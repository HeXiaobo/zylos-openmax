/**
 * Connector write confirmation (OPENM-1239): the per-org switch + scope, the
 * card shape, and the gate conn.invoke runs before a write is sent.
 *
 * Config — `orgs.<slug>.connector_confirm` in the plugin config:
 *   enabled  boolean, default false. Off = conn.invoke behaves exactly as
 *            before (no card, no gate). Only the effect log line is added.
 *   scope    "all" | { connectors: [{ app, connectionId? }] }. `app` matches
 *            the connection's slug or applicationId; `connectionId`, when
 *            given, narrows the entry to that one connection.
 *   requested_by / date / ticket — record only, never matched.
 *
 * enabled + in scope: a read runs directly; a write / outbound_message needs a
 * `confirmation` naming a `connector.write_confirm` card the requester answered
 * "确认执行" on, or — for a request that came from an external IM — an
 * external confirmation bound to a record conn.confirm_prepare created
 * (`connector.write_confirm_external`: the same digests, windows and single
 * use as a card; the reply text must be an inbound C4 message on the recorded
 * channel / chat after the prepare). The external path is Agent-attested: the
 * plugin cannot prove that a human, let alone the requester, wrote that
 * reply.
 *
 * This whole gate is a guardrail within the Agent's own trust scope, not a
 * hard security boundary: the Agent can edit pending-questions.json, writes
 * the card text and supplies askedOf / requesterMemberId. It protects against
 * mistakes and injected instructions, not against a compromised Agent.
 *
 * Two windows: the tap must come within 30 minutes of the card being sent
 * (CONNECTOR_CONFIRM_TTL_MS, else `expired`); the confirmed actions then run
 * within 30 minutes of the tap (CONFIRM_EXEC_WINDOW_MS, measured from the
 * receipt-sourced answer time, else `execution_window_expired`).
 *
 * Fail closed: an enabled config with a malformed scope gates EVERYTHING (as
 * "all") and warns; it never silently passes.
 *
 * The answer the gate trusts is the one the bridge wrote from the system-sent
 * interaction receipt (`outcome.source === "receipt"`), never anything the
 * agent passed to comm.answered.
 */

import {
  CONNECTOR_CONFIRM_KIND, CONNECTOR_CONFIRM_EXTERNAL_KIND, CONNECTOR_CONFIRM_TTL_MS, CONFIRM_EXEC_WINDOW_MS, PENDING_QUESTIONS_PATH,
  PENDING_QUESTIONS_MAX, askedOfList, mutatePendingQuestions, trimPendingQuestions,
} from './pending-question.js';
import { DIGEST_RE } from './conn-effect.js';
import { stripMessageParams } from './im-owner-notice.js';
import crypto from 'node:crypto';

export { CONNECTOR_CONFIRM_KIND, CONNECTOR_CONFIRM_EXTERNAL_KIND, CONNECTOR_CONFIRM_TTL_MS, CONFIRM_EXEC_WINDOW_MS };

/** Channels that are not an external IM: Workspace itself and internal C4 channels. */
export const NON_EXTERNAL_CHANNELS = Object.freeze(['openmax', 'workspace', 'internal', 'scheduler', 'system', 'web-console', 'shell']);

/** The two options of a confirmation card, in this order: index 0 confirms. */
export const CONFIRM_OPTIONS = Object.freeze(['确认执行', '取消']);
export const CONFIRM_OPTION_INDEX = 0;

/** What the agent tells the user when a card's parameters no longer match. */
export const DIGEST_MISMATCH_USER_TEXT = '参数和你确认的不一致，需要重新确认';
/** What the agent sends when a card expired unanswered. */
export const EXPIRED_USER_TEXT = '已取消（30 分钟内未确认）';

// ---------------------------------------------------------------------------
//  Config: switch + scope
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate a scope value. Returns { ok: true, scope } with the normalized
 * scope, or { ok: false, error }.
 */
