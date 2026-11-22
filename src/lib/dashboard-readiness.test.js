import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { readDashboardProbe, evaluateDashboardReadiness, readinessProbePath } from './dashboard-readiness.js';
import { getDashboardPort } from './dashboard-address.js';
import { createDefaultReadinessGate, createReadinessGate, createGatedOnlineReporter, readinessReport } from './agent-readiness.js';

// Boundary: real HTTP client, private loopback server and existing Dashboard
// port config. Run for readiness HTTP/address/timeout changes; unrelated work
// may skip. Every case allocates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and passes
// only its private port/config to product code; the outer runner also isolates.
// No runtime, tmux or database starts; t.after closes all server connections.
async function fixture(t, respond) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/omr-http-'));
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'home/zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  let server;
  const controller = new AbortController(), waits = new Set();
  t.after(async () => {
    try {
      controller.abort();
      server?.closeAllConnections();
      await Promise.allSettled([...waits]);
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep));
    assert.equal(env[key].startsWith(os.userInfo().homedir + path.sep), false);
  }
  t.diagnostic(JSON.stringify({ ...env, tmux: 'unused', database: 'unused' }));
  const requests = [];
  server = http.createServer((request, response) => { requests.push(request.url); respond(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, requests, env, server, root, controller, waits, testSignal: t.signal };
}

const payload = (overrides = {}) => ({ ready: true, reason: null, session_mode: 'multi', session_running: null,
  runtime_health: { claude: { source: 'record', health: 'ok' }, codex: { source: 'missing', health: null } }, ...overrides });

function wireCore(f, version = '1.0.0-beta.9') {
  const core = path.join(f.root, 'core');
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'zylos', version }));
  f.env.ZYLOS_PACKAGE_ROOT = core;
  for (const folder of ['.zylos', 'components/dashboard', 'activity-monitor']) fs.mkdirSync(path.join(f.env.ZYLOS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'components/dashboard/config.json'), JSON.stringify({ port: f.port }));
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'activity-monitor/agent-status.json'), JSON.stringify({ state: 'busy', health: 'auth_failed' }));
  // Short injected settings bound a faulty readiness policy too. Teardown
  // aborts in-flight HTTP, then drains every real wait before removing files.
  const gate = createDefaultReadinessGate({ env: f.env,
    options: () => ({ max_wait_ms: 30, poll_ms: 5 }),
    fetch: (url, init) => fetch(url, { ...init,
      signal: AbortSignal.any([init.signal, f.controller.signal, f.testSignal]) }),
  });
  return { ...gate, waitUntilReady(...args) {
    const wait = gate.waitUntilReady(...args);
    f.waits.add(wait);
    wait.finally(() => f.waits.delete(wait)).catch(() => {});
    return wait;
  } };
}

test('the existing Dashboard configured port serves the unauthenticated readiness request', async t => {
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true }));
  });
  const config = path.join(f.env.HOME, 'zylos/components/dashboard/config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ port: f.port }));
  assert.deepEqual(await readDashboardProbe({ port: getDashboardPort({ home: f.env.HOME }), path: '/api/health?probe=ready' }), { status: 200, body: { ready: true } });
  assert.deepEqual(f.requests, ['/api/health?probe=ready']);
});

test('a probe without a path requests the address an unknown version selects', async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify({ ready: true })));
  assert.deepEqual(await readDashboardProbe({ port: f.port }), { status: 200, body: { ready: true } });
  assert.deepEqual(f.requests, [readinessProbePath(null)]);
  assert.deepEqual(f.requests, ['/api/health?probe=ready']);
});

test('a 503 readiness body is read without treating HTTP status as a transport error', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: false }));
  });
  assert.deepEqual(await readDashboardProbe({ port: f.port, path: '/api/health/ready' }), { status: 503, body: { ready: false } });
});

