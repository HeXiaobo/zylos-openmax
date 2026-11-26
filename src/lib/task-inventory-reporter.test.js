import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskInventoryCollector, createTaskInventoryReporter, readUserCrontab, HEARTBEAT_MS,
} from './task-inventory-reporter.js';
import { snapshotHash } from './task-inventory.js';

const NOW = Date.parse('2026-11-26T01:00:00Z');
const H = 3600_000;
const D = 24 * H;
const at = (ms) => new Date(ms).toISOString();
const noop = () => {};

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function row(id, over = {}) {
  return {
    id, name: `Task ${id}`, promptSummary: `Summary of ${id}`, promptTruncated: false,
    type: 'recurring', status: 'pending', cron: '0 10 * * *', intervalSeconds: null,
    nextRunAt: '2026-11-26T02:00:00.000Z', lastRunAt: '2026-11-25T02:00:43.000Z', updatedAt: '2026-11-25T02:00:43.000Z',
    priority: 3, requireIdle: false, missThreshold: 300, showLastError: false, lastError: null,
    recent: [{ id: 1, status: 'success', executedAt: '2026-11-25T02:00:03.000Z', completedAt: '2026-11-25T02:00:39.000Z', duration: 36000, error: null }],
    nextRuns: { runs: ['2026-11-26T02:00:00.000Z'], in24h: ['2026-11-26T02:00:00.000Z'] },
    target: { kind: 'origin' }, reply: null, reenable: false,
    ...over,
  };
}

// A fake shared Dashboard client. `state.list` is the list body (or a
// function returning a response); details and histories default to OK.
function fakeDashboard(state) {
  const calls = [];
  const client = {
    isQuiet: () => Boolean(state.quiet),
    async get(port, pathname, opts) {
      calls.push(pathname);
      assert.equal(opts?.readBody, true);
      if (state.noToken) return null;
      if (state.throwAll) throw new Error('connect ECONNREFUSED');
      const url = new URL(pathname, 'http://x');
      if (url.pathname === '/api/schedules') {
        if (typeof state.list === 'function') return state.list(url);
        return res(200, state.list);
      }
      const m = /^\/api\/schedules\/([^/]+)(\/history)?$/.exec(url.pathname);
      const id = decodeURIComponent(m[1]);
      if (state.detail) {
        const custom = state.detail(id, Boolean(m[2]), url);
        if (custom) return custom;
      }
      if (m[2]) return res(200, { items: state.history?.[id] ?? [], nextCursor: null });
      return res(200, { task: { ...(state.list.items.find((it) => it.id === id) ?? {}), prompt: `Full prompt of ${id}. Token=abc123` } });
    },
  };
  return { client, calls };
}

const listBody = (items, over = {}) => ({ items, nextCursor: null, total: items.length, available: true, tz: 'Asia/Singapore', ...over });

function collectorWith(state, over = {}) {
  const dash = fakeDashboard(state);
  const warns = [];
  const clock = { t: NOW };
  const crontab = { result: { state: 'not_installed' } };
  // The scheduler database fallback: unreadable unless a test sets a result.
  const db = { result: { state: 'failed', error: 'no database in this test' }, calls: 0 };
  const collector = createTaskInventoryCollector({
    dashboardClient: dash.client,
    warn: (m) => warns.push(m),
    now: () => clock.t,
    getDashboardPort: () => 3470,
    readCrontab: async () => {
      if (crontab.result instanceof Error) throw crontab.result;
      return crontab.result;
    },
    readSchedulerDb: async (nowMs) => {
      db.calls += 1;
      if (db.result instanceof Error) throw db.result;
      return typeof db.result === 'function' ? db.result(nowMs) : db.result;
    },
    cronTimeZone: () => 'UTC',
    home: '/home/alice',
    ...over,
  });
  return { collector, calls: dash.calls, warns, clock, crontab, db };
}

const detailReads = (calls) => calls.filter((p) => /^\/api\/schedules\/[^?]/.test(p));

