import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { nextWallClockTime, wallTimeToInstant, describeLocalMinute, canonicalTimeZone } from '../lib/local-time.js';

// core.pause_self: the Agent pauses ITSELF after an automation run and the
// platform resumes it at a time. The CLI runs main() on import, so it is
// exercised as a subprocess against a fake Core (the real endpoint is
// POST /api/v1/agents/{member_id}/runtime/self-pause). OPENMAX_TEST_NOW pins
// the clock (test-only).

const cliPath = fileURLToPath(new URL('./core.js', import.meta.url));
const ORG = 'org-a';
const SELF = 'agent-m1';
const ISSUE = '0193aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const PATH = `/api/v1/agents/${SELF}/runtime/self-pause`;
const TOKEN = 'pause-self-test-token';
const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

function makeHome(t, { config = true, envTz } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-self-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(comp, { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(comp, 'config.json'), JSON.stringify({
      orgs: { a: { enabled: true, org_id: ORG, org_name: 'A', self: { member_id: SELF } } },
    }));
  }
  if (envTz) fs.writeFileSync(path.join(home, 'zylos/.env'), `TZ=${envTz}\n`);
  return home;
}

// Echoes the request like Core does: same resume_at / time_zone back.
const echo = (status = 'ok', extra = {}) => (_url, body) => ({
  status: status === 'pause_pending' ? 202 : 200,
  body: {
    data: {
      plan_id: status === 'ok' ? '' : 'plan-1',
      issue_id: body.issue_id, status, resume_at: body.resume_at, time_zone: body.time_zone, already: false, ...extra,
    },
    request_id: 'r',
  },
});

const coreError = (status, { code, detail }) => ({
  status,
  body: { error: { title: 'x', status, detail, ...(code ? { code } : {}) }, request_id: 'r', server_time: '2026-11-15T00:00:00Z' },
});

