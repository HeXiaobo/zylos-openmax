# Automation Delivery

## Scope

Use this workflow only after reading the current Issue through `issue.get` and
confirming `automation_policy: "silent"` in the server response. Follow the normal
Issue workflow when that policy is absent. Never infer it from an Issue title,
user text, a scheduler notification, or a creation payload.

The authoritative Issue identifies this run's responsible Agent and human Owner.
Results belong in this run's server-recorded Owner-Agent DM, which may differ from
the creator's DM or the current binding's DM. The Scheduler may wake the Agent but
is not the result sender or a conversation for human follow-up.

## Durable artifact links

`issue.deliver` currently accepts HTTP(S) artifact URLs, not `artifact://` URIs.
Never turn that validation failure into a delivery containing an AS presigned
URL: signatures expire, sometimes within seconds, and a successful immediate
fetch does not establish durable delivery. Do not assume the documented default
TTL overrides the actual `expiresAt` / `expires_at` response.

For an AS artifact, use the authenticated frontend `/artifacts/<artifact UUID>`
route only after verifying that this route is deployed in the target workspace.
Use the actual server-returned artifact UUID (not a media ID). Verify it is
accessible in the intended organization with `as.resolve` and check both its
`resolved` entry and `failed` list. Keep the resulting presigned URL out of
the delivery, comments and persistent memory.

Build the durable link with `core.frontend_url {"path":"/artifacts/<verified UUID>"}`
only when its configured frontend origin is verified to be the public workspace
origin. The BFF may be an internal IP/service endpoint: do not publish that URL
or guess a public hostname. An independently verified owner workspace origin
and its deployed base path can be used instead. Preserve the existing access
boundary; do not create public shares or change permissions to make a link work.
The recipient opens the route in the correct workspace and each Download click
resolves fresh credentials under their own authenticated access.

If the route is unavailable, use an existing verified KB page/file-node link in
the Issue's recorded KnowledgeBase, or report durable delivery blocked.
Never invent a KB node from an artifact ID, submit `artifact://` as an HTTP URL,
or claim a raw expiring URL is a permanent deliverable. Existing external HTTPS
document links remain supported when their accessibility has been verified.

## Execute And Deliver

### Resolve responsibility from this run's snapshot

For every wake or reminder, read `issue.get {org,id}` for the exact referenced
Issue and verify `automation_policy: "silent"`, org and responsible Agent before
acting. Read this Issue's `owner_member_id`, `lead_agent_id` and
`origin_conversation_id`; these are this run's responsibility and destination
snapshot. For an existing result, also verify its persisted `delivery` record.
The current binding describes future triggers, not a replacement for an existing
Issue's Owner, Lead or delivery destination. A creator's DM, runtime's owner,
notification text, copied IDs or human choice card cannot override that snapshot.

An Owner transfer changes future runs only. If a run was created with Owner B
and delivery DM B, and the binding is now Owner A with delivery DM A, the old run
continues for B in DM B; a new run created after transfer uses its own A snapshot.
This difference alone is expected, not an ownership conflict. Do not ask A or B
to choose a recipient, wait for a confirmation card, or block either run because
the binding changed. Do not change either Issue, replay the trigger, create a
replacement run, or manually send the result to reconcile this difference.
Match and process each run independently; one run's blocker does not automatically
block another run of the same binding.

| Authoritative server-read state | Required action |
| --- | --- |
| Existing run: Issue Owner B, DM B; current binding Owner A, DM A | Continue existing run for B in DM B without recipient confirmation |
| New run: Issue Owner A, DM A; older run Owner B, DM B | Continue new run for A in DM A independently |
| Issue responsibility missing, wrong org, or caller is not its responsible Agent | Stop this run and report the specific verification blocker |
| Issue destination missing/inaccessible or persisted delivery conflicts with this Issue snapshot | Stop this run; do not substitute the current binding or creator DM |
| Issue already terminal | Preserve terminal state; no new Attempt or result |

A missing or genuinely inconsistent server snapshot remains a blocker. Preserve
the evidence and report the exact mismatch; do not invent a destination or use
the current binding as fallback. An expected difference from a later binding
version is not such a mismatch. Leave an earlier mistaken recipient-choice card
unanswered: it is not authorization to reroute this run. Re-read the authoritative
Issue and resume its normal workflow only if still nonterminal and verified;
do not use a past local blocker note or session summary as stronger authority.

