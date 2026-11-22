import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChannelEvent,
  normalizeAction,
  CHANNEL_COMPONENT,
  createChannelInstaller,
} from './channel-connector.js';

const apiPath = (p) => `/api/v1${p}`;

test('isChannelEvent: channel.* → true; other domains → false', () => {
  assert.equal(isChannelEvent('channel.connect'), true);
  assert.equal(isChannelEvent('channel.disconnect'), true);
  assert.equal(isChannelEvent('CHANNEL.CONNECT'), true); // case-insensitive
  assert.equal(isChannelEvent('connection.authorized'), false);
  assert.equal(isChannelEvent('message.updated'), false);
  assert.equal(isChannelEvent(''), false);
  assert.equal(isChannelEvent(undefined), false);
});

test('normalizeAction: connect/disconnect + legacy aliases', () => {
  assert.equal(normalizeAction('connect'), 'connect');
  assert.equal(normalizeAction('install'), 'connect');            // legacy
  assert.equal(normalizeAction('update-credentials'), 'connect'); // legacy
  assert.equal(normalizeAction('disconnect'), 'disconnect');
  assert.equal(normalizeAction('uninstall'), 'disconnect');       // legacy
  assert.equal(normalizeAction('CONNECT'), 'connect');
  assert.equal(normalizeAction('bogus'), 'bogus');
});

test('CHANNEL_COMPONENT.feishu.buildConfig: app_id/app_secret → .env (no dead FEISHU_IS_LARK), websocket → config.json', () => {
  const spec = CHANNEL_COMPONENT.feishu;
  assert.equal(spec.component, 'feishu');
  assert.equal(spec.pm2Service, 'zylos-feishu');

  const built = spec.buildConfig({ app_id: 'cli_abc', app_secret: 's3cr3t', extra: 'ignored' });
  assert.deepEqual(built.env, { FEISHU_APP_ID: 'cli_abc', FEISHU_APP_SECRET: 's3cr3t' });
  assert.deepEqual(built.configJson, { enabled: true, connection_mode: 'websocket' });

  // Accept alternate key spellings from cws-core.
  const built2 = spec.buildConfig({ appId: 'x', appSecret: 'y' });
  assert.equal(built2.env.FEISHU_APP_ID, 'x');
  assert.equal(built2.env.FEISHU_APP_SECRET, 'y');
});

const ORG = { slug: 'acme', org_id: 'org-1', self: { member_id: 'm-self' } };

// Fake fetch for probes: feishu-style success by default; override per test.
function fakeFetch(bodyOrFn = { code: 0, tenant_access_token: 't' }, status = 200) {
  return async (url, opts) => {
    const body = typeof bodyOrFn === 'function' ? bodyOrFn(url, opts) : bodyOrFn;
    if (body instanceof Error) throw body;
    return { status, text: async () => JSON.stringify(body) };
  };
}

function makeConnector({
  pullResp = { config: { app_id: 'aid', app_secret: 'asec' } },
  installed = false,      // whether `zylos info` reports the component installed
  dedupeSeen = false,
  verify = true,          // injected verifyConnected result
  fetchDep = fakeFetch(), // probe passes by default
  pm2Fails = false,       // every pm2 invocation throws (restart AND start)
  installFails = false,   // zylos add/upgrade throws
  // connect-result delivery: fail the first N report attempts (0 = reporter
  // always succeeds, which is what every pre-existing test assumes)
  reportFailTimes = 0,
  reportAttempts,         // undefined → the installer's own default (3)
  persistFails = false,   // the queue-for-resend hook itself throws
  fsDep,                  // inject a fake fs (readFileSync/rmSync) for logout paths
  home,                   // override HOME so logout file paths point nowhere real
} = {}) {
  const pulls = [];
  const execCalls = [];
  const envWrites = [];
  const configWrites = [];
  const reports = [];
  const reportAttemptsMade = [];
  const queued = [];
  const sleeps = [];
  const warns = [];
  const logs = [];
  const fetches = [];

  const getForOrgWithHeaders = async (orgId, path, extraHeaders) => {
    pulls.push({ orgId, path, extraHeaders });
    if (pullResp instanceof Error) throw pullResp;
    return pullResp;
  };
  const execFile = async (file, args) => {
    execCalls.push([file, ...args]);
    if (file === 'zylos' && args[0] === 'info') {
      if (installed) return { stdout: JSON.stringify({ name: args[1] }) };
      throw new Error('component not installed');
    }
    if (pm2Fails && file === 'pm2') throw new Error('[PM2][ERROR] Process 9 not found');
    if (installFails && file === 'zylos' && (args[0] === 'add' || args[0] === 'upgrade')) {
      throw new Error('npm install exited 1 (env echoed sekrit-value-42 by mistake)');
    }
    return { stdout: '' };
  };

  const handle = createChannelInstaller({
    getForOrgWithHeaders,
    apiPath,
    dedupe: () => dedupeSeen,
    execFile,
    writeEnv: (vars) => envWrites.push(vars),
    writeConfig: (component, patch) => configWrites.push({ component, patch }),
    verifyConnected: async () => verify,
    reportResult: async (r) => {
      reportAttemptsMade.push(r);
      if (reportAttemptsMade.length <= reportFailTimes) throw new Error('503 upstream unavailable');
      reports.push(r);
    },
    ...(reportAttempts === undefined ? {} : { reportAttempts }),
    persistUndeliveredResult: async (r) => {
      if (persistFails) throw new Error('EROFS: read-only file system');
      queued.push(r);
    },
    reportSleep: async (ms) => { sleeps.push(ms); },   // no real waiting in tests
    fetchDep: async (url, opts) => { fetches.push({ url, opts }); return fetchDep(url, opts); },
    ...(fsDep === undefined ? {} : { fsDep }),
    ...(home === undefined ? {} : { home }),
    qrPollMs: 0,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  return {
    handle, pulls, execCalls, envWrites, configWrites, reports,
    reportAttemptsMade, queued, sleeps, warns, logs, fetches,
  };
}

function frame(data) {
  return { payload: { event: `channel.${data.action}`, data } };
}

test('connect feishu (not installed): pulls, zylos add, writes .env + config, restarts, verifies, reports connected', async () => {
  const h = makeConnector({ installed: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-1',
    request_id: 'req-1', credential_pull_token: 'tok-1', agent_member_id: 'm-self',
  }));

  assert.equal(h.pulls.length, 1);
  assert.equal(h.pulls[0].path, '/api/v1/connect/channel-bindings/bind-1/credential');
  assert.deepEqual(h.pulls[0].extraHeaders, { 'X-Channel-Bind-Token': 'tok-1' });

  // not installed → add (not upgrade) → restart
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'feishu', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'add', 'feishu', '--yes']);
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'restart' && c[2] === 'zylos-feishu'));
  assert.ok(!h.execCalls.some((c) => c[1] === 'upgrade'));

  // secrets → .env (no dead FEISHU_IS_LARK), mode → config.json
  assert.deepEqual(h.envWrites, [{ FEISHU_APP_ID: 'aid', FEISHU_APP_SECRET: 'asec' }]);
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: true, connection_mode: 'websocket' } }]);

  // connect-result回执 = connected
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'connected');
  assert.equal(h.reports[0].bindingId, 'bind-1');
  assert.equal(h.reports[0].channelType, 'feishu');
  assert.equal(h.warns.length, 0);

  // Secret VALUES must never be logged (keys only).
  assert.ok(!h.logs.some((l) => l.includes('asec') || l.includes('aid')));
});

