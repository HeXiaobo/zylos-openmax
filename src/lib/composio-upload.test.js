import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_LOCAL_UPLOAD_BYTES, resolveMaxUploadBytes, putTimeoutMs, MIN_PUT_TIMEOUT_MS,
  isUrlString, isLocalPathValue, hasLocalPathCandidate,
  findLocalFileParams, checkUploadPath, md5File, mimeForFilename, inspectLocalFile,
  putFileToPresignedUrl, uploadSlotPath, prepareFileParams, isUploadIdRejected,
  runProxyExecuteWithUploads,
} from './composio-upload.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cupload-home-'));
}

function writeFile(dir, name, content = 'hello') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// --- constants ----------------------------------------------------------------

test('cap: 500MB default, env override only for a positive integer', () => {
  assert.equal(MAX_LOCAL_UPLOAD_BYTES, 524288000);
  assert.equal(resolveMaxUploadBytes({}), 524288000);
  assert.equal(resolveMaxUploadBytes({ OPENMAX_CONN_UPLOAD_MAX_BYTES: '1000' }), 1000);
  assert.equal(resolveMaxUploadBytes({ OPENMAX_CONN_UPLOAD_MAX_BYTES: '-5' }), 524288000);
  assert.equal(resolveMaxUploadBytes({ OPENMAX_CONN_UPLOAD_MAX_BYTES: 'abc' }), 524288000);
});

test('PUT timeout: at least 10 minutes, scaled up for big files', () => {
  assert.equal(putTimeoutMs(1024), MIN_PUT_TIMEOUT_MS);
  assert.ok(putTimeoutMs(500 * 1024 * 1024) > MIN_PUT_TIMEOUT_MS);
});

// --- P2: value classification -------------------------------------------------

test('path detection: http(s) URLs are not local paths; other non-blank strings are', () => {
  assert.equal(isUrlString('https://x.test/a.mp4'), true);
  assert.equal(isUrlString('HTTP://x.test/a'), true);
  assert.equal(isLocalPathValue('https://x.test/a.mp4'), false);
  assert.equal(isLocalPathValue('http://x.test/a.mp4'), false);
  assert.equal(isLocalPathValue('/tmp/a.mp4'), true);
  assert.equal(isLocalPathValue('~/v/a.mp4'), true);
  assert.equal(isLocalPathValue('a.mp4'), true);
  assert.equal(isLocalPathValue(''), false);
  assert.equal(isLocalPathValue('   '), false);
  assert.equal(isLocalPathValue({ upload_id: 'x' }), false);
  assert.equal(isLocalPathValue(null), false);
});

test('hasLocalPathCandidate: only strings that are not URLs count', () => {
  assert.equal(hasLocalPathCandidate({ n: 1, b: true, u: 'https://a' }), false);
  assert.equal(hasLocalPathCandidate({ deep: [{ x: '/tmp/a' }] }), true);
  assert.equal(hasLocalPathCandidate({}), false);
});

// --- P2: schema walker --------------------------------------------------------

test('walker: top-level file_uploadable property with a local path', () => {
  const schema = { type: 'object', properties: { videoFilePath: { type: 'object', file_uploadable: true }, title: { type: 'string' } } };
  const hits = findLocalFileParams(schema, { videoFilePath: '/tmp/a.mp4', title: 'my title' });
  assert.deepEqual(hits, [{ path: ['videoFilePath'], value: '/tmp/a.mp4' }]);
});

