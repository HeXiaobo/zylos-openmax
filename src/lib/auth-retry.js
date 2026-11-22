/**
 * Bounded retry of an outbound send on a transient auth failure (HTTP 401).
 *
 * Why this exists
 * ---------------
 * client.js already refreshes the JWT and retries once on a 401, but that
 * single retry happens immediately and only re-reads the shared token file. A
 * 401 seen while ANOTHER process is mid-refresh (or right after a refresh-token
 * reuse revoked the token family — the race fixed in token.js) can therefore
 * fail both attempts inside the same few milliseconds. For an onboarding card
 * that is costly: the skill treats any failed card send as permanent and
 * downgrades to the plain-text form, and if the text send lands in the same
 * invalidation window there is no fallback after it at all.
 *
 * So the user-visible send verbs (comm.send / comm.send_card / comm.ask_card)
 * wrap their POST in `withAuthRetry`: on a 401 it waits briefly, re-acquires
 * the token, and re-sends the SAME request (same client_msg_id, so a retry can
 * never post twice), a small fixed number of times. The re-acquire escalates:
 * the first retries only drop the cached token (adopting a pair another
 * process has just rotated onto disk); the last one mints a fresh token from
 * the api_key, which cannot be a revoked one.
 *
 * Anything that is not a 401 — a 4xx refusing a field, a 5xx, a network
 * error, a response-shape error — is rethrown immediately, unchanged, so the
 * caller's existing fallback behaviour is untouched.
 *
 * Pure: the send, the re-acquire and the sleep are injected, so the loop is
 * unit-testable without a server or real waiting.
 */

/** Backoff before each retry, in ms. Length = number of retries. */
export const AUTH_RETRY_DELAYS_MS = Object.freeze([500, 1500]);

/** A 401 is the only failure worth re-sending: the request never ran. */
export function isTransientAuthError(err) {
  return err?.status === 401;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => Promise<T>} send  Send the request once. Must re-send the
 *   identical request (build the body once, outside).
 * @param {object} [opts]
 * @param {(o: {force: boolean, attempt: number}) => Promise<void>|void} [opts.reacquire]
 *   Re-acquire the auth token before a retry. `force` is true on the last
 *   retry (mint a fresh token rather than re-read the cached one).
 * @param {number[]} [opts.delaysMs]  Backoff before each retry.
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {string} [opts.label]  For the stderr log line.
 * @returns {Promise<T>}
 * @template T
 */
export async function withAuthRetry(send, {
  reacquire = () => {},
  delaysMs = AUTH_RETRY_DELAYS_MS,
  sleep = realSleep,
  label = 'send',
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isTransientAuthError(err) || attempt >= delaysMs.length) throw err;
      const force = attempt === delaysMs.length - 1;
      console.warn(
        `[auth-retry] 401 on ${label}; retry ${attempt + 1}/${delaysMs.length} in ${delaysMs[attempt]}ms`
        + (force ? ' with a freshly minted token' : ''),
      );
      await sleep(delaysMs[attempt]);
      try {
        await reacquire({ force, attempt: attempt + 1 });
      } catch (e) {
        // A failed re-acquire must not mask the send's own error; the next
        // send resolves its token again and fails (or not) on its own.
        console.warn(`[auth-retry] token re-acquire failed: ${e?.message || e}`);
      }
    }
  }
}
