#!/usr/bin/env node
'use strict';

/**
 * Standalone upgrade executor — runs as its OWN PM2 app (`zylos-openmax-upgrader`).
 *
 * Started on demand by auto-upgrade.js via:
 *   pm2 start scripts/upgrade-executor.cjs --name zylos-openmax-upgrader \
 *     --max-restarts 3 --restart-delay 2000 \
 *     --output <runtime>/upgrader-out.log --error <runtime>/upgrader-err.log \
 *     -- <marker-path>
 *
 * Why a separate PM2 app instead of a detached child of the openmax service?
 *   `zylos upgrade openmax` internally runs `pm2 stop zylos-openmax`, and PM2's
 *   TreeKill walks the PPID chain of that service's process tree. A child of the
 *   openmax service (even detached) risks being caught. A process started via
 *   `pm2 start` is parented to the PM2 God daemon — it is a SIBLING of
 *   zylos-openmax, not a descendant — so stopping zylos-openmax can never reach
 *   it.
 *
 * Why autorestart (capped) instead of --no-autorestart?
 *   If this executor dies unexpectedly (OOM, manual kill, pm2-wide restart)
 *   AFTER it has already stopped openmax, nothing else can rescue the system:
 *   the auto-upgrade check timer lives INSIDE openmax, so a stopped openmax
 *   means no future detection cycle. PM2 therefore acts as the watchdog — it
 *   relaunches a dead executor within seconds. The relaunched instance never
 *   re-runs the upgrade: the first instance claims the marker with its pid, so
 *   a relaunch sees a foreign `executorPid` on a 'running' marker and takes the
 *   interrupted-run path (restore snapshot, restart openmax, mark failed,
 *   self-delete). Relaunches after a terminal marker are cheap no-ops that exit
 *   immediately; --max-restarts caps the loop (fast exits count as unstable
 *   restarts), leaving at worst an 'errored' entry that auto-upgrade.js clears
 *   on its next cycle. The entry is never `pm2 save`d, so a daemon resurrection
 *   cannot bring back a stale upgrader.
 *
 * Responsibilities:
 *   1. Read the pre-written marker (from, to, notes, url) and claim it (pid).
 *   2. Snapshot the currently installed skill dir (self-contained rollback —
 *      does not depend on zylos-core's internal backup layout).
 *   3. Run `zylos upgrade openmax --yes --mode overwrite`.
 *   4. Verify the new version is installed AND stable (not crash-looping).
 *   5. On verification failure: stop openmax, restore the snapshot, restart,
 *      verify the rollback, and record a truthful outcome in the marker.
 *   6. Write the terminal result back to the marker (atomically), THEN remove
 *      our own PM2 entry — state must be final before the self-delete.
 *   7. On ANY failure, ensure the openmax service is running again (with an
 *      ecosystem-file fallback in case its pm2 entry was deleted).
 *
 * Anti-infinite-loop guarantees live here + in auto-upgrade.js:
 *   - a relaunched instance never re-runs a claimed upgrade (pid guard);
 *   - verification requires the version to ACTUALLY change to the target and
 *     the restart counter to hold steady, so a broken upgrade is recorded as
 *     failed and auto-upgrade.js won't retry that version (cooldown);
 *   - stray/terminal/stale-marker launches exit without acting.
 *
 * CJS (.cjs) so Node treats it as CommonJS regardless of package.json "type".
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PM2_SERVICE = 'zylos-openmax';
const PM2_UPGRADER = 'zylos-openmax-upgrader';
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const PM2_CMD_TIMEOUT_MS = 30 * 1000;
const VERIFY_DELAY_MS = 5 * 1000;
const VERIFY_RETRIES = 6;
const ROLLBACK_VERIFY_RETRIES = 4;
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
const SKILL_DIR = path.resolve(__dirname, '..');
const ECOSYSTEM_PATH = path.join(SKILL_DIR, 'ecosystem.config.cjs');

const zylosBin = process.env.ZYLOS_BIN || 'zylos';

// Marker path: prefer the argument, fall back to the canonical runtime path so
// the executor still works if PM2 arg forwarding ever misbehaves.
const DEFAULT_MARKER_PATH = path.join(
  process.env.HOME || os.homedir(),
  'zylos/components/openmax/runtime/upgrade-marker.json',
);
const markerPath = process.argv[2] || DEFAULT_MARKER_PATH;
const runtimeDir = path.dirname(markerPath);
const logFile = path.join(runtimeDir, 'upgrade-executor.log');
const MAX_EXECUTOR_LOG_BYTES = 1024 * 1024;

// PM2-captured stdout/stderr of this app. auto-upgrade.js starts us with
// --output/--error pointing here (instead of the default ~/.pm2/logs, which
// would accumulate forever). Removed on terminal cleanup paths; a watchdog
// relaunch leaves them in place so crash forensics survive until then.
const UPGRADER_OUT_LOG = path.join(runtimeDir, 'upgrader-out.log');
const UPGRADER_ERR_LOG = path.join(runtimeDir, 'upgrader-err.log');

// Self-contained pre-upgrade snapshot (lives in the openmax data dir, outside
// the skill dir that `zylos upgrade` overwrites). node_modules is tiny for
// this component, so the snapshot includes it — restoring needs no npm.
const SNAPSHOT_DIR = path.join(runtimeDir, 'rollback-snapshot');
const SNAPSHOT_EXCLUDES = new Set(['.backup', '.git', '.zylos']);

function appendLog(line) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [upgrader:${process.pid}] ${line}\n`);
  } catch {}
}

/** Keep the executor's own log size-bounded: truncate if it exceeds 1MB. */
function boundExecutorLog() {
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_EXECUTOR_LOG_BYTES) {
      fs.truncateSync(logFile, 0);
      appendLog(`log truncated (previous size ${st.size} bytes exceeded ${MAX_EXECUTOR_LOG_BYTES})`);
    }
  } catch {}
}

