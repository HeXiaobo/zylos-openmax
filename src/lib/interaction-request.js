/**
 * Build the body for `POST /conversations/{id}/interaction-requests`
 * (interaction_type=choice) from the arguments `comm.send_card` accepts.
 *
 * This replaces building a `cws.card.v1` body locally. The agent now states
 * what it wants — a title, a body, the choices — and cws-comm builds the card,
 * which is why nothing here names an operation, a URL, a handler or an option
 * id.
 *
 * 🔴 Option ids are NOT ours to choose any more. cws-comm generates them and
 * returns them in `action_ids`, positionally aligned with the options sent. A
 * caller that used to pass `id` and match on it later is rejected loudly here
 * rather than having that binding silently dropped — losing it would make the
 * answer unreadable at exactly the moment it arrives.
 *
 * 🔴 No length or count caps here, deliberately, and this reverses what
 * buildDisplayCard did. Every such rule already exists in cws-comm — the block
 * allowlist, the option cap, the label length, the duplicate-label check — and
 * restating one locally creates a second ruling point that drifts. The
 * stricter direction is the worse one: a local cap tighter than cws-comm's
 * makes a range the server accepts unreachable, with an error that blames the
 * caller. The cws-core edge made the same call for the same reason.
 */
import { newClientMsgId } from './message.js';

export class InteractionRequestError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'InteractionRequestError';
    this.field = field;
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InteractionRequestError(field, 'is required and must be a non-empty string');
  }
  return value;
}

/**
 * Normalize one option. Accepts a bare string as shorthand for its label.
 * `text` is accepted as an alias because that is what the old card API called
 * this field — under the old model it was the reply text a settlement matched
 * on, and matching is gone, so the two collapse into one.
 */
/**
 * Keys an option and a confirm may carry. Closed sets, and refused the same way
 * the top-level params are.
 *
 * The top-level whitelist stops at the top level, and every failure it exists
 * to prevent is just as reachable one level down: `stye` for `style` would
 * cost the card its primary button without a word.
 *
 * Whitelists for the same reason as above: the key that needs refusing is the
 * one nobody thought of.
 */
const OPTION_KEYS = new Set(['label', 'text', 'style', 'confirm', 'behavior', 'decline', 'icon']);
const CONFIRM_KEYS = new Set(['text', 'label']);

function rejectUnknownKeys(obj, allowed, path, carries) {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    throw new InteractionRequestError(`${path}.${key}`, `is not supported here; ${carries}`);
  }
}

/**
 * Normalize a confirm into `{text, label?}`. One expression, used for both the
 * card-level confirm and an option's own, so the two cannot drift into slightly
 * different shapes for the same thing.
 *
 * `confirm` is a protocol field that cws-core and cws-comm pass through, so it
 * is still accepted and validated here. Since the OPENM-833 Q24 reversal the
 * web client does not render it on a choice card — one click answers — so it
 * guards nothing; an irreversible action belongs on a business (action) card.
 */
function normalizeConfirm(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractionRequestError(path, 'must be an object');
  }
  rejectUnknownKeys(value, CONFIRM_KEYS, path, 'a confirm carries `text` and an optional `label`');
  const confirm = { text: requireText(value.text, `${path}.text`) };
  if (value.label !== undefined) confirm.label = requireText(value.label, `${path}.label`);
  return confirm;
}

function normalizeOption(option, index) {
  const at = `options[${index}]`;
  if (typeof option === 'string') return { label: requireText(option, at) };
  if (!option || typeof option !== 'object') {
    throw new InteractionRequestError(at, 'must be a string or an object');
  }
  if (option.id !== undefined) {
    throw new InteractionRequestError(`${at}.id`, 'cannot be set: cws-comm generates option ids and returns them as action_ids');
  }
  rejectUnknownKeys(option, OPTION_KEYS, at, 'an option carries `label` (or the `text` alias), `style`, `confirm`, and on an onboarding card `behavior`, `decline` and `icon`');
  const label = requireText(option.label ?? option.text, `${at}.label`);
  const out = { label };
  if (option.style !== undefined) out.style = String(option.style);
  if (option.confirm !== undefined) out.confirm = normalizeConfirm(option.confirm, `${at}.confirm`);
  // The onboarding guide-card fields. Passed through as given — not coerced:
  // String(false) is "false", which is a valid icon slug, so coercion would
  // turn a wrongly typed value into a legal one the server then accepts.
  // Which values exist, and which card kinds admit each, is cws-comm's ruling
  // (see the no-local-caps note at the top of this file).
  if (option.behavior !== undefined) out.behavior = option.behavior;
  if (option.decline !== undefined) out.decline = option.decline;
  if (option.icon !== undefined) out.icon = option.icon;
  return out;
}

