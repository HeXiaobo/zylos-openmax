import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttribution } from './attribution.js';
import { formatMarker, parseInputCtx, splitInputSegments } from './marker.js';

const CONV_A = '019f0000-aaaa-7bbb-8ccc-00000000000a';
const CONV_B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
const REPLY_VIA = (ch, ep) => ` ---- reply via: node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "${ch}" "${ep}"`;

function harness() {
  let t = 1760000000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const stats = {
    events_dropped: 0, attribution_unfocused_events: 0, focus_by_signal: {}, marker_rejected: {},
    replied_via: {}, runs_closed: {},
  };
  const finishes = [];
  const throttled = [];
  const emitter = {
    setState(run, s, c) { run._state = s; run._cat = c; },
    pushEvent(run, ev) { (run._pushed || (run._pushed = [])).push(ev); },
    finish(run, s, r) { finishes.push([run.run_id, s, r]); },
    untrack() {},
  };
  const attr = createAttribution({
    now: clock.now, emitter, stats, throttle: { warn: (...a) => throttled.push(a) },
    readSpillHead: () => null,
  });
  const mkRun = (id, conv, { c4 = null, endpoint = conv } = {}) => {
    const run = {
      run_id: id, org_id: 'org', conversation_id: conv, reply_conversation_id: conv,
      context_conversation_id: conv, endpoint, c4_id: c4, created_at: clock.now(), state: 'queued',
      seq: 1, next_event: 1, events: [], dropped: 0,
    };
    clock.advance(10);
    attr.addRun(run);
    return run;
  };
  return { attr, clock, stats, finishes, throttled, mkRun };
}

/** An openmax C4 body as the runtime log shows it (inline, with reply-via). */
function omBody(run, { conv = run?.conversation_id ?? CONV_A, endpoint = run?.endpoint ?? conv } = {}) {
  const env = `[OPENMAX DM] (org: Acme)\n<message-context conversation-id="${conv}" source-message-id="1"/>\n<current-message>\nAlice said: hi\n</current-message>`;
  return `${run ? formatMarker(run.run_id) : ''}${env}${REPLY_VIA('openmax', endpoint)}`;
}
function larkBody(text) {
  return `[Lark DM]\n<current-message>\nBob said: ${text}\n</current-message>${REPLY_VIA('lark', 'oc_1')}`;
}
const input = (form, content, at = 0) => ({ t: 'input', form, head: content.slice(0, 120), ctx: parseInputCtx(content), at });
const toolStart = (callId, name, inp, at = 0) => ({ t: 'tool_start', callId, name, input: inp, at });
const toolEnd = (callId, at = 0, isError = false) => ({ t: 'tool_end', callId, isError, at });
const commentary = (text, at = 0) => ({ t: 'commentary', text, at });
const kinds = (run) => (run._pushed || []).map((e) => (e.kind === 'notice' ? `notice:${e.code}` : e.kind === 'tool' ? `tool:${e.category}${e.ended_at != null ? ':end' : ''}` : e.kind));

test('single-run turn: thinking → commentary / tool → replied by claim → done at turn end', () => {
  const { attr, mkRun, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  assert.equal(a.state, 'active');
  assert.equal(a._state, 'thinking');
  attr.handle(commentary('先看一下。'));
  assert.equal(a.exec_started_at, a.created_at, 'execution start: entering the turn (clamped into the run)');
  attr.handle(toolStart('t1', 'Read', { file_path: '/x.md' }));
  assert.equal(a._state, 'thinking', 'v3: the state does not flip per tool');
  assert.equal(a.step_count, 1);
  attr.handle(toolEnd('t1', 5));
  assert.equal(a._state, 'thinking');
  assert.equal(a.step_count, 1, 'the end of a step is not another step');
  assert.deepEqual(kinds(a), ['commentary', 'tool:read', 'tool:read:end']);
  assert.equal(a.events.length, 2, 'start and end merged in the run record');
  assert.equal(a.events[1].ended_at, 5);
  attr.noteReplyClaim(a.run_id);
  assert.equal(a.state, 'replied');
  attr.handle(commentary('更新记忆'));
  assert.equal(kinds(a).length, 3, 'a replied run receives no more events');
  attr.handle({ t: 'turn_end', at: 9 });
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);
});

test('busy: enqueue keeps queued; turn_end → dequeue → user starts the new run turn', () => {
  const { attr, mkRun } = harness();
  attr.handle(input('user', larkBody('busy work')));
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('enqueue', omBody(a)));
  assert.equal(a._state, 'queued');
  attr.handle(toolStart('t1', 'Bash', { command: 'ls' }));
  assert.equal(kinds(a).length, 0);
  attr.handle({ t: 'turn_end', at: 1 });
  attr.handle(input('dequeue', ''));
  attr.handle(input('user', omBody(a)));
  assert.equal(a.state, 'active');
  attr.handle(toolStart('t2', 'Bash', { command: 'git log' }));
  assert.deepEqual(kinds(a), ['tool:command']);
  assert.equal(a.step_count, 1, 'the call before the run started is not counted');
});

test('(6) same-conversation merge: focus stays on the first; after its reply the second gets focus (no visible note)', () => {
  const { attr, mkRun, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(input('absorbed', omBody(b)));
  attr.handle(input('queued_command', omBody(b)));
  assert.deepEqual(kinds(b), ['notice:merged_turn']);
  assert.equal(attr.turn.focus, a);
  attr.handle(toolStart('t1', 'Grep', {}));
  assert.deepEqual(kinds(a), ['tool:search_files']);
  attr.handle(toolStart('t2', 'Bash', { command: `node /x/c4-send.js "openmax" "${CONV_A}" <<EOF` }));
  assert.equal(a.state, 'replied');
  assert.deepEqual(kinds(a), ['tool:search_files'], 'the reply send is not a step');
  assert.equal(a.step_count, 1, 'nor counted');
  assert.equal(attr.turn.focus, b);
  assert.deepEqual(kinds(b), ['notice:merged_turn']);
  assert.equal(stats.focus_by_signal[2], 1);
  assert.equal(b.focus, true);
  assert.equal(a.focus, false);
  attr.handle(commentary('第二条的处理'));
  assert.equal(kinds(b).at(-1), 'commentary');
  // The claim file for the same reply arrives later: processed once only.
  attr.noteReplyClaim(a.run_id);
  assert.equal(stats.replied_via.log, 1);
  assert.equal(stats.replied_via.claim, undefined);
});

test('(7) cross-conversation owners: no focus without ①; A replying does not hand focus to B', () => {
  const { attr, mkRun, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_B);
  attr.handle(input('user', omBody(a)));
  attr.handle(input('queued_command', omBody(b)));
  assert.equal(attr.turn.focus, null);
  attr.handle(toolStart('t1', 'Read', { file_path: '/x' }));
  attr.handle(commentary('x'));
  assert.deepEqual(kinds(a), []);
  assert.deepEqual(kinds(b), ['notice:merged_turn']);
  assert.equal(stats.attribution_unfocused_events, 2);
  attr.noteReplyClaim(a.run_id);
  assert.equal(attr.turn.focus, null);
  attr.handle({ t: 'turn_end', at: 1 });
  assert.equal(stats.mixed_turn_runs, 1, 'a closed (it had focus before b merged)');
  assert.equal(stats.focus_none_runs, undefined);
  attr.noteReplyClaim(b.run_id);
  assert.equal(stats.mixed_turn_runs, 2);
  assert.equal(stats.focus_none_runs, 1, 'b sat in the mixed turn and never got focus');
});

test('(8) a turn opened by external input stays foreign: ④ does not apply', () => {
  const { attr, mkRun } = harness();
  attr.handle(input('user', larkBody('hello')));
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(input('queued_command', omBody(a)));
  attr.handle(input('queued_command', omBody(b)));
  assert.equal(attr.turn.foreign, true);
  assert.equal(attr.turn.focus, null);
});

test('① reading the spill file gives focus, even in a foreign turn; sticky beats ④', () => {
  const { attr, mkRun, stats } = harness();
  attr.handle(input('user', larkBody('hello')));
  const a = mkRun('r_0000000a', CONV_A, { c4: 41 });
  attr.handle(input('queued_command', omBody(a)));
  attr.handle(toolStart('t1', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-41/message.txt' }));
  assert.equal(attr.turn.focus, a);
  assert.deepEqual(kinds(a), ['notice:merged_turn', 'tool:read']);
  assert.equal(stats.focus_by_signal[1], 1);

  const h = harness();
  const x = h.mkRun('r_0000000a', CONV_A, { c4: 1 });
  const y = h.mkRun('r_0000000b', CONV_A, { c4: 2 });
  h.attr.handle(input('user', omBody(x)));
  h.attr.handle(input('queued_command', omBody(y)));
  assert.equal(h.attr.turn.focus, x, '④ picks the earliest');
  h.attr.handle(toolStart('t1', 'Bash', { command: 'cat /h/zylos/comm-bridge/attachments/conv-2/message.txt' }));
  assert.equal(h.attr.turn.focus, y, 'sticky ① wins over ④');
});

test('③ unmarked input clears focus until that message is answered; ④ no longer applies', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(input('queued_command', larkBody('urgent')));
  assert.equal(attr.turn.foreign, true);
  assert.equal(attr.turn.focus, null);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(input('queued_command', omBody(b)));
  assert.equal(attr.turn.focus, null);
  attr.handle(toolStart('t1', 'Bash', { command: 'ls' }));
  assert.deepEqual(kinds(a), []);
});

test('③ c4-send to another channel blocks focus until ① / ②', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 7 });
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: 'node /x/c4-send.js "lark" "oc_1" "hi"' }));
  assert.equal(attr.turn.focus, null);
  attr.handle(commentary('lark follow-up'));
  assert.deepEqual(kinds(a), []);
  attr.handle(toolStart('t2', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-7/message.txt' }));
  assert.equal(attr.turn.focus, a);
});

