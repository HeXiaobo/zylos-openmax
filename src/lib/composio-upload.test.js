import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_LOCAL_UPLOAD_BYTES, resolveMaxUploadBytes, putTimeoutMs, MIN_PUT_TIMEOUT_MS,
  isUrlString, isLocalPathValue, hasLocalPathCandidate,
  findLocalFileParams, mimeForFilename, openLocalFile, readExact, md5OfHandle, looksLikeBase64,
  putFileToPresignedUrl, uploadSlotPath, prepareFileParams, isUploadIdRejected, errorBodyCode,
  runProxyExecuteWithUploads, UPLOAD_ID_INVALID_CODE,
} from './composio-upload.js';

// A fake HOME with the openmax component's allowed upload/ and media/ dirs.
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cupload-home-'));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(comp, 'upload'), { recursive: true });
  fs.mkdirSync(path.join(comp, 'media'), { recursive: true });
  return { home, comp, upload: path.join(comp, 'upload'), media: path.join(comp, 'media') };
}

// Open fds of this process (Linux /proc), or null when unavailable.
function fdCount() {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
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

// --- value classification -----------------------------------------------------

test('path detection: only strings starting with "/" or "~/" are local paths', () => {
  assert.equal(isUrlString('https://x.test/a.mp4'), true);
  assert.equal(isLocalPathValue('/home/me/zylos/components/openmax/upload/a.mp4'), true);
  assert.equal(isLocalPathValue('~/zylos/components/openmax/upload/a.mp4'), true);
  for (const v of [
    'https://x.test/a.mp4', 'http://x.test/a.mp4', 'data:text/plain;base64,aGVsbG8=',
    'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=', 'a.mp4', './a.mp4', '../a.mp4', '~user/a', '', '   ',
  ]) assert.equal(isLocalPathValue(v), false, v);
  assert.equal(isLocalPathValue({ upload_id: 'x' }), false);
  assert.equal(isLocalPathValue(null), false);
});

test('raw base64 that starts with "/" (JPEG "/9j/…") is not a path; normal absolute paths are', () => {
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';
  assert.equal(looksLikeBase64(jpeg), true);
  assert.equal(isLocalPathValue(jpeg), false);
  assert.equal(isLocalPathValue('/9j/4AAQ'), false, 'short JPEG prefix too');
  const b64 = '/' + 'A'.repeat(80) + '==';
  assert.equal(isLocalPathValue(b64), false);
  for (const p of [
    '/home/me/zylos/components/openmax/upload/demo.mp4',
    '/home/me/zylos/components/openmax/upload/a-very-long-file-name-without-much-else-but-with-an.ext',
    '/tmp/a', '~/zylos/components/openmax/upload/9j.jpg', '~/' + 'A'.repeat(80),
  ]) assert.equal(isLocalPathValue(p), true, p);
  const schema = { properties: { f: { file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(schema, { f: jpeg }), []);
});

test('hasLocalPathCandidate: only path-looking strings count', () => {
  assert.equal(hasLocalPathCandidate({ n: 1, b: true, u: 'https://a', t: 'hello world', d: 'data:x' }), false);
  assert.equal(hasLocalPathCandidate({ deep: [{ x: '/tmp/a' }] }), true);
  assert.equal(hasLocalPathCandidate({}), false);
});

// --- schema walker --------------------------------------------------------------

test('walker: top-level file_uploadable property with a local path', () => {
  const schema = { type: 'object', properties: { videoFilePath: { type: 'object', file_uploadable: true }, title: { type: 'string' } } };
  const hits = findLocalFileParams(schema, { videoFilePath: '/tmp/a.mp4', title: '/not/a/file/param' });
  assert.deepEqual(hits, [{ path: ['videoFilePath'], value: '/tmp/a.mp4' }]);
});

test('walker: URL / data URI / base64 text / base64 object / upload_id object pass through (no hits)', () => {
  const schema = { properties: { f: { file_uploadable: true } } };
  for (const v of [
    'https://cdn.test/a.mp4', 'data:video/mp4;base64,AAAA', 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28y', 'relative.mp4',
    { name: 'a.txt', mimetype: 'text/plain', content_base64: 'aGk=' }, { upload_id: 'fu_1' },
  ]) assert.deepEqual(findLocalFileParams(schema, { f: v }), [], JSON.stringify(v));
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

test('walker: anyOf / oneOf / allOf (incl. the server-rewritten string|{upload_id} shape)', () => {
  const rewritten = { properties: { v: { file_uploadable: true, anyOf: [{ type: 'string' }, { type: 'object', properties: { upload_id: { type: 'string' } } }] } } };
  assert.deepEqual(findLocalFileParams(rewritten, { v: '/tmp/a.mp4' }), [{ path: ['v'], value: '/tmp/a.mp4' }]);
  const nested = { properties: { x: { anyOf: [{ type: 'null' }, { type: 'object', properties: { f: { file_uploadable: true } } }] } } };
  assert.deepEqual(findLocalFileParams(nested, { x: { f: '~/a.bin' } }), [{ path: ['x', 'f'], value: '~/a.bin' }]);
  const all = { allOf: [{ properties: { f: { file_uploadable: true } } }, { properties: { g: { type: 'string' } } }] };
  assert.deepEqual(findLocalFileParams(all, { f: '/a', g: '/b' }), [{ path: ['f'], value: '/a' }]);
  const one = { properties: { x: { oneOf: [{ type: 'string' }, { file_uploadable: true }] } } };
  assert.deepEqual(findLocalFileParams(one, { x: '/a' }), [{ path: ['x'], value: '/a' }]);
});

test('walker: $ref through $defs and definitions, and a recursive $ref terminates', () => {
  const s1 = { $defs: { File: { type: 'object', file_uploadable: true } }, properties: { f: { $ref: '#/$defs/File' } } };
  assert.deepEqual(findLocalFileParams(s1, { f: '/tmp/a' }), [{ path: ['f'], value: '/tmp/a' }]);
  const s2 = { definitions: { Att: { properties: { file: { file_uploadable: true } } } }, properties: { att: { $ref: '#/definitions/Att' } } };
  assert.deepEqual(findLocalFileParams(s2, { att: { file: '/x.pdf' } }), [{ path: ['att', 'file'], value: '/x.pdf' }]);
  const cyc = { $defs: { Node: { properties: { child: { $ref: '#/$defs/Node' }, f: { file_uploadable: true } } } }, $ref: '#/$defs/Node' };
  assert.deepEqual(findLocalFileParams(cyc, { child: { child: { f: '/deep' } } }), [{ path: ['child', 'child', 'f'], value: '/deep' }]);
});

test('walker: arrays — single-schema items (file leaves and objects with file props)', () => {
  const s = { properties: { attachments: { type: 'array', items: { file_uploadable: true } } } };
  assert.deepEqual(findLocalFileParams(s, { attachments: ['/a', 'https://b', { upload_id: 'u' }, '/c'] }), [
    { path: ['attachments', 0], value: '/a' },
    { path: ['attachments', 3], value: '/c' },
  ]);
  const objs = { properties: { list: { items: { properties: { f: { file_uploadable: true } } } } } };
  assert.deepEqual(findLocalFileParams(objs, { list: [{ f: '/x' }, { f: 'https://y' }] }), [{ path: ['list', 0, 'f'], value: '/x' }]);
});

// The walker mirrors the server materializer exactly: structures the server
// does not traverse are never uploaded (the value passes through unchanged).
test('walker (server parity): file_uploadable under additionalProperties is NOT a file param', () => {
  const s = { properties: { meta: { type: 'object', additionalProperties: { file_uploadable: true } } } };
  assert.deepEqual(findLocalFileParams(s, { meta: { anything: '/tmp/a.mp4' } }), []);
  const top = { additionalProperties: { file_uploadable: true } };
  assert.deepEqual(findLocalFileParams(top, { x: '/tmp/a.mp4' }), []);
});

test('walker (server parity): tuple-form items:[…] and prefixItems are NOT walked', () => {
  const tuple = { properties: { t: { type: 'array', items: [{ type: 'string' }, { file_uploadable: true }] } } };
  assert.deepEqual(findLocalFileParams(tuple, { t: ['x', '/file'] }), []);
  const pre = { properties: { t: { prefixItems: [{ type: 'string' }, { file_uploadable: true }] } } };
  assert.deepEqual(findLocalFileParams(pre, { t: ['/not-file', '/file'] }), []);
});

test('walker (server parity): an array value on a file_uploadable leaf is not split into elements', () => {
  const arr = { properties: { files: { type: 'array', file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(arr, { files: ['/a', '/b'] }), []);
});

test('walker (server parity): $ref replaces the node (siblings ignored); resolved by name in $defs/definitions', () => {
  const sib = { $defs: { Plain: { type: 'string' } }, properties: { f: { $ref: '#/$defs/Plain', file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(sib, { f: '/a' }), []);
  const byName = { definitions: { File: { file_uploadable: true } }, properties: { f: { $ref: '#/components/schemas/File' } } };
  assert.deepEqual(findLocalFileParams(byName, { f: '/a' }), [{ path: ['f'], value: '/a' }]);
  const unresolved = { properties: { f: { $ref: '#/$defs/Missing' } } };
  assert.deepEqual(findLocalFileParams(unresolved, { f: '/a' }), []);
});

test('walker (server parity): anyOf first branch with a file wins; allOf hits stop the node', () => {
  const any = { properties: { x: { anyOf: [
    { properties: { a: { file_uploadable: true } } },
    { properties: { b: { file_uploadable: true } } },
  ] } } };
  assert.deepEqual(findLocalFileParams(any, { x: { a: '/1', b: '/2' } }), [{ path: ['x', 'a'], value: '/1' }]);
  // allOf yields a file → the node's own properties are not walked (server returns early).
  const all = { allOf: [{ properties: { a: { file_uploadable: true } } }], properties: { b: { file_uploadable: true } } };
  assert.deepEqual(findLocalFileParams(all, { a: '/1', b: '/2' }), [{ path: ['a'], value: '/1' }]);
  // allOf yields nothing (absent / null / bare {s3key}) → properties are walked.
  assert.deepEqual(findLocalFileParams(all, { b: '/2' }), [{ path: ['b'], value: '/2' }]);
  assert.deepEqual(findLocalFileParams(all, { a: null, b: '/2' }), [{ path: ['b'], value: '/2' }]);
  assert.deepEqual(findLocalFileParams(all, { a: { name: 'x', s3key: 'k' }, b: '/2' }), [{ path: ['b'], value: '/2' }]);
});

test('walker (server parity): a URL / inline / upload_id leaf counts as taken, like the server "changed"', () => {
  // allOf takes a URL leaf → server returns early; the sibling local path is never resolved, so not uploaded.
  const all = { allOf: [{ properties: { a: { file_uploadable: true } } }], properties: { b: { file_uploadable: true } } };
  for (const a of ['https://x', 'aGVsbG8=', { content_base64: 'aGk=' }, { upload_id: 'u' }]) {
    assert.deepEqual(findLocalFileParams(all, { a, b: '/2' }), [], JSON.stringify(a));
  }
  // anyOf first branch takes a URL leaf → the later local-path branch is not used.
  const any = { properties: { x: { anyOf: [
    { properties: { a: { file_uploadable: true } } },
    { properties: { b: { file_uploadable: true } } },
  ] } } };
  assert.deepEqual(findLocalFileParams(any, { x: { a: 'https://x', b: '/2' } }), []);
  // ...but a first branch whose leaf is absent / null / bare {s3key} is skipped.
  assert.deepEqual(findLocalFileParams(any, { x: { b: '/2' } }), [{ path: ['x', 'b'], value: '/2' }]);
  assert.deepEqual(findLocalFileParams(any, { x: { a: null, b: '/2' } }), [{ path: ['x', 'b'], value: '/2' }]);
  assert.deepEqual(findLocalFileParams(any, { x: { a: { s3key: 'k' }, b: '/2' } }), [{ path: ['x', 'b'], value: '/2' }]);
  // {upload_id, s3key}: the server takes the upload_id path first → taken.
  assert.deepEqual(findLocalFileParams(any, { x: { a: { upload_id: 'u', s3key: 'k' }, b: '/2' } }), []);
  assert.deepEqual(findLocalFileParams(all, { a: { upload_id: 'u', s3key: 'k' }, b: '/2' }), []);
  // items: a URL in the first anyOf branch's array element is taken too.
  const anyItems = { properties: { x: { anyOf: [
    { items: { properties: { a: { file_uploadable: true } } } },
    { items: { properties: { b: { file_uploadable: true } } } },
  ] } } };
  assert.deepEqual(findLocalFileParams(anyItems, { x: [{ a: 'https://x', b: '/2' }] }), []);
  assert.deepEqual(findLocalFileParams(anyItems, { x: [{ b: '/2' }] }), [{ path: ['x', 0, 'b'], value: '/2' }]);
  // allOf: a URL in one branch does not hide a local path in another branch.
  const all2 = { allOf: [{ properties: { a: { file_uploadable: true } } }, { properties: { b: { file_uploadable: true } } }] };
  assert.deepEqual(findLocalFileParams(all2, { a: 'https://x', b: '/2' }), [{ path: ['b'], value: '/2' }]);
});

test('walker: a $ref chain resolves up to 15 hops and stops at 16 (server parity)', () => {
  const chain = (hops) => {
    const defs = {};
    for (let i = 0; i < hops; i++) defs[`D${i}`] = { $ref: `#/$defs/D${i + 1}` };
    defs[`D${hops}`] = { file_uploadable: true };
    return { $defs: defs, properties: { f: { $ref: '#/$defs/D0' } } };
  };
  // hops = number of $ref links after the property's own $ref.
  assert.deepEqual(findLocalFileParams(chain(15), { f: '/a' }), [{ path: ['f'], value: '/a' }]);
  assert.deepEqual(findLocalFileParams(chain(16), { f: '/a' }), []);
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

// --- sandbox (same policy as the direct branch: upload/ + media/ only) ----------

async function openOk(p, opts) {
  const f = await openLocalFile(p, opts);
  await f.fh.close();
  return f;
}

test('openLocalFile: file in upload/ or media/ (absolute or ~/) → size, filename, md5, mimetype', async () => {
  const { home, upload, media } = tmpHome();
  const data = crypto.randomBytes(300 * 1024);
  writeFile(upload, 'clip.mp4', data);
  const f = await openOk('~/zylos/components/openmax/upload/clip.mp4', { home });
  assert.equal(f.size, data.length);
  assert.equal(f.filename, 'clip.mp4');
  assert.equal(f.mimetype, 'video/mp4');
  assert.equal(f.md5, crypto.createHash('md5').update(data).digest('hex'));
  const g = await openOk(writeFile(media, 'r.pdf', 'pdf'), { home });
  assert.equal(g.mimetype, 'application/pdf');
});

test('mimetype by extension with octet-stream fallback', () => {
  assert.equal(mimeForFilename('a.MOV'), 'video/quicktime');
  assert.equal(mimeForFilename('a.webm'), 'video/webm');
  assert.equal(mimeForFilename('a.unknownext'), 'application/octet-stream');
  assert.equal(mimeForFilename('noext'), 'application/octet-stream');
});

test('openLocalFile: a file outside upload/ and media/ → refused with "copy it into …/upload first"', async () => {
  const { home } = tmpHome();
  const f = writeFile(path.join(home, 'videos'), 'a.mp4');
  await assert.rejects(openLocalFile(f, { home, paramName: 'videoFilePath' }), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'file_outside_allowed_dirs');
    assert.match(e.message, /videoFilePath/);
    assert.match(e.message, /copy it into .*zylos\/components\/openmax\/upload first/);
    return true;
  });
});

test('openLocalFile: relative path → file_invalid_path (absolute or ~/ only)', async () => {
  const { home } = tmpHome();
  await assert.rejects(openLocalFile('upload/a.mp4', { home }), (e) => e.status === 400 && e.code === 'file_invalid_path');
});

test('openLocalFile: missing file → 400 file_not_found; the message never echoes the full input', async () => {
  const { home, upload } = tmpHome();
  const input = path.join(upload, 'secret-dir-name', 'x.mp4');
  await assert.rejects(openLocalFile(input, { home }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'file_not_found');
    assert.ok(!e.message.includes(input), e.message);
    assert.ok(!e.message.includes('secret-dir-name'), e.message);
    return true;
  });
});

test('openLocalFile: protected files inside the allowed dirs (.env*, *.pem, *.key, id_*, dot-files) → refused', async () => {
  const { home, upload } = tmpHome();
  for (const name of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_rsa', '.hidden.mp4']) {
    const p = writeFile(upload, name);
    await assert.rejects(openLocalFile(p, { home }), (e) => {
      assert.equal(e.status, 403, name);
      assert.equal(e.code, 'file_forbidden', name);
      return true;
    }, name);
  }
});

test('openLocalFile: ~/.ssh, ~/.config, component runtime/ and config.json → refused', async () => {
  const { home, comp } = tmpHome();
  for (const p of [
    writeFile(path.join(home, '.ssh'), 'id_ed25519'),
    writeFile(path.join(home, '.config/bot-credentials'), 'x.json'),
    writeFile(path.join(comp, 'runtime/connect/credentials'), 'c1.json'),
    path.join(comp, 'config.json'),
  ]) {
    if (!fs.existsSync(p)) writeFile(path.dirname(p), path.basename(p), '{}');
    await assert.rejects(openLocalFile(p, { home }), (e) => e.status === 403 && /file_forbidden|file_outside_allowed_dirs/.test(e.code), p);
  }
});

test('openLocalFile: a symlink in upload/ pointing outside (e.g. ~/.ssh/id_rsa) is refused after realpath', async () => {
  const { home, upload } = tmpHome();
  const secret = writeFile(path.join(home, '.ssh'), 'id_rsa', 'PRIVATE');
  const link = path.join(upload, 'innocent.mp4');
  fs.symlinkSync(secret, link);
  await assert.rejects(openLocalFile(link, { home }), (e) => e.status === 403);
  const outside = writeFile(path.join(home, 'docs'), 'plan.pdf');
  const link2 = path.join(upload, 'plan.pdf');
  fs.symlinkSync(outside, link2);
  await assert.rejects(openLocalFile(link2, { home }), (e) => e.code === 'file_outside_allowed_dirs');
});

test('openLocalFile: a hard link in upload/ to a file elsewhere cannot escape (nlink > 1 refused)', async () => {
  const { home, upload } = tmpHome();
  const secret = writeFile(path.join(home, 'private'), 'notes.txt', 'SECRET');
  const hl = path.join(upload, 'notes.txt');
  fs.linkSync(secret, hl);
  await assert.rejects(openLocalFile(hl, { home }), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'file_forbidden');
    assert.match(e.message, /hard link/);
    return true;
  });
});

test('openLocalFile: directory → file_not_regular; 0-byte → file_empty; /proc → refused', async () => {
  const { home, upload } = tmpHome();
  fs.mkdirSync(path.join(upload, 'd'));
  await assert.rejects(openLocalFile(path.join(upload, 'd'), { home }), (e) => e.status === 400 && e.code === 'file_not_regular');
  await assert.rejects(openLocalFile(writeFile(upload, 'empty.txt', ''), { home }), (e) => e.status === 400 && e.code === 'file_empty');
  if (fs.existsSync('/proc/self/status')) {
    await assert.rejects(openLocalFile('/proc/self/status', { home }), (e) => e.status === 403);
  }
});

test('openLocalFile: a different inode at open than at check (parent-dir swap) → 409 file_changed, fd closed', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'a.mp4', 'abc');
  const st = fs.statSync(p);
  const before = fdCount();
  await assert.rejects(openLocalFile(p, { home, checkPath: () => ({ real: p, size: 3, dev: st.dev, ino: st.ino + 1 }) }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'file_changed');
    return true;
  });
  if (before !== null) assert.equal(fdCount(), before, 'no fd leak');
});

test('openLocalFile: the fd resolves (via /proc/self/fd) to a path outside the allowed dirs → 409, fd closed', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'a.mp4', 'abc');
  const outside = writeFile(path.join(home, 'private'), 'secret.mp4', 'abc');
  const before = fdCount();
  let asked = 0;
  await assert.rejects(openLocalFile(p, { home, readFdPath: async () => { asked += 1; return outside; } }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'file_changed');
    return true;
  });
  assert.equal(asked, 1);
  if (before !== null) assert.equal(fdCount(), before, 'no fd leak');
});

