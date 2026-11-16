/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * Every OpenMax DM, group and sub-conversation gets its own session group
 * (its own AI session) on a Core that takes `--session-group`. The name is
 * derived from the reply endpoint alone, so the inbound `--session-group`
 * value and `scripts/session-group.js <endpoint>` (which Core runs for every
 * outbound send) always agree:
 *
 *   <D>|type:dm|…     -> dm-<D>       (DMs: humans, system members, agent ↔ agent)
 *   <G>|type:group|…  -> group-<G>    (groups, quote replies included)
 *   <S>|type:sub|…    -> sub-<S>      (any sub-conversation, under a DM or a group;
 *                                      S is the sub-conversation's own id)
 *
 * `group-<G>:topic-<T>` is reserved for a future topic that has no
 * conversation id of its own; nothing produces it today.
 *
 * Which kind a conversation is comes from its record (endpointKindOf): a
 * non-empty context_owner_kind with a parent conversation is a
 * sub-conversation (checked first: a sub-conversation inherits its parent's
 * DM / GROUP type); otherwise DM -> dm, GROUP -> group. Anything else (STRAT,
 * BROADCAST, BRIDGE, no record) has no session group and is refused, never
 * guessed.
 *
 * These names are Core's memory keys. The rules are FIXED once live: changing
 * them needs a migration planned together with Core, otherwise existing
 * groups lose their memory.
 *
 * Per-message parts of the endpoint (reply, msg, unknown segments) never take
 * part. Nothing is rewritten, truncated or hashed: an endpoint without a known
 * type, an id with unexpected characters, or a name Core would reject throws.
 * The component never adds the `openmax:` namespace; Core does.
 *
 * An endpoint without `|type:` (a bare conversation id, a legacy prefix, or a
 * legacy thread endpoint) is resolved by resolveSessionGroup: the stored type
 * (conv-org-map.json), else GET /conversations/{id} with the org's
 * credentials, written back. If that fails it throws.
 */
import { parseEndpoint } from './message.js';
import { convRecordFields, lookupConvOrg, lookupConvRecord, registerConvOrg } from './conv-org.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** OpenMax conversation ids (UUIDs) used verbatim inside group names. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** endpoint `type:` value -> group-name prefix */
const KIND_PREFIX = { dm: 'dm', group: 'group', sub: 'sub' };

// Core kills the session-group query after 5s; stay under it so a slow API
// fails cleanly here instead of being cut off. Budget for all org attempts.
export const CONVERSATION_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * The endpoint kind of a conversation, from its stored fields
 * (conv-org.js convRecordFields shape: `{type, parentId?, sub?}`).
 * @param {{type?:string, parentId?:string, sub?:boolean}|null|undefined} fields
 * @returns {'dm'|'group'|'sub'|null} null when it has no session group
 */
export function endpointKindOf(fields) {
  if (!fields || typeof fields !== 'object') return null;
  if (fields.sub === true) {
    return typeof fields.parentId === 'string' && fields.parentId.trim() ? 'sub' : null;
  }
  const type = typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '';
  if (type === 'dm') return 'dm';
  if (type === 'group') return 'group';
  return null;
}

/**
 * The endpoint kind of a conversation record (GET /conversations/{id}).
 * Same rule as endpointKindOf, applied to the fields conv-org.js stores, so a
 * record read from the API and the same record read back from the file give
 * the same kind.
 * @param {object|null|undefined} conv
 * @returns {'dm'|'group'|'sub'|null}
 */
export function endpointKindOfRecord(conv) {
  return endpointKindOf(convRecordFields(conv));
}

/**
 * Derive the in-group session name from an endpoint that carries `|type:`.
 * @param {string} endpoint - e.g. "<uuid>|type:group|msg:7300000000000000132"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const id = parsed.conversationId;
  if (!CONVERSATION_ID.test(id)) {
    throw new Error(`invalid OpenMax conversation id in endpoint: ${quote(endpoint)}`);
  }
  const kind = parsed.endpointType;
  if (kind === undefined) {
    throw new Error(`endpoint has no type, cannot tell DM, group and sub-conversation apart: ${quote(endpoint)}`);
  }
  if (!Object.hasOwn(KIND_PREFIX, kind)) {
    throw new Error(`unknown conversation type in endpoint: ${quote(kind, 32)}`);
  }
  const name = `${KIND_PREFIX[kind]}-${id}`;
  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}

async function defaultFetchConversation(orgId, conversationId, timeoutMs) {
  // Dynamic import keeps the HTTP client (and its token cache) out of the
  // module load path of the pure mapping above.
  const { getForOrg, apiPath } = await import('./client.js');
  return getForOrg(orgId, apiPath(`/conversations/${conversationId}`), undefined, { timeoutMs });
}

async function defaultCandidateOrgs(conversationId) {
  const known = lookupConvOrg(conversationId);
  if (known) return [known];
  if (process.env.COCO_ORG_ID) return [process.env.COCO_ORG_ID];
  const { enabledOrgs } = await import('./config.js');
  return enabledOrgs().map((o) => o.org_id).filter(Boolean);
}

/**
 * Look a conversation's record up through the API, trying each candidate org
 * (the one conv-org-map.json names, else COCO_ORG_ID, else every enabled org)
 * within one overall deadline. Writes the type fields back on success.
 * @returns {Promise<{orgId:string, fields:object}>}
 */
async function lookupConversation(conversationId, { fetchConversation, candidateOrgs, timeoutMs, now }) {
  const deadline = now() + timeoutMs;
  const orgs = await candidateOrgs(conversationId);
  if (!orgs.length) throw new Error('no enabled org to look the conversation up in');
  const errors = [];
  for (const orgId of orgs) {
    const left = deadline - now();
    if (left <= 0) { errors.push('timed out'); break; }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`GET /conversations timed out after ${timeoutMs}ms`)), left);
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      const conv = await Promise.race([fetchConversation(orgId, conversationId, left), timeout]);
      const fields = convRecordFields(conv?.data && !conv.type ? conv.data : conv);
      if (!fields) throw new Error('conversation record has no type');
      registerConvOrg(conversationId, orgId, fields);
      return { orgId, fields };
    } catch (err) {
      errors.push(err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * Session group for any endpoint, including a bare conversation id.
 * - With `|type:`: exactly sessionGroupFromEndpoint (no file, no network).
 * - Otherwise (bare id, legacy `[OPENMAX DM|GROUP]/` prefix whose type is not
 *   trusted, legacy thread endpoint whose thread part is ignored): the stored
 *   type for the leading conversation id, else GET /conversations/{id} (then
 *   stored). Maps to dm-/group-/sub-<id>.
 * @param {string} endpoint
 * @param {object} [deps] - test hooks
 * @param {function} [deps.lookupRecord] - id -> stored fields | null
 * @param {function} [deps.fetchConversation] - (orgId, id, timeoutMs) -> Promise<record>
 * @param {function} [deps.candidateOrgs] - id -> Promise<orgId[]>
 * @param {number} [deps.timeoutMs]
 * @param {function} [deps.onLegacyThread] - called when a legacy thread part was ignored
 * @returns {Promise<string>} group name without namespace
 * @throws {Error} when the endpoint cannot be mapped or the lookup fails
 */
export async function resolveSessionGroup(endpoint, {
  lookupRecord = lookupConvRecord,
  fetchConversation = defaultFetchConversation,
  candidateOrgs = defaultCandidateOrgs,
  timeoutMs = CONVERSATION_LOOKUP_TIMEOUT_MS,
  now = Date.now,
  onLegacyThread,
} = {}) {
  if (typeof endpoint !== 'string') throw new Error('endpoint must be a string');
  const parsed = parseEndpoint(endpoint);
  if (parsed.legacyThread && onLegacyThread) onLegacyThread(parsed);
  if (parsed.endpointType !== undefined) return sessionGroupFromEndpoint(endpoint);

  const id = parsed.conversationId;
  if (!CONVERSATION_ID.test(id)) {
    throw new Error(`invalid OpenMax conversation id in endpoint: ${quote(endpoint)}`);
  }
  let fields = lookupRecord(id);
  if (!fields) {
    try {
      ({ fields } = await lookupConversation(id, { fetchConversation, candidateOrgs, timeoutMs, now }));
    } catch (err) {
      throw new Error(`cannot look up conversation type for ${quote(id)}: ${err.message}`);
    }
  }
  const kind = endpointKindOf(fields);
  if (!kind) {
    throw new Error(`conversation ${quote(id)} (type ${quote(fields.type, 32)}) has no session group`);
  }
  return sessionGroupFromEndpoint(`${id}|type:${kind}`);
}
