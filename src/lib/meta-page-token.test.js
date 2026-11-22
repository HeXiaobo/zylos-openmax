import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assembleRequest, invokeDirect } from './direct-exec.js';
import {
  PageTokenCache,
  FilePageTokenCache,
  defaultPageTokenCache,
  parseExchangeMarker,
  validateGraphId,
  graphVersionOf,
  TOKEN_EXCHANGE_HEADER,
} from './meta-page-token.js';
import {
  CREDENTIALS_DIR,
  pageTokensPath,
  saveCredentialCache,
  listCachedCredentials,
  clearCachedCredentials,
  readCredentialCache,
  deleteCredentialCache,
  isCredentialFile,
} from './credential-cache.js';

const USER_TOKEN = 'EAAUSERTOKEN_0123456789_secret_user';
const PAGE_TOKEN = 'EAAPAGETOKEN_0123456789_secret_page';
const PAGE_TOKEN_2 = 'EAAPAGETOKEN_2_ABCDEFGHIJ_secret_page2';
const IG_PAGE_TOKEN = 'EAAIGPAGETOKEN_9876543210_secret_igpage';

const CRED = { credential_mode: 'direct', token_type: 'bearer', access_token: USER_TOKEN };
const CONN = { id: 'conn-meta-1', applicationId: 'app-meta', slug: 'meta' };

const CREATE_POST = {
  toolkit: 'meta_pages',
  action: 'create_page_post',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{page_id}/feed',
  headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_page:page_id' },
  input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};
const CREATE_COMMENT = {
  toolkit: 'meta_pages',
  action: 'create_comment',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{object_id}/comments',
  headers_template: { 'x-openmax-token-exchange': 'meta_page:page_id' },
  input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};
const IG_PRIVATE_REPLY = {
  toolkit: 'meta_messaging',
  action: 'send_ig_private_reply',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{ig_user_id}/messages',
  headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_ig_page:ig_user_id' },
  input_schema: { type: 'object', properties: { recipient: { type: 'object' }, message: { type: 'object' } } },
};
const ME = {
  toolkit: 'meta_account',
  action: 'me',
  method: 'GET',
  url_template: 'https://graph.facebook.com/v26.0/me?fields=id,name',
  input_schema: '',
};
const CATALOG = [CREATE_POST, CREATE_COMMENT, IG_PRIVATE_REPLY, ME];

// Router fetch double: `routes` is a list of [predicate(url, opts), response]
// or [predicate, response[]] (consumed in order, last one sticks). Records calls.
function routerFetch(routes) {
  const calls = [];
  const queues = routes.map(([, r]) => (Array.isArray(r) ? [...r] : [r]));
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const i = routes.findIndex(([pred]) => pred(url, opts));
    if (i < 0) throw new Error(`unexpected fetch ${opts.method} ${url}`);
    const q = queues[i];
    const r = q.length > 1 ? q.shift() : q[0];
    const text = JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(text);
    return {
      status: r.status ?? 200,
      headers: new Map([['content-type', 'application/json']]),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => text,
    };
  };
  return { impl, calls };
}

const isExchange = (id) => (u) => u === `https://graph.facebook.com/v26.0/${id}?fields=access_token`;
const isAccounts = (u) => u.startsWith('https://graph.facebook.com/v26.0/me/accounts?');
const isFeed = (id) => (u, o) => u === `https://graph.facebook.com/v26.0/${id}/feed` && o.method === 'POST';
const authOf = (call) => call.opts.headers.Authorization;

function sink() {
  const lines = [];
  const fn = (l) => { lines.push(String(l)); };
  return { lines, fn };
}

function deps(fetchImpl, extra = {}) {
  const logs = sink();
  return {
    logs,
    d: {
      fetchImpl,
      pageTokenCache: new PageTokenCache(),
      audit: logs.fn,
      log: logs.fn,
      warn: logs.fn,
      ...extra,
    },
  };
}

