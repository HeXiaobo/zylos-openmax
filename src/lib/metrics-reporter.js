/**
 * Runtime-metrics reporter — reads the local zylos-dashboard state and PUTs
 * it to cws-core (`PUT /api/v1/agents/{member_id}/runtime-metrics`) on a
 * periodic tick driven by src/comm-bridge.js.
 *
 * Dashboard auth: when zylos-dashboard has password auth enabled, all
 * `/api/*` routes return 401 unless authenticated. The reporter exchanges a
 * `zylos_ak_...` API key at `POST /api/auth/token` for a short-lived session
 * token (`zylos_st_...`), caches it until expiry (with a safety margin), and
 * attaches it to `/api/state`. A 401 from `/api/state` triggers one
 * re-exchange + one retry.
 *
 * Key auto-provisioning (zero operator action on upgrade): when the reporter
 * has no working key — none configured and the dashboard demands auth
 * (`/api/state` 401), or the exchange itself returns 401 (invalid key) — it
 * self-provisions via the dashboard's local CLI
 * (`api-key.js generate openmax-metrics read`, falling back to
 * `api-key.js rotate openmax-metrics` when the name already exists), parses
 * the `Key: zylos_ak_...` line from stdout, persists it into config.json
 * `metricsReport.dashboardApiKey` (via updateConfig, so the in-memory config
 * stays coherent), and proceeds with the normal exchange in the same tick.
 * A manually configured key is always tried first. Auto-provision runs at
 * most ONCE per process (success or fail — no rotate-loops); if the CLI is
 * missing/fails/unparseable, or a provisioned key is still rejected, the
 * reporter warns once and goes quiet until restart.
 *
 * Failures are never silent: an unavailable dashboard state is warned once
 * (same once-guard style as the runtime-metrics 404 skip), and a later
 * successful fetch re-arms the warning.
 *
 * Deps are injected so the logic is unit-testable without the comm-bridge
 * daemon or a live dashboard (see metrics-reporter.test.js).
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { updateConfig } from './config.js';
import { createCgroupCollector } from './cgroup-resources.js';
import { getDashboardPort } from './dashboard-address.js';
import { readinessReport } from './agent-readiness.js';

// Shared service adapter: resolve the gate before projecting its four fields.
export function createMetricsReadinessEvaluator(gate, isDisabled) {
  return async () => (isDisabled() ? null : readinessReport(await gate.evaluate()));
}

const HOME = process.env.HOME;
const FETCH_TIMEOUT_MS = 5000;

// Deadline for each report PUT to cws-core (runtime-metrics here, and
// channel-liveness). Native fetch has none: with the network down, a PUT whose
// connection is never answered held its tick for minutes, and the task
// registry skipped every tick that came due meanwhile. 20s, the same bound as
// the connect-result POST, is far beyond a healthy round-trip and well inside
// the 60s default interval. A timeout is an ordinary failed report; the next
// tick reports again.
export const REPORT_REQUEST_TIMEOUT_MS = 20_000;

// openmax's own package version, read once at module load (not per tick). Same
// pattern as auto-upgrade.js readPkgVersion(). Reported as a top-level `version`
// field in the runtime-metrics payload (a downstream service reads body.version).
const PKG_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

// Dashboard-local API-key CLI (same machine/user — reads/writes the dashboard
// store directly, no HTTP auth involved). Overridable via the factory's
// `apiKeyCliPath` for tests / nonstandard layouts.
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
 * Resolve the PRIMARY org to self-report under: the first entry of the
 * insertion-ordered `activeOrgConfigs` Map (the first enabled org). Returns
 * `{ slug, orgConfig, selfMemberId }` (selfMemberId may be undefined when the
 * primary org has no `self.member_id`), or `null` when no org is active. The
 * caller decides how to warn on each dead end, so its message text can name
 * the specific report (runtime-metrics / channel-liveness). Shared so every
 * periodic self-report targets the exact same org/member.
 */
export function selectPrimaryOrg(activeOrgConfigs) {
  const [primary] = activeOrgConfigs;
  if (!primary) return null;
  const [slug, orgConfig] = primary;
  return { slug, orgConfig, selfMemberId: orgConfig.self?.member_id };
}

