# Automation Update

An edit-form submission requests a proposal, not an authorized mutation. Do not
register an Issue, execute the task, run-now, delete, rotate credentials, or call
create to replace a binding. A trigger change uses only the server's atomic
result of a confirmed update.

**Required:** read [Automation Common](automation-common.md) in full. For timer
configuration also read [Schedule Resolution](automation-schedule.md); for webhook
configuration or a trigger replacement in either direction, also read
[Webhook Rules](automation-webhook.md). Read [Recovery](automation-recovery.md)
for old-proposal rejection, store outage, rollout or ordinary update eligibility.

## Validate the handoff and target

The fenced envelope requires `kind: "automation-update-request"`, `schema_version: 1`,
`request_id`, `org_id`, `requester_member_id`, `lead_member_id`, `source_kind`,
`target_binding_id`, `expected_version`, `configuration` and `form_context`.
IDs must be nonzero UUIDs; `expected_version` a positive safe integer.
`source_kind` is the desired `timer` or `webhook` kind. Configuration is a full
replacement using that kind's REST fields; reject unknown fields or schemas.
Optional `project_member_additions` follows Common's
[Project member additions](automation-common.md#project-member-additions) rules:
it is a write-time list, not a stored field, so carry only the handoff's list
verbatim and never derive one from the baseline binding.
`form_context` is display context, never API parameters or authorization.

An update may switch an attached automation to no project (OPENM-1308): its
spec then has `unattached: true` and `unattached_scope` and no `project_id`.
Treat it as Common's
[No project and output knowledge base](automation-common.md#no-project-and-output-knowledge-base)
describes: do not ask for a project and never put the baseline `project_id`
back, which would undo the change. The form takes the scope from the saved
automation; the server refuses a real scope change
(`AUTOMATION_SCOPE_CHANGE_FORBIDDEN`). A private automation needs its Owner's
personal private project: on `AUTOMATION_PRIVATE_WORKSPACE_REQUIRED` explain
that the Owner must create their private workspace first and stop; never attach
it to a project instead. An edit of an automation that is already unattached
names the system project its read returned and omits `unattached`, which keeps
it unattached; `unattached: false` with a `project_id` attaches it.

1. Complete Common's identity verification first, including explicit verified
   `org` on every call. Read `event-binding.get {org,id:target_binding_id}`.
   If the current binding is a webhook, also read
   `webhook.get {org,id:target_binding_id}` for its full filter. Both reads must
   agree on ID, version, source kind, owner and lead; reread after intervening
   changes. Every returned `org_id`, if present, must match the verified org.
2. Match target ID to the envelope, owner to the verified human, and lead to this
   Agent. Configuration owner normally remains the persisted Owner; an explicit
   handover uses the Owner handover rules below. Configuration lead
   normally matches the current Lead; an explicitly requested replacement uses
   the Lead replacement rules below. Missing/deleted target, denied
   read or identity mismatch stops without writes or Issue intake. Never repair
   identity by changing the requesting Agent or Owner. Retain current and desired
   source kinds separately; a difference requires an explicit human request and
   the replacement eligibility check below **before proposing**.
3. Compare the read version with the handoff's `expected_version`. A stale form
   requires showing relevant current values and asking which requested changes
   still apply. Never silently refresh the version and apply the old replacement.
   Keep the baseline full configuration; preserve fields the human did not ask to
   change, and clarify only missing values/conflicts without inventing schedules.
4. Track `(org, DM, request_id, target_binding_id)`, baseline version, draft,
   questions, proposal and write outcome. Recover interrupted history before
   writing; redelivery never authorizes an additional update.

## Owner handover

Only the verified current Owner may hand over an existing automation. An
organization administrator who is not the current Owner cannot authorize it.
Keep the requester and confirmation DM unchanged; put the explicitly selected
colleague in `configuration.owner_member_id`. Core validates that the final
target is an active human in the same organization, a member of the selected
project, and permitted to chat with the final Lead. Failure blocks the operation;
never grant membership, reset the target to the requester, or impersonate them.
A target Owner listed in the handoff's `configuration.project_member_additions`
joins the project when the confirmed update succeeds; their current
non-membership is not a blocker. Pass that list verbatim; it is not you granting
membership, and you must not add one that the handoff did not carry.

The server card must explain the old and new Owner, loss of Owner-level config
editing rights, and that existing runs and pending approvals remain with the
old Owner while newly started runs use the new Owner. Keep original project
access unchanged. Only the current Owner confirms; do not seek a second card
from the recipient. Changes to other fields use the same full configuration,
version and single confirmation. Owner and trigger-kind changes cannot be
combined; explain that they must be saved separately before proposing.
If the returned card omits any of these responsibility changes or the complete
resulting configuration, stop before confirmation or mutation and reconcile with
the server; never infer missing card contents or supply a second authorization card.

The server resolves the future target-Owner/Lead result DM. Never include a DM
ID in configuration or forward private confirmation history. Read back the
returned Owner and full configuration after success. Loss of read access after
handover is not proof of failure and never authorizes another mutation.
For an accepted Webhook event that has not yet created a run, the server applies
the current Owner and matching delivery context when it starts the run. Existing
created runs retain their recorded principals and delivery context. Do not
rewrite event payloads, filters, old Issues or historical approvals during handover.

## Owner-confirmed Lead replacement

For a direct chat request to change Lead, identify one existing automation before
proposing. Read its authoritative ID, Owner, current Lead, version and complete
configuration under Common's verified human/Agent/org/DM checks. A direct request
does not require manufacturing a form envelope, and does not skip confirmation.
Ambiguous automation or Agent names require clarification, not guessing.

The requesting Agent A must remain the persisted current Lead, and the human must
be the persisted Owner. An organization administrator who is not that Owner cannot
authorize the change. Keep envelope `lead_member_id` as A for form handoffs; set
only `configuration.lead_member_id` to the explicitly requested target B. Never
replace the authenticated caller with B or create a new automation as a workaround.
Read `core.member_get {org,memberId:<target B>}` and
`core.project_members {org,projectId:<confirmed project>}`. Verify the returned
member identifies B as an active Agent in the same organization, and B appears in
the confirmed project's member list. `member_get` has no org field: its successful
read using the verified org's authentication proves the same-org lookup; Core
rejects a target outside that authenticated org. Match its `member_id` to B.
Project members use numbered pages, not `cursor` or `next_cursor`. Start at
`page:1` and keep the same verified `org`, `projectId` and `pageSize` on every call.
If B is absent and `pagination.page < pagination.total_pages`, call
`core.project_members {org,projectId:<confirmed project>,page:<next page>,pageSize:20}`
with page incremented by one until B is found or every page is read. Match both
`member_id` to B and `project_id` to the confirmed project. Never infer absence
from the first page alone. Only a completed, consistent traversal with no match
establishes that B is not a project member; zero `total_count`/`total_pages` on an
empty first page is also complete. Missing or inconsistent pagination, a repeated
or unexpected page, changing totals, or any failed page leaves membership
unresolved: report "unable to confirm project membership" and stop before
confirmation, never report "not a member" from partial results.
When a form handoff's `configuration.project_member_additions` lists B, a
completed traversal without B is expected and not a blocker: B joins the
project when the confirmed update succeeds. Otherwise B must already be a
member. A direct chat request carries no such list; never create one.
When the read has `spec.unattached: true`, its `project_id` is the Inbox or the
Owner's hidden private project: skip the `core.project_members` traversal for
B; Core validates B against that project at proposal and mutation, and a
rejection stops the transfer.
Likewise, when the confirmed spec moves the automation to no project in the
same handoff (`unattached: true` and no `project_id`, even though the read
still shows `unattached: false` and the old project), there is no confirmed
project to traverse: skip the `core.project_members` traversal for B and never
fall back to the old project. Core no longer requires membership in the
original project (OPENM-1301) and validates B against the target (Inbox or
hidden private project) at proposal and mutation; a rejection stops the transfer.
A rejected or unavailable directory read
stops before confirmation; do not add project membership, upgrade Agents or change flags.
Core enforces B's runtime readiness through server-side admission at proposal
preparation and mutation. Do not query another Agent's automation eligibility or
invent a readiness endpoint. A server admission rejection stops the transfer;
never substitute the requesting Agent's readiness for B's.
Check `automation.eligibility {org,memberId:<requesting A>,operation:"lead_change",projectId:<confirmed project>}`
(target named as in [Replacement eligibility](#replacement-eligibility))
and require `status:"supported"` before proposing the transfer. Known limitation:
for a confirmed spec with `unattached: true` and `unattached_scope: "private"`,
Core resolves the hidden private project only for human callers, so this Agent
eligibility check returns a rejection; stop and tell the Owner to make that
change in the automation editor instead. Ordinary update
eligibility is not evidence of Lead-change compatibility. Unknown operation,
unsupported version, unavailable or stale capability data stops this transfer;
never fall back to `operation:"update"` to bypass this compatibility check.

Use the existing update proposal with the original binding ID/version. Require the
server card to name A -> B and explain that future runs use B while already
snapshotted runs retain A. Only the actual Owner's confirmation of this exact
proposal permits mutation. Keep confirmation in A's original DM with Owner;
the server resolves B's future result DM. Do not supply or overwrite delivery DM
IDs in configuration, send a second card in B's DM, or transfer chat transcripts.
Create and unverified Agent writes retain the self-Lead restriction.

Lead replacement alone preserves Owner. An explicit combined Owner handover
must also satisfy the Owner handover rules; trigger-kind replacement cannot be
combined with either principal change. Preserve webhook
credentials/URL, filters, prompt, schedule, pause state and run history. Do not
combine Lead and trigger replacement into an unreviewed operation. Other requested
field edits retain their existing validation and confirmation requirements.
After success, compare the result and exact target readback against confirmed B,
the confirmed Owner and the complete configuration. An access denial after transfer
is not proof of failure: report verification incomplete and do not repeat PUT,
create, impersonate B or ask for new privileges. Existing runs and queued webhook
snapshots continue with their recorded Lead and result DM for Lead-only edits;
an explicit Owner handover follows the run-start boundary described above.
Future snapshots use B.
The change record must identify Owner and conversation confirmation, not A as Owner.
If A is unavailable, direct the Owner to the editor; another Agent cannot take over
the chat update. Unsupported backend behavior fails closed; never bypass proof.

## Propose and apply

Use Common's single server-card proposal/readback/status process, with a new UUID
for the exact revision (not the handoff correlation ID):

```text
automation.authorization_propose {org,request_id,requester_member_id?,source_kind,operation:"update",target_binding_id,expected_version,configuration}
```

Record the agreed target/version and full replacement before proposing. Explain
that unchanged-Owner updates omit `requester_member_id`; an Owner handover must
send the verified persisted current Owner, never the target colleague. Follow
Common's Core-first compatibility rule and stop if unsupported. Explain
that this modifies an existing automation and show its resulting task, project,
owner, Agent, trigger/timezone and output. For a trigger change, explain that a
new automation replaces and pauses the original while retaining old run history
and already-started execution. The signed proposal always targets the original
ID/version; never substitute a new ID or a create proposal. Common's confirmation
checks apply unchanged; `cancelled` leaves the existing automation unchanged.

Only after verified confirmation, use `event-binding.update` for desired timer
or `webhook.update` for desired webhook, even if the original has the other kind:

```text
{org,id:<confirmed original target>,expected_version:<confirmed version>,source_kind,configuration:<confirmed full replacement>,authorization_proposal_message_id,authorization_card_interaction_id}
```

Use structured JSON, never shell-interpolated human text. Do not forward the
envelope or `form_context`. Never use create as a fallback, strip proof, reuse
creation proof, swap targets or rewrite a confirmed version. Clarification,
Modify and Cancel cause no automation writes. For timer-to-webhook replacement,
prefix the **original** `webhook.update` call with `COCO_RPC_LOG=0`; the final JSON,
not its redacted preview, contains the credential. Logging changes never justify
repeating an executed mutation.

A stale-version rejection requires rereading, reconciling the requested changes,
a new proposal and fresh confirmation. Do not silently refresh `expected_version`
or replay the old update. For 401 restore authentication separately. On timeout,
5xx, connection loss or unreadable result, reconcile target version/configuration
before declaring success or failure. Do not automatically repeat PUT or replace
proof while a write is uncertain. For replacements inspect the original's
successor link first, then that successor; otherwise follow Common's discovery
rules. An absent or inconsistent result is not permission to create.

## Verify and deliver the result

For same-kind edits, read the same target with its source-specific get. For
replacement, require all of the following:

- Original `event-binding.get`: `display_status: "paused"` and
  `replaced_by_binding_id` matching the returned successor.
- Successor's source-specific get: `replaces_binding_id` matching the original;
  both records' org/owner/lead agree and successor configuration matches the plan.
- Timer results are direct bindings. Webhook update/get returns `binding`,
  `event_filter`, `credential_version`: check identity and links inside `binding`
  and check `event_filter` separately. Only a successful new webhook replacement
  may additionally return `webhook_url`; get does not reveal it.

For both paths, verify ID, owner, lead, source kind, returned version and complete
confirmed configuration. A confirmed spec with `unattached: true` and no
`project_id` is compared by `spec.unattached` and the binding's `scope`, not
`project_id`, as in Common. Missing cross-links or inconsistent reads leave the
outcome unknown. Report success only after the update result and readback agree.
Report task name, actual state and returned next timer time with local timezone.
No Automation list link, internal endpoint, binding/proof ID or raw metadata;
do not call `core.frontend_url`. Repeated confirmation returns the verified
existing result, not another write.

Same-kind webhook updates preserve credentials: do not reissue, rotate,
reconstruct or request a new `webhook_url`. For a new timer-to-webhook successor,
follow [credential receipt checks](automation-webhook.md#one-time-webhook-credential-receipt):
send a usable final-JSON URL only in the original verified owner-Agent private DM.
If missing, empty or `[REDACTED]`, inspect the existing original result without
another write. If unavailable, report credential delivery incomplete even when
binding readback succeeds; do not rotate, reconstruct or repeat the replacement
to obtain it. Never expose the secret in groups, logs, artifacts or public pages.

## Replacement eligibility

Before proposing a trigger change, require plugin 2.25.0 and the independent
`AUTOMATION_REPLACE_MIN_AGENT_VERSION` gate (empty disables replacement). Call
`automation.eligibility {org,memberId:<verified Agent>,operation:"replace",projectId:<confirmed project>}`
and require `status:"supported"`. Name the target as the confirmed spec does:
`projectId` when it has a `project_id` (for an automation that is already
unattached, the system project its read returned), or
`unattachedScope:<its unattached_scope>` (`org` when omitted) instead of
`projectId` when it has `unattached: true` and no `project_id`; never both. A
rejection stops; never retry with the other form. This checks replacement
support; signed proposals and mutations still use `operation:"update"` with
original target/version.
Ordinary update eligibility is insufficient. Do not change minimum versions or
upgrade the plugin to pass a request. Keep editing unavailable until compatible
backend/plugin are deployed; consult Recovery before rollout/eligibility changes.

Instruction tests are not live Agent proof. Acceptance must cover same-kind and
both replacement directions, no changes before Confirm, Modify/Cancel, wrong
identities/target, stale form/confirmed versions, duplicate/uncertain writes,
atomic pause/cross-links, private credentials and retained historical runs.
