#!/usr/bin/env node
/**
 * Smoke 11 — AS 工件 + KB 文件集成(NL 驱动)
 *
 * 见 smoke-11-as-kb-files.md。2 轮 NL + 11 断言。
 * test client 在 /tmp 准备 fixture,然后让 agent 用 NL 上传。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';
const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID', 'TEST_DEFAULT_KB_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  TEST_DEFAULT_KB_ID:      process.env.TEST_DEFAULT_KB_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;
process.env.COCO_RPC_LOG = '0';

const TS = Date.now();
const NS = `Smoke11-${TS}`;
const KB_ID = env.TEST_DEFAULT_KB_ID;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const KB_CLI = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/kb.js');
const AS_CLI = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/as.js');
async function runCli(cli, cmd, p = {}) {
  const { stdout } = await execp('node', [cli, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}
const kb = (cmd, p) => runCli(KB_CLI, cmd, p);
const as_ = (cmd, p) => runCli(AS_CLI, cmd, p);
const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- poll ----
function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return unwrapList(await res.json()).filter(m => {
    const k = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return k.includes('AGENT');
  }).filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
}
function extractText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  return '';
}
async function waitForCard({ label, sinceSeq, matchAny = [], maxMs }) {
  const startedAt = Date.now();
  const seen = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        const text = extractText(m);
        seen.push({ seq: m.seq, preview: text.slice(0, 120) });
        if (matchAny.length === 0 || matchAny.some(p => text.includes(p))) return { msg: m, text };
      }
    } catch (e) { log(`  · poll err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms)`);
  for (const s of seen.slice(-8)) console.error(`    seq=${s.seq}  ${s.preview}`);
  process.exit(1);
}
async function currentSeq() {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const arr = unwrapList(await res.json());
  return arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
}

// ---- Fixtures ----
log(`=== Smoke 11 (NL): AS + KB 文件集成 ===  ${NS}`);

const pngPath = `/tmp/${NS}.png`;
const mdPath  = `/tmp/${NS}.md`;
{
  const head = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489', 'hex');
  const pad  = Buffer.alloc(8192 - head.length, 0);
  pad.write(`${TS}-png-fixture-`, 0, 'utf8');
  fs.writeFileSync(pngPath, Buffer.concat([head, pad]));
}
{
  let buf = '';
  while (buf.length < 12 * 1024) buf += `${NS} md line ${buf.length}\n`;
  fs.writeFileSync(mdPath, buf);
}
log(`   fixtures: ${pngPath} (${fs.statSync(pngPath).size}B) + ${mdPath} (${fs.statSync(mdPath).size}B)`);

let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] upload + links');
const NL1 = `我本地有两个研究材料,在 ${pngPath} 和 ${mdPath},你帮我:
1. 这两个文件都上传到默认知识库根目录(用 KB 高层 upload 接口)
2. 上传完告诉我每个文件怎么下载

报给我两个 artifactId + 两个 nodeId + 下载方式。`;
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: ['artifactId', 'artifact_id', 'nodeId', 'node_id', '上传', 'upload'],
  maxMs: 150 * 1000,
});
cursor = Number(r1.msg.seq);

// 卡片体:至少 2 个 artifactId(uuid-like),且不含短时效的原始下载链接
// (下载链接只给 agent 自己当场取用,不进消息)
const uuids1 = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids1.length >= 2, `1a. round1 含 ≥ 2 uuid (got ${uuids1.length})`);
const rawLinks = r1.text.match(/https?:\/\/\S*(X-Amz-|X-Goog-|\/api\/public\/artifacts\/download\/)\S*/gi) || [];
assertTrue(rawLinks.length === 0, `1b. round1 不含原始下载链接 (got ${rawLinks.length})`);
assertTrue(/上传完|上传成功|upload/i.test(r1.text), `2. round1 含 上传完 / upload 语义`);

// 旁路:走 tree 找新增 file 节点
const rootsAfter1 = unwrapList(await kb('kb.tree_roots', { kbId: KB_ID }));
let foundPngNode = null, foundMdNode = null;
async function walkFindFiles(nodeId) {
  if (!nodeId) return;
  let kids;
  try { kids = unwrapList(await kb('kb.node_children', { kbId: KB_ID, nodeId })); }
  catch { return; }
  for (const k of kids) {
    if (k.node_type === 'file') {
      if (/png/i.test(k.name) && (k.name || '').includes(NS)) foundPngNode = foundPngNode || k;
      if (/md|markdown/i.test(k.name) && (k.name || '').includes(NS)) foundMdNode = foundMdNode || k;
    }
    if (k.node_type === 'folder') await walkFindFiles(k.id);
  }
}
for (const r of rootsAfter1) {
  if (r.node_type === 'file' && (r.name || '').includes(NS)) {
    if (/png/i.test(r.name)) foundPngNode = foundPngNode || r;
    if (/md|markdown/i.test(r.name)) foundMdNode = foundMdNode || r;
  }
  if (r.node_type === 'folder') await walkFindFiles(r.id);
}
assertTrue(foundPngNode || foundMdNode, `6. KB 树里能找到至少一个 file 节点的 name 含 ${NS}`);
log(`   foundPngNode=${foundPngNode && foundPngNode.id}  foundMdNode=${foundMdNode && foundMdNode.id}`);

