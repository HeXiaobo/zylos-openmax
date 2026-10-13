import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from './run-store.js';
import {
  planReplyMetadata, selectRun, classifySendError, noteCardReply,
  attachRunMetadata, attachRunToCardRequest, postWithRunMetadata, cardBodyHash, canonicalJson, semanticBodyHash,
} from './reply.js';
import { classifyAgentRun } from './testdata/validators.js';
import { buildTextBody, buildMediaBody } from '../outbound-body.js';

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
  const ar = p.firstAgentRun;
  assert.equal(ar.run_id, 'r_0000000a');
  assert.equal(ar.schema_version, 2);
  assert.equal(ar.steps.at(-1).title, '发送回复');
  assert.deepEqual(p.laterAgentRun, { schema_version: 2, run_id: 'r_0000000a', ref: true });
  assert.equal(classifyAgentRun({ raw: ar }).verdict, 'ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'pending');
  p.settle('ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'delivered');
  // A second reply of the same run: reference only, no claim of its own.
  const p2 = plan(s, 'second');
  assert.deepEqual(p2.firstAgentRun, { schema_version: 2, run_id: 'r_0000000a', ref: true });
  assert.equal(p2.clientMsgId, null);
  assert.equal(s.store.readSendStats().agent_run_ref, 1);
});

test('gate pending / closed or no active index: no agent_run, no claim', () => {
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
    assert.ok(r.firstAgentRun.steps);
  }
  assert.equal(s.store.readClaim('r_0000000a').attempts, 4);
});

test('a different body after an uncertain outcome: new key, reference only, ambiguous_ref counted', () => {
  const s = setup();
  plan(s, 'v1').settle('uncertain');
  const r = plan(s, 'v2');
  assert.equal(r.clientMsgId, null);
  assert.deepEqual(r.firstAgentRun, { schema_version: 2, run_id: 'r_0000000a', ref: true });
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
  assert.ok(plan(withFocus).firstAgentRun.steps, 'a focus run is still claimed');
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
  assert.equal(req.agent_run.run_id, 'r_0000000a');
  assert.ok(req.agent_run.steps);
  assert.equal(classifyAgentRun({ raw: req.agent_run }).verdict, 'ok');
  p.settle('ok');
  assert.equal(s.store.readClaim('r_0000000a').state, 'delivered');
  // A later card, then a later comm.send text, of the same run: reference only.
  const req2 = card({ client_msg_id: 'cm_gen2', choice: { ...card().choice, title: 'again' } });
  attachCard(s, req2);
  assert.deepEqual(req2.agent_run, { schema_version: 2, run_id: 'r_0000000a', ref: true });
  assert.equal(req2.client_msg_id, 'cm_gen2');
  const msg = { client_msg_id: 'cm_t', type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'hi' }, attachments: [] } };
  attachRunMetadata({ convId: CONV, kind: 'text', body: msg, bodyHash: 'h', now: T0 + 7000, store: s.store });
  assert.deepEqual(msg.agent_run, { schema_version: 2, run_id: 'r_0000000a', ref: true });
});

