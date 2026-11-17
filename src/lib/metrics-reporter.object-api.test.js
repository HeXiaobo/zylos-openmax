import { test } from 'node:test';
import fs from 'node:fs';
import { setImmediate as flushIO } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createMetricsReporter, OBJECT_API_PATHS } from './metrics-reporter.js';

// Real reporter and Dashboard client; HTTP, the cgroup collector and the
// readiness gate are stand-ins. Response bodies follow Core's Dashboard API
// reference (skills/dashboard/docs/api.md): GET /api/instance,
// /api/groups/counts, /api/usage/summary and /api/groups/:id.

const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
).version;

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

function instanceBody({ mode = 'single', runtime = 'claude', accounts } = {}) {
  return {
    agent: { name: 'isolated', color: '#123456', hue: 210 },
    tz: 'UTC',
    session_mode: { sessionMode: mode, transition: null, globalGate: null, blocked: null, supervisor: 'reachable', lastCompleted: null, lastEvents: [] },
    default_runtime: runtime,
    defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-5', effort: 'medium' } },
    versions: {},
    runtimeHealth: null,
    accounts: accounts ?? {
      claude: { used_percentage: 18, resets_at: 1, recordedAt: 2, live: true },
      codex: { usedPercentage: 7, recordedAt: 2, live: false },
    },
    supervisorPaused: false,
    autoRestarts: { count: 0 },
    resources: {
      scope: 'container', sampledAt: 1, cpu_pct: 12.5, cpu_count: 2, cpu_source: 'container',
      mem_pct: 40, mem_used_bytes: 320, mem_total_bytes: 800, mem_source: 'container',
      disk_pct: 22, disk_free_bytes: 780, disk_total_bytes: 1000,
    },
    services: null,
    chat_allow_remote: false,
  };
}

function countsBody({ working = 0, idle = 1, unknown = 0, listKnown = true } = {}) {
  const states = { working, idle, starting: 0, stopping: 0, unknown };
  return {
    readAt: 1,
    listKnown,
    running: { total: working + idle + unknown, states, flags: { queued: 0, noResponse: 0 } },
    offline: { total: 3, waitingSlot: 0, startFailed: 1 },
    pool: { used: working + idle + unknown, capacity: 8 },
  };
}

const usageBody = () => ({
  tz: 'UTC', tzFallback: false, scope: 'all_groups',
  today: { since: 'a', until: 'b', tokens: 1, cost: 9.5, byRuntime: {} },
  sevenDay: { since: 'c', until: 'd', tokens: 2, cost: 41.75, byRuntime: {} },
});

const originBody = () => ({
  id: 'origin', side: 'running', contextPct: 37.5,
  runtimeInfo: { runtime: 'claude', model: 'claude-opus-4-1', effort: 'high', runningVersion: '2.0.0', installedVersion: '2.0.0', update: null, pendingRestart: false },
});

const READY = { ready: true, observable: true, stage: 'ready', reason: 'ready' };

// `routes` maps a request path (with query) to a responder; the defaults are
// a healthy single-session Dashboard.
function harness({ coreVersion = '1.0.0', routes = {}, readiness = READY, createCgroup } = {}) {
  const requests = [];
  const puts = [];
  const warns = [];
  const cgroupCalls = [];
  const served = {
    '/api/auth/token': () => jsonRes(200, { token: 'zylos_st_1', ttl_seconds: 600 }),
    '/api/instance': () => jsonRes(200, instanceBody()),
    '/api/groups/counts': () => jsonRes(200, countsBody({ working: 1, idle: 0 })),
    '/api/usage/summary': () => jsonRes(200, usageBody()),
    '/api/groups/origin?include=': () => jsonRes(200, originBody()),
    '/api/state': () => jsonRes(200, { state: 'IDLE', system_metrics: { disk_pct: 7 }, runtime_info: {} }),
    ...routes,
  };
  const fetch = async (url, opts = {}) => {
    const { pathname, search } = new URL(url);
    const key = pathname + search;
    requests.push({ path: key, authorization: opts.headers?.Authorization ?? null });
    if (!served[key]) throw new Error(`unexpected fetch: ${url}`);
    return served[key](opts);
  };
  const reporter = createMetricsReporter(new Map([['org-a', { org_id: 'org-id-a', self: { member_id: 'm-1' } }]]), {
    log: () => {},
    warn: (m) => warns.push(m),
    dashboardApiKey: 'zylos_ak_x',
    fetch,
    now: () => 0,
    execFile: async () => { throw new Error('no key provisioning in these tests'); },
    fileExists: () => true,
    persistKey: () => {},
    apiKeyCliPath: '/fake/api-key.js',
    evaluateReadiness: async () => readiness,
    putForOrg: async (orgId, path, payload, opts) => { puts.push({ orgId, path, payload, opts }); },
    apiPath: (p) => `/api/v1${p}`,
    // A function reads the installed version anew on each call, like the product.
    readCoreVersion: typeof coreVersion === 'function' ? coreVersion : () => coreVersion,
    createCgroup: createCgroup ?? (() => {
      cgroupCalls.push('create');
      return {
        sample() { cgroupCalls.push('sample'); },
        read() { cgroupCalls.push('read'); return { cpu_pct: 50, mem_pct: 60, mem_total_bytes: 100, mem_used_bytes: 60, cgroup_version: 'v2', errors: [] }; },
      };
    }),
  });
  const paths = () => requests.map((r) => r.path).filter((p) => p !== '/api/auth/token');
  return { reporter, requests, paths, puts, warns, cgroupCalls };
}