test('walker: URL / base64 object / upload_id object values pass through (no hits)', () => {
  const schema = { properties: { f: { file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(schema, { f: 'https://cdn.test/a.mp4' }), []);
  assert.deepEqual(findLocalFileParams(schema, { f: { name: 'a.txt', mimetype: 'text/plain', content_base64: 'aGk=' } }), []);
  assert.deepEqual(findLocalFileParams(schema, { f: { upload_id: 'fu_1' } }), []);
});

test('walker: no file_uploadable params → no hits even with path-like strings', () => {
  const schema = { properties: { path: { type: 'string' }, body: { type: 'string' } } };
  assert.deepEqual(findLocalFileParams(schema, { path: '/tmp/a', body: 'x' }), []);
});

test('walker: nested objects', () => {
  const schema = { properties: { message: { type: 'object', properties: { attachment: { file_uploadable: true }, subject: { type: 'string' } } } } };
  const hits = findLocalFileParams(schema, { message: { attachment: '/tmp/r.pdf', subject: 's' } });
  assert.deepEqual(hits, [{ path: ['message', 'attachment'], value: '/tmp/r.pdf' }]);
});

test('walker: anyOf / oneOf / allOf (incl. the §4.4 rewritten schema shape)', () => {
  const rewritten = { properties: { v: { file_uploadable: true, anyOf: [{ type: 'string' }, { type: 'object', properties: { upload_id: { type: 'string' } } }] } } };
  assert.deepEqual(findLocalFileParams(rewritten, { v: '/tmp/a.mp4' }), [{ path: ['v'], value: '/tmp/a.mp4' }]);
  const nested = { properties: { x: { anyOf: [{ type: 'null' }, { type: 'object', properties: { f: { file_uploadable: true } } }] } } };
  assert.deepEqual(findLocalFileParams(nested, { x: { f: 'a.bin' } }), [{ path: ['x', 'f'], value: 'a.bin' }]);
  const all = { allOf: [{ properties: { f: { file_uploadable: true } } }, { properties: { g: { type: 'string' } } }] };
  assert.deepEqual(findLocalFileParams(all, { f: '/a', g: '/b' }), [{ path: ['f'], value: '/a' }]);
  const one = { properties: { x: { oneOf: [{ type: 'string' }, { file_uploadable: true }] } } };
  assert.deepEqual(findLocalFileParams(one, { x: '/a' }), [{ path: ['x'], value: '/a' }]);
});

test('walker: $ref through $defs and definitions, and a recursive $ref terminates', () => {
  const s1 = { $defs: { File: { type: 'object', file_uploadable: true } }, properties: { f: { $ref: '#/$defs/File' } } };
  assert.deepEqual(findLocalFileParams(s1, { f: '/tmp/a' }), [{ path: ['f'], value: '/tmp/a' }]);
  const s2 = { definitions: { Att: { properties: { file: { file_uploadable: true } } } }, properties: { att: { $ref: '#/definitions/Att' } } };
  assert.deepEqual(findLocalFileParams(s2, { att: { file: 'x.pdf' } }), [{ path: ['att', 'file'], value: 'x.pdf' }]);
  const cyc = { $defs: { Node: { properties: { child: { $ref: '#/$defs/Node' }, f: { file_uploadable: true } } } }, $ref: '#/$defs/Node' };
  assert.deepEqual(findLocalFileParams(cyc, { child: { child: { f: '/deep' } } }), [{ path: ['child', 'child', 'f'], value: '/deep' }]);
});

test('walker: arrays — items of file objects, a file_uploadable array of strings, prefixItems', () => {
  const s = { properties: { attachments: { type: 'array', items: { file_uploadable: true } } } };
  assert.deepEqual(findLocalFileParams(s, { attachments: ['/a', 'https://b', { upload_id: 'u' }, '/c'] }), [
    { path: ['attachments', 0], value: '/a' },
    { path: ['attachments', 3], value: '/c' },
  ]);
  const arr = { properties: { files: { type: 'array', file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(arr, { files: ['/a', 'https://b'] }), [{ path: ['files', 0], value: '/a' }]);
  const objs = { properties: { list: { items: { properties: { f: { file_uploadable: true } } } } } };
  assert.deepEqual(findLocalFileParams(objs, { list: [{ f: '/x' }, { f: 'https://y' }] }), [{ path: ['list', 0, 'f'], value: '/x' }]);
  const pre = { properties: { t: { prefixItems: [{ type: 'string' }, { file_uploadable: true }] } } };
  assert.deepEqual(findLocalFileParams(pre, { t: ['/not-file', '/file'] }), [{ path: ['t', 1], value: '/file' }]);
});

test('walker: input_schema as a JSON string; empty / bad schema → no hits', () => {
  const s = JSON.stringify({ properties: { f: { file_uploadable: true } } });
  assert.deepEqual(findLocalFileParams(s, { f: '/a' }), [{ path: ['f'], value: '/a' }]);
  assert.deepEqual(findLocalFileParams('', { f: '/a' }), []);
  assert.deepEqual(findLocalFileParams('{bad', { f: '/a' }), []);
  assert.deepEqual(findLocalFileParams(null, { f: '/a' }), []);
});

test('walker: one location reported once even when reachable through several branches', () => {
  const s = { properties: { f: { file_uploadable: true } }, allOf: [{ properties: { f: { file_uploadable: true } } }] };
  assert.equal(findLocalFileParams(s, { f: '/a' }).length, 1);
});

// --- P3: local file validation -------------------------------------------------

test('checkUploadPath: regular file → real path, size, filename; ~ expands to home', () => {
  const home = tmpHome();
  const f = writeFile(path.join(home, 'videos'), 'a.mp4', 'abc');
  const r = checkUploadPath('~/videos/a.mp4', { home });
  assert.equal(r.real, fs.realpathSync(f));
  assert.equal(r.size, 3);
  assert.equal(r.filename, 'a.mp4');
});

test('checkUploadPath: relative path resolves against cwd', () => {
  const home = tmpHome();
  writeFile(path.join(home, 'w'), 'r.txt');
  assert.equal(checkUploadPath('r.txt', { home, cwd: path.join(home, 'w') }).filename, 'r.txt');
});

test('checkUploadPath: missing file → 400 file_not_found with what-to-do hint', () => {
  const home = tmpHome();
  assert.throws(() => checkUploadPath('/nope/x.mp4', { home, paramName: 'videoFilePath' }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'file_not_found');
    assert.match(e.message, /videoFilePath/);
    assert.match(e.message, /https URL/);
    return true;
  });
});

test('checkUploadPath: directory → 400 file_not_regular', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'd'));
  assert.throws(() => checkUploadPath(path.join(home, 'd'), { home }), (e) => e.status === 400 && e.code === 'file_not_regular');
});