test('openLocalFile: fd path differs from the checked realpath (even inside upload/) → 409, fd closed', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'a.mp4', 'abc');
  const other = writeFile(upload, 'b.mp4', 'abc');
  const before = fdCount();
  await assert.rejects(openLocalFile(p, { home, readFdPath: async () => other }), (e) => e.status === 409 && e.code === 'file_changed');
  if (before !== null) assert.equal(fdCount(), before, 'no fd leak');
});

test('openLocalFile: fd path equal to the checked realpath but no longer passing the sandbox → 409', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'a.mp4', 'abc');
  let calls = 0;
  const real = fs.realpathSync(p);
  const st = fs.statSync(p);
  const checkPath = () => {
    calls += 1;
    if (calls > 1) throw Object.assign(new Error('outside'), { status: 403, code: 'file_outside_allowed_dirs' });
    return { real, size: 3, dev: st.dev, ino: st.ino };
  };
  await assert.rejects(openLocalFile(p, { home, checkPath, readFdPath: async () => real }), (e) => e.status === 409 && e.code === 'file_changed');
  assert.equal(calls, 2, 'sandbox re-run on the fd path');
});

test('openLocalFile: without /proc (readFdPath → null) the dev/ino comparison still applies', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'a.mp4', 'abc');
  const st = fs.statSync(p);
  const real = fs.realpathSync(p);
  const ok = await openLocalFile(p, { home, readFdPath: async () => null });
  await ok.fh.close();
  await assert.rejects(openLocalFile(p, { home, readFdPath: async () => null, checkPath: () => ({ real, size: 3, dev: st.dev, ino: st.ino + 1 }) }),
    (e) => e.code === 'file_changed');
});

