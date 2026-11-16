/**
 * Inbound hand-off to zylos-core (c4-receive): the old-Core argv is exactly
 * the pre-multi-session one, the session group is passed only when Core lists
 * the option, and every failure ends in one fixed notice without a blind
 * resend.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readInboundCaps, buildC4ReceiveArgs, forwardToC4, classifyC4Rejection,
  fetchConversationRecord, conversationKindPending,
  TRY_LATER, MAYBE_LOST, CARD_RETRY, C4_RECEIVE_TIMEOUT_MS,
} from './c4-receive.js';
import { formatEndpoint } from './message.js';

const G = '01a18649-b095-7add-bfa6-9b405ec30433';
const D = '019f6a84-3a1e-76dd-931d-0eea1cb3112a';
const MSG = '7300000000000000132';
const RECEIVE = '/x/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js';

// The pre-multi-session forwardToC4 argv (comm-bridge.js on origin/main 083c248).
function mainArgv(endpoint, body, priority) {
  const args = ['--channel', 'openmax', '--endpoint', endpoint, '--json'];
  if (Number.isInteger(priority) && priority >= 1 && priority <= 3) args.push('--priority', String(priority));
  args.push('--content', body);
  return [RECEIVE, ...args];
}

function coreDir(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-c4-receive-'));
  const receivePath = path.join(dir, 'c4-receive.js');
  if (options !== undefined) {
    fs.writeFileSync(path.join(dir, 'c4-receive-options.json'), typeof options === 'string' ? options : JSON.stringify(options));
  }
  return receivePath;
}

const NEW_CORE = { options: { '--channel': { takesValue: true }, '--session-group': { takesValue: true } } };

/** execFile stand-in: answers each call with the next scripted result. */
function fakeExec(results) {
  const calls = [];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const r = results.shift() || {};
    setImmediate(() => cb(r.error || null, r.stdout ?? '', r.stderr ?? ''));
  };
  return { impl, calls };
}

const quiet = { log: () => {}, warn: () => {} };

test('T3: options file missing / malformed / without the key → no session group', () => {
  assert.deepEqual(readInboundCaps(coreDir()), { sessionGroup: false });
  assert.deepEqual(readInboundCaps(coreDir('{not json')), { sessionGroup: false });
  assert.deepEqual(readInboundCaps(coreDir({ options: { '--channel': {} } })), { sessionGroup: false });
  assert.deepEqual(readInboundCaps(coreDir({ options: [] })), { sessionGroup: false });
  assert.deepEqual(readInboundCaps(coreDir(NEW_CORE)), { sessionGroup: true });
});

test('T3: old Core — endpoint and argv byte-identical to main (with and without priority)', async () => {
  const endpoint = formatEndpoint({ type: 'group', conversationId: G, sourceMessageId: MSG });
  assert.equal(endpoint, `${G}|msg:${MSG}`);
  for (const priority of [undefined, 1, 2, 3, 7]) {
    const { impl, calls } = fakeExec([{ stdout: '{"ok":true}' }]);
    // eslint-disable-next-line no-await-in-loop
    const r = await forwardToC4({ channel: 'openmax', endpoint, content: 'body', priority, caps: { sessionGroup: false } },
      { ...quiet, execFileImpl: impl, receivePath: RECEIVE });
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(calls[0].args, mainArgv(endpoint, 'body', priority));
    assert.equal(calls[0].file, process.execPath);
    assert.equal(calls[0].opts.timeout, 30000);
  }
  // Old Core never maps the endpoint: an untyped one is forwarded, not refused.
  const { impl } = fakeExec([{ stdout: '{"ok":true}' }]);
  const r = await forwardToC4({ channel: 'openmax', endpoint: D, content: 'b', caps: { sessionGroup: false } }, { ...quiet, execFileImpl: impl, receivePath: RECEIVE });
  assert.equal(r.outcome, 'sent');
});

test('T4: new Core — |type: right after the id, |msg: last, --session-group last in argv', async () => {
  const endpoint = formatEndpoint({ type: 'dm', endpointType: 'dm', conversationId: D, sourceMessageId: MSG });
  assert.equal(endpoint, `${D}|type:dm|msg:${MSG}`);
  const { impl, calls } = fakeExec([{ stdout: '{"ok":true}' }]);
  const r = await forwardToC4({ channel: 'openmax', endpoint, content: 'body', priority: 2, caps: { sessionGroup: true } },
    { ...quiet, execFileImpl: impl, receivePath: RECEIVE });
  assert.equal(r.outcome, 'sent');
  assert.equal(r.sessionGroup, `dm-${D}`);
  assert.deepEqual(calls[0].args, [...mainArgv(endpoint, 'body', 2), '--session-group', `dm-${D}`]);
  assert.deepEqual(buildC4ReceiveArgs({ channel: 'openmax', endpoint, content: 'b' }).includes('--session-group'), false);
});