test('collector: reads the list, then detail + history once per changed task', async () => {
  const state = { list: listBody([row('task-a'), row('task-b')]) };
  const h = collectorWith(state);
  const body = await h.collector.collect();
  assert.deepEqual(body.sources, [
    { source: 'scheduler', state: 'ok', last_ok_at: '2026-11-26T01:00:00Z' },
    { source: 'cron', state: 'not_installed', last_ok_at: null },
  ]);
  assert.equal(body.truncated_count, 0);
  assert.deepEqual(body.tasks.map((t) => t.id), ['scheduler-task-a', 'scheduler-task-b']);
  assert.equal(body.tasks[0].detail.instruction, 'Full prompt of task-a. Token=[secret]');
  assert.equal(h.calls[0], '/api/schedules?limit=100&include=total');
  assert.deepEqual(detailReads(h.calls), [
    '/api/schedules/task-a', '/api/schedules/task-a/history?limit=30',
    '/api/schedules/task-b', '/api/schedules/task-b/history?limit=30',
  ]);

  // Unchanged rows: list only. A moving `nextRuns` window is not a change.
  h.calls.length = 0;
  state.list.items[0].nextRuns = { runs: ['2026-11-27T02:00:00.000Z'], in24h: [] };
  await h.collector.collect();
  assert.deepEqual(h.calls, ['/api/schedules?limit=100&include=total']);

  // A new run on task-b: only task-b is read again.
  h.calls.length = 0;
  state.list.items[1].recent = [...state.list.items[1].recent, { id: 2, status: 'failed', executedAt: at(NOW - H), completedAt: at(NOW - H), duration: 1, error: 'X' }];
  state.history = { 'task-b': [{ id: 2, status: 'failed', executedAt: at(NOW - H), completedAt: at(NOW - H), error: 'X' }] };
  const after = await h.collector.collect();
  assert.deepEqual(detailReads(h.calls), ['/api/schedules/task-b', '/api/schedules/task-b/history?limit=30']);
  assert.equal(after.tasks[0].id, 'scheduler-task-b', 'attention first');
  assert.equal(after.tasks[0].attention_reason, 'undeliverable');
});

test('collector: local_no is the creation order of all task ids', async () => {
  const state = { list: listBody([row('task-mwz0000a-x'), row('task-ms000000-y'), row('task-mw000000-z')]) };
  const body = await collectorWith(state).collector.collect();
  assert.deepEqual(body.tasks.map((t) => [t.id, t.local_no]), [
    ['scheduler-task-mwz0000a-x', 3], ['scheduler-task-ms000000-y', 1], ['scheduler-task-mw000000-z', 2],
  ]);
});

test('collector: one-time tasks delivered more than 7 days ago are neither read nor reported', async () => {
  const old = row('task-old', { type: 'one-time', cron: null, status: 'completed', lastRunAt: at(NOW - 9 * D) });
  const recent = row('task-new', { type: 'one-time', cron: null, status: 'completed', lastRunAt: at(NOW - D) });
  const h = collectorWith({ list: listBody([old, recent]) });
  const body = await h.collector.collect();
  assert.deepEqual(body.tasks.map((t) => [t.id, t.status]), [['scheduler-task-new', 'delivered']]);
  assert.ok(!h.calls.some((p) => p.includes('task-old')));
});

test('collector: pages through the list; beyond maxListPages the rest is counted', async () => {
  const pages = {
    '': listBody([row('task-1')], { nextCursor: 'c/1', total: 5 }),
    'c/1': listBody([row('task-2')], { nextCursor: 'c2', total: 5 }),
    c2: listBody([row('task-3')], { nextCursor: 'c3', total: 5 }),
  };
  const state = { list: (url) => res(200, pages[url.searchParams.get('cursor') ?? '']) };
  state.list.items = [row('task-1'), row('task-2'), row('task-3')];
  const h = collectorWith(state, { maxListPages: 2 });
  const body = await h.collector.collect();
  assert.equal(h.calls[1], '/api/schedules?limit=100&include=total&cursor=c%2F1');
  assert.deepEqual(body.tasks.map((t) => t.id), ['scheduler-task-1', 'scheduler-task-2']);
  assert.equal(body.truncated_count, 3);
});

test('collector: no scheduler database → not_installed with no tasks', async () => {
  const state = { list: listBody([row('task-a')]) };
  const h = collectorWith(state);
  await h.collector.collect();
  state.list = { available: false, items: [], nextCursor: null };
  const body = await h.collector.collect();
  assert.deepEqual(body.sources[0], { source: 'scheduler', state: 'not_installed', last_ok_at: null });
  assert.deepEqual(body.tasks, []);
});

