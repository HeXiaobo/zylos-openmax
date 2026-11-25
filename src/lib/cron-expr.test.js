import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron, parseCrontabLine, nextCronRuns, tzOffsetMs, systemTimeZone, isValidTimeZone, CRON_MACROS,
} from './cron-expr.js';

const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const runs = (expr, from, tz = 'UTC', n = 5) => nextCronRuns(parseCron(expr), Date.parse(from), tz, n).map(iso);

test('parseCron: valid five-field expressions', () => {
  for (const expr of [
    '* * * * *', '*/5 * * * *', '0 9 * * 1-5', '0 0,12 1 */2 *', '1-10/3 */5 */3 * *',
    '0 0 * jan-mar mon-fri', '0 0 * * SUN', '0 0 * * 7', '5/15 * * * *', '0 22 * * 1,3,5',
  ]) {
    assert.equal(parseCron(expr).ok, true, expr);
  }
});

test('parseCron: invalid expressions', () => {
  for (const expr of [
    '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *',
    '* * * * 8', '5-1 * * * *', '*/0 * * * *', '0 0 ? * *', '0 0 L * *', '0 0 * * 1#2', '0 0 15W * *',
    'a b c d e', '0 0 * foo *', '@every 5m', '@daily extra',
  ]) {
    assert.equal(parseCron(expr).ok, false, expr);
  }
});

test('parseCron: names, 7 = Sunday, steps and the * flags', () => {
  const s = parseCron('*/20 9-17/4 1,15 jan,JUL sun,7');
  assert.deepEqual([...s.minute], [0, 20, 40]);
  assert.deepEqual([...s.hour], [9, 13, 17]);
  assert.deepEqual([...s.dom], [1, 15]);
  assert.deepEqual([...s.month], [1, 7]);
  assert.deepEqual([...s.dow], [0]);
  assert.equal(s.domStar, false);
  assert.equal(s.dowStar, false);
  assert.deepEqual([...parseCron('50/5 * * * *').minute], [50, 55], 'cronie a/n = a-max/n');
  assert.equal(parseCron('* * */2 * *').domStar, true, 'a field starting with * counts as *');
});

test('parseCron: macros', () => {
  for (const [macro, expr] of Object.entries(CRON_MACROS)) {
    assert.deepEqual(parseCron(macro), parseCron(expr), macro);
    assert.equal(parseCron(macro.toUpperCase()).ok, true);
  }
  assert.deepEqual(parseCron('@reboot'), { ok: true, reboot: true });
});

test('parseCrontabLine: skips blanks, comments and environment lines', () => {
  for (const line of ['', '   ', '# m h dom mon dow command', '  # indented', 'MAILTO=me@example.com',
    'PATH=/usr/bin:/bin', 'SHELL = /bin/bash', 'CRON_TZ=Asia/Shanghai']) {
    assert.deepEqual(parseCrontabLine(line), { kind: 'skip' }, line);
  }
});

test('parseCrontabLine: jobs keep the command text as written', () => {
  const job = parseCrontabLine('*/5  *  * * 1-5   /usr/bin/backup.sh  --full  >> /tmp/log 2>&1');
  assert.equal(job.kind, 'job');
  assert.equal(job.schedule, '*/5 * * * 1-5');
  assert.equal(job.command, '/usr/bin/backup.sh  --full  >> /tmp/log 2>&1');
  const macro = parseCrontabLine('@daily  run.sh');
  assert.equal(macro.schedule, '@daily');
  assert.equal(macro.command, 'run.sh');
  assert.equal(parseCrontabLine('@reboot start.sh').spec.reboot, true);
});

test('parseCrontabLine: unparsable jobs keep the raw line', () => {
  for (const line of ['61 * * * * cmd', '* * * * *', '@every 5m cmd', '@daily', 'not a cron line at all']) {
    const p = parseCrontabLine(line);
    assert.equal(p.kind, 'job', line);
    assert.equal(p.unparsable, true, line);
    assert.equal(p.raw, line.trim());
  }
});

test('nextCronRuns: basic schedules in UTC', () => {
  assert.deepEqual(runs('*/15 * * * *', '2026-11-26T01:07:30Z', 'UTC', 3),
    ['2026-11-26T01:15:00Z', '2026-11-26T01:30:00Z', '2026-11-26T01:45:00Z']);
  assert.deepEqual(runs('0 9 * * 1-5', '2026-11-27T10:00:00Z', 'UTC', 3), // Fri 27 Nov 2026
    ['2026-11-30T09:00:00Z', '2026-12-01T09:00:00Z', '2026-12-02T09:00:00Z']);
  assert.deepEqual(runs('0 0 1 1 *', '2026-11-26T00:00:00Z', 'UTC', 2), ['2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z']);
  assert.deepEqual(runs('@hourly', '2026-11-26T01:00:00Z', 'UTC', 2), ['2026-11-26T02:00:00Z', '2026-11-26T03:00:00Z'],
    'strictly after the start');
});

