import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from './run-store.js';
import {
  planReplyMetadata, selectRun, classifySendError, noteCardReply,
  attachRunMetadata, attachRunToCardRequest, postWithRunMetadata, cardBodyHash, canonicalJson,
} from './reply.js';
import { classifyAgentRun } from './testdata/validators.js';

const CONV = '019f0000-aaaa-7bbb-8ccc-00000000000a';
const T0 = 1760000000000;

function setup({ gate = 'open', runs = [{ run_id: 'r_0000000a' }], unregistered } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-runs-'));
  const store = createRunStore({ dir });
  for (const [i, r] of runs.entries()) {
    store.writeRun({ org_id: 'org', conversation_id: CONV, created_at: T0 + i * 1000, state: 'active', events: [], dropped: 0, next_event: 1, ...r });
  }
  store.writeActive({ v: 1, by_conversation: { [CONV]: runs.map((r) => r.run_id) }, gate: { org: gate }, ...(unregistered ? { unregistered: { [CONV]: unregistered } } : {}) });
  let n = 0;
  const newKey = () => `c_key${++n}`;
  return { store, newKey };
}
const plan = (s, body = 'hello', now = T0 + 5000) => planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: body, newKey: s.newKey, now, store: s.store });

test('gate open: first reply claims the run and carries the full agent_run the server accepts', () => {
  const s = setup();
  const p = plan(s);
  assert.equal(p.clientMsgId, 'c_key1');
  const ar = p.firstMetadata.agent_run;
  assert.equal(ar.run_id, 'r_0000000a');
  assert.equal(ar.steps.at(-1).category, 'reply');
  assert.deepEqual(p.laterMetadata, { agent_run: { v: 1, run_id: 'r_0000000a' } });
  assert.equal(classifyAgentRun({ enabled: true, senderType: 'agent', raw: ar, now: T0 + 6000 }).verdict, 'ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'pending');
  p.settle('ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'delivered');
  // A second reply of the same run: reference only, no claim of its own.
  const p2 = plan(s, 'second');
  assert.deepEqual(p2.firstMetadata, { agent_run: { v: 1, run_id: 'r_0000000a' } });
  assert.equal(p2.clientMsgId, null);
  assert.equal(s.store.readSendStats().agent_run_ref, 1);
});

test('gate pending / closed or no active index: no metadata, no claim', () => {
  for (const gate of ['pending', 'closed']) {
    const s = setup({ gate });
    assert.equal(plan(s), null);
    assert.equal(s.store.claimExists('r_0000000a'), false);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-runs-'));
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'k', store: createRunStore({ dir }) }), null);
});

test('uncertain outcome keeps the claim; the same body retried reuses K and the full summary (any delay)', () => {
  const s = setup();
  const p = plan(s, 'same body');
  p.settle('uncertain');
  for (const later of [6 * 60_000, 3600_000, 86_400_000]) {
    const r = plan(s, 'same body', T0 + later);
    assert.equal(r.clientMsgId, 'c_key1', `reused after ${later} ms`);
    assert.ok(r.firstMetadata.agent_run.steps);
  }
  assert.equal(s.store.readClaim('r_0000000a').attempts, 4);
});

test('a different body after an uncertain outcome: new key, reference only, ambiguous_ref counted', () => {
  const s = setup();
  plan(s, 'v1').settle('uncertain');
  const r = plan(s, 'v2');
  assert.equal(r.clientMsgId, null);
  assert.deepEqual(r.firstMetadata, { agent_run: { v: 1, run_id: 'r_0000000a' } });
  assert.equal(s.store.readSendStats().agent_run_ambiguous_ref, 1);
});

test('a certain rejection releases the claim; delivered then same body → new key', () => {
  const s = setup();
  plan(s).settle('rejected');
  assert.equal(s.store.claimExists('r_0000000a'), false);
  const p = plan(s);
  p.settle('ok');
  const again = plan(s);
  assert.equal(again.clientMsgId, null, 'after delivery the same body is a new reply with a new key');
});

test('classifySendError', () => {
  for (const st of [400, 401, 403, 404, 413, 422]) assert.equal(classifySendError({ status: st }), 'rejected');
  for (const st of [500, 502, 503, undefined]) assert.equal(classifySendError({ status: st }), 'uncertain');
  assert.equal(classifySendError(new Error('timeout')), 'uncertain');
});

