#!/usr/bin/env node

/**
 * Communication CLI — IM operations against cws-core
 * (paths and shapes match the live OpenAPI at
 *  https://zylos01.jinglever.com/cws-core/openapi.json).
 *
 * Reactive IM (Agent replying to a user via the WebSocket frame) is handled
 * by `src/comm-bridge.js` automatically. This CLI is for proactive IM:
 * starting a new DM, sending into a non-current conversation, pulling
 * history, etc.
 *
 * WebSocket frames stay on the direct cws-comm link (src/lib/ws.js) —
 * this CLI is REST only.
 *
 * Usage:
 *   node src/cli/comm.js <command> '<json-params>'
 *   node src/cli/comm.js comm.send '{"conversationId":"cv-1","content":"hi"}'
 *
 * Status:
 *   ✅  available in cws-core today
 *   ⏳  not exposed by cws-core yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { randomUUID } from 'crypto';
import { getForOrg, postForOrg, delForOrg, apiPath, reacquireToken } from '../lib/client.js';
import { withAuthRetry } from '../lib/auth-retry.js';
import { looksLikeMarkdown } from '../lib/message.js';
import { assertAnswerable, buildChoiceRequest, resolveInteractionType } from '../lib/interaction-request.js';
import { askForm, hasAskedOf } from '../lib/card-message.js';
import { assertAllImChannels } from '../lib/onboarding-channel-guard.js';
import { formatLocalTime } from '../lib/local-time.js';
import {
  claimGroupReminder,
  clearPendingGroup,
  clearPendingQuestion,
  decodeFormAnswer,
  findPendingQuestion,
  formGroupStatus,
  isAnswerAuthorized,
  isExpired,
  listPendingQuestions,
  recordFormOutcome,
  recordPendingQuestion,
  sameFormAnswers,
} from '../lib/pending-question.js';
import {
  buildMentions,
  needsRosterHydration,
  recordRoster,
  rosterFetchedRecently,
  markRosterFetched,
} from '../lib/mention.js';
import { loadConfig, updateConfig, enabledOrgs, getOrgByOrgId, setOwner } from '../lib/config.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

function ensureClientMsgId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * Resolve the target org for HTTP/JWT ROUTING. Accepts `org` as a config key
 * (org_id), org UUID, or org_name (case-insensitive); with neither, defaults to
 * the env-selected org (COCO_ORG_ID) or the single enabled org.
 * Returns { slug, org_id, org_name, self, owner, ... } where `slug` is the
 * config key (used for config writes). For an env-only org that is not in
 * config.orgs, returns a MINIMAL { org_id } block carrying just the id for
 * JWT routing (no slug/self).
 *
 * This minimal env-only block is ONLY safe for routing (getForOrg/postForOrg/
 * delForOrg key off org_id alone). Commands that read/write config-backed
 * fields (slug/self/access/owner) must instead call resolveConfiguredOrg(),
 * which rejects the slug-less minimal block with an actionable 400 rather than
 * fabricating success on / crashing over a non-existent org (reviewer zylos0t
 * sibling blocker, auto-task #13).
 */
function resolveOrgConfig(p) {
  const key = p.org || p.orgSlug || p.orgId || p.org_id;
  const enabled = enabledOrgs();
  if (key) {
    const byKey = enabled.find((o) => o.slug === key);
    if (byKey) return byKey;
    const byId = getOrgByOrgId(key);
    if (byId) return byId;
    const norm = (s) => s?.toLowerCase().replace(/[-_ ]/g, '');
    const keyNorm = norm(key);
    const byName = enabled.find((o) => norm(o.org_name) === keyNorm);
    if (byName) return byName;
    const names = enabled.map((o) => o.org_name || o.slug).join(', ');
    throw new Error(`org not found in config: "${key}" (known: ${names || 'none'})`);
  }
  // No explicit {org}. Honor the env-selected operating org next, kept
  // consistent with config.resolveDefaultOrgId(): the env-only passthrough
  // requires a TRULY EMPTY config.orgs map; a POPULATED map (even one whose
  // orgs are all disabled) makes a non-enabled COCO_ORG_ID a BAD VALUE that
  // FAILS CLOSED (owner 2026-08-18). Match on the enabled set (not
  // getOrgByOrgId, which ignores the `enabled` flag) so slug/name/self stay
  // populated for config-backed ops.
  const envOrgId = process.env.COCO_ORG_ID;
  if (envOrgId) {
    const byEnv = enabled.find((o) => o.org_id === envOrgId);
    if (byEnv) return byEnv;
    // Env-only deployment = truly empty config.orgs map (nothing to validate
    // against): carry a minimal { org_id } routing block (the pre-existing
    // supported env-only path, Bug B). A populated-but-all-disabled map does
    // NOT take this path — it falls through to the fail-closed handling below.
    const configuredCount = Object.keys(loadConfig().orgs || {}).length;
    if (configuredCount === 0) return { org_id: envOrgId };
    // Bad value RELATIVE TO a populated config set. Single enabled org → fall
    // back to it (WARN, stderr only — this CLI emits JSON on stdout). Otherwise
    // (all disabled = 0 enabled, or >1 enabled) → fail fast with a 400 before
    // any network call, noting COCO_ORG_ID is not an enabled org.
    if (enabled.length === 1) {
      console.error(
        `[comm] COCO_ORG_ID=${envOrgId} is not an enabled org `
        + `(${enabled.length} enabled / ${configuredCount} configured); `
        + `falling back to sole enabled org ${enabled[0].org_id}`,
      );
      return enabled[0];
    }
    const names = enabled.map((o) => o.org_name || o.slug).join(', ');
    throw Object.assign(
      new Error(
        `COCO_ORG_ID=${envOrgId} is not an enabled org `
        + `(${enabled.length} enabled / ${configuredCount} configured) — `
        + `pass {"org":"<name>"}${names ? ` (one of: ${names})` : ''}`,
      ),
      { status: 400 },
    );
  }
  if (enabled.length === 1) return enabled[0];
  // Nothing (arg, env, or a lone enabled org) determines the operating org.
  // Fail fast (400) instead of dropping to a bare, identity-only call.
  if (enabled.length === 0) throw Object.assign(new Error('no enabled orgs in config.orgs'), { status: 400 });
  const names = enabled.map((o) => o.org_name || o.slug).join(', ');
  throw Object.assign(
    new Error(`multiple enabled orgs — pass {"org":"<name>"} (one of: ${names})`),
    { status: 400 },
  );
}

