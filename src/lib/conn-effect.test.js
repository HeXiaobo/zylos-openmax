import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyEffect, classifyGraphqlDocument, composioWords, canonicalJson, paramsDigest,
  appendEffectLog, readEffectLog, summarizeEffectLog, buildEffectLogRecord,
} from './conn-effect.js';

// Real request_spec snippets from cws-connect seeds (000120 / 000121 / 000122).
const SPEC_PRODUCTS_LIST = {
  version: 1, requires: ['body_template'], encoding: 'json', unmapped_params: 'reject',
  body: { query: 'query ProductsList($first: Int!, $after: String, $query: String) { products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id title } pageInfo { hasNextPage endCursor } } }', variables: { first: '{{limit | default(50)}}' } },
};
const SPEC_UPDATE_VARIANT = {
  version: 1, requires: ['body_template'], encoding: 'json',
  body: { query: 'mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } } }', variables: {} },
};
const SPEC_APP_SEND_INVOICE = {
  version: 1, requires: ['body_template'], encoding: 'json', unmapped_params: 'reject',
  body: { query: 'mutation DraftOrderInvoiceSend($id: ID!, $email: EmailInput) { draftOrderInvoiceSend(id: $id, email: $email) { draftOrder { id name status invoiceUrl invoiceSentAt } userErrors { field message } } }', variables: {} },
};
const SPEC_APP_GRAPHQL_QUERY = {
  version: 1, requires: ['body_template'], encoding: 'json', unmapped_params: 'reject',
  body: { query: 'query OpenMaxQuery {{query}}', operationName: 'OpenMaxQuery', variables: '{{variables}}' },
};
const SHOPIFY_GQL_URL = 'https://{shop}/admin/api/2026-10/graphql.json';

const direct = (action, def, params) => classifyEffect({ mode: 'direct', slug: 'shopify-app', action, actionDef: def, params });

test('direct GraphQL (request_spec): products/list → read, update-variant → write', () => {
  assert.deepEqual(direct('shopify-app-products/list', { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: SPEC_PRODUCTS_LIST }), { effect: 'read', basis: 'graphql:query' });
  assert.deepEqual(direct('shopify-app-products/update-variant', { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: SPEC_UPDATE_VARIANT }), { effect: 'write', basis: 'graphql:mutation' });
});

test('request_spec given as JSON text is parsed too', () => {
  assert.equal(direct('x/list', { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: JSON.stringify(SPEC_PRODUCTS_LIST) }).effect, 'read');
});

test('both Shopify send-invoice variants are outbound_message (REST + GraphQL), whatever the mode', () => {
  const rest = { method: 'POST', url_template: 'https://{shop}/admin/api/2026-07/draft_orders/{draft_order_id}/send_invoice.json' };
  assert.deepEqual(direct('shopify-draft-orders/send-invoice', rest), { effect: 'outbound_message', basis: 'outbound_const' });
  assert.deepEqual(direct('shopify-app-draft-orders/send-invoice', { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: SPEC_APP_SEND_INVOICE }), { effect: 'outbound_message', basis: 'outbound_const' });
  // Even without a catalog entry / on another mode.
  assert.equal(classifyEffect({ mode: 'proxy', action: 'shopify-draft-orders/send-invoice' }).effect, 'outbound_message');
  assert.equal(classifyEffect({ action: 'shopify-app-draft-orders/send-invoice' }).effect, 'outbound_message');
  // A lookalike that only shares a tail word is not.
  assert.notEqual(direct('x/resend-invoice-template', { method: 'GET', url_template: 'https://x' }).basis, 'outbound_const');
});

test('shopify-app-graphql/query: server wraps the caller text as "query OpenMaxQuery …" → read', () => {
  const def = { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: SPEC_APP_GRAPHQL_QUERY };
  assert.deepEqual(direct('shopify-app-graphql/query', def, { query: '{ x } mutation M { productDelete(input:{}) { id } }' }), { effect: 'read', basis: 'graphql:query' });
});

