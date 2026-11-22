import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8').replace(/\s+/g, ' ');
// Scan SKILL.md, every references/automation-*.md and every other reference
// that mentions automations, so the reversed rule cannot reappear in a file
// this test does not read.
const referenceNames = readdirSync(new URL('references/', root)).filter(name => name.endsWith('.md')).sort();
const docs = { 'SKILL.md': read('SKILL.md') };
for (const name of referenceNames) {
  const text = read(`references/${name}`);
  if (name.startsWith('automation-') || /automation/i.test(text)) docs[name] = text;
}
const DELIVERY = 'automation-delivery.md';

// These check written guardrails for OPENM-1164 (held webhook events replayed
// on the human Owner's decision), not whether a model follows them.
const required = [
  /A webhook run with `replay_state: "replay"` is a replayed event/,
  /it arrived while the automation was paused or the organization was suspended, was held, and the human Owner chose to replay it when resuming/,
  /Its `trigger_kind` stays `webhook`, and its `scheduled_at` is the time the event was received, not the time the replay ran/,
  /On a normal run `replay_state` is empty or absent/,
  /Read `replay_state` from the matching run record; the Issue description line `Replayed event <delivery_id>: received at <t> while the automation was not running; replayed at <t2>\. It may be outdated\.` is only a hint/,
  /The event may be outdated: before acting, check the current state of the external object it refers to \(for example, the merge request may already be merged\)/,
  /act on that state, not on the payload alone/,
  /If the event is outdated and nothing is left to do, take no action and complete the run as `success`; state clearly in the result that the event was outdated and no action was taken/,
  /The `<delivery_id>` in that line identifies the original webhook event \(it is not the result `delivery\.id`\)/,
  /Use it to correlate the replay with that event, and do not repeat side effects, such as reports or DMs, already produced for that delivery ID/,
  /Only the human Owner decides, when resuming, whether held events are replayed; the Agent cannot replay or decline them/,
  /Holding applies to webhooks only: a timer automation still does not catch up runs missed while it was paused or the organization was suspended/,
];
// The 09-19 rule ("suspended deliveries never replay") is reversed for
// webhooks; no reference may state it again. Only the human Owner decides on
// held events, so no reference may let the Agent replay or decline them.
const forbidden = [
  /(?:paused|suspended|held|cancelled)[^.]*\b(?:never|not|no longer) (?:be )?(?:replayed|re-?run)/i,
  /`scheduled_at` is the time the replay ran/,
  /\bAgents? (?:also )?(?:may|can|could|should|must|will|is allowed to|is able to|(?:decides?|chooses?)(?: whether)? to)(?: also)?(?: (?:choose|decide)(?: whether)? to)? (?:replay|decline)/i,
  /\bAgents? (?:decides?|chooses?) (?:whether|which|if)\b[^.]*\b(?:replay|declin)/i,
  /\b(?:be|is|are|gets?) (?:replayed|declined)(?: or (?:replayed|declined))? by (?:the |an |a |this |its )?(?:responsible )?Agents?\b/i,
  /timer automation (?:also )?catches up/,
  /OPENM-1164/,
];

function verify(texts) {
  const section = texts[DELIVERY].split('### Identify the run before interpreting its timing')[1]?.split('### Execution steps')[0];
  assert.ok(section, 'missing reachable run-identification section');
  for (const pattern of required) assert.match(section, pattern);
  for (const [name, text] of Object.entries(texts)) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name}: ${pattern}`);
  }
}

test('the wording checks scan SKILL.md and every automation reference', () => {
  const automationFiles = referenceNames.filter(name => name.startsWith('automation-'));
  for (const name of ['automation-common.md', DELIVERY, 'automation-schedule.md', 'automation-update.md', 'automation-webhook.md']) {
    assert.ok(automationFiles.includes(name), `references/${name} exists`);
  }
  for (const name of ['SKILL.md', ...automationFiles, 'tm-operations.md']) assert.ok(name in docs, `scans ${name}`);
});

test('replayed webhook runs are identified by replay_state and checked for staleness', () => {
  verify(docs);
});

test('webhook replay instructions reject removed guardrails and the reversed rule', () => {
  for (const [before, after] of [
    ['`scheduled_at` is the time the event was received, not the time the replay ran', '`scheduled_at` is the time the replay ran'],
    ['On a normal run `replay_state` is empty or absent', 'On a normal run `replay_state` is `normal`'],
    ['The event may be outdated', 'The event is current'],
    ['before acting, check the current state of the external object', 'act on the payload directly'],
    ['complete the run as `success`', 'fail the run'],
    ['state clearly in the result that the event was outdated and no action was taken', 'report nothing'],
    ['Use it to correlate the replay with that event', 'Ignore it'],
    ['do not repeat side effects', 'repeat side effects'],
    ['the human Owner chose to replay it', 'the Agent chose to replay it'],
    ['the Agent cannot replay or decline them', 'the Agent can decline them'],
    ['a timer automation still does not catch up', 'a timer automation also catches up'],
    ['Its `trigger_kind` stays `webhook`', 'Its `trigger_kind` becomes `replay`'],
  ]) {
    assert.ok(docs[DELIVERY].includes(before), `delivery contains: ${before}`);
    assert.throws(() => verify({ ...docs, [DELIVERY]: docs[DELIVERY].replace(before, after) }), before);
  }
  for (const addition of [
    'Webhook deliveries received while the automation is suspended are never replayed.',
    'Events received while paused are not replayed.',
    'The Agent may decline held events.',
    'Held events can be declined or replayed by the Agent.',
    'The Agent decides whether held events are replayed.',
    'A replayed event (OPENM-1164) may be outdated.',
  ]) {
    for (const name of Object.keys(docs)) {
      assert.throws(() => verify({ ...docs, [name]: `${docs[name]} ${addition}` }), `${name}: ${addition}`);
    }
  }
});
