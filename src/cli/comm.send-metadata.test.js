import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// comm.send `metadata` / `fallback_text` pass-through (Workflows AGENT_STRUCTURED
// sends): carried unchanged when given, the body byte-identical when not, and
// anything cws-comm would refuse — or the reserved metadata.context — refused
// before a single request goes out.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Hermetic: a temp HOME and runs dir, so no host org config or live run leaks
// an agent_run into these bodies.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-meta-home-'));
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-meta-runs-'));

async function run(verb, params) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, raw, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, verb, JSON.stringify(params)],
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
        (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
      );
    });
    return { requests, posts: requests.filter((r) => r.method === 'POST'), ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const send = (params) => run('comm.send', params);

const CONV = '019f0000-aaaa-7bbb-8ccc-000000000201';
const STRUCTURED = {
  conversationId: CONV,
  clientMsgId: 'cmsg-wf-1',
  type: 'AGENT_STRUCTURED',
  content: { content_type: 'workflow.run_card', body: { run_id: 'r1', status: 'ok' } },
};

// ---- pass-through ---------------------------------------------------------

test('🔴 metadata and fallback_text are carried unchanged on a structured send', async () => {
  const metadata = { wf_ref: { workflow_id: 'wf-1', run_id: 'r1' }, nested: [1, { a: null }], flag: false };
  const { ok, posts, stderr } = await send({ ...STRUCTURED, metadata, fallback_text: '工作流 r1 已完成' });
  assert.equal(ok, true, stderr);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {
    client_msg_id: 'cmsg-wf-1',
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'workflow.run_card', body: { run_id: 'r1', status: 'ok' }, attachments: [] },
    metadata,
    fallback_text: '工作流 r1 已完成',
  });
});

test('metadata alone and fallback_text alone are each carried without the other', async () => {
  const a = await send({ conversationId: CONV, content: 'hi', metadata: { k: 'v' } });
  assert.equal(a.ok, true, a.stderr);
  assert.deepEqual(a.posts[0].body.metadata, { k: 'v' });
  assert.equal('fallback_text' in a.posts[0].body, false);
  const b = await send({ conversationId: CONV, content: 'hi', fallback_text: 'preview' });
  assert.equal(b.ok, true, b.stderr);
  assert.equal(b.posts[0].body.fallback_text, 'preview');
  assert.equal('metadata' in b.posts[0].body, false);
});

test('fallbackText is accepted as the camel-case alias and sent as fallback_text', async () => {
  const { ok, posts, stderr } = await send({ ...STRUCTURED, fallbackText: 'preview' });
  assert.equal(ok, true, stderr);
  assert.equal(posts[0].body.fallback_text, 'preview');
  assert.equal('fallbackText' in posts[0].body, false);
});

test('an empty metadata object and an empty fallback_text are still sent as given', async () => {
  const { ok, posts, stderr } = await send({ ...STRUCTURED, metadata: {}, fallback_text: '' });
  assert.equal(ok, true, stderr);
  assert.deepEqual(posts[0].body.metadata, {});
  assert.equal(posts[0].body.fallback_text, '');
});

test('other metadata keys are not filtered (context-like and dotted keys pass as given)', async () => {
  const metadata = { 'context_hint': 'x', 'a.b': 1, preferred_connectors: ['gmail'] };
  const { ok, posts, stderr } = await send({ ...STRUCTURED, metadata });
  assert.equal(ok, true, stderr);
  assert.deepEqual(posts[0].body.metadata, metadata);
});

// The CLI sets no metadata of its own; its own top-level fields stay its own.
test('caller metadata/fallback_text never displace the CLI-built fields', async () => {
  const { ok, posts, stderr } = await send({
    conversationId: CONV, clientMsgId: 'cmsg-own', content: 'hi', replyTo: '42',
    metadata: { client_msg_id: 'forged', type: 'SYSTEM', parent_id: '1' }, fallback_text: 'p',
  });
  assert.equal(ok, true, stderr);
  const { body } = posts[0];
  assert.equal(body.client_msg_id, 'cmsg-own');
  assert.equal(body.type, 'AGENT_TEXT');
  assert.equal(body.parent_id, '42');
  assert.deepEqual(body.metadata, { client_msg_id: 'forged', type: 'SYSTEM', parent_id: '1' });
});

