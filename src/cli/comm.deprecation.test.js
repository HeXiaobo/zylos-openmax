import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// T10: comm.send / send_card / ask / ask_card still send in 2.35.x but print
// one deprecation line on stderr (every send goes through c4-send now); the
// other comm.* commands print nothing. comm.create_dm / create_group store the
// new conversation's type, so the first send into it needs no lookup.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));
const sessionGroupPath = fileURLToPath(new URL('../../scripts/session-group.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-deprecation-home-'));
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-deprecation-runs-'));

const CONV = '019f0000-aaaa-7bbb-8ccc-000000000301';
const NEW_DM = '019f0000-aaaa-7bbb-8ccc-000000000302';
const NEW_GROUP = '019f0000-aaaa-7bbb-8ccc-000000000303';

async function run(verb, params) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      let out = { id: '7300000000000000001' };
      if (req.url.endsWith('/interaction-requests')) {
        out = { message_id: '7300000000000000002', action_ids: (body?.choice?.options || []).map((_, i) => `a${i}`) };
      } else if (req.url.endsWith('/conversations/dm')) {
        // cws-core findOrCreateDMResult (in the D8 envelope below)
        out = { conversation: { id: NEW_DM, type: 'DM', name: 'peer' }, created: true };
      } else if (req.url.endsWith('/conversations/groups')) {
        // cws-core createGroupResult: no type in the answer
        out = { id: NEW_GROUP, created_at: '2026-11-16T00:00:00Z', member_count: 2 };
      } else if (req.method === 'GET') {
        out = { id: CONV, type: 'DM' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: out, request_id: 'req-1' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, verb, JSON.stringify(params)], {
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
      }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
    });
    return { requests, posts: requests.filter((r) => r.method === 'POST'), ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const CHOICE = { title: '继续吗', text: '要继续吗', options: ['是', '否'] };

test('T10: the four send verbs still send, with exactly one deprecation line on stderr', async () => {
  const cases = [
    ['comm.send', { conversationId: CONV, content: 'hi' }, /\[STRUCTURED\]/],
    ['comm.send_card', { conversationId: CONV, ...CHOICE }, /display card \[CARD\]/],
    ['comm.ask', { conversationId: CONV, ...CHOICE, kind: 'k', askedOf: 'm-1' }, /\[CARD\]/],
    ['comm.ask_card', { conversationId: CONV, ...CHOICE, kind: 'k', askedOf: 'm-1' }, /\[CARD\]/],
  ];
  for (const [verb, params, replacement] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(verb, params);
    assert.equal(r.ok, true, `${verb}: ${r.stderr}`);
    assert.ok(r.posts.length >= 1, `${verb} sent`);
    const lines = r.stderr.split('\n').filter((l) => l.includes('DEPRECATED'));
    assert.equal(lines.length, 1, `${verb}: ${r.stderr}`);
    assert.match(lines[0], new RegExp(`${verb.replace('.', '\\.')} is deprecated and will stop working in openmax 2\\.36\\.0`));
    assert.match(lines[0], replacement);
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout stays the JSON result');
  }
});

test('T10: other comm.* commands print no deprecation warning', async () => {
  for (const [verb, params] of [['comm.get_conversation', { conversationId: CONV }], ['comm.create_dm', { peerMemberId: 'm-peer' }]]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(verb, params);
    assert.equal(r.ok, true, r.stderr);
    assert.doesNotMatch(r.stderr, /DEPRECATED/);
  }
});

// The session-group query Core runs before the first send, with an
// unroutable API: it answers only from the stored type, never a lookup.
function sessionGroupOffline(conversationId) {
  return new Promise((resolve) => {
    execFile(process.execPath, [sessionGroupPath, conversationId], {
      env: { ...process.env, HOME, COCO_ORG_ID: '', COCO_API_URL: 'http://127.0.0.1:9', COCO_RPC_LOG: '0' },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
  });
}

function storedMap() {
  return JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/components/openmax/runtime/conv-org-map.json'), 'utf8'));
}

test('comm.create_dm stores the new conversation\'s org and type; the first send needs no type lookup', async () => {
  const r = await run('comm.create_dm', { peerMemberId: 'm-peer' });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(JSON.parse(r.stdout).conversation.id, NEW_DM, 'the response is returned unchanged');
  const map = storedMap();
  assert.equal(map[NEW_DM].orgId, 'org-test');
  assert.equal(map[NEW_DM].type, 'DM');

  const q = await sessionGroupOffline(NEW_DM);
  assert.equal(q.ok, true, q.stderr);
  assert.equal(q.stdout, `dm-${NEW_DM}\n`);
});

test('comm.create_group stores the new conversation\'s org and type GROUP; the first send needs no type lookup', async () => {
  const r = await run('comm.create_group', { name: 'g', memberIds: ['m-1', 'm-2'] });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, NEW_GROUP, 'the response is returned unchanged');
  const map = storedMap();
  assert.equal(map[NEW_GROUP].orgId, 'org-test');
  assert.equal(map[NEW_GROUP].type, 'GROUP');

  const q = await sessionGroupOffline(NEW_GROUP);
  assert.equal(q.ok, true, q.stderr);
  assert.equal(q.stdout, `group-${NEW_GROUP}\n`);
});
