import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmitter } from './emitter.js';
import { validateActivityFrame, validateFrameV3 } from './testdata/validators.js';

const ORG = 'org-1';

function setup({ connected = true } = {}) {
  let t = 1760000000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const stats = { frames_sent: 0, frames_dropped: 0, events_dropped: 0, unknown_frame_type: 0, server_errors: {} };
  const throttled = [];
  const gates = [];
  const sent = [];
  const ws = {
    connected,
    lastSentType: null,
    lastSentAt: 0,
    trySend(frame) {
      if (!this.connected) return false;
      sent.push(JSON.parse(JSON.stringify(frame)));
      this.lastSentType = frame.type;
      this.lastSentAt = t;
      return true;
    },
  };
  const em = createEmitter({
    now: clock.now,
    stats,
    throttle: { warn: (...a) => throttled.push(a) },
    onGateChange: (org, g) => gates.push(g),
  });
  em.bindOrgWs(ORG, ws);
  em.onWsOpen(ORG);
  const run = {
    run_id: 'r_8c1f2a9d', org_id: ORG, conversation_id: '019f0000-aaaa-7bbb-8ccc-000000000001',
    source_message_id: '7383920118271', created_at: t, seq: 0, dropped: 0,
  };
  em.track(run);
  return { em, run, ws, sent, stats, clock, throttled, gates };
}

function assertValid(frame, now) {
  const r = validateActivityFrame(JSON.stringify(frame), now);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = frame.payload;
  assert.equal(p.schema_version, 3);
  for (const k of ['category', 'reason', 'events', 'title']) assert.equal(k in p, false, k);
  assert.deepEqual(validateFrameV3(p), []);
}

test('first frame after connect is a probe without steps; steps follow ≥ 500 ms later', () => {
  const { em, run, sent, clock } = setup();
  em.setState(run, 'queued');
  em.emitNow(run);
  em.setState(run, 'thinking');
  em.pushEvent(run, { id: 'e1', kind: 'commentary', text: 'hi', at: clock.now() });
  clock.advance(100);
  em.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.state, 'queued');
  assert.deepEqual(sent[0].payload.steps, []);
  assert.equal(sent[0].payload.step_count, 0);
  assert.equal(sent[0].payload.sequence, 1);
  clock.advance(450);
  em.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'thinking');
  assert.deepEqual(sent[1].payload.steps, [{ id: 'e1', kind: 'thinking', at: sent[1].payload.steps[0].at, body: 'hi' }]);
  assert.equal(sent[1].payload.sequence, 2);
  for (const f of sent) assertValid(f, clock.now());
});

test('500 ms merge window accumulates steps and merges tool start/end into one step; state stays thinking', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  run.exec_started_at = clock.now();
  em.setState(run, 'thinking');
  run.step_count = 2;
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', object: 'a.md', at: clock.now() });
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', object: 'a.md', at: clock.now(), ended_at: clock.now() + 5, error: false });
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', title: '跑测试', at: clock.now() });
  em.tick();
  assert.equal(sent.length, 2);
  const f = sent[1].payload;
  assert.equal(f.state, 'thinking');
  assert.equal(f.exec_started_at, clock.now());
  assert.equal(f.step_count, 2);
  assert.deepEqual(f.steps, [
    { id: 'e1', kind: 'tool', category: 'read', status: 'ok', at: clock.now(), ended_at: clock.now() + 5, object: 'a.md' },
    { id: 'e2', kind: 'tool', category: 'command', status: 'running', at: clock.now(), title: '跑测试', wait_for: 'command_result' },
  ]);
  clock.advance(100);
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', title: '跑测试', at: clock.now() - 100, ended_at: clock.now(), error: false,
    detail: { type: 'output', exit_code: 0, lines: 3, truncated: false } });
  em.tick();
  assert.equal(sent.length, 2, 'inside the window nothing is sent');
  clock.advance(400);
  em.tick();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2].payload.steps[0].detail, { type: 'output', exit_code: 0, lines: 3, truncated: false });
  for (const fr of sent) assertValid(fr, clock.now());
});

test('terminal frame goes out immediately with ended_at and an end_reason key (no title / reason / category fields)', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(10);
  run.reason = null;
  em.finish(run, 'done', 'no_reply');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'done');
  assert.equal(sent[1].payload.end_reason, 'no_reply');
  assert.equal(sent[1].payload.ended_at, clock.now());
  em.finish(run, 'failed', 'interrupted');
  assert.equal(sent[2].payload.end_reason, 'interrupted');
  em.finish(run, 'failed', 'runtime_restarted');
  assert.equal(sent[3].payload.end_reason, 'runtime_restarted');
  em.finish(run, 'done');
  assert.equal('end_reason' in sent[4].payload, false);
  for (const f of sent) assertValid(f, clock.now());
});

