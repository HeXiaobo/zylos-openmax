import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { quoteExcerptFrom, quotedMessageText } from './quote-excerpt.js';
import { formatInboundForC4 } from './message.js';

// Quoting part of a card. The quoted message comes from the
// get-message detail envelope: the card body sits under top-level `content`,
// `message.content` is null and `message.fallback_text` is the sender's
// plain-text projection.

const PARENT = 'm-card';
const FALLBACK = '要升级哪些组件?(回复 只升 dashboard / 全部升级)';

function cardDetail(bodyOver = {}) {
  return {
    message: { id: PARENT, type: 'CARD', sender_id: 'a-1', content: null, fallback_text: FALLBACK },
    content: {
      content_type: 'card',
      body: {
        schema: 'cws.card.v1',
        kind: 'interaction.choice',
        mode: 'display',
        title: '要升级哪些组件?',
        summary: '两个组件有新版本',
        blocks: [
          { type: 'text', text: '升级期间服务会重启一次,约 30 秒。' },
          { type: 'fields', items: [{ label: 'dashboard', value: '0.5.4 -> 0.5.5' }, { label: 'openmax', value: '2.31.0 -> 2.32.0' }] },
        ],
        actions: [{ id: 'opt_1', label: '只升 dashboard' }, { id: 'opt_2', label: '全部升级' }],
        ...bodyOver,
      },
    },
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(q, excerptText) {
  const msg = {
    id: 'm-2', parent_id: PARENT,
    metadata: { quote_excerpts: { version: 1, items: [{ message_id: PARENT, text: excerptText }] } },
  };
  return formatInboundForC4({ type: 'dm', id: 'cv-1' }, { displayName: 'Alice' }, { content: '这段什么意思?', messageId: 'm-2' }, [], {
    quotedContent: { sender: 'Bot', text: quotedMessageText(q) },
    quotedExcerpt: quoteExcerptFrom(msg, PARENT),
  });
}

test('card quoted: the parent full text is the structured expansion, not fallback_text', () => {
  const text = quotedMessageText(cardDetail());
  assert.equal(text, [
    '【要升级哪些组件?】',
    '两个组件有新版本',
    '',
    '升级期间服务会重启一次,约 30 秒。',
    '',
    'dashboard: 0.5.4 -> 0.5.5\nopenmax: 2.31.0 -> 2.32.0',
    '',
    '[options] 只升 dashboard / 全部升级',
  ].join('\n'));
  // An excerpt not found in it: <replying-to> keeps the full text.
  const out = render(cardDetail(), '不在卡片里的一句');
  assert.ok(out.includes(`<replying-to>\n[Bot]: ${esc(text)}\n</replying-to>`), out);
  assert.ok(!out.includes(FALLBACK), out);
});

test('card quoted: a single field or a single body paragraph verifies', () => {
  for (const excerpt of [
    '升级期间服务会重启一次,约 30 秒。', // one body paragraph
    '重启一次',                          // part of a paragraph
    '要升级哪些组件?',                    // title
    '两个组件有新版本',                    // summary
    '0.5.4 -> 0.5.5',                    // one field value
    'openmax',                           // one field label
    '全部升级',                           // one option
  ]) {
    const out = render(cardDetail(), excerpt);
    assert.ok(out.includes(`<replying-to>\n[Bot]: ${esc(excerpt)}\n</replying-to>`), `${excerpt}: ${out}`);
  }
});

test('card quoted: a selection spanning several fields may stay unverified (accepted) → full text', () => {
  // The expansion lays fields out as `label: value` and wraps the title in 【】,
  // so a selection whose layout differs across fields is not found. This is
  // accepted; the assertion pins today's behaviour, it is not a requirement.
  for (const excerpt of ['dashboard 0.5.4 -> 0.5.5', '要升级哪些组件? 两个组件有新版本']) {
    const out = render(cardDetail(), excerpt);
    assert.ok(out.includes(`<replying-to>\n[Bot]: ${esc(quotedMessageText(cardDetail()))}\n</replying-to>`), `${excerpt}: ${out}`);
  }
});

test('card with no structured content falls back to fallback_text', () => {
  // channel_qr shape: schema-only body, no blocks.
  const q = { message: { id: PARENT, content: null, fallback_text: '扫码连接 lark' }, content: { content_type: 'channel_qr', body: { schema: 'openmax.channel-qr.v1', channel_type: 'lark' } } };
  assert.equal(quotedMessageText(q), '扫码连接 lark');
  assert.ok(render(q, '扫码连接').includes('<replying-to>\n[Bot]: 扫码连接\n</replying-to>'));
});

test('non-card quoted messages are unchanged', () => {
  // body.text wins, even over blocks / fallback_text
  assert.equal(quotedMessageText({ message: { content: 'flat', fallback_text: 'fb' }, content: { body: { text: 'hi', blocks: [{ text: 'x' }] } } }), 'hi');
  // string message.content next
  assert.equal(quotedMessageText({ message: { content: 'flat', fallback_text: 'fb' }, content: { body: {} } }), 'flat');
  // then message.fallback_text
  assert.equal(quotedMessageText({ message: { fallback_text: 'fb' }, content: { attachments: [] } }), 'fb');
  // a caption-less image/file yields '' so the bridge can label it
  assert.equal(quotedMessageText({ message: { type: 'image' }, content: { attachments: [{ artifact_id: 'a' }] } }), '');
  assert.equal(quotedMessageText({}), '');
});

test('comm-bridge builds the quoted text with quotedMessageText', () => {
  const bridge = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');
  assert.match(bridge, /import \{[^}]*quotedMessageText[^}]*\} from '\.\/lib\/quote-excerpt\.js'/);
  assert.match(bridge, /let qText = quotedMessageText\(q\);/);
});
