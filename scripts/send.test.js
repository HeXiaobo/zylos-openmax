import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The registry path is resolved from HOME at import time; the spawned send.js
// inherits the same HOME, so it reads the participants recorded here.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-send-test-'));
process.env.HOME = tmpHome;
const { recordParticipants } = await import('../src/lib/mention.js');

const SEND_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send.js');
const LUNA_ID = '019f6a10-1af8-73ef-b9bb-08b28dcaa998';

function startCaptureServer() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `m${posts.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, port: server.address().port }));
  });
}

function runSend(port, endpoint, message) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEND_JS, endpoint, message], {
      env: {
        ...process.env,
        HOME: tmpHome,
        COCO_API_URL: `http://127.0.0.1:${port}`,
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: 'org-test',
        COCO_RPC_LOG: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('send.js puts the whole-message mentions on every chunk it POSTs (#350)', async () => {
  const conv = 'conv-send-350';
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  const message = `@luna.coco please read\n\n${'a'.repeat(2500)}\n\n${'b'.repeat(2500)}`;

  const { server, posts, port } = await startCaptureServer();
  try {
    const { code, stderr } = await runSend(port, conv, message);
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }

  const sends = posts.filter((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.ok(sends.length > 1, `expected a split message, got ${sends.length} POST(s)`);
  assert.equal(sends[1].body.content.body.text.includes('@luna.coco'), false);
  for (const { body } of sends) {
    assert.deepEqual(body.mentions, [{ type: 'member', member_id: LUNA_ID }]);
  }
});

// ── agent activity: metadata.agent_run on replies ──────────────────────────

const RUNS_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime/runs');

function writeRunIndex(conv, runId, { gate = 'open' } = {}) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  for (const f of fs.readdirSync(RUNS_DIR)) fs.rmSync(path.join(RUNS_DIR, f));
  fs.writeFileSync(path.join(RUNS_DIR, `${runId}.json`), JSON.stringify({
    v: 1, run_id: runId, org_id: 'org-test', conversation_id: conv, reply_conversation_id: conv,
    created_at: Date.now() - 5000, state: 'active', next_event: 2, dropped: 0,
    events: [{ id: 'e1', kind: 'tool', category: 'read', tool: 'Read', at: Date.now() - 4000, ended_at: Date.now() - 3900, error: false }],
  }));
  fs.writeFileSync(path.join(RUNS_DIR, 'active.json'), JSON.stringify({ v: 1, by_conversation: { [conv]: [runId] }, gate: { 'org-test': gate } }));
}

// A fake cws-core that answers each POST with the next scripted status and,
// like cws-comm, stores a message once per client_msg_id.
function startScriptedServer(statuses = []) {
  const posts = [];
  const stored = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST') posts.push({ url: req.url, body });
      const status = req.method === 'POST' && statuses.length ? statuses.shift() : 200;
      if (status >= 400 || status === 'drop') {
        if (status === 500 && body.client_msg_id) stored.set(body.client_msg_id, body);   // stored, answer lost
        res.writeHead(status === 'drop' ? 500 : status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { title: 'x', status } }));
        return;
      }
      if (body.client_msg_id) stored.set(body.client_msg_id, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `m${posts.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, stored, port: server.address().port }));
  });
}

test('agent activity: no run index → the reply carries no metadata (feature off is unchanged)', async () => {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  const conv = 'conv-activity-off';
  const { server, posts, port } = await startScriptedServer();
  try {
    const { code, stderr } = await runSend(port, conv, 'plain reply');
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }
  assert.equal('metadata' in posts[0].body, false);
});

test('agent activity: gate open → first chunk full agent_run with the claimed key, later chunks the reference', async () => {
  const conv = 'conv-activity-on';
  writeRunIndex(conv, 'r_0000aaaa');
  const { server, posts, port } = await startScriptedServer();
  try {
    const { code, stderr } = await runSend(port, conv, `${'a'.repeat(2500)}\n\n${'b'.repeat(2500)}`);
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }
  const sends = posts.filter((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.ok(sends.length > 1);
  const ar = sends[0].body.metadata.agent_run;
  assert.equal(ar.run_id, 'r_0000aaaa');
  assert.equal(ar.state, 'done');
  assert.equal(ar.steps.at(-1).category, 'reply');
  assert.deepEqual(sends[1].body.metadata, { agent_run: { v: 1, run_id: 'r_0000aaaa' } });
  const claim = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'r_0000aaaa.reply'), 'utf8'));
  assert.equal(claim.state, 'delivered');
  assert.equal(claim.client_msg_id, sends[0].body.client_msg_id);
});

test('agent activity: gate pending → no metadata and no claim', async () => {
  const conv = 'conv-activity-pending';
  writeRunIndex(conv, 'r_0000bbbb', { gate: 'pending' });
  const { server, posts, port } = await startScriptedServer();
  try {
    await runSend(port, conv, 'hi');
  } finally {
    server.close();
  }
  assert.equal('metadata' in posts[0].body, false);
  assert.equal(fs.existsSync(path.join(RUNS_DIR, 'r_0000bbbb.reply')), false);
});

test('agent activity: 5xx keeps the claim; the identical retry reuses the key so the server stores one message', async () => {
  const conv = 'conv-activity-retry';
  writeRunIndex(conv, 'r_0000cccc');
  const { server, posts, stored, port } = await startScriptedServer([500]);
  try {
    const first = await runSend(port, conv, 'the answer');
    assert.notEqual(first.code, 0);
    const claim = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'r_0000cccc.reply'), 'utf8'));
    assert.equal(claim.state, 'pending');
    const second = await runSend(port, conv, 'the answer');
    assert.equal(second.code, 0, second.stderr);
  } finally {
    server.close();
  }
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.client_msg_id, posts[1].body.client_msg_id);
  assert.ok(posts[1].body.metadata.agent_run.steps, 'the retry carries the full summary again');
  assert.equal(stored.size, 1);
});

test('agent activity: 422 releases the claim', async () => {
  const conv = 'conv-activity-422';
  writeRunIndex(conv, 'r_0000dddd');
  const { server, port } = await startScriptedServer([422]);
  try {
    const r = await runSend(port, conv, 'bad');
    assert.notEqual(r.code, 0);
  } finally {
    server.close();
  }
  assert.equal(fs.existsSync(path.join(RUNS_DIR, 'r_0000dddd.reply')), false);
});
