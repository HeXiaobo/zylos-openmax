import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Hermetic: an empty HOME keeps the host's org config and tokens out of the
// spawned CLI; every request goes to the local stub below.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-topic-title-home-'));
const TOPIC = '019f0000-aaaa-7bbb-8ccc-0000000000e1';

/**
 * Run `comm.set_topic_title` against a stub that answers with `status` / `body`.
 * Resolves with the requests the stub saw and the CLI's exit code and output.
 */
async function run(params, { status = 200, body = { data: {}, request_id: 't' } } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, 'comm.set_topic_title', JSON.stringify(params)],
        {
          env: {
            ...process.env,
            HOME,
            COCO_API_URL: `http://127.0.0.1:${port}`,
            COCO_API_PREFIX: '/api/v1',
            COCO_AUTH_TOKEN: 'cli-contract-token',
            COCO_USER_TOKEN: '',
            COCO_ORG_ID: 'org-test',
            COCO_RPC_LOG: '0',
          },
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, requests }),
      );
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const lastJson = (text) => JSON.parse(text.trim().split('\n').pop());

test('set_topic_title → PATCH /subconversations/{id} with the trimmed title only', async () => {
  const r = await run({ conversationId: TOPIC, title: '  周报格式讨论  ', name: 'ignored' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].method, 'PATCH');
  assert.equal(r.requests[0].url, `/api/v1/subconversations/${TOPIC}`);
  assert.deepEqual(r.requests[0].body, { title: '周报格式讨论' });
});

test('a title is at most 20 characters, counted in code points; longer, blank or missing is refused before any request', async () => {
  assert.equal((await run({ conversationId: TOPIC, title: '话'.repeat(20) })).code, 0);
  assert.equal((await run({ conversationId: TOPIC, title: '𠀀'.repeat(20) })).code, 0);

  for (const [params, pattern] of [
    [{ conversationId: TOPIC, title: '话'.repeat(21) }, /too long \(max 20/],
    [{ conversationId: TOPIC, title: '𠀀'.repeat(21) }, /too long \(max 20/],
    // 11 characters as people see them, 22 code points: the count is code points.
    [{ conversationId: TOPIC, title: 'e\u0301'.repeat(11) }, /too long \(max 20/],
    [{ conversationId: TOPIC, title: '   ' }, /non-empty/],
    [{ conversationId: TOPIC, title: 7 }, /non-empty/],
    [{ conversationId: TOPIC }, /non-empty/],
    [{ title: 'x' }, /conversationId required/],
    [{ conversationId: '../members', title: 'x' }, /must be a UUID/],
  ]) {
    const r = await run(params);
    assert.equal(r.code, 1, JSON.stringify(params));
    assert.match(lastJson(r.stderr).error, pattern);
    assert.equal(r.requests.length, 0, `no request for ${JSON.stringify(params)}`);
  }
});

test('a refusal keeps the HTTP status and passes the server error code through as `code`', async () => {
  const r = await run(
    { conversationId: TOPIC, title: '新标题' },
    { status: 409, body: { error: { status: 409, title: 'Conflict', detail: 'title was set by a person', code: 'COMM_TOPIC_TITLE_SET_BY_USER' } } },
  );
  assert.equal(r.code, 1);
  const out = lastJson(r.stderr);
  assert.equal(out.status, 409);
  assert.equal(out.code, 'COMM_TOPIC_TITLE_SET_BY_USER');
  assert.equal(out.error, 'title was set by a person');
  assert.equal(r.requests.length, 1);
});