test('card: a caller-supplied clientMsgId wins; a resend with it reuses the pending claim (ask_card resend safety)', () => {
  const s = setup();
  const p = attachCard(s, card({ client_msg_id: 'cm_mine' }), true);
  p.settle('uncertain');
  const again = card({ client_msg_id: 'cm_mine' });
  attachCard(s, again, true);
  assert.equal(again.client_msg_id, 'cm_mine');
  assert.ok(again.agent_run.steps, 'same body, same key: full summary again');
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

test('card body hash ignores client_msg_id, agent_run and key order (metadata is the caller\'s: it counts)', () => {
  const a = card();
  const b = { client_msg_id: 'other', agent_run: { schema_version: 2 }, choice: { options: a.choice.options, blocks: a.choice.blocks, title: a.choice.title }, interaction_type: 'choice' };
  assert.equal(cardBodyHash(a), cardBodyHash(b));
  assert.notEqual(cardBodyHash(a), cardBodyHash(card({ choice: { ...a.choice, title: 'другое' } })));
  assert.notEqual(cardBodyHash(a), cardBodyHash({ ...a, metadata: { x: 1 } }));
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
});

test('onboarding cards get no agent_run and no claim; a caller agent_run is always dropped, caller metadata kept', () => {
  const s = setup();
  const req = card({ choice: { ...card().choice, kind: 'onboarding.task' }, agent_run: { forged: true }, metadata: { mine: 1 } });
  assert.equal(attachCard(s, req), null);
  assert.equal('agent_run' in req, false);
  assert.deepEqual(req.metadata, { mine: 1 });
  assert.equal(s.store.claimExists('r_0000000a'), false);
  // No run for the conversation: a forged agent_run is dropped too.
  const empty = setup({ runs: [] });
  const msg = { client_msg_id: 'k', agent_run: { schema_version: 2, run_id: 'r_0000000f', ref: true }, metadata: { mine: 2 } };
  assert.equal(attachRunMetadata({ convId: CONV, kind: 'text', body: msg, bodyHash: 'h', store: empty.store }), null);
  assert.equal('agent_run' in msg, false);
  assert.deepEqual(msg.metadata, { mine: 2 });
  // With a run: the summary goes to the top-level field, never into metadata.
  const s2 = setup();
  const msg2 = { client_msg_id: 'k2', metadata: { mine: 3 } };
  attachRunMetadata({ convId: CONV, kind: 'text', body: msg2, bodyHash: 'h2', store: s2.store });
  assert.equal(msg2.agent_run.schema_version, 2);
  assert.deepEqual(msg2.metadata, { mine: 3 });
});

test('postWithRunMetadata: 2xx settles ok; a 422 with agent_run is retried once without it (same key), the claim released', async () => {
  const s = setup();
  const req = card();
  const p = attachCard(s, req);
  const seen = [];
  const res = await postWithRunMetadata(async (path, body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    if (body.agent_run) throw Object.assign(new Error('unknown field agent_run'), { status: 422 });
    return { message_id: 'm1', action_ids: ['a1', 'a2'] };
  }, '/x', req, p, { store: s.store });
  assert.deepEqual(res, { message_id: 'm1', action_ids: ['a1', 'a2'] });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].agent_run);
  assert.equal('agent_run' in seen[1], false);
  assert.equal(seen[1].client_msg_id, seen[0].client_msg_id);
  assert.equal(s.store.claimExists('r_0000000a'), false, 'released: a later reply may carry the summary');
  assert.equal(s.store.formCardExists('r_0000000a'), true);
  assert.equal(s.store.readSendStats().agent_run_unsupported, 1);

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

  // No agent_run on the body: a 422 is the caller's own error, not retried.
  calls = 0;
  await assert.rejects(postWithRunMetadata(async () => { calls += 1; throw Object.assign(new Error('x'), { status: 422 }); }, '/x', { client_msg_id: 'k' }, null), /x/);
  assert.equal(calls, 1);
});

// ── review R4-4: the retry hash covers the whole semantic body ─────────────
const textBody = (over = {}) => ({ client_msg_id: 'cm_a', type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: '同一句话' }, attachments: [] }, ...over });

