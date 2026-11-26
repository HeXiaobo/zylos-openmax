import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createBrowserRemoteConnector,
  PUBLIC_URL_MISSING,
  PUBLIC_URL_INVALID,
  NO_PUBLIC_DOMAIN_NOTICE_INTERVAL_MS,
  createRelayUrlResolver,
  isBrowserRemoteCommand,
  relayUrlFromBase,
} from './browser-remote-connector.js';
import { enqueueControl } from './session-control.js';

const apiPath = (p) => `/api/v1${p}`;
const ORG = { slug: 'acme', org_id: 'org-1', self: { member_id: 'agent-1' } };
const CONN = 'conn-1';
const RELAY = 'wss://agent.example.com/browser-remote/ext';

const frame = (action, requestId = 'req-1', bindingId = CONN) => ({
  payload: {
    event: `channel.${action}`,
    data: { channel_type: 'browser-remote', action, binding_id: bindingId, request_id: requestId, agent_member_id: 'agent-1' },
  },
});

/**
 * Fake browser-remote: an in-memory keys store behind a fake execFile that
 * speaks key.js --json, zylos info/add/upgrade and pm2 jlist.
 */
function makeEnv({
  installed = true,
  supportsJson = true,
  online = true,
  keys = [],
  relay = async () => RELAY,
  postFail = () => null,
  active = [],
  keyFail = () => null,
  now = () => Date.parse('2026-11-17T12:00:00Z'),
  onNoPublicDomain = () => {},
} = {}) {
  const store = new Map(keys.map((k) => [k.keyId, { ...k }]));
  let seq = 0;
  const calls = [];
  const posts = [];
  const logs = [];
  const queued = [];
  const seen = new Set();
  const state = { installed, supportsJson, online };
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'zylos') {
      if (args[0] === 'info') {
        if (!state.installed) throw new Error('not installed');
        return { stdout: JSON.stringify({ name: 'browser-remote' }) };
      }
      if (args[0] === 'add') { state.installed = true; return { stdout: '' }; }
      if (args[0] === 'upgrade') return { stdout: '' };
    }
    if (file === 'pm2') {
      if (args[0] === 'jlist') {
        return { stdout: JSON.stringify([{ name: 'zylos-browser-remote', pm2_env: { status: state.online ? 'online' : 'stopped' } }]) };
      }
      state.online = true;
      return { stdout: '' };
    }
    // node key.js <cmd> ... --json
    const [, cmd, ...rest] = args;
    const failure = keyFail(cmd);
    if (failure) throw failure;
    if (!state.supportsJson) return { stdout: 'no keys in /x/keys.json\n' };
    if (cmd === 'list') return { stdout: JSON.stringify({ ok: true, keys: [...store.entries()].map(([keyId, v]) => ({ keyId, ...v })) }) };
    if (cmd === 'revoke') {
      const id = rest[0];
      const revoked = store.delete(id);
      return { stdout: JSON.stringify({ ok: true, keyId: id, revoked }) };
    }
    if (cmd === 'new') {
      const i = rest.indexOf('--connection');
      seq += 1;
      const keyId = `kid-${seq}`;
      const key = `SECRETKEY${seq}abcdef0123456789`;
      store.set(keyId, { connectionId: rest[i + 1], createdAt: new Date(now()).toISOString(), label: rest[rest.indexOf('--label') + 1] });
      return { stdout: JSON.stringify({ ok: true, key, keyId, connectionId: rest[i + 1], expiresAt: 'x', singleBrowser: true }) };
    }
    throw new Error('unexpected');
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-'));
  const connector = createBrowserRemoteConnector({
    getForOrg: async (_org, p) => {
      assert.equal(p, '/api/v1/connect/agent-browser-connections');
      if (active instanceof Error) throw active;
      return active;
    },
    postForOrg: async (orgId, p, body) => {
      posts.push({ orgId, path: p, body });
      const err = postFail(p, body, posts.length);
      if (err) throw err;
      return { success: true };
    },
    apiPath,
    resolveRelayUrl: relay,
    onNoPublicDomain,
    dedupe: (k) => { if (seen.has(k)) return true; seen.add(k); return false; },
    persistUndeliveredResult: (e) => { queued.push(e); },
    readQueued: () => queued,
    execFile,
    nodeBin: 'node',
    home: '/h',
    keyRecordFile: path.join(dir, 'rec.json'),
    now,
    reportSleep: async () => {},
    verifyPollMs: 0,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  });
  return { connector, store, calls, posts, logs, queued, state, dir };
}

