import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChannelLivenessReporter,
  decideChannelOnline,
  CHANNEL_TYPES,
} from './channel-liveness-reporter.js';
import { CHANNEL_COMPONENT } from './channel-connector.js';

const noop = () => {};
const apiPath = (p) => `/api/v1${p}`;

// Build a pm2 jlist-derived Map (name → online bool) for the given set of
// online pm2 service names; every other known service is offline.
function pm2Map(onlineServices = []) {
  const m = new Map();
  for (const ct of CHANNEL_TYPES) {
    m.set(CHANNEL_COMPONENT[ct].pm2Service, onlineServices.includes(CHANNEL_COMPONENT[ct].pm2Service));
  }
  // A couple of non-IM processes that must be ignored by the reporter.
  m.set('zylos-openmax', true);
  m.set('zylos-dashboard', true);
  return m;
}

function orgMap(entries) {
  return new Map(entries.map((o) => [o.slug, o]));
}

function harness({ readPm2Statuses, orgs, putForOrg }) {
  const puts = [];
  const warns = [];
  const logs = [];
  const defaultPut = async (orgId, path, payload) => { puts.push({ orgId, path, payload }); };
  const report = createChannelLivenessReporter(orgMap(orgs), {
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    apiPath,
    readPm2Statuses,
    putForOrg: putForOrg || defaultPut,
  });
  return { report, puts, warns, logs };
}

test('CHANNEL_TYPES is exactly the 13 cws-connect catalog values', () => {
  assert.equal(CHANNEL_TYPES.length, 13);
  assert.deepEqual(
    [...CHANNEL_TYPES].sort(),
    ['dingtalk', 'discord', 'feishu', 'lark', 'line', 'ms_teams', 'slack',
     'telegram', 'wechat', 'wecom', 'whatsapp', 'whatsapp_business', 'zalo'].sort(),
  );
});

test('healthy pm2: single PUT of 13 channels with correct online flags to the primary org self.member_id', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map(['zylos-telegram', 'zylos-slack']),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].orgId, 'org-A');
  assert.equal(puts[0].path, '/api/v1/agents/m-A/channel-liveness');
  const { channels } = puts[0].payload;
  assert.equal(channels.length, 13);
  // Body carries no identity — only channels.
  assert.deepEqual(Object.keys(puts[0].payload), ['channels']);
  const online = channels.filter((c) => c.online).map((c) => c.channel_type).sort();
  assert.deepEqual(online, ['slack', 'telegram']);
  assert.equal(warns.length, 0);
});

test('safety guard: pm2 jlist failure (null) → no PUT, warn once', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => null,
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  await report(); // second failing tick must NOT warn again
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /pm2 jlist unavailable/);
});

test('safety guard: empty pm2 map → no PUT, warn once (never all-offline report)', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => new Map(),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
});

test('pm2 recovers after a failure → once-guard re-arms and reports', async () => {
  let call = 0;
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => (++call === 1 ? null : pm2Map(['zylos-lark'])),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report(); // fails, warns once
  await report(); // recovers, PUTs
  assert.equal(puts.length, 1);
  assert.equal(warns.length, 1);
  const online = puts[0].payload.channels.filter((c) => c.online).map((c) => c.channel_type);
  assert.deepEqual(online, ['lark']);
});

test('multi-org: reports ONCE to the primary (first) org only — a single PUT', async () => {
  const { report, puts } = harness({
    readPm2Statuses: async () => pm2Map(['zylos-discord']),
    orgs: [
      { slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } },
      { slug: 'orgB', org_id: 'org-B', self: { member_id: 'm-B' } },
    ],
  });
  await report();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].orgId, 'org-A');
  assert.equal(puts[0].path, '/api/v1/agents/m-A/channel-liveness');
});

test('primary org without self.member_id → warned, no PUT (does not fall through to other orgs)', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [
      { slug: 'orgA', org_id: 'org-A', self: {} },
      { slug: 'orgB', org_id: 'org-B', self: { member_id: 'm-B' } },
    ],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.match(warns.find((w) => /orgA/.test(w)), /primary org has no self\.member_id/);
});

test('persistent 404 → disable on first 404, warn once, and STOP issuing the PUT (no error.log flood)', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('page not found'); e.status = 404; throw e; };
  const { report, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
    putForOrg,
  });
  // First tick fires the PUT (gets 404 → disables). Next ~10 ticks must NOT
  // fire it — this is the flood fix: the HTTP client only logs its [rpc] pair
  // when the PUT is actually issued.
  for (let i = 0; i < 11; i++) await report();
  assert.equal(putCalls, 1, 'PUT issued exactly once, then suppressed');
  const disableWarns = warns.filter((w) => /returns 404 .*disabling reporter/.test(w));
  assert.equal(disableWarns.length, 1, 'the 404 is logged exactly once, not every tick');
});

