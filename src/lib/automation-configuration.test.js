import assert from 'node:assert/strict';
import test from 'node:test';
import { automationAuthorizationPreview, automationAuthorizationProposal, automationConfiguration, automationMutation } from './automation-configuration.js';

const base = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
const cardID = '01000000-0000-4000-8000-000000000002';

test('result notification policy preserves presence through proposal and mutation', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const policy of [undefined, 'every', 'failure_only', 'none']) {
        const configuration = { ...base, ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}),
          ...(policy === undefined ? {} : { result_notification_policy: policy }) };
        const params = { source_kind, operation, request_id: cardID, configuration,
          ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) };
        const proposal = automationAuthorizationProposal(params);
        const body = automationMutation({ source_kind, configuration,
          id: 'binding', expected_version: 7,
          authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, source_kind, operation);
        for (const result of [proposal.configuration, body,
          automationConfiguration({ ...configuration, source_kind }, source_kind)]) {
          assert.equal(Object.hasOwn(result, 'result_notification_policy'), policy !== undefined);
          assert.equal(result.result_notification_policy, policy);
        }
      }
    }
  }
});

test('invalid notification policy and readonly migration marker cannot reach a write', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const fields of [
      ...['', null, undefined, 'all', 'EVERY', false, 0, {}, []].map(result_notification_policy => ({ result_notification_policy })),
      { result_notification_policy_migrated: false },
    ]) {
      const configuration = { ...base, timezone: 'Asia/Singapore', ...fields };
      if (source_kind === 'webhook') delete configuration.timezone;
      const params = { source_kind, operation: 'create', request_id: cardID, configuration };
      assert.throws(() => automationAuthorizationProposal(params), /result_notification_policy/);
      assert.throws(() => automationMutation({ source_kind, configuration }, source_kind), /result_notification_policy/);
      assert.throws(() => automationConfiguration({ source_kind, ...configuration }, source_kind), /result_notification_policy/);
    }
  }
});

test('requester UUID case does not change self identity or erase a distinct confirmer', () => {
  const requester = 'abcdefab-0000-4000-8000-000000000003';
  for (const [human, owner] of [[requester.toUpperCase(), requester], [requester, requester.toUpperCase()]]) {
    const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
      requester_member_id: human, configuration: { ...base, owner_member_id: owner, timezone: 'Asia/Singapore' } };
    assert.equal(Object.hasOwn(automationAuthorizationProposal(params), 'requester_member_id'), false);
    assert.equal(automationAuthorizationProposal({ ...params,
      configuration: { ...params.configuration, owner_member_id: 'abcdefab-0000-4000-8000-000000000004' } }).requester_member_id, human);
  }
});

test('self-owned proposals omit redundant requester for the legacy strict schema', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const params = { source_kind, operation, request_id: cardID,
        configuration: { ...base, owner_member_id: cardID, ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) },
        ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) };
      const legacy = automationAuthorizationProposal(params);
      assert.equal(Object.hasOwn(legacy, 'requester_member_id'), false);
      assert.deepEqual(automationAuthorizationProposal({ ...params, requester_member_id: cardID }), legacy);
    }
  }
});

test('assignment proposal keeps confirming requester separate from target Owner', () => {
  const requester = '01000000-0000-4000-8000-000000000003';
  const configuration = { ...base, owner_member_id: 'target-human', timezone: 'Asia/Singapore' };
  const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
    requester_member_id: requester, configuration };
  const proposal = automationAuthorizationProposal(params);
  assert.equal(proposal.requester_member_id, requester);
  assert.equal(proposal.configuration.owner_member_id, 'target-human');
  assert.equal(Object.hasOwn(proposal.configuration, 'requester_member_id'), false);
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const plan = automationAuthorizationProposal({ ...params, source_kind, operation,
        configuration: { ...base, owner_member_id: 'target-human', ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) },
        ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) });
      assert.equal(plan.requester_member_id, requester);
      assert.equal(plan.configuration.owner_member_id, 'target-human');
    }
  }
  for (const value of ['', null, 42, 'not-a-member', '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => automationAuthorizationProposal({ ...params, requester_member_id: value }), /requester_member_id/);
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer',
    configuration: { ...configuration, requester_member_id: requester } }, 'timer'), /unsupported/);
});