test('collector: a failed list read with an unreadable database keeps the last good tasks and last_ok_at', async () => {
  const state = { list: listBody([row('task-a')]) };
  const h = collectorWith(state);
  const good = await h.collector.collect();
  h.clock.t = NOW + 60_000;
  for (const failure of [
    { list: () => res(503, { ok: false }) },
    { list: () => res(200, { nope: true }) },
    { throwAll: true },
    { noToken: true },
    { quiet: true },
  ]) {
    Object.assign(state, failure);
    const body = await h.collector.collect();
    assert.deepEqual(body.sources[0], { source: 'scheduler', state: 'failed', last_ok_at: '2026-11-26T01:00:00Z' }, JSON.stringify(Object.keys(failure)));
    assert.deepEqual(body.tasks, good.tasks);
    for (const k of Object.keys(failure)) delete state[k];
  }
  assert.equal(h.warns.length, 1, 'warned once for the failure streak');
  assert.match(h.warns[0], /scheduler tasks unavailable \(Dashboard: GET \/api\/schedules: http 503; scheduler database: no database in this test\)/);
  assert.equal(h.db.calls, 5, 'the database was tried after every failed list read');
  state.list = listBody([row('task-a')]);
  const back = await h.collector.collect();
  assert.equal(back.sources[0].state, 'ok');
  assert.equal(back.sources[0].last_ok_at, '2026-11-26T01:01:00Z');
});

test('collector: a failing detail read falls back to list data, stops detail reads, retries next tick', async () => {
  let failing = true;
  const state = {
    list: listBody([row('task-a'), row('task-b')]),
    detail: () => (failing ? res(500, {}) : null),
  };
  const h = collectorWith(state);
  const body = await h.collector.collect();
  assert.deepEqual(detailReads(h.calls), ['/api/schedules/task-a'], 'stopped after the first failure');
  assert.equal(body.sources[0].state, 'ok');
  assert.equal(body.tasks[0].detail.instruction, 'Summary of task-a');
  assert.equal(h.warns.length, 1);
  await h.collector.collect();
  assert.equal(h.warns.length, 1, 'once per failure streak');
  failing = false;
  h.calls.length = 0;
  const next = await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 4, 'both read on the next tick');
  assert.equal(next.tasks[1].detail.instruction, 'Full prompt of task-b. Token=[secret]');
});

test('collector: a task gone between list and detail (404) uses list data', async () => {
  const state = { list: listBody([row('task-a')]), detail: () => res(404, { ok: false }) };
  const body = await collectorWith(state).collector.collect();
  assert.equal(body.tasks[0].detail.instruction, 'Summary of task-a');
});

test('collector: at most maxDetailReadsPerTick detail reads per tick', async () => {
  const items = Array.from({ length: 5 }, (_, i) => row(`task-${i}`));
  const h = collectorWith({ list: listBody(items) }, { maxDetailReadsPerTick: 2 });
  await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 4);
  h.calls.length = 0;
  await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 4);
  h.calls.length = 0;
  await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 2);
  h.calls.length = 0;
  await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 0);
});

test('collector: crontab ok / not installed / failed (keeps the last good crontab)', async () => {
  const h = collectorWith({ list: listBody([]) });
  h.crontab.result = { state: 'ok', text: '# c\n0 3 * * * /home/alice/x.sh\n' };
  const ok = await h.collector.collect();
  assert.deepEqual(ok.sources[1], { source: 'cron', state: 'ok', last_ok_at: '2026-11-26T01:00:00Z' });
  assert.deepEqual(ok.tasks.map((t) => [t.source, t.detail.instruction, t.next_run_at]), [['cron', '~/x.sh', '2026-11-26T03:00:00Z']]);

  h.clock.t = NOW + 3 * H;
  h.crontab.result = { state: 'failed', error: 'permission denied' };
  const failed = await h.collector.collect();
  assert.deepEqual(failed.sources[1], { source: 'cron', state: 'failed', last_ok_at: '2026-11-26T01:00:00Z' });
  assert.equal(failed.tasks[0].next_run_at, '2026-11-27T03:00:00Z', 'next run recomputed from the kept crontab');
  h.crontab.result = new Error('spawn blew up');
  assert.equal((await h.collector.collect()).sources[1].state, 'failed');
  assert.equal(h.warns.length, 1);

  h.crontab.result = { state: 'not_installed' };
  const none = await h.collector.collect();
  assert.deepEqual(none.sources[1], { source: 'cron', state: 'not_installed', last_ok_at: null });
  assert.deepEqual(none.tasks, []);
});