/**
 * Resolve the target org for CONFIG-BACKED commands (sync_owner, dm_policy,
 * dm_list, dm_allow, dm_revoke). These read/write slug/self/access/owner, which
 * only exist on a real config.orgs block — they cannot operate on the minimal
 * env-only { org_id } routing block resolveOrgConfig() returns for a
 * COCO_ORG_ID that is not in config.orgs.
 *
 * Delegates org SELECTION to resolveOrgConfig() (so explicit {org}, single-org,
 * multi-org fail-fast and env-selection all stay identical), then REQUIRES the
 * result to be a real config block (identified by `slug`). If selection landed
 * on the slug-less env-only fallback, fail fast with an actionable 400 instead
 * of returning fake success (dm_list / read-only dm_policy) or crashing on
 * undefined config (dm_policy write / dm_allow / dm_revoke / sync_owner).
 */
function resolveConfiguredOrg(p) {
  const org = resolveOrgConfig(p);
  if (!org.slug) {
    throw Object.assign(
      new Error(
        `org ${org.org_id} selected via COCO_ORG_ID has no block in config.orgs; `
        + `these commands require a configured org (add an orgs.<key> block with `
        + `slug/self/access, or pass {"org":"<configured org>"})`,
      ),
      { status: 400 },
    );
  }
  return org;
}

/**
 * HTTP helpers for an org-owned IM op. Every backend IM route is org-scoped:
 * the backend resolves the org from the JWT principal and 403s on an identity-only
 * token. We ALWAYS route through the operating org's cached JWT via the *ForOrg
 * helpers — `resolveOrgConfig(p)` picks the explicit `{org}` (config key / org
 * UUID / org_name) or the single enabled org, and FAILS FAST (400) on a
 * multi-org install with no `{org}` instead of silently dropping to a bare,
 * identity-only call. Single-org / `COCO_ORG_ID` deployments resolve the one
 * org exactly as before.
 *
 * Bug B fix (#13): the previous no-`{org}` branch returned bare
 * `{ get, post, del }`, so on a multi-org agent the 6 conversation-member
 * commands (and the 10 formerly-bare commands below) went out identity-only and
 * 403'd. Resolving a default org here closes that leak.
 */
function convClient(p) {
  const org = resolveOrgConfig(p);
  return {
    get:  (path, query, opts) => getForOrg(org.org_id, path, query, opts),
    post: (path, body)  => postForOrg(org.org_id, path, body),
    del:  (path)        => delForOrg(org.org_id, path),
  };
}

// Org-scoped shadows of the bare verbs. Every IM REST command is org-owned, so
// each resolves the operating org (fail-fast in multi-org) and carries that
// org's JWT — see convClient above. This converts the 10 formerly-unconditionally
// -bare commands (list_conversations / create_dm / create_group / get_messages /
// send / get_message / unread / mark_read / search / sync) without touching each
// call site.
const get  = (path, query, opts) => convClient(params).get(path, query, opts);
const post = (path, body)  => convClient(params).post(path, body);
const del  = (path)        => convClient(params).del(path);

// POST a user-visible send, re-sending it a bounded number of times on a 401
// (auth-retry.js). Only the outbound send verbs use this: a card or message
// that fails on a token rotated mid-flight would otherwise be reported as a
// failed send — and for an onboarding card that means a permanent downgrade to
// the text form. `body` is built once by the caller, so every attempt carries
// the same client_msg_id and a retry can never post twice.
function postWithAuthRetry(path, body, label) {
  return withAuthRetry(() => post(path, body), {
    label,
    reacquire: ({ force }) => reacquireToken(resolveOrgConfig(params).org_id, { force }),
  });
}

// Read this agent's own member record from the backend for the given org; the
// authoritative owner_member_id lives here.
async function fetchSelfMember(org) {
  const selfId = org.self?.member_id;
  if (!selfId) throw new Error(`org "${org.slug}" has no self.member_id yet (token exchange not completed)`);
  return getForOrg(org.org_id, apiPath(`/members/${selfId}`));
}

/**
 * Build the cws-core v5 send-message body from caller input.
 *
 * cws-core schema (sendMessageRequest):
 *   {
 *     client_msg_id: "...",
 *     type: "TEXT" | "MARKDOWN" | "AGENT_TEXT" | "IMAGE" | "FILE" | "AGENT_STRUCTURED" | ...,
 *     content: {
 *       content_type: "text" | "markdown" | "image" | "file" | ...,
 *       body: { text, ... } | {},
 *       attachments: [{artifact_id, file_name, content_type, size_bytes}, ...]
 *     },
 *     mentions?: [{type: "member", member_id}, ...]
 *   }
 *
 * mentions is resolved automatically from `@name` tokens in the text body
 * against the conversation's known participants (src/lib/mention.js) —
 * required for a mention to actually wake its target; cws-comm does not
 * parse @-mentions out of text itself. Pass `params.mentions` explicitly
 * (array of `{type, member_id}`, or plain member_id strings) to override
 * auto-detection.
 *
 * Caller can pass:
 *   - string                                            → text/markdown auto-detect
 *   - {text} | {body}                                   → text/markdown auto-detect
 *   - {content_type, body, attachments?}                → pass-through (advanced)
 *   - already-built object with top-level type+content  → returned as-is
 */
/**
 * Best-effort text extraction for the mention pre-check — mirrors the plain-text
 * branch of buildSendBody(). A pre-built content object carries its text at
 * `content.body.text`; anything we can't read yields '' and simply skips the
 * roster fetch.
 */
function outboundText(params) {
  const c = params.content;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    if (c.content_type) return String(c.body?.text ?? '');
    return String(c.text ?? c.body ?? '');
  }
  return String(params.body?.content?.body?.text ?? '');
}