### Identify the run before interpreting its timing

A Scheduler notification can announce either a scheduled run or a manually
requested run. Its sender, Issue title and arrival time do not establish the
trigger type. Read the binding with `event-binding.get {org,id}` and the run
history with `event-binding.runs {org,id,limit,offset}`. Match the current
occurrence ID and Issue against `id`, `created_issue_id`, `latest_issue_id` or
`revision_issue_ids` before using that record's `trigger_kind`. Use `last_run`
from the binding only when its identities match this run; it may refer to a
newer execution. If no matching authoritative record is available, report the
trigger as unverified rather than guessing. History pages do not share a
snapshot, and a full page does not prove another page exists.

`trigger_kind: "manual"` means an independent manual execution. Its
`scheduled_at` records the manual execution instant, not an early firing of the
configured timer. A manual run does not consume, cancel or advance a once
schedule: the later configured run remains expected unless the binding was
explicitly changed. Read the current binding state and schedule before
describing what remains pending.

A webhook run with `replay_state: "replay"` is a replayed event: it arrived
while the automation was paused or the organization was suspended, was held,
and the human Owner chose to replay it when resuming. Its `trigger_kind` stays
`webhook`, and its `scheduled_at` is the time the event was received, not the
time the replay ran. On a normal run `replay_state` is empty or absent. Read
`replay_state` from the matching run record; the Issue description line
`Replayed event <delivery_id>: received at <t> while the automation was not
running; replayed at <t2>. It may be outdated.` is only a hint. The event may
be outdated: before acting, check the current state of the external object it
refers to (for example, the merge request may already be merged) and act on
that state, not on the payload alone. If the event is outdated and nothing is
left to do, take no action and complete the run as `success`; state clearly in
the result that the event was outdated and no action was taken.

The `<delivery_id>` in that line identifies the original webhook event (it is
not the result `delivery.id`). Use it to correlate the replay with that event,
and do not repeat side effects, such as reports or DMs, already produced for
that delivery ID. Only the human Owner decides, when resuming, whether held
events are replayed; the Agent cannot replay or decline them. Holding applies
to webhooks only: a timer automation still does not catch up runs missed while
it was paused or the organization was suspended.

Two executions of the same automation are not automatically duplicates.
Distinguish their occurrence/Issue identities and trigger kinds (`timer`,
`manual`, `webhook`); repeated notifications of the same occurrence differ from
independent manual and scheduled occurrences. Timing alone does not prove
duplicate execution. Never pause, reschedule or suppress an expected run merely
to resolve this uncertainty. Preserve the terminal-run safeguards below.

### Execution steps

