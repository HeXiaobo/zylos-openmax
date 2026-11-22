import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  askedOfList,
  claimGroupReminder,
  clearPendingGroup,
  decodeFormAnswer,
  findPendingQuestion,
  formGroupStatus,
  isAnswerAuthorized,
  listPendingQuestions,
  PENDING_QUESTION_TTL_MS,
  recordFormOutcome,
  recordPendingQuestion,
  sameFormAnswers,
} from './pending-question.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pqf-')), 'pending-questions.json');
}

const ASKED = '2026-10-15T00:00:00Z';
const NOW = Date.parse(ASKED) + 60_000;

const formRecord = (over = {}) => ({
  kind: 'sdlc.requirement_intake',
  interactionType: 'form',
  cardMessageId: '9001',
  conversationId: 'grp-1',
  askedOf: ['m-kevin', 'm-jessie'],
  askedAt: ASKED,
  fields: { audience: ['opt_1', 'opt_2', 'opt_3'], cc: ['opt_4', 'opt_5'] },
  questions: {
    audience: { label: '谁来用？', required: true, optionKeys: ['internal', '', 'both'], optionLabels: ['内部员工', '外部客户', '两者都有'] },
    cc: { label: '抄送谁？', required: false, optionKeys: ['', ''], optionLabels: ['产品', '设计'] },
  },
  ...over,
});

// --------------------------------------------------------------- askedOf

test('a record written before forms (askedOf a string) still authorizes exactly that member', () => {
  const legacy = { askedOf: 'owner-1' };
  assert.equal(isAnswerAuthorized(legacy, 'owner-1'), true);
  assert.equal(isAnswerAuthorized(legacy, 'owner-2'), false);
  assert.deepEqual(askedOfList(legacy), ['owner-1']);
});

test('askedOf as a list authorizes any member on it, and no one else', () => {
  const r = formRecord();
  assert.equal(isAnswerAuthorized(r, 'm-kevin'), true);
  assert.equal(isAnswerAuthorized(r, 'm-jessie'), true);
  assert.equal(isAnswerAuthorized(r, 'm-ann'), false);
});

test('missing either side is still a refusal', () => {
  assert.equal(isAnswerAuthorized(formRecord(), ''), false);
  assert.equal(isAnswerAuthorized(formRecord(), undefined), false);
  assert.equal(isAnswerAuthorized({ askedOf: [] }, 'm-kevin'), false);
  assert.equal(isAnswerAuthorized({}, 'm-kevin'), false);
});

// ---------------------------------------------------------------- record

test('a form record is kept per card with its per-question option ids', () => {
  const file = tmpFile();
  recordPendingQuestion(formRecord(), { file });
  const found = findPendingQuestion('9001', { file });
  assert.deepEqual(found.fields.cc, ['opt_4', 'opt_5']);
  assert.deepEqual(found.askedOf, ['m-kevin', 'm-jessie']);
});

test('a form record without fields is refused — its answer could not be decoded', () => {
  const file = tmpFile();
  assert.throws(() => recordPendingQuestion(formRecord({ fields: {} }), { file }), /fields/);
  assert.throws(() => recordPendingQuestion(formRecord({ fields: { a: [] } }), { file }), /fields/);
  assert.deepEqual(listPendingQuestions({ file }), []);
});

// ---------------------------------------------------------------- decode

test('selected ids are read back per question; an unanswered optional question says so', () => {
  const d = decodeFormAnswer(formRecord(), ['opt_1']);
  assert.equal(d.answered, 1);
  assert.equal(d.total, 2);
  assert.deepEqual(d.unknownIds, []);
  assert.deepEqual(d.unknownKeys, []);
  assert.deepEqual(d.answers.audience, {
    type: 'choice', status: 'answered', optionIndexes: [0], optionKeys: ['internal'], labels: ['内部员工'], otherSelected: false, otherText: null,
  });
  assert.deepEqual(d.answers.cc, {
    type: 'choice', status: 'unanswered', optionIndexes: [], optionKeys: [], labels: [], otherSelected: false, otherText: null,
  });
});

