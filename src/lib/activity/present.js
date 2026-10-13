/**
 * Display wording for agent_run schema v2 — the one place that decides what a
 * run looks like (titles, tags, notes). cws-comm stores / relays the result
 * without reading it and cws-fe renders it generically (title · tags, plain
 * text), so a display change is a change here only.
 *
 * Privacy (unchanged, enforced here and in classify.js): a step never carries
 * command text. Tags come only from TOOL_ALLOWLIST (tool names) and
 * DETAIL_ALLOWLIST (program names); an action body is only the sanitized Bash
 * `description` (classify.js sanitizeDescription); a text body is the agent's
 * own commentary. Every string is cut to its limit here.
 */

import {
  TOOL_ALLOWLIST, DETAIL_ALLOWLIST, TEXT_LIMIT, TITLE_LIMIT, DESCRIPTION_LIMIT, TAG_LIMIT, MAX_TAGS, STEP_ID_LIMIT,
} from './constants.js';

/** Tool category → step title (also the "正在…" status line). */
export const CATEGORY_TITLES = Object.freeze({
  command: '执行命令',
  read: '读取文件',
  write: '编辑文件',
  search: '搜索文件',
  web: '搜索网页',
  image: '查看图片',
  delegate: '分派任务',
  waiting: '等待结果',
  tool: '调用工具',
  kb: '查询知识库',
  reply: '发送回复',
});

/** Notice code → note title. */
export const NOTICE_TITLES = Object.freeze({
  merged_turn: '与其他消息合并处理',
  focus_acquired: '开始处理这条消息',
  truncated: '说明过长，已截断',
});

/** Live-frame status line per state (tool: "正在<title> · tags"). */
const STATE_TITLES = Object.freeze({
  queued: '排队中',
  thinking: '正在思考',
  done: '已完成',
  failed: '已中断',
});

// Any control character (a title / tag allows none; a body allows \n and \t).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Cut to at most `limit` code points, ending in "…" when shortened. */
export function cut(text, limit) {
  const cps = Array.from(String(text ?? ''));
  if (cps.length <= limit) return cps.join('');
  return `${cps.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** One-line text: controls removed, whitespace collapsed, cut to `limit`. */
export function line(text, limit = TITLE_LIMIT) {
  return cut(String(text ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim(), limit);
}

/** Multi-line text (\n and \t kept), cut to `limit`. */
export function bodyText(text, limit = TEXT_LIMIT) {
  return cut(String(text ?? '').replace(BODY_CONTROL_RE, ''), limit);
}

export function categoryTitle(category) {
  return CATEGORY_TITLES[category] || CATEGORY_TITLES.tool;
}

/** Tags of a tool step: allowlisted tool name, then allowlisted program name. */
export function toolTags({ tool, detail } = {}) {
  const tags = [];
  if (typeof tool === 'string' && TOOL_ALLOWLIST.has(tool)) tags.push(tool);
  if (typeof detail === 'string' && DETAIL_ALLOWLIST.has(detail)) tags.push(detail);
  return tags.slice(0, MAX_TAGS).map((t) => cut(t, TAG_LIMIT));
}

/** "执行命令 · Bash · node" — the title followed by its tags. */
export function joinTitle(title, tags = []) {
  return line([title, ...tags].join(' · '));
}

/** Terminal status lines by reason. */
const REASON_TITLES = Object.freeze({
  no_reply: '已结束',
  runtime_restarted: '已中断（Agent 重启）',
  interrupted: '已中断',
});

/** Live status line of a run for the frame header. */
export function stateTitle(state, { category, tool, detail, reason } = {}) {
  if (state === 'tool') return joinTitle(`正在${categoryTitle(category)}`, toolTags({ tool, detail }));
  if ((state === 'done' || state === 'failed') && REASON_TITLES[reason]) return REASON_TITLES[reason];
  return STATE_TITLES[state] || STATE_TITLES.thinking;
}

const stepId = (id) => cut(String(id ?? ''), STEP_ID_LIMIT);

/**
 * One run event (commentary / tool / notice, start and end merged) → a v2
 * step, or null when it has nothing to show.
 *
 * @param {object} ev
 * @param {{ withBody?: boolean }} opts withBody: the tool step's sanitized
 *   `description` as its body (stored summary only; live frames leave it out)
 */
export function eventToStep(ev, { withBody = true } = {}) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.kind === 'commentary') {
    const body = bodyText(ev.text);
    if (!body.trim()) return null;
    return { id: stepId(ev.id), kind: 'text', at: ev.at, body };
  }
  if (ev.kind === 'tool') {
    const done = ev.ended_at != null;
    const step = { id: stepId(ev.id), kind: 'action', status: done ? (ev.error ? 'error' : 'ok') : 'running', at: ev.at };
    if (done) step.ended_at = ev.ended_at;
    step.title = categoryTitle(ev.category);
    const tags = toolTags(ev);
    if (tags.length) step.tags = tags;
    if (withBody && ev.description) {
      const body = line(ev.description, DESCRIPTION_LIMIT);
      if (body) step.body = body;
    }
    return step;
  }
  if (ev.kind === 'notice') {
    const title = NOTICE_TITLES[ev.code];
    if (!title) return null;
    return { id: stepId(ev.id), kind: 'note', at: ev.at, title };
  }
  return null;
}

/** Run title of a stored summary: "执行了 N 步" (N = action steps before compaction). */
export function runTitle(actionCount) {
  return actionCount > 0 ? `执行了 ${actionCount} 步` : '执行过程';
}

/** Subtitle of a compacted summary. */
export function runSubtitle({ omitted = 0, trimmed = false } = {}) {
  if (omitted > 0) return `已精简，省略中间 ${omitted} 步`;
  return trimmed ? '已精简' : undefined;
}

/** The folded middle of a compacted summary. */
export function groupStep(mid) {
  return {
    id: 'omitted',
    kind: 'group',
    status: mid.some((s) => s.status === 'error') ? 'error' : 'ok',
    at: mid[0].at,
    ended_at: Math.max(...mid.map((s) => s.ended_at ?? s.at)),
    title: `…中间 ${mid.length} 步`,
    count: mid.length,
  };
}

/** The reply step a summary adds for the reply it travels with. */
export function replyStep(id, at) {
  return { id: stepId(id), kind: 'action', status: 'ok', at, ended_at: at, title: CATEGORY_TITLES.reply };
}
