// Group access rules (group / group sub-conversation), pure so they
// can be unit-tested. The caller (comm-bridge.shouldHandleMessage) has already
// skipped self-echo, System Member and DM messages, and resolves who was
// mentioned and whether the sender is the owner.

import { groupScopeConversationId } from './subconversation.js';

export const NOTICE_GROUP_DISABLED =
  "Sorry, group chat is currently disabled.";
export const NOTICE_GROUP_NOT_ALLOWED =
  "Sorry, I'm not available in this group.";
export const NOTICE_GROUP_SENDER_NOT_ALLOWED =
  "Sorry, you don't have permission to interact with me in this group.";

/**
 * Decide a group message. Returns the shape shouldHandleMessage returns:
 *   { handle: false, reason, userNotice? }
 *   { handle: true, reason, mode, mentioned, groupCfg }
 *
 * A sub-conversation (`sub`, from subConversationOf) is gated exactly as a
 * message in its parent group: the parent's `groups{}` entry decides the
 * allowlist, mode and allowFrom, and the polite refusals are the parent's.
 * App and platform sub-conversations alike follow the parent's mode: in a
 * mention-mode group only an @ addresses the Agent.
 *
 * @param {object} p
 * @param {object} [p.access]          orgConfig.access
 * @param {string} p.conversationId    the conversation the message arrived in
 * @param {object|null} [p.sub]        subConversationOf(conv)
 * @param {string} [p.senderId]
 * @param {boolean} p.mentioned        structurally @-mentions this agent
 * @param {boolean} p.senderIsOwner
 */
export function decideGroupAccess({ access = {}, conversationId, sub = null, senderId, mentioned, senderIsOwner }) {
  const policy = access.groupPolicy || 'allowlist';
  const convId = groupScopeConversationId(conversationId, sub);
  const groupCfg = (access.groups || {})[convId];
  // Log label: names the parent when a sub-conversation is gated by it.
  const scope = convId === conversationId ? convId : `${convId} (parent of ${conversationId})`;

  if (policy === 'disabled') {
    return {
      handle: false,
      reason: 'group:disabled',
      userNotice: mentioned ? NOTICE_GROUP_DISABLED : undefined,
    };
  }

  // Owner @-mention bypasses the allowlist gate (mirrors zylos-feishu 1242).
  if (policy === 'allowlist' && !groupCfg && !(senderIsOwner && mentioned)) {
    return {
      handle: false,
      reason: `group:allowlist (${scope} not in groups{})`,
      userNotice: mentioned ? NOTICE_GROUP_NOT_ALLOWED : undefined,
    };
  }

  // mode: per-group `mode` if present, else default to 'mention'
  const mode = groupCfg?.mode || 'mention';
  if (mode === 'mention' && !mentioned) {
    // No userNotice — this is normal background traffic, replying would spam.
    return { handle: false, reason: 'group:mention (not @-ed)' };
  }
  // mode === 'smart' bypasses the mention requirement

  // allowFrom: ['*'] / [] = all members allowed; otherwise restrict.
  // Owner is exempt from per-group allowFrom — matches zylos-feishu.
  const allowFrom = groupCfg?.allowFrom;
  if (allowFrom && allowFrom.length > 0 && !allowFrom.includes('*') && !senderIsOwner) {
    if (!allowFrom.map(String).includes(String(senderId))) {
      return {
        handle: false,
        reason: `group:allowFrom (sender ${senderId} not allowed in ${scope})`,
        userNotice: mentioned ? NOTICE_GROUP_SENDER_NOT_ALLOWED : undefined,
      };
    }
  }

  const ownerTag = (!groupCfg && senderIsOwner && mentioned) ? ' [owner-mention-bypass]' : '';
  return {
    handle: true,
    reason: `group:${policy}/${mode}${ownerTag}`,
    mode,
    mentioned,
    groupCfg,
  };
}
