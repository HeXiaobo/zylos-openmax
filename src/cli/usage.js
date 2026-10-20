#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const FIELDS = new Set(['range_start', 'range_end', 'granularity', 'agent_identity_id',
  'agent_identity_ids', 'model_key', 'usage_kind', 'page_size', 'cursor',
  'group_by_agent', 'group_by_model']);

export function parseUsageArgs(args, now = Date.now()) {
  if (!args[0]?.startsWith('--')) {
    try { return JSON.parse(args.join(' ')); } catch { throw new Error('Invalid JSON parameters'); }
  }
  const options = Object.fromEntries(['granularity', 'last', 'group-by', 'range-start',
    'range-end', 'agent-identity-id', 'model-key', 'usage-kind', 'page-size', 'cursor']
    .map(name => [name, { type: 'string' }]));
  options['agent-identity-ids'] = { type: 'string', multiple: true };
  let parsed;
  try { parsed = parseArgs({ args, options, strict: true, allowPositionals: false, tokens: true }); }
  catch { throw new Error('Invalid usage options; run usage.js --help'); }
  const names = parsed.tokens.map(token => token.name).filter(name => name !== 'agent-identity-ids');
  if (new Set(names).size !== names.length) throw new Error('Duplicate usage option');
  const values = parsed.values;
  const params = {};
  for (const [key, value] of Object.entries(values)) {
    if (!['last', 'group-by'].includes(key)) params[key.replaceAll('-', '_')] = value;
  }
  if (values['page-size'] !== undefined) {
    if (!/^\d+$/.test(values['page-size'])) throw new Error('page_size must be 1..2000');
    params.page_size = Number(values['page-size']);
  }
  if (values['group-by'] !== undefined) {
    if (!['organization', 'agent', 'model', 'agent,model'].includes(values['group-by'])) throw new Error('group-by must be organization, agent, model or agent,model');
    params.group_by_agent = values['group-by'].split(',').includes('agent');
    params.group_by_model = values['group-by'].split(',').includes('model');
  }
  if (values.last !== undefined) {
    if (values['range-start'] !== undefined || values['range-end'] !== undefined) throw new Error('last cannot be combined with explicit ranges');
    if (values.cursor !== undefined) throw new Error('Use fixed range-start/range-end with cursor to keep pagination stable');
    const match = /^([1-9]\d*)(h|d)$/.exec(values.last);
    if (!match) throw new Error('last must be a positive whole duration such as 24h or 7d');
    params.granularity ??= 'hour';
    if (!['hour', 'day'].includes(params.granularity)) throw new Error('granularity must be hour or day');
    if (params.granularity === 'day' && match[2] !== 'd') throw new Error('Daily last ranges must use whole days');
    const duration = Number(match[1]) * (match[2] === 'h' ? 3600000 : 86400000);
    const maximum = (params.granularity === 'hour' ? 7 : 90) * 86400000;
    if (!Number.isFinite(duration) || duration > maximum) throw new Error('Relative usage range exceeds granularity limit');
    if (!Number.isFinite(now)) throw new Error('Invalid current time');
    const bucket = params.granularity === 'hour' ? 3600000 : 86400000;
    const offset = params.granularity === 'day' ? 8 * 3600000 : 0;
    const end = Math.floor((now + offset) / bucket) * bucket - offset;
    params.range_start = new Date(end - duration).toISOString();
    params.range_end = new Date(end).toISOString();
  }
  usageQuery(params);
  return params;
}

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
  const bucket = granularity === 'hour' ? 3600000 : 86400000;
  const offset = granularity === 'day' ? 8 * 3600000 : 0;
  for (const field of ['range_start', 'range_end']) {
    if ((Date.parse(params[field]) + offset) % bucket !== 0 ||
        /\.\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/.test(params[field])) {
      throw new Error('Usage ranges must align to UTC hours or Beijing midnight');
    }
  }
  if (params.usage_kind !== undefined && !['model', 'runtime'].includes(params.usage_kind)) throw new Error('usage_kind must be model or runtime');
  if (params.agent_identity_id !== undefined && params.agent_identity_ids !== undefined) throw new Error('Agent filters are mutually exclusive');
  if (params.page_size !== undefined && (!Number.isInteger(params.page_size) || params.page_size < 1 || params.page_size > 2000)) throw new Error('page_size must be 1..2000');
  for (const field of ['group_by_agent', 'group_by_model']) {
    if (params[field] !== undefined && typeof params[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  if (params.agent_identity_ids !== undefined && (!Array.isArray(params.agent_identity_ids) || params.agent_identity_ids.length < 1 || params.agent_identity_ids.length > 200)) throw new Error('agent_identity_ids must contain 1..200 IDs');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, granularity })) {
    const values = key === 'agent_identity_ids' ? value : [value];
    for (const item of values) {
      const maximum = key === 'cursor' ? 4096 : 512;
      if (!['page_size', 'group_by_agent', 'group_by_model'].includes(key) && (typeof item !== 'string' || !item || Buffer.byteLength(item) > maximum)) throw new Error('Invalid usage filter');
      query.append(key, String(item));
    }
  }
  return query;
}

