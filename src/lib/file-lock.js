/**
 * Cross-process lock file (O_EXCL create) with a safe stale-lock takeover.
 * Shared by runtime/pending-questions.json (pending-question.js) and
 * config.json (config.js `updateConfig(fn, {fresh:true})`).
 *
 * The lock file holds `{"pid":…,"token":…,"at":…}` of its holder.
 *
 * Takeover — a lock is stale when:
 *   - its holder pid has exited (process.kill(pid, 0) → ESRCH), or
 *   - it names no readable pid (a crash between create and write, or a lock
 *     left by an older version) and is older than `staleMs`, or
 *   - it is older than `maxHoldMs` whatever the pid says (a reused pid would
 *     otherwise keep a dead holder's lock forever; holders keep it for
 *     milliseconds of file I/O).
 * Judging stale and removing are two steps, so two waiters could both judge
 * the same stale lock and one could then remove the other's FRESH lock (both
 * enter). To prevent that, a lock is broken only while holding the takeover
 * guard `<lock>.break` (O_EXCL too): with the guard held, the lock is re-read
 * and removed only if it is still the very file judged stale (same inode,
 * mtime and token). Then the guard is released and acquisition retried with
 * O_EXCL as usual.
 *
 * Residual risk (documented, accepted): a guard older than `breakStaleMs`
 * (30 s; a guard is held for one stat + read + unlink) is assumed to belong to
 * a crashed breaker and is removed. If a breaker really stalled that long
 * between its re-check and its unlink, a second breaker could run at the same
 * time; the identity re-check still stops it from removing a different file
 * unless the two re-checks and unlinks interleave inside that window.
 *
 * Release removes the lock only if it still carries our token.
 *
 * Acquisition that does not succeed within `waitMs` throws (`onTimeout()`),
 * so a caller never proceeds unlocked: the lock fails CLOSED.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_WAIT_MS = 3_000;
export const LOCK_STALE_MS = 10_000;
export const LOCK_MAX_HOLD_MS = 60_000;
export const LOCK_BREAK_STALE_MS = 30_000;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

function readHolder(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

/** 'dead' | 'alive' | 'unknown' for a holder pid on this host. */
export function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (pid === process.pid) return 'alive';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    if (e.code === 'ESRCH') return 'dead';
    if (e.code === 'EPERM') return 'alive'; // exists, owned by someone else
    return 'unknown';
  }
}

/** Whether an observed lock (stat + holder) is stale; see the module comment. */
export function isStaleLock(st, holder, { now = Date.now(), staleMs = LOCK_STALE_MS, maxHoldMs = LOCK_MAX_HOLD_MS } = {}) {
  const age = now - st.mtimeMs;
  if (age > maxHoldMs) return true;
  const state = pidState(holder?.pid);
  if (state === 'dead') return true;
  if (state === 'unknown') return age > staleMs;
  return false;
}

function createExclusive(file, body) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
}

/**
 * Remove `lock` only if it is still the file observed as stale (`seen` =
 * {ino, mtimeMs, token}), holding the takeover guard. Returns true when the
 * caller should retry acquiring at once.
 */
function breakStaleLock(lock, seen, { breakStaleMs, now }) {
  const guard = `${lock}.break`;
  const token = crypto.randomBytes(12).toString('hex');
  try {
    createExclusive(guard, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Another waiter is breaking it. A guard left by a crashed breaker is
    // cleared after breakStaleMs (residual risk: see the module comment).
    const gst = statOrNull(guard);
    if (gst && now() - gst.mtimeMs > breakStaleMs) {
      const gh = readHolder(guard);
      const again = statOrNull(guard);
      if (again && again.ino === gst.ino && again.mtimeMs === gst.mtimeMs && readHolder(guard)?.token === gh?.token) {
        try { fs.unlinkSync(guard); } catch {}
      }
    }
    return false;
  }
  try {
    const st = statOrNull(lock);
    if (!st) return true; // already gone
    const holder = readHolder(lock);
    if (st.ino === seen.ino && st.mtimeMs === seen.mtimeMs && (holder?.token ?? null) === seen.token) {
      fs.unlinkSync(lock);
    }
    return true;
  } finally {
    if (readHolder(guard)?.token === token) {
      try { fs.unlinkSync(guard); } catch {}
    }
  }
}

/**
 * Run `fn` holding `lockPath`. Throws `onTimeout()` (default: an Error) when
 * the lock cannot be taken within `waitMs`.
 */
export function withFileLock(lockPath, fn, {
  waitMs = LOCK_WAIT_MS,
  staleMs = LOCK_STALE_MS,
  maxHoldMs = LOCK_MAX_HOLD_MS,
  breakStaleMs = LOCK_BREAK_STALE_MS,
  onTimeout = () => new Error(`${lockPath} is held by another process`),
  now = () => Date.now(),
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      createExclusive(lockPath, body);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const st = statOrNull(lockPath);
    if (st) {
      const holder = readHolder(lockPath);
      if (isStaleLock(st, holder, { now: now(), staleMs, maxHoldMs })
          && breakStaleLock(lockPath, { ino: st.ino, mtimeMs: st.mtimeMs, token: holder?.token ?? null }, { breakStaleMs, now })) {
        continue;
      }
    } else {
      continue; // released between our create and stat
    }
    if (now() > deadline) throw onTimeout();
    sleep(10 + Math.floor(Math.random() * 15));
  }
  try {
    return fn();
  } finally {
    if (readHolder(lockPath)?.token === token) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}
