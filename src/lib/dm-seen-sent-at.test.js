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
