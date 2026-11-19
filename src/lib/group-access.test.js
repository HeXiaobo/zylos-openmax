import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decideGroupAccess,
  NOTICE_GROUP_DISABLED,
  NOTICE_GROUP_NOT_ALLOWED,
  NOTICE_GROUP_SENDER_NOT_ALLOWED,
} from './group-access.js';
import { subConversationOf } from './subconversation.js';

// A group sub-conversation / topic is gated exactly as a message in its
// parent group (groups[parent]: allowlist, mode, allowFrom, notices). Ordinary
// groups keep their own entry, as before.

const P = '019f7000-0000-7000-8000-00000000000a';
const S = '019f7000-0000-7000-8000-00000000000b';
const OWNER = 'm-owner';
const ALICE = 'm-alice';
const BOB = 'm-bob';

const TOPIC = subConversationOf({
  id: S, type: 'group', parent_conversation_id: P, context_owner_kind: 'platform', context_key: 'message:17950',
});
const APP_IN_GROUP = subConversationOf({
  id: S, type: 'group', parent_conversation_id: P, context_owner_kind: 'app', context_owner_app_id: 'app-1', context_key: 'ticket:42',
});

function decide({ groups = {}, groupPolicy, sub = TOPIC, senderId = ALICE, mentioned = false, addressed = false, conversationId = S } = {}) {
  return decideGroupAccess({
    access: { groupPolicy, groups },
    conversationId,
    sub,
    senderId,
    mentioned,
    addressed,
    senderIsOwner: senderId === OWNER,
  });
}

for (const [label, sub] of [['platform topic', TOPIC], ['app sub-conversation', APP_IN_GROUP]]) {
  test(`${label}: parent in groups{} (mention mode) + @ → handled with the parent's config`, () => {
    const parentCfg = { mode: 'mention', name: 'Product' };
    const d = decide({ sub, groups: { [P]: parentCfg }, mentioned: true });
    assert.equal(d.handle, true);
    assert.equal(d.mode, 'mention');
    assert.equal(d.mentioned, true);
    assert.equal(d.groupCfg, parentCfg, 'groupCfg (and so the group name) is the parent\'s');
  });

  test(`${label}: parent mention mode, not @-ed → dropped, no notice`, () => {
    const d = decide({ sub, groups: { [P]: { mode: 'mention' } } });
    assert.equal(d.handle, false);
    assert.equal(d.reason, 'group:mention (not @-ed)');
    assert.equal(d.userNotice, undefined);
  });

  test(`${label}: parent smart mode, not @-ed → handled as smart (the smart-mode hint applies)`, () => {
    const d = decide({ sub, groups: { [P]: { mode: 'smart' } } });
    assert.equal(d.handle, true);
    assert.equal(d.mode, 'smart');
    assert.equal(d.mentioned, false);
  });

  test(`${label}: parent not in groups{} but the sub-conversation is → not handled; @ gets the parent's refusal`, () => {
    const quiet = decide({ sub, groups: { [S]: { mode: 'smart' } } });
    assert.equal(quiet.handle, false);
    assert.equal(quiet.userNotice, undefined);
    assert.equal(quiet.reason, `group:allowlist (${P} (parent of ${S}) not in groups{})`);
    const atted = decide({ sub, groups: { [S]: { mode: 'smart' } }, mentioned: true });
    assert.equal(atted.handle, false);
    assert.equal(atted.userNotice, NOTICE_GROUP_NOT_ALLOWED, '@-ed but not allowed → the reject reply uses the parent decision');
  });

  test(`${label}: the parent's allowFrom applies; the sub-conversation's own entry is ignored`, () => {
    const groups = { [P]: { mode: 'smart', allowFrom: [BOB] }, [S]: { mode: 'smart', allowFrom: ['*'] } };
    const d = decide({ sub, groups, senderId: ALICE, mentioned: true });
    assert.equal(d.handle, false);
    assert.equal(d.userNotice, NOTICE_GROUP_SENDER_NOT_ALLOWED);
    assert.match(d.reason, new RegExp(`not allowed in ${P} \\(parent of ${S}\\)`));
    assert.equal(decide({ sub, groups, senderId: BOB }).handle, true);
    assert.equal(decide({ sub, groups, senderId: OWNER }).handle, true, 'owner exempt from allowFrom');
  });

  test(`${label}: owner @ bypasses the allowlist, as in the parent group`, () => {
    const d = decide({ sub, groups: {}, senderId: OWNER, mentioned: true });
    assert.equal(d.handle, true);
    assert.match(d.reason, /\[owner-mention-bypass\]$/);
    assert.equal(decide({ sub, groups: {}, senderId: OWNER }).handle, false, 'owner without @ is not');
  });

  test(`${label}: groupPolicy disabled / open behave as in the parent group`, () => {
    const disabled = decide({ sub, groupPolicy: 'disabled', groups: { [P]: { mode: 'smart' } }, mentioned: true });
    assert.equal(disabled.handle, false);
    assert.equal(disabled.userNotice, NOTICE_GROUP_DISABLED);
    assert.equal(decide({ sub, groupPolicy: 'open', mentioned: true }).handle, true);
    assert.equal(decide({ sub, groupPolicy: 'open' }).handle, false, 'open + default mention mode needs an @');
  });
}

