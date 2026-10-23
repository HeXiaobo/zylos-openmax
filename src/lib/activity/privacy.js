/**
 * Display redaction — the one privacy gate of agent_run schema v3.
 *
 * Owner decision (taskboard #137 v4, D3): for now ONLY secret-type content is
 * filtered — API keys, tokens, passwords, bearer / basic credentials, private
 * keys, cookies, connection strings with credentials, `.env`-style
 * KEY=secret values, URL userinfo and sensitive query parameters. Search
 * terms, domains, page titles, file names, attachment names, task names,
 * e-mail addresses and paths are NOT hidden. No org-level blocklist.
 *
 * Every string that leaves the host in a step — title, object, detail
 * (link titles / urls, diff preview, text), thinking body — goes through
 * redactDisplay() (urls through redactUrl()). cws-comm / cws-core / cws-fe
 * render what they get and never filter again.
 *
 * Order matters: invisible / control characters are removed BEFORE the
 * patterns run, otherwise one planted inside a token would split it past the
 * patterns. \n and \t are kept (multi-line previews / thinking).
 */

export const REDACTED = '[已隐藏]';
export const ENCODED = '[编码内容已省略]';

// C0 controls except \t \n, DEL, C1 controls, zero-width characters, line /
// paragraph separators, BOM, soft hyphen.
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

// Key names whose value is a secret. Matched as the END of a key (so
// `DB_PASSWORD`, `x-api-key`, `client_secret`, `"refreshToken"` match, while
// `max_tokens` / `token_count` / `password_hint_shown` do not).
const SECRET_KEY_WORDS = [
  'password', 'passwd', 'passphrase', 'pwd', 'secret', 'token', 'api[-_]?key', 'apikey', 'access[-_]?key',
  'private[-_]?key', 'secret[-_]?key', 'client[-_]?secret', 'credentials?', 'auth', 'authorization',
  'cookie', 'session[-_]?id', 'sessionid', 'signature', 'sig', 'dsn', 'connection[-_]?string', 'conn[-_]?str',
];
const KEY_TAIL = `(?:${SECRET_KEY_WORDS.join('|')})`;
// A key: optional prefix of word chars / - / . then a secret word, case-insensitive.
const KEY_RE_SRC = `[A-Za-z0-9_.-]*?${KEY_TAIL}`;
const LITERAL_VALUE_RE = /^(?:true|false|null|none|undefined|yes|no|required|optional|\[已隐藏\]|\*+)$/i;

// Query parameters whose value is a credential (redactUrl drops them).
const SENSITIVE_QUERY_RE = new RegExp(
  `^(?:${KEY_RE_SRC}|key|code|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential)|sv|se|sp|skoid|sktid|access_token|id_token|refresh_token)$`, 'i',
);

const RULES = [
  // 1. PEM private key blocks (an unterminated one runs to the end of the text).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // 2. Inline images and long base64 runs.
  [/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/g, ENCODED],
  [/[A-Za-z0-9+/]{256,}={0,2}/g, ENCODED],
  // 3. Well-known token shapes.
  [/\b(?:sk-(?:proj-|ant-[a-z0-9]*-?)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|cwsk_[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, REDACTED],
  // 4. JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // 5. Authorization schemes.
  [/\b(Bearer|Basic|Token|Digest)\s+(?!\[已隐藏\])[A-Za-z0-9._~+/=:-]{6,}/g, `$1 ${REDACTED}`],
  // 6. Credentials in a URL / connection string: scheme://user:password@ (a
  //    bare user — git@ — is not a secret).
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:"'`<>]*:[^\s/@"'`<>]+@/g, `$1${REDACTED}@`],
  // 7. Header lines.
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*:\s*)[^\r\n"']+/gi, `$1$2${REDACTED}`],
  // 8. KEY=value / "key": "value" / key: value of a secret-looking key
  //    (.env lines, JSON, YAML, URL queries, connection strings).
  [new RegExp(`(["']?)\\b(${KEY_RE_SRC})\\1(\\s*[:=]\\s*)(\\[已隐藏\\]|"(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|(?:\\[已隐藏\\]|[^\\s,;&}\\[\\]"'\`<>])+)`, 'gi'),
    (m, q, key, sep, value) => {
      const inner = value.replace(/^["']|["']$/g, '');
      // No value-based exemption (all-digit values included): numeric metadata
      // such as max_tokens / token_count is already excluded by the key match.
      if (!inner || LITERAL_VALUE_RE.test(inner)) return m;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    }],
  // 9. Command-line flag followed by a separate value: --password abc.
  [new RegExp(`(--?${KEY_RE_SRC})(\\s+)(?!\\[已隐藏\\])("[^"\\n]*"|'[^'\\n]*'|[^\\s-]\\S*)`, 'gi'), `$1$2${REDACTED}`],
  // 10. Random-looking long tokens: ≥ 32 chars mixing upper, lower and digits,
  //     or ≥ 48 hex digits (a 40-hex git sha stays).
  [/[A-Za-z0-9_+/=-]{32,}/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? REDACTED : m)],
  [/\b[0-9a-fA-F]{48,}\b/g, REDACTED],
];

/**
 * Redact secrets from display text. Everything else is kept as-is (no
 * translation, no rewording); \n and \t are kept.
 * @param {unknown} text
 * @returns {string}
 */
export function redactDisplay(text) {
  let s = String(text ?? '').replace(INVISIBLE_RE, '');
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

/** True when nothing but placeholders / punctuation / whitespace is left. */
export function isEmptyAfterRedaction(s) {
  return !/[\p{L}\p{N}]/u.test(String(s ?? '').split(REDACTED).join('').split(ENCODED).join(''));
}

/**
 * A URL for display: userinfo dropped, credential query parameters and a
 * credential-bearing fragment dropped, then redactDisplay() over the rest
 * (a token in the path). Only http(s).
 * @returns {{ url: string, site: string } | undefined}
 */
export function redactUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  u.username = '';
  u.password = '';
  for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY_RE.test(k)) u.searchParams.delete(k);
  if (u.hash && /[=&]/.test(u.hash)) {
    const h = new URLSearchParams(u.hash.slice(1));
    if ([...h.keys()].some((k) => SENSITIVE_QUERY_RE.test(k))) u.hash = '';
  }
  const site = u.hostname;
  if (!site) return undefined;
  let href = u.toString();
  try { href = decodeURI(href); } catch {}
  return { url: redactDisplay(href), site };
}

/** Hostname of an http(s) URL, or undefined. */
export function siteOf(raw) {
  return redactUrl(raw)?.site;
}
