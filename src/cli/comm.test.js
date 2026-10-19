import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from '../lib/activity/run-store.js';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Every spawned CLI inherits this: comm.send / send_card / ask_card read the
// agent-activity run files, and a test must never see (or claim) the host's
// live runs. Empty dir → no run → no agent_run, exactly the old behaviour.
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-runs-'));

/**
 * Run a command against a local stub server and return the request it sent.
 *
 * `allowFailure` keeps the captured request when the CLI exits non-zero AFTER
 * sending it. It exists for `comm.ask_card`, which posts and then requires
 * `message_id` / `action_ids` back before recording the question — the stub
 * answers every route with `{}`, so the verb always fails on that check. What
 * this harness can prove about it is exactly what we need: the request went out
 * and carried what it should. Letting it succeed would also make the test write
 * a real pending-question record into the component's runtime directory.
 */
async function captureRequest(command, params, { allowFailure = false } = {}) {
  let resolveRequest;
  let sawRequest = false;
  const requestPromise = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    // comm.ask_card's onboarding.channel guard reads the channel list first;
    // answer it with no im_channels (guard skips) and keep waiting for the send.
    if (req.url.startsWith('/api/v1/onboarding/profile-options')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {} }));
      return;
    }
    sawRequest = true;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      resolveRequest({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const processPromise = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      {
        env: {
          ...process.env,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_RPC_LOG: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error && !allowFailure) { reject(new Error(`comm.js failed: ${stderr || stdout}`)); return; }
        // Under allowFailure, a CLI that exits BEFORE sending leaves the request
        // promise pending forever — the test would hang to the runner's timeout
        // and fail the whole file instead of naming what went wrong. Turn that
        // into an immediate, readable failure.
        if (error && !sawRequest) {
          reject(new Error(`comm.js exited without sending a request: ${stderr || stdout}`));
          return;
        }
        resolve();
      },
    );
  });

  try {
    const [request] = await Promise.all([requestPromise, processPromise]);
    return request;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureFailure(command, params) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      { env: { ...process.env, COCO_RPC_LOG: '0' } },
      (error, stdout, stderr) => {
        if (!error) { reject(new Error(`comm.js unexpectedly succeeded: ${stdout}`)); return; }
        resolve(JSON.parse(stderr));
      },
    );
  });
}

test('member_list → GET .../members (full list, no pagination params) + documented auth', async () => {
  // cws-core ListMembers takes only conversation_id; the CLI must not send
  // cursor/limit (they would be silently ignored — fake pagination).
  const request = await captureRequest('comm.member_list', { conversationId: 'cv-1', limit: 50 });
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
});

test('member_add (single) → POST .../members {member_id}', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: 'cv-1', memberId: 'm-1' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members');
  assert.deepEqual(request.body, { member_id: 'm-1' });
});

test('member_add (single, with role) forwards role', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: 'cv-1', memberId: 'm-1', role: 'ADMIN' });
  assert.deepEqual(request.body, { member_id: 'm-1', role: 'ADMIN' });
});

