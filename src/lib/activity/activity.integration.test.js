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
import { planReplyMetadata, selectRun } from './reply.js';
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

test('plugin restart recovery (OPENM-1108): an open run from the previous process ends done, without an end reason, once the org connects', () => {
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
  assert.equal(ws2Sent[0].payload.state, 'done', 'a plugin restart is not a failure');
  assert.equal('end_reason' in ws2Sent[0].payload, false, 'never runtime_restarted (that is the agent runtime)');
  assert.equal('reason' in ws2Sent[0].payload, false);
  assert.equal(ws2Sent[0].payload.sequence, 2, 'sequence continues from the run file');
  const file = createRunStore({ dir: runsDir }).readRun(reg.runId);
  assert.equal(file.state, 'closed');
  assert.equal(file.reason, null);
});

test('plugin restart recovery (OPENM-1108): a running step is ended ok on the terminal frame and in the run file', async () => {
  const { activity, clock, sent, append, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":1}');
  await activity.collector.discover();
  const body = `${reg.marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="7383920118271"/>\n<current-message>\nAlice said: hi\n</current-message> ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}"`;
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: body } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/a.md' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'zylos upgrade openmax', description: '升级 openmax' } }] } });
  activity.pollNow();
  clock.advance(600);
  activity.emitter.tick();
  const liveSteps = sent.flatMap((f) => f.payload.steps);
  assert.ok(liveSteps.some((s) => s.kind === 'tool' && s.category === 'command' && s.status === 'running'), 'the FE saw the step running');
  activity.stop();

  // The plugin restarts mid-step (the agent session goes on).
  clock.advance(5_000);
  const ws2Sent = [];
  const again = createActivity({ config: { activity: { enabled: true } }, env: {}, now: clock.now, runsDir, homeDir: os.tmpdir(), zylosDir: os.tmpdir(), runtime: 'claude' });
  again.start();
  again.bindOrgWs(ORG, { trySend: (f) => { ws2Sent.push(JSON.parse(JSON.stringify(f))); return true; } });
  again.onWsOpen(ORG);
  again.stop();

  assert.equal(ws2Sent.length, 2, 'a step-less probe, then the terminal frame carrying the ended step');
  assert.equal(ws2Sent[0].payload.state, 'thinking');
  assert.deepEqual(ws2Sent[0].payload.steps, []);
  const last = ws2Sent[1].payload;
  assert.equal(last.state, 'done');
  assert.equal('end_reason' in last, false);
  assert.deepEqual(validateFrameV3(last), []);
  const ended = last.steps.find((s) => s.kind === 'tool' && s.category === 'command');
  assert.equal(ended.status, 'ok', 'no step the FE would show as interrupted');
  assert.equal(ended.ended_at, clock.now());
  assert.equal(ended.wait_for, undefined);
  assert.deepEqual(ws2Sent.map((f) => f.payload.sequence), [...ws2Sent.map((f) => f.payload.sequence)].sort((a, b) => a - b));

  const file = createRunStore({ dir: runsDir }).readRun(reg.runId);
  assert.equal(file.state, 'closed');
  assert.equal(file.reason, null);
  assert.equal(file.ended_at, clock.now());
  const tools = file.events.filter((e) => e.kind === 'tool');
  assert.ok(tools.length >= 2);
  assert.ok(tools.every((e) => e.ended_at != null && e.error !== true), 'every tool step in the run file is ended');
});

test('plugin restart recovery (OPENM-1108): a run that went status-only after its step was seen running still ends the step in the run file', async () => {
  const { activity, clock, sent, append, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":1}');
  await activity.collector.discover();
  const body = `${reg.marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="7383920118271"/>\n<current-message>\nAlice said: hi\n</current-message> ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}"`;
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: body } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'zylos upgrade openmax', description: '升级 openmax' } }] } });
  activity.pollNow();
  clock.advance(600);
  activity.emitter.tick();
  assert.ok(sent.flatMap((f) => f.payload.steps).some((s) => s.kind === 'tool' && s.category === 'command' && s.status === 'running'), 'the FE saw the step running');
  // The collector falls back to status-only; the flag is saved with the run.
  activity.attribution.degradeAll();
  const run = activity.attribution.getRun(reg.runId);
  assert.equal(run.status_only, true);
  const store = createRunStore({ dir: runsDir });
  store.writeRun(run);
  activity.stop();
  assert.equal(store.readRun(reg.runId).status_only, true);

  clock.advance(5_000);
  const ws2Sent = [];
  const again = createActivity({ config: { activity: { enabled: true } }, env: {}, now: clock.now, runsDir, homeDir: os.tmpdir(), zylosDir: os.tmpdir(), runtime: 'claude' });
  again.start();
  again.bindOrgWs(ORG, { trySend: (f) => { ws2Sent.push(JSON.parse(JSON.stringify(f))); return true; } });
  again.onWsOpen(ORG);
  again.stop();

  const last = ws2Sent.at(-1).payload;
  assert.equal(last.state, 'done');
  assert.equal('end_reason' in last, false);
  assert.deepEqual(validateFrameV3(last), []);
  assert.equal(ws2Sent.flatMap((f) => f.payload.steps || []).some((s) => s.status === 'running' || s.wait_for), false, 'no running step on the wire');
  const file = store.readRun(reg.runId);
  assert.equal(file.state, 'closed');
  assert.equal(file.reason, null);
  const tools = file.events.filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].ended_at, clock.now(), 'the step is ended in the run file, not left running');
  assert.equal(tools[0].error, false);
});