test('advanced pre-built body: top-level metadata/fallback_text are added to it', async () => {
  const prebuilt = { type: 'AGENT_STRUCTURED', content: { content_type: 'x', body: { a: 1 } } };
  const { ok, posts, stderr } = await send({
    conversationId: CONV, clientMsgId: 'c-adv', body: prebuilt, metadata: { k: 1 }, fallback_text: 'p',
  });
  assert.equal(ok, true, stderr);
  assert.deepEqual(posts[0].body, { client_msg_id: 'c-adv', ...prebuilt, metadata: { k: 1 }, fallback_text: 'p' });
});

// A body without type+content is not a pre-built body: buildSendBody ignores
// it, so its metadata / fallback_text are ignored too (as before this change).
test('a body that is not pre-built (no type+content) contributes no metadata / fallback_text', async () => {
  const { ok, posts, stderr } = await send({
    conversationId: CONV, clientMsgId: 'c-np', content: 'hi', body: { metadata: { k: 1, context: {} }, fallback_text: 'pv' },
  });
  assert.equal(ok, true, stderr);
  assert.equal(posts[0].raw, JSON.stringify({
    client_msg_id: 'c-np',
    type: 'AGENT_TEXT',
    content: { content_type: 'text', body: { text: 'hi' }, attachments: [] },
  }));
  // Half a pre-built body (type only, or content only) is not one either.
  for (const partial of [{ type: 'AGENT_TEXT' }, { content: { content_type: 'text', body: { text: 'x' } } }]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await send({ conversationId: CONV, content: 'hi', body: { ...partial, metadata: { k: 1 }, fallback_text: 'pv' } });
    assert.equal(r.ok, true, r.stderr);
    assert.equal('metadata' in r.posts[0].body, false, JSON.stringify(partial));
    assert.equal('fallback_text' in r.posts[0].body, false, JSON.stringify(partial));
  }
  // …and does not clash with the top-level fields either.
  const both = await send({ conversationId: CONV, content: 'hi', metadata: { a: 1 }, body: { metadata: { b: 2 } } });
  assert.equal(both.ok, true, both.stderr);
  assert.deepEqual(both.posts[0].body.metadata, { a: 1 });
});

// ---- absent → unchanged ---------------------------------------------------

test('🔴 without metadata/fallback_text the wire body is byte-identical to before', async () => {
  const plain = await send({ conversationId: CONV, clientMsgId: 'c-plain', content: 'hi', replyTo: '7' });
  assert.equal(plain.ok, true, plain.stderr);
  assert.equal(plain.posts[0].raw, JSON.stringify({
    client_msg_id: 'c-plain',
    type: 'AGENT_TEXT',
    content: { content_type: 'text', body: { text: 'hi' }, attachments: [] },
    parent_id: '7',
  }));
  const structured = await send(STRUCTURED);
  assert.equal(structured.posts[0].raw, JSON.stringify({
    client_msg_id: 'cmsg-wf-1',
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'workflow.run_card', body: { run_id: 'r1', status: 'ok' }, attachments: [] },
  }));
  const prebuilt = { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'x' } }, metadata: { k: 1 } };
  const adv = await send({ conversationId: CONV, clientMsgId: 'c-adv', body: prebuilt });
  assert.equal(adv.posts[0].raw, JSON.stringify({ client_msg_id: 'c-adv', ...prebuilt }));
});

// ---- refusals (nothing is sent, not even the roster GET) ------------------

async function assertRefused(params, re) {
  const { ok, requests, stderr } = await send(params);
  assert.equal(ok, false, `expected refusal for ${JSON.stringify(params).slice(0, 200)}`);
  assert.equal(requests.length, 0, 'no request may go out');
  assert.match(stderr, re);
}

test('🔴 metadata that is not a plain object is refused', async () => {
  await assertRefused({ ...STRUCTURED, metadata: [] }, /comm\.send: metadata must be a plain JSON object, got an array/);
  await assertRefused({ ...STRUCTURED, metadata: null }, /metadata must be a plain JSON object, got null/);
  await assertRefused({ ...STRUCTURED, metadata: 'k=v' }, /metadata must be a plain JSON object, got string/);
  await assertRefused({ ...STRUCTURED, metadata: 3 }, /metadata must be a plain JSON object, got number/);
});

