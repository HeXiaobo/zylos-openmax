import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmitter } from './emitter.js';
import { validateActivityFrame } from './testdata/validators.js';

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
  assert.equal(p.schema_version, 2);
  assert.equal(typeof p.title, 'string');
  assert.ok(Array.from(p.title).length <= 80);
  for (const k of ['category', 'reason', 'events']) assert.equal(k in p, false, k);
  for (const st of p.steps) {
    assert.ok(['action', 'text', 'note'].includes(st.kind));
    assert.ok(st.kind === 'text' ? st.body : st.title);
    if (st.kind === 'action') assert.equal(st.body, undefined, 'no action body on live frames');
  }
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
  assert.equal(sent[0].payload.title, '排队中');
  assert.equal(sent[0].payload.sequence, 1);
  clock.advance(450);
  em.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'thinking');
  assert.deepEqual(sent[1].payload.steps, [{ id: 'e1', kind: 'text', at: sent[1].payload.steps[0].at, body: 'hi' }]);
  assert.equal(sent[1].payload.title, '正在思考');
  assert.equal(sent[1].payload.sequence, 2);
  for (const f of sent) assertValid(f, clock.now());
});

test('500 ms merge window keeps only the latest state, accumulates steps, merges tool start/end into one step', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  em.setState(run, 'tool', 'read');
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', tool: 'Read', at: clock.now() });
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', tool: 'Read', at: clock.now(), ended_at: clock.now() + 5, error: false });
  em.setState(run, 'tool', 'command', { tool: 'Bash', detail: 'node' });
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', at: clock.now() });
  em.tick();
  assert.equal(sent.length, 2);
  const f = sent[1].payload;
  assert.equal(f.state, 'tool');
  assert.equal(f.title, '正在执行命令 · Bash · node');
  assert.deepEqual(f.steps, [
    { id: 'e1', kind: 'action', status: 'ok', at: clock.now(), ended_at: clock.now() + 5, title: '读取文件', tags: ['Read'] },
    { id: 'e2', kind: 'action', status: 'running', at: clock.now(), title: '执行命令', tags: ['Bash', 'node'] },
  ]);
  clock.advance(100);
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent.length, 2, 'inside the window nothing is sent');
  clock.advance(400);
  em.tick();
  assert.equal(sent.length, 3);
  for (const fr of sent) assertValid(fr, clock.now());
});

test('terminal frame goes out immediately with ended_at and a terminal title (no reason / category fields)', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(10);
  run.reason = null;
  em.finish(run, 'done', 'no_reply');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'done');
  assert.equal(sent[1].payload.title, '已结束');
  assert.equal(sent[1].payload.ended_at, clock.now());
  em.finish(run, 'failed', 'interrupted');
  assert.equal(sent[2].payload.title, '已中断');
  em.finish(run, 'failed', 'runtime_restarted');
  assert.equal(sent[3].payload.title, '已中断（Agent 重启）');
  em.finish(run, 'done');
  assert.equal(sent[4].payload.title, '已完成');
  assertValid(sent[2], clock.now());
  assertValid(sent[1], clock.now());
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

test('a host-local `description` on a tool event never reaches the frame; live step keys are the v2 display keys', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  em.setState(run, 'tool', 'command');
  const ev = { id: 'e1', kind: 'tool', category: 'command', tool: 'Bash', detail: 'git', description: '查看 git 工作区状态', at: clock.now() };
  em.pushEvent(run, ev);
  em.pushEvent(run, { ...ev, ended_at: clock.now() + 5, error: false });
  em.tick();
  const steps = sent.flatMap((f) => f.payload.steps);
  assert.equal(steps.length, 1);
  assert.deepEqual(Object.keys(steps[0]), ['id', 'kind', 'status', 'at', 'ended_at', 'title', 'tags']);
  assert.equal(JSON.stringify(sent).includes('工作区'), false);
  assert.equal(ev.description, '查看 git 工作区状态', 'the caller\'s event is not mutated');
  for (const f of sent) assertValid(f, clock.now());
});

test('tags on live steps only from the allowlists; an end after its start was sent is a full upsert step', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  em.setState(run, 'tool', 'tool', { tool: 'mcp__secret__x', detail: 'evilbin' });
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'tool', tool: 'mcp__secret__x', detail: 'evilbin', at: clock.now() });
  em.tick();
  assert.equal(sent[1].payload.title, '正在调用工具');
  assert.deepEqual(sent[1].payload.steps[0], { id: 'e1', kind: 'action', status: 'running', at: clock.now(), title: '调用工具' });
  clock.advance(600);
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'tool', tool: 'mcp__secret__x', detail: 'evilbin', at: clock.now() - 600, ended_at: clock.now(), error: true });
  em.tick();
  assert.deepEqual(sent[2].payload.steps[0], { id: 'e1', kind: 'action', status: 'error', at: clock.now() - 600, ended_at: clock.now(), title: '调用工具' });
  assert.equal(JSON.stringify(sent).includes('secret'), false);
  assert.equal(JSON.stringify(sent).includes('evilbin'), false);
  for (const f of sent) assertValid(f, clock.now());
});
