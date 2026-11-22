// End-to-end tests of request_spec actions through invokeDirect (mock fetch).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { invokeDirect } from './direct-exec.js';
import * as S from './request-spec/testdata/specs.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const def = (name, method, url, extra = {}) => {
  const [toolkit, action] = name.split('/');
  return { toolkit, action, method, url_template: url, input_schema: '', ...extra };
};
const MESSAGES_GET = def('gmail/messages-get', 'GET', `${GMAIL}/messages/{id}?format={format}`, { input_schema: '{"type":"object","properties":{},"additionalProperties":false}' });
const CATALOG = [
  MESSAGES_GET,
  def('gmail/messages-compose-send', 'POST', `${GMAIL}/messages/send`, { request_spec: S.COMPOSE_SEND }),
  def('gmail/drafts-compose-create', 'POST', `${GMAIL}/drafts`, { request_spec: S.DRAFT_CREATE }),
  def('gmail/threads-compose-reply', 'POST', `${GMAIL}/messages/send`, { request_spec: S.REPLY }),
  def('gmail/messages-compose-forward', 'POST', `${GMAIL}/messages/send`, { request_spec: JSON.stringify(S.FORWARD) }),
  def('docs/documents-insert-text', 'POST', 'https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate', { request_spec: S.DOCS_INSERT }),
  def('drive/files-upload', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields={fields}', { request_spec: S.DRIVE_UPLOAD }),
  def('drive/files-update-content', 'PATCH', 'https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media', { request_spec: S.DRIVE_UPDATE_CONTENT }),
  def('drive/files-upload-resumable', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', { request_spec: S.DRIVE_RESUMABLE }),
  def('calendar/events-insert', 'POST', 'https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events?sendUpdates={send_updates}', { input_schema: '{"type":"object","properties":{"summary":{"type":"string"}}}' }),
  def('calendar/events-patch', 'PATCH', 'https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}', { input_schema: '{"type":"object","properties":{"summary":{"type":"string"}}}' }),
  def('calendar/events-delete', 'DELETE', 'https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}', { input_schema: '{"type":"object","properties":{},"additionalProperties":false}' }),
  def('tasks/items-insert', 'POST', 'https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks'),
  def('calendar/events-batch', 'POST', 'https://www.googleapis.com/batch/calendar/v3', { request_spec: S.CALENDAR_BATCH }),
  def('x/needs-future', 'POST', 'https://api.example.com/x', { request_spec: { version: 1, requires: ['body_template', 'teleport'], body: {} } }),
];
const CRED = { access_token: 'tok-1', token_type: 'bearer', credential_mode: 'direct' };
const DATE = new Date(Date.UTC(2026, 9, 22, 8, 0, 0));

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, opts = {}) => {
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
    calls.push({ url, method: opts.method, headers: { ...(opts.headers || {}) }, body });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const text = r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? {});
    const bytes = Buffer.from(text);
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => text,
    };
  };
  return { calls, impl };
}

function run(action, params, fetchImpl, extraDeps = {}) {
  let n = 0;
  return invokeDirect(
    { orgId: 'o', connection: { id: 'c1' }, actionSlug: action, params, catalog: CATALOG, credential: CRED },
    { fetchImpl, audit: () => {}, rfc822Options: { date: DATE, boundary: () => `B${n++}` }, boundary: () => 'BOUNDARY', ...extraDeps },
  );
}

const rawOf = (call) => Buffer.from(JSON.parse(call.body.toString()).raw, 'base64url').toString();

test('compose-send: flat fields → RFC 2822 → base64url raw, JSON body, auth injected', async () => {
  const f = fakeFetch([{ body: { id: 'M1' } }]);
  const res = await run('gmail/messages-compose-send', {
    to: ['me@example.com'], subject: '[cws-verify] hi', text: 'hello',
    attachments: [{ source: 'base64', data: Buffer.from('%PDF-1.4').toString('base64'), filename: 'a.pdf' }],
  }, f.impl);
  assert.equal(res.status_code, 200);
  const c = f.calls[0];
  assert.equal(c.url, `${GMAIL}/messages/send`);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, 'Bearer tok-1');
  assert.equal(c.headers['Content-Type'], 'application/json');
  const body = JSON.parse(c.body.toString());
  assert.deepEqual(Object.keys(body), ['raw'], 'threadId dropped when not given; leftover params never leak into the body');
  assert.ok(!/[+/=]/.test(body.raw));
  const raw = rawOf(c);
  assert.match(raw, /^MIME-Version: 1\.0\r\nDate: Thu, 22 Oct 2026 08:00:00 \+0000\r\nTo: me@example\.com\r\nSubject: \[cws-verify\] hi\r\nContent-Type: multipart\/mixed;/);
  assert.ok(raw.includes('Content-Type: application/pdf;\r\n name="a.pdf"'));
  assert.ok(raw.includes(Buffer.from('%PDF-1.4').toString('base64')));
});

