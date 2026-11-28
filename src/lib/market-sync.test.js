import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarketSyncController, parseMarketSyncRequest, handleMarketSyncEvent, MARKET_SYNC_EVENT, MARKET_SYNC_ARGS,
} from './market-sync.js';
import { classifySystemEvent } from './system-event-routing.js';

const BIN = '/z/bin/market-client';
const SELF = 'm-self';

// execFile stub: each call returns a promise settled by the test.
function fakeExec() {
  const calls = [];
  const fn = (file, args, opts) => new Promise((resolve, reject) => {
    calls.push({ file, args, opts, resolve, reject });
  });
  return { fn, calls };
}

const exitErr = (code) => Object.assign(new Error('Command failed'), { code });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(overrides = {}) {
  const exec = fakeExec();
  const logs = [];
  const warns = [];
  const missing = [];
  const ctl = createMarketSyncController({
    execFile: exec.fn,
    marketClientBin: BIN,
    onClientMissing: () => { missing.push(1); return Promise.resolve(); },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    ...overrides,
  });
  return { ctl, exec, logs, warns, missing };
}

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); });
afterEach(() => { mock.timers.reset(); });

test('event is routed as a config update', () => {
  assert.equal(MARKET_SYNC_EVENT, 'agent.config.market_sync_requested');
  assert.equal(classifySystemEvent(MARKET_SYNC_EVENT), 'config_update');
});

test('parse: valid frame for self', () => {
  const r = parseMarketSyncRequest({ agent_member_id: SELF, request_id: 'r1', reason: 'hire', extra: { x: 1 } }, SELF);
  assert.deepEqual(r, { ok: true, requestId: 'r1', reason: 'hire' });
});

test('parse: other agent, missing member id, bad request id are rejected', () => {
  assert.equal(parseMarketSyncRequest({ agent_member_id: 'other', request_id: 'r1' }, SELF).ok, false);
  assert.equal(parseMarketSyncRequest({ request_id: 'r1' }, SELF).ok, false);
  assert.equal(parseMarketSyncRequest({ agent_member_id: SELF, request_id: '' }, SELF).ok, false);
  assert.equal(parseMarketSyncRequest({ agent_member_id: SELF, request_id: 7 }, SELF).ok, false);
  assert.equal(parseMarketSyncRequest({ agent_member_id: SELF, request_id: 'r1' }, '').ok, false);
  assert.equal(parseMarketSyncRequest(null, SELF).ok, false);
});

test('parse: unknown reason is not passed through', () => {
  const r = parseMarketSyncRequest({ agent_member_id: SELF, request_id: 'r1', reason: 'rm -rf /' }, SELF);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'unknown');
});

test('runs the fixed binary with fixed argv, no shell', async () => {
  const { ctl, exec } = setup();
  assert.equal(ctl.request('r1', { reason: 'hire' }), 'started');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, BIN);
  assert.deepEqual(exec.calls[0].args, ['sync', '--wait', '5']);
  assert.deepEqual(MARKET_SYNC_ARGS, ['sync', '--wait', '5']);
  assert.ok(!exec.calls[0].opts?.shell);
  assert.ok(exec.calls[0].opts.timeout > 5000);
});

test('frame contents never influence argv', async () => {
  const { ctl, exec } = setup();
  const data = { agent_member_id: SELF, request_id: '--wait 0; touch /tmp/x', reason: 'update', changed_by: '$(id)', cmd: 'x' };
  assert.equal(parseMarketSyncRequest(data, SELF).ok, false);
  const parsed = parseMarketSyncRequest({ ...data, request_id: 'ok-1' }, SELF);
  ctl.request(parsed.requestId, { reason: parsed.reason });
  ctl.request(data.request_id, { reason: data.reason });
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  assert.equal(exec.calls.length, 2);
  for (const c of exec.calls) {
    assert.equal(c.file, BIN);
    assert.deepEqual(c.args, ['sync', '--wait', '5']);
    assert.ok(!c.opts?.shell);
  }
  assert.equal(exec.calls[0].file, BIN);
  assert.deepEqual(exec.calls[0].args, ['sync', '--wait', '5']);
});

test('dedupe by request id', async () => {
  const { ctl, exec } = setup();
  assert.equal(ctl.request('r1'), 'started');
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(5000);
  assert.equal(ctl.request('r1'), 'duplicate');
  assert.equal(exec.calls.length, 1);
});

test('dedupe memory expires after 10 minutes', async () => {
  const { ctl, exec } = setup();
  ctl.request('r1');
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(ctl.request('r1'), 'started');
});

test('dedupe memory is bounded to 256 ids', async () => {
  const { ctl, exec } = setup();
  for (let i = 0; i < 257; i++) ctl.request(`r${i}`);
  // r0 was evicted; r256 is still remembered.
  assert.equal(ctl.request('r256'), 'duplicate');
  assert.notEqual(ctl.request('r0'), 'duplicate');
  assert.equal(exec.calls.length, 1);
});

