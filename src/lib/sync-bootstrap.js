/**
 * First-boot vs catch-up decision for an org's inbox sync (OPENM-1038).
 *
 * `sync_seq` used to double as the "has this org ever been bootstrapped?"
 * signal: 0 meant first boot. But an org can legitimately sit at sync_seq 0
 * after its first-boot replay — e.g. a freshly joined org whose inbox was empty
 * at first connect, so the replay delivered nothing and never advanced the
 * cursor. The next reconnect then took the first-boot path again: it cleared
 * the inbox ledger's received marks and replayed the whole inbox with dedupe
 * taint clearing, re-delivering every message already handled live.
 *
 * The org session now carries a separate `bootstrapped: true` flag, written
 * once a first-boot (or #148 identity-rebind) replay sweep COMPLETES — even
 * when it delivered 0 messages. A bootstrapped org at sync_seq 0 takes the
 * normal catch-up path (sync from 0, no dedupe reset), so already-delivered
 * messages are suppressed by the message-id deduper.
 *
 * The marker is bound to the member_id it was earned under, and a #148
 * identity rebind drops it before its replay and owes a `rebind_replay_pending`
 * replay until that replay completes (see beginRebindReplay).
 *
 * Upgrade compatibility: legacy sessions have no flag. sync_seq > 0 behaves as
 * before (catch-up); sync_seq 0 without the flag takes the first-boot path once
 * (same as before), after which the flag is set.
 */

/**
 * Bootstrap completion is owned by ONE identity. The marker is stored with the
 * member_id it was earned under (`bootstrapped_member_id`); a marker written
 * under a different identity (e.g. before a #148 identity rebind) does not
 * count, so a new identity never inherits the old one's "already replayed".
 */
export function isBootstrappedFor(session, memberId) {
  if (session?.bootstrapped !== true) return false;
  return (session.bootstrapped_member_id ?? null) === (memberId ?? null);
}

/**
 * Which onOpen path to take.
 *
 *   identity-rebind — #148 mismatch detected, reseed from /sync/status first.
 *   rebind-replay   — a rebind was committed but its replay never completed
 *                     (it halted / failed, or the process restarted mid-way);
 *                     re-run the fromStart replay, never a plain catch-up.
 *   first-boot      — never bootstrapped and no cursor.
 *   catch-up        — everything else.
 *
 * @returns {'identity-rebind' | 'rebind-replay' | 'first-boot' | 'catch-up'}
 */
export function decideOpenPath({ syncSeq, bootstrapped, identityRebindPending, rebindReplayPending }) {
  if (identityRebindPending) return 'identity-rebind';
  if (rebindReplayPending) return 'rebind-replay';
  if (!syncSeq && !bootstrapped) return 'first-boot';
  return 'catch-up';
}

/**
 * Whether a NON-fromStart catch-up sweep may run. Before OPENM-1038 it was a
 * no-op whenever sync_seq was 0 (nothing to catch up before first boot). A
 * bootstrapped org at sync_seq 0 must still be able to catch up / gap-fill
 * from 0, otherwise the inbox ledger's gap-sync can never repair a gap there.
 */
export function canCatchUp({ fromStart, syncSeq, bootstrapped, rebindReplayPending }) {
  if (fromStart) return true;
  // While a #148 rebind replay is owed, a plain (non-fromStart) sweep must
  // never run: it would skip ids still marked in the deduper but never
  // delivered, yet advance sync_seq past them — after which the owed replay
  // would start beyond them and they would be lost (review R2 of #208).
  if (rebindReplayPending) return false;
  return !!syncSeq || !!bootstrapped;
}

/**
 * Single router for every NON-onOpen sync entry point (ledger gap-sync,
 * receipt-watch lost-receipt fallback, and onOpen's catch-up branch). While a
 * rebind replay is owed it runs that replay (fromStart, dedupe-taint clearing,
 * pending cleared only on completion) so gap / receipt compensation still
 * repairs; otherwise the ordinary catch-up.
 */
export function routeSync({ sessionRef, runRebindReplay, runCatchUp }) {
  return sessionRef.rebindReplayPending ? runRebindReplay() : runCatchUp();
}

/**
 * Start a #148 identity-rebind replay. Must run BEFORE the rebind is committed
 * and before its replay: drops the bootstrap marker (memory + disk) — it
 * belonged to the old identity — and records that a rebind replay is owed, so
 * if the replay halts/fails (or the process dies) the next connect re-runs the
 * replay instead of a plain catch-up that would skip what was never delivered.
 */
export function beginRebindReplay({ orgSlug, sessionRef, saveOrgSession }) {
  sessionRef.bootstrapped = false;
  sessionRef.rebindReplayPending = true;
  saveOrgSession(orgSlug, { bootstrapped: false, bootstrapped_member_id: null, rebind_replay_pending: true });
}

/**
 * Persist the bootstrap marker (bound to `memberId`) after a first-boot /
 * identity-rebind replay, but only if the sweep reached the end of the inbox
 * (`result.completed`). Clears a pending rebind replay at the same time. A sweep
 * that halted on a transient error, failed, hit the per-sweep cap, or was
 * skipped because another sweep was in flight changes nothing, so the next
 * connect retries the same replay path.
 *
 * Returns true iff it marked the org bootstrapped.
 */
export function markBootstrappedIfCompleted({ orgSlug, sessionRef, result, memberId, saveOrgSession, log }) {
  if (!result?.completed) return false;
  if (sessionRef.bootstrapped && !sessionRef.rebindReplayPending) return false;
  sessionRef.bootstrapped = true;
  sessionRef.rebindReplayPending = false;
  saveOrgSession(orgSlug, { bootstrapped: true, bootstrapped_member_id: memberId ?? null, rebind_replay_pending: false });
  log?.(`[${orgSlug}] inbox bootstrap complete (sync_seq=${sessionRef.sync_seq || 0}); later connects take the catch-up path`);
  return true;
}

/**
 * Inbound handler's inbox-seq gate. Records `inboxSeq` in the ledger; if the
 * ledger refuses it (already recorded / below the watermark) the frame is NOT
 * dispatched, so the id-level dedupe mark the handler set earlier is released —
 * otherwise a frame blocked by a stale watermark (e.g. the old identity's, while
 * a #148 rebind is in progress) would later be skipped as a "duplicate" even
 * though it was never delivered. Real duplicates stay blocked by the ledger.
 *
 * Returns true iff the frame should be dispatched.
 */
export function recordSeqOrReleaseId({ inboxLedger, dedupe, notifId, inboxSeq }) {
  if (inboxLedger.record(inboxSeq)) return true;
  dedupe.forget?.(notifId);
  return false;
}
