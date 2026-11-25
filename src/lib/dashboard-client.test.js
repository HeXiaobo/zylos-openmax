import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardClient } from './dashboard-client.js';
import { createMetricsReporter } from './metrics-reporter.js';
import { createTaskInventoryCollector } from './task-inventory-reporter.js';

// The comm-bridge daemon shares one client between runtime-metrics and the
// task inventory; these cases pin what sharing buys: one session token, one
// key auto-provision. The client's own auth paths are covered through
// metrics-reporter.test.js (the reporter builds its own client there).

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

function harness({ dashboardApiKey = '', acceptedKey = 'zylos_ak_auto1' } = {}) {
  const exchanges = [];
  const cli = [];
  const persisted = [];
  const fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const auth = opts.headers?.Authorization ?? '';
    if (pathname === '/api/auth/token') {
      exchanges.push(auth);
      return auth === `Bearer ${acceptedKey}`
        ? jsonRes(200, { token: 'zylos_st_1', ttl_seconds: 600 })
        : jsonRes(401, {});
    }
    if (auth !== 'Bearer zylos_st_1') return jsonRes(401, {});
    if (pathname === '/api/state') return jsonRes(200, { state: 'IDLE', system_metrics: {}, runtime_info: {} });
    if (pathname === '/api/schedules') return jsonRes(200, { items: [], nextCursor: null, total: 0, available: true, tz: 'UTC' });
    throw new Error(`unexpected ${pathname}`);
  };
  const client = createDashboardClient({
    log: () => {}, warn: () => {}, dashboardApiKey, fetch, now: () => 0,
    fileExists: () => true,
    apiKeyCliPath: '/fake/api-key.js',
    execFile: async (file, args) => {
      cli.push(args.slice(1));
      // Simulate a slow CLI so both readers are waiting on it at once.
      await new Promise((r) => setTimeout(r, 10));
      return { stdout: `Key: ${acceptedKey}\n` };
    },
    persistKey: (k) => persisted.push(k),
  });
  return { client, exchanges, cli, persisted };
}

test('two readers on one client: one auto-provision, then one shared session token', async () => {
  const h = harness();
  const metrics = createMetricsReporter(new Map([['o', { org_id: 'o1', self: { member_id: 'm1' } }]]), {
    log: () => {}, warn: () => {}, dashboardClient: h.client,
    readCoreVersion: () => '0.9.9',
    createCgroup: () => ({ sample() {}, read: () => ({ cgroup_version: 'v2' }) }),
    putForOrg: async () => {}, apiPath: (p) => p,
  });
  const inventory = createTaskInventoryCollector({
    dashboardClient: h.client, getDashboardPort: () => 3470,
    readCrontab: async () => ({ state: 'not_installed' }), cronTimeZone: () => 'UTC',
  });
  const [, body] = await Promise.all([metrics(), inventory.collect()]);
  assert.equal(h.cli.length, 1, 'provisioned once');
  assert.deepEqual(h.cli[0], ['generate', 'openmax-metrics', 'read']);
  assert.deepEqual(h.persisted, ['zylos_ak_auto1']);
  assert.equal(body.sources[0].state, 'ok');
  assert.equal(h.client.isQuiet(), false);
  // Later reads by either reader reuse the cached session token.
  const exchanged = h.exchanges.length;
  await metrics();
  await inventory.collect();
  assert.equal(h.exchanges.length, exchanged);
  assert.equal(h.cli.length, 1);
});

test('a configured key is used as is (no provisioning)', async () => {
  const h = harness({ dashboardApiKey: 'zylos_ak_manual', acceptedKey: 'zylos_ak_manual' });
  const res = await h.client.get(3470, '/api/schedules', { readBody: true });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items, []);
  assert.equal(h.cli.length, 0);
});
