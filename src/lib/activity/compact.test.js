import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentRun, agentRunSize, agentRunRef, cut } from './compact.js';
import { classifyAgentRun } from './testdata/validators.js';
import { PRODUCER_FIXTURES } from './testdata/producer-fixtures.js';
import { renderSample, v2Examples } from '../../../scripts/gen-agent-run-golden.mjs';
import { TOOL_ALLOWLIST, DETAIL_ALLOWLIST } from './constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = 1760000523000;
const TOP_KEYS = ['schema_version', 'run_id', 'status', 'started_at', 'ended_at', 'title', 'subtitle', 'steps', 'compaction'];
const STEP_KEYS = new Set(['id', 'kind', 'status', 'at', 'ended_at', 'title', 'tags', 'body', 'count']);
const KINDS = new Set(['action', 'text', 'note', 'group']);
const STATUSES = new Set(['running', 'ok', 'error', 'interrupted', 'unfinished']);

/** The v2 display contract (plan §4.1 / §4.2) and the cws-comm gates. */
function assertV2(ar) {
  assert.equal(classifyAgentRun({ raw: JSON.parse(JSON.stringify(ar)) }).verdict, 'ok');
  assert.ok(agentRunSize(ar) <= 15 * 1024, `size ${agentRunSize(ar)}`);
  for (const k of Object.keys(ar)) assert.ok(TOP_KEYS.includes(k), k);
  assert.equal(ar.schema_version, 2);
  assert.match(ar.run_id, /^r_[0-9a-f]{8}$/);
  assert.ok(Array.from(ar.title).length <= 80);
  if (ar.subtitle !== undefined) assert.ok(Array.from(ar.subtitle).length <= 80);
  assert.ok(ar.steps.length <= 500);
  const ids = new Set();
  for (const s of ar.steps) {
    for (const k of Object.keys(s)) assert.ok(STEP_KEYS.has(k), `step key ${k}`);
    assert.ok(KINDS.has(s.kind), s.kind);
    assert.ok(typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 32);
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(Number.isInteger(s.at));
    if (s.status !== undefined) assert.ok(STATUSES.has(s.status), s.status);
    if (s.ended_at !== undefined) assert.ok(s.ended_at >= s.at);
    if (s.title !== undefined) assert.ok(Array.from(s.title).length <= 80);
    if (s.body !== undefined) assert.ok(Array.from(s.body).length <= 2000);
    if (s.kind === 'text') assert.ok(s.body);
    if (s.kind !== 'text') assert.ok(s.title, `${s.kind} needs a title`);
    if (s.tags !== undefined) {
      assert.ok(s.tags.length >= 1 && s.tags.length <= 4);
      for (const t of s.tags) {
        assert.ok(t.length <= 32);
        assert.ok(TOOL_ALLOWLIST.has(t) || DETAIL_ALLOWLIST.has(t), `tag ${t} not allowlisted`);
      }
    }
  }
}

function run(events, over = {}) {
  return { run_id: 'r_8c1f2a9d', created_at: T0, events, dropped: 0, next_event: events.length + 1, ...over };
}

test('committed producer golden samples equal what compact.js produces now (byte for byte)', () => {
  const dir = path.join(HERE, 'testdata/agent_run_producer');
  assert.equal(fs.readdirSync(dir).length, PRODUCER_FIXTURES.length);
  for (const fx of PRODUCER_FIXTURES) {
    const committed = fs.readFileSync(path.join(dir, `${fx.name}.json`), 'utf8');
    assert.equal(renderSample(fx), committed, `${fx.name}: regenerate with node scripts/gen-agent-run-golden.mjs`);
  }
});

test('committed shared v2 examples (cws-fe golden) equal what the code produces now', () => {
  const dir = path.join(HERE, 'testdata/agent_run_v2');
  const ex = v2Examples();
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(ex).sort());
  for (const [name, body] of Object.entries(ex)) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), body, `${name}: regenerate with node scripts/gen-agent-run-golden.mjs`);
  }
  assertV2(JSON.parse(ex['agent_run.json']));
  assertV2(JSON.parse(ex['agent_run_compacted.json']));
  assert.deepEqual(JSON.parse(ex['agent_run_ref.json']), { schema_version: 2, run_id: 'r_8c1f2a9d', ref: true });
});

test('every producer sample is a valid v2 agent_run within 15,360 bytes; one sample per compaction level', () => {
  const levels = [];
  for (const fx of PRODUCER_FIXTURES) {
    const ar = buildAgentRun(fx.run, { now: fx.now });
    assert.ok(ar, fx.name);
    assertV2(ar);
    assert.equal(ar.compaction.level, Number(fx.name.match(/^level(\d)/)[1]), fx.name);
    levels.push(ar.compaction.level);
  }
  assert.deepEqual([...new Set(levels)].sort(), [0, 1, 2, 3, 4, 5]);
});

