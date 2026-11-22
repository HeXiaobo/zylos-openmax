import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSendBody, readSendExtras, parseStructuredMessage, sendStructuredMessage, StructuredMessageError, STRUCTURED_PREFIX,
} from './send-body.js';
import { createRunStore } from './activity/run-store.js';

// `[STRUCTURED]` is comm.send's body builder behind the c4-send entry: the same
// input builds the same body, the endpoint supplies conversation / reply / run.

const strip = ({ client_msg_id: _id, ...rest }) => rest;
const structured = (payload) => `${STRUCTURED_PREFIX}${JSON.stringify(payload)}`;

test('T9: the same input builds the same body through [STRUCTURED] as through comm.send', () => {
  const inputs = [
    { content: 'plain' },
    { content: '# heading\n- item' },
    { content: { text: 'see', attachments: [{ artifact_id: 'a', file_name: 'r.pdf', content_type: 'application/pdf', size_bytes: 3 }] } },
    { type: 'AGENT_STRUCTURED', content: { content_type: 'x.card', body: { k: 1 } }, metadata: { a: 1 }, fallback_text: 'fb' },
    { content: 'hi', mentions: ['m-1', { type: 'all_agents' }] },
  ];
  for (const input of inputs) {
    const viaComm = buildSendBody({ ...input, conversationId: 'c1' }, readSendExtras(input, 'comm.send'));
    const parsed = parseStructuredMessage(structured(input));
    const viaStructured = buildSendBody({ ...parsed.params, conversationId: 'c1' }, parsed.extras, '[STRUCTURED]');
    assert.deepEqual(strip(viaStructured), strip(viaComm), JSON.stringify(input));
  }
});

test('T9: `@name` in text gives no mentions; mentions are explicit only', () => {
  const body = buildSendBody({ conversationId: 'c1', content: '@luna.coco @所有人 看下' });
  assert.equal('mentions' in body, false);
});

test('T9: errors name the entry used, and a non-[STRUCTURED] message is not parsed', () => {
  assert.equal(parseStructuredMessage('hello'), null);
  assert.equal(parseStructuredMessage('[CARD]{}'), null);
  assert.throws(() => parseStructuredMessage(structured({ content: [] })), /^Error: \[STRUCTURED\]: content cannot be an array/);
  assert.throws(() => parseStructuredMessage(structured({ content: 'x', org: 'a' })), StructuredMessageError);
  assert.throws(() => buildSendBody({ content: [] }), /^Error: comm\.send: content cannot be an array/);
});

test('T9: sendStructuredMessage posts once to the endpoint conversation, quote from |reply:, run from |msg:', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-structured-runs-'));
  const store = createRunStore({ dir });
  const posts = [];
  const out = await sendStructuredMessage('conv-s', parseStructuredMessage(structured({ content: 'x', clientMsgId: 'cmsg-keep' })), {
    post: async (p, body) => { posts.push({ p, body }); return { id: '7300000000000000201' }; },
    apiPath: (p) => `/api/v1${p}`,
    replyTo: '7300000000000000200',
    sourceMessageId: '7300000000000000199',
    runStore: store,
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].p, '/api/v1/conversations/conv-s/messages');
  assert.equal(posts[0].body.parent_id, '7300000000000000200');
  assert.equal(posts[0].body.client_msg_id, 'cmsg-keep');
  assert.equal('agent_run' in posts[0].body, false, 'no run registered → no agent_run');
  assert.deepEqual(out, { ok: true, structured: true, message_id: '7300000000000000201' });
});
