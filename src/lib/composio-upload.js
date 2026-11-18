/**
 * Local-file upload for proxy (Composio) actions.
 *
 * A Composio action marks its file params with `file_uploadable: true` in the
 * input_schema. cws-connect cannot read a file on this host, so before the
 * server-side execute, conn.invoke:
 *
 *   1. reads the action's input_schema (conn.js: action_describe + local cache)
 *   2. finds every file_uploadable param whose value is a LOCAL PATH (see
 *      isLocalPathValue). Everything else (http(s) URLs, data: URIs, base64
 *      text, {upload_id} / {name,mimetype,content_base64} objects) passes
 *      through unchanged.
 *   3. validates the path with the SAME sandbox as the direct branch's file
 *      sources (request-spec/files.js checkLocalPath: realpath, only the
 *      openmax component's media/ and upload/ directories, dot-segments, keys,
 *      .env*, runtime/, config.json, hard links refused), then opens the file
 *      ONCE (O_NOFOLLOW | O_NONBLOCK) and works only on that descriptor: fstat
 *      (regular, same inode as checked, single link, non-empty, ≤ cap), md5
 *      over exactly [0, size), upload of exactly [0, size).
 *   4. POST /connect/connections/{id}/files/upload-slot → {upload_id, presigned_url}
 *   5. streams the file to presigned_url with native fetch (no auth / CF-Access
 *      headers; the URL is never logged or put in an error message)
 *   6. replaces the param value with {"upload_id": "…"}; the caller executes.
 *      An execute whose passthrough says CONNECT_FILE_UPLOAD_ID_INVALID re-runs
 *      steps 4–6 exactly once (runProxyExecuteWithUploads).
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
//  Value classification + schema walk
// ---------------------------------------------------------------------------

export function isUrlString(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

// Raw base64 can start with "/" (a JPEG's is "/9j/…"). Such a string is long and
// uses only the base64 alphabet — a real path almost always has a "." (an
// extension) or another character outside it.
const BASE64_LIKE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_MIN_LEN = 64;

/** Does a "/"-leading string look like raw base64 rather than a path? */
export function looksLikeBase64(v) {
  if (typeof v !== 'string') return false;
  if (v.startsWith('/9j/')) return true;
  return v.length >= BASE64_MIN_LEN && BASE64_LIKE_RE.test(v);
}

/**
 * A file param value the CLI uploads: a string starting with "~/", or with "/"
 * unless it looks like raw base64. Anything else — URLs, data: URIs, base64
 * text, relative names — is not treated as a path and passes through unchanged.
 */
export function isLocalPathValue(v) {
  if (typeof v !== 'string') return false;
  if (v.startsWith('~/')) return true;
  return v.startsWith('/') && !looksLikeBase64(v);
}

