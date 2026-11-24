import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withFileLock, isStaleLock, pidState, LOCK_MAX_HOLD_MS } from './file-lock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const age = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };

test('pidState / isStaleLock: dead pid stale at once; live pid only past the max hold; no pid past staleMs', () => {
  const dead = deadPid();
  assert.equal(pidState(dead), 'dead');
  assert.equal(pidState(process.pid), 'alive');
  assert.equal(pidState(undefined), 'unknown');
  const now = Date.now();
  const st = (ago) => ({ mtimeMs: now - ago });
  assert.equal(isStaleLock(st(0), { pid: dead }, { now }), true);
  assert.equal(isStaleLock(st(20_000), { pid: process.pid }, { now }), false);
  assert.equal(isStaleLock(st(LOCK_MAX_HOLD_MS + 1), { pid: process.pid }, { now }), true);
  assert.equal(isStaleLock(st(5_000), null, { now }), false);
  assert.equal(isStaleLock(st(11_000), null, { now }), true);
});

test('withFileLock: holder pid + token written; released only while it is still ours; timeout fails closed', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'x.lock');
  let seen;
  assert.equal(withFileLock(lock, () => { seen = JSON.parse(fs.readFileSync(lock, 'utf8')); return 7; }), 7);
  assert.equal(seen.pid, process.pid);
  assert.match(seen.token, /^[0-9a-f]{32}$/);
  assert.equal(fs.existsSync(lock), false);
  // Someone else's lock replaced ours meanwhile: release leaves it alone.
  withFileLock(lock, () => { fs.unlinkSync(lock); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' })); });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'other');
  // A live holder (this pid), fresh: never taken over → timeout error, fn not run.
  let ran = false;
  assert.throws(() => withFileLock(lock, () => { ran = true; }, { waitMs: 150, onTimeout: () => new Error('held') }), /held/);
  assert.equal(ran, false);
  // A dead holder's lock is taken over at once, even when fresh.
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 't' }));
  assert.equal(withFileLock(lock, () => 'ok', { waitMs: 150 }), 'ok');
  // A legacy empty lock: taken over only once older than staleMs.
  fs.writeFileSync(lock, '');
  assert.throws(() => withFileLock(lock, () => {}, { waitMs: 100, onTimeout: () => new Error('held') }), /held/);
  age(lock, 11_000);
  assert.equal(withFileLock(lock, () => 'ok', { waitMs: 150 }), 'ok');
  // A takeover guard left by a crashed breaker blocks breaking until it is old.
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 't' }));
  fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: deadPid(), token: 'g' }));
  assert.throws(() => withFileLock(lock, () => {}, { waitMs: 100, onTimeout: () => new Error('held') }), /held/);
  age(`${lock}.break`, 31_000);
  assert.equal(withFileLock(lock, () => 'ok', { waitMs: 300 }), 'ok');
  assert.equal(fs.existsSync(`${lock}.break`), false);
});

test('stress: 8 processes race on a lock that is ALREADY stale when they start — single use never violated', async () => {
  const dir = tmpDir();
  const ROUNDS = 24;
  const PROCS = 8;
  const STEP = 120;
  const dead = deadPid();
  for (let r = 0; r < ROUNDS; r += 1) {
    const file = path.join(dir, `round-${r}.json`);
    fs.writeFileSync(file, JSON.stringify({ used: false }));
    const lock = `${file}.lock`;
    // Three kinds of pre-planted stale lock: dead holder pid (fresh mtime),
    // legacy empty file (old), and a "live" pid held past the max hold.
    if (r % 3 === 0) fs.writeFileSync(lock, JSON.stringify({ pid: dead, token: `stale-${r}` }));
    else if (r % 3 === 1) { fs.writeFileSync(lock, ''); age(lock, 15_000); } else {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: `old-${r}` }));
      age(lock, LOCK_MAX_HOLD_MS + 5_000);
    }
  }
  const t0 = Date.now() + 1_500; // after every child has loaded
  const worker = path.join(here, '..', '..', 'test', 'fixtures', 'file-lock.stress-worker.js');
  const results = await Promise.all(Array.from({ length: PROCS }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, dir, String(ROUNDS), String(t0), String(STEP)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim()));
    });
  })));
  const wins = new Map();
  for (const res of results) {
    assert.deepEqual(res.errors, []);
    assert.equal(res.overlap, 0, 'two processes were inside the lock at once');
    for (const r of res.won) wins.set(r, (wins.get(r) || 0) + 1);
  }
  for (let r = 0; r < ROUNDS; r += 1) assert.equal(wins.get(r), 1, `round ${r} consumed ${wins.get(r) || 0} times`);
  for (let r = 0; r < ROUNDS; r += 1) {
    assert.equal(fs.existsSync(path.join(dir, `round-${r}.json.lock`)), false);
    assert.equal(fs.existsSync(path.join(dir, `round-${r}.json.lock.break`)), false);
  }
});
