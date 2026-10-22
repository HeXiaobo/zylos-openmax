/**
 * [OM-RUN …] marker: ties a runtime input back to the openmax run it belongs to.
 *
 * comm-bridge prefixes every C4 message that has a registered run with
 * `[OM-RUN r_xxxxxxxx] ` (20 chars, trailing space included). The collector
 * later sees that text again as a runtime log input and has to decide whether
 * the input really is that run's message. There is no attacker model (every
 * other channel is used by the owner), so the checks guard against
 * misattribution only:
 *
 *   1. anchor  — the marker is recognised at the start of a message only:
 *                character 0 of the input, or (merged input, see
 *                splitInputSegments) right after the previous message's C4
 *                `reply via` line — never in the middle of a message body;
 *   2. run     — the run id is a live (not closed) run on this host;
 *   3. tag     — the marker is followed by the openmax envelope tag;
 *   4. reply   — the last C4 `reply via` line names channel "openmax" and an
 *                endpoint equal (after normalisation) to the run's endpoint;
 *   5. context — when available, the <message-context conversation-id> (inline,
 *                or from the C4 spill file) matches the run's conversation.
 *
 * Any failed check means "no marker": the input is treated as foreign.
 */

import crypto from 'crypto';
import { RUN_ID_RE, INPUT_HEAD_CHARS } from './constants.js';

const MARKER_RE = /^\[OM-RUN (r_[0-9a-f]{8})\] /;
export const MARKER_LENGTH = 20;
const OPENMAX_TAGS = ['[OPENMAX DM]', '[OPENMAX GROUP:', '[OPENMAX THREAD'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Segments that vary per message rather than naming the conversation scope.
const VOLATILE_SEGMENTS = new Set(['reply', 'parent', 'msg', 'req']);

export function newRunId(exists = () => false) {
  for (let i = 0; i < 16; i++) {
    const id = `r_${crypto.randomBytes(4).toString('hex')}`;
    if (!exists(id)) return id;
  }
  throw new Error('newRunId: could not find a free run id');
}

export function formatMarker(runId) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`formatMarker: invalid run id ${runId}`);
  return `[OM-RUN ${runId}] `;
}

/** Recognises the marker at character 0 only — no newline / prefix variants. */
export function parseMarker(head) {
  if (typeof head !== 'string') return null;
  const m = MARKER_RE.exec(head);
  return m ? { runId: m[1] } : null;
}

/** The text right after the marker must be the openmax envelope tag. */
export function startsWithOpenmaxTag(head) {
  if (typeof head !== 'string' || !parseMarker(head)) return false;
  const rest = head.slice(MARKER_LENGTH);
  return OPENMAX_TAGS.some((t) => rest.startsWith(t));
}

/**
 * Normalise a C4 endpoint so semantically equal endpoints compare equal:
 * trim segments, lowercase a uuid base id and segment keys, drop per-message
 * segments (reply / parent / msg / req), keep scope segments (thread / root /
 * type and any unknown key), sort the kept segments by key.
 */
