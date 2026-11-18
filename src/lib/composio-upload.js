/**
 * Local-file upload for proxy (Composio) actions — "Composio 文件上传方案 B"
 * (EM-2026-11-17-01 §4.5 / §4.6, steps P1–P6).
 *
 * A Composio action marks its file params with `file_uploadable: true` in the
 * input_schema. cws-connect cannot read a file on this host, so before the
 * server-side execute, conn.invoke:
 *
 *   P1  reads the action's input_schema (conn.js: action_describe + local cache)
 *   P2  finds every file_uploadable param whose value is a LOCAL PATH — a
 *       non-empty string that does not start with http:// or https://. URLs,
 *       objects ({upload_id}, {name,mimetype,content_base64}, …) pass through.
 *   P3  validates the file: realpath, regular file, size cap, sensitive-path
 *       deny list (checked after realpath, so a symlink cannot reach a denied
 *       file), streaming md5, mimetype by extension.
 *   P4  POST /connect/connections/{id}/files/upload-slot → {upload_id, presigned_url}
 *   P5  streams the file to presigned_url with a plain PUT (no auth / proxy
 *       headers; the URL is never logged or put in an error message)
 *   P6  replaces the param value with {"upload_id": "…"}; the caller executes.
 *       An execute that fails with an expired/unknown upload_id re-runs P4–P6
 *       once (runProxyExecuteWithUploads).
 *
 * Network and filesystem effects are injected (deps) so every step is
 * unit-testable without a server.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { detectMime } from './request-spec/files.js';

/** Default local-file cap: 500MB (server enforces its own configurable cap too). */
export const MAX_LOCAL_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Env override for the cap (positive integer bytes). */
export const MAX_UPLOAD_ENV = 'OPENMAX_CONN_UPLOAD_MAX_BYTES';
/** PUT timeout floor: 10 minutes. */
export const MIN_PUT_TIMEOUT_MS = 10 * 60 * 1000;
/** Throughput assumed when scaling the PUT timeout up for big files (256KB/s). */
export const PUT_TIMEOUT_BYTES_PER_SEC = 256 * 1024;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function resolveMaxUploadBytes(env = process.env) {
  const raw = env?.[MAX_UPLOAD_ENV];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return MAX_LOCAL_UPLOAD_BYTES;
}

export function putTimeoutMs(size) {
  const scaled = Math.ceil((Number(size) || 0) / PUT_TIMEOUT_BYTES_PER_SEC) * 1000;
  return Math.max(MIN_PUT_TIMEOUT_MS, scaled);
}

// ---------------------------------------------------------------------------
//  P2: value classification + schema walk
// ---------------------------------------------------------------------------

