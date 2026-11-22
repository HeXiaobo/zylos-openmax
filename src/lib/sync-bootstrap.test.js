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
const { createDeduper } = await import('./ws.js');
const { commitIdentityRebind } = await import('./inbox-rebind.js');
const {
  decideOpenPath, canCatchUp, isBootstrappedFor, beginRebindReplay,
  markBootstrappedIfCompleted, recordSeqOrReleaseId, routeSync,
} = await import('./sync-bootstrap.js');
const RUNTIME_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime');

const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('decideOpenPath: owed rebind replay beats first-boot / catch-up, loses to a pending rebind', () => {
  for (const syncSeq of [0, 42]) {
    for (const bootstrapped of [false, true]) {
      assert.equal(decideOpenPath({ syncSeq, bootstrapped, rebindReplayPending: true }), 'rebind-replay');
    }
  }
  assert.equal(decideOpenPath({ syncSeq: 0, identityRebindPending: true, rebindReplayPending: true }), 'identity-rebind');
});

test('isBootstrappedFor: the marker only counts for the identity that earned it', () => {
  assert.equal(isBootstrappedFor({ bootstrapped: true, bootstrapped_member_id: 'B' }, 'B'), true);
  assert.equal(isBootstrappedFor({ bootstrapped: true, bootstrapped_member_id: 'A' }, 'B'), false);
  assert.equal(isBootstrappedFor({ bootstrapped: true }, 'B'), false);
  assert.equal(isBootstrappedFor({ bootstrapped: true }, undefined), true);   // no member_id either side
  assert.equal(isBootstrappedFor({ bootstrapped: false, bootstrapped_member_id: 'B' }, 'B'), false);
  assert.equal(isBootstrappedFor(null, 'B'), false);
});

test('beginRebindReplay: clears the marker in memory and on disk, records the owed replay', () => {
  const slug = 'org-begin-rebind';
  saveOrgSession(slug, { sync_seq: 100, bootstrapped: true, bootstrapped_member_id: 'A' });
  const sessionRef = { sync_seq: 100, bootstrapped: true, rebindReplayPending: false };
  beginRebindReplay({ orgSlug: slug, sessionRef, saveOrgSession });
  assert.equal(sessionRef.bootstrapped, false);
  assert.equal(sessionRef.rebindReplayPending, true);
  const s = loadOrgSession(slug);
  assert.equal(s.bootstrapped, false);
  assert.equal(s.bootstrapped_member_id, null);
  assert.equal(s.rebind_replay_pending, true);
  assert.equal(s.sync_seq, 100);
});

test('recordSeqOrReleaseId: a frame blocked by the ledger releases its dedupe mark', () => {
  const slug = 'org-gate';
  const ledger = createInboxLedger(slug, { log: noop, warn: noop });
  ledger.setAckedSeq(10);
  const dedupe = createDeduper({});
  assert.equal(dedupe('m-old'), false);   // handler marks the id first
  assert.equal(recordSeqOrReleaseId({ inboxLedger: ledger, dedupe, notifId: 'm-old', inboxSeq: 5 }), false);
  assert.equal(dedupe('m-old'), false, 'blocked id is not left marked as seen');
  assert.equal(dedupe('m-new'), false);
  assert.equal(recordSeqOrReleaseId({ inboxLedger: ledger, dedupe, notifId: 'm-new', inboxSeq: 11 }), true);
  assert.equal(dedupe('m-new'), true, 'dispatched id stays deduped');
  ledger.stop();
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
  assert.equal(markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: { completed: true }, memberId: 'B', saveOrgSession }), true);
  assert.equal(sessionRef.bootstrapped, true);
  assert.equal(loadOrgSession(slug).bootstrapped, true);
  assert.equal(loadOrgSession(slug).bootstrapped_member_id, 'B');
  assert.equal(loadOrgSession(slug).rebind_replay_pending, false);
});

