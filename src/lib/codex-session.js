/**
 * Codex-runtime session evidence for the readiness gate.
 *
 * WHY: the gate (agent-readiness.js) requires proof that a session started in
 * THIS runtime launch. On Claude that proof is `activity-monitor/
 * foreground-session.json`, written by zylos-core's SessionStart hook
 * (session-foreground.js). That hook only writes for a managed *Claude*
 * process: on the Codex runtime the same `fg` shard runs but rejects the
 * caller, so the file is never written (or keeps a stale Claude record from a
 * previous launch). The gate then reads `no_session` /
 * `session_predates_launch` forever, the online report is held, and the agent
 * is never `ready`.
 *
 * WHAT WE READ INSTEAD: Codex records every thread as a rollout file,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`.
 * Its first line is `session_meta`, written when the thread is created, with
 * the thread id, creation `timestamp`, `cwd` and `source`. A foreground thread
 * of the managed runtime is one with `source` "cli" (or "vscode") and `cwd` =
 * the zylos dir; subagent threads carry `source: {subagent: …}` and
 * `codex exec` runs carry "exec", and both are ignored. This is the same filter
 * the activity collector applies to Codex's thread table (collector.js).
 *
 * We scan files rather than querying `state_5.sqlite` because this runs on the
 * readiness poll (every 2s): spawning `sqlite3` that often is not cheap, the
 * CLI may be missing, and a directory listing plus one cached first-line read
 * per new file is enough. Nothing under `$CODEX_HOME` is ever written.
 *
 * COST: day directories older than the launch (minus a timezone slack) are not
 * listed; files whose name time is older than that are not opened; each
 * file's `session_meta` is parsed once and cached; full scans are throttled to
 * one per `minScanIntervalMs`.
 */

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rollout directory and file names use the host's LOCAL time, while launch
// times are epoch ms. One day of slack covers every UTC offset (−12h…+14h), so a
// rollout created after `since` is never skipped by the name filters.
const NAME_SLACK_MS = DAY_MS;

// The session_meta line embeds the base instructions (~22 KB on Codex 0.166).
// A first line longer than this is not a rollout we understand.
const MAX_META_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const ROLLOUT_NAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-.+\.jsonl$/;
const FOREGROUND_SOURCES = new Set(['cli', 'vscode']);

/**
 * The active zylos runtime, as zylos-core reads it (`~/zylos/.zylos/config.json`
 * `runtime`). `null` when unknown — callers treat that as "not Codex" and keep
 * the original behavior.
 */