/**
 * Fill the mention registry from the conversation roster when the outbound text
 * mentions somebody the registry can't resolve. No-op when the caller supplied
 * `mentions` explicitly (buildSendBody short-circuits to those, so there is
 * nothing to resolve) or when every mentioned name already resolves.
 *
 * Best-effort: a failed, timed-out, or hung roster fetch leaves the pre-existing
 * behaviour intact (an unresolvable @name produces no mention) and never blocks
 * the send. The members GET is bounded by a short timeout because native fetch
 * has no default deadline — a connection accepted and then never answered would
 * otherwise hang forever, and a try/catch can't rescue a promise that never
 * rejects. The conversation is stamped as fetched BEFORE the request and
 * skipped for ROSTER_FETCH_TTL_MS afterwards, so a persistently-unresolvable
 * @token (or a bad endpoint) can't re-issue this GET on every message.
 */
const ROSTER_HYDRATION_TIMEOUT_MS = 2000;

async function hydrateRoster(params) {
  if (Array.isArray(params.mentions)) return;
  const convId = params.conversationId;
  if (!convId || rosterFetchedRecently(convId)) return;
  const text = outboundText(params);
  if (!needsRosterHydration(text, convId)) return;
  markRosterFetched(convId);
  try {
    const res = await convClient(params).get(
      apiPath(`/conversations/${convId}/members`),
      undefined,
      { timeoutMs: ROSTER_HYDRATION_TIMEOUT_MS },
    );
    const members = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    recordRoster(convId, members);
  } catch {
    /* best-effort: fall back to whatever the registry already knew */
  }
}

function buildSendBody(params) {
  // Allow advanced caller to override completely
  if (params.body && params.body.content && params.body.type) {
    return {
      client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
      ...params.body,
      ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    };
  }
  const c = params.content;
  let msgType = params.type;
  let contentType, body, attachments;
  if (c && typeof c === 'object' && c.content_type) {
    // pre-built content object
    contentType = c.content_type;
    body        = c.body ?? {};
    attachments = c.attachments ?? [];
    if (!msgType) msgType = contentType === 'image' ? 'IMAGE'
                       : contentType === 'file' ? 'FILE'
                       : 'AGENT_TEXT';
  } else {
    const text = (typeof c === 'string') ? c
              : (c && typeof c === 'object') ? (c.text ?? c.body ?? '')
              : '';
    contentType = looksLikeMarkdown(text) ? 'markdown' : 'text';
    body        = { text: String(text) };
    attachments = [];
    if (!msgType) msgType = 'AGENT_TEXT';
  }
  // Resolve `@name` tokens in the text body to a structured mentions[]
  // entry (cws-core MentionInput[]) against known conversation
  // participants, unless the caller already supplied one explicitly.
  // cws-comm never derives mentions from text itself — only the sending
  // client does (see src/lib/mention.js) — so without this an agent's
  // outbound @-mention never wakes its target.
  const explicitMentions = Array.isArray(params.mentions)
    ? params.mentions.map((m) => (typeof m === 'string' ? { type: 'member', member_id: m } : m))
    : undefined;
  const mentions = explicitMentions
    || (typeof body?.text === 'string' ? buildMentions(body.text, params.conversationId) : undefined);
  return {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    type:          msgType,
    content:       { content_type: contentType, body, attachments },
    ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    ...(mentions ? { mentions } : {}),
  };
}

// comm.ask_card, and comm.ask with interactionType "choice". `params` is the
// verb's own object, shadowing the module-level one so both verbs read what
// they were given. Messages name the verb that was called.
async function askChoice(params, verb) {
  if (!params.kind || !params.askedOf) {
    throw new Error(`${verb}: kind and askedOf are required — an answer with neither cannot be acted on`);
  }
  // Strip this verb's own arguments before building the request. `kind`,
  // `askedOf` and `meta` describe the QUESTION, not the card, and the card
  // builder refuses all three — `kind` included, because the card family is
  // `cardKind` there. Passing them through made this verb throw on its own
  // required argument.
  const { kind, askedOf, meta, ...cardParams } = params;
  const request = buildChoiceRequest(cardParams);
  assertAnswerable(request, verb);
  // onboarding.channel: refuse a card whose options are not exactly
  // im_channels (first 15 over the cap) in order, re-read with the im_order
  // the Agent's TZ selects (visible:false is a display hint only). A failed fetch
  // warns and lets the card go. See src/lib/onboarding-channel-guard.js.
  await assertAllImChannels(request, {
    fetchProfileOptions: (imOrder) => get(apiPath('/onboarding/profile-options'), { im_order: imOrder }, { timeoutMs: 8000 }),
  }, verb);
  const res = await postWithAuthRetry(
    apiPath(`/conversations/${params.conversationId}/interaction-requests`),
    request,
    verb,
  );
  const actionIds = res?.action_ids || res?.data?.action_ids;
  const messageId = res?.message_id || res?.data?.message_id;
  if (!Array.isArray(actionIds) || !actionIds.length || !messageId) {
    // The card is already posted; say so rather than implying nothing happened.
    throw new Error(`${verb}: card was SENT but the response carried no ${messageId ? 'action_ids' : 'message_id'}, so the answer will not be decodable: ${JSON.stringify(res)}`);
  }
  recordPendingQuestion({
    kind,
    askedOf,
    conversationId: params.conversationId,
    cardMessageId: messageId,
    actionIds,
    askedAt: new Date().toISOString(),
    title: params.title,
    meta,
  });
  return { ...res, recorded: true };
}

function commaList(raw) {
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((v) => String(v).trim()).filter(Boolean);
}