function assertNoTokens(texts) {
  for (const t of texts) {
    for (const secret of [USER_TOKEN, PAGE_TOKEN, PAGE_TOKEN_2, IG_PAGE_TOKEN]) {
      assert.ok(!String(t).includes(secret), `secret leaked into: ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------

test('B2 marker absent → unchanged: user token, single call, no exchange', async () => {
  const f = routerFetch([[(u) => u.startsWith('https://graph.facebook.com/v26.0/me?'), { body: { id: '1', name: 'u' } }]]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_account/me', params: {}, catalog: CATALOG, credential: CRED }, d);
  assert.equal(r.status_code, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(authOf(f.calls[0]), `Bearer ${USER_TOKEN}`);
});

test('B2 exchange success: derives page token on Graph, sends real call with Bearer <page token>', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN, id: '111' } }],
    [isFeed('111'), { body: { id: '111_999' } }],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({
    orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post',
    params: { page_id: '111', message: 'hello' }, catalog: CATALOG, credential: CRED,
  }, d);
  assert.deepEqual(r.body, { id: '111_999' });
  assert.equal(f.calls.length, 2);
  // exchange: fixed Graph origin, user token, redirects not followed
  assert.equal(authOf(f.calls[0]), `Bearer ${USER_TOKEN}`);
  assert.equal(f.calls[0].opts.redirect, 'manual');
  // real call: page token REPLACES the user token; no access_token param anywhere
  assert.equal(authOf(f.calls[1]), `Bearer ${PAGE_TOKEN}`);
  assert.ok(!f.calls[1].url.includes('access_token'));
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { message: 'hello' });
});

test('B2 marker header is stripped before sending (any case), never reaches the provider', async () => {
  // assembleRequest alone
  const a = assembleRequest(CREATE_COMMENT, { object_id: '1_2', page_id: '1', message: 'x' }, 'tok');
  assert.ok(!Object.keys(a.headers).some((h) => h.toLowerCase() === 'x-openmax-token-exchange'));
  // end to end
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d } = deps(f.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  for (const c of f.calls) {
    assert.ok(!Object.keys(c.opts.headers).some((h) => h.toLowerCase() === 'x-openmax-token-exchange'));
  }
});

test('B2 page_id not used by the URL (object-keyed action) is consumed, not sent in the body', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [(u) => u === 'https://graph.facebook.com/v26.0/111_222/comments', { body: { id: 'c1' } }],
  ]);
  const { d } = deps(f.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_comment', params: { object_id: '111_222', page_id: '111', message: 'hi' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(authOf(f.calls[1]), `Bearer ${PAGE_TOKEN}`);
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { message: 'hi' });
});

test('B2 cache hit: a second invoke for the same (connection, user token, page) skips the exchange', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d, logs } = deps(f.impl);
  const call = () => invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  await call();
  await call();
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 1);
  assert.equal(f.calls.length, 3);
  assert.equal(authOf(f.calls[2]), `Bearer ${PAGE_TOKEN}`);
  assert.ok(logs.lines.some((l) => l.includes('cache hit')));
  // a different user token (refreshed/reconnected) does NOT reuse the entry
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: { ...CRED, access_token: 'EAAOTHERUSER_xxxxxxxxxx' } }, d);
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 2);
});

test('B2 cache TTL: an expired entry is re-derived', async () => {
  let t = 1_000_000;
  const cache = new PageTokenCache({ ttlMs: 1000, now: () => t });
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d } = deps(f.impl, { pageTokenCache: cache });
  const call = () => invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  await call();
  t += 1001;
  await call();
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 2);
});

test('B2 Graph 190 on the real call → invalidate, re-derive, retry ONCE', async () => {
  const f = routerFetch([
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, { body: { access_token: PAGE_TOKEN_2 } }]],
    [isFeed('111'), [
      { status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } } },
      { body: { id: 'ok' } },
    ]],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.deepEqual(r.body, { id: 'ok' });
  assert.deepEqual(f.calls.map((c) => authOf(c)), [
    `Bearer ${USER_TOKEN}`, `Bearer ${PAGE_TOKEN}`, `Bearer ${USER_TOKEN}`, `Bearer ${PAGE_TOKEN_2}`,
  ]);
  // the retried token is now the cached one
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(authOf(f.calls[4]), `Bearer ${PAGE_TOKEN_2}`);
});

test('B2 Graph 190 twice → surfaced after one retry (no loop)', async () => {
  const err190 = { status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'expired' } } };
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), err190],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(r.status_code, 400);
  assert.equal(r.body.error.code, 190);
  assert.equal(f.calls.length, 4); // exchange, call, re-exchange, retry
});

test('B2 Graph 190 on the exchange (user token invalid) → one credential re-acquire, then retry', async () => {
  const fresh = { ...CRED, access_token: 'EAAFRESHUSER_zzzzzzzzzz' };
  const f = routerFetch([
    [(u, o) => isExchange('111')(u) && o.headers.Authorization === `Bearer ${USER_TOKEN}`, { status: 400, body: { error: { code: 190, message: 'Session has expired' } } }],
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'ok' } }],
  ]);
  let acquired = 0;
  const { d } = deps(f.impl, { acquire: async () => { acquired += 1; return fresh; }, saveCache: () => {} });
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.deepEqual(r.body, { id: 'ok' });
  assert.equal(acquired, 1);
  // without acquire the 401 is surfaced with a clear message
  const f2 = routerFetch([[isExchange('111'), { status: 400, body: { error: { code: 190, message: 'Session has expired' } } }]]);
  const { d: d2 } = deps(f2.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2),
    (e) => e.status === 401 && /re-authorized/.test(e.message),
  );
});

test('B2 non-numeric / unsafe page_id rejected before any network call', async () => {
  for (const bad of ['abc', '111/../me', '111?x=1', '', '1 1', 2 ** 60, -1, { id: 1 }, undefined]) {
    const f = routerFetch([]);
    const { d } = deps(f.impl);
    await assert.rejects(
      invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: bad, message: 'm' }, catalog: CATALOG, credential: CRED }, d),
      (e) => e.status === 400 && /page_id/.test(e.message),
      `expected 400 for ${String(bad)}`,
    );
    assert.equal(f.calls.length, 0);
  }
  assert.equal(validateGraphId(12345, 'page_id'), '12345');
});

test('B2 no access to the Page → clear 403 for the LLM, no real call', async () => {
  const f = routerFetch([[isExchange('222'), { body: { id: '222' } }]]); // no access_token field
  const { d } = deps(f.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '222', message: 'm' }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 403 && /Facebook Page 222/.test(e.message) && /meta_account\/list_pages/.test(e.message),
  );
  assert.equal(f.calls.length, 1);
  // Graph permission error is surfaced with its code
  const f2 = routerFetch([[isExchange('222'), { status: 400, body: { error: { code: 100, type: 'GraphMethodException', message: 'Unsupported get request' } } }]]);
  const { d: d2 } = deps(f2.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '222', message: 'm' }, catalog: CATALOG, credential: CRED }, d2),
    (e) => e.status === 403 && /code 100/.test(e.message),
  );
});

test('B2 IG: page resolved from ig_user_id via paginated /me/accounts, then cached', async () => {
  const IG = '17841400000000001'; // 17 digits — must stay a string
  const f = routerFetch([
    [(u) => isAccounts(u) && !u.includes('after='), { body: {
      data: [{ id: '301', access_token: PAGE_TOKEN, instagram_business_account: { id: '17841400000000999' } }],
      paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/v26.0/me/accounts?after=CUR1' },
    } }],
    [(u) => isAccounts(u) && u.includes('after=CUR1'), { body: {
      data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: IG } }],
      paging: { cursors: { after: 'CUR2' } },
    } }],
    [(u) => u === `https://graph.facebook.com/v26.0/${IG}/messages`, { body: { recipient_id: 'x' } }],
  ]);
  const { d } = deps(f.impl);
  const params = { ig_user_id: IG, recipient: { comment_id: '9' }, message: { text: 'hi' } };
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, d);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[0].url.includes('fields=id,access_token,instagram_business_account'));
  assert.equal(authOf(f.calls[2]), `Bearer ${IG_PAGE_TOKEN}`);
  assert.deepEqual(JSON.parse(f.calls[2].opts.body), { recipient: { comment_id: '9' }, message: { text: 'hi' } });
  // cached: no further /me/accounts
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, d);
  assert.equal(f.calls.filter((c) => isAccounts(c.url)).length, 2);
  // the side-cached page 301 serves a meta_page action without an exchange
  const f2calls = f.calls.length;
  await assert.rejects(invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '301', message: 'm' }, catalog: CATALOG, credential: CRED }, d), /unexpected fetch POST https:\/\/graph.facebook.com\/v26.0\/301\/feed/);
  assert.equal(f.calls.length, f2calls + 1); // only the (unrouted) real call, no exchange
});

