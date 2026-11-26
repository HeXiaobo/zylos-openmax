import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  LIMITS, MAX_BODY_BYTES, toMs, toIso, schedulerTaskId, runResult, schedulerStatus, schedulerTarget,
  buildSchedulerTask, buildCronTasks, buildSnapshot, snapshotHash,
} from './task-inventory.js';

const HOME = '/home/alice';
const NOW = Date.parse('2026-11-26T01:00:00Z');
const H = 3600_000;
const D = 24 * H;
const at = (ms) => new Date(ms).toISOString();

// A Dashboard `GET /api/schedules` row, shaped like Core 1.0.0-beta.17's
// (times are ISO strings on the wire).
function row(over = {}) {
  return {
    id: 'task-msscj22p-e0tles',
    name: 'Daily report',
    promptSummary: 'Every day at 10:00, send the report.',
    promptTruncated: false,
    type: 'recurring',
    status: 'pending',
    cron: '0 10 * * *',
    intervalSeconds: null,
    nextRunAt: '2026-11-26T02:00:00.000Z',
    lastRunAt: '2026-11-25T02:00:43.000Z',
    updatedAt: '2026-11-25T02:00:43.000Z',
    priority: 3,
    requireIdle: false,
    missThreshold: 14400,
    showLastError: false,
    lastError: null,
    recent: [
      { id: 1, status: 'success', executedAt: '2026-11-24T02:00:00.000Z', completedAt: '2026-11-24T02:00:32.000Z', duration: 32000, error: null },
      { id: 2, status: 'success', executedAt: '2026-11-25T02:00:03.000Z', completedAt: '2026-11-25T02:00:39.000Z', duration: 36000, error: null },
    ],
    nextRuns: { runs: ['2026-11-26T02:00:00.000Z', '2026-11-27T02:00:00.000Z'], in24h: ['2026-11-26T02:00:00.000Z'] },
    target: { kind: 'group', sessionGroup: 'lark', componentName: 'lark', displayName: null },
    reply: { channel: 'lark', endpoint: 'oc_655daebb99f5c62bae0121979c8f152d' },
    reenable: false,
    ...over,
  };
}

const hist = (...statuses) => statuses.map((status, i) => ({
  id: 100 - i, status, executedAt: at(NOW - (i + 1) * H), completedAt: status === 'started' ? null : at(NOW - (i + 1) * H + 30_000),
  duration: 30000, error: status === 'failed' ? 'RECEIVE_NOT_COMMITTED' : status === 'timeout' ? 'TIMEOUT oc_655daebb99f5c62bae0121979c8f152d' : null,
}));

test('toMs / toIso accept ISO strings, epoch seconds and epoch ms', () => {
  assert.equal(toMs('2026-11-26T02:00:00.000Z'), Date.parse('2026-11-26T02:00:00Z'));
  assert.equal(toMs(1795744800), 1795744800000);
  assert.equal(toMs(1795744800000), 1795744800000);
  assert.equal(toMs('1795744800'), 1795744800000);
  assert.equal(toMs(null), null);
  assert.equal(toMs('nope'), null);
  assert.equal(toIso('2026-11-26T02:00:00.789Z'), '2026-11-26T02:00:00Z');
  assert.equal(toIso(1795744800), '2026-11-27T02:00:00Z');
  assert.equal(toIso(undefined), null);
});

test('schedulerTaskId: URL-safe ids pass through, others are hashed', () => {
  assert.equal(schedulerTaskId('task-msscj22p-e0tles'), 'scheduler-task-msscj22p-e0tles');
  const odd = schedulerTaskId('daily report/1');
  assert.match(odd, /^scheduler-h[0-9a-f]{16}$/);
  assert.equal(odd, schedulerTaskId('daily report/1'), 'stable');
  assert.match(schedulerTaskId('x'.repeat(200)), /^scheduler-h[0-9a-f]{16}$/);
});

test('runResult maps scheduler history statuses', () => {
  assert.equal(runResult('success'), 'delivered');
  assert.equal(runResult('failed'), 'failed');
  assert.equal(runResult('timeout'), 'timeout');
  assert.equal(runResult('started'), 'running');
  assert.equal(runResult('weird'), null);
});

