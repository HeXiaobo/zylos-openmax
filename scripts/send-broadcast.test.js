import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// [STRUCTURED] broadcast mentions through scripts/send.js (the c4-send path):
// the same gate as comm.send (src/cli/comm.send-broadcast.test.js, #284). A
// broadcast ({type:"all"} / {type:"all_agents"}) goes out only when passed
// explicitly in `mentions`; body text such as "@所有人" is plain text. An
// explicit one is checked against the conversation's can_mention_all first; a
// refusal (local or cws-comm's 403 "mention all not allowed") fails the send
// with code mention_all_not_allowed, and the broadcast is never dropped.

const SEND_JS = fileURLToPath(new URL('./send.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-send-bcast-home-'));

const CONV = '019f0000-aaaa-7bbb-8ccc-000000000401';
const CONV_PATH = `/api/v1/conversations/${CONV}`;
const MEMBER = '019f0000-aaaa-7bbb-8ccc-000000000402';

const structured = (payload) => `[STRUCTURED]${JSON.stringify(payload)}`;

async function send(message, {
  conversation = { status: 200, body: { id: CONV, type: 'GROUP', can_mention_all: true } },
  send: sendReply = { status: 200, body: { id: '7300000000000000401' } },
  endpoint = `${CONV}|type:group|msg:7300000000000000400`,
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
      const child = spawn(process.execPath, [SEND_JS, endpoint, message], {
        env: {
          ...process.env,
          HOME,
          COCO_ORG_ID: 'org-test',
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_AUTH_TOKEN: 'test-token',
          COCO_RPC_LOG: '0',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({
        ok: code === 0,
        stdout,
        stderr,
        failure: code ? JSON.parse(stderr.trim().split('\n').pop()) : null,
      }));
    });
    return {
      ...outcome,
      posts: requests.filter((r) => r.method === 'POST'),
      convGets: requests.filter((r) => r.method === 'GET' && r.url === CONV_PATH),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('🔴 "@所有人" / "@所有Agent" text is plain text on both paths: no broadcast, no lookup', async () => {
  for (const message of ['@所有人 请查收', structured({ content: '@所有Agent 集合' })]) {
    const { ok, posts, convGets, stderr } = await send(message);
    assert.equal(ok, true, stderr);
    assert.equal(posts.length, 1);
    assert.equal('mentions' in posts[0].body, false, message);
    assert.equal(convGets.length, 0);
    assert.equal(stderr, '', message);
  }
});

test('🔴 [STRUCTURED] explicit {type:"all"} is sent when can_mention_all is true', async () => {
  const { ok, posts, convGets, stderr } = await send(structured({ content: '请查收', mentions: [{ type: 'all' }] }));
  assert.equal(ok, true, stderr);
  assert.equal(convGets.length, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('[STRUCTURED] explicit all + all_agents + a member are all carried unchanged', async () => {
  const mentions = [{ type: 'all' }, { type: 'all_agents' }, { type: 'member', member_id: MEMBER }];
  const { ok, posts, stderr } = await send(structured({ content: 'hi', mentions }));
  assert.equal(ok, true, stderr);
  assert.deepEqual(posts[0].body.mentions, mentions);
});

test('🔴 [STRUCTURED] can_mention_all false refuses the send (code mention_all_not_allowed) — nothing is posted', async () => {
  const { ok, posts, failure } = await send(
    structured({ content: '集合', mentions: [{ type: 'all_agents' }] }),
    { conversation: { status: 200, body: { id: CONV, type: 'DM', can_mention_all: false } } },
  );
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.equal(failure.status, 403);
  assert.equal(failure.code, 'mention_all_not_allowed');
  assert.match(failure.error, /^\[STRUCTURED\]: broadcast mention \(\{type:"all_agents"\}\) is not allowed/);
  assert.match(failure.error, /can_mention_all is false/);
  assert.match(failure.error, /Nothing was sent/);
});

test('🔴 [STRUCTURED] server ErrMentionAllNotAllowed (403) surfaces as the same error, mention not dropped', async () => {
  const { ok, posts, failure } = await send(
    structured({ content: '请查收', mentions: [{ type: 'all' }] }),
    { send: { status: 403, body: { error: { status: 403, title: 'Forbidden', detail: 'mention all not allowed', code: 'COMM_ERROR' } } } },
  );
  assert.equal(ok, false);
  assert.equal(posts.length, 1, 'one attempt, never retried without the broadcast');
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
  assert.equal(failure.status, 403);
  assert.equal(failure.code, 'mention_all_not_allowed');
  assert.match(failure.error, /the server refused it \(mention all not allowed\)/);
});

test('[STRUCTURED] an unrelated 403 on a broadcast send is passed through as-is', async () => {
  const { ok, failure } = await send(
    structured({ content: '请查收', mentions: [{ type: 'all' }] }),
    { send: { status: 403, body: { error: { status: 403, detail: 'observer cannot send' } } } },
  );
  assert.equal(ok, false);
  assert.equal(failure.status, 403);
  assert.equal(failure.error, 'observer cannot send');
  assert.equal('code' in failure, false);
});

test('[STRUCTURED] a failed can_mention_all lookup warns and sends — the server still decides', async () => {
  const { ok, posts, stderr } = await send(
    structured({ content: '请查收', mentions: [{ type: 'all' }] }),
    { conversation: { status: 500, body: { error: { status: 500, detail: 'boom' } } } },
  );
  assert.equal(ok, true, stderr);
  assert.match(stderr, /could not check can_mention_all/);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('[STRUCTURED] a conversation without can_mention_all warns and sends — the server still decides', async () => {
  const { ok, posts, stderr } = await send(
    structured({ content: '请查收', mentions: [{ type: 'all' }] }),
    { conversation: { status: 200, body: { id: CONV, type: 'GROUP' } } },
  );
  assert.equal(ok, true, stderr);
  assert.match(stderr, /did not report can_mention_all/);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'all' }]);
});

test('[STRUCTURED] member-only mentions do not look up the conversation', async () => {
  const { ok, posts, convGets, stderr } = await send(structured({ content: 'hi', mentions: [MEMBER] }));
  assert.equal(ok, true, stderr);
  assert.equal(convGets.length, 0);
  assert.deepEqual(posts[0].body.mentions, [{ type: 'member', member_id: MEMBER }]);
});

// The broadcast pre-check runs BEFORE the run claim: a refused broadcast must
// leave no reply claim on the conversation's live run (a claim that never
// settles would make the corrected resend carry only the run reference).
async function withLiveRun(fn) {
  const { createRunStore } = await import('../src/lib/activity/run-store.js');
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

test('🔴 [STRUCTURED]: a broadcast refused by can_mention_all leaves no run claim (pre-check before the claim)', async () => {
  // No |msg: (that would select a run by its source message); the live run is the conversation's.
  const endpoint = `${CONV}|type:group`;
  const refused = { endpoint, conversation: { status: 200, body: { id: CONV, type: 'GROUP', can_mention_all: false } } };
  await withLiveRun(async (store) => {
    const { ok, posts, failure } = await send(structured({ content: "集合", mentions: [{ type: "all" }] }), refused);
    assert.equal(ok, false);
    assert.equal(failure.code, 'mention_all_not_allowed');
    assert.equal(posts.length, 0);
    assert.equal(store.claimExists('r_0000b0b0'), false, 'no claim left on the live run');
    // Control: the same run is live and claimable, so the absence above is meaningful.
    const allowed = await send(structured({ content: "集合", mentions: [{ type: "all" }] }), { endpoint });
    assert.equal(allowed.ok, true, allowed.stderr);
    assert.equal(allowed.posts[0].body.agent_run?.run_id, 'r_0000b0b0');
    assert.equal(store.claimExists('r_0000b0b0'), true);
  });
});
