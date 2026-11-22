import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as json from './encoders/json.js';
import * as form from './encoders/form.js';
import * as none from './encoders/none.js';
import * as media from './encoders/media.js';
import * as related from './encoders/multipart-related.js';
import * as formData from './encoders/multipart-form.js';
import * as batchMixed from './encoders/batch-mixed.js';
import { MISSING } from './transforms.js';
import { MAX_BODY_BYTES } from './files.js';

const file = (filename, mime, content) => ({ __file: true, filename, mime_type: mime, bytes: Buffer.from(content), size: Buffer.byteLength(content) });
const fixed = (b) => () => b;

test('json: exactly JSON.stringify, application/json; missing → no body', () => {
  const v = { a: 'é', b: [1, { c: null }] };
  assert.deepEqual(json.encode({ value: v }), { contentType: 'application/json', body: JSON.stringify(v) });
  assert.deepEqual(json.encode({ value: MISSING }), { contentType: undefined, body: undefined });
});

test('form: Go url.Values.Encode semantics for scalars (sorted, QueryEscape, + for space)', () => {
  const { contentType, body } = form.encode({ value: { z: 'a b', a: "x!'()*~-._y", n: 3, t: true, f: false, nul: null, e: 'é&=' } });
  assert.equal(contentType, 'application/x-www-form-urlencoded');
  assert.equal(body, 'a=x%21%27%28%29%2A~-._y&e=%C3%A9%26%3D&f=false&n=3&t=true&z=a+b');
});

test('form: nested objects / arrays use bracket notation (Stripe deep-object style)', () => {
  const { body } = form.encode({ value: { metadata: { order: '42', tag: 'x y' }, items: [{ price: 'p_1', quantity: 2 }], expand: ['a', 'b'] } });
  assert.equal(body, 'expand%5B0%5D=a&expand%5B1%5D=b&items%5B0%5D%5Bprice%5D=p_1&items%5B0%5D%5Bquantity%5D=2&metadata%5Border%5D=42&metadata%5Btag%5D=x+y');
  assert.throws(() => form.encode({ value: [1] }), { status: 422 });
});

test('none: never a body nor a content type', () => {
  assert.deepEqual(none.encode({ value: { a: 1 } }), { contentType: undefined, body: undefined });
});

test('media: raw bytes with the file mime type', () => {
  const r = media.encode({ value: file('a.txt', 'text/plain', 'hello') });
  assert.equal(r.contentType, 'text/plain');
  assert.deepEqual(r.body, Buffer.from('hello'));
  assert.equal(media.encode({ value: Buffer.from('x') }).contentType, 'application/octet-stream');
  assert.throws(() => media.encode({ value: MISSING }), { status: 400 });
  assert.throws(() => media.encode({ value: { a: 1 } }), { status: 422 });
});

test('multipart_related golden (metadata JSON + file), CRLF, closing --boundary--', () => {
  const r = related.encode({
    parts: [
      { value: { name: 'a.txt', parents: ['p'] }, content_type: 'application/json; charset=UTF-8' },
      { value: file('a.txt', 'text/plain', 'hello') },
    ],
    boundary: fixed('BB'),
  });
  assert.equal(r.contentType, 'multipart/related; boundary=BB');
  assert.equal(r.body.toString(), [
    '--BB',
    'Content-Type: application/json; charset=UTF-8',
    '',
    '{"name":"a.txt","parents":["p"]}',
    '--BB',
    'Content-Type: text/plain',
    '',
    'hello',
    '--BB--',
    '',
  ].join('\r\n'));
});

test('multipart boundary never collides with a part', () => {
  let i = 0;
  const r = related.encode({ parts: [{ value: 'xxBOUNDxx' }], boundary: () => (i++ === 0 ? 'BOUND' : 'OTHER') });
  assert.equal(r.contentType, 'multipart/related; boundary=OTHER');
});

test('multipart_form golden incl. non-ASCII filename (RFC 7578)', () => {
  const r = formData.encode({
    parts: [{ name: 'note', value: 'hi' }, { name: 'file', value: file('报告.txt', 'text/plain', 'x') }],
    boundary: fixed('FF'),
  });
  assert.equal(r.contentType, 'multipart/form-data; boundary=FF');
  assert.equal(r.body.toString(), [
    '--FF',
    'Content-Disposition: form-data; name="note"',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'hi',
    '--FF',
    'Content-Disposition: form-data; name="file"; filename="__.txt"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.txt',
    'Content-Type: text/plain',
    '',
    'x',
    '--FF--',
    '',
  ].join('\r\n'));
  assert.throws(() => formData.encode({ parts: [{ name: 'a"b', value: 'x' }] }), { status: 400 });
});

test('body size cap (25 MiB) on every encoder', () => {
  const big = 'x'.repeat(MAX_BODY_BYTES + 1);
  assert.throws(() => json.encode({ value: big }), { status: 413 });
  assert.throws(() => form.encode({ value: { a: big } }), { status: 413 });
  assert.throws(() => media.encode({ value: Buffer.alloc(MAX_BODY_BYTES + 1) }), { status: 413 });
  assert.throws(() => related.encode({ parts: [{ value: big }] }), { status: 413 });
});

test('batch_mixed golden: application/http parts with Content-ID <item-N>', () => {
  const r = batchMixed.encode({
    items: [
      { method: 'POST', path: '/calendar/v3/calendars/primary/events', headers: { 'Content-Type': 'application/json' }, body: '{"summary":"A"}' },
      { method: 'DELETE', path: '/calendar/v3/calendars/primary/events/e1?sendUpdates=none', headers: {} },
    ],
    boundary: fixed('batch_X'),
  });
  assert.equal(r.contentType, 'multipart/mixed; boundary=batch_X');
  assert.equal(r.body.toString(), [
    '--batch_X',
    'Content-Type: application/http',
    'Content-ID: <item-0>',
    '',
    'POST /calendar/v3/calendars/primary/events HTTP/1.1',
    'Content-Type: application/json',
    '',
    '{"summary":"A"}',
    '--batch_X',
    'Content-Type: application/http',
    'Content-ID: <item-1>',
    '',
    'DELETE /calendar/v3/calendars/primary/events/e1?sendUpdates=none HTTP/1.1',
    '',
    '',
    '--batch_X--',
    '',
  ].join('\r\n'));
});