1. Read the authoritative Issue, Blueprint, Tasks and previous outputs. Do not
   recreate the Issue or ask the user to choose its already-bound Agent/Project.
   Use the authoritative Issue's `knowledge_base_id` as its output location.
   This is the creation-time snapshot: changing the Project's default KB affects
   new Issues, not this run or existing documents. Never replace a present Issue
   KB with the Project's current default. On an older server that omits the field,
   preserve a verified existing output location; consult the bound Project only
   when no prior output location exists. An inaccessible recorded KB is a blocker,
   not permission to switch to another KB.
   A `kb.page_create` into the recorded KB answered 404 `KB_NOT_FOUND` (or a
   plain 404; the KB CLI adds `kbId` and `hint`) means that knowledge base was
   deleted, does not exist or is no longer accessible to the Agent; the Project
   can still point to a deleted KB.
   This is that blocker, not "gateway not connected" or a temporary outage: do
   not retry it or write elsewhere. Finish the run truthfully (`failed`, or
   `partial` only under step 4's rules) and say in the result that the knowledge
   base `<kbId>` was deleted, does not exist or is no longer accessible to the
   Agent, and that the Owner should restore the Agent's access, pick or
   re-create a knowledge base, or update the automation's or project's
   knowledge base. The run result is the notification: do not send a separate
   message about it. See SKILL.md "Writing into a deleted knowledge base".
   Do not repeat new-Issue intake or KB approval for these runs or their verified
   linked revisions. A missing or inaccessible configured resource is a genuine
   blocker; do not invent a replacement or silently change the binding.
   If the Issue is already terminal, do not start another Attempt, alter Tasks,
   or submit a new result. A timeout or cancellation is a terminal fence: stop
   this run's execution and preserve outputs. A late success cannot overwrite it.
2. Establish the accepted plan using the Issue plan-state gate below. Do not
   request human plan acceptance or synthesize `source=text_card_proxy` acceptance.
3. Execute and record Attempt/Task outcomes. Complete the inner state transitions
   and output comments before delivering the Issue. Report partial or failed
   execution truthfully; do not mark unsuccessful Tasks done to unblock delivery.
4. Submit the structured result with `issue.deliver`: a self-contained
   summary, durable artifact links, and the actual success/partial/failure
   outcome (`success`, `partial`, or `failed`) and a stable `idempotencyKey`.
   Do not submit secrets or claim a link works without checking it.
   `partial` requires every Task to be terminal, at least one done, at least one
   failed or cancelled, and at least one durable artifact. Do not use `partial`
   for all-failed work, missing output, or still-running Tasks. Report `failed`
   truthfully when no partial result satisfies those conditions.
5. The server persists completion and applies the run's result notification
   policy. When permitted, it reliably delivers the result as the responsible
   Agent in the bound DM. Do not separately send the same
   result, send it through the Scheduler DM, or ask the user to accept it in Work.
   Automatic closure records that the run ended, not human endorsement.

### Pausing yourself after the run (only when the automation's instructions ask for it)

Some automations tell the responsible Agent to pause itself when the run is
done and say when to resume, for example "做完后暂停自己，明天 08:30 恢复；周五就设下周一
08:30". This pauses the Agent itself, not the automation: the automation and its
schedule are unchanged, and the platform resumes the Agent at the given time.
It is unrelated to the rule above about not pausing an expected run. Only for
such a run, in this order:

1. Finish the work as usual: Attempts, Tasks and outputs, as in the execution
   steps above.
2. Check: `core.pause_self {issueId, at, skipWeekend, timeZone?, dryRun:true}`
   with this run's Issue id and the time from the instructions (`at` is
   `HH:MM`; `skipWeekend:true` when a Saturday or Sunday resume should move to
   Monday; `timeZone` only when the instructions name a zone, otherwise the
   Agent's own zone is used). The check changes nothing. `at` gives the next
   such time (today if it is still ahead, else tomorrow). It answers
   `{ok:true, resume_at, resume_local, resume_weekday, ...}`, or
   `{ok:false, code, reason}` when the pause would be refused. When that next
   time is less than 30 minutes away, the check itself refuses with
   `SELF_PAUSE_TOO_CLOSE` (before contacting the platform): stay running, and
   the summary says "未暂停：<reason>". Keep the check's `resume_at` for step 4.
   `at` cannot say "tomorrow" by itself (a run that ends at 07:00 gets today
   08:30): when the instructions name a specific day (明天, 下周一, a date) and
   it differs from what `at` gives, check with an explicit `resumeAt` for that
   day instead.
3. Deliver with `tm.js issue.deliver` as usual. The `outcome` reflects the work
   itself: never set `partial` or `failed` because of the pause. End the
   summary with "已暂停，<resume_local> 恢复" (in the user's language) when the check
   passed, or "未暂停：<reason>" when it was refused.
4. Pause, only when the check passed:
   `core.pause_self {issueId, resumeAt:<the check's resume_at>, timeZone?}`
   without `dryRun` (and with the check's `timeZone`, if it had one). Always pass the check's `resume_at` as `resumeAt`, here
   and on every retry; never `at` again, because time has passed since the
   check and `at` could now give another time than the summary states. The
   platform pauses only after the run's result is delivered;
   `SELF_PAUSE_RUN_NOT_DELIVERED` means deliver first, then call again. A 5xx,
   a network error or any other error printed on stderr (no `ok` field) is
   uncertain: send the same call again, at most 3 more times about a minute
   apart (the platform keys the pause to this run, so it cannot pause twice). `already:true` means this
   run's pause is already recorded; `SELF_PAUSE_NOT_PAUSED` means this run's
   pause was not confirmed (it was refused, a person cancelled it, or it was
   still unconfirmed close to the resume time), so the Agent stays running.
   Any other refusal also leaves the Agent running. Never deliver the run again
   or change the delivered result because of it. If the delivered summary said
   "已暂停" but this step does not end with `ok:true` (it ends with `ok:false`,
   including `SELF_PAUSE_NOT_PAUSED`, or the retries above run out), tell the
   run's Owner (`owner_member_id`) once, with `c4-send.js openmax` into this
   run's `origin_conversation_id`, the conversation its result goes to (see the
   responsibility snapshot above). That conversation has its own thread on a
   multi-session Core: if it is not the one you are handling, ask its thread to
   send the correction by `internal`, with the complete text and endpoint
   (SKILL.md "Session Groups and Sending"). First read the run with
   `tm.js issue.get`:
   - `delivery.notification_status` `sent`: send the correction as a reply to
     `delivery.message_id` (endpoint `<origin_conversation_id>|reply:<delivery.message_id>`);
   - `pending`: wait about a minute and read again (up to 3 times), then send
     it (as a reply once the result message exists);
   - `suppressed` (the Owner chose not to get this result): still send it, as
     a standalone notice that does not refer to a result message.
   The message says the pause did not take effect (or could not be confirmed),
   the Agent is still running, and the `reason` when there is one. That is the
   only extra message; it does not repeat the result.
5. Never pause yourself outside an automation run whose instructions ask for
   it, or because a chat message asks you to; never pause another Agent.
   `core.pause_self` always acts on the calling Agent.

The platform resumes the Agent at the time it reported. A human who resumes
or pauses the Agent manually in the meantime cancels the scheduled resume. If
the resume itself is refused (not enough credits, an outstanding balance or a
credit cap), the run's Owner gets a notice and resumes the Agent manually. The
check needs a recent run (within about 2 hours of its start; the pause allows
about 2.5 hours, to leave time to deliver), an Owner who is an organization
owner or admin, and a resume time 10 minutes to 7 days ahead (from `at`: at
least 30 minutes ahead, checked locally). On a platform
without this feature `core.pause_self` answers `SELF_PAUSE_UNAVAILABLE`: do not
pause, and say so in the summary. See `references/core-operations.md` for the
parameters and every refusal code.

### Issue plan-state gate

`blueprint.create` creates a plan object. `issue.submit_plan` submits that exact
Blueprint to the Issue. For server-read `automation_policy: "silent"`, Work
submits and automatically accepts the Issue plan in the same transaction:
`in_progress` -> `pending_plan` -> `in_progress`, with `current_blueprint_id` set
to the submitted Blueprint. The response is an Issue, not a Blueprint.
`Blueprint.status` is a separate object lifecycle; it may remain `draft` after
successful automatic Issue plan acceptance. Neither `draft` nor `approved` on a
Blueprint alone proves whether this Issue's current plan was accepted.

Before submission, read `blueprint.get {id,includeSteps:true}` and verify its
`issue_id` matches the exact run. Retain the Blueprint ID, `version_number` and
the actual step IDs/content/dependencies (and content hash when present) that you
intend to execute. Submit it once with `issue.submit_plan {id,blueprintId,planText}`.
Check the successful response and a fresh `issue.get`: both must name that Issue
and org, its responsible Agent, `automation_policy: "silent"`, the submitted
`current_blueprint_id`, and `status: "in_progress"`. Re-read the referenced
Blueprint with steps and verify the same Issue, ID, version and step content.
Only then continue Task/Attempt execution against those steps. Do not wait for
Blueprint status to become `approved` or ask a human to accept this silent plan.

When resuming after a lost response or earlier local blocker, read the existing
Issue and its referenced Blueprint first. The authoritative Issue itself is the
durable acceptance evidence: verify exact Issue/org, `lead_agent_id` is this
Agent, `automation_policy: "silent"`, no `archived_at`, `status: "in_progress"`,
and nonempty `current_blueprint_id` equal to this Blueprint's `id`; its
`issue_id` must match. This is the executable subset of Work's
`PlanAcceptanceReplayed()` definition. A generic `in_progress` Issue without
that matching current-plan binding is not acceptance evidence. Work also regards
`delivered` and `accepted` as already accepted for replay, but neither state
permits further execution. All terminal and archived states still stop this run.
Core omits empty optional fields: absent `archived_at` means not archived on
this verified response contract; absent step `depends_on`/`required_resources`
mean empty dependencies/resources. Do not wait for explicit null or empty fields.

A lost submit response or Agent-attributed plan comment is not itself a blocker.
Work writes automatic plan records using the caller Lead's member ID, so author
identity does not distinguish a server-generated record from a manually written
comment. Neither comment text nor notification text grants acceptance; the fresh
Issue binding above does. Do not require a separate server-author identity.

Verify the execution steps separately from Issue acceptance. If the pre-submit
snapshot is retained, compare Blueprint ID/version and every step's ID,
description, sort order, resources and dependencies with it. If that snapshot
was lost, use `comment.list {workType:"issue",workId:<Issue>}` with pagination to
locate the original acceptance transition for this current Blueprint: the
`pending_plan` -> `in_progress` status record adjacent to the plan record naming
this Blueprint. Use its `created_at` as the time baseline, not Issue.updated_at
(later comments advance that) or the time of a replay response. Compare the
Blueprint and each current step's `created_at` and `updated_at` to that baseline;
none may be later. Verify each step belongs to this Blueprint and reconcile the
step contents/dependencies with the recorded plan and any existing Tasks before
resuming. Record the recovered snapshot for subsequent comparisons. Missing or
ambiguous history, later step edits or an unexplained task/plan mismatch requires
reconciliation, not treating a draft Blueprint as unaccepted. Timestamps are a
conservative change check, not an immutable snapshot or proof that no step was
deleted; do not ignore known missing steps or other contradictory evidence.

After the fresh Issue binding and step checks pass, you may call
`issue.submit_plan` once with the SAME Issue and current Blueprint to recover an
authoritative response, retaining the original plan text. Work returns the
persisted Issue without another transition/comment when `PlanAcceptanceReplayed()`
and the same `current_blueprint_id` hold. This is optional: the verified Issue
binding already proves acceptance. Re-read Issue/Blueprint before execution;
do not repeat this call blindly after an error, use another Blueprint, or use
replay to reset the step time baseline. A state/Lead/plan change stops recovery.

Do not mutate an accepted Blueprint: no `blueprint.set_steps`, step add/update/
delete, dependency/resource changes or other plan edits after acceptance, even
when its status is still `draft`. The backend currently permits draft step edits
without changing the Blueprint version, so version equality alone is insufficient.
An intentional replan requires a new Blueprint and the normal submit/accept
workflow while the Issue remains executable; never create a replacement merely
to change the displayed status or silently discard existing Tasks.

| Verified state for this exact run | Action |
| --- | --- |
| Silent Issue has matching accepted current Blueprint, in_progress, no archive; recovered step checks pass; Blueprint still draft | Continue or resume Tasks and Attempts for that accepted plan |
| Issue in_progress but current Blueprint is missing or mismatched | Reconcile the plan; do not execute or infer acceptance |
| Current Blueprint ID, Issue, version or step content differs from the submitted/accepted plan | Stop and reconcile the changed plan before execution |
| Issue remains pending_plan, or ordinary human acceptance is required | Wait for the real acceptance workflow; never proxy acceptance |
| External-action approval is pending | Keep that action blocked until its actual approval |
| Issue is terminal or archived | Stop; do not create Tasks, Attempts or a new result |

Do not call `issue.accept_plan`, edit Blueprint status, or bypass an endpoint
error to force progress. A successful HTTP response without the matching Issue
plan-state readback is insufficient. Report actual missing or conflicting
evidence; an unchanged Blueprint `draft` alone is not such a conflict.

Read the actual delivery outcome as well as Issue status. A successful or valid
partial automation delivery closes as `accepted`; `failed` closes as
`terminated` with its failure reason and retained result. Historical
`accepted` plus `delivery.outcome: "failed"` is still failure. Do not describe
it as success merely because its Issue was accepted. Pending result notification
is separate from execution failure. Real external-action approvals still require
confirmation; silent plan/delivery handling does not bypass them. A blocked
Attempt without pending approval IDs is not an approval request.

If delivery is pending or a response is lost, read back the Issue/delivery state
and use the same delivery identity for any supported retry. Never rerun business
actions just to retry a message. Never call `accept_delivered` as a workaround.
Structured `issue.deliver` and `issue.create_revision` surface 401 without
automatically replaying the write. Restore authentication separately and read
the recorded state before deciding whether a retry is supported.
If the deployment lacks this protocol, report the unsupported operation and
preserve the recorded result; do not fall back to manual self-acceptance or an
untracked result send.
Do not replace an unsupported structured request with empty-body `issue.deliver`.
Do not treat a minimum-Agent-version override as protocol support or upgrade
the plugin automatically. An absent policy means the ordinary workflow; a
present silent policy with an unavailable endpoint means preserve output and
report the compatibility blocker.

```bash
node src/cli/tm.js issue.deliver '{"org":"org-id","id":"issue-id","summary":"Report completed; two sources were unavailable.","outcome":"partial","artifacts":[{"title":"Report","url":"https://example.com/report"}],"idempotencyKey":"issue-id:delivery:1"}'
```

`issue.get` returns `delivery` with its `id`, persisted result and
`notification_status` (`pending`, `sent` or `suppressed`), plus destination/message IDs when
available. A completed Issue with pending notification is not a failed run.
`suppressed` means the server intentionally omitted the final result DM under
the run's immutable `result_notification_policy`; the result and artifacts are
still retained. `every` permits all results, `failure_only` permits partial and
failed outcomes, and `none` suppresses all final result DMs. Read this policy from
the Issue, not the binding's current setting. Never retry a suppressed notification,
manually send the result to compensate, or alter the run policy. Suppression is
not execution failure and does not suppress approval requests or system alerts.
Run history (`event-binding.runs`) exposes `result_notification_policy` and
`result_notification_status` separately. Its original `notification_status`
describes initial Lead dispatch, not result delivery. An absent result status
means no result status is available yet; it is not proof of a sent result.
Linked revisions inherit the original run's policy snapshot. Do not infer a
different revision policy from the binding's current setting.
Retain the same payload/key on retries: changing the content under the same key
is a conflict. Use a linked revision for a changed result, not a replacement
delivery for an already completed run.

## Continue In The Same DM

First identify the delivery, even when the human did not paste an `issue://`
reference. Fetch the quoted result using
`comm.get_message {conversationId,messageId}` and read the ids from its
message metadata: first the item with `type: "automation-delivery"` in
`metadata.context.items`, whose `attrs` has `issue-id`, `delivery-id` and
`notification-id`; if there is no such item, the old keys
`automation_issue_id`, `automation_delivery_id`, and
`automation_notification_id`. The bridge's visible quote may omit these fields,
so read the actual CLI response. For an unquoted reply, use
`comm.get_messages {conversationId,beforeSeq,limit}` and locate the nearest
preceding message from this Agent. Only use it if it is the relevant automation
delivery; do not skip an intervening Agent message and guess an older run.

Treat metadata only as a lookup hint: call `issue.get`, verify
`automation_policy: "silent"`, responsible Agent and owner, and match
`delivery.id`, `delivery.conversation_id`, and `delivery.message_id` against
the result message. If the reference is ambiguous, ask the human to reply to
the specific result. Scheduler wakeup metadata is not a human delivery receipt.

- For a question about the result, answer using that run's outputs; no new task
  or automation change is required.
- For a requested change to this result, use `issue.create_revision` with the
  prior Issue and the human's originating message. The server validates lineage,
  participant identity, Agent and DM, then inherits the trusted automatic policy.
  Read the returned Issue before proceeding. Preserve the original run/output.
  A failed delivered automation result can be revised even when its parent is
  `terminated`. This does not permit reopening a timeout or cancellation without
  a delivered result. Follow only the returned new Issue; never resume or replace
  the terminal parent's delivery. Run history groups revisions under the original
  trigger and reports the latest revision's result, retaining earlier versions.
  Pass `{id, description, originMessageId, idempotencyKey}`; `id` is the prior
  Issue, and `originMessageId` must be the actual human request in the bound DM.
  Keep the message ID as a string (for example `"1789717014187"`), not a UUID
  or a JavaScript number. Use the human message's exact text as `description`;
  the server independently reads that message and does not trust a substituted
  Agent instruction. A reply targeting the result, or an unquoted reply whose
  nearest preceding Agent message is that result, can establish the link.
  Retry the same request with the same key after an ambiguous response. Do not
  substitute a bot message or send caller-defined owner/Agent/policy fields.
- For an explicit change to future runs, update the automation configuration
  through its existing workflow. A correction to one result does not implicitly
  change future runs. Clarify only when the intended scope cannot be determined.

Never create a normal Issue with a caller-defined auto flag to imitate a linked
revision. Approval for the automation lifecycle does not authorize unrelated
external sends, destructive actions, or permission escalation.
