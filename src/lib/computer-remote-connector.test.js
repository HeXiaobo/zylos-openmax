import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAgentBaseUrl } from './agent-domain.js';
import {
  createComputerRemoteConnector,
  createComputerRemoteLocalClient,
  createPublicBaseResolver,
  isComputerRemoteCommand,
} from './computer-remote-connector.js';

const orgId = '11111111-1111-1111-1111-111111111111';
const memberId = '22222222-2222-2222-2222-222222222222';
const bindingId = '33333333-3333-3333-3333-333333333333';
const requestId = '44444444-4444-4444-4444-444444444444';
const deviceId = '55555555-5555-5555-5555-555555555555';
const epoch = Date.UTC(2026, 0, 1);
const expiresAt = new Date(epoch + 60_000).toISOString();
const ticket = 'ticket_that_must_not_appear_in_any_log_output';
const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const org = { org_id: orgId, slug: 'test-org', self: { member_id: memberId } };
const meta = { slug: org.slug, orgId, memberId, bindingId, requestId };
const frameFor = (action, extra = {}) => ({
  payload: { event: 'channel.install', data: {
    channel_type: 'computer-remote', org_id: orgId, agent_member_id: memberId,
    action, binding_id: bindingId, request_id: requestId, ...extra,
  } },
});
const local = '/v1/workspace-enrollment';
const core = `/api/v1/connect/computer-use/connections/${bindingId}`;
const ids = { connection_id: bindingId, request_id: requestId };
const componentMissing = () => Object.assign(new Error('not installed'), {
  stderr: 'Error: Component "computer-remote" is not installed.',
});
const legacy404 = () => Object.assign(new Error('unknown route'), { status: 404, remoteCode: 'not_found' });

function fixture(overrides = {}) {
  const calls = { get: [], post: [], remote: [], exec: [], queue: [], fetch: [], log: [] };
  const connector = createComputerRemoteConnector({
    apiPath: (route) => `/api/v1${route}`,
    now: () => epoch,
    wait: async () => {},
    readEnrollmentVersion: () => undefined,
    resolvePublicBase: async () => 'https://agent.example.test',
    getForOrg: async (...args) => {
      calls.get.push(args);
      return { data: { ...ids, agent_member_id: memberId, public_key: publicKey, device_name: 'Test Mac' } };
    },
    postForOrg: async (...args) => { calls.post.push(args); },
    persistConnectedCheck: (entry) => { calls.queue.push(entry); return true; },
    fetchImpl: async (...args) => {
      calls.fetch.push(args);
      return Response.json({ error: 'upgrade_required' }, { status: 426 });
    },
    execFile: async (file, args) => {
      calls.exec.push([file, args]);
      if (args[0] === 'info') {
        return { stdout: JSON.stringify({
          name: 'computer-remote', service: { name: 'zylos-computer-remote', status: 'online' },
        }) };
      }
    },
    remote: async (...args) => {
      calls.remote.push(args);
      if (args[1] === '/v1/health') return { ok: true };
      if (args[1] === local) return { ticket, expires_at: expiresAt };
      if (args[1] === `${local}/revoke`) return { revoked: true };
      return { state: 'paired', online: true, device_id: deviceId };
    },
    log: (message) => calls.log.push(message),
    warn: (message) => calls.log.push(message),
    ...overrides,
  });
  return { connector, calls };
}

test('reuses a healthy Remote, verifies the public route, and reports a credential only after saving receipt metadata', async () => {
  const { connector, calls } = fixture();
  assert.equal(isComputerRemoteCommand(frameFor('prepare').payload.data), true);
  assert.equal(isComputerRemoteCommand({ channel_type: 'browser-remote' }), false);
  await connector.handleCommand(org, frameFor('prepare'));

  assert.deepEqual(calls.get.map(([org, route, query]) => [org, route, query]), Array(3).fill(
    [orgId, `${core}/prepare-input`, { request_id: requestId }],
  ));
  assert.deepEqual(calls.exec, [['zylos', ['info', 'computer-remote', '--json']]]);
  assert.equal(calls.fetch[0][0], 'https://agent.example.test/computer-remote/device/v1/ws');
  assert.equal(calls.fetch[0][1].redirect, 'error');
  assert.deepEqual(calls.remote, [
    ['GET', '/v1/health'],
    ['POST', local, { ...ids, public_key: publicKey, device_name: 'Test Mac' }],
  ]);
  assert.deepEqual(calls.queue, [{ ...meta, kind: 'computer-connected', status: 'pending' }]);
  assert.deepEqual(calls.post[0].slice(0, 3), [orgId, `${core}/prepare-result`, {
    request_id: requestId, ok: true, remote_url: 'https://agent.example.test/computer-remote',
    ticket, expires_at: expiresAt,
  }]);
  assert.equal(calls.post[0][3].sensitiveBody, true);
  assert.ok(!JSON.stringify(calls.log).includes(ticket));
  assert.ok(!JSON.stringify(calls.queue).includes(ticket));
});

