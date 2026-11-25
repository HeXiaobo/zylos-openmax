/**
 * Text redaction for content that leaves the machine as display text — the
 * scheduled-task inventory (task-inventory.js) uploads task names, prompts,
 * cron commands, delivery-target names and error texts to Workspace.
 *
 * Pure functions, no I/O. The rules keep the text readable: a match is
 * replaced by a short placeholder, not removed.
 *
 *   home paths        /home/<user>/…, /Users/<user>/…, /root/…, $HOME  → ~/…
 *   secrets           Authorization values (any scheme: `Authorization: Token
 *                     x` keeps `Token`), Bearer/Basic credentials, JWTs, URL
 *                     user:password@, `-u`/`--user` user:password, mysql-style
 *                     `-p<password>`, `redis-cli -a`, `sshpass -p`, webhook URL
 *                     tokens (Slack hooks, …/hook/…, …/webhooks/…), query
 *                     parameters such as `?key=` / `&sig=`, sk-/ghp_/
 *                     github_pat_/glpat-/xox?-/AKIA/AIza/zylos_ak_ style
 *                     tokens, PEM private keys, `key=value` / `key: value` /
 *                     `--flag value` with a secret-ish key (token, secret,
 *                     pass…, pw, pwd, api key, …), long hex and long
 *                     mixed-case random strings                         → [secret]
 *   ids               Lark/Feishu oc_/ou_/on_/om_/omt_/ot_/cli_ ids, WeCom
 *                     wm/wo/wr ids, DingTalk cid… ids, UUIDs, numeric ids of
 *                     9+ digits (Telegram/Discord/phone/timestamps)     → [id]
 *   email addresses   (not `git@host:` remotes)                         → [email]
 *   U+0000            removed (Workspace refuses it)
 *
 * Order matters: home paths first (they contain no secrets), then secrets
 * (a token that happens to look like an id is reported as a secret), then ids.
 *
 * Every pattern is linear in the input: a pattern that can start at many
 * places inside one run of characters is anchored to the start of the run
 * (lookbehind) and its lookaheads are bounded. `redactTruncate` also cuts its
 * input to the field limit plus a margin before redacting, so one huge prompt
 * or crontab line costs little on every tick.
 *
 * `truncateChars` counts Unicode code points, like the Workspace contract;
 * callers redact first and truncate after.
 */

import os from 'os';

