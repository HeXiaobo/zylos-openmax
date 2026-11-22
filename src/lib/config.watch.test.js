import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OPENM-1037: watchConfig must keep firing after atomic (tmp + rename) saves.
// CONFIG_PATH is derived from HOME at module load, so point HOME at a temp dir
// before importing config.js (node --test runs each file in its own process).

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-watch-'));
const compDir = path.join(home, 'zylos/components/openmax');
const configPath = path.join(compDir, 'config.json');
fs.mkdirSync(compDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {} }));
process.env.HOME = home;

const { watchConfig, updateConfig } = await import('./config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until `calls` has grown past `n` (or time out).
async function waitForCalls(calls, n, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (calls.length <= n && Date.now() < end) await sleep(20);
  return calls.length > n;
}

let calls;
let stop;
before(() => {
  calls = [];
  stop = watchConfig((cfg) => calls.push(cfg));
});
after(() => {
  stop?.();
  fs.rmSync(home, { recursive: true, force: true });
});

test('fires after each of two consecutive updateConfig (rename) saves', async () => {
  const n0 = calls.length;
  updateConfig((c) => { c.marker = 'first'; });
  assert.ok(await waitForCalls(calls, n0), 'callback after first save');
  assert.equal(calls.at(-1).marker, 'first');

  await sleep(200); // let the debounce window close
  const n1 = calls.length;
  updateConfig((c) => { c.marker = 'second'; });
  assert.ok(await waitForCalls(calls, n1), 'callback after second save (inode replaced by first)');
  assert.equal(calls.at(-1).marker, 'second');
});

test('a tmp-file write alone does not trigger the callback', async () => {
  await sleep(200);
  const n = calls.length;
  fs.writeFileSync(`${configPath}.tmp.${process.pid}.${Date.now()}`, '{}');
  await sleep(400);
  assert.equal(calls.length, n);
});

test('an unrelated file in the directory does not trigger the callback', async () => {
  await sleep(200);
  const n = calls.length;
  fs.writeFileSync(path.join(compDir, 'other.json'), '{}');
  await sleep(400);
  assert.equal(calls.length, n);
});

test('an external editor-style save (write elsewhere + rename over) triggers', async () => {
  await sleep(200);
  const n = calls.length;
  const swap = path.join(compDir, '.config.json.swp');
  fs.writeFileSync(swap, JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {}, marker: 'editor' }));
  fs.renameSync(swap, configPath);
  assert.ok(await waitForCalls(calls, n), 'callback after editor rename');
  assert.equal(calls.at(-1).marker, 'editor');

  // ...and an in-place write after that still triggers.
  await sleep(200);
  const n2 = calls.length;
  fs.writeFileSync(configPath, JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {}, marker: 'inplace' }));
  assert.ok(await waitForCalls(calls, n2), 'callback after in-place write');
  assert.equal(calls.at(-1).marker, 'inplace');
});

test('stop function closes the watcher', async () => {
  stop();
  stop = null;
  await sleep(200);
  const n = calls.length;
  updateConfig((c) => { c.marker = 'after-stop'; });
  await sleep(400);
  assert.equal(calls.length, n);
});