test('plugin restart recovery: a run file older than the retention closes without runtime_restarted, its steps ended', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-act-old-'));
  const runsDir = path.join(home, 'runs');
  const store = createRunStore({ dir: runsDir });
  const t = Date.now();
  const old = {
    v: 1, run_id: 'r_0000abcd', org_id: ORG, conversation_id: CONV, reply_conversation_id: CONV, endpoint: CONV,
    created_at: t - 25 * 60 * 60 * 1000, state: 'active', seq: 3, next_event: 2, dropped: 0, reason: null,
    events: [{ id: 'e1', kind: 'tool', category: 'command', at: t - 25 * 60 * 60 * 1000 + 10 }],
  };
  store.writeRun(old);
  const ws2Sent = [];
  const again = createActivity({ config: { activity: { enabled: true } }, env: {}, now: () => t, runsDir, homeDir: home, zylosDir: home, runtime: 'claude' });
  again.start();
  const after = store.readRun(old.run_id);
  assert.equal(after.state, 'closed');
  assert.equal(after.reason, null, 'not runtime_restarted');
  assert.ok(after.events.every((e) => e.ended_at != null && e.error === false));
  again.bindOrgWs(ORG, { trySend: (f) => { ws2Sent.push(f); return true; } });
  again.onWsOpen(ORG);
  again.stop();
  assert.equal(ws2Sent.length, 0, 'a stale run sends nothing');
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

test('review P2: a short numeric credential never reaches the run files, the agent_run summary or live frames', async () => {
  const { activity, clock, sent, append, runsDir, warns } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118272', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"action":"queued","id":43}\n');
  await activity.collector.discover();
  const body = `${reg.marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="7383920118272"/>\n<current-message>\nAlice said: 登录一下\n</current-message> ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}"`;
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: body } });
  // thinking / title / object / diff preview, each with a 1–5 digit credential.
  append({ type: 'assistant', message: { content: [{ type: 'text', text: '用 DB_PASSWORD=4821 登录测试库' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_n1', name: 'Bash', input: { command: 'psql -c "select 1"', description: '用 token=73 连接数据库' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_n1', content: '1' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_n2', name: 'Grep', input: { pattern: 'api_key: 90210', path: '/w' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_n2', content: 'none' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_n3', name: 'Write', input: { file_path: '/w/.env', content: 'PORT=3000\nSECRET=31337\n' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_n3', content: 'ok' }] } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_n4', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'` } }] } });
  activity.pollNow();

  const leaks = ['DB_PASSWORD=4821', 'token=73', 'api_key: 90210', 'SECRET=31337'];
  const assertClean = (text, where) => {
    for (const s of leaks) assert.equal(text.includes(s), false, `${where}: ${s}`);
    assert.ok(text.includes('[已隐藏]'), `${where}: redacted placeholder present`);
  };

  // 1. Storage: every run file holds only the redacted values.
  const files = fs.readdirSync(runsDir, { recursive: true }).map((f) => path.join(runsDir, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.length > 0);
  assertClean(files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'), 'run files');

  // 2. The agent_run summary (send.js side, read from the same run files).
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'x', newKey: () => 'c_n', now: clock.now(), store: createRunStore({ dir: runsDir }) });
  const ar = plan.firstAgentRun;
  assert.deepEqual(validateAgentRunV3(ar), []);
  assertClean(JSON.stringify(ar), 'summary');
  const steps = ar.steps;
  assert.equal(steps.find((s) => s.kind === 'thinking').body, '用 DB_PASSWORD=[已隐藏] 登录测试库');
  assert.equal(steps.find((s) => s.category === 'command').title, '用 token=[已隐藏] 连接数据库');
  assert.equal(steps.find((s) => s.category === 'search_files').object, 'api_key: [已隐藏]');
  assert.equal(steps.find((s) => s.detail?.type === 'diff').detail.preview, 'PORT=3000\nSECRET=[已隐藏]\n', 'non-secret numbers stay');
  plan.settle('ok');

  // 3. Live frames.
  clock.advance(600);
  activity.emitter.tick();
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_n4', content: 'ok' }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 3000 });
  activity.pollNow();
  assert.equal(sent.at(-1).payload.state, 'done');
  for (const f of sent) assert.deepEqual(validateFrameV3(f.payload), []);
  assertClean(JSON.stringify(sent), 'live frames');
  assert.deepEqual(warns, []);
  activity.stop();
});

// ── 10-22 ──

const RV = (ch, ep) => ` ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "${ch}" "${ep}"`;
const omMsg = (marker) => `${marker}[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${CONV}" source-message-id="7383920118271"/>\n<current-message>\nAlice said: 报价对一下\n</current-message>${RV('openmax', CONV)}`;
const larkMsg = `[Lark DM]\n<current-message>\nBob said: 在吗\n</current-message>${RV('lark', 'oc_96|type:p2p|msg:om_1')}`;
const states = (sent, runId) => sent.filter((f) => f.payload.run_id === runId).map((f) => f.payload.state);

test('10-22 terminal state: done goes out when the reply is delivered, not at turn end; later replies of the turn still get the reference', async () => {
  const { activity, clock, sent, append, runsDir, warns } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":42}\n');
  await activity.collector.discover();
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: omMsg(reg.marker) } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'price' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();                              // gate open

  // send.js: claim pending → POST 2xx → delivered.
  const store = createRunStore({ dir: runsDir });
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  assert.equal(plan.firstAgentRun.state, 'done');
  activity.pollNow();
  assert.notEqual(states(sent, reg.runId).at(-1), 'done', 'pending claim: not done yet');
  plan.settle('ok');
  clock.advance(700);
  activity.pollNow();                                   // ≤ one poll after the 2xx
  assert.equal(states(sent, reg.runId).at(-1), 'done', 'done right after the reply, before the turn ends');
  const doneFrame = sent.at(-1);
  assert.equal(doneFrame.payload.ended_at, clock.now());
  assert.equal(store.readRun(reg.runId).state, 'closed');

  // Another reply in the same turn (e.g. a follow-up): reference form.
  const plan2 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store });
  assert.deepEqual(plan2.firstAgentRun, { schema_version: 3, run_id: reg.runId, ref: true });

  // The turn keeps going for 20 s (memory work) and ends: no frame regresses the run.
  // OPENM-1089 ①: that visible step opens a continuation run (its own run_id),
  // which the turn end closes done (no no_reply: the parent was answered).
  const n = states(sent, reg.runId).length;
  clock.advance(20_000);
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Edit', input: { file_path: '/m/state.md', old_string: 'a', new_string: 'b' } }] } });
  append({ type: 'system', subtype: 'turn_duration', durationMs: 23000 });
  activity.pollNow();
  activity.emitter.tick();
  clock.advance(200_000);
  activity.pollNow();
  activity.emitter.tick();
  assert.equal(states(sent, reg.runId).length, n, 'no frame for the run after its terminal frame');
  const cont = sent.find((f) => f.payload.run_id !== reg.runId)?.payload;
  assert.equal(cont.source_message_id, '7383920118271', 'continuation of the same source message');
  assert.equal(states(sent, cont.run_id).at(-1), 'done');
  assert.equal(sent.at(-1).payload.end_reason, undefined);
  assert.equal(store.readRun(cont.run_id).continues, reg.runId);
  assert.equal(store.readActive().by_conversation[CONV], undefined, 'turn ended: no longer listed');
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h3', newKey: () => 'c_3', now: clock.now(), store }), null);
  assert.match(activity.statsLine(), /runs_closed=\{done:2\}/);
  assert.match(activity.statsLine(), /continuations=1/);
  assert.deepEqual(warns, []);
  activity.stop();
});

