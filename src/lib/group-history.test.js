import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point RUNTIME_DIR (session.js: path.join(process.env.HOME, 'zylos/components/openmax/runtime'))
// at a throwaway HOME so the group transcripts these tests write never touch a
// real component data dir. Must be set before importing the module under test.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-grouphist-'));
process.env.HOME = tmpHome;
const LOGS_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime/group-logs');
const { logAndRecord, getHistory, ensureReplay, setLimits } = await import('./group-history.js');

setLimits(5, 15);

let _conv = 0;
/** A fresh conversation id per test, so in-memory history never bleeds across tests. */
function newConv() {
  return `conv-${++_conv}`;
}

function entry(messageId, text, extra = {}) {
  return {
    timestamp: '2026-08-07T10:20:32.693Z',
    message_id: messageId,
    sender_id: 'member-1',
    sender_name: 'gaivn08081',
    text,
    seq: 1,
    parent_id: null,
    type: 'agent_text',
    ...extra,
  };
}

function seedLogFile(conversationId, entries) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LOGS_DIR, `${conversationId}.log`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// message_id JSON type drift
//
// comm-bridge.js builds the entry with `message_id: msg.id` unnormalized (the
// `seq` on the very next line IS coerced with Number()). cws-comm emits that id
// as a JSON number on some delivery paths and a string on others, so one log
// file routinely holds both shapes — verified in the wild: a single group log
// held 13 numeric and 10 string ids.
// ---------------------------------------------------------------------------

test('dedup treats the numeric and string forms of one id as the same message', () => {
  const conv = newConv();
  logAndRecord(conv, entry(1786027449978, 'first delivery'));
  logAndRecord(conv, entry('1786027449978', 'redelivery, id arrived as a string'));

  const history = getHistory(conv);
  assert.equal(history.length, 1, 'the redelivery must not be recorded a second time');
  assert.equal(history[0].text, 'first delivery', 'the original entry is the one kept');
});

test('dedup still fires when the first delivery is the string form', () => {
  const conv = newConv();
  logAndRecord(conv, entry('1786027449978', 'first delivery'));
  logAndRecord(conv, entry(1786027449978, 'redelivery, id arrived as a number'));

  assert.equal(getHistory(conv).length, 1, 'normalization must work in both directions');
});

test('genuinely different ids are both kept (dedup is not over-eager)', () => {
  const conv = newConv();
  logAndRecord(conv, entry(1786027449978, 'first'));
  logAndRecord(conv, entry(1786027449979, 'second'));
  logAndRecord(conv, entry('1786027449980', 'third'));

  assert.equal(getHistory(conv).length, 3);
});

test('numeric-string ids that differ only past Number precision stay distinct', () => {
  // String(id) comparison must not collapse two ids that are distinct as
  // strings. (Had normalization gone the other way — Number(id) — these two
  // would both become 9007199254740992 and silently dedup into one.)
  const conv = newConv();
  logAndRecord(conv, entry('9007199254740993', 'first'));
  logAndRecord(conv, entry('9007199254740992', 'second'));

  assert.equal(getHistory(conv).length, 2, 'string comparison keeps large ids distinct');
});

// ---------------------------------------------------------------------------
// getHistory's exclude filter
//
// comm-bridge.js calls getHistory(conv, msg.id) to build the context handed to
// the model, where msg.id excludes the message currently being handled. If the
// stored entry's id has the other JSON type, the exclusion silently misses and
// the current message shows up inside its own context — the model reads it as
// though the user said the same thing twice.
// ---------------------------------------------------------------------------

test('exclude drops the current message when the stored id is the other type', () => {
  const conv = newConv();
  logAndRecord(conv, entry(1786027449978, 'earlier message'));
  logAndRecord(conv, entry(1786027449979, 'the message being handled'));

  // The inbound frame carries the id as a string this time.
  const context = getHistory(conv, '1786027449979');
  assert.equal(context.length, 1, 'the current message must be excluded from its own context');
  assert.equal(context[0].text, 'earlier message');
});

test('exclude drops the current message when the inbound id is numeric', () => {
  const conv = newConv();
  logAndRecord(conv, entry('1786027449978', 'earlier message'));
  logAndRecord(conv, entry('1786027449979', 'the message being handled'));

  const context = getHistory(conv, 1786027449979);
  assert.equal(context.length, 1);
  assert.equal(context[0].text, 'earlier message');
});

test('exclude keeps every entry when nothing matches', () => {
  const conv = newConv();
  logAndRecord(conv, entry(1, 'a'));
  logAndRecord(conv, entry(2, 'b'));

  assert.equal(getHistory(conv, 999).length, 2);
});

// ---------------------------------------------------------------------------
// Replay from disk — the real cross-restart scenario, and the reason
// normalization happens at comparison time instead of on write.
// ---------------------------------------------------------------------------

test('a message replayed from disk as a number dedups against a string redelivery', () => {
  // This is the scenario that makes on-write normalization insufficient:
  // the log line already on disk was persisted with a numeric id (before any
  // fix), ensureReplay JSON.parses it back as a number, and the message is then
  // re-delivered — e.g. via the sync-replay path — carrying a string id.
  const conv = newConv();
  seedLogFile(conv, [entry(1786027449978, 'persisted before the fix')]);

  ensureReplay(conv);
  assert.equal(getHistory(conv).length, 1, 'replay loaded the persisted entry');

  logAndRecord(conv, entry('1786027449978', 'redelivered after restart'));
  const history = getHistory(conv);
  assert.equal(history.length, 1, 'the redelivery dedups against the replayed entry');
  assert.equal(history[0].text, 'persisted before the fix', 'no migration of old logs needed');
});

test('replay dedups a log file that already holds both shapes of one id', () => {
  const conv = newConv();
  seedLogFile(conv, [
    entry(1786027449978, 'numeric shape'),
    entry('1786027449978', 'string shape'),
    entry(1786027449979, 'a genuinely different message'),
  ]);

  ensureReplay(conv);
  const history = getHistory(conv);
  assert.equal(history.length, 2, 'the duplicated id collapses, the distinct one survives');
  assert.deepEqual(history.map(m => m.text), ['numeric shape', 'a genuinely different message']);
});

// ---------------------------------------------------------------------------
// Absent ids
// ---------------------------------------------------------------------------

test('entries with no message_id are never collapsed into each other', () => {
  const conv = newConv();
  logAndRecord(conv, entry(undefined, 'first idless'));
  logAndRecord(conv, entry(undefined, 'second idless'));

  assert.equal(getHistory(conv).length, 2, 'a missing id must not read as "same message"');
});

test('a null exclude id filters nothing out', () => {
  const conv = newConv();
  logAndRecord(conv, entry(1, 'a'));
  logAndRecord(conv, entry(undefined, 'b'));

  // Falsy excludeMessageId skips the filter entirely; the idless entry must
  // survive rather than matching a null-vs-undefined comparison.
  assert.equal(getHistory(conv, null).length, 2);
});

// ---------------------------------------------------------------------------
// sub-conversations
// ---------------------------------------------------------------------------

test('a DM sub-conversation is recorded under its own id, separate from its parent', () => {
  const parent = newConv();
  const sub = newConv();
  logAndRecord(sub, entry('11', 'in the sub-conversation'));
  assert.equal(getHistory(parent), null);
  assert.equal(getHistory(sub).length, 1);
  assert.ok(fs.existsSync(path.join(LOGS_DIR, `${sub}.log`)));
  assert.equal(fs.existsSync(path.join(LOGS_DIR, `${parent}.log`)), false);
});
