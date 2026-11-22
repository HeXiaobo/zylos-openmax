import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const skill = read('../../SKILL.md');
const updateRoute = read('../../references/automation-update.md');
const common = read('../../references/automation-common.md');
const schedule = read('../../references/automation-schedule.md');
const recovery = read('../../references/automation-recovery.md');
const webhook = read('../../references/automation-webhook.md');
const update = [updateRoute, common, schedule, recovery, webhook].join(' ');

function boundedSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing instruction section: ${start}`);
  return source.slice(from, to);
}

const leadSection = source => boundedSection(source, '## Owner-confirmed Lead replacement', '## Propose and apply');
const directChatSkillSection = source => boundedSection(source,
  'For an explicit human DM request to change the responsible Agent of an existing automation,',
  'For an existing automation run or a reply about its result,');
const directChatSkillGuards = [
  /read \[Automation Update\]\(references\/automation-update\.md\) before generic Issue intake/,
  /do not create an Issue or fabricate a form handoff/,
  /still requires the server's exact-change Owner confirmation before any mutation/,
];

function assertUpdateRouting(source) {
  assert.ok(source.includes('(automation-common.md)'), 'update must import shared authorization');
  assert.ok(source.includes('(automation-schedule.md)'), 'update must import schedule clarification');
  assert.ok(source.includes('(automation-recovery.md)'), 'update must expose conditional recovery');
  assert.ok(source.includes('(automation-webhook.md)'), 'webhooks and replacements must route to webhook rules');
  assert.match(source, /\*\*Required:\*\* read \[Automation Common\]\(automation-common\.md\) in full/);
  assert.match(source, /For timer configuration also read \[Schedule Resolution\]\(automation-schedule\.md\)/);
  assert.match(source, /for webhook configuration or a trigger replacement in either direction, also read \[Webhook Rules\]\(automation-webhook\.md\)/i);
  assert.match(source, /Read \[Recovery\]\(automation-recovery\.md\) for old-proposal rejection, store outage, rollout or ordinary update eligibility/);
  assert.doesNotMatch(source, /\]\(automation-creation\.md\)/, 'update must not import the creation workflow');
}

test('update reads required shared modules and routes recovery without importing creation', () => {
  assertUpdateRouting(updateRoute);
});

test('update routing guards reject omitted shared modules or a creation import', () => {
  for (const name of ['common', 'schedule', 'recovery', 'webhook']) {
    assert.throws(() => assertUpdateRouting(updateRoute.replaceAll(`(automation-${name}.md)`, '(missing.md)')));
  }
  assert.throws(() => assertUpdateRouting(`${updateRoute} [Creation](automation-creation.md)`));
  assert.throws(() => assertUpdateRouting(updateRoute.replace('**Required:**', '**Optional:**')));
});

// Shipped instructions are the routing implementation; these do not simulate an Agent.
test('update handoffs have their own workflow before generic task intake', () => {
  assert.ok(skill.includes('kind: "automation-update-request"'));
  assert.ok(skill.includes('[Automation Update](references/automation-update.md) before generic Issue intake'));
  assert.ok(skill.includes('Editing an existing automation must never fall through to creation.'));
  assert.match(skill, /explicit human DM request to change the responsible Agent of an existing automation/);
  assertUpdateGuards(directChatSkillSection(skill), directChatSkillGuards);
});

test('direct chat routing retains its own Owner confirmation guard in SKILL', () => {
  const section = directChatSkillSection(skill);
  for (const guard of directChatSkillGuards) {
    const changed = skill.replace(section, section.replace(guard, ''));
    assert.throws(() => assertUpdateGuards(directChatSkillSection(changed), directChatSkillGuards), /missing update safeguard/);
  }
});

const updateGuards = {
  provenance: [/require `sender_type:"HUMAN"` and `sender_id` equal to `requester_member_id`/,
    /`comm.get_message \{org,conversationId,messageId\}`/, /`core.me \{org\}`/,
    /`event-binding.get \{org,id:target_binding_id\}`/, /`webhook.get \{org,id:target_binding_id\}`/,
    /Match target ID to the envelope, owner to the verified human, and lead to this Agent/,
    /Pass this verified `org` explicitly to every directory, conversation, history, automation read, proposal, status and mutation/,
    /Both reads must agree on ID, version, source kind, owner and lead/,
    /Every returned `org_id`, if present, must match the verified org/,
    /Missing\/deleted target, denied read or identity mismatch stops without writes or Issue intake/],
  confirmation: [/operation:"update",target_binding_id,expected_version,configuration/,
    /`authorization_kind:"card"`/, /`status:"confirmed"`/, /nonzero UUID `card_interaction_id`/,
    /`replaces_proposal_message_id`/, /`modifying` \| Ask what to change; no write/,
    /`cancelled` leaves the existing automation unchanged/,
    /A stale-version rejection requires rereading, reconciling the requested changes, a new proposal and fresh confirmation/],
  recovery: [/Do not silently refresh `expected_version` or replay the old update/,
    /Do not automatically repeat PUT or replace proof while a write is uncertain/,
    /Never use create as a fallback/,
    /redelivery never authorizes an additional update/,
    /Report success only after the update result and readback agree/],
  receipt: [/No Automation list link, internal endpoint, binding\/proof ID or raw metadata/,
    /do not call `core.frontend_url`/, /do not reissue, rotate, reconstruct or request a new `webhook_url`/],
};
function assertUpdateGuards(source, safeguards) {
  for (const safeguard of safeguards) assert.match(source, safeguard, `missing update safeguard: ${safeguard}`);
}
for (const [scope, safeguards] of Object.entries(updateGuards)) {
  test(`update instructions retain ${scope} safeguards`, () => {
    assertUpdateGuards(update, safeguards);
  });
}

const replacementGuards = [
  /plugin 2\.25\.0/, /`AUTOMATION_REPLACE_MIN_AGENT_VERSION` gate \(empty disables replacement\)/,
  /operation:"replace"/, /require `status:"supported"`/,
  /proposals and mutations still use `operation:"update"` with original target\/version/,
  /signed proposal always targets the original ID\/version; never substitute a new ID or a create proposal/,
  /`display_status: "paused"`/, /`replaced_by_binding_id` matching the returned successor/,
  /`replaces_binding_id` matching the original/,
  /both records' org\/owner\/lead agree and successor configuration matches the plan/,
  /Missing cross-links or inconsistent reads leave the outcome unknown/,
  /For replacements inspect the original's successor link first, then that successor/,
  /Do not automatically repeat PUT or replace proof while a write is uncertain/,
  /send a usable final-JSON URL only in the original verified owner-Agent private DM/,
  /do not rotate, reconstruct or repeat the replacement to obtain it/,
];
test('trigger replacements retain signed old target and independent compatibility gate', () => {
  assertUpdateGuards(updateRoute, replacementGuards);
});

test('update and replacement guards reject missing actor, version, link and retry fences', () => {
  for (const safeguards of [...Object.values(updateGuards), replacementGuards]) {
    const source = safeguards === replacementGuards ? updateRoute : update;
    for (const safeguard of safeguards) {
      assert.match(source, safeguard);
      assert.throws(() => assertUpdateGuards(source.replaceAll(new RegExp(safeguard.source, 'g'), ''), safeguards), /missing update safeguard/);
    }
  }
  assert.throws(() => assertUpdateGuards(update.replace('`sender_type:"HUMAN"`', '`sender_type:"SYSTEM"`'), updateGuards.provenance), /missing update safeguard/);
  assert.throws(() => assertUpdateGuards(updateRoute.replace('`replaced_by_binding_id`', '`replaces_binding_id`'), replacementGuards), /missing update safeguard/);
});

const leadReplacementGuards = [
  /A direct request does not require manufacturing a form envelope, and does not skip confirmation/,
  /The requesting Agent A must remain the persisted current Lead/,
  /the human must be the persisted Owner/,
  /administrator who is not that Owner cannot authorize the change/,
  /Keep envelope `lead_member_id` as A/,
  /only `configuration.lead_member_id` to the explicitly requested target B/,
  /`core\.member_get \{org,memberId:<target B>\}`/,
  /`core\.project_members \{org,projectId:<confirmed project>\}`/,
  /member identifies B as an active Agent in the same organization/,
  /B appears in the confirmed project's member list/,
  /`member_get` has no org field: its successful read using the verified org's authentication proves the same-org lookup/,
  /Match its `member_id` to B/,
  /Project members use numbered pages, not `cursor` or `next_cursor`/,
  /keep the same verified `org`, `projectId` and `pageSize` on every call/,
  /`pagination.page < pagination.total_pages`/,
  /`core\.project_members \{org,projectId:<confirmed project>,page:<next page>,pageSize:20\}`/,
  /with page incremented by one until B is found or every page is read/,
  /Match both `member_id` to B and `project_id` to the confirmed project/,
  /Never infer absence from the first page alone/,
  /Only a completed, consistent traversal with no match establishes that B is not a project member/,
  /zero `total_count`\/`total_pages` on an empty first page is also complete/,
  /Missing or inconsistent pagination, a repeated or unexpected page, changing totals, or any failed page leaves membership unresolved/,
  /report "unable to confirm project membership" and stop before confirmation, never report "not a member" from partial results/,
  /A rejected or unavailable directory read stops before confirmation/,
  /Core enforces B's runtime readiness through server-side admission at proposal preparation and mutation/,
  /Do not query another Agent's automation eligibility or invent a readiness endpoint/,
  /A server admission rejection stops the transfer/,
  /never substitute the requesting Agent's readiness for B's/,
  /`automation\.eligibility \{org,memberId:<requesting A>,operation:"lead_change",projectId:<confirmed project>\}`/,
  /require `status:"supported"` before proposing the transfer/,
  /never fall back to `operation:"update"` to bypass this compatibility check/,
  /Only the actual Owner's confirmation of this exact proposal permits mutation/,
  /Keep confirmation in A's original DM with Owner/,
  /server resolves B's future result DM/,
  /Create and unverified Agent writes retain the self-Lead restriction/,
  /do not repeat PUT, create, impersonate B or ask for new privileges/,
  /Existing runs and queued webhook snapshots continue with their recorded Lead and result DM/,
  /change record must identify Owner and conversation confirmation/,
  /Do not combine Lead and trigger replacement/,
];

test('Lead replacement distinguishes requester, target, Owner and delivery while retaining fences', () => {
  assertUpdateGuards(leadSection(updateRoute), leadReplacementGuards);
  assert.match(common, /For creation, configuration lead must match envelope\/Agent/);
  assert.match(common, /For updates, the envelope lead and persisted current lead must match this Agent/);
  assert.match(common, /verify requesting Agent sender/);
  assert.match(common, /Do not invent envelope IDs to satisfy the form checks/);
  assert.doesNotMatch(updateRoute, /Configuration owner\/lead must match too/);
});

test('Lead replacement instruction guards reject removed authority and recovery boundaries', () => {
  const section = leadSection(updateRoute);
  for (const guard of leadReplacementGuards) {
    const changed = updateRoute.replace(section, section.replace(guard, ''));
    assert.throws(() => assertUpdateGuards(leadSection(changed), leadReplacementGuards), /missing update safeguard/);
  }
});

test('Lead compatibility rules cannot be supplied by another subsection', () => {
  const section = leadSection(updateRoute);
  for (const guard of leadReplacementGuards) {
    const match = section.match(guard);
    assert.ok(match, `missing Lead section guard: ${guard}`);
    const movedOutside = `${updateRoute.replace(section, section.replace(guard, ''))} ${match[0]}`;
    assert.throws(() => assertUpdateGuards(leadSection(movedOutside), leadReplacementGuards), /missing update safeguard/);
  }
});

test('automation delivery respects outcome, partial evidence and timeout fences', () => {
  const delivery = read('../../references/automation-delivery.md');
  for (const rule of ['`failed` closes as `terminated`', 'Historical `accepted` plus `delivery.outcome: "failed"` is still failure',
    'at least one done', 'failed or cancelled', 'at least one durable artifact',
    'A late success cannot overwrite it', 'never resume or replace the terminal parent',
    'A blocked Attempt without pending approval IDs is not an approval request']) {
    assert.ok(delivery.includes(rule), rule);
  }
});
