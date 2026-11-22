import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

// token.js resolves the api_key and core URL from env before falling back to
// config, so setting these keeps the test hermetic (no config.json needed).
process.env.COCO_API_KEY = 'cwsk_test';
process.env.COCO_API_URL = 'http://127.0.0.1:65535';
process.env.COCO_RPC_LOG = '0'; // silence the [rpc] stdout lines during the test

const { exchange } = await import('./token.js');

const realFetch = globalThis.fetch;

/** Make global.fetch return a non-ok response whose JSON body is `payload`. */
function stubErrorResponse(payload, status = 400) {
  globalThis.fetch = async () => ({
    ok: false,
    status,
    text: async () => JSON.stringify(payload),
  });
}

before(() => {});
after(() => { globalThis.fetch = realFetch; });

async function messageFrom(payload) {
  stubErrorResponse(payload);
  try {
    await exchange('org-xyz');
    assert.fail('expected exchange() to throw on a non-ok response');
    return '';
  } catch (err) {
    return err.message;
  }
}

test('nested error envelope with detail renders the real cause, not [object Object]', async () => {
  const msg = await messageFrom({ error: { title: 'Bad Request', detail: 'org not found' } });
  assert.match(msg, /org not found/);
  assert.doesNotMatch(msg, /\[object Object\]/);
});

test('nested error envelope falls back to title when detail is absent', async () => {
  const msg = await messageFrom({ error: { title: 'Unauthorized', status: 401 } });
  assert.match(msg, /Unauthorized/);
  assert.doesNotMatch(msg, /\[object Object\]/);
});

test('an unrecognized object body never coerces to [object Object]', async () => {
  const msg = await messageFrom({ error: { code: 'E_WEIRD' } });
  assert.doesNotMatch(msg, /\[object Object\]/);
  // falls through to the raw text body, which still carries the real content
  assert.match(msg, /E_WEIRD/);
});

test('a string error field is used directly', async () => {
  const msg = await messageFrom({ error: 'plain string error' });
  assert.match(msg, /plain string error/);
  assert.doesNotMatch(msg, /\[object Object\]/);
});
