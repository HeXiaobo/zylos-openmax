/**
 * comm.ask (form) run as the CLI runs: in a DM the `answerers` are dropped
 * before the send and the output carries a `note`; in a group they are sent.
 * The conversation type comes from the same GET /conversations/{id} the
 * group-without-answerers warning reads.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-dm-answerers-'));
  const dir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ orgs: { acme: { org_id: 'org-1', enabled: true } } }));
  test.after?.(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  return home;
}

async function run(home, params, convType) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      let body;
      if (req.method === 'GET' && /\/conversations\/[^/]+$/.test(req.url)) body = { data: { id: 'c', type: convType } };
      else body = { data: { message_id: 'f1', action_ids: [], form_option_ids: { a: ['opt_1', 'opt_2'] } } };
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, 'comm.ask', JSON.stringify(params)], {
        env: {
          ...process.env,
          HOME: home,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_RPC_LOG: '0',
        },
      }, (error, stdout, stderr) => {
        const start = stdout.search(/^[[{]/m);
        resolve({ code: error ? error.code : 0, out: start >= 0 ? JSON.parse(stdout.slice(start)) : null, err: stderr, requests });
      });
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const FORM = {
  conversationId: 'conv-1', interactionType: 'form', kind: 'q', title: 't', summary: 's',
  fields: [{ key: 'a', label: '问题？', options: ['甲', '乙'] }],
};
const pending = (home) => JSON.parse(fs.readFileSync(path.join(home, 'zylos/components/openmax/runtime/pending-questions.json'), 'utf8'));

test('comm.ask in a DM with answerers: sent without them, note in the output, askedOf kept', async () => {
  const home = tmpHome();
  const r = await run(home, { ...FORM, answerers: ['m-ann'] }, 'dm');
  assert.equal(r.code, 0, r.err);
  const post = r.requests.find((q) => q.method === 'POST');
  assert.equal(post.body.form.answerers, undefined);
  assert.match(r.out.note, /answerers dropped/);
  assert.deepEqual(pending(home)[0].askedOf, ['m-ann']);
});

test('comm.ask in a group with answerers: sent with them, no note', async () => {
  const home = tmpHome();
  const r = await run(home, { ...FORM, answerers: ['m-ann'] }, 'group');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.requests.find((q) => q.method === 'POST').body.form.answerers, ['m-ann']);
  assert.equal(r.out.note, undefined);
});

test('comm.ask in a DM without answerers: unchanged', async () => {
  const home = tmpHome();
  const r = await run(home, { ...FORM, askedOf: 'm-ann' }, 'dm');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.requests.find((q) => q.method === 'POST').body.form.answerers, undefined);
  assert.equal(r.out.note, undefined);
  assert.equal(r.out.warning, undefined, 'a DM is not a group');
});