test('10-22 terminal state, failure path: a rejected reply (claim released) and a failed send never complete the run', async () => {
  const { activity, clock, sent, append, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":42}\n');
  await activity.collector.discover();
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: omMsg(reg.marker) } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();
  const store = createRunStore({ dir: runsDir });
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_s', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'\nx\nEOF` } }] } });
  activity.pollNow();
  plan.settle('rejected');                              // 422: claim released
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'HTTP 422', is_error: true }] } });
  clock.advance(700);
  activity.pollNow();
  activity.emitter.tick();
  assert.equal(states(sent, reg.runId).includes('done'), false);
  assert.equal(activity.attribution.getRun(reg.runId).state, 'active', 'the failed send undid replied');
  append({ type: 'system', subtype: 'turn_duration', durationMs: 3000 });
  activity.pollNow();
  assert.equal(states(sent, reg.runId).includes('done'), false, 'turn end alone does not complete an unanswered run');
  clock.advance(121_000);
  activity.pollNow();
  assert.equal(states(sent, reg.runId).at(-1), 'done');
  assert.equal(sent.at(-1).payload.end_reason, 'no_reply');
  activity.stop();
});

test('10-22 merged input (Lark first, then openmax — the INT 10-21 case): the run gets its steps, not Lark\'s, and ends on its reply', async () => {
  const { activity, clock, sent, append, runsDir } = setup();
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":42}\n');
  await activity.collector.discover();
  clock.advance(200);
  append({ type: 'user', message: { role: 'user', content: larkMsg + omMsg(reg.marker) } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'l1', name: 'WebFetch', input: { url: 'https://lark.example/doc', prompt: 'p' } }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'l2', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "oc_96|type:p2p|msg:om_1" <<'EOF'\nok\nEOF` } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'l2', content: 'sent' }] } });
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o1', name: 'Grep', input: { pattern: 'price' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'o1', content: 'x' }] } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();
  const run = activity.attribution.getRun(reg.runId);
  assert.equal(run.exec_started_at != null, true, 'the run entered the turn');
  assert.deepEqual(run.events.filter((e) => e.kind === 'tool').map((e) => e.category), ['search_files'], 'Lark\'s fetch / send are not the run\'s');
  const store = createRunStore({ dir: runsDir });
  const plan = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h', newKey: () => 'c', now: clock.now(), store });
  assert.equal(plan.firstAgentRun.step_count, 1);
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o2', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'\nx\nEOF` } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'o2', content: 'ok' }] } });
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, reg.runId).at(-1), 'done', 'done on the reply (log path), turn still running');
  assert.match(activity.statsLine(), /merged_inputs=1 closed_on_reply=\{log:1\} reply_failed=0/);
  activity.stop();
});

test('10-22 R2-1 (reviewer repro): merged Lark A + openmax B, A\'s reply fails — continued Lark work never enters B\'s frames; contrast: A\'s reply succeeds', async () => {
  for (const fail of [true, false]) {
    const { activity, clock, sent, append } = setup();
    const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, endpoint: CONV });
    activity.confirmRun(reg.runId, '{"ok":true,"id":42}\n');
    await activity.collector.discover();
    clock.advance(200);
    append({ type: 'user', message: { role: 'user', content: larkMsg + omMsg(reg.marker) } });
    activity.pollNow();
    clock.advance(2100);
    activity.emitter.tick();                            // gate open: steps go on the wire
    append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'l1', name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "oc_96|type:p2p|msg:om_1" <<'EOF'\nok\nEOF` } }] } });
    append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'l1', content: fail ? 'Error: lark 99991663' : 'sent', is_error: fail } ] } });
    append({ type: 'assistant', message: { content: [{ type: 'text', text: 'LARK-ONLY retry note' }] } });
    append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'l2', name: 'WebFetch', input: { url: 'https://lark-only.example/doc', prompt: 'p' } }] } });
    activity.pollNow();
    clock.advance(600);
    activity.emitter.tick();
    const wire = JSON.stringify(sent.filter((f) => f.payload.run_id === reg.runId));
    const run = activity.attribution.getRun(reg.runId);
    if (fail) {
      assert.equal(wire.includes('LARK-ONLY'), false, 'no Lark text in the openmax frames');
      assert.equal(wire.includes('lark-only.example'), false);
      assert.deepEqual(run.events.filter((e) => e.kind !== 'notice'), []);
    } else {
      assert.equal(wire.includes('LARK-ONLY'), true, 'after a successful Lark reply the queue moved on (disclosed limit)');
    }
    activity.stop();
  }
});

