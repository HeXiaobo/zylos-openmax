/**
 * IM owner notice (OPENM-936, contract v2) — deliver a platform-rendered notice
 * to the owner's most recent IM private chat, in code, without waking the model.
 *
 * Contract v2 (cws-core → cws-comm PushAgentNotice → this plugin):
 *   cws-comm pushes a WS `system` frame
 *     { event: "agent.im_owner_notice",
 *       data: { org_id, agent_member_id, event_id, kind, text, occurred_at } }
 *   (any `report_token` in data is ignored — there is no report-back to cws-core).
 *   (no conversation / message — the v1 system-DM carrier was dropped). The
 *   frame path never runs the credit-arrears gate, so notices still go out
 *   while the org is LLM-suspended (that is exactly the org_credits_exhausted case).
 *
 * Plugin behavior:
 *   1. Never forward the notice to C4 / the model.
 *   2. Dedup by event_id (small bounded persisted set).
 *   3. Resolve the "latest owner DM endpoint" and send `text` through
 *      `c4-send.js <channel> <endpoint>` (body on stdin).
 *   4. No owner DM address → log and do nothing. Nothing is reported back.
 *
 * Owner-DM endpoint cache. Every inbound IM message is written by its channel
 * component to C4 sqlite (`conversations`, direction='in'). We read that table
 * on demand at notice time (freshest answer, no extra service), AND persist the
 * winner to `im-owner-endpoint.json` — refreshed periodically and on every
 * notice — so C4 pruning/rotation cannot lose the last known address.
 *
 * DM detection per channel (contract v2 §B, verified against each channel
 * component's endpoint builder). `type:dm-pairing` (admin pairing
 * notifications) is always excluded; anything unknown is NOT cached.
 *   - lark / feishu / dingtalk / wecom / whatsapp: endpoint token `type:p2p`
 *   - slack / line / ms-teams / whatsapp-business: exact endpoint token `type:dm`
 *   - telegram: first endpoint segment is a positive integer (private chat id;
 *     groups are negative)
 *   - wechat: endpoint contains `|to:` (`<account>|to:<user>`). Sending may fail
 *     with ERR_CONTEXT_TOKEN_MISSING (no live context token) → logged `failed`.
 *   - discord: C4 row content starts with `[DISCORD DM]`
 *   - zalo: C4 row content starts with `[Zalo DM]`
 *
 * A DM is then only used if it is POSITIVELY attributable to the channel's
 * bound owner (components/<channel>/config.json `owner.*`); see OWNER_MATCHERS.
 * dmPolicy is never used as evidence (legacy `whitelist` configs, history from
 * an earlier open policy or a previous owner would make it wrong).
 *
 * Before sending (and caching), message-level endpoint params (msg / req /
 * replyKey / root / parent / thread) are stripped so the notice is a fresh DM,
 * not a reply to an old message; routing params (type / account / user / to)
 * are kept.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

export const IM_OWNER_NOTICE_TYPE = 'im_owner_notice';

/** Internal / non-IM C4 channels that must never be chosen as an owner DM. */
export const EXCLUDED_CHANNELS = new Set(['openmax', 'scheduler', 'system', 'web-console', 'shell']);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DEFAULT_COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
export const DEFAULT_CACHE_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-endpoint.json');
export const DEFAULT_DEDUP_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-notice-seen.json');
export const DEFAULT_C4_DB = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
export const DEFAULT_C4_SEND = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-send.js');
export const DEDUP_MAX = 200;
/** Send attempts per event_id (local delayed retries + redeliveries) before giving up. */
export const MAX_ATTEMPTS = 3;
/** Delay before local retry #2 and #3 after a failed / no_address attempt. */
export const RETRY_DELAYS_MS = [30_000, 120_000];
/** C4 comm-bridge skill dir; its node_modules ships better-sqlite3 (c4-db.js uses it). */
export const DEFAULT_COMM_BRIDGE_DIR = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge');
/** Rows scanned per on-demand C4 read (newest first). */
const SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const IM_OWNER_NOTICE_EVENT = 'agent.im_owner_notice';

/** Return the notice payload (`payload.data`) of an agent.im_owner_notice system frame. */
export function noticeFromSystemFrame(frame) {
  const data = frame?.payload?.data;
  return data && typeof data === 'object' ? data : null;
}

