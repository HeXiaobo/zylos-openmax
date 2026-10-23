/**
 * Agent execution-process visibility (agent_activity) — the only surface
 * comm-bridge uses.
 *
 * OFF by default. Enabled by OPENMAX_ACTIVITY=1|true|on|yes (process env,
 * highest priority) or `activity.enabled: true` in config.json; OPENMAX_ACTIVITY=
 * 0|false|off|no forces it off. Disabled means no behaviour change at all: no
 * [OM-RUN …] marker on C4 messages, no collector, no frames, no run files, so
 * send.js finds no run and attaches no metadata. A change needs a restart.
 *
 * Data flow: comm-bridge registers a run per inbound message that should show
 * its process and prefixes the C4 body with the marker → the collector tails
 * the runtime log → attribution decides which run each step belongs to →
 * the emitter sends lossy agent_activity frames over the org's WS → send.js
 * attaches the compacted agent_run (top-level field) to the reply.
 */

import fs from 'fs';
import path from 'path';
import { parseEndpoint } from '../message.js';
import { createRunStore } from './run-store.js';
import { createEmitter } from './emitter.js';
import { createAttribution } from './attribution.js';
import { createCollector, readRuntimeName } from './collector.js';
import { createThrottledLogger } from './throttled-log.js';
import TaskRegistry from '../task-registry.js';
import { newRunId, formatMarker } from './marker.js';
import {
  EMIT_TICK_MS, POLL_INTERVAL_MS, DISCOVERY_INTERVAL_MS, RUN_FILE_RETENTION_MS, SPILL_READ_BYTES,
  REPLY_REF_WINDOW_MS,
} from './constants.js';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** TaskRegistry task names. The three hot ones run only while a run is open. */
export const ACTIVITY_TASKS = Object.freeze({
  poll: 'activity-poll',
  emit: 'activity-emit',
  discovery: 'activity-discovery',
  cleanup: 'activity-cleanup',
});
const HOT_TASKS = [ACTIVITY_TASKS.emit, ACTIVITY_TASKS.poll, ACTIVITY_TASKS.discovery];

/** OPENMAX_ACTIVITY wins; otherwise config.activity.enabled === true. Default off. */
export function resolveActivityEnabled({ env = process.env, config } = {}) {
  const raw = env?.OPENMAX_ACTIVITY;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (OFF_VALUES.has(v)) return false;
    if (ON_VALUES.has(v)) return true;
  }
  return config?.activity?.enabled === true;
}

/**
 * Run registration rule: every DM; in a group / thread only a message that
 * structurally @-mentions this agent (decision.mentioned from
 * shouldHandleMessage). Smart-mode messages without an @ are handled as
 * before, without a run.
 */
export function shouldRegisterRun({ enabled, convType, decision }) {
  if (!enabled) return false;
  return convType === 'dm' || decision?.mentioned === true;
}

/** The conversation send.js will post the reply to (thread wins). */
export function replyConversationOf(endpoint) {
  try {
    const ep = parseEndpoint(endpoint);
    return ep.threadConversationId || ep.conversationId;
  } catch {
    return null;
  }
}

function newStats() {
  return {
    runs_registered: 0,
    runs_skipped_not_mentioned: 0,
    frames_sent: 0,
    frames_dropped: 0,
    events_dropped: 0,
    attribution_unfocused_events: 0,
    unknown_frame_type: 0,
    parse_errors: 0,
    lines_oversized: 0,
    parse_unknown_shape: 0,
    focus_by_signal: {},
    marker_rejected: {},
    replied_via: {},
    runs_closed: {},
    run_reply_form: {},
    server_errors: {},
  };
}

function fmtCounts(obj) {
  const parts = Object.entries(obj).filter(([, n]) => n);
  return parts.length ? `{${parts.map(([k, n]) => `${k}:${n}`).join(',')}}` : '{}';
}

const DISABLED = Object.freeze({
  enabled: false,
  registerRun: () => null,
  confirmRun: () => {},
  dropRun: () => {},
  noteUnregisteredInput: () => {},
  noteNotMentioned: () => {},
  bindOrgWs: () => {},
  onWsOpen: () => {},
  onServerError: () => false,
  start: () => {},
  stop: () => {},
  statsLine: () => null,
});