// ── OPENM-1089 ──

const bashSend = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}" <<'EOF'\nx\nEOF` } }] } });
const toolOk = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
/** An unregistered smart-mode message of the same group (no marker), server id `id`. */
const smartMsg = (id) => omMsg('').replace('source-message-id="7383920118271"', `source-message-id="${id}"`);
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

/** A run whose turn started and whose gate is open. */
async function startedRun(h) {
  const reg = h.activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  h.activity.confirmRun(reg.runId, '{"ok":true,"id":42}\n');
  await h.activity.collector.discover();
  h.clock.advance(200);
  h.append({ type: 'user', message: { role: 'user', content: omMsg(reg.marker) } });
  h.activity.pollNow();
  h.clock.advance(2100);
  h.activity.emitter.tick();                            // gate open
  return reg;
}

test('1089-① end to end: reply 1 delivered → later log steps open a continuation in active.json → the next reply carries its full agent_run', async () => {
  const h = setup();
  const { activity, clock, sent, append, runsDir, warns } = h;
  const reg = await startedRun(h);
  const store = createRunStore({ dir: runsDir });
  append(toolUse('toolu_1', 'Grep', { pattern: 'price' }));
  append(toolOk('toolu_1'));
  activity.pollNow();
  // Reply 1 ("收到，我来查"): claim → delivered.
  const p1 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  assert.equal(p1.firstAgentRun.run_id, reg.runId);
  p1.settle('ok');
  append(bashSend('toolu_s1'));
  append(toolOk('toolu_s1'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(store.readRun(reg.runId).state, 'closed');

  // The agent keeps working: a visible step opens r1′.
  clock.advance(1000);
  append(toolUse('toolu_2', 'Read', { file_path: '/data/quote.xlsx' }));
  append(toolOk('toolu_2'));
  activity.pollNow();
  const ids = store.readActive().by_conversation[CONV];
  const contId = ids.find((id) => id !== reg.runId);
  assert.ok(contId, 'the continuation is listed for send.js');
  const cont = store.readRun(contId);
  assert.equal(cont.continues, reg.runId);
  assert.equal(cont.segment, 2);
  assert.equal(cont.focus, true);
  assert.equal(cont.source_message_id, '7383920118271');
  clock.advance(600);
  activity.emitter.tick();
  const contFrames = sent.filter((f) => f.payload.run_id === contId);
  assert.ok(contFrames.length >= 1, 'live frames for the continuation');
  assert.equal(contFrames[0].payload.source_message_id, '7383920118271');
  assert.ok(contFrames.some((f) => f.payload.steps.some((s) => s.category === 'read')));
  for (const f of contFrames) assert.deepEqual(validateFrameV3(f.payload), []);

  // Reply 2 (the answer): send.js picks the focused continuation, full snapshot.
  const p2 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store });
  assert.equal(p2.runId, contId);
  assert.equal(p2.firstAgentRun.run_id, contId);
  assert.ok(p2.firstAgentRun.steps.some((s) => s.category === 'read'));
  assert.equal(classifyAgentRun({ raw: p2.firstAgentRun }).verdict, 'ok');
  p2.settle('ok');
  append(bashSend('toolu_s2'));
  append(toolOk('toolu_s2'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, contId).at(-1), 'done');
  assert.equal(store.readRun(contId).state, 'closed');
  assert.match(activity.statsLine(), /continuations=1/);
  assert.deepEqual(warns, []);
  activity.stop();
});

