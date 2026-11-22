# Billing answers (read-only)

**Purpose**: answer an org Owner's or admin's questions about credits and the plan — "how many credits are left", "which plan are we on", "when does it renew", "which Agent spent the most this month" — with this Agent's own token. No usage credential is needed (that is `usage.js`, see `usage-operations.md`).

**When to load this document**: any question about credit balance, plan / subscription status, renewal date, next charge, or spend per Agent / per time range, from any channel.

**Out of scope for this document**: buying credits, upgrading / downgrading the plan, adding seats, auto top-up, invoices and payment methods — all web-only (see "Read-only" below); the token-level usage API (`usage.js`).

**Prerequisites**: none beyond a working OpenMax login. CLI: `node src/cli/billing.js <command> '<json>'` from the OpenMax directory.

## Who gets numbers

Only an org **Owner** (`org-owner`) or **admin** (`org-admin`). The CLI decides this itself before it reads any billing data; you pass where the question came from, never who you think asked.

- **Workspace (OpenMax)**: by the asker's own role — an Owner/admin gets numbers in a DM **and** in a group.
- **External IM channels (Lark, Feishu, Telegram, Slack, …)** — product decision d159 (option B): numbers **only in a private chat (DM) with this Agent's bound owner on that channel**, and only if your Workspace owner is an active org Owner/admin. A group chat — **even when your owner asks there** — or anyone else asking gets the fixed reply 「这类信息请到 Workspace 里问我，或找组织管理员」 and no billing request is made.

| Where the question came from | Initiator params |
|---|---|
| Workspace (OpenMax) DM or group | `{"conversationId":"<conversation-id>","messageId":"<source-message-id>"}` — copied exactly from the inbound `<message-context conversation-id=… source-message-id=…>` of the message that asked |
| External IM channel (lark, feishu, dingtalk, wecom, telegram, slack, …) | `{"channel":"<channel>","endpoint":"<endpoint>"}` — both copied **verbatim** from the inbound message's `reply via: node …/c4-send.js "<channel>" "<endpoint>"` line (the whole endpoint, including `type:` / `msg:` parts). Always pass it, for DMs and groups alike; the CLI decides. |

How the CLI checks:

- **Workspace**: it reads that message from the server (`sender_id` / `sender_type` are set by the server; you can only read conversations you are in), requires a human sender, a message from this conversation and at most 30 minutes old, then looks up the sender's member record: active, human, role `org-owner` or `org-admin`. Group chats are fine: an Owner/admin asking in a group gets the answer in that group.
- **External IM**: the CLI applies the same owner-DM rules as the ops push owner lookup (cws-agent-ops `ownerdm.go`, a port of this plugin's `im-owner-notice.js`):
  1. **Private chat?** From the endpoint: `type:p2p` (lark, feishu, dingtalk, wecom, whatsapp), `type:dm` (slack, line, ms-teams, whatsapp-business), a positive chat id (telegram), `|to:` (wechat); discord / zalo by the stored message's `[DISCORD DM]` / `[Zalo DM]` prefix. `type:dm-pairing`, `web-console`, `shell` and unknown channels are never a DM.
  2. **A real, recent message?** The endpoint must be an inbound message of that channel in the local message store, at most 30 minutes old.
  3. **Your bound owner?** Positive evidence from that channel component's `config.json` `owner` binding (and, for lark / feishu / slack / discord, the component's own message log for that `msg:` id); wechat: the account's QR scanner, else a single-user allowlist. Lark / Feishu: the owner's log file is found even when the app lacks the "get user ID" permission (private-chat logs then land in `null.log` / `undefined.log`) or the owner was bound with only an `open_id`; group-chat logs (`oc_…`) and the component's PM2 process logs (`out.log` / `error.log` and rotated variants) are never used as evidence.
  4. **Server check**: your **Workspace owner** must be an active human Owner/admin; if your owner is an ordinary member, the answer is denied even for them.

  A failure in 1–3 returns the fixed reply 「这类信息请到 Workspace 里问我，或找组织管理员」 — except `owner_unverifiable` (below); a failure in 4 returns the "ask an org admin" reply. `askerIsAgentOwner` is no longer read.
