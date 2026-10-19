import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentRun, agentRunSize, agentRunRef, cut, runStepCount } from './compact.js';
import { classifyAgentRun, goEncodedSize, validateAgentRunV3 } from './testdata/validators.js';
import { PRODUCER_FIXTURES, T0 } from './testdata/producer-fixtures.js';
import { renderSample, v3Examples } from '../../../scripts/gen-agent-run-golden.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The v3 display contract (validators.js) and the cws-comm gates. */
function assertV3(ar) {
  assert.equal(classifyAgentRun({ raw: JSON.parse(JSON.stringify(ar)) }).verdict, 'ok');
  assert.ok(agentRunSize(ar) <= 15 * 1024, `size ${agentRunSize(ar)}`);
  assert.deepEqual(validateAgentRunV3(JSON.parse(JSON.stringify(ar))), []);
}

function run(events, over = {}) {
  return { run_id: 'r_8c1f2a9d', created_at: T0, events, dropped: 0, next_event: events.length + 1, ...over };
}

const byName = (n) => PRODUCER_FIXTURES.find((f) => f.name === n);
const build = (n, opts = {}) => buildAgentRun(byName(n).run, { now: byName(n).now, ...opts });

test('committed producer golden samples equal what compact.js produces now (byte for byte)', () => {
  const dir = path.join(HERE, 'testdata/agent_run_producer');
  assert.equal(fs.readdirSync(dir).length, PRODUCER_FIXTURES.length);
  for (const fx of PRODUCER_FIXTURES) {
    const committed = fs.readFileSync(path.join(dir, `${fx.name}.json`), 'utf8');
    assert.equal(renderSample(fx), committed, `${fx.name}: regenerate with node scripts/gen-agent-run-golden.mjs`);
  }
});

test('committed shared v3 examples (cws-fe fixtures) equal what the code produces now, and pass the contract', () => {
  const dir = path.join(HERE, 'testdata/agent_run_v3');
  const ex = v3Examples();
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(ex).sort());
  for (const [name, body] of Object.entries(ex)) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), body, `${name}: regenerate with node scripts/gen-agent-run-golden.mjs`);
  }
  for (const n of ['agent_run.json', 'agent_run_truncated.json', 'agent_run_compacted.json']) assertV3(JSON.parse(ex[n]));
  assert.deepEqual(JSON.parse(ex['agent_run_ref.json']), { schema_version: 3, run_id: 'r_3fa9c1d2', ref: true });
  assert.deepEqual(validateAgentRunV3(JSON.parse(ex['agent_run_ref.json'])), []);
  const trunc = JSON.parse(ex['agent_run_truncated.json']);
  assert.ok(trunc.steps.some((s) => s.detail?.truncated === true), 'the truncated example shows truncated details');
});

