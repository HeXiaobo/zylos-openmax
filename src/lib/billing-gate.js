/**
 * Initiator gate for the read-only billing answers (OPENM-1375,
 * workspace-backlog#817).
 *
 * The Agent's own token can read the org's billing numbers (cws-core lets any
 * org member read plan-state / credit-statement), so WHO ASKED is decided here,
 * in the component, before any billing request is made. Only an org Owner
 * (`org-owner`) or admin (`org-admin`) gets numbers; everyone else gets
 * DENIED_REPLY and no billing request is sent at all.
 *
 * Two initiator sources:
 *
 *  1. Workspace (OpenMax) message — `{conversationId, messageId}` copied from
 *     the inbound `<message-context conversation-id source-message-id>`.
 *     The message is fetched SERVER-SIDE (GET /conversations/{id}/messages/{id};
 *     cws-comm sets sender_id / sender_type from the authenticated principal,
 *     and only lets the Agent read conversations it can read), then the sender
 *     member is looked up (GET /members/{id}) for kind / status / role. A
 *     member id, name or role claimed in the call itself is never used. DMs and
 *     group chats both pass when the sender is an active human Owner/admin.
 *
 *  2. External IM channel (lark, feishu, telegram, …) — `{channel, endpoint}`,
 *     both copied verbatim from the inbound `reply via: … c4-send.js "<channel>"
 *     "<endpoint>"` line (product decision d159, option B). Answered ONLY in a
 *     private chat AND only when the asker is this Agent's bound owner on that
 *     channel, decided exactly like cws-agent-ops `ownerdm.go` (itself a port
 *     of this plugin's im-owner-notice.js, tested against shared vectors):
 *       a. the endpoint is a DM — isOwnerDmEndpoint (lark/feishu/dingtalk/
 *          wecom/whatsapp `type:p2p`; slack/line/ms-teams/whatsapp-business
 *          `type:dm`; telegram positive chat id; wechat `|to:`; discord/zalo
 *          the C4 row's content prefix; `type:dm-pairing` and internal
 *          channels never);
 *       b. the endpoint is a real inbound C4 row of that channel, at most
 *          SOURCE_MESSAGE_MAX_AGE_MS old (ownerdm only ever evaluates C4 rows);
 *       c. the DM is POSITIVELY attributable to the channel's bound owner —
 *          isOwnerAttributed against components/<channel>/config.json `owner.*`
 *          (+ the component's own message log for lark/feishu/slack/discord;
 *          wechat: the QR-scanner rule of ownerdm.go wechatOwner, else the
 *          single-user allowlist rule).
 *     lark / feishu owner proof also searches the other p2p logs (never
 *     `oc_…` group logs, never PM2 logs) for the msg id, so an app without
 *     the "get user ID" permission (`null.log` / `undefined.log`) or an
 *     open_id-only binding still proves the owner; a usable binding + a found
 *     entry with no sender id at all → reason owner_unverifiable
 *     (OWNER_UNVERIFIABLE_REPLY); a missing / incomplete binding is
 *     asker_not_agent_owner like any other non-owner.
 *     Group chats (the owner asking in a group included), anyone else, a
 *     missing / unrecognisable endpoint → EXTERNAL_REDIRECT_REPLY, no request
 *     at all. Then, server-side, the Agent's Workspace owner (GET /members/{self}
 *     → owner_member_id → GET /members/{owner}) must be an active human
 *     Owner/admin. A self-declared `askerIsAgentOwner` is no longer read.
 *     Extension point: TRUSTED_CHANNEL_SENDER_RESOLVERS — once a channel
 *     component writes a trusted, server-mappable sender id, register a
 *     resolver here and it replaces step c (the DM-only rule still applies).
 *
 * Missing, malformed or unverifiable input always means DENIED (fail closed).
 *
 * `requirement: 'agent_owner'` (conn.confirm_config loosening, OPENM-1239): the
 * asker must be THIS Agent's own owner instead of an org Owner/admin. Only the
 * Workspace form is accepted; the source message is checked exactly as above,
 * then the Agent's owner is read SERVER-SIDE (GET /members/{self} →
 * owner_member_id — the same authoritative record comm-bridge's owner sync
 * reads; the local `orgs.<slug>.owner` cache is not trusted) and must equal the
 * message's sender_id; the sender must be an active human member. Any
 * external IM initiator → reason external_channel_refused (no owner-DM
 * exception). A lookup that could not be made → verification_unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_MESSAGE_ID_RE } from './activity/constants.js';
import {
  DEFAULT_C4_DB, DEFAULT_COMPONENTS_DIR, isOwnerAttributed, isOwnerDmEndpoint, larkLikeOwnerVerdict, loadChannelConfig,
  readC4InboundRows,
} from './im-owner-notice.js';

export const ALLOWED_ROLES = new Set(['org-owner', 'org-admin']);

/** Max age of a Workspace source message; an older one is not accepted as the ask. */
export const SOURCE_MESSAGE_MAX_AGE_MS = 30 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const WORKSPACE_CHANNELS = new Set(['openmax', 'workspace']);
/** Internal C4 channels with no human asker behind them. */
const NON_HUMAN_CHANNELS = new Set(['scheduler', 'system']);