test('coalescing: requests during a run queue exactly one follow-up', async () => {
  const { ctl, exec } = setup();
  assert.equal(ctl.request('a'), 'started');
  assert.equal(ctl.request('b'), 'queued');
  assert.equal(ctl.request('c'), 'coalesced');
  assert.equal(exec.calls.length, 1);
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  assert.equal(exec.calls.length, 2, 'follow-up starts when the run ends');
  exec.calls[1].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(5000);
  await flush();
  assert.equal(exec.calls.length, 2, 'no further runs');
});

test('coalescing: request within 2 s after a run starts at the end of the window', async () => {
  const { ctl, exec } = setup();
  ctl.request('a');
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(500);
  assert.equal(ctl.request('b'), 'queued');
  assert.equal(ctl.request('c'), 'coalesced');
  assert.equal(exec.calls.length, 1);
  mock.timers.tick(1499);
  await flush();
  assert.equal(exec.calls.length, 1);
  mock.timers.tick(1);
  await flush();
  assert.equal(exec.calls.length, 2);
});

test('coalescing: request after the 2 s window runs immediately', async () => {
  const { ctl, exec } = setup();
  ctl.request('a');
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(2000);
  await flush();
  assert.equal(ctl.request('b'), 'started');
  assert.equal(exec.calls.length, 2);
});

test('exit 0 and 4 log info; other codes warn with the code', async () => {
  const { ctl, exec, logs, warns } = setup();
  ctl.request('a');
  exec.calls[0].resolve({ stdout: 'ignored output' });
  await flush();
  assert.ok(logs.some((l) => /exit=0/.test(l)));
  mock.timers.tick(2000);
  ctl.request('b');
  exec.calls[1].reject(exitErr(4));
  await flush();
  assert.ok(logs.some((l) => /exit=4/.test(l)));
  assert.equal(warns.length, 0);
  mock.timers.tick(2000);
  ctl.request('c');
  exec.calls[2].reject(exitErr(1));
  await flush();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /exit=1/);
  assert.ok(!warns[0].includes('ignored output'));
  mock.timers.tick(2000);
  ctl.request('d');
  exec.calls[3].reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }));
  await flush();
  assert.equal(warns.length, 2);
  assert.match(warns[1], /signal=SIGTERM/);
});

test('missing binary triggers the ensure check immediately', async () => {
  const { ctl, exec, missing, warns } = setup();
  ctl.request('a');
  exec.calls[0].reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await flush();
  assert.equal(missing.length, 1);
  assert.ok(warns.some((w) => /not installed/.test(w)));
});

test('missing binary: ensure is not re-entered while one is in flight', async () => {
  let release;
  const missing = [];
  const { ctl, exec } = setup({
    onClientMissing: () => { missing.push(1); return new Promise((r) => { release = r; }); },
  });
  const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  ctl.request('a');
  exec.calls[0].reject(enoent());
  await flush();
  mock.timers.tick(2000);
  ctl.request('b');
  exec.calls[1].reject(enoent());
  await flush();
  assert.equal(missing.length, 1);
  release();
  await flush();
  mock.timers.tick(2000);
  ctl.request('c');
  exec.calls[2].reject(enoent());
  await flush();
  assert.equal(missing.length, 2);
});

test('a throwing ensure hook or exec never escapes request()', async () => {
  const { ctl } = setup({
    execFile: () => { throw new Error('sync throw'); },
    onClientMissing: () => { throw new Error('boom'); },
  });
  assert.doesNotThrow(() => ctl.request('a'));
  await flush();
});

test('synthetic reconnect ids are never deduped', async () => {
  const { ctl, exec } = setup();
  assert.equal(ctl.requestResync('ws-open'), 'started');
  exec.calls[0].resolve({ stdout: '' });
  await flush();
  mock.timers.tick(2000);
  assert.equal(ctl.requestResync('ws-open'), 'started');
  assert.equal(exec.calls.length, 2);
});

test('handler: other-agent frame is ignored, own frame runs once', async () => {
  const { ctl, exec, warns } = setup();
  handleMarketSyncEvent({ agent_member_id: 'other', request_id: 'r1' }, { selfMemberId: SELF, controller: ctl, slug: 'o', warn: (m) => warns.push(m) });
  handleMarketSyncEvent({ request_id: 'r1' }, { selfMemberId: SELF, controller: ctl, slug: 'o', warn: (m) => warns.push(m) });
  assert.equal(exec.calls.length, 0);
  assert.equal(warns.length, 2);
  handleMarketSyncEvent({ agent_member_id: SELF, request_id: 'r1', reason: 'hire' }, { selfMemberId: SELF, controller: ctl, slug: 'o' });
  handleMarketSyncEvent({ agent_member_id: SELF, request_id: 'r1', reason: 'hire' }, { selfMemberId: SELF, controller: ctl, slug: 'o' });
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0].args, ['sync', '--wait', '5']);
});