test('T5: an endpoint with no mappable group on new Core is never sent (no overall group, no guess) → TRY_LATER', async () => {
  for (const endpoint of [`${G}|msg:1`, `${G}|type:strat|msg:1`, 'a.b|type:dm']) {
    const { impl, calls } = fakeExec([]);
    // eslint-disable-next-line no-await-in-loop
    const r = await forwardToC4({ channel: 'openmax', endpoint, content: 'b', caps: { sessionGroup: true } }, { ...quiet, execFileImpl: impl, receivePath: RECEIVE });
    assert.equal(r.outcome, 'no_group', endpoint);
    assert.equal(r.notice, TRY_LATER);
    assert.equal(calls.length, 0);
  }
});

test('T5: rejection classes by error.persisted — stored / not stored / uncertain; one call each, no resend', async () => {
  const rej = (persisted) => {
    const error = { code: 'X', message: 'core text for the agent', ...(persisted === 'absent' ? {} : { persisted }) };
    return { error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: JSON.stringify({ ok: false, error }) };
  };
  const cases = [
    [rej(['c4-1']), 'stored', null],
    [rej([]), 'not_stored', TRY_LATER],
    [rej(null), 'uncertain', MAYBE_LOST],
    [rej('absent'), 'uncertain', MAYBE_LOST],
  ];
  for (const [result, outcome, notice] of cases) {
    const warns = [];
    const { impl, calls } = fakeExec([result]);
    // eslint-disable-next-line no-await-in-loop
    const r = await forwardToC4({ channel: 'openmax', endpoint: `${G}|type:group|msg:1`, content: 'b', caps: { sessionGroup: true } },
      { log: () => {}, warn: (m) => warns.push(m), execFileImpl: impl, receivePath: RECEIVE });
    assert.equal(r.outcome, outcome);
    assert.equal(r.notice, notice);
    assert.equal(calls.length, 1, 'never resent');
    assert.ok(warns.some((w) => w.includes('(X') && w.includes(`group-${G}`)), 'the log names the code and the group');
    if (notice) assert.equal(notice.includes('core text'), false, 'the user never sees Core\'s text');
  }
  assert.equal(classifyC4Rejection({ error: { persisted: ['x'] } }), 'stored');
});

test('T5: timeout or a non-zero exit without JSON → MAYBE_LOST, not resent', async () => {
  for (const error of [Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), Object.assign(new Error('exit 2'), { code: 2 })]) {
    const { impl, calls } = fakeExec([{ error, stdout: 'not json' }]);
    // eslint-disable-next-line no-await-in-loop
    const r = await forwardToC4({ channel: 'openmax', endpoint: `${G}|type:group`, content: 'b', caps: { sessionGroup: true } }, { ...quiet, execFileImpl: impl, receivePath: RECEIVE });
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.notice, MAYBE_LOST);
    assert.equal(calls.length, 1);
  }
  assert.equal(C4_RECEIVE_TIMEOUT_MS, 30000, 'Q5: 30 seconds kept');
});

test('T5: a spawn failure is retried once (same argv, group kept); success after it, or MAYBE_LOST after two', async () => {
  const spawnErr = () => Object.assign(new Error('spawn EAGAIN'), { syscall: 'spawn /usr/bin/node', code: 'EAGAIN' });
  let { impl, calls } = fakeExec([{ error: spawnErr() }, { stdout: '{"ok":true}' }]);
  let r = await forwardToC4({ channel: 'openmax', endpoint: `${G}|type:group`, content: 'b', caps: { sessionGroup: true } },
    { ...quiet, execFileImpl: impl, receivePath: RECEIVE, retryDelayMs: 1 });
  assert.equal(r.outcome, 'sent');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(calls[1].args.at(-1), `group-${G}`);

  ({ impl, calls } = fakeExec([{ error: spawnErr() }, { error: spawnErr() }]));
  r = await forwardToC4({ channel: 'openmax', endpoint: `${G}|type:group`, content: 'b', caps: { sessionGroup: true } },
    { ...quiet, execFileImpl: impl, receivePath: RECEIVE, retryDelayMs: 1 });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.notice, MAYBE_LOST);
  assert.equal(calls.length, 2, 'exactly one retry');
});

test('Q6: the fixed notices are bilingual (Chinese line, then English)', () => {
  for (const notice of [TRY_LATER, MAYBE_LOST, CARD_RETRY]) {
    const [zh, en] = notice.split('\n');
    assert.match(zh, /[一-鿿]/);
    assert.match(en, /^Sorry, /);
  }
});

// --- bridge wiring (comm-bridge.js has side-effecting startup code, so its
// use of this module is checked on its source, as message-context.test.js does).

const BRIDGE = fs.readFileSync(new URL('../comm-bridge.js', import.meta.url), 'utf8');

test('T4: the bridge reads the capability once per message and uses that one result for the endpoint and the argv', () => {
  const handler = BRIDGE.slice(BRIDGE.indexOf('function makeOrgMessageHandler'), BRIDGE.indexOf('function shouldNoticeInboundFailure'));
  assert.equal(handler.match(/readInboundCaps\(\)/g).length, 1);
  assert.match(handler, /const caps = readInboundCaps\(\);[\s\S]*endpointType = conversationKindOf\(replyConv, replyConvId\);[\s\S]*forwardInbound\(endpoint, [^\n]*, caps\)/);
  assert.doesNotMatch(BRIDGE, /thread_id|threadConversationId|parentMessageId/, 'no thread logic left');
});

