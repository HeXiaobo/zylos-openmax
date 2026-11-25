/**
 * Authenticated reads of the local zylos Dashboard, shared by every periodic
 * reader in the comm-bridge daemon (runtime-metrics, task inventory).
 *
 * Dashboard auth: when zylos-dashboard has password auth enabled, all
 * `/api/*` routes return 401 unless authenticated. The client exchanges a
 * `zylos_ak_...` API key at `POST /api/auth/token` for a short-lived session
 * token (`zylos_st_...`), caches it until expiry (with a safety margin), and
 * attaches it to its Dashboard reads. A 401 from a read triggers one
 * re-exchange + one retry.
 *
 * Key auto-provisioning (zero operator action on upgrade): when the client
 * has no working key — none configured and the dashboard demands auth
 * (a read answers 401), or the exchange itself returns 401 (invalid key) — it
 * self-provisions via the dashboard's local CLI
 * (`api-key.js generate openmax-metrics read`, falling back to
 * `api-key.js rotate openmax-metrics` when the name already exists), parses
 * the `Key: zylos_ak_...` line from stdout, persists it into config.json
 * `metricsReport.dashboardApiKey` (via updateConfig, so the in-memory config
 * stays coherent), and proceeds with the normal exchange in the same read.
 * A manually configured key is always tried first. Auto-provision runs at
 * most ONCE per client (success or fail — no rotate-loops); if the CLI is
 * missing/fails/unparseable, or a provisioned key is still rejected, the
 * client warns once and goes quiet until restart.
 *
 * One client per process: the comm-bridge daemon creates it once and hands it
 * to every reader, so they share one session token and one provision attempt
 * (two clients would each rotate the same `openmax-metrics` key and revoke
 * each other's). A reader created without one gets its own (tests, CLIs).
 *
 * Moved out of metrics-reporter.js unchanged; deps are injected so the logic
 * is unit-testable without a live dashboard (see metrics-reporter.test.js).
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { updateConfig } from './config.js';

const HOME = process.env.HOME;
export const DASHBOARD_FETCH_TIMEOUT_MS = 5000;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

// Dashboard-local API-key CLI (same machine/user — reads/writes the dashboard
// store directly, no HTTP auth involved). Overridable via `apiKeyCliPath` for
// tests / nonstandard layouts.
const DEFAULT_API_KEY_CLI = path.join(HOME, 'zylos/.claude/skills/dashboard/scripts/api-key.js');
const PROVISION_KEY_NAME = 'openmax-metrics';
const KEY_LINE_RE = /^(?:Key|New key): (zylos_ak_\S+)$/m;
const CLI_TIMEOUT_MS = 15_000;

const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args) => promisifiedExecFile(file, args, { timeout: CLI_TIMEOUT_MS });

// Default key persister — writes the provisioned key into openmax's own
// config.json via updateConfig so the in-memory config cache stays coherent.
function persistKeyToConfig(key) {
  updateConfig((cfg) => {
    cfg.metricsReport = cfg.metricsReport || {};
    cfg.metricsReport.dashboardApiKey = key;
  });
}

/**
 * @returns {{
 *   get: (port: number, pathname: string, opts?: {readBody?: boolean}) => Promise<object|null>,
 *   isQuiet: () => boolean,
 * }}
 *   `get` resolves to the Response (or, with `readBody`, a Response-like
 *   `{ok, status, json}` whose body was read inside the deadline), or null
 *   when no token can be had this read (transient exchange failure, or the
 *   unrecoverable auth state that has already warned). Network errors and
 *   timeouts throw. `isQuiet` is true after that unrecoverable auth state.
 */