test('v2 shape: "执行命令 · Bash · node" step, text / note / reply steps, run title and status', () => {
  const fx = PRODUCER_FIXTURES[0];
  const ar = buildAgentRun(fx.run, { now: fx.now });
  assert.deepEqual(Object.keys(ar), ['schema_version', 'run_id', 'status', 'started_at', 'ended_at', 'title', 'steps', 'compaction']);
  assert.equal(ar.status, 'ok');
  assert.equal(ar.title, '执行了 7 步');
  assert.deepEqual(ar.steps.find((s) => s.id === 'e5'), {
    id: 'e5', kind: 'action', status: 'error', at: T0 + 8000, ended_at: T0 + 11100, title: '执行命令', tags: ['Bash', 'node'], body: '运行报价脚本核对数字',
  });
  assert.deepEqual(ar.steps[0], { id: 'e1', kind: 'text', at: T0 + 3500, body: '收到。我先读一下定价文档，\n再跑一遍报价脚本核对数字。' });
  assert.deepEqual(ar.steps.find((s) => s.id === 'e7'), { id: 'e7', kind: 'note', at: T0 + 17000, title: '与其他消息合并处理' });
  assert.equal(ar.steps.find((s) => s.id === 'e9').status, 'unfinished');
  assert.deepEqual(ar.steps.at(-1), { id: 'e11', kind: 'action', status: 'ok', at: fx.now, ended_at: fx.now, title: '发送回复' });
  assert.deepEqual(ar.compaction, { level: 0, action_count: 7, text_count: 3, dropped: 2, omitted: 0 });
  // No command text, no raw input anywhere.
  assert.equal(JSON.stringify(ar).includes('category'), false);
});

test('privacy: tags only from the allowlists; body only the sanitized description; no raw command', () => {
  const ar = buildAgentRun(run([
    { id: 'e1', kind: 'tool', category: 'command', tool: 'Bash', detail: 'git', description: '查看 git 工作区状态', at: T0 + 100, ended_at: T0 + 200, error: false },
    { id: 'e2', kind: 'tool', category: 'tool', tool: 'mcp__secret__x', detail: 'evilbin', at: T0 + 300, ended_at: T0 + 400, error: false },
    { id: 'e3', kind: 'tool', category: 'command', tool: 'exec_command', detail: 'rg', command: 'rg password /etc', at: T0 + 500 },
    { id: 'e4', kind: 'tool', category: 'command', tool: 'Bash', description: `改\n${'字'.repeat(200)}`, at: T0 + 600, ended_at: T0 + 700 },
    { id: 'e5', kind: 'tool', category: 'nonsense', at: T0 + 800, ended_at: T0 + 900 },
  ]), { now: T0 + 1000 });
  assertV2(ar);
  assert.deepEqual(ar.steps.slice(0, 5).map((s) => s.tags), [['Bash', 'git'], undefined, ['exec_command', 'rg'], ['Bash'], undefined]);
  assert.equal(ar.steps[0].body, '查看 git 工作区状态');
  assert.equal(ar.steps[1].body, undefined);
  assert.equal(Array.from(ar.steps[3].body).length, 80);
  assert.equal(/[\u0000-\u001f]/.test(ar.steps[3].body), false);
  assert.equal(ar.steps[4].title, '调用工具', 'unknown category → generic title');
  const json = JSON.stringify(ar);
  for (const leak of ['mcp__secret__x', 'evilbin', 'password', '/etc']) assert.equal(json.includes(leak), false, leak);
});