test('connect feishu (already installed): zylos upgrade (NOT add), reports connected', async () => {
  const h = makeConnector({ installed: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-2',
    request_id: 'req-2', credential_pull_token: 'tok-2',
  }));
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'feishu', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'upgrade', 'feishu', '--yes']);
  assert.ok(!h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports[0].status, 'connected');
});

test('legacy action "install" is treated as connect', async () => {
  const h = makeConnector({ installed: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-2b', request_id: 'r', credential_pull_token: 't',
  }));
  assert.ok(h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports[0].status, 'connected');
});

test('connect: verification fails → reports error (not a false connected)', async () => {
  const h = makeConnector({ installed: false, verify: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-3', request_id: 'req-3', credential_pull_token: 'tok-3',
  }));
  // work still happened (add + restart), but result is error
  assert.ok(h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'error');
});

test('connect: pm2 start throws but service comes online → connected (no false failure)', async () => {
  // int E2E 2026-07-10: `zylos add` had already started the service; the
  // connector's own pm2 start raced it and crashed, while the process was
  // fine. The start error must defer to verification, not fail the connect.
  const h = makeConnector({ installed: false, pm2Fails: true, verify: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-race', request_id: 'req-race', credential_pull_token: 'tok-r',
  }));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'connected');
  assert.ok(h.warns.some((w) => /starting service failed/.test(w) && /deferring to connect verification/.test(w)));
});

test('connect: pm2 start throws AND verification fails → error receipt carries the underlying start error', async () => {
  const h = makeConnector({ installed: false, pm2Fails: true, verify: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-race2', request_id: 'req-race2', credential_pull_token: 'tok-r2',
  }));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.reports[0].detail, /starting service failed: .*Process 9 not found/);
});

test('connect: install failure receipt carries the underlying error with secret values masked', async () => {
  const h = makeConnector({
    installed: true, installFails: true,
    pullResp: { config: { app_id: 'aid', app_secret: 'sekrit-value-42' } },
  });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-inst', request_id: 'req-inst', credential_pull_token: 'tok-i',
  }));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.reports[0].detail, /install\/upgrade failed: npm install exited 1/);
  // the pulled app_secret value must be masked out of the receipt
  assert.ok(!h.reports[0].detail.includes('sekrit-value-42'), `secret leaked: ${h.reports[0].detail}`);
  assert.ok(h.reports[0].detail.includes('***'));
});

test('disconnect: soft-disable (pm2 stop + enabled:false), keeps creds, NO uninstall', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'disconnect', binding_id: 'bind-4', request_id: 'req-4',
  }));
  assert.equal(h.pulls.length, 0);                                   // no cred pull on disconnect
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-feishu'));
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: false } }]);
  assert.equal(h.envWrites.length, 0);                               // creds kept (no .env change)
  assert.ok(!h.execCalls.some((c) => c[0] === 'zylos' && (c[1] === 'uninstall' || c[1] === 'remove')));
  assert.equal(h.reports[0].status, 'disconnected');
});

test('legacy action "uninstall" → disconnect (soft-disable, not zylos uninstall)', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'uninstall', binding_id: 'bind-4b', request_id: 'r',
  }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop'));
  assert.ok(!h.execCalls.some((c) => c[1] === 'uninstall' || c[1] === 'remove'));
  assert.equal(h.reports[0].status, 'disconnected');
});

test('unsupported channel_type on connect (zalo-personal = out of scope per D-4): no pull, no shell-out, warns', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'zalo-personal', action: 'connect', binding_id: 'bind-5', request_id: 'req-5', credential_pull_token: 'tok-5',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /not supported/);
});

test('event not for this agent: skipped entirely', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-6', request_id: 'req-6',
    credential_pull_token: 'tok-6', agent_member_id: 'someone-else',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports.length, 0);
});

test('dedup: redelivered command dropped before any work', async () => {
  const h = makeConnector({ dedupeSeen: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-7', request_id: 'req-7', credential_pull_token: 'tok-7',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
});

test('empty pulled config: reports error, does not install', async () => {
  const h = makeConnector({ pullResp: { config: {} } });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-8', request_id: 'req-8', credential_pull_token: 'tok-8',
  }));
  assert.equal(h.pulls.length, 1);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.warns[0], /empty\/absent/);
});

test('credential pull failure: reports error, never throws, no install', async () => {
  const h = makeConnector({ pullResp: new Error('403 forbidden') });
  await assert.doesNotReject(h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-9', request_id: 'req-9', credential_pull_token: 'bad',
  })));
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.warns[0], /credential pull failed/);
});

test('missing binding_id: warns, no work', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({ channel_type: 'feishu', action: 'connect', request_id: 'r' }));
  assert.equal(h.pulls.length, 0);
  assert.match(h.warns[0], /missing binding_id/);
});

// ── connect-result delivery: retry + queue-for-resend ────────────────────────
// Regression cover for the live incident: a `connected` report came back 503
// while the channel was actually open, the connector gave up after one POST, and
// the binding stayed `pending` — which the UI renders as a permanent spinner.

const connectFrame = (over = {}) => frame({
  channel_type: 'feishu', action: 'connect', binding_id: 'bind-r1',
  request_id: 'req-r1', credential_pull_token: 'tok-r1', agent_member_id: 'm-self',
  ...over,
});

test('connect-result: transient failure then success → delivered, nothing queued', async () => {
  const h = makeConnector({ reportFailTimes: 1 });
  await h.handle(ORG, connectFrame());

  assert.equal(h.reportAttemptsMade.length, 2, 'retried once after the 5xx');
  assert.equal(h.reports.length, 1, 'exactly one result recorded upstream');
  assert.equal(h.reports[0].status, 'connected');
  assert.equal(h.queued.length, 0, 'a delivered result must not be queued');
  assert.ok(h.logs.some((m) => /connect-result delivered on attempt 2/.test(m)));
  assert.match(h.warns[0], /connect-result report failed .*\(attempt 1\/3\)/);
  assert.ok(!/queuing for resend/.test(h.warns[0]), 'not the last attempt yet');
});

