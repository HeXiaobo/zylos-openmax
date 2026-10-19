## Resolving a draft timer schedule

Required for every timer creation or update: apply after verifying the human and organization.

- With no explicit picker schedule, parse a complete time in `spec.description`
  using the retained user timezone. Do not ask the human to choose between that
  time and an absent picker value. Never invent Monday 09:00, a one-hour interval,
  or any other default schedule. Preserve any timezone explicitly stated in the
  description; resolve genuine timezone ambiguity instead of silently rewriting it.
- A deliberately selected template's prefilled schedule counts as explicit user
  input. Preserve a complete picker/template schedule when the description gives
  no time. When both give the same schedule, ask no redundant time question.
- Compare meaning, including timezone and one-time versus recurring, before
  declaring a conflict. Only genuinely conflicting explicit picker/template and
  description values require a choice. Compatible partial inputs can complete
  each other; retain them instead of asking the human to repeat supplied values.
  If neither source gives a complete schedule, ask only for the missing pieces
  in the user's timezone. Do not infer a date, frequency, or interval merely
  because a mode was selected. If the timezone itself is missing or ambiguous,
  clarify it; do not use the machine timezone as a fallback.
- For a real two-way conflict, send a clickable clarification card with two
  options, one for the description and one for the picker/template. Each option
  must name its actual local time and timezone and whether it is one-time or
  recurring (with date or frequency as applicable). Do not send a plain-text
  A/B question when the existing OpenMax card workflow is available. Use `[CARD]`
  through the exact routed C4 reply path, or `comm.ask_card` for a proactive
  question in the verified DM, following `references/comm-operations.md`.
  Set `kind` to `automation-schedule-clarification`, `askedOf` to the verified
  human member ID, and `meta` to the request ID and current draft revision so
  the answer can be matched to this request. Retain the two candidate schedules
  in the pending context; do not turn card labels into API parameters.
  On receipt, use `comm.answered` and accept only an `actionable` answer for
  this request's current revision; then clear it with `comm.pending_clear`.
  Ignore stale or duplicate receipts and unauthorized actors. A failed card send
  leaves the conflict unresolved; do not silently choose a schedule.
- A clarification card choice only resolves schedule input; it is not final
  authorization to create or update. After resolving the draft, follow Automation Common's server-card process:
  ask the server to send the final readable confirmation card. Do not use a
  clarification card receipt as an authorization confirmation ID.

Reference acceptance scenarios (instruction checks, not live Agent evidence):

| Input | Expected clarification |
| --- | --- |
| Untouched picker; description says every weekday at 18:15; user timezone Asia/Singapore | Parse description; no picker-versus-description question. |
| Explicit weekly Monday 09:00 picker; description says weekly Monday 18:15; both Asia/Singapore | Two clickable options naming each time, timezone, and weekly recurrence. |
| Explicit weekly Monday 09:00 picker; description gives the same time and timezone | No redundant time question. |
| Neither description nor picker supplies time; user timezone Asia/Singapore | Ask for the missing schedule in Asia/Singapore; no invented default. |
| Once mode with an explicit date but no time; description gives no time | Keep the date and ask only for the time in the user timezone. |
| Explicit template has a complete schedule; description gives no time | Keep the template schedule. |
| Current schedule clarification card is answered | Revise the draft, then have the server send one final confirmation card; no create from the clarification click. |



