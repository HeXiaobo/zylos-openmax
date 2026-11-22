/**
 * Runtime log collector: finds the runtime's session logs and tails them,
 * feeding normalised inputs to the attribution.
 *
 *   claude — ~/.claude/projects/<cwd-encoded>/<uuid>.jsonl (root sessions only;
 *            <uuid>/subagents/ is never read)
 *   codex  — rollout paths from $CODEX_HOME/state_5.sqlite (read-only)
 *
 * At most 4 logs, ≤ 1 MiB per log per poll, a line over 4 MiB is skipped.
 * Nothing is read while no run is open. The collector never logs per poll:
 * parse failures and unknown shapes are counted; a lasting problem (logs not
 * discoverable, 100 consecutive bad lines) switches to status-only mode and is
 * logged once per state change.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { parseClaudeRecord } from './adapters/claude-jsonl.js';
import { parseCodexRecord, createCodexState } from './adapters/codex-rollout.js';
import {
  READ_CHUNK_BYTES, MAX_LINE_BYTES, INITIAL_TAIL_BYTES, MAX_TRACKED_LOGS,
  DISCOVERY_SLACK_MS, UUID_LRU_SIZE, MAX_CONSECUTIVE_PARSE_FAILURES,
  CODEX_SQLITE_TIMEOUT_MS, DISCOVERY_RETRY_MS, RUNTIME_RESTART_IDLE_MS,
} from './constants.js';

const NEWLINE = 0x0a;

/** Claude Code's project directory name for a cwd: every non-alphanumeric → '-'. */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function readRuntimeName(zylosDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8'));
    return typeof cfg.runtime === 'string' ? cfg.runtime : 'claude';
  } catch {
    return 'claude';
  }
}

