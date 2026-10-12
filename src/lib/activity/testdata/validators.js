/**
 * Test-only JS mirror of cws-comm's two server-side validators, so the
 * producer side can be checked against the exact rules it must satisfy:
 *
 *   validateActivityFrame — internal/transport/ws/agent_activity.go
 *                           normalizeAgentActivity / normalizeActivityEvent
 *   classifyAgentRun      — internal/app/agent_run_metadata.go ClassifyAgentRun
 *
 * The mirror is itself pinned to cws-comm through the golden validator
 * samples (validators.test.js), copied from cws-comm @ 8beb62d.
 */

const set = (...v) => new Set(v);
const STATES = set('queued', 'thinking', 'tool', 'done', 'failed');
const KINDS = set('commentary', 'tool', 'notice');
const CATEGORIES = set('command', 'read', 'write', 'search', 'web', 'image', 'delegate', 'waiting', 'tool', 'kb', 'reply');
const NOTICES = set('merged_turn', 'focus_acquired', 'truncated');
const TOOLS = set('Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'TodoWrite', 'exec_command', 'apply_patch', 'view_image', 'read_file', 'web_search_call', 'tool_search_call');
const DETAILS = set('node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'rg', 'cat', 'sed', 'ls', 'git', 'gh', 'curl', 'jq', 'bash', 'sh');
const REASONS = { done: set('no_reply'), failed: set('runtime_restarted', 'interrupted') };
const KIND_FIELDS = { commentary: set('text'), tool: set('category', 'tool', 'detail', 'ended_at', 'error'), notice: set('code') };
const OPTIONAL_EVENT_FIELDS = ['text', 'category', 'tool', 'detail', 'ended_at', 'error', 'code'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isStr = (v) => typeof v === 'string';
// Go unicode.IsControl: C0, DEL, C1.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const runes = (s) => Array.from(s).length;

function validText(s) {
  return isStr(s) && s !== '' && runes(s) <= 2000 && !CONTROL_EXCEPT_NL_TAB.test(s);
}

export function validateActivityFrame(rawFrameJson, nowMs) {
  if (Buffer.byteLength(rawFrameJson, 'utf8') > 16384) return { ok: false, error: 'too_large' };
  const frame = JSON.parse(rawFrameJson);
  const f = frame.payload;
  const fail = (error) => ({ ok: false, error });
  if (!f || typeof f !== 'object' || Array.isArray(f)) return fail('payload');
  const maxFuture = nowMs + 5 * 60 * 1000;
  if (!isStr(f.conversation_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(f.conversation_id)) return fail('conversation_id');
  if (!isStr(f.run_id) || !/^r_[0-9a-f]{8}$/.test(f.run_id)) return fail('run_id');
  if (has(f, 'source_message_id') && (!isStr(f.source_message_id) || !/^\d{1,19}$/.test(f.source_message_id))) return fail('source_message_id');
  if (!isInt(f.sequence) || f.sequence < 1 || f.sequence > 2 ** 31 - 1) return fail('sequence');
  if (!isStr(f.state) || !STATES.has(f.state)) return fail('state');
  const terminal = f.state === 'done' || f.state === 'failed';
  const unknownEnums = [];
  if (f.state === 'tool') {
    if (!isStr(f.category)) return fail('category');
    if (!CATEGORIES.has(f.category)) unknownEnums.push('category');
  } else if (has(f, 'category')) return fail('category_not_allowed');
  if (!isInt(f.started_at) || f.started_at < nowMs - 24 * 3600 * 1000 || f.started_at > maxFuture) return fail('started_at');
  if (terminal) {
    if (!isInt(f.ended_at) || f.ended_at < f.started_at || f.ended_at > maxFuture) return fail('ended_at');
  } else if (has(f, 'ended_at')) return fail('ended_at_not_allowed');
  if (has(f, 'reason')) {
    if (!terminal) return fail('reason_not_allowed');
    if (!isStr(f.reason)) return fail('reason_type');
    if (!REASONS[f.state].has(f.reason)) unknownEnums.push('reason');
  }
  if (has(f, 'dropped') && (!isInt(f.dropped) || f.dropped < 0 || f.dropped > 1_000_000)) return fail('dropped');
  if (has(f, 'ttl_ms') && (!isInt(f.ttl_ms) || f.ttl_ms < 5000 || f.ttl_ms > 60000)) return fail('ttl_ms');
  const droppedEvents = [];
  const events = [];
  if (has(f, 'events')) {
    if (!Array.isArray(f.events)) return fail('events');
    if (f.events.length > 50) return fail('events_count');
    const minAt = f.started_at - 5000;
    for (const [i, e] of f.events.entries()) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(`events[${i}]`);
      if (!isStr(e.id) || !/^[A-Za-z0-9_-]{1,32}$/.test(e.id)) return fail(`events[${i}].id`);
      if (!isStr(e.kind) || !KINDS.has(e.kind)) return fail(`events[${i}].kind`);
      if (!isInt(e.at) || e.at < minAt || e.at > maxFuture) return fail(`events[${i}].at`);
      const allowed = KIND_FIELDS[e.kind];
      if (OPTIONAL_EVENT_FIELDS.some((n) => !allowed.has(n) && has(e, n))) { droppedEvents.push('fields'); continue; }
      if (e.kind === 'commentary' && !validText(e.text)) { droppedEvents.push('text'); continue; }
      if (e.kind === 'tool') {
        if (!has(e, 'category')) { droppedEvents.push('missing'); continue; }
        if (!isStr(e.category)) { droppedEvents.push('fields'); continue; }
        if (!CATEGORIES.has(e.category)) unknownEnums.push('category');
        if (has(e, 'tool') && !TOOLS.has(e.tool)) unknownEnums.push('tool');
        if (has(e, 'detail') && !DETAILS.has(e.detail)) unknownEnums.push('detail');
        if (has(e, 'ended_at') && (!isInt(e.ended_at) || e.ended_at < e.at || e.ended_at > maxFuture)) { droppedEvents.push('ended_at'); continue; }
        if (has(e, 'error') && (typeof e.error !== 'boolean' || !has(e, 'ended_at'))) { droppedEvents.push('error_flag'); continue; }
      }
      if (e.kind === 'notice') {
        if (!has(e, 'code')) { droppedEvents.push('missing'); continue; }
        if (!NOTICES.has(e.code)) { unknownEnums.push('notice_code'); continue; }
      }
      events.push(e);
    }
  }
  return { ok: true, events, droppedEvents, unknownEnums };
}

// ── metadata.agent_run ─────────────────────────────────────────────────────
const RUN_STATES = set('done', 'failed');
const STEP_KINDS = set('commentary', 'tool', 'notice', 'omitted');
const STATUSES = set('ok', 'error', 'unfinished');
const TEXT_LIMITS = set(2000, 500, 200, 0);
const STEP_KIND_FIELDS = { commentary: set('text'), tool: set('ended_at', 'status'), notice: set(), omitted: set('ended_at', 'status', 'count') };
const OPTIONAL_STEP_FIELDS = ['text', 'ended_at', 'status', 'count'];

const intOK = (v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 2 ** 53;
const present = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function validStepText(s, max, allowNlTab) {
  if (!isStr(s) || runes(s) > max) return false;
  return !(allowNlTab ? CONTROL_EXCEPT_NL_TAB : CONTROL).test(s);
}

function encodedSize(v) {
  // Go json.Encoder with SetEscapeHTML(false) — differs from JSON.stringify
  // only for U+2028 / U+2029 (escaped by Go), which redactText removes.
  const s = JSON.stringify({ agent_run: v }).replace(/[\u2028\u2029]/g, '\\u2028');
  return Buffer.byteLength(s, 'utf8');
}

export function classifyAgentRun({ enabled, senderType, raw, now }) {
  if (!enabled) return { verdict: 'stripped_disabled', normalized: null };
  if (senderType !== 'agent') return { verdict: 'stripped_not_agent', normalized: null };
  const invalid = (detail) => ({ verdict: 'stripped_invalid', detail, normalized: null });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('not object');
  const header = () => {
    if (!intOK(raw.v) || raw.v !== 1) return 'v';
    if (!isStr(raw.run_id) || !/^r_[0-9a-f]{8}$/.test(raw.run_id)) return 'run_id';
    return null;
  };
  const keys = Object.keys(raw);
  if (keys.length === 2 && present(raw, 'v') && present(raw, 'run_id')) {
    const h = header();
    if (h) return invalid(h);
    return { verdict: 'ref', normalized: { v: 1, run_id: raw.run_id } };
  }
  if (encodedSize(raw) > 16384) return { verdict: 'stripped_too_large', normalized: null };
  const h = header();
  if (h) return invalid(h);
  if (!isStr(raw.state) || !RUN_STATES.has(raw.state)) return invalid('state');
  if (!intOK(raw.started_at) || raw.started_at < now - 24 * 3600 * 1000 || raw.started_at > now + 300000) return invalid('started_at');
  if (!intOK(raw.ended_at) || raw.ended_at < raw.started_at || raw.ended_at > now + 300000) return invalid('ended_at');
  const s = raw.summary;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return invalid('summary');
  const summary = {};
  for (const k of ['step_count', 'commentary_count', 'duration_ms', 'dropped', 'omitted_count']) {
    if (!intOK(s[k]) || s[k] < 0) return invalid(`summary.${k}`);
    summary[k] = s[k];
  }
  if (typeof s.compacted !== 'boolean') return invalid('summary.compacted');
  summary.compacted = s.compacted;
  if (!intOK(s.compaction_level) || s.compaction_level < 0 || s.compaction_level > 3) return invalid('summary.compaction_level');
  summary.compaction_level = s.compaction_level;
  if (!intOK(s.text_limit) || !TEXT_LIMITS.has(s.text_limit)) return invalid('summary.text_limit');
  summary.text_limit = s.text_limit;
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 500) return invalid('steps');
  const steps = [];
  let unknownCategories = 0;
  for (const [i, st] of raw.steps.entries()) {
    if (!st || typeof st !== 'object' || Array.isArray(st)) return invalid(`steps[${i}]`);
    if (!isStr(st.id) || !/^[A-Za-z0-9_-]{1,32}$/.test(st.id)) return invalid(`steps[${i}].id`);
    if (!isStr(st.kind) || !STEP_KINDS.has(st.kind)) return invalid(`steps[${i}].kind`);
    if (!intOK(st.at) || st.at < raw.started_at - 5000 || st.at > raw.ended_at + 5000) return invalid(`steps[${i}].at`);
    const allowed = STEP_KIND_FIELDS[st.kind];
    if (OPTIONAL_STEP_FIELDS.some((f) => present(st, f) && !allowed.has(f))) continue;
    const out = { id: st.id, kind: st.kind, at: st.at };
    let category = st.category;
    if (!isStr(category)) continue;
    if (st.kind === 'tool') {
      if (!CATEGORIES.has(category)) { category = 'tool'; unknownCategories += 1; }
    } else if (category !== st.kind) continue;
    out.category = category;
    if (!isStr(st.description) || !validStepText(st.description, 80, false)) continue;
    out.description = st.description;
    if (present(st, 'text')) {
      if (!validStepText(st.text, 2000, true)) continue;
      out.text = st.text;
    }
    if (present(st, 'ended_at')) {
      if (!intOK(st.ended_at) || st.ended_at < st.at) continue;
      out.ended_at = st.ended_at;
    }
    if (st.kind === 'tool' || st.kind === 'omitted') {
      if (!isStr(st.status) || !STATUSES.has(st.status)) continue;
      out.status = st.status;
    }
    if (st.kind === 'omitted') {
      if (!intOK(st.count) || st.count < 1) continue;
      out.count = st.count;
    }
    steps.push(out);
  }
  if (steps.length === 0) return { verdict: 'stripped_invalid', detail: 'no step left', normalized: null, unknownCategories };
  return {
    verdict: 'ok',
    normalized: { v: 1, run_id: raw.run_id, state: raw.state, started_at: raw.started_at, ended_at: raw.ended_at, steps, summary },
    unknownCategories,
  };
}