const P2P_CHANNELS = new Set(['lark', 'feishu', 'dingtalk', 'wecom', 'whatsapp']);
const DM_TOKEN_CHANNELS = new Set(['slack', 'line', 'ms-teams', 'whatsapp-business']);
const CONTENT_PREFIX = { discord: '[DISCORD DM]', zalo: '[Zalo DM]' };

/**
 * Whether a C4 inbound row (channel, endpoint, content) is a private chat with
 * the owner. Conservative: unknown channels / formats return false.
 */
export function isOwnerDmEndpoint(channel, endpoint, content) {
  const ch = String(channel || '').toLowerCase();
  if (!ch || EXCLUDED_CHANNELS.has(ch) || !endpoint) return false;
  const ep = String(endpoint);
  const parts = ep.split('|');
  if (!parts[0] || parts.slice(1).includes('type:dm-pairing')) return false;
  if (P2P_CHANNELS.has(ch)) return parts.slice(1).includes('type:p2p');
  if (DM_TOKEN_CHANNELS.has(ch)) return parts.slice(1).includes('type:dm');
  if (ch === 'telegram') return /^[1-9]\d*$/.test(parts[0]);
  if (ch === 'wechat') return ep.includes('|to:') && parts.some(p => p.startsWith('to:') && p.length > 3);
  if (CONTENT_PREFIX[ch]) return typeof content === 'string' && content.startsWith(CONTENT_PREFIX[ch]);
  return false;
}

// ---------------------------------------------------------------------------
// Owner attribution (a DM is not necessarily the OWNER's DM)
// ---------------------------------------------------------------------------

/** Read ~/zylos/components/<channel>/config.json (null when missing/invalid). */
export function loadChannelConfig(channel, componentsDir = DEFAULT_COMPONENTS_DIR) {
  if (!/^[a-z0-9-]+$/.test(String(channel || ''))) return null;
  return readJson(path.join(componentsDir, String(channel), 'config.json'));
}

const firstSeg = (ep) => String(ep).split('|')[0];
const token = (ep, key) => {
  const t = String(ep).split('|').slice(1).find(p => p.startsWith(`${key}:`));
  return t ? t.slice(key.length + 1) : '';
};
const same = (a, b) => a != null && b != null && String(a) !== '' && String(a) === String(b);
const jidNum = (j) => String(j || '').split(':')[0].split('@')[0];

/** Message-level endpoint params; never part of a fresh DM address. */
export const MESSAGE_LEVEL_KEYS = new Set(['msg', 'req', 'replyKey', 'root', 'parent', 'thread']);

/**
 * Drop message-level params so the notice is a new DM rather than a reply /
 * thread post on an old message (telegram msg → reply_to, LINE stale replyKey,
 * lark markTypingDone on msg, discord req correlation). Routing params kept:
 * type (lark/feishu/dingtalk/wecom/whatsapp/slack), account+user (line),
 * user (ms-teams), to (wechat).
 */
export function stripMessageParams(endpoint) {
  const parts = String(endpoint || '').split('|');
  return [parts[0], ...parts.slice(1).filter((p) => {
    const i = p.indexOf(':');
    return !(i > 0 && MESSAGE_LEVEL_KEYS.has(p.slice(0, i)));
  })].join('|');
}

// --- Component message-log proof (lark / feishu / slack / discord) ----------
// These endpoints carry only a chat id and the C4 content only a display name,
// so the sender is proven from the component's own per-message log: the C4
// endpoint's `msg:` id must appear in that log with the owner's user id.
//   lark/feishu: components/<ch>/logs/<sender user_id>.log (p2p logs are keyed
//                by sender; threads: <uid>_t_<thread>.log), JSONL
//                {message_id, user_id, open_id}. Group logs are keyed by
//                chat id (`oc_…`). Without the app's "get user ID" permission
//                the sender user_id is empty and p2p logs land in
//                `undefined.log` / `null.log` / `.log`; an owner bound before
//                the permission was granted has only open_id. So when the
//                owner-named files hold no proof, every other `*.log` that is
//                neither a group log (`oc_…`) nor a PM2 process log
//                (LARK_PM2_LOG_RE: the components' ecosystem.config.cjs put
//                PM2's out.log / error.log in the same dir) is searched for
//                the msg id (newest LARK_FALLBACK_MAX_FILES,
//                LARK_FALLBACK_TAIL_BYTES tail each) — the entry's user_id /
//                open_id must still match the bound owner.
//   slack:       components/slack/logs/<channel id>.log, JSONL {userId, ts}
//   discord:     components/discord/logs/dm/<channel id>.jsonl, JSONL
//                {direction:'in', userId, messageId}
// No `msg:` / no log entry / different sender → not the owner (skip).

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const safeName = (s, fallback = '') => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_') || fallback;