export const UNAVAILABLE_REPLY = '身份核验暂时不可用，请稍后再试。\n'
  + 'The identity check is temporarily unavailable, please try again later.';

/**
 * External channel, not the bound owner's private chat (d159 option B): the
 * fixed reply, Chinese text exactly as decided.
 */
export const EXTERNAL_REDIRECT_REPLY = '这类信息请到 Workspace 里问我，或找组织管理员\n'
  + 'For this information, please ask me in Workspace, or ask an org admin.';

/**
 * lark / feishu private chat whose sender cannot be compared with the owner
 * binding (reason owner_unverifiable): the binding is usable but the message's
 * log entry has neither user_id nor open_id (app lacks the "get user ID"
 * permission). Reveals no config values.
 */
export const OWNER_UNVERIFIABLE_REPLY = '无法确认你是这个 Agent 的主人：飞书 / Lark 应用可能未开通获取用户 ID 权限，或主人绑定信息不完整。'
  + '可以先到 Workspace 里问我，或找组织管理员。\n'
  + "I can't confirm that you are this Agent's owner: the Feishu / Lark app may not have the permission to get user IDs, "
  + 'or the owner binding is incomplete. You can ask me in Workspace for now, or ask an org admin.';

export const DENIED_REPLY = '这类信息请联系组织管理员（Owner 或管理员）查看。\n'
  + 'Please ask an org admin (Owner or admin) for this information.';

/**
 * Future hook: channel → async (params, ctx) => { member_id } | null, for
 * channels whose component supplies a trusted sender id that maps to a
 * Workspace member. Empty in phase 1 (no IM ↔ member mapping exists).
 */
export const TRUSTED_CHANNEL_SENDER_RESOLVERS = Object.freeze({});

const deny = (reason, extra = {}) => ({ allowed: false, reason, ...extra });

function roleSlug(member) {
  const r = member?.role;
  if (typeof r === 'string') return r;
  if (r && typeof r.slug === 'string') return r.slug;
  return typeof member?.role_slug === 'string' ? member.role_slug : '';
}

/** Allowed only for an active human member (no role requirement). */
export function checkActiveHuman(member) {
  if (!member || typeof member !== 'object') return deny('member_not_found');
  if (member.kind !== 'human') return deny('initiator_not_human');
  if (member.status !== undefined && member.status !== 'active') return deny('initiator_not_active');
  return { allowed: true };
}

/** Allowed only for an active human member whose role is org-owner / org-admin. */
export function checkMemberRole(member) {
  const human = checkActiveHuman(member);
  if (!human.allowed) return human;
  const role = roleSlug(member);
  if (!ALLOWED_ROLES.has(role)) return deny('initiator_not_admin', { role: role || null });
  return { allowed: true, role };
}

/**
 * 403 / 404 are answers ("no such member / not readable"); anything else —
 * 5xx, timeout, network, an unresolved org — means the check could not be
 * made. Both deny, but the latter must not read as "you lack permission".
 */
export function isDefinitiveDenial(err) {
  return err?.status === 403 || err?.status === 404;
}

const unavailable = (err, extra = {}) => deny('verification_unavailable', {
  status: Number.isInteger(err?.status) ? err.status : null, ...extra,
});

