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
  assert.deepEqual(r.droppedEvents, []);
  assert.deepEqual(r.unknownEnums, []);
}

test('first frame after connect is a probe without events; events follow ≥ 500 ms later', () => {
  const { em, run, sent, clock } = setup();
  em.setState(run, 'queued');
  em.emitNow(run);
  em.setState(run, 'thinking');
  em.pushEvent(run, { id: 'e1', kind: 'commentary', text: 'hi', at: clock.now() });
  clock.advance(100);
  em.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.state, 'queued');
  assert.deepEqual(sent[0].payload.events, []);
  assert.equal(sent[0].payload.sequence, 1);
  clock.advance(450);
  em.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'thinking');
  assert.equal(sent[1].payload.events.length, 1);
  assert.equal(sent[1].payload.sequence, 2);
  for (const f of sent) assertValid(f, clock.now());
});

test('500 ms merge window keeps only the latest state, accumulates events, merges tool start/end', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  em.setState(run, 'tool', 'read');
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', tool: 'Read', at: clock.now() });
  em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'read', tool: 'Read', at: clock.now(), ended_at: clock.now() + 5, error: false });
  em.setState(run, 'tool', 'command');
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', tool: 'Bash', detail: 'git', at: clock.now() });
  em.tick();
  assert.equal(sent.length, 2);
  const f = sent[1].payload;
  assert.equal(f.state, 'tool');
  assert.equal(f.category, 'command');
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].ended_at, clock.now() + 5);
  clock.advance(100);
  em.setState(run, 'thinking');
  em.tick();
  assert.equal(sent.length, 2, 'inside the window nothing is sent');
  clock.advance(400);
  em.tick();
  assert.equal(sent.length, 3);
  for (const fr of sent) assertValid(fr, clock.now());
});

test('terminal frame goes out immediately with ended_at and reason', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(10);
  run.reason = null;
  em.finish(run, 'done', 'no_reply');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.state, 'done');
  assert.equal(sent[1].payload.reason, 'no_reply');
  assert.equal(sent[1].payload.ended_at, clock.now());
  assert.equal(sent[1].payload.category, undefined);
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
  assert.deepEqual(sent[1].payload.events, []);
});

test('frames split at 50 events and at 15,360 bytes', () => {
  const { em, run, sent, clock } = setup();
  em.emitNow(run);
  clock.advance(600);
  for (let i = 0; i < 70; i++) em.pushEvent(run, { id: `n${i}`, kind: 'notice', code: 'merged_turn', at: clock.now() });
  em.tick();
  assert.equal(sent[1].payload.events.length, 50);
  clock.advance(600);
  em.tick();
  assert.equal(sent[2].payload.events.length, 20);
  for (let i = 0; i < 20; i++) em.pushEvent(run, { id: `c${i}`, kind: 'commentary', text: '字'.repeat(1500), at: clock.now() });
  clock.advance(600);
  em.tick();
  const bytes = Buffer.byteLength(JSON.stringify(sent[3]));
  assert.ok(bytes <= 15_360, `${bytes}`);
  assert.ok(sent[3].payload.events.length < 20);
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
  assert.equal(sent[1].payload.events[0].id, 'n10');
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
  assert.deepEqual(sent[0].payload.events, [], 'probe after reconnect carries no events');
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