for (const kind of ['timer', 'webhook']) {
  test(`${kind} Lead replacement keeps target and exact proof without injecting a delivery DM`, () => {
    const configuration = { ...base, lead_member_id: 'new-agent', ...(kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) };
    const proposal = automationAuthorizationProposal({ source_kind: kind, operation: 'update',
      target_binding_id: 'binding', expected_version: 7, request_id: cardID, configuration });
    assert.equal(proposal.configuration.lead_member_id, 'new-agent');
    assert.equal(proposal.expected_version, 7);
    const result = automationMutation({ id: 'binding', expected_version: 7, source_kind: kind,
      configuration, authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, kind, 'update');
    assert.equal(result.lead_member_id, 'new-agent');
    assert.equal(result.owner_member_id, 'human');
    assert.equal(result.expected_version, 7);
    assert.equal(result.authorization_card_interaction_id, cardID);
    assert.throws(() => automationMutation({ id: 'binding', expected_version: 7, source_kind: kind,
      configuration: { ...configuration, spec: { ...base.spec, delivery_conversation_id: 'forged-dm' } },
      authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, kind, 'update'), /unsupported/);
  });
}

for (const kind of ['timer', 'webhook']) {
  test(`${kind} card consent is exclusive transport metadata for create and update`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof };
    for (const operation of ['create', 'update']) {
      const result = automationMutation(params, kind, operation);
      assert.equal(result.authorization_card_interaction_id, cardID);
      assert.equal(result.authorization_confirmation_message_id, undefined);
      assert.throws(() => automationMutation({ ...params, authorization_confirmation_message_id: '1790220732845' }, kind, operation), /exactly one/);
      for (const value of ['', null, 1, '1790220732845', cardID.replaceAll('-', ''), '00000000-0000-0000-0000-000000000000']) {
        assert.throws(() => automationMutation({ ...params, authorization_card_interaction_id: value }, kind, operation), /canonical nonzero UUID/);
      }
      assert.throws(() => automationMutation({ ...params, authorization_proposal_message_id: undefined }, kind, operation), /requires both/);
    }
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
  });
}

