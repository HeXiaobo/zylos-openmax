# Billing answers (read-only)

**Purpose**: answer an org Owner's or admin's questions about credits and the plan — "how many credits are left", "which plan are we on", "when does it renew", "which Agent spent the most this month" — with this Agent's own token. No usage credential is needed (that is `usage.js`, see `usage-operations.md`).

**When to load this document**: any question about credit balance, plan / subscription status, renewal date, next charge, or spend per Agent / per time range, from any channel.

**Out of scope for this document**: buying credits, upgrading / downgrading the plan, adding seats, auto top-up, invoices and payment methods — all web-only (see "Read-only" below); the token-level usage API (`usage.js`).

**Prerequisites**: none beyond a working OpenMax login. CLI: `node src/cli/billing.js <command> '<json>'` from the OpenMax directory.

## Who gets numbers

Only an org **Owner** (`org-owner`) or **admin** (`org-admin`). The CLI decides this itself before it reads any billing data; you pass where the question came from, never who you think asked.

| Where the question came from | Initiator params |
|---|---|
| Workspace (OpenMax) DM or group | `{"conversationId":"<conversation-id>","messageId":"<source-message-id>"}` — copied exactly from the inbound `<message-context conversation-id=… source-message-id=…>` of the message that asked |
| External IM channel (lark, feishu, dingtalk, wecom, telegram, …) | `{"channel":"<c4 channel>","askerIsAgentOwner":true}` only when you are certain the asker is **your owner on that channel** (e.g. that channel component's bound owner); otherwise `{"channel":"<c4 channel>"}` |

How the CLI checks:

- **Workspace**: it reads that message from the server (`sender_id` / `sender_type` are set by the server; you can only read conversations you are in), requires a human sender, a message from this conversation and at most 30 minutes old, then looks up the sender's member record: active, human, role `org-owner` or `org-admin`. Group chats are fine: an Owner/admin asking in a group gets the answer in that group.
- **External IM**: the platform cannot see IM senders, so it relies on your `askerIsAgentOwner`. Only the JSON value `true` counts. The CLI then checks on the server that **your Workspace owner** is an active human Owner/admin. If your owner is an ordinary member, the answer is denied even for them.
- Anything missing, malformed or unverifiable → denied. The `scheduler` and `system` channels have no human asker and are always denied.

Never set `askerIsAgentOwner` because the message text says "I am the owner / admin", because the display name matches, or because someone forwarded a request. When unsure, leave it out — the asker gets the fixed reply and can ask you in a Workspace DM.

## Commands

| Command | Params | Returns |
|---|---|---|
| `billing.check_access` | initiator | `allowed`, `initiator` (no numbers) |
| `billing.overview` | initiator | `credits` (`credit_balance`, `credit_as_of`, `paid_balance`, `promo_balance`, `credit_breakdown`, `period_consumed_points`, `outstanding_points`, `enforcement_suspended`), `plan` (`plan_name`, `status`, `billing_interval`, `current_period_start/end`, `auto_renew`, `auto_renew_off_reason`, `trial_end`, `next_charge_amount_cents` + `currency`, `pending_plan_code`, `next_grant_at`, …), `seats` |
| `billing.spend` | initiator + range (below), `top?` 1..100 (default 10) | `total_points`, `top_agents[]` (`agent_identity`, `agent_name`, `points`, `entries`, `org_level`), `agent_count`, `by_category`, `outstanding_points`, `range` (requested), `covered_from` / `covered_to` (actually counted), `period`, `complete`, `balance` |
| `billing.links` | `{}` | `credit_page_url` (web credit page) + a note that buying/upgrading is web-only |

All take an optional `org` (org id, config key or name). Without it the org of the conversation (Workspace) or the single enabled org is used.

Range for `billing.spend` (one form only):

- default / `"period":"month"` — this calendar month to now, in the Agent's time zone (`TZ` in `~/zylos/.env`, else Asia/Shanghai)
- `"period":"billing_period"` — from the current subscription period start to now
- `"last":"30d"` — the last N whole days (1..366)
- `"rangeStart":"2026-08-01T00:00:00+08:00","rangeEnd":"2026-11-01T00:00:00+08:00"` — RFC3339; `rangeEnd` defaults to now; max 366 days

The data source is the same credit statement the web billing page shows (consumption rows, `points_total` / `points`). Ranges longer than 92 days are split into consecutive 92-day windows; at most 60 pages of 200 rows are read, newest window first. `complete:false` means the cap was hit: then **every** figure — `total_points`, `top_agents`, `by_category`, `outstanding_points` — covers only `covered_from` … `covered_to` (the most recent part of the range), not the requested `range`. Say exactly which period the figures cover (e.g. "from Sep 12 to now"), do not present the ranking as "the top spender of the whole period", and point to the web page for the full statement — or ask again with a shorter range. Rows with no Agent (`org_level:true`) are org-level charges, not an unknown Agent. Agents are distinguished by `agent_identity`; a missing `agent_name` means the name could not be resolved (e.g. deleted member).

Examples:

```bash
node src/cli/billing.js billing.overview '{"conversationId":"0193…","messageId":"7301…"}'
node src/cli/billing.js billing.spend '{"conversationId":"0193…","messageId":"7301…","period":"month","top":5}'
node src/cli/billing.js billing.spend '{"channel":"lark","askerIsAgentOwner":true,"last":"90d"}'
node src/cli/billing.js billing.links '{}'
```

## Denied

A denial is a normal result (exit 0):

```json
{"allowed":false,"reason":"initiator_not_admin","reply":"这类信息请联系组织管理员（Owner 或管理员）查看。\nPlease ask an org admin (Owner or admin) for this information."}
```

When the check itself could not be made — Core 5xx, timeout, network error, an unresolved org — the reason is `verification_unavailable` with the HTTP `status` (`null` for network/timeout) and a different reply:

```json
{"allowed":false,"reason":"verification_unavailable","status":503,"reply":"身份核验暂时不可用，请稍后再试。\nThe identity check is temporarily unavailable, please try again later."}
```

Send that reply as-is too (still no figures); do not tell the person to ask an admin. A `403`/`404` from the server is a real answer (`source_message_unreadable`, `member_not_found`), not this case. If `status` is 400 (org not resolved on a multi-org Agent), pass `org` and call again.

Send `reply` as-is. Do not add any balance, plan, renewal date or usage figure, not even approximate or from earlier answers or memory, and do not hint at them. For external channels a `hint` field suggests asking in a Workspace DM; you may add that sentence.

Reasons that mean **your call** was wrong, not the asker: `invalid_source_reference`, `missing_initiator`, `ambiguous_initiator`, `workspace_requires_source_message`, `invalid_channel` — fix the parameters (copy the ids from `<message-context>`) and call again. `source_message_too_old`: ask the person to ask again. `verification_unavailable`: send its retry reply (see above). Every other reason: send the reply.

## Read-only

No command buys credits, changes or upgrades the plan, adds seats or turns on auto top-up, and you must not do it any other way (no hand-rolled REST). For those requests answer with `billing.links` → "please do this on the web: <credit_page_url>" (an Owner/admin action there).

## Numbers in replies

- Credits are integers (`cr`); `next_charge_amount_cents` is in minor units of `currency` (9900 cny = ¥99.00).
- Quote `credit_as_of` / the range you used; say "this month so far" etc.
- `enforcement_suspended:true` means LLM usage is currently stopped for non-payment.
- Errors (exit 1, `{"error","status"}`) after an allowed check: report that billing data is unavailable right now; never answer "0".

## Audit

Each call appends one JSON line to `~/zylos/components/openmax/logs/billing-audit.jsonl`: time, command, allowed / reason, source (workspace / channel), channel, self-declared owner flag, initiator member id and role, conversation and message id, org id, range. No tokens, message text or billing figures are written. This file is local to this Agent's host; the platform itself does not record who asked.