export function validateScope(scope) {
  if (scope === 'all') return { ok: true, scope: 'all' };
  if (!isObj(scope)) return { ok: false, error: 'scope must be "all" or {"connectors":[{"app":"…","connectionId?":"…"}]}' };
  const extra = Object.keys(scope).filter((k) => k !== 'connectors');
  if (extra.length) return { ok: false, error: `scope has unknown key(s): ${extra.join(', ')} (only "connectors")` };
  const list = scope.connectors;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'scope.connectors must be a non-empty array' };
  const connectors = [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (!isObj(c)) return { ok: false, error: `scope.connectors[${i}] must be an object` };
    const unknown = Object.keys(c).filter((k) => k !== 'app' && k !== 'connectionId');
    if (unknown.length) return { ok: false, error: `scope.connectors[${i}] has unknown key(s): ${unknown.join(', ')} (only "app", "connectionId")` };
    if (!nonEmptyString(c.app)) return { ok: false, error: `scope.connectors[${i}].app is required (slug or applicationId)` };
    if (c.connectionId !== undefined && !nonEmptyString(c.connectionId)) {
      return { ok: false, error: `scope.connectors[${i}].connectionId must be a non-empty string when given` };
    }
    connectors.push(c.connectionId !== undefined ? { app: c.app.trim(), connectionId: c.connectionId.trim() } : { app: c.app.trim() });
  }
  return { ok: true, scope: { connectors } };
}

/**
 * The effective policy of one org's `connector_confirm` block.
 * @returns {{enabled: boolean, scope: ("all"|{connectors: object[]}), warning: (string|null)}}
 */
export function resolveConfirmPolicy(cfg) {
  if (cfg === undefined || cfg === null) return { enabled: false, scope: null, warning: null };
  if (!isObj(cfg)) {
    return { enabled: true, scope: 'all', warning: 'connector_confirm is not an object; treated as enabled with scope "all"' };
  }
  const warnings = [];
  let enabled;
  if (cfg.enabled === undefined || cfg.enabled === false) enabled = false;
  else if (cfg.enabled === true) enabled = true;
  else {
    // Not a boolean: someone meant to set it. Fail closed rather than guess "off".
    enabled = true;
    warnings.push(`connector_confirm.enabled must be true/false, got ${JSON.stringify(cfg.enabled)}; treated as enabled`);
  }
  if (!enabled) return { enabled: false, scope: null, warning: null };
  const v = validateScope(cfg.scope);
  if (!v.ok) {
    warnings.push(`connector_confirm.scope is malformed (${v.error}); treated as "all" — every connector write needs confirmation until it is fixed`);
    return { enabled: true, scope: 'all', warning: warnings.join('; ') };
  }
  return { enabled: true, scope: v.scope, warning: warnings.length ? warnings.join('; ') : null };
}

/** Whether a call's connection is covered by an enabled policy's scope. */
export function inScope(policy, { slug, applicationId, connectionId } = {}) {
  if (!policy?.enabled) return false;
  if (policy.scope === 'all') return true;
  const ids = new Set([slug, applicationId].filter(nonEmptyString).map(String));
  for (const c of policy.scope?.connectors || []) {
    if (!ids.has(c.app)) continue;
    if (c.connectionId && c.connectionId !== String(connectionId || '')) continue;
    return true;
  }
  return false;
}

/**
 * Does changing the effective policy `prev` → `next` (both from
 * resolveConfirmPolicy) un-gate anything that was gated? Any previously
 * gated (app, connectionId) that `next` would no longer gate is loosening:
 *   on → off                          reason "disabled"
 *   "all" → a list                    reason "scope_all_to_list"
 *   a list entry not covered by next  reason "scope_narrowed" (removed = those entries)
 * Coverage is by literal app / connectionId string: {app} covers every
 * connection of that app, {app, connectionId} only that connection. A change
 * that also adds something (a swap) is still loosening. A malformed stored
 * scope resolves to "all", so replacing it with a list is loosening.
 * @returns {{loosening: boolean, reason: string|null, removed: object[]}}
 */
export function confirmPolicyLoosening(prev, next) {
  const none = { loosening: false, reason: null, removed: [] };
  if (!prev?.enabled) return none;
  if (!next?.enabled) return { loosening: true, reason: 'disabled', removed: [] };
  if (next.scope === 'all') return none;
  if (prev.scope === 'all') return { loosening: true, reason: 'scope_all_to_list', removed: [] };
  const nextList = next.scope?.connectors || [];
  const removed = (prev.scope?.connectors || []).filter((e) => !nextList.some(
    (n) => n.app === e.app && (!n.connectionId || n.connectionId === e.connectionId),
  ));
  return removed.length ? { loosening: true, reason: 'scope_narrowed', removed } : none;
}