export function normEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  let base = parts.shift();
  if (UUID_RE.test(base)) base = base.toLowerCase();
  const kept = [];
  for (const seg of parts) {
    const idx = seg.indexOf(':');
    const key = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
    const value = idx === -1 ? '' : seg.slice(idx + 1).trim();
    if (VOLATILE_SEGMENTS.has(key)) continue;
    kept.push([key, UUID_RE.test(value) ? value.toLowerCase() : value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [base, ...kept.map(([k, v]) => `${k}:${v}`)].join('|');
}

const MESSAGE_CONTEXT_RE = /<message-context conversation-id="([^"]*)"/;
const SPILL_RE = /\[C4\] ⚠️ TRUNCATED[^\n]*?message file: (\S*comm-bridge\/attachments\/conv-(\d+)\/message\.txt)/g;
const REPLY_VIA_RE = /---- reply via: node \S+ "([^"]+)" "([^"]+)"/g;

function lastMatch(re, text) {
  re.lastIndex = 0;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

/**
 * Pull the three structural values the marker checks need out of one input
 * body. Local use only — none of this ever leaves the host.
 */
export function parseInputCtx(content) {
  const text = typeof content === 'string' ? content : '';
  const ctx = {};
  const spill = lastMatch(SPILL_RE, text);
  if (spill) {
    ctx.spillPath = spill[1];
    ctx.spillConvId = spill[2];
  } else {
    const mc = MESSAGE_CONTEXT_RE.exec(text);
    if (mc) ctx.convAttr = mc[1];
  }
  const rv = lastMatch(REPLY_VIA_RE, text);
  if (rv) ctx.replyVia = { channel: rv[1], endpoint: rv[2] };
  return ctx;
}

/**
 * Split one runtime input into the C4 messages it carries.
 *
 * While the agent is busy the runtime queues incoming C4 messages and later
 * delivers several of them as ONE input (a user prompt, or a mid-turn
 * queued_command / absorbed prompt), concatenated in arrival order. C4 ends
 * every message with its `---- reply via: …` line, so a message boundary is
 * the end of such a line that is followed by the next message's `[…]`
 * envelope tag; whitespace the runtime may put between two messages is
 * dropped. A single message yields one segment (the whole text),
 * exactly as before.
 *
 * @returns {{ head: string, ctx: object }[]}  head: first INPUT_HEAD_CHARS of
 *   the segment (marker anchor), ctx: parseInputCtx of the segment alone (its
 *   own reply-via / spill file / message-context).
 */
const NEXT_MESSAGE_RE = /^\s*\[/;

export function splitInputSegments(content) {
  const text = typeof content === 'string' ? content : '';
  const cuts = [];
  REPLY_VIA_RE.lastIndex = 0;
  let m;
  while ((m = REPLY_VIA_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    // A boundary only where the next C4 message envelope (`[…`) begins: a
    // reply-via-looking line inside a body does not split the message.
    if (NEXT_MESSAGE_RE.test(text.slice(end, end + 64))) cuts.push(end);
  }
  const pieces = [];
  let from = 0;
  for (const end of cuts) {
    pieces.push(text.slice(from, end));
    from = end;
  }
  const rest = text.slice(from);
  if (pieces.length === 0 || rest.trim()) pieces.push(rest);
  return pieces.map((piece, i) => {
    // Only a later message may start after separator whitespace; the first
    // keeps the strict character-0 anchor.
    const seg = i === 0 ? piece : piece.replace(/^\s+/, '');
    return { head: seg.slice(0, INPUT_HEAD_CHARS), ctx: parseInputCtx(seg) };
  });
}

/** Message-context conversation id from the first bytes of a spill file. */
export function messageContextFromSpillHead(head) {
  const mc = MESSAGE_CONTEXT_RE.exec(String(head ?? ''));
  return mc ? mc[1] : null;
}

/**
 * Decide whether one input belongs to a run.
 *
 * @param {{head: string, ctx: object}} input
 * @param {{getRun: (id: string) => object|undefined,
 *          readSpillHead?: (path: string) => string|null}} deps
 * @returns {{ run: object|null, reason: string|null }}  reason is null when the
 *   input simply carries no marker, otherwise the rejection reason
 *   (run | tag | endpoint | endpoint_after_anchor_ok | context).
 */
export function resolveMarkedRun(input, { getRun, readSpillHead } = {}) {
  const mk = parseMarker(input?.head);
  if (!mk) return { run: null, reason: null };
  const run = getRun?.(mk.runId);
  if (!run || run.state === 'closed') return { run: null, reason: 'run' };
  if (!startsWithOpenmaxTag(input.head)) return { run: null, reason: 'tag' };

  const ctx = input.ctx || {};
  const rv = ctx.replyVia;
  // No genuine openmax reply-via line although anchor, run and tag all passed:
  // almost always C4 skipped its own suffix because the body already held a
  // line that looks like one (hasLegacyReplyViaSuffix). Reported separately.
  if (!rv || rv.channel !== 'openmax') return { run: null, reason: 'endpoint_after_anchor_ok' };
  if (normEndpoint(rv.endpoint) !== normEndpoint(run.endpoint)) return { run: null, reason: 'endpoint' };

  // Extra checks — only ever reject, and only when the value is available.
  if (ctx.spillConvId) {
    if (run.c4_id != null && String(run.c4_id) !== String(ctx.spillConvId)) {
      return { run: null, reason: 'context' };
    }
    const head = ctx.spillPath && readSpillHead ? readSpillHead(ctx.spillPath) : null;
    const conv = head ? messageContextFromSpillHead(head) : null;
    if (conv && run.context_conversation_id && conv !== run.context_conversation_id) {
      return { run: null, reason: 'context' };
    }
  } else if (ctx.convAttr && run.context_conversation_id && ctx.convAttr !== run.context_conversation_id) {
    return { run: null, reason: 'context' };
  }
  return { run, reason: null };
}
