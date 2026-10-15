import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseUsageArgs, queryUsage, usageQuery } from './usage.js';

const params = { range_start: '2026-10-01T00:00:00Z', range_end: '2026-10-02T00:00:00Z', granularity: 'hour' };
const env = { COCO_API_URL: 'https://core.example', COCO_USAGE_API_KEY: 'usage-test-secret' };

test('short hourly query resolves seven complete UTC days independently of local timezone', () => {
  assert.deepEqual(parseUsageArgs(['--granularity', 'hour', '--last', '7d', '--group-by', 'agent'], Date.parse('2026-10-14T14:35:24+08:00')), {
    granularity: 'hour', group_by_agent: true, group_by_model: false,
    range_start: '2026-10-07T06:00:00.000Z', range_end: '2026-10-14T06:00:00.000Z',
  });
});

test('relative daily ranges align to Beijing midnight and accept maximum 90 days', () => {
  const result = parseUsageArgs(['--granularity', 'day', '--last', '90d'], Date.parse('2026-10-14T06:35:24Z'));
  assert.equal(result.range_end, '2026-10-13T16:00:00.000Z');
  assert.equal(Date.parse(result.range_end) - Date.parse(result.range_start), 90 * 86400000);
  assert.equal(parseUsageArgs(['--last', '1h'], Date.parse('2026-10-14T06:00:00Z')).range_end, '2026-10-14T06:00:00.000Z');
});

test('explicit flags support stable cursor pagination, repeated agents and JSON compatibility', () => {
  const result = parseUsageArgs(['--range-start', params.range_start, '--range-end', params.range_end,
    '--granularity', 'hour',
    '--agent-identity-ids', 'a', '--agent-identity-ids', 'b', '--page-size', '25', '--cursor', 'opaque', '--group-by', 'agent,model']);
  assert.deepEqual(result.agent_identity_ids, ['a', 'b']);
  assert.equal(result.page_size, 25);
  assert.equal(result.cursor, 'opaque');
  assert.equal(result.group_by_model, true);
  assert.deepEqual(parseUsageArgs([JSON.stringify(params)]), params);
});

test('flag errors do not echo values and reject ambiguous or unbounded ranges', () => {
  for (const args of [
    ['--last', '8d'], ['--last', '169h'], ['--last', '0d'], ['--last', '-1d'], ['--last', '1.5d'],
    ['--granularity', 'day', '--last', '91d'], ['--granularity', 'day', '--last', '24h'],
    ['--last', '7d', '--range-start', params.range_start], ['--last', '7d', '--cursor', 'opaque'],
    ['--last', '1h', '--last', '2h'], ['--last', '1h', '--group-by', 'secret-value'],
    ['--key', 'secret-value'], ['--last', '1h', 'secret-value'], ['--last'],
    ['--last', '1h', '--page-size', '1.5'],
  ]) assert.throws(() => parseUsageArgs(args), error => !error.message.includes('secret-value'));
});

test('dedicated auth, filters, cursor and exact strings survive without aggregation', async () => {
  // Final Core !823 UsagePage/UsageRow JSON contract (merge ea837fc9).
  const expected = { request_id: 'request-fixture', server_time: '2026-10-02T01:00:00Z', data: {
    rows: [{ bucket_start: params.range_start, agent_identity_id: 'a', usage_kind: 'model', model_key: 'fixture', unit: 'token',
      points: '0.000001', input_tokens: '9007199254740993', text_output_tokens: '2',
      cache_read_tokens: '3', cache_creation_5m_tokens: '4', cache_creation_1h_tokens: '5',
      cache_creation_uncategorized_tokens: '6', image_output_tokens: '7', quantity: '0.25',
      online_minutes: '0', sleep_minutes: '0', event_count: '8', missing_token_events: '1', image_count: '0', missing_image_events: '1' }],
    next_cursor: 'opaque', revision: '9007199254740995', covered_from: params.range_start,
    covered_until: params.range_end, refreshed_at: '2026-10-02T00:30:00Z',
    pending_dirty_count: '9007199254740997', oldest_pending_at: params.range_start, provisional: true,
  } };
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

test('scalar filters reject arrays and nonstrings before making any HTTP request', async () => {
  let calls = 0;
  for (const field of ['agent_identity_id', 'model_key', 'cursor']) {
    for (const value of [[], ['a'], ['a', 'b'], 1, 0, {}, { value: 'a' }, true, false, null, '']) {
      await assert.rejects(queryUsage({ ...params, [field]: value }, {
        env, fetchImpl: async () => { calls++; return Response.json({}); },
      }), /Invalid usage filter/);
    }
  }
  assert.equal(calls, 0);
  const query = usageQuery({ ...params, agent_identity_id: 'a', model_key: 'm', cursor: 'opaque' });
  for (const field of ['agent_identity_id', 'model_key', 'cursor']) assert.equal(query.getAll(field).length, 1);
  assert.deepEqual(usageQuery({ ...params, agent_identity_ids: ['a', 'b'] }).getAll('agent_identity_ids'), ['a', 'b']);
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
  for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) {
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

test('final Core alignment, enum and byte limits are enforced before network', () => {
  for (const extra of [
    { granularity: 'day' }, { range_start: '2026-10-01T00:01:00Z' },
    { range_start: '2026-10-01T00:00:00.000000001Z' },
    { usage_kind: 'tokens' }, { agent_identity_id: 'a'.repeat(513) },
    { agent_identity_ids: ['a'.repeat(513)] }, { model_key: 'a'.repeat(513) },
    { model_key: '\u4e2d'.repeat(171) }, { cursor: 'a'.repeat(4097) },
  ]) assert.throws(() => usageQuery({ ...params, ...extra }));
  assert.equal(usageQuery({ ...params, agent_identity_id: 'a'.repeat(512), cursor: 'a'.repeat(4096), usage_kind: 'runtime' }).get('usage_kind'), 'runtime');
  assert.equal(usageQuery({ range_start: '2026-10-01T00:00:00+08:00', range_end: '2026-10-02T00:00:00+08:00' }).get('granularity'), 'day');
});

test('offline help describes final metadata and stale-cursor recovery', () => {
  const result = spawnSync(process.execPath, ['src/cli/usage.js', 'usage.query', '--help'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0);
  for (const field of ['data.next_cursor', 'data.revision', 'data.pending_dirty_count', 'data.provisional', '409:', '400/422:']) assert.ok(result.stdout.includes(field));
  assert.ok(!result.stdout.includes('adapter/SDK is ready'));
  assert.ok(!result.stdout.includes('then returns 503'));
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
