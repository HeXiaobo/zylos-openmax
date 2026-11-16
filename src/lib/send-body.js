/**
 * Send-message body: shared by `comm.send` (src/cli/comm.js) and the
 * `[STRUCTURED]{…}` body of the C4 outbound entry (scripts/send.js).
 *
 * The body builder and its checks moved here unchanged from comm.js, so the
 * two entries cannot build different messages from the same input; error
 * messages name the entry that was used (`verb`, default `comm.send`).
 *
 * `[STRUCTURED]` exists so that every send can go through `c4-send` (and so
 * leave a C4 conversation-log row): a structured message, explicit mentions,
 * metadata, a fallback text or already-uploaded attachments were only possible
 * through `comm.send` before, which bypasses C4 entirely. Layering as for
 * `[CARD]` (src/lib/card-message.js): parsing, validation and the send live
 * here because `scripts/` has no test surface; `scripts/send.js` only
 * dispatches.
 *
 * 🔴 The payload is INLINE JSON (the C4 row stores the body verbatim, so it
 * stays readable on its own), and a malformed one is an error, NEVER posted as
 * chat text.
 *
 * Mentions are only ever explicit (`mentions`): `@name` in a text body is plain
 * text, and nothing is resolved from it. A member is mentioned by member_id
 * (`comm.member_list` gives them); a broadcast by `{type:"all"}` (every human
 * member) or `{type:"all_agents"}` (every agent member). cws-comm stores only the
 * mentions the client sends; it never parses the body.
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
 *     mentions?: [{type: "member", member_id} | {type: "all"} | {type: "all_agents"}, ...]
 *   }
 */

import { randomUUID } from 'crypto';
import { looksLikeMarkdown } from './message.js';
import { attachRunMetadata, postWithRunMetadata, semanticBodyHash } from './activity/reply.js';
import { SOURCE_MESSAGE_ID_RE } from './activity/constants.js';

export function ensureClientMsgId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * Build the cws-core v5 send-message body from caller input.
 *
 * Caller can pass:
 *   - string                                            → text/markdown auto-detect
 *   - {text} | {body}                                   → text/markdown auto-detect
 *   - {text?, attachments:[...]} (or string content plus
 *     top-level params.attachments)                     → IMAGE / FILE message
 *   - {content_type, body, attachments?}                → pass-through (advanced)
 *   - already-built object with top-level type+content  → returned as-is
 *
 * Attachments given with shorthand content are carried, never dropped. Each
 * item, shorthand or in a pre-built content object, must already be in the
 * wire shape {artifact_id, file_name, content_type, size_bytes}: artifact_id,
 * file_name and content_type non-empty strings, size_bytes a non-negative
 * integer (cws-core requires it on every item), and no camel-case keys
 * (as.upload returns artifactId / fileName / mimeType / sizeBytes, which must
 * be renamed, not passed through). Anything else is refused before sending —
 * items are passed through verbatim, so a half-renamed item would otherwise go
 * out with no artifact_id or an empty file name, and an image downgraded to a
 * file. All items with an `image/*` content_type (case-insensitive) make an
 * IMAGE message, anything else a FILE message — the same body shape the
 * `[MEDIA:image]` / `[MEDIA:file]` outbound path builds (buildMediaBody).
 * A message with no text and no attachments is refused instead of being posted
 * as a blank message, and array content is refused rather than read as one.
 *
 * `mentions` (array of member_id strings, or `{type, member_id?}` objects) is
 * sent as given; without it the message mentions nobody.
 */
const ATTACHMENT_SHAPE = '{artifact_id, file_name, content_type, size_bytes} — snake_case, with artifact_id = the '
  + 'artifactId returned by as.upload (not mediaId), file_name = its fileName, content_type = its mimeType, '
  + 'size_bytes = its sizeBytes. Or send the file with c4-send.js "[MEDIA:image]/abs/path" / "[MEDIA:file]/abs/path".';
