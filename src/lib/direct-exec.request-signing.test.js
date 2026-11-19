// Server-side request signing on the plain direct path: a connection whose
// credential carries request_signing has every request signed by cws-core
// /sign (mocked here) and sends the returned URL with the same body bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invokeDirect } from './direct-exec.js';
import { requestSigningOf, mapSigningError, signWithRetry, validateSignResponse } from './request-signing.js';

const HOST = 'https://open-api.provider.example';
const def = (name, method, url, extra = {}) => {
  const [toolkit, action] = name.split('/');
  return { toolkit, action, method, url_template: url, input_schema: '', ...extra };
};
const SEARCH = def('shop_order/search_orders', 'POST', `${HOST}/order/202309/orders/search?shop_cipher={shop_cipher}&page_size={page_size}`);
const GET_SHOPS = def('shop_auth/get_authorized_shops', 'GET', `${HOST}/authorization/202309/shops`);
const SPEC = def('shop_order/spec_action', 'POST', `${HOST}/x`, { request_spec: { version: 1, encoding: 'json', body: { a: '{{params.a}}' } } });
const CATALOG = [SEARCH, GET_SHOPS, SPEC];
const INJ = { location: 'header', name: 'x-tts-access-token', value_template: '{token}' };

const signedCred = (extra = {}) => ({
  credential_mode: 'direct', token_type: 'bearer', access_token: 'TOKEN_SECRET', auth_injection: INJ,
  url_placeholders: { shop_cipher: 'CIPHER1' },
  request_signing: { scheme: 'tiktok_shop_v2', max_body_bytes: 1024 },
  ...extra,
});

function fakeFetch(responses = [{ status: 200, body: { code: 0 } }]) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    const text = JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(text);
    return {
      status: r.status,
      headers: new Map([['content-type', 'application/json'], ...(r.headers || [])]),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => text,
    };
  };
  return { impl, calls };
}

// Fake cws-core /sign: echoes the request URL with signer params appended.
function fakeSigner(outcomes = []) {
  const calls = [];
  const fn = async (orgId, connId, req) => {
    calls.push({ orgId, connId, req: JSON.parse(JSON.stringify(req)) });
    const o = outcomes[calls.length - 1];
    if (o instanceof Error) throw o;
    if (typeof o === 'function') return o(req);
    if (o) return o;
    const sep = req.url.includes('?') ? '&' : '?';
    return {
      url: `${req.url}${sep}app_key=AK&timestamp=1700000000&sign=SIGNATURE_HEX`,
      headers: {},
      expires_at: new Date(Date.now() + 240000).toISOString(),
      signed_params: { app_key: 'AK', timestamp: '1700000000', sign: 'SIGNATURE_HEX' },
    };
  };
  return { fn, calls };
}

const httpError = (status, code, message = 'refused') => Object.assign(new Error(message), {
  status, body: code ? { error: { code, detail: message } } : { error: { detail: message } },
});

function invoke({ actionSlug = 'shop_order/search_orders', params = { page_size: 10, order_status: 'UNPAID' }, credential = signedCred(), catalog = CATALOG } = {}, deps = {}) {
  return invokeDirect(
    { orgId: 'org-1', connection: { id: 'conn-1', applicationId: 'app', slug: 'whatever' }, actionSlug, params, catalog, credential },
    { audit: () => {}, ...deps },
  );
}

// ---------------------------------------------------------------------------

test('signing: requestSigningOf reads only a non-empty scheme', () => {
  assert.equal(requestSigningOf(null), null);
  assert.equal(requestSigningOf({}), null);
  assert.equal(requestSigningOf({ request_signing: {} }), null);
  assert.equal(requestSigningOf({ request_signing: { scheme: ' ' } }), null);
  assert.deepEqual(requestSigningOf({ request_signing: { scheme: 's', max_body_bytes: 10 } }), { scheme: 's', maxBodyBytes: 10 });
  assert.deepEqual(requestSigningOf({ request_signing: { scheme: 's' } }), { scheme: 's', maxBodyBytes: 0 });
});

