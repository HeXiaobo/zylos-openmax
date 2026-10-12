import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAgentRun } from './testdata/validators.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/agent_run_golden');

test('golden copy matches its MANIFEST', async () => {
  const crypto = await import('node:crypto');
  const lines = fs.readFileSync(path.join(GOLDEN, 'MANIFEST.sha256'), 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const [hash, name] = line.split('  ');
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(GOLDEN, name))).digest('hex');
    assert.equal(got, hash, name);
  }
});

// The JS mirror of cws-comm's ClassifyAgentRun must reproduce every golden
// verdict and normalized output, or compact.test.js would be checking the
// producer against the wrong rules.
for (const name of fs.readdirSync(path.join(GOLDEN, 'validator')).sort()) {
  test(`validator mirror matches cws-comm golden: ${name}`, () => {
    const s = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'validator', name), 'utf8'));
    const c = classifyAgentRun({ enabled: s.enabled, senderType: s.sender_type, raw: s.input, now: s.now });
    assert.equal(c.verdict, s.verdict, s.note);
    assert.deepEqual(c.normalized ?? null, s.normalized ?? null, s.note);
  });
}

// ── frame mirror, pinned by cases ported from cws-comm agent_activity_test.go ──
import { validateActivityFrame } from './testdata/validators.js';

const NOW = 1760000600000;
function basePayload() {
  return {
    conversation_id: '019f0000-aaaa-7bbb-8ccc-000000000001',
    run_id: 'r_8c1f2a9d',
    source_message_id: '7383920118271',
    sequence: 1,
    state: 'tool',
    category: 'command',
    started_at: NOW - 30000,
    events: [
      { id: 'e1', kind: 'commentary', text: '看一下配置。', at: NOW - 20000 },
      { id: 'e2', kind: 'tool', category: 'search', tool: 'Grep', at: NOW - 19000, ended_at: NOW - 18000, error: false },
      { id: 'e3', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', at: NOW - 17000 },
      { id: 'e4', kind: 'notice', code: 'merged_turn', at: NOW - 16000 },
    ],
    dropped: 0,
    ttl_ms: 30000,
  };
}
const frameOf = (p) => JSON.stringify({ type: 'agent_activity', payload: p });

test('frame mirror: base payload accepted with all events', () => {
  const r = validateActivityFrame(frameOf(basePayload()), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 4);
});

test('frame mirror: structural rejects', () => {
  const cases = [
    (p) => { delete p.conversation_id; },
    (p) => { p.conversation_id = 'conv.1'; },
    (p) => { p.run_id = 'r_XYZ'; },
    (p) => { p.source_message_id = 'msg_1'; },
    (p) => { p.sequence = 0; },
    (p) => { p.sequence = 2 ** 31; },
    (p) => { p.sequence = 1.5; },
    (p) => { p.state = 'running'; },
    (p) => { delete p.category; },
    (p) => { p.state = 'thinking'; },
    (p) => { p.started_at = NOW - 25 * 3600 * 1000; },
    (p) => { p.state = 'done'; delete p.category; },
    (p) => { p.reason = 'no_reply'; },
    (p) => { p.events = Array.from({ length: 51 }, (_, i) => ({ id: `e${i}`, kind: 'notice', code: 'truncated', at: NOW })); },
    (p) => { p.dropped = 1_000_001; },
    (p) => { p.ttl_ms = 4999; },
    (p) => { p.events[2].id = 'e 42'; },
    (p) => { p.events[3].at = p.started_at - 5001; },
  ];
  for (const mutate of cases) {
    const p = basePayload();
    mutate(p);
    assert.equal(validateActivityFrame(frameOf(p), NOW).ok, false, mutate.toString());
  }
});

test('frame mirror: event-layer drops and decorative enums', () => {
  const drops = [
    [0, (e) => { e.text = ''; }],
    [0, (e) => { e.text = '字'.repeat(2001); }],
    [0, (e) => { e.text = 'a\u0000b'; }],
    [0, (e) => { e.text = 'a\u0085b'; }],
    [3, (e) => { e.text = 'x'; }],
    [2, (e) => { delete e.category; }],
    [1, (e) => { e.ended_at = e.at - 1; }],
    [2, (e) => { e.error = true; }],
  ];
  for (const [i, mutate] of drops) {
    const p = basePayload();
    mutate(p.events[i]);
    const r = validateActivityFrame(frameOf(p), NOW);
    assert.equal(r.ok, true);
    assert.equal(r.events.length, 3, mutate.toString());
  }
  const p = basePayload();
  p.events[1].tool = 'mcp__x';
  const r = validateActivityFrame(frameOf(p), NOW);
  assert.deepEqual(r.unknownEnums, ['tool']);
});
