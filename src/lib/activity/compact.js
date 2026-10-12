/**
 * metadata.agent_run builder: a run's merged events → steps, compacted to fit
 * the local 15 KiB budget (cws-comm caps {"agent_run": …} at 16,384 bytes).
 *
 * Tool step description: the sanitized Bash `description` (classify.js
 * sanitizeDescription, ≤ 80 code points) when the run event has one, else the
 * allowlisted program name (`detail`), else empty.
 *
 * Compaction levels (summary.compaction_level):
 *   0  untouched
 *   1  commentary text cut to 500, then 200 code points
 *   2  commentary text removed (description kept)
 *   3  first / last K steps kept, the middle folded into one `omitted` step
 *      (K = 20, 10, 5, 2, 1)
 * Still too large → null (the reply goes out without agent_run).
 * summary.step_count / commentary_count always describe the run BEFORE
 * compaction, so the "N steps" label never shrinks.
 */

import { AGENT_RUN_LOCAL_BUDGET, DESCRIPTION_LIMIT, TEXT_LIMIT } from './constants.js';

// Any control character (description allows none; text allows \n and \t).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function agentRunSize(ar) {
  return Buffer.byteLength(JSON.stringify({ agent_run: ar }), 'utf8');
}

/** Cut to at most `limit` code points, ending in "…" when shortened. */
export function cut(text, limit) {
  const cps = Array.from(String(text ?? ''));
  if (cps.length <= limit) return cps.join('');
  return `${cps.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

function describe(text) {
  return cut(String(text ?? '').replace(/\s+/g, ' ').replace(CONTROL_RE, '').trim(), DESCRIPTION_LIMIT);
}

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

/** One stored run event (frame-event shape, start/end merged) → one step. */
export function eventToStep(ev, { startedAt, endedAt }) {
  const at = clamp(Number(ev.at) || startedAt, startedAt, endedAt);
  if (ev.kind === 'commentary') {
    const text = cut(String(ev.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), TEXT_LIMIT);
    if (!text.trim()) return null;
    return { id: ev.id, kind: 'commentary', category: 'commentary', description: describe(text), text, at };
  }
  if (ev.kind === 'tool') {
    const step = { id: ev.id, kind: 'tool', category: ev.category || 'tool', description: describe(ev.description || ev.detail || ''), at };
    if (ev.ended_at != null) {
      step.ended_at = clamp(Number(ev.ended_at) || at, at, Math.max(at, endedAt));
      step.status = ev.error ? 'error' : 'ok';
    } else {
      step.status = 'unfinished';
    }
    return step;
  }
  if (ev.kind === 'notice') {
    return { id: ev.id, kind: 'notice', category: 'notice', description: describe(ev.code), at };
  }
  return null;
}

function setLevel(ar, level, patch) {
  ar.summary.compaction_level = level;
  ar.summary.compacted = level > 0;
  Object.assign(ar.summary, patch);
}

/**
 * @param {object} run   run file (run_id, created_at, events, dropped, next_event)
 * @param {{ now: number, budget?: number }} opts
 * @returns {object|null} the full-form agent_run, or null when it cannot fit
 */
export function buildAgentRun(run, { now, budget = AGENT_RUN_LOCAL_BUDGET } = {}) {
  const startedAt = Number(run.created_at);
  const endedAt = Math.max(Number(now), startedAt);
  const steps = (Array.isArray(run.events) ? run.events : [])
    .map((ev) => eventToStep(ev, { startedAt, endedAt }))
    .filter(Boolean);

  // This reply is a step of its own. The collector trails by up to one poll,
  // so the reply call is usually not in the run yet — or only as unfinished.
  const hasDoneReply = steps.some((s) => s.category === 'reply' && s.status !== 'unfinished');
  if (!hasDoneReply) {
    const open = [...steps].reverse().find((s) => s.category === 'reply' && s.status === 'unfinished');
    if (open) {
      open.ended_at = Math.max(open.at, endedAt);
      open.status = 'ok';
    } else {
      const usedIds = new Set(steps.map((s) => s.id));
      let n = Number.isInteger(run.next_event) ? run.next_event : steps.length + 1;
      while (usedIds.has(`e${n}`)) n += 1;
      steps.push({ id: `e${n}`, kind: 'tool', category: 'reply', description: '', at: endedAt, ended_at: endedAt, status: 'ok' });
    }
  }

  const ar = {
    v: 1,
    run_id: run.run_id,
    state: 'done',
    started_at: startedAt,
    ended_at: endedAt,
    steps,
    summary: {
      step_count: steps.filter((s) => s.kind === 'tool').length,
      commentary_count: steps.filter((s) => s.kind === 'commentary').length,
      duration_ms: endedAt - startedAt,
      dropped: Math.max(0, Number(run.dropped) || 0),
      compacted: false,
      compaction_level: 0,
      text_limit: TEXT_LIMIT,
      omitted_count: 0,
    },
  };
  if (agentRunSize(ar) <= budget) return ar;

  // Level 1: shorten commentary text.
  for (const limit of [500, 200]) {
    for (const s of ar.steps) if (s.text) s.text = cut(s.text, limit);
    setLevel(ar, 1, { text_limit: limit });
    if (agentRunSize(ar) <= budget) return ar;
  }

  // Level 2: drop commentary text, keep descriptions; no step is removed.
  for (const s of ar.steps) delete s.text;
  setLevel(ar, 2, { text_limit: 0 });
  if (agentRunSize(ar) <= budget) return ar;

  // Level 3: keep the first / last K steps, fold the middle.
  const all = ar.steps;
  for (let K = 20; K >= 1; K = Math.floor(K / 2)) {
    if (all.length <= 2 * K) continue;
    const mid = all.slice(K, all.length - K);
    ar.steps = [
      ...all.slice(0, K),
      {
        id: 'omitted',
        kind: 'omitted',
        category: 'omitted',
        description: `…中间 ${mid.length} 步`,
        count: mid.length,
        at: mid[0].at,
        ended_at: Math.max(...mid.map((s) => s.ended_at ?? s.at)),
        status: mid.some((s) => s.status === 'error') ? 'error' : 'ok',
      },
      ...all.slice(all.length - K),
    ];
    setLevel(ar, 3, { omitted_count: mid.length });
    if (agentRunSize(ar) <= budget) return ar;
  }
  return null;
}

/** The reference form used by every later reply of the same run. */
export function agentRunRef(runId) {
  return { v: 1, run_id: runId };
}