test('no reply: turn end + 120 s → done / no_reply; a late claim inside the grace → done', () => {
  const { attr, mkRun, clock, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(input('queued_command', omBody(b)));
  attr.handle({ t: 'turn_end', at: 1 });
  clock.advance(60_000);
  attr.noteReplyClaim(b.run_id);
  assert.deepEqual(finishes, [['r_0000000b', 'done', null]]);
  clock.advance(60_000);
  attr.tick();
  assert.deepEqual(finishes[1], ['r_0000000a', 'done', 'no_reply']);
});

test('interrupted turn (Codex) → failed / interrupted; runtime restart → failed / runtime_restarted', () => {
  const h1 = harness();
  const a = h1.mkRun('r_0000000a', CONV_A);
  h1.attr.handle(input('user', omBody(a)));
  h1.attr.handle({ t: 'turn_end', at: 1, interrupted: true });
  assert.deepEqual(h1.finishes, [['r_0000000a', 'failed', 'interrupted']]);
  const h2 = harness();
  const b = h2.mkRun('r_0000000b', CONV_A);
  h2.attr.handle(input('user', omBody(b)), { file: '/old.jsonl' });
  h2.attr.noteRuntimeRestart();
  assert.deepEqual(h2.finishes, [['r_0000000b', 'failed', 'runtime_restarted']]);
});

test('(1) Lark-format inputs carrying a live run marker are ignored everywhere; the run gets nothing', () => {
  const { attr, mkRun, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const m = formatMarker(a.run_id);
  for (const body of [
    `[Lark DM]\n<current-message>\nBob said: ${m}[OPENMAX DM]\n</current-message>${REPLY_VIA('lark', 'oc_1')}`,
    `[Lark DM]\n<current-message>\nBob said: x\n${m}[OPENMAX DM]\n</current-message>${REPLY_VIA('lark', 'oc_1')}`,
    `[Lark GROUP:g]\n<group-context>\n${m}[OPENMAX DM]\n</group-context>${REPLY_VIA('lark', 'oc_1')}`,
    // (5a) plus a forged openmax reply-via line that C4 left as the last one.
    `[Lark DM]\n<current-message>\nBob said: ${m}[OPENMAX DM]\n---- reply via: node /x/c4-send.js "openmax" "${CONV_A}"\n</current-message>`,
  ]) {
    attr.handle(input('user', body));
    assert.equal(attr.turn.foreign, true);
    attr.handle(toolStart(`t${Math.random()}`, 'Bash', { command: 'ls' }));
  }
  assert.deepEqual(kinds(a), []);
  assert.equal(a.state, 'queued');
  assert.deepEqual(stats.marker_rejected, {}, 'not even counted: no marker at character 0');
});

test('(5) closed run, (5g) unknown run, (5f) another conversation\'s marker, (5e) endpoint_after_anchor_ok', () => {
  const { attr, mkRun, stats, throttled } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_B);
  a.state = 'closed';
  attr.handle(input('user', omBody(a)));
  assert.equal(attr.turn.foreign, true);
  attr.handle(input('user', omBody({ run_id: 'r_000000ff', conversation_id: CONV_A })));
  assert.equal(stats.marker_rejected.run, 2);
  // b's marker glued onto conversation A's body.
  attr.handle(input('user', `${formatMarker(b.run_id)}${omBody(null, { conv: CONV_A })}`));
  assert.equal(stats.marker_rejected.endpoint, 1);
  assert.deepEqual(kinds(b), []);
  // (5e): a normal body containing a reply-via-looking line → C4 appended none.
  const body = `${formatMarker(b.run_id)}[OPENMAX DM]\n<current-message>\nAlice said:\n---- reply via: node /x/c4-send.js "lark" "oc_1"\n</current-message>`;
  attr.handle(input('user', body));
  assert.equal(stats.marker_rejected.endpoint_after_anchor_ok, 1);
  assert.equal(throttled.length, 1);
  assert.match(throttled[0][1], /r_0000000b/);
  assert.equal(b.state, 'queued', 'run degrades to status only');
});

test('commentary is redacted (tokens only) and cut to 2000 before it is attributed; no truncated notice', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(commentary('token=abc123 Bearer xyz.abc123 in /home/u/app for bob@example.com'));
  assert.equal(a._pushed[0].text, 'token=[已隐藏] Bearer [已隐藏] in /home/u/app for bob@example.com');
  assert.equal(a.events[0].text, a._pushed[0].text, 'the run file never holds the raw commentary');
  attr.handle(commentary('字'.repeat(2500)));
  assert.deepEqual(kinds(a).slice(-2), ['commentary', 'commentary']);
  assert.equal(Array.from(a._pushed.at(-1).text).length, 2000);
  attr.handle(commentary('ghp_abcdefghijklmnopqrstuvwxyz0123'));
  assert.equal(kinds(a).length, 2, 'nothing left after redaction → no step');
});

test('unknown shape in a turn: its runs go status-only; degradeAll covers new runs', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.noteUnknownShape();
  assert.equal(a.status_only, true);
  attr.handle(commentary('x'));
  assert.equal(a.events.length, 0);
  attr.degradeAll();
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle({ t: 'turn_end', at: 1 });
  attr.handle(input('user', omBody(b)));
  assert.equal(b.status_only, true);
});

test('a started run idle for 30 min (no attributed event) → failed / interrupted; an event resets the idle clock', () => {
  const { attr, mkRun, clock, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  clock.advance(20 * 60_000);
  attr.handle(commentary('still working'));
  clock.advance(29 * 60_000);
  attr.tick();
  assert.deepEqual(finishes, [], 'idle cap, not a total-duration cap');
  clock.advance(60_000);
  attr.tick();
  assert.deepEqual(finishes, [['r_0000000a', 'failed', 'interrupted']]);
});

test('a run that never started closes done / no_reply after 5 min; a started run does not', () => {
  const { attr, mkRun, clock, finishes } = harness();
  const q = mkRun('r_0000000a', CONV_A);
  const c = mkRun('r_0000000c', CONV_A);
  c.state = 'created';
  const r = mkRun('r_0000000d', CONV_A);
  r._restartPending = true;
  const b = mkRun('r_0000000b', CONV_B);
  attr.handle(input('user', omBody(b)));
  clock.advance(5 * 60_000 - 100);
  attr.tick();
  assert.deepEqual(finishes, []);
  clock.advance(100);
  attr.tick();
  assert.deepEqual(finishes, [['r_0000000a', 'done', 'no_reply'], ['r_0000000c', 'done', 'no_reply']]);
  assert.equal(q.state, 'closed');
  assert.equal(b.state, 'active', 'a started run keeps turn end + grace / the idle cap');
  assert.equal(r.state, 'queued', 'a recovered run waits for onWsOpen (runtime_restarted)');
});

test('comm.ask (choice or form) marks the owner replying in that conversation and closes the run at turn end', () => {
  for (const json of [
    `{"conversationId":"${CONV_A}","interactionType":"choice","kind":"k","askedOf":"m-1","title":"t","options":["a","b"]}`,
    `{"conversationId":"${CONV_A}","interactionType":"form","kind":"k","askedOf":"m-1","title":"t","fields":[{"key":"q","label":"Q","options":["a"]}]}`,
  ]) {
    const { attr, mkRun, finishes } = harness();
    const a = mkRun('r_0000000a', CONV_A);
    attr.handle(input('user', omBody(a)));
    attr.handle(toolStart('t1', 'Bash', { command: `cd /h/zylos/.claude/skills/openmax && node src/cli/comm.js comm.ask '${json}'` }));
    assert.equal(a.state, 'replied', json);
    assert.deepEqual(kinds(a), [], 'the reply send is not a step');
    attr.handle({ t: 'turn_end', at: 1 });
    assert.deepEqual(finishes, [['r_0000000a', 'done', null]], json);
  }
});

test('comm CLI reply verbs mark the owner replying in that conversation; a send to another conversation is ③', () => {
  const { attr, mkRun, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: `cd /h/zylos/.claude/skills/openmax && node src/cli/comm.js comm.ask_card '{"conversationId":"${CONV_A}","title":"t"}'` }));
  assert.equal(a.state, 'replied');
  assert.deepEqual(kinds(a), [], 'the reply send is not a step');
  attr.handle({ t: 'turn_end', at: 1 });
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);

  const h = harness();
  const b = h.mkRun('r_0000000b', CONV_A);
  h.attr.handle(input('user', omBody(b)));
  // Not a reply verb, and an unreadable argument: neither a reply nor external.
  h.attr.handle(toolStart('t1', 'Bash', { command: `node src/cli/comm.js comm.get_messages '{"conversationId":"${CONV_A}"}'` }));
  assert.equal(b.state, 'active');
  assert.equal(h.attr.turn.focus, b);
  // A send into a conversation no owner replies to pauses attribution.
  h.attr.handle(toolStart('t3', 'Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}","content":"hi"}'` }));
  assert.equal(b.state, 'active');
  assert.equal(h.attr.turn.focus, null);
  h.attr.handle(commentary('elsewhere'));
  assert.deepEqual(kinds(b), ['tool:command']);
});

test('comm CLI reply matches the thread reply conversation', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { endpoint: `${CONV_A}|thread:${CONV_B}|parent:9` });
  a.reply_conversation_id = CONV_B;
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}","content":"x"}'` }));
  assert.equal(a.state, 'replied');
});