// ── Core 1.0.0-beta.12 or later: the payload is built from the object APIs ──

test('single session: every field comes from its documented object-API field', async () => {
  const h = harness();
  await h.reporter();
  assert.deepEqual(h.paths(), ['/api/instance', '/api/groups/counts', '/api/usage/summary', '/api/groups/origin?include=']);
  assert.ok(h.requests.every((r) => r.path === '/api/auth/token' || r.authorization === 'Bearer zylos_st_1'));
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.puts[0].payload, {
    version: PKG_VERSION,
    resources: {
      scope: 'container', cpu_pct: 12.5, mem_pct: 40, mem_total_bytes: 800, mem_used_bytes: 320,
      disk_pct: 22, disk_free_bytes: 780,
    },
    runtime: {
      state: 'BUSY',
      model_id: 'claude-opus-4-1',
      model: null,
      context_pct: 37.5,
      effort: 'high',
      session_mode: 'single',
      groups: {
        running: { total: 1, states: { working: 1, idle: 0, starting: 0, stopping: 0, unknown: 0 }, flags: { queued: 0, noResponse: 0 } },
        offline: { total: 3, waitingSlot: 0, startFailed: 1 },
        pool: { used: 1, capacity: 8 },
      },
    },
    cost: { session: null, daily: 9.5, weekly: 41.75 },
    rate_limit_pct: null,
    readiness: READY,
  });
  assert.deepEqual(h.warns, []);
});

test('multi session: Origin is not read and the single-session fields are null', async () => {
  const h = harness({ routes: {
    '/api/instance': () => jsonRes(200, instanceBody({ mode: 'multi', runtime: 'codex' })),
    '/api/groups/counts': () => jsonRes(200, countsBody({ working: 1, idle: 6, unknown: 1 })),
  } });
  await h.reporter();
  assert.deepEqual(h.paths(), ['/api/instance', '/api/groups/counts', '/api/usage/summary']);
  const { runtime, cost, rate_limit_pct: rateLimit } = h.puts[0].payload;
  assert.equal(runtime.session_mode, 'multi');
  assert.equal(runtime.state, 'BUSY');
  assert.equal(runtime.groups.running.total, 8);
  assert.equal(runtime.model_id, null);
  assert.equal(runtime.effort, null);
  assert.equal(runtime.context_pct, null);
  assert.equal(cost.session, null);
  assert.equal(rateLimit, null, 'the seven-day account quota is not reported as the 5-hour rate limit');
});

for (const [label, mode, counts, expected] of [
  ['an unknown group list', 'single', countsBody({ working: 1, idle: 0, listKnown: false }), 'UNKNOWN'],
  ['an unknown session mode', null, countsBody({ working: 1, idle: 0 }), 'UNKNOWN'],
  ['an unknown group and none working', 'multi', countsBody({ idle: 2, unknown: 1 }), 'UNKNOWN'],
  ['a working group beside an unknown one', 'multi', countsBody({ working: 1, idle: 0, unknown: 1 }), 'BUSY'],
  ['only idle groups', 'multi', countsBody({ idle: 2 }), 'IDLE'],
  ['no running group', 'multi', countsBody({ idle: 0 }), 'IDLE'],
]) {
  test(`state is ${expected} with ${label}`, async () => {
    const h = harness({ routes: {
      '/api/instance': () => jsonRes(200, instanceBody({ mode })),
      '/api/groups/counts': () => jsonRes(200, counts),
    } });
    await h.reporter();
    assert.equal(h.puts[0].payload.runtime.state, expected);
  });
}