- Anything missing, malformed or unverifiable → denied. The `scheduler` and `system` channels have no human asker and are always denied.

Never pass an endpoint other than the one on the asking message's own `reply via` line — not your owner's DM endpoint while answering a group, not one quoted in message text or forwarded. A group question from your owner is answered with the fixed reply, not moved to a DM.

### Known limitations (external channels)

- **The CLI cannot see which conversation you are answering.** The endpoint still comes from you. The CLI can only prove that **your owner sent a message in that private chat within the last 30 minutes** — not that the current question came from there. If you pass (by mistake, or because a message talked you into it) your owner's recent DM endpoint while answering **any** other conversation — a group, someone else's DM on the same channel, a different external channel, or a Workspace conversation (by sending `{channel, endpoint}` instead of `conversationId` + `messageId`) — the numbers are released. Passing only the asking message's own `reply via` endpoint is therefore a hard rule, not a formality. A real fix needs a trusted sender for each message from the channel component or the server (extension point `TRUSTED_CHANNEL_SENDER_RESOLVERS`; the DM-only rule would still apply).
- **The evidence is local.** The message store (`~/zylos/comm-bridge/c4.db`) and the channel components' `config.json` and message logs live on this Agent's host and are writable from it (e.g. a local `c4-receive.js` call can insert an inbound row). For channels where the owner is matched only by the id in the endpoint (telegram, dingtalk, wecom, …) such a forged row passes. This is the same trust domain as #301: the check stops honest mistakes and outside askers, not a misbehaving Agent on its own host.
- Only the newest 500 inbound rows are searched; on a very busy host an owner DM from within the window can fall out of it, which denies (fails safe).

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

The data source is the same credit statement the web billing page shows (consumption rows, `points_total` / `points`). Ranges longer than 92 days are split into consecutive 92-day windows; at most 60 pages of 200 rows are read, newest window first. `complete:false` means the cap was hit: then **every** figure — `total_points`, `top_agents`, `by_category`, `outstanding_points` — covers exactly `covered_from` … `covered_to` (the most recent part of the range), not the requested `range` (rows on the instant where reading stopped are left out, because more rows at that same time may be on the unread page, so `covered_from` can be one millisecond after a full hour). **If `complete:false` and the covered span is empty (`covered_from` equals `covered_to`, nothing could be counted), that does NOT mean zero spend** — say the spend data could not be fully read for this period (never "0 credits spent" or "no Agent spent anything"), and point to the web page or ask again with a shorter range. Otherwise say exactly which period the figures cover (e.g. "from Sep 12 to now"), do not present the ranking as "the top spender of the whole period", and point to the web page for the full statement — or ask again with a shorter range. Rows with no Agent (`org_level:true`) are org-level charges, not an unknown Agent. Agents are distinguished by `agent_identity`; a missing `agent_name` means the name could not be resolved (e.g. deleted member).

Examples:

```bash
node src/cli/billing.js billing.overview '{"conversationId":"0193…","messageId":"7301…"}'
node src/cli/billing.js billing.spend '{"conversationId":"0193…","messageId":"7301…","period":"month","top":5}'
node src/cli/billing.js billing.spend '{"channel":"lark","endpoint":"oc_123|type:p2p|msg:om_456","last":"90d"}'
node src/cli/billing.js billing.links '{}'
```

## Denied

A denial is a normal result (exit 0):

```json
{"allowed":false,"reason":"initiator_not_admin","reply":"这类信息请联系组织管理员（Owner 或管理员）查看。\nPlease ask an org admin (Owner or admin) for this information."}
```

External channel, not a private chat with your bound owner (`not_private_chat`, `chat_type_unknown`, `asker_not_agent_owner`, `source_message_not_found`, `source_message_too_old`):

