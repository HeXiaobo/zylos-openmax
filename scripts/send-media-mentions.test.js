import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OPENM-1039 through scripts/send.js (the c4-send path):
//  - `[MEDIA:file|image]/path` + `[MENTIONS][…]` on the next line uploads the
//    file and sends ONE message that carries the explicit mentions; the caption
//    is never read for `@name` (2.35.0 explicit-only rule).
//  - a malformed [MENTIONS] line, or a broadcast refused by can_mention_all,
//    fails before the upload: nothing is uploaded, nothing is posted.
//  - a [MEDIA:…] tag that starts a later line fails the send (nothing is
//    uploaded or posted) instead of being posted as literal text.

const SEND_JS = fileURLToPath(new URL('./send.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-send-media-mentions-'));

const CONV = '01a1ecc0-6935-7910-b5e5-598b2ef4cee3';
const CONV_PATH = `/api/v1/conversations/${CONV}`;
const XIAO_B = '01a1ecbc-6239-7c14-8e0a-9976c61a153f';
const XIAO_C = '01a1ecbc-71f0-7d2a-9b3e-5c8d4a2f1e07';
const CAPTION = '@小B请看报价单';

const PDF = path.join(HOME, '报价单-2026Q4.pdf');
fs.writeFileSync(PDF, '%PDF-1.4 quote');
const PNG = path.join(HOME, '方案A.png');
fs.writeFileSync(PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function send(message, {
  conversation = { status: 200, body: { id: CONV, type: 'GROUP', can_mention_all: true } },
  send: sendReply = { status: 200, body: { id: '7300000000000001039' } },
  endpoint = `${CONV}|type:group|msg:7300000000000001038`,
} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      let reply;
      if (req.method === 'GET' && req.url === CONV_PATH) reply = conversation;
      else if (req.url.endsWith('/uploads/prepare')) reply = { status: 200, body: { upload_token: 'tok-1039', instant_upload: true } };
      else if (req.url.endsWith('/uploads/finalize')) reply = { status: 200, body: { media_id: '01a1ecc8-7cbd-794f-9079-f2c452366938', artifact_id: '01a1ecc8-7c13-7471-9760-7eb6938061bf' } };
      else if (req.method === 'POST' && req.url === `${CONV_PATH}/messages`) reply = sendReply;
      else reply = { status: 200, body: { data: [] } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SEND_JS, endpoint, message], {
        env: {
          ...process.env,
          HOME,
          COCO_ORG_ID: 'org-test',
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_AUTH_TOKEN: 'test-token',
          COCO_RPC_LOG: '0',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({
        code,
        stdout,
        stderr,
        failure: code ? JSON.parse(stderr.trim().split('\n').pop()) : null,
      }));
    });
    return {
      ...outcome,
      uploads: requests.filter((r) => r.url.includes('/uploads/')),
      messages: requests.filter((r) => r.method === 'POST' && r.url === `${CONV_PATH}/messages`),
      convGets: requests.filter((r) => r.method === 'GET' && r.url === CONV_PATH),
      all: requests,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('🔴 [MEDIA:file] + [MENTIONS] → one FILE message carrying the mentions; caption sent verbatim', async () => {
  const r = await send(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]\n${CAPTION}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.uploads.length, 2, 'prepare + finalize');
  assert.equal(r.messages.length, 1);
  const { body } = r.messages[0];
  assert.equal(body.type, 'FILE');
  assert.deepEqual(body.mentions, [{ type: 'member', member_id: XIAO_B }]);
  assert.equal(body.content.body.text, CAPTION, 'caption unchanged, [MENTIONS] line not in it');
  assert.equal(body.content.body.file_name, '报价单-2026Q4.pdf');
  assert.equal(body.content.attachments[0].artifact_id, '01a1ecc8-7c13-7471-9760-7eb6938061bf');
  assert.equal(r.convGets.length, 0, 'member-only mentions do not look up the conversation');
});

test('🔴 [MEDIA:image] + [MENTIONS] object + all_agents → IMAGE message, broadcast checked first', async () => {
  const r = await send(`[MEDIA:image]${PNG}\n[MENTIONS][{"type":"member","member_id":"${XIAO_C}"},{"type":"all_agents"}]\n方案 A`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages.length, 1);
  const { body } = r.messages[0];
  assert.equal(body.type, 'IMAGE');
  assert.deepEqual(body.mentions, [{ type: 'member', member_id: XIAO_C }, { type: 'all_agents' }]);
  assert.equal(body.content.body.text, '方案 A');
  assert.equal(r.convGets.length, 1, 'can_mention_all looked up');
  const firstUpload = r.all.findIndex((q) => q.url.includes('/uploads/'));
  const theGet = r.all.findIndex((q) => q.method === 'GET' && q.url === CONV_PATH);
  assert.ok(theGet < firstUpload, 'the broadcast is checked before the upload');
});

test('|reply: endpoint + [MENTIONS] → the FILE message carries both parent_id and mentions', async () => {
  const r = await send(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]\n${CAPTION}`, {
    endpoint: `${CONV}|type:group|reply:7300000000000001037|msg:7300000000000001038`,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages.length, 1);
  const { body } = r.messages[0];
  assert.equal(body.parent_id, '7300000000000001037');
  assert.deepEqual(body.mentions, [{ type: 'member', member_id: XIAO_B }]);
  assert.equal(body.content.body.text, CAPTION);
});

test('CRLF input → the FILE message with the mentions, caption without the [MENTIONS] line', async () => {
  const r = await send(`[MEDIA:file]${PDF}\r\n[MENTIONS]["${XIAO_B}"]\r\n${CAPTION}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].body.type, 'FILE');
  assert.deepEqual(r.messages[0].body.mentions, [{ type: 'member', member_id: XIAO_B }]);
  assert.equal(r.messages[0].body.content.body.text, CAPTION);
});

