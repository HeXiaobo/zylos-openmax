import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const delivery = read('../../references/automation-delivery.md');
const operations = read('../../references/tm-operations.md');
const skill = read('../../SKILL.md');
const flat = text => text.replace(/\s+/g, ' ');

// Instruction-contract checks, not a model evaluation or backend state simulator.
function validate(source, ops, entry) {
  const gate = source.split('### Issue plan-state gate\n')[1]?.split('Read the actual delivery outcome')[0];
  assert.ok(gate, 'missing Issue plan-state gate');
  assert.match(source, /2\. Establish the accepted plan using the Issue plan-state gate below/);
  const rules = [
    'The response is an Issue, not a Blueprint.',
    '`Blueprint.status` is a separate object lifecycle; it may remain `draft` after successful automatic Issue plan acceptance.',
    "Neither `draft` nor `approved` on a Blueprint alone proves whether this Issue's current plan was accepted.",
    'verify its `issue_id` matches the exact run',
    'Retain the Blueprint ID, `version_number` and the actual step IDs/content/dependencies',
    'Check the successful response and a fresh `issue.get`: both must name that Issue and org, its responsible Agent, `automation_policy: "silent"`, the submitted `current_blueprint_id`, and `status: "in_progress"`.',
    'verify the same Issue, ID, version and step content',
    'Do not wait for Blueprint status to become `approved`',
    'The authoritative Issue itself is the durable acceptance evidence',
    'verify exact Issue/org, `lead_agent_id` is this Agent, `automation_policy: "silent"`, no `archived_at`, `status: "in_progress"`, and nonempty `current_blueprint_id` equal to this Blueprint\'s `id`',
    'A generic `in_progress` Issue without that matching current-plan binding is not acceptance evidence.',
    '`delivered` and `accepted` as already accepted for replay, but neither state permits further execution.',
    "Work writes automatic plan records using the caller Lead's member ID",
    'Do not require a separate server-author identity.',
    'absent `archived_at` means not archived on this verified response contract',
    'absent step `depends_on`/`required_resources` mean empty dependencies/resources',
    'If that snapshot was lost, use `comment.list {workType:"issue",workId:<Issue>}` with pagination',
    'Use its `created_at` as the time baseline, not Issue.updated_at',
    "Compare the Blueprint and each current step's `created_at` and `updated_at` to that baseline; none may be later.",
    'Timestamps are a conservative change check, not an immutable snapshot or proof that no step was deleted',
    'you may call `issue.submit_plan` once with the SAME Issue and current Blueprint',
    'This is optional: the verified Issue binding already proves acceptance.',
    'do not repeat this call blindly after an error, use another Blueprint, or use replay to reset the step time baseline.',
    'Do not mutate an accepted Blueprint: no `blueprint.set_steps`, step add/update/ delete, dependency/resource changes or other plan edits after acceptance',
    'An intentional replan requires a new Blueprint and the normal submit/accept workflow while the Issue remains executable',
    'Do not call `issue.accept_plan`, edit Blueprint status, or bypass an endpoint error to force progress.',
  ];
  for (const rule of rules) assert.ok(flat(gate).includes(rule), `missing plan gate: ${rule}`);
  const rows = new Map(gate.split('\n').filter(line => line.startsWith('| ')).slice(2).map(line => line.split('|').slice(1, -1).map(x => x.trim())));
  assert.deepEqual(rows, new Map([
    ['Silent Issue has matching accepted current Blueprint, in_progress, no archive; recovered step checks pass; Blueprint still draft', 'Continue or resume Tasks and Attempts for that accepted plan'],
    ['Issue in_progress but current Blueprint is missing or mismatched', 'Reconcile the plan; do not execute or infer acceptance'],
    ['Current Blueprint ID, Issue, version or step content differs from the submitted/accepted plan', 'Stop and reconcile the changed plan before execution'],
    ['Issue remains pending_plan, or ordinary human acceptance is required', 'Wait for the real acceptance workflow; never proxy acceptance'],
    ['External-action approval is pending', 'Keep that action blocked until its actual approval'],
    ['Issue is terminal or archived', 'Stop; do not create Tasks, Attempts or a new result'],
  ]), 'plan decision table changed');
  assert.ok(flat(ops).includes('Ordinary plans enter pending_plan; server-trusted silent automation plans are automatically accepted and return in_progress with current_blueprint_id.'));
  assert.ok(flat(ops).includes('Blueprint draft is not an approval gate'));
  assert.ok(flat(entry).includes("Never call `accept_plan` or `accept_delivered` on the human's behalf to emulate automation."));

  // Catch representative additive contradictions too; this is not an exhaustive
  // natural-language contradiction detector. Negated safeguards above stay valid.
  for (const text of [source, ops, entry]) {
    assert.doesNotMatch(text, /(?:^|\n|[.!?]\s+)(?:Always\s+)?[Ww]ait for (?:the )?Blueprint(?:\.status| status)? to (?:become|be) [`"']?approved/i, 'added Blueprint approval wait');
    assert.doesNotMatch(text, /(?:^|\n|[.!?]\s+)[Ee]xecute (?:the )?(?:plan|Tasks|tasks) (?:whenever|if|when) (?:the )?Issue(?:\.status| status)? is [`"']?in_progress[`"']? alone/i, 'added unconditional execution');
    assert.doesNotMatch(text, /(?:^|\n|[.!?]\s+)[Cc]all [`"']?issue\.accept_plan[`"']? to (?:force|unblock) (?:silent|automation) (?:plans|execution)/i, 'added proxy acceptance');
    assert.doesNotMatch(text, /(?:^|\n|[.!?]\s+)(?:A )?[Dd]raft Blueprint (?:means|is) (?:an? )?unaccepted plan/i, 'draft used as acceptance status');
    assert.doesNotMatch(text, /(?:^|\n|[.!?]\s+)[Rr]esume (?:Tasks|execution) (?:for|on) (?:delivered|accepted) Issues/i, 'terminal replay confused with execution');
  }
}

test('silent plan execution uses exact accepted Issue plan binding, not Blueprint object status', () => {
  validate(delivery, operations, skill);
});

test('plan gate rejects removed checks and inverted execution decisions', () => {
  const mutations = [
    ['Continue or resume Tasks and Attempts for that accepted plan', 'Wait until Blueprint status becomes approved'],
    ['Reconcile the plan; do not execute or infer acceptance', 'Continue from in_progress alone'],
    ['Stop and reconcile the changed plan before execution', 'Execute the old plan despite changed version'],
    ['Wait for the real acceptance workflow; never proxy acceptance', 'Call accept_plan as the human'],
    ['Keep that action blocked until its actual approval', 'Execute without external-action approval'],
    ['Stop; do not create Tasks, Attempts or a new result', 'Create a new Attempt on the terminal Issue'],
    ['the submitted\n`current_blueprint_id`', 'any current_blueprint_id'],
    ['verify the same Issue, ID, version and step content', 'verify the ID only'],
    ['Do not require a separate server-author identity.', 'Require a distinct system author.'],
    ['none may be later', 'later edits are allowed'],
    ['you may call\n`issue.submit_plan` once with the SAME Issue and current Blueprint', 'never replay submit_plan'],
    ['Do not mutate an accepted Blueprint', 'Mutate accepted draft Blueprints freely'],
  ];
  for (const [before, after] of mutations) {
    assert.ok(delivery.includes(before), `mutation absent: ${before}`);
    assert.throws(() => validate(delivery.replace(before, after), operations, skill));
  }
});

test('representative added contradictory instructions fail even when original safeguards remain', () => {
  for (const addition of [
    'Always wait for Blueprint.status to become approved.',
    'Execute Tasks when Issue.status is in_progress alone.',
    'Call issue.accept_plan to force silent plans.',
    'Draft Blueprint means an unaccepted plan.',
    'Resume Tasks on accepted Issues.',
  ]) {
    assert.throws(() => validate(`${delivery}\n\n${addition}`, operations, skill));
    assert.throws(() => validate(delivery, `${operations}\n\n${addition}`, skill));
    assert.throws(() => validate(delivery, operations, `${skill}\n\n${addition}`));
  }
});
