import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity, resolveActivityEnabled, shouldRegisterRun, replyConversationOf, ACTIVITY_TASKS } from './index.js';
import TaskRegistry from '../task-registry.js';

test('feature flag: off by default; env wins over config', () => {
  assert.equal(resolveActivityEnabled({ env: {}, config: {} }), false);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: {} } }), false);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: { enabled: true } } }), true);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: { enabled: 'yes' } } }), false);
  for (const v of ['0', 'false', 'OFF', 'no']) {
    assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: v }, config: { activity: { enabled: true } } }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'YES']) {
    assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: v }, config: {} }), true, v);
  }
  assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: 'maybe' }, config: {} }), false);
});

test('disabled: an inert stub — no run, no marker, no files, no stats line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-off-'));
  const runsDir = path.join(dir, 'runs');
  const a = createActivity({ config: {}, env: {}, runsDir });
  assert.equal(a.enabled, false);
  assert.equal(a.registerRun({ orgId: 'o', conversationId: 'c', endpoint: 'c' }), null);
  assert.equal(a.onServerError('o', { code: 'UNKNOWN_FRAME_TYPE', message: 'agent_activity' }), false);
  assert.equal(a.statsLine(), null);
  a.start();
  a.stop();
  assert.equal(fs.existsSync(runsDir), false, 'nothing written while off');
});

test('disabled: a run index left from an enabled period is removed so send.js stops attaching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-off-'));
  fs.writeFileSync(path.join(dir, 'active.json'), '{"v":1,"by_conversation":{},"gate":{"o":"open"}}');
  createActivity({ config: {}, env: {}, runsDir: dir });
  assert.equal(fs.existsSync(path.join(dir, 'active.json')), false);
});

// Decisions in the exact shapes shouldHandleMessage returns (src/comm-bridge.js).
test('run registration rule (DM always; group / thread only when @-mentioned)', () => {
  const cases = [
    ['dm', { handle: true, reason: 'dm:owner-exempt' }, true],
    ['dm', { handle: true, reason: 'system-sender' }, true],
    ['group', { handle: true, reason: 'group:allowlist/smart', mode: 'smart', mentioned: true }, true],
    ['group', { handle: true, reason: 'group:allowlist/smart', mode: 'smart', mentioned: false }, false],
    ['group', { handle: true, reason: 'group:allowlist/mention [owner-mention-bypass]', mode: 'mention', mentioned: true }, true],
    ['thread', { handle: true, reason: 'group:open/mention', mode: 'mention', mentioned: true }, true],
    ['group', { handle: true, reason: 'system-sender' }, false],
  ];
  for (const [convType, decision, want] of cases) {
    assert.equal(shouldRegisterRun({ enabled: true, convType, decision }), want, `${convType} ${decision.reason} ${decision.mentioned}`);
    assert.equal(shouldRegisterRun({ enabled: false, convType, decision }), false);
  }
});

test('replyConversationOf: thread wins over the parent conversation', () => {
  assert.equal(replyConversationOf('c1|reply:9'), 'c1');
  assert.equal(replyConversationOf('c1|thread:t1|parent:9'), 't1');
  assert.equal(replyConversationOf(''), null);
});

// ── timers on TaskRegistry, hot ones only while a run is open ──────────────
const HOT = [ACTIVITY_TASKS.emit, ACTIVITY_TASKS.poll, ACTIVITY_TASKS.discovery];
const running = (tasks) => tasks.list().filter((t) => t.running).map((t) => t.name).sort();

