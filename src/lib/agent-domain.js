/**
 * Self public base-URL resolution for the agent.
 *
 * Webhook-style channels (WhatsApp Business / LINE / Teams) need the agent to
 * know its OWN publicly-reachable base URL so it can construct callback/webhook
 * URLs. This module implements the two-tier resolution order (TM 79ad2910):
 *
 *   1. cws-core  — GET /api/v1/platform-agents/{identity_id}/domain returns the
 *      domain bound to this agent (`{full_domain, label, root_suffix}`).
 *      base_url = "https://" + full_domain.
 *   2. env       — ONLY if the agent has no bound domain (core responds 404),
 *      fall back to the AGENT_PUBLIC_BASE_URL environment variable.
 *
 * If neither yields a value → `{ ok:false, error }`.
 *
 * Strict semantics: the 404 is the ONE condition that reaches the env tier.
 * Any other HTTP/network error propagates, and a malformed 200 (a /me response
 * without identity_id, or a domain response without full_domain) throws a
 * protocol-violation Error instead of silently falling back — a corrupt
 * cws-core response must never be masked as "no bound domain", or a stale env
 * URL could keep receiving webhooks.
 *
 * The reusable `resolveAgentBaseUrl()` takes injectable deps (get / apiPath /
 * env / config / identityId) so callers — the `core.agent_domain` CLI command,
 * future step-3 channel code, and unit tests — all share one resolution path
 * without hitting the network in tests.
 *
 * Env loading: modules read `process.env.*`, which the Zylos runtime fills from
 * ~/zylos/.env at start. AGENT_PUBLIC_BASE_URL can also be re-read from that file
 * at call time (parseDotenv / publicBaseUrlFromEnv below, dotenv 16 grammar, no
 * dependency) so it takes effect without a restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { get, apiPath } from './client.js';
import { loadConfig } from './config.js';
import { readCoreSettings } from './session-control.js';

// The dotenv line grammar (dotenv 16 `LINE`), so a value reads here exactly as the
// Zylos runtime loads it: inline `# comments` dropped, quotes removed, last key wins.
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

/** Parse dotenv text into an object (dotenv 16 semantics, no interpolation). */
export function parseDotenv(src) {
  const out = {};
  const lines = String(src).replace(/^\uFEFF/, '').replace(/\r\n?/mg, '\n');
  let m;
  DOTENV_LINE.lastIndex = 0;
  while ((m = DOTENV_LINE.exec(lines)) != null) {
    let value = (m[2] || '').trim();
    const q = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
    if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    out[m[1]] = value;
  }
  return out;
}

/**
 * Current value of `key` in ~/zylos/.env, read at call time (the process
 * environment only holds what PM2 exported at start). Undefined when the file
 * or the key is absent or empty. Never logs the value.
 */
export function readZylosEnvValue(key, { home = process.env.HOME || '', fsDep = fs } = {}) {
  let content;
  try { content = fsDep.readFileSync(path.join(home, 'zylos/.env'), 'utf8'); } catch { return undefined; }
  return parseDotenv(content)[key] || undefined;
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; }
}

/**
 * AGENT_PUBLIC_BASE_URL to use: the value now in ~/zylos/.env when it is a valid
 * http(s) URL (so adding or changing it needs no restart), else the value the
 * process started with. A malformed fresh value never overrides a working one.
 */
export function publicBaseUrlFromEnv({ env = process.env, readFresh = () => readZylosEnvValue('AGENT_PUBLIC_BASE_URL') } = {}) {
  const fresh = readFresh();
  if (fresh && isHttpUrl(fresh)) return fresh;
  return env.AGENT_PUBLIC_BASE_URL;
}

/** Local operator-configured HTTPS host for relay-specific reachability checks. */
export function configuredHttpsBaseUrl(readSettings = readCoreSettings) {
  const { domain, protocol = 'https' } = readSettings() || {};
  if (protocol !== 'https' || typeof domain !== 'string' || domain !== domain.trim()
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) return null;
  return `https://${domain}`;
}

