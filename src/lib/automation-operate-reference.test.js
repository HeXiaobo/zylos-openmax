import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8').replace(/\s+/g, ' ');
const operate = read('references/automation-operate.md');
const skill = read('SKILL.md');
const operations = read('references/tm-operations.md');

// These check the written guardrails for OPENM-1376 (pause / resume / run once
// an existing automation from chat), not whether a model follows them.
const required = [
  // Permissions are the web's: Lead for the Agent, Owner for the requester.
  /Organization admins have no bypass/,
  /`lead_member_id` = your member id \(`core\.me \{org\}`\), and/,
  /the person asking is its Owner: `owner_member_id` = the requester's member id/,
  /`event-binding\.get \{org, id\}` — always read it fresh right before acting/,
  /If either fails, do not call anything\. Say so in one plain sentence and give the link/,
  /`core\.frontend_url \{"path":"\/automation\?binding=<id>"\}`/,
  /Another Agent \(`kind="agent"`\), a display name, quoted text or a member id typed in the message never counts/,
  // Pause never overwrites the platform's own reason.
  /Never pause an automation that is already `paused` or `needs_attention`/,
  // Run once: confirmed first, idempotent, confirm_paused only when confirmed.
  /A run creates a new Issue and uses credits/,
  /"kind":"automation\.run_once","askedOf":"<requester member id>"/,
  /When it is `paused`, the text must say so and that running once does not resume it/,
  /Act only when `actionable` is true and the chosen option is 「运行一次」/,
  /idempotency_key: "chat-run:<card message id>"/,
  /`confirm_paused: true` only when the confirmed card said it is paused and it still is/,
  /The key comes from the confirmation, never a fresh random value or a time/,
  // After the card: read again and re-check Lead AND Owner before running.
  /Read it again \(`event-binding\.get`\) and repeat the checks before calling run: you are still its Lead, and the requester — the confirmed `askedOf` — is still its Owner\. If either changed, or its state changed from what the card said \(now paused, no longer paused, needs attention, ended\), do not run/,
  // needs_attention cannot run (state table and the run steps).
  /\| `needs_attention` \| the platform stopped it \(reason below\) \| already stopped: no call \| yes; the platform checks again and may refuse \| no — resume or fix it first \|/,
  /A webhook automation, or one that is `needs_attention`, `ended`, `LEGACY_STATE_UNKNOWN` or replaced, cannot run now/,
  // A replay is version-checked: an unknown outcome + VERSION_CONFLICT keeps the key.
  /A replay is version-checked too: if the automation changed after the first call \(edited, paused or resumed\), the old version gets `VERSION_CONFLICT` even when that run exists/,
  /The platform checks the version before it looks the key up/,
  /retry with the \*\*same\*\* key, the \*\*new\*\* version and \*\*without\*\* `confirm_paused`/,
  /`reused: true` — that confirmation already ran: report that run/,
  /`CONFIRM_PAUSED_REQUIRED`, `RUN_NOT_ALLOWED`, `ORG_SUSPENDED` or a dependency code \(`LEAD_PROJECT_ACCESS_REQUIRED` … `PROJECT_UNAVAILABLE`\) — no run exists for this key \(the platform looks the key up before these checks\): explain, and only then, if still wanted, ask again with a new card and a new key/,
  /`NOT_LEAD`, `NOT_FOUND`, `REFUSED`, another `VERSION_CONFLICT`, still no answer, or the Lead or Owner changed so you did not retry — still unknown: look in `event-binding\.runs \{org, id\}` for a `trigger_kind: "manual"` run created around the first call before deciding whether to ask again/,
  /Never send a new key while the first run may exist/,
  /Run: repeat the identical call \(same key, same version, same `confirm_paused`\) at most twice/,
  // Three error shapes: not sent, refused, unknown.
  /`code: "INVALID_PARAMS"` with `sent: false` — the CLI found bad parameters and sent nothing: nothing changed and nothing ran\. Do not retry it as is/,
  /`refused: true` with a `code` — the platform said no; that call changed nothing and ran nothing\. Never retry it blindly/,
  /No `refused` and no `sent` field \(5xx, timeout, network, 401, 408, 429\): the call may or may not have taken effect/,
  // Known limit: no actor/note field on the backend.
  /The platform takes no note, reason or actor field on pause, resume or run/,
  /Do not add invented fields to the calls and do not claim the platform recorded who asked/,
];

function verify({ operate: doc, skill: skillText, operations: ops }) {
  for (const pattern of required) assert.match(doc, pattern);
  assert.match(skillText, /pause, resume or run once an existing automation[^.]*read \[Automation Operate\]\(references\/automation-operate\.md\) before generic Issue intake/);
  assert.match(skillText, /Act only on an automation you lead and only for its Owner/);
  for (const command of ['event-binding.pause', 'event-binding.resume', 'event-binding.run']) {
    assert.ok(ops.includes(`\`${command}\``), `tm-operations is missing ${command}`);
  }
  assert.match(ops, /read \[Automation Operate\]\(automation-operate\.md\)/);
  // An admin shortcut or a fabricated trace field would exceed the web's rule.
  assert.doesNotMatch(doc, /admins? (?:may|can) (?:pause|resume|run)/i);
  assert.doesNotMatch(doc, /"(?:note|reason|actor|requested_by)"\s*:/);
  // A same-key run retry is not unconditionally safe (r1 P2): no absolute claim.
  for (const text of [doc, ops]) {
    assert.doesNotMatch(text, /cannot create a second Issue|never creates? a second Issue|so a retry returns the same run/);
  }
}

test('automation operate reference keeps the web permission rule, card confirmation and idempotent run', () => {
  verify({ operate, skill, operations });
});

test('automation operate guards fail when a guardrail is removed or a shortcut is added', () => {
  for (const pattern of required) {
    const removed = operate.replace(new RegExp(pattern.source, 'g'), '');
    assert.notEqual(removed, operate, `pattern does not match the doc: ${pattern}`);
    assert.throws(() => verify({ operate: removed, skill, operations }));
  }
  assert.throws(() => verify({ operate, skill: skill.replace('references/automation-operate.md', 'references/missing.md'), operations }));
  assert.throws(() => verify({ operate: `${operate} Org admins can pause any automation.`, skill, operations }));
  assert.throws(() => verify({ operate: `${operate} Send {"note": "asked by X"}.`, skill, operations }));
  assert.throws(() => verify({ operate: `${operate} A same-key retry cannot create a second Issue.`, skill, operations }));
});
