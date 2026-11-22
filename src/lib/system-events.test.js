// Log-hygiene for high-frequency benign no-op system events (task #44 / PR #135).
//
// comm-bridge's `system`-frame dispatch calls logSystemFrame() exactly once per
// frame (passing classifySystemEvent as `classify`), and handleSystemEvent no
// longer logs the unhandled case — so an unknown event produces exactly ONE
// line, not the two it used to (trace + unhandled). logSystemFrame is the real
// function wired into src/comm-bridge.js, so testing it here covers the live
// dispatch log behavior without importing the self-executing comm-bridge daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBenignNoopSystemEvent, logSystemFrame } from './system-events.js';

const BENIGN = [
  'message.reaction.added',
  'message.reaction.removed',
  'message.read',
  'message.delivered',
  'message.mention.created',
  'message.created',
];

// Stand-in for comm-bridge's classifySystemEvent: truthy = known/actionable.
const fakeClassify = (ev) => {
  const e = String(ev || '').toLowerCase();
  if (e === 'message.recalled' || e === 'message.deleted') return 'recall';
  if (e === 'message.updated') return 'edit';
  return null;
};

function spy() {
  const logs = [];
  return { log: (...a) => logs.push(a.join(' ')), logs };
}

test('isBenignNoopSystemEvent: all known no-ops match (case-insensitive)', () => {
  for (const name of BENIGN) {
    assert.equal(isBenignNoopSystemEvent(name), true, name);
    assert.equal(isBenignNoopSystemEvent(name.toUpperCase()), true, `${name} upper`);
  }
});

test('isBenignNoopSystemEvent: unknown / actionable events do not match', () => {
  for (const name of ['message.recalled', 'message.updated', 'message.somethingnew',
    'connection.authorized', 'agent.config.updated', '', undefined, null]) {
    assert.equal(isBenignNoopSystemEvent(name), false, String(name));
  }
});

test('logSystemFrame (a): a benign no-op frame produces ZERO lines', () => {
  const { log, logs } = spy();
  const frame = { type: 'system', payload: { event: 'message.reaction.added', conversation_id: 'c-1' } };
  assert.equal(logSystemFrame(log, 'org-a', frame, fakeClassify), false);
  assert.equal(logs.length, 0);
});

test('logSystemFrame (b): a known/actionable event logs EXACTLY one trace line', () => {
  const { log, logs } = spy();
  const frame = { type: 'system', payload: { event: 'message.recalled', conversation_id: 'c-7' } };
  assert.equal(logSystemFrame(log, 'org-a', frame, fakeClassify), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[org-a\] system event=message\.recalled conv=c-7$/);
});

test('logSystemFrame (c): an unknown event logs EXACTLY one "unhandled" line (no double-log)', () => {
  const { log, logs } = spy();
  const frame = { type: 'system', payload: { event: 'message.somethingnew', conversation_id: 'c-9' } };
  assert.equal(logSystemFrame(log, 'org-a', frame, fakeClassify), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[org-a\] unhandled system event: message\.somethingnew conv=c-9$/);
});

test('logSystemFrame: missing event / conv fall back to the original placeholder strings', () => {
  // Unknown-with-missing-fields uses (unknown)/? ; a classified-but-blank uses <unknown>/<unknown>.
  const u = spy();
  logSystemFrame(u.log, 'org-a', { payload: {} }, fakeClassify);
  assert.equal(u.logs.length, 1);
  assert.match(u.logs[0], /unhandled system event: \(unknown\) conv=\?$/);

  const k = spy();
  // classify returns truthy for '' here to exercise the trace-line placeholders.
  logSystemFrame(k.log, 'org-a', { payload: {} }, () => 'edit');
  assert.equal(k.logs.length, 1);
  assert.match(k.logs[0], /system event=<unknown> conv=<unknown>$/);
});
