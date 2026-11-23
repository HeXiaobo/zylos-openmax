import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OPENM-1239 review: a cached updateConfig writer (bridge events, token
// refresh, owner bind) must not write back a stale connector_confirm and
// silently undo a conn.confirm_config change made by another process.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-cc-'));
const compDir = path.join(home, 'zylos/components/openmax');
const configPath = path.join(compDir, 'config.json');
fs.mkdirSync(compDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: { a: { org_id: 'o1', enabled: true } } }));
process.env.HOME = home;

const { loadConfig, updateConfig } = await import('./config.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const disk = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));

test('cached writer keeps the on-disk connector_confirm (turned on elsewhere)', () => {
  loadConfig(); // cache: no connector_confirm
  const d = disk();
  d.orgs.a.connector_confirm = { enabled: true, scope: 'all' };
  fs.writeFileSync(configPath, JSON.stringify(d)); // another process (fresh path)
  updateConfig((c) => { c.orgs.a.group_mode = 'smart'; });
  assert.deepEqual(disk().orgs.a.connector_confirm, { enabled: true, scope: 'all' });
  assert.equal(disk().orgs.a.group_mode, 'smart');
});

test('cached writer cannot set or change connector_confirm itself', () => {
  updateConfig((c) => { c.orgs.a.connector_confirm = { enabled: false }; });
  assert.deepEqual(disk().orgs.a.connector_confirm, { enabled: true, scope: 'all' });
});

test('fresh writer still changes it', () => {
  updateConfig((c) => { c.orgs.a.connector_confirm = { enabled: false }; }, { fresh: true });
  assert.deepEqual(disk().orgs.a.connector_confirm, { enabled: false });
});