test('B2 IG: no linked Page → 403; number ig_user_id beyond safe integer → 400', async () => {
  const f = routerFetch([[isAccounts, { body: { data: [{ id: '301', access_token: PAGE_TOKEN }], paging: {} } }]]);
  const { d } = deps(f.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: '17841400000000001' }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 403 && /Instagram account 17841400000000001/.test(e.message),
  );
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: 17841400000000001 }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 400 && /string/.test(e.message),
  );
});

test('B2 fail closed: unknown marker kind / non-Graph action → 422, no network', async () => {
  const f = routerFetch([]);
  const { d } = deps(f.impl);
  const unknown = { ...CREATE_POST, action: 'u', headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_business:page_id' } };
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/u', params: { page_id: '1', message: 'm' }, catalog: [unknown], credential: CRED }, d),
    (e) => e.status === 422,
  );
  const evil = { ...CREATE_POST, action: 'evil', url_template: 'https://attacker.example/{page_id}' };
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/evil', params: { page_id: '1', message: 'm' }, catalog: [evil], credential: CRED }, d),
    (e) => e.status === 422 && /graph\.facebook\.com/.test(e.message),
  );
  assert.equal(f.calls.length, 0);
  assert.throws(() => parseExchangeMarker('meta_page'), (e) => e.status === 422);
  assert.deepEqual(parseExchangeMarker(' meta_page : page_id '), { kind: 'meta_page', param: 'page_id' });
});

