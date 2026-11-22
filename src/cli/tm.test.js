import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliPath = fileURLToPath(new URL('./tm.js', import.meta.url));

// Hermetic: every spawned CLI inherits an empty HOME, so the host's org config
// (and its tokens) never decides a result; captureRequest names the org with
// COCO_ORG_ID, the other tests pass {org} themselves.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-tm-home-'));

const readableProposal = {
  request_id: '01000000-0000-4000-8000-000000000001', source_kind: 'timer', operation: 'create',
  configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' }, schedule_kind: 'cron', cron_expr: '0 9 * * *', timezone: 'Asia/Singapore' },
};
const cardProof = {
  authorization_proposal_message_id: '1790220732844',
  authorization_card_interaction_id: '01000000-0000-4000-8000-000000000002',
};

test('notification policy consent and omission survive CLI proposal and write bodies', async () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const policy of [undefined, 'every', 'failure_only', 'none']) {
        const configuration = { lead_member_id: 'agent', owner_member_id: 'human',
          spec: { project_id: 'project', title: 'Task' },
          ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore', schedule_kind: 'cron', cron_expr: '0 9 * * *' } : {}),
          ...(policy === undefined ? {} : { result_notification_policy: policy }) };
        const proposed = await captureRequest('automation.authorization_propose', {
          org: 'org-automation', request_id: readableProposal.request_id, source_kind, operation,
          configuration, ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}),
        });
        const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
        const mutated = await captureRequest(`${route}.${operation}`, {
          org: 'org-automation', source_kind, configuration, id: 'binding', expected_version: 7, ...cardProof,
        });
        for (const body of [proposed.body.configuration, mutated.body]) {
          assert.equal(Object.hasOwn(body, 'result_notification_policy'), policy !== undefined);
          assert.equal(body.result_notification_policy, policy);
        }
        assert.equal(mutated.body.authorization_card_interaction_id, cardProof.authorization_card_interaction_id);
      }
    }
  }
});

test('notification policy validation rejects before CLI sends HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const source_kind of ['timer', 'webhook']) {
      for (const fields of [{ result_notification_policy: '' }, { result_notification_policy: null },
        { result_notification_policy: 'invalid' }, { result_notification_policy_migrated: false }]) {
        const params = { org: 'org-automation', source_kind, operation: 'update',
          request_id: readableProposal.request_id, target_binding_id: 'binding', expected_version: 7,
          configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { title: 'Task' }, ...fields } };
        const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
        for (const [command, input] of [
          ['automation.authorization_propose', params],
          ...['create', 'update'].map(operation => [`${route}.${operation}`, {
            org: params.org, source_kind, configuration: params.configuration,
            id: 'binding', expected_version: 7, ...cardProof,
          }]),
        ]) {
          const result = await new Promise(resolve => execFile(process.execPath,
            [cliPath, command, JSON.stringify(input)], {
              env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
            }, (error, stdout, stderr) => resolve({ error, stderr })));
          assert.ok(result.error, command);
          assert.match(result.stderr, /result_notification_policy/);
          assert.equal(requests, 0, `${command} sent an invalid policy`);
        }
      }
    }
    assert.equal(requests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('run history uses an authenticated GET with only bounded history query fields', async () => {
  const request = await captureRequest('event-binding.runs', { org: 'org-automation', id: 'binding', limit: 7, offset: 14, page: 9 });
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/v1/event-bindings/binding/runs?limit=7&offset=14');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
  assert.equal(request.body, undefined);
  const defaults = await captureRequest('event-binding.runs', { org: 'org-automation', id: 'binding' });
  assert.equal(defaults.url, '/api/v1/event-bindings/binding/runs');
  const boundary = await captureRequest('event-binding.runs', { org: 'org-automation', id: 'binding', limit: 100, offset: 0 });
  assert.equal(boundary.url, '/api/v1/event-bindings/binding/runs?limit=100&offset=0');
});

test('run history rejects absent scope and invalid pagination before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const invalid of [{ org: undefined }, { org: ' ' }, { id: undefined }, { id: ' ' },
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '7' }, { limit: null },
      { offset: -1 }, { offset: 2147483648 }, { offset: 1.5 }, { offset: '0' }]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'event-binding.runs', JSON.stringify({ org: 'org-automation', id: 'binding', ...invalid })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /event-binding.runs/);
    }
    assert.equal(requests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('run history preserves trigger classification and revision identity in output', async () => {
  const runs = ['manual', 'timer', 'webhook'].map((kind, i) => ({ id: `occ-${i}`, event_binding_id: 'binding', trigger_kind: kind,
    created_issue_id: `issue-${i}`, latest_issue_id: `revision-${i}`, revision_issue_ids: [`issue-${i}`, `revision-${i}`], scheduled_at: '2026-10-13T00:00:00Z' }));
  const envelope = { data: runs, request_id: 'test-request' };
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(envelope)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'event-binding.runs', JSON.stringify({ org: 'org-automation', id: 'binding' })], {
      env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ifError(result.error);
    assert.deepEqual(JSON.parse(result.stdout), runs);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('replacement eligibility is an org-scoped read with a separate operation', async () => {
  const request = await captureRequest('automation.eligibility', { org: 'org-automation', memberId: 'agent', projectId: 'project', operation: 'replace' });
  assert.equal(request.method, 'GET');
  const url = new URL(request.url, 'https://example.com');
  assert.equal(url.pathname, '/api/v1/agents/agent/automation-creation-eligibility');
  assert.equal(url.searchParams.get('operation'), 'replace');
  assert.equal(url.searchParams.get('project_id'), 'project');
});

test('Lead-change compatibility queries the current requesting Agent without mutating', async () => {
  const request = await captureRequest('automation.eligibility', { org: 'org-automation', memberId: 'current-agent', projectId: 'project', operation: 'lead_change' });
  assert.equal(request.method, 'GET');
  const url = new URL(request.url, 'https://example.com');
  assert.equal(url.pathname, '/api/v1/agents/current-agent/automation-creation-eligibility');
  assert.equal(url.searchParams.get('operation'), 'lead_change');
  assert.equal(url.searchParams.get('project_id'), 'project');
  assert.equal(request.body, undefined);
});

test('eligibility rejects missing project before sending HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const projectId of [undefined, null, '', '   ', 123]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.eligibility', JSON.stringify({
        org: 'org-automation', memberId: 'agent', operation: 'replace', projectId,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /requires projectId/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eligibility rejects operation near-misses before any HTTP request', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const operation of ['lead-change', 'LEAD_CHANGE', 'lead_change ', '', null, 7]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.eligibility', JSON.stringify({
        org: 'org-automation', memberId: 'agent', projectId: 'project', operation,
      })], {
        env: { ...process.env, COCO_ORG_ID: 'org-automation', COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error, `operation ${JSON.stringify(operation)} must fail locally`);
      assert.match(result.stderr, /operation create, update, replace or lead_change/);
      assert.equal(requests, 0, `operation ${JSON.stringify(operation)} sent HTTP`);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('trigger replacement uses desired route but original target and confirmed version', async () => {
  for (const source_kind of ['timer', 'webhook']) {
    const configuration = { ...readableProposal.configuration };
    if (source_kind === 'webhook') {
      delete configuration.schedule_kind; delete configuration.cron_expr; delete configuration.timezone;
      configuration.event_filter = '';
    }
    const proposal = { org: 'org-automation', ...readableProposal, operation: 'update', source_kind,
      target_binding_id: 'original-binding', expected_version: 7, configuration };
    const proposed = await captureRequest('automation.authorization_propose', proposal);
    assert.equal(proposed.body.operation, 'update');
    assert.equal(proposed.body.target_binding_id, 'original-binding');
    assert.equal(proposed.body.expected_version, 7);
    const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
    const updated = await captureRequest(`${route}.update`, { org: proposal.org, id: proposal.target_binding_id,
      source_kind, expected_version: proposal.expected_version, configuration, ...cardProof });
    assert.equal(updated.method, 'PUT');
    assert.equal(updated.url, `/api/v1/${route === 'event-binding' ? 'event-bindings' : 'webhooks'}/original-binding`);
    assert.equal(updated.body.expected_version, 7);
    assert.equal(updated.body.authorization_card_interaction_id, cardProof.authorization_card_interaction_id);
  }
});

test('Owner assignment sends requester separately and preserves target through mutation', async () => {
  const requester = '01000000-0000-4000-8000-000000000003';
  const target = '01000000-0000-4000-8000-000000000004';
  const configuration = { ...readableProposal.configuration, owner_member_id: target };
  const params = { org: 'org-automation', ...readableProposal,
    requester_member_id: requester, configuration };
  const request = await captureRequest('automation.authorization_propose', params);
  assert.equal(request.url, '/api/v1/automation-authorizations/proposals');
  assert.equal(request.body.requester_member_id, requester);
  assert.equal(request.body.configuration.owner_member_id, target);
  assert.equal(Object.hasOwn(request.body.configuration, 'requester_member_id'), false);
  const mutation = await captureRequest('event-binding.create', {
    org: params.org, source_kind: 'timer', requester_member_id: requester, configuration, ...cardProof,
  });
  assert.equal(Object.hasOwn(mutation.body, 'requester_member_id'), false);
  assert.deepEqual(mutation.body, { ...configuration, ...cardProof });
});

test('self-owned create and update retain the legacy proposal HTTP body even with a redundant requester', async () => {
  const requester = 'abcdefab-0000-4000-8000-000000000003';
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const configuration = { ...readableProposal.configuration, owner_member_id: requester };
      if (source_kind === 'webhook') {
        delete configuration.schedule_kind; delete configuration.cron_expr; delete configuration.timezone;
        configuration.event_filter = '';
      }
      const proposal = { ...readableProposal, operation, source_kind, configuration,
        ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) };
      const request = await captureRequest('automation.authorization_propose', {
        org: 'org-automation', ...proposal, requester_member_id: requester.toUpperCase(),
      });
      assert.equal(request.url, '/api/v1/automation-authorizations/proposals');
      assert.deepEqual(request.body, proposal);
      assert.equal(Object.hasOwn(request.body, 'requester_member_id'), false);
    }
  }
});

test('replacement proposal preserves immutable replacement identity on explicit retry', async () => {
  const proposal = { ...readableProposal, replaces_proposal_message_id: cardProof.authorization_proposal_message_id };
  for (let retry = 0; retry < 2; retry++) {
    const request = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...proposal });
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, proposal);
  }
});