test('member_add (batch) → POST .../members:batch-add {member_ids, role}', async () => {
  const request = await captureRequest('comm.member_add', {
    conversationId: 'cv-1', memberIds: ['m-1', 'm-2'], role: 'MEMBER',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members:batch-add');
  assert.deepEqual(request.body, { member_ids: ['m-1', 'm-2'], role: 'MEMBER' });
});

test('member_remove → DELETE .../members/{member_id}', async () => {
  const request = await captureRequest('comm.member_remove', { conversationId: 'cv-1', memberId: 'm-1' });
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members/m-1');
  assert.equal(request.body, undefined);
});

test('member_remove_batch → POST .../members:batch-remove {member_ids}', async () => {
  const request = await captureRequest('comm.member_remove_batch', {
    conversationId: 'cv-1', memberIds: ['m-1', 'm-2'],
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members:batch-remove');
  assert.deepEqual(request.body, { member_ids: ['m-1', 'm-2'] });
});

test('leave → POST .../leave, omits new_owner_id unless given', async () => {
  const plain = await captureRequest('comm.leave', { conversationId: 'cv-1' });
  assert.equal(plain.method, 'POST');
  assert.equal(plain.url, '/api/v1/conversations/cv-1/leave');
  assert.deepEqual(plain.body, {});

  const withOwner = await captureRequest('comm.leave', { conversationId: 'cv-1', newOwnerId: 'h-9' });
  assert.deepEqual(withOwner.body, { new_owner_id: 'h-9' });
});

test('validation: member_add with neither id, remove without id, batch with empty', async () => {
  assert.match((await captureFailure('comm.member_add', { conversationId: 'cv-1' })).error, /memberId/);
  assert.match((await captureFailure('comm.member_remove', { conversationId: 'cv-1' })).error, /memberId required/);
  assert.match((await captureFailure('comm.member_remove_batch', { conversationId: 'cv-1', memberIds: [] })).error, /non-empty/);
});

test('send_card → POST .../interaction-requests with an interaction_type=choice body', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-1',
    title: 'Confirm',
    summary: 'Continue the deploy?',
    text: 'The deploy is staged and waiting.',
    options: ['Yes', 'No'],
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-card-1/interaction-requests');
  assert.equal(request.body.interaction_type, 'choice');
  assert.equal(request.body.choice.title, 'Confirm');
  assert.deepEqual(request.body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
  // The card body is cws-comm's to build: nothing here names a schema, a mode,
  // an operation or an option id.
  assert.equal(request.body.choice.schema, undefined);
  assert.equal(request.body.type, undefined);
});

test('send_card refuses an option id rather than dropping it', async () => {
  // The server generates the ids and returns them as action_ids. A dropped id
  // would leave the caller matching the answer against one the server never saw.
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-3',
    title: 't',
    summary: 's',
    text: 'body',
    options: [{ label: 'Yes', id: 'yes' }],
  });
  assert.match(failure.error, /^options\[0\]\.id: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('send_card refuses replyTo and mentions — the endpoint has no field for them', async () => {
  for (const extra of [{ replyTo: 'msg-parent' }, { mentions: ['member-9'] }]) {
    const failure = await captureFailure('comm.send_card', {
      conversationId: 'cv-card-2', title: 't', summary: 's', text: 'body', options: ['Yes'], ...extra,
    });
    assert.match(failure.error, /is not supported by interaction-requests/);
    assert.equal(failure.status, undefined, 'no HTTP round trip happened');
  }
});

test('🔴 send_card refuses a top-level `fields` instead of posting a card without it', async () => {
  // The real failure this guards: an upgrade card passed one row per component
  // as top-level `fields`. The card posted successfully carrying only the prose
  // body, the reader never saw the versions, and no error was raised anywhere.
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-5',
    title: '确认升级', summary: 'openmax · 自动检查', text: '确认升级以下组件?',
    options: ['升级', '先不升'],
    fields: [{ label: 'core', value: '0.7.1 → 0.8.1' }],
  });
  assert.match(failure.error, /^fields: /);
  assert.match(failure.error, /blocks/, 'the error has to say where fields belongs');
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('🔴 a fields block inside `blocks` reaches the wire as sent', async () => {
  // Refusing the misplaced key only helps if the destination the error names
  // actually works end to end.
  const blocks = [
    { type: 'text', text: '确认升级以下组件?' },
    { type: 'fields', items: [{ label: 'core', value: '0.7.1 → 0.8.1' }] },
  ];
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-6', title: '确认升级', summary: 'openmax · 自动检查',
    blocks, options: ['升级', '先不升'],
  });
  assert.deepEqual(request.body.choice.blocks, blocks);
});

test('🔴 ask_card is not broken by the whitelist: kind/askedOf/meta still work', async () => {
  // send_card and ask_card have DIFFERENT legitimate arguments, and the builder
  // refuses ask_card's three. This is the cell that catches a whitelist applied
  // without ask_card stripping them first — it would throw on the verb's own
  // required argument, on every call, before any request went out.
  const request = await captureRequest('comm.ask_card', {
    conversationId: 'cv-card-7', title: '要升级吗', summary: 'openmax · 自动检查',
    text: 'openmax 2.20.0 → 2.21.0。', options: [{ label: '升级', style: 'primary' }, '先不升'],
    kind: 'component-upgrade', askedOf: 'm-owner', meta: { component: 'openmax' },
  }, { allowFailure: true });
  assert.equal(request.url, '/api/v1/conversations/cv-card-7/interaction-requests');
  assert.equal(request.body.interaction_type, 'choice');
  // The question's own arguments describe the question, not the card.
  for (const key of ['kind', 'askedOf', 'meta']) assert.equal(key in request.body.choice, false, key);
});

test('send_card refuses a card with no options', async () => {
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-4', title: 't', summary: 's', text: 'body',
  });
  assert.match(failure.error, /^options: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('🔴 send_card carries the onboarding guide-card fields to the wire', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-g1', title: '选择渠道', summary: '把 agent 接到你常用的地方',
    text: '选一个渠道。', cardKind: 'onboarding.channel',
    options: [{ label: '飞书', icon: 'lark' }, { label: '都不用', decline: true }],
  });
  assert.equal(request.body.choice.kind, 'onboarding.channel');
  assert.deepEqual(request.body.choice.options, [
    { label: '飞书', icon: 'lark' },
    { label: '都不用', decline: true },
  ]);
});

test('send_card sends a partner card whose only button opens the dialog', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-g2', title: '找个搭档', summary: '再加一位 agent',
    text: '加入一位搭档,分担工作。', cardKind: 'onboarding.partner',
    options: [{ label: '加入一位搭档', behavior: 'open_create_agent' }],
  });
  assert.equal(request.body.choice.kind, 'onboarding.partner');
  assert.equal(request.body.choice.options[0].behavior, 'open_create_agent');
});

