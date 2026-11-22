import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// comm.send broadcast mentions: a broadcast ({type:"all"} / {type:"all_agents"})
// goes out ONLY when passed explicitly in `mentions` — "@所有人" body text is
// plain text — and an explicit one is checked against the conversation's
// can_mention_all first. A refusal (local or cws-comm's ErrMentionAllNotAllowed,
// HTTP 403 "mention all not allowed") fails the send with a clear error; the
// broadcast is never silently dropped. The same gate on the [STRUCTURED] path:
// scripts/send-broadcast.test.js.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Hermetic: a temp HOME and runs dir, so no host org config, mention registry
// or live run leaks into these sends.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-bcast-home-'));
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-bcast-runs-'));

const CONV = '019f0000-aaaa-7bbb-8ccc-000000000301';
const CONV_PATH = `/api/v1/conversations/${CONV}`;
const MEMBER = '019f0000-aaaa-7bbb-8ccc-000000000302';

// `conversation`: the GET /conversations/{id} answer (status + body).
// `send`: the POST .../messages answer.
async function send(params, {
  conversation = { status: 200, body: { id: CONV, type: 'group', can_mention_all: true } },
  send: sendReply = { status: 200, body: { data: {}, request_id: 'test-request' } },
} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      const reply = req.method === 'GET' && req.url === CONV_PATH ? conversation
        : req.method === 'POST' && req.url === `${CONV_PATH}/messages` ? sendReply
          : { status: 200, body: { data: [] } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, 'comm.send', JSON.stringify({ conversationId: CONV, ...params })],
        {
          env: {
            ...process.env,
            HOME,
            COCO_ORG_ID: 'org-test',
            COCO_API_URL: `http://127.0.0.1:${port}`,
            COCO_API_PREFIX: '/api/v1',
            COCO_AUTH_TOKEN: 'cli-contract-token',
            COCO_USER_TOKEN: '',
            COCO_RPC_LOG: '0',
          },
        },
        (error, stdout, stderr) => resolve({
          ok: !error,
          stderr,
          failure: error ? JSON.parse(stderr.trim().split('\n').pop()) : null,
        }),
      );
    });
    return {
      ...outcome,
      requests,
      posts: requests.filter((r) => r.method === 'POST'),
      convGets: requests.filter((r) => r.method === 'GET' && r.url === CONV_PATH),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('🔴 "@所有人" / "@所有Agent" body text is plain text: no broadcast, no lookup, no hint', async () => {
  for (const content of ['@所有人 请查收', '@所有Agent 集合', '＠Everyone please check']) {
    const { ok, posts, convGets, stderr } = await send({ content });
    assert.equal(ok, true, stderr);
    assert.equal(posts.length, 1);
    assert.equal('mentions' in posts[0].body, false, content);
    assert.equal(convGets.length, 0);
    // Only the comm.send deprecation line (2.35.x); no broadcast hint.
    assert.deepEqual(stderr.split('\n').filter((l) => l && !l.includes('DEPRECATED')), [], content);
  }
});

test('🔴 an explicit {type:"all"} is sent when can_mention_all is true', async () => {
  const { ok, posts, convGets, stderr } = await send({ content: '请查收', mentions: [{ type: 'all' }] });
  assert.equal(ok, true, stderr);
  assert.equal(convGets.length, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('explicit all + all_agents + a member are all carried unchanged', async () => {
  const mentions = [{ type: 'all' }, { type: 'all_agents' }, { type: 'member', member_id: MEMBER }];
  const { ok, posts, stderr } = await send({ content: 'hi', mentions });
  assert.equal(ok, true, stderr);
  assert.deepEqual(posts[0].body.mentions, mentions);
});

test('🔴 can_mention_all false refuses the send with a clear error — nothing is posted', async () => {
  const { ok, posts, failure } = await send(
    { content: '集合', mentions: [{ type: 'all_agents' }] },
    { conversation: { status: 200, body: { id: CONV, type: 'dm', can_mention_all: false } } },
  );
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.equal(failure.status, 403);
  assert.match(failure.error, /broadcast mention \(\{type:"all_agents"\}\) is not allowed/);
  assert.equal(failure.code, 'mention_all_not_allowed');
  assert.match(failure.error, /can_mention_all is false/);
  assert.match(failure.error, /Nothing was sent/);
});

test('🔴 server ErrMentionAllNotAllowed (403) surfaces as the same clear error, mention not dropped', async () => {
  const { ok, posts, failure } = await send(
    { content: '请查收', mentions: [{ type: 'all' }] },
    { send: { status: 403, body: { error: { status: 403, title: 'Forbidden', detail: 'mention all not allowed', code: 'COMM_ERROR' } } } },
  );
  assert.equal(ok, false);
  // One attempt, and it carried the broadcast: never retried without it.
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
  assert.equal(failure.status, 403);
  assert.match(failure.error, /broadcast mention \(\{type:"all"\}\) is not allowed/);
  assert.equal(failure.code, 'mention_all_not_allowed');
  assert.match(failure.error, /the server refused it \(mention all not allowed\)/);
});

test('an unrelated 403 on a broadcast send is passed through as-is', async () => {
  const { ok, failure } = await send(
    { content: '请查收', mentions: [{ type: 'all' }] },
    { send: { status: 403, body: { error: { status: 403, detail: 'observer cannot send' } } } },
  );
  assert.equal(ok, false);
  assert.equal(failure.status, 403);
  assert.equal(failure.error, 'observer cannot send');
  assert.equal('code' in failure, false);
});

test('a failed can_mention_all lookup warns and sends — the server still decides', async () => {
  const { ok, posts, stderr } = await send(
    { content: '请查收', mentions: [{ type: 'all' }] },
    { conversation: { status: 500, body: { error: { status: 500, detail: 'boom' } } } },
  );
  assert.equal(ok, true, stderr);
  assert.match(stderr, /could not check can_mention_all/);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('a conversation without can_mention_all warns and sends — the server still decides', async () => {
  const { ok, posts, stderr } = await send(
    { content: '请查收', mentions: [{ type: 'all' }] },
    { conversation: { status: 200, body: { id: CONV, type: 'group' } } },
  );
  assert.equal(ok, true, stderr);
  assert.match(stderr, /did not report can_mention_all/);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('member-only explicit mentions do not look up the conversation', async () => {
  const { ok, posts, convGets, stderr } = await send({ content: 'hi', mentions: [MEMBER] });
  assert.equal(ok, true, stderr);
  assert.equal(convGets.length, 0);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'member', member_id: MEMBER }]);
});

// The broadcast pre-check runs BEFORE the run claim: a refused broadcast must
// leave no reply claim on the conversation's live run (a claim that never
// settles would make the corrected resend carry only the run reference).
async function withLiveRun(fn) {
  const { createRunStore } = await import('../lib/activity/run-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-bcast-live-'));
  const store = createRunStore({ dir });
  const t = Date.now();
  store.writeRun({
    v: 1, run_id: 'r_0000b0b0', org_id: 'org-test', conversation_id: CONV, reply_conversation_id: CONV,
    created_at: t - 5000, state: 'active', events: [], dropped: 0, next_event: 1, seq: 1,
  });
  store.writeActive({ v: 1, by_conversation: { [CONV]: ['r_0000b0b0'] }, gate: { 'org-test': 'open' } });
  const prev = process.env.OPENMAX_RUNS_DIR;
  process.env.OPENMAX_RUNS_DIR = dir;
  try {
    return await fn(store);
  } finally {
    if (prev === undefined) delete process.env.OPENMAX_RUNS_DIR; else process.env.OPENMAX_RUNS_DIR = prev;
  }
}

test('🔴 comm.send: a broadcast refused by can_mention_all leaves no run claim (pre-check before the claim)', async () => {
  const refused = { conversation: { status: 200, body: { id: CONV, type: 'GROUP', can_mention_all: false } } };
  await withLiveRun(async (store) => {
    const { ok, posts, failure } = await send({ content: "集合", mentions: [{ type: "all" }] }, refused);
    assert.equal(ok, false);
    assert.equal(failure.code, 'mention_all_not_allowed');
    assert.equal(posts.length, 0);
    assert.equal(store.claimExists('r_0000b0b0'), false, 'no claim left on the live run');
    // Control: the same run is live and claimable, so the absence above is meaningful.
    const allowed = await send({ content: "集合", mentions: [{ type: "all" }] });
    assert.equal(allowed.ok, true, allowed.stderr);
    assert.equal(allowed.posts[0].body.agent_run?.run_id, 'r_0000b0b0');
    assert.equal(store.claimExists('r_0000b0b0'), true);
  });
});
