/**
 * Test-only JS mirror of what cws-comm checks under agent_run schema v2
 * (agent-run-generic-render plan, MR 1). cws-comm no longer validates content:
 *
 *   classifyAgentRun      — internal/app/agent_run_metadata.go sanitizeAgentRun:
 *                           the three gates (JSON object, encoded ≤ 16 KiB,
 *                           agent sender) plus the deployment switch. A value
 *                           that fails is dropped (the message is still sent);
 *                           one that passes is stored as is.
 *   validateActivityFrame — internal/transport/ws/agent_activity.go: the typed
 *                           envelope (routing, sequence, state, time window,
 *                           rate limits) and `steps` only as an array of ≤ 50
 *                           objects; `title` a string. The steps themselves are
 *                           opaque.
 *
 * The producer side (compact.js, emitter.js) is checked against these in
 * compact.test.js / emitter.test.js / reply.test.js. Update together with the
 * cws-comm MR if its gates differ.
 */

const STATES = new Set(['queued', 'thinking', 'tool', 'done', 'failed']);
const AGENT_RUN_MAX_BYTES = 16384;
const FRAME_MAX_BYTES = 16384;
const MAX_FRAME_STEPS = 50;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isStr = (v) => typeof v === 'string';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