// v1.6 §1: a question counts as answered with an option, or with non-blank
// "other" text. One row per line of that table.
test('"other" is read per question: only an option or non-blank other text counts as answered (v1.6 §1)', () => {
  const pick = (d, k) => [d.answers[k].status, d.answers[k].otherSelected, d.answers[k].otherText];

  // other with text only
  let d = decodeFormAnswer(formRecord(), [], { otherSelected: ['cc'], otherText: { cc: '  运营  ' } });
  assert.deepEqual(pick(d, 'cc'), ['answered', true, '运营']);
  assert.equal(d.answered, 1);

  // other ticked, nothing typed (whitespace is nothing)
  d = decodeFormAnswer(formRecord(), [], { otherSelected: ['cc'], otherText: { cc: '   ' } });
  assert.deepEqual(pick(d, 'cc'), ['unanswered', true, null]);
  assert.equal(d.answered, 0);

  // an option plus a blank other
  d = decodeFormAnswer(formRecord(), ['opt_1'], { otherSelected: ['audience'] });
  assert.deepEqual(pick(d, 'audience'), ['answered', true, null]);
  assert.deepEqual(d.answers.audience.optionIndexes, [0]);

  // nothing at all
  d = decodeFormAnswer(formRecord(), []);
  assert.deepEqual(pick(d, 'cc'), ['unanswered', false, null]);
});

test('other text alone marks other as selected, even when otherSelected left it out', () => {
  const d = decodeFormAnswer(formRecord(), [], { otherText: { audience: '合作方' } });
  assert.equal(d.answers.audience.otherSelected, true);
  assert.equal(d.answers.audience.status, 'answered');
});

test('an "other" key on no question is reported, not dropped', () => {
  const d = decodeFormAnswer(formRecord(), [], { otherSelected: ['audiance'], otherText: { scope: 'x' } });
  assert.deepEqual(d.unknownKeys, ['audiance', 'scope']);
  assert.equal(d.answered, 0);
});

test('option keys stay aligned with the ids: an option without a key reads as an empty string', () => {
  const d = decodeFormAnswer(formRecord(), ['opt_2', 'opt_5']);
  assert.deepEqual(d.answers.audience.optionKeys, ['']);
  assert.deepEqual(d.answers.audience.labels, ['外部客户']);
  assert.deepEqual(d.answers.cc.optionIndexes, [1]);
});

test('an id on no question is reported, not dropped', () => {
  const d = decodeFormAnswer(formRecord(), ['opt_1', 'opt_99']);
  assert.deepEqual(d.unknownIds, ['opt_99']);
});

// ---------------------------------------------------------------- fill-in

const textRecord = (over = {}) => formRecord({
  fields: { scope: ['opt_1', 'opt_2'] },
  questions: {
    name: { label: '你的名字', type: 'text', required: false, multiline: false },
    scope: { label: '做多大？', required: false, optionKeys: ['', ''], optionLabels: ['MVP', '完整一期'] },
    notes: { label: '补充', type: 'text', required: false, multiline: true },
  },
  ...over,
});

test('text answers are read per question in card order: non-blank text answers, blank does not', () => {
  const d = decodeFormAnswer(textRecord(), [], { text: { name: '  王小明 ', notes: '   ' } });
  assert.deepEqual(Object.keys(d.answers), ['name', 'scope', 'notes']);
  assert.deepEqual(d.answers.name, { type: 'text', status: 'answered', text: '王小明' });
  assert.deepEqual(d.answers.notes, { type: 'text', status: 'unanswered', text: null });
  assert.equal(d.answers.scope.type, 'choice');
  assert.equal(d.answered, 1);
  assert.equal(d.total, 3);
  assert.deepEqual(d.unknownKeys, []);
});

test('multi-line text is kept as typed, apart from the outer whitespace', () => {
  const d = decodeFormAnswer(textRecord(), [], { text: { notes: '第一版只要订单。\n回款按客户分组。\n' } });
  assert.equal(d.answers.notes.text, '第一版只要订单。\n回款按客户分组。');
});

test('typed text on a choice question, or "other" on a text question, is a key this side cannot place', () => {
  const d = decodeFormAnswer(textRecord(), [], { text: { scope: 'x', ghost: 'y' }, otherSelected: ['name'], otherText: { notes: 'z' } });
  assert.deepEqual(d.unknownKeys.sort(), ['ghost', 'name', 'notes', 'scope']);
  assert.equal(d.answered, 0);
});

test('a pending form of text questions only is recorded; one with neither option ids nor text questions is refused', () => {
  const file = tmpFile();
  recordPendingQuestion(textRecord({ fields: {}, questions: { name: { label: 'L', type: 'text' } } }), { file });
  assert.equal(findPendingQuestion('9001', { file }).questions.name.type, 'text');
  assert.throws(() => recordPendingQuestion(formRecord({ fields: {}, questions: { a: { label: 'L' } } }), { file }), /choice questions, or text questions/);
});

// ----------------------------------------------------------------- group

