/**
 * Sub-conversations (cws-comm#373): a conversation that lives under a parent
 * DM or group, owned by an app (any context key, e.g. `ticket:42`) or by the
 * platform (a reply topic).
 *
 * Everything here is pure, so the bridge's decisions can be unit-tested:
 *   - subConversationOf: is this conversation record a sub-conversation?
 *   - groupScopeConversationId: which conversation's group config gates it;
 *   - fetchesConversationContext: who gets local history and a context block.
 *
 * Only the conversation record (GET /conversations/{id}) is read, never message
 * metadata, so a sender cannot make an ordinary conversation look like one.
 * Generic by design: no context key, owner app or title is special-cased, and
 * none of them reaches the envelope.
 */

// The two owner kinds cws-comm writes (context_owner_kind).
const OWNER_KINDS = new Set(['app', 'platform']);

// cws-comm's context key rule.
const CONTEXT_KEY_RE = /^[a-z0-9:_-]{1,128}$/;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Read a conversation record as a sub-conversation.
 *
 * All of these, or it is not one (fail closed: anything missing or malformed
 * keeps the ordinary handling):
 *   - context_owner_kind is `app` or `platform`;
 *   - context_key matches the server's rule;
 *   - parent_conversation_id is set (the group gate needs it);
 *   - for `app`, context_owner_app_id is set.
 * A legacy thread with only parent_conversation_id is not a sub-conversation.
 *
 * @param {object|null|undefined} conv  GET /conversations/{id} response
 * @returns {{parentConversationId:string, ownerKind:'app'|'platform'}|null}
 */
export function subConversationOf(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const ownerKind = conv.context_owner_kind;
  if (typeof ownerKind !== 'string' || !OWNER_KINDS.has(ownerKind)) return null;
  const key = conv.context_key;
  if (typeof key !== 'string' || !CONTEXT_KEY_RE.test(key)) return null;
  if (!nonEmptyString(conv.parent_conversation_id)) return null;
  if (ownerKind === 'app' && !nonEmptyString(conv.context_owner_app_id)) return null;

  return { parentConversationId: conv.parent_conversation_id, ownerKind };
}

/**
 * The conversation whose group config (`access.groups[id]`: allowlist entry,
 * mode, allowFrom) gates a group message: the parent group for a
 * sub-conversation, as if the message had been sent in the parent group; the
 * conversation itself otherwise. A sub-conversation's own id in `groups{}`
 * does not let it through.
 */
export function groupScopeConversationId(conversationId, sub) {
  return sub ? sub.parentConversationId : conversationId;
}

/**
 * Whether the bridge records a message into local history and gives it a
 * context block: every non-DM conversation, as before, and every
 * sub-conversation, a DM one included (keyed by the sub-conversation's own
 * id). A plain DM gets neither.
 */
export function fetchesConversationContext(convType, sub) {
  return convType !== 'dm' || !!sub;
}
