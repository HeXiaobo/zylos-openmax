/**
 * Session-group naming for multi-session zylos-core: the inbound
 * `--session-group` and `scripts/session-group.js` must give the same name for
 * the same conversation, nothing is guessed, and every name Core receives
 * passes Core's own check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// conv-org.js resolves its file from HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-session-group-test-'));
process.env.HOME = tmpHome;
const {
  sessionGroupFromEndpoint, resolveSessionGroup, endpointKindOf, endpointKindOfRecord, endpointOf, endpointOfRecord,
  isValidSessionGroup, SESSION_GROUP_MAX_LENGTH,
} = await import('./session-group.js');
const { convRecordFields, registerConvOrg, lookupConvRecord } = await import('./conv-org.js');
const { formatEndpoint, parseEndpoint } = await import('./message.js');
const { replyConversationOf } = await import('./activity/index.js');
const { subConversationOf } = await import('./subconversation.js');

// Core's own rule (core c4-session-group.js), copied, so a drift shows up here.
const CORE_GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

const D = '019f6a84-3a1e-76dd-931d-0eea1cb3112a';
const G = '01a18649-b095-7add-bfa6-9b405ec30433';
const S = '019f0000-aaaa-7bbb-8ccc-000000000abc';
const MSG = '7300000000000000132';

test('T1: dm / group / sub endpoints map to dm-<id> / group-<id> / sub-<id>; msg / reply / unknown segments take no part', () => {
  const cases = [
    [`${D}|type:dm|msg:${MSG}`, `dm-${D}`],
    [`${G}|type:group|msg:${MSG}`, `group-${G}`],
    [`${G}|type:group|reply:7300000000000000001|msg:${MSG}`, `group-${G}`],
    [`${S}|type:sub|msg:${MSG}`, `sub-${S}`],
    [`${G}|type:group|foo:bar|msg:1`, `group-${G}`],
    [`${D}|type:dm`, `dm-${D}`],
  ];
  for (const [endpoint, want] of cases) {
    const got = sessionGroupFromEndpoint(endpoint);
    assert.equal(got, want, endpoint);
    assert.match(got, CORE_GROUP_RE);
    assert.ok(got.length <= 95);
  }
  // Two messages of one conversation, differing only in msg: one group.
  assert.equal(sessionGroupFromEndpoint(`${G}|type:group|msg:1`), sessionGroupFromEndpoint(`${G}|type:group|msg:2`));
});

test('T1: a receipt endpoint (card conversation + card message) names the card conversation', () => {
  const endpoint = formatEndpoint({ conversationId: G, endpointType: 'group', sourceMessageId: MSG });
  assert.equal(endpoint, `${G}|type:group|msg:${MSG}`);
  assert.equal(sessionGroupFromEndpoint(endpoint), `group-${G}`);
});

test('T1: refused — no type, unknown type, bad id characters, leading "-", too long', () => {
  const bad = [
    `${D}|msg:1`,                        // no type: never guessed
    `${D}|type:|msg:1`,                  // empty type
    `${D}|type:thread`,                  // the removed thread kind
    `${D}|type:strat`,
    `${D}|type:DM`,                      // case matters: the bridge writes lower case
    'a.b|type:dm',
    'a:b|type:dm',
    'a/b|type:dm',
    'a b|type:dm',
    '-abc|type:dm',
    `${'a'.repeat(SESSION_GROUP_MAX_LENGTH)}|type:dm`,
  ];
  for (const endpoint of bad) {
    assert.throws(() => sessionGroupFromEndpoint(endpoint), Error, endpoint);
  }
  assert.equal(isValidSessionGroup('x'.repeat(95)), true);
  assert.equal(isValidSessionGroup('x'.repeat(96)), false);
});

test('T2: endpointKindOf — sub-conversation first (platform -> dm-/group-topic, app or other -> sub), DM / GROUP any case, everything else null', () => {
  const rec = (o) => endpointKindOfRecord(o);
  assert.equal(rec({ type: 'DM' }), 'dm');
  assert.equal(rec({ type: 'dm' }), 'dm');
  assert.equal(rec({ type: 'GROUP' }), 'group');
  assert.equal(rec({ type: 'Group' }), 'group');
  // A sub-conversation inherits its parent's type; the owner kind decides first.
  assert.equal(rec({ type: 'DM', context_owner_kind: 'platform', context_key: 'message:1', parent_conversation_id: D }), 'dm-topic');
  assert.equal(rec({ type: 'GROUP', context_owner_kind: 'platform', context_key: 'message:1', parent_conversation_id: G }), 'group-topic');
  // A platform topic whose inherited type is neither DM nor GROUP: no group.
  assert.equal(rec({ type: 'STRAT', context_owner_kind: 'platform', context_key: 'message:1', parent_conversation_id: G }), null);
  assert.equal(rec({ type: 'GROUP', context_owner_kind: 'app', context_key: 'ticket:42', context_owner_app_id: 'app1', parent_conversation_id: G }), 'sub');
  // A new owner kind the access check does not know: still its own sub group.
  const unknownKind = { type: 'GROUP', context_owner_kind: 'workflow', parent_conversation_id: G };
  assert.equal(rec(unknownKind), 'sub');
  assert.equal(subConversationOf(unknownKind), null, 'access control keeps its whitelist');
  // Owner kind but no parent: refused.
  assert.equal(rec({ type: 'GROUP', context_owner_kind: 'app' }), null);
  for (const type of ['STRAT', 'BROADCAST', 'BRIDGE', '', 'THREAD']) {
    assert.equal(rec({ type }), null, type);
  }
  assert.equal(rec(null), null);
  assert.equal(endpointKindOf(null), null);
});

const T = '01a20000-1111-7222-8333-000000000444';

test('topic: a platform topic is named after its parent — group-<G>:topic-<T> / dm-<D>:topic-<T>', () => {
  const cases = [
    [`${T}|type:group-topic|of:${G}|msg:${MSG}`, `group-${G}:topic-${T}`],
    [`${T}|type:dm-topic|of:${D}|msg:${MSG}`, `dm-${D}:topic-${T}`],
    [`${T}|type:group-topic|of:${G}`, `group-${G}:topic-${T}`],
    [`${T}|type:group-topic|of:${G}|reply:1|msg:2`, `group-${G}:topic-${T}`],
  ];
  for (const [endpoint, want] of cases) {
    const got = sessionGroupFromEndpoint(endpoint);
    assert.equal(got, want, endpoint);
    assert.match(got, CORE_GROUP_RE);
    assert.ok(got.length <= 95, `${got.length}`);
  }
  // Two UUIDs is the longest name: 85 characters.
  assert.equal(sessionGroupFromEndpoint(`${T}|type:group-topic|of:${G}`).length, 85);
});

test('topic: refused — no or bad parent, a parent on a non-topic endpoint, the legacy parent: key', () => {
  const bad = [
    `${T}|type:group-topic|msg:1`,          // no parent: never guessed
    `${T}|type:dm-topic`,
    `${T}|type:group-topic|of:a:b`,         // parent id with a colon
    `${T}|type:group-topic|of:-x`,
    `${G}|type:group|of:${D}`,              // of: only on a topic
    `${S}|type:sub|of:${G}`,
    `${T}|type:topic|of:${G}`,              // no bare topic kind
  ];
  for (const endpoint of bad) {
    assert.throws(() => sessionGroupFromEndpoint(endpoint), Error, endpoint);
  }
  // parent: stays the legacy thread marker, not the topic parent.
  const legacy = parseEndpoint(`${T}|type:group-topic|parent:${G}`);
  assert.equal(legacy.parentConversationId, undefined);
  assert.equal(legacy.legacyThread, true);
});

test('topic: the bridge endpoint round-trips — record -> endpointOf -> formatEndpoint -> name', () => {
  const groupTopic = { id: T, type: 'GROUP', context_owner_kind: 'platform', context_key: 'message:7', parent_conversation_id: G };
  const dmTopic = { id: T, type: 'DM', context_owner_kind: 'platform', context_key: 'message:8', parent_conversation_id: D };
  const app = { id: S, type: 'GROUP', context_owner_kind: 'app', context_key: 'wf:9', context_owner_app_id: 'a1', parent_conversation_id: G };
  assert.deepEqual(endpointOfRecord(groupTopic), { endpointType: 'group-topic', parentConversationId: G });
  assert.deepEqual(endpointOfRecord(dmTopic), { endpointType: 'dm-topic', parentConversationId: D });
  assert.deepEqual(endpointOfRecord(app), { endpointType: 'sub' });
  assert.deepEqual(endpointOfRecord({ id: G, type: 'GROUP' }), { endpointType: 'group' });
  assert.equal(endpointOfRecord({ id: G, type: 'STRAT' }), null);
  assert.equal(endpointOf(null), null);

  const ep = formatEndpoint({ conversationId: T, ...endpointOfRecord(groupTopic), sourceMessageId: MSG });
  assert.equal(ep, `${T}|type:group-topic|of:${G}|msg:${MSG}`);
  assert.equal(parseEndpoint(ep).conversationId, T, 'replies still go to the topic itself');
  assert.equal(sessionGroupFromEndpoint(ep), `group-${G}:topic-${T}`);
  assert.equal(sessionGroupFromEndpoint(formatEndpoint({ conversationId: T, ...endpointOfRecord(dmTopic) })), `dm-${D}:topic-${T}`);
  // App sub-conversations keep sub-<S>.
  assert.equal(sessionGroupFromEndpoint(formatEndpoint({ conversationId: S, ...endpointOfRecord(app) })), `sub-${S}`);
  // Without a kind (old Core) the parent is not written either: byte-identical to before.
  assert.equal(formatEndpoint({ conversationId: T, parentConversationId: G, sourceMessageId: MSG }), `${T}|msg:${MSG}`);
});

test('topic: bare id — a stored topic answers from the file; an old entry without owner kind is looked up again', async () => {
  const stored = '01a20000-1111-7222-8333-0000000000c1';
  registerConvOrg(stored, 'org-1', convRecordFields({ type: 'GROUP', context_owner_kind: 'platform', context_key: 'message:1', parent_conversation_id: G }));
  assert.equal(await resolveSessionGroup(stored, { fetchConversation: noNetwork }), `group-${G}:topic-${stored}`);

  // Written by 2.36.x: sub without ownerKind. Not named from the file.
  const old = '01a20000-1111-7222-8333-0000000000c2';
  registerConvOrg(old, 'org-1', { type: 'DM', parentId: D, sub: true });
  assert.deepEqual(lookupConvRecord(old), { orgId: 'org-1', type: 'DM', parentId: D, sub: true });
  let calls = 0;
  const name = await resolveSessionGroup(old, {
    candidateOrgs: async () => ['org-1'],
    fetchConversation: async (orgId, id) => { calls += 1; return { id, type: 'DM', context_owner_kind: 'platform', context_key: 'message:2', parent_conversation_id: D }; },
  });
  assert.equal(name, `dm-${D}:topic-${old}`);
  assert.equal(calls, 1);
  assert.equal(lookupConvRecord(old).ownerKind, 'platform', 'the owner kind is written back');
  assert.equal(await resolveSessionGroup(old, { fetchConversation: noNetwork }), `dm-${D}:topic-${old}`);

  // An app sub-conversation stays sub-<S>.
  const app = '01a20000-1111-7222-8333-0000000000c3';
  registerConvOrg(app, 'org-1', convRecordFields({ type: 'GROUP', context_owner_kind: 'app', context_key: 'wf:3', context_owner_app_id: 'a1', parent_conversation_id: G }));
  assert.equal(await resolveSessionGroup(app, { fetchConversation: noNetwork }), `sub-${app}`);
});

const noNetwork = () => { throw new Error('must not look the conversation up'); };

test('T2: the same record read from the API and read back from the file gives the same kind', () => {
  const records = [
    { id: '01a18649-0000-7000-8000-000000000001', type: 'DM' },
    { id: '01a18649-0000-7000-8000-000000000002', type: 'GROUP' },
    { id: '01a18649-0000-7000-8000-000000000003', type: 'GROUP', context_owner_kind: 'platform', context_key: 'message:9', parent_conversation_id: G },
    { id: '01a18649-0000-7000-8000-000000000004', type: 'STRAT', parent_conversation_id: G },
  ];
  for (const r of records) {
    registerConvOrg(r.id, 'org-1', convRecordFields(r));
    assert.equal(endpointKindOf(lookupConvRecord(r.id)), endpointKindOfRecord(r), r.type);
  }
});

test('T6/T7: a typed endpoint reads no file and makes no request', async () => {
  const name = await resolveSessionGroup(`${G}|type:group|msg:1`, {
    lookupRecord: noNetwork, fetchConversation: noNetwork, candidateOrgs: noNetwork,
  });
  assert.equal(name, `group-${G}`);
});

test('T7: bare id — the stored type answers without a request', async () => {
  const id = '01a18649-0000-7000-8000-0000000000a1';
  registerConvOrg(id, 'org-1', { type: 'GROUP' });
  assert.equal(await resolveSessionGroup(id, { fetchConversation: noNetwork }), `group-${id}`);
});

test('T7: bare id — a miss goes to the API through the stored / candidate org, and is written back', async () => {
  const id = '01a18649-0000-7000-8000-0000000000a2';
  const calls = [];
  const name = await resolveSessionGroup(id, {
    candidateOrgs: async () => ['org-x', 'org-y'],
    fetchConversation: async (orgId, convId) => {
      calls.push(orgId);
      if (orgId === 'org-x') throw Object.assign(new Error('forbidden'), { status: 403 });
      return { id: convId, type: 'DM' };
    },
  });
  assert.equal(name, `dm-${id}`);
  assert.deepEqual(calls, ['org-x', 'org-y']);
  assert.deepEqual(lookupConvRecord(id), { orgId: 'org-y', type: 'DM' });
  // Next time: from the file.
  assert.equal(await resolveSessionGroup(id, { fetchConversation: noNetwork }), `dm-${id}`);
});

test('T7: bare id — an API failure, a timeout or a type without a group throws (exit 1 in the script), nothing stored', async () => {
  const id = '01a18649-0000-7000-8000-0000000000a3';
  await assert.rejects(resolveSessionGroup(id, {
    candidateOrgs: async () => ['org-1'],
    fetchConversation: async () => { throw new Error('ECONNREFUSED'); },
  }), /cannot look up conversation type/);
  assert.equal(lookupConvRecord(id), null);

  const started = Date.now();
  await assert.rejects(resolveSessionGroup(id, {
    candidateOrgs: async () => ['org-1', 'org-2', 'org-3'],
    fetchConversation: () => new Promise(() => {}),
    timeoutMs: 150,
  }), /timed out/);
  assert.ok(Date.now() - started < 1000, 'all orgs share one deadline');

  const strat = '01a18649-0000-7000-8000-0000000000a4';
  await assert.rejects(resolveSessionGroup(strat, {
    candidateOrgs: async () => ['org-1'],
    fetchConversation: async () => ({ id: strat, type: 'STRAT' }),
  }), /has no session group/);
});

test('Q15: a legacy [OPENMAX DM]/ prefix is not trusted — the conversation id is looked up', async () => {
  const id = '01a18649-0000-7000-8000-0000000000b1';
  registerConvOrg(id, 'org-1', { type: 'GROUP' });
  assert.equal(await resolveSessionGroup(`[OPENMAX DM]/${id}|msg:1`), `group-${id}`);
});

test('T11: a legacy thread endpoint resolves to its leading conversation, and is flagged', async () => {
  registerConvOrg(G, 'org-1', { type: 'GROUP' });
  const flagged = [];
  const onLegacyThread = (ep) => flagged.push(ep.conversationId);
  assert.equal(await resolveSessionGroup(`${G}|thread:${S}|parent:7|msg:${MSG}`, { onLegacyThread }), `group-${G}`);
  assert.equal(await resolveSessionGroup(`[OPENMAX THREAD]/${G}|thread:${S}`, { onLegacyThread }), `group-${G}`);
  assert.deepEqual(flagged, [G, G]);
});

test('T12: activity reply conversation is the same with and without |type:', () => {
  for (const ep of [`${G}|msg:1`, `${G}|type:group|msg:1`, G, `${G}|type:group|reply:5`]) {
    assert.equal(replyConversationOf(ep), G, ep);
    assert.equal(parseEndpoint(ep).conversationId, G);
  }
});
