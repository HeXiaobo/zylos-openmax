/**
 * OPENM-1239 review fix: conn.confirm_config set writes config.json with a
 * fresh, locked read-modify-write of the file on disk — never this process's
 * config cached at start — so a stale process cannot write back an old value
 * (e.g. enabled:false without the owner check) or drop other changes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CONFIG_PATH is derived from HOME at module load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-cfg-fresh-'));
process.env.HOME = home;
const cfgPath = path.join(home, 'zylos/components/openmax/config.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
const ORG = 'org-1';
const SLUG = 'lin-shop';
const write = (cc, extra = {}) => fs.writeFileSync(cfgPath, JSON.stringify({ orgs: { [SLUG]: { enabled: true, org_id: ORG, ...(cc ? { connector_confirm: cc } : {}), ...extra } } }));
const disk = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
write({ enabled: false });

const { loadConfig, updateConfig } = await import('../lib/config.js');
const { runConfirmConfig } = await import('./conn.js');

const deps = (audits = []) => ({
  resolveOrg: () => ORG,
  checkAgentOwner: async () => ({ allowed: false, reason: 'missing_initiator' }),
  audit: (r) => audits.push(r),
  now: () => new Date('2026-11-23T08:00:00Z'),
});

test('stale cache says off, disk says on: "set enabled:false" is refused (409), the disk value stays on', async () => {
  write({ enabled: false });
  loadConfig(); // cached: off
  // Someone else turns it on and adds a field meanwhile.
  write({ enabled: true, scope: 'all' }, { other_change: 'keep-me' });
  assert.equal(loadConfig().orgs[SLUG].connector_confirm.enabled, false, 'the cache is stale');
  await assert.rejects(
    () => runConfirmConfig({ action: 'set', enabled: false }, deps()),
    (e) => e.status === 409 && /changed meanwhile/.test(e.message),
  );
  assert.deepEqual(disk().orgs[SLUG].connector_confirm, { enabled: true, scope: 'all' });
  assert.equal(disk().orgs[SLUG].other_change, 'keep-me');
});

test('a tightening change keeps other changes made on disk after the process started', async () => {
  write({ enabled: false });
  updateConfig(() => {}); // re-prime the cache from this state
  write({ enabled: false }, { other_change: 'keep-me' });
  const out = await runConfirmConfig({ action: 'set', enabled: true }, deps());
  assert.equal(out.allowed, true);
  assert.equal(out.effective.enabled, true, 'the result view is the fresh config');
  const o = disk().orgs[SLUG];
  assert.equal(o.connector_confirm.enabled, true);
  assert.equal(o.other_change, 'keep-me', 'not overwritten by the cached copy');
  assert.equal(disk().diagnostics, undefined, 'defaults are not written into the file');
});

test('updateConfig {fresh:true} waits for the lock and refuses (409) when it cannot get it; nothing written', () => {
  write({ enabled: false });
  const lock = `${cfgPath}.lock`;
  fs.writeFileSync(lock, '');
  try {
    assert.throws(() => updateConfig((c) => { c.orgs[SLUG].connector_confirm = { enabled: true }; }, { fresh: true }), (e) => e.status === 409);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  assert.deepEqual(disk().orgs[SLUG].connector_confirm, { enabled: false });
});

test('updateConfig {fresh:true} refuses a corrupt config.json instead of replacing it', () => {
  fs.writeFileSync(cfgPath, '{not json');
  assert.throws(() => updateConfig(() => {}, { fresh: true }));
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{not json');
});
