/**
 * `[MEDIA:file]` / `[MEDIA:image]` outbound messages (scripts/send.js), with
 * optional explicit mentions (OPENM-1039).
 *
 * Form (one file per message):
 *
 *   [MEDIA:file]/abs/path/报价单.pdf          ← line 1: the tag + the local path
 *   [MENTIONS]["<member id>", {"type":"all_agents"}]   ← optional, line 2 only
 *   @小B 请看报价单                              ← optional caption (rest of the message)
 *
 * `[MENTIONS]` takes inline JSON in exactly the `[STRUCTURED]` `mentions`
 * shape (member_id strings, `{type:"member", member_id}`, `{type:"all"}`,
 * `{type:"all_agents"}`), checked by the same validator (src/lib/send-body.js)
 * and, for a broadcast, the same can_mention_all gate. Mentions are explicit
 * only (2.35.0): the caption is plain text and `@name` in it mentions nobody.
 *
 * 🔴 A malformed message is an error, NEVER posted as text, and it fails
 * before the upload:
 *   - a `[MENTIONS]` line that is not valid (not JSON, not a non-empty array,
 *     a bad item, a member id that is not a UUID — e.g. a name such as "@小B"
 *     or "小B") → code MEDIA_MENTIONS_INVALID;
 *   - a line 2 that only nearly is the tag (`[mentions]`, `【MENTIONS】`,
 *     `[MENTION]` …: case, full-width brackets) — it would otherwise go out as
 *     caption text and wake nobody → MEDIA_MENTIONS_INVALID;
 *   - a `[MENTIONS]` line anywhere but right after the path line (it would
 *     otherwise go out as caption text and wake nobody) → MEDIA_MENTIONS_INVALID;
 *   - a `[MEDIA:…]` tag that starts a later line → MEDIA_NOT_FIRST;
 *   - a message that is not a `[MEDIA:…]` message (nor `[STRUCTURED]` /
 *     `[CARD]`) with ANY line whose first non-blank text is `[MENTIONS]`
 *     (outside fenced code) → MENTIONS_WITHOUT_MEDIA (text with mentions goes
 *     in `[STRUCTURED]`).
 *
 * "A tag that starts a line" (findMisplacedMediaTag): a line whose first
 * non-blank text is `[MEDIA:image]` or `[MEDIA:file]`, outside a fenced code
 * block (``` or ~~~, possibly indented; as in CommonMark, a ``` line whose
 * info string holds a backtick — "```x```" — opens no fence, and only a fence
 * of the same character and at least the opening length, with nothing after
 * it, closes it; an unclosed fence runs to the end).
 * The tag in the middle of a line, in inline code, or in a fence is text.
 */

import { validateMentions, normalizeMentions } from './send-body.js';

export const MEDIA_MENTIONS_PREFIX = '[MENTIONS]';

const MEDIA_TAG_RE = /^\[MEDIA:(image|file)\]/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const MENTIONS_LINE_RE = /^\[MENTIONS\]/;
// Line 2 that looks like the tag but is not exactly `[MENTIONS]`: another
// case, `[MENTION]`, full-width brackets (［ ］ / 【 】), inner spaces.
const MENTIONS_NEAR_MISS_RE = /^[[［【]\s*mentions?\s*[\]］】]/i;
// Member ids are UUIDs (cws-comm; the same shape src/cli/comm.js checks).
const MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRECT_FORM = '[MEDIA:file]/abs/path\n[MENTIONS]["<member id>"]\n<caption>';

export class MediaMessageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MediaMessageError';
    this.code = code;
  }
}

// The first line outside fenced code blocks whose first non-blank text
// matches `re` → {index, match}, or null.
function firstLineOutsideFences(text, re) {
  let fence = null;
  const lines = text.split(/\r?\n/); // CRLF input: a trailing \r would hide a fence
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    // CommonMark: a backtick fence's info string may not contain a backtick,
    // so "```x```" (inline code at a line start) opens no fence; a tilde
    // fence's info string may.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      // CommonMark: the closing fence is the same character, at least as long
      // as the opening one, with no info string (```` keeps ``` inside it).
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const m = re.exec(lines[i].trimStart());
    if (m) return { index: i, match: m };
  }
  return null;
}

/**
 * The first line (1-based) whose first non-blank
 * text is a `[MEDIA:image]` / `[MEDIA:file]` tag, outside fenced code blocks.
 * @returns {null|{line:number, kind:'image'|'file'}}
 */
export function findMisplacedMediaTag(text) {
  if (typeof text !== 'string' || !text.includes('[MEDIA:')) return null;
  const hit = firstLineOutsideFences(text, MEDIA_TAG_RE);
  return hit ? { line: hit.index + 1, kind: hit.match[1] } : null;
}

/** Refuse a message whose `[MEDIA:…]` tag is not at its start. */
export function assertNoMisplacedMediaTag(message) {
  const hit = findMisplacedMediaTag(message);
  if (!hit) return;
  throw new MediaMessageError(
    `[MEDIA] a [MEDIA:${hit.kind}] tag starts line ${hit.line}, but a file or image is sent only when the message `
    + 'STARTS with the tag. Nothing was sent (the text would have been posted with the local path and no file). '
    + `Send the file as its own message, tag first:\n${CORRECT_FORM}\n`
    + '(the [MENTIONS] line is optional; one file per message; send any other text as a separate message).',
    'MEDIA_NOT_FIRST',
  );
}