for (const mode of ['no-headers', 'incomplete-body']) {
  test(`a ${mode} response times out and releases the HTTP request`, { timeout: 3000 }, async t => {
    const f = await fixture(t, (_request, response) => {
      if (mode === 'incomplete-body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
    });
    assert.equal(await readDashboardProbe({ port: f.port, path: '/api/health/ready', timeoutMs: 30 }), null);
  });
}

test('default Core 1 wiring reports a sessionless multi instance ready and releases onboarding', { timeout: 3000 }, async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
  const gate = wireCore(f);
  assert.deepEqual(readinessReport(await gate.evaluate()), { ready: true, observable: true, stage: 'ready', reason: 'ready' });
  const result = await gate.waitUntilReady();
  assert.equal(result.timedOut, false);
  assert.equal(result.polls, 0, 'onboarding must not enter its wait loop');
  let reports = 0;
  const online = createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } });
  await online({ slug: 'isolated-org' });
  assert.equal(reports, 1, 'multi mode needs no current-launch session file');
  assert.ok(f.requests.every(url => url === '/api/health?probe=ready'));
});

test('default Core 1 uses the Core Claude default when runtime is unset', async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
  const gate = wireCore(f);
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), '{}');
  const v = await gate.evaluate();
  assert.equal(v.ready, true);
  assert.equal(v.onboardingReason, undefined);
  assert.equal(v.detail.runtime, 'claude');
});

// The installed Core version selects the probe address before the request.
// beta.2 sorts before beta.12 only when the pre-release number is compared as
// a number, not as text.
for (const [version, expected] of [
  ['1.0.0-beta.1', '/api/health?probe=ready'], ['1.0.0-beta.2', '/api/health?probe=ready'],
  ['1.0.0-beta.11', '/api/health?probe=ready'], ['1.0.0-beta.12', '/api/health/ready'],
  ['1.0.0-beta.13', '/api/health/ready'], ['1.0.0', '/api/health/ready'], ['1.2.0', '/api/health/ready'],
]) {
  test(`default wiring on Core ${version} requests ${expected}`, async t => {
    const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
    assert.equal(readinessProbePath(version), expected);
    const v = await wireCore(f, version).evaluate();
    assert.equal(v.ready, true);
    assert.deepEqual(f.requests, [expected]);
  });
}

// A Core upgrade restarts only the Core services; each evaluation reads the
// installed version again, so the probe address follows it without a restart.
test('default wiring follows a Core version that changes between evaluations', async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
  const gate = wireCore(f, '1.0.0-beta.11');
  const setVersion = version => fs.writeFileSync(path.join(f.env.ZYLOS_PACKAGE_ROOT, 'package.json'), JSON.stringify({ name: 'zylos', version }));
  assert.equal((await gate.evaluate()).ready, true);
  setVersion('1.0.0-beta.12');
  assert.equal((await gate.evaluate()).ready, true);
  setVersion('1.0.0-beta.11');
  assert.equal((await gate.evaluate()).ready, true);
  assert.deepEqual(f.requests, ['/api/health?probe=ready', '/api/health/ready', '/api/health?probe=ready']);
});

test('default wiring with an unreadable Core version requests nothing and keeps core_version_unknown', async t => {
  const f = await fixture(t, () => { throw new Error('an unknown Core must not request HTTP'); });
  const gate = wireCore(f, 'unreadable');
  assert.deepEqual(readinessReport(gate.evaluate()), { ready: false, observable: false, stage: 'runtime_down', reason: 'core_version_unknown' });
  assert.equal(f.requests.length, 0);
});

test('default Core 0 wiring retains file readiness and never requests Dashboard', async t => {
  const f = await fixture(t, () => { throw new Error('legacy Core must not request HTTP'); });
  const gate = wireCore(f, '0.9.9');
  const result = gate.evaluate();
  assert.equal(result.reason, 'health_auth_failed');
  assert.equal(result.ready, false);
  assert.equal(f.requests.length, 0);
});

test('default Core 1 connection failure never falls back to legacy status', async t => {
  const f = await fixture(t, (_request, response) => response.end('{}'));
  const gate = wireCore(f);
  await new Promise(resolve => f.server.close(resolve));
  const result = await gate.evaluate();
  assert.deepEqual(readinessReport(result), { ready: false, observable: false, stage: 'runtime_down', reason: 'dashboard_unavailable' });
});

for (const [reason, stage] of [['supervisor_unavailable', 'runtime_down'], ['session_not_running', 'runtime_up']]) {
  test(`default Core 1 maps ${reason} to ${stage}`, async t => {
    const f = await fixture(t, (_request, response) => {
      response.statusCode = 503;
      response.end(JSON.stringify(payload({ ready: false, reason, session_mode: 'single', session_running: false })));
    });
    assert.deepEqual(readinessReport(await wireCore(f).evaluate()), { ready: false, observable: false, stage, reason });
  });
}

