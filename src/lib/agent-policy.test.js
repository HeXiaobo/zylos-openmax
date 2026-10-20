import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';

import {
  POLICY_UPDATED_EVENT,
  LEGACY_POLICY_EVENTS,
  validatePolicyBatch,
  handlePolicyUpdated,
  handleLegacyPolicyEvent,
  legacyBatchId,
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

// --- Dual-send compatibility: legacy per-field events tagged with batch_id ---

const LEGACY = {
  'agent.config.dm_policy_changed': { policy: 'allowlist' },
  'agent.config.dm_allowlist_changed': { action: 'set', member_ids: ['m-a', 'm-b'] },
  'agent.config.group_scope_changed': { scope: 'allowlist' },
  'agent.config.group_allowlist_changed': { action: 'set', conversation_ids: ['conv-keep', 'conv-new'] },
};

function legacy(name, extra = {}) {
  return {
    org_id: 'org-1',
    agent_member_id: 'agent-1',
    changed_by: 'user-1',
    ...LEGACY[name],
    ...extra,
  };
}

test('LEGACY_POLICY_EVENTS is exactly the four per-field policy events', () => {
  assert.deepEqual([...LEGACY_POLICY_EVENTS].sort(), Object.keys(LEGACY).sort());
  for (const e of [
    'agent.config.group_mode_changed',
    'agent.config.group_allowfrom_changed',
    'agent.config.owner_changed',
    'agent.config.diagnostics_changed',
    POLICY_UPDATED_EVENT,
  ]) assert.equal(LEGACY_POLICY_EVENTS.has(e), false, e);
});

test('legacyBatchId: only a non-empty string tags an event', () => {
  assert.equal(legacyBatchId({ batch_id: 'b-1' }), 'b-1');
  for (const v of [undefined, null, '', '   ', 7, {}, true]) {
    assert.equal(legacyBatchId({ batch_id: v }), null, JSON.stringify(v));
  }
  assert.equal(legacyBatchId(undefined), null);
});

test('legacy event with batch_id → skipped: no config write, no report, one log line', () => {
  for (const name of Object.keys(LEGACY)) {
    const h = harness(BASE);
    const logs = [];
    const result = handleLegacyPolicyEvent({
      slug: SLUG, event: name, data: legacy(name, { batch_id: 'batch-123' }),
      update: h.update, report: h.report, log: (m) => logs.push(m),
    });
    assert.deepEqual(result, { skipped: true, batchId: 'batch-123' }, name);
    assert.equal(h.writes.length, 0, name);
    assert.equal(h.reports.length, 0, name);
    assert.deepEqual(h.access, BASE, name);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /skip legacy .*covered by batch batch-123/);
  }
});

test('legacy event without batch_id → applied and reported as before', () => {
  const cases = [
    ['agent.config.dm_policy_changed', {}, (a) => assert.equal(a.dmPolicy, 'allowlist')],
    ['agent.config.dm_allowlist_changed', {}, (a) => assert.deepEqual(a.dmAllowFrom, ['m-a', 'm-b'])],
    ['agent.config.dm_allowlist_changed', { action: 'add', member_ids: ['m-old', 'm-x'] },
      (a) => assert.deepEqual(a.dmAllowFrom, ['m-old', 'm-x'])],
    ['agent.config.dm_allowlist_changed', { action: 'remove', member_ids: ['m-old'] },
      (a) => assert.deepEqual(a.dmAllowFrom, [])],
    ['agent.config.group_scope_changed', {}, (a) => assert.equal(a.groupPolicy, 'allowlist')],
    ['agent.config.group_allowlist_changed', {}, (a) => assert.deepEqual(a.groups, {
      'conv-keep': { mode: 'smart', allowFrom: ['m-1'] },
      'conv-new': { mode: 'mention', allowFrom: ['*'] },
    })],
    ['agent.config.group_allowlist_changed', { action: 'add', conversation_ids: ['conv-x'] },
      (a) => assert.deepEqual(Object.keys(a.groups), ['conv-keep', 'conv-drop', 'conv-x'])],
    ['agent.config.group_allowlist_changed', { action: 'remove', conversation_ids: ['conv-drop'] },
      (a) => assert.deepEqual(Object.keys(a.groups), ['conv-keep'])],
    // blank / non-string batch_id is "untagged" → still applied
    ['agent.config.dm_policy_changed', { batch_id: '' }, (a) => assert.equal(a.dmPolicy, 'allowlist')],
    ['agent.config.group_scope_changed', { batch_id: null }, (a) => assert.equal(a.groupPolicy, 'allowlist')],
  ];
  for (const [name, extra, check] of cases) {
    const h = harness(BASE);
    const result = handleLegacyPolicyEvent({
      slug: SLUG, event: name, data: legacy(name, extra), update: h.update, report: h.report,
    });
    assert.deepEqual(result, { skipped: false, applied: true }, name);
    assert.equal(h.writes.length, 1, name);
    assert.equal(h.reports.length, 1, name);
    check(h.access);
    assert.deepEqual(h.reports[0], buildReportedPolicy(h.access));
  }
});

