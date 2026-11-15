import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A request's timeoutMs is its whole budget, including resolving the bearer
// token. With the access token expired and cws-core not answering, a report
// tick ends within its budget even though the token refresh behind it is still
// waiting on its own (longer) deadline; later ticks reuse that one refresh;
// and once the server answers, the next tick reports with the new token.
// Callers without timeoutMs stay unbounded.
//
// Real reporter, client.js and token.js against a local HTTP server, with a
// fixture config and token file under a temporary HOME set before the modules
// load. No bearer override is set, so tokens go through token.js.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-token-'));
const compDir = path.join(home, 'zylos/components/openmax');
fs.mkdirSync(path.join(compDir, 'runtime/tokens'), { recursive: true });
fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {} }));
const ORG_ID = 'org-id-a';
fs.writeFileSync(path.join(compDir, 'runtime/tokens', `${ORG_ID}.json`), JSON.stringify({
  access_token: 'access-old',
  access_token_expires_at: Date.now() - 1_000,
  refresh_token: 'refresh-1',
  refresh_token_expires_at: Date.now() + 86_400_000,
}));
process.env.HOME = home;
process.env.COCO_API_PREFIX = '/api/v1';
process.env.COCO_RPC_LOG = '0';
delete process.env.COCO_AUTH_TOKEN;
delete process.env.COCO_USER_TOKEN;
delete process.env.COCO_API_KEY;

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const { createChannelLivenessReporter, CHANNEL_TYPES } = await import('./channel-liveness-reporter.js');
const { CHANNEL_COMPONENT } = await import('./channel-connector.js');
const { getForOrg, putForOrg, apiPath } = await import('./client.js');

const BUDGET_MS = 1_500;
const SLACK_MS = 1_000;

let answering = false;   // false: every request is read and held without a response
const held = [];         // held { req, res } while not answering
const received = [];     // { url, auth } of every request
let route = null;        // optional (req, res) => void that handles a request instead
const timers = [];       // response delays a route scheduled, cleared at teardown

function respond(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/auth/refresh' || req.url === '/auth/agent/token') {
    res.end(JSON.stringify({
      access_token: 'access-new',
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      refresh_token: 'refresh-2',
      refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    return;
  }
  res.end(JSON.stringify({ data: { ok: true }, request_id: 'r' }));
}

let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization || null });
      if (route) route(req, res);
      else if (answering && !req.url.endsWith('/slow')) respond(req, res);
      else held.push({ req, res });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.COCO_API_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const t of timers) clearTimeout(t);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

function pm2Statuses() {
  const m = new Map();
  for (const ct of CHANNEL_TYPES) m.set(CHANNEL_COMPONENT[ct].pm2Service, false);
  return m;
}

const urls = () => received.map((r) => r.url);

// Each test must finish (or fail) well inside this; a regression that removes
// a deadline fails here instead of hanging the run.
const TEST_TIMEOUT_MS = 15_000;

function writeTokenFile(orgId, accessExpiresAt) {
  fs.writeFileSync(path.join(compDir, 'runtime/tokens', `${orgId}.json`), JSON.stringify({
    access_token: `access-${orgId}`,
    access_token_expires_at: accessExpiresAt,
    refresh_token: `refresh-${orgId}`,
    refresh_token_expires_at: Date.now() + 86_400_000,
  }));
}

function later(ms, fn) {
  timers.push(setTimeout(fn, ms));
}

test('expired token, silent server: each tick ends within its budget; the refresh is shared; recovery reports', { timeout: TEST_TIMEOUT_MS }, async () => {
  const warns = [];
  const logs = [];
  const report = createChannelLivenessReporter(new Map([['a', { org_id: ORG_ID, self: { member_id: 'm-1' } }]]), {
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    readPm2Statuses: async () => pm2Statuses(),
    requestTimeoutMs: BUDGET_MS,
  });

  for (let tick = 1; tick <= 2; tick++) {
    const started = Date.now();
    await report();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= BUDGET_MS - 50, `tick ${tick} ended before its budget (${elapsed}ms)`);
    assert.ok(elapsed < BUDGET_MS + SLACK_MS, `tick ${tick} took ${elapsed}ms, budget ${BUDGET_MS}ms`);
    assert.equal(warns.length, tick);
    assert.match(warns[tick - 1], /channel-liveness report failed: PUT \S+ no access token within the 1500ms request deadline/);
  }
  // Both ticks waited on the same refresh (still within token.js's own
  // deadline): one /auth/refresh, and no PUT went out without a token.
  assert.deepEqual(urls(), ['/auth/refresh']);

  // The network comes back: the held refresh is answered, as are new requests.
  answering = true;
  for (const { req, res } of held.splice(0)) respond(req, res);
  received.length = 0;

  await report();
  assert.equal(warns.length, 2, 'no new failure');
  assert.ok(logs.some((m) => /channel-liveness reported/.test(m)));
  assert.deepEqual(urls(), ['/api/v1/agents/m-1/channel-liveness']);
  assert.equal(received[0].auth, 'Bearer access-new');
  assert.deepEqual(unhandled, []);
});