test('status: paused / enabled / running / completed periodic', () => {
  assert.deepEqual(schedulerStatus(row({ status: 'paused' }), [], NOW), { status: 'paused', attention_reason: null });
  assert.deepEqual(schedulerStatus(row(), hist('success'), NOW), { status: 'enabled', attention_reason: null });
  assert.deepEqual(schedulerStatus(row({ status: 'running' }), hist('started', 'success'), NOW), { status: 'enabled', attention_reason: null });
  assert.deepEqual(schedulerStatus(row({ status: 'completed' }), [], NOW), { status: 'enabled', attention_reason: null });
  assert.deepEqual(schedulerStatus(row({ status: 'mystery' }), [], NOW), { status: 'unknown', attention_reason: null });
});

test('status: attention / undeliverable when the latest finished run failed or timed out', () => {
  assert.deepEqual(schedulerStatus(row(), hist('failed', 'success'), NOW), { status: 'attention', attention_reason: 'undeliverable' });
  assert.deepEqual(schedulerStatus(row(), hist('timeout'), NOW), { status: 'attention', attention_reason: 'undeliverable' });
  // A run in progress does not hide the previous failure.
  assert.deepEqual(schedulerStatus(row({ status: 'running' }), hist('started', 'failed'), NOW), { status: 'attention', attention_reason: 'undeliverable' });
  // An older failure followed by a success is fine.
  assert.equal(schedulerStatus(row(), hist('success', 'failed'), NOW).status, 'enabled');
});

test('status: attention / missed when a pending task is past its run time and miss window', () => {
  const late = row({ nextRunAt: at(NOW - 5 * H), missThreshold: 3600 });
  assert.deepEqual(schedulerStatus(late, hist('success'), NOW), { status: 'attention', attention_reason: 'missed' });
  // Inside the window (+ grace): still enabled.
  assert.equal(schedulerStatus(row({ nextRunAt: at(NOW - 2 * 60_000), missThreshold: null }), [], NOW).status, 'enabled');
  // Default window 300 s + 5 min grace.
  assert.equal(schedulerStatus(row({ nextRunAt: at(NOW - 11 * 60_000), missThreshold: null }), [], NOW).attention_reason, 'missed');
  // A running task is being delivered, not missed.
  assert.equal(schedulerStatus(row({ status: 'running', nextRunAt: at(NOW - 5 * H), missThreshold: 60 }), [], NOW).status, 'enabled');
});

