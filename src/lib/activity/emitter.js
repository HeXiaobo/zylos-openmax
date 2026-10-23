/**
 * agent_activity emitter: per-run merging, sequence numbers, heartbeats, the
 * post-connect probe, and the per-org summary gate.
 *
 * Send semantics are lossy on purpose: a frame goes out through
 * WsClient.trySend() or is dropped — never buffered, never re-sent. The
 * sequence number advances for every frame built (sent or not), so a gap is
 * visible to the client; the complete run arrives later with the reply's
 * agent_run.
 *
 * Frame payload (schema v3): a typed envelope cws-comm routes and
 * rate-limits on (conversation_id, run_id, source_message_id, sequence, state,
 * started_at = queued_at, exec_started_at, ended_at, step_count, ttl_ms,
 * dropped) plus display fields it does not read: schema_version, end_reason
 * (terminal frames) and steps — v3 step objects (present.js, the same
 * generator as the stored summary), sent incrementally; the client upserts
 * them by id (a tool's start and end are the same step; the end carries its
 * detail). The state does not flip per tool any more: queued → thinking →
 * done | failed (the FE maps thinking/tool to "processing").
 *
 * Gate (per org, mirrored into runs/active.json for send.js):
 *   pending — just (re)connected; the first frame carries no steps (probe)
 *   open    — no UNKNOWN_FRAME_TYPE within 2 s of the probe: summaries allowed
 *   closed  — cws-comm answered UNKNOWN_FRAME_TYPE: stop on this connection,
 *             retry once after the next reconnect
 *
 * No per-frame logging: outcomes are counted in `stats`; recurring problems go
 * through the throttled logger.
 */

import {
  MERGE_WINDOW_MS, HEARTBEAT_MS, TTL_MS, MAX_FRAME_EVENTS, MAX_FRAME_BYTES,
  MAX_PENDING_EVENTS, MAX_CONCURRENT_RUNS, MAX_DROPPED, PROBE_CONFIRM_MS,
  FORBIDDEN_LOCAL_ONLY_AFTER, SOURCE_MESSAGE_ID_RE, SCHEMA_VERSION, END_REASONS, MAX_STEP_COUNT,
} from './constants.js';
import { eventToStep, fitFrameDetail } from './present.js';
import { runStepCount } from './compact.js';

const FRAME_TYPE = 'agent_activity';

