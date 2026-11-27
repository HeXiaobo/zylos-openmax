import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./kb.js', import.meta.url));

// A cws-core stand-in that records each request and answers an empty list.
async function withServer(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [], meta: { total: 0 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-list-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = params => new Promise(resolve => {
    execFile(process.execPath, [cliPath, 'kb.list', JSON.stringify(params)], {
      env: { ...process.env, HOME: home, COCO_ORG_ID: 'org-test', COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
        COCO_AUTH_TOKEN: 'kb-test-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
  return { requests, run };
}

test('kb.list passes limit, offset and statusFilter as status_filter', async t => {
  const { run, requests } = await withServer(t);
  const result = await run({ limit: 100, offset: 100, statusFilter: 'archived' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/v1/kbs?limit=100&offset=100&status_filter=archived' }]);
});

test('kb.list without parameters sends no query string', async t => {
  const { run, requests } = await withServer(t);
  const result = await run({});
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/v1/kbs' }]);
});