test('readProcFdPath: on Linux returns the realpath of an open file', async () => {
  const { upload } = tmpHome();
  const p = writeFile(upload, 'a.bin', 'x');
  const fh = await fs.promises.open(p);
  try {
    const got = await (await import('./composio-upload.js')).readProcFdPath(fh.fd);
    if (got !== null) assert.equal(got, fs.realpathSync(p));
  } finally { await fh.close(); }
});

test('openLocalFile: a final-component symlink at open time is refused (O_NOFOLLOW)', async () => {
  const { home, upload } = tmpHome();
  const target = writeFile(upload, 'real.mp4', 'abc');
  const link = path.join(upload, 'link.mp4');
  fs.symlinkSync(target, link);
  const st = fs.statSync(target);
  // The check "saw" the target inode at the link's path (a swap after check):
  // without O_NOFOLLOW the open would follow the link and the inodes would match.
  await assert.rejects(openLocalFile(link, { home, checkPath: () => ({ real: link, size: 3, dev: st.dev, ino: st.ino }) }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'file_changed');
    return true;
  });
});

test('openLocalFile: a FIFO swapped in does not block the open (O_NONBLOCK) and is refused', { timeout: 5000 }, async () => {
  const { home, upload } = tmpHome();
  const fifo = path.join(upload, 'pipe.mp4');
  try { execFileSync('mkfifo', [fifo]); } catch { return; } // no mkfifo → skip
  const st = fs.statSync(fifo);
  await assert.rejects(openLocalFile(fifo, { home, checkPath: () => ({ real: fifo, size: 0, dev: st.dev, ino: st.ino }) }), (e) => {
    assert.equal(e.code, 'file_not_regular');
    return true;
  });
});