// comm.answered for a choice form. The receipt's ids are read back per
// question; `actionable` is the contract's: the submitter was asked, and the
// answer is in time, every id and "other" key belongs to the card, and at
// least one question is answered — an option, or "other" with text.
//
// For a card in a split group the outcome is written onto the record, because
// whether the group is complete is decided across receipts that arrive apart.
// `group.complete` is what says whether to act yet; `group.mayRemind` is true
// for exactly one call per group (PRD T-13: remind at most once).
function answeredForm(record) {
  // `actionId` is accepted too, comma-split like `selectedActionIds`: the
  // generic step reads "pass the actionId", and a model copying the header's
  // `selected-action-ids` into it would otherwise be refused for one string.
  const raw = params.selectedActionIds ?? params.actionId ?? [];
  const selected = commaList(raw);
  // "Other" has no option id: `otherSelected` is the header's `other-selected`
  // (question keys, comma-joined like the ids), `otherText` the member's text
  // per key, read from the receipt body.
  //
  // otherSelected is required. Defaulting a missing one to "none ticked" made
  // an Agent that forgot it report every "other" as unticked and blame the
  // platform (wsb#602 int eval, I1/I3); the header always carries the
  // attribute on a form receipt, so there is always a value to pass.
  //
  // otherTextKeys (the header's `other-text`, keys whose "other" has text) is
  // required for the same reason, and every key on it must come with its text:
  // dropping it would read a typed answer as a blank "other" and lose it.
  if (params.otherSelected === undefined) {
    throw new Error('comm.answered: a form answer needs otherSelected — pass the <interaction-receipt/> element\'s other-selected value as it is (an empty string when it is empty)');
  }
  if (params.otherTextKeys === undefined) {
    throw new Error('comm.answered: a form answer needs otherTextKeys — pass the <interaction-receipt/> element\'s other-text value as it is (an empty string when it is empty)');
  }
  const otherText = params.otherText ?? {};
  if (!otherText || typeof otherText !== 'object' || Array.isArray(otherText)) {
    throw new Error('comm.answered: otherText must be an object {questionKey: text}');
  }
  const textKeys = commaList(params.otherTextKeys);
  const untyped = textKeys.filter((k) => typeof otherText[k] !== 'string' || !otherText[k].trim());
  if (untyped.length) {
    throw new Error(`comm.answered: other-text lists ${untyped.join(', ')} but otherText has no text for it — copy the member's quoted "other" text for that question from the receipt body, e.g. otherText {"${untyped[0]}": "…"}`);
  }
  // The reverse as well: text the header does not vouch for would count as an
  // answer nobody gave. A blank entry counts as nothing, so it is let through.
  const unlisted = Object.keys(otherText)
    .filter((k) => !textKeys.includes(k) && typeof otherText[k] === 'string' && otherText[k].trim());
  if (unlisted.length) {
    throw new Error(`comm.answered: other-text does not list ${unlisted.join(', ')}; pass only text the receipt quotes`);
  }
  const authorized = isAnswerAuthorized(record, params.actorMemberId);
  const now = Date.now();
  const decoded = decodeFormAnswer(record, selected, { otherSelected: commaList(params.otherSelected), otherText });
  // The same accepted answer read again stays accepted: it was in time when it
  // was given, and judging it against today's clock would undo it.
  const prior = record.outcome;
  const repeat = Boolean(prior?.actionable) && prior.actorMemberId === (params.actorMemberId || '')
    && sameFormAnswers(prior.answers, decoded.answers);
  const expired = !repeat && isExpired(record, now);
  const actionable = authorized && !expired && decoded.unknownIds.length === 0
    && decoded.unknownKeys.length === 0 && decoded.answered > 0;
  const reason = !authorized ? 'the answering member is not who the question was asked of'
    : expired ? 'the question expired before it was answered'
    : decoded.unknownIds.length ? `ids not on this card: ${decoded.unknownIds.join(', ')}`
    : decoded.unknownKeys.length ? `question keys not on this card: ${decoded.unknownKeys.join(', ')}`
    : decoded.answered === 0 ? 'no question on this card was answered'
    : 'ok';
  const out = {
    known: true,
    interactionType: 'form',
    authorized,
    expired,
    actionable,
    reason,
    answered: `${decoded.answered}/${decoded.total}`,
    answers: decoded.answers,
    question: record,
  };
  if (!record.group) return out;

  if (!repeat) {
    recordFormOutcome(record.cardMessageId, {
      actionable, reason, actorMemberId: params.actorMemberId || '', answers: decoded.answers, at: new Date(now).toISOString(),
    });
  }
  // `group.answers`, once complete, is every card's answers in card order, so
  // the one follow-up can be written from this single call.
  const group = formGroupStatus(record.conversationId, record.group.id, now);
  group.mayRemind = !group.complete && group.needsReask.length === 0
    && claimGroupReminder(record.conversationId, record.group.id, new Date(now).toISOString());
  return { ...out, group };
}

const MESSAGE_TIME_FIELDS = ['timestamp', 'created_at', 'edited_at', 'deleted_at'];

// cws-core returns message times as UTC ISO strings (`…Z`); passed through
// as-is, the model quotes the UTC clock to people in other zones (cws-comm#322).
// Same rule as `askedAtLocal`: add a `<field>_local` copy for reading, keep the
// raw UTC field for anything that compares or forwards it.
function withLocalTimes(message) {
  if (!message || typeof message !== 'object') return message;
  const out = { ...message };
  for (const field of MESSAGE_TIME_FIELDS) {
    const local = formatLocalTime(message[field]);
    if (local) out[`${field}_local`] = local;
  }
  return out;
}

// get() returns {data, pagination} for a paginated envelope, bare data otherwise.
function withLocalMessageTimes(result) {
  if (Array.isArray(result)) return result.map(withLocalTimes);
  if (Array.isArray(result?.data)) return { ...result, data: result.data.map(withLocalTimes) };
  return result;
}