test('checkUploadPath: size over the cap → 400 file_too_large; at the cap passes', () => {
  const home = tmpHome();
  const f = writeFile(home, 'big.bin', Buffer.alloc(11));
  assert.throws(() => checkUploadPath(f, { home, maxBytes: 10 }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'file_too_large');
    assert.match(e.message, /smaller file|https URL/);
    return true;
  });
  assert.equal(checkUploadPath(f, { home, maxBytes: 11 }).size, 11);
});

test('deny list: ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/bot-credentials, any .env, component runtime/config', () => {
  const home = tmpHome();
  const comp = path.join(home, 'zylos/components/openmax');
  const denied = [
    writeFile(path.join(home, '.ssh'), 'id_ed25519'),
    writeFile(path.join(home, '.aws'), 'credentials'),
    writeFile(path.join(home, '.gnupg'), 'secring.gpg'),
    writeFile(path.join(home, '.config/bot-credentials'), 'x.json'),
    writeFile(path.join(home, 'zylos'), '.env'),
    writeFile(path.join(home, 'proj'), '.env.local'),
    writeFile(path.join(home, 'proj'), 'prod.env'),
    writeFile(path.join(comp, 'runtime/connect/credentials'), 'c1.json'),
    writeFile(comp, 'config.json'),
    writeFile(home, '.netrc'),
    writeFile(path.join(home, 'keys'), 'server.pem'),
  ];
  for (const p of denied) {
    assert.throws(() => checkUploadPath(p, { home }), (e) => {
      assert.equal(e.status, 400, p);
      assert.equal(e.code, 'file_forbidden', p);
      return true;
    }, p);
  }
  // A normal file next to them is fine.
  assert.equal(checkUploadPath(writeFile(path.join(home, 'proj'), 'readme.md'), { home }).filename, 'readme.md');
});

test('deny list: a symlink to a denied file is refused (checked after realpath)', () => {
  const home = tmpHome();
  const secret = writeFile(path.join(home, '.ssh'), 'id_rsa', 'PRIVATE');
  const link = path.join(home, 'innocent.mp4');
  fs.symlinkSync(secret, link);
  assert.throws(() => checkUploadPath(link, { home }), (e) => e.status === 400 && e.code === 'file_forbidden');
  const envLink = path.join(home, 'notes.txt');
  fs.symlinkSync(writeFile(path.join(home, 'app'), '.env', 'K=V'), envLink);
  assert.throws(() => checkUploadPath(envLink, { home }), (e) => e.code === 'file_forbidden');
  // Symlinked denied directory (~/.aws → elsewhere) is also refused.
  const realAws = path.join(home, 'stash-aws');
  writeFile(realAws, 'credentials');
  fs.symlinkSync(realAws, path.join(home, '.aws'));
  assert.throws(() => checkUploadPath(path.join(home, '.aws/credentials'), { home }), (e) => e.code === 'file_forbidden');
  assert.throws(() => checkUploadPath(path.join(realAws, 'credentials'), { home }), (e) => e.code === 'file_forbidden');
});

