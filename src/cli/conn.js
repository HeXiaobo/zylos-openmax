#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { apiPath, getForOrg, getForOrgPage, postForOrg, patchForOrg, delForOrg } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { listCachedCredentials, clearCachedCredentials, readCredentialCache, saveCredentialCache } from '../lib/credential-cache.js';
import {
  readIndex, replaceIndexFromList, findConnectionByApp, findActiveConnectionsByApp, indexPathForOrg,
  readCatalog, writeCatalog, invalidateCatalog, CATALOG_TTL_MS,
  personalConnectorBlockedInConversation,
} from '../lib/connect-store.js';
import { acquireCredential } from '../lib/connection-events.js';
import { parseEndpoint } from '../lib/message.js';
import { contextMetadata, fitsContextDataLimit } from '../lib/message-context.js';
import { invokeDirect, resolveCredential } from '../lib/direct-exec.js';
import { capabilityHeaders, CAPABILITIES_HEADER_VALUE } from '../lib/request-spec/capabilities.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Operating org for the capability-cache verbs: explicit {org} wins, else the
// default/single enabled org. The index is org-scoped, so every lookup + the
// execute call must run against the same org's file, token, and member.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}

// Resolve the operating org and FAIL FAST when it can't be determined. Every
// cws-connect route below is org-scoped: cws-core requires an org-scoped JWT
// and 403s ("org membership required") on an identity-only token. A bare
// get()/post() would silently fall through to resolveDefaultOrgId(), which
// returns '' when >1 org is enabled and neither {org} nor COCO_ORG_ID is set —
// producing exactly that opaque 403. Throwing here turns "no org resolved" into
// an actionable 400 instead. Single-org / COCO_ORG_ID deployments resolve as
// before and never hit this.
function requireOrgId() {
  const orgId = resolveOrgId();
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}

// Security note: this agent's own member_id for an org — the ONLY identity
// the conn.* commands below use for the cws-connect agent_member_id calls.
// There is deliberately no client-supplied override (e.g. params.agentMemberId)
// here: accepting one would let a caller impersonate a different agent's
// identity against cws-connect (a confused-deputy/IDOR risk). cws-core is
// moving to derive this server-side from the authenticated principal too, so
// even if a caller sent an override it would be ignored there as well.
function resolveSelfMemberId(orgId = resolveDefaultOrgId()) {
  const cfg = loadConfig();
  for (const [, org] of Object.entries(cfg.orgs || {})) {
    if (org.org_id === orgId && org.self?.member_id) return org.self.member_id;
  }
  const first = Object.values(cfg.orgs || {})[0];
  return first?.self?.member_id || '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// ============================================================================
//  Custom-connector management (applications + action-defs)
// ============================================================================
//
// These verbs onboard/manage CUSTOM connector applications and their DB-backed
// HTTP action definitions against the cws-core BFF (/connect/applications*).
// They are org-scoped exactly like the rest of conn.js: the handler resolves the
// operating org via requireOrgId() and routes through the *ForOrg helpers so a
// multi-org agent never calls the backend with an identity-only token.
//
// The request PLAN for each verb is a pure function (planApp* / planActionDef*)
// that validates required params locally (throws {status:400}) and returns
// { method, path, body } WITHOUT touching the network — so path-building, the
// method, and the request body are unit-testable in isolation. The COMMANDS
// handlers below just wire the plan to the matching *ForOrg helper.
//
// SECURITY: a set of fields is NEVER forwarded to cws-core in the request body —
// they are all server-decided, so we build bodies with a strict ALLOWLIST (`pick`)
// rather than spreading the caller's params, and any field outside the allowlist
// (or any unknown key) cannot leak through even if supplied:
//   - `org_id`             — derived from the authenticated principal (still honored
//                            as an OPERATING-org selector via resolveOrgId — that
//                            picks which org's JWT to use, never written to a body).
//   - `oauth_callback_url` — injected by cws-core on create/update, returned read-only.
//   - `credential_source`  — server-FORCED to `custom` for these CLI-created connectors.
//   - `visibility`         — server-FORCED to `org`.
//   - `credential_mode`    — server-FORCED to `direct` (proxy is deprecated/removed).
// The last three were removed from the cws-core custom-connector create/update
// request schema (strict huma): sending ANY of them now returns HTTP 422. So the
// CLI planner drops them exactly the way it already drops `org_id`/`oauth_callback_url`.
// This mirrors conn.js's existing "no client-supplied identity override" posture.

// Application create body — the custom-connector superset (§1.2). `org_id`,
// `oauth_callback_url`, `credential_source`, `visibility`, and `credential_mode`
// are intentionally absent from this allowlist: cws-core forces
// custom/org/direct server-side and REJECTS (422) any of them in the body.
const APP_CREATE_FIELDS = [
  'slug', 'display_name', 'description', 'provider_type', 'connector_kind',
  'icon_url', 'category', 'tags',
  'api_key_location', 'api_key_header_name',
  'oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret',
  'oauth_scopes_default', 'oauth_pkce', 'oauth_token_auth_method', 'oauth_token_body_format',
  'default_ttl_seconds',
];
// connector_kind is a separate axis from provider_type (cws-connect
// connect.proto Application.connector_kind): "http" (default — the per-action
// HTTP connector) or "mcp" (a Model Context Protocol server connector).
// provider_type always carries the AUTH model and the platform only stores
// oauth2 | api_key (DB CHECK) — "mcp" is never a provider_type (sending it 500s).
// For an mcp connector it is only a placeholder (default api_key): the auth is
// decided per connection when the user connects it.
// An mcp connector is a DEFINITION only: no MCP server config and no action
// defs at create — the server URL is entered per-connection when the user
// connects it (cws-core connectCreateConnectionMcpServerInput), where
// cws-connect probes the server and runs OAuth discovery + DCR when needed.
export const CONNECTOR_KINDS = Object.freeze(['http', 'mcp']);
const APP_PROVIDER_TYPES = Object.freeze(['oauth2', 'api_key']);
// Per-connection MCP server fields an agent might be tempted to put on the
// connector definition. cws-core's create schema has none of them.
const MCP_CONNECT_TIME_FIELDS = ['mcp_server', 'server_url', 'mcp_server_url'];
// OAuth endpoint fields an mcp definition must NOT carry: connect-time discovery
// writes the discovered authorize/token URLs + scopes onto the application row,
// and once the row has endpoints, a connection whose discovery resolves to
// different ones is refused (cws-connect ErrMCPEndpointMismatch) — so a guessed
// value would break every connection. oauth_client_id stays allowed: it is the
// fallback client for an MCP server without dynamic client registration.
const MCP_DISCOVERED_OAUTH_FIELDS = ['oauth_authorize_url', 'oauth_token_url', 'oauth_scopes_default'];
// Application update body — pointer/optional fields (§1.2). `slug` and
// `provider_type` are immutable server-side, so they are NOT accepted here.
// `credential_source` / `visibility` / `credential_mode` are likewise NOT
// accepted: they are server-forced (custom/org/direct) and REJECTED (422) if
// sent — same treatment as the always-forbidden `org_id` / `oauth_callback_url`.
const APP_UPDATE_FIELDS = [
  'display_name', 'description',
  'icon_url', 'category', 'tags', 'is_enabled',
  'api_key_location', 'api_key_header_name',
  'oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret',
  'oauth_scopes_default', 'oauth_pkce', 'oauth_token_auth_method', 'oauth_token_body_format',
  'default_ttl_seconds',
];
// request_spec: the declarative body/file/upload/batch description of an action
// (custom connectors may carry one too, owner decision Q8). cws-connect
// validates it on write; the plugin re-validates it before executing.
const ACTIONDEF_CREATE_FIELDS = ['name', 'method', 'url_template', 'description', 'headers', 'encoding', 'input_schema', 'request_spec'];
const ACTIONDEF_UPDATE_FIELDS = ['method', 'url_template', 'description', 'headers', 'encoding', 'input_schema', 'request_spec'];

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

// Tombstone error for the removed legacy verbs (conn.proxy / conn.execute). They
// are gone; conn.invoke is the single entry point and auto-routes by
// credential_mode — direct (local egress) AND proxy/Composio (server-side
// execute) are both invokable through it.
function proxyDeprecatedError(verb) {
  return bad(`unsupported: ${verb} is removed — use conn.invoke {app|connectionId, action, params} instead, which supports both direct (local egress) and proxy/Composio (server-side execute) connections.`);
}

// Copy only the allowlisted keys that are actually present (skip `undefined`).
// Absent keys stay absent so cws-core applies its own defaults; `null` passes
// through so an update can explicitly clear a field.
function pick(src, allowed) {
  const out = {};
  for (const k of allowed) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// OAuth secret semantics: a BLANK (empty/whitespace-only) `oauth_client_secret`
// means "leave the stored secret unchanged" — it must NEVER be forwarded, so an
// update that omits or blanks the secret can never CLEAR a previously-stored one.
// A NON-empty secret IS forwarded (to set/rotate it). This mirrors the cws-fe
// form, which only sends the secret when the user actually typed a new value.
// Note this is deliberately asymmetric with `oauth_scopes_default`: an explicit
// empty array (`[]`) there is preserved and CLEARS the default scopes — only the
// secret has the write-only "blank = keep" behavior.
function dropBlankClientSecret(body) {
  if (typeof body.oauth_client_secret === 'string' && body.oauth_client_secret.trim() === '') {
    delete body.oauth_client_secret;
  }
  return body;
}

// An action-def's stored `headers` are applied by cws-connect on the DB-backed
// custom-action execution path AFTER the per-connection credential is injected,
// and (unlike discovery) that path does NOT strip them — so a stored
// `Authorization` header would override the connection's own auth. Reject any
// caller-supplied Authorization key locally (case-insensitive) so the CLI never
// authors a row that violates the "provider auth comes from the connection, not
// from action headers" contract. Lives in the pure planner so every path
// (create / update / app_import) is covered and can't bypass it.
function assertNoAuthorizationHeader(headers) {
  if (!headers || typeof headers !== 'object') return;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') {
      throw bad('headers.Authorization is forbidden — the connection credential is injected at call time');
    }
  }
}

function requireAppId(p) {
  const applicationId = p.applicationId || p.application_id;
  if (!applicationId) throw bad('applicationId is required');
  if (!isUuid(applicationId)) throw bad('applicationId must be a UUID');
  return applicationId;
}

function requireActionId(p) {
  const actionId = p.actionId || p.action_id;
  if (!actionId) throw bad('actionId is required');
  if (!isUuid(actionId)) throw bad('actionId must be a UUID');
  return actionId;
}

// POST /connect/applications — create a custom connector application.
// `slug` is OPTIONAL: cws-core generates one from display_name when omitted
// (#31, end-to-end deployed). An explicit slug is still honored — it stays in the
// allowlist and is forwarded as-is — but the CLI no longer force-requires it.
const isBlank = (v) => v === undefined || v === null || v === '';