test('connect-result: every attempt fails → payload queued for resend, flow never throws', async () => {
  const h = makeConnector({ reportFailTimes: 99 });
  await assert.doesNotReject(h.handle(ORG, connectFrame()));

  assert.equal(h.reportAttemptsMade.length, 3, 'default is 3 attempts');
  assert.equal(h.reports.length, 0);
  assert.equal(h.queued.length, 1, 'undelivered result handed to the queue');
  // The queued payload must carry everything the resend needs to re-POST.
  assert.deepEqual(h.queued[0], {
    slug: ORG.slug, orgId: ORG.org_id, bindingId: 'bind-r1',
    channelType: 'feishu', requestId: 'req-r1', status: 'connected', detail: '',
  });
  assert.match(h.warns.at(-1), /\(attempt 3\/3\).*queuing for resend/);
});

test('connect-result: retry backoff grows and does not sleep after the last attempt', async () => {
  const h = makeConnector({ reportFailTimes: 99 });
  await h.handle(ORG, connectFrame());
  assert.deepEqual(h.sleeps, [2000, 4000], 'one sleep between attempts, none after the last');
});

test('connect-result: reportAttempts is honoured (single attempt → straight to the queue)', async () => {
  const h = makeConnector({ reportFailTimes: 99, reportAttempts: 1 });
  await h.handle(ORG, connectFrame());
  assert.equal(h.reportAttemptsMade.length, 1);
  assert.deepEqual(h.sleeps, [], 'nothing to back off from');
  assert.equal(h.queued.length, 1);
});

test('connect-result: a failing queue hook is warned about, not thrown out of the flow', async () => {
  const h = makeConnector({ reportFailTimes: 99, persistFails: true });
  await assert.doesNotReject(h.handle(ORG, connectFrame()));
  assert.equal(h.queued.length, 0);
  assert.ok(h.warns.some((m) => /could not queue connect-result for resend: EROFS/.test(m)));
});

test('connect-result: an error receipt is retried and queued too (a stranded failure also spins the UI)', async () => {
  const h = makeConnector({ reportFailTimes: 99, verify: false });
  await h.handle(ORG, connectFrame({ binding_id: 'bind-r2', request_id: 'req-r2' }));

  assert.equal(h.reportAttemptsMade.length, 3);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].status, 'error');
  assert.equal(h.queued[0].bindingId, 'bind-r2');
  assert.ok(h.queued[0].detail, 'verification failure detail preserved for the resend');
});

test('connect-result: disconnect receipts get the same retry + queue treatment', async () => {
  const h = makeConnector({ reportFailTimes: 99 });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'disconnect', binding_id: 'bind-r3', request_id: 'req-r3',
  }));
  assert.equal(h.reportAttemptsMade.length, 3);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].status, 'disconnected');
});

// ── batch 1: 10-channel expansion ────────────────────────────────────────────

test('CHANNEL_COMPONENT: all 13 channels mapped (11 credential + 2 QR); D-1 aliases translate to hyphenated components', () => {
  const expected = ['feishu', 'lark', 'telegram', 'dingtalk', 'wecom', 'slack', 'discord', 'zalo', 'line', 'whatsapp_business', 'ms_teams', 'wechat', 'whatsapp'];
  assert.deepEqual(Object.keys(CHANNEL_COMPONENT).sort(), [...expected].sort());
  assert.ok(CHANNEL_COMPONENT.wechat.qrLogin);    // QR-login channel
  assert.ok(CHANNEL_COMPONENT.whatsapp.qrLogin);  // QR-login channel
  // underscore channel_type → hyphenated component (naming decision D-1)
  assert.equal(CHANNEL_COMPONENT.ms_teams.component, 'ms-teams');
  assert.equal(CHANNEL_COMPONENT.ms_teams.pm2Service, 'zylos-ms-teams');
  assert.equal(CHANNEL_COMPONENT.whatsapp_business.component, 'whatsapp-business');
  assert.equal(CHANNEL_COMPONENT.whatsapp_business.pm2Service, 'zylos-whatsapp-business');
});

test('buildConfig: catalog form fields → component env contract, per channel', () => {
  const cases = [
    ['lark', { app_id: 'cli_1', app_secret: 's' },
      { LARK_APP_ID: 'cli_1', LARK_APP_SECRET: 's' }, { enabled: true, transport: 'websocket' }],
    ['telegram', { bot_token: '12:ab' },
      { TELEGRAM_BOT_TOKEN: '12:ab' }, { enabled: true }],
    ['dingtalk', { app_key: 'k', app_secret: 's', robot_code: 'r' },
      { DINGTALK_APP_KEY: 'k', DINGTALK_APP_SECRET: 's', DINGTALK_ROBOT_CODE: 'r' }, { enabled: true }],
    ['wecom', { bot_id: 'b', bot_secret: 's' },
      { WECOM_BOT_ID: 'b', WECOM_BOT_SECRET: 's' }, { enabled: true }],
    ['slack', { bot_token: 'xoxb-1', app_token: 'xapp-1' },
      { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }, { enabled: true, connection_mode: 'socket' }],
    // config-first loaders: fresh creds must land in config.json too, or a
    // stale config value survives the upgrade and beats the new .env value.
    ['discord', { bot_token: 'd' },
      { DISCORD_BOT_TOKEN: 'd' }, { enabled: true, botToken: 'd' }],
    ['zalo', { bot_token: 'z' },
      { ZALO_BOT_TOKEN: 'z' }, { enabled: true, botToken: 'z' }],
    ['line', { channel_access_token: 'cat', channel_secret: 'cs' },
      { LINE_CHANNEL_ACCESS_TOKEN: 'cat', LINE_CHANNEL_SECRET: 'cs' },
      { enabled: true, channelAccessToken: 'cat', channelSecret: 'cs' }],
  ];
  for (const [type, config, env, configJson] of cases) {
    const built = CHANNEL_COMPONENT[type].buildConfig(config);
    assert.deepEqual(built.env, env, type);
    assert.deepEqual(built.configJson, configJson, type);
  }
});