const CAMEL_ATTACHMENT_KEYS = ['artifactId', 'fileName', 'mimeType', 'contentType', 'sizeBytes'];

export function shorthandAttachments(params, verb = 'comm.send') {
  const c = params.content;
  const fromContent = (c && typeof c === 'object' && !Array.isArray(c)) ? c.attachments : undefined;
  const fromParams = params.attachments;
  if (fromContent !== undefined && fromParams !== undefined) {
    throw new Error(`${verb}: attachments given both in content.attachments and top-level attachments — pass them in one place`);
  }
  const list = fromContent ?? fromParams;
  if (list === undefined || list === null) return [];
  return validateAttachments(list, verb);
}

// Both the shorthand and the pre-built content object pass attachment items
// through verbatim, so both are held to the same wire shape.
export function validateAttachments(list, verb = 'comm.send') {
  if (!Array.isArray(list)) throw new Error(`${verb}: attachments must be an array`);
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  list.forEach((a, i) => {
    const bad = (why) => new Error(`${verb}: attachments[${i}] ${why} — each attachment must be ${ATTACHMENT_SHAPE}`);
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('is not an object');
    const camel = CAMEL_ATTACHMENT_KEYS.filter((k) => k in a);
    if (camel.length) throw bad(`has camel-case key(s) ${camel.join(', ')}`);
    for (const k of ['artifact_id', 'file_name', 'content_type']) {
      if (!nonEmpty(a[k])) throw bad(`has no ${k}`);
    }
    if (!Number.isInteger(a.size_bytes) || a.size_bytes < 0) throw bad('has no size_bytes (a non-negative integer)');
  });
  return list;
}

export function isEmptyContent(body, attachments) {
  if (Array.isArray(attachments) && attachments.length > 0) return false;
  if (!body || typeof body !== 'object') return true;
  return Object.entries(body).every(([k, v]) => v === undefined || v === null || v === ''
    || (k === 'text' && typeof v === 'string' && !v.trim()));
}

// A broadcast — MentionInput {type:"all"} (every human member only) /
// {type:"all_agents"} (every Agent member only) — is sent ONLY when the caller
// passes it in `mentions`; body text such as "@所有人" is plain text. cws-comm
// refuses a broadcast the sender may not use with ErrMentionAllNotAllowed (HTTP
// 403, detail "mention all not allowed"): only a group conversation (a
// sub-conversation follows its parent group), with the org flag on and the
// sender's role allowed by the group's mention_all_policy. GET
// /conversations/{id} returns that same caller-perspective answer as
// can_mention_all, so it is checked first and a refusal says why. Never
// downgraded: the mention is not dropped and the message is not sent without it.
// Shared by comm.send and [STRUCTURED] (scripts/send.js), the same helpers as
// the 2.34.1 hotfix (#284).
const BROADCAST_MENTION_TYPES = new Set(['all', 'all_agents']);
const MENTION_ALL_NOT_ALLOWED_RE = /mention all not allowed/i;

export function broadcastMentionTypes(mentions) {
  return Array.isArray(mentions)
    ? mentions.map((m) => m?.type).filter((t) => BROADCAST_MENTION_TYPES.has(t))
    : [];
}

export function mentionAllNotAllowedError(verb, conversationId, types, why) {
  return Object.assign(
    new Error(`${verb}: broadcast mention (${types.map((t) => `{type:"${t}"}`).join(', ')}) is not allowed in conversation `
      + `${conversationId} — ${why}. Nothing was sent. Remove the broadcast from mentions, or mention the `
      + 'members you need individually ({type:"member", member_id}).'),
    { status: 403, code: 'mention_all_not_allowed' },
  );
}

