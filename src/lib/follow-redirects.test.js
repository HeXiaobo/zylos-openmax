import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchFollowingRedirects } from './follow-redirects.js';

// A scripted fetch: url → response. Records every request.
function scripted(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return {
      status: r.status,
      headers: new Headers(r.location ? { location: r.location } : {}),
      body: null,
      ok: r.status >= 200 && r.status < 300,
    };
  };
  return { calls, fetchImpl };
}

test('follows a platform link redirect to the storage object, with the same headers on every hop', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/api/public/artifacts/download/t1': { status: 302, location: 'https://store.example/obj?sig=1' },
    'https://store.example/obj?sig=1': { status: 200 },
  });
  const res = await fetchFollowingRedirects('https://core.example/api/public/artifacts/download/t1', {
    headers: { 'CF-Access-Client-Id': 'id' },
    fetchImpl,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), [
    'https://core.example/api/public/artifacts/download/t1',
    'https://store.example/obj?sig=1',
  ]);
  for (const c of calls) {
    assert.equal(c.opts.redirect, 'manual');
    assert.equal(c.opts.method, 'GET');
    assert.deepEqual(c.opts.headers, { 'CF-Access-Client-Id': 'id' });
  }
});

test('a direct storage URL (no redirect) is fetched exactly once', async () => {
  const { calls, fetchImpl } = scripted({ 'https://store.example/obj': { status: 200 } });
  const res = await fetchFollowingRedirects('https://store.example/obj', { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('relative Location resolves against the current URL', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/a/t1': { status: 307, location: '/store/obj' },
    'https://core.example/store/obj': { status: 200 },
  });
  await fetchFollowingRedirects('https://core.example/a/t1', { fetchImpl });
  assert.equal(calls.at(-1).url, 'https://core.example/store/obj');
});

test('non-redirect failures come back as-is (the caller decides; no retry of the same URL)', async () => {
  const { calls, fetchImpl } = scripted({ 'https://core.example/t1': { status: 404 } });
  const res = await fetchFollowingRedirects('https://core.example/t1', { fetchImpl });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('refuses https → http downgrade, non-http schemes, loops, missing Location and too many hops', async () => {
  await assert.rejects(fetchFollowingRedirects('https://a.example/x', {
    fetchImpl: scripted({ 'https://a.example/x': { status: 302, location: 'http://a.example/y' } }).fetchImpl,
  }), /non-https/);
  await assert.rejects(fetchFollowingRedirects('https://a.example/x', {
    fetchImpl: scripted({ 'https://a.example/x': { status: 302, location: 'file:///etc/passwd' } }).fetchImpl,
  }), /non-https|scheme/);
  await assert.rejects(fetchFollowingRedirects('ftp://a.example/x', { fetchImpl: async () => { throw new Error('no'); } }), /scheme/);
  await assert.rejects(fetchFollowingRedirects('https://a.example/x', {
    fetchImpl: scripted({
      'https://a.example/x': { status: 302, location: 'https://a.example/y' },
      'https://a.example/y': { status: 302, location: 'https://a.example/x' },
    }).fetchImpl,
  }), /loop/);
  await assert.rejects(fetchFollowingRedirects('https://a.example/x', {
    fetchImpl: scripted({ 'https://a.example/x': { status: 302 } }).fetchImpl,
  }), /without a Location/);
  const chain = {};
  for (let i = 0; i < 5; i++) chain[`https://a.example/${i}`] = { status: 302, location: `https://a.example/${i + 1}` };
  await assert.rejects(fetchFollowingRedirects('https://a.example/0', { fetchImpl: scripted(chain).fetchImpl, maxRedirects: 3 }), /more than 3/);
});

function chain(n) {
  // n redirects, then the object.
  const routes = {};
  for (let i = 0; i < n; i++) routes[`https://a.example/${i}`] = { status: 302, location: `https://a.example/${i + 1}` };
  routes[`https://a.example/${n}`] = { status: 200 };
  return scripted(routes);
}

test('default hop limit: exactly 3 redirects are followed, a 4th is refused', async () => {
  const ok = chain(3);
  const res = await fetchFollowingRedirects('https://a.example/0', { fetchImpl: ok.fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(ok.calls.length, 4);

  const tooMany = chain(4);
  await assert.rejects(fetchFollowingRedirects('https://a.example/0', { fetchImpl: tooMany.fetchImpl }), /more than 3 redirects/);
  // The 4th redirect answer is read but its target is never requested.
  assert.deepEqual(tooMany.calls.map((c) => c.url), [0, 1, 2, 3].map((i) => `https://a.example/${i}`));
});

test('cross-origin redirect drops authorization, proxy-authorization and cookie (as fetch does); same-origin keeps them', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/t1': { status: 302, location: '/t1b' },
    'https://core.example/t1b': { status: 302, location: 'https://store.example/obj' },
    'https://store.example/obj': { status: 302, location: 'https://core.example/back' },
    'https://core.example/back': { status: 200 },
  });
  const headers = {
    Authorization: 'Bearer x',
    'Proxy-Authorization': 'Basic y',
    Cookie: 'c=1',
    'CF-Access-Client-Id': 'id',
    'CF-Access-Client-Secret': 's',
  };
  await fetchFollowingRedirects('https://core.example/t1', { headers, fetchImpl });
  assert.deepEqual(calls[0].opts.headers, headers);
  assert.deepEqual(calls[1].opts.headers, headers);
  const stripped = { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 's' };
  assert.deepEqual(calls[2].opts.headers, stripped);
  // Once dropped they stay dropped, even back on the original origin.
  assert.deepEqual(calls[3].opts.headers, stripped);
  // The caller's object is not mutated.
  assert.equal(headers.Authorization, 'Bearer x');
});

test('cross-origin stripping also works for a Headers instance', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/t1': { status: 302, location: 'https://store.example/obj' },
    'https://store.example/obj': { status: 200 },
  });
  await fetchFollowingRedirects('https://core.example/t1', {
    headers: new Headers({ authorization: 'Bearer x', cookie: 'c=1', 'cf-access-client-id': 'id' }),
    fetchImpl,
  });
  assert.deepEqual(calls[1].opts.headers, { 'cf-access-client-id': 'id' });
});

