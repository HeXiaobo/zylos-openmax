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
`form_context` is display context, never API parameters or authorization.

1. Complete Common's identity verification first, including explicit verified
   `org` on every call. Read `event-binding.get {org,id:target_binding_id}`.
   If the current binding is a webhook, also read
   `webhook.get {org,id:target_binding_id}` for its full filter. Both reads must
   agree on ID, version, source kind, owner and lead; reread after intervening
   changes. Every returned `org_id`, if present, must match the verified org.
2. Match target ID to the envelope, owner to the verified human, and lead to this
   Agent. Configuration owner/lead must match too. Missing/deleted target, denied
   read or identity mismatch stops without writes or Issue intake. Never repair
   identity by changing owner, lead or trigger kind. Retain current and desired
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

## Propose and apply

Use Common's single server-card proposal/readback/status process, with a new UUID
for the exact revision (not the handoff correlation ID):

```text
automation.authorization_propose {org,request_id,source_kind,operation:"update",target_binding_id,expected_version,configuration}
```

Record the agreed target/version and full replacement before proposing. Explain
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
confirmed configuration. Missing cross-links or inconsistent reads leave the
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
and require `status:"supported"`. This checks replacement support; signed
proposals and mutations still use `operation:"update"` with original target/version.
Ordinary update eligibility is insufficient. Do not change minimum versions or
upgrade the plugin to pass a request. Keep editing unavailable until compatible
backend/plugin are deployed; consult Recovery before rollout/eligibility changes.

Instruction tests are not live Agent proof. Acceptance must cover same-kind and
both replacement directions, no changes before Confirm, Modify/Cancel, wrong
identities/target, stale form/confirmed versions, duplicate/uncertain writes,
atomic pause/cross-links, private credentials and retained historical runs.
