/**
 * Server-side request signing for direct-mode connections (TikTok Shop is the
 * first user; nothing here knows any connector).
 *
 * A direct connection whose Acquire response carries
 * `request_signing: { scheme, max_body_bytes }` must have EVERY outbound
 * request signed by the platform before it is sent (the application secret
 * never leaves cws-connect). invokeDirect (direct-exec.js) assembles the
 * request as usual, serializes the body once, hands URL + those exact bytes to
 * cws-core `POST /connect/connections/{id}/sign`, and sends the URL the server
 * returns, unchanged, with the same bytes. Whether to sign is decided ONLY by
 * that marker — never by connector slug — and `scheme` is not interpreted
 * (logs / diagnostics only).
 *
 * This module holds the connector-agnostic pieces: reading the marker, one
 * retry on a transient failure, and the mapping of the
 * server's error codes to messages an Agent can act on. A signing failure
 * never results in an unsigned request. Leaf module (no client / config
 * import) like direct-exec.js; the cws-core call itself is
 * connection-events.js signRequestCall.
 */

/** cws-core sign path for a connection (caller wraps it with apiPath). */
export function signPath(connectionId) {
  return `/connect/connections/${encodeURIComponent(connectionId)}/sign`;
}

// Fields never written to the [rpc] log for the sign route: the request URL
// and body (business data), and the signed URL / headers / params in the
// response (the signature). The route path, status and error codes still are.
export const SIGN_LOG_REDACT_KEYS = Object.freeze(['url', 'body', 'headers', 'signed_params']);

/** Default timeout for one sign call (the request is sent right after). */
export const SIGN_TIMEOUT_MS = 20 * 1000;

/** Signing-related error codes cws-connect / cws-core return (X-Error-Code). */
export const SIGNING_ERROR_CODES = Object.freeze({
  SIGNING_NOT_ENABLED: 'CONNECT_SIGNING_NOT_ENABLED',
  REQUEST_NOT_IN_CATALOG: 'CONNECT_REQUEST_NOT_IN_CATALOG',
  BODY_TOO_LARGE: 'CONNECT_BODY_TOO_LARGE',
  SHOP_NOT_AUTHORIZED: 'CONNECT_SHOP_NOT_AUTHORIZED',
  CLIENT_UPGRADE_REQUIRED: 'CONNECT_CLIENT_UPGRADE_REQUIRED',
});

const NOTHING_SENT = 'Nothing was sent to the provider.';

/**
 * The connection's signing requirement, or null when its requests are sent
 * as before. Requires a non-empty string `scheme`; `maxBodyBytes` is 0 when
 * the server gave no positive limit (then only the server enforces one).
 */
export function requestSigningOf(cred) {
  const rs = cred && cred.request_signing;
  if (!rs || typeof rs !== 'object' || typeof rs.scheme !== 'string' || rs.scheme.trim() === '') return null;
  const max = Number(rs.max_body_bytes);
  return { scheme: rs.scheme, maxBodyBytes: Number.isFinite(max) && max > 0 ? max : 0 };
}

/** The error code a cws-core error body carries (envelope error.code or a flat code), or ''. */
export function errorCodeOf(err) {
  let b = err && err.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (b && typeof b === 'object') {
    const c = (b.error && typeof b.error === 'object' ? b.error.code : undefined) ?? b.code;
    if (typeof c === 'string' && c) return c;
  }
  return '';
}

function isTransient(err) {
  if (!err) return false;
  if (err.code === 'REQUEST_TIMEOUT' || err.code === 'TOKEN_TIMEOUT') return true;
  if (typeof err.status !== 'number') return true; // network error: no HTTP answer
  return err.status >= 500;
}

function signingError(status, code, message, cause) {
  return Object.assign(new Error(message), { status, code, sent: false, ...(cause ? { cause } : {}) });
}

/**
 * Turn a failed sign call into an error the Agent can act on. Every message
 * says nothing was sent. Codes the server set are kept (err.code); a sign
 * route missing on an older server becomes `request_signing_unsupported`.
 */
