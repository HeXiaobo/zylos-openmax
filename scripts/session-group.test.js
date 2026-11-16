/**
 * scripts/session-group.js as Core runs it: one line + exit 0, or stderr +
 * exit 1 with nothing on stdout (Core then sends and records nothing). The
 * name equals the one the bridge passes inbound for the same conversation.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatEndpoint } from '../src/lib/message.js';
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-group.js');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-session-group-script-'));
const G = '01a18649-b095-7add-bfa6-9b405ec30433';
const D = '019f6a84-3a1e-76dd-931d-0eea1cb3112a';

function run(...args) {
  // No orgs configured and an unroutable API: any lookup fails fast.
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: tmpHome, COCO_API_URL: 'http://127.0.0.1:9', COCO_ORG_ID: '', COCO_RPC_LOG: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('T6: a typed endpoint → exactly one line, exit 0, the same name as the inbound mapping', () => {
  for (const [conversationId, endpointType] of [[D, 'dm'], [G, 'group'], [G, 'sub']]) {
    const endpoint = formatEndpoint({ conversationId, endpointType, sourceMessageId: '7300000000000000132' });
    const r = run(endpoint);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${sessionGroupFromEndpoint(endpoint)}\n`);
  }
});

test('T6: wrong argument count or an unmappable endpoint → nothing on stdout, exit 1', () => {
  for (const args of [[], ['a', 'b'], [`${G}|type:thread`], ['a.b|type:dm'], [`${G}|type:strat|msg:1`]]) {
    const r = run(...args);
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.equal(r.stdout, '', 'never an empty line');
    assert.ok(r.stderr.length > 0);
  }
});

test('T6/T7: a bare id with a stored type answers offline; without one and no reachable API → exit 1', () => {
  const mapPath = path.join(tmpHome, 'zylos/components/openmax/runtime/conv-org-map.json');
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify({ [D]: { orgId: 'org-1', ts: Date.now(), type: 'DM' } }));
  let r = run(D);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `dm-${D}\n`);

  r = run(G);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot look up conversation type/);
});