/** Fallback scan bounds for lark/feishu (see above). */
export const LARK_FALLBACK_MAX_FILES = 64;
export const LARK_FALLBACK_TAIL_BYTES = 512 * 1024;

function readTail(file, memo, maxBytes = LOG_TAIL_BYTES) {
  const key = maxBytes === LOG_TAIL_BYTES ? file : `${file}#${maxBytes}`;
  if (memo?.has(key)) return memo.get(key);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { text = ''; }
  memo?.set(key, text);
  return text;
}

/**
 * Call visit(entry) for every JSON object line containing `needle` (files
 * whose tail lacks the needle are skipped); stops when visit returns true.
 * Malformed lines are ignored.
 */
function scanEntries(files, needle, visit, memo, maxBytes = LOG_TAIL_BYTES) {
  for (const f of files) {
    const text = readTail(f, memo, maxBytes);
    if (!text || !text.includes(needle)) continue;
    for (const line of text.split('\n')) {
      if (!line.includes(needle)) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e && typeof e === 'object' && !Array.isArray(e) && visit(e)) return true;
    }
  }
  return false;
}

function logHasEntry(files, needle, pred, memo) {
  return scanEntries(files, needle, (e) => { try { return !!pred(e); } catch { return false; } }, memo);
}

function listLogs(dir, prefixes, memo) {
  const key = `ls:${dir}`;
  let names = memo?.get(key);
  if (!names) {
    try { names = fs.readdirSync(dir); } catch { names = []; }
    memo?.set(key, names);
  }
  return names.filter(n => prefixes.some(p => n === `${p}.log` || n.startsWith(`${p}_t_`)))
    .map(n => path.join(dir, n));
}

/** Lark / Feishu group chat ids (`oc_…`) name the group logs; never owner-DM evidence. */
const LARK_GROUP_LOG_PREFIX = 'oc_';

/**
 * PM2 process logs of zylos-lark / zylos-feishu (ecosystem.config.cjs:
 * out_file / error_file = components/<ch>/logs/{out,error}.log) and their
 * PM2 / pm2-logrotate variants (`out-0.log`, `error-1.log`,
 * `out__2026-11-19_00-00-00.log`, `error.1.log`; compressed `.gz` files are
 * not `*.log`). Never message logs. A denylist rather than an allowlist of
 * sender-id shapes: lark user_ids are tenant-defined (employee ids), so no
 * reliable name shape exists. A user whose user_id is literally `out` /
 * `error` / `err` / `combined` is only found by the owner-named fast path
 * (false negative only).
 */
export const LARK_PM2_LOG_RE = /^(?:out|error|err|combined)(?:[-_.].*)?\.log$/;

/**
 * Candidate p2p logs for the fallback: `*.log` not named by a group chat id
 * and not a PM2 process log, newest first (mtime), at most LARK_FALLBACK_MAX_FILES.
 */