test('buildConfig optional fields: waba_id / app_catalog_id only written when present; config-first creds mirrored to config.json', () => {
  const wab = CHANNEL_COMPONENT.whatsapp_business;
  const base = { phone_number_id: 'p', access_token: 'a', app_secret: 's', verify_token: 'v' };
  const wabBuilt = wab.buildConfig(base);
  assert.deepEqual(wabBuilt.env, {
    WAB_PHONE_NUMBER_ID: 'p', WAB_ACCESS_TOKEN: 'a', WAB_APP_SECRET: 's', WAB_VERIFY_TOKEN: 'v',
  });
  // loader is config-first (cfg.credentials.*) → creds mirrored to config.json
  assert.deepEqual(wabBuilt.configJson.credentials, {
    phone_number_id: 'p', access_token: 'a', app_secret: 's', verify_token: 'v',
  });
  const wabOpt = wab.buildConfig({ ...base, waba_id: 'w' });
  assert.equal(wabOpt.env.WAB_WABA_ID, 'w');
  assert.equal(wabOpt.configJson.credentials.waba_id, 'w');
  // omitted optional field must not linger in the replaced credentials object
  assert.ok(!('waba_id' in wabBuilt.configJson.credentials));

  const teams = CHANNEL_COMPONENT.ms_teams;
  const tbase = { app_id: 'i', app_password: 'p', tenant_id: 't' };
  const teamsBuilt = teams.buildConfig(tbase);
  assert.deepEqual(teamsBuilt.env, {
    MSTEAMS_APP_ID: 'i', MSTEAMS_APP_PASSWORD: 'p', MSTEAMS_TENANT_ID: 't',
  });
  assert.deepEqual(teamsBuilt.configJson.credentials, {
    appId: 'i', appPassword: 'p', tenantId: 't',
  });
  const teamsOpt = teams.buildConfig({ ...tbase, app_catalog_id: 'c' });
  assert.equal(teamsOpt.env.MSTEAMS_APP_CATALOG_ID, 'c');
  assert.equal(teamsOpt.configJson.teamsAppCatalogId, 'c'); // top-level key in that loader
  assert.ok(!('teamsAppCatalogId' in teamsBuilt.configJson));
});

test('connect: probe definitively rejects creds → error receipt, NO install/restart side effects', async () => {
  // feishu-style rejection: code != 0
  const h = makeConnector({ fetchDep: fakeFetch({ code: 10003, msg: 'invalid app_secret' }) });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-p1', request_id: 'r', credential_pull_token: 't',
  }));
  assert.equal(h.execCalls.length, 0);                     // fail-fast: nothing installed
  assert.equal(h.envWrites.length, 0);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.reports[0].detail, /credential check failed/);
  assert.match(h.reports[0].detail, /10003/);
  // detail must not leak the secret
  assert.ok(!h.reports[0].detail.includes('asec'));
});

test('connect: probe inconclusive (IM API unreachable) → proceeds and connects via process-health fallback', async () => {
  const h = makeConnector({ fetchDep: fakeFetch(new Error('ECONNREFUSED')) });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-p2', request_id: 'r', credential_pull_token: 't',
  }));
  assert.ok(h.execCalls.some((c) => c[1] === 'add'));      // install went ahead
  assert.equal(h.reports[0].status, 'connected');
  assert.ok(h.logs.some((l) => /probe inconclusive/.test(l)));
});

test('connect: channel without probe (wecom) skips the probe and proceeds', async () => {
  const h = makeConnector({ pullResp: { config: { bot_id: 'b', bot_secret: 's' } } });
  await h.handle(ORG, frame({
    channel_type: 'wecom', action: 'connect', binding_id: 'bind-p3', request_id: 'r', credential_pull_token: 't',
  }));
  assert.equal(h.fetches.length, 0);                       // no probe call
  assert.deepEqual(h.execCalls[1], ['zylos', 'add', 'wecom', '--yes']);
  assert.deepEqual(h.envWrites, [{ WECOM_BOT_ID: 'b', WECOM_BOT_SECRET: 's' }]);
  assert.equal(h.reports[0].status, 'connected');
});

test('connect ms_teams: alias resolves through the whole flow (add ms-teams, restart zylos-ms-teams)', async () => {
  const h = makeConnector({
    pullResp: { config: { app_id: 'i', app_password: 'pw', tenant_id: 'tn' } },
    fetchDep: fakeFetch({ token_type: 'Bearer', access_token: 'jwt' }),
  });
  await h.handle(ORG, frame({
    channel_type: 'ms_teams', action: 'connect', binding_id: 'bind-p4', request_id: 'r', credential_pull_token: 't',
  }));
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'ms-teams', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'add', 'ms-teams', '--yes']);
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'restart' && c[2] === 'zylos-ms-teams'));
  assert.equal(h.reports[0].status, 'connected');
  // AAD probe hit the tenant token endpoint with form-encoded client creds
  assert.match(h.fetches[0].url, /login\.microsoftonline\.com\/tn\/oauth2\/v2\.0\/token/);
  assert.match(h.fetches[0].opts.body, /grant_type=client_credentials/);
});

// Per-channel probe contract: endpoint shape + pass/fail parsing.
test('probes: endpoint + auth shape + definitive pass/fail per channel', async () => {
  const run = (type, config, body, status = 200) => {
    const calls = [];
    const fetchDep = async (url, opts) => {
      calls.push({ url, opts });
      const b = Array.isArray(body) ? body[calls.length - 1] : body;
      return { status, text: async () => JSON.stringify(b) };
    };
    return CHANNEL_COMPONENT[type].probe(config, { fetchDep, timeoutMs: 1000 })
      .then((r) => ({ r, calls }), (e) => ({ e, calls }));
  };

  // telegram: getMe ok / rejected
  let { r, calls } = await run('telegram', { bot_token: 'T' }, { ok: true, result: {} });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /api\.telegram\.org\/botT\/getMe/);
  ({ r } = await run('telegram', { bot_token: 'T' }, { ok: false, error_code: 401 }, 401));
  assert.equal(r.ok, false);

  // lark: larksuite domain, code 0 pass / non-zero fail
  ({ r, calls } = await run('lark', { app_id: 'a', app_secret: 's' }, { code: 0 }));
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /open\.larksuite\.com/);
  ({ r } = await run('lark', { app_id: 'a', app_secret: 's' }, { code: 10014 }));
  assert.equal(r.ok, false);

  // dingtalk: accessToken pass / 400 fail
  ({ r, calls } = await run('dingtalk', { app_key: 'k', app_secret: 's' }, { accessToken: 'x' }));
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /api\.dingtalk\.com\/v1\.0\/oauth2\/accessToken/);
  ({ r } = await run('dingtalk', { app_key: 'k', app_secret: 's' }, { code: 'invalidAppKey' }, 400));
  assert.equal(r.ok, false);

  // slack: both tokens checked (two calls), app token failure is definitive
  ({ r, calls } = await run('slack', { bot_token: 'xb', app_token: 'xa' }, [{ ok: true }, { ok: true, url: 'wss://x' }]));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer xb');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer xa');
  ({ r } = await run('slack', { bot_token: 'xb', app_token: 'xa' }, [{ ok: true }, { ok: false, error: 'invalid_auth' }]));
  assert.equal(r.ok, false);

  // discord: 200 pass / 401 definitive fail
  ({ r, calls } = await run('discord', { bot_token: 'D' }, {}, 200));
  assert.equal(r.ok, true);
  assert.equal(calls[0].opts.headers.Authorization, 'Bot D');
  ({ r } = await run('discord', { bot_token: 'D' }, {}, 401));
  assert.equal(r.ok, false);

  // zalo: telegram-shaped bot API on zaloplatforms.com
  ({ r, calls } = await run('zalo', { bot_token: 'Z' }, { ok: true }));
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /bot-api\.zaloplatforms\.com\/botZ\/getMe/);

  // line: bot/info 200 pass / 401 fail
  ({ r, calls } = await run('line', { channel_access_token: 'L' }, {}, 200));
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /api\.line\.me\/v2\/bot\/info/);
  ({ r } = await run('line', { channel_access_token: 'L' }, {}, 401));
  assert.equal(r.ok, false);

  // whatsapp_business: graph 200 pass / error object fail
  ({ r, calls } = await run('whatsapp_business', { phone_number_id: 'p1', access_token: 'A' }, { id: 'p1' }));
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/p1/);
  ({ r } = await run('whatsapp_business', { phone_number_id: 'p1', access_token: 'A' }, { error: { code: 190 } }, 401));
  assert.equal(r.ok, false);

  // ms_teams: AAD invalid_client is definitive
  ({ r } = await run('ms_teams', { app_id: 'i', app_password: 'p', tenant_id: 't' }, { error: 'invalid_client' }, 401));
  assert.equal(r.ok, false);

  // 5xx / unparseable → inconclusive (throws), never a definitive verdict
  const out = await run('telegram', { bot_token: 'T' }, {}, 502);
  assert.ok(out.e);
});

