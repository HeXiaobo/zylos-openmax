import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAgentRun, validateActivityFrame, goEncodedSize, validateAgentRunV3, validateStepV3, validateFrameV3,
} from './testdata/validators.js';

// The mirror of cws-comm's gates (content not validated) and the v3 display contract.

test('agent_run gates: object, ≤ 16 KiB encoded, agent sender, switch on; anything else is stored as is', () => {
  const ar = { schema_version: 3, run_id: 'r_8c1f2a9d', steps: [{ id: 'e1', kind: 'whatever', future_field: [1] }], debug: { x: 1 } };
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
    state: 'thinking',
    started_at: NOW - 30000,
    exec_started_at: NOW - 25000,
    step_count: 1,
    schema_version: 3,
    steps: [
      { id: 'e1', kind: 'thinking', at: NOW - 20000, body: '看一下配置。' },
      { id: 'e3', kind: 'tool', category: 'command', status: 'running', at: NOW - 17000, title: '跑测试', wait_for: 'command_result' },
      { id: 'e4', kind: 'note', at: NOW - 16000, code: 'merged_turn' },
    ],
    dropped: 0,
    ttl_ms: 30000,
  };
}
const frameOf = (p) => JSON.stringify({ type: 'agent_activity', payload: p });

test('frame mirror: envelope ok, steps opaque to the server; display part valid v3', () => {
  const r = validateActivityFrame(frameOf(basePayload()), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(validateFrameV3(basePayload()), []);
  const odd = basePayload();
  odd.steps.push({ id: 'x', kind: 'whatever' });
  assert.equal(validateActivityFrame(frameOf(odd), NOW).ok, true, 'the server does not read steps');
  assert.notDeepEqual(validateFrameV3(odd), []);
});

test('v3 envelope fields (C1): exec_started_at in [started_at, ended_at | now + 5 min], step_count 0..10000', () => {
  const bad = [
    (p) => { p.exec_started_at = p.started_at - 1; },
    (p) => { p.exec_started_at = NOW + 6 * 60 * 1000; },
    (p) => { p.exec_started_at = '1'; },
    (p) => { p.state = 'done'; p.ended_at = NOW - 26000; },
    (p) => { p.step_count = -1; },
    (p) => { p.step_count = 10001; },
    (p) => { p.step_count = 1.5; },
  ];
  for (const mutate of bad) {
    const p = basePayload();
    mutate(p);
    assert.equal(validateActivityFrame(frameOf(p), NOW).ok, false, mutate.toString());
  }
  const p = basePayload();
  p.state = 'done';
  p.ended_at = NOW;
  p.exec_started_at = NOW;
  assert.equal(validateActivityFrame(frameOf(p), NOW).ok, true);
});

test('v3 display contract rejects unknown keys / enums, over-cap strings, wait_for after the end, title on frames', () => {
  const tool = { id: 'e1', kind: 'tool', category: 'search_web', status: 'running', at: 1, object: 'q', wait_for: 'search_results' };
  assert.deepEqual(validateStepV3(tool), []);
  const cases = [
    { ...tool, category: 'web' },
    { ...tool, status: 'unfinished' },
    { ...tool, tags: ['x'] },
    { ...tool, status: 'ok', ended_at: 2 },
    { ...tool, wait_for: '等待搜索服务返回' },
    { ...tool, title: 'x'.repeat(61) },
    { ...tool, object: 'a\nb' },
    { ...tool, detail: { type: 'links', total: 1, items: [{ url: 'https://a.com', site: 'a.com' }] } },
    { ...tool, detail: { type: 'output', lines: 1, text: 'raw output', truncated: false } },
    { ...tool, detail: { type: 'diff', file: 'a', added: 1, removed: 0, truncated: false, detail_ref: 'x' } },
    { id: 'e2', kind: 'note', at: 1, code: 'focus_acquired' },
    { id: 'e2', kind: 'note', at: 1, code: 'steps_omitted' },
    { id: 'e3', kind: 'text', at: 1, body: 'x' },
  ];
  for (const s of cases) assert.notDeepEqual(validateStepV3(s), [], JSON.stringify(s));
  const withTitle = { ...basePayload(), title: '处理中' };
  assert.notDeepEqual(validateFrameV3(withTitle), []);
  assert.notDeepEqual(validateAgentRunV3({ schema_version: 2, run_id: 'r_8c1f2a9d', ref: true }), []);
  assert.deepEqual(validateAgentRunV3({ schema_version: 3, run_id: 'r_8c1f2a9d', ref: true }), []);
});

test('frame mirror: envelope rejects', () => {
  const cases = [
    (p) => { delete p.conversation_id; },
    (p) => { p.run_id = 'r_XYZ'; },
    (p) => { p.source_message_id = 'msg_1'; },
    (p) => { p.sequence = 0; },
    (p) => { p.state = 'running'; },
    (p) => { p.reason = 'no_reply'; },
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
