#!/usr/bin/env node

/**
 * C4 standard outbound interface — directly calls cws-core OpenAPI
 * `POST /api/v1/conversations/{conversation_id}/messages`.
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Every agent send goes through here (via c4-send), so it is recorded in C4
 * and, on a multi-session Core, checked against the thread that owns the
 * conversation (scripts/session-group.js).
 *
 * Endpoint forms (per docs/DESIGN.md §3.4; encoded by C4):
 *   <conversationId>
 *   <conversationId>|type:<dm|group|sub>       (multi-session Core; routing ignores it)
 *   any of the above + `|reply:<messageId>` (quote) and/or `|msg:<sourceMessageId>`:
 *   the inbound message this reply answers — selects that message's run for
 *   agent_run (OPENM-1337); not sent to the server, not a quote
 * The legacy `[OPENMAX DM|GROUP]/<conversationId>...` form is still accepted.
 * A legacy thread endpoint (`|thread:…|parent:…`, `[OPENMAX THREAD]/`) is sent
 * to its leading conversation as an ordinary message, with a warning on
 * stderr (2.35.x only; refused from 2.36.0): the platform has no threads.
 *
 * Message body forms (dispatched by prefix):
 *   plain text         → content={content_type:"text", body:{text}}
 *   markdown-looking   → content={content_type:"markdown", body:{text}}   (heuristic)
 *   [MEDIA:image]/path → upload via as.js → type IMAGE, content.attachments[].artifact_id=<artifactId>
 *   [MEDIA:file]/path  → upload via as.js → type FILE,  content.attachments[].artifact_id=<artifactId>
 *                         (see sendMediaMessage — the media id is NOT renderable)
 *                         line 2 may be `[MENTIONS][…]` (explicit mentions, the
 *                         [STRUCTURED] shape); the rest is the caption — see
 *                         src/lib/media-message.js. A [MEDIA:…] tag that starts
 *                         a LATER line fails the send (MEDIA_NOT_FIRST).
 *   [CARD]{...json...}  → POST .../interaction-requests: a question card
 *                         (kind + askedOf; options or fields), recording what
 *                         was asked, or a display card (no kind / askedOf, no
 *                         answering option, e.g. onboarding.partner), recording
 *                         nothing — see src/lib/card-message.js
 *                         (carries agent_run like a text reply)
 *   [STRUCTURED]{...json...} → one POST .../messages built like comm.send:
 *                         {type?, content, attachments?, mentions?, metadata?,
 *                         fallback_text?, clientMsgId?} — see src/lib/send-body.js
 *
 * Long text is split into ≤3000-char chunks (paragraph → newline → hard) and
 * sent as sequential POSTs to the same conversation. Each chunk gets its own
 * client_msg_id so the server de-dupes them independently. `reply_to` is
 * applied only on the first chunk to avoid duplicate threading.
 *
 * cws-core SendMessageRequestBody (current schema, per
 * internal/transport/http/message.go:sendMessageRequest):
 *   { client_msg_id, type, content: MessageContentItem, parent_id?,
 *     thread_id?, ttl?, metadata? }
 *   type: enum UNSPECIFIED|TEXT|IMAGE|FILE|AUDIO|VIDEO|SYSTEM|AGENT_TEXT|
 *     AGENT_STRUCTURED|AGENT_CARD|AGENT_STREAM
 *   MessageContentItem: { content_type, body: object, attachments: [] }
 *
 * mentions (MentionInput[]) are sent only when given explicitly, in a
 * [STRUCTURED] body or a [MEDIA:…] message's [MENTIONS] line: `@name` in text
 * (or in a caption) is plain text. cws-comm only stores
 * mentions the client supplies and never parses them out of the text.
 *
 * Auth: Bearer api_key (canonical store: config.agent.api_key) plus
 *       X-Workspace-Id header (handled by client.js).
 */