test('status: attention / unparsable for unusable schedules', () => {
  const un = { status: 'attention', attention_reason: 'unparsable' };
  assert.deepEqual(schedulerStatus(row({ cron: null }), [], NOW), un);
  const noCron = buildSchedulerTask({ entry: row({ cron: null }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.deepEqual(noCron.schedule, { kind: 'cron', expr: null, every_seconds: null, at: null, tz: 'UTC' }, 'no empty expr');
  assert.equal(noCron.next_run_at, null);
  assert.deepEqual(noCron.detail.next_runs, []);
  assert.deepEqual(schedulerStatus(row({ cron: '0 0 L * *', nextRuns: { unavailable: true, reason: 'cron_preview_unavailable' } }), [], NOW), un);
  // The Dashboard could not evaluate it but the expression is fine (its cron module was missing): enabled.
  assert.equal(schedulerStatus(row({ nextRuns: { unavailable: true, reason: 'cron_preview_unavailable' } }), [], NOW).status, 'enabled');
  assert.deepEqual(schedulerStatus(row({ type: 'interval', cron: null, intervalSeconds: 0 }), [], NOW), un);
  assert.deepEqual(schedulerStatus(row({ type: 'one-time', cron: null, nextRunAt: null }), [], NOW), un);
  // The scheduler marks a periodic task failed when it cannot compute its next run.
  assert.deepEqual(schedulerStatus(row({ status: 'failed' }), [], NOW), un);
});

test('status: one-time tasks — expired, delivered within 7 days, older not reported', () => {
  const once = (over) => row({ type: 'one-time', cron: null, ...over });
  assert.deepEqual(schedulerStatus(once({ status: 'failed' }), [], NOW), { status: 'expired', attention_reason: null });
  assert.deepEqual(schedulerStatus(once({ status: 'completed', lastRunAt: at(NOW - 6 * D) }), [], NOW), { status: 'delivered', attention_reason: null });
  assert.equal(schedulerStatus(once({ status: 'completed', lastRunAt: at(NOW - 8 * D) }), [], NOW), null);
  assert.deepEqual(schedulerStatus(once({ status: 'completed', lastRunAt: null, updatedAt: at(NOW - D) }), [], NOW).status, 'delivered');
});

test('target: channel + group name + kind, never a chat id', () => {
  assert.deepEqual(schedulerTarget(row()), { channel: 'lark', name: null, kind: 'group' });
  assert.equal(schedulerTarget(row({ target: { kind: 'origin' }, reply: null })), null, 'Origin: not sent anywhere');
  assert.deepEqual(schedulerTarget(row({
    target: { kind: 'group', sessionGroup: 'openmax:group-019f6a84-3a1e-76dd-931d-0eea1cb3112a', componentName: 'openmax', displayName: 'Ops 群 oc_655daebb99f5c62bae0121979c8f152d' },
    reply: { channel: 'openmax', endpoint: '019f6a84-3a1e-76dd-931d-0eea1cb3112a' },
  })), { channel: 'openmax', name: 'Ops 群 [id]', kind: 'group' });
  // DM: from the endpoint type, the session group, or a user id; no name.
  assert.equal(schedulerTarget(row({ reply: { channel: 'lark', endpoint: 'oc_1a2b3c4d5e6f7a8b9c|type:p2p|msg:om_1a2b3c4d5e6f' } })).kind, 'dm');
  assert.deepEqual(schedulerTarget(row({
    target: { kind: 'group', sessionGroup: 'openmax:dm-019f', componentName: 'openmax', displayName: 'Alice' },
    reply: { channel: 'openmax', endpoint: '019f' },
  })), { channel: 'openmax', name: null, kind: 'dm' });
  assert.equal(schedulerTarget(row({ reply: { channel: 'lark', endpoint: 'ou_7d8a6e6f0a1b2c3d4e5f' } })).kind, 'dm');
  assert.equal(schedulerTarget(row({ reply: { channel: 'telegram', endpoint: '123456789' } })).kind, 'dm');
  assert.equal(schedulerTarget(row({ reply: { channel: 'telegram', endpoint: '-1001234567890' } })).kind, 'group');
  // A session group without a reply channel: the component is the channel.
  assert.deepEqual(schedulerTarget(row({ reply: null, target: { kind: 'raw', text: 'wecom:group-x' } })), { channel: 'wecom', name: null, kind: 'group' });
});

test('buildSchedulerTask: recurring task with detail + history', () => {
  const history = hist('success', 'timeout', 'success');
  const task = buildSchedulerTask({
    entry: row({ name: 'Report to oc_655daebb99f5c62bae0121979c8f152d' }),
    detail: { prompt: 'Read /home/alice/notes.md. Then send it with token=abc123 to ou_7d8a6e6f0a1b2c3d4e5f60718293a4b5.', history },
    localNo: 2, tz: 'Asia/Singapore', nowMs: NOW, home: HOME,
  });
  assert.deepEqual(task, {
    id: 'scheduler-task-msscj22p-e0tles',
    source: 'scheduler',
    local_no: 2,
    name: 'Report to [id]',
    unnamed: false,
    schedule: { kind: 'cron', expr: '0 10 * * *', every_seconds: null, at: null, tz: 'Asia/Singapore' },
    next_run_at: '2026-11-26T02:00:00Z',
    status: 'enabled',
    attention_reason: null,
    last_run: 'delivered',
    instruction_head: 'Read ~/notes.md.',
    recent_deliveries: ['delivered', 'timeout', 'delivered'],
    last_delivered_at: toIso(NOW - H + 30_000),
    target: { channel: 'lark', name: null, kind: 'group' },
    detail: {
      instruction: 'Read ~/notes.md. Then send it with token=[secret] to [id].',
      runs: [
        { at: toIso(NOW - H), result: 'delivered' },
        { at: toIso(NOW - 2 * H), result: 'timeout' },
        { at: toIso(NOW - 3 * H), result: 'delivered' },
      ],
      next_runs: ['2026-11-26T02:00:00Z', '2026-11-27T02:00:00Z'],
      skip_late_seconds: 14400,
      wait_idle: false,
      last_error: null,
      created_at: toIso(parseInt('msscj22p', 36)),
      automation_name: null,
    },
  });
});

test('buildSchedulerTask: list data only (no detail) — prompt summary and list runs', () => {
  const task = buildSchedulerTask({
    entry: row({ promptSummary: 'x'.repeat(200), promptTruncated: true }), localNo: 1, tz: 'UTC', nowMs: NOW, home: HOME,
  });
  assert.equal(task.detail.instruction, `${'x'.repeat(200)}…`);
  assert.equal(Array.from(task.instruction_head).length, LIMITS.instructionHead);
  // List `recent` is oldest → newest; runs are newest → oldest.
  assert.deepEqual(task.detail.runs.map((r) => r.at), ['2026-11-25T02:00:03Z', '2026-11-24T02:00:00Z']);
  assert.deepEqual(task.recent_deliveries, ['delivered', 'delivered']);
  assert.equal(task.last_delivered_at, '2026-11-25T02:00:39Z');
});

test('buildSchedulerTask: limits on name, instruction, error; unnamed tasks', () => {
  const long = buildSchedulerTask({
    entry: row({ name: '名'.repeat(100), lastError: `E ${'z'.repeat(600)}` }),
    detail: { prompt: 'p'.repeat(9000), history: hist('failed') },
    localNo: 1, tz: 'UTC', nowMs: NOW, home: HOME,
  });
  assert.equal(Array.from(long.name).length, LIMITS.name);
  assert.equal(Array.from(long.detail.instruction).length, LIMITS.instruction);
  assert.equal(Array.from(long.detail.last_error).length, LIMITS.lastError);
  assert.equal(long.status, 'attention');
  const unnamed = buildSchedulerTask({ entry: row({ name: '  ' }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(unnamed.name, null);
  assert.equal(unnamed.unnamed, true);
  const nulName = buildSchedulerTask({ entry: row({ name: '\u0000\u0000' }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(nulName.name, null, 'a name of only U+0000 is no name');
  assert.equal(nulName.unnamed, true);
});

test('U+0000 in a time zone or channel: the tz falls back, an empty channel means no target', () => {
  // Workspace refuses U+0000 and an empty target.channel (400 for the whole report).
  const task = buildSchedulerTask({
    entry: row({ timezone: 'Asia/Shanghai\u0000' }), localNo: 1, tz: 'Asia/Singapore', nowMs: NOW,
  });
  assert.equal(task.schedule.tz, 'Asia/Singapore', 'a tz with U+0000 is not used');
  const bad = buildSchedulerTask({
    entry: row(), detail: { prompt: 'p', timezone: '\u0000' }, localNo: 1, tz: 'Asia/\u0000x', nowMs: NOW,
  });
  assert.equal(bad.schedule.tz, null, 'no usable tz at all');
  assert.equal(schedulerTarget(row({ reply: { channel: '\u0000\u0000', endpoint: 'oc_655daebb99f5c62bae0121979c8f152d' } })), null);
  assert.deepEqual(schedulerTarget(row({ reply: { channel: 'la\u0000rk', endpoint: 'x' } })), { channel: 'lark', name: null, kind: 'group' });
  assert.equal(buildSchedulerTask({
    entry: row({ reply: { channel: '\u0000', endpoint: 'x' } }), localNo: 1, tz: 'UTC', nowMs: NOW,
  }).target, null);
});

test('buildSchedulerTask: runs and deliveries are capped at 30', () => {
  const history = hist(...Array(40).fill('success'));
  const task = buildSchedulerTask({ entry: row(), detail: { prompt: 'p', history }, localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(task.detail.runs.length, 30);
  assert.equal(task.recent_deliveries.length, 30);
  assert.equal(task.detail.runs[0].at, toIso(NOW - H), 'newest first');
});

test('buildSchedulerTask: last error comes from the failed run when the Dashboard hides it', () => {
  const task = buildSchedulerTask({ entry: row(), detail: { prompt: 'p', history: hist('timeout') }, localNo: 1, tz: 'UTC', nowMs: NOW, home: HOME });
  assert.equal(task.status, 'attention');
  assert.equal(task.attention_reason, 'undeliverable');
  assert.equal(task.last_run, 'failed');
  assert.equal(task.detail.last_error, 'TIMEOUT [id]');
  const shown = buildSchedulerTask({ entry: row({ lastError: 'DELIVERY_RESULT_UNKNOWN' }), detail: { prompt: 'p', history: hist('failed') }, localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(shown.detail.last_error, 'DELIVERY_RESULT_UNKNOWN');
});

test('buildSchedulerTask: interval, paused — no next run, interval has no tz', () => {
  const task = buildSchedulerTask({
    entry: row({ type: 'interval', cron: null, intervalSeconds: 900, status: 'paused', nextRuns: { runs: [], in24h: [] } }),
    localNo: 5, tz: 'Asia/Singapore', nowMs: NOW,
  });
  assert.deepEqual(task.schedule, { kind: 'interval', expr: null, every_seconds: 900, at: null, tz: null });
  assert.equal(task.status, 'paused');
  assert.equal(task.next_run_at, null);
  assert.deepEqual(task.detail.next_runs, []);
});

test('buildSchedulerTask: one-time — pending, delivered, expired (missed window)', () => {
  const once = (over) => row({ type: 'one-time', cron: null, recent: [], lastRunAt: null, ...over });
  const pending = buildSchedulerTask({ entry: once({ nextRunAt: '2026-12-01T02:30:00.000Z', nextRuns: { runs: ['2026-12-01T02:30:00.000Z'], in24h: [] } }), localNo: 1, tz: 'Asia/Singapore', nowMs: NOW });
  assert.deepEqual(pending.schedule, { kind: 'once', expr: null, every_seconds: null, at: '2026-12-01T02:30:00Z', tz: 'Asia/Singapore' });
  assert.equal(pending.next_run_at, '2026-12-01T02:30:00Z');
  assert.equal(pending.last_run, 'never');

  const done = buildSchedulerTask({ entry: once({ status: 'completed', lastRunAt: at(NOW - D), nextRunAt: at(NOW - D) }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(done.status, 'delivered');
  assert.equal(done.next_run_at, null);
  assert.equal(done.last_run, 'delivered');
  assert.equal(done.last_delivered_at, toIso(NOW - D), 'from lastRunAt when the run aged out of the history');

  const missed = buildSchedulerTask({ entry: once({ status: 'failed', nextRunAt: at(NOW - D) }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(missed.status, 'expired');
  assert.equal(missed.last_run, 'never');
  assert.equal(missed.detail.last_error, 'Missed execution window');

  assert.equal(buildSchedulerTask({ entry: once({ status: 'completed', lastRunAt: at(NOW - 10 * D) }), localNo: 1, tz: 'UTC', nowMs: NOW }), null);
});

test('buildSchedulerTask: created_at prefers the Dashboard field, else the generated id, else null', () => {
  const served = buildSchedulerTask({ entry: row({ createdAt: '2026-01-02T03:04:05Z' }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(served.detail.created_at, '2026-01-02T03:04:05Z');
  const custom = buildSchedulerTask({ entry: row({ id: 'daily-report' }), localNo: 1, tz: 'UTC', nowMs: NOW });
  assert.equal(custom.detail.created_at, null);
  assert.equal(custom.id, 'scheduler-daily-report');
});

test('buildCronTasks: jobs, ids, next runs in the machine zone', () => {
  const text = [
    '# backups',
    'MAILTO=ops@example.com',
    '',
    '30 2 * * * /home/alice/bin/backup.sh --token abc123 >> /home/alice/log 2>&1',
    '@reboot /usr/bin/start-agent',
    '30 2 * * * /home/alice/bin/backup.sh --token abc123 >> /home/alice/log 2>&1',
    '61 * * * * broken.sh PASSWORD=hunter2',
  ].join('\n');
  const tasks = buildCronTasks(text, { nowMs: NOW, tz: 'Asia/Singapore', home: HOME });
  assert.equal(tasks.length, 4);
  const line = '30 2 * * * /home/alice/bin/backup.sh --token abc123 >> /home/alice/log 2>&1';
  const base = `cron-${crypto.createHash('sha256').update(line).digest('hex').slice(0, 8)}`;
  assert.deepEqual(tasks.map((t) => t.id), [base, tasks[1].id, `${base}-2`, tasks[3].id]);
  assert.deepEqual(tasks.map((t) => t.local_no), [1, 2, 3, 4]);

  const [job, reboot, , broken] = tasks;
  assert.deepEqual(job.schedule, { kind: 'cron', expr: '30 2 * * *', every_seconds: null, at: null, tz: 'Asia/Singapore' });
  assert.equal(job.next_run_at, '2026-11-26T18:30:00Z');
  assert.equal(job.detail.next_runs.length, 5);
  assert.equal(job.detail.instruction, '~/bin/backup.sh --token [secret] >> ~/log 2>&1');
  assert.equal(job.instruction_head, '~/bin/backup.sh --token [secret] >> ~/log 2>&1');
  assert.equal(job.status, 'enabled');
  assert.equal(job.name, null);
  assert.equal(job.unnamed, false);
  assert.equal(job.last_run, null);
  assert.equal(job.target, null);
  assert.deepEqual(job.recent_deliveries, []);
  assert.deepEqual(job.detail.runs, []);

  assert.equal(reboot.schedule.expr, '@reboot');
  assert.equal(reboot.next_run_at, null);
  assert.equal(reboot.status, 'enabled');

  assert.equal(broken.status, 'attention');
  assert.equal(broken.attention_reason, 'unparsable');
  assert.equal(broken.next_run_at, null);
  assert.equal(broken.schedule.expr, '61 * * * * broken.sh PASSWORD=[secret]');
  assert.equal(broken.detail.instruction, '61 * * * * broken.sh PASSWORD=[secret]');
});

test('buildCronTasks: empty crontab', () => {
  assert.deepEqual(buildCronTasks('', { nowMs: NOW, tz: 'UTC' }), []);
  assert.deepEqual(buildCronTasks('# only comments\n', { nowMs: NOW, tz: 'UTC' }), []);
});

const SOURCES = [
  { source: 'scheduler', state: 'ok', last_ok_at: '2026-11-26T01:00:00Z' },
  { source: 'cron', state: 'not_installed', last_ok_at: null },
];
const fakeTask = (id, status, instruction = 'do it') => ({ id, status, detail: { instruction } });

test('buildSnapshot: orders by status rank (stable), caps at 200 and counts the rest', () => {
  const tasks = [
    fakeTask('a', 'delivered'), fakeTask('b', 'enabled'), fakeTask('c', 'attention'),
    fakeTask('d', 'paused'), fakeTask('e', 'expired'), fakeTask('f', 'enabled'), fakeTask('g', 'whatever'),
  ];
  const body = buildSnapshot({ sources: SOURCES, tasks });
  assert.deepEqual(body.tasks.map((t) => t.id), ['c', 'b', 'f', 'd', 'g', 'e', 'a']);
  assert.equal(body.truncated_count, 0);

  const many = Array.from({ length: 230 }, (_, i) => fakeTask(`t${i}`, i < 10 ? 'delivered' : 'enabled'));
  const capped = buildSnapshot({ sources: SOURCES, tasks: many, truncatedCount: 5 });
  assert.equal(capped.tasks.length, 200);
  assert.equal(capped.truncated_count, 35);
  assert.ok(capped.tasks.every((t) => t.status === 'enabled'), 'delivered ones are dropped first');
});

test('buildSnapshot: size guard shortens instructions, then drops tasks from the end', () => {
  const big = Array.from({ length: 10 }, (_, i) => fakeTask(`t${i}`, 'enabled', 'x'.repeat(8000)));
  const shortened = buildSnapshot({ sources: SOURCES, tasks: big, maxBytes: 40_000 });
  assert.equal(shortened.tasks.length, 10);
  assert.ok(shortened.tasks.every((t) => Array.from(t.detail.instruction).length === LIMITS.shortInstruction));
  assert.ok(Buffer.byteLength(JSON.stringify(shortened)) <= 40_000);

  const dropped = buildSnapshot({ sources: SOURCES, tasks: big, maxBytes: 9_000 });
  assert.equal(dropped.tasks.length, 4);
  assert.equal(dropped.truncated_count, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(dropped)) <= 9_000);
  assert.ok(MAX_BODY_BYTES < 2 * 1024 * 1024);
});

test('snapshotHash ignores last_ok_at only', () => {
  const a = buildSnapshot({ sources: SOURCES, tasks: [fakeTask('a', 'enabled')] });
  const b = { ...a, sources: a.sources.map((s) => ({ ...s, last_ok_at: s.last_ok_at && '2026-11-26T01:01:00Z' })) };
  assert.equal(snapshotHash(a), snapshotHash(b));
  const c = { ...a, sources: [{ ...a.sources[0], state: 'failed' }, a.sources[1]] };
  assert.notEqual(snapshotHash(a), snapshotHash(c));
  const d = buildSnapshot({ sources: SOURCES, tasks: [fakeTask('a', 'paused')] });
  assert.notEqual(snapshotHash(a), snapshotHash(d));
});

// ---- contract shape (CONTRACT.md §1): every object carries exactly the
// contract's keys (cws-core declares them required; a missing key or a value
// of the wrong type fails the whole report) ----

const TASK_KEYS = ['id', 'source', 'local_no', 'name', 'unnamed', 'schedule', 'next_run_at', 'status',
  'attention_reason', 'last_run', 'instruction_head', 'recent_deliveries', 'last_delivered_at', 'target', 'detail'];
const SCHEDULE_KEYS = ['kind', 'expr', 'every_seconds', 'at', 'tz'];
const TARGET_KEYS = ['channel', 'name', 'kind'];
const DETAIL_KEYS = ['instruction', 'runs', 'next_runs', 'skip_late_seconds', 'wait_idle', 'last_error', 'created_at', 'automation_name'];
const RUN_KEYS = ['at', 'result'];
const SOURCE_KEYS = ['source', 'state', 'last_ok_at'];
const BODY_KEYS = ['sources', 'tasks', 'truncated_count'];
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const chars = (s) => Array.from(s).length;
const keys = (o) => Object.keys(o).sort();
const isTime = (v) => typeof v === 'string' && TIME_RE.test(v);
const strOrNull = (v, max) => v === null || (typeof v === 'string' && chars(v) <= max);

function assertContractTask(t) {
  const where = t.id;
  assert.deepEqual(keys(t), [...TASK_KEYS].sort(), `${where}: task keys`);
  assert.match(t.id, /^[A-Za-z0-9._-]{1,128}$/, where);
  assert.ok(typeof t.source === 'string' && chars(t.source) >= 1 && chars(t.source) <= 32, where);
  assert.ok(Number.isInteger(t.local_no) && t.local_no >= 0, `${where}: local_no`);
  assert.ok(strOrNull(t.name, 60), `${where}: name`);
  assert.equal(typeof t.unnamed, 'boolean', where);
  assert.deepEqual(keys(t.schedule), [...SCHEDULE_KEYS].sort(), `${where}: schedule keys`);
  assert.ok(['cron', 'interval', 'once'].includes(t.schedule.kind), where);
  assert.ok(strOrNull(t.schedule.expr, 256), `${where}: expr`);
  assert.ok(t.schedule.every_seconds === null || (Number.isInteger(t.schedule.every_seconds) && t.schedule.every_seconds >= 1), where);
  assert.ok(t.schedule.at === null || isTime(t.schedule.at), `${where}: at`);
  assert.ok(strOrNull(t.schedule.tz, 64), `${where}: tz`);
  assert.ok(t.next_run_at === null || isTime(t.next_run_at), `${where}: next_run_at`);
  assert.ok(typeof t.status === 'string' && chars(t.status) >= 1 && chars(t.status) <= 32, where);
  assert.ok(t.attention_reason === null || ['undeliverable', 'missed', 'unparsable'].includes(t.attention_reason), where);
  if (t.attention_reason !== null) assert.equal(t.status, 'attention', where);
  assert.ok(t.last_run === null || ['delivered', 'failed', 'never'].includes(t.last_run), where);
  assert.ok(strOrNull(t.instruction_head, 80), `${where}: instruction_head`);
  assert.ok(Array.isArray(t.recent_deliveries) && t.recent_deliveries.length <= 30, where);
  assert.ok(t.recent_deliveries.every((r) => ['delivered', 'failed', 'timeout'].includes(r)), where);
  assert.ok(t.last_delivered_at === null || isTime(t.last_delivered_at), where);
  if (t.target !== null) {
    assert.deepEqual(keys(t.target), [...TARGET_KEYS].sort(), `${where}: target keys`);
    assert.ok(typeof t.target.channel === 'string' && chars(t.target.channel) >= 1 && chars(t.target.channel) <= 32, where);
    assert.ok(strOrNull(t.target.name, 60), where);
    assert.ok(['group', 'dm'].includes(t.target.kind), where);
  }
  const d = t.detail;
  assert.deepEqual(keys(d), [...DETAIL_KEYS].sort(), `${where}: detail keys`);
  assert.ok(typeof d.instruction === 'string' && chars(d.instruction) <= 8000, where);
  assert.ok(Array.isArray(d.runs) && d.runs.length <= 30, where);
  for (const r of d.runs) {
    assert.deepEqual(keys(r), [...RUN_KEYS].sort(), `${where}: run keys`);
    assert.ok(isTime(r.at) && ['delivered', 'failed', 'timeout', 'running'].includes(r.result), where);
  }
  assert.ok(Array.isArray(d.next_runs) && d.next_runs.length <= 5 && d.next_runs.every(isTime), where);
  assert.ok(d.skip_late_seconds === null || (Number.isInteger(d.skip_late_seconds) && d.skip_late_seconds >= 0), where);
  assert.ok(d.wait_idle === null || typeof d.wait_idle === 'boolean', where);
  assert.ok(strOrNull(d.last_error, 500), where);
  assert.ok(d.created_at === null || isTime(d.created_at), where);
  assert.ok(strOrNull(d.automation_name, 120), where);
}

test('contract shape: every task / schedule / target / detail has exactly the contract keys and types', () => {
  const once = (over) => row({ type: 'one-time', cron: null, recent: [], lastRunAt: null, ...over });
  const entries = [
    row(),
    row({ id: 'task-b', status: 'paused', name: '' }),
    row({ id: 'task-c', cron: null }),
    row({ id: 'task-d', type: 'interval', cron: null, intervalSeconds: 900 }),
    row({ id: 'task-e', type: 'interval', cron: null, intervalSeconds: null }),
    once({ id: 'task-f', nextRunAt: '2026-12-01T02:30:00.000Z' }),
    once({ id: 'task-g', nextRunAt: null }),
    once({ id: 'task-h', status: 'failed', nextRunAt: at(NOW - D) }),
    once({ id: 'task-i', status: 'completed', lastRunAt: at(NOW - D) }),
    row({ id: 'task-j', status: 'mystery' }),
    row({ id: 'task-k', nextRunAt: at(NOW - 5 * H), missThreshold: 60 }),
    row({ id: 'task-l', target: { kind: 'origin' }, reply: null, requireIdle: undefined, missThreshold: null }),
    row({ id: 'odd id/with space', name: 'x'.repeat(100), lastError: 'e'.repeat(900) }),
  ];
  const scheduler = entries.map((entry, i) => buildSchedulerTask({
    entry, detail: i === 0 ? { prompt: 'p'.repeat(9000), history: hist(...Array(40).fill('success'), 'started') } : null,
    localNo: i + 1, tz: 'Asia/Singapore', nowMs: NOW, home: HOME,
  }));
  const cron = buildCronTasks([
    '*/5 * * * * /home/alice/a.sh', '@reboot b.sh', '@daily c.sh', '0 0 30 2 * never.sh', '61 * * * * broken.sh', '* * * * *',
  ].join('\n'), { nowMs: NOW, tz: 'UTC', home: HOME });
  const tasks = [...scheduler, ...cron];
  assert.ok(tasks.every(Boolean));
  assert.ok(tasks.some((t) => t.target !== null) && tasks.some((t) => t.target === null));
  const kinds = new Set(tasks.map((t) => t.schedule.kind));
  assert.deepEqual([...kinds].sort(), ['cron', 'interval', 'once']);
  for (const t of tasks) assertContractTask(t);
  const skipLate = (id) => scheduler.find((t) => t.id === `scheduler-${id}`).detail.skip_late_seconds;
  assert.equal(skipLate('task-k'), 60);
  assert.equal(skipLate('task-l'), 300, 'no miss_threshold → the scheduler default (miss_threshold || 300)');

  const body = buildSnapshot({
    sources: [
      { source: 'scheduler', state: 'ok', last_ok_at: '2026-11-26T01:00:00Z' },
      { source: 'cron', state: 'failed', last_ok_at: null },
    ],
    tasks,
  });
  assert.deepEqual(keys(body), [...BODY_KEYS].sort());
  assert.ok(body.sources.length <= 8);
  for (const s of body.sources) {
    assert.deepEqual(keys(s), [...SOURCE_KEYS].sort());
    assert.ok(['ok', 'not_installed', 'failed'].includes(s.state));
    assert.ok(s.last_ok_at === null || isTime(s.last_ok_at));
  }
  assert.ok(body.tasks.length <= 200 && Number.isInteger(body.truncated_count) && body.truncated_count >= 0);
  assert.equal(new Set(body.tasks.map((t) => t.id)).size, body.tasks.length, 'ids unique');
  for (const t of body.tasks) assertContractTask(t);
});
