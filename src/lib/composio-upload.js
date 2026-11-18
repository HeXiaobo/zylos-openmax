/**
 * Local-file upload for proxy (Composio) actions — "Composio 文件上传方案 B"
 * (EM-2026-11-17-01 §4.5 / §4.6, steps P1–P6).
 *
 * A Composio action marks its file params with `file_uploadable: true` in the
 * input_schema. cws-connect cannot read a file on this host, so before the
 * server-side execute, conn.invoke:
 *
 *   P1  reads the action's input_schema (conn.js: action_describe + local cache)
 *   P2  finds every file_uploadable param whose value is a LOCAL PATH — a string
 *       starting with "/" or "~/". Everything else (http(s) URLs, data: URIs,
 *       base64 text, {upload_id} / {name,mimetype,content_base64} objects)
 *       passes through unchanged.
 *   P3  validates the path with the SAME sandbox as the direct branch's file
 *       sources (request-spec/files.js checkLocalPath: realpath, only the
 *       openmax component's media/ and upload/ directories, dot-segments, keys,
 *       .env*, runtime/, config.json refused), then opens the file ONCE and
 *       works only on that descriptor: fstat (regular, non-empty, single link,
 *       ≤ cap), md5 over exactly [0, size), upload of exactly [0, size).
 *   P4  POST /connect/connections/{id}/files/upload-slot → {upload_id, presigned_url}
 *   P5  streams the file to presigned_url with native fetch (no auth / CF-Access
 *       headers; the URL is never logged or put in an error message)
 *   P6  replaces the param value with {"upload_id": "…"}; the caller executes.
 *       An execute whose passthrough says CONNECT_FILE_UPLOAD_ID_INVALID re-runs
 *       P4–P6 exactly once (runProxyExecuteWithUploads).
 *
 * Network and filesystem effects are injected (deps) so every step is
 * unit-testable without a server.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkLocalPath, detectMime, defaultHome, defaultComponentDir } from './request-spec/files.js';

/** Default local-file cap: 500MB (server enforces its own configurable cap too). */
export const MAX_LOCAL_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Env override for the cap (positive integer bytes). */
export const MAX_UPLOAD_ENV = 'OPENMAX_CONN_UPLOAD_MAX_BYTES';
/** PUT timeout floor: 10 minutes. */
export const MIN_PUT_TIMEOUT_MS = 10 * 60 * 1000;
/** Throughput assumed when scaling the PUT timeout up for big files (256KB/s). */
export const PUT_TIMEOUT_BYTES_PER_SEC = 256 * 1024;
/** Stable cws-connect code for an expired / foreign / unknown upload_id on execute. */
export const UPLOAD_ID_INVALID_CODE = 'CONNECT_FILE_UPLOAD_ID_INVALID';
/** Read size for md5 and upload. */
const CHUNK_BYTES = 1024 * 1024;

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

/**
 * A file param value the CLI uploads: a string starting with "/" or "~/".
 * Anything else — URLs, data: URIs, base64 text, relative names — is not
 * treated as a path and passes through unchanged.
 */
export function isLocalPathValue(v) {
  return typeof v === 'string' && (v.startsWith('/') || v.startsWith('~/'));
}

/** Cheap pre-check: does params contain ANY local-path-looking string? */
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
      // Objects and non-path strings pass through unchanged — never descended into.
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
//  P3: local file — sandbox check, then one descriptor for everything
// ---------------------------------------------------------------------------

/** Mimetype by extension (shared table with request_spec); unknown → application/octet-stream. */
export function mimeForFilename(filename) {
  return detectMime({ filename });
}

const changedError = (name) => fail(409, 'file_changed',
  `the local file "${name}" changed (shrank) while it was being read — make sure nothing is writing to it, then retry`);

/**
 * Read exactly [0, size) from an open FileHandle, chunk by chunk. A short read
 * (the file shrank) throws file_changed; bytes past `size` (the file grew) are
 * never read. Each chunk is a fresh Buffer.
 */
export async function* readExact(fh, size, name = 'file') {
  let pos = 0;
  while (pos < size) {
    const want = Math.min(CHUNK_BYTES, size - pos);
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await fh.read(buf, filled, want - filled, pos + filled);
      if (bytesRead === 0) throw changedError(name);
      filled += bytesRead;
    }
    pos += want;
    yield buf;
  }
}

