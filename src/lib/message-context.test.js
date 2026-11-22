import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  contextItemsFrom, agentContextItemsFrom, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ATTRS,
  fitsContextDataLimit, UNREGISTERED_DATA_MAX_BYTES,
} from './message-context.js';
import { connectorPreferenceOf, preferredConnectorsFrom } from './connector-preference.js';
import { workflowRefOf, wfRefFrom } from './wf-context.js';
import { quoteExcerptOf, quoteExcerptFrom } from './quote-excerpt.js';
import { chatHistoryOf } from './forwarded.js';
import { inboundPriority, systemEventPriority } from './system-message.js';
import { formatInboundForC4 } from './message.js';

// metadata.context (OPENM-1351):
//   { items: [{ type, source, audience, attrs, data? }] }   — no version field.
// The bridge reads the context item first and the old key as fallback, and
// renders both through the existing 2.33.0 elements: the envelope must be
// byte-identical whichever key carried the same data.

const ctx = (...items) => ({ context: { items } });
const item = (type, attrs = {}, more = {}) => ({ type, source: 'client', audience: 'agent', attrs, ...more });

// The same logical data, once per key.
const OLD = {
  preferred_connectors: [{ connection_id: 'c_8f2', label: 'Gmail·Work mail (org)' }, { connection_id: 'c_91a', label: 'Notion' }],
  wf_ref: { workflow_id: 'wf-1', run_id: 'run-9', page: 'step', step_n: 3 },
  quote_excerpts: { version: 1, items: [{ message_id: 'm-1', text: '下周三前交初稿', offset: 12 }] },
  forwarded_from: {
    version: 1, sender_id: 'u-zhang', sender_type: 'human', sender_name: '张三', sent_at: '2026-11-10T08:00:00.000Z', source_kind: 'group',
  },
};
const CONNECTORS = item('connectors', { count: 2 }, { data: { connections: OLD.preferred_connectors } });
const WORKFLOW = item('workflow', { 'workflow-id': 'wf-1', 'run-id': 'run-9', page: 'step', 'step-n': 3 }, { source: 'app:3f2' });
const QUOTE = item('quote', { 'message-id': 'm-1', offset: 12 }, { data: { text: '下周三前交初稿' } });
const FORWARDED = item('forwarded', {
  'sender-id': 'u-zhang', 'sender-type': 'human', 'sender-name': '张三', 'sent-at': '2026-11-10T08:00:00.000Z', 'source-kind': 'group',
}, { source: 'platform' });
const NEW = ctx(CONNECTORS, WORKFLOW, QUOTE, FORWARDED);

function msgWith(metadata, extra = {}) {
  return { id: 'm-2', conversation_id: 'cv-1', parent_id: 'm-1', content: { body: { text: '这个能提前吗？' } }, metadata, ...extra };
}

// The whole envelope, built the way comm-bridge builds it (new readers).
function envelope(msg, { type = 'dm' } = {}) {
  return formatInboundForC4({ type, id: 'cv-1', name: 'G' }, { displayName: 'Alice' }, { content: '这个能提前吗？', messageId: 'm-2' },
    [{ senderName: 'Bob', content: '那句话' }], {
      quotedContent: { sender: 'Bob', text: '请在下周三前交初稿，谢谢' },
      quotedExcerpt: quoteExcerptOf(msg, 'm-1'),
      chatHistory: chatHistoryOf(msg),
      preferredConnectors: connectorPreferenceOf(msg),
      wfRef: workflowRefOf(msg),
      orgId: 'org-1',
    });
}

