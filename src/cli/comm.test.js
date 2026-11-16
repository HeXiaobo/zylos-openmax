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

// Hermetic, the same way: an empty HOME keeps the host's org config (and its
// tokens) out of every spawned CLI, and the request helpers below name the org
// with COCO_ORG_ID, so no test depends on how this machine is set up.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-home-'));
const TEST_ORG_ID = 'org-test';

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
          COCO_ORG_ID: TEST_ORG_ID,
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
        // The last line: deprecated send verbs print a warning line first.
        resolve(JSON.parse(stderr.trim().split('\n').pop()));
      },
    );
  });
}

test('member_list → GET .../members (full list, no pagination params) + documented auth', async () => {
  // cws-core ListMembers takes only conversation_id; the CLI must not send
  // cursor/limit (they would be silently ignored — fake pagination).
  const request = await captureRequest('comm.member_list', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', limit: 50 });
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/members');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
});

test('member_add (single) → POST .../members {member_id}', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberId: '019f0000-aaaa-7bbb-8ccc-000000000101' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/members');
  assert.deepEqual(request.body, { member_id: '019f0000-aaaa-7bbb-8ccc-000000000101' });
});

test('member_add (single, with role) forwards role', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberId: '019f0000-aaaa-7bbb-8ccc-000000000101', role: 'ADMIN' });
  assert.deepEqual(request.body, { member_id: '019f0000-aaaa-7bbb-8ccc-000000000101', role: 'ADMIN' });
});

test('member_add (batch) → POST .../members:batch-add {member_ids, role}', async () => {
  const request = await captureRequest('comm.member_add', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberIds: ['019f0000-aaaa-7bbb-8ccc-000000000101', '019f0000-aaaa-7bbb-8ccc-000000000102'], role: 'MEMBER',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/members:batch-add');
  assert.deepEqual(request.body, { member_ids: ['019f0000-aaaa-7bbb-8ccc-000000000101', '019f0000-aaaa-7bbb-8ccc-000000000102'], role: 'MEMBER' });
});

test('member_remove → DELETE .../members/{member_id}', async () => {
  const request = await captureRequest('comm.member_remove', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberId: '019f0000-aaaa-7bbb-8ccc-000000000101' });
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/members/019f0000-aaaa-7bbb-8ccc-000000000101');
  assert.equal(request.body, undefined);
});