test('every producer sample is a valid v3 agent_run within 15,360 bytes; one sample per compaction level 0–6', () => {
  const levels = [];
  for (const fx of PRODUCER_FIXTURES) {
    const ar = buildAgentRun(fx.run, { now: fx.now });
    assert.ok(ar, fx.name);
    assertV3(ar);
    assert.equal(ar.compaction.level, Number(fx.name.match(/^level(\d)/)[1]), fx.name);
    levels.push(ar.compaction.level);
  }
  assert.deepEqual([...new Set(levels)].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('v3 run fields: done, queued_at / exec_started_at / ended_at, step_count, source_message_id; no title / status', () => {
  const ar = build('level0_common');
  assert.deepEqual(Object.keys(ar), ['schema_version', 'run_id', 'source_message_id', 'state', 'queued_at', 'exec_started_at', 'ended_at',
    'step_count', 'steps', 'compaction']);
  assert.equal(ar.state, 'done');
  assert.equal(ar.queued_at, T0);
  assert.equal(ar.exec_started_at, T0 + 3200);
  assert.equal(ar.step_count, 8);
  assert.equal(ar.steps.filter((s) => s.kind === 'tool').length, 8);
  // No reply step: the reply is the message itself (decision 6).
  assert.equal(ar.steps.some((s) => s.category === 'reply'), false);
  // A running step stays running (the FE shows it interrupted once the run ended).
  assert.equal(ar.steps.at(-1).status, 'running');
  // The secret in the commentary is redacted; the link with a token loses it.
  const json = JSON.stringify(ar);
  for (const leak of ['sk-live', 'token=abc', 'SECRET']) assert.equal(json.includes(leak), false, leak);
  assert.ok(json.includes('API_KEY=[已隐藏]'));
});

test('exec_started_at is clamped into the run and left out when the run never started', () => {
  const a = buildAgentRun(run([], { exec_started_at: T0 - 50 }), { now: T0 + 100 });
  assert.equal(a.exec_started_at, T0);
  const b = buildAgentRun(run([], { exec_started_at: T0 + 500 }), { now: T0 + 100 });
  assert.equal(b.exec_started_at, T0 + 100);
  const c = buildAgentRun(run([]), { now: T0 + 100 });
  assert.equal('exec_started_at' in c, false);
  assert.equal(c.step_count, 0);
  assertV3(c);
});

test('step_count: the run counter when present, else visible tool events (reply / waiting excluded)', () => {
  const events = [
    { id: 'e1', kind: 'tool', category: 'command', at: T0 + 1 },
    { id: 'e2', kind: 'tool', category: 'reply', at: T0 + 2 },
    { id: 'e3', kind: 'tool', category: 'waiting', at: T0 + 3 },
    { id: 'e4', kind: 'commentary', text: 'x', at: T0 + 4 },
    { id: 'e5', kind: 'notice', code: 'merged_turn', at: T0 + 5 },
  ];
  assert.equal(runStepCount(run(events)), 1);
  assert.equal(runStepCount(run(events, { step_count: 7 })), 7);
  const ar = buildAgentRun(run(events), { now: T0 + 10 });
  assert.deepEqual(ar.steps.map((s) => s.kind), ['tool', 'thinking', 'note']);
});

test('ladder 1: details re-cut to half their caps, marked truncated', () => {
  const ar = build('level1_details_halved');
  assert.equal(ar.compaction.level, 1);
  for (const s of ar.steps) {
    assert.ok(s.detail.items.length <= 4);
    assert.equal(s.detail.truncated, true);
  }
});

test('ladder 2: diff previews removed', () => {
  const ar = build('level2_previews_dropped');
  assert.equal(ar.compaction.level, 2);
  const diffs = ar.steps.filter((s) => s.detail?.type === 'diff');
  assert.ok(diffs.length > 0);
  for (const s of diffs) {
    assert.equal(s.detail.preview, undefined);
    assert.equal(s.detail.truncated, true);
    assert.ok(s.detail.added > 0, 'counts stay');
  }
});

test('ladder 3: thinking cut to 200; ladder 4: links keep only total; ladder 5: thinking removed', () => {
  const l3 = build('level3_thinking_cut');
  assert.equal(l3.compaction.level, 3);
  const th = l3.steps.filter((s) => s.kind === 'thinking');
  assert.ok(th.length > 0 && th.every((s) => Array.from(s.body).length <= 200));

  const l4 = build('level4_links_total_only');
  assert.equal(l4.compaction.level, 4);
  for (const s of l4.steps) {
    assert.equal(s.detail.items, undefined);
    assert.equal(s.detail.total, 10);
    assert.equal(s.detail.truncated, true);
  }

  const l5 = build('level5_thinking_removed');
  assert.equal(l5.compaction.level, 5);
  assert.equal(l5.steps.some((s) => s.kind === 'thinking'), false);
  assert.equal(l5.step_count, 40);
});

test('ladder 6: head / tail kept, the middle becomes one steps_omitted note; step_count never shrinks', () => {
  const fx = byName('level6_omitted');
  const ar = build('level6_omitted');
  assert.equal(ar.compaction.level, 6);
  const n = ar.steps.find((s) => s.kind === 'note');
  assert.deepEqual(Object.keys(n), ['id', 'kind', 'at', 'code', 'count']);
  assert.equal(n.code, 'steps_omitted');
  assert.equal(ar.steps.length - 1 + n.count, 200);
  assert.equal(ar.compaction.omitted, n.count);
  assert.equal(ar.step_count, 200);
  assert.equal(fx.run.step_count, 200);
  // A tiny budget forces K down to 1 and then gives up.
  assert.equal(build('level6_omitted', { budget: 1000 }).steps.length, 3);
  assert.equal(build('level6_omitted', { budget: 600 }), null);
});

test('ladder order holds step by step: with room for halved details, previews stay', () => {
  const fx = byName('level2_previews_dropped');
  const l1 = buildAgentRun(fx.run, { now: fx.now, budget: 1e9 });
  assert.equal(l1.compaction.level, 0);
  const halved = buildAgentRun(fx.run, { now: fx.now, budget: 28_000 });
  assert.equal(halved.compaction.level, 1);
  assert.ok(halved.steps.some((s) => s.detail?.type === 'diff' && s.detail.preview));
});

test('reference form and cut()', () => {
  assert.deepEqual(agentRunRef('r_8c1f2a9d'), { schema_version: 3, run_id: 'r_8c1f2a9d', ref: true });
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('字字', 2), '字字');
});

test('60-code-point CJK titles on every step still compact into the 15,360-byte budget', () => {
  const title = (i) => `${'检查报价单并核对'.repeat(10)}`.slice(0, 59) + (i % 10);
  for (const n of [10, 30, 60, 300, 2000]) {
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push({ id: `e${i + 1}`, kind: 'tool', category: 'command', title: title(i), at: T0 + i * 10, ended_at: T0 + i * 10 + 5, error: i === 3,
        detail: { type: 'output', exit_code: i === 3 ? 1 : 0, lines: i, truncated: false } });
    }
    const ar = buildAgentRun(run(events, { step_count: n }), { now: T0 + n * 10 + 100 });
    assert.ok(ar, `n=${n}: must not give up`);
    assertV3(ar);
    assert.equal(ar.step_count, n);
    const g = ar.steps.find((s) => s.kind === 'note');
    if (g) assert.equal(ar.steps.length - 1 + g.count, n, 'kept + omitted = every step');
  }
});

test('U+2028 / U+2029 never reach the summary (removed by redaction); size equals the server-side encoding', () => {
  const r = {
    v: 1, run_id: 'r_8c1f2a9d', created_at: T0, next_event: 4, dropped: 0,
    events: [1, 2, 3].map((i) => ({ id: `e${i}`, kind: 'commentary', text: 'x\u2028y\u2029'.repeat(300), at: T0 + i * 1000 })),
  };
  const ar = buildAgentRun(r, { now: T0 + 10000 });
  assert.equal(/[\u2028\u2029]/.test(JSON.stringify(ar)), false);
  assert.equal(agentRunSize(ar), goEncodedSize(ar));
  assertV3(ar);
});
