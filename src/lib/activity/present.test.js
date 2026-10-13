import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATEGORY_TITLES, eventToStep, toolTags, joinTitle, stateTitle, line, bodyText, runTitle, runSubtitle, groupStep, replyStep,
} from './present.js';
import { CATEGORIES, TOOL_ALLOWLIST, DETAIL_ALLOWLIST } from './constants.js';

test('"执行命令 · Bash · node": title from the category, tags from the allowlisted tool and program', () => {
  const step = eventToStep({ id: 'e3', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', at: 1, ended_at: 5, error: false });
  assert.deepEqual(step, { id: 'e3', kind: 'action', status: 'ok', at: 1, ended_at: 5, title: '执行命令', tags: ['Bash', 'node'] });
  assert.equal(joinTitle(step.title, step.tags), '执行命令 · Bash · node');
  assert.equal(stateTitle('tool', { category: 'command', tool: 'Bash', detail: 'node' }), '正在执行命令 · Bash · node');
});

test('every tool category has a title; unknown → 调用工具', () => {
  for (const c of CATEGORIES) assert.ok(CATEGORY_TITLES[c], c);
  assert.equal(CATEGORY_TITLES.reply, '发送回复');
  assert.equal(CATEGORY_TITLES.web, '搜索网页');
  assert.equal(CATEGORY_TITLES.delegate, '分派任务');
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'mystery', at: 1 }).title, '调用工具');
});

test('tags: only TOOL_ALLOWLIST / DETAIL_ALLOWLIST names, ≤ 4, each ≤ 32', () => {
  assert.deepEqual(toolTags({ tool: 'Bash', detail: 'git' }), ['Bash', 'git']);
  assert.deepEqual(toolTags({ tool: 'mcp__x__y', detail: 'rm' }), []);
  assert.deepEqual(toolTags({ tool: 'node', detail: 'Bash' }), [], 'a name only counts in its own list');
  assert.deepEqual(toolTags({}), []);
  for (const t of [...TOOL_ALLOWLIST, ...DETAIL_ALLOWLIST]) assert.ok(t.length <= 32, t);
  // A tool step never carries a tags field when nothing is allowlisted.
  assert.equal('tags' in eventToStep({ id: 'e1', kind: 'tool', category: 'tool', tool: 'secret_tool', at: 1 }), false);
});

test('steps: commentary → text (body), notice → note (title), running / error / ok statuses, ids cut to 32', () => {
  assert.deepEqual(eventToStep({ id: 'e1', kind: 'commentary', text: '先看配置\n再跑测试\u0007', at: 1 }), { id: 'e1', kind: 'text', at: 1, body: '先看配置\n再跑测试' });
  assert.equal(eventToStep({ id: 'e1', kind: 'commentary', text: '  \n ', at: 1 }), null);
  assert.deepEqual(eventToStep({ id: 'e2', kind: 'notice', code: 'merged_turn', at: 2 }), { id: 'e2', kind: 'note', at: 2, title: '与其他消息合并处理' });
  assert.equal(eventToStep({ id: 'e2', kind: 'notice', code: 'unknown_code', at: 2 }), null);
  assert.equal(eventToStep({ id: 'e3', kind: 'tool', category: 'read', at: 3 }).status, 'running');
  assert.equal(eventToStep({ id: 'e3', kind: 'tool', category: 'read', at: 3, ended_at: 4, error: true }).status, 'error');
  assert.equal(eventToStep({ id: 'x'.repeat(40), kind: 'notice', code: 'truncated', at: 1 }).id.length <= 32, true);
  assert.equal(eventToStep({ kind: 'other' }), null);
});

test('action body: the sanitized description only, one line, ≤ 80; never on live steps (withBody: false)', () => {
  const ev = { id: 'e1', kind: 'tool', category: 'command', tool: 'Bash', detail: 'git', description: `看\n${'字'.repeat(100)}`, at: 1 };
  const stored = eventToStep(ev);
  assert.equal(Array.from(stored.body).length, 80);
  assert.equal(stored.body.includes('\n'), false);
  assert.equal('body' in eventToStep(ev, { withBody: false }), false);
});

test('length caps: titles / lines ≤ 80, bodies ≤ 2000 code points', () => {
  assert.equal(Array.from(line('长'.repeat(200))).length, 80);
  assert.equal(Array.from(bodyText('长'.repeat(3000))).length, 2000);
  assert.equal(Array.from(stateTitle('tool', { category: 'command', tool: 'Bash', detail: 'node' })).length <= 80, true);
});

test('run titles, subtitles, group and reply steps; status lines per state', () => {
  assert.equal(runTitle(12), '执行了 12 步');
  assert.equal(runTitle(0), '执行过程');
  assert.equal(runSubtitle({ omitted: 37 }), '已精简，省略中间 37 步');
  assert.equal(runSubtitle({ trimmed: true }), '已精简');
  assert.equal(runSubtitle({}), undefined);
  assert.deepEqual(groupStep([{ at: 10, ended_at: 12, status: 'ok' }, { at: 13, status: 'error' }]),
    { id: 'omitted', kind: 'group', status: 'error', at: 10, ended_at: 13, title: '…中间 2 步', count: 2 });
  assert.deepEqual(replyStep('e9', 50), { id: 'e9', kind: 'action', status: 'ok', at: 50, ended_at: 50, title: '发送回复' });
  assert.equal(stateTitle('queued'), '排队中');
  assert.equal(stateTitle('thinking'), '正在思考');
  assert.equal(stateTitle('done'), '已完成');
  assert.equal(stateTitle('done', { reason: 'no_reply' }), '已结束');
  assert.equal(stateTitle('failed', { reason: 'interrupted' }), '已中断');
  assert.equal(stateTitle('failed', { reason: 'runtime_restarted' }), '已中断（Agent 重启）');
  assert.equal(stateTitle('tool', { category: 'read', tool: 'Read' }), '正在读取文件 · Read');
  assert.equal(stateTitle('tool', { category: 'web', tool: 'not_allowed' }), '正在搜索网页');
});