/**
 * Behaviors that do something other than answer. An option answers unless it
 * declares one of these; an unknown behavior counts as answering here only so
 * that cws-comm, not this check, is what refuses it.
 */
const NON_ANSWER_BEHAVIORS = new Set(['open_create_agent']);

function isAnsweringOption(option) {
  return !NON_ANSWER_BEHAVIORS.has(option.behavior);
}

/**
 * Refuse, for the two entries that RECORD a question, a card nobody can answer.
 *
 * `comm.ask_card` and `[CARD]` write a pending question that waits for a
 * receipt. A card whose every option opens a dialog instead of answering —
 * the onboarding partner card — never produces one: cws-comm refuses to settle
 * such a button. The record would then sit in `comm.pending` for good, looking
 * like a person who has not replied yet. `comm.send_card` records nothing and
 * is the verb for that card.
 */
export function assertAnswerable(body, verb) {
  const options = body?.choice?.options || [];
  if (options.some(isAnsweringOption)) return;
  throw new InteractionRequestError(
    'options',
    `${verb} records a question awaiting an answer, but no option on this card answers one — every option opens something instead. `
      + 'Send it with comm.send_card, which records nothing',
  );
}

/** A single text block, the shape `text` collapses into when no blocks are given. */
function textBlock(text) {
  return { type: 'text', text };
}

/**
 * Every top-level key this builder knows.
 *
 * 🔴 It is a WHITELIST, not a deny-list, because the builder constructs its
 * result from scratch: a key it does not name is neither used nor reported, so
 * a caller that passes one gets a card that sends successfully and is missing
 * what they asked for. That happened — an upgrade card carried a top-level
 * `fields` with one row per component, and what arrived had the prose body and
 * nothing else. A deny-list cannot catch that, because the key you need to deny
 * is the one nobody thought of.
 *
 * `conversationId` and the org-routing keys are here because they are NOT card
 * fields: `comm.send_card` hands its whole parsed params object to this
 * function, so the CLI's own arguments arrive alongside the card's. Dropping
 * them from this set would reject every real call.
 *
 * One flat set covers both callers because `comm.ask_card` strips its own three
 * arguments (`kind`, `askedOf`, `meta`) before calling — and must keep doing so.
 * `kind` in particular means something different to each verb, and this builder
 * has to keep refusing it: to the two recording entries it is what the question
 * is for, and the card family the endpoint does accept is taken as `cardKind`
 * instead, so one word never carries both meanings. If a future verb needs to
 * pass an argument through instead of stripping it, split this into a
 * per-caller set rather than widening the shared one, or the widened key
 * becomes silently droppable again for the other verb.
 */
const KNOWN_PARAMS = new Set([
  // card fields
  'title', 'summary', 'text', 'blocks', 'options', 'confirm', 'clientMsgId', 'cardKind',
  // CLI arguments that ride along on the same params object
  'conversationId', 'org', 'orgSlug', 'orgId', 'org_id',
]);

/**
 * cws-comm's block vocabulary, used ONLY to phrase the error when one of these
 * names shows up as a TOP-LEVEL key — `fields` is where this whole class of bug
 * was found, and naming the right destination is the difference between an
 * error a caller can act on and one they have to go read source for.
 *
 * Nothing here validates a block. The block rules stay cws-comm's (see the
 * no-local-caps note at the top of this file); if the server adds a type and
 * this list lags, the only cost is a slightly less specific error message, and
 * that type still sends fine inside `blocks`.
 */
const BLOCK_TYPES = new Set([
  'text', 'markdown', 'fields', 'divider', 'image', 'quote', 'artifact_list',
]);