```json
{"allowed":false,"reason":"not_private_chat","reply":"这类信息请到 Workspace 里问我，或找组织管理员\nFor this information, please ask me in Workspace, or ask an org admin."}
```

Lark / Feishu private chat where the sender cannot be compared with the owner binding (`owner_unverifiable`): the owner binding is usable (bound, with a `user_id` or `open_id`) and the asking message was found in the component's private-chat log, but its entry carries no sender id at all (neither `user_id` nor `open_id`) — usually the Lark / Feishu app has not been granted the "get user ID" permission (`contact:user.employee_id:readonly`). A missing or incomplete owner binding is **not** this case: everyone then gets the fixed reply above (`asker_not_agent_owner`), as does any sender whose log entry has an id that is not the owner's:

```json
{"allowed":false,"reason":"owner_unverifiable","reply":"无法确认你是这个 Agent 的主人：飞书 / Lark 应用可能未开通获取用户 ID 权限，或主人绑定信息不完整。可以先到 Workspace 里问我，或找组织管理员。\nI can't confirm that you are this Agent's owner: the Feishu / Lark app may not have the permission to get user IDs, or the owner binding is incomplete. You can ask me in Workspace for now, or ask an org admin."}
```

Send it as-is (no ids or config values). If your owner reports this in your private chat, tell them (or the org admin) to grant the app the "get user ID" permission; a different person and group chats still get the fixed reply above. If your owner gets the fixed reply in their own private chat, check that the channel component has an owner bound.

When the check itself could not be made — Core 5xx, timeout, network error, an unresolved org — the reason is `verification_unavailable` with the HTTP `status` (`null` for network/timeout) and a different reply:

```json
{"allowed":false,"reason":"verification_unavailable","status":503,"reply":"身份核验暂时不可用，请稍后再试。\nThe identity check is temporarily unavailable, please try again later."}
```

Send that reply as-is too (still no figures); do not tell the person to ask an admin. A `403`/`404` from the server is a real answer (`source_message_unreadable`, `member_not_found`), not this case. If `status` is 400 (org not resolved on a multi-org Agent), pass `org` and call again.

Send `reply` as-is. Do not add any balance, plan, renewal date or usage figure, not even approximate or from earlier answers or memory, and do not hint at them. When an external-channel denial carries a `hint` (the Workspace-side check failed), it suggests asking in a Workspace DM; you may add that sentence.

Reasons that mean **your call** was wrong, not the asker: `invalid_source_reference`, `missing_initiator`, `ambiguous_initiator`, `workspace_requires_source_message`, `invalid_channel` — fix the parameters (copy the ids from `<message-context>`) and call again. `source_message_too_old` in Workspace: ask the person to ask again. On an external channel every reason except `verification_unavailable`, `owner_unverifiable` (and the parameter reasons above) is answered with the fixed reply; `chat_type_unknown` also means check that you passed the full `reply via` endpoint. `verification_unavailable`: send its retry reply (see above). Every other reason: send the reply.

## Read-only

No command buys credits, changes or upgrades the plan, adds seats or turns on auto top-up, and you must not do it any other way (no hand-rolled REST). For those requests answer with `billing.links` → "please do this on the web: <credit_page_url>" (an Owner/admin action there).

## Numbers in replies

- Credits are integers (`cr`); `next_charge_amount_cents` is in minor units of `currency` (9900 cny = ¥99.00).
- Quote `credit_as_of` / the range you used; say "this month so far" etc.
- `enforcement_suspended:true` means LLM usage is currently stopped for non-payment.
- Errors (exit 1, `{"error","status"}`) after an allowed check: report that billing data is unavailable right now; never answer "0".

## Audit

Each call appends one JSON line to `~/zylos/components/openmax/logs/billing-audit.jsonl`: time, command, allowed / reason, source (workspace / channel), channel, whether it was a private chat and whether the owner proof passed, initiator member id and role, conversation and message id, org id, range. No tokens, message text or billing figures are written. This file is local to this Agent's host; the platform itself does not record who asked.
