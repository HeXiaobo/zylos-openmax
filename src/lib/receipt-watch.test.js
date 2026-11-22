// Lost-receipt fallback (RECEIPT-DELAY-RCA F1): a `card.interaction.recorded`
// event for a card this agent sent, with no matching interaction receipt
// within the grace period, triggers the /sync catch-up exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptWatcher, RECEIPT_GRACE_MS } from './receipt-watch.js';

const OWN_CARD = 1789917485214;      // numeric, as cws-comm sends it
const OTHER_CARD = 1789917485999;
const CONV = '01a119ea-eedf-71f7-9e01-7320a21b806d';

function recorded(messageId, extra = {}) {
  return {
    event: 'card.interaction.recorded',
    conversation_id: CONV,
    data: { message_id: messageId, conversation_id: CONV, status: 'succeeded', ...extra },
  };
}

// Manual clock + timer queue so tests are deterministic and instant.
function harness({ own = [String(OWN_CARD)], graceMs } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  const synced = [];
  const ownChecks = [];
  const watcher = createReceiptWatcher({
    graceMs,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    isOwnCard: async (card) => { ownChecks.push(card.messageId); return own.includes(card.messageId); },
    onMissing: (card) => { synced.push(card); },
  });
  async function advance(ms) {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) { timers.delete(id); tm.fn(); }
    }
    // let the async ownership check settle
    await new Promise((r) => setImmediate(r));
  }
  return { watcher, synced, ownChecks, advance, timers };
}

test('recorded event for own card with no receipt → sync triggered once the grace period expires', async () => {
  const h = harness();
  assert.equal(h.watcher.onRecorded(recorded(OWN_CARD)), true);
  await h.advance(RECEIPT_GRACE_MS - 1);
  assert.equal(h.synced.length, 0, 'not before the grace period');
  await h.advance(1);
  assert.equal(h.synced.length, 1, 'sync within the grace period');
  assert.deepEqual(h.synced[0], { messageId: String(OWN_CARD), conversationId: CONV });
  assert.equal(h.watcher.pendingCount(), 0);
});

test('receipt arrives in time → no sync and no ownership lookup', async () => {
  const h = harness();
  h.watcher.onRecorded(recorded(OWN_CARD));
  await h.advance(500);
  h.watcher.onReceipt(String(OWN_CARD));
  await h.advance(RECEIPT_GRACE_MS * 2);
  assert.equal(h.synced.length, 0);
  assert.equal(h.ownChecks.length, 0, 'on-time receipt costs no request');
});

test('receipt that arrived BEFORE the recorded event still suppresses the sync', async () => {
  const h = harness();
  h.watcher.onReceipt(String(OWN_CARD));
  assert.equal(h.watcher.onRecorded(recorded(OWN_CARD)), false);
  await h.advance(RECEIPT_GRACE_MS * 2);
  assert.equal(h.synced.length, 0);
});

test('recorded event for another agent\'s card → ignored (no sync)', async () => {
  const h = harness();
  h.watcher.onRecorded(recorded(OTHER_CARD));
  await h.advance(RECEIPT_GRACE_MS);
  assert.deepEqual(h.ownChecks, [String(OTHER_CARD)]);
  assert.equal(h.synced.length, 0);
});

test('ownership check that throws → treated as not ours (no sync)', async () => {
  let t = 0;
  const synced = [];
  let fire;
  const w = createReceiptWatcher({
    now: () => t,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    isOwnCard: async () => { throw new Error('boom'); },
    onMissing: (c) => synced.push(c),
  });
  w.onRecorded(recorded(OWN_CARD));
  fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(synced.length, 0);
});

test('duplicate recorded events for the same card → sync fires at most once', async () => {
  const h = harness();
  h.watcher.onRecorded(recorded(OWN_CARD));
  assert.equal(h.watcher.onRecorded(recorded(OWN_CARD)), false, 'second one while pending is not re-armed');
  await h.advance(RECEIPT_GRACE_MS);
  assert.equal(h.synced.length, 1);
  // A replayed recorded event after the sync must not fire another one.
  h.watcher.onRecorded(recorded(OWN_CARD));
  await h.advance(RECEIPT_GRACE_MS);
  assert.equal(h.synced.length, 1);
});

test('receipt landing during the ownership check → no sync', async () => {
  let fire;
  let resolveOwn;
  const synced = [];
  const w = createReceiptWatcher({
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    isOwnCard: () => new Promise((r) => { resolveOwn = r; }),
    onMissing: (c) => synced.push(c),
  });
  w.onRecorded(recorded(OWN_CARD));
  fire();
  w.onReceipt(String(OWN_CARD));
  resolveOwn(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(synced.length, 0);
});

test('non-succeeded interaction or missing message_id → nothing armed', () => {
  const h = harness();
  assert.equal(h.watcher.onRecorded(recorded(OWN_CARD, { status: 'failed' })), false);
  assert.equal(h.watcher.onRecorded({ event: 'card.interaction.recorded', data: {} }), false);
  assert.equal(h.timers.size, 0);
});

test('real timers: an unref\'d timer still fires onMissing after the grace period', async () => {
  const synced = [];
  const w = createReceiptWatcher({
    graceMs: 30,
    isOwnCard: async () => true,
    onMissing: (c) => synced.push(c),
  });
  w.onRecorded(recorded(OWN_CARD));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(synced.length, 1);
  w.stop();
});