// NOTE: `installed_channels` reporting was removed. In the connect/disconnect
// redesign, channel-binding status is driven by the connector's connect-result
// callback, not by reconciling a periodic installed-channels report. This
// reporter now carries only runtime metrics (version / resources / cost).

// Resource sourcing depends on whether we're in a container:
//   - In a cgroup (containerized): CPU and memory come from the cgroup
//     collector (`cg`), NOT the dashboard — the dashboard's os.cpus()/
//     os.totalmem() figures are node-level and don't reflect this container's
//     quota (see cgroup-resources.js). Disk stays from the dashboard (its
//     statfs on the volume mount is already the correct container scope).
//   - Not in a cgroup (external / non-containerized agent, cgroup_version
//     "none"): there is no container quota to read, so fall back to ALL
//     metrics from the dashboard — node-level numbers are the best available
//     and beat reporting null. (Gavin's call, 2026-07-15.)
function buildPayload(dashboard, cg, readiness) {
  if (!dashboard) return null;
  const sys = dashboard.system_metrics || {};
  const rt = dashboard.runtime_info || {};
  const containerized = cg.cgroup_version !== 'none';
  return {
    version: PKG_VERSION,
    resources: {
      cpu_pct:   containerized ? (cg.cpu_pct ?? null) : (sys.cpu_pct ?? null),
      mem_pct:   containerized ? (cg.mem_pct ?? null) : (sys.mem_pct ?? null),
      mem_total_bytes: containerized ? (cg.mem_total_bytes ?? null) : (sys.mem_total_bytes ?? null),
      mem_used_bytes:  containerized ? (cg.mem_used_bytes ?? null) : (sys.mem_used_bytes ?? null),
      disk_pct:        sys.disk_pct ?? null,
      disk_free_bytes: sys.disk_free_bytes ?? null,
    },
    runtime: {
      state:       dashboard.state ?? 'UNKNOWN',
      model_id:    rt.model_id ?? null,
      model:       rt.model ?? null,
      context_pct: dashboard.context_pct ?? null,
      effort:      rt.effort ?? null,
    },
    cost: {
      session: dashboard.session_cost ?? null,
      daily:   dashboard.daily_cost ?? null,
      weekly:  dashboard.weekly_cost ?? null,
    },
    rate_limit_pct: dashboard.rate_limit_pct ?? null,
    // Provisioning readiness, as judged by the readiness gate — the platform's
    // chat gate reads this instead of inferring from `runtime.state`.
    //
    // `runtime.state` above is deliberately left untouched: it is still the
    // live execution state, still reported every tick, and a platform that has
    // not learned about this field keeps working exactly as before. Omitted
    // entirely when no verdict is available, so "absent" stays distinguishable
    // from "not ready" on the receiving end.
    ...(readiness ? { readiness } : {}),
  };
}

