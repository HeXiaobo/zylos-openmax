/**
 * Local cache for cws-connect credentials acquired by this agent.
 *
 * One file per connection: `<CREDENTIALS_DIR>/<connectionId>.json`. Direct-mode
 * connections cache a real access_token, so files/dir are kept owner-only
 * (0600 / 0700). Records are enriched with the `provider` slug (from the
 * connection event) so the cache is addressable by third-party component — the
 * acquire response carries no provider id and the filename is only the UUID.
 *
 * Shared single source for the event-driven writer (comm-bridge) and the
 * `conn` CLI reader, so both agree on layout, permissions, and shape.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

// Lives under the consolidated runtime/connect/ subtree alongside the index and
// action-catalog caches (see connect-store.js). Only direct/token-mode
// connections cache a real access_token here; proxy-mode connections store
// nothing (the token is injected server-side and never leaves cws-connect).
export const CREDENTIALS_DIR = path.join(RUNTIME_DIR, 'connect', 'credentials');

// Pre-consolidation location — credentials used to live directly under runtime/.
// Files are migrated into CREDENTIALS_DIR once, best-effort, on first ensure.
const LEGACY_CREDENTIALS_DIR = path.join(RUNTIME_DIR, 'credentials');

export function credentialPath(connectionId, dir = CREDENTIALS_DIR) {
  return path.join(dir, `${connectionId}.json`);
}

// Sidecar file holding the B2 Meta Page tokens derived from a connection's user
// token (written by meta-page-token.js FilePageTokenCache). It lives next to the
// credential file, so every reader that enumerates `*.json` here must skip it —
// use isCredentialFile(), never a bare `.endsWith('.json')`.
export const PAGE_TOKENS_SUFFIX = '.page-tokens.json';

export function pageTokensPath(connectionId, dir = CREDENTIALS_DIR) {
  return path.join(dir, `${connectionId}${PAGE_TOKENS_SUFFIX}`);
}

/** True for a `<connectionId>.json` credential file (not a page-token sidecar / tmp file). */
export function isCredentialFile(name) {
  return name.endsWith('.json') && !name.endsWith(PAGE_TOKENS_SUFFIX);
}

function isPageTokensFile(name) {
  return name.endsWith(PAGE_TOKENS_SUFFIX);
}

// Atomic writes of the sidecar go through `<connectionId>.page-tokens.json.<pid>.<rand>.tmp`;
// a crash between write and rename can leave one behind (it holds page tokens).
const PAGE_TOKENS_TMP_RE = /\.page-tokens\.json\.[0-9]+\.[0-9a-f]+\.tmp$/;

/** True for a leftover page-token tmp file (any connection). */
export function isPageTokensTmpFile(name) {
  return PAGE_TOKENS_TMP_RE.test(name);
}

function pageTokensTmpIdOf(name) {
  return isPageTokensTmpFile(name) ? name.replace(PAGE_TOKENS_TMP_RE, '') : null;
}

/**
 * Best-effort removal of a connection's derived Meta Page-token file and of any
 * leftover tmp file of it.
 */
export function deletePageTokenCache(connectionId, dir = CREDENTIALS_DIR) {
  try { fs.unlinkSync(pageTokensPath(connectionId, dir)); } catch {}
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (pageTokensTmpIdOf(n) === String(connectionId)) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
  }
}

/**
 * One-time move of any pre-consolidation credential files from runtime/credentials
 * into the new runtime/connect/credentials. Idempotent and best-effort: only runs
 * for the default dir, never overwrites a newer file, and removes the empty legacy
 * dir when done. Silent on any error (a failed migration must not break acquire).
 */
export function migrateLegacyCredentials(dir = CREDENTIALS_DIR) {
  if (dir !== CREDENTIALS_DIR || LEGACY_CREDENTIALS_DIR === CREDENTIALS_DIR) return;
  let legacyFiles;
  try {
    legacyFiles = fs.readdirSync(LEGACY_CREDENTIALS_DIR).filter(isCredentialFile);
  } catch {
    return; // legacy dir absent — nothing to migrate
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of legacyFiles) {
      const src = path.join(LEGACY_CREDENTIALS_DIR, f);
      const dst = path.join(dir, f);
      try {
        if (fs.existsSync(dst)) fs.unlinkSync(src); // new location wins
        else fs.renameSync(src, dst);
      } catch {}
    }
    try { fs.rmdirSync(LEGACY_CREDENTIALS_DIR); } catch {} // only succeeds when empty
  } catch {}
}