test('404 backoff re-probes after reprobeEveryTicks and stays quiet if still 404', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('not found'); e.status = 404; throw e; };
  const puts = [];
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    reprobeEveryTicks: 3,
  });
  await report();            // tick 1: PUT → 404 → disabled (putCalls=1)
  await report();            // tick 2: disabled, skip
  await report();            // tick 3: disabled, skip (ticksSinceDisabled=2 < 3)
  assert.equal(putCalls, 1, 'no PUT during the backoff window');
  await report();            // tick 4: re-probe → PUT → still 404 (putCalls=2)
  assert.equal(putCalls, 2, 're-probe issues exactly one PUT');
  const disableWarns = warns.filter((w) => /disabling reporter/.test(w));
  assert.equal(disableWarns.length, 1, 're-probe that still 404s does not re-warn');
});

test('404 backoff self-heals: a later successful probe re-enables the reporter', async () => {
  let call = 0;
  const putForOrg = async () => {
    call += 1;
    if (call === 1) { const e = new Error('not found'); e.status = 404; throw e; }
    // subsequent calls succeed
  };
  const logs = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: (m) => logs.push(m), warn: noop, apiPath, readPm2Statuses: async () => pm2Map(['zylos-lark']), putForOrg,
    reprobeEveryTicks: 2,
  });
  await report();            // 404 → disabled
  await report();            // skipped (ticksSinceDisabled=1 < 2)
  await report();            // re-probe → succeeds → re-enabled
  await report();            // now enabled again → reports normally every tick
  assert.equal(call, 3, 'two successful PUTs after the single 404 (probe + next tick)');
  assert.ok(logs.some((m) => /endpoint recovered/.test(m)), 'recovery is announced');
});

test('disable404Threshold: stays retrying until the threshold, then disables', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('nf'); e.status = 404; throw e; };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    disable404Threshold: 3, reprobeEveryTicks: 100,
  });
  await report(); await report(); // 2 x 404, below threshold → still trying, not disabled
  assert.equal(putCalls, 2);
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0, 'not yet disabled');
  await report();                 // 3rd 404 hits threshold → disable
  assert.equal(putCalls, 3);
  await report();                 // disabled → skipped
  assert.equal(putCalls, 3, 'no further PUT after the 3rd 404 disables it');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 1);
});

test('non-404 errors keep retrying and never disable the reporter', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('boom'); e.status = 503; throw e; };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
  });
  await report(); await report(); await report();
  assert.equal(putCalls, 3, '5xx keeps retrying every tick — unchanged behavior');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0);
  assert.ok(warns.filter((w) => /report failed: boom/.test(w)).length >= 1);
});

test('a 404 streak interrupted by a non-404 error resets the streak', async () => {
  let call = 0;
  // 404, then a transient 5xx, then 404 again — with threshold 2 the reporter
  // must NOT disable, because the 5xx reset the consecutive-404 count.
  const putForOrg = async () => {
    call += 1;
    const e = new Error('x');
    e.status = call === 2 ? 503 : 404;
    throw e;
  };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    disable404Threshold: 2, reprobeEveryTicks: 100,
  });
  await report(); // 404 (streak=1)
  await report(); // 503 (streak reset to 0)
  await report(); // 404 (streak=1, below threshold 2)
  assert.equal(call, 3, 'all three ticks issued the PUT — never disabled');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0);
});

test('non-404 PUT error is caught (best-effort, never throws into the tick)', async () => {
  const putForOrg = async () => { throw new Error('boom'); };
  const { report, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
    putForOrg,
  });
  await assert.doesNotReject(report());
  assert.match(warns.find((w) => /report failed/.test(w)), /boom/);
});

test('no active orgs → warn, no PUT', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.match(warns[0], /no active org/);
});

// ── QR-login channels: online = pm2 online AND component logged in ──────────

const HOME_DIR = '/h';
const WA_STATUS = `${HOME_DIR}/zylos/components/whatsapp/status.json`;
const WC_DIR = `${HOME_DIR}/zylos/components/wechat`;

