// Verifies the opt-in `withCursor` response shape for cursor-paginated cws-core
// endpoints ({ data, next_cursor?, request_id, server_time }):
//   - default (no flag)  → bare `data`, exactly as before (next_cursor dropped)
//   - withCursor:true    → { data, next_cursor }, '' when the field is omitted
//                          (cws-core next_cursor is omitempty on the last page)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getForOrg, setApiKey, setBaseUrl, setHeaders } from './client.js';

let origFetch;
let origLog;
const savedRpcLog = process.env.COCO_RPC_LOG;
const savedRpcFile = process.env.COCO_RPC_LOG_FILE;

const respond = (body) => async () => ({ status: 200, ok: true, async text() { return JSON.stringify(body); } });

beforeEach(() => {
  process.env.COCO_RPC_LOG = '0';
  delete process.env.COCO_RPC_LOG_FILE;
  setApiKey('test-token');
  setBaseUrl('http://client-test.local');
  setHeaders({});
  origFetch = globalThis.fetch;
  origLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  setApiKey(null);
  setBaseUrl(null);
  setHeaders(null);
  if (savedRpcLog === undefined) delete process.env.COCO_RPC_LOG; else process.env.COCO_RPC_LOG = savedRpcLog;
  if (savedRpcFile !== undefined) process.env.COCO_RPC_LOG_FILE = savedRpcFile;
});

test('getForOrg default: cursor envelope unwraps to bare data (other callers unaffected)', async () => {
  globalThis.fetch = respond({ data: [{ id: 'a' }], next_cursor: 'c1', request_id: 'r1' });
  assert.deepEqual(await getForOrg('org-1', '/api/v1/connect/applications'), [{ id: 'a' }]);
});

test('getForOrg withCursor: returns { data, next_cursor }; omitted next_cursor → ""', async () => {
  globalThis.fetch = respond({ data: [{ id: 'a' }], next_cursor: 'c1', total_count: 3, request_id: 'r1' });
  assert.deepEqual(await getForOrg('org-1', '/api/v1/connect/applications', { limit: '1' }, { withCursor: true }),
    { data: [{ id: 'a' }], next_cursor: 'c1' });
  globalThis.fetch = respond({ data: [{ id: 'b' }], request_id: 'r2' });
  assert.deepEqual(await getForOrg('org-1', '/api/v1/connect/applications', { cursor: 'c1' }, { withCursor: true }),
    { data: [{ id: 'b' }], next_cursor: '' });
});