test('a request that gets its token in time leaves no timer behind', { timeout: TEST_TIMEOUT_MS }, async () => {
  answering = true;
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  await putForOrg(ORG_ID, apiPath('/agents/m-1/channel-liveness'), { channels: [] }, { timeoutMs: 60_000 });
  assert.equal(timers(), before);
});

test('without timeoutMs a request is not bounded', { timeout: TEST_TIMEOUT_MS }, async () => {
  answering = true;
  received.length = 0;
  let settled = false;
  const pending = getForOrg(ORG_ID, apiPath('/slow')).then((v) => { settled = true; return v; });
  await new Promise((resolve) => setTimeout(resolve, BUDGET_MS + SLACK_MS));
  assert.equal(settled, false);
  const slow = held.find(({ req }) => req.url.endsWith('/slow'));
  assert.ok(slow, 'request reached the server');
  respond(slow.req, slow.res);
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(unhandled, []);
});

// Budget and delays for the two cases below: a mis-measured deadline would end
// at DELAY + BUDGET (3000ms), a correct one at BUDGET (2000ms).
const SPLIT_BUDGET_MS = 2_000;
const SPLIT_DELAY_MS = 1_000;
const SPLIT_SLACK_MS = 500;

test('the request gets only the time left after its token arrived', { timeout: TEST_TIMEOUT_MS }, async () => {
  const org = 'org-id-split-token';
  writeTokenFile(org, Date.now() - 1_000); // expired: the request refreshes first
  received.length = 0;
  route = (req, res) => {
    if (req.url === '/auth/refresh') later(SPLIT_DELAY_MS, () => respond(req, res)); // token at half budget
    else held.push({ req, res });                                                     // the PUT is never answered
  };
  try {
    const started = Date.now();
    await assert.rejects(
      putForOrg(org, apiPath('/agents/m-1/channel-liveness'), { channels: [] }, { timeoutMs: SPLIT_BUDGET_MS }),
      (err) => err.code === 'REQUEST_TIMEOUT' && /no response within the 2000ms request deadline/.test(err.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= SPLIT_BUDGET_MS - 50, `ended before the budget (${elapsed}ms)`);
    assert.ok(elapsed < SPLIT_BUDGET_MS + SPLIT_SLACK_MS, `took ${elapsed}ms, budget ${SPLIT_BUDGET_MS}ms`);
    assert.deepEqual(urls(), ['/auth/refresh', '/api/v1/agents/m-1/channel-liveness']);
    assert.equal(received[1].auth, 'Bearer access-new');
  } finally {
    route = null;
  }
});

test('a 401 retry shares the original budget', { timeout: TEST_TIMEOUT_MS }, async () => {
  const org = 'org-id-split-401';
  writeTokenFile(org, Date.now() + 3_600_000); // valid: no refresh before either attempt
  received.length = 0;
  let puts = 0;
  route = (req, res) => {
    puts += 1;
    if (puts === 1) {
      // First attempt: 401 after half the budget.
      later(SPLIT_DELAY_MS, () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { detail: 'expired' } }));
      });
    } else {
      held.push({ req, res }); // the retry is never answered
    }
  };
  try {
    const started = Date.now();
    await assert.rejects(
      putForOrg(org, apiPath('/agents/m-1/channel-liveness'), { channels: [] }, { timeoutMs: SPLIT_BUDGET_MS }),
      (err) => err.code === 'REQUEST_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= SPLIT_BUDGET_MS - 50, `ended before the budget (${elapsed}ms)`);
    assert.ok(elapsed < SPLIT_BUDGET_MS + SPLIT_SLACK_MS, `took ${elapsed}ms, budget ${SPLIT_BUDGET_MS}ms`);
    assert.deepEqual(urls(), ['/api/v1/agents/m-1/channel-liveness', '/api/v1/agents/m-1/channel-liveness']);
    assert.equal(received[0].auth, `Bearer access-${org}`);
  } finally {
    route = null;
  }
});