/** Plain-words description of an effective policy, { zh, en }. */
export function describeConfirmPolicy(policy) {
  if (!policy?.enabled) return { zh: '关闭（连接器写操作不需要确认）', en: 'off (connector write actions need no confirmation)' };
  if (policy.scope === 'all') return { zh: '开启，范围：全部连接器', en: 'on, scope: all connectors' };
  const list = policy.scope?.connectors || [];
  return {
    zh: `开启，范围：${list.map((c) => (c.connectionId ? `${c.app}（连接 ${c.connectionId}）` : `${c.app}（全部连接）`)).join('、')}`,
    en: `on, scope: ${list.map((c) => (c.connectionId ? `${c.app} (connection ${c.connectionId})` : `${c.app} (all connections)`)).join(', ')}`,
  };
}

/**
 * What the gate does with a classified call:
 *   off | out_of_scope | read  → run as today
 *   confirm                     → a confirmation is required
 */
export function gateDecision(policy, effect, call) {
  if (!policy?.enabled) return 'off';
  if (!inScope(policy, call)) return 'out_of_scope';
  if (effect === 'read') return 'read';
  return 'confirm';
}

// ---------------------------------------------------------------------------
//  Card shape
// ---------------------------------------------------------------------------

function optionLabel(o) {
  if (typeof o === 'string') return o;
  if (isObj(o)) return o.label ?? o.text;
  return undefined;
}

/**
 * The shape problem of a `connector.write_confirm` card, or null when it is
 * well formed. `parsed` = { interactionType?, askedOf, meta, card }.
 */
export function confirmCardProblem({ interactionType, askedOf, meta, card } = {}) {
  if (interactionType === 'form' || card?.fields !== undefined) {
    return 'must be a choice card (options), not a form';
  }
  if (typeof askedOf !== 'string' || !askedOf.trim()) {
    return 'askedOf must be ONE member id: the requester of this task, who alone can confirm';
  }
  const opts = Array.isArray(card?.options) ? card.options : [];
  if (opts.length !== CONFIRM_OPTIONS.length || opts.some((o, i) => optionLabel(o) !== CONFIRM_OPTIONS[i])) {
    return `options must be exactly ${JSON.stringify(CONFIRM_OPTIONS)} in this order (index 0 confirms)`;
  }
  const actions = meta?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return 'meta.actions must be a non-empty array — build it with conn.confirm_prepare and put it in unchanged';
  }
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    if (!isObj(a)) return `meta.actions[${i}] must be an object`;
    for (const k of ['app', 'action', 'connectionId', 'summary', 'digest']) {
      if (!nonEmptyString(a[k])) return `meta.actions[${i}].${k} is required — build meta.actions with conn.confirm_prepare`;
    }
    if (!DIGEST_RE.test(a.digest)) return `meta.actions[${i}].digest must be the "sha256:<hex>" value conn.confirm_prepare returned`;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Gate errors
// ---------------------------------------------------------------------------

const REQUIRED_HINT = 'This action changes data or sends a message outside (effect=%EFFECT%). Nothing was sent. '
  + 'Run conn.confirm_prepare for the action(s), send ONE confirmation card (kind=connector.write_confirm, askedOf=the requester, '
  + `options ${JSON.stringify(CONFIRM_OPTIONS)}, meta.actions from conn.confirm_prepare), end the turn, and after the requester `
  + 'taps 确认执行 retry with confirmation=<card message id>. 先用 conn.confirm_prepare 生成 meta.actions，发确认卡给发起人，发起人点「确认执行」后带 confirmation=<卡编号> 重试。';