export function isUrlString(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

/** A file param value that is a local path: a non-blank string that is not an http(s) URL. */
export function isLocalPathValue(v) {
  return typeof v === 'string' && v.trim() !== '' && !isUrlString(v);
}

/** Cheap pre-check: does params contain ANY string that could be a local path? */
export function hasLocalPathCandidate(value, depth = 0) {
  if (depth > 32) return false;
  if (isLocalPathValue(value)) return true;
  if (Array.isArray(value)) return value.some((v) => hasLocalPathCandidate(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).some((v) => hasLocalPathCandidate(v, depth + 1));
  return false;
}

function decodePointerToken(t) {
  return decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~');
}

// Resolve a local $ref ("#/$defs/X", "#/definitions/X", any "#/a/b" pointer)
// against the root schema. Remote refs are not followed (→ null).
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return null;
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return null;
  let cur = root;
  for (const tok of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[decodePointerToken(tok)];
  }
  return cur && typeof cur === 'object' ? cur : null;
}

export function parseInputSchema(schema) {
  if (typeof schema === 'string') {
    if (schema.trim() === '') return null;
    try { schema = JSON.parse(schema); } catch { return null; }
  }
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

/**
 * Walk params alongside the action's input_schema and return every local-path
 * value sitting on a file_uploadable node: [{ path: [key|index...], value }].
 * Handles properties, additionalProperties, items / prefixItems (arrays),
 * anyOf / oneOf / allOf and local $ref ($defs / definitions). Each param
 * location is reported once.
 */
export function findLocalFileParams(inputSchema, params) {
  const root = parseInputSchema(inputSchema);
  if (!root || !params || typeof params !== 'object') return [];
  const found = new Map();

  const record = (p, value) => {
    const key = JSON.stringify(p);
    if (!found.has(key)) found.set(key, { path: p, value });
  };

  const walk = (node, value, p, refDepth, depth) => {
    if (!node || typeof node !== 'object' || depth > 64 || value === undefined) return;
    if (typeof node.$ref === 'string') {
      if (refDepth > 32) return;
      const target = resolveRef(root, node.$ref);
      if (target) walk(target, value, p, refDepth + 1, depth + 1);
      // Siblings of $ref (2019-09+) are still applied below.
    }
    if (node.file_uploadable === true) {
      if (isLocalPathValue(value)) record(p, value);
      else if (Array.isArray(value)) {
        value.forEach((v, i) => { if (isLocalPathValue(v)) record([...p, i], v); });
      }
      // An object value ({upload_id} / {name,mimetype,content_base64} / …) and
      // URLs pass through unchanged — do not descend into them.
      return;
    }
    for (const k of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[k])) for (const sub of node[k]) walk(sub, value, p, refDepth, depth + 1);
    }
    if (Array.isArray(value)) {
      const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : (Array.isArray(node.items) ? node.items : null);
      value.forEach((v, i) => {
        if (prefix && i < prefix.length) walk(prefix[i], v, [...p, i], refDepth, depth + 1);
        else if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) walk(node.items, v, [...p, i], refDepth, depth + 1);
      });
      return;
    }
    if (value && typeof value === 'object') {
      const props = node.properties && typeof node.properties === 'object' ? node.properties : {};
      for (const [k, v] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) walk(props[k], v, [...p, k], refDepth, depth + 1);
        else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
          walk(node.additionalProperties, v, [...p, k], refDepth, depth + 1);
        }
      }
    }
  };

  walk(root, params, [], 0, 0);
  return [...found.values()];
}

function setAtPath(obj, p, value) {
  let cur = obj;
  for (let i = 0; i < p.length - 1; i++) cur = cur[p[i]];
  cur[p[p.length - 1]] = value;
}

function displayPath(p) {
  return p.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : (s ? `${s}.${k}` : String(k))), '');
}

// ---------------------------------------------------------------------------
//  P3: local file validation
// ---------------------------------------------------------------------------

export function defaultHome() { return process.env.HOME || os.homedir() || '/tmp'; }

// Directory trees whose contents are never uploaded (credentials / keys).
const DENIED_TREES = (home, componentDir) => [
  path.join(home, '.ssh'),
  path.join(home, '.aws'),
  path.join(home, '.gnupg'),
  path.join(home, '.kube'),
  path.join(home, '.docker'),
  path.join(home, '.azure'),
  path.join(home, '.config', 'bot-credentials'),
  path.join(home, '.config', 'gcloud'),
  path.join(home, '.config', 'gh'),
  path.join(componentDir, 'runtime'),
];
const DENIED_FILES = (home, componentDir) => [
  path.join(home, '.netrc'),
  path.join(home, '.git-credentials'),
  path.join(home, '.npmrc'),
  path.join(home, '.pgpass'),
  path.join(componentDir, 'config.json'),
];
// Any file whose basename is a dotenv file, an SSH private/public key, or a PEM.
const DENIED_BASENAMES = [/^\.env($|\.)/i, /\.env$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.pem$/i];

function realOr(p) { try { return fs.realpathSync(p); } catch { return p; } }
function within(child, parent) { return child === parent || child.startsWith(parent + path.sep); }

function isDenied(p, home, componentDir) {
  const trees = DENIED_TREES(home, componentDir).flatMap((d) => [d, realOr(d)]);
  const files = DENIED_FILES(home, componentDir).flatMap((f) => [f, realOr(f)]);
  return trees.some((d) => within(p, d)) || files.includes(p) || DENIED_BASENAMES.some((re) => re.test(path.basename(p)));
}