const prepares = (posts) => posts.filter((p) => p.path.endsWith('/prepare-result'));
const acks = (posts) => posts.filter((p) => p.path.endsWith('/revoke-ack'));

test('helpers: channel_type match and relay URL from base URL', () => {
  assert.equal(isBrowserRemoteCommand({ channel_type: 'browser-remote' }), true);
  assert.equal(isBrowserRemoteCommand({ channel_type: 'lark' }), false);
  assert.equal(relayUrlFromBase('https://a.example.com'), RELAY.replace('agent', 'a'));
  assert.equal(relayUrlFromBase('http://127.0.0.1:8080/'), 'ws://127.0.0.1:8080/browser-remote/ext');
});

test('prepare (fresh): mints a single-browser 30-day key for the connection and reports it', async () => {
  const env = makeEnv();
  await env.connector.handleCommand(ORG, frame('prepare'));
  const [p] = prepares(env.posts);
  assert.equal(p.path, `/api/v1/connect/browser-connections/${CONN}/prepare-result`);
  assert.equal(p.body.ok, true);
  assert.equal(p.body.request_id, 'req-1');
  assert.equal(p.body.relay_url, RELAY);
  assert.equal(p.body.key_id, 'kid-1');
  assert.match(p.body.key, /^SECRETKEY1/);
  const newCall = env.calls.find((c) => c[2] === 'new');
  assert.deepEqual(newCall.slice(3), ['--label', `openmax:${CONN}`, '--connection', CONN, '--ttl-days', '30', '--single-browser', '--json']);
  assert.equal(env.calls.some((c) => c[0] === 'zylos' && c[1] !== 'info'), false, 'no add/upgrade when installed and capable');
  assert.equal(env.store.size, 1);
});

test('prepare: duplicate request_id is ignored; a retry with a new request_id replaces the key', async () => {
  const env = makeEnv();
  await env.connector.handleCommand(ORG, frame('prepare', 'req-1'));
  await env.connector.handleCommand(ORG, frame('prepare', 'req-1'));
  assert.equal(prepares(env.posts).length, 1);
  await env.connector.handleCommand(ORG, frame('prepare', 'req-2'));
  assert.equal(prepares(env.posts).length, 2);
  assert.deepEqual([...env.store.keys()], ['kid-2'], 'the first key was revoked, not leaked');
});

test('prepare: an existing key for the connection is revoked first; manual keys are untouched', async () => {
  const env = makeEnv({ keys: [
    { keyId: 'old', connectionId: CONN, createdAt: '2026-01-01T00:00:00Z' },
    { keyId: 'manual', connectionId: null, createdAt: '2026-01-01T00:00:00Z' },
  ] });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.deepEqual([...env.store.keys()].sort(), ['kid-1', 'manual']);
});

const missing = () => Object.assign(new Error('no bound domain and AGENT_PUBLIC_BASE_URL unset'), { code: PUBLIC_URL_MISSING });

test('prepare: no public domain → ok=false with a clear error, no key minted', async () => {
  const env = makeEnv({ relay: async () => { throw missing(); } });
  await env.connector.handleCommand(ORG, frame('prepare'));
  const [p] = prepares(env.posts);
  assert.equal(p.body.ok, false);
  assert.match(p.body.error, /^BROWSER_PUBLIC_URL_MISSING:.*configure its public HTTPS URL/);
  assert.match(p.body.error, /notice could not be queued/);
  assert.doesNotMatch(p.body.error, /no public domain|AGENT_PUBLIC_BASE_URL/i);
  assert.equal(p.body.key, undefined);
  assert.equal(env.store.size, 0);
});