test('unknown observations are reported as null, not zero', async () => {
  const instance = instanceBody({ accounts: { claude: null, codex: null } });
  instance.resources = { scope: 'mixed', cpu_pct: null, mem_pct: null, mem_used_bytes: null, mem_total_bytes: null, disk_pct: null, disk_free_bytes: null };
  const usage = usageBody();
  usage.today.cost = null;
  const h = harness({ routes: {
    '/api/instance': () => jsonRes(200, instance),
    '/api/groups/counts': () => jsonRes(200, { ...countsBody(), pool: null }),
    '/api/usage/summary': () => jsonRes(200, usage),
    '/api/groups/origin?include=': () => jsonRes(200, { id: 'origin', contextPct: null, runtimeInfo: { model: null, effort: null } }),
  } });
  await h.reporter();
  const p = h.puts[0].payload;
  assert.deepEqual(p.resources, { scope: 'mixed', cpu_pct: null, mem_pct: null, mem_total_bytes: null, mem_used_bytes: null, disk_pct: null, disk_free_bytes: null });
  assert.equal(p.rate_limit_pct, null);
  assert.equal(p.cost.daily, null);
  assert.equal(p.runtime.groups.pool, null);
  assert.equal(p.runtime.context_pct, null);
  assert.equal(p.runtime.model_id, null);
});

test('the readiness verdict is carried as before and omitted when there is none', async () => {
  const notReady = { ready: false, observable: true, stage: 'runtime_up', reason: 'session_not_running' };
  const h = harness({ readiness: notReady });
  await h.reporter();
  assert.deepEqual(h.puts[0].payload.readiness, notReady);
  const none = harness({ readiness: null });
  await none.reporter();
  assert.equal(Object.hasOwn(none.puts[0].payload, 'readiness'), false);
});

test('an object-API Core never requests /api/state and never creates the cgroup collector', async () => {
  const h = harness({ routes: { '/api/state': () => { throw new Error('/api/state must not be requested'); } } });
  assert.deepEqual(h.cgroupCalls, []);
  await h.reporter();
  await h.reporter();
  assert.equal(h.puts.length, 2);
  assert.deepEqual(h.cgroupCalls, []);
  assert.ok(!h.paths().includes('/api/state'));
});

// ── Object-API Core: any failed read skips the tick, with nothing read instead

const FAILURES = [
  ['404', () => jsonRes(404, { error: 'not_found' }), /http 404/],
  ['500', () => jsonRes(500, { ok: false, error: { code: 'internal_error', message: 'x' } }), /http 500/],
  ['a refused connection', () => { throw new TypeError('fetch failed'); }, /fetch failed/],
  ['an unreadable body', () => ({ ok: true, status: 200, text: async () => '<html>' }), /JSON/],
];
const MALFORMED = {
  '/api/instance': { agent: {} },
  '/api/groups/counts': { readAt: 1, running: { total: 0 } },
  '/api/usage/summary': { today: null },
  '/api/groups/origin?include=': [],
};

for (const path of Object.values(OBJECT_API_PATHS)) {
  for (const [label, respond, reason] of [...FAILURES, ['a malformed body', () => jsonRes(200, MALFORMED[path]), /not an object|no /]]) {
    test(`${label} from ${path} skips the report and reads nothing else`, async () => {
      const h = harness({ routes: { [path]: respond } });
      await h.reporter();
      assert.equal(h.puts.length, 0);
      assert.equal(h.warns.length, 1);
      assert.ok(h.warns[0].includes(`GET ${path}`), h.warns[0]);
      assert.match(h.warns[0], reason);
      const order = Object.values(OBJECT_API_PATHS);
      assert.deepEqual(h.paths(), order.slice(0, order.indexOf(path) + 1), 'stops at the failed read; no /api/state');
      assert.deepEqual(h.cgroupCalls, []);
    });
  }
}

test('a failing Dashboard warns once, and a recovered one reports and re-arms the warning', async () => {
  let up = false;
  const h = harness({ routes: { '/api/groups/counts': () => (up ? jsonRes(200, countsBody()) : jsonRes(503, {})) } });
  await h.reporter();
  await h.reporter();
  assert.equal(h.warns.length, 1);
  assert.equal(h.puts.length, 0);
  up = true;
  await h.reporter();
  assert.equal(h.puts.length, 1);
  up = false;
  await h.reporter();
  assert.equal(h.warns.length, 2);
});

test('a 401 re-exchanges the token once and retries the same read', async () => {
  let rejected = false;
  const h = harness({ routes: {
    '/api/groups/counts': (opts) => {
      if (!rejected) { rejected = true; return jsonRes(401, {}); }
      assert.equal(opts.headers.Authorization, 'Bearer zylos_st_1');
      return jsonRes(200, countsBody());
    },
  } });
  await h.reporter();
  assert.equal(h.puts.length, 1);
  assert.equal(h.requests.filter((r) => r.path === '/api/auth/token').length, 2);
  assert.equal(h.requests.filter((r) => r.path === '/api/groups/counts').length, 2);
});

