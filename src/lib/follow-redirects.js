/**
 * GET an absolute URL and follow its redirects by hand.
 *
 * Artifact download links returned by `/artifacts/resolve` may be short-lived
 * platform links that answer with a redirect to the storage object, instead of
 * the storage URL itself. Following the redirect explicitly (rather than
 * relying on fetch's default) lets callers that fetch with `redirect: 'manual'`
 * keep their guarantees:
 *
 *   - at most `maxRedirects` hops, each a fresh URL; a URL is never requested
 *     twice (a link may be single-use);
 *   - only http(s) targets, and never a downgrade from https to http;
 *   - the caller's headers go to every hop, as with fetch's default follow (the
 *     CF Access headers are needed by the gateway that fronts both the API and
 *     the storage) — except that, like fetch, `authorization`,
 *     `proxy-authorization` and `cookie` are dropped once a redirect leaves the
 *     origin, and stay dropped for the remaining hops.
 *
 * Returns the final response, whatever its status. A redirect without a
 * `Location`, or one that breaks the rules above, throws.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const DEFAULT_MAX_REDIRECTS = 3;

// Headers fetch removes when a redirect goes to another origin.
const CROSS_ORIGIN_DROPPED = new Set(['authorization', 'proxy-authorization', 'cookie']);

// Accepts every HeadersInit form fetch does. A plain object keeps its entries
// (and the caller's name casing) as-is; anything else (a Headers instance, an
// array of [name, value] pairs, ...) is normalized through `new Headers()` so
// it is read the way fetch reads it — never via Object.entries, which would
// turn an array's pairs into headers named "0", "1", ...
function withoutCredentialHeaders(headers) {
  const isPlainObject = headers != null && typeof headers === 'object'
    && (Object.getPrototypeOf(headers) === Object.prototype || Object.getPrototypeOf(headers) === null);
  const entries = isPlainObject ? Object.entries(headers) : [...new Headers(headers ?? undefined).entries()];
  return Object.fromEntries(entries.filter(([k]) => !CROSS_ORIGIN_DROPPED.has(String(k).toLowerCase())));
}

export async function fetchFollowingRedirects(url, {
  headers: initialHeaders = {},
  fetchImpl = fetch,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  let current = new URL(url);
  let headers = initialHeaders;
  const seen = new Set();
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new Error(`download: unsupported URL scheme ${current.protocol}`);
    }
    if (seen.has(current.href)) throw new Error('download: redirect loop');
    seen.add(current.href);
    const res = await fetchImpl(current.href, { method: 'GET', headers, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    // Release the redirect body before moving on (undici keeps the socket otherwise).
    try { await res.body?.cancel?.(); } catch { /* best effort */ }
    if (hop >= maxRedirects) throw new Error(`download: more than ${maxRedirects} redirects`);
    const location = typeof res.headers?.get === 'function' ? res.headers.get('location') : undefined;
    if (!location) throw new Error(`download: HTTP ${res.status} without a Location`);
    const next = new URL(location, current);
    if (current.protocol === 'https:' && next.protocol !== 'https:') {
      throw new Error('download: refusing a redirect from https to a non-https URL');
    }
    if (next.origin !== current.origin) headers = withoutCredentialHeaders(headers);
    current = next;
  }
}
