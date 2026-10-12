/**
 * Codex rollout (JSONL, `{timestamp, type, payload}` per line) → normalised
 * activity inputs. Same output shape as claude-jsonl.js; the same attribution
 * and emit logic runs on top of it.
 *
 * Fail closed: an unknown response_item payload type, or a known type whose
 * value path is missing / mistyped, is reported as `unknown` and never
 * guessed at. Field paths follow the rollout format and the fields the
 * browser-remote parser already reads; they are to be confirmed against a
 * real Codex host during integration (design §9.4 scenario 14).
 */

import { INPUT_HEAD_CHARS } from '../constants.js';
import { parseInputCtx } from '../marker.js';

const SKIP_USER_PREFIXES = ['# AGENTS.md instructions', '<environment_context>', '<skill>'];
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'web_search_call', 'tool_search_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);
const TURN_END_TYPES = new Set(['task_complete', 'task_interrupted', 'turn_aborted']);
const IGNORED_ITEM_TYPES = new Set(['reasoning']);

const IGNORED = Object.freeze({ status: 'ignored', events: [] });
const UNKNOWN = Object.freeze({ status: 'unknown', events: [] });

export function createCodexState() {
  return { turnId: null, userInputs: 0 };
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** Exit code from a tool output, used only to decide ok / error. */
export function exitCodeOf(output) {
  if (output == null) return null;
  const parsed = parseMaybeJson(output);
  if (parsed && typeof parsed === 'object') {
    const code = parsed.metadata?.exit_code ?? parsed.exit_code;
    if (Number.isInteger(code)) return code;
    if (typeof parsed.output === 'string') return exitCodeOf(parsed.output);
    return null;
  }
  const m = /(?:Process exited with code|Exit code:?)\s*(-?\d+)/.exec(String(output));
  return m ? Number(m[1]) : null;
}

function textBlocks(content, blockType) {
  return content.filter((b) => b?.type === blockType && typeof b.text === 'string').map((b) => b.text);
}

/**
 * @param {object} rec    one parsed rollout line
 * @param {object} state  per-file state from createCodexState()
 */
export function parseCodexRecord(rec, state) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return UNKNOWN;
  const p = rec.payload;
  if (rec.type !== 'event_msg' && rec.type !== 'response_item') return IGNORED;
  if (!p || typeof p !== 'object') return UNKNOWN;
  const at = Date.parse(rec.timestamp);
  if (!Number.isFinite(at)) return UNKNOWN;

  if (rec.type === 'event_msg') {
    if (p.type === 'task_started') {
      state.turnId = typeof p.turn_id === 'string' ? p.turn_id : null;
      state.userInputs = 0;
      return { status: 'ok', events: [] };
    }
    if (TURN_END_TYPES.has(p.type)) {
      if (p.turn_id && state.turnId && p.turn_id !== state.turnId) return IGNORED;
      state.turnId = null;
      state.userInputs = 0;
      return { status: 'ok', events: [{ t: 'turn_end', at, interrupted: p.type !== 'task_complete' }] };
    }
    return IGNORED;
  }

  // response_item
  const key = typeof p.id === 'string' ? p.id : undefined;
  if (p.type === 'message') {
    if (!Array.isArray(p.content)) return UNKNOWN;
    if (p.role === 'user') {
      const texts = textBlocks(p.content, 'input_text')
        .filter((t) => !SKIP_USER_PREFIXES.some((pre) => t.startsWith(pre)));
      if (texts.length === 0) return IGNORED;
      const form = state.userInputs > 0 ? 'queued_command' : 'user';
      state.userInputs += 1;
      const text = texts[0];
      return { status: 'ok', events: [{ t: 'input', form, head: text.slice(0, INPUT_HEAD_CHARS), ctx: parseInputCtx(text), at, key }] };
    }
    if (p.role === 'assistant') {
      const phase = p.channel ?? p.phase;
      if (phase !== 'commentary') return IGNORED;   // final answers are the reply itself
      const events = textBlocks(p.content, 'output_text')
        .filter((t) => t.trim())
        .map((text) => ({ t: 'commentary', text, at, key }));
      return { status: events.length ? 'ok' : 'ignored', events };
    }
    return IGNORED;
  }

  if (TOOL_CALL_TYPES.has(p.type)) {
    const callId = p.call_id ?? p.id;
    if (typeof callId !== 'string') return UNKNOWN;
    const name = typeof p.name === 'string' ? p.name : (p.type === 'function_call' || p.type === 'custom_tool_call' ? null : p.type);
    if (!name) return UNKNOWN;
    const input = parseMaybeJson(p.arguments ?? p.input ?? p.action);
    const events = [{ t: 'tool_start', callId, name, input, at }];
    // A web search is one record with no separate output record.
    if (p.type === 'web_search_call') events.push({ t: 'tool_end', callId, isError: p.status === 'failed', at });
    return { status: 'ok', events };
  }

  if (TOOL_OUTPUT_TYPES.has(p.type)) {
    if (typeof p.call_id !== 'string') return UNKNOWN;
    const code = exitCodeOf(p.output);
    return { status: 'ok', events: [{ t: 'tool_end', callId: p.call_id, isError: code != null && code !== 0, at }] };
  }

  if (IGNORED_ITEM_TYPES.has(p.type)) return IGNORED;
  return UNKNOWN;
}
