/**
 * Attribution: which run does a runtime log event belong to?
 *
 * Works per runtime turn — TurnState { owners, foreign, focus, sticky, blocked }:
 *   - a turn opened by a marked input belongs to that run; an unmarked input
 *     (another channel, a scheduled task, a rejected marker) makes the turn
 *     foreign — nothing is attributed without focus evidence;
 *   - inputs absorbed into the running turn add owners (marked) or make the
 *     turn foreign (unmarked, signal ③);
 *   - process events (commentary / tools) go to the focus run only. Focus
 *     signals, strongest first:
 *       ③ unmarked input, or a c4-send to another channel → no focus (safety)
 *       ① the agent reads a run's C4 spill file → focus (sticky), even in a
 *          foreign turn
 *       ② a reply to a run (send.js / comm CLI claim file, c4-send … openmax
 *          <endpoint>, or comm.js comm.send / send_card / ask_card / ask
 *          {"conversationId": …} in the log) → that run is replied; focus is
 *          recomputed by ④. A comm CLI send to a conversation no owner of the
 *          turn replies to counts as ③.
 *       ④ not foreign and every owner in one conversation → the earliest
 *          unreplied owner
 *   - turn end: replied owners → done; the others get 120 s to reply, then
 *     done / no_reply.
 */

import { classifyTool } from './classify.js';
import { isVisibleTool, thinkingBody } from './present.js';
import { startDetail, endDetail } from './tool-detail.js';
import { normalizeDetail } from './detail.js';
import { resolveMarkedRun, normEndpoint, parseMarker } from './marker.js';
import { NO_REPLY_GRACE_MS, ACTIVE_IDLE_TIMEOUT_MS, QUEUED_NO_START_TIMEOUT_MS } from './constants.js';

const MAX_RUN_EVENTS = 2000;

