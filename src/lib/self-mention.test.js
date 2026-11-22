import assert from 'node:assert/strict';
import test from 'node:test';

import { isSelfAddressed, isSelfMentioned } from './self-mention.js';

const SELF = '019fa13e-5542-73cd-abd0-0bd4a0f65a67';
const OTHER = '019f6b2f-9cb0-76ed-94b2-1357236c684c';

test('matched when our member_id is among the structured mentions', () => {
  assert.equal(isSelfMentioned({ mentionIds: [SELF], selfMemberId: SELF }), true);
  assert.equal(isSelfMentioned({ mentionIds: [OTHER, SELF], selfMemberId: SELF }), true); // order-independent
});

test('#85: structured mentions present but NOT us → not mentioned', () => {
  // "@luna.coco" carries luna.coco's member_id; a bare "luna" agent is absent
  // from the array and must not be woken.
  assert.equal(isSelfMentioned({ mentionIds: [OTHER], selfMemberId: SELF }), false);
});

test('no structured mentions at all → not mentioned (no text fallback)', () => {
  assert.equal(isSelfMentioned({ mentionIds: [], selfMemberId: SELF }), false);
  assert.equal(isSelfMentioned({ selfMemberId: SELF }), false);
});

test('@所有Agent is matched for free — expansion carries our own member_id', () => {
  // Live payload shape: @所有Agent expands to one row per agent, each with the
  // real member_id (is_mention_all marker is irrelevant to matching).
  assert.equal(isSelfMentioned({ mentionIds: [SELF, OTHER], selfMemberId: SELF }), true);
});

test('@所有人 is NOT matched — expansion targets humans, our id is absent', () => {
  // @所有人 yields rows for human members only; this agent's id is not present.
  assert.equal(isSelfMentioned({ mentionIds: [OTHER], selfMemberId: SELF }), false);
});

test('missing selfMemberId → not mentioned', () => {
  assert.equal(isSelfMentioned({ mentionIds: [SELF], selfMemberId: undefined }), false);
  assert.equal(isSelfMentioned({ mentionIds: [SELF] }), false);
});

test('id comparison is string-normalized', () => {
  assert.equal(isSelfMentioned({ mentionIds: [12345], selfMemberId: '12345' }), true);
});

test('isSelfAddressed: true only when addressed_member_ids holds this agent', () => {
  assert.equal(isSelfAddressed({ addressedIds: [OTHER, SELF], selfMemberId: SELF }), true);
  assert.equal(isSelfAddressed({ addressedIds: [OTHER], selfMemberId: SELF }), false);
  assert.equal(isSelfAddressed({ addressedIds: undefined, selfMemberId: SELF }), false);
});
