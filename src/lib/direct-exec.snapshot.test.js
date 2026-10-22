// Byte-identical regression snapshot: actions WITHOUT request_spec must put
// exactly the same request on the wire as origin/main (c108939) did — method,
// URL, headers and body bytes — except for the two deliberate fixes listed in
// DELIBERATE_CHANGES (plan §2 F2 / F3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeDirect } from './direct-exec.js';
import { invokeDirect as invokeDirectMain } from './request-spec/testdata/direct-exec.main-c108939.js';

const SCHEMA_EMPTY = '{"type":"object","properties":{},"additionalProperties":false}';
const a = (name, method, url, extra = {}) => {
  const [toolkit, action] = name.split('/');
  return { toolkit, action, method, url_template: url, input_schema: '', ...extra };
};

const CASES = [
  { def: a('gh/get', 'GET', 'https://api.example.com/repos/{owner}/{repo}?per_page={per_page}&page={page}'), params: { owner: 'o', repo: 'r/x', per_page: 5, extra: 'ignored' } },
  { def: a('gh/get-query', 'GET', 'https://api.example.com/items'), params: { _query: { fields: 'a,b', ids: [1, 2] } } },
  { def: a('gh/xq', 'GET', 'https://api.example.com/r?fields={fields}', { input_schema: '{"type":"object","properties":{"fields":{"type":"array","x-query-style":"json"}}}' }), params: { fields: ['a', 'b'] } },
  { def: a('gh/post', 'POST', 'https://api.example.com/repos/{owner}/issues'), params: { owner: 'o', title: 'T', labels: ['a'], body: { nested: true } } },
  { def: a('gh/post-empty', 'POST', 'https://api.example.com/x'), params: {} },
  { def: a('gh/put', 'PUT', 'https://api.example.com/x/{id}', { input_schema: SCHEMA_EMPTY }), params: { id: 1, v: 'é' } },
  { def: a('gh/patch', 'PATCH', 'https://api.example.com/x/{id}'), params: { id: 2, a: null } },
  { def: a('gh/delete-declared', 'DELETE', 'https://api.example.com/repos/{owner}/contents/{path}', { input_schema: '{"type":"object","properties":{"owner":{"type":"string"},"message":{"type":"string"},"sha":{"type":"string"}}}' }), params: { owner: 'o', path: 'a/b.txt', message: 'm', sha: 's' } },
  { def: a('gh/delete-plain', 'DELETE', 'https://api.example.com/x/{id}', { input_schema: SCHEMA_EMPTY }), params: { id: 3 } },
  { def: a('n/hdr', 'POST', 'https://api.example.com/pages', { headers_template: { 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json; charset=utf-8', From: '{from_email}' } }), params: { from_email: 'a@b.c', x: 1 } },
  { def: a('n/base', 'POST', '{base_url}/api/json?tree={tree}'), params: { tree: 'jobs', y: 2 }, cred: { url_placeholders: { base_url: 'https://jenkins.example.com' }, token_type: 'basic' } },
  { def: a('n/inj-header', 'POST', 'https://api.example.com/v3/x'), params: { z: 1 }, cred: { auth_injection: { location: 'header', name: 'X-MKT-API-Key', value_template: '{token}' } } },
  { def: a('n/inj-query', 'GET', 'https://api.example.com/v3/x?a={a}'), params: { a: 'b' }, cred: { auth_injection: { location: 'query', name: 'key', value_template: '{token}' } } },
  { def: a('n/form-empty', 'POST', 'https://api.stripe.com/v1/customers', { encoding: 'form' }), params: {} },
  // Deliberate F2 / F3 changes:
  { id: 'stripe-form', def: a('stripe/customers-create', 'POST', 'https://api.stripe.com/v1/customers', { encoding: 'form' }), params: { email: 'a b@x.io', name: 'Zoë', metadata: { order: '42' } } },
  { id: 'none-post', def: a('dropbox/current-account', 'POST', 'https://api.dropboxapi.com/2/users/get_current_account', { encoding: 'none' }), params: { stray: 1 } },
  { id: 'delete-stray', def: a('gh/delete-stray', 'DELETE', 'https://api.example.com/x/{id}', { input_schema: SCHEMA_EMPTY }), params: { id: 3, stray: 'x' } },
  { id: 'delete-unpublished', def: a('gh/delete-unpublished', 'DELETE', 'https://api.example.com/x/{id}'), params: { id: 3, stray: 'x' } },
];

// What changed on purpose, and the exact new wire form.
const DELIBERATE_CHANGES = {
  'stripe-form': {
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=a+b%40x.io&metadata%5Border%5D=42&name=Zo%C3%AB',
  },
  'none-post': { headers: { Authorization: 'Bearer tok' }, body: undefined },
  'delete-stray': { headers: { Authorization: 'Bearer tok' }, body: undefined },
  'delete-unpublished': { headers: { Authorization: 'Bearer tok' }, body: undefined },
};

async function wire(invoke, c) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: { ...opts.headers }, body: opts.body === undefined ? undefined : Buffer.from(opts.body).toString('latin1') });
    return { status: 200, headers: new Map([['content-type', 'application/json']]), body: new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('{}')); ctl.close(); } }) };
  };
  await invoke(
    { orgId: 'o', connection: { id: 'c' }, actionSlug: `${c.def.toolkit}/${c.def.action}`, params: JSON.parse(JSON.stringify(c.params)), catalog: [c.def], credential: { access_token: 'tok', token_type: 'bearer', ...(c.cred || {}) } },
    { fetchImpl, audit: () => {} },
  );
  return calls[0];
}

for (const c of CASES) {
  const label = c.id || `${c.def.toolkit}/${c.def.action}`;
  test(`snapshot: ${label}`, async () => {
    const before = await wire(invokeDirectMain, c);
    const after = await wire(invokeDirect, c);
    if (!c.id) {
      assert.deepStrictEqual(after, before, 'byte-identical to origin/main');
      return;
    }
    const want = DELIBERATE_CHANGES[c.id];
    assert.notDeepStrictEqual(after, before, 'this case changes on purpose');
    assert.equal(after.url, before.url);
    assert.equal(after.method, before.method);
    assert.deepStrictEqual(after.headers, want.headers);
    assert.equal(after.body, want.body);
  });
}

test('every deliberate change is exercised by a case', () => {
  assert.deepEqual(Object.keys(DELIBERATE_CHANGES).sort(), CASES.filter((c) => c.id).map((c) => c.id).sort());
});