test('an app sub-conversation in a mention-mode group: a message without an @ is not addressed to the Agent', () => {
  const d = decide({ sub: APP_IN_GROUP, groups: { [P]: { mode: 'mention' } } });
  assert.equal(d.handle, false);
  assert.equal(d.reason, 'group:mention (not @-ed)');
  assert.equal(d.userNotice, undefined);
  // In a smart-mode parent it is handled, but still as not @-ed (smart-mode hint).
  const smart = decide({ sub: APP_IN_GROUP, groups: { [P]: { mode: 'smart' } } });
  assert.equal(smart.handle, true);
  assert.equal(smart.mentioned, false);
});

test('ordinary group: its own entry, unchanged decisions and reasons', () => {
  const cfg = { mode: 'mention' };
  assert.deepEqual(decide({ sub: null, conversationId: P, groups: { [P]: cfg }, mentioned: true }), {
    handle: true, reason: 'group:allowlist/mention', mode: 'mention', mentioned: true, groupCfg: cfg,
  });
  assert.deepEqual(decide({ sub: null, conversationId: P, groups: {} , mentioned: true }), {
    handle: false, reason: `group:allowlist (${P} not in groups{})`, userNotice: NOTICE_GROUP_NOT_ALLOWED,
  });
  assert.deepEqual(decide({ sub: null, conversationId: P, groups: { [P]: { allowFrom: [BOB] } }, mentioned: true }), {
    handle: false, reason: `group:allowFrom (sender ${ALICE} not allowed in ${P})`, userNotice: NOTICE_GROUP_SENDER_NOT_ALLOWED,
  });
  // A legacy thread (parent only) keeps its own id.
  const legacy = subConversationOf({ id: S, type: 'group', parent_conversation_id: P });
  assert.equal(decide({ sub: legacy, groups: { [P]: { mode: 'smart' } } }).handle, false);
  assert.equal(decide({ sub: legacy, groups: { [S]: { mode: 'smart' } } }).handle, true);
});

test('edit / recall events of a topic follow the parent gate (no mentions on the synthetic message)', () => {
  // handleSystemEvent builds a message without mentions and calls the same
  // shouldHandleMessage → decideGroupAccess with the conversation record.
  assert.equal(decide({ groups: { [P]: { mode: 'mention' } } }).handle, false);
  assert.equal(decide({ groups: { [P]: { mode: 'smart' } } }).handle, true);
  assert.equal(decide({ groups: { [S]: { mode: 'smart' } } }).handle, false);
});

// A group topic message addressed to this agent without an @ (the server's
// addressed_member_ids): an @ in mention mode, nothing new in smart mode.

test('mention mode: a message addressed to this agent is handled as @-ed', () => {
  const d = decide({ groups: { [P]: { mode: 'mention' } }, addressed: true });
  assert.equal(d.handle, true);
  assert.equal(d.mentioned, true, 'treated as an @ downstream (run, attachments)');
});

test('mention mode: an addressed message from a sender outside allowFrom is dropped without a refusal', () => {
  const d = decide({ groups: { [P]: { mode: 'mention', allowFrom: [BOB] } }, senderId: ALICE, addressed: true });
  assert.equal(d.handle, false);
  assert.equal(d.userNotice, undefined, 'only an explicit @ earns a refusal');
});

test('mention mode: a message not addressed to this agent is still dropped', () => {
  const d = decide({ groups: { [P]: { mode: 'mention' } }, addressed: false });
  assert.equal(d.handle, false);
  assert.equal(d.reason, 'group:mention (not @-ed)');
});

test('smart mode: being addressed changes nothing (the smart-mode hint still applies)', () => {
  const d = decide({ groups: { [P]: { mode: 'smart' } }, addressed: true });
  assert.equal(d.handle, true);
  assert.equal(d.mentioned, false);
});

// ── bridge wiring ────────────────────────────────────────────────────────────

const BRIDGE = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');

test('comm-bridge: the group branch is decideGroupAccess with the sub-conversation from the record', () => {
  assert.match(BRIDGE, /return decideGroupAccess\(\{[\s\S]*?sub: subConversationOf\(conv\),[\s\S]*?\}\);/);
  assert.doesNotMatch(BRIDGE, /const NOTICE_GROUP_/, 'the group notices live in group-access.js only');
});

test('comm-bridge: the group branch passes whether the message is addressed to this agent', () => {
  assert.match(BRIDGE, /addressed: isSelfAddressed\(\{\s*addressedIds: msg\.addressed_member_ids \|\| msg\.message\?\.addressed_member_ids,\s*selfMemberId,\s*\}\),/);
});

test('comm-bridge: edit / recall events go through shouldHandleMessage with the conversation record', () => {
  assert.match(BRIDGE, /const decision = await shouldHandleMessage\(syntheticMsg, conv \|\| \{\}, orgConfig\);/);
});

test('comm-bridge: a drop\'s refusal is the decision\'s notice, posted in the conversation the message came from', () => {
  assert.match(BRIDGE, /sendRejectNotice\(orgConfig, msg, decision\.userNotice\)/);
  assert.match(BRIDGE, /apiPath\(`\/conversations\/\$\{msg\.conversation_id\}\/messages`\)/);
});
