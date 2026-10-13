import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAgentRun, validateActivityFrame, goEncodedSize } from './testdata/validators.js';

// The mirror of cws-comm's v2 gates (plan MR 1): no content validation.

test('agent_run gates: object, ≤ 16 KiB encoded, agent sender, switch on; anything else is stored as is', () => {
  const ar = { schema_version: 2, run_id: 'r_8c1f2a9d', steps: [{ id: 'e1', kind: 'whatever', future_field: [1] }], debug: { x: 1 } };
  assert.deepEqual(classifyAgentRun({ raw: ar }), { verdict: 'ok', stored: ar });
  assert.equal(classifyAgentRun({ raw: undefined }).verdict, 'absent');
  assert.equal(classifyAgentRun({ raw: ar, enabled: false }).verdict, 'stripped_disabled');
  assert.equal(classifyAgentRun({ raw: ar, senderType: 'user' }).verdict, 'stripped_not_agent');
  for (const raw of [[], 'x', 1, true]) assert.equal(classifyAgentRun({ raw }).verdict, 'stripped_invalid', JSON.stringify(raw));
});

test('agent_run size gate: 16,384 encoded bytes (Go encoder: U+2028 escaped, trailing newline)', () => {
  const pad = (n) => ({ s: 'a'.repeat(n) });
  const base = goEncodedSize(pad(0));
  assert.equal(classifyAgentRun({ raw: pad(16384 - base) }).verdict, 'ok');
  assert.equal(classifyAgentRun({ raw: pad(16384 - base + 1) }).verdict, 'stripped_too_large');
  assert.equal(goEncodedSize({ s: '\u2028' }), Buffer.byteLength('{"s":"\\u2028"}') + 1);
});

const NOW = 1760000600000;
function basePayload() {
  return {
    conversation_id: '019f0000-aaaa-7bbb-8ccc-000000000001',
    run_id: 'r_8c1f2a9d',
    source_message_id: '7383920118271',
    sequence: 1,
    state: 'tool',
    started_at: NOW - 30000,
    schema_version: 2,
    title: '正在执行命令 · Bash · node',
    steps: [
      { id: 'e1', kind: 'text', at: NOW - 20000, body: '看一下配置。' },
      { id: 'e3', kind: 'action', status: 'running', at: NOW - 17000, title: '执行命令', tags: ['Bash', 'node'] },
      { id: 'e4', kind: 'note', at: NOW - 16000, title: '与其他消息合并处理', unknown_key: true },
    ],
    dropped: 0,
    ttl_ms: 30000,
  };
}
const frameOf = (p) => JSON.stringify({ type: 'agent_activity', payload: p });

test('frame mirror: envelope ok, steps opaque', () => {
  const r = validateActivityFrame(frameOf(basePayload()), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, 3);
});

test('frame mirror: envelope rejects', () => {
  const cases = [
    (p) => { delete p.conversation_id; },
    (p) => { p.run_id = 'r_XYZ'; },
    (p) => { p.source_message_id = 'msg_1'; },
    (p) => { p.sequence = 0; },
    (p) => { p.state = 'running'; },
    (p) => { p.started_at = NOW - 25 * 3600 * 1000; },
    (p) => { p.state = 'done'; },
    (p) => { p.ended_at = NOW; },
    (p) => { p.category = 'command'; },
    (p) => { p.events = []; },
    (p) => { p.title = 1; },
    (p) => { p.schema_version = '2'; },
    (p) => { p.steps = {}; },
    (p) => { p.steps = Array.from({ length: 51 }, (_, i) => ({ id: `e${i}` })); },
    (p) => { p.steps.push('x'); },
    (p) => { p.dropped = 1_000_001; },
    (p) => { p.ttl_ms = 4999; },
  ];
  for (const mutate of cases) {
    const p = basePayload();
    mutate(p);
    assert.equal(validateActivityFrame(frameOf(p), NOW).ok, false, mutate.toString());
  }
});
