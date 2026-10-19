/**
 * End to end on one host: inbound message → registerRun / marker → C4 accepted
 * → runtime log lines (fake Claude JSONL) → collector → attribution → frames
 * over a fake WsClient → send.js-side agent_run from the same run files.
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
import {
  validateActivityFrame, classifyAgentRun, validateAgentRunV3, validateFrameV3,
} from './testdata/validators.js';

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

test('inbound → queued → thinking → tool → done frames, and the reply agent_run', async () => {
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
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'git -C /secret/repo log -1', description: '查看 /secret/repo 最近一次提交' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'commit abc' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'` } }] } });
  activity.pollNow();

  // The reply (send.js) reads the same run files.
  const store = createRunStore({ dir: runsDir });
  assert.equal(store.readActive().gate[ORG], 'open');
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'c_k', now: clock.now(), store });
  const ar = plan.firstAgentRun;
  assert.equal(classifyAgentRun({ raw: ar }).verdict, 'ok');
  assert.equal(ar.schema_version, 3);
  assert.deepEqual(validateAgentRunV3(ar), []);
  assert.deepEqual(ar.steps.map((s) => s.kind), ['thinking', 'tool', 'tool'], 'no reply step');
  assert.deepEqual(ar.steps.slice(1).map((s) => s.category), ['read', 'command']);
  assert.equal(ar.steps[1].object, 'pricing.md', 'the file name is shown (D3), never the path');
  assert.equal(ar.steps[1].detail, undefined, 'Read has no expandable body');
  assert.deepEqual(ar.steps[2].detail, { type: 'output', lines: 1, truncated: false }, 'line count only, never the output');
  assert.equal(ar.steps[2].title, '查看 /secret/repo 最近一次提交', 'the Bash description is the step title');
  assert.equal(ar.step_count, 2);
  assert.ok(ar.exec_started_at >= ar.queued_at);
  plan.settle('ok');

  clock.advance(600);
  activity.emitter.tick();
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 3000 });
  activity.pollNow();

  const states = sent.map((f) => f.payload.state);
  assert.equal(states[0], 'queued');
  assert.ok(states.includes('thinking'));
  assert.equal(states.includes('tool'), false, 'v3: no per-tool state');
  assert.equal(states.at(-1), 'done');
  const seqs = sent.map((f) => f.payload.sequence);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  for (const f of sent) {
    const r = validateActivityFrame(JSON.stringify(f), clock.now());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(f.payload.schema_version, 3);
    assert.deepEqual(validateFrameV3(f.payload), []);
  }
  assert.equal(sent.at(-1).payload.step_count, 2);
  assert.ok(sent.at(-1).payload.exec_started_at >= sent.at(-1).payload.started_at);
  const wire = JSON.stringify(sent);
  assert.equal(wire.includes('sk-secret-value'), false, 'commentary is redacted');
  assert.equal(wire.includes('git -C'), false, 'command text never leaves the host');
  assert.equal(wire.includes('file body'), false, 'tool output never leaves the host');
  assert.equal(wire.includes('commit abc'), false, 'command output never leaves the host');
  assert.equal(wire.includes('/secret/path'), false, 'paths of tool inputs never leave the host');
  const steps = sent.flatMap((f) => f.payload.steps);
  assert.ok(steps.some((e) => e.kind === 'thinking' && e.body.includes('[已隐藏]')));
  assert.ok(steps.some((e) => e.kind === 'tool' && e.category === 'read'));
  assert.equal(steps.some((e) => e.category === 'reply'), false, 'the reply send is not a step');
  // v3: the Bash description is the step title on live frames too.
  const cmd = steps.filter((e) => e.kind === 'tool' && e.category === 'command').at(-1);
  assert.equal(cmd.title, '查看 /secret/repo 最近一次提交');
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
  assert.equal(ws2Sent[0].payload.end_reason, 'runtime_restarted');
  assert.equal('reason' in ws2Sent[0].payload, false);
  assert.equal(ws2Sent[0].payload.sequence, 2, 'sequence continues from the run file');
});

test('dropRun: C4 refused the message → no frame, no files', () => {
  const { activity, sent, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.dropRun(reg.runId);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(path.join(runsDir, `${reg.runId}.json`)), false);
});

test('codex: an external send inside the exec wrapper keeps later commentary out of frames and the agent_run summary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-codex-'));
  const rollout = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(rollout, '');
  const runsDir = path.join(home, 'runs');
  let t = Date.now();
  const sent = [];
  const activity = createActivity({
    config: { activity: { enabled: true } }, env: {}, now: () => t, runsDir, homeDir: home, zylosDir: home,
    runtime: 'codex', codexQuery: async () => [rollout],
  });
  activity.bindOrgWs(ORG, { trySend: (f) => { sent.push(JSON.parse(JSON.stringify(f))); return true; } });
  activity.onWsOpen(ORG);
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '1', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":5}');
  await activity.collector.discover();
  activity.pollNow();
  const line = (type, payload) => fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date(t).toISOString(), type, payload })}\n`);
  const body = `${reg.marker}[OPENMAX DM]\n<message-context conversation-id="${CONV}" source-message-id="1"/>\nhi ---- reply via: node /x/c4-send.js "openmax" "${CONV}"`;
  line('event_msg', { type: 'task_started', turn_id: 't1' });
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] });
  line('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'openmax step' }] });
  line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'w1', input: 'await tools.exec_command({ cmd: "node /x/c4-send.js \\"telegram\\" \\"42\\" hi" });' });
  line('response_item', { type: 'custom_tool_call_output', call_id: 'w1', output: 'ok' });
  line('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'telegram session step' }] });
  activity.pollNow();
  t += 2600;
  activity.emitter.tick();
  t += 600;
  activity.emitter.tick();

  const wire = JSON.stringify(sent);
  assert.ok(wire.includes('openmax step'));
  assert.equal(wire.includes('telegram session step'), false);
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'k', now: t, store: createRunStore({ dir: runsDir }) });
  const texts = plan.firstAgentRun.steps.filter((s) => s.kind === 'thinking').map((s) => s.body);
  assert.deepEqual(texts, ['openmax step']);
  activity.stop();
});

test('regression: a card sent via comm.ask_card answers the run; the next run (card receipt) gets the next c4-send reply', async () => {
  const { activity, clock, sent, append, runsDir } = setup();
  await activity.collector.discover();
  const store = createRunStore({ dir: runsDir });
  const bodyFor = (reg, text, src) => `${reg.marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="${src}"/>\n<current-message>\n${text}\n</current-message> ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}"`;

  // 1. The user's message → run A; the agent answers it with a card through the comm CLI.
  const a = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '101', endpoint: CONV });
  activity.confirmRun(a.runId, '{"ok":true,"id":51}');
  clock.advance(100);
  append({ type: 'user', message: { role: 'user', content: bodyFor(a, 'Alice said: 帮我升级', '101') } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: `cd ~/zylos/.claude/skills/openmax && node src/cli/comm.js comm.ask_card '{"conversationId":"${CONV}","kind":"upgrade","askedOf":"m-1","title":"升级?","text":"x","options":["是","否"]}'`, description: '发送确认卡片' } }] } });
  activity.pollNow();
  const runA = activity.attribution.getRun(a.runId);
  assert.equal(runA.state, 'replied', 'the comm CLI card counts as the reply');
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: '{"recorded":true}' }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
  activity.pollNow();
  assert.equal(runA.state, 'closed');
  assert.equal(runA._terminalState, 'done');
  assert.equal(runA.reason, null);
  const aFrames = sent.filter((f) => f.payload.run_id === a.runId);
  assert.equal(aFrames.at(-1).payload.state, 'done', 'the live block of run A ends');

  // 2. The card receipt arrives → run B; the agent replies with c4-send.
  clock.advance(30_000);
  activity.emitter.tick();          // the probe is confirmed: summaries open
  const b = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '102', endpoint: CONV });
  activity.confirmRun(b.runId, '{"ok":true,"id":52}');
  append({ type: 'user', message: { role: 'user', content: bodyFor(b, 'Alice clicked: 是', '102') } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'\n好的,开始升级\nEOF` } }] } });
  activity.pollNow();
  // send.js, run at the same moment, picks run B — never the closed run A.
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'c_b', now: clock.now(), store });
  assert.equal(plan.runId, b.runId);
  assert.equal(plan.firstAgentRun.run_id, b.runId);
  plan.settle('ok');
  const runB = activity.attribution.getRun(b.runId);
  assert.equal(runB.state, 'replied');
  assert.equal(runA.state, 'closed');
  assert.equal(runB.events.some((e) => e.kind === 'tool' && e.category === 'reply'), false, 'reply sends are not steps');
  assert.equal(runA.events.filter((e) => e.category === 'reply').length, 0);
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'ok' }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
  activity.pollNow();
  assert.equal(runB.state, 'closed');
  assert.equal(sent.filter((f) => f.payload.run_id === b.runId).at(-1).payload.state, 'done');
  assert.match(activity.statsLine(), /runs_closed=\{done:2\}/);
  assert.match(activity.statsLine(), /replied_via=\{log:2\}/);
  activity.stop();
});

test('a run no runtime turn ever picks up ends done / no_reply after 5 min, with its terminal frame', () => {
  const { activity, clock, sent } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":9}');
  clock.advance(4 * 60_000);
  activity.pollNow();
  assert.equal(activity.attribution.getRun(reg.runId).state, 'queued');
  clock.advance(60_000);
  activity.pollNow();
  const last = sent.filter((f) => f.payload.run_id === reg.runId).at(-1).payload;
  assert.equal(last.state, 'done');
  assert.equal(last.end_reason, 'no_reply');
  assert.equal('exec_started_at' in last, false, 'never started');
  assert.equal(activity.attribution.openRuns().length, 0);
  activity.stop();
});