const COMMANDS = {
  // ---- Conversation collection -------------------------------------------------
  // ✅ GET /api/v1/conversations
  'comm.list_conversations': () => get(apiPath('/conversations'), {
    cursor:           params.cursor ?? params.pageToken,
    limit:            params.limit  ?? params.pageSize,
    include_archived: params.includeArchived,
  }),

  // ✅ POST /api/v1/conversations/dm    body {peer_member_id}
  // ✅ POST /api/v1/conversations/groups body {name, member_ids, description?, avatar_media_id?, metadata?}
  //   cws-core derives org_id and caller member_id from the JWT — do NOT send them.
  'comm.create_dm':    () => post(apiPath('/conversations/dm'), {
    peer_member_id: params.peerMemberId || params.participantId || params.peerId,
  }),
  'comm.create_group': () => post(apiPath('/conversations/groups'), {
    name:             params.name || params.title,
    member_ids:       params.memberIds || params.participantIds,
    description:      params.description,
    avatar_media_id:  params.avatarMediaId,
    metadata:         params.metadata,
  }),

  // ✅ GET /api/v1/conversations/{id}
  'comm.get_conversation': () => convClient(params).get(apiPath(`/conversations/${params.conversationId}`)),

  // ---- Conversation members ---------------------------------------------------
  // Group membership after creation. cws-core derives the caller from the JWT
  // and enforces permissions server-side (only conversation owner/admins may
  // add/remove; non-self targets must be org members). Pass {org} for multi-org.

  // ✅ GET /api/v1/conversations/{id}/members
  //   cws-core's ListMembers takes only conversation_id and returns the full
  //   member list — it is NOT paginated, so do not send cursor/limit (they'd be
  //   silently ignored and mislead callers into fake pagination loops).
  'comm.member_list': () => convClient(params).get(
    apiPath(`/conversations/${params.conversationId}/members`),
  ),

  // ✅ POST /api/v1/conversations/{id}/members            body {member_id, role?}   (single)
  // ✅ POST /api/v1/conversations/{id}/members:batch-add  body {member_ids, role?}  (many)
  //   Pass {memberId} for one, or {memberIds:[...]} for a batch (partial-success
  //   envelope). role ∈ MEMBER|ADMIN|OWNER|PUBLISHER|SUBSCRIBER (default MEMBER).
  'comm.member_add': () => {
    const cid = params.conversationId;
    const c = convClient(params);
    const many = params.memberIds != null;
    const ids = many ? [].concat(params.memberIds) : [];
    if (many) {
      if (!ids.length) throw new Error('memberIds must be a non-empty array');
      return c.post(apiPath(`/conversations/${cid}/members:batch-add`), {
        member_ids: ids, ...(params.role ? { role: params.role } : {}),
      });
    }
    if (!params.memberId) throw new Error('memberId (or memberIds) required');
    return c.post(apiPath(`/conversations/${cid}/members`), {
      member_id: params.memberId, ...(params.role ? { role: params.role } : {}),
    });
  },

  // ✅ DELETE /api/v1/conversations/{id}/members/{member_id}
  //   Removing yourself is rejected (400) — use comm.leave instead.
  'comm.member_remove': async () => {
    if (!params.memberId) throw new Error('memberId required');
    const r = await convClient(params).del(
      apiPath(`/conversations/${params.conversationId}/members/${params.memberId}`),
    );
    return r ?? { removed: params.memberId, conversationId: params.conversationId };
  },

  // ✅ POST /api/v1/conversations/{id}/members:batch-remove  body {member_ids}
  //   Rejects self-removal (400) — use comm.leave. Returns a partial-success envelope.
  'comm.member_remove_batch': () => {
    const ids = params.memberIds != null ? [].concat(params.memberIds) : [];
    if (!ids.length) throw new Error('memberIds must be a non-empty array');
    return convClient(params).post(
      apiPath(`/conversations/${params.conversationId}/members:batch-remove`),
      { member_ids: ids },
    );
  },

  // ✅ POST /api/v1/conversations/{id}/leave   body {new_owner_id?}
  //   Self-removal path. If the leaver is the group owner, cws-core requires a
  //   human successor: pass {newOwnerId}, or omit to let it pick a remaining
  //   human (or delete the group when only agents/nobody remain).
  'comm.leave': () => convClient(params).post(
    apiPath(`/conversations/${params.conversationId}/leave`),
    { ...(params.newOwnerId ? { new_owner_id: params.newOwnerId } : {}) },
  ),

  // ---- Messages ---------------------------------------------------------------
  // ✅ GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=
  'comm.get_messages': async () => withLocalMessageTimes(await get(apiPath(`/conversations/${params.conversationId}/messages`), {
    after_seq:  params.afterSeq,
    before_seq: params.beforeSeq,
    limit:      params.limit,
  })),

  // ✅ POST /api/v1/conversations/{id}/messages
  //   body: {client_msg_id, type, content:{content_type, body, attachments}, parent_id?}
  //   See buildSendBody() for the schema details.
  'comm.send': async () => {
    // Only matters when the caller did NOT pass mentions explicitly — in that
    // case buildSendBody falls back to resolving `@name` against the local
    // registry, which only knows participants observed speaking here. Pull the
    // roster once when the text aims at somebody unresolvable, so a mention of
    // a member who has never spoken still wakes them. See hydrateRoster().
    await hydrateRoster(params);
    // If an @token still can't resolve after hydration, the target isn't in the
    // roster; the mention silently produces nothing. Surface it on stderr so a
    // dead @ is diagnosable — never blocks the send.
    if (!Array.isArray(params.mentions) && needsRosterHydration(outboundText(params), params.conversationId)) {
      console.warn(`[comm.send] unresolvable @mention in conversation ${params.conversationId}; sending without a structured mention`);
    }
    return postWithAuthRetry(
      apiPath(`/conversations/${params.conversationId}/messages`),
      buildSendBody(params),
      'comm.send',
    );
  },

  // ✅ POST /api/v1/conversations/{id}/interaction-requests
  //   Ask the humans in a conversation to pick one of a few fixed answers.
  //   Use it instead of a plain-text question when the answer is a choice
  //   (yes/no, approve/reject); use plain text for open questions, for more
  //   choices than the server allows, or when a typed explanation is wanted.
  //
  //   The agent states what it wants — title, body blocks, option labels — and
  //   cws-comm builds the card. Nothing here names an operation, a URL, a
  //   handler or an option id.
  //
  //   🔴 Keep the `action_ids` from the response. They are the server's ids for
  //   the options, in the order supplied, and they are how the answer is read
  //   back later; there is no way to recover which option was which without
  //   them.
  'comm.send_card': async () => postWithAuthRetry(
    apiPath(`/conversations/${params.conversationId}/interaction-requests`),
    buildChoiceRequest(params),
    'comm.send_card',
  ),

  //   Ask a question AND remember what it was, in one call.
  //
  //   Sending and remembering are one verb on purpose. The answer arrives later
  //   as a separate receipt naming only the card, so a send whose `action_ids`
  //   were not written down produces an answer nobody can decode — and that is
  //   a two-step sequence away from happening every time the second step is
  //   skipped, forgotten, or lost to a restart between them.
  //
  //   `kind` says what the question is for, `askedOf` is the member whose
  //   answer counts, and `meta` is kept verbatim with the record for the
  //   answering side. Those three are this verb's own; everything else is a
  //   card field and is validated as one.
  'comm.ask_card': () => askChoice(params, 'comm.ask_card'),

  //   The one entry for asking a question you intend to act on (Q27).
  //   `interactionType` "choice" is exactly comm.ask_card; "form" asks a choice
  //   form whose questions are `fields`. Left out, the content decides:
  //   `fields` → form, `options` → choice — the same rule `[CARD]` uses.
  //   `kind`, `askedOf` and `meta` are this verb's own, as under ask_card; a
  //   form may give `answerers` in place of `askedOf`.
  'comm.ask': async () => {
    const { interactionType, ...rest } = params;
    const type = resolveInteractionType(params);
    if (type === 'choice') return askChoice(rest, 'comm.ask');
    const { kind, askedOf, meta, ...card } = rest;
    const asked = hasAskedOf(askedOf) ? askedOf : card.answerers;
    if (!kind || !hasAskedOf(asked)) {
      throw new Error('comm.ask: kind and askedOf (or answerers) are required — an answer with neither cannot be acted on');
    }
    const res = await askForm(params.conversationId, { kind, askedOf: asked, meta, card }, {
      post: (path, body) => postWithAuthRetry(path, body, 'comm.ask'),
    }, 'comm.ask');
    const out = { ...res.response, recorded: true };
    // Warned, not defaulted: in a group without answerers anyone may submit
    // first, and an answer by someone not asked settles the card for good
    // (PRD §9.4). Whether to restrict is the caller's call. Read after the
    // send, so a failed lookup costs only the warning.
    if (!card.answerers) {
      const conv = await get(apiPath(`/conversations/${params.conversationId}`)).catch(() => null);
      if (String(conv?.type || conv?.data?.type || '').toLowerCase() === 'group') {
        out.warning = 'group chat without answerers: any member can submit first, and an answer from someone not in askedOf settles the card so the people asked can no longer answer it. Pass answerers to restrict who can submit.';
      }
    }
    return out;
  },

  //   Resolve a receipt against what was asked. Give it the receipt's
  //   `card-message-id`, the chosen `actionId`, and the `actor-member-id`; it
  //   answers whether this is a question we asked, whether that member's answer
  //   counts, whether it arrived in time, and which option was chosen.
  //
  //   It decides nothing and executes nothing — the caller still acts.
  'comm.answered': () => {
    const record = findPendingQuestion(params.cardMessageId);
    if (!record) return { known: false, reason: 'no pending question for this card' };
    if (record.interactionType === 'form') return answeredForm(record);
    const authorized = isAnswerAuthorized(record, params.actorMemberId);
    const expired = isExpired(record, Date.now());
    const index = Array.isArray(record.actionIds)
      ? record.actionIds.indexOf(params.actionId)
      : -1;
    return {
      known: true,
      authorized,
      expired,
      actionable: authorized && !expired && index >= 0,
      optionIndex: index,
      reason: !authorized ? 'the answering member is not who the question was asked of'
        : expired ? 'the question expired before it was answered'
        : index < 0 ? 'the chosen action id was not one of this card\'s options'
        : 'ok',
      question: record,
    };
  },

  //   Questions still waiting, and forgetting one that has been dealt with.
  //
  //   `askedAtLocal` is added for reading only; the stored `askedAt` stays the
  //   UTC ISO string every comparison uses (`isExpired` parses it), because a
  //   local rendering carries no zone once it is copied anywhere else.
  //   A card in a split group also carries `groupStatus`, so a group with a
  //   card that expired unanswered shows up here as needing a re-ask.
  'comm.pending': () => {
    const records = listPendingQuestions();
    const now = Date.now();
    return records.map((r) => {
      const local = formatLocalTime(r.askedAt);
      const out = local ? { ...r, askedAtLocal: local } : r;
      if (!r.group) return out;
      return { ...out, groupStatus: formGroupStatus(r.conversationId, r.group.id, now, { records }) };
    });
  },
  //   A split-card group is cleared as a whole, by groupId. Clearing one of
  //   its cards alone would leave the rest waiting on a card no longer on file.
  'comm.pending_clear': () => {
    if (params.groupId !== undefined) {
      if (!params.conversationId) {
        throw new Error('comm.pending_clear: groupId needs conversationId — group ids can repeat across conversations');
      }
      return { cleared: clearPendingGroup(params.conversationId, params.groupId) };
    }
    const record = findPendingQuestion(params.cardMessageId);
    if (record?.group) {
      throw new Error(`comm.pending_clear: card ${params.cardMessageId} belongs to split group ${record.group.id}; clear the group with {conversationId, groupId}`);
    }
    return { cleared: clearPendingQuestion(params.cardMessageId) };
  },

  // ✅ GET /api/v1/conversations/{id}/messages/{msg_id}
  'comm.get_message': async () => withLocalTimes(await get(
    apiPath(`/conversations/${params.conversationId}/messages/${params.messageId}`),
  )),

  // ✅ GET /api/v1/conversations/{id}/unread
  'comm.unread': () => get(apiPath(`/conversations/${params.conversationId}/unread`)),

  // ✅ POST /api/v1/conversations/{id}/read
  'comm.mark_read': () => post(apiPath(`/conversations/${params.conversationId}/read`), { read_until_seq: params.seq }),

  // ✅ GET /api/v1/search/pages  — KB page search (only search surface in v5)
  'comm.search': () => get(apiPath('/search/pages'), {
    query:  params.query || params.q,
    kb_id:  params.kbId,
    limit:  params.limit  ?? params.pageSize,
    offset: params.offset,
    sort:   params.sort,
  }),

  // ✅ POST /api/v1/sync   body {since_seq, device_id, limit?}
  // Pull missed events after WS reconnect.
  'comm.sync': () => post(apiPath('/sync'), {
    since_seq: params.sinceSeq,
    device_id: params.deviceId,
    limit:     params.limit,
  }),

  // ---- Owner ------------------------------------------------------------------
  'comm.sync_owner': async () => {
    const org = resolveConfiguredOrg(params);
    const member = await fetchSelfMember(org);
    const coreOwnerId = member?.owner_member_id || '';
    const localOwnerId = org.owner?.member_id || '';
    if (!coreOwnerId) {
      return { org_slug: org.slug, synced: false, reason: 'core has no owner recorded; local binding left as-is', local_owner_id: localOwnerId };
    }
    if (coreOwnerId === localOwnerId) {
      return { org_slug: org.slug, synced: false, reason: 'already in sync', owner_id: coreOwnerId };
    }
    let name = '';
    try {
      const ownerMember = await getForOrg(org.org_id, apiPath(`/members/${coreOwnerId}`));
      name = ownerMember?.display_name || ownerMember?.username || '';
    } catch { /* name is cosmetic */ }
    setOwner(org.slug, coreOwnerId, name);
    return { org_slug: org.slug, synced: true, previous_owner_id: localOwnerId, owner: { member_id: coreOwnerId, name } };
  },

  // ---- DM access control (local config, hot-reloaded) -----------------------

  'comm.dm_policy': () => {
    const org = resolveConfiguredOrg(params);
    const access = org.access || {};
    if (params.policy) {
      const valid = ['open', 'allowlist', 'owner'];
      if (!valid.includes(params.policy)) throw new Error(`Invalid policy: ${params.policy}. Must be one of: ${valid.join(', ')}`);
      updateConfig(cfg => { cfg.orgs[org.slug].access = { ...cfg.orgs[org.slug].access, dmPolicy: params.policy }; });
      return { org: org.org_name || org.slug, dmPolicy: params.policy, applied: true };
    }
    return { org: org.org_name || org.slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_list': () => {
    const org = resolveConfiguredOrg(params);
    const access = org.access || {};
    return { org: org.org_name || org.slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_allow': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const org = resolveConfiguredOrg(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[org.slug].access = cfg.orgs[org.slug].access || {};
      const list = new Set(access.dmAllowFrom || []);
      for (const id of ids) list.add(id);
      access.dmAllowFrom = [...list];
    });
    return { org: org.org_name || org.slug, dmAllowFrom: result.orgs[org.slug].access.dmAllowFrom, added: ids };
  },

  'comm.dm_revoke': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const org = resolveConfiguredOrg(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[org.slug].access = cfg.orgs[org.slug].access || {};
      const remove = new Set(ids.map(String));
      access.dmAllowFrom = (access.dmAllowFrom || []).filter(id => !remove.has(String(id)));
    });
    return { org: org.org_name || org.slug, dmAllowFrom: result.orgs[org.slug].access.dmAllowFrom, removed: ids };
  },
};

