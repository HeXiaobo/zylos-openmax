import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// At the CLI: every card verb refuses Markdown in the plain-text
// body, exits non-zero, and sends no POST. Same hermetic harness as
// comm.send-metadata.test.js.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Hermetic: a temp HOME and runs dir, so no host org config or live run leaks
// an agent_run into these bodies.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-cardmd-home-'));
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-cardmd-runs-'));

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
const CONV = '00000000-0000-4000-8000-000000000001';
const choice = { conversationId: CONV, title: 't', options: ['a', 'b'] };
const form = { conversationId: CONV, title: 't', fields: [{ key: 'q', label: 'Q', options: ['a', 'b'] }] };

test('🔴 send_card, ask_card and ask (choice, form) refuse Markdown in text with no POST', async () => {
  const cases = [
    ['comm.send_card', { ...choice, text: '**重要**：会重启服务' }, 'text'],
    ['comm.send_card', { ...choice, blocks: [{ type: 'text', text: 'a **b**' }] }, 'blocks[0].text'],
    ['comm.ask_card', { ...choice, text: '[notes](https://e.com)', kind: 'k', askedOf: 'm-1' }, 'text'],
    ['comm.ask', { ...choice, text: '# Title', kind: 'k', askedOf: 'm-1', interactionType: 'choice' }, 'text'],
    ['comm.ask', { ...form, text: '```\nx\n```', kind: 'k', askedOf: 'm-1' }, 'text'],
  ];
  for (const [verb, params, field] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await run(verb, params);
    assert.equal(ok, false, `${verb} accepted ${JSON.stringify(params)}`);
    assert.equal(posts.length, 0, `${verb} posted`);
    const { error } = JSON.parse(stderr.trim().split('\n').pop());
    assert.ok(error.startsWith(`${field}: contains Markdown`), `${verb}: ${error}`);
    assert.match(error, /"type":"markdown"/);
  }
});

test('the same body as a markdown block is sent', async () => {
  const { posts } = await run('comm.send_card', { ...choice, blocks: [{ type: 'markdown', text: '**重要**' }] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.choice.blocks[0].type, 'markdown');
});
