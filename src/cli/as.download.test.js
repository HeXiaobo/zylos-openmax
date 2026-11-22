import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// as.download / as.url against short-lived platform download links: the
// resolve answer is a single-use link that redirects to the storage object.
// The CLI runs main() on import, so it is exercised via subprocess.

const cli = fileURLToPath(new URL('./as.js', import.meta.url));

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'as-download-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { 'org-1': { enabled: true, org_id: 'org-1', org_name: 'Alpha', self: { member_id: 'm-1' } } },
  }));
  return home;
}

// Fake cws-core: /artifacts/resolve mints a new single-use ticket each call;
// /api/public/artifacts/download/<ticket> redeems it once (302 to the object),
// any later use 404s. `failFirstRedeem` makes the first ticket fail as if it
// had already been used or had expired.
function fakeCore({ failFirstRedeem = false, failAllRedeems = false } = {}) {
  const log = { resolves: 0, redeems: [], objects: 0 };
  const used = new Set();
  let base = '';
  const server = createServer((req, res) => {
    if (req.url.includes('/artifacts/resolve')) {
      log.resolves += 1;
      const ticket = `t${log.resolves}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        resolved: {
          'artifact://a1': {
            download_url: `${base}/api/public/artifacts/download/${ticket}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            name: 'report.txt',
            content_type: 'text/plain',
            content_length: 5,
          },
        },
        failed: [],
      }));
      return;
    }
    const m = req.url.match(/^\/api\/public\/artifacts\/download\/(\w+)$/);
    if (m) {
      log.redeems.push(m[1]);
      if (used.has(m[1]) || failAllRedeems || (failFirstRedeem && m[1] === 't1')) {
        used.add(m[1]);
        res.statusCode = 404;
        res.end();
        return;
      }
      used.add(m[1]);
      res.statusCode = 302;
      res.setHeader('location', `/storage/obj?sig=${m[1]}`);
      res.end();
      return;
    }
    if (req.url.startsWith('/storage/obj')) {
      log.objects += 1;
      res.end('hello');
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  return {
    log,
    server,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}

function run(home, command, params, apiUrl) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: 'org-1',
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('as.download follows the platform link redirect and saves the object locally', async () => {
  const core = fakeCore();
  const base = await core.start();
  try {
    const home = setupHome();
    const r = await run(home, 'as.download', { artifactId: 'a1' }, base);
    assert.equal(r.code, 0, r.stderr);
    const { localPath } = JSON.parse(r.stdout);
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'hello');
    assert.equal(path.basename(localPath), 'report.txt');
    assert.equal(core.log.resolves, 1);
    assert.deepEqual(core.log.redeems, ['t1']);
  } finally {
    await core.stop();
  }
});

test('as.download re-resolves after a failed link and never re-requests it', async () => {
  const core = fakeCore({ failFirstRedeem: true });
  const base = await core.start();
  try {
    const home = setupHome();
    const r = await run(home, 'as.download', { artifactId: 'a1' }, base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(JSON.parse(r.stdout).localPath, 'utf8'), 'hello');
    assert.equal(core.log.resolves, 2);
    assert.deepEqual(core.log.redeems, ['t1', 't2']);
  } finally {
    await core.stop();
  }
});

test('as.download gives up after exactly one re-resolve when every link fails', async () => {
  const core = fakeCore({ failAllRedeems: true });
  const base = await core.start();
  try {
    const home = setupHome();
    const r = await run(home, 'as.download', { artifactId: 'a1' }, base);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /GET 404/);
    assert.equal(core.log.resolves, 2);
    assert.deepEqual(core.log.redeems, ['t1', 't2']);
    assert.equal(core.log.objects, 0);
  } finally {
    await core.stop();
  }
});

test('as.url / as.resolve mark the link as short-lived and not for messages', async () => {
  const core = fakeCore();
  const base = await core.start();
  try {
    const home = setupHome();
    const u = await run(home, 'as.url', { artifactId: 'a1' }, base);
    assert.equal(u.code, 0, u.stderr);
    const out = JSON.parse(u.stdout);
    assert.match(out.url, /\/api\/public\/artifacts\/download\/t1$/);
    assert.equal(out.shortLived, true);
    assert.match(out.notice, /Do not post it in messages/);
    assert.match(out.notice, /as\.download/);
    const b = await run(home, 'as.resolve', { uris: ['artifact://a1'] }, base);
    assert.equal(b.code, 0, b.stderr);
    const bOut = JSON.parse(b.stdout);
    assert.equal(bOut.shortLived, true);
    assert.match(bOut.notice, /Do not post it in messages/);
    assert.match(bOut.resolved['artifact://a1'].download_url, /\/download\/t2$/);
    // Resolving alone never redeems the link.
    assert.deepEqual(core.log.redeems, []);
  } finally {
    await core.stop();
  }
});