for (const runtime of ['claude', 'codex']) for (const health of ['ok', 'auth_failed', 'down', 'unavailable', 'rate_limited', 'recovering']) {
  test(`${runtime} ${health}: availability stays ready and only selected health defers onboarding`, async () => {
    const data = payload({ runtime_health: {
      [runtime]: { source: 'record', health },
      [runtime === 'claude' ? 'codex' : 'claude']: { source: 'record', health: 'auth_failed' },
    } });
    const v = await evaluateDashboardReadiness({ runtime, readProbe: async () => ({ status: 200, body: data }) });
    assert.deepEqual(readinessReport(v), { ready: true, observable: true, stage: 'ready', reason: 'ready' });
    assert.equal(v.onboardingReason, ['auth_failed', 'down', 'unavailable'].includes(health) ? `health_${health}` : undefined);
  });
}

for (const source of ['missing', 'unreadable']) {
  test(`${source} health releases onboarding without inventing login history`, async () => {
    const v = await evaluateDashboardReadiness({ runtime: 'claude',
      readProbe: async () => ({ status: 200, body: payload({ runtime_health: { claude: { source, health: null } } }) }) });
    assert.equal(v.ready, true);
    assert.equal(v.detail.health, null);
    assert.equal(v.detail.health_source, source);
    assert.equal(v.onboardingReason, undefined);
  });
}

for (const probe of [null, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { ready: false } },
  { status: 503, body: { ready: false, reason: 'unknown' } }]) {
  test(`an invalid or unavailable probe is not ready (${JSON.stringify(probe)})`, async () => {
    const v = await evaluateDashboardReadiness({ readProbe: async () => probe });
    assert.equal(v.ready, false);
    assert.equal(readinessReport(v).stage, 'runtime_down');
  });
}

for (const [body, status, failOpen] of [
  ...['auth_failed', 'down', 'unavailable'].map(health =>
    [payload({ runtime_health: { claude: { source: 'record', health } } }), 200, true]),
  [payload({ ready: false, reason: 'session_not_running', session_mode: 'single', session_running: false }), 503, false],
]) {
  test(`onboarding cap preserves ${failOpen ? 'fail-open for runtime health' : 'the single missing-session hold'} (${body.runtime_health.claude.health})`, async () => {
    let now = 0, reports = 0;
    const gate = createReadinessGate({ readCoreVersion: () => '1.0.0',
      readDashboardReadiness: () => evaluateDashboardReadiness({ runtime: 'claude', readProbe: async () => ({ status, body }) }),
      now: () => now, sleep: async ms => { now += ms; }, options: () => ({ maxWaitMs: 5, pollMs: 2 }) });
    const result = await gate.waitUntilReady();
    assert.equal(result.timedOut, true);
    assert.equal(result.failOpenAllowed, failOpen);
    assert.equal(result.waitedMs, 4, 'existing cap stops before the next 2ms poll would exceed 5ms');
    if (failOpen) assert.equal(result.reason, `health_${body.runtime_health.claude.health}`);
    const online = createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } });
    await online({ slug: 'isolated-org' });
    assert.equal(reports, failOpen ? 1 : 0);
  });
}

// Policy boundary: exercise the actual wait loop and online callback, with a
// deterministic clock. Only explicit current-runtime failure may consume time.
for (const runtime of ['claude', 'codex', null, 'unknown']) {
  for (const health of [
    { source: 'missing', health: null }, { source: 'unreadable', health: null },
    ...['ok', 'rate_limited', 'recovering', 'unknown'].map(health => ({ source: 'record', health })),
  ]) {
    test(`onboarding immediately releases ${runtime ?? 'unset'} with ${health.source}/${health.health}`, async () => {
      let now = 0, reports = 0, sleeps = 0;
      const data = payload({ runtime_health: { claude: health, codex: health } });
      const gate = createReadinessGate({ readCoreVersion: () => '1.0.0',
        readDashboardReadiness: () => evaluateDashboardReadiness({ runtime, readProbe: async () => ({ status: 200, body: data }) }),
        now: () => now, sleep: async ms => { sleeps++; now += ms; }, options: () => ({ maxWaitMs: 5, pollMs: 2 }) });
      const result = await gate.waitUntilReady();
      assert.equal(result.ready, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.waitedMs, 0);
      await createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } })({ slug: 'isolated-org' });
      assert.equal(reports, 1);
      assert.equal(sleeps, 0);
    });
  }
}