test('replacement names one previous proposal without altering the configuration', () => {
  const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
    configuration: { ...base, timezone: 'Asia/Singapore' }, replaces_proposal_message_id: '1790220732844' };
  assert.equal(automationAuthorizationProposal(params).replaces_proposal_message_id, '1790220732844');
  assert.equal(automationAuthorizationProposal(params).configuration, params.configuration);
  for (const value of ['', null, 1, '01', 'not-a-message']) {
    assert.throws(() => automationAuthorizationProposal({ ...params, replaces_proposal_message_id: value }), /canonical decimal/);
  }
});
test('readable proposal binds its request UUID to the unchanged final configuration and scope', () => {
  const request_id = '01000000-0000-4000-8000-000000000001';
  const configuration = { ...base, timezone: 'Asia/Singapore' };
  const params = { org: 'org', source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id };
  assert.deepEqual(automationAuthorizationProposal(params), {
    source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id,
  });
  assert.deepEqual(automationAuthorizationProposal({ ...params, operation: 'create', target_binding_id: '', expected_version: 0 }), {
    source_kind: 'timer', operation: 'create', configuration, request_id,
  });
  for (const value of [undefined, null, 42, '', 'some-key', '00000000-0000-0000-0000-000000000000', ` ${request_id}`, request_id.replaceAll('-', '')]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, request_id: value }), /request_id must be a UUID/);
  }
  assert.throws(() => automationAuthorizationProposal({ ...params, operation: 'delete' }), /operation/);
  assert.throws(() => automationAuthorizationProposal({ ...params, expected_version: 0 }), /preview requires/);
  assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, request_id } }), /unsupported/);
  for (const timezone of [undefined, null, '', '   ', 0]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, timezone } }), /explicit timezone/);
  }
  assert.equal(automationAuthorizationProposal({ ...params, source_kind: 'webhook', configuration: base }).configuration, base);
});
for (const kind of ['timer', 'webhook']) {
  test(`${kind} rejects missing or mismatched route discriminator`, () => {
    assert.throws(() => automationConfiguration({ configuration: base }, kind), /source_kind is required/);
    assert.throws(() => automationConfiguration({ source_kind: kind === 'timer' ? 'webhook' : 'timer', configuration: base }, kind), /source_kind must be/);
  });
  test(`${kind} rejects unsupported configuration and spec fields`, () => {
    for (const configuration of [{ ...base, enabled: false }, { ...base, spec: { ...base.spec, priority: 1 } }]) {
      assert.throws(() => automationConfiguration({ source_kind: kind, configuration }, kind), /unsupported/);
    }
  });
}
test('wrong-route fields cannot silently disappear, including legacy calls', () => {
  for (const field of ['schedule_kind', 'cron_expr', 'timezone', 'run_at', 'interval_seconds', 'anchor_at']) {
    assert.throws(() => automationConfiguration({ source_kind: 'webhook', configuration: { ...base, [field]: 'value' } }, 'webhook'), /unsupported/);
    assert.throws(() => automationConfiguration({ ...base, [field]: 'value' }, 'webhook'), /unsupported/);
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer', configuration: { ...base, event_filter: '' } }, 'timer'), /unsupported/);
});

test('authorization preview keeps final configuration and operation separate', () => {
  const configuration = { ...base, cron_expr: '0 9 * * *' };
  assert.deepEqual(automationAuthorizationPreview({ org: 'org', source_kind: 'timer', operation: 'create', configuration }), {
    source_kind: 'timer', operation: 'create', target_binding_id: '', expected_version: 0, configuration,
  });
  assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', operation: 'delete', configuration }), /operation/);
});

test('preview rejects ambiguous scope and lossy update versions', () => {
  for (const scope of [
    { operation: 'create', target_binding_id: 'binding' },
    { operation: 'create', expected_version: 1 },
    { operation: 'update' },
    { operation: 'update', target_binding_id: ' ', expected_version: 1 },
    { operation: 'update', target_binding_id: 'binding', expected_version: '1' },
    { operation: 'update', target_binding_id: 'binding', expected_version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', configuration: base, ...scope }), /preview requires/);
  }
});

for (const kind of ['timer', 'webhook']) {
  test(`${kind} updates require both proofs and creates reject partial proof`, () => {
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base };
    assert.deepEqual(automationMutation(params, kind), base);
    assert.throws(() => automationMutation(params, kind, 'update'), /requires both authorization/);
    for (const proof of [
      { authorization_proposal_message_id: '1790220732844' },
      { authorization_confirmation_message_id: '1790220732845' },
    ]) {
      for (const operation of ['create', 'update']) {
        assert.throws(() => automationMutation({ ...params, ...proof }, kind, operation), /requires both authorization/);
      }
    }
  });
  test(`${kind} authorization proof is transport metadata, never form configuration`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.deepEqual(automationMutation({ source_kind: kind, configuration: base, ...proof }, kind), { ...base, ...proof });
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
    for (const field of Object.keys(proof)) {
      for (const value of [1790220732844, '001', '', ' ', null, 'fake', '1'.repeat(129)]) {
        for (const operation of ['create', 'update']) {
          assert.throws(() => automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof, [field]: value }, kind, operation), /canonical decimal/);
        }
      }
    }
  });
  test(`${kind} update preserves expected version and prevents malformed targets`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.equal(automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof }, kind, 'update').expected_version, 2);
    assert.throws(() => automationMutation({ source_kind: kind, configuration: base, ...proof }, kind, 'update'), /update requires/);
  });
}

const lead = '01000000-0000-4000-8000-0000000000a1';
const owner = '01000000-0000-4000-8000-0000000000b2';
const joining = { ...base, lead_member_id: lead, owner_member_id: owner };
const scoped = (kind, configuration) => ({ ...configuration, ...(kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) });
const memberAdditionLists = [[lead], [owner], [lead, owner], [owner, lead], []];

