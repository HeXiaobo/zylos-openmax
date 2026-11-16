import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime paths are resolved from HOME; the spawned send.js gets the same HOME.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-send-test-'));
process.env.HOME = tmpHome;

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

test('send.js sends `@name` in text as plain text: no mentions on any chunk (explicit mentions only, via [STRUCTURED])', async () => {
  const conv = 'conv-send-350';
  const message = `@luna.coco please read\n\n${'a'.repeat(2500)}\n\n${'b'.repeat(2500)} @所有人`;

  const { server, posts, port } = await startCaptureServer();
  try {
    const { code, stderr } = await runSend(port, conv, message);
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }

  const sends = posts.filter((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.ok(sends.length > 1, `expected a split message, got ${sends.length} POST(s)`);
  assert.ok(sends[0].body.content.body.text.startsWith('@luna.coco please read'), 'text unchanged');
  for (const { body } of sends) {
    assert.equal('mentions' in body, false);
  }
});

// ── agent activity: agent_run (top-level) on replies ──────────────────────────

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

test('agent activity: no run index → the reply carries no agent_run (feature off is unchanged)', async () => {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  const conv = 'conv-activity-off';
  const { server, posts, port } = await startScriptedServer();
  try {
    const { code, stderr } = await runSend(port, conv, 'plain reply');
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }
  assert.equal('agent_run' in posts[0].body, false);
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
  const ar = sends[0].body.agent_run;
  assert.equal(ar.run_id, 'r_0000aaaa');
  assert.equal(ar.schema_version, 3);
  assert.equal(ar.state, 'done');
  assert.equal(ar.steps.some((s) => s.category === 'reply'), false, 'no reply step (v3)');
  assert.equal('metadata' in sends[0].body, false);
  assert.deepEqual(sends[1].body.agent_run, { schema_version: 3, run_id: 'r_0000aaaa', ref: true });
  const claim = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'r_0000aaaa.reply'), 'utf8'));
  assert.equal(claim.state, 'delivered');
  assert.equal(claim.client_msg_id, sends[0].body.client_msg_id);
});

test('agent activity: gate pending → no agent_run and no claim', async () => {
  const conv = 'conv-activity-pending';
  writeRunIndex(conv, 'r_0000bbbb', { gate: 'pending' });
  const { server, posts, port } = await startScriptedServer();
  try {
    await runSend(port, conv, 'hi');
  } finally {
    server.close();
  }
  assert.equal('agent_run' in posts[0].body, false);
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
  assert.ok(posts[1].body.agent_run.steps, 'the retry carries the full summary again');
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

// ── OPENM-1337: the reply via endpoint names the source message (`|msg:<id>`) ──

const SRC_A = '7300000000000000132';
const SRC_B = '7300000000000000133';

/** Two live runs of one group (A and B merged into a turn), B focused — the incident shape. */
function writeMergedRuns(conv) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  for (const f of fs.readdirSync(RUNS_DIR)) fs.rmSync(path.join(RUNS_DIR, f));
  const t = Date.now();
  const run = (id, src, i, extra = {}) => fs.writeFileSync(path.join(RUNS_DIR, `${id}.json`), JSON.stringify({
    v: 1, run_id: id, org_id: 'org-test', conversation_id: conv, reply_conversation_id: conv,
    source_message_id: src, endpoint: `${conv}|msg:${src}`,
    created_at: t - 5000 + i, state: 'active', next_event: 1, dropped: 0, events: [], ...extra,
  }));
  run('r_000013a0', SRC_A, 0);
  run('r_000013b0', SRC_B, 1, { focus: true });
  fs.writeFileSync(path.join(RUNS_DIR, 'active.json'), JSON.stringify({
    v: 1, by_conversation: { [conv]: ['r_000013a0', 'r_000013b0'] }, gate: { 'org-test': 'open' },
  }));
}

test('1337: each reply via its own `|msg:` claims its own run (B focused); the wire body gains no field', async () => {
  const conv = 'conv-1337-text';
  writeMergedRuns(conv);
  const { server, posts, port } = await startScriptedServer();
  try {
    for (const [ep, text] of [[`${conv}|msg:${SRC_A}`, 'answer A'], [`${conv}|msg:${SRC_B}`, 'answer B'], [`${conv}|msg:7300000000000000160`, 'smart']]) {
      const { code, stderr } = await runSend(port, ep, text);
      assert.equal(code, 0, stderr);
    }
  } finally {
    server.close();
  }
  const sends = posts.filter((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.equal(sends.length, 3, 'the msg segment does not change the target');
  assert.equal(sends[0].body.agent_run.run_id, 'r_000013a0');
  assert.equal(sends[0].body.agent_run.source_message_id, SRC_A);
  assert.equal(sends[1].body.agent_run.run_id, 'r_000013b0');
  assert.equal(sends[1].body.agent_run.source_message_id, SRC_B);
  assert.ok(Array.isArray(sends[1].body.agent_run.steps), 'B gets its own full card');
  assert.equal('agent_run' in sends[2].body, false, 'a message with no run: no card at all');
  for (const { body } of sends) {
    assert.deepEqual(Object.keys(body).filter((k) => k !== 'agent_run').sort(), ['client_msg_id', 'content', 'type'], 'no parent_id, no msg field');
  }
  const stats = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'send-stats.json'), 'utf8'));
  assert.equal(stats.agent_run_source_matched, 2);
  assert.equal(stats.agent_run_skipped_no_source_run, 1);
});

