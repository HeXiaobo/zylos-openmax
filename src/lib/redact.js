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
  // Composio upload-slot responses: a presigned PUT URL is a bearer credential
  // for one storage object, so it never reaches an RPC log line.
  'presigned_url', 'new_presigned_url',
  // OpenMax Browser prepare-result: the browser-remote connection Key. Bare
  // `key` also names non-secret fields (card form field keys); those only lose
  // their value in RPC log lines, which is the safe side to err on.
  'key',
  // Request signatures: server-side request signing (/sign `signed_params`
  // carries `sign`) and connection-issued signatures such as Shopee's
  // url_placeholders sign_* (matched by prefix below) — bound to a token, so
  // handled like one.
  'sign', 'signature', 'signed_params',
]);

// Prefix rule, for signature families whose exact names vary (sign_*).
function isSensitiveKey(k) {
  const lower = k.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || lower.startsWith('sign_');
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}
