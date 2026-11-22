import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const raw = path => readFileSync(new URL(path, root), 'utf8');
const flat = text => text.replace(/\s+/g, ' ');
const docs = { 'SKILL.md': raw('SKILL.md') };
for (const name of readdirSync(new URL('references/', root)).filter(n => n.endsWith('.md')).sort()) {
  docs[name] = raw(`references/${name}`);
}

// These check written guardrails (a page write into a deleted or unknown
// knowledge base answers 404 KB_NOT_FOUND since cws-kb !290), not whether a
// model follows them.
const required = {
  'SKILL.md': [
    /Degrade only when the gateway itself does not serve the operation: a CLI command returns 501, or a command its operation guide marks ⏳ \(not yet available\) returns 404 \(cws-core gateway not yet connected\)/,
    /Any other 404 is an answer about the resource, not a missing gateway/,
    /Never report it as "gateway not connected" or "temporarily unsupported", and do not degrade to the conversation flow for it/,
    /#### Writing into a deleted knowledge base/,
    /`kb\.page_create` answered 404 with `code: "KB_NOT_FOUND"` means the knowledge base was deleted, doesn't exist or is no longer accessible to you \(for example your access was revoked\), and nothing was written/,
    /A 404 without a cws-core error body is not this answer \(it can come from a proxy or a wrong server URL\)/,
    /A cws-core without that code answers a plain 404; the KB CLI then still adds `kbId` and a `hint` with the same meaning/,
    /do not retry the same `kbId`, and do not switch to another KB or the Project's current default on your own/,
    /the knowledge base `<kbId>` was deleted, doesn't exist or is no longer accessible to you; ask them to restore your access, pick or re-create a knowledge base, or update the project's \(or automation's\) knowledge base/,
    /If only your access is gone, the documents are still in that knowledge base, so restoring your access is the fix, not a new knowledge base/,
    /In an automation run the run result is this notification: write it there and do not send a separate message/,
    /A page write into it answered 404 `KB_NOT_FOUND` \(or a plain 404 from `kb\.page_create`\) means that KB was deleted, doesn't exist or is no longer accessible to you: the same blocker, handled as in "Writing into a deleted knowledge base", never "gateway not connected"/,
  ],
  'kb-operations.md': [
    /\*\*404 on a page write: the knowledge base is gone\*\* \(not a gateway problem\)/,
    /cws-core answers 404 with `code: "KB_NOT_FOUND"` and `meta\.kb_id`; a cws-core without that code answers a plain 404 \(`code: "KB_ERROR"`\)/,
    /the CLI's error JSON carries, next to `error` \/ `status`: `code` \(when the response had one\), `kbId` and a `hint`/,
    /A 404 \*\*without\*\* a cws-core error body \(no `code`\) is not an answer about the knowledge base/,
    /the `hint` then says to run `kb\.get \{kbId\}`: 404 there = the knowledge base is gone or not accessible to you, otherwise only the folder is/,
    /A knowledge base that is gone or no longer accessible is never "gateway not connected" or "temporarily unsupported"/,
    /ask them to restore your access, pick or re-create one, or update the project's \(or automation's\) knowledge base/,
  ],
  'automation-delivery.md': [
    /A `kb\.page_create` into the recorded KB answered 404 `KB_NOT_FOUND` \(or a plain 404; the KB CLI adds `kbId` and `hint`\) means that knowledge base was deleted, does not exist or is no longer accessible to the Agent/,
    /This is that blocker, not "gateway not connected" or a temporary outage: do not retry it or write elsewhere/,
    /say in the result that the knowledge base `<kbId>` was deleted, does not exist or is no longer accessible to the Agent, and that the Owner should restore the Agent's access, pick or re-create a knowledge base, or update the automation's or project's knowledge base/,
    /The run result is the notification: do not send a separate message about it/,
  ],
};

for (const [name, patterns] of Object.entries(required)) {
  test(`${name} states how a KB page write's 404 / KB_NOT_FOUND is reported`, () => {
    const text = flat(docs[name]);
    for (const pattern of patterns) assert.match(text, pattern);
  });
}

// The contradiction this replaces: SKILL.md's API Degradation section read any
// 404 as "cws-core gateway not yet connected", while the KB section called an
// inaccessible recorded KB a blocker. "Gateway not connected" may only be tied
// to a 501 or to a command marked ⏳, appear as something a 404 is not, or name
// the wrong behaviour in the anti-pattern table.
test('no doc reads a plain 404 as "gateway not connected"', () => {
  assert.doesNotMatch(flat(docs['SKILL.md']), /When a CLI command returns 404 or 501 \(cws-core gateway not yet connected\)/);
  for (const [name, text] of Object.entries(docs)) {
    for (const line of text.split('\n')) {
      if (!/gateway not (yet )?connected/i.test(line) || !/404/.test(line)) continue;
      // ⏳ / 501 degradation, a negation ("never \"gateway not connected\""), or
      // the wrong-behaviour column of SKILL.md's anti-pattern table.
      const allowed = /⏳/.test(line) || /\b(never|not|isn't|is not)\b[^.]*gateway not (yet )?connected/i.test(line)
        || /^\| Reporting [^|]* as "gateway not connected"/.test(line);
      assert.ok(allowed, `${name}: a 404 is tied to "gateway not connected" outside the ⏳ / negated forms:\n${line}`);
    }
  }
});
