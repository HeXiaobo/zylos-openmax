/**
 * Markdown in a card's plain-text body is refused before the
 * card is posted. Cells: the detector's positives, the prose it must leave
 * alone, and every builder/send path refusing with nothing posted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownMarks, plainTextMarkdownProblem } from './card-text-markdown.js';
import { buildChoiceRequest, buildFormRequest, InteractionRequestError } from './interaction-request.js';
import { askForm, CARD_PREFIX, parseCardMessage, sendCardMessage } from './card-message.js';

// ------------------------------------------------------------------ detector

test('each rule fires on the mark it names', () => {
  const cases = [
    ['bold', '升级前请注意 **会重启服务**。'],
    ['bold', '**a** is enough'],
    ['bold', 'Results:**done**'],
    ['bold', '请注意**会重启**服务'],
    ['bold', '（**注意**）升级'],
    ['bold', 'run **`npm test`** first'],
    ['bold', '(**Note**) restart first'],
    ['bold', '`a`**b**'],
    ['bold', 'a ``` **b** `` c'],
    ['link', 'See [the release notes](https://example.com/notes).'],
    ['heading', '# Upgrade'],
    ['heading', 'Intro\n### 关键步骤'],
    ['fence', 'Run:\n```\nnpm test\n```'],
  ];
  for (const [rule, text] of cases) {
    assert.ok(markdownMarks(text).includes(rule), `${rule} missed in ${JSON.stringify(text)}`);
  }
});

test('ordinary prose is left alone', () => {
  const plain = [
    '2*3 = 6, and 2 * 3 * 4 = 24',
    'x**2 + y**2 = r**2',
    'call f(*args, **kwargs) and **opts',
    'a well-known, up-to-date, self-hosted setup',
    'see https://example.com/a_b_c?x=1 for details',
    'Visit [the dashboard] (no link) or (https://example.com)',
    'openmax 2.20.0 → 2.21.0。升级会重启服务，预计 30 秒。',
    '这是第 1. 步，接下来是第 2. 步',
    '#1 priority, #2 next, C# code',
    'define __init__ and __main__',
    'use `npm test` then _maybe_ *this*',
    '> quoted reply',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '- just one dash line',
    'score: 3 - 1\nnext: 4 - 2',
    'inline ``` in the middle',
    '***',
    '** spaced **',
    '**/node_modules/** is ignored',
    'dist/**/*.map 和 tmp/**',
    'call f(**a) then g(**b)',
    'use `**kwargs**` here',
    '** a**',
    '**a\nb**',
    'match src/**name**.js',
    // each of these is let through by exactly one bold condition
    'f(**a)**',
    'clean **/*.tmp and build**',
    'copy **docs/** too',
    '**a **',
    'glob **x**/y',
    'merge(x, **a,**b)',
    // lists read fine verbatim
    'Choose:\n- core\n- lark',
    '1. 备份\n2. 升级',
    // only https links are refused
    'see [doc](/x)',
    'mail [me](mailto:a@b)',
    'Old docs [x](http://example.com)',
  ];
  for (const text of plain) {
    assert.deepEqual(markdownMarks(text), [], `false positive on ${JSON.stringify(text)}`);
  }
});

test('non-strings and empty text have no marks', () => {
  for (const v of [undefined, null, '', 42, {}]) assert.deepEqual(markdownMarks(v), []);
});

test('the refusal shows the markdown block to send instead', () => {
  const short = plainTextMarkdownProblem('**hi**', undefined);
  assert.equal(short.field, 'text');
  assert.match(short.message, /shown verbatim/);
  assert.match(short.message, /Nothing was sent/);
  assert.match(short.message, /https links only/);
  assert.ok(short.message.includes('"blocks":[{"type":"markdown","text":"**hi**"}]'), short.message);

  const blocks = [{ type: 'markdown', text: '**ok here**' }, { type: 'text', text: 'a\n# b' }];
  const inBlock = plainTextMarkdownProblem(undefined, blocks);
  assert.equal(inBlock.field, 'blocks[1].text');
  assert.ok(inBlock.message.includes('{"type":"markdown","text":"a\\n# b"}'), inBlock.message);

  assert.equal(plainTextMarkdownProblem('plain', undefined), null);
  assert.equal(plainTextMarkdownProblem(undefined, [{ type: 'quote', text: '**theirs**' }]), null,
    'only text blocks are checked');
});

// ------------------------------------------------------------------ builders

const choice = (extra) => ({ title: 'Upgrade?', options: ['Yes', 'No'], ...extra });
const form = (extra) => ({ title: 'Pick', fields: [{ key: 'k', label: 'Which?', options: ['a', 'b'] }], ...extra });
const refused = (field) => (e) => e instanceof InteractionRequestError && e.field === field && /shown verbatim/.test(e.message);

test('🔴 both builders refuse Markdown in the text shorthand and in a text block', () => {
  assert.throws(() => buildChoiceRequest(choice({ text: '**重要**' })), refused('text'));
  assert.throws(() => buildChoiceRequest(choice({ blocks: [{ type: 'text', text: '# T' }] })), refused('blocks[0].text'));
  assert.throws(() => buildFormRequest(form({ text: '**a** b' })), refused('text'));
  assert.throws(() => buildFormRequest(form({ blocks: [{ type: 'divider' }, { type: 'text', text: '[x](https://e.com)' }] })), refused('blocks[1].text'));
});

test('the same content is accepted as a markdown block, and plain text still passes', () => {
  assert.equal(buildChoiceRequest(choice({ blocks: [{ type: 'markdown', text: '**重要**' }] })).choice.blocks[0].type, 'markdown');
  assert.equal(buildFormRequest(form({ blocks: [{ type: 'markdown', text: '- a\n- b' }] })).form.blocks[0].type, 'markdown');
  assert.equal(buildChoiceRequest(choice({ text: '升级会重启服务，2*3 秒。' })).choice.blocks[0].type, 'text');
});

// ------------------------------------------------------------------ send paths

function stubPost() {
  const calls = [];
  const fn = async (url, body) => { calls.push({ url, body }); return { message_id: 'm', action_ids: ['a'] }; };
  fn.calls = calls;
  return fn;
}

test('🔴 [CARD] with Markdown in text is refused and nothing is posted', async () => {
  const parsed = parseCardMessage(`${CARD_PREFIX}${JSON.stringify({ kind: 'k', askedOf: 'm1', ...choice({ text: '**升级**' }) })}`);
  const post = stubPost();
  let recorded = 0;
  await assert.rejects(() => sendCardMessage('cv', parsed, { post, recordQuestion() { recorded++; } }), refused('text'));
  assert.equal(post.calls.length, 0);
  assert.equal(recorded, 0);
});

test('🔴 a form (comm.ask / [CARD] form) with Markdown in a text block is refused and nothing is posted', async () => {
  const post = stubPost();
  await assert.rejects(
    () => askForm('cv', { kind: 'k', askedOf: 'm1', card: form({ blocks: [{ type: 'text', text: '## Steps' }] }) }, { post, recordQuestion() {} }),
    refused('blocks[0].text'),
  );
  assert.equal(post.calls.length, 0);
});
