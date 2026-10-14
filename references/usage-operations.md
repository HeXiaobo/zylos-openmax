# Usage queries (Draft)

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

Filters use the Core draft snake_case names: `agent_identity_id` or
`agent_identity_ids` (array of up to 200), `model_key`, `usage_kind`,
`group_by_agent`, `group_by_model`. Hourly ranges allow up to 7 days; daily
ranges up to 90. `page_size` is 1..2000. Core remains authoritative for time
alignment and filter semantics.

Output preserves the complete JSON envelope, rows, projection freshness,
coverage and incompleteness metadata, and string-valued counters and decimals.
There is no summation across units or automatic pagination. Pass the server's
cursor as `cursor` with otherwise unchanged filters to request the next page.
The command makes one request with a 30-second timeout. Errors are JSON on
stderr and exit 1. HTTP status is retained; 429 includes numeric `retry_after`
when available. Requests are not automatically retried.

## Dependency blockers

Billing !465 and Core !819 are not yet a released public query API. Core !819
currently authenticates and rate-limits this path, then returns 503. Its public
DTO, Billing SDK adapter, and response mapping remain incomplete. This client
uses the agreed draft query names; array IDs are repeated query parameters.
Confirm this encoding and the response cursor location against the finalized
Core DTO before removing Draft. No public SDK is pinned or published here.
Local mocked-transport tests are not real-service acceptance or E2E evidence.
Production load, projection freshness, and deployment readiness remain outside
this CLI change. No release, installed component update, or deployment is included.