function seedGroup(file, { total = 2, askedAt = ASKED } = {}) {
  for (let i = 1; i <= total; i += 1) {
    recordPendingQuestion(formRecord({
      cardMessageId: `g${i}`, askedAt, group: { id: 'sdlc-1024', index: i, total },
    }), { file });
  }
}

const answeredOutcome = { actionable: true, reason: 'ok', answers: {} };

test('T-13: only the first card answered — the group is not complete and nothing needs re-asking', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', answeredOutcome, { file });
  const s = formGroupStatus('grp-1', 'sdlc-1024', NOW, { file });
  assert.equal(s.complete, false);
  assert.deepEqual(s.answered, [1]);
  assert.deepEqual(s.waiting, [2]);
  assert.deepEqual(s.needsReask, []);
});

test('both cards answered — complete', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', answeredOutcome, { file });
  recordFormOutcome('g2', answeredOutcome, { file });
  assert.equal(formGroupStatus('grp-1', 'sdlc-1024', NOW, { file }).complete, true);
});

test('T-14: a card that expired unanswered makes the group incomplete and is listed for a re-ask', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', answeredOutcome, { file });
  const later = Date.parse(ASKED) + PENDING_QUESTION_TTL_MS + 1;
  const s = formGroupStatus('grp-1', 'sdlc-1024', later, { file });
  assert.equal(s.complete, false);
  assert.deepEqual(s.expired, [2]);
  assert.deepEqual(s.needsReask, [2]);
});

test('a card settled by someone not asked is dead, and is listed for a re-ask', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g2', { actionable: false, reason: 'not asked' }, { file });
  assert.deepEqual(formGroupStatus('grp-1', 'sdlc-1024', NOW, { file }).needsReask, [2]);
});

test('re-asking a missing card under the same group id and index replaces the dead one', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', answeredOutcome, { file });
  recordFormOutcome('g2', { actionable: false, reason: 'expired' }, { file });
  recordPendingQuestion(formRecord({ cardMessageId: 'g2b', group: { id: 'sdlc-1024', index: 2, total: 2 } }), { file });
  recordFormOutcome('g2b', answeredOutcome, { file });
  const s = formGroupStatus('grp-1', 'sdlc-1024', NOW, { file });
  assert.equal(s.complete, true);
  assert.deepEqual(s.needsReask, []);
});

test('a group is scoped to its conversation: the same id elsewhere is another group', () => {
  const file = tmpFile();
  seedGroup(file);
  assert.equal(formGroupStatus('grp-other', 'sdlc-1024', NOW, { file }), null);
});

test('a card of the group that was never recorded keeps it incomplete', () => {
  const file = tmpFile();
  recordPendingQuestion(formRecord({ cardMessageId: 'g1', group: { id: 'sdlc-1024', index: 1, total: 2 } }), { file });
  recordFormOutcome('g1', answeredOutcome, { file });
  const s = formGroupStatus('grp-1', 'sdlc-1024', NOW, { file });
  assert.equal(s.complete, false);
  assert.deepEqual(s.notRecorded, [2]);
});

test('the reminder can be claimed once per group', () => {
  const file = tmpFile();
  seedGroup(file);
  assert.equal(claimGroupReminder('grp-1', 'sdlc-1024', ASKED, { file }), true);
  assert.equal(claimGroupReminder('grp-1', 'sdlc-1024', ASKED, { file }), false);
  assert.equal(formGroupStatus('grp-1', 'sdlc-1024', NOW, { file }).reminded, true);
});

test('clearing a group drops every card of it and nothing else', () => {
  const file = tmpFile();
  seedGroup(file);
  recordPendingQuestion(formRecord({ cardMessageId: 'solo' }), { file });
  assert.equal(clearPendingGroup('grp-1', 'sdlc-1024', { file }), 2);
  assert.deepEqual(listPendingQuestions({ file }).map((r) => r.cardMessageId), ['solo']);
});

test('E2: a group card whose record is gone is listed for a re-ask, so the group does not wait forever', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', answeredOutcome, { file });
  const records = listPendingQuestions({ file }).filter((r) => r.cardMessageId !== 'g2');
  const s = formGroupStatus('grp-1', 'sdlc-1024', NOW, { records });
  assert.equal(s.complete, false);
  assert.deepEqual(s.notRecorded, [2]);
  assert.deepEqual(s.needsReask, [2]);
});

test('E3: total=3 with only two cards sent — the missing index is a re-ask, not a wait', () => {
  const file = tmpFile();
  for (const i of [1, 2]) {
    recordPendingQuestion(formRecord({ cardMessageId: `t${i}`, group: { id: 'g3', index: i, total: 3 } }), { file });
    recordFormOutcome(`t${i}`, answeredOutcome, { file });
  }
  const s = formGroupStatus('grp-1', 'g3', NOW, { file });
  assert.equal(s.complete, false);
  assert.deepEqual(s.waiting, []);
  assert.deepEqual(s.needsReask, [3]);
});

