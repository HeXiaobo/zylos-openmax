import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// comm.send with attachments: shorthand content must carry them (or refuse
// clearly), and a message with no text and no attachments is never posted.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Hermetic: a temp HOME and an explicit org, so neither the host's org config
// nor a live run (see comm.test.js) leaks into these sends.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-att-home-'));
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-att-runs-'));

// Run comm.send against a stub server; return every request it received and
// how the CLI exited.
async function send(params) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
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
        [cliPath, 'comm.send', JSON.stringify(params)],
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

const CONV = '019f0000-aaaa-7bbb-8ccc-000000000202';
const PDF = { artifact_id: 'art-pdf', file_name: 'weekly.pdf', content_type: 'application/pdf', size_bytes: 10 };
const PNG = { artifact_id: 'art-png', file_name: 'shot.png', content_type: 'image/png', size_bytes: 20 };

test('🔴 shorthand {text, attachments} carries the attachments as a FILE message', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: { text: '周报', attachments: [PDF] } });
  assert.equal(ok, true);
  assert.equal(posts.length, 1);
  const { body } = posts[0];
  assert.equal(body.type, 'FILE');
  assert.deepEqual(body.content, {
    content_type: 'file',
    body: { file_name: 'weekly.pdf', text: '周报' },
    attachments: [PDF],
  });
});

test('🔴 shorthand with only image attachments and no text is an IMAGE message', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: { attachments: [PNG] } });
  assert.equal(ok, true);
  const { body } = posts[0];
  assert.equal(body.type, 'IMAGE');
  assert.deepEqual(body.content, { content_type: 'image', body: { file_name: 'shot.png' }, attachments: [PNG] });
});

test('mixed image + file attachments are a FILE message', async () => {
  const { posts } = await send({ conversationId: CONV, content: { text: 'x', attachments: [PNG, PDF] } });
  assert.equal(posts[0].body.type, 'FILE');
  assert.equal(posts[0].body.content.content_type, 'file');
  assert.deepEqual(posts[0].body.content.attachments, [PNG, PDF]);
});

test('🔴 top-level params.attachments with string content are carried', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: '看图', attachments: [PNG] });
  assert.equal(ok, true);
  const { body } = posts[0];
  assert.equal(body.type, 'IMAGE');
  assert.deepEqual(body.content.attachments, [PNG]);
  assert.equal(body.content.body.text, '看图');
});

test('🔴 an attachment without artifact_id is refused before anything is sent', async () => {
  const { artifact_id: _drop, ...noId } = PDF;
  const { ok, posts, stderr } = await send({ conversationId: CONV, content: { text: 'x', attachments: [noId] } });
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.match(stderr, /attachments\[0\] has no artifact_id/);
});

// as.upload returns {artifactId, fileName, mimeType, sizeBytes}. Renaming only
// artifactId must not send a FILE with an empty name and the camel keys
// passed through verbatim.
test('🔴 an as.upload-shaped item (camel keys, only artifactId renamed) is refused', async () => {
  const uploaded = { artifactId: 'art-png', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 20 };
  const { artifactId, ...rest } = uploaded;
  for (const item of [uploaded, { artifact_id: artifactId, ...rest }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { attachments: [item] } });
    assert.equal(ok, false, JSON.stringify(item));
    assert.equal(posts.length, 0, JSON.stringify(item));
    assert.match(stderr, /attachments\[0\] has camel-case key\(s\) .*fileName.*mimeType.*sizeBytes/);
    assert.match(stderr, /snake_case/);
  }
});

test('🔴 an item missing file_name or content_type is refused', async () => {
  for (const k of ['file_name', 'content_type']) {
    const { [k]: _drop, ...item } = PNG;
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { attachments: [item] } });
    assert.equal(ok, false, k);
    assert.equal(posts.length, 0, k);
    assert.match(stderr, new RegExp(`attachments\\[0\\] has no ${k}`));
  }
});

test('🔴 an item without an integer size_bytes is refused (the server requires it)', async () => {
  const { size_bytes: _drop, ...noSize } = PNG;
  for (const item of [noSize, { ...PNG, size_bytes: '20' }, { ...PNG, size_bytes: -1 }, { ...PNG, size_bytes: 1.5 }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { attachments: [item] } });
    assert.equal(ok, false, JSON.stringify(item));
    assert.equal(posts.length, 0, JSON.stringify(item));
    assert.match(stderr, /attachments\[0\] has no size_bytes/);
  }
  const { ok, posts } = await send({ conversationId: CONV, content: { attachments: [{ ...PNG, size_bytes: 0 }] } });
  assert.equal(ok, true);
  assert.equal(posts.length, 1);
});

test('🔴 a whitespace-only artifact_id / file_name / content_type is refused', async () => {
  for (const k of ['artifact_id', 'file_name', 'content_type']) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { attachments: [{ ...PNG, [k]: '   ' }] } });
    assert.equal(ok, false, k);
    assert.equal(posts.length, 0, k);
    assert.match(stderr, new RegExp(`attachments\\[0\\] has no ${k}`));
  }
});