test('compose-send: an explicit raw wins ($first) and thread_id maps to threadId', async () => {
  const f = fakeFetch([{ body: {} }]);
  await run('gmail/messages-compose-send', { raw: 'UkFX', thread_id: 'T9' }, f.impl);
  assert.deepEqual(JSON.parse(f.calls[0].body.toString()), { raw: 'UkFX', threadId: 'T9' });
});

test('drafts-compose-create nests the message', async () => {
  const f = fakeFetch([{ body: { id: 'D1' } }]);
  await run('gmail/drafts-compose-create', { to: 'me@example.com', subject: 's', html: '<b>x</b>' }, f.impl);
  const body = JSON.parse(f.calls[0].body.toString());
  assert.match(Buffer.from(body.message.raw, 'base64url').toString(), /Content-Type: text\/html; charset="UTF-8"/);
  assert.equal(body.message.threadId, undefined);
});

const ORIG = {
  id: 'M0', threadId: 'T0',
  payload: { headers: [
    { name: 'From', value: 'Alice <alice@example.com>' },
    { name: 'Subject', value: 'Quarterly plan' },
    { name: 'Message-ID', value: '<orig@mail.example.com>' },
    { name: 'References', value: '<root@mail.example.com>' },
  ] },
};

test('threads-compose-reply: prefetch (GET, same auth) → In-Reply-To / References / Re: / threadId', async () => {
  const f = fakeFetch([{ body: ORIG }, { body: { id: 'M2' } }]);
  const res = await run('gmail/threads-compose-reply', { message_id: 'M0', text: 'Sounds good' }, f.impl);
  assert.equal(res.status_code, 200);
  const [g, s] = f.calls;
  assert.equal(g.method, 'GET');
  assert.equal(g.url, `${GMAIL}/messages/M0?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To`);
  assert.equal(g.headers.Authorization, 'Bearer tok-1');
  assert.equal(g.body, undefined);
  const raw = rawOf(s);
  assert.ok(raw.includes('\r\nTo: Alice <alice@example.com>\r\n'), 'falls back to From when no Reply-To');
  assert.ok(raw.includes('\r\nSubject: Re: Quarterly plan\r\n'));
  assert.ok(raw.includes('\r\nIn-Reply-To: <orig@mail.example.com>\r\n'));
  assert.ok(raw.includes('\r\nReferences: <root@mail.example.com> <orig@mail.example.com>\r\n'));
  assert.equal(JSON.parse(s.body.toString()).threadId, 'T0');
});

test('reply: Reply-To wins over From; explicit to wins over both; Re: not doubled', async () => {
  const orig = JSON.parse(JSON.stringify(ORIG));
  orig.payload.headers.push({ name: 'Reply-To', value: 'team@example.com' });
  orig.payload.headers[1].value = 'RE: Quarterly plan';
  const f = fakeFetch([{ body: orig }, { body: {} }]);
  await run('gmail/threads-compose-reply', { message_id: 'M0', text: 'x' }, f.impl);
  const raw = rawOf(f.calls[1]);
  assert.ok(raw.includes('\r\nTo: team@example.com\r\n'));
  assert.ok(raw.includes('\r\nSubject: RE: Quarterly plan\r\n'));
  const g = fakeFetch([{ body: orig }, { body: {} }]);
  await run('gmail/threads-compose-reply', { message_id: 'M0', text: 'x', to: 'bob@example.com' }, g.impl);
  assert.ok(rawOf(g.calls[1]).includes('\r\nTo: bob@example.com\r\n'));
});

