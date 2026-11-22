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
 *          turn replies to counts as ③; one with a literal "noRun": true is
 *          neither a reply nor ③. A reply that names its source message
 *          (endpoint `|msg:<id>`, or a literal comm CLI "sourceMessageId",
 *          OPENM-1337) replies only the owner with that source_message_id —
 *          or answers the merged-in unmarked openmax message with that id
 *          (once the send succeeds, its arrival record is acknowledged, so the
 *          group guard is lifted for it) — and never another run (send.js
 *          selects the same way).
 *       ④ not foreign and every owner in one conversation → the earliest
 *          unreplied owner
 *   - turn end: replied owners → done; the others get 120 s to reply, then
 *     done / no_reply.
 *
 * Merged inputs (10-22): while the agent is busy the runtime queues C4
 * messages and hands several over as ONE input (turn-opening prompt or a
 * mid-turn injection), concatenated in arrival order. Every C4 message in it
 * is checked on its own (marker.splitInputSegments): each valid [OM-RUN …]
 * message makes its run an owner, wherever it sits in the input; every other
 * message is a foreign item. The turn keeps them in a queue:
 *   - a turn-opening merged input keeps arrival order; a mid-turn injection
 *     puts its foreign messages in FRONT (the agent usually switches to what
 *     just arrived) and appends its runs;
 *   - in a turn with foreign items, ④ is replaced by queue order: focus = the
 *     first pending item if it is a run, none while it is a foreign message;
 *   - a foreign message is answered by a c4-send to its own reply-via channel
 *     and endpoint: no ③ pause, the queue moves on (to the next run);
 *   - reading a foreign message's spill file moves it to the front (the agent
 *     is now looking at it): no focus until it is answered;
 *   - ① (own spill read) and ② still win; a send whose destination is not a
 *     known message of the turn is still ③.
 * Limits: a foreign message with no reply-via (control / scheduled task) can
 * never be answered, so a turn that starts with one keeps no focus (as
 * before). Work on a foreign message that comes AFTER an openmax run in the
 * same input, done before that run is answered and without reading the
 * foreign spill file, is attributed to the run; so is foreign work between
 * two sends to the same foreign message.
 *
 * Terminal state (10-22): a run is closed `done` as soon as its reply is
 * known delivered — send.js's claim turns `delivered` (POST 2xx), or a
 * log-visible openmax reply call ends without error — instead of waiting for
 * the turn to end. A reply call that ends with an error undoes its `replied`
 * mark (the run keeps going; the usual turn-end / no-reply rules apply), and
 * a failed send to a merged-in foreign message puts that message back to
 * pending at the front of the queue. A Codex exec send that is still running
 * is settled by the write_stdin poll that sees it exit (sendCalls).
 * Closing is idempotent and never regressed: turn end, timers and restart
 * handling skip closed runs.
 *
 * Continuation runs (OPENM-1089 ①): a reply closes its run (above), but the
 * agent often answers first ("收到，我来查") and keeps working. In a turn
 * that is not foreign and whose owners share one conversation, the answered
 * run is continuable: the next VISIBLE tool step of the turn with no unreplied
 * owner left (not commentary, not a reply / wait call) opens a continuation —
 * a new run_id for the same source message (spawnContinuation, built by
 * index.js like a registered run), which takes focus, streams live and is
 * carried in full by the next reply. Each reply closes the current segment;
 * no visible step between two replies → no continuation (the second reply
 * carries the reference, as before). At most MAX_CONTINUATIONS_PER_TURN per
 * turn; none while blocked (③) or degraded. A continuation still unanswered
 * at turn end closes done without no_reply: its parent was answered.
 *
 * Guard-skipped replies (OPENM-1089 ②): send.js's group guard may decide a
 * reply answers an unregistered smart-mode message, not the run (no claim, no
 * agent_run; it leaves runs/<run_id>.skip). The sender's decision wins: when
 * such a log reply settles ok (replySkipped: a skip file written while THIS
 * call ran, by the log records' own timestamps), the run is NOT completed —
 * it goes back to unanswered with ambiguous_reply, and the send answers the
 * unmarked openmax message of the same endpoint that was pending when the
 * call started (the earliest-arrived one, snapshotted then: a message that
 * arrives while the send is in flight is never acknowledged by it). The
 * guard is updated only when such a message was acknowledged, by its
 * identity (onAmbiguousReply with its server message id): index.js removes
 * that message's arrival record only — none for a message without an id —
 * and keeps the guard while any other recorded smart-mode message is
 * outstanding, so only when none is left does the next reply select the run;
 * the queue moves on. No later reply → done after the no-reply
 * grace, without no_reply (the merged reply may well have answered it).
 */

import { classifyTool } from './classify.js';
import { isVisibleTool, thinkingBody } from './present.js';
import { startDetail, endDetail } from './tool-detail.js';
import { normalizeDetail } from './detail.js';
import { resolveMarkedRun, normEndpoint, parseMarker, sourceMessageIdFromSpillHead, endpointSourceMessageId } from './marker.js';
import { parseEndpoint } from '../message.js';
import {
  NO_REPLY_GRACE_MS, ACTIVE_IDLE_TIMEOUT_MS, QUEUED_NO_START_TIMEOUT_MS, REPLY_REF_WINDOW_MS,
  MAX_CONTINUATIONS_PER_TURN,
} from './constants.js';

const MAX_RUN_EVENTS = 2000;

/** The conversation a reply to `endpoint` goes to, as index.js keys the guard. */
function replyConvOfEndpoint(endpoint) {
  try {
    const ep = parseEndpoint(endpoint);
    return ep.conversationId;
  } catch {
    return null;
  }
}

/** A merged-in message that is not a valid openmax run of this host. */
function foreignItem(seg) {
  const ctx = seg?.ctx || {};
  return {
    foreign: true,
    reply: ctx.replyVia || null,
    spill: ctx.spillConvId != null ? String(ctx.spillConvId) : null,
    answered: false,
  };
}
/** The turn's opening input was never seen (collector joined mid-turn). */
const unknownItem = () => ({ foreign: true, reply: null, spill: null, answered: false });

export function createAttribution({
  now = Date.now,
  emitter,
  stats,
  throttle,
  persist = () => {},
  onRunClosed = () => {},
  readSpillHead,
  // OPENM-1089 ①: build + register a continuation run of `parent` (index.js);
  // null when it cannot be created.
  spawnContinuation = () => null,
  // OPENM-1089 ②: send.js's guard skipped this run's latest reply (skip file).
  replySkipped = () => false,
  // OPENM-1089 ②: a guard-skipped reply was settled — clear the conversation's guard.
  onAmbiguousReply = () => {},
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
  /**
   * callId → { runIds, items } for a send call whose outcome is still open:
   * the openmax runs it marked replied and the merged-in foreign messages it
   * marked answered, both optimistically at the call's start. Its end
   * settles them: ok → runs done (completeOnReply); error → runs back to
   * unanswered (revertReply) and foreign messages back to pending, at the
   * front of the queue (reopenItem). A Codex exec still running moves the
   * entry to `session:<id>`; a write_stdin poll on it maps its own callId to
   * the entry, and the poll that sees the exit settles it.
   *
   * Every key of one send (call, session, each poll alias — Codex allows
   * concurrent polls of one process) holds `{ send }` with the SAME send
   * object; settling removes every key that holds it, so a sibling poll
   * that returns later finds nothing to settle (see also sendOutcome).
   */
  const sendCalls = new Map();
  let turn = null;
  // Arrival order of merged-in foreign messages (the queue reorders them).
  let itemSeq = 0;
  const newForeignItem = (seg) => {
    const it = { ...foreignItem(seg), seq: ++itemSeq };
    // An unmarked openmax message: its server message id (the bridge's
    // <message-context> header, inline or in the spill file) identifies it
    // to the send guard's arrival records (OPENM-1089 ②).
    if (it.reply?.channel === 'openmax') {
      const ctx = seg?.ctx || {};
      let id = ctx.sourceMessageId || null;
      if (!id && ctx.spillPath && readSpillHead) {
        try { id = sourceMessageIdFromSpillHead(readSpillHead(ctx.spillPath)); } catch { id = null; }
      }
      if (id) it.msgId = String(id);
    }
    return it;
  };
  let degraded = false;

  const isOpen = (run) => run && run.state !== 'closed';
  const unreplied = (run) => isOpen(run) && run.state !== 'replied';
  const pendingItem = (it) => (it.run ? unreplied(it.run) : !it.answered);

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
    if (turn.blocked) return null;
    if (turn.foreign) {
      // Mixed turn: messages are taken in queue order; none while the first
      // pending one is another channel's message.
      const front = turn.queue.find(pendingItem);
      return front?.run || null;
    }
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

  /**
   * Resolve every C4 message of an input (a merged input carries several).
   * Inputs built without `segments` are one message.
   * @returns {{ seg: {head, ctx}, run: object|null }[]}
   */
  function resolveSegments(input, { count }) {
    const segs = Array.isArray(input.segments) && input.segments.length
      ? input.segments : [{ head: input.head, ctx: input.ctx }];
    if (segs.length > 1 && count) stats.merged_inputs = (stats.merged_inputs || 0) + 1;
    const seen = new Set();
    return segs.map((seg) => {
      let run = resolve(seg, { count });
      if (run && seen.has(run)) run = null;      // the same marker twice: one owner
      if (run) seen.add(run);
      return { seg, run };
    });
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
      // A continuation nobody answered (e.g. memory work after the reply): its
      // parent was answered — done, no no-reply grace.
      else if (run.continues) closeRun(run, 'done');
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
    sendCalls.clear();
    // Runs closed on their reply stay listed for later replies' reference
    // form only while the turn they were answered in lasts.
    for (const run of ended.owners) {
      if (run._refListed) {
        run._refListed = false;
        persist(run);
      }
    }
  }

  function newTurn(foreign, file) {
    turn = {
      id: `${file || 'log'}:${now()}`, owners: [], queue: [], foreign, focus: null, sticky: null, blocked: false, file,
      lastAnswered: null, continuations: 0,
    };
    return turn;
  }

  /**
   * The reply of `run` is known delivered: the run ends `done` now. Idempotent
   * (a closed run is left alone), so the claim and the log may both report it.
   */
  function completeOnReply(run, via) {
    if (!isOpen(run)) return false;
    if (run.state !== 'replied') {
      markReplied(run, via);
      if (!isOpen(run)) {
        run.closed_on_reply = true;
        return true;
      }
    }
    run.closed_on_reply = true;
    // Later replies of the same turn still find the run (reference form).
    run._refListed = !!(turn && turn.owners.includes(run));
    stats.closed_on_reply = stats.closed_on_reply || {};
    stats.closed_on_reply[via] = (stats.closed_on_reply[via] || 0) + 1;
    closeRun(run, 'done');
    if (turn && turn.owners.includes(run)) {
      noteAnswered(run);
      applyFocus(2, now());
    }
    return true;
  }

  /**
   * OPENM-1089 ①: remember the run the turn last answered; it may be
   * continued when the turn is the run's own (not foreign, one conversation).
   */
  function noteAnswered(run) {
    turn.lastAnswered = run;
    const convs = new Set(turn.owners.map((r) => r.conversation_id));
    run._continuable = !turn.foreign && convs.size === 1;
  }

  /**
   * OPENM-1089 ①: a visible tool step starts with no run to take it — open a
   * continuation of the run the turn last answered, when every condition
   * holds. Returns the new run (focused) or null.
   */
  function maybeContinue(cls, t) {
    if (!turn || turn.focus || turn.blocked || turn.foreign || degraded) return null;
    if (turn.owners.some(unreplied)) return null;
    const parent = turn.lastAnswered;
    if (!parent || parent._continuable !== true) return null;
    if (!isVisibleTool({ kind: 'tool', category: cls.category })) return null;
    if (turn.continuations >= MAX_CONTINUATIONS_PER_TURN) return null;
    let run = null;
    try {
      run = spawnContinuation(parent);
    } catch {
      run = null;
    }
    if (!run) return null;
    turn.continuations += 1;
    runs.set(run.run_id, run);
    turn.owners.push(run);
    turn.queue.push({ run });
    enterTurn(run, t);
    turn.focus = run;
    setFocusFlags(run);
    emitter.emitNow(run);
    stats.continuations = (stats.continuations || 0) + 1;
    return run;
  }

  /**
   * OPENM-1089 ②: a log reply to `run` went out, but send.js's group guard
   * decided it answers an unregistered (smart-mode) message: the sender's
   * decision wins. The run is not answered (ambiguous_reply); the send
   * answers that openmax message; the guard is lifted for the next reply.
   */
  function deferReply(run, item, skip, startAt) {
    if (!isOpen(run) || run.state !== 'replied') return;
    run.state = 'active';
    run.replied_at = null;
    run.ambiguous_reply = true;
    stats.reply_deferred_unregistered = (stats.reply_deferred_unregistered || 0) + 1;
    persist(run);
    // Only the message this send could have answered (pending at its start).
    // The guard is touched only when that message was really acknowledged: a
    // smart-mode input still on its way to the runtime is not answered yet.
    if (item && !item.answered && turn && turn.queue.includes(item)) {
      item.answered = true;
      try { onAmbiguousReply(run.reply_conversation_id || run.conversation_id, { skip, startAt, msgId: item.msgId || null }); } catch {}
    }
    if (turn && turn.owners.includes(run)) applyFocus(2, now());
  }

  /**
   * A send that answered a merged-in foreign message failed: the message is
   * not answered — back to pending at the front of the queue (the agent goes
   * on with it), so its work is not attributed to the next run.
   */
  function reopenItem(it) {
    if (!it.answered || !turn || !turn.queue.includes(it)) return;
    it.answered = false;
    turn.queue.splice(turn.queue.indexOf(it), 1);
    turn.queue.unshift(it);
    turn.sticky = null;
    stats.foreign_send_failed = (stats.foreign_send_failed || 0) + 1;
    applyFocus(3, now());
    if (!turn.focus) setFocusFlags(null);
  }

  /**
   * What one result says about a send: true (confirmed success), false
   * (confirmed failure) or null (says nothing — keep waiting).
   *   - An explicit exit code decides: 0 → success, anything else → failure.
   *   - A poll result without one is neutral: `write_stdin failed: Unknown
   *     process id` (a concurrent poll already reaped the process, or it was
   *     gone before), or the poll tool itself failing, observed nothing of the
   *     send. Counting it as success closed failed sends; counting it as
   *     failure would let a lost race undo a reply that went out. The send is
   *     left to the other evidence: a sibling poll's exit code, send.js's
   *     claim (delivered → done), else the turn-end / no-reply rules.
   *   - The original Codex exec call (exitCodeRequired, set by the Codex
   *     adapter) without an exit code is a FAILURE: it never reported a
   *     completion, e.g. `exec_command failed: CreateProcess … No such file
   *     or directory` — the process never started, nothing was sent. Not
   *     neutral: a neutral result would leave a merged-in foreign message
   *     marked answered after a send that never happened (its continued work
   *     would reach the next run, review R2-1). It is safe for runs: if the
   *     reply did go out, send.js's claim re-marks the run replied (pending)
   *     or closes it done (delivered) on its own. Only a poll's code-less
   *     result is neutral (the concurrent-poll race above).
   *     "Process running with session ID" is not an outcome either: the
   *     send moves to its session and a poll's exit code settles it.
   *   - A Claude call (a non-zero exit is reported as is_error, there is no
   *     exit code) is decided by its error flag, unchanged.
   */
  function sendOutcome(input, isPoll) {
    const code = input.result?.exitCode;
    if (Number.isInteger(code)) return code === 0;
    if (isPoll) return null;
    if (input.exitCodeRequired === true) return false;
    return input.isError !== true;
  }

  /** A send call's final outcome (see sendCalls). Idempotent per run / item. */
  function settleSend(entry, ok, endAt) {
    for (const id of entry.runIds) {
      const run = runs.get(id);
      if (!ok) revertReply(run);
      else {
        const skip = isOpen(run) && run.state === 'replied'
          ? skippedBySender(run, { startAt: entry.at, endAt }) : null;
        if (skip) deferReply(run, entry.skipItems?.[id] || null, skip, entry.at);
        else completeOnReply(run, 'log');
      }
    }
    if (!ok) for (const it of entry.items) reopenItem(it);
    else {
      // OPENM-1337: a reply that named an unmarked smart-mode message by its id
      // answered it — acknowledge its arrival record, by identity, as a
      // guard-deferred reply does (OPENM-1089 ②).
      for (const it of entry.acks || []) {
        if (!it.answered) continue;
        const conv = replyConvOfEndpoint(it.reply?.endpoint);
        if (conv) try { onAmbiguousReply(conv, { msgId: it.msgId }); } catch {}
      }
    }
  }

  /** The skip record send.js left for THIS send of `run`, or null. */
  function skippedBySender(run, window) {
    try {
      const skip = replySkipped(run, window);
      return skip && typeof skip === 'object' ? skip : null;
    } catch {
      return null;
    }
  }

  /** The reply call that marked `run` replied failed: the run is not answered. */
  function revertReply(run) {
    if (!isOpen(run) || run.state !== 'replied') return;
    run.state = 'active';
    run.replied_at = null;
    stats.reply_failed = (stats.reply_failed || 0) + 1;
    persist(run);
    if (turn && turn.owners.includes(run)) applyFocus(2, now());
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
      // A poll on a still-running send (Codex exec): its result settles the send.
      const owner2 = cls.waitRef ? sendCalls.get(cls.waitRef) : null;
      if (owner2) sendCalls.set(input.callId, { send: owner2.send, poll: cls.waitRef });
      return;
    }

    const sig = cls.signals;
    // Reading a merged-in foreign message's spill file: the agent is on that
    // message now — it moves to the front, no focus until it is answered.
    const foreignSpill = sig.spillC4Ids && !sig.external
      ? turn.queue.find((it) => it.foreign && !it.answered && it.spill && sig.spillC4Ids.includes(it.spill)) : null;
    if (foreignSpill) {
      turn.queue.splice(turn.queue.indexOf(foreignSpill), 1);
      turn.queue.unshift(foreignSpill);
      turn.sticky = null;
      applyFocus(1, t);
    } else if (sig.spillC4Ids && !sig.external) {
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
    // A send elsewhere that answers no known message of this turn (or whose
    // destination is unknown) is signal ③; one that answers a merged-in
    // foreign message only moves the queue on.
    let unknownExternal = sig.externalUnknown === true;
    const answered = [];
    const answerItem = (channel, endpoint, { idUnknownOnly = false } = {}) => {
      const ne = normEndpoint(endpoint);
      const hits = turn.queue.filter((it) => it.foreign && it.reply
        && it.reply.channel === channel && normEndpoint(it.reply.endpoint) === ne
        && !(idUnknownOnly && it.msgId));
      const item = hits.find((it) => !it.answered && !answered.includes(it)) || hits[0];
      if (item && !item.answered && !answered.includes(item)) answered.push(item);
      return !!item;
    };
    // OPENM-1337: an unmarked openmax message of this turn, by its server id,
    // in the conversation the reply goes to (an id copied into another
    // conversation's endpoint answers nothing). The reply named it, so once
    // the send succeeds its arrival record is acknowledged (the group guard is
    // lifted for it — see settleSend).
    const ackedByMsg = [];
    const sameConv = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
    const answerItemByMsg = (msgId, destConv) => {
      const item = turn.queue.find((it) => it.foreign && !it.answered && !answered.includes(it)
        && it.reply?.channel === 'openmax' && it.msgId === msgId
        && sameConv(replyConvOfEndpoint(it.reply.endpoint), destConv));
      if (item) {
        answered.push(item);
        ackedByMsg.push(item);
      }
      return !!item;
    };
    const replied = [];
    for (const reply of sig.replies || []) {
      // The message the reply names (OPENM-1337): exact, never a guess.
      const src = reply.sourceMessageId || (reply.endpoint ? endpointSourceMessageId(reply.endpoint) : null);
      let match;
      if (reply.endpoint) {
        const ne = normEndpoint(reply.endpoint);
        match = (r) => normEndpoint(r.endpoint) === ne;
      } else if (reply.conversationId) {
        match = (r) => replyConv(r) === reply.conversationId;
      } else {
        continue;
      }
      if (src) {
        const own = (r) => match(r) && r.source_message_id != null && String(r.source_message_id) === src;
        const run = turn.owners
          .filter((r) => unreplied(r) && !replied.includes(r) && own(r))
          .sort((a, b) => a.created_at - b.created_at)[0];
        if (run) replied.push(run);
        // A later reply to a message whose run is already answered: nothing
        // to mark. Otherwise it answers an unmarked (smart-mode) message —
        // by its id, or one whose id could not be read — and never another
        // run: send.js attaches no run's card either.
        else if (turn.owners.some(own)) { /* already replied */ }
        else if (answerItemByMsg(src, reply.endpoint ? replyConvOfEndpoint(reply.endpoint) : reply.conversationId)) { /* answered by id */ }
        else if (reply.endpoint) answerItem('openmax', reply.endpoint, { idUnknownOnly: true });
        else if (!turn.owners.some(match)) external = unknownExternal = true;
        continue;
      }
      if (reply.conversationId && !turn.owners.some(match)) external = unknownExternal = true;
      const run = turn.owners
        .filter((r) => unreplied(r) && !replied.includes(r) && match(r))
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (run) replied.push(run);
      else if (reply.endpoint) answerItem('openmax', reply.endpoint);   // an unmarked openmax message
    }
    for (const send of sig.externalSends || []) {
      if (!answerItem(send.channel, send.endpoint)) unknownExternal = true;
    }
    if (external && !unknownExternal && !(sig.externalSends || []).length) unknownExternal = true;

    // External sends pause attribution BEFORE this operation is attributed:
    // only an openmax run this operation itself answers gets the step.
    let target = replied[0] || (external ? null : turn.focus);
    // OPENM-1089 ①: work after the reply opens a continuation run.
    if (!target && !external && !answered.length) target = maybeContinue(cls, t);
    if (target && unreplied(target)) startTool(target, input.callId, cls, t, input.name, input.input);
    else stats.attribution_unfocused_events += 1;
    for (const run of replied) markReplied(run, 'log', { pauseFocus: external });

    let marked = [];
    if (external && !unknownExternal) {
      // Every send elsewhere answers a merged-in message of this turn.
      marked = answered;
      for (const it of marked) it.answered = true;
      turn.sticky = null;
      applyFocus(3, t);
    } else if (answered.length && !external) {
      marked = answered;
      for (const it of marked) it.answered = true;
      applyFocus(2, t);
    }
    // The call's end tells whether the sends went out (settleSend).
    if (replied.length || marked.length) {
      // OPENM-1089 ②: per replied run, the unmarked openmax message of its
      // endpoint pending right now (earliest arrived) — what this send answers
      // if send.js's guard skipped it. The call's log time bounds the skip file.
      const skipItems = {};
      for (const r of replied) {
        const ne = normEndpoint(r.endpoint);
        const it = turn.queue
          .filter((q) => q.foreign && !q.answered && q.reply && q.reply.channel === 'openmax'
            && normEndpoint(q.reply.endpoint) === ne)
          .sort((a, b) => (a.seq || 0) - (b.seq || 0))[0];
        if (it) skipItems[r.run_id] = it;
      }
      sendCalls.set(input.callId, {
        send: {
          runIds: replied.map((r) => r.run_id), items: [...marked], skipItems, at: t,
          acks: ackedByMsg.filter((it) => marked.includes(it)),
        },
      });
    }

    if (external && unknownExternal) {
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
    const sc = sendCalls.get(input.callId);
    if (sc) {
      const { send } = sc;
      if (input.running === true && input.sessionId != null) {
        // Codex: the send still runs in an exec session — a poll settles it.
        sendCalls.delete(input.callId);
        sendCalls.set(`session:${input.sessionId}`, { send });
      } else if (input.running !== true) {
        sendCalls.delete(input.callId);
        const ok = sendOutcome(input, sc.poll != null);
        if (ok !== null) {
          // Settled once: every key of this send goes (concurrent poll aliases too).
          for (const [k, v] of [...sendCalls]) if (v.send === send) sendCalls.delete(k);
          settleSend(send, ok, input.at);
        }
      }
    }
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
    /**
     * Runs the collector must keep reading the log for: open runs, plus runs
     * closed on their reply whose turn has not ended yet (the turn end takes
     * them off runs/active.json).
     */
    trackedRuns() {
      return [...runs.values()].filter((r) => isOpen(r) || r._refListed === true);
    },
    closeRun,

    /**
     * A run left open by the previous openmax process (OPENM-1108). Only the
     * plugin restarted — the agent session went on and its reply goes out as
     * an ordinary message — so the run ends normally: `done`, no end reason
     * (runtime_restarted stays reserved for noteRuntimeRestart). Its tool
     * steps still running end `ok` at the close, so neither the frame nor the
     * run file leaves a step the FE would mark interrupted.
     *
     * The stored events are ended in place rather than through deliver(): a
     * run that went status-only after its steps were recorded (degradeAll /
     * noteUnknownShape, persisted across the restart) would have deliver()
     * skip the rewrite and leave the step running in the run file. The wire
     * copy still goes through the emitter, which drops it under status-only.
     */
    closeLeftoverRun(run) {
      if (!isOpen(run)) return;
      const t = now();
      for (const ev of run.events || []) {
        if (ev.kind !== 'tool' || ev.ended_at != null) continue;
        ev.ended_at = Math.max(t, Number(ev.at) || 0);
        ev.error = false;
        touch(run, t);
        emitter.pushEvent(run, ev);
      }
      closeRun(run, 'done');
    },

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

    /** send.js's claim for this run is `delivered` (POST 2xx): the run ends now. */
    noteReplyDelivered(runId) {
      return completeOnReply(runs.get(runId), 'claim');
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
            const items = resolveSegments(input, { count: true });
            const fresh = (it) => it.run && it.run.state !== 'replied';
            if (items.length === 1) {
              const { run, seg } = items[0];
              if (fresh(items[0])) {
                newTurn(false, file);
                turn.owners.push(run);
                turn.queue.push({ run });
                enterTurn(run, t);
                turn.focus = run;
                setFocusFlags(run);
              } else {
                newTurn(true, file);
                turn.queue.push(newForeignItem(seg));
              }
              return;
            }
            // Merged input: every openmax message in it opens its own run,
            // wherever it sits; the rest are foreign items, in arrival order.
            newTurn(!items.every(fresh), file);
            for (const it of items) {
              if (fresh(it)) {
                turn.owners.push(it.run);
                turn.queue.push({ run: it.run });
                enterTurn(it.run, t);
                deliver(it.run, { id: nextEventId(it.run), kind: 'notice', code: 'merged_turn', at: t });
              } else {
                turn.queue.push(newForeignItem(it.seg));
              }
            }
            applyFocus(4, t);
            return;
          }
          if (input.form === 'enqueue') {
            for (const { run } of resolveSegments(input, { count: false })) {
              if (run && (run.state === 'queued' || run.state === 'created')) emitter.setState(run, 'queued');
            }
            return;
          }
          // absorbed / queued_command: merged into the running turn.
          if (!turn) {
            newTurn(true, file);
            turn.queue.push(unknownItem());
          }
          const foreignNow = [];
          for (const { run, seg } of resolveSegments(input, { count: input.form === 'queued_command' })) {
            if (run && run.state !== 'replied') {
              if (!turn.owners.includes(run)) {
                turn.owners.push(run);
                turn.queue.push({ run });
                enterTurn(run, t);
                deliver(run, { id: nextEventId(run), kind: 'notice', code: 'merged_turn', at: t });
              }
            } else if (!run) {
              foreignNow.push(newForeignItem(seg));
            }
          }
          if (foreignNow.length) {
            // Injected mid-turn: the agent usually turns to it right away.
            turn.queue.unshift(...foreignNow);
            turn.foreign = true;
            turn.sticky = null;
          }
          applyFocus(4, t);
          if (!turn.focus) setFocusFlags(null);
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
        if (!isOpen(run)) {
          if (run._refListed && t - (run.ended_at || 0) >= REPLY_REF_WINDOW_MS) {
            run._refListed = false;
            persist(run);
          }
          continue;
        }
        if (run._awaitNoReply && t - run.turn_ended_at >= NO_REPLY_GRACE_MS) {
          // A guard-skipped reply probably answered it as well (OPENM-1089 ②).
          closeRun(run, 'done', run.ambiguous_reply === true ? null : 'no_reply');
          continue;
        }
        // A run recovered from a previous process waits for onWsOpen, which ends
        // it done, without an end reason, once its org can hear the frame (OPENM-1108).
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
