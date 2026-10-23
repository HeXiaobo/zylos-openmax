/**
 * `[CARD]{…}` — asking a choice card through the same outbound entry as text.
 *
 * Every inbound message hands the agent one reply command (`c4-send`), and
 * until now that command could only carry text: a card had to be asked with a
 * different verb entirely. Two entries for "answer this person" is the ground
 * a wrong choice grows in — the agent reaches for the one it was just told to
 * use and types the options into a sentence. One entry removes the choice.
 *
 * It also puts cards in the audit log for free. `c4-send` writes the outbound
 * body to its conversation table BEFORE spawning this script, so a card asked
 * this way leaves a row exactly like a text reply does; a card asked by the
 * other verb never touches that table, and the history Memory Sync reads from
 * it has no idea the interaction happened.
 *
 * 🔴 The payload is INLINE JSON, not a path to a file holding it. The audit row
 * stores the body verbatim, so inline means the row is self-contained — the
 * question is still readable from it months later. A path would store a
 * pointer, and the existing `[MEDIA:…]` rows are what that turns into: every
 * one of them names a file that is long gone, so the row proves a send
 * happened and can never again say what was sent. A card carries the question
 * a human was asked and answered; it is the last thing that should decay into
 * a dangling pointer.
 *
 * Layering: parsing, validation and the record live here because `scripts/`
 * has no test surface at all. `scripts/send.js` keeps only the three-way
 * dispatch.
 */

import { post, get, apiPath } from './client.js';
import { assertAnswerable, buildChoiceRequest, buildFormRequest, resolveInteractionType } from './interaction-request.js';
import { recentQuickReplyTo, recordPendingQuestion, repeatQuickReplyWarning } from './pending-question.js';
import { assertAllImChannels } from './onboarding-channel-guard.js';
import { postWithRunMetadata } from './activity/reply.js';

export const CARD_PREFIX = '[CARD]';

export class CardMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CardMessageError';
  }
}

/**
 * Keys the card builder accepts but this entry point cannot honour: the
 * endpoint and the conversation-to-org map already decide where the card goes.
 *
 * They are refused rather than ignored. A caller who writes a `conversationId`
 * into the payload believes they chose the target; silently sending to the
 * endpoint's conversation instead would be right by luck and wrong without a
 * word whenever the two differ.
 *
 * This is a deny-list of exactly the keys `buildChoiceRequest`'s whitelist
 * permits and this path does not use — deliberately NOT a second copy of the
 * card-field list, which would be a second ruling point and would drift from
 * the first one.
 */
const ENDPOINT_OWNED_KEYS = ['conversationId', 'org', 'orgSlug', 'orgId', 'org_id'];

/**
 * Recognize and validate a `[CARD]` message.
 *
 * One prefix for both card types: `fields` in the payload asks a choice form,
 * `options` a quick-reply card (`resolveInteractionType`).
 *
 * @returns {null|{interactionType:(string|undefined), kind:string, askedOf:string|string[], meta:*, card:object}}
 *   null when the message is not a card — plain text and `[MEDIA:…]` both land
 *   here and must come back null.
 * @throws {CardMessageError} when it IS a card and is malformed. Throwing is
 *   the whole point: the alternative to an error is posting the raw JSON into
 *   the conversation as a chat message, which is both unreadable to the person
 *   and indistinguishable — to the agent — from having asked them something.
 */
export function parseCardMessage(message) {
  const text = typeof message === 'string' ? message : '';
  // trimStart, not a bare prefix test: a leading space is otherwise the
  // difference between asking a question and dumping JSON into the chat, and
  // nothing downstream would report it.
  const body = text.trimStart();
  if (!body.startsWith(CARD_PREFIX)) return null;

  const raw = body.slice(CARD_PREFIX.length).trim();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new CardMessageError(`[CARD] payload is not valid JSON: ${e.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CardMessageError('[CARD] payload must be a JSON object');
  }

  // `kind` and `askedOf` are required for the same reason `comm.ask_card`
  // requires them: the receipt that comes back names the card and nothing
  // else. Without `kind` the answer cannot say what it answered; without
  // `askedOf` there is nobody to check the clicker against, and the protocol
  // has no authorization of its own.
  const { kind, askedOf, meta, interactionType, ...card } = payload;
  // A form's `answerers` stand in for `askedOf` when it is left out — the same
  // people the platform lets answer are the ones whose answer counts. Which
  // type this is gets settled in sendCardMessage, by the shared rule.
  const askedOfGiven = hasAskedOf(askedOf) || card.fields === undefined ? askedOf : card.answerers;
  if (!kind || !hasAskedOf(askedOfGiven)) {
    throw new CardMessageError(
      '[CARD] requires `kind` and `askedOf` (a form may give `answerers` instead) — a receipt names only the card, so an answer with neither is decodable but meaningless',
    );
  }

  for (const key of ENDPOINT_OWNED_KEYS) {
    if (key in card) {
      throw new CardMessageError(
        `[CARD] payload must not set \`${key}\`: the endpoint passed to send.js decides the target conversation and its org`,
      );
    }
  }

  // Everything left is a card field, and `buildChoiceRequest` is the single
  // judge of those — including its whitelist, which is what stops a key the
  // endpoint has no place for from being dropped in silence.
  return { interactionType, kind, askedOf: askedOfGiven, meta, card };
}

