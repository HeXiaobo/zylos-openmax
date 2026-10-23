import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SUPPORTED_CAPABILITIES, CAPABILITIES_HEADER_VALUE, CAPABILITIES_HEADER_NAME, capabilityHeaders, assertCapabilities,
} from './capabilities.js';
import { readCatalog, writeCatalog } from '../connect-store.js';

test('header advertises the spec version plus every implemented feature', () => {
  assert.deepEqual([...SUPPORTED_CAPABILITIES], ['request_spec.v1', 'body_template', 'prefetch', 'file_source', 'file_upload', 'resumable_upload', 'batch']);
  assert.equal(CAPABILITIES_HEADER_VALUE, 'request_spec.v1, body_template, prefetch, file_source, file_upload, resumable_upload, batch');
  assert.equal(CAPABILITIES_HEADER_NAME, 'X-Connect-Client-Capabilities');
  assert.deepEqual(capabilityHeaders(), { 'X-Connect-Client-Capabilities': CAPABILITIES_HEADER_VALUE });
  assert.ok(!/openmax/i.test(CAPABILITIES_HEADER_NAME), 'header name is client-neutral');
});

test('local refusal names the missing capabilities with a 426', () => {
  assert.doesNotThrow(() => assertCapabilities(['body_template', 'batch']));
  assert.throws(() => assertCapabilities(['body_template', 'batch'], ['request_spec.v1', 'body_template']), (e) => e.status === 426 && e.message === 'action requires plugin capabilities [batch]; upgrade the openmax plugin');
});

test('catalog cache: a record with a different (or no) capability signature is a miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-cat-'));
  writeCatalog('app1', [{ toolkit: 't', action: 'a' }], { dir });
  assert.ok(readCatalog('app1', { dir }), 'legacy readers unaffected');
  assert.equal(readCatalog('app1', { dir, capabilities: CAPABILITIES_HEADER_VALUE }), null, 'pre-signature record is refetched');
  writeCatalog('app1', [{ toolkit: 't', action: 'a' }], { dir, capabilities: 'request_spec.v1, body_template' });
  assert.equal(readCatalog('app1', { dir, capabilities: CAPABILITIES_HEADER_VALUE }), null, 'older plugin build → refetch');
  writeCatalog('app1', [{ toolkit: 't', action: 'a' }], { dir, capabilities: CAPABILITIES_HEADER_VALUE });
  const rec = readCatalog('app1', { dir, capabilities: CAPABILITIES_HEADER_VALUE });
  assert.equal(rec.capabilities, CAPABILITIES_HEADER_VALUE);
  assert.equal(rec.actions.length, 1);
});

test('catalog warm-up after authorize sends the capability header and records the signature', async () => {
  const { warmIdentityAndCatalog } = await import('../connection-events.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omx-warm-'));
  const idxPath = path.join(base, 'index.json');
  const catalogDir = path.join(base, 'cat');
  const seen = [];
  const get = async (orgId, urlPath, query, opts) => {
    seen.push({ urlPath, headers: opts && opts.extraHeaders });
    if (urlPath.endsWith('/connections')) return { connections: [{ id: 'c1', application_id: 'app-9', application_slug: 'x', credential_mode: 'direct', status: 'active' }] };
    return [{ toolkit: 't', action: 'a' }];
  };
  await warmIdentityAndCatalog('o', 'c1', idxPath, { get, catalogDir, credentialsDir: path.join(base, 'cred') });
  const actionsCall = seen.find((s) => s.urlPath.endsWith('/actions'));
  assert.deepEqual(actionsCall.headers, { 'X-Connect-Client-Capabilities': CAPABILITIES_HEADER_VALUE });
  assert.ok(readCatalog('app-9', { dir: catalogDir, capabilities: CAPABILITIES_HEADER_VALUE }));
});