test('member_remove_batch → POST .../members:batch-remove {member_ids}', async () => {
  const request = await captureRequest('comm.member_remove_batch', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberIds: ['019f0000-aaaa-7bbb-8ccc-000000000101', '019f0000-aaaa-7bbb-8ccc-000000000102'],
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/members:batch-remove');
  assert.deepEqual(request.body, { member_ids: ['019f0000-aaaa-7bbb-8ccc-000000000101', '019f0000-aaaa-7bbb-8ccc-000000000102'] });
});

test('leave → POST .../leave, omits new_owner_id unless given', async () => {
  const plain = await captureRequest('comm.leave', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1' });
  assert.equal(plain.method, 'POST');
  assert.equal(plain.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d1/leave');
  assert.deepEqual(plain.body, {});

  const withOwner = await captureRequest('comm.leave', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', newOwnerId: '019f0000-aaaa-7bbb-8ccc-000000000109' });
  assert.deepEqual(withOwner.body, { new_owner_id: '019f0000-aaaa-7bbb-8ccc-000000000109' });
});

test('validation: member_add with neither id, remove without id, batch with empty', async () => {
  assert.match((await captureFailure('comm.member_add', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1' })).error, /memberId/);
  assert.match((await captureFailure('comm.member_remove', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1' })).error, /memberId required/);
  assert.match((await captureFailure('comm.member_remove_batch', { conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d1', memberIds: [] })).error, /non-empty/);
});

// a real-shaped conversation id: update_group refuses anything else
const CV = '01a18277-f26a-7ef9-a08d-5ffc014d7d9e';

test('update_group (name) → PATCH /conversations/{id} {name} + documented auth', async () => {
  const request = await captureRequest('comm.update_group', { conversationId: CV, name: '新群名' });
  assert.equal(request.method, 'PATCH');
  assert.equal(request.url, `/api/v1/conversations/${CV}`);
  assert.equal(request.authorization, 'Bearer cli-contract-token');
  assert.deepEqual(request.body, { name: '新群名' });
});

test('update_group (description only) sends only description; "" is sent as-is to clear it', async () => {
  const desc = await captureRequest('comm.update_group', { conversationId: CV, description: '群说明' });
  assert.deepEqual(desc.body, { description: '群说明' });

  const cleared = await captureRequest('comm.update_group', { conversationId: CV, description: '' });
  assert.deepEqual(cleared.body, { description: '' });
});

test('update_group (both) sends name and description', async () => {
  const request = await captureRequest('comm.update_group', {
    conversationId: CV, name: 'n', description: 'd',
  });
  assert.deepEqual(request.body, { name: 'n', description: 'd' });
});

test('update_group body is a whitelist: metadata / avatar / permissions never go out', async () => {
  const request = await captureRequest('comm.update_group', {
    conversationId: CV, name: 'n',
    metadata: { description: 'x', agent_config: {} },
    avatarMediaId: 'media-1', avatar_media_id: 'media-1', permissions: { who_can_invite: 'ALL' },
  });
  assert.deepEqual(request.body, { name: 'n' });
});

test('validation: update_group without id, with nothing to update, blank name, non-string description', async () => {
  assert.match((await captureFailure('comm.update_group', { name: 'n' })).error, /conversationId required/);
  assert.match((await captureFailure('comm.update_group', { conversationId: CV })).error, /nothing to update/);
  assert.match((await captureFailure('comm.update_group', { conversationId: CV, metadata: { a: 1 } })).error, /nothing to update/);
  assert.match((await captureFailure('comm.update_group', { conversationId: CV, name: '  ' })).error, /non-empty/);
  assert.match((await captureFailure('comm.update_group', { conversationId: CV, name: 7 })).error, /non-empty/);
  assert.match((await captureFailure('comm.update_group', { conversationId: CV, description: 123 })).error, /description must be a string/);
  // the id is spliced into the path: anything but a UUID is refused before a request
  for (const bad of ['../members', 'a/b?c=1', 'cv-1', `${CV}/members`]) {
    assert.match((await captureFailure('comm.update_group', { conversationId: bad, name: 'n' })).error, /must be a UUID/);
  }
});

test('update_group: name is at most 200 characters (code points), refused locally beyond', async () => {
  const max = '群'.repeat(200);
  const request = await captureRequest('comm.update_group', { conversationId: CV, name: max });
  assert.deepEqual(request.body, { name: max });
  // 200 astral characters are 400 UTF-16 units — still within the limit
  const astral = '😀'.repeat(200);
  assert.deepEqual((await captureRequest('comm.update_group', { conversationId: CV, name: astral })).body, { name: astral });
  assert.match((await captureFailure('comm.update_group', { conversationId: CV, name: '群'.repeat(201) })).error, /too long \(max 200 characters\)/);
});

test('create_group: name is at most 200 characters (code points), refused locally beyond', async () => {
  const max = '群'.repeat(200);
  const request = await captureRequest('comm.create_group', { name: max, memberIds: [] });
  assert.equal(request.body.name, max);
  assert.match((await captureFailure('comm.create_group', { name: '群'.repeat(201), memberIds: [] })).error, /too long \(max 200 characters\)/);
  assert.match((await captureFailure('comm.create_group', { title: '群'.repeat(201), memberIds: [] })).error, /too long/);
});

// Every command that splices conversationId into a request path refuses a value
// that is not a UUID, before any request (and before resolving an org — the
// failure helper has no server and no COCO_ORG_ID).
const BAD_PATH_IDS = ['../members', 'a/b?c=1', `${CV}/members`, 'cv-1', '', 42];
const PATH_ID_COMMANDS = [
  ['comm.get_conversation', {}],
  ['comm.update_group', { name: 'n' }],
  ['comm.member_list', {}],
  ['comm.member_add', { memberId: CV }],
  ['comm.member_add', { memberIds: [CV] }],
  ['comm.member_remove', { memberId: CV }],
  ['comm.member_remove_batch', { memberIds: [CV] }],
  ['comm.leave', {}],
  ['comm.get_messages', {}],
  ['comm.get_message', { messageId: '1790221024242' }],
  ['comm.unread', {}],
  ['comm.mark_read', { seq: 1 }],
  ['comm.send', { content: 'hi' }],
  ['comm.send_card', { title: 't', summary: 's', text: 'b', options: ['Yes'] }],
  ['comm.ask_card', { kind: 'k', askedOf: CV, title: 't', summary: 's', text: 'b', options: ['Yes'] }],
  ['comm.ask', { kind: 'k', askedOf: CV, title: 't', summary: 's', text: 'b', options: ['Yes'] }],
  // form shape: only comm.ask's own check guards this path (askChoice is not reached)
  ['comm.ask', { kind: 'k', askedOf: CV, title: 't', summary: 's', fields: [{ key: 'who', label: '谁来用？', options: ['内部', '外部'] }] }],
];

test('🔴 a conversationId that is not a UUID is refused before any request, on every path-splicing command', async () => {
  for (const [command, extra] of PATH_ID_COMMANDS) {
    assert.match((await captureFailure(command, extra)).error, /conversationId required/, `${command} without conversationId`);
    for (const bad of BAD_PATH_IDS) {
      const { error } = await captureFailure(command, { ...extra, conversationId: bad });
      assert.match(error, bad ? /conversationId must be a UUID/ : /conversationId required/, `${command} ${JSON.stringify(bad)}`);
    }
  }
});

test('member_remove: memberId (a path segment) must be a UUID', async () => {
  for (const bad of ['../leave', 'a/b?c=1', `${CV}/members`, 'm-1', 42]) {
    const { error } = await captureFailure('comm.member_remove', { conversationId: CV, memberId: bad });
    assert.match(error, /memberId must be a UUID/, JSON.stringify(bad));
  }
});

test('get_message: messageId is the message id (digits), as a string or a safe integer', async () => {
  const asString = await captureRequest('comm.get_message', { conversationId: CV, messageId: '1790221024242' });
  assert.equal(asString.method, 'GET');
  assert.equal(asString.url, `/api/v1/conversations/${CV}/messages/1790221024242`);
  const asNumber = await captureRequest('comm.get_message', { conversationId: CV, messageId: 1790221024242 });
  assert.equal(asNumber.url, `/api/v1/conversations/${CV}/messages/1790221024242`);
  assert.match((await captureFailure('comm.get_message', { conversationId: CV })).error, /messageId required/);
  for (const bad of ['../members', 'a/b?c=1', '1790221024242/x', CV, '-1', 1.5, 2 ** 63]) {
    const { error } = await captureFailure('comm.get_message', { conversationId: CV, messageId: bad });
    assert.match(error, /messageId must be a message id/, JSON.stringify(bad));
  }
});

test('the conversation-scoped reads and writes put a valid conversationId in their path unchanged', async () => {
  for (const [command, extra, method, suffix] of [
    ['comm.get_conversation', {}, 'GET', ''],
    ['comm.get_messages', {}, 'GET', '/messages'],
    ['comm.unread', {}, 'GET', '/unread'],
    ['comm.mark_read', { seq: 3 }, 'POST', '/read'],
  ]) {
    const request = await captureRequest(command, { conversationId: CV, ...extra });
    assert.equal(request.method, method, command);
    assert.equal(request.url.split('?')[0], `/api/v1/conversations/${CV}${suffix}`, command);
  }
});

test('send_card → POST .../interaction-requests with an interaction_type=choice body', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e1',
    title: 'Confirm',
    summary: 'Continue the deploy?',
    text: 'The deploy is staged and waiting.',
    options: ['Yes', 'No'],
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000e1/interaction-requests');
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e3',
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
      conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e2', title: 't', summary: 's', text: 'body', options: ['Yes'], ...extra,
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e5',
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e6', title: '确认升级', summary: 'openmax · 自动检查',
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e7', title: '要升级吗', summary: 'openmax · 自动检查',
    text: 'openmax 2.20.0 → 2.21.0。', options: [{ label: '升级', style: 'primary' }, '先不升'],
    kind: 'component-upgrade', askedOf: 'm-owner', meta: { component: 'openmax' },
  }, { allowFailure: true });
  assert.equal(request.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000e7/interaction-requests');
  assert.equal(request.body.interaction_type, 'choice');
  // The question's own arguments describe the question, not the card.
  for (const key of ['kind', 'askedOf', 'meta']) assert.equal(key in request.body.choice, false, key);
});

test('send_card refuses a card with no options', async () => {
  const failure = await captureFailure('comm.send_card', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e4', title: 't', summary: 's', text: 'body',
  });
  assert.match(failure.error, /^options: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('🔴 send_card carries the onboarding guide-card fields to the wire', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000f1', title: '选择渠道', summary: '把 agent 接到你常用的地方',
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000f2', title: '找个搭档', summary: '再加一位 agent',
    text: '加入一位搭档,分担工作。', cardKind: 'onboarding.partner',
    options: [{ label: '加入一位搭档', behavior: 'open_create_agent' }],
  });
  assert.equal(request.body.choice.kind, 'onboarding.partner');
  assert.equal(request.body.choice.options[0].behavior, 'open_create_agent');
});

test('🔴 ask_card refuses a card no one can answer, before anything is sent', async () => {
  // It would record a pending question that never receives a receipt.
  const failure = await captureFailure('comm.ask_card', {
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000f3', title: '找个搭档', summary: '再加一位 agent',
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000f4', title: '选择渠道', summary: 's', text: 'body',
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
        conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000e0', title: 't', summary: 's', text: 'b',
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
            COCO_ORG_ID: TEST_ORG_ID,
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
  conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d2', title: '我能帮你做这些', summary: '选一个开始',
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
  for (const r of requests) assert.equal(r.url, '/api/v1/conversations/019f0000-aaaa-7bbb-8ccc-0000000000d2/interaction-requests');
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d2', content: '1. 任务一\n2. 任务二\n3. 任务三',
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

test('update_group passes a server 403 (not owner/admin) through as {error, status} and is not retried', async () => {
  const { requests, ok, failure } = await runAgainstFlakyServer('comm.update_group', {
    conversationId: CV, name: 'n',
  }, { failures: 100, failStatus: 403 });
  assert.equal(ok, false);
  assert.equal(failure.status, 403);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/v1/conversations/${CV}`);
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
          COCO_AUTH_TOKEN: 'cli-contract-token', COCO_USER_TOKEN: '', COCO_ORG_ID: TEST_ORG_ID, COCO_RPC_LOG: '0',
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
  conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d4', title: '对了，你日常用哪个办公沟通工具？', text: '可以把我接入。',
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

test('🔴 ask_card re-reads im_channels with the im_order its TZ selects, and refuses a reordered card', async (t) => {
  // agentTimeZone() reads TZ= from the agent's zylos .env (ZYLOS_DIR, else
  // $HOME/zylos) before TZ; an inherited ZYLOS_DIR whose .env sets TZ would
  // decide the order instead of the TZ under test. Point it at an empty dir.
  const emptyZylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-tz-'));
  t.after(() => fs.rmSync(emptyZylosDir, { recursive: true, force: true }));
  for (const [tz, want] of [['Asia/Shanghai', 'cn'], ['UTC', 'intl']]) {
    const { requests, failure } = await runWithProfileOptions(
      imCard(IM12.map((c) => c.label)), { profileOptions: { im_channels: IM12 }, env: { TZ: tz, ZYLOS_DIR: emptyZylosDir } },
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
    conversationId: '019f0000-aaaa-7bbb-8ccc-0000000000d3', body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'x' }, attachments: [] }, ...forged },
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

test('comm.ask (choice and form) carries agent_run, claimed by the card client_msg_id', async () => {
  const form = {
    conversationId: RUN_CONV, kind: 'k', askedOf: 'm-owner', title: '两个问题',
    fields: [{ key: 'who', label: '谁来用？', options: ['内部', '外部'] }],
  };
  for (const params of [
    plainCard({ kind: 'k', askedOf: 'm-owner', interactionType: 'choice' }),
    { ...form, interactionType: 'form' },
    form,
  ]) {
    await withLiveRun(async (store) => {
      // The stub answers {} (no action_ids / form_option_ids): the verb fails
      // AFTER the post, which keeps the test from writing a pending record.
      const { requests } = await runAgainstFlakyServer('comm.ask', params, { failures: 0 });
      const post = requests.find((r) => r.url.endsWith('/interaction-requests'));
      assert.equal(post.body.agent_run.run_id, 'r_000000c1', JSON.stringify(params));
      assert.equal(store.readClaim('r_000000c1').client_msg_id, post.body.client_msg_id);
      assert.equal(store.readClaim('r_000000c1').state, 'delivered');
      assert.equal(store.readClaim('r_000000c1').kind, 'card');
    });
  }
});

test('comm.ask form: a caller clientMsgId stays the form key and the claim key; a 422 resends it once without agent_run', async () => {
  const form = {
    conversationId: RUN_CONV, kind: 'k', askedOf: 'm-owner', title: '两个问题', clientMsgId: 'cm_form_1',
    fields: [{ key: 'who', label: '谁来用？', options: ['内部', '外部'] }],
  };
  await withLiveRun(async (store) => {
    const { requests } = await runAgainstFlakyServer('comm.ask', form, { failures: 1, failStatus: 422 });
    const posts = requests.filter((r) => r.url.endsWith('/interaction-requests'));
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.interaction_type, 'form');
    assert.equal(posts[0].body.client_msg_id, 'cm_form_1');
    assert.ok(posts[0].body.agent_run);
    assert.equal('agent_run' in posts[1].body, false);
    assert.equal(posts[1].body.client_msg_id, 'cm_form_1');
    assert.equal(store.claimExists('r_000000c1'), false);
    assert.equal(store.formCardExists('r_000000c1'), true);
  });
});

test('comm.send noRun: no agent_run and no claim, even with a live run; the default still attaches', async () => {
  await withLiveRun(async (store) => {
    const { requests, ok } = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'notice', noRun: true }, { failures: 0 });
    assert.equal(ok, true);
    assert.equal('agent_run' in requests[0].body, false);
    assert.equal('noRun' in requests[0].body, false);
    assert.equal(store.claimExists('r_000000c1'), false);
    const dflt = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'reply', noRun: false }, { failures: 0 });
    assert.equal(dflt.requests[0].body.agent_run.run_id, 'r_000000c1');
    assert.equal(store.readClaim('r_000000c1').client_msg_id, dflt.requests[0].body.client_msg_id);
  });
});

test('comm.send_card / ask_card / ask noRun: no agent_run and no claim, even with a live run', async () => {
  const form = {
    conversationId: RUN_CONV, kind: 'k', askedOf: 'm-owner', title: '两个问题', noRun: true,
    fields: [{ key: 'who', label: '谁来用？', options: ['内部', '外部'] }],
  };
  for (const [command, params] of [
    ['comm.send_card', plainCard({ noRun: true })],
    ['comm.ask_card', plainCard({ kind: 'k', askedOf: 'm-owner', noRun: true })],
    ['comm.ask', plainCard({ kind: 'k', askedOf: 'm-owner', interactionType: 'choice', noRun: true })],
    ['comm.ask', form],
  ]) {
    await withLiveRun(async (store) => {
      const { requests } = await runAgainstFlakyServer(command, params, { failures: 0 });
      const post = requests.find((r) => r.url.endsWith('/interaction-requests'));
      assert.ok(post, command);
      assert.equal('agent_run' in post.body, false, command);
      assert.equal('noRun' in post.body, false, command);
      assert.equal(store.claimExists('r_000000c1'), false, command);
    });
  }
});

// ── OPENM-1337: optional sourceMessageId selects that message's run ──

const SRC_A = '7300000000000000132';
const SRC_B = '7300000000000000133';

/** Two live runs in RUN_CONV (A and B of one merged turn), B focused. */
async function withMergedRuns(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-1337-'));
  const store = createRunStore({ dir });
  const t = Date.now();
  for (const [id, src, i, extra] of [['r_000013a1', SRC_A, 0, {}], ['r_000013b1', SRC_B, 1, { focus: true }]]) {
    store.writeRun({
      v: 1, run_id: id, org_id: 'org', conversation_id: RUN_CONV, reply_conversation_id: RUN_CONV, source_message_id: src,
      created_at: t - 5000 + i, state: 'active', events: [], dropped: 0, next_event: 1, seq: 1, ...extra,
    });
  }
  store.writeActive({ v: 1, by_conversation: { [RUN_CONV]: ['r_000013a1', 'r_000013b1'] }, gate: { org: 'open' } });
  const prev = process.env.OPENMAX_RUNS_DIR;
  process.env.OPENMAX_RUNS_DIR = dir;
  try {
    return await fn(store);
  } finally {
    process.env.OPENMAX_RUNS_DIR = prev;
  }
}

test('1337: comm.send / send_card / ask_card / ask with sourceMessageId attach that message\'s run, not the focus; the id is not sent', async () => {
  const form = {
    conversationId: RUN_CONV, kind: 'k', askedOf: 'm-owner', title: '两个问题', sourceMessageId: SRC_A,
    fields: [{ key: 'who', label: '谁来用？', options: ['内部', '外部'] }],
  };
  for (const [command, params] of [
    ['comm.send', { conversationId: RUN_CONV, content: 'A 的答案', sourceMessageId: SRC_A }],
    ['comm.send_card', plainCard({ sourceMessageId: SRC_A })],
    ['comm.ask_card', plainCard({ kind: 'k', askedOf: 'm-owner', sourceMessageId: SRC_A })],
    ['comm.ask', plainCard({ kind: 'k', askedOf: 'm-owner', interactionType: 'choice', sourceMessageId: SRC_A })],
    ['comm.ask', form],
  ]) {
    await withMergedRuns(async (store) => {
      const { requests } = await runAgainstFlakyServer(command, params, { failures: 0 });
      const post = requests.find((r) => /\/(messages|interaction-requests)$/.test(r.url));
      assert.ok(post, command);
      assert.equal(post.body.agent_run.run_id, 'r_000013a1', command);
      assert.equal(post.body.agent_run.source_message_id, SRC_A, command);
      assert.equal(JSON.stringify(post.body).includes('sourceMessageId'), false, command);
      assert.equal(store.claimExists('r_000013b1'), false, command);
    });
  }
});

test('1337: comm.send with a sourceMessageId no run has → no agent_run, no claim; without one → the focus, as before', async () => {
  await withMergedRuns(async (store) => {
    const none = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'x', sourceMessageId: '7300000000000000160' }, { failures: 0 });
    assert.equal(none.ok, true);
    assert.equal('agent_run' in none.requests[0].body, false);
    assert.equal(store.claimExists('r_000013a1') || store.claimExists('r_000013b1'), false);
    const dflt = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'y' }, { failures: 0 });
    assert.equal(dflt.requests[0].body.agent_run.run_id, 'r_000013b1');
  });
});

test('1337: sourceMessageId must be a string of digits — refused before anything is sent', async () => {
  for (const bad of [7300000000000000132, 'abc', '', true, { id: '1' }]) {
    const { requests, ok, failure } = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'x', sourceMessageId: bad }, { failures: 0 });
    assert.equal(ok, false, JSON.stringify(bad));
    assert.equal(requests.length, 0);
    assert.match(JSON.stringify(failure), /sourceMessageId must be/);
  }
});

test('noRun must be a boolean', async () => {
  const { requests, ok, failure } = await runAgainstFlakyServer('comm.send', { conversationId: RUN_CONV, content: 'x', noRun: 'yes' }, { failures: 0 });
  assert.equal(ok, false);
  assert.equal(requests.length, 0);
  assert.match(JSON.stringify(failure), /noRun must be a boolean/);
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
