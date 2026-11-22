import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureOpenmaxKb, ensureOpenmaxProductFaq, isInstalled, probeCloned, zylosDir,
  FAQ_NAME, FAQ_REPO, LEGACY_NAME, TIMEOUT_MS,
} from './ensure-openmax-kb.js';

const ADD = ['add', FAQ_REPO, '--yes'];
const UPGRADE = ['upgrade', FAQ_NAME, '--yes'];
const UNINSTALL = ['uninstall', LEGACY_NAME, '--purge', '--yes'];

// Stateful fake registry: `reg` is the set of registered names, `cloned` the set of
// names with repo/.git present. runImpl may mutate both to simulate zylos side effects.
function harness({ region = '', reg = [], cloned = [], runImpl } = {}) {
  const logs = [], warns = [], errors = [], runs = [];
  const state = { reg: new Set(reg), cloned: new Set(cloned) };
  const deps = {
    env: { DEPLOY_REGION: region },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    installed: (n) => state.reg.has(n),
    probe: (n) => state.cloned.has(n),
    run: (args) => { runs.push(args); if (runImpl) runImpl(args, state); },
  };
  return { deps, state, logs, warns, errors, runs };
}

// Default "zylos works" simulation.
function okZylos(args, state) {
  if (args[0] === 'add') { state.reg.add(FAQ_NAME); state.cloned.add(FAQ_NAME); }
  if (args[0] === 'uninstall') { state.reg.delete(args[1]); state.cloned.delete(args[1]); }
}

test('constants: TIMEOUT_MS is 60s, names/repo as planned', () => {
  assert.equal(TIMEOUT_MS, 60000);
  assert.equal(FAQ_REPO, 'openmaxai/zylos-openmax-product-faq');
  assert.equal(FAQ_NAME, 'openmax-product-faq');
  assert.equal(LEGACY_NAME, 'openmax-kb');
  assert.equal(ensureOpenmaxProductFaq, ensureOpenmaxKb);
});

test('① only legacy → add faq (latest, no pin) → ok → uninstall openmax-kb --purge --yes', () => {
  const h = harness({ reg: [LEGACY_NAME], cloned: [LEGACY_NAME], runImpl: okZylos });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [ADD, UNINSTALL]);
  assert.ok(!h.state.reg.has(LEGACY_NAME));
  assert.equal(h.warns.length, 0);
  assert.equal(h.errors.length, 0);
});

test('② both installed → upgrade faq → purge legacy', () => {
  const h = harness({ reg: [FAQ_NAME, LEGACY_NAME], cloned: [FAQ_NAME, LEGACY_NAME], runImpl: okZylos });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [UPGRADE, UNINSTALL]);
});

test('③a faq add fails (not registered) → no uninstall, warn retry', () => {
  const h = harness({ reg: [LEGACY_NAME], cloned: [LEGACY_NAME], runImpl: (a) => { if (a[0] === 'add') throw new Error('boom'); } });
  assert.doesNotThrow(() => ensureOpenmaxKb(h.deps));
  assert.deepEqual(h.runs, [ADD]);
  assert.match(h.errors.join('\n'), /install failed \(non-fatal/);
  assert.match(h.warns.join('\n'), /not installed \(install did not complete; will retry on next run\)/);
  assert.match(h.warns.join('\n'), /keeping openmax-kb/);
});

test('③b faq add "succeeds" but empty shell (registered, no repo/.git) → no uninstall, warn', () => {
  const h = harness({ reg: [LEGACY_NAME], runImpl: (a, s) => { if (a[0] === 'add') s.reg.add(FAQ_NAME); } });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [ADD]);
  assert.match(h.warns.join('\n'), /registered but repo\/\.git missing — empty shell/);
  assert.ok(h.state.reg.has(LEGACY_NAME));
});

