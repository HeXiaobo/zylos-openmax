/**
 * `[CARD]` asking a choice form: the payload's `fields` picks the form, the
 * request is the contract 04 §2.1 body, and the record is kept per question.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { CARD_PREFIX, CardMessageError, parseCardMessage, sendCardMessage } from './card-message.js';
import { buildFormRequest } from './interaction-request.js';
import { findPendingQuestion } from './pending-question.js';

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

// No cell here may reach the network: every request goes through a stub. A
// real fetch (the conversation-type lookup, a token refresh) is recorded and
// fails the cell, instead of being swallowed by the best-effort lookup.
const realFetch = globalThis.fetch;
let unplannedFetches = [];
beforeEach(() => {
  unplannedFetches = [];
  globalThis.fetch = async (url) => { unplannedFetches.push(String(url)); throw new Error(`unplanned network I/O: ${url}`); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(unplannedFetches, [], 'a unit cell reached the network');
});

/** Cards with answerers read the conversation type first; these cells stub it. */
const groupLookup = async () => 'group';

function stubPost(res = FORM_RES) {
  const calls = [];
  const fn = async (url, body) => { calls.push({ url, body }); return res; };
  fn.calls = calls;
  return fn;
}

test('a [CARD] with fields is sent as a form, with the body the shared builder makes', async () => {
  const parsed = parseCardMessage(asMessage(formCard({ askedOf: 'm-kevin', answerers: ['m-kevin'] })));
  const post = stubPost();
  const result = await sendCardMessage('grp-1', parsed, { post, recordQuestion() {}, conversationType: groupLookup });

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
  await sendCardMessage('grp-1', parsed, { post: stubPost(), now: () => '2026-10-15T00:00:00.000Z', recordOptions: { file }, conversationType: groupLookup });

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
  await assert.rejects(() => sendCardMessage('grp-1', parsed, { post, recordQuestion() {}, conversationType: groupLookup }), /m-ann/);
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