test('a complete group carries every card\'s answers in card order, newest record per index', () => {
  const file = tmpFile();
  seedGroup(file);
  recordFormOutcome('g1', { ...answeredOutcome, answers: { a: 1 } }, { file });
  recordFormOutcome('g2', { actionable: false, reason: 'expired' }, { file });
  recordPendingQuestion(formRecord({ cardMessageId: 'g2b', group: { id: 'sdlc-1024', index: 2, total: 2 } }), { file });
  recordFormOutcome('g2b', { ...answeredOutcome, answers: { b: 2 } }, { file });
  assert.deepEqual(formGroupStatus('grp-1', 'sdlc-1024', NOW, { file }).answers, [
    { index: 1, cardMessageId: 'g1', answers: { a: 1 } },
    { index: 2, cardMessageId: 'g2b', answers: { b: 2 } },
  ]);
});

test('clearing a group needs the conversation: the same group id elsewhere is left alone', () => {
  const file = tmpFile();
  seedGroup(file);
  recordPendingQuestion(formRecord({ cardMessageId: 'other', conversationId: 'grp-2', group: { id: 'sdlc-1024', index: 1, total: 2 } }), { file });
  assert.throws(() => clearPendingGroup(undefined, 'sdlc-1024', { file }), /conversationId/);
  assert.equal(clearPendingGroup('grp-1', 'sdlc-1024', { file }), 2);
  assert.deepEqual(listPendingQuestions({ file }).map((r) => r.cardMessageId), ['other']);
});

// ------------------------------------------------- PR #205 review follow-ups

test('a key that only exists on the prototype is not a question on the card', () => {
  for (const k of ['constructor', 'toString', 'hasOwnProperty']) {
    const viaTicked = decodeFormAnswer(formRecord(), ['opt_1'], { otherSelected: [k] });
    assert.deepEqual(viaTicked.unknownKeys, [k], `otherSelected ${k}`);
    const viaText = decodeFormAnswer(formRecord(), ['opt_1'], { otherText: { [k]: 'x' } });
    assert.deepEqual(viaText.unknownKeys, [k], `otherText ${k}`);
  }
});

test('sameFormAnswers: an older outcome without otherSelected equals the same answer read today', () => {
  const today = decodeFormAnswer(formRecord(), ['opt_1']).answers;
  // What the pre-v1.6 version stored: no otherSelected, otherText always null.
  const older = Object.fromEntries(Object.entries(today).map(([k, q]) => {
    const { otherSelected, ...rest } = q;
    return [k, rest];
  }));
  assert.notEqual(JSON.stringify(older), JSON.stringify(today), 'the shapes do differ');
  assert.equal(sameFormAnswers(older, today), true);
});

test('sameFormAnswers: a different option, "other" or question set is a different answer', () => {
  const base = decodeFormAnswer(formRecord(), ['opt_1']).answers;
  assert.equal(sameFormAnswers(base, decodeFormAnswer(formRecord(), ['opt_2']).answers), false);
  assert.equal(sameFormAnswers(base, decodeFormAnswer(formRecord(), ['opt_1'], { otherSelected: ['cc'] }).answers), false);
  assert.equal(sameFormAnswers(base, decodeFormAnswer(formRecord(), ['opt_1'], { otherText: { cc: '运营' } }).answers), false);
  const { cc, ...fewer } = base;
  assert.equal(sameFormAnswers(base, fewer), false);
  assert.equal(sameFormAnswers(fewer, base), false, 'a question only the newer answer has');
  const typed = (t) => decodeFormAnswer(formRecord(), [], { otherSelected: ['cc'], otherText: { cc: t } }).answers;
  assert.equal(sameFormAnswers(typed('运营'), typed('运营')), true);
  assert.equal(sameFormAnswers(typed('运营'), typed('市场')), false, 'only the other text differs');
});

test('sameFormAnswers: a fill-in answer is the same only with the same text', () => {
  const filled = (t) => decodeFormAnswer(textRecord(), [], { text: { name: t } }).answers;
  assert.equal(sameFormAnswers(filled('王小明'), filled('王小明')), true);
  assert.equal(sameFormAnswers(filled('王小明'), filled('李雷')), false);
  assert.equal(sameFormAnswers(filled('王小明'), decodeFormAnswer(textRecord(), []).answers), false, 'answered vs unanswered');
});