test('authorization status returns authoritative data without issuing a mutation', async () => {
  const requests = [];
  let status = 'pending_confirmation';
  const response = () => ({ proposal_message_id: cardProof.authorization_proposal_message_id,
    authorization_kind: 'card', status,
    ...(status === 'confirmed' ? { card_interaction_id: cardProof.authorization_card_interaction_id } : {}) });
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: response(), request_id: 'server-request', server_time: '2026-09-30T00:00:00Z' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (status of ['pending_confirmation', 'confirmed', 'modifying', 'cancelled', 'expired', 'superseded']) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_status', JSON.stringify({
        org: 'org-automation', proposal_message_id: cardProof.authorization_proposal_message_id,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      assert.ifError(result.error);
      assert.deepEqual(JSON.parse(result.stdout), response());
    }
    assert.deepEqual(requests, Array.from({ length: 6 }, () => ({ method: 'GET',
      url: `/api/v1/automation-authorizations/proposals/${cardProof.authorization_proposal_message_id}` })));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('status and replacement identifiers reject malformed input before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const value of ['', null, 123, '01', '../other', '1'.repeat(129)]) {
      for (const [command, params] of [
        ['automation.authorization_status', { proposal_message_id: value }],
        ['automation.authorization_propose', { ...readableProposal, replaces_proposal_message_id: value }],
      ]) {
        const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', ...params })], {
          env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
        }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error);
        assert.match(result.stderr, /canonical decimal/);
      }
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test('readable proposal forwards stable request identity and canonical configuration to server only', async () => {
  const request = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...readableProposal });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/automation-authorizations/proposals');
  assert.deepEqual(request.body, readableProposal);
  const replay = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...readableProposal });
  assert.deepEqual(replay.body, request.body);
});

