// Outbound DM "seen" watch (workspace-backlog#11): a DM to another agent with
// no target reaction within the timeout prompts the agent exactly once; a
// reaction or a reply from the peer ends the watch silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDmSeenWatcher,
  resolveDmSeenConfig,
  sentMessageId,
  writeSentMarker,
  drainSentMarkers,
  buildUnseenPrompt,
  DEFAULT_TIMEOUT_MS,
  EARLY_EVIDENCE_TTL_MS,
  EARLY_EVIDENCE_MAX,
} from './dm-seen-watch.js';

const SELF = 'self-agent';
const PEER = 'peer-agent';
const AGENT_DM = 'conv-agent-dm';
const HUMAN_DM = 'conv-human-dm';
const MSG = 1789917485214; // numeric, as cws-comm sends it

function reaction(event, { messageId = MSG, code = 'eyes', reactor = PEER } = {}) {
  return {
    event,
    conversation_id: AGENT_DM,
    data: { message_id: messageId, conversation_id: AGENT_DM, reactor_id: reactor, reaction_code: code },
  };
}

function harness({ cfg = {} } = {}) {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const prompts = [];
  const lookups = [];
  const logs = [];
  const watcher = createDmSeenWatcher({
    getConfig: () => resolveDmSeenConfig({ dm_seen_watch: cfg }),
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    resolveTarget: async (entry) => {
      lookups.push(entry.messageId);
      return entry.conversationId === AGENT_DM ? { orgId: entry.orgId || '', peerId: PEER, peerName: 'Peer' } : null;
    },
    onTimeout: (entry, target, waitedMs) => { prompts.push({ entry, target, waitedMs }); },
    log: (s) => logs.push(s),
  });
  for (const org of ['', 'org-a', 'org-b']) watcher.onObservationRestored(org);
  function advance(ms) {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) { timers.delete(id); tm.fn(); }
    }
  }
  const sent = (conversationId = AGENT_DM, messageId = MSG) => watcher.watch({ conversationId, messageId, sentAt: t });
  // The bridge registers a send only when it drains the marker, up to one
  // poll (2s) after the send itself: `sendAt()` then `register()` models that.
  let lastSend = null;
  const sendAt = ({ conversationId = AGENT_DM, messageId = MSG, orgId = '' } = {}) => { lastSend = { conversationId, messageId, orgId, sentAt: t }; };
  const register = () => watcher.watch(lastSend);
  return { watcher, prompts, lookups, logs, timers, advance, sent, sendAt, register, now: () => t };
}

test('agent DM with no reaction → one prompt at the timeout, not before', async () => {
  const h = harness();
  assert.equal(await h.sent(), true);
  h.advance(DEFAULT_TIMEOUT_MS - 1);
  assert.equal(h.prompts.length, 0);
  h.advance(1);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].entry.messageId, String(MSG));
  assert.equal(h.prompts[0].target.peerId, PEER);
  h.advance(DEFAULT_TIMEOUT_MS * 3);
  assert.equal(h.prompts.length, 1, 'fires once');
  assert.equal(h.watcher.pendingCount(), 0);
  assert.ok(h.logs.some((l) => l.includes('timeout')), 'timeout is logged');
});

test('peer eyes reaction in time → watch ends, no prompt', async () => {
  const h = harness();
  await h.sent();
  h.advance(5_000);
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added'), SELF), true);
  h.advance(DEFAULT_TIMEOUT_MS * 2);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(h.logs.some((l) => l.includes('seen msg=')), 'seen is logged');
});

