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

## Workspace Computer Use enrollment

For a fresh Agent, set `COMPUTER_REMOTE_ENROLLMENT_VERSION` in the Agent process
environment or in `~/zylos/.env` to the exact
stable tag of an official `zylos-ai/zylos-computer-remote` GitHub release
that the operator has verified includes Workspace enrollment. Releases
through `v0.1.6` predate enrollment. Until a supported release is available,
use a separately provisioned enrollment-capable Remote in a test environment.
The pin opts the Agent into acquisition from the official GitHub repository
on an authorized Workspace request. An already installed service keeps its
version. The Agent also validates the HTTPS device route before returning a
ticket.

Revocation can restart a stopped installed Remote. If the enrollment route
is absent and the authenticated device inventory is empty, a legacy Remote
can finish revocation without clearing any devices. A nonempty inventory
can contain credentials retained from a downgrade, so revocation remains
pending until an enrollment-capable Remote can confirm removal.

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
Dashboard API key described in `src/lib/dashboard-client.js`. If any of these
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

## Scheduled-task inventory

Every ~60 seconds the bridge collects this machine's scheduled tasks and, when
they changed, PUTs them to `PUT /api/v1/agents/{member_id}/inventory/tasks` of
the primary org (the org runtime-metrics goes to), so the Agent's owner sees
them on the Agent's page in Workspace. An unchanged snapshot is sent again
every 5 minutes as a heartbeat, with fresh read times.

- zylos scheduler tasks: the local Dashboard's `GET /api/schedules` (same
  Dashboard API key as runtime metrics); `GET /api/schedules/:id` and
  `/api/schedules/:id/history?limit=30` only for a task whose list row
  changed. One-time tasks delivered more than 7 days ago are left out.
  When the Dashboard cannot list them (zylos core 0.9.x: its Dashboard has
  no `/api/schedules`; also no Dashboard, no session token or a timeout),
  the scheduler's own database `<zylos>/scheduler/scheduler.db` is read
  instead, read-only (`src/lib/scheduler-db-read.js`: the same data file
  and list order as the core 1.0 Dashboard, the inventory's 7-day window
  applied in SQL; names, full instructions and the last 30 runs of every
  task in one read). It is opened with Node's built-in `node:sqlite` (Node
  ≥ 22.13), else the better-sqlite3 zylos installed for its comm-bridge or
  scheduler skill — never a dependency of this plugin. The Dashboard is
  still tried first on every tick.
- the user crontab: `crontab -l`; next runs are computed in the machine's
  time zone (`src/lib/cron-expr.js`).

Names, instructions, cron commands, error texts and group names are redacted
on the machine before upload (`src/lib/text-redact.js`: chat/user ids,
UUIDs, long numeric ids, email addresses, tokens, keys, passwords — including
`Authorization` values, `-u user:pass`, mysql `-p…`, `redis-cli -a`, `sshpass
-p`, `docker|podman login -p`, `smbclient -U user%pass`, `lftp -u user,pass`,
`ldap… -w`, `zip -P`, `7z -p…`, `openssl -k`/`pass:`, `aws configure set`,
webhook URL tokens and `?key=`/`&sig=` parameters — and home paths). Only
the field limit plus a margin of a huge text is redacted, and the last,
possibly cut, line of that part is never shown. Delivery targets carry the
channel, the group's display name and group/DM only.

Redaction is a heuristic. Known gaps: credentials in prose ("the password is
hunter2"), an unknown `Authorization` scheme followed by a plain word,
command flags not listed above, and a password containing `;`, `|` or `&`
inside a quoted shell argument (the command is read per shell segment). Known
over-redaction: a credential-looking word after `Authorization:`, `--key
<file>` / `-key <file>`, a key like `PWD=…`, a named `-u user:group`
(`docker run -u postgres:postgres`), an ssh destination without a path
(`deploy@prod.example.com` reads as an email), and a 16+ character
…/hook(s)/… path with digits (dated paths included). An all-digit
`-u 12345:987654` stays as written (it reads like uid:gid). A
source that cannot be read is reported `failed` with its previous tasks. A
404 from the server (route not deployed) stops the report until restart.
Turn it off with `"taskInventory": {"enabled": false}` in `config.json`.

## License

UNLICENSED
