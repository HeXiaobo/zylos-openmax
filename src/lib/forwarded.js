/**
 * Merged forwards (inbound rendering).
 *
 * A merged forward is a message of type `chat_history` whose content body is
 * `cws.chat_history.v1` ({ record_count, records[], ... }). The list path only
 * has the trimmed `chat_history_preview` (`cws.chat_history.preview.v1`), and
 * every message has the server-built `fallback_text`. They are read with the
 * same lenient rules as quote-excerpt.js: anything with an unexpected shape
 * falls to the next, smaller representation (body → preview → fallback text),
 * and with none left the message renders as an ordinary one.
 *
 * It renders as the message text, in zylos-lark's merge_forward shape
 * (fetchMergeForwardContent): a header, then one "<sender>: <text>" line per
 * record, already flat:
 *
 *   carol (m-carol) said: [Forwarded conversation]
 *   alice: 看下这个图
 *   bob: [image: a.png]
 *
 * `<` and `>` in it are escaped like any message text, so nothing in it can
 * close </current-message>. A line break inside a record continues on a line
 * indented by two spaces (see INDENT), so a record cannot fake another one. In context lines (group history, the message
 * being replied to) a merged forward is the header alone, as lark shows a
 * quoted merge_forward as one line.
 *
 * A one-by-one forwarded copy (metadata `forwarded_from`) is the forwarder's
 * own words and renders as an ordinary message, so nothing here reads it; a
 * record that was such a copy is likewise said by the record's sender.
 */

export const MAX_RECORDS = 100;
export const MAX_RECORD_TEXT_CODE_POINTS = 1000;
// The whole C4 envelope reaches c4-receive as ONE argv element, which Linux
// caps at MAX_ARG_STRLEN (131072 bytes, terminating NUL included); over it the
// spawn fails with E2BIG and the message is lost. A full chat history is up to
// ~300 KB rendered, so its text gets at most 64 KiB and no more than the
// rest of the envelope leaves free (see chatHistoryBudget). Records past the
// budget are not rendered and one plain line says how many; when not even
// the header and that line fit, the fixed CHAT_HISTORY_TOO_LONG text
// replaces it.
export const C4_ARG_MAX_BYTES = 131072;
export const MAX_FORWARDED_BLOCK_BYTES = 64 * 1024;
// Kept free for what the bridge adds after formatting: the 20-byte [OM-RUN …]
// marker and the argv string's NUL, with room to spare.
export const ENVELOPE_MARGIN_BYTES = 1024;
// Server-written names are short (<= 128 code points); the cap only keeps an
// odd value from crowding out the records.
export const MAX_NAME_CODE_POINTS = 300;

const CHAT_HISTORY_SCHEMA = 'cws.chat_history.v1';
const CHAT_HISTORY_PREVIEW_SCHEMA = 'cws.chat_history.preview.v1';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

function readRecord(r) {
  if (!isObject(r)) return null;
  const chars = [...(typeof r.text === 'string' ? r.text : '')];
  const truncated = chars.length > MAX_RECORD_TEXT_CODE_POINTS || r.text_truncated === true;
  return {
    senderId: str(r.sender_id),
    senderName: str(r.sender_name),
    type: str(r.type) || 'text',
    text: chars.slice(0, MAX_RECORD_TEXT_CODE_POINTS).join(''),
    truncated,
    fileNames: (Array.isArray(r.attachments) ? r.attachments : [])
      .filter(isObject)
      .map((a) => str(a.file_name)),
  };
}

function readHistory(h, schema) {
  if (!isObject(h) || h.schema !== schema || !Array.isArray(h.records)) return null;
  const records = h.records.slice(0, MAX_RECORDS).map(readRecord).filter(Boolean);
  const n = h.record_count;
  return {
    recordCount: Number.isInteger(n) && n >= records.length ? n : records.length,
    records,
  };
}

// Lark's merge_forward header, used as-is.
export const FORWARDED_CONVERSATION = '[Forwarded conversation]';

export function isChatHistory(msg) {
  return isObject(msg) && String(msg.type || msg.message?.type || '').toLowerCase() === 'chat_history';
}

/**
 * A merged forward, read from the richest representation present: the full
 * body (get-message), else the list-path preview, else the fallback text.
 *
 * @returns {null | { recordCount, records } | { text }}
 */
export function chatHistoryOf(msg) {
  if (!isChatHistory(msg)) return null;

  const full = readHistory(isObject(msg.content) ? msg.content.body : undefined, CHAT_HISTORY_SCHEMA);
  if (full) return full;
  const preview = readHistory(msg.message?.chat_history_preview ?? msg.chat_history_preview, CHAT_HISTORY_PREVIEW_SCHEMA);
  if (preview) return preview;
  const text = str(msg.message?.fallback_text) || str(msg.fallback_text)
    || str(msg.message?.content) || str(msg.content);
  return text ? { text } : null;
}