export const GATE_HINTS = Object.freeze({
  card_not_found: 'No local record of this confirmation card (not sent by this Agent, cleared, or pushed out). Send a new card. 找不到这张确认卡，请重新发卡确认。',
  wrong_kind: 'This card is not a connector write confirmation card and cannot authorize a connector write. 这张卡不是连接器写操作确认卡，不能用来授权。',
  not_answered: 'The requester has not confirmed yet. End the turn and wait for the interaction receipt; do not poll. 发起人还没确认，等回执唤醒后再调用，不要轮询。',
  not_confirmed: 'The requester chose 取消. Do not execute; tell them it was cancelled (已取消（未确认）). 发起人选择了取消：不执行。',
  answerer_not_asked: 'The card was answered by someone other than the requester it was asked of; that does not count. Ask the requester to confirm. 点确认的不是发起人，不算数。',
  not_requester: 'The card was asked of a different member than this task\'s requester. Send a new card asked of the requester. 确认卡的确认人不是本次任务的发起人，请给发起人重新发卡。',
  expired: `The confirmation expired (the card was not confirmed within 30 minutes of being sent). Nothing was executed; tell the user (「已过期，未执行」) and send a new card if it is still wanted. 确认已过期，未执行。`,
  execution_window_expired: 'The requester confirmed in time, but more than 30 minutes have passed since they tapped 确认执行, so this confirmation can no longer run actions. Nothing was executed; tell the user (「确认后 30 分钟内未执行，已失效」) and send a new card if it is still wanted. 确认后超过 30 分钟未执行，确认已失效，需重新发卡确认。',
  action_not_listed: 'This call (app / action / connection / parameters) is not one of the actions listed on the card. Send a new card for it. 本次调用不在卡上列出的动作里，需要发新卡确认。',
  digest_mismatch: `The parameters differ from what the requester confirmed. Do NOT change them silently: tell the user in plain words 「${DIGEST_MISMATCH_USER_TEXT}」 and send a new card built from the current parameters with conn.confirm_prepare.`,
  already_used: 'This confirmation was already used for this action (or the whole card is used up); it cannot authorize again. 这张卡已用过，不能再次授权。',
  card_stopped: 'An earlier action on this card failed, so the remaining ones were stopped. Send a new card for them. 前一条失败后已停止；剩余操作需重新发卡确认。',
  external_malformed: 'An external-IM confirmation needs external:true with id (from conn.confirm_prepare with external:{channel, endpoint}), by (who confirmed), at (when) and text (their exact reply). 外部 IM 确认需带 conn.confirm_prepare 返回的 id，并写明确认人、时间和原话。',
  external_not_found: 'No prepared external confirmation with this id (never prepared, cleared, or pushed out). Run conn.confirm_prepare with external:{channel, endpoint} again and ask the requester again. 找不到这条外部确认记录，请重新 conn.confirm_prepare 并重新询问。',
  external_unverified: 'The reply text was not found as an inbound message on the prepared external chat after the confirmation was prepared (or the message store could not be read). Pass text = the requester\'s exact reply in that chat; if they have not replied yet, end the turn and wait. 在该外部会话里找不到这条确认原话（须是准备之后收到的消息），请原样填写发起人的回复，或等待其回复。',
  external_in_workspace: 'This call is in a Workspace (OpenMax) conversation, where only a confirmation card counts; an external-IM text confirmation is refused. Run conn.confirm_prepare and send the card. Workspace 会话里只认确认卡，请发确认卡。',
  requester_missing: 'requesterMemberId is required for a confirmed write: pass the member who asked for this task (the same one the card was asked of). 需要传入本次任务发起人的 requesterMemberId。',
  answerer_not_human: 'The card was answered by a non-human member (e.g. an Agent); only the human requester can confirm. Send a new card. 确认必须由发起人本人（人类成员）点击。',
  confirmation_malformed: 'confirmation must be the card message id (string), {cardMessageId}, or {external:true, id, by, at, text}.',
});

export function gateError(code, reason, { effect, cardMessageId } = {}) {
  const hint = code === 'confirmation_required'
    ? REQUIRED_HINT.replace('%EFFECT%', effect || 'write')
    : GATE_HINTS[reason] || '';
  const msg = code === 'confirmation_required'
    ? `confirmation required: this connector action is a ${effect || 'write'} and the connector is in the write-confirmation scope — nothing was sent`
    : `confirmation rejected (${reason})${cardMessageId ? ` for card ${cardMessageId}` : ''} — nothing was sent`;
  return Object.assign(new Error(msg), {
    status: 403, code, ...(reason ? { reason } : {}), hint, sent: false, gate: true,
    ...(reason === 'digest_mismatch' ? { user_message: DIGEST_MISMATCH_USER_TEXT } : {}),
  });
}

/** The log string of a gate rejection: rejected:<code>[:<reason>]. */
export function rejectedOutcome(err) {
  return `rejected:${err.code}${err.reason ? `:${err.reason}` : ''}`;
}

// ---------------------------------------------------------------------------
//  The gate
// ---------------------------------------------------------------------------

/**
 * Receipt `actor.kind` values that mean a human member tapped. cws-comm sends
 * "human_member"; "human" is accepted as its short form. Anything else
 * (an Agent, a missing kind) cannot confirm.
 */
export const HUMAN_ACTOR_KINDS = Object.freeze(['human_member', 'human']);