test('exec_started_at: absent while queued, clamped into [started_at, now] once set', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  assert.equal('exec_started_at' in sent[0].payload, false);
  clock.advance(1000);
  run.exec_started_at = run.created_at - 5;
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent[1].payload.exec_started_at, run.created_at);
  run.exec_started_at = clock.now() + 60_000;
  em.touch(run);
  clock.advance(600);
  em.tick();
  assert.equal(sent[2].payload.exec_started_at, clock.now());
  for (const f of sent) assertValid(f, clock.now());
});

test('10 s heartbeat for an idle open run', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(9_000);
  em.tick();
  assert.equal(sent.length, 1);
  clock.advance(1_000);
  em.tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].payload.steps, []);
});

test('frames split at 50 steps and at 15,360 bytes', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  for (let i = 0; i < 70; i++) em.pushEvent(run, { id: `n${i}`, kind: 'notice', code: 'merged_turn', at: clock.now() });
  em.tick();
  assert.equal(sent[1].payload.steps.length, 50);
  clock.advance(600);
  em.tick();
  assert.equal(sent[2].payload.steps.length, 20);
  for (let i = 0; i < 20; i++) em.pushEvent(run, { id: `c${i}`, kind: 'commentary', text: '字'.repeat(1500), at: clock.now() });
  clock.advance(600);
  em.tick();
  const bytes = Buffer.byteLength(JSON.stringify(sent[3]));
  assert.ok(bytes <= 15_360, `${bytes}`);
  assert.ok(sent[3].payload.steps.length < 20);
  for (const f of sent) assertValid(f, clock.now());
});

test('pending buffer capped at 500: oldest dropped and counted', () => {
  const { em, run, sent, clock, stats } = setup();
  em.emitNow(run);
  for (let i = 0; i < 510; i++) em.pushEvent(run, { id: `n${i}`, kind: 'notice', code: 'merged_turn', at: clock.now() });
  assert.equal(run.dropped, 10);
  assert.equal(stats.events_dropped, 10);
  clock.advance(600);
  em.tick();
  assert.equal(sent[1].payload.dropped, 10);
  assert.equal(sent[1].payload.steps[0].id, 'n10');
});

test('disconnected: trySend false, nothing buffered or re-sent, sequence still advances', () => {
  const { em, run, sent, ws, clock, stats } = setup({ connected: false });
  em.emitNow(run);
  clock.advance(600);
  em.pushEvent(run, { id: 'e1', kind: 'notice', code: 'merged_turn', at: clock.now() });
  em.tick();
  assert.equal(sent.length, 0);
  assert.equal(stats.frames_dropped, 2);
  assert.equal(run.seq, 2);
  ws.connected = true;
  em.onWsOpen(ORG);
  clock.advance(600);
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.sequence, 3);
  assert.deepEqual(sent[0].payload.steps, [], 'probe after reconnect carries no steps');
});

test('gate: pending → open 2 s after the probe; UNKNOWN_FRAME_TYPE → closed, stop, one warn; reconnect retries', () => {
  const { em, run, sent, clock, gates, throttled, ws } = setup();
  assert.deepEqual(gates, ['pending']);
  em.emitNow(run);
  clock.advance(1_999);
  em.tick();
  assert.equal(em.gateOf(ORG), 'pending');
  clock.advance(1);
  em.tick();
  assert.equal(em.gateOf(ORG), 'open');

  assert.equal(em.onServerError(ORG, { code: 'UNKNOWN_FRAME_TYPE', message: 'unrecognized frame type: agent_activity' }), true);
  assert.equal(em.gateOf(ORG), 'closed');
  em.onServerError(ORG, { code: 'UNKNOWN_FRAME_TYPE', message: 'unrecognized frame type: agent_activity' });
  const ufWarns = throttled.filter((a) => a[0] === 'unknown_frame_type');
  assert.equal(ufWarns.length, 1, 'one warn per connection');
  assert.match(ufWarns[0][1], /lastSentType=agent_activity/);
  const before = sent.length;
  clock.advance(600);
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent.length, before, 'stopped on this connection');

  em.onWsOpen(ORG);
  assert.equal(em.gateOf(ORG), 'pending');
  clock.advance(600);
  em.setState(run, 'tool', 'read');
  em.tick();
  assert.equal(sent.length, before + 1);
  assert.equal(ws.lastSentType, 'agent_activity');
});

