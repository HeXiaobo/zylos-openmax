/**
 * File parameter resolver for request_spec actions (plan §5.4 / §8, owner
 * decisions Q1 / Q2). A file parameter's value is one of:
 *
 *   {"source":"path",     "path":"~/zylos/components/openmax/upload/a.pdf", "mime_type"?, "filename"?}
 *   {"source":"artifact", "artifact":"artifact://<id>", ...}
 *   {"source":"base64",   "data":"<base64 / base64url>", "filename"?, "mime_type"?}
 *   {"source":"text",     "text":"...", "filename"?, "mime_type"?}
 *   "artifact://<id>"  |  "<absolute path>"            (shorthands)
 *
 * URL sources are NOT supported (Q2): "http(s)://…" is refused with a hint.
 *
 * Local paths may only come from the openmax component's own media/ and
 * upload/ directories (Q1) — resolved with realpath first, then
 * prefix-checked, so symlinks and ".." cannot escape. Dotfile segments,
 * .env*, *.pem, *.key, id_*, the component's runtime/ (credential + catalog
 * caches) and config.json, ~/.ssh, ~/.config and ~/zylos/.env are always
 * refused. Only regular files are read. Size caps are fixed constants (not
 * configurable); a spec's max_bytes may only be stricter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specError } from './errors.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_STREAM_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const FILE_SOURCES = Object.freeze(['path', 'artifact', 'base64', 'text']);

export function defaultHome() { return process.env.HOME || os.homedir() || '/tmp'; }
export function defaultComponentDir(home = defaultHome()) { return path.join(home, 'zylos/components/openmax'); }

const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.eml': 'message/rfc822', '.ics': 'text/calendar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

function sniff(buf) {
  if (!buf || buf.length === 0) return null;
  const h = buf.subarray(0, 8);
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (h.length >= 8 && h.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05) ) return 'application/zip';
  const sample = buf.subarray(0, 4096);
  if (!sample.includes(0)) {
    const txt = sample.toString('utf8');
    // Treat as text only if the sample round-trips (allowing a cut multi-byte tail).
    if (!txt.slice(0, -3).includes('�')) return 'text/plain';
  }
  return null;
}

/** MIME decision order: explicit → extension → magic → octet-stream. */
export function detectMime({ explicit, filename, head }) {
  if (explicit) return explicit;
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return sniff(head) || 'application/octet-stream';
}

export function mimeAccepted(mime, accept) {
  if (!Array.isArray(accept) || accept.length === 0) return true;
  const m = String(mime).split(';', 1)[0].trim().toLowerCase();
  return accept.some((p) => {
    const pat = String(p).trim().toLowerCase();
    if (pat === '*/*' || pat === '*') return true;
    if (pat.endsWith('/*')) return m.startsWith(pat.slice(0, -1));
    return m === pat;
  });
}

function safeMeta(v, what) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || /[\r\n\0]/.test(v)) throw specError(400, `file ${what} must be a string without CR/LF/NUL`);
  return v;
}

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }
function within(child, parent) { return !!parent && (child === parent || child.startsWith(parent + path.sep)); }

const DENY_BASENAME = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i];

/**
 * Sandbox check for a local path. Returns { real, size }. Throws 400/403/413.
 * opts: { home, componentDir, cap }
 */