async function withCore(t, respond, { home = makeHome(t), env = {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, ...(body ? { body } : {}) });
      const out = respond(req.url, body);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const run = (params, extraEnv = {}) => new Promise((resolve) => {
    execFile(process.execPath, [cliPath, 'core.pause_self', JSON.stringify(params)], {
      env: {
        ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), TZ: '',
        COCO_ORG_ID: ORG, COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
        COCO_AUTH_TOKEN: TOKEN, COCO_USER_TOKEN: '', COCO_RPC_LOG: '0', OPENMAX_TEST_NOW: '',
        ...env, ...extraEnv,
      },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
  return { requests, run };
}

const ok = (result) => {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};

// ---- resume time ------------------------------------------------------------

for (const c of [
  { name: 'Fri 20:00 Shanghai + skipWeekend → Mon 08:30', now: '2026-11-13T20:00:00+08:00', skipWeekend: true,
    resumeAt: '2026-11-16T00:30:00Z', local: '2026-11-16 08:30 (+08:00)', weekday: 'Mon' },
  { name: 'Fri 20:00 Shanghai without skipWeekend → Sat 08:30', now: '2026-11-13T20:00:00+08:00',
    resumeAt: '2026-11-14T00:30:00Z', local: '2026-11-14 08:30 (+08:00)', weekday: 'Sat' },
  { name: 'Sat 20:00 Shanghai + skipWeekend → Mon 08:30 (Sunday moves too)', now: '2026-11-14T20:00:00+08:00', skipWeekend: true,
    resumeAt: '2026-11-16T00:30:00Z', local: '2026-11-16 08:30 (+08:00)', weekday: 'Mon' },
  { name: 'Tue 20:00 → Wed 08:30', now: '2026-11-17T20:00:00+08:00', skipWeekend: true,
    resumeAt: '2026-11-18T00:30:00Z', local: '2026-11-18 08:30 (+08:00)', weekday: 'Wed' },
  { name: '01:00 → same day 08:30', now: '2026-11-17T01:00:00+08:00', skipWeekend: true,
    resumeAt: '2026-11-17T00:30:00Z', local: '2026-11-17 08:30 (+08:00)', weekday: 'Tue' },
  { name: '07:59 → today 08:30 (31 minutes away)', now: '2026-11-17T07:59:00+08:00',
    resumeAt: '2026-11-17T00:30:00Z', local: '2026-11-17 08:30 (+08:00)', weekday: 'Tue' },
  { name: '08:00 exactly → today 08:30 (30 minutes is enough)', now: '2026-11-17T08:00:00+08:00',
    resumeAt: '2026-11-17T00:30:00Z', local: '2026-11-17 08:30 (+08:00)', weekday: 'Tue' },
  { name: '08:30 exactly → tomorrow 08:30 (strictly after now)', now: '2026-11-17T08:30:00+08:00',
    resumeAt: '2026-11-18T00:30:00Z', local: '2026-11-18 08:30 (+08:00)', weekday: 'Wed' },
  { name: '08:31 → tomorrow 08:30', now: '2026-11-17T08:31:00+08:00',
    resumeAt: '2026-11-18T00:30:00Z', local: '2026-11-18 08:30 (+08:00)', weekday: 'Wed' },
  { name: 'Sat 08:25 + skipWeekend → Mon 08:30 (not too close once moved)', now: '2026-11-14T08:25:00+08:00', skipWeekend: true,
    resumeAt: '2026-11-16T00:30:00Z', local: '2026-11-16 08:30 (+08:00)', weekday: 'Mon' },
  { name: 'New York: Sat 20:00 EST → Sun 08:30 EDT (clocks go forward overnight)', now: '2026-03-07T20:00:00-05:00', zone: NY,
    resumeAt: '2026-03-08T12:30:00Z', local: '2026-03-08 08:30 (-04:00)', weekday: 'Sun' },
  { name: 'New York: Fri 20:00 EST + skipWeekend → Mon 08:30 EDT', now: '2026-03-06T20:00:00-05:00', zone: NY, skipWeekend: true,
    resumeAt: '2026-03-09T12:30:00Z', local: '2026-03-09 08:30 (-04:00)', weekday: 'Mon' },
  { name: 'New York: Sat 20:00 EDT → Sun 08:30 EST (clocks go back overnight)', now: '2026-10-31T20:00:00-04:00', zone: NY,
    resumeAt: '2026-11-01T13:30:00Z', local: '2026-11-01 08:30 (-05:00)', weekday: 'Sun' },
]) {
  test(`resume time: ${c.name}`, async (t) => {
    const { run, requests } = await withCore(t, echo());
    const zone = c.zone ?? SH;
    const out = ok(await run({ issueId: ISSUE, at: '08:30', skipWeekend: c.skipWeekend, timeZone: zone, dryRun: true },
      { OPENMAX_TEST_NOW: c.now }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.resume_at, c.resumeAt);
    assert.equal(requests[0].body.time_zone, zone);
    assert.equal(out.resume_at, c.resumeAt);
    assert.equal(out.resume_local, c.local);
    assert.equal(out.resume_weekday, c.weekday);
    assert.equal(out.time_zone, zone);
  });
}

test('resume time: the zone defaults to the Agent\'s TZ, then UTC', async (t) => {
  const now = { OPENMAX_TEST_NOW: '2026-11-17T20:00:00+08:00' };
  const withTz = await withCore(t, echo(), { home: makeHome(t, { envTz: SH }) });
  const a = ok(await withTz.run({ issueId: ISSUE, at: '08:30', dryRun: true }, now));
  assert.equal(withTz.requests[0].body.time_zone, SH);
  assert.equal(a.resume_local, '2026-11-18 08:30 (+08:00)');

  const bare = await withCore(t, echo());
  const b = ok(await bare.run({ issueId: ISSUE, at: '08:30', dryRun: true }, now));
  assert.equal(bare.requests[0].body.time_zone, 'UTC');
  assert.equal(b.resume_at, '2026-11-18T08:30:00Z');
  assert.equal(b.resume_local, '2026-11-18 08:30 (+00:00)');
});

test('resume time: an explicit resumeAt is sent unchanged and rendered in the zone', async (t) => {
  const { run, requests } = await withCore(t, echo());
  const out = ok(await run({ issue_id: ISSUE, resume_at: '2026-11-16T08:30:00+08:00', time_zone: SH, dry_run: true }));
  assert.equal(requests[0].body.resume_at, '2026-11-16T08:30:00+08:00');
  assert.equal(out.resume_at, '2026-11-16T08:30:00+08:00');
  assert.equal(out.resume_local, '2026-11-16 08:30 (+08:00)');
  assert.equal(out.resume_weekday, 'Mon');
});

const TOO_CLOSE = {
  ok: false, code: 'SELF_PAUSE_TOO_CLOSE',
  reason: 'the resume time is less than 30 minutes away; stay running instead of pausing', retryable: false,
};

for (const c of [
  { name: '08:25 with at 08:30 (check)', now: '2026-11-17T08:25:00+08:00', dryRun: true },
  { name: '08:01 with at 08:30 (pause), 29 minutes', now: '2026-11-17T08:01:00+08:00', dryRun: false },
  { name: '08:25 with at 08:30, env-only (no /me lookup either)', now: '2026-11-17T08:25:00+08:00', dryRun: true, config: false },
]) {
  test(`too close: ${c.name} → stdout SELF_PAUSE_TOO_CLOSE, exit 1, no HTTP`, async (t) => {
    const { run, requests } = await withCore(t, echo(), { home: makeHome(t, { config: c.config ?? true }) });
    const result = await run({ issueId: ISSUE, at: '08:30', timeZone: SH, dryRun: c.dryRun }, { OPENMAX_TEST_NOW: c.now });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out, { ...TOO_CLOSE, dry_run: c.dryRun });
    assert.deepEqual(Object.keys(out), ['ok', 'dry_run', 'code', 'reason', 'retryable']);
    assert.equal(requests.length, 0);
  });
}

test('check and pause straddle the boundary: the pause sends the check\'s resume_at, so the time does not move', async (t) => {
  const { run, requests } = await withCore(t, echo('ok'));
  // 07:59: the check gets today 08:30.
  const check = ok(await run({ issueId: ISSUE, at: '08:30', timeZone: SH, dryRun: true }, { OPENMAX_TEST_NOW: '2026-11-17T07:59:00+08:00' }));
  assert.equal(check.resume_at, '2026-11-17T00:30:00Z');
  // 08:05, after delivering: repeating `at` would now be refused as too close
  // (and after 08:30 it would move to tomorrow) …
  const repeated = await run({ issueId: ISSUE, at: '08:30', timeZone: SH }, { OPENMAX_TEST_NOW: '2026-11-17T08:05:00+08:00' });
  assert.equal(JSON.parse(repeated.stdout).code, 'SELF_PAUSE_TOO_CLOSE');
  // … while resumeAt = the check's resume_at sends exactly the checked time, at
  // 08:05 and on a retry at 08:40 alike.
  for (const now of ['2026-11-17T08:05:00+08:00', '2026-11-17T08:40:00+08:00']) {
    ok(await run({ issueId: ISSUE, resumeAt: check.resume_at, timeZone: SH }, { OPENMAX_TEST_NOW: now }));
  }
  assert.deepEqual(requests.map((r) => [r.body.resume_at, r.body.dry_run]), [
    ['2026-11-17T00:30:00Z', true], ['2026-11-17T00:30:00Z', false], ['2026-11-17T00:30:00Z', false],
  ]);
});

test('an explicit resumeAt only 15 minutes ahead is sent unchanged (no local 30-minute rule)', async (t) => {
  const { run, requests } = await withCore(t, echo('paused'));
  const out = ok(await run({ issueId: ISSUE, resumeAt: '2026-11-17T08:15:00+08:00', timeZone: SH },
    { OPENMAX_TEST_NOW: '2026-11-17T08:00:00+08:00' }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.resume_at, '2026-11-17T08:15:00+08:00');
  assert.equal(out.status, 'paused');
  assert.equal(out.resume_local, '2026-11-17 08:15 (+08:00)');
});

test('canonicalTimeZone fixes only the case of a valid name', () => {
  assert.equal(canonicalTimeZone('asia/shanghai'), 'Asia/Shanghai');
  assert.equal(canonicalTimeZone(' America/New_York '), 'America/New_York');
  // Intl itself would rename it to Asia/Calcutta; the platform lists both.
  assert.equal(canonicalTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(canonicalTimeZone('Mars/Olympus'), 'Mars/Olympus');
});

test('wall clock → instant: a skipped time moves forward by the gap, a repeated time takes the earlier instant', () => {
  // 2026-03-08 02:30 does not exist in New York (02:00 EST → 03:00 EDT).
  const gap = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
  assert.equal(new Date(gap).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(describeLocalMinute(gap, NY).local, '2026-03-08 03:30 (-04:00)');
  // 2026-11-01 01:30 happens twice (EDT, then EST): the first one.
  const twice = wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
  assert.equal(new Date(twice).toISOString(), '2026-11-01T05:30:00.000Z');
  // Zones with non-hour offsets and the date line.
  const kolkata = nextWallClockTime({ hour: 8, minute: 30, timeZone: 'Asia/Kolkata', now: Date.parse('2026-11-17T20:00:00+05:30') });
  assert.equal(new Date(kolkata).toISOString(), '2026-11-18T03:00:00.000Z');
  const kiritimati = nextWallClockTime({ hour: 8, minute: 30, timeZone: 'Pacific/Kiritimati', now: Date.parse('2026-11-17T20:00:00+14:00') });
  assert.equal(describeLocalMinute(kiritimati, 'Pacific/Kiritimati').local, '2026-11-18 08:30 (+14:00)');
});

// ---- request / response ------------------------------------------------------

test('dry run: POSTs the check to the Agent\'s own member id and prints the result', async (t) => {
  const { run, requests } = await withCore(t, echo('ok'));
  const out = ok(await run({ issueId: ISSUE, at: '08:30', skipWeekend: true, timeZone: SH, dryRun: true },
    { OPENMAX_TEST_NOW: '2026-11-13T20:00:00+08:00' }));
  assert.deepEqual(requests, [{
    method: 'POST', url: PATH, authorization: `Bearer ${TOKEN}`,
    body: { issue_id: ISSUE, resume_at: '2026-11-16T00:30:00Z', time_zone: SH, dry_run: true },
  }]);
  assert.deepEqual(out, {
    ok: true, dry_run: true, status: 'ok', plan_id: '', plan_status: '', resume_scheduled: null, issue_id: ISSUE, resume_at: '2026-11-16T00:30:00Z',
    resume_local: '2026-11-16 08:30 (+08:00)', resume_weekday: 'Mon', time_zone: SH, already: false,
  });
});

for (const status of ['paused', 'pause_pending']) {
  test(`execute: dry_run false → ${status}`, async (t) => {
    const { run, requests } = await withCore(t, echo(status));
    const out = ok(await run({ issueId: ISSUE, at: '08:30', skipWeekend: true, timeZone: SH },
      { OPENMAX_TEST_NOW: '2026-11-13T20:00:00+08:00' }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, PATH);
    assert.deepEqual(requests[0].body, { issue_id: ISSUE, resume_at: '2026-11-16T00:30:00Z', time_zone: SH, dry_run: false });
    assert.deepEqual(out, {
      ok: true, dry_run: false, status, plan_id: 'plan-1', plan_status: '', resume_scheduled: true, issue_id: ISSUE, resume_at: '2026-11-16T00:30:00Z',
      resume_local: '2026-11-16 08:30 (+08:00)', resume_weekday: 'Mon', time_zone: SH, already: false,
    });
  });
}

test('execute again: an existing plan is reported with its own resume time (already:true)', async (t) => {
  const { run } = await withCore(t, (_url, body) => ({
    body: { data: { plan_id: 'plan-1', issue_id: body.issue_id, status: 'paused', resume_at: '2026-11-17T00:30:00Z', time_zone: SH, already: true }, request_id: 'r' },
  }));
  const out = ok(await run({ issueId: ISSUE, at: '09:00', timeZone: 'UTC' }, { OPENMAX_TEST_NOW: '2026-11-16T20:00:00+08:00' }));
  assert.equal(out.already, true);
  assert.equal(out.resume_at, '2026-11-17T00:30:00Z');
  assert.equal(out.time_zone, SH);
  assert.equal(out.resume_local, '2026-11-17 08:30 (+08:00)');
});

test('an earlier refused or cancelled pause of this run (status not_paused) is reported as not paused', async (t) => {
  const { run, requests } = await withCore(t, (_url, body) => ({
    body: { data: { plan_id: 'plan-1', issue_id: body.issue_id, status: 'not_paused', plan_status: 'cancelled', resume_at: '2026-11-17T00:30:00Z', time_zone: SH, already: true }, request_id: 'r' },
  }));
  const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out, { ok: false, dry_run: false, code: 'SELF_PAUSE_NOT_PAUSED', reason: "this run's pause was not confirmed (it was refused, cancelled, or still unconfirmed close to the resume time); the Agent stays running", retryable: false });
  assert.equal(requests.length, 1);
});

test('plan_status from the platform is passed through', async (t) => {
  const { run } = await withCore(t, (_url, body) => ({
    body: { data: { plan_id: 'plan-1', issue_id: body.issue_id, status: 'paused', plan_status: 'pending', resume_at: '2026-11-17T00:30:00Z', time_zone: SH, already: false }, request_id: 'r' },
  }));
  const out = ok(await run({ issueId: ISSUE, resumeAt: '2026-11-17T08:30:00+08:00', timeZone: SH }));
  assert.equal(out.plan_status, 'pending');
  assert.equal(out.status, 'paused');
  assert.equal(out.resume_scheduled, true);
});

test('paused with a cancelled plan (a person intervened) reports resume_scheduled:false', async (t) => {
  const { run } = await withCore(t, (_url, body) => ({
    body: { data: { plan_id: 'plan-1', issue_id: body.issue_id, status: 'paused', plan_status: 'cancelled', resume_at: '2026-11-17T00:30:00Z', time_zone: SH, already: false }, request_id: 'r' },
  }));
  const out = ok(await run({ issueId: ISSUE, resumeAt: '2026-11-17T08:30:00+08:00', timeZone: SH }));
  assert.equal(out.status, 'paused');
  assert.equal(out.plan_status, 'cancelled');
  assert.equal(out.resume_scheduled, false);
});

for (const planStatus of ['resumed', 'failed']) {
  test(`already:true with plan_status ${planStatus} → resume_scheduled:false (this run's plan is settled)`, async (t) => {
    const { run } = await withCore(t, (_url, body) => ({
      body: { data: { plan_id: 'plan-1', issue_id: body.issue_id, status: 'paused', plan_status: planStatus, resume_at: '2026-11-17T00:30:00Z', time_zone: SH, already: true }, request_id: 'r' },
    }));
    const out = ok(await run({ issueId: ISSUE, resumeAt: '2026-11-17T08:30:00+08:00', timeZone: SH }));
    assert.equal(out.already, true);
    assert.equal(out.status, 'paused');
    assert.equal(out.plan_status, planStatus);
    assert.equal(out.resume_scheduled, false);
  });
}

test('member id: a caller-supplied memberId / member_id is ignored; the Agent\'s own id is used', async (t) => {
  const { run, requests } = await withCore(t, echo());
  ok(await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH, dryRun: true, memberId: 'other-agent', member_id: 'other-agent-2' }));
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`POST ${PATH}`]);
});

test('member id: env-only deployment (no config entry) reads it from /me with the org token', async (t) => {
  const { run, requests } = await withCore(t, (url, body) => (url === '/api/v1/me'
    ? { body: { data: { member_id: 'agent-from-me', org_id: ORG }, request_id: 'r' } }
    : echo()(url, body)), { home: makeHome(t, { config: false }) });
  ok(await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', dryRun: true }));
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    'GET /api/v1/me', 'POST /api/v1/agents/agent-from-me/runtime/self-pause',
  ]);
});

test('a 2xx without a status is an error, not a success', async (t) => {
  const { run } = await withCore(t, () => ({ body: { data: {}, request_id: 'r' } }));
  const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', dryRun: true });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /unexpected response/);
});

// ---- invalid input: 400, no HTTP ---------------------------------------------

test('invalid input is refused with 400 before any HTTP', async (t) => {
  const { run, requests } = await withCore(t, echo());
  const base = { issueId: ISSUE, at: '08:30' };
  for (const params of [
    { at: '08:30' },
    { issueId: '  ', at: '08:30' },
    { issueId: ISSUE },
    { issueId: ISSUE, at: '08:30', resumeAt: '2026-11-16T08:30:00+08:00' },
    { ...base, timeZone: 'Mars/Olympus' },
    { ...base, timeZone: '+08:00' },
    { ...base, timeZone: '' },
    { issueId: ISSUE, at: '24:00' },
    { issueId: ISSUE, at: '8:5' },
    { issueId: ISSUE, at: '0830' },
    { issueId: ISSUE, at: '08:60' },
    { issueId: ISSUE, at: 830 },
    { issueId: ISSUE, resumeAt: 'tomorrow 08:30' },
    { issueId: ISSUE, resumeAt: '2026-11-16 08:30' },
    { issueId: ISSUE, resumeAt: '2026-11-16T08:30+08:00' },
    { issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', skipWeekend: true },
    { ...base, dryRun: 'true' },
    { ...base, skipWeekend: 1 },
  ]) {
    const result = await run(params);
    assert.equal(result.code, 1, JSON.stringify(params));
    assert.equal(result.stdout, '', JSON.stringify(params));
    const err = JSON.parse(result.stderr);
    assert.equal(err.status, 400, JSON.stringify(params));
    assert.match(err.error, /^core\.pause_self: /);
  }
  assert.equal(requests.length, 0);
});

test('an invalid TZ in the Agent\'s settings is a 400 unless timeZone is passed', async (t) => {
  const { run, requests } = await withCore(t, echo(), { home: makeHome(t, { envTz: 'Not/AZone' }) });
  const bad = await run({ issueId: ISSUE, at: '08:30', dryRun: true });
  assert.equal(JSON.parse(bad.stderr).status, 400);
  assert.match(JSON.parse(bad.stderr).error, /pass timeZone/);
  assert.equal(requests.length, 0);
  ok(await run({ issueId: ISSUE, at: '08:30', timeZone: SH, dryRun: true }, { OPENMAX_TEST_NOW: '2026-11-17T20:00:00+08:00' }));
  assert.equal(requests.length, 1);
});

// ---- refusals: stdout {ok:false}, exit 1 -------------------------------------

// send: what Core answers (SELF_PAUSE_* as `code`; billing refusals without a
// code, Billing's reason in `detail`, at Billing's status); expect: the output.
for (const c of [
  { status: 422, send: { code: 'SELF_PAUSE_RESUME_AT_OUT_OF_RANGE' }, reason: /10 minutes and at most 7 days/ },
  { status: 404, send: { code: 'SELF_PAUSE_RUN_NOT_FOUND' }, reason: /not found/ },
  { status: 409, send: { code: 'SELF_PAUSE_NOT_AUTOMATION_RUN' }, reason: /not an automation run/ },
  { status: 409, send: { code: 'SELF_PAUSE_RUN_TOO_OLD' }, reason: /too long ago/ },
  { status: 403, send: { code: 'SELF_PAUSE_OWNER_NOT_ADMIN' }, reason: /^the automation's owner must be an organization owner or admin$/ },
  { status: 409, send: { code: 'SELF_PAUSE_RUN_NOT_DELIVERED' }, dryRun: false, reason: /^deliver the run result first .*then call core\.pause_self again$/ },
  { status: 409, send: { code: 'SELF_PAUSE_SOMETHING_NEW', detail: 'a new refusal' }, reason: /^a new refusal$/ },
  { status: 409, send: { detail: 'AGENT_OPERATION_IN_PROGRESS' }, dryRun: false, reason: /in progress/ },
  { status: 409, send: { detail: 'ADDON_INVALID_STATE' }, dryRun: false, reason: /current state/ },
  { status: 409, send: { detail: 'INSUFFICIENT_BALANCE' }, dryRun: false, reason: /credits/ },
  { status: 409, send: { detail: 'SOME_NEW_BILLING_REASON' }, dryRun: false, reason: /refused .*SOME_NEW_BILLING_REASON/ },
  // Not only 409: Billing's status decides (these fail if the check is 409-only).
  { status: 404, send: { detail: 'ADDON_NOT_FOUND' }, dryRun: false, reason: /^the Agent has no billing add-on to pause$/ },
  { status: 403, send: { detail: 'PERMISSION_DENIED' }, dryRun: false, reason: /^the platform does not allow this Agent to be paused \(permission denied\)$/ },
  { status: 403, send: { detail: 'OPERATOR_NOT_ALLOWED' }, dryRun: false, expect: 'OPERATOR_NOT_ALLOWED', reason: /permission denied/ },
  { status: 403, send: { detail: 'operator may not pause this agent' }, dryRun: false, expect: 'PERMISSION_DENIED', reason: /permission denied/ },
  { status: 412, send: { detail: 'FAILED_PRECONDITION' }, dryRun: false, reason: /refused .*FAILED_PRECONDITION/ },
  { status: 404, plain: true, expect: 'SELF_PAUSE_UNAVAILABLE', reason: /does not support/ },
  { status: 404, send: { detail: 'Not Found' }, expect: 'SELF_PAUSE_UNAVAILABLE', reason: /does not support/ },
]) {
  const dryRun = c.dryRun ?? true;
  const code = c.expect ?? c.send.code ?? c.send.detail;
  test(`refusal: ${c.status} ${JSON.stringify(c.send ?? 'plain text')} → stdout {ok:false, code:${code}}, exit 1`, async (t) => {
    const respond = c.plain
      ? () => ({ status: 404, body: '404 page not found' })
      : () => coreError(c.status, { detail: 'refused', ...c.send });
    const { run, requests } = await withCore(t, respond);
    const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH, dryRun });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const out = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(out), ['ok', 'dry_run', 'code', 'reason', 'retryable']);
    assert.equal(out.ok, false);
    assert.equal(out.dry_run, dryRun);
    assert.equal(out.code, code);
    assert.match(out.reason, c.reason);
    assert.equal(out.retryable, false);
    assert.equal(requests.length, 1);
  });
}