export function createActivity({
  config,
  env = process.env,
  log = () => {},
  warn = () => {},
  now = Date.now,
  runsDir,
  homeDir = process.env.HOME || '/tmp',
  zylosDir,
  runtime,
  codexQuery,
  tasks = new TaskRegistry(),
} = {}) {
  if (!resolveActivityEnabled({ env, config })) {
    // Disabled: nothing is registered on `tasks`, so no timer ever runs.
    // A run index left behind by an earlier enabled period must not keep
    // send.js attaching summaries while the feature is off.
    createRunStore(runsDir ? { dir: runsDir } : {}).removeActive();
    return DISABLED;
  }

  const zDir = zylosDir || path.join(homeDir, 'zylos');
  const store = createRunStore(runsDir ? { dir: runsDir } : {});
  const stats = newStats();
  const throttle = createThrottledLogger({ warn, now });
  const gates = {};
  const unregistered = {};
  let lastActive = null;

  function openRuns() {
    return attribution.openRuns();
  }

  /** Open runs + runs closed on their reply still listed until their turn ends. */
  function trackedRuns() {
    return attribution.trackedRuns();
  }

  function syncActive() {
    const byConv = {};
    const t = now();
    // Open runs, plus runs closed on their delivered reply while their turn
    // lasts (a later reply of that turn still carries the reference form).
    const listed = [...attribution.runs.values()].filter((r) => (r.state === 'closed'
      ? r._refListed === true && t - (r.ended_at || 0) < REPLY_REF_WINDOW_MS
      : r.state !== 'created'));
    for (const r of listed) {
      const key = r.reply_conversation_id || r.conversation_id;
      (byConv[key] || (byConv[key] = [])).push(r.run_id);
    }
    for (const conv of Object.keys(unregistered)) if (!byConv[conv]) delete unregistered[conv];
    const body = { v: 1, by_conversation: byConv, gate: { ...gates }, unregistered: { ...unregistered } };
    const sig = JSON.stringify(body);
    if (sig === lastActive) return;
    try {
      store.writeActive({ ...body, updated_at: now() });
      lastActive = sig;
    } catch (err) {
      throttle.warn('active_index_write', `cannot write runs/active.json: ${err.message}`);
    }
  }

  function persistRun(run) {
    try {
      store.writeRun(run);
    } catch (err) {
      throttle.warn('run_file_write', `cannot write run ${run.run_id}: ${err.message}`);
    }
    syncActive();
  }

  function replyForm(run) {
    const claim = store.readClaim(run.run_id);
    if (claim?.state === 'delivered') return claim.kind === 'media' || claim.kind === 'card' ? claim.kind : 'text';
    if (claim?.state === 'pending') return 'unknown';
    if (store.formCardExists(run.run_id)) return 'card';
    return 'none';
  }

  function readSpillHead(p) {
    if (!/comm-bridge\/attachments\/conv-\d+\/message\.txt$/.test(p)) return null;
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(SPILL_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, SPILL_READ_BYTES, 0);
      return buf.subarray(0, n).toString('utf8');
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  const emitter = createEmitter({
    now,
    stats,
    throttle,
    persist: persistRun,
    onGateChange: (orgId, gate) => { gates[orgId] = gate; syncActive(); },
  });
  const attribution = createAttribution({
    now,
    emitter,
    stats,
    throttle,
    persist: persistRun,
    readSpillHead,
    onRunClosed: (run) => {
      const form = replyForm(run);
      stats.run_reply_form[form] = (stats.run_reply_form[form] || 0) + 1;
      syncActive();
    },
  });
  const runtimeName = runtime || readRuntimeName(zDir);
  const collector = createCollector({
    runtime: runtimeName,
    homeDir,
    zylosDir: zDir,
    attribution,
    stats,
    warn: (msg) => throttle.warn('collector_state', msg),
    now,
    ...(codexQuery ? { codexQuery } : {}),
  });

  let started = false;
  let idleSeen = false;

  /**
   * send.js claims: a claim (pending) marks the run replied (signal ②); a
   * `delivered` claim (POST 2xx) ends the run done right away — the header
   * must not keep showing "processing" until the whole turn ends. A released
   * claim (certain rejection) changes nothing here.
   */
  function checkClaims() {
    for (const r of openRuns()) {
      if (r.state === 'created') continue;
      const claim = store.readClaim(r.run_id);
      if (claim?.state === 'delivered') attribution.noteReplyDelivered(r.run_id);
      else if (r.state !== 'replied' && (claim || store.claimExists(r.run_id))) attribution.noteReplyClaim(r.run_id);
    }
  }

  function pollTick() {
    try {
      if (trackedRuns().length === 0) {
        collector.poll();          // lets the collector note it is idle
        return;
      }
      collector.poll();
      checkClaims();
      attribution.tick();
    } catch (err) {
      throttle.warn('collector_tick', err.message);
    }
  }

  /** Returned promise: TaskRegistry serializes overlapping discovery ticks. */
  async function discoveryTick() {
    if (trackedRuns().length === 0) return;
    try {
      await collector.discover();
    } catch (err) {
      throttle.warn('collector_discovery', err.message);
    }
  }

  // ── lazy hot timers ─────────────────────────────────────────────────────
  // emit / poll / discovery run only while a run is open (or the emitter
  // still has work: a sent probe awaiting confirmation). They start on the
  // first open run and stop on the second consecutive idle emit tick, so a
  // run closing and the next one arriving right after do not thrash them.

  const hotRunning = () => HOT_TASKS.some((n) => tasks.isRunning(n));

  function startHot() {
    idleSeen = false;
    if (!started) return;
    for (const n of HOT_TASKS) tasks.start(n);
  }

  function stopHot() {
    idleSeen = false;
    if (!hotRunning()) return;
    for (const n of HOT_TASKS) tasks.stop(n);
    // The next poll after a restart skips what the log gathered meanwhile.
    collector.markIdle();
  }

  function emitTick() {
    try {
      emitter.tick();
    } catch (err) {
      throttle.warn('emitter_tick', err.message);
    }
    if (trackedRuns().length > 0 || emitter.hasPendingWork()) {
      idleSeen = false;
      return;
    }
    if (idleSeen) stopHot();
    else idleSeen = true;
  }

  tasks.register(ACTIVITY_TASKS.emit, emitTick, EMIT_TICK_MS);
  tasks.register(ACTIVITY_TASKS.poll, pollTick, POLL_INTERVAL_MS);
  tasks.register(ACTIVITY_TASKS.discovery, discoveryTick, DISCOVERY_INTERVAL_MS);
  tasks.register(ACTIVITY_TASKS.cleanup, () => { try { cleanup(); } catch {} }, CLEANUP_INTERVAL_MS);

  function cleanup() {
    const t = now();
    for (const id of store.listRunIds()) {
      const live = attribution.getRun(id);
      if (live && live.state !== 'closed') continue;
      const run = live || store.readRun(id);
      if (!run) continue;
      const end = run.ended_at || run.created_at || 0;
      if (t - end >= RUN_FILE_RETENTION_MS) {
        store.removeRun(id);
        attribution.removeRun(id);
      }
    }
  }

  function recover() {
    const t = now();
    for (const id of store.listRunIds()) {
      const run = store.readRun(id);
      if (!run || run.run_id !== id) continue;
      if (run.state === 'closed') {
        attribution.addRun(run);
        continue;
      }
      if (t - (run.created_at || 0) >= RUN_FILE_RETENTION_MS) {
        run.state = 'closed';
        run.ended_at = t;
        run.reason = 'runtime_restarted';
        try { store.writeRun(run); } catch {}
        attribution.addRun(run);
        continue;
      }
      run._restartPending = true;
      attribution.addRun(run);
    }
    cleanup();
  }

  return {
    enabled: true,
    stats,
    store,
    attribution,
    emitter,
    collector,
    tasks,

    registerRun({ orgId, conversationId, contextConversationId, sourceMessageId, endpoint }) {
      try {
        const runId = newRunId((id) => !!attribution.getRun(id) || fs.existsSync(store.runPath(id)));
        const t = now();
        const run = {
          v: 1,
          run_id: runId,
          org_id: orgId,
          conversation_id: conversationId,
          reply_conversation_id: replyConversationOf(endpoint) || conversationId,
          context_conversation_id: contextConversationId || conversationId,
          source_message_id: sourceMessageId != null ? String(sourceMessageId) : null,
          endpoint,
          c4_channel: 'openmax',
          c4_id: null,
          created_at: t,
          state: 'created',
          turn_id: null,
          seq: 0,
          next_event: 1,
          events: [],
          dropped: 0,
          focus: false,
          status_only: false,
          replied_at: null,
          turn_ended_at: null,
          ended_at: null,
          reason: null,
        };
        attribution.addRun(run);
        store.writeRun(run);
        stats.runs_registered += 1;
        startHot();
        return { runId, marker: formatMarker(runId) };
      } catch (err) {
        throttle.warn('register_run', err.message);
        return null;
      }
    },

    /** C4 accepted the message: the run is queued; the first frame goes out now. */
    confirmRun(runId, c4Stdout) {
      const run = attribution.getRun(runId);
      if (!run || run.state !== 'created') return;
      try {
        const out = typeof c4Stdout === 'string' ? JSON.parse(c4Stdout.trim().split('\n').pop()) : c4Stdout;
        if (out && out.id != null) run.c4_id = out.id;
      } catch {}
      run.state = 'queued';
      if (attribution.degraded) run.status_only = true;
      emitter.track(run);
      emitter.setState(run, 'queued');
      emitter.emitNow(run);
      persistRun(run);
      if (collector.files.size === 0) void tasks.tickNow(ACTIVITY_TASKS.discovery);
    },

    /** C4 did not take the message: forget the run, send nothing. */
    dropRun(runId) {
      const run = attribution.getRun(runId);
      if (run) emitter.untrack(run);
      attribution.removeRun(runId);
      store.removeRun(runId);
      syncActive();
    },

    /** An unregistered group input (smart mode, no @) was forwarded to C4. */
    noteUnregisteredInput(endpoint) {
      stats.runs_skipped_not_mentioned += 1;
      const conv = replyConversationOf(endpoint);
      if (!conv) return;
      if (!openRuns().some((r) => (r.reply_conversation_id || r.conversation_id) === conv)) return;
      unregistered[conv] = now();
      syncActive();
    },

    bindOrgWs(orgId, ws) {
      emitter.bindOrgWs(orgId, ws);
    },

    onWsOpen(orgId) {
      emitter.onWsOpen(orgId);
      // Runs left open by a previous process end now, once this org can hear it.
      for (const run of [...attribution.runs.values()]) {
        if (run._restartPending && run.org_id === orgId && run.state !== 'closed') {
          run._restartPending = false;
          attribution.closeRun(run, 'failed', 'runtime_restarted');
        }
      }
    },

    onServerError(orgId, payload) {
      return emitter.onServerError(orgId, payload);
    },

    /**
     * Recover run files, start the hourly cleanup, and — only when recovery
     * left a run open — the hot timers. Registered on the injected TaskRegistry
     * (comm-bridge's `tasks`), so its stopAll() stops them too.
     */
    start() {
      if (started) return;
      recover();
      started = true;
      tasks.start(ACTIVITY_TASKS.cleanup);
      if (openRuns().length > 0) startHot();
      log(`[activity] agent activity reporting enabled (runtime=${runtimeName})`);
    },

    stop() {
      started = false;
      for (const n of Object.values(ACTIVITY_TASKS)) tasks.stop(n);
    },

    /** Whether the emit / poll / discovery timers are running (tests / stats). */
    get timersActive() {
      return hotRunning();
    },

    /** One collector poll + claim check + attribution timers (tests / manual use). */
    pollNow() {
      pollTick();
    },

    statsLine() {
      const send = store.readSendStats();
      return [
        `runs_active=${openRuns().length}`,
        `timers=${hotRunning() ? 'on' : 'off'}`,
        `runs_registered=${stats.runs_registered}`,
        `runs_skipped_not_mentioned=${stats.runs_skipped_not_mentioned}`,
        `frames_sent=${stats.frames_sent}`,
        `frames_dropped=${stats.frames_dropped}`,
        `events_dropped=${stats.events_dropped}`,
        `unfocused_events=${stats.attribution_unfocused_events}`,
        `parse_errors=${stats.parse_errors}`,
        `lines_oversized=${stats.lines_oversized || 0}`,
        `parse_unknown_shape=${stats.parse_unknown_shape}`,
        `unknown_frame_type=${stats.unknown_frame_type}`,
        `focus_by_signal=${fmtCounts(stats.focus_by_signal)}`,
        `focus_none_runs=${stats.focus_none_runs || 0}/${stats.mixed_turn_runs || 0}`,
        `marker_rejected=${fmtCounts(stats.marker_rejected)}`,
        `replied_via=${fmtCounts(stats.replied_via)}`,
        `merged_inputs=${stats.merged_inputs || 0}`,
        `closed_on_reply=${fmtCounts(stats.closed_on_reply || {})}`,
        `reply_failed=${stats.reply_failed || 0}`,
        `runs_closed=${fmtCounts(stats.runs_closed)}`,
        `run_reply_form=${fmtCounts(stats.run_reply_form)}`,
        `server_errors=${fmtCounts(stats.server_errors)}`,
        `send=${fmtCounts(send)}`,
        `gate=${fmtCounts(Object.fromEntries(Object.entries(gates).map(([k, v]) => [k.slice(0, 8), v])))}`,
      ].join(' ');
    },
  };
}