/** A usable `askedOf`: a non-empty id, or a non-empty list of them. */
export function hasAskedOf(v) {
  return Array.isArray(v) ? v.length > 0 && v.every(Boolean) : Boolean(v);
}

/**
 * Post the card and write down what was asked, in that order.
 *
 * Same two steps, same order and the same failure wording as
 * `comm.ask_card`: both produce one interaction-request and one pending
 * record, so the two entries are interchangeable for the answering side.
 *
 * 🔴 The returned `action_ids` reach the caller because `scripts/send.js` ends
 * with `console.log(JSON.stringify(result))` — the CLI's stdout IS the return
 * channel for every send. Treat that as a contract of this path, not a
 * convenience of that line: an answer is decoded by matching an action id, and
 * a caller that never sees the ids has no way back to the option. Anything
 * that stops printing this result breaks card answers, silently.
 */
export async function sendCardMessage(conversationId, parsed, deps = {}) {
  if (resolveInteractionType({ ...parsed.card, interactionType: parsed.interactionType }) === 'form') {
    const res = await askForm(conversationId, parsed, deps, '[CARD]');
    return { ok: true, card: true, interaction_type: 'form', message_id: res.messageId, form_option_ids: res.formOptionIds, recorded: true, ...(res.note ? { note: res.note } : {}) };
  }
  const postFn = deps.post || post;
  const record = deps.recordQuestion || recordPendingQuestion;

  const request = buildChoiceRequest(parsed.card);
  assertAnswerable(request, '[CARD]');
  // Same onboarding.channel guard as comm.ask_card (exact im_channels in order, same im_order, or refuse;
  // a failed fetch never blocks). See onboarding-channel-guard.js.
  await assertAllImChannels(request, {
    fetchProfileOptions: deps.fetchProfileOptions
      || ((imOrder) => get(apiPath('/onboarding/profile-options'), { im_order: imOrder }, { timeoutMs: 8000 })),
    warn: deps.warn,
  }, '[CARD]');
  // Agent activity: `deps.attachRun(request)` (scripts/send.js) may set
  // request.agent_run and return the reply plan; the POST then settles it, and
  // a server that refuses `agent_run` gets the card once more without it.
  const plan = deps.attachRun ? deps.attachRun(request) : null;
  const path = apiPath(`/conversations/${conversationId}/interaction-requests`);
  const res = plan
    ? await postWithRunMetadata(postFn, path, request, plan, deps.runStore ? { store: deps.runStore } : {})
    : await postFn(path, request);

  const actionIds = res?.action_ids || res?.data?.action_ids;
  const messageId = res?.message_id || res?.data?.message_id;
  if (!Array.isArray(actionIds) || !actionIds.length || !messageId) {
    // The card is already posted. Say that, so the reader does not retry an
    // ask the person is already looking at.
    throw new CardMessageError(
      `[CARD] card was SENT but the response carried no ${messageId ? 'action_ids' : 'message_id'}, so the answer will not be decodable: ${JSON.stringify(res)}`,
    );
  }

  // Taken after a successful POST, the same moment askChoice in comm.js takes
  // it, so both paths record the card's time and measure the wsb#679 window
  // from the same event. Read the window before this card is recorded, so it
  // does not find itself; warned, never refused.
  const nowIso = deps.now ? deps.now() : new Date().toISOString();
  const earlier = (deps.recentQuickReply || recentQuickReplyTo)(conversationId, parsed.askedOf, nowIso, deps.recordOptions);

  record({
    kind:           parsed.kind,
    askedOf:        parsed.askedOf,
    conversationId,
    cardMessageId:  messageId,
    actionIds,
    askedAt:        nowIso,
    title:          parsed.card?.title,
    meta:           parsed.meta,
  }, deps.recordOptions);

  const out = { ok: true, card: true, message_id: messageId, action_ids: actionIds, recorded: true };
  if (earlier) out.warning = repeatQuickReplyWarning(earlier);
  return out;
}

/**
 * Bound on the conversation-type lookup that decides whether to drop
 * `answerers`. Same bound as the best-effort pre-send roster GET on both send
 * paths (ROSTER_HYDRATION_TIMEOUT_MS): the lookup only removes an @, so it may
 * delay a card by at most this much and never hold it.
 */
export const CONVERSATION_TYPE_TIMEOUT_MS = 2000;