test('a failing prefetch aborts and returns that response with failed_step', async () => {
  const f = fakeFetch([{ status: 404, body: { error: { code: 404 } } }]);
  const res = await run('gmail/threads-compose-reply', { message_id: 'nope', text: 'x' }, f.impl);
  assert.equal(res.status_code, 404);
  assert.equal(res.failed_step, 'prefetch:orig');
  assert.equal(f.calls.length, 1, 'nothing is sent after a failed prefetch');
});

test('messages-compose-forward: original attached as message/rfc822 forwarded.eml + caller attachments', async () => {
  const original = 'From: alice@example.com\r\nSubject: Quarterly plan\r\n\r\nbody text';
  const f = fakeFetch([{ body: ORIG }, { body: { raw: Buffer.from(original).toString('base64url') } }, { body: {} }]);
  await run('gmail/messages-compose-forward', {
    message_id: 'M0', to: 'me@example.com', text: 'FYI',
    attachments: { source: 'text', text: 'note', filename: 'n.txt' },
  }, f.impl);
  assert.equal(f.calls[0].url, `${GMAIL}/messages/M0?format=metadata&metadataHeaders=Subject`);
  assert.equal(f.calls[1].url, `${GMAIL}/messages/M0?format=raw`);
  const raw = rawOf(f.calls[2]);
  assert.ok(raw.includes('\r\nSubject: Fwd: Quarterly plan\r\n'));
  assert.ok(raw.includes('Content-Type: message/rfc822;\r\n name="forwarded.eml"'));
  const b64 = Buffer.from(original).toString('base64');
  assert.ok(raw.includes(`${b64.slice(0, 76)}\r\n${b64.slice(76)}`), 'original bytes, base64 at 76 columns');
  assert.ok(raw.indexOf('forwarded.eml') < raw.indexOf('n.txt'), 'original first, then caller attachments');
  assert.equal(JSON.parse(f.calls[2].body.toString()).threadId, undefined);
});

test('docs/documents-insert-text: integer index kept; no index → endOfSegmentLocation', async () => {
  const f = fakeFetch([{ body: {} }]);
  await run('docs/documents-insert-text', { document_id: 'D1', text: 'Hi', index: 1 }, f.impl);
  assert.equal(f.calls[0].url, 'https://docs.googleapis.com/v1/documents/D1:batchUpdate');
  assert.equal(f.calls[0].body.toString(), '{"requests":[{"insertText":{"text":"Hi","location":{"index":1}}}]}');
  await run('docs/documents-insert-text', { document_id: 'D1', text: 'Hi' }, f.impl);
  assert.equal(f.calls[1].body.toString(), '{"requests":[{"insertText":{"text":"Hi","endOfSegmentLocation":{}}}]}');
});

test('unmapped params are refused (default) before any network call', async () => {
  const f = fakeFetch([{ body: {} }]);
  await assert.rejects(run('docs/documents-insert-text', { document_id: 'D1', text: 'x', bogus: 1 }, f.impl), (e) => e.status === 400 && /bogus/.test(e.message));
  assert.equal(f.calls.length, 0);
});

test('unmapped_params: "ignore" drops them silently', async () => {
  const cat = CATALOG.map((a) => (a.action === 'documents-insert-text' ? { ...a, request_spec: { ...S.DOCS_INSERT, unmapped_params: 'ignore' } } : a));
  const f = fakeFetch([{ body: {} }]);
  await invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'docs/documents-insert-text', params: { document_id: 'D', text: 'x', bogus: 1 }, catalog: cat, credential: CRED }, { fetchImpl: f.impl, audit: () => {} });
  assert.ok(!f.calls[0].body.toString().includes('bogus'));
});

test('unknown capability → 426 upgrade error, no request sent', async () => {
  const f = fakeFetch([{ body: {} }]);
  await assert.rejects(run('x/needs-future', {}, f.impl), (e) => e.status === 426 && e.message === 'action requires plugin capabilities [teleport]; upgrade the openmax plugin');
  assert.equal(f.calls.length, 0);
});

test('_download on a request_spec action → 400', async () => {
  const f = fakeFetch([{ body: {} }]);
  await assert.rejects(run('gmail/messages-compose-send', { _download: { url: `${GMAIL}/x` } }, f.impl), { status: 400 });
  assert.equal(f.calls.length, 0);
});