test('1089-① plugin restart with an open continuation → done without an end reason on ws open (OPENM-1108); the parent untouched', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await startedRun(h);
  const store = createRunStore({ dir: runsDir });
  const p1 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  p1.settle('ok');
  activity.pollNow();
  append(toolUse('toolu_2', 'Read', { file_path: '/x' }));
  activity.pollNow();
  const contId = store.listRunIds().find((id) => id !== reg.runId);
  assert.ok(contId);
  clock.advance(600);
  activity.emitter.tick();
  const contTools = store.readRun(contId).events.filter((e) => e.kind === 'tool');
  assert.ok(contTools.length >= 1 && contTools.some((e) => e.ended_at == null), 'the continuation run file holds a running tool step before the restart');
  activity.stop();
  const parentBefore = JSON.stringify(store.readRun(reg.runId));

  const ws2Sent = [];
  const again = createActivity({ config: { activity: { enabled: true } }, env: {}, runsDir, homeDir: os.tmpdir(), zylosDir: os.tmpdir(), runtime: 'claude' });
  again.start();
  again.bindOrgWs(ORG, { trySend: (f) => { ws2Sent.push(f); return true; } });
  again.onWsOpen(ORG);
  again.stop();
  const terminal = ws2Sent.filter((f) => f.payload.state === 'done' || f.payload.state === 'failed');
  assert.deepEqual(terminal.map((f) => [f.payload.run_id, f.payload.state, 'end_reason' in f.payload]), [[contId, 'done', false]], 'a plugin restart is not a failure (OPENM-1108)');
  assert.equal(ws2Sent.every((f) => f.payload.run_id === contId), true);
  assert.equal(ws2Sent.flatMap((f) => f.payload.steps || []).some((s) => s.status === 'running' || s.wait_for), false, 'no running step on the wire');
  assert.ok(terminal[0].payload.steps.some((s) => s.kind === 'tool' && s.status === 'ok'), 'the done frame carries the step, ended ok');
  const contFile = store.readRun(contId);
  assert.equal(contFile.state, 'closed');
  assert.equal(contFile.reason, null);
  const contFileTools = contFile.events.filter((e) => e.kind === 'tool');
  assert.ok(contFileTools.length >= 1);
  assert.ok(contFileTools.every((e) => e.ended_at != null && e.error !== true), 'the continuation\'s steps are ended');
  assert.equal(JSON.stringify(store.readRun(reg.runId)), parentBefore);
});

test('1089-② end to end: guard skip writes the skip file → the log reply settles → unregistered cleared → the next reply selects the run', async () => {
  const h = setup();
  const { activity, clock, sent, append, runsDir } = h;
  const reg = await startedRun(h);
  const store = createRunStore({ dir: runsDir });
  // A smart-mode (not @) message of the same group arrives and is absorbed mid-turn.
  clock.advance(100);
  activity.noteUnregisteredInput(CONV, '9000000000001');
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000001') } });
  activity.pollNow();
  assert.ok(store.readActive().unregistered[CONV]);
  assert.equal(store.readRun(reg.runId).focus, false);

  // The agent answers the smart message first: send.js skips (no claim, no agent_run).
  const p1 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  assert.equal(p1, null);
  assert.equal(store.readSkip(reg.runId).at, clock.now());
  append(bashSend('toolu_s1'));
  append(toolOk('toolu_s1'));
  clock.advance(700);
  activity.pollNow();
  const r = store.readRun(reg.runId);
  assert.equal(r.state, 'active', 'not done: that reply was not the run\'s');
  assert.equal(r.ambiguous_reply, true);
  assert.equal(r.focus, true);
  assert.equal(store.readActive().unregistered?.[CONV], undefined, 'guard lifted');
  assert.equal(states(sent, reg.runId).includes('done'), false);

  // Then the @ message: the run with its full agent_run, done on delivery.
  const p2 = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store });
  assert.equal(p2.runId, reg.runId);
  assert.ok(Array.isArray(p2.firstAgentRun.steps));
  p2.settle('ok');
  append(bashSend('toolu_s2'));
  append(toolOk('toolu_s2'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, reg.runId).at(-1), 'done');
  assert.equal(sent.filter((f) => f.payload.run_id === reg.runId).at(-1).payload.end_reason, undefined);
  assert.match(activity.statsLine(), /reply_deferred_unregistered=1/);
  activity.stop();
});

/** A started run plus a smart-mode message of the same group absorbed mid-turn. */
async function guardedRun(h) {
  const reg = await startedRun(h);
  h.clock.advance(100);
  h.activity.noteUnregisteredInput(CONV, '9000000000001');
  h.append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000001') } });
  h.activity.pollNow();
  return reg;
}

