import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateScope, resolveConfirmPolicy, inScope, gateDecision, confirmCardProblem,
  checkConfirmation, markConfirmStopped, recordConfirmReceipt, scanExpiredConfirmCards, expiredCardNotice,
  CONFIRM_OPTIONS, CONNECTOR_CONFIRM_KIND, CONNECTOR_CONFIRM_TTL_MS, DIGEST_MISMATCH_USER_TEXT,
} from './connector-confirm.js';
import {
  recordPendingQuestion, listPendingQuestions, trimPendingQuestions, PENDING_QUESTIONS_MAX, findPendingQuestion,
} from './pending-question.js';
import { paramsDigest } from './conn-effect.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-')), 'pending-questions.json');

const P1 = { product_id: '1', variant: { price: '179.10' } };
const P2 = { product_id: '2', variant: { price: '80.10' } };
const A = (params, extra = {}) => ({
  app: 'shopify-app', action: 'shopify-app-products/update-variant', connectionId: 'c1',
  summary: 's', effect: 'write', digest: paramsDigest(params), ...extra,
});

function card(file, { id = 'm1', askedOf = 'u-req', actions = [A(P1), A(P2)], outcome, askedAt = iso(T0), kind = CONNECTOR_CONFIRM_KIND, extra = {} } = {}) {
  recordPendingQuestion({
    kind, askedOf, conversationId: 'conv-1', cardMessageId: id, actionIds: ['opt_1', 'opt_2'], askedAt,
    meta: { actions }, ...extra,
  }, { file });
  if (outcome) {
    const recs = JSON.parse(fs.readFileSync(file, 'utf8'));
    recs.find((r) => r.cardMessageId === id).outcome = outcome;
    fs.writeFileSync(file, JSON.stringify(recs));
  }
}
const receiptOutcome = (o = {}) => ({ source: 'receipt', actorMemberId: 'u-req', optionIndex: 0, at: iso(T0 + 60_000), ...o });
const call = (params = P1, extra = {}) => ({
  app: 'shopify-app', slug: 'shopify-app', applicationId: 'app-uuid', connectionId: 'c1',
  action: 'shopify-app-products/update-variant', effect: 'write', digest: paramsDigest(params), ...extra,
});
function rejects(fn, code, reason) {
  try { fn(); } catch (e) {
    assert.equal(e.status, 403);
    assert.equal(e.code, code);
    assert.equal(e.reason, reason ?? undefined);
    assert.equal(e.sent, false);
    assert.ok(e.hint, 'has a hint');
    return e;
  }
  assert.fail(`expected rejection ${code}:${reason}`);
}

// --- scope + policy --------------------------------------------------------

test('validateScope: "all", connector lists, and malformed shapes', () => {
  assert.deepEqual(validateScope('all'), { ok: true, scope: 'all' });
  assert.deepEqual(validateScope({ connectors: [{ app: 'shopify-app', connectionId: 'c1' }, { app: 'googlesheets' }] }).scope,
    { connectors: [{ app: 'shopify-app', connectionId: 'c1' }, { app: 'googlesheets' }] });
  for (const bad of [undefined, null, 'ALL', 'some', [], {}, { connectors: [] }, { connectors: 'x' }, { connectors: [{}] },
    { connectors: [{ app: '' }] }, { connectors: [{ app: 'a', connectionId: '' }] }, { connectors: [{ app: 'a', extra: 1 }] },
    { connectors: [{ app: 'a' }], other: 1 }, { connectors: ['a'] }]) {
    assert.equal(validateScope(bad).ok, false, JSON.stringify(bad));
  }
});