function rejectUnknownParams(params) {
  for (const key of Object.keys(params)) {
    if (KNOWN_PARAMS.has(key)) continue;
    if (key === 'kind') {
      // The endpoint DOES have a kind now, so the generic "no field for it"
      // below would be false here; the caller almost certainly meant the card
      // family.
      throw new InteractionRequestError(
        key,
        'is not a card field: the card family (interaction.choice / onboarding.task / onboarding.channel / '
          + 'onboarding.partner) is `cardKind`, and `kind` is comm.ask_card\'s name for what the question is for',
      );
    }
    const hint = BLOCK_TYPES.has(key)
      ? ` — \`${key}\` is a BLOCK type, not a top-level field: pass it inside \`blocks\`, `
        + `e.g. {"blocks":[{"type":"text","text":"…"},{"type":"${key}", …}]}`
      : '';
    throw new InteractionRequestError(
      key,
      `is not supported by interaction-requests; the endpoint has no field for it${hint}`,
    );
  }
}

export function buildChoiceRequest(params = {}) {
  // First, before any field is read: an unknown key is a caller who thinks they
  // sent something. Report it instead of building a card without it. Running
  // this ahead of the required-field checks means the report names the key they
  // got wrong, not the field they merely also omitted.
  rejectUnknownParams(params);

  const title = requireText(params.title, 'title');
  // summary is the one-line line under the title, and the text a client that
  // cannot render the card falls back to. It is NOT the card body — see the
  // blocks check below. Optional here: the three onboarding guide kinds go
  // without one (workspace-backlog#615), and whether a kind needs it is
  // cws-comm's call — it still refuses a missing summary on every other kind,
  // naming the field. Only the type is checked: given means a real string.
  const summary = params.summary === undefined ? undefined : requireText(params.summary, 'summary');

  // 🔴 The body is not defaulted from `summary`. It used to be, and the card
  // then rendered the same sentence twice — once in the header beside the
  // title, once as the body — because both fields reach the client and neither
  // knows the other repeated it. A convenience default that produces a visibly
  // wrong card is worse than asking the caller for one more field.
  let blocks;
  if (params.blocks !== undefined) {
    // 🔴 Refused, not resolved by precedence. Letting `blocks` win silently is
    // the one silent drop this builder had left: a caller who passed both loses
    // the `text` paragraph without a word, which is exactly what the whitelist
    // above exists to stop. Both documents already tell callers to pass one or
    // the other, so refusing cannot break a caller who was following them.
    if (params.text !== undefined) {
      throw new InteractionRequestError(
        'text',
        'cannot be combined with `blocks`: `text` is shorthand for a single text block, so passing both means one of the two is not being shown — send the paragraph as the first entry of `blocks` instead',
      );
    }
    if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
      throw new InteractionRequestError('blocks', 'must be a non-empty array');
    }
    blocks = params.blocks;
  } else if (params.text !== undefined) {
    blocks = [textBlock(requireText(params.text, 'text'))];
  } else {
    throw new InteractionRequestError('text', 'is required (or pass `blocks`): the card body is not derived from `summary`, which the client already shows beside the title');
  }

  // Options are required now. A zero-button card is not something this path can
  // produce any more — the protocol has no interaction type for it.
  if (!Array.isArray(params.options) || params.options.length === 0) {
    throw new InteractionRequestError('options', 'must be a non-empty array: a choice card without options has no interaction to request');
  }
  const options = params.options.map(normalizeOption);

  // An absent summary leaves no key at all, not an empty string: cws-comm keeps
  // "there is none" and "an empty one was sent" apart.
  const choice = { title, blocks, options };
  if (summary !== undefined) choice.summary = summary;
  // `cardKind`, not `kind`: comm.ask_card and `[CARD]` already use `kind` for
  // what the question is for, and strip it before calling here. Reusing the
  // name would give one word two meanings on the same payload. The value is
  // cws-comm's to judge; it refuses one outside its closed set by name.
  if (params.cardKind !== undefined) choice.kind = params.cardKind;
  if (params.confirm !== undefined) {
    choice.confirm = normalizeConfirm(params.confirm, 'confirm');
  }

  // Always send a key, because the old card path did and a body without one
  // cannot be de-duplicated at all. Be precise about what the generated one
  // buys: the server de-dupes an IDENTICAL key for five minutes, and a fresh
  // uuid per call is identical only within the call that made it. So it covers
  // a retry of the same request object — nothing more.
  //
  // 🔴 It does NOT make a re-invocation safe. If the first request reached the
  // server and only the response was lost, running the same command again mints
  // a new key and posts a SECOND card: two sets of action ids, two receipts, two
  // answers to reconcile, on the one channel whose job is authorizing
  // irreversible things. A caller that wants to survive that has to keep its own
  // `clientMsgId` and pass the same one back.
  const body = { interaction_type: 'choice', choice };
  body.client_msg_id = params.clientMsgId === undefined
    ? newClientMsgId()
    : requireText(params.clientMsgId, 'clientMsgId');
  return body;
}