test('md5File streams and matches crypto md5; mimetype by extension with octet-stream fallback', async () => {
  const home = tmpHome();
  const data = crypto.randomBytes(300 * 1024);
  const f = writeFile(home, 'clip.mp4', data);
  assert.equal(await md5File(f), crypto.createHash('md5').update(data).digest('hex'));
  assert.equal(mimeForFilename('a.mp4'), 'video/mp4');
  assert.equal(mimeForFilename('a.MOV'), 'video/quicktime');
  assert.equal(mimeForFilename('a.webm'), 'video/webm');
  assert.equal(mimeForFilename('a.pdf'), 'application/pdf');
  assert.equal(mimeForFilename('a.unknownext'), 'application/octet-stream');
  assert.equal(mimeForFilename('noext'), 'application/octet-stream');
  const info = await inspectLocalFile(f, { home });
  assert.deepEqual(Object.keys(info).sort(), ['filename', 'md5', 'mimetype', 'real', 'size']);
  assert.equal(info.mimetype, 'video/mp4');
  assert.equal(info.size, data.length);
});

// --- P5: streaming PUT --------------------------------------------------------

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((r) => server.close(r));
  }
}

test('putFileToPresignedUrl: streams bytes with Content-Type/Content-Length and no auth headers', async () => {
  const home = tmpHome();
  const data = crypto.randomBytes(200 * 1024);
  const f = writeFile(home, 'a.mp4', data);
  let got;
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got = { method: req.method, headers: req.headers, body: Buffer.concat(chunks), url: req.url };
      res.writeHead(200); res.end();
    });
  }, async (base) => {
    const r = await putFileToPresignedUrl(`${base}/bucket/key.mp4?X-Amz-Signature=sig`, { filePath: f, size: data.length, mimetype: 'video/mp4' });
    assert.equal(r.status, 200);
  });
  assert.equal(got.method, 'PUT');
  assert.equal(got.url, '/bucket/key.mp4?X-Amz-Signature=sig');
  assert.equal(got.headers['content-type'], 'video/mp4');
  assert.equal(got.headers['content-length'], String(data.length));
  assert.equal(got.headers['transfer-encoding'], undefined);
  assert.equal(got.headers.authorization, undefined);
  assert.equal(got.headers['cf-access-client-id'], undefined);
  assert.ok(got.body.equals(data));
});

test('putFileToPresignedUrl: non-2xx → clear error that never contains the presigned URL', async () => {
  const home = tmpHome();
  const f = writeFile(home, 'a.bin', 'x');
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(403); res.end('SignatureDoesNotMatch for http://127.0.0.1/bucket?X-Amz-Signature=SECRET'); });
  }, async (base) => {
    const url = `${base}/bucket/k?X-Amz-Signature=SECRET`;
    await assert.rejects(putFileToPresignedUrl(url, { filePath: f, size: 1, mimetype: 'application/octet-stream' }), (e) => {
      assert.equal(e.code, 'upload_put_failed');
      assert.match(e.message, /HTTP 403/);
      assert.ok(!e.message.includes('SECRET'), e.message);
      assert.ok(!e.message.includes(base), e.message);
      return true;
    });
  });
});

