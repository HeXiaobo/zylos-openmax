import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexRecord, createCodexState, exitCodeOf } from './codex-rollout.js';

// Structure examples (not a local sample — no Codex host here); to be
// replaced by real rollout samples during integration.
const TS = '2026-10-09T08:12:03.000Z';
const AT = Date.parse(TS);
const ev = (payload) => ({ timestamp: TS, type: 'event_msg', payload });
const item = (payload) => ({ timestamp: TS, type: 'response_item', payload });

test('a full turn: task_started → user → commentary → function_call(+output) → custom_tool_call → task_complete', () => {
  const st = createCodexState();
  assert.deepEqual(parseCodexRecord(ev({ type: 'task_started', turn_id: 't1' }), st).events, []);
  assert.equal(st.turnId, 't1');
  const user = parseCodexRecord(item({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '# AGENTS.md instructions for x' },
    { type: 'input_text', text: '[OM-RUN r_8c1f2a9d] [OPENMAX DM] hi' },
  ] }), st);
  assert.equal(user.events[0].form, 'user');
  assert.ok(user.events[0].head.startsWith('[OM-RUN r_8c1f2a9d]'));
  const second = parseCodexRecord(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'more' }] }), st);
  assert.equal(second.events[0].form, 'queued_command');
  const c = parseCodexRecord(item({ type: 'message', role: 'assistant', phase: 'commentary', id: 'm1', content: [{ type: 'output_text', text: 'looking' }] }), st);
  assert.deepEqual(c.events, [{ t: 'commentary', text: 'looking', at: AT, key: 'm1' }]);
  assert.equal(parseCodexRecord(item({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'answer' }] }), st).status, 'ignored');
  const call = parseCodexRecord(item({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status"}', call_id: 'call_1' }), st);
  assert.deepEqual(call.events[0], { t: 'tool_start', callId: 'call_1', name: 'exec_command', input: { cmd: 'git status' }, at: AT });
  const out = parseCodexRecord(item({ type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 2\nboom' }), st);
  assert.deepEqual(out.events[0], { t: 'tool_end', callId: 'call_1', isError: true, at: AT });
  const patch = parseCodexRecord(item({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_2' }), st);
  assert.equal(patch.events[0].name, 'apply_patch');
  const done = parseCodexRecord(ev({ type: 'task_complete', turn_id: 't1' }), st);
  assert.deepEqual(done.events, [{ t: 'turn_end', at: AT, interrupted: false }]);
});

test('turn_aborted / task_interrupted → interrupted turn_end; mismatched turn ignored', () => {
  const st = createCodexState();
  parseCodexRecord(ev({ type: 'task_started', turn_id: 't1' }), st);
  assert.equal(parseCodexRecord(ev({ type: 'turn_aborted', turn_id: 't2' }), st).status, 'ignored');
  assert.equal(parseCodexRecord(ev({ type: 'turn_aborted', turn_id: 't1' }), st).events[0].interrupted, true);
});

test('exit code extraction', () => {
  assert.equal(exitCodeOf('Process exited with code 0'), 0);
  assert.equal(exitCodeOf('{"output":"x","metadata":{"exit_code":1}}'), 1);
  assert.equal(exitCodeOf('no code here'), null);
});

test('fail closed on unknown payload types and missing paths; discard list ignored', () => {
  const st = createCodexState();
  assert.equal(parseCodexRecord(item({ type: 'brand_new_item' }), st).status, 'unknown');
  assert.equal(parseCodexRecord(item({ type: 'function_call', name: 'x' }), st).status, 'unknown');
  assert.equal(parseCodexRecord(item({ type: 'function_call_output' }), st).status, 'unknown');
  assert.equal(parseCodexRecord(item({ type: 'message', role: 'user', content: 'x' }), st).status, 'unknown');
  assert.equal(parseCodexRecord(item({ type: 'reasoning', summary: [] }), st).status, 'ignored');
  assert.equal(parseCodexRecord({ timestamp: TS, type: 'turn_context', payload: {} }, st).status, 'ignored');
  assert.equal(parseCodexRecord({ timestamp: TS, type: 'session_meta', payload: {} }, st).status, 'ignored');
  assert.equal(parseCodexRecord(ev({ type: 'token_count' }), st).status, 'ignored');
});