// Refuse before sending when the conversation says this sender may not
// broadcast. A failed lookup, or a backend without can_mention_all, warns and
// lets the send go: cws-comm still enforces the rule, and its refusal is turned
// into the same error by rethrowMentionAllNotAllowed below. `deps.get` is the
// caller's org-scoped GET and `deps.apiPath` its path builder.
export async function assertMayBroadcast(params, mentions, verb, { get, apiPath }) {
  const types = broadcastMentionTypes(mentions);
  if (!types.length) return;
  let conv;
  try {
    conv = await get(apiPath(`/conversations/${params.conversationId}`));
  } catch (e) {
    console.warn(`[${verb}] could not check can_mention_all for conversation ${params.conversationId} (${e.message}); sending, the server decides`);
    return;
  }
  if (conv?.can_mention_all === false) {
    throw mentionAllNotAllowedError(verb, params.conversationId, types,
      'can_mention_all is false (only a group allows it, and its @all policy may limit it to the owner/admins)');
  }
  if (typeof conv?.can_mention_all !== 'boolean') {
    console.warn(`[${verb}] conversation ${params.conversationId} did not report can_mention_all; sending, the server decides`);
  }
}

export function rethrowMentionAllNotAllowed(err, params, mentions, verb) {
  const types = broadcastMentionTypes(mentions);
  if (types.length && err?.status === 403 && MENTION_ALL_NOT_ALLOWED_RE.test(err.message)) {
    throw mentionAllNotAllowedError(verb, params.conversationId, types, `the server refused it (${err.message})`);
  }
  throw err;
}

// cws-comm caps an explicit fallback_text at 8192 UTF-8 bytes (domain
// MaxFallbackTextBytes), for every message type; cws-core forwards it unchecked.
// An exception to the "no local cap" rule of interaction-request.js: it mirrors
// cws-comm's ValidateFallbackTextBytes exactly (same number, same byte
// semantics), so it can never be stricter, and it fails fast — before any
// request — with a clearer error than the server's.
export const MAX_FALLBACK_TEXT_BYTES = 8192;

// `metadata.context` is reserved for the upcoming platform metadata governance
// (message context), so a caller may not supply it. Neither cws-core nor
// cws-comm reserves it yet: until the server enforces it, this refusal is a
// courtesy check, not a security boundary.
const RESERVED_METADATA_KEYS = ['context'];

/**
 * Optional `metadata` (a plain JSON object) and `fallback_text` (a string of at
 * most 8192 UTF-8 bytes) for the send-message body, passed through unchanged.
 * Used by e.g. AGENT_STRUCTURED senders that set their own content_type and a
 * plain-text preview. Read from the top-level params and, for an advanced
 * caller, from a pre-built `params.body` — the same rules hold for both, and
 * giving one field in both places is refused rather than resolved by
 * precedence. `fallbackText` is accepted as the camel-case alias.
 *
 * The CLI sets no metadata key of its own (agent_run is a top-level field), so
 * there is nothing for the caller's metadata to clobber or be merged with.
 * Returns only the fields that were given: absent → `{}`, body unchanged.
 */
export function readSendExtras(params, verb) {
  // The same condition buildSendBody uses: a body without content and type is
  // not a pre-built body and is ignored there, so its fields are ignored here.
  const advanced = (params.body && params.body.content && params.body.type) ? params.body : {};
  const pick = (name, sources) => {
    const given = sources.filter(([, v]) => v !== undefined);
    if (given.length > 1) {
      throw new Error(`${verb}: ${name} given both as ${given.map(([k]) => k).join(' and ')} — pass it in one place`);
    }
    return given[0]?.[1];
  };
  const metadata = pick('metadata', [['metadata', params.metadata], ['body.metadata', advanced.metadata]]);
  const fallbackText = pick('fallback_text', [
    ['fallback_text', params.fallback_text],
    ['fallbackText', params.fallbackText],
    ['body.fallback_text', advanced.fallback_text],
  ]);
  const out = {};
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`${verb}: metadata must be a plain JSON object, got `
        + `${Array.isArray(metadata) ? 'an array' : metadata === null ? 'null' : typeof metadata}`);
    }
    const reserved = RESERVED_METADATA_KEYS.filter((k) => Object.hasOwn(metadata, k));
    if (reserved.length) {
      throw new Error(`${verb}: metadata.${reserved[0]} is reserved for the upcoming platform metadata governance `
        + '(message context); a sender must not set it. Put your own fields under another key.');
    }
    out.metadata = metadata;
  }
  if (fallbackText !== undefined) {
    if (typeof fallbackText !== 'string') {
      throw new Error(`${verb}: fallback_text must be a string, got `
        + `${Array.isArray(fallbackText) ? 'an array' : fallbackText === null ? 'null' : typeof fallbackText}`);
    }
    const bytes = Buffer.byteLength(fallbackText, 'utf8');
    if (bytes > MAX_FALLBACK_TEXT_BYTES) {
      throw new Error(`${verb}: fallback_text is ${bytes} UTF-8 bytes; the limit is ${MAX_FALLBACK_TEXT_BYTES}`);
    }
    out.fallback_text = fallbackText;
  }
  return out;
}