test('🔴 ask_card refuses a card no one can answer, before anything is sent', async () => {
  // It would record a pending question that never receives a receipt.
  const failure = await captureFailure('comm.ask_card', {
    conversationId: 'cv-card-g3', title: '找个搭档', summary: '再加一位 agent',
    text: '加入一位搭档。', cardKind: 'onboarding.partner',
    options: [{ label: '加入一位搭档', behavior: 'open_create_agent' }],
    kind: 'onboarding-partner', askedOf: 'm-owner',
  });
  assert.match(failure.error, /^options: /);
  assert.match(failure.error, /comm\.send_card/);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('ask_card keeps its own `kind` separate from the card family', async () => {
  const request = await captureRequest('comm.ask_card', {
    conversationId: 'cv-card-g4', title: '选择渠道', summary: 's', text: 'body',
    cardKind: 'onboarding.channel', options: ['飞书', { label: '都不用', decline: true }],
    kind: 'channel-choice', askedOf: 'm-owner',
  }, { allowFailure: true });
  assert.equal(request.body.choice.kind, 'onboarding.channel');
});

test('🔴 guide-card values keep their JSON type on the wire, through both CLI verbs', async () => {
  for (const [command, extra] of [
    ['comm.send_card', {}],
    ['comm.ask_card', { kind: 'k', askedOf: 'm-owner' }],
  ]) {
    for (const v of [false, null, '']) {
      const request = await captureRequest(command, {
        conversationId: 'cv-card-t', title: 't', summary: 's', text: 'b',
        cardKind: v, options: [{ label: 'x', behavior: v, icon: v, decline: v }, 'y'], ...extra,
      }, { allowFailure: true });
      const label = `${command} ${JSON.stringify(v)}`;
      assert.deepEqual(request.body.choice.kind, v, label);
      assert.deepEqual(request.body.choice.options[0], { label: 'x', behavior: v, icon: v, decline: v }, label);
    }
  }
});

/**
 * Run a command against a stub server that answers the first `failures`
 * requests with `failStatus`, then 200 with `okBody`. Returns every request it
 * received plus the CLI's exit outcome.
 */
async function runAgainstFlakyServer(command, params, { failures, failStatus = 401, okBody = {} }) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, body: rawBody ? JSON.parse(rawBody) : undefined });
      if (requests.length <= failures) {
        res.writeHead(failStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { status: failStatus, detail: `stub ${failStatus}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: okBody, request_id: 'test-request' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, command, JSON.stringify(params)],
        {
          env: {
            ...process.env,
            COCO_API_URL: `http://127.0.0.1:${port}`,
            COCO_API_PREFIX: '/api/v1',
            COCO_AUTH_TOKEN: 'cli-contract-token',
            COCO_USER_TOKEN: '',
            COCO_RPC_LOG: '0',
          },
        },
        (error, stdout, stderr) => resolve({
          ok: !error,
          stdout,
          failure: error ? JSON.parse(stderr.trim().split('\n').pop()) : null,
        }),
      );
    });
    return { requests, ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const onboardingTaskCard = {
  conversationId: 'cv-onb', title: '我能帮你做这些', summary: '选一个开始',
  text: '你好,我是你的助理。', cardKind: 'onboarding.task',
  options: [{ label: '任务一' }, { label: '任务二' }, { label: '任务三' }],
};

// The client's own single 401 retry happens first (two requests); the send
// verbs then add a bounded, backed-off retry on top. Three 401s in a row is
// the e2e case: a token rotated by another process while the card was in
// flight, which the immediate client retry alone did not survive.
test('🔴 send_card survives a transient 401 burst: the SAME card is re-sent and goes out', async () => {
  const { requests, ok } = await runAgainstFlakyServer('comm.send_card', onboardingTaskCard, { failures: 3 });
  assert.equal(ok, true);
  assert.equal(requests.length, 4);
  for (const r of requests) assert.equal(r.url, '/api/v1/conversations/cv-onb/interaction-requests');
  const ids = new Set(requests.map((r) => r.body.client_msg_id));
  assert.equal(ids.size, 1, 'every attempt carries the same client_msg_id, so a retry cannot post twice');
});

test('🔴 ask_card re-sends on a 401 before giving up on the card', async () => {
  // The stub's success body has no action_ids, so the verb still fails on its
  // shape check — AFTER the retry. What matters is that the 401 did not end it.
  const { requests, ok, failure } = await runAgainstFlakyServer('comm.ask_card', {
    ...onboardingTaskCard, kind: 'onboarding-task', askedOf: 'm-owner',
  }, { failures: 3 });
  assert.equal(ok, false);
  assert.equal(requests.length, 4);
  assert.match(failure.error, /card was SENT/);
  assert.equal(new Set(requests.map((r) => r.body.client_msg_id)).size, 1);
});

test('🔴 the text fallback (comm.send) gets the same retry, so it cannot die in the same window', async () => {
  const { requests, ok } = await runAgainstFlakyServer('comm.send', {
    conversationId: 'cv-onb', content: '1. 任务一\n2. 任务二\n3. 任务三',
  }, { failures: 3 });
  assert.equal(ok, true);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map((r) => r.body.client_msg_id)).size, 1);
});

