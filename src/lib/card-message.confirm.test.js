/**
 * OPENM-1239: a `connector.write_confirm` card has a fixed shape (one askedOf,
 * options 确认执行 / 取消, meta.actions from conn.confirm_prepare) because
 * conn.invoke's gate reads it back. A malformed one is refused before it is
 * posted; a well-formed one is posted and recorded like any card.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CARD_PREFIX, CardMessageError, parseCardMessage, sendCardMessage } from './card-message.js';
import { findPendingQuestion } from './pending-question.js';
import { paramsDigest } from './conn-effect.js';

const action = (extra = {}) => ({
  app: 'shopify-app', action: 'shopify-app-products/update-variant', connectionId: 'c1',
  summary: '夏季亚麻衬衫 价格 199.00 → 179.10', effect: 'write', digest: paramsDigest({ a: 1 }), ...extra,
});
const confirmCard = (extra = {}) => ({
  kind: 'connector.write_confirm',
  askedOf: 'u-req',
  title: '请确认：Shopify 改价 1 个商品',
  summary: '连接：Shopify · lin-store',
  blocks: [{ type: 'markdown', text: '· 夏季亚麻衬衫 价格 ¥199.00 → ¥179.10' }],
  options: [{ label: '确认执行' }, { label: '取消' }],
  meta: { actions: [action()] },
  ...extra,
});
const asMessage = (payload) => `${CARD_PREFIX}${JSON.stringify(payload)}`;
const refused = (payload, re) => assert.throws(() => parseCardMessage(asMessage(payload)),
  (e) => e instanceof CardMessageError && /connector\.write_confirm/.test(e.message) && re.test(e.message));

test('a well-formed confirmation card parses, posts, and is recorded with its meta.actions', async () => {
  const parsed = parseCardMessage(asMessage(confirmCard()));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-confirm-')), 'pending.json');
  const calls = [];
  const res = await sendCardMessage('cv-1', parsed, {
    post: async (url, body) => { calls.push(body); return { message_id: 'msg-c', action_ids: ['o1', 'o2'] }; },
    now: () => '2026-11-23T10:00:00.000Z',
    recordOptions: { file },
  });
  assert.equal(res.message_id, 'msg-c');
  assert.deepEqual(calls[0].choice.options.map((o) => o.label), ['确认执行', '取消']);
  const rec = findPendingQuestion('msg-c', { file });
  assert.equal(rec.kind, 'connector.write_confirm');
  assert.equal(rec.askedOf, 'u-req');
  assert.deepEqual(rec.meta.actions, [action()]);
});

test('options must be exactly 确认执行 / 取消 in that order', () => {
  refused(confirmCard({ options: [{ label: '取消' }, { label: '确认执行' }] }), /options/);
  refused(confirmCard({ options: [{ label: '确认' }, { label: '取消' }] }), /options/);
  refused(confirmCard({ options: [{ label: '确认执行' }, { label: '取消' }, { label: '稍后' }] }), /options/);
  // String options with the right labels are fine.
  assert.ok(parseCardMessage(asMessage(confirmCard({ options: ['确认执行', '取消'] }))));
});

test('askedOf must be one member id (the requester)', () => {
  refused(confirmCard({ askedOf: ['u-req', 'u-2'] }), /ONE member/);
  refused(confirmCard({ askedOf: ['u-req'] }), /ONE member/);
});

test('meta.actions must be non-empty and each carry app/action/connectionId/summary/digest', () => {
  refused(confirmCard({ meta: undefined }), /meta\.actions/);
  refused(confirmCard({ meta: { actions: [] } }), /meta\.actions/);
  refused(confirmCard({ meta: { actions: [action({ summary: '' })] } }), /summary/);
  refused(confirmCard({ meta: { actions: [action({ digest: 'sha256:short' })] } }), /digest/);
  const noConn = action(); delete noConn.connectionId;
  refused(confirmCard({ meta: { actions: [noConn] } }), /connectionId/);
});

test('a form cannot be a confirmation card; other kinds are not affected', () => {
  const { options: _o, ...rest } = confirmCard();
  refused({ ...rest, fields: [{ key: 'a', label: 'A', options: ['x'] }] }, /choice card/);
  assert.ok(parseCardMessage(asMessage({ ...confirmCard(), kind: 'something-else', meta: {} })));
});
