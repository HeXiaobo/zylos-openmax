# zylos-openmax

OpenMax integration plugin for [Zylos](https://git.coco.xyz/zylos-ai/zylos-core) agents.

Provides unified IM communication (WebSocket bridge), service CLIs (TM/KB/AS/Comm/Core/Channel/Usage), and Lead/Worker behavioral lifecycle via progressive skill loading.

## Quick Start

```bash
zylos install openmax
```

## Architecture

- **Communication Module** — PM2 service (`src/comm-bridge.js`), bridges WebSocket messages to C4
- **Service CLIs** — Stateless JSON in/out (`src/cli/{tm,kb,as,comm,core,channel}.js`)
- **Usage CLI** (built in since v2.26.0) — Organization usage queries with a dedicated `billing.usage.read` key and explicit cursor pagination (`src/cli/usage.js`); needs `COCO_API_URL` + `COCO_USAGE_API_KEY`, see [usage operations](references/usage-operations.md).
- **Skill Layer** — `SKILL.md` (L1+L2 always loaded) + `references/*.md` (L3 on demand)

## Development

```bash
npm install
npm start
```

Requires Node.js 20+.

## Readiness and runtime metrics

The installed Core package version selects the sources, before any request,
by semver precedence including the pre-release part (`1.0.0-beta.2` <
`1.0.0-beta.12` < `1.0.0`). The Dashboard object APIs
(`skills/dashboard/docs/api.md` in zylos-core) are used from **Core
1.0.0-beta.12** on, including 1.0.0 and later 1.x; the earlier Dashboard paths
(`/api/state`, `/api/health?probe=ready`) are gone there and are not requested.

Every earlier Core keeps the current reads, unchanged:

- Core 1.0.0-beta.1 to beta.11: readiness from `GET /api/health?probe=ready`,
  runtime metrics from `GET /api/state` plus the cgroup.
- Core 0.x: the original monitor/session-file readiness checks, and
  `GET /api/state` plus the cgroup for runtime metrics.
- A Core version that cannot be read: readiness `core_version_unknown`, and
  `GET /api/state` plus the cgroup for runtime metrics.

This is a choice made before the request, not a fallback: once the object APIs
are selected, a failed read is not retried on an earlier path.

On Core 1.0.0-beta.12 or later:

Runtime metrics read `GET /api/instance`, `/api/groups/counts`,
`/api/usage/summary` and, in single-session mode, `/api/groups/origin`, with the
Dashboard API key described in `src/lib/metrics-reporter.js`. If any of these
reads fails (connection, any non-2xx status including 404, five-second timeout,
unreadable or malformed body), that report is skipped and the next tick reads
again; nothing else is read instead. The field sources are listed at
`payloadFromObjects` in that file and in the CHANGELOG.

Readiness comes from the unauthenticated local Dashboard endpoint
`GET /api/health/ready` (on Core 1.0.0-beta.1 to beta.11,
`GET /api/health?probe=ready`, read the same way as below). The port comes from
the existing Dashboard `components/dashboard/config.json` (default 3470).
Unavailable or invalid responses report not ready instead of falling back to
obsolete files. Requests, including the response body, have a five-second
timeout. A reachable HTTP 200 response without `ready` reports
`probe_unsupported`; transport failures and other statuses (including 404)
remain `dashboard_unavailable`.

HTTP 200 reports the existing `ready` stage, including multi-session instances
with no running sessions. HTTP 503 maps `supervisor_unavailable` to
`runtime_down` and single-mode `session_not_running` to `runtime_up`. The reported
readiness fields and existing report/trigger intervals are unchanged.

Onboarding additionally waits for the configured runtime's `auth_failed`, `down`
or `unavailable` health explicitly reported by a health record. All other cases,
including missing/unreadable records, an unknown runtime, `ok`, `rate_limited`
and `recovering`, release onboarding immediately. Core writes records only on
health transitions and treats missing records as ok; absence does not establish
unhealthy status or login history. The existing maximum wait still permits
reporting after an explicit health failure. An explicitly absent single session
does not fail open. Multi mode needs no session belonging to the current launch. No new
configuration, watcher, cache or persistent state is added.

## License

UNLICENSED
