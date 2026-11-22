import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./core.js', import.meta.url));
const scope = { org: 'org-automation', projectId: 'project' };
const member = id => ({ id: `row-${id}`, project_id: 'project', member_id: id, role: 'member' });
const envelope = (data, page, totalCount, totalPages) => ({
  data, pagination: { page, page_size: 20, total_count: totalCount, total_pages: totalPages }, request_id: 'test-request',
});

async function withServer(t, respond) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    req.resume();
    const response = respond(new URL(req.url, 'http://localhost'));
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (params, command = 'core.project_members') => new Promise(resolve => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: { ...process.env, COCO_ORG_ID: scope.org, COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
        COCO_AUTH_TOKEN: 'project-member-test-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  const read = async params => {
    const result = await run(params);
    assert.ifError(result.error);
    return JSON.parse(result.stdout);
  };
  return { requests, run, read };
}

test('project members can read B beyond the first 20 with exact numbered-page metadata', async t => {
  const first = envelope(Array.from({ length: 20 }, (_, i) => member(`agent-${i}`)), 1, 21, 2);
  const second = envelope([member('B')], 2, 21, 2);
  const { read, requests } = await withServer(t, url => ({ body: url.searchParams.get('page') === '2' ? second : first }));
  const page1 = await read({ ...scope, page: 1, pageSize: 20 });
  assert.equal(page1.data.some(row => row.member_id === 'B'), false);
  assert.deepEqual(page1.pagination, first.pagination);
  assert.ok(page1.pagination.page < page1.pagination.total_pages);
  const page2 = await read({ ...scope, page: page1.pagination.page + 1, pageSize: 20 });
  assert.deepEqual(page2, { data: [member('B')], pagination: second.pagination });
  assert.deepEqual(requests, [1, 2].map(page => ({ method: 'GET',
    url: `/api/v1/projects/project/members?page=${page}&page_size=20`, authorization: 'Bearer project-member-test-token' })));
});

test('project members preserve final-page and empty-list evidence for a completed negative lookup', async t => {
  const pages = [envelope(Array.from({ length: 20 }, (_, i) => member(`agent-${i}`)), 1, 21, 2),
    envelope([member('agent-20')], 2, 21, 2), envelope([], 1, 0, 0)];
  const { read } = await withServer(t, () => ({ body: pages.shift() }));
  const first = await read({ ...scope, page: 1, pageSize: 20 });
  const last = await read({ ...scope, page: 2, pageSize: 20 });
  assert.equal([...first.data, ...last.data].some(row => row.member_id === 'B'), false);
  assert.equal(first.pagination.total_count, last.pagination.total_count);
  assert.equal(last.pagination.page, last.pagination.total_pages);
  assert.equal(first.data.length + last.data.length, last.pagination.total_count);
  assert.deepEqual(await read({ ...scope, page: 1, pageSize: 20 }), {
    data: [], pagination: { page: 1, page_size: 20, total_count: 0, total_pages: 0 },
  });
});

test('project members preserve incomplete pagination instead of manufacturing exhaustion', async t => {
  const responses = [
    { data: [], request_id: 'r' },
    { data: [], next_cursor: 'unexpected-cursor-contract', request_id: 'r' },
    { data: [], pagination: { page: 1, page_size: 20 }, request_id: 'r' },
    envelope([], 1, 21, 2),
    envelope([], 2, 22, 2),
  ];
  const { read } = await withServer(t, () => ({ body: responses.shift() }));
  assert.deepEqual(await read(scope), []);
  assert.deepEqual(await read(scope), []);
  assert.deepEqual(await read(scope), { data: [], pagination: { page: 1, page_size: 20 } });
  const repeated = await read({ ...scope, page: 2, pageSize: 20 });
  assert.equal(repeated.pagination.page, 1);
  const changed = await read({ ...scope, page: 2, pageSize: 20 });
  assert.notEqual(changed.pagination.total_count, repeated.pagination.total_count);
  // The Lead instructions govern unresolved outcomes; this thin CLI preserves
  // the evidence without claiming a traversal or interpreting membership.
});

test('a failed subsequent project-member page exits nonzero with no false empty list', async t => {
  for (const status of [403, 503]) {
    const { run, read, requests } = await withServer(t, url => url.searchParams.get('page') === '2'
      ? { status, body: { error: { message: 'directory unavailable' } } }
      : { body: envelope([member('A')], 1, 21, 2) });
    const first = await read({ ...scope, page: 1, pageSize: 20 });
    assert.ok(first.pagination.page < first.pagination.total_pages);
    const result = await run({ ...scope, page: 2, pageSize: 20 });
    assert.ok(result.error);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).status, status);
    assert.equal(requests.length, 2);
  }
});

test('project members retain defaults and limit alias, with canonical pageSize precedence', async t => {
  const { read, requests } = await withServer(t, () => ({ body: envelope([], 1, 0, 0) }));
  await read(scope);
  await read({ ...scope, page: 3, limit: 50 });
  await read({ ...scope, page: 2, pageSize: 20, limit: 50 });
  assert.deepEqual(requests.map(row => row.url), [
    '/api/v1/projects/project/members',
    '/api/v1/projects/project/members?page=3&page_size=50',
    '/api/v1/projects/project/members?page=2&page_size=20',
  ]);
});

test('project members reject invalid numeric pages and cursor pagination before HTTP', async t => {
  const { run, requests } = await withServer(t, () => ({ body: {} }));
  for (const invalid of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: '2' }, { page: null },
    { page: 2147483648 }, { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 },
    { pageSize: '20' }, { pageSize: null }, { limit: null }, { limit: -1 }, { cursor: 'next' }, { next_cursor: 'next' }]) {
    const result = await run({ ...scope, ...invalid });
    assert.ok(result.error, JSON.stringify(invalid));
    assert.match(result.stderr, /core.project_members/);
    assert.equal(JSON.parse(result.stderr).status, 400);
    assert.equal(requests.length, 0);
  }
});

test('member_get returns B without inventing an org response field', async t => {
  const target = { member_id: 'B', kind: 'agent', status: 'active' };
  const { run, requests } = await withServer(t, () => ({ body: { data: target, request_id: 'r' } }));
  const result = await run({ org: scope.org, memberId: 'B' }, 'core.member_get');
  assert.ifError(result.error);
  assert.deepEqual(JSON.parse(result.stdout), target);
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/v1/members/B', authorization: 'Bearer project-member-test-token' }]);
});