// ── batch 2: QR-login channels (wechat / whatsapp) ───────────────────────────

import { wechatQrLogin, whatsappQrLogin, wechatLogout, whatsappLogout } from './channel-connector.js';

const noSleep = async () => {};

test('CHANNEL_COMPONENT: wechat/whatsapp present as qrLogin channels (no probe, empty env)', () => {
  for (const type of ['wechat', 'whatsapp']) {
    const spec = CHANNEL_COMPONENT[type];
    assert.ok(spec.qrLogin, type);
    assert.equal(spec.probe, undefined, type);
    assert.deepEqual(spec.buildConfig({}).env, {}, type);
    assert.deepEqual(spec.buildConfig({}).configJson, { enabled: true }, type);
  }
});

test('wechatQrLogin: start → qr_ready relays QR (and rotation) → confirmed finalizes → connected', async () => {
  const qrs = [];
  const calls = [];
  const sessions = [
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'QR1' },
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'QR1' },  // unchanged → no re-relay
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'QR2' },  // rotated → relay again
    { state: 'scanned', sessionId: 's1' },
    { state: 'confirmed', sessionId: 's1' },
  ];
  let polls = 0;
  const fetchDep = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/v1/login/start')) {
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's1' } }) };
    }
    if (url.endsWith('/v1/login/session')) {
      const s = sessions[Math.min(polls++, sessions.length - 1)];
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: s }) };
    }
    if (url.endsWith('/v1/login/finalize')) {
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    return { status: 404, text: async () => '{}' };
  };
  const fsDep = { readFileSync: () => 'tok-123\n' };
  const res = await wechatQrLogin({
    fetchDep, fsDep, home: '/h', onQr: (q) => qrs.push(q), log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.deepEqual(res, { status: 'connected', detail: '' });
  assert.deepEqual(qrs, ['QR1', 'QR2']);                      // relayed once per distinct code
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-123');
  assert.ok(calls.some((c) => c.url.endsWith('/v1/login/finalize')));
});

test('wechatQrLogin: 409 on start (account already present) → connected immediately', async () => {
  const fetchDep = async () => ({ status: 409, text: async () => JSON.stringify({ ok: false }) });
  const res = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => 't' }, home: '/h', onQr: () => {}, log: () => {},
    timeoutMs: 1000, pollMs: 0, sleepDep: noSleep,
  });
  assert.equal(res.status, 'connected');
});

test('wechatQrLogin: expired session → error; missing admin token → error', async () => {
  let started = false;
  const fetchDep = async (url) => {
    if (url.endsWith('/start')) { started = true; return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's' } }) }; }
    return { status: 200, text: async () => JSON.stringify({ ok: true, session: { state: 'expired' } }) };
  };
  const res = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => 't' }, home: '/h', onQr: () => {}, log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /expired/);
  assert.ok(started);

  const res2 = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => { throw new Error('ENOENT'); } }, home: '/h',
    onQr: () => {}, log: () => {}, timeoutMs: 1000, pollMs: 0, sleepDep: noSleep,
    readyTimeoutMs: 0,
  });
  assert.equal(res2.status, 'error');
  assert.match(res2.detail, /admin token/);
});

test('wechatQrLogin: component booting (token missing, then API refused) → retries within ready window, then proceeds', async () => {
  // Simulates connect right after pm2 start: .admin-token appears on the 2nd
  // read, the admin HTTP starts answering on the 2nd /login/start attempt.
  let tokenReads = 0;
  let startCalls = 0;
  let polls = 0;
  const sessions = [
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'QRX' },
    { state: 'confirmed', sessionId: 's1' },
  ];
  const fsDep = {
    readFileSync: () => {
      tokenReads += 1;
      if (tokenReads < 2) throw new Error('ENOENT');
      return 'tok-late\n';
    },
  };
  const fetchDep = async (url) => {
    if (url.endsWith('/v1/login/start')) {
      startCalls += 1;
      if (startCalls < 2) throw new Error('fetch failed'); // ECONNREFUSED while booting
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's1' } }) };
    }
    if (url.endsWith('/v1/login/session')) {
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: sessions[Math.min(polls++, 1)] }) };
    }
    if (url.endsWith('/v1/login/finalize')) return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    return { status: 404, text: async () => '{}' };
  };
  const qrs = [];
  const res = await wechatQrLogin({
    fetchDep, fsDep, home: '/h', onQr: (q) => qrs.push(q), log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep, readyTimeoutMs: 10_000, readyPollMs: 0,
  });
  assert.deepEqual(res, { status: 'connected', detail: '' });
  assert.deepEqual(qrs, ['QRX']);
  assert.ok(tokenReads >= 2 && startCalls >= 2);
});

test('wechatQrLogin: component never comes up within ready window → clean not-ready error (no crash)', async () => {
  const fetchDep = async () => { throw new Error('fetch failed'); };
  const res = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => 'tok\n' }, home: '/h', onQr: () => {}, log: () => {},
    timeoutMs: 1000, pollMs: 0, sleepDep: noSleep, readyTimeoutMs: 0,
  });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /not ready/);
});