test('a provider 401 refreshes once and resends the same bytes', async () => {
  const f = fakeFetch([{ status: 401, body: {} }, { body: { ok: 1 } }]);
  const res = await run('docs/documents-insert-text', { document_id: 'D1', text: 'x' }, f.impl, {
    acquire: async () => ({ ...CRED, access_token: 'tok-2' }),
  });
  assert.equal(res.status_code, 200);
  assert.equal(f.calls[1].headers.Authorization, 'Bearer tok-2');
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
});

test('audit line carries only key/type/size summaries — never values', async () => {
  const lines = [];
  const f = fakeFetch([{ body: {} }]);
  await run('gmail/messages-compose-send', { to: 'me@example.com', subject: 'TOP-SECRET-SUBJECT', text: 'TOP-SECRET-BODY', attachments: [{ source: 'text', text: 'TOP-SECRET-FILE', filename: 'n.txt' }] }, f.impl, { audit: (l) => lines.push(l) });
  const all = lines.join('\n');
  assert.ok(!/TOP-SECRET|me@example\.com/.test(all), all);
  assert.match(all, /subject:<string 18B>/);
  assert.match(all, /attachments:<1 file 15B>/);
  assert.match(all, /origin=https:\/\/gmail\.googleapis\.com/);
  assert.match(all, /files: n\.txt\(15B\)/);
});