import fs from 'fs';
import path from 'path';
import { post, get, getForOrg, apiPath, reacquireToken } from '../src/lib/client.js';
import { withAuthRetry } from '../src/lib/auth-retry.js';
import { enabledOrgs } from '../src/lib/config.js';
import {
  parseEndpoint,
  newClientMsgId,
  splitMessage,
} from '../src/lib/message.js';
import { uploadMedia } from '../src/cli/as.js';
import { parseCardMessage, sendCardMessage } from '../src/lib/card-message.js';
import {
  parseStructuredMessage, sendStructuredMessage, assertMayBroadcast, rethrowMentionAllNotAllowed,
} from '../src/lib/send-body.js';
import { parseMediaMessage, assertNoMisplacedMediaTag, assertNoMentionsWithoutMedia } from '../src/lib/media-message.js';
import { lookupConvOrg, registerConvOrg, convRecordFields } from '../src/lib/conv-org.js';
import { RUNTIME_DIR } from '../src/lib/session.js';
import {
  planReplyMetadata, attachRunToCardRequest, classifySendError, sha256, semanticBodyHash,
} from '../src/lib/activity/reply.js';
import { buildTextBody, buildMediaBody } from '../src/lib/outbound-body.js';
import { SENT_DIR, writeSentMarker, sentMessageId } from '../src/lib/dm-seen-watch.js';

const TYPING_DIR = path.join(RUNTIME_DIR, 'typing');

function markTypingDone(messageId) {
  if (!messageId) return;
  const safe = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(path.join(TYPING_DIR, `${safe}.done`), String(Date.now()));
  } catch {}
}

function usage() {
  console.error('Usage: node scripts/send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  <conversationId>[|type:dm|group|sub][|reply:<messageId>][|msg:<sourceMessageId>]');
  console.error('  (legacy [OPENMAX DM|GROUP]/<conversationId>... is still accepted)');
  console.error('');
  console.error('Message: plain text, markdown (auto-detected),');
  console.error('         [MEDIA:image|file]/abs/path (the tag must start the message; optional next line');
  console.error('           [MENTIONS]["<member id>",{"type":"all_agents"},..], then an optional caption),');
  console.error('         [CARD]{"title":..,"summary":..,"text":..,"options":[..],"kind":..,"askedOf":..} (question card),');
  console.error('         [CARD]{"cardKind":..,"title":..,"options":[{"label":..,"behavior":..}]} (display card),');
  console.error('         or [STRUCTURED]{"content":..,"mentions"?:[..],"metadata"?:{..},"fallback_text"?:..}');
}

async function sendText(ep, text) {
  const convId = ep.conversationId;
  // Long text is split; `@name` is plain text (no mentions are derived from
  // it — explicit mentions go in a [STRUCTURED] body).
  const chunks = splitMessage(text);
  // Agent activity: the run this reply answers, if any (null when the feature
  // is off or no run is registered for the conversation). The first chunk
  // carries the full agent_run, later chunks the reference form.
  const bodies = chunks.map((chunk, i) => buildTextBody({ text: chunk, replyTo: ep.replyTo, first: i === 0 }));
  // Retry hash = the first chunk's whole semantic body (text, parent_id,
  // mentions, type), so a resend that changes any of them never reuses the
  // first attempt's client_msg_id. See semanticBodyHash.
  const plan = bodies.length
    ? planReplyMetadata({ convId, sourceMessageId: ep.sourceMessageId, kind: 'text', bodyHash: () => semanticBodyHash(bodies[0]), newKey: newClientMsgId })
    : null;
  const results = [];
  for (let i = 0; i < bodies.length; i++) {
    const agentRun = plan ? (i === 0 ? plan.firstAgentRun : plan.laterAgentRun) : null;
    const body = {
      client_msg_id: (i === 0 && plan?.clientMsgId) || newClientMsgId(),
      ...bodies[i],
      ...(agentRun ? { agent_run: agentRun } : {}),
    };
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await post(apiPath(`/conversations/${convId}/messages`), body);
    } catch (e) {
      if (i === 0) plan?.settle(classifySendError(e));
      throw e;
    }
    if (i === 0) plan?.settle('ok');
    results.push(res?.id || res?.message_id || null);
  }
  return { ok: true, chunks: chunks.length, message_ids: results };
}

