import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A JWT refresh that cws-core accepts and never answers fails after the auth
// request deadline (20s), takes the existing failure path (re-exchange with the
// api_key), and does not leave the per-org refresh stuck: the next caller that
// needs a token starts a new refresh, which succeeds once the server answers.
//
// Runs the real token module against a local HTTP server. HOME points at a
// temporary directory before the module loads, so the token files and config
// it reads and writes are test fixtures.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-timeout-'));
const compDir = path.join(home, 'zylos/components/openmax');
fs.mkdirSync(path.join(compDir, 'runtime/tokens'), { recursive: true });
fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {} }));
const ORG = 'org-a';
// Expired access token with a usable refresh token: the next getAccessToken refreshes.
fs.writeFileSync(path.join(compDir, 'runtime/tokens', `${ORG}.json`), JSON.stringify({
  access_token: 'access-old',
  access_token_expires_at: Date.now() - 1_000,
  refresh_token: 'refresh-1',
  refresh_token_expires_at: Date.now() + 86_400_000,
}));
process.env.HOME = home;
process.env.COCO_RPC_LOG = '0';
delete process.env.COCO_API_KEY;

const { getAccessToken } = await import('./token.js');

const DEADLINE_MS = 20_000;
let answerRefresh = false; // false: /auth/refresh is read and never answered
const received = [];       // { url, body } of every request

let server;
before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/auth/refresh') {
        if (!answerRefresh) return; // silent
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'access-new',
          access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          refresh_token: 'refresh-2',
          refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }));
        return;
      }
      // The re-exchange fallback fails at once, so the refresh deadline alone
      // sets how long the failing call takes.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { detail: 'unavailable' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.COCO_API_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unanswered refresh fails after the deadline, then the next call refreshes again and succeeds', { timeout: 60_000 }, async () => {
  // Two concurrent callers share the one in-flight refresh.
  const started = Date.now();
  const results = await Promise.allSettled([getAccessToken(ORG), getAccessToken(ORG)]);
  const elapsed = Date.now() - started;

  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.ok(elapsed >= DEADLINE_MS - 100, `failed before the deadline (${elapsed}ms)`);
  assert.ok(elapsed < DEADLINE_MS + 5_000, `took ${elapsed}ms`);
  // One refresh for both callers, then the existing fallback: re-exchange.
  assert.deepEqual(received.map((r) => r.url), ['/auth/refresh', '/auth/agent/token']);
  assert.equal(received[0].body.refresh_token, 'refresh-1');

  // The server answers again: a new call starts a new refresh and gets the new token.
  answerRefresh = true;
  received.length = 0;
  assert.equal(await getAccessToken(ORG), 'access-new');
  assert.deepEqual(received.map((r) => r.url), ['/auth/refresh']);
  assert.equal(received[0].body.refresh_token, 'refresh-1');
  const saved = JSON.parse(fs.readFileSync(path.join(compDir, 'runtime/tokens', `${ORG}.json`), 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-2');
});
