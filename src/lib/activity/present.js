/**
 * agent_run schema v3 steps — the one place that decides what a step looks
 * like, for the live frame and the stored summary alike (plan §2.3: one step
 * shape, one generator, one privacy rule; only the size budget differs).
 *
 * openmax sends keys, the FE owns wording (decision 7): `category`,
 * `wait_for`, note `code` are fixed enums mapped to (i18n) text by cws-fe.
 * A step `title` is sent only when it carries text the FE cannot derive — the
 * agent's own action description (Bash / Monitor `description`, sub-agent
 * task description) or a generic tool's display name; otherwise the FE shows
 * its category label. `object` is the call's target (search terms, domain,
 * file name, skill name, …). Every string is token-redacted (privacy.js) and
 * cut to its cap here.
 *
 * Step kinds:
 *   tool      { id, kind, category, status, at, ended_at?, title?, object?,
 *               wait_for?, live_preview?, detail? }
 *   thinking  { id, kind, at, body }      (agent commentary between tools)
 *   note      { id, kind, at, code, count? }
 */

import {
  CATEGORIES, HIDDEN_CATEGORIES, WAIT_FOR, TEXT_LIMIT, TITLE_LIMIT, OBJECT_LIMIT, STEP_ID_LIMIT,
  FRAME_DETAIL_BYTES,
} from './constants.js';
import { redactDisplay, isEmptyAfterRedaction } from './privacy.js';
import {
  cut, line, bodyText, displayLine, normalizeDetail, scaledLimits, DETAIL_LIMITS,
} from './detail.js';

export { cut, line, bodyText };

const CATEGORY_SET = new Set(CATEGORIES);
const HIDDEN_SET = new Set(HIDDEN_CATEGORIES);
const NOTE_FROM_NOTICE = new Set(['merged_turn']);

const stepId = (id) => cut(String(id ?? ''), STEP_ID_LIMIT);

/** A run event's category as sent: one of CATEGORIES (unknown → 'tool'). */
export function stepCategory(category) {
  return CATEGORY_SET.has(category) ? category : 'tool';
}

/** Whether a tool event becomes a visible, counted step (reply / wait polls do not). */
export function isVisibleTool(ev) {
  return ev?.kind === 'tool' && !HIDDEN_SET.has(ev.category);
}

/** Redacted thinking body (≤ 2000 code points), or undefined when nothing is left. */
export function thinkingBody(text) {
  const body = bodyText(redactDisplay(text), TEXT_LIMIT);
  return body.trim() && !isEmptyAfterRedaction(body) ? body : undefined;
}

/**
 * One run event (commentary / tool / notice; a tool's start and end are the
 * same event) → a v3 step, or null when it has nothing to show.
 */
export function eventToStep(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.kind === 'commentary') {
    const body = thinkingBody(ev.text);
    if (!body) return null;
    return { id: stepId(ev.id), kind: 'thinking', at: ev.at, body };
  }
  if (ev.kind === 'tool') {
    if (!isVisibleTool(ev)) return null;
    const done = ev.ended_at != null;
    const category = stepCategory(ev.category);
    const step = {
      id: stepId(ev.id), kind: 'tool', category, status: done ? (ev.error ? 'error' : 'ok') : 'running', at: ev.at,
    };
    if (done) step.ended_at = ev.ended_at;
    const title = displayLine(ev.title, TITLE_LIMIT);
    if (title) step.title = title;
    const object = displayLine(ev.object, OBJECT_LIMIT);
    if (object) step.object = object;
    if (!done && WAIT_FOR[category]) step.wait_for = WAIT_FOR[category];
    if (ev.live_preview === true) step.live_preview = true;
    const detail = normalizeDetail(ev.detail);
    if (detail) step.detail = detail;
    return step;
  }
  if (ev.kind === 'notice') {
    if (!NOTE_FROM_NOTICE.has(ev.code)) return null;
    return { id: stepId(ev.id), kind: 'note', at: ev.at, code: ev.code };
  }
  return null;
}

/** The note that replaces the folded middle of a compacted summary. */
export function omittedNote(mid) {
  return { id: 'omitted', kind: 'note', at: mid[0].at, code: 'steps_omitted', count: mid.length };
}

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Live-frame budget for one step's detail (plan §4.1 emitter): ≤ 4 KiB —
 * over it, re-cut to half, then a quarter of the caps; still over → the
 * detail is left out of the frame (the summary keeps its own copy).
 */
export function fitFrameDetail(step, maxBytes = FRAME_DETAIL_BYTES) {
  if (!step?.detail || jsonBytes(step.detail) <= maxBytes) return step;
  for (const f of [0.5, 0.25]) {
    const d = normalizeDetail({ ...step.detail, preview: step.detail.preview }, scaledLimits(f, DETAIL_LIMITS));
    if (d && jsonBytes(d) <= maxBytes) {
      d.truncated = true;
      step.detail = d;
      return step;
    }
  }
  delete step.detail;
  return step;
}
