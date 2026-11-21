/**
 * Market client install on explicit request (self-hosted Agents).
 *
 * On each periodic sync, pull the Agent's pending market client request from
 * cws-core: GET /api/v1/agents/{member_id}/market-client. When one is pending,
 * install or upgrade the market client and report the outcome:
 * POST /api/v1/agents/{member_id}/market-client:result.
 *
 * - The component name is a constant; nothing the server sends is used as a
 *   name, ref or command. Only `version` is read, and it must be X.Y.Z.
 * - zylos, market-client and pm2 are run with argv arrays (no shell).
 * - After a successful install, upgrade or up-to-date check, the client service
 *   is started and must come up; otherwise the request is reported failed.
 *   `<zylos dir>/bin/market-client start` is used when the client has it (it
 *   runs post-install, starts the service under pm2, saves the process list
 *   and exits 0 only after a pull from the market). Older clients fall back to
 *   pm2: a running service is left alone, a stopped one is started, and a pid
 *   plus a non-empty client config.json are required.
 * - Crash recovery stays read-only, but reports success only when the version
 *   is at the target, the service has a pid and the client config exists.
 * - Each request id is acted on at most once (persisted before installing, so
 *   it holds across restarts); a failed install is not retried until the
 *   server issues a new request. Only pending requests are acted on, so an
 *   owner uninstall is respected.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

export const MARKET_CLIENT_COMPONENT = 'om-marketplace-client';
export const MARKET_CLIENT_SERVICE = `zylos-${MARKET_CLIENT_COMPONENT}`;

const INSTALL_TIMEOUT_MS = 180_000;
// openmax's own cut-off for `market-client start`, not a bound on start itself:
// start can run longer (up to 300 s per poll round, with retries, plus
// post-install, pm2 and the state lock); past this it is killed and reported
// service_start_timeout. The whole request is also bounded by cws-core: it
// times out 10 minutes after it was created, and openmax may pick it up as
// much as one sync interval (5 minutes) later, so a slow install + start can
// still miss it.
const START_TIMEOUT_MS = 330_000;
const QUERY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const REPORT_RETRY_DELAY_MS = 30_000;
const MAX_REMEMBERED_REQUESTS = 50;

const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches zylos' "is not installed" wording; if that wording changes, an absent
// client is reported probe_failed (never a wrong install).
const NOT_INSTALLED_RE = /is not installed/;

const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args, opts) => promisifiedExecFile(file, args, opts);
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function zylosDir() {
  return process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
}

function defaultStatePath() {
  return path.join(zylosDir(), 'components/openmax/runtime/market-client.json');
}

// Where `zylos add` links component bins (zylos core BIN_DIR). Not looked up on
// PATH: the openmax pm2 environment may not contain it.
function defaultMarketClientBin() {
  return path.join(zylosDir(), 'bin', 'market-client');
}

function defaultEcosystemPath() {
  return path.join(zylosDir(), '.claude/skills', MARKET_CLIENT_COMPONENT, 'ecosystem.config.cjs');
}

// Same path the client reads: OM_MARKETPLACE_CLIENT_HOME, else HOME (not ZYLOS_DIR).
function defaultClientConfigPath() {
  const dataDir = process.env.OM_MARKETPLACE_CLIENT_HOME
    ? path.resolve(process.env.OM_MARKETPLACE_CLIENT_HOME)
    : path.join(process.env.HOME || os.homedir(), 'zylos/components', MARKET_CLIENT_COMPONENT);
  return path.join(dataDir, 'config.json');
}

// A pid alone does not prove the client is configured.
function isNonEmptyFile(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// `market-client help` lists a `start` command (clients that run post-install,
// start the service and verify a pull).
const HELP_START_RE = /^ *start(\s|$)/m;

export function parseStrictSemver(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Reported versions: a leading "v" is stripped, then strict X.Y.Z is required.
export function normaliseVersion(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.startsWith('v') ? value.slice(1) : value;
  return parseStrictSemver(stripped) ? stripped : null;
}

function atLeast(version, target) {
  const a = parseStrictSemver(version);
  const b = parseStrictSemver(target);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

export function fileStore(statePath = defaultStatePath()) {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && isPlainObject(parsed.requests);
        return valid ? parsed : { requests: {} };
      } catch {
        return { requests: {} };
      }
    },
    save(state) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, statePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
      }
    },
  };
}

// Exit status only: zylos output is never logged or reported.
function describeExecError(err) {
  if (err?.killed || err?.signal) return `signal=${err.signal || 'SIGTERM'}`;
  if (err?.code !== undefined) return `exit=${err.code}`;
  return 'spawn failed';
}

export function createMarketClientEnsurer({
  loadConfig,
  getForOrg,
  postForOrg,
  apiPath,
  log = () => {},
  warn = () => {},
  execFile = realExecFile,
  store = fileStore(),
  now = () => Date.now(),
  sleep = realSleep,
  ecosystemPath = defaultEcosystemPath(),
  marketClientBin = defaultMarketClientBin(),
  clientConfigPath = defaultClientConfigPath(),
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  reportRetryDelayMs = REPORT_RETRY_DELAY_MS,
} = {}) {
  const notified404 = new Set();
  let chain = Promise.resolve();

  // { state: 'installed', version } | { state: 'absent' } | { state: 'error' }.
  // version is null when the installed version is not strict X.Y.Z.
  async function probe() {
    let stdout;
    try {
      ({ stdout } = await execFile('zylos', ['info', MARKET_CLIENT_COMPONENT, '--json'], { timeout: queryTimeoutMs }));
    } catch (err) {
      const notInstalled = err?.code === 1 && !err.killed && NOT_INSTALLED_RE.test(String(err.stderr || ''));
      return notInstalled ? { state: 'absent' } : { state: 'error', detail: describeExecError(err) };
    }
    try {
      const info = JSON.parse(String(stdout));
      if (!info || info.name !== MARKET_CLIENT_COMPONENT) return { state: 'error', detail: 'unexpected info' };
      return { state: 'installed', version: normaliseVersion(info.version) };
    } catch {
      return { state: 'error', detail: 'unparseable info' };
    }
  }

  async function hasStartCommand() {
    let out;
    try {
      ({ stdout: out } = await execFile(marketClientBin, ['help'], { timeout: queryTimeoutMs }));
    } catch (err) {
      out = err?.stdout;
    }
    return HELP_START_RE.test(String(out || ''));
  }

  // pm2 pid of the client service, 0 when it is not running or pm2 fails.
  async function servicePid(slug) {
    try {
      const { stdout } = await execFile('pm2', ['pid', MARKET_CLIENT_SERVICE], { timeout: queryTimeoutMs });
      const pid = Number.parseInt(String(stdout).trim(), 10);
      return pid > 0 ? pid : 0;
    } catch (err) {
      warn(`[${slug}] market client: pm2 pid failed (${describeExecError(err)})`);
      return 0;
    }
  }

  // null when the service runs and the client config exists, else a failed result.
  async function checkRunning(slug) {
    if (!(await servicePid(slug))) {
      warn(`[${slug}] market client: service ${MARKET_CLIENT_SERVICE} is not running`);
      return { outcome: 'failed', reason: 'service_not_running' };
    }
    if (!isNonEmptyFile(clientConfigPath)) {
      warn(`[${slug}] market client: client config is missing or empty`);
      return { outcome: 'failed', reason: 'client_not_configured' };
    }
    return null;
  }

  async function runStep(slug, file, args, timeout) {
    log(`[${slug}] market client: ${path.basename(file)} ${args[0]}`);
    try {
      await execFile(file, args, { timeout });
      return null;
    } catch (err) {
      warn(`[${slug}] market client: ${path.basename(file)} ${args[0]} failed (${describeExecError(err)})`);
      return {
        outcome: 'failed',
        reason: err?.killed || err?.signal ? 'service_start_timeout' : 'service_start_failed',
      };
    }
  }

  // Returns null when the service is up, else a failed result.
  async function startService(slug) {
    if (await hasStartCommand()) {
      // Idempotent: a running service with an unchanged config is not restarted.
      return runStep(slug, marketClientBin, ['start'], startTimeoutMs);
    }
    // Older client: a missing config is reported before starting anything, so
    // the reason does not depend on whether the client has exited yet.
    if (!isNonEmptyFile(clientConfigPath)) {
      warn(`[${slug}] market client: client config is missing or empty`);
      return { outcome: 'failed', reason: 'client_not_configured' };
    }
    // Never restart a running service (it may be mid-install).
    if (!(await servicePid(slug))) {
      const failed = await runStep(slug, 'pm2', ['startOrRestart', ecosystemPath], installTimeoutMs)
        || await runStep(slug, 'pm2', ['save'], installTimeoutMs);
      if (failed) return failed;
    }
    return checkRunning(slug);
  }

  async function install(slug, target) {
    const result = await installPackage(slug, target);
    if (result.outcome !== 'succeeded') return result;
    return (await startService(slug)) || result;
  }

  async function installPackage(slug, target) {
    const before = await probe();
    if (before.state === 'error') {
      warn(`[${slug}] market client: zylos info failed (${before.detail})`);
      return { outcome: 'failed', reason: 'probe_failed' };
    }
    if (before.state === 'installed' && atLeast(before.version, target)) {
      return { outcome: 'succeeded', client_version: before.version };
    }
    const upgrading = before.state === 'installed';
    // zylos upgrade cannot pin a version; the result is verified below.
    const args = upgrading
      ? ['upgrade', MARKET_CLIENT_COMPONENT, '--yes']
      : ['add', `${MARKET_CLIENT_COMPONENT}@${target}`, '--yes'];
    log(`[${slug}] market client: zylos ${args[0]} ${args[1]}`);
    try {
      await execFile('zylos', args, { timeout: installTimeoutMs });
    } catch (err) {
      const timedOut = !!(err?.killed || err?.signal);
      warn(`[${slug}] market client: zylos ${args[0]} failed (${describeExecError(err)})`);
      return {
        outcome: 'failed',
        reason: timedOut ? 'install_timeout' : (upgrading ? 'upgrade_failed' : 'install_failed'),
      };
    }
    const after = await probe();
    if (after.state !== 'installed' || !atLeast(after.version, target)) {
      return { outcome: 'failed', reason: 'version_unverified' };
    }
    return { outcome: 'succeeded', client_version: after.version };
  }

  // After a crash mid-install: read-only check, never reinstall or start.
  async function recover(slug, target) {
    if (!parseStrictSemver(target)) return { outcome: 'failed', reason: 'interrupted' };
    const current = await probe();
    if (current.state !== 'installed' || !atLeast(current.version, target)) {
      return { outcome: 'failed', reason: 'interrupted' };
    }
    return (await checkRunning(slug)) || { outcome: 'succeeded', client_version: current.version };
  }

  function remember(state, requestId, entry) {
    state.requests[requestId] = { ...(state.requests[requestId] || {}), ...entry, updated_at: now() };
    const ids = Object.keys(state.requests);
    if (ids.length > MAX_REMEMBERED_REQUESTS) {
      ids.sort((a, b) => (state.requests[a].updated_at || 0) - (state.requests[b].updated_at || 0));
      for (const id of ids.slice(0, ids.length - MAX_REMEMBERED_REQUESTS)) delete state.requests[id];
    }
    store.save(state);
  }

  async function report(orgConfig, memberId, requestId, state, result) {
    const body = { request_id: requestId, outcome: result.outcome };
    if (result.client_version) body.client_version = result.client_version;
    if (result.reason) body.reason = result.reason;
    const send = () => postForOrg(orgConfig.org_id, apiPath(`/agents/${memberId}/market-client:result`), body,
      { timeoutMs: requestTimeoutMs });
    // One quick retry; later syncs re-report. cws-core ignores a report that
    // arrives after its request deadline and keeps its own timeout result.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await send();
        remember(state, requestId, { reported: true });
        log(`[${orgConfig.slug}] market client: reported ${result.outcome} request=${requestId}`);
        return;
      } catch (err) {
        warn(`[${orgConfig.slug}] market client: result report failed request=${requestId} (attempt ${attempt}/2): ${err.message}`);
        if (attempt === 1) await sleep(reportRetryDelayMs);
      }
    }
  }

  async function run(orgConfig) {
    const slug = orgConfig.slug;
    let memberId = orgConfig.self?.member_id;
    if (!memberId) memberId = loadConfig?.().orgs?.[slug]?.self?.member_id || '';
    if (!memberId) return;

    let pending;
    try {
      pending = await getForOrg(orgConfig.org_id, apiPath(`/agents/${memberId}/market-client`), undefined,
        { quietOnSuccess: true, quietStatuses: [404], timeoutMs: requestTimeoutMs });
    } catch (err) {
      if (err?.status === 404) {
        if (!notified404.has(slug)) {
          notified404.add(slug);
          log(`[${slug}] market client request endpoint not available (404), skipping`);
        }
        return;
      }
      throw err;
    }
    notified404.delete(slug);
    if (!pending || pending.required !== true) return;

    const requestId = typeof pending.request_id === 'string' ? pending.request_id : '';
    if (!UUID_RE.test(requestId)) {
      warn(`[${slug}] market client: ignoring request with an invalid request_id`);
      return;
    }

    const state = store.load();
    const seen = state.requests[requestId];
    if (seen) {
      if (seen.reported) return;
      let result = seen.result;
      if (!result) {
        result = await recover(slug, pending.version);
        remember(state, requestId, { result });
      }
      await report(orgConfig, memberId, requestId, state, result);
      return;
    }

    // Persisted before any side effect so a crash cannot cause a second install.
    remember(state, requestId, { org: slug, reported: false });

    let result;
    const version = pending.version;
    if (!parseStrictSemver(version)) {
      warn(`[${slug}] market client: rejected request=${requestId}, version is not X.Y.Z`);
      result = { outcome: 'failed', reason: 'invalid_version' };
    } else {
      result = await install(slug, version);
    }
    remember(state, requestId, { result });
    await report(orgConfig, memberId, requestId, state, result);
  }

  // Serialized: one install at a time across orgs.
  return function ensureMarketClient(orgConfig) {
    const next = chain.then(() => run(orgConfig));
    chain = next.catch(() => {});
    return next;
  };
}