// ── review fixes: Codex exec wrapper and compound commands ─────────────────
import { parseCodexRecord, createCodexState } from './adapters/codex-rollout.js';

const codexToolStart = (payload) => {
  const r = parseCodexRecord({ timestamp: new Date(0).toISOString(), type: 'response_item', payload }, createCodexState());
  assert.equal(r.status, 'ok');
  return { ...r.events[0], at: 0 };
};
const wrapperCode = (cmd) => `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\nconsole.log(r.output);`;
const summaryTexts = (run) => run.events.filter((e) => e.kind === 'commentary').map((e) => e.text);
const wireTexts = (run) => (run._pushed || []).filter((e) => e.kind === 'commentary').map((e) => e.text);

for (const [label, start] of [
  ['custom_tool_call exec wrapper', (cmd, id) => codexToolStart({ type: 'custom_tool_call', name: 'exec', call_id: id, input: wrapperCode(cmd) })],
  ['function_call exec_command (control)', (cmd, id) => codexToolStart({ type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd }) })],
]) {
  test(`${label}: an external send clears focus — later commentary reaches neither frames nor summary; a spill read re-acquires`, () => {
    const { attr, mkRun } = harness();
    const a = mkRun('r_0000000a', CONV_A, { c4: 41 });
    attr.handle(input('user', omBody(a)));
    attr.handle(commentary('openmax work'));
    attr.handle(start('node /x/c4-send.js "lark" "oc_1" "hi"', 'c1'));
    assert.equal(attr.turn.focus, null);
    attr.handle(commentary('lark session work'));
    assert.deepEqual(summaryTexts(a), ['openmax work']);
    assert.deepEqual(wireTexts(a), ['openmax work']);
    attr.handle(start('cat /h/zylos/comm-bridge/attachments/conv-41/message.txt', 'c2'));
    assert.equal(attr.turn.focus, a);
    attr.handle(commentary('back on openmax'));
    assert.deepEqual(summaryTexts(a), ['openmax work', 'back on openmax']);
    assert.deepEqual(wireTexts(a), ['openmax work', 'back on openmax']);
  });
}

const SHELLS = {
  Bash: (cmd) => ({ command: cmd }),
  exec_command: (cmd) => ({ cmd }),
  shell: (cmd) => ({ command: ['bash', '-lc', cmd] }),
  local_shell: (cmd) => ({ command: ['bash', '-lc', cmd] }),
};
for (const [name, wrap] of Object.entries(SHELLS)) {
  for (const order of ['openmax-first', 'telegram-first']) {
    test(`${name} compound (${order}): A replied, focus does NOT move to B, external commentary stays out of B`, () => {
      const { attr, mkRun } = harness();
      const a = mkRun('r_0000000a', CONV_A);
      const b = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a)));
      attr.handle(input('queued_command', omBody(b)));
      assert.equal(attr.turn.focus, a);
      const om = `node /x/c4-send.js "openmax" "${CONV_A}" "done"`;
      const tg = 'node /x/c4-send.js "telegram" "123" "done"';
      attr.handle(toolStart('t1', name, wrap(order === 'openmax-first' ? `${om} && ${tg}` : `${tg}; ${om}`)));
      assert.equal(a.state, 'replied');
      assert.equal(attr.turn.focus, null);
      assert.equal(b.focus, false);
      attr.handle(commentary('telegram follow-up'));
      assert.deepEqual(summaryTexts(b), []);
      assert.deepEqual(wireTexts(b), []);
      assert.deepEqual(kinds(b), ['notice:merged_turn']);
      assert.deepEqual(kinds(a), [], 'the reply send is not a step (v3)');
    });
  }
}

// R2: a wrapper that is not fully recognized pauses attribution (sticky and
// non-sticky focus alike), and pause beats regain within one call.
const wrapperRaw = (src, id) => codexToolStart({ type: 'custom_tool_call', name: 'exec', call_id: id, input: src });
const UNSUPPORTED_SRC = {
  concatenation: "const sender='/h/'+'c4-'+'send.js'; await tools.exec_command({cmd:'node '+sender+' telegram foreign'});",
  hexEscape: 'await tools.exec_command({cmd:"node /h/c4-\\x73end.js telegram foreign"});',
  template: 'const p = "/h/c4-send.js"; await tools.exec_command({cmd:`node ${p} telegram foreign`});',
  empty: '',
  oversized: `await tools.exec_command({cmd:"echo ${'a'.repeat(70 * 1024)}"});`,
};
for (const [label, src] of Object.entries(UNSUPPORTED_SRC)) {
  for (const sticky of [false, true]) {
    test(`unrecognized wrapper (${label}, ${sticky ? 'sticky' : 'non-sticky'} focus) pauses: later commentary reaches neither frames nor summary`, () => {
      const { attr, mkRun } = harness();
      const a = mkRun('r_0000000a', CONV_A, { c4: 41 });
      attr.handle(input('user', omBody(a)));
      if (sticky) attr.handle(toolStart('s0', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-41/message.txt' }));
      assert.equal(attr.turn.sticky === a, sticky);
      attr.handle(commentary('openmax work'));
      attr.handle(wrapperRaw(src, 'w1'));
      assert.equal(attr.turn.focus, null);
      attr.handle(commentary('foreign work'));
      assert.deepEqual(summaryTexts(a), ['openmax work']);
      assert.deepEqual(wireTexts(a), ['openmax work']);
    });
  }
}

test('literal wrapper with plain git status keeps attribution', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(wrapperRaw('const r = await tools.exec_command({ cmd: "git status" });\nconsole.log(r.output);', 'w1'));
  assert.equal(attr.turn.focus, a);
  attr.handle(commentary('still openmax'));
  assert.deepEqual(summaryTexts(a), ['still openmax']);
  assert.deepEqual(kinds(a).slice(0, 1), ['tool:command']);
});

test('pause beats regain in one call: unrecognized wrapper with a literal spill read stays paused; a later independent spill read regains', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 41 });
  attr.handle(input('user', omBody(a)));
  attr.handle(wrapperRaw('const x = 1 + 1; await tools.exec_command({cmd:"cat /h/zylos/comm-bridge/attachments/conv-41/message.txt"});', 'w1'));
  assert.equal(attr.turn.focus, null);
  attr.handle(commentary('unknown work'));
  assert.deepEqual(summaryTexts(a), []);
  attr.handle(wrapperRaw('await tools.exec_command({ cmd: "cat /h/zylos/comm-bridge/attachments/conv-41/message.txt" })', 'w2'));
  assert.equal(attr.turn.focus, a);
  attr.handle(commentary('back on openmax'));
  assert.deepEqual(summaryTexts(a), ['back on openmax']);
});

test('pause beats regain in one call: unrecognized wrapper with a literal openmax reply does not restore focus, not even via the later send.js claim', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 41 });
  const b = mkRun('r_0000000b', CONV_A, { c4: 42 });
  attr.handle(input('user', omBody(a)));
  attr.handle(input('queued_command', omBody(b)));
  attr.handle(wrapperRaw(`await tools.exec_command({cmd:"node /x/c4-send.js openmax ${CONV_A} ok"}); const y = a + b;`, 'w1'));
  assert.equal(attr.turn.focus, null);
  assert.notEqual(a.state, 'replied', 'the log-side reply is not trusted from this call');
  attr.noteReplyClaim(a.run_id);          // send.js's claim for that reply
  assert.equal(a.state, 'replied', 'the claim still marks the run replied');
  assert.equal(attr.turn.focus, null, 'but does not lift the pause');
  attr.handle(commentary('unknown work'));
  assert.deepEqual(summaryTexts(b), []);
  assert.deepEqual(wireTexts(b), []);
  // A later independent spill read of b regains.
  attr.handle(toolStart('r2', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-42/message.txt' }));
  assert.equal(attr.turn.focus, b);
});

