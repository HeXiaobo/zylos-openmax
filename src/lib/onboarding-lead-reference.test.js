import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// These guards protect the shipped Agent instructions, not live Agent behavior:
// no code builds the onboarding card titles — the Agent fills them in from the
// fixed wording in references/onboarding-lead.md — so the wording and its
// placeholder definitions ARE the contract.

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const lead = read('references/onboarding-lead.md');

// The fixed-wording table under "Sending the cards": `| Card | title | text |`.
// Other tables in the file also have "Task cards" rows, so start at the rule.
const wordingTable = lead.split('🔴 **The card words are fixed')[1]?.split('\n## ')[0] ?? '';

function cardRow(card) {
  const row = wordingTable.split('\n').find((line) => line.trim().startsWith(`| ${card} |`));
  assert.ok(row, `references/onboarding-lead.md has no "${card}" row in the card wording table`);
  const [, title, text] = row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [zh, en] = title.split(' / ');
  return { zh, en, text };
}

// The {name} rule as the reference states it: the part of the display name
// after 「 · 」, else the whole display name.
const shortName = (displayName) => {
  const parts = displayName.split(' · ');
  return parts[parts.length - 1].trim();
};

// Fill a template the way the Agent is told to: {name} from its own display
// name, {person} from the role preset (which the opening card must not use).
const render = (template, { displayName, person }) => template
  .replaceAll('{name}', shortName(displayName))
  .replaceAll('{person}', person);

const placeholders = (s) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);

test('🔴 task card title introduces the Agent by its own name, never the preset persona', () => {
  const { zh, en } = cardRow('Task cards');
  assert.deepEqual(placeholders(zh), ['name'], `zh task-card title must use {name} only: ${zh}`);
  assert.deepEqual(placeholders(en), ['name'], `en task-card title must use {name} only: ${en}`);
});

test('🔴 a custom display name without 「 · 」 is used whole (add-on Agent bought as 销售测试1283)', () => {
  const { zh, en } = cardRow('Task cards');
  const values = { displayName: '销售测试1283', person: '大麦' };
  assert.equal(render(zh, values), '你好 👋 我是销售测试1283，已经上岗了');
  assert.equal(render(en, values), "Hi 👋 I'm 销售测试1283, and I'm on the job");
  assert.ok(!render(zh, values).includes('大麦'), 'preset person leaked into the zh title');
  assert.ok(!render(en, values).includes('大麦'), 'preset person leaked into the en title');
});

test('🔴 a renamed Agent 「运营助手 · 小张」 introduces itself as 小张', () => {
  const { zh, en } = cardRow('Task cards');
  const values = { displayName: '运营助手 · 小张', person: '大麦' };
  assert.equal(render(zh, values), '你好 👋 我是小张，已经上岗了');
  assert.equal(render(en, values), "Hi 👋 I'm 小张, and I'm on the job");
  assert.ok(!render(zh, values).includes('大麦'));
});

test('teammate card names the Agent the same way as the task card', () => {
  const { zh, en } = cardRow('Teammate card');
  assert.deepEqual(placeholders(zh), ['name']);
  assert.deepEqual(placeholders(en), ['name']);
  assert.equal(render(zh, { displayName: '销售测试1283', person: '大麦' }), '给销售测试1283配一位搭档');
});

test('{name} is defined from the live display name, with the no-「 · 」 fallback, and not from the preset', () => {
  const def = lead.split('\n').find((l) => l.includes('🔴 **The card words are fixed'));
  assert.ok(def, 'card wording rule line missing');
  const flat = def.replace(/\s+/g, ' ');
  assert.match(flat, /`\{name\}` is .*your own display name/, '{name} must be your own display name');
  assert.match(flat, /`core\.me( \{\})?`/, '{name} must be read from core.me (reflects a rename / purchase name)');
  assert.match(flat, /no 「 · 」.*whole display name/, '{name} must say what to use when there is no 「 · 」');
  assert.match(flat, /never `person`/, 'must say the preset person is not your name');
  assert.ok(!/`\{person\}` is/.test(flat), '{person} must no longer be defined as a card placeholder');
});

test('no shipped instruction fills an onboarding card with the preset {person}', () => {
  const files = ['SKILL.md', ...readdirSync(new URL('../../references/', import.meta.url))
    .filter((f) => f.endsWith('.md')).map((f) => `references/${f}`)];
  const offenders = files.filter((f) => read(f).includes('{person}'));
  assert.deepEqual(offenders, [], `{person} placeholder still used in: ${offenders.join(', ')}`);
});

// Multi-session Core: the onboarding opening has exactly
// one owner — the owner DM's thread sends the cards (or their text form) and
// reports task_cards_sent with the card ids; the System Member DM's thread only
// hands it off and never sends or reports the opening itself.
test('the onboarding opening is owned by the owner DM thread; the wake thread only hands it off', () => {
  const flat = lead.replace(/\s+/g, ' ');
  assert.match(flat, /The opening — the task cards, their text form if the cards fail, and the `task_cards_sent` report with the `card_ids` — belongs entirely to the \*\*owner DM's thread\*\*/);
  assert.match(flat, /Then stop: send no card, text form or report yourself, and do not wait for a reply\. The opening is \*\*in flight\*\*/);
  assert.match(flat, /the owner DM's thread starts every hand-off with step 1 and does nothing once `task_cards_sent` is recorded/);
  assert.match(flat, /reported by the thread that sent the cards \(the owner DM's thread\), with the ids it got back/);
  assert.match(flat, /in the owner DM's thread; in any other thread, hand it off instead/);
  assert.doesNotMatch(flat, /ask the owner DM's thread to send the card by `internal`/, 'no split ownership of the opening');
});
