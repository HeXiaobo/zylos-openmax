/**
 * Meta (Facebook) Page access-token exchange for direct-mode execution (B2).
 *
 * Page-scoped Graph endpoints (Page feed/photos/videos, comments, Page/post
 * insights, conversations, Send API, private replies) require a PAGE access
 * token, while a Meta connection only holds the USER (or BISU) token. Rather
 * than let the LLM copy page tokens around (they never expire when derived from
 * a long-lived user token), the executor derives the page token itself, right
 * before the call, so it never leaves this process.
 *
 * Opt-in per action through a RESERVED header in the action's seeded
 * `headers` (published to the agent as `headers_template`):
 *
 *   X-Openmax-Token-Exchange: meta_page:<param>      page id is params[<param>]
 *   X-Openmax-Token-Exchange: meta_ig_page:<param>   IG user id is params[<param>];
 *                                                    the token is that of the Page
 *                                                    the IG account is linked to
 *
 * The header is a control directive for the executor only: assembleRequest
 * strips it so it never reaches the provider. An action without it is executed
 * exactly as before.
 *
 * SECURITY:
 *   - The exchange only ever talks to the fixed origin https://graph.facebook.com
 *     (never a caller/LLM URL), the id is validated as numeric before it is put
 *     in the path, and redirects are not followed.
 *   - The action using the marker must itself target https://graph.facebook.com,
 *     so a (custom) catalog entry cannot use the marker to send a derived page
 *     token to another host, and the main request carrying the page token is
 *     sent with redirect:'manual' (a 3xx is returned as-is, never followed).
 *   - Tokens are never logged or put in error messages (errors carry Graph's
 *     error code/type/message, scrubbed of any token string, and the page/IG id).
 *
 * Cache: keyed by (connection id, sha256 of the user token, kind, id), TTL
 * DEFAULT_PAGE_TOKEN_TTL_MS. Keying on the user-token hash means a
 * refreshed/reconnected user token never reuses a page token derived from the
 * old one. Entries are invalidated when Graph rejects the page token (code 190).
 * `conn.invoke` runs as a short-lived CLI process, so the default cache
 * (FilePageTokenCache) persists to `<CREDENTIALS_DIR>/<connectionId>.page-tokens.json`
 * next to the connection's credential file, with the same protection: dir 0700,
 * file 0600, atomic tmp+rename writes, expired entries pruned on every write.
 * The file is read on every lookup (no in-process layer), so an invalidation by
 * one process is seen by the next. All file IO is best-effort: a cache failure
 * never fails an invoke, it only costs an extra exchange. The file is removed
 * with the credential (deleteCredentialCache: revoke / needs_reauth /
 * conn.clear_cache), leftover `<connectionId>.page-tokens.json.<pid>.<rand>.tmp`
 * files included. Because that deletion runs in another process (comm-bridge)
 * and may land while an exchange is in flight, every write first checks that
 * `<connectionId>.json` still exists and still holds the user token the entries
 * were derived from (key hash); otherwise nothing is written and the page-token
 * file is removed. The check is repeated before and after the rename.
 * PageTokenCache (in-memory) remains for tests / injection.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CREDENTIALS_DIR, PAGE_TOKENS_SUFFIX, credentialPath, deletePageTokenCache, isPageTokensTmpFile, pageTokensPath,
} from './credential-cache.js';

export const TOKEN_EXCHANGE_HEADER = 'X-Openmax-Token-Exchange';
export const META_GRAPH_ORIGIN = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v26.0';
export const DEFAULT_PAGE_TOKEN_TTL_MS = 45 * 60 * 1000;
// /me/accounts pagination guard for the IG → Page lookup (100 Pages per page).
export const MAX_ACCOUNTS_PAGES = 10;

const KINDS = new Set(['meta_page', 'meta_ig_page']);
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const GRAPH_ID_RE = /^[0-9]{1,32}$/;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Case-insensitive lookup of the marker header in an action's headers_template. */
export function findExchangeMarker(actionDef) {
  const ht = actionDef && actionDef.headers_template;
  if (!ht || typeof ht !== 'object') return null;
  const lower = TOKEN_EXCHANGE_HEADER.toLowerCase();
  for (const [k, v] of Object.entries(ht)) {
    if (k.toLowerCase() === lower) return v == null ? '' : String(v);
  }
  return null;
}

export function isExchangeHeaderName(name) {
  return String(name).toLowerCase() === TOKEN_EXCHANGE_HEADER.toLowerCase();
}

/**
 * Parse the marker value "<kind>:<param>". Throws 422 on anything malformed or
 * unknown: the catalog asks for an exchange this executor does not understand,
 * so we fail closed rather than silently send the user token.
 */