test('1337: [CARD] via `|msg:A` carries A\'s run while B is focused', async () => {
  const conv = 'conv-1337-card';
  writeMergedRuns(conv);
  const card = { kind: 'k', askedOf: 'm-owner', title: '确认?', text: '要继续吗', options: ['是', '否'] };
  const { server, posts, port } = await startScriptedServer();
  try {
    await runSend(port, `${conv}|msg:${SRC_A}`, `[CARD]${JSON.stringify(card)}`);   // the stub returns no action_ids: fails after the POST
  } finally {
    server.close();
  }
  const post = posts.find((p) => p.url === `/api/v1/conversations/${conv}/interaction-requests`);
  assert.ok(post, 'the card was posted');
  assert.equal(post.body.agent_run.run_id, 'r_000013a0');
  assert.equal(fs.existsSync(path.join(RUNS_DIR, 'r_000013b0.reply')), false);
});

test('1337: [MEDIA:file] via `|msg:A` carries A\'s run while B is focused', async () => {
  const conv = 'conv-1337-media';
  writeMergedRuns(conv);
  const file = path.join(tmpHome, 'report-1337.txt');
  fs.writeFileSync(file, 'weekly numbers');
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST') posts.push({ url: req.url, body });
      let out = { id: `m${posts.length}` };
      if (req.url.endsWith('/uploads/prepare')) out = { upload_token: 'tok', instant_upload: true };
      else if (req.url.endsWith('/uploads/finalize')) out = { media_id: 'med-1', artifact_id: 'art-1' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { code, stderr } = await runSend(server.address().port, `${conv}|msg:${SRC_A}`, `[MEDIA:file]${file}`);
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }
  const send = posts.find((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.ok(send, 'the media message was posted');
  assert.equal(send.body.type, 'FILE');
  assert.equal(send.body.agent_run.run_id, 'r_000013a0');
  assert.equal(send.body.agent_run.source_message_id, SRC_A);
  assert.equal(fs.existsSync(path.join(RUNS_DIR, 'r_000013b0.reply')), false, 'B is left for its own answer');
});

// ── cws-comm#373: an archived sub-conversation is reported, never rerouted ──

test('409 COMM_SUBCONVERSATION_ARCHIVED → exit 1 with status 409, one POST to the sub-conversation, no reroute', async () => {
  const sub = '019f7000-0000-7000-8000-00000000000b';
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ url: req.url, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { title: 'Conflict', status: 409, code: 'COMM_SUBCONVERSATION_ARCHIVED', detail: 'sub-conversation is archived' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let r;
  try {
    r = await runSend(server.address().port, `${sub}|msg:7300000000000000999`, 'done');
  } finally {
    server.close();
  }
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr.trim().split('\n').pop());
  assert.equal(err.status, 409);
  assert.equal(posts.length, 1, 'no second POST');
  assert.equal(posts[0].url, `/api/v1/conversations/${sub}/messages`);
});

// ── prefix dispatch: text / [MEDIA:…] / [CARD] question / [CARD] display / [STRUCTURED] ──

const DISPATCH_CONV = '019f7000-0000-7000-8000-0000000000d1';

// A fake cws-core: interaction-requests answer with a message id and action ids,
// messages with an id. Records every POST.
function startDispatchServer() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST') posts.push({ url: req.url, body });
      const out = req.url.endsWith('/interaction-requests')
        ? { message_id: `7300000000000000${String(posts.length).padStart(3, '0')}`, action_ids: (body.choice?.options || []).map((_, i) => `act_${i}`) }
        : { id: `7300000000000001${String(posts.length).padStart(3, '0')}` };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, port: server.address().port }));
  });
}