test('Bash description: the step title on the run event AND the live frame (v3); never the command text', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: 'git status --token=abc', description: '查看 /home/u/repo 的 git 状态' }, 1));
  attr.handle(toolEnd('t1', 5));
  attr.handle(toolStart('t2', 'exec_command', { cmd: 'rg foo' }, 6));
  assert.equal(a.events[0].title, '查看 /home/u/repo 的 git 状态', 'paths are not hidden (D3)');
  assert.equal(a._pushed[0].title, a.events[0].title, 'same title live');
  assert.equal(a.events[0].ended_at, 5, 'start and end still merged');
  assert.equal('title' in a.events[1], false, 'no description → no title (the FE shows its category label)');
  assert.equal(JSON.stringify(a.events).includes('git status'), false);
  assert.deepEqual(kinds(a), ['tool:command', 'tool:command:end', 'tool:command']);
  assert.equal(a.step_count, 2);
});

test('review R4-1: a comm CLI send to an unprovable destination pauses focus; later work stays out of the run', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 7 });
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: 'node src/cli/comm.js comm.send "$(cat /tmp/p.json)"' }));
  assert.equal(a.state, 'active', 'not a reply');
  assert.equal(attr.turn.focus, null);
  attr.handle(commentary('work for the other conversation'));
  attr.handle(toolStart('t2', 'Bash', { command: 'ls' }));
  assert.deepEqual(kinds(a), []);
  assert.equal(a.events.length, 0, 'nothing in the summary either');
  // Reliable evidence (① spill read) restores focus.
  attr.handle(toolStart('t3', 'Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-7/message.txt' }));
  assert.equal(attr.turn.focus, a);
});

test('review R4-2: two owners in A; a card to B whose content quotes A marks neither replied and pauses', () => {
  const { attr, mkRun } = harness();
  const a1 = mkRun('r_0000000a', CONV_A);
  const a2 = mkRun('r_0000000b', CONV_A);
  attr.handle(input('user', omBody(a1)));
  attr.handle(input('queued_command', omBody(a2)));
  attr.handle(toolStart('t1', 'Bash', { command: `node src/cli/comm.js comm.send '{"content":"about ${CONV_A}: {\\"conversationId\\":\\"${CONV_A}\\"}","conversationId":"${CONV_B}"}'` }));
  assert.equal(a1.state, 'active');
  assert.equal(a2.state, 'active');
  assert.equal(attr.turn.focus, null);
  attr.handle(commentary('B work'));
  assert.equal(a1.events.filter((e) => e.kind === 'commentary').length, 0);
  assert.equal(a2.events.filter((e) => e.kind === 'commentary').length, 0);
});

test('review R5-2: two A owners; a send to B whose JSON quotes an A example marks neither replied, the turn end closes neither', () => {
  const { attr, mkRun, finishes } = harness();
  const a1 = mkRun('r_0000000a', CONV_A);
  const a2 = mkRun('r_0000000b', CONV_A);
  attr.handle(input('user', omBody(a1)));
  attr.handle(input('queued_command', omBody(a2)));
  attr.handle(toolStart('t1', 'Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}","content":"例: node src/cli/comm.js comm.send {\\"conversationId\\":\\"${CONV_A}\\"}"}'; echo trailing` }));
  assert.equal(a1.state, 'active');
  assert.equal(a2.state, 'active');
  assert.equal(attr.turn.focus, null, 'B is no owner here: paused');
  attr.handle({ t: 'turn_end', at: 1 });
  assert.deepEqual(finishes, [], 'nobody closed early as replied');
  // Control: the same command line sending to A marks only the earliest A owner.
  const h = harness();
  const b1 = h.mkRun('r_0000000c', CONV_A);
  const b2 = h.mkRun('r_0000000d', CONV_A);
  h.attr.handle(input('user', omBody(b1)));
  h.attr.handle(input('queued_command', omBody(b2)));
  h.attr.handle(toolStart('t1', 'Bash', { command: `/usr/bin/node src/cli/comm.js comm.send '{"conversationId":"${CONV_A}","content":"例: node src/cli/comm.js comm.send {\\"conversationId\\":\\"${CONV_A}\\"}"}'` }));
  assert.equal(b1.state, 'replied');
  assert.equal(b2.state, 'active');
});

test('review R5-1: an absolute-path node send to B pauses the A run', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', { command: `/usr/bin/node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}","content":"hi"}'` }));
  assert.equal(attr.turn.focus, null);
  attr.handle(commentary('B work'));
  assert.equal(a.events.length, 0);
});

test('review R6: two A owners — node --check / bash -nc of a send to A marks nobody replied and closes nobody', () => {
  for (const cmd of [
    `node --check src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`,
    `bash -nc 'node /x/c4-send.js "openmax" "${CONV_A}" hi'`,
  ]) {
    const { attr, mkRun, finishes } = harness();
    const a1 = mkRun('r_0000000a', CONV_A);
    const a2 = mkRun('r_0000000b', CONV_A);
    attr.handle(input('user', omBody(a1)));
    attr.handle(input('queued_command', omBody(a2)));
    attr.handle(toolStart('t1', 'Bash', { command: cmd }));
    assert.equal(a1.state, 'active', cmd);
    assert.equal(a2.state, 'active', cmd);
    attr.handle({ t: 'turn_end', at: 1 });
    assert.deepEqual(finishes, [], cmd);
  }
});

test('review R6: an unquoted heredoc running a B send inside an A get_messages pauses A; the quoted one does not', () => {
  const body = (delim) => `node src/cli/comm.js comm.get_messages '{"conversationId":"${CONV_A}"}' ${delim}\n$(node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}"}')\nEOF`;
  const h1 = harness();
  const a = h1.mkRun('r_0000000a', CONV_A);
  h1.attr.handle(input('user', omBody(a)));
  h1.attr.handle(toolStart('t1', 'Bash', { command: body('<<EOF') }));
  assert.equal(h1.attr.turn.focus, null);
  h1.attr.handle(commentary('B work'));
  assert.equal(a.events.filter((e) => e.kind === 'commentary').length, 0);
  const h2 = harness();
  const b = h2.mkRun('r_0000000b', CONV_A);
  h2.attr.handle(input('user', omBody(b)));
  h2.attr.handle(toolStart('t1', 'Bash', { command: body("<<'EOF'") }));
  assert.equal(h2.attr.turn.focus, b);
});

// ── review R7 ──
const R7_A_SEND = `node /x/c4-send.js "openmax" "${CONV_A}" hi`;
const R7_B_SEND = `node src/cli/comm.js comm.send '{"conversationId":"${CONV_B}"}'`;
const R7_TOOLS = [
  ['Bash', (c) => ({ command: c })],
  ['exec_command', (c) => ({ cmd: c })],
  ['shell', (c) => ({ command: ['bash', '-lc', c] })],
  ['local_shell', (c) => ({ command: ['bash', '-lc', c] })],
];

test('review R8: two A owners — a send to A in a literal noexec invocation marks nobody replied and closes nobody', () => {
  for (const cmd of [`bash +n -n -c '${R7_A_SEND}'`, `bash +o noexec -o noexec -c '${R7_A_SEND}'`, `bash -in -c '${R7_A_SEND}'`]) {
    for (const [tool, wrap] of R7_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'active', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
      attr.handle({ t: 'turn_end', at: 1 });
      assert.deepEqual(finishes, [], `${tool}: ${cmd}`);
    }
  }
});

const R9_TOOLS = [...R7_TOOLS, ['exec', (c) => `await tools.exec_command({ cmd: ${JSON.stringify(c)} });`]];

test('review R9: two A owners — a send to A after a runtime set -n is uncertain: nobody replied, nothing closed, focus paused', () => {
  for (const cmd of [
    `set -n; ${R7_A_SEND}`, `set -o noexec; ${R7_A_SEND}`, `set -on noexec; ${R7_A_SEND}`, `builtin set -n; ${R7_A_SEND}`,
    `(set -n); ${R7_A_SEND}`, `set() { :; }; set -n; ${R7_A_SEND}`, `if false; then 'fi'; set -n; fi; ${R7_A_SEND}`,
    `set -n +n; ${R7_A_SEND}`, `bash --noprofile --norc -i -c 'set -n; ${R7_A_SEND}'`,
    `node --check -r ./p.cjs src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`,
    `NODE_OPTIONS="--require ./p.cjs" node --check src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`,
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'active', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
      assert.equal(attr.turn.focus, null, `${tool}: ${cmd}`);
      attr.handle(commentary('maybe elsewhere'));
      assert.equal(a1.events.filter((e) => e.kind === 'commentary').length, 0, `${tool}: ${cmd}`);
      attr.handle({ t: 'turn_end', at: 1 });
      assert.deepEqual(finishes, [], `${tool}: ${cmd}`);
    }
  }
});

test('review R9: two A owners — a send to A that really runs (noexec turned off in the invocation) marks only the earliest A', () => {
  for (const cmd of [
    `bash -n +n -c '${R7_A_SEND}'`, `node --check --no-check src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`,
    `set -euo pipefail; ${R7_A_SEND}`,
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'replied', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
    }
  }
});

test('review R9: two A owners — a literal node mode invocation (--no-check --check) marks nobody and closes nothing', () => {
  for (const [tool, wrap] of R9_TOOLS) {
    const { attr, mkRun, finishes } = harness();
    const a1 = mkRun('r_0000000a', CONV_A);
    const a2 = mkRun('r_0000000b', CONV_A);
    attr.handle(input('user', omBody(a1)));
    attr.handle(input('queued_command', omBody(a2)));
    attr.handle(toolStart('t1', tool, wrap(`node --no-check --check src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`)));
    assert.equal(a1.state, 'active', tool);
    assert.equal(a2.state, 'active', tool);
    assert.equal(attr.turn.focus, a1, tool);
    attr.handle({ t: 'turn_end', at: 1 });
    assert.deepEqual(finishes, [], tool);
  }
});

test('review R9: set -n text inside a consumed A message does not make a later A send uncertain', () => {
  const first = `node /x/c4-send.js "openmax" "${CONV_A}" "tip: set -n; set -o noexec"`;
  for (const [cmd, uncertain] of [[`${first}; ${R7_A_SEND}`, false], [`${first}; set -n; ${R7_A_SEND}`, true]]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'replied', `${tool}: ${cmd}`);
      assert.equal(a2.state, uncertain ? 'active' : 'replied', `${tool}: ${cmd}`);
    }
  }
});