test('B2 Graph version follows the action template', () => {
  assert.equal(graphVersionOf('https://graph.facebook.com/v27.0/{page_id}/feed'), 'v27.0');
  assert.equal(graphVersionOf('https://example.com/x'), 'v26.0');
});

test('B2 tokens never appear in audit/log lines or error messages', async () => {
  // Graph echoes the token in an error message → scrubbed in our error
  const f = routerFetch([[isExchange('111'), { status: 400, body: { error: { code: 200, message: `bad token ${USER_TOKEN}` } } }]]);
  const { d, logs } = deps(f.impl);
  let err;
  try {
    await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  } catch (e) { err = e; }
  assert.ok(err);
  assertNoTokens([err.message, ...logs.lines]);

  // success + cache hit + 190 retry + IG paths: nothing in logs either
  const f2 = routerFetch([
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, { body: { access_token: PAGE_TOKEN_2 } }]],
    [isFeed('111'), [{ status: 400, body: { error: { code: 190, message: 'x' } } }, { body: { id: 'ok' } }]],
    [isAccounts, { body: { data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: '178414' } }] } }],
    [(u) => u.endsWith('/178414/messages'), { body: {} }],
  ]);
  const { d: d2, logs: logs2 } = deps(f2.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: '178414' }, catalog: CATALOG, credential: CRED }, d2);
  assert.ok(logs2.lines.length > 0);
  assertNoTokens(logs2.lines);
});

// ---------------------------------------------------------------------------
// File-backed page-token cache (persists across one-shot conn.invoke processes)
// ---------------------------------------------------------------------------

// A credentials dir holding CONN's credential file (page tokens are only
// persisted while the credential they derive from is still on disk). The dir is
// created 0755 under a fresh tmp parent so the 0700 assertion below is
// meaningful: only the code under test can tighten it.
function tmpCredDir({ cred = CRED } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-tokens-')), 'credentials');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  if (cred) fs.writeFileSync(path.join(dir, `${CONN.id}.json`), JSON.stringify(cred));
  return dir;
}
const postTo = (page) => ({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: page, message: 'm' }, catalog: CATALOG, credential: CRED });

test('B2 file cache: conn.invoke default is the file-backed cache under CREDENTIALS_DIR', () => {
  assert.ok(defaultPageTokenCache instanceof FilePageTokenCache);
  assert.equal(defaultPageTokenCache.dir, CREDENTIALS_DIR);
});

test('B2 file cache: a second cache instance (= next conn.invoke process) reuses the page token, zero exchange fetches', async () => {
  const dir = tmpCredDir();
  const f1 = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p1' } }],
  ]);
  await invokeDirect(postTo('111'), deps(f1.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  assert.equal(f1.calls.filter((c) => isExchange('111')(c.url)).length, 1);

  const file = pageTokensPath(CONN.id, dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'page-token file must be 0600');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'dir (created 0755) must be tightened to 0700');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 1);
  const [entry] = Object.values(stored.entries);
  assert.equal(entry.value, PAGE_TOKEN);
  assert.equal(typeof entry.expiresAt, 'number');
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'no tmp file left behind');

  // fresh instance, fresh fetch double: only the real call goes out
  const f2 = routerFetch([[isFeed('111'), { body: { id: 'p2' } }]]);
  const { d, logs } = deps(f2.impl, { pageTokenCache: new FilePageTokenCache({ dir }) });
  const r = await invokeDirect(postTo('111'), d);
  assert.deepEqual(r.body, { id: 'p2' });
  assert.equal(f2.calls.length, 1);
  assert.equal(authOf(f2.calls[0]), `Bearer ${PAGE_TOKEN}`);
  assert.ok(logs.lines.some((l) => l.includes('cache hit')));
  assertNoTokens(logs.lines);
});

