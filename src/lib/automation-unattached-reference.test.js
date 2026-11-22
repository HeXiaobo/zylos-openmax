import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const docs = {
  common: read('../../references/automation-common.md'),
  creation: read('../../references/automation-creation.md'),
  update: read('../../references/automation-update.md'),
  tm: read('../../references/tm-operations.md'),
};

// These check written guardrails for OPENM-1305 / OPENM-1308, not whether a
// model follows them.
const required = {
  common: [
    /`spec` with `project_id`, `title`, `description` and optional `unattached`, `unattached_scope`, `knowledge_base_mode`, `knowledge_base_id`/,
    /never for the system project of an automation that belongs to no project/,
    /`spec\.unattached: true` is the human's choice that the automation belongs to no project \(「不挂项目」\)/,
    /It is a decision, not a missing project: do not ask for a project, pick one or treat the absent `project_id` as incomplete/,
    /Pass the handoff's `spec` verbatim in the proposal and mutation configuration; never add a `project_id`, drop `unattached` or `unattached_scope`, or change the scope/,
    /Rely on the server card's project line 「项目：不归属项目」 \(private: 「项目：不归属项目（私人）」\)/,
    /`unattached_scope` is `org` or `private`, only with `unattached: true` and no `project_id`/,
    /Without `unattached: true`, `project_id` is required/,
    /`knowledge_base_id` is required exactly with `custom`/,
    /`unattached: true` together with a `project_id` is valid only for the system project an earlier read returned/,
    /never fill it in from a baseline or read/,
    /do not run `core\.project_members` or any other membership check against the Inbox or a hidden private project/,
    /the server refuses `project_member_additions` there/,
    /compare `spec\.unattached: true` and the binding's `scope` with the confirmed `unattached_scope` \(`org` when omitted\) on readback, not `project_id`/,
    /never strip them, substitute a project or retry without them/,
  ],
  creation: [
    /For 「不挂项目」 the spec has no `project_id`/,
    /`spec\.unattached: true` already decides the project question \(no project\): never ask for a project or suggest one/,
    /With `spec\.unattached: true` there is no selected project to check/,
    /For `spec\.unattached: true`, compare `spec\.unattached` and the binding's `scope` with the confirmed `unattached_scope`, not `project_id`/,
  ],
  update: [
    /An update may switch an attached automation to no project \(OPENM-1308\)/,
    /do not ask for a project and never put the baseline `project_id` back, which would undo the change/,
    /`AUTOMATION_SCOPE_CHANGE_FORBIDDEN`/,
    /on `AUTOMATION_PRIVATE_WORKSPACE_REQUIRED` explain that the Owner must create their private workspace first and stop; never attach it to a project instead/,
    /names the system project its read returned and omits `unattached`, which keeps it unattached/,
    /When the read has `spec\.unattached: true`, its `project_id` is the Inbox or the Owner's hidden private project: skip the `core\.project_members` traversal for B/,
    /`unattachedScope:<its unattached_scope>` \(`org` when omitted\) instead of `projectId` when it has `unattached: true` and no `project_id`; never both/,
    /A rejection stops; never retry with the other form/,
    /compared by `spec\.unattached` and the binding's `scope`, not `project_id`/,
  ],
  tm: [/`spec` carries `project_id`, `title`, `description` and the optional `unattached`, `unattached_scope`, `knowledge_base_mode` and `knowledge_base_id` verbatim/],
};
const forbidden = [
  /`spec` with `project_id`, `title`, `description` \|/,
  /[Aa]sk (the human )?(which|for a) project when `spec\.unattached/,
  /[Cc]ompare `project_id` for an unattached automation/,
];

function verify(texts) {
  for (const [name, patterns] of Object.entries(required)) {
    for (const pattern of patterns) assert.match(texts[name], pattern, `${name}: ${pattern}`);
  }
  for (const text of Object.values(texts)) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern);
  }
}

test('unattached instructions treat no project as a decision and pass the spec verbatim', () => {
  verify(docs);
});

test('unattached instructions reject removed guardrails and contradictions', () => {
  for (const [name, before, after] of [
    ['common', 'It is a decision, not a missing project', 'It is a missing project'],
    ['common', 'never add a `project_id`', 'add the baseline `project_id`'],
    ['common', 'do not run `core.project_members`', 'run `core.project_members`'],
    ['common', 'on readback, not `project_id`', 'on readback, and `project_id`'],
    ['creation', 'never ask for a project or suggest one', 'ask which project to use'],
    ['update', 'never put the baseline `project_id` back', 'put the baseline `project_id` back'],
    ['update', 'skip the `core.project_members` traversal for B', 'run the `core.project_members` traversal for B'],
    ['update', 'never both', 'or both'],
  ]) {
    assert.ok(docs[name].includes(before), `${name} contains: ${before}`);
    assert.throws(() => verify({ ...docs, [name]: docs[name].replace(before, after) }), `${name}: ${before}`);
  }
  for (const addition of ['Ask which project when `spec.unattached` is true.', 'Compare `project_id` for an unattached automation.']) {
    for (const name of Object.keys(docs)) {
      assert.throws(() => verify({ ...docs, [name]: `${docs[name]} ${addition}` }), `${name}: ${addition}`);
    }
  }
  // The old three-field spec row must not come back.
  assert.throws(() => verify({ ...docs, common: docs.common.replace(
    '`spec` with `project_id`, `title`, `description` and optional `unattached`, `unattached_scope`, `knowledge_base_mode`, `knowledge_base_id` |',
    '`spec` with `project_id`, `title`, `description` |') }));
});