test('drive/files-upload: multipart/related metadata + file part', async () => {
  const f = fakeFetch([{ body: { id: 'F1' } }]);
  await run('drive/files-upload', { file: { source: 'text', text: 'hello', filename: 'a.txt' }, parents: ['P1'], fields: 'id,name' }, f.impl);
  const c = f.calls[0];
  assert.equal(c.url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2Cname');
  assert.equal(c.headers['Content-Type'], 'multipart/related; boundary=BOUNDARY');
  assert.equal(c.body.toString(), '--BOUNDARY\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.txt","parents":["P1"]}\r\n--BOUNDARY\r\nContent-Type: text/plain\r\n\r\nhello\r\n--BOUNDARY--\r\n');
});

test('drive/files-update-content: media body = raw file bytes with its mime type', async () => {
  const f = fakeFetch([{ body: { id: 'F1' } }]);
  await run('drive/files-update-content', { file_id: 'F1', file: { source: 'base64', data: Buffer.from('%PDF-1.7').toString('base64'), filename: 'x.pdf' } }, f.impl);
  assert.equal(f.calls[0].method, 'PATCH');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/pdf');
  assert.equal(f.calls[0].body.toString(), '%PDF-1.7');
});

test('drive/files-upload-resumable: init metadata + X-Upload headers, then chunked PUT', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-rs-'));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(comp, 'upload'), { recursive: true });
  const fp = path.join(comp, 'upload/big.txt');
  fs.writeFileSync(fp, 'x'.repeat(1000));
  const f = fakeFetch([
    { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ' }, raw: '' },
    { status: 200, body: { id: 'F9' } },
  ]);
  const res = await run('drive/files-upload-resumable', { file: fp, name: 'Big' }, f.impl, { home, componentDir: comp });
  assert.equal(res.status_code, 200);
  const [init, put] = f.calls;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok-1');
  assert.equal(init.headers['X-Upload-Content-Type'], 'text/plain');
  assert.equal(init.headers['X-Upload-Content-Length'], '1000');
  assert.equal(init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(init.body.toString(), '{"name":"Big"}');
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['Content-Range'], 'bytes 0-999/1000');
  assert.equal(put.headers.Authorization, 'Bearer tok-1');
  assert.equal(put.body.length, 1000);
});

const BATCH_RESPONSE = [
  '--batch_R', 'Content-Type: application/http', 'Content-ID: <response-item-0>', '',
  'HTTP/1.1 200 OK', 'Content-Type: application/json', '', '{"id":"E1"}',
  '--batch_R', 'Content-Type: application/http', 'Content-ID: <response-item-1>', '',
  'HTTP/1.1 204 No Content', '', '',
  '--batch_R--', '',
].join('\r\n');

test('calendar/events-batch: sub-requests assembled without auth, packed, response split', async () => {
  const f = fakeFetch([{ status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batch_R' }, raw: BATCH_RESPONSE }]);
  const res = await run('calendar/events-batch', { requests: [
    { action: 'calendar/events-insert', params: { calendar_id: 'primary', summary: '[cws-verify] A', send_updates: 'none' } },
    { action: 'calendar/events-delete', params: { calendar_id: 'primary', event_id: 'E0', stray: 1 } },
  ] }, f.impl);
  const c = f.calls[0];
  assert.equal(c.url, 'https://www.googleapis.com/batch/calendar/v3');
  assert.equal(c.headers.Authorization, 'Bearer tok-1');
  assert.equal(c.headers['Content-Type'], 'multipart/mixed; boundary=BOUNDARY');
  const body = c.body.toString();
  assert.equal(body, [
    '--BOUNDARY', 'Content-Type: application/http', 'Content-ID: <item-0>', '',
    'POST /calendar/v3/calendars/primary/events?sendUpdates=none HTTP/1.1', 'Content-Type: application/json', '',
    '{"summary":"[cws-verify] A"}',
    '--BOUNDARY', 'Content-Type: application/http', 'Content-ID: <item-1>', '',
    'DELETE /calendar/v3/calendars/primary/events/E0 HTTP/1.1', '', '',
    '--BOUNDARY--', '',
  ].join('\r\n'));
  assert.ok(!body.includes('tok-1'), 'no credential inside sub-requests');
  assert.deepEqual(res.body.results, [
    { index: 0, action: 'calendar/events-insert', status_code: 200, headers: { 'content-type': 'application/json' }, body: { id: 'E1' } },
    { index: 1, action: 'calendar/events-delete', status_code: 204, headers: {}, body: '' },
  ]);
});

test('batch refusals: disallowed action, cross-origin, too many items, outer 5xx passthrough', async () => {
  const f = fakeFetch([{ status: 503, body: { error: 'x' } }]);
  await assert.rejects(run('calendar/events-batch', { requests: [{ action: 'tasks/items-insert', params: { tasklist: 'L' } }] }, f.impl), (e) => e.status === 400 && /not allowed/.test(e.message));
  const cross = CATALOG.map((a) => (a.action === 'events-batch' ? { ...a, request_spec: { ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, allowed_actions: ['tasks/items-insert'] } } } : a));
  await assert.rejects(invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'calendar/events-batch', params: { requests: [{ action: 'tasks/items-insert', params: { tasklist: 'L' } }] }, catalog: cross, credential: CRED }, { fetchImpl: f.impl, audit: () => {} }),
    (e) => e.status === 400 && /not the batch endpoint origin/.test(e.message));
  const prefix = CATALOG.map((a) => (a.action === 'events-batch' ? { ...a, request_spec: { ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, path_prefix: '/drive/v3/' } } } : a));
  await assert.rejects(invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'calendar/events-batch', params: { requests: [{ action: 'calendar/events-delete', params: { calendar_id: 'p', event_id: 'e' } }] }, catalog: prefix, credential: CRED }, { fetchImpl: f.impl, audit: () => {} }),
    (e) => e.status === 400 && /outside/.test(e.message));
  const many = Array.from({ length: 51 }, () => ({ action: 'calendar/events-delete', params: { calendar_id: 'p', event_id: 'e' } }));
  await assert.rejects(run('calendar/events-batch', { requests: many }, f.impl), { status: 400 });
  assert.equal(f.calls.length, 0);
  const res = await run('calendar/events-batch', { requests: [{ action: 'calendar/events-delete', params: { calendar_id: 'p', event_id: 'e' } }] }, f.impl);
  assert.equal(res.status_code, 503);
  assert.equal(f.calls.length, 1, 'outer 5xx is not retried');
});

test('batch: a sub-action that has its own request_spec cannot be nested', async () => {
  const cat = CATALOG.map((a) => (a.action === 'events-batch' ? { ...a, request_spec: { ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, allowed_actions: ['docs/documents-insert-text'] } } } : a));
  await assert.rejects(invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'calendar/events-batch', params: { requests: [] }, catalog: cat, credential: CRED }, { fetchImpl: fakeFetch([{}]).impl, audit: () => {} }), { status: 422 });
});

