import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBatchResponse, boundaryFromContentType, packBatch } from './batch.js';

const CT = 'multipart/mixed; boundary=batch_pK7JBAk73-E=_AA5eFwv4m2Q=';
// Shape of the batch response in Google's "Batching requests" guide, with our
// Content-ID scheme (<item-N> → <response-item-N>) and parts out of order.
const RESPONSE = [
  '--batch_pK7JBAk73-E=_AA5eFwv4m2Q=',
  'Content-Type: application/http',
  'Content-ID: <response-item-1>',
  '',
  'HTTP/1.1 404 Not Found',
  'Content-Type: application/json; charset=UTF-8',
  '',
  '{"error":{"code":404,"message":"Not Found"}}',
  '--batch_pK7JBAk73-E=_AA5eFwv4m2Q=',
  'Content-Type: application/http',
  'Content-ID: <response-item-0>',
  '',
  'HTTP/1.1 200 OK',
  'Content-Type: application/json; charset=UTF-8',
  'ETag: "lGaP-E0memYDumK16YuUDM_6Gf0"',
  '',
  '{',
  '  "kind": "calendar#event",',
  '  "id": "e1"',
  '}',
  '--batch_pK7JBAk73-E=_AA5eFwv4m2Q=',
  'Content-Type: application/http',
  'Content-ID: <response-item-2>',
  '',
  'HTTP/1.1 204 No Content',
  '',
  '',
  '--batch_pK7JBAk73-E=_AA5eFwv4m2Q=--',
  '',
].join('\r\n');

test('boundary parsing (quoted and bare)', () => {
  assert.equal(boundaryFromContentType(CT), 'batch_pK7JBAk73-E=_AA5eFwv4m2Q=');
  assert.equal(boundaryFromContentType('multipart/mixed; boundary="a b"'), 'a b');
  assert.equal(boundaryFromContentType('application/json'), null);
});

test('response split maps Content-ID back to request index, per-item status/body', () => {
  const items = [{ action: 'calendar/events-insert' }, { action: 'calendar/events-patch' }, { action: 'calendar/events-delete' }];
  const r = parseBatchResponse(RESPONSE, CT, items);
  assert.deepEqual(r.map((x) => [x.index, x.action, x.status_code]), [
    [0, 'calendar/events-insert', 200], [1, 'calendar/events-patch', 404], [2, 'calendar/events-delete', 204],
  ]);
  assert.deepEqual(r[0].body, { kind: 'calendar#event', id: 'e1' });
  assert.equal(r[0].headers.etag, '"lGaP-E0memYDumK16YuUDM_6Gf0"');
  assert.equal(r[1].body.error.code, 404);
  assert.equal(r[2].body, '');
});

test('LF-only responses are tolerated; no Content-ID falls back to order', () => {
  const lf = RESPONSE.replace(/\r\n/g, '\n').replace(/Content-ID: <response-item-\d>\n/g, '');
  const r = parseBatchResponse(lf, CT, [{ action: 'a' }, { action: 'b' }, { action: 'c' }]);
  assert.deepEqual(r.map((x) => x.status_code), [404, 200, 204]);
  assert.throws(() => parseBatchResponse(RESPONSE, 'application/json', []), { status: 502 });
});

test('pack refuses header/path injection', () => {
  assert.throws(() => packBatch([{ method: 'GET', path: '/a b', headers: {} }]), { status: 400 });
  assert.throws(() => packBatch([{ method: 'GET', path: 'http://evil/x', headers: {} }]), { status: 400 });
  assert.throws(() => packBatch([{ method: 'GET', path: '/a', headers: { X: 'a\r\nB: c' } }]), { status: 400 });
});