async function sendMediaMessage(ep, { kind, localPath, caption, mentions }) {
  const convId = ep.conversationId;
  const contentType = kind === 'image' ? 'image' : 'file';
  // An explicit broadcast is checked against can_mention_all BEFORE the upload
  // (as [STRUCTURED] does before its POST): a refused one uploads nothing.
  await assertMayBroadcast({ conversationId: convId }, mentions, '[MEDIA]', { get: (p) => get(p), apiPath });
  // IM-mode finalize returns BOTH `mediaId` and `artifactId` as *distinct* UUIDs:
  //   - `mediaId`    : cws-comm-internal media reference (lives on the message)
  //   - `artifactId` : cws-as artifact id (the actual blob in storage)
  // The chat message's `attachments[].artifact_id` field must hold the
  // cws-as id so that any consumer (FE / agent) can `as.resolve` it to a
  // download URL. Using `mediaId` instead yields a "image loading…" forever
  // placeholder because cws-as has no record of that id. See group thread
  // 2026-06-04 22:24 HKT for the cross-agent investigation.
  // uploadMedia returns the resolved MIME under `mimeType`; older shapes used
  // `contentType`. Read `mimeType` first and fall back to `contentType` so the
  // attachment's content_type isn't dropped (issue #8) — otherwise the
  // outbound message ships an empty MIME and the FE can't render the image.
  const { mediaId, artifactId, fileName, mimeType, contentType: legacyContentType, sizeBytes } = await uploadMedia(localPath, {
    conversationId: convId,
    mediaType: contentType,
  });
  const semantic = buildMediaBody({
    kind,
    fileName,
    caption,
    artifactId,
    mediaId,
    mimeType: mimeType || legacyContentType || '',
    sizeBytes,
    replyTo: ep.replyTo,
    mentions,
  });
  // Agent activity (see sendText). Retry hash = the whole semantic body with
  // the file's content digest in place of the artifact id (every attempt
  // uploads again and gets a new one); computed only when a run is found.
  const plan = planReplyMetadata({
    convId,
    sourceMessageId: ep.sourceMessageId,
    kind: 'media',
    bodyHash: () => semanticBodyHash(semantic, { attachmentDigests: [sha256(fs.readFileSync(localPath))] }),
    newKey: newClientMsgId,
  });
  const agentRun = plan?.firstAgentRun;
  const body = {
    client_msg_id: plan?.clientMsgId || newClientMsgId(),
    ...semantic,
    ...(agentRun ? { agent_run: agentRun } : {}),
  };
  let res;
  try {
    res = await post(apiPath(`/conversations/${convId}/messages`), body);
  } catch (e) {
    plan?.settle(classifySendError(e));
    rethrowMentionAllNotAllowed(e, { conversationId: convId }, mentions, '[MEDIA]');
  }
  plan?.settle('ok');
  return res;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) { usage(); process.exit(1); }

  const [endpoint, ...messageParts] = args;
  const message = messageParts.join(' ');

  // Smart-mode escape hatch: when formatInboundForC4 emits a <smart-mode>
  // block, the LLM may decide to stay silent by replying with the literal
  // string "[SKIP]". Treat that as a no-op so we don't actually post it.
  // Mirrors zylos-feishu/scripts/send.js:64.
  if (message.trim() === '[SKIP]') {
    console.log(JSON.stringify({ ok: true, skipped: true }));
    return;
  }

  let ep;
  try {
    ep = parseEndpoint(endpoint);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
  // 2.35.x compatibility: the platform has no threads, so a stored legacy
  // thread endpoint goes to its leading conversation as an ordinary message
  // (the parent named a message inside the thread, so it is no quote here).
  // From 2.36.0 this is refused.
  if (ep.legacyThread) {
    console.warn(`[send] DEPRECATED: legacy thread endpoint ${JSON.stringify(endpoint)} — the thread part is ignored and the message goes to conversation ${ep.conversationId}. Thread endpoints are refused from openmax 2.36.0; use the conversation id (or the reply via endpoint) instead.`);
  }

  // Multi-org: resolve the conversation's org so downstream API calls use
  // the correct org-scoped JWT. Without this, resolveDefaultOrgId() returns
  // empty when 2+ orgs are enabled, producing an identity-only token → 401.
  if (!process.env.COCO_ORG_ID) {
    const convId = ep.conversationId;
    let orgId = lookupConvOrg(convId);

    // Fallback: outbound-first DMs have no map entry yet. Reverse-lookup by
    // trying each enabled org until one can access the conversation.
    if (!orgId) {
      for (const org of enabledOrgs()) {
        try {
          const conv = await getForOrg(org.org_id, apiPath(`/conversations/${convId}`));
          orgId = org.org_id;
          // The record is at hand: keep its type too (conv-org-map.json), so
          // the session-group query never has to look it up again.
          registerConvOrg(convId, orgId, convRecordFields(conv?.data && !conv.type ? conv.data : conv));
          break;
        } catch { /* 401/403/404 → try next org */ }
      }
    }

    if (orgId) process.env.COCO_ORG_ID = orgId;
  }

  try {
    // Prefix dispatch, and nothing more: what a `[CARD]` or `[STRUCTURED]`
    // body means, and what a malformed one costs, lives in
    // src/lib/card-message.js / src/lib/send-body.js, where there is a test
    // surface. A body that fails to parse throws out of here into the catch
    // below — it is NEVER downgraded to sendText, because posting the raw JSON
    // as chat looks, to this agent, exactly like having sent it.
    const structured = parseStructuredMessage(message);
    const card = structured ? null : parseCardMessage(message);
    // A [MEDIA:…] message, its optional [MENTIONS] line included, is checked
    // here, before any upload; a malformed one throws (src/lib/media-message.js).
    const media = (structured || card) ? null : parseMediaMessage(message);
    // Plain text whose [MEDIA:…] tag starts a later line would go out as text
    // with the local path and no file: refused, nothing sent.
    // Likewise text with a line starting with [MENTIONS] (outside fenced code)
    // would mention nobody: refused, pointing to [STRUCTURED].
    // The MEDIA check runs first: when both are present, the root error is the
    // tag not on line 1 (the [MENTIONS] line is then just its line 2).
    if (!structured && !card && !media) {
      assertNoMisplacedMediaTag(message);
      assertNoMentionsWithoutMedia(message);
    }
    // Taken before the request: the watch reads it as "sent no later than",
    // and the response can come back after the peer has already reacted.
    const sentAt = Date.now();
    const authRetryPost = (label) => (p, body) => withAuthRetry(() => post(p, body), {
      label,
      reacquire: ({ force }) => reacquireToken(process.env.COCO_ORG_ID, { force }),
    });
    let result;
    if (structured) {
      // One POST, built like comm.send; a 401 is re-sent a bounded number of
      // times with the same client_msg_id (src/lib/auth-retry.js).
      result = await sendStructuredMessage(ep.conversationId, structured, {
        post: authRetryPost('[STRUCTURED]'),
        // The broadcast gate's can_mention_all lookup: same org as the POST
        // (COCO_ORG_ID is resolved above).
        get: (p) => get(p),
        apiPath,
        replyTo: ep.replyTo,
        sourceMessageId: ep.sourceMessageId,
      });
    } else if (card) {
      // A 401 on the card (token rotated mid-flight) is re-sent a bounded
      // number of times before it is reported as a failed send — see
      // src/lib/auth-retry.js. The request is built once, so a retry carries
      // the same client_msg_id and cannot post a second card.
      const cardConvId = ep.conversationId;
      result = await sendCardMessage(cardConvId, card, {
        post: authRetryPost('[CARD]'),
        // Agent activity: the card carries agent_run like a text
        // reply (claim keyed by the card's client_msg_id; onboarding cards
        // skipped). See attachRunToCardRequest.
        attachRun: (request) => attachRunToCardRequest({
          convId: cardConvId,
          sourceMessageId: ep.sourceMessageId,
          request,
          clientMsgIdSupplied: card.card?.clientMsgId !== undefined,
        }),
      });
    }
    else if (media) result = await sendMediaMessage(ep, media);
    else result = await sendText(ep, message);
    markTypingDone(ep.replyTo || ep.conversationId);
    writeSentMarker(SENT_DIR, {
      conversationId: ep.conversationId,
      messageId: sentMessageId(result),
      orgId: process.env.COCO_ORG_ID || '',
      sentAt,
    });
    // Contract, not incidental output: this line is how `action_ids` get back
    // to the caller, and an answer cannot be decoded without them. See the
    // note on sendCardMessage.
    console.log(JSON.stringify(result));
  } catch (e) {
    const payload = { error: e.message };
    if (e.status) payload.status = e.status;
    if (e.code) payload.code = e.code;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