test('T8: a receipt whose card conversation has no known kind is not forwarded; the card gets CARD_RETRY, as a reply to it', () => {
  const block = BRIDGE.slice(BRIDGE.indexOf('const caps = readInboundCaps();'), BRIDGE.indexOf('const sourceMessageId = String('));
  assert.match(block, /if \(caps\.sessionGroup\) \{/, 'only on a multi-session Core (old Core: main behaviour)');
  assert.match(block, /if \(replyTarget\.redirected\) \{[\s\S]*sendRejectNotice\(orgConfig, \{ conversation_id: replyConvId, id: replyTarget\.cardMessageId \}, CARD_RETRY\)/);
  assert.match(block, /removeReaction\(msg\.id, 'no-session-group'\)/);
  assert.match(block, /\n {8}return;\n/, 'returns before any run is registered or c4-receive runs');
  // The card conversation's kind: record first, then the stored type.
  assert.match(BRIDGE, /return conv \? endpointKindOfRecord\(conv\) : endpointKindOf\(lookupConvRecord\(conversationId\)\);/);
});

test('A: failure handling — stored counts as delivered; anything else drops the run, the 👀, no markRead, notice with the usual exemptions', () => {
  const tail = BRIDGE.slice(BRIDGE.indexOf('const result = await forwardInbound(endpoint'), BRIDGE.indexOf('function shouldNoticeInboundFailure'));
  assert.match(tail, /result\.outcome === 'sent' \|\| result\.outcome === 'stored'[\s\S]*markRead\(orgConfig[\s\S]*return;/);
  assert.match(tail, /activity\.dropRun\(run\.runId\);\n {4}removeReaction\(msg\.id, 'c4-failed'\);/);
  assert.match(tail, /if \(result\.notice && shouldNoticeInboundFailure\(msg, notification\)\)/);
  const exempt = BRIDGE.slice(BRIDGE.indexOf('function shouldNoticeInboundFailure'));
  assert.match(exempt, /notification\._via !== 'sync' && senderType !== 'AGENT' && !isSystemSender\(msg\)/);
});

// --- An unknown conversation kind is a wait, not a silent drop.

test('unknown kind: the conversation record is fetched with one retry (null or throw both count as a miss)', async () => {
  for (const firstMiss of [() => null, () => { throw new Error('502'); }]) {
    let calls = 0;
    // eslint-disable-next-line no-await-in-loop
    const rec = await fetchConversationRecord(() => { calls += 1; return calls === 1 ? firstMiss() : { id: G, type: 'GROUP' }; }, { retryDelayMs: 1 });
    assert.deepEqual(rec, { id: G, type: 'GROUP' });
    assert.equal(calls, 2);
  }
  let calls = 0;
  assert.equal(await fetchConversationRecord(() => { calls += 1; return null; }, { retryDelayMs: 1 }), null);
  assert.equal(calls, 2, 'exactly one retry');
  calls = 0;
  await fetchConversationRecord(() => { calls += 1; return { type: 'DM' }; }, { retryDelayMs: 1 });
  assert.equal(calls, 1, 'no retry after a hit');
});

test('unknown kind: only "no record and no stored type" on a multi-session Core waits', () => {
  const NEW = { sessionGroup: true };
  assert.equal(conversationKindPending(NEW, null, null), true);
  assert.equal(conversationKindPending(NEW, null, { orgId: 'o' }), true, 'an org-only entry has no type');
  assert.equal(conversationKindPending(NEW, null, { type: 'DM' }), false, 'stored type answers');
  assert.equal(conversationKindPending(NEW, { type: 'STRAT' }, null), false, 'a record without a group is refused later, not retried');
  assert.equal(conversationKindPending({ sessionGroup: false }, null, null), false, 'old Core: forwarded as before');
});

test('unknown kind: the bridge checks the kind BEFORE the inbox seq is recorded and releases the dedupe mark like a transient fetch failure', () => {
  const handler = BRIDGE.slice(BRIDGE.indexOf('function makeOrgMessageHandler'), BRIDGE.indexOf('function shouldNoticeInboundFailure'));
  const gate = handler.indexOf('if (conversationKindPending(caps, record, lookupConvRecord(notifConv)))');
  const ledger = handler.indexOf('recordSeqOrReleaseId({ inboxLedger, dedupe, notifId, inboxSeq })');
  assert.ok(gate > 0 && ledger > gate, 'kind gate before the ledger record');
  const block = handler.slice(gate, ledger);
  assert.match(block, /dedupe\.forget\?\.\(notifId\);/);
  assert.match(block, /forceReconnect\('conversation-record-unavailable'\)/);
  assert.match(block, /return \{ contentFetchFailed: true, transient: true \};/);
  assert.match(handler, /const record = await fetchConversationRecord\(\(\) => fetchConversation\(orgConfig\.org_id, notifConv\)\);/);
});