test('request_spec actions validate the catalog input_schema (JSON text): a missing required param is refused before any prefetch/send', async () => {
  const schema = '{"type":"object","properties":{"message_id":{"type":"string"},"to":{"type":["string","array"]}},"required":["message_id","to"]}';
  const fwd = { ...CATALOG.find((a) => a.action === 'messages-compose-forward'), input_schema: schema };
  const catalog = CATALOG.map((a) => (a === CATALOG.find((x) => x.action === 'messages-compose-forward') ? fwd : a));
  const f = fakeFetch([{ body: { id: 'M1' } }]);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'gmail/messages-compose-forward', params: { message_id: 'M0' }, catalog, credential: CRED },
      { fetchImpl: f.impl, audit: () => {} }),
    (e) => e.status === 400 && /missing required param "to"/.test(e.message),
  );
  assert.equal(f.calls.length, 0, 'no prefetch, no send');
  // A legacy action (no request_spec) keeps the historical lenient no-op on a
  // JSON-text schema: byte-identical behaviour, still sent.
  const legacy = { toolkit: 'x', action: 'legacy', method: 'POST', url_template: 'https://api.example.com/x', input_schema: '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}' };
  const g = fakeFetch([{ body: {} }]);
  const res = await invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'x/legacy', params: {}, catalog: [legacy], credential: CRED },
    { fetchImpl: g.impl, audit: () => {} });
  assert.equal(res.status_code, 200);
  assert.equal(g.calls.length, 1);
});

// Batch sub-requests resolve connection-owned URL placeholders (e.g. a
// self-hosted {base_url}) from the credential, exactly like a single call —
// they only skip auth injection (the outer request carries it).
const BASE = 'https://items.example.com';
const TPL_CRED = { ...CRED, url_placeholders: { base_url: BASE } };
const TPL_ITEMS_RESPONSE = [
  '--batch_R', 'Content-Type: application/http', 'Content-ID: <response-item-0>', '',
  'HTTP/1.1 200 OK', 'Content-Type: application/json', '', '{"id":"I1"}',
  '--batch_R--', '',
].join('\r\n');
const itemsCatalog = (subUrl, batchUrl) => [
  def('items/items-create', 'POST', subUrl, { input_schema: '{"type":"object","properties":{"name":{"type":"string"}}}' }),
  def('items/items-batch', 'POST', batchUrl, { request_spec: {
    version: 1, requires: ['batch'], encoding: 'batch_mixed',
    batch: { items_param: 'requests', max_items: 10, allowed_actions: ['items/items-create'], path_prefix: '/v1/', part_format: 'application_http' },
  } }),
];
const runItems = (catalog, actionSlug, params, fetchImpl) => invokeDirect(
  { orgId: 'o', connection: { id: 'c1' }, actionSlug, params, catalog, credential: TPL_CRED },
  { fetchImpl, audit: () => {}, boundary: () => 'BOUNDARY' },
);
const ITEMS_SUB_BODY = [
  '--BOUNDARY', 'Content-Type: application/http', 'Content-ID: <item-0>', '',
  'POST /v1/items HTTP/1.1', 'Content-Type: application/json', '',
  '{"name":"[cws-verify] a"}',
  '--BOUNDARY--', '',
].join('\r\n');

