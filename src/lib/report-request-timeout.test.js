import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The runtime-metrics and channel-liveness PUTs carry a deadline: a cws-core
// that accepts the connection and never answers fails the report after the
// timeout instead of holding the tick, and the next tick reports again.
//
// Runs the real reporters through the real HTTP client against a local server
// that never responds. HOME points at a temporary directory before the client
// and config modules load, and a fixed bearer comes from the environment, so
// nothing reads the live config or mints a token.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-timeout-'));
fs.mkdirSync(path.join(home, 'zylos/components/openmax'), { recursive: true });
fs.writeFileSync(path.join(home, 'zylos/components/openmax/config.json'), JSON.stringify({ orgs: {} }));
process.env.HOME = home;
process.env.COCO_AUTH_TOKEN = 'test-bearer';
process.env.COCO_API_PREFIX = '/api/v1';
process.env.COCO_RPC_LOG = '0';

const { createChannelLivenessReporter } = await import('./channel-liveness-reporter.js');
const { createMetricsReporter, REPORT_REQUEST_TIMEOUT_MS } = await import('./metrics-reporter.js');
const { CHANNEL_TYPES } = await import('./channel-liveness-reporter.js');
const { CHANNEL_COMPONENT } = await import('./channel-connector.js');
const { putForOrg, apiPath } = await import('./client.js');

const TIMEOUT_MS = 300;
// Generous bound for one tick: the deadline plus scheduling slack, far below
// anything an unbounded request would reach.
const TICK_BOUND_MS = 5_000;
// Each test must finish (or fail) well inside this; a regression that removes
// the deadline fails here instead of hanging the run.
const TEST_TIMEOUT_MS = 15_000;

const ORGS = new Map([['org-a', { org_id: 'org-id-a', self: { member_id: 'm-1' } }]]);

let server;
const received = []; // { method, url } of every request the silent server saw

before(async () => {
  server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    req.resume(); // read the body, never respond
    if (req.url.endsWith('/stalled-body')) {
      // Status and headers arrive, then the body stops partway.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data":');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.COCO_API_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

async function timedTick(tick) {
  const started = Date.now();
  await tick();
  return Date.now() - started;
}

function pm2Statuses() {
  const m = new Map();
  for (const ct of CHANNEL_TYPES) m.set(CHANNEL_COMPONENT[ct].pm2Service, ct === 'telegram');
  return m;
}

test('channel-liveness: an unanswered PUT fails after the timeout and the next tick reports again', { timeout: TEST_TIMEOUT_MS }, async () => {
  received.length = 0;
  const warns = [];
  const report = createChannelLivenessReporter(ORGS, {
    log: () => {},
    warn: (m) => warns.push(m),
    readPm2Statuses: async () => pm2Statuses(),
    requestTimeoutMs: TIMEOUT_MS,
  });

  for (let tick = 1; tick <= 2; tick++) {
    const elapsed = await timedTick(report);
    assert.ok(elapsed >= TIMEOUT_MS - 50, `tick ${tick} returned before the deadline (${elapsed}ms)`);
    assert.ok(elapsed < TICK_BOUND_MS, `tick ${tick} took ${elapsed}ms`);
    assert.equal(received.length, tick, `tick ${tick} sent its PUT`);
    assert.equal(warns.length, tick);
    assert.match(warns[tick - 1], /channel-liveness report failed: PUT \S+ no response within the 300ms request deadline/);
  }
  assert.deepEqual(received.map((r) => r.method), ['PUT', 'PUT']);
  assert.equal(received[0].url, '/api/v1/agents/m-1/channel-liveness');
});

test('runtime-metrics: an unanswered PUT fails after the timeout and the next tick reports again', { timeout: TEST_TIMEOUT_MS }, async () => {
  received.length = 0;
  const warns = [];
  const report = createMetricsReporter(ORGS, {
    log: () => {},
    warn: (m) => warns.push(m),
    // Local dashboard state (no auth) and channel listing stand-ins.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ state: 'IDLE', system_metrics: {}, runtime_info: {} }) }),
    execFile: async (file) => ({ stdout: file === 'pm2' ? '[]' : '' }),
    readCoreVersion: () => '0.9.9', // Core 0.x: /api/state stand-in below
    createCgroup: () => ({ sample() {}, read: () => ({ cgroup_version: 'v2', errors: [] }) }),
    requestTimeoutMs: TIMEOUT_MS,
  });

  for (let tick = 1; tick <= 2; tick++) {
    const elapsed = await timedTick(report);
    assert.ok(elapsed >= TIMEOUT_MS - 50, `tick ${tick} returned before the deadline (${elapsed}ms)`);
    assert.ok(elapsed < TICK_BOUND_MS, `tick ${tick} took ${elapsed}ms`);
    assert.equal(received.length, tick, `tick ${tick} sent its PUT`);
    assert.equal(warns.length, tick);
    assert.match(warns[tick - 1], /metrics report failed: PUT \S+ no response within the 300ms request deadline/);
  }
  assert.deepEqual(received.map((r) => r.method), ['PUT', 'PUT']);
  assert.equal(received[0].url, '/api/v1/agents/m-1/runtime-metrics');
});

test('both reporters default to the 20s report deadline', { timeout: TEST_TIMEOUT_MS }, async () => {
  assert.equal(REPORT_REQUEST_TIMEOUT_MS, 20_000);
  const seen = [];
  const capture = async (orgId, p, payload, opts) => { seen.push({ path: p, opts }); };

  await createChannelLivenessReporter(ORGS, {
    log: () => {},
    warn: () => {},
    readPm2Statuses: async () => pm2Statuses(),
    putForOrg: capture,
  })();
  await createMetricsReporter(ORGS, {
    log: () => {},
    warn: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ state: 'IDLE', system_metrics: {}, runtime_info: {} }) }),
    execFile: async (file) => ({ stdout: file === 'pm2' ? '[]' : '' }),
    readCoreVersion: () => '0.9.9', // Core 0.x: /api/state stand-in below
    createCgroup: () => ({ sample() {}, read: () => ({ cgroup_version: 'v2', errors: [] }) }),
    putForOrg: capture,
  })();

  assert.equal(seen.length, 2);
  assert.match(seen[0].path, /channel-liveness$/);
  assert.equal(seen[0].opts?.timeoutMs, 20_000);
  assert.match(seen[1].path, /runtime-metrics$/);
  assert.equal(seen[1].opts?.timeoutMs, 20_000);
});

test('a response whose body stalls after the headers fails as a request timeout', { timeout: TEST_TIMEOUT_MS }, async () => {
  received.length = 0;
  const started = Date.now();
  await assert.rejects(
    putForOrg('org-id-a', apiPath('/agents/m-1/stalled-body'), { channels: [] }, { timeoutMs: TIMEOUT_MS }),
    (err) => err.code === 'REQUEST_TIMEOUT' && /no response within the 300ms request deadline/.test(err.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= TIMEOUT_MS - 50 && elapsed < TICK_BOUND_MS, `took ${elapsed}ms`);
  assert.equal(received.length, 1);
});
