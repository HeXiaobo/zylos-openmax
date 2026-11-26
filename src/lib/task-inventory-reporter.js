/**
 * Scheduled-task inventory reporter — collects this machine's scheduled tasks
 * (zylos scheduler via the local Dashboard or, when the Dashboard cannot serve
 * them, the scheduler's database; plus the user crontab) and PUTs
 * the snapshot to cws-core
 * (`PUT /api/v1/agents/{member_id}/inventory/tasks`), so the Agent's owner
 * sees them on the Agent's page in Workspace. Driven by the comm-bridge task
 * registry (~60 s tick, like runtime-metrics). Snapshot shape and mapping:
 * task-inventory.js.
 *
 * Collector (createTaskInventoryCollector), per tick:
 *   - `GET /api/schedules?limit=100&include=total` (all pages, at most
 *     `maxListPages`; tasks beyond are counted in `truncated_count`), through
 *     the shared Dashboard client (dashboard-client.js: read key → session
 *     token, the same as runtime-metrics). `{available:false}` = no scheduler
 *     database → source `not_installed`.
 *   - For a reported task whose list row changed since the last read (hash of
 *     the row without `nextRuns`, which moves with the clock), and only then:
 *     `GET /api/schedules/:id` (full prompt) and
 *     `GET /api/schedules/:id/history?limit=30` (runs). At most
 *     `maxDetailReadsPerTick` per tick; the rest keep their cached detail (or
 *     the list's prompt summary and last 12 runs) and are read next tick. The
 *     first failing detail read stops the detail reads for this tick.
 *   - When the list cannot be read (core 0.9.x: its Dashboard has no
 *     `/api/schedules` → 404; also no Dashboard, no session token, reads
 *     turned off after an API-key failure, a timeout): the scheduler's own
 *     database, read-only (scheduler-db-read.js: the same data file and list
 *     order as the core 1.0 Dashboard, all details in one read; the
 *     Dashboard's detail cache is kept, not used). A
 *     readable database → `ok` (noted once per streak); no database file →
 *     `not_installed`; unreadable too → `failed`. The Dashboard is tried
 *     first on every tick, so an upgrade to core 1.0 switches back by itself.
 *   - `crontab -l`: "no crontab" or no `crontab` command → `not_installed`;
 *     any other failure → `failed`.
 *   A source whose read fails is reported `failed` with its previous
 *   `last_ok_at`, and keeps the tasks of its last good read.
 *
 * Reporter (createTaskInventoryReporter): PRIMARY org only (selectPrimaryOrg,
 * the org runtime-metrics goes to). The body is sent when its hash
 * (snapshotHash: without `last_ok_at`) differs from the last accepted one;
 * otherwise the current body is sent every 5 minutes as a heartbeat. Only its
 * `sources[].last_ok_at` can differ from the last one, and the server's content
 * hash leaves read times out too, so a heartbeat is never rate-limited; it
 * keeps the page's "last successful read" current.
 *   429 (a changed snapshot < 30 s after the previous change) → sent again on
 *       the next tick;
 *   404 (route not deployed on this server) → warned once, then nothing more
 *       is read or sent until the process restarts (like runtime-metrics);
 *   other 4xx → warned, the same body is not re-sent before the heartbeat
 *       interval (a changed snapshot is sent at once);
 *   5xx / network / timeout → warned once per failure streak, retried next tick.
 * The tick never throws, and has its own task in the registry, so it cannot
 * delay or break the runtime-metrics report. Request and response bodies are
 * kept out of the [rpc] log (`sensitiveBody`): the snapshot is up to ~2 MB.
 *
 * Deps are injected so the logic is unit-testable without a Dashboard, a
 * scheduler database, a crontab or cws-core (see
 * task-inventory-reporter.test.js).
 */

import os from 'os';
import crypto from 'crypto';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { selectPrimaryOrg, REPORT_REQUEST_TIMEOUT_MS } from './metrics-reporter.js';
import { getDashboardPort as realGetDashboardPort } from './dashboard-address.js';
import { systemTimeZone } from './cron-expr.js';
import { createSchedulerDbReader } from './scheduler-db-read.js';
import {
  buildSchedulerTask, buildCronTasks, buildSnapshot, snapshotHash, schedulerStatus, toIso,
} from './task-inventory.js';