// Same rule as escapeXml in message.js: only `<` / `>` can break the framing.
function escapeText(s) {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Every line break a reader may honour: CR, LF, CRLF, VT, FF, NEL, U+2028, U+2029.
const LINE_BREAKS = /(?:\r\n|[\r\n\v\f\u0085\u2028\u2029])+/g;
const ONE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g;
// Only the header, a record's own "<name>: " start and the "more" line begin at
// column 0. Text from the message (a record body past its first line, every
// fallback_text line) is indented two spaces, so it can never start a line
// that reads as another record. Indenting rather than joining keeps multi-line
// text (lists, code) readable; the spaces are in the string before its bytes
// are counted, so the budget includes them.
const INDENT = '  ';
export const indentBreaks = (s) => s.replace(ONE_BREAK, `\n${INDENT}`);

// A name sits at the start of its line: no line breaks, capped length.
function nameOf(v) {
  const chars = [...String(v).replace(LINE_BREAKS, ' ')];
  const s = chars.length > MAX_NAME_CODE_POINTS ? `${chars.slice(0, MAX_NAME_CODE_POINTS).join('')}…` : chars.join('');
  return escapeText(s);
}

// The short placeholders the bridge uses for media elsewhere ([image: a.png]).
// No artifact ids: comm.get_message returns them when a file is really needed.
const MEDIA_KIND = { image: 'image', file: 'file', audio: 'audio', video: 'video' };

function recordBody(r) {
  // A nested chat history is a placeholder only: its records are never copied.
  // Lark: "[nested merge_forward message]"; same words as our own header.
  if (r.type === 'chat_history') return '[nested forwarded conversation]';
  const kind = MEDIA_KIND[r.type] || (r.fileNames.length ? 'file' : '');
  const media = !kind ? []
    : r.fileNames.length ? r.fileNames.map((n) => (n ? `[${kind}: ${n}]` : `[${kind}]`))
      : [`[${kind}]`];
  const text = r.truncated ? `${r.text}…` : r.text;
  return [...media, text].filter(Boolean).join(' ');
}

function recordLine(r) {
  return `${nameOf(r.senderName || r.senderId || 'unknown')}: ${indentBreaks(escapeText(recordBody(r)))}`;
}

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

// Longest prefix of `s` whose escaped form fits in `budget` bytes.
function escapedPrefix(s, budget) {
  const out = [];
  let used = 0;
  for (const ch of s) {
    const e = escapeText(ch);
    const n = byteLength(e);
    if (used + n > budget) return { text: out.join(''), truncated: true };
    out.push(e);
    used += n;
  }
  return { text: out.join(''), truncated: false };
}

const moreLine = (n) => `（后面还有 ${n} 条未显示，用 comm.get_message 取全文）`;
const MORE_TEXT_LINE = '（后面还有内容未显示，用 comm.get_message 取全文）';

// Nothing from the message, so its size is fixed.
export const CHAT_HISTORY_TOO_LONG = `${FORWARDED_CONVERSATION}\n（转发的会话记录太长，未显示，用 comm.get_message 取全文）`;

/**
 * Bytes the merged-forward text may take when everything else in the
 * envelope already takes `restBytes`.
 */
export function chatHistoryBudget(restBytes) {
  return Math.min(MAX_FORWARDED_BLOCK_BYTES, C4_ARG_MAX_BYTES - 1 - ENVELOPE_MARGIN_BYTES - restBytes);
}

/**
 * Merged forward as message text: the header, then one line per record,
 * within `budget` bytes whenever the budget holds the header and the "more"
 * line; below that CHAT_HISTORY_TOO_LONG.
 */
export function formatForwardedChatHistory(history, budget = MAX_FORWARDED_BLOCK_BYTES) {
  if (!history) return '';
  const limit = Math.min(MAX_FORWARDED_BLOCK_BYTES, budget);
  const head = `${FORWARDED_CONVERSATION}\n`;
  if (!history.records) {
    const tail = `…\n${MORE_TEXT_LINE}`;
    const room = limit - byteLength(head) - byteLength(tail);
    const { text, truncated } = escapedPrefix(INDENT + indentBreaks(history.text), Math.max(0, room));
    return fitOrNotice(`${head}${truncated ? `${text}${tail}` : text}`, limit);
  }
  let room = limit - byteLength(FORWARDED_CONVERSATION) - byteLength(`\n${moreLine(history.recordCount)}`);
  const lines = [FORWARDED_CONVERSATION];
  for (const r of history.records) {
    const line = recordLine(r);
    const n = byteLength(line) + 1;
    if (n > room) break;
    lines.push(line);
    room -= n;
  }
  const more = history.recordCount - (lines.length - 1);
  if (more > 0) lines.push(moreLine(more));
  return fitOrNotice(lines.join('\n'), limit);
}

function fitOrNotice(text, limit) {
  return byteLength(text) <= limit ? text : CHAT_HISTORY_TOO_LONG;
}