test('openLocalFile: every error after open closes the fd (no leak)', async () => {
  const { home, upload } = tmpHome();
  if (fdCount() === null) return;
  const empty = writeFile(upload, 'empty.bin', '');
  const big = writeFile(upload, 'big.bin', Buffer.alloc(20));
  const before = fdCount();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(openLocalFile(empty, { home }), (e) => e.code === 'file_empty');
    await assert.rejects(openLocalFile(big, { home, maxBytes: 10 }), (e) => e.code === 'file_too_large');
  }
  assert.equal(fdCount(), before);
});

test('openLocalFile: size over the cap → 400 file_too_large; exactly the cap passes', async () => {
  const { home, upload } = tmpHome();
  const f = writeFile(upload, 'big.bin', Buffer.alloc(11));
  await assert.rejects(openLocalFile(f, { home, maxBytes: 10 }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'file_too_large');
    assert.match(e.message, /smaller file|https URL/);
    return true;
  });
  assert.equal((await openOk(f, { home, maxBytes: 11 })).size, 11);
});

// --- one descriptor, exactly [0, size) ------------------------------------------

test('readExact / md5OfHandle: reads exactly size bytes; a shrunk file fails with file_changed', async () => {
  const { upload } = tmpHome();
  const p = writeFile(upload, 'a.bin', Buffer.alloc(100, 7));
  const fh = await fs.promises.open(p);
  try {
    let n = 0;
    for await (const c of readExact(fh, 60)) n += c.length;
    assert.equal(n, 60);
    await assert.rejects(md5OfHandle(fh, 200, 'a.bin'), (e) => e.code === 'file_changed');
  } finally { await fh.close(); }
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function recordingServer(store, status = 200) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {});
    req.on('end', () => {
      store.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks), url: req.url });
      res.writeHead(status); res.end();
    });
  };
}