test('review R8: two A owners — a send to A whose noexec is unknown marks nobody replied and pauses', () => {
  for (const cmd of [`flags=+n; bash -n $flags -c '${R7_A_SEND}'`, `opt=noexec; bash -n +o "$opt" -c '${R7_A_SEND}'`]) {
    for (const [tool, wrap] of R7_TOOLS) {
      const { attr, mkRun } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'active', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
      assert.equal(attr.turn.focus, null, `${tool}: ${cmd}`);
    }
  }
});

test('review R8: a B send after a runtime set -n, with unknown noexec, or in an unquoted continued heredoc moves focus off A', () => {
  for (const cmd of [
    `(set -n); ${R7_B_SEND}`, `set -n; ${R7_B_SEND}`, `false && set -n; ${R7_B_SEND}`, `set() { :; }; set -n; ${R7_B_SEND}`,
    `while false; do 'done'; set -n; done; ${R7_B_SEND}`, `flags=+n; set -n $flags; ${R7_B_SEND}`,
    `bash --noprofile --norc -i -c 'set -n; ${R7_B_SEND}'`,
    `flags=+n; bash -n $flags -c '${R7_B_SEND}'`, `opt=noexec; bash -n +o "$opt" -c '${R7_B_SEND}'`,
    `bash -o noexec +o noexec -c '${R7_B_SEND}'`,
    `node src/cli/comm.js comm.get_messages '{"conversationId":"${CONV_A}"}' <<EO\\\nF\n$(${R7_B_SEND})\nEOF`,
  ]) {
    for (const [tool, wrap] of R7_TOOLS) {
      const { attr, mkRun } = harness();
      const a = mkRun('r_0000000a', CONV_A);
      attr.handle(input('user', omBody(a)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.notEqual(attr.turn.focus, a, `${tool}: ${cmd}`);
      attr.handle(commentary('B work'));
      assert.equal(a.events.filter((e) => e.kind === 'commentary').length, 0, `${tool}: ${cmd}`);
      assert.notEqual(a.state, 'replied', `${tool}: ${cmd}`);
    }
  }
  // Controls: the quoted continued delimiter and a literal noexec invocation keep A's focus.
  for (const cmd of [
    `node src/cli/comm.js comm.get_messages '{"conversationId":"${CONV_A}"}' <<\\EO\\\nF\n$(${R7_B_SEND})\nEOF`,
    `bash -n -c '${R7_B_SEND}'`, `bash +o noexec -o noexec -c '${R7_B_SEND}'`,
  ]) {
    for (const [tool, wrap] of R7_TOOLS) {
      const { attr, mkRun } = harness();
      const a = mkRun('r_0000000a', CONV_A);
      attr.handle(input('user', omBody(a)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(attr.turn.focus, a, `${tool}: ${cmd}`);
    }
  }
});

// ── review R10 ──
test('review R10: two A owners — node with a non-mode option / env prefix, or a prefixed runtime set -n: nobody replied, nothing closed, focus paused', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  for (const cmd of [
    `node --frobnicate ${comm}`, `node --require ./hookB.cjs ${comm}`, `node --import=./hookB.mjs ${comm}`,
    `node --check --no-check --require ./hookB.cjs ${comm}`, `NODE_OPTIONS="--require ./hookB.cjs" node ${comm}`,
    `env node ${comm}`, `export NODE_OPTIONS=-r./hookB.cjs; node ${comm}`,
    `command -p set -n; ${R7_A_SEND}`, `command -- set -n; ${R7_A_SEND}`, `command -p -- set -n; ${R7_A_SEND}`,
    `builtin -- set -n; ${R7_A_SEND}`, `eval -- 'set -n'; ${R7_A_SEND}`, `builtin eval 'set -n'; ${R7_A_SEND}`,
    `exit 0; ${R7_A_SEND}`, `node() { :; }; node ${comm}`,
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'active', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
      assert.equal(attr.turn.focus, null, `${tool}: ${cmd}`);
      attr.handle({ t: 'turn_end', at: 1 });
      assert.deepEqual(finishes, [], `${tool}: ${cmd}`);
    }
  }
});

test('review R10: two A owners — plain node, mode flags ending off, and command -v queries still mark only the earliest A', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  for (const cmd of [`node ${comm}`, `node --check --no-check ${comm}`, `command -p node ${comm}`, `command -v set -n; ${R7_A_SEND}`, `command -V set; ${R7_A_SEND}`]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'replied', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
    }
  }
});

// ── review R11 ──
test('review R11: two A owners — a failing prefix lookup or an inherited NODE_OPTIONS: nobody replied, nothing closed, focus paused', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  const inner = `node src/cli/comm.js comm.send "{\\"conversationId\\":\\"${CONV_A}\\"}"`;
  for (const cmd of [
    `builtin node ${comm}`, `command builtin node ${comm}`, `exec builtin node ${comm}`, `exec command node ${comm}`,
    `builtin -- node ${comm}`, `builtin command builtin node ${comm}`, `exec -a altered builtin node ${comm}`,
    `NODE_OPTIONS='--import=x --require=hookB' bash -c '${inner}'`, `NODE_OPTIONS=--require=hookB eval '${inner}'`,
    `NODE_OPTIONS+=' --require=hookB'; ${inner}`,
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'active', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
      assert.equal(attr.turn.focus, null, `${tool}: ${cmd}`);
      attr.handle({ t: 'turn_end', at: 1 });
      assert.deepEqual(finishes, [], `${tool}: ${cmd}`);
    }
  }
});

test('review R11: two A owners — prefixes that really run node, and an unrelated env prefix, mark only the earliest A', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  const inner = `node src/cli/comm.js comm.send "{\\"conversationId\\":\\"${CONV_A}\\"}"`;
  for (const cmd of [
    `builtin command node ${comm}`, `builtin exec node ${comm}`, `command -p node ${comm}`, `command -- node ${comm}`,
    `time -p node ${comm}`, `FOO=1 bash -c '${inner}'`,
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(cmd)));
      assert.equal(a1.state, 'replied', `${tool}: ${cmd}`);
      assert.equal(a2.state, 'active', `${tool}: ${cmd}`);
    }
  }
});

// ── review R12 ──
test('review R12: two A owners — a wrapper that exits early (help / version / bad operand) marks nobody and closes nothing; valid shapes mark the earliest A', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  for (const [pre, runs] of [
    ['timeout --help 5 node', false], ['timeout --version 5 node', false], ['timeout --bogus 5 node', false], ['timeout nope node', false],
    ['timeout -s INVALID 5 node', false], ['timeout -k nope 5 node', false], ['nice -n nope node', false], ['nohup --help node', false],
    ['timeout -s KILL 5 node', true], ['timeout -k 1 5 node', true], ['timeout --signal=KILL 5 node', true],
    ['timeout --kill-after=1 5 node', true], ['nice -n 5 node', true], ['nice --adjustment=5 node', true],
  ]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(`${pre} ${comm}`)));
      assert.equal(a1.state, runs ? 'replied' : 'active', `${tool}: ${pre}`);
      assert.equal(a2.state, 'active', `${tool}: ${pre}`);
      if (!runs) {
        assert.equal(attr.turn.focus, null, `${tool}: ${pre}`);
        attr.handle({ t: 'turn_end', at: 1 });
        assert.deepEqual(finishes, [], `${tool}: ${pre}`);
      }
    }
  }
});

