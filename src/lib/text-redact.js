/**
 * Text redaction for content that leaves the machine as display text — the
 * scheduled-task inventory (task-inventory.js) uploads task names, prompts,
 * cron commands, delivery-target names and error texts to Workspace.
 *
 * Pure functions, no I/O. The rules keep the text readable: a match is
 * replaced by a short placeholder, not removed.
 *
 *   home paths        /home/<user>/…, /Users/<user>/…, /root/…, $HOME  → ~/…
 *   secrets           Authorization values (a known scheme stays: `Authorization:
 *                     Token x` keeps `Token`), Bearer/Basic credentials, JWTs,
 *                     URL user:password@, `-u`/`--user` user:password, mysql-style
 *                     `-p<password>`, `redis-cli -a`, `sshpass -p`, `docker|podman
 *                     … login -p`, `smbclient -U user%pass`, `lftp -u user,pass`,
 *                     `ldap… -w`, `zip -P`, `7z -p<pw>`, `openssl -k` / `pass:`,
 *                     `aws configure set <secret key> <value>`, webhook URL
 *                     tokens (Slack hooks, …/hook/…, …/webhooks/…), query
 *                     parameters such as `?key=` / `&sig=`, sk-/ghp_/
 *                     github_pat_/glpat-/xox?-/AKIA/AIza/zylos_ak_ style
 *                     tokens, PEM private keys, `key=value` / `key: value` /
 *                     `--flag value` with a secret-ish key (token, secret,
 *                     password, a key ending in pass / pw, api key, …; quoted
 *                     values with spaces go whole), long hex and long
 *                     mixed-case random strings                         → [secret]
 *   ids               Lark/Feishu oc_/ou_/on_/om_/omt_/ot_/cli_ ids, WeCom
 *                     wm/wo/wr ids, DingTalk cid… ids, UUIDs, numeric ids of
 *                     9+ digits (Telegram/Discord/phone/timestamps)     → [id]
 *   email addresses   (not `git@host:` remotes, not `user@host:path`)   → [email]
 *   U+0000            removed (Workspace refuses it)
 *
 * It is a heuristic: some credential shapes are not recognized ("the password
 * is hunter2"), and some harmless text is (a word after `Authorization:` that
 * looks like a credential, `--key <file>`).
 *
 * Order matters: home paths first (they contain no secrets), then secrets
 * (a token that happens to look like an id is reported as a secret), then ids.
 *
 * Every pattern is linear in the input: a pattern that can start at many
 * places inside one run of characters is anchored to the start of the run
 * (lookbehind) and its lookaheads are bounded. Every pattern but the PEM block
 * and Bearer/Basic stays inside one line, which `redactTruncate` relies on to
 * redact only the field limit plus a margin of a huge input (see there).
 *
 * `truncateChars` counts Unicode code points, like the Workspace contract;
 * callers redact first and truncate after.
 */

import os from 'os';
import { createHash } from 'crypto';

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

// A flag or key value: "double quoted" or 'single quoted' (spaces allowed; an
// unclosed quote runs to the end of the line), or bare. Three groups: the
// double-quoted, single-quoted and bare value. Patterns using it need the `m`
// flag.
const VALUE = String.raw`(?:"([^"\n]*)(?:"|$)|'([^'\n]*)(?:'|$)|([^\s"']+))`;

