/**
 * Message format helpers per DESIGN.md §3.4 and §3.5.
 *
 * Endpoint format (C4 routing key / `reply via` target):
 *   <conversationId>[|type:<dm|group|sub>][|reply:<messageId>][|msg:<sourceMessageId>]
 *   `type:` (right after the id) is the conversation's session-group kind. The
 *   bridge writes it only when the installed zylos-core takes --session-group
 *   (multi-session Core); it never changes where a message is sent, it only
 *   lets Core name the conversation's session group (src/lib/session-group.js).
 *   `msg:` (last) is the inbound message this endpoint answers (OPENM-1337).
 *   It is not a quote (`reply:` is): it only tells the send path which run the
 *   reply belongs to.
 *
 * send.js routes purely off the conversation id plus the reply suffix.
 * `parseEndpoint` still accepts the legacy `[OPENMAX DM|GROUP]/<id>...` (or
 * older `[COCO TYPE]/`) prefix, whose type is not trusted. Legacy thread
 * endpoints (`|thread:…|parent:…`, `[OPENMAX THREAD]/`) are no longer produced:
 * for one release (2.35.x) they are parsed, their thread part is ignored and
 * flagged as `legacyThread`, and the message goes to the leading conversation.

 * Inbound C4 text format (tag on its own line; the attributed utterance lives
 * inside <current-message> for parity with other C4 channels):
 *   [OPENMAX DM]
 *   <sender-context kind="human" member-id="<memberId>"/>   (DM only, when known)
 *   <openmax-instruction>...</openmax-instruction>
 *   <current-message>
 *   <name> (<sender member id>) said: <content>
 *   </current-message>
 *
 *   [OPENMAX GROUP:<group>]
 *   <group-context>...</group-context>
 *   <current-message>
 *   <name> (<sender member id>) said: <content>
 *   </current-message>
 *   (with optional `---- file: <path>` or `---- image: <path>` suffix)
 */

import { randomUUID } from 'crypto';
import { extractWorkReferences, formatWorkReferenceContext } from './work-reference.js';
import { formatConnectorPreference } from './connector-preference.js';
import { formatWfContext } from './wf-context.js';
import { verifiedExcerptText } from './quote-excerpt.js';
import { formatForwardedChatHistory, chatHistoryBudget, indentBreaks } from './forwarded.js';

const TYPE_TAG = { dm: '[OPENMAX DM]', group: '[OPENMAX GROUP]' };
const VALID_TYPES = new Set(['dm', 'group']);

/**
 * Generate a client-side idempotency key for SendMessageRequest.client_msg_id.
 * cws-comm de-dupes on (org_id, client_msg_id) with no time limit (unique index;
 * the lookup runs before the membership gate and the rate limit).
 */
export function newClientMsgId() {
  return `c_${randomUUID()}`;
}

/**
 * Parse a C4 endpoint string into structured fields.
 *
 * Accepts two forms:
 *   - minimal (current):  `<conversationId>[|type:..][|reply:..][|msg:..]`
 *   - legacy:             `[OPENMAX DM|GROUP|THREAD]/<conversationId>[|...]` (or older `[COCO TYPE]/`) (prefix stripped)
 *
 * The leading conversation id is whatever precedes the first `|`. Routing is
 * driven entirely by the conversation id and the reply suffix; a legacy prefix
 * says nothing (its type is not trusted).
 *
 * `type:<kind>` becomes `endpointType` (validated by session-group.js, not
 * here). `msg:<id>` (OPENM-1337) names the inbound message the reply answers;
 * it becomes `sourceMessageId` and changes no routing. Unknown keys are
 * ignored. A legacy thread form (`thread:` / `parent:` segments, or the
 * `[OPENMAX THREAD]/` prefix) sets `legacyThread: true` and its thread / parent
 * values are dropped: the platform no longer has threads (2.35.x compatibility;
 * refused from 2.36.0).
 *
 * @param {string} endpoint
 * @returns {{conversationId:string, endpointType?:string, replyTo?:string,
 *            sourceMessageId?:string, legacyThread?:true}}
 */
