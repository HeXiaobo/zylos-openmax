import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveOneFile, resolveFiles, checkLocalPath, detectMime, mimeAccepted, MAX_FILE_BYTES, MAX_STREAM_FILE_BYTES } from './files.js';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-files-'));
  const comp = path.join(home, 'zylos/components/openmax');
  for (const d of ['media', 'upload', 'runtime/connect']) fs.mkdirSync(path.join(comp, d), { recursive: true });
  fs.mkdirSync(path.join(home, 'zylos/workspace'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(comp, 'config.json'), '{"secret":1}');
  fs.writeFileSync(path.join(comp, 'runtime/connect/cred.json'), '{"access_token":"x"}');
  fs.writeFileSync(path.join(home, 'zylos/.env'), 'KEY=1');
  fs.writeFileSync(path.join(home, '.ssh/id_rsa'), 'k');
  fs.writeFileSync(path.join(home, 'zylos/workspace/notes.txt'), 'n');
  fs.writeFileSync(path.join(comp, 'upload/report.pdf'), '%PDF-1.4 x');
  fs.writeFileSync(path.join(comp, 'media/photo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
  return { home, comp, deps: { home, componentDir: comp } };
}

test('paths inside media/ and upload/ resolve (also via ~)', async () => {
  const { comp, deps } = sandbox();
  const f = await resolveOneFile('f', { source: 'path', path: path.join(comp, 'upload/report.pdf') }, {}, deps);
  assert.equal(f.filename, 'report.pdf');
  assert.equal(f.mime_type, 'application/pdf');
  assert.equal(f.size, 10);
  assert.equal(f.bytes.toString(), '%PDF-1.4 x');
  const g = await resolveOneFile('f', '~/zylos/components/openmax/media/photo.bin', {}, deps);
  assert.equal(g.mime_type, 'image/png', 'magic sniff');
});

test('paths outside the component dirs are refused (workspace, home, /etc)', async () => {
  const { home, deps } = sandbox();
  for (const p of [path.join(home, 'zylos/workspace/notes.txt'), '/etc/hostname', path.join(home, 'zylos/.env')]) {
    await assert.rejects(resolveOneFile('f', p, {}, deps), (e) => e.status === 403 || e.status === 400, p);
  }
});

test('runtime/ and config.json are refused even when linked into upload/', async () => {
  const { comp, deps } = sandbox();
  fs.symlinkSync(path.join(comp, 'runtime'), path.join(comp, 'upload/rt'));
  fs.symlinkSync(path.join(comp, 'config.json'), path.join(comp, 'upload/cfg'));
  await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/rt/connect/cred.json'), {}, deps), { status: 403 });
  await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/cfg'), {}, deps), { status: 403 });
  await assert.rejects(resolveOneFile('f', path.join(comp, 'runtime/connect/cred.json'), {}, deps), { status: 403 });
  await assert.rejects(resolveOneFile('f', path.join(comp, 'config.json'), {}, deps), { status: 403 });
});

test('symlink escape out of upload/ is refused (realpath before prefix check)', async () => {
  const { home, comp, deps } = sandbox();
  fs.symlinkSync(path.join(home, 'zylos/workspace/notes.txt'), path.join(comp, 'upload/innocent.txt'));
  fs.symlinkSync(path.join(home, '.ssh'), path.join(comp, 'upload/keys'));
  await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/innocent.txt'), {}, deps), { status: 403 });
  await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/keys/id_rsa'), {}, deps), { status: 403 });
});

test('.. traversal, dotfiles, .env*, *.pem, *.key, id_* are refused', async () => {
  const { comp, deps } = sandbox();
  for (const n of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_ed25519', '.hidden']) fs.writeFileSync(path.join(comp, 'upload', n), 'x');
  for (const n of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_ed25519', '.hidden']) {
    await assert.rejects(resolveOneFile('f', path.join(comp, 'upload', n), {}, deps), { status: 403 }, n);
  }
  await assert.rejects(resolveOneFile('f', `${comp}/upload/../config.json`, {}, deps), { status: 403 });
  await assert.rejects(resolveOneFile('f', 'upload/report.pdf', {}, deps), { status: 400 }, 'relative path');
});

test('directories and FIFOs are not regular files', async () => {
  const { comp, deps } = sandbox();
  fs.mkdirSync(path.join(comp, 'upload/sub'));
  await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/sub'), {}, deps), { status: 400 });
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(comp, 'upload/pipe')]);
    await assert.rejects(resolveOneFile('f', path.join(comp, 'upload/pipe'), {}, deps), { status: 400 });
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
});

test('URL sources are refused with a hint', async () => {
  const { deps } = sandbox();
  await assert.rejects(resolveOneFile('f', 'https://example.com/a.pdf', {}, deps), (e) => e.status === 400 && /upload/.test(e.message));
  await assert.rejects(resolveOneFile('f', 'http://example.com/a.pdf', {}, deps), { status: 400 });
});

test('size caps: 25 MiB in memory, 1 GiB streamed, spec max_bytes only stricter', async () => {
  const { comp, deps } = sandbox();
  const big = path.join(comp, 'upload/big.bin');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_FILE_BYTES + 1);
  await assert.rejects(resolveOneFile('f', big, {}, deps), { status: 413 });
  await assert.rejects(resolveOneFile('f', big, { max_bytes: MAX_FILE_BYTES * 4 }, deps), { status: 413 }, 'spec cannot raise the cap');
  const s = await resolveOneFile('f', big, { stream: true }, deps);
  assert.equal(s.size, MAX_FILE_BYTES + 1);
  assert.equal(s.bytes, undefined, 'streamed files are not read into memory');
  assert.equal(s.readRange(0, 3).length, 4);
  fs.truncateSync(big, MAX_STREAM_FILE_BYTES + 1);
  await assert.rejects(resolveOneFile('f', big, { stream: true }, deps), { status: 413 });
  await assert.rejects(resolveOneFile('f', { source: 'text', text: 'abcdef' }, { max_bytes: 5 }, deps), { status: 413 });
  await assert.rejects(resolveOneFile('f', { source: 'base64', data: Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64') }, {}, deps), { status: 413 });
});

test('base64 / text sources, MIME precedence and accept', async () => {
  const deps = {};
  const a = await resolveOneFile('f', { source: 'base64', data: Buffer.from('%PDF-1').toString('base64url'), filename: 'x' }, {}, deps);
  assert.equal(a.mime_type, 'application/pdf');
  const b = await resolveOneFile('f', { source: 'text', text: '# T', filename: 'n.md' }, {}, deps);
  assert.equal(b.mime_type, 'text/markdown');
  const c = await resolveOneFile('f', { source: 'text', text: 'x', filename: 'n.md', mime_type: 'text/x-custom' }, {}, deps);
  assert.equal(c.mime_type, 'text/x-custom');
  const d = await resolveOneFile('f', { source: 'base64', data: Buffer.from([0, 1, 2, 0xff]).toString('base64') }, {}, deps);
  assert.equal(d.mime_type, 'application/octet-stream');
  await assert.rejects(resolveOneFile('f', { source: 'text', text: 'x', filename: 'a.txt' }, { accept: ['image/*'] }, deps), { status: 400 });
  assert.ok(mimeAccepted('image/png', ['image/*']));
  assert.ok(mimeAccepted('text/plain; charset=utf-8', ['text/plain']));
  assert.ok(!mimeAccepted('text/plain', ['application/pdf']));
  assert.equal(detectMime({ head: Buffer.from('GIF89a') }), 'image/gif');
  assert.equal(detectMime({ head: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }), 'image/jpeg');
  assert.equal(detectMime({ head: Buffer.from('PK\x03\x04') }), 'application/zip');
  assert.equal(detectMime({ head: Buffer.from('héllo') }), 'text/plain');
  await assert.rejects(resolveOneFile('f', { source: 'text', text: 'x' }, { sources: ['path'] }, deps), { status: 400 });
  await assert.rejects(resolveOneFile('f', { source: 'text', text: 'x', filename: 'a\r\nb' }, {}, deps), { status: 400 });
  await assert.rejects(resolveOneFile('f', { source: 'url', url: 'x' }, {}, deps), { status: 400 });
});

test('artifact source: only the resolved URL is fetched, with a streaming cap', async () => {
  const calls = [];
  const deps = {
    resolveArtifact: async (uri) => { calls.push(uri); return { url: 'https://store.example/presigned?sig=1', name: 'doc.pdf', contentType: 'application/pdf' }; },
    fetchImpl: async (url, opts) => { calls.push(url); assert.equal(opts.redirect, 'manual'); return { status: 200, body: new Blob([Buffer.from('%PDF-1.7')]).stream() }; },
  };
  const f = await resolveOneFile('f', 'artifact://abc-123', {}, deps);
  assert.deepEqual(calls, ['artifact://abc-123', 'https://store.example/presigned?sig=1']);
  assert.equal(f.filename, 'doc.pdf');
  assert.equal(f.mime_type, 'application/pdf');
  const big = { ...deps, fetchImpl: async () => ({ status: 200, body: new Blob([Buffer.alloc(10)]).stream() }) };
  await assert.rejects(resolveOneFile('f', 'artifact://abc', { max_bytes: 5 }, big), { status: 413 });
  await assert.rejects(resolveOneFile('f', { source: 'artifact', artifact: 'https://x' }, {}, deps), { status: 400 });
  const http = { ...deps, resolveArtifact: async () => ({ url: 'http://plain/x' }) };
  await assert.rejects(resolveOneFile('f', 'artifact://abc', {}, http), { status: 502 });
});

test('multiple files: arrays, single value promoted, total cap', async () => {
  const spec = { att: { multiple: true, max_total_bytes: 5 } };
  const r = await resolveFiles(spec, { att: { source: 'text', text: 'ab', filename: 'a.txt' } }, {});
  assert.equal(r.files.att.length, 1);
  await assert.rejects(resolveFiles(spec, { att: [{ source: 'text', text: 'abc' }, { source: 'text', text: 'abc' }] }, {}), { status: 413 });
  await assert.rejects(resolveFiles({ one: {} }, { one: [{ source: 'text', text: 'a' }] }, {}), { status: 400 });
  const none = await resolveFiles(spec, {}, {});
  assert.deepEqual(none.files, {});
});

test('checkLocalPath never accepts a path when the component dirs do not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-empty-'));
  fs.writeFileSync(path.join(home, 'x.txt'), 'x');
  assert.throws(() => checkLocalPath(path.join(home, 'x.txt'), { home }), { status: 403 });
});

test('defence in depth: even if media/ itself is a symlink into runtime/, credentials stay unreadable', async () => {
  const { comp, deps } = sandbox();
  fs.rmSync(path.join(comp, 'media'), { recursive: true });
  fs.symlinkSync(path.join(comp, 'runtime'), path.join(comp, 'media'));
  await assert.rejects(resolveOneFile('f', path.join(comp, 'media/connect/cred.json'), {}, deps), { status: 403 });
  fs.rmSync(path.join(comp, 'media'));
  fs.symlinkSync(comp, path.join(comp, 'media'));
  await assert.rejects(resolveOneFile('f', path.join(comp, 'media/config.json'), {}, deps), { status: 403 });
});