test('whatsappQrLogin: qr_waiting relays qr.png as base64 (rotation re-relays) → open → connected', async () => {
  const qrs = [];
  let poll = 0;
  const statuses = ['connecting', 'qr_waiting', 'qr_waiting', 'qr_waiting', 'open'];
  const pngs = { 1: 'PNG-A', 2: 'PNG-A', 3: 'PNG-B' };
  const fsDep = {
    readFileSync: (p) => {
      if (String(p).endsWith('status.json')) {
        const s = statuses[Math.min(poll++, statuses.length - 1)];
        return JSON.stringify({ status: s });
      }
      return Buffer.from(pngs[poll - 1] || 'PNG-A');
    },
  };
  const res = await whatsappQrLogin({
    fsDep, home: '/h', onQr: (q) => qrs.push(q), log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.deepEqual(res, { status: 'connected', detail: '' });
  assert.deepEqual(qrs, [
    Buffer.from('PNG-A').toString('base64'),
    Buffer.from('PNG-B').toString('base64'),
  ]);
});

test('whatsappQrLogin: never reaches open before deadline → timeout error', async () => {
  const fsDep = { readFileSync: (p) => String(p).endsWith('status.json') ? JSON.stringify({ status: 'connecting' }) : Buffer.from('x') };
  const res = await whatsappQrLogin({
    fsDep, home: '/h', onQr: () => {}, log: () => {}, timeoutMs: 1, pollMs: 0, sleepDep: noSleep,
  });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /timed out/);
});

test('whatsappQrLogin: reads the component\'s REAL `state` key (int E2E regression: `.status`-only reads relayed zero QRs)', async () => {
  const qrs = [];
  let poll = 0;
  // zylos-whatsapp actually writes { state: ... } — this is the shape from the
  // live incident (binding 80b45491): qr_waiting with rotating qr.png.
  const states = ['connecting', 'qr_waiting', 'open'];
  const fsDep = {
    readFileSync: (p) => {
      if (String(p).endsWith('status.json')) {
        return JSON.stringify({ state: states[Math.min(poll++, states.length - 1)], updatedAt: 'x' });
      }
      return Buffer.from('PNG-REAL');
    },
  };
  const res = await whatsappQrLogin({
    fsDep, home: '/h', onQr: (q) => qrs.push(q), log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.deepEqual(res, { status: 'connected', detail: '' });
  assert.deepEqual(qrs, [Buffer.from('PNG-REAL').toString('base64')]); // QR actually relayed
});

test('connect wechat (QR): skips credential pull, installs + starts, QR relayed via reportQR, terminal receipt from flow', async () => {
  const h = makeConnector();
  const qrReports = [];
  // rebuild with reportQR + a qrLogin stub via spec injection is not possible —
  // instead drive the real wechat spec with a fake local admin API.
  const sessions = [
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'QQ' },
    { state: 'confirmed', sessionId: 's1' },
  ];
  let poll = 0;
  const fetchDep = async (url) => {
    if (url.endsWith('/v1/login/start')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's1' } }) };
    if (url.endsWith('/v1/login/session')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: sessions[Math.min(poll++, 1)] }) };
    if (url.endsWith('/v1/login/finalize')) return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    return { status: 404, text: async () => '{}' };
  };
  // token file read goes through the REAL fs (home-based path) — but home in
  // tests points nowhere; instead assert the error path is reported cleanly.
  const pulls = [];
  const reports = [];
  const execCalls = [];
  const handle = createChannelInstaller({
    getForOrgWithHeaders: async (...a) => { pulls.push(a); return {}; },
    apiPath,
    dedupe: () => false,
    execFile: async (file, args) => { execCalls.push([file, ...args]); if (file === 'zylos' && args[0] === 'info') throw new Error('nope'); return { stdout: '' }; },
    writeEnv: () => {},
    writeConfig: () => {},
    verifyConnected: async () => true,
    reportResult: async (r) => reports.push(r),
    reportQR: async (r) => qrReports.push(r),
    fetchDep,
    home: '/nonexistent-home',
    qrReadyTimeoutMs: 0, // token file never appears — fail fast in tests
    log: () => {}, warn: () => {},
  });
  await handle(ORG, frame({
    channel_type: 'wechat', action: 'connect', binding_id: 'bind-qr1', request_id: 'rq', credential_pull_token: 't',
  }));
  assert.equal(pulls.length, 0);                                    // no credential pull for QR channels
  assert.ok(execCalls.some((c) => c[1] === 'add' && c[2] === 'wechat'));
  assert.ok(execCalls.some((c) => c[0] === 'pm2'));
  assert.equal(reports.length, 1);
  // /nonexistent-home has no .admin-token → flow reports a clean error receipt
  assert.equal(reports[0].status, 'error');
  assert.match(reports[0].detail, /admin token/);
});

// ── batch 3: Fix B — disconnect DESTROYS the QR-channel session ───────────────
// A soft-disable left the logged-in session on disk; the next connect's QR
// helper then short-circuited to the OLD account (wechat 409 / whatsapp
// state:'open') and no fresh QR appeared. Disconnect must truly destroy it.

test('CHANNEL_COMPONENT: only wechat/whatsapp carry a logout (destroy-session) hook; form channels do NOT', () => {
  assert.ok(CHANNEL_COMPONENT.wechat.logout, 'wechat has logout');
  assert.ok(CHANNEL_COMPONENT.whatsapp.logout, 'whatsapp has logout');
  for (const type of ['feishu', 'lark', 'telegram', 'dingtalk', 'wecom', 'slack',
    'discord', 'zalo', 'line', 'whatsapp_business', 'ms_teams']) {
    assert.equal(CHANNEL_COMPONENT[type].logout, undefined, `${type} must keep soft-disable`);
  }
});

// -- wechatLogout unit --------------------------------------------------------

test('wechatLogout: cancels in-flight session, DELETEs every account via admin API, then stops; no file fallback', async () => {
  const calls = [];
  const fetchDep = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    if (url.endsWith('/v1/login/cancel')) return { status: 200, text: async () => '{"ok":true}' };
    if (url.endsWith('/v1/accounts') && opts.method === 'GET') {
      return { status: 200, text: async () => JSON.stringify({ ok: true, accounts: [{ normalizedAccountId: 'acc1' }, { normalizedAccountId: 'acc2' }] }) };
    }
    if (url.includes('/v1/accounts/') && opts.method === 'DELETE') return { status: 200, text: async () => '{"ok":true}' };
    return { status: 404, text: async () => '{}' };
  };
  const removed = [];
  const fsDep = { readFileSync: () => 'tok\n', rmSync: (p) => removed.push(String(p)) };
  let stopped = false;
  await wechatLogout({
    fetchDep, fsDep, home: '/h',
    stopService: async () => { stopped = true; return true; },
    active: { sessionId: 'sess-1' }, log: () => {}, warn: () => {},
  });
  assert.ok(stopped, 'service stopped');
  assert.ok(calls.some((c) => c.url.endsWith('/v1/login/cancel') && /sess-1/.test(c.body)), 'cancelled in-flight session by id');
  assert.ok(calls.some((c) => c.url.endsWith('/v1/accounts/acc1') && c.method === 'DELETE'));
  assert.ok(calls.some((c) => c.url.endsWith('/v1/accounts/acc2') && c.method === 'DELETE'));
  assert.equal(removed.length, 0, 'admin API reachable → NO file fallback');
});

