/**
 * End to end on one host: inbound message → registerRun / marker → C4 accepted
 * → runtime log lines (fake Claude JSONL) → collector → attribution → frames
 * over a fake WsClient → send.js-side metadata from the same run files.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity } from './index.js';
import { encodeProjectDir } from './collector.js';
import { createRunStore } from './run-store.js';
import { planReplyMetadata } from './reply.js';
import { validateActivityFrame, classifyAgentRun } from './testdata/validators.js';

const ORG = 'org-1';
const CONV = '019f0000-aaaa-7bbb-8ccc-00000000000a';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-int-'));
  const zylos = path.join(home, 'zylos');
  fs.mkdirSync(path.join(zylos, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  const projDir = path.join(home, '.claude/projects', encodeProjectDir(fs.realpathSync(zylos)));
  fs.mkdirSync(projDir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  const logFile = path.join(projDir, `${sid}.jsonl`);
  fs.writeFileSync(logFile, `${JSON.stringify({ type: 'mode', mode: 'x' })}\n`);
  const runsDir = path.join(home, 'runs');

  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sent = [];
  const ws = {
    lastSentType: null,
    lastSentAt: 0,
    trySend(frame) { sent.push(JSON.parse(JSON.stringify(frame))); this.lastSentType = frame.type; return true; },
  };
  const warns = [];
  const activity = createActivity({
    config: { activity: { enabled: true } }, env: {}, now: clock.now, runsDir, homeDir: home, zylosDir: zylos,
    warn: (...a) => warns.push(a),
  });
  activity.bindOrgWs(ORG, ws);
  activity.onWsOpen(ORG);
  let uuid = 0;
  const append = (rec) => fs.appendFileSync(logFile, `${JSON.stringify({ isSidechain: false, sessionId: sid, uuid: `u${++uuid}`, timestamp: new Date(t).toISOString(), ...rec })}\n`);
  return { activity, clock, sent, append, runsDir, warns };
}

test('inbound → queued → thinking → tool → done frames, and the reply metadata', async () => {
  const { activity, clock, sent, append, runsDir, warns } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  assert.match(reg.marker, /^\[OM-RUN r_[0-9a-f]{8}\] $/);
  activity.confirmRun(reg.runId, '{"ok":true,"action":"queued","id":42}\n');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.state, 'queued');
  await activity.collector.discover();
  assert.equal(activity.collector.files.size, 1);

  const body = `${reg.marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="7383920118271"/>\n<current-message>\nAlice said: 报价对一下\n</current-message> ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}"`;
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: body } });
  append({ type: 'assistant', message: { content: [{ type: 'text', text: '先读定价文档。token=sk-secret-value' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/secret/path/pricing.md' } }] } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'` } }] } });
  activity.pollNow();

  // The reply (send.js) reads the same run files.
  const store = createRunStore({ dir: runsDir });
  assert.equal(store.readActive().gate[ORG], 'open');
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'c_k', now: clock.now(), store });
  const ar = plan.firstMetadata.agent_run;
  assert.equal(classifyAgentRun({ enabled: true, senderType: 'agent', raw: ar, now: clock.now() }).verdict, 'ok');
  assert.deepEqual(ar.steps.map((s) => s.category), ['commentary', 'read', 'reply']);
  plan.settle('ok');

  clock.advance(600);
  activity.emitter.tick();
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 3000 });
  activity.pollNow();

  const states = sent.map((f) => f.payload.state);
  assert.equal(states[0], 'queued');
  assert.ok(states.includes('tool'));
  assert.equal(states.at(-1), 'done');
  const seqs = sent.map((f) => f.payload.sequence);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  for (const f of sent) {
    const r = validateActivityFrame(JSON.stringify(f), clock.now());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.droppedEvents, []);
    assert.deepEqual(r.unknownEnums, []);
  }
  const wire = JSON.stringify(sent);
  assert.equal(wire.includes('sk-secret-value'), false, 'commentary is redacted');
  assert.equal(wire.includes('/secret/path'), false, 'tool input never leaves the host');
  assert.equal(wire.includes('file body'), false, 'tool output never leaves the host');
  const events = sent.flatMap((f) => f.payload.events);
  assert.ok(events.some((e) => e.kind === 'commentary' && e.text.includes('[已隐藏]')));
  assert.ok(events.some((e) => e.kind === 'tool' && e.category === 'read' && e.tool === 'Read'));
  assert.ok(events.some((e) => e.kind === 'tool' && e.category === 'reply'));
  assert.match(activity.statsLine(), /frames_sent=\d+/);
  assert.match(activity.statsLine(), /runs_closed=\{done:1\}/);
  assert.match(activity.statsLine(), /run_reply_form=\{text:1\}/);
  assert.deepEqual(warns, []);
  activity.stop();
});

test('restart recovery: an open run from the previous process ends failed / runtime_restarted once the org connects', () => {
  const { activity, sent, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":1}');
  activity.stop();
  const before = sent.length;

  const ws2Sent = [];
  const again = createActivity({ config: { activity: { enabled: true } }, env: {}, runsDir, homeDir: os.tmpdir(), zylosDir: os.tmpdir(), runtime: 'claude' });
  again.start();
  again.bindOrgWs(ORG, { trySend: (f) => { ws2Sent.push(f); return true; } });
  again.onWsOpen(ORG);
  again.stop();
  assert.equal(sent.length, before);
  assert.equal(ws2Sent.length, 1);
  assert.equal(ws2Sent[0].payload.state, 'failed');
  assert.equal(ws2Sent[0].payload.reason, 'runtime_restarted');
  assert.equal(ws2Sent[0].payload.sequence, 2, 'sequence continues from the run file');
});

test('dropRun: C4 refused the message → no frame, no files', () => {
  const { activity, sent, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.dropRun(reg.runId);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(path.join(runsDir, `${reg.runId}.json`)), false);
});
