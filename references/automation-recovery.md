# Automation Recovery and Compatibility

Conditional reference for known unregistered old proposals, proposal-store outage,
rollout and update eligibility. Read [Automation Common](automation-common.md)
first; its uncertainty reconciliation rules remain mandatory.

### Previously sent plans after an upgrade

An old plan sent before server registration was required can receive 403 when
the human confirms it after the Core upgrade. Explain in plain language:
"The confirmation flow has been updated, so the earlier plan can no longer be
accepted. I will check whether the automation was already saved before sending
you a new plan to confirm." Do not blame the human or describe their reply as
invalid. Do not expose authorization IDs or protocol details in that explanation.

First reconcile any prior uncertain create/update using the discovery and
version checks in Automation Common. A later 403 does not resolve an earlier uncertain write.
If an earlier operation succeeded, return its verified result without another
creation. While any write remains unresolved, do not issue replacement proof or
retry the mutation. Only after a known rejection of the unregistered proposal
and no unresolved writes, call `automation.authorization_propose` with a new
request ID for the verified current configuration. Read back the new server-sent
readable card and obtain a new verified human card confirmation before writing.
Never reuse the old proposal or confirmation IDs, manufacture a confirmation,
or fall back to raw `automation.authorization_preview` output.

A proposal-store outage returns 503, not the unregistered-proposal 403. Explain
that confirmation is temporarily unavailable; do not invalidate the human's
reply, substitute a new proposal, or blindly retry a create/update. Reconcile
any uncertain mutation first and wait for store health to recover. If only a
proposal send is uncertain, use the same request ID and identical configuration
under the proposal recovery rules in Automation Common after recovery.

### Coordinated rollout

Required order: deploy compatible Work with the card proof contract, successfully
apply and verify Core migrations 110 and 111, then deploy compatible Core and
verify proposal-store and confirmation-card health, then release the compatible
plugin. Stop the rollout if any prerequisite fails.
Verification must include durable proposal registration and readback, not just
process liveness. This is rollout guidance, not permission to deploy or create
test automations in a live environment.

Existing registered legacy proposals keep their original verification rules;
unregistered legacy previews must follow the recovery above. Plan a maintenance
window if needed to prevent new confirmations during an incompatible interval;
do not promise zero downtime. An old plugin must not interpret a SYSTEM card
receipt as quoted human confirmation.


## Update eligibility

Update handoff eligibility must require a plugin release containing this routing
and workflow (2.23.0), independently of creation eligibility. Configure Core's
`AUTOMATION_UPDATE_MIN_AGENT_VERSION` only after verifying that compatible source
is actually deployed and reported by the target Agent; its empty default disables
update handoffs. A minimum-version override
is not proof of support; do not upgrade the installed plugin automatically.
Keep edit handoff unavailable until compatible backend and plugin are deployed.


## Backend evidence

Backend contract evidence: Core `internal/transport/http/event_binding.go`
registers shared list/get/delete; `automation_webhook.go` exposes webhook
configuration by binding ID. Work `internal/app/webhook_service.go` creates an
EventBinding with `source_kind=webhook`; `ListEventBindingsByOrg` in
`internal/generated/sqlc/event_binding.sql.go` filters only org and deletion,
not source kind. Work `internal/transport/rpc/event_binding.go` authorizes and
soft-deletes either binding through `DeleteEventBindingVersion`.