test('markBootstrappedIfCompleted: an owed rebind replay is cleared only by a completed sweep', () => {
  const slug = 'org-mark-rebind';
  const sessionRef = { sync_seq: 0, bootstrapped: false, rebindReplayPending: true };
  assert.equal(markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: { completed: false }, memberId: 'B', saveOrgSession }), false);
  assert.equal(sessionRef.rebindReplayPending, true);
  assert.equal(markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: { completed: true }, memberId: 'B', saveOrgSession }), true);
  assert.equal(sessionRef.rebindReplayPending, false);
  assert.equal(loadOrgSession(slug).rebind_replay_pending, false);
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
async function openOnce(slug, { sweep, ledger, identityRebindPending = false, memberId = 'self' }) {
  const session = loadOrgSession(slug) || {};
  const sessionRef = { sync_seq: session.sync_seq ?? session.last_seq ?? 0, bootstrapped: isBootstrappedFor(session, memberId) };
  const calls = { resetReceived: 0, sweeps: [] };
  const path_ = decideOpenPath({ syncSeq: sessionRef.sync_seq, bootstrapped: sessionRef.bootstrapped, identityRebindPending });
  if (path_ === 'first-boot') {
    calls.resetReceived += 1;
    ledger?.resetReceived();
    const r = await sweep(sessionRef, { fromStart: true });
    calls.sweeps.push('fromStart');
    markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: r, memberId, saveOrgSession });
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
  saveOrgSession(slug, { sync_seq: 0, bootstrapped: true, bootstrapped_member_id: 'self' });
  const r = await openOnce(slug, { sweep: async () => ({ completed: true }), identityRebindPending: true });
  assert.equal(r.path, 'identity-rebind');
  assert.equal(r.calls.sweeps.length, 0, 'normal branches not run');
});

// ---------------------------------------------------------------------------
// Review of #208 (P2): identity rebind must not inherit the old identity's
// bootstrap marker, and a failed rebind replay must be retried — not replaced
// by a catch-up that skips a never-delivered message.
// ---------------------------------------------------------------------------

// Chain harness: the real ledger, deduper, session store, commitIdentityRebind
// and sync-bootstrap helpers, wired the way comm-bridge's startOrgWs / onOpen /
// handler / syncMissedEvents wire them. The server inbox of the NEW identity
// holds one message (seq 1).
function makeBridge(slug, memberId, { inbox, dedupPath }) {
  const ledger = createInboxLedger(slug, { log: noop, warn: noop, memberId });
  const session = loadOrgSession(slug) || {};
  const sessionRef = {
    sync_seq: session.sync_seq ?? 0,
    bootstrapped: isBootstrappedFor(session, memberId),
    rebindReplayPending: session.rebind_replay_pending === true,
  };
  let identityRebindPending = !!ledger.getIdentityChange();
  if (sessionRef.sync_seq > 0) ledger.setAckedSeq(sessionRef.sync_seq);
  const dedupe = createDeduper({ persistPath: dedupPath });
  const delivered = [];

  // handleIncomingMessage: dedupe (with _firstBoot forget) → ledger gate → dispatch.
  async function handle(frame) {
    if (frame._firstBoot) dedupe.forget(frame.id);
    if (dedupe(frame.id)) return;
    if (!recordSeqOrReleaseId({ inboxLedger: ledger, dedupe, notifId: frame.id, inboxSeq: frame.seq })) return;
    delivered.push(frame.id);
  }

  // syncMissedEvents: `fail` simulates a transient /sync failure (caught → incomplete).
  async function sweep({ fromStart, fail = false }) {
    if (!canCatchUp({
      fromStart, syncSeq: sessionRef.sync_seq, bootstrapped: sessionRef.bootstrapped,
      rebindReplayPending: sessionRef.rebindReplayPending,
    })) return { completed: false };
    if (fail) return { completed: false };
    const start = sessionRef.sync_seq || 0;
    let since = start;
    for (const ev of inbox.filter((e) => e.seq > start)) {
      await handle({ id: ev.message_id, seq: ev.seq, _via: 'sync', ...(fromStart ? { _firstBoot: true } : {}) });
      since = ev.seq;
    }
    if (since > start) { sessionRef.sync_seq = since; saveOrgSession(slug, { sync_seq: since }); }
    return { completed: true };
  }

  async function runRebindReplay(opts) {
    const result = await sweep({ fromStart: true, ...opts });
    if (sessionRef.sync_seq) ledger.setAckedSeq(sessionRef.sync_seq);
    markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result, memberId, saveOrgSession });
  }

  // runSync: the router every non-replay entry point uses (ledger onGapSync,
  // receipt-watch onMissing, onOpen catch-up).
  function runSync(opts = {}) {
    return routeSync({
      sessionRef,
      runRebindReplay: () => runRebindReplay(opts),
      runCatchUp: () => sweep({ fromStart: false, ...opts }),
    });
  }
  const compensation = {
    'ledger gap-sync': (opts) => runSync(opts),           // onGapSync
    'receipt-watch onMissing': (opts) => runSync(opts),   // onMissing
  };

  // onOpen. `duringStatus` runs while GET /sync/status is awaited.
  async function open({ anchor = 0, duringStatus, replayFails = false } = {}) {
    if (identityRebindPending) {
      if (duringStatus) await duringStatus();
      beginRebindReplay({ orgSlug: slug, sessionRef, saveOrgSession });
      commitIdentityRebind({ orgSlug: slug, sessionRef, inboxLedger: ledger, memberId, anchor, saveOrgSession });
      identityRebindPending = false;
      await runRebindReplay({ fail: replayFails });
      return 'identity-rebind';
    }
    const p = decideOpenPath({
      syncSeq: sessionRef.sync_seq, bootstrapped: sessionRef.bootstrapped,
      identityRebindPending, rebindReplayPending: sessionRef.rebindReplayPending,
    });
    if (p === 'rebind-replay') await runRebindReplay({ fail: replayFails });
    else if (p === 'first-boot') {
      ledger.resetReceived();
      const r = await sweep({ fromStart: true, fail: replayFails });
      if (sessionRef.sync_seq) ledger.setAckedSeq(sessionRef.sync_seq);
      markBootstrappedIfCompleted({ orgSlug: slug, sessionRef, result: r, memberId, saveOrgSession });
    } else await runSync({ fail: replayFails });
    return p;
  }

  return { ledger, sessionRef, dedupe, delivered, handle, open, sweep, compensation, stop: () => ledger.stop() };
}