export function createDashboardClient({
  log,
  warn,
  dashboardApiKey = '',
  fetch = globalThis.fetch,
  now = Date.now,
  execFile = realExecFile,
  fileExists = fs.existsSync,
  persistKey = persistKeyToConfig,
  apiKeyCliPath = DEFAULT_API_KEY_CLI,
  fetchTimeoutMs = DASHBOARD_FETCH_TIMEOUT_MS,
} = {}) {
  let apiKey = dashboardApiKey;       // may be replaced by an auto-provisioned key
  let provisionAttempted = false;     // auto-provision runs at most once per client
  let provisionPromise = null;        // serialize overlapping reads onto one attempt
  let authQuiet = false;              // unrecoverable auth state — warned once, quiet until restart
  let cachedToken = null;             // { token, expiresAtMs }

  // With `readBody`, the body is read inside the same deadline and returned
  // as a Response-like `{ok, status, json}`; otherwise only the response
  // headers are bounded, as before.
  async function fetchWithTimeout(url, opts = {}, { readBody = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (!readBody) return res;
      const text = await res.text();
      return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Exchange the API key for a session token. Returns:
  //   { token }             — success (token cached)
  //   { token: null }       — transient failure, retried next read
  //   { invalidKey: true }  — 401, the key is invalid → auto-provision path
  async function exchangeToken(port) {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { invalidKey: true };
    if (!res.ok) return { token: null };
    const body = await res.json();
    const expiresAtMs = body.ttl_seconds != null
      ? now() + body.ttl_seconds * 1000
      : (body.expires_at ? Date.parse(body.expires_at) : now());
    cachedToken = { token: body.token, expiresAtMs };
    return { token: body.token };
  }

  async function runApiKeyCli(args) {
    const { stdout } = await execFile(process.execPath, [apiKeyCliPath, ...args]);
    return String(stdout);
  }

  // Generate (or rotate, when the name already exists) an API key via the
  // dashboard's local CLI and parse it from stdout. Throws on any failure
  // (CLI missing, non-zero exit, unparseable output).
  async function provisionKey() {
    if (!fileExists(apiKeyCliPath)) {
      throw new Error(`dashboard api-key CLI not found at ${apiKeyCliPath}`);
    }
    let stdout;
    try {
      stdout = await runApiKeyCli(['generate', PROVISION_KEY_NAME, 'read']);
    } catch (err) {
      const errText = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
      if (!/already exists/i.test(errText)) throw err;
      stdout = await runApiKeyCli(['rotate', PROVISION_KEY_NAME]);
    }
    const m = KEY_LINE_RE.exec(stdout);
    if (!m) throw new Error('could not parse api key from CLI output');
    return m[1];
  }

  // Make sure we have an auto-provisioned key to try. At most one provision
  // attempt per client (success or fail); any dead end here warns once and
  // silences the client until restart. Returns true when a fresh key was
  // provisioned and persisted.
  async function ensureProvisionedKey() {
    if (provisionPromise) return provisionPromise;
    if (provisionAttempted) {
      authQuiet = true;
      warn('dashboard api key rejected (401) after auto-provision — '
        + 'runtime-metrics and task inventory not reported until restart');
      return false;
    }
    provisionAttempted = true;
    provisionPromise = (async () => {
      const key = await provisionKey();
      apiKey = key;
      persistKey(key);
      log?.(`dashboard api key auto-provisioned ("${PROVISION_KEY_NAME}") and saved to config`);
      return true;
    })();
    try {
      return await provisionPromise;
    } catch (err) {
      authQuiet = true;
      warn(`dashboard api key auto-provision failed (${err?.message || err}) — `
        + 'metrics reporting needs the dashboard component, or set '
        + 'metricsReport.dashboardApiKey manually; runtime-metrics and task inventory '
        + 'not reported until restart');
      return false;
    } finally {
      provisionPromise = null;
    }
  }

  // Get a session token, auto-provisioning the key when there is none or the
  // current one is rejected. Returns the token string, or null to skip this
  // read (transient exchange failures retry next time; unrecoverable auth
  // states have warned once and set authQuiet).
  async function getToken(port) {
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > now()) {
      return cachedToken.token;
    }
    cachedToken = null;
    if (!apiKey && !(await ensureProvisionedKey())) return null;
    let r = await exchangeToken(port);
    if (r.invalidKey) {
      if (!(await ensureProvisionedKey())) return null;
      r = await exchangeToken(port);
      if (r.invalidKey) {
        // The freshly provisioned key is rejected too — provisionAttempted is
        // already set, so this warns once and goes quiet.
        await ensureProvisionedKey();
        return null;
      }
    }
    return r.token;
  }

  /**
   * GET `pathname` with the current token. A 401 re-exchanges (or provisions)
   * once and retries once. Returns the Response, or null when no token can be
   * had this read (transient exchange failure, or the unrecoverable auth state
   * that has already warned). Network errors and timeouts throw.
   */
  async function dashboardGet(port, pathname, { readBody = false } = {}) {
    const get = (token) => fetchWithTimeout(`http://127.0.0.1:${port}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, { readBody });
    let token = null;
    if (apiKey) {
      token = await getToken(port);
      if (!token) return null;
    }
    let res = await get(token);
    if (res.status === 401) {
      // With a key: session token expired/revoked server-side — re-exchange
      // once. Without one: the dashboard demands auth — auto-provision a key
      // (inside getToken). Either way, retry the read once.
      cachedToken = null;
      token = await getToken(port);
      if (!token) return null;
      res = await get(token);
    }
    return res;
  }

  return { get: dashboardGet, isQuiet: () => authQuiet };
}