test('confirmed project member additions pass through nested proposals, previews and mutations verbatim', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const additions of memberAdditionLists) {
        const configuration = scoped(source_kind, { ...joining, project_member_additions: additions });
        const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
        const proposal = automationAuthorizationProposal({ source_kind, operation, request_id: cardID, configuration, ...scope });
        assert.equal(proposal.configuration, configuration);
        assert.equal(proposal.configuration.project_member_additions, additions);
        assert.equal(Object.hasOwn(proposal, 'project_member_additions'), false);
        assert.equal(automationAuthorizationPreview({ source_kind, operation, configuration, ...scope }).configuration, configuration);
        const body = automationMutation({ source_kind, configuration, id: 'binding', expected_version: 7,
          authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, source_kind, operation);
        assert.deepEqual(body.project_member_additions, additions);
        assert.equal(body.lead_member_id, lead);
        assert.equal(body.owner_member_id, owner);
      }
    }
  }
});

test('flat bodies map project member additions onto the top-level POST/PUT field', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const additions of memberAdditionLists) {
        const flat = { source_kind, ...scoped(source_kind, joining), project_member_additions: additions };
        assert.deepEqual(automationConfiguration(flat, source_kind).project_member_additions, additions);
        const body = automationMutation({ ...flat, id: 'binding', expected_version: 7,
          authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, source_kind, operation);
        assert.deepEqual(body.project_member_additions, additions);
        assert.equal(Object.hasOwn(body, 'configuration'), false);
      }
      const aliases = { source_kind, leadMemberId: lead, ownerMemberId: owner, projectId: 'project', title: 'Task',
        ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}), project_member_additions: [owner, lead] };
      const body = automationConfiguration(aliases, source_kind);
      assert.deepEqual(body.project_member_additions, [owner, lead]);
      assert.equal(body.lead_member_id, lead);
      assert.equal(body.owner_member_id, owner);
    }
  }
});

test('project member additions outside the configured Lead/Owner never reach a request', () => {
  const invalid = [
    ['other member', ['01000000-0000-4000-8000-0000000000c3'], /lead_member_id and\/or owner_member_id, each once/],
    ['requester instead of Owner', [cardID], /each once/],
    ['duplicate Lead', [lead, lead], /each once/],
    ['duplicate Owner', [owner, owner], /each once/],
    ['case-variant Lead', [lead.toUpperCase()], /each once/],
    ['more than two', [lead, owner, lead], /at most 2/],
    ['non-array string', lead, /must be an array/],
    ['non-array object', { 0: lead }, /must be an array/],
    ['null', null, /must be an array/],
    ['empty string entry', [''], /non-empty member ID strings/],
    ['blank entry', ['   '], /non-empty member ID strings/],
    ['non-string entry', [42], /non-empty member ID strings/],
    ['null entry', [lead, null], /non-empty member ID strings/],
  ];
  for (const source_kind of ['timer', 'webhook']) {
    for (const [name, project_member_additions, message] of invalid) {
      const configuration = scoped(source_kind, { ...joining, project_member_additions });
      const proof = { id: 'binding', expected_version: 7, authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };
      for (const operation of ['create', 'update']) {
        const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
        for (const call of [
          () => automationAuthorizationProposal({ source_kind, operation, request_id: cardID, configuration, ...scope }),
          () => automationAuthorizationPreview({ source_kind, operation, configuration, ...scope }),
          () => automationMutation({ source_kind, configuration, ...proof }, source_kind, operation),
          () => automationMutation({ source_kind, ...configuration, ...proof }, source_kind, operation),
        ]) {
          assert.throws(call, error => error.status === 400 && message.test(error.message), `${source_kind} ${operation}: ${name}`);
        }
      }
    }
    // The Owner may be listed only when the configuration names one.
    const ownerless = scoped(source_kind, { lead_member_id: lead, spec: base.spec });
    assert.deepEqual(automationConfiguration({ source_kind, ...ownerless, project_member_additions: [lead] }, source_kind).project_member_additions, [lead]);
    assert.throws(() => automationConfiguration({ source_kind, configuration: { ...ownerless, project_member_additions: [owner] } }, source_kind), /each once/);
    assert.throws(() => automationConfiguration({ source_kind, configuration: { ...ownerless, project_member_additions: [''] } }, source_kind), /non-empty/);
  }
});

