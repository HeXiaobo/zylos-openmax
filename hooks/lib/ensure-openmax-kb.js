/**
 * ensure-openmax-kb.js — ensure the openmax-product-faq companion component and
 * migrate agents off the legacy openmax-kb component.
 *
 * Invoked at the end of openmax's post-install (on install) and post-upgrade
 * (on upgrade) hooks so every agent that has openmax also gets the product
 * FAQ skill by default. Idempotent, non-fatal, time-bounded.
 *
 * Behavior (strict order):
 *   DEPLOY_REGION=cn            → skip (GitHub unreachable; cn content source is out of scope)
 *   (1) faq installed           → `zylos upgrade openmax-product-faq --yes`
 *       faq not installed       → `zylos add openmaxai/zylos-openmax-product-faq --yes` (latest)
 *   (2) ok(faq) && legacy installed
 *                               → `zylos uninstall openmax-kb --purge --yes`
 *                                 (removes skill dir + data dir + registry entry)
 *       !ok(faq)                → keep openmax-kb, warn; retried on the next openmax install/upgrade
 *
 * ok(faq) = registered in components.json AND <ZYLOS_DIR>/components/openmax-product-faq/repo/.git
 * exists. The gate for step (2) is ok(faq), NOT the exit code of step (1): an upgrade that
 * fails while a good prior install is still present still lets the legacy purge proceed.
 *
 * Every failure is non-fatal (warns, never throws) so a companion hiccup never blocks
 * the openmax install/upgrade. Each nested zylos call is bounded by a 60s timeout +
 * SIGKILL so a hung git clone cannot stall the upgrade or hold the component lock.
 *
 * Known risk: zylos-core getLatestVersion falls back to the version on the repo's main
 * branch when the GitHub tag fetch fails (e.g. rate limit), so an un-pinned add/upgrade
 * may install main. Mitigated by keeping the faq repo's main always releasable.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const FAQ_REPO    = 'openmaxai/zylos-openmax-product-faq';
export const FAQ_NAME    = 'openmax-product-faq';
export const LEGACY_NAME = 'openmax-kb';
export const TIMEOUT_MS  = 60000;

// zylos CLI is a sibling of node (the hook is launched via spawnSync(process.execPath));
// it lives with node in the npm-global bin, NOT under ~/zylos/bin. Fall back to bare name.
export function zylosBin() {
  const sib = path.join(path.dirname(process.execPath), 'zylos');
  return fs.existsSync(sib) ? sib : 'zylos';
}

export function zylosDir(env = process.env) {
  return env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
}

// Nested zylos call: bounded (60s + SIGKILL) and self-contained stdio.
// Explicit ['ignore','pipe','pipe'] keeps BOTH stdout and stderr in our own buffer;
// execFileSync would otherwise forward stderr to the parent (→ floods the outer 1MB pipe).
export function runZylos(args) {
  execFileSync(zylosBin(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Is <name> registered in components.json? (no network). components.json is a dict
// keyed by component name.
export function isInstalled(name) {
  try {
    const reg = path.join(zylosDir(), '.zylos/components.json');
    const installed = JSON.parse(fs.readFileSync(reg, 'utf8'));
    return Object.prototype.hasOwnProperty.call(installed, name);
  } catch (e) {
    console.warn(`[openmax] components.json read failed, treating ${name} as not installed: ${e.message}`);
    return false;
  }
}

// Empty-shell probe: the component clones content into DATA_DIR/repo. Check repo/.git —
// NOT DATA_DIR itself (which always holds a config.json written before the clone).
// Pure local readdir: bounded, no network, cannot hang.
export function probeCloned(name) {
  const repoDir = path.join(zylosDir(), 'components', name, 'repo');
  try {
    return fs.existsSync(path.join(repoDir, '.git')) && fs.readdirSync(repoDir).length > 1;
  } catch {
    return false;
  }
}

function errDetail(e) {
  // On the timeout path, stderr lands on e.stderr (NOT e.message) — surface it so a
  // hung clone-vs-npm is diagnosable.
  const extra = e && e.stderr ? ' | stderr: ' + String(e.stderr).slice(-500) : '';
  return `${e && e.message}${extra}`;
}

/**
 * Ensure openmax-product-faq is present (latest) and purge the legacy openmax-kb once the
 * new component is confirmed installed. Production hooks call ensureOpenmaxKb().
 * The optional deps object exists only so unit tests can inject fakes.
 */
export function ensureOpenmaxKb(deps = {}) {
  const {
    env = process.env,
    log = console.log,
    warn = console.warn,
    error = console.error,
    installed = isInstalled,
    probe = probeCloned,
    run = runZylos,
  } = deps;

  // region short-circuit: cn cannot reach GitHub → would only produce an empty shell.
  if ((env.DEPLOY_REGION || '').toLowerCase() === 'cn') {
    log(`[openmax] DEPLOY_REGION=cn — skip ${FAQ_NAME} (content source handled separately)`);
    return;
  }

  try {
    // (1) Ensure the faq component is installed at the latest release.
    const hadFaq = installed(FAQ_NAME);
    const action = hadFaq ? 'upgrade' : 'install';
    try {
      if (hadFaq) {
        log(`[openmax] upgrading ${FAQ_NAME} …`);
        run(['upgrade', FAQ_NAME, '--yes']);
      } else {
        log(`[openmax] installing ${FAQ_REPO} …`);
        run(['add', FAQ_REPO, '--yes']);
      }
    } catch (e) {
      error(`[openmax] ⚠ ${FAQ_NAME} ${action} failed (non-fatal, openmax not blocked): ${errDetail(e)}`);
    }

    // (2) Gate on ok(faq), not on the exit code of step (1).
    const faqRegistered = installed(FAQ_NAME);
    const faqOk = faqRegistered && probe(FAQ_NAME);
    const hasLegacy = installed(LEGACY_NAME);

    if (!faqOk) {
      if (faqRegistered) warn(`[openmax] ⚠ ${FAQ_NAME} registered but repo/.git missing — empty shell (non-fatal, needs attention)`);
      else warn(`[openmax] ⚠ ${FAQ_NAME} not installed (${action} did not complete; will retry on next run)`);
      if (hasLegacy) warn(`[openmax] keeping ${LEGACY_NAME} until ${FAQ_NAME} is confirmed installed`);
      return;
    }

    log(`[openmax] ✓ ${FAQ_NAME} installed`);
    if (!hasLegacy) return;

    try {
      log(`[openmax] removing legacy ${LEGACY_NAME} (replaced by ${FAQ_NAME}) …`);
      run(['uninstall', LEGACY_NAME, '--purge', '--yes']);
      log(`[openmax] ✓ ${LEGACY_NAME} uninstalled (purged)`);
    } catch (e) {
      warn(`[openmax] ⚠ ${LEGACY_NAME} uninstall failed (non-fatal; will retry on next run): ${errDetail(e)}`);
    }
  } catch (e) {
    // Defensive: injected/probe helpers should never throw, but never let this block openmax.
    error(`[openmax] ⚠ ${FAQ_NAME} ensure failed unexpectedly (non-fatal): ${errDetail(e)}`);
  }
}

// Clearer alias for the new behavior; ensureOpenmaxKb stays the name callers import.
export const ensureOpenmaxProductFaq = ensureOpenmaxKb;