test('readUserCrontab maps crontab -l outcomes', async () => {
  const run = (impl) => readUserCrontab({ execFile: impl });
  assert.deepEqual(await run(async (cmd, args) => {
    assert.equal(cmd, 'crontab');
    assert.deepEqual(args, ['-l']);
    return { stdout: '0 3 * * * x\n' };
  }), { state: 'ok', text: '0 3 * * * x\n' });
  assert.deepEqual(await run(async () => { throw Object.assign(new Error('spawn crontab ENOENT'), { code: 'ENOENT' }); }),
    { state: 'not_installed' });
  assert.deepEqual(await run(async () => { throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'no crontab for alice\n' }); }),
    { state: 'not_installed' });
  assert.deepEqual(await run(async () => { throw Object.assign(new Error('Command failed: crontab -l'), { code: 1, stderr: 'crontab: permission denied' }); }),
    { state: 'failed', error: 'Command failed: crontab -l' });
});

// ---- reporter cadence ----

const ORGS = new Map([
  ['primary', { org_id: 'org-1', self: { member_id: 'm-1' } }],
  ['second', { org_id: 'org-2', self: { member_id: 'm-2' } }],
]);
const apiPath = (p) => `/api/v1${p}`;

function snapshot(tag, lastOk = '2026-11-26T01:00:00Z') {
  return {
    sources: [{ source: 'scheduler', state: 'ok', last_ok_at: lastOk }, { source: 'cron', state: 'not_installed', last_ok_at: null }],
    tasks: [{ id: `scheduler-${tag}`, status: 'enabled', detail: { instruction: tag } }],
    truncated_count: 0,
  };
}

function reporterWith({ orgs = ORGS, put } = {}) {
  const clock = { t: NOW };
  const puts = [];
  const warns = [];
  const logs = [];
  const current = { body: snapshot('a'), collects: 0, throwOnCollect: null };
  const reporter = createTaskInventoryReporter(orgs, {
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    now: () => clock.t,
    apiPath,
    collector: {
      collect: async () => {
        current.collects += 1;
        if (current.throwOnCollect) throw current.throwOnCollect;
        return current.body;
      },
    },
    putForOrg: async (orgId, path, body, opts) => {
      puts.push({ orgId, path, body, opts, json: JSON.stringify(body) });
      if (put) await put(puts.length, body);
    },
  });
  return { reporter, clock, puts, warns, logs, current };
}

const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

test('reporter: PUTs the snapshot to the primary org only, with the log-safe options', async () => {
  const h = reporterWith();
  await h.reporter();
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0].orgId, 'org-1');
  assert.equal(h.puts[0].path, '/api/v1/agents/m-1/inventory/tasks');
  assert.deepEqual(h.puts[0].body, snapshot('a'));
  assert.deepEqual(h.puts[0].opts, { timeoutMs: 20_000, quietOnSuccess: true, quietStatuses: [429], sensitiveBody: true });
});

test('reporter: unchanged → nothing until the 5-minute heartbeat, which sends the current body (fresh last_ok_at)', async () => {
  const h = reporterWith();
  await h.reporter();
  // Same content, fresher last_ok_at: not a change.
  h.current.body = snapshot('a', '2026-11-26T01:01:00Z');
  for (let i = 1; i < 5; i++) {
    h.clock.t = NOW + i * 60_000;
    await h.reporter();
  }
  assert.equal(h.puts.length, 1);
  h.clock.t = NOW + HEARTBEAT_MS;
  await h.reporter();
  assert.equal(h.puts.length, 2);
  assert.deepEqual(h.puts[1].body, snapshot('a', '2026-11-26T01:01:00Z'), 'heartbeat = current body');
  assert.notEqual(h.puts[1].json, h.puts[0].json, 'the read time moved on');
  h.clock.t = NOW + HEARTBEAT_MS + 60_000;
  await h.reporter();
  assert.equal(h.puts.length, 2, 'the heartbeat restarts the 5 minutes');
});

test('reporter: a changed snapshot is sent on the next tick', async () => {
  const h = reporterWith();
  await h.reporter();
  h.clock.t = NOW + 60_000;
  h.current.body = snapshot('b');
  await h.reporter();
  assert.equal(h.puts.length, 2);
  assert.deepEqual(h.puts[1].body, snapshot('b'));
});

