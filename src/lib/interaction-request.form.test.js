import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFormRequest, InteractionRequestError, resolveInteractionType } from './interaction-request.js';

const form = (over = {}) => ({
  conversationId: 'c1',
  title: '需求打磨：开工前 2 个问题',
  summary: '「客户看板」· 答完点一次提交',
  fields: [
    {
      key: 'audience',
      label: '谁来用？',
      options: [{ key: 'internal', label: '内部员工', recommended: true }, { label: '外部客户' }],
    },
    { key: 'cc', label: '抄送谁？', required: false, options: ['产品', '设计'] },
  ],
  ...over,
});

function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected a refusal');
}

test('builds the contract 04 §2.1 form body', () => {
  const body = buildFormRequest(form({
    answerers: ['m-kevin', 'm-jessie'],
    group: { id: 'sdlc-1024', index: 1, total: 2 },
    clientMsgId: 'cmsg_fixed',
  }));
  assert.deepEqual(body, {
    interaction_type: 'form',
    client_msg_id: 'cmsg_fixed',
    form: {
      title: '需求打磨：开工前 2 个问题',
      summary: '「客户看板」· 答完点一次提交',
      blocks: [],
      fields: [
        {
          key: 'audience',
          label: '谁来用？',
          options: [{ key: 'internal', label: '内部员工', recommended: true }, { label: '外部客户' }],
        },
        { key: 'cc', label: '抄送谁？', required: false, options: [{ label: '产品' }, { label: '设计' }] },
      ],
      answerers: ['m-kevin', 'm-jessie'],
      group: { id: 'sdlc-1024', index: 1, total: 2 },
    },
  });
});

test('answerers and group are left out entirely when not given', () => {
  const body = buildFormRequest(form());
  assert.equal('answerers' in body.form, false);
  assert.equal('group' in body.form, false);
  assert.equal(typeof body.client_msg_id, 'string');
});

test('text is shorthand for one text block, and cannot be combined with blocks', () => {
  assert.deepEqual(buildFormRequest(form({ text: '先答这两题' })).form.blocks, [{ type: 'text', text: '先答这两题' }]);
  const err = refusal(() => buildFormRequest(form({ text: 'a', blocks: [] })));
  assert.equal(err.field, 'text');
});

test('step-two keys pass through to cws-comm, which is the one that refuses them', () => {
  const body = buildFormRequest(form({
    fields: [{
      key: 'pages', label: '做哪些页面？', selection_mode: 'multiple', min_select: 1, max_select: 2, allow_other: true,
      options: [{ label: '列表页' }, { label: '都不需要', exclusive: true }],
    }],
  }));
  const f = body.form.fields[0];
  assert.equal(f.selection_mode, 'multiple');
  assert.equal(f.min_select, 1);
  assert.equal(f.max_select, 2);
  assert.equal(f.allow_other, true);
  assert.equal(f.options[1].exclusive, true);
});

test('a misspelled key is refused at every level, not dropped', () => {
  assert.equal(refusal(() => buildFormRequest(form({ answerer: ['m-1'] }))).field, 'answerer');
  const badField = form();
  badField.fields[0].selection = 'single';
  assert.equal(refusal(() => buildFormRequest(badField)).field, 'fields[0].selection');
  const badOption = form();
  badOption.fields[0].options[0].recomended = true;
  assert.equal(refusal(() => buildFormRequest(badOption)).field, 'fields[0].options[0].recomended');
  assert.equal(refusal(() => buildFormRequest(form({ group: { id: 'g', index: 1, of: 2 } }))).field, 'group.of');
});

test('an option id is refused: cws-comm generates them', () => {
  const f = form();
  f.fields[0].options[0].id = 'opt_9';
  assert.match(refusal(() => buildFormRequest(f)).message, /form_option_ids/);
});

test('a question needs a key, a label and options; label/value rows are pointed at blocks', () => {
  const noKey = form();
  delete noKey.fields[0].key;
  assert.equal(refusal(() => buildFormRequest(noKey)).field, 'fields[0].key');

  const rows = refusal(() => buildFormRequest(form({ fields: [{ label: 'core', value: '0.7.1 → 0.8.1' }] })));
  assert.equal(rows.field, 'fields[0].options');
  assert.match(rows.message, /BLOCK/);

  assert.equal(refusal(() => buildFormRequest(form({ fields: [] }))).field, 'fields');
});

test('no counts or lengths are capped locally', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `q${i}`, label: `Q${i}`, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
  assert.equal(buildFormRequest(form({ fields: many })).form.fields.length, 12);
});

test('kind is refused with the reason, as on the choice builder', () => {
  assert.match(refusal(() => buildFormRequest(form({ kind: 'x' }))).message, /comm\.ask/);
});

test('resolveInteractionType: content decides, an explicit type must agree', () => {
  assert.equal(resolveInteractionType({ fields: [] }), 'form');
  assert.equal(resolveInteractionType({ options: [] }), 'choice');
  assert.equal(resolveInteractionType({}), 'choice');
  assert.equal(resolveInteractionType({ interactionType: 'form', fields: [] }), 'form');

  const both = refusal(() => resolveInteractionType({ fields: [], options: [] }));
  assert.ok(both instanceof InteractionRequestError);
  assert.equal(both.field, 'fields');
  assert.match(both.message, /blocks/);

  assert.equal(refusal(() => resolveInteractionType({ interactionType: 'form', options: [] })).field, 'options');
  const choiceWithFields = refusal(() => resolveInteractionType({ interactionType: 'choice', fields: [] }));
  assert.equal(choiceWithFields.field, 'fields');
  assert.match(choiceWithFields.message, /disagrees with interactionType "choice"/);
  assert.equal(refusal(() => resolveInteractionType({ interactionType: 'poll' })).field, 'interactionType');
});
