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

// ---------------------------------------------------------------- bounded, org-scoped lookup

/**
 * Two enabled orgs and a token endpoint that mints `tok-<org_id>`, so the
 * bearer on each request shows which org's JWT it carried. The conversation
 * GET answers `convType`, or never answers when `hangGet` is set.
 */
function twoOrgHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-dm-answerers-org-'));
  const dir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(dir, 'runtime/tokens'), { recursive: true });
  const orgs = {};
  for (const id of ['org-alpha', 'org-beta']) orgs[id] = { org_id: id, slug: id.slice(4), enabled: true, self: { member_id: `self-${id}` } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs }));
  test.after?.(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  return home;
}

async function runOrg(home, params, { convType = 'dm', hangGet = false } = {}) {
  const requests = [];
  const held = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url.includes('/auth/agent/token')) {
        let orgId = '';
        try { orgId = JSON.parse(raw || '{}').org_id || ''; } catch { /* identity */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `tok-${orgId || 'identity'}`, access_token_expires_at: 9999999999000,
          refresh_token: `r-${orgId || 'identity'}`, refresh_token_expires_at: 9999999999000,
        }));
        return;
      }
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: raw ? JSON.parse(raw) : undefined, at: Date.now() });
      if (req.method === 'GET' && /\/conversations\/[^/]+$/.test(req.url)) {
        if (hangGet) { held.push(res); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'c', type: convType } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { message_id: 'f1', action_ids: [], form_option_ids: { a: ['opt_1', 'opt_2'] } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const t0 = Date.now();
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, 'comm.ask', JSON.stringify(params)], {
        env: {
          ...process.env,
          HOME: home,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '', COCO_ORG_ID: '',
          COCO_RPC_LOG: '0',
        },
        timeout: 20000,
      }, (error, stdout, stderr) => {
        // The result is the last JSON object on stdout; token log lines ("[token] ...") may precede it.
        const start = [...stdout.matchAll(/^\{/gm)].pop()?.index;
        let out = null;
        try { out = start === undefined ? null : JSON.parse(stdout.slice(start)); } catch { /* reported via code/err */ }
        resolve({ code: error ? (error.code ?? 1) : 0, out, err: stderr + stdout, requests, t0 });
      });
    });
  } finally {
    for (const res of held) res.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('comm.ask with org "beta": the conversation lookup and the POST both carry beta\'s token', async () => {
  const r = await runOrg(twoOrgHome(), { ...FORM, org: 'org-beta', answerers: ['m-ann'] }, { convType: 'dm' });
  assert.equal(r.code, 0, r.err);
  const get = r.requests.find((q) => q.method === 'GET' && /\/conversations\/conv-1$/.test(q.url));
  const post = r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/interaction-requests'));
  assert.ok(get, 'the lookup was made');
  assert.equal(get.auth, 'Bearer tok-org-beta', 'lookup must use the selected org');
  assert.equal(post.auth, 'Bearer tok-org-beta');
  assert.equal(post.body.form.answerers, undefined, 'a DM confirmed in beta drops answerers');
  assert.match(r.out.note, /answerers dropped/);
});

test('comm.ask with a conversation GET that never answers: the card is sent after the 2 s deadline, with its answerers', { timeout: 30000 }, async () => {
  const r = await runOrg(twoOrgHome(), { ...FORM, org: 'org-beta', answerers: ['m-ann'] }, { hangGet: true });
  assert.equal(r.code, 0, r.err);
  const get = r.requests.find((q) => q.method === 'GET' && /\/conversations\/conv-1$/.test(q.url));
  const post = r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/interaction-requests'));
  assert.ok(post, 'the POST must go out');
  assert.deepEqual(post.body.form.answerers, ['m-ann']);
  assert.equal(r.out.note, undefined);
  assert.ok(get, 'the lookup was made');
  // The 2 s deadline starts inside the CLI, before the token exchange and the
  // GET, so measure from the CLI's launch: at least the deadline, well under
  // the 20 s the run is allowed.
  const waited = post.at - r.t0;
  assert.ok(waited >= 2000 && waited < 10000, `POST ${waited} ms after the CLI started`);
});