test('signing: a connection without request_signing never calls /sign (unchanged flow)', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  const cred = signedCred();
  delete cred.request_signing;
  await invoke({ credential: cred }, { fetchImpl: impl, signRequest: signer.fn });
  assert.equal(signer.calls.length, 0);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes('sign='));
});

test('signing: the body is serialized once — the bytes signed are the bytes sent, to the URL the server returned', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  const res = await invoke({}, { fetchImpl: impl, signRequest: signer.fn });
  assert.equal(res.status_code, 200);
  assert.equal(signer.calls.length, 1);
  const { orgId, connId, req } = signer.calls[0];
  assert.equal(orgId, 'org-1');
  assert.equal(connId, 'conn-1');
  assert.equal(req.action, 'shop_order/search_orders');
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `${HOST}/order/202309/orders/search?shop_cipher=CIPHER1&page_size=10`);
  assert.equal(req.content_type, 'application/json');
  // The token is never sent to the signer.
  assert.ok(!JSON.stringify(req).includes('TOKEN_SECRET'));

  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, `${req.url}&app_key=AK&timestamp=1700000000&sign=SIGNATURE_HEX`, 'returned URL sent unchanged');
  assert.ok(Buffer.isBuffer(sent.opts.body));
  assert.ok(Buffer.from(req.body, 'base64').equals(sent.opts.body), 'same bytes signed and sent');
  assert.deepEqual(JSON.parse(sent.opts.body.toString('utf8')), { order_status: 'UNPAID' });
  assert.equal(sent.opts.headers['x-tts-access-token'], 'TOKEN_SECRET');
  assert.equal(sent.opts.headers.Authorization, undefined);
  assert.equal(sent.opts.redirect, 'manual');
});

test('signing: GET without a body sends no body / content_type to /sign', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  await invoke({ actionSlug: 'shop_auth/get_authorized_shops', params: {} }, { fetchImpl: impl, signRequest: signer.fn });
  const { req } = signer.calls[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined);
  assert.equal(req.content_type, undefined);
  assert.equal(calls[0].opts.body, undefined);
});

test('signing: server-returned headers are merged; the connection auth header still wins', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([(req) => ({ url: req.url, headers: { 'X-Sig': 'abc', 'x-tts-access-token': 'EVIL' } })]);
  await invoke({}, { fetchImpl: impl, signRequest: signer.fn });
  assert.equal(calls[0].opts.headers['X-Sig'], 'abc');
  assert.equal(calls[0].opts.headers['x-tts-access-token'], 'TOKEN_SECRET');
});

test('signing: a returned URL on another origin is refused by the local origin check — nothing sent', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([{ url: 'https://attacker.example/order/202309/orders/search?sign=x' }]);
  await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 403 && e.code === 'direct_origin_refused' && !/TOKEN_SECRET/.test(e.message));
  assert.equal(calls.length, 0);
});

test('signing: a malformed sign response is refused (502) — nothing sent', async () => {
  for (const bad of [() => null, {}, { url: '' }, { url: `${HOST}/x`, headers: { 'Bad Header': 'v' } }, { url: `${HOST}/x`, headers: { a: 'x\r\ny' } }, { url: `${HOST}/x`, expires_at: 'not-a-date' }]) {
    const { impl, calls } = fakeFetch();
    const signer = fakeSigner([bad, bad]);
    await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
      (e) => e.status === 502 && e.code === 'request_signing_invalid_response' && e.sent === false);
    assert.equal(calls.length, 0);
    assert.equal(signer.calls.length, 1, 'an invalid response is not retried');
  }
});

