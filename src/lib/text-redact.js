/**
 * Text redaction for content that leaves the machine as display text — the
 * scheduled-task inventory (task-inventory.js) uploads task names, prompts,
 * cron commands, delivery-target names and error texts to Workspace.
 *
 * Pure functions, no I/O. The rules keep the text readable: a match is
 * replaced by a short placeholder, not removed.
 *
 *   home paths        /home/<user>/…, /Users/<user>/…, /root/…, $HOME  → ~/…
 *   secrets           Bearer/Basic credentials, JWTs, URL user:password@,
 *                     sk-/ghp_/github_pat_/glpat-/xox?-/AKIA/AIza/zylos_ak_
 *                     style tokens, PEM private keys, `key=value` / `key: value`
 *                     / `--flag value` with a secret-ish key, long hex and long
 *                     mixed-case random strings                         → [secret]
 *   ids               Lark/Feishu oc_/ou_/on_/om_/omt_/ot_/cli_ ids, WeCom
 *                     wm/wo/wr ids, DingTalk cid… ids, UUIDs, numeric ids of
 *                     9+ digits (Telegram/Discord/phone/timestamps)     → [id]
 *
 * Order matters: home paths first (they contain no secrets), then secrets
 * (a token that happens to look like an id is reported as a secret), then ids.
 *
 * `truncateChars` counts Unicode code points, like the Workspace contract;
 * callers redact first and truncate after.
 */

import os from 'os';

