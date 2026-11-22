/**
 * agent_run schema v3 — test mirrors and the shared display contract.
 *
 * Server gates (mirrors of cws-comm; update together with its MR):
 *   classifyAgentRun      — internal/app/agent_run_metadata.go: JSON object,
 *                           encoded ≤ 16 KiB, agent sender, deployment switch.
 *                           Content is not validated; a passing value is
 *                           stored as is.
 *   validateActivityFrame — internal/transport/ws/agent_activity.go: the typed
 *                           envelope (routing, sequence, state, time window)
 *                           incl. the two v3 envelope fields (C1):
 *                           exec_started_at ∈ [started_at, ended_at | now+5m],
 *                           step_count ∈ [0, 10000]; `steps` ≤ 50 objects,
 *                           opaque to the server.
 *
 * Display contract (openmax ⇄ cws-fe; cws-fe can run the same checks over the
 * fixtures in testdata/agent_run_v3/):
 *   validateAgentRunV3    — a stored summary (or its reference form)
 *   validateStepV3        — one step (summary or live frame)
 *   validateFrameV3       — the display part of a live frame payload
 * They are strict: an unknown key, enum value or an over-cap string fails.
 */

const STATES = new Set(['queued', 'thinking', 'tool', 'done', 'failed']);
const AGENT_RUN_MAX_BYTES = 16384;
const FRAME_MAX_BYTES = 16384;
const MAX_FRAME_STEPS = 50;