export function parseExchangeMarker(value) {
  const m = /^\s*([a-z_]+)\s*:\s*([A-Za-z0-9_]+)\s*$/.exec(String(value || ''));
  if (!m || !KINDS.has(m[1]) || !PARAM_NAME_RE.test(m[2])) {
    throw httpError(422,
      `action declares an unsupported ${TOKEN_EXCHANGE_HEADER} value "${String(value).slice(0, 80)}" `
      + '(expected "meta_page:<param>" or "meta_ig_page:<param>") — this zylos-openmax may be too old for this catalog');
  }
  return { kind: m[1], param: m[2] };
}

/**
 * Validate a Graph object id coming from params. Strings of digits only; a JS
 * number is accepted only when it is a safe integer (IG user ids are 17 digits
 * and lose precision as numbers, so they must be passed as strings).
 */
export function validateGraphId(value, param) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw httpError(400, `param "${param}" must be a numeric Graph id passed as a string (number is not a safe integer)`);
    }
    return String(value);
  }
  if (typeof value !== 'string' || !GRAPH_ID_RE.test(value)) {
    throw httpError(400, `param "${param}" must be a numeric Graph id (digits only) — required to derive the Page access token`);
  }
  return value;
}

/** The action's Graph API version ("/v26.0/"), else DEFAULT_GRAPH_VERSION. */
export function graphVersionOf(urlTemplate) {
  const m = /^https:\/\/graph\.facebook\.com\/(v\d+\.\d+)\//.exec(String(urlTemplate || ''));
  return m ? m[1] : DEFAULT_GRAPH_VERSION;
}

/** True when a url_template / URL targets exactly https://graph.facebook.com. */
export function isGraphOrigin(url) {
  try { return new URL(String(url)).origin === META_GRAPH_ORIGIN; } catch { return false; }
}

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

