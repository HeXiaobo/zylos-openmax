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
 * Upgrade compatibility: legacy sessions have no flag. sync_seq > 0 behaves as
 * before (catch-up); sync_seq 0 without the flag takes the first-boot path once
 * (same as before), after which the flag is set.
 */

/**
 * Which onOpen path to take.
 * @returns {'identity-rebind' | 'first-boot' | 'catch-up'}
 */
export function decideOpenPath({ syncSeq, bootstrapped, identityRebindPending }) {
  if (identityRebindPending) return 'identity-rebind';
  if (!syncSeq && !bootstrapped) return 'first-boot';
  return 'catch-up';
}

/**
 * Whether a NON-fromStart catch-up sweep may run. Before OPENM-1038 it was a
 * no-op whenever sync_seq was 0 (nothing to catch up before first boot). A
 * bootstrapped org at sync_seq 0 must still be able to catch up / gap-fill
 * from 0, otherwise the inbox ledger's gap-sync can never repair a gap there.
 */
export function canCatchUp({ fromStart, syncSeq, bootstrapped }) {
  return !!fromStart || !!syncSeq || !!bootstrapped;
}

/**
 * Persist the bootstrapped flag after a first-boot / identity-rebind replay,
 * but only if the sweep reached the end of the inbox (`result.completed`). A
 * sweep that halted on a transient error, failed, hit the per-sweep cap, or was
 * skipped because another sweep was in flight leaves the flag unset, so the
 * next connect retries the first-boot path exactly as before.
 *
 * Returns true iff it marked the org bootstrapped.
 */
export function markBootstrappedIfCompleted({ orgSlug, sessionRef, result, saveOrgSession, log }) {
  if (!result?.completed) return false;
  if (sessionRef.bootstrapped) return false;
  sessionRef.bootstrapped = true;
  saveOrgSession(orgSlug, { bootstrapped: true });
  log?.(`[${orgSlug}] inbox bootstrap complete (sync_seq=${sessionRef.sync_seq || 0}); later connects take the catch-up path`);
  return true;
}