export function createAttribution({
  now = Date.now,
  emitter,
  stats,
  throttle,
  persist = () => {},
  onRunClosed = () => {},
  readSpillHead,
} = {}) {
  const runs = new Map();
  /**
   * callId → { runId, ev, name, input } for tool calls attributed to a run
   * (name / input stay in memory only: the end builds the detail from them).
   * A Codex exec session still running after its call returned is kept under
   * `session:<id>`; a write_stdin poll on it maps its own callId to the same
   * entry, so the poll's result ends the command step (decision 6).
   */
  const calls = new Map();
  let turn = null;
  let degraded = false;

  const isOpen = (run) => run && run.state !== 'closed';
  const unreplied = (run) => isOpen(run) && run.state !== 'replied';

  function touch(run, t = now()) {
    run._lastEventAt = t;
  }

  function nextEventId(run) {
    const n = Number.isInteger(run.next_event) ? run.next_event : 1;
    run.next_event = n + 1;
    return `e${n}`;
  }

  /**
   * Record the event on the run (for the summary) and queue it for the wire.
   * A tool end replaces the stored start (same id) with the whole event.
   */
  function deliver(run, ev) {
    if (!isOpen(run)) return;
    touch(run);
    if (run.status_only) {
      emitter.pushEvent(run, ev);   // counted as dropped by the emitter
      return;
    }
    const events = run.events || (run.events = []);
    if (ev.kind === 'tool' && ev.ended_at != null) {
      const i = events.findIndex((e) => e.kind === 'tool' && e.id === ev.id);
      if (i !== -1) {
        events[i] = { ...ev };
        emitter.pushEvent(run, ev);
        return;
      }
    }
    if (events.length >= MAX_RUN_EVENTS) {
      run.dropped = (run.dropped || 0) + 1;
      stats.events_dropped += 1;
    } else {
      events.push({ ...ev });
    }
    emitter.pushEvent(run, ev);
  }

  function setFocusFlags(focus) {
    if (!turn) return;
    if (focus) focus.ever_focused = true;
    for (const r of turn.owners) {
      if (turn.foreign || turn.owners.length > 1) r.mixed_turn = true;
      const f = r === focus;
      if (r.focus !== f) {
        r.focus = f;
        persist(r);
      }
    }
  }

  function computeFocus() {
    if (!turn) return null;
    if (turn.sticky && unreplied(turn.sticky)) return turn.sticky;
    if (turn.foreign || turn.blocked) return null;
    const convs = new Set(turn.owners.map((r) => r.conversation_id));
    if (convs.size !== 1) return null;
    return turn.owners.filter(unreplied).sort((a, b) => a.created_at - b.created_at)[0] || null;
  }

  function applyFocus(signal, t) {
    if (!turn) return;
    const prev = turn.focus;
    const next = computeFocus();
    turn.focus = next;
    setFocusFlags(next);
    // Focus changes are counted only: no visible note (decision 6).
    if (next && next !== prev) stats.focus_by_signal[signal] = (stats.focus_by_signal[signal] || 0) + 1;
  }

  function enterTurn(run, t) {
    run.state = 'active';
    run.turn_id = turn.id;
    // Execution start: the first runtime turn the run enters (the FE switches
    // its one timer from waiting to execution time here).
    if (!Number.isFinite(run.exec_started_at)) {
      const at = Number.isFinite(Number(t)) ? Number(t) : now();
      run.exec_started_at = Math.min(Math.max(at, run.created_at || 0), Math.max(now(), run.created_at || 0));
    }
    if (degraded) run.status_only = true;
    touch(run, t);
    emitter.setState(run, 'thinking');
    persist(run);
  }

  function resolve(input, { count }) {
    const { run, reason } = resolveMarkedRun(input, { getRun: (id) => runs.get(id), readSpillHead });
    if (reason && count) {
      stats.marker_rejected[reason] = (stats.marker_rejected[reason] || 0) + 1;
      if (reason === 'endpoint_after_anchor_ok') {
        const id = parseMarker(input.head)?.runId;
        throttle.warn('marker_endpoint_after_anchor_ok',
          `run ${id}: marker accepted at the anchor but the reply-via endpoint check failed — run shows status only`);
      }
    }
    return run;
  }

  function closeRun(run, state, reason = null) {
    if (!isOpen(run)) return;
    const t = now();
    run.state = 'closed';
    run.ended_at = t;
    run.focus = false;
    run._awaitNoReply = false;
    emitter.finish(run, state, reason);
    emitter.untrack(run);
    // focus_none_runs_ratio (design §11 #4): runs that sat in a mixed /
    // foreign turn and never got focus before they ended.
    if (run.mixed_turn) {
      stats.mixed_turn_runs = (stats.mixed_turn_runs || 0) + 1;
      if (!run.ever_focused) stats.focus_none_runs = (stats.focus_none_runs || 0) + 1;
    }
    stats.runs_closed[`${state}${reason ? `/${reason}` : ''}`] = (stats.runs_closed[`${state}${reason ? `/${reason}` : ''}`] || 0) + 1;
    persist(run);
    onRunClosed(run);
  }

  function endTurn({ interrupted = false } = {}) {
    if (!turn) return;
    const t = now();
    const ended = turn;
    turn = null;
    for (const run of ended.owners) {
      if (!isOpen(run)) continue;
      if (run.state === 'replied') closeRun(run, 'done');
      else if (interrupted) closeRun(run, 'failed', 'interrupted');
      else {
        run.turn_ended_at = t;
        run._awaitNoReply = true;
        run.focus = false;
        emitter.setState(run, 'thinking');
        persist(run);
      }
    }
    // A run whose marker was rejected never became an owner, but its reply was
    // still claimed: it ends with the turn it was answered in.
    for (const run of runs.values()) {
      if (run.state === 'replied' && !ended.owners.includes(run)) closeRun(run, 'done');
    }
    for (const [id, c] of calls) if (ended.owners.some((r) => r.run_id === c.runId)) calls.delete(id);
  }

  function newTurn(foreign, file) {
    turn = { id: `${file || 'log'}:${now()}`, owners: [], foreign, focus: null, sticky: null, blocked: false, file };
    return turn;
  }

  function markReplied(run, via, { pauseFocus = false } = {}) {
    if (!unreplied(run)) return false;
    run.state = 'replied';
    run.replied_at = now();
    stats.replied_via[via] = (stats.replied_via[via] || 0) + 1;
    if (run._awaitNoReply) {
      closeRun(run, 'done');
      return true;
    }
    persist(run);
    if (turn && turn.owners.includes(run)) {
      if (turn.sticky === run) turn.sticky = null;
      if (pauseFocus) return true;      // the same operation also sent elsewhere: ③ wins
      if (via === 'claim' && turn.blockedUninspectable) return true;
      turn.blocked = false;
      turn.blockedUninspectable = false;
      applyFocus(2, now());
    }
    return true;
  }

  /**
   * A visible tool call starts: one step, counted (decision 6). Reply sends
   * and wait / poll calls are neither.
   */
  function startTool(run, callId, cls, at, name, input) {
    const ev = { id: nextEventId(run), kind: 'tool', category: cls.category, at };
    if (!isVisibleTool(ev)) return;
    if (cls.title) ev.title = cls.title;
    if (cls.object) ev.object = cls.object;
    if (cls.live_preview) ev.live_preview = true;
    // Stored redacted and capped: raw tool input never reaches the run file.
    const detail = normalizeDetail(startDetail(name, cls.category, input));
    if (detail) ev.detail = detail;
    run.step_count = (Number.isInteger(run.step_count) ? run.step_count : 0) + 1;
    deliver(run, ev);
    calls.set(callId, { runId: run.run_id, ev, name, input });
  }

  function handleToolStart(input) {
    if (!turn) return;
    const cls = classifyTool(input.name, input.input);
    const t = input.at;

    // A wait / poll call is never a step. One on a still-running Codex exec
    // session joins that command's step: its result may end it.
    if (cls.category === 'waiting') {
      const owner = cls.waitRef ? calls.get(cls.waitRef) : null;
      if (owner) calls.set(input.callId, { ...owner, poll: cls.waitRef });
      return;
    }

    const sig = cls.signals;
    if (sig.spillC4Ids && !sig.external) {
      const run = turn.owners.find((r) => unreplied(r) && r.c4_id != null && sig.spillC4Ids.includes(String(r.c4_id)));
      if (run) {
        turn.sticky = run;
        turn.blocked = false;
        turn.blockedUninspectable = false;
        applyFocus(1, t);
      }
    }

    // Every openmax send in the operation marks its run replied; the first one
    // owns the reply step itself.
    // A comm CLI send (comm.send / send_card / ask_card / ask) names its conversation,
    // not an endpoint: it answers the earliest unreplied owner replying there.
    // One aimed at a conversation no owner of this turn replies to is a send
    // elsewhere — treated like a c4-send to another channel (signal ③).
    const replyConv = (r) => r.reply_conversation_id || r.conversation_id;
    let external = sig.external === true;
    const replied = [];
    for (const reply of sig.replies || []) {
      let match;
      if (reply.endpoint) {
        const ne = normEndpoint(reply.endpoint);
        match = (r) => normEndpoint(r.endpoint) === ne;
      } else if (reply.conversationId) {
        match = (r) => replyConv(r) === reply.conversationId;
        if (!turn.owners.some(match)) external = true;
      } else {
        continue;
      }
      const run = turn.owners
        .filter((r) => unreplied(r) && !replied.includes(r) && match(r))
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (run) replied.push(run);
    }

    // External sends pause attribution BEFORE this operation is attributed:
    // only an openmax run this operation itself answers gets the step.
    const target = replied[0] || (external ? null : turn.focus);
    if (target && unreplied(target)) startTool(target, input.callId, cls, t, input.name, input.input);
    else stats.attribution_unfocused_events += 1;
    for (const run of replied) markReplied(run, 'log', { pauseFocus: external });

    if (external) {
      // Signal ③: the agent answers another channel (or runs something whose
      // sends cannot be inspected) — no focus until ① / ②. Applied last, so it
      // wins over the focus a same-operation openmax reply would hand on (④).
      turn.focus = null;
      turn.sticky = null;
      turn.blocked = true;
      // A wrapper we could not fully read may have done anything (including
      // an openmax reply that send.js later claims): only a recognized spill
      // read or a log-visible openmax reply in a recognized call lifts this.
      if (sig.uninspectable) turn.blockedUninspectable = true;
      setFocusFlags(null);
    }
  }

  function handleToolEnd(input) {
    const c = calls.get(input.callId);
    if (!c) return;
    calls.delete(input.callId);
    const run = runs.get(c.runId);
    if (!isOpen(run)) {
      if (c.poll) calls.delete(c.poll);
      return;
    }
    // Codex: the command is still running in an exec session — the step stays
    // running until a poll (write_stdin) on that session sees it exit.
    if (input.running === true && input.sessionId != null) {
      calls.set(`session:${input.sessionId}`, { runId: c.runId, ev: c.ev, name: c.name, input: c.input });
      return;
    }
    if (c.poll) calls.delete(c.poll);
    const endEv = { ...c.ev, ended_at: Math.max(input.at, c.ev.at), error: input.isError === true };
    let detail;
    try {
      detail = endDetail({ name: c.name, category: c.ev.category, input: c.input, result: input.result, isError: input.isError === true, start: c.ev.detail });
    } catch {
      detail = undefined;               // fail closed: no detail rather than a guess
    }
    detail = normalizeDetail(detail);
    if (detail) endEv.detail = detail;
    else delete endEv.detail;
    deliver(run, endEv);
  }

  function handleCommentary(input) {
    const target = turn?.focus;
    if (!target || !unreplied(target)) {
      if (turn) stats.attribution_unfocused_events += 1;
      return;
    }
    // Stored already redacted and cut (present.js thinkingBody): the raw
    // commentary never reaches the run file.
    const text = thinkingBody(input.text);
    if (!text) return;
    deliver(target, { id: nextEventId(target), kind: 'commentary', text, at: input.at });
  }

  return {
    runs,
    get turn() { return turn; },

    addRun(run) {
      runs.set(run.run_id, run);
    },
    removeRun(runId) {
      runs.delete(runId);
    },
    getRun(id) {
      return runs.get(id);
    },
    openRuns() {
      return [...runs.values()].filter(isOpen);
    },
    closeRun,

    /** Collector fell back to status-only: no process events for any run. */
    degradeAll() {
      degraded = true;
      for (const r of runs.values()) if (isOpen(r)) r.status_only = true;
    },
    recover() {
      degraded = false;
    },
    get degraded() { return degraded; },

    /** A record of unknown shape inside the current turn: its runs go status-only. */
    noteUnknownShape() {
      if (!turn) return;
      for (const r of turn.owners) if (isOpen(r)) r.status_only = true;
    },

    /** Signal ② from send.js: the claim file for this run exists. */
    noteReplyClaim(runId) {
      const run = runs.get(runId);
      if (run) markReplied(run, 'claim');
    },

    /** The turn's log stopped and another one took over: the runtime restarted. */
    noteRuntimeRestart() {
      if (!turn) return;
      const ended = turn;
      turn = null;
      for (const run of ended.owners) {
        if (!isOpen(run)) continue;
        if (run.state === 'replied') closeRun(run, 'done');
        else closeRun(run, 'failed', 'runtime_restarted');
      }
    },

    /** Process one normalised log input. */
    handle(input, { file } = {}) {
      if (turn) turn.lastEventAt = now();
      switch (input.t) {
        case 'input': {
          const t = input.at;
          if (input.form === 'user' || input.form === 'dequeue') {
            endTurn();
            if (input.form === 'dequeue') return;
            const run = resolve(input, { count: true });
            if (run && run.state !== 'replied') {
              newTurn(false, file);
              turn.owners.push(run);
              enterTurn(run, t);
              turn.focus = run;
              setFocusFlags(run);
            } else {
              newTurn(true, file);
            }
            return;
          }
          if (input.form === 'enqueue') {
            const run = resolve(input, { count: false });
            if (run && (run.state === 'queued' || run.state === 'created')) emitter.setState(run, 'queued');
            return;
          }
          // absorbed / queued_command: merged into the running turn.
          if (!turn) newTurn(true, file);
          const run = resolve(input, { count: input.form === 'queued_command' });
          if (run && run.state !== 'replied') {
            if (!turn.owners.includes(run)) {
              turn.owners.push(run);
              enterTurn(run, t);
              deliver(run, { id: nextEventId(run), kind: 'notice', code: 'merged_turn', at: t });
            }
            applyFocus(4, t);
          } else if (!run) {
            turn.foreign = true;
            turn.focus = null;
            turn.sticky = null;
            setFocusFlags(null);
          }
          return;
        }
        case 'commentary':
          handleCommentary(input);
          return;
        case 'tool_start':
          handleToolStart(input);
          return;
        case 'tool_end':
          handleToolEnd(input);
          return;
        case 'turn_end':
          endTurn({ interrupted: input.interrupted === true });
          return;
        default:
      }
    },

    /**
     * Timers: no-reply grace after the turn end, the 5 min cap on a run that
     * never started (no runtime turn ever picked it up), and the 30 min idle cap
     * on a started run.
     */
    tick() {
      const t = now();
      for (const run of runs.values()) {
        if (!isOpen(run)) continue;
        if (run._awaitNoReply && t - run.turn_ended_at >= NO_REPLY_GRACE_MS) {
          closeRun(run, 'done', 'no_reply');
          continue;
        }
        // A run recovered from a previous process waits for onWsOpen, which ends
        // it failed / runtime_restarted once its org can hear the frame.
        if ((run.state === 'queued' || run.state === 'created') && !run._restartPending
          && t - (run.created_at || 0) >= QUEUED_NO_START_TIMEOUT_MS) {
          closeRun(run, 'done', 'no_reply');
          continue;
        }
        const last = run._lastEventAt || run.created_at;
        if (t - last >= ACTIVE_IDLE_TIMEOUT_MS) closeRun(run, 'failed', 'interrupted');
      }
    },
  };
}