test('resolveConfirmPolicy: default off; enabled+valid; malformed scope → "all" with a warning (never silently off)', () => {
  assert.deepEqual(resolveConfirmPolicy(undefined), { enabled: false, scope: null, warning: null });
  assert.equal(resolveConfirmPolicy({}).enabled, false);
  assert.equal(resolveConfirmPolicy({ enabled: false, scope: 'garbage' }).enabled, false);
  assert.deepEqual(resolveConfirmPolicy({ enabled: true, scope: 'all' }), { enabled: true, scope: 'all', warning: null });
  for (const scope of [undefined, 'some', { connectors: [] }, { connectors: [{ connectionId: 'c1' }] }]) {
    const p = resolveConfirmPolicy({ enabled: true, scope });
    assert.equal(p.enabled, true);
    assert.equal(p.scope, 'all');
    assert.match(p.warning, /malformed/);
  }
  const nb = resolveConfirmPolicy({ enabled: 'true', scope: 'all' });
  assert.equal(nb.enabled, true);
  assert.match(nb.warning, /true\/false/);
  assert.equal(resolveConfirmPolicy('on').scope, 'all');
});

test('inScope / gateDecision: slug or applicationId, optional connectionId narrowing', () => {
  const pol = resolveConfirmPolicy({ enabled: true, scope: { connectors: [{ app: 'shopify-app', connectionId: 'c1' }, { app: 'app-gs' }] } });
  assert.equal(inScope(pol, { slug: 'shopify-app', connectionId: 'c1' }), true);
  assert.equal(inScope(pol, { slug: 'shopify-app', connectionId: 'c2' }), false);
  assert.equal(inScope(pol, { slug: 'googlesheets', applicationId: 'app-gs', connectionId: 'zz' }), true);
  assert.equal(inScope(pol, { slug: 'gmail', connectionId: 'c1' }), false);
  assert.equal(gateDecision(resolveConfirmPolicy(undefined), 'write', { slug: 'shopify-app' }), 'off');
  assert.equal(gateDecision(pol, 'write', { slug: 'gmail' }), 'out_of_scope');
  assert.equal(gateDecision(pol, 'read', { slug: 'shopify-app', connectionId: 'c1' }), 'read');
  assert.equal(gateDecision(pol, 'write', { slug: 'shopify-app', connectionId: 'c1' }), 'confirm');
  assert.equal(gateDecision(pol, 'outbound_message', { slug: 'shopify-app', connectionId: 'c1' }), 'confirm');
  const malformed = resolveConfirmPolicy({ enabled: true, scope: { connectors: 'oops' } });
  assert.equal(gateDecision(malformed, 'write', { slug: 'anything' }), 'confirm');
});

// --- card shape -------------------------------------------------------------

test('confirmCardProblem: well-formed card passes; each broken field is named', () => {
  const ok = { askedOf: 'u-req', meta: { actions: [A(P1)] }, card: { options: CONFIRM_OPTIONS.map((label) => ({ label })) } };
  assert.equal(confirmCardProblem(ok), null);
  assert.equal(confirmCardProblem({ ...ok, card: { options: [...CONFIRM_OPTIONS] } }), null);
  assert.match(confirmCardProblem({ ...ok, askedOf: ['u-req'] }), /ONE member/);
  assert.match(confirmCardProblem({ ...ok, card: { options: [{ label: '取消' }, { label: '确认执行' }] } }), /options/);
  assert.match(confirmCardProblem({ ...ok, card: { options: [{ label: '确认执行' }] } }), /options/);
  assert.match(confirmCardProblem({ ...ok, meta: { actions: [] } }), /meta\.actions/);
  assert.match(confirmCardProblem({ ...ok, meta: {} }), /meta\.actions/);
  for (const k of ['app', 'action', 'connectionId', 'summary', 'digest']) {
    const a = A(P1); delete a[k];
    assert.match(confirmCardProblem({ ...ok, meta: { actions: [a] } }), new RegExp(`\\.${k} is required`));
  }
  assert.match(confirmCardProblem({ ...ok, meta: { actions: [A(P1, { digest: 'abc' })] } }), /sha256/);
  assert.match(confirmCardProblem({ ...ok, interactionType: 'form' }), /choice card/);
});

// --- gate ---------------------------------------------------------------------

