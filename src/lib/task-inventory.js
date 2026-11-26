/**
 * Scheduled-task inventory — pure builders for the snapshot this Agent reports
 * to Workspace (`PUT /api/v1/agents/{member_id}/inventory/tasks`, see
 * task-inventory-reporter.js for the I/O and the cadence).
 *
 * Two sources:
 *   - `scheduler`: zylos scheduler tasks as served by the local Dashboard
 *     (`GET /api/schedules`, `/api/schedules/:id`, `/api/schedules/:id/history`),
 *     or read in the same shape from the scheduler's database when the
 *     Dashboard cannot serve them (scheduler-db-read.js; core 0.9.x);
 *   - `cron`: the user's crontab (`crontab -l`), next runs computed here
 *     (cron-expr.js) in the machine's time zone.
 *
 * Everything that is display text (names, instructions, cron commands, error
 * texts, delivery-target names) is redacted on this machine (text-redact.js)
 * and then cut to the Workspace limits (Unicode code points), so a report is
 * never rejected for length. Delivery targets carry the channel, the group's
 * display name and group/dm only — never a chat or user id.
 *
 * Status mapping (scheduler):
 *   paused                                  → paused
 *   completed one-time, done ≤ 7 days ago   → delivered (older: not reported)
 *   failed one-time (missed / failed)       → expired
 *   failed recurring/interval (the scheduler could not compute the next run)
 *                                           → attention / unparsable
 *   pending/running:
 *     cron text or interval unusable        → attention / unparsable
 *     pending past its run time + its miss window (scheduler not dispatching)
 *                                           → attention / missed
 *     latest finished run failed / timed out → attention / undeliverable
 *     otherwise                             → enabled
 *   any other status                        → unknown
 */

import crypto from 'crypto';
import { redactTruncate, truncateChars, firstSentence } from './text-redact.js';
import { parseCron, parseCrontabLine, nextCronRuns } from './cron-expr.js';

export const LIMITS = Object.freeze({
  tasks: 200,
  id: 128,
  source: 32,
  name: 60,
  expr: 256,
  tz: 64,
  status: 32,
  instructionHead: 80,
  instruction: 8000,
  shortInstruction: 2000,
  deliveries: 30,
  runs: 30,
  nextRuns: 5,
  channel: 32,
  targetName: 60,
  lastError: 500,
});

// Contract: 2 MiB max body; the plugin keeps under ~1.9 MiB.
export const MAX_BODY_BYTES = Math.floor(1.9 * 1024 * 1024);
export const DELIVERED_WINDOW_MS = 7 * 24 * 3600 * 1000;
// The scheduler's default miss window (`task.miss_threshold || 300`).
const DEFAULT_MISS_SECONDS = 300;
// Slack on top of the miss window before a pending task counts as missed: the
// scheduler loop runs every 5 s and a delivery may take up to 180 s.
const MISSED_GRACE_MS = 5 * 60 * 1000;
const MISSED_WINDOW_TEXT = 'Missed execution window';

