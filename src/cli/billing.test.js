import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './billing.js';
import { checkInitiator, DENIED_REPLY, UNAVAILABLE_REPLY, SOURCE_MESSAGE_MAX_AGE_MS } from '../lib/billing-gate.js';
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
  // External channel: self / owner lookups failing transiently.
  for (const failing of [(p) => p === `/members/${SELF}`, (p) => p === `/members/${OWNER}`]) {
    const c = fakeCore();
    const out = await runCommand('billing.overview', { channel: 'lark', askerIsAgentOwner: true }, deps(c, { get: wrap(c, failing, 502) }).d);
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

// ---- External IM channels ---------------------------------------------------

test('lark: Agent-declared owner whose Workspace owner is org Owner/admin is answered (DM or group)', async () => {
  for (const selfOwner of [OWNER, ADMIN]) {
    const core = fakeCore({ selfOwner });
    const { d, audits } = deps(core);
    const out = await runCommand('billing.overview', { channel: 'lark', askerIsAgentOwner: true }, d);
    assert.equal(out.allowed, true);
    assert.equal(out.initiator.source, 'channel');
    assert.equal(out.initiator.channel, 'lark');
    assert.equal(out.initiator.member_id, selfOwner);
    assert.equal(audits[0].channel, 'lark');
    assert.equal(audits[0].asker_is_agent_owner, true);
  }
});

test('lark: not the owner, unclear flag, or owner without admin role → fixed reply', async () => {
  for (const [params, selfOwner, reason] of [
    [{ channel: 'lark' }, OWNER, 'asker_not_agent_owner'],
    [{ channel: 'lark', askerIsAgentOwner: false }, OWNER, 'asker_not_agent_owner'],
    [{ channel: 'lark', askerIsAgentOwner: 'true' }, OWNER, 'asker_not_agent_owner'],
    [{ channel: 'lark', askerIsAgentOwner: 1 }, OWNER, 'asker_not_agent_owner'],
    [{ channel: 'telegram', askerIsAgentOwner: true }, MEMBER, 'initiator_not_admin'],
    [{ channel: 'lark', askerIsAgentOwner: true }, '', 'agent_owner_unknown'],
    [{ channel: 'Bad Channel!', askerIsAgentOwner: true }, OWNER, 'invalid_channel'],
    [{ channel: 'scheduler', askerIsAgentOwner: true }, OWNER, 'initiator_not_human'],
  ]) {
    const core = fakeCore({ selfOwner });
    const { d, audits } = deps(core);
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
  const failed = await runCommand('billing.overview', { channel: 'lark', askerIsAgentOwner: true },
    deps(core, { selfMemberId: async () => { throw new Error('no config, /me down'); } }).d);
  assert.equal(failed.allowed, false);
  assert.equal(failed.reason, 'verification_unavailable');
  const none = await runCommand('billing.overview', { channel: 'lark', askerIsAgentOwner: true },
    deps(core, { selfMemberId: async () => '' }).d);
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
  assert.equal(out.total_points, 3);
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
  assert.equal(out.covered_from, iso(w1[1] - 2 * 86400000));
  assert.equal(out.total_points, 80);
  assert.deepEqual(out.top_agents.map((a) => [a.agent_identity, a.points]), [['b', 70], ['a', 10]]);
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
  return { run, requests, rpcLog, audit };
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