test('selection: focus run first; else the earliest unclaimed', () => {
  const s = setup({ runs: [{ run_id: 'r_0000000a' }, { run_id: 'r_0000000b', focus: true }] });
  assert.equal(selectRun({ store: s.store, active: s.store.readActive(), convId: CONV }).run.run_id, 'r_0000000b');
  const s2 = setup({ runs: [{ run_id: 'r_0000000a' }, { run_id: 'r_0000000b' }] });
  assert.equal(selectRun({ store: s2.store, active: s2.store.readActive(), convId: CONV }).run.run_id, 'r_0000000a');
});

test('r4 guard: an unregistered smart input after the earliest unanswered run and no focus → skip', () => {
  const s = setup({ unregistered: T0 + 500 });
  assert.equal(plan(s), null);
  assert.equal(s.store.claimExists('r_0000000a'), false);
  assert.equal(s.store.readSendStats().agent_run_skipped_unregistered, 1);
  const withFocus = setup({ runs: [{ run_id: 'r_0000000a', focus: true }], unregistered: T0 + 500 });
  assert.ok(plan(withFocus).firstMetadata.agent_run.steps, 'a focus run is still claimed');
});

test('[CARD] does not claim; it only leaves the form-card marker', () => {
  const s = setup();
  noteCardReply({ convId: CONV, store: s.store });
  assert.equal(s.store.claimExists('r_0000000a'), false);
  assert.equal(s.store.formCardExists('r_0000000a'), true);
});

test('broken run store never throws into the send path', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.store.dir, 'r_0000000a.json'), '{not json');
  assert.equal(plan(s), null);
});

// ── comm CLI / card requests ───────────────────────────────────────────────
const card = (over = {}) => ({
  interaction_type: 'choice',
  choice: { title: '确认?', blocks: [{ type: 'text', text: 'x' }], options: [{ label: '是' }, { label: '否' }] },
  client_msg_id: 'cm_gen1',
  ...over,
});
const attachCard = (s, request, supplied = false, now = T0 + 5000) => attachRunToCardRequest({ convId: CONV, request, clientMsgIdSupplied: supplied, now, store: s.store });

test('card: first card claims the run with ITS client_msg_id and carries the full agent_run; a 2nd message carries the reference', () => {
  const s = setup();
  const req = card();
  const p = attachCard(s, req);
  assert.equal(req.client_msg_id, 'cm_gen1');
  assert.equal(s.store.readClaim('r_0000000a').client_msg_id, 'cm_gen1', 'claim key == card key');
  assert.equal(s.store.readClaim('r_0000000a').kind, 'card');
  assert.equal(req.metadata.agent_run.run_id, 'r_0000000a');
  assert.ok(req.metadata.agent_run.steps);
  assert.equal(classifyAgentRun({ enabled: true, senderType: 'agent', raw: req.metadata.agent_run, now: T0 + 6000 }).verdict, 'ok');
  p.settle('ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'delivered');
  // A later card, then a later comm.send text, of the same run: reference only.
  const req2 = card({ client_msg_id: 'cm_gen2', choice: { ...card().choice, title: 'again' } });
  attachCard(s, req2);
  assert.deepEqual(req2.metadata, { agent_run: { v: 1, run_id: 'r_0000000a' } });
  assert.equal(req2.client_msg_id, 'cm_gen2');
  const msg = { client_msg_id: 'cm_t', type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'hi' }, attachments: [] } };
  attachRunMetadata({ convId: CONV, kind: 'text', body: msg, bodyHash: 'h', now: T0 + 7000, store: s.store });
  assert.deepEqual(msg.metadata, { agent_run: { v: 1, run_id: 'r_0000000a' } });
});

test('card: a caller-supplied clientMsgId wins; a resend with it reuses the pending claim (ask_card resend safety)', () => {
  const s = setup();
  const p = attachCard(s, card({ client_msg_id: 'cm_mine' }), true);
  p.settle('uncertain');
  const again = card({ client_msg_id: 'cm_mine' });
  attachCard(s, again, true);
  assert.equal(again.client_msg_id, 'cm_mine');
  assert.ok(again.metadata.agent_run.steps, 'same body, same key: full summary again');
  assert.equal(s.store.readClaim('r_0000000a').attempts, 2);

  // First attempt with a generated key, retry with a caller key: the caller's
  // key stays on the card and the claim is re-keyed to it.
  const s2 = setup();
  attachCard(s2, card({ client_msg_id: 'cm_gen1' })).settle('uncertain');
  const mine = card({ client_msg_id: 'cm_mine' });
  attachCard(s2, mine, true);
  assert.equal(mine.client_msg_id, 'cm_mine');
  assert.equal(s2.store.readClaim('r_0000000a').client_msg_id, 'cm_mine');

  // Generated key on the retry: replaced by the pending claim's key (server de-dupes).
  const s3 = setup();
  attachCard(s3, card({ client_msg_id: 'cm_gen1' })).settle('uncertain');
  const gen = card({ client_msg_id: 'cm_gen9' });
  attachCard(s3, gen);
  assert.equal(gen.client_msg_id, 'cm_gen1');
});

