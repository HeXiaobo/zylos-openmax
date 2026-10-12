/**
 * scripts/send.js side of the activity feature: attach metadata.agent_run to
 * a reply.
 *
 * Reads runs/active.json and the run files the comm-bridge process writes; no
 * run file (feature off, nothing registered) means no metadata — the reply is
 * sent exactly as before. Never throws into the send path and never logs:
 * outcomes are counted in runs/send-stats.json.
 *
 * Claim protocol (runs/<run_id>.reply, created with 'wx'):
 *   - the first reply of a run creates the claim {state:'pending', client_msg_id K,
 *     body_sha256} and carries the full agent_run;
 *   - POST 2xx → state 'delivered'; a later reply of the run carries the
 *     reference form {v, run_id};
 *   - a certain rejection (400 / 413 / 422, or 401 / 403 / 404 after auth
 *     retries) → claim released;
 *   - anything uncertain (timeout, 5xx, lost response) → claim kept 'pending':
 *     a retry with the same first-chunk body reuses K (cws-comm de-dupes on
 *     (org_id, client_msg_id) with no time limit) and the full summary; a
 *     retry with a different body uses a new key and only the reference.
 */

import crypto from 'crypto';
import { createRunStore } from './run-store.js';
import { buildAgentRun, agentRunRef } from './compact.js';

const CERTAIN_REJECT = new Set([400, 401, 403, 404, 413, 422]);

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Classify a POST error: 'rejected' (certainly not stored) or 'uncertain'. */
export function classifySendError(err) {
  const status = Number(err?.status);
  return CERTAIN_REJECT.has(status) ? 'rejected' : 'uncertain';
}

function liveRuns(store, active, convId) {
  const ids = active?.by_conversation?.[convId];
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => store.readRun(id))
    .filter((r) => r && r.state !== 'closed' && r.state !== 'created')
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * Pick the run a reply to `convId` belongs to.
 * @returns {{ run: object|null, skipped?: string }}
 */
export function selectRun({ store, active, convId }) {
  const runs = liveRuns(store, active, convId).filter((r) => active?.gate?.[r.org_id] === 'open');
  if (runs.length === 0) return { run: null };
  const focus = runs.find((r) => r.focus === true);
  if (focus) return { run: focus };
  const unclaimed = runs.filter((r) => !store.claimExists(r.run_id));
  const earliest = unclaimed[0];
  if (earliest) {
    // Group guard: an unregistered (smart, not @) input arrived after the
    // earliest unanswered run — this reply may well answer that one instead.
    const unreg = active?.unregistered?.[convId];
    if (unreg && unreg > earliest.created_at) return { run: null, skipped: 'agent_run_skipped_unregistered' };
    return { run: earliest };
  }
  return { run: runs[runs.length - 1] };
}

/**
 * Plan the metadata for one reply.
 *
 * @param {{ convId: string, kind: 'text'|'media', bodyHash: string|(() => string), newKey: () => string,
 *           now?: number, store?: object }} args
 * @returns {null | { runId, firstMetadata, laterMetadata, clientMsgId, settle(outcome) }}
 *   settle('ok' | 'rejected' | 'uncertain') is called once after the first POST.
 */
export function planReplyMetadata({ convId, kind, bodyHash, newKey, now = Date.now(), store = createRunStore() }) {
  try {
    const active = store.readActive();
    if (!active || !convId) return null;
    const { run, skipped } = selectRun({ store, active, convId });
    if (skipped) store.bumpSendStat(skipped);
    if (!run) return null;

    const ref = { agent_run: agentRunRef(run.run_id) };
    if (typeof bodyHash === 'function') bodyHash = bodyHash();
    const K = newKey();
    const claim = { v: 2, state: 'pending', client_msg_id: K, body_sha256: bodyHash, attempts: 1, claimed_at: now, pid: process.pid, kind };

    let owned = false;
    let full = null;
    let clientMsgId = null;
    if (store.createClaim(run.run_id, claim)) {
      owned = true;
      clientMsgId = K;
      const ar = buildAgentRun(run, { now });
      if (ar) {
        full = { agent_run: ar };
        store.bumpSendStat('agent_run_attached');
      } else {
        store.bumpSendStat('agent_run_skipped_oversize');
      }
    } else {
      const prev = store.readClaim(run.run_id);
      if (prev?.state === 'pending' && prev.body_sha256 === bodyHash && typeof prev.client_msg_id === 'string') {
        // Same body retried after an uncertain outcome: same key, full summary.
        owned = true;
        clientMsgId = prev.client_msg_id;
        store.updateClaim(run.run_id, { ...prev, attempts: (prev.attempts || 1) + 1 });
        const ar = buildAgentRun(run, { now });
        full = ar ? { agent_run: ar } : null;
        store.bumpSendStat(ar ? 'agent_run_attached' : 'agent_run_skipped_oversize');
      } else {
        if (prev?.state === 'pending') store.bumpSendStat('agent_run_ambiguous_ref');
        else store.bumpSendStat('agent_run_ref');
      }
    }

    return {
      runId: run.run_id,
      // Owning the claim but over budget: this reply goes out without agent_run.
      firstMetadata: full || (owned ? null : ref),
      laterMetadata: ref,
      clientMsgId,
      settle(outcome) {
        if (!owned) return;
        try {
          if (outcome === 'ok') {
            const cur = store.readClaim(run.run_id) || claim;
            store.updateClaim(run.run_id, { ...cur, state: 'delivered', delivered_at: Date.now(), kind });
          } else if (outcome === 'rejected') {
            store.releaseClaim(run.run_id);
          }
        } catch {}
      },
    };
  } catch {
    try { store.bumpSendStat('agent_run_error'); } catch {}
    return null;
  }
}

/** [CARD] replies cannot carry metadata: only note the reply form for stats. */
export function noteCardReply({ convId, store = createRunStore() }) {
  try {
    const active = store.readActive();
    if (!active) return;
    const { run } = selectRun({ store, active, convId });
    if (run) store.writeFormCard(run.run_id);
  } catch {}
}