test('untagged invalid legacy event → warned, no write, no report (as before)', () => {
  const invalid = [
    ['agent.config.dm_policy_changed', { policy: 'nobody' }],
    ['agent.config.dm_allowlist_changed', { member_ids: [] }],
    ['agent.config.group_scope_changed', { scope: 'everyone' }],
    ['agent.config.group_allowlist_changed', { conversation_ids: 'conv-1' }],
    ['agent.config.group_allowlist_changed', { action: 'replace' }],
  ];
  for (const [name, extra] of invalid) {
    const h = harness(BASE);
    const warnings = [];
    const result = handleLegacyPolicyEvent({
      slug: SLUG, event: name, data: legacy(name, extra),
      update: h.update, report: h.report, warn: (m) => warnings.push(m),
    });
    assert.deepEqual(result, { skipped: false, applied: false }, name);
    assert.equal(h.writes.length, 0, name);
    assert.equal(h.reports.length, 0, name);
    assert.equal(warnings.length, 1, name);
  }
});

test('dual-send: batch event + its four tagged legacy copies → exactly 1 write, 1 report with all values', () => {
  const h = harness(BASE);
  const batchId = 'batch-dual-1';
  // Same order cws-comm publishes on the subject: batch first, then legacy copies.
  const frames = [
    [POLICY_UPDATED_EVENT, event({
      batch_id: batchId,
      dm_policy: 'allowlist',
      dm_allowlist: ['m-a', 'm-b'],
      group_scope: 'allowlist',
      group_allowlist: ['conv-keep', 'conv-new'],
    })],
    ...Object.keys(LEGACY).map(name => [name, legacy(name, { batch_id: batchId })]),
  ];
  // Mirrors handleConfigUpdate's routing in src/comm-bridge.js.
  for (const [name, data] of frames) {
    if (name === POLICY_UPDATED_EVENT) {
      handlePolicyUpdated({ slug: SLUG, data, update: h.update, report: h.report });
    } else {
      handleLegacyPolicyEvent({ slug: SLUG, event: name, data, update: h.update, report: h.report });
    }
  }
  assert.equal(h.writes.length, 1);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.reports[0], {
    dm_policy: 'allowlist',
    dm_allowlist: ['m-a', 'm-b'],
    group_scope: 'allowlist',
    group_allowlist: ['conv-keep', 'conv-new'],
    groups: [
      { conversation_id: 'conv-keep', mode: 'smart', allow_from: ['m-1'] },
      { conversation_id: 'conv-new', mode: 'mention', allow_from: ['*'] },
    ],
  });
});

test('comm-bridge routes only the four legacy events through the batch_id skip; per-group events keep their own handlers', () => {
  const src = fs.readFileSync(new URL('../comm-bridge.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function handleConfigUpdate('), src.indexOf('function syncLiveAccessAndReport('));
  assert.ok(fn.length > 0);
  // The case labels immediately before the handleLegacyPolicyEvent call.
  const call = fn.indexOf('handleLegacyPolicyEvent(');
  const block = fn.slice(fn.lastIndexOf('return;', call), call);
  const routed = [...block.matchAll(/case '([^']+)':/g)].map(m => m[1]).sort();
  assert.deepEqual(routed, [...LEGACY_POLICY_EVENTS].sort());
  // Per-group / owner events are still handled inline and never see the skip.
  for (const e of ['agent.config.group_mode_changed', 'agent.config.group_allowfrom_changed', 'agent.config.owner_changed']) {
    const at = fn.indexOf(`case '${e}':`);
    assert.ok(at > 0, e);
    const body = fn.slice(at, fn.indexOf('case ', at + 6));
    assert.doesNotMatch(body, /batch_id|handleLegacyPolicyEvent/, e);
  }
});

test('handleLegacyPolicyEvent refuses non-legacy events', () => {
  const h = harness(BASE);
  assert.throws(() => handleLegacyPolicyEvent({
    slug: SLUG, event: 'agent.config.group_mode_changed', data: { mode: 'smart' }, update: h.update, report: h.report,
  }));
});
