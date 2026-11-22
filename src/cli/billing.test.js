import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './billing.js';
import {
  checkInitiator, DENIED_REPLY, EXTERNAL_REDIRECT_REPLY, OWNER_UNVERIFIABLE_REPLY, UNAVAILABLE_REPLY, SOURCE_MESSAGE_MAX_AGE_MS,
} from '../lib/billing-gate.js';
import { fetchSpend, resolveSpendRange, splitWindows, summarizePlanState, STATEMENT_WINDOW_MAX_MS } from '../lib/billing-query.js';
import { appendAudit, buildAuditRecord } from '../lib/billing-audit.js';

// OPENM-1375: read-only billing answers gated on the initiator's org role.

const ORG = '0193aaaa-0000-7000-8000-000000000001';
const CONV = '0193aaaa-0000-7000-8000-0000000000c1';
const MSG = '7300000000000000001';
const OWNER = '0193aaaa-0000-7000-8000-0000000000a1';
const ADMIN = '0193aaaa-0000-7000-8000-0000000000a2';
const MEMBER = '0193aaaa-0000-7000-8000-0000000000a3';
const AGENT = '0193aaaa-0000-7000-8000-0000000000b1';
const SELF = '0193aaaa-0000-7000-8000-0000000000b9';
const NOW = Date.parse('2026-11-19T08:00:00Z');

const member = (id, kind, slug, extra = {}) => ({ member_id: id, kind, status: 'active', display_name: `n-${id.slice(-2)}`, role: { slug, display_name: slug }, ...extra });
const MEMBERS = {
  [OWNER]: member(OWNER, 'human', 'org-owner'),
  [ADMIN]: member(ADMIN, 'human', 'org-admin'),
  [MEMBER]: member(MEMBER, 'human', 'org-member'),
  [AGENT]: member(AGENT, 'agent', 'org-admin'),
};

const PLAN_STATE = {
  subscription: { plan_code: 'pro', plan_name: 'Pro', status: 'active', billing_interval: 'month',
    current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z', auto_renew: true,
    next_charge_amount_cents: 9900, currency: 'cny', credential_id: 'cred-secret', can_manage_payment: true },
  current_payment_method: { brand: 'visa', last4: '4242' },
  usage_snapshot: { credit_balance: 31337, paid_balance: 27182, promo_balance: 5000, period_consumed_points: 1200,
    outstanding_points: 0, enforcement_suspended: false, agent_slots_used: 3, agent_slots_total: 5 },
  is_paid_plan: true,
};

