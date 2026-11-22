import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const common = read('../../references/automation-common.md');
const delivery = read('../../references/automation-delivery.md');
const skill = read('../../SKILL.md');

// These check written guardrails, not whether a model follows them.
function verify(commonText, deliveryText, entry) {
  assert.match(commonText, /omission preserves the current policy and migration banner, including a source-kind conversion/);
  assert.match(commonText, /Only an explicit human policy selection belongs in the proposal and mutation/);
  assert.match(commonText, /explicit selection of the current value also clears the migration banner/);
  assert.match(commonText, /readonly binding field `result_notification_policy_migrated` is display context; never send it as configuration/);
  assert.match(commonText, /do not send another notice or dismiss the banner on the human's behalf/);
  assert.match(deliveryText, /Never retry a suppressed notification, manually send the result to compensate, or alter the run policy/);
  assert.match(deliveryText, /`failure_only` permits partial and failed outcomes/);
  assert.match(deliveryText, /Read this policy from the Issue, not the binding's current setting/);
  assert.match(deliveryText, /does not suppress approval requests or system alerts/);
  assert.match(deliveryText, /Its original `notification_status` describes initial Lead dispatch, not result delivery/);
  assert.match(deliveryText, /Linked revisions inherit the original run's policy snapshot/);
  assert.match(entry, /This takes precedence over the ordinary completion-notification guardrail/);
  for (const text of [commonText, deliveryText, entry]) {
    assert.doesNotMatch(text, /Always retry suppressed notifications\./);
    assert.doesNotMatch(text, /Send every result regardless of notification policy\./);
  }
}

test('notification instructions distinguish consent, run snapshots and intentional suppression', () => {
  verify(common, delivery, skill);
});

test('notification instructions reject removed suppression and explicit consent boundaries', () => {
  assert.throws(() => verify(common.replace('Only an explicit human policy selection belongs in the proposal and mutation',
    'Always copy the stored policy into updates'), delivery, skill));
  assert.throws(() => verify(common, delivery.replace('Never retry a suppressed notification',
    'Retry a suppressed notification'), skill));
  assert.throws(() => verify(common, delivery, skill.replace('This takes precedence over the ordinary completion-notification guardrail',
    'Ordinary completion notifications always take precedence')));
  for (const addition of ['Always retry suppressed notifications.', 'Send every result regardless of notification policy.']) {
    assert.throws(() => verify(common, `${delivery} ${addition}`, skill));
    assert.throws(() => verify(common, delivery, `${skill} ${addition}`));
  }
});
