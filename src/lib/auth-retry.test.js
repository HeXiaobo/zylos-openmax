import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTH_RETRY_DELAYS_MS, isTransientAuthError, withAuthRetry } from './auth-retry.js';

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** A send that fails with the given errors in order, then succeeds. */
function scripted(errors, result = { ok: true }) {
  const calls = { n: 0 };
  const send = async () => {
    const err = errors[calls.n++];
    if (err) throw err;
    return result;
  };
  return { send, calls };
}

function harness() {
  const slept = [];
  const reacquired = [];
  return {
    slept,
    reacquired,
    opts: {
      sleep: async (ms) => { slept.push(ms); },
      reacquire: async (o) => { reacquired.push(o); },
    },
  };
}

test('only a 401 counts as a transient auth failure', () => {
  assert.equal(isTransientAuthError(httpError(401)), true);
  for (const s of [400, 403, 404, 409, 422, 500, 503, undefined]) {
    assert.equal(isTransientAuthError(httpError(s)), false, String(s));
  }
  assert.equal(isTransientAuthError(new Error('network')), false);
  assert.equal(isTransientAuthError(undefined), false);
});

test('a send that succeeds first time is sent once, with no wait or re-acquire', async () => {
  const { send, calls } = scripted([]);
  const h = harness();
  assert.deepEqual(await withAuthRetry(send, h.opts), { ok: true });
  assert.equal(calls.n, 1);
  assert.deepEqual(h.slept, []);
  assert.deepEqual(h.reacquired, []);
});

test('🔴 a 401 is re-sent after a backoff and a token re-acquire, and the card goes out', async () => {
  const { send, calls } = scripted([httpError(401)], { message_id: 'm1' });
  const h = harness();
  assert.deepEqual(await withAuthRetry(send, h.opts), { message_id: 'm1' });
  assert.equal(calls.n, 2);
  assert.deepEqual(h.slept, [AUTH_RETRY_DELAYS_MS[0]]);
  assert.deepEqual(h.reacquired, [{ force: false, attempt: 1 }]);
});

test('🔴 the last retry mints a fresh token rather than re-reading the cached one', async () => {
  const { send, calls } = scripted([httpError(401), httpError(401)]);
  const h = harness();
  await withAuthRetry(send, h.opts);
  assert.equal(calls.n, 3);
  assert.deepEqual(h.slept, [...AUTH_RETRY_DELAYS_MS]);
  assert.deepEqual(h.reacquired, [{ force: false, attempt: 1 }, { force: true, attempt: 2 }]);
});

test('🔴 retries are bounded: a persistent 401 is rethrown after the last retry', async () => {
  const errors = Array.from({ length: 10 }, () => httpError(401));
  const { send, calls } = scripted(errors);
  const h = harness();
  await assert.rejects(withAuthRetry(send, h.opts), (err) => err.status === 401);
  assert.equal(calls.n, AUTH_RETRY_DELAYS_MS.length + 1);
});

test('🔴 a non-auth failure is rethrown at once, unchanged — the caller still falls back', async () => {
  for (const err of [httpError(400), httpError(403), httpError(500), new Error('fetch failed')]) {
    const { send, calls } = scripted([err]);
    const h = harness();
    await assert.rejects(withAuthRetry(send, h.opts), (e) => e === err);
    assert.equal(calls.n, 1);
    assert.deepEqual(h.slept, []);
    assert.deepEqual(h.reacquired, []);
  }
});

test('a non-auth failure on a retry ends the loop with that failure', async () => {
  const bad = httpError(422);
  const { send, calls } = scripted([httpError(401), bad]);
  const h = harness();
  await assert.rejects(withAuthRetry(send, h.opts), (e) => e === bad);
  assert.equal(calls.n, 2);
});

test('a failing re-acquire does not mask the send: the retry still happens', async () => {
  const { send, calls } = scripted([httpError(401)], 'sent');
  const result = await withAuthRetry(send, {
    sleep: async () => {},
    reacquire: async () => { throw new Error('token endpoint down'); },
  });
  assert.equal(result, 'sent');
  assert.equal(calls.n, 2);
});