test('a removed eyes (receiver replied / 120s) also proves it was seen', async () => {
  const h = harness();
  await h.sent();
  assert.equal(h.watcher.onReaction(reaction('message.reaction.removed'), SELF), true);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('own reaction, other code, other message, other event → still prompts', async () => {
  const h = harness();
  await h.sent();
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added', { reactor: SELF }), SELF), false);
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added', { code: 'heart' }), SELF), false);
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added', { messageId: 42 }), SELF), false);
  assert.equal(h.watcher.onReaction(reaction('message.updated'), SELF), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 1);
});

test('a message from the peer in the DM ends the watch; one from self does not', async () => {
  const h = harness();
  await h.sent();
  assert.equal(h.watcher.onPeerMessage(AGENT_DM, SELF, SELF), 0);
  assert.equal(h.watcher.onPeerMessage('other-conv', PEER, SELF), 0);
  assert.equal(h.watcher.onPeerMessage(AGENT_DM, PEER, SELF), 1);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('non-agent DM (human peer / group) is not watched and never prompts', async () => {
  const h = harness();
  assert.equal(await h.sent(HUMAN_DM), false);
  assert.equal(h.watcher.pendingCount(), 0);
  h.advance(DEFAULT_TIMEOUT_MS * 2);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.logs.length, 0, 'nothing logged for an unwatched send');
});

test('reaction that lands while the conversation lookup is in flight still counts', async () => {
  const h = harness();
  const p = h.sent();
  h.watcher.onReaction(reaction('message.reaction.added'), SELF);
  assert.equal(await p, false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('timeout and reaction codes are configurable; "*" accepts any reaction', async () => {
  const h = harness({ cfg: { timeout_seconds: 30, reaction_codes: ['thumbs_up'] } });
  await h.sent();
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added'), SELF), false, 'eyes no longer the target');
  h.advance(30_000);
  assert.equal(h.prompts.length, 1);

  const any = harness({ cfg: { reaction_codes: ['*'] } });
  await any.sent();
  assert.equal(any.watcher.onReaction(reaction('message.reaction.added', { code: 'heart' }), SELF), true);
});

test('disabled → nothing watched', async () => {
  const h = harness({ cfg: { enabled: false } });
  assert.equal(await h.sent(), false);
  assert.equal(h.lookups.length, 0);
});

test('resolveDmSeenConfig defaults and bad values', () => {
  assert.deepEqual(resolveDmSeenConfig(undefined), { enabled: true, timeoutMs: DEFAULT_TIMEOUT_MS, reactionCodes: ['eyes'] });
  assert.deepEqual(
    resolveDmSeenConfig({ dm_seen_watch: { timeout_seconds: -5, reaction_codes: [] } }),
    { enabled: true, timeoutMs: DEFAULT_TIMEOUT_MS, reactionCodes: ['eyes'] },
  );
});

test('sentMessageId picks the last chunk, then id / message_id', () => {
  assert.equal(sentMessageId({ ok: true, message_ids: ['1', null, '3'] }), '3');
  assert.equal(sentMessageId({ id: 7 }), '7');
  assert.equal(sentMessageId({ ok: true, card: true, message_id: '9' }), '9');
  assert.equal(sentMessageId({ ok: true, skipped: true }), '');
});

test('markers round-trip through the directory and are consumed once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-seen-'));
  try {
    assert.equal(writeSentMarker(dir, { conversationId: AGENT_DM, messageId: MSG, orgId: 'org-1', sentAt: 5 }), true);
    assert.equal(writeSentMarker(dir, { conversationId: AGENT_DM, messageId: '' }), false);
    assert.equal(writeSentMarker(dir, { conversationId: AGENT_DM, messageId: 'no-time' }), false, 'sentAt is required');
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{not json');
    assert.deepEqual(drainSentMarkers(dir), [{ conversationId: AGENT_DM, messageId: String(MSG), orgId: 'org-1', sentAt: 5 }]);
    assert.deepEqual(drainSentMarkers(dir), []);
    assert.deepEqual(fs.readdirSync(dir), [], 'garbage marker removed too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt names the peer, ids and tells the agent to report to its owner', () => {
  const s = buildUnseenPrompt({ peerName: 'Peer', peerId: PEER, conversationId: AGENT_DM, messageId: '1', waitedMs: 600_000, reactionCodes: ['eyes'] });
  assert.match(s, /Peer \(agent, member_id=peer-agent\)/);
  assert.match(s, /10 min/);
  assert.match(s, /conversation_id=conv-agent-dm, message_id=1/);
  assert.match(s, /owner/);
});

// --- R2: evidence that lands before the marker is drained (PR #202 review) ---

test('eyes before the watch registers (100ms vs 1.9s poll) still settles it, at a 60s timeout', async () => {
  const h = harness({ cfg: { timeout_seconds: 60 } });
  h.sendAt();
  h.advance(100);
  assert.equal(h.watcher.onReaction(reaction('message.reaction.added'), SELF), false, 'nothing to settle yet');
  h.advance(1_800);
  assert.equal(await h.register(), false, 'settled from the remembered reaction');
  assert.equal(h.lookups.length, 0, 'no lookup needed');
  h.advance(120_000);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.watcher.pendingCount(), 0);
  assert.ok(h.logs.length === 0 || h.logs.every((l) => !l.includes('timeout')));
});

test('eyes added and removed (fast reply) both before the watch → no prompt', async () => {
  const h = harness();
  h.sendAt();
  h.advance(100);
  h.watcher.onReaction(reaction('message.reaction.added'), SELF);
  h.advance(500);
  h.watcher.onReaction(reaction('message.reaction.removed'), SELF);
  h.advance(1_000);
  assert.equal(await h.register(), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('peer reply before the watch settles it; a peer message from before the send does not', async () => {
  const h = harness();
  h.sendAt();
  h.advance(300);
  h.watcher.onPeerMessage(AGENT_DM, PEER, SELF);
  h.advance(1_500);
  assert.equal(await h.register(), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);

  const old = harness();
  old.watcher.onPeerMessage(AGENT_DM, PEER, SELF);
  old.advance(1_000);
  old.sendAt({ messageId: 77 });
  old.advance(1_900);
  assert.equal(await old.register(), true, 'an earlier peer message is not evidence for this send');
  old.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(old.prompts.length, 1);
});

test('early evidence that does not qualify is not remembered: own, other code, other message', async () => {
  const h = harness();
  h.sendAt();
  h.advance(100);
  h.watcher.onReaction(reaction('message.reaction.added', { reactor: SELF }), SELF);
  h.watcher.onReaction(reaction('message.reaction.added', { code: 'heart' }), SELF);
  h.watcher.onReaction(reaction('message.reaction.added', { messageId: 42 }), SELF);
  h.watcher.onPeerMessage(AGENT_DM, SELF, SELF);
  h.advance(1_800);
  assert.equal(await h.register(), true);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 1);
});

test('remembered reactions expire and are capped', async () => {
  const h = harness();
  h.watcher.onReaction(reaction('message.reaction.added'), SELF);
  h.advance(EARLY_EVIDENCE_TTL_MS + 1);
  h.sendAt();
  assert.equal(await h.register(), true, 'stale evidence ignored');

  const c = harness();
  c.watcher.onReaction(reaction('message.reaction.added', { messageId: 1 }), SELF);
  for (let i = 0; i < EARLY_EVIDENCE_MAX; i++) {
    c.watcher.onReaction(reaction('message.reaction.added', { messageId: 1000 + i }), SELF);
  }
  c.sendAt({ messageId: 1 });
  assert.equal(await c.register(), true, 'oldest entry evicted past the cap');
  c.sendAt({ messageId: 1000 + EARLY_EVIDENCE_MAX - 1 });
  assert.equal(await c.register(), false, 'newest entry kept');
});

// --- R2: WebSocket drop (reactions are not replayed on reconnect) ---

test('a drop spanning both reaction frames: the watch is dropped silently, no prompt', async () => {
  const h = harness();
  h.sendAt();
  h.advance(1_900);
  assert.equal(await h.register(), true);
  assert.equal(h.watcher.onObservationLost(''), 1);
  h.advance(30_000); // eyes added and removed while down: never delivered
  h.watcher.onObservationRestored('');
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(h.logs.some((l) => l.includes('connection lost')));
});

test('sent while down or before the reconnect → not watched; sent after it → watched', async () => {
  const h = harness();
  h.watcher.onObservationLost('');
  h.sendAt({ messageId: 1 });
  h.advance(1_000);
  assert.equal(await h.register(), false, 'sent during the gap');
  h.sendAt({ messageId: 2 });
  h.advance(500);
  h.watcher.onObservationRestored('');
  h.advance(1_000);
  assert.equal(await h.register(), false, 'sent before the socket came back, drained after');
  h.sendAt({ messageId: 3 });
  h.advance(1_900);
  assert.equal(await h.register(), true, 'sent after the reconnect');
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].entry.messageId, '3');
});

test('an org whose socket has not opened yet is not watched', async () => {
  const h = harness();
  h.sendAt({ orgId: 'org-never-opened' });
  assert.equal(await h.register(), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('a drop in one org leaves another org\'s watch alone', async () => {
  const h = harness();
  h.sendAt({ messageId: 1, orgId: 'org-a' });
  assert.equal(await h.register(), true);
  assert.equal(h.watcher.onObservationLost('org-b'), 0);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 1);
});

// --- R3: sent_at is the time BEFORE the request; the response may be slow ---

test('response returns after a reconnect: a send stamped before the gap is not watched', async () => {
  const h = harness();
  h.sendAt(); // request starts
  h.advance(100);
  h.watcher.onObservationLost(''); // peer's eyes lands while we are down
  h.advance(2_000);
  h.watcher.onObservationRestored('');
  h.advance(500); // only now does the HTTP response come back
  h.advance(1_900); // marker drained
  assert.equal(await h.register(), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('peer reply before the response returns still settles the watch', async () => {
  const h = harness();
  h.sendAt();
  h.advance(200);
  h.watcher.onPeerMessage(AGENT_DM, PEER, SELF);
  h.advance(800); // response
  h.advance(1_900);
  assert.equal(await h.register(), false);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 0);
});

test('control: a slow response with no reaction or reply still prompts', async () => {
  const h = harness();
  h.sendAt();
  h.advance(1_000); // response
  h.advance(1_900);
  assert.equal(await h.register(), true);
  h.advance(DEFAULT_TIMEOUT_MS);
  assert.equal(h.prompts.length, 1);
});