test('🔴 a persistent 401 is bounded and still exits non-zero with status 401', async () => {
  const { requests, ok, failure } = await runAgainstFlakyServer('comm.send_card', onboardingTaskCard, { failures: 100 });
  assert.equal(ok, false);
  assert.equal(failure.status, 401);
  // client single retry (2) + two bounded retries, the client's own refresh
  // throttled on those (1 each).
  assert.equal(requests.length, 4);
});

test('🔴 a non-auth refusal is not retried — the skill falls back to text exactly as before', async () => {
  const { requests, ok, failure } = await runAgainstFlakyServer('comm.send_card', onboardingTaskCard, {
    failures: 100, failStatus: 422,
  });
  assert.equal(ok, false);
  assert.equal(failure.status, 422);
  assert.equal(requests.length, 1);
});

// ── onboarding.channel guard, end to end through the CLI ───────────────────
// The stub serves `profileOptions` (or `profileStatus`) on GET profile-options
// and `{}` on the card POST, so a card that passes the guard still exits on the
// "card was SENT" shape check — which proves it was posted — without writing a
// pending record.
async function runWithProfileOptions(params, { profileOptions, profileStatus = 200, env = {} }) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/api/v1/onboarding/profile-options')) {
        res.writeHead(profileStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(profileStatus === 200 ? { data: profileOptions } : { error: { status: profileStatus, detail: 'stub' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, 'comm.ask_card', JSON.stringify(params)], {
        env: {
          ...process.env, COCO_API_URL: `http://127.0.0.1:${port}`, COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0',
          ...env,
        },
      }, (error, stdout, stderr) => resolve({
        ok: !error, stderr,
        failure: error ? JSON.parse(stderr.trim().split('\n').pop()) : null,
      }));
    });
    return { requests, ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const IM12 = ['企业微信', '个人微信', '飞书', '钉钉', 'Lark', 'WhatsApp', 'Telegram', 'Slack', 'Discord', 'Microsoft Teams', 'LINE', '邮箱']
  .map((label, i) => ({ type: `t${i}`, label, label_zh: label, label_en: label, visible: i < 5 }));
const imCard = (labels) => ({
  conversationId: 'cv-im', title: '对了，你日常用哪个办公沟通工具？', text: '可以把我接入。',
  cardKind: 'onboarding.channel', kind: 'onboarding-channel', askedOf: 'm-owner',
  meta: { onboarding: 'o1', trigger: 'first' },
  options: [...labels.map((label) => ({ label })), { label: '都不用，就在这儿聊', decline: true }],
});
const cardPosts = (requests) => requests.filter((r) => r.url.endsWith('/interaction-requests'));

test('🔴 ask_card refuses an onboarding.channel card missing the visible:false channels — nothing is posted', async () => {
  const { requests, ok, failure } = await runWithProfileOptions(
    imCard(IM12.slice(0, 5).map((c) => c.label)), { profileOptions: { im_channels: IM12 } },
  );
  assert.equal(ok, false);
  assert.match(failure.error, /onboarding\.channel card refused/);
  assert.match(failure.error, /visible/);
  assert.equal(cardPosts(requests).length, 0, 'the card never reached cws-comm');
});

test('ask_card sends an onboarding.channel card carrying all 12 channels', async () => {
  const { requests, failure } = await runWithProfileOptions(
    imCard(IM12.map((c) => c.label)), { profileOptions: { im_channels: IM12 } },
  );
  assert.equal(cardPosts(requests).length, 1);
  assert.match(failure.error, /card was SENT/);
});

test('🔴 ask_card re-reads im_channels with the im_order its TZ selects, and refuses a reordered card', async () => {
  for (const [tz, want] of [['Asia/Shanghai', 'cn'], ['UTC', 'intl']]) {
    const { requests, failure } = await runWithProfileOptions(
      imCard(IM12.map((c) => c.label)), { profileOptions: { im_channels: IM12 }, env: { TZ: tz } },
    );
    const fetches = requests.filter((r) => r.url.startsWith('/api/v1/onboarding/profile-options'));
    assert.equal(fetches.length, 1, tz);
    assert.match(fetches[0].url, new RegExp(`[?&]im_order=${want}(&|$)`), tz);
    assert.match(failure.error, /card was SENT/, tz);
  }
  const reordered = [IM12[1].label, IM12[0].label, ...IM12.slice(2).map((c) => c.label)];
  const { requests, failure } = await runWithProfileOptions(imCard(reordered), { profileOptions: { im_channels: IM12 } });
  assert.match(failure.error, /wrong order/);
  assert.equal(cardPosts(requests).length, 0);
});

test('ask_card still sends the channel card when the channel-list fetch fails', async () => {
  const { requests, failure, stderr } = await runWithProfileOptions(
    imCard(IM12.slice(0, 5).map((c) => c.label)), { profileStatus: 500 },
  );
  assert.equal(cardPosts(requests).length, 1);
  assert.match(failure.error, /card was SENT/);
  assert.match(stderr, /guard skipped/);
});

// ── agent activity: comm CLI sends carry agent_run (top-level) ────────────────

const RUN_CONV = '019f0000-aaaa-7bbb-8ccc-0000000000c1';

/** A runs dir with one live run in RUN_CONV (gate open); spawned CLIs see it. */
async function withLiveRun(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-live-'));
  const store = createRunStore({ dir });
  const t = Date.now();
  store.writeRun({
    v: 1, run_id: 'r_000000c1', org_id: 'org', conversation_id: RUN_CONV, reply_conversation_id: RUN_CONV,
    created_at: t - 5000, state: 'active', events: [], dropped: 0, next_event: 1, seq: 1,
  });
  store.writeActive({ v: 1, by_conversation: { [RUN_CONV]: ['r_000000c1'] }, gate: { org: 'open' } });
  const prev = process.env.OPENMAX_RUNS_DIR;
  process.env.OPENMAX_RUNS_DIR = dir;
  try {
    return await fn(store);
  } finally {
    process.env.OPENMAX_RUNS_DIR = prev;
  }
}

const plainCard = (extra = {}) => ({
  conversationId: RUN_CONV, title: '确认?', text: '要继续吗', options: [{ label: '继续', style: 'primary' }, '算了'], ...extra,
});

test('comm.send into a conversation with a live run carries the full agent_run, claimed by its client_msg_id', async () => {
  await withLiveRun(async (store) => {
    const { requests, ok } = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: '好的' }, { failures: 0 });
    assert.equal(ok, true);
    const body = requests[0].body;
    assert.equal(body.agent_run.run_id, 'r_000000c1');
    assert.ok(Array.isArray(body.agent_run.steps));
    const claim = store.readClaim('r_000000c1');
    assert.equal(claim.client_msg_id, body.client_msg_id);
    assert.equal(claim.state, 'delivered');
    assert.equal(claim.kind, 'text');
    // The next send of the same run: reference form only.
    const second = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: '还有一件事' }, { failures: 0 });
    assert.deepEqual(second.requests[0].body.agent_run, { schema_version: 3, run_id: 'r_000000c1', ref: true });
  });
});