test('prepare: only a missing public URL notifies the session; core errors and malformed values do not', async () => {
  for (const [err, re] of [
    [Object.assign(new Error('the AGENT_PUBLIC_BASE_URL value is not a valid http(s) URL'), { code: PUBLIC_URL_INVALID }), /not a valid http\(s\) URL/],
    [Object.assign(new Error('core 503'), { status: 503 }), /could not resolve this Agent's public URL/],
  ]) {
    const notices = [];
    const env = makeEnv({ relay: async () => { throw err; }, onNoPublicDomain: () => { notices.push(1); return true; } });
    await env.connector.handleCommand(ORG, frame('prepare'));
    const [p] = prepares(env.posts);
    assert.equal(p.body.ok, false);
    assert.match(p.body.error, re);
    assert.doesNotMatch(p.body.error, /AGENT_PUBLIC_BASE_URL=/);
    assert.equal(notices.length, 0);
  }
  const notices = [];
  const ok = makeEnv({ onNoPublicDomain: () => { notices.push(1); return true; } });
  await ok.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(notices.length, 0);
});

test('prepare: the no-public-URL notice is rate-limited after successful enqueue', async () => {
  let t = Date.parse('2026-11-17T12:00:00Z');
  const results = [false, true, true, true];
  const notices = [];
  const env = makeEnv({
    now: () => t,
    relay: async () => { throw missing(); },
    onNoPublicDomain: async () => { notices.push(t); return results[notices.length - 1]; },
  });
  const attempt = async (id) => { await env.connector.handleCommand(ORG, frame('prepare', id)); await new Promise((r) => setImmediate(r)); };
  await attempt('r1');                       // enqueue fails → not counted
  await attempt('r2');                       // delivered
  t += 60_000; await attempt('r3');          // within 10 min → skipped
  t += NO_PUBLIC_DOMAIN_NOTICE_INTERVAL_MS; await attempt('r4');
  assert.equal(notices.length, 3);
  assert.deepEqual(prepares(env.posts).map(({ body }) => body.error.split(' notice ')[1]),
    ['could not be queued.', 'queued.', 'recently queued.', 'queued.']);
});

test('prepare: a throwing notice hook does not change the reported failure', async () => {
  const env = makeEnv({ relay: async () => { throw missing(); }, onNoPublicDomain: () => { throw new Error('enqueue failed'); } });
  await env.connector.handleCommand(ORG, frame('prepare'));
  const [p] = prepares(env.posts);
  assert.equal(p.body.ok, false);
  assert.match(p.body.error, /notice could not be queued/);
});

test('prepare: concurrent requests share one missing-domain notice', async () => {
  let notices = 0;
  let settle;
  const queued = new Promise((resolve) => { settle = resolve; });
  const env = makeEnv({
    relay: async () => { throw missing(); },
    onNoPublicDomain: () => { notices++; return queued; },
  });
  const first = env.connector.handleCommand(ORG, frame('prepare', 'r1', 'c1'));
  const second = env.connector.handleCommand(ORG, frame('prepare', 'r2', 'c2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices, 1);
  settle(true);
  await Promise.all([first, second]);
  assert.equal(prepares(env.posts).length, 2);
  assert.ok(prepares(env.posts).every(({ body }) => /notice queued/.test(body.error)));
});

test('prepare: not installed → zylos add, then pm2 start when offline', async () => {
  const env = makeEnv({ installed: false, online: false });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.ok(env.calls.some((c) => c[0] === 'zylos' && c[1] === 'add'));
  assert.ok(env.calls.some((c) => c[0] === 'pm2' && c[1] === 'restart'));
  assert.equal(prepares(env.posts)[0].body.ok, true);
});

test('prepare: browser-remote without --json support → upgrade, then a clear too-old error', async () => {
  const env = makeEnv({ supportsJson: false });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.ok(env.calls.some((c) => c[0] === 'zylos' && c[1] === 'upgrade'));
  const [p] = prepares(env.posts);
  assert.equal(p.body.ok, false);
  assert.match(p.body.error, /too old/);
});

test('prepare: key.js exiting non-zero without JSON is an error, not "too old" — no upgrade', async () => {
  const env = makeEnv({ keyFail: (cmd) => (cmd === 'list'
    ? Object.assign(new Error('Command failed: SyntaxError: Unexpected token in keys.json'), { code: 1, stdout: '' })
    : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(env.calls.some((c) => c[0] === 'zylos' && c[1] === 'upgrade'), false);
  const [p] = prepares(env.posts);
  assert.equal(p.body.ok, false);
  assert.doesNotMatch(p.body.error, /too old/);
  assert.match(p.body.error, /keys\.json/);
});

test('prepare: key.js timing out is an error, not "too old" — no upgrade', async () => {
  const env = makeEnv({ keyFail: (cmd) => (cmd === 'list'
    ? Object.assign(new Error('Command failed: node key.js list --json'), { killed: true, signal: 'SIGTERM', code: null, stdout: '' })
    : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(env.calls.some((c) => c[0] === 'zylos' && c[1] === 'upgrade'), false);
  const [p] = prepares(env.posts);
  assert.equal(p.body.ok, false);
  assert.doesNotMatch(p.body.error, /too old/);
});

test('prepare: a command addressed to a different Agent is ignored', async () => {
  const env = makeEnv();
  const f = frame('prepare');
  f.payload.data.agent_member_id = 'agent-2';
  await env.connector.handleCommand(ORG, f);
  assert.equal(env.calls.length, 0);
  assert.equal(env.posts.length, 0);
  assert.equal(env.store.size, 0);
});

test('prepare: undelivered result is queued WITHOUT the key; resend reuses the undelivered key', async () => {
  let fail = true;
  const env = makeEnv({ postFail: (p) => (fail && p.endsWith('/prepare-result') ? new Error('503') : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(env.queued.length, 1);
  const q = env.queued[0];
  assert.equal(q.kind, 'browser-prepare');
  assert.equal(q.status, 'ok');
  assert.equal(JSON.stringify(q).includes('SECRETKEY'), false, 'key not in the queue entry');
  assert.equal(q.relay_url, undefined);

  fail = false;
  await env.connector.resendPrepare(q);
  const last = prepares(env.posts).at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.request_id, 'req-1');
  assert.equal(last.body.key_id, 'kid-1');
  assert.match(last.body.key, /^SECRETKEY1/);
  assert.equal(env.calls.filter((c) => c[2] === 'new').length, 1, 'no key minted per resend');
  assert.deepEqual([...env.store.keys()], ['kid-1']);
});

test('resend: 5xx keeps the entry and reuses one key across attempts; a key gone from key.js is re-minted', async () => {
  let fail = true;
  const env = makeEnv({ postFail: (p) => (fail && p.endsWith('/prepare-result') ? Object.assign(new Error('502'), { status: 502 }) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  const q = env.queued[0];
  for (let i = 0; i < 3; i++) await assert.rejects(() => env.connector.resendPrepare(q), /502/);
  assert.equal(env.calls.filter((c) => c[2] === 'new').length, 1);
  assert.deepEqual([...env.store.keys()], ['kid-1']);

  env.store.clear();
  fail = false;
  await env.connector.resendPrepare(q);
  assert.equal(prepares(env.posts).at(-1).body.key_id, 'kid-2');
  assert.deepEqual([...env.store.keys()], ['kid-2']);
});

test('prepare: a final 4xx is not retried or queued, and the undelivered key is revoked', async () => {
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error('409 conflict'), { status: 409 }) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(prepares(env.posts).length, 1, 'no retry');
  assert.equal(env.queued.length, 0, 'not queued');
  assert.equal(env.store.size, 0, 'key revoked');
});

test('prepare: 429 is retried and queued like a 5xx', async () => {
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error('429'), { status: 429 }) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(prepares(env.posts).length, 3);
  assert.equal(env.queued.length, 1);
});

test('resend: a final 4xx resolves (entry dropped) and revokes the key instead of re-minting every tick', async () => {
  let status = 503;
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error(String(status)), { status }) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  const q = env.queued[0];
  status = 404;
  await env.connector.resendPrepare(q);
  assert.equal(env.store.size, 0, 'undeliverable key revoked');
  assert.equal(env.calls.filter((c) => c[2] === 'new').length, 1);
});

test('resend: a queued ok:false result hitting a final 4xx resolves (entry dropped)', async () => {
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error('404'), { status: 404 }) : null) });
  await env.connector.resendPrepare({ kind: 'browser-prepare', slug: 's', orgId: 'org-1', bindingId: CONN, requestId: 'r', status: 'error', detail: 'x' });
  assert.equal(prepares(env.posts).length, 1);
});

test('resend: a queued ok:false result hitting a 5xx still throws (stays queued)', async () => {
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error('503'), { status: 503 }) : null) });
  await assert.rejects(env.connector.resendPrepare({ kind: 'browser-prepare', slug: 's', orgId: 'org-1', bindingId: CONN, requestId: 'r', status: 'error', detail: 'x' }));
});

test('prepare: 401 is retried and queued, not treated as final', async () => {
  const env = makeEnv({ postFail: (p) => (p.endsWith('/prepare-result') ? Object.assign(new Error('401'), { status: 401 }) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  assert.equal(env.queued.length, 1);
  assert.equal(env.store.size, 1, 'key kept for resend');
});

test('resend: connection already ready at cws-connect → nothing re-minted', async () => {
  const env = makeEnv({ active: [{ connection_id: CONN, key_id: 'kid-1', state: 'ready' }] });
  await env.connector.resendPrepare({ kind: 'browser-prepare', orgId: 'org-1', bindingId: CONN, requestId: 'r', status: 'ok' });
  assert.equal(env.posts.length, 0);
  assert.equal(env.calls.some((c) => c[2] === 'new'), false);
});

test('revoke: revokes the connection keys and acks with the key_id; idempotent when none', async () => {
  const env = makeEnv({ keys: [
    { keyId: 'k-a', connectionId: CONN, createdAt: '2026-01-01T00:00:00Z' },
    { keyId: 'manual', connectionId: null },
  ] });
  await env.connector.handleCommand(ORG, frame('revoke', 'rv-1'));
  assert.deepEqual([...env.store.keys()], ['manual']);
  assert.deepEqual(acks(env.posts).map((a) => a.body), [{ key_id: 'k-a' }]);

  // Re-pushed revoke (new request_id), key already gone: still acks.
  await env.connector.handleCommand(ORG, frame('revoke', 'rv-2'));
  assert.equal(acks(env.posts).length, 2);
  assert.deepEqual(acks(env.posts)[1].body, { key_id: '' });
});

test('revoke: when listing keys fails nothing is acked (cws-connect re-pushes)', async () => {
  const env = makeEnv({
    keys: [{ keyId: 'k-a', connectionId: CONN, createdAt: '2026-01-01T00:00:00Z' }],
    keyFail: (cmd) => (cmd === 'list' ? Object.assign(new Error('boom'), { code: 1, stdout: '' }) : null),
  });
  await env.connector.handleCommand(ORG, frame('revoke', 'rv-1'));
  assert.equal(acks(env.posts).length, 0);
  assert.equal(env.store.size, 1);
});

test('revoke after a prepare whose key is gone: acks with the remembered key_id, falls back on 4xx', async () => {
  const env = makeEnv({ postFail: (p, body) => {
    if (p.endsWith('/revoke-ack') && body.key_id !== 'kid-1') { const e = new Error('400'); e.status = 400; return e; }
    return null;
  } });
  await env.connector.handleCommand(ORG, frame('prepare'));
  env.store.clear();
  await env.connector.handleCommand(ORG, frame('revoke', 'rv-1'));
  assert.deepEqual(acks(env.posts).map((a) => a.body.key_id), ['kid-1']);
});

test('reconcile: revokes orphan Workspace keys, keeps active, young and manual keys', async () => {
  const env = makeEnv({
    keys: [
      { keyId: 'active', connectionId: 'c-active', createdAt: '2026-01-01T00:00:00Z' },
      { keyId: 'orphan', connectionId: 'c-gone', createdAt: '2026-01-01T00:00:00Z' },
      { keyId: 'young', connectionId: 'c-preparing', createdAt: '2026-11-17T11:55:00Z' },
      { keyId: 'manual', connectionId: null, createdAt: '2026-01-01T00:00:00Z' },
    ],
    active: [{ connection_id: 'c-active', key_id: 'active', state: 'connected' }],
  });
  const r = await env.connector.reconcile([ORG]);
  assert.deepEqual(r.revoked, ['orphan']);
  assert.deepEqual([...env.store.keys()].sort(), ['active', 'manual', 'young']);
});

test('reconcile: a failed active-list read revokes nothing', async () => {
  const env = makeEnv({
    keys: [{ keyId: 'orphan', connectionId: 'c-gone', createdAt: '2026-01-01T00:00:00Z' }],
    active: new Error('502'),
  });
  const r = await env.connector.reconcile([ORG]);
  assert.deepEqual(r.revoked, []);
  assert.equal(env.store.size, 1);
});

test('the key never appears in logs, even when the report fails with it echoed', async () => {
  const env = makeEnv({ postFail: (p, body) => (p.endsWith('/prepare-result') ? new Error(`bad body ${JSON.stringify(body)}`) : null) });
  await env.connector.handleCommand(ORG, frame('prepare'));
  const all = env.logs.join('\n');
  assert.ok(all.length > 0);
  assert.equal(all.includes('SECRETKEY'), false);
  assert.ok(all.includes('***'));
});

test('createRelayUrlResolver: 404 + no value → MISSING; malformed → INVALID; core errors untagged; valid fresh value → relay URL', async () => {
  const notFound = Object.assign(new Error('not found'), { status: 404 });
  const unbound = async () => { throw notFound; };
  const mk = ({ env = {}, fresh, get = unbound } = {}) => createRelayUrlResolver({
    getForOrg: async (_org, p) => (p.endsWith('/me') ? { identity_id: 'ident-1' } : get(p)), apiPath: (p) => `/api/v1${p}`, env, readFresh: () => fresh,
    readSettings: () => null,
  });
  const code = async (fn) => { try { await fn(); return 'none'; } catch (e) { return e.code ?? 'untagged'; } };

  assert.equal(await code(() => mk()(ORG)), PUBLIC_URL_MISSING);
  assert.equal(await code(() => mk({ fresh: 'not a url' })(ORG)), PUBLIC_URL_INVALID);
  assert.equal(await code(() => mk({ fresh: 'ftp://x.example' })(ORG)), PUBLIC_URL_INVALID);
  assert.equal(await code(() => mk({ get: async () => { throw Object.assign(new Error('boom'), { status: 503 }); } })(ORG)), 'untagged');
  assert.equal(await mk({ fresh: 'https://pub.example' })(ORG), 'wss://pub.example/browser-remote/ext');
  const bound = (base_url) => createRelayUrlResolver({
    getForOrg: async () => ({}), apiPath: (p) => p, env: {}, readFresh: () => undefined,
    resolveBase: async () => ({ ok: true, source: 'core', base_url }),
  });
  assert.equal(await code(() => bound('https://bad host')(ORG)), PUBLIC_URL_INVALID);
  assert.equal(await code(() => bound('ftp://x.example')(ORG)), PUBLIC_URL_INVALID);
  assert.equal(await bound('https://bound.example')(ORG), 'wss://bound.example/browser-remote/ext');
  // a bound domain wins over a malformed .env value, and a core error is not masked by it
  const boundWithBadEnv = createRelayUrlResolver({
    getForOrg: async () => ({}), apiPath: (p) => p, env: {}, readFresh: () => 'oops',
    resolveBase: async () => ({ ok: true, source: 'core', base_url: 'https://bound.example' }),
  });
  assert.equal(await boundWithBadEnv(ORG), 'wss://bound.example/browser-remote/ext');
  assert.equal(await code(() => mk({ fresh: 'oops', get: async () => { throw Object.assign(new Error('boom'), { status: 503 }); } })(ORG)), 'untagged');
  // a malformed fresh value does not override the value the process started with
  assert.equal(await mk({ env: { AGENT_PUBLIC_BASE_URL: 'https://started.example' }, fresh: 'oops' })(ORG), 'wss://started.example/browser-remote/ext');
});

test('createRelayUrlResolver uses only a responding local HTTPS domain on the unbound path', async () => {
  let probes = 0;
  const local = 'local.example';
  const resolveWith = (config, status, result = { ok: false }) => createRelayUrlResolver({
    env: {}, readFresh: () => undefined, readSettings: () => config,
    resolveBase: async () => result,
    fetchEndpoint: async (url, options) => {
      probes++;
      assert.equal(url, `https://${local}/browser-remote/ext`);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.ok(options.signal instanceof AbortSignal);
      if (status instanceof Error) throw status;
      return { status };
    },
  });
  assert.equal(await resolveWith({ domain: local }, 426)(ORG), `wss://${local}/browser-remote/ext`);
  await assert.rejects(resolveWith({ domain: local }, 302)(ORG), { code: PUBLIC_URL_MISSING });
  await assert.rejects(resolveWith({ domain: local }, new Error('timeout'))(ORG), { code: PUBLIC_URL_MISSING });
  await assert.rejects(resolveWith({ domain: local, protocol: 'http' }, 426)(ORG), { code: PUBLIC_URL_MISSING });
  await assert.rejects(resolveWith({ domain: 'owner@foreign.example' }, 426)(ORG), { code: PUBLIC_URL_MISSING });
  assert.equal(await resolveWith({ domain: local }, 426, { ok: true, base_url: 'https://bound.example' })(ORG),
    'wss://bound.example/browser-remote/ext');
  assert.equal(probes, 3);
});

test('enqueueControl: resolves true only when the enqueue succeeds', async () => {
  const readSettings = () => null;
  const ok = await enqueueControl('hi', { readSettings, controlPath: '/c4-control.js', execFile: (_bin, args, opts, cb) => {
    assert.deepEqual(args, ['/c4-control.js', 'enqueue', '--content', 'hi', '--priority', '2', '--no-ack-suffix']);
    assert.deepEqual(opts, { timeout: 10000 });
    cb(null, '', '');
  } });
  const failed = await enqueueControl('hi', { readSettings, controlPath: '/c', execFile: (_b, _a, _o, cb) => cb(new Error('x'), '', 'db locked') });
  const threw = await enqueueControl('hi', { readSettings, controlPath: '/c', execFile: () => { throw new Error('spawn'); } });
  assert.deepEqual([ok, failed, threw], [true, false, false]);
});

test('enqueueControl targets the conversation in multi mode and origin in migrated single mode', async () => {
  for (const [mode, target] of [['multi', 'openmax:dm-c1'], ['single', 'origin']]) {
    const calls = [];
    const ok = await enqueueControl('hi', {
      group: 'openmax:dm-c1', readSettings: () => ({ session_mode: mode }), controlPath: '/c',
      execFile: (_b, args, _o, cb) => { calls.push(args.slice(-2)); cb(null); },
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, [['--group', target]]);
  }
});

test('enqueueControl retries only an explicit pre-enqueue target rejection', async () => {
  for (const [stderr, target] of [['Error [CONTROL_TARGET_REQUIRED]: target needed', 'origin'], ['timeout', null]]) {
    const targets = [];
    const ok = await enqueueControl('hi', {
      group: 'origin', readSettings: () => null, controlPath: '/c',
      execFile: (_b, args, _o, cb) => {
        const groupIndex = args.indexOf('--group');
        targets.push(groupIndex === -1 ? null : args[groupIndex + 1]);
        if (targets.length === 1) cb(new Error('failed'), '', stderr);
        else cb(null);
      },
    });
    assert.equal(ok, target !== null);
    assert.deepEqual(targets, target ? [null, target] : [null]);
  }
});
