/**
 * Runtime-metrics reporter — reads the local zylos-dashboard state and PUTs
 * it to cws-core (`PUT /api/v1/agents/{member_id}/runtime-metrics`) on a
 * periodic tick driven by src/comm-bridge.js.
 *
 * Dashboard reads go through the shared Dashboard client (dashboard-client.js:
 * zylos_ak → zylos_st session exchange, one re-exchange + retry on 401, key
 * auto-provisioning). The comm-bridge daemon passes its one process-wide
 * client as `dashboardClient`; without one the reporter builds its own from
 * the same deps as before (fetch, now, execFile, fileExists, persistKey,
 * apiKeyCliPath, dashboardApiKey).
 *
 * What is read depends on the installed Core version (core-version.js), read
 * before any request on every tick:
 *   - Core 1.0.0-beta.12 or later (coreServesObjectApis, a semver comparison
 *     including the pre-release part): the Dashboard object APIs
 *     `GET /api/instance`, `/api/groups/counts`, `/api/usage/summary` and, in
 *     single-session mode, `/api/groups/origin` (field sources:
 *     payloadFromObjects). Any of them failing (connection, non-2xx including
 *     404, timeout, unreadable or malformed body) fails the read and skips the
 *     tick; there is no fallback to another path. The cgroup is not read.
 *   - An earlier Core (every 0.x, and 1.x before beta.12), or a version that
 *     cannot be read: `GET /api/state` plus the cgroup collector, as before.
 *     This is chosen before any request; it is not a fallback after a failed
 *     object-API read.
 *
 * Failures are never silent: an unavailable dashboard state is warned once
 * (same once-guard style as the runtime-metrics 404 skip), and a later
 * successful fetch re-arms the warning.
 *
 * Deps are injected so the logic is unit-testable without the comm-bridge
 * daemon or a live dashboard (see metrics-reporter.test.js).
 */

import fs from 'fs';
import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { createDashboardClient } from './dashboard-client.js';
import { createCgroupCollector } from './cgroup-resources.js';
import { getDashboardPort } from './dashboard-address.js';
import { readinessReport } from './agent-readiness.js';
import { readCoreVersion as readInstalledCoreVersion, coreServesObjectApis } from './core-version.js';

// Shared service adapter: resolve the gate before projecting its four fields.
export function createMetricsReadinessEvaluator(gate, isDisabled) {
  return async () => (isDisabled() ? null : readinessReport(await gate.evaluate()));
}

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