test('gate: no confirmation → confirmation_required (hint names conn.confirm_prepare)', () => {
  const e = rejects(() => checkConfirmation({ confirmation: undefined, call: call(), file: tmpFile() }), 'confirmation_required', null);
  assert.match(e.hint, /conn\.confirm_prepare/);
});

test('gate: every rejection reason', () => {
  const now = T0 + 5 * 60_000;
  let f = tmpFile();
  rejects(() => checkConfirmation({ confirmation: 'nope', call: call(), now, file: f }), 'confirmation_invalid', 'card_not_found');

  f = tmpFile(); card(f, { kind: 'upgrade.confirm', outcome: receiptOutcome() });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'wrong_kind');

  f = tmpFile(); card(f);
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'not_answered');

  // An outcome NOT written from the receipt (e.g. agent-supplied) is ignored.
  f = tmpFile(); card(f, { outcome: { ...receiptOutcome(), source: 'agent' } });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'not_answered');

  f = tmpFile(); card(f, { outcome: receiptOutcome({ optionIndex: 1 }) });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'not_confirmed');

  f = tmpFile(); card(f, { outcome: receiptOutcome({ actorMemberId: 'u-other' }) });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'answerer_not_asked');

  f = tmpFile(); card(f, { outcome: receiptOutcome() });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), requesterMemberId: 'u-someone-else', now, file: f }), 'confirmation_invalid', 'not_requester');

  // Invoked more than 30 minutes after the card was asked.
  f = tmpFile(); card(f, { outcome: receiptOutcome() });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now: T0 + CONNECTOR_CONFIRM_TTL_MS + 1, file: f }), 'confirmation_invalid', 'expired');
  // Answered after 30 minutes (a late tap on a card not yet scanned).
  f = tmpFile(); card(f, { outcome: receiptOutcome({ at: iso(T0 + CONNECTOR_CONFIRM_TTL_MS + 1000) }) });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now: T0 + 60_000, file: f }), 'confirmation_invalid', 'expired');
  // Marked expired by the scan.
  f = tmpFile(); card(f, { outcome: receiptOutcome(), extra: { status: 'expired' } });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'expired');

  f = tmpFile(); card(f, { outcome: receiptOutcome() });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(P1, { action: 'shopify-app-products/delete' }), now, file: f }), 'confirmation_invalid', 'action_not_listed');
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(P1, { connectionId: 'c2' }), now, file: f }), 'confirmation_invalid', 'action_not_listed');

  f = tmpFile(); card(f, { outcome: receiptOutcome(), extra: { status: 'stopped' } });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'card_stopped');

  f = tmpFile(); card(f, { outcome: receiptOutcome(), extra: { status: 'used' } });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now, file: f }), 'confirmation_invalid', 'already_used');

  rejects(() => checkConfirmation({ confirmation: { external: true, by: 'Lin', at: '2026-11-23T10:00:00Z' }, call: call(), now, file: f }), 'confirmation_invalid', 'external_malformed');
  rejects(() => checkConfirmation({ confirmation: { foo: 1 }, call: call(), now, file: f }), 'confirmation_invalid', 'confirmation_malformed');
});

test('gate: digest mismatch → digest_mismatch with the plain-words re-confirm text', () => {
  const f = tmpFile(); card(f, { outcome: receiptOutcome() });
  const e = rejects(() => checkConfirmation({ confirmation: 'm1', call: call({ product_id: '1', variant: { price: '9.90' } }), now: T0 + 60_000, file: f }), 'confirmation_invalid', 'digest_mismatch');
  assert.equal(e.user_message, DIGEST_MISMATCH_USER_TEXT);
  assert.ok(e.hint.includes(DIGEST_MISMATCH_USER_TEXT));
  // Nothing consumed by a rejection.
  assert.equal(findPendingQuestion('m1', { file: f }).consumed, undefined);
});

