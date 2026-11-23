import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// as.upload content_type (wsb#796): a [MEDIA:file] upload of an office / zip /
// csv file must send its real MIME to uploads/prepare, not
// application/octet-stream; an explicit contentType still wins. The CLI runs
// main() when invoked directly, so it is exercised via subprocess (same
// approach as as.download.test.js).

const cli = fileURLToPath(new URL('./as.js', import.meta.url));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'as-upload-'));
  homes.push(home);
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { 'org-1': { enabled: true, org_id: 'org-1', org_name: 'Alpha', self: { member_id: 'm-1' } } },
  }));
  return home;
}

// Fake cws-core: records each prepare body and answers instant_upload so no
// PUT is needed; finalize returns a media/artifact id.
function fakeCore() {
  const log = { prepares: [], finalizes: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/uploads/prepare')) {
        log.prepares.push({ url: req.url, body: JSON.parse(body) });
        res.end(JSON.stringify({ upload_token: 'tok-1', instant_upload: true }));
        return;
      }
      if (req.url.endsWith('/uploads/finalize')) {
        log.finalizes += 1;
        res.end(JSON.stringify({ media_id: 'med-1', artifact_id: 'art-1' }));
        return;
      }
      res.statusCode = 500;
      res.end('{}');
    });
  });
  return {
    log,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
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

function writeFile(home, name) {
  const p = path.join(home, name);
  fs.writeFileSync(p, 'PK\x03\x04fake');
  return p;
}

test('as.upload of a .xlsx [MEDIA:file] sends the spreadsheet MIME to prepare, not octet-stream', async () => {
  const core = fakeCore();
  const base = await core.start();
  try {
    const home = setupHome();
    const filePath = writeFile(home, 'Q3 Report.XLSX');
    const r = await run(home, 'as.upload', { filePath, conversationId: 'conv-1', mediaType: 'file' }, base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(core.log.prepares.length, 1);
    assert.match(core.log.prepares[0].url, /\/conversations\/conv-1\/uploads\/prepare$/);
    assert.equal(core.log.prepares[0].body.content_type, XLSX);
    assert.equal(core.log.prepares[0].body.filename, 'Q3 Report.XLSX');
    assert.equal(JSON.parse(r.stdout).mimeType, XLSX);
  } finally {
    await core.stop();
  }
});

test('as.upload: an explicit contentType still wins over the extension', async () => {
  const core = fakeCore();
  const base = await core.start();
  try {
    const home = setupHome();
    const filePath = writeFile(home, 'report.xlsx');
    const r = await run(home, 'as.upload', { filePath, conversationId: 'conv-1', contentType: 'application/x-custom' }, base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(core.log.prepares[0].body.content_type, 'application/x-custom');
  } finally {
    await core.stop();
  }
});

test('as.upload: an unknown extension still falls back to application/octet-stream', async () => {
  const core = fakeCore();
  const base = await core.start();
  try {
    const home = setupHome();
    const r = await run(home, 'as.upload', { filePath: writeFile(home, 'blob.unknownext'), conversationId: 'conv-1' }, base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(core.log.prepares[0].body.content_type, 'application/octet-stream');
  } finally {
    await core.stop();
  }
});
