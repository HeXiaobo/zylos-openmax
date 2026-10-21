import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// OPENM-1038: an org at sync_seq 0 after a completed first-boot replay (empty
// inbox at first connect) must NOT be treated as a first boot again on
// reconnect. Drives the real helpers against the real session + ledger stores
// in a throwaway HOME.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-bootstrap-'));
process.env.HOME = tmpHome;

const { loadOrgSession, saveOrgSession } = await import('./session.js');
const { createInboxLedger } = await import('./inbox-ledger.js');
const { decideOpenPath, canCatchUp, markBootstrappedIfCompleted } = await import('./sync-bootstrap.js');

const noop = () => {};

// ---------------------------------------------------------------------------
// decideOpenPath
// ---------------------------------------------------------------------------

test('decideOpenPath: fresh agent (seq 0, no flag) → first-boot', () => {
  assert.equal(decideOpenPath({ syncSeq: 0, bootstrapped: false, identityRebindPending: false }), 'first-boot');
  assert.equal(decideOpenPath({ syncSeq: undefined, bootstrapped: undefined }), 'first-boot');
});

test('decideOpenPath: bootstrapped at seq 0 → catch-up', () => {
  assert.equal(decideOpenPath({ syncSeq: 0, bootstrapped: true, identityRebindPending: false }), 'catch-up');
});

test('decideOpenPath: legacy session (no flag) with seq > 0 → catch-up (unchanged)', () => {
  assert.equal(decideOpenPath({ syncSeq: 42, bootstrapped: undefined, identityRebindPending: false }), 'catch-up');
  assert.equal(decideOpenPath({ syncSeq: 42, bootstrapped: true, identityRebindPending: false }), 'catch-up');
});

test('decideOpenPath: identity rebind pending wins regardless of seq / flag', () => {
  for (const syncSeq of [0, 42]) {
    for (const bootstrapped of [false, true]) {
      assert.equal(decideOpenPath({ syncSeq, bootstrapped, identityRebindPending: true }), 'identity-rebind');
    }
  }
});

// ---------------------------------------------------------------------------
// canCatchUp (syncMissedEvents early-return gate)
// ---------------------------------------------------------------------------

test('canCatchUp: non-fromStart at seq 0 before bootstrap is a no-op (unchanged)', () => {
  assert.equal(canCatchUp({ fromStart: false, syncSeq: 0, bootstrapped: false }), false);
});

test('canCatchUp: bootstrapped + seq 0 gap-sync runs', () => {
  assert.equal(canCatchUp({ fromStart: false, syncSeq: 0, bootstrapped: true }), true);
});

test('canCatchUp: seq > 0 or fromStart always runs (unchanged)', () => {
  assert.equal(canCatchUp({ fromStart: false, syncSeq: 7, bootstrapped: false }), true);
  assert.equal(canCatchUp({ fromStart: true, syncSeq: 0, bootstrapped: false }), true);
});

// ---------------------------------------------------------------------------
// markBootstrappedIfCompleted
// ---------------------------------------------------------------------------

test('markBootstrappedIfCompleted: completed sweep (0 delivered) persists the flag', () => {
  const slug = 'org-mark-ok';
  const sessionRef = { sync_seq: 0, bootstrapped: false };
  assert.equal(markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: { completed: true }, saveOrgSession }), true);
  assert.equal(sessionRef.bootstrapped, true);
  assert.equal(loadOrgSession(slug).bootstrapped, true);
});

test('markBootstrappedIfCompleted: halted / failed / skipped sweep leaves the flag unset', () => {
  for (const [i, result] of [{ completed: false }, undefined, null].entries()) {
    const slug = `org-mark-halt-${i}`;
    const sessionRef = { sync_seq: 0, bootstrapped: false };
    assert.equal(markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result, saveOrgSession }), false);
    assert.equal(sessionRef.bootstrapped, false);
    assert.equal(loadOrgSession(slug), null);
  }
});

test('markBootstrappedIfCompleted: preserves the existing sync_seq in the session file', () => {
  const slug = 'org-mark-merge';
  saveOrgSession(slug, { sync_seq: 9 });
  markBootstrappedIfCompleted({ orgSlug: slug, sessionRef: { sync_seq: 9 }, result: { completed: true }, saveOrgSession });
  const s = loadOrgSession(slug);
  assert.equal(s.sync_seq, 9);
  assert.equal(s.bootstrapped, true);
});

// ---------------------------------------------------------------------------
// Lifecycle: mirror startOrgWs + onOpen branch selection with a fake sweep
// ---------------------------------------------------------------------------