for (const [code, status, re] of [
  ['CONNECT_SIGNING_NOT_ENABLED', 422, /does not use request signing.*conn\.clear_cache/],
  ['CONNECT_REQUEST_NOT_IN_CATALOG', 400, /does not match this action.*conn\.catalog \{refresh:true\}/],
  ['CONNECT_BODY_TOO_LARGE', 400, /exceeds the signing limit/],
  ['CONNECT_SHOP_NOT_AUTHORIZED', 400, /get_authorized_shops.*shop_cipher/],
  ['CONNECT_CLIENT_UPGRADE_REQUIRED', 426, /upgrade the openmax plugin/],
]) {
  test(`signing: ${code} → clear error (${status}), not retried, nothing sent`, async () => {
    const { impl, calls } = fakeFetch();
    const httpStatus = code === 'CONNECT_SIGNING_NOT_ENABLED' || code === 'CONNECT_CLIENT_UPGRADE_REQUIRED' ? 422 : 400;
    const signer = fakeSigner([httpError(httpStatus, code), httpError(httpStatus, code)]);
    await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
      (e) => e.status === status && e.code === code && e.sent === false && re.test(e.message) && /Nothing was sent/.test(e.message));
    assert.equal(signer.calls.length, 1);
    assert.equal(calls.length, 0);
  });
}

test('signing: another server code (e.g. NOT_AUTHORIZED 403) keeps its status and code', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([httpError(403, 'CONNECT_NOT_AUTHORIZED', 'agent not bound')]);
  await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 403 && e.code === 'CONNECT_NOT_AUTHORIZED' && /agent not bound/.test(e.message));
  assert.equal(calls.length, 0);
});

test('signing: a sign route missing on an older server (404 without code) → request_signing_unsupported', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([httpError(404, '', 'Not Found')]);
  await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.code === 'request_signing_unsupported' && e.status === 501);
  assert.equal(calls.length, 0);
});

test('signing: a transient failure (503 / network) is retried once', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([httpError(503, '', 'unavailable')]);
  await invoke({}, { fetchImpl: impl, signRequest: signer.fn });
  assert.equal(signer.calls.length, 2);
  assert.equal(calls.length, 1);

  const f2 = fakeFetch();
  const s2 = fakeSigner([new TypeError('fetch failed'), httpError(502, '', 'bad gateway')]);
  await assert.rejects(() => invoke({}, { fetchImpl: f2.impl, signRequest: s2.fn }),
    (e) => e.status === 502 && e.sent === false && /Nothing was sent/.test(e.message));
  assert.equal(s2.calls.length, 2, 'retried exactly once');
  assert.equal(f2.calls.length, 0);
});

test('signing: an already-expired signature is re-signed once; expired twice → error, nothing sent', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner([(req) => ({ url: req.url, expires_at: past })]);
  await invoke({}, { fetchImpl: impl, signRequest: signer.fn });
  assert.equal(signer.calls.length, 2);
  assert.equal(calls.length, 1);

  const f2 = fakeFetch();
  const s2 = fakeSigner([(req) => ({ url: req.url, expires_at: past }), (req) => ({ url: req.url, expires_at: past })]);
  await assert.rejects(() => invoke({}, { fetchImpl: f2.impl, signRequest: s2.fn }), (e) => e.code === 'request_signing_expired');
  assert.equal(f2.calls.length, 0);
});

test('signing: a body over max_body_bytes is refused locally — /sign never called', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  await assert.rejects(() => invoke({ params: { page_size: 1, note: 'x'.repeat(2000) } }, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 400 && e.code === 'CONNECT_BODY_TOO_LARGE' && /1024/.test(e.message));
  assert.equal(signer.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('signing: a redirect is not followed — 3xx is an error after exactly one request', async () => {
  const { impl, calls } = fakeFetch([{ status: 302, headers: [['location', 'https://elsewhere.example/']] }]);
  const signer = fakeSigner();
  await assert.rejects(() => invoke({}, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.code === 'signed_request_redirected' && e.provider_status === 302);
  assert.equal(calls.length, 1);
});

test('signing: provider 401 → re-acquire once and the retry is signed again', async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: {} }, { status: 200, body: { code: 0 } }]);
  const signer = fakeSigner();
  let acquired = 0;
  const res = await invoke({}, {
    fetchImpl: impl, signRequest: signer.fn,
    acquire: async () => { acquired++; return signedCred({ access_token: 'TOKEN_SECRET_2' }); },
  });
  assert.equal(res.status_code, 200);
  assert.equal(acquired, 1);
  assert.equal(signer.calls.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers['x-tts-access-token'], 'TOKEN_SECRET_2');
});