/**
 * Which interaction a `comm.ask` call or a `[CARD]` payload asks for.
 *
 * `fields` makes a choice form (select, then submit once); `options` makes a
 * quick-reply card. The content decides, so `[CARD]` needs no second prefix;
 * an explicit `interactionType` is accepted and must agree with it.
 *
 * Both present is refused rather than resolved by precedence: one of the two
 * would be dropped without a word. A `fields` that was meant as a fields BLOCK
 * (label/value rows) lands here too, so the error says where that goes.
 */
export function resolveInteractionType(params = {}) {
  const hasFields = params.fields !== undefined;
  const hasOptions = params.options !== undefined;
  if (hasFields && hasOptions) {
    throw new InteractionRequestError(
      'fields',
      'cannot be combined with `options`: `fields` asks a choice form (select, then submit), `options` asks a quick-reply card — send one of them. '
        + 'Label/value rows are a `fields` BLOCK and go inside `blocks`, e.g. {"blocks":[{"type":"fields","items":[…]}]}',
    );
  }
  const declared = params.interactionType;
  if (declared === undefined) return hasFields ? 'form' : 'choice';
  if (declared !== 'choice' && declared !== 'form') {
    throw new InteractionRequestError('interactionType', 'must be "choice" or "form"');
  }
  if (declared === 'form' && hasOptions) {
    throw new InteractionRequestError('options', 'is a quick-reply card field; a form asks its questions in `fields`, each with its own `options`');
  }
  if (declared === 'choice' && hasFields) {
    throw new InteractionRequestError(
      'fields',
      'disagrees with interactionType "choice": `fields` asks a choice form. Label/value rows are a `fields` BLOCK and go inside `blocks`',
    );
  }
  return declared;
}

/**
 * Keys a form card may carry, at each level. Closed sets for the reason
 * KNOWN_PARAMS is one: a misspelled key is otherwise dropped in silence.
 *
 * The step-two keys (`min_select`, `max_select`, `allow_other`, `exclusive`)
 * pass through unchecked: cws-comm accepts them since wsb#602 v1.6 and rules
 * on their values, and checking them here as well would be the second ruling
 * point the note at the top of this file warns about.
 */
const FORM_PARAMS = new Set([
  'title', 'summary', 'text', 'blocks', 'fields', 'answerers', 'group', 'clientMsgId',
  'conversationId', 'org', 'orgSlug', 'orgId', 'org_id',
]);
const FORM_FIELD_KEYS = new Set([
  'key', 'type', 'label', 'description', 'required', 'selection_mode',
  'min_select', 'max_select', 'allow_other', 'options',
  'multiline', 'min_length', 'max_length', 'placeholder',
]);
const FORM_OPTION_KEYS = new Set(['key', 'label', 'description', 'recommended', 'exclusive']);
const FORM_GROUP_KEYS = new Set(['id', 'index', 'total']);

function normalizeFormOption(option, at) {
  if (typeof option === 'string') return { label: requireText(option, at) };
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new InteractionRequestError(at, 'must be a string or an object');
  }
  if (option.id !== undefined) {
    throw new InteractionRequestError(`${at}.id`, 'cannot be set: cws-comm generates option ids and returns them as form_option_ids');
  }
  rejectUnknownKeys(option, FORM_OPTION_KEYS, at, 'a form option carries `label`, and optionally `key`, `description`, `recommended`, `exclusive`');
  requireText(option.label, `${at}.label`);
  return { ...option };
}

