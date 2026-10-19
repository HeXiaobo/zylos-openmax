# Automation Creation

Handle a new automation form handoff in the existing human-agent DM. This is a
creation conversation, not an instruction to execute the task or register an
Issue. Use the existing automation APIs after confirmation. Leave all later
scheduling, Issue generation, execution approvals and acceptance unchanged.

## Handoff contract

The normal TEXT message contains human-readable instructions followed by fenced
JSON with this envelope:

```json
{
  "kind": "automation-create-request",
  "schema_version": 1,
  "request_id": "stable UUID for this form submission",
  "org_id": "organization UUID",
  "requester_member_id": "human UUID",
  "lead_member_id": "selected agent UUID",
  "source_kind": "timer",
  "configuration": {
    "lead_member_id": "selected agent UUID",
    "owner_member_id": "human UUID",
    "spec": {"project_id": "project UUID", "title": "Task title", "description": "Task instructions"},
    "schedule_kind": "cron",
    "cron_expr": "0 9 * * 1",
    "timezone": "Asia/Singapore"
  },
  "form_context": {}
}
```

**Required:** read [Automation Common](automation-common.md) in full before
proceeding; it owns identity, configuration, server-card confirmation, proof and
uncertain-write rules. For timers also read [Schedule Resolution](automation-schedule.md).
For webhook creation also read [Webhook Rules](automation-webhook.md) for filter
resolution and one-time credential delivery. For known old proposal rejection or
rollout, read [Recovery](automation-recovery.md).

## Conversation workflow

1. Track this request by `(org_id, DM conversation, request_id)` in the existing
   conversation context/memory. Retain the latest proposed configuration,
   outstanding questions, whether its latest revision was confirmed, and any
   actual creation result. A redelivered request does not authorize a new create.
   Resume from conversation history after interruption; if history is incomplete,
   recover it before writing. Do not guess that an earlier write failed.
2. Check whether the task is actionable: trigger/timezone, project, executor,
   owner, required inputs/access, concrete work and expected output/destination.
   Ask only for missing or ambiguous information. Do not ask again for fields
   already supplied. Preserve clarified task instructions in `spec.description`;
   do not merely leave information required at execution time in the DM. For a
   draft timer, apply the [schedule-resolution rules](automation-schedule.md) before proposing.
3. Follow Automation Common's server plan/card process with `operation:"create"`.
   Confirmed status is not mutation success; apply its exact proof and uncertainty rules.
4. After the server verifies the latest plan's confirmation, call `src/cli/tm.js` with
   `event-binding.create` for timer or `webhook.create` for webhook. Pass
   `{"org":"<verified org_id>","source_kind":"<confirmed timer or webhook>","configuration":<confirmed configuration>,"authorization_proposal_message_id":"<actual registered proposal ID>","authorization_card_interaction_id":"<UUID returned by authorization_status>"}`.
   For the original `webhook.create` invocation, prefix the command with
   `COCO_RPC_LOG=0` (for example, `COCO_RPC_LOG=0 node src/cli/tm.js webhook.create ...`)
   so RPC debug previews do not obscure the credential-bearing result. This
   changes logging only; it is never a reason to repeat an executed mutation.
   Apply Automation Common's mutation proof rules. Do not call `issue.create`,
   `issue.activate`, run-now, or a scheduler to emulate creation; do not reassign
   the lead to fix a denial.
5. Before reporting success, compare the returned binding's `source_kind`,
   owner, lead, spec and schedule/filter with the confirmed configuration.
   Use `event-binding.get` for timer or `webhook.get` for webhook when needed.
   A mismatch or unreadable result is not verified success: report uncertainty,
   never automatically recreate or delete the binding.
   Record the returned binding ID privately. Report the task name, actual state
   and timer's next trigger time if returned in readable local time with timezone;
   do not expose binding IDs or protocol fields. Do not include an Automation
   list link in the creation result. Do not call `core.frontend_url` for this
   receipt or construct a browser link from the backend/BFF address: it may be
   an internal IP or service endpoint, not a public frontend URL.
   A webhook response includes a one-time secret
   `webhook_url`: send it only in this verified requester's DM when required for
   setup, never in group messages, public reports, screenshots or memory files.
   Preserve the existing webhook setup flow. Do not rotate the URL automatically.
   Apply [one-time webhook credential receipt](automation-webhook.md#one-time-webhook-credential-receipt)
   checks before claiming a usable setup URL was delivered.


## Updating an existing automation

For edits, read [Automation Update](automation-update.md); never reuse creation
proof for update, another binding or another version. Do not run create for edits.