test('comm.send: a caller agent_run in an advanced body is dropped (caller metadata kept); no run → no agent_run', async () => {
  const forged = { agent_run: { schema_version: 3, run_id: 'r_0000dead', ref: true }, metadata: { mine: 1 } };
  const { requests } = await runAgainstFlakyServer('comm.send', {
    conversationId: 'cv-norun', body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'x' }, attachments: [] }, ...forged },
  }, { failures: 0 });
  assert.equal('agent_run' in requests[0].body, false);
  assert.deepEqual(requests[0].body.metadata, { mine: 1 });
});

test('comm.send_card carries agent_run; the caller clientMsgId stays the card key and the claim key', async () => {
  await withLiveRun(async (store) => {
    const { requests, ok } = await runAgainstFlakyServer('comm.send_card', plainCard({ clientMsgId: 'cm_keep_1' }), { failures: 0 });
    assert.equal(ok, true);
    assert.equal(requests[0].body.client_msg_id, 'cm_keep_1');
    assert.equal(requests[0].body.agent_run.run_id, 'r_000000c1');
    assert.equal(store.readClaim('r_000000c1').client_msg_id, 'cm_keep_1');
    assert.equal(store.readClaim('r_000000c1').kind, 'card');
  });
});

test('comm.ask_card carries agent_run', async () => {
  await withLiveRun(async (store) => {
    // The stub answers {} (no action_ids): the verb fails AFTER the post, which
    // keeps the test from writing a pending-question record.
    const { requests } = await runAgainstFlakyServer('comm.ask_card', plainCard({ kind: 'k', askedOf: 'm-owner' }), { failures: 0 });
    const post = requests.find((r) => r.url.endsWith('/interaction-requests'));
    assert.equal(post.body.agent_run.run_id, 'r_000000c1');
    assert.equal(store.readClaim('r_000000c1').client_msg_id, post.body.client_msg_id);
    assert.equal(store.readClaim('r_000000c1').state, 'delivered');
  });
});

test('onboarding cards carry no agent_run even with a live run', async () => {
  await withLiveRun(async (store) => {
    const { requests } = await runAgainstFlakyServer('comm.send_card', { ...onboardingTaskCard, conversationId: RUN_CONV }, { failures: 0 });
    assert.equal('agent_run' in requests[0].body, false);
    assert.equal(store.claimExists('r_000000c1'), false);
  });
});

test('🔴 a server that refuses agent_run (422) still gets the card: resent once without it, same key', async () => {
  await withLiveRun(async (store) => {
    const { requests, ok } = await runAgainstFlakyServer('comm.send_card', plainCard(), { failures: 1, failStatus: 422 });
    assert.equal(ok, true);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].body.agent_run);
    assert.equal('agent_run' in requests[1].body, false);
    assert.equal(requests[1].body.client_msg_id, requests[0].body.client_msg_id);
    assert.equal(store.claimExists('r_000000c1'), false);
    assert.equal(store.formCardExists('r_000000c1'), true);
  });
});