test('cross-origin stripping also works for array-of-pairs headers', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/t1': { status: 302, location: 'https://store.example/obj' },
    'https://store.example/obj': { status: 200 },
  });
  const headers = [
    ['Authorization', 'Bearer x'],
    ['Proxy-Authorization', 'Basic y'],
    ['Cookie', 'c=1'],
    ['CF-Access-Client-Id', 'id'],
    ['CF-Access-Client-Secret', 's'],
    ['Accept', '*/*'],
  ];
  await fetchFollowingRedirects('https://core.example/t1', { headers, fetchImpl });
  assert.deepEqual(calls[0].opts.headers, headers);
  assert.deepEqual(calls[1].opts.headers, {
    'cf-access-client-id': 'id',
    'cf-access-client-secret': 's',
    accept: '*/*',
  });
});

test('same-origin redirect keeps every array-of-pairs header', async () => {
  const { calls, fetchImpl } = scripted({
    'https://core.example/t1': { status: 302, location: '/obj' },
    'https://core.example/obj': { status: 200 },
  });
  const headers = [['Authorization', 'Bearer x'], ['Cookie', 'c=1'], ['CF-Access-Client-Id', 'id']];
  await fetchFollowingRedirects('https://core.example/t1', { headers, fetchImpl });
  for (const c of calls) {
    assert.deepEqual(Object.fromEntries(new Headers(c.opts.headers)), {
      authorization: 'Bearer x', cookie: 'c=1', 'cf-access-client-id': 'id',
    });
  }
});
