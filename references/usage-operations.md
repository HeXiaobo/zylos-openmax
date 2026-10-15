# Usage queries (Draft)

Discovery: `node src/cli/usage.js --help` (also `usage.query --help`) works
without credentials or network requests. Translate the user's natural-language
request into these supported options; endpoint assembly belongs to this CLI.

Run `node src/cli/usage.js usage.query '<json-params>'` to read one page of
organization usage with a dedicated `billing.usage.read` credential.
The organization is resolved by Core from that credential. Agent API keys and
human JWTs are not substitutes. This command does not create or rotate keys.

Provide `COCO_API_URL` as the Core HTTPS origin and `COCO_USAGE_API_KEY` through
your secret manager or private process environment. Do not place the key in
command arguments, JSON, URLs, checked-in files, or shared logs. The CLI does
not save it, read normal agent credentials, refresh tokens, or follow redirects.

Example (with the environment already populated):

```sh
node src/cli/usage.js usage.query --granularity hour --last 7d --group-by agent
```

For Bash, set the key without putting its value in shell history or printing it:

```bash
read -rsp 'Usage API key: ' COCO_USAGE_API_KEY
export COCO_USAGE_API_KEY
printf '\n'
export COCO_API_URL='https://your-core-host.example'
```

Run from the OpenMax checkout/component directory. No globally installed binary
is introduced. The URL must be your actual Core HTTPS origin, without a path.
`--last 7d` queries the preceding seven complete days of hourly buckets, ending
at the current UTC hour boundary. It excludes the current partial hour. With
`--granularity day`, durations must use whole days and end at the most recent
Beijing midnight (UTC+08:00); timestamps sent to Core are UTC. Hourly ranges
allow 1..168 hours, daily ranges 1..90 days. Omitted granularity with `--last`
defaults to `hour`. `--group-by` accepts `organization`, `agent`, `model`, or
`agent,model`. Other flags mirror the JSON field names with hyphens; repeat
`--agent-identity-ids` for multiple IDs.

For pagination, use fixed `--range-start` and `--range-end` with `--cursor`.
Combining `--last` and `--cursor` is rejected because a moving relative range
could cross a bucket boundary and invalidate the cursor. The JSON form remains
supported:

```sh
node src/cli/usage.js usage.query '{"range_start":"2026-10-01T00:00:00Z","range_end":"2026-10-02T00:00:00Z","granularity":"hour","group_by_agent":true,"page_size":100}'
```

Filters use the Core public snake_case names: `agent_identity_id` or
`agent_identity_ids` (array of up to 200), `model_key`, `usage_kind`,
`group_by_agent`, `group_by_model`. Hourly ranges allow up to 7 days; daily
ranges up to 90. `page_size` is 1..2000. Core remains authoritative for time
alignment and filter semantics. Agent IDs and model keys are at most 512 UTF-8
bytes; cursors are at most 4096 bytes. The CLI checks bucket alignment and these
bounds before sending. Core also rejects ranges extending beyond the current
bucket. Omitted JSON granularity defaults to `day`, so use Beijing midnight
boundaries or explicitly select `hour`.

Output preserves the complete JSON envelope, rows, projection freshness,
coverage and incompleteness metadata, and string-valued counters and decimals.
There is no summation across units or automatic pagination. Pass the server's
`data.next_cursor` as `cursor` with otherwise unchanged filters to request the
next page. An empty `data.next_cursor` ends pagination. Keep the same
`data.revision` throughout a paginated result.
The command makes one request with a 30-second timeout. Errors are JSON on
stderr and exit 1. HTTP status is retained; 429 includes numeric `retry_after`
when available. Requests are not automatically retried.

Read the returned freshness, actual coverage, pending work, and incomplete
markers before interpreting totals. A completed time bucket does not prove
all upstream charges have arrived. Empty rows are not proof of zero usage;
retain any warning or incomplete metadata in the user-facing result. Do not
sum unlike units (tokens, images, minutes). `usage_kind` accepts `model` or
`runtime`. Exact decimals and token counters remain strings.

The final Core response contains `data.rows`, `data.next_cursor`, `data.revision`,
`data.covered_from`, `data.covered_until`, `data.refreshed_at`,
`data.pending_dirty_count`, optional `data.oldest_pending_at`, and
`data.provisional`. `request_id` and `server_time` are envelope fields.
`pending_dirty_count` and `revision` are strings, not JavaScript numbers.
Per-row `missing_token_events` and `missing_image_events` are string counters
that must be retained when reporting incomplete measurements. A provisional
result or pending work means the projection may still change; coverage and
freshness must be checked even if rows are empty.

## Error recovery

- 400/422: correct query validation errors: bucket alignment, range bounds,
  filter types and lengths, or page size. Do not retry the same invalid query.
- 401: verify the dedicated key and correct Core origin. Request a valid key
  from the organization Owner. If the key is lost or revoked, the Owner must
  explicitly rotate/recreate it in credential management. The CLI cannot
  recover plaintext, regenerate a key, or substitute an Agent key/JWT.
- 403/404: verify organization access and feature availability. Do not bypass
  authorization or change the target organization through query parameters.
- 409: the projection revision changed. Discard previously collected pages and
  restart the same fixed query without `cursor`. Do not combine old and new
  revisions. The CLI does not automatically restart or aggregate pages.
- 429: wait the returned numeric `retry_after` seconds before a deliberate
  retry. If absent, report the limit instead of entering a tight retry loop.
- 503: report service/dependency or projection unavailability, not zero usage.
  Verify organization activation and projection readiness with operations.
- Network/timeout or invalid JSON response: report failure; never print raw
  upstream bodies, headers or credentials to diagnose it.

Credentials are entered separately from the user's query and must not be
echoed in chat replies or copied into reusable command examples. Agents should
use a secret manager/private environment; the Bash prompt above is for a
human's interactive terminal, not an instruction to block an agent pipeline.

## Delivery status

Core !823 implements the public query DTO, Billing SDK adapter, and response
mapping. This CLI matches merge `ea837fc915ba52753c0ca0bb825fb95446c402fc`:
array IDs use repeated query parameters and pagination uses `data.next_cursor`.
Core is deployed to Int; availability for a specific organization still depends
on Billing activation, backfill, and projection readiness. Billing !469 supplies
activation support, but its delivery does not prove that every organization is
ready. No public SDK is pinned or published by this CLI.
Local mocked-transport tests are not real-service acceptance or E2E evidence.
Production load, projection freshness, and deployment readiness remain outside
this CLI change. No release, installed component update, or deployment is included.