for (const runtime of [null, 'unknown']) {
  test(`an unrecognized runtime ${runtime} does not wait on another runtime's explicit failures`, async () => {
    const v = await evaluateDashboardReadiness({ runtime, readProbe: async () => ({ status: 200, body: payload({
      runtime_health: { claude: { source: 'record', health: 'auth_failed' }, codex: { source: 'record', health: 'down' } },
    }) }) });
    assert.equal(v.ready, true);
    assert.equal(v.onboardingReason, undefined);
  });
}

for (const source of ['missing', 'unreadable']) {
  // Same isolated HTTP/default-wiring boundary and lifecycle as fixture above.
  test(`default Core 1 sessionless multi instance releases onboarding with ${source} health`, { timeout: 3000 }, async t => {
    const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload({
      runtime_health: { codex: { source, health: null } },
    }))));
    const gate = wireCore(f);
    fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'codex' }));
    assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, 'activity-monitor/foreground-session.json')), false);
    const result = await gate.waitUntilReady();
    assert.equal(result.ready, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.polls, 0, 'missing health must release without polling');
    let reports = 0;
    await createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } })({ slug: 'isolated-org' });
    assert.equal(reports, 1);
  });
}

// Same default factory/HTTP boundary: exercise an actual blocked policy path
// with short settings, so cleanup is also covered when readiness does wait.
test('default Core 1 health waiting uses the bounded fixture budget and drains at teardown', { timeout: 3000 }, async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload({
    runtime_health: { claude: { source: 'record', health: 'auth_failed' } },
  }))));
  const gate = wireCore(f), started = performance.now();
  const result = await gate.waitUntilReady();
  const elapsed = performance.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, 'health_auth_failed');
  assert.equal(result.failOpenAllowed, true);
  assert.ok(elapsed < 1000, `blocked default wiring exceeded the test budget: ${elapsed}ms`);
  assert.equal(f.waits.size, 0);
  t.diagnostic(`bounded default wait completed in ${elapsed.toFixed(1)}ms`);
});

// Same HTTP/default-wiring boundary; abort the in-flight request exactly as
// fixture teardown does on assertion failure or the test timeout.
test('default Core 1 pending onboarding work settles after fixture cancellation', { timeout: 3000 }, async t => {
  let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, () => entered());
  const gate = wireCore(f), started = performance.now();
  const pending = gate.waitUntilReady();
  await requested;
  assert.equal(f.waits.size, 1);
  f.controller.abort();
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, 'dashboard_unavailable');
  assert.equal(f.waits.size, 0);
  assert.ok(performance.now() - started < 1000, 'cancelled wait must settle within the short fixture budget');
});

// Same isolated default factory and HTTP boundary; a reachable old Dashboard
// has no ready field, distinct from an actual connection failure above.
test('default Core 1 identifies an unsupported readiness probe without disabling fail-open', { timeout: 3000 }, async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify({ status: 'ok', uptime: 100 })));
  const gate = wireCore(f, '1.0.0-beta.8');
  assert.deepEqual(readinessReport(await gate.evaluate()), {
    ready: false, observable: false, stage: 'runtime_down', reason: 'probe_unsupported',
  });
  const result = await gate.waitUntilReady();
  assert.equal(result.reason, 'probe_unsupported');
  assert.equal(result.timedOut, true);
  assert.equal(result.failOpenAllowed, true);
});

for (const [status, body] of [[200, { ready: false }], [500, { status: 'error' }]]) {
  test(`HTTP ${status} with ${JSON.stringify(body)} remains a Dashboard availability failure`, async () => {
    const result = await evaluateDashboardReadiness({ readProbe: async () => ({ status, body }) });
    assert.equal(result.reason, 'dashboard_unavailable');
    assert.deepEqual(readinessReport(result), {
      ready: false, observable: false, stage: 'runtime_down', reason: 'dashboard_unavailable',
    });
  });
}
