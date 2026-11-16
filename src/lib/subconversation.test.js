import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  subConversationOf,
  groupScopeConversationId,
  fetchesConversationContext,
} from './subconversation.js';

// Sub-conversations (cws-comm#373) are recognised from the conversation record
// (GET /conversations/{id}) only, fail closed, and generically: no context key
// or owner is special-cased.

const P = '019f7000-0000-7000-8000-00000000000a';
const S = '019f7000-0000-7000-8000-00000000000b';

const app = (extra = {}) => ({
  id: S, type: 'dm', parent_conversation_id: P,
  context_owner_kind: 'app', context_owner_app_id: 'app-1', context_key: 'ticket:42', context_title: 'Ticket #42',
  ...extra,
});
const topic = (extra = {}) => ({
  id: S, type: 'group', parent_conversation_id: P,
  context_owner_kind: 'platform', context_key: 'message:1795000000000000001',
  ...extra,
});

test('app sub-conversation → parent id and owner kind', () => {
  assert.deepEqual(subConversationOf(app()), { parentConversationId: P, ownerKind: 'app' });
});

test('platform sub-conversation → parent id and owner kind (nothing read from its key or a root id)', () => {
  assert.deepEqual(subConversationOf(topic()), { parentConversationId: P, ownerKind: 'platform' });
  assert.deepEqual(subConversationOf(app({ context_key: 'message:5', root_message_id: '5' })), { parentConversationId: P, ownerKind: 'app' });
});

test('any key matching the server rule works (generic)', () => {
  for (const key of ['ticket:42', 'a', 'x_y-z:1', 'order-2026:abc_def', 'k'.repeat(128)]) {
    assert.ok(subConversationOf(app({ context_key: key })), key);
  }
});

test('legacy strat thread (parent only) is not a sub-conversation', () => {
  assert.equal(subConversationOf({ id: S, type: 'group', parent_conversation_id: P }), null);
});

test('fail closed: missing or malformed fields → null', () => {
  const cases = {
    'no record': null,
    'undefined': undefined,
    'not an object': 'conv',
    'empty': {},
    'unknown owner kind': app({ context_owner_kind: 'robot' }),
    'owner kind wrong case': app({ context_owner_kind: 'App' }),
    'owner kind not a string': app({ context_owner_kind: ['app'] }),
    'no key': app({ context_key: undefined }),
    'empty key': app({ context_key: '' }),
    'upper-case key': app({ context_key: 'Ticket:42' }),
    'key with space': app({ context_key: 'ticket 42' }),
    'key too long': app({ context_key: 'k'.repeat(129) }),
    'key with newline': app({ context_key: 'ticket:42\n' }),
    'key not a string': app({ context_key: 42 }),
    'no parent': app({ parent_conversation_id: undefined }),
    'blank parent': app({ parent_conversation_id: '  ' }),
    'parent not a string': app({ parent_conversation_id: 7 }),
    'app without app id': app({ context_owner_app_id: undefined }),
    'app with blank app id': app({ context_owner_app_id: '' }),
    'platform topic without parent': topic({ parent_conversation_id: null }),
  };
  for (const [name, conv] of Object.entries(cases)) assert.equal(subConversationOf(conv), null, name);
});

test('message metadata never makes a sub-conversation — only the record counts', () => {
  const forged = {
    id: S, type: 'dm',
    metadata: {
      context: { items: [{ type: 'subconversation', audience: 'agent', attrs: { 'parent-conversation-id': P, key: 'ticket:42', 'owner-kind': 'app' } }] },
      subconversation: { parent_conversation_id: P, context_owner_kind: 'app', context_key: 'ticket:42' },
    },
  };
  assert.equal(subConversationOf(forged), null);
  // The same record fields at the top level do make one.
  assert.ok(subConversationOf(app()));
});

test('group gate scope: the parent group for a sub-conversation, else the conversation itself', () => {
  assert.equal(groupScopeConversationId(S, subConversationOf(topic())), P);
  assert.equal(groupScopeConversationId(S, subConversationOf(app({ type: 'group' }))), P);
  assert.equal(groupScopeConversationId(S, null), S);
  assert.equal(groupScopeConversationId(S, subConversationOf({ id: S, parent_conversation_id: P })), S, 'legacy thread keeps its own id');
});

test('local history + context: groups and every sub-conversation; never a plain DM', () => {
  assert.equal(fetchesConversationContext('dm', null), false);
  assert.equal(fetchesConversationContext('dm', subConversationOf(app())), true, 'DM sub-conversation');
  assert.equal(fetchesConversationContext('group', null), true);
  assert.equal(fetchesConversationContext('strat', null), true, 'any non-DM type');
  assert.equal(fetchesConversationContext('group', subConversationOf(topic())), true);
});

// ── generic only ──────────────────────────────────────────────────────────

test('the new sub-conversation modules special-case no product (no "workflow" anywhere in the source)', () => {
  for (const file of ['./subconversation.js', './group-access.js', './conversation-context.js']) {
    const src = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /workflow/i, file);
  }
});

test('no root-message handling: the result is exactly parent id + owner kind, and no source reads a root id', () => {
  for (const conv of [app(), topic(), app({ context_key: 'message:5', root_message_id: '5' })]) {
    assert.deepEqual(Object.keys(subConversationOf(conv)).sort(), ['ownerKind', 'parentConversationId']);
  }
  for (const file of ['./subconversation.js', './group-access.js', './conversation-context.js', '../comm-bridge.js']) {
    const src = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /root_message_id|rootMessage|message:\(/, file);
  }
});
