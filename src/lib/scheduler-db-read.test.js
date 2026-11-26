import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import {
  readSchedulerDatabase, createSchedulerDbReader, firstDriver, defaultDriverLoaders,
  schedulerTimeZone, schedulerDbPath, taskNextRuns, taskEntry, HISTORY_SQL,
} from './scheduler-db-read.js';
import { createTaskInventoryCollector } from './task-inventory-reporter.js';

const NOW = Date.parse('2026-11-26T01:00:00Z');
const NOW_S = NOW / 1000;
const H = 3600;
const D = 24 * H;
const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

// zylos core 0.9.2 scheduler schema (skills/scheduler/scripts/migrations.js).
const SCHEMA_092 = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, prompt TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('one-time', 'recurring', 'interval')),
    cron_expression TEXT, interval_seconds INTEGER, timezone TEXT DEFAULT 'UTC',
    next_run_at INTEGER NOT NULL, last_run_at INTEGER,
    priority INTEGER DEFAULT 3, status TEXT DEFAULT 'pending',
    require_idle INTEGER DEFAULT 0, miss_threshold INTEGER DEFAULT 300,
    reply_channel TEXT DEFAULT NULL, reply_endpoint TEXT DEFAULT NULL,
    retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
    created_at INTEGER, updated_at INTEGER, last_error TEXT, failed_at INTEGER
  );
  CREATE TABLE task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, executed_at INTEGER NOT NULL,
    completed_at INTEGER, status TEXT NOT NULL, duration_ms INTEGER, error TEXT
  );
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
  CREATE INDEX idx_next_run ON tasks(next_run_at) WHERE status = 'pending';
  CREATE INDEX idx_status_priority ON tasks(status, priority);
  CREATE INDEX idx_type ON tasks(type);
  CREATE INDEX idx_history_task ON task_history(task_id);
  CREATE INDEX idx_history_time ON task_history(executed_at);