test('nextCronRuns: Vixie day rule (both restricted = either matches)', () => {
  // 13th of the month OR a Friday.
  assert.deepEqual(runs('0 0 13 * 5', '2026-11-01T00:00:00Z', 'UTC', 4),
    ['2026-11-06T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-20T00:00:00Z', '2026-11-27T00:00:00Z']);
  // A * day-of-month: day-of-week alone decides.
  assert.deepEqual(runs('0 0 * * 0', '2026-11-26T00:00:00Z', 'UTC', 2), ['2026-11-29T00:00:00Z', '2026-12-06T00:00:00Z']);
  // */2 day-of-month starts with *, so both must match (odd days that are Mondays).
  assert.deepEqual(runs('0 0 */2 * 1', '2026-11-01T00:00:00Z', 'UTC', 2), ['2026-11-09T00:00:00Z', '2026-11-23T00:00:00Z']);
});

test('nextCronRuns: time zones', () => {
  assert.deepEqual(runs('0 10 * * *', '2026-11-26T01:00:00Z', 'Asia/Singapore', 2),
    ['2026-11-26T02:00:00Z', '2026-11-27T02:00:00Z']);
  assert.deepEqual(runs('30 9 * * *', '2026-11-26T00:00:00Z', 'Asia/Kolkata', 1), ['2026-11-26T04:00:00Z']);
});

test('nextCronRuns: DST gap runs after the change, ambiguous hour runs once (first)', () => {
  // America/New_York springs forward 2026-03-08 02:00 → 03:00.
  assert.deepEqual(runs('30 2 * * *', '2026-03-07T12:00:00Z', 'America/New_York', 2),
    ['2026-03-08T07:30:00Z', '2026-03-09T06:30:00Z']);
  // Europe/Berlin falls back 2026-10-25 03:00 CEST → 02:00 CET.
  assert.deepEqual(runs('30 2 * * *', '2026-10-24T12:00:00Z', 'Europe/Berlin', 2),
    ['2026-10-25T00:30:00Z', '2026-10-26T01:30:00Z']);
  const r = nextCronRuns(parseCron('*/20 * * * *'), Date.parse('2026-10-24T23:30:00Z'), 'Europe/Berlin', 20);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1], 'strictly increasing');
});

test('nextCronRuns: rare and impossible dates', () => {
  assert.deepEqual(runs('0 0 29 2 *', '2026-11-26T00:00:00Z', 'UTC', 2), ['2028-02-29T00:00:00Z', '2032-02-29T00:00:00Z']);
  assert.deepEqual(runs('0 0 30 2 *', '2026-11-26T00:00:00Z', 'UTC', 2), []);
  assert.deepEqual(runs('0 0 31 4 *', '2026-11-26T00:00:00Z', 'UTC', 1), []);
});

test('nextCronRuns: @reboot and invalid specs have no runs', () => {
  assert.deepEqual(nextCronRuns(parseCron('@reboot'), Date.now(), 'UTC'), []);
  assert.deepEqual(nextCronRuns(parseCron('bad'), Date.now(), 'UTC'), []);
  assert.deepEqual(nextCronRuns(null, Date.now(), 'UTC'), []);
});

test('tzOffsetMs', () => {
  assert.equal(tzOffsetMs(Date.parse('2026-11-26T00:00:00Z'), 'UTC'), 0);
  assert.equal(tzOffsetMs(Date.parse('2026-11-26T00:00:00Z'), 'Asia/Singapore'), 8 * 3600_000);
  assert.equal(tzOffsetMs(Date.parse('2026-07-01T00:00:00Z'), 'America/New_York'), -4 * 3600_000);
  assert.equal(tzOffsetMs(Date.parse('2026-01-01T00:00:00Z'), 'America/New_York'), -5 * 3600_000);
});

test('systemTimeZone: /etc/localtime link, then /etc/timezone, then the process zone', () => {
  const fail = () => { throw new Error('ENOENT'); };
  assert.equal(systemTimeZone({ readlink: () => '/usr/share/zoneinfo/Asia/Singapore', readFile: fail }), 'Asia/Singapore');
  assert.equal(systemTimeZone({ readlink: () => '/var/db/timezone/zoneinfo/Europe/Berlin', readFile: fail }), 'Europe/Berlin');
  assert.equal(systemTimeZone({ readlink: fail, readFile: () => 'America/New_York\n' }), 'America/New_York');
  assert.equal(systemTimeZone({ readlink: fail, readFile: fail, processZone: () => 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(systemTimeZone({ readlink: () => '/usr/share/zoneinfo/Not/AZone', readFile: () => 'bogus', processZone: () => 'nope' }), 'UTC');
  assert.equal(isValidTimeZone('Asia/Singapore'), true);
  assert.equal(isValidTimeZone(''), false);
});