/**
 * Refuse a message that is no `[MEDIA:…]` message but has a line whose first
 * non-blank text is `[MENTIONS]` (any line, outside fenced code blocks): it
 * would be posted as text and mention nobody. Mentions for a text message go
 * in a `[STRUCTURED]` body. Call it only for a message that is not
 * `[STRUCTURED]`, `[CARD]` or `[MEDIA:…]` (scripts/send.js).
 */
export function assertNoMentionsWithoutMedia(message) {
  if (typeof message !== 'string' || !message.includes(MEDIA_MENTIONS_PREFIX)) return;
  const hit = firstLineOutsideFences(message, MENTIONS_LINE_RE);
  if (!hit) return;
  throw new MediaMessageError(
    `[MENTIONS] a [MENTIONS] line (line ${hit.index + 1}) is read only right after a [MEDIA:file] / [MEDIA:image] `
    + 'path line; this message is not a [MEDIA:…] message, so it would have been posted as text and mentioned '
    + 'nobody. Nothing was sent. For a text message '
    + 'with mentions send [STRUCTURED]{"content":"<text>","mentions":["<member id>"]}; for a file or image put '
    + `the [MENTIONS] line after the path:\n${CORRECT_FORM}`,
    'MENTIONS_WITHOUT_MEDIA',
  );
}

function mentionsError(why) {
  return new MediaMessageError(
    `[MEDIA] ${why}. Nothing was sent. The form is:\n${CORRECT_FORM}\n`
    + 'where [MENTIONS] (optional, right after the path line) is a JSON array of member ids '
    + '(from comm.member_list), {"type":"member","member_id":"…"}, {"type":"all"} or {"type":"all_agents"}.',
    'MEDIA_MENTIONS_INVALID',
  );
}

function parseMentionsLine(line) {
  const raw = line.trim().slice(MEDIA_MENTIONS_PREFIX.length).trim();
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw mentionsError(`[MENTIONS] is not valid JSON (${e.message})`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw mentionsError('[MENTIONS] must be a non-empty JSON array');
  }
  try {
    validateMentions(list, { verb: '[MENTIONS]', ErrorClass: Error });
  } catch (e) {
    throw mentionsError(e.message);
  }
  list.forEach((m, i) => {
    const id = typeof m === 'string' ? m : m.member_id;
    if (typeof id !== 'string') return;
    if (/^\s*@/.test(id) || /\s/.test(id.trim())) {
      throw mentionsError(`[MENTIONS] mentions[${i}] "${id}" looks like a name, not a member id — look the id up with comm.member_list`);
    }
    if (!MEMBER_ID_RE.test(id.trim())) {
      throw mentionsError(`[MENTIONS] mentions[${i}] "${id}" is not a member id (a UUID) — look the id up with comm.member_list`);
    }
  });
  return normalizeMentions(list);
}

/**
 * Recognize and validate a `[MEDIA:…]` message.
 * @returns {null|{kind:'image'|'file', localPath:string, caption?:string, mentions?:object[]}}
 *   null when the message does not start with a `[MEDIA:image]` / `[MEDIA:file]`
 *   tag (leading blank space allowed); `mentions` only when a `[MENTIONS]` line
 *   was given, already in the wire shape.
 * @throws {MediaMessageError} when it IS a media message and is malformed.
 */
export function parseMediaMessage(message) {
  const text = typeof message === 'string' ? message.trimStart() : '';
  const m = /^\[MEDIA:(image|file)\]([^\n]*)(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const kind = m[1];
  const localPath = m[2].trim();
  let rest = m[3] ?? '';
  let mentions;
  const [second, ...after] = rest.split('\n');
  if (second.trimStart().startsWith(MEDIA_MENTIONS_PREFIX)) {
    mentions = parseMentionsLine(second);
    rest = after.join('\n');
  } else if (MENTIONS_NEAR_MISS_RE.test(second.trimStart())) {
    throw mentionsError(`line 2 "${second.trim().slice(0, 40)}" looks like a [MENTIONS] line but is not exactly `
      + '[MENTIONS] (ASCII brackets, upper case)');
  }
  if (firstLineOutsideFences(rest, MENTIONS_LINE_RE)) {
    throw mentionsError('[MENTIONS] must be on the line right after the path line, once');
  }
  const hit = findMisplacedMediaTag(rest);
  if (hit) {
    throw new MediaMessageError(
      `[MEDIA] the caption has another [MEDIA:${hit.kind}] line: one file per message. Nothing was sent. `
      + `Send each file as its own message:\n${CORRECT_FORM}`,
      'MEDIA_NOT_FIRST',
    );
  }
  const caption = rest.trim();
  return {
    kind,
    localPath,
    caption: caption || undefined,
    ...(mentions ? { mentions } : {}),
  };
}