test('signing: request_spec actions and _download fail closed (422) on a signing connection — nothing sent', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  await assert.rejects(() => invoke({ actionSlug: 'shop_order/spec_action', params: { a: 1 } }, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 422 && e.code === 'request_signing_unsupported_path');
  await assert.rejects(() => invoke({ params: { _download: { url: `${HOST}/file` } } }, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 422 && e.code === 'request_signing_unsupported_path');
  assert.equal(signer.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('signing: a query-placed credential cannot be combined with signing (422, nothing sent)', async () => {
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  const cred = signedCred({ auth_injection: { location: 'query', name: 'access_token', value_template: '{token}' } });
  await assert.rejects(() => invoke({ credential: cred }, { fetchImpl: impl, signRequest: signer.fn }),
    (e) => e.status === 422 && e.code === 'request_signing_unsupported_auth');
  assert.equal(signer.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('signing: without a signing client the call fails closed', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(() => invoke({}, { fetchImpl: impl }), (e) => e.code === 'request_signing_unavailable');
  assert.equal(calls.length, 0);
});

test('signing: audit lines carry no signature, signed query, body or token', async () => {
  const { impl } = fakeFetch();
  const signer = fakeSigner();
  const lines = [];
  await invoke({}, { fetchImpl: impl, signRequest: signer.fn, audit: (l) => lines.push(l) });
  assert.ok(lines.length >= 2);
  const all = lines.join('\n');
  assert.ok(!/SIGNATURE_HEX|sign=|TOKEN_SECRET|app_key=/.test(all), all);
  assert.ok(lines.some((l) => l.includes('signed (tiktok_shop_v2)') && l.includes(`${HOST}/order/202309/orders/search`)));
});

test('signing: the audit never carries params / body — only method, host, path and the status code', async () => {
  const { impl } = fakeFetch([{ status: 201, body: { code: 0 } }]);
  const signer = fakeSigner();
  const lines = [];
  await invoke({ params: { page_size: 10, buyer_email: 'a@b.c' } }, { fetchImpl: impl, signRequest: signer.fn, audit: (l) => lines.push(l) });
  const all = lines.join('\n');
  assert.ok(!/a@b\.c|buyer_email|params:/.test(all), all);
  assert.ok(!/\?|shop_cipher|page_size/.test(all), `no query in the audit: ${all}`);
  assert.ok(lines.some((l) => /\b201\b/.test(l) && l.includes('POST') && l.includes(`${HOST}/order/202309/orders/search`)), all);
});

test('signing: a Meta page-token exchange action fails closed (422) on a signing connection — /sign and the provider never called', async () => {
  const GRAPH_POST = def('meta_pages/create_page_post', 'POST', 'https://graph.facebook.com/v26.0/{page_id}/feed',
    { headers_template: { 'X-Openmax-Token-Exchange': 'meta_page:page_id' } });
  const { impl, calls } = fakeFetch();
  const signer = fakeSigner();
  const pageTokenCache = { get: () => null, set: () => {}, delete: () => {} };
  await assert.rejects(
    () => invoke({ actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: [GRAPH_POST] },
      { fetchImpl: impl, signRequest: signer.fn, pageTokenCache }),
    (e) => e.status === 422 && e.code === 'request_signing_unsupported_path' && e.sent === false && !/TOKEN_SECRET/.test(e.message));
  assert.equal(signer.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('signing: mapSigningError / signWithRetry / validateSignResponse unit behaviour', async () => {
  const e = mapSigningError(httpError(400, 'CONNECT_BODY_TOO_LARGE'), { maxBodyBytes: 10, bodyBytes: 20 });
  assert.match(e.message, /\(20 bytes\).*of 10 bytes/);
  assert.equal(validateSignResponse({ url: 'https://h/x' }).expiresAtMs, null);
  let n = 0;
  await assert.rejects(() => signWithRetry(async () => { n++; throw httpError(400, ''); }, {}), (err) => err.status === 400);
  assert.equal(n, 1, '4xx not retried');
});
