/**
 * scripts/send.js side of the activity feature: attach `agent_run` (schema v3,
 * a top-level field of the send body) to a reply.
 *
 * Reads runs/active.json and the run files the comm-bridge process writes; no
 * run file (feature off, nothing registered) means no metadata — the reply is
 * sent exactly as before. Never throws into the send path and never logs:
 * outcomes are counted in runs/send-stats.json.
 *
 * Used by scripts/send.js (text / media / [CARD]) and by the comm CLI
 * (comm.send / comm.send_card / comm.ask_card) — see attachRunMetadata,
 * attachRunToCardRequest and postWithRunMetadata below.
 *
 * Claim protocol (runs/<run_id>.reply, created with 'wx'):
 *   - the first reply of a run creates the claim {state:'pending', client_msg_id K,
 *     body_sha256} and carries the full agent_run;
 *   - POST 2xx → state 'delivered'; a later reply of the run carries the
 *     reference form {schema_version: 3, run_id, ref: true};
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
 * Plan the agent_run of one reply.
 *
 * @param {{ convId: string, kind: 'text'|'media'|'card', bodyHash: string|(() => string), newKey: () => string,
 *           now?: number, store?: object }} args
 * @returns {null | { runId, firstAgentRun, laterAgentRun, clientMsgId, settle(outcome) }}
 *   firstAgentRun / laterAgentRun: the `agent_run` value for the first / a
 *   later message (null = none). settle('ok' | 'rejected' | 'uncertain') is
 *   called once after the first POST.
 */