export function ensureCredentialsDir(dir = CREDENTIALS_DIR) {
  // mkdir mode only applies on creation; chmod an already-existing dir too so a
  // pre-existing looser-perm dir gets tightened (best-effort).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  migrateLegacyCredentials(dir);
}

/**
 * Persist an acquired credential. The full acquire record is stored verbatim, so
 * every field round-trips — including `url_placeholders` (connection-owned
 * NON-secret URL parts like a self-hosted connector's `base_url`), which
 * direct-mode execution needs to fill `{base_url}`-style url_template tokens.
 * `provider` (application slug) is folded in additively — it is not overwritten
 * if the record already carries one, and older caches without it still parse.
 */
export function saveCredentialCache(connectionId, data, provider, dir = CREDENTIALS_DIR) {
  ensureCredentialsDir(dir);
  const record = provider && !data?.provider ? { ...data, provider } : data;
  const file = credentialPath(connectionId, dir);
  // writeFileSync mode only applies on creation; chmod an existing file too to
  // keep the token owner-only.
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * Drop a connection's credential file AND its derived Meta Page tokens: every
 * caller (revoke, needs_reauth, credential gone, conn.clear_cache) means the
 * user token is no longer to be used, so tokens derived from it go too.
 */
export function deleteCredentialCache(connectionId, dir = CREDENTIALS_DIR) {
  try { fs.unlinkSync(credentialPath(connectionId, dir)); } catch {}
  deletePageTokenCache(connectionId, dir);
}

/**
 * Read the FULL cached credential record for a connection (including the real
 * access_token, expires_at, credential_mode, provider). Returns null when no
 * cache file exists. Unlike listCachedCredentials (metadata only), direct-mode
 * execution needs the token itself, so this returns the raw record — callers
 * must never log it (see redact.js / direct-exec audit).
 */
export function readCredentialCache(connectionId, dir = CREDENTIALS_DIR) {
  try {
    return JSON.parse(fs.readFileSync(credentialPath(connectionId, dir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a local credential file exists for a connection. Only direct/token-mode
 * connections have one, so this doubles as "is this a direct connection we track?"
 * — used by the `credential_updated` handler, whose upstream event does not carry
 * credential_mode.
 */
export function hasCredentialCache(connectionId, dir = CREDENTIALS_DIR) {
  return fs.existsSync(credentialPath(connectionId, dir));
}

/** List locally cached credentials (metadata only; never returns the token). */
export function listCachedCredentials(dir = CREDENTIALS_DIR) {
  migrateLegacyCredentials(dir);
  let files;
  try {
    files = fs.readdirSync(dir).filter(isCredentialFile);
  } catch {
    return [];
  }
  return files.map((f) => {
    const connId = f.slice(0, -'.json'.length);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        connection_id: connId,
        provider: data.provider || null,
        credential_mode: data.credential_mode || '?',
        has_access_token: !!data.access_token,
        has_proxy_ref: !!data.proxy_ref,
      };
    } catch {
      return { connection_id: connId, error: 'parse_failed' };
    }
  });
}

/**
 * Clear one connection's cache, or all when connectionId is falsy. Removes the
 * credential files, the derived Meta Page-token files and their leftover tmp
 * files. Returns cleared ids (connections that had any such file; listed once).
 */
export function clearCachedCredentials(connectionId, dir = CREDENTIALS_DIR) {
  if (connectionId) {
    deleteCredentialCache(connectionId, dir);
    return [connectionId];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const f of names) {
    let id = null;
    if (isPageTokensFile(f)) id = f.slice(0, -PAGE_TOKENS_SUFFIX.length);
    else if (isPageTokensTmpFile(f)) id = pageTokensTmpIdOf(f);
    else if (isCredentialFile(f)) id = f.slice(0, -'.json'.length);
    if (id === null) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