// Old identity A: bootstrapped, ledger + session at seq 100.
function seedOldIdentity(slug) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, `inbox-${slug}.json`),
    JSON.stringify({ member_id: 'A', acked_seq: 100, received: [], fetch_failures: {} }));
  saveOrgSession(slug, { sync_seq: 100, bootstrapped: true, bootstrapped_member_id: 'A' });
}

const inbox = [{ seq: 1, message_id: 'm1' }];
const liveFrame = { id: 'm1', seq: 1 };   // realtime frame carrying inbox_seq=1

test('review #208: rebind → live frame during status await → replay fails → reconnect retries the rebind replay and delivers seq 1', async () => {
  const slug = 'org-chain-reconnect';
  seedOldIdentity(slug);
  const b = makeBridge(slug, 'B', { inbox, dedupPath: path.join(RUNTIME_DIR, `dedup-${slug}.json`) });
  assert.equal(b.sessionRef.bootstrapped, false, 'old identity marker not inherited');

  // Connect #1: the live frame lands while /sync/status is awaited — blocked by
  // the OLD watermark (100) — then the rebind replay's /sync fails.
  assert.equal(await b.open({ anchor: 0, duringStatus: () => b.handle(liveFrame), replayFails: true }), 'identity-rebind');
  assert.deepEqual(b.delivered, []);
  assert.equal(b.sessionRef.sync_seq, 0, 'sync_seq not advanced past the undelivered message');
  const s1 = loadOrgSession(slug);
  assert.equal(s1.bootstrapped, false);
  assert.equal(s1.rebind_replay_pending, true);

  // Connect #2 (reconnect, same process): must retry the rebind replay, not catch-up.
  assert.equal(await b.open(), 'rebind-replay');
  assert.deepEqual(b.delivered, ['m1']);
  assert.equal(b.sessionRef.sync_seq, 1);
  const s2 = loadOrgSession(slug);
  assert.equal(s2.bootstrapped, true);
  assert.equal(s2.bootstrapped_member_id, 'B');
  assert.equal(s2.rebind_replay_pending, false);

  // Connect #3: now an ordinary catch-up; nothing re-delivered.
  assert.equal(await b.open(), 'catch-up');
  assert.deepEqual(b.delivered, ['m1']);
  b.stop();
});

test('review #208: same chain across a process restart → restart retries the rebind replay and delivers seq 1', async () => {
  const slug = 'org-chain-restart';
  const dedupPath = path.join(RUNTIME_DIR, `dedup-${slug}.json`);
  seedOldIdentity(slug);
  const b1 = makeBridge(slug, 'B', { inbox, dedupPath });
  await b1.open({ anchor: 0, duringStatus: () => b1.handle(liveFrame), replayFails: true });
  assert.deepEqual(b1.delivered, []);
  b1.stop();
  await sleep(1200);   // let the deduper's debounced flush land on disk

  // Restart: the ledger already carries B (rebind committed), so no identity
  // change is detected — the persisted owed replay drives the retry.
  const b2 = makeBridge(slug, 'B', { inbox, dedupPath });
  assert.equal(b2.sessionRef.rebindReplayPending, true);
  assert.equal(await b2.open(), 'rebind-replay');
  assert.deepEqual(b2.delivered, ['m1']);
  assert.equal(b2.sessionRef.sync_seq, 1);
  assert.equal(loadOrgSession(slug).bootstrapped_member_id, 'B');
  b2.stop();
});