/** The `note` a choice form in a DM carries when its `answerers` were dropped. */
export const DM_ANSWERERS_NOTE = 'answerers dropped: this conversation is a DM, so there is only one person to answer and answerers would only add an @ and a notification. askedOf is unchanged.';

/**
 * Ask a choice form and write down what was asked: the form counterpart of
 * `sendCardMessage`'s choice path, shared by `[CARD]` and `comm.ask` so the
 * two cannot record different things for the same question.
 *
 * `askedOf` is stored as a list. When the caller gave `answerers` as well, it
 * must name only answerers: anyone else is refused by the platform when they
 * try to submit, so a question asked of them could never be answered.
 */
export async function askForm(conversationId, parsed, deps = {}, verb = 'comm.ask') {
  const postFn = deps.post || post;
  const record = deps.recordQuestion || recordPendingQuestion;
  const nowIso = deps.now ? deps.now() : new Date().toISOString();

  const request = buildFormRequest(parsed.card);
  const askedOf = (Array.isArray(parsed.askedOf) ? parsed.askedOf : [parsed.askedOf]).map(String);
  const answerers = request.form.answerers;
  if (answerers) {
    const outside = askedOf.filter((id) => !answerers.includes(id));
    if (outside.length) {
      throw new CardMessageError(
        `${verb}: askedOf ${outside.join(', ')} is not in answerers — the platform would refuse their submission, so the question could never be answered`,
      );
    }
  }

  // In a DM there is one human to answer, so `answerers` only adds an @ and a
  // notification (cws-comm mentions every answerer). Dropped before the send,
  // after askedOf has taken its default from them and been checked against
  // them. A failed or slow lookup keeps them: the card still works, it only @s.
  // `deps.conversationType(id, timeoutMs)` must use the same org as `deps.post`;
  // comm.ask passes its org-scoped GET.
  let note;
  if (answerers) {
    const timeoutMs = deps.conversationTypeTimeoutMs ?? CONVERSATION_TYPE_TIMEOUT_MS;
    const typeOf = deps.conversationType || (async (id, ms) => {
      const conv = await get(apiPath(`/conversations/${id}`), undefined, { timeoutMs: ms });
      return conv?.type || conv?.data?.type;
    });
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, null); });
    const type = await Promise.race([
      Promise.resolve().then(() => typeOf(conversationId, timeoutMs)).catch(() => null),
      deadline,
    ]);
    clearTimeout(timer);
    if (String(type || '').toLowerCase() === 'dm') {
      delete request.form.answerers;
      note = DM_ANSWERERS_NOTE;
    }
  }

  // Agent activity, exactly as on the choice path: `deps.attachRun(request)`
  // may set request.agent_run and return the reply plan; the POST settles it,
  // and a server that refuses `agent_run` (422) gets the form once more
  // without it (same client_msg_id).
  const plan = deps.attachRun ? deps.attachRun(request) : null;
  const path = apiPath(`/conversations/${conversationId}/interaction-requests`);
  const res = plan
    ? await postWithRunMetadata(postFn, path, request, plan, deps.runStore ? { store: deps.runStore } : {})
    : await postFn(path, request);
  const messageId = res?.message_id || res?.data?.message_id;
  const formOptionIds = res?.form_option_ids || res?.data?.form_option_ids;
  // `fields` maps each choice question to its option ids; a text question has
  // none, so it is recorded in `questions` only, as `type: "text"`.
  const fields = {};
  const questions = {};
  const choices = request.form.fields.filter((f) => f.type !== 'text');
  for (const f of request.form.fields) {
    if (f.type === 'text') {
      questions[f.key] = { label: f.label, type: 'text', required: f.required !== false, multiline: f.multiline === true };
      continue;
    }
    const ids = formOptionIds?.[f.key];
    if (Array.isArray(ids) && ids.length === f.options.length) fields[f.key] = ids;
    questions[f.key] = {
      label: f.label,
      required: f.required !== false,
      allowOther: f.allow_other === true,
      optionKeys: f.options.map((o) => o.key ?? ''),
      optionLabels: f.options.map((o) => o.label),
    };
  }
  if (!messageId || Object.keys(fields).length !== choices.length) {
    // The card is already posted. Say that, so the reader does not retry an
    // ask the person is already looking at.
    throw new CardMessageError(
      `${verb}: card was SENT but the response carried no ${messageId ? 'form_option_ids matching every choice question' : 'message_id'}, so the answer will not be decodable: ${JSON.stringify(res)}`,
    );
  }

  record({
    kind:            parsed.kind,
    interactionType: 'form',
    askedOf,
    conversationId,
    cardMessageId:   messageId,
    fields,
    questions,
    ...(request.form.group ? { group: request.form.group } : {}),
    askedAt:         nowIso,
    title:           request.form.title,
    meta:            parsed.meta,
  }, deps.recordOptions);

  return { messageId, formOptionIds, response: res, ...(note ? { note } : {}) };
}