export function planAppCreate(p) {
  if (!p.display_name) throw bad('display_name is required');
  const kind = p.connector_kind;
  if (kind !== undefined && !CONNECTOR_KINDS.includes(kind)) {
    throw bad(`connector_kind must be one of ${CONNECTOR_KINDS.join(' | ')}`);
  }
  // `auth_type` is the agent-facing name of the auth model — the same word the
  // conn.create_card card uses (api_key | oauth2, http connectors only); it is
  // mapped onto the platform's provider_type and never forwarded itself.
  // `provider_type` stays accepted. "mcp" is a connector_kind, never an auth
  // model, under either name.
  const isMcpWord = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'mcp';
  const authType = isBlank(p.auth_type) ? undefined : p.auth_type;
  if (isMcpWord(authType)) {
    throw bad('auth_type "mcp" is not valid — MCP is a connector kind, not an auth type: send connector_kind:"mcp" with no auth_type (the auth is decided when the user connects it)');
  }
  if (kind === 'mcp' && authType !== undefined) {
    throw bad('auth_type is not accepted for connector_kind "mcp" — an MCP connector\'s auth is decided when the user connects it; omit auth_type');
  }
  if (authType !== undefined && !isBlank(p.provider_type) && p.provider_type !== authType) {
    throw bad('auth_type and provider_type differ — send auth_type only');
  }
  // provider_type is checked for EVERY connector_kind: the platform stores only
  // oauth2 | api_key (exact, lowercase — DB CHECK) and does not validate it
  // before the insert, so any other value ("OAuth2", "basic", …) 500s.
  const typeField = authType !== undefined ? 'auth_type' : 'provider_type';
  const rawProviderType = authType !== undefined ? authType : p.provider_type;
  if (isMcpWord(rawProviderType)) {
    throw bad('provider_type "mcp" is not valid — MCP is a connector kind, not an auth model: send connector_kind:"mcp" (provider_type may then be omitted; it defaults to api_key)');
  }
  // For an mcp connector provider_type is only a placeholder: the platform
  // decides the auth when the user connects (OAuth discovery upgrades api_key →
  // oauth2, never the reverse). Default it to api_key, as the openmax.com form does.
  const providerType = (kind === 'mcp' && isBlank(rawProviderType))
    ? 'api_key'
    : rawProviderType;
  if (!providerType) throw bad('auth_type is required for an http connector (api_key | oauth2; provider_type is accepted as an alias)');
  if (!APP_PROVIDER_TYPES.includes(providerType)) {
    throw bad(`${typeField} must be one of ${APP_PROVIDER_TYPES.join(' | ')} (exact, lowercase) — got ${JSON.stringify(providerType)}`);
  }
  if (kind === 'mcp') {
    for (const f of MCP_CONNECT_TIME_FIELDS) {
      if (p[f] !== undefined) {
        throw bad(`${f} is not accepted on an mcp connector definition — the MCP server URL is entered per-connection when the user connects it on openmax.com (connections page)`);
      }
    }
    for (const f of MCP_DISCOVERED_OAUTH_FIELDS) {
      if (p[f] !== undefined) {
        throw bad(`${f} is not accepted on an mcp connector definition — the OAuth endpoints and scopes are discovered from the MCP server when the user connects it (a preset value would make every connection fail); oauth_client_id is still allowed for a server without dynamic client registration`);
      }
    }
  }
  const body = dropBlankClientSecret(pick(p, APP_CREATE_FIELDS));
  body.provider_type = providerType;
  return { method: 'POST', path: apiPath('/connect/applications'), body };
}

// PATCH /connect/applications/{id} — update the caller's own custom connector.
// Carries the full OAuth field set (oauth_client_id / oauth_client_secret /
// oauth_scopes_default / authorize+token URLs, all in APP_UPDATE_FIELDS). A blank
// secret is dropped BEFORE the "no updatable fields" check, so an update whose
// ONLY field is a blank secret is correctly rejected as empty rather than sent.
export function planAppUpdate(p) {
  const applicationId = requireAppId(p);
  const body = dropBlankClientSecret(pick(p, APP_UPDATE_FIELDS));
  if (Object.keys(body).length === 0) throw bad('no updatable fields provided');
  return { method: 'PATCH', path: apiPath(`/connect/applications/${applicationId}`), body };
}

// GET /connect/applications/{id}/action-defs — list the app's HTTP action defs.
export function planActionDefList(p) {
  const applicationId = requireAppId(p);
  return { method: 'GET', path: apiPath(`/connect/applications/${applicationId}/action-defs`) };
}

// POST /connect/applications/{id}/action-defs — create one HTTP action def.
export function planActionDefCreate(p) {
  const applicationId = requireAppId(p);
  if (!p.name) throw bad('name is required (format: toolkit-slug/action-name)');
  if (!p.method) throw bad('method is required (GET|POST|PUT|PATCH|DELETE)');
  if (!p.url_template) throw bad('url_template is required');
  // description is REQUIRED and non-empty on create/import (#31, cws-core now
  // stores it end-to-end). Reject a missing/blank one locally before any network.
  if (p.description == null || String(p.description).trim() === '') {
    throw bad('description is required (non-empty)');
  }
  assertNoAuthorizationHeader(p.headers);
  return {
    method: 'POST',
    path: apiPath(`/connect/applications/${applicationId}/action-defs`),
    body: pick(p, ACTIONDEF_CREATE_FIELDS),
  };
}

// PATCH /connect/applications/{id}/action-defs/{action_id} — partial update.
export function planActionDefUpdate(p) {
  const applicationId = requireAppId(p);
  const actionId = requireActionId(p);
  assertNoAuthorizationHeader(p.headers);
  const body = pick(p, ACTIONDEF_UPDATE_FIELDS);
  if (Object.keys(body).length === 0) throw bad('no updatable fields provided');
  return {
    method: 'PATCH',
    path: apiPath(`/connect/applications/${applicationId}/action-defs/${actionId}`),
    body,
  };
}

// DELETE /connect/applications/{id}/action-defs/{action_id}.
export function planActionDefDelete(p) {
  const applicationId = requireAppId(p);
  const actionId = requireActionId(p);
  return {
    method: 'DELETE',
    path: apiPath(`/connect/applications/${applicationId}/action-defs/${actionId}`),
  };
}

// --- Action discovery paging (cursor/limit) + keyword search ----------------
// Composio connectors can expose hundreds of actions; one discovery page is
// capped server-side, so discovery is cursor-paged and searchable.

// Build the optional paging query. Only params the caller actually gave are
// included, so a call with no cursor/limit sends exactly the pre-paging request
// (no query string) — older backends see an unchanged URL. `limit` range
// (1..100) is validated server-side; locally we only reject non-integers.
export function buildPageQuery(p) {
  const query = {};
  if (p.cursor !== undefined && p.cursor !== null && p.cursor !== '') {
    if (typeof p.cursor !== 'string') throw bad('cursor must be a string (pass next_cursor as-is)');
    query.cursor = p.cursor;
  }
  if (p.limit !== undefined && p.limit !== null && p.limit !== '') {
    const n = Number(p.limit);
    if (!Number.isInteger(n) || n < 1) throw bad('limit must be a positive integer (server accepts 1..100)');
    query.limit = n;
  }
  return query;
}

// GET /connect/connections/{id}/actions[?cursor=&limit=]
export function planConnActions(p) {
  const connId = p.connectionId || p.connection_id;
  if (!connId) throw bad('connectionId is required');
  return { method: 'GET', path: apiPath(`/connect/connections/${connId}/actions`), query: buildPageQuery(p) };
}

// GET /connect/applications/{id}/actions[?cursor=&limit=]
export function planAppActions(p) {
  const appId = p.applicationId || p.application_id;
  if (!appId) throw bad('applicationId is required');
  return { method: 'GET', path: apiPath(`/connect/applications/${appId}/actions`), query: buildPageQuery(p) };
}

// GET /connect/applications/{id}/actions:search[?query=&cursor=&limit=]
// Keyword search over an application's action catalog (cws-core). `query` is
// optional (omitted → server lists from the start); blank values are omitted.
export function planActionsSearch(p) {
  const appId = p.applicationId || p.application_id;
  if (!appId) throw bad('applicationId is required');
  const query = {};
  if (p.query !== undefined && p.query !== null && p.query !== '') {
    if (typeof p.query !== 'string') throw bad('query must be a string keyword');
    query.query = p.query;
  }
  Object.assign(query, buildPageQuery(p));
  return { method: 'GET', path: apiPath(`/connect/applications/${appId}/actions:search`), query };
}

// GET /connect/applications/{id}/actions/{action}
// Stage 2 of discovery: the FULL ActionInfo (input_schema, params, ...) for ONE
// action. conn.actions_search / paged lists return lightweight entries whose
// input_schema may be empty, so describe the chosen action before invoking it.
// The action id is path-encoded (it is a single path segment server-side).
export function planActionDescribe(p) {
  const appId = p.applicationId || p.application_id;
  if (!appId) throw bad('applicationId is required');
  const action = p.action;
  if (action === undefined || action === null || action === '') throw bad('action is required');
  if (typeof action !== 'string') throw bad('action must be a string (the action id from conn.actions_search)');
  return { method: 'GET', path: apiPath(`/connect/applications/${appId}/actions/${encodeURIComponent(action)}`) };
}

// Shape a discovery page for the agent. With no next_cursor (last page, or an
// older backend that never sends one) the actions are returned exactly as
// before (the bare array). When more pages exist, the result is
// { actions, next_cursor } — next_cursor passed through as-is; feed it back as
// `cursor` to fetch the next page.
export function withNextCursor(data, nextCursor) {
  if (typeof nextCursor !== 'string' || nextCursor === '') return data;
  return { actions: actionsOf(data), next_cursor: nextCursor };
}

// Bulk import: create the application, then create each action-def in order,
// collecting a per-action success/failure report so a partial import surfaces
// exactly which actions landed. Pure/injectable (deps: createApp,
// createActionDef) so the loop + partial-failure reporting are unit-testable
// without network or config. The app body and every action body run through the
// same allowlist planners, so `org_id`/`oauth_callback_url` can never leak in.
export async function runAppImport(params, { createApp, createActionDef }) {
  const application = params.application;
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw bad('application object is required');
  }
  const actions = Array.isArray(params.actions) ? params.actions : [];
  // Validate the app body up-front (throws 400) BEFORE any network call.
  const { body: appBody } = planAppCreate(application);
  // An mcp connector's tools come from the MCP server itself — it has no
  // DB-backed HTTP action defs, so refuse them before creating anything.
  if (appBody.connector_kind === 'mcp' && actions.length > 0) {
    throw bad('actions are not accepted for connector_kind "mcp" — an MCP connector\'s tools come from the MCP server; import it with no actions');
  }
  const app = await createApp(appBody);
  const applicationId = app?.id || app?.application_id;
  if (!applicationId) {
    throw Object.assign(new Error('application create did not return an id'), { status: 502 });
  }
  const results = [];
  let created = 0;
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i] || {};
    const name = a.name ?? null;
    try {
      const { body } = planActionDefCreate({ applicationId, ...a });
      const def = await createActionDef(applicationId, body);
      created += 1;
      results.push({ index: i, name, ok: true, id: def?.id ?? null });
    } catch (err) {
      results.push({ index: i, name, ok: false, error: err.message, status: err.status });
    }
  }
  return {
    application: app,
    applicationId,
    actions_total: actions.length,
    actions_created: created,
    actions_failed: actions.length - created,
    results,
  };
}

// The app_actions / actions endpoints return the catalog either as a bare array
// or wrapped as { actions: [...] } depending on the BFF envelope — normalize.
function actionsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.actions)) return result.actions;
  return [];
}

// Fetch this agent's connections for an org from cws-core and rewrite that org's
// index file (org-scoped: uses the org's JWT and its own index path). The
// endpoint is always "your own" connections now (cws-core derives the caller
// from the authenticated principal, no id in the path) — agentId is accepted
// for call-site compatibility but no longer used to build the URL.
async function refreshIndex(orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  const list = await getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath);
  return readIndex(idxPath);
}

// Resolve an application (slug or applicationId) → its connection entry within an
// org, reading that org's index first. Refreshes from conn.list once when the
// app is missing OR the cached entry lacks an applicationId — the latter happens
// in the window after a connection.authorized event (which may carry only a slug)
// before any conn.list has filled the applicationId. Without that refresh,
// conn.catalog {app} would 400 on a slug-only entry.
async function resolveConnectionForApp(app, orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  let entry = findConnectionByApp(app, idxPath);
  if (!entry || !entry.applicationId) {
    await refreshIndex(orgId, agentId);
    entry = findConnectionByApp(app, idxPath);
  }
  return entry;
}

