import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const docs = {
  common: read('../../references/automation-common.md'),
  creation: read('../../references/automation-creation.md'),
  update: read('../../references/automation-update.md'),
  tm: read('../../references/tm-operations.md'),
};

// These check written guardrails, not whether a model follows them.
const required = {
  common: [
    /\| Both \| `lead_member_id`, `owner_member_id`, optional `result_notification_policy`, optional `project_member_additions`, `spec`/,
    /only this configuration's `lead_member_id` and\/or `owner_member_id`, each at most once, at most two entries/,
    /Pass the handoff's list verbatim in the proposal configuration and the mutation configuration; never add, drop or reorder entries, build a list yourself, or copy one from a baseline, directory read or rejection/,
    /Omitted or empty means nobody joins and the existing membership rules apply unchanged/,
    /joins the project when the confirmed create or update succeeds, in the same server transaction; a failed write adds nobody and writes nothing/,
    /Their current non-membership is therefore not missing access and not a blocker for actionability, proposal or confirmation/,
    /Never add members yourself \(for example with `project\.member_add`\)/,
    /The confirming human needs project write access \(an effective project member or org owner\/admin\)/,
    /When the list is non-empty, the server's readable card must name who joins the project/,
    /never strip the list, retry without it or add members to make a rejection pass/,
    /binding reads do not return it, so compare the other confirmed fields on readback/,
    /report the actual returned state; never assume it resumed/,
  ],
  creation: [
    /listed in `configuration\.project_member_additions` joins the project when the confirmed write succeeds, so their current non-membership is not missing access and not a blocker/,
    /Do not add members yourself; pass the confirmed list verbatim/,
    /The creator must be an active human in the same organization and a member of the selected project/,
    /A creator listed as Owner in `configuration\.project_member_additions` joins the project with the write instead of already being a member/,
    /Any non-empty list also requires the creator to have project write access/,
    /A target Owner listed in `project_member_additions` joins the project when the confirmed write succeeds instead of already being a member; chat access with the Lead is still required/,
  ],
  update: [
    /it is a write-time list, not a stored field, so carry only the handoff's list verbatim and never derive one from the baseline binding/,
    /never grant membership, reset the target to the requester, or impersonate them/,
    /A target Owner listed in the handoff's `configuration\.project_member_additions` joins the project when the confirmed update succeeds; their current non-membership is not a blocker/,
    /you must not add one that the handoff did not carry/,
    /lists B, a completed traversal without B is expected and not a blocker: B joins the project when the confirmed update succeeds\. Otherwise B must already be a member/,
    /A direct chat request carries no such list; never create one/,
  ],
  tm: [/Both forward an optional confirmed `project_member_additions` \(only the configuration's Lead and\/or Owner, each once\) as the top-level body field/],
};
const forbidden = [
  /Add the Lead to the project with `project\.member_add`/,
  /Drop `project_member_additions` and retry/,
  /Add any project member to `project_member_additions`/,
];

function verify(texts) {
  for (const [name, patterns] of Object.entries(required)) {
    for (const pattern of patterns) assert.match(texts[name], pattern, `${name}: ${pattern}`);
  }
  for (const text of Object.values(texts)) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern);
  }
}

test('member addition instructions keep the confirmed list verbatim and membership server-side', () => {
  verify(docs);
});

test('member addition instructions reject removed guardrails and contradictions', () => {
  for (const [name, before, after] of [
    ['common', 'never add, drop or reorder entries', 'you may adjust entries'],
    ['common', 'Never add members yourself', 'You may add members yourself'],
    ['common', 'the server\'s readable card must name who joins the project', 'the server card may omit who joins'],
    ['common', 'never strip the list, retry without it', 'strip the list and retry'],
    ['creation', 'is not missing access and not a blocker', 'is missing access and a blocker'],
    ['update', 'never derive one from the baseline binding', 'copy it from the baseline binding'],
    ['update', 'A direct chat request carries no such list; never create one.', 'A direct chat request may add B to the list.'],
  ]) {
    assert.ok(docs[name].includes(before), `${name} contains: ${before}`);
    assert.throws(() => verify({ ...docs, [name]: docs[name].replace(before, after) }), `${name}: ${before}`);
  }
  for (const addition of ['Add the Lead to the project with `project.member_add` first.',
    'Drop `project_member_additions` and retry.', 'Add any project member to `project_member_additions`.']) {
    for (const name of Object.keys(docs)) {
      assert.throws(() => verify({ ...docs, [name]: `${docs[name]} ${addition}` }), `${name}: ${addition}`);
    }
  }
});