// Mirrors comm-bridge: build sessionRef from the persisted session, pick the
// onOpen path, run the (fake) sweep, mark bootstrapped on the first-boot path.
async function openOnce(slug, { sweep, ledger, identityRebindPending = false }) {
  const session = loadOrgSession(slug) || {};
  const sessionRef = { sync_seq: session.sync_seq ?? session.last_seq ?? 0, bootstrapped: session.bootstrapped === true };
  const calls = { resetReceived: 0, sweeps: [] };
  const path_ = decideOpenPath({ syncSeq: sessionRef.sync_seq, bootstrapped: sessionRef.bootstrapped, identityRebindPending });
  if (path_ === 'first-boot') {
    calls.resetReceived += 1;
    ledger?.resetReceived();
    const r = await sweep(sessionRef, { fromStart: true });
    calls.sweeps.push('fromStart');
    markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: r, saveOrgSession });
  } else if (path_ === 'catch-up') {
    if (canCatchUp({ fromStart: false, syncSeq: sessionRef.sync_seq, bootstrapped: sessionRef.bootstrapped })) {
      await sweep(sessionRef, { fromStart: false });
      calls.sweeps.push('catch-up');
    }
  }
  return { path: path_, calls, sessionRef };
}

test('lifecycle: fresh agent with welcome in inbox → first-boot replay delivers it, then catch-up', async () => {
  const slug = 'org-fresh-welcome';
  const delivered = [];
  // Inbox holds the owner welcome (seq 1) + activation DM (seq 2).
  const sweep = async (ref, { fromStart }) => {
    const start = ref.sync_seq || 0;
    for (const seq of [1, 2]) if (seq > start) delivered.push({ seq, fromStart });
    if (start < 2) { ref.sync_seq = 2; saveOrgSession(slug, { sync_seq: 2 }); }
    return { completed: true };
  };
  const first = await openOnce(slug, { sweep });
  assert.equal(first.path, 'first-boot');
  assert.deepEqual(delivered.map((d) => d.seq), [1, 2]);
  assert.equal(loadOrgSession(slug).bootstrapped, true);

  const second = await openOnce(slug, { sweep });
  assert.equal(second.path, 'catch-up');
  assert.equal(second.calls.resetReceived, 0);
  assert.equal(delivered.length, 2, 'nothing re-delivered');
});

test('lifecycle: empty-inbox first connect, then reconnect → catch-up from 0 without resetReceived', async () => {
  const slug = 'org-new-empty';
  const ledger = createInboxLedger(slug, { log: noop, warn: noop });
  let resets = 0;
  const realReset = ledger.resetReceived;
  ledger.resetReceived = () => { resets += 1; realReset(); };

  const emptySweep = async () => ({ completed: true });   // 0 events, sync_seq stays 0
  const first = await openOnce(slug, { sweep: emptySweep, ledger });
  assert.equal(first.path, 'first-boot');
  assert.equal(resets, 1);
  assert.equal(loadOrgSession(slug).bootstrapped, true);
  assert.ok(!loadOrgSession(slug).sync_seq, 'sync_seq still 0');

  // Online: messages arrive live but out of order (gap at seq 1) — ledger stays at 0.
  ledger.record(2);
  ledger.record(3);
  assert.equal(ledger.getAckedSeq(), 0);

  const sweeps = [];
  const second = await openOnce(slug, {
    ledger,
    sweep: async (ref, opts) => { sweeps.push({ from: ref.sync_seq || 0, ...opts }); return { completed: true }; },
  });
  assert.equal(second.path, 'catch-up');
  assert.equal(resets, 1, 'resetReceived NOT called on reconnect');
  assert.deepEqual(sweeps, [{ from: 0, fromStart: false }]);
  // Received marks survive, so live-delivered seqs are still deduped by the ledger.
  assert.equal(ledger.record(2), false);
  assert.equal(ledger.record(3), false);
  ledger.stop();
});

test('lifecycle: first-boot sweep that halts leaves the org un-bootstrapped → first-boot retried', async () => {
  const slug = 'org-halted';
  const first = await openOnce(slug, { sweep: async () => ({ completed: false }) });
  assert.equal(first.path, 'first-boot');
  assert.ok(!loadOrgSession(slug)?.bootstrapped);
  const second = await openOnce(slug, { sweep: async () => ({ completed: true }) });
  assert.equal(second.path, 'first-boot', 'retries the first-boot replay, as before');
  assert.equal(loadOrgSession(slug).bootstrapped, true);
});

test('lifecycle: legacy session (no flag) with sync_seq > 0 → catch-up, flag not required', async () => {
  const slug = 'org-legacy-warm';
  saveOrgSession(slug, { sync_seq: 120 });
  const r = await openOnce(slug, { sweep: async () => ({ completed: true }) });
  assert.equal(r.path, 'catch-up');
  assert.equal(r.calls.resetReceived, 0);
});

test('lifecycle: legacy session (no flag) at sync_seq 0 → first-boot once, then catch-up', async () => {
  const slug = 'org-legacy-zero';
  saveOrgSession(slug, { sync_seq: 0 });
  const sweep = async () => ({ completed: true });
  assert.equal((await openOnce(slug, { sweep })).path, 'first-boot');
  assert.equal((await openOnce(slug, { sweep })).path, 'catch-up');
});

test('lifecycle: identity rebind pending takes the rebind path even when bootstrapped', async () => {
  const slug = 'org-rebind';
  saveOrgSession(slug, { sync_seq: 0, bootstrapped: true });
  const r = await openOnce(slug, { sweep: async () => ({ completed: true }), identityRebindPending: true });
  assert.equal(r.path, 'identity-rebind');
  assert.equal(r.calls.sweeps.length, 0, 'normal branches not run');
});

test('cleanup', () => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
