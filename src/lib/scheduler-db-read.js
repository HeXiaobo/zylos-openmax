/**
 * Scheduler tasks read straight from the zylos scheduler's own database
 * (`<zylos>/scheduler/scheduler.db`), for the task inventory when the local
 * Dashboard cannot serve them (task-inventory-reporter.js).
 *
 * Why: zylos core 0.9.x ships the scheduler, but its Dashboard (component
 * 0.6.x) has no `/api/schedules`; only the Dashboard built into core 1.0
 * serves one. Without this fallback a 0.9.x Agent reports `scheduler: failed`
 * and only its crontab. The scheduler and this plugin run as the same user on
 * the same machine, so the plugin reads the file the 1.0 Dashboard reads
 * (core 1.0 `dashboard/src/lib/workbench/schedule-read.js`), the same way.
 *
 * The result is shaped like the Dashboard's answers, so task-inventory.js maps
 * both paths with the same code:
 *   items    list rows: {id, name, prompt, type, status, cron, intervalSeconds,
 *            nextRunAt, lastRunAt, updatedAt (epoch seconds, as stored),
 *            priority, requireIdle, missThreshold, showLastError, lastError,
 *            recent (≤ 12 runs, oldest → newest), nextRuns {runs, in24h},
 *            target, reply, timezone, createdAt}
 *   details  Map id → {prompt, history (≤ 30 runs, newest → oldest),
 *            createdAt, timezone}: what the Dashboard path gets from
 *            `/api/schedules/:id` + `/history?limit=30`
 *   allIds   every task id (local_no is the place among all of them)
 *   tz       the scheduler's default zone, as the scheduler resolves it:
 *            `TZ=` in `<zylos>/.env`, else `$TZ`, else UTC
 *   unread   tasks left out by `maxTasks`
 * Like the Dashboard, the list is ordered enabled (by next run) → failed →
 * paused → completed (latest change first); one-time tasks completed more than
 * 7 days ago are left out in SQL (the inventory never reports them).
 *
 * Next runs (only for pending/running tasks, strictly after now, at most 5):
 *   recurring  the cron rule in the task's own zone (the zone the 0.9 scheduler
 *              uses: `task.timezone`, else the scheduler's), via cron-expr.js;
 *              a rule our parser cannot read (cron-parser accepts more, e.g. a
 *              seconds field) gets only the scheduler's own `next_run_at` —
 *              never a false "unparsable": a rule the scheduler cannot
 *              evaluate makes it mark the task failed, and that is mapped;
 *   interval   the series from `next_run_at`, advanced past now (as the
 *              Dashboard does);
 *   one-time   `next_run_at`.
 * Delivery target: the Dashboard's rule without its session snapshot
 * (`session_component ?? reply_channel`; `origin` when neither), so a group
 * has no display name on this path.
 *
 * Safety:
 *   - opened read-only (file must exist), busy timeout 3 s, every query in one
 *     read transaction (one consistent snapshot while tasks run);
 *   - open → read → close is synchronous, so this process never has two
 *     connections to the file open at once (two SQLite copies in one process
 *     closing connections to one file can drop each other's POSIX locks — see
 *     core 1.0 `comm-bridge/scripts/sqlite-driver.js`);
 *   - driver: Node's built-in `node:sqlite` (Node ≥ 22.13), else the
 *     better-sqlite3 zylos installed for itself (comm-bridge skill, then
 *     scheduler skill) — never a dependency of this plugin;
 *   - `SELECT *`, so core 1.0's extra columns (`session_component`,
 *     `session_group_name`) are used when present and nothing breaks without
 *     them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { parseCron, nextCronRuns, isValidTimeZone } from './cron-expr.js';
import { DELIVERED_WINDOW_MS } from './task-inventory.js';

const ENABLED = new Set(['pending', 'running']);
const NEXT_RUNS = 5;
const RECENT_RUNS = 12;
const HISTORY_RUNS = 30;
const DAY_S = 86_400;
const BUSY_TIMEOUT_MS = 3000;

// The Dashboard's list order (schedule-read.js SECTION_RANK / SECTION_KEY).
const SECTION_RANK = "CASE WHEN status IN ('pending', 'running') THEN 0 WHEN status = 'failed' THEN 1 WHEN status = 'paused' THEN 2 ELSE 3 END";
const SECTION_KEY = 'CASE WHEN status IN (\'pending\', \'running\') THEN COALESCE(next_run_at, 0) ELSE -COALESCE(updated_at, 0) END';
// Left out: one-time tasks completed before the delivered window (bound: its
// start, epoch seconds), or with no time at all — schedulerStatus drops both.
const KEEP = `NOT (type = 'one-time' AND status = 'completed'
  AND (COALESCE(last_run_at, updated_at) IS NULL OR COALESCE(last_run_at, updated_at) < ?))`;
// The last runs of one task, newest first: one query per task (like the
// Dashboard's list read) through the scheduler's idx_history_task index.
// Newest = highest id: the scheduler inserts every run with executed_at = now()
// (0.9.x daemon.js, 1.0 daemon-dispatch.js) into an AUTOINCREMENT table, so id
// order is executed_at order unless the clock steps back (the Dashboard sorts
// by executed_at DESC, id DESC). The index holds (task_id, id), so this needs
// no sort however long a task's history is.
export const HISTORY_SQL = `SELECT id, task_id, status, executed_at, completed_at, duration_ms, error
  FROM task_history WHERE task_id = ? ORDER BY id DESC LIMIT ${HISTORY_RUNS}`;

/** The agent's zylos directory, resolved as the scheduler resolves it. */
export function defaultZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

