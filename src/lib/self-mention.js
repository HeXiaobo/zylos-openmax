/**
 * Self-mention detection for group messages.
 *
 * @-mentions are resolved purely by stable member ID. cws-comm/cws-core treat
 * a message's structured `mentions[]` array (member UUIDs, `mentioned_id` per
 * entry) as the ONLY mention source and do NOT parse @names from the message
 * text (cws-core message.go: "cws-comm does not parse @names from the message
 * text; this array is the only mention source"). So an agent is @-mentioned
 * iff its own member_id appears in that array.
 *
 * This is what fixes issue #85 / cws-comm #329: "@luna.coco" carries
 * luna.coco's member_id, so a bare "luna" agent is simply not in the array and
 * is never woken — no fragile text/name matching is involved, so there is no
 * dot/hyphen/substring collision class to get wrong.
 *
 * @all handling comes for free: cws-comm EXPANDS @all/@all_agents into one row
 * per targeted member, each carrying that member's real `mentioned_id` (plus an
 * `is_mention_all` marker used only for @-chip rendering). So "@所有Agent"
 * yields a row with this agent's own member_id → matched; "@所有人" yields rows
 * for human members only → this agent's id is absent → not matched. The
 * `is_mention_all` flag is therefore NOT a matching signal: keying off it would
 * add no real @all_agents coverage (the id is already present) while causing
 * agents to answer human-only "@所有人" broadcasts in multi-human groups.
 */

/**
 * @param {string[]} mentionIds     structured mention member IDs from the message
 *                                  (see extractMentions in comm-bridge.js).
 * @param {string}   selfMemberId   this agent's member_id in the org.
 * @returns {boolean} true iff this agent's member_id is among the mentions.
 */
export function isSelfMentioned({ mentionIds = [], selfMemberId } = {}) {
  if (!selfMemberId) return false;
  return (mentionIds || []).map(String).includes(String(selfMemberId));
}

/**
 * In a group topic the server may address a message to one agent without an
 * @: a person's message that @-mentions no agent, in a topic where exactly
 * one agent has replied, carries that agent's member_id in
 * `addressed_member_ids`. It is not a mention (no mention row, no @
 * notification); a mention-mode agent treats it as one.
 *
 * @param {string[]} addressedIds   the message's addressed_member_ids.
 * @param {string}   selfMemberId   this agent's member_id in the org.
 * @returns {boolean} true iff the message is addressed to this agent.
 */
export function isSelfAddressed({ addressedIds = [], selfMemberId } = {}) {
  if (!selfMemberId) return false;
  return (addressedIds || []).map(String).includes(String(selfMemberId));
}
