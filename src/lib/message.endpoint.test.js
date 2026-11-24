import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseEndpoint, formatEndpoint } from './message.js';

// OPENM-1337: the `reply via` endpoint names the inbound message it answers
// (`|msg:<sourceMessageId>`), so the reply selects that message's run. It is
// routing-neutral: no quote (`reply:` is the quote), no change of target.

const CONV = '01a18649-b095-7add-bfa6-9b405ec30433';
const THREAD = '019f0000-aaaa-7bbb-8ccc-000000000abc';
const MSG = '7300000000000000132';

test('1337: format puts msg last; parse reads it back as sourceMessageId — DM / group, typed, quote', () => {
  const shapes = [
    { conversationId: CONV },
    { conversationId: CONV, endpointType: 'group' },
    { conversationId: CONV, replyTo: '7300000000000000002' },
    { conversationId: CONV, endpointType: 'dm', replyTo: '7300000000000000002' },
  ];
  for (const ep of shapes) {
    const s = formatEndpoint({ ...ep, sourceMessageId: MSG });
    assert.ok(s.endsWith(`|msg:${MSG}`), s);
    const back = parseEndpoint(s);
    assert.equal(back.sourceMessageId, MSG);
    assert.equal(back.conversationId, CONV);
    assert.equal(back.endpointType, ep.endpointType);
    assert.equal(back.replyTo, ep.replyTo, 'msg is not a quote');
  }
  // |type: right after the id, |msg: last.
  assert.equal(formatEndpoint({ conversationId: CONV, endpointType: 'group', replyTo: '1', sourceMessageId: MSG }),
    `${CONV}|type:group|reply:1|msg:${MSG}`);
});

test('1337: an endpoint without msg is unchanged both ways (old endpoints, edit notices)', () => {
  assert.equal(formatEndpoint({ type: 'group', conversationId: CONV }), CONV);
  assert.equal(formatEndpoint({ conversationId: CONV, sourceMessageId: '' }), CONV);
  assert.deepEqual(parseEndpoint(CONV), { conversationId: CONV });
});

test('T3: without endpointType the endpoint is the pre-multi-session form (no |type:, no thread segments)', () => {
  // ep.type (the platform type) never reaches the string; only endpointType does.
  assert.equal(formatEndpoint({ type: 'dm', conversationId: CONV, sourceMessageId: MSG }), `${CONV}|msg:${MSG}`);
  assert.equal(formatEndpoint({ type: 'group', conversationId: CONV, replyTo: '5', sourceMessageId: MSG }), `${CONV}|reply:5|msg:${MSG}`);
  // The removed thread fields are not written even if a caller still passes them.
  assert.equal(formatEndpoint({ conversationId: CONV, threadConversationId: THREAD, parentMessageId: '1', sourceMessageId: MSG }),
    `${CONV}|msg:${MSG}`);
});

test('T11: a legacy thread endpoint parses to its leading conversation, flagged, thread / parent dropped', () => {
  for (const s of [`${CONV}|thread:${THREAD}|parent:9|msg:${MSG}`, `[OPENMAX THREAD]/${CONV}|thread:${THREAD}`, `${CONV}|parent:9`]) {
    const ep = parseEndpoint(s);
    assert.equal(ep.conversationId, CONV, s);
    assert.equal(ep.legacyThread, true, s);
    assert.equal('threadConversationId' in ep, false);
    assert.equal('parentMessageId' in ep, false);
    assert.equal('replyTo' in ep, false, 'a thread parent is no quote in the leading conversation');
  }
  assert.equal('legacyThread' in parseEndpoint(`${CONV}|type:group|msg:1`), false);
});

test('1337: legacy prefix, unknown and empty segments still parse; an empty msg is no source', () => {
  const legacy = parseEndpoint(`[OPENMAX GROUP]/${CONV}|msg:${MSG}`);
  assert.equal(legacy.conversationId, CONV);
  assert.equal('endpointType' in legacy, false, 'the legacy prefix type is not trusted');
  assert.equal(legacy.sourceMessageId, MSG);
  const odd = parseEndpoint(`${CONV}|foo:bar|req:1||msg:${MSG}`);
  assert.equal(odd.conversationId, CONV);
  assert.equal(odd.sourceMessageId, MSG);
  assert.equal('sourceMessageId' in parseEndpoint(`${CONV}|msg:`), false);
  assert.equal('sourceMessageId' in parseEndpoint(`${CONV}|msg: `), false);
  assert.equal('endpointType' in parseEndpoint(`${CONV}|type:|msg:1`), false);
});

test('1337: comm-bridge builds the inbound endpoint with msg = the run\'s source message (one value for both)', () => {
  const bridge = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');
  const decl = bridge.match(/const sourceMessageId = (.+);/);
  assert.ok(decl, 'one sourceMessageId computed before the endpoint');
  assert.equal(decl[1], 'String(replyTarget.redirected ? (replyTarget.cardMessageId || msg.id) : msg.id)',
    'a redirected receipt names its card');
  const ep = bridge.slice(bridge.indexOf(decl[0]));
  assert.match(ep, /const endpoint = formatEndpoint\(\{[\s\S]*?\n {6}sourceMessageId,\n {4}\}\);/);
  assert.match(bridge, /activity\.registerRun\(\{[\s\S]*?\n {8}sourceMessageId,\n {8}endpoint,/);
  // The edit notice registers no run; its endpoint gains only the kind (and a
  // platform topic's parent) on a multi-session Core.
  assert.match(bridge, /formatEndpoint\(\{ type: convType, \.\.\.sessionEndpoint, conversationId \}\)/);
});

test('1337: SKILL.md tells the agent to copy the reply via endpoint verbatim, |msg: included, one per message', () => {
  const SKILL = fs.readFileSync(fileURLToPath(new URL('../../SKILL.md', import.meta.url)), 'utf8');
  const rule = SKILL.split('\n').find((l) => l.includes('Every inbound message carries a `reply via:'));
  assert.ok(rule, 'SKILL.md has the reply-path rule');
  assert.match(rule, /c4-send\.js "openmax" "<endpoint>"/);
  assert.match(rule, /verbatim, including its trailing `\|msg:<id>`/);
  assert.match(rule, /answer each with its own `reply via` line/);
  assert.equal(SKILL.includes('c4-send.js openmax "<conversationId>"'), false, 'no example drops the msg segment');
});
