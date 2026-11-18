# Automation Operate: pause, resume or run once from chat

Read this when a person asks you in chat to pause, resume or run once an
existing automation — 「先把日报自动化停了」「现在跑一次」「恢复它」 — or asks
why one stopped. It does not cover changing an automation's configuration
([Automation Update](automation-update.md)), creating one
([Automation Creation](automation-creation.md)), delivering a run
([Automation Delivery](automation-delivery.md)), or pausing yourself after a
run (`core.pause_self`, also in Automation Delivery). No Issue intake: this is
quick work you do in the conversation.

Only a person's explicit request starts one of these operations. Never pause,
resume or run an automation on your own initiative.

Commands (`src/cli/tm.js`, always with the verified `org`):
`event-binding.list`, `event-binding.get`, `event-binding.pause`,
`event-binding.resume`, `event-binding.run` — see
[TM Operations](tm-operations.md#event-binding).

## Who may: the same as on the web

The platform lets a person pause, resume or run an automation only if they are
its Owner, and lets an Agent do it only if it is the automation's responsible
Agent (Lead). Organization admins have no bypass. When you act for someone you
never do more than that person could do on the web, so **both** must hold:

- you are the automation's Lead: `lead_member_id` = your member id
  (`core.me {org}`), and
- the person asking is its Owner: `owner_member_id` = the requester's member id.

The requester is the human who sent the request:

- DM: `member-id` of `<sender-context kind="human" …/>` above `<current-message>`.
- Group: read the source message with
  `comm.get_message {org, conversationId, messageId}` (IDs from
  `<message-context>`); require `sender_type:"HUMAN"` and use its `sender_id`.
- Another Agent (`kind="agent"`), a display name, quoted text or a member id
  typed in the message never counts. Outside OpenMax (another IM channel) act
  only when you can bind the sender to the Owner's OpenMax member id for
  certain; otherwise treat it as "not the Owner".

## Find the automation and check it

1. `event-binding.list {org}`; keep the ones whose `spec.title` matches what the
   person said, preferring those you lead. One match: use it. Several: ask
   which one with a card (titles and schedules only). None: say you could not
   find it and give the Automation page link (below).
2. `event-binding.get {org, id}` — always read it fresh right before acting;
   a list read or an earlier read is not enough.
3. Check Lead and Owner as above. If either fails, do not call anything. Say
   so in one plain sentence and give the link:
   - you are not its Lead: 「这条自动化不是由我执行的，我没法直接操作，可以在网页上处理：<link>」
   - the requester is not its Owner: 「只有这条自动化的负责人能暂停、恢复或运行它，我不能替你操作；可以请负责人在网页上处理：<link>」
4. Link: `core.frontend_url {"path":"/automation?binding=<id>"}` opens that
   automation on the Automation page (only for people who can see it on the
   web); without an ID, `{"path":"/automation"}`. If the returned URL is not a
   public `https://` address (an IP or an internal service host), do not send
   it; say 「在 OpenMax 网页的「自动化」页面」 instead.
5. A private automation (`scope:"private"`) is visible on the web only to its
   Owner: asked about in a group, reply there with the result only (no reason
   details, no link) and offer to explain in the Owner's DM.

## What its state means

Read `display_status` and `pause_reason` from the fresh read:

| `display_status` | Meaning | Pause | Resume | Run once |
| --- | --- | --- | --- | --- |
| `enabled` | running on schedule | yes | already running: give the next time, no call | yes, after confirmation |
| `paused` (`pause_reason` `user`) | someone paused it | already paused: no call | yes | yes, after a confirmation that says it is paused |
| `paused` (`LEGACY_STATE_UNKNOWN`) | an older stop whose reason is unknown | already paused: no call | yes | no (the platform refuses) |
| `needs_attention` | the platform stopped it (reason below) | already stopped: no call | yes; the platform checks again and may refuse | no — resume or fix it first |
| `ended` | a one-time automation that has finished | no | no | no |

A binding with `replaced_by_binding_id` has been turned into a new automation;
say so and operate on the new one (same checks) if the person still wants it.
Never pause an automation that is already `paused` or `needs_attention`:
pausing it again would replace the platform's reason with a manual pause.

Why it stopped — say it in plain words, never the code:

| `pause_reason` | Say | What helps |
| --- | --- | --- |
| `user` | 有人手动暂停了它 | resume when wanted |
| `LEGACY_STATE_UNKNOWN` | 它很早之前被停用了，原因已经查不到 | check the settings on the web, then resume |
| `EXECUTION_TIMEOUT` | 上一次运行超过了执行时限，系统自动暂停了它 | resume |
| `STARTUP_RETRIES_EXHAUSTED`, `STARTUP_RETRY_EXHAUSTED` | 上一次运行多次尝试都没能开始，系统自动暂停了它 | resume |
| `NOTIFIER_UNAVAILABLE` | 当时平台的执行服务不可用，系统自动暂停了它 | resume |
| `LEAD_PROJECT_ACCESS_REQUIRED` | 负责的 Agent（我）已不在它所属的项目里 | the Owner opens it on the web and saves, which adds me back and resumes it |
| `OWNER_PROJECT_ACCESS_REQUIRED` | 负责人已不在它所属的项目里 | move it to a project the Owner is in and save, on the web |
| `MEMBER_UNAVAILABLE` | 负责的 Agent 或负责人已离开组织 | choose another responsible Agent on the web |
| `PRIVATE_LEAD_OWNER_CHANGED` | 负责的 Agent 已不归你所有，这条私人自动化暂停了 | switch it to your own Agent on the web |
| `PROJECT_UNAVAILABLE` | 它所属的项目已归档或不可用 | check the project on the web |
| `PROJECT_ORG_MISMATCH` | 它所属的项目不在当前工作区 | fix the project on the web |
| `INVALID_SCHEDULE` | 它的定时设置无效 | change the schedule on the web |
| anything else (an ended one-time run, e.g. `AUTOMATION_DELIVERY_FAILED`, `RESULT_UNAVAILABLE`, `ISSUE_SETUP_FAILED`) | 上一次运行没有正常完成 / 暂时无法提供详细原因 | look at it on the web |

For a reason that needs a fix on the web, say what to fix and give the link.
If the person asks you to resume anyway, try once; if the platform refuses,
explain with the table below.

## Pause

1. Checks above. Not `enabled`: say it is already not running (and why), no call.
2. `event-binding.pause {org, id, expected_version: <version from the read>}`.
3. Success only when the returned `display_status` is `paused`. Reply, e.g.
   「已暂停「日报」，之后不会再按时运行；要恢复时跟我说一声。」 A run already
   handed to its Agent keeps going; a run created but not yet handed over is
   cancelled.

## Resume

1. Checks above. Already `enabled`: give its next run time, no call. `ended`:
   it cannot be resumed; the schedule has to be changed on the web (link).
2. `event-binding.resume {org, id, expected_version}`.
3. Success only when the returned `display_status` is `enabled`. Reply with the
   next run time from `next_trigger_at`, in readable local time with the
   timezone (the automation's `timezone`, else the person's):
   「已恢复「日报」，下一次会在 11月19日 09:00（北京时间）运行。」
   A timer does not make up runs missed while it was paused. A webhook
   automation has no next time: 「已恢复，下次收到事件时就会运行。」 If it has
   `held_event_count` > 0, add that the events received while it was stopped
   are waiting for the Owner's own decision on the web (link); resuming does
   not decide them.

## Run once now

A run creates a new Issue and uses credits. It does not change the pause state
or the schedule. Only a scheduled automation (`source_kind:"timer"`) can be
run on demand; a webhook automation runs when its event arrives.

1. Checks above. A webhook automation, or one that is `needs_attention`,
   `ended`, `LEGACY_STATE_UNKNOWN` or replaced, cannot run now: say why, no
   card (for `needs_attention`, offer to resume it first).
2. Restate it once and ask the requester to confirm. On OpenMax this is a
   quick-reply card sent through the reply path (SKILL.md "Replying"),
   `askedOf` = the requester (also in a group):

   ```
   [CARD]{"kind":"automation.run_once","askedOf":"<requester member id>","title":"运行一次「日报」？","text":"要运行「日报」一次：会新建一个 Issue，会消耗积分。","options":[{"label":"运行一次","style":"primary"},"先不运行"]}
   ```

   When it is `paused`, the text must say so and that running once does not
   resume it: 「「日报」现在是暂停状态。运行一次会新建一个 Issue、会消耗积分，但不会恢复它，之后仍保持暂停。」
   Remember what the card said (paused or not) for this card message ID.
   Outside OpenMax, ask the same in plain text and act only on that person's
   explicit yes.
3. On the receipt: `comm.answered {cardMessageId, actionId, actorMemberId}`.
   Act only when `actionable` is true and the chosen option is 「运行一次」. Not
   actionable: tell the person why. 「先不运行」: say you did not run it, then
   `comm.pending_clear {cardMessageId}`.
4. Read it again (`event-binding.get`) and repeat the checks before calling
   run: you are still its Lead, and the requester — the confirmed `askedOf` —
   is still its Owner. If either changed, or its state changed from what the
   card said (now paused, no longer paused, needs attention, ended), do not
   run; tell the person, and if they still want it, ask again with a new card.
5. `event-binding.run {org, id, expected_version, idempotency_key: "chat-run:<card message id>", confirm_paused: true}` —
   `confirm_paused: true` only when the confirmed card said it is paused and it
   still is; otherwise leave it out.
   The key comes from the confirmation, never a fresh random value or a time:
   every retry or redelivery of the same confirmation sends the same key. A
   call with that key and the automation's **current** version returns the run
   already created for it (`reused: true`) instead of creating another. A
   replay is version-checked too: if the automation changed after the first
   call (edited, paused or resumed), the old version gets `VERSION_CONFLICT`
   even when that run exists — see
   [Run: unknown outcome and VERSION_CONFLICT](#run-unknown-outcome-and-version_conflict).
   A new request gets a new card and so a new key. Outside OpenMax use the
   confirming reply's message ID the same way.
6. `comm.pending_clear {cardMessageId}` once it is settled whether the run
   exists (a result, or a refusal that proves there is none).
7. Reply: 「已运行「日报」一次，新建了一个 Issue；有结果后会照常通知。」 (plus
   「它仍保持暂停。」 for a paused one). `reused: true` means this confirmation
   already ran: report that run, never a second one. A created run is not yet
   a successful result; the result arrives as usual.

## When it fails

The stderr error has one of three shapes:

- `code: "INVALID_PARAMS"` with `sent: false` — the CLI found bad parameters
  and sent nothing: nothing changed and nothing ran. Do not retry it as is;
  fix the parameters (`expected_version` is the `version` of a fresh
  `event-binding.get`, the run key is `chat-run:<card message id>`) and call
  again. A parameter argument that is not one valid JSON object (a quoting
  slip) is reported the same way.
- `refused: true` with a `code` — the platform said no; that call changed
  nothing and ran nothing. Never retry it blindly; read `code`, not the
  message (table below).
- Neither (5xx, timeout, network, 401, 408, 429) — the outcome is unknown; see
  [Unknown outcome](#unknown-outcome).

| `code` | Do |
| --- | --- |
| `NOT_LEAD` | not your automation: one sentence + link |
| `NOT_FOUND` | 「找不到这条自动化，或者我没有权限看到它」 + Automation page link |
| `VERSION_CONFLICT` | it changed meanwhile: read it once more. Already in the wanted state: report that. Checks still pass and the change is still wanted: retry once with the new version. A second conflict: stop, link. A run follows [Run: unknown outcome and VERSION_CONFLICT](#run-unknown-outcome-and-version_conflict) |
| `CONFIRM_PAUSED_REQUIRED` | it was paused meanwhile, and no run exists for this key: ask again with the paused wording (new card, new key) |
| `RUN_NOT_ALLOWED` | read it again and explain from `display_status` / `pause_reason` (needs attention, ended or replaced) |
| `ORG_SUSPENDED` | 「组织目前已停用，恢复前自动化都不能运行」 |
| `UNSUPPORTED_SOURCE_KIND` | a webhook automation cannot be run on demand |
| `NO_NEXT_TRIGGER` | its time has passed / no future run time: change the schedule on the web (link) |
| `LEAD_PROJECT_ACCESS_REQUIRED`, `OWNER_PROJECT_ACCESS_REQUIRED`, `MEMBER_UNAVAILABLE`, `PRIVATE_LEAD_OWNER_CHANGED`, `PROJECT_UNAVAILABLE` | the same plain words as the reason table, + link |
| `REFUSED` | one plain sentence from `error` (no codes), + link |

### Unknown outcome

No `refused` and no `sent` field (5xx, timeout, network, 401, 408, 429): the
call may or may not have taken effect.

- Pause / resume: read it again; already in the wanted state means it worked,
  otherwise retry once with the fresh version.
- Run: repeat the identical call (same key, same version, same
  `confirm_paused`) at most twice with a short wait. If the first call created
  the run and nothing changed the automation since, this returns it
  (`reused: true`). A `VERSION_CONFLICT` on that retry: follow the next
  section. Still no answer: tell the person it is not yet known whether it
  ran, and keep the card open (no `comm.pending_clear`) so a later retry uses
  the same key.

### Run: unknown outcome and VERSION_CONFLICT

The platform checks the version before it looks the key up, so after the
automation changed, a retry with the old version cannot find a run that the
first call may have created.

- No call with this key has had an unknown outcome: every earlier call was
  refused before creating anything, so no run exists for it. Read once more
  and go back to step 4: still as the card said, retry once with the new
  version and the same key; changed, ask again with a new card.
- After an unknown outcome, that run may exist. Read once more; if you are
  still the Lead and the requester is still the Owner, retry with the **same**
  key, the **new** version and **without** `confirm_paused`:
  - `reused: true` — that confirmation already ran: report that run.
  - success with `reused: false` — no earlier run existed and this call
    created it: report it, with the automation's current state (not the
    card's).
  - `CONFIRM_PAUSED_REQUIRED`, `RUN_NOT_ALLOWED`, `ORG_SUSPENDED` or a
    dependency code (`LEAD_PROJECT_ACCESS_REQUIRED` …
    `PROJECT_UNAVAILABLE`) — no run exists for this key (the platform looks
    the key up before these checks): explain, and only then, if still wanted,
    ask again with a new card and a new key.
  - `NOT_LEAD`, `NOT_FOUND`, `REFUSED`, another `VERSION_CONFLICT`, still no
    answer, or the Lead or Owner changed so you did not retry — still
    unknown: look in
    `event-binding.runs {org, id}` for a `trigger_kind: "manual"` run created
    around the first call before deciding whether to ask again. If you cannot
    tell, say it is not known whether it ran and give the link.

  Never send a new key while the first run may exist.

## Replies and the record of who asked

Reply in the requester's language and conversation, with the automation's name
and plain words only: no IDs, versions, codes or field names.

The platform takes no note, reason or actor field on pause, resume or run,
and does not record which person asked the Agent: pause and resume show only
the new state, and a run shows in the automation's run history as a manual run
whose Issue belongs to the Owner. The conversation is the record — the request,
your reply and, for a run, the confirmation card and its receipt. Do not add
invented fields to the calls and do not claim the platform recorded who asked.