test('semanticBodyHash: differs on parent / mentions / type / attachments / metadata; ignores generated id and agent_run', () => {
  const base = semanticBodyHash(textBody());
  assert.equal(semanticBodyHash(textBody({ client_msg_id: 'cm_b', agent_run: { schema_version: 2, run_id: 'r_0000000a', ref: true } })), base);
  assert.notEqual(semanticBodyHash(textBody({ metadata: { x: 1 } })), base);
  assert.notEqual(semanticBodyHash(textBody({ parent_id: '77' })), base);
  assert.notEqual(semanticBodyHash(textBody({ mentions: [{ type: 'member', member_id: 'm1' }] })), base);
  assert.notEqual(semanticBodyHash(textBody({ type: 'TEXT' })), base);
  const att = textBody({ content: { content_type: 'text', body: { text: '同一句话' }, attachments: [{ artifact_id: 'art1' }] } });
  assert.notEqual(semanticBodyHash(att), base);
  // A file digest stands in for the (per-upload) artifact id.
  const m1 = buildMediaBody({ kind: 'file', fileName: 'a.pdf', artifactId: 'art-1', mimeType: 'application/pdf', sizeBytes: 3 });
  const m2 = buildMediaBody({ kind: 'file', fileName: 'a.pdf', artifactId: 'art-2', mimeType: 'application/pdf', sizeBytes: 3 });
  assert.equal(semanticBodyHash(m1, { attachmentDigests: ['d1'] }), semanticBodyHash(m2, { attachmentDigests: ['d1'] }));
  assert.notEqual(semanticBodyHash(m1, { attachmentDigests: ['d1'] }), semanticBodyHash(m2, { attachmentDigests: ['d2'] }));
  assert.notEqual(semanticBodyHash(m1), semanticBodyHash(m2), 'without a digest the artifact id counts');
});

test('comm.send path: same text, other parent after an uncertain send → never the first client_msg_id', () => {
  const s = setup();
  const attach = (body, supplied = false) => attachRunMetadata({ convId: CONV, kind: 'text', body, bodyHash: () => semanticBodyHash(body), clientMsgIdSupplied: supplied, store: s.store });
  attach(textBody({ client_msg_id: 'cm_1' })).settle('uncertain');
  const other = textBody({ client_msg_id: 'cm_2', parent_id: '99' });
  const p = attach(other);
  assert.equal(other.client_msg_id, 'cm_2', 'its own key, not cm_1');
  assert.equal(p.clientMsgId, null);
  assert.deepEqual(other.agent_run, { schema_version: 2, run_id: 'r_0000000a', ref: true });
  const sameAgain = textBody({ client_msg_id: 'cm_3' });
  attach(sameAgain);
  assert.equal(sameAgain.client_msg_id, 'cm_1', 'the identical body is the retry: same key');
  // An explicit caller key always stays.
  const mine = textBody({ client_msg_id: 'cm_mine' });
  attach(mine, true);
  assert.equal(mine.client_msg_id, 'cm_mine');
});

test('send.js text path: the first chunk body (parent, mentions) decides the retry key', () => {
  const s = setup();
  let n = 0;
  const planFor = (body) => planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: () => semanticBodyHash(body), newKey: () => `k${++n}`, store: s.store });
  const first = buildTextBody({ text: 'hello', replyTo: '5' });
  assert.equal(first.parent_id, '5');
  assert.equal(buildTextBody({ text: 'hello', replyTo: '5', first: false }).parent_id, undefined);
  planFor(first).settle('uncertain');
  assert.equal(planFor(buildTextBody({ text: 'hello', replyTo: '5' })).clientMsgId, 'k1');
  assert.equal(planFor(buildTextBody({ text: 'hello', replyTo: '6' })).clientMsgId, null);
  assert.equal(planFor(buildTextBody({ text: 'hello', replyTo: '5', mentions: [{ type: 'member', member_id: 'm' }] })).clientMsgId, null);
});

test('send.js media path: same file re-uploaded → same key; other caption / parent / file → not', () => {
  const s = setup();
  let n = 0;
  const planFor = (opts, digest) => planReplyMetadata({ convId: CONV, kind: 'media', bodyHash: () => semanticBodyHash(buildMediaBody(opts), { attachmentDigests: [digest] }), newKey: () => `m${++n}`, store: s.store });
  const opts = { kind: 'image', fileName: 'x.png', artifactId: 'art-1', mimeType: 'image/png', sizeBytes: 9, caption: 'c' };
  planFor(opts, 'd1').settle('uncertain');
  assert.equal(planFor({ ...opts, artifactId: 'art-2' }, 'd1').clientMsgId, 'm1');
  assert.equal(planFor({ ...opts, caption: 'other' }, 'd1').clientMsgId, null);
  assert.equal(planFor({ ...opts, replyTo: '8' }, 'd1').clientMsgId, null);
  assert.equal(planFor(opts, 'd2').clientMsgId, null);
});
