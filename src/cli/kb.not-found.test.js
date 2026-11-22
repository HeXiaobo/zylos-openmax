import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./kb.js', import.meta.url));
const KB = '55555555-5555-5555-5555-555555555555';

// A cws-core stand-in answering every request with one problem response.
async function withServer(t, status, body) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(status, { 'content-type': 'application/problem+json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-not-found-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (command, params) => new Promise(resolve => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: { ...process.env, HOME: home, COCO_ORG_ID: 'org-test', COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
        COCO_AUTH_TOKEN: 'kb-test-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
  return { requests, run };
}

function lastJsonLine(text) {
  const lines = text.trim().split('\n').filter(line => line.startsWith('{'));
  return JSON.parse(lines[lines.length - 1]);
}

test('kb.page_create into a deleted knowledge base prints KB_NOT_FOUND, the kbId and the owner guidance', async t => {
  const { run, requests } = await withServer(t, 404, { error: { title: 'Not Found', status: 404, code: 'KB_NOT_FOUND',
    detail: 'This knowledge base was deleted, does not exist, or is not visible to you.', meta: { kb_id: KB } }, request_id: 'r1' });
  const result = await run('kb.page_create', { kbId: KB, title: 'Run report', body: '# Report' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const payload = lastJsonLine(result.stderr);
  assert.equal(payload.status, 404);
  assert.equal(payload.code, 'KB_NOT_FOUND');
  assert.equal(payload.kbId, KB);
  assert.equal(payload.error, 'This knowledge base was deleted, does not exist, or is not visible to you.');
  assert.match(payload.hint, /was deleted, does not exist, or you can no longer access it/);
  assert.match(payload.hint, /not "gateway not connected"/);
  assert.deepEqual(requests, [{ method: 'POST', url: `/api/v1/kbs/${KB}/pages` }]);
});

test('kb.page_create answered a plain 404 by an older cws-core still carries the knowledge base context', async t => {
  const { run } = await withServer(t, 404, { error: { title: 'Not Found', status: 404, code: 'KB_ERROR', detail: 'not found' } });
  const payload = lastJsonLine((await run('kb.page_create', { kbId: KB, title: 'Run report' })).stderr);
  assert.equal(payload.code, 'KB_ERROR');
  assert.equal(payload.kbId, KB);
  assert.match(payload.hint, new RegExp(`Knowledge base ${KB} was deleted, does not exist, or you can no longer access it`));
});

test('other KB failures keep their output, plus the code', async t => {
  const { run } = await withServer(t, 409, { error: { title: 'Conflict', status: 409, code: 'KB_REVISION_CONFLICT', detail: 'reload' } });
  const payload = lastJsonLine((await run('kb.page_content_write', { pageId: 'p1', body: 'x' })).stderr);
  assert.deepEqual(payload, { error: 'reload', status: 409, code: 'KB_REVISION_CONFLICT' });
});
