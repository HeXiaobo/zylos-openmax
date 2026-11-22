/**
 * System-event log hygiene (task #44 / PR #135).
 *
 * cws-comm delivers every non-create message lifecycle event as a `system`
 * frame. A handful of these are pure no-ops for the agent (reactions, read /
 * delivered receipts, @-mention notices) and arrive at high frequency — logging
 * them on every frame floods out.log with lines the agent never acts on.
 *
 * `logSystemFrame` centralizes the ENTIRE stdout decision for a system frame so
 * it stays unit-testable without importing the comm-bridge daemon (which
 * self-executes on import). It emits exactly ONE line for an event the agent
 * cares about, and ZERO for benign no-ops:
 *
 *   - benign no-op            → no line
 *   - classify(ev) truthy     → one `system event=…` trace line
 *   - classify(ev) null/false → one `unhandled system event: …` line
 *
 * The dispatcher owns the single call; handleSystemEvent no longer logs the
 * unhandled case (that would double-log every unknown event — one trace + one
 * unhandled). `classify` is injected because classifySystemEvent lives in
 * comm-bridge.js and can't be imported here.
 */

// Known benign no-op system events. Matched case-insensitively. These are
// suppressed from stdout; every OTHER system event still logs (exactly once) so
// genuine contract drift (a new/unexpected event kind) stays visible.
export const BENIGN_NOOP_SYSTEM_EVENTS = new Set([
  'message.reaction.added',
  'message.reaction.removed',
  'message.read',
  'message.delivered',
  'message.mention.created',
  'message.created',
]);

export function isBenignNoopSystemEvent(name) {
  return BENIGN_NOOP_SYSTEM_EVENTS.has(String(name || '').toLowerCase());
}

/**
 * Emit the single stdout line (if any) for an inbound `system` frame. Called
 * once by the comm-bridge dispatcher; mirrors the live sequence so unknown
 * events log exactly once. Returns true when a line was emitted.
 *
 * @param {(msg: string) => void} log   stdout logger
 * @param {string} slug                 org slug for the log prefix
 * @param {object} frame                the raw ws frame ({ payload: { event, conversation_id } })
 * @param {(ev: string) => *} classify  classifySystemEvent — truthy = actionable/known
 */
export function logSystemFrame(log, slug, frame, classify) {
  const ev = frame?.payload?.event;
  if (isBenignNoopSystemEvent(ev)) return false; // high-frequency no-op → silent
  const conv = frame?.payload?.conversation_id;
  if (classify(ev)) {
    // Known / actionable event — the pre-classification trace is the one line.
    log(`[${slug}] system event=${ev || '<unknown>'} conv=${conv || '<unknown>'}`);
  } else {
    // Unknown event we don't act on — one "unhandled" line keeps drift visible.
    log(`[${slug}] unhandled system event: ${ev || '(unknown)'} conv=${conv || '?'}`);
  }
  return true;
}