test('review R13: two A owners — timeout -s 32/33 marks nobody and closes nothing; -s 34 marks the earliest A', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${CONV_A}"}'`;
  for (const [pre, runs] of [['timeout -s 32 5 node', false], ['timeout --signal=33 5 node', false], ['timeout -s32 -sKILL 5 node', false], ['timeout -s 34 5 node', true], ['timeout -s 0 5 node', true]]) {
    for (const [tool, wrap] of R9_TOOLS) {
      const { attr, mkRun, finishes } = harness();
      const a1 = mkRun('r_0000000a', CONV_A);
      const a2 = mkRun('r_0000000b', CONV_A);
      attr.handle(input('user', omBody(a1)));
      attr.handle(input('queued_command', omBody(a2)));
      attr.handle(toolStart('t1', tool, wrap(`${pre} ${comm}`)));
      assert.equal(a1.state, runs ? 'replied' : 'active', `${tool}: ${pre}`);
      assert.equal(a2.state, 'active', `${tool}: ${pre}`);
      if (!runs) {
        assert.equal(attr.turn.focus, null, `${tool}: ${pre}`);
        attr.handle({ t: 'turn_end', at: 1 });
        assert.deepEqual(finishes, [], `${tool}: ${pre}`);
      }
    }
  }
});

// ── v3 (#137 v4): objects, details, wait polls ─────────────────────────────

test('v3: a step carries its object at the start and its detail at the end; raw input / output never stored', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('t1', 'WebSearch', { query: '七大地理分区' }, 1));
  assert.equal(a._pushed[0].object, '七大地理分区');
  attr.handle({ t: 'tool_end', callId: 't1', isError: false, at: 3,
    result: { text: 'summary text', meta: { results: [{ tool_use_id: 's', content: [{ title: 'A', url: 'https://a.example.com/x?token=t' }] }] } } });
  assert.deepEqual(a.events[0].detail, { type: 'links', total: 1, truncated: false, items: [{ title: 'A', url: 'https://a.example.com/x', site: 'a.example.com' }] });
  attr.handle(toolStart('t2', 'Write', { file_path: '/w/.env', content: 'A=1\nAPI_KEY=sk-abcdefghijklmnopqrst\n' }, 4));
  assert.equal(a.events[1].live_preview, true);
  assert.equal(a.events[1].detail.preview, 'A=1\nAPI_KEY=[已隐藏]\n', 'the stored preview is already redacted');
  attr.handle({ t: 'tool_end', callId: 't2', isError: false, at: 5, result: { text: 'ok', meta: { type: 'create', structuredPatch: [] } } });
  assert.equal(a.events[1].detail.added, 2);
  attr.handle(toolStart('t3', 'Bash', { command: 'npm test', description: 'Run tests' }, 6));
  attr.handle({ t: 'tool_end', callId: 't3', isError: true, at: 8, result: { text: 'Exit code 1\nFAIL secret', meta: { stdout: 'FAIL secret', stderr: '' } } });
  assert.deepEqual(a.events[2].detail, { type: 'output', exit_code: 1, lines: 1, truncated: false });
  const stored = JSON.stringify(a.events);
  for (const leak of ['sk-abcdef', 'summary text', 'FAIL secret', 'npm test', 'token=t']) assert.equal(stored.includes(leak), false, leak);
  assert.equal(a.step_count, 3);
});

test('v3: a Codex exec session still running stays one running step; write_stdin polls are merged into it, not steps', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('c1', 'exec_command', { cmd: 'npm run build' }, 1));
  attr.handle({ t: 'tool_end', callId: 'c1', isError: false, at: 2, running: true, sessionId: '7', result: { text: 'Process running with session ID 7\nOutput:\n' } });
  assert.deepEqual(kinds(a), ['tool:command'], 'no end yet');
  attr.handle(toolStart('p1', 'write_stdin', { session_id: 7, chars: '' }, 3));
  attr.handle({ t: 'tool_end', callId: 'p1', isError: false, at: 4, running: true, sessionId: '7', result: { text: 'Process running with session ID 7' } });
  attr.handle(toolStart('p2', 'write_stdin', { session_id: 7, chars: '' }, 5));
  assert.deepEqual(kinds(a), ['tool:command'], 'polls are not steps');
  assert.equal(a.step_count, 1, 'nor counted');
  attr.handle({ t: 'tool_end', callId: 'p2', isError: true, at: 9, result: { text: 'Process exited with code 2\nOutput:\nerr\n', exitCode: 2 } });
  assert.deepEqual(kinds(a), ['tool:command', 'tool:command:end']);
  assert.equal(a.events[0].ended_at, 9);
  assert.equal(a.events[0].error, true);
  assert.deepEqual(a.events[0].detail, { type: 'output', exit_code: 2, lines: 1, truncated: false });
  // A poll on an unknown session: nothing.
  attr.handle(toolStart('p3', 'write_stdin', { session_id: 99 }, 10));
  attr.handle({ t: 'tool_end', callId: 'p3', isError: false, at: 11, result: { text: 'x' } });
  assert.equal(kinds(a).length, 2);
  assert.equal(a.step_count, 1);
});

test('v3: Claude TaskOutput / BashOutput polls are neither steps nor counted', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('b1', 'Bash', { command: 'sleep 100', run_in_background: true, description: 'Long job' }, 1));
  attr.handle({ t: 'tool_end', callId: 'b1', isError: false, at: 2, result: { text: 'started', meta: { stdout: '', stderr: '', backgroundTaskId: 'bg1' } } });
  attr.handle(toolStart('o1', 'TaskOutput', { task_id: 'bg1' }, 3));
  attr.handle(toolStart('o2', 'BashOutput', { bash_id: 'bg1' }, 3));
  attr.handle(toolEnd('o1', 4));
  assert.deepEqual(kinds(a), ['tool:command', 'tool:command:end']);
  assert.equal(a.events[0].detail, undefined, 'a background launch has no output detail');
  assert.equal(a.step_count, 1);
});

test('v3: a retry is a new step and a new count; parallel calls are separate steps', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(input('user', omBody(a)));
  attr.handle(toolStart('x1', 'WebFetch', { url: 'https://a.example.com' }, 1));
  attr.handle(toolStart('x2', 'WebFetch', { url: 'https://b.example.com' }, 1));
  attr.handle(toolEnd('x1', 2, true));
  attr.handle(toolEnd('x2', 3));
  attr.handle(toolStart('x3', 'WebFetch', { url: 'https://a.example.com' }, 4));
  assert.equal(a.step_count, 3);
  assert.deepEqual(a.events.map((e) => [e.object, e.error ?? null]), [['a.example.com', true], ['b.example.com', false], ['a.example.com', null]]);
});

// ── 10-22: merged inputs (several C4 messages delivered as ONE runtime input) ──

/** An input as the adapters build it: one segment per C4 message. */
const minput = (form, content, at = 0) => ({
  t: 'input', form, head: content.slice(0, 120), ctx: parseInputCtx(content), segments: splitInputSegments(content), at,
});
const SPILL = (id) => `/h/zylos/comm-bridge/attachments/conv-${id}/message.txt`;
/** A truncated C4 body (preview + spill notice + reply-via), as INT showed it. */
function spilledBody(prefix, id, ch, ep) {
  return `${prefix}\n<current-message>\n...\n\n[C4] ⚠️ TRUNCATED — the text above is only a preview (0.1KB of 1.2KB). Before acting or replying you MUST read the complete message file: ${SPILL(id)}${REPLY_VIA(ch, ep)}`;
}
const LARK_EP = 'oc_96|type:p2p|msg:om_1';
const sendTo = (ch, ep) => ({ command: `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "${ch}" "${ep}" <<'EOF'\nhi\nEOF` });