test('1089-② review: a newer smart message arriving while the skipped send is in flight keeps the guard; the next reply does not claim the run', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await guardedRun(h);
  const store = createRunStore({ dir: runsDir });
  const unregA = store.readActive().unregistered[CONV];
  append(bashSend('toolu_s1'));
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null);
  assert.equal(store.readSkip(reg.runId).unreg, unregA);
  // Smart B arrives (bridge + log) before the send's result is collected.
  clock.advance(300);
  activity.noteUnregisteredInput(CONV, '9000000000002');
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000002') } });
  clock.advance(200);
  append(toolOk('toolu_s1'));
  activity.pollNow();
  const unregB = store.readActive().unregistered?.[CONV];
  assert.ok(unregB > unregA, 'the guard for B stays');
  const r = store.readRun(reg.runId);
  assert.equal(r.state, 'active');
  assert.equal(r.ambiguous_reply, true);
  assert.equal(r.focus, false, 'B is pending: no focus');
  // The answer to B is skipped again — it never claims the run.
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store }), null);
  assert.equal(store.claimExists(reg.runId), false);
  activity.stop();
});

test('1089-② review: the send record collected late (log backlog) still honours the skip — the window is the records\' own timestamps', async () => {
  const h = setup();
  const { activity, clock, sent, append, runsDir } = h;
  const reg = await guardedRun(h);
  const store = createRunStore({ dir: runsDir });
  append(bashSend('toolu_s1'));
  clock.advance(50);
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null);
  clock.advance(400);
  append(toolOk('toolu_s1'));
  clock.advance(30_000);                                // read 30 s later
  activity.pollNow();
  const r = store.readRun(reg.runId);
  assert.equal(r.state, 'active', 'deferred, not closed');
  assert.equal(r.ambiguous_reply, true);
  assert.equal(states(sent, reg.runId).includes('done'), false);
  activity.stop();
});

test('1089-② review: a skip file older than the send call (an earlier skipped send) is not this send\'s — the run completes', async () => {
  const h = setup();
  const { activity, clock, sent, append, runsDir } = h;
  const reg = await guardedRun(h);
  const store = createRunStore({ dir: runsDir });
  store.writeSkip(reg.runId, { at: clock.now() - 10_000, unreg: 1 });
  append(bashSend('toolu_s1'));
  append(toolOk('toolu_s1'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, reg.runId).at(-1), 'done');
  assert.equal(store.readRun(reg.runId).ambiguous_reply, undefined);
  activity.stop();
});

test('1089-② review R2: B arrives after the send call started but BEFORE send.js plans (guard already B) → B stays pending, the guard stays, the next send does not claim the run', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await guardedRun(h);                      // smart A
  const store = createRunStore({ dir: runsDir });
  clock.advance(100);
  append(bashSend('toolu_s1'));                         // the agent's answer to A starts
  clock.advance(100);
  activity.noteUnregisteredInput(CONV, '9000000000002');                 // smart B reaches the bridge …
  activity.pollNow();
  const unregB = store.readActive().unregistered[CONV];
  // … while send.js is still preparing: it plans now and records B's guard.
  clock.advance(100);
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null);
  assert.equal(store.readSkip(reg.runId).unreg, unregB);
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000002') } });
  clock.advance(200);
  append(toolOk('toolu_s1'));
  activity.pollNow();
  const r = store.readRun(reg.runId);
  assert.equal(r.state, 'active');
  assert.equal(r.ambiguous_reply, true);
  assert.equal(r.focus, false, 'B is pending: no focus');
  const q = activity.attribution.turn.queue.filter((it) => it.foreign);
  assert.deepEqual(q.map((it) => it.answered).sort(), [false, true], 'A answered, B pending');
  assert.equal(store.readActive().unregistered?.[CONV], unregB, 'the guard for B stays');
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store }), null);
  assert.equal(store.claimExists(reg.runId), false, 'the next send does not claim the run');
  activity.stop();
});

test('1089-② review R3: smart A reaches the runtime only after the skipped send settled → A keeps the guard; the next send does not claim the run', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await startedRun(h);
  const store = createRunStore({ dir: runsDir });
  // A Lark message in front: the run has no focus.
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: larkMsg } });
  activity.pollNow();
  clock.advance(100);
  activity.noteUnregisteredInput(CONV, '9000000000001');                 // smart A at the bridge, still on its way to C4
  const unregA = store.readActive().unregistered[CONV];
  clock.advance(100);
  append(bashSend('toolu_s1'));
  clock.advance(50);
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null);
  clock.advance(200);
  append(toolOk('toolu_s1'));
  activity.pollNow();
  assert.equal(store.readActive().unregistered?.[CONV], unregA, 'nothing acknowledged: the guard stays');
  // A is delivered to the runtime only now.
  clock.advance(500);
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000001') } });
  activity.pollNow();
  const smart = activity.attribution.turn.queue.find((it) => it.foreign && it.reply?.channel === 'openmax');
  assert.equal(smart.answered, false, 'A is pending');
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store }), null);
  assert.equal(store.claimExists(reg.runId), false, 'the next send does not claim the run');
  activity.stop();
});