function normalizeConfirmation(c) {
  if (c === undefined || c === null || c === '') return null;
  if (typeof c === 'string' || typeof c === 'number') return { cardMessageId: String(c) };
  if (!isObj(c)) return { malformed: true };
  if (c.external === true) return { external: true, id: c.id, by: c.by, at: c.at, text: c.text };
  const id = c.cardMessageId ?? c.card_message_id ?? c.messageId;
  if (typeof id === 'string' || typeof id === 'number') return { cardMessageId: String(id) };
  return { malformed: true };
}

function matches(a, call) {
  const apps = new Set([call.slug, call.applicationId, call.app].filter(nonEmptyString).map(String));
  return apps.has(String(a.app)) && String(a.action) === String(call.action)
    && String(a.connectionId) === String(call.connectionId);
}

/**
 * Check a confirmation for a call and, when it passes, CONSUME the matching
 * card action before anything is sent (a concurrent second call then sees
 * already_used). Throws a gate error (status 403) on any failure; a card-level
 * failure (stopped / used / expired) leaves the record as it is.
 *
 * @param {object} args
 * @param {*} args.confirmation       as passed to conn.invoke
 * @param {object} args.call          { app, slug, applicationId, connectionId, action, digest, effect }
 * @param {string} args.requesterMemberId  required: the member who asked for the task
 * @param {string} [args.conversationId]   the Workspace conversation of the call, when there is one
 * @param {object[]|null} [args.externalRows]  inbound C4 rows (external confirmations only; see findExternalReply)
 * @param {number} [args.now]
 * @param {string} [args.file]
 * @returns {{mode:"card", cardMessageId, actionIndex, confirmer} | {mode:"external", cardMessageId, actionIndex, by, at, agent_at, evidence}}
 */
export function checkConfirmation({
  confirmation, call, requesterMemberId, conversationId, externalRows = null, now = Date.now(), file = PENDING_QUESTIONS_PATH,
}) {
  const c = normalizeConfirmation(confirmation);
  if (!c) throw gateError('confirmation_required', null, { effect: call.effect });
  if (c.malformed) throw gateError('confirmation_invalid', 'confirmation_malformed');
  if (!nonEmptyString(requesterMemberId)) throw gateError('confirmation_invalid', 'requester_missing');
  if (c.external) {
    // External-IM text confirmations are for requests that came from an
    // external IM. A call made in a Workspace conversation must use a card.
    if (conversationId !== undefined && conversationId !== null && String(conversationId).trim() !== '') {
      throw gateError('confirmation_invalid', 'external_in_workspace');
    }
    if (![c.id, c.by, c.at, c.text].every(nonEmptyString)) throw gateError('confirmation_invalid', 'external_malformed');
    return checkExternalConfirmation({ c, call, requesterMemberId, externalRows, now, file });
  }
  const cardMessageId = c.cardMessageId;
  const fail = (reason) => gateError('confirmation_invalid', reason, { cardMessageId });
  return mutatePendingQuestions((records, changed) => {
    const r = records.find((x) => String(x.cardMessageId) === cardMessageId);
    if (!r) throw fail('card_not_found');
    if (r.kind !== CONNECTOR_CONFIRM_KIND) throw fail('wrong_kind');
    if (r.status === 'stopped') throw fail('card_stopped');
    if (r.status === 'expired') throw fail('expired');
    if (r.status === 'used') throw fail('already_used');
    const o = r.outcome;
    // Only the bridge's receipt-sourced outcome counts.
    if (!o || o.source !== 'receipt') throw fail('not_answered');
    const askedOf = askedOfList(r);
    if (!o.actorMemberId || !askedOf.includes(String(o.actorMemberId))) throw fail('answerer_not_asked');
    if (!HUMAN_ACTOR_KINDS.includes(String(o.actorKind || ''))) throw fail('answerer_not_human');
    if (!askedOf.includes(String(requesterMemberId))) throw fail('not_requester');
    if (o.optionIndex !== CONFIRM_OPTION_INDEX) throw fail('not_confirmed');
    // Window 1: the tap (receipt-sourced o.at, never agent-supplied) must
    // come within 30 minutes of the card being sent.
    const asked = Date.parse(r.askedAt);
    const answeredAt = Date.parse(o.at);
    if (Number.isNaN(asked) || Number.isNaN(answeredAt) || answeredAt - asked > CONNECTOR_CONFIRM_TTL_MS) {
      throw fail('expired');
    }
    // Window 2: actions run within 30 minutes of the tap. (Since the tap is
    // at most 30 minutes after the send, nothing runs past send + 60 min.)
    if (now - answeredAt > CONFIRM_EXEC_WINDOW_MS) throw fail('execution_window_expired');
    const actionIndex = consumeAction(r, call, now, fail);
    changed();
    return { mode: 'card', cardMessageId, actionIndex, confirmer: String(o.actorMemberId) };
  }, { file });
}