function frameBytes(frame) {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

export function createEmitter({
  now = Date.now,
  stats,
  throttle,
  persist = () => {},
  onGateChange = () => {},
} = {}) {
  /** orgId → binding */
  const bindings = new Map();
  /** open runs in creation order */
  const openRuns = [];
  /** conversation ids that got FORBIDDEN repeatedly: keep their runs local */
  const localOnlyConvs = new Set();

  function setGate(binding, orgId, gate) {
    if (binding.gate === gate) return;
    binding.gate = gate;
    onGateChange(orgId, gate);
  }

  function em(run) {
    if (!run._em) run._em = { pending: [], lastSentAt: 0, dirty: true, state: 'queued' };
    return run._em;
  }

  function overConcurrency(run) {
    const idx = openRuns.indexOf(run);
    return idx >= MAX_CONCURRENT_RUNS;
  }

  function addDropped(run, n = 1) {
    run.dropped = Math.min(MAX_DROPPED, (run.dropped || 0) + n);
    stats.events_dropped += n;
  }

  function buildPayload(run, state, steps, t) {
    const terminal = state === 'done' || state === 'failed';
    const p = {
      conversation_id: run.conversation_id,
      run_id: run.run_id,
      ...(run.source_message_id && SOURCE_MESSAGE_ID_RE.test(run.source_message_id) ? { source_message_id: run.source_message_id } : {}),
      sequence: run.seq,
      state,
      started_at: run.created_at,
    };
    // Execution start (the run entered a runtime turn): the FE resets its one
    // timer from the wait time to the execution time here.
    if (Number.isFinite(run.exec_started_at)) {
      p.exec_started_at = Math.min(Math.max(run.exec_started_at, run.created_at), Math.max(t, run.created_at));
    }
    if (terminal) p.ended_at = Math.max(t, run.created_at);
    p.step_count = Math.min(MAX_STEP_COUNT, runStepCount(run));
    p.schema_version = SCHEMA_VERSION;
    if (terminal && END_REASONS.includes(run.reason)) p.end_reason = run.reason;
    p.steps = steps;
    p.dropped = Math.min(MAX_DROPPED, run.dropped || 0);
    p.ttl_ms = TTL_MS;
    return p;
  }

  /** Build and try to send one frame for `run` now. */
  function emit(run, t, { terminal = false } = {}) {
    const e = em(run);
    const binding = bindings.get(run.org_id);
    const probe = !binding || binding.probePending;
    const state = terminal ? run._terminalState : e.state;

    run.seq = (run.seq || 0) + 1;
    const frame = {
      type: FRAME_TYPE,
      timestamp: t,
      org_id: run.org_id,
      payload: buildPayload(run, state, [], t),
    };
    // Fill steps up to the count / byte caps. The probe frame (first after a
    // connect) carries none, so no process text reaches a server that may not
    // accept the frame type at all.
    if (!probe && e.pending.length > 0) {
      let taken = 0;
      while (taken < e.pending.length && taken < MAX_FRAME_EVENTS) {
        frame.payload.steps.push(e.pending[taken]);
        if (frameBytes(frame) > MAX_FRAME_BYTES) {
          frame.payload.steps.pop();
          if (taken === 0) {
            // A single event that cannot fit at all is dropped.
            e.pending.shift();
            addDropped(run);
            frame.payload.dropped = Math.min(MAX_DROPPED, run.dropped);
            continue;
          }
          break;
        }
        taken += 1;
      }
      e.pending.splice(0, taken);
    }
    if (terminal) {
      // Whatever did not fit into the final frame is gone.
      if (e.pending.length) addDropped(run, e.pending.length);
      e.pending = [];
    }

    const sendable = binding && binding.enabled && !localOnlyConvs.has(run.conversation_id);
    const ok = sendable && binding.ws?.trySend?.(frame) === true;
    if (ok) {
      stats.frames_sent += 1;
      if (binding.probePending) {
        binding.probePending = false;
        binding.probeSentAt = t;
      }
      binding.lastConversationId = run.conversation_id;
    } else {
      stats.frames_dropped += 1;
    }
    e.lastSentAt = t;
    e.dirty = false;
    try { persist(run); } catch {}
    return ok;
  }

  return {
    bindings,

    bindOrgWs(orgId, ws) {
      const prev = bindings.get(orgId);
      bindings.set(orgId, {
        ws,
        enabled: true,
        probePending: true,
        probeSentAt: null,
        gate: prev?.gate ?? null,
        warnedUnknown: false,
        forbiddenStreak: 0,
        lastConversationId: null,
      });
    },

    onWsOpen(orgId) {
      const b = bindings.get(orgId);
      if (!b) return;
      b.enabled = true;
      b.probePending = true;
      b.probeSentAt = null;
      b.warnedUnknown = false;
      b.forbiddenStreak = 0;
      setGate(b, orgId, 'pending');
    },

    gateOf(orgId) {
      return bindings.get(orgId)?.gate ?? 'pending';
    },

    /**
     * Handle a server `error` frame. Returns true when it was attributed to
     * agent_activity (the caller then skips its generic per-frame warn).
     */
    onServerError(orgId, payload = {}) {
      const b = bindings.get(orgId);
      if (!b) return false;
      const code = String(payload.code || '');
      const message = String(payload.message || '');
      const lastSentType = b.ws?.lastSentType;
      const ours = message.includes(FRAME_TYPE) || lastSentType === FRAME_TYPE;
      if (!ours) return false;
      if (code === 'UNKNOWN_FRAME_TYPE') {
        stats.unknown_frame_type += 1;
        b.enabled = false;
        setGate(b, orgId, 'closed');
        if (!b.warnedUnknown) {
          b.warnedUnknown = true;
          const since = b.ws?.lastSentAt ? now() - b.ws.lastSentAt : null;
          // Once per connection, and throttled across reconnects.
          throttle.warn('unknown_frame_type', `cws-comm does not accept agent_activity on org ${orgId} (lastSentType=${lastSentType || 'none'}, ${since ?? '?'}ms after last send) — paused on this connection, summaries off; retrying after reconnect`);
        }
        return true;
      }
      if (code === 'INVALID_PAYLOAD' || code === 'FORBIDDEN' || code === 'INTERNAL_ERROR') {
        stats.server_errors[code] = (stats.server_errors[code] || 0) + 1;
        throttle.warn(`server_error_${code}`, `cws-comm rejected an agent_activity frame on org ${orgId}: ${message.slice(0, 200)}`);
        if (code === 'FORBIDDEN') {
          b.forbiddenStreak += 1;
          if (b.forbiddenStreak >= FORBIDDEN_LOCAL_ONLY_AFTER && b.lastConversationId) {
            localOnlyConvs.add(b.lastConversationId);
          }
        }
        return true;
      }
      return false;
    },

    track(run) {
      em(run);
      if (!openRuns.includes(run)) openRuns.push(run);
    },

    untrack(run) {
      const i = openRuns.indexOf(run);
      if (i !== -1) openRuns.splice(i, 1);
    },

    openRunCount() {
      return openRuns.length;
    },

    /**
     * Whether tick() still has work: a tracked (open) run, or a probe that was
     * sent and awaits its 2 s confirmation (gate pending → open). A closed run's
     * terminal frame is sent synchronously by finish(), so it never counts. A
     * probe not yet sent (reconnect with no run) is not work: it goes out with
     * the next run's first frame.
     */
    hasPendingWork() {
      if (openRuns.length > 0) return true;
      for (const b of bindings.values()) {
        if (b.enabled && b.gate === 'pending' && !b.probePending && b.probeSentAt != null) return true;
      }
      return false;
    },

    /**
     * Change the frame state (queued / thinking); sent with the next window.
     * Also marks the run dirty when only its step count changed.
     */
    setState(run, state) {
      const e = em(run);
      if (e.state === state) return;
      e.state = state;
      e.dirty = true;
    },

    /** Something in the envelope changed (step_count, exec_started_at): send with the next window. */
    touch(run) {
      em(run).dirty = true;
    },

    /**
     * Queue one run event for the wire as a v3 step. A newer version of a
     * step still pending (a tool's end after its start) replaces it in place:
     * each step carries its whole state, the client upserts by id.
     */
    pushEvent(run, ev) {
      const e = em(run);
      if (run.status_only || overConcurrency(run)) {
        addDropped(run);
        return;
      }
      const step = eventToStep(ev);
      if (!step) return;
      fitFrameDetail(step);
      if (step.kind === 'tool') {
        const i = e.pending.findIndex((p) => p.kind === 'tool' && p.id === step.id);
        if (i !== -1) {
          e.pending[i] = step;
          return;
        }
      }
      e.pending.push(step);
      if (e.pending.length > MAX_PENDING_EVENTS) {
        e.pending.shift();
        addDropped(run);
      }
    },

    /** Send the first frame (queued) right away. */
    emitNow(run) {
      return emit(run, now());
    },

    /** End the run with an immediate terminal frame. */
    finish(run, state, reason = null) {
      run._terminalState = state;
      run.reason = reason;
      em(run).state = state;
      return emit(run, now(), { terminal: true });
    },

    tick() {
      const t = now();
      for (const [orgId, b] of bindings) {
        if (b.gate === 'pending' && b.enabled && b.probeSentAt != null && t - b.probeSentAt >= PROBE_CONFIRM_MS) {
          setGate(b, orgId, 'open');
        }
      }
      for (const run of [...openRuns]) {
        const e = em(run);
        const since = t - e.lastSentAt;
        const due = (e.dirty || e.pending.length > 0) && since >= MERGE_WINDOW_MS;
        if (due || since >= HEARTBEAT_MS) emit(run, t);
      }
    },
  };
}