/** `<zylos>/scheduler/scheduler.db`. */
export function schedulerDbPath(zylosDir) {
  return path.join(zylosDir, 'scheduler', 'scheduler.db');
}

/**
 * The scheduler's default zone, resolved like the 0.9 scheduler's tz.js: the
 * last `TZ=` in `<zylos>/.env`, else `$TZ`, else UTC. An invalid value falls
 * through to the next (the scheduler refuses to start on one, so it does not
 * occur on a running scheduler).
 */
export function schedulerTimeZone(zylosDir, { readFile = fs.readFileSync, env = process.env } = {}) {
  try {
    let found = '';
    for (const line of String(readFile(path.join(zylosDir, '.env'), 'utf8')).split('\n')) {
      const m = /^\s*(?:export\s+)?TZ\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[1].split('#')[0].trim().replace(/^["']|["']$/g, '');
      if (value) found = value;
    }
    if (isValidTimeZone(found)) return found;
  } catch { /* no .env: the process environment decides */ }
  const z = String(env.TZ ?? '').trim();
  return isValidTimeZone(z) ? z : 'UTC';
}

// --- drivers ---------------------------------------------------------------

function wrap(db) {
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return { all: (...params) => statement.all(...params) };
    },
    close: () => db.close(),
  };
}

async function loadNodeSqlite() {
  const { DatabaseSync } = await import('node:sqlite'); // Node >= 22.13 (unflagged)
  return { name: 'node:sqlite', open: (file) => wrap(new DatabaseSync(file, { readOnly: true })) };
}

function loadBetterSqlite(skillDir) {
  const Database = createRequire(path.join(skillDir, 'package.json'))('better-sqlite3');
  return {
    name: `better-sqlite3 from ${path.basename(skillDir)}`,
    open: (file) => wrap(new Database(file, { readonly: true, fileMustExist: true })),
  };
}

/** Driver loaders in order of preference. */
export function defaultDriverLoaders(zylosDir) {
  const skills = path.join(zylosDir, '.claude', 'skills');
  return [
    loadNodeSqlite,
    async () => loadBetterSqlite(path.join(skills, 'comm-bridge')),
    async () => loadBetterSqlite(path.join(skills, 'scheduler')),
  ];
}

/** The first driver whose loader works; throws with every loader's error. */
export async function firstDriver(loaders) {
  const errors = [];
  for (const load of loaders) {
    try {
      return await load();
    } catch (err) {
      errors.push(err?.code || err?.message || String(err));
    }
  }
  throw new Error(`no SQLite driver (${errors.join('; ')})`);
}

/**
 * A reader that resolves its driver once (the first loader that works; a
 * failed resolution is tried again on the next read).
 * @returns {(nowMs: number) => Promise<object>} see readSchedulerDatabase
 */
export function createSchedulerDbReader({
  zylosDir = defaultZylosDir(),
  loaders = defaultDriverLoaders(zylosDir),
  ...opts
} = {}) {
  let driver = null;
  const resolveDriver = async () => (driver ??= await firstDriver(loaders));
  return (nowMs) => readSchedulerDatabase({ zylosDir, nowMs, resolveDriver, ...opts });
}

// --- mapping ---------------------------------------------------------------

function historyRow(row) {
  const duration = row.duration_ms ?? (row.completed_at != null && row.executed_at != null
    ? (row.completed_at - row.executed_at) * 1000 : null);
  return {
    id: row.id,
    status: row.status,
    executedAt: row.executed_at ?? null,
    completedAt: row.completed_at ?? null,
    duration,
    error: row.error ?? null,
  };
}

function deliveryTarget(task) {
  const component = task.session_component ?? task.reply_channel ?? null;
  const name = task.session_component != null ? task.session_group_name ?? null : null;
  const reply = task.reply_channel ? { channel: task.reply_channel, endpoint: task.reply_endpoint ?? null } : null;
  if (component === null) return { target: { kind: 'origin' }, reply };
  return { target: { kind: 'raw', text: name === null ? component : `${component}:${name}` }, reply };
}

/**
 * Upcoming runs of one task row, epoch seconds, strictly after `nowSec`.
 * @returns {number[]}
 */
