import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Read the installed Core package, without launching a CLI or caching a version. */
export function readCoreVersion({ env = process.env, io = fs } = {}) {
  const versionAt = root => {
    try {
      const pkg = JSON.parse(io.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return pkg.name === 'zylos' && /^\d+\./.test(pkg.version) ? pkg.version : null;
    } catch { return null; }
  };
  // Match Core's existing explicit override and installation-record precedence.
  if (env.ZYLOS_PACKAGE_ROOT) return versionAt(env.ZYLOS_PACKAGE_ROOT);
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  try {
    const record = JSON.parse(io.readFileSync(path.join(zylosDir, '.claude/skills/comm-bridge/.zylos/core-package.json'), 'utf8'));
    if (record.v === 1 && typeof record.packageRoot === 'string' && path.isAbsolute(record.packageRoot)) {
      const version = versionAt(record.packageRoot);
      if (version) return version;
    }
  } catch { /* Older Core installations may only be discoverable on PATH. */ }
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const executable = path.resolve(directory || '.', 'zylos');
    try {
      if (!io.statSync(executable).isFile()) continue;
      io.accessSync(executable, fs.constants.X_OK);
    } catch { continue; }
    try { return versionAt(path.resolve(path.dirname(io.realpathSync(executable)), '..')); }
    catch { return null; }
  }
  return null;
}

/** The first Core whose Dashboard serves the object APIs (`skills/dashboard/docs/api.md`). */
export const OBJECT_API_MIN_CORE_VERSION = '1.0.0-beta.12';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

// Numeric identifiers without leading zeros: a longer one is larger, equal
// lengths compare as text. Exact for any length, unlike Number().
function compareNumeric(a, b) {
  return a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence of two versions, including the pre-release part
 * (`1.0.0-beta.2` < `1.0.0-beta.12` < `1.0.0`); build metadata is ignored.
 * Returns -1, 0 or 1, or null when either is not a semver version.
 */
export function compareCoreVersions(a, b) {
  const pa = SEMVER.exec(typeof a === 'string' ? a : '');
  const pb = SEMVER.exec(typeof b === 'string' ? b : '');
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const c = compareNumeric(String(BigInt(pa[i])), String(BigInt(pb[i])));
    if (c) return c;
  }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const ia = pa[4].split('.'), ib = pb[4].split('.');
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const na = /^\d+$/.test(ia[i]), nb = /^\d+$/.test(ib[i]);
    const c = na && nb ? compareNumeric(String(BigInt(ia[i])), String(BigInt(ib[i])))
      : na ? -1 : nb ? 1 : ia[i] < ib[i] ? -1 : ia[i] > ib[i] ? 1 : 0;
    if (c) return c;
  }
  return Math.sign(ia.length - ib.length);
}

/** Whether this Core version serves the Dashboard object APIs; unknown or unparsable is false. */
export function coreServesObjectApis(version) {
  const c = compareCoreVersions(version, OBJECT_API_MIN_CORE_VERSION);
  return c !== null && c >= 0;
}
