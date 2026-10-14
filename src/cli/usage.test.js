import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { queryUsage, usageQuery } from './usage.js';

const params = { range_start: '2026-10-01T00:00:00Z', range_end: '2026-10-02T00:00:00Z' };
const env = { COCO_API_URL: 'https://core.example', COCO_USAGE_API_KEY: 'usage-test-secret' };

test('dedicated auth, filters, cursor and exact strings survive without aggregation', async () => {
  const expected = { data: { rows: [{ tokens: '9007199254740993', points: '0.000001' }], next_cursor: 'opaque', pending: 3, complete: false } };
  const result = await queryUsage({ ...params, agent_identity_ids: ['a', 'b'], group_by_agent: false, page_size: 2000, cursor: 'a+/=' }, {
    env, fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/public/v1/billing/usage');
      assert.deepEqual(url.searchParams.getAll('agent_identity_ids'), ['a', 'b']);
      assert.equal(url.searchParams.get('cursor'), 'a+/=');
      assert.equal(url.searchParams.get('group_by_agent'), 'false');
      assert.equal(options.headers.Authorization, `Bearer ${env.COCO_USAGE_API_KEY}`);
      assert.equal(options.redirect, 'error');
      assert.equal(url.toString().includes(env.COCO_USAGE_API_KEY), false);
      return Response.json(expected);
    },
  });
  assert.deepEqual(result, expected);
});

test('missing dedicated key never falls back to agent credentials or calls network', async () => {
  await assert.rejects(queryUsage(params, { env: { COCO_API_KEY: 'agent-key' }, fetchImpl: () => assert.fail() }), /COCO_USAGE_API_KEY/);
});

test('unsafe destinations fail before credentials leave process', async () => {
  for (const base of ['http://core.example', 'https://user:pass@core.example', 'https://core.example/path', 'https://core.example/?key=x', 'https://core.example/#x']) {
    await assert.rejects(queryUsage(params, { env: { ...env, COCO_API_URL: base }, fetchImpl: () => assert.fail() }), /HTTPS origin/);
  }
});

test('invalid ranges, cross-org parameters and malformed filters fail locally', () => {
  for (const extra of [{ org: 'x' }, { api_key: 'secret' }, { range_end: params.range_start }, { granularity: 'minute' }, { page_size: 2001 }, { group_by_agent: 'false' }, { agent_identity_ids: [] }, { agent_identity_ids: ['a'], agent_identity_id: 'b' }, { granularity: 'hour', range_end: '2026-10-10T00:00:00Z' }]) {
    assert.throws(() => usageQuery({ ...params, ...extra }));
  }
});

test('HTTP errors preserve status and bounded Retry-After, never upstream body, no retries', async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    await assert.rejects(queryUsage(params, { env, fetchImpl: async () => {
      calls++;
      return new Response(env.COCO_USAGE_API_KEY, { status, headers: { 'retry-after': '60' } });
    } }), error => {
      assert.equal(error.status, status);
      assert.equal(error.retry_after, status === 429 ? 60 : undefined);
      assert.equal(error.message.includes(env.COCO_USAGE_API_KEY), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('network exceptions and reflected secrets cannot reach output', async () => {
  await assert.rejects(queryUsage(params, { env, fetchImpl: () => { throw new Error(env.COCO_USAGE_API_KEY); } }), /network, redirect or timeout/);
  await assert.rejects(queryUsage(params, { env, fetchImpl: async () => Response.json({ secret: env.COCO_USAGE_API_KEY }) }), /Invalid usage response/);
});

test('CLI malformed JSON is structured and does not echo input', () => {
  const result = spawnSync(process.execPath, ['src/cli/usage.js', 'usage.query', '{private-secret'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'Invalid JSON parameters' });
});