export function taskNextRuns(task, nowSec, schedulerTz, n = NEXT_RUNS) {
  if (!ENABLED.has(task.status)) return [];
  const next = Number.isFinite(task.next_run_at) ? task.next_run_at : null;
  if (task.type === 'recurring') {
    const spec = parseCron(task.cron_expression);
    if (!spec.ok || spec.reboot) return next !== null && next > nowSec ? [next] : [];
    const tz = isValidTimeZone(task.timezone) ? task.timezone : schedulerTz;
    return nextCronRuns(spec, nowSec * 1000, tz, n).map((ms) => Math.floor(ms / 1000));
  }
  if (task.type === 'interval') {
    const step = task.interval_seconds;
    if (!(step > 0) || next === null) return [];
    const start = next > nowSec ? next : next + (Math.floor((nowSec - next) / step) + 1) * step;
    return Array.from({ length: n }, (_, k) => start + k * step);
  }
  return next !== null && next > nowSec ? [next] : [];
}

/**
 * Dashboard-shaped list row + detail of one task row.
 * @param {object} task     `tasks` row
 * @param {object[]} runs   its `task_history` rows, newest → oldest
 */
export function taskEntry(task, runs, nowSec, schedulerTz) {
  const history = runs.map(historyRow);
  const latest = history[0];
  const showLastError = Boolean(latest && latest.status === 'failed');
  const upcoming = taskNextRuns(task, nowSec, schedulerTz);
  const { target, reply } = deliveryTarget(task);
  const entry = {
    id: task.id,
    name: task.name ?? null,
    prompt: task.prompt ?? null,
    type: task.type,
    status: task.status,
    cron: task.cron_expression ?? null,
    intervalSeconds: task.interval_seconds ?? null,
    nextRunAt: task.next_run_at ?? null,
    lastRunAt: task.last_run_at ?? null,
    updatedAt: task.updated_at ?? null,
    priority: task.priority ?? null,
    requireIdle: Boolean(task.require_idle),
    missThreshold: task.miss_threshold ?? null,
    showLastError,
    lastError: showLastError ? task.last_error ?? null : null,
    recent: history.slice(0, RECENT_RUNS).reverse(),
    nextRuns: { runs: upcoming, in24h: upcoming.filter((t) => t <= nowSec + DAY_S) },
    target,
    reply,
    timezone: task.timezone ?? null,
    createdAt: task.created_at ?? null,
  };
  const detail = {
    prompt: task.prompt ?? null,
    history: history.slice(0, HISTORY_RUNS),
    createdAt: task.created_at ?? null,
    timezone: task.timezone ?? null,
  };
  return { entry, detail };
}

// --- read ------------------------------------------------------------------

/**
 * One read of the scheduler database.
 * @returns {Promise<
 *   {state: 'ok', items: object[], details: Map<string, object>, allIds: string[], tz: string, unread: number} |
 *   {state: 'not_installed'} |
 *   {state: 'failed', error: string}>}
 *   `not_installed`: no database file (the Dashboard's `available: false`).
 *   Never throws.
 */
export async function readSchedulerDatabase({
  zylosDir = defaultZylosDir(),
  nowMs = Date.now(),
  resolveDriver = () => firstDriver(defaultDriverLoaders(zylosDir)),
  exists = fs.existsSync,
  timeZone = () => schedulerTimeZone(zylosDir),
  maxTasks = 1000,
} = {}) {
  const file = schedulerDbPath(zylosDir);
  try {
    if (!exists(file)) return { state: 'not_installed' };
    const driver = await resolveDriver();
    const nowSec = Math.floor(nowMs / 1000);
    const keepFrom = (nowMs - DELIVERED_WINDOW_MS) / 1000;
    let ids, tasks, total;
    const byTask = new Map();
    // Synchronous from here to close (see Safety above).
    const db = driver.open(file);
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('BEGIN');
      try {
        ids = db.all('SELECT id FROM tasks').map((r) => r.id).filter((id) => typeof id === 'string' && id);
        const page = `SELECT * FROM tasks WHERE ${KEEP}
          ORDER BY ${SECTION_RANK}, ${SECTION_KEY}, id LIMIT ?`;
        tasks = db.all(page, keepFrom, maxTasks);
        total = db.all(`SELECT count(*) AS count FROM tasks WHERE ${KEEP}`, keepFrom)[0]?.count ?? tasks.length;
        if (tasks.length > 0) {
          const history = db.prepare(HISTORY_SQL);
          for (const task of tasks) byTask.set(task.id, history.all(task.id));
        }
      } finally {
        db.exec('COMMIT');
      }
    } finally {
      db.close();
    }
    const tz = timeZone();
    const items = [];
    const details = new Map();
    for (const task of tasks) {
      if (typeof task.id !== 'string' || !task.id) continue;
      const { entry, detail } = taskEntry(task, byTask.get(task.id) ?? [], nowSec, tz);
      items.push(entry);
      details.set(task.id, detail);
    }
    return { state: 'ok', items, details, allIds: ids, tz, unread: Math.max(0, Number(total) - tasks.length) };
  } catch (err) {
    return { state: 'failed', error: err?.message || String(err) };
  }
}
