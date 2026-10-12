/**
 * Shared secret-redaction helper for RPC/debug logging.
 *
 * token.js and client.js both log request/response bodies for debugging
 * (gated by COCO_RPC_LOG). Those bodies carry access_token/refresh_token
 * values on the auth endpoints — this strips known-sensitive field names
 * before anything is serialized to a log line, regardless of nesting depth.
 *
 * No dependencies (leaf module) so token.js can use it without creating the
 * circular import it explicitly avoids with client.js.
 */

// Exact-match (not substring) on purpose: a substring match on /token/ or
// /secret/ would also catch access_token_expires_at/refresh_token_expires_at
// (plain timestamps, useful for debugging expiry — not secrets) and any
// unrelated field that merely contains those words in its name.
const SENSITIVE_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token', 'token',
  'upload_token', 'verify_token',
  'api_key', 'apikey',
  'client_secret', 'clientsecret', 'app_secret',
  'password', 'secret', 'ticket',
  'webhook_url',
]);

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

// =============================================================================
// redactText — free-text redaction for agent activity commentary
// =============================================================================
//
// Process text (an agent's commentary between tool calls) is the only free
// text the activity feature sends off the host, so it is scrubbed here first.
// Order matters: control / invisible characters are removed BEFORE the
// pattern replacements, otherwise one planted inside a JWT or base64 run would
// split it past the patterns and be deleted afterwards, rejoining the secret.
// \n and \t are kept (the private-key rule spans lines).

const TEXT_REDACTED = '[已隐藏]';
const TEXT_ENCODED = '[编码内容已省略]';
const TEXT_LIMIT = 2000;

// Rule 9 (runs first): C0 controls except \t \n, DEL, C1 controls (cws-comm
// rejects any Unicode control character other than \n \t), zero-width
// characters, line / paragraph separators, BOM, soft hyphen.
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g;

const TEXT_SENSITIVE_KEYS = [
  ...SENSITIVE_KEYS,
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'private_key',
  'session', 'passwd', 'pwd',
];
// `api_key` should also catch `api-key` / `--api-key`: treat - and _ alike.
const KEY_ALT = [...new Set(TEXT_SENSITIVE_KEYS)]
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_]/g, '[-_]'))
  .join('|');

const TEXT_RULES = [
  // 1. PEM private key blocks (multi-line).
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, TEXT_REDACTED],
  // 2. Well-known token shapes.
  [/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, TEXT_REDACTED],
  // 3. JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, TEXT_REDACTED],
  // 4. Authorization schemes.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${TEXT_REDACTED}`],
  // 5. Credentials embedded in a URL.
  [/(https?:\/\/)[^/\s"']+@/g, `$1${TEXT_REDACTED}@`],
  // 6a. JSON / assignment / URL query value of a sensitive key.
  [new RegExp(`(["']?)\\b(${KEY_ALT})\\1(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|(?:Bearer|Basic) \\[已隐藏\\]|[^\\s,;&}\\]"']+)`, 'gi'),
    (_m, q, key, sep, value) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${q}${key}${q}${sep}${quote}${TEXT_REDACTED}${quote}`;
    }],
  // 6b. Command-line flag followed by a separate value: --token abc.
  [new RegExp(`(--?(?:${KEY_ALT}))(\\s+)("[^"]*"|'[^']*'|[^\\s-]\\S*)`, 'gi'), `$1$2${TEXT_REDACTED}`],
  // 7. Header lines.
  [/(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n"']+/gi, `$1: ${TEXT_REDACTED}`],
  // 8. Inline images and long base64 runs.
  [/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/g, TEXT_ENCODED],
  [/[A-Za-z0-9+/]{256,}={0,2}/g, TEXT_ENCODED],
];

/**
 * Redact free text and report whether it had to be truncated (the caller
 * emits a `truncated` notice). Truncation counts code points after the
 * invisible characters are removed: > 2000 → first 1998 + "…".
 *
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
export function redactTextDetailed(text) {
  let s = String(text ?? '').replace(INVISIBLE_RE, '');
  for (const [re, rep] of TEXT_RULES) s = s.replace(re, rep);
  const cps = Array.from(s);
  if (cps.length > TEXT_LIMIT) return { text: `${cps.slice(0, TEXT_LIMIT - 2).join('')}…`, truncated: true };
  return { text: s, truncated: false };
}

/** redactTextDetailed() without the truncation flag. */
export function redactText(text) {
  return redactTextDetailed(text).text;
}