test('linear-graphql/query: no request_spec, document comes from params.query', () => {
  const def = { method: 'POST', url_template: 'https://api.linear.app/graphql' };
  assert.deepEqual(direct('linear-graphql/query', def, { query: 'mutation { issueCreate(input: {title: "x"}) { success } }' }), { effect: 'write', basis: 'graphql:param_doc:mutation' });
  assert.deepEqual(direct('linear-graphql/query', def, { query: '# comment mentioning mutation\nquery Me { viewer { id } }' }), { effect: 'read', basis: 'graphql:param_doc:query' });
  assert.deepEqual(direct('linear-graphql/query', def, { query: '{ viewer { id } }' }), { effect: 'read', basis: 'graphql:param_doc:query' });
  // No document → plain REST POST → write.
  assert.deepEqual(direct('linear-graphql/query', def, {}), { effect: 'write', basis: 'rest:POST' });
});

test('GraphQL document parsing: comments, strings, subscriptions, multi-op, fragments, empty', () => {
  assert.deepEqual(classifyGraphqlDocument('  # mutation in a comment\n  query Q { a }'), { effect: 'read', kind: 'query' });
  assert.deepEqual(classifyGraphqlDocument('query Q { a(s: "mutation { x }") }'), { effect: 'read', kind: 'query' });
  assert.deepEqual(classifyGraphqlDocument('query Q { a(s: """ mutation\n block """) }'), { effect: 'read', kind: 'query' });
  assert.deepEqual(classifyGraphqlDocument('subscription S { a }'), { effect: 'write', kind: 'subscription' });
  assert.deepEqual(classifyGraphqlDocument('query A { a } mutation B { b }'), { effect: 'write', kind: 'mutation' });
  assert.deepEqual(classifyGraphqlDocument('fragment F on X { id } query Q { ...F }'), { effect: 'read', kind: 'query' });
  assert.deepEqual(classifyGraphqlDocument('query Q($a: [ID!] = ["mutation"]) @dir { a }'), { effect: 'read', kind: 'query' });
  assert.equal(classifyGraphqlDocument('').effect, 'write');
  assert.equal(classifyGraphqlDocument('fragment F on X { id }').effect, 'write');
  assert.equal(classifyGraphqlDocument('garbage').effect, 'write');
  assert.equal(classifyGraphqlDocument(42).effect, 'write');
});

test('direct REST: GET/HEAD read, everything else write; default method GET', () => {
  assert.deepEqual(direct('gmail/messages-list', { method: 'GET', url_template: 'https://x/messages' }), { effect: 'read', basis: 'rest:GET' });
  assert.deepEqual(direct('x/head', { method: 'head', url_template: 'https://x' }), { effect: 'read', basis: 'rest:HEAD' });
  assert.deepEqual(direct('x/default', { url_template: 'https://x' }), { effect: 'read', basis: 'rest:GET' });
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(direct('x/y', { method: m, url_template: 'https://x' }).effect, 'write');
});

test('fallback: no catalog entry / unknown mode → write', () => {
  assert.deepEqual(classifyEffect({ mode: 'direct', action: 'x/unknown', actionDef: null }), { effect: 'write', basis: 'fallback_write' });
  assert.deepEqual(classifyEffect({ mode: undefined, action: 'gmail/messages-list' }), { effect: 'write', basis: 'fallback_write' });
  assert.deepEqual(classifyEffect({ mode: 'weird', action: 'x/y', actionDef: { method: 'GET' } }), { effect: 'write', basis: 'fallback_write' });
});