function lazyHarness({ runsDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-lazy-'));
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const tasks = new TaskRegistry();
  const sent = [];
  const a = createActivity({
    config: { activity: { enabled: true } }, env: {}, now: clock.now, tasks,
    runsDir: runsDir || path.join(dir, 'runs'), homeDir: dir, zylosDir: dir, runtime: 'claude',
  });
  a.bindOrgWs('org', { trySend: (f) => { sent.push(f); return true; } });
  return { a, tasks, clock, sent };
}

test('timers: at boot only activity-cleanup runs; registerRun starts emit / poll / discovery', () => {
  const { a, tasks } = lazyHarness();
  assert.deepEqual(tasks.list().map((x) => x.name).sort(), Object.values(ACTIVITY_TASKS).sort());
  assert.deepEqual(running(tasks), []);
  a.start();
  assert.deepEqual(running(tasks), [ACTIVITY_TASKS.cleanup]);
  assert.equal(a.timersActive, false);
  a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  assert.deepEqual(running(tasks), [...HOT, ACTIVITY_TASKS.cleanup].sort());
  assert.match(a.statsLine(), /timers=on/);
  a.stop();
  assert.deepEqual(running(tasks), []);
});

test('timers: they stop on the 2nd idle emit tick after the run closed and its done frame went out; a new run restarts them', async () => {
  const { a, tasks, sent } = lazyHarness();
  a.start();
  const reg = a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  a.confirmRun(reg.runId, '{"ok":true,"id":1}');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, true, 'an open run keeps them');
  let idleMarks = 0;
  const markIdle = a.collector.markIdle;
  a.collector.markIdle = () => { idleMarks += 1; markIdle(); };
  a.attribution.closeRun(a.attribution.getRun(reg.runId), 'done');
  assert.equal(sent.at(-1).payload.state, 'done', 'the terminal frame is sent at close');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, true, 'idle seen once: not yet (no thrash)');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, false);
  assert.deepEqual(running(tasks), [ACTIVITY_TASKS.cleanup]);
  assert.equal(idleMarks, 1, 'the collector skips the idle gap on the next start');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(idleMarks, 1, 'stopping is idempotent');
  a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  assert.equal(a.timersActive, true);
  a.stop();
});

test('timers: a run arriving between the two idle ticks cancels the stop', async () => {
  const { a, tasks } = lazyHarness();
  a.start();
  const r1 = a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  a.dropRun(r1.runId);
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, true);
  a.stop();
});

test('timers: a sent probe awaiting confirmation keeps the emit tick until the gate opens', async () => {
  const { a, tasks, clock } = lazyHarness();
  a.onWsOpen('org');
  a.start();
  const reg = a.registerRun({ orgId: 'org', conversationId: 'c1', endpoint: 'c1' });
  a.confirmRun(reg.runId, '{"ok":true,"id":1}');      // first frame = probe
  a.attribution.closeRun(a.attribution.getRun(reg.runId), 'done');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, true, 'gate still pending');
  assert.equal(a.emitter.gateOf('org'), 'pending');
  clock.advance(2_100);
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.emitter.gateOf('org'), 'open');
  await tasks.tickNow(ACTIVITY_TASKS.emit);
  assert.equal(a.timersActive, false);
  a.stop();
});

test('timers: open runs recovered at boot start the hot timers', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-rec-'));
  fs.writeFileSync(path.join(runsDir, 'r_0000abcd.json'), JSON.stringify({
    v: 1, run_id: 'r_0000abcd', org_id: 'org', conversation_id: 'c1', created_at: Date.now() - 1000,
    state: 'queued', events: [], dropped: 0, next_event: 1, seq: 1,
  }));
  const { a, tasks } = lazyHarness({ runsDir });
  a.start();
  assert.deepEqual(running(tasks), [...HOT, ACTIVITY_TASKS.cleanup].sort());
  a.stop();
  // Only closed runs on disk: nothing hot.
  const closedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-rec-'));
  fs.writeFileSync(path.join(closedDir, 'r_0000abce.json'), JSON.stringify({
    v: 1, run_id: 'r_0000abce', org_id: 'org', conversation_id: 'c1', created_at: Date.now() - 1000,
    state: 'closed', ended_at: Date.now() - 500, events: [], dropped: 0, next_event: 1, seq: 2,
  }));
  const h2 = lazyHarness({ runsDir: closedDir });
  h2.a.start();
  assert.deepEqual(running(h2.tasks), [ACTIVITY_TASKS.cleanup]);
  h2.a.stop();
});

test('timers: disabled registers nothing on the registry', () => {
  const tasks = new TaskRegistry();
  const a = createActivity({ config: {}, env: {}, tasks, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-off-')) });
  a.start();
  a.registerRun({ orgId: 'o', conversationId: 'c', endpoint: 'c' });
  assert.deepEqual(tasks.list(), []);
});
