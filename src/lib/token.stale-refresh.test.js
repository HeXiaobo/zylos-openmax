import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach, after, mock } from 'node:test';

// Production path this guards (verified against cws-core auth/service.go):
// a long-lived process (the comm-bridge) caches the JWT pair in memory, while
// short-lived CLI processes (comm/core verbs) share the same token file. When a
// CLI process refreshes first it rotates the refresh token and writes the new
// pair to disk. cws-core tolerates re-using a rotated refresh token for only
// 10 s (rotation grace); later re-use is treated as theft and revokes the whole
// token family. So the long-lived process must never refresh with its stale
// in-memory refresh token once another process has rotated it on disk.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'token-stale-'));
process.env.HOME = HOME;
process.env.COCO_API_KEY = 'cwsk_test';
process.env.COCO_API_URL = 'http://127.0.0.1:65535';
process.env.COCO_RPC_LOG = '0';

const { getAccessToken, refresh, invalidate } = await import('./token.js');

const TOKEN_FILE = path.join(HOME, 'zylos/components/openmax/runtime/tokens/_identity.json');
const realFetch = globalThis.fetch;
let calls;

function writeTokenFile(state) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(state));
}

function pair(n, accessTtlMs) {
  const now = Date.now();
  return {
    access_token: `access-${n}`,
    access_token_expires_at: now + accessTtlMs,
    refresh_token: `refresh-${n}`,
    refresh_token_expires_at: now + 7 * 24 * 3600_000,
  };
}

const MIN = 60_000;

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  calls = [];
  invalidate();
  fs.rmSync(TOKEN_FILE, { force: true });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, body });
    const n = calls.length + 100;
    const payload = {
      access_token: `access-${n}`,
      access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      refresh_token: `refresh-${n}`,
      refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
});

afterEach(() => { mock.timers.reset(); });

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// Each test: this process caches pair 0 (15 min TTL), then 14.5 min pass so the
// cached access token is inside the 60 s refresh margin.

test('near expiry, a pair another process already refreshed on disk is adopted without refreshing', async () => {
  writeTokenFile(pair(0, 15 * MIN));
  assert.equal(await getAccessToken(''), 'access-0');
  mock.timers.tick(14.5 * MIN);
  writeTokenFile(pair(1, 15 * MIN));           // a CLI process rotated: fresh pair 1 on disk

  assert.equal(await getAccessToken(''), 'access-1');
  assert.deepEqual(calls, [], 'no refresh call: the fresh pair on disk is used as is');
});

test('refresh uses the refresh token on disk, never a stale one cached in memory', async () => {
  writeTokenFile(pair(0, 15 * MIN));
  assert.equal(await getAccessToken(''), 'access-0');
  mock.timers.tick(14.5 * MIN);
  writeTokenFile(pair(1, 0.75 * MIN));         // rotated by another process (later expiry), itself near expiry

  await getAccessToken('');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.endsWith('/auth/refresh'), true);
  assert.equal(calls[0].body.refresh_token, 'refresh-1', 'refreshed with the rotated token from disk');
});

test('an explicit refresh() also prefers the newer pair on disk', async () => {
  writeTokenFile(pair(0, 15 * MIN));
  assert.equal(await getAccessToken(''), 'access-0');
  writeTokenFile(pair(1, 16 * MIN));           // newer pair on disk

  await refresh('');
  assert.equal(calls[0].body.refresh_token, 'refresh-1');
});

test('an older pair on disk never replaces a newer cached one', async () => {
  writeTokenFile(pair(0, 15 * MIN));
  assert.equal(await getAccessToken(''), 'access-0');
  mock.timers.tick(14.5 * MIN);
  writeTokenFile(pair(9, -1 * MIN));           // stale leftover on disk (already expired)

  await getAccessToken('');
  assert.equal(calls[0].body.refresh_token, 'refresh-0');
});

test('with no file on disk the cached pair is still used', async () => {
  writeTokenFile(pair(0, 15 * MIN));
  assert.equal(await getAccessToken(''), 'access-0');
  mock.timers.tick(14.5 * MIN);
  fs.rmSync(TOKEN_FILE);                       // e.g. a failed write elsewhere

  await getAccessToken('');
  assert.equal(calls[0].body.refresh_token, 'refresh-0');
});