const CREDENTIAL_HINT = 'a billing.usage.read credential created by the organization Owner in the workspace '
  + 'frontend (Account → Points panel → usage credentials); see references/usage-operations.md';

// COCO_API_URL is the same HTTPS origin as config.json server.bff_url. When the
// variable is unset, fall back to that configured value — but only when it is
// already HTTPS, so a local http:// default never carries the usage key.
export async function resolveUsageOrigin(env = process.env, config = undefined) {
  if (env.COCO_API_URL) return env.COCO_API_URL;
  let cfg = config;
  if (!cfg) {
    try { cfg = (await import('../lib/config.js')).loadConfig(); } catch { return undefined; }
  }
  const bff = cfg?.server?.bff_url;
  return typeof bff === 'string' && bff.startsWith('https://') ? bff : undefined;
}

export async function queryUsage(params, { env = process.env, fetchImpl = fetch, config = undefined } = {}) {
  const query = usageQuery(params);
  const secret = env.COCO_USAGE_API_KEY;
  if (!secret || /\s/.test(secret)) throw new Error(`Set COCO_USAGE_API_KEY to ${CREDENTIAL_HINT}`);
  let url;
  try { url = new URL(await resolveUsageOrigin(env, config)); } catch { throw new Error('Set COCO_API_URL to the Core HTTPS origin (same origin as config.json server.bff_url, e.g. https://your-core-host.example)'); }
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
  if (!args.length || ['help', '--help', '-h'].includes(args[0]) ||
      (args[0] === 'usage.query' && args.length === 2 && ['--help', '-h'].includes(args[1]))) {
    console.log(`Usage: node src/cli/usage.js usage.query --granularity hour --last 7d --group-by agent
   or: node src/cli/usage.js usage.query '<json-params>'
Flags: --range-start, --range-end, --granularity, --last (Nh/Nd), --group-by
(organization/agent/model/agent,model), --agent-identity-id, --agent-identity-ids
(repeatable), --model-key, --usage-kind, --page-size, --cursor.
Relative ranges exclude the current bucket; hours align to UTC (max 168h/7d),
days to Beijing midnight UTC+08:00 (max 90d, whole days only). --last defaults
to hour granularity. Explicit ranges require RFC3339 with the same alignment.
Use explicit fixed ranges with --cursor, not --last; keep all filters unchanged.
JSON required: range_start, range_end (RFC3339). Optional: granularity (hour/day),
agent_identity_id OR agent_identity_ids (array, max 200), model_key, usage_kind,
page_size (1..2000), cursor, group_by_agent, group_by_model.
Environment: COCO_API_URL (HTTPS origin), COCO_USAGE_API_KEY (dedicated key).
Run from the OpenMax directory. COCO_API_URL is the same HTTPS origin as
config.json server.bff_url (no path/query/userinfo); when unset, the CLI
falls back to that configured value if it is already https://.
COCO_USAGE_API_KEY is a billing.usage.read credential that the organization
Owner creates in the workspace frontend (Account → Points panel); it is not
the Agent's own key or JWT. Supply it via a private process environment or
secret manager. Details: references/usage-operations.md.
Interactive Bash setup (does not print the key or put its value in history):
  read -rsp 'Usage API key: ' COCO_USAGE_API_KEY
  export COCO_USAGE_API_KEY
  printf '\\n'
  export COCO_API_URL='https://your-core-host.example'
Never put keys in arguments, URLs, shared logs, source files or chat replies.
No agent-key/JWT fallback, key storage, token refresh or redirects.

Returns one JSON page with the full envelope and exact string counters/decimals.
Read freshness, coverage, pending-work and incomplete markers before reporting
totals. Completed time buckets may still have pending charges; empty rows do
not prove zero usage. Do not mix token/image/minute units or drop metadata.
Use usage-kind model/runtime. Agent filters are mutually exclusive, max 200 IDs.
No automatic retries, aggregation or pagination; request timeout is 30 seconds.
Errors are JSON on stderr, exit 1; HTTP status is preserved:
  400/422: check range alignment, filter types/lengths and page size.
  401: check dedicated key and origin. Ask the organization Owner to provide a
       valid key or explicitly rotate/recreate it; this CLI cannot recover keys.
  403/404: verify access, organization/feature availability; do not change auth.
  409: projection revision changed; discard collected pages and restart the
       same fixed query without cursor. Do not combine different revisions.
  429: wait retry_after seconds when returned before a deliberate retry.
  503: service/dependency unavailable; report unavailable, not zero usage.
Response metadata: data.next_cursor, data.revision, data.covered_from,
data.covered_until, data.refreshed_at, data.pending_dirty_count,
data.oldest_pending_at (optional), data.provisional; request_id and server_time
are envelope fields. Missing token/image counts are per-row string counters.
Core's public adapter is implemented. Availability still depends on deployment,
organization activation and projection readiness; no live CLI E2E is claimed.
Full guidance: references/usage-operations.md`);
    return;
  }
  try {
    if (args[0] !== 'usage.query') throw new Error('Unknown usage command');
    const params = parseUsageArgs(args.slice(1));
    console.log(JSON.stringify(await queryUsage(params), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, status: error.status, retry_after: error.retry_after }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