/** { member } | { error } — error set only when the lookup could not be made. */
async function fetchMember(get, memberId) {
  if (typeof memberId !== 'string' || !UUID_RE.test(memberId)) return { member: null };
  try { return { member: await get(`/members/${memberId}`) }; } catch (err) {
    return isDefinitiveDenial(err) ? { member: null } : { error: err };
  }
}

async function memberVerdict(get, memberId, extra) {
  const { member, error } = await fetchMember(get, memberId);
  if (error) return { verdict: unavailable(error, extra), member: null };
  return { verdict: checkMemberRole(member), member };
}

function messageTime(msg) {
  for (const v of [msg?.timestamp, msg?.created_at]) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return NaN;
}

/**
 * requirement 'agent_owner': the sender must be the Agent's owner as cws-core
 * records it (GET /members/{self}.owner_member_id), compared by member id.
 */
async function agentOwnerVerdict(get, senderId, selfMemberId, extra) {
  let self = '';
  try { self = await selfMemberId(); } catch (err) {
    if (!isDefinitiveDenial(err)) return unavailable(err, extra);
    self = '';
  }
  const selfLookup = await fetchMember(get, self);
  if (selfLookup.error) return unavailable(selfLookup.error, extra);
  const ownerId = selfLookup.member?.owner_member_id;
  if (typeof ownerId !== 'string' || !ownerId) return deny('agent_owner_unknown', extra);
  if (typeof senderId !== 'string' || senderId.toLowerCase() !== ownerId.toLowerCase()) {
    return deny('initiator_not_agent_owner', extra);
  }
  const { member, error } = await fetchMember(get, senderId);
  if (error) return unavailable(error, extra);
  const v = checkActiveHuman(member);
  if (!v.allowed) return { ...v, ...extra };
  return { allowed: true, ...extra, agent_owner: true, initiator_name: member.display_name || null };
}

async function gateWorkspace(params, { get, orgId, now, requireAgentOwner = false, selfMemberId }) {
  const cid = params.conversationId;
  const raw = params.messageId ?? params.sourceMessageId;
  const mid = Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
  if (typeof cid !== 'string' || !UUID_RE.test(cid)
      || typeof mid !== 'string' || !SOURCE_MESSAGE_ID_RE.test(mid)) {
    return deny('invalid_source_reference', { source: 'workspace' });
  }
  let res;
  try { res = await get(`/conversations/${cid}/messages/${mid}`); } catch (e) {
    if (!isDefinitiveDenial(e)) return unavailable(e, { source: 'workspace' });
    return deny('source_message_unreadable', { source: 'workspace', status: e.status });
  }
  const msg = res?.message ?? res;
  // cws-core reads the message by id only; the conversation is checked here.
  if (!msg || msg.conversation_id !== cid) return deny('source_message_not_in_conversation', { source: 'workspace' });
  if (orgId && msg.org_id && msg.org_id !== orgId) return deny('source_message_other_org', { source: 'workspace' });
  if (msg.recalled_by || msg.deleted_at) return deny('source_message_recalled', { source: 'workspace' });
  if (String(msg.sender_type || '').toUpperCase() !== 'HUMAN') return deny('initiator_not_human', { source: 'workspace' });
  const at = messageTime(msg);
  if (!Number.isFinite(at) || now - at > SOURCE_MESSAGE_MAX_AGE_MS) {
    return deny('source_message_too_old', { source: 'workspace', initiator_member_id: msg.sender_id || null });
  }
  if (requireAgentOwner) {
    return agentOwnerVerdict(get, msg.sender_id, selfMemberId, { source: 'workspace', initiator_member_id: msg.sender_id || null });
  }
  const { verdict, member } = await memberVerdict(get, msg.sender_id, { source: 'workspace' });
  return {
    ...verdict,
    source: 'workspace',
    initiator_member_id: msg.sender_id || null,
    ...(verdict.allowed ? { initiator_name: member.display_name || null } : {}),
  };
}

const MAX_ENDPOINT_LEN = 1024;
const WECHAT_ACCOUNT_RE = /^[A-Za-z0-9_-]+$/;