// In-memory fs: { path: string } — readFileSync throws ENOENT for absent paths.
function memFs(files) {
  return {
    readFileSync(p) {
      if (!(p in files)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
  };
}

function qrHarness({ online = [], files = {}, clock = { t: 1_000_000 }, graceMs } = {}) {
  const puts = [];
  const logs = [];
  const fsState = { files };
  const report = createChannelLivenessReporter(
    orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]),
    {
      log: (m) => logs.push(m),
      warn: () => {},
      apiPath,
      readPm2Statuses: async () => pm2Map(online),
      putForOrg: async (orgId, path, payload) => { puts.push(payload); },
      fsDep: { readFileSync: (p) => memFs(fsState.files).readFileSync(p) },
      home: HOME_DIR,
      now: () => clock.t,
      ...(graceMs != null ? { qrPendingGraceMs: graceMs } : {}),
    },
  );
  const last = (ct) => puts.at(-1).channels.find((c) => c.channel_type === ct).online;
  return { report, puts, logs, fsState, clock, last };
}

const waStatus = (obj) => ({ [WA_STATUS]: JSON.stringify(obj) });
const wcFiles = (ids, healthById = {}) => {
  const f = { [`${WC_DIR}/accounts.json`]: JSON.stringify(ids) };
  for (const [id, h] of Object.entries(healthById)) {
    f[`${WC_DIR}/accounts/${id}.runtime.json`] = JSON.stringify({ normalizedAccountId: id, loginHealth: h });
  }
  return f;
};

test('whatsapp: pm2 online + state open → online', async () => {
  const h = qrHarness({ online: ['zylos-whatsapp'], files: waStatus({ state: 'open' }) });
  await h.report();
  assert.equal(h.last('whatsapp'), true);
});

for (const [label, files] of [
  ['qr_waiting', waStatus({ state: 'qr_waiting' })],
  ['disconnected 401 (logged out)', waStatus({ state: 'disconnected', statusCode: 401 })],
  ['missing status.json', {}],
  ['unparseable status.json', { [WA_STATUS]: '{not json' }],
  ['unknown state', waStatus({ state: 'weird' })],
  ['connecting (no prior online → no grace)', waStatus({ state: 'connecting' })],
  ['disconnected 408 (no prior online → no grace)', waStatus({ state: 'disconnected', statusCode: 408 })],
]) {
  test(`whatsapp: pm2 online + ${label} → offline`, async () => {
    const h = qrHarness({ online: ['zylos-whatsapp'], files });
    await h.report();
    assert.equal(h.last('whatsapp'), false);
  });
}

test('whatsapp: legacy `status` key is accepted', async () => {
  const h = qrHarness({ online: ['zylos-whatsapp'], files: waStatus({ status: 'open' }) });
  await h.report();
  assert.equal(h.last('whatsapp'), true);
});

test('whatsapp: pm2 stopped → offline even with a stale state open (probe not consulted)', async () => {
  let reads = 0;
  const h = qrHarness({ online: [], files: waStatus({ state: 'open' }) });
  const orig = h.fsState.files;
  h.fsState.files = new Proxy(orig, { has(o, k) { reads += 1; return k in o; } });
  await h.report();
  assert.equal(h.last('whatsapp'), false);
  assert.equal(reads, 0);
});

