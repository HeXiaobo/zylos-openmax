/**
 * agent_run (schema v2) builder: a run's merged events → display steps
 * (present.js), compacted to fit the local 15 KiB budget (cws-comm drops an
 * agent_run whose JSON is over 16,384 bytes).
 *
 * Shape (see testdata/agent_run_v2/agent_run.json):
 *   { schema_version: 2, run_id, status, started_at, ended_at, title,
 *     subtitle?, steps: [ { id, kind: action|text|note|group, status?, at,
 *     ended_at?, title?, tags?, body?, count? } ], compaction: {…} }
 * `compaction` is openmax bookkeeping (FE ignores unknown keys).
 *
 * Compaction levels (compaction.level), each tried only while still over:
 *   0  untouched
 *   1  tags removed (decorative)
 *   2  action bodies (the Bash description) removed (decorative)
 *   3  text step bodies cut to 500, then 200 code points
 *   4  text steps removed (a text step has no title, so without its body it
 *      has nothing to show)
 *   5  first / last K steps kept, the middle folded into one `group` step
 *      (K = 20, 10, 5, 2, 1)
 * Still too large → null (the reply goes out without agent_run). The 15 KiB
 * budget also keeps steps far below the 500 the display reads (a step is
 * ≥ 60 bytes; a folded summary has ≤ 41).
 * The run title ("执行了 N 步") counts the action steps BEFORE compaction, so
 * it never shrinks.
 */

import { AGENT_RUN_LOCAL_BUDGET, SCHEMA_VERSION } from './constants.js';
import { goJsonBytes } from './json-size.js';
import {
  cut, eventToStep, runTitle, runSubtitle, groupStep, replyStep,
} from './present.js';

export { cut };

/** Bytes of the agent_run value itself, encoded the way cws-comm measures it. */
export function agentRunSize(ar) {
  return goJsonBytes(ar);
}

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

/** Run events with times clamped into the run and this reply's step added. */
function prepareEvents(run, startedAt, endedAt) {
  const events = (Array.isArray(run.events) ? run.events : []).map((ev) => {
    const at = clamp(Number(ev.at) || startedAt, startedAt, endedAt);
    const out = { ...ev, at };
    if (ev.ended_at != null) out.ended_at = clamp(Number(ev.ended_at) || at, at, Math.max(at, endedAt));
    return out;
  });
  // This reply is a step of its own. The collector trails by up to one poll,
  // so the reply call is usually not in the run yet — or only as unfinished.
  const isReply = (e) => e.kind === 'tool' && e.category === 'reply';
  if (!events.some((e) => isReply(e) && e.ended_at != null)) {
    const open = [...events].reverse().find((e) => isReply(e) && e.ended_at == null);
    if (open) {
      open.ended_at = Math.max(open.at, endedAt);
      open.error = false;
    } else {
      const used = new Set(events.map((e) => e.id));
      let n = Number.isInteger(run.next_event) ? run.next_event : events.length + 1;
      while (used.has(`e${n}`)) n += 1;
      events.push({ _reply: `e${n}` });
    }
  }
  return events;
}

/**
 * @param {object} run   run file (run_id, created_at, events, dropped, next_event)
 * @param {{ now: number, budget?: number }} opts
 * @returns {object|null} the full agent_run, or null when it cannot fit
 */
export function buildAgentRun(run, { now, budget = AGENT_RUN_LOCAL_BUDGET } = {}) {
  const startedAt = Number(run.created_at);
  const endedAt = Math.max(Number(now), startedAt);
  const steps = prepareEvents(run, startedAt, endedAt)
    .map((ev) => (ev._reply ? replyStep(ev._reply, endedAt) : eventToStep(ev)))
    .filter(Boolean);
  // Unfinished at reply time (the call is still open in the log).
  for (const s of steps) if (s.status === 'running') s.status = 'unfinished';

  const actionCount = steps.filter((s) => s.kind === 'action').length;
  const ar = {
    schema_version: SCHEMA_VERSION,
    run_id: run.run_id,
    status: 'ok',
    started_at: startedAt,
    ended_at: endedAt,
    title: runTitle(actionCount),
    steps,
    compaction: {
      level: 0,
      action_count: actionCount,
      text_count: steps.filter((s) => s.kind === 'text').length,
      dropped: Math.max(0, Number(run.dropped) || 0),
      omitted: 0,
    },
  };
  const fits = () => agentRunSize(ar) <= budget;
  const level = (n, patch = {}) => {
    Object.assign(ar.compaction, { level: n }, patch);
    const subtitle = runSubtitle({ omitted: ar.compaction.omitted, trimmed: n >= 3 });
    if (subtitle) ar.subtitle = subtitle;
  };
  if (fits()) return ar;

  // 1: decorative tags.
  for (const s of ar.steps) delete s.tags;
  level(1);
  if (fits()) return ar;

  // 2: decorative action bodies (the Bash description).
  for (const s of ar.steps) if (s.kind === 'action') delete s.body;
  level(2);
  if (fits()) return ar;

  // 3: shorten text bodies.
  for (const limit of [500, 200]) {
    for (const s of ar.steps) if (s.kind === 'text') s.body = cut(s.body, limit);
    level(3, { text_limit: limit });
    if (fits()) return ar;
  }

  // 4: drop text steps (nothing left to show without their body).
  ar.steps = ar.steps.filter((s) => s.kind !== 'text');
  level(4, { text_limit: 0 });
  if (fits()) return ar;

  // 5: keep the first / last K steps, fold the middle.
  const all = ar.steps;
  for (let K = 20; K >= 1; K = Math.floor(K / 2)) {
    if (all.length <= 2 * K) continue;
    const mid = all.slice(K, all.length - K);
    ar.steps = [...all.slice(0, K), groupStep(mid), ...all.slice(all.length - K)];
    level(5, { omitted: mid.length });
    if (fits()) return ar;
  }
  return null;
}

/** The reference form used by every later reply of the same run. */
export function agentRunRef(runId) {
  return { schema_version: SCHEMA_VERSION, run_id: runId, ref: true };
}