test('card body hash ignores client_msg_id, metadata and key order', () => {
  const a = card();
  const b = { client_msg_id: 'other', metadata: { agent_run: {} }, choice: { options: a.choice.options, blocks: a.choice.blocks, title: a.choice.title }, interaction_type: 'choice' };
  assert.equal(cardBodyHash(a), cardBodyHash(b));
  assert.notEqual(cardBodyHash(a), cardBodyHash(card({ choice: { ...a.choice, title: 'другое' } })));
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
});

test('onboarding cards get no agent_run and no claim; caller metadata is always dropped', () => {
  const s = setup();
  const req = card({ choice: { ...card().choice, kind: 'onboarding.task' }, metadata: { forged: true } });
  assert.equal(attachCard(s, req), null);
  assert.equal('metadata' in req, false);
  assert.equal(s.store.claimExists('r_0000000a'), false);
  // No run for the conversation: forged metadata is dropped too.
  const empty = setup({ runs: [] });
  const msg = { client_msg_id: 'k', metadata: { agent_run: { v: 1, run_id: 'r_0000000f' } } };
  assert.equal(attachRunMetadata({ convId: CONV, kind: 'text', body: msg, bodyHash: 'h', store: empty.store }), null);
  assert.equal('metadata' in msg, false);
});

test('postWithRunMetadata: 2xx settles ok; a 422 with metadata is retried once without it (same key), the claim released', async () => {
  const s = setup();
  const req = card();
  const p = attachCard(s, req);
  const seen = [];
  const res = await postWithRunMetadata(async (path, body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    if (body.metadata) throw Object.assign(new Error('unknown field metadata'), { status: 422 });
    return { message_id: 'm1', action_ids: ['a1', 'a2'] };
  }, '/x', req, p, { store: s.store });
  assert.deepEqual(res, { message_id: 'm1', action_ids: ['a1', 'a2'] });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].metadata);
  assert.equal('metadata' in seen[1], false);
  assert.equal(seen[1].client_msg_id, seen[0].client_msg_id);
  assert.equal(s.store.claimExists('r_0000000a'), false, 'released: a later reply may carry the summary');
  assert.equal(s.store.formCardExists('r_0000000a'), true);
  assert.equal(s.store.readSendStats().agent_run_metadata_unsupported, 1);

  const s2 = setup();
  const req2 = card();
  const p2 = attachCard(s2, req2);
  await postWithRunMetadata(async () => ({ ok: 1 }), '/x', req2, p2, { store: s2.store });
  assert.equal(s2.store.readClaim('r_0000000a').state, 'delivered');
});

test('postWithRunMetadata: other errors are not retried; a 422 again on the retry is thrown and releases the claim', async () => {
  const s = setup();
  const req = card();
  const p = attachCard(s, req);
  let calls = 0;
  await assert.rejects(postWithRunMetadata(async () => { calls += 1; throw Object.assign(new Error('boom'), { status: 503 }); }, '/x', req, p, { store: s.store }), /boom/);
  assert.equal(calls, 1);
  assert.equal(s.store.readClaim('r_0000000a').state, 'pending', 'uncertain keeps the claim');

  const s2 = setup();
  const req2 = card();
  const p2 = attachCard(s2, req2);
  calls = 0;
  await assert.rejects(postWithRunMetadata(async () => { calls += 1; throw Object.assign(new Error('bad card'), { status: 422 }); }, '/x', req2, p2, { store: s2.store }), /bad card/);
  assert.equal(calls, 2);
  assert.equal(s2.store.claimExists('r_0000000a'), false);

  // No metadata on the body: a 422 is the caller's own error, not retried.
  calls = 0;
  await assert.rejects(postWithRunMetadata(async () => { calls += 1; throw Object.assign(new Error('x'), { status: 422 }); }, '/x', { client_msg_id: 'k' }, null), /x/);
  assert.equal(calls, 1);
});