function normalizeFormField(field, index) {
  const at = `fields[${index}]`;
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new InteractionRequestError(at, 'must be an object');
  }
  if (field.type === 'text') return normalizeTextField(field, at);
  if (!Array.isArray(field.options) || field.options.length === 0) {
    throw new InteractionRequestError(
      `${at}.options`,
      'must be a non-empty array: every form question offers options. Label/value rows are a `fields` BLOCK and go inside `blocks`',
    );
  }
  rejectUnknownKeys(field, FORM_FIELD_KEYS, at, 'a form question carries `key`, `label`, `options`, and optionally `type`, `description`, `required`, `selection_mode`, `min_select`, `max_select`, `allow_other`; a `type: "text"` question carries `multiline`, `min_length`, `max_length`, `placeholder` instead of options');
  // The key is what the receipt and comm.answered organize answers by, so a
  // question without one cannot be read back. Its format is cws-comm's call.
  requireText(field.key, `${at}.key`);
  requireText(field.label, `${at}.label`);
  // cws-comm defaults a missing `required` to true; a form question the Agent
  // did not mark is meant to be optional (wsb#602 v1.6 D2), so it is written
  // out as false. An explicit value, true included, is sent as given.
  const required = field.required === undefined ? false : field.required;
  // Every selection question offers "other" unless the Agent turns it off
  // (wsb#602, athan 10-21); cws-comm's own default is false.
  const allowOther = field.allow_other === undefined ? true : field.allow_other;
  return {
    ...field,
    required,
    allow_other: allowOther,
    options: field.options.map((o, i) => normalizeFormOption(o, `${at}.options[${i}]`)),
  };
}

/**
 * A fill-in question (`type: "text"`, 09-fillin-contract §1). It has no
 * options and no "other", so `allow_other` is not filled in here (D7): a text
 * question carrying any choice key is cws-comm's to refuse, by name.
 * `required` is filled in as for a choice question; cws-comm ignores it (D8).
 */
function normalizeTextField(field, at) {
  rejectUnknownKeys(field, FORM_FIELD_KEYS, at, 'a text question carries `key`, `label`, `type: "text"`, and optionally `description`, `multiline`, `min_length`, `max_length`, `placeholder`');
  requireText(field.key, `${at}.key`);
  requireText(field.label, `${at}.label`);
  const required = field.required === undefined ? false : field.required;
  return { ...field, required };
}

/**
 * Build the body for `POST /conversations/{id}/interaction-requests` with
 * interaction_type=form (contract 04 §2.1).
 *
 * Values pass through uncoerced and uncapped, exactly as in the choice builder
 * above: counts, lengths, key formats, answerer membership and the step-two
 * keys are all cws-comm's to rule on. The values filled in are `required`
 * and `allow_other` (see normalizeFormField). What is checked here is only what
 * this side needs to read the answer back — every question has a key, every
 * choice question options and every option a label — and the closed key sets.
 */
export function buildFormRequest(params = {}) {
  for (const key of Object.keys(params)) {
    if (FORM_PARAMS.has(key)) continue;
    if (key === 'kind') {
      throw new InteractionRequestError(key, 'is not a card field: `kind` is comm.ask\'s name for what the question is for');
    }
    throw new InteractionRequestError(key, 'is not supported on a form card');
  }

  const title = requireText(params.title, 'title');
  const summary = params.summary === undefined ? undefined : requireText(params.summary, 'summary');

  let blocks = [];
  if (params.blocks !== undefined) {
    if (params.text !== undefined) {
      throw new InteractionRequestError('text', 'cannot be combined with `blocks`: send the paragraph as the first entry of `blocks` instead');
    }
    if (!Array.isArray(params.blocks)) throw new InteractionRequestError('blocks', 'must be an array');
    blocks = params.blocks;
  } else if (params.text !== undefined) {
    blocks = [textBlock(requireText(params.text, 'text'))];
  }

  if (!Array.isArray(params.fields) || params.fields.length === 0) {
    throw new InteractionRequestError('fields', 'must be a non-empty array of questions');
  }
  const fields = params.fields.map(normalizeFormField);

  const form = { title };
  if (summary !== undefined) form.summary = summary;
  form.blocks = blocks;
  form.fields = fields;
  if (params.answerers !== undefined) {
    if (!Array.isArray(params.answerers)) {
      throw new InteractionRequestError('answerers', 'must be an array of member ids');
    }
    form.answerers = params.answerers.map((id, i) => requireText(id, `answerers[${i}]`));
  }
  if (params.group !== undefined) {
    if (!params.group || typeof params.group !== 'object' || Array.isArray(params.group)) {
      throw new InteractionRequestError('group', 'must be an object {id, index, total}');
    }
    rejectUnknownKeys(params.group, FORM_GROUP_KEYS, 'group', 'a group carries `id`, `index` and `total`');
    form.group = { ...params.group };
  }

  // Same client_msg_id rule, and the same limit on what it buys, as the
  // choice builder above.
  return {
    interaction_type: 'form',
    form,
    client_msg_id: params.clientMsgId === undefined ? newClientMsgId() : requireText(params.clientMsgId, 'clientMsgId'),
  };
}