export function buildSendBody(params, extras = readSendExtras(params, 'comm.send'), verb = 'comm.send') {
  // Allow advanced caller to override completely
  if (params.body && params.body.content && params.body.type) {
    // `agent_run` is never the caller's: it is added by this CLI itself
    // (attachRunMetadata), from the local run files.
    const { agent_run: _callerAgentRun, ...advanced } = params.body;
    return {
      client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
      ...advanced,
      ...(params.replyTo ? { parent_id: params.replyTo } : {}),
      ...extras,
    };
  }
  const c = params.content;
  let msgType = params.type;
  let contentType, body, attachments;
  if (c && typeof c === 'object' && c.content_type) {
    // pre-built content object
    if (params.attachments !== undefined) {
      throw new Error(`${verb}: top-level attachments cannot be combined with a pre-built content object — put them in content.attachments`);
    }
    if (c.body !== undefined && (!c.body || typeof c.body !== 'object' || Array.isArray(c.body))) {
      throw new Error(`${verb}: a pre-built content object needs body to be an object ({text} or {file_name, text?}), `
        + `got ${Array.isArray(c.body) ? 'an array' : c.body === null ? 'null' : typeof c.body}`);
    }
    contentType = c.content_type;
    body        = c.body ?? {};
    attachments = (c.attachments === undefined || c.attachments === null) ? [] : validateAttachments(c.attachments, verb);
    if (!msgType) msgType = contentType === 'image' ? 'IMAGE'
                       : contentType === 'file' ? 'FILE'
                       : 'AGENT_TEXT';
  } else {
    if (Array.isArray(c)) {
      throw new Error(`${verb}: content cannot be an array (of parts) — pass a string, {text}, `
        + '{text?, attachments:[...]} or a pre-built {content_type, body, attachments?} object');
    }
    const text = (typeof c === 'string') ? c
              : (c && typeof c === 'object') ? (c.text ?? c.body ?? '')
              : '';
    attachments = shorthandAttachments(params, verb);
    if (attachments.length > 0) {
      const allImages = attachments.every((a) => a.content_type.toLowerCase().startsWith('image/'));
      contentType = allImages ? 'image' : 'file';
      body        = { file_name: attachments[0].file_name, ...(String(text) ? { text: String(text) } : {}) };
      if (!msgType) msgType = allImages ? 'IMAGE' : 'FILE';
    } else {
      contentType = looksLikeMarkdown(text) ? 'markdown' : 'text';
      body        = { text: String(text) };
      if (!msgType) msgType = 'AGENT_TEXT';
    }
  }
  if (isEmptyContent(body, attachments)) {
    throw new Error(`${verb}: refusing to send an empty message (no text and no attachments). `
      + 'Pass content as a non-empty string or {text}, or attach files via {text?, attachments:[{artifact_id, ...}]}.');
  }
  // Mentions are explicit only: cws-comm stores exactly the mentions the
  // client sends and never parses `@name` out of the text, and neither does
  // this builder. A member_id string is shorthand for {type:'member', member_id}.
  const mentions = Array.isArray(params.mentions)
    ? params.mentions.map((m) => (typeof m === 'string' ? { type: 'member', member_id: m } : m))
    : undefined;
  return {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    type:          msgType,
    content:       { content_type: contentType, body, attachments },
    ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    ...(mentions ? { mentions } : {}),
    ...extras,
  };
}

