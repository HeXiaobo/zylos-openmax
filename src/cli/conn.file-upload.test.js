// conn.invoke proxy branch — local-file upload wiring (Composio 文件上传方案 B,
// P1–P6), exercised end-to-end via subprocess against a local server that plays
// cws-core (describe / upload-slot / execute) AND the presigned storage URL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));

function setupHome(connections) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-upload-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  const connDir = path.join(compDir, 'runtime/connect');
  fs.mkdirSync(connDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { 'org-1': { enabled: true, org_id: 'org-1', self: { member_id: 'm-self' } } },
  }));
  fs.writeFileSync(path.join(connDir, 'connections-index.org-1.json'), JSON.stringify({ connections }));
  return home;
}

const PROXY_CONN = { c1: { id: 'c1', applicationId: 'app-yt', slug: 'youtube', name: 'YouTube', status: 'active', credentialMode: 'proxy' } };
const SCHEMA = { type: 'object', properties: { videoFilePath: { type: 'object', file_uploadable: true }, title: { type: 'string' } } };

function runConn(home, params, apiUrl) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
    delete env.OPENMAX_TEST_FORCE_GROUP_GUARD;
    execFile(process.execPath, [cliPath, 'conn.invoke', JSON.stringify(params)], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function withFakeServer({ slotStatus = 200 } = {}, fn) {
  const seen = [];
  let base;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw });
      if (req.method === 'GET' && req.url.includes('/connect/agents/me/connections')) {
        // Refresh for an index entry without applicationId: still unresolved.
        return json(res, 200, { data: [{ id: 'c1', status: 'active', credential_mode: 'proxy' }], request_id: 'r' });
      }
      if (req.method === 'GET' && req.url.includes('/connect/applications/app-yt/actions/YOUTUBE_UPLOAD_VIDEO')) {
        return json(res, 200, { data: { action: 'YOUTUBE_UPLOAD_VIDEO', input_schema: SCHEMA }, request_id: 'r' });
      }
      if (req.method === 'POST' && req.url.includes('/connect/connections/c1/files/upload-slot')) {
        if (slotStatus !== 200) return json(res, slotStatus, { error: { detail: 'Not Found' }, request_id: 'r' });
        return json(res, 200, { data: { upload_id: 'fu_01', presigned_url: `${base}/storage/obj.mp4?X-Amz-Signature=SECRET`, expires_at: 'x' }, request_id: 'r' });
      }
      if (req.method === 'PUT' && req.url.startsWith('/storage/')) {
        res.writeHead(200); res.end(); return undefined;
      }
      if (req.method === 'POST' && req.url.includes('/connect/connections/c1/actions/execute')) {
        return json(res, 200, { data: { status_code: 200, body: { id: 'vid-1' } }, request_id: 'r' });
      }
      return json(res, 404, { error: { detail: 'unexpected' }, request_id: 'r' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, seen); } finally { await new Promise((r) => server.close(r)); }
}

test('conn.invoke proxy + local file: describe → upload-slot → PUT → execute with {upload_id}', async () => {
  const home = setupHome(PROXY_CONN);
  const data = crypto.randomBytes(64 * 1024);
  const file = path.join(home, 'clip.mp4');
  fs.writeFileSync(file, data);
  await withFakeServer({}, async (base, seen) => {
    const { code, stdout, stderr } = await runConn(home, { app: 'youtube', action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: file, title: 'T' } }, base);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { status_code: 200, body: { id: 'vid-1' } });

    const slot = seen.find((s) => s.url.includes('/files/upload-slot'));
    assert.deepEqual(JSON.parse(slot.raw), {
      action: 'YOUTUBE_UPLOAD_VIDEO', filename: 'clip.mp4', mimetype: 'video/mp4', size: data.length,
      md5: crypto.createHash('md5').update(data).digest('hex'),
    });
    const put = seen.find((s) => s.method === 'PUT');
    assert.ok(put.raw.equals(data));
    assert.equal(put.headers['content-type'], 'video/mp4');
    assert.equal(put.headers.authorization, undefined, 'no bearer token to the storage URL');
    const exec = seen.find((s) => s.url.includes('/actions/execute'));
    assert.deepEqual(JSON.parse(exec.raw), { action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: { upload_id: 'fu_01' }, title: 'T' } });
    assert.ok(!stdout.includes('SECRET') && !stderr.includes('SECRET'), 'presigned URL never printed');

    // Schema is cached: a second call does not describe again.
    const before = seen.filter((s) => s.method === 'GET').length;
    const again = await runConn(home, { app: 'youtube', action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: file } }, base);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(seen.filter((s) => s.method === 'GET').length, before);
  });
});

test('conn.invoke proxy + URL value: no upload-slot, params forwarded unchanged', async () => {
  const home = setupHome(PROXY_CONN);
  await withFakeServer({}, async (base, seen) => {
    const params = { videoFilePath: 'https://cdn.test/a.mp4', title: 'T' };
    const { code, stderr } = await runConn(home, { app: 'youtube', action: 'YOUTUBE_UPLOAD_VIDEO', params }, base);
    assert.equal(code, 0, stderr);
    assert.ok(!seen.some((s) => s.url.includes('upload-slot')));
    assert.deepEqual(JSON.parse(seen.find((s) => s.url.includes('/actions/execute')).raw).params, params);
  });
});

test('conn.invoke proxy + local file on an old server (upload-slot 404) → actionable 400', async () => {
  const home = setupHome(PROXY_CONN);
  const file = path.join(home, 'clip.mp4');
  fs.writeFileSync(file, 'x');
  await withFakeServer({ slotStatus: 404 }, async (base, seen) => {
    const { code, stderr } = await runConn(home, { app: 'youtube', action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: file } }, base);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'local_file_upload_unsupported');
    assert.ok(!seen.some((s) => s.url.includes('/actions/execute')));
  });
});

test('conn.invoke proxy + missing local file → 400 file_not_found, nothing uploaded or executed', async () => {
  const home = setupHome(PROXY_CONN);
  await withFakeServer({}, async (base, seen) => {
    const { code, stderr } = await runConn(home, { app: 'youtube', action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: '/no/such/clip.mp4' } }, base);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'file_not_found');
    assert.ok(!seen.some((s) => s.url.includes('upload-slot') || s.url.includes('/actions/execute')));
  });
});

test('conn.invoke proxy without applicationId: no describe, executes as before', async () => {
  const home = setupHome({ c1: { ...PROXY_CONN.c1, applicationId: null } });
  await withFakeServer({}, async (base, seen) => {
    const { code, stderr } = await runConn(home, { connectionId: 'c1', action: 'YOUTUBE_UPLOAD_VIDEO', params: { videoFilePath: '/tmp/x.mp4' } }, base);
    assert.equal(code, 0, stderr);
    assert.ok(!seen.some((s) => s.method === 'GET' && s.url.includes('/actions/')));
    assert.deepEqual(JSON.parse(seen.find((s) => s.url.includes('/actions/execute')).raw).params, { videoFilePath: '/tmp/x.mp4' });
  });
});
