import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRequestSpec, parseRequestSpec } from './spec.js';
import * as S from './testdata/specs.js';

const POST = { method: 'POST', url_template: 'https://api.example.com/v1/x' };
const catalog = [
  { toolkit: 'gmail', action: 'messages-get', method: 'GET', url_template: 'https://api.example.com/m/{id}?format={format}' },
  { toolkit: 'gmail', action: 'messages-delete', method: 'DELETE', url_template: 'https://api.example.com/m/{id}' },
  { toolkit: 'calendar', action: 'events-insert', method: 'POST', url_template: 'https://api.example.com/calendar/v3/e' },
  { toolkit: 'calendar', action: 'events-patch', method: 'PATCH', url_template: 'https://api.example.com/calendar/v3/e/{id}' },
  { toolkit: 'calendar', action: 'events-delete', method: 'DELETE', url_template: 'https://api.example.com/calendar/v3/e/{id}' },
  { toolkit: 'x', action: 'with-spec', method: 'GET', url_template: 'https://api.example.com/y', request_spec: { version: 1 } },
];

test('every plan §6 example validates and reports the params it references', () => {
  for (const [name, spec] of Object.entries(S)) {
    const r = validateRequestSpec(spec, POST, catalog);
    assert.ok(r.referenced.has('_query'), name);
  }
  const r = validateRequestSpec(S.REPLY, POST, catalog);
  assert.deepEqual([...r.referenced].filter((x) => x !== '_query').sort(), ['attachments', 'bcc', 'cc', 'html', 'message_id', 'text', 'to']);
  assert.ok(validateRequestSpec(S.CALENDAR_BATCH, POST, catalog).referenced.has('requests'));
});

test('JSON-string form is accepted', () => {
  assert.equal(validateRequestSpec(JSON.stringify(S.DOCS_INSERT), POST).encoding, 'json');
  assert.throws(() => parseRequestSpec('{nope'), { status: 422 });
  assert.equal(parseRequestSpec(''), null);
});

test('unknown requires → 426 (upgrade the plugin)', () => {
  assert.throws(() => validateRequestSpec({ ...S.DOCS_INSERT, requires: ['body_template', 'quantum_upload'] }, POST),
    (e) => e.status === 426 && /upgrade the openmax plugin/.test(e.message) && /quantum_upload/.test(e.message));
});

const bad = (spec, re, def = POST, cat = catalog) => assert.throws(() => validateRequestSpec(spec, def, cat), (e) => e.status === 422 && (!re || re.test(e.message)), JSON.stringify(spec).slice(0, 80));

test('structural rejections', () => {
  bad({ ...S.DOCS_INSERT, extra: 1 }, /unknown key/);
  bad({ ...S.DOCS_INSERT, version: 2 }, /version/);
  bad({ ...S.DOCS_INSERT, requires: [] }, /requires/);
  bad({ ...S.DOCS_INSERT, requires: ['body_template', 'body_template'] }, /repeat/);
  bad({ ...S.DOCS_INSERT, encoding: 'xml' }, /encoding/);
  bad({ ...S.DOCS_INSERT, unmapped_params: 'maybe' }, /unmapped/);
  bad(S.DOCS_INSERT, /GET/, { method: 'GET', url_template: 'https://x/y' });
  bad({ ...S.DOCS_INSERT, requires: ['body_template', 'prefetch'] }, /exactly/);
  bad({ ...S.COMPOSE_SEND, requires: ['body_template'] }, /missing: \[file_source\]/);
});

test('files rules', () => {
  bad({ ...S.COMPOSE_SEND, files: { attachments: { multiple: true, max_bytes: 26 * 1024 * 1024 } } }, /max_bytes/);
  bad({ ...S.COMPOSE_SEND, files: { attachments: { sources: ['url'] } } }, /sources/);
  bad({ ...S.COMPOSE_SEND, files: { attachments: { stream: true } } }, /stream/);
  bad({ ...S.COMPOSE_SEND, files: { attachments: { owner: 'x' } } }, /unknown key/);
  bad({ ...S.DOCS_INSERT, body: '{{files.nope.size}}' }, /not declared/);
});

test('prefetch rules', () => {
  const pf = (p) => ({ ...S.REPLY, prefetch: p });
  bad(pf([{ as: 'orig', action: 'gmail/messages-delete', params: {} }]), /GET/);
  bad(pf([{ as: 'orig', action: 'gmail/nope', params: {} }]), /not in this catalog/);
  bad(pf([{ as: 'orig', action: 'x/with-spec', params: {} }]), /request_spec/);
  bad(pf([{ as: 'Orig', action: 'gmail/messages-get', params: {} }]), /as must match/);
  bad(pf(Array(4).fill({ as: 'a', action: 'gmail/messages-get', params: {} })), /1\.\.3/);
  bad(pf([{ as: 'a', action: 'gmail/messages-get', params: { id: '{{prefetch.b.body.id}}' } }, { as: 'b', action: 'gmail/messages-get', params: {} }]), /unknown prefetch/);
  bad({ ...S.REPLY, body: { t: '{{prefetch.other.body}}' } }, /unknown prefetch/);
});

test('encoding / block consistency', () => {
  bad({ ...S.DRIVE_UPLOAD, encoding: 'json' }, /parts are only valid/);
  bad({ ...S.DRIVE_UPLOAD, parts: [{ file: 'nope' }] }, /not declared/);
  bad({ ...S.DRIVE_UPDATE_CONTENT, body: undefined }, /media/);
  bad({ version: 1, requires: ['body_template'], encoding: 'none', body: { a: 1 } }, /none/);
  bad({ ...S.CALENDAR_BATCH, encoding: 'json' }, /batch_mixed/);
  bad({ ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, max_items: 101 } }, /max_items/);
  bad({ ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, allowed_actions: ['x/with-spec'] } }, /request_spec/);
  bad({ ...S.CALENDAR_BATCH, batch: { ...S.CALENDAR_BATCH.batch, allowed_actions: ['calendar/nope'] } }, /not in this catalog/);
  bad({ ...S.DRIVE_RESUMABLE, encoding: 'media' }, /json/);
  bad({ ...S.DRIVE_RESUMABLE, upload: { ...S.DRIVE_RESUMABLE.upload, max_restarts: 3 } }, /max_restarts/);
  bad({ ...S.DRIVE_RESUMABLE, upload: { ...S.DRIVE_RESUMABLE.upload, session_url_from: 'body:uploadUrl' } }, /session_url_from/);
  bad({ ...S.DRIVE_RESUMABLE, upload: { ...S.DRIVE_RESUMABLE.upload, chunk_bytes: 1000 } }, /chunk_bytes/);
  bad({ ...S.DRIVE_RESUMABLE, upload: { ...S.DRIVE_RESUMABLE.upload, init_headers: { Authorization: 'x' } } }, /not allowed/);
  bad({ ...S.DRIVE_RESUMABLE, files: { file: { stream: false } } }, /stream/);
});

test('hard-coded file references in a spec are refused (custom connectors, Q8)', () => {
  bad({ ...S.DRIVE_UPDATE_CONTENT, body: { $bytes: '/home/user/.ssh/id_rsa' } }, /literal/);
  bad({ ...S.COMPOSE_SEND, body: { raw: { $rfc822: { attachments: { $bytes: 'artifact://x' } } } } }, /literal/);
});
