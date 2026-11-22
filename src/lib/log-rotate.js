/**
 * Size-based log rotation via copytruncate — zero external deps.
 *
 * PM2 (fork mode) owns the log file descriptors and opens them O_APPEND, so we
 * cannot rename+reopen from inside the app (the daemon would keep writing to the
 * old inode and `pm2 logs` would tail the wrong file). Instead we use the
 * logrotate `copytruncate` strategy: take a fast raw snapshot of the live file
 * (`copyFileSync` to a durable, uncompressed `<stem>.<stamp>.log`), truncate the
 * live file to 0 IMMEDIATELY, then gzip that snapshot to a `.gz.partial` and
 * atomically rename it onto the final `<stem>.<stamp>.log.gz` — only then is the
 * uncompressed snapshot deleted. Under O_APPEND the daemon's next write lands at
 * offset 0 with no sparse hole, the path is unchanged, and `pm2 logs` keeps
 * following it.
 *
 * Archive-I/O failures never eat the segment: if the gzip/write fails after the
 * truncate (disk full, perms, stream error) the `.gz.partial` is removed but the
 * uncompressed `<stem>.<stamp>.log` snapshot is KEPT in place (data preserved,
 * just not compressed) and the error propagates so rotateAll logs it. The atomic
 * rename also means a half-written `.log.gz` is never observable.
 *
 * copytruncate is inherently lossy in one tiny window: bytes the O_APPEND writer
 * emits in the microsecond gap between `copyFileSync` returning and the
 * `truncateSync` are in neither the snapshot nor the (now-empty) live file — they
 * are LOST, not preserved and not deferred to a next window. This is the same
 * trade-off logrotate's own copytruncate makes. Doing copy-then-immediate-
 * truncate (and compressing only AFTER the truncate) shrinks that window from the
 * full gzip-stream duration down to two adjacent syscalls; it does not eliminate
 * it. Acceptable for logs.
 *
 * The live file stays plain text; only the rolled-off archives are gzipped.
 * Archives are kept forever — there is NO pruning / retention limit here.
 *
 * Because archives are never pruned, the archive identity must be collision-proof:
 * `stamp()` is only second-granular, so two rotations of the same file within one
 * second (runOnStart + a manual tick, a crash-restart, a frozen-clock test) would
 * otherwise derive the same `<stem>.<stamp>` base and the second rotation would
 * silently overwrite the first archive. A reservation loop instead claims a unique
 * base by appending `.1`, `.2`, … until it finds one whose `.log.gz` does not
 * already exist AND whose `.log` snapshot slot it can atomically create with
 * `O_EXCL` — so neither a published archive nor an in-progress/preserved snapshot
 * is ever clobbered.
 *
 * Registered into the existing TaskRegistry via startLogRotation() so it inherits
 * serialization (non-overlapping ticks), error isolation and unified start/stop.
 *
 * Log paths come from PM2's injected env (`pm_out_log_path` / `pm_err_log_path`).
 * Outside PM2 those are absent and every tick is a graceful no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// 20MB is both the rotation threshold AND the floor: files at or below it are
// skipped, so frequent restarts can never accumulate a pile of tiny archives.
export const MAX_BYTES = 20 * 1024 * 1024;
// DAILY size check (this is the *check* cadence, not the rotation frequency —
// a file only rotates on the tick where it has grown past MAX_BYTES).
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Filesystem-safe local timestamp: YYYY-MM-DD_HHMMSS. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Log file paths PM2 injects into the child process env. */
export function logPaths() {
  return [process.env.pm_out_log_path, process.env.pm_err_log_path].filter(Boolean);
}

/**
 * Rotate a single file if (and only if) it is larger than `maxBytes`.
 * Returns true if it rotated, false if skipped (small / missing / unreadable).
 * @param {string} file
 * @param {number} [maxBytes]
 * @param {object} [opts]
 * @param {() => import('node:stream').Transform} [opts.gzipFactory]
 *        Compression-stream factory; defaults to zlib.createGzip. Injectable so
 *        tests can force an archive-write failure (zlib exports are read-only).
 * @param {() => string} [opts.stampFn]
 *        Timestamp factory; defaults to `stamp`. Injectable so tests can freeze the
 *        clock (a constant stamp) and deterministically exercise same-second rotations.
 */
