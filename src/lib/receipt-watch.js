/**
 * Lost-receipt fallback: a card click whose interaction receipt never arrived.
 *
 * Why this exists
 * ---------------
 * When someone answers a card, cws-comm emits two things to the agent:
 *
 *   1. `card.interaction.recorded` — a thin `system` frame on the card's own
 *      conversation ("the card flipped"). No answer semantics.
 *   2. The INTERACTION_RECEIPT message, posted into the `interaction_center`
 *      system DM. This is the agent's only wake-up signal for the answer.
 *
 * cws-comm's realtime fan-out can drop (2): on the first receipt per agent the
 * interaction_center DM is created inside the settlement transaction, the
 * agent's per-connection subscription lands a few ms after the receipt is
 * stored, and the gateway fallback then skips the connection as "already
 * subscribed" (RCA: onb-p2-int-e2e RECEIPT-DELAY-RCA.md, F1). The receipt IS
 * in the agent's inbox — only the realtime frame is lost — but nothing in the
 * bridge notices a missing TAIL seq until a later message exposes the gap. In
 * the observed run that took 4m49s.
 *
 * (1) did arrive on the same socket. So: on `card.interaction.recorded`, wait a
 * short grace period for the matching receipt; if it has not shown up, run the
 * existing /sync catch-up ONCE. The receipt is then pulled from the inbox and
 * dispatched through the normal handler, whose id-dedupe + inbox-ledger make a
 * receipt that arrives both live and via sync be handled exactly once.
 *
 * "Is this a card THIS agent sent?" is answered lazily, only when the grace
 * period expires without a receipt — the common case (receipt on time) costs
 * no request at all. A recorded event for someone else's card is then dropped.
 *
 * Pure apart from injected effects (timers, ownership check, sync trigger), so
 * it is unit-testable without importing the self-executing comm-bridge.
 */

export const CARD_RECORDED_EVENT = 'card.interaction.recorded';
export const RECEIPT_GRACE_MS = 3_000;
// How long a receipt we've seen is remembered, so a recorded event that
// arrives AFTER its receipt (frame ordering is not guaranteed) is not mistaken
// for a lost one. Also bounds the fired-once memory.
export const RECEIPT_SEEN_TTL_MS = 5 * 60_000;

function idOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.length > 0 ? v : '';
}

/**
 * @param {object} opts
 * @param {(card: {messageId: string, conversationId: string}) => Promise<boolean>} opts.isOwnCard
 *   Whether this agent sent the card. Only called once the grace period has
 *   expired without a receipt. A throw counts as "not ours" (no sync).
 * @param {(card: {messageId: string, conversationId: string}) => void} opts.onMissing
 *   Trigger the /sync catch-up. Called at most once per card.
 * @param {number} [opts.graceMs]
 * @param {number} [opts.seenTtlMs]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.setTimer]   setTimeout stand-in (tests)
 * @param {Function} [opts.clearTimer] clearTimeout stand-in (tests)
 * @param {Function} [opts.log]
 * @param {Function} [opts.warn]
 */
export function createReceiptWatcher({
  isOwnCard,
  onMissing,
  graceMs = RECEIPT_GRACE_MS,
  seenTtlMs = RECEIPT_SEEN_TTL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
  warn = () => {},
} = {}) {
  // cardMessageId -> timer handle, while waiting for its receipt.
  const pending = new Map();
  // cardMessageId -> ts, for receipts already seen and cards already synced for.
  const settled = new Map();

  function prune() {
    const cutoff = now() - seenTtlMs;
    for (const [id, ts] of settled) {
      if (ts < cutoff) settled.delete(id);
    }
  }

  async function expire(card) {
    pending.delete(card.messageId);
    if (settled.has(card.messageId)) return;
    let own = false;
    try {
      own = await isOwnCard(card);
    } catch (e) {
      warn(`receipt-watch: ownership check for card=${card.messageId} failed: ${e?.message || e} — not syncing`);
    }
    // The receipt may have landed while the ownership check was in flight.
    if (settled.has(card.messageId)) return;
    if (!own) return;
    settled.set(card.messageId, now());
    log(`receipt-watch: no interaction receipt for own card=${card.messageId} conv=${card.conversationId} within ${graceMs}ms — running /sync to recover it`);
    try {
      onMissing(card);
    } catch (e) {
      warn(`receipt-watch: sync trigger for card=${card.messageId} failed: ${e?.message || e}`);
    }
  }

  return {
    /**
     * Feed a `card.interaction.recorded` system-frame payload
     * ({ event, conversation_id, data: { message_id, status, ... } }).
     * Returns true when a wait was armed.
     */
    onRecorded(payload) {
      const data = payload?.data || {};
      const messageId = idOf(data.message_id);
      const conversationId = idOf(payload?.conversation_id) || idOf(data.conversation_id);
      if (!messageId) return false;
      // A failed/rejected interaction produces no receipt; nothing to wait for.
      if (data.status && String(data.status).toLowerCase() !== 'succeeded') return false;
      prune();
      if (settled.has(messageId) || pending.has(messageId)) return false;
      const card = { messageId, conversationId };
      const timer = setTimer(() => { expire(card); }, graceMs);
      timer?.unref?.();
      pending.set(messageId, timer);
      return true;
    },

    /** Note an interaction receipt answering `cardMessageId` (live or via sync). */
    onReceipt(cardMessageId) {
      const id = idOf(cardMessageId);
      if (!id) return;
      prune();
      settled.set(id, now());
      const timer = pending.get(id);
      if (timer !== undefined) {
        clearTimer(timer);
        pending.delete(id);
      }
    },

    /** Cancel every armed wait (shutdown / tests). */
    stop() {
      for (const t of pending.values()) clearTimer(t);
      pending.clear();
    },

    pendingCount() { return pending.size; },
  };
}