export const HEARTBEAT_MS = 5 * 60 * 1000;
const LIST_PAGE_LIMIT = 100;
const HISTORY_LIMIT = 30;
const CRONTAB_TIMEOUT_MS = 5000;

const execFileP = promisify(execFileCb);

/**
 * `crontab -l` → `{state: 'ok', text}` | `{state: 'not_installed'}` |
 * `{state: 'failed', error}`.
 */
export async function readUserCrontab({ execFile = execFileP } = {}) {
  try {
    const { stdout } = await execFile('crontab', ['-l'], {
      timeout: CRONTAB_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    });
    return { state: 'ok', text: String(stdout ?? '') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'not_installed' };
    if (/no crontab for/i.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) return { state: 'not_installed' };
    return { state: 'failed', error: err?.message || String(err) };
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Hash of a list row without `nextRuns` (its 24-hour window moves every
// minute): a changed hash means the row's task or its runs changed.
function rowHash(entry) {
  const { nextRuns, ...rest } = entry;
  return sha256(JSON.stringify(rest));
}

/**
 * @returns {{collect: () => Promise<object>}} `collect()` returns the report body
 *   (`{sources, tasks, truncated_count}`); it never throws for a source failure.
 */
export function createTaskInventoryCollector({
  dashboardClient,
  warn = () => {},
  now = Date.now,
  getDashboardPort = realGetDashboardPort,
  readCrontab = () => readUserCrontab(),
  readSchedulerDb = createSchedulerDbReader(),
  cronTimeZone = () => systemTimeZone(),
  home = os.homedir(),
  maxListPages = 10,
  maxDetailReadsPerTick = 40,
} = {}) {
  if (!dashboardClient) throw new Error('task inventory: dashboardClient is required');

  const detailCache = new Map(); // task id → { hash, prompt, history, createdAt, timezone }
  const scheduler = { tasks: [], truncated: 0, lastOkAt: null, warned: false };
  const details = { warned: false };
  const fromDb = { warned: false }; // "reading the database directly" note, once per streak
  const cron = { text: null, lastOkAt: null, warned: false };

  function warnOnce(state, message) {
    if (state.warned) return;
    state.warned = true;
    warn(message);
  }

  async function readJson(port, pathname) {
    const res = await dashboardClient.get(port, pathname, { readBody: true });
    if (!res) throw new Error('no Dashboard session token');
    return res;
  }

  async function listSchedules(port) {
    const items = [];
    let tz = null, total = null, cursor = null, pages = 0;
    do {
      const query = `limit=${LIST_PAGE_LIMIT}&include=total${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await readJson(port, `/api/schedules?${query}`);
      if (!res.ok) throw new Error(`GET /api/schedules: http ${res.status}`);
      const body = await res.json();
      if (!isObject(body)) throw new Error('GET /api/schedules: not an object');
      if (body.available === false) return { available: false };
      if (!Array.isArray(body.items)) throw new Error('GET /api/schedules: no items');
      items.push(...body.items.filter((it) => isObject(it) && typeof it.id === 'string' && it.id));
      if (typeof body.tz === 'string') tz = body.tz;
      if (Number.isInteger(body.total)) total = body.total;
      cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
      pages += 1;
    } while (cursor && pages < maxListPages);
    const unread = cursor && total !== null ? Math.max(0, total - items.length) : 0;
    return { available: true, items, tz, unread };
  }

  // Detail + history of one task. Returns null when the task disappeared in
  // between (404); throws on any other failure.
  async function readDetail(port, id) {
    const enc = encodeURIComponent(id);
    const d = await readJson(port, `/api/schedules/${enc}`);
    if (d.status === 404) return null;
    if (!d.ok) throw new Error(`GET /api/schedules/:id: http ${d.status}`);
    const task = (await d.json())?.task;
    if (!isObject(task)) throw new Error('GET /api/schedules/:id: no task');
    const h = await readJson(port, `/api/schedules/${enc}/history?limit=${HISTORY_LIMIT}`);
    if (h.status === 404) return null;
    if (!h.ok) throw new Error(`GET /api/schedules/:id/history: http ${h.status}`);
    const items = (await h.json())?.items;
    if (!Array.isArray(items)) throw new Error('GET /api/schedules/:id/history: no items');
    return {
      prompt: typeof task.prompt === 'string' ? task.prompt : null,
      history: items,
      createdAt: task.createdAt ?? null,
      timezone: task.timezone ?? null,
    };
  }

  function clearScheduler() {
    scheduler.tasks = [];
    scheduler.truncated = 0;
    scheduler.lastOkAt = null;
    detailCache.clear();
  }

  // local_no: the task's place among all scheduler task ids. Generated ids
  // start with the base-36 creation time, so this is creation order.
  const localOrder = (ids) => new Map([...ids].sort().map((id, i) => [id, i + 1]));

  // The Dashboard could not list the tasks: read the scheduler's database
  // (scheduler-db-read.js) — core 0.9.x, whose Dashboard has no
  // /api/schedules, always lands here.
  async function readSchedulerFromDb(nowMs, dashboardError) {
    let db;
    try {
      db = await readSchedulerDb(nowMs);
    } catch (err) {
      db = { state: 'failed', error: err?.message || String(err) };
    }
    if (db?.state !== 'ok' && db?.state !== 'not_installed') {
      warnOnce(scheduler, `task inventory: scheduler tasks unavailable (Dashboard: ${dashboardError}; `
        + `scheduler database: ${db?.error ?? 'unreadable'}) — reported as failed with the last good read`);
      return 'failed';
    }
    scheduler.warned = false;
    warnOnce(fromDb, `task inventory: reading scheduler tasks from the scheduler database (Dashboard: ${dashboardError})`);
    if (db.state === 'not_installed') {
      clearScheduler();
      return 'not_installed';
    }
    // The database read has every detail and does not use the Dashboard's
    // detail cache, but keeps it: after a passing Dashboard failure (core 1.0)
    // unchanged rows need no re-read (the cache is keyed by the list row).
    const order = localOrder(db.allIds);
    const tasks = [];
    for (const entry of db.items) {
      if (schedulerStatus(entry, [], nowMs) === null) continue;
      const task = buildSchedulerTask({
        entry, detail: db.details.get(entry.id) ?? null, localNo: order.get(entry.id), tz: db.tz, nowMs, home,
      });
      if (task) tasks.push(task);
    }
    scheduler.tasks = tasks;
    scheduler.truncated = db.unread;
    scheduler.lastOkAt = nowMs;
    return 'ok';
  }

  async function readScheduler(nowMs) {
    if (dashboardClient.isQuiet()) return readSchedulerFromDb(nowMs, 'reads are off (API key)');
    const port = getDashboardPort();
    let list;
    try {
      list = await listSchedules(port);
    } catch (err) {
      return readSchedulerFromDb(nowMs, err?.message || String(err));
    }
    scheduler.warned = false;
    fromDb.warned = false;
    if (!list.available) {
      clearScheduler();
      return 'not_installed';
    }

    const order = localOrder(list.items.map((it) => it.id));
    const reported = list.items.filter((it) => schedulerStatus(it, [], nowMs) !== null);
    const seen = new Set(reported.map((it) => it.id));
    for (const id of detailCache.keys()) if (!seen.has(id)) detailCache.delete(id);

    let reads = 0, detailsOff = false;
    const tasks = [];
    for (const entry of reported) {
      const hash = rowHash(entry);
      let cached = detailCache.get(entry.id);
      if (cached?.hash !== hash && !detailsOff && reads < maxDetailReadsPerTick) {
        reads += 1;
        try {
          const detail = await readDetail(port, entry.id);
          if (detail) {
            cached = { hash, ...detail };
            detailCache.set(entry.id, cached);
          }
          details.warned = false;
        } catch (err) {
          detailsOff = true;
          warnOnce(details, `task inventory: scheduler task detail unavailable (${err?.message || err}) — `
            + 'using the list row, retried next tick');
        }
      }
      // A stale cache keeps the full prompt, but its runs are from before the
      // change: use the list's own runs until the detail is read again.
      const detail = cached && cached.hash !== hash ? { ...cached, history: null } : cached;
      const task = buildSchedulerTask({
        entry, detail, localNo: order.get(entry.id), tz: list.tz, nowMs, home,
      });
      if (task) tasks.push(task);
    }
    scheduler.tasks = tasks;
    scheduler.truncated = list.unread;
    scheduler.lastOkAt = nowMs;
    return 'ok';
  }

  async function readCron(nowMs) {
    let result;
    try {
      result = await readCrontab();
    } catch (err) {
      result = { state: 'failed', error: err?.message || String(err) };
    }
    if (result.state === 'ok') {
      cron.text = result.text;
      cron.lastOkAt = nowMs;
      cron.warned = false;
      return 'ok';
    }
    if (result.state === 'not_installed') {
      cron.text = null;
      cron.lastOkAt = null;
      cron.warned = false;
      return 'not_installed';
    }
    warnOnce(cron, `task inventory: crontab unreadable (${result.error}) — reported as failed with the last good read`);
    return 'failed';
  }

  async function collect() {
    const nowMs = now();
    const schedulerState = await readScheduler(nowMs);
    const cronState = await readCron(nowMs);
    // Cron next runs are recomputed from the last good crontab every time.
    const cronTasks = cron.text !== null
      ? buildCronTasks(cron.text, { nowMs, tz: cronTimeZone(), home }) : [];
    return buildSnapshot({
      sources: [
        { source: 'scheduler', state: schedulerState, last_ok_at: toIso(scheduler.lastOkAt) },
        { source: 'cron', state: cronState, last_ok_at: toIso(cron.lastOkAt) },
      ],
      tasks: [...scheduler.tasks, ...cronTasks],
      truncatedCount: scheduler.truncated,
    });
  }

  return { collect };
}

/**
 * @returns {() => Promise<void>} the tick; never throws.
 */
export function createTaskInventoryReporter(activeOrgConfigs, {
  log,
  warn,
  collector,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  now = Date.now,
  heartbeatMs = HEARTBEAT_MS,
  requestTimeoutMs = REPORT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!collector) throw new Error('task inventory: collector is required');
  let endpointMissing = false;  // 404 — off until restart
  let sent = null;              // last accepted (or rejected) { key, hash, body, at }
  let warnedFailure = false;    // once per failure streak
  let warnedOrg = false;

  return async function reportTaskInventory() {
    if (endpointMissing) return;
    let slug = '?';
    try {
      const primary = selectPrimaryOrg(activeOrgConfigs);
      if (!primary || !primary.selfMemberId) {
        if (!warnedOrg) {
          warnedOrg = true;
          warn(primary
            ? `[${primary.slug}] primary org has no self.member_id — task inventory not reported`
            : 'no active org configured — task inventory not reported');
        }
        return;
      }
      warnedOrg = false;
      slug = primary.slug;
      const { orgConfig, selfMemberId } = primary;
      const key = `${orgConfig.org_id}/${selfMemberId}`;

      const body = await collector.collect();
      const hash = snapshotHash(body);
      const t = now();
      let payload, payloadHash;
      if (!sent || sent.key !== key || sent.hash !== hash) {
        payload = body;
        payloadHash = hash;
      } else if (t - sent.at >= heartbeatMs) {
        payload = body;          // heartbeat: same content, fresh last_ok_at
        payloadHash = hash;
      } else {
        return;
      }

      try {
        await putForOrg(orgConfig.org_id, apiPath(`/agents/${selfMemberId}/inventory/tasks`), payload, {
          timeoutMs: requestTimeoutMs,
          quietOnSuccess: true,
          quietStatuses: [429],
          sensitiveBody: true,
        });
      } catch (err) {
        const status = err?.status;
        if (status === 404) {
          endpointMissing = true;
          warn(`[${slug}] task inventory endpoint not available (404), skipping until restart`);
          return;
        }
        if (status === 429) return; // a change < 30 s after the previous one; next tick sends it
        if (status >= 400 && status < 500 && status !== 401 && status !== 408) {
          // The server refused this body; send it again only with the heartbeat.
          sent = { key, hash: payloadHash, body: payload, at: t };
          warn(`[${slug}] task inventory rejected (${status}): ${err.message}`);
          return;
        }
        throw err;
      }
      sent = { key, hash: payloadHash, body: payload, at: t };
      if (warnedFailure) log?.(`[${slug}] task inventory reported again`);
      warnedFailure = false;
    } catch (err) {
      if (!warnedFailure) {
        warnedFailure = true;
        warn(`[${slug}] task inventory report failed: ${err?.message || err}`);
      }
    }
  };
}

// Exported for tests.
export const _internal = { rowHash };