test('installs a missing Remote once for concurrent valid requests', async () => {
  const installed = [];
  let unblock;
  const installBarrier = new Promise((resolve) => { unblock = resolve; });
  const otherBinding = '66666666-6666-6666-6666-666666666666';
  const { connector } = fixture({
    env: { COMPUTER_REMOTE_ENROLLMENT_VERSION: 'v0.1.7' },
    getForOrg: async (_org, route) => ({
      ...ids, connection_id: route.split('/').at(-2), agent_member_id: memberId,
      public_key: publicKey, device_name: 'Test Mac',
    }),
    execFile: async (file, args) => {
      if (args[0] === 'info') {
        throw componentMissing();
      }
      installed.push([file, args]);
      return installBarrier;
    },
  });
  const first = connector.handleCommand(org, frameFor('prepare'));
  const second = connector.handleCommand(org, frameFor('prepare', { binding_id: otherBinding }));
  await new Promise(setImmediate);
  assert.deepEqual(installed, [['zylos', ['add', 'zylos-ai/zylos-computer-remote@v0.1.7', '--yes']]]);
  unblock();
  await Promise.all([first, second]);
});

test('requires an exact enrollment-capable release pin before installing', async () => {
  for (const version of [undefined, 'v0.1.6', 'main', 'v0.1.7-dev', 'v0.1.7 --yes']) {
    const { connector, calls } = fixture({
      env: { COMPUTER_REMOTE_ENROLLMENT_VERSION: version },
      execFile: async (file, args) => {
        assert.equal(file, 'zylos');
        assert.equal(args[0], 'info');
        throw componentMissing();
      },
    });
    await connector.handleCommand(org, frameFor('prepare'));
    assert.deepEqual(calls.post[0][2], { request_id: requestId, ok: false, error: 'remote_install_version_required' });
    assert.deepEqual(calls.remote, []);
    assert.ok(calls.log.some(line => line.includes('reason=remote_install_version_required')));
  }
});