/**
 * Find the listed action matching `call` (app / action / connection and
 * digest) that is not used yet and mark it used on `r`. Throws `fail(reason)`
 * (digest_mismatch / action_not_listed / already_used) otherwise.
 */
function consumeAction(r, call, now, fail) {
  const actions = Array.isArray(r.meta?.actions) ? r.meta.actions : [];
  const consumed = new Set(Array.isArray(r.consumed) ? r.consumed : []);
  const same = actions.map((a, i) => ({ a, i })).filter(({ a }) => a && matches(a, call));
  const exact = same.filter(({ a }) => String(a.digest) === String(call.digest));
  if (exact.length === 0) throw fail(same.length ? 'digest_mismatch' : 'action_not_listed');
  const free = exact.find(({ i }) => !consumed.has(i));
  if (!free) throw fail('already_used');
  consumed.add(free.i);
  r.consumed = [...consumed].sort((x, y) => x - y);
  r.lastConsumedAt = new Date(now).toISOString();
  if (r.consumed.length >= actions.length) r.status = 'used';
  return free.i;
}

// ---------------------------------------------------------------------------
//  External-IM confirmations
// ---------------------------------------------------------------------------

/** Whitespace-collapsed text for matching a reply against a C4 row. */
export function normalizeReplyText(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

/** A C4 timestamp ("YYYY-MM-DD HH:MM:SS" UTC, or ISO / epoch ms) → ms. */
export function c4RowTime(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

/** The chat identity of an endpoint: message-level params (msg, root, …) dropped. */
export function externalChatKey(endpoint) {
  return stripMessageParams(String(endpoint ?? '').trim());
}

/**
 * The inbound C4 row that carries the external reply, or null: same channel,
 * same chat (endpoint without message-level params), received at or after the
 * prepare (to the second, C4's resolution) and within the 30-minute confirm
 * window, and whose content contains the reply text.
 */
export function findExternalReply(rows, record, text) {
  const want = normalizeReplyText(text);
  if (!want || !Array.isArray(rows)) return null;
  const asked = Date.parse(record.askedAt);
  if (Number.isNaN(asked)) return null;
  const from = Math.floor(asked / 1000) * 1000;
  const channel = String(record.channel || '').toLowerCase();
  const chat = externalChatKey(record.endpoint);
  for (const row of rows) {
    if (String(row?.channel || '').toLowerCase() !== channel) continue;
    if (externalChatKey(row.endpoint_id ?? row.endpoint) !== chat) continue;
    const at = c4RowTime(row.timestamp);
    if (!Number.isFinite(at) || at < from || at - asked > CONNECTOR_CONFIRM_TTL_MS) continue;
    if (!normalizeReplyText(row.content).includes(want)) continue;
    return { id: row.id ?? null, at: new Date(at).toISOString() };
  }
  return null;
}

/**
 * conn.confirm_prepare for a request from an external IM: write a pending
 * confirmation record (no card is sent). The Agent asks in that chat, and
 * conn.invoke then passes {external:true, id, by, at, text}.
 */
export function createExternalConfirmRecord({ actions, requesterMemberId, channel, endpoint, now = Date.now(), file = PENDING_QUESTIONS_PATH }) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('external confirmation: actions are required');
  if (!nonEmptyString(requesterMemberId)) throw new Error('external confirmation: requesterMemberId is required');
  const ch = String(channel ?? '').trim().toLowerCase();
  if (!ch || NON_EXTERNAL_CHANNELS.includes(ch)) {
    throw Object.assign(new Error(`external confirmation: channel must be the external IM the request came from (not ${JSON.stringify(ch || channel)}); in Workspace send a confirmation card`), { status: 400 });
  }
  const ep = externalChatKey(endpoint);
  if (!ep || /[\r\n]/.test(ep)) throw Object.assign(new Error('external confirmation: endpoint (the reply-via endpoint of the request) is required'), { status: 400 });
  const id = `extc_${crypto.randomBytes(12).toString('hex')}`;
  const record = {
    kind: CONNECTOR_CONFIRM_EXTERNAL_KIND,
    cardMessageId: id,
    id,
    external: true,
    channel: ch,
    endpoint: ep,
    requesterMemberId: requesterMemberId.trim(),
    askedAt: new Date(now).toISOString(),
    meta: { actions },
    consumed: [],
  };
  mutatePendingQuestions((records, changed) => {
    records.push(record);
    const kept = trimPendingQuestions(records, PENDING_QUESTIONS_MAX, now);
    records.splice(0, records.length, ...kept);
    changed();
  }, { file });
  return record;
}

/**
 * The external path of checkConfirmation. Check and consume happen in ONE
 * locked read-modify-write of pending-questions.json, the same critical
 * section as a card's.
 *
 * Window 1: the gate must first see the confirmation within 30 minutes of the
 * prepare; that moment (the gate's clock, never the Agent's `at`) is stored
 * as `confirmedAt`. Window 2: actions run within 30 minutes of `confirmedAt`.
 * On first sight the reply text must be an inbound C4 row on the prepared
 * chat (`externalRows`, read by the caller); it is recorded as `evidence`.
 */
function checkExternalConfirmation({ c, call, requesterMemberId, externalRows, now, file }) {
  const id = String(c.id);
  const fail = (reason) => gateError('confirmation_invalid', reason, { cardMessageId: id });
  return mutatePendingQuestions((records, changed) => {
    const r = records.find((x) => String(x.cardMessageId) === id);
    if (!r) throw fail('external_not_found');
    if (r.kind !== CONNECTOR_CONFIRM_EXTERNAL_KIND) throw fail('wrong_kind');
    if (r.status === 'stopped') throw fail('card_stopped');
    if (r.status === 'expired') throw fail('expired');
    if (r.status === 'used') throw fail('already_used');
    if (String(r.requesterMemberId || '') !== String(requesterMemberId)) throw fail('not_requester');
    const asked = Date.parse(r.askedAt);
    if (Number.isNaN(asked)) throw fail('expired');
    let confirmedAt = Date.parse(r.confirmedAt);
    let first = false;
    if (Number.isNaN(confirmedAt)) {
      if (now - asked > CONNECTOR_CONFIRM_TTL_MS) throw fail('expired');
      const evidence = findExternalReply(externalRows, r, c.text);
      if (!evidence) throw fail('external_unverified');
      confirmedAt = now;
      first = true;
      r.evidence = evidence;
    }
    if (now - confirmedAt > CONFIRM_EXEC_WINDOW_MS) throw fail('execution_window_expired');
    const actionIndex = consumeAction(r, call, now, fail);
    if (first) {
      r.confirmedAt = new Date(now).toISOString();
      r.confirmedBy = String(c.by);
      r.confirmedText = String(c.text).slice(0, 500);
      r.agentAt = String(c.at);
    }
    changed();
    return {
      mode: 'external', cardMessageId: id, actionIndex, by: String(c.by), at: r.confirmedAt,
      agent_at: String(c.at), evidence: r.evidence,
    };
  }, { file });
}

/**
 * An action consumed from a card failed: stop the card so its remaining
 * actions are rejected (card_stopped) and need a new confirmation.
 */
export function markConfirmStopped(cardMessageId, { reason = 'action_failed', actionIndex, now = Date.now(), file = PENDING_QUESTIONS_PATH } = {}) {
  return mutatePendingQuestions((records, changed) => {
    const r = records.find((x) => String(x.cardMessageId) === String(cardMessageId));
    if (!r || (r.kind !== CONNECTOR_CONFIRM_KIND && r.kind !== CONNECTOR_CONFIRM_EXTERNAL_KIND)) return false;
    r.status = 'stopped';
    r.stoppedAt = new Date(now).toISOString();
    r.stoppedReason = reason;
    if (actionIndex !== undefined) r.stoppedAtAction = actionIndex;
    changed();
    return true;
  }, { file });
}

// ---------------------------------------------------------------------------
//  Bridge side: receipt outcome + expiry scan
// ---------------------------------------------------------------------------

/** At most this many ignored (not-asked) taps are kept on a card record. */
export const IGNORED_RECEIPTS_MAX = 10;

/**
 * Write a confirmation card's answer from a TRUSTED receipt (`receiptFacts`,
 * which only returns facts for a system-sent interaction receipt). Only
 * `connector.write_confirm` records are touched; the first receipt from a
 * member the card was asked of wins (a redelivery changes nothing). A tap by
 * anyone else is not recorded as the answer: it is kept in `ignoredReceipts`
 * and `{ignored:true, reason, actorMemberId}` is returned. Returns the written
 * outcome, or null when nothing was written.
 */
export function recordConfirmReceipt(facts, { now = Date.now(), file = PENDING_QUESTIONS_PATH } = {}) {
  if (!facts || !facts.cardMessageId || facts.interactionType === 'form') return null;
  return mutatePendingQuestions((records, changed) => {
    const r = records.find((x) => String(x.cardMessageId) === String(facts.cardMessageId));
    if (!r || r.kind !== CONNECTOR_CONFIRM_KIND) return null;
    if (r.outcome?.source === 'receipt') return null;
    if (facts.cardConversationId && r.conversationId && String(facts.cardConversationId) !== String(r.conversationId)) return null;
    const actionId = Array.isArray(facts.selectedActionIds) ? facts.selectedActionIds[0] : undefined;
    // A tap by someone the card was not asked of is not the answer: it is
    // noted (bounded, once per receipt) and the card stays open for the
    // requester, so one wrong tap in a group cannot use the card up.
    if (!facts.actorMemberId || !askedOfList(r).includes(String(facts.actorMemberId))) {
      const ignored = Array.isArray(r.ignoredReceipts) ? r.ignoredReceipts : [];
      const entry = {
        actorMemberId: facts.actorMemberId || '', actorKind: facts.actorKind || '', actionId: actionId ?? null,
        settledAt: facts.settledAt || null, receivedAt: new Date(now).toISOString(),
      };
      if (!ignored.some((x) => x.actorMemberId === entry.actorMemberId && x.settledAt === entry.settledAt && x.actionId === entry.actionId)) {
        r.ignoredReceipts = [...ignored, entry].slice(-IGNORED_RECEIPTS_MAX);
        changed();
      }
      return { ignored: true, reason: 'answerer_not_asked', actorMemberId: entry.actorMemberId };
    }
    const optionIndex = Array.isArray(r.actionIds) && actionId !== undefined ? r.actionIds.indexOf(actionId) : -1;
    const settled = Date.parse(facts.settledAt);
    r.outcome = {
      source: 'receipt',
      actorMemberId: facts.actorMemberId || '',
      actorKind: facts.actorKind || '',
      actionId: actionId ?? null,
      optionIndex,
      at: new Date(Number.isNaN(settled) ? now : settled).toISOString(),
      receivedAt: new Date(now).toISOString(),
    };
    changed();
    return r.outcome;
  }, { file });
}

/**
 * Mark unanswered confirmation cards older than 30 minutes as expired and
 * return them, each exactly once (the mark and `expiryNotifiedAt` are written
 * in the same locked update), so the bridge can wake the agent in the card's
 * conversation to send 「已取消（30 分钟内未确认）」.
 */
export function scanExpiredConfirmCards({ now = Date.now(), file = PENDING_QUESTIONS_PATH } = {}) {
  return mutatePendingQuestions((records, changed) => {
    const out = [];
    for (const r of records) {
      if (r.kind !== CONNECTOR_CONFIRM_KIND) continue;
      if (r.outcome || r.expiryNotifiedAt || ['expired', 'used', 'stopped'].includes(r.status)) continue;
      const asked = Date.parse(r.askedAt);
      if (Number.isNaN(asked) || now - asked <= CONNECTOR_CONFIRM_TTL_MS) continue;
      r.status = 'expired';
      r.expiredAt = new Date(now).toISOString();
      r.expiryNotifiedAt = r.expiredAt;
      out.push({ ...r });
      changed();
    }
    return out;
  }, { file });
}

/** The notice the agent receives for an expired card. */
export function expiredCardNotice(record) {
  const actions = Array.isArray(record?.meta?.actions) ? record.meta.actions : [];
  const list = actions.map((a) => `- ${a.summary || `${a.app} ${a.action}`}`).join('\n');
  return `[Connector Confirmation Expired] The write-confirmation card ${record.cardMessageId} was not confirmed within 30 minutes, `
    + 'so none of its actions will run (a later tap on it is rejected as expired). '
    + `Tell the requester in this conversation, in their language: 「${EXPIRED_USER_TEXT}」. Do not execute these actions without a new card.`
    + (list ? `\nActions on the card:\n${list}` : '');
}
