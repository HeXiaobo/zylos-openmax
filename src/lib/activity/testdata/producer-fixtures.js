/**
 * Inputs for the agent_run (schema v3) producer golden samples.
 * scripts/gen-agent-run-golden.mjs turns each into
 * { note, now, run, expected: buildAgentRun(run, { now }) } under
 * testdata/agent_run_producer/ (one per compaction level), and writes the
 * shared display examples under testdata/agent_run_v3/ (for cws-fe).
 *
 * The run events are what attribution.js stores on the agent host: tool
 * events already carry their display candidates (title / object / detail as
 * classify.js and tool-detail.js produce them); present.js redacts and caps
 * them again on the way out.
 */

export const T0 = 1760598660000;

export function baseRun(over = {}) {
  return {
    v: 1, run_id: 'r_3fa9c1d2', org_id: 'org', conversation_id: 'c_7Hk2', source_message_id: '1849302211',
    created_at: T0, exec_started_at: T0 + 3200, state: 'replied', seq: 14, next_event: 1, step_count: 0,
    events: [], dropped: 0, ...over,
  };
}

const PREVIEW = '# 销售地区汇总\n\n| 地区 | 销售额 | 占比 |\n| --- | --- | --- |\n| 华东 | 1,284,000 | 31% |\n| 华南 | 902,500 | 22% |\n| 华北 | 811,000 | 20% |\n| 西南 | 433,000 | 10% |\n';

function common() {
  const ev = [
    { id: 'e1', kind: 'tool', category: 'read', at: T0 + 4000, ended_at: T0 + 5000, error: false, object: 'message.txt' },
    { id: 'e2', kind: 'tool', category: 'command', title: '统计缺失地区的记录', at: T0 + 6000, ended_at: T0 + 8000, error: false,
      detail: { type: 'output', exit_code: 0, lines: 12, truncated: false } },
    { id: 'e3', kind: 'commentary', text: '字段检查完成，接下来检索公开的地区划分标准。', at: T0 + 11000 },
    { id: 'e4', kind: 'tool', category: 'search_web', object: '中国七大地理分区 划分标准', at: T0 + 12000, ended_at: T0 + 23000, error: false,
      detail: { type: 'links', total: 5, truncated: false, items: [
        { title: '中国地理区划 - 百度百科', url: 'https://baike.baidu.com/item/中国地理区划' },
        { title: '七大地理分区', url: 'https://www.example.gov.cn/dqfq/index.html?from=search' },
        { title: 'China geographic regions', url: 'https://en.example.org/wiki/Regions_of_China' },
        { title: '地理分区数据说明', url: 'https://data.example.com/docs/regions?lang=zh&token=abc123SECRET' },
        { title: '区域划分标准（2024）', url: 'https://stats.example.cn/std/2024/regions.html' },
      ] } },
    { id: 'e5', kind: 'notice', code: 'merged_turn', at: T0 + 23500 },
    { id: 'e6', kind: 'tool', category: 'fetch_web', object: 'www.example.gov.cn', at: T0 + 24000, ended_at: T0 + 26000, error: false,
      detail: { type: 'links', total: 1, truncated: false, items: [{ url: 'https://www.example.gov.cn/dqfq/index.html' }] } },
    { id: 'e7', kind: 'tool', category: 'command', title: '核对报价脚本输出', at: T0 + 26200, ended_at: T0 + 26400, error: true,
      detail: { type: 'output', exit_code: 2, lines: 3, truncated: false } },
    { id: 'e8', kind: 'commentary', text: '脚本的地区枚举少了「西南」，我先补上再写汇总表。\n配置里的 API_KEY=sk-live-abcdefghijklmnop12345678 不会出现在展示里。', at: T0 + 26450 },
    { id: 'e9', kind: 'tool', category: 'write', object: '销售地区汇总.md', live_preview: true, at: T0 + 26500, ended_at: T0 + 27000, error: false,
      detail: { type: 'diff', file: '销售地区汇总.md', added: 42, removed: 0, preview: PREVIEW, truncated: true } },
    { id: 'e10', kind: 'tool', category: 'kb', at: T0 + 27100, ended_at: T0 + 27600, error: false },
    { id: 'e11', kind: 'tool', category: 'delegate', title: '整理各地区明细', at: T0 + 27700 },
  ];
  return baseRun({ events: ev, next_event: 12, step_count: 8 });
}