for (const stall of ['headers', 'body']) {
  test(`a Dashboard that stalls its ${stall} fails the read at the request deadline`, { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onAbort = (signal, reject) => {
      const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail);
    };
    const h = harness({ routes: {
      '/api/instance': (opts) => new Promise((resolve, reject) => {
        if (stall === 'headers') return onAbort(opts.signal, reject);
        resolve({ ok: true, status: 200, text: () => new Promise((_, rejectBody) => onAbort(opts.signal, rejectBody)) });
      }),
    } });
    const tick = h.reporter();
    for (let i = 0; i < 5; i += 1) await flushIO(); // token exchange, then the stalled read
    t.mock.timers.tick(5000);
    await tick;
    assert.equal(h.puts.length, 0);
    assert.match(h.warns[0], /GET \/api\/instance: This operation was aborted/);
  });
}

// ── The Core version selects the source before any request ──────────────────

for (const coreVersion of ['1.0.0-beta.12', '1.0.0-beta.13', '1.0.0', '1.2.0']) {
  test(`Core ${coreVersion} reads the object APIs and not /api/state`, async () => {
    const h = harness({ coreVersion });
    await h.reporter();
    assert.deepEqual(h.paths(), Object.values(OBJECT_API_PATHS));
    assert.deepEqual(h.cgroupCalls, []);
    assert.equal(h.puts[0].payload.runtime.session_mode, 'single');
  });
}

// Earlier Core (every 0.x, 1.x before beta.12) or an unreadable version:
// /api/state and the cgroup, as before. beta.2 sorts before beta.12 only when
// the pre-release number is compared as a number, not as text.
for (const coreVersion of ['1.0.0-beta.11', '1.0.0-beta.2', '1.0.0-beta.1', '0.9.9', null, 'not-a-version']) {
  test(`Core version ${coreVersion ?? 'unreadable'} reads /api/state and no object API`, async () => {
    const h = harness({ coreVersion });
    assert.deepEqual(h.cgroupCalls, ['create'], 'created at startup, as before');
    await h.reporter();
    assert.deepEqual(h.paths(), ['/api/state']);
    assert.deepEqual(h.cgroupCalls, ['create', 'sample', 'read']);
    assert.equal(h.puts[0].payload.resources.cpu_pct, 50);
    assert.equal(Object.hasOwn(h.puts[0].payload.runtime, 'session_mode'), false);
  });
}

// Core upgrades restart only the Core services, not this component, so the
// installed version can change between two ticks of one reporter.
test('a Core upgraded from beta.11 to beta.12 while running reads the object APIs from the next tick', async () => {
  let installed = '1.0.0-beta.11';
  const h = harness({ coreVersion: () => installed });
  await h.reporter();
  assert.deepEqual(h.paths(), ['/api/state']);
  installed = '1.0.0-beta.12';
  const before = h.requests.length, cgroupBefore = h.cgroupCalls.length;
  await h.reporter();
  const after = h.requests.slice(before).map((r) => r.path).filter((p) => p !== '/api/auth/token');
  assert.deepEqual(after, Object.values(OBJECT_API_PATHS));
  assert.deepEqual(h.cgroupCalls.slice(cgroupBefore), [], 'the cgroup is not read once the object APIs are selected');
  assert.equal(h.puts.length, 2);
  assert.equal(h.puts[1].payload.runtime.session_mode, 'single');
  assert.deepEqual(h.warns, []);
});

test('a Core changed from beta.12 to beta.11 while running creates the cgroup collector and reads /api/state from the next tick', async () => {
  let installed = '1.0.0-beta.12';
  const h = harness({ coreVersion: () => installed });
  assert.deepEqual(h.cgroupCalls, [], 'not created at startup on an object-API Core');
  await h.reporter();
  installed = '1.0.0-beta.11';
  const before = h.requests.length;
  await h.reporter();
  const after = h.requests.slice(before).map((r) => r.path).filter((p) => p !== '/api/auth/token');
  assert.deepEqual(after, ['/api/state']);
  assert.deepEqual(h.cgroupCalls, ['create', 'read'], 'created on that tick, which takes its first sample');
  assert.equal(h.puts.length, 2);
  assert.equal(h.puts[1].payload.resources.cpu_pct, 50);
  assert.equal(Object.hasOwn(h.puts[1].payload.runtime, 'session_mode'), false);
  await h.reporter();
  assert.deepEqual(h.cgroupCalls, ['create', 'read', 'sample', 'read'], 'later ticks sample the same collector');
  assert.equal(h.puts.length, 3);
  assert.deepEqual(h.warns, []);
});

test('Core 1.0.0-beta.11 reports exactly the payload that Core 0.x reports', async () => {
  const before = harness({ coreVersion: '1.0.0-beta.11' }), legacy = harness({ coreVersion: '0.9.9' });
  await before.reporter();
  await legacy.reporter();
  assert.deepEqual(before.requests, legacy.requests);
  assert.deepEqual(before.puts, legacy.puts);
});