test('🔴 every item is checked: a valid first item does not let an invalid second one through', async () => {
  const { artifact_id: _drop, ...noId } = PDF;
  for (const second of [noId, { ...PDF, fileName: 'weekly.pdf' }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { text: 'x', attachments: [PNG, second] } });
    assert.equal(ok, false, JSON.stringify(second));
    assert.equal(posts.length, 0, JSON.stringify(second));
    assert.match(stderr, /attachments\[1\] has/);
  }
});

test('🔴 pre-built content object: camel-case or incomplete attachment items are refused', async () => {
  const camel = { artifactId: 'art-png', fileName: 'shot.png', mimeType: 'image/png' };
  const { artifact_id: _drop, ...noId } = PNG;
  for (const [item, why] of [[camel, /attachments\[0\] has camel-case key\(s\)/], [noId, /attachments\[0\] has no artifact_id/]]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({
      conversationId: CONV,
      content: { content_type: 'image', body: { file_name: 'shot.png' }, attachments: [item] },
    });
    assert.equal(ok, false, JSON.stringify(item));
    assert.equal(posts.length, 0, JSON.stringify(item));
    assert.match(stderr, why);
  }
  const notArray = await send({ conversationId: CONV, content: { content_type: 'image', body: { file_name: 'x' }, attachments: PNG } });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.posts.length, 0);
  assert.match(notArray.stderr, /attachments must be an array/);
});

test('pre-built content object with valid snake_case items still goes out unchanged', async () => {
  const content = { content_type: 'image', body: { file_name: 'shot.png', text: 'cap' }, attachments: [PNG] };
  const { ok, posts } = await send({ conversationId: CONV, content });
  assert.equal(ok, true);
  assert.equal(posts[0].body.type, 'IMAGE');
  assert.deepEqual(posts[0].body.content, content);
});

test('🔴 array content is refused, with or without top-level attachments', async () => {
  const parts = [{ type: 'text', body: 'hi' }];
  for (const params of [{ content: parts }, { content: [] }, { content: parts, attachments: [PDF] }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, ...params });
    assert.equal(ok, false, JSON.stringify(params));
    assert.equal(posts.length, 0, JSON.stringify(params));
    assert.match(stderr, /content cannot be an array/);
  }
});

test('image detection ignores content_type case', async () => {
  const upper = { ...PNG, content_type: 'IMAGE/PNG' };
  const { ok, posts } = await send({ conversationId: CONV, content: { attachments: [upper] } });
  assert.equal(ok, true);
  assert.equal(posts[0].body.type, 'IMAGE');
  assert.deepEqual(posts[0].body.content.attachments, [upper]);
});

test('attachments given in both places, or top-level with pre-built content, are refused', async () => {
  const both = await send({ conversationId: CONV, content: { text: 'x', attachments: [PDF] }, attachments: [PNG] });
  assert.equal(both.ok, false);
  assert.equal(both.posts.length, 0);
  assert.match(both.stderr, /both in content\.attachments and top-level/);

  const prebuilt = await send({
    conversationId: CONV,
    content: { content_type: 'file', body: { file_name: 'weekly.pdf' }, attachments: [PDF] },
    attachments: [PNG],
  });
  assert.equal(prebuilt.ok, false);
  assert.equal(prebuilt.posts.length, 0);
  assert.match(prebuilt.stderr, /pre-built content object/);
});

test('🔴 an empty message is refused client-side: nothing reaches the server', async () => {
  for (const content of ['', '   ', { text: '' }, { attachments: [] }, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content });
    assert.equal(ok, false, `content=${JSON.stringify(content)} must fail`);
    assert.equal(posts.length, 0, `content=${JSON.stringify(content)} must not be posted`);
    assert.match(stderr, /refusing to send an empty message/);
  }
});

test('a pre-built content object with neither text nor attachments is refused', async () => {
  const { ok, posts, stderr } = await send({ conversationId: CONV, content: { content_type: 'image', body: {}, attachments: [] } });
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.match(stderr, /refusing to send an empty message/);
});

test('a pre-built content object whose body is not an object is refused for that reason', async () => {
  for (const [bodyValue, kind] of [['hi', 'string'], [['x'], 'an array'], [null, 'null']]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content: { content_type: 'text', body: bodyValue } });
    assert.equal(ok, false, kind);
    assert.equal(posts.length, 0, kind);
    assert.match(stderr, new RegExp(`needs body to be an object .*got ${kind}`));
    assert.doesNotMatch(stderr, /empty message/);
  }
});

test('unchanged: plain text and the pre-built content object still go out as before', async () => {
  const plain = await send({ conversationId: CONV, content: 'hello' });
  assert.equal(plain.ok, true);
  assert.equal(plain.posts[0].body.type, 'AGENT_TEXT');
  assert.deepEqual(plain.posts[0].body.content, { content_type: 'text', body: { text: 'hello' }, attachments: [] });

  const prebuilt = await send({
    conversationId: CONV,
    content: { content_type: 'file', body: { file_name: 'weekly.pdf', text: 'x' }, attachments: [PDF] },
  });
  assert.equal(prebuilt.ok, true);
  assert.equal(prebuilt.posts[0].body.type, 'FILE');
  assert.deepEqual(prebuilt.posts[0].body.content.attachments, [PDF]);
});