/** md5 (hex) of exactly [0, size) of an open FileHandle — streamed, never the whole file in memory. */
export async function md5OfHandle(fh, size, name) {
  const hash = crypto.createHash('md5');
  for await (const chunk of readExact(fh, size, name)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * P3: validate a local path and open it ONCE. Returns
 * { fh, size, filename, mimetype, md5 } — the caller owns fh and must close it.
 * opts: { home, componentDir, maxBytes, paramName }
 */
export async function openLocalFile(input, opts = {}) {
  const home = opts.home || defaultHome();
  const componentDir = opts.componentDir || defaultComponentDir(home);
  const maxBytes = opts.maxBytes || resolveMaxUploadBytes();
  const label = opts.paramName ? `file param "${opts.paramName}"` : 'file param';
  let real;
  try {
    ({ real } = checkLocalPath(input, { home, componentDir }));
  } catch (err) {
    // checkLocalPath messages carry the basename only, never the full input.
    throw Object.assign(new Error(`${label}: ${err.message}`), { status: err.status || 400, code: err.code || 'file_invalid_path' });
  }
  const filename = path.basename(real);
  let fh;
  try {
    // O_NOFOLLOW: a final-component symlink swapped in after the realpath check is refused.
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw fail(400, 'file_not_found', `${label}: cannot open "${filename}" — it may have been moved or replaced; retry with a file under ${path.join(componentDir, 'upload')}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw fail(400, 'file_not_regular', `${label}: "${filename}" is not a regular file`);
    if (st.nlink > 1) {
      throw fail(403, 'file_forbidden', `${label}: "${filename}" is a hard link — copy the file (cp, not ln) into ${path.join(componentDir, 'upload')} first`);
    }
    if (st.size === 0) throw fail(400, 'file_empty', `${label}: "${filename}" is empty (0 bytes) — pass a file with content`);
    if (st.size > maxBytes) {
      throw fail(400, 'file_too_large',
        `${label}: "${filename}" is ${st.size} bytes, over the ${maxBytes}-byte (${Math.round(maxBytes / 1048576)}MB) local upload limit — use a smaller file or pass a public https URL`);
    }
    const md5 = await md5OfHandle(fh, st.size, filename);
    return { fh, size: st.size, filename, mimetype: mimeForFilename(filename), md5 };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
//  P5: streaming PUT to the presigned URL (native fetch)
// ---------------------------------------------------------------------------

/**
 * Stream exactly [0, size) of an open FileHandle to a presigned URL with
 * native fetch. Sends only Content-Type + Content-Length — no Authorization,
 * no CF-Access / proxy credentials. Errors never contain the URL (it is a
 * write credential). opts: { fh, size, mimetype, filename, timeoutMs, fetchImpl }
 */
export async function putFileToPresignedUrl(url, { fh, size, mimetype, filename = 'file', timeoutMs = putTimeoutMs(size), fetchImpl = fetch }) {
  let u;
  try { u = new URL(url); } catch { throw fail(502, 'upload_put_failed', 'file upload failed: server returned an invalid upload URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail(502, 'upload_put_failed', 'file upload failed: server returned a non-http(s) upload URL');

  let readErr = null;
  const chunks = readExact(fh, size, filename);
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (err) {
        readErr = err;
        controller.error(err);
      }
    },
    async cancel() { await chunks.return?.(); },
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(u, {
      method: 'PUT',
      headers: { 'Content-Type': mimetype || 'application/octet-stream', 'Content-Length': String(size) },
      body,
      duplex: 'half',
      redirect: 'error',
      signal: ac.signal,
    });
  } catch (err) {
    if (readErr) throw readErr;
    if (ac.signal.aborted) throw fail(504, 'upload_put_timeout', `file upload to storage timed out after ${Math.round(timeoutMs / 1000)}s`);
    const code = err?.cause?.code || err?.code || 'network error';
    throw fail(502, 'upload_put_failed', `file upload to storage failed (${code}) — retry the call once; if it keeps failing, pass a public https URL instead`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 200 && res.status < 300) {
    try { await res.body?.cancel?.(); } catch { /* best effort */ }
    return { status: res.status };
  }
  let text = '';
  try { text = (await res.text()).slice(0, 300).replace(/https?:\/\/\S+/g, '[url]'); } catch { /* ignore */ }
  throw fail(502, 'upload_put_failed', `file upload to storage failed (HTTP ${res.status})${text ? `: ${text}` : ''} — retry the call once; if it keeps failing, pass a public https URL instead`);
}

// ---------------------------------------------------------------------------
//  P4–P6: upload-slot + PUT + param rewrite, and the execute retry
// ---------------------------------------------------------------------------

/** cws-core upload-slot path for a connection (caller wraps it with apiPath). */
export function uploadSlotPath(connectionId) {
  return `/connect/connections/${connectionId}/files/upload-slot`;
}

/** The error code a cws-core error body carries (envelope error.code or a flat code), or ''. */
export function errorBodyCode(body) {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return ''; } }
  if (!b || typeof b !== 'object') return '';
  const c = (b.error && typeof b.error === 'object' ? b.error.code : undefined) ?? b.code;
  return typeof c === 'string' ? c : '';
}

/**
 * P4 + P5 for one opened file. deps: { requestSlot(body) → data, putFile(url, opts) }.
 * Returns the upload_id.
 */
export async function uploadOne(file, { action }, deps) {
  let slot;
  try {
    slot = await deps.requestSlot({ action, filename: file.filename, mimetype: file.mimetype, size: file.size, md5: file.md5 });
  } catch (err) {
    // A 404 WITH a server error code (e.g. CONNECT_CONNECTION_NOT_FOUND) is a real
    // answer from the endpoint — surface it as-is. Only a bare 404 (the route
    // does not exist on an older server) means local upload is unsupported.
    if (err && err.status === 404) {
      const code = errorBodyCode(err.body);
      if (code) throw Object.assign(err, { code });
      throw Object.assign(fail(400, 'local_file_upload_unsupported',
        'local-file upload is not supported on this environment yet (the server has no files/upload-slot endpoint) — pass a public direct https URL for the file parameter instead'),
      { cause: err });
    }
    throw err;
  }
  const uploadId = slot && typeof slot.upload_id === 'string' ? slot.upload_id : '';
  if (!uploadId) throw fail(502, 'upload_slot_invalid', 'file upload failed: the server returned no upload_id');
  if (typeof slot.presigned_url === 'string' && slot.presigned_url !== '') {
    await deps.putFile(slot.presigned_url, { fh: file.fh, size: file.size, mimetype: file.mimetype, filename: file.filename });
  }
  return uploadId;
}

/**
 * P2–P6: return { params, uploads } where params is a copy of `params` with each
 * local-path file value replaced by {upload_id}. No file params / no local
 * paths → the original params object is returned unchanged and uploads is [].
 * deps: { open(path, {paramName}), requestSlot, putFile, opened: Map (owned by caller) }
 */
export async function prepareFileParams({ inputSchema, params, action }, deps) {
  const hits = findLocalFileParams(inputSchema, params);
  if (hits.length === 0) return { params, uploads: [] };
  const out = structuredClone(params);
  const opened = deps.opened;
  const uploads = [];
  // Validate + open every file before uploading any, so a bad second path fails fast.
  for (const hit of hits) {
    if (!opened.has(hit.value)) opened.set(hit.value, await deps.open(hit.value, { paramName: displayPath(hit.path) }));
  }
  for (const hit of hits) {
    const file = opened.get(hit.value);
    const uploadId = await uploadOne(file, { action }, deps);
    setAtPath(out, hit.path, { upload_id: uploadId });
    uploads.push({ param: displayPath(hit.path), upload_id: uploadId, size: file.size });
  }
  return { params: out, uploads };
}

/**
 * Does an execute outcome say the upload_id is expired / unknown / not ours?
 * Keyed ONLY on the stable server code: the passthrough {status_code: 400,
 * body: {code: CONNECT_FILE_UPLOAD_ID_INVALID}} (body object or JSON string),
 * or a thrown 400 whose body carries that code.
 */
export function isUploadIdRejected({ result, error } = {}) {
  if (error) return error.status === 400 && errorBodyCode(error.body) === UPLOAD_ID_INVALID_CODE;
  return !!result && result.status_code === 400 && errorBodyCode(result.body) === UPLOAD_ID_INVALID_CODE;
}

async function settle(p) {
  try { return { result: await p }; } catch (error) { return { error }; }
}

/**
 * The full proxy execute with local-file preprocessing. deps:
 *   getSchema() → input_schema | null   (null/throw → no preprocessing)
 *   execute(params) → result
 *   open, requestSlot, putFile           (see prepareFileParams)
 * Every opened file handle is closed before this returns.
 */
export async function runProxyExecuteWithUploads({ action, params }, deps) {
  const p = params || {};
  let schema = null;
  if (hasLocalPathCandidate(p)) {
    try { schema = await deps.getSchema(); } catch { schema = null; }
  }
  if (!schema) return deps.execute(p);
  const opened = new Map();
  try {
    const first = await prepareFileParams({ inputSchema: schema, params: p, action }, { ...deps, opened });
    if (first.uploads.length === 0) return deps.execute(p);
    const outcome = await settle(deps.execute(first.params));
    if (!isUploadIdRejected(outcome)) {
      if (outcome.error) throw outcome.error;
      return outcome.result;
    }
    // upload_id rejected: re-run P4–P6 exactly once from the same open files;
    // whatever the second execute returns (even another rejection) is final.
    const second = await prepareFileParams({ inputSchema: schema, params: p, action }, { ...deps, opened });
    return await deps.execute(second.params);
  } finally {
    await Promise.all([...opened.values()].map((f) => f?.fh?.close?.().catch(() => {})));
  }
}
