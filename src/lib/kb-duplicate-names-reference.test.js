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
    // the web app menu item is behind a runtime switch (zylos0t #326 R2 P2)
    /That menu item sits behind a runtime switch that is off until each environment turns it on, so it may not be there yet: if the owner does not see it, tell them plainly that converting is not available in this workspace yet, and do not try to convert the knowledge base any other way/,
    /an Agent without `kb\.manage` gets 403 `AUTH_FORBIDDEN`; the owner's own Agents holding `kb\.manage` get 400 `KB_PRIVATE_VISIBILITY_RESERVED`; other `kb\.manage` holders get 404/,
    /while projects use it, archived projects included \(409 `KB_IN_USE_BY_PROJECTS`/,
    /`meta\.reason: personal`/,
    /`meta\.reason: archived`; restore it first/,
    /asking for `closed` is refused \(412 `KB_PRIVATE_VISIBILITY_IMMUTABLE` `meta\.reason: not_open`\)/,
    /once no project uses it, while automations \(enabled or paused\) store their outputs in it or unfinished Issues \(neither accepted nor terminated\) are located in it \(409 `KB_IN_USE_BY_AUTOMATIONS_OR_ISSUES` with `meta\.automation_count` and `meta\.open_issue_count`/,
    /Refused with 409 `KB_IN_USE_BY_PROJECTS` \(`meta\.project_count`\) while projects, archived ones included, use it/,
    /`\{limit\?, offset\?, statusFilter\?\}`/,
  ]) assert.match(text, pattern);
  for (const stale of [/Known limit: the owner's private automations/, /tracked in cws-core#324/, /cws-core answers 403 to Agents/, /Permanently delete a KB \(physical delete/, /currently usually 1 per org/, /an org usually has only 1 KB/, /each org has 1 default KB/]) {
    assert.doesNotMatch(text, stale);
  }
});

test('SKILL.md asks when a KnowledgeBase name matches several', () => {
  const text = flat('SKILL.md');
  assert.match(text, /KnowledgeBase names are not unique: if the name the human gives matches several, list them \(link, creator, private or org, last update\) and ask which one/);
  assert.match(text, /KB names are not unique, so a name that matches several KBs is not a choice: list the candidates and ask/);
  assert.match(text, /kb\.list\(\{limit:100\}\) → kbId \(names are not unique: several matches → ask the human\)/);
  // Complex Task Flow step 2 points at the same rule (zylos0t #326 P3)
  assert.match(text, /Confirm the output KnowledgeBase only if the human has not already specified it; KnowledgeBase names are not unique, so a name that matches several is not a choice: list them/);
});