/** C4 `timestamp` is SQLite CURRENT_TIMESTAMP: UTC "YYYY-MM-DD HH:MM:SS". */
function c4Time(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

/**
 * ownerdm.go wechatOwner (cws-agent-ops#18): when <account>.runtime.json is
 * usable, only the QR-scanner rule applies (credentials file present, `to:` =
 * scanner userId); otherwise null → the allowlist rule of isOwnerAttributed.
 */
function wechatScannerVerdict(endpoint, componentsDir) {
  const first = endpoint.split('|')[0];
  if (!WECHAT_ACCOUNT_RE.test(first)) return null;
  const accounts = path.join(componentsDir, 'wechat', 'accounts');
  let rt;
  try { rt = JSON.parse(fs.readFileSync(path.join(accounts, `${first}.runtime.json`), 'utf8')); } catch { return null; }
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) return null;
  if (typeof rt.userId !== 'string' || !rt.userId) return null;
  if (Object.hasOwn(rt, 'normalizedAccountId') && rt.normalizedAccountId != null && rt.normalizedAccountId !== first) return null;
  if (!fs.existsSync(path.join(accounts, `${first}.json`))) return false;
  const to = endpoint.split('|').slice(1).find((p) => p.startsWith('to:'))?.slice(3) || '';
  return to !== '' && to === rt.userId;
}

const LARK_LIKE = new Set(['lark', 'feishu']);

/**
 * Owner verdict for a DM: 'owner' | 'not_owner' | 'unverifiable'.
 * 'owner' is exactly ownerdm.go ownerAttributed (positive evidence).
 * 'unverifiable' only for lark / feishu (larkLikeOwnerVerdict): usable owner
 * binding, but the message's log entry carries no sender id at all.
 */
export function channelOwnerDmVerdict(channel, endpoint, { componentsDir = DEFAULT_COMPONENTS_DIR, loadConfig } = {}) {
  if (channel === 'wechat') {
    const v = wechatScannerVerdict(endpoint, componentsDir);
    if (v !== null) return v ? 'owner' : 'not_owner';
  }
  const cfg = (loadConfig || ((ch) => loadChannelConfig(ch, componentsDir)))(channel);
  const memo = new Map(); // the second pass reuses the log reads of the first
  if (isOwnerAttributed(channel, endpoint, cfg, { componentsDir, memo })) return 'owner';
  if (!LARK_LIKE.has(channel)) return 'not_owner';
  try {
    return larkLikeOwnerVerdict(channel, endpoint, cfg, { componentsDir, memo }) === 'unverifiable' ? 'unverifiable' : 'not_owner';
  } catch { return 'not_owner'; }
}

/** ownerdm.go ownerAttributed: positive evidence that the DM is the bound owner's. */
export function isChannelOwnerDm(channel, endpoint, opts = {}) {
  return channelOwnerDmVerdict(channel, endpoint, opts) === 'owner';
}

const defaultImOwner = () => ({
  componentsDir: DEFAULT_COMPONENTS_DIR,
  readRows: () => readC4InboundRows(DEFAULT_C4_DB, undefined, { warn: () => {} }),
});

