// The prepare-result body carries the connection Key. Drive it through the
// REAL client.js postForOrg (RPC logging on, as by default, plus the file
// sink) and assert the Key never reaches a log line — stdout, warn or file.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { postForOrg, getForOrg, apiPath, setApiKey, setBaseUrl, setHeaders } from './client.js';
import { createBrowserRemoteConnector } from './browser-remote-connector.js';

const KEY = 'brk_LIVEKEYVALUE0123456789abcdef';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-rpc-'));
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

test('prepare-result through the real client.js: the Key is sent but never logged', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init.body });
    return { status: 200, ok: true, async text() { return JSON.stringify({ success: true }); } };
  };
  const execFile = async (file, args) => {
    if (file === 'zylos') return { stdout: JSON.stringify({ name: 'browser-remote' }) };
    if (file === 'pm2') return { stdout: JSON.stringify([{ name: 'zylos-browser-remote', pm2_env: { status: 'online' } }]) };
    const cmd = args[1];
    if (cmd === 'list') return { stdout: JSON.stringify({ ok: true, keys: [] }) };
    if (cmd === 'new') return { stdout: JSON.stringify({ ok: true, key: KEY, keyId: 'kid-1', connectionId: 'conn-1' }) };
    throw new Error(`unexpected ${cmd}`);
  };
  const connector = createBrowserRemoteConnector({
    getForOrg, postForOrg, apiPath,
    resolveRelayUrl: async () => 'wss://agent.example.com/browser-remote/ext',
    execFile, nodeBin: 'node', home: dir,
    keyRecordFile: path.join(dir, 'rec.json'),
    log: (m) => out.push(m), warn: (m) => out.push(m),
  });
  await connector.handleCommand({ slug: 'acme', org_id: 'org-1', self: { member_id: 'agent-1' } }, {
    payload: { data: { channel_type: 'browser-remote', action: 'prepare', binding_id: 'conn-1', request_id: 'req-1', agent_member_id: 'agent-1' } },
  });

  const post = sent.find((s) => s.url.endsWith('/connect/browser-connections/conn-1/prepare-result'));
  assert.ok(post, 'prepare-result was posted');
  assert.equal(JSON.parse(post.body).key, KEY, 'the Key itself still goes on the wire');

  const stdout = out.join('\n');
  assert.ok(stdout.includes('[rpc] → POST'), 'RPC request line was logged');
  assert.equal(stdout.includes(KEY), false, 'Key not in stdout/stderr log');
  const file = fs.readFileSync(logFile, 'utf8');
  assert.ok(file.includes('prepare-result'));
  assert.equal(file.includes(KEY), false, 'Key not in the RPC log file');
});
