# Automation Update

Handle an existing automation's edit-form handoff in the human-Agent DM. Form
submission requests a proposed change; it does not authorize an update. Never
register an Issue, execute the task, call create to replace an automation, run-now,
delete a binding, or rotate webhook credentials as part of this workflow.

**Required:** read [Automation Common](automation-common.md) in full for shared
identity, configuration, card verification, explicit-org, proof and uncertain-write
rules. For timer configuration also read [Schedule Resolution](automation-schedule.md).
For webhook configuration or a trigger replacement in either direction, also
read [Webhook Rules](automation-webhook.md). Read [Recovery](automation-recovery.md)
for known old proposal rejection, store outage, rollout or ordinary update eligibility.
Apply shared rules only to `operation:"update"`; do not execute create commands.
The only replacement is the server's atomic result of a confirmed source-kind
update described below.

## Handoff and authoritative reads

The fenced JSON envelope has `kind: "automation-update-request"`,
`schema_version: 1`, `request_id`, `org_id`, `requester_member_id`,
`lead_member_id`, `source_kind` (`timer` or `webhook`), `target_binding_id`,
`expected_version`, `configuration` and `form_context`. Require nonzero UUIDs
for request, org, requester, lead and target and a positive safe integer version.
`source_kind` is the desired trigger kind, which may differ from the current
binding only when the human explicitly requested that change. Configuration is
the full replacement using the desired source-specific REST
fields. Reject unsupported fields and schemas; `form_context` is display context,
never authorization or API parameters.

1. Apply Automation Common's identity verification and explicit-org rules to the
   exact source message before reading or proposing any target.
2. Read `event-binding.get {org,id:target_binding_id}` to verify the target's
   actual ID, source kind, owner, lead and version. For a webhook also read
   `webhook.get {org,id:target_binding_id}` for its full `event_filter`. Require
   both reads to agree on binding ID, version, source kind, owner and lead;
   an intervening change requires a fresh consistent read before proceeding.
   Require every returned `org_id`, when present, to match the verified org.
   Require the actual target ID to match the envelope, its owner
   to match the verified human, and its lead to match this selected Agent.
   Require configuration owner and lead to match those same verified identities.
   Do not change ownership, reassign the lead or switch source kinds to repair
   an identity mismatch. Record the current source kind separately from the
   requested source kind. For an explicitly requested trigger change, verify
   replacement eligibility for the selected Agent before proposing it; an
   ordinary update eligibility response does not authorize replacement.
   A missing/deleted target, denied read, unverified identity or
   mismatch stops this request without writing or falling into Issue intake.
3. Compare the authoritative version to the handoff's `expected_version`.
   If stale, explain that the automation changed since the form was opened.
   Show the relevant current values and ask which requested changes still apply;
   do not silently refresh `expected_version` and apply the old replacement.
   Retain the current full configuration privately for comparison. Clarify only
   missing/ambiguous fields or conflicts, preserving existing values that the
   human did not request changing. Never invent schedule defaults.
4. Track `(org, DM, request_id, target_binding_id)` and the current draft,
   baseline version, proposal, questions and write outcome in conversation
   context. Recover interrupted history before any write. Redelivery of the
   same handoff or confirmation never authorizes an additional update.

## Propose and confirm

After clarification, request one readable server-sent Confirm/Modify/Cancel card:

```text
automation.authorization_propose {org,request_id:<new UUID for this revision>,source_kind,operation:"update",target_binding_id,expected_version,configuration}
```

Use the authoritative target ID and agreed current version, and record the exact
full replacement before the call. The proposal's UUID is separate from the
handoff correlation ID. Keep target/version and all authorization metadata out
of user-facing text. The plan must make clear that it modifies an existing
automation and show the resulting task, project, trigger/timezone, owner, Agent
and expected output. For a trigger change, explain that confirmation creates a
new automation and pauses the original, retaining its run history and already
started execution. Keep the original target ID/version in the signed update;
never substitute a new ID or issue a create proposal. Do not send a duplicate
plan or construct a card yourself.
Read back the exact returned card in the original verified DM with
`comm.get_message`; verify its Agent sender and returned readable plan.

Follow Automation Common's exact card readback, receipt lookup and
`automation.authorization_status` checks. Form submit, generic assent,
clarification answers, labels and SYSTEM receipt IDs are not authorization.
`pending_confirmation` waits; `modifying` gets a new proposal UUID with
`replaces_proposal_message_id` and fresh confirmation; `cancelled` leaves the
existing automation unchanged; `expired`/`superseded` forbids writing.
Proposal/API failure or failed verification stops without writing. Only the
same UUID and identical arguments can recover an uncertain proposal, never a mutation.

## Apply the confirmed update