test('PUT (native fetch): streams bytes with Content-Type/Content-Length, no auth / CF-Access headers', async () => {
  const { home, upload } = tmpHome();
  const data = crypto.randomBytes(2 * 1024 * 1024 + 123);
  writeFile(upload, 'a.mp4', data);
  const f = await openLocalFile(path.join(upload, 'a.mp4'), { home });
  const got = [];
  try {
    await withServer(recordingServer(got), async (base) => {
      const r = await putFileToPresignedUrl(`${base}/bucket/key.mp4?X-Amz-Signature=sig`, f);
      assert.equal(r.status, 200);
    });
  } finally { await f.fh.close(); }
  assert.equal(got[0].method, 'PUT');
  assert.equal(got[0].url, '/bucket/key.mp4?X-Amz-Signature=sig');
  assert.equal(got[0].headers['content-type'], 'video/mp4');
  assert.equal(got[0].headers['content-length'], String(data.length));
  assert.equal(got[0].headers['transfer-encoding'], undefined);
  assert.equal(got[0].headers.authorization, undefined);
  assert.equal(got[0].headers['cf-access-client-id'], undefined);
  assert.ok(got[0].body.equals(data));
});

test('file grows after the check: md5 and PUT cover only the original size bytes', async () => {
  const { home, upload } = tmpHome();
  const data = crypto.randomBytes(50 * 1024);
  const p = writeFile(upload, 'grow.bin', data);
  const f = await openLocalFile(p, { home });
  fs.appendFileSync(p, Buffer.alloc(4096, 1));
  const got = [];
  try {
    await withServer(recordingServer(got), (base) => putFileToPresignedUrl(`${base}/k`, f));
  } finally { await f.fh.close(); }
  assert.equal(f.md5, crypto.createHash('md5').update(data).digest('hex'));
  assert.ok(got[0].body.equals(data), `sent ${got[0].body.length} bytes, expected ${data.length}`);
});

