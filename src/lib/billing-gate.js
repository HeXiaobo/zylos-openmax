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
 *  2. External IM channel (lark, feishu, telegram, …) — `{channel,
 *     askerIsAgentOwner: true}`. Channel events go straight to the Agent's
 *     process, so the platform cannot verify the IM sender; the Agent declares
 *     that the asker is its own owner on that channel (e.g. the channel
 *     component's bound owner). The gate then checks server-side that the
 *     Agent's Workspace owner (GET /members/{self} → owner_member_id →
 *     GET /members/{owner}) is an active human Owner/admin. Anything short of
 *     a literal `true` is "not the owner".
 *     Extension point: TRUSTED_CHANNEL_SENDER_RESOLVERS — once a channel
 *     component writes a trusted, server-mappable sender id, register a
 *     resolver here and it takes precedence over the self-declared flag.
 *
 * Missing, malformed or unverifiable input always means DENIED (fail closed).
 */

import { SOURCE_MESSAGE_ID_RE } from './activity/constants.js';

export const ALLOWED_ROLES = new Set(['org-owner', 'org-admin']);

/** Max age of a Workspace source message; an older one is not accepted as the ask. */
export const SOURCE_MESSAGE_MAX_AGE_MS = 30 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const WORKSPACE_CHANNELS = new Set(['openmax', 'workspace']);
/** Internal C4 channels with no human asker behind them. */
const NON_HUMAN_CHANNELS = new Set(['scheduler', 'system']);

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

/** Allowed only for an active human member whose role is org-owner / org-admin. */
export function checkMemberRole(member) {
  if (!member || typeof member !== 'object') return deny('member_not_found');
  if (member.kind !== 'human') return deny('initiator_not_human');
  if (member.status !== undefined && member.status !== 'active') return deny('initiator_not_active');
  const role = roleSlug(member);
  if (!ALLOWED_ROLES.has(role)) return deny('initiator_not_admin', { role: role || null });
  return { allowed: true, role };
}

async function fetchMember(get, memberId) {
  if (typeof memberId !== 'string' || !UUID_RE.test(memberId)) return null;
  try { return await get(`/members/${memberId}`); } catch { return null; }
}

function messageTime(msg) {
  for (const v of [msg?.timestamp, msg?.created_at]) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return NaN;
}

async function gateWorkspace(params, { get, orgId, now }) {
  const cid = params.conversationId;
  const raw = params.messageId ?? params.sourceMessageId;
  const mid = Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
  if (typeof cid !== 'string' || !UUID_RE.test(cid)
      || typeof mid !== 'string' || !SOURCE_MESSAGE_ID_RE.test(mid)) {
    return deny('invalid_source_reference', { source: 'workspace' });
  }
  let res;
  try { res = await get(`/conversations/${cid}/messages/${mid}`); } catch (e) {
    return deny('source_message_unreadable', { source: 'workspace', status: e?.status ?? null });
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
  const member = await fetchMember(get, msg.sender_id);
  const verdict = checkMemberRole(member);
  return {
    ...verdict,
    source: 'workspace',
    initiator_member_id: msg.sender_id || null,
    ...(verdict.allowed ? { initiator_name: member.display_name || null } : {}),
  };
}

async function gateExternal(params, { get, selfMemberId }) {
  const channel = String(params.channel).toLowerCase();
  const resolver = TRUSTED_CHANNEL_SENDER_RESOLVERS[channel];
  if (resolver) {
    let trusted = null;
    try { trusted = await resolver(params, { get }); } catch { trusted = null; }
    if (!trusted?.member_id) return deny('initiator_unverified', { source: 'channel', channel });
    const verdict = checkMemberRole(await fetchMember(get, trusted.member_id));
    return { ...verdict, source: 'channel', channel, initiator_member_id: trusted.member_id };
  }
  // Only the JSON boolean true counts; "true", 1, missing → not the owner.
  if (params.askerIsAgentOwner !== true) return deny('asker_not_agent_owner', { source: 'channel', channel, asker_is_agent_owner: false });
  let self = null;
  try { self = await selfMemberId(); } catch { self = null; }
  const selfMember = await fetchMember(get, self);
  const ownerId = selfMember?.owner_member_id;
  if (!ownerId) return deny('agent_owner_unknown', { source: 'channel', channel, asker_is_agent_owner: true });
  const owner = await fetchMember(get, ownerId);
  const verdict = checkMemberRole(owner);
  return {
    ...verdict, source: 'channel', channel, asker_is_agent_owner: true, initiator_member_id: ownerId,
    ...(verdict.allowed ? { initiator_name: owner.display_name || null } : {}),
  };
}

/**
 * Decide whether the asker may see billing numbers.
 * @param {object} params  CLI params (conversationId/messageId OR channel/askerIsAgentOwner)
 * @param {object} ctx     { get(path) → unwrapped data, orgId, selfMemberId() → id, now }
 * @returns {Promise<{allowed:boolean, reason?:string, source?:string, role?:string, initiator_member_id?:string|null, ...}>}
 */
export async function checkInitiator(params, { get, orgId = '', selfMemberId = async () => '', now = Date.now() } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return deny('missing_initiator');
  const hasRef = params.conversationId !== undefined || params.messageId !== undefined || params.sourceMessageId !== undefined;
  const channel = params.channel === undefined ? '' : String(params.channel).toLowerCase();
  const external = channel !== '' && !WORKSPACE_CHANNELS.has(channel);
  if (channel && !CHANNEL_RE.test(channel)) return deny('invalid_channel');
  if (NON_HUMAN_CHANNELS.has(channel)) return deny('initiator_not_human', { source: 'channel', channel });
  // A Workspace ask is identified by its message, never by a self-declared flag.
  if (hasRef && external) return deny('ambiguous_initiator');
  if (!hasRef && params.askerIsAgentOwner !== undefined && !external) return deny('workspace_requires_source_message', { source: 'workspace' });
  try {
    if (hasRef) return await gateWorkspace(params, { get, orgId, now });
    if (external) return await gateExternal(params, { get, selfMemberId });
  } catch {
    return deny('initiator_check_failed');
  }
  return deny('missing_initiator');
}