/** Fake core: messages keyed by id, members, self owner, statement pages. */
function fakeCore({ messages = {}, members = MEMBERS, selfOwner = OWNER, statement = () => ({ consumptions: [], has_more: false }) } = {}) {
  const calls = [];
  const get = async (p, q) => {
    calls.push({ path: p, query: q });
    let m = /^\/conversations\/([^/]+)\/messages\/(\d+)$/.exec(p);
    if (m) {
      const msg = messages[m[2]];
      if (!msg) throw Object.assign(new Error('forbidden'), { status: 403 });
      return { message: msg };
    }
    m = /^\/members\/([^/]+)$/.exec(p);
    if (m) {
      if (m[1] === SELF) return member(SELF, 'agent', 'org-member', { owner_member_id: selfOwner });
      if (members[m[1]]) return members[m[1]];
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    if (p === '/billing/plan-state') return PLAN_STATE;
    if (p === '/billing/credit-statement') return statement(q);
    throw new Error(`unexpected ${p}`);
  };
  return { get, calls };
}

const msgFrom = (sender, senderType = 'HUMAN', extra = {}) => ({
  [MSG]: { id: 'm', org_id: ORG, conversation_id: CONV, sender_id: sender, sender_type: senderType,
    timestamp: new Date(NOW - 60_000).toISOString(), ...extra },
});

function deps(core, extra = {}) {
  const audits = [];
  return {
    d: { get: core.get, orgId: ORG, selfMemberId: async () => SELF, now: NOW, timeZone: 'Asia/Shanghai',
      creditPageUrl: 'https://core.example/workspace/account?tab=credit', audit: (r) => audits.push(r), ...extra },
    audits,
  };
}

const wsRef = { conversationId: CONV, messageId: MSG };
const billingCalls = (core) => core.calls.filter((c) => c.path.startsWith('/billing/'));

// ---- Workspace initiator ----------------------------------------------------

for (const [who, id, role] of [['owner', OWNER, 'org-owner'], ['admin', ADMIN, 'org-admin']]) {
  test(`workspace: ${who} gets the overview`, async () => {
    const core = fakeCore({ messages: msgFrom(id) });
    const { d, audits } = deps(core);
    const out = await runCommand('billing.overview', wsRef, d);
    assert.equal(out.allowed, true);
    assert.deepEqual(out.initiator, { source: 'workspace', role, member_id: id, name: MEMBERS[id].display_name });
    assert.equal(out.credits.credit_balance, 31337);
    assert.equal(out.plan.plan_name, 'Pro');
    assert.equal(out.plan.current_period_end, '2026-12-01T00:00:00Z');
    assert.equal(out.credit_page_url, 'https://core.example/workspace/account?tab=credit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].allowed, true);
    assert.equal(audits[0].initiator_member_id, id);
    assert.equal(audits[0].role, role);
  });
}

test('overview never returns payment credentials or capability flags', () => {
  const s = JSON.stringify(summarizePlanState(PLAN_STATE));
  for (const leak of ['cred-secret', '4242', 'can_manage_payment', 'credential_id']) assert.equal(s.includes(leak), false, leak);
});

test('workspace: ordinary member is denied with the fixed reply and no billing call', async () => {
  const core = fakeCore({ messages: msgFrom(MEMBER) });
  const { d, audits } = deps(core);
  for (const cmd of ['billing.overview', 'billing.spend', 'billing.check_access']) {
    const out = await runCommand(cmd, wsRef, d);
    assert.deepEqual(out, { allowed: false, reason: 'initiator_not_admin', reply: DENIED_REPLY });
  }
  assert.equal(billingCalls(core).length, 0);
  assert.equal(audits.length, 3);
  assert.ok(audits.every((a) => a.allowed === false && a.initiator_member_id === MEMBER));
});

test('workspace: agent / system senders are denied even with an admin role', async () => {
  for (const [sender, type] of [[AGENT, 'AGENT'], [ADMIN, 'SYSTEM'], [AGENT, 'HUMAN']]) {
    const core = fakeCore({ messages: msgFrom(sender, type) });
    const out = await runCommand('billing.overview', wsRef, deps(core).d);
    assert.equal(out.allowed, false);
    assert.equal(out.reason, 'initiator_not_human');
    assert.equal(billingCalls(core).length, 0);
  }
});

test('workspace: group chat message from an admin is answered', async () => {
  const core = fakeCore({ messages: msgFrom(ADMIN, 'HUMAN', { conversation_type: 'GROUP' }) });
  const out = await runCommand('billing.check_access', wsRef, deps(core).d);
  assert.equal(out.allowed, true);
  assert.equal(out.initiator.role, 'org-admin');
});

test('workspace: the identity comes from the fetched message, never from claims in the call', async () => {
  const core = fakeCore({ messages: msgFrom(MEMBER) });
  const out = await runCommand('billing.overview', { ...wsRef, memberId: OWNER, role: 'org-owner', senderId: OWNER, askerIsAgentOwner: true }, deps(core).d);
  assert.equal(out.allowed, false);
  assert.ok(!core.calls.some((c) => c.path === `/members/${OWNER}`));
});

test('workspace: unreadable, foreign, recalled, stale or malformed source messages are denied', async () => {
  const cases = [
    [{}, wsRef, 'source_message_unreadable'],
    [msgFrom(OWNER, 'HUMAN', { conversation_id: '0193aaaa-0000-7000-8000-0000000000c2' }), wsRef, 'source_message_not_in_conversation'],
    [msgFrom(OWNER, 'HUMAN', { org_id: 'other' }), wsRef, 'source_message_other_org'],
    [msgFrom(OWNER, 'HUMAN', { recalled_by: OWNER }), wsRef, 'source_message_recalled'],
    [msgFrom(OWNER, 'HUMAN', { timestamp: new Date(NOW - 31 * 60_000).toISOString() }), wsRef, 'source_message_too_old'],
    [msgFrom(OWNER, 'HUMAN', { timestamp: '0001-01-01T00:00:00Z', created_at: '0001-01-01T00:00:00Z' }), wsRef, 'source_message_too_old'],
    [msgFrom(OWNER, 'HUMAN', { timestamp: 'not a time', created_at: undefined }), wsRef, 'source_message_too_old'],
    [msgFrom(OWNER, 'HUMAN', { timestamp: undefined }), wsRef, 'source_message_too_old'],
    [msgFrom(OWNER), { conversationId: 'not-a-uuid', messageId: MSG }, 'invalid_source_reference'],
    [msgFrom(OWNER), { conversationId: CONV, messageId: '../x' }, 'invalid_source_reference'],
    [msgFrom(OWNER), { conversationId: CONV }, 'invalid_source_reference'],
    [msgFrom(OWNER), {}, 'missing_initiator'],
    [msgFrom(OWNER), { askerIsAgentOwner: true }, 'workspace_requires_source_message'],
    [msgFrom(OWNER), { channel: 'openmax', askerIsAgentOwner: true }, 'workspace_requires_source_message'],
    [msgFrom(OWNER), { ...wsRef, channel: 'lark' }, 'ambiguous_initiator'],
  ];
  for (const [messages, params, reason] of cases) {
    const core = fakeCore({ messages });
    const out = await runCommand('billing.overview', params, deps(core).d);
    assert.equal(out.allowed, false, reason);
    assert.equal(out.reason, reason);
    assert.equal(billingCalls(core).length, 0);
  }
});

test('workspace: the source message window is 30 minutes (29 min allowed, 31 min denied)', async () => {
  assert.equal(SOURCE_MESSAGE_MAX_AGE_MS, 30 * 60 * 1000);
  const ok = await checkInitiator(wsRef, { get: fakeCore({ messages: msgFrom(OWNER, 'HUMAN', { timestamp: new Date(NOW - 29 * 60_000).toISOString() }) }).get, orgId: ORG, now: NOW });
  assert.equal(ok.allowed, true);
  const old = await checkInitiator(wsRef, { get: fakeCore({ messages: msgFrom(OWNER, 'HUMAN', { timestamp: new Date(NOW - 31 * 60_000).toISOString() }) }).get, orgId: ORG, now: NOW });
  assert.equal(old.reason, 'source_message_too_old');
});

test('transient errors deny as verification_unavailable with the status and a retry reply', async () => {
  const fail = (status) => Object.assign(new Error('upstream'), status ? { status } : {});
  const wrap = (core, failing, status) => async (p, q) => {
    if (failing(p)) throw fail(status);
    return core.get(p, q);
  };
  for (const [failing, status] of [
    [(p) => p.startsWith('/conversations/'), 503],
    [(p) => p.startsWith('/members/'), 503],
    [(p) => p.startsWith('/members/'), undefined],
    [(p) => p.startsWith('/members/'), 400],
  ]) {
    const core = fakeCore({ messages: msgFrom(OWNER) });
    const { d, audits } = deps(core, { get: wrap(core, failing, status) });
    const out = await runCommand('billing.overview', wsRef, d);
    assert.deepEqual(out, { allowed: false, reason: 'verification_unavailable', status: status ?? null, reply: UNAVAILABLE_REPLY });
    assert.equal(audits[0].error_status, status ?? null);
    assert.equal(billingCalls(core).length, 0);
  }
  // 403 / 404 stay definitive answers.
  const core = fakeCore({ messages: msgFrom(OWNER) });
  const out404 = await runCommand('billing.overview', wsRef, deps(core, { get: wrap(core, (p) => p.startsWith('/members/'), 404) }).d);
  assert.equal(out404.reason, 'member_not_found');
  assert.equal(out404.reply, DENIED_REPLY);
  const out403 = await runCommand('billing.overview', wsRef, deps(core, { get: wrap(core, (p) => p.startsWith('/conversations/'), 403) }).d);
  assert.equal(out403.reason, 'source_message_unreadable');
  assert.equal(out403.reply, DENIED_REPLY);
  // External channel: self / owner lookups failing transiently.
  for (const failing of [(p) => p === `/members/${SELF}`, (p) => p === `/members/${OWNER}`]) {
    const c = fakeCore();
    const out = await runCommand('billing.overview', larkDm, deps(c, { get: wrap(c, failing, 502), imOwner: imFixture() }).d);
    assert.equal(out.reason, 'verification_unavailable');
    assert.equal(out.status, 502);
    assert.equal(out.reply, UNAVAILABLE_REPLY);
  }
});

test('workspace: suspended / departed member and failed member lookup are denied', async () => {
  for (const members of [
    { ...MEMBERS, [ADMIN]: member(ADMIN, 'human', 'org-admin', { status: 'suspended' }) },
    { [OWNER]: MEMBERS[OWNER] },
  ]) {
    const out = await checkInitiator(wsRef, { get: fakeCore({ messages: msgFrom(ADMIN), members }).get, orgId: ORG, now: NOW });
    assert.equal(out.allowed, false);
  }
});

// ---- External IM channels (d159 option B: owner DM only, ownerdm.go rules) --

const LARK_OWNER = { bound: true, user_id: 'u_owner', open_id: 'ou_owner' };
const LARK_DM_EP = 'oc_dm1|type:p2p|msg:om_own1';
const LARK_GROUP_EP = 'oc_grp1|type:group|root:om_r|msg:om_own2';
const LARK_OTHER_DM_EP = 'oc_dm2|type:p2p|msg:om_oth1';
const c4At = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19); // SQLite CURRENT_TIMESTAMP form

/** Component dir with lark / telegram / discord / wechat owner bindings + logs. */
function componentsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-im-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('lark/config.json', JSON.stringify({ owner: LARK_OWNER, dmPolicy: 'open' }));
  put('lark/logs/u_owner.log', [
    { message_id: 'om_own1', user_id: 'u_owner', open_id: 'ou_owner' },
    { message_id: 'om_own2', user_id: 'u_owner', open_id: 'ou_owner' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  put('lark/logs/u_other.log', `${JSON.stringify({ message_id: 'om_oth1', user_id: 'u_other', open_id: 'ou_other' })}\n`);
  put('telegram/config.json', JSON.stringify({ owner: { chat_id: 4242, bound: true } }));
  put('discord/config.json', JSON.stringify({ owner: '777' }));
  put('discord/logs/dm/D1.jsonl', `${JSON.stringify({ direction: 'in', messageId: '901', userId: '777' })}\n`);
  put('wechat/config.json', JSON.stringify({ dmPolicy: 'allowlist', dmAllowFrom: ['wx_allow'] }));
  put('wechat/accounts/acc1.runtime.json', JSON.stringify({ userId: 'wx_scanner' }));
  put('wechat/accounts/acc1.json', '{}');
  put('wechat/accounts/acc2.runtime.json', JSON.stringify({ userId: 'wx_scanner2' })); // no acc2.json: removed account
  // normalizedAccountId ≠ account: runtime not usable → allowlist rule, never this scanner
  put('wechat/accounts/acc3.runtime.json', JSON.stringify({ userId: 'wx_scanner3', normalizedAccountId: 'other' }));
  put('wechat/accounts/acc3.json', '{}');
  return dir;
}
const COMPONENTS = componentsFixture();
process.on('exit', () => fs.rmSync(COMPONENTS, { recursive: true, force: true }));

/** imOwner dependency: C4 inbound rows (newest first) + the fixture components dir. */
function imFixture(rows, { reads } = {}) {
  const fresh = c4At(NOW - 60_000);
  const list = rows ?? [LARK_DM_EP, LARK_GROUP_EP, LARK_OTHER_DM_EP].map((e, i) => ({ id: 100 - i, channel: 'lark', endpoint_id: e, timestamp: fresh, content: 'hi' }));
  return { componentsDir: COMPONENTS, readRows: async () => { if (reads) reads.n += 1; return list; } };
}
const larkDm = { channel: 'lark', endpoint: LARK_DM_EP };

test('external reply is exactly the d159 text, bilingual like the other fixed replies', () => {
  assert.equal(EXTERNAL_REDIRECT_REPLY,
    '这类信息请到 Workspace 里问我，或找组织管理员\nFor this information, please ask me in Workspace, or ask an org admin.');
  assert.equal(EXTERNAL_REDIRECT_REPLY.split('\n')[0], '这类信息请到 Workspace 里问我，或找组织管理员');
  assert.notEqual(EXTERNAL_REDIRECT_REPLY, DENIED_REPLY);
});

test('lark: bound owner in a private chat + Workspace owner is Owner/admin → answered', async () => {
  for (const selfOwner of [OWNER, ADMIN]) {
    const core = fakeCore({ selfOwner });
    const { d, audits } = deps(core, { imOwner: imFixture() });
    const out = await runCommand('billing.overview', larkDm, d);
    assert.equal(out.allowed, true);
    assert.equal(out.credits.credit_balance, 31337);
    assert.deepEqual(out.initiator, { source: 'channel', role: MEMBERS[selfOwner].role.slug, member_id: selfOwner, name: MEMBERS[selfOwner].display_name, channel: 'lark' });
    assert.equal(audits[0].channel, 'lark');
    assert.equal(audits[0].private_chat, true);
    assert.equal(audits[0].asker_is_agent_owner, true);
  }
});

test('lark: the owner asking in a GROUP gets the fixed redirect reply, no request of any kind', async () => {
  const core = fakeCore();
  const reads = { n: 0 };
  const { d, audits } = deps(core, { imOwner: imFixture(undefined, { reads }) });
  for (const cmd of ['billing.overview', 'billing.spend', 'billing.check_access']) {
    const out = await runCommand(cmd, { channel: 'lark', endpoint: LARK_GROUP_EP }, d);
    assert.deepEqual(out, { allowed: false, reason: 'not_private_chat',
      reply: '这类信息请到 Workspace 里问我，或找组织管理员\nFor this information, please ask me in Workspace, or ask an org admin.' });
  }
  assert.equal(core.calls.length, 0);
  assert.equal(reads.n, 0);
  assert.ok(audits.every((a) => a.allowed === false && a.private_chat === false && a.reason === 'not_private_chat'));
});

test('lark: someone else in a private chat → redirect reply, no Core request', async () => {
  const core = fakeCore();
  const { d, audits } = deps(core, { imOwner: imFixture() });
  const out = await runCommand('billing.overview', { channel: 'lark', endpoint: LARK_OTHER_DM_EP }, d);
  assert.deepEqual(out, { allowed: false, reason: 'asker_not_agent_owner', reply: EXTERNAL_REDIRECT_REPLY });
  assert.equal(core.calls.length, 0);
  assert.equal(audits[0].asker_is_agent_owner, false);
  assert.equal(audits[0].private_chat, true);
});

// --- lark / feishu without the "get user ID" permission (owner proof fallback, owner_unverifiable) ---

const OWNER_UNVERIFIABLE_TEXT = '无法确认你是这个 Agent 的主人：飞书 / Lark 应用可能未开通获取用户 ID 权限，或主人绑定信息不完整。'
  + '可以先到 Workspace 里问我，或找组织管理员。\n'
  + "I can't confirm that you are this Agent's owner: the Feishu / Lark app may not have the permission to get user IDs, "
  + 'or the owner binding is incomplete. You can ask me in Workspace for now, or ask an org admin.';

/** components/<ch>/{config.json, logs/*} laid out like zylos-lark / zylos-feishu write them. */
function larkLikeComponents(ch, owner, logs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-larklike-'));
  fs.mkdirSync(path.join(dir, ch, 'logs'), { recursive: true });
  if (owner !== undefined) fs.writeFileSync(path.join(dir, ch, 'config.json'), JSON.stringify({ owner, dmPolicy: 'owner' }));
  for (const [name, entries] of Object.entries(logs)) {
    fs.writeFileSync(path.join(dir, ch, 'logs', name),
      typeof entries === 'string' ? entries : entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const larkLikeIo = (ch, componentsDir, endpoints, ageMs = 60_000) => ({
  componentsDir,
  readRows: async () => endpoints.map((e, i) => ({ id: 50 - i, channel: ch, endpoint_id: e, timestamp: c4At(NOW - ageMs), content: 'hi' })),
});
const NO_PERM_LOGS = {
  'null.log': [{ message_id: 'om_n1', open_id: 'ou_owner' }, { message_id: 'om_n2', open_id: 'ou_other' }],
  'undefined.log': [{ message_id: 'om_u1', open_id: 'ou_owner' }, { message_id: 'om_anon' }],
  'u_owner.log': [{ message_id: 'om_uid1', user_id: 'u_owner', open_id: 'ou_owner' }],
  'oc_grp9.log': [{ message_id: 'om_g1', user_id: 'u_owner', open_id: 'ou_owner' }],
};

test('owner_unverifiable reply is exact, bilingual, distinct from the other fixed replies', () => {
  assert.equal(OWNER_UNVERIFIABLE_REPLY, OWNER_UNVERIFIABLE_TEXT);
  for (const r of [EXTERNAL_REDIRECT_REPLY, DENIED_REPLY, UNAVAILABLE_REPLY]) assert.notEqual(OWNER_UNVERIFIABLE_REPLY, r);
});

test('lark/feishu: owner DM logged in null.log / undefined.log (no "get user ID" permission) → answered', async () => {
  for (const ch of ['lark', 'feishu']) {
    for (const owner of [{ bound: true, open_id: 'ou_owner' }, { bound: true, user_id: 'u_owner', open_id: 'ou_owner' }]) {
      const dir = larkLikeComponents(ch, owner, NO_PERM_LOGS);
      for (const m of ['om_n1', 'om_u1']) {
        const ep = `oc_dm9|type:p2p|msg:${m}`;
        const core = fakeCore();
        const out = await runCommand('billing.overview', { channel: ch, endpoint: ep }, deps(core, { imOwner: larkLikeIo(ch, dir, [ep]) }).d);
        assert.equal(out.allowed, true, `${ch} ${m} ${JSON.stringify(owner)}`);
        assert.equal(out.initiator.channel, ch);
      }
    }
  }
});

test('lark/feishu: owner bound open_id-only, DM now logged under the user_id → answered', async () => {
  for (const ch of ['lark', 'feishu']) {
    const dir = larkLikeComponents(ch, { bound: true, open_id: 'ou_owner' }, NO_PERM_LOGS);
    const ep = 'oc_dm9|type:p2p|msg:om_uid1';
    const out = await runCommand('billing.overview', { channel: ch, endpoint: ep }, deps(fakeCore(), { imOwner: larkLikeIo(ch, dir, [ep]) }).d);
    assert.equal(out.allowed, true, ch);
  }
});

test('lark/feishu fallback: group log, other sender, missing msg, stale row → still denied, no Core request', async () => {
  for (const ch of ['lark', 'feishu']) {
    const dir = larkLikeComponents(ch, { bound: true, open_id: 'ou_owner' }, NO_PERM_LOGS);
    for (const [ep, reason, ageMs] of [
      // msg of the owner that exists only in a group log, on a p2p-typed row
      ['oc_grp9|type:p2p|msg:om_g1', 'asker_not_agent_owner'],
      // the real group endpoint
      ['oc_grp9|type:group|msg:om_g1', 'not_private_chat'],
      ['oc_dm8|type:p2p|msg:om_n2', 'asker_not_agent_owner'],
      ['oc_dm8|type:p2p|msg:om_missing', 'asker_not_agent_owner'],
      ['oc_dm9|type:p2p|msg:om_n1', 'source_message_too_old', SOURCE_MESSAGE_MAX_AGE_MS + 60_000],
    ]) {
      const core = fakeCore();
      const out = await runCommand('billing.overview', { channel: ch, endpoint: ep },
        deps(core, { imOwner: larkLikeIo(ch, dir, [ep], ageMs) }).d);
      assert.deepEqual(out, { allowed: false, reason, reply: EXTERNAL_REDIRECT_REPLY }, `${ch} ${ep}`);
      assert.equal(core.calls.length, 0);
    }
  }
});

test('lark/feishu: usable binding + the asking entry has no sender id at all → owner_unverifiable', async () => {
  for (const ch of ['lark', 'feishu']) {
    for (const owner of [{ bound: true, open_id: 'ou_owner' }, { bound: true, user_id: 'u_owner' }, { bound: true, user_id: 'u_owner', open_id: 'ou_owner' }]) {
      const dir = larkLikeComponents(ch, owner, NO_PERM_LOGS);
      const ep = 'oc_dm9|type:p2p|msg:om_anon';
      const core = fakeCore();
      const { d, audits } = deps(core, { imOwner: larkLikeIo(ch, dir, [ep]) });
      const out = await runCommand('billing.spend', { channel: ch, endpoint: ep }, d);
      assert.deepEqual(out, { allowed: false, reason: 'owner_unverifiable', reply: OWNER_UNVERIFIABLE_TEXT }, `${ch} ${JSON.stringify(owner)}`);
      assert.equal(core.calls.length, 0);
      assert.equal(audits[0].reason, 'owner_unverifiable');
      assert.equal(audits[0].private_chat, true);
      assert.equal(audits[0].asker_is_agent_owner, false);
      assert.ok(!out.reply.includes('ou_owner') && !out.reply.includes('u_owner'));
    }
    // A group stays the d159 redirect.
    const dir = larkLikeComponents(ch, { bound: true, open_id: 'ou_owner' }, NO_PERM_LOGS);
    const gep = 'oc_grp9|type:group|msg:om_g1';
    const out = await runCommand('billing.overview', { channel: ch, endpoint: gep }, deps(fakeCore(), { imOwner: larkLikeIo(ch, dir, [gep]) }).d);
    assert.deepEqual(out, { allowed: false, reason: 'not_private_chat', reply: EXTERNAL_REDIRECT_REPLY });
  }
});

test('lark/feishu: strangers get the fixed reply, never owner_unverifiable (missing / incomplete binding, id-type mismatch)', async () => {
  for (const ch of ['lark', 'feishu']) {
    for (const [owner, m] of [
      [undefined, 'om_n2'], // no config.json, stranger's open_id-only entry
      [undefined, 'om_anon'],
      [{ bound: false, open_id: 'ou_owner' }, 'om_n1'],
      [{ bound: true }, 'om_n2'],
      [{ bound: true, user_id: '', open_id: '' }, 'om_anon'],
      // user_id-only binding, stranger's entry carries only an open_id
      [{ bound: true, user_id: 'u_owner' }, 'om_n2'],
    ]) {
      const dir = larkLikeComponents(ch, owner, NO_PERM_LOGS);
      const ep = `oc_dm8|type:p2p|msg:${m}`;
      const core = fakeCore();
      const out = await runCommand('billing.overview', { channel: ch, endpoint: ep }, deps(core, { imOwner: larkLikeIo(ch, dir, [ep]) }).d);
      assert.deepEqual(out, { allowed: false, reason: 'asker_not_agent_owner', reply: EXTERNAL_REDIRECT_REPLY }, `${ch} ${JSON.stringify(owner)} ${m}`);
      assert.equal(core.calls.length, 0);
    }
  }
});

test('lark/feishu: a stranger message in PM2 out.log / error.log with the owner ids is not the owner', async () => {
  for (const ch of ['lark', 'feishu']) {
    for (const name of ['out.log', 'error.log', 'out__2026-11-19_00-00-00.log', 'error-1.log']) {
      const dir = larkLikeComponents(ch, { bound: true, open_id: 'ou_owner' },
        { [name]: [{ message_id: 'om_pm2', user_id: 'u_owner', open_id: 'ou_owner' }] });
      const ep = 'oc_dm8|type:p2p|msg:om_pm2';
      const out = await runCommand('billing.overview', { channel: ch, endpoint: ep }, deps(fakeCore(), { imOwner: larkLikeIo(ch, dir, [ep]) }).d);
      assert.deepEqual(out, { allowed: false, reason: 'asker_not_agent_owner', reply: EXTERNAL_REDIRECT_REPLY }, `${ch} ${name}`);
    }
  }
});

test('external: missing / unrecognisable chat type is denied (a self-declared owner flag is ignored)', async () => {
  for (const [params, reason] of [
    [{ channel: 'lark' }, 'chat_type_unknown'],
    [{ channel: 'lark', askerIsAgentOwner: true }, 'chat_type_unknown'],
    [{ channel: 'lark', endpoint: '' }, 'chat_type_unknown'],
    [{ channel: 'lark', endpoint: 42 }, 'chat_type_unknown'],
    [{ channel: 'lark', endpoint: `${LARK_DM_EP}\nx` }, 'chat_type_unknown'],
    [{ channel: 'lark', endpoint: 'oc_dm1|msg:om_own1' }, 'not_private_chat'],
    [{ channel: 'lark', endpoint: 'oc_dm1|type:dm-pairing|type:p2p|msg:om_own1' }, 'not_private_chat'],
    [{ channel: 'lark', endpoint: 'oc_dm1|type:P2P|msg:om_own1' }, 'not_private_chat'],
    [{ channel: 'web-console', endpoint: 'console' }, 'not_private_chat'],
    [{ channel: 'unknownim', endpoint: 'x|type:p2p' }, 'not_private_chat'],
    // The retired self-declared flag never rescues a group endpoint or a non-owner DM.
    [{ channel: 'lark', endpoint: LARK_GROUP_EP, askerIsAgentOwner: true }, 'not_private_chat'],
    [{ channel: 'lark', endpoint: LARK_OTHER_DM_EP, askerIsAgentOwner: true }, 'asker_not_agent_owner'],
  ]) {
    const core = fakeCore();
    const out = await runCommand('billing.spend', params, deps(core, { imOwner: imFixture() }).d);
    assert.deepEqual(out, { allowed: false, reason, reply: EXTERNAL_REDIRECT_REPLY }, JSON.stringify(params));
    assert.equal(core.calls.length, 0);
  }
});

test('external: the endpoint must be a real inbound C4 row of that channel, ≤ 30 minutes old', async () => {
  const row = (extra) => [{ id: 1, channel: 'lark', endpoint_id: LARK_DM_EP, timestamp: c4At(NOW - 60_000), content: 'hi', ...extra }];
  for (const [rows, reason] of [
    [[{ id: 1, channel: 'lark', endpoint_id: LARK_OTHER_DM_EP, timestamp: c4At(NOW), content: 'x' }], 'source_message_not_found'],
    [row({ channel: 'feishu' }), 'source_message_not_found'],
    [row({ timestamp: c4At(NOW - SOURCE_MESSAGE_MAX_AGE_MS - 60_000) }), 'source_message_too_old'],
    [row({ timestamp: 'not a time' }), 'source_message_too_old'],
  ]) {
    const core = fakeCore();
    const out = await runCommand('billing.overview', larkDm, deps(core, { imOwner: imFixture(rows) }).d);
    assert.deepEqual(out, { allowed: false, reason, reply: EXTERNAL_REDIRECT_REPLY });
    assert.equal(core.calls.length, 0);
  }
  const ok = await runCommand('billing.check_access', larkDm,
    deps(fakeCore(), { imOwner: imFixture(row({ timestamp: c4At(NOW - SOURCE_MESSAGE_MAX_AGE_MS + 60_000) })) }).d);
  assert.equal(ok.allowed, true);
  // C4 unreadable (no rows at all, or the reader throws) → "check unavailable", not "you may not".
  for (const readRows of [async () => [], async () => { throw new Error('locked'); }]) {
    const out = await runCommand('billing.overview', larkDm, deps(fakeCore(), { imOwner: { componentsDir: COMPONENTS, readRows } }).d);
    assert.deepEqual(out, { allowed: false, reason: 'verification_unavailable', status: null, reply: UNAVAILABLE_REPLY });
  }
});

test('external: owner proof follows ownerdm.go per channel (telegram, discord, wechat)', async () => {
  const fresh = c4At(NOW - 60_000);
  const cases = [
    // telegram: positive chat id = DM, first segment must equal owner.chat_id
    ['telegram', '4242|msg:9', '', true, null],
    ['telegram', '-1004242|msg:9', '', false, 'not_private_chat'],
    ['telegram', '5151|msg:9', '', false, 'asker_not_agent_owner'],
    // discord: DM only by the C4 content prefix, then the dm log proves the sender
    ['discord', 'D1|msg:901', '[DISCORD DM] hi', true, null],
    ['discord', 'D1|msg:901', '[DISCORD] #general hi', false, 'not_private_chat'],
    ['discord', 'D1|msg:902', '[DISCORD DM] hi', false, 'asker_not_agent_owner'],
    // wechat: QR scanner rule wins when runtime.json is usable (allowlist then ignored)
    ['wechat', 'acc1|to:wx_scanner', '', true, null],
    ['wechat', 'acc1|to:wx_allow', '', false, 'asker_not_agent_owner'],
    ['wechat', 'acc2|to:wx_scanner2', '', false, 'asker_not_agent_owner'],
    // …else the single-user allowlist rule
    ['wechat', 'acc9|to:wx_allow', '', true, null],
    ['wechat', 'acc3|to:wx_allow', '', true, null],
    ['wechat', 'acc3|to:wx_scanner3', '', false, 'asker_not_agent_owner'],
    ['wechat', 'acc9', '', false, 'not_private_chat'],
  ];
  for (const [channel, endpoint, content, allowed, reason] of cases) {
    const imOwner = imFixture([{ id: 1, channel, endpoint_id: endpoint, timestamp: fresh, content }]);
    const out = await runCommand('billing.check_access', { channel, endpoint }, deps(fakeCore(), { imOwner }).d);
    assert.equal(out.allowed, allowed, `${channel} ${endpoint}`);
    if (!allowed) assert.deepEqual(out, { allowed: false, reason, reply: EXTERNAL_REDIRECT_REPLY }, `${channel} ${endpoint}`);
  }
});

test('external: owner DM but the Workspace side says no → the admin reply, not the redirect', async () => {
  for (const [params, selfOwner, reason] of [
    [larkDm, MEMBER, 'initiator_not_admin'],
    [larkDm, '', 'agent_owner_unknown'],
    [{ channel: 'Bad Channel!', endpoint: LARK_DM_EP }, OWNER, 'invalid_channel'],
    [{ channel: 'scheduler', endpoint: LARK_DM_EP }, OWNER, 'initiator_not_human'],
  ]) {
    const core = fakeCore({ selfOwner });
    const { d, audits } = deps(core, { imOwner: imFixture() });
    const out = await runCommand('billing.spend', params, d);
    assert.equal(out.allowed, false, reason);
    assert.equal(out.reason, reason);
    assert.equal(out.reply, DENIED_REPLY);
    assert.equal(billingCalls(core).length, 0);
    assert.equal(audits[0].allowed, false);
  }
});

test('lark: self member unresolvable → denied, never throws', async () => {
  const core = fakeCore();
  const failed = await runCommand('billing.overview', larkDm,
    deps(core, { imOwner: imFixture(), selfMemberId: async () => { throw new Error('no config, /me down'); } }).d);
  assert.equal(failed.allowed, false);
  assert.equal(failed.reason, 'verification_unavailable');
  const none = await runCommand('billing.overview', larkDm,
    deps(core, { imOwner: imFixture(), selfMemberId: async () => '' }).d);
  assert.equal(none.reason, 'agent_owner_unknown');
  assert.equal(none.reply, DENIED_REPLY);
});

// ---- spend: ranges + aggregation ---------------------------------------------

test('spend range: default month-to-date in the Agent time zone, last Nd, explicit ranges', () => {
  const m = resolveSpendRange({}, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(new Date(m.start).toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(m.end, NOW);
  assert.equal(m.label, 'month_to_date');
  const l = resolveSpendRange({ last: '30d' }, { now: NOW, timeZone: 'UTC' });
  assert.equal(NOW - l.start, 30 * 86400000);
  const e = resolveSpendRange({ rangeStart: '2026-01-01T00:00:00+08:00', rangeEnd: '2026-07-01T00:00:00+08:00' }, { now: NOW, timeZone: 'UTC' });
  assert.equal(e.label, 'custom');
  const b = resolveSpendRange({ period: 'billing_period' }, { now: NOW, timeZone: 'UTC', billingPeriodStart: '2026-11-01T00:00:00Z' });
  assert.equal(new Date(b.start).toISOString(), '2026-11-01T00:00:00.000Z');
});

test('spend range: invalid input is a 400 before any request', async () => {
  for (const p of [
    { last: '0d' }, { last: '7h' }, { last: '400d' }, { period: 'year' },
    { rangeStart: '2026-01-01' }, { rangeEnd: '2026-01-01T00:00:00Z' },
    { rangeStart: '2025-01-01T00:00:00Z', rangeEnd: '2026-06-01T00:00:00Z' },
    { rangeStart: '2026-11-10T00:00:00Z', rangeEnd: '2026-11-01T00:00:00Z' },
    { last: '7d', period: 'month' },
  ]) assert.throws(() => resolveSpendRange(p, { now: NOW, timeZone: 'UTC' }), (e) => e.status === 400, JSON.stringify(p));
  const core = fakeCore({ messages: msgFrom(OWNER) });
  await assert.rejects(runCommand('billing.spend', { ...wsRef, last: 'forever' }, deps(core).d), /last/);
  assert.equal(core.calls.length, 0);
});

test('spend range: >92 days is split into ≤92-day windows', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const end = start + 200 * 86400000;
  const w = splitWindows(start, end);
  assert.equal(w.length, 3);
  assert.equal(w[0][0], start);
  assert.equal(w.at(-1)[1], end);
  for (let i = 0; i < w.length; i++) {
    assert.ok(w[i][1] - w[i][0] <= STATEMENT_WINDOW_MAX_MS);
    if (i) assert.equal(w[i][0], w[i - 1][1]);
  }
});

const row = (agent, name, points, extra = {}) => ({ kind: 'consumption', agent_identity: agent, agent_name: name, points, category: 'llm_usage', ...extra });

test('spend aggregates consumptions per Agent across pages and windows, with top N', async () => {
  const seen = [];
  const statement = (q) => {
    seen.push(q);
    const winStart = q.range_start;
    if (q.page === 1) return { consumptions: [row('a', 'Alpha', 100, { charge_id: 1 }), row('b', 'Beta', 50, { charge_id: 2 })], has_more: true, balance: 30000 };
    if (q.page === 2) return { consumptions: [row('a', 'Alpha', 25, { charge_id: 3, category: 'agent_runtime_hourly' }), row('', null, 10, { charge_id: winStart.startsWith('2026-05') ? 40 : 41 })], has_more: false };
    return { consumptions: [], has_more: false };
  };
  const core = fakeCore({ messages: msgFrom(OWNER), statement });
  const out = await runCommand('billing.spend', { ...wsRef, rangeStart: '2026-05-01T00:00:00Z', rangeEnd: '2026-09-01T00:00:00Z', top: 1 }, deps(core).d);
  assert.equal(out.allowed, true);
  assert.equal(out.windows, 2);
  assert.equal(out.pages, 4);
  assert.equal(out.complete, true);
  // charge ids 1-3 repeat in the second window and are counted once.
  assert.equal(out.total_points, 100 + 50 + 25 + 10 + 10);
  assert.deepEqual(out.top_agents, [{ agent_identity: 'a', agent_name: 'Alpha', points: 125, entries: 2, org_level: false }]);
  assert.equal(out.agent_count, 2);
  assert.equal(out.by_category.llm_usage, 170);
  assert.equal(out.by_category.agent_runtime_hourly, 25);
  assert.ok(seen.every((q) => q.page_size === 200));
  assert.ok(seen.every((q) => Date.parse(q.range_end) - Date.parse(q.range_start) <= STATEMENT_WINDOW_MAX_MS));
});

test('spend stops at the page cap and reports complete:false', async () => {
  const get = async () => ({ consumptions: [row('a', 'A', 1)], has_more: true });
  const out = await fetchSpend(get, { start: NOW - 86400000, end: NOW, maxPages: 3 });
  assert.equal(out.pages, 3);
  assert.equal(out.complete, false);
  // Rows without a time cannot be placed inside a truncated window: none claimed.
  assert.equal(out.total_points, 0);
  assert.equal(out.covered_from, new Date(NOW).toISOString());
});

test('spend: rows on the truncation instant are dropped (same-hour charges split across pages)', async () => {
  const end = Date.parse('2026-11-19T12:00:00Z');
  const start = end - 86400000;
  const h10 = '2026-11-19T10:00:00.000Z';
  const pagesData = {
    1: { consumptions: [
      row('x', 'X', 7, { charge_id: 1, occurred_at: '2026-11-19T11:00:00.000Z' }),
      row('a', 'A', 1, { charge_id: 2, occurred_at: h10 }),
      row('b', 'B', 2, { charge_id: 3, occurred_at: h10 }),
    ], has_more: true },
    2: { consumptions: [
      row('c', 'C', 4, { charge_id: 4, occurred_at: h10 }),
      row('d', 'D', 8, { charge_id: 5, occurred_at: h10 }),
    ], has_more: false },
  };
  const out = await fetchSpend(async (_p, q) => pagesData[q.page], { start, end, maxPages: 1 });
  assert.equal(out.complete, false);
  assert.equal(out.covered_from, '2026-11-19T10:00:00.001Z');
  assert.equal(out.covered_to, new Date(end).toISOString());
  assert.equal(out.total_points, 7);
  assert.deepEqual(out.top_agents.map((a) => a.agent_identity), ['x']);
  assert.deepEqual(out.by_category, { llm_usage: 7 });
  const full = await fetchSpend(async (_p, q) => pagesData[q.page], { start, end, maxPages: 2 });
  assert.equal(full.complete, true);
  assert.equal(full.total_points, 22);
});

test('spend: a truncated page on a single instant claims nothing from that window', async () => {
  const end = Date.parse('2026-11-01T00:00:00Z');
  const start = end - 100 * 86400000;
  const [w0, w1] = splitWindows(start, end);
  const iso = (t) => new Date(t).toISOString();
  const get = async (_p, q) => (Date.parse(q.range_start) === w1[0]
    ? { consumptions: [row('n', 'N', 3, { charge_id: 9, occurred_at: iso(w1[1] - 1000) })], has_more: false }
    : { consumptions: [row('a', 'A', 5, { charge_id: 1, occurred_at: iso(w0[1] - 3600000) }),
      row('b', 'B', 6, { charge_id: 2, occurred_at: iso(w0[1] - 3600000) })], has_more: true });
  const out = await fetchSpend(get, { start, end, maxPages: 2 });
  assert.equal(out.complete, false);
  assert.equal(out.covered_from, iso(w1[0]));
  assert.equal(out.total_points, 3);
  // Same with only the truncated window: coverage collapses to the range end.
  const only = await fetchSpend(async () => ({ consumptions: [row('a', 'A', 5, { occurred_at: iso(end - 3600000) })], has_more: true }),
    { start: end - 86400000, end, maxPages: 1 });
  assert.equal(only.covered_from, iso(end));
  assert.equal(only.total_points, 0);
  assert.deepEqual(only.top_agents, []);
});

test('spend under a page cap keeps the newest windows and reports the covered span', async () => {
  // 200 days → windows W0 (oldest), W1, W2 (newest). Cap 3 pages: W2 fully
  // (2 pages), then page 1 of W1; W0 never read.
  const end = Date.parse('2026-11-01T00:00:00Z');
  const start = end - 200 * 86400000;
  const [w0, w1, w2] = splitWindows(start, end);
  const iso = (t) => new Date(t).toISOString();
  const queried = [];
  let id = 0;
  const get = async (_p, q) => {
    queried.push(`${q.range_start}#${q.page}`);
    const ws = Date.parse(q.range_start);
    if (ws === w2[0]) {
      return q.page === 1
        ? { consumptions: [row('b', 'B', 40, { charge_id: ++id, occurred_at: iso(w2[1] - 3600000) })], has_more: true }
        : { consumptions: [row('b', 'B', 30, { charge_id: ++id, occurred_at: iso(w2[0] + 3600000) })], has_more: false };
    }
    if (ws === w1[0]) {
      return { consumptions: [
        row('a', 'A', 5, { charge_id: ++id, occurred_at: iso(w1[1] - 86400000) }),
        row('a', 'A', 5, { charge_id: ++id, occurred_at: iso(w1[1] - 2 * 86400000) }),
      ], has_more: true };
    }
    return { consumptions: [row('a', 'A', 1000, { charge_id: ++id, occurred_at: iso(w0[0]) })], has_more: false };
  };
  const out = await fetchSpend(get, { start, end, maxPages: 3 });
  assert.equal(out.complete, false);
  assert.equal(out.pages, 3);
  assert.ok(!queried.some((k) => k.startsWith(iso(w0[0]))), 'oldest window must not be read');
  assert.equal(out.range.start, iso(start));
  assert.equal(out.covered_to, iso(end));
  // The oldest instant read in W1 is dropped; coverage starts 1 ms after it.
  assert.equal(out.covered_from, iso(w1[1] - 2 * 86400000 + 1));
  assert.equal(out.total_points, 75);
  assert.deepEqual(out.top_agents.map((a) => [a.agent_identity, a.points]), [['b', 70], ['a', 5]]);
  // Complete reads cover the whole range.
  const done = await fetchSpend(async () => ({ consumptions: [], has_more: false }), { start, end });
  assert.equal(done.complete, true);
  assert.equal(done.covered_from, iso(start));
});

test('spend billing_period uses plan-state current_period_start after the gate', async () => {
  const statement = () => ({ consumptions: [], has_more: false });
  const core = fakeCore({ messages: msgFrom(ADMIN), statement });
  const out = await runCommand('billing.spend', { ...wsRef, period: 'billing_period' }, deps(core).d);
  assert.equal(out.period, 'billing_period_to_date');
  assert.equal(out.range.start, '2026-11-01T00:00:00.000Z');
});

test('billing.links needs no gate and points to the web credit page', async () => {
  const out = await runCommand('billing.links', {}, deps(fakeCore()).d);
  assert.equal(out.credit_page_url, 'https://core.example/workspace/account?tab=credit');
  await assert.rejects(runCommand('billing.purchase', {}, deps(fakeCore()).d), /Unknown command/);
});

// ---- audit ------------------------------------------------------------------

test('audit records whitelist fields only — no tokens, text or numbers', () => {
  const rec = buildAuditRecord({ command: 'billing.overview', allowed: true, role: 'org-owner', initiator_member_id: OWNER,
    token: 'cwsk_secret', authorization: 'Bearer x', credit_balance: 31337, content: 'how many credits', reason: 'has space and secret' });
  const s = JSON.stringify(rec);
  for (const leak of ['cwsk_secret', 'Bearer', '31337', 'how many credits', 'secret']) assert.equal(s.includes(leak), false, leak);
  assert.equal(rec.reason, '[invalid]');
  assert.equal(rec.role, 'org-owner');
});

test('audit appends JSONL lines to the file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs', 'audit.jsonl');
  assert.equal(appendAudit({ command: 'billing.spend', allowed: false, reason: 'initiator_not_admin' }, { file }), true);
  appendAudit({ command: 'billing.overview', allowed: true }, { file });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].reason, 'initiator_not_admin');
});

// ---- CLI subprocess against a fake Core (wiring, org routing, log redaction) --

const cliPath = fileURLToPath(new URL('./billing.js', import.meta.url));
const TOKEN = 'billing-cli-test-token-xyz';

async function withCore(t, senderId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(comp, { recursive: true });
  fs.writeFileSync(path.join(comp, 'config.json'), JSON.stringify({
    orgs: { a: { enabled: true, org_id: ORG, org_name: 'A', self: { member_id: SELF } } },
  }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, org: req.headers['x-org-id'] });
    const u = new URL(req.url, 'http://x');
    let data;
    if (u.pathname === `/api/v1/conversations/${CONV}/messages/${MSG}`) {
      data = { message: { conversation_id: CONV, org_id: ORG, sender_id: senderId, sender_type: 'HUMAN', timestamp: new Date().toISOString() } };
    } else if (u.pathname === `/api/v1/members/${SELF}`) {
      data = member(SELF, 'agent', 'org-member', { owner_member_id: OWNER });
    } else if (u.pathname.startsWith('/api/v1/members/')) {
      data = MEMBERS[u.pathname.split('/').pop()];
    } else if (u.pathname === '/api/v1/billing/plan-state') data = PLAN_STATE;
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data ? { data, request_id: 'r', server_time: new Date().toISOString() } : { error: { status: 404 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const rpcLog = path.join(home, 'rpc.log');
  const audit = path.join(home, 'audit.jsonl');
  const run = (cmd, params) => new Promise((resolve) => {
    execFile(process.execPath, [cliPath, cmd, JSON.stringify(params)], {
      env: { ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), COCO_ORG_ID: ORG,
        COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: TOKEN, COCO_USER_TOKEN: '',
        COCO_RPC_LOG: '0', COCO_RPC_LOG_FILE: rpcLog, OPENMAX_BILLING_AUDIT_FILE: audit },
      timeout: 15000,
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
  return { run, requests, rpcLog, audit, home };
}

test('CLI: owner overview end to end; numbers and token stay out of rpc and audit logs', async (t) => {
  const { run, requests, rpcLog, audit } = await withCore(t, OWNER);
  const r = await run('billing.overview', wsRef);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.allowed, true);
  assert.equal(out.credits.credit_balance, 31337);
  assert.ok(requests.every((q) => q.authorization === `Bearer ${TOKEN}`));
  const logs = fs.readFileSync(rpcLog, 'utf8') + fs.readFileSync(audit, 'utf8');
  assert.ok(logs.includes('/billing/plan-state'));
  for (const leak of [TOKEN, '31337', '27182', 'cred-secret', '4242']) assert.equal(logs.includes(leak), false, leak);
});

test('CLI: member is denied with exit 0 and Core never sees a billing request', async (t) => {
  const { run, requests } = await withCore(t, MEMBER);
  const r = await run('billing.spend', wsRef);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).reply, DENIED_REPLY);
  assert.ok(!requests.some((q) => q.url.includes('/billing/')));
});

test('CLI: lark owner DM answered from real component files + C4 db; the same owner in a group is redirected', async (t) => {
  const { run, requests, home } = await withCore(t, OWNER);
  const zylos = path.join(home, 'zylos');
  const comp = path.join(zylos, 'components', 'lark');
  fs.mkdirSync(path.join(comp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(comp, 'config.json'), JSON.stringify({ owner: LARK_OWNER }));
  fs.writeFileSync(path.join(comp, 'logs', 'u_owner.log'), `${JSON.stringify({ message_id: 'om_own1', user_id: 'u_owner', open_id: 'ou_owner' })}\n`);
  fs.mkdirSync(path.join(zylos, 'comm-bridge'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(zylos, 'comm-bridge', 'c4.db'));
  db.exec(`CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, channel TEXT, endpoint_id TEXT,
    content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare('INSERT INTO conversations (direction, channel, endpoint_id, content) VALUES (?, ?, ?, ?)').run('in', 'lark', LARK_DM_EP, 'hi');
  db.close();
  const dm = await run('billing.overview', { channel: 'lark', endpoint: LARK_DM_EP });
  assert.equal(dm.code, 0, dm.stderr);
  const out = JSON.parse(dm.stdout);
  assert.equal(out.allowed, true, dm.stdout);
  assert.equal(out.initiator.member_id, OWNER);
  assert.equal(out.credits.credit_balance, 31337);
  const before = requests.length;
  const grp = await run('billing.overview', { channel: 'lark', endpoint: LARK_GROUP_EP });
  assert.equal(grp.code, 0, grp.stderr);
  assert.deepEqual(JSON.parse(grp.stdout), { allowed: false, reason: 'not_private_chat', reply: EXTERNAL_REDIRECT_REPLY });
  assert.equal(requests.length, before);
});