/** Remove the PM2-captured stdout/stderr files (terminal cleanup only). */
function removeUpgraderPm2Logs() {
  for (const f of [UPGRADER_OUT_LOG, UPGRADER_ERR_LOG]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

/**
 * Preserve crash forensics: copy the tail of the pm2-captured stderr of the
 * previous (crashed) run into our persistent executor log before terminal
 * cleanup deletes the pm2 log files.
 */
function logUpgraderErrTail(maxBytes = 4096) {
  try {
    const st = fs.statSync(UPGRADER_ERR_LOG);
    if (!st.size) return;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(UPGRADER_ERR_LOG, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    appendLog(`tail of previous run's pm2 error log:\n${buf.toString('utf-8')}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Pure decision helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Decide what a freshly started executor instance should do, based solely on
 * the marker contents. One code path covers every relaunch flavour: PM2
 * watchdog restart after a crash, `pm2 restart` from a pm2-wide operation
 * (e.g. `zylos upgrade --self` restarting skill services), or a stray launch.
 *
 * @returns {{action: 'proceed'|'exit-stale'|'interrupted', reason: string}}
 *   'proceed'     — fresh unclaimed running marker: this is the real run.
 *   'exit-stale'  — terminal/missing/too-old marker: no-op, self-delete, exit.
 *   'interrupted' — running marker claimed by another pid: the previous run
 *                   died mid-upgrade. Recover openmax; NEVER re-run the upgrade.
 */
function evaluateStartGuard(marker, now = Date.now(), pid = process.pid) {
  if (!marker || marker.status !== 'running') {
    return {
      action: 'exit-stale',
      reason: `marker status is '${marker ? marker.status : 'missing'}' — nothing pending`,
    };
  }
  const age = now - (marker.ts || 0);
  if (age >= STALE_RUNNING_THRESHOLD_MS) {
    return { action: 'exit-stale', reason: `running marker too old (${age}ms) — refusing to act on it` };
  }
  if (marker.executorPid && marker.executorPid !== pid) {
    // Note: pid reuse could theoretically alias a relaunch to 'proceed', but a
    // recycled pid landing on the exact claimed value within the fresh-marker
    // window is negligible in practice.
    return {
      action: 'interrupted',
      reason: `marker claimed by pid ${marker.executorPid}, we are ${pid} — previous run died mid-upgrade`,
    };
  }
  return { action: 'proceed', reason: 'fresh unclaimed running marker' };
}

// ---------------------------------------------------------------------------
// pm2 helpers (array args — no shell interpolation anywhere in this file)
// ---------------------------------------------------------------------------

function pm2(args, timeout = PM2_CMD_TIMEOUT_MS) {
  execFileSync('pm2', args, { timeout, stdio: 'ignore' });
}

function getPm2Proc(name = PM2_SERVICE) {
  try {
    const out = execFileSync('pm2', ['jlist'], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const procs = JSON.parse(out.toString());
    return procs.find(p => p.name === name) || null;
  } catch {
    return null;
  }
}

function startServiceFromEcosystem() {
  try {
    pm2(['start', ECOSYSTEM_PATH, '--only', PM2_SERVICE, '--update-env']);
    appendLog('PM2 start from ecosystem file succeeded');
    return true;
  } catch (e) {
    appendLog(`PM2 start from ecosystem file FAILED: ${e.message}`);
    return false;
  }
}

/**
 * Safety net: make sure the openmax service is running.
 *
 * - If its pm2 entry is gone entirely (e.g. a failed re-registration inside
 *   `zylos upgrade` deleted it), `pm2 restart/start <name>` cannot work — go
 *   straight to the component ecosystem file.
 * - If it is already online and forceRestart is false, leave it untouched
 *   (no gratuitous restart of a healthy service).
 * - forceRestart is used after restoring files, so the process reloads them.
 *
 * @returns {boolean} whether the service is believed to be running afterwards.
 */
function ensurePm2Running({ forceRestart = false } = {}) {
  appendLog(`ensuring ${PM2_SERVICE} is running (forceRestart=${forceRestart})...`);
  const proc = getPm2Proc();
  if (!proc) {
    appendLog(`${PM2_SERVICE} has no pm2 entry — starting from ecosystem file`);
    return startServiceFromEcosystem();
  }
  if (!forceRestart && proc.pm2_env?.status === 'online') {
    appendLog(`${PM2_SERVICE} already online — leaving it untouched`);
    return true;
  }
  try {
    pm2(['restart', PM2_SERVICE]);
    appendLog('PM2 restart succeeded');
    return true;
  } catch (e) {
    appendLog(`PM2 restart failed: ${e.message}`);
  }
  try {
    pm2(['start', PM2_SERVICE]);
    appendLog('PM2 start succeeded');
    return true;
  } catch (e) {
    appendLog(`PM2 start failed: ${e.message}`);
  }
  return startServiceFromEcosystem();
}

/**
 * Remove our own PM2 entry and exit. Deleting ourselves would kill this
 * process mid-call, so the `pm2 delete` runs as a detached child that outlives
 * us. IMPORTANT: the marker (and thus the owner notification content) must be
 * finalized BEFORE calling this — after process.exit nothing else runs. If the
 * delete loses the race against PM2's autorestart, the relaunch is a cheap
 * no-op ('exit-stale' guard) that spawns its own delete; --max-restarts bounds
 * the cycle and auto-upgrade.js clears any leftover errored entry.
 */
function selfDeleteAndExit(code) {
  appendLog(`self-cleanup: pm2 delete ${PM2_UPGRADER}, exiting(${code})`);
  // Terminal path: drop the pm2-captured stdout/stderr files so they never
  // accumulate across runs. (A relaunch racing the delete may recreate small
  // files; auto-upgrade.js removes them again on its cleanup paths.)
  removeUpgraderPm2Logs();
  try {
    const child = spawn('pm2', ['delete', PM2_UPGRADER], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    appendLog(`WARN: self pm2 delete spawn failed: ${e.message}`);
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Snapshot / rollback (self-contained — no dependence on zylos-core internals)
// ---------------------------------------------------------------------------

function snapshotFilter(src) {
  return !SNAPSHOT_EXCLUDES.has(path.basename(src));
}

function hasSnapshot() {
  try {
    return fs.existsSync(path.join(SNAPSHOT_DIR, 'package.json'));
  } catch {
    return false;
  }
}

function takeSnapshot() {
  try {
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    fs.cpSync(SKILL_DIR, SNAPSHOT_DIR, { recursive: true, filter: snapshotFilter });
    appendLog(`snapshot of current version saved to ${SNAPSHOT_DIR}`);
    return true;
  } catch (e) {
    appendLog(`WARN: snapshot failed: ${e.message} — no self-contained rollback available`);
    return false;
  }
}

// Snapshot lifecycle policy: removed only once the install state is RESOLVED —
// verified success (incl. verification resumed after an interruption) or a
// snapshot consumed by a successful rollback. Kept for forensics/manual
// recovery in every unresolved case: failed restore, unhealthy rollback, or an
// interruption that left the version state ambiguous. Every decision is
// logged; the next upgrade's takeSnapshot() replaces any leftover snapshot.
function clearSnapshot(reason) {
  try {
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    appendLog(`snapshot removed (${reason})`);
  } catch (e) {
    appendLog(`WARN: failed to remove snapshot: ${e.message}`);
  }
}

/**
 * Replace targetDir's contents with the snapshot — a true restore, not a
 * merge. A plain overwrite-copy would leave files ADDED by the failed new
 * version in place, producing a broken mix of old package.json + new-version
 * leftovers. Entries in `preserved` (zylos-core's .backup, component .zylos
 * state, .git in dev installs) survive; everything else is replaced. All
 * runtime data/config/logs live under ~/zylos/components/openmax (verified
 * across the repo), so nothing else in the skill dir needs to survive.
 *
 * Failure ordering — no data copying may happen after anything is deleted:
 *   1. STAGE: copy the snapshot to a sibling temp dir (same filesystem).
 *      Fails → abort with targetDir completely untouched.
 *   2. CLEAR: delete targetDir entries (incl. dotfiles, except preserved).
 *      Only the CONTENTS are removed — targetDir keeps its inode, so pm2 cwd
 *      references and this process's own cwd stay valid.
 *   3. SWAP:  rename staged entries into place — pure same-filesystem
 *      renames, no data copying left to fail. If a rename still fails, log
 *      loudly and KEEP the staged copy on disk for manual recovery.
 *
 * Exported for tests (paths injectable).
 *
 * @returns {boolean} whether the restore fully completed.
 */
function replaceDirWithSnapshot(snapshotDir, targetDir, preserved = SNAPSHOT_EXCLUDES, log = appendLog) {
  const stageDir = `${targetDir}.restore-tmp`;

  // 1. STAGE
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.cpSync(snapshotDir, stageDir, { recursive: true });
  } catch (e) {
    log(`restore staging FAILED (target dir untouched): ${e.message}`);
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    return false;
  }

  try {
    // 2. CLEAR
    for (const entry of fs.readdirSync(targetDir)) {
      if (preserved.has(entry)) continue;
      fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
    }
    // 3. SWAP
    for (const entry of fs.readdirSync(stageDir)) {
      fs.renameSync(path.join(stageDir, entry), path.join(targetDir, entry));
    }
  } catch (e) {
    log(`FATAL: restore swap failed midway: ${e.message} — target dir may be incomplete; staged copy KEPT at ${stageDir} for manual recovery`);
    return false;
  }

  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  return true;
}

/**
 * Roll back to the pre-upgrade snapshot: stop service, replace files, restart.
 *
 * @returns {boolean} whether the snapshot was fully restored (the service is
 *   restarted in either case, with whatever ended up on disk).
 */
function rollbackToSnapshot() {
  if (!hasSnapshot()) {
    appendLog('no snapshot available — cannot roll back');
    return false;
  }
  appendLog('rolling back to pre-upgrade snapshot (replace, not merge)...');
  try {
    pm2(['stop', PM2_SERVICE]);
  } catch (e) {
    appendLog(`pm2 stop before rollback failed (continuing): ${e.message}`);
  }
  const restored = replaceDirWithSnapshot(SNAPSHOT_DIR, SKILL_DIR);
  if (restored) {
    appendLog('snapshot restored (skill dir fully replaced)');
  }
  // Restart in either case — with the restored version, or with whatever is
  // on disk if the restore could not complete.
  ensurePm2Running({ forceRestart: true });
  return restored;
}

// ---------------------------------------------------------------------------
// Marker + verification
// ---------------------------------------------------------------------------

let marker = null;

// Atomic write: tmp file + rename, so a reader (the restarted openmax service)
// never observes a half-written JSON marker.
function writeMarker(updates) {
  Object.assign(marker, updates, { ts: Date.now() });
  const tmp = `${markerPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch (e) {
    appendLog(`WARN: failed to write marker: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function readInstalledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return null;
  }
}

/**
 * Verify a target version landed AND is stable.
 *
 * Requires two consecutive polls where the installed version equals the target
 * and the service is online with a NON-increasing restart counter. If the
 * restart counter climbs between polls the version is crash-looping — treated
 * as failure rather than declaring success on a process about to die again.
 *
 * Last-poll boundary: success needs two consecutive healthy polls, so a
 * service whose FIRST healthy sighting lands on the final scheduled poll can
 * never confirm within the loop. Exactly one extra confirmation poll is
 * granted in that case — otherwise a service that came up healthy right at
 * the deadline would be declared failed and needlessly rolled back.
 *
 * deps ({sleep, readInstalledVersion, getPm2Proc}) are injectable for tests.
 */
async function verifyUpgrade(targetVersion, retries = VERIFY_RETRIES, deps = {}) {
  const doSleep = deps.sleep || sleep;
  const readVersion = deps.readInstalledVersion || readInstalledVersion;
  const getProc = deps.getPm2Proc || getPm2Proc;

  appendLog(`verifying v${targetVersion} (version match + stability, up to ${retries} polls)...`);
  let baselineRestarts = null;
  let stableOnce = false;
  let extraPollGranted = false;
  let polls = 0;

  for (let i = 0; i < retries; i++) {
    await doSleep(VERIFY_DELAY_MS);
    polls = i + 1;
    const version = readVersion();
    const proc = getProc();
    const status = proc ? proc.pm2_env.status : null;
    const restarts = proc ? (proc.pm2_env.restart_time ?? 0) : null;
    appendLog(`  poll ${polls}: version=${version}, pm2=${status}, restarts=${restarts}`);

    if (version !== targetVersion || status !== 'online') {
      // Reset stability tracking — not there yet.
      baselineRestarts = null;
      stableOnce = false;
      continue;
    }

    if (baselineRestarts === null) {
      // First healthy sighting — record restart baseline, need one more clean poll.
      baselineRestarts = restarts;
      stableOnce = true;
      if (i === retries - 1 && !extraPollGranted) {
        extraPollGranted = true;
        retries += 1;
        appendLog('  first healthy poll landed on the final slot — granting one extra confirmation poll');
      }
      continue;
    }

    if (restarts != null && baselineRestarts != null && restarts > baselineRestarts) {
      appendLog(`  restart counter climbed ${baselineRestarts} -> ${restarts}: version is crash-looping`);
      return false;
    }

    if (stableOnce) {
      appendLog('  version matches and service stable across two polls');
      return true;
    }
  }
  appendLog(`verification FAILED for v${targetVersion}: no two consecutive healthy polls in ${polls} polls`);
  return false;
}

// ---------------------------------------------------------------------------
// Failure handlers
// ---------------------------------------------------------------------------

/**
 * The upgrade command succeeded but the result failed verification (wrong
 * version, offline, or crash-looping). `zylos upgrade` exited 0 so IT rolled
 * nothing back — the broken new version is on disk. Restore our snapshot,
 * verify the rollback, and record a truthful outcome. The marker stays
 * 'running' until the final write, so a restarted openmax cannot consume a
 * half-baked result mid-recovery.
 */
async function handleVerificationFailure() {
  const version = readInstalledVersion();
  const proc = getPm2Proc();
  const status = proc ? proc.pm2_env?.status : null;
  appendLog(`post-upgrade verification FAILED: version=${version}, pm2=${status}`);

  if (!hasSnapshot()) {
    writeMarker({
      completed: false,
      status: 'failed',
      error: `Upgrade verification failed (installed=${version}, pm2=${status}).`,
      detail: `The new version failed verification and no snapshot was available to roll back — the service was left on v${version} and may be unstable.`,
    });
    ensurePm2Running();
    return;
  }

  const restored = rollbackToSnapshot();
  if (!restored) {
    writeMarker({
      completed: false,
      status: 'failed',
      error: `Upgrade verification failed (installed=${version}, pm2=${status}) and the snapshot restore also failed.`,
      detail: `The new version failed verification AND the rollback could not be fully applied — the install may be broken or incomplete. Manual attention needed; see upgrade-executor.log. Snapshot kept at ${SNAPSHOT_DIR}.`,
    });
    return; // rollbackToSnapshot already attempted a restart
  }

  const rollbackOk = await verifyUpgrade(marker.from, ROLLBACK_VERIFY_RETRIES);
  if (rollbackOk) {
    clearSnapshot('consumed by successful rollback');
    writeMarker({
      completed: false,
      status: 'failed',
      error: `New version v${marker.to} failed verification (crash-loop or version mismatch).`,
      detail: `The new version did not run stably; rolled back to v${marker.from} and the service is running again.`,
    });
  } else {
    writeMarker({
      completed: false,
      status: 'failed',
      error: `New version v${marker.to} failed verification; rollback to v${marker.from} was applied but the service did not come up healthy.`,
      detail: `Rolled back to v${marker.from}, but the service is still not healthy — manual attention needed. Snapshot kept at ${SNAPSHOT_DIR}.`,
    });
  }
}

const INTERRUPTED_ERROR = 'Upgrade executor died mid-run and was relaunched (PM2 watchdog or a pm2-wide restart).';

/**
 * Pure (exported for tests): decide how an interrupted run should recover,
 * based on what version is ACTUALLY installed. The previous executor may have
 * died at any point, so the install state — not the service state — is the
 * source of truth:
 *
 *   'resume-verify' — installed == marker.to: `zylos upgrade` completed before
 *       the interruption. The new version may be perfectly healthy; blindly
 *       failing it (and deleting the snapshot, the only rollback path!) would
 *       both mislabel a good upgrade as failedVersion and destroy recovery.
 *       Resume verification instead.
 *   'restore'       — installed == marker.from, service down, snapshot
 *       available: the upgrade never took effect but may have died mid-copy;
 *       a full snapshot restore guarantees a consistent install.
 *   'fail-keep-old' — installed == marker.from, but the service is running or
 *       no snapshot exists: the old version is in place; just ensure it runs.
 *   'fail-preserve-snapshot' — version unreadable or matches neither side:
 *       unknown state. Keep the snapshot, ensure the service runs, tell the
 *       owner manual attention may be needed.
 *
 * The snapshot is never cleared before the version state is resolved.
 */
function resolveInterruptedAction({ installedVersion, marker, serviceOnline, snapshotAvailable }) {
  if (installedVersion && marker && installedVersion === marker.to) {
    return { action: 'resume-verify' };
  }
  if (installedVersion && marker && installedVersion === marker.from) {
    if (!serviceOnline && snapshotAvailable) return { action: 'restore' };
    return { action: 'fail-keep-old' };
  }
  return { action: 'fail-preserve-snapshot' };
}

/**
 * A relaunched instance found a running marker claimed by a dead predecessor.
 * The previous run may have died at any point — before, during, or after the
 * upgrade command. Resolve the actual install state first; NEVER re-run the
 * upgrade command itself.
 */
async function handleInterrupted(reason) {
  appendLog(`INTERRUPTED RUN DETECTED: ${reason}`);
  // The previous instance may have crashed with a stack trace on stderr —
  // preserve it in our persistent log before terminal cleanup wipes the
  // pm2-captured files.
  logUpgraderErrTail();

  const installedVersion = readInstalledVersion();
  const proc = getPm2Proc();
  const serviceOnline = proc?.pm2_env?.status === 'online';
  const { action } = resolveInterruptedAction({
    installedVersion,
    marker,
    serviceOnline,
    snapshotAvailable: hasSnapshot(),
  });
  appendLog(`interrupted recovery: installed=${installedVersion}, from=v${marker.from}, to=v${marker.to}, serviceOnline=${serviceOnline}, action=${action}`);

  switch (action) {
    case 'resume-verify': {
      // Files are on the target version — the upgrade command completed
      // before the interruption. Resume verification where the previous run
      // left off instead of failing a possibly-healthy upgrade.
      ensurePm2Running(); // it may have died before the post-upgrade restart
      const ok = await verifyUpgrade(marker.to);
      if (ok) {
        appendLog('resumed verification PASSED — recording success');
        clearSnapshot('upgrade verified successfully (verification resumed after interruption)');
        writeMarker({
          completed: true,
          status: 'completed',
          detail: 'The upgrade completed; verification was interrupted and resumed by a relaunched executor, then passed.',
        });
      } else {
        // Same recovery as a normal verification failure — the snapshot is
        // still intact because nothing was cleared before this resolution.
        await handleVerificationFailure();
      }
      break;
    }

    case 'restore': {
      const restored = rollbackToSnapshot();
      if (restored) {
        clearSnapshot('consumed by interrupted-run rollback');
        writeMarker({
          completed: false,
          status: 'failed',
          error: INTERRUPTED_ERROR,
          detail: `The upgrade was interrupted before taking effect; the previous version v${marker.from} was restored from snapshot and the service restarted. The upgrade was NOT re-run.`,
        });
      } else {
        writeMarker({
          completed: false,
          status: 'failed',
          error: INTERRUPTED_ERROR,
          detail: `The upgrade was interrupted and the snapshot restore could not be fully applied; the service was restarted with what is on disk. Manual check advised; see upgrade-executor.log. Snapshot kept at ${SNAPSHOT_DIR}.`,
        });
      }
      break;
    }

    case 'fail-keep-old': {
      ensurePm2Running();
      writeMarker({
        completed: false,
        status: 'failed',
        error: INTERRUPTED_ERROR,
        detail: `The upgrade was interrupted before it took effect; the service is still on v${marker.from}. The upgrade was NOT re-run.`,
      });
      // The old version is confirmed in place, but keep the snapshot anyway —
      // the interruption's exact progress is unknown (package.json is the
      // last-copied signal, not proof of full consistency). The next
      // upgrade's takeSnapshot() replaces it.
      appendLog(`snapshot kept at ${SNAPSHOT_DIR} (old version in place; next upgrade replaces it)`);
      break;
    }

    case 'fail-preserve-snapshot':
    default: {
      ensurePm2Running();
      writeMarker({
        completed: false,
        status: 'failed',
        error: INTERRUPTED_ERROR,
        detail: `The upgrade was interrupted and left the install in an unexpected state (installed=${installedVersion ?? 'unreadable'}, expected v${marker.from} or v${marker.to}); the service was restarted with what is on disk. Manual attention may be needed. Snapshot kept at ${SNAPSHOT_DIR}.`,
      });
      break;
    }
  }

  selfDeleteAndExit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Pure (exported for tests): build the marker update for an unexpected
 * top-level crash of main(), or null when nothing should be written — either
 * there is no marker to update, or it already holds a terminal result that
 * must not be overwritten (re-entrancy with the normal terminal paths).
 */
function buildFatalMarkerUpdate(err, currentMarker) {
  if (!currentMarker) return null;
  if (currentMarker.status && currentMarker.status !== 'running') return null;
  return {
    completed: false,
    status: 'failed',
    error: `Unexpected executor error: ${(err && err.message) || String(err)}`,
    detail: 'The upgrade executor crashed unexpectedly; the service was restarted as a safety net. See upgrade-executor.log.',
  };
}

/**
 * Pure (exported for tests): argv for the install step of an upgrade.
 *
 * `--beta` is required, not optional. `fetchLatestTag()` in zylos-core filters
 * out every version containing `-` unless `{includePrerelease:true}` is passed,
 * and the fork's versions are all `official-3ai.N` — i.e. prereleases. Discovery
 * here (`auto-upgrade.js`) may therefore find `2.37.1-3ai.2` while the install
 * command below, without `--beta`, resolves nothing and reports "up to date".
 * The run would then fail verification on `marker.to` and burn that version into
 * the failed-version cooldown. Passing `--beta` makes the install step look at
 * the same population of versions that discovery looked at.
 */
function buildUpgradeArgs() {
  return ['upgrade', 'openmax', '--yes', '--beta', '--mode', 'overwrite'];
}

async function main() {
  boundExecutorLog();
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch (e) {
    appendLog(`FATAL: cannot read marker ${markerPath}: ${e.message}`);
    // Nothing to upgrade toward and no marker to update — just make sure the
    // service is alive (no forced restart if it already is) and clean up.
    ensurePm2Running();
    selfDeleteAndExit(1);
    return;
  }

  const guard = evaluateStartGuard(marker, Date.now(), process.pid);
  appendLog(`start guard: ${guard.action} (${guard.reason})`);

  if (guard.action === 'exit-stale') {
    selfDeleteAndExit(0);
    return;
  }
  if (guard.action === 'interrupted') {
    await handleInterrupted(guard.reason);
    return;
  }

  // Claim the run: any relaunch of this pm2 app will now hit the
  // 'interrupted' path instead of re-running the upgrade.
  writeMarker({ executorPid: process.pid });

  appendLog(`starting upgrade: v${marker.from} -> v${marker.to}`);
  appendLog(`zylos bin: ${zylosBin}; skill dir: ${SKILL_DIR}; marker: ${markerPath}`);

  takeSnapshot();

  try {
    const result = execFileSync(zylosBin, buildUpgradeArgs(), {
      timeout: UPGRADE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    appendLog(`zylos upgrade exited successfully:\n${result.toString().slice(-2000)}`);

    const ok = await verifyUpgrade(marker.to);
    if (ok) {
      appendLog('post-upgrade verification passed');
      clearSnapshot('upgrade verified successfully');
      writeMarker({ completed: true, status: 'completed' });
    } else {
      await handleVerificationFailure();
    }
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(0, 1000) : '';
    const stdout = err.stdout ? err.stdout.toString().slice(-500) : '';
    const errMsg = stderr || err.message || 'unknown error';
    appendLog(`upgrade command failed: ${errMsg}`);
    if (stdout) appendLog(`stdout: ${stdout}`);
    // zylos upgrade rolls back its own files and restarts the service when it
    // fails; write the marker first (so the failure DM cannot be swallowed by
    // a later crash), then double-check the service as a second net.
    writeMarker({
      completed: false,
      status: 'failed',
      error: errMsg,
      detail: 'The upgrade command failed; zylos upgrade rolled back to the previous version automatically. The service was restarted.',
    });
    ensurePm2Running();
    clearSnapshot('upgrade command failed; zylos upgrade performed its own rollback');
  }

  appendLog('executor done');
  selfDeleteAndExit(0);
}

// PM2 fork mode starts apps through its own ProcessContainer wrapper, which
// `require()`s the target script — so under pm2, `require.main === module` is
// FALSE here and main() would never run: the upgrader sits "online" doing
// nothing forever (observed on the mechanism's first live run, v2.6.0→v2.7.0).
// Detect the pm2-managed case via the env pm2 injects: `pm_id` is always set,
// and `pm_exec_path` must point at THIS file so a pm2-managed process that
// merely requires this module still gets a side-effect-free import.
function shouldRunMain(requireMainIsModule, env, selfPath) {
  if (requireMainIsModule) return true;
  return env.pm_id !== undefined && env.pm_exec_path === selfPath;
}

module.exports = {
  shouldRunMain,
  evaluateStartGuard,
  buildFatalMarkerUpdate,
  buildUpgradeArgs,
  resolveInterruptedAction,
  replaceDirWithSnapshot,
  verifyUpgrade,
  STALE_RUNNING_THRESHOLD_MS,
  VERIFY_RETRIES,
};

if (shouldRunMain(require.main === module, process.env, __filename)) {
  // Top-level catch: without it an unexpected throw becomes an unhandled
  // rejection — the process would die with no failed marker, no owner
  // notification, and possibly openmax left stopped.
  main().catch(err => {
    appendLog(`FATAL: unhandled executor error: ${(err && err.stack) || err}`);
    try {
      const update = buildFatalMarkerUpdate(err, marker);
      if (update) writeMarker(update); // atomic, stamps ts
    } catch (e) {
      appendLog(`WARN: fatal-path marker write failed: ${e.message}`);
    }
    try {
      ensurePm2Running();
    } catch (e) {
      appendLog(`WARN: fatal-path ensurePm2Running failed: ${e.message}`);
    }
    selfDeleteAndExit(1);
  });
}