test('gate: passes, consumes each action once; card "used" when all consumed', () => {
  const f = tmpFile(); card(f, { outcome: receiptOutcome(), actions: [A(P1), A(P2, { app: 'app-uuid' })] });
  const now = T0 + 2 * 60_000;
  const ok1 = checkConfirmation({ confirmation: 'm1', call: call(P1), requesterMemberId: 'u-req', now, file: f });
  assert.deepEqual(ok1, { mode: 'card', cardMessageId: 'm1', actionIndex: 0, confirmer: 'u-req' });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(P1), now, file: f }), 'confirmation_invalid', 'already_used');
  // A card entry naming the applicationId matches too; {cardMessageId} object form works.
  const ok2 = checkConfirmation({ confirmation: { cardMessageId: 'm1' }, call: call(P2), now, file: f });
  assert.equal(ok2.actionIndex, 1);
  const rec = findPendingQuestion('m1', { file: f });
  assert.deepEqual(rec.consumed, [0, 1]);
  assert.equal(rec.status, 'used');
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(P2), now, file: f }), 'confirmation_invalid', 'already_used');
});

test('gate: first failure stops the card; the remaining actions are rejected card_stopped', () => {
  const f = tmpFile(); card(f, { outcome: receiptOutcome() });
  const now = T0 + 60_000;
  checkConfirmation({ confirmation: 'm1', call: call(P1), now, file: f });
  assert.equal(markConfirmStopped('m1', { reason: 'provider_status:500', actionIndex: 0, now, file: f }), true);
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(P2), now, file: f }), 'confirmation_invalid', 'card_stopped');
  assert.equal(findPendingQuestion('m1', { file: f }).stoppedReason, 'provider_status:500');
});

test('gate: external IM text confirmation with all fields → allowed, not verified', () => {
  const r = checkConfirmation({ confirmation: { external: true, by: '林店主', at: '2026-11-23T10:00:00Z', text: '确认' }, call: call(), file: tmpFile() });
  assert.deepEqual(r, { mode: 'external', by: '林店主', at: '2026-11-23T10:00:00Z' });
});

// --- receipt outcome (bridge) ----------------------------------------------

const facts = (o = {}) => ({
  selectedActionIds: ['opt_1'], selectedCount: 1, actorMemberId: 'u-req', actorKind: 'human',
  cardConversationId: 'conv-1', cardMessageId: 'm1', settledAt: iso(T0 + 90_000), ...o,
});

test('recordConfirmReceipt: writes source:"receipt" outcome; first receipt wins; gate then passes', () => {
  const f = tmpFile(); card(f);
  const out = recordConfirmReceipt(facts(), { now: T0 + 91_000, file: f });
  assert.equal(out.source, 'receipt');
  assert.equal(out.optionIndex, 0);
  assert.equal(out.actorMemberId, 'u-req');
  assert.equal(out.at, iso(T0 + 90_000));
  // A second (forged or redelivered) receipt changes nothing.
  assert.equal(recordConfirmReceipt(facts({ actorMemberId: 'u-other', selectedActionIds: ['opt_2'] }), { file: f }), null);
  assert.equal(findPendingQuestion('m1', { file: f }).outcome.actorMemberId, 'u-req');
  assert.equal(checkConfirmation({ confirmation: 'm1', call: call(P1), now: T0 + 100_000, file: f }).mode, 'card');
});

test('recordConfirmReceipt: cancel → optionIndex 1; other kinds, forms, unknown cards and wrong conversation are untouched', () => {
  let f = tmpFile(); card(f);
  assert.equal(recordConfirmReceipt(facts({ selectedActionIds: ['opt_2'] }), { file: f }).optionIndex, 1);
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now: T0 + 100_000, file: f }), 'confirmation_invalid', 'not_confirmed');

  f = tmpFile(); card(f, { kind: 'upgrade.confirm' });
  assert.equal(recordConfirmReceipt(facts(), { file: f }), null);
  assert.equal(findPendingQuestion('m1', { file: f }).outcome, undefined);

  f = tmpFile(); card(f);
  assert.equal(recordConfirmReceipt(facts({ cardConversationId: 'conv-OTHER' }), { file: f }), null);
  assert.equal(recordConfirmReceipt(facts({ interactionType: 'form' }), { file: f }), null);
  assert.equal(recordConfirmReceipt(facts({ cardMessageId: 'unknown' }), { file: f }), null);
  assert.equal(recordConfirmReceipt(null, { file: f }), null);
  assert.equal(findPendingQuestion('m1', { file: f }).outcome, undefined);

  // A different member's tap is recorded as-is; the gate rejects it.
  f = tmpFile(); card(f);
  recordConfirmReceipt(facts({ actorMemberId: 'u-other' }), { file: f });
  rejects(() => checkConfirmation({ confirmation: 'm1', call: call(), now: T0 + 100_000, file: f }), 'confirmation_invalid', 'answerer_not_asked');
});

