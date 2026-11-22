import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatInboundForC4 } from './message.js';

// Shipped instructions are the contract here: no code decides whether an
// inbound request gets the Issue-intake card — the Agent does, from the
// Trigger in SKILL.md and the inbound <openmax-instruction>. These guards
// protect that wording; they do not simulate an Agent.

const rawSkill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const flat = s => s.replace(/\s+/g, ' ');
const skill = flat(rawSkill);

function boundedSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing instruction section: ${start}`);
  return source.slice(from, to);
}

const trigger = boundedSection(skill, '**Trigger (do this for every message)**', '### New-Issue Intake');
const triggerRaw = boundedSection(rawSkill, '**Trigger (do this for every message)**', '### New-Issue Intake');
const intake = boundedSection(skill, '### New-Issue Intake', '### Simple Task Flow');
const cardRule = boundedSection(skill,
  'is what I need back one of a few fixed options?',
  '🔴 **Never merge a text answer with an unrelated card.**');
const frontmatter = flat(rawSkill.split('\n---')[0]);

function bullet(section, label) {
  const start = section.indexOf(`- **${label}**`);
  assert.ok(start >= 0, `Trigger has no "${label}" bullet`);
  const next = section.indexOf(' - **', start + 1);
  return section.slice(start, next > start ? next : undefined);
}

// Rows of the classification example table: `| 「…」 | Kind | What to do |`.
function exampleRows(kind) {
  return triggerRaw.split('\n')
    .filter(line => line.startsWith('| 「'))
    .map(line => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(([, k]) => k === kind)
    .map(([said]) => said);
}

test('Trigger sorts by collaboration and time span into chat, quick, tracked and unsure', () => {
  assert.ok(trigger.includes('collaboration and time span, not the type of output'));
  for (const label of ['Chat / Q&A', 'Quick single-Agent work', 'Cross-team or cross-time work', 'Unsure which']) {
    bullet(trigger, label);
  }
  assert.ok(trigger.includes('An explicit "create an Issue" / "do not create an Issue" from the human always wins'));
});

test('quick single-Agent work is done directly, with no time limit and no intake card', () => {
  const quick = bullet(trigger, 'Quick single-Agent work');
  for (const phrase of [
    '**no intake card**',
    'without waiting on anyone',
    'short report',
    'a small code fix together with its PR (reviewed within your own team)',
    'no time limit',
  ]) {
    assert.ok(quick.includes(phrase), `Quick bullet lost: ${phrase}`);
  }
});

test('quick work ends with at most one plain-text tracking offer, never a card', () => {
  const quick = bullet(trigger, 'Quick single-Agent work');
  assert.ok(quick.includes('**at most one plain-text line**'));
  assert.ok(quick.includes('never a card'));
  assert.ok(quick.includes('「需要的话我建 Issue 跟踪」'));
});

test('cross-team or cross-time work keeps New-Issue Intake, including a PR another team must review', () => {
  const tracked = bullet(trigger, 'Cross-team or cross-time work');
  for (const phrase of [
    'New-Issue Intake',
    'several people, or several Agents',
    'spans time',
    'Any one signal is enough:',
    'Ordinary same-team code review of a PR you open is not "later acceptance"; the PR is its own record.',
    'A PR that needs review by another team is cross-team work.',
  ]) {
    assert.ok(tracked.includes(phrase), `tracked bullet lost: ${phrase}`);
  }
  assert.ok(trigger.includes('**Cross-team or cross-time work that does not reference an existing Issue** → run the new-Issue intake'));
});

test('unsure requests do the doable part first, then make the same one-line offer', () => {
  const unsure = bullet(trigger, 'Unsure which');
  assert.ok(unsure.includes('do the part you can finish now first'));
  assert.ok(unsure.includes('the same one-line offer'));
  assert.ok(unsure.includes('Do not block on the intake card first'));
  assert.ok(trigger.includes('Uncertain classification follows "Unsure which" above.'));
  assert.ok(!trigger.includes('(task classification,'), 'uncertain classification must not route to "consult the user first"');
  assert.ok(unsure.includes('A request is unsure only when it shows no collaboration or time-span signal; any one signal (e.g. 「周五给我」) makes it cross-team or cross-time work, never unsure.'));
});

test('the example table covers at least 3 quick and 3 tracked requests', () => {
  const quick = exampleRows('Quick');
  const tracked = exampleRows('Tracked');
  assert.ok(quick.length >= 3 && tracked.length >= 3, `quick=${quick.length} tracked=${tracked.length}`);
  for (const said of ['阅读一下这个开发文档', '总结一下这段', '这个功能怎么用', '帮我写一份竞品调研」', '把这个 bug 修了提个 PR」']) {
    assert.ok(quick.some(row => row.includes(said)), `no quick example: ${said}`);
  }
  for (const said of ['帮我做一份竞品调研报告，周五给我', '这个需求拆给几个 Agent 一起做', '整理一份接入方案，下周评审', '要 X 团队 review']) {
    assert.ok(tracked.some(row => row.includes(said)), `no tracked example: ${said}`);
  }
  assert.ok(exampleRows('Unsure').some(row => row.includes('帮我把这个模块重构一下')));
});

const EXEMPTION = '**One exception, bound to one situation only:** after you have handed back, in this reply, finished quick ' +
  'single-Agent work — or the part of an unsure request you could finish now — (see the Trigger in "Task ' +
  'Classification and Execution Flow"), the single closing line offering to track it as an Issue ' +
  '(「需要的话我建 Issue 跟踪」) is plain text, not a card. Write it as an offer, not as a 「要不要建 Issue?」 ' +
  'question, and list no options. Nothing else is exempt: any other question, and any question asked before ' +
  'the work is done or handed back, still follows the test above.';

function exemptionParagraph() {
  const from = rawSkill.indexOf('**One exception, bound to one situation only:**');
  assert.ok(from >= 0, 'exemption paragraph missing');
  const to = rawSkill.indexOf('\n\n', from);
  return flat(rawSkill.slice(from, to)).trim();
}

test('🔴 card rule carries the tracking-offer exemption, bound to handed-back quick work only', () => {
  assert.ok(cardRule.includes('**One exception, bound to one situation only:**'), 'exemption must live inside the 🔴 card rule');
  const exemption = exemptionParagraph();
  for (const phrase of [
    'after you have handed back, in this reply, finished quick single-Agent work',
    'the part of an unsure request you could finish now',
    'the single closing line offering to track it as an Issue',
    '(「需要的话我建 Issue 跟踪」) is plain text, not a card',
    'Write it as an offer, not as a 「要不要建 Issue?」 question, and list no options',
    'any question asked before the work is done or handed back, still follows the test above',
    'Nothing else is exempt: any other question',
  ]) {
    assert.ok(exemption.includes(phrase), `exemption lost: ${phrase}`);
  }
  assert.equal(exemption.split('Nothing else is exempt').length, 2, 'exactly one "Nothing else is exempt"');
  assert.ok(exemption.endsWith('still follows the test above.'), 'nothing may follow the closing sentence');
  assert.equal(exemption, EXEMPTION, 'exemption scope changed: widen or narrow it only deliberately');
});

test('🔴 card rule itself is unchanged by the exemption', () => {
  assert.ok(cardRule.includes('`要不要 Z?`'));
  assert.ok(cardRule.includes('a defect here'));
  assert.ok(cardRule.indexOf('`要不要 Z?`') < cardRule.indexOf('**One exception'));
});

test('"A card asks only about its content" matches the 🔴 exemption', () => {
  const rule = boundedSection(skill, '**A card asks only about its content.**', '**Do not write `required`.**');
  assert.ok(rule.includes('after the work is done and handed back'));
  assert.ok(rule.includes('for an unsure request, after the part you could finish now is handed back'));
  assert.ok(rule.includes('never a card'));
  assert.ok(rule.includes('see the exception under 🔴 "Replying"'));
});

test('old "every output is a task / ask even when simple" wording is gone', () => {
  assert.ok(!skill.includes('is a task even when the output is short'));
  assert.ok(!skill.includes('simple enough to finish in the conversation'));
  assert.ok(!skill.includes('Is a task and does not reference an existing Issue'));
  assert.ok(intake.includes('ordinary wording, not an Issue decision'));
  assert.ok(intake.includes('"直接做"'), '"直接做" is listed as ordinary wording, not special-cased');
  assert.ok(intake.includes('Applies only to new **cross-team or cross-time work**'));
});

test('explicit decisions and the no-repeat rule are unchanged', () => {
  assert.ok(intake.includes('**Do not ask twice.**'));
  for (const row of [
    '| Create an Issue | Yes | Nothing; proceed with the confirmed Project |',
    '| Do not create an Issue | Irrelevant | Nothing; do not create an Issue or any other Work object |',
    '| Not stated | No | In one intake turn, ask whether to create an Issue and recommend a Project for confirmation |',
  ]) {
    assert.ok(intake.includes(row), `intake table lost: ${row}`);
  }
  assert.ok(intake.includes('**The intake is its own card.**'));
});

test('frontmatter description no longer sends every new task through intake', () => {
  assert.ok(frontmatter.includes('finish quickly'));
  assert.ok(frontmatter.includes('do it directly, no Issue card'));
  assert.ok(frontmatter.includes('or when the human asks to track it, resolve the missing Issue-creation'));
  assert.ok(frontmatter.includes('do not skip that flow for tracked work.'));
  assert.ok(!frontmatter.includes('do not skip the flow and just start working'));
  assert.ok(frontmatter.includes('spans time'));
  assert.ok(!frontmatter.includes('if it is a new task, resolve'));
  assert.ok(frontmatter.includes('before generic Issue intake'), 'automation handoffs still route first');
});

test('Simple Task Flow is introduced as Issue-backed work, not every research report', () => {
  const heading = rawSkill.split('\n').find(line => line.startsWith('### Simple Task Flow'));
  assert.ok(heading);
  assert.ok(!heading.endsWith('e.g. research report)'));
  assert.ok(heading.includes('Issue-backed'));
});

test('inbound instruction classifies before intake, after the automation routes', () => {
  const out = formatInboundForC4({ type: 'dm', id: 'cv-1' }, { displayName: 'Alice' }, { content: '阅读一下这个开发文档' }, [], {});
  const instruction = boundedSection(out, '<openmax-instruction>', '</openmax-instruction>');
  for (const phrase of ['finish quickly', 'spans time', 'New-Issue Intake']) {
    assert.ok(instruction.includes(phrase), `instruction lost: ${phrase}`);
  }
  assert.ok(!instruction.includes('For other new tasks, complete New-Issue Intake'));
  const classify = instruction.indexOf('Otherwise classify the message per the skill');
  assert.ok(classify > instruction.indexOf('Automation Update workflow before generic Issue intake'));
  assert.ok(classify > instruction.indexOf('Automation Creation workflow before generic Issue intake'));
});

test('automation handoffs still route before generic Issue intake', () => {
  assert.ok(skill.includes('[Automation Update](references/automation-update.md) before generic Issue intake'));
});

test('no blanket "every task goes through intake" wording anywhere', () => {
  assert.ok(!/every new task/i.test(skill), 'no "every new task …" rule');
  assert.ok(!/always (run|send|ask)[^.]*intake/i.test(skill), 'no "always run the intake" rule');
  assert.ok(!/\bin doubt\b[^.]*intake/i.test(skill), 'doubt goes to "Unsure which", not to the intake card');
  assert.ok(!/(two|both|several) signals/i.test(trigger), 'one signal is enough');
  assert.ok(!skill.includes('new task first registers an Issue'));
  assert.ok(!skill.includes('recognizes it as a work goal (not a simple Q&A)'));
});

test('New-Issue Intake states exactly when it applies', () => {
  const scope = flat(boundedSection(rawSkill, 'Applies only to new **cross-team', '\n\n')).trim();
  assert.equal(scope, 'Applies only to new **cross-team or cross-time work**, or when the human asks to track something (see the Trigger above). Quick single-Agent work skips it.');
});

test('references and Complex Task Flow use the Trigger, not the old task/intake split', () => {
  const refs = boundedSection(skill, '### Work Object References', '**Trigger (do this for every message)**');
  assert.ok(refs.includes('advance along the existing lifecycle; do not run New-Issue Intake for it.'));
  assert.ok(refs.includes('classify the rest of the message by the Trigger below; if it runs New-Issue Intake, the Project is already explicit'));
  assert.ok(refs.includes('(「proj://X 总结一下进度」 is quick work: answer it, no card.)'));
  const complex = boundedSection(skill, '### Complex Task Flow', '2. **Resolve new-Issue intake');
  assert.ok(complex.includes('recognizes it as cross-team or multi-Agent work (not chat or quick single-Agent work)'));
});

test('Common Mistakes, Guardrail #1 and the Onboarding exception still carry the quick-work rule', () => {
  for (const row of [
    '| Sending the Issue intake card for work one Agent can finish quickly in the conversation (read a doc, summarize, answer, look up, small edit, a short report, a small fix with its same-team-reviewed PR) | Do it directly; at most one plain-text line offering to track it |',
    '| Treating cross-team or cross-time work as quick because the first step is easy | Any collaboration or time-span signal (other teams / people / Agents, a PR another team must review, future deadline, several days, later acceptance) sends it through intake |',
  ]) {
    assert.ok(skill.includes(row), `Common Mistakes lost: ${row}`);
  }
  assert.ok(skill.includes('(Quick single-Agent work never reaches this step; see the Trigger in "Task Classification and Execution Flow".)'));
  assert.ok(skill.includes("- **Exception — Onboarding**: the owner's first task in the onboarding DM is executed directly in the conversation without this intake, unless they explicitly ask for an Issue."));
});

test('inbound instruction covers explicit tracking requests and the unsure path', () => {
  const out = formatInboundForC4({ type: 'dm', id: 'cv-1' }, { displayName: 'Alice' }, { content: 'hi' }, [], {});
  const instruction = flat(boundedSection(out, '<openmax-instruction>', '</openmax-instruction>'));
  assert.ok(instruction.includes('or that the human asks to track;'));
  assert.ok(instruction.includes('if unsure, do the part you can finish now, then offer in one plain-text line to track the rest.'));
});