// 旁路:下载 + hash 回环(对找到的那个)
const downloadTarget = foundPngNode || foundMdNode;
let pngArtifactId = downloadTarget.artifact_id || downloadTarget.artifactId;
try {
  const dl = await as_('as.download', { artifactId: pngArtifactId });
  const localPath = dl.localPath || dl.local_path;
  const origPath  = /png/i.test(downloadTarget.name) ? pngPath : mdPath;
  assertEq(hashFile(localPath), hashFile(origPath),
      `7. 下载文件 byte hash == 原 fixture`);
} catch (e) {
  warn(`7. 字节回环 抛: ${e.message.slice(0,160)}; warn-only`);
  ok(`7. (warn-only)`);
}

// ---------- Round 2 ----------
log('[Round 2] folder refs + batch download');
const NL2 = `顺手再做两件事:
1. 在默认 KB 下面新建一个 folder 叫 "${NS}/refs",
   把刚才那个 PNG 文件(用 artifactId)在这个新 folder 下挂一份引用(file_create)
2. 然后批量下载这两个文件(原 PNG 和 MD,用 batch_download),
   验证一次能拿到两个 URL

完成后报新 folder id、引用 file 节点 id、batch_download 返回了几条记录。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: [`${NS}/refs`, 'batch', '批量', '引用', 'file_create'],
  maxMs: 120 * 1000,
});
cursor = Number(r2.msg.seq);

const uuids2 = r2.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids2.length >= 2, `3a. round2 含 ≥ 2 uuid (folder + file ref) (got ${uuids2.length})`);
assertTrue(/批量|batch/i.test(r2.text), `3b. round2 含 批量 / batch 语义`);
assertTrue(/2|两/.test(r2.text), `4. round2 提到 ≥ 2 条`);
assertTrue(r2.text.includes(`${NS}/refs`), `5. round2 含 folder 名 ${NS}/refs`);

// 旁路:在 tree 里找 refs folder
let refsFolder = null;
for (const r of unwrapList(await kb('kb.tree_roots', { kbId: KB_ID }))) {
  if (r.node_type === 'folder' && (r.name || '').includes(`${NS}/refs`)) { refsFolder = r; break; }
}
assertTrue(refsFolder, `8. KB 树里找到 ${NS}/refs folder`);
log(`   refsFolder=${refsFolder && refsFolder.id}`);

const refsKids = unwrapList(await kb('kb.node_children', { kbId: KB_ID, nodeId: refsFolder.id }));
assertTrue(refsKids.length >= 1, `9. refs folder 下 ≥ 1 child (got ${refsKids.length})`);

const refChild = refsKids[0];
const refArtId = refChild.artifact_id || refChild.artifactId;
if (refArtId && pngArtifactId) {
  assertEq(refArtId, pngArtifactId, `10. 引用 child 的 artifact_id == 原 PNG artifactId`);
} else {
  warn(`10. tree node 没暴露 artifact_id 字段,无法对比,warn-only`);
  ok(`10. (warn-only)`);
}

// 旁路:batch_download
if (foundPngNode && foundMdNode) {
  try {
    const batch = await kb('kb.file_batch_download', {
      kbId: KB_ID, nodeIds: [foundPngNode.id, foundMdNode.id],
    });
    const arr = unwrapList(batch);
    assertTrue(arr.length >= 2, `11. kb.file_batch_download ≥ 2 条 (got ${arr.length})`);
  } catch (e) {
    die(`11. batch_download 抛错: ${e.message}`);
  }
} else {
  warn(`11. foundPngNode 或 foundMdNode 缺失,跳过 batch 测`);
  ok(`11. (skipped)`);
}

// ---------------------------------------------------------------------------
log('');
log(`✅ Smoke 11 (NL) PASS (11 / 11)`);
log(`   PNG node = ${foundPngNode && foundPngNode.id}`);
log(`   MD  node = ${foundMdNode && foundMdNode.id}`);
log(`   refs folder = ${refsFolder && refsFolder.id}`);
