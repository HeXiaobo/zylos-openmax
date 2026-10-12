import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from './run-store.js';
import { planReplyMetadata, selectRun, classifySendError, noteCardReply } from './reply.js';
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