export const V3 = Object.freeze({
  SCHEMA_VERSION: 3,
  SUMMARY_STATES: ['done', 'failed'],
  END_REASONS: ['runtime_restarted', 'interrupted', 'no_reply'],
  KINDS: ['tool', 'thinking', 'note'],
  CATEGORIES: ['command', 'read', 'write', 'edit', 'search_files', 'search_web', 'fetch_web', 'image', 'delegate', 'kb', 'skill', 'tool'],
  STATUSES: ['running', 'ok', 'error'],
  WAIT_FOR: ['command_result', 'search_results', 'page_response', 'subagent_result', 'kb_result', 'tool_result'],
  NOTE_CODES: ['merged_turn', 'steps_omitted'],
  DETAIL_TYPES: ['text', 'links', 'output', 'diff', 'children'],
  LIMITS: {
    step_id: 32, title: 60, object: 60, body: 2000, max_steps: 500, step_count: 10000,
    detail_text: 500, links: 8, link_title: 80, link_url: 200, diff_file: 60,
    diff_preview_lines: 40, diff_preview_bytes: 2048, children: 10,
  },
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isStr = (v) => typeof v === 'string';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cps = (s) => Array.from(s).length;
// eslint-disable-next-line no-control-regex
const LINE_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const BODY_BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Go json.Encoder with SetEscapeHTML(false): JSON.stringify output, except that
 * U+2028 / U+2029 are escaped (6 bytes instead of 3), plus a trailing newline.
 */
export function goEncodedSize(v) {
  const s = JSON.stringify(v).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return Buffer.byteLength(s, 'utf8') + 1;
}

/**
 * @returns {{ verdict: 'ok'|'absent'|'stripped_disabled'|'stripped_not_agent'|'stripped_invalid'|'stripped_too_large',
 *             stored?: object }}
 */
export function classifyAgentRun({ enabled = true, senderType = 'agent', raw }) {
  if (raw === undefined || raw === null) return { verdict: 'absent' };
  if (!enabled) return { verdict: 'stripped_disabled' };
  if (senderType !== 'agent') return { verdict: 'stripped_not_agent' };
  if (!isObject(raw)) return { verdict: 'stripped_invalid' };
  if (goEncodedSize(raw) > AGENT_RUN_MAX_BYTES) return { verdict: 'stripped_too_large' };
  return { verdict: 'ok', stored: raw };
}

/** cws-comm envelope check of one agent_activity frame (raw JSON text). */
export function validateActivityFrame(rawFrameJson, nowMs) {
  if (Buffer.byteLength(rawFrameJson, 'utf8') > FRAME_MAX_BYTES) return { ok: false, error: 'too_large' };
  const frame = JSON.parse(rawFrameJson);
  const f = frame.payload;
  const fail = (error) => ({ ok: false, error });
  if (!isObject(f)) return fail('payload');
  const maxFuture = nowMs + 5 * 60 * 1000;
  if (!isStr(f.conversation_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(f.conversation_id)) return fail('conversation_id');
  if (!isStr(f.run_id) || !/^r_[0-9a-f]{8}$/.test(f.run_id)) return fail('run_id');
  if (has(f, 'source_message_id') && (!isStr(f.source_message_id) || !/^\d{1,19}$/.test(f.source_message_id))) return fail('source_message_id');
  if (!isInt(f.sequence) || f.sequence < 1 || f.sequence > 2 ** 31 - 1) return fail('sequence');
  if (!isStr(f.state) || !STATES.has(f.state)) return fail('state');
  const terminal = f.state === 'done' || f.state === 'failed';
  if (!isInt(f.started_at) || f.started_at < nowMs - 24 * 3600 * 1000 || f.started_at > maxFuture) return fail('started_at');
  if (terminal) {
    if (!isInt(f.ended_at) || f.ended_at < f.started_at || f.ended_at > maxFuture) return fail('ended_at');
  } else if (has(f, 'ended_at')) return fail('ended_at_not_allowed');
  if (has(f, 'exec_started_at')) {
    const hi = terminal ? f.ended_at : maxFuture;
    if (!isInt(f.exec_started_at) || f.exec_started_at < f.started_at || f.exec_started_at > hi) return fail('exec_started_at');
  }
  if (has(f, 'step_count') && (!isInt(f.step_count) || f.step_count < 0 || f.step_count > 10000)) return fail('step_count');
  for (const removed of ['category', 'reason', 'events']) if (has(f, removed)) return fail(`${removed}_removed`);
  if (has(f, 'schema_version') && !isInt(f.schema_version)) return fail('schema_version');
  if (has(f, 'title') && !isStr(f.title)) return fail('title');
  if (has(f, 'dropped') && (!isInt(f.dropped) || f.dropped < 0 || f.dropped > 1_000_000)) return fail('dropped');
  if (has(f, 'ttl_ms') && (!isInt(f.ttl_ms) || f.ttl_ms < 5000 || f.ttl_ms > 60000)) return fail('ttl_ms');
  const steps = has(f, 'steps') ? f.steps : [];
  if (!Array.isArray(steps)) return fail('steps');
  if (steps.length > MAX_FRAME_STEPS) return fail('steps_count');
  if (!steps.every(isObject)) return fail('steps_item');
  return { ok: true, steps };
}

// ── display contract ───────────────────────────────────────────────────────

function lineOk(v, max) {
  return isStr(v) && v.length > 0 && cps(v) <= max && !LINE_BAD.test(v) && v.trim() === v;
}

function keysOk(o, allowed, errs, where) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${where}: unknown key ${k}`);
}

/** @returns {string[]} errors (empty = valid) */
export function validateDetailV3(d, where = 'detail') {
  const L = V3.LIMITS;
  const errs = [];
  const e = (m) => errs.push(`${where}: ${m}`);
  if (!isObject(d)) return [`${where}: not an object`];
  if (!V3.DETAIL_TYPES.includes(d.type)) return [`${where}: type ${d.type}`];
  if (typeof d.truncated !== 'boolean') e('truncated must be boolean');
  if (has(d, 'detail_ref')) e('detail_ref is reserved (plan B) and not emitted');
  switch (d.type) {
    case 'text':
      keysOk(d, ['type', 'text', 'truncated'], errs, where);
      if (!isStr(d.text) || !d.text.trim() || cps(d.text) > L.detail_text || BODY_BAD.test(d.text)) e('text');
      break;
    case 'links':
      keysOk(d, ['type', 'items', 'total', 'truncated'], errs, where);
      if (!isInt(d.total) || d.total < 1) e('total');
      if (has(d, 'items')) {
        if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > L.links) e('items');
        else {
          if (d.total < d.items.length) e('total < items');
          d.items.forEach((it, i) => {
            if (!isObject(it)) { e(`items[${i}]`); return; }
            keysOk(it, ['title', 'url', 'site'], errs, `${where}.items[${i}]`);
            if (has(it, 'title') && !lineOk(it.title, L.link_title)) e(`items[${i}].title`);
            if (!isStr(it.url) || cps(it.url) > L.link_url || !/^https?:\/\//.test(it.url)) e(`items[${i}].url`);
            if (!lineOk(it.site, 253)) e(`items[${i}].site`);
          });
        }
      }
      break;
    case 'output':
      keysOk(d, ['type', 'exit_code', 'lines', 'truncated'], errs, where);
      if (has(d, 'exit_code') && !isInt(d.exit_code)) e('exit_code');
      if (!isInt(d.lines) || d.lines < 0) e('lines');
      break;
    case 'diff':
      keysOk(d, ['type', 'file', 'added', 'removed', 'preview', 'truncated'], errs, where);
      if (!lineOk(d.file, L.diff_file)) e('file');
      if (!isInt(d.added) || d.added < 0) e('added');
      if (!isInt(d.removed) || d.removed < 0) e('removed');
      if (has(d, 'preview')) {
        if (!isStr(d.preview) || !d.preview.trim() || BODY_BAD.test(d.preview)) e('preview');
        else {
          if (d.preview.split('\n').length > L.diff_preview_lines) e('preview lines');
          if (Buffer.byteLength(d.preview, 'utf8') > L.diff_preview_bytes) e('preview bytes');
        }
      }
      break;
    case 'children':
      keysOk(d, ['type', 'items', 'total', 'truncated'], errs, where);
      if (!isInt(d.total) || d.total < 1) e('total');
      if (!Array.isArray(d.items) || d.items.length > L.children) e('items');
      else d.items.forEach((it, i) => {
        if (!isObject(it)) { e(`items[${i}]`); return; }
        keysOk(it, ['title', 'object', 'status'], errs, `${where}.items[${i}]`);
        if (has(it, 'title') && !lineOk(it.title, L.title)) e(`items[${i}].title`);
        if (has(it, 'object') && !lineOk(it.object, L.object)) e(`items[${i}].object`);
        if (!V3.STATUSES.includes(it.status)) e(`items[${i}].status`);
      });
      break;
    default:
  }
  return errs;
}

/** @returns {string[]} errors (empty = valid) */
export function validateStepV3(s, where = 'step') {
  const L = V3.LIMITS;
  const errs = [];
  const e = (m) => errs.push(`${where}: ${m}`);
  if (!isObject(s)) return [`${where}: not an object`];
  if (!isStr(s.id) || s.id.length < 1 || s.id.length > L.step_id) e('id');
  if (!V3.KINDS.includes(s.kind)) return [...errs, `${where}: kind ${s.kind}`];
  if (!isInt(s.at)) e('at');
  if (s.kind === 'tool') {
    keysOk(s, ['id', 'kind', 'category', 'status', 'at', 'ended_at', 'title', 'object', 'progress', 'wait_for', 'live_preview', 'detail'], errs, where);
    if (!V3.CATEGORIES.includes(s.category)) e(`category ${s.category}`);
    if (!V3.STATUSES.includes(s.status)) e(`status ${s.status}`);
    if (s.status === 'running' && has(s, 'ended_at')) e('running step has ended_at');
    if (s.status !== 'running' && !isInt(s.ended_at)) e('finished step needs ended_at');
    if (has(s, 'ended_at') && (!isInt(s.ended_at) || s.ended_at < s.at)) e('ended_at');
    if (has(s, 'title') && !lineOk(s.title, L.title)) e('title');
    if (has(s, 'object') && !lineOk(s.object, L.object)) e('object');
    if (has(s, 'progress') && !lineOk(s.progress, 40)) e('progress');
    if (has(s, 'wait_for')) {
      if (!V3.WAIT_FOR.includes(s.wait_for)) e(`wait_for ${s.wait_for}`);
      if (s.status !== 'running') e('wait_for only on running steps');
    }
    if (has(s, 'live_preview') && s.live_preview !== true) e('live_preview');
    if (has(s, 'detail')) errs.push(...validateDetailV3(s.detail, `${where}.detail`));
  } else if (s.kind === 'thinking') {
    keysOk(s, ['id', 'kind', 'at', 'body'], errs, where);
    if (!isStr(s.body) || !s.body.trim() || cps(s.body) > L.body || BODY_BAD.test(s.body)) e('body');
  } else {
    keysOk(s, ['id', 'kind', 'at', 'code', 'count'], errs, where);
    if (!V3.NOTE_CODES.includes(s.code)) e(`code ${s.code}`);
    if (s.code === 'steps_omitted' ? !(isInt(s.count) && s.count >= 1) : has(s, 'count')) e('count');
  }
  return errs;
}

function validateSteps(steps, max, errs) {
  if (!Array.isArray(steps) || steps.length > max) {
    errs.push('steps');
    return;
  }
  const ids = new Set();
  steps.forEach((s, i) => {
    errs.push(...validateStepV3(s, `steps[${i}]`));
    if (ids.has(s?.id)) errs.push(`steps[${i}]: duplicate id ${s?.id}`);
    ids.add(s?.id);
  });
}

/** A stored summary (message.agent_run) or its reference form. @returns {string[]} errors */
export function validateAgentRunV3(ar) {
  const errs = [];
  const e = (m) => errs.push(m);
  if (!isObject(ar)) return ['not an object'];
  if (ar.schema_version !== 3) e('schema_version');
  if (!isStr(ar.run_id) || !/^r_[0-9a-f]{8}$/.test(ar.run_id)) e('run_id');
  if (ar.ref === true) {
    keysOk(ar, ['schema_version', 'run_id', 'ref'], errs, 'ref');
    return errs;
  }
  keysOk(ar, ['schema_version', 'run_id', 'source_message_id', 'state', 'queued_at', 'exec_started_at', 'ended_at',
    'step_count', 'end_reason', 'steps', 'compaction'], errs, 'agent_run');
  if (has(ar, 'source_message_id') && (!isStr(ar.source_message_id) || !/^\d{1,19}$/.test(ar.source_message_id))) e('source_message_id');
  if (!V3.SUMMARY_STATES.includes(ar.state)) e('state');
  if (!isInt(ar.queued_at)) e('queued_at');
  if (!isInt(ar.ended_at) || ar.ended_at < ar.queued_at) e('ended_at');
  if (has(ar, 'exec_started_at') && (!isInt(ar.exec_started_at) || ar.exec_started_at < ar.queued_at || ar.exec_started_at > ar.ended_at)) e('exec_started_at');
  if (!isInt(ar.step_count) || ar.step_count < 0 || ar.step_count > V3.LIMITS.step_count) e('step_count');
  if (has(ar, 'end_reason') && !V3.END_REASONS.includes(ar.end_reason)) e('end_reason');
  if (has(ar, 'compaction') && !isObject(ar.compaction)) e('compaction');
  validateSteps(ar.steps, V3.LIMITS.max_steps, errs);
  if (Array.isArray(ar.steps)) {
    const shown = ar.steps.filter((s) => s?.kind === 'tool').length;
    const omitted = ar.steps.some((s) => s?.code === 'steps_omitted');
    if (!omitted && shown > ar.step_count) e(`step_count ${ar.step_count} < tool steps ${shown}`);
  }
  return errs;
}

/** The display part of a live frame payload. @returns {string[]} errors */
export function validateFrameV3(p) {
  const errs = [];
  if (!isObject(p)) return ['payload'];
  if (p.schema_version !== 3) errs.push('schema_version');
  if (has(p, 'title')) errs.push('title is not sent in v3 (the FE maps state)');
  if (!isInt(p.step_count) || p.step_count < 0 || p.step_count > V3.LIMITS.step_count) errs.push('step_count');
  if (has(p, 'end_reason')) {
    if (!V3.END_REASONS.includes(p.end_reason)) errs.push('end_reason');
    if (p.state !== 'done' && p.state !== 'failed') errs.push('end_reason only on terminal frames');
  }
  if (p.state === 'tool') errs.push('v3 producers send thinking, not tool');
  validateSteps(p.steps, MAX_FRAME_STEPS, errs);
  return errs;
}
