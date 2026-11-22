/**
 * agent_run (schema v3) builder: a run's merged events → display steps
 * (present.js), compacted to fit the local 15 KiB budget (cws-comm drops an
 * agent_run whose JSON is over 16,384 bytes). Plan A (decision 5): summary +
 * truncation only; `detail_ref` stays reserved and is never emitted.
 *
 * Shape (see testdata/agent_run_v3/agent_run.json):
 *   { schema_version: 3, run_id, source_message_id?, state: 'done',
 *     queued_at, exec_started_at?, ended_at, step_count, end_reason?,
 *     steps: [ tool | thinking | note step ], compaction: { level, omitted?, dropped? } }
 * `compaction` is openmax bookkeeping (the FE may ignore it).
 *
 * Compaction ladder (compaction.level), each tried only while still over:
 *   0  untouched
 *   1  every detail re-cut to half its caps (truncated: true)
 *   2  diff previews removed (truncated: true)
 *   3  thinking bodies cut to 200 code points
 *   4  links details keep only `total`; text details removed
 *   5  thinking steps removed
 *   6  first / last K steps kept, the middle replaced by one note
 *      { code: 'steps_omitted', count } (K = 20, 10, 5, 2, 1)
 * Still too large → null (the reply goes out without agent_run).
 * `step_count` is the run's own count (visible tool calls started), never the
 * compacted one, so it never shrinks.
 */

import {
  AGENT_RUN_LOCAL_BUDGET, SCHEMA_VERSION, SOURCE_MESSAGE_ID_RE, END_REASONS, THINKING_COMPACT_LIMIT,
} from './constants.js';
import { goJsonBytes } from './json-size.js';
import { cut, eventToStep, omittedNote, isVisibleTool } from './present.js';
import { normalizeDetail, scaledLimits } from './detail.js';

export { cut };

/** Bytes of the agent_run value itself, encoded the way cws-comm measures it. */
export function agentRunSize(ar) {
  return goJsonBytes(ar);
}

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

/** Run events with their times clamped into [queuedAt, endedAt]. */
function prepareEvents(run, queuedAt, endedAt) {
  return (Array.isArray(run.events) ? run.events : []).map((ev) => {
    const at = clamp(Number(ev.at) || queuedAt, queuedAt, endedAt);
    const out = { ...ev, at };
    if (ev.ended_at != null) out.ended_at = clamp(Number(ev.ended_at) || at, at, Math.max(at, endedAt));
    return out;
  });
}

/** Visible tool calls started in the run (decision 6): the run's counter, else its events. */
export function runStepCount(run) {
  if (Number.isInteger(run.step_count) && run.step_count >= 0) return run.step_count;
  return (Array.isArray(run.events) ? run.events : []).filter(isVisibleTool).length;
}

/**
 * @param {object} run   run file (run_id, created_at, exec_started_at, step_count, events, dropped)
 * @param {{ now: number, budget?: number }} opts
 * @returns {object|null} the full agent_run, or null when it cannot fit
 */
export function buildAgentRun(run, { now, budget = AGENT_RUN_LOCAL_BUDGET } = {}) {
  const queuedAt = Number(run.created_at);
  const endedAt = Math.max(Number(now), queuedAt);
  const steps = prepareEvents(run, queuedAt, endedAt).map(eventToStep).filter(Boolean);

  const ar = { schema_version: SCHEMA_VERSION, run_id: run.run_id };
  if (typeof run.source_message_id === 'string' && SOURCE_MESSAGE_ID_RE.test(run.source_message_id)) {
    ar.source_message_id = run.source_message_id;
  }
  ar.state = 'done';
  ar.queued_at = queuedAt;
  if (Number.isFinite(Number(run.exec_started_at)) && run.exec_started_at != null) {
    ar.exec_started_at = clamp(Number(run.exec_started_at), queuedAt, endedAt);
  }
  ar.ended_at = endedAt;
  ar.step_count = runStepCount(run);
  if (END_REASONS.includes(run.reason)) ar.end_reason = run.reason;
  ar.steps = steps;
  ar.compaction = { level: 0 };
  const dropped = Math.max(0, Number(run.dropped) || 0);
  if (dropped) ar.compaction.dropped = dropped;

  const fits = () => agentRunSize(ar) <= budget;
  const level = (n, patch = {}) => Object.assign(ar.compaction, { level: n }, patch);
  if (fits()) return ar;

  // 1: every detail re-cut to half its caps.
  const half = scaledLimits(0.5);
  for (const s of ar.steps) {
    if (!s.detail) continue;
    const d = normalizeDetail(s.detail, half);
    if (d) {
      if (JSON.stringify(d) !== JSON.stringify(s.detail)) d.truncated = true;
      s.detail = d;
    } else delete s.detail;
  }
  level(1);
  if (fits()) return ar;

  // 2: diff previews removed.
  for (const s of ar.steps) {
    if (s.detail?.type === 'diff' && s.detail.preview !== undefined) {
      delete s.detail.preview;
      s.detail.truncated = true;
    }
  }
  level(2);
  if (fits()) return ar;

  // 3: thinking bodies cut.
  for (const s of ar.steps) if (s.kind === 'thinking') s.body = cut(s.body, THINKING_COMPACT_LIMIT);
  level(3);
  if (fits()) return ar;

  // 4: links keep only their total; text details removed.
  for (const s of ar.steps) {
    if (s.detail?.type === 'links' && s.detail.items) {
      delete s.detail.items;
      s.detail.truncated = true;
    } else if (s.detail?.type === 'text') delete s.detail;
  }
  level(4);
  if (fits()) return ar;

  // 5: thinking steps removed.
  ar.steps = ar.steps.filter((s) => s.kind !== 'thinking');
  level(5);
  if (fits()) return ar;

  // 6: keep the first / last K steps, the middle becomes one note.
  const all = ar.steps;
  for (let K = 20; K >= 1; K = Math.floor(K / 2)) {
    if (all.length <= 2 * K) continue;
    const mid = all.slice(K, all.length - K);
    ar.steps = [...all.slice(0, K), omittedNote(mid), ...all.slice(all.length - K)];
    level(6, { omitted: mid.length });
    if (fits()) return ar;
  }
  return null;
}

/** The reference form used by every later reply of the same run. */
export function agentRunRef(runId) {
  return { schema_version: SCHEMA_VERSION, run_id: runId, ref: true };
}