async function dispatch(endpoint, message) {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  const { server, posts, port } = await startDispatchServer();
  try {
    const r = await runSend(port, endpoint, message);
    return { ...r, posts };
  } finally {
    server.close();
  }
}

test('T9: [STRUCTURED] — one POST built like comm.send: explicit mentions (string → member), metadata, fallback_text, type, reply', async () => {
  const payload = {
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'report', body: { title: '周报', rows: [1, 2] } },
    mentions: [LUNA_ID, { type: 'all' }],
    metadata: { source: 'weekly' },
    fallback_text: '周报：2 行',
  };
  const { code, stderr, stdout, posts } = await dispatch(`${DISPATCH_CONV}|type:group|reply:7300000000000000005|msg:7300000000000000006`, `[STRUCTURED]${JSON.stringify(payload)}`);
  assert.equal(code, 0, stderr);
  assert.equal(posts.length, 1, 'never split');
  assert.equal(posts[0].url, `/api/v1/conversations/${DISPATCH_CONV}/messages`);
  const { body } = posts[0];
  assert.equal(body.type, 'AGENT_STRUCTURED');
  assert.deepEqual(body.content, { content_type: 'report', body: { title: '周报', rows: [1, 2] }, attachments: [] });
  assert.deepEqual(body.mentions, [{ type: 'member', member_id: LUNA_ID }, { type: 'all' }]);
  assert.deepEqual(body.metadata, { source: 'weekly' });
  assert.equal(body.fallback_text, '周报：2 行');
  assert.equal(body.parent_id, '7300000000000000005', '|reply: is the quote');
  assert.match(body.client_msg_id, /^cmsg_/);
  assert.equal(JSON.parse(stdout).structured, true);
});

test('T9: [STRUCTURED] — text plus already-uploaded attachments (shorthand) makes an IMAGE / FILE message', async () => {
  const att = { artifact_id: 'art-1', file_name: 'a.png', content_type: 'image/png', size_bytes: 10 };
  const { code, stderr, posts } = await dispatch(DISPATCH_CONV, `[STRUCTURED]${JSON.stringify({ content: { text: '截图', attachments: [att] } })}`);
  assert.equal(code, 0, stderr);
  assert.equal(posts[0].body.type, 'IMAGE');
  assert.deepEqual(posts[0].body.content, { content_type: 'image', body: { file_name: 'a.png', text: '截图' }, attachments: [att] });
});

