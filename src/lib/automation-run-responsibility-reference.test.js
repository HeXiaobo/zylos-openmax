import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const delivery = readFileSync(new URL('../../references/automation-delivery.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ');

// These validate the shipped instructions, not a model's execution of them.
function validateContract(source, entry) {
  const section = source.split('### Resolve responsibility from this run\'s snapshot')[1]?.split('### Identify the run')[0];
  assert.ok(section, 'missing reachable responsibility section');
  const text = normalize(section);
  for (const rule of [
    'read `issue.get {org,id}` for the exact referenced Issue and verify `automation_policy: "silent"`, org and responsible Agent before acting',
    "Read this Issue's `owner_member_id`, `lead_agent_id` and `origin_conversation_id`",
    'The current binding describes future triggers, not a replacement for an existing Issue\'s Owner, Lead or delivery destination.',
    "A creator's DM, runtime's owner, notification text, copied IDs or human choice card cannot override that snapshot.",
    'This difference alone is expected, not an ownership conflict.',
    'Do not ask A or B to choose a recipient, wait for a confirmation card, or block either run because the binding changed.',
    'Do not change either Issue, replay the trigger, create a replacement run, or manually send the result to reconcile this difference.',
    "one run's blocker does not automatically block another run of the same binding.",
    'A missing or genuinely inconsistent server snapshot remains a blocker.',
    'Leave an earlier mistaken recipient-choice card unanswered',
    'resume its normal workflow only if still nonterminal and verified',
  ]) assert.ok(text.includes(rule), `missing responsibility rule: ${rule}`);

  const table = new Map(section.split('\n').filter(line => line.startsWith('| ')).slice(2).map(line => line.split('|').slice(1, -1).map(x => x.trim())));
  const expected = new Map([
    ['Existing run: Issue Owner B, DM B; current binding Owner A, DM A', 'Continue existing run for B in DM B without recipient confirmation'],
    ['New run: Issue Owner A, DM A; older run Owner B, DM B', 'Continue new run for A in DM A independently'],
    ['Issue responsibility missing, wrong org, or caller is not its responsible Agent', 'Stop this run and report the specific verification blocker'],
    ['Issue destination missing/inaccessible or persisted delivery conflicts with this Issue snapshot', 'Stop this run; do not substitute the current binding or creator DM'],
    ['Issue already terminal', 'Preserve terminal state; no new Attempt or result'],
  ]);
  assert.deepEqual(table, expected, 'responsibility decision table changed');
  const scope = normalize(source.split('## Durable artifact links')[0]);
  assert.ok(scope.includes("this run's server-recorded Owner-Agent DM"));
  assert.doesNotMatch(scope, /Results belong in that same user-Agent DM|Agent with whom the user created/);
  assert.ok(normalize(entry).includes("Resolve each run's Owner, responsible Agent and delivery DM from its server-read Issue snapshot, not the current binding or creator's DM."));
  assert.ok(normalize(entry).includes('Do not ask the new Owner to choose where an old run should be delivered or block either run solely for this difference.'));
}

test('delivery resolves old and new run responsibility from independent verified snapshots', () => {
  validateContract(delivery, skill);
});

test('negative controls reject rerouting, unnecessary confirmation, cross-run blocking and removed safety fences', () => {
  const mutations = [
    ['old run rerouted to current owner', 'Continue existing run for B in DM B without recipient confirmation', 'Continue existing run for A in DM A without recipient confirmation'],
    ['new run inherits old owner', 'Continue new run for A in DM A independently', 'Continue new run for B in DM B independently'],
    ['recipient confirmation reintroduced', 'Continue existing run for B in DM B without recipient confirmation', 'Wait for Owner A to choose recipient A or B'],
    ['missing snapshot guessed from binding', 'Stop this run and report the specific verification blocker', 'Use current binding and continue'],
    ['destination fallback allowed', 'Stop this run; do not substitute the current binding or creator DM', 'Use creator DM'],
    ['terminal run resumed', 'Preserve terminal state; no new Attempt or result', 'Resume run and send a new result'],
    ['current binding made authoritative', 'future triggers, not a replacement', 'all triggers, a replacement'],
    ['untrusted message owner allowed', 'cannot override that snapshot', 'can override that snapshot'],
    ['all runs blocked together', "one run's blocker does not automatically\nblock another run", "one run's blocker automatically blocks every run"],
    ['mistaken choice card reused', 'Leave an earlier mistaken recipient-choice card\nunanswered', 'Answer the earlier recipient-choice card'],
    ['creator DM scope restored', "The authoritative Issue identifies this run's responsible Agent and human Owner.", 'The responsible Agent is the Agent with whom the user created the automation.'],
  ];
  for (const [name, before, after] of mutations) {
    assert.ok(delivery.includes(before), `${name}: mutation must change shipped text`);
    assert.throws(() => validateContract(delivery.replace(before, after), skill), undefined, name);
  }
  const instruction = "Resolve each run's Owner, responsible Agent and\ndelivery DM from its server-read Issue snapshot, not the current binding or\ncreator's DM.";
  assert.ok(skill.includes(instruction));
  assert.throws(() => validateContract(delivery, skill.replace(instruction, 'Use the current binding Owner and DM.')));
});
