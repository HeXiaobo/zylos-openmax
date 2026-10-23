/**
 * wsb#679: a second quick-reply card to the same person in the same
 * conversation within 10 minutes carries a `warning` suggesting one choice
 * form. Warned, never refused. These cells cover the lookup and the `[CARD]`
 * reply path; src/cli/comm.repeat-card.test.js covers comm.ask / comm.ask_card.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CARD_PREFIX, parseCardMessage, sendCardMessage } from './card-message.js';
import {
  REPEAT_QUICK_REPLY_WINDOW_MS,
  recentQuickReplyTo,
  recordPendingQuestion,
} from './pending-question.js';

function tmpFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-qr-')), 'pending.json');
  test.after?.(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {} });
  return file;
}

const T0 = '2026-10-23T08:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60 * 1000).toISOString();

function quickReply(file, { conversationId = 'grp-1', askedOf = 'm-steph', askedAt = T0, cardMessageId = 'c1' } = {}) {
  recordPendingQuestion({ kind: 'q', askedOf, conversationId, cardMessageId, actionIds: ['opt_1', 'opt_2'], askedAt }, { file });
}

function form(file, { conversationId = 'grp-1', askedOf = ['m-steph'], askedAt = T0, cardMessageId = 'f1' } = {}) {
  recordPendingQuestion({
    kind: 'q', interactionType: 'form', askedOf, conversationId, cardMessageId,
    fields: { a: ['opt_1', 'opt_2'] }, askedAt,
  }, { file });
}

// ---------------------------------------------------------------- lookup

test('the window is 10 minutes', () => {
  assert.equal(REPEAT_QUICK_REPLY_WINDOW_MS, 10 * 60 * 1000);
});

test('a quick-reply card to the same person 5 minutes earlier is found', () => {
  const file = tmpFile();
  quickReply(file);
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', at(5), { file })?.cardMessageId, 'c1');
});

test('a list askedOf matches when any member overlaps', () => {
  const file = tmpFile();
  quickReply(file, { askedOf: ['m-ann', 'm-steph'] });
  assert.equal(recentQuickReplyTo('grp-1', ['m-steph'], at(1), { file })?.cardMessageId, 'c1');
});

test('a different person, another conversation, or none on file: nothing found', () => {
  const file = tmpFile();
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', at(1), { file }), null, 'first card');
  quickReply(file);
  assert.equal(recentQuickReplyTo('grp-1', 'm-kevin', at(1), { file }), null, 'different person');
  assert.equal(recentQuickReplyTo('grp-2', 'm-steph', at(1), { file }), null, 'different conversation');
});

const atMs = (ms) => new Date(Date.parse(T0) + ms).toISOString();

test('less than 10 minutes later is inside; exactly 10 minutes or more is outside', () => {
  const file = tmpFile();
  quickReply(file);
  assert.ok(recentQuickReplyTo('grp-1', 'm-steph', atMs(599999), { file }), '599999 ms: inside');
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', atMs(600000), { file }), null, '600000 ms: outside');
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', atMs(600001), { file }), null, '600001 ms: outside');
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', at(60), { file }), null);
});

test('a form on file never counts', () => {
  const file = tmpFile();
  form(file);
  assert.equal(recentQuickReplyTo('grp-1', 'm-steph', at(1), { file }), null);
});

// ---------------------------------------------------------------- [CARD] reply path

const qrCard = (askedOf = 'm-steph', title = '要升级吗') =>
  parseCardMessage(`${CARD_PREFIX}${JSON.stringify({ kind: 'q', askedOf, title, summary: 's', text: 'x', options: ['是', '否'] })}`);
const formCard = (askedOf = 'm-steph') =>
  parseCardMessage(`${CARD_PREFIX}${JSON.stringify({ kind: 'q', askedOf, title: 't', summary: 's', fields: [{ key: 'a', label: '问题？', options: ['甲', '乙'] }] })}`);

let seq = 0;
const choicePost = () => async () => { seq += 1; return { message_id: `m${seq}`, action_ids: ['opt_1', 'opt_2'] }; };
const formPost = () => async () => { seq += 1; return { message_id: `m${seq}`, form_option_ids: { a: ['opt_1', 'opt_2'] } }; };
const send = (file, parsed, minutes, post = choicePost()) =>
  sendCardMessage('grp-1', parsed, { post, now: () => at(minutes), recordOptions: { file } });

test('[CARD]: the second quick-reply card to the same person within 10 minutes carries a warning', async () => {
  const file = tmpFile();
  const first = await send(file, qrCard(), 0);
  assert.equal(first.warning, undefined, 'a single card does not warn');
  const second = await send(file, qrCard('m-steph', '第二个问题'), 2);
  assert.equal(second.ok, true, 'warned, not refused');
  assert.match(second.warning, /ONE choice form/);
  assert.match(second.warning, new RegExp(first.message_id));
});

test('[CARD]: a different person, or 10+ minutes later, carries no warning', async () => {
  const file = tmpFile();
  await send(file, qrCard('m-steph'), 0);
  assert.equal((await send(file, qrCard('m-kevin'), 1)).warning, undefined, 'different person');
  assert.equal((await send(file, qrCard('m-steph'), 11)).warning, undefined, '11 minutes after the last card to m-steph');
});

test('[CARD]: a form card never triggers it, before or after a quick-reply card', async () => {
  const file = tmpFile();
  await send(file, qrCard(), 0);
  const f = await send(file, formCard(), 1, formPost());
  assert.equal(f.warning, undefined, 'a form after a quick-reply card');
  const file2 = tmpFile();
  await send(file2, formCard(), 0, formPost());
  assert.equal((await send(file2, qrCard(), 1)).warning, undefined, 'a quick-reply card after a form');
});

test('[CARD]: the card is recorded at the time its POST answered, not before (same event as comm.ask_card)', async () => {
  const file = tmpFile();
  let answeredAt = 0;
  const slowPost = async () => {
    await new Promise((r) => setTimeout(r, 300));
    answeredAt = Date.now();
    seq += 1;
    return { message_id: `m${seq}`, action_ids: ['opt_1', 'opt_2'] };
  };
  const res = await sendCardMessage('grp-1', qrCard(), { post: slowPost, recordOptions: { file } });
  const [rec] = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.cardMessageId, res.message_id);
  assert.ok(Date.parse(rec.askedAt) >= answeredAt, `askedAt ${rec.askedAt} is before the POST answered at ${new Date(answeredAt).toISOString()}`);
});