/** Cheap pre-check: does params contain ANY local-path-looking string? */
export function hasLocalPathCandidate(value, depth = 0) {
  if (depth > 32) return false;
  if (isLocalPathValue(value)) return true;
  if (Array.isArray(value)) return value.some((v) => hasLocalPathCandidate(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).some((v) => hasLocalPathCandidate(v, depth + 1));
  return false;
}

export function parseInputSchema(schema) {
  if (typeof schema === 'string') {
    if (schema.trim() === '') return null;
    try { schema = JSON.parse(schema); } catch { return null; }
  }
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A {.., s3key} descriptor (non-empty string s3key, no own upload_id key): the
// server neither converts it nor counts it as changed (server isFileDescriptor).
// The server checks upload_id FIRST, so {upload_id, s3key} is an upload_id value.
const isS3KeyDescriptor = (v) => isObj(v) && !Object.hasOwn(v, 'upload_id') &&
  typeof v.s3key === 'string' && v.s3key !== '';

// Local definitions ($defs and legacy definitions) as one flat name → schema map.
function schemaDefs(root) {
  const out = {};
  for (const k of ['$defs', 'definitions']) {
    if (isObj(root[k])) Object.assign(out, root[k]);
  }
  return out;
}

// Follow a node's $ref chain against defs by the ref's last segment (bounded);
// an unresolvable ref leaves the node as-is. Siblings of $ref are not merged.
function derefSchema(node, defs) {
  let cur = node;
  for (let i = 0; i < 16; i++) {
    const ref = cur.$ref;
    if (typeof ref !== 'string' || ref === '') return cur;
    const idx = ref.lastIndexOf('/');
    if (idx < 0) return cur;
    const target = defs[ref.slice(idx + 1)];
    if (!isObj(target)) return cur;
    cur = target;
  }
  return cur;
}

/**
 * Walk params alongside the action's input_schema and return every local-path
 * value sitting on a file_uploadable node: [{ path: [key|index...], value }].
 *
 * The traversal is the server materializer's (cws-connect
 * composio_file_materializer.go materializeValue), including its "changed"
 * rule, so the CLI never uploads a file the server will not convert:
 *   - $ref is resolved by name against $defs / definitions (node replaced);
 *   - a file_uploadable node is a leaf: its whole value is the file. A leaf is
 *     TAKEN (the server's "changed") when its value is non-null and not a
 *     {.., s3key} descriptor — a local path, but equally a URL, a base64
 *     string, {content_base64} or {upload_id};
 *   - anyOf / oneOf: the first branch that takes a leaf wins (even when that
 *     leaf is a URL and a later branch holds a local path);
 *   - allOf: every branch, cumulatively; if any takes a leaf, stop there
 *     (the node's own properties / items are not walked);
 *   - properties: declared properties present in an object value; stop there;
 *   - items: a single-schema items, for each element of an array value.
 * additionalProperties, prefixItems and tuple-form items are NOT walked.
 */
export function findLocalFileParams(inputSchema, params) {
  const root = parseInputSchema(inputSchema);
  if (!root || !params || typeof params !== 'object') return [];
  const defs = schemaDefs(root);
  const none = { hits: [], taken: false };

  // Returns { hits, taken }: local-path hits under this node, and whether the
  // server would report this node as changed.
  const walk = (node, value, p, depth) => {
    if (!isObj(node) || depth > 64) return none;
    node = derefSchema(node, defs);
    if (node.file_uploadable === true) {
      if (value === null || value === undefined || isS3KeyDescriptor(value)) return none;
      return { hits: isLocalPathValue(value) ? [{ path: p, value }] : [], taken: true };
    }
    for (const k of ['anyOf', 'oneOf']) {
      if (!Array.isArray(node[k])) continue;
      for (const sub of node[k]) {
        const r = walk(sub, value, p, depth + 1);
        if (r.taken) return r;
      }
    }
    if (Array.isArray(node.allOf)) {
      const hits = [];
      let taken = false;
      for (const sub of node.allOf) {
        const r = walk(sub, value, p, depth + 1);
        hits.push(...r.hits);
        taken = taken || r.taken;
      }
      if (taken) return { hits, taken };
    }
    if (isObj(node.properties) && isObj(value)) {
      const hits = [];
      let taken = false;
      for (const [k, sub] of Object.entries(node.properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        const r = walk(sub, value[k], [...p, k], depth + 1);
        hits.push(...r.hits);
        taken = taken || r.taken;
      }
      return { hits, taken };
    }
    if (isObj(node.items) && Array.isArray(value)) {
      const hits = [];
      let taken = false;
      value.forEach((v, i) => {
        const r = walk(node.items, v, [...p, i], depth + 1);
        hits.push(...r.hits);
        taken = taken || r.taken;
      });
      return { hits, taken };
    }
    return none;
  };

  // One entry per location (allOf branches may reach the same leaf).
  const found = new Map();
  for (const hit of walk(root, params, [], 0).hits) {
    const key = JSON.stringify(hit.path);
    if (!found.has(key)) found.set(key, hit);
  }
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
//  Local file — sandbox check, then one descriptor for everything
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

/** The path an open fd refers to, via /proc/self/fd (Linux); null when unavailable. */
export async function readProcFdPath(fd) {
  try { return await fs.promises.readlink(`/proc/self/fd/${fd}`); } catch { return null; }
}

/**
 * Validate a local path and open it ONCE. Returns
 * { fh, size, filename, mimetype, md5 } — the caller owns fh and must close it.
 * opts: { home, componentDir, maxBytes, paramName }
 */
export async function openLocalFile(input, opts = {}) {
  const home = opts.home || defaultHome();
  const componentDir = opts.componentDir || defaultComponentDir(home);
  const maxBytes = opts.maxBytes || resolveMaxUploadBytes();
  const checkPath = opts.checkPath || checkLocalPath;
  const readFdPath = opts.readFdPath || readProcFdPath;
  const label = opts.paramName ? `file param "${opts.paramName}"` : 'file param';
  let checked;
  try {
    checked = checkPath(input, { home, componentDir });
  } catch (err) {
    // checkLocalPath messages carry the basename only, never the full input.
    throw Object.assign(new Error(`${label}: ${err.message}`), { status: err.status || 400, code: err.code || 'file_invalid_path' });
  }
  const { real } = checked;
  const filename = path.basename(real);
  const replaced = () => fail(409, 'file_changed',
    `${label}: "${filename}" was replaced between the check and the open — make sure nothing is changing it, then retry`);
  let fh;
  try {
    // O_NOFOLLOW: a final-component symlink swapped in after the check is refused.
    // O_NONBLOCK: a FIFO swapped in cannot block the open (fstat refuses it below).
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    if (err && err.code === 'ELOOP') throw replaced();
    throw fail(400, 'file_not_found', `${label}: cannot open "${filename}" — it may have been moved; retry with a file under ${path.join(componentDir, 'upload')}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw fail(400, 'file_not_regular', `${label}: "${filename}" is not a regular file`);
    // The descriptor must be the file the sandbox approved. An intermediate
    // directory swapped for a symlink between check and open lands elsewhere:
    // where /proc exists, the fd's own path must equal the checked realpath and
    // pass the sandbox again; dev/ino is compared everywhere (the only check
    // without /proc).
    const fdPath = await readFdPath(fh.fd);
    if (fdPath !== null) {
      if (fdPath !== real) throw replaced();
      try { checkPath(fdPath, { home, componentDir }); } catch { throw replaced(); }
    }
    if (checked.dev !== undefined && checked.ino !== undefined && (st.dev !== checked.dev || st.ino !== checked.ino)) throw replaced();
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
//  Streaming PUT to the presigned URL (native fetch)
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
//  Upload slot + PUT + param rewrite, and the execute retry
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
 * Upload slot + PUT for one opened file. deps: { requestSlot(body) → data, putFile(url, opts) }.
 * Returns the upload_id.
 */
export async function uploadOne(file, { action }, deps) {
  let slot;
  try {
    slot = await deps.requestSlot({ action, filename: file.filename, mimetype: file.mimetype, size: file.size, md5: file.md5 });
  } catch (err) {
    // Any server error code (e.g. CONNECT_CONNECTION_NOT_FOUND,
    // CONNECT_FILE_UPLOAD_SLOT_UNAVAILABLE, CONNECT_FILE_UPLOAD_RATE_LIMITED)
    // is surfaced on the error with its status. Only a 404 WITHOUT a code (the
    // route does not exist on an older server) means local upload is unsupported.
    const code = errorBodyCode(err?.body);
    if (err && err.status === 404 && !code) {
      throw Object.assign(fail(400, 'local_file_upload_unsupported',
        'local-file upload is not supported on this environment yet (the server has no files/upload-slot endpoint) — pass a public direct https URL for the file parameter instead'),
      { cause: err });
    }
    if (err && code) err.code = code;
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
 * Find, open, upload and rewrite: return { params, uploads } where params is a copy of `params` with each
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
    // upload_id rejected: request a new slot + PUT exactly once from the same open files;
    // whatever the second execute returns (even another rejection) is final.
    const second = await prepareFileParams({ inputSchema: schema, params: p, action }, { ...deps, opened });
    return await deps.execute(second.params);
  } finally {
    await Promise.all([...opened.values()].map((f) => f?.fh?.close?.().catch(() => {})));
  }
}