/** Replace any occurrence of the given secrets in a string (defense in depth). */
export function scrubTokens(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    if (s && typeof s === 'string' && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/** A Graph JSON error object `{error:{code,...}}` from a normalized response, or null. */
export function graphError(result) {
  const b = result && result.body;
  return b && typeof b === 'object' && b.error && typeof b.error === 'object' ? b.error : null;
}

/** Graph rejected the token itself (invalid / expired / revoked): code 190. */
export function isGraphTokenError(result) {
  const e = graphError(result);
  return !!e && Number(e.code) === 190;
}

/**
 * In-memory TTL cache for derived page tokens and IG→Page mappings. Base of
 * FilePageTokenCache (the persistent default) and injectable in tests.
 */
export class PageTokenCache {
  constructor({ ttlMs = DEFAULT_PAGE_TOKEN_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  key(connId, userToken, kind, id) {
    return `${connId}|${tokenHash(userToken)}|${kind}|${id}`;
  }

  get(k) {
    const e = this.map.get(k);
    if (!e) return null;
    if (e.expiresAt <= this.now()) { this.map.delete(k); return null; }
    return e.value;
  }

  set(k, value) {
    this.map.set(k, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Set several `[key, value]` pairs at once (one write for file-backed caches). */
  setMany(pairs) { for (const [k, v] of pairs) this.set(k, v); }

  delete(k) { this.map.delete(k); }

  clear() { this.map.clear(); }
}

// Connection ids become file names; anything that is not a plain id (path
// separators, leading dot, …) is simply not persisted.
const SAFE_CONN_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const PAGE_TOKENS_FILE_VERSION = 1;

/**
 * File-backed page-token cache (the default for conn.invoke): one JSON file per
 * connection, `<dir>/<connectionId>.page-tokens.json`, shape
 * `{ version: 1, entries: { <key>: { value, expiresAt } } }`. Same key scheme
 * and TTL as PageTokenCache. Every operation is best-effort and silent on IO
 * errors: a miss just means the resolver exchanges again.
 */
export class FilePageTokenCache extends PageTokenCache {
  constructor({ dir = CREDENTIALS_DIR, ttlMs = DEFAULT_PAGE_TOKEN_TTL_MS, now = Date.now } = {}) {
    super({ ttlMs, now });
    this.dir = dir;
    this.map = null; // unused: the file is the store
  }

  connIdOf(k) { return String(k).split('|', 1)[0]; }

  fileFor(k) {
    const connId = this.connIdOf(k);
    return SAFE_CONN_ID_RE.test(connId) ? pageTokensPath(connId, this.dir) : null;
  }

  // Hash of the user token currently in the connection's credential file, or
  // null when the file is gone / unreadable / has no token. Page tokens may
  // only be persisted while the credential they were derived from is still the
  // live one: comm-bridge (another process) may delete or rewrite it — revoke,
  // needs_reauth, re-auth — while an exchange is in flight in conn.invoke.
  liveUserTokenHash(connId) {
    try {
      const cred = JSON.parse(fs.readFileSync(credentialPath(connId, this.dir), 'utf8'));
      return cred && typeof cred.access_token === 'string' && cred.access_token ? tokenHash(cred.access_token) : null;
    } catch { return null; }
  }

  // Drop a connection's page-token file and any leftover tmp files.
  purge(connId) { deletePageTokenCache(connId, this.dir); }

  // Valid, unexpired entries of a file ({} when absent / unreadable / malformed).
  readEntries(file) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
    const raw = data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : {};
    const t = this.now();
    const out = {};
    for (const [k, e] of Object.entries(raw)) {
      if (e && typeof e === 'object' && typeof e.value === 'string' && e.value
        && typeof e.expiresAt === 'number' && e.expiresAt > t) out[k] = { value: e.value, expiresAt: e.expiresAt };
    }
    return out;
  }

  /**
   * Persist `entries` for one connection, guarded against the credential being
   * revoked / re-authorized concurrently: only entries keyed on the hash of the
   * user token CURRENTLY in `<connId>.json` are kept; if the credential is gone
   * (or nothing matches) the page-token file and its tmp files are removed
   * instead. The check is repeated right before the rename, and once more
   * after it — if the credential vanished in between, the just-written file is
   * deleted, so a revoke can never leave page tokens behind.
   */
  writeEntries(file, connId, entries) {
    try {
      const live = this.liveUserTokenHash(connId);
      const kept = {};
      if (live) {
        for (const [k, e] of Object.entries(entries)) if (String(k).split('|')[1] === live) kept[k] = e;
      }
      if (Object.keys(kept).length === 0) { this.purge(connId); return; }
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(this.dir, 0o700); } catch {}
      // Deterministic prefix `<connId>.page-tokens.json.` so cleanup
      // (deletePageTokenCache / clear) can find a tmp left by a crash.
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ version: PAGE_TOKENS_FILE_VERSION, entries: kept }), { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch {}
        if (this.liveUserTokenHash(connId) !== live) { this.purge(connId); return; }
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
      if (this.liveUserTokenHash(connId) !== live) this.purge(connId);
    } catch {}
  }

  // Read-modify-write one file (readEntries already prunes expired entries).
  update(file, connId, fn) {
    const entries = this.readEntries(file);
    fn(entries);
    this.writeEntries(file, connId, entries);
  }

  get(k) {
    const file = this.fileFor(k);
    if (!file) return null;
    const e = this.readEntries(file)[k];
    return e ? e.value : null;
  }

  set(k, value) { this.setMany([[k, value]]); }

  setMany(pairs) {
    const byFile = new Map();
    for (const [k, v] of pairs) {
      const file = this.fileFor(k);
      if (!file || typeof v !== 'string' || !v) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push([k, v]);
    }
    const expiresAt = this.now() + this.ttlMs;
    for (const [file, list] of byFile) {
      this.update(file, this.connIdOf(list[0][0]), (entries) => { for (const [k, v] of list) entries[k] = { value: v, expiresAt }; });
    }
  }

  delete(k) {
    const file = this.fileFor(k);
    if (file) this.update(file, this.connIdOf(k), (entries) => { delete entries[k]; });
  }

  clear() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch {}
    for (const n of names) {
      if (n.endsWith(PAGE_TOKENS_SUFFIX) || isPageTokensTmpFile(n)) { try { fs.unlinkSync(path.join(this.dir, n)); } catch {} }
    }
  }
}

export const defaultPageTokenCache = new FilePageTokenCache();

/**
 * Derives Page tokens for one invoke. Holds the user credential's token and an
 * injected `graphGet(url, userToken)` that performs a GET against the fixed
 * Graph origin and returns the normalized `{status_code, body}`.
 */
export function createPageTokenResolver({ connId, cache = defaultPageTokenCache, graphGet, version = DEFAULT_GRAPH_VERSION, audit = () => {} }) {
  const base = `${META_GRAPH_ORIGIN}/${version}`;

  function failure(kind, id, result, userToken, fallbackMsg) {
    const e = graphError(result);
    const what = kind === 'meta_page' ? `Facebook Page ${id}` : `the Facebook Page linked to Instagram account ${id}`;
    if (e && Number(e.code) === 190) {
      return Object.assign(
        httpError(401, `Meta user token was rejected while deriving the Page access token for ${what} (Graph code 190: ${scrubTokens(e.message, [userToken])}) — the connection must be re-authorized`),
        { graphTokenInvalid: true },
      );
    }
    const detail = e ? ` (Graph error code ${e.code}${e.type ? ` ${e.type}` : ''}: ${scrubTokens(e.message, [userToken])})` : '';
    return httpError(403,
      `cannot act as ${what}: ${fallbackMsg}${detail}. The connected Meta account must have a task/role on that Page `
      + 'and the Page must have been granted during Facebook Login for Business. Use meta_account/list_pages to see the Pages this connection can manage.');
  }

  async function pageToken(userToken, pageId, { force = false } = {}) {
    const k = cache.key(connId, userToken, 'page', pageId);
    if (!force) {
      const hit = cache.get(k);
      if (hit) { audit(`[conn.direct] page-token cache hit page=${pageId} conn=${connId}`); return hit; }
    }
    audit(`[conn.direct] page-token exchange GET ${META_GRAPH_ORIGIN}/${version}/{page_id}?fields=access_token page=${pageId} conn=${connId}`);
    const res = await graphGet(`${base}/${pageId}?fields=access_token`, userToken);
    const tok = res && res.status_code === 200 && res.body && typeof res.body === 'object' ? res.body.access_token : null;
    if (typeof tok !== 'string' || !tok) {
      throw failure('meta_page', pageId, res, userToken, 'no Page access token was returned for this Page');
    }
    cache.set(k, tok);
    audit(`[conn.direct] page-token derived page=${pageId} conn=${connId} len=${tok.length}`);
    return tok;
  }

  async function igPageToken(userToken, igUserId, { force = false } = {}) {
    const mapKey = cache.key(connId, userToken, 'ig', igUserId);
    if (!force) {
      const pageId = cache.get(mapKey);
      if (pageId) {
        const hit = cache.get(cache.key(connId, userToken, 'page', pageId));
        if (hit) { audit(`[conn.direct] page-token cache hit ig=${igUserId} page=${pageId} conn=${connId}`); return hit; }
      }
    }
    audit(`[conn.direct] page-token exchange GET ${META_GRAPH_ORIGIN}/${version}/me/accounts (ig lookup) ig=${igUserId} conn=${connId}`);
    let after = null;
    for (let i = 0; i < MAX_ACCOUNTS_PAGES; i += 1) {
      const url = `${base}/me/accounts?fields=id,access_token,instagram_business_account&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const res = await graphGet(url, userToken);
      if (!res || res.status_code !== 200 || !res.body || typeof res.body !== 'object' || !Array.isArray(res.body.data)) {
        throw failure('meta_ig_page', igUserId, res, userToken, 'listing the Pages of the connected account failed');
      }
      let found = null;
      const pairs = [];
      for (const p of res.body.data) {
        const pid = p && typeof p.id === 'string' && GRAPH_ID_RE.test(p.id) ? p.id : null;
        if (!pid || typeof p.access_token !== 'string' || !p.access_token) continue;
        pairs.push([cache.key(connId, userToken, 'page', pid), p.access_token]);
        const iga = p.instagram_business_account && p.instagram_business_account.id;
        if (typeof iga === 'string' && GRAPH_ID_RE.test(iga)) {
          pairs.push([cache.key(connId, userToken, 'ig', iga), pid]);
          if (iga === igUserId) found = { pid, tok: p.access_token };
        }
      }
      // One write per /me/accounts page for a file-backed cache.
      if (typeof cache.setMany === 'function') cache.setMany(pairs);
      else for (const [k, v] of pairs) cache.set(k, v);
      if (found) {
        audit(`[conn.direct] page-token derived ig=${igUserId} page=${found.pid} conn=${connId} len=${found.tok.length}`);
        return found.tok;
      }
      const cur = res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
      if (!res.body.paging || !res.body.paging.next || typeof cur !== 'string' || !cur) break;
      after = cur;
    }
    throw failure('meta_ig_page', igUserId, null, userToken,
      'no managed Page with a Page access token is linked to this Instagram account');
  }

  /** Drop the cached page token for a target (after Graph code 190 on the real call). */
  function invalidate(userToken, kind, id) {
    if (kind === 'meta_page') {
      cache.delete(cache.key(connId, userToken, 'page', id));
      return;
    }
    const mapKey = cache.key(connId, userToken, 'ig', id);
    const pageId = cache.get(mapKey);
    if (pageId) cache.delete(cache.key(connId, userToken, 'page', pageId));
    cache.delete(mapKey);
  }

  return {
    resolve(userToken, kind, id, opts) {
      return kind === 'meta_page' ? pageToken(userToken, id, opts) : igPageToken(userToken, id, opts);
    },
    invalidate,
  };
}
