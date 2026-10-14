#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const FIELDS = new Set(['range_start', 'range_end', 'granularity', 'agent_identity_id',
  'agent_identity_ids', 'model_key', 'usage_kind', 'page_size', 'cursor',
  'group_by_agent', 'group_by_model']);

export function usageQuery(params) {
  if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Expected a JSON object');
  if (Object.keys(params).some(key => !FIELDS.has(key))) throw new Error('Unsupported usage query field');
  for (const field of ['range_start', 'range_end']) {
    if (typeof params[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(params[field]) || !Number.isFinite(Date.parse(params[field]))) {
      throw new Error(`${field} must be RFC3339`);
    }
  }
  const granularity = params.granularity ?? 'day';
  if (!['hour', 'day'].includes(granularity)) throw new Error('granularity must be hour or day');
  const span = Date.parse(params.range_end) - Date.parse(params.range_start);
  if (span <= 0 || span > (granularity === 'hour' ? 7 : 90) * 86400000) throw new Error('Invalid usage range (hour: max 7 days; day: max 90 days)');
  if (params.agent_identity_id !== undefined && params.agent_identity_ids !== undefined) throw new Error('Agent filters are mutually exclusive');
  if (params.page_size !== undefined && (!Number.isInteger(params.page_size) || params.page_size < 1 || params.page_size > 2000)) throw new Error('page_size must be 1..2000');
  for (const field of ['group_by_agent', 'group_by_model']) {
    if (params[field] !== undefined && typeof params[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  if (params.agent_identity_ids !== undefined && (!Array.isArray(params.agent_identity_ids) || params.agent_identity_ids.length < 1 || params.agent_identity_ids.length > 200)) throw new Error('agent_identity_ids must contain 1..200 IDs');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, granularity })) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!['page_size', 'group_by_agent', 'group_by_model'].includes(key) && (typeof item !== 'string' || !item || item.length > 8192)) throw new Error('Invalid usage filter');
      query.append(key, String(item));
    }
  }
  return query;
}

export async function queryUsage(params, { env = process.env, fetchImpl = fetch } = {}) {
  const query = usageQuery(params);
  const secret = env.COCO_USAGE_API_KEY;
  if (!secret || /\s/.test(secret)) throw new Error('Set COCO_USAGE_API_KEY to a dedicated usage credential');
  let url;
  try { url = new URL(env.COCO_API_URL); } catch { throw new Error('Set COCO_API_URL to the Core HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('COCO_API_URL must be an HTTPS origin without credentials, path, query or fragment');
  url.pathname = '/api/public/v1/billing/usage';
  url.search = query.toString();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('Usage request failed (network, redirect or timeout)'); }
  if (!response.ok) {
    // Never echo upstream bodies: a proxy may reflect Authorization headers.
    const error = Object.assign(new Error(`Usage request failed (HTTP ${response.status})`), { status: response.status });
    const retry = response.headers.get('retry-after');
    if (response.status === 429 && /^\d{1,6}$/.test(retry ?? '')) error.retry_after = Number(retry);
    throw error;
  }
  try {
    const body = await response.text();
    const result = JSON.parse(body);
    if (JSON.stringify(result).includes(secret)) throw new Error('Credential reflected');
    return result;
  } catch { throw new Error('Invalid usage response'); }
}

export async function runCli(args = process.argv.slice(2)) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log(`Usage: node src/cli/usage.js usage.query '<json-params>'
Required: range_start, range_end (RFC3339). Optional: granularity (hour/day),
agent_identity_id OR agent_identity_ids (array, max 200), model_key, usage_kind,
page_size (1..2000), cursor, group_by_agent, group_by_model.
Environment: COCO_API_URL (HTTPS origin), COCO_USAGE_API_KEY (dedicated key).
Returns one unmodified JSON page including metadata. Pass the returned cursor
with the same filters for the next page. No automatic retries or aggregation.
Draft: Core query adapter/SDK and public response contract are not yet ready.`);
    return;
  }
  try {
    if (args[0] !== 'usage.query') throw new Error('Unknown usage command');
    let params;
    try { params = JSON.parse(args.slice(1).join(' ')); } catch { throw new Error('Invalid JSON parameters'); }
    console.log(JSON.stringify(await queryUsage(params), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, status: error.status, retry_after: error.retry_after }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