test('merged input, Lark first then the marked openmax message (INT 10-21): the run opens; Lark work is not its; after the Lark reply its steps are', () => {
  const { attr, mkRun, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 52 });
  // Exactly how the runtime concatenates: no separator after the closing quote.
  const merged = spilledBody('[Lark DM]', 51, 'lark', LARK_EP) + spilledBody(`${formatMarker(a.run_id)}[OPENMAX DM] (org: Acme)`, 52, 'openmax', CONV_A);
  attr.handle(minput('user', merged));
  assert.equal(a.state, 'active', 'the marker in the middle of the input is recognised');
  assert.equal(a._state, 'thinking');
  assert.deepEqual(attr.turn.owners, [a]);
  assert.equal(attr.turn.focus, null, 'the Lark message comes first: no focus yet');
  assert.equal(stats.merged_inputs, 1);

  attr.handle(toolStart('t1', 'Read', { file_path: SPILL(51) }));          // reads the Lark message
  attr.handle(toolStart('t2', 'Bash', { command: 'ls /lark/stuff' }));
  attr.handle(commentary('answering the Lark question'));
  attr.handle(toolStart('t3', 'Bash', sendTo('lark', LARK_EP)));           // Lark answered
  assert.deepEqual(kinds(a), ['notice:merged_turn'], 'no Lark work on the openmax run');
  assert.equal(attr.turn.focus, a, 'the Lark reply hands focus to the next message: the run');
  assert.equal(attr.turn.blocked, false, 'answering a known merged-in message is not ③');

  attr.handle(toolStart('t4', 'Read', { file_path: SPILL(52) }));
  attr.handle(toolStart('t5', 'Grep', { pattern: 'price' }));
  assert.deepEqual(kinds(a), ['notice:merged_turn', 'tool:read', 'tool:search_files']);
  attr.handle(toolStart('t6', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(a.state, 'replied');
});

test('merged input, openmax first then Lark: the run has focus; a Lark spill read pauses it; the Lark reply returns it', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A, { c4: 52 });
  const merged = spilledBody(`${formatMarker(a.run_id)}[OPENMAX DM] (org: Acme)`, 52, 'openmax', CONV_A) + spilledBody('[Lark DM]', 53, 'lark', LARK_EP);
  attr.handle(minput('user', merged));
  assert.equal(attr.turn.focus, a, 'queue order: the openmax message is first');
  attr.handle(toolStart('t1', 'Glob', { pattern: '*.md' }));
  attr.handle(toolStart('t2', 'Read', { file_path: SPILL(53) }));          // switches to the Lark message
  assert.equal(attr.turn.focus, null);
  attr.handle(toolStart('t3', 'Bash', { command: 'ls /lark' }));
  attr.handle(toolStart('t4', 'Bash', sendTo('lark', 'oc_96|type:p2p|msg:om_OTHER')));   // same chat, other msg id
  assert.equal(attr.turn.focus, a);
  attr.handle(toolStart('t5', 'WebSearch', { query: 'q' }));
  assert.deepEqual(kinds(a), ['notice:merged_turn', 'tool:search_files', 'tool:search_web']);
});

test('merged input with two openmax markers: each maps to its own run, answered in order', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_B, { c4: 61 });
  attr.handle(minput('user', omBody(a) + omBody(b)));
  assert.deepEqual(attr.turn.owners, [a, b]);
  assert.equal(a.state, 'active');
  assert.equal(b.state, 'active');
  assert.equal(attr.turn.foreign, false);
  assert.equal(attr.turn.focus, null, 'two conversations: ④ stays conservative (no focus without ① / ②)');
  attr.handle(toolStart('t1', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(a.state, 'replied');
  assert.equal(attr.turn.focus, null, 'owners in two conversations: still no implicit focus (existing ④ rule)');
  attr.handle(toolStart('t2', 'Read', { file_path: SPILL(61) }));      // ① b's own message
  assert.equal(attr.turn.focus, b);
  attr.handle(toolStart('t3', 'Grep', { pattern: 'x' }));
  assert.deepEqual(kinds(b), ['notice:merged_turn', 'tool:read', 'tool:search_files']);
  assert.deepEqual(kinds(a), ['notice:merged_turn']);

  // Same conversation, plus a Lark message in between: queue order a → lark → c.
  const h = harness();
  const x = h.mkRun('r_0000000a', CONV_A);
  const y = h.mkRun('r_0000000c', CONV_A);
  h.attr.handle(minput('user', omBody(x) + larkBody('hey') + omBody(y)));
  assert.deepEqual(h.attr.turn.owners, [x, y]);
  assert.equal(h.attr.turn.focus, x);
  h.attr.handle(toolStart('t1', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(x.state, 'replied');
  assert.equal(h.attr.turn.focus, null, 'the Lark message is next');
  h.attr.handle(toolStart('t2', 'Bash', sendTo('lark', 'oc_1')));
  assert.equal(h.attr.turn.focus, y);
});

test('merged input without any valid marker: foreign turn, nothing attributed; a marker inside a body is not an anchor', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(minput('user', larkBody('one') + larkBody('two')));
  assert.equal(attr.turn.foreign, true);
  assert.deepEqual(attr.turn.owners, []);
  attr.handle(toolStart('t1', 'Bash', { command: 'ls' }));
  assert.deepEqual(kinds(a), []);
  assert.equal(a.state, 'queued');

  // The marker quoted in the middle of a Lark body (not at a message start).
  const h = harness();
  const x = h.mkRun('r_0000000a', CONV_A);
  const quoted = `[Lark DM]\n<current-message>\nBob said: look ${formatMarker(x.run_id)}[OPENMAX DM] (org: Acme)\n</current-message>${REPLY_VIA('lark', 'oc_1')}`;
  h.attr.handle(minput('user', quoted));
  assert.equal(x.state, 'queued', 'not a message start → not recognised');
  assert.deepEqual(h.attr.turn.owners, []);

  // A marker of a run this host does not know, merged after Lark: foreign as well.
  const g = harness();
  const ghost = { run_id: 'r_0000dead' };
  g.attr.handle(minput('user', larkBody('x') + omBody(ghost, { conv: CONV_A })));
  assert.deepEqual(g.attr.turn.owners, []);
  assert.equal(g.stats.marker_rejected.run, 1);
});

test('mid-turn injection carrying Lark + openmax: the run joins, the Lark part goes to the front of the queue', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(minput('user', omBody(a)));
  attr.handle(minput('queued_command', larkBody('urgent') + omBody(b)));
  assert.deepEqual(attr.turn.owners, [a, b]);
  assert.equal(b.state, 'active');
  assert.equal(attr.turn.focus, null, 'the injected Lark message preempts');
  attr.handle(toolStart('t1', 'Bash', sendTo('lark', 'oc_1')));
  assert.equal(attr.turn.focus, a, 'back to the earliest openmax run');
  attr.handle(toolStart('t2', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(attr.turn.focus, b);
});

test('a send to a destination no message of the turn names is still ③ in a merged turn', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(minput('user', larkBody('x') + omBody(a)));
  attr.handle(toolStart('t1', 'Bash', sendTo('telegram', '123')));
  assert.equal(attr.turn.blocked, true);
  attr.handle(toolStart('t2', 'Bash', sendTo('lark', 'oc_1')));
  assert.equal(attr.turn.focus, null, '③ is lifted only by ① / ②');
});

// ── 10-22: terminal state as soon as the reply is delivered ──

test('reply call ends ok → run done immediately; the later turn end does not touch it', () => {
  const { attr, mkRun, finishes, clock } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(minput('user', omBody(a)));
  attr.handle(toolStart('t1', 'Grep', { pattern: 'x' }));
  attr.handle(toolStart('t2', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(a.state, 'replied');
  assert.deepEqual(finishes, [], 'the send has not finished yet');
  clock.advance(500);
  attr.handle(toolEnd('t2', 1));
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);
  assert.equal(a.state, 'closed');
  assert.equal(a.closed_on_reply, true);
  const endedAt = a.ended_at;
  clock.advance(20_000);
  attr.handle(commentary('memory update after the reply'));
  attr.handle({ t: 'turn_end', at: 2 });
  clock.advance(60 * 60 * 1000);
  attr.tick();
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]], 'exactly one terminal frame');
  assert.equal(a.ended_at, endedAt, 'the end time is the reply time');
  assert.deepEqual(kinds(a), ['tool:search_files'], 'nothing after the reply');
});

test('send.js claim delivered → done; idempotent with the log; never regressed by turn end / restart', () => {
  const { attr, mkRun, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(minput('user', omBody(a)));
  attr.noteReplyClaim(a.run_id);                      // pending claim: replied, still open
  assert.equal(a.state, 'replied');
  assert.deepEqual(finishes, []);
  assert.equal(attr.noteReplyDelivered(a.run_id), true);
  assert.equal(attr.noteReplyDelivered(a.run_id), false, 'second report is a no-op');
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);
  attr.noteRuntimeRestart();
  attr.handle({ t: 'turn_end', at: 3, interrupted: true });
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);
  assert.equal(a.state, 'closed');

  // Delivered straight away (no pending tick seen) also works.
  const h = harness();
  const b = h.mkRun('r_0000000b', CONV_A);
  h.attr.handle(minput('user', omBody(b)));
  h.attr.noteReplyDelivered(b.run_id);
  assert.deepEqual(h.finishes, [['r_0000000b', 'done', null]]);
});

