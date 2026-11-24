/**
 * Tests for the upgrade executor's pure/injectable logic: the start guard,
 * the fatal-crash marker builder, and verification poll boundaries.
 *
 * The executor script is CJS and only runs its main() when executed directly
 * (require.main === module), so importing it here is side-effect free. HOME is
 * pointed at a temp dir during import so every path the module derives
 * (marker, logs) lands in the sandbox.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-executor-test-'));
fs.mkdirSync(path.join(tmpDir, 'zylos/components/openmax/runtime'), { recursive: true });

const originalHome = process.env.HOME;
process.env.HOME = tmpDir;
const executor = (await import('../../scripts/upgrade-executor.cjs')).default;
process.env.HOME = originalHome;

const {
  shouldRunMain,
  evaluateStartGuard,
  buildFatalMarkerUpdate,
  buildUpgradeArgs,
  resolveInterruptedAction,
  replaceDirWithSnapshot,
  verifyUpgrade,
  STALE_RUNNING_THRESHOLD_MS,
} = executor;

const NOW = 500 * 60 * 1000; // arbitrary fixed clock
const MY_PID = 4242;

describe('upgrade-executor start guard (interrupted-run detection)', () => {
  it('missing marker → exit-stale', () => {
    assert.equal(evaluateStartGuard(null, NOW, MY_PID).action, 'exit-stale');
  });

  it('terminal marker → exit-stale (cheap no-op on autorestart relaunch, F12)', () => {
    assert.equal(evaluateStartGuard({ status: 'completed', ts: NOW }, NOW, MY_PID).action, 'exit-stale');
    assert.equal(evaluateStartGuard({ status: 'failed', ts: NOW }, NOW, MY_PID).action, 'exit-stale');
  });

  it('running marker past the stale threshold → exit-stale (never acts on old state)', () => {
    const marker = { status: 'running', ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1) };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'exit-stale');
  });

  it('fresh unclaimed running marker → proceed (the real run)', () => {
    const marker = { status: 'running', ts: NOW - 5000 };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'proceed');
  });

  it('fresh running marker claimed by our own pid → proceed (idempotent re-read)', () => {
    const marker = { status: 'running', ts: NOW - 5000, executorPid: MY_PID };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'proceed');
  });

  it('fresh running marker claimed by a DIFFERENT pid → interrupted, never re-run (F2/F12)', () => {
    const marker = { status: 'running', ts: NOW - 5000, executorPid: MY_PID + 1 };
    const res = evaluateStartGuard(marker, NOW, MY_PID);
    assert.equal(res.action, 'interrupted');
    assert.ok(res.reason.includes(String(MY_PID + 1)));
  });

  it('claimed marker that has gone stale → exit-stale wins over interrupted', () => {
    const marker = {
      status: 'running',
      ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1),
      executorPid: MY_PID + 1,
    };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'exit-stale');
  });
});

describe('buildFatalMarkerUpdate (top-level main().catch marker write)', () => {
  it('running marker → terminal failed update carrying the error message', () => {
    const upd = buildFatalMarkerUpdate(new Error('kaboom'), { status: 'running', from: '1.0.0', to: '1.1.0' });
    assert.equal(upd.status, 'failed');
    assert.equal(upd.completed, false);
    assert.ok(upd.error.includes('kaboom'));
    assert.ok(upd.detail.length > 0);
  });

  it('marker already terminal → null (never overwrite a real outcome)', () => {
    assert.equal(buildFatalMarkerUpdate(new Error('x'), { status: 'completed', completed: true }), null);
    assert.equal(buildFatalMarkerUpdate(new Error('x'), { status: 'failed', error: 'earlier' }), null);
  });

  it('no marker at all → null (nothing to update)', () => {
    assert.equal(buildFatalMarkerUpdate(new Error('x'), null), null);
  });

  it('non-Error throw values are stringified', () => {
    const upd = buildFatalMarkerUpdate('string-throw', { status: 'running' });
    assert.ok(upd.error.includes('string-throw'));
  });
});

describe('verifyUpgrade poll boundaries (injected deps, no real sleeps/pm2)', () => {
  // Scripted poll sequence: each entry is one poll's observed world state.
  // readInstalledVersion is called before getPm2Proc in each poll; the index
  // advances in getPm2Proc.
  function scripted(polls) {
    let i = 0;
    const at = () => polls[Math.min(i, polls.length - 1)];
    return {
      sleep: async () => {},
      readInstalledVersion: () => at().version,
      getPm2Proc: () => {
        const p = at();
        i += 1;
        if (!p.status) return null;
        return { pm2_env: { status: p.status, restart_time: p.restarts ?? 0 } };
      },
    };
  }

  const down = { version: '1.0.0', status: null };
  const healthy = (restarts = 0) => ({ version: '2.0.0', status: 'online', restarts });

  it('first healthy sighting on the FINAL poll gets one extra confirmation poll and passes', async () => {
    const deps = scripted([down, down, healthy(1), healthy(1)]);
    const ok = await verifyUpgrade('2.0.0', 3, deps);
    assert.equal(ok, true, 'healthy-at-deadline service must not be declared failed');
  });

  it('the extra confirmation poll is granted at most once', async () => {
    // Healthy at the final slot, then down again on the single extra poll.
    const deps = scripted([down, down, healthy(1), down, healthy(1), healthy(1)]);
    const ok = await verifyUpgrade('2.0.0', 3, deps);
    assert.equal(ok, false, 'only one extension is allowed');
  });

  it('two consecutive healthy polls with steady restart counter → success', async () => {
    const ok = await verifyUpgrade('2.0.0', 6, scripted([healthy(3), healthy(3)]));
    assert.equal(ok, true);
  });

  it('climbing restart counter between polls → crash-loop failure', async () => {
    const ok = await verifyUpgrade('2.0.0', 6, scripted([healthy(3), healthy(4)]));
    assert.equal(ok, false);
  });

  it('never healthy → failure after the scheduled polls', async () => {
    const ok = await verifyUpgrade('2.0.0', 2, scripted([down, down]));
    assert.equal(ok, false);
  });
});

describe('resolveInterruptedAction (version-aware interrupted recovery)', () => {
  const marker = { from: '1.0.0', to: '2.0.0', status: 'running' };

  it('installed == target → resume-verify, regardless of service/snapshot state', () => {
    for (const serviceOnline of [true, false]) {
      for (const snapshotAvailable of [true, false]) {
        const res = resolveInterruptedAction({ installedVersion: '2.0.0', marker, serviceOnline, snapshotAvailable });
        assert.equal(res.action, 'resume-verify', `online=${serviceOnline}, snapshot=${snapshotAvailable}`);
      }
    }
  });

  it('installed == previous + service down + snapshot → restore (consistency guarantee)', () => {
    const res = resolveInterruptedAction({ installedVersion: '1.0.0', marker, serviceOnline: false, snapshotAvailable: true });
    assert.equal(res.action, 'restore');
  });

  it('installed == previous + service running → fail-keep-old (no disruptive restore)', () => {
    const res = resolveInterruptedAction({ installedVersion: '1.0.0', marker, serviceOnline: true, snapshotAvailable: true });
    assert.equal(res.action, 'fail-keep-old');
  });

  it('installed == previous + no snapshot → fail-keep-old', () => {
    const res = resolveInterruptedAction({ installedVersion: '1.0.0', marker, serviceOnline: false, snapshotAvailable: false });
    assert.equal(res.action, 'fail-keep-old');
  });

  it('unknown installed version → fail-preserve-snapshot (never destroy the rollback path)', () => {
    const res = resolveInterruptedAction({ installedVersion: '9.9.9', marker, serviceOnline: true, snapshotAvailable: true });
    assert.equal(res.action, 'fail-preserve-snapshot');
  });

  it('unreadable installed version → fail-preserve-snapshot', () => {
    const res = resolveInterruptedAction({ installedVersion: null, marker, serviceOnline: false, snapshotAvailable: true });
    assert.equal(res.action, 'fail-preserve-snapshot');
  });
});

describe('replaceDirWithSnapshot (restore replaces, never merges)', () => {
  function makeDirs(name) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `restore-test-${name}-`));
    const snapshot = path.join(base, 'snapshot');
    const target = path.join(base, 'target');
    fs.mkdirSync(snapshot, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    return { base, snapshot, target };
  }
  const noopLog = () => {};

  it('removes files added by the failed new version and restores old contents', () => {
    const { snapshot, target } = makeDirs('replace');
    // Snapshot = old version.
    fs.writeFileSync(path.join(snapshot, 'package.json'), '{"version":"1.0.0"}');
    fs.mkdirSync(path.join(snapshot, 'src'));
    fs.writeFileSync(path.join(snapshot, 'src/old.js'), 'old');
    // Target = broken new version: modified file + files ADDED by the upgrade.
    fs.writeFileSync(path.join(target, 'package.json'), '{"version":"2.0.0"}');
    fs.mkdirSync(path.join(target, 'src'));
    fs.writeFileSync(path.join(target, 'src/old.js'), 'new-modified');
    fs.writeFileSync(path.join(target, 'src/added-by-new.js'), 'leftover');
    fs.writeFileSync(path.join(target, '.new-dotfile'), 'leftover');
    // Preserved entries must survive.
    fs.mkdirSync(path.join(target, '.backup/2026'), { recursive: true });
    fs.writeFileSync(path.join(target, '.backup/2026/keep.txt'), 'keep');

    const ok = replaceDirWithSnapshot(snapshot, target, new Set(['.backup', '.git', '.zylos']), noopLog);
    assert.equal(ok, true);
    assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf-8'), '{"version":"1.0.0"}');
    assert.equal(fs.readFileSync(path.join(target, 'src/old.js'), 'utf-8'), 'old');
    assert.ok(!fs.existsSync(path.join(target, 'src/added-by-new.js')), 'added file must be gone (no merge)');
    assert.ok(!fs.existsSync(path.join(target, '.new-dotfile')), 'added dotfile must be gone');
    assert.equal(fs.readFileSync(path.join(target, '.backup/2026/keep.txt'), 'utf-8'), 'keep', '.backup must be preserved');
    assert.ok(!fs.existsSync(`${target}.restore-tmp`), 'stage dir must be cleaned up');
  });

  it('staging failure leaves the target completely untouched', () => {
    const { base, target } = makeDirs('stage-fail');
    fs.writeFileSync(path.join(target, 'package.json'), '{"version":"2.0.0"}');
    fs.writeFileSync(path.join(target, 'added.js'), 'still-here');

    const missingSnapshot = path.join(base, 'no-such-snapshot');
    const ok = replaceDirWithSnapshot(missingSnapshot, target, new Set(), noopLog);
    assert.equal(ok, false);
    assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf-8'), '{"version":"2.0.0"}');
    assert.ok(fs.existsSync(path.join(target, 'added.js')), 'target untouched on staging failure');
    assert.ok(!fs.existsSync(`${target}.restore-tmp`), 'no stage dir left behind');
  });
});

describe('shouldRunMain (pm2 fork-mode entry gate)', () => {
  const SELF = '/skills/openmax/scripts/upgrade-executor.cjs';

  it('direct CLI execution (require.main === module) runs', () => {
    assert.equal(shouldRunMain(true, {}, SELF), true);
  });

  it('plain import (tests) does NOT run', () => {
    assert.equal(shouldRunMain(false, {}, SELF), false);
  });

  it('pm2 fork mode (wrapper requires the script) RUNS: pm_id set + pm_exec_path is this file', () => {
    assert.equal(shouldRunMain(false, { pm_id: '7', pm_exec_path: SELF }, SELF), true);
  });

  it('pm2-managed process that merely imports this module does NOT run (pm_exec_path is another file)', () => {
    assert.equal(shouldRunMain(false, { pm_id: '3', pm_exec_path: '/other/service.js' }, SELF), false);
  });

  it('pm_exec_path matching but no pm_id (not pm2) does NOT run', () => {
    assert.equal(shouldRunMain(false, { pm_exec_path: SELF }, SELF), false);
  });
});

// The fork's versions are all prereleases (`official-3ai.N`), and zylos-core's
// fetchLatestTag() drops every `-` version unless includePrerelease is set. So
// discovery (auto-upgrade.js) can find 2.37.1-3ai.2 while an install step
// without --beta sees nothing, reports "up to date", and fails the subsequent
// verifyUpgrade(marker.to) — burning that tag into the failed-version cooldown.
describe('upgrade-executor install argv', () => {
  it('passes --beta so the install step sees the same prerelease versions discovery found', () => {
    const args = buildUpgradeArgs();
    assert.ok(args.includes('--beta'), `argv must include --beta, got ${JSON.stringify(args)}`);
  });

  it('still targets openmax non-interactively with overwrite mode', () => {
    const args = buildUpgradeArgs();
    assert.equal(args[0], 'upgrade');
    assert.equal(args[1], 'openmax');
    assert.ok(args.includes('--yes'));
    assert.equal(args[args.indexOf('--mode') + 1], 'overwrite');
  });

  it('keeps --beta and --branch mutually exclusive (never passes --branch)', () => {
    const args = buildUpgradeArgs();
    assert.ok(!args.includes('--branch'), 'CLI rejects --beta together with --branch');
  });
});