test('reporter: 429 → the change is sent again on the next tick', async () => {
  const h = reporterWith({ put: async (n) => { if (n === 2) throw httpError(429, 'AGENT_INVENTORY_RATE_LIMITED'); } });
  await h.reporter();
  h.clock.t = NOW + 10_000;
  h.current.body = snapshot('b');
  await h.reporter();
  h.clock.t = NOW + 70_000;
  await h.reporter();
  assert.equal(h.puts.length, 3);
  assert.deepEqual(h.puts[2].body, snapshot('b'));
  assert.deepEqual(h.warns, [], '429 is expected, not a warning');
  h.clock.t = NOW + 130_000;
  await h.reporter();
  assert.equal(h.puts.length, 3, 'accepted now');
});

test('reporter: 404 → warned once, then no reads or PUTs until restart', async () => {
  const h = reporterWith({ put: async () => { throw httpError(404); } });
  await h.reporter();
  for (let i = 1; i <= 10; i++) {
    h.clock.t = NOW + i * HEARTBEAT_MS;
    h.current.body = snapshot(`x${i}`);
    await h.reporter();
  }
  assert.equal(h.puts.length, 1);
  assert.equal(h.current.collects, 1);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /\[primary\] task inventory endpoint not available \(404\)/);
});

test('reporter: 5xx / network → warned once per streak, retried every tick, recovery logged', async () => {
  let fail = true;
  const h = reporterWith({ put: async () => { if (fail) throw httpError(502, 'Bad Gateway'); } });
  for (let i = 0; i < 3; i++) {
    h.clock.t = NOW + i * 60_000;
    await h.reporter();
  }
  assert.equal(h.puts.length, 3);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /task inventory report failed: Bad Gateway/);
  fail = false;
  h.clock.t = NOW + 3 * 60_000;
  await h.reporter();
  assert.equal(h.puts.length, 4);
  assert.equal(h.logs.length, 1);
  h.clock.t = NOW + 4 * 60_000;
  await h.reporter();
  assert.equal(h.puts.length, 4, 'accepted; nothing new to send');
});

test('reporter: a rejected body (422/413) is not re-sent before the heartbeat; a change is sent at once', async () => {
  const h = reporterWith({ put: async (n) => { if (n === 1) throw httpError(422, 'tasks[0].name too long'); } });
  await h.reporter();
  assert.match(h.warns[0], /rejected \(422\): tasks\[0\]\.name too long/);
  h.clock.t = NOW + 60_000;
  await h.reporter();
  assert.equal(h.puts.length, 1);
  h.clock.t = NOW + 120_000;
  h.current.body = snapshot('fixed');
  await h.reporter();
  assert.equal(h.puts.length, 2);
});

test('reporter: no active org / no member id → warned once, nothing collected', async () => {
  const none = reporterWith({ orgs: new Map() });
  await none.reporter();
  await none.reporter();
  assert.equal(none.current.collects, 0);
  assert.deepEqual(none.warns, ['no active org configured — task inventory not reported']);
  const noMember = reporterWith({ orgs: new Map([['p', { org_id: 'o', self: {} }]]) });
  await noMember.reporter();
  assert.match(noMember.warns[0], /\[p\] primary org has no self\.member_id/);
});

test('reporter: a new primary org gets the snapshot at once', async () => {
  const orgs = new Map([['primary', { org_id: 'org-1', self: { member_id: 'm-1' } }]]);
  const h = reporterWith({ orgs });
  await h.reporter();
  orgs.clear();
  orgs.set('other', { org_id: 'org-9', self: { member_id: 'm-9' } });
  h.clock.t = NOW + 60_000;
  await h.reporter();
  assert.equal(h.puts.length, 2);
  assert.equal(h.puts[1].path, '/api/v1/agents/m-9/inventory/tasks');
});

test('reporter: never throws, even when collecting fails', async () => {
  const h = reporterWith();
  h.current.throwOnCollect = new Error('boom');
  await assert.doesNotReject(h.reporter());
  assert.equal(h.puts.length, 0);
  assert.match(h.warns[0], /task inventory report failed: boom/);
});