test('Composio names (AC7 table)', () => {
  const p = (action, slug) => classifyEffect({ mode: 'proxy', slug, action });
  assert.deepEqual(p('GOOGLESHEETS_GET_SPREADSHEET_INFO', 'googlesheets'), { effect: 'read', basis: 'composio_name:read_verb', verb: 'GET' });
  assert.deepEqual(p('GOOGLESHEETS_BATCH_UPDATE', 'googlesheets'), { effect: 'write', basis: 'composio_name:default_write', verb: 'BATCH' });
  assert.deepEqual(p('GMAIL_SEND_EMAIL', 'gmail'), { effect: 'outbound_message', basis: 'composio_name:outbound_word', verb: 'SEND' });
  // Starts with a read verb but contains a send word → outbound (not downgraded).
  assert.equal(p('SLACK_GET_AND_POST_MESSAGE', 'slack').effect, 'outbound_message');
  // toolkit/ prefix form, and a slug with a dash.
  assert.equal(p('googlesheets/GOOGLESHEETS_GET_SPREADSHEET_INFO', 'googlesheets').effect, 'read');
  assert.equal(p('GOOGLE_DRIVE_LIST_FILES', 'google-drive').effect, 'read');
  // No matching slug: the first segment is dropped.
  assert.equal(p('NOTION_SEARCH_NOTION_PAGE', 'other').effect, 'read');
  assert.equal(p('notion/search', 'notion').effect, 'read');
  for (const v of ['LIST', 'SEARCH', 'FIND', 'FETCH', 'RETRIEVE', 'QUERY', 'COUNT', 'DESCRIBE', 'READ', 'LOOKUP', 'CHECK']) {
    assert.equal(p(`X_${v}_THING`, 'x').effect, 'read', v);
  }
  for (const w of ['REPLY', 'INVITE', 'SHARE', 'PUBLISH', 'NOTIFY']) assert.equal(p(`X_DO_${w}`, 'x').effect, 'outbound_message', w);
  assert.equal(p('X_DELETE_ROW', 'x').effect, 'write');
  assert.deepEqual(composioWords('gmail/GMAIL_SEND_EMAIL', 'gmail'), ['SEND', 'EMAIL']);
});

test('params digest: canonical (key order independent), sensitive to any value change', () => {
  const a = paramsDigest({ variant: { price: '17.90', id: 1 }, product_id: '9' });
  const b = paramsDigest({ product_id: '9', variant: { id: 1, price: '17.90' } });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, paramsDigest({ product_id: '9', variant: { id: 1, price: '9.90' } }));
  assert.equal(paramsDigest(undefined), paramsDigest({}));
  assert.equal(canonicalJson({ b: [2, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[2,{"c":2,"d":1}]}');
});

test('effect log: append, rotate, read back, summarize; params are never written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efflog-'));
  const file = path.join(dir, 'conn-effect.jsonl');
  const base = { event: 'invoke', org_id: 'o1', connection_id: 'c1', app: 'googlesheets', mode: 'proxy', effect: 'write', basis: 'composio_name:default_write', gate: 'off', result: 'ok' };
  assert.equal(appendEffectLog({ ...base, action: 'GOOGLESHEETS_BATCH_UPDATE', params: { secret: 'x' } }, { file, now: new Date('2026-11-20T00:00:00Z') }), true);
  appendEffectLog({ ...base, action: 'GOOGLESHEETS_GET_X', effect: 'read', basis: 'composio_name:read_verb', gate: 'read' }, { file, now: new Date('2026-11-25T00:00:00Z') });
  appendEffectLog({ ...base, mode: 'direct', action: 'x/y', gate: 'rejected:confirmation_invalid:expired' }, { file, now: new Date('2026-11-25T01:00:00Z'), maxBytes: 1 });
  assert.ok(fs.existsSync(`${file}.1`), 'rotated');
  const recs = readEffectLog({ file });
  assert.equal(recs.length, 3);
  assert.ok(!('params' in recs[0]));
  assert.ok(!fs.readFileSync(`${file}.1`, 'utf8').includes('secret'));
  const sum = summarizeEffectLog(recs, { since: '2026-11-24', mode: 'proxy' });
  assert.equal(sum.total, 1);
  assert.deepEqual(sum.by_effect, { read: 1 });
  const all = summarizeEffectLog(recs, {});
  assert.equal(all.total, 3);
  assert.equal(all.by_gate['rejected:confirmation_invalid'], 1);
  assert.throws(() => summarizeEffectLog(recs, { since: 'not-a-date' }), /since/);
  assert.ok(buildEffectLogRecord({ unknown_field: 1, effect: 'read' }).effect === 'read');
  assert.ok(!('unknown_field' in buildEffectLogRecord({ unknown_field: 1 })));
});