function listLarkP2pLogs(dir, memo) {
  const key = `p2p:${dir}`;
  if (memo?.has(key)) return memo.get(key);
  let names;
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const files = [];
  for (const n of names) {
    if (!n.endsWith('.log') || n.startsWith(LARK_GROUP_LOG_PREFIX) || LARK_PM2_LOG_RE.test(n)) continue;
    const f = path.join(dir, n);
    try {
      const st = fs.statSync(f);
      if (st.isFile()) files.push({ f, t: st.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => b.t - a.t);
  const out = files.slice(0, LARK_FALLBACK_MAX_FILES).map(x => x.f);
  memo?.set(key, out);
  return out;
}

const idOf = (v) => (typeof v === 'string' || typeof v === 'number') && String(v) !== '' ? String(v) : '';

/**
 * Lark / Feishu owner verdict for a p2p endpoint: 'owner' | 'not_owner' |
 * 'unverifiable'. 'owner' needs positive evidence: the endpoint's msg id in a
 * p2p log entry whose user_id / open_id equals the bound owner's. Owner-named
 * logs first (fast path), then the other p2p logs (never `oc_…` group logs
 * or PM2 logs). user_id is only compared with user_id, open_id with open_id.
 * 'unverifiable' only when the binding is usable (bound, with a user_id or
 * open_id) AND the msg's log entry was found AND none of its entries carries
 * any sender id at all (neither user_id nor open_id) — nothing to compare,
 * e.g. the app lacks the "get user ID" permission. A missing / incomplete
 * binding, any entry with a sender id that is not the owner's (even of the
 * type the binding lacks), a missing msg → 'not_owner', so everyone else
 * keeps the fixed reply.
 */
export function larkLikeOwnerVerdict(channel, ep, c, { componentsDir = DEFAULT_COMPONENTS_DIR, memo = new Map() } = {}) {
  const owner = c && typeof c === 'object' && c.owner && typeof c.owner === 'object' ? c.owner : null;
  const uid = idOf(owner?.user_id);
  const oid = idOf(owner?.open_id);
  if (!owner?.bound || (!uid && !oid)) return 'not_owner';
  const msg = token(ep, 'msg');
  if (!msg) return 'not_owner';
  const isOwner = (e) => (uid !== '' && same(e.user_id, uid)) || (oid !== '' && same(e.open_id, oid));
  const dir = path.join(componentsDir, channel, 'logs');
  const prefixes = [uid, oid].filter(Boolean).map(x => safeName(x));
  if (logHasEntry(listLogs(dir, prefixes, memo), msg, (e) => e.message_id === msg && isOwner(e), memo)) return 'owner';
  let withId = false;
  let withoutId = false;
  const found = scanEntries(listLarkP2pLogs(dir, memo), msg, (e) => {
    if (e.message_id !== msg) return false;
    if (isOwner(e)) return true;
    if (idOf(e.user_id) || idOf(e.open_id)) withId = true;
    else withoutId = true;
    return false;
  }, memo, LARK_FALLBACK_TAIL_BYTES);
  if (found) return 'owner';
  return withoutId && !withId ? 'unverifiable' : 'not_owner';
}

const larkLikeProof = (channel) => (ep, c, opts) => larkLikeOwnerVerdict(channel, ep, c, opts) === 'owner';

/**
 * Per-channel owner attribution (positive evidence only), verified against
 * each component's endpoint builder + persisted data. wechat has no owner
 * binding: accepted only when dmPolicy=allowlist names exactly one user and the
 * row is that user.
 */
export const OWNER_MATCHERS = {
  telegram: (ep, c) => same(firstSeg(ep), c.owner?.chat_id),
  dingtalk: (ep, c) => same(firstSeg(ep), c.owner?.staff_id),
  wecom: (ep, c) => same(firstSeg(ep), c.owner?.user_id),
  zalo: (ep, c) => same(firstSeg(ep), c.owner?.user_id),
  'whatsapp-business': (ep, c) => same(firstSeg(ep), c.owner?.wa_id),
  whatsapp: (ep, c) => !!c.owner?.jid && same(jidNum(firstSeg(ep)), jidNum(c.owner.jid)),
  line: (ep, c) => same(token(ep, 'user'), c.owner?.userId),
  'ms-teams': (ep, c) => same(token(ep, 'user'), c.owner?.aadObjectId),
  lark: larkLikeProof('lark'),
  feishu: larkLikeProof('feishu'),
  slack: (ep, c, { componentsDir, memo }) => {
    const msg = token(ep, 'msg');
    const uid = c.owner?.user_id;
    if (!c.owner?.bound || !uid || !msg) return false;
    const file = path.join(componentsDir, 'slack', 'logs', `${safeName(firstSeg(ep))}.log`);
    return logHasEntry([file], msg, (e) => String(e.ts) === msg && same(e.userId, uid), memo);
  },
  discord: (ep, c, { componentsDir, memo }) => {
    const msg = token(ep, 'msg');
    const owner = typeof c.owner === 'string' || typeof c.owner === 'number' ? String(c.owner) : '';
    if (!owner || !msg) return false;
    const file = path.join(componentsDir, 'discord', 'logs', 'dm', `${safeName(firstSeg(ep), 'unknown')}.jsonl`);
    return logHasEntry([file], msg, (e) => e.direction === 'in' && String(e.messageId) === msg && same(e.userId, owner), memo);
  },
  wechat: (ep, c) => c.dmPolicy === 'allowlist' && Array.isArray(c.dmAllowFrom)
    && c.dmAllowFrom.length === 1 && same(token(ep, 'to'), c.dmAllowFrom[0]),
};

/** Whether a DM endpoint is attributable to the channel's bound owner. */
export function isOwnerAttributed(channel, endpoint, cfg, { componentsDir = DEFAULT_COMPONENTS_DIR, memo = new Map() } = {}) {
  const m = OWNER_MATCHERS[String(channel || '').toLowerCase()];
  if (!m || !cfg || typeof cfg !== 'object' || !endpoint) return false;
  try { return !!m(String(endpoint), cfg, { componentsDir, memo }); } catch { return false; }
}

/**
 * Pick the newest owner-DM row from rows ordered newest-first. A row must be a
 * DM (isOwnerDmEndpoint) AND attributable to the channel owner. Returns
 * { channel, source (raw C4 endpoint), endpoint (stripped send address), at, id }.
 */
export function selectOwnerDm(rows, loadConfig = loadChannelConfig, { componentsDir = DEFAULT_COMPONENTS_DIR } = {}) {
  const cfgs = new Map();
  const memo = new Map();
  const cfgOf = (ch) => {
    if (!cfgs.has(ch)) cfgs.set(ch, loadConfig(ch));
    return cfgs.get(ch);
  };
  for (const r of rows || []) {
    const channel = r.channel;
    const endpoint = r.endpoint_id ?? r.endpoint;
    if (isOwnerDmEndpoint(channel, endpoint, r.content)
      && isOwnerAttributed(channel, endpoint, cfgOf(String(channel).toLowerCase()), { componentsDir, memo })) {
      const hit = { channel, source: endpoint, endpoint: stripMessageParams(endpoint), at: r.timestamp || r.at || null, id: r.id ?? null };
      const prefix = CONTENT_PREFIX[String(channel).toLowerCase()];
      if (prefix) hit.content = prefix;
      return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C4 read + persisted cache
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
let c4ReadWarned = false;
/** Test hook: re-arm the one-time "cannot read C4" warning. */
export function _resetC4ReadWarning() { c4ReadWarned = false; }

function c4Sql(limit) {
  // Only constants + a validated integer are interpolated (no user input), so
  // the same text is safe for the sqlite3 CLI, which has no bind parameters.
  const excluded = [...EXCLUDED_CHANNELS].map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const n = Math.max(1, Math.min(10000, Number.parseInt(limit, 10) || SCAN_LIMIT));
  return `SELECT id, channel, endpoint_id, timestamp, substr(content, 1, 32) AS content FROM conversations
    WHERE direction = 'in' AND endpoint_id IS NOT NULL AND channel NOT IN (${excluded})
    ORDER BY id DESC LIMIT ${n}`;
}

async function readViaNodeSqlite(dbPath, sql) {
  const { DatabaseSync } = await import('node:sqlite'); // Node >= 22.13 (unflagged)
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { try { db.close(); } catch {} }
}

/**
 * better-sqlite3 resolved from the comm-bridge's own install (never a plugin
 * dependency). Read-only, fileMustExist.
 */
export async function readViaCommBridgeBetterSqlite(dbPath, sql, { commBridgeDir = DEFAULT_COMM_BRIDGE_DIR } = {}) {
  const req = createRequire(path.join(commBridgeDir, 'scripts', 'c4-db.js'));
  const Database = req('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(); } finally { try { db.close(); } catch {} }
}

async function readViaSqliteCli(dbPath, sql, bin = 'sqlite3') {
  const { stdout } = await execFileP(bin, ['-readonly', '-json', dbPath, sql], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const out = String(stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

/**
 * Newest-first inbound rows from C4 sqlite. Tries built-in node:sqlite, then
 * better-sqlite3 from the comm-bridge install, then the sqlite3 CLI (read-only,
 * 5s timeout). If neither works, warns once and
 * returns [] (the persisted cache is then the only source).
 */
export async function readC4InboundRows(dbPath = DEFAULT_C4_DB, limit = SCAN_LIMIT, {
  warn = (m) => console.warn(m), sqliteBin = 'sqlite3', nodeSqlite = readViaNodeSqlite,
  betterSqlite = readViaCommBridgeBetterSqlite,
} = {}) {
  if (!fs.existsSync(dbPath)) return [];
  const sql = c4Sql(limit);
  const errors = [];
  try { return await nodeSqlite(dbPath, sql); } catch (e) { errors.push(`node:sqlite: ${e.code || e.message}`); }
  try { return await betterSqlite(dbPath, sql); } catch (e) { errors.push(`better-sqlite3: ${e.code || e.message}`); }
  try { return await readViaSqliteCli(dbPath, sql, sqliteBin); } catch (e) { errors.push(`sqlite3 CLI: ${e.code || e.message}`); }
  if (!c4ReadWarned) {
    c4ReadWarned = true;
    warn(`[im-owner-notice] cannot read C4 (${errors.join('; ')}); owner IM address falls back to cache only — install sqlite3 or use Node >= 22.13`);
  }
  return [];
}

/** A value for a C4 SQL string literal: quotes doubled; NUL / CR / LF refused. */
function sqlText(v) {
  const s = String(v);
  if (/[\0\r\n]/.test(s)) throw new Error('C4 query value has a control character');
  return `'${s.replace(/'/g, "''")}'`;
}

/** epoch ms → C4's "YYYY-MM-DD HH:MM:SS" (UTC, CURRENT_TIMESTAMP). */
export function c4TimestampText(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Inbound C4 rows of ONE chat, oldest first, with their FULL content (no
 * substr): `channel` exactly, `endpoint_id` = `chatId` or starting with
 * `chatId|` (the caller compares the rest of the endpoint), and — when given
 * — `endpoint` exactly, `timestamp` in [sinceMs, untilMs] (to the second, C4's
 * resolution), `id` > `afterId`. `newest: true` returns the newest `limit`
 * rows newest first instead. The values are quoted SQL literals (the sqlite3
 * CLI has no bind parameters); the channel must look like a channel name.
 * Unlike readC4InboundRows a read failure THROWS (the caller fails closed).
 */
export async function readC4ChatRows(dbPath = DEFAULT_C4_DB, {
  channel, chatId, endpoint, sinceMs, untilMs, afterId, limit = 1000, newest = false,
} = {}, {
  sqliteBin = 'sqlite3', nodeSqlite = readViaNodeSqlite, betterSqlite = readViaCommBridgeBetterSqlite,
} = {}) {
  const ch = String(channel ?? '');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(ch)) throw new Error('C4 chat query: invalid channel');
  const chat = String(chatId ?? '');
  if (!chat) throw new Error('C4 chat query: chatId is required');
  if (!fs.existsSync(dbPath)) throw new Error('C4 chat query: no C4 database');
  const where = [
    "direction = 'in'",
    `channel = ${sqlText(ch)}`,
    // "chat|…" exactly: '|' (0x7C) and '}' (0x7D) are adjacent, so under the
    // default BINARY collation this range is the prefix match (index-friendly).
    `(endpoint_id = ${sqlText(chat)} OR (endpoint_id >= ${sqlText(`${chat}|`)} AND endpoint_id < ${sqlText(`${chat}}`)}))`,
  ];
  if (endpoint !== undefined) where.push(`endpoint_id = ${sqlText(endpoint)}`);
  if (Number.isFinite(sinceMs)) where.push(`timestamp >= ${sqlText(c4TimestampText(Math.floor(sinceMs / 1000) * 1000))}`);
  if (Number.isFinite(untilMs)) where.push(`timestamp <= ${sqlText(c4TimestampText(untilMs))}`);
  if (Number.isInteger(afterId)) where.push(`id > ${afterId}`);
  const n = Math.max(1, Math.min(10000, Number.parseInt(limit, 10) || 1000));
  const sql = `SELECT id, channel, endpoint_id, timestamp, content FROM conversations
    WHERE ${where.join(' AND ')} ORDER BY id ${newest ? 'DESC' : 'ASC'} LIMIT ${n}`;
  const errors = [];
  try { return await nodeSqlite(dbPath, sql); } catch (e) { errors.push(`node:sqlite: ${e.code || e.message}`); }
  try { return await betterSqlite(dbPath, sql); } catch (e) { errors.push(`better-sqlite3: ${e.code || e.message}`); }
  try { return await readViaSqliteCli(dbPath, sql, sqliteBin); } catch (e) { errors.push(`sqlite3 CLI: ${e.code || e.message}`); }
  throw new Error(`cannot read C4 (${errors.join('; ')})`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readCachedEndpoint(cacheFile = DEFAULT_CACHE_FILE, loadConfig = loadChannelConfig, { componentsDir = DEFAULT_COMPONENTS_DIR } = {}) {
  const c = readJson(cacheFile);
  if (!c || !c.channel) return null;
  // Re-attribute on read from the original C4 endpoint: the owner binding may
  // have changed since. Entries without `source` (older format) re-attribute
  // from `endpoint` and fail closed for log-proof channels.
  const source = c.source || c.endpoint;
  if (isOwnerDmEndpoint(c.channel, source, c.content)
    && isOwnerAttributed(c.channel, source, loadConfig(String(c.channel).toLowerCase()), { componentsDir })) {
    return { ...c, source, endpoint: stripMessageParams(source) };
  }
  return null;
}

/**
 * Refresh the persisted cache from C4. Returns the best known address
 * (fresh C4 hit, else the persisted one), or null.
 */
export async function refreshOwnerEndpoint({
  dbPath = DEFAULT_C4_DB,
  cacheFile = DEFAULT_CACHE_FILE,
  readRows = readC4InboundRows,
  loadConfig = loadChannelConfig,
  componentsDir = DEFAULT_COMPONENTS_DIR,
} = {}) {
  const fresh = selectOwnerDm(await readRows(dbPath), loadConfig, { componentsDir });
  if (fresh) {
    const entry = { channel: fresh.channel, endpoint: fresh.endpoint, source: fresh.source, at: fresh.at };
    // Content-detected channels (discord/zalo) keep the prefix so the cached
    // entry still validates without the C4 row.
    if (fresh.content) entry.content = fresh.content;
    const prev = readJson(cacheFile);
    if (!prev || prev.channel !== entry.channel || prev.source !== entry.source || prev.at !== entry.at) {
      try { writeJsonAtomic(cacheFile, entry); } catch {}
    }
    return entry;
  }
  return readCachedEndpoint(cacheFile, loadConfig, { componentsDir });
}

// ---------------------------------------------------------------------------
// Dedup (bounded, persisted)
// ---------------------------------------------------------------------------

/**
 * Persisted per-event_id state. An id is "done" once it was sent (or is
 * unrecoverable); until then each delivery counts one attempt, so a failed
 * send is retried on a later delivery of the same event, up to MAX_ATTEMPTS.
 * File: { done: [ids], attempts: { id: n } } (legacy: plain array of done ids).
 */
export function createDedup({ file = DEFAULT_DEDUP_FILE, max = DEDUP_MAX } = {}) {
  const loaded = readJson(file);
  const doneList = (Array.isArray(loaded) ? loaded : Array.isArray(loaded?.done) ? loaded.done : [])
    .filter(x => typeof x === 'string').slice(-max);
  const done = new Set(doneList);
  const attempts = new Map(Object.entries(loaded && !Array.isArray(loaded) && typeof loaded.attempts === 'object' && loaded.attempts ? loaded.attempts : {})
    .filter(([, n]) => Number.isInteger(n) && n > 0).slice(-max));
  const persist = () => {
    try { writeJsonAtomic(file, { done: doneList, attempts: Object.fromEntries(attempts) }); } catch {}
  };
  return {
    has: (id) => done.has(id),
    attempts: (id) => attempts.get(id) || 0,
    /** Count one attempt; returns the new count. */
    attempt(id) {
      const n = (attempts.get(id) || 0) + 1;
      attempts.delete(id);
      attempts.set(id, n);
      while (attempts.size > max) attempts.delete(attempts.keys().next().value);
      persist();
      return n;
    },
    add(id) {
      attempts.delete(id);
      if (!done.has(id)) {
        done.add(id);
        doneList.push(id);
        while (doneList.length > max) done.delete(doneList.shift());
      }
      persist();
    },
  };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** Send `text` via c4-send.js; resolves true on exit code 0. */
export function c4Send(channel, endpoint, text, { script = DEFAULT_C4_SEND, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, channel, endpoint], { timeout: timeoutMs },
      (err) => resolve(!err));
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  });
}

/** event_ids currently being handled in this process (incl. pending retries). */
const inFlight = new Set();
/** Test hook. */
export function _resetInFlight() { inFlight.clear(); }

/**
 * Handle one im_owner_notice systemEvent. Never throws.
 * Returns the outcome of the first attempt: 'sent' | 'no_address' | 'failed' |
 * 'duplicate' | 'in_flight' | 'invalid' | 'gave_up'.
 *
 * The upstream push is fire-and-forget (no redelivery on a local failure), so
 * a 'failed' / 'no_address' attempt is retried locally with in-process timers
 * (RETRY_DELAYS_MS: 30s, then 2min) up to maxAttempts in total, then given up
 * with a log. Attempts are persisted, so a redelivery after a restart
 * continues the count; a restart drops pending retry timers (accepted — the
 * persisted done set is checked before every attempt, so nothing is sent
 * twice). The event stays owned by the retry (in-flight) until final
 * success / give-up. The comm-bridge is a single process, so an in-memory
 * in-flight set prevents concurrent duplicate deliveries from sending twice.
 */
export async function handleImOwnerNotice(se, {
  dedup,
  resolveEndpoint = () => refreshOwnerEndpoint(),
  send = c4Send,
  log = () => {},
  warn = () => {},
  maxAttempts = MAX_ATTEMPTS,
  retryDelaysMs = RETRY_DELAYS_MS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
} = {}) {
  const eventId = se?.event_id ? String(se.event_id) : '';
  const text = typeof se?.text === 'string' ? se.text.trim() : '';
  if (!eventId) {
    warn('[im-owner-notice] missing event_id, ignored');
    return 'invalid';
  }
  if (dedup?.has(eventId)) {
    log(`[im-owner-notice] duplicate event_id=${eventId}, skipped`);
    return 'duplicate';
  }
  if (inFlight.has(eventId)) {
    log(`[im-owner-notice] event_id=${eventId} already in flight, skipped`);
    return 'in_flight';
  }
  if (!text) {
    dedup?.add(eventId);
    warn(`[im-owner-notice] event_id=${eventId} empty text, ignored`);
    return 'invalid';
  }
  inFlight.add(eventId); // synchronous claim before the first await

  const run = async () => {
    try {
      if (dedup?.has(eventId)) { // sent meanwhile (checked before every attempt)
        inFlight.delete(eventId);
        return 'duplicate';
      }
      if (dedup && dedup.attempts(eventId) >= maxAttempts) {
        dedup.add(eventId);
        inFlight.delete(eventId);
        warn(`[im-owner-notice] event_id=${eventId} status=gave_up after ${maxAttempts} attempts`);
        return 'gave_up';
      }
      const attempt = dedup ? dedup.attempt(eventId) : 1;
      let status;
      let target = null;
      try { target = await resolveEndpoint(); } catch (e) { warn(`[im-owner-notice] resolve endpoint: ${e.message}`); }
      if (!target) {
        status = 'no_address';
      } else {
        let ok = false;
        try { ok = await send(target.channel, stripMessageParams(target.endpoint), text); } catch { ok = false; }
        status = ok ? 'sent' : 'failed';
      }
      log(`[im-owner-notice] event_id=${eventId} kind=${se.kind || '?'} status=${status} attempt=${attempt}/${maxAttempts}` +
        (target ? ` channel=${target.channel}` : ''));
      if (status === 'sent') {
        dedup?.add(eventId);
        inFlight.delete(eventId);
      } else if (attempt < maxAttempts) {
        const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
        setTimer(run, delay);
      } else {
        dedup?.add(eventId);
        inFlight.delete(eventId);
        warn(`[im-owner-notice] event_id=${eventId} status=gave_up after ${attempt} attempts (last=${status})`);
      }
      return status;
    } catch (e) {
      inFlight.delete(eventId);
      warn(`[im-owner-notice] event_id=${eventId} error: ${e.message}`);
      return 'failed';
    }
  };
  return run();
}