test('1089-② review R4: smart A arrives before any run, the run is injected, B reaches the bridge but is delivered after the settlement → acking A never consumes B; B keeps the guard and the next send does not claim the run', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const store = createRunStore({ dir: runsDir });
  await activity.collector.discover();
  // Smart A with no run open: recorded by id, no guard yet; the runtime takes it.
  activity.noteUnregisteredInput(CONV, '9000000000001');
  clock.advance(100);
  append({ type: 'user', message: { role: 'user', content: smartMsg('9000000000001') } });
  // The @ message of the same group registers a run and is injected into the turn.
  clock.advance(100);
  const reg = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: '7383920118271', endpoint: CONV });
  activity.confirmRun(reg.runId, '{"ok":true,"id":43}\n');
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: omMsg(reg.marker) } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();                              // gate open
  assert.equal(store.readRun(reg.runId).focus, false, 'A is in front');
  // Smart B reaches the bridge (guard = B) but not yet the runtime.
  clock.advance(100);
  activity.noteUnregisteredInput(CONV, '9000000000002');
  const unregB = store.readActive().unregistered[CONV];
  assert.ok(unregB);
  // The agent answers A; send.js skips because of B's guard.
  clock.advance(100);
  append(bashSend('toolu_s1'));
  clock.advance(50);
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null);
  clock.advance(200);
  append(toolOk('toolu_s1'));
  activity.pollNow();
  assert.equal(store.readActive().unregistered?.[CONV], unregB, 'A acknowledged by id; B\'s record and guard stay');
  // B is delivered only now.
  clock.advance(500);
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000002') } });
  activity.pollNow();
  const items = activity.attribution.turn.queue.filter((it) => it.foreign);
  assert.deepEqual(items.map((it) => [it.msgId, it.answered]), [['9000000000002', false], ['9000000000001', true]]);
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store }), null);
  assert.equal(store.claimExists(reg.runId), false, 'the next send does not claim the run');
  activity.stop();
});

for (const [total, lifted] of [[50, true], [51, false]]) {
  test(`1089-② review R5: a burst of ${total} smart messages (cap 50), the oldest delivered last → ${lifted ? 'all recorded: the guard lifts once all are answered' : 'one evicted: the guard stays and the next send does not claim the run'}`, async () => {
    const h = setup();
    const { activity, clock, append, runsDir } = h;
    const reg = await startedRun(h);
    const store = createRunStore({ dir: runsDir });
    append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: larkMsg } });
    activity.pollNow();                                 // no focus for the run
    const ids = Array.from({ length: total }, (_, i) => String(9100000000000 + i));
    for (const id of ids) {
      clock.advance(10);
      activity.noteUnregisteredInput(CONV, id);
    }
    // All but the oldest reach the runtime and are answered one by one (each skipped by the guard).
    for (const id of ids.slice(1)) {
      clock.advance(10);
      append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg(id) } });
    }
    activity.pollNow();
    for (let i = 1; i < total; i++) {
      clock.advance(10);
      append(bashSend(`toolu_b${i}`));
      assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: `b${i}`, newKey: () => `c_b${i}`, now: clock.now(), store }), null);
      clock.advance(10);
      append(toolOk(`toolu_b${i}`));
      activity.pollNow();
    }
    // The oldest is answered (acknowledged by id) only after it is delivered.
    clock.advance(10);
    append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg(ids[0]) } });
    activity.pollNow();
    const pendingOldest = activity.attribution.turn.queue.find((it) => it.msgId === ids[0]);
    assert.equal(pendingOldest.answered, false);
    if (!lifted) {
      assert.ok(store.readActive().unregistered?.[CONV], 'the guard stays: a record was evicted unanswered');
      assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'n', newKey: () => 'c_n', now: clock.now(), store }), null);
      assert.equal(store.claimExists(reg.runId), false, 'the next send does not claim the run');
    } else {
      assert.ok(store.readActive().unregistered?.[CONV], 'the oldest is still outstanding');
      append(bashSend('toolu_a'));
      assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'a', newKey: () => 'c_a', now: clock.now(), store }), null);
      clock.advance(10);
      append(toolOk('toolu_a'));
      activity.pollNow();
      assert.equal(store.readActive().unregistered?.[CONV], undefined, 'every recorded message answered: guard lifted');
      assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'n', newKey: () => 'c_n', now: clock.now(), store }).runId, reg.runId);
    }
    activity.stop();
  });
}

// ── OPENM-1337: two @s merged into one turn, each answered via its own reply via ──

