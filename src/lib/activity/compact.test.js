import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentRun, agentRunSize, agentRunRef, cut } from './compact.js';
import { classifyAgentRun } from './testdata/validators.js';
import { PRODUCER_FIXTURES } from './testdata/producer-fixtures.js';
import { renderSample } from '../../../scripts/gen-agent-run-golden.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = 1760000523000;
const STEP_KEYS = new Set(['id', 'kind', 'category', 'description', 'text', 'at', 'ended_at', 'status', 'count']);
const TOP_KEYS = ['v', 'run_id', 'state', 'started_at', 'ended_at', 'steps', 'summary'];

function assertServerAccepts(ar, now) {
  const c = classifyAgentRun({ enabled: true, senderType: 'agent', raw: JSON.parse(JSON.stringify(ar)), now });
  assert.equal(c.verdict, 'ok', c.detail);
  assert.deepEqual(c.normalized, JSON.parse(JSON.stringify(ar)), 'output must be a fixed point of cws-comm normalization');
}

function run(events, over = {}) {
  return { run_id: 'r_8c1f2a9d', created_at: T0, events, dropped: 0, next_event: events.length + 1, ...over };
}

test('committed producer golden samples equal what compact.js produces now (byte for byte)', () => {
  const dir = path.join(HERE, 'testdata/agent_run_producer');
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, PRODUCER_FIXTURES.length);
  for (const fx of PRODUCER_FIXTURES) {
    const committed = fs.readFileSync(path.join(dir, `${fx.name}.json`), 'utf8');
    assert.equal(renderSample(fx), committed, `${fx.name}: regenerate with node scripts/gen-agent-run-golden.mjs`);
  }
});

test('every producer sample passes the cws-comm validator unchanged and fits 15,360 bytes', () => {
  const levels = new Set();
  for (const fx of PRODUCER_FIXTURES) {
    const ar = buildAgentRun(fx.run, { now: fx.now });
    assert.ok(ar, fx.name);
    assert.ok(agentRunSize(ar) <= 15_360, `${fx.name} ${agentRunSize(ar)}`);
    assertServerAccepts(ar, fx.now + 1000);
    levels.add(ar.summary.compaction_level);
  }
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3]);
});

test('only allowlisted fields are emitted (no tool name, no raw input)', () => {
  const ar = buildAgentRun(PRODUCER_FIXTURES[0].run, { now: PRODUCER_FIXTURES[0].now });
  assert.deepEqual(Object.keys(ar), TOP_KEYS);
  for (const s of ar.steps) for (const k of Object.keys(s)) assert.ok(STEP_KEYS.has(k), k);
  for (const name of ['"Read"', '"Grep"', '"Bash"', '"WebFetch"']) assert.equal(JSON.stringify(ar).includes(name), false, name);
});

test('uncompressed: reply step appended, counts and statuses', () => {
  const ar = buildAgentRun(PRODUCER_FIXTURES[0].run, { now: PRODUCER_FIXTURES[0].now });
  assert.equal(ar.summary.compaction_level, 0);
  assert.equal(ar.summary.compacted, false);
  assert.equal(ar.summary.step_count, 7);
  assert.equal(ar.summary.commentary_count, 3);
  assert.equal(ar.summary.dropped, 2);
  const last = ar.steps.at(-1);
  assert.deepEqual(last, { id: 'e11', kind: 'tool', category: 'reply', description: '', at: PRODUCER_FIXTURES[0].now, ended_at: PRODUCER_FIXTURES[0].now, status: 'ok' });
  assert.equal(ar.steps.find((s) => s.id === 'e5').status, 'error');
  assert.equal(ar.steps.find((s) => s.id === 'e9').status, 'unfinished');
  assert.equal(ar.steps.find((s) => s.id === 'e5').description, 'node');
  assert.equal(ar.steps[0].description.includes('\n'), false);
});

test('level 1 tightens text to 500 then 200; step_count unchanged', () => {
  const long = (i) => ({ id: `e${i}`, kind: 'commentary', text: '很长的过程文字。'.repeat(250), at: T0 + i });
  const r500 = buildAgentRun(run(Array.from({ length: 6 }, (_, i) => long(i + 1))), { now: T0 + 9000 });
  assert.equal(r500.summary.compaction_level, 1);
  assert.equal(r500.summary.text_limit, 500);
  assert.ok(r500.steps.filter((s) => s.text).every((s) => Array.from(s.text).length <= 500));
  const r200 = buildAgentRun(run(Array.from({ length: 15 }, (_, i) => long(i + 1))), { now: T0 + 9000 });
  assert.equal(r200.summary.text_limit, 200);
  assert.equal(r200.summary.commentary_count, 15);
  assertServerAccepts(r200, T0 + 10000);
});

test('level 2 drops text, keeps every step; level 3 folds K = 20 → 1', () => {
  const l2 = buildAgentRun(PRODUCER_FIXTURES.find((f) => f.name === 'level2_text_dropped').run, { now: T0 + 400000 });
  assert.equal(l2.summary.compaction_level, 2);
  assert.equal(l2.steps.some((s) => s.text), false);
  const l3 = buildAgentRun(PRODUCER_FIXTURES.find((f) => f.name === 'level3_folded').run, { now: T0 + 912000 });
  assert.equal(l3.summary.compaction_level, 3);
  assert.equal(l3.summary.step_count, 161);
  const om = l3.steps.find((s) => s.kind === 'omitted');
  assert.equal(om.count, 161 - 40);
  assert.equal(l3.summary.omitted_count, om.count);
  assert.equal(om.status, 'ok');
  // An error inside the folded middle marks the omitted step as error.
  const withErr = structuredClone(PRODUCER_FIXTURES.find((f) => f.name === 'level3_folded').run);
  withErr.events[80].error = true;
  assert.equal(buildAgentRun(withErr, { now: T0 + 912000 }).steps.find((s) => s.kind === 'omitted').status, 'error');
  assert.equal(om.description, `…中间 ${om.count} 步`);
  // A tiny budget forces K down to 1 and then gives up.
  const tiny = buildAgentRun(PRODUCER_FIXTURES.find((f) => f.name === 'level3_folded').run, { now: T0 + 912000, budget: 800 });
  assert.equal(tiny.steps.length, 3);
  assert.equal(buildAgentRun(PRODUCER_FIXTURES.find((f) => f.name === 'level3_folded').run, { now: T0 + 912000, budget: 600 }), null);
});

test('an unfinished reply step is finished instead of duplicated', () => {
  const fx = PRODUCER_FIXTURES.find((f) => f.name === 'level0_unfinished_reply_finished');
  const ar = buildAgentRun(fx.run, { now: fx.now });
  assert.equal(ar.steps.filter((s) => s.category === 'reply').length, 1);
  assert.equal(ar.steps[1].status, 'ok');
  assert.equal(ar.steps[1].ended_at, fx.now);
});

test('reference form and cut()', () => {
  assert.deepEqual(agentRunRef('r_8c1f2a9d'), { v: 1, run_id: 'r_8c1f2a9d' });
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('字字', 2), '字字');
});