test('absent project member additions keep proposal and request bodies unchanged', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const configuration = scoped(source_kind, joining);
      const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
      const proposal = automationAuthorizationProposal({ source_kind, operation, request_id: cardID, configuration, ...scope });
      assert.equal(proposal.configuration, configuration);
      assert.deepEqual(Object.keys(proposal.configuration).sort(), Object.keys(configuration).sort());
      const proof = { id: 'binding', expected_version: 7, authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };
      for (const body of [automationMutation({ source_kind, configuration, ...proof }, source_kind, operation),
        automationMutation({ source_kind, ...configuration, ...proof }, source_kind, operation),
        automationConfiguration({ source_kind, ...configuration }, source_kind)]) {
        assert.equal(Object.hasOwn(body, 'project_member_additions'), false);
      }
      assert.deepEqual(automationConfiguration({ source_kind, ...configuration }, source_kind), {
        lead_member_id: lead, owner_member_id: owner, spec: { project_id: 'project', title: 'Task', description: undefined },
        ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}),
      });
    }
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer', configuration: { ...joining, projectMemberAdditions: [lead] } }, 'timer'), /unsupported timer configuration field: projectMemberAdditions/);
  assert.throws(() => automationConfiguration({ source_kind: 'webhook', configuration: { ...joining, spec: { ...base.spec, project_member_additions: [lead] } } }, 'webhook'), /unsupported spec field/);
});

// OPENM-1305 / OPENM-1308: a spec that belongs to no project, and the output
// knowledge base choice, reach Core exactly as the form sent them.
const { project_id: _project, ...detached } = base.spec;
const kbID = '01000000-0000-4000-8000-0000000000d4';
const targetSpecs = [
  ['unattached org', { ...detached, unattached: true, unattached_scope: 'org' }],
  ['unattached private', { ...detached, unattached: true, unattached_scope: 'private' }],
  ['unattached default scope', { ...detached, unattached: true }],
  ['unattached naming the read system project', { ...base.spec, unattached: true }],
  ['attach an unattached automation', { ...base.spec, unattached: false }],
  ['project default knowledge base', { ...base.spec, knowledge_base_mode: 'project_default' }],
  ['no knowledge base', { ...base.spec, knowledge_base_mode: 'none' }],
  ['custom knowledge base', { ...base.spec, knowledge_base_mode: 'custom', knowledge_base_id: kbID }],
  ['unattached private with custom knowledge base',
    { ...detached, unattached: true, unattached_scope: 'private', knowledge_base_mode: 'custom', knowledge_base_id: kbID }],
  ['unattached org without knowledge base', { ...detached, unattached: true, unattached_scope: 'org', knowledge_base_mode: 'none' }],
];
const writeProof = { id: 'binding', expected_version: 7,
  authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };

test('unattached and knowledge base spec fields pass through preview, proposal and mutation verbatim', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const [name, spec] of targetSpecs) {
        const configuration = scoped(source_kind, { ...base, spec });
        const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
        const label = `${source_kind} ${operation}: ${name}`;
        const proposal = automationAuthorizationProposal({ source_kind, operation, request_id: cardID, configuration, ...scope });
        assert.equal(proposal.configuration, configuration, label);
        assert.deepEqual(proposal.configuration.spec, spec, label);
        assert.equal(automationAuthorizationPreview({ source_kind, operation, configuration, ...scope }).configuration, configuration, label);
        const nested = automationMutation({ source_kind, configuration, ...writeProof }, source_kind, operation);
        assert.deepEqual(nested.spec, spec, label);
        // Flat calls keep the three legacy keys and add a target field only when it was given.
        const flat = automationMutation({ source_kind, ...configuration, ...writeProof }, source_kind, operation);
        assert.deepEqual(flat.spec, { project_id: undefined, description: undefined, ...spec }, label);
      }
    }
  }
});

test('an unattached private spec keeps the confirmed Lead joining the hidden project', () => {
  const configuration = scoped('timer', { ...joining, spec: { ...detached, unattached: true, unattached_scope: 'private' },
    project_member_additions: [lead] });
  const proposal = automationAuthorizationProposal({ source_kind: 'timer', operation: 'create', request_id: cardID, configuration });
  assert.equal(proposal.configuration, configuration);
  const body = automationMutation({ source_kind: 'timer', ...configuration, ...writeProof }, 'timer');
  assert.deepEqual(body.project_member_additions, [lead]);
  assert.equal(body.spec.unattached_scope, 'private');
});