// `noRun: true` marks a system-originated notice: it is no run's reply, so it
// carries no agent_run and claims no run. Only a real boolean is accepted.
export function readNoRun(params, verb) {
  const v = params.noRun;
  if (v !== undefined && typeof v !== 'boolean') throw new Error(`${verb}: noRun must be a boolean`);
  return v === true;
}

// `sourceMessageId` (OPENM-1337): the inbound message this send answers — the
// source-message-id of its <message-context>. It only selects that message's
// run for agent_run (never sent; no run with that source → no agent_run).
// Optional; when given it must be the id as a string of digits.
export function readSourceMessageId(params, verb) {
  const v = params.sourceMessageId;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !SOURCE_MESSAGE_ID_RE.test(v)) {
    throw new Error(`${verb}: sourceMessageId must be the source-message-id of <message-context>, as a string of digits`);
  }
  return v;
}

// ============================================================
// [STRUCTURED]{…} — the c4-send entry for a structured message
// ============================================================

export const STRUCTURED_PREFIX = '[STRUCTURED]';

export class StructuredMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StructuredMessageError';
  }
}

/**
 * The endpoint decides the conversation, its org, the quoted message
 * (`|reply:`) and the run (`|msg:`); a payload that names any of them is
 * refused rather than ignored (same rule as `[CARD]`).
 */
const ENDPOINT_OWNED_KEYS = ['conversationId', 'org', 'orgSlug', 'orgId', 'org_id', 'replyTo', 'sourceMessageId', 'noRun'];

/** Every key a `[STRUCTURED]` payload may carry. Anything else is refused. */
const STRUCTURED_KEYS = new Set(['type', 'content', 'attachments', 'mentions', 'metadata', 'fallback_text', 'fallbackText', 'clientMsgId']);

function validateMentions(mentions) {
  if (mentions === undefined) return;
  if (!Array.isArray(mentions)) {
    throw new StructuredMessageError('[STRUCTURED] mentions must be an array of member ids or {type, member_id?} objects');
  }
  mentions.forEach((m, i) => {
    if (typeof m === 'string' && m.trim()) return;
    if (m && typeof m === 'object' && !Array.isArray(m) && typeof m.type === 'string' && m.type) {
      if (m.type === 'member' && !(typeof m.member_id === 'string' && m.member_id.trim())) {
        throw new StructuredMessageError(`[STRUCTURED] mentions[${i}] of type "member" needs a member_id`);
      }
      return;
    }
    throw new StructuredMessageError(
      `[STRUCTURED] mentions[${i}] must be a member id string, {type:"member", member_id}, {type:"all"} or {type:"all_agents"}`,
    );
  });
}

/**
 * Recognize and validate a `[STRUCTURED]` message.
 *
 * Payload: `{type?, content, attachments?, mentions?, metadata?, fallback_text?,
 * clientMsgId?}` — the `comm.send` fields minus everything the endpoint decides.
 * `content` is a string, `{text}`, `{text?, attachments:[…]}` (text plus
 * already-uploaded files) or a pre-built `{content_type, body, attachments?}`.
 *
 * @returns {null|{params:object, extras:object}} null when the message is not
 *   `[STRUCTURED]`; otherwise the comm.send-style params and extras, already
 *   checked by the body builder's own rules.
 * @throws {StructuredMessageError|Error} when it IS `[STRUCTURED]` and is malformed.
 */
