/**
 * wsb#679 on the proactive path: comm.ask_card / comm.ask with a quick-reply
 * card, run as the CLI runs. A second quick-reply card to the same person in
 * the same conversation within 10 minutes is sent and carries a `warning`.
 * HOME is a temp dir holding a one-org config, so the pending-question file
 * is the test's own.
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-repeat-'));
  const dir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ orgs: { acme: { org_id: 'org-1', enabled: true } } }));
  test.after?.(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  return home;
}

let seq = 0;

async function run(home, command, params, response) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      seq += 1;
      const body = req.url.startsWith('/api/v1/onboarding/') ? { data: {} } : response(seq);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
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
        resolve({ code: error ? error.code : 0, out: start >= 0 ? JSON.parse(stdout.slice(start)) : null, err: stderr });
      });
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const choiceRes = (n) => ({ data: { message_id: `c${n}`, action_ids: ['opt_1', 'opt_2'] } });
const formRes = (n) => ({ data: { message_id: `f${n}`, action_ids: [], form_option_ids: { a: ['opt_1', 'opt_2'] } } });
const ask = (askedOf, title) => ({ conversationId: 'grp-1', kind: 'q', askedOf, title, summary: 's', text: 'x', options: ['是', '否'] });

test('comm.ask_card: the second quick-reply card to the same person carries a warning, and is still sent', async () => {
  const home = tmpHome();
  const first = await run(home, 'comm.ask_card', ask('m-steph', '问题一'), choiceRes);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out.warning, undefined, 'a single card does not warn');
  const second = await run(home, 'comm.ask_card', ask('m-steph', '问题二'), choiceRes);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.out.recorded, true, 'warned, not refused');
  assert.match(second.out.warning, /ONE choice form/);
});

test('comm.ask (choice): same rule; a different person gets no warning', async () => {
  const home = tmpHome();
  await run(home, 'comm.ask', { ...ask('m-steph', '问题一'), interactionType: 'choice' }, choiceRes);
  const other = await run(home, 'comm.ask', { ...ask('m-kevin', '问题二'), interactionType: 'choice' }, choiceRes);
  assert.equal(other.code, 0, other.err);
  assert.equal(other.out.warning, undefined, 'different person');
  const again = await run(home, 'comm.ask', { ...ask('m-steph', '问题三'), interactionType: 'choice' }, choiceRes);
  assert.match(again.out.warning, /ONE choice form/);
});

test('comm.ask (form) after a quick-reply card to the same person carries no warning', async () => {
  const home = tmpHome();
  await run(home, 'comm.ask_card', ask('m-steph', '问题一'), choiceRes);
  const f = await run(home, 'comm.ask', {
    conversationId: 'grp-1', kind: 'q', askedOf: 'm-steph', answerers: ['m-steph'], title: 't', summary: 's',
    fields: [{ key: 'a', label: '问题？', options: ['甲', '乙'] }],
  }, formRes);
  assert.equal(f.code, 0, f.err);
  assert.equal(f.out.warning, undefined);
});