// The same envelope with the 2.33.0 readers (old keys only). A one-by-one
// forwarded copy is not framed as forwarded, whichever key carries it.
function envelope233(msg, { type = 'dm' } = {}) {
  return formatInboundForC4({ type, id: 'cv-1', name: 'G' }, { displayName: 'Alice' }, { content: '这个能提前吗？', messageId: 'm-2' },
    [{ senderName: 'Bob', content: '那句话' }], {
      quotedContent: { sender: 'Bob', text: '请在下周三前交初稿，谢谢' },
      quotedExcerpt: quoteExcerptFrom(msg, 'm-1'),
      chatHistory: chatHistoryOf(msg),
      preferredConnectors: preferredConnectorsFrom(msg),
      wfRef: wfRefFrom(msg),
      orgId: 'org-1',
    });
}

// --- parity: new item and old key render byte-identically ---------------------

test('parity: the four new items render exactly like the four old keys (DM and group)', () => {
  for (const type of ['dm', 'group']) {
    const fromNew = envelope(msgWith(NEW), { type });
    const fromOld = envelope(msgWith(OLD), { type });
    assert.equal(fromNew, fromOld, type);
    assert.equal(fromOld, envelope233(msgWith(OLD), { type }), type);
  }
  const out = envelope(msgWith(NEW), { type: 'group' });
  assert.match(out, /^<connector-preference connection-ids="c_8f2,c_91a">$/m);
  assert.match(out, /^<wf-context workflow-id="wf-1" run-id="run-9" page="step" step-n="3"\/>$/m);
  assert.match(out, /^<replying-to>\n\[Bob\]: 下周三前交初稿\n<\/replying-to>$/m);
  // Neither forwarded key frames the message as forwarded.
  assert.doesNotMatch(out, /forwarded|张三/);
  assert.match(out, /\[Bob\]: 那句话/);
  // No new element or attribute anywhere in the envelope.
  assert.doesNotMatch(out, /<context|source-verified|source="|<subconversation|unverified|<quoted-excerpt/);
});

test('parity per type: each new item alone renders like its old key alone', () => {
  const pairs = [
    [{ preferred_connectors: OLD.preferred_connectors }, ctx(CONNECTORS)],
    [{ wf_ref: OLD.wf_ref }, ctx(WORKFLOW)],
    [{ quote_excerpts: OLD.quote_excerpts }, ctx(QUOTE)],
    [{ forwarded_from: OLD.forwarded_from }, ctx(FORWARDED)],
  ];
  for (const [oldMeta, newMeta] of pairs) {
    for (const type of ['dm', 'group']) {
      assert.equal(envelope(msgWith(newMeta), { type }), envelope(msgWith(oldMeta), { type }), JSON.stringify(oldMeta));
    }
  }
});

test('parity: the quote content check (unverified → full quoted text) and the tombstone behave the same', () => {
  const notInOriginal = { text: '原文里没有这句' };
  const oldQ = { quote_excerpts: { version: 1, items: [{ message_id: 'm-1', ...notInOriginal }] } };
  const newQ = ctx(item('quote', { 'message-id': 'm-1' }, { data: notInOriginal }));
  assert.equal(envelope(msgWith(newQ)), envelope(msgWith(oldQ)));
  assert.match(envelope(msgWith(newQ)), /<replying-to>\n\[Bob\]: 请在下周三前交初稿，谢谢\n<\/replying-to>/);
  assert.doesNotMatch(envelope(msgWith(newQ)), /原文里没有这句|<quoted-excerpt|unverified/);
  const oldT = { quote_excerpts: { version: 1, items: [{ message_id: 'm-1', recalled: true, text: 'stale' }] } };
  const newT = ctx(item('quote', { 'message-id': 'm-1', recalled: true }, { data: { text: 'stale' } }));
  assert.deepEqual(quoteExcerptOf(msgWith(newT), 'm-1'), { kind: 'recalled' });
  assert.equal(envelope(msgWith(newT)), envelope(msgWith(oldT)));
  assert.match(envelope(msgWith(newT)), /<replying-to>\n\[Bob\]: 请在下周三前交初稿，谢谢\n<\/replying-to>/);
  assert.doesNotMatch(envelope(msgWith(newT)), /<quoted-excerpt|stale/);
});

test('parity: values are normalized by the same rules (escaping, flattening, caps)', () => {
  const label = 'A<b>"c"\nd'.padEnd(70, 'x');
  const name = '张  三 <x> "y"';
  const oldM = {
    preferred_connectors: [{ connection_id: 'c_1', label }, { connection_id: 'bad id', label: 'dropped' }],
    wf_ref: { workflow_id: 'wf "1"\n<x>', run_id: null, page: 'run' },
    forwarded_from: { version: 1, sender_id: 'u-1', sender_name: name },
  };
  const newM = ctx(
    item('connectors', {}, { data: { connections: oldM.preferred_connectors } }),
    item('workflow', { 'workflow-id': 'wf "1"\n<x>', page: 'run' }),
    item('forwarded', { 'sender-id': 'u-1', 'sender-name': name }),
  );
  for (const type of ['dm', 'group']) assert.equal(envelope(msgWith(newM), { type }), envelope(msgWith(oldM), { type }));
});

// --- fallback and precedence --------------------------------------------------

test('without context items each reader falls back to its old key (old-key output unchanged from 2.33.0)', () => {
  const msg = msgWith(OLD);
  assert.deepEqual(connectorPreferenceOf(msg), preferredConnectorsFrom(msg));
  assert.deepEqual(workflowRefOf(msg), wfRefFrom(msg));
  assert.deepEqual(quoteExcerptOf(msg, 'm-1'), quoteExcerptFrom(msg, 'm-1'));
  assert.equal(envelope(msg), envelope233(msg));
});

test('an unusable context item falls back to the old key', () => {
  const msg = msgWith({
    ...OLD,
    ...ctx(
      item('connectors', {}, { data: { connections: [{ connection_id: 'bad id!', label: 'x' }] } }),
      item('workflow', { note: 'no registered attr' }),
      item('quote', { 'message-id': 'm-1' }),
      item('quote', { 'message-id': 'm-other' }, { data: { text: 'another message' } }),
      item('forwarded', { 'sender-name': 'no id' }),
    ),
  });
  assert.equal(envelope(msg), envelope(msgWith(OLD)));
});

test('both present → the context item wins, and only one element is rendered', () => {
  const msg = msgWith({ ...OLD, ...ctx(
    item('connectors', {}, { data: { connections: [{ connection_id: 'c_new', label: 'New' }] } }),
    item('workflow', { 'workflow-id': 'wf-new', page: 'run' }),
    item('quote', { 'message-id': 'm-1' }, { data: { text: '谢谢' } }),
    item('forwarded', { 'sender-id': 'u-new', 'sender-name': '新作者' }),
  ) });
  const out = envelope(msg, { type: 'group' });
  assert.equal(out.match(/<connector-preference/g).length, 1);
  assert.match(out, /connection-ids="c_new"/);
  assert.equal(out.match(/<wf-context/g).length, 1);
  assert.match(out, /<wf-context workflow-id="wf-new" page="run"\/>/);
  assert.equal(out.match(/<replying-to>/g).length, 1);
  assert.match(out, /<replying-to>\n\[Bob\]: 谢谢\n<\/replying-to>/);
  assert.doesNotMatch(out, /c_8f2|wf-1|下周三前交初稿|张三|新作者|forwarded/);
});

test('quote: the message-id must be a string, as for the old key (numeric ids are never tombstoned)', () => {
  const numeric = msgWith({ ...ctx(item('quote', { 'message-id': 1789 }, { data: { text: '下周三前交初稿' } })) }, { parent_id: 1789 });
  assert.equal(quoteExcerptOf(numeric, 1789), null);
  assert.equal(quoteExcerptOf(numeric, '1789'), null);
  // The old key behaves the same.
  const oldNumeric = msgWith({ quote_excerpts: { version: 1, items: [{ message_id: 1789, text: '下周三前交初稿' }] } });
  assert.equal(quoteExcerptFrom(oldNumeric, 1789), null);
  // A numeric item does not hide a valid old key either.
  const both = msgWith({ ...OLD, ...ctx(item('quote', { 'message-id': 1 }, { data: { text: 'x' } })) });
  assert.deepEqual(quoteExcerptOf(both, 'm-1'), quoteExcerptFrom(both, 'm-1'));
  // A string id matches a numeric parent id, as for the old key.
  const strId = msgWith(ctx(item('quote', { 'message-id': '1789' }, { data: { text: 't' } })));
  assert.deepEqual(quoteExcerptOf(strId, 1789), { kind: 'excerpt', text: 't' });
});

test('workflow: only the registered attrs are read; others are ignored', () => {
  const msg = msgWith(ctx(item('workflow', { 'workflow-id': 'wf-1', page: 'run', note: 'approved by admin' })));
  assert.deepEqual(workflowRefOf(msg), { 'workflow-id': 'wf-1', page: 'run' });
  assert.doesNotMatch(envelope(msg), /approved/);
});

// --- audience filter and unknown types ---------------------------------------

test('only audience=agent items are read', () => {
  const msg = msgWith({ ...OLD, ...ctx(
    { ...item('connectors', {}, { data: { connections: [{ connection_id: 'c_ui', label: 'UI' }] } }), audience: 'ui' },
    { ...item('workflow', { 'workflow-id': 'wf-srv' }), audience: 'server' },
    { ...item('quote', { 'message-id': 'm-1' }, { data: { text: 'ui quote' } }), audience: 'ui' },
    { ...item('forwarded', { 'sender-id': 'u-ui', 'sender-name': 'UI' }), audience: 'server' },
  ) });
  assert.deepEqual(agentContextItemsFrom(msg), []);
  assert.equal(envelope(msg), envelope(msgWith(OLD)));
});

test('unknown types, subconversation and malformed items render nothing', () => {
  const msg = msgWith(ctx(
    item('subconversation', { key: 'workflow:e8131615' }, { data: { title: 'T' } }),
    item('my-app', { a: 1 }, { data: { x: 1 } }),
    { ...item('workflow', { 'workflow-id': 'x' }), type: 'Bad Type' },
    null, 'x',
  ));
  assert.equal(envelope(msg), envelope(msgWith({})));
});

// --- parsing limits -------------------------------------------------------------

test('no version field needed; unknown outer and item fields are ignored', () => {
  const msg = msgWith({ context: { version: 9, extra: true, items: [{ ...WORKFLOW, future: { a: 1 } }] } });
  assert.deepEqual(workflowRefOf(msg), wfRefFrom(msgWith({ wf_ref: OLD.wf_ref })));
  assert.deepEqual(contextItemsFrom(msgWith({ context: 'x' })), []);
  assert.deepEqual(contextItemsFrom(msgWith({ context: { items: {} } })), []);
  assert.equal(contextItemsFrom({ message: { metadata: ctx(WORKFLOW) } }).length, 1);
});

test(`at most ${MAX_CONTEXT_ITEMS} items and ${MAX_CONTEXT_ATTRS} attrs per item are read`, () => {
  const many = Array.from({ length: MAX_CONTEXT_ITEMS + 4 }, (_, i) => item(`app-${i}`, { n: i }));
  assert.equal(contextItemsFrom(msgWith(ctx(...many))).length, MAX_CONTEXT_ITEMS);
  const attrs = Object.fromEntries(Array.from({ length: MAX_CONTEXT_ATTRS + 3 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(contextItemsFrom(msgWith(ctx(item('app-x', attrs))))[0].attrs).length, MAX_CONTEXT_ATTRS);
});

test('over-long or non-scalar attrs and oversize data are dropped, not cut', () => {
  const [it] = contextItemsFrom(msgWith(ctx(item('my-app', {
    long: 'x'.repeat(201), ok: 'x'.repeat(200), obj: { a: 1 }, nul: null, nan: Number.NaN, Bad_Key: 'v', flag: false,
  }))));
  assert.deepEqual(Object.keys(it.attrs), ['ok', 'flag']);
  // A workflow id over 200 code points is dropped (the old key drops it the same way).
  assert.equal(workflowRefOf(msgWith(ctx(item('workflow', { 'workflow-id': 'x'.repeat(201) })))), null);
  // A quote whose data is over the 6 KiB quote limit is dropped → falls back.
  const q = msgWith({ ...OLD, ...ctx(item('quote', { 'message-id': 'm-1' }, { data: { text: '字'.repeat(2100) } })) });
  assert.deepEqual(quoteExcerptOf(q, 'm-1'), quoteExcerptFrom(q, 'm-1'));
  // Data deeper than 5 levels is dropped.
  const [deep] = contextItemsFrom(msgWith(ctx(item('my-app', {}, { data: { a: { b: { c: { d: { e: { f: 1 } } } } } } }))));
  assert.equal(deep.data, undefined);
});

// --- systemEvent.priority only from a System Member -----------------------------

test('systemEvent.priority is honored only on a SYSTEM sender message', () => {
  const urgent = { metadata: { systemEvent: { priority: 'urgent' } } };
  assert.equal(inboundPriority({ ...urgent, sender_type: 'SYSTEM' }), 1);
  assert.equal(inboundPriority({ message: { sender_type: 'SYSTEM' }, ...urgent }), 1);
  for (const sender_type of ['HUMAN', 'AGENT', undefined, 'system-ish']) {
    assert.equal(inboundPriority({ ...urgent, sender_type }), undefined, String(sender_type));
  }
  assert.equal(inboundPriority({ content: { metadata: { systemEvent: { priority: 'urgent' } } }, sender_type: 'HUMAN' }), undefined);
  assert.equal(systemEventPriority(urgent), 1);
});

// --- data size threshold (2 KiB for an unregistered type) ---------------------

test('fitsContextDataLimit: exactly 2048 encoded bytes fits, 2049 does not', () => {
  assert.equal(UNREGISTERED_DATA_MAX_BYTES, 2048);
  const ofBytes = (n, ch = 'x') => ({ s: ch.repeat((n - 8) / Buffer.byteLength(ch)) }); // {"s":"…"} = 8 + payload
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  assert.equal(bytes(ofBytes(2048)), 2048);
  assert.equal(fitsContextDataLimit(ofBytes(2048)), true);
  assert.equal(bytes(ofBytes(2049)), 2049);
  assert.equal(fitsContextDataLimit(ofBytes(2049)), false);
  // UTF-8 bytes, not code units: 680 × 说 (3 bytes) + 8 = 2048, + 1 ASCII = 2049
  const cjk = ofBytes(2048, '说');
  assert.equal(cjk.s.length, 680);
  assert.equal(fitsContextDataLimit(cjk), true);
  assert.equal(fitsContextDataLimit({ s: `${cjk.s}x` }), false);
  // explicit limit; unencodable → false
  assert.equal(fitsContextDataLimit(ofBytes(2049), 2049), true);
  const cyc = {}; cyc.self = cyc;
  assert.equal(fitsContextDataLimit(cyc), false);
  assert.equal(fitsContextDataLimit({ n: 1n }), false);
  // the reader applies the same threshold to an unregistered type's data
  const read = (data) => contextItemsFrom({ metadata: { context: { items: [{ type: 'some-card', audience: 'ui', data }] } } })[0];
  assert.deepEqual(read(ofBytes(2048)).data, ofBytes(2048));
  assert.equal(read(ofBytes(2049)).data, undefined);
});

// --- priority item (phase 2): context first, old systemEvent as fallback --------

test('priority item: read first, only on a SYSTEM sender, source not read', () => {
  const pr = (level, extra = {}) => ({ type: 'priority', source: 'platform', audience: 'agent', attrs: { level }, ...extra });
  const sys = (items, metadata = {}) => ({ sender_type: 'SYSTEM', metadata: { ...metadata, context: { items } } });
  assert.equal(inboundPriority(sys([pr('urgent')])), 1);
  assert.equal(inboundPriority(sys([pr('high')])), 2);
  assert.equal(inboundPriority(sys([pr('normal')])), 3);
  assert.equal(inboundPriority(sys([pr('URGENT')])), 1);
  // an item with a missing / unknown level is invalid → the old key (plan §1.1)
  assert.equal(inboundPriority(sys([pr('bogus')], { systemEvent: { priority: 'urgent' } })), 1);
  assert.equal(inboundPriority(sys([pr(undefined)], { systemEvent: { priority: 'high' } })), 2);
  assert.equal(inboundPriority(sys([pr('')], { systemEvent: { priority: 'urgent' } })), 1);
  assert.equal(inboundPriority(sys([pr(1)], { systemEvent: { priority: 'urgent' } })), 1);
  // … and with no old key either, no priority (c4-receive default)
  assert.equal(inboundPriority(sys([pr('bogus')])), undefined);
  assert.equal(inboundPriority(sys([pr(undefined)])), undefined);
  // invalid item + present systemEvent with an unknown priority → 3, as before
  assert.equal(inboundPriority(sys([pr('bogus')], { systemEvent: { priority: 'nope' } })), 3);
  // the item wins over the old key on the same message
  assert.equal(inboundPriority(sys([pr('high')], { systemEvent: { priority: 'urgent' } })), 2);
  // no (well-formed agent) priority item → the old key, as before
  assert.equal(inboundPriority(sys([], { systemEvent: { priority: 'urgent' } })), 1);
  assert.equal(inboundPriority(sys([pr('high', { audience: 'ui' })], { systemEvent: { priority: 'urgent' } })), 1);
  assert.equal(inboundPriority(sys([pr('high', { audience: 'nope' })])), undefined);
  assert.equal(inboundPriority(sys([])), undefined);
  // source is not read: any stamped source on a SYSTEM message counts
  for (const source of ['client', 'app:x', undefined]) {
    assert.equal(inboundPriority(sys([pr('urgent', { source })])), 1, String(source));
  }
  // nested envelope
  assert.equal(inboundPriority({ message: { sender_type: 'SYSTEM', metadata: { context: { items: [pr('high')] } } } }), 2);
  // never from a non-SYSTEM sender, item or old key
  for (const sender_type of ['HUMAN', 'AGENT', undefined]) {
    assert.equal(inboundPriority({ sender_type, metadata: { context: { items: [pr('urgent')] }, systemEvent: { priority: 'urgent' } } }), undefined);
    assert.equal(inboundPriority({ sender_type, metadata: { context: { items: [pr('bogus')] }, systemEvent: { priority: 'urgent' } } }), undefined);
  }
});

// --- bridge wiring -----------------------------------------------------------

const BRIDGE = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');

test('comm-bridge: C4 priority goes through inboundPriority, never systemEventPriority directly', () => {
  assert.match(BRIDGE, /forwardInbound\(endpoint, run \? run\.marker \+ body : body, inboundPriority\(msg\), caps\)/);
  assert.doesNotMatch(BRIDGE, /systemEventPriority/);
});

test('comm-bridge: the context-first readers feed the existing opts', () => {
  assert.match(BRIDGE, /quotedExcerpt: quoteExcerptOf\(msg, quotedMsgId\)/);
  assert.doesNotMatch(BRIDGE, /forwardedFrom/);
  assert.match(BRIDGE, /preferredConnectors: connectorPreferenceOf\(msg\)/);
  assert.match(BRIDGE, /wfRef: workflowRefOf\(msg\)/);
});