test('file shrinks after the check: PUT fails fast with file_changed (no hang until timeout)', async () => {
  const { home, upload } = tmpHome();
  const p = writeFile(upload, 'shrink.bin', crypto.randomBytes(3 * 1024 * 1024));
  const f = await openLocalFile(p, { home });
  fs.truncateSync(p, 1024);
  const t0 = Date.now();
  try {
    await withServer(recordingServer([]), async (base) => {
      await assert.rejects(putFileToPresignedUrl(`${base}/k?sig=SECRET`, { ...f, timeoutMs: 60000 }), (e) => {
        assert.equal(e.code, 'file_changed');
        assert.ok(!e.message.includes('SECRET'));
        return true;
      });
    });
  } finally { await f.fh.close(); }
  assert.ok(Date.now() - t0 < 5000, 'fails fast');
});

test('PUT: non-2xx → clear error that never contains the presigned URL', async () => {
  const { home, upload } = tmpHome();
  const f = await openLocalFile(writeFile(upload, 'a.bin', 'x'), { home });
  try {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(403); res.end('SignatureDoesNotMatch for http://127.0.0.1/bucket?X-Amz-Signature=SECRET'); });
    }, async (base) => {
      const url = `${base}/bucket/k?X-Amz-Signature=SECRET`;
      await assert.rejects(putFileToPresignedUrl(url, f), (e) => {
        assert.equal(e.code, 'upload_put_failed');
        assert.match(e.message, /HTTP 403/);
        assert.ok(!e.message.includes('SECRET'), e.message);
        assert.ok(!e.message.includes(base), e.message);
        return true;
      });
    });
  } finally { await f.fh.close(); }
});

test('PUT: network error and timeout carry no URL', async () => {
  const { home, upload } = tmpHome();
  const f = await openLocalFile(writeFile(upload, 'a.bin', 'x'), { home });
  try {
    await assert.rejects(putFileToPresignedUrl('http://127.0.0.1:1/k?sig=SECRET', f), (e) => {
      assert.equal(e.code, 'upload_put_failed');
      assert.ok(!e.message.includes('SECRET'));
      return true;
    });
    await withServer((req) => { req.resume(); /* never answers */ }, async (base) => {
      await assert.rejects(putFileToPresignedUrl(`${base}/k?sig=SECRET`, { ...f, timeoutMs: 150 }), (e) => {
        assert.equal(e.code, 'upload_put_timeout');
        assert.ok(!e.message.includes('SECRET'));
        return true;
      });
    });
  } finally { await f.fh.close(); }
});

// --- upload + execute flow with mocked deps -------------------------------------

const SCHEMA = { properties: { videoFilePath: { file_uploadable: true }, title: { type: 'string' } } };

function mockDeps({ slot = () => ({ upload_id: 'fu_1', presigned_url: 'https://r2.test/put?sig=S', expires_at: 't' }), put, execute } = {}) {
  const calls = { slot: [], put: [], execute: [], open: [], closed: 0 };
  let n = 0;
  const deps = {
    getSchema: async () => SCHEMA,
    open: async (p, opts) => {
      calls.open.push([p, opts]);
      return { fh: { close: async () => { calls.closed += 1; } }, size: 5, filename: path.basename(p), md5: '0'.repeat(32), mimetype: 'video/mp4' };
    },
    requestSlot: async (body) => { calls.slot.push(body); n += 1; return slot(body, n); },
    putFile: async (url, opts) => { calls.put.push([url, opts]); if (put) return put(url, opts); return { status: 200 }; },
    execute: async (params) => { calls.execute.push(params); if (execute) return execute(params, calls.execute.length); return { status_code: 200, body: { ok: true } }; },
  };
  return { deps, calls };
}

const rejected = (body = { error: 'composio file materialization failed: upload_id not found or not owned by this connection', code: UPLOAD_ID_INVALID_CODE }) => ({ status_code: 400, body });

test('uploadSlotPath shape', () => {
  assert.equal(uploadSlotPath('c1'), '/connect/connections/c1/files/upload-slot');
});