test('missing status file is logged once, not every tick', async () => {
  const h = qrHarness({ online: ['zylos-whatsapp'], files: {} });
  await h.report();
  await h.report();
  await h.report();
  const lines = h.logs.filter((m) => /whatsapp pm2 online but not logged in/.test(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status\.json missing/);
});

test('flap guard: brief connecting/disconnected after being online holds online within grace, then offline', async () => {
  const clock = { t: 1_000_000 };
  const h = qrHarness({ online: ['zylos-whatsapp'], files: waStatus({ state: 'open' }), clock, graceMs: 90_000 });
  await h.report();
  assert.equal(h.last('whatsapp'), true);

  h.fsState.files = waStatus({ state: 'connecting' }); // pm2 restart / reconnect
  clock.t += 60_000;
  await h.report();
  assert.equal(h.last('whatsapp'), true, 'held within grace');

  h.fsState.files = waStatus({ state: 'disconnected', statusCode: 428 }); // still reconnecting
  clock.t += 60_000; // 60s since pending began → still in grace
  await h.report();
  assert.equal(h.last('whatsapp'), true, 'grace measured from first pending tick');

  clock.t += 60_000; // 120s pending > 90s grace
  await h.report();
  assert.equal(h.last('whatsapp'), false, 'reconnect never completed → offline');

  h.fsState.files = waStatus({ state: 'open' });
  clock.t += 60_000;
  await h.report();
  assert.equal(h.last('whatsapp'), true, 'recovers on open');

  // A fresh pending episode gets a fresh grace window.
  h.fsState.files = waStatus({ state: 'connecting' });
  clock.t += 60_000;
  await h.report();
  assert.equal(h.last('whatsapp'), true);
});

test('flap guard does not apply to definitive logged-out states (401 → offline immediately)', async () => {
  const h = qrHarness({ online: ['zylos-whatsapp'], files: waStatus({ state: 'open' }) });
  await h.report();
  h.fsState.files = waStatus({ state: 'disconnected', statusCode: 401 });
  await h.report();
  assert.equal(h.last('whatsapp'), false);
});

// WeChat is deliberately pm2-only (no login probe): zylos-wechat persists
// loginHealth=degraded on a poll error and never writes healthy back after
// later successful empty polls, so reading it would report a recovered idle
// account offline (PR #200 review). Its files must not even be read.
test('wechat: liveness is pm2-only — no login probe declared', () => {
  assert.equal(CHANNEL_COMPONENT.wechat.loginState, undefined);
});

for (const [label, files] of [
  ['healthy account', wcFiles(['a1'], { a1: 'healthy' })],
  ['degraded runtime file (recovered-but-idle account)', wcFiles(['a1'], { a1: 'degraded' })],
  ['reauth_required runtime file', wcFiles(['a1'], { a1: 'reauth_required' })],
  ['no accounts.json', {}],
]) {
  test(`wechat: pm2 online + ${label} → online, accounts/runtime files never read`, async () => {
    const clock = { t: 5_000_000 };
    const reads = [];
    const h = qrHarness({ online: ['zylos-wechat'], files, clock, graceMs: 90_000 });
    const orig = h.fsState.files;
    h.fsState.files = new Proxy(orig, { has(o, k) { reads.push(k); return k in o; } });
    // Several ticks well past the 90s grace: must stay online throughout.
    for (let i = 0; i < 4; i++) {
      await h.report();
      assert.equal(h.last('wechat'), true, `tick ${i}`);
      clock.t += 60_000;
    }
    assert.deepEqual(reads.filter((k) => k.startsWith(WC_DIR)), []);
    assert.equal(h.logs.filter((m) => /wechat pm2 online but not logged in/.test(m)).length, 0);
  });
}

test('wechat: pm2 stopped → offline', async () => {
  const h = qrHarness({ online: [], files: wcFiles(['a1'], { a1: 'healthy' }) });
  await h.report();
  assert.equal(h.last('wechat'), false);
});

test('credential channels are unaffected: pm2 status only, no file reads', async () => {
  let reads = 0;
  const report = createChannelLivenessReporter(
    orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]),
    {
      log: noop, warn: noop, apiPath,
      readPm2Statuses: async () => pm2Map(['zylos-telegram', 'zylos-lark', 'zylos-whatsapp-business']),
      putForOrg: async (o, p, payload) => { puts.push(payload); },
      fsDep: { readFileSync: () => { reads += 1; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } },
      home: HOME_DIR,
    },
  );
  const puts = [];
  await report();
  const online = puts[0].channels.filter((c) => c.online).map((c) => c.channel_type).sort();
  assert.deepEqual(online, ['lark', 'telegram', 'whatsapp_business']);
  assert.equal(reads, 0);
});

test('payload shape unchanged for QR channels: { channels: [{ channel_type, online }] }', async () => {
  const h = qrHarness({ online: ['zylos-whatsapp', 'zylos-wechat'], files: waStatus({ state: 'open' }) });
  await h.report();
  assert.deepEqual(Object.keys(h.puts[0]), ['channels']);
  for (const c of h.puts[0].channels) assert.deepEqual(Object.keys(c).sort(), ['channel_type', 'online']);
});

test('decideChannelOnline: pure rule table', () => {
  const now = 100_000;
  assert.deepEqual(decideChannelOnline({ pm2Online: false, login: { state: 'logged_in' }, now }), { online: false, pendingSince: null });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, now }), { online: true, pendingSince: null });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, login: { state: 'logged_in' }, now }), { online: true, pendingSince: null });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, login: { state: 'logged_out' }, prev: { online: true }, now }), { online: false, pendingSince: null });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, login: { state: 'pending' }, prev: { online: true }, now, graceMs: 10 }), { online: true, pendingSince: now });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, login: { state: 'pending' }, prev: { online: true, pendingSince: now - 10 }, now, graceMs: 10 }), { online: false, pendingSince: now - 10 });
  assert.deepEqual(decideChannelOnline({ pm2Online: true, login: { state: 'pending' }, prev: { online: false }, now }), { online: false, pendingSince: now });
});