export function planReplyMetadata({ convId, kind, bodyHash, newKey, now = Date.now(), store = createRunStore() }) {
  try {
    const active = store.readActive();
    if (!active || !convId) return null;
    const { run, skipped } = selectRun({ store, active, convId });
    if (skipped) store.bumpSendStat(skipped);
    if (!run) return null;

    const ref = agentRunRef(run.run_id);
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
        full = ar;
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
        full = ar || null;
        store.bumpSendStat(ar ? 'agent_run_attached' : 'agent_run_skipped_oversize');
      } else {
        if (prev?.state === 'pending') store.bumpSendStat('agent_run_ambiguous_ref');
        else store.bumpSendStat('agent_run_ref');
      }
    }

    return {
      runId: run.run_id,
      // Owning the claim but over budget: this reply goes out without agent_run.
      firstAgentRun: full || (owned ? null : ref),
      laterAgentRun: ref,
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

/**
 * Only note that a run was answered with a card (reply-form stats), without a
 * claim. Cards now carry agent_run via attachRunToCardRequest; this stays for
 * a card whose agent_run the server refused (see postWithRunMetadata).
 */
export function noteCardReply({ convId, store = createRunStore() }) {
  try {
    const active = store.readActive();
    if (!active) return;
    const { run } = selectRun({ store, active, convId });
    if (run) store.writeFormCard(run.run_id);
  } catch {}
}

/** JSON with object keys sorted at every depth (a stable body hash). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Attach `agent_run` (top-level) to an outbound request body that already
 * carries a client_msg_id (comm.send message body, interaction-request body).
 *
 * The claim key is the body's own client_msg_id, so the claim and the request
 * always name the same message:
 *   - a caller-supplied id (clientMsgIdSupplied) wins: the body keeps it, and a
 *     reused pending claim is re-keyed to it (the caller resends with the same
 *     id after a lost response; cws-comm de-dupes on it);
 *   - a generated id is replaced by the key of a still-pending claim for the
 *     same body (same retry semantics as scripts/send.js).
 * An agent_run already on the body is dropped first: the caller never supplies
 * it (any other field, `metadata` included, is the caller's). Never throws.
 *
 * @returns the plan (see planReplyMetadata) or null — call settle via
 *   postWithRunMetadata.
 */
export function attachRunMetadata({ convId, kind, body, bodyHash, clientMsgIdSupplied = false, now = Date.now(), store = createRunStore() }) {
  try {
    if (!body || typeof body !== 'object') return null;
    delete body.agent_run;
    const own = body.client_msg_id;
    if (typeof own !== 'string' || !own) return null;
    const plan = planReplyMetadata({ convId, kind, bodyHash, newKey: () => own, now, store });
    if (!plan) return null;
    if (plan.clientMsgId && plan.clientMsgId !== own) {
      if (clientMsgIdSupplied) {
        const cur = store.readClaim(plan.runId);
        if (cur) store.updateClaim(plan.runId, { ...cur, client_msg_id: own });
      } else {
        body.client_msg_id = plan.clientMsgId;
      }
    }
    if (plan.firstAgentRun) body.agent_run = plan.firstAgentRun;
    return plan;
  } catch {
    try { store.bumpSendStat('agent_run_error'); } catch {}
    return null;
  }
}

/**
 * Retry hash of a request body: canonical JSON of the WHOLE semantic body —
 * type, content (text, attachments …), parent_id, mentions, metadata, card
 * fields — without client_msg_id and agent_run. Two sends reuse a pending claim's key
 * only when this matches, so a different parent / mention / attachment never
 * borrows the first send's client_msg_id (cws-comm would answer it with the
 * stored message and the new one would be lost).
 *
 * `attachmentDigests[i]`, when given, stands in for attachments[i].artifact_id:
 * scripts/send.js uploads a file again on every attempt (a new artifact id each
 * time), so the file's content digest is what identifies the attachment.
 */
export function semanticBodyHash(body, { attachmentDigests } = {}) {
  const { client_msg_id: _k, agent_run: _a, ...rest } = body || {};
  if (Array.isArray(attachmentDigests) && Array.isArray(rest.content?.attachments)) {
    rest.content = {
      ...rest.content,
      attachments: rest.content.attachments.map((a, i) => (attachmentDigests[i] == null ? a
        : { ...a, artifact_id: undefined, file_sha256: attachmentDigests[i] })),
    };
  }
  return sha256(canonicalJson(rest));
}

/** Retry hash of an interaction-request (see semanticBodyHash). */
export function cardBodyHash(request) {
  return semanticBodyHash(request);
}

/**
 * Attach `agent_run` to a choice card (POST …/interaction-requests).
 * Onboarding cards (choice.kind 'onboarding.*') are not replies to a run and
 * get nothing.
 */
export function attachRunToCardRequest({ convId, request, clientMsgIdSupplied = false, now = Date.now(), store = createRunStore() }) {
  try {
    const cardKind = request?.choice?.kind;
    if (typeof cardKind === 'string' && cardKind.startsWith('onboarding.')) {
      if (request) delete request.agent_run;
      return null;
    }
    return attachRunMetadata({ convId, kind: 'card', body: request, bodyHash: () => cardBodyHash(request), clientMsgIdSupplied, now, store });
  } catch {
    return null;
  }
}

/**
 * POST a body that may carry agent_run, then settle the plan.
 *
 * Compatibility: a cws-core whose schema for this route does not know
 * `agent_run` answers 422. Then the same body (same client_msg_id) is sent once
 * more without it — the user's message never fails because of the
 * summary. If that retry is accepted the claim is released (the summary did not
 * reach the server, so a later reply of the run may carry it) and, for a card,
 * the run's reply form is noted; the collector still sees the send in the log.
 */
export async function postWithRunMetadata(postFn, apiPath, body, plan, { store = createRunStore() } = {}) {
  let res;
  try {
    res = await postFn(apiPath, body);
  } catch (err) {
    if (!(body && body.agent_run && Number(err?.status) === 422)) {
      plan?.settle(classifySendError(err));
      throw err;
    }
    const { agent_run: _drop, ...bare } = body;
    try {
      res = await postFn(apiPath, bare);
    } catch (err2) {
      plan?.settle(classifySendError(err2));
      throw err2;
    }
    plan?.settle('rejected');
    try {
      store.bumpSendStat('agent_run_unsupported');
      if (plan?.runId && body.interaction_type) store.writeFormCard(plan.runId);
    } catch {}
    return res;
  }
  plan?.settle('ok');
  return res;
}