/**
 * Validate one local path for upload. Returns { real, size, filename }.
 * Throws {status:400, code} for a missing file, a non-regular file, a denied
 * path (checked on the given path AND its realpath) or a file over the cap.
 * opts: { home, cwd, componentDir, maxBytes, paramName }
 */
export function checkUploadPath(input, opts = {}) {
  const home = opts.home || defaultHome();
  const componentDir = opts.componentDir || path.join(home, 'zylos/components/openmax');
  const maxBytes = opts.maxBytes || resolveMaxUploadBytes();
  const label = opts.paramName ? `file param "${opts.paramName}"` : 'file param';
  if (/[\0\r\n]/.test(input)) throw fail(400, 'file_invalid_path', `${label}: path must not contain NUL/CR/LF`);
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  const lexical = path.resolve(opts.cwd || process.cwd(), p);
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw fail(400, 'file_not_found',
      `${label}: local file not found: ${input} — pass the path of an existing local file (absolute path recommended), or a public https URL`);
  }
  if (isDenied(lexical, home, componentDir) || isDenied(real, home, componentDir)) {
    throw fail(400, 'file_forbidden',
      `${label}: "${path.basename(lexical)}" is in a protected location (credentials / keys / .env) and cannot be uploaded — pick a different file`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw fail(400, 'file_not_regular', `${label}: ${input} is not a regular file — pass the path of a file, not a directory or device`);
  if (st.size > maxBytes) {
    throw fail(400, 'file_too_large',
      `${label}: ${path.basename(real)} is ${st.size} bytes, over the ${maxBytes}-byte (${Math.round(maxBytes / 1048576)}MB) local upload limit — use a smaller file or pass a public https URL`);
  }
  return { real, size: st.size, filename: path.basename(real) };
}

/** md5 (hex) of a file, streamed — never loads the whole file in memory. */
export async function md5File(filePath) {
  const hash = crypto.createHash('md5');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Mimetype by extension (shared table with request_spec); unknown → application/octet-stream. */
export function mimeForFilename(filename) {
  return detectMime({ filename });
}

/** P3 in full: validate + md5 + mimetype. */
export async function inspectLocalFile(input, opts = {}) {
  const info = checkUploadPath(input, opts);
  const md5 = await (opts.md5File || md5File)(info.real);
  return { ...info, md5, mimetype: mimeForFilename(info.filename) };
}

// ---------------------------------------------------------------------------
//  P5: streaming PUT to the presigned URL
// ---------------------------------------------------------------------------

/**
 * Stream a file to a presigned URL. Sends only Content-Type + Content-Length —
 * no Authorization, no CF-Access / proxy credentials. Errors never contain the
 * URL (it is a write credential).
 */
export function putFileToPresignedUrl(url, { filePath, size, mimetype, timeoutMs = putTimeoutMs(size) }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(fail(502, 'upload_put_failed', 'file upload failed: server returned an invalid upload URL')); return; }
    const mod = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null);
    if (!mod) { reject(fail(502, 'upload_put_failed', 'file upload failed: server returned a non-http(s) upload URL')); return; }
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };
    const req = mod.request(u, {
      method: 'PUT',
      headers: { 'Content-Type': mimetype || 'application/octet-stream', 'Content-Length': String(size) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 16) chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return done(null, { status: res.statusCode });
        const text = Buffer.concat(chunks).toString('utf8').slice(0, 300).replace(/https?:\/\/\S+/g, '[url]');
        done(fail(502, 'upload_put_failed', `file upload to storage failed (HTTP ${res.statusCode})${text ? `: ${text}` : ''} — retry the call once; if it keeps failing, pass a public https URL instead`));
      });
      res.on('error', (e) => done(fail(502, 'upload_put_failed', `file upload to storage failed (${e.code || 'response error'})`)));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(fail(504, 'upload_put_timeout', `file upload to storage timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    req.on('error', (e) => done(fail(502, 'upload_put_failed', `file upload to storage failed (${e.code || 'network error'}) — retry the call once; if it keeps failing, pass a public https URL instead`)));
    const src = fs.createReadStream(filePath);
    src.on('error', (e) => { req.destroy(); done(fail(400, 'file_read_failed', `cannot read the local file (${e.code || 'read error'})`)); });
    src.pipe(req);
  });
}

// ---------------------------------------------------------------------------
//  P4–P6: upload-slot + PUT + param rewrite, and the execute retry
// ---------------------------------------------------------------------------

/** cws-core upload-slot path for a connection (caller wraps it with apiPath). */
export function uploadSlotPath(connectionId) {
  return `/connect/connections/${connectionId}/files/upload-slot`;
}

/**
 * P4 + P5 for one inspected file. deps: { requestSlot(body) → data, putFile(url, opts) }.
 * Returns the upload_id.
 */
export async function uploadOne(file, { action }, deps) {
  let slot;
  try {
    slot = await deps.requestSlot({ action, filename: file.filename, mimetype: file.mimetype, size: file.size, md5: file.md5 });
  } catch (err) {
    if (err && err.status === 404) {
      throw Object.assign(fail(400, 'local_file_upload_unsupported',
        'local-file upload is not supported on this environment yet (the server has no files/upload-slot endpoint) — pass a public direct https URL for the file parameter instead'),
      { cause: err });
    }
    throw err;
  }
  const uploadId = slot && typeof slot.upload_id === 'string' ? slot.upload_id : '';
  if (!uploadId) throw fail(502, 'upload_slot_invalid', 'file upload failed: the server returned no upload_id');
  if (typeof slot.presigned_url === 'string' && slot.presigned_url !== '') {
    await deps.putFile(slot.presigned_url, { filePath: file.real, size: file.size, mimetype: file.mimetype });
  }
  return uploadId;
}

/**
 * P2–P6: return { params, uploads } where params is a copy of `params` with each
 * local-path file value replaced by {upload_id}. No file params / no local
 * paths → the original params object is returned unchanged and uploads is [].
 * deps: { inspect(path, {paramName}), requestSlot, putFile, inspected? (cache) }
 */
export async function prepareFileParams({ inputSchema, params, action }, deps) {
  const hits = findLocalFileParams(inputSchema, params);
  if (hits.length === 0) return { params, uploads: [] };
  const out = structuredClone(params);
  const inspected = deps.inspected || new Map();
  const uploads = [];
  // Validate every file before uploading any, so a bad second path fails fast.
  for (const hit of hits) {
    const name = displayPath(hit.path);
    if (!inspected.has(hit.value)) inspected.set(hit.value, await deps.inspect(hit.value, { paramName: name }));
  }
  for (const hit of hits) {
    const file = inspected.get(hit.value);
    const uploadId = await uploadOne(file, { action }, deps);
    setAtPath(out, hit.path, { upload_id: uploadId });
    uploads.push({ param: displayPath(hit.path), upload_id: uploadId, size: file.size });
  }
  return { params: out, uploads };
}

/** Does an execute error say an upload_id is expired / unknown? (re-upload once) */
export function isUploadIdRejected(err) {
  if (!err || ![400, 404, 409, 410, 422].includes(err.status)) return false;
  const msg = String(err.message || '');
  return /upload_id/i.test(msg) && /(expired|not found|not owned|unknown|invalid)/i.test(msg);
}

/**
 * The full proxy execute with local-file preprocessing. deps:
 *   getSchema() → input_schema | null   (null/throw → no preprocessing)
 *   execute(params) → result
 *   inspect, requestSlot, putFile        (see prepareFileParams)
 */
export async function runProxyExecuteWithUploads({ action, params }, deps) {
  const p = params || {};
  let schema = null;
  if (hasLocalPathCandidate(p)) {
    try { schema = await deps.getSchema(); } catch { schema = null; }
  }
  if (!schema) return deps.execute(p);
  const inspected = new Map();
  const first = await prepareFileParams({ inputSchema: schema, params: p, action }, { ...deps, inspected });
  if (first.uploads.length === 0) return deps.execute(p);
  try {
    return await deps.execute(first.params);
  } catch (err) {
    if (!isUploadIdRejected(err)) throw err;
  }
  // upload_id expired / not found: re-run P4–P6 once (files already validated).
  const second = await prepareFileParams({ inputSchema: schema, params: p, action }, { ...deps, inspected });
  return deps.execute(second.params);
}
