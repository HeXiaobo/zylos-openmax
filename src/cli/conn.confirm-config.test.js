/**
 * OPENM-1239 (wsb#753, owner decision "option C") — conn.confirm_config set:
 * tightening needs no check; loosening needs THIS Agent's owner, verified
 * server-side from the Workspace source message (billing-gate.js
 * checkInitiator, requirement 'agent_owner'); every change returns a notice;
 * allowed and denied attempts are audited.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runConfirmConfig, confirmConfigLoosening, CONFIRM_CONFIG_DENIED_REPLY, CONFIRM_CONFIG_EXTERNAL_REPLY,
  CONFIRM_CONFIG_UNAVAILABLE_REPLY,
} from './conn.js';
import { checkInitiator } from '../lib/billing-gate.js';

const ORG = '0193aaaa-0000-7000-8000-000000000001';
const SLUG = 'lin-shop';
const CONV = '0193aaaa-0000-7000-8000-0000000000c1';
const MSG = '7300000000000000001';
const OWNER = '0193aaaa-0000-7000-8000-0000000000a1'; // this Agent's owner
const ADMIN = '0193aaaa-0000-7000-8000-0000000000a2'; // org admin, NOT this Agent's owner
const SELF = '0193aaaa-0000-7000-8000-0000000000b9';
const NOW = Date.parse('2026-11-23T08:00:00Z');

const member = (id, kind, slug, extra = {}) => ({ member_id: id, kind, status: 'active', display_name: `n-${id.slice(-2)}`, role: { slug }, ...extra });
const MEMBERS = { [OWNER]: member(OWNER, 'human', 'org-member'), [ADMIN]: member(ADMIN, 'human', 'org-owner') };

/** Fake cws-core: one source message from `sender`; `down` → every call 503. */
function fakeCore({ sender = OWNER, selfOwner = OWNER, down = false } = {}) {
  const calls = [];
  const get = async (p) => {
    calls.push(p);
    if (down) throw Object.assign(new Error('unavailable'), { status: 503 });
    if (p === `/conversations/${CONV}/messages/${MSG}`) {
      return { message: { org_id: ORG, conversation_id: CONV, sender_id: sender, sender_type: 'HUMAN', timestamp: new Date(NOW - 60_000).toISOString() } };
    }
    const m = /^\/members\/([^/]+)$/.exec(p);
    if (m) {
      if (m[1] === SELF) return member(SELF, 'agent', 'org-member', { owner_member_id: selfOwner });
      if (MEMBERS[m[1]]) return MEMBERS[m[1]];
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    throw new Error(`unexpected ${p}`);
  };
  return { get, calls };
}

/** In-memory org config + audit sink, wired to the real initiator gate. */
function harness(stored, core = fakeCore()) {
  const cfg = { orgs: { [SLUG]: { org_id: ORG, slug: SLUG, ...(stored !== undefined ? { connector_confirm: structuredClone(stored) } : {}) } } };
  const audits = [];
  const checks = [];
  const deps = {
    resolveOrg: () => ORG,
    orgRecord: () => ({ ...cfg.orgs[SLUG], slug: SLUG }),
    writeConfig: (fn) => fn(cfg),
    audit: (r) => audits.push(r),
    now: () => new Date(NOW),
    checkAgentOwner: (ip, orgId) => {
      checks.push(ip);
      return checkInitiator(ip, { get: core.get, orgId, selfMemberId: async () => SELF, now: NOW, requirement: 'agent_owner' });
    },
  };
  return { cfg, audits, checks, deps, stored: () => cfg.orgs[SLUG].connector_confirm };
}

const ws = { conversationId: CONV, messageId: MSG };
const LIST = { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }, { app: 'gmail' }] };

test('tighten without any initiator → allowed, no identity check, notice returned', async () => {
  for (const [stored, change] of [
    [undefined, { enabled: true }],
    [{ enabled: false }, { enabled: true, scope: LIST }],
    [{ enabled: true, scope: LIST }, { scope: { connectors: [...LIST.connectors, { app: 'googlesheets' }] } }],
    [{ enabled: true, scope: LIST }, { scope: { connectors: [{ app: 'shopify-app' }, { app: 'gmail' }] } }], // connection → whole app
    [{ enabled: true, scope: LIST }, { scope: 'all' }],
  ]) {
    const h = harness(stored);
    const out = await runConfirmConfig({ action: 'set', ...change }, h.deps);
    assert.equal(out.allowed, true, JSON.stringify(change));
    assert.equal(out.loosening, false);
    assert.equal(h.checks.length, 0, 'no identity check for tightening');
    assert.equal(typeof out.notice, 'string');
    assert.equal(h.audits.at(-1).decision, 'allowed');
    assert.equal(h.audits.at(-1).reason, 'tightening_no_check');
  }
});

