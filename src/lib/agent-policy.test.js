import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLICY_UPDATED_EVENT,
  validatePolicyBatch,
  handlePolicyUpdated,
  buildReportedPolicy,
} from './agent-policy.js';

const SLUG = 'acme';

// A fake config store: counts writes, and a report() that snapshots what the
// bridge would PUT to /agents/{id}/reported-policy right now.
function harness(access) {
  let cfg = { orgs: { [SLUG]: { access: structuredClone(access) } } };
  const writes = [];
  const reports = [];
  const update = (mutate) => {
    const next = structuredClone(cfg);
    mutate(next);
    cfg = next;
    writes.push(next);
    return next;
  };
  const report = () => reports.push(buildReportedPolicy(cfg.orgs[SLUG].access));
  return { update, report, writes, reports, get access() { return cfg.orgs[SLUG].access; } };
}

const BASE = {
  dmPolicy: 'owner',
  dmAllowFrom: ['m-old'],
  groupPolicy: 'open',
  groups: {
    'conv-keep': { mode: 'smart', allowFrom: ['m-1'] },
    'conv-drop': { mode: 'mention', allowFrom: ['*'] },
  },
};

function event(overrides = {}) {
  return {
    org_id: 'org-1',
    agent_member_id: 'agent-1',
    batch_id: 'batch-123',
    changed_by: 'user-1',
    occurred_at: '2026-10-19T06:48:56Z',
    ...overrides,
  };
}

test('event name is the cws-comm batch event', () => {
  assert.equal(POLICY_UPDATED_EVENT, 'agent.config.policy_updated');
});

test('one event with all four items → one config write, one report with every new value', () => {
  const h = harness(BASE);
  const result = handlePolicyUpdated({
    slug: SLUG,
    data: event({
      dm_policy: 'allowlist',
      dm_allowlist: ['m-a', 'm-b'],
      group_scope: 'allowlist',
      group_allowlist: ['conv-keep', 'conv-new'],
    }),
    update: h.update,
    report: h.report,
  });

  assert.deepEqual(result, { applied: true, fields: ['dm_policy', 'dm_allowlist', 'group_scope', 'group_allowlist'] });
  assert.equal(h.writes.length, 1);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.reports[0], {
    dm_policy: 'allowlist',
    dm_allowlist: ['m-a', 'm-b'],
    group_scope: 'allowlist',
    group_allowlist: ['conv-keep', 'conv-new'],
    groups: [
      // a group that stays listed keeps its own mode / allowFrom
      { conversation_id: 'conv-keep', mode: 'smart', allow_from: ['m-1'] },
      { conversation_id: 'conv-new', mode: 'mention', allow_from: ['*'] },
    ],
  });
});

test('two items → only those change; absent and null fields are left alone', () => {
  const h = harness(BASE);
  const result = handlePolicyUpdated({
    slug: SLUG,
    data: event({ dm_policy: 'open', group_scope: 'disabled', dm_allowlist: null, some_future_field: 42 }),
    update: h.update,
    report: h.report,
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.fields, ['dm_policy', 'group_scope']);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].dm_policy, 'open');
  assert.equal(h.reports[0].group_scope, 'disabled');
  assert.deepEqual(h.reports[0].dm_allowlist, ['m-old']);
  assert.deepEqual(h.reports[0].group_allowlist, ['conv-keep', 'conv-drop']);
});

test('empty lists clear the allowlists', () => {
  const h = harness(BASE);
  handlePolicyUpdated({
    slug: SLUG,
    data: event({ dm_allowlist: [], group_allowlist: [] }),
    update: h.update,
    report: h.report,
  });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.access.dmAllowFrom, []);
  assert.deepEqual(h.access.groups, {});
  assert.deepEqual(h.reports[0].dm_allowlist, []);
  assert.deepEqual(h.reports[0].group_allowlist, []);
});

test('any invalid item rejects the whole event: no write, current snapshot reported once', () => {
  const invalid = [
    { dm_policy: 'allowlist', group_scope: 'everyone' },
    { dm_policy: 'nobody', dm_allowlist: ['m-a'] },
    { dm_policy: 'allowlist', dm_allowlist: 'm-a' },
    { group_scope: 'allowlist', group_allowlist: ['conv-1', 7] },
    { dm_allowlist: ['m-a', ''] },
    { dm_policy: 'open', batch_id: 99 },
    {}, // no items at all
  ];
  for (const fields of invalid) {
    const h = harness(BASE);
    const warnings = [];
    const result = handlePolicyUpdated({
      slug: SLUG,
      data: event(fields),
      update: h.update,
      report: h.report,
      warn: (m) => warnings.push(m),
    });
    assert.equal(result.applied, false, JSON.stringify(fields));
    assert.equal(h.writes.length, 0, JSON.stringify(fields));
    assert.deepEqual(h.access, BASE, JSON.stringify(fields));
    assert.equal(h.reports.length, 1);
    assert.deepEqual(h.reports[0], buildReportedPolicy(BASE));
    assert.equal(warnings.length, 1);
  }
});

test('missing org in config → no change, still one report', () => {
  const h = harness(BASE);
  const result = handlePolicyUpdated({
    slug: 'other-org',
    data: event({ dm_policy: 'open' }),
    update: h.update,
    report: h.report,
  });
  assert.deepEqual(result, { applied: false, reason: 'org_not_found' });
  assert.equal(h.access.dmPolicy, 'owner');
  assert.equal(h.reports.length, 1);
});

test('validatePolicyBatch dedupes lists and maps fields', () => {
  const v = validatePolicyBatch(event({ dm_allowlist: ['a', 'b', 'a'], group_allowlist: ['c', 'c'] }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.items, { dmAllowFrom: ['a', 'b'], groupIds: ['c'] });
  assert.equal(validatePolicyBatch(null).ok, false);
});

test('buildReportedPolicy keeps the legacy defaults for an empty access block', () => {
  assert.deepEqual(buildReportedPolicy({}), {
    dm_policy: 'owner',
    dm_allowlist: [],
    group_scope: 'allowlist',
    group_allowlist: [],
    groups: [],
  });
});