test('B2 file cache: IG→Page mapping survives across instances too', async () => {
  const dir = tmpCredDir();
  const IG = '17841400000000001';
  const f1 = routerFetch([
    [isAccounts, { body: { data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: IG } }] } }],
    [(u) => u.endsWith(`/${IG}/messages`), { body: {} }],
  ]);
  const params = { ig_user_id: IG };
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, deps(f1.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  const f2 = routerFetch([[(u) => u.endsWith(`/${IG}/messages`), { body: {} }]]);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, deps(f2.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  assert.equal(f2.calls.length, 1);
  assert.equal(authOf(f2.calls[0]), `Bearer ${IG_PAGE_TOKEN}`);
});

test('B2 file cache: TTL — an expired entry is ignored and pruned on the next write', async () => {
  const dir = tmpCredDir();
  let t = 1_000_000;
  const mk = () => new FilePageTokenCache({ dir, ttlMs: 1000, now: () => t });
  const c = mk();
  const k1 = c.key(CONN.id, USER_TOKEN, 'page', '111');
  const k2 = c.key(CONN.id, USER_TOKEN, 'page', '222');
  c.set(k1, PAGE_TOKEN);
  assert.equal(mk().get(k1), PAGE_TOKEN);
  t += 1001;
  assert.equal(mk().get(k1), null);
  mk().set(k2, PAGE_TOKEN_2);
  const stored = JSON.parse(fs.readFileSync(pageTokensPath(CONN.id, dir), 'utf8'));
  assert.deepEqual(Object.keys(stored.entries), [k2]);

  // through invokeDirect: expired → re-derived
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  await invokeDirect(postTo('111'), deps(f.impl, { pageTokenCache: mk() }).d);
  t += 1001;
  await invokeDirect(postTo('111'), deps(f.impl, { pageTokenCache: mk() }).d);
  assert.equal(f.calls.filter((c2) => isExchange('111')(c2.url)).length, 2);
});

test('B2 file cache: Graph 190 invalidation removes the entry from the file; next process re-derives', async () => {
  const dir = tmpCredDir();
  const seed = new FilePageTokenCache({ dir });
  const k = seed.key(CONN.id, USER_TOKEN, 'page', '111');
  seed.set(k, PAGE_TOKEN); // stale token persisted by an earlier process
  seed.set(seed.key(CONN.id, USER_TOKEN, 'page', '222'), PAGE_TOKEN_2);

  const f = routerFetch([
    [isExchange('111'), { status: 400, body: { error: { code: 100, message: 'nope' } } }],
    [isFeed('111'), { status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'expired' } } }],
  ]);
  await assert.rejects(invokeDirect(postTo('111'), deps(f.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d), (e) => e.status === 403);
  const stored = JSON.parse(fs.readFileSync(pageTokensPath(CONN.id, dir), 'utf8'));
  assert.ok(!(k in stored.entries), 'invalidated entry removed from the file');
  assert.equal(Object.keys(stored.entries).length, 1, 'other entries kept');
  assert.equal(new FilePageTokenCache({ dir }).get(k), null);

  // removing the last entry removes the file
  const c = new FilePageTokenCache({ dir });
  c.delete(c.key(CONN.id, USER_TOKEN, 'page', '222'));
  assert.equal(fs.existsSync(pageTokensPath(CONN.id, dir)), false);
});