test('putFileToPresignedUrl: network error and timeout carry no URL', async () => {
  const home = tmpHome();
  const f = writeFile(home, 'a.bin', 'x');
  await assert.rejects(putFileToPresignedUrl('http://127.0.0.1:1/k?sig=SECRET', { filePath: f, size: 1 }), (e) => {
    assert.equal(e.code, 'upload_put_failed');
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
  await withServer((req) => { req.resume(); /* never answers */ }, async (base) => {
    await assert.rejects(putFileToPresignedUrl(`${base}/k?sig=SECRET`, { filePath: f, size: 1, timeoutMs: 100 }), (e) => {
      assert.equal(e.code, 'upload_put_timeout');
      assert.ok(!e.message.includes('SECRET'));
      return true;
    });
  });
});

// --- P4–P6 flow with mocked deps ----------------------------------------------

const SCHEMA = { properties: { videoFilePath: { file_uploadable: true }, title: { type: 'string' } } };

function mockDeps({ slot = () => ({ upload_id: 'fu_1', presigned_url: 'https://r2.test/put?sig=S', expires_at: 't' }), put, execute } = {}) {
  const calls = { slot: [], put: [], execute: [], inspect: [] };
  let n = 0;
  const deps = {
    getSchema: async () => SCHEMA,
    inspect: async (p, opts) => {
      calls.inspect.push([p, opts]);
      return { real: `/real${p}`, size: 5, filename: path.basename(p), md5: '0'.repeat(32), mimetype: 'video/mp4' };
    },
    requestSlot: async (body) => { calls.slot.push(body); n += 1; return slot(body, n); },
    putFile: async (url, opts) => { calls.put.push([url, opts]); if (put) return put(url, opts); return { status: 200 }; },
    execute: async (params) => { calls.execute.push(params); if (execute) return execute(params, calls.execute.length); return { status_code: 200, body: { ok: true } }; },
  };
  return { deps, calls };
}

test('uploadSlotPath shape', () => {
  assert.equal(uploadSlotPath('c1'), '/connect/connections/c1/files/upload-slot');
});

test('flow success: slot body, PUT to presigned URL, param replaced by {upload_id}, execute once', async () => {
  const { deps, calls } = mockDeps();
  const params = { videoFilePath: '/tmp/a.mp4', title: 'T' };
  const res = await runProxyExecuteWithUploads({ action: 'YOUTUBE_UPLOAD_VIDEO', params }, deps);
  assert.deepEqual(res, { status_code: 200, body: { ok: true } });
  assert.deepEqual(calls.slot, [{ action: 'YOUTUBE_UPLOAD_VIDEO', filename: 'a.mp4', mimetype: 'video/mp4', size: 5, md5: '0'.repeat(32) }]);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0][0], 'https://r2.test/put?sig=S');
  assert.deepEqual(calls.put[0][1], { filePath: '/real/tmp/a.mp4', size: 5, mimetype: 'video/mp4' });
  assert.deepEqual(calls.execute, [{ videoFilePath: { upload_id: 'fu_1' }, title: 'T' }]);
  assert.equal(params.videoFilePath, '/tmp/a.mp4', 'caller params are not mutated');
});

test('flow: empty presigned_url (type=existing) skips the PUT', async () => {
  const { deps, calls } = mockDeps({ slot: () => ({ upload_id: 'fu_e', presigned_url: '' }) });
  await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
  assert.equal(calls.put.length, 0);
  assert.deepEqual(calls.execute, [{ videoFilePath: { upload_id: 'fu_e' } }]);
});

test('flow: 404 from upload-slot (old server) → actionable 400 "pass a public https URL"', async () => {
  const { deps, calls } = mockDeps({ slot: () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'local_file_upload_unsupported');
    assert.match(e.message, /not supported on this environment/);
    assert.match(e.message, /https URL/);
    return true;
  });
  assert.equal(calls.execute.length, 0);
});

test('flow: other upload-slot errors propagate unchanged', async () => {
  const err = Object.assign(new Error('rate limited'), { status: 429 });
  const { deps } = mockDeps({ slot: () => { throw err; } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => e === err);
});

test('flow: PUT failure → error, execute never called', async () => {
  const { deps, calls } = mockDeps({ put: () => { throw Object.assign(new Error('file upload to storage failed (HTTP 500)'), { status: 502, code: 'upload_put_failed' }); } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => e.code === 'upload_put_failed');
  assert.equal(calls.execute.length, 0);
});

test('flow: upload_id expired on execute → re-run P4–P6 once and retry with the new id', async () => {
  const { deps, calls } = mockDeps({
    slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: 'https://r2.test/p' }),
    execute: (_p, n) => {
      if (n === 1) throw Object.assign(new Error('upload_id not found or not owned by this connection'), { status: 400 });
      return { status_code: 200 };
    },
  });
  const res = await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
  assert.deepEqual(res, { status_code: 200 });
  assert.equal(calls.slot.length, 2);
  assert.equal(calls.put.length, 2);
  assert.equal(calls.inspect.length, 1, 'the file is validated/hashed once');
  assert.deepEqual(calls.execute.map((p) => p.videoFilePath.upload_id), ['fu_1', 'fu_2']);
});

test('flow: upload_id rejected twice → second error surfaces (retry only once)', async () => {
  const { deps, calls } = mockDeps({
    slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: '' }),
    execute: () => { throw Object.assign(new Error('upload_id expired'), { status: 400 }); },
  });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), /upload_id expired/);
  assert.equal(calls.execute.length, 2);
});