test('wechatLogout: admin API unreachable → stops, then deletes accounts.json + accounts/ + login-sessions/ + context-tokens.json (fallback)', async () => {
  const fetchDep = async () => { throw new Error('ECONNREFUSED'); };
  const removed = [];
  const fsDep = { readFileSync: () => 'tok\n', rmSync: (p) => removed.push(String(p)) };
  let stopped = false;
  await wechatLogout({
    fetchDep, fsDep, home: '/h',
    stopService: async () => { stopped = true; return true; },
    active: null, log: () => {}, warn: () => {},
  });
  assert.ok(stopped);
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/accounts.json')));
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/login-sessions')));
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/context-tokens.json')));
});

test('wechatLogout: partial DELETE failure (GET 200 but one account DELETE non-200) → still runs file fallback after stop', async () => {
  const calls = [];
  const fetchDep = async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (url.endsWith('/v1/login/cancel')) return { status: 200, text: async () => '{}' };
    if (url.endsWith('/v1/accounts') && opts.method === 'GET') {
      return { status: 200, text: async () => JSON.stringify({ accounts: [{ normalizedAccountId: 'ok-acc' }, { normalizedAccountId: 'stale-acc' }] }) };
    }
    if (url.endsWith('/v1/accounts/ok-acc') && opts.method === 'DELETE') return { status: 200, text: async () => '{}' };
    if (url.endsWith('/v1/accounts/stale-acc') && opts.method === 'DELETE') return { status: 500, text: async () => '{"error":"boom"}' };
    return { status: 404, text: async () => '{}' };
  };
  const removed = [];
  const fsDep = { readFileSync: () => 'tok\n', rmSync: (p) => removed.push(String(p)) };
  let stopped = false;
  await wechatLogout({
    fetchDep, fsDep, home: '/h',
    stopService: async () => { stopped = true; return true; },
    active: null, log: () => {}, warn: () => {},
  });
  assert.ok(stopped, 'service stopped');
  assert.ok(calls.some((c) => c.url.endsWith('/v1/accounts/stale-acc') && c.method === 'DELETE'), 'attempted the failing DELETE');
  // Core of the fix: a non-200 DELETE must NOT count as confirmed removal, so
  // the file fallback runs and destroys the on-disk session even though the
  // admin API was reachable — otherwise the stale account revives via the 409
  // already-present path on the next connect (taskboard #50 rebind invariant).
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/accounts.json')), 'fallback deleted accounts.json');
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/accounts')), 'fallback deleted accounts/');
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/login-sessions')), 'fallback deleted login-sessions/');
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/wechat/context-tokens.json')), 'fallback deleted context-tokens.json');
});

// -- whatsappLogout unit ------------------------------------------------------

test('whatsappLogout: stops FIRST (Baileys holds files open), then removes auth_info + status.json + qr.png', async () => {
  const removed = [];
  const order = [];
  const fsDep = { rmSync: (p) => { removed.push(String(p)); order.push('rm'); } };
  await whatsappLogout({
    fsDep, home: '/h',
    stopService: async () => { order.push('stop'); return true; },
    log: () => {}, warn: () => {},
  });
  assert.equal(order[0], 'stop', 'stop happens before any file removal');
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/whatsapp/auth_info')));
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/whatsapp/status.json')));
  assert.ok(removed.some((p) => p.endsWith('/h/zylos/components/whatsapp/qr.png')));
});

// -- disconnect through the installer -----------------------------------------

test('disconnect wechat: admin DELETE each account + login/cancel AND pm2 stop AND reports disconnected', async () => {
  const fetchDep = async (url, opts) => {
    if (url.endsWith('/v1/accounts') && opts.method === 'GET') {
      return { status: 200, text: async () => JSON.stringify({ ok: true, accounts: [{ normalizedAccountId: 'a1' }] }) };
    }
    if (url.includes('/v1/accounts/') && opts.method === 'DELETE') return { status: 200, text: async () => '{"ok":true}' };
    if (url.endsWith('/v1/login/cancel')) return { status: 200, text: async () => '{"ok":true}' };
    return { status: 404, text: async () => '{}' };
  };
  const h = makeConnector({
    fetchDep,
    fsDep: { readFileSync: () => 'tok\n', rmSync: () => { throw new Error('should not delete files when API reachable'); } },
    home: '/tmp/nohome-wechat',
  });
  await h.handle(ORG, frame({ channel_type: 'wechat', action: 'disconnect', binding_id: 'bw', request_id: 'rw' }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-wechat'), 'pm2 stop zylos-wechat');
  assert.ok(h.fetches.some((f) => f.url.endsWith('/v1/accounts') && f.opts.method === 'GET'), 'listed accounts');
  assert.ok(h.fetches.some((f) => f.url.includes('/v1/accounts/a1') && f.opts.method === 'DELETE'), 'deleted the account');
  assert.deepEqual(h.configWrites, [{ component: 'wechat', patch: { enabled: false } }]);
  assert.equal(h.reports[0].status, 'disconnected');
});

test('disconnect wechat: admin API unreachable → file fallback deletes session files, still reports disconnected', async () => {
  const fetchDep = async () => { throw new Error('ECONNREFUSED'); };
  const removed = [];
  const h = makeConnector({
    fetchDep,
    fsDep: { readFileSync: () => 'tok\n', rmSync: (p) => removed.push(String(p)) },
    home: '/tmp/nohome-wechat2',
  });
  await h.handle(ORG, frame({ channel_type: 'wechat', action: 'disconnect', binding_id: 'bw2', request_id: 'rw2' }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-wechat'));
  assert.ok(removed.some((p) => p.endsWith('accounts.json')), 'fell back to file deletion');
  assert.equal(h.reports[0].status, 'disconnected');
});

test('disconnect whatsapp: after pm2 stop, removes auth_info + status.json + qr.png; reports disconnected', async () => {
  const removed = [];
  const h = makeConnector({
    fsDep: { readFileSync: () => 'x', rmSync: (p) => removed.push(String(p)) },
    home: '/tmp/nohome-wa',
  });
  await h.handle(ORG, frame({ channel_type: 'whatsapp', action: 'disconnect', binding_id: 'bwa', request_id: 'rwa' }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-whatsapp'));
  assert.ok(removed.some((p) => p.endsWith('auth_info')));
  assert.ok(removed.some((p) => p.endsWith('status.json')));
  assert.ok(removed.some((p) => p.endsWith('qr.png')));
  assert.deepEqual(h.configWrites, [{ component: 'whatsapp', patch: { enabled: false } }]);
  assert.equal(h.reports[0].status, 'disconnected');
});

test('disconnect feishu (form channel): soft-disable ONLY — no admin API call, no file removal (regression guard)', async () => {
  const removed = [];
  const h = makeConnector({
    fsDep: { readFileSync: () => 'x', rmSync: (p) => removed.push(String(p)) },
    home: '/tmp/nohome-feishu',
  });
  await h.handle(ORG, frame({ channel_type: 'feishu', action: 'disconnect', binding_id: 'bf', request_id: 'rf' }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-feishu'));
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: false } }]);
  assert.equal(h.fetches.length, 0, 'no admin/destroy HTTP call for a form channel');
  assert.equal(removed.length, 0, 'nothing destroyed on disk for a form channel');
  assert.equal(h.reports[0].status, 'disconnected');
});

// -- connect AFTER disconnect: fresh QR, not the old-session short-circuit -----

test('connect after disconnect (wechat): login/start returns 200 (no lingering account) → fresh QR relayed, NOT the 409 connected short-circuit', async () => {
  const qrs = [];
  let poll = 0;
  const sessions = [
    { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'FRESHQR' },
    { state: 'expired', sessionId: 's1' },
  ];
  const fetchDep = async (url) => {
    if (url.endsWith('/v1/login/start')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's1' } }) };
    if (url.endsWith('/v1/login/session')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: sessions[Math.min(poll++, 1)] }) };
    return { status: 404, text: async () => '{}' };
  };
  const res = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => 'tok' }, home: '/h', onQr: (q) => qrs.push(q),
    log: () => {}, timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.deepEqual(qrs, ['FRESHQR'], 'a fresh QR was relayed (session was destroyed by the prior disconnect)');
  assert.notEqual(res.status, 'connected', 'did NOT take the 409 already-connected short-circuit');
});

