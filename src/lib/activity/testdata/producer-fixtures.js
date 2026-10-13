/**
 * Inputs for the agent_run (schema v2) producer golden samples.
 * scripts/gen-agent-run-golden.mjs turns each into
 * { note, now, run, expected: buildAgentRun(run, { now }) } under
 * testdata/agent_run_producer/ (one per compaction level), and writes the
 * shared display examples under testdata/agent_run_v2/ (for cws-fe).
 */

const T0 = 1760000523000;

function baseRun(over = {}) {
  return {
    v: 1, run_id: 'r_8c1f2a9d', org_id: 'org', conversation_id: 'conv', created_at: T0,
    state: 'replied', seq: 9, next_event: 1, events: [], dropped: 0, ...over,
  };
}

function common() {
  const ev = [
    { id: 'e1', kind: 'commentary', text: '收到。我先读一下定价文档，\n再跑一遍报价脚本核对数字。', at: T0 + 3500 },
    { id: 'e2', kind: 'tool', category: 'read', tool: 'Read', at: T0 + 4000, ended_at: T0 + 4100, error: false },
    { id: 'e3', kind: 'tool', category: 'search', tool: 'Grep', at: T0 + 4600, ended_at: T0 + 5800, error: false },
    { id: 'e4', kind: 'commentary', text: '文档里的阶梯价和脚本输出对不上，我再看一下最新的计费配置。', at: T0 + 7500 },
    { id: 'e5', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', description: '运行报价脚本核对数字', at: T0 + 8000, ended_at: T0 + 11100, error: true },
    { id: 'e6', kind: 'tool', category: 'web', tool: 'WebFetch', at: T0 + 12000, ended_at: T0 + 16400, error: false },
    { id: 'e7', kind: 'notice', code: 'merged_turn', at: T0 + 17000 },
    { id: 'e8', kind: 'tool', category: 'kb', tool: 'Skill', at: T0 + 18600, ended_at: T0 + 21200, error: false },
    { id: 'e9', kind: 'tool', category: 'write', tool: 'Edit', at: T0 + 22400 },
    { id: 'e10', kind: 'commentary', text: '对比表已更新，正在回复。', at: T0 + 33000 },
  ];
  return baseRun({ events: ev, next_event: 11, dropped: 2 });
}

function manyTools(n, { text = null, description = null } = {}) {
  const ev = [];
  let id = 1;
  for (let i = 0; i < n; i++) {
    if (text && i % 3 === 0) ev.push({ id: `e${id++}`, kind: 'commentary', text: text(i), at: T0 + 1000 + i * 1000 });
    ev.push({ id: `e${id++}`, kind: 'tool', category: i % 2 ? 'command' : 'read', tool: i % 2 ? 'Bash' : 'Read', ...(i % 2 ? { detail: 'git' } : {}), ...(description ? { description: description(i) } : {}), at: T0 + 1500 + i * 1000, ended_at: T0 + 1900 + i * 1000, error: i === 7 });
  }
  return baseRun({ run_id: 'r_51d0c3e7', events: ev, next_event: id });
}

export const PRODUCER_FIXTURES = [
  { name: 'level0_common', note: 'common run: 7 tools, 3 commentary, 1 notice; reply step appended', now: T0 + 37000, run: common() },
  { name: 'level0_unfinished_reply_finished', note: 'an unfinished reply call already in the run is finished, not duplicated',
    now: T0 + 9000,
    run: baseRun({ next_event: 3, events: [
      { id: 'e1', kind: 'commentary', text: '好的。', at: T0 + 2000 },
      { id: 'e2', kind: 'tool', category: 'reply', tool: 'Bash', detail: 'node', at: T0 + 8000 },
    ] }) },
  { name: 'level0_status_only', note: 'a run that showed status only: the summary is just the reply step', now: T0 + 5000, run: baseRun() },
  { name: 'level1_tags_dropped', note: '120 tool steps: decorative tags removed', now: T0 + 200000, run: manyTools(120) },
  { name: 'level2_action_body_dropped', note: '70 tool steps with long descriptions: tags and action bodies removed', now: T0 + 200000,
    run: manyTools(70, { description: (i) => `第 ${i} 步：${'核对报价脚本输出与文档中的阶梯价，'.repeat(4)}`.slice(0, 80) }) },
  { name: 'level3_text_cut', note: 'long commentary: text cut to 500 / 200', now: T0 + 200000,
    run: manyTools(24, { text: (i) => `${i}：${'这一段过程文字很长，'.repeat(60)}` }) },
  { name: 'level4_text_dropped', note: 'many commentary steps: text steps removed, actions kept', now: T0 + 400000,
    run: manyTools(60, { text: (i) => `第 ${i} 步：${'检查输出并继续。'.repeat(30)}` }) },
  { name: 'level5_folded', note: '160 tool steps: middle folded into one group step', now: T0 + 912000, run: manyTools(160) },
];
