import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runResumableUpload, nextOffsetFromProgress } from './resumable.js';

const UPLOAD = {
  session_url_from: 'header:Location', chunk_method: 'PUT', chunk_bytes: 4, chunk_multiple: 2,
  range_style: 'content_range', incomplete_status: 308, progress_header: 'Range',
  status_probe: 'content_range_star', final_status: [200, 201], max_restarts: 1,
};
const INIT = { method: 'POST', url: 'https://up.example.com/upload/files?uploadType=resumable', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: '{"name":"a"}' };
const fileOf = (s) => { const b = Buffer.from(s); return { size: b.length, readRange: (a, e) => b.subarray(a, e + 1) }; };

function harness(script) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: { ...opts.headers }, body: opts.body ? Buffer.from(opts.body).toString() : undefined, redirect: opts.redirect });
    const r = queue.shift();
    if (!r) throw new Error('unexpected call');
    if (r.throw) throw new Error('ECONNRESET');
    return { status: r.status, headers: new Map(Object.entries(r.headers || {})), body: null, text: async () => r.body || '' };
  };
  let token = 't1';
  const deps = {
    fetchImpl,
    normalize: async (res) => ({ status_code: res.status, body: await res.text() }),
    authorize: (url, h) => { h.Authorization = `Bearer ${token}`; return url; },
    refresh: async () => { token = 't2'; return true; },
    sleep: async () => {},
    audit: () => {},
  };
  return { calls, deps };
}

test('progress header parsing', () => {
  assert.equal(nextOffsetFromProgress('bytes=0-3'), 4);
  assert.equal(nextOffsetFromProgress(''), 0);
});

test('308 progression: init → chunks with Content-Range → final', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/upload/files?upload_id=S1' } },
    { status: 308, headers: { Range: 'bytes=0-3' } },
    { status: 308, headers: { Range: 'bytes=0-7' } },
    { status: 201, body: '{"id":"F"}' },
  ]);
  const res = await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abcdefghij') }, deps);
  assert.deepEqual(res, { status_code: 201, body: '{"id":"F"}' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"name":"a"}');
  assert.equal(calls[0].headers.Authorization, 'Bearer t1');
  assert.deepEqual(calls.slice(1).map((c) => [c.method, c.headers['Content-Range'], c.body]), [
    ['PUT', 'bytes 0-3/10', 'abcd'], ['PUT', 'bytes 4-7/10', 'efgh'], ['PUT', 'bytes 8-9/10', 'ij'],
  ]);
  assert.ok(calls.every((c) => c.redirect === 'manual'));
  assert.ok(calls.slice(1).every((c) => c.url === 'https://up.example.com/upload/files?upload_id=S1'));
});

test('partial acceptance resumes from the server-reported offset', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s' } },
    { status: 308, headers: { Range: 'bytes=0-1' } },
    { status: 200, body: 'ok' },
  ]);
  await runResumableUpload({ upload: { ...UPLOAD, chunk_bytes: 8 }, init: INIT, file: fileOf('abcdef') }, deps);
  assert.equal(calls[2].headers['Content-Range'], 'bytes 2-5/6');
});

test('a session URL on another origin is refused before any bytes are sent', async () => {
  const { calls, deps } = harness([{ status: 200, headers: { Location: 'https://evil.example.net/s' } }]);
  await assert.rejects(runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abc') }, deps), { status: 502 });
  assert.equal(calls.length, 1);
});

test('init failure is returned as-is; missing session header is a 502', async () => {
  const a = harness([{ status: 403, body: 'denied' }]);
  assert.deepEqual(await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('a') }, a.deps), { status_code: 403, body: 'denied' });
  const b = harness([{ status: 200 }]);
  await assert.rejects(runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('a') }, b.deps), { status: 502 });
});

test('5xx → backoff → status probe (bytes */total) → continue from reported offset', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s' } },
    { status: 503 },
    { status: 308, headers: { Range: 'bytes=0-3' } },
    { status: 200, body: 'done' },
  ]);
  const res = await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abcdefgh') }, deps);
  assert.equal(res.status_code, 200);
  assert.equal(calls[2].headers['Content-Range'], 'bytes */8');
  assert.equal(calls[2].body, undefined);
  assert.equal(calls[3].headers['Content-Range'], 'bytes 4-7/8');
});

test('network error → retry the chunk (probe first)', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s' } },
    { throw: true },
    { status: 308 },
    { status: 200, body: 'done' },
  ]);
  await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abcd') }, deps);
  assert.equal(calls[2].headers['Content-Range'], 'bytes */4');
  assert.equal(calls[3].headers['Content-Range'], 'bytes 0-3/4');
});

test('404 / 410 restarts the session up to max_restarts', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s1' } },
    { status: 404 },
    { status: 200, headers: { Location: 'https://up.example.com/s2' } },
    { status: 201, body: 'ok' },
  ]);
  const res = await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abc') }, deps);
  assert.equal(res.status_code, 201);
  assert.equal(calls[3].url, 'https://up.example.com/s2');
  assert.equal(calls[3].headers['Content-Range'], 'bytes 0-2/3');
  const b = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s1' } },
    { status: 410, body: 'gone' },
    { status: 200, headers: { Location: 'https://up.example.com/s2' } },
    { status: 410, body: 'gone again' },
  ]);
  const r2 = await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('abc') }, b.deps);
  assert.deepEqual(r2, { status_code: 410, body: 'gone again' });
});

test('401 on a chunk refreshes the token and resends the same chunk (session kept)', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s' } },
    { status: 401 },
    { status: 200, body: 'ok' },
  ]);
  await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('ab') }, deps);
  assert.equal(calls[1].headers.Authorization, 'Bearer t1');
  assert.equal(calls[2].headers.Authorization, 'Bearer t2');
  assert.equal(calls[2].headers['Content-Range'], 'bytes 0-1/2');
  assert.equal(calls[2].url, 'https://up.example.com/s');
});

test('empty file sends bytes */0', async () => {
  const { calls, deps } = harness([
    { status: 200, headers: { Location: 'https://up.example.com/s' } },
    { status: 200, body: 'ok' },
  ]);
  await runResumableUpload({ upload: UPLOAD, init: INIT, file: fileOf('') }, deps);
  assert.equal(calls[1].headers['Content-Range'], 'bytes */0');
});