test('readable proposal rejects invalid request identity or missing timer timezone before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cases = [
      ...[undefined, '', 'invalid', '00000000-0000-0000-0000-000000000000'].map(request_id => [{ ...readableProposal, request_id }, /request_id must be a UUID/]),
      ...[undefined, null, '', '   '].map(timezone => [{ ...readableProposal, configuration: { ...readableProposal.configuration, timezone } }, /explicit timezone/]),
    ];
    for (const [proposal, errorMessage] of cases) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_propose', JSON.stringify({
        org: 'org-automation', ...proposal,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, errorMessage);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('successful readable proposal returns the server receipt without a second message send', async () => {
  const requests = [];
  const response = { data: {
    proposal_message_id: '1790220732844', conversation_id: 'owner-agent-dm',
    proposal_text: 'Daily report at 09:00 Asia/Singapore.',
  }, request_id: 'server-request', server_time: '2026-09-29T00:00:00Z' };
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_propose', JSON.stringify({
      org: 'org-automation', ...readableProposal,
    })], {
      env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ifError(result.error);
    assert.deepEqual(JSON.parse(result.stdout), response.data);
    assert.deepEqual(requests, [{ method: 'POST', url: '/api/v1/automation-authorizations/proposals' }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('authorization preview forwards final configuration and update scope', async () => {
  const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' }, cron_expr: '0 9 * * *' };
  const request = await captureRequest('automation.authorization_preview', {
    org: 'org-automation', source_kind: 'timer', operation: 'update', target_binding_id: 'binding-1', expected_version: 3, configuration,
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/automation-authorizations/preview');
  assert.deepEqual(request.body, { source_kind: 'timer', operation: 'update', target_binding_id: 'binding-1', expected_version: 3, configuration });
});

for (const [kind, prefix, path] of [['timer', 'event-binding', 'event-bindings'], ['webhook', 'webhook', 'webhooks']]) {
  test(`${kind} update card proposal preserves target and version through mutation`, async () => {
    const configuration = kind === 'timer' ? readableProposal.configuration : {
      lead_member_id: 'agent', owner_member_id: 'human',
      spec: { project_id: 'project', title: 'Changed task' }, event_filter: 'event.type == "new"',
    };
    const plan = { request_id: readableProposal.request_id, source_kind: kind,
      operation: 'update', target_binding_id: 'binding-1', expected_version: 7, configuration };
    const proposal = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...plan });
    assert.equal(proposal.url, '/api/v1/automation-authorizations/proposals');
    assert.deepEqual(proposal.body, plan);
    const update = await captureRequest(`${prefix}.update`, { org: 'org-automation',
      id: plan.target_binding_id, expected_version: plan.expected_version,
      source_kind: kind, configuration, ...cardProof });
    assert.equal(update.method, 'PUT');
    assert.equal(update.url, `/api/v1/${path}/binding-1`);
    assert.deepEqual(update.body, { ...configuration, expected_version: 7, ...cardProof });
    assert.equal(Object.hasOwn(update.body, 'webhook_url'), false);
  });

  for (const operation of ['create', 'update']) {
    test(`${kind} ${operation} forwards exclusive card proof without lifecycle claims`, async () => {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
      const request = await captureRequest(`${prefix}.${operation}`, { org: 'org-automation', id: 'binding-1', expected_version: 3,
        source_kind: kind, configuration, ...cardProof, status: 'created', authorization_kind: 'card' });
      assert.equal(request.method, operation === 'create' ? 'POST' : 'PUT');
      assert.equal(request.url, `/api/v1/${path}${operation === 'create' ? '' : '/binding-1'}`);
      assert.deepEqual(request.body, { ...configuration, ...cardProof, ...(operation === 'update' ? { expected_version: 3 } : {}) });
    });
    test(`${kind} ${operation} forwards proof and full replacement version`, async () => {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
      const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
      const request = await captureRequest(`${prefix}.${operation}`, { org: 'org-automation', id: 'binding-1', expected_version: 3, source_kind: kind, configuration, ...proof });
      assert.equal(request.method, operation === 'create' ? 'POST' : 'PUT');
      assert.equal(request.url, `/api/v1/${path}${operation === 'create' ? '' : '/binding-1'}`);
      assert.deepEqual(request.body, { ...configuration, ...proof, ...(operation === 'update' ? { expected_version: 3 } : {}) });
    });
  }
  test(`${kind} mutations reject missing update proof and partial proof before HTTP`, async () => {
    let requests = 0;
    const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
      const cases = [['update', {}]];
      for (const operation of ['create', 'update']) {
        cases.push([operation, { authorization_proposal_message_id: proof.authorization_proposal_message_id }]);
        cases.push([operation, { authorization_confirmation_message_id: proof.authorization_confirmation_message_id }]);
        for (const field of Object.keys(proof)) cases.push([operation, { ...proof, [field]: ' ' }]);
        cases.push([operation, { ...proof, ...cardProof }]);
        cases.push([operation, { authorization_card_interaction_id: cardProof.authorization_card_interaction_id }]);
        for (const invalid of ['', null, 1, '1790220732845', '00000000-0000-0000-0000-000000000000']) {
          cases.push([operation, { ...cardProof, authorization_card_interaction_id: invalid }]);
        }
      }
      for (const [operation, authorization] of cases) {
        const result = await new Promise(resolve => execFile(process.execPath, [cliPath, `${prefix}.${operation}`, JSON.stringify({
          org: 'org-automation', id: 'binding-1', expected_version: 3, source_kind: kind,
          configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } },
          ...authorization,
        })], {
          env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
        }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error, `${prefix}.${operation} must reject ${JSON.stringify(authorization)}`);
        assert.match(result.stderr, /requires both authorization|canonical decimal|canonical nonzero UUID/);
      }
      assert.equal(requests, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('ordinary delivery preserves the empty-body acceptance workflow', async () => {
  const request = await captureRequest('issue.deliver', { org: 'org-automation', id: 'issue-1' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/issues/issue-1/deliver');
  assert.equal(request.body, undefined);
});

const authorizationProof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
for (const [command, params, retry] of [
  ['automation.authorization_propose', readableProposal, false],
  ...['event-binding', 'webhook'].flatMap(prefix => {
    const source_kind = prefix === 'event-binding' ? 'timer' : 'webhook';
    const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
    return [
      [`${prefix}.create`, { source_kind, configuration, ...authorizationProof }, false],
      [`${prefix}.update`, { source_kind, configuration, expected_version: 3, ...authorizationProof }, false],
      [`${prefix}.create`, { source_kind, configuration, ...cardProof }, false],
      [`${prefix}.update`, { source_kind, configuration, expected_version: 3, ...cardProof }, false],
      [`${prefix}.create`, { leadMemberId: 'agent', ownerMemberId: 'human', projectId: 'project', title: 'Legacy task' }, false],
    ];
  }),
  ['issue.deliver', { summary: 'Recorded result', outcome: 'success', idempotencyKey: 'delivery-1' }, false],
  ['issue.create_revision', { description: 'Correct result', originMessageId: '1790220732845', idempotencyKey: 'revision-1' }, false],
  ['issue.deliver', {}, true],
]) {
  test(`${command} ${params.title ? 'legacy create' : params.summary ? 'structured result' : retry ? 'ordinary' : 'automation'} ${retry ? 'retains' : 'disables'} 401 replay`, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(requests === 1 ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests === 1 ? { error: { detail: 'Original unauthorized response' } } : { ok: true }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'binding-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      if (retry) {
        assert.ifError(result.error);
      } else {
        assert.ok(result.error);
        assert.match(result.stderr, /Original unauthorized response/);
        assert.match(result.stderr, /401/);
      }
      assert.equal(requests, retry ? 2 : 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const [command, params] of [
  ['automation.authorization_propose', readableProposal],
  ['issue.deliver', { summary: 'Recorded result', outcome: 'success', idempotencyKey: 'delivery-1' }],
  ['issue.create_revision', { description: 'Correct result', originMessageId: 'human-1', idempotencyKey: 'revision-1' }],
]) {
  test(`${command} preserves ambiguous write failure without automatic replay or fallback`, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { detail: 'write outcome unknown' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'issue-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /write outcome unknown/);
      assert.equal(requests, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const outcome of ['success', 'partial', 'failed']) {
  test(`structured delivery forwards ${outcome} without caller-defined lifecycle or sender`, async () => {
    const request = await captureRequest('issue.deliver', {
      org: 'org-automation', id: 'issue-1', summary: 'Result summary', outcome,
      idempotencyKey: 'delivery-1', artifacts: [{ title: 'Report', url: 'https://example.com/report', injected: true }],
      automation_policy: 'silent', source: 'text_card_proxy', conversationId: 'wrong-dm', leadAgentId: 'wrong-agent',
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/issues/issue-1/deliver');
    assert.deepEqual(request.body, {
      summary: 'Result summary', outcome, idempotency_key: 'delivery-1',
      artifacts: [{ title: 'Report', url: 'https://example.com/report' }],
    });
  });
}

test('linked revision submits the human-message reference but no inherited policy claims', async () => {
  const request = await captureRequest('issue.create_revision', {
    org: 'org-automation', id: 'issue-1', description: 'Correct this report',
    originMessageId: '1789717014187', idempotencyKey: 'revision-1',
    automationPolicy: 'silent', ownerMemberId: 'spoofed-owner', leadAgentId: 'spoofed-agent',
  });
  assert.equal(request.url, '/api/v1/issues/issue-1/revisions');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, {
    description: 'Correct this report', origin_message_id: '1789717014187', idempotency_key: 'revision-1',
  });
});

test('incomplete or malformed automation result and revision fail before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [command, params] of [
      ['issue.deliver', { summary: 'Missing outcome/key' }],
      ['issue.deliver', { summary: ' ', outcome: 'success', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: { text: 'Wrong type' }, outcome: 'success', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: 'Invalid outcome', outcome: 'accepted', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: 'Invalid artifact', outcome: 'success', idempotencyKey: 'd1', artifacts: [{}] }],
      ['issue.create_revision', { description: 'Missing human message/key' }],
      ['issue.create_revision', { description: 'Correction', originMessageId: ' ', idempotencyKey: 'r1' }],
      ['issue.create_revision', { description: 'Correction', originMessageId: 1789717014187, idempotencyKey: 'r1' }],
    ]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'issue-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /requires|outcome must|artifacts must/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('wrong route and unsupported fields fail before HTTP submission', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const params of [
      { source_kind: 'timer', configuration: { schedule_kind: 'cron', cron_expr: '0 9 * * 1', timezone: 'UTC' } },
      { source_kind: 'webhook', configuration: { schedule_kind: 'cron' } },
      { source_kind: 'webhook', configuration: { spec: { title: 'Task', unsupported: true } } },
    ]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'webhook.create', JSON.stringify({ org: 'org-automation', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /source_kind must be webhook|unsupported/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('update proposals and writes reject unknown configuration without any HTTP fallback', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const kind of ['timer', 'webhook']) {
      for (const command of ['automation.authorization_propose', kind === 'timer' ? 'event-binding.update' : 'webhook.update']) {
        const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({
          org: 'org-automation', request_id: readableProposal.request_id, operation: 'update',
          target_binding_id: 'binding-1', id: 'binding-1', expected_version: 7, source_kind: kind,
          configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { title: 'Task' },
            unexpected_envelope_field: true }, ...cardProof,
        })], {
          env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
        }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error);
        assert.match(result.stderr, /unsupported .* configuration field/);
      }
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

for (const schedule of [
  { schedule_kind: 'cron', cron_expr: '0 9 * * 1', timezone: 'Asia/Singapore' },
  { schedule_kind: 'once', run_at: '2030-01-01T01:00:00Z', timezone: 'America/New_York' },
  { schedule_kind: 'interval', interval_seconds: 90, anchor_at: '2030-01-01T01:00:00Z', timezone: 'UTC' },
]) {
  test(`automation create preserves ${schedule.schedule_kind} form configuration`, async () => {
    const configuration = {
      lead_member_id: 'agent', owner_member_id: 'human',
      spec: { project_id: 'project', title: 'Review', description: 'Inputs and output destination' },
      ...schedule,
    };
    const request = await captureRequest('event-binding.create', {
      org: 'org-automation', source_kind: 'timer', request_id: 'not-an-idempotency-key', configuration,
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/event-bindings');
    assert.deepEqual(request.body, configuration);
  });
}

test('legacy cron creation remains compatible', async () => {
  const request = await captureRequest('event-binding.create', {
    org: 'org-automation', cronExpr: '0 9 * * 1', leadMemberId: 'agent',
    ownerMemberId: 'human', projectId: 'project', title: 'Legacy',
  });
  assert.deepEqual(request.body, {
    cron_expr: '0 9 * * 1', lead_member_id: 'agent', owner_member_id: 'human',
    spec: { project_id: 'project', title: 'Legacy' },
  });
});

test('webhook create preserves filter without forwarding envelope fields', async () => {
  const configuration = {
    lead_member_id: 'agent', owner_member_id: 'human',
    spec: { project_id: 'project', title: 'Incoming', description: '' },
    event_filter: 'payload.type == "ready"',
  };
  const request = await captureRequest('webhook.create', {
    org: 'org-automation', configuration, source_kind: 'webhook',
  });
  assert.equal(request.url, '/api/v1/webhooks');
  assert.deepEqual(request.body, configuration);
  const read = await captureRequest('webhook.get', { org: 'org-automation', id: 'binding' });
  assert.equal(read.method, 'GET');
  assert.equal(read.url, '/api/v1/webhooks/binding');
});

test('ambiguous webhook server failure does not retry creation', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { detail: 'write outcome unknown' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'webhook.create', JSON.stringify({
      org: 'org-automation', source_kind: 'webhook', configuration: {
        lead_member_id: 'agent', owner_member_id: 'human',
        spec: { project_id: 'project', title: 'Incoming' }, event_filter: '',
      },
    })], { env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
      COCO_AUTH_TOKEN: 'contract-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ok(result.error);
    assert.match(result.stderr, /write outcome unknown/);
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

async function captureRequest(command, params) {
  let resolveRequest;
  const requestPromise = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      resolveRequest({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const processPromise = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      {
        env: {
          ...process.env,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_ORG_ID: 'org-test',
          COCO_RPC_LOG: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tm.js failed: ${stderr || stdout}`));
          return;
        }
        resolve();
      },
    );
  });

  try {
    const [request] = await Promise.all([requestPromise, processPromise]);
    return request;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureFailure(command, params) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      { env: { ...process.env, COCO_RPC_LOG: '0' } },
      (error, stdout, stderr) => {
        if (!error) {
          reject(new Error(`tm.js unexpectedly succeeded: ${stdout}`));
          return;
        }
        resolve(JSON.parse(stderr));
      },
    );
  });
}

test('project.create forwards atomic project fields and documented auth token', async () => {
  const request = await captureRequest('project.create', {
    name: 'Semantic alignment',
    leadMemberId: 'lead-1',
    knowledgeBaseId: 'kb-1',
    memberIds: ['member-1', 'member-2'],
    isDefault: true,
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/projects');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
  assert.deepEqual(request.body, {
    name: 'Semantic alignment',
    lead_member_id: 'lead-1',
    knowledge_base_id: 'kb-1',
    member_ids: ['member-1', 'member-2'],
    is_default: true,
  });
});

test('project.update preserves omitted KB and forwards an explicitly selected KB', async () => {
  const unchanged = await captureRequest('project.update', { id: 'project-1', name: 'Renamed' });
  assert.equal(unchanged.method, 'PATCH');
  assert.equal(unchanged.url, '/api/v1/projects/project-1');
  assert.deepEqual(unchanged.body, { name: 'Renamed' });
  const changed = await captureRequest('project.update', { id: 'project-1', knowledgeBaseId: 'kb-2' });
  assert.deepEqual(changed.body, { knowledge_base_id: 'kb-2' });
});

test('project and organization issue searches forward query', async () => {
  const projectRequest = await captureRequest('project.list', { query: 'alpha' });
  const issueRequest = await captureRequest('issue.list', { query: 'beta' });

  assert.equal(projectRequest.url, '/api/v1/projects?query=alpha');
  assert.equal(issueRequest.url, '/api/v1/issues?query=beta');
});

const issueListCommands = [
  { command: 'issue.list', params: {}, path: '/api/v1/issues' },
  { command: 'issue.list_in_project', params: { projectId: 'project-1' }, path: '/api/v1/projects/project-1/issues' },
];

for (const { command, params, path: listPath } of issueListCommands) {
  test(`${command} sends include_automation=true only when includeAutomation is true`, async () => {
    const included = await captureRequest(command, { ...params, includeAutomation: true });
    assert.equal(included.method, 'GET');
    assert.equal(included.url, `${listPath}?include_automation=true`);

    const absent = await captureRequest(command, params);
    assert.equal(absent.url, listPath);
    assert.equal(new URL(absent.url, 'http://cli.test').searchParams.has('include_automation'), false);

    const explicitFalse = await captureRequest(command, { ...params, includeAutomation: false });
    assert.equal(explicitFalse.url, listPath);
  });

  test(`${command} rejects a non-boolean includeAutomation before HTTP`, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], request_id: 'test-request' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const invalid of ['true', 1, null, 'false', 0]) {
        const result = await new Promise(resolve => execFile(process.execPath,
          [cliPath, command, JSON.stringify({ ...params, includeAutomation: invalid })], {
            env: {
              ...process.env,
              COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
              COCO_API_PREFIX: '/api/v1',
              COCO_AUTH_TOKEN: 'cli-contract-token',
              COCO_USER_TOKEN: '',
              COCO_ORG_ID: 'org-test',
              COCO_RPC_LOG: '0',
            },
            timeout: 5000,
          }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error, `${JSON.stringify(invalid)} must be rejected`);
        const { error } = JSON.parse(result.stderr);
        assert.match(error, new RegExp(`^${command.replace('.', '\\.')} includeAutomation must be true or false`));
        assert.ok(error.endsWith(`got ${JSON.stringify(invalid)}`), error);
      }
      assert.equal(requests, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test(`${command} combines includeAutomation with archive, status and page params`, async () => {
    const request = await captureRequest(command, {
      ...params,
      includeAutomation: true,
      includeArchived: true,
      statuses: 'accepted,terminated',
      orderBy: 'created_at:desc',
      pageSize: 100,
    });
    const url = new URL(request.url, 'http://cli.test');
    assert.equal(url.pathname, listPath);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      statuses: 'accepted,terminated',
      include_archived: 'true',
      include_automation: 'true',
      page_size: '100',
      order_by: 'created_at:desc',
    });
  });
}

test('issue.create preserves backlog presence and requires owner and lead', async () => {
  const backlogRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Record discovered issue',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
  });
  assert.equal(Object.hasOwn(backlogRequest.body, 'backlog'), false);

  const immediateRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Start immediately',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
    backlog: false,
  });
  assert.equal(immediateRequest.body.backlog, false);

  const failure = await captureFailure('issue.create', {
    projectId: 'project-1',
    title: 'Missing ownership',
  });
  assert.match(failure.error, /leadAgentId, ownerMemberId/);
});

test('issue.accept_delivered defaults to the Lead text-card proxy source', async () => {
  const proxyRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
  });
  assert.equal(proxyRequest.method, 'POST');
  assert.equal(proxyRequest.url, '/api/v1/issues/issue-1/accept-delivered');
  assert.deepEqual(proxyRequest.body, { source: 'text_card_proxy' });

  const explicitRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
    source: 'explicit',
  });
  assert.deepEqual(explicitRequest.body, { source: 'explicit' });
});

test('comment.list uses cursor pagination', async () => {
  const request = await captureRequest('comment.list', {
    workType: 'task',
    workId: 'task-1',
    cursor: 'cursor-1',
    limit: 25,
    orderBy: 'created_at desc',
  });

  const url = new URL(request.url, 'http://localhost');
  assert.equal(url.searchParams.get('work_type'), 'task');
  assert.equal(url.searchParams.get('work_id'), 'task-1');
  assert.equal(url.searchParams.get('cursor'), 'cursor-1');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('order_by'), 'created_at desc');
  assert.equal(url.searchParams.has('page'), false);
  assert.equal(url.searchParams.has('page_size'), false);
});

test('project member commands match BFF paths and bodies', async () => {
  const addRequest = await captureRequest('project.member_add', {
    id: 'project-1',
    memberId: 'member-1',
  });
  const removeRequest = await captureRequest('project.member_remove', {
    id: 'project-1',
    memberId: 'member-1',
  });

  assert.equal(addRequest.method, 'POST');
  assert.equal(addRequest.url, '/api/v1/projects/project-1/members');
  assert.deepEqual(addRequest.body, { member_id: 'member-1', role: 'member' });
  assert.equal(removeRequest.method, 'DELETE');
  assert.equal(removeRequest.url, '/api/v1/projects/project-1/members/member-1');
});

test('confirmed project member additions reach proposal and every write route', async () => {
  const lead = '01000000-0000-4000-8000-0000000000a1';
  const owner = '01000000-0000-4000-8000-0000000000b2';
  for (const source_kind of ['timer', 'webhook']) {
    const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
    const path = source_kind === 'timer' ? '/api/v1/event-bindings' : '/api/v1/webhooks';
    for (const operation of ['create', 'update']) {
      for (const additions of [[lead], [owner], [lead, owner]]) {
        const configuration = { lead_member_id: lead, owner_member_id: owner, spec: { project_id: 'project', title: 'Task' },
          ...(source_kind === 'timer' ? { schedule_kind: 'cron', cron_expr: '0 9 * * *', timezone: 'Asia/Singapore' } : {}),
          project_member_additions: additions };
        const scope = operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {};
        const proposed = await captureRequest('automation.authorization_propose', {
          org: 'org-automation', request_id: readableProposal.request_id, source_kind, operation, configuration, ...scope,
        });
        assert.equal(proposed.url, '/api/v1/automation-authorizations/proposals');
        assert.deepEqual(proposed.body.configuration, configuration);
        assert.equal(Object.hasOwn(proposed.body, 'project_member_additions'), false);
        const nested = await captureRequest(`${route}.${operation}`, {
          org: 'org-automation', source_kind, configuration, id: 'binding', expected_version: 7, ...cardProof,
        });
        const flat = await captureRequest(`${route}.${operation}`, {
          org: 'org-automation', source_kind, ...configuration, id: 'binding', expected_version: 7, ...cardProof,
        });
        for (const mutated of [nested, flat]) {
          assert.equal(mutated.method, operation === 'create' ? 'POST' : 'PUT');
          assert.equal(mutated.url, operation === 'create' ? path : `${path}/binding`);
          assert.deepEqual(mutated.body.project_member_additions, additions);
          assert.equal(Object.hasOwn(mutated.body, 'configuration'), false);
          assert.equal(mutated.body.authorization_card_interaction_id, cardProof.authorization_card_interaction_id);
        }
      }
      const omitted = await captureRequest(`${route}.${operation}`, {
        org: 'org-automation', source_kind, id: 'binding', expected_version: 7, ...cardProof,
        configuration: { lead_member_id: lead, owner_member_id: owner, spec: { project_id: 'project', title: 'Task' } },
      });
      assert.equal(Object.hasOwn(omitted.body, 'project_member_additions'), false);
    }
  }
});

test('invalid project member additions are rejected before CLI sends HTTP', async () => {
  const lead = '01000000-0000-4000-8000-0000000000a1';
  const owner = '01000000-0000-4000-8000-0000000000b2';
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const source_kind of ['timer', 'webhook']) {
      const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
      for (const project_member_additions of [['01000000-0000-4000-8000-0000000000c3'], [lead, lead],
        [lead, owner, owner], lead, null, ['']]) {
        const configuration = { lead_member_id: lead, owner_member_id: owner, spec: { project_id: 'project', title: 'Task' },
          ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}), project_member_additions };
        for (const [command, input] of [
          ['automation.authorization_propose', { source_kind, operation: 'update', request_id: readableProposal.request_id,
            target_binding_id: 'binding', expected_version: 7, configuration }],
          ['automation.authorization_preview', { source_kind, operation: 'create', configuration }],
          ...['create', 'update'].map(operation => [`${route}.${operation}`,
            { source_kind, configuration, id: 'binding', expected_version: 7, ...cardProof }]),
          [`${route}.create`, { source_kind, ...configuration, ...cardProof }],
        ]) {
          const result = await new Promise(resolve => execFile(process.execPath,
            [cliPath, command, JSON.stringify({ org: 'org-automation', ...input })], {
              env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
            }, (error, stdout, stderr) => resolve({ error, stderr })));
          assert.ok(result.error, command);
          assert.match(result.stderr, /project_member_additions/);
          assert.equal(requests, 0, `${command} sent invalid project member additions`);
        }
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// OPENM-1305 / OPENM-1308: unattached and knowledge base spec fields.
const unattachedSpecs = [
  { title: 'Task', unattached: true, unattached_scope: 'org' },
  { title: 'Task', unattached: true, unattached_scope: 'private', knowledge_base_mode: 'none' },
  { project_id: 'project', title: 'Task', knowledge_base_mode: 'custom', knowledge_base_id: '01000000-0000-4000-8000-0000000000d4' },
];

test('unattached and knowledge base specs reach the proposal and every write route verbatim', async () => {
  for (const source_kind of ['timer', 'webhook']) {
    const route = source_kind === 'timer' ? 'event-binding' : 'webhook';
    for (const spec of unattachedSpecs) {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec,
        ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore', schedule_kind: 'cron', cron_expr: '0 9 * * *' } : {}) };
      for (const operation of ['create', 'update']) {
        const proposed = await captureRequest('automation.authorization_propose', {
          org: 'org-automation', request_id: readableProposal.request_id, source_kind, operation, configuration,
          ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}),
        });
        assert.deepEqual(proposed.body.configuration.spec, spec);
        const written = await captureRequest(`${route}.${operation}`, {
          org: 'org-automation', source_kind, configuration, id: 'binding', expected_version: 7, ...cardProof,
        });
        assert.deepEqual(written.body.spec, spec);
        const flat = await captureRequest(`${route}.${operation}`, {
          org: 'org-automation', source_kind, ...configuration, id: 'binding', expected_version: 7, ...cardProof,
        });
        assert.deepEqual(flat.body.spec, spec, 'flat calls drop no target field and add no project');
      }
    }
  }
});

test('invalid unattached or knowledge base combinations fail before CLI sends HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [spec, message] of [
      [{ title: 'Task', unattached_scope: 'org' }, /project_id is required/],
      [{ project_id: 'project', title: 'Task', unattached: true, unattached_scope: 'org' }, /unattached_scope applies only/],
      [{ title: 'Task', unattached: true, unattached_scope: 'public' }, /unattached_scope must be org or private/],
      [{ title: 'Task', unattached: 'true' }, /spec\.unattached must be a boolean/],
      [{ project_id: 'project', title: 'Task', knowledge_base_mode: 'custom' }, /knowledge_base_id is required exactly/],
      [{ project_id: 'project', title: 'Task', knowledge_base_mode: 'shared' }, /knowledge_base_mode must be/],
    ]) {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec, timezone: 'Asia/Singapore' };
      for (const [command, input] of [
        ['automation.authorization_propose', { source_kind: 'timer', operation: 'create', request_id: readableProposal.request_id, configuration }],
        ['event-binding.update', { source_kind: 'timer', configuration, id: 'binding', expected_version: 7, ...cardProof }],
      ]) {
        const result = await new Promise(resolve => execFile(process.execPath,
          [cliPath, command, JSON.stringify({ org: 'org-automation', ...input })], {
            env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
          }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error, `${command} ${JSON.stringify(spec)}`);
        assert.match(result.stderr, message);
        assert.equal(requests, 0, `${command} sent ${JSON.stringify(spec)}`);
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('eligibility for an automation attached to no project sends unattached_scope instead of project_id', async () => {
  for (const operation of ['lead_change', 'replace']) {
    for (const unattachedScope of ['org', 'private']) {
      const request = await captureRequest('automation.eligibility', { org: 'org-automation', memberId: 'agent', operation, unattachedScope });
      assert.equal(request.method, 'GET');
      const url = new URL(request.url, 'https://example.com');
      assert.equal(url.pathname, '/api/v1/agents/agent/automation-creation-eligibility');
      assert.equal(url.searchParams.get('operation'), operation);
      assert.equal(url.searchParams.get('unattached_scope'), unattachedScope);
      assert.equal(url.searchParams.has('project_id'), false);
      assert.equal(request.body, undefined);
    }
  }
  const attached = new URL((await captureRequest('automation.eligibility', {
    org: 'org-automation', memberId: 'agent', operation: 'replace', projectId: 'project' })).url, 'https://example.com');
  assert.equal(attached.searchParams.has('unattached_scope'), false);
});

test('eligibility refuses an invalid scope or both targets before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const target of [
      ...['', 'ORG', 'public', null, 1, ['org']].map(unattachedScope => ({ unattachedScope })),
      { unattachedScope: 'org', projectId: 'project' },
      { unattachedScope: 'private', projectId: '' },
    ]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.eligibility', JSON.stringify({
        org: 'org-automation', memberId: 'agent', operation: 'lead_change', ...target,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error, JSON.stringify(target));
      assert.match(result.stderr, /unattachedScope must be org or private, without projectId/);
    }
    assert.equal(requests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// ── Pause / resume / run once an existing automation (OPENM-1376) ──────────

async function runAgainst(handler, command, input, { raw = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      const [status, body] = handler(req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, raw ? input : JSON.stringify(input)], {
      env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_API_PREFIX: '/api/v1',
        COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    return { ...result, requests };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

const coreError = (status, code, detail) => [status, { error: { title: 'x', status, detail, code }, request_id: 'r' }];

test('pause and resume POST only expected_version to the encoded binding path', async () => {
  for (const action of ['pause', 'resume']) {
    const request = await captureRequest(`event-binding.${action}`, {
      org: 'org-automation', id: 'binding/1 x', expected_version: 7, note: 'asked by owner', confirm_paused: true,
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/api/v1/event-bindings/binding%2F1%20x/${action}`);
    assert.equal(request.authorization, 'Bearer cli-contract-token');
    assert.deepEqual(request.body, { expected_version: 7 });
  }
});

test('run POSTs version and idempotency key, and confirm_paused only when true', async () => {
  const base = { org: 'org-automation', id: 'binding', expected_version: 3, idempotency_key: 'chat-run:1790220732844' };
  const plain = await captureRequest('event-binding.run', base);
  assert.equal(plain.method, 'POST');
  assert.equal(plain.url, '/api/v1/event-bindings/binding/run');
  assert.deepEqual(plain.body, { expected_version: 3, idempotency_key: 'chat-run:1790220732844' });
  const notPaused = await captureRequest('event-binding.run', { ...base, confirm_paused: false, note: 'x' });
  assert.deepEqual(notPaused.body, { expected_version: 3, idempotency_key: 'chat-run:1790220732844' });
  const paused = await captureRequest('event-binding.run', { ...base, confirm_paused: true });
  assert.deepEqual(paused.body, { expected_version: 3, idempotency_key: 'chat-run:1790220732844', confirm_paused: true });
  // 128 bytes is the server's limit, counted in UTF-8 bytes.
  const longest = await captureRequest('event-binding.run', { ...base, idempotency_key: 'k'.repeat(128) });
  assert.equal(longest.body.idempotency_key.length, 128);
});

test('pause, resume and run reject bad parameters before any request', async () => {
  const valid = { org: 'org-automation', id: 'binding', expected_version: 3, idempotency_key: 'chat-run:1' };
  const versionCases = [{ org: undefined }, { org: ' ' }, { id: undefined }, { id: '' }, { id: 7 },
    { expected_version: undefined }, { expected_version: 0 }, { expected_version: -1 }, { expected_version: 1.5 },
    { expected_version: '3' }, { expected_version: null }, { expected_version: 2 ** 53 }];
  const runCases = [{ idempotency_key: undefined }, { idempotency_key: '' }, { idempotency_key: '   ' },
    { idempotency_key: 12 }, { idempotency_key: 'k'.repeat(129) }, { idempotency_key: '键'.repeat(43) },
    { idempotency_key: 'a\u0000b' }, { idempotency_key: 'a\ud800b' },
    { confirm_paused: 'true' }, { confirm_paused: 1 }, { confirm_paused: null }];
  for (const [command, cases] of [['event-binding.pause', versionCases], ['event-binding.resume', versionCases],
    ['event-binding.run', [...versionCases, ...runCases]]]) {
    for (const invalid of cases) {
      const result = await runAgainst(() => [200, { data: {}, request_id: 'r' }], command, { ...valid, ...invalid });
      assert.ok(result.error, `${command} ${JSON.stringify(invalid)}`);
      assert.match(result.stderr, new RegExp(command.replace('.', '\\.')));
      assert.equal(result.requests.length, 0, `${command} sent a request for ${JSON.stringify(invalid)}`);
      // Nothing was sent: its own category, never "outcome unknown" or a refusal.
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.code, 'INVALID_PARAMS', `${command} ${JSON.stringify(invalid)}`);
      assert.equal(payload.sent, false);
      assert.equal(payload.status, 400);
      assert.equal(payload.refused, undefined);
    }
  }
});

test('pause and run return the server data unchanged', async () => {
  const binding = { id: 'binding', display_status: 'paused', pause_reason: 'user', version: 8, next_trigger_at: '2026-11-19T01:00:00Z' };
  const paused = await runAgainst(() => [200, { data: binding, request_id: 'r' }], 'event-binding.pause',
    { org: 'org-automation', id: 'binding', expected_version: 7 });
  assert.equal(paused.error, null);
  assert.deepEqual(JSON.parse(paused.stdout), binding);
  const run = { occurrence: { id: 'occ', created_issue_id: 'issue', status: 'created' }, reused: true };
  const ran = await runAgainst(() => [200, { data: run, request_id: 'r' }], 'event-binding.run',
    { org: 'org-automation', id: 'binding', expected_version: 7, idempotency_key: 'chat-run:1' });
  assert.deepEqual(JSON.parse(ran.stdout), run);
});

test('refusals are mapped to stable codes; transient failures stay unmapped and are not retried', async () => {
  const input = { org: 'org-automation', id: 'binding', expected_version: 7, idempotency_key: 'chat-run:1' };
  for (const [response, expected] of [
    [coreError(403, 'WORK_ERROR', 'an agent may only manage its own event binding'), 'NOT_LEAD'],
    [coreError(404, 'WORK_EVENT_BINDING_NOT_FOUND', 'event binding not found'), 'NOT_FOUND'],
    [coreError(409, 'WORK_EVENT_BINDING_VERSION_CONFLICT', 'event binding version conflict'), 'VERSION_CONFLICT'],
    [coreError(412, 'WORK_ERROR', 'paused automation requires confirmation to run once'), 'CONFIRM_PAUSED_REQUIRED'],
    [coreError(412, 'WORK_ERROR', 'automation must be repaired or rescheduled before running'), 'RUN_NOT_ALLOWED'],
    [coreError(412, 'AUTOMATION_ORG_SUSPENDED', 'organization is suspended'), 'ORG_SUSPENDED'],
    [coreError(400, 'WORK_ERROR', 'event binding: only timer source kind is supported in v0.7'), 'UNSUPPORTED_SOURCE_KIND'],
    [coreError(400, 'WORK_ERROR', 'event binding: invalid timer schedule'), 'NO_NEXT_TRIGGER'],
    [coreError(400, 'WORK_EVENT_BINDING_LEAD_PROJECT_ACCESS_REQUIRED', 'lead must be a member'), 'LEAD_PROJECT_ACCESS_REQUIRED'],
    [coreError(403, 'WORK_OWNER_PROJECT_ACCESS_REQUIRED', 'owner must be a member'), 'OWNER_PROJECT_ACCESS_REQUIRED'],
    [coreError(412, 'WORK_MEMBER_DEPARTED', 'member has departed'), 'MEMBER_UNAVAILABLE'],
    [coreError(403, 'AUTOMATION_PRIVATE_LEAD_NOT_OWNED', 'lead not owned'), 'PRIVATE_LEAD_OWNER_CHANGED'],
    [coreError(412, 'WORK_PROJECT_ALREADY_ARCHIVED', 'project is already archived'), 'PROJECT_UNAVAILABLE'],
    [coreError(404, 'WORK_ERROR', 'project not found'), 'PROJECT_UNAVAILABLE'],
    [coreError(412, 'WORK_ERROR', 'something new'), 'REFUSED'],
    [coreError(422, 'VALIDATION_FAILED', 'validation failed'), 'REFUSED'],
    // A 403 with another specific code is not Work's Lead check.
    [coreError(403, 'WORK_PROJECT_ACCESS_FORBIDDEN', 'project access forbidden'), 'REFUSED'],
  ]) {
    for (const command of ['event-binding.pause', 'event-binding.resume', 'event-binding.run']) {
      const result = await runAgainst(() => response, command, input);
      assert.ok(result.error);
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.code, expected, `${command} ${response[1].error.code} ${response[1].error.detail}`);
      assert.equal(payload.refused, true);
      assert.equal(payload.status, response[0]);
      assert.equal(payload.error, response[1].error.detail);
      assert.equal(payload.platform_code, response[1].error.code);
      assert.equal(typeof payload.reason, 'string');
      assert.equal(payload.sent, undefined, 'a server answer is never sent:false');
      assert.equal(result.requests.length, 1);
    }
  }
  for (const response of [coreError(502, 'WORK_ERROR', 'upstream service error'), coreError(503, 'SYS_UNAVAILABLE', 'unavailable'),
    coreError(401, 'UNAUTHORIZED', 'unauthorized'), coreError(408, 'SYS_TIMEOUT', 'request timeout'),
    coreError(429, 'RATE_LIMITED', 'slow down')]) {
    for (const command of ['event-binding.pause', 'event-binding.run']) {
      const result = await runAgainst(() => response, command, input);
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.status, response[0]);
      assert.equal(payload.refused, undefined, `${command} ${response[0]} must not look like a refusal`);
      assert.equal(payload.code, undefined);
      assert.equal(payload.sent, undefined);
      assert.equal(result.requests.length, 1, `${command} ${response[0]} was retried`);
    }
  }
});

test('a 400 returned by the server keeps its refusal mapping and is never INVALID_PARAMS / sent:false', async () => {
  const input = { org: 'org-automation', id: 'binding', expected_version: 7, idempotency_key: 'chat-run:1' };
  for (const [response, expected] of [
    [coreError(400, 'WORK_ERROR', 'event binding: invalid timer schedule'), 'NO_NEXT_TRIGGER'],
    [coreError(400, 'WORK_ERROR', 'event binding: org_id, cron_expr, lead_member_id, owner_member_id, project_id and title are required'), 'REFUSED'],
    [coreError(400, 'VALIDATION_FAILED', 'expected_version must be at least 1'), 'REFUSED'],
  ]) {
    for (const command of ['event-binding.pause', 'event-binding.resume', 'event-binding.run']) {
      const result = await runAgainst(() => response, command, input);
      const payload = JSON.parse(result.stderr);
      assert.equal(result.requests.length, 1);
      assert.equal(payload.status, 400);
      assert.equal(payload.code, expected, `${command} ${response[1].error.detail}`);
      assert.equal(payload.refused, true);
      assert.equal(payload.sent, undefined, `${command}: a server 400 was reported as not sent`);
    }
  }
});

test('pause, resume and run report an argument that is not a JSON object as INVALID_PARAMS / sent:false', async () => {
  // A quoting slip must not look like an unknown outcome (no code, no sent), or the Agent would retry and
  // tell the person it may have run.
  for (const command of ['event-binding.pause', 'event-binding.resume', 'event-binding.run']) {
    for (const rawArg of ['{"org":"org-automation","id":"binding","expected_version":3', "{'org':'x'}", 'null', '[]', '"x"', '5']) {
      const result = await runAgainst(() => [200, { data: {}, request_id: 'r' }], command, rawArg, { raw: true });
      assert.ok(result.error, `${command} ${rawArg}`);
      assert.equal(result.requests.length, 0, `${command} sent a request for ${rawArg}`);
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.code, 'INVALID_PARAMS', `${command} ${rawArg}`);
      assert.equal(payload.sent, false);
      assert.equal(payload.status, 400);
      assert.equal(payload.refused, undefined);
      assert.match(payload.error, new RegExp(`^${command.replace('.', '\\.')} requires its parameters as one JSON object`));
    }
  }
  // Other commands keep their old behaviour for an unparseable argument: a SyntaxError, no request.
  const other = await runAgainst(() => [200, { data: [], request_id: 'r' }], 'event-binding.runs', '{"id":', { raw: true });
  assert.ok(other.error);
  assert.equal(other.requests.length, 0);
  assert.match(other.stderr, /SyntaxError/);
});

test('INVALID_PARAMS / sent:false stays limited to pause, resume and run', async () => {
  // Another command's local validation keeps its existing error shape.
  const result = await runAgainst(() => [200, { data: [], request_id: 'r' }], 'event-binding.runs', { id: 'binding' });
  assert.ok(result.error);
  assert.equal(result.requests.length, 0);
  const payload = JSON.parse(result.stderr);
  assert.match(payload.error, /event-binding\.runs requires non-empty text: org/);
  assert.equal(payload.code, undefined);
  assert.equal(payload.sent, undefined);
  assert.equal(payload.status, undefined);
});