const SITES = ['baike.example.com', 'www.example.gov.cn', 'news.example.com', 'data.example.org', 'stats.example.cn', 'blog.example.net', 'docs.example.io', 'wiki.example.org'];

function searchRun(n, { titleLen = 70, text = null, preview = null, steps = null } = {}) {
  const ev = [];
  let id = 1;
  for (let i = 0; i < n; i++) {
    const at = T0 + 4000 + i * 1000;
    if (text && i % 2 === 0) ev.push({ id: `e${id++}`, kind: 'commentary', text: text(i), at });
    if (preview && i % 2 === 1) {
      ev.push({ id: `e${id++}`, kind: 'tool', category: 'edit', object: `模块${i}.js`, live_preview: true, at: at + 100, ended_at: at + 600, error: false,
        detail: { type: 'diff', file: `模块${i}.js`, added: 30 + i, removed: 4, preview: preview(i), truncated: false } });
      continue;
    }
    ev.push({ id: `e${id++}`, kind: 'tool', category: 'search_web', object: `第 ${i} 轮检索 地区划分`, at: at + 100, ended_at: at + 900, error: i === 7,
      detail: { type: 'links', total: 10, truncated: true, items: SITES.map((site, k) => ({
        title: `${i}-${k} ${'地区划分标准与统计口径说明'.repeat(6)}`.slice(0, titleLen), url: `https://${site}/a/${i}/${k}/${'p'.repeat(60)}.html` })) } });
  }
  if (steps) for (let i = 0; i < steps; i++) {
    ev.push({ id: `e${id++}`, kind: 'tool', category: i % 2 ? 'command' : 'read', ...(i % 2 ? { title: '运行检查', detail: { type: 'output', exit_code: 0, lines: i, truncated: false } } : { object: `f${i}.md` }), at: T0 + 200000 + i * 500, ended_at: T0 + 200300 + i * 500, error: false });
  }
  const count = ev.filter((e) => e.kind === 'tool').length;
  return baseRun({ run_id: 'r_51d0c3e7', events: ev, next_event: id, step_count: count });
}

const longPreview = (i) => Array.from({ length: 60 }, (_, k) => `+ const row${i}_${k} = computeRegionTotals(input, '${'华东华南华北'.repeat(3)}');`).join('\n');

export const PRODUCER_FIXTURES = [
  { name: 'level0_common', note: 'common run: 8 tool steps (one still running), 2 thinking, 1 merged_turn note; secrets redacted', now: T0 + 28000, run: common() },
  { name: 'level0_status_only', note: 'a run that showed status only: no steps, step_count 0', now: T0 + 5000, run: baseRun({ step_count: 0 }) },
  { name: 'level1_details_halved', note: '9 searches × 8 links: every detail re-cut to half its caps', now: T0 + 200000, run: searchRun(9) },
  { name: 'level2_previews_dropped', note: 'edits with long diff previews: halved, then previews removed', now: T0 + 200000,
    run: searchRun(22, { titleLen: 20, preview: longPreview }) },
  { name: 'level3_thinking_cut', note: 'long commentary: thinking bodies cut to 200', now: T0 + 200000,
    run: searchRun(10, { titleLen: 10, text: (i) => `${i}：${'这一段过程说明很长，'.repeat(90)}` }) },
  { name: 'level4_links_total_only', note: 'many searches: links keep only their total', now: T0 + 200000, run: searchRun(30, { titleLen: 40 }) },
  { name: 'level5_thinking_removed', note: 'many thinking steps and searches: thinking removed', now: T0 + 400000,
    run: searchRun(40, { titleLen: 10, text: (i) => `第 ${i} 步：${'检查输出并继续。'.repeat(30)}` }) },
  { name: 'level6_omitted', note: '200 tool steps: head / tail kept, middle replaced by a steps_omitted note', now: T0 + 912000,
    run: searchRun(40, { steps: 160 }) },
];