const STATUS_RANK = { attention: 0, enabled: 1, paused: 2, unknown: 3, expired: 4, delivered: 5 };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Epoch ms from a Dashboard time (ISO string, epoch seconds or epoch ms), or null. */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? v * 1000 : v) : null;
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** RFC 3339 UTC, whole seconds (`2026-11-26T02:00:00Z`), or null. */
export function toIso(v) {
  const ms = toMs(v);
  if (ms === null) return null;
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The contract's schedule object: all five keys, null when not applicable
// (cws-core declares them required — a missing key fails the whole report).
function scheduleObject({ kind, expr = null, every_seconds = null, at = null, tz = null }) {
  return { kind, expr, every_seconds, at, tz };
}

function cleanTz(tz) {
  return typeof tz === 'string' && tz && !tz.includes('\u0000') && Array.from(tz).length <= LIMITS.tz ? tz : null;
}

/** Report id of a scheduler task: `scheduler-<task id>`, hashed when not URL-safe. */
export function schedulerTaskId(rawId) {
  const id = `scheduler-${rawId}`;
  if (/^[A-Za-z0-9._-]+$/.test(id) && id.length <= LIMITS.id) return id;
  return `scheduler-h${sha256(String(rawId)).slice(0, 16)}`;
}

/** Scheduler history status → run result (`started` = in progress). */
export function runResult(status) {
  switch (status) {
    case 'success': return 'delivered';
    case 'failed': return 'failed';
    case 'timeout': return 'timeout';
    case 'started': return 'running';
    default: return null;
  }
}

// The newest finished run, from history ordered newest → oldest.
const FINISHED = new Set(['success', 'failed', 'timeout']);
const latestFinished = (history) => history.find((r) => FINISHED.has(r?.status)) ?? null;

function scheduleUnusable(entry) {
  if (entry.type === 'recurring') {
    if (typeof entry.cron !== 'string' || !entry.cron.trim()) return true;
    // The Dashboard could not evaluate it; trust our own parser before
    // calling it unparsable (the Dashboard also says so when its cron module
    // is missing).
    return Boolean(entry.nextRuns?.unavailable) && !parseCron(entry.cron).ok;
  }
  if (entry.type === 'interval') return !(Number(entry.intervalSeconds) >= 1);
  if (entry.type === 'one-time') return toMs(entry.nextRunAt) === null;
  return false;
}

/**
 * Inventory status of one scheduler task.
 * @param {object} entry   Dashboard task (list row or detail `task`)
 * @param {object[]} history runs, newest → oldest
 * @param {number} nowMs
 * @returns {{status: string, attention_reason: string|null} | null} null: not reported
 */
export function schedulerStatus(entry, history, nowMs) {
  const plain = (status) => ({ status, attention_reason: null });
  const attention = (reason) => ({ status: 'attention', attention_reason: reason });
  const { type, status } = entry;
  if (status === 'paused') return plain('paused');
  if (status === 'completed' && type === 'one-time') {
    const at = toMs(entry.lastRunAt) ?? toMs(entry.updatedAt);
    return at !== null && nowMs - at <= DELIVERED_WINDOW_MS ? plain('delivered') : null;
  }
  if (status === 'failed') return type === 'one-time' ? plain('expired') : attention('unparsable');
  // `completed` on a periodic task is the moment before the scheduler
  // reschedules it: enabled.
  if (!['pending', 'running', 'completed'].includes(status)) return plain('unknown');
  if (scheduleUnusable(entry)) return attention('unparsable');
  const next = toMs(entry.nextRunAt);
  const missSeconds = Number(entry.missThreshold) > 0 ? Number(entry.missThreshold) : DEFAULT_MISS_SECONDS;
  if (status === 'pending' && next !== null && nowMs - next > missSeconds * 1000 + MISSED_GRACE_MS) {
    return attention('missed');
  }
  const latest = latestFinished(history);
  if (latest && (latest.status === 'failed' || latest.status === 'timeout')) return attention('undeliverable');
  return plain('enabled');
}

// group | dm from an endpoint's `|type:` part, a session-group name, or the
// shape of a bare chat id. Unknown → group.
const DM_TYPES = new Set(['dm', 'p2p', 'private', 'dm-topic', 'direct']);
function targetKind(target, reply) {
  const endpoint = typeof reply?.endpoint === 'string' ? reply.endpoint : '';
  const typed = /\|type:([^|]+)/.exec(endpoint);
  if (typed) return DM_TYPES.has(typed[1].toLowerCase()) ? 'dm' : 'group';
  const groupText = target?.kind === 'group' ? target.sessionGroup : target?.kind === 'raw' ? target.text : null;
  if (typeof groupText === 'string' && groupText.includes(':')) {
    const name = groupText.slice(groupText.indexOf(':') + 1);
    if (name.startsWith('dm-')) return 'dm';
    if (name.startsWith('group-')) return 'group';
  }
  const bare = endpoint.split('|')[0];
  if (/^o[un]_/.test(bare)) return 'dm';       // Lark / Feishu user id
  if (/^\d+$/.test(bare)) return 'dm';          // Telegram private chat
  return 'group';
}

/**
 * Where a scheduler task's result goes: `{channel, name, kind}`, or null when
 * it is not sent anywhere (Origin, no reply channel). `name` is the group's
 * display name (redacted), never for a DM.
 */
export function schedulerTarget(entry, { home } = {}) {
  const reply = isObject(entry.reply) ? entry.reply : null;
  const target = isObject(entry.target) ? entry.target : null;
  let channel = reply?.channel
    || (target?.kind === 'group' ? target.componentName : null)
    || (target?.kind === 'raw' && typeof target.text === 'string' ? target.text.split(':')[0] : null);
  if (typeof channel !== 'string' || !channel.trim()) return null;
  channel = redactTruncate(channel.trim(), LIMITS.channel, { home });
  if (!channel) return null; // only U+0000: Workspace needs a non-empty channel
  const kind = targetKind(target, reply);
  const displayName = kind === 'group' && target?.kind === 'group' && typeof target.displayName === 'string'
    ? redactTruncate(target.displayName.trim(), LIMITS.targetName, { home }) : null;
  return { channel, name: displayName || null, kind };
}

// Creation time: the Dashboard's `createdAt` when it serves one; else the
// scheduler's generated id `task-<base36 epoch ms>-<random>` carries it.
function createdAtOf(entry, nowMs) {
  const served = toIso(entry.createdAt);
  if (served) return served;
  const m = /^task-([0-9a-z]{6,10})-[0-9a-z]+$/.exec(String(entry.id));
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return ms >= Date.UTC(2020, 0, 1) && ms <= nowMs + 86_400_000 ? toIso(ms) : null;
}

function historyFromEntry(entry) {
  // The list's `recent` is oldest → newest; the history read is newest → oldest.
  return Array.isArray(entry.recent) ? entry.recent.filter(isObject).slice().reverse() : [];
}

/**
 * One scheduler task in the report.
 * @param {object} a
 * @param {object} a.entry      Dashboard list row
 * @param {object} [a.detail]   `{prompt?, history?, createdAt?, timezone?}` from the
 *                              detail + history reads (absent: list data only)
 * @param {number} a.localNo    number inside the source
 * @param {string|null} a.tz    the scheduler's time zone (list `tz`)
 * @param {number} a.nowMs
 * @returns {object|null} null when the task is not reported (old delivered one-time task)
 */
export function buildSchedulerTask({ entry, detail = null, localNo, tz, nowMs, home }) {
  const history = Array.isArray(detail?.history) ? detail.history.filter(isObject) : historyFromEntry(entry);
  const mapped = schedulerStatus(entry, history, nowMs);
  if (!mapped) return null;
  const { status, attention_reason } = mapped;
  const zone = cleanTz(detail?.timezone ?? entry.timezone) ?? cleanTz(tz);

  let schedule;
  if (entry.type === 'recurring') {
    const expr = typeof entry.cron === 'string' ? entry.cron.trim() : '';
    schedule = scheduleObject({ kind: 'cron', expr: expr ? truncateChars(expr, LIMITS.expr) : null, tz: zone });
  } else if (entry.type === 'interval') {
    const every = Math.floor(Number(entry.intervalSeconds));
    schedule = scheduleObject({ kind: 'interval', every_seconds: every >= 1 ? every : null });
  } else {
    const at = toIso(entry.nextRunAt);
    schedule = scheduleObject({ kind: 'once', at, tz: zone });
  }

  const live = status === 'enabled' || (status === 'attention' && attention_reason !== 'unparsable');
  const nextRunAt = live ? toIso(entry.nextRunAt) : null;
  const nextRuns = live && Array.isArray(entry.nextRuns?.runs)
    ? entry.nextRuns.runs.map(toIso).filter(Boolean).slice(0, LIMITS.nextRuns) : [];

  const rawName = typeof entry.name === 'string' ? entry.name.trim() : '';
  const name = (rawName && redactTruncate(rawName, LIMITS.name, { home })) || null; // '' after U+0000 removal

  const prompt = typeof detail?.prompt === 'string' ? detail.prompt
    : typeof entry.prompt === 'string' ? entry.prompt
      : `${entry.promptSummary ?? ''}${entry.promptTruncated ? '…' : ''}`;
  const instruction = redactTruncate(prompt, LIMITS.instruction, { home }) ?? '';
  const head = firstSentence(instruction);

  const finished = history.filter((r) => ['delivered', 'failed', 'timeout'].includes(runResult(r.status)));
  const recentDeliveries = finished.slice(0, LIMITS.deliveries).map((r) => runResult(r.status)).reverse();
  const runs = history
    .map((r) => ({ at: toIso(r.executedAt), result: runResult(r.status) }))
    .filter((r) => r.at && r.result)
    .slice(0, LIMITS.runs);

  const lastSuccess = history.find((r) => r.status === 'success');
  const completedOnce = entry.type === 'one-time' && entry.status === 'completed';
  const lastDeliveredAt = lastSuccess ? toIso(lastSuccess.completedAt ?? lastSuccess.executedAt)
    : completedOnce ? toIso(entry.lastRunAt) : null;

  const latest = latestFinished(history);
  let lastRun;
  if (latest) lastRun = latest.status === 'success' ? 'delivered' : 'failed';
  else if (completedOnce) lastRun = 'delivered';
  else if (toMs(entry.lastRunAt) === null) lastRun = 'never';
  else lastRun = null; // ran, but its record has aged out of the history

  // The Dashboard shows `lastError` only while the latest run failed; a
  // timeout keeps its reason on the history row; a one-time task that never
  // ran and failed missed its window (the scheduler writes no run for that).
  let lastError = typeof entry.lastError === 'string' && entry.lastError ? entry.lastError : null;
  if (!lastError && latest && latest.status !== 'success' && typeof latest.error === 'string') lastError = latest.error || null;
  if (!lastError && status === 'expired' && !latest && toMs(entry.lastRunAt) === null) lastError = MISSED_WINDOW_TEXT;

  return {
    id: schedulerTaskId(entry.id),
    source: 'scheduler',
    local_no: localNo,
    name,
    unnamed: !name,
    schedule,
    next_run_at: nextRunAt,
    status,
    attention_reason,
    last_run: lastRun,
    instruction_head: head ? truncateChars(head, LIMITS.instructionHead) : null,
    recent_deliveries: recentDeliveries,
    last_delivered_at: lastDeliveredAt,
    target: schedulerTarget(entry, { home }),
    detail: {
      instruction,
      runs,
      next_runs: nextRuns,
      skip_late_seconds: Math.floor(Number(entry.missThreshold) > 0 ? Number(entry.missThreshold) : DEFAULT_MISS_SECONDS),
      wait_idle: typeof entry.requireIdle === 'boolean' ? entry.requireIdle : null,
      last_error: lastError ? redactTruncate(lastError, LIMITS.lastError, { home }) : null,
      created_at: createdAtOf(detail?.createdAt ? { ...entry, createdAt: detail.createdAt } : entry, nowMs),
      automation_name: null,
    },
  };
}

/**
 * The user crontab as report tasks. Comments, blank lines and environment
 * assignments are skipped; `local_no` is the job's position (1-based).
 * @param {string} text   `crontab -l` output
 * @param {{nowMs: number, tz: string, home?: string}} opts
 */
export function buildCronTasks(text, { nowMs, tz, home }) {
  const tasks = [];
  const used = new Map();
  let no = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parsed = parseCrontabLine(line);
    if (parsed.kind !== 'job') continue;
    no += 1;
    const base = `cron-${sha256(line.trim()).slice(0, 8)}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen ? `${base}-${seen + 1}` : base;
    let schedule, status = 'enabled', reason = null, command, nextRuns = [];
    if (parsed.unparsable) {
      status = 'attention';
      reason = 'unparsable';
      schedule = scheduleObject({ kind: 'cron', expr: redactTruncate(parsed.raw, LIMITS.expr, { home }), tz: cleanTz(tz) });
      command = parsed.raw;
    } else {
      schedule = scheduleObject({ kind: 'cron', expr: truncateChars(parsed.schedule, LIMITS.expr), tz: cleanTz(tz) });
      command = parsed.command;
      nextRuns = nextCronRuns(parsed.spec, nowMs, tz, LIMITS.nextRuns).map(toIso);
    }
    const instruction = redactTruncate(command, LIMITS.instruction, { home }) ?? '';
    const head = firstSentence(instruction);
    tasks.push({
      id,
      source: 'cron',
      local_no: no,
      name: null,
      unnamed: false,
      schedule,
      next_run_at: nextRuns[0] ?? null,
      status,
      attention_reason: reason,
      last_run: null,
      instruction_head: head ? truncateChars(head, LIMITS.instructionHead) : null,
      recent_deliveries: [],
      last_delivered_at: null,
      target: null,
      detail: {
        instruction,
        runs: [],
        next_runs: nextRuns,
        skip_late_seconds: null,
        wait_idle: null,
        last_error: null,
        created_at: null,
        automation_name: null,
      },
    });
  }
  return tasks;
}

const byteLength = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Assemble the report body: tasks ordered attention → enabled → paused →
 * unknown → expired → delivered (stable inside a rank), at most 200, the rest
 * counted in `truncated_count`; then kept under `maxBytes` by shortening
 * instructions to 2000 chars and, if still too large, dropping tasks from the
 * end (counted too).
 */
export function buildSnapshot({ sources, tasks, truncatedCount = 0, maxBytes = MAX_BODY_BYTES }) {
  const ordered = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => ((STATUS_RANK[a.t.status] ?? 3) - (STATUS_RANK[b.t.status] ?? 3)) || a.i - b.i)
    .map(({ t }) => t);
  const kept = ordered.slice(0, LIMITS.tasks);
  const body = {
    sources,
    tasks: kept,
    truncated_count: Math.max(0, truncatedCount) + (ordered.length - kept.length),
  };
  if (byteLength(body) <= maxBytes) return body;
  body.tasks = body.tasks.map((t) => ({
    ...t,
    detail: { ...t.detail, instruction: truncateChars(t.detail.instruction, LIMITS.shortInstruction) },
  }));
  // Drop from the end on a running estimate (one stringify per task), then
  // confirm on the exact size.
  let size = byteLength(body);
  while (size > maxBytes && body.tasks.length) {
    size -= byteLength(body.tasks.pop()) + 1;
    body.truncated_count += 1;
  }
  while (body.tasks.length && byteLength(body) > maxBytes) {
    body.tasks.pop();
    body.truncated_count += 1;
  }
  return body;
}

/**
 * Change-detection hash of a report body. `sources[].last_ok_at` moves on
 * every successful read, so it is left out: a snapshot whose tasks and
 * source states are unchanged is the same snapshot.
 */
export function snapshotHash(body) {
  const stable = {
    ...body,
    sources: (body.sources ?? []).map(({ last_ok_at, ...rest }) => rest),
  };
  return sha256(JSON.stringify(stable));
}