// Secret-ish key names for `key=value`, `key: value` and JSON `"key": "value"`.
// A plural `…tokens` key (max_tokens, input_tokens) is a count, not a token.
// `pass` / `pw` count only as the key's last part (DB_PASS, smtp.pw; not
// passed, compass, bypass_proxy, passport_no, pwm_duty). Prefix and suffix are
// bounded so a long run of word characters cannot make the match quadratic.
const SECRET_KEY = String.raw`(?:[A-Za-z0-9_.-]{0,40}?(?:token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|authorization|auth[_-]?token|session[_-]?(?:id|key|token)|signature)[A-Za-z0-9_-]{0,40}|(?:[A-Za-z0-9_.-]{0,40}[_.-])?(?:pass|pw))`;
const KEY_VALUE_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_.-])(["']?)(${SECRET_KEY})(["']?[ \t]*[:=：][ \t]*)`
  + String.raw`(?:"([^"\n]*)(?:"|$)|'([^'\n]*)(?:'|$)|(\[(?:secret|id)\]|[^\s"'&,;)}\]]+))`,
  'gmi',
);
// The same in Chinese: 密码：… / 令牌=…
const ZH_KEY_VALUE_RE = /(密码|口令|令牌|密钥|秘钥|私钥)([ \t]*[:：=][ \t]*)(["'“]?)([^\s"'”，,；;]+)/g;
const FLAG_RE = new RegExp(
  String.raw`((?:^|\s)--?(?:token|access-token|auth-token|password|passwd|passphrase|pass|pw|secret|client-secret|api-key|apikey|key)(?:[ \t]+|=))${VALUE}`,
  'gmi',
);
// `Authorization: <scheme> <value>` (also Proxy-Authorization, JSON / quoted
// forms): the scheme stays readable, the value goes when the scheme is a known
// one or the value looks like a credential ("authorization: required for all"
// is prose). A bare value is left to KEY_VALUE_RE.
const AUTH_SCHEME_RE = /((?<![A-Za-z0-9_])authorization["']?[ \t]*[:=][ \t]*["']?)([A-Za-z][A-Za-z0-9_-]{0,30})([ \t]+)([^\s"',;]+)/gi;
const AUTH_SCHEMES_RE = /^(?:bearer|basic|digest|token|negotiate|ntlm|oauth|apikey|api-key|key|sharedkey|sharedkeylite|dpop|mac|hoba|mutual|signature|aws4-hmac-sha256|ssws|bot|hmac|pat|sso-key|splunk)$/i;
const looksCredential = (v) => (v.length >= 6 && /\d/.test(v)) || (v.length >= 8 && /[+/=._~-]/.test(v)) || v.length >= 20;
// `user<sep>password` after a flag: "quoted", 'quoted' or bare. Groups: head,
// then user (with the separator) and password for each of the three forms.
const userPassRe = (head, sep) => new RegExp(
  String.raw`(${head})(?:"([^"\n${sep}]*${sep})([^"\n]*)"|'([^'\n${sep}]*${sep})([^'\n]*)'|([^\s"'${sep}]*${sep})([^\s"']+))`,
  'gm',
);
// curl / wget / httpie style `-u user:password`, `--user=user:password`.
// `date -u +%H:%M` (a format) and `docker -u 1000:1000` (uid:gid) stay.
const USER_PASS_RE = userPassRe(String.raw`(?:^|\s)(?:-u|--(?:proxy-)?user(?=[ \t=]))(?:[ \t]+|=)?`, ':');
const keepUserPass = (user, pass) => /^\+/.test(user) || (/^\d+:$/.test(user) && /^\d+$/.test(pass));
// Query parameters that carry a credential.
const QUERY_SECRET_RE = /([?&;](?:key|sig|sign|signature|token|auth|apikey|api_key|ticket|secret|password|pass|pwd|pw|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)([^&#\s"'<>]+)/gi;
// Webhook URLs whose path is the credential. A generic …/hook(s)/… or
// …/webhook(s)/… path counts when its rest has 16+ token characters with 3+
// digits or mixed case and a digit (`.git/hooks/pre-commit-check` and
// `/hooks/deploy-notify-v2` stay).
const SLACK_HOOK_RE = /\b(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/gi;
const PATH_HOOK_RE = /(\/(?:hook|hooks|webhook|webhooks)\/)([A-Za-z0-9_/-]+)/gi;
const hookToken = (rest) => rest.length >= 16
  && ((rest.match(/\d/g)?.length ?? 0) >= 3 || (/[A-Z]/.test(rest) && /[a-z]/.test(rest) && /\d/.test(rest)));
// `aws configure set <key> <value>` with a secret-ish key.
const AWS_SET_RE = new RegExp(
  String.raw`(\baws[ \t]+configure[ \t]+set[ \t]+(?:--profile[ \t]+\S+[ \t]+)?([\w.-]{1,80})[ \t]+)${VALUE}`,
  'gmi',
);
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

const keepValue = (value) => !value || PLACEHOLDER_RE.test(value) || /^\$/.test(value);

// Replacer for `(head)${VALUE}`: the value goes, its quotes stay.
function valueReplacer(m, head, dq, sq, bare) {
  const value = dq ?? sq ?? bare;
  if (keepValue(value)) return m;
  const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
  return `${head}${q}${SECRET}${q}`;
}

// Replacer for `userPassRe`: the user stays, the password goes.
const userPassReplacer = (keep = () => false) => (m, head, du, dp, su, sp, bu, bp) => {
  const user = du ?? su ?? bu;
  const pass = dp ?? sp ?? bp;
  if (keepValue(pass) || keep(user, pass)) return m;
  const q = du !== undefined ? '"' : su !== undefined ? "'" : '';
  return `${head}${q}${user}${SECRET}${q}`;
};

// Shell segments: split on line ends and `|`, `;`, `&` so a command-specific
// flag is only read in its own command.
const SEGMENT_SPLIT_RE = /([\n|;&]+)/;
const cmdRe = (names) => new RegExp(String.raw`(?<![\w-])(?:${names})(?![\w-])`);
const flagRe = (flag, flags = 'gm') => new RegExp(String.raw`(\s${flag})${VALUE}`, flags);
// Command-specific password flags. `after`: the flag only counts after this
// word (`docker login`); `-p` alone prompts, `-P` is often a port.
const COMMAND_RULES = [
  { cmd: cmdRe('mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlsh|mariadb|mariadb-dump|mariadb-admin'),
    re: flagRe('-p(?=\\S)') },
  { cmd: cmdRe('redis-cli|valkey-cli|keydb-cli'), re: flagRe('-a(?:[ \\t]+|(?=\\S))') },
  // The first -p after sshpass only (a later `ssh -p 22` is a port).
  { cmd: cmdRe('sshpass'), re: flagRe('-p[ \\t]*', 'm') },
  { cmd: cmdRe('docker|podman|nerdctl|buildah|skopeo|helm|oras|finch'), after: cmdRe('login'), re: flagRe('-p(?:[ \\t]+|=|(?=\\S))') },
  { cmd: cmdRe('ldap[a-z]*'), re: flagRe('-w(?:[ \\t]+|(?=\\S))') },
  { cmd: cmdRe('zip|zipcloak'), re: flagRe('-P(?:[ \\t]+|(?=\\S))') },
  { cmd: cmdRe('7z|7za|7zr'), re: flagRe('-p(?=\\S)') },
  { cmd: cmdRe('openssl'), re: flagRe('-k[ \\t]+') },
  { cmd: cmdRe('openssl'), re: flagRe('-pass(?:in|out)?[ \\t]+pass:') },
  { cmd: cmdRe('smbclient|smbget|smbcacls|rpcclient|net'), re: userPassRe(String.raw`\s(?:-U|--user(?:name)?)(?:[ \t]+|=)?`, '%'), user: true },
  { cmd: cmdRe('lftp'), re: userPassRe(String.raw`\s-u[ \t]+`, ','), user: true },
];

function redactCommandFlags(text) {
  const rules = COMMAND_RULES.filter((rule) => rule.cmd.test(text));
  if (!rules.length) return text;
  return text.split(SEGMENT_SPLIT_RE).map((seg, i) => {
    if (i % 2 === 1) return seg; // a separator
    let out = seg;
    for (const rule of rules) {
      const m = rule.cmd.exec(out);
      if (!m) continue;
      let at = m.index + m[0].length;
      if (rule.after) {
        const a = rule.after.exec(out.slice(at));
        if (!a) continue;
        at += a.index + a[0].length;
      }
      out = out.slice(0, at) + out.slice(at).replace(rule.re, rule.user ? userPassReplacer() : valueReplacer);
    }
    return out;
  }).join('');
}

function redactSecrets(text) {
  let out = text;
  // URL credentials: scheme://user:password@host → scheme://[secret]@host
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${SECRET}@`);
  out = out.replace(SLACK_HOOK_RE, `$1${SECRET}`);
  out = out.replace(PATH_HOOK_RE, (m, head, rest) => (hookToken(rest) ? `${head}${SECRET}` : m));
  out = out.replace(QUERY_SECRET_RE, (m, key, value) => (keepValue(value) ? m : `${key}${SECRET}`));
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${SECRET}`);
  out = out.replace(/\b(Basic)\s+[A-Za-z0-9+/=]{12,}/g, `$1 ${SECRET}`);
  out = out.replace(AUTH_SCHEME_RE, (m, head, scheme, gap, value) => (
    keepValue(value) || !(AUTH_SCHEMES_RE.test(scheme) || looksCredential(value)) ? m : `${head}${scheme}${gap}${SECRET}`));
  out = out.replace(USER_PASS_RE, userPassReplacer(keepUserPass));
  out = out.replace(AWS_SET_RE, (m, head, key, dq, sq, bare) => (
    /secret|token|password/i.test(key) ? valueReplacer(m, head, dq, sq, bare) : m));
  out = redactCommandFlags(out);
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET);
  out = out.replace(KEY_VALUE_RE, (m, lead, q1, key, sep, dq, sq, bare, offset, whole) => {
    if (/tokens$/i.test(key)) return m;
    const value = dq ?? sq ?? bare;
    // A reference to a variable is not the secret itself; keep it readable.
    if (!value || keepValue(value) || PLAIN_VALUE_RE.test(value)) return m;
    // A bare `pass:` / `pw:` is prose more often than a key ("Tests pass: 12/12").
    if (/^(?:pass|pw)$/i.test(key) && !sep.includes('=')) return m;
    // An auth scheme followed by more text: AUTH_SCHEME_RE decided about it
    // (`Authorization: Token [secret]`, `Authorization: Bearer $TOKEN`,
    // `authorization: required for all requests`).
    if (bare !== undefined && /authorization$/i.test(key) && /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(bare)
      && /^[ \t]+[^\s"',;]/.test(whole.slice(offset + m.length, offset + m.length + 2))) return m;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${lead}${q1}${key}${sep}${quote}${SECRET}${quote}`;
  });
  out = out.replace(ZH_KEY_VALUE_RE, (m, key, sep, q, value) => (
    PLACEHOLDER_RE.test(value) ? m : `${key}${sep}${q}${SECRET}`));
  out = out.replace(FLAG_RE, valueReplacer);
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

// Email addresses; a `git@host:repo` remote and `user@host:path` (scp,
// rsync) stay. The address must not continue with `.x` or `:x`.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])(?!\.[A-Za-z0-9])(?!:\S)/g;

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
// they replace, so text past the limit can move into the field.
export const REDACT_MARGIN_CHARS = 1024;
// The margin grows ×8 up to this before redactTruncate gives up on the last line.
export const REDACT_MARGIN_MAX_CHARS = 64 * 1024;
// redactTruncate results kept (LRU): every tick sees the same texts again.
// Bounded by entries and by stored UTF-16 units (key + value), so the
// long-running bridge holds at most about 8 MB here. A normal Agent needs
// about 200 tasks x 5 fields, far below both limits.
export const CACHE_MAX_ENTRIES = 4096;
export const CACHE_MAX_UNITS = 4 * 1024 * 1024;

/**
 * A small LRU map from string keys to string values (or null), bounded by
 * `maxEntries` and by `maxUnits`, the summed `length` of keys and values.
 * `get` refreshes an entry; `set` evicts the least recently used entries
 * until both limits hold. A value bigger than `maxUnits` on its own is not
 * stored.
 */
export function createLru({ maxEntries, maxUnits }) {
  const map = new Map();
  let units = 0;
  const cost = (key, value) => key.length + (value?.length ?? 0);
  const remove = (key) => {
    units -= cost(key, map.get(key));
    map.delete(key);
  };
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) remove(key);
      if (cost(key, value) > maxUnits) return;
      map.set(key, value);
      units += cost(key, value);
      while (map.size > maxEntries || units > maxUnits) remove(map.keys().next().value);
    },
    get size() { return map.size; },
    get units() { return units; },
  };
}

const cache = createLru({ maxEntries: CACHE_MAX_ENTRIES, maxUnits: CACHE_MAX_UNITS });

/** Current size of the redactTruncate cache (entries and UTF-16 units), for tests. */
export function redactCacheStats() {
  return { entries: cache.size, units: cache.units };
}

// UTF-16 index just past the first `n` code points of `text` (its length when shorter).
function cpIndex(text, n) {
  let i = 0;
  for (let k = 0; k < n && i < text.length; k += 1) i += text.codePointAt(i) > 0xffff ? 2 : 1;
  return i;
}

/*
 * Redact a prefix of `str` that is long enough, then truncate. Every pattern
 * but the PEM block and Bearer/Basic stays inside one line, so the lines of a
 * prefix before its last (cut) line redact exactly as in the whole text; the
 * PEM block and Bearer/Basic only redact more in a prefix. The prefix is
 * accepted once the first `max` code points of its redaction end before its
 * last line break. Otherwise the margin grows; at the cap the cut line is
 * dropped (a single line longer than the cap gives `…`). The cut line itself
 * is never shown: a quoted value or token cut in half there would not match.
 */
function redactPrefix(str, max, opts) {
  for (let margin = REDACT_MARGIN_CHARS; ; margin *= 8) {
    const end = cpIndex(str, max + margin);
    if (end >= str.length) return truncateChars(redactText(str, opts), max);
    const red = redactText(str.slice(0, end), opts);
    const nl = red.lastIndexOf('\n');
    if (nl >= 0 && cpIndex(red, max) <= nl) return truncateChars(red, max);
    if (margin >= REDACT_MARGIN_MAX_CHARS) return truncateChars(`${red.slice(0, nl + 1)}…`, max);
  }
}

/**
 * Redact, then truncate to `max` code points. Equal to
 * `truncateChars(redactText(input), max)` whenever a cut line is found within
 * `max` + 64 K code points; past that cap the cut line is dropped (whole lines
 * plus `…`, see `redactPrefix`), which can only show less. A huge input costs
 * only about `max` + 64 K code points, and results are cached (LRU).
 */
export function redactTruncate(input, max, opts) {
  if (input === null || input === undefined) return null;
  const str = String(input);
  const home = opts?.home === undefined ? os.homedir() : opts.home;
  const key = createHash('sha1').update(`${home}\u0000${max}\u0000`).update(str).digest('base64');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Store a flat copy: the result can be a slice that keeps a much larger
  // string (the whole crontab output, or the redacted prefix) alive while the
  // unit budget counts only its own length.
  const out = Buffer.from(redactPrefix(str, max, opts), 'utf16le').toString('utf16le');
  cache.set(key, out);
  return out;
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