test('T9: [STRUCTURED] — malformed payloads exit 1 and send nothing (never downgraded to text)', async () => {
  const bad = [
    '[STRUCTURED]{not json',
    '[STRUCTURED][1,2]',
    `[STRUCTURED]${JSON.stringify({ conversationId: DISPATCH_CONV, content: 'x' })}`,
    `[STRUCTURED]${JSON.stringify({ content: 'x', replyTo: '1' })}`,
    `[STRUCTURED]${JSON.stringify({ content: 'x', bogus: 1 })}`,
    `[STRUCTURED]${JSON.stringify({ text: 'x' })}`,
    `[STRUCTURED]${JSON.stringify({ content: '' })}`,
    `[STRUCTURED]${JSON.stringify({ content: { text: 'x', attachments: [{ artifactId: 'a' }] } })}`,
    `[STRUCTURED]${JSON.stringify({ content: 'x', mentions: '@luna' })}`,
    `[STRUCTURED]${JSON.stringify({ content: 'x', metadata: { context: {} } })}`,
  ];
  for (const message of bad) {
    // eslint-disable-next-line no-await-in-loop
    const { code, posts } = await dispatch(DISPATCH_CONV, message);
    assert.equal(code, 1, message);
    assert.equal(posts.length, 0, `${message}: nothing sent`);
  }
});

test('T9: [CARD] question card — interaction request posted and recorded as pending', async () => {
  const card = { kind: 'confirm', askedOf: 'm-owner', title: '继续吗', text: '要继续吗', options: ['是', '否'] };
  const { code, stderr, stdout, posts } = await dispatch(DISPATCH_CONV, `[CARD]${JSON.stringify(card)}`);
  assert.equal(code, 0, stderr);
  assert.equal(posts[0].url, `/api/v1/conversations/${DISPATCH_CONV}/interaction-requests`);
  const out = JSON.parse(stdout);
  assert.equal(out.recorded, true);
  assert.deepEqual(out.action_ids, ['act_0', 'act_1']);
});

test('T9: [CARD] display card (onboarding.partner: no kind / askedOf, only a behavior button) — posted, nothing recorded', async () => {
  const card = {
    cardKind: 'onboarding.partner', title: '再添加一个 Agent', text: '可以随时添加',
    options: [{ label: '添加 Agent', behavior: 'open_create_agent' }],
  };
  const pendingFile = path.join(tmpHome, 'zylos/components/openmax/runtime/pending-questions.json');
  const readPending = () => (fs.existsSync(pendingFile) ? fs.readFileSync(pendingFile, 'utf8') : '');
  const before = readPending();
  const { code, stderr, stdout, posts } = await dispatch(DISPATCH_CONV, `[CARD]${JSON.stringify(card)}`);
  assert.equal(code, 0, stderr);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.choice.kind, 'onboarding.partner');
  const out = JSON.parse(stdout);
  assert.equal(out.display, true);
  assert.equal(out.recorded, false);
  assert.equal(readPending(), before, 'no pending question for a display card');
});

test('T9: [CARD] with an answering option but no kind / askedOf is still refused (exit 1, nothing sent)', async () => {
  const card = { title: '继续吗', text: 'x', options: ['是', '否'] };
  const { code, stderr, posts } = await dispatch(DISPATCH_CONV, `[CARD]${JSON.stringify(card)}`);
  assert.equal(code, 1);
  assert.match(stderr, /requires `kind` and `askedOf`/);
  assert.equal(posts.length, 0);
});

test('T9: plain text and a typed endpoint — sent to the conversation; |type: changes nothing on the wire', async () => {
  const { code, stderr, posts } = await dispatch(`${DISPATCH_CONV}|type:dm|msg:7300000000000000007`, 'hello');
  assert.equal(code, 0, stderr);
  assert.equal(posts[0].url, `/api/v1/conversations/${DISPATCH_CONV}/messages`);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['client_msg_id', 'content', 'type']);
});

test('T11: a legacy thread endpoint is sent to its leading conversation, no parent_id, with a stderr warning', async () => {
  const thread = '019f7000-0000-7000-8000-0000000000d2';
  for (const endpoint of [`${DISPATCH_CONV}|thread:${thread}|parent:7300000000000000009`, `[OPENMAX THREAD]/${DISPATCH_CONV}|thread:${thread}`]) {
    // eslint-disable-next-line no-await-in-loop
    const { code, stderr, posts } = await dispatch(endpoint, 'still here');
    assert.equal(code, 0, stderr);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/api/v1/conversations/${DISPATCH_CONV}/messages`);
    assert.equal('parent_id' in posts[0].body, false);
    assert.match(stderr, /legacy thread endpoint/);
  }
});