test('notice text: who + plain description, both languages; tighten uses the declared name', async () => {
  const h = harness({ enabled: false });
  const out = await runConfirmConfig({ action: 'set', enabled: true, scope: LIST, requestedBy: '林店主' }, h.deps);
  assert.equal(out.notice, '连接器写操作确认开关已由 林店主 改为：开启，范围：shopify-app（连接 c-sh）、gmail（全部连接）\n'
    + 'Connector write confirmation changed by 林店主 to: on, scope: shopify-app (connection c-sh), gmail (all connections)');
  assert.match(out.instruction, /verbatim/);
  const anon = await runConfirmConfig({ action: 'set', scope: 'all' }, harness({ enabled: true, scope: LIST }).deps);
  assert.match(anon.notice, /^连接器写操作确认开关已由 未注明 \/ unspecified 改为：开启，范围：全部连接器\n/);
});

test('loosen (turn off) by the verified Agent owner → allowed; owner recorded, declared name ignored; notice says off', async () => {
  const h = harness({ enabled: true, scope: 'all' });
  const out = await runConfirmConfig({ action: 'set', enabled: false, requestedBy: 'someone else', ...ws }, h.deps);
  assert.equal(out.allowed, true);
  assert.equal(out.loosening, 'disabled');
  assert.equal(out.verified_owner, true);
  assert.equal(h.stored().enabled, false);
  assert.equal(h.stored().requested_by, MEMBERS[OWNER].display_name);
  assert.equal(h.stored().requested_by_member_id, OWNER);
  assert.equal(out.notice, `连接器写操作确认开关已由 n-a1（${OWNER}） 改为：关闭（连接器写操作不需要确认）\n`
    + `Connector write confirmation changed by n-a1（${OWNER}） to: off (connector write actions need no confirmation)`);
  const line = h.audits.at(-1);
  assert.equal(line.decision, 'allowed');
  assert.equal(line.reason, 'verified_agent_owner');
  assert.equal(line.initiator_member_id, OWNER);
  assert.deepEqual(line.initiator, { source: 'workspace', conversation_id: CONV, message_id: MSG, member_id: OWNER });
});

test('loosen by a non-owner (even an org Owner/admin) → denied, config unchanged, denial audited', async () => {
  const before = { enabled: true, scope: LIST };
  const h = harness(before, fakeCore({ sender: ADMIN }));
  const out = await runConfirmConfig({ action: 'set', enabled: false, ...ws }, h.deps);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'initiator_not_agent_owner');
  assert.equal(out.reply, CONFIRM_CONFIG_DENIED_REPLY);
  assert.equal(out.notice, undefined);
  assert.deepEqual(h.stored(), before);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].event, 'confirm_config');
  assert.equal(h.audits[0].decision, 'denied');
  assert.equal(h.audits[0].reason, 'initiator_not_agent_owner');
  assert.equal(h.audits[0].initiator_member_id, ADMIN);
  assert.equal(h.audits[0].initiator.source, 'workspace');
});

test('loosen without an initiator → denied (missing_initiator), nothing changed', async () => {
  const h = harness({ enabled: true, scope: 'all' });
  const out = await runConfirmConfig({ action: 'set', enabled: false, requesterMemberId: OWNER }, h.deps);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'missing_initiator');
  assert.deepEqual(h.stored(), { enabled: true, scope: 'all' });
});

test('loosen via an external IM initiator → always denied, no request made (even the bound owner\'s DM)', async () => {
  const core = fakeCore();
  const h = harness({ enabled: true, scope: 'all' }, core);
  const out = await runConfirmConfig({ action: 'set', enabled: false, channel: 'lark', endpoint: 'ou_owner|type:p2p|msg:om_1' }, h.deps);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'external_channel_refused');
  assert.equal(out.reply, CONFIRM_CONFIG_EXTERNAL_REPLY);
  assert.equal(core.calls.length, 0);
  assert.deepEqual(h.stored(), { enabled: true, scope: 'all' });
  assert.equal(h.audits[0].decision, 'denied');
  assert.deepEqual(h.audits[0].initiator, { source: 'channel', channel: 'lark', member_id: null });
});