export function parseEndpoint(endpoint) {
  let rest = (endpoint || '').trim();

  // Strip a legacy `[OPENMAX TYPE]/` (or older `[COCO TYPE]/`) prefix if present.
  let legacyThread = false;
  const legacy = /^\[(?:OPENMAX|COCO) (DM|GROUP|THREAD)\]\/(.*)$/.exec(rest);
  if (legacy) { legacyThread = legacy[1] === 'THREAD'; rest = legacy[2]; }

  const segments = rest.split('|');
  const conversationId = (segments.shift() || '').trim();
  if (!conversationId) throw new Error(`invalid endpoint: ${endpoint}`);

  const result = { conversationId };
  for (const part of segments.filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'type' && v.trim()) result.endpointType = v.trim();
    else if (k === 'reply')  result.replyTo = v;
    else if (k === 'thread' || k === 'parent') legacyThread = true;
    else if (k === 'msg' && v.trim()) result.sourceMessageId = v.trim();
  }
  if (legacyThread) result.legacyThread = true;
  return result;
}

/**
 * Build a C4 endpoint string (the `reply via` target) from structured fields.
 *
 * Emits the conversation id, `|type:<endpointType>` right after it when given
 * (the bridge passes it only on a multi-session Core), the reply suffix, and
 * `|msg:<sourceMessageId>` last when given (OPENM-1337). Without
 * `endpointType` the result is the pre-multi-session form, byte for byte.
 * `ep.type` (the conversation's platform type) is accepted but ignored.
 *
 * @param {{type?:string, endpointType?:string, conversationId:string,
 *          replyTo?:string, sourceMessageId?:string}} ep
 */
export function formatEndpoint(ep) {
  if (!ep?.conversationId) throw new Error('formatEndpoint: conversationId required');
  let s = `${ep.conversationId}`;
  if (ep.endpointType)         s += `|type:${ep.endpointType}`;
  if (ep.replyTo)              s += `|reply:${ep.replyTo}`;
  if (ep.sourceMessageId)      s += `|msg:${ep.sourceMessageId}`;
  return s;
}

/**
 * Neutralize the structural-breakout vector in user-supplied strings before
 * embedding them in the XML-tagged context blocks emitted by formatInboundForC4.
 *
 * The consumer is an LLM reading raw text, NOT an XML parser. The only real
 * threat is a sender planting a literal `</current-message>` (or any other
 * closing tag) to break out of the framing the model relies on — that requires
 * the `<` / `>` characters, so those are all we neutralize.
 *
 * We deliberately do NOT escape `&`, `"`, `'`: turning a user's natural
 * ampersands, quotes, and apostrophes into `&amp;` / `&quot;` / `&apos;` only
 * litters the text the model reads (e.g. `she said "hi"` → `she said &quot;hi&quot;`)
 * without preventing any breakout. Keeping prose verbatim gives the model a
 * cleaner, more faithful view of what the user actually wrote.
 */
function escapeXml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a single context-line entry: `[name]: text`. Both fields go through
 * escapeXml. Accepts the shape returned by fetchRecentMessages
 * ({senderName, content}) as well as generic {user_name|sender_id, text|content}.
 */
/**
 * Attribute-safe rendering. escapeXml deliberately leaves `"` alone — harmless
 * in element text, but inside a quoted attribute a `"` ends the value and the
 * rest becomes attributes of our own element. Line breaks would do the same to
 * the one-element-per-line framing. Attributes carry ids, kinds and timestamps,
 * so dropping these characters costs nothing and removes the breakout.
 */
