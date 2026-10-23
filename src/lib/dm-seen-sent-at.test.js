// Both send entry points must stamp the dm-seen marker with a time taken
// BEFORE the request (PR #202 R2): the HTTP response can come back after the
// peer has reacted or replied, or after a WebSocket reconnect, and the watch
// compares `sent_at` with exactly those.

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEND_JS = path.join(ROOT, 'scripts/send.js');
const COMM_JS = path.join(ROOT, 'src/cli/comm.js');
const RESPONSE_DELAY_MS = 400;

// Answers the send after a delay and records when the request arrived.
function startSlowServer() {
  const arrivals = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url.endsWith('/messages')) arrivals.push(Date.now());
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'm1' }, id: 'm1' }));
      }, RESPONSE_DELAY_MS);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, arrivals, port: server.address().port }));
  });
}

function run(args, home, port) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: `http://127.0.0.1:${port}`,
        COCO_API_PREFIX: '/api/v1',
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: 'org-test',
        COCO_RPC_LOG: '0',
      },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}

function readMarkers(home) {
  const dir = path.join(home, 'zylos/components/openmax/runtime/dm-sent');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

async function markerAgainstSlowServer(argsFor) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-seen-sent-at-'));
  const { server, arrivals, port } = await startSlowServer();
  try {
    const r = await run(argsFor(), home, port);
    assert.equal(r.code, 0, r.stderr);
    const markers = readMarkers(home);
    assert.equal(markers.length, 1, `one marker expected, got ${markers.length}`);
    assert.equal(arrivals.length, 1);
    return { marker: markers[0], arrivedAt: arrivals[0] };
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('send.js stamps sent_at before the request, not after the (slow) response', async () => {
  const { marker, arrivedAt } = await markerAgainstSlowServer(() => [SEND_JS, 'conv-dm', 'hello']);
  assert.equal(marker.conversation_id, 'conv-dm');
  assert.ok(marker.sent_at <= arrivedAt, `sent_at ${marker.sent_at} is after the server got the request at ${arrivedAt}`);
});

test('comm.send stamps sent_at before the request, not after the (slow) response', async () => {
  const { marker, arrivedAt } = await markerAgainstSlowServer(
    () => [COMM_JS, 'comm.send', JSON.stringify({ conversationId: 'conv-dm', content: 'hello' })],
  );
  assert.equal(marker.conversation_id, 'conv-dm');
  assert.ok(marker.sent_at <= arrivedAt, `sent_at ${marker.sent_at} is after the server got the request at ${arrivedAt}`);
});

// ── merge of PR #202 with #183 (agent activity): one send carries both ──────
import { createRunStore } from './activity/run-store.js';

const RUN_CONV = 'conv-dm-run';

/** POST /messages: `mode(body)` → [status, json]. Records request bodies. */
function startScriptedServer(mode) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (req.method === 'POST' && req.url.endsWith('/messages')) bodies.push(body);
      const [status, json] = req.method === 'POST' && req.url.endsWith('/messages')
        ? mode(body) : [200, { data: {} }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, bodies, port: server.address().port }));
  });
}

function liveRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-seen-run-'));
  const store = createRunStore({ dir });
  store.writeRun({
    v: 1, run_id: 'r_000000d1', org_id: 'org-test', conversation_id: RUN_CONV, reply_conversation_id: RUN_CONV,
    created_at: Date.now() - 5000, state: 'active', events: [], dropped: 0, next_event: 1, seq: 1,
  });
  store.writeActive({ v: 1, by_conversation: { [RUN_CONV]: ['r_000000d1'] }, gate: { 'org-test': 'open' } });
  return { dir, store };
}

async function sendWithRun(argsFor, mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-seen-run-home-'));
  const { dir, store } = liveRunDir();
  const { server, bodies, port } = await startScriptedServer(mode);
  const prev = process.env.OPENMAX_RUNS_DIR;
  process.env.OPENMAX_RUNS_DIR = dir;
  try {
    const r = await run(argsFor(), home, port);
    return { r, bodies, markers: readMarkers(home), claim: store.readClaim('r_000000d1') };
  } finally {
    if (prev === undefined) delete process.env.OPENMAX_RUNS_DIR;
    else process.env.OPENMAX_RUNS_DIR = prev;
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ENTRY_POINTS = [
  ['send.js', () => [SEND_JS, RUN_CONV, 'hello']],
  ['comm.send', () => [COMM_JS, 'comm.send', JSON.stringify({ conversationId: RUN_CONV, content: 'hello' })]],
];

for (const [name, argsFor] of ENTRY_POINTS) {
  test(`${name} with a live run: agent_run attached and claim delivered, and one dm-seen marker for the message`, async () => {
    const { r, bodies, markers, claim } = await sendWithRun(argsFor, () => [200, { data: { id: 'm-ok' }, id: 'm-ok' }]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].agent_run.run_id, 'r_000000d1');
    assert.equal(claim.state, 'delivered');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].message_id, 'm-ok');
  });

  test(`${name} with a live run: a 422 on agent_run — comm.send resends bare (marker for the stored message), send.js fails (no marker); claim released either way`, async () => {
    const { r, bodies, markers, claim } = await sendWithRun(argsFor, (body) => (body.agent_run
      ? [422, { error: { code: 'VALIDATION', message: 'agent_run' } }]
      : [200, { data: { id: 'm-bare' }, id: 'm-bare' }]));
    if (name === 'send.js') {
      // #183 as reviewed: scripts/send.js text replies have no bare resend
      // (only the comm CLI / cards use postWithRunMetadata).
      assert.notEqual(r.code, 0);
      assert.equal(bodies.length, 1);
      assert.equal(claim, null);
      assert.equal(markers.length, 0, 'nothing stored: no marker');
      return;
    }
    assert.equal(r.code, 0, r.stderr);
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].agent_run);
    assert.equal('agent_run' in bodies[1], false);
    assert.equal(bodies[1].client_msg_id, bodies[0].client_msg_id, 'same message id on the bare retry');
    assert.equal(claim, null, 'summary did not reach the server: claim released');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].message_id, 'm-bare');
  });

  test(`${name} with a live run: a rejected send writes no marker and releases the claim`, async () => {
    const { r, markers, claim } = await sendWithRun(argsFor, () => [400, { error: { code: 'BAD_REQUEST', message: 'no' } }]);
    assert.notEqual(r.code, 0);
    assert.equal(markers.length, 0);
    assert.equal(claim, null);
  });
}