test('UNKNOWN_FRAME_TYPE attribution: message names agent_activity, or lastSentType; otherwise not ours', () => {
  const a = setup();
  a.ws.lastSentType = 'pong';
  assert.equal(a.em.onServerError(ORG, { code: 'UNKNOWN_FRAME_TYPE', message: 'unrecognized frame type: agent_activity' }), true);
  const b = setup();
  b.ws.lastSentType = 'agent_activity';
  assert.equal(b.em.onServerError(ORG, { code: 'UNKNOWN_FRAME_TYPE', message: 'something else' }), true);
  const c = setup();
  c.ws.lastSentType = 'typing';
  assert.equal(c.em.onServerError(ORG, { code: 'UNKNOWN_FRAME_TYPE', message: 'unrecognized frame type: typing2' }), false);
  assert.equal(c.em.gateOf(ORG), 'pending');
  assert.equal(c.throttled.length, 0);
});

test('INVALID_PAYLOAD / FORBIDDEN are counted and throttled; 10 FORBIDDEN keep the conversation local', () => {
  const { em, run, sent, clock, stats, throttled } = setup();
  em.emitNow(run);
  for (let i = 0; i < 10; i++) em.onServerError(ORG, { code: 'FORBIDDEN', message: 'not an agent member' });
  assert.equal(stats.server_errors.FORBIDDEN, 10);
  assert.equal(throttled.length, 10, 'routed through the throttled logger');
  const before = sent.length;
  clock.advance(600);
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent.length, before);
});

test('over 50 concurrent runs: the newest only send state, their events count as dropped', () => {
  const { em, run, clock } = setup();
  const extra = [];
  for (let i = 0; i < 50; i++) {
    const r = { ...run, run_id: `r_0000${String(i).padStart(4, '0')}`, _em: undefined };
    em.track(r);
    extra.push(r);
  }
  const newest = extra[extra.length - 1];
  em.pushEvent(newest, { id: 'e1', kind: 'notice', code: 'merged_turn', at: clock.now() });
  assert.equal(newest.dropped, 1);
  em.pushEvent(run, { id: 'e1', kind: 'notice', code: 'merged_turn', at: clock.now() });
  assert.equal(run.dropped, 0);
});

test('the Bash description (the step title) is on live steps too; same step keys as the summary', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  const ev = { id: 'e1', kind: 'tool', category: 'command', title: '查看 git 工作区状态', at: clock.now() };
  em.pushEvent(run, ev);
  em.pushEvent(run, { ...ev, ended_at: clock.now() + 5, error: false });
  em.tick();
  const steps = sent.flatMap((f) => f.payload.steps);
  assert.equal(steps.length, 1);
  assert.deepEqual(Object.keys(steps[0]), ['id', 'kind', 'category', 'status', 'at', 'ended_at', 'title']);
  assert.equal(steps[0].title, '查看 git 工作区状态');
  for (const f of sent) assertValid(f, clock.now());
});

test('an end after its start was sent is a full upsert step; reply / waiting events never reach the frame', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'tool', title: 'SendMessage', at: clock.now() });
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'reply', at: clock.now() });
  em.pushEvent(run, { id: 'e3', kind: 'tool', category: 'waiting', at: clock.now() });
  em.tick();
  assert.deepEqual(sent[1].payload.steps, [{ id: 'e1', kind: 'tool', category: 'tool', status: 'running', at: clock.now(), title: 'SendMessage', wait_for: 'tool_result' }]);
  clock.advance(600);
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'tool', title: 'SendMessage', at: clock.now() - 600, ended_at: clock.now(), error: true });
  em.tick();
  assert.deepEqual(sent[2].payload.steps[0], { id: 'e1', kind: 'tool', category: 'tool', status: 'error', at: clock.now() - 600, ended_at: clock.now(), title: 'SendMessage' });
  for (const f of sent) assertValid(f, clock.now());
});

test('a live detail stays ≤ 4 KiB (summary caps already keep the largest links detail under it)', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  const items = Array.from({ length: 8 }, (_, i) => ({ title: `${i} ${'标题'.repeat(39)}`, url: `https://e${i}.example.com/${'p'.repeat(180)}` }));
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'search_web', at: clock.now(), ended_at: clock.now() + 1, error: false,
    detail: { type: 'links', total: 8, truncated: false, items } });
  em.tick();
  const d = sent[1].payload.steps[0].detail;
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 4096);
  assert.equal(d.items.length, 8);
  for (const f of sent) assertValid(f, clock.now());
});