const invalidTargets = [
  ['scope without unattached', { ...detached, unattached_scope: 'org' }, /project_id is required/],
  ['scope without unattached but with project', { ...base.spec, unattached_scope: 'org' }, /unattached_scope applies only with spec\.unattached true and no spec\.project_id/],
  ['scope with unattached false', { ...base.spec, unattached: false, unattached_scope: 'private' }, /unattached_scope applies only/],
  ['scope with a project', { ...base.spec, unattached: true, unattached_scope: 'org' }, /unattached_scope applies only/],
  ['private scope with a project', { ...base.spec, unattached: true, unattached_scope: 'private' }, /unattached_scope applies only/],
  ...['', 'ORG', 'public', 'none', null, 1, true, ['org']].map(unattached_scope =>
    [`scope ${JSON.stringify(unattached_scope)}`, { ...detached, unattached: true, unattached_scope }, /unattached_scope must be org or private/]),
  ...['true', 1, 0, null, {}].map(unattached =>
    [`unattached ${JSON.stringify(unattached)}`, { ...detached, unattached, unattached_scope: 'org' }, /spec\.unattached must be a boolean/]),
  ['no project and not unattached', { ...detached }, /project_id is required unless spec\.unattached is true/],
  ['unattached false without a project', { ...detached, unattached: false }, /project_id is required/],
  ['empty project', { ...detached, project_id: '' }, /project_id is required/],
  ...['', 'default', 'CUSTOM', 'org', null, 0].map(knowledge_base_mode =>
    [`knowledge base mode ${JSON.stringify(knowledge_base_mode)}`, { ...base.spec, knowledge_base_mode }, /knowledge_base_mode must be project_default, custom or none/]),
  ['custom without an id', { ...base.spec, knowledge_base_mode: 'custom' }, /knowledge_base_id is required exactly when/],
  ...['', '   ', null, 7].map(knowledge_base_id =>
    [`custom id ${JSON.stringify(knowledge_base_id)}`, { ...base.spec, knowledge_base_mode: 'custom', knowledge_base_id }, /knowledge_base_id is required exactly when/]),
  ['id without a mode', { ...base.spec, knowledge_base_id: kbID }, /knowledge_base_id is required exactly when/],
  ['id with the project default', { ...base.spec, knowledge_base_mode: 'project_default', knowledge_base_id: kbID }, /knowledge_base_id is required exactly when/],
  ['id with no knowledge base', { ...detached, unattached: true, knowledge_base_mode: 'none', knowledge_base_id: kbID }, /knowledge_base_id is required exactly when/],
  ['camel-case scope', { ...detached, unattached: true, unattachedScope: 'org' }, /unsupported spec field: unattachedScope/],
  ['camel-case knowledge base', { ...base.spec, knowledgeBaseMode: 'none' }, /unsupported spec field: knowledgeBaseMode/],
];

test('invalid unattached and knowledge base combinations never reach a request', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
      for (const [name, spec, message] of invalidTargets) {
        const configuration = scoped(source_kind, { ...base, spec });
        for (const call of [
          () => automationAuthorizationProposal({ source_kind, operation, request_id: cardID, configuration, ...scope }),
          () => automationAuthorizationPreview({ source_kind, operation, configuration, ...scope }),
          () => automationMutation({ source_kind, configuration, ...writeProof }, source_kind, operation),
          () => automationMutation({ source_kind, ...configuration, ...writeProof }, source_kind, operation),
        ]) {
          assert.throws(call, error => error.status === 400 && message.test(error.message), `${source_kind} ${operation}: ${name}`);
        }
      }
    }
  }
});

test('a legacy flat call without a project is refused before HTTP, as Core refuses it', () => {
  assert.throws(() => automationConfiguration({ source_kind: 'timer', cronExpr: '0 9 * * *', leadMemberId: 'agent',
    ownerMemberId: 'human', title: 'Legacy' }, 'timer'), /project_id is required/);
});
