/**
 * `[CARD]` asking a choice form: the payload's `fields` picks the form, the
 * request is the contract 04 §2.1 body, and the record is kept per question.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CARD_PREFIX, CardMessageError, parseCardMessage, sendCardMessage } from './card-message.js';
import { buildFormRequest } from './interaction-request.js';
import { findPendingQuestion } from './pending-question.js';
import { attachRunToCardRequest } from './activity/reply.js';
import { createRunStore } from './activity/run-store.js';

const formCard = (extra = {}) => ({
  kind:    'sdlc.requirement_intake',
  title:   '需求打磨：开工前 2 个问题',
  summary: '「客户看板」· 答完点一次提交',
  fields:  [
    { key: 'audience', label: '谁来用？', options: [{ key: 'internal', label: '内部员工' }, { label: '外部客户' }] },
    { key: 'cc', label: '抄送谁？', required: false, options: ['产品', '设计'] },
  ],
  ...extra,
});

const asMessage = (payload) => `${CARD_PREFIX}${JSON.stringify(payload)}`;

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-form-')), 'pending.json');
}

const FORM_RES = {
  data: {
    message_id: 'msg-7', seq: 12, created_at: '2026-10-15T00:00:00Z', action_ids: [],
    form_option_ids: { audience: ['opt_1', 'opt_2'], cc: ['opt_3', 'opt_4'] },
  },
};

function stubPost(res = FORM_RES) {
  const calls = [];
  const fn = async (url, body) => { calls.push({ url, body }); return res; };
  fn.calls = calls;
  return fn;
}

test('a [CARD] with fields is sent as a form, with the body the shared builder makes', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-kevin', answerers: ['m-kevin'] })));
  const post = stubPost();
  const result = await sendCardMessage('grp-1', parsed, { post, recordQuestion() {} });

  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].url, '/api/v1/conversations/grp-1/interaction-requests');
  const { client_msg_id: _k, ...sent } = post.calls[0].body;
  const { kind: _kind, ...cardFields } = formCard({ answerers: ['m-kevin'] });
  const { client_msg_id: _e, ...expected } = buildFormRequest(cardFields);
  assert.deepEqual(sent, expected);
  assert.equal(sent.interaction_type, 'form');

  assert.deepEqual(result, {
    ok: true, card: true, interaction_type: 'form', message_id: 'msg-7',
    form_option_ids: FORM_RES.data.form_option_ids, recorded: true,
  });
});

test('the record is kept per question, with askedOf defaulting to the answerers', async () => {
  const file = tmpFile();
  const parsed = parseCardMessage(asMessage(formCard({
    answerers: ['m-kevin', 'm-jessie'], group: { id: 'sdlc-1024', index: 1, total: 2 }, meta: { issue: 42 },
  })));
  await sendCardMessage('grp-1', parsed, { post: stubPost(), now: () => '2026-10-15T00:00:00.000Z', recordOptions: { file } });

  const r = findPendingQuestion('msg-7', { file });
  assert.equal(r.interactionType, 'form');
  assert.deepEqual(r.askedOf, ['m-kevin', 'm-jessie']);
  assert.deepEqual(r.fields, { audience: ['opt_1', 'opt_2'], cc: ['opt_3', 'opt_4'] });
  assert.deepEqual(r.questions.audience.optionKeys, ['internal', '']);
  assert.deepEqual(r.questions.cc, { label: '抄送谁？', required: false, allowOther: true, optionKeys: ['', ''], optionLabels: ['产品', '设计'] });
  assert.deepEqual(r.group, { id: 'sdlc-1024', index: 1, total: 2 });
  assert.equal(r.conversationId, 'grp-1');
  assert.equal(r.askedAt, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(r.meta, { issue: 42 });
});

test('the record says the same required as the wire: omitted → false, explicit true → true (v1.6 D2)', async () => {
  const file = tmpFile();
  const parsed = parseCardMessage(asMessage(formCard({
    askedOf: 'm-kevin',
    fields: [
      { key: 'audience', label: '谁来用？', options: ['内部员工', '外部客户'] },
      { key: 'cc', label: '抄送谁？', required: true, options: ['产品', '设计'] },
    ],
  })));
  const post = stubPost();
  await sendCardMessage('grp-1', parsed, { post, recordOptions: { file } });

  const sent = post.calls[0].body.form.fields.map((f) => f.required);
  const r = findPendingQuestion('msg-7', { file });
  assert.deepEqual(sent, [false, true]);
  assert.deepEqual([r.questions.audience.required, r.questions.cc.required], sent);
});

test('the record says the same allow_other as the wire: omitted → true, explicit false → false', async () => {
  const file = tmpFile();
  const parsed = parseCardMessage(asMessage(formCard({
    askedOf: 'm-kevin',
    fields: [
      { key: 'audience', label: '谁来用？', options: ['内部员工', '外部客户'] },
      { key: 'cc', label: '确认发布？', allow_other: false, options: ['是', '否'] },
    ],
  })));
  const post = stubPost();
  await sendCardMessage('grp-1', parsed, { post, recordOptions: { file } });

  const sent = post.calls[0].body.form.fields.map((f) => f.allow_other);
  const r = findPendingQuestion('msg-7', { file });
  assert.deepEqual(sent, [true, false]);
  assert.deepEqual([r.questions.audience.allowOther, r.questions.cc.allowOther], sent);
});

test('a form needs kind, and askedOf or answerers', () => {
  assert.throws(() => parseCardMessage(asMessage(formCard())), CardMessageError);
  assert.throws(() => parseCardMessage(asMessage(formCard({ answerers: [] }))), CardMessageError);
  assert.throws(() => parseCardMessage(asMessage(formCard({ kind: undefined, askedOf: 'm-1' }))), CardMessageError);
});

test('askedOf naming someone outside answerers is refused before anything is sent', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: ['m-kevin', 'm-ann'], answerers: ['m-kevin'] })));
  const post = stubPost();
  await assert.rejects(() => sendCardMessage('grp-1', parsed, { post, recordQuestion() {} }), /m-ann/);
  assert.equal(post.calls.length, 0);
});

test('fields and options together are refused before anything is sent', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-1', options: ['a', 'b'] })));
  const post = stubPost();
  await assert.rejects(() => sendCardMessage('grp-1', parsed, { post, recordQuestion() {} }), /fields/);
  assert.equal(post.calls.length, 0);
});

test('an explicit interactionType must agree with the content', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-1', interactionType: 'form' })));
  assert.equal(parsed.interactionType, 'form');
  assert.equal('interactionType' in parsed.card, false, 'it is not a card field');
  await sendCardMessage('grp-1', parsed, { post: stubPost(), recordQuestion() {} });
});

test('a response without option ids for every question fails loudly, says the card was sent, records nothing', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-1' })));
  const partial = { message_id: 'msg-7', form_option_ids: { audience: ['opt_1', 'opt_2'] } };
  // Every key present, but one question's ids do not line up with its options:
  // option i would decode as the wrong label.
  const misaligned = { message_id: 'msg-7', form_option_ids: { audience: ['opt_1'], cc: ['opt_3', 'opt_4'] } };
  for (const res of [{ message_id: 'msg-7' }, partial, misaligned, { form_option_ids: FORM_RES.data.form_option_ids }]) {
    let recorded = false;
    await assert.rejects(
      () => sendCardMessage('grp-1', parsed, { post: stubPost(res), recordQuestion() { recorded = true; } }),
      (e) => e instanceof CardMessageError && /was SENT/.test(e.message),
      JSON.stringify(res),
    );
    assert.equal(recorded, false);
  }
});

// ------------------------------------------------- agent activity (send.js)

function liveRunStore(conv) {
  const store = createRunStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'card-form-runs-')) });
  store.writeRun({ v: 1, run_id: 'r_000000f1', org_id: 'org', conversation_id: conv, reply_conversation_id: conv, created_at: Date.now() - 1000, state: 'active', events: [], dropped: 0, next_event: 1 });
  store.writeActive({ v: 1, by_conversation: { [conv]: ['r_000000f1'] }, gate: { org: 'open' } });
  return store;
}
const attachWith = (store, conv, parsed) => (request) => attachRunToCardRequest({
  convId: conv, request, clientMsgIdSupplied: parsed.card.clientMsgId !== undefined, store,
});

test('a [CARD] form via send.js carries agent_run; the claim is keyed by the form client_msg_id and settled', async () => {
  const conv = 'grp-run-1';
  const store = liveRunStore(conv);
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-kevin', clientMsgId: 'cm_form_1' })));
  const post = stubPost();
  const res = await sendCardMessage(conv, parsed, {
    post, recordQuestion: () => {}, attachRun: attachWith(store, conv, parsed), runStore: store,
  });
  assert.equal(res.interaction_type, 'form');
  const body = post.calls[0].body;
  assert.equal(body.interaction_type, 'form');
  assert.equal(body.client_msg_id, 'cm_form_1');
  assert.equal(body.agent_run.run_id, 'r_000000f1');
  const claim = store.readClaim('r_000000f1');
  assert.equal(claim.client_msg_id, 'cm_form_1');
  assert.equal(claim.state, 'delivered');
  assert.equal(claim.kind, 'card');
});

test('a [CARD] form on a server without agent_run support (422): sent again without it, the answer still recorded', async () => {
  const conv = 'grp-run-2';
  const store = liveRunStore(conv);
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-kevin' })));
  const calls = [];
  const recorded = [];
  const res = await sendCardMessage(conv, parsed, {
    post: async (url, body) => {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (body.agent_run) throw Object.assign(new Error('422'), { status: 422 });
      return FORM_RES;
    },
    recordQuestion: (r) => recorded.push(r),
    attachRun: attachWith(store, conv, parsed),
    runStore: store,
  });
  assert.equal(res.message_id, 'msg-7');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].client_msg_id, calls[0].client_msg_id);
  assert.equal('agent_run' in calls[1], false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].interactionType, 'form');
  assert.equal(store.claimExists('r_000000f1'), false);
  assert.equal(store.formCardExists('r_000000f1'), true);
});

test('a [CARD] form without attachRun posts exactly once, with no agent_run', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-kevin' })));
  const post = stubPost();
  await sendCardMessage('grp-1', parsed, { post, recordQuestion() {} });
  assert.equal(post.calls.length, 1);
  assert.equal('agent_run' in post.calls[0].body, false);
});
