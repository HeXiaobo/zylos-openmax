import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { postForOrg, setApiKey, setBaseUrl, setHeaders } from './client.js';

test('enrollment RPC sends the credential without logging request or arbitrary reflected response bodies', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-computer-remote-rpc-'));
  const file = path.join(dir, 'rpc.log');
  const oldFile = process.env.COCO_RPC_LOG_FILE;
  const oldEnabled = process.env.COCO_RPC_LOG;
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const oldWarn = console.warn;
  t.after(() => {
    if (oldFile === undefined) delete process.env.COCO_RPC_LOG_FILE;
    else process.env.COCO_RPC_LOG_FILE = oldFile;
    if (oldEnabled === undefined) delete process.env.COCO_RPC_LOG;
    else process.env.COCO_RPC_LOG = oldEnabled;
    globalThis.fetch = oldFetch;
    console.log = oldLog;
    console.warn = oldWarn;
    setApiKey(null);
    setBaseUrl(null);
    setHeaders(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.COCO_RPC_LOG_FILE = file;
  delete process.env.COCO_RPC_LOG;
  setApiKey('test-token');
  setBaseUrl('https://core.example.test');
  setHeaders({});
  const logged = [];
  console.log = console.warn = (line) => logged.push(line);
  const ticket = 'plaintext_test_ticket';
  globalThis.fetch = async (_, init) => {
    assert.deepEqual(JSON.parse(init.body), { ticket });
    assert.equal(init.redirect, 'error');
    return new Response(`Upstream problem with ${ticket}`, { status: 400 });
  };
  await assert.rejects(
    postForOrg('test-org', '/api/v1/connect/computer-use/connections/test/prepare-result', { ticket }, {
      sensitiveBody: true, timeoutMs: 500,
    }),
    (error) => error.status === 400,
  );
  const text = logged.join('\n');
  const fileText = fs.readFileSync(file, 'utf8');
  for (const sink of [text, fileText]) {
    assert.match(sink, /req: \[REDACTED\]/);
    assert.match(sink, /resp 400: \[REDACTED\]/);
    assert.ok(!sink.includes(ticket));
  }
});
