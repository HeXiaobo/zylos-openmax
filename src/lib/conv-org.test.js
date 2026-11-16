/**
 * conv-org-map.json keeps a conversation's type for good (a type never
 * changes), writes the type the first time it is seen, and keeps entries other
 * processes wrote.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// conv-org.js resolves its file from HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-conv-org-test-'));
process.env.HOME = tmpHome;
const { registerConvOrg, lookupConvOrg, lookupConvRecord, convRecordFields, CONV_ORG_MAP_PATH } = await import('./conv-org.js');

const CONV_ORG_JS = fileURLToPath(new URL('./conv-org.js', import.meta.url));
const readFile = () => JSON.parse(fs.readFileSync(CONV_ORG_MAP_PATH, 'utf8'));
const DAY = 24 * 60 * 60 * 1000;

test('convRecordFields keeps only what never changes: platform type, parent id, sub marker', () => {
  assert.deepEqual(convRecordFields({ id: 'c', type: 'GROUP', name: 'Eng', members: [] }), { type: 'GROUP' });
  assert.deepEqual(
    convRecordFields({ type: 'DM', context_owner_kind: 'platform', context_key: 'message:1', parent_conversation_id: 'p1', title: 't' }),
    { type: 'DM', parentId: 'p1', sub: true },
  );
  assert.deepEqual(convRecordFields({ type: 'STRAT', parent_conversation_id: 'p2' }), { type: 'STRAT', parentId: 'p2' });
  assert.equal(convRecordFields({ name: 'no type' }), null);
  assert.equal(convRecordFields(null), null);
});

test('T7: the type is written the first time it is seen, even for a conversation already mapped to the same org', () => {
  registerConvOrg('c-first', 'org-1');
  assert.equal(readFile()['c-first'].type, undefined);
  registerConvOrg('c-first', 'org-1', { type: 'GROUP' });
  assert.equal(readFile()['c-first'].type, 'GROUP', 'written to disk, not only memory');
  assert.deepEqual(lookupConvRecord('c-first'), { orgId: 'org-1', type: 'GROUP' });
  assert.equal(lookupConvOrg('c-first'), 'org-1');
  // A later sighting without fields keeps the type.
  registerConvOrg('c-first', 'org-1');
  assert.equal(readFile()['c-first'].type, 'GROUP');
});

test('T7: an entry with a type is never pruned; one without a type still is after 24h', () => {
  const old = Date.now() - 3 * DAY;
  const disk = readFile();
  disk['c-typed-old'] = { orgId: 'org-1', ts: old, type: 'DM' };
  disk['c-untyped-old'] = { orgId: 'org-1', ts: old };
  fs.writeFileSync(CONV_ORG_MAP_PATH, JSON.stringify(disk));
  // Any write prunes. Use a fresh process so this one's memory does not mask the file.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(CONV_ORG_JS)}); m.registerConvOrg('c-trigger', 'org-1', { type: 'GROUP' });`],
  { env: { ...process.env, HOME: tmpHome } });
  const after = readFile();
  assert.equal(after['c-typed-old'].type, 'DM');
  assert.equal('c-untyped-old' in after, false);
});

test('T7: two processes writing in turn keep each other\'s entries (re-read and merge before write)', () => {
  // This process caches the map in memory; another process then adds an entry.
  registerConvOrg('c-here-1', 'org-1', { type: 'DM' });
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(CONV_ORG_JS)}); m.registerConvOrg('c-other', 'org-2', { type: 'GROUP', parentId: 'p', sub: true });`],
  { env: { ...process.env, HOME: tmpHome } });
  // This process writes again from its (stale) cache: the other entry survives.
  registerConvOrg('c-here-2', 'org-1', { type: 'GROUP' });
  const after = readFile();
  assert.deepEqual(
    { type: after['c-other'].type, parentId: after['c-other'].parentId, sub: after['c-other'].sub, orgId: after['c-other'].orgId },
    { type: 'GROUP', parentId: 'p', sub: true, orgId: 'org-2' },
  );
  assert.equal(after['c-here-1'].type, 'DM');
  assert.equal(after['c-here-2'].type, 'GROUP');
  // And a lookup in this process finds the other process's entry (file fallback).
  assert.deepEqual(lookupConvRecord('c-other'), { orgId: 'org-2', type: 'GROUP', parentId: 'p', sub: true });
});

test('a v1 file (plain orgId strings) still reads', () => {
  const disk = readFile();
  disk['c-v1'] = 'org-legacy';
  fs.writeFileSync(CONV_ORG_MAP_PATH, JSON.stringify(disk));
  assert.equal(lookupConvOrg('c-v1'), 'org-legacy');
  assert.equal(lookupConvRecord('c-v1'), null);
});