test('③c faq upgrade fails and faq is an empty shell → no uninstall', () => {
  const h = harness({ reg: [FAQ_NAME, LEGACY_NAME], cloned: [LEGACY_NAME], runImpl: (a) => { if (a[0] === 'upgrade') throw new Error('nope'); } });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [UPGRADE]);
  assert.match(h.errors.join('\n'), /upgrade failed \(non-fatal/);
  assert.match(h.warns.join('\n'), /empty shell/);
});

test('upgrade throws but faq is still ok → still purges legacy (gate is ok(faq), not exit code)', () => {
  const h = harness({
    reg: [FAQ_NAME, LEGACY_NAME], cloned: [FAQ_NAME, LEGACY_NAME],
    runImpl: (a, s) => { if (a[0] === 'upgrade') throw new Error('upgrade exit 1'); okZylos(a, s); },
  });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [UPGRADE, UNINSTALL]);
  assert.match(h.errors.join('\n'), /upgrade failed/);
});

test('④ DEPLOY_REGION=cn short-circuits (no zylos call)', () => {
  const h = harness({ region: 'CN', reg: [LEGACY_NAME] });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 0);
  assert.match(h.logs.join('\n'), /DEPLOY_REGION=cn — skip/);
});

test('⑤ nested 60s timeout kill (ETIMEDOUT + e.stderr) does not throw and surfaces stderr', () => {
  const h = harness({
    reg: [LEGACY_NAME], cloned: [LEGACY_NAME],
    runImpl: () => { const e = new Error('spawnSync zylos ETIMEDOUT'); e.code = 'ETIMEDOUT'; e.signal = 'SIGKILL'; e.stderr = 'CHILD-STDERR-BEFORE-HANG'; throw e; },
  });
  assert.doesNotThrow(() => ensureOpenmaxKb(h.deps));
  assert.deepEqual(h.runs, [ADD]);
  assert.match(h.errors.join('\n'), /ETIMEDOUT/);
  assert.match(h.errors.join('\n'), /stderr: .*CHILD-STDERR-BEFORE-HANG/);
});

test('⑥ only faq → only upgrade, no uninstall', () => {
  const h = harness({ reg: [FAQ_NAME], cloned: [FAQ_NAME], runImpl: okZylos });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [UPGRADE]);
  assert.equal(h.warns.length, 0);
});

test('neither installed → add faq only', () => {
  const h = harness({ runImpl: okZylos });
  ensureOpenmaxKb(h.deps);
  assert.deepEqual(h.runs, [ADD]);
});

test('uninstall failure is non-fatal (warn, retry next run)', () => {
  const h = harness({
    reg: [FAQ_NAME, LEGACY_NAME], cloned: [FAQ_NAME],
    runImpl: (a) => { if (a[0] === 'uninstall') { const e = new Error('locked'); e.stderr = 'LOCK-HELD'; throw e; } },
  });
  assert.doesNotThrow(() => ensureOpenmaxKb(h.deps));
  assert.deepEqual(h.runs, [UPGRADE, UNINSTALL]);
  assert.match(h.warns.join('\n'), /openmax-kb uninstall failed \(non-fatal; will retry on next run\).*LOCK-HELD/);
});

test('helper that throws unexpectedly is still non-fatal', () => {
  const h = harness();
  h.deps.installed = () => { throw new Error('weird'); };
  assert.doesNotThrow(() => ensureOpenmaxKb(h.deps));
  assert.match(h.errors.join('\n'), /ensure failed unexpectedly/);
});

test('isInstalled / probeCloned honor ZYLOS_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-faq-'));
  const prev = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  try {
    assert.equal(zylosDir(), dir);
    fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zylos/components.json'), JSON.stringify({ [FAQ_NAME]: { version: '0.2.0' } }));
    assert.equal(isInstalled(FAQ_NAME), true);
    assert.equal(isInstalled(LEGACY_NAME), false);
    const repo = path.join(dir, 'components', FAQ_NAME, 'repo');
    assert.equal(probeCloned(FAQ_NAME), false);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'x');
    assert.equal(probeCloned(FAQ_NAME), true);
  } finally {
    if (prev === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