test('connect after disconnect (whatsapp): status.json absent → then qr_waiting → fresh QR relayed (no stale state:open short-circuit)', async () => {
  const qrs = [];
  let poll = 0;
  const states = [null, 'qr_waiting', 'open']; // null = file absent right after auth_info wipe
  const fsDep = {
    readFileSync: (p) => {
      if (String(p).endsWith('status.json')) {
        const s = states[Math.min(poll++, states.length - 1)];
        if (s === null) throw new Error('ENOENT');
        return JSON.stringify({ state: s });
      }
      return Buffer.from('WA-FRESH-QR');
    },
  };
  const res = await whatsappQrLogin({
    fsDep, home: '/h', onQr: (q) => qrs.push(q), log: () => {},
    timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.deepEqual(res, { status: 'connected', detail: '' });
  assert.deepEqual(qrs, [Buffer.from('WA-FRESH-QR').toString('base64')], 'QR relayed after a fresh start, not an immediate open');
});

// -- in-flight guard ----------------------------------------------------------

test('wechatQrLogin: onSession publishes id and shouldAbort() mid-loop cancels the session and returns aborted', async () => {
  const calls = [];
  let sessionSeen = '';
  let aborted = false;
  const fetchDep = async (url, opts) => {
    calls.push({ url, method: opts?.method });
    if (url.endsWith('/v1/login/start')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 'S9' } }) };
    if (url.endsWith('/v1/login/session')) { aborted = true; return { status: 200, text: async () => JSON.stringify({ ok: true, session: { state: 'qr_ready', sessionId: 'S9', qrPngBase64: 'Q' } }) }; }
    if (url.endsWith('/v1/login/cancel')) return { status: 200, text: async () => '{"ok":true}' };
    return { status: 404, text: async () => '{}' };
  };
  const res = await wechatQrLogin({
    fetchDep, fsDep: { readFileSync: () => 'tok' }, home: '/h', onQr: () => {},
    onSession: (sid) => { sessionSeen = sid; }, shouldAbort: () => aborted,
    log: () => {}, timeoutMs: 10_000, pollMs: 0, sleepDep: noSleep,
  });
  assert.equal(sessionSeen, 'S9', 'session id published for the disconnect to cancel');
  assert.equal(res.status, 'error');
  assert.match(res.detail, /aborted/);
  assert.ok(calls.some((c) => c.url.endsWith('/v1/login/cancel')), 'in-flight session cancelled');
});

test('in-flight guard: a disconnect during an active wechat login aborts it; the stale connect reports error (superseded), never connected', async () => {
  const reports = [];
  let releaseSession;
  const sessionGate = new Promise((r) => { releaseSession = r; });
  let firstPoll = true;
  const fsDep = { readFileSync: () => 'tok\n', rmSync: () => {} };
  const fetchDep = async (url, opts) => {
    if (url.endsWith('/v1/login/start')) return { status: 200, text: async () => JSON.stringify({ ok: true, session: { sessionId: 's1' } }) };
    if (url.endsWith('/v1/login/session')) {
      if (firstPoll) { firstPoll = false; await sessionGate; } // hold the loop open until the disconnect lands
      return { status: 200, text: async () => JSON.stringify({ ok: true, session: { state: 'qr_ready', sessionId: 's1', qrPngBase64: 'Q' } }) };
    }
    if (url.endsWith('/v1/login/cancel')) return { status: 200, text: async () => '{"ok":true}' };
    if (url.endsWith('/v1/accounts')) return { status: 200, text: async () => JSON.stringify({ ok: true, accounts: [] }) };
    return { status: 404, text: async () => '{}' };
  };
  const handle = createChannelInstaller({
    getForOrgWithHeaders: async () => ({}), apiPath, dedupe: () => false,
    execFile: async (f, a) => { if (f === 'zylos' && a[0] === 'info') throw new Error('not installed'); return { stdout: '' }; },
    writeEnv: () => {}, writeConfig: () => {}, verifyConnected: async () => true,
    reportResult: async (r) => reports.push(r), reportQR: async () => {},
    fetchDep, fsDep, home: '/tmp/nohome-inflight',
    qrPollMs: 0, qrReadyTimeoutMs: 5000, qrTimeoutMs: 5000,
    log: () => {}, warn: () => {},
  });

  const connectP = handle(ORG, frame({ channel_type: 'wechat', action: 'connect', binding_id: 'b1', request_id: 'r1' }));
  await new Promise((r) => setTimeout(r, 30)); // let connect start login + register activeLogins, then block at the gate
  await handle(ORG, frame({ channel_type: 'wechat', action: 'disconnect', binding_id: 'b1', request_id: 'r2' }));
  releaseSession(); // let the connect loop resume and observe the abort
  await connectP;

  const statuses = reports.map((r) => r.status);
  assert.ok(statuses.includes('disconnected'), 'disconnect reported');
  assert.ok(!statuses.includes('connected'), 'stale connect must NOT report connected');
  const stale = reports.find((r) => r.status === 'error');
  assert.ok(stale && /superseded by disconnect/.test(stale.detail), 'stale connect reported error/superseded');
});
