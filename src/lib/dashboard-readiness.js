import { getDashboardPort } from './dashboard-address.js';
import { coreServesObjectApis } from './core-version.js';

/**
 * The readiness probe address for the installed Core version, chosen before
 * the request: `GET /api/health/ready` from Core 1.0.0-beta.12 (the object
 * APIs), `GET /api/health?probe=ready` on an earlier 1.x.
 */
export function readinessProbePath(coreVersion) {
  return coreServesObjectApis(coreVersion) ? '/api/health/ready' : '/api/health?probe=ready';
}

/**
 * One request per existing readiness evaluation; no watcher or cached result.
 * `path` comes from readinessProbePath; without it, the address an unknown
 * version selects (`/api/health?probe=ready`).
 */
export async function readDashboardProbe({ fetch = globalThis.fetch, port = getDashboardPort(), path = readinessProbePath(null), timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal, redirect: 'error',
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Availability follows the probe; onboarding policy uses only its health facts. */
export async function evaluateDashboardReadiness({ readProbe = readDashboardProbe, runtime = null } = {}) {
  const probe = await readProbe();
  const body = probe?.body;
  const health = body?.runtime_health?.[runtime];
  const detail = { source: 'dashboard', http_status: probe?.status ?? null,
    session_mode: body?.session_mode ?? null, runtime,
    health_source: health?.source ?? null, health: health?.health ?? null };
  const unavailable = () => ({ ready: false, reason: 'dashboard_unavailable', detail });
  if (probe?.status === 503 && body?.ready === false) {
    if (body.reason === 'supervisor_unavailable') return { ready: false, reason: body.reason, detail };
    if (body.reason === 'session_not_running' && body.session_mode === 'single') return { ready: false, reason: body.reason, detail };
    return unavailable();
  }
  if (probe?.status === 200 && body && typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'ready')) {
    return { ready: false, reason: 'probe_unsupported', detail };
  }
  if (probe?.status !== 200 || body?.ready !== true) return unavailable();
  // Only an explicit current-runtime failure delays onboarding. Core writes
  // health records on transitions; absent records are normal on new instances.
  const onboardingReason = health?.source === 'record' && ['auth_failed', 'down', 'unavailable'].includes(health.health)
    ? `health_${health.health}` : null;
  return { ready: true, reason: 'ready', detail, ...(onboardingReason ? { onboardingReason } : {}) };
}