export function checkLocalPath(input, { home = defaultHome(), componentDir = defaultComponentDir(home) } = {}) {
  if (typeof input !== 'string' || !input) throw specError(400, 'file path must be a non-empty string');
  if (/[\0\r\n]/.test(input)) throw specError(400, 'file path must not contain NUL/CR/LF');
  let p = input;
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  if (!path.isAbsolute(p)) throw specError(400, `file path must be absolute (under ${path.join(componentDir, 'upload')})`);
  const lexical = p.split(/[\\/]+/).filter(Boolean);
  if (lexical.some((seg) => seg.startsWith('.'))) throw specError(403, 'file path must not contain "." / ".." or dot-file segments');
  const real = realOrNull(p);
  if (!real) throw specError(400, `file not found: ${path.basename(p)}`);
  const roots = ['media', 'upload'].map((d) => realOrNull(path.join(componentDir, d))).filter(Boolean);
  const root = roots.find((r) => within(real, r));
  if (!root) {
    throw specError(403, `file "${path.basename(p)}" is outside the allowed directories — copy it into ${path.join(componentDir, 'upload')} first`);
  }
  const relSegs = path.relative(root, real).split(path.sep);
  const base = path.basename(real);
  if (relSegs.some((s) => s.startsWith('.')) || DENY_BASENAME.some((re) => re.test(base))) {
    throw specError(403, `file "${base}" is a protected file and cannot be read`);
  }
  const deniedTrees = [
    path.join(componentDir, 'runtime'), path.join(home, '.ssh'), path.join(home, '.config'),
  ].map((d) => realOrNull(d) || d);
  const deniedFiles = [path.join(componentDir, 'config.json'), path.join(home, 'zylos/.env')].map((f) => realOrNull(f) || f);
  if (deniedTrees.some((d) => within(real, d)) || deniedFiles.includes(real)) {
    throw specError(403, `file "${base}" is a protected file and cannot be read`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw specError(400, `"${base}" is not a regular file`);
  return { real, size: st.size };
}

async function readCappedStream(body, cap, what) {
  const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
  if (!reader) throw specError(502, `${what}: download has no readable body`);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw specError(413, `${what} exceeds the ${cap}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Default artifact resolver: cws-core /artifacts/resolve (as.js getMediaUrl);
// the returned presigned URL is fetched with the CF Access service headers the
// storage gateway needs (same as client.js getBytes) and nothing else.
async function defaultResolveArtifact(uri, orgId) {
  const { getMediaUrl } = await import('../../cli/as.js');
  const { cfAccessHeaders } = await import('../cf-access.js');
  const meta = await getMediaUrl(uri, orgId);
  return { ...meta, headers: cfAccessHeaders() };
}

function decodeBase64(data) {
  if (typeof data !== 'string') throw specError(400, 'base64 file data must be a string');
  const s = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw specError(400, 'base64 file data is not valid base64');
  return Buffer.from(s, 'base64');
}

function normalizeValue(v) {
  if (typeof v === 'string') {
    if (/^https?:\/\//i.test(v)) {
      throw specError(400, 'URL file sources are not supported — download the file into ~/zylos/components/openmax/upload or upload it as an artifact, then pass that');
    }
    if (v.startsWith('artifact://')) return { source: 'artifact', artifact: v };
    return { source: 'path', path: v };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw specError(400, 'file value must be an object {source, ...} or a path / artifact:// string');
  return v;
}

/**
 * Resolve ONE file value to { __file, filename, mime_type, size, bytes } (or,
 * for stream:true, { ..., path, open(start,end) } without reading it).
 * deps: { home, componentDir, resolveArtifact(uri, orgId), fetchImpl, orgId, tmpDir }
 */
export async function resolveOneFile(paramName, rawValue, fileSpec = {}, deps = {}) {
  const v = normalizeValue(rawValue);
  const source = v.source;
  const allowed = Array.isArray(fileSpec.sources) && fileSpec.sources.length ? fileSpec.sources : FILE_SOURCES;
  if (!FILE_SOURCES.includes(source)) throw specError(400, `file "${paramName}": unknown source "${source}" (use ${FILE_SOURCES.join(' / ')})`);
  if (!allowed.includes(source)) throw specError(400, `file "${paramName}": source "${source}" is not allowed for this action (allowed: ${allowed.join(', ')})`);
  const stream = fileSpec.stream === true;
  const hard = stream ? MAX_STREAM_FILE_BYTES : MAX_FILE_BYTES;
  const cap = Number.isInteger(fileSpec.max_bytes) && fileSpec.max_bytes > 0 ? Math.min(fileSpec.max_bytes, hard) : hard;
  let filename = safeMeta(v.filename, 'filename');
  const explicitMime = safeMeta(v.mime_type, 'mime_type');
  const tooBig = (n) => specError(413, `file "${paramName}" is ${n} bytes, over the ${cap}-byte limit`);
  let bytes;
  let localPath;
  let size;
  let cleanup;

  switch (source) {
    case 'path': {
      const { real, size: sz } = checkLocalPath(v.path, deps);
      if (sz > cap) throw tooBig(sz);
      if (!filename) filename = path.basename(real);
      localPath = real; size = sz;
      if (!stream) bytes = fs.readFileSync(real);
      break;
    }
    case 'artifact': {
      if (typeof v.artifact !== 'string' || !/^artifact:\/\/[A-Za-z0-9._:-]+$/.test(v.artifact)) {
        throw specError(400, `file "${paramName}": artifact must be an artifact://<id> URI`);
      }
      const resolve = deps.resolveArtifact || defaultResolveArtifact;
      const meta = await resolve(v.artifact, deps.orgId);
      if (!meta || typeof meta.url !== 'string' || !/^https:\/\//i.test(meta.url)) {
        throw specError(502, `file "${paramName}": artifact did not resolve to a download URL`);
      }
      if (Number.isFinite(meta.contentLength) && meta.contentLength > cap) throw tooBig(meta.contentLength);
      const fetchImpl = deps.fetchImpl || fetch;
      // Only the URL the resolve endpoint returned is fetched; redirects are not followed.
      const res = await fetchImpl(meta.url, { method: 'GET', headers: meta.headers || {}, redirect: 'manual' });
      if (res.status < 200 || res.status >= 300) throw specError(502, `file "${paramName}": artifact download failed (HTTP ${res.status})`);
      bytes = await readCappedStream(res.body, cap, `file "${paramName}"`);
      if (!filename && meta.name) filename = safeMeta(String(meta.name), 'filename');
      if (!v.mime_type && meta.contentType && !/octet-stream/i.test(meta.contentType)) v.mime_type = String(meta.contentType).split(';')[0];
      size = bytes.length;
      if (stream) {
        const dir = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'omx-upload-'));
        localPath = path.join(dir, 'artifact.bin');
        fs.writeFileSync(localPath, bytes, { mode: 0o600 });
        bytes = undefined;
        cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
      }
      break;
    }
    case 'base64': bytes = decodeBase64(v.data); size = bytes.length; break;
    case 'text':
      if (typeof v.text !== 'string') throw specError(400, `file "${paramName}": text source needs a "text" string`);
      bytes = Buffer.from(v.text, 'utf8'); size = bytes.length;
      break;
    default: break;
  }
  if (size > cap) throw tooBig(size);
  if (stream && !localPath) {
    // Inline sources for a streamed parameter: still bounded by the cap above.
    const dir = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'omx-upload-'));
    localPath = path.join(dir, 'inline.bin');
    fs.writeFileSync(localPath, bytes, { mode: 0o600 });
    bytes = undefined;
    cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  }
  let head = bytes;
  if (!head && localPath) {
    const fd = fs.openSync(localPath, 'r');
    try { head = Buffer.alloc(Math.min(4096, size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  }
  const mime = detectMime({ explicit: explicitMime || safeMeta(v.mime_type, 'mime_type'), filename, head });
  if (!mimeAccepted(mime, fileSpec.accept)) {
    throw specError(400, `file "${paramName}" has type ${mime}, which this action does not accept (${fileSpec.accept.join(', ')})`);
  }
  const file = { __file: true, filename: filename || 'file', mime_type: mime, size, source };
  if (bytes) file.bytes = bytes;
  if (stream) {
    file.path = localPath;
    file.open = (start, end) => fs.createReadStream(localPath, { start, end });
    file.readRange = (start, end) => {
      const fd = fs.openSync(localPath, 'r');
      try {
        const b = Buffer.alloc(end - start + 1);
        fs.readSync(fd, b, 0, b.length, start);
        return b;
      } finally { fs.closeSync(fd); }
    };
    if (cleanup) file.cleanup = cleanup;
  }
  return file;
}

/**
 * Resolve every declared file parameter present in params.
 * Returns { files: {name → file | file[]}, cleanup() }.
 */
export async function resolveFiles(filesSpec, params, deps = {}) {
  const out = {};
  const cleanups = [];
  try {
    for (const [name, fspec] of Object.entries(filesSpec || {})) {
      if (!Object.prototype.hasOwnProperty.call(params || {}, name)) continue;
      const raw = params[name];
      if (raw === undefined || raw === null) continue;
      if (fspec.multiple) {
        const list = Array.isArray(raw) ? raw : [raw];
        const resolved = [];
        let total = 0;
        const totalCap = Number.isInteger(fspec.max_total_bytes) && fspec.max_total_bytes > 0
          ? Math.min(fspec.max_total_bytes, MAX_BODY_BYTES) : MAX_BODY_BYTES;
        for (let i = 0; i < list.length; i++) {
          const f = await resolveOneFile(`${name}[${i}]`, list[i], fspec, deps);
          if (f.cleanup) cleanups.push(f.cleanup);
          total += f.size;
          if (total > totalCap) throw specError(413, `files "${name}" total ${total} bytes exceeds the ${totalCap}-byte limit`);
          resolved.push(f);
        }
        out[name] = resolved;
      } else {
        if (Array.isArray(raw)) throw specError(400, `file "${name}" takes one file, not an array`);
        const f = await resolveOneFile(name, raw, fspec, deps);
        if (f.cleanup) cleanups.push(f.cleanup);
        out[name] = f;
      }
    }
  } catch (e) {
    cleanups.forEach((c) => c());
    throw e;
  }
  return { files: out, cleanup: () => cleanups.forEach((c) => c()) };
}