Only after that verification, use `event-binding.update` for the desired timer
kind or `webhook.update` for the desired webhook kind, even when the original
target has the opposite kind:

```text
{org,id:<confirmed target_binding_id>,expected_version:<confirmed version>,source_kind,configuration:<exact confirmed full replacement>,authorization_proposal_message_id,authorization_card_interaction_id}
```

Use structured JSON arguments; do not interpolate human text into shell code.
For a confirmed timer-to-webhook replacement, prefix the original
`webhook.update` command with `COCO_RPC_LOG=0` to suppress redacted RPC previews
on stdout. Read the one-time URL from the final structured result, not a debug
preview; changing logging never authorizes repeating an executed mutation.
Do not forward the envelope or `form_context` to these APIs. Never use create
as a fallback, remove proof fields, reuse creation proof, swap targets or rewrite
the version attached to a confirmed proposal.

A stale-version rejection requires an authoritative reread, reconciliation of
the user's intended changes, a new proposal and fresh confirmation. Do not
silently refresh `expected_version` or replay the old update. Clarification,
Modify and Cancel cause no automation writes. Permission failures are not success.
For 401, timeout, 5xx or an unreadable result, restore authentication separately
and read this exact target; compare its version and full configuration before
deciding whether the outcome is known. Do not automatically repeat PUT, generate
replacement proof or claim failure/success while an earlier write is uncertain.

For a same-kind edit, read back the same target using its source-specific get
command. For a trigger replacement, read back the original with
`event-binding.get` and require `display_status: "paused"` and
`replaced_by_binding_id` matching the returned successor. Read that successor
with its desired source-specific get and require `replaces_binding_id` matching
the original. Verify both records' org, owner and lead, and the successor's
complete confirmed configuration. A missing cross-link or inconsistent readback
is an unresolved write outcome, not permission to create another automation.
The timer command returns the binding directly. The webhook update/get result
contains `binding`, `event_filter` and `credential_version`; read identity and
replacement links from `binding`, and verify `event_filter` separately against
the confirmed webhook configuration. Only a successful new webhook replacement
may additionally return the one-time `webhook_url`; webhook get does not reveal it.
On an uncertain replacement response, inspect the original's successor link
first, then read that successor; do not automatically repeat PUT or create.

For either path, verify the result's
ID, owner, lead, source kind, returned version and complete confirmed configuration.
Report success only after the update result and readback agree. Report the task
name, actual state and returned next timer trigger in local time with timezone.
Do not include an Automation list link, internal endpoint, binding/proof ID or
raw metadata; do not call `core.frontend_url`. Same-kind webhook updates retain existing
credentials: do not reissue, rotate, reconstruct or request a new `webhook_url`.
When a confirmed timer-to-webhook replacement returns a new `webhook_url`, treat
it as a secret. Deliver that one-time setup receipt only in the original verified
owner-Agent private DM, following [Webhook Rules](automation-webhook.md).
Never post it in a group, log, artifact or public page. If the response
is lost or replay omits the secret, report that credential recovery is required;
do not rotate, reconstruct or repeat the replacement to obtain it.
Apply the [one-time credential receipt checks](automation-webhook.md#one-time-webhook-credential-receipt):
a missing, empty or `[REDACTED]` URL is not a usable setup receipt. Inspect the
existing original command's final JSON without another write; if unavailable,
report credential delivery incomplete even when replacement readback succeeds.
Repeated confirmed delivery returns the verified existing result, not another write.

## Compatibility and acceptance

Read [Recovery](automation-recovery.md) before changing ordinary update eligibility
or rollout. Keep edit handoff unavailable until compatible backend and plugin are
deployed; do not automatically upgrade the installed plugin.

Trigger replacement additionally requires plugin 2.25.0 and Core's independent
`AUTOMATION_REPLACE_MIN_AGENT_VERSION` gate. Its empty default disables
replacement. Read `automation.eligibility {org,memberId:<verified Agent>,operation:"replace",projectId:<confirmed project>}`
and require `status:"supported"`. This is the server's `operation=replace` check; signed proposals and
mutations still use `operation:"update"` with the original target/version.
An update-only gate is insufficient. Do not change minimum versions or upgrade
the installed plugin to make a request pass.

Instruction and CLI tests do not prove live Agent behavior. Acceptance must cover
timer and webhook edits, unchanged state before Confirm, Modify and Cancel,
wrong human/org/Agent/target, stale form and stale confirmed versions, duplicate
delivery and uncertain writes. Existing creation and webhook credentials must
remain unchanged by same-kind update paths. Replacement acceptance additionally
covers both directions, atomic pause/link creation, private one-time credentials,
unchanged records before Confirm, old run history, repeated confirmation and
uncertain writes without duplicate successors.
