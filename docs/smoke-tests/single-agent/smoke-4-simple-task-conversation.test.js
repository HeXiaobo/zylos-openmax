#!/usr/bin/env node
/**
 * Smoke 4 — 简单任务 · 对话全流程(P0 五卡片闭环)
 *
 * 见同目录 smoke-4-simple-task-conversation.md 完整 spec。
 *
 * 与 Smoke 1/2/3 不同:这条用例**不**让 agent 走 tm.js 显式状态机指令,而是
 * 给一段自然语言,让 agent 自主走完"任务分析 → 开始执行 → 执行进度 →
 * 交付 → 验收完成"五张卡片,过程中验证卡片体关键短语 + 后端真实状态。
 *
 * 任意断言失败 → process.exit(1)。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  sendInstruction, tm, listIssuesInProject,
  assertEq, assertTrue, log, ok, warn, die,
} from './lib/runner.js';

const execp = promisify(execFile);

// ---------------------------------------------------------------------------
// Env validation (smoke-4 reuses runner.loadEnv but enforces extra fields)
// ---------------------------------------------------------------------------

const SMOKE4_REQUIRED = [
  'COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID',
  'TEST_DEFAULT_PROJECT_ID', 'TEST_DEFAULT_KB_ID',
];
for (const k of SMOKE4_REQUIRED) {
  if (!process.env[k]) {
    console.error(`✗ Missing required env: ${k}`);
    console.error(`  Smoke 4 required: ${SMOKE4_REQUIRED.join(', ')}`);
    process.exit(2);
  }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  TEST_DEFAULT_PROJECT_ID: process.env.TEST_DEFAULT_PROJECT_ID,
  TEST_DEFAULT_KB_ID:      process.env.TEST_DEFAULT_KB_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;  // for downstream tm/kb CLI

// ---------------------------------------------------------------------------
// kb.js CLI wrapper (mirrors smoke-2 pattern; kb.search is not in runner.js)
// ---------------------------------------------------------------------------

function resolveKbCli() {
  if (process.env.COCO_KB_CLI) return process.env.COCO_KB_CLI;
  const installed = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/kb.js');
  if (fs.existsSync(installed)) return installed;
  return path.resolve(path.dirname(import.meta.url.replace('file://','')), '../../../src/cli/kb.js');
}
async function kb(cmd, params = {}) {
  const { stdout } = await execp('node', [resolveKbCli(), cmd, JSON.stringify(params)], {
    env: { ...process.env, COCO_RPC_LOG: '0' },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Conversation message polling (loop until matching message arrives)
// ---------------------------------------------------------------------------

function headers(extra = {}) {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json', ...extra };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
    h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return h;
}

async function listAgentMessagesAfter(seq) {
  // GET /api/v1/conversations/{id}/messages — only AGENT-authored ones above `seq`.
  const url = `${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`list-messages HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const msgs = (body.data || body.items || body || []).filter(m => m.sender_type === 'AGENT_TEXT'
                                                              || m.sender_type === 'AGENT'
                                                              || m.type === 'AGENT_TEXT');
  return msgs.filter(m => Number(m.seq || 0) > seq).sort((a, b) => Number(a.seq) - Number(b.seq));
}

function extractText(msg) {
  // Tolerate every shape cws-core has used during the contract churn.
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  if (Array.isArray(c)) {
    return c.map(part => part?.body || part?.text || '').join('\n');
  }
  try { return JSON.stringify(c); } catch { return ''; }
}

const CARD_TIMEOUTS = {
  '任务分析':   30 * 1000,
  '开始执行':   15 * 1000,
  '执行进度':   60 * 1000,
  '交付':       90 * 1000,
  '验收完成':   15 * 1000,
};

async function waitForCard({ label, sinceSeq, matchAny, maxMs }) {
  const startedAt = Date.now();
  const seenMsgs = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        const text = extractText(m);
        seenMsgs.push({ seq: m.seq, preview: text.slice(0, 120) });
        for (const phrase of matchAny) {
          if (text.includes(phrase)) {
            return { msg: m, text, matchedPhrase: phrase };
          }
        }
      }
    } catch (e) {
      log(`  · poll error (将重试): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms, sinceSeq=${sinceSeq})`);
  console.error('  Agent messages seen in this window:');
  for (const s of seenMsgs.slice(-10)) console.error(`    seq=${s.seq}  ${s.preview}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers for backing-data assertions
// ---------------------------------------------------------------------------

const KEYWORDS_FOR_ISSUE_TITLE = ['AI Coding', '竞品分析', 'Cursor', 'Windsurf'];

function titleMatchesPhase1(title) {
  if (!title) return false;
  return KEYWORDS_FOR_ISSUE_TITLE.some(k => title.includes(k));
}

async function findCreatedIssue() {
  const issues = await listIssuesInProject(env.TEST_DEFAULT_PROJECT_ID);
  return issues.find(i => titleMatchesPhase1(i.title));
}

async function findArchivedIssue(issueId) {
  const issues = await tm('issue.list_in_project', {
    projectId: env.TEST_DEFAULT_PROJECT_ID, status: 'archived',
  });
  const arr = Array.isArray(issues) ? issues : (issues.data || []);
  return arr.find(i => i.id === issueId);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log('=== Smoke 4: 简单任务 · 对话全流程 ===');

// Snapshot conversation seq so we only watch agent messages from now on.
let cursorSeq = 0;
try {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const body = await res.json();
  const arr = body.data || body.items || [];
  cursorSeq = arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
  log(`  cursorSeq = ${cursorSeq}`);
} catch (e) {
  warn(`未能读取当前 conv seq,默认从 0 开始(${e.message})`);
}

// -- Phase 1: send the simple-task instruction -----------------------------
const PHASE1_INSTRUCTION = `帮我做一份近期主流 AI Coding 工具的竞品分析报告。
重点对比 Cursor、Windsurf、Claude Code、Codex 这 4 个的核心功能、定价、目标用户。
不用做特别复杂,有个大概对比就行,这周五前给我,我准备拿来给团队评审。`;

log('[Phase 1] 发自然语言指令');
await sendInstruction(env, PHASE1_INSTRUCTION);

// -- Phase 2: wait for "任务分析" card --------------------------------------
log('[Phase 2] 等"任务分析"卡片');
const analysis = await waitForCard({
  label: '任务分析',
  sinceSeq: cursorSeq,
  matchAny: ['任务分析', '简单研究任务', '独立完成'],
  maxMs: CARD_TIMEOUTS['任务分析'],
});
cursorSeq = Number(analysis.msg.seq);

const at = analysis.text;
assertTrue(at.includes('简单') || at.includes('single agent') || at.includes('独立完成'),
    '2. 卡片体含简单任务语义关键词');
assertTrue(at.includes('默认项目'), '3. 卡片体含 "默认项目"');
assertTrue(at.includes('默认知识库'), '4. 卡片体含 "默认知识库"');
assertTrue(at.includes('确认执行') || at.includes('是否确认') || at.includes('是否开始'),
    '5. 卡片体含确认询问');
ok('1. "任务分析"卡片已收到');

// -- Phase 3: user confirms -------------------------------------------------
log('[Phase 3] 发"确认"');
await sendInstruction(env, '确认');

// -- Phase 4: wait for "开始执行" card + backing issue ---------------------
log('[Phase 4] 等"开始执行"卡片');
const startExec = await waitForCard({
  label: '开始执行',
  sinceSeq: cursorSeq,
  matchAny: ['开始执行', '已在项目', '已创建问题'],
  maxMs: CARD_TIMEOUTS['开始执行'],
});
cursorSeq = Number(startExec.msg.seq);

assertTrue(startExec.text.includes('已在项目「默认项目」') || startExec.text.includes('默认项目'),
    '7. 卡片体含 "默认项目" 落点');
assertTrue(startExec.text.includes('开始执行') || startExec.text.includes('完成后会通知'),
    '8. 卡片体含执行启动语义');
ok('6. "开始执行"卡片已收到');

// Backing assertion: a new issue exists under default project
let issue = null;
for (let i = 0; i < 20; i++) {
  issue = await findCreatedIssue();
  if (issue) break;
  await new Promise(r => setTimeout(r, 1000));
}
assertTrue(issue, '13. 默认项目下能找到新 issue,title 命中 Phase 1 关键词');
assertEq(issue.project_id, env.TEST_DEFAULT_PROJECT_ID, '14. issue.project_id == 默认项目');
log(`   created issueId = ${issue.id}, title = "${issue.title}"`);

// -- Phase 5: wait for at least one "执行进度" card -------------------------
log('[Phase 5] 等至少 1 张"执行进度"卡片');
const progress = await waitForCard({
  label: '执行进度',
  sinceSeq: cursorSeq,
  matchAny: ['执行进度', '任务进展', '进展', '✅'],
  maxMs: CARD_TIMEOUTS['执行进度'],
});
cursorSeq = Number(progress.msg.seq);
ok('9. 至少 1 张"执行进度"卡片已收到');

// -- Phase 6: wait for "交付" card + KB page exists ------------------------
log('[Phase 6] 等"交付"卡片');
const delivery = await waitForCard({
  label: '交付',
  sinceSeq: cursorSeq,
  matchAny: ['请验收', '产物文件', '交付'],
  maxMs: CARD_TIMEOUTS['交付'],
});
cursorSeq = Number(delivery.msg.seq);

assertTrue(delivery.text.includes('请验收'), '11. 交付卡片体含 "请验收"');
ok('10. "交付"卡片已收到');

// Backing: issue is now in 'delivered' (or already 'accepted' if agent moved on)
const issueAfterDeliver = (await tm('issue.get', { id: issue.id })).data || (await tm('issue.get', { id: issue.id }));
assertTrue(issueAfterDeliver.status === 'delivered' || issueAfterDeliver.status === 'accepted',
    `15. 交付后 issue.status ∈ {delivered, accepted}(got ${issueAfterDeliver.status})`);

// Backing: KB search hits at least one page tied to this issue's topic
try {
  const searchResp = await kb('kb.search', { query: KEYWORDS_FOR_ISSUE_TITLE[0], kbId: env.TEST_DEFAULT_KB_ID });
  const hits = (searchResp.data || searchResp.hits || searchResp.results || searchResp || []);
  const hitsArr = Array.isArray(hits) ? hits : (hits.items || []);
  assertTrue(hitsArr.length >= 1, `16. kb.search 在默认 KB 至少 1 条命中 (got ${hitsArr.length})`);
} catch (e) {
  console.error(`✗ 16. kb.search 失败: ${e.message}`);
  process.exit(1);
}

// -- Phase 7: user accepts --------------------------------------------------
log('[Phase 7] 发"确认验收"');
await sendInstruction(env, '确认验收');

// -- Phase 8: wait for "验收完成" card + final state assertions -------------
log('[Phase 8] 等"验收完成"卡片');
const ack = await waitForCard({
  label: '验收完成',
  sinceSeq: cursorSeq,
  matchAny: ['验收完成', '已关闭', '已归档'],
  maxMs: CARD_TIMEOUTS['验收完成'],
});
cursorSeq = Number(ack.msg.seq);

assertTrue(ack.text.includes('已关闭'), '12a. 验收完成卡含 "已关闭"');
assertTrue(ack.text.includes('已归档'), '12b. 验收完成卡含 "已归档"');
ok('12. "验收完成"卡片已收到');

// Backing: final issue state
const finalIssueResp = await tm('issue.get', { id: issue.id });
const finalIssue = finalIssueResp.data || finalIssueResp;
assertEq(finalIssue.status, 'accepted', '17. issue.status == accepted');
assertEq(finalIssue.acceptance_source, 'explicit', '18. issue.acceptance_source == explicit');

// Backing: should not appear in active list, should appear in archived list
const activeList = (await tm('issue.list_in_project', { projectId: env.TEST_DEFAULT_PROJECT_ID, status: 'active' }));
const activeArr = Array.isArray(activeList) ? activeList : (activeList.data || []);
const inActive = activeArr.some(i => i.id === issue.id);
const archivedHit = await findArchivedIssue(issue.id);
assertTrue(!inActive && archivedHit, '19. 默认 active list 不再出现 + archived list 能找回');

// Backing: KB page survives accept (not deleted)
try {
  const searchResp = await kb('kb.search', { query: KEYWORDS_FOR_ISSUE_TITLE[0], kbId: env.TEST_DEFAULT_KB_ID });
  const hits = (searchResp.data || searchResp.hits || searchResp.results || searchResp || []);
  const hitsArr = Array.isArray(hits) ? hits : (hits.items || []);
  assertTrue(hitsArr.length >= 1, '20. 验收后 KB 产物 page 仍能搜到');
} catch (e) {
  console.error(`✗ 20. 验收后 kb.search 失败: ${e.message}`);
  process.exit(1);
}

log('');
log('✅ Smoke 4: 简单任务 · 对话全流程 PASS');
log(`   issueId = ${issue.id}`);
log(`   title   = ${issue.title}`);
log(`   final   = accepted + archived`);
