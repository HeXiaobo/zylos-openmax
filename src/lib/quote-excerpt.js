/**
 * Quoted excerpt (phase 1).
 *
 * When a user quotes part of a message, the web FE sends `parent_id` plus
 * message metadata
 *
 *   quote_excerpts: { version: 1, items: [{ message_id, text, offset?, truncated? }] }
 *
 * and when the quoted original is recalled, cws-comm rewrites the item into a
 * tombstone `{ message_id, recalled: true }`. `metadata` is an opaque
 * pass-through any client can write, so it is read with the same lenient
 * rules as the FE's `readQuoteExcerpt`: anything unexpected means "no excerpt"
 * and the inbound text stays exactly as for a plain reply. A verified excerpt
 * replaces the quoted text in <replying-to> (see verifiedExcerptText).
 */

import { formatStructuredForModel } from './structured-body.js';
import { agentContextItems } from './message-context.js';

export const MAX_EXCERPT_CODE_POINTS = 1000;

/**
 * The quoted message's full text: shown in <replying-to> and the text the
 * excerpt is checked against. A card has no `body.text` and the detail path
 * nulls `message.content`, so without the structured arm a card quotes only
 * as its `fallback_text` and an excerpt of any field is not found (so
 * <replying-to> falls back to the full text).
 * Same expansion as the forward path uses for a received card.
 */
export function quotedMessageText(q) {
  const qStructured = (q?.content && typeof q.content === 'object') ? q.content : {};
  return qStructured.body?.text
    || (typeof q?.message?.content === 'string' ? q.message.content : '')
    || formatStructuredForModel(q)
    || q?.message?.fallback_text
    || '';
}

/**
 * @returns {null | { kind: 'recalled' } | { kind: 'excerpt', text: string }}
 */
export function quoteExcerptFrom(msg, parentId) {
  if (!msg || typeof msg !== 'object' || parentId === undefined || parentId === null) return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => m && typeof m === 'object' && !Array.isArray(m) && 'quote_excerpts' in m);
  const qe = meta?.quote_excerpts;
  if (!qe || typeof qe !== 'object' || Array.isArray(qe)) return null;
  if (qe.version !== 1 || !Array.isArray(qe.items)) return null;

  // Phase 1 sends exactly one item; later items are a phase-2 extension.
  const item = qe.items[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.message_id !== 'string' || item.message_id !== String(parentId)) return null;
  // A tombstone may still carry a stale `text`; it must never be shown.
  if (item.recalled === true) return { kind: 'recalled' };
  if (typeof item.text !== 'string' || !item.text.trim()) return null;

  return { kind: 'excerpt', text: capExcerpt(item.text) };
}

function capExcerpt(text) {
  const chars = [...text];
  return chars.length > MAX_EXCERPT_CODE_POINTS ? chars.slice(0, MAX_EXCERPT_CODE_POINTS).join('') : text;
}

/**
 * The quoted excerpt of a reply, context first (OPENM-1351): the first `quote`
 * item of `metadata.context` (audience=agent) whose `attrs.message-id` is the
 * replied-to message — `attrs.recalled: true` is a tombstone, else
 * `data.text` is the excerpt — then the old `quote_excerpts` key. Same result
 * shape as quoteExcerptFrom, so <replying-to> is the same either way.
 *
 * @returns {null | { kind: 'recalled' } | { kind: 'excerpt', text: string }}
 */
export function quoteExcerptOf(msg, parentId) {
  if (parentId === undefined || parentId === null) return null;
  for (const item of agentContextItems(msg, 'quote')) {
    // A string id only, like the old key: cws-comm's recall cascade matches
    // string ids, so a numeric one would never be tombstoned.
    const id = item.attrs['message-id'];
    if (typeof id !== 'string' || id !== String(parentId)) continue;
    // A tombstone may still carry a stale text; it must never be shown.
    if (item.attrs.recalled === true) return { kind: 'recalled' };
    const text = item.data?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    return { kind: 'excerpt', text: capExcerpt(text) };
  }
  return quoteExcerptFrom(msg, parentId);
}

// The FE selects rendered text, so markdown syntax is reduced to what a reader
// sees before comparing. The excerpt side only drops marker characters: the
// rules that delete content (fence lines, link targets) run on the original
// alone, or they would hide arbitrary text inside a tampered excerpt.
function stripMarkers(s) {
  return String(s)
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')               // headings
    .replace(/^[ \t]*>[ \t]?/gm, '')                    // blockquotes
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')                // bullet markers
    .replace(/[*_`~]/g, '')                             // emphasis / inline code
    .replace(/\s+/g, ' ')
    .trim();
}

function renderedText(markdown) {
  return stripMarkers(String(markdown)
    .replace(/^[ \t]*(?:```|~~~).*$/gm, '')            // code fences
    .replace(/^[ \t]*(?:[-*_=][ \t]*){3,}$/gm, '')      // rules, setext underlines
    .replace(/^([ \t]*(?:>[ \t]?)*)\d+[.)][ \t]+/gm, '$1') // ordered markers (also inside blockquotes): digits are content in an excerpt
    // No `[` / `(` inside the classes: keeps it linear on input with many `[`.
    .replace(/!?\[([^[\]]*)\]\([^()]*\)/g, '$1'));      // links / images → text
}

/**
 * The excerpt text to show in <replying-to> in place of the quoted message's
 * full text, or null when there is none to show: no excerpt, a tombstone (the
 * quoted text was recalled), or an excerpt not found in `parentText`.
 *
 * The excerpt comes from the quoting client, not from the quoted message, yet
 * <replying-to> names the quoted author, so only an excerpt that appears in
 * the quoted text is shown; otherwise the full quoted text is shown instead.
 */
export function verifiedExcerptText(excerpt, parentText) {
  if (excerpt?.kind !== 'excerpt') return null;
  const needle = stripMarkers(excerpt.text);
  return needle !== '' && renderedText(parentText ?? '').includes(needle) ? excerpt.text : null;
}