test('batch: a templated {base_url}/v1/items sub-request resolves base_url from the credential → 200, batch sent', async () => {
  const f = fakeFetch([{ status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batch_R' }, raw: TPL_ITEMS_RESPONSE }]);
  const res = await runItems(itemsCatalog('{base_url}/v1/items', '{base_url}/batch'), 'items/items-batch',
    { requests: [{ action: 'items/items-create', params: { name: '[cws-verify] a' } }] }, f.impl);
  assert.equal(res.status_code, 200);
  assert.equal(f.calls.length, 1, 'the batch is sent');
  assert.equal(f.calls[0].url, `${BASE}/batch`);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok-1');
  const body = f.calls[0].body.toString();
  assert.equal(body, ITEMS_SUB_BODY);
  assert.ok(!body.includes('tok-1'), 'no credential inside sub-requests');
  assert.deepEqual(res.body.results, [{ index: 0, action: 'items/items-create', status_code: 200, headers: { 'content-type': 'application/json' }, body: { id: 'I1' } }]);
});

test('batch: the same sub-request with a fixed URL → 200 (contrast)', async () => {
  const f = fakeFetch([{ status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batch_R' }, raw: TPL_ITEMS_RESPONSE }]);
  const res = await runItems(itemsCatalog(`${BASE}/v1/items`, `${BASE}/batch`), 'items/items-batch',
    { requests: [{ action: 'items/items-create', params: { name: '[cws-verify] a' } }] }, f.impl);
  assert.equal(res.status_code, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.toString(), ITEMS_SUB_BODY);
});

test('a templated {base_url}/v1/items single call with the same credential → 200 (contrast)', async () => {
  const f = fakeFetch([{ status: 200, body: { id: 'I1' } }]);
  const res = await runItems(itemsCatalog('{base_url}/v1/items', '{base_url}/batch'), 'items/items-create', { name: '[cws-verify] a' }, f.impl);
  assert.equal(res.status_code, 200);
  assert.equal(f.calls[0].url, `${BASE}/v1/items`);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok-1');
});

// Resumable chunk 401: the response body is drained only when a retry is
// certain; a terminal 401 keeps the provider's error code/reason.
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ';
const INIT_OK = { status: 200, headers: { location: SESSION }, raw: '' };
const ERR_401 = { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } };
function resumableRun(responses, { credential = CRED, acquire } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-rs401-'));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(comp, 'upload'), { recursive: true });
  const fp = path.join(comp, 'upload/f.txt');
  fs.writeFileSync(fp, 'abc');
  const f = fakeFetch(responses);
  const p = invokeDirect(
    { orgId: 'o', connection: { id: 'c1' }, actionSlug: 'drive/files-upload-resumable', params: { file: fp }, catalog: CATALOG, credential },
    { fetchImpl: f.impl, audit: () => {}, sleep: async () => {}, home, componentDir: comp, ...(acquire ? { acquire } : {}) },
  );
  return { f, p };
}

test('resumable chunk 401, no acquire fn → terminal 401 keeps the provider error body', async () => {
  const { f, p } = resumableRun([INIT_OK, { status: 401, body: ERR_401 }]);
  const res = await p;
  assert.equal(res.status_code, 401);
  assert.deepEqual(res.body, ERR_401);
  assert.equal(f.calls.length, 2);
});

test('resumable chunk 401, API-key credential (not refreshable) → terminal 401 keeps the body', async () => {
  let acquired = 0;
  const { f, p } = resumableRun([INIT_OK, { status: 401, body: ERR_401 }], {
    credential: { ...CRED, token_type: 'api_key' },
    acquire: async () => { acquired++; return { ...CRED, access_token: 'tok-2' }; },
  });
  const res = await p;
  assert.equal(res.status_code, 401);
  assert.deepEqual(res.body, ERR_401);
  assert.equal(acquired, 0, 'api_key is never refreshed');
  assert.equal(f.calls.length, 2);
});

test('resumable chunk 401 after the refresh budget (two refreshes) is spent → terminal 401 keeps the body', async () => {
  let n = 1;
  const { f, p } = resumableRun([INIT_OK, { status: 401, body: ERR_401 }, { status: 401, body: ERR_401 }, { status: 401, body: ERR_401 }], {
    acquire: async () => ({ ...CRED, access_token: `tok-${++n}` }),
  });
  const res = await p;
  assert.equal(res.status_code, 401);
  assert.deepEqual(res.body, ERR_401);
  assert.equal(n, 3, 'exactly two refreshes');
  assert.deepEqual(f.calls.slice(1).map((c) => c.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3']);
});

test('resumable controls: init 401 (no refresh) and chunk 403 keep their bodies; chunk 401 + refresh → 200', async () => {
  const a = resumableRun([{ status: 401, body: ERR_401 }]);
  const ra = await a.p;
  assert.equal(ra.status_code, 401);
  assert.deepEqual(ra.body, ERR_401);
  const forbidden = { error: { code: 403, message: 'insufficientPermissions' } };
  const b = resumableRun([INIT_OK, { status: 403, body: forbidden }]);
  const rb = await b.p;
  assert.equal(rb.status_code, 403);
  assert.deepEqual(rb.body, forbidden);
  const ok = resumableRun([INIT_OK, { status: 200, body: { id: 'F1' } }]);
  assert.deepEqual((await ok.p).body, { id: 'F1' });
  const c = resumableRun([INIT_OK, { status: 401, body: ERR_401 }, { status: 200, body: { id: 'F2' } }], {
    acquire: async () => ({ ...CRED, access_token: 'tok-2' }),
  });
  const rc = await c.p;
  assert.equal(rc.status_code, 200);
  assert.deepEqual(rc.body, { id: 'F2' });
  assert.equal(c.f.calls[2].headers.Authorization, 'Bearer tok-2');
  assert.equal(c.f.calls[2].headers['Content-Range'], 'bytes 0-2/3');
});

// ---------------------------------------------------------------------------
//  B2 Meta Page token exchange × request_spec: the exchange is only wired into
//  the plain path, so a marked action reached through the request_spec engine
//  fails closed (422) before ANY network call — the marker is never silently
//  stripped and the user token sent instead.
// ---------------------------------------------------------------------------

const MARKER = { 'X-Openmax-Token-Exchange': 'meta_page:page_id' };
const GRAPH = 'https://graph.facebook.com/v26.0';

test('B2: request_spec action carrying the token-exchange marker → 422, no request sent', async () => {
  const cat = [
    ...CATALOG,
    def('meta_pages/create_page_post_spec', 'POST', `${GRAPH}/{page_id}/feed`, {
      headers_template: MARKER,
      request_spec: { version: 1, requires: ['body_template'], body: { message: '{{message}}' } },
    }),
  ];
  const f = fakeFetch([{ body: { id: 'P1' } }]);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'meta_pages/create_page_post_spec', params: { page_id: '111', message: 'm' }, catalog: cat, credential: CRED }, { fetchImpl: f.impl, audit: () => {} }),
    (e) => e.status === 422 && /X-Openmax-Token-Exchange/.test(e.message) && /request_spec/.test(e.message) && !e.message.includes('tok-1'),
  );
  // marker key in any case is still detected
  const lower = cat.map((a) => (a.action === 'create_page_post_spec' ? { ...a, headers_template: { 'x-openmax-token-exchange': 'meta_page:page_id' } } : a));
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: 'meta_pages/create_page_post_spec', params: { page_id: '111', message: 'm' }, catalog: lower, credential: CRED }, { fetchImpl: f.impl, audit: () => {} }),
    { status: 422 },
  );
  assert.equal(f.calls.length, 0, 'neither the exchange nor the real call is attempted');
});

test('B2: a marked prefetch step or batch item → 422, the user token is never sent for it', async () => {
  const f = fakeFetch([{ body: ORIG }, { body: { id: 'M2' } }]);
  const markedGet = CATALOG.map((a) => (a.action === 'messages-get' ? { ...a, headers_template: MARKER } : a));
  await assert.rejects(run2(markedGet, 'gmail/threads-compose-reply', { message_id: 'M0', text: 'x' }, f.impl),
    (e) => e.status === 422 && /prefetch steps/.test(e.message));
  assert.equal(f.calls.length, 0, 'marked prefetch GET not sent');

  const markedItem = CATALOG.map((a) => (a.action === 'events-delete' ? { ...a, headers_template: MARKER } : a));
  await assert.rejects(run2(markedItem, 'calendar/events-batch', { requests: [{ action: 'calendar/events-delete', params: { calendar_id: 'p', event_id: 'e' } }] }, f.impl),
    (e) => e.status === 422 && /batch items/.test(e.message));
  assert.equal(f.calls.length, 0, 'batch with a marked item not sent');
});

function run2(catalog, action, params, fetchImpl) {
  return invokeDirect({ orgId: 'o', connection: { id: 'c1' }, actionSlug: action, params, catalog, credential: CRED }, { fetchImpl, audit: () => {}, boundary: () => 'BOUNDARY' });
}

test('B2: a marked action called with _download → 422, the user token is never sent', async () => {
  const cat = [
    ...CATALOG,
    def('meta_pages/get_page_post', 'GET', `${GRAPH}/{post_id}`, { headers_template: MARKER }),
  ];
  const f = fakeFetch([{ body: 'bytes' }]);
  await assert.rejects(
    run2(cat, 'meta_pages/get_page_post', { post_id: '111_222', page_id: '111', _download: { url: `${GRAPH}/file` } }, f.impl),
    (e) => e.status === 422 && /_download/.test(e.message) && !e.message.includes('tok-1'),
  );
  assert.equal(f.calls.length, 0, 'download not attempted');
});