test('1337 end to end: A and B merged, the agent reads B first — A\'s reply carries A\'s run, B\'s carries B\'s; both done', async () => {
  const h = setup();
  const { activity, clock, sent, append, runsDir, warns } = h;
  const SA = '7300000000000000161';
  const SB = '7300000000000000163';
  const epA = `${CONV}|msg:${SA}`;
  const epB = `${CONV}|msg:${SB}`;
  const regA = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: SA, endpoint: epA });
  activity.confirmRun(regA.runId, '{"ok":true,"id":51}\n');
  clock.advance(300);
  const regB = activity.registerRun({ orgId: ORG, conversationId: CONV, contextConversationId: CONV, sourceMessageId: SB, endpoint: epB });
  activity.confirmRun(regB.runId, '{"ok":true,"id":52}\n');
  await activity.collector.discover();
  const msgFor = (marker, src, ep) => omMsg(marker)
    .replace('source-message-id="7383920118271"', `source-message-id="${src}"`)
    .replace(RV('openmax', CONV), RV('openmax', ep));
  clock.advance(200);
  // Both reach the runtime as ONE input (the agent was busy).
  append({ type: 'user', message: { role: 'user', content: msgFor(regA.marker, SA, epA) + msgFor(regB.marker, SB, epB) } });
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();                              // gate open
  // The agent reads B's spill file first (signal ①: B focused), then works.
  append(toolUse('toolu_r', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-52/message.txt' }));
  append(toolOk('toolu_r'));
  append(toolUse('toolu_g', 'Grep', { pattern: 'b' }));
  append(toolOk('toolu_g'));
  activity.pollNow();
  clock.advance(2100);
  activity.emitter.tick();                              // run files written
  const store = createRunStore({ dir: runsDir });
  assert.equal(store.readRun(regB.runId).focus, true, 'the incident precondition: B holds the focus');
  // Without msg (the old endpoint), A's answer would take B's run — the bug.
  assert.equal(selectRun({ store, active: store.readActive(), convId: CONV, now: clock.now() }).run.run_id, regB.runId);

  // A's answer, via A's reply via.
  const pA = planReplyMetadata({ convId: CONV, sourceMessageId: SA, kind: 'text', bodyHash: 'hA', newKey: () => 'c_A', now: clock.now(), store });
  assert.equal(pA.runId, regA.runId);
  assert.equal(pA.firstAgentRun.source_message_id, SA);
  assert.deepEqual(pA.firstAgentRun.steps.filter((s) => s.kind === 'tool'), [], 'none of B\'s work on A\'s card');
  pA.settle('ok');
  append(toolUse('toolu_sA', 'Bash', { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${epA}" <<'EOF'\nA\nEOF` }));
  append(toolOk('toolu_sA'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, regA.runId).at(-1), 'done');
  assert.equal(store.readRun(regB.runId).state === 'closed', false, 'B is not closed by A\'s answer');

  // B's answer, via B's reply via: its own full agent_run with its steps.
  const pB = planReplyMetadata({ convId: CONV, sourceMessageId: SB, kind: 'text', bodyHash: 'hB', newKey: () => 'c_B', now: clock.now(), store });
  assert.equal(pB.runId, regB.runId);
  assert.equal(pB.firstAgentRun.source_message_id, SB);
  assert.deepEqual(pB.firstAgentRun.steps.filter((s) => s.kind === 'tool').map((s) => s.category), ['read', 'search_files'], 'B\'s own work');
  pB.settle('ok');
  append(toolUse('toolu_sB', 'Bash', { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${epB}" <<'EOF'\nB\nEOF` }));
  append(toolOk('toolu_sB'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(states(sent, regB.runId).at(-1), 'done');
  assert.equal(store.readSendStats().agent_run_source_matched, 2);
  assert.deepEqual(warns, []);
  activity.stop();
});

test('1337 end to end: a reply naming the unregistered smart message (`|msg:`) lifts the guard — the next reply without msg claims the run', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await guardedRun(h);
  const store = createRunStore({ dir: runsDir });
  assert.ok(store.readActive().unregistered[CONV], 'guard set by the smart message');
  // The smart message is answered via its own reply via: send.js attaches nothing.
  const ep = `${CONV}|msg:9000000000001`;
  assert.equal(planReplyMetadata({ convId: CONV, sourceMessageId: '9000000000001', kind: 'text', bodyHash: 'h0', newKey: () => 'c_0', now: clock.now(), store }), null);
  assert.equal(store.readSkip(reg.runId), null);
  append(toolUse('toolu_s0', 'Bash', { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${ep}" <<'EOF'\nx\nEOF` }));
  append(toolOk('toolu_s0'));
  clock.advance(700);
  activity.pollNow();
  assert.equal(store.readActive().unregistered?.[CONV], undefined, 'guard lifted');
  assert.equal(store.readRun(reg.runId).state === 'closed', false, 'the run is not answered by it');
  // The @ message is answered by an old-style reply (no msg): not blocked any more.
  const p = planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store });
  assert.equal(p?.runId, reg.runId);
  assert.ok(Array.isArray(p.firstAgentRun.steps));
  activity.stop();
});

test('1337: with two smart messages outstanding, a `|msg:` reply lifts only its own record — the guard stays until both are answered', async () => {
  const h = setup();
  const { activity, clock, append, runsDir } = h;
  const reg = await guardedRun(h);                      // smart message 9000000000001
  clock.advance(100);
  activity.noteUnregisteredInput(CONV, '9000000000002');
  append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: smartMsg('9000000000002') } });
  activity.pollNow();
  const store = createRunStore({ dir: runsDir });
  const send = (id, n) => {
    append(toolUse(`toolu_m${n}`, 'Bash', { command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${CONV}|msg:${id}" <<'EOF'\nx\nEOF` }));
    append(toolOk(`toolu_m${n}`));
    clock.advance(700);
    activity.pollNow();
  };
  send('9000000000002', 1);
  assert.ok(store.readActive().unregistered?.[CONV], 'the other smart message still holds the guard');
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h1', newKey: () => 'c_1', now: clock.now(), store }), null, 'a no-msg reply is still skipped');
  send('9000000000001', 2);
  assert.equal(store.readActive().unregistered?.[CONV], undefined, 'both answered: guard lifted');
  assert.equal(planReplyMetadata({ convId: CONV, kind: 'text', bodyHash: 'h2', newKey: () => 'c_2', now: clock.now(), store })?.runId, reg.runId);
  activity.stop();
});
