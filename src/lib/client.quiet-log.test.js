// Verifies the opt-in `quietOnSuccess` stdout-suppression added for the
// high-frequency periodic reporters (runtime-metrics / online-report):
//   - quietOnSuccess:true + 2xx  → NO console.log for the → / ← lines
//   - quietOnSuccess:true + >=400 → STILL logs (via console.warn)
//   - default (no flag) + 2xx    → logs exactly as before
// The file sink (COCO_RPC_LOG_FILE) is intentionally left unset so it stays
// inert and only stdout behavior is exercised here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getForOrg, putForOrg, postForOrg, setApiKey, setBaseUrl, setHeaders } from './client.js';

// Isolate stdout logging: keep RPC stdout on, file sink off.
const savedEnv = {};
let logs;
let warns;
let origLog;
let origWarn;
let origFetch;

function fakeResponse(status, bodyObj) {
  return {
    status,
    ok: status < 400,
    async text() { return JSON.stringify(bodyObj); },
  };
}

beforeEach(() => {
  savedEnv.RPC_LOG = process.env.COCO_RPC_LOG;
  savedEnv.RPC_LOG_FILE = process.env.COCO_RPC_LOG_FILE;
  delete process.env.COCO_RPC_LOG;        // default ON
  delete process.env.COCO_RPC_LOG_FILE;   // file sink inert

  // Short-circuit token/base/header resolution — no network, no config needed.
  setApiKey('test-token');
  setBaseUrl('http://client-test.local');
  setHeaders({});

  logs = [];
  warns = [];
  origLog = console.log;
  origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => warns.push(a.join(' '));

  origFetch = globalThis.fetch;
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  globalThis.fetch = origFetch;
  setApiKey(null);
  setBaseUrl(null);
  setHeaders(null);
  if (savedEnv.RPC_LOG === undefined) delete process.env.COCO_RPC_LOG;
  else process.env.COCO_RPC_LOG = savedEnv.RPC_LOG;
  if (savedEnv.RPC_LOG_FILE === undefined) delete process.env.COCO_RPC_LOG_FILE;
  else process.env.COCO_RPC_LOG_FILE = savedEnv.RPC_LOG_FILE;
});

test('quietOnSuccess + 2xx: no stdout for → / ← rpc lines', async () => {
  globalThis.fetch = async () => fakeResponse(200, { data: { ok: true }, request_id: 'r1' });
  await putForOrg('org-1', '/api/v1/agents/m-1/runtime-metrics', { v: 1 }, { quietOnSuccess: true });
  const rpcLogs = logs.filter((l) => l.includes('[rpc]'));
  assert.equal(rpcLogs.length, 0, `expected no [rpc] stdout, got: ${JSON.stringify(rpcLogs)}`);
  const rpcWarns = warns.filter((l) => l.includes('[rpc]'));
  assert.equal(rpcWarns.length, 0);
});

test('quietOnSuccess + >=400: error STILL logs via console.warn', async () => {
  globalThis.fetch = async () => fakeResponse(500, { error: { detail: 'boom' } });
  await assert.rejects(
    () => putForOrg('org-1', '/api/v1/agents/m-1/runtime-metrics', { v: 1 }, { quietOnSuccess: true }),
    /boom/,
  );
  // The response line must surface as a warning even under quietOnSuccess.
  const respWarn = warns.filter((l) => l.includes('[rpc] ←') && l.includes('resp 500'));
  assert.equal(respWarn.length, 1, `expected the 500 response to warn, got: ${JSON.stringify(warns)}`);
  // And it must NOT have been printed to console.log.
  assert.equal(logs.filter((l) => l.includes('[rpc]')).length, 0);
});

test('default (no flag) + 2xx: logs → and ← as before', async () => {
  globalThis.fetch = async () => fakeResponse(200, { data: { ok: true }, request_id: 'r1' });
  await postForOrg('org-1', '/api/v1/agents/m-1/online-report', undefined);
  const reqLog = logs.filter((l) => l.includes('[rpc] →'));
  const respLog = logs.filter((l) => l.includes('[rpc] ←') && l.includes('resp 200'));
  assert.equal(reqLog.length, 1, `expected the request line on stdout, got: ${JSON.stringify(logs)}`);
  assert.equal(respLog.length, 1, `expected the response line on stdout, got: ${JSON.stringify(logs)}`);
});

test('postForOrg forwards quietOnSuccess: 2xx suppressed', async () => {
  globalThis.fetch = async () => fakeResponse(200, { data: { triggered: false }, request_id: 'r1' });
  await postForOrg('org-1', '/api/v1/agents/m-1/online-report', undefined, { quietOnSuccess: true });
  assert.equal(logs.filter((l) => l.includes('[rpc]')).length, 0);
});

test('quietStatuses: a listed error status is not printed to stdout; others still warn', async () => {
  globalThis.fetch = async () => fakeResponse(404, { error: { detail: 'not found' } });
  await assert.rejects(
    () => getForOrg('org-1', '/api/v1/agents/m-1/market-client', undefined, { quietOnSuccess: true, quietStatuses: [404] }),
    (err) => err.status === 404,
  );
  assert.equal([...logs, ...warns].filter((l) => l.includes('[rpc]')).length, 0);

  globalThis.fetch = async () => fakeResponse(500, { error: { detail: 'boom' } });
  await assert.rejects(
    () => getForOrg('org-1', '/api/v1/agents/m-1/market-client', undefined, { quietOnSuccess: true, quietStatuses: [404] }),
    /boom/,
  );
  assert.equal(warns.filter((l) => l.includes('[rpc] ←') && l.includes('resp 500')).length, 1);
});

test('logRedactKeys: the listed fields are hidden in the → and ← lines (also inside the D8 data envelope)', async () => {
  globalThis.fetch = async () => fakeResponse(200, { data: { url: 'https://h/x?sign=SIGNATURE', expires_at: 'T' }, request_id: 'r1' });
  const out = await postForOrg('org-1', '/api/v1/connect/connections/c/sign', { action: 'a/b', url: 'https://h/x?q=SECRETQ', body: 'BODYB64' }, { logRedactKeys: ['url', 'body'] });
  assert.equal(out.url, 'https://h/x?sign=SIGNATURE', 'the caller still gets the real value');
  const all = logs.filter((l) => l.includes('[rpc]')).join('\n');
  assert.ok(all.includes('a/b'), all);
  assert.ok(all.includes('"expires_at":"T"'), all);
  assert.ok(!/SIGNATURE|SECRETQ|BODYB64/.test(all), all);
});

test('postForOrg forwards extraHeaders to the request', async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = init.headers; return fakeResponse(200, { data: {}, request_id: 'r1' }); };
  await postForOrg('org-1', '/api/v1/connect/connections/c/credential', undefined, { extraHeaders: { 'X-Connect-Client-Capabilities': 'request_signing.v1' } });
  assert.equal(seen['X-Connect-Client-Capabilities'], 'request_signing.v1');
});