test('flow: an unrelated execute error is not retried', async () => {
  const { deps, calls } = mockDeps({ execute: () => { throw Object.assign(new Error('quota exceeded'), { status: 400 }); } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), /quota/);
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.slot.length, 1);
});

test('isUploadIdRejected', () => {
  assert.equal(isUploadIdRejected(Object.assign(new Error('upload_id not found or not owned by this connection'), { status: 400 })), true);
  assert.equal(isUploadIdRejected(Object.assign(new Error('upload_id expired'), { status: 410 })), true);
  assert.equal(isUploadIdRejected(Object.assign(new Error('upload_id expired'), { status: 500 })), false);
  assert.equal(isUploadIdRejected(Object.assign(new Error('not found'), { status: 404 })), false);
  assert.equal(isUploadIdRejected(null), false);
});

test('passthrough: URL and base64-object values execute unchanged, no upload calls', async () => {
  for (const v of ['https://cdn.test/a.mp4', { name: 'a.txt', mimetype: 'text/plain', content_base64: 'aGk=' }, { upload_id: 'fu_x' }]) {
    const { deps, calls } = mockDeps();
    const params = { videoFilePath: v, title: 'T' };
    await runProxyExecuteWithUploads({ action: 'A', params }, deps);
    assert.equal(calls.slot.length, 0);
    assert.equal(calls.put.length, 0);
    assert.deepEqual(calls.execute, [params]);
  }
});

test('no preprocessing: action without file params executes params as-is', async () => {
  const { deps, calls } = mockDeps();
  deps.getSchema = async () => ({ properties: { query: { type: 'string' } } });
  const params = { query: '/not/a/file' };
  await runProxyExecuteWithUploads({ action: 'A', params }, deps);
  assert.equal(calls.slot.length, 0);
  assert.equal(calls.execute[0], params);
});

test('no preprocessing: no local-path candidate → schema never fetched', async () => {
  const { deps, calls } = mockDeps();
  let fetched = 0;
  deps.getSchema = async () => { fetched += 1; return SCHEMA; };
  await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: 'https://x', n: 3 } }, deps);
  assert.equal(fetched, 0);
  assert.equal(calls.execute.length, 1);
});

test('no preprocessing: schema unavailable (null or describe throws) → execute as today', async () => {
  for (const getSchema of [async () => null, async () => { throw Object.assign(new Error('boom'), { status: 500 }); }]) {
    const { deps, calls } = mockDeps();
    deps.getSchema = getSchema;
    const params = { videoFilePath: '/tmp/a.mp4' };
    await runProxyExecuteWithUploads({ action: 'A', params }, deps);
    assert.equal(calls.slot.length, 0);
    assert.deepEqual(calls.execute, [params]);
  }
});

test('flow: params undefined → executes with {}', async () => {
  const { deps, calls } = mockDeps();
  await runProxyExecuteWithUploads({ action: 'A', params: undefined }, deps);
  assert.deepEqual(calls.execute, [{}]);
});

test('prepareFileParams: every file is validated before any upload (bad 2nd path → no slot requested)', async () => {
  const { deps, calls } = mockDeps();
  deps.inspect = async (p, { paramName }) => {
    if (p === '/missing') throw Object.assign(new Error(`file param "${paramName}": local file not found`), { status: 400, code: 'file_not_found' });
    return { real: p, size: 1, filename: 'a', md5: 'm', mimetype: 'x' };
  };
  const schema = { properties: { files: { items: { file_uploadable: true } } } };
  await assert.rejects(prepareFileParams({ inputSchema: schema, params: { files: ['/ok', '/missing'] }, action: 'A' }, deps), (e) => {
    assert.equal(e.code, 'file_not_found');
    assert.match(e.message, /files\[1\]/);
    return true;
  });
  assert.equal(calls.slot.length, 0);
});

test('prepareFileParams: several file params (nested + array) all replaced', async () => {
  const { deps } = mockDeps({ slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: '' }) });
  const schema = { properties: { a: { file_uploadable: true }, m: { properties: { list: { items: { file_uploadable: true } } } } } };
  const r = await prepareFileParams({ inputSchema: schema, params: { a: '/1', m: { list: ['/2', 'https://3'] } }, action: 'A' }, deps);
  assert.deepEqual(r.params, { a: { upload_id: 'fu_1' }, m: { list: [{ upload_id: 'fu_2' }, 'https://3'] } });
  assert.deepEqual(r.uploads.map((u) => u.param), ['a', 'm.list[0]']);
});
