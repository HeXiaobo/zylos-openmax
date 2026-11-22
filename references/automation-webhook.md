# Automation Webhook Rules

Required when creating or updating a webhook, or replacing a trigger in either
direction. Read after Automation Common's identity checks. These rules do not
authorize a write; use the relevant Creation/Update workflow.

## Resolving a webhook event filter

Apply after verifying the human and organization, before proposing the desired webhook configuration:

- Translate a natural-language condition into `event_filter` when the payload
  field and value are established by the user's sample JSON, supplied schema,
  or explicit field mapping. Do not require the human to write CEL syntax.
  For example, given `{"type":"order.created"}` and "only order.created events",
  use `has(payload.type) && payload.type == "order.created"`. Here `type` is a
  field of that example payload, not a platform-defined event-type field.
- The only CEL variable is `payload`, the received JSON object. Do not use
  undeclared variables such as `event`, `body`, or `type`. Do not guess whether
  a provider uses `type`, `event_type`, `action`, or a nested path. When that
  mapping is missing, ask only for a sample payload or the field containing
  the event type; once known, derive the expression yourself.
- Use presence guards for fields that can be absent: a missing field without
  a guard causes an evaluation error rather than a normal non-match. For a
  known nested mapping, guard each optional parent before selecting its child.
  The supported CEL subset includes field/index selection, `has`, comparisons,
  and boolean logic. Do not assume full CEL functions, regex, or comprehensions
  are supported.
- Preserve an explicitly supplied filter. If it conflicts with the requested
  condition, clarify before proposing a replacement. An empty filter matches
  all events; never clear a requested restriction to work around uncertainty.
  Include the condition and its actual payload mapping in the human-readable
  confirmation plan, and submit the exact derived filter through the existing
  authorization proposal/card flow before creating or updating the webhook.

### One-time webhook credential receipt

For webhook creation and a confirmed timer-to-webhook replacement, read
`webhook_url` from the final structured CLI result. A `[rpc]` response preview
is redacted logging, not the authoritative result, even when it appears on
stdout before that result. Never copy its `[REDACTED]` placeholder into a receipt.
Do not extract the URL from a `resp 200` log line with `sed`, `grep`, or similar
text matching; parse the final JSON result instead.
Require a nonempty URL string that is not `[REDACTED]` before saying a usable
setup URL was delivered. Send the actual value only in the original verified
requester/owner-Agent private DM; never expose it in group messages, public
reports, screenshots, logs, artifacts or memory files.

If the URL is absent, empty or a placeholder, inspect the existing original
command result for its final JSON without running the mutation again. Ordinary
configuration readback can verify the binding, but cannot recover its one-time
secret. If the original value is unavailable, distinguish verified creation or
replacement from incomplete credential delivery and report that setup is
blocked pending credential recovery. Do not automatically replay, rotate,
recreate, reconstruct the URL, or claim a usable receipt was sent.