export async function rotateFile(file, maxBytes = MAX_BYTES, opts = {}) {
  const gzipFactory = opts.gzipFactory ?? (() => zlib.createGzip());
  const stampFn = opts.stampFn ?? stamp;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // missing / unreadable → nothing to do
  }
  if (size <= maxBytes) return false; // floor protection: <= threshold never rotates

  const dir = path.dirname(file);
  const bn = path.basename(file);
  const stem = bn.endsWith('.log') ? bn.slice(0, -'.log'.length) : bn;

  // Reserve a collision-proof base. `stamp()` is only second-granular, so a base
  // of just `<stem>.<stamp>` can repeat when the same file rotates twice within one
  // second — and since archives are never pruned, reusing a base means the second
  // rotation clobbers the first's `.log.gz` (success path) or its preserved `.log`
  // snapshot (archive-failure path). We probe n = 0, 1, 2, … and claim the first
  // base whose `.log.gz` is absent AND whose `.log` snapshot slot we can create with
  // O_EXCL (atomic reserve). Rotations are serialized by TaskRegistry's
  // non-overlapping ticks, so this is sequential — the same-second case is repeated
  // calls, not true concurrency. A brief TOCTOU exists between the `.log.gz` check
  // and the O_EXCL create; that is acceptable given the serialized single-writer.
  const stamped = stampFn();
  let base, snapshot, archive;
  for (let n = 0; ; n++) {
    const cand = path.join(dir, `${stem}.${stamped}${n === 0 ? '' : `.${n}`}`);
    if (fs.existsSync(`${cand}.log.gz`)) continue; // a prior same-second rotation already published here
    let fd;
    try {
      fd = fs.openSync(`${cand}.log`, 'wx'); // O_EXCL: fails if a snapshot slot is already taken
    } catch (err) {
      if (err?.code === 'EEXIST') continue;  // a prior rotation's snapshot still present (e.g. its archive failed)
      throw err;
    }
    fs.closeSync(fd);
    base = cand;
    snapshot = `${cand}.log`;   // durable UNCOMPRESSED snapshot (slot already reserved above)
    archive = `${cand}.log.gz`; // final compressed archive
    break;
  }
  const partial = `${archive}.partial.${process.pid}`;    // in-progress gzip (collision-safe)

  // Fast raw snapshot into the reserved (currently empty) archive candidate.
  // copyFileSync reads to EOF, so appends that land while the copy is running
  // (O_APPEND puts them at EOF, ahead of the copy read) are captured too — only the
  // gap AFTER this returns is at risk.
  fs.copyFileSync(file, snapshot);
  // Truncate IMMEDIATELY, before the (slow) compression, so the copytruncate
  // loss window is just the syscall gap between the copy and this truncate.
  // Bytes appended in that microsecond gap are LOST — not preserved, not
  // deferred to a next window. Same lossy race as logrotate's copytruncate.
  fs.truncateSync(file, 0); // O_APPEND writer resumes at offset 0, no sparse hole

  // Compress the snapshot outside the loss window. The uncompressed snapshot is
  // the durable copy of the rotated segment and must survive until the .log.gz
  // is safely in place — so if the archive I/O fails here (disk full, perms,
  // stream error) we KEEP the snapshot rather than lose the whole segment.
  try {
    await pipeline(
      fs.createReadStream(snapshot),
      gzipFactory(),
      fs.createWriteStream(partial),
    );
    // Atomic publish: rename the fully-written .partial onto the final name so a
    // half-written .log.gz is never observable. Only then drop the snapshot.
    fs.renameSync(partial, archive);
    try { fs.rmSync(snapshot, { force: true }); } catch { /* best-effort */ }
  } catch (err) {
    // Archive failed: bin the partial, but LEAVE the uncompressed snapshot in
    // place so the rotated segment is preserved (just not gzipped). Propagate so
    // rotateAll logs it.
    try { fs.rmSync(partial, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
  return true;
}

/**
 * One rotation tick over all target files. Best-effort and total: a failure on
 * one file is logged and swallowed so nothing can ever throw into the task loop.
 * @param {object} [opts]
 * @param {string[]} [opts.files]     Override target paths (tests); defaults to logPaths()
 * @param {number}   [opts.maxBytes]  Override threshold (tests)
 */
export async function rotateAll(opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  let files;
  try {
    files = opts.files ?? logPaths();
  } catch {
    return; // resolving paths must never throw into the loop
  }
  for (const f of files) {
    try {
      await rotateFile(f, maxBytes);
    } catch (err) {
      try { console.error(`[log-rotate] rotation failed for ${f}: ${err?.message || err}`); } catch { /* ignore */ }
    }
  }
}

/**
 * Register (and by default start) the `log-rotate` task on an existing
 * TaskRegistry. runOnStart:true → an oversized file is caught at boot rather
 * than after the first full day.
 * @param {import('./task-registry.js').default} taskRegistry
 * @param {object} [opts]
 * @param {string[]} [opts.files]
 * @param {number}   [opts.maxBytes]
 * @param {number}   [opts.intervalMs]
 * @param {boolean}  [opts.autoStart=true]
 * @returns {Function} the registered tick function
 */
export function startLogRotation(taskRegistry, opts = {}) {
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const fn = () => rotateAll(opts);
  taskRegistry.register('log-rotate', fn, intervalMs, { runOnStart: true });
  if (opts.autoStart !== false) taskRegistry.start('log-rotate');
  return fn;
}
