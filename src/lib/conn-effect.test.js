import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyEffect, classifyGraphqlDocument, graphqlTopLevelOperations, composioWords, canonicalJson, paramsDigest,
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

test('shopify-app-graphql/query: the templated document is classified as rendered from params', () => {
  const def = { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: SPEC_APP_GRAPHQL_QUERY };
  assert.deepEqual(direct('shopify-app-graphql/query', def, { query: '{ products(first: 5) { nodes { id } } }' }), { effect: 'read', basis: 'graphql:rendered:query' });
  // A smuggled second operation is a mutation in the rendered document → write.
  assert.deepEqual(direct('shopify-app-graphql/query', def, { query: '{ x } mutation M { productDelete(input:{}) { id } }' }), { effect: 'write', basis: 'graphql:rendered:mutation' });
});

test('request_spec body.query that is a bare placeholder: caller-supplied mutation is a write, never a read', () => {
  const spec = { version: 1, requires: ['body_template'], encoding: 'json', body: { query: '{{query}}', variables: '{{variables}}' } };
  const def = { method: 'POST', url_template: SHOPIFY_GQL_URL, request_spec: spec };
  assert.deepEqual(direct('x/graphql', def, { query: 'mutation { productDelete(input: {id: "1"}) { deletedProductId } }' }), { effect: 'write', basis: 'graphql:rendered:mutation' });
  assert.deepEqual(direct('x/graphql', def, { query: 'query Q { shop { name } }' }), { effect: 'read', basis: 'graphql:rendered:query' });
  // Missing / non-string param, prefetch or file params, a bad template → write.
  assert.deepEqual(direct('x/graphql', def, {}), { effect: 'write', basis: 'graphql:templated_unresolved' });
  assert.deepEqual(direct('x/graphql', def, { query: { a: 1 } }), { effect: 'write', basis: 'graphql:templated_unresolved' });
  const pf = { ...def, request_spec: { ...spec, prefetch: [{ as: 'p', action: 'x/list' }] } };
  assert.deepEqual(direct('x/graphql', pf, { query: 'query Q { a }' }), { effect: 'write', basis: 'graphql:templated_unresolved' });
  const fl = { ...def, request_spec: { ...spec, files: { f: {} } } };
  assert.deepEqual(direct('x/graphql', fl, { query: 'query Q { a }' }), { effect: 'write', basis: 'graphql:templated_unresolved' });
  const broken = { ...def, request_spec: { ...spec, body: { query: '{{ 9bad }}' } } };
  assert.equal(direct('x/graphql', broken, { query: 'query Q { a }' }).effect, 'write');
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

test('a # comment ends at a lone CR too: a mutation after "#\\r" is still seen (write)', () => {
  const doc = 'query A { viewer { id } } #\rmutation B { issueDelete(id:"x") { success } }';
  assert.equal(classifyGraphqlDocument(doc).effect, 'write');
  const crlf = 'query A { viewer { id } } # c\r\nmutation B { issueDelete(id:"x") { success } }';
  assert.equal(classifyGraphqlDocument(crlf).effect, 'write');
  // A mutation inside a comment is still only a comment.
  assert.equal(classifyGraphqlDocument('query A { viewer { id } } # mutation B { x }').effect, 'read');
  const templated = {
    mode: 'direct',
    actionDef: { method: 'POST', url_template: 'https://x/graphql', request_spec: { version: 1, requires: ['body_template'], encoding: 'json', body: { query: '{{query}}', operationName: '{{operationName}}' } } },
    params: { query: doc, operationName: 'B' },
  };
  assert.equal(classifyEffect(templated).effect, 'write');
});

// --- GraphQL lexing per spec (zylos0t review of #316) ------------------------

const W = (doc) => assert.equal(classifyGraphqlDocument(doc).effect, 'write', `expected write: ${JSON.stringify(doc)}`);
const R = (doc) => assert.equal(classifyGraphqlDocument(doc).effect, 'read', `expected read: ${JSON.stringify(doc)}`);

test('GraphQL block strings: \\""" is an escape, not the end — a mutation hidden after an escaped delimiter is a write', () => {
  // graphql-js parses query A AND mutation B; operationName "B" would run the mutation.
  assert.deepEqual(classifyGraphqlDocument('query A { f(a: """\\""" # """) } mutation B { del }'), { effect: 'write', kind: 'mutation' });
  W('query A { f(a: """\\"""""") } mutation B { del }');
  W('query A { f(a: """ x \\""" y \\""" """) }\nmutation B { del }');
  // The escaped delimiter really is inside the string: one query, read.
  R('query A { f(a: """\\""" # mutation B { del } """) }');
  // Other backslashes in a block string are literal: \\ is not an escape, so in
  // """\\""" the second backslash still starts \""" (graphql-js: unterminated).
  W('query A { f(a: """\\\\""") }');
  R('query A { f(a: """\\\\"""""") }');
  W('query A { f(a: """\\\\"""""") } mutation B { del }');
  R('query A { f(a: """ \\" \\ """) }');
  R('query A { f(a: """ \\n \\u0041 \\x """) }');
  R('query A { f(a: """a\r\nb\rc\nd""") }');
  R('query A { f(a: """""") { x } }'); // empty block string
});

test('GraphQL single-line strings: escapes per spec; " ends; LF/CR inside is malformed (write)', () => {
  R('query A { f(a: "\\"") }');
  R('query A { f(a: "\\\\") }');
  R('query A { f(a: "\\\\", b: "x") }');
  W('query A { f(a: "\\\\") } mutation B { del }');
  R('query A { f(a: "\\u0041\\u{1F600}\\uD83D\\uDE00 \\/ \\b \\f \\n \\r \\t") }');
  R('query A { f(a: "😀 é # } mutation B { del }") }');
  // A string that "continues" past a line terminator is malformed, not skipped.
  W('query A { f(a: "abc\n") }');
  W('query A { f(a: "abc\r") }');
  W('query A { f(a: "abc\r\n") }');
  // Bad escapes are malformed.
  for (const esc of ['\\x', '\\uZZZZ', '\\u12', '\\u{}', '\\u{110000}', '\\u{D800}', '\\uD800', '\\uDE00', '\\uD83Dx', '\\q']) {
    assert.deepEqual(classifyGraphqlDocument(`query A { f(a: "${esc}") }`), { effect: 'write', kind: 'malformed' }, esc);
  }
});

test('GraphQL comments: quotes inside a comment are not strings; CR, LF and CRLF end a comment', () => {
  R('query A { # a "comment with a " quote and """ block\n f }');
  W('query A { f } # " \nmutation B { del }');
  W('query A { f } # """ \r\nmutation B { del }');
  W('query A { f } # """\rmutation B { del }');
  R('# mutation B { del }\r\nquery A { f }');
  R('query A { f(a: "# not a comment") }');
});

test('GraphQL malformed documents classify as write (fail closed)', () => {
  const malformed = [
    'query A { f(a: """unclosed) }',           // unclosed block string
    'query A { f(a: "unclosed) }',             // unclosed string
    'query A { f(a: """\\""") }',              // the only """ is escaped → unclosed
    'query A { f ',                            // unclosed brace at end
    'query A { f(a: 1 }',                      // unclosed paren, mismatched
    'query A { f(a: [1 ) }',                   // unclosed bracket
    'query A { f }}',                          // stray close
    'query A { f } )',                         // stray close paren
    'query A',                                 // no selection set
    'query A { }',                             // empty selection set
    'query A { f } %',                         // not a GraphQL character
    'query A { f(a: .5) }',                    // lone dot
    'query A { f(a: 1x) }',                    // number followed by a name
    'query A { f(a: 01) }',                    // leading zero
    'query A { f(a: "\uD800") }',              // lone surrogate in source
    '\u0001query A { f }',                     // control character outside a string
    'query A { f } query',                     // trailing keyword
    'query A ($v: Int = $w) { f }',            // variable in a const default
    'fragment on on T { f } query A { ...on }',
  ];
  for (const doc of malformed) assert.equal(classifyGraphqlDocument(doc).effect, 'write', JSON.stringify(doc));
  assert.deepEqual(classifyGraphqlDocument('query A { f(a: """unclosed) }'), { effect: 'write', kind: 'malformed' });
  assert.ok(graphqlTopLevelOperations('query A { f ').includes('malformed'));
  // Absurd nesting does not crash the classifier: malformed → write.
  W(`query A { f(a: ${'['.repeat(20000)}${']'.repeat(20000)}) }`);
});

test('GraphQL valid documents keep their meaning: BOM, commas, CRLF, aliases, fragments, directives, values', () => {
  R('﻿query A { f }');
  R('query A,{,f,g,}');
  R('query A {\r\n  a: f(x: 1, y: -2.5e3, z: true, w: null, e: ENUM, l: [1, "x"], o: {k: "v", n: [{m: $v}]}) @skip(if: $v) { id }\r\n}');
  R('query A($v: [Int!]! = [1] @d) @d(x: 1) { ...F ... on T { x } ... @include(if: true) { y } }\nfragment F on T { z }');
  R('{ mutation query subscription fragment }');
  R('query mutation { f }');
  W('mutation query { f }');
  W('subscription { f }');
  W('type T { f: Int }');
  W('{ f } mutation { g }');
});
