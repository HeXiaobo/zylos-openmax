import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const flat = path => readFileSync(new URL(path, root), 'utf8').replace(/\s+/g, ' ');

// These check the written guardrails for duplicate knowledge base names (cws-kb
// migration 000028 drops the name-unique indexes) and for private to org
// conversion (owner only, in the web app), not whether a model follows them.
test('kb-operations.md explains same-named knowledge bases', () => {
  const text = flat('references/kb-operations.md');
  for (const pattern of [
    /## Same-named knowledge bases/,
    /Knowledge base names are not unique/,
    /`kb\.list \{limit: 100\}` and page with `offset` until a page comes back short/,
    /\*\*Several matches: ask, never pick one yourself\.\*\*/,
    /creator \(resolve `creator_id` with `core\.member_get \{memberId\}`/,
    /\*\*Never blindly retry `kb\.create`\*\*/,
    /a second call now silently creates a second one with the same name/,
    /an Agent cannot convert a knowledge base between private and org/,
    /it cannot be turned back to private/,
    /`\{limit\?, offset\?, statusFilter\?\}`/,
  ]) assert.match(text, pattern);
  for (const stale of [/currently usually 1 per org/, /an org usually has only 1 KB/, /each org has 1 default KB/]) {
    assert.doesNotMatch(text, stale);
  }
});

test('SKILL.md asks when a KnowledgeBase name matches several', () => {
  const text = flat('SKILL.md');
  assert.match(text, /KnowledgeBase names are not unique: if the name the human gives matches several, list them \(link, creator, private or org, last update\) and ask which one/);
  assert.match(text, /KB names are not unique, so a name that matches several KBs is not a choice: list the candidates and ask/);
  assert.match(text, /kb\.list\(\{limit:100\}\) → kbId \(names are not unique: several matches → ask the human\)/);
});
