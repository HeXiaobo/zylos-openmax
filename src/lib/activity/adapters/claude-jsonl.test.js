import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClaudeRecord } from './claude-jsonl.js';

// Structure-only fixtures in the shape of local Claude Code 2.1.x logs.
const SID = '11111111-2222-3333-4444-555555555555';
const TS = '2026-10-09T08:12:03.512Z';
const AT = Date.parse(TS);
const base = (o) => ({ isSidechain: false, sessionId: SID, timestamp: TS, uuid: 'u1', ...o });
const parse = (rec) => parseClaudeRecord(rec, { sessionId: SID });

test('user string → input/user with head ≤ 120 and ctx', () => {
  const content = `[OM-RUN r_8c1f2a9d] [OPENMAX DM]\n<message-context conversation-id="c1" source-message-id="1"/>\n${'x'.repeat(300)} ---- reply via: node /x/c4-send.js "openmax" "c1"`;
  const r = parse(base({ type: 'user', message: { role: 'user', content } }));
  assert.equal(r.status, 'ok');
  const [ev] = r.events;
  assert.equal(ev.t, 'input');
  assert.equal(ev.form, 'user');
  assert.equal(ev.head.length, 120);
  assert.equal(ev.ctx.convAttr, 'c1');
  assert.deepEqual(ev.ctx.replyVia, { channel: 'openmax', endpoint: 'c1' });
  assert.equal(ev.at, AT);
  assert.equal(ev.key, 'u1');
});

test('queue operations and queued_command', () => {
  assert.equal(parse(base({ type: 'queue-operation', operation: 'enqueue', content: 'abc' })).events[0].form, 'enqueue');
  assert.equal(parse(base({ type: 'queue-operation', operation: 'dequeue' })).events[0].form, 'dequeue');
  assert.equal(parse(base({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: 'a' })).events[0].form, 'absorbed');
  assert.equal(parse(base({ type: 'queue-operation', operation: 'remove', reason: 'delivered_to_agent', content: 'a' })).status, 'ignored');
  const qc = parse(base({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'p', commandMode: 'prompt' } }));
  assert.equal(qc.events[0].form, 'queued_command');
  assert.equal(parse(base({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'p', commandMode: 'task-notification' } })).status, 'ignored');
  assert.equal(parse(base({ type: 'attachment', attachment: { type: 'environment' } })).status, 'ignored');
});

test('assistant text / tool_use, thinking dropped; tool_result (+ toolUseResult) handed on for the detail builder', () => {
  const r = parse(base({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.deepEqual(r.events.map((e) => e.t), ['commentary', 'tool_start']);
  assert.equal(r.events[1].callId, 'toolu_1');
  const res = parse(base({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'secret output' }] } }));
  assert.deepEqual(res.events, [{ t: 'tool_end', callId: 'toolu_1', isError: false, at: AT, result: { text: 'secret output' } }]);
  const err = parse(base({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }] } }));
  assert.equal(err.events[0].isError, true);
  assert.equal(err.events[0].result.text, '');
  // The structured result of the record's single tool_result; text blocks of an array content joined.
  const meta = { stdout: 'a\nb', stderr: '', interrupted: false };
  const one = parse(base({ type: 'user', toolUseResult: meta, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }] }] } }));
  assert.deepEqual(one.events[0].result, { text: 'x\ny', meta });
  const two = parse(base({ type: 'user', toolUseResult: meta, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b' }] } }));
  assert.equal(two.events.every((e) => e.result.meta === undefined), true, 'with several results the structured one is not attributed');
});

test('turn_duration → turn_end; other system subtypes and metadata records ignored', () => {
  assert.deepEqual(parse(base({ type: 'system', subtype: 'turn_duration', durationMs: 1 })).events, [{ t: 'turn_end', at: AT }]);
  assert.equal(parse(base({ type: 'system', subtype: 'stop_hook_summary' })).status, 'ignored');
  for (const type of ['file-history-snapshot', 'mode', 'ai-title', 'last-prompt', 'pr-link', 'atis-latch']) {
    assert.equal(parse(base({ type })).status, 'ignored', type);
  }
});

test('sidechain and foreign session records are filtered; isMeta ignored', () => {
  assert.equal(parse(base({ type: 'user', isSidechain: true, message: { content: 'x' } })).status, 'filtered');
  assert.equal(parse(base({ type: 'user', sessionId: 'other', message: { content: 'x' } })).status, 'filtered');
  assert.equal(parse(base({ type: 'user', isMeta: true, message: { content: 'x' } })).status, 'ignored');
});

test('fail closed: producing shapes with missing / mistyped paths are unknown', () => {
  assert.equal(parse(base({ type: 'assistant', message: { content: 'str' } })).status, 'unknown');
  assert.equal(parse(base({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })).status, 'unknown');
  assert.equal(parse(base({ type: 'assistant', message: { content: [{ type: 'brand_new_block' }] } })).status, 'unknown');
  assert.equal(parse(base({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).status, 'unknown');
  assert.equal(parse(base({ type: 'user', message: {} })).status, 'unknown');
  assert.equal(parse(base({ type: 'queue-operation', operation: 'enqueue' })).status, 'unknown');
  assert.equal(parse(base({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 3 } })).status, 'unknown');
  assert.equal(parse(base({ type: 'user', timestamp: 'nope', message: { content: 'x' } })).status, 'unknown');
  assert.equal(parse(null).status, 'unknown');
});

test('a merged user input (runtime queue) carries one segment per C4 message', () => {
  const rv = (ch, ep) => ` ---- reply via: node /h/c4-send.js "${ch}" "${ep}"`;
  const text = `[Lark DM]\nhi${rv('lark', 'oc_1')}[OM-RUN r_0123abcd] [OPENMAX DM] (org: A)\nyo${rv('openmax', 'c1')}`;
  for (const rec of [
    { type: 'user', message: { content: text } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text } },
  ]) {
    const { events } = parseClaudeRecord({ timestamp: '2026-10-21T00:00:00Z', uuid: 'u', ...rec });
    assert.equal(events[0].segments.length, 2);
    assert.ok(events[0].segments[1].head.startsWith('[OM-RUN r_0123abcd] '));
    assert.equal(events[0].segments[1].ctx.replyVia.endpoint, 'c1');
  }
});