// --- expiry scan --------------------------------------------------------------

test('scanExpiredConfirmCards: only unanswered confirm cards older than 30 min, each exactly once; later tap rejected', () => {
  const f = tmpFile();
  card(f, { id: 'old' });
  card(f, { id: 'fresh', askedAt: iso(T0 + 20 * 60_000) });
  card(f, { id: 'answered', outcome: receiptOutcome() });
  card(f, { id: 'other-kind', kind: 'upgrade.confirm' });
  const now = T0 + CONNECTOR_CONFIRM_TTL_MS + 1000;
  const first = scanExpiredConfirmCards({ now, file: f });
  assert.deepEqual(first.map((r) => r.cardMessageId), ['old']);
  assert.equal(first[0].status, 'expired');
  assert.deepEqual(scanExpiredConfirmCards({ now: now + 60_000, file: f }), [], 'notified only once');
  assert.equal(findPendingQuestion('fresh', { file: f }).status, undefined);
  // A tap arriving after expiry is recorded but cannot authorize.
  recordConfirmReceipt(facts({ cardMessageId: 'old' }), { now, file: f });
  rejects(() => checkConfirmation({ confirmation: 'old', call: call(), now, file: f }), 'confirmation_invalid', 'expired');
  assert.match(expiredCardNotice(first[0]), /已取消（30 分钟内未确认）/);
});

// --- trim priority --------------------------------------------------------------

test('trim at PENDING_QUESTIONS_MAX drops live confirm cards last', () => {
  const f = tmpFile();
  card(f, { id: 'confirm-live', askedAt: iso(T0) });
  card(f, { id: 'confirm-used', askedAt: iso(T0), extra: { status: 'used' } });
  for (let i = 0; i < PENDING_QUESTIONS_MAX; i += 1) {
    recordPendingQuestion({ kind: 'k', askedOf: 'u', conversationId: 'c', cardMessageId: `q${i}`, actionIds: ['a'], askedAt: iso(T0 + 1000 + i) }, { file: f });
  }
  const ids = listPendingQuestions({ file: f }).map((r) => r.cardMessageId);
  assert.equal(ids.length, PENDING_QUESTIONS_MAX);
  assert.ok(ids.includes('confirm-live'), 'live confirm card survived');
  assert.ok(!ids.includes('confirm-used'), 'used confirm card dropped like any other');
  assert.ok(!ids.includes('q0'), 'oldest ordinary card dropped');
  // When only live confirm cards are left to drop, the oldest goes first.
  const recs = [1, 2, 3].map((i) => ({ kind: CONNECTOR_CONFIRM_KIND, cardMessageId: `c${i}`, askedAt: iso(T0 + i) }));
  assert.deepEqual(trimPendingQuestions(recs, 2, T0 + 10).map((r) => r.cardMessageId), ['c2', 'c3']);
  // An expired-by-age confirm card is not protected.
  const aged = [{ kind: CONNECTOR_CONFIRM_KIND, cardMessageId: 'aged', askedAt: iso(T0) }, { kind: 'k', cardMessageId: 'n', askedAt: iso(T0 + 1) }];
  assert.deepEqual(trimPendingQuestions(aged, 1, T0 + CONNECTOR_CONFIRM_TTL_MS + 5).map((r) => r.cardMessageId), ['n']);
});