`;

async function nodeSqlite(t) {
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function tmpZylos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scheduler'));
  return dir;
}

function task(over) {
  return {
    name: 'T', description: null, prompt: 'P', type: 'recurring', cron_expression: '0 10 * * *',
    interval_seconds: null, timezone: 'Asia/Shanghai', next_run_at: NOW_S + H, last_run_at: null,
    priority: 3, status: 'pending', require_idle: 0, miss_threshold: 300, reply_channel: null,
    reply_endpoint: null, retry_count: 0, max_retries: 3, created_at: NOW_S - 30 * D,
    updated_at: NOW_S - D, last_error: null, failed_at: null,
    ...over,
  };
}

function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
}

// A 0.9.2 database with one task of each kind the inventory distinguishes.
function fixture(DatabaseSync, zylosDir, { extraColumns = false } = {}) {
  const db = new DatabaseSync(schedulerDbPath(zylosDir));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_092);
  if (extraColumns) {
    db.exec('ALTER TABLE tasks ADD COLUMN session_component TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN session_group_name TEXT');
  }
  const rows = [
    task({ id: 'task-mwwvz2f8-daily', name: '测试-每日提醒', cron_expression: '30 9 * * *', next_run_at: NOW_S + 30 * 60,
      last_run_at: NOW_S - D + 30 * 60, reply_channel: 'lark', reply_endpoint: 'oc_x|type:p2p', last_error: 'send failed' }),
    task({ id: 'task-mwwvz2o2-hourly', type: 'interval', cron_expression: null, interval_seconds: H,
      next_run_at: NOW_S - 2.5 * H, timezone: 'UTC' }),
    task({ id: 'task-mwwvz343-once', type: 'one-time', cron_expression: null, next_run_at: NOW_S + 50 * 60 }),
    task({ id: 'task-mwwvz3cb-paused', status: 'paused', updated_at: NOW_S - 2 * H }),
    task({ id: 'task-mwwvz3cc-broken', status: 'failed', updated_at: NOW_S - 3 * H, last_error: 'bad cron' }),
    task({ id: 'task-mwwvz3cd-done', type: 'one-time', cron_expression: null, status: 'completed',
      next_run_at: NOW_S - D, last_run_at: NOW_S - D, updated_at: NOW_S - D }),
    task({ id: 'task-ms000000-ancient', type: 'one-time', cron_expression: null, status: 'completed',
      next_run_at: NOW_S - 9 * D, last_run_at: NOW_S - 9 * D, updated_at: NOW_S - 9 * D }),
    task({ id: 'task-mwwvz3ce-seconds', cron_expression: '0 30 9 * * *', next_run_at: NOW_S + 2 * H }),
  ];
  if (extraColumns) {
    rows.push(task({ id: 'task-mwwvz3cf-group', session_component: 'lark', session_group_name: 'group-oc_y',
      reply_channel: 'lark', reply_endpoint: 'oc_y', next_run_at: NOW_S + 3 * H }));
  }
  for (const r of rows) insert(db, 'tasks', r);
  // 35 runs of the daily task, newest failed: the read keeps 30, the list 12.
  for (let i = 35; i >= 1; i--) {
    const at = NOW_S - i * D + 30 * 60;
    insert(db, 'task_history', { task_id: 'task-mwwvz2f8-daily', executed_at: at, completed_at: at + 20,
      status: i === 1 ? 'failed' : 'success', duration_ms: null, error: i === 1 ? 'send failed' : null });
  }
  insert(db, 'task_history', { task_id: 'task-mwwvz2o2-hourly', executed_at: NOW_S - 3.5 * H,
    completed_at: NOW_S - 3.5 * H + 5, status: 'success', duration_ms: 5000, error: null });
  db.close();
}

// The production node:sqlite loader (the first of the default loaders).
const nodeSqliteOnly = () => defaultDriverLoaders('/unused')[0]();

test('readSchedulerDatabase: 0.9.2 database → Dashboard-shaped rows in the Dashboard order', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir);
  const out = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: nodeSqliteOnly, timeZone: () => 'Asia/Singapore' });
  assert.equal(out.state, 'ok', out.error);
  assert.equal(out.tz, 'Asia/Singapore');
  assert.equal(out.unread, 0);
  assert.equal(out.allIds.length, 8, 'every id, the ancient one too (local_no)');
  // enabled by next run (overdue interval first), then failed, paused, completed; ancient one-time left out
  assert.deepEqual(out.items.map((e) => e.id), [
    'task-mwwvz2o2-hourly', 'task-mwwvz2f8-daily', 'task-mwwvz343-once', 'task-mwwvz3ce-seconds',
    'task-mwwvz3cc-broken', 'task-mwwvz3cb-paused', 'task-mwwvz3cd-done',
  ]);

  const daily = out.items.find((e) => e.id === 'task-mwwvz2f8-daily');
  assert.equal(daily.name, '测试-每日提醒');
  assert.equal(daily.prompt, 'P');
  assert.equal(daily.cron, '30 9 * * *');
  assert.equal(daily.timezone, 'Asia/Shanghai');
  assert.equal(daily.createdAt, NOW_S - 30 * D);
  assert.equal(daily.requireIdle, false);
  assert.equal(daily.missThreshold, 300);
  assert.deepEqual(daily.nextRuns.runs.map(iso), [
    '2026-11-26T01:30:00Z', '2026-11-27T01:30:00Z', '2026-11-28T01:30:00Z', '2026-11-29T01:30:00Z', '2026-11-30T01:30:00Z',
  ], '09:30 Asia/Shanghai = 01:30Z');
  assert.deepEqual(daily.nextRuns.in24h.map(iso), ['2026-11-26T01:30:00Z']);
  assert.equal(daily.recent.length, 12);
  assert.equal(daily.recent.at(-1).status, 'failed', 'recent: oldest → newest');
  assert.equal(daily.recent.at(-1).duration, 20000, 'duration from completed - executed when not stored');
  assert.equal(daily.showLastError, true);
  assert.equal(daily.lastError, 'send failed');
  assert.deepEqual(daily.target, { kind: 'raw', text: 'lark' });
  assert.deepEqual(daily.reply, { channel: 'lark', endpoint: 'oc_x|type:p2p' });
  const detail = out.details.get('task-mwwvz2f8-daily');
  assert.equal(detail.history.length, 30);
  assert.equal(detail.history[0].status, 'failed', 'history: newest → oldest');
  assert.equal(detail.history[0].executedAt, NOW_S - D + 30 * 60);
  assert.equal(detail.prompt, 'P');
  assert.equal(detail.timezone, 'Asia/Shanghai');

  const hourly = out.items.find((e) => e.id === 'task-mwwvz2o2-hourly');
  assert.deepEqual(hourly.nextRuns.runs.map(iso), [
    '2026-11-26T01:30:00Z', '2026-11-26T02:30:00Z', '2026-11-26T03:30:00Z', '2026-11-26T04:30:00Z', '2026-11-26T05:30:00Z',
  ], 'overdue anchor advanced past now in whole steps');
  assert.equal(hourly.showLastError, false);
  assert.equal(hourly.lastError, null);
  assert.deepEqual(hourly.target, { kind: 'origin' });
  assert.equal(hourly.reply, null);
  assert.equal(out.details.get('task-mwwvz2o2-hourly').history[0].duration, 5000);

  assert.deepEqual(out.items.find((e) => e.id === 'task-mwwvz343-once').nextRuns.runs, [NOW_S + 50 * 60]);
  assert.deepEqual(out.items.find((e) => e.id === 'task-mwwvz3ce-seconds').nextRuns.runs, [NOW_S + 2 * H],
    'a rule our parser cannot read: the scheduler\'s own next run, not "unavailable"');
  for (const id of ['task-mwwvz3cb-paused', 'task-mwwvz3cc-broken', 'task-mwwvz3cd-done']) {
    assert.deepEqual(out.items.find((e) => e.id === id).nextRuns.runs, [], `${id}: not enabled, no next runs`);
  }
  assert.deepEqual(out.details.get('task-mwwvz343-once').history, []);
});

test('readSchedulerDatabase: core 1.0 columns (session_component / session_group_name) set the target', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir, { extraColumns: true });
  const out = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: nodeSqliteOnly, timeZone: () => 'UTC' });
  const group = out.items.find((e) => e.id === 'task-mwwvz3cf-group');
  assert.deepEqual(group.target, { kind: 'raw', text: 'lark:group-oc_y' });
  assert.deepEqual(group.reply, { channel: 'lark', endpoint: 'oc_y' });
});

test('readSchedulerDatabase: maxTasks keeps the first rows in list order, the rest counted as unread', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir);
  const out = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: nodeSqliteOnly, timeZone: () => 'UTC', maxTasks: 2 });
  assert.deepEqual(out.items.map((e) => e.id), ['task-mwwvz2o2-hourly', 'task-mwwvz2f8-daily']);
  assert.equal(out.unread, 5);
  assert.equal(out.details.get('task-mwwvz2f8-daily').history.length, 30, 'history of the kept rows');
  assert.equal(out.details.size, 2);
});

test('readSchedulerDatabase: read-only — writes refused, the file unchanged, closed after the read', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir);
  const file = schedulerDbPath(dir);
  const before = fs.readFileSync(file);
  let opened, refused = null;
  const spy = async () => {
    const d = await nodeSqliteOnly();
    return { open: (f) => {
      opened = d.open(f);
      try { opened.exec("UPDATE tasks SET name = 'x'"); } catch (err) { refused = err; }
      return opened;
    } };
  };
  assert.equal((await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: spy, timeZone: () => 'UTC' })).state, 'ok');
  assert.match(String(refused?.message), /readonly/i, 'opened read-only');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => opened.exec('SELECT 1'), 'closed after the read');
});

test('readSchedulerDatabase: history read per task through idx_history_task (LIMIT 30, newest by id, no sort), never a scan of the whole history', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir);
  const plan = new DatabaseSync(schedulerDbPath(dir), { readOnly: true });
  const steps = plan.prepare(`EXPLAIN QUERY PLAN ${HISTORY_SQL}`).all('task-x').map((r) => r.detail).join(' | ');
  plan.close();
  assert.match(steps, /USING INDEX idx_history_task \(task_id=\?\)/, steps);
  assert.doesNotMatch(steps, /^SCAN task_history|\| SCAN task_history/, steps);
  assert.doesNotMatch(steps, /TEMP B-TREE/, `no sort: newest first straight from the index (${steps})`);

  // Every task_history query the read runs is that one, once per listed task.
  const history = [];
  const spy = async () => {
    const d = await nodeSqliteOnly();
    return { open: (f) => {
      const db = d.open(f);
      const note = (sql, params, rows) => { if (/task_history/.test(sql)) history.push({ sql, params, rows: rows.length }); return rows; };
      return {
        ...db,
        all: (sql, ...params) => note(sql, params, db.all(sql, ...params)),
        prepare: (sql) => {
          const statement = db.prepare(sql);
          return { all: (...params) => note(sql, params, statement.all(...params)) };
        },
      };
    } };
  };
  const out = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: spy, timeZone: () => 'UTC' });
  assert.equal(out.state, 'ok');
  assert.ok(history.every((q) => q.sql === HISTORY_SQL), history.map((q) => q.sql).join('\n'));
  assert.deepEqual(history.map((q) => q.params[0]), out.items.map((it) => it.id));
  assert.equal(history.find((q) => q.params[0] === 'task-mwwvz2f8-daily').rows, 30, 'LIMIT 30 in SQL (the task has 35 runs)');
});

test('readSchedulerDatabase: no file → not_installed; no driver / not a database → failed; never throws', async (t) => {
  const dir = tmpZylos(t);
  let loads = 0;
  const out = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: async () => { loads += 1; } });
  assert.deepEqual(out, { state: 'not_installed' });
  assert.equal(loads, 0, 'no driver needed to see there is no database');

  fs.writeFileSync(schedulerDbPath(dir), 'not a database at all, just text that is long enough to have a header');
  const noDriver = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW,
    resolveDriver: () => firstDriver([async () => { throw Object.assign(new Error('x'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }); }]) });
  assert.deepEqual(noDriver, { state: 'failed', error: 'no SQLite driver (ERR_UNKNOWN_BUILTIN_MODULE)' });

  if (!(await nodeSqlite(t))) return;
  const garbage = await readSchedulerDatabase({ zylosDir: dir, nowMs: NOW, resolveDriver: nodeSqliteOnly, timeZone: () => 'UTC' });
  assert.equal(garbage.state, 'failed');
  assert.match(garbage.error, /not a database|file is not a database/i);
});

test('createSchedulerDbReader: resolves the driver once; a failed resolution is tried again', async () => {
  let attempts = 0;
  const driver = { open: () => ({ exec() {}, all: () => [], close() {} }) };
  const reader = createSchedulerDbReader({
    zylosDir: '/nowhere', exists: () => true, timeZone: () => 'UTC',
    loaders: [async () => { attempts += 1; if (attempts === 1) throw new Error('first'); return driver; }],
  });
  assert.equal((await reader(NOW)).state, 'failed');
  assert.equal((await reader(NOW)).state, 'ok');
  assert.equal((await reader(NOW)).state, 'ok');
  assert.equal(attempts, 2);
});

test('firstDriver / defaultDriverLoaders: node:sqlite, then better-sqlite3 from comm-bridge, then scheduler', async (t) => {
  const order = [];
  const d = await firstDriver([
    async () => { order.push(1); throw new Error('a'); },
    async () => { order.push(2); return 'second'; },
    async () => { order.push(3); return 'third'; },
  ]);
  assert.equal(d, 'second');
  assert.deepEqual(order, [1, 2]);
  await assert.rejects(firstDriver([async () => { throw new Error('a'); }, async () => { throw Object.assign(new Error('b'), { code: 'MODULE_NOT_FOUND' }); }]),
    /no SQLite driver \(a; MODULE_NOT_FOUND\)/);

  const dir = tmpZylos(t);
  const loaders = defaultDriverLoaders(dir);
  assert.equal(loaders.length, 3);
  for (const skill of [1, 2]) {
    await assert.rejects(loaders[skill](), (err) => err.code === 'MODULE_NOT_FOUND', 'no better-sqlite3 in an empty zylos dir');
  }
  if (await nodeSqlite(t)) assert.equal((await loaders[0]()).name, 'node:sqlite');
});

test('defaultDriverLoaders: better-sqlite3 opened read-only, file must exist; comm-bridge copy before scheduler copy', async (t) => {
  const dir = tmpZylos(t);
  // A stand-in better-sqlite3 in each skill dir that records how it is opened.
  for (const skill of ['comm-bridge', 'scheduler']) {
    const pkg = path.join(dir, '.claude', 'skills', skill, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), `
      class FakeDatabase {
        constructor(file, opts) { FakeDatabase.calls.push({ skill: ${JSON.stringify(skill)}, file, opts }); }
        exec() {}
        prepare() { return { all: () => [] }; }
        close() {}
      }
      FakeDatabase.calls = [];
      module.exports = FakeDatabase;
    `);
  }
  const calls = (skill) => createRequire(path.join(dir, '.claude', 'skills', skill, 'package.json'))('better-sqlite3').calls;
  const [, commBridge, scheduler] = defaultDriverLoaders(dir);
  for (const [load, skill] of [[commBridge, 'comm-bridge'], [scheduler, 'scheduler']]) {
    const driver = await load();
    assert.equal(driver.name, `better-sqlite3 from ${skill}`);
    driver.open('/z/scheduler/scheduler.db').close();
    assert.deepEqual(calls(skill), [{ skill, file: '/z/scheduler/scheduler.db', opts: { readonly: true, fileMustExist: true } }]);
  }
  const d = await firstDriver([async () => { throw new Error('no node:sqlite'); }, commBridge, scheduler]);
  assert.equal(d.name, 'better-sqlite3 from comm-bridge');
});

test('schedulerTimeZone: last TZ= in .env (quotes, export, comment), else $TZ, else UTC', (t) => {
  const dir = tmpZylos(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'TZ=Europe/Paris\nFOO=1\nexport TZ="Asia/Singapore" # agent zone\n');
  assert.equal(schedulerTimeZone(dir, { env: { TZ: 'America/New_York' } }), 'Asia/Singapore');
  fs.writeFileSync(env, 'TZ=Not/AZone\n');
  assert.equal(schedulerTimeZone(dir, { env: { TZ: 'America/New_York' } }), 'America/New_York');
  fs.rmSync(env);
  assert.equal(schedulerTimeZone(dir, { env: { TZ: 'America/New_York' } }), 'America/New_York');
  assert.equal(schedulerTimeZone(dir, { env: {} }), 'UTC');
  assert.equal(schedulerTimeZone(dir, { env: { TZ: 'bogus' } }), 'UTC');
});

test('taskNextRuns: recurring in the task zone, else the scheduler zone; interval and one-time edge cases', () => {
  const base = { status: 'pending', next_run_at: NOW_S + H };
  assert.deepEqual(taskNextRuns({ ...base, type: 'recurring', cron_expression: '0 9 * * *', timezone: 'Asia/Shanghai' }, NOW_S, 'UTC', 2).map(iso),
    ['2026-11-27T01:00:00Z', '2026-11-28T01:00:00Z'], 'the task zone wins over the scheduler zone (09:00 Shanghai = 01:00Z; now is 01:00Z, not after now)');
  assert.deepEqual(taskNextRuns({ ...base, type: 'recurring', cron_expression: '0 9 * * *', timezone: 'bogus' }, NOW_S, 'Asia/Tokyo', 2).map(iso),
    ['2026-11-27T00:00:00Z', '2026-11-28T00:00:00Z'], 'invalid task zone → scheduler zone');
  assert.deepEqual(taskNextRuns({ ...base, type: 'recurring', cron_expression: '0 9 * * *', timezone: null }, NOW_S, 'UTC', 1).map(iso),
    ['2026-11-26T09:00:00Z']);
  assert.deepEqual(taskNextRuns({ ...base, type: 'recurring', cron_expression: '@reboot' }, NOW_S, 'UTC'), [NOW_S + H]);
  assert.deepEqual(taskNextRuns({ ...base, type: 'recurring', cron_expression: 'nonsense', next_run_at: NOW_S - 1 }, NOW_S, 'UTC'), []);
  assert.deepEqual(taskNextRuns({ ...base, type: 'interval', interval_seconds: 600, next_run_at: NOW_S + 60 }, NOW_S, 'UTC', 3),
    [NOW_S + 60, NOW_S + 660, NOW_S + 1260], 'future anchor kept');
  assert.deepEqual(taskNextRuns({ ...base, type: 'interval', interval_seconds: 600, next_run_at: NOW_S }, NOW_S, 'UTC', 1),
    [NOW_S + 600], 'an anchor at now is not after now');
  assert.deepEqual(taskNextRuns({ ...base, type: 'interval', interval_seconds: 0 }, NOW_S, 'UTC'), []);
  assert.deepEqual(taskNextRuns({ ...base, type: 'interval', interval_seconds: 60, next_run_at: null }, NOW_S, 'UTC'), []);
  assert.deepEqual(taskNextRuns({ ...base, type: 'one-time', next_run_at: NOW_S }, NOW_S, 'UTC'), []);
  assert.deepEqual(taskNextRuns({ ...base, type: 'one-time', status: 'running' }, NOW_S, 'UTC'), [NOW_S + H]);
  assert.deepEqual(taskNextRuns({ ...base, type: 'one-time', status: 'paused' }, NOW_S, 'UTC'), []);
});

test('taskEntry: lastError only while the newest run failed (like the Dashboard)', () => {
  const row = { id: 'task-x', type: 'interval', status: 'pending', interval_seconds: 60, next_run_at: NOW_S + 10, last_error: 'old' };
  const ok = taskEntry(row, [{ id: 2, status: 'success', executed_at: NOW_S - 60 }, { id: 1, status: 'failed', executed_at: NOW_S - 120 }], NOW_S, 'UTC');
  assert.equal(ok.entry.showLastError, false);
  assert.equal(ok.entry.lastError, null);
  const timedOut = taskEntry(row, [{ id: 3, status: 'timeout', executed_at: NOW_S - 30 }], NOW_S, 'UTC');
  assert.equal(timedOut.entry.lastError, null, 'a timeout keeps its reason on the run row');
  const bad = taskEntry(row, [{ id: 3, status: 'failed', executed_at: NOW_S - 30 }], NOW_S, 'UTC');
  assert.equal(bad.entry.lastError, 'old');
  assert.equal(taskEntry(row, [], NOW_S, 'UTC').entry.lastError, null);
});

test('end to end: 0.9.x Agent (Dashboard 404) — collector reports the database tasks', async (t) => {
  const DatabaseSync = await nodeSqlite(t);
  if (!DatabaseSync) return;
  const dir = tmpZylos(t);
  fixture(DatabaseSync, dir);
  fs.writeFileSync(path.join(dir, '.env'), 'TZ=Etc/UTC\n');
  const warns = [];
  const collector = createTaskInventoryCollector({
    dashboardClient: { isQuiet: () => false, get: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
    warn: (m) => warns.push(m),
    now: () => NOW,
    getDashboardPort: () => 3470,
    readCrontab: async () => ({ state: 'not_installed' }),
    readSchedulerDb: createSchedulerDbReader({ zylosDir: dir }),
    cronTimeZone: () => 'UTC',
    home: '/home/alice',
  });
  const body = await collector.collect();
  assert.equal(body.sources[0].state, 'ok', warns.join('\n'));
  const byId = new Map(body.tasks.map((x) => [x.id, x]));
  assert.deepEqual([...byId.keys()], [
    'scheduler-task-mwwvz2o2-hourly', 'scheduler-task-mwwvz2f8-daily', 'scheduler-task-mwwvz3cc-broken',
    'scheduler-task-mwwvz343-once', 'scheduler-task-mwwvz3ce-seconds', 'scheduler-task-mwwvz3cb-paused',
    'scheduler-task-mwwvz3cd-done',
  ], 'attention (in list order) first, then enabled, paused, delivered; the 9-day-old one-time is not reported');
  const daily = byId.get('scheduler-task-mwwvz2f8-daily');
  assert.equal(daily.status, 'attention');
  assert.equal(daily.attention_reason, 'undeliverable');
  assert.equal(daily.name, '测试-每日提醒');
  assert.deepEqual(daily.schedule, { kind: 'cron', expr: '30 9 * * *', every_seconds: null, at: null, tz: 'Asia/Shanghai' });
  assert.equal(daily.next_run_at, '2026-11-26T01:30:00Z');
  assert.equal(daily.detail.runs.length, 30);
  assert.equal(daily.recent_deliveries.length, 30);
  assert.equal(daily.recent_deliveries.at(-1), 'failed');
  assert.equal(daily.last_delivered_at, '2026-11-24T01:30:20Z');
  assert.equal(daily.detail.last_error, 'send failed');
  assert.deepEqual(daily.target, { channel: 'lark', name: null, kind: 'dm' });
  assert.equal(daily.local_no, 2);
  const hourly = byId.get('scheduler-task-mwwvz2o2-hourly');
  assert.equal(hourly.attention_reason, 'missed', 'pending 2.5 h past its run time: the scheduler is not dispatching');
  assert.equal(hourly.schedule.every_seconds, 3600);
  assert.equal(hourly.next_run_at, '2026-11-25T22:30:00Z', 'the scheduler\'s own next_run_at');
  assert.equal(hourly.detail.next_runs[0], '2026-11-26T01:30:00Z');
  assert.equal(byId.get('scheduler-task-mwwvz3ce-seconds').status, 'enabled', 'not a false "unparsable"');
  assert.deepEqual(byId.get('scheduler-task-mwwvz3cc-broken').attention_reason, 'unparsable');
  assert.equal(byId.get('scheduler-task-mwwvz3cb-paused').status, 'paused');
  assert.equal(byId.get('scheduler-task-mwwvz3cd-done').status, 'delivered');
  assert.equal(byId.get('scheduler-task-mwwvz343-once').schedule.at, '2026-11-26T01:50:00Z');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /reading scheduler tasks from the scheduler database/);
});