test('end to end: collector + reporter on Dashboard fixtures; heartbeat body hash is stable', async () => {
  const state = { list: listBody([row('task-a')]) };
  const c = collectorWith(state);
  const puts = [];
  const reporter = createTaskInventoryReporter(ORGS, {
    log: noop, warn: noop, now: () => c.clock.t, apiPath, collector: c.collector,
    putForOrg: async (orgId, path, body) => { puts.push(body); },
  });
  await reporter();
  c.clock.t = NOW + 60_000;
  await reporter();
  assert.equal(puts.length, 1, 'only last_ok_at moved');
  c.clock.t = NOW + HEARTBEAT_MS;
  await reporter();
  assert.equal(puts.length, 2);
  assert.equal(snapshotHash(puts[1]), snapshotHash(puts[0]));
  assert.equal(puts[0].tasks[0].id, 'scheduler-task-a');
});

// --- scheduler database fallback (core 0.9.x: no /api/schedules) ---

const S = (ms) => Math.floor(ms / 1000);
function dbEntry(id, over = {}) {
  return {
    id, name: `DB ${id}`, prompt: `Prompt of ${id}`, type: 'recurring', status: 'pending', cron: '0 10 * * *',
    intervalSeconds: null, nextRunAt: S(NOW + H), lastRunAt: S(NOW - 23 * H), updatedAt: S(NOW - 23 * H),
    priority: 3, requireIdle: false, missThreshold: 300, showLastError: false, lastError: null,
    recent: [], nextRuns: { runs: [S(NOW + H), S(NOW + 25 * H)], in24h: [S(NOW + H)] },
    target: { kind: 'raw', text: 'lark' },
    reply: { channel: 'lark', endpoint: 'oc_abc|type:p2p' },
    timezone: 'Asia/Shanghai', createdAt: S(NOW - 30 * D),
    ...over,
  };
}
function dbResult(entries, { history = {}, allIds = entries.map((e) => e.id), unread = 0 } = {}) {
  return {
    state: 'ok',
    items: entries,
    details: new Map(entries.map((e) => [e.id, {
      prompt: e.prompt, history: history[e.id] ?? [], createdAt: e.createdAt, timezone: e.timezone,
    }])),
    allIds, tz: 'UTC', unread,
  };
}
const notFound = { list: () => res(404, { error: 'not_found' }) };

test('collector: Dashboard without /api/schedules (404) → scheduler database, reported ok with full details', async () => {
  const h = collectorWith({ ...notFound });
  h.db.result = dbResult([
    dbEntry('task-b'),
    dbEntry('task-a', { status: 'paused' }),
    dbEntry('task-old', { type: 'one-time', cron: null, status: 'completed', lastRunAt: S(NOW - 9 * D) }),
  ], {
    allIds: ['task-0', 'task-a', 'task-b', 'task-old'],
    unread: 7,
    history: { 'task-b': [{ id: 9, status: 'timeout', executedAt: S(NOW - 23 * H), completedAt: null, duration: null, error: 'Task timed out' }] },
  });
  const body = await h.collector.collect();
  assert.deepEqual(body.sources[0], { source: 'scheduler', state: 'ok', last_ok_at: '2026-11-26T01:00:00Z' });
  assert.deepEqual(h.calls, ['/api/schedules?limit=100&include=total'], 'no Dashboard detail reads');
  assert.deepEqual(body.tasks.map((t) => [t.id, t.local_no, t.status]), [
    ['scheduler-task-b', 3, 'attention'], ['scheduler-task-a', 2, 'paused'],
  ], 'old delivered one-time left out; local_no among all ids');
  const b = body.tasks[0];
  assert.equal(b.attention_reason, 'undeliverable');
  assert.equal(b.name, 'DB task-b');
  assert.deepEqual(b.schedule, { kind: 'cron', expr: '0 10 * * *', every_seconds: null, at: null, tz: 'Asia/Shanghai' });
  assert.equal(b.next_run_at, '2026-11-26T02:00:00Z');
  assert.deepEqual(b.detail.next_runs, ['2026-11-26T02:00:00Z', '2026-11-27T02:00:00Z']);
  assert.equal(b.detail.instruction, 'Prompt of task-b');
  assert.deepEqual(b.detail.runs, [{ at: '2026-11-25T02:00:00Z', result: 'timeout' }]);
  assert.equal(b.detail.last_error, 'Task timed out');
  assert.equal(b.detail.created_at, '2026-10-27T01:00:00Z');
  assert.deepEqual(b.target, { channel: 'lark', name: null, kind: 'dm' });
  assert.equal(body.truncated_count, 7);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /reading scheduler tasks from the scheduler database \(Dashboard: GET \/api\/schedules: http 404\)/);
  await h.collector.collect();
  assert.equal(h.warns.length, 1, 'noted once per streak');
});

