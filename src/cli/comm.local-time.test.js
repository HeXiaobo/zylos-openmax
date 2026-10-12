import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// Shaped like cws-core's messageItem: times are UTC RFC3339 with a `Z`.
const MESSAGE = { id: 'm1', seq: 7, created_at: '2026-07-16T03:36:00.123Z' };

// The message verbs route by org, so they need a config with one enabled org;
// a temp HOME keeps the real agent config out of it.
function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-localtime-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/tokens'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    agent: { api_key: 'cwsk_test' },
    orgs: { o1: { org_id: 'o1', enabled: true, self: { member_id: 'self-o1' } } },
  }));
  return home;
}

async function run(command, params, body, env = {}) {
  const home = setupHome();
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/auth/agent/token')) {
        res.end(JSON.stringify({
          access_token: 'tok', access_token_expires_at: 9999999999000,
          refresh_token: 'r', refresh_token_expires_at: 9999999999000,
        }));
        return;
      }
      res.end(JSON.stringify({ ...body, request_id: 'test-request' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
        env: {
          ...process.env, HOME: home, COCO_API_URL: `http://127.0.0.1:${port}`, COCO_API_PREFIX: '/api/v1',
          COCO_ORG_ID: '', COCO_RPC_LOG: '0',
          ...env,
        },
      }, (error, stdout, stderr) => {
        if (error) { reject(new Error(stderr || stdout)); return; }
        // The token exchange logs `[token] …` lines to stdout ahead of the result.
        try { resolve(JSON.parse(stdout.slice(stdout.search(/^\{/m)))); } catch (err) { reject(err); }
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('get_messages adds created_at_local in the agent TZ, keeps the raw UTC value and pagination', async () => {
  const out = await run(
    'comm.get_messages', { conversationId: 'cv1' },
    { data: [MESSAGE], pagination: { has_more: true } },
    { TZ: 'Asia/Shanghai' },
  );
  assert.deepEqual(out, {
    data: [{ ...MESSAGE, created_at_local: '2026-07-16 11:36:00 (+08:00)' }],
    pagination: { has_more: true },
  });
});

test('get_message annotates the single message', async () => {
  const msg = await run(
    'comm.get_message', { conversationId: 'cv1', messageId: 'm1' },
    { data: MESSAGE },
    { TZ: 'Asia/Shanghai' },
  );
  assert.deepEqual(msg, { ...MESSAGE, created_at_local: '2026-07-16 11:36:00 (+08:00)' });
});