// Format a connection createdAt (ISO string or epoch ms) as YYYY-MM-DD, or with
// second precision when `time` is set. Returns null when missing/unparseable.
function fmtCreated(ts, { time = false } = {}) {
  if (ts == null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return time ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

// Establish a DETERMINISTIC candidate order that is invariant to the server's
// incidental return order. Sort key: created_at ASCENDING, tie-broken by the
// connection id (lexicographic). The id is used ONLY as a tiebreak here and must
// never leak into a label. Applied at the single point candidates are assembled
// (buildNeedsSelection) so that labels[i] and candidates[i] always derive from
// the SAME ordered list — otherwise (the P2 bug) two nameless connections in
// reversed input order swapped "Gmail (1)"/"Gmail (2)", so the label the user
// just picked could point to a DIFFERENT account on retry. Missing/unparseable
// createdAt sorts last (deterministically) and still tiebreaks by id.
function sortCandidatesDeterministically(entries) {
  const timeOf = (e) => {
    if (e.createdAt == null || e.createdAt === '') return Infinity;
    const t = new Date(e.createdAt).getTime();
    return Number.isNaN(t) ? Infinity : t;
  };
  return (entries || []).slice().sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// Build a guaranteed-NON-EMPTY and guaranteed-UNIQUE human LABEL per candidate,
// so the agent can refer to same-app connections unambiguously WITHOUT ever
// exposing the raw connection_id (design §3/§5 empty-name fallback). Precedence:
//   1. display_name when non-empty;
//   2. else "<app name> · <created date>" (app name + creation time);
// then collisions (duplicate/empty display_name, same-day creations) are broken
// with finer created-time precision and, as a LAST resort, a positional ordinal
// "(1)/(2)". A raw connection_id is NEVER used as a label.
export function buildCandidateLabels(entries) {
  const list = entries || [];
  const base = list.map((e) => {
    const dn = (e.displayName || '').trim();
    if (dn) return dn;
    const appName = (`${e.name || e.slug || 'connection'}`).trim() || 'connection';
    const d = fmtCreated(e.createdAt);
    return d ? `${appName} · ${d}` : appName;
  });
  // Disambiguate each group of colliding base labels.
  const groups = new Map();
  base.forEach((l, i) => {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  });
  const labels = base.slice();
  for (const [l, idxs] of groups) {
    if (idxs.length < 2) continue;
    const times = idxs.map((i) => fmtCreated(list[i].createdAt, { time: true }));
    const distinctTimes = times.every(Boolean) && new Set(times).size === idxs.length;
    idxs.forEach((i, n) => {
      labels[i] = distinctTimes
        ? `${l} · ${fmtCreated(list[i].createdAt, { time: true })}`
        : `${l} (${n + 1})`;
    });
  }
  // Belt-and-suspenders: enforce non-emptiness + global uniqueness.
  const used = new Set();
  return labels.map((l, i) => {
    let label = (l && l.trim()) ? l : `connection (${i + 1})`;
    if (used.has(label)) {
      let k = 2;
      while (used.has(`${label} (${k})`)) k += 1;
      label = `${label} (${k})`;
    }
    used.add(label);
    return label;
  });
}

// Build the `needs_selection` result for the >1-active-connections case. This is
// a NORMAL return value (printed to stdout, exit 0) — NOT an error — so the
// agent can act on it. i18n contract: `agent_instruction` is LANGUAGE-NEUTRAL
// English guidance telling the agent to localize its question into the USER'S
// language; it deliberately contains NO ready-made zh/en user-facing sentence.
// Each candidate carries a guaranteed-non-empty, unique `label` (built from
// display_name with a created-time fallback) — the agent refers to connections
// by label; the raw connection_id is never shown to the user, only echoed back
// on retry via `connectionId`. `display_name` still passes through as-is.
export function buildNeedsSelection(app, action, candidates) {
  // Sort into a deterministic order BEFORE computing labels AND before building
  // candidates[], so both the label ordinal fallback and the candidate position
  // are invariant to the input (server return) order. This is the single
  // assembly point, so labels[i] and candidates[i] cannot diverge.
  const list = sortCandidatesDeterministically(candidates);
  const labels = buildCandidateLabels(list);
  return {
    needs_selection: true,
    reason: 'multiple_connections',
    app,
    agent_instruction:
      "Multiple connections match this app. Ask the user which one to use, phrasing your "
      + "question in the USER'S language (they may write Chinese or English). Refer to each "
      + "connection by its label, never the connection_id. Then retry with the chosen connectionId.",
    candidates: list.map((e, i) => ({
      connection_id: e.id,
      label: labels[i],
      display_name: e.displayName ?? null,
      status: e.status,
    })),
    retry_hint: `conn.invoke {"connectionId":"<chosen>","action":"${action}","params":{...}}`,
  };
}

// Count-aware resolution of a conn.invoke target. Returns either { entry } (use
// it directly; entry may be null → caller 404s) or { needsSelection } (return
// it verbatim). Pure/injectable (deps: findActives, findAny, readEntryById,
// refresh) so the 0/1/>1 branching and the connectionId bypass are unit-testable
// without network or config. Branching:
//   - connectionId given → SKIP app-resolution, use that connection (refresh
//     once if it is unknown or lacks an applicationId).
//   - 0 active → refresh once (already done if the sole candidate lacked an
//     applicationId); still 0 → fall back to any (non-active, e.g. needs_reauth)
//     entry so its actionable hint surfaces, else null → 404.
//   - exactly 1 active → use it.
//   - >1 active → needs_selection (never silently pick the first).
export async function resolveInvokeEntry(
  { app, connectionId, action },
  { findActives, findAny, readEntryById, refresh },
) {
  if (connectionId) {
    let entry = readEntryById(connectionId);
    if (!entry || !entry.applicationId) {
      await refresh();
      entry = readEntryById(connectionId);
    }
    // Even if still unknown locally, honor the explicit id — cws-core re-checks
    // the connection-agent boundary server-side. applicationId stays null (the
    // direct path guards on it and errors with an actionable hint).
    return { entry: entry || { id: connectionId, status: 'active', applicationId: null, slug: null, name: null, displayName: null } };
  }

  let actives = findActives(app);
  // Refresh once when nothing matches, OR the sole candidate lacks an
  // applicationId (slug-only event before any conn.list) — mirrors the old
  // resolveConnectionForApp trigger, now count-aware (a refresh may also reveal
  // a second active, correctly routing to needs_selection).
  if (actives.length === 0 || (actives.length === 1 && !actives[0].applicationId)) {
    await refresh();
    actives = findActives(app);
  }
  if (actives.length > 1) return { needsSelection: buildNeedsSelection(app, action, actives) };
  if (actives.length === 1) return { entry: actives[0] };
  return { entry: findAny(app) || null };
}

// Return an application's action catalog, reading the cache first and filling it
// via conn.app_actions (org-scoped token) on a miss / TTL-expiry / explicit
// refresh. The catalog file is global (keyed by applicationId) since an app's
// capabilities are the same across orgs.
// `persist` (default true) gates the on-disk catalog. For a composio (proxy)
// connector we must NEVER persist a full action catalog — its action space is
// huge and it executes server-side — so the composio path passes persist:false,
// which BOTH skips the cache read (never serves a stale/absent composio catalog)
// AND skips writeCatalog (fetch-through, no disk footprint).
async function getCatalog(orgId, applicationId, { refresh = false, ttlMs = CATALOG_TTL_MS, persist = true } = {}) {
  if (!refresh && persist) {
    const cached = readCatalog(applicationId, { ttlMs, capabilities: CAPABILITIES_HEADER_VALUE });
    if (cached) return { ...cached, source: 'cache' };
  }
  const actions = actionsOf(await getForOrg(orgId, apiPath(`/connect/applications/${applicationId}/actions`), undefined, { extraHeaders: capabilityHeaders() }));
  if (!persist) {
    return { applicationId, fetchedAt: Date.now(), actions, source: 'fetch' };
  }
  const rec = writeCatalog(applicationId, actions, { capabilities: CAPABILITIES_HEADER_VALUE });
  return { ...rec, source: 'fetch' };
}

// A connection is a proxy connector when its credential_mode is "proxy" — it
// holds no local token and executes SERVER-SIDE (see conn.invoke). This is the
// single source of truth for the direct/proxy split; credential_source is no
// longer consulted.
function isProxyEntry(entry) {
  return !!entry && entry.credentialMode === 'proxy';
}

// Is an index entry's connector taxonomy KNOWN? A legacy entry that predates
// credentialMode has it null — we cannot tell proxy from direct, so the caller
// must refresh before trusting a "not proxy" read.
function taxonomyKnown(entry) {
  return !!entry && entry.credentialMode != null;
}

// Heuristic: does an execute error look like a stale/unknown-action or
// input-schema mismatch (vs. an auth/network failure)? Used to decide whether a
// one-shot catalog refresh could help.
function looksLikeActionOrSchemaError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.status === 400) {
    return /action|schema|param|unknown|not found|invalid|required/i.test(err.message || '');
  }
  return false;
}

// --- conn.auth_notice: structured "go authorize" card ------------------------
//
// When conn.check says an app is not_authorized, the agent posts ONE structured
// Agent message the cws-fe chat already renders as an authorize card (click →
// /connections?connect=<slug>, which opens that app's own connect dialog).
// Shape mirrors the channel.js structured-message builders: AGENT_STRUCTURED +
// content {content_type, body{schema,...}} + a metadata copy (cws-comm trims
// structured bodies from the list hot path, and the FE parser falls back to
// it: a `connector-auth-notice` context item, audience=ui, data = the copy;
// message context phase 2, the old metadata.connector_auth_notice key is no
// longer written) + a plain-language fallback_text for any
// client that does not know the schema.
//
// The schema string MUST stay byte-identical to cws-fe's
// CONNECTOR_AUTH_NOTICE_SCHEMA (apps/web/src/lib/connector-auth-notice.ts) so no
// frontend change is needed. Renaming it off the "prototype." prefix is a
// coordinated FE+agent follow-up — do not change it on one side only.
export const CONNECTOR_AUTH_NOTICE_SCHEMA = 'prototype.connector-auth-notice.v1';
const AUTH_NOTICE_MAX_APPS = 10;

// Pure builder. `connectors` = [{name, slug}] in display order; names and slugs
// are emitted index-aligned (connector_slugs[i] belongs to connector_names[i]).
export function buildConnectorAuthNoticeMessage(connectors) {
  if (!Array.isArray(connectors) || connectors.length === 0) throw bad('at least one connector is required');
  const names = [];
  const slugs = [];
  for (const c of connectors) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    const slug = typeof c?.slug === 'string' ? c.slug.trim() : '';
    if (!name || !slug) throw bad('each connector needs a non-empty name and slug');
    names.push(name);
    slugs.push(slug);
  }
  const body = { schema: CONNECTOR_AUTH_NOTICE_SCHEMA, connector_names: names, connector_slugs: slugs };
  return {
    client_msg_id: randomUUID(),
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'connector_auth_notice', body, attachments: [] },
    metadata: contextMetadata({
      type: 'connector-auth-notice',
      audience: 'ui',
      data: { ...body, connector_names: [...names], connector_slugs: [...slugs] },
    }),
    fallback_text: `${names.join('、')} 还没有授权给我。请到「连接」页面（/connections）完成授权，授权后就能用了。`,
  };
}

// Parse + validate the `apps` param: a non-empty list (or a single string) of
// slugs / display names / application ids, de-duplicated case-insensitively.
export function parseAuthNoticeApps(p) {
  let raw = p.apps ?? p.app;
  if (typeof raw === 'string') raw = [raw];
  if (!Array.isArray(raw) || raw.length === 0) throw bad('apps (non-empty list of app slugs) is required');
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (typeof a !== 'string' || !a.trim()) throw bad('apps entries must be non-empty strings');
    const key = a.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(a.trim()); }
  }
  if (out.length > AUTH_NOTICE_MAX_APPS) throw bad(`at most ${AUTH_NOTICE_MAX_APPS} apps per notice`);
  return out;
}

function applicationItemsOf(resp) {
  if (Array.isArray(resp)) return resp;
  for (const k of ['data', 'applications', 'items']) if (Array.isArray(resp?.[k])) return resp[k];
  return [];
}