function printUsage() {
  console.log(`Comm CLI — IM operations on cws-core (contract-v5)

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  comm.list_conversations   {cursor?, limit?, includeArchived?}
  comm.create_dm            {peerMemberId}                           # POST /conversations/dm
  comm.create_group         {name, memberIds, description?}          # POST /conversations/groups
  comm.get_conversation     {conversationId, org?}

Conversation members (owner/admin only; pass {org} for multi-org installs)
  comm.member_list          {conversationId, org?}                                  # GET  .../members (full list; not paginated)
  comm.member_add           {conversationId, memberId | memberIds[], role?, org?}   # POST .../members (or :batch-add)
  comm.member_remove        {conversationId, memberId, org?}                        # DELETE .../members/{id}
  comm.member_remove_batch  {conversationId, memberIds[], org?}                     # POST .../members:batch-remove
  comm.leave                {conversationId, newOwnerId?, org?}                     # POST .../leave

Messages
  comm.send                 {conversationId, content, replyTo?, clientMsgId?, mentions?}
                            # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
                            # mentions auto-resolved from @name in text if omitted (array of member_id or {type,member_id})
  comm.ask                  {conversationId, interactionType?, kind, askedOf?, meta?, ...card}
                            # THE entry for a question you intend to act on.
                            #   interactionType "form"   — choice form (select, then submit once):
                            #     {title, summary, text?|blocks?, fields:[{key, label, description?,
                            #      selection_mode?("single"|"multiple"), min_select?, max_select?,
                            #      allow_other?, options:[{label, key?, description?, recommended?,
                            #      exclusive?}]}], answerers?, group?:{id, index, total}}
                            #     leave required out: omitted is sent as false (optional); the
                            #       card submits once any one question is answered
                            #     allow_other omitted is sent as true: every question offers
                            #       "其他"; pass false only where free text makes no sense (yes/no)
                            #     any question with options is a form — one question included
                            #     never use "other" to collect a password, key or token
                            #     askedOf: member id or list; defaults to answerers
                            #     label is the bare question: the client numbers questions itself,
                            #       so never start it with 1. / Q1 / ① / (1)
                            #   interactionType "choice" — quick-reply card, exactly comm.ask_card below;
                            #     only for one-tap action buttons (approve/reject, confirm/cancel,
                            #     a single button, primary/danger actions)
                            #   omitted: fields → form, options → choice; both → refused
                            # replying to a routed message? same JSON as a [CARD]{...} body
                            #   (fields → form, options → quick reply). See references/comm-operations.md
  comm.ask_card             {conversationId, title, summary?, options, kind, askedOf, text?|blocks?, confirm?, cardKind?, meta?}
                            # alias of comm.ask with interactionType "choice"
                            # send a choice card AND record what was asked, so the later receipt
                            #   can be decoded. Prefer this over comm.send_card for any question
                            #   you intend to act on
                            # this is the PROACTIVE form. Replying to a message routed to you?
                            #   send the same card through that message's own "reply via"
                            #   command instead, as a [CARD]{...} body:
                            #     c4-send.js openmax '<conv>' <<'EOF'
                            #     [CARD]{"kind":..,"askedOf":..,"title":..,"summary":..,"text":..,"options":[..]}
                            #     EOF
                            #   same builder, same record, identical result — but it also leaves
                            #   a C4 conversation-log row (this verb leaves none, so a card asked
                            #   here is invisible to the history Memory Sync reads). Fields are
                            #   these minus conversationId; the JSON is INLINE, never a file path,
                            #   so the logged row stays readable on its own.
                            #   See references/comm-operations.md and src/lib/card-message.js
                            # kind / askedOf / meta belong to the QUESTION and are consumed here;
                            #   every other key is a CARD field, checked exactly as under
                            #   comm.send_card below — body shape (text vs blocks) included
                            # option styles work exactly as under comm.send_card below: undeclared
                            #   renders secondary, the primary one has to be declared
                            # one click answers: the client does not show confirm {text, label?}, on
                            #   the card or an option, so it guards nothing. For anything irreversible
                            #   use the platform's business card for it, or label the option with what
                            #   will happen and act only after an actionable answer
  comm.answered             {cardMessageId, actionId | selectedActionIds, actorMemberId,
                             otherSelected, otherTextKeys (form: both required), otherText?}
                            # resolve a receipt against what was asked: known / authorized /
                            #   expired / actionable. Decides nothing, executes nothing
                            # form: pass the header's selected-action-ids as selectedActionIds,
                            #   its other-selected as otherSelected and its other-text as
                            #   otherTextKeys (always, "" when empty — a form answer without
                            #   either is refused), and the "other" text the body quotes as
                            #   otherText {key: text}, one entry per otherTextKeys key and no
                            #   other (text for an unlisted key is refused), e.g.
                            #   {"cardMessageId":"…","selectedActionIds":"opt_1",
                            #    "otherSelected":"env","otherTextKeys":"env",
                            #    "otherText":{"env":"先灰度 10%"},"actorMemberId":"…"}
                            #   returns answers per question key {status, optionIndexes,
                            #   optionKeys, labels, otherSelected, otherText} and, for split cards, group
                            #   {complete, waiting, needsReask, mayRemind, answers}
                            #   "other" ticked but blank: otherSelected true, otherText null,
                            #   not an answer — go with the recommended/default and say so
  comm.pending              {}                                   # questions still awaiting an answer
  comm.pending_clear        {cardMessageId} | {conversationId, groupId}  # forget one that has been dealt with;
                            #   a split-group card only as the whole group (conversationId required)
  comm.send_card            {conversationId, title, summary?, text?|blocks?, options, confirm?, cardKind?, clientMsgId?}
                            # cardKind picks an onboarding card family: onboarding.task |
                            #   onboarding.channel | onboarding.partner (omitted = plain choice card).
                            #   NOT "kind" — that is ask_card's "what the question is for"
                            # onboarding options may also carry: decline:true ("none of these";
                            #   cws-comm records its generated id for the client), icon:"<slug>"
                            #   (never a URL), behavior:"open_create_agent" (partner card only:
                            #   opens the add-agent dialog, answers nothing). channel card: up to 16
                            #   options. See references/comm-operations.md "Onboarding guide cards"
                            # ask_card / [CARD] refuse an onboarding.channel card that leaves out
                            #   any im_channels entry (visible:false included — visible is only
                            #   the client's 5 + "其他 N 个渠道" collapse hint)
                            # a partner card MUST go through send_card: ask_card and [CARD] refuse a
                            #   card on which no option answers, since no receipt would ever arrive
                            # BODY: "text" is shorthand for one paragraph; anything richer passes
                            #   "blocks" INSTEAD (pass one or the other, never both):
                            #     "blocks": [
                            #       {"type":"text",  "text":"确认升级以下组件?"},
                            #       {"type":"fields","items":[{"label":"core","value":"0.7.1 → 0.8.1"}]}
                            #     ]
                            #   block types: text | markdown | fields | divider | image | quote |
                            #     artifact_list (each also takes fallback_text)
                            #   "fields" is a BLOCK, not a top-level key — one row per item is how
                            #     structured detail (per-component versions, amounts) is shown
                            # the accepted top-level keys are exactly the ones above: anything else
                            #   is REFUSED with the field named, never carried along. A top-level
                            #   "fields" used to be dropped in silence and the card posted without it
                            # client_msg_id is generated when omitted, which only de-dupes a retry
                            #   of the same request. To survive a lost response, KEEP your own
                            #   clientMsgId and pass the same one back — otherwise re-running
                            #   posts a second card
                            # asks a choice: options ["Yes","No"] or [{label,style?}] — at least one, no id
                            # an option that declares no style renders SECONDARY (white/outline).
                            #   There is no "first option is the primary one" rule: if the card has
                            #   one action you are actually asking for, mark that one
                            #   {"label":"...","style":"primary"}. Peer choices declare nothing
                            # style accepts primary | secondary | danger and nothing else — cws-comm
                            #   rejects any other value outright instead of falling back to a default
                            # confirm (card or option) is accepted but not shown by the client — see
                            #   comm.ask_card above
                            # KEEP the response's action_ids: they are the server's option ids, in order,
                            # and the only way to read back which option was chosen
  comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  comm.get_message          {conversationId, messageId}

Read receipts
  comm.unread               {conversationId}                         # GET  /conversations/{id}/unread
  comm.mark_read            {conversationId, seq}                    # POST /conversations/{id}/read

Search (KB pages only)
  comm.search               {query, kbId?, limit?, offset?, sort?}   # GET /search/pages

Sync (WS reconnect catch-up)
  comm.sync                 {sinceSeq, deviceId, limit?}             # POST /sync

Owner (local cache ↔ cws-core authoritative)
  comm.sync_owner           {org?}                  # pull authoritative owner from core into config

DM access control (local config, hot-reloaded by running service)
  comm.dm_policy            {org?, policy?}                          # show or set dmPolicy (open|allowlist|owner)
  comm.dm_list              {org?}                                   # list current dmPolicy + dmAllowFrom
  comm.dm_allow             {memberId|memberIds, org?}               # add member(s) to dmAllowFrom
  comm.dm_revoke            {memberId|memberIds, org?}               # remove member(s) from dmAllowFrom

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