/**
 * One example step per category / detail type, for the FE renderers
 * (testdata/agent_run_v3/steps_catalog.json). `children` is Phase 2 (not
 * produced yet) and shown for the renderer only.
 */
export const STEP_CATALOG = [
  { id: 'e1', kind: 'tool', category: 'command', title: '安装依赖并运行测试', at: T0 + 1000 },
  { id: 'e2', kind: 'tool', category: 'command', title: '安装依赖并运行测试', at: T0 + 1000, ended_at: T0 + 9000, error: true,
    detail: { type: 'output', exit_code: 1, lines: 214, truncated: false } },
  { id: 'e3', kind: 'tool', category: 'command', at: T0 + 1000, ended_at: T0 + 1500, error: false, detail: { type: 'output', lines: 0, truncated: false } },
  { id: 'e4', kind: 'tool', category: 'read', object: 'pricing.md', at: T0 + 2000, ended_at: T0 + 2100, error: false },
  { id: 'e5', kind: 'tool', category: 'write', object: 'report.md', live_preview: true, at: T0 + 3000,
    detail: { type: 'diff', file: 'report.md', added: 3, removed: 0, preview: '# Report\n\nDB_PASSWORD=hunter22secret\n', truncated: false } },
  { id: 'e6', kind: 'tool', category: 'edit', object: 'config.js', live_preview: true, at: T0 + 3000, ended_at: T0 + 3100, error: false,
    detail: { type: 'diff', file: 'config.js', added: 1, removed: 1, preview: "- const retries = 3;\n+ const retries = 5;", truncated: false } },
  { id: 'e7', kind: 'tool', category: 'search_files', object: 'TODO\\(', at: T0 + 4000, ended_at: T0 + 4100, error: false },
  { id: 'e8', kind: 'tool', category: 'search_web', object: 'node 22 release date', at: T0 + 5000 },
  { id: 'e9', kind: 'tool', category: 'search_web', object: 'node 22 release date', at: T0 + 5000, ended_at: T0 + 8000, error: false,
    detail: { type: 'links', total: 2, truncated: false, items: [
      { title: 'Node.js 22 is now available', url: 'https://nodejs.org/en/blog/announcements/v22-release-announce' },
      { title: 'Releases', url: 'https://nodejs.org/en/about/previous-releases#looking-for-latest-release' }] } },
  { id: 'e10', kind: 'tool', category: 'fetch_web', object: 'nodejs.org', at: T0 + 9000, ended_at: T0 + 9900, error: true,
    detail: { type: 'text', text: 'HTTP 404 Not Found', truncated: false } },
  { id: 'e11', kind: 'tool', category: 'image', object: 'screenshot.png', at: T0 + 10000, ended_at: T0 + 10100, error: false },
  { id: 'e12', kind: 'tool', category: 'delegate', title: '核对三个地区的数据口径', at: T0 + 11000 },
  { id: 'e13', kind: 'tool', category: 'delegate', title: '核对三个地区的数据口径', at: T0 + 11000, ended_at: T0 + 30000, error: false,
    detail: { type: 'children', total: 4, truncated: true, items: [
      { title: '读取文件', object: 'east.csv', status: 'ok' }, { object: 'south.csv', status: 'ok' }, { title: '统计行数', status: 'error' }] } },
  { id: 'e14', kind: 'tool', category: 'kb', at: T0 + 31000, ended_at: T0 + 31500, error: false },
  { id: 'e15', kind: 'tool', category: 'skill', object: 'pdf', at: T0 + 32000, ended_at: T0 + 32500, error: false },
  { id: 'e16', kind: 'tool', category: 'tool', title: 'SendMessage', at: T0 + 33000, ended_at: T0 + 33100, error: false },
  { id: 'e17', kind: 'tool', category: 'tool', at: T0 + 34000 },
  { id: 'e18', kind: 'commentary', text: 'Tests pass locally; next I will check the release notes.', at: T0 + 35000 },
  { id: 'e19', kind: 'notice', code: 'merged_turn', at: T0 + 36000 },
];
