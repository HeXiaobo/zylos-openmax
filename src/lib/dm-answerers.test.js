/**
 * `answerers` in a DM: there is one person to answer, so the @ and the
 * notification they add are noise. askForm (shared by `[CARD]` and comm.ask)
 * drops them before the send when the conversation is a DM and says so in a
 * `note`; askedOf still takes its default from them and is kept. A group, or
 * a DM card without answerers, is sent as before.
 * src/cli/comm.dm-answerers.test.js runs the same through the CLI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { CARD_PREFIX, CONVERSATION_TYPE_TIMEOUT_MS, DM_ANSWERERS_NOTE, parseCardMessage, sendCardMessage } from './card-message.js';

// Every lookup and POST here is a stub; a real fetch fails the cell.
const realFetch = globalThis.fetch;
let unplannedFetches = [];
beforeEach(() => {
  unplannedFetches = [];
  globalThis.fetch = async (url) => { unplannedFetches.push(String(url)); throw new Error(`unplanned network I/O: ${url}`); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(unplannedFetches, [], 'a unit cell reached the network');
});

function tmpFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-answerers-')), 'pending.json');
  test.after?.(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {} });
  return file;
}

const form = (extra = {}) => parseCardMessage(`${CARD_PREFIX}${JSON.stringify({
  kind: 'q', title: 't', summary: 's', fields: [{ key: 'a', label: '问题？', options: ['甲', '乙'] }], ...extra,
})}`);

function stubPost() {
  const calls = [];
  const fn = async (url, body) => { calls.push({ url, body }); return { message_id: 'f1', form_option_ids: { a: ['opt_1', 'opt_2'] } }; };
  fn.calls = calls;
  return fn;
}

async function send(parsed, type) {
  const file = tmpFile();
  const post = stubPost();
  const lookups = [];
  const out = await sendCardMessage('conv-1', parsed, {
    post,
    conversationType: async (id) => { lookups.push(id); return type; },
    recordOptions: { file },
  });
  const [rec] = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { out, body: post.calls[0].body, rec, lookups };
}

test('DM + answerers: sent without answerers, with a note; askedOf kept from them', async () => {
  const { out, body, rec, lookups } = await send(form({ answerers: ['m-ann'] }), 'dm');
  assert.deepEqual(lookups, ['conv-1']);
  assert.equal(body.form.answerers, undefined, 'answerers must not reach cws-comm in a DM');
  assert.equal(out.note, DM_ANSWERERS_NOTE);
  assert.deepEqual(rec.askedOf, ['m-ann'], 'askedOf defaults from answerers before they are dropped');
});

test('DM + answerers + askedOf: askedOf is still checked against answerers, then answerers dropped', async () => {
  const { out, body, rec } = await send(form({ askedOf: 'm-ann', answerers: ['m-ann'] }), 'DM');
  assert.equal(body.form.answerers, undefined);
  assert.equal(out.note, DM_ANSWERERS_NOTE);
  assert.deepEqual(rec.askedOf, ['m-ann']);
  await assert.rejects(() => send(form({ askedOf: 'm-bob', answerers: ['m-ann'] }), 'dm'), /not in answerers/);
});

test('group + answerers: unchanged', async () => {
  const { out, body } = await send(form({ answerers: ['m-ann'] }), 'group');
  assert.deepEqual(body.form.answerers, ['m-ann']);
  assert.equal(out.note, undefined);
});

test('DM without answerers: unchanged, and no lookup', async () => {
  const { out, body, lookups } = await send(form({ askedOf: 'm-ann' }), 'dm');
  assert.equal(body.form.answerers, undefined);
  assert.equal(out.note, undefined);
  assert.deepEqual(lookups, [], 'no answerers, nothing to decide');
});

test('a failed lookup keeps the answerers (the card only @s)', async () => {
  const file = tmpFile();
  const post = stubPost();
  const out = await sendCardMessage('conv-1', form({ answerers: ['m-ann'] }), {
    post, conversationType: async () => { throw new Error('boom'); }, recordOptions: { file },
  });
  assert.deepEqual(post.calls[0].body.form.answerers, ['m-ann']);
  assert.equal(out.note, undefined);
});

test('the lookup is bounded: 2000 ms by default', () => {
  assert.equal(CONVERSATION_TYPE_TIMEOUT_MS, 2000);
});

test('a lookup that never answers: the card is still sent after the deadline, with its answerers', { timeout: 5000 }, async () => {
  const file = tmpFile();
  const post = stubPost();
  const t0 = Date.now();
  const out = await sendCardMessage('conv-1', form({ answerers: ['m-ann'] }), {
    post,
    conversationType: () => new Promise(() => {}),
    conversationTypeTimeoutMs: 150,
    recordOptions: { file },
  });
  const elapsed = Date.now() - t0;
  assert.equal(post.calls.length, 1, 'the POST must go out');
  assert.deepEqual(post.calls[0].body.form.answerers, ['m-ann'], 'no answer is not "a DM"');
  assert.equal(out.note, undefined);
  assert.ok(elapsed >= 140 && elapsed < 2000, `sent after ${elapsed} ms`);
});

test('the lookup gets the deadline, so a real GET can abort itself', async () => {
  const file = tmpFile();
  const seen = [];
  await sendCardMessage('conv-1', form({ answerers: ['m-ann'] }), {
    post: stubPost(),
    conversationType: async (id, timeoutMs) => { seen.push([id, timeoutMs]); return 'group'; },
    recordOptions: { file },
  });
  assert.deepEqual(seen, [['conv-1', CONVERSATION_TYPE_TIMEOUT_MS]]);
});
