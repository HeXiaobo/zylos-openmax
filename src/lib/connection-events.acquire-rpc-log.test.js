// O-1 — the Acquire response carries the connection's secrets: access_token /
// refresh_token and, for connections like Shopee, signature url_placeholders
// (sign_*). Drive acquireCredential through the REAL client.js postForOrg (RPC
// logging on, as by default, plus the file sink) and assert none of those
// values reaches an [rpc] log line, while non-secret placeholders still do.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setApiKey, setBaseUrl, setHeaders } from './client.js';
import { acquireCredential } from './connection-events.js';

const SECRETS = {
  access_token: 'AT_LIVEVALUE_0123456789',
  refresh_token: 'RT_LIVEVALUE_0123456789',
  sign_shop: 'SIGNSHOP_abcdef0123456789',
  sign_partner: 'SIGNPARTNER_abcdef0123456789',
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-rpc-'));
const logFile = path.join(dir, 'rpc.log');
const saved = {};
let out;
let origLog, origWarn, origFetch;

before(() => {
  saved.RPC_LOG = process.env.COCO_RPC_LOG;
  saved.RPC_LOG_FILE = process.env.COCO_RPC_LOG_FILE;
  delete process.env.COCO_RPC_LOG;           // default ON
  process.env.COCO_RPC_LOG_FILE = logFile;
  setApiKey('test-token');
  setBaseUrl('http://client-test.local');
  setHeaders({});
  out = [];
  origLog = console.log; origWarn = console.warn; origFetch = globalThis.fetch;
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => out.push(a.join(' '));
});

after(() => {
  console.log = origLog; console.warn = origWarn; globalThis.fetch = origFetch;
  setApiKey(null); setBaseUrl(null); setHeaders(null);
  for (const [k, env] of [['RPC_LOG', 'COCO_RPC_LOG'], ['RPC_LOG_FILE', 'COCO_RPC_LOG_FILE']]) {
    if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
  }
});

test('Acquire through the real client.js: token and sign_* url_placeholders are returned but never logged', async () => {
  const credential = {
    credential_mode: 'direct', token_type: 'bearer',
    access_token: SECRETS.access_token, refresh_token: SECRETS.refresh_token,
    expires_at: '2030-01-01T00:00:00Z',
    url_placeholders: {
      partner_id: '1253057', shop_id: '228020652', timestamp: '1763600000',
      sign_shop: SECRETS.sign_shop, sign_partner: SECRETS.sign_partner,
    },
  };
  globalThis.fetch = async () => ({ status: 200, ok: true, async text() { return JSON.stringify({ data: credential, request_id: 'r-1', server_time: 'now' }); } });

  const got = await acquireCredential('org-1', 'conn-1');
  assert.equal(got.url_placeholders.sign_shop, SECRETS.sign_shop, 'the caller still gets the real values');
  assert.equal(got.access_token, SECRETS.access_token);

  const stdout = out.join('\n');
  const file = fs.readFileSync(logFile, 'utf8');
  assert.ok(stdout.includes('[rpc] ← POST'), 'RPC response line was logged');
  assert.ok(file.includes('/connect/connections/conn-1/credential'));
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(stdout.includes(value), false, `${name} not in stdout/stderr log`);
    assert.equal(file.includes(value), false, `${name} not in the RPC log file`);
  }
  // Non-secret placeholders stay visible for debugging.
  assert.ok(stdout.includes('228020652') && stdout.includes('1763600000'), 'shop_id / timestamp still logged');
});