export const SECRET = '[secret]';
export const ID = '[id]';
export const EMAIL = '[email]';

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
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]{0,40}?(?:token|secret|pass(?:w(?:or)?d|phrase)?|pwd|pw|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|authorization|auth[_-]?token|session[_-]?(?:id|key|token)|signature)[A-Za-z0-9_-]{0,40}`;
const KEY_VALUE_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_.-])(["']?)(${SECRET_KEY})(["']?[ \t]*[:=：][ \t]*)`
  + String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|(\[(?:secret|id)\]|[^\s"'&,;)}\]]+))`,
  'gmi',
);
// The same in Chinese: 密码：… / 令牌=…
const ZH_KEY_VALUE_RE = /(密码|口令|令牌|密钥|秘钥|私钥)([ \t]*[:：=][ \t]*)(["'“]?)([^\s"'”，,；;]+)/g;
const FLAG_RE = /(^|\s)(--?(?:token|access-token|auth-token|password|passwd|passphrase|pass|pw|secret|client-secret|api-key|apikey|key)(?:[ \t]+|=))(["']?)([^\s"']+)/gmi;
// `Authorization: <scheme> <value>` (also Proxy-Authorization, JSON / quoted
// forms): the scheme stays readable, the value goes. A bare value is left to
// KEY_VALUE_RE.
const AUTH_SCHEME_RE = /((?<![A-Za-z0-9_])authorization["']?[ \t]*[:=][ \t]*["']?)([A-Za-z][A-Za-z0-9_-]{0,30})([ \t]+)([^\s"',;]+)/gi;
// curl / wget / httpie style `-u user:password`, `--user=user:password`.
const USER_PASS_RE = /((?:^|\s)(?:-u|--(?:proxy-)?user(?=[ \t=]))(?:[ \t]+|=)?["']?[^\s:"']*:)([^\s"']+)/gm;
// Query parameters that carry a credential.
const QUERY_SECRET_RE = /([?&;](?:key|sig|sign|signature|token|auth|apikey|api_key|code|ticket|secret|password|pass|pwd|pw|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)([^&#\s"'<>]+)/gi;
// Webhook URLs whose path is the credential. A generic …/hook(s)/… or
// …/webhook(s)/… path counts when it has 16+ token characters with a digit
// (`.git/hooks/pre-commit-check` stays).
const SLACK_HOOK_RE = /\b(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/gi;
const PATH_HOOK_RE = /(\/(?:hook|hooks|webhook|webhooks)\/)(?=[A-Za-z0-9_/-]{0,64}\d)[A-Za-z0-9_/-]{16,}/gi;
// Shell segments: split on line ends and `|`, `;`, `&` so a command-specific
// flag is only read in its own command.
const SEGMENT_SPLIT_RE = /([\n|;&]+)/;
const MYSQL_CMD_RE = /(?<![\w-])(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlsh|mariadb|mariadb-dump|mariadb-admin)(?![\w-])/;
const MYSQL_GLUED_P_RE = /(\s-p)(?=\S)(["']?)([^\s"']+)/g; // -pSecret (`-p` alone prompts; `-P` is the port)
const REDIS_CMD_RE = /(?<![\w-])(?:redis-cli|valkey-cli|keydb-cli)(?![\w-])/;
const REDIS_A_RE = /(\s-a(?:[ \t]+|(?=\S)))(["']?)([^\s"']+)/g;
const SSHPASS_CMD_RE = /(?<![\w-])sshpass(?![\w-])/;
const SSHPASS_P_RE = /(\s-p[ \t]*)(["']?)([^\s"']+)/; // the first -p after sshpass only (a later `ssh -p 22` is a port)
// Values that are never a credential, for keys that only look secret-ish
// (`bypass_cache=true`).
const PLAIN_VALUE_RE = /^(?:true|false|yes|no|on|off|null|none|nil|undefined)$/i;

const PLACEHOLDER_RE = /^\[(?:secret|id|email)\]$/;

const SECRET_PATTERNS = [
  // PEM private key blocks.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // JWT (header.payload.signature); starts only at the start of a run.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
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

const keepValue = (value) => PLACEHOLDER_RE.test(value) || /^\$/.test(value);

// Command-specific password flags, read per shell segment.
function redactCommandFlags(text) {
  if (!MYSQL_CMD_RE.test(text) && !REDIS_CMD_RE.test(text) && !SSHPASS_CMD_RE.test(text)) return text;
  const flag = (m, lead, q, value) => (keepValue(value) ? m : `${lead}${q}${SECRET}`);
  return text.split(SEGMENT_SPLIT_RE).map((seg, i) => {
    if (i % 2 === 1) return seg; // a separator
    let out = seg;
    let m = MYSQL_CMD_RE.exec(out);
    if (m) out = out.slice(0, m.index) + out.slice(m.index).replace(MYSQL_GLUED_P_RE, flag);
    m = REDIS_CMD_RE.exec(out);
    if (m) out = out.slice(0, m.index) + out.slice(m.index).replace(REDIS_A_RE, flag);
    m = SSHPASS_CMD_RE.exec(out);
    if (m) out = out.slice(0, m.index) + out.slice(m.index).replace(SSHPASS_P_RE, flag);
    return out;
  }).join('');
}

function redactSecrets(text) {
  let out = text;
  // URL credentials: scheme://user:password@host → scheme://[secret]@host
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${SECRET}@`);
  out = out.replace(SLACK_HOOK_RE, `$1${SECRET}`);
  out = out.replace(PATH_HOOK_RE, `$1${SECRET}`);
  out = out.replace(QUERY_SECRET_RE, (m, key, value) => (keepValue(value) ? m : `${key}${SECRET}`));
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${SECRET}`);
  out = out.replace(/\b(Basic)\s+[A-Za-z0-9+/=]{12,}/g, `$1 ${SECRET}`);
  out = out.replace(AUTH_SCHEME_RE, (m, head, scheme, gap, value) => (
    keepValue(value) ? m : `${head}${scheme}${gap}${SECRET}`));
  out = out.replace(USER_PASS_RE, (m, head, value) => (keepValue(value) ? m : `${head}${SECRET}`));
  out = redactCommandFlags(out);
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET);
  out = out.replace(KEY_VALUE_RE, (m, lead, q1, key, sep, dq, sq, bare, offset, whole) => {
    if (/tokens$/i.test(key)) return m;
    const value = dq ?? sq ?? bare;
    // A reference to a variable is not the secret itself; keep it readable.
    if (!value || keepValue(value) || PLAIN_VALUE_RE.test(value)) return m;
    // A bare `pass:` / `pw:` is prose more often than a key ("Tests pass: 12/12").
    if (/^(?:pass|pw)$/i.test(key) && !sep.includes('=')) return m;
    // An auth scheme followed by its value: AUTH_SCHEME_RE handled the value
    // (`Authorization: Token [secret]`, `Authorization: Bearer $TOKEN`).
    if (bare !== undefined && /authorization$/i.test(key) && /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(bare)
      && /^[ \t]+[^\s"',;]/.test(whole.slice(offset + m.length, offset + m.length + 2))) return m;
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
  // WeCom external user (wm/wo) and group chat (wr) ids. Anchored to the
  // start of a run, lookahead bounded: `wm-wm-wm-…` stays linear.
  out = out.replace(/(?<![A-Za-z0-9_-])w[mor](?=[A-Za-z0-9_-]{0,64}\d)[A-Za-z0-9_-]{16,}\b/g, ID);
  // DingTalk conversation ids (base64; may follow a `/` in a URL path).
  out = out.replace(/(?<![A-Za-z0-9+=])cid(?=[A-Za-z0-9+/=]{0,64}\d)[A-Za-z0-9+/=]{12,}/g, ID);
  // Long numeric ids: Telegram/Discord chat and user ids, message ids,
  // phone numbers. Not part of a word or a decimal number.
  out = out.replace(/(?<![\w.])-?\d{9,}(?!\w)/g, ID);
  return out;
}

// Email addresses; a `git@host:repo` remote stays.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

/**
 * Redact one text. null / undefined pass through as null.
 * @param {*} input
 * @param {{home?: string}} [opts] home directory to fold into `~` (default: this user's)
 * @returns {string|null}
 */
export function redactText(input, { home = os.homedir() } = {}) {
  if (input === null || input === undefined) return null;
  let out = String(input).replace(/\u0000/g, '');
  out = redactHomePaths(out, home);
  out = redactSecrets(out);
  out = out.replace(EMAIL_RE, EMAIL); // before ids: `123456789@qq.com` is one address
  out = redactIds(out);
  return out;
}

/**
 * Cut `text` to at most `max` Unicode code points, ending in `…` when cut.
 * A placeholder cut in half (`[secr…`) is dropped rather than left dangling.
 */
export function truncateChars(text, max) {
  if (text === null || text === undefined) return null;
  const str = String(text).replace(/\u0000/g, '');
  const chars = Array.from(str);
  if (chars.length <= max) return str;
  if (max <= 0) return '';
  let head = chars.slice(0, max - 1).join('');
  head = head.replace(/\[(?:s|se|sec|secr|secre|secret|i|id|e|em|ema|emai|email)$/, '');
  return `${head}…`;
}

// Redaction margin past the field limit: placeholders are shorter than what
// they replace, so text a little past the limit can move into the field.
export const REDACT_MARGIN_CHARS = 1024;
// A partial word at the pre-cut is dropped when the cut falls inside one of
// at most this many characters (a cut-off token might no longer match).
const PRECUT_WORD_MAX = 512;

/**
 * Cut `text` to `max + REDACT_MARGIN_CHARS` code points before it is redacted,
 * dropping a partial last word.
 */
function precut(text, max) {
  const limit = max + REDACT_MARGIN_CHARS;
  if (text.length <= limit) return text; // UTF-16 length ≥ code points
  let i = 0;
  let n = 0;
  while (i < text.length && n < limit) {
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
    n += 1;
  }
  if (i >= text.length) return text;
  let cut = text.slice(0, i);
  if (/\S/.test(text[i])) {
    // Inside a word: back up to the last whitespace if it is close.
    const stop = Math.max(0, cut.length - PRECUT_WORD_MAX - 1);
    let j = cut.length;
    while (j > stop && !/\s/.test(cut[j - 1])) j -= 1;
    if (j > stop) cut = cut.slice(0, j);
  }
  return cut;
}

/** Redact, then truncate to `max` code points. The input is cut first (see `precut`). */
export function redactTruncate(input, max, opts) {
  if (input === null || input === undefined) return null;
  const redacted = redactText(precut(String(input), max), opts);
  return truncateChars(redacted, max);
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