test('reply call fails → no completion, replied undone; normal turn-end rules apply; a later good reply completes', () => {
  const { attr, mkRun, finishes, clock, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  attr.handle(minput('user', omBody(a)));
  attr.handle(toolStart('t1', 'Bash', sendTo('openmax', CONV_A)));
  assert.equal(a.state, 'replied');
  attr.handle(toolEnd('t1', 1, true));
  assert.deepEqual(finishes, [], 'a failed send never completes the run');
  assert.equal(a.state, 'active');
  assert.equal(attr.turn.focus, a, 'the run keeps its focus: the agent will retry');
  assert.equal(stats.reply_failed, 1);
  attr.handle(toolStart('t2', 'Grep', { pattern: 'why' }));
  assert.deepEqual(kinds(a), ['tool:search_files']);

  // Retry succeeds.
  attr.handle(toolStart('t3', 'Bash', sendTo('openmax', CONV_A)));
  attr.handle(toolEnd('t3', 2));
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]]);

  // No retry: the turn ends, the 120 s no-reply grace decides.
  const h = harness();
  const b = h.mkRun('r_0000000b', CONV_A);
  h.attr.handle(minput('user', omBody(b)));
  h.attr.handle(toolStart('t1', 'Bash', sendTo('openmax', CONV_A)));
  h.attr.handle(toolEnd('t1', 1, true));
  h.attr.handle({ t: 'turn_end', at: 2 });
  assert.deepEqual(h.finishes, [], 'not done at turn end: the reply failed');
  h.clock.advance(120_000);
  h.attr.tick();
  assert.deepEqual(h.finishes, [['r_0000000b', 'done', 'no_reply']]);
});

// ── 10-22 R2 ──

test('R2-1: a failed send to the merged-in Lark message puts it back to pending — its continued work never reaches the openmax run (contrast: success)', () => {
  for (const ok of [true, false]) {
    const { attr, mkRun, stats } = harness();
    const a = mkRun('r_0000000a', CONV_A);
    attr.handle(minput('user', larkBody('first') + omBody(a)));
    attr.handle(toolStart('l1', 'Bash', sendTo('lark', 'oc_1')));
    assert.equal(attr.turn.focus, a, 'optimistic at the call start');
    attr.handle(toolEnd('l1', 1, !ok));
    if (ok) {
      assert.equal(attr.turn.focus, a);
      attr.handle(commentary('now the openmax part'));
      attr.handle(toolStart('o1', 'Grep', { pattern: 'p' }));
      assert.deepEqual(kinds(a), ['notice:merged_turn', 'commentary', 'tool:search_files']);
      continue;
    }
    assert.equal(attr.turn.focus, null, 'the Lark message is still unanswered');
    assert.equal(stats.foreign_send_failed, 1);
    attr.handle(commentary('Lark send failed, retrying with a shorter text'));
    attr.handle(toolStart('l2', 'Bash', { command: 'ls /lark' }));
    assert.deepEqual(kinds(a), ['notice:merged_turn'], 'no Lark work on the openmax run');
    // The retry succeeds: now the queue moves on.
    attr.handle(toolStart('l3', 'Bash', sendTo('lark', 'oc_1')));
    attr.handle(toolEnd('l3', 2));
    assert.equal(attr.turn.focus, a);
    attr.handle(toolStart('o1', 'Grep', { pattern: 'p' }));
    assert.deepEqual(kinds(a), ['notice:merged_turn', 'tool:search_files']);
  }
});

test('R2-1: a failed send to a Lark message that was behind the run returns it to the front as well; a failed send of an op answering Lark + openmax reverts both', () => {
  const { attr, mkRun } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const b = mkRun('r_0000000b', CONV_A);
  attr.handle(minput('user', omBody(a) + larkBody('x') + omBody(b)));
  attr.handle(toolStart('s1', 'Bash', { command: `${sendTo('openmax', CONV_A).command}\nnode /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "oc_1" "hi"` }));
  assert.equal(a.state, 'replied');
  attr.handle(toolEnd('s1', 1, true));
  assert.equal(a.state, 'active', 'the openmax reply is undone');
  assert.equal(attr.turn.focus, null, 'the Lark message is pending again, in front');
  assert.equal(attr.turn.queue[0].foreign, true);
  attr.handle(toolStart('x', 'Grep', { pattern: 'q' }));
  assert.deepEqual(kinds(b), ['notice:merged_turn']);
  assert.deepEqual(kinds(a), ['notice:merged_turn']);
});

/** Codex records through the real adapter into attribution. */
function codexFeed(attr) {
  const st = createCodexState();
  const TS = '2026-10-22T08:00:00.000Z';
  return (payload) => {
    const res = parseCodexRecord({ timestamp: TS, type: 'response_item', payload }, st);
    assert.equal(res.status, 'ok', JSON.stringify(payload));
    for (const ev of res.events) attr.handle(ev);
  };
}
const codexUser = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const codexExec = (id, cmd) => ({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: id });
const codexPoll = (id, sid) => ({ type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: sid, chars: '' }), call_id: id });
const codexOut = (id, output) => ({ type: 'function_call_output', call_id: id, output });
const RUNNING = (sid) => `Chunk ID: 1\nWall time: 10.0 seconds\nProcess running with session ID ${sid}\nOutput:\n`;
const EXITED = (code) => `Chunk ID: 2\nWall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n${code ? 'HTTP 500' : 'ok'}\n`;
const codexSend = (ch, ep) => `node /h/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "${ch}" "${ep}" <<'EOF'\nhi\nEOF`;

test('R2-2 Codex: a reply still running in an exec session is settled by the poll that sees it exit — exit 0 → done at once, repeated polls / claim idempotent', () => {
  const { attr, mkRun, finishes } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const feed = codexFeed(attr);
  feed(codexUser(omBody(a)));
  feed(codexExec('c1', codexSend('openmax', CONV_A)));
  assert.equal(a.state, 'replied');
  feed(codexOut('c1', RUNNING(7)));
  assert.deepEqual(finishes, [], 'still running: not done');
  feed(codexPoll('p1', 7));
  feed(codexOut('p1', RUNNING(7)));
  assert.deepEqual(finishes, [], 'a poll that sees it still running settles nothing');
  feed(codexPoll('p2', 7));
  feed(codexOut('p2', EXITED(0)));
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]], 'done on the poll that sees exit 0');
  feed(codexPoll('p3', 7));
  feed(codexOut('p3', EXITED(0)));
  attr.noteReplyDelivered(a.run_id);
  attr.handle({ t: 'turn_end', at: 9 });
  assert.deepEqual(finishes, [['r_0000000a', 'done', null]], 'one terminal frame');
});

test('R2-2 Codex: exit 1 on the poll undoes replied (no completion, no-reply rules); claim first then a failing poll never reopens a closed run', () => {
  const { attr, mkRun, finishes, clock, stats } = harness();
  const a = mkRun('r_0000000a', CONV_A);
  const feed = codexFeed(attr);
  feed(codexUser(omBody(a)));
  feed(codexExec('c1', codexSend('openmax', CONV_A)));
  feed(codexOut('c1', RUNNING(8)));
  feed(codexPoll('p1', 8));
  feed(codexOut('p1', EXITED(1)));
  assert.equal(a.state, 'active');
  assert.equal(stats.reply_failed, 1);
  assert.deepEqual(finishes, []);
  feed(codexPoll('p2', 8));
  feed(codexOut('p2', EXITED(1)));
  assert.equal(stats.reply_failed, 1, 'a repeated poll settles nothing twice');
  attr.handle({ t: 'turn_end', at: 9 });
  assert.deepEqual(finishes, []);
  clock.advance(120_000);
  attr.tick();
  assert.deepEqual(finishes, [['r_0000000a', 'done', 'no_reply']]);

  const h = harness();
  const b = h.mkRun('r_0000000b', CONV_A);
  const feed2 = codexFeed(h.attr);
  feed2(codexUser(omBody(b)));
  feed2(codexExec('c1', codexSend('openmax', CONV_A)));
  feed2(codexOut('c1', RUNNING(9)));
  h.attr.noteReplyDelivered(b.run_id);               // send.js saw the 2xx first
  feed2(codexPoll('p1', 9));
  feed2(codexOut('p1', EXITED(1)));                   // e.g. a later command in the same script failed
  assert.equal(b.state, 'closed');
  assert.deepEqual(h.finishes, [['r_0000000b', 'done', null]]);
});

test('R2-2 Codex: a failed Lark send in an exec session reopens the Lark message on the poll; success moves the queue on', () => {
  for (const code of [0, 1]) {
    const { attr, mkRun } = harness();
    const a = mkRun('r_0000000a', CONV_A);
    const feed = codexFeed(attr);
    feed(codexUser(larkBody('first') + omBody(a)));
    feed(codexExec('l1', codexSend('lark', 'oc_1')));
    feed(codexOut('l1', RUNNING(5)));
    feed(codexPoll('p1', 5));
    feed(codexOut('p1', EXITED(code)));
    assert.equal(attr.turn.focus, code === 0 ? a : null);
  }
});