export function readZylosRuntime(zylosDir, { fsImpl = fs, defaultRuntime = null } = {}) {
  try {
    const cfg = JSON.parse(fsImpl.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    return typeof cfg.runtime === 'string' ? cfg.runtime : cfg.runtime === undefined ? defaultRuntime : null;
  } catch (error) {
    return error?.code === 'ENOENT' ? defaultRuntime : null;
  }
}

/** Epoch ms of the name's local time read as UTC (exact up to the UTC offset). */
function nameTimeMs(name) {
  const m = ROLLOUT_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** YYYYMMDD of an epoch ms in UTC, for comparing against directory dates. */
function dayKey(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Read the first line of a file.
 * @returns {{line: string}|{incomplete: true}|{unusable: true}}
 */
function readFirstLine(fsImpl, file) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const chunks = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(READ_CHUNK_BYTES);
      const n = fsImpl.readSync(fd, buf, 0, READ_CHUNK_BYTES, total);
      if (n <= 0) return { incomplete: true }; // still being written
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        return { line: Buffer.concat(chunks).toString('utf8') };
      }
      chunks.push(buf.subarray(0, n));
      total += n;
      if (total >= MAX_META_BYTES) return { unusable: true };
    }
  } catch {
    return { incomplete: true }; // unreadable now; retry on a later scan
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.codexHome                 $CODEX_HOME (default ~/.codex)
 * @param {string} opts.zylosDir                  the managed runtime's cwd
 * @param {object} [opts.fsImpl]                  fs subset: readdirSync, openSync, readSync, closeSync, realpathSync
 * @param {() => number} [opts.now]
 * @param {number} [opts.minScanIntervalMs]       throttle between full scans
 * @param {number} [opts.lookbackMs]              window when the launch time is unknown
 * @returns {({launchAt}: {launchAt: number}) => ({session_id: string|null, started_at: number, rollout: string}|null)}
 *   the newest foreground Codex thread created at/after `launchAt` minus the
 *   name slack — possibly one older than the launch (the caller decides), or
 *   null when there is none.
 */
export function createCodexSessionReader({
  codexHome,
  zylosDir,
  fsImpl = fs,
  now = () => Date.now(),
  minScanIntervalMs = 5000,
  lookbackMs = DAY_MS,
} = {}) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const cwds = new Set([zylosDir]);
  try { cwds.add(fsImpl.realpathSync(zylosDir)); } catch { /* keep the literal path */ }

  /** path → {qualifies, startedAt, sessionId} (immutable: the first line never changes) */
  const metaCache = new Map();
  let last = null;

  function metaFor(file) {
    if (metaCache.has(file)) return metaCache.get(file);
    const first = readFirstLine(fsImpl, file);
    if (first.incomplete) return null; // not cached: the line may land later
    let meta = { qualifies: false };
    if (first.line) {
      try {
        const rec = JSON.parse(first.line);
        const p = rec?.type === 'session_meta' ? rec.payload : null;
        const startedAt = Date.parse(p?.timestamp ?? rec?.timestamp);
        if (p && typeof p.source === 'string' && FOREGROUND_SOURCES.has(p.source)
          && cwds.has(p.cwd) && Number.isFinite(startedAt)) {
          meta = { qualifies: true, startedAt, sessionId: p.id ?? p.session_id ?? null };
        }
      } catch { /* not a rollout we understand */ }
    }
    metaCache.set(file, meta);
    return meta;
  }

  const list = (dir) => {
    try { return fsImpl.readdirSync(dir); } catch { return []; }
  };

  function scan(since) {
    const cutoff = since - NAME_SLACK_MS;
    const cutoffDay = dayKey(cutoff);
    const seen = new Set();
    let best = null;

    for (const y of list(sessionsDir)) {
      if (!/^\d{4}$/.test(y) || Number(y) * 10000 + 1231 < cutoffDay) continue;
      for (const m of list(path.join(sessionsDir, y))) {
        if (!/^\d{2}$/.test(m) || Number(y) * 10000 + Number(m) * 100 + 31 < cutoffDay) continue;
        for (const d of list(path.join(sessionsDir, y, m))) {
          if (!/^\d{2}$/.test(d) || Number(y) * 10000 + Number(m) * 100 + Number(d) < cutoffDay) continue;
          const dayDir = path.join(sessionsDir, y, m, d);
          for (const name of list(dayDir)) {
            const t = nameTimeMs(name);
            if (t === null || t < cutoff) continue;
            const file = path.join(dayDir, name);
            seen.add(file);
            const meta = metaFor(file);
            if (meta?.qualifies && (!best || meta.startedAt > best.started_at)) {
              best = { session_id: meta.sessionId, started_at: meta.startedAt, rollout: file };
            }
          }
        }
      }
    }

    // Keep the cache bounded to the files still inside the window.
    for (const file of metaCache.keys()) if (!seen.has(file)) metaCache.delete(file);
    return best;
  }

  return function readCodexSession({ launchAt } = {}) {
    const t = now();
    const since = Number(launchAt) > 0 ? Number(launchAt) : t - lookbackMs;
    if (last && last.since === since && t - last.at < minScanIntervalMs) return last.result;
    let result = null;
    try { result = scan(since); } catch { result = null; }
    last = { since, at: t, result };
    return result;
  };
}