test('loosen with verification unavailable (core 5xx) → denied (fail closed) with the unavailable reply', async () => {
  const h = harness({ enabled: true, scope: 'all' }, fakeCore({ down: true }));
  const out = await runConfirmConfig({ action: 'set', scope: LIST, ...ws }, h.deps);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'verification_unavailable');
  assert.equal(out.reply, CONFIRM_CONFIG_UNAVAILABLE_REPLY);
  assert.deepEqual(h.stored(), { enabled: true, scope: 'all' });
  assert.equal(h.audits[0].reason, 'verification_unavailable');
  // the self-member lookup failing (owner unknown) is unavailable too
  const core2 = fakeCore();
  const h2 = harness({ enabled: true, scope: 'all' }, core2);
  h2.deps.checkAgentOwner = (ip, orgId) => checkInitiator(ip, {
    get: async (p) => { if (p === `/members/${SELF}`) throw Object.assign(new Error('x'), { status: 502 }); return core2.get(p); },
    orgId, selfMemberId: async () => SELF, now: NOW, requirement: 'agent_owner',
  });
  assert.equal((await runConfirmConfig({ action: 'set', enabled: false, ...ws }, h2.deps)).reason, 'verification_unavailable');
  // a checker that throws is unavailable, not allowed
  const h3 = harness({ enabled: true, scope: 'all' });
  h3.deps.checkAgentOwner = async () => { throw new Error('boom'); };
  const out3 = await runConfirmConfig({ action: 'set', enabled: false, ...ws }, h3.deps);
  assert.equal(out3.allowed, false);
  assert.equal(out3.reply, CONFIRM_CONFIG_UNAVAILABLE_REPLY);
});

test('an org-admin "allowed" verdict (no agent_owner flag) never authorizes loosening', async () => {
  const h = harness({ enabled: true, scope: 'all' });
  h.deps.checkAgentOwner = async () => ({ allowed: true, source: 'workspace', role: 'org-owner', initiator_member_id: ADMIN });
  const out = await runConfirmConfig({ action: 'set', enabled: false, ...ws }, h.deps);
  assert.equal(out.allowed, false);
  assert.deepEqual(h.stored(), { enabled: true, scope: 'all' });
});

test('mixed swap (remove one connector, add another) → loosening: non-owner denied, owner allowed', async () => {
  const before = { enabled: true, scope: { connectors: [{ app: 'shopify-app' }] } };
  const swap = { scope: { connectors: [{ app: 'gmail' }] } };
  assert.deepEqual(confirmConfigLoosening(before, swap), { loosening: true, reason: 'scope_narrowed', removed: [{ app: 'shopify-app' }] });
  const denied = harness(before, fakeCore({ sender: ADMIN }));
  assert.equal((await runConfirmConfig({ action: 'set', ...swap, ...ws }, denied.deps)).allowed, false);
  assert.deepEqual(denied.stored(), before);
  const ok = harness(before);
  const out = await runConfirmConfig({ action: 'set', ...swap, ...ws }, ok.deps);
  assert.equal(out.allowed, true);
  assert.equal(out.loosening, 'scope_narrowed');
  assert.deepEqual(ok.stored().scope, swap.scope);
});

test('narrowing an app to one connection, or "all" → a list, is loosening', async () => {
  assert.equal(confirmConfigLoosening({ enabled: true, scope: { connectors: [{ app: 'gmail' }] } },
    { scope: { connectors: [{ app: 'gmail', connectionId: 'c-gm' }] } }).loosening, true);
  assert.equal(confirmConfigLoosening({ enabled: true, scope: 'all' }, { scope: LIST }).reason, 'scope_all_to_list');
  const h = harness({ enabled: true, scope: 'all' }, fakeCore({ sender: ADMIN }));
  assert.equal((await runConfirmConfig({ action: 'set', scope: LIST, ...ws }, h.deps)).allowed, false);
});

test('malformed stored scope counts as "all": replacing it with a list is loosening; keeping it on is not', async () => {
  const malformed = { enabled: true, scope: { connectors: 'oops' } };
  assert.equal(confirmConfigLoosening(malformed, { scope: LIST }).reason, 'scope_all_to_list');
  assert.equal(confirmConfigLoosening(malformed, { enabled: true }).loosening, false);
  const h = harness(malformed);
  const out = await runConfirmConfig({ action: 'set', scope: LIST }, h.deps);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'missing_initiator');
  assert.deepEqual(h.stored(), malformed);
});

test('get stays unchecked', async () => {
  const h = harness({ enabled: true, scope: 'all' });
  h.deps.checkAgentOwner = async () => { throw new Error('must not be called'); };
  const out = await runConfirmConfig({ action: 'get' }, h.deps);
  assert.equal(out.effective.scope, 'all');
  assert.equal(h.audits.length, 0);
});

test('the stored block changing into a loosening between read and write → 409, nothing written', async () => {
  const h = harness({ enabled: false });
  const write = h.deps.writeConfig;
  // someone else turned it on meanwhile; this "set scope LIST" would now narrow "all"
  h.deps.writeConfig = (fn) => { h.cfg.orgs[SLUG].connector_confirm = { enabled: true, scope: 'all' }; return write(fn); };
  await assert.rejects(runConfirmConfig({ action: 'set', scope: LIST }, h.deps), (e) => e.status === 409);
  assert.deepEqual(h.stored(), { enabled: true, scope: 'all' });
});