test('review #208: a catch-up sweep never skips a frame the ledger blocked earlier', async () => {
  // Even on the plain catch-up path, the released dedupe mark lets the frame
  // through once the ledger accepts its seq (here: after a rebind reset).
  const slug = 'org-chain-catchup';
  seedOldIdentity(slug);
  const b = makeBridge(slug, 'B', { inbox, dedupPath: path.join(RUNTIME_DIR, `dedup-${slug}.json`) });
  await b.handle(liveFrame);                 // blocked by old watermark 100
  assert.deepEqual(b.delivered, []);
  b.ledger.rebindIdentity('B', 0);           // ledger now accepts seq 1
  await b.handle({ ...liveFrame, _via: 'sync' });   // non-firstBoot re-pull
  assert.deepEqual(b.delivered, ['m1']);
  b.stop();
});

// ---------------------------------------------------------------------------
// Review R2 of #208: in-connection compensation syncs must not overtake an
// owed rebind replay.
// ---------------------------------------------------------------------------

const inbox2 = [
  { seq: 11, message_id: 'm11' },
  { seq: 12, message_id: 'm12' },
  { seq: 13, message_id: 'm13' },
];

for (const entry of ['ledger gap-sync', 'receipt-watch onMissing']) {
  test(`review R2: ${entry} while a rebind replay is owed runs the replay and delivers retained m11 exactly once`, async () => {
    const slug = `org-r2-${entry.split(' ')[0]}`;
    const dedupPath = path.join(RUNTIME_DIR, `dedup-${slug}.json`);
    seedOldIdentity(slug);
    // m11 is retained in the persisted deduper but was never delivered
    // (prepare-phase / reloaded-deduper case).
    fs.writeFileSync(dedupPath, JSON.stringify({ m11: Date.now() }));
    const b = makeBridge(slug, 'B', { inbox: inbox2, dedupPath });

    // Rebind to non-zero anchor 10; the first replay fails.
    await b.open({ anchor: 10, replayFails: true });
    assert.equal(b.sessionRef.sync_seq, 10);
    assert.equal(b.sessionRef.rebindReplayPending, true);

    // m12, m13 arrive live and are delivered; m11 never arrives live.
    await b.handle({ id: 'm12', seq: 12 });
    await b.handle({ id: 'm13', seq: 13 });
    assert.deepEqual(b.delivered, ['m12', 'm13']);

    // A plain sweep is refused outright while the replay is owed.
    assert.deepEqual(await b.sweep({ fromStart: false }), { completed: false });
    assert.equal(b.sessionRef.sync_seq, 10, 'plain sync did not advance past undelivered m11');

    // Compensation that fails again: nothing advances, still owed.
    await b.compensation[entry]({ fail: true });
    assert.equal(b.sessionRef.sync_seq, 10);
    assert.equal(loadOrgSession(slug).rebind_replay_pending, true);

    // Compensation that succeeds: routed to the rebind replay.
    await b.compensation[entry]();
    assert.equal(b.delivered.filter((id) => id === 'm11').length, 1, 'm11 delivered exactly once');
    assert.equal(b.delivered.filter((id) => id === 'm12').length, 1);
    assert.equal(b.delivered.filter((id) => id === 'm13').length, 1, 'm13 delivered exactly once');
    assert.equal(b.sessionRef.sync_seq, 13);
    const s = loadOrgSession(slug);
    assert.equal(s.rebind_replay_pending, false, 'pending cleared only after the successful replay');
    assert.equal(s.bootstrapped_member_id, 'B');

    // Later compensation / reconnect are plain catch-ups; nothing re-delivered.
    await b.compensation[entry]();
    assert.equal(await b.open(), 'catch-up');
    assert.equal(b.delivered.length, 3);
    b.stop();
  });
}

test('review R2: incomplete first boot (sync_seq 0) — compensation does not advance the cursor', async () => {
  const slug = 'org-r2-firstboot';
  const b = makeBridge(slug, 'B', { inbox: [{ seq: 1, message_id: 'w1' }], dedupPath: path.join(RUNTIME_DIR, `dedup-${slug}.json`) });
  assert.equal(await b.open({ replayFails: true }), 'first-boot');
  assert.equal(b.sessionRef.bootstrapped, false);
  for (const entry of Object.keys(b.compensation)) await b.compensation[entry]();
  assert.deepEqual(b.delivered, []);
  assert.equal(b.sessionRef.sync_seq, 0, 'early return still applies before bootstrap');
  assert.equal(await b.open(), 'first-boot');
  assert.deepEqual(b.delivered, ['w1']);
  b.stop();
});

test('canCatchUp: a plain sweep is refused while a rebind replay is owed; fromStart still runs', () => {
  assert.equal(canCatchUp({ fromStart: false, syncSeq: 10, bootstrapped: true, rebindReplayPending: true }), false);
  assert.equal(canCatchUp({ fromStart: true, syncSeq: 10, rebindReplayPending: true }), true);
});

test('cleanup', () => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
