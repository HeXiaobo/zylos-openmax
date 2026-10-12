import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity, resolveActivityEnabled, shouldRegisterRun, replyConversationOf } from './index.js';

test('feature flag: off by default; env wins over config', () => {
  assert.equal(resolveActivityEnabled({ env: {}, config: {} }), false);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: {} } }), false);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: { enabled: true } } }), true);
  assert.equal(resolveActivityEnabled({ env: {}, config: { activity: { enabled: 'yes' } } }), false);
  for (const v of ['0', 'false', 'OFF', 'no']) {
    assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: v }, config: { activity: { enabled: true } } }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'YES']) {
    assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: v }, config: {} }), true, v);
  }
  assert.equal(resolveActivityEnabled({ env: { OPENMAX_ACTIVITY: 'maybe' }, config: {} }), false);
});

test('disabled: an inert stub — no run, no marker, no files, no stats line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-off-'));
  const runsDir = path.join(dir, 'runs');
  const a = createActivity({ config: {}, env: {}, runsDir });
  assert.equal(a.enabled, false);
  assert.equal(a.registerRun({ orgId: 'o', conversationId: 'c', endpoint: 'c' }), null);
  assert.equal(a.onServerError('o', { code: 'UNKNOWN_FRAME_TYPE', message: 'agent_activity' }), false);
  assert.equal(a.statsLine(), null);
  a.start();
  a.stop();
  assert.equal(fs.existsSync(runsDir), false, 'nothing written while off');
});

test('disabled: a run index left from an enabled period is removed so send.js stops attaching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-off-'));
  fs.writeFileSync(path.join(dir, 'active.json'), '{"v":1,"by_conversation":{},"gate":{"o":"open"}}');
  createActivity({ config: {}, env: {}, runsDir: dir });
  assert.equal(fs.existsSync(path.join(dir, 'active.json')), false);
});

// Decisions in the exact shapes shouldHandleMessage returns (src/comm-bridge.js).
test('run registration rule (DM always; group / thread only when @-mentioned)', () => {
  const cases = [
    ['dm', { handle: true, reason: 'dm:owner-exempt' }, true],
    ['dm', { handle: true, reason: 'system-sender' }, true],
    ['group', { handle: true, reason: 'group:allowlist/smart', mode: 'smart', mentioned: true }, true],
    ['group', { handle: true, reason: 'group:allowlist/smart', mode: 'smart', mentioned: false }, false],
    ['group', { handle: true, reason: 'group:allowlist/mention [owner-mention-bypass]', mode: 'mention', mentioned: true }, true],
    ['thread', { handle: true, reason: 'group:open/mention', mode: 'mention', mentioned: true }, true],
    ['group', { handle: true, reason: 'system-sender' }, false],
  ];
  for (const [convType, decision, want] of cases) {
    assert.equal(shouldRegisterRun({ enabled: true, convType, decision }), want, `${convType} ${decision.reason} ${decision.mentioned}`);
    assert.equal(shouldRegisterRun({ enabled: false, convType, decision }), false);
  }
});

test('replyConversationOf: thread wins over the parent conversation', () => {
  assert.equal(replyConversationOf('c1|reply:9'), 'c1');
  assert.equal(replyConversationOf('c1|thread:t1|parent:9'), 't1');
  assert.equal(replyConversationOf(''), null);
});