async function gateExternal(params, { get, selfMemberId, now, imOwner }) {
  const channel = String(params.channel).toLowerCase();
  const io = { ...defaultImOwner(), ...(imOwner || {}) };
  const ctx = { source: 'channel', channel };
  // Everything up to the owner proof is answered with the redirect reply.
  const redirect = (reason, extra = {}) => deny(reason, { ...ctx, redirect: true, ...extra });
  const endpoint = params.endpoint;
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LEN || /[\r\n]/.test(endpoint)) {
    return redirect('chat_type_unknown', { private_chat: false });
  }
  // a. DM by the endpoint alone (discord / zalo need the C4 row content → after b).
  const contentDm = channel === 'discord' || channel === 'zalo';
  if (!contentDm && !isOwnerDmEndpoint(channel, endpoint)) return redirect('not_private_chat', { private_chat: false });
  // b. a real, recent inbound C4 row on exactly this endpoint.
  let rows;
  try { rows = await io.readRows(); } catch { rows = []; }
  if (!Array.isArray(rows) || rows.length === 0) return unavailable(null, { ...ctx, check: 'c4_unreadable' });
  const row = rows.find((r) => String(r?.channel || '').toLowerCase() === channel && (r.endpoint_id ?? r.endpoint) === endpoint);
  if (!row) return redirect('source_message_not_found');
  if (contentDm && !isOwnerDmEndpoint(channel, endpoint, row.content)) return redirect('not_private_chat', { private_chat: false });
  const at = c4Time(row.timestamp);
  if (!Number.isFinite(at) || now - at > SOURCE_MESSAGE_MAX_AGE_MS) return redirect('source_message_too_old', { private_chat: true });
  // c. the DM is the bound owner's (or a trusted resolver's member id).
  const resolver = TRUSTED_CHANNEL_SENDER_RESOLVERS[channel];
  if (resolver) {
    let trusted = null;
    try { trusted = await resolver(params, { get }); } catch { trusted = null; }
    if (!trusted?.member_id) return redirect('initiator_unverified', { private_chat: true });
    const { verdict } = await memberVerdict(get, trusted.member_id, ctx);
    return { ...verdict, ...ctx, private_chat: true, initiator_member_id: trusted.member_id };
  }
  let ownerVerdict = 'not_owner';
  try {
    ownerVerdict = channelOwnerDmVerdict(channel, endpoint, { componentsDir: io.componentsDir, loadConfig: io.loadConfig });
  } catch { ownerVerdict = 'not_owner'; }
  if (ownerVerdict === 'unverifiable') return redirect('owner_unverifiable', { private_chat: true, asker_is_agent_owner: false });
  if (ownerVerdict !== 'owner') return redirect('asker_not_agent_owner', { private_chat: true, asker_is_agent_owner: false });
  const okCtx = { ...ctx, private_chat: true, asker_is_agent_owner: true };
  // Backend re-check: the Agent's Workspace owner must be an active Owner/admin.
  let self = null;
  try { self = await selfMemberId(); } catch (err) {
    if (!isDefinitiveDenial(err)) return unavailable(err, okCtx);
    self = null;
  }
  const selfLookup = await fetchMember(get, self);
  if (selfLookup.error) return unavailable(selfLookup.error, okCtx);
  const ownerId = selfLookup.member?.owner_member_id;
  if (!ownerId) return deny('agent_owner_unknown', okCtx);
  const { verdict, member: wsOwner } = await memberVerdict(get, ownerId, okCtx);
  return {
    ...verdict, ...okCtx, initiator_member_id: ownerId,
    ...(verdict.allowed ? { initiator_name: wsOwner.display_name || null } : {}),
  };
}

/**
 * Decide whether the asker may see billing numbers.
 * @param {object} params  CLI params (conversationId/messageId OR channel/endpoint)
 * @param {object} ctx     { get(path) → unwrapped data, orgId, selfMemberId() → id, now,
 *                           imOwner?: { readRows(), componentsDir, loadConfig(ch) } (tests),
 *                           requirement?: 'org_admin' (default) | 'agent_owner' }
 * @returns {Promise<{allowed:boolean, reason?:string, source?:string, role?:string, initiator_member_id?:string|null, ...}>}
 */
export async function checkInitiator(params, {
  get, orgId = '', selfMemberId = async () => '', now = Date.now(), imOwner, requirement = 'org_admin',
} = {}) {
  if (requirement !== 'org_admin' && requirement !== 'agent_owner') return deny('invalid_requirement');
  const requireAgentOwner = requirement === 'agent_owner';
  if (!params || typeof params !== 'object' || Array.isArray(params)) return deny('missing_initiator');
  const hasRef = params.conversationId !== undefined || params.messageId !== undefined || params.sourceMessageId !== undefined;
  const channel = params.channel === undefined ? '' : String(params.channel).toLowerCase();
  const external = channel !== '' && !WORKSPACE_CHANNELS.has(channel);
  if (channel && !CHANNEL_RE.test(channel)) return deny('invalid_channel');
  if (NON_HUMAN_CHANNELS.has(channel)) return deny('initiator_not_human', { source: 'channel', channel });
  // A Workspace ask is identified by its message, never by a self-declared flag.
  if (hasRef && external) return deny('ambiguous_initiator');
  if (!hasRef && (params.endpoint !== undefined || params.askerIsAgentOwner !== undefined) && !external) {
    return deny('workspace_requires_source_message', { source: 'workspace' });
  }
  try {
    if (hasRef) return await gateWorkspace(params, { get, orgId, now, requireAgentOwner, selfMemberId });
    if (external && requireAgentOwner) return deny('external_channel_refused', { source: 'channel', channel });
    if (external) return await gateExternal(params, { get, selfMemberId, now, imOwner });
  } catch {
    return deny('initiator_check_failed');
  }
  return deny('missing_initiator');
}