test('collector: database fallback also when Dashboard reads are off, unreachable or tokenless', async () => {
  for (const failure of [{ quiet: true }, { throwAll: true }, { noToken: true }]) {
    const h = collectorWith({ list: listBody([]), ...failure });
    h.db.result = dbResult([dbEntry('task-a')]);
    const body = await h.collector.collect();
    assert.equal(body.sources[0].state, 'ok', JSON.stringify(failure));
    assert.deepEqual(body.tasks.map((t) => t.id), ['scheduler-task-a']);
    if (failure.quiet) assert.deepEqual(h.calls, [], 'no Dashboard read while reads are off');
  }
});

test('collector: database fallback without a database file → not_installed, tasks cleared', async () => {
  const h = collectorWith({ ...notFound });
  h.db.result = dbResult([dbEntry('task-a')]);
  assert.equal((await h.collector.collect()).tasks.length, 1);
  h.db.result = { state: 'not_installed' };
  const body = await h.collector.collect();
  assert.deepEqual(body.sources[0], { source: 'scheduler', state: 'not_installed', last_ok_at: null });
  assert.deepEqual(body.tasks, []);
});

test('collector: database fallback failing (or throwing) → failed, last good read kept, warned once', async () => {
  const h = collectorWith({ ...notFound });
  h.db.result = dbResult([dbEntry('task-a')]);
  const good = await h.collector.collect();
  h.clock.t = NOW + 60_000;
  h.db.result = { state: 'failed', error: 'no SQLite driver (ERR_UNKNOWN_BUILTIN_MODULE; MODULE_NOT_FOUND)' };
  const failed = await h.collector.collect();
  assert.deepEqual(failed.sources[0], { source: 'scheduler', state: 'failed', last_ok_at: '2026-11-26T01:00:00Z' });
  assert.deepEqual(failed.tasks, good.tasks);
  h.db.result = new Error('boom');
  assert.equal((await h.collector.collect()).sources[0].state, 'failed');
  assert.equal(h.warns.length, 2, 'the fallback note, then one failure warning for the streak');
  assert.match(h.warns[1], /Dashboard: GET \/api\/schedules: http 404; scheduler database: no SQLite driver/);
});

test('collector: a passing Dashboard failure read from the database keeps the Dashboard detail cache (core 1.0)', async () => {
  const items = [row('task-a'), row('task-b')];
  const state = { list: listBody(items) };
  const h = collectorWith(state);
  h.db.result = dbResult([dbEntry('task-a'), dbEntry('task-b')]);
  const first = await h.collector.collect();
  assert.equal(detailReads(h.calls).length, 4, 'detail + history of both tasks');
  state.list = () => res(503, {});
  assert.equal((await h.collector.collect()).sources[0].state, 'ok');
  assert.equal(h.db.calls, 1, 'that tick came from the database');
  state.list = listBody(items);
  h.calls.length = 0;
  const back = await h.collector.collect();
  assert.deepEqual(detailReads(h.calls), [], 'unchanged rows keep their cached details: no re-read');
  assert.deepEqual(back.tasks, first.tasks, 'the same full details as before the failed tick');
});

test('collector: the Dashboard is tried first every tick; when it serves the list again it is used', async () => {
  const state = { ...notFound };
  const h = collectorWith(state);
  h.db.result = dbResult([dbEntry('task-a')]);
  await h.collector.collect();
  await h.collector.collect();
  assert.equal(h.calls.filter((p) => p.startsWith('/api/schedules?')).length, 2);
  delete state.list;
  state.list = listBody([row('task-a')]);
  h.calls.length = 0;
  const body = await h.collector.collect();
  assert.equal(h.db.calls, 2, 'database not read once the Dashboard answers');
  assert.equal(body.tasks[0].detail.instruction, 'Full prompt of task-a. Token=[secret]');
  assert.deepEqual(detailReads(h.calls), ['/api/schedules/task-a', '/api/schedules/task-a/history?limit=30']);
  // A later Dashboard failure notes the fallback again.
  state.list = () => res(404, {});
  await h.collector.collect();
  assert.equal(h.warns.filter((w) => /from the scheduler database/.test(w)).length, 2);
});