/** Trim whitespace and strip any trailing slashes so base_url never ends in "/". */
export function normalizeBaseUrl(u) {
  return String(u ?? '').trim().replace(/\/+$/, '');
}

/**
 * Resolve this agent's identity_id. Prefers config.json `agent.identity_id`
 * (the canonical global identity); falls back to cws-core `GET /me` which
 * returns `{ ..., identity_id }` when config is missing it.
 *
 * @param {object}   [deps]
 * @param {object}   [deps.config]     pre-loaded config (else loadConfig())
 * @param {Function} [deps.getFn]      get(path) → response (else client.get)
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path (else client.apiPath)
 * @returns {Promise<string>}          identity_id (never empty)
 * @throws {Error} when /me succeeds (200) but carries no identity_id — a
 *                 cws-core protocol violation that must fail loudly rather
 *                 than silently skip the core domain tier.
 */
export async function resolveAgentIdentityId(deps = {}) {
  const { config, getFn = get, apiPathFn = apiPath } = deps;
  const cfg = config || loadConfig();
  const fromCfg = cfg?.agent?.identity_id;
  if (fromCfg) return String(fromCfg);

  const me = await getFn(apiPathFn('/me'));
  const id = me?.identity_id || me?.identity?.id;
  if (!id) {
    throw new Error(
      'cws-core protocol violation: GET /me succeeded but returned no identity_id',
    );
  }
  return String(id);
}

/**
 * Resolve the agent's public base URL via the two-tier order documented above.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.getFn]      get(path) → response (else client.get)
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path (else client.apiPath)
 * @param {object}   [deps.env]        env source (else process.env)
 * @param {object}   [deps.config]     pre-loaded config (else loadConfig())
 * @param {string}   [deps.identityId] skip identity resolution when provided
 * @returns {Promise<
 *   { ok:true,  source:'core', full_domain:string, label?:string, root_suffix?:string, base_url:string } |
 *   { ok:true,  source:'env',  base_url:string } |
 *   { ok:false, error:string }
 * >}
 * @throws {Error} on non-404 core errors and on malformed 200 responses
 *                 (protocol violations) — see module doc; only a 404 reaches
 *                 the env fallback.
 */
export async function resolveAgentBaseUrl(deps = {}) {
  const {
    getFn = get,
    apiPathFn = apiPath,
    env = process.env,
    config,
  } = deps;

  // Tier 1 — cws-core bound domain.
  const identityId =
    deps.identityId || (await resolveAgentIdentityId({ config, getFn, apiPathFn }));

  if (identityId) {
    try {
      const domain = await getFn(apiPathFn(`/platform-agents/${identityId}/domain`));
      const fullDomain = domain?.full_domain;
      if (!fullDomain) {
        // A 200 MUST carry full_domain — "no bound domain" is signalled by a
        // 404, never by an empty body. Fail loudly instead of silently
        // falling back to a possibly-stale env URL.
        throw new Error(
          `cws-core protocol violation: GET /platform-agents/${identityId}/domain ` +
          'succeeded but returned no full_domain',
        );
      }
      return {
        ok: true,
        source: 'core',
        full_domain: fullDomain,
        label: domain.label,
        root_suffix: domain.root_suffix,
        base_url: normalizeBaseUrl(`https://${fullDomain}`),
      };
    } catch (err) {
      // ONLY a 404 (no bound domain) falls through to the env tier. Any other
      // error (auth, 5xx, network, protocol violation) is a real failure and
      // must propagate.
      if (err?.status !== 404) throw err;
    }
  }

  // Tier 2 — AGENT_PUBLIC_BASE_URL fallback.
  const envUrl = normalizeBaseUrl(env?.AGENT_PUBLIC_BASE_URL);
  if (envUrl) {
    return { ok: true, source: 'env', base_url: envUrl };
  }

  return { ok: false, error: 'no bound domain and AGENT_PUBLIC_BASE_URL unset' };
}