test('budget: decorative tags go first, then action bodies, then text is cut / dropped, then the middle is folded', () => {
  const byName = (n) => PRODUCER_FIXTURES.find((f) => f.name === n);
  const l1 = buildAgentRun(byName('level1_tags_dropped').run, { now: byName('level1_tags_dropped').now });
  assert.equal(l1.compaction.level, 1);
  assert.ok(l1.steps.every((s) => s.tags === undefined));
  assert.equal(l1.subtitle, undefined);

  const fx2 = byName('level2_action_body_dropped');
  const l2 = buildAgentRun(fx2.run, { now: fx2.now });
  assert.equal(l2.compaction.level, 2);
  assert.ok(l2.steps.every((s) => s.tags === undefined && s.body === undefined));
  // Level 1 alone was not enough for this run, and with tags kept it is over budget.
  assert.ok(fx2.run.events.every((e) => e.description));

  const l3 = buildAgentRun(byName('level3_text_cut').run, { now: byName('level3_text_cut').now });
  assert.equal(l3.compaction.level, 3);
  assert.ok([500, 200].includes(l3.compaction.text_limit));
  assert.ok(l3.steps.filter((s) => s.kind === 'text').every((s) => Array.from(s.body).length <= l3.compaction.text_limit));
  assert.equal(l3.subtitle, '已精简');

  const l4 = buildAgentRun(byName('level4_text_dropped').run, { now: byName('level4_text_dropped').now });
  assert.equal(l4.compaction.level, 4);
  assert.equal(l4.steps.some((s) => s.kind === 'text'), false);
  assert.equal(l4.title, '执行了 61 步', 'the title counts the run before compaction');

  const fx5 = byName('level5_folded');
  const l5 = buildAgentRun(fx5.run, { now: fx5.now });
  assert.equal(l5.compaction.level, 5);
  const g = l5.steps.find((s) => s.kind === 'group');
  assert.deepEqual(Object.keys(g), ['id', 'kind', 'status', 'at', 'ended_at', 'title', 'count']);
  assert.equal(g.count, 161 - 40);
  assert.equal(g.title, `…中间 ${g.count} 步`);
  assert.equal(l5.subtitle, `已精简，省略中间 ${g.count} 步`);
  assert.equal(l5.compaction.omitted, g.count);
  assert.equal(l5.title, '执行了 161 步');
  const withErr = structuredClone(fx5.run);
  withErr.events[80].error = true;
  assert.equal(buildAgentRun(withErr, { now: fx5.now }).steps.find((s) => s.kind === 'group').status, 'error');
  // A tiny budget forces K down to 1 and then gives up.
  assert.equal(buildAgentRun(fx5.run, { now: fx5.now, budget: 700 }).steps.length, 3);
  assert.equal(buildAgentRun(fx5.run, { now: fx5.now, budget: 600 }), null);
});

test('budget order holds step by step: with room for tags, nothing else is touched', () => {
  const fx = PRODUCER_FIXTURES.find((f) => f.name === 'level2_action_body_dropped');
  const full = buildAgentRun(fx.run, { now: fx.now, budget: 1e9 });
  const noTags = structuredClone(full);
  for (const s of noTags.steps) delete s.tags;
  // Budget exactly at "tags removed": level 1, bodies still there.
  const l1 = buildAgentRun(fx.run, { now: fx.now, budget: agentRunSize({ ...noTags, compaction: { ...noTags.compaction, level: 1 } }) });
  assert.equal(l1.compaction.level, 1);
  assert.ok(l1.steps.filter((s) => s.kind === 'action' && s.id !== `e${fx.run.next_event}`).every((s) => s.body));
});

test('an unfinished reply step is finished instead of duplicated; a run with no events still gets its reply step', () => {
  const fx = PRODUCER_FIXTURES.find((f) => f.name === 'level0_unfinished_reply_finished');
  const ar = buildAgentRun(fx.run, { now: fx.now });
  assert.equal(ar.steps.filter((s) => s.title === '发送回复').length, 1);
  assert.equal(ar.steps[1].status, 'ok');
  assert.equal(ar.steps[1].ended_at, fx.now);
  const so = PRODUCER_FIXTURES.find((f) => f.name === 'level0_status_only');
  const ar2 = buildAgentRun(so.run, { now: so.now });
  assert.deepEqual(ar2.steps.map((s) => s.title), ['发送回复']);
  assert.equal(ar2.title, '执行了 1 步');
});

test('reference form and cut()', () => {
  assert.deepEqual(agentRunRef('r_8c1f2a9d'), { schema_version: 2, run_id: 'r_8c1f2a9d', ref: true });
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('字字', 2), '字字');
});

test('80-code-point CJK descriptions on every step still compact into the 15,360-byte budget', () => {
  const desc = (i) => `${'检查报价单并核对'.repeat(10)}`.slice(0, 79) + (i % 10);
  for (const n of [10, 30, 60, 300, 2000]) {
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push({ id: `e${i + 1}`, kind: 'tool', category: 'command', tool: 'Bash', detail: 'git', description: desc(i), at: T0 + i * 10, ended_at: T0 + i * 10 + 5, error: i === 3 });
    }
    const now = T0 + n * 10 + 100;
    const ar = buildAgentRun(run(events), { now });
    assert.ok(ar, `n=${n}: must not give up`);
    assertV2(ar);
    assert.equal(ar.compaction.action_count, n + 1, 'counted before compaction');
    const g = ar.steps.find((s) => s.kind === 'group');
    if (g) assert.equal(ar.steps.length - 1 + g.count, n + 1, 'kept + folded = every step');
  }
});