test('🔴 plain [MEDIA:file] without [MENTIONS] is unchanged: no mentions key, caption @name not parsed', async () => {
  const r = await send(`[MEDIA:file]${PDF}\n${CAPTION}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages.length, 1);
  assert.equal('mentions' in r.messages[0].body, false);
  assert.equal(r.messages[0].body.content.body.text, CAPTION);
});

test('🔴 malformed [MENTIONS] → exit 1, code MEDIA_MENTIONS_INVALID, nothing uploaded or posted', async () => {
  for (const line of [`[MENTIONS]${XIAO_B}`, '[MENTIONS][]', '[MENTIONS][{"type":"member"}]', '[MENTIONS]["@小B"]', '[MENTIONS]["小B"]', `[mentions]["${XIAO_B}"]`, `【MENTIONS】["${XIAO_B}"]`]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await send(`[MEDIA:file]${PDF}\n${line}\n${CAPTION}`);
    assert.equal(r.code, 1, line);
    assert.equal(r.failure.code, 'MEDIA_MENTIONS_INVALID', line);
    assert.equal(r.all.length, 0, `${line}: no request at all`);
  }
});

test('🔴 broadcast refused by can_mention_all → exit 1, mention_all_not_allowed, nothing uploaded or posted', async () => {
  const r = await send(`[MEDIA:file]${PDF}\n[MENTIONS][{"type":"all"}]\n全员请看`, {
    conversation: { status: 200, body: { id: CONV, type: 'GROUP', can_mention_all: false } },
  });
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'mention_all_not_allowed');
  assert.equal(r.failure.status, 403);
  assert.match(r.failure.error, /^\[MEDIA\]/);
  assert.equal(r.uploads.length, 0);
  assert.equal(r.messages.length, 0);
});

test('server 403 "mention all not allowed" on the media POST surfaces as mention_all_not_allowed', async () => {
  const r = await send(`[MEDIA:file]${PDF}\n[MENTIONS][{"type":"all"}]`, {
    send: { status: 403, body: { error: { status: 403, title: 'Forbidden', detail: 'mention all not allowed', code: 'COMM_ERROR' } } },
  });
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'mention_all_not_allowed');
  assert.equal(r.messages.length, 1, 'tried once');
  assert.deepEqual(r.messages[0].body.mentions, [{ type: 'all' }], 'the broadcast was not dropped');
});

test('🔴 [MEDIA:file] on a later line → exit 1, MEDIA_NOT_FIRST, nothing uploaded or posted', async () => {
  const r = await send(`${CAPTION}\n[MEDIA:file]${PDF}`);
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'MEDIA_NOT_FIRST');
  assert.match(r.failure.error, /\[MEDIA:file\]\/abs\/path/);
  assert.equal(r.all.length, 0);
});

test('a [MEDIA:…] example inside a fenced code block is sent as text', async () => {
  const text = `发送文件的写法：\n\`\`\`text\n[MEDIA:file]/abs/path\n[MENTIONS]["<member id>"]\n说明\n\`\`\``;
  const r = await send(text);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.uploads.length, 0);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].body.content.body.text, text);
});

test('a [MEDIA:…] tag after leading blank lines is still the media message', async () => {
  const r = await send(`\n[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages[0].body.type, 'FILE');
  assert.deepEqual(r.messages[0].body.mentions, [{ type: 'member', member_id: XIAO_B }]);
});

test('🔴 plain text with a LATER [MENTIONS] line → exit 1, MENTIONS_WITHOUT_MEDIA, nothing sent', async () => {
  for (const msg of [`${CAPTION}\n[MENTIONS]["${XIAO_B}"]`, `${CAPTION}\r\n  [MENTIONS]["${XIAO_B}"]\r\n尾`]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await send(msg);
    assert.equal(r.code, 1, msg);
    assert.equal(r.failure.code, 'MENTIONS_WITHOUT_MEDIA', msg);
    assert.equal(r.all.length, 0, msg);
  }
});

test('[STRUCTURED] whose content has a [MENTIONS] line is unaffected (checked first)', async () => {
  const content = `说明\n[MENTIONS]["${XIAO_B}"]`;
  const r = await send(`[STRUCTURED]${JSON.stringify({ content, mentions: [XIAO_B] })}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages[0].body.mentions, [{ type: 'member', member_id: XIAO_B }]);
});

test('🔴 "```x```" opens no fence: a later [MEDIA:file] line → MEDIA_NOT_FIRST, nothing sent', async () => {
  const r = await send(`\`\`\`x\`\`\` 是行内代码\n[MEDIA:file]${PDF}`);
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'MEDIA_NOT_FIRST');
  assert.equal(r.all.length, 0);
});

test('🔴 text, then a [MEDIA:file] line, then a [MENTIONS] line → MEDIA_NOT_FIRST (the root error), nothing sent', async () => {
  const r = await send(`说明\n[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]`);
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'MEDIA_NOT_FIRST');
  assert.match(r.failure.error, /\[MEDIA:file\]\/abs\/path/);
  assert.equal(r.all.length, 0);
});

test('🔴 plain text starting with [MENTIONS] (no MEDIA line) → exit 1, MENTIONS_WITHOUT_MEDIA, nothing sent', async () => {
  const r = await send(`[MENTIONS]["${XIAO_B}"]\n${CAPTION}`);
  assert.equal(r.code, 1);
  assert.equal(r.failure.code, 'MENTIONS_WITHOUT_MEDIA');
  assert.match(r.failure.error, /\[STRUCTURED\]/);
  assert.equal(r.all.length, 0);
});