test('🔴 metadata.context is refused as reserved — top level and in a pre-built body', async () => {
  await assertRefused({ ...STRUCTURED, metadata: { context: { workflow: 'forged' }, ok: 1 } },
    /comm\.send: metadata\.context is reserved/);
  // Present even with an empty / null value is still a forgery attempt.
  await assertRefused({ ...STRUCTURED, metadata: { context: null } }, /metadata\.context is reserved/);
  await assertRefused({
    conversationId: CONV,
    body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'x' } }, metadata: { context: {} } },
  }, /metadata\.context is reserved/);
  // With @mention text that would otherwise trigger the roster fetch.
  await assertRefused({ conversationId: CONV, content: '@nobody hi', metadata: { context: {} } },
    /metadata\.context is reserved/);
});

test('🔴 fallback_text that is not a string is refused', async () => {
  await assertRefused({ ...STRUCTURED, fallback_text: 5 }, /comm\.send: fallback_text must be a string, got number/);
  await assertRefused({ ...STRUCTURED, fallback_text: null }, /fallback_text must be a string, got null/);
  await assertRefused({ ...STRUCTURED, fallback_text: { text: 'x' } }, /fallback_text must be a string, got object/);
  await assertRefused({ ...STRUCTURED, fallbackText: ['x'] }, /fallback_text must be a string, got an array/);
});

test('🔴 fallback_text over 8192 UTF-8 bytes is refused; exactly 8192 is sent', async () => {
  // 2730 CJK chars (3 bytes each) + 2 ASCII = 8192 bytes in 2732 characters.
  const atCap = '中'.repeat(2730) + 'ab';
  const ok = await send({ ...STRUCTURED, fallback_text: atCap });
  assert.equal(ok.ok, true, ok.stderr);
  assert.equal(ok.posts[0].body.fallback_text, atCap);
  // One byte over, still far under 8192 characters: the cap is bytes, not chars.
  await assertRefused({ ...STRUCTURED, fallback_text: `${atCap}c` },
    /comm\.send: fallback_text is 8193 UTF-8 bytes; the limit is 8192/);
  await assertRefused({ ...STRUCTURED, fallback_text: 'a'.repeat(8193) }, /fallback_text is 8193 UTF-8 bytes/);
});

test('the same field given in two places is refused, not resolved by precedence', async () => {
  await assertRefused({ ...STRUCTURED, fallback_text: 'a', fallbackText: 'b' },
    /fallback_text given both as fallback_text and fallbackText/);
  await assertRefused({
    conversationId: CONV,
    body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'x' } }, metadata: { a: 1 } },
    metadata: { b: 2 },
  }, /metadata given both as metadata and body\.metadata/);
});

// ---- card verbs have neither field ----------------------------------------

test('card verbs refuse metadata / fallback_text (interaction-requests has no such field)', async () => {
  for (const key of ['metadata', 'fallback_text']) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await run('comm.send_card', {
      conversationId: CONV, title: 't', summary: 's', text: 'x', options: ['a', 'b'], [key]: key === 'metadata' ? {} : 'p',
    });
    assert.equal(ok, false);
    assert.equal(posts.length, 0);
    assert.match(stderr, new RegExp(`${key}: is not supported by interaction-requests`));
  }
});

test('comm.ask_card and comm.ask (choice and form) refuse metadata / fallback_text', async () => {
  const choice = { conversationId: CONV, title: 't', summary: 's', text: 'x', options: ['a', 'b'], kind: 'k', askedOf: 'm-1' };
  const form = { conversationId: CONV, title: 't', summary: 's', fields: [{ key: 'q', label: 'Q', options: ['a', 'b'] }], kind: 'k', askedOf: 'm-1' };
  const cases = [
    ['comm.ask_card', choice, /is not supported by interaction-requests/],
    ['comm.ask', { ...choice, interactionType: 'choice' }, /is not supported by interaction-requests/],
    ['comm.ask', { ...form, interactionType: 'form' }, /is not supported on a form card/],
  ];
  for (const [verb, base, re] of cases) {
    for (const [key, value] of [['metadata', { k: 1 }], ['fallback_text', 'p']]) {
      // eslint-disable-next-line no-await-in-loop
      const { ok, posts, stderr } = await run(verb, { ...base, [key]: value });
      assert.equal(ok, false, `${verb} ${base.interactionType || ''} accepted ${key}`);
      assert.equal(posts.length, 0, `${verb} posted with ${key}`);
      assert.match(stderr, new RegExp(`${key}: ${re.source}`));
    }
  }
});