export function parseStructuredMessage(message) {
  const text = typeof message === 'string' ? message : '';
  const body = text.trimStart();
  if (!body.startsWith(STRUCTURED_PREFIX)) return null;

  const raw = body.slice(STRUCTURED_PREFIX.length).trim();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new StructuredMessageError(`[STRUCTURED] payload is not valid JSON: ${e.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new StructuredMessageError('[STRUCTURED] payload must be a JSON object');
  }
  for (const key of ENDPOINT_OWNED_KEYS) {
    if (key in payload) {
      throw new StructuredMessageError(
        `[STRUCTURED] payload must not set \`${key}\`: the endpoint passed to send.js decides the target conversation, its org, the quoted message and the run`,
      );
    }
  }
  const unknown = Object.keys(payload).filter((k) => !STRUCTURED_KEYS.has(k));
  if (unknown.length) {
    throw new StructuredMessageError(
      `[STRUCTURED] unknown key(s) ${unknown.join(', ')} — accepted: ${[...STRUCTURED_KEYS].join(', ')}`,
    );
  }
  if (payload.content === undefined) {
    throw new StructuredMessageError('[STRUCTURED] payload needs `content`');
  }
  if (payload.type !== undefined && (typeof payload.type !== 'string' || !payload.type.trim())) {
    throw new StructuredMessageError('[STRUCTURED] type must be a non-empty string (e.g. "AGENT_STRUCTURED")');
  }
  if (payload.clientMsgId !== undefined && (typeof payload.clientMsgId !== 'string' || !payload.clientMsgId)) {
    throw new StructuredMessageError('[STRUCTURED] clientMsgId must be a non-empty string');
  }
  validateMentions(payload.mentions);
  const extras = readSendExtras(payload, '[STRUCTURED]');
  // Build once to run every content / attachment check now, before anything is
  // sent; the send builds again with the endpoint's conversation and reply.
  buildSendBody(payload, extras, '[STRUCTURED]');
  return { params: payload, extras };
}

/**
 * Send a parsed `[STRUCTURED]` message: one POST, never split. The body is
 * comm.send's; agent_run is attached exactly as for comm.send (claim keyed by
 * the body's client_msg_id; the endpoint's `|msg:` selects the run).
 *
 * @param {string} conversationId - from the endpoint
 * @param {{params:object, extras:object}} parsed - parseStructuredMessage result
 * An explicit broadcast is checked against the conversation's can_mention_all
 * first (assertMayBroadcast), exactly as for comm.send.
 *
 * @param {object} deps
 * @param {function} deps.post - (path, body) => Promise<response>
 * @param {function} deps.get - (path) => Promise<conversation>, same org as post
 * @param {function} deps.apiPath
 * @param {string} [deps.replyTo] - the endpoint's `|reply:`
 * @param {string|null} [deps.sourceMessageId] - the endpoint's `|msg:`
 * @param {object} [deps.runStore] - test hook
 */
export async function sendStructuredMessage(conversationId, parsed, deps) {
  const params = {
    ...parsed.params,
    conversationId,
    ...(deps.replyTo ? { replyTo: deps.replyTo } : {}),
  };
  const body = buildSendBody(params, parsed.extras, '[STRUCTURED]');
  // An explicit broadcast is checked against can_mention_all before any run
  // claim or send (see assertMayBroadcast).
  await assertMayBroadcast(params, body.mentions, '[STRUCTURED]', deps);
  const plan = attachRunMetadata({
    convId: conversationId,
    sourceMessageId: deps.sourceMessageId ?? null,
    kind: body.content?.content_type === 'image' || body.content?.content_type === 'file' ? 'media' : 'text',
    body,
    bodyHash: () => semanticBodyHash(body),
    clientMsgIdSupplied: !!parsed.params.clientMsgId,
    ...(deps.runStore ? { store: deps.runStore } : {}),
  });
  const res = await postWithRunMetadata(
    deps.post,
    deps.apiPath(`/conversations/${conversationId}/messages`),
    body,
    plan,
    deps.runStore ? { store: deps.runStore } : {},
  ).catch((e) => rethrowMentionAllNotAllowed(e, params, body.mentions, '[STRUCTURED]'));
  return { ok: true, structured: true, message_id: res?.id || res?.message_id || null };
}