function attrValue(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[<>"\r\n\u2028\u2029]/g, '').trim();
}

function formatContextLine(m) {
  const name = escapeXml(
       m.senderName
    || m.sender_display_name
    || m.user_name
    || m.sender_id
    || 'unknown',
  );
  const text = escapeXml(m.content ?? m.text ?? m.content_text ?? '');
  return `[${name}]: ${text}`;
}

// The display name on the `<name> (<member id>) said:` line is sender-chosen,
// so it must not be able to fake that shape: ASCII `(` / `)` become fullwidth
// `（` / `）` (still readable, but never the id's delimiters, so the only ASCII
// parenthesized token on the line is the real id), and any line break (CR, LF,
// CRLF, VT, FF, NEL, U+2028, U+2029) becomes one space, so the name cannot
// start a new sender line.
function senderLineName(name) {
  return String(name)
    .replace(/\(/g, '\uFF08')
    .replace(/\)/g, '\uFF09')
    .replace(/(?:\r\n|[\r\n\v\f\u0085\u2028\u2029])+/g, ' ');
}

// Shown for an inbound attachment that cannot be fetched (no artifact id, or
// its download failed), so the message is not rendered as an empty one.
export const UNAVAILABLE_ATTACHMENT = '[附件无法获取]';

/**
 * Build the C4-bridge inbound text for a single incoming message.
 *
 * Output framing mirrors zylos-feishu `src/index.js formatMessage`:
 *   - tag includes the group name for group messages
 *     (`[OPENMAX GROUP:Engineering]`)
 *   - context blocks are XML-tagged so the LLM can cleanly separate history
 *     from the current message
 *   - replying-to and smart-mode hint blocks are emitted
 *     when the relevant opts are present
 *   - all user-supplied strings go through escapeXml
 *
 * @param {object} conv     - { type:'dm'|'group', id?, name? }
 * @param {object} sender   - { displayName, id? }  (id: the sender's member id)
 * @param {object} current  - { content:string, messageId?:string,
 *                              type?:'text'|'image'|'file', mediaLocalPath?:string }
 * @param {Array}  [recent] - recent group messages used for `<group-context>`
 *                            (`<subconversation-context>` with opts.subConversation)
 * @param {object} [opts]   - { groupName, quotedContent, smartHint, receipt,
 *                              preferredConnectors, wfRef, quotedExcerpt,
 *                              chatHistory, subConversation,
 *                              systemSender: { memberId? } | undefined,
 *                              senderMember: { kind:'human'|'agent', memberId } | undefined }
 *                            `chatHistory` comes from forwarded.js
 *                            (chatHistoryOf).
 *                            `systemSender` is set by the bridge only for a
 *                            platform System Member (sender_type=SYSTEM).
 *                            `senderMember` (from sender_type / sender_id) is
 *                            rendered only in a DM and only when there is no
 *                            systemSender.
 *                            `subConversation` (boolean, set by the bridge
 *                            from the conversation record only) renders
 *                            `recent` as <subconversation-context>, DM or group.
 * @returns {string}
 */
export function formatInboundForC4(conv, sender, current, recent = [], opts = {}) {
  const rawType = (conv?.type || '').toLowerCase();
  const type = VALID_TYPES.has(rawType) ? rawType : 'dm';
  const {
    groupName, quotedContent, smartHint, orgId, orgName, receipt, systemSender,
    senderMember, preferredConnectors, wfRef, quotedExcerpt, chatHistory, subConversation,
  } = opts;

  const name = sender?.displayName || sender?.display_name || sender?.id || 'unknown';
  const safeName = escapeXml(senderLineName(name));
  // A System Member body is flattened onto one line so all of it follows
  // `<name> said:` — a multi-line platform event otherwise leaves its later
  // lines (e.g. a `ref: event=…` token) bare, where they read as pasted data.
  // Human / agent content keeps its lines, but every line after the first is
  // indented two spaces (as merged-forward records are), so text from the body
  // can never start a line that reads as another `<name> (<id>) said:`.
  const rawContent = String(current?.content ?? '');
  const safeContent = systemSender
    ? escapeXml(rawContent.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim())
    : indentBreaks(escapeXml(rawContent));

  const baseTag = TYPE_TAG[type];
  // baseTag is like "[OPENMAX GROUP]" — inject ":<name>" before the closing "]".
  const tag = type === 'group'
    ? `${baseTag.slice(0, -1)}:${escapeXml(groupName || conv?.name || 'unknown')}]`
    : baseTag;

  // Tag on its own line; the `<name> said: ...` attribution now lives inside
  // the <current-message> block (semantic parity with other C4 channels).
  //
  // Org header. The org NAME is UNTRUSTED display data; the org_id is the
  // AUTHORITATIVE routing key. Keep them apart so a malicious name can't forge
  // a competing id (see SKILL.md hard rule):
  //   - display text carries the NAME ONLY, escapeXml'd AND with CR/LF
  //     neutralized so it cannot break out of its line;
  //   - the org_id is emitted as a dedicated self-closing <org-context>
  //     element on its own line. Because escapeXml turns the name's `<`/`>`
  //     into entities, the untrusted name CANNOT produce a second/competing
  //     <org-context .../> element.
  // When org_id is absent, no <org-context> element is emitted and the display
  // falls back to name-or-id as before.
  const displayLabel = orgName
    ? escapeXml(orgName).replace(/[\r\n]/g, ' ')
    : (orgId ? escapeXml(orgId) : '');
  const orgSuffix = displayLabel ? ` (org: ${displayLabel})` : '';
  let header = `${tag}${orgSuffix}\n`;
  if (orgId) {
    header += `<org-context org-id="${escapeXml(orgId)}"/>\n`;
  }
  // Tool calls that cause external side effects must be tied back to the
  // exact inbound human request. Keep the server-issued ids in a structural
  // element outside <current-message>; user text cannot forge this because
  // angle brackets in the message body are escaped below.
  if (conv?.id && current?.messageId) {
    header += `<message-context conversation-id="${escapeXml(conv.id)}" source-message-id="${escapeXml(current.messageId)}"/>\n`;
  }
  // Sender kind. Only the bridge can mark a message as coming from a platform
  // System Member (it reads sender_type from the server frame); message text
  // cannot forge this element because `<` and `>` in content are escaped, and
  // the member id goes through attrValue (no quotes / angle brackets / line
  // breaks). A display name like "调度中心" in `said:` is NOT this signal.
  if (systemSender) {
    const memberAttr = systemSender.memberId ? ` member-id="${attrValue(systemSender.memberId)}"` : '';
    header += `<sender-context kind="system"${memberAttr}/>\n`;
  } else if (senderMember && rawType === 'dm') {
    // DM sender identity: the human / agent OpenMax member id, from the
    // server frame's sender_id (never from metadata, display name or text).
    // Same forgery guarantees as kind="system" above. Not a platform event.
    // Gated on the type the caller passed, not the defaulted `type`: other
    // conversation types (strat / broadcast / bridge / …) fall back to the
    // [OPENMAX DM] label but are not DMs, so they get no element.
    const memberId = attrValue(senderMember.memberId);
    const kind = senderMember.kind === 'human' || senderMember.kind === 'agent' ? senderMember.kind : '';
    if (memberId && kind) header += `<sender-context kind="${kind}" member-id="${memberId}"/>\n`;
  }
  // An interaction receipt's answer and actor decide whether an irreversible
  // action runs, so they are emitted as a structural element rather than left
  // in the message text. Anyone can type text that reads like a receipt; nobody
  // can type this element, because `<` and `>` in content are escaped below.
  if (receipt) {
    const attrs = [
      `selected-action-ids="${attrValue(receipt.selectedActionIds.join(','))}"`,
      `selected-count="${attrValue(receipt.selectedCount)}"`,
    ];
    if (receipt.actorMemberId) attrs.push(`actor-member-id="${attrValue(receipt.actorMemberId)}"`);
    if (receipt.actorKind) attrs.push(`actor-kind="${attrValue(receipt.actorKind)}"`);
    if (receipt.cardConversationId) attrs.push(`card-conversation-id="${attrValue(receipt.cardConversationId)}"`);
    if (receipt.cardMessageId) attrs.push(`card-message-id="${attrValue(receipt.cardMessageId)}"`);
    if (receipt.settledAt) attrs.push(`settled-at="${attrValue(receipt.settledAt)}"`);
    if (receipt.interactionType) attrs.push(`interaction-type="${attrValue(receipt.interactionType)}"`);
    if (receipt.answered) attrs.push(`answered="${attrValue(receipt.answered)}"`);
    // On every form receipt, empty included: comm.answered refuses a form
    // answer without otherSelected / otherTextKeys / textKeys, so the values to copy must
    // always be there.
    if (receipt.interactionType === 'form') {
      attrs.push(`other-selected="${attrValue((receipt.otherSelected || []).join(','))}"`);
      attrs.push(`other-text="${attrValue((receipt.otherTyped || []).join(','))}"`);
      attrs.push(`text-keys="${attrValue((receipt.textKeys || []).join(','))}"`);
    }
    header += `<interaction-receipt ${attrs.join(' ')}/>\n`;
  }
  // Connector preference (OPENM-915): the connectors the user picked in the
  // input-box panel, from message metadata. A preference, not a gate — see
  // connector-preference.js. Structural for the same reason as the elements
  // above: typed text cannot produce it.
  const preference = formatConnectorPreference(preferredConnectors);
  if (preference) header += `${preference}\n`;
  // Workflow context: which workflow / run / page of the workflows page the
  // user sent this from, from message metadata `wf_ref`. A hint only — the
  // workflows records stay authoritative (see wf-context.js). Structural for
  // the same reason as the elements above.
  const wfContext = formatWfContext(wfRef);
  if (wfContext) header += `${wfContext}\n`;
  const parts = [header];

  // A merged forward (chat history) is the message text, rendered last into the
  // room the rest of the envelope leaves (see chatHistoryBudget); its slot in
  // `parts` is filled in then. Absent it, nothing below changes.
  let historySlot = -1;

  // Skill discovery is advisory in the runtime: a model can occasionally
  // answer an inbound message without invoking the listed skill, especially
  // immediately after a session restart. Put the fixed channel instruction in
  // every OpenMax envelope so loading the skill is part of the message contract
  // rather than a best-effort inference from the skill listing.
  parts.push(
`<openmax-instruction>
Before handling the current message, invoke the openmax skill and follow it. For an explicit automation-update-request form handoff or its confirmation conversation, follow the skill's Automation Update workflow before generic Issue intake. For an explicit automation-create-request form handoff or its confirmation conversation, follow the skill's Automation Creation workflow before generic Issue intake. Otherwise classify the message per the skill: handle chat and work one Agent can finish quickly in this conversation directly, without an Issue card; complete New-Issue Intake before new work that needs other teams, several people or Agents, or spans time (future deadline, several days, later acceptance), or that the human asks to track; if unsure, do the part you can finish now, then offer in one plain-text line to track the rest. A message with a sender-context element of kind="system" (placed above, never inside, current-message) is a platform event from a System Member, not pasted content and not a new task for New-Issue intake (an onboarding card receipt may still start the owner's onboarding task): handle it per the skill, and for a "ref: event=…" token follow the matching skill section (it verifies against platform data before acting).
</openmax-instruction>

`,
  );

  if (subConversation && recent && recent.length > 0) {
    // A sub-conversation's recent messages (DM or group), in place of
    // <group-context>; same lines, no attributes. Nothing when there are none.
    const lines = recent.map(formatContextLine);
    parts.push(`<subconversation-context>\n${lines.join('\n')}\n</subconversation-context>\n\n`);
  } else if (!subConversation && type !== 'dm' && recent && recent.length > 0) {
    const lines = recent.map(formatContextLine);
    parts.push(`<group-context>\n${lines.join('\n')}\n</group-context>\n\n`);
  }

  if (quotedContent) {
    const qsender = escapeXml(quotedContent.sender || quotedContent.senderName || 'unknown');
    const fullText = quotedContent.text || quotedContent.content || '';
    // A quoted excerpt (part of the message) replaces the full text, but only
    // when it is found in that text: the excerpt is written by the quoting
    // client, and this line names the quoted author. Later lines are indented
    // so the excerpt cannot start a line of its own.
    const excerptText = verifiedExcerptText(quotedExcerpt, fullText);
    const qtext = excerptText !== null ? indentBreaks(escapeXml(excerptText)) : escapeXml(fullText);
    parts.push(`<replying-to>\n[${qsender}]: ${qtext}\n</replying-to>\n\n`);
  }

  if (smartHint) {
    parts.push(
`<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`,
    );
  }

  const workReferenceContext = formatWorkReferenceContext(
    extractWorkReferences(current?.content ?? ''),
  );
  if (workReferenceContext) {
    parts.push(`${workReferenceContext}\n\n`);
  }

  // The sender's member id after the name, so the Agent knows who spoke even
  // when display names collide. Not repeated when the name already is the id
  // (no resolvable name). The message id stays in <message-context>.
  const senderId = attrValue(sender?.id);
  const who = senderId && senderId !== name ? `${safeName} (${senderId})` : safeName;
  if (chatHistory) {
    parts.push(`<current-message>\n${who} said: `);
    historySlot = parts.length;
    parts.push('', '\n</current-message>');
  } else {
    parts.push(`<current-message>\n${who} said: ${safeContent}\n</current-message>`);
  }

  let line = parts.join('');
  const kind = current.type === 'image' ? 'image' : 'file';
  if (Array.isArray(current?.mediaItems) && current.mediaItems.length > 0) {
    for (const item of current.mediaItems) {
      if (item.localPath) {
        line += ` ---- ${kind}: ${escapeXml(item.localPath)}`;
        if (item.fileName) line += ` name="${escapeXml(item.fileName)}"`;
      } else if (item.id) {
        line += ` ---- artifact_id: ${escapeXml(item.id)}`;
        if (item.fileName) line += ` name="${escapeXml(item.fileName)}"`;
        if (item.downloadFailed) line += ` ${UNAVAILABLE_ATTACHMENT}`;
      } else {
        // No artifact id to fetch it by: say so, so the message is never blank.
        line += ` ---- ${UNAVAILABLE_ATTACHMENT}`;
        if (item.fileName) line += ` name="${escapeXml(item.fileName)}"`;
        if (item.contentType) line += ` content_type="${escapeXml(item.contentType)}"`;
      }
    }
  } else if (current?.mediaLocalPath) {
    line += ` ---- ${kind}: ${escapeXml(current.mediaLocalPath)}`;
    if (current.mediaFileName) line += ` name="${escapeXml(current.mediaFileName)}"`;
  } else if (current?.mediaId) {
    line += ` ---- artifact_id: ${escapeXml(current.mediaId)}`;
    if (current.mediaFileName) line += ` name="${escapeXml(current.mediaFileName)}"`;
  }
  if (chatHistory) {
    const before = parts.slice(0, historySlot).join('');
    const budget = chatHistoryBudget(Buffer.byteLength(line, 'utf8'));
    line = before + formatForwardedChatHistory(chatHistory, budget) + line.slice(before.length);
  }
  return line;
}

/**
 * Heuristic markdown auto-detection for outbound messages.
 * Matches presence of headings, emphasis, code fences, lists, or links.
 */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string' || !text) return false;
  return /(^|\n)(#{1,6}\s|[*_-]{1,3}\s|```|\|\s|>\s|\d+\.\s)/.test(text) ||
         /\[[^\]]+\]\([^)]+\)/.test(text) ||
         /\*\*\S/.test(text) ||
         /`[^`]+`/.test(text);
}

/**
 * MEDIA prefix detection for outbound messages.
 * Matches `[MEDIA:image]/path/to/file` or `[MEDIA:file]/path/to/doc.pdf`.
 */
export function parseMediaPrefix(message) {
  // First line after the tag is the file path (may contain spaces); anything
  // after the first newline is an optional caption that travels with the media
  // message (cws-fe puts it in content.body.text). Path-only messages (no
  // newline) keep working unchanged.
  const m = /^\[MEDIA:(image|file)\]([^\n]*)(?:\n([\s\S]*))?$/.exec(message || '');
  if (!m) return null;
  const caption = m[3] != null ? m[3].trim() : '';
  return { kind: m[1], localPath: m[2].trim(), caption: caption || undefined };
}

/**
 * Split a long message into chunks that fit within maxLen characters.
 * Tries to break at paragraph (double-newline) boundaries first, then
 * single-newline boundaries, then hard-cuts as a last resort.
 */
export function splitMessage(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = -1;

    // prefer paragraph break
    cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut).trimStart(); continue; }

    // fallback: single newline
    cut = remaining.lastIndexOf('\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut + 1).trimStart(); continue; }

    // last resort: hard cut at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}