// Dashboard object APIs read on each tick, in order. The Origin
// group detail is read only in single-session mode (see payloadFromObjects);
// `include=` leaves out its optional raw message and configuration.
export const OBJECT_API_PATHS = Object.freeze({
  instance: '/api/instance',
  counts: '/api/groups/counts',
  usage: '/api/usage/summary',
  origin: '/api/groups/origin?include=',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The bodies the payload is built from must have the structure the Dashboard
// documents; anything else is a failed read, not a payload of nulls. Returns
// the failure reason, or null.
function objectApiBodyError(name, body) {
  if (!isObject(body)) return `${name}: not an object`;
  if (name === 'instance' && !isObject(body.session_mode)) return 'instance: no session_mode';
  if (name === 'counts' && (typeof body.listKnown !== 'boolean' || !isObject(body.running?.states))) {
    return 'counts: no listKnown or running.states';
  }
  if (name === 'usage' && (!isObject(body.today) || !isObject(body.sevenDay))) return 'usage: no today or sevenDay';
  return null;
}

// The runtime-metrics payload from the object APIs. Field names are
// unchanged; each value is copied from one documented field without
// conversion (Core skills/dashboard/docs/api.md):
//   runtime.session_mode  ← instance.session_mode.sessionMode
//   runtime.state         ← groups/counts, by the Dashboard's own aggregate
//                           (Fleet): UNKNOWN when the mode or the group list
//                           is unknown, else BUSY with any working group,
//                           else UNKNOWN with any unknown group, else IDLE
//   runtime.groups        ← groups/counts `running`, `offline`, `pool`
//   runtime.model_id, runtime.effort, runtime.context_pct
//                         ← single-session mode: the Origin group detail's
//                           runtimeInfo.model, runtimeInfo.effort, contextPct
//                           (the one session); multi-session mode: null, as no
//                           single session describes the agent
//   runtime.model         ← null: the object APIs carry a model id only, no
//                           display name
//   cost.daily, cost.weekly ← usage/summary today.cost, sevenDay.cost
//   cost.session          ← null: the object APIs have no session cost
//   rate_limit_pct        ← null: the platform defines it as the 5-hour
//                           window, and the object APIs expose only the
//                           account's seven-day used percentage, so there is
//                           no source for it
//   resources             ← instance.resources (scope, cpu_pct, mem_pct,
//                           mem_total_bytes, mem_used_bytes, disk_pct,
//                           disk_free_bytes)
// `version` is this component's own; `readiness` is the gate's verdict.
function payloadFromObjects({ instance, counts, usage, origin }, readiness) {
  const mode = instance.session_mode.sessionMode ?? null;
  const states = counts.running.states;
  const res = isObject(instance.resources) ? instance.resources : {};
  const info = origin?.runtimeInfo ?? {};
  return {
    version: PKG_VERSION,
    resources: {
      scope:           res.scope ?? null,
      cpu_pct:         res.cpu_pct ?? null,
      mem_pct:         res.mem_pct ?? null,
      mem_total_bytes: res.mem_total_bytes ?? null,
      mem_used_bytes:  res.mem_used_bytes ?? null,
      disk_pct:        res.disk_pct ?? null,
      disk_free_bytes: res.disk_free_bytes ?? null,
    },
    runtime: {
      state: mode === null || counts.listKnown === false ? 'UNKNOWN'
        : states.working > 0 ? 'BUSY' : states.unknown > 0 ? 'UNKNOWN' : 'IDLE',
      model_id:     info.model ?? null,
      model:        null,
      context_pct:  origin?.contextPct ?? null,
      effort:       info.effort ?? null,
      session_mode: mode,
      groups: {
        running: counts.running,
        offline: counts.offline ?? null,
        pool:    counts.pool ?? null,
      },
    },
    cost: {
      session: null,
      daily:   usage.today.cost ?? null,
      weekly:  usage.sevenDay.cost ?? null,
    },
    rate_limit_pct: null,
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
  execFile,
  fileExists,
  persistKey,
  apiKeyCliPath,
  // The process-wide Dashboard client (dashboard-client.js). Absent: one is
  // built here from the deps above (dashboardApiKey, fetch, now, execFile,
  // fileExists, persistKey, apiKeyCliPath), as before.
  dashboardClient = null,
  // Installed Core version (core-version.js); selects what is read, see the
  // top of this file.
  readCoreVersion = () => readInstalledCoreVersion(),
  // Creates the cgroup collector, which reads /sys at once. Only the
  // `/api/state` path uses it: created at startup there, as before, and never
  // on a Core that serves the object APIs.
  createCgroup = createCgroupCollector,
  requestTimeoutMs = REPORT_REQUEST_TIMEOUT_MS,
} = {}) {
  let warnedEndpoint404 = false;     // cws-core runtime-metrics endpoint missing
  let warnedStateUnavailable = false; // dashboard state fetch failing — re-armed on success
  let loggedCgroupFallback = false;   // logged once when cgroup is absent (non-containerized)
  const dashboard = dashboardClient ?? createDashboardClient({
    log, warn, dashboardApiKey, fetch, now,
    ...(execFile ? { execFile } : {}),
    ...(fileExists ? { fileExists } : {}),
    ...(persistKey ? { persistKey } : {}),
    ...(apiKeyCliPath ? { apiKeyCliPath } : {}),
  });
  const dashboardGet = dashboard.get;

  function coreUsesObjectApis() {
    return coreServesObjectApis(readCoreVersion());
  }
  let cgroup = coreUsesObjectApis() ? null : createCgroup();

  function warnStateUnavailable(reason) {
    if (warnedStateUnavailable) return;
    warnedStateUnavailable = true;
    warn(`dashboard state unavailable (${reason}) — runtime-metrics not reported; `
      + 'set metricsReport.dashboardApiKey if the dashboard has auth enabled');
  }

  // Earlier Core: `GET /api/state`, as before.
  async function fetchDashboardState() {
    if (dashboard.isQuiet()) return null; // warned once at the dead end — stay quiet
    try {
      const res = await dashboardGet(getDashboardPort(), '/api/state');
      if (!res) return null;
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

  // Object-API Core: the object APIs. Returns the bodies, or null after warning
  // (once) when any read fails. The body is read inside the request deadline,
  // so a Dashboard that sends headers and then stalls fails like a timeout.
  async function readObjectApis() {
    if (dashboard.isQuiet()) return null;
    const port = getDashboardPort();
    const bodies = {};
    for (const name of ['instance', 'counts', 'usage', 'origin']) {
      if (name === 'origin' && bodies.instance.session_mode.sessionMode !== 'single') continue;
      const pathname = OBJECT_API_PATHS[name];
      let res, body;
      try {
        res = await dashboardGet(port, pathname, { readBody: true });
        if (!res) return null; // no token this tick; any dead end has warned
        if (!res.ok) throw new Error(`http ${res.status}`);
        body = await res.json();
      } catch (err) {
        warnStateUnavailable(`GET ${pathname}: ${err?.message || 'fetch failed'}`);
        return null;
      }
      const invalid = objectApiBodyError(name, body);
      if (invalid) {
        warnStateUnavailable(`GET ${pathname}: ${invalid}`);
        return null;
      }
      bodies[name] = body;
    }
    warnedStateUnavailable = false; // recovered — re-arm the once-guard
    return bodies;
  }

  async function currentPayload() {
    if (coreUsesObjectApis()) {
      const bodies = await readObjectApis();
      return bodies ? payloadFromObjects(bodies, await evaluateReadiness()) : null;
    }
    // Sample CPU every tick — cumulative usage_usec needs a differential window,
    // and sampling unconditionally (before the dashboard fetch, which can fail)
    // keeps the window evenly spaced across dashboard outages. A collector
    // first needed here (the installed Core changed to an earlier one) takes
    // its first sample when created, so CPU is reported from the next tick on.
    if (cgroup) cgroup.sample();
    else cgroup = createCgroup();
    const dashboard = await fetchDashboardState();
    if (!dashboard) return null;
    const cg = cgroup.read();
    if (cg.cgroup_version === 'none' && !loggedCgroupFallback) {
      loggedCgroupFallback = true;
      log?.('cgroup unavailable (non-containerized agent) — reporting node-level CPU/memory from dashboard');
    }
    return buildPayload(dashboard, cg, await evaluateReadiness());
  }

  return async function reportMetrics() {
    const payload = await currentPayload();
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