function defaultCodexQuery({ dbPath, cwd }) {
  const sql = "SELECT id, rollout_path FROM threads WHERE archived=0 AND source IN ('cli','vscode') AND cwd="
    + `'${String(cwd).replace(/'/g, "''")}' ORDER BY updated_at DESC LIMIT ${MAX_TRACKED_LOGS}`;
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-readonly', '-json', dbPath, sql], { timeout: CODEX_SQLITE_TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const rows = stdout.trim() ? JSON.parse(stdout) : [];
        resolve(rows.map((r) => r.rollout_path).filter((p) => typeof p === 'string'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function createCollector({
  runtime = 'claude',
  homeDir = process.env.HOME || '/tmp',
  zylosDir = path.join(process.env.HOME || '/tmp', 'zylos'),
  codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex'),
  attribution,
  stats,
  warn = () => {},
  now = Date.now,
  codexQuery = defaultCodexQuery,
  fsImpl = fs,
} = {}) {
  /** path → tracked log */
  const files = new Map();
  const seenUuids = new Map();
  let statusOnly = false;
  let statusOnlyReason = null;
  let lastDiscoveryFailureAt = 0;
  let consecutiveParseFailures = 0;
  let consecutiveUnknown = 0;
  let wasIdle = true;

  function setStatusOnly(on, reason) {
    if (on === statusOnly && reason === statusOnlyReason) return;
    statusOnly = on;
    statusOnlyReason = reason;
    if (on) {
      attribution.degradeAll();
      warn(`collector in status-only mode: ${reason}`);
    } else {
      attribution.recover();
      warn('collector recovered: full activity');
    }
  }

  function earliestOpenRunAt() {
    let min = Infinity;
    for (const r of (attribution.trackedRuns ? attribution.trackedRuns() : attribution.openRuns())) min = Math.min(min, r.created_at);
    return min;
  }

  function track(paths, t) {
    const keep = new Set(paths);
    for (const p of [...files.keys()]) if (!keep.has(p)) files.delete(p);
    for (const p of paths) {
      if (files.has(p)) continue;
      let size = 0;
      try { size = fsImpl.statSync(p).size; } catch { continue; }
      const offset = Math.max(0, size - INITIAL_TAIL_BYTES);
      files.set(p, {
        path: p,
        sessionId: path.basename(p, '.jsonl'),
        offset,
        skipPartial: offset > 0,
        carry: null,
        oversized: false,
        size,
        lastGrowthAt: t,
        codexState: createCodexState(),
      });
    }
  }

  async function discover() {
    const t = now();
    if (statusOnly && statusOnlyReason?.startsWith('discovery') && t - lastDiscoveryFailureAt < DISCOVERY_RETRY_MS) return;
    const earliest = earliestOpenRunAt();
    if (!Number.isFinite(earliest)) return;
    try {
      let paths;
      if (runtime === 'claude') {
        const dir = path.join(homeDir, '.claude/projects', encodeProjectDir(fsImpl.realpathSync(zylosDir)));
        const entries = fsImpl.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
        paths = entries
          .map((n) => {
            const p = path.join(dir, n);
            try { return { p, mtime: fsImpl.statSync(p).mtimeMs }; } catch { return null; }
          })
          .filter((e) => e && e.mtime >= earliest - DISCOVERY_SLACK_MS)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, MAX_TRACKED_LOGS)
          .map((e) => e.p);
      } else if (runtime === 'codex') {
        paths = (await codexQuery({ dbPath: path.join(codexHome, 'state_5.sqlite'), cwd: zylosDir }))
          .slice(0, MAX_TRACKED_LOGS);
      } else {
        throw new Error(`runtime ${runtime} not supported`);
      }
      track(paths, t);
      if (statusOnly && statusOnlyReason?.startsWith('discovery')) setStatusOnly(false, null);
    } catch (err) {
      lastDiscoveryFailureAt = t;
      setStatusOnly(true, `discovery failed (${err.code || err.message})`);
    }
  }

  function seen(uuid) {
    if (!uuid) return false;
    if (seenUuids.has(uuid)) return true;
    seenUuids.set(uuid, true);
    if (seenUuids.size > UUID_LRU_SIZE) seenUuids.delete(seenUuids.keys().next().value);
    return false;
  }

  function handleLine(f, line, window) {
    if (line.length === 0) return;
    let rec;
    try {
      rec = JSON.parse(line.toString('utf8'));
    } catch {
      stats.parse_errors += 1;
      consecutiveParseFailures += 1;
      if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
        setStatusOnly(true, `${consecutiveParseFailures} consecutive unparsable log lines`);
      }
      return;
    }
    consecutiveParseFailures = 0;
    if (runtime === 'claude') {
      const ts = Date.parse(rec?.timestamp);
      if (Number.isFinite(ts) && (ts < window.from || ts > window.to)) return;
      if (seen(rec?.uuid)) return;
    }
    const res = runtime === 'codex'
      ? parseCodexRecord(rec, f.codexState)
      : parseClaudeRecord(rec, { sessionId: f.sessionId });
    if (res.status === 'unknown') {
      stats.parse_unknown_shape += 1;
      consecutiveUnknown += 1;
      attribution.noteUnknownShape();
      if (consecutiveUnknown >= MAX_CONSECUTIVE_PARSE_FAILURES) {
        setStatusOnly(true, `${consecutiveUnknown} consecutive records of unknown shape`);
      }
      return;
    }
    if (res.status === 'ok') consecutiveUnknown = 0;
    if (runtime === 'codex') {
      for (const ev of res.events) {
        if (Number.isFinite(ev.at) && (ev.at < window.from || ev.at > window.to)) return;
      }
    }
    for (const ev of res.events) attribution.handle(ev, { file: f.path });
  }

  function readFile(f, t, window) {
    let st;
    try { st = fsImpl.statSync(f.path); } catch { return; }
    if (st.size < f.offset) {
      // Truncated or rotated: start over (uuid dedupe prevents replays).
      f.offset = 0;
      f.carry = null;
      f.skipPartial = false;
      f.oversized = false;
    }
    if (st.size > f.size) f.lastGrowthAt = t;
    f.size = st.size;
    if (st.size === f.offset) return;
    const len = Math.min(READ_CHUNK_BYTES, st.size - f.offset);
    const chunk = Buffer.alloc(len);
    let fd;
    try {
      fd = fsImpl.openSync(f.path, 'r');
      fsImpl.readSync(fd, chunk, 0, len, f.offset);
    } catch {
      return;
    } finally {
      if (fd !== undefined) try { fsImpl.closeSync(fd); } catch {}
    }
    f.offset += len;

    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== NEWLINE) continue;
      const segment = chunk.subarray(start, i);
      start = i + 1;
      const carry = f.carry;
      f.carry = null;
      if (f.skipPartial) { f.skipPartial = false; continue; }
      if (f.oversized) { f.oversized = false; continue; }
      // The cap applies to the whole line (carry + this segment), not only to
      // the incomplete tail, so a complete over-limit line is never parsed.
      if ((carry ? carry.length : 0) + segment.length > MAX_LINE_BYTES) {
        stats.lines_oversized = (stats.lines_oversized || 0) + 1;
        continue;
      }
      handleLine(f, carry ? Buffer.concat([carry, segment]) : segment, window);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      const carryLen = (f.carry ? f.carry.length : 0) + rest.length;
      if (carryLen > MAX_LINE_BYTES) {
        stats.lines_oversized = (stats.lines_oversized || 0) + 1;
        f.carry = null;
        f.oversized = true;
      } else if (!f.oversized) {
        f.carry = f.carry ? Buffer.concat([f.carry, rest]) : Buffer.from(rest);
      }
    }
  }

  function checkRuntimeRestart(t) {
    const turn = attribution.turn;
    if (!turn?.file) return;
    const f = files.get(turn.file);
    if (!f || t - f.lastGrowthAt < RUNTIME_RESTART_IDLE_MS) return;
    for (const other of files.values()) {
      if (other !== f && other.lastGrowthAt > f.lastGrowthAt) {
        attribution.noteRuntimeRestart();
        return;
      }
    }
  }

  return {
    files,
    get statusOnly() { return statusOnly; },
    discover,

    /**
     * The poll timer is stopping (no open run): the next poll starts as a
     * return from idle and skips what accumulated meanwhile.
     */
    markIdle() {
      wasIdle = true;
    },

    /** One poll: read every tracked log once. */
    poll() {
      const t = now();
      const earliest = earliestOpenRunAt();
      if (!Number.isFinite(earliest)) {
        wasIdle = true;
        return;
      }
      if (wasIdle) {
        // Coming back from idle: skip what accumulated while nobody listened.
        for (const f of files.values()) {
          let size = f.size;
          try { size = fsImpl.statSync(f.path).size; } catch {}
          const target = Math.max(f.offset, size - INITIAL_TAIL_BYTES);
          if (target > f.offset) {
            f.offset = target;
            f.carry = null;
            f.skipPartial = true;
          }
        }
        wasIdle = false;
      }
      const window = { from: earliest - DISCOVERY_SLACK_MS, to: t + DISCOVERY_SLACK_MS };
      for (const f of files.values()) readFile(f, t, window);
      checkRuntimeRestart(t);
    },
  };
}