test('uses the local Zylos enrollment pin when the process has no explicit pin', async () => {
  const commands = [];
  const { connector } = fixture({
    env: {},
    readEnrollmentVersion: () => 'v0.1.8',
    execFile: async (file, args) => {
      commands.push([file, args]);
      if (args[0] === 'info') throw componentMissing();
    },
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(commands, [
    ['zylos', ['info', 'computer-remote', '--json']],
    ['zylos', ['add', 'zylos-ai/zylos-computer-remote@v0.1.8', '--yes']],
  ]);
});

test('uses the configured HTTPS hostname only when the platform domain and explicit URL are absent', async () => {
  let bound = false;
  const deps = {
    getForOrg: async (org, route) => {
      assert.equal(org, orgId);
      assert.match(route, /\/platform-agents\/test-identity\/domain$/);
      if (bound) return { full_domain: 'bound.example.test' };
      throw Object.assign(new Error('not bound'), { status: 404 });
    },
    apiPath: (route) => '/api/v1' + route,
    resolveBase: (args) => resolveAgentBaseUrl({ ...args, identityId: 'test-identity' }),
    readSettings: () => ({ domain: 'operator.example.test' }),
    readFresh: () => undefined,
  };
  assert.equal(await createPublicBaseResolver({ ...deps, env: {} })(orgId), 'https://operator.example.test');
  assert.equal(await createPublicBaseResolver({
    ...deps, env: { AGENT_PUBLIC_BASE_URL: 'https://specific.example.test' },
  })(orgId), 'https://specific.example.test');
  bound = true;
  const { connector, calls } = fixture({
    resolvePublicBase: createPublicBaseResolver({ ...deps, env: {} }),
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.equal(calls.fetch[0][0], 'https://bound.example.test/computer-remote/device/v1/ws');
  assert.equal(calls.fetch[0][1].credentials, 'omit');
  bound = false;
  await assert.rejects(createPublicBaseResolver({
    ...deps, env: {}, readSettings: () => ({ domain: '127.0.0.1' }),
  })(orgId), /URL unavailable/);
});

test('a wrong target, stale command, or differently scoped Core response cannot install or revoke', async () => {
  const stale = Object.assign(new Error('stale'), { status: 409 });
  const { connector, calls } = fixture({
    getForOrg: async (_org, route) => {
      if (route.endsWith('/revoke-input')) {
        return { ...ids, agent_member_id: deviceId };
      }
      throw stale;
    },
  });
  await connector.handleCommand(org, frameFor('prepare', { org_id: deviceId }));
  await connector.handleCommand(org, frameFor('prepare', { agent_member_id: deviceId }));
  await connector.handleCommand(org, frameFor('prepare'));
  await connector.handleCommand(org, frameFor('revoke'));
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.remote, []);
  assert.deepEqual(calls.post, []);
});

test('a superseded prepare result discards only the matching pending Remote enrollment', async () => {
  const calls = [];
  const { connector } = fixture({
    postForOrg: async () => { throw Object.assign(new Error(ticket), { status: 409 }); },
    remote: async (method, route, body) => {
      calls.push([method, route, body]);
      if (route === '/v1/health') return { ok: true };
      if (route === local) return { ticket, expires_at: expiresAt };
      return { discarded: true };
    },
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(calls.at(-1), ['POST', `${local}/discard`, ids]);
  assert.ok(!calls.some(([, route]) => route === `${local}/revoke`));
});

test('a missed prepare reply preserves metadata and leaves the same ticket available for idempotent retry', async () => {
  const { connector, calls } = fixture({
    postForOrg: async () => { throw new Error('response lost'); },
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(calls.queue, [{ ...meta, kind: 'computer-connected', status: 'pending' }]);
  assert.ok(!calls.remote.some(([, route]) => route === `${local}/discard`));
});

test('an HTTPS route failure or queue persistence failure never gives Core a ticket', async () => {
  const insecure = fixture({ resolvePublicBase: async () => 'http://agent.example.test' });
  await insecure.connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(insecure.calls.post[0][2], { request_id: requestId, ok: false, error: 'public_url_unavailable' });
  assert.deepEqual(insecure.calls.exec, []);

  const storage = fixture({ persistConnectedCheck: () => false });
  await storage.connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(storage.calls.remote.at(-1), ['POST', `${local}/discard`, ids]);
  assert.deepEqual(storage.calls.post[0][2], { request_id: requestId, ok: false, error: 'receipt_storage_unavailable' });
});

test('connected reports require paired state and a live Remote observation', async () => {
  const states = [
    { state: 'pending' },
    { state: 'paired', online: 'true', device_id: deviceId },
    { state: 'paired', online: false, device_id: deviceId },
    { state: 'paired', online: true, device_id: deviceId },
  ];
  const { connector, calls } = fixture({ remote: async () => states.shift() });
  for (let i = 0; i < 3; i++) await assert.rejects(connector.verifyConnected(meta), /Waiting for a verified/);
  assert.deepEqual(calls.post, []);
  await connector.verifyConnected(meta);
  assert.deepEqual(calls.post[0].slice(0, 3), [
    orgId, `${core}/connected`, { request_id: requestId, device_id: deviceId },
  ]);
});

test('revoke must be authorized by Core and acknowledged by Remote before sending a completion', async () => {
  const { connector, calls } = fixture();
  await connector.handleCommand(org, frameFor('revoke'));
  assert.equal(calls.get[0][1], `${core}/revoke-input`);
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.remote, [['POST', `${local}/revoke`, ids]]);
  assert.deepEqual(calls.post[0].slice(0, 3), [orgId, `${core}/revoke-ack`, { request_id: requestId }]);
});

test('does not acknowledge revocation when the local response omits confirmation', async () => {
  const { connector, calls } = fixture({ remote: async () => ({ revoked: false }) });
  await connector.handleCommand(org, frameFor('revoke'));
  assert.deepEqual(calls.post, []);
  assert.match(calls.log[0], /revoke not confirmed/);
});

test('acknowledges a never-installed Remote only when local state is absent', async () => {
  for (const [absent, processes, acknowledged] of [
    [true, [], true], [false, [], false], [true, [{ name: 'zylos-computer-remote' }], false],
  ]) {
    const { connector, calls } = fixture({
      remote: async () => { throw Object.assign(new Error('token absent'), { code: 'remote_credentials_missing' }); },
      remoteStateAbsent: async () => absent,
      execFile: async (_file, args) => {
        if (args[0] === 'jlist') return { stdout: JSON.stringify(processes) };
        assert.equal(args[0], 'info');
        throw componentMissing();
      },
    });
    await connector.handleCommand(org, frameFor('revoke'));
    assert.equal(calls.post.length, acknowledged ? 1 : 0);
    if (acknowledged) assert.equal(calls.get.length, 2);
  }
});

test('restarts an installed stopped Remote to revoke after a fresh Core check', async () => {
  const order = [];
  let started = false;
  const { connector, calls } = fixture({
    getForOrg: async () => {
      order.push('authority');
      return { ...ids, agent_member_id: memberId };
    },
    remote: async (_, route) => {
      order.push(route);
      if (!started) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      return route === '/v1/health' ? { ok: true } : { revoked: true };
    },
    execFile: async (file, args) => {
      order.push(`${file}: ${args.join(' ')}`);
      if (file === 'zylos') {
        return { stdout: JSON.stringify({
          name: 'computer-remote', service: { name: 'zylos-computer-remote', status: 'stopped' },
        }) };
      }
      started = true;
    },
  });
  await connector.handleCommand(org, frameFor('revoke'));
  assert.deepEqual(order, ['authority', `${local}/revoke`, 'zylos: info computer-remote --json',
    'pm2: restart zylos-computer-remote', '/v1/health', 'authority', `${local}/revoke`]);
  assert.equal(calls.post[0][1], `${core}/revoke-ack`);
});

test('requires an authenticated empty device inventory before acknowledging a legacy Remote', async () => {
  for (const devices of [[], [{ device_id: deviceId }], null]) {
    const { connector, calls } = fixture({
      remote: async (_method, route) => {
        if (route === '/v1/devices') return { devices };
        throw legacy404();
      },
    });
    await connector.handleCommand(org, frameFor('revoke'));
    assert.equal(calls.post.length, devices?.length === 0 ? 1 : 0);
    if (devices?.length !== 0) assert.match(calls.log[0], /revoke not confirmed/);
  }
});

test('reports bounded prepare refusals and keeps uncertain transport errors available for retry', async () => {
  for (const [error, result] of [
    [legacy404(), 'remote_enrollment_unsupported'],
    [Object.assign(new Error(ticket), { status: 409, remoteCode: 'enrollment_device_mismatch' }), 'enrollment_device_mismatch'],
    [Object.assign(new Error(ticket), { status: 503, remoteCode: 'enrollment_capacity' }), 'enrollment_capacity'],
    [Object.assign(new Error(ticket), { status: 401 }), 'remote_authentication_failed'],
    [Object.assign(new Error(ticket), { code: 'remote_credentials_invalid' }), 'remote_credentials_invalid'],
    [Object.assign(new Error(ticket), { code: 'remote_response_invalid' }), 'remote_response_invalid'],
    [new Error('socket closed'), null],
  ]) {
    const { connector, calls } = fixture({
      remote: async (_method, route) => {
        if (route === '/v1/health') return { ok: true };
        throw error;
      },
    });
    await connector.handleCommand(org, frameFor('prepare'));
    if (result) assert.deepEqual(calls.post[0][2], { request_id: requestId, ok: false, error: result });
    else assert.deepEqual(calls.post, []);
    assert.ok(!JSON.stringify(calls).includes(ticket));
  }
});

test('settles queued receipt checks when Remote confirms the enrollment is gone', async () => {
  const { connector, calls } = fixture({
    remote: async () => { throw Object.assign(new Error('expired record pruned'), { status: 404, remoteCode: 'enrollment_not_found' }); },
  });
  await connector.verifyConnected(meta);
  assert.deepEqual(calls.post, []);
});

test('the local client authenticates only to the recorded private loopback port and refuses a symlink token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-computer-remote-test-'));
  const token = 'a'.repeat(43);
  fs.writeFileSync(path.join(dir, 'agent.token'), token, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-computer-remote-token'], token);
    if (req.url === '/v1/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: req.url === '/missing-route' ? 'not_found' : token }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fs.writeFileSync(path.join(dir, 'agent.port'), String(server.address().port), { mode: 0o600 });
  const remote = createComputerRemoteLocalClient({ dataDir: dir });
  assert.deepEqual(await remote('GET', '/v1/health'), { ok: true });
  await assert.rejects(remote('POST', '/missing-route'), { status: 404, remoteCode: 'not_found' });
  await assert.rejects(remote('POST', '/private-error'), (error) =>
    error.status === 404 && error.remoteCode === undefined && !error.message.includes(token));
  fs.chmodSync(path.join(dir, 'agent.token'), 0o640);
  await assert.rejects(remote('GET', '/v1/health'), { code: 'remote_credentials_invalid' });
  fs.chmodSync(path.join(dir, 'agent.token'), 0o600);
  fs.renameSync(path.join(dir, 'agent.token'), path.join(dir, 'renamed'));
  fs.symlinkSync(path.join(dir, 'renamed'), path.join(dir, 'agent.token'));
  await assert.rejects(remote('GET', '/v1/health'));
});