test('flow success: slot body, PUT from the opened handle, param replaced by {upload_id}, handle closed', async () => {
  const { deps, calls } = mockDeps();
  const params = { videoFilePath: '/tmp/a.mp4', title: 'T' };
  const res = await runProxyExecuteWithUploads({ action: 'YOUTUBE_UPLOAD_VIDEO', params }, deps);
  assert.deepEqual(res, { status_code: 200, body: { ok: true } });
  assert.deepEqual(calls.slot, [{ action: 'YOUTUBE_UPLOAD_VIDEO', filename: 'a.mp4', mimetype: 'video/mp4', size: 5, md5: '0'.repeat(32) }]);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0][0], 'https://r2.test/put?sig=S');
  assert.equal(calls.put[0][1].size, 5);
  assert.ok(calls.put[0][1].fh);
  assert.deepEqual(calls.execute, [{ videoFilePath: { upload_id: 'fu_1' }, title: 'T' }]);
  assert.equal(params.videoFilePath, '/tmp/a.mp4', 'caller params are not mutated');
  assert.equal(calls.closed, 1);
});

test('flow: empty presigned_url (type=existing) skips the PUT', async () => {
  const { deps, calls } = mockDeps({ slot: () => ({ upload_id: 'fu_e', presigned_url: '' }) });
  await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
  assert.equal(calls.put.length, 0);
  assert.deepEqual(calls.execute, [{ videoFilePath: { upload_id: 'fu_e' } }]);
});

test('flow: bare 404 from upload-slot (route missing on an old server) → 400 local_file_upload_unsupported', async () => {
  for (const body of [undefined, null, '404 page not found', { title: 'Not Found', status: 404 }]) {
    const { deps, calls } = mockDeps({ slot: () => { throw Object.assign(new Error('Not Found'), { status: 404, body }); } });
    await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.code, 'local_file_upload_unsupported');
      assert.match(e.message, /https URL/);
      return true;
    });
    assert.equal(calls.execute.length, 0);
    assert.equal(calls.closed, 1);
  }
});

test('flow: 404 WITH a server error code (connection not found) is surfaced as-is, not "unsupported"', async () => {
  for (const body of [
    { error: { title: 'Not Found', status: 404, detail: 'connection not found', code: 'CONNECT_CONNECTION_NOT_FOUND' } },
    { code: 'CONNECT_CONNECTION_NOT_FOUND', error: 'connection not found' },
  ]) {
    const err = Object.assign(new Error('connection not found'), { status: 404, body });
    const { deps } = mockDeps({ slot: () => { throw err; } });
    await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.code, 'CONNECT_CONNECTION_NOT_FOUND');
      assert.match(e.message, /connection not found/);
      return true;
    });
  }
});

test('flow: non-404 upload-slot errors keep their status and gain the server code (503 / 429)', async () => {
  for (const [status, code] of [[503, 'CONNECT_FILE_UPLOAD_SLOT_UNAVAILABLE'], [429, 'CONNECT_FILE_UPLOAD_RATE_LIMITED']]) {
    const err = Object.assign(new Error('try later'), { status, body: { error: { status, detail: 'try later', code } } });
    const { deps, calls } = mockDeps({ slot: () => { throw err; } });
    await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => {
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      return true;
    });
    assert.equal(calls.execute.length, 0);
    assert.equal(calls.closed, 1);
  }
});

test('errorBodyCode: envelope, flat, JSON string, none', () => {
  assert.equal(errorBodyCode({ error: { code: 'A' } }), 'A');
  assert.equal(errorBodyCode({ code: 'B' }), 'B');
  assert.equal(errorBodyCode('{"code":"C"}'), 'C');
  assert.equal(errorBodyCode('not json'), '');
  assert.equal(errorBodyCode(null), '');
  assert.equal(errorBodyCode({ error: 'x' }), '');
});

test('flow: other upload-slot errors propagate unchanged', async () => {
  const err = Object.assign(new Error('rate limited'), { status: 429 });
  const { deps } = mockDeps({ slot: () => { throw err; } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => e === err);
});

test('flow: PUT failure → error, execute never called, handle closed', async () => {
  const { deps, calls } = mockDeps({ put: () => { throw Object.assign(new Error('file upload to storage failed (HTTP 500)'), { status: 502, code: 'upload_put_failed' }); } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => e.code === 'upload_put_failed');
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.closed, 1);
});

test('flow: execute passthrough 400 + CONNECT_FILE_UPLOAD_ID_INVALID → re-upload once and retry with the new id', async () => {
  for (const firstBody of [rejected().body, JSON.stringify(rejected().body)]) {
    const { deps, calls } = mockDeps({
      slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: 'https://r2.test/p' }),
      execute: (_p, n) => (n === 1 ? rejected(firstBody) : { status_code: 200, body: { id: 'v' } }),
    });
    const res = await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
    assert.deepEqual(res, { status_code: 200, body: { id: 'v' } });
    assert.equal(calls.slot.length, 2);
    assert.equal(calls.put.length, 2);
    assert.equal(calls.open.length, 1, 'the file is opened/hashed once');
    assert.deepEqual(calls.execute.map((p) => p.videoFilePath.upload_id), ['fu_1', 'fu_2']);
    assert.equal(calls.closed, 1);
  }
});

