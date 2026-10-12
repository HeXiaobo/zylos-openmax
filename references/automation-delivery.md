# Automation Delivery

## Scope

Use this workflow only after reading the current Issue through `issue.get` and
confirming `automation_policy: "silent"` in the server response. Follow the normal
Issue workflow when that policy is absent. Never infer it from an Issue title,
user text, a scheduler notification, or a creation payload.

The responsible Agent is the Agent with whom the user created the automation.
Results belong in that same user-Agent DM. The Scheduler may wake the Agent but
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
the Project's configured KnowledgeBase, or report durable delivery blocked.
Never invent a KB node from an artifact ID, submit `artifact://` as an HTTP URL,
or claim a raw expiring URL is a permanent deliverable. Existing external HTTPS
document links remain supported when their accessibility has been verified.

## Execute And Deliver

1. Read the authoritative Issue, Blueprint, Tasks and previous outputs. Do not
   recreate the Issue or ask the user to choose its already-bound Agent/Project.
   Read the bound Project's configured KnowledgeBase and reuse its output
   location, including a default Project/KB already chosen during creation.
   Do not repeat new-Issue intake or KB approval for these runs or their verified
   linked revisions. A missing or inaccessible configured resource is a genuine
   blocker; do not invent a replacement or silently change the binding.
   If the Issue is already terminal, do not start another Attempt, alter Tasks,
   or submit a new result. A timeout or cancellation is a terminal fence: stop
   this run's execution and preserve outputs. A late success cannot overwrite it.
2. Create and submit the Blueprint through the normal plan API. The server
   applies the automation policy; read back the state and proceed only when the
   server has advanced it. Do not request human plan acceptance or synthesize
   `source=text_card_proxy` acceptance.
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
5. The server persists completion and reliably delivers the result as the
   responsible Agent in the bound DM. Do not separately `comm.send` the same
   result, send it through the Scheduler DM, or ask the user to accept it in Work.
   Automatic closure records that the run ended, not human endorsement.

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
`notification_status` (`pending` or `sent`), plus destination/message IDs when
available. A completed Issue with pending notification is not a failed run.
Retain the same payload/key on retries: changing the content under the same key
is a conflict. Use a linked revision for a changed result, not a replacement
delivery for an already completed run.

## Continue In The Same DM

First identify the delivery, even when the human did not paste an `issue://`
reference. Fetch the quoted result using
`comm.get_message {conversationId,messageId}`. Its message metadata contains
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