// Catalog lookup bounds. cws-core list-connect-applications cursor mode
// accepts limit 1..100 (connect.go listConnectApplicationsRequest.Limit); the
// last page is the one without a next_cursor. 20 pages = 2000 substring matches
// for one input — far beyond any real catalog query; hitting it is an error,
// never "unknown".
export const AUTH_NOTICE_PAGE_SIZE = 100;
export const AUTH_NOTICE_MAX_PAGES = 20;
const APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve each requested app to {name, slug} against the application directory
// (the catalog the /connections page renders and resolves `?connect=<slug>`
// against — a not-authorized app is by definition absent from the local
// connections index). Exact, case-insensitive match on slug / display name / id;
// no fuzzy guess, so the deep link always targets a real catalog slug.
//
// Producer contract (cws-connect db/queries/application.sql): the list `query`
// is a SUBSTRING filter over display_name / slug / category only — never id —
// so an exact slug can sit behind a full page of substring matches. Hence:
//   - an application-id-shaped input is read exactly via
//     GET /connect/applications/{id} (same org visibility gate as the list;
//     disabled apps are not linkable and count as absent);
//   - slug / name inputs walk the query-filtered list in CURSOR mode
//     (ListApplicationsPaged: keyset over the stable (sort_order, display_name,
//     id) order) until an exact hit or no next_cursor. Numbered mode
//     (ListApplicationsOffsetPaged) is NOT used: it orders by the caller's
//     connection-state bucket before OFFSET, so a connection revoked (or an app
//     disabled) between two pages shifts rows back and OFFSET skips one.
// Only a fully searched miss is 404 unknown_connector (never a card with a dead
// link); running out of the page bound is 502 catalog_lookup_incomplete.
// `getApplication(id)` / `listApplicationsPage(query, cursor)` are injected; the
// latter resolves to { data, next_cursor } ('' / absent on the last page).
export async function resolveAuthNoticeConnectors(apps, { getApplication, listApplicationsPage }) {
  const resolved = [];
  const slugsSeen = new Set();
  for (const app of apps) {
    const want = app.toLowerCase();
    const isExact = (it) => it && [it.slug, it.display_name, it.name, it.id, it.application_id]
      .some((v) => typeof v === 'string' && v.toLowerCase() === want);
    let hit = null;
    if (APP_ID_RE.test(app)) {
      try {
        const item = await getApplication(app);
        if (isExact(item) && item.is_enabled !== false) hit = item;
      } catch (err) {
        if (err?.status !== 404 && err?.status !== 400) throw err;
      }
    }
    let cursor = '';
    for (let page = 1; !hit; page += 1) {
      if (page > AUTH_NOTICE_MAX_PAGES) {
        throw Object.assign(new Error(`could not finish the application catalog lookup for "${app}" within ${AUTH_NOTICE_MAX_PAGES} pages; pass the application id instead`), { status: 502, code: 'catalog_lookup_incomplete' });
      }
      const resp = await listApplicationsPage(app, cursor);
      hit = applicationItemsOf(resp).find(isExact) || null;
      cursor = typeof resp?.next_cursor === 'string' ? resp.next_cursor : '';
      if (!cursor) break;
    }
    const slug = hit && typeof hit.slug === 'string' ? hit.slug.trim() : '';
    if (!slug) {
      throw Object.assign(new Error(`unknown connector "${app}" — not found in the application catalog; use the exact app slug`), { status: 404, code: 'unknown_connector' });
    }
    if (slugsSeen.has(slug)) continue;
    slugsSeen.add(slug);
    const name = [hit.display_name, hit.name].find((v) => typeof v === 'string' && v.trim()) || slug;
    resolved.push({ name: name.trim(), slug });
  }
  return resolved;
}

// The conversation the card is posted INTO. It is a send target, not a gate —
// no other conn.* verb needs a conversation. Shape-checked because it is
// interpolated into the POST path.
const CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function requireTargetConversationId(p) {
  const raw = p.conversationId ?? p.conversation_id;
  if (typeof raw !== 'string' || !CONV_ID_RE.test(raw)) {
    throw bad('conversationId (the conversation to post the card into — copy it from this turn\'s <message-context conversation-id="..."/>) is required and must be well-formed');
  }
  return raw;
}

// --- conn.create_card: "create this custom connector?" confirmation card ------
//
// Before the Agent creates a custom connector (conn.app_import /
// conn.actiondef_create) it posts ONE structured card describing exactly what
// will be created, and waits for the owner's confirmation (OPENM-836). The card
// creates nothing: the frontend posts an ordinary user message on click
// ("确认创建 {name}" / "我要改 {name}" with a `card-action` context item,
// attrs {card-id, action, ref-message-id}; older frontends sent the metadata
// keys {connector_create_card_id, action, ref_message_id}), and the Agent then
// runs conn.app_import with the
// SAME slug and actions.
//
// Shape mirrors conn.auth_notice / channel.js: AGENT_STRUCTURED + content
// {content_type, body{schema,...}} + a compact metadata copy (cws-comm trims
// structured bodies from the list hot path) + a plain-text fallback_text.
//
// The schema string MUST stay byte-identical to the cws-fe renderer's constant.
// No secret ever travels on this card: any secret-like key anywhere in the
// input is refused before anything is sent (the OAuth Client Secret is entered
// by the user on the connections page via the card's「填写 Client Secret」button).
export const CONNECTOR_CREATE_CARD_SCHEMA = 'openmax.connector-create.v1';
export const CREATE_CARD_MAX_ACTIONS = 50;
export const CREATE_CARD_LIMITS = Object.freeze({
  name: 100,
  slug: 64,
  description: 500,
  url: 2048,
  action_name: 100,
  action_summary: 200,
  oauth_scope: 200,
});
// OAuth endpoint details an http + oauth2 card may show (wsb#789): the
// authorize / token URLs and the default scopes the Agent found in the target
// system's docs. Display only — the card creates nothing; conn.app_import
// still carries the real values.
export const CREATE_CARD_MAX_OAUTH_SCOPES = 50;
const CREATE_CARD_OAUTH_KEYS = ['oauth_authorize_url', 'oauth_token_url', 'oauth_scopes_default'];
// Same two axes as conn.app_create: connector_kind (http | mcp) and, for an
// http connector only, auth_type (api_key | oauth2). An mcp card has no
// auth_type — the auth is decided when the user connects the server.
const CREATE_CARD_KINDS = ['http', 'mcp'];
const CREATE_CARD_AUTH_TYPES = ['api_key', 'oauth2'];
const CREATE_CARD_EFFECTS = ['read', 'write'];
const CREATE_CARD_KIND_LABELS = { http: 'HTTP', mcp: 'MCP 服务器' };
const CREATE_CARD_AUTH_LABELS = { api_key: 'API Key', oauth2: 'OAuth 2.0' };
const CREATE_CARD_EFFECT_LABELS = { read: '读', write: '写' };
// Same character set cws-connect's slug generator emits (lowercase a-z0-9 runs
// joined by '-'; '_' also occurs in platform slugs), no leading/trailing
// separator. The card's slug must equal the slug later passed to conn.app_import.
export const CONNECTOR_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CREATE_CARD_TOP_KEYS = new Set([
  'conversationId', 'conversation_id', 'connector', 'actions', 'application_id', 'applicationId',
  'org', 'orgId', 'org_id',
]);
const CREATE_CARD_CONNECTOR_KEYS = new Set([
  'name', 'slug', 'icon_url', 'description', 'base_url', 'connector_kind', 'auth_type', 'server_url', 'mcp_server_url',
  ...CREATE_CARD_OAUTH_KEYS,
]);
const CREATE_CARD_ACTION_KEYS = new Set(['name', 'effect', 'summary']);

// A key that names a secret, compared on its lowercased alphanumerics so
// `client_secret`, `clientSecret`, `OAUTH-CLIENT-SECRET`, `apiKey`, `access_token`
// all match. Deliberately broad: a false positive costs a rename, a false
// negative leaks a credential into a chat message. Covers signed-URL
// parameters too (`sig` / `signature` / `X-Amz-Signature` / `X-Goog-Credential`,
// Azure SAS `sig`), JWTs (`jwt`, `id_token`) and refresh tokens.
export function isSecretLikeKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return false;
  if (['key', 'pat', 'otp', 'sig', 'sas', 'jwt'].includes(k)) return true;
  if (/(secret|password|passwd|passphrase|privatekey|accesskey|signingkey)/.test(k)) return true;
  return /(token|apikey|credential|credentials|authorization|bearer|cookie|pin|signature|jwt)$/.test(k);
}

// Best-effort: a URL path segment or query value that LOOKS like a credential
// even though nothing names it as one. Only well-known token formats, each
// with a minimum body length so locale codes and words (`sk-SK`, `sk_SK`,
// `xoxo-gossip`) pass. There is deliberately NO generic "long random string"
// rule: Google Drive / Notion / S3 ids look exactly like that, and a false
// positive would block legitimate URLs. Catching everything is impossible —
// secret-named parameters are checked separately (isSecretLikeKey).
const TOKEN_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{16,}$/, //                         OpenAI / Anthropic style
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}$/, //      Stripe secret / restricted
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, //                    GitHub tokens
  /^github_pat_[A-Za-z0-9_]{20,}$/, //                  GitHub fine-grained PAT
  /^glpat-[A-Za-z0-9_-]{20,}$/, //                      GitLab PAT
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/, //                  Slack tokens
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?$/, // JWT
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, //                     AWS access key id
];
export function looksLikeToken(value) {
  const v = String(value);
  return TOKEN_PATTERNS.some((re) => re.test(v));
}

// The one refusal for a secret on the card. `location` names WHERE (a field
// path or a URL parameter name), never the value.
function secretFieldError(location) {
  return Object.assign(
    new Error(`secret-like ${location} is not allowed on the connector create card — never put a key, token, password or client secret on it (not in a field, not in a URL). The user enters the OAuth Client Secret on the connections page (the card's「填写 Client Secret」button); an API key is entered when they authorize the connector.`),
    { status: 400, code: 'secret_field_rejected' },
  );
}

// Walk every object key at any depth (arrays included) and refuse the first
// secret-like one with its path. Runs before any other validation so a secret
// is never echoed into a later error message either.
export function assertNoSecretKeys(value, path = '') {
  const seen = new Set();
  const walk = (v, p) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${p}[${i}]`)); return; }
    for (const k of Object.keys(v)) {
      const kp = p ? `${p}.${k}` : k;
      if (isSecretLikeKey(k)) throw secretFieldError(`field "${kp}"`);
      walk(v[k], kp);
    }
  };
  walk(value, path);
}

function cardString(v, field, max, { required = false, joiners = 'none' } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && !required)) {
    if (required) throw bad(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (!s) throw bad(`${field} is required`);
  if ([...s].length > max) throw bad(`${field} is too long (max ${max} characters)`);
  if (hasForbiddenChar(s, joiners)) {
    throw bad(`${field} must not contain control, invisible formatting or line-separator characters (e.g. U+202E, U+200B, U+2028)`);
  }
  return s;
}

// Control (Cc), invisible formatting (Cf: bidi controls U+200E/F, U+202A–202E,
// U+2066–2069, U+200B, U+2060–2064, BOM, tag characters, …), every other
// Default_Ignorable_Code_Point that renders as nothing (Hangul fillers U+115F,
// U+1160, U+3164, U+FFA0; Mongolian variation selectors U+180B–180F; variation
// selectors U+FE00–FE0F / U+E0100–E01EF; U+034F; …) and the line / paragraph
// separators U+2028 / U+2029 can make the card display something other than
// what will be created, so they are refused. The only exceptions, by field
// (`joiners`):
//   'none'  — slug, action names, URLs: no exception at all.
//   'emoji' — connector name, action summary:
//             * VS16 U+FE0F directly after an emoji character (❤️, 1️⃣);
//             * ZWJ U+200D only BETWEEN two emoji (Extended_Pictographic,
//               optionally followed by VS16 / a skin-tone modifier, e.g.
//               👨‍👩‍👧, 🏳️‍🌈);
//             * tag characters only in a complete subdivision-flag sequence:
//               U+1F3F4, then 3–6 tags from U+E0030–E0039 / U+E0061–E007A
//               (digits / lowercase letters), then U+E007F (🏴󠁧󠁢󠁳󠁣󠁴󠁿).
//   'text'  — description: 'emoji' plus ZWNJ U+200C after a letter or mark
//             ([\p{L}\p{M}], e.g. a Devanagari virama or Arabic harakat) and
//             before a letter (Persian, Indic scripts). ZWNJ is refused elsewhere.
// Known limitation: look-alike letters from different scripts (Cyrillic "а" vs
// Latin "a") are not detected.
const PICTO_RE = /\p{Extended_Pictographic}/u;
const EMOJI_RE = /\p{Emoji}/u;
const LETTER_RE = /\p{L}/u;
const LETTER_OR_MARK_RE = /[\p{L}\p{M}]/u;
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
const isFlagTag = (cp) => (cp >= 0xE0030 && cp <= 0xE0039) || (cp >= 0xE0061 && cp <= 0xE007A);
const isEmojiTail = (cp) => cp === 0xFE0F || (cp >= 0x1F3FB && cp <= 0x1F3FF);
function hasForbiddenChar(s, joiners = 'none') {
  const cps = [...s].map((c) => c.codePointAt(0));
  const ch = (cp) => (cp === undefined ? '' : String.fromCodePoint(cp));
  const allowed = new Set();
  if (joiners !== 'none') {
    for (let i = 0; i < cps.length; i += 1) {
      const cp = cps[i];
      if (cp === 0x1F3F4) {
        let j = i + 1;
        while (j < cps.length && isFlagTag(cps[j])) j += 1;
        const n = j - (i + 1);
        if (n >= 3 && n <= 6 && cps[j] === 0xE007F) { for (let k = i + 1; k <= j; k += 1) allowed.add(k); i = j; }
        continue;
      }
      if (cp === 0xFE0F) {
        if (EMOJI_RE.test(ch(cps[i - 1]))) allowed.add(i);
        continue;
      }
      if (cp === 0x200D) {
        let b = i - 1;
        while (b >= 0 && isEmojiTail(cps[b])) b -= 1;
        if (b >= 0 && PICTO_RE.test(ch(cps[b])) && PICTO_RE.test(ch(cps[i + 1]))) allowed.add(i);
        continue;
      }
      if (cp === 0x200C && joiners === 'text'
        && LETTER_OR_MARK_RE.test(ch(cps[i - 1])) && LETTER_RE.test(ch(cps[i + 1]))) allowed.add(i);
    }
  }
  for (let i = 0; i < cps.length; i += 1) {
    if (INVISIBLE_RE.test(ch(cps[i])) && !allowed.has(i)) return true;
  }
  return false;
}

// Duplicate-detection key for action names: NFKC folds compatibility forms
// (full-width letters, ligatures, …), default-ignorable code points are removed
// (defensive — validation already refuses them in action names), then
// lower-cased. Cross-script look-alikes (Cyrillic vs Latin) still differ.
export function actionNameKey(name) {
  return name.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase();
}

// [name, value] pairs of a query string or fragment ("a=1&b=2;c"), split on
// BOTH '&' and ';' (URLSearchParams only splits on '&', so "?x=1;api_key=…"
// would hide the second name), decoded best-effort.
function urlParamPairs(raw) {
  const str = raw.replace(/^[?#]/, '');
  if (!str) return [];
  const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
  return str.split(/[&;]/).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return i < 0 ? [dec(pair), ''] : [dec(pair.slice(0, i)), dec(pair.slice(i + 1))];
  });
}

function cardUrl(v, field) {
  const s = cardString(v, field, CREATE_CARD_LIMITS.url);
  if (s === undefined) return undefined;
  let u;
  try { u = new URL(s); } catch { throw bad(`${field} must be an absolute http(s) URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(`${field} must be an absolute http(s) URL`);
  if (u.username || u.password) throw bad(`${field} must not embed credentials`);
  // A secret can also ride in the query string or the fragment
  // (?api_key=…, ?x=1;sig=…, #access_token=…). Name the parameter, never its
  // value. Best-effort, value side: a token-shaped query value or path segment.
  for (const [name, value] of urlParamPairs(u.search)) {
    if (isSecretLikeKey(name)) throw secretFieldError(`URL query parameter "${name}" in ${field}`);
    if (looksLikeToken(value)) throw secretFieldError(`token-like value of URL query parameter "${name}" in ${field}`);
  }
  for (const [name] of urlParamPairs(u.hash)) {
    if (isSecretLikeKey(name)) throw secretFieldError(`URL fragment parameter "${name}" in ${field}`);
  }
  u.pathname.split('/').forEach((seg, i) => {
    let d = seg;
    try { d = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (seg && looksLikeToken(d)) throw secretFieldError(`token-like URL path segment #${i} in ${field}`);
  });
  if (u.hash) throw bad(`${field} must not have a #fragment`);
  // Echo the parsed, normalized form so the card shows the host that will
  // actually be used (e.g. "https://evil.com\\@good.com" → "https://evil.com/@good.com").
  const href = u.href;
  if ([...href].length > CREATE_CARD_LIMITS.url) throw bad(`${field} is too long (max ${CREATE_CARD_LIMITS.url} characters)`);
  return href;
}

// Default OAuth scopes: an array of non-empty strings (each a cardString, no
// invisible characters, no whitespace inside — RFC 6749 §3.3 scope tokens are
// space-delimited, so "contacts read" would read as two), no duplicates, at most
// CREATE_CARD_MAX_OAUTH_SCOPES. Absent / null / [] → omitted.
function cardScopes(v, field) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad(`${field} must be an array of strings`);
  if (v.length > CREATE_CARD_MAX_OAUTH_SCOPES) throw bad(`${field} has too many items (max ${CREATE_CARD_MAX_OAUTH_SCOPES})`);
  const out = v.map((item, i) => {
    if (typeof item !== 'string') throw bad(`${field}[${i}] must be a string`);
    const scope = cardString(item, `${field}[${i}]`, CREATE_CARD_LIMITS.oauth_scope, { required: true });
    if (/\s/.test(scope)) throw bad(`${field}[${i}] must be a single scope (no whitespace)`);
    return scope;
  });
  if (new Set(out).size !== out.length) throw bad(`${field} has duplicate items`);
  return out.length ? out : undefined;
}

function rejectUnknownKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw bad(`unknown field "${where}${k}" — allowed: ${[...allowed].join(', ')}`);
  }
}

// Validate + normalize the conn.create_card input. Pure (no network); throws
// {status:400} on the first problem. Returns {conversationId, connector,
// actions, application_id?} with trimmed strings and optional fields omitted
// when absent.
export function parseCreateCardInput(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('params object is required');
  assertNoSecretKeys(p);
  rejectUnknownKeys(p, CREATE_CARD_TOP_KEYS, '');
  const conversationId = requireTargetConversationId(p);

  const c = p.connector;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('connector object is required');
  rejectUnknownKeys(c, CREATE_CARD_CONNECTOR_KEYS, 'connector.');
  const connector = { name: cardString(c.name, 'connector.name', CREATE_CARD_LIMITS.name, { required: true, joiners: 'emoji' }) };
  const slug = cardString(c.slug, 'connector.slug', CREATE_CARD_LIMITS.slug, { required: true });
  if (!CONNECTOR_SLUG_RE.test(slug)) {
    throw bad('connector.slug must be lowercase letters/digits joined by "-" or "_" (no leading/trailing separator, max 64), e.g. "acme-crm" — and must be the exact slug you will pass to conn.app_import');
  }
  connector.slug = slug;
  if (typeof c.auth_type === 'string' && c.auth_type.trim().toLowerCase() === 'mcp') {
    throw bad('connector.auth_type "mcp" is not valid — MCP is a connector kind, not an auth type: send connector.connector_kind:"mcp" with no auth_type (and the server address in connector.server_url)');
  }
  if (!CREATE_CARD_KINDS.includes(c.connector_kind)) {
    throw bad(`connector.connector_kind is required: one of ${CREATE_CARD_KINDS.join(' | ')}`);
  }
  connector.connector_kind = c.connector_kind;
  const isMcp = connector.connector_kind === 'mcp';
  if (isMcp) {
    if (c.auth_type !== undefined) {
      throw bad('connector.auth_type is not used when connector_kind is "mcp" — an MCP connector\'s auth is decided when the user connects it; omit auth_type');
    }
  } else {
    if (!CREATE_CARD_AUTH_TYPES.includes(c.auth_type)) {
      throw bad(`connector.auth_type must be one of ${CREATE_CARD_AUTH_TYPES.join(' | ')} when connector_kind is "http"`);
    }
    connector.auth_type = c.auth_type;
  }
  // OAuth endpoint fields: only on an http + oauth2 card.
  if (connector.auth_type !== 'oauth2') {
    const present = CREATE_CARD_OAUTH_KEYS.find((k) => c[k] !== undefined);
    if (present) {
      throw bad(`connector.${present} is only allowed when connector_kind is "http" and auth_type is "oauth2"`);
    }
  } else {
    const authorizeUrl = cardUrl(c.oauth_authorize_url, 'connector.oauth_authorize_url');
    if (authorizeUrl !== undefined) connector.oauth_authorize_url = authorizeUrl;
    const tokenUrl = cardUrl(c.oauth_token_url, 'connector.oauth_token_url');
    if (tokenUrl !== undefined) connector.oauth_token_url = tokenUrl;
    const scopes = cardScopes(c.oauth_scopes_default, 'connector.oauth_scopes_default');
    if (scopes !== undefined) connector.oauth_scopes_default = scopes;
  }
  const iconUrl = cardUrl(c.icon_url, 'connector.icon_url');
  if (iconUrl !== undefined) connector.icon_url = iconUrl;
  const description = cardString(c.description, 'connector.description', CREATE_CARD_LIMITS.description, { joiners: 'text' });
  if (description !== undefined) connector.description = description;
  if (isMcp) {
    // MCP: the card shows the MCP server address (`server_url`) the user will
    // enter when they connect it, and lists no actions (the tools come from
    // the server).
    if (c.server_url !== undefined && c.mcp_server_url !== undefined && c.server_url !== c.mcp_server_url) {
      throw bad('connector.server_url and connector.mcp_server_url differ — send one of them');
    }
    const rawServerUrl = c.server_url ?? c.mcp_server_url;
    const field = c.server_url !== undefined ? 'connector.server_url' : 'connector.mcp_server_url';
    if (rawServerUrl === undefined || rawServerUrl === null || (typeof rawServerUrl === 'string' && rawServerUrl.trim() === '')) {
      throw bad('connector.server_url (the MCP server address, https) is required when connector_kind is "mcp"');
    }
    const serverUrl = cardUrl(rawServerUrl, field);
    if (!serverUrl.startsWith('https:')) throw bad(`${field} must be an https URL`);
    if (c.base_url !== undefined) throw bad('connector.base_url is not used when connector_kind is "mcp" — put the MCP server address in connector.server_url');
    connector.server_url = serverUrl;
    if (p.actions !== undefined && !(Array.isArray(p.actions) && p.actions.length === 0)) {
      throw bad('actions are not listed when connector_kind is "mcp" — an MCP connector\'s tools come from the MCP server; omit actions (or send [])');
    }
  } else {
    if (c.server_url !== undefined || c.mcp_server_url !== undefined) {
      throw bad('connector.server_url is only for connector_kind "mcp" — use connector.base_url for an http connector');
    }
    const baseUrl = cardUrl(c.base_url, 'connector.base_url');
    if (baseUrl !== undefined) connector.base_url = baseUrl;
  }

  const rawActions = isMcp ? [] : p.actions;
  if (!isMcp && (!Array.isArray(rawActions) || rawActions.length === 0)) throw bad('actions (non-empty list) is required');
  if (rawActions.length > CREATE_CARD_MAX_ACTIONS) throw bad(`at most ${CREATE_CARD_MAX_ACTIONS} actions per card`);
  const seenNames = new Set();
  const actions = rawActions.map((a, i) => {
    const where = `actions[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad(`${where} must be an object`);
    rejectUnknownKeys(a, CREATE_CARD_ACTION_KEYS, `${where}.`);
    const name = cardString(a.name, `${where}.name`, CREATE_CARD_LIMITS.action_name, { required: true });
    // Bare action segment, exactly what conn.app_import submits (the server
    // prepends "{slug}/").
    if (name.includes('/')) throw bad(`${where}.name must be the bare action name (no "/"; the server prepends the connector slug)`);
    const key = actionNameKey(name);
    if (seenNames.has(key)) throw bad(`${where}.name "${name}" is duplicated`);
    seenNames.add(key);
    if (!CREATE_CARD_EFFECTS.includes(a.effect)) throw bad(`${where}.effect must be one of ${CREATE_CARD_EFFECTS.join(' | ')}`);
    const summary = cardString(a.summary, `${where}.summary`, CREATE_CARD_LIMITS.action_summary, { required: true, joiners: 'emoji' });
    return { name, effect: a.effect, summary };
  });

  const out = { conversationId, connector, actions };
  const appId = p.application_id ?? p.applicationId;
  if (appId !== undefined && appId !== null && appId !== '') {
    if (!isUuid(appId)) throw bad('application_id must be a UUID');
    out.application_id = appId;
  }
  return out;
}

// Plain-text version for clients that do not render the card.
export function buildCreateCardFallbackText({ connector, actions }) {
  const lines = [
    `准备创建自定义连接器「${connector.name}」（${connector.slug}）`,
    `类型：${CREATE_CARD_KIND_LABELS[connector.connector_kind]}`,
  ];
  if (connector.auth_type) lines.push(`认证方式：${CREATE_CARD_AUTH_LABELS[connector.auth_type]}`);
  if (connector.description) lines.push(`说明：${connector.description}`);
  if (connector.connector_kind === 'mcp') {
    lines.push(`MCP 服务器地址：${connector.server_url}`);
    lines.push('工具由 MCP 服务器提供，无需逐个配置动作。');
    lines.push(`回复「确认创建 ${connector.name}」开始创建，或「我要改 ${connector.name}」修改。`);
    lines.push(`创建后下一步：在 openmax.com 的「应用连接」页面为「${connector.name}」新建连接，传输类型选「远程（Streamable HTTP）」，在「服务器 URL」填入上面的 MCP 服务器地址，按提示完成授权。`);
    return lines.join('\n');
  }
  if (connector.base_url) lines.push(`服务地址：${connector.base_url}`);
  if (connector.oauth_authorize_url) lines.push(`授权地址：${connector.oauth_authorize_url}`);
  if (connector.oauth_token_url) lines.push(`令牌地址：${connector.oauth_token_url}`);
  if (connector.oauth_scopes_default) lines.push(`Scopes：${connector.oauth_scopes_default.join(' ')}`);
  lines.push(`动作（${actions.length}）：`);
  for (const a of actions) lines.push(`- [${CREATE_CARD_EFFECT_LABELS[a.effect]}] ${a.name}：${a.summary}`);
  lines.push(`回复「确认创建 ${connector.name}」开始创建，或「我要改 ${connector.name}」修改。`);
  if (connector.auth_type === 'oauth2') {
    lines.push('Client Secret 请在「连接」页面填写，不要发在聊天里。');
  }
  return lines.join('\n');
}

// The copy rides as a `connector-create-card` context item (audience=ui;
// message context phase 2, the old metadata.connector_create_card key is no
// longer written). cws-comm registers this type with an 8 KiB data limit
// (JSON-encoded) and drops data over it. The copy is never cut: when the full
// copy is over the limit the item is not written at all, and the frontend
// falls back to fallback_text, which lists every action (the body keeps them
// all too). A partial action list would misstate what gets created.
export const CREATE_CARD_DATA_MAX_BYTES = 8 * 1024;

export function createCardMetadata(meta) {
  if (!fitsContextDataLimit(meta, CREATE_CARD_DATA_MAX_BYTES)) return undefined;
  return contextMetadata({ type: 'connector-create-card', audience: 'ui', data: meta });
}

// Pure builder. `input` is the parseCreateCardInput result; `cardId` is
// injectable for tests (defaults to a fresh UUID).
export function buildConnectorCreateCardMessage(input, cardId = randomUUID()) {
  const { connector, actions } = input;
  const fallbackText = buildCreateCardFallbackText(input);
  const body = {
    schema: CONNECTOR_CREATE_CARD_SCHEMA,
    card_id: cardId,
    connector: { ...connector },
    actions: actions.map((a) => ({ ...a })),
    ...(input.application_id ? { application_id: input.application_id } : {}),
    fallback_text: fallbackText,
  };
  // Compact render projection: what the card shows, nothing else (no
  // description / base_url / fallback_text — the full body is one GetMessage
  // away when the card is opened).
  const meta = {
    schema: CONNECTOR_CREATE_CARD_SCHEMA,
    card_id: cardId,
    connector: {
      name: connector.name,
      slug: connector.slug,
      connector_kind: connector.connector_kind,
      ...(connector.auth_type ? { auth_type: connector.auth_type } : {}),
      ...(connector.icon_url ? { icon_url: connector.icon_url } : {}),
      ...(connector.server_url ? { server_url: connector.server_url } : {}),
      // OAuth details: the pending card often has only this copy to render.
      ...(connector.oauth_authorize_url ? { oauth_authorize_url: connector.oauth_authorize_url } : {}),
      ...(connector.oauth_token_url ? { oauth_token_url: connector.oauth_token_url } : {}),
      ...(connector.oauth_scopes_default ? { oauth_scopes_default: [...connector.oauth_scopes_default] } : {}),
    },
    actions: actions.map((a) => ({ name: a.name, effect: a.effect, summary: a.summary })),
    ...(input.application_id ? { application_id: input.application_id } : {}),
  };
  const metadata = createCardMetadata(meta);
  return {
    client_msg_id: randomUUID(),
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'connector_create_card', body, attachments: [] },
    ...(metadata ? { metadata } : {}),
    fallback_text: fallbackText,
  };
}

// The one send path for the structured connector cards (auth_notice and
// create_card): POST the message into the target conversation. `post` is
// injectable for tests; production passes postForOrg.
// Module boundary for the card POST (tests replace `post` to observe that a
// command entry routes through sendConnectorCard).
export const connectorCardTransport = { post: (...args) => postForOrg(...args) };

export async function sendConnectorCard(orgId, conversationId, message, post = connectorCardTransport.post) {
  return post(orgId, apiPath(`/conversations/${conversationId}/messages`), message, { timeoutMs: 30_000, quietOnSuccess: true });
}

function messageIdOf(resp) {
  for (const v of [resp?.id, resp?.message_id, resp?.message?.id]) {
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// conn.auth_notice body: validate → resolve against the catalog → build → send
// through the shared card send path. Catalog readers and `post` are injectable
// for tests; production uses the org-scoped helpers.
export async function runAuthNotice(p, { resolveOrg, getApplication, listApplicationsPage, post } = {}) {
  const convId = requireTargetConversationId(p);
  const apps = parseAuthNoticeApps(p);
  const orgId = resolveOrg();
  const connectors = await resolveAuthNoticeConnectors(apps, {
    getApplication: getApplication
      || ((id) => getForOrg(orgId, apiPath(`/connect/applications/${encodeURIComponent(id)}`))),
    listApplicationsPage: listApplicationsPage || ((q, cursor) => getForOrgPage(
      orgId, apiPath('/connect/applications'),
      { query: q, limit: String(AUTH_NOTICE_PAGE_SIZE), ...(cursor ? { cursor } : {}) },
    )),
  });
  const message = buildConnectorAuthNoticeMessage(connectors);
  await sendConnectorCard(orgId, convId, message, post);
  return { status: 'sent', conversation_id: convId, connectors };
}

// Validate → build → send. Validation (incl. the secret-key refusal) runs before
// the org is resolved or anything is sent.
export async function runCreateCard(p, { resolveOrg, post, cardId } = {}) {
  const input = parseCreateCardInput(p);
  const orgId = resolveOrg();
  const message = buildConnectorCreateCardMessage(input, cardId);
  const resp = await sendConnectorCard(orgId, input.conversationId, message, post);
  return {
    status: 'sent',
    conversation_id: input.conversationId,
    card_id: message.content.body.card_id,
    message_id: messageIdOf(resp),
    connector: {
      name: input.connector.name,
      slug: input.connector.slug,
      connector_kind: input.connector.connector_kind,
      ...(input.connector.auth_type ? { auth_type: input.connector.auth_type } : {}),
      ...(input.connector.server_url ? { server_url: input.connector.server_url } : {}),
    },
    actions_total: input.actions.length,
  };
}

function connectionListOf(resp) {
  return Array.isArray(resp) ? resp : (Array.isArray(resp?.connections) ? resp.connections : []);
}

// --- personal-connector group guard: on/off switch ------------------------
//
// Off for now: group-chat connector behaviour changes are not enabled yet, so a
// personal connector keeps working in group conversations exactly as before
// 2.27.1. While false,
// conn.invoke does NOT refresh the index for an unknown ownerScope, does NOT
// look the conversation up, and never returns 403 personal_connector_in_group.
// All guard code (resolveGuardConversationType,
// personalConnectorBlockedInConversation) and its tests stay in place.
//
// TO RESTORE: set this to true, and put the Agent-facing docs back (the docs
// pin in conn.test.js switches with this constant and fails until you do):
//   - SKILL.md, after the `conn.invoke` reflex step 4, the paragraph
//     "**Personal connectors are for direct messages only.** …" (2.27.1 text);
//   - references/conn-operations.md, the section
//     "### Personal connectors — direct messages only (`conversationId`)" and
//     the "one conversation-dependent rule" sentence under conn.check
//     (2.27.1 text: `git show 220fb67:<file>`, the #192 merge).
//   - conn.test.js: drop the "guard switched OFF" tests (they pin this default).
export const GROUP_PERSONAL_CONNECTOR_GUARD_ENABLED = false;

// Test hook only: the subprocess tests set OPENMAX_TEST_FORCE_GROUP_GUARD=1 to
// exercise the guard while the constant is false. It can only turn the guard ON
// (stricter), never off.
export function groupPersonalConnectorGuardEnabled(env = process.env) {
  return GROUP_PERSONAL_CONNECTOR_GUARD_ENABLED || env?.OPENMAX_TEST_FORCE_GROUP_GUARD === '1';
}

// --- personal-connector group guard: effective conversation type ------------
//
// Contract (cws-core GET /api/v1/conversations/{id}, conversationItem.type):
// upper-case enum DM | GROUP | STRAT | BROADCAST | BRIDGE (STRAT is the renamed
// THREAD type). A reply inside a DM is a message in that same DM (message
// parent_id; cws-comm validates same-conversation), so its conversation reads
// as DM. A STRAT conversation (a thread) carries its parent conversation in
// `parent_id` (cws-comm Conversation.parent_id ← parent_conversation_id); we
// resolve it ONE hop to the parent's type so a thread inside a DM is not
// mistaken for a group. The caller may also pass a reply-via endpoint string
// (`<conv>|type:…|msg:…`) — only its leading conversation id (where the
// message arrived) is used.
//
// Returns the lower-cased effective type ('dm', 'group', …) or null when it
// cannot be confirmed (malformed id, lookup failure, no type, a thread with no
// resolvable parent) — the caller treats null as "not a DM" (fail-closed).
// `fetchConversation(id)` is injected for tests.
export async function resolveGuardConversationType(rawConversationId, fetchConversation) {
  if (typeof rawConversationId !== 'string' || !rawConversationId.trim()) return null;
  let convId;
  try { convId = parseEndpoint(rawConversationId).conversationId; } catch { return null; }
  if (!CONV_ID_RE.test(convId)) return null;
  const typeOf = (c) => (typeof c?.type === 'string' ? c.type.trim().toLowerCase() : '');
  const isThread = (t) => t === 'strat';
  let conv;
  try { conv = await fetchConversation(convId); } catch { return null; }
  let type = typeOf(conv);
  if (isThread(type)) {
    const parentId = [conv.parent_id, conv.parent_conversation_id, conv.parentId]
      .find((v) => typeof v === 'string' && v.trim());
    if (!parentId || !CONV_ID_RE.test(parentId) || parentId === convId) return null;
    let parent;
    try { parent = await fetchConversation(parentId); } catch { return null; }
    type = typeOf(parent);
    if (isThread(type)) return null; // one hop only: a thread's parent is never a thread
  }
  return type || null;
}

export const COMMANDS = {
  // List connections available to this agent.
  // Always uses the agent's own member_id (resolveSelfMemberId) — no
  // client-supplied override; see the security note above resolveSelfMemberId.
  'conn.list': () => {
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  },

  // conn.check {app} — read-only availability check for one app, so the agent
  // can answer the user in plain language BEFORE invoking. Returns
  //   { app, app_name, state, connection_ids }
  // where state is one of:
  //   - 'authorized'     → at least one active connection; go ahead
  //                         (connection_ids = the active ones)
  //   - 'not_authorized' → no connection for this app — send conn.auth_notice
  //   - 'needs_reauth'   → only expired / revoked / needs-reauth connections —
  //                         ask the user to re-authorize
  // No conversation id: the input-box connector switch is a preference
  // (OPENM-915), not a per-conversation gate, so nothing here depends on it.
  'conn.check': async () => {
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!app || typeof app !== 'string') throw bad('app (slug, name or applicationId) is required');
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    const all = connectionListOf(await getForOrg(orgId, apiPath('/connect/agents/me/connections')));
    const want = app.trim().toLowerCase();
    const matches = all.filter((c) => c && [c.application_slug, c.slug, c.provider, c.application_name, c.application_id, c.applicationId]
      .some((v) => typeof v === 'string' && v.toLowerCase() === want));
    if (matches.length === 0) return { app, app_name: null, state: 'not_authorized', connection_ids: [] };
    const appName = matches.find((c) => c.application_name)?.application_name || matches[0].application_slug || app;
    const idOf = (c) => c.id || c.connection_id;
    const isActive = (c) => (c.status || 'active') === 'active' && c.needs_reauth !== true && c.needsReauth !== true;
    const active = matches.filter(isActive);
    if (active.length) return { app, app_name: appName, state: 'authorized', connection_ids: active.map(idOf) };
    return { app, app_name: appName, state: 'needs_reauth', connection_ids: matches.map(idOf) };
  },

  // conn.auth_notice {conversationId, apps:[slug...]} — follow-up to
  // conn.check → not_authorized: post the structured "go authorize" card into
  // the given conversation (see buildConnectorAuthNoticeMessage). Validation
  // runs before any request.
  'conn.auth_notice': () => runAuthNotice(params, { resolveOrg: requireOrgId }),

  // conn.create_card {conversationId, connector:{name, slug, connector_kind,
  // auth_type? (http only), icon_url?, description?, base_url?, server_url?,
  // oauth_authorize_url? / oauth_token_url? / oauth_scopes_default? (http + oauth2 only)},
  // actions:[{name, effect, summary}], application_id?} — post the "create this
  // custom connector?" confirmation card (OPENM-836). connector_kind "mcp" has no
  // auth_type, requires connector.server_url (https) and lists no actions. Creates nothing; on the owner's confirmation the Agent runs
  // conn.app_import with the same slug + actions (mcp: connector_kind "mcp", no
  // actions). Secret-like keys anywhere → 400, nothing sent.
  'conn.create_card': () => runCreateCard(params, { resolveOrg: requireOrgId }),

  // Acquire a credential for a connection. This verb is DIRECT-only: it returns
  // credential_mode:'direct' + access_token for local egress. A proxy/Composio
  // connection has no local token to hand out (its acquire is rejected
  // server-side), so conn.acquire does not apply to it — but such connections
  // ARE invokable via conn.invoke, which routes proxy/Composio to server-side
  // execute (no local token needed).
  'conn.acquire': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return postForOrg(orgId, apiPath(`/connect/connections/${connId}/credential`));
  },

  // conn.proxy — REMOVED. The old free-form client-driven proxy verb is gone;
  // server-side execution is now reached only through conn.invoke's proxy route
  // (which auto-selects it by credential_mode). Kept as an explicit tombstone so
  // an old caller gets an actionable error pointing at conn.invoke instead of a
  // silent failure — there is NO client-driven proxy HTTP path left in this module.
  'conn.proxy': () => { throw proxyDeprecatedError('conn.proxy'); },

  // Discover the named actions available for a connection (action discovery).
  // Returns [{toolkit, action, method, description, params, input_schema}];
  // pair with conn.invoke to run one by "toolkit-slug/action-name". cws-core
  // scopes discovery to the caller's own connection-agent authorization
  // boundary (derived server-side).
  //
  // Composio note: this per-connection GET is a READ-ONLY discovery call — it
  // never persists a full action catalog (no writeCatalog), so it is already safe
  // for composio (proxy) connectors, which must not carry a full on-disk catalog.
  // Optional {cursor, limit} page through a large catalog; when the backend
  // reports more pages the result is { actions, next_cursor } (see
  // withNextCursor). For a big Composio catalog, prefer conn.actions_search.
  'conn.actions': async () => {
    const { path, query } = planConnActions(params);
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    const page = await getForOrgPage(orgId, path, query, { extraHeaders: capabilityHeaders() });
    return withNextCursor(page.data, page.next_cursor);
  },

  // conn.execute — REMOVED. This used to be a standalone verb that POSTed to the
  // server-side execute endpoint. That endpoint is still used — but now only via
  // conn.invoke's proxy/Composio route (POST /connect/connections/{id}/actions/
  // execute), selected automatically by credential_mode. Kept as an explicit
  // tombstone pointing at conn.invoke; no standalone execute verb remains here.
  'conn.execute': () => { throw proxyDeprecatedError('conn.execute'); },

  // Get connection details (status, owner, scopes, etc.).
  'conn.status': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    return getForOrg(orgId, apiPath(`/connect/connections/${connId}`));
  },

  // Discover the app-keyed action catalog for an application — the full set of
  // actions the app exposes, each with its input_schema, WITHOUT needing an
  // existing connection. Returns [{toolkit, action, method, description,
  // params, input_schema}]. Unlike conn.actions (connection-scoped and gated
  // on the connection-agent authorization boundary), this is capability
  // metadata readable by any org member — use it to see what an app can do
  // before a connection exists, or to build a per-application capability cache.
  // Resolved strictly by applicationId (the BFF route keys on the path id; it
  // does not accept a slug override, so URL identity always matches the result).
  // Optional {cursor, limit} page through the catalog exactly like conn.actions.
  'conn.app_actions': async () => {
    const { path, query } = planAppActions(params);
    const orgId = requireOrgId();
    const page = await getForOrgPage(orgId, path, query, { extraHeaders: capabilityHeaders() });
    return withNextCursor(page.data, page.next_cursor);
  },

  // Keyword search over an application's action catalog — the way to find the
  // right action in a Composio connector with hundreds of actions (one
  // conn.actions page only shows the first slice). {applicationId, query?,
  // cursor?, limit?}; returns the matching actions (same item shape as
  // conn.actions), plus next_cursor when more matches exist.
  'conn.actions_search': async () => {
    const { path, query } = planActionsSearch(params);
    const orgId = requireOrgId();
    const page = await getForOrgPage(orgId, path, query, { extraHeaders: capabilityHeaders() });
    return withNextCursor(page.data, page.next_cursor);
  },

  // Describe ONE action: the full action (incl. input_schema with required
  // param names/types). Search/list entries are lightweight (input_schema may
  // be empty), so the flow is conn.actions_search → conn.action_describe (the
  // chosen action only) → conn.invoke. {applicationId, action}.
  'conn.action_describe': () => {
    const { path } = planActionDescribe(params);
    const orgId = requireOrgId();
    return getForOrg(orgId, path, undefined, { extraHeaders: capabilityHeaders() });
  },

  // Return the platform's OAuth callback URL — the redirect URI to register in
  // your provider's OAuth app BEFORE creating a connector. cws-core forces the
  // callback URL server-side, so a user needs this value up-front. The endpoint
  // is authed (bearer) but NOT org-scoped; we call it via getForOrg so the org's
  // JWT authenticates the request (the org scoping is harmless — the route
  // ignores it). The D8 envelope is unwrapped by the client, so this resolves to
  // the inner `{ callback_url }` object, which we return as-is (matching how the
  // sibling read verbs echo their unwrapped data).
  'conn.callback': () => {
    return getForOrg(requireOrgId(), apiPath('/connect/oauth-callback-url'));
  },

  // List the caller's org custom connector applications — the way to enumerate
  // applicationIds WITHOUT an existing connection (contrast conn.list, which is
  // connection-scoped). Org-scoped exactly like the sibling read verbs: the org
  // is derived server-side from the authenticated principal (requireOrgId only
  // selects which org's JWT to use — org_id is NEVER sent as a client param).
  // Optional {category} is appended as a query filter. The D8 envelope's `data`
  // is an ARRAY of application items (same item shape conn.app_create/app_get
  // return); the client unwraps it, so this resolves to that array as-is.
  'conn.app_list': () => {
    let path = apiPath('/connect/applications');
    if (params.category !== undefined && params.category !== null && params.category !== '') {
      path += `?category=${encodeURIComponent(params.category)}`;
    }
    return getForOrg(requireOrgId(), path);
  },

  // --- Custom-connector management: applications ----------------------------
  // Each verb validates its params locally (pure planner, throws 400), then
  // resolves the operating org and routes through the org-scoped helper. Param
  // validation runs BEFORE requireOrgId(), matching conn.acquire/conn.app_actions.

  // Create a custom connector application. org_id/oauth_callback_url are never
  // forwarded (server-derived/injected) — the planner's allowlist drops them.
  'conn.app_create': () => {
    const { path, body } = planAppCreate(params);
    const orgId = requireOrgId();
    return postForOrg(orgId, path, body);
  },

  // Update the caller's own custom connector application (ownership-gated
  // server-side; slug/provider_type are immutable and not accepted).
  'conn.app_update': () => {
    const { path, body } = planAppUpdate(params);
    const orgId = requireOrgId();
    return patchForOrg(orgId, path, body);
  },

  // --- Custom-connector management: action definitions ----------------------
  // DB-backed HTTP action definitions (distinct from the resolved capability
  // catalog conn.app_actions returns). See references/conn-operations.md for the
  // method set, url_template placeholders, encoding values, input_schema, and the
  // forbidden Authorization header.

  'conn.actiondef_list': () => {
    const { path } = planActionDefList(params);
    const orgId = requireOrgId();
    return getForOrg(orgId, path);
  },

  'conn.actiondef_create': () => {
    const { path, body } = planActionDefCreate(params);
    const orgId = requireOrgId();
    return postForOrg(orgId, path, body);
  },

  'conn.actiondef_update': () => {
    const { path, body } = planActionDefUpdate(params);
    const orgId = requireOrgId();
    return patchForOrg(orgId, path, body);
  },

  'conn.actiondef_delete': () => {
    const { path } = planActionDefDelete(params);
    const orgId = requireOrgId();
    return delForOrg(orgId, path);
  },

  // Bulk onboard a custom connector from an import JSON: create the application,
  // then loop-create each action-def, reporting per-action success/failure so a
  // partial import is visible. Mirrors the cws-fe "actions JSON import" flow.
  'conn.app_import': () => {
    if (!params.application || typeof params.application !== 'object' || Array.isArray(params.application)) {
      throw Object.assign(new Error('application object is required'), { status: 400 });
    }
    const orgId = requireOrgId();
    return runAppImport(params, {
      createApp: (body) => postForOrg(orgId, apiPath('/connect/applications'), body),
      createActionDef: (appId, body) => postForOrg(orgId, apiPath(`/connect/applications/${appId}/action-defs`), body),
    });
  },

  // Cache-aware, app-keyed action catalog. Reads runtime/connect/action-catalog/
  // first and fills it from conn.app_actions on a miss / TTL-expiry / {refresh}.
  // Accepts either {applicationId} directly, or {app} (slug or id) resolved via
  // the local connections index. Returns { applicationId, actions, fetchedAt,
  // source }.
  'conn.catalog': async () => {
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    const idxPath = indexPathForOrg(orgId);
    let appId = params.applicationId || params.application_id;
    let entry = null;
    if (!appId && params.app) {
      entry = await resolveConnectionForApp(params.app, orgId, agentId);
      appId = entry?.applicationId || (isUuid(params.app) ? params.app : null);
    }
    if (!appId) throw Object.assign(new Error('applicationId (or a resolvable app) is required'), { status: 400 });
    // Decide whether to persist a full on-disk catalog. We must NEVER persist for
    // a proxy connector — so we persist ONLY when CONFIDENT the app is direct (its
    // taxonomy is known and not proxy). A LEGACY index entry that predates
    // credentialMode has UNKNOWN taxonomy: scanning it would (wrongly) look
    // non-proxy, so refresh once from conn.list (which now returns the taxonomy)
    // and re-decide. If STILL unknown after the refresh, stay conservative and do
    // NOT persist — a legacy entry could be proxy.
    // Decision inputs: the resolved entry when we have one, else the index entries
    // sharing this applicationId.
    const decide = () => {
      if (entry) return { proxy: isProxyEntry(entry), known: taxonomyKnown(entry) };
      const forApp = Object.values(readIndex(idxPath).connections || {}).filter((e) => e.applicationId === appId);
      return { proxy: forApp.some(isProxyEntry), known: forApp.some(taxonomyKnown) };
    };
    let { proxy, known } = decide();
    if (!proxy && !known && agentId) {
      await refreshIndex(orgId, agentId);
      if (entry) { const re = readIndex(idxPath).connections[entry.id]; if (re) entry = re; }
      ({ proxy, known } = decide());
    }
    // Persist only when confidently direct; proxy OR still-unknown → skip.
    return getCatalog(orgId, appId, { refresh: !!params.refresh, persist: known && !proxy });
  },

  // One-call app-keyed execute: resolve the connection for an application from
  // the local index (refreshing from conn.list on a miss), then run the named
  // action. This is the cache-aware entry meant for agents — it removes the
  // per-call discovery round-trip. Routed by the connector taxonomy recorded in
  // the index (credential_mode):
  //   - direct → LOCAL EGRESS: assemble the request from the local catalog's
  //     url_template + params, inject the locally-cached token (refreshing it on
  //     near-expiry / a provider 401), and call the provider from THIS host.
  //     Returns the provider passthrough { status_code, headers, body }.
  //   - proxy (e.g. composio) → SERVER-SIDE execute: the connection holds no
  //     local token and its acquire is rejected server-side, so we POST the
  //     action to cws-core's proxy execute endpoint, which resolves the action,
  //     injects the credential, and calls the provider. Returns the server
  //     passthrough { status_code, body } (no locally-observed response headers).
  //   - an unexpected mode → an explicit "unsupported" error (never a guess).
  // On an action/schema-shaped failure (direct path) it invalidates the cached
  // catalog once so the next conn.catalog is fresh, then resurfaces the error.
  'conn.invoke': async () => {
    // An explicit connectionId (alias connection_id) SKIPS app-resolution and
    // targets that connection directly — the one-command retry after a
    // needs_selection prompt (the user picked, we re-invoke by id). When absent,
    // resolution is app-driven and count-aware (0/1/>1).
    const explicitConnId = params.connectionId || params.connection_id;
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!explicitConnId && !app) throw Object.assign(new Error('app (slug or applicationId) is required unless connectionId is given'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });

    const idxPath = indexPathForOrg(orgId);
    // `let` — the credential_mode refresh below may re-read a fuller entry.
    const { entry: resolvedEntry, needsSelection } = await resolveInvokeEntry(
      { app, connectionId: explicitConnId, action: params.action },
      {
        findActives: (a) => findActiveConnectionsByApp(a, idxPath),
        findAny: (a) => findConnectionByApp(a, idxPath),
        readEntryById: (id) => readIndex(idxPath).connections[id] || null,
        refresh: () => refreshIndex(orgId, agentId),
      },
    );
    // >1 active for the app: return the candidate list (normal result, exit 0)
    // so the agent asks the user which one — never silently pick the first.
    if (needsSelection) return needsSelection;
    if (!resolvedEntry) throw Object.assign(new Error(`no connection found for app "${app}" (org ${orgId}, agent ${agentId})`), { status: 404 });
    // Mutable — the credential_mode legacy refresh below may re-read a fuller entry.
    let entry = resolvedEntry;

    // Prefer the caller's app for messages; when they invoked by connectionId
    // (no app), fall back to the resolved slug/id so hints stay meaningful.
    const appLabel = app || entry.slug || entry.id;

    // Reject ANY non-active connection BEFORE credential resolution — for BOTH
    // the app-resolved path (a 0-active fallback may surface a blocked entry) and
    // the explicit connectionId path (app-resolution bypassed). cws-connect list
    // responses can mark a connection needs_reauth / error / expired / revoked;
    // proceeding to acquire a credential for one of these fails opaquely, or worse
    // calls the provider with a dead token. needs_reauth (incl. the normalized
    // status:"error"+needs_reauth from toEntry) gets the specific re-authorize
    // hint; any other blocked status gets a generic actionable error. A reauth_needed
    // event also clears the cached credential (see connection-events.js), so an
    // acquire could not help until a human re-authorizes anyway.
    if (entry.status && entry.status !== 'active') {
      if (entry.status === 'needs_reauth') {
        throw Object.assign(
          new Error(`connection for app "${appLabel}" needs re-authorization — its credential expired or was revoked. 请到连接页点「重新授权」，完成后重试。`),
          { status: 409 },
        );
      }
      throw Object.assign(
        new Error(`connection for app "${appLabel}" is not usable (status: ${entry.status}) — it may be expired, revoked, or in an error state. Re-authorize it on the connection page, then retry.`),
        { status: 409 },
      );
    }

    // Personal connector ≠ group conversation (OPENM-815). A personal-scope
    // connector is the owner's PRIVATE credential: it must never execute in a
    // group conversation, where other members could trigger it. When the caller
    // passes the conversation it is acting in (conversationId, from this turn's
    // <message-context>), the conversation TYPE is read from the server — the
    // source of truth; we never trust an agent-supplied "is this a group" flag —
    // and anything not confirmed to be a DM is refused (fail-closed). org-scope
    // connectors are shared/admin-authorized and never look the conversation up.
    // No conversationId (Lark, scheduled tasks, automations) → no check here; the
    // server-side block in cws-connect is the hard guarantee.
    // Switched off while GROUP_PERSONAL_CONNECTOR_GUARD_ENABLED is false: no
    // index refresh, no conversation lookup, no refusal.
    const invokeConvId = params.conversationId ?? params.conversation_id ?? null;
    if (groupPersonalConnectorGuardEnabled() && invokeConvId != null && entry.ownerScope !== 'org') {
      // A sparse WS event may have left ownerScope null; refresh once so a stale
      // index cannot mask a personal connector (mirrors the credential_mode
      // self-heal below). Still unknown after that → treated as personal.
      if (entry.ownerScope == null) {
        await refreshIndex(orgId, agentId);
        const refreshed = readIndex(idxPath).connections[entry.id];
        if (refreshed) entry = refreshed;
      }
      if (entry.ownerScope !== 'org') {
        const convType = await resolveGuardConversationType(
          invokeConvId,
          (id) => getForOrg(orgId, apiPath(`/conversations/${id}`)),
        );
        if (personalConnectorBlockedInConversation(entry.ownerScope, convType)) {
          throw Object.assign(
            new Error(`connection for app "${appLabel}" is a personal connector and cannot be used in a group conversation — personal connectors only work in direct messages. Tell the user in their own language; use an org connector if one fits.`),
            { status: 403, code: 'personal_connector_in_group' },
          );
        }
      }
    }

    // Route by the connector taxonomy recorded in the index (credential_mode).
    let mode = entry.credentialMode;
    if (!mode) {
      // Stale / not-yet-refreshed entry: conn.list now returns credential_mode, so
      // refresh once and re-read — this self-heals a stale-but-valid entry. We
      // deliberately do NOT use `acquire` to detect the mode — a proxy acquire is
      // REJECTED server-side (ErrComposioNotAcquirable), so it cannot be a detector.
      // If the field is STILL absent after the refresh, the connection is a true
      // orphan (unresolvable app + no mode) and is treated as UNSUPPORTED below —
      // we never guess 'direct'.
      await refreshIndex(orgId, agentId);
      const refreshed = readIndex(idxPath).connections[entry.id];
      if (refreshed) entry = refreshed;
      mode = entry.credentialMode;
    }

    if (mode === 'proxy') {
      // Proxy (e.g. composio): no local token, no local catalog. Execute the
      // action SERVER-SIDE via cws-core's proxy execute endpoint (op
      // execute-connect-action) — cws-connect resolves the action, injects the
      // credential, and calls the provider. We never touch the credential cache
      // or getCatalog on this path. Result is the server passthrough
      // { status_code, body } (analogous to the direct path's { status_code,
      // headers, body }, minus locally-observed response headers).
      return await postForOrg(
        orgId,
        apiPath(`/connect/connections/${entry.id}/actions/execute`),
        { action: params.action, params: params.params || {} },
      );
    }

    if (mode === 'direct') {
      // Decide the path from the local credential cache, re-acquiring on a miss so
      // a direct connection with no cache file (authorized offline / runtime wiped
      // / conn.clear_cache) is not wrongly downgraded (cws-connect rejects a direct
      // connection on the proxy path with ErrDirectNotProxyable/422). See
      // resolveCredential.
      const { credential, mode: credMode } = await resolveCredential(
        { orgId, connectionId: entry.id, cached: readCredentialCache(entry.id) },
        {
          acquire: (oid, connId) => acquireCredential(oid, connId),
          saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
        },
      );
      if (credMode === 'direct') {
        if (!entry.applicationId) {
          throw Object.assign(new Error(`cannot run direct action for app "${appLabel}": applicationId unresolved (run conn.index {refresh:true})`), { status: 400 });
        }
        try {
          // The local catalog now carries per-action url_template/headers_template;
          // direct execution assembles the request from it (never a free-form URL).
          const catalogRec = await getCatalog(orgId, entry.applicationId, {});
          return await invokeDirect(
            { orgId, connection: entry, actionSlug: params.action, params: params.params || {}, catalog: catalogRec.actions, credential },
            {
              acquire: (oid, connId) => acquireCredential(oid, connId),
              saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
            },
          );
        } catch (err) {
          // Drop the cached catalog on an action/schema mismatch OR a 422 (a catalog
          // predating url_template — direct assembly can't proceed) so the agent's
          // next conn.catalog refetches. Re-thrown as-is (no auto-retry).
          if ((looksLikeActionOrSchemaError(err) || err.status === 422) && entry.applicationId) invalidateCatalog(entry.applicationId);
          throw err;
        }
      }
      // The index said direct but the acquired credential is not direct — an
      // inconsistent connection state. Fall through to the unsupported throw
      // rather than execute with a token we do not hold.
    }

    // Genuinely unexpected credential_mode (neither 'proxy' nor a direct-
    // acquirable connection). Surface an explicit, actionable error — we never
    // guess an execution path.
    throw Object.assign(
      new Error(`unsupported: connection ${entry.id} has an unexpected credential_mode (${mode}) — expected 'direct' (local egress) or 'proxy' (server-side execute).`),
      { status: 400 },
    );
  },

  // Show the local connections index for an org (observability). {refresh}
  // rebuilds it from conn.list first; {org} selects the org (default otherwise).
  'conn.index': async () => {
    const orgId = requireOrgId();
    if (params.refresh) {
      const agentId = resolveSelfMemberId(orgId);
      if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
      await refreshIndex(orgId, agentId);
    }
    const index = readIndex(indexPathForOrg(orgId));
    const connections = Object.values(index.connections);
    return { org_id: orgId, count: connections.length, connections };
  },

  // List locally cached credentials (metadata only; shared cache module).
  'conn.cached': () => {
    const entries = listCachedCredentials();
    return { count: entries.length, credentials: entries };
  },

  // Clear cached credentials (all or specific connection).
  'conn.clear_cache': () => {
    const connId = params.connectionId || params.connection_id;
    return { cleared: clearCachedCredentials(connId) };
  },
};

function printUsage() {
  console.log(`Connection CLI — cws-connect operations via cws-core BFF

Usage: node src/cli/conn.js <command> '<json-params>'

Connections
  conn.list           {}                                        # list connections available to this agent (self only)
  conn.check          {app}                                     # read-only: authorized | not_authorized | needs_reauth
  conn.auth_notice    {conversationId, apps:[slug...]}          # post the "go authorize" card into that conversation
  conn.create_card    {conversationId, connector:{name, slug, connector_kind (http|mcp), auth_type (http only: api_key|oauth2), icon_url?, description?, base_url? (http), server_url (mcp, https), oauth_authorize_url? / oauth_token_url? / oauth_scopes_default?:[string] (http + oauth2 only)}, actions:[{name, effect, summary}] (none for mcp), application_id?}
                                                                 # post the "create this custom connector?" confirmation card (creates nothing; no secrets)
  conn.acquire        {connectionId}                            # acquire the direct access_token for a connection
  conn.actions        {connectionId, cursor?, limit?}           # discover named actions for a connection (paged: next_cursor → cursor)
  conn.status         {connectionId}                            # get connection details (status, owner, scopes)

Applications
  conn.app_actions    {applicationId, cursor?, limit?}          # app-keyed action catalog (incl. input_schema; no connection needed; paged)
  conn.actions_search {applicationId, query?, cursor?, limit?}  # keyword-search an app's actions (use first for big Composio catalogs)
  conn.action_describe {applicationId, action}                 # full schema (input_schema) of ONE action — describe the chosen search hit before conn.invoke
  conn.app_list       {category?}                                   # list your org's custom connector applications (GET /connect/applications)
  conn.callback       {}                                        # platform OAuth callback URL to register in the provider's OAuth app

Applications (custom connector management)
  conn.app_create     {display_name, connector_kind?, auth_type, slug?, ...} # create a custom connector application (slug optional — server-generated when omitted; connector_kind http (default)|mcp; auth_type api_key|oauth2 for http (alias provider_type) — mcp: no auth_type, provider_type defaults to api_key)
  conn.app_update     {applicationId, ...optional}              # update your own custom connector (slug/provider_type immutable; OAuth id/secret/scopes updatable)
  conn.actiondef_list   {applicationId}                         # list an app's HTTP action definitions
  conn.actiondef_create {applicationId, name, method, url_template, description, headers?, encoding?, input_schema?}  # description REQUIRED
  conn.actiondef_update {applicationId, actionId, method?, url_template?, description?, headers?, encoding?, input_schema?}
  conn.actiondef_delete {applicationId, actionId}               # delete one action definition
  conn.app_import     {application:{...}, actions:[...]}        # bulk: create app then each action-def (per-action report)
                                                                 #   never forward org_id/oauth_callback_url (server-derived);
                                                                 #   action-def Authorization header is forbidden (see reference doc)

Capability cache (runtime/connect/)
  conn.invoke         {app, action, params?, conversationId?}   # app-keyed execute: resolve connection via local index → execute; conversationId: the OpenMax conversation (personal-connector group guard currently off)
                      {connectionId, action, params?}           #   or target a specific connection (skips app-resolution)
                                                                 #   >1 connections for an app → returns needs_selection (ask
                                                                 #   the user by candidate label; map the choice back to its
                                                                 #   connection_id, retry with connectionId)
  conn.catalog        {app|applicationId, refresh?}             # cached action catalog (fills from conn.app_actions on miss/TTL)
  conn.index          {refresh?}                                # show the local connections index (connection → application)

Local cache
  conn.cached         {}                                        # list locally cached credentials (direct-mode tokens)
  conn.clear_cache    {connectionId?}                           # clear cached credentials (all if no connectionId)

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    if (err.code) payload.code = err.code;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (node src/cli/conn.js …). Guarding this
// lets the module be imported by tests to exercise the pure helpers
// (buildNeedsSelection / resolveInvokeEntry) without executing a command.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