export function mapSigningError(err, { maxBodyBytes = 0, bodyBytes = 0 } = {}) {
  const code = errorCodeOf(err);
  const detail = err && err.message ? ` (server: ${err.message})` : '';
  const status = err && typeof err.status === 'number' ? err.status : 502;
  switch (code) {
    case SIGNING_ERROR_CODES.SIGNING_NOT_ENABLED:
      return signingError(422, code,
        `request signing failed: the server says this connection does not use request signing, but its credential asked for it — the local credential may be stale; run conn.clear_cache for this connection and retry once, and report it to the OpenMax team if it persists. ${NOTHING_SENT}`, err);
    case SIGNING_ERROR_CODES.REQUEST_NOT_IN_CATALOG:
      return signingError(400, code,
        `request signing refused: the request does not match this action in the connection's catalog (method, host, path or query parameters)${detail}. Refresh the catalog (conn.catalog {refresh:true}), check the parameters with conn.action_describe, and pass only parameters the action declares. ${NOTHING_SENT}`, err);
    case SIGNING_ERROR_CODES.BODY_TOO_LARGE:
      return signingError(400, code,
        `request signing refused: the request body${bodyBytes ? ` (${bodyBytes} bytes)` : ''} exceeds the signing limit${maxBodyBytes ? ` of ${maxBodyBytes} bytes` : ''}; send less data per call. ${NOTHING_SENT}`, err);
    case SIGNING_ERROR_CODES.SHOP_NOT_AUTHORIZED:
      return signingError(400, code,
        `request signing refused: the shop named in this request (shop_cipher) is not one this connection authorized. List the connection's authorized shops first (its get_authorized_shops action) and pass one of the returned shop_cipher values; if the shop is missing, the user must re-authorize the connection to include it. ${NOTHING_SENT}`, err);
    case SIGNING_ERROR_CODES.CLIENT_UPGRADE_REQUIRED:
      return clientUpgradeError(err);
    default:
      break;
  }
  if (!code && status === 404) {
    return signingError(501, 'request_signing_unsupported',
      `request signing is not available on this environment yet (the server has no sign endpoint), so this connection cannot be used from here. ${NOTHING_SENT}`, err);
  }
  const msg = err && err.message ? err.message : 'unknown error';
  return signingError(status, code || (err && err.code) || 'request_signing_failed',
    `request signing failed: ${msg}. ${NOTHING_SENT}`, err);
}

/** CONNECT_CLIENT_UPGRADE_REQUIRED (from Acquire, or a sign call) → upgrade hint. */
export function clientUpgradeError(cause) {
  return signingError(426, SIGNING_ERROR_CODES.CLIENT_UPGRADE_REQUIRED,
    `this connection requires request signing, which this openmax plugin version does not support; upgrade the openmax plugin and retry. ${NOTHING_SENT}`, cause);
}

/**
 * Sign one request: one retry on a transient failure (network, timeout, 5xx);
 * any other failure is mapped (mapSigningError) and thrown. A 401 is already
 * retried once by the client after a JWT refresh.
 *
 * @param {Function} sign  (req) → Promise<{url, headers, expires_at, signed_params}>
 * @param {object} req     { action, method, url, body?, content_type? }
 */
export async function signWithRetry(sign, req, ctx = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return validateSignResponse(await sign(req));
    } catch (err) {
      if (err && err.signResponseInvalid) throw err;
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  throw mapSigningError(lastErr, ctx);
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Check the sign response shape; malformed → 502, never sent. */
export function validateSignResponse(res) {
  const bad = (why) => Object.assign(
    signingError(502, 'request_signing_invalid_response', `request signing failed: the server returned an invalid response (${why}). ${NOTHING_SENT}`),
    { signResponseInvalid: true },
  );
  if (!res || typeof res !== 'object') throw bad('empty');
  if (typeof res.url !== 'string' || !res.url) throw bad('no url');
  const headers = {};
  if (res.headers != null) {
    if (typeof res.headers !== 'object' || Array.isArray(res.headers)) throw bad('headers is not an object');
    for (const [k, v] of Object.entries(res.headers)) {
      if (!HEADER_NAME_RE.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw bad('invalid header');
      headers[k] = v;
    }
  }
  let expiresAtMs = null;
  if (res.expires_at != null && res.expires_at !== '') {
    expiresAtMs = Date.parse(res.expires_at);
    if (!Number.isFinite(expiresAtMs)) throw bad('unparseable expires_at');
  }
  return { url: res.url, headers, expiresAtMs };
}
