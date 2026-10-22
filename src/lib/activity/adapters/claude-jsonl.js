/**
 * Claude Code session log (JSONL) → normalised activity inputs.
 *
 * One JSON record per line. Only the paths listed in the detailed design are
 * read; anything else is ignored. A record whose discriminator matches a
 * producing shape but whose value path is missing or mistyped is reported as
 * `unknown` (fail closed — the caller drops it and degrades the affected run
 * to status-only instead of guessing the structure).
 *
 * Output (ActivityInput):
 *   { t:'input', form, head, ctx, segments, at, key }   form: user|enqueue|dequeue|absorbed|queued_command
 *                                         segments: [{head, ctx}] per C4 message (merged input)
 *   { t:'commentary', text, at, key }
 *   { t:'tool_start', callId, name, input, at }   input is for classify() only
 *   { t:'tool_end', callId, isError, at, result }   result {text, meta} for tool-detail.js only:
 *                                                     summarized there, never stored raw
 *   { t:'turn_end', at }
 */

import { INPUT_HEAD_CHARS } from '../constants.js';
import { parseInputCtx, splitInputSegments } from '../marker.js';

const IGNORED_BLOCKS = new Set(['thinking', 'redacted_thinking']);

function makeInput(form, content, at, key) {
  const text = typeof content === 'string' ? content : '';
  // segments: the C4 messages a merged input carries (one for a plain input).
  return { t: 'input', form, head: text.slice(0, INPUT_HEAD_CHARS), ctx: parseInputCtx(text), segments: splitInputSegments(text), at, key };
}

/** Text of a tool_result content (a string, or the text blocks of an array). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

const IGNORED = Object.freeze({ status: 'ignored', events: [] });
const FILTERED = Object.freeze({ status: 'filtered', events: [] });
const UNKNOWN = Object.freeze({ status: 'unknown', events: [] });

/**
 * @param {object} rec        one parsed JSONL record
 * @param {{ sessionId?: string }} [opts]  the log file's session id (file name)
 * @returns {{ status: 'ok'|'ignored'|'filtered'|'unknown', events: object[] }}
 */
export function parseClaudeRecord(rec, { sessionId } = {}) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return UNKNOWN;
  const type = rec.type;
  if (!['user', 'assistant', 'system', 'queue-operation', 'attachment'].includes(type)) return IGNORED;
  if (rec.isSidechain === true) return FILTERED;
  if (sessionId && rec.sessionId && rec.sessionId !== sessionId) return FILTERED;

  const at = Date.parse(rec.timestamp);
  if (!Number.isFinite(at)) return UNKNOWN;
  const key = typeof rec.uuid === 'string' ? rec.uuid : undefined;

  switch (type) {
    case 'user': {
      if (rec.isMeta === true) return IGNORED;
      const content = rec.message?.content;
      if (typeof content === 'string') return { status: 'ok', events: [makeInput('user', content, at, key)] };
      if (!Array.isArray(content)) return UNKNOWN;
      const results = content.filter((b) => b?.type === 'tool_result');
      if (results.length > 0) {
        const events = [];
        // `toolUseResult` (structured result: Bash stdout / stderr, Write / Edit
        // structuredPatch, WebSearch results, WebFetch url / code …) belongs to
        // the record's single tool_result; with several it is not attributed.
        const meta = results.length === 1 && rec.toolUseResult && typeof rec.toolUseResult === 'object'
          && !Array.isArray(rec.toolUseResult) ? rec.toolUseResult : undefined;
        for (const b of results) {
          if (typeof b.tool_use_id !== 'string') return UNKNOWN;
          const result = { text: resultText(b.content) };
          if (meta) result.meta = meta;
          events.push({ t: 'tool_end', callId: b.tool_use_id, isError: b.is_error === true, at, result });
        }
        return { status: 'ok', events };
      }
      const firstText = content.find((b) => b?.type === 'text');
      if (!firstText) return IGNORED;            // e.g. an image-only prompt: nothing to anchor on
      if (typeof firstText.text !== 'string') return UNKNOWN;
      return { status: 'ok', events: [makeInput('user', firstText.text, at, key)] };
    }

    case 'assistant': {
      const content = rec.message?.content;
      if (!Array.isArray(content)) return UNKNOWN;
      const events = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') return UNKNOWN;
        if (b.type === 'text') {
          if (typeof b.text !== 'string') return UNKNOWN;
          if (b.text.trim()) events.push({ t: 'commentary', text: b.text, at, key });
        } else if (b.type === 'tool_use') {
          if (typeof b.id !== 'string' || typeof b.name !== 'string') return UNKNOWN;
          events.push({ t: 'tool_start', callId: b.id, name: b.name, input: b.input, at });
        } else if (!IGNORED_BLOCKS.has(b.type)) {
          return UNKNOWN;
        }
      }
      return { status: events.length ? 'ok' : 'ignored', events };
    }

    case 'system':
      if (rec.subtype === 'turn_duration') return { status: 'ok', events: [{ t: 'turn_end', at }] };
      return IGNORED;

    case 'queue-operation': {
      const op = rec.operation;
      if (op === 'enqueue') {
        if (typeof rec.content !== 'string') return UNKNOWN;
        return { status: 'ok', events: [makeInput('enqueue', rec.content, at, key)] };
      }
      if (op === 'dequeue') return { status: 'ok', events: [makeInput('dequeue', '', at, key)] };
      if (op === 'remove' && rec.reason === 'absorbed_mid_turn') {
        if (typeof rec.content !== 'string') return UNKNOWN;
        return { status: 'ok', events: [makeInput('absorbed', rec.content, at, key)] };
      }
      return IGNORED;
    }

    case 'attachment': {
      const a = rec.attachment;
      if (!a || typeof a !== 'object') return UNKNOWN;
      if (a.type !== 'queued_command' || a.commandMode !== 'prompt') return IGNORED;
      if (typeof a.prompt !== 'string') return UNKNOWN;
      return { status: 'ok', events: [makeInput('queued_command', a.prompt, at, key)] };
    }

    default:
      return IGNORED;
  }
}