test('flow: rejected twice → the second rejection is returned, NO third attempt (retry bounded to one)', async () => {
  const { deps, calls } = mockDeps({
    slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: '' }),
    execute: () => rejected(),
  });
  const res = await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
  assert.deepEqual(res, rejected());
  assert.equal(calls.execute.length, 2);
  assert.equal(calls.slot.length, 2);
});

test('flow: a thrown 400 carrying the code also retries once; a second throw surfaces', async () => {
  const thrown = () => Object.assign(new Error('bad'), { status: 400, body: { code: UPLOAD_ID_INVALID_CODE } });
  const { deps, calls } = mockDeps({ slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: '' }), execute: () => { throw thrown(); } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), /bad/);
  assert.equal(calls.execute.length, 2);
});

test('flow: upload_id wording WITHOUT the code (or another status) is not retried', async () => {
  for (const out of [
    { status_code: 400, body: { error: 'upload_id not found or not owned by this connection' } },
    { status_code: 500, body: { code: UPLOAD_ID_INVALID_CODE } },
    { status_code: 400, body: { code: 'OTHER' } },
  ]) {
    const { deps, calls } = mockDeps({ execute: () => out });
    const res = await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps);
    assert.equal(res, out);
    assert.equal(calls.execute.length, 1);
    assert.equal(calls.slot.length, 1);
  }
  const err = Object.assign(new Error('upload_id expired'), { status: 400 });
  const { deps, calls } = mockDeps({ execute: () => { throw err; } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: '/tmp/a.mp4' } }, deps), (e) => e === err);
  assert.equal(calls.execute.length, 1);
});

test('isUploadIdRejected: code-only', () => {
  assert.equal(isUploadIdRejected({ result: rejected() }), true);
  assert.equal(isUploadIdRejected({ result: { status_code: 400, body: JSON.stringify({ code: UPLOAD_ID_INVALID_CODE }) } }), true);
  assert.equal(isUploadIdRejected({ result: { status_code: 400, body: 'upload_id not found' } }), false);
  assert.equal(isUploadIdRejected({ error: Object.assign(new Error('x'), { status: 400, body: { error: { code: UPLOAD_ID_INVALID_CODE } } }) }), true);
  assert.equal(isUploadIdRejected({ error: Object.assign(new Error('upload_id expired'), { status: 400 }) }), false);
  assert.equal(isUploadIdRejected({}), false);
});

test('passthrough: URL / data URI / base64 / relative name / objects execute unchanged, no upload calls', async () => {
  for (const v of ['https://cdn.test/a.mp4', 'data:video/mp4;base64,AAAA', 'AAAAIGZ0eXA=', 'a.mp4',
    { name: 'a.txt', mimetype: 'text/plain', content_base64: 'aGk=' }, { upload_id: 'fu_x' }]) {
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

test('no preprocessing: no path-looking string → schema never fetched', async () => {
  const { deps, calls } = mockDeps();
  let fetched = 0;
  deps.getSchema = async () => { fetched += 1; return SCHEMA; };
  await runProxyExecuteWithUploads({ action: 'A', params: { videoFilePath: 'https://x', title: 'hello', n: 3 } }, deps);
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

test('prepareFileParams: every file is opened before any upload (bad 2nd path → no slot requested)', async () => {
  const { deps, calls } = mockDeps();
  deps.open = async (p, { paramName }) => {
    if (p === '/missing') throw Object.assign(new Error(`file param "${paramName}": file not found: missing`), { status: 400, code: 'file_not_found' });
    return { fh: { close: async () => {} }, size: 1, filename: 'a', md5: 'm', mimetype: 'x' };
  };
  const schema = { properties: { files: { items: { file_uploadable: true } } } };
  await assert.rejects(prepareFileParams({ inputSchema: schema, params: { files: ['/ok', '/missing'] }, action: 'A' }, { ...deps, opened: new Map() }), (e) => {
    assert.equal(e.code, 'file_not_found');
    assert.match(e.message, /files\[1\]/);
    return true;
  });
  assert.equal(calls.slot.length, 0);
});

test('runProxyExecuteWithUploads: a failing 2nd open still closes the 1st handle', async () => {
  const { deps } = mockDeps();
  let closed = 0;
  deps.open = async (p) => {
    if (p === '/bad') throw Object.assign(new Error('nope'), { status: 400 });
    return { fh: { close: async () => { closed += 1; } }, size: 1, filename: 'a', md5: 'm', mimetype: 'x' };
  };
  deps.getSchema = async () => ({ properties: { files: { items: { file_uploadable: true } } } });
  await assert.rejects(runProxyExecuteWithUploads({ action: 'A', params: { files: ['/ok', '/bad'] } }, deps), /nope/);
  assert.equal(closed, 1);
});

test('prepareFileParams: several file params (nested + array) all replaced', async () => {
  const { deps } = mockDeps({ slot: (_b, n) => ({ upload_id: `fu_${n}`, presigned_url: '' }) });
  const schema = { properties: { a: { file_uploadable: true }, m: { properties: { list: { items: { file_uploadable: true } } } } } };
  const r = await prepareFileParams({ inputSchema: schema, params: { a: '/1', m: { list: ['/2', 'https://3'] } }, action: 'A' }, { ...deps, opened: new Map() });
  assert.deepEqual(r.params, { a: { upload_id: 'fu_1' }, m: { list: [{ upload_id: 'fu_2' }, 'https://3'] } });
  assert.deepEqual(r.uploads.map((u) => u.param), ['a', 'm.list[0]']);
});