test('B2 file cache: corrupted / malformed file is tolerated (miss, then overwritten)', async () => {
  const dir = tmpCredDir();
  const file = pageTokensPath(CONN.id, dir);
  fs.writeFileSync(file, '{not json', { mode: 0o600 });
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const r = await invokeDirect(postTo('111'), deps(f.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  assert.deepEqual(r.body, { id: 'p' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);

  const c = new FilePageTokenCache({ dir });
  const k = c.key(CONN.id, USER_TOKEN, 'page', '111');
  for (const bad of ['null', '[]', '{"entries":"x"}', JSON.stringify({ entries: { [k]: { value: 42, expiresAt: Date.now() + 1e6 } } }),
    JSON.stringify({ entries: { [k]: { value: PAGE_TOKEN } } })]) {
    fs.writeFileSync(file, bad);
    assert.equal(c.get(k), null, `malformed ${bad} must be a miss`);
  }
});

test('B2 file cache: IO failure never fails the invoke (unwritable dir → falls back to exchanging)', async () => {
  const base = tmpCredDir();
  const notADir = path.join(base, 'file');
  fs.writeFileSync(notADir, 'x');
  const cache = new FilePageTokenCache({ dir: path.join(notADir, 'sub') });
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const d = deps(f.impl, { pageTokenCache: cache }).d;
  assert.deepEqual((await invokeDirect(postTo('111'), d)).body, { id: 'p' });
  assert.deepEqual((await invokeDirect(postTo('111'), d)).body, { id: 'p' });
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 2);
});

test('B2 file cache: unsafe connection id is never used as a file name', () => {
  const dir = tmpCredDir();
  const c = new FilePageTokenCache({ dir });
  const k = c.key('../evil', USER_TOKEN, 'page', '111');
  c.set(k, PAGE_TOKEN);
  assert.equal(c.get(k), null);
  assert.deepEqual(fs.readdirSync(dir), [`${CONN.id}.json`]);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.page-tokens.json')), false);
});

test('B2 file cache: credential readers ignore the page-token file; clear_cache removes it', () => {
  const dir = tmpCredDir();
  saveCredentialCache(CONN.id, CRED, 'meta', dir);
  const c = new FilePageTokenCache({ dir });
  c.set(c.key(CONN.id, USER_TOKEN, 'page', '111'), PAGE_TOKEN);
  // an orphan page-token file (no credential) left by an older build
  fs.writeFileSync(pageTokensPath('conn-orphan', dir), JSON.stringify({ version: 1, entries: {} }));

  const listed = listCachedCredentials(dir);
  assert.deepEqual(listed.map((e) => e.connection_id), [CONN.id]);
  assert.ok(!listed.some((e) => e.error));
  assert.equal(readCredentialCache(CONN.id, dir).access_token, USER_TOKEN);

  // clear one connection: credential + its page tokens
  assert.deepEqual(clearCachedCredentials(CONN.id, dir), [CONN.id]);
  assert.equal(fs.existsSync(pageTokensPath(CONN.id, dir)), false);
  assert.equal(fs.existsSync(pageTokensPath('conn-orphan', dir)), true);

  // clear all: page-token files go too
  saveCredentialCache(CONN.id, CRED, 'meta', dir);
  c.set(c.key(CONN.id, USER_TOKEN, 'page', '111'), PAGE_TOKEN);
  assert.deepEqual(clearCachedCredentials(undefined, dir).sort(), [CONN.id, 'conn-orphan'].sort());
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---------------------------------------------------------------------------
// #225 review: no stale page-token writes after revoke / re-auth
// ---------------------------------------------------------------------------

// Wrap a routerFetch so requests matching `pred` wait until release() is called.
function gatedFetch(inner, pred) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const started = new Promise((r) => { entered = r; });
  const impl = async (url, opts) => {
    if (pred(url, opts)) { entered(); await gate; }
    return inner(url, opts);
  };
  return { impl, release, started };
}

test('B2 file cache: credential deleted while the exchange is in flight → no page-token file afterwards', async () => {
  const dir = tmpCredDir();
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const g = gatedFetch(f.impl, isExchange('111'));
  const pending = invokeDirect(postTo('111'), deps(g.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  await g.started;
  deleteCredentialCache(CONN.id, dir); // comm-bridge: revoke / needs_reauth
  g.release();
  await pending;
  assert.equal(fs.existsSync(pageTokensPath(CONN.id, dir)), false, 'page token must not be written back');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('B2 file cache: credential deleted while /me/accounts is in flight (IG setMany) → nothing written', async () => {
  const dir = tmpCredDir();
  const IG = '17841400000000001';
  const f = routerFetch([
    [isAccounts, { body: { data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: IG } }] } }],
    [(u) => u.endsWith(`/${IG}/messages`), { body: {} }],
  ]);
  const g = gatedFetch(f.impl, isAccounts);
  const pending = invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: IG }, catalog: CATALOG, credential: CRED },
    deps(g.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  await g.started;
  deleteCredentialCache(CONN.id, dir);
  g.release();
  await pending;
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('B2 file cache: user token rewritten (re-auth) while the exchange is in flight → no write, old file dropped', async () => {
  const dir = tmpCredDir();
  // an earlier process persisted page tokens derived from the old user token
  const seed = new FilePageTokenCache({ dir });
  seed.set(seed.key(CONN.id, USER_TOKEN, 'page', '222'), PAGE_TOKEN_2);
  assert.equal(fs.existsSync(pageTokensPath(CONN.id, dir)), true);

  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const g = gatedFetch(f.impl, isExchange('111'));
  const pending = invokeDirect(postTo('111'), deps(g.impl, { pageTokenCache: new FilePageTokenCache({ dir }) }).d);
  await g.started;
  saveCredentialCache(CONN.id, { ...CRED, access_token: 'EAANEWUSERTOKEN_after_reauth_xyz' }, 'meta', dir);
  g.release();
  await pending;
  assert.equal(fs.existsSync(pageTokensPath(CONN.id, dir)), false, 'no page token derived from the old user token survives');
  assert.deepEqual(fs.readdirSync(dir), [`${CONN.id}.json`]);
});

test('B2 file cache: a write is refused when the credential is gone, and when its token does not match the key', () => {
  const dir = tmpCredDir({ cred: null });
  const c = new FilePageTokenCache({ dir });
  c.set(c.key(CONN.id, USER_TOKEN, 'page', '111'), PAGE_TOKEN);
  assert.deepEqual(fs.readdirSync(dir), []);

  saveCredentialCache(CONN.id, CRED, 'meta', dir);
  c.setMany([
    [c.key(CONN.id, 'EAAOTHERUSERTOKEN_not_live_123', 'page', '111'), PAGE_TOKEN],
    [c.key(CONN.id, USER_TOKEN, 'page', '222'), PAGE_TOKEN_2],
  ]);
  const stored = JSON.parse(fs.readFileSync(pageTokensPath(CONN.id, dir), 'utf8'));
  assert.deepEqual(Object.keys(stored.entries), [c.key(CONN.id, USER_TOKEN, 'page', '222')], 'only entries of the live user token are kept');
});

test('B2 file cache: credential vanishing between write and rename / right after rename leaves no page-token file', () => {
  for (const vanishAt of [2, 3]) { // 1 = pre-write check, 2 = pre-rename, 3 = post-rename
    const dir = tmpCredDir();
    const c = new FilePageTokenCache({ dir });
    let n = 0;
    const real = c.liveUserTokenHash.bind(c);
    c.liveUserTokenHash = (id) => {
      n += 1;
      if (n === vanishAt) deleteCredentialCache(id, dir);
      return real(id);
    };
    c.set(c.key(CONN.id, USER_TOKEN, 'page', '111'), PAGE_TOKEN);
    assert.deepEqual(fs.readdirSync(dir), [], `vanish at check ${vanishAt}: nothing left (no tmp either)`);
  }
});

test('B2 file cache: leftover tmp files are ignored by readers and removed by delete / clear / clear-all', () => {
  const dir = tmpCredDir();
  const tmpOf = (id) => `${pageTokensPath(id, dir)}.4242.deadbeef.tmp`;
  const touch = (f) => fs.writeFileSync(f, JSON.stringify({ version: 1, entries: { x: { value: PAGE_TOKEN, expiresAt: Date.now() + 1e6 } } }));

  // readers
  touch(tmpOf(CONN.id));
  assert.equal(isCredentialFile(path.basename(tmpOf(CONN.id))), false);
  assert.deepEqual(listCachedCredentials(dir).map((e) => e.connection_id), [CONN.id]);

  // deleteCredentialCache (revoke / needs_reauth) — other connections' tmp untouched
  touch(tmpOf('conn-other'));
  deleteCredentialCache(CONN.id, dir);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(tmpOf('conn-other'))]);

  // clear one connection
  saveCredentialCache(CONN.id, CRED, 'meta', dir);
  touch(tmpOf(CONN.id));
  assert.deepEqual(clearCachedCredentials(CONN.id, dir), [CONN.id]);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(tmpOf('conn-other'))]);

  // clear all
  saveCredentialCache(CONN.id, CRED, 'meta', dir);
  touch(tmpOf(CONN.id));
  assert.deepEqual(clearCachedCredentials(undefined, dir).sort(), [CONN.id, 'conn-other'].sort());
  assert.deepEqual(fs.readdirSync(dir), []);

  // FilePageTokenCache.clear() too
  touch(tmpOf(CONN.id));
  new FilePageTokenCache({ dir }).clear();
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---------------------------------------------------------------------------
// #225 review: the main request carrying a Page token never follows redirects
// ---------------------------------------------------------------------------

test('B2 main request with a Page token is sent with redirect:"manual"; a 3xx is returned as-is', async () => {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (isExchange('111')(url)) {
      const text = JSON.stringify({ access_token: PAGE_TOKEN });
      return { status: 200, headers: new Map([['content-type', 'application/json']]), body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), text: async () => text };
    }
    return { status: 302, headers: new Map([['location', 'https://evil.example/steal'], ['content-type', 'text/plain']]), body: new ReadableStream({ start(c) { c.close(); } }), text: async () => '' };
  };
  const r = await invokeDirect(postTo('111'), deps(impl).d);
  assert.equal(r.status_code, 302);
  assert.equal(r.headers.location, 'https://evil.example/steal');
  assert.equal(calls.length, 2, 'exchange + main call only; the redirect is not followed');
  assert.equal(calls[1].opts.redirect, 'manual');
  assert.equal(calls[1].opts.headers.Authorization, `Bearer ${PAGE_TOKEN}`);

  // an unmarked action also uses redirect:"manual" on the wire; the executor
  // follows redirects itself (credential headers dropped off-origin)
  const f = routerFetch([[(u) => u.endsWith('/me?fields=id,name'), { body: { id: '1' } }]]);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_account/me', params: {}, catalog: CATALOG, credential: CRED }, deps(f.impl).d);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.redirect, 'manual');
});

// ---------------------------------------------------------------------------
// #225 review: forced re-derive after a page-token 190 goes through the same
// user-token-190 → refresh-once handling as the first send
// ---------------------------------------------------------------------------

test('B2 page token 190 → forced re-derive hits user-token 190 → credential refreshed once, then success', async () => {
  const fresh = { ...CRED, access_token: 'EAAFRESHUSER_zzzzzzzzzz' };
  const err190 = (m) => ({ status: 400, body: { error: { code: 190, type: 'OAuthException', message: m } } });
  const f = routerFetch([
    // old user token: first exchange works, the re-derive is rejected
    [(u, o) => isExchange('111')(u) && o.headers.Authorization === `Bearer ${USER_TOKEN}`, [{ body: { access_token: PAGE_TOKEN } }, err190('Session has expired')]],
    [(u, o) => isExchange('111')(u) && o.headers.Authorization === `Bearer ${fresh.access_token}`, { body: { access_token: PAGE_TOKEN_2 } }],
    [(u, o) => isFeed('111')(u, o) && o.headers.Authorization === `Bearer ${PAGE_TOKEN}`, err190('page token invalid')],
    [isFeed('111'), { body: { id: 'ok' } }],
  ]);
  let acquired = 0;
  const { d } = deps(f.impl, { acquire: async () => { acquired += 1; return fresh; }, saveCache: () => {} });
  const r = await invokeDirect(postTo('111'), d);
  assert.deepEqual(r.body, { id: 'ok' });
  assert.equal(acquired, 1);
  assert.equal(authOf(f.calls.at(-1)), `Bearer ${PAGE_TOKEN_2}`);

  // without acquire: the forced re-derive's 401 is surfaced (no unhandled path)
  const f2 = routerFetch([
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, err190('Session has expired')]],
    [isFeed('111'), err190('page token invalid')],
  ]);
  await assert.rejects(invokeDirect(postTo('111'), deps(f2.impl).d), (e) => e.status === 401 && /re-authorized/.test(e.message));
});

test('B2 refresh budget is shared: exchange 190 refreshed once, forced re-derive 190 again → surfaced, no second acquire', async () => {
  const fresh = { ...CRED, access_token: 'EAAFRESHUSER_zzzzzzzzzz' };
  const err190 = (m) => ({ status: 400, body: { error: { code: 190, message: m } } });
  const f = routerFetch([
    [(u, o) => isExchange('111')(u) && o.headers.Authorization === `Bearer ${USER_TOKEN}`, err190('expired')],
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, err190('expired again')]],
    [isFeed('111'), err190('page token invalid')],
  ]);
  let acquired = 0;
  const { d } = deps(f.impl, { acquire: async () => { acquired += 1; return fresh; }, saveCache: () => {} });
  await assert.rejects(invokeDirect(postTo('111'), d), (e) => e.status === 401 && e.graphTokenInvalid);
  assert.equal(acquired, 1);
});