for (const c of [
  { name: '403 with a code (the platform\'s own authorization: not this Agent)', respond: () => coreError(403, { code: 'AUTH_FORBIDDEN', detail: 'forbidden' }), status: 403 },
  { name: '400 without a code (free-text detail)', respond: () => coreError(400, { detail: 'invalid time zone' }), status: 400 },
  { name: '409 with another code', respond: () => coreError(409, { code: 'CONFLICT', detail: 'AGENT_OPERATION_IN_PROGRESS' }), status: 409 },
  { name: '503 (uncertain, safe to retry the same call)', respond: () => coreError(503, { detail: 'billing command unavailable' }), status: 503 },
  { name: '502', respond: () => coreError(502, { code: 'SELF_PAUSE_RUN_NOT_FOUND', detail: 'bad gateway' }), status: 502 },
]) {
  test(`error path: ${c.name} → stderr, exit 1, sent once`, async (t) => {
    const { run, requests } = await withCore(t, c.respond);
    const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).status, c.status);
    assert.equal(requests.length, 1);
  });
}

test('error path: a network failure → stderr, exit 1', async (t) => {
  const { run } = await withCore(t, echo());
  const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH }, { COCO_API_URL: 'http://127.0.0.1:1' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(JSON.parse(result.stderr).error);
});

test('401 is not replayed (retryOn401:false)', async (t) => {
  const { run, requests } = await withCore(t, () => coreError(401, { detail: 'token expired' }));
  const result = await run({ issueId: ISSUE, resumeAt: '2026-11-16T08:30:00+08:00', timeZone: SH });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).status, 401);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`POST ${PATH}`]);
});

test('help lists core.pause_self', async (t) => {
  const result = await new Promise((resolve) => execFile(process.execPath, [cliPath, '--help'], (error, stdout) => resolve({ error, stdout })));
  assert.ifError(result.error);
  assert.match(result.stdout, /core\.pause_self +\{issueId, at \| resumeAt, skipWeekend\?, timeZone\?, dryRun\?\}/);
});