export function createMetricsReporter(activeOrgConfigs, {
  log,
  warn,
  dashboardApiKey = '',
  // Readiness verdict source. Injected rather than imported so this reporter
  // stays testable without an activity monitor, and so a deployment with the
  // gate disabled simply omits the field instead of reporting a fabricated one.
  evaluateReadiness = () => null,
  fetch = globalThis.fetch,
  now = Date.now,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  execFile = realExecFile,
  fileExists = fs.existsSync,
  persistKey = persistKeyToConfig,
  apiKeyCliPath = DEFAULT_API_KEY_CLI,
  cgroup = createCgroupCollector(),
  requestTimeoutMs = REPORT_REQUEST_TIMEOUT_MS,
} = {}) {
  let warnedEndpoint404 = false;     // cws-core runtime-metrics endpoint missing
  let warnedStateUnavailable = false; // dashboard state fetch failing — re-armed on success
  let apiKey = dashboardApiKey;       // may be replaced by an auto-provisioned key
  let provisionAttempted = false;     // auto-provision runs at most once per process
  let provisionPromise = null;        // serialize overlapping ticks onto one attempt
  let authQuiet = false;              // unrecoverable auth state — warned once, quiet until restart
  let cachedToken = null;             // { token, expiresAtMs }
  let loggedCgroupFallback = false;   // logged once when cgroup is absent (non-containerized)

  async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Exchange the API key for a session token. Returns:
  //   { token }             — success (token cached)
  //   { token: null }       — transient failure, retried next tick
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
  // attempt per process (success or fail); any dead end here warns once and
  // silences the reporter until restart. Returns true when a fresh key was
  // provisioned and persisted.
  async function ensureProvisionedKey() {
    if (provisionPromise) return provisionPromise;
    if (provisionAttempted) {
      authQuiet = true;
      warn('dashboard api key rejected (401) after auto-provision — '
        + 'runtime-metrics not reported until restart');
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
        + 'metricsReport.dashboardApiKey manually; runtime-metrics not reported until restart');
      return false;
    } finally {
      provisionPromise = null;
    }
  }

  // Get a session token, auto-provisioning the key when there is none or the
  // current one is rejected. Returns the token string, or null to skip this
  // tick (transient exchange failures retry next tick; unrecoverable auth
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

  function fetchState(port, token) {
    return fetchWithTimeout(`http://127.0.0.1:${port}/api/state`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  function warnStateUnavailable(reason) {
    if (warnedStateUnavailable) return;
    warnedStateUnavailable = true;
    warn(`dashboard state unavailable (${reason}) — runtime-metrics not reported; `
      + 'set metricsReport.dashboardApiKey if the dashboard has auth enabled');
  }

  async function fetchDashboardState() {
    if (authQuiet) return null; // warned once at the dead end — stay quiet
    const port = getDashboardPort();
    try {
      let token = null;
      if (apiKey) {
        token = await getToken(port);
        if (!token) return null;
      }
      let res = await fetchState(port, token);
      if (res.status === 401) {
        // With a key: session token expired/revoked server-side — re-exchange
        // once. Without one: the dashboard demands auth — auto-provision a key
        // (inside getToken). Either way, retry the state fetch once.
        cachedToken = null;
        token = await getToken(port);
        if (!token) return null;
        res = await fetchState(port, token);
      }
      if (!res.ok) {
        warnStateUnavailable(`http ${res.status}`);
        return null;
      }
      const state = await res.json();
      warnedStateUnavailable = false; // recovered — re-arm the once-guard
      return state;
    } catch (err) {
      warnStateUnavailable(err?.message || 'fetch failed');
      return null;
    }
  }

  return async function reportMetrics() {
    // Sample CPU every tick — cumulative usage_usec needs a differential window,
    // and sampling unconditionally (before the dashboard fetch, which can fail)
    // keeps the window evenly spaced across dashboard outages.
    cgroup.sample();
    const dashboard = await fetchDashboardState();
    if (!dashboard) return;
    const cg = cgroup.read();
    if (cg.cgroup_version === 'none' && !loggedCgroupFallback) {
      loggedCgroupFallback = true;
      log?.('cgroup unavailable (non-containerized agent) — reporting node-level CPU/memory from dashboard');
    }
    const payload = buildPayload(dashboard, cg, await evaluateReadiness());
    if (!payload) return;

    // Report to the PRIMARY org only (the first enabled org, i.e. the first
    // entry of the insertion-ordered Map) — a single PUT, not one per org.
    const primary = selectPrimaryOrg(activeOrgConfigs);
    if (!primary) {
      warn('no active org configured — runtime-metrics not reported');
      return;
    }
    const { slug, orgConfig, selfMemberId } = primary;
    if (!selfMemberId) {
      warn(`[${slug}] primary org has no self.member_id — runtime-metrics not reported`);
      return;
    }
    try {
      await putForOrg(orgConfig.org_id, apiPath(`/agents/${selfMemberId}/runtime-metrics`), payload, {
        timeoutMs: requestTimeoutMs,
        quietOnSuccess: true,
      });
    } catch (err) {
      if (err.status === 404) {
        if (!warnedEndpoint404) {
          warn(`[${slug}] runtime-metrics endpoint not available (404), skipping`);
          warnedEndpoint404 = true;
        }
      } else {
        warn(`[${slug}] metrics report failed: ${err.message}`);
      }
    }
  };
}