export const SECRET = '[secret]';
export const ID = '[id]';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Characters that may precede an absolute path for it to count as one (start
// of text, whitespace, quotes, brackets, `=`, `:`, `,`). A `/home/` inside a
// URL path (`example.com/home/x`) is preceded by a word character and stays.
const PATH_LEAD = String.raw`(^|[\s"'\`(\[{=:,;>])`;

function redactHomePaths(text, home) {
  let out = text;
  if (home && home.length > 1 && home !== '/') {
    const re = new RegExp(`${PATH_LEAD}${escapeRe(home.replace(/\/+$/, ''))}(?=/|$|[^\\w.-])`, 'gm');
    out = out.replace(re, '$1~');
  }
  out = out.replace(new RegExp(`${PATH_LEAD}/(?:home|Users)/[^/\\s"'\`]+(?=/|$|[^\\w.-])`, 'gm'), '$1~');
  out = out.replace(new RegExp(`${PATH_LEAD}/root(?=/|$|[^\\w.-])`, 'gm'), '$1~');
  return out;
}

// Secret-ish key names for `key=value`, `key: value` and JSON `"key": "value"`.
// A plural `…tokens` key (max_tokens, input_tokens) is a count, not a token.
// Prefix and suffix are bounded so a long run of word characters cannot make
// the match quadratic.
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]{0,40}?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|authorization|auth[_-]?token|session[_-]?(?:id|key|token)|signature)[A-Za-z0-9_-]{0,40}`;
const KEY_VALUE_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_.-])(["']?)(${SECRET_KEY})(["']?[ \t]*[:=：][ \t]*)`
  + String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|(\[(?:secret|id)\]|[^\s"'&,;)}\]]+))`,
  'gmi',
);
// The same in Chinese: 密码：… / 令牌=…
const ZH_KEY_VALUE_RE = /(密码|口令|令牌|密钥|秘钥|私钥)([ \t]*[:：=][ \t]*)(["'“]?)([^\s"'”，,；;]+)/g;
const FLAG_RE = /(^|\s)(--?(?:token|access-token|auth-token|password|passwd|secret|client-secret|api-key|apikey|key)(?:[ \t]+|=))(["']?)([^\s"']+)/gmi;

const PLACEHOLDER_RE = /^\[(?:secret|id)\]$/;

const SECRET_PATTERNS = [
  // PEM private key blocks.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // JWT (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // Vendor token formats.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bzylos_(?:ak|st)_[A-Za-z0-9_-]{8,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
];

function redactSecrets(text) {
  let out = text;
  // URL credentials: scheme://user:password@host → scheme://[secret]@host
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${SECRET}@`);
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${SECRET}`);
  out = out.replace(/\b(Basic)\s+[A-Za-z0-9+/=]{12,}/g, `$1 ${SECRET}`);
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET);
  out = out.replace(KEY_VALUE_RE, (m, lead, q1, key, sep, dq, sq, bare) => {
    if (/tokens$/i.test(key)) return m;
    const value = dq ?? sq ?? bare;
    // A reference to a variable is not the secret itself; keep it readable.
    // An auth scheme was handled above (`Authorization: Bearer [secret]`).
    if (!value || PLACEHOLDER_RE.test(value) || /^\$/.test(value) || /^(?:Bearer|Basic)$/i.test(value)) return m;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${lead}${q1}${key}${sep}${quote}${SECRET}${quote}`;
  });
  out = out.replace(ZH_KEY_VALUE_RE, (m, key, sep, q, value) => (
    PLACEHOLDER_RE.test(value) ? m : `${key}${sep}${q}${SECRET}`));
  out = out.replace(FLAG_RE, (m, lead, flag, q, value) => (
    PLACEHOLDER_RE.test(value) || /^\$/.test(value) ? m : `${lead}${flag}${q}${SECRET}`));
  // Long hex strings (API keys, signing secrets, hashes).
  out = out.replace(/\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{32,}\b/g, SECRET);
  // Long random-looking strings: 32+ chars mixing upper, lower and digits.
  out = out.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, SECRET);
  return out;
}

function redactIds(text) {
  let out = text;
  out = out.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, ID);
  // Lark / Feishu: chat (oc_), user (ou_, on_), message (om_), thread (omt_),
  // tenant (ot_), app (cli_). The id part has a digit, so words like
  // `on_success` stay.
  out = out.replace(/\b(?:oc|ou|on|om|omt|ot|cli)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\b/g, ID);
  // WeCom external user (wm/wo) and group chat (wr) ids.
  out = out.replace(/\bw[mor](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, ID);
  // DingTalk conversation ids.
  out = out.replace(/\bcid(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/=]{12,}/g, ID);
  // Long numeric ids: Telegram/Discord chat and user ids, message ids,
  // phone numbers. Not part of a word or a decimal number.
  out = out.replace(/(?<![\w.])-?\d{9,}(?!\w)/g, ID);
  return out;
}

/**
 * Redact one text. null / undefined pass through as null.
 * @param {*} input
 * @param {{home?: string}} [opts] home directory to fold into `~` (default: this user's)
 * @returns {string|null}
 */
export function redactText(input, { home = os.homedir() } = {}) {
  if (input === null || input === undefined) return null;
  let out = String(input);
  out = redactHomePaths(out, home);
  out = redactSecrets(out);
  out = redactIds(out);
  return out;
}

/**
 * Cut `text` to at most `max` Unicode code points, ending in `…` when cut.
 * A placeholder cut in half (`[secr…`) is dropped rather than left dangling.
 */
export function truncateChars(text, max) {
  if (text === null || text === undefined) return null;
  const chars = Array.from(String(text));
  if (chars.length <= max) return String(text);
  if (max <= 0) return '';
  let head = chars.slice(0, max - 1).join('');
  head = head.replace(/\[(?:s|se|sec|secr|secre|secret|i|id)$/, '');
  return `${head}…`;
}

/** Redact, then truncate to `max` code points. */
export function redactTruncate(input, max, opts) {
  const redacted = redactText(input, opts);
  return redacted === null ? null : truncateChars(redacted, max);
}

/**
 * The first sentence of a text, for a one-line preview: the first non-empty
 * line (leading Markdown heading / quote / list marks dropped), cut after the
 * first `。！？` or after `.!?` followed by whitespace. Not truncated.
 */
export function firstSentence(text) {
  if (text === null || text === undefined) return null;
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const clean = line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)+/, '').trim() || line;
  const m = /^.*?(?:[。！？]|[.!?](?=\s|$))/u.exec(clean);
  return (m ? m[0] : clean).trim();
}
