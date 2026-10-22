/**
 * Resumable (session-based, chunked) upload state machine (plan §5.6). Every
 * protocol detail comes from request_spec.upload as data — the session-URL
 * header, chunk method, incomplete status, progress header, probe style,
 * final statuses — so no provider is named here.
 *
 *   init  : <action method> url_template + JSON metadata + init_headers
 *   session URL: response header `session_url_from` — MUST be same-origin
 *          as the url_template request (the token is never sent elsewhere)
 *   chunks: chunk_method + Content-Range: bytes a-b/total
 *           incomplete_status + progress_header "bytes=0-N" → next offset
 *           final_status → done
 *   5xx / network → exponential backoff, then status probe (bytes *\/total)
 *   404 / 410     → restart the session (≤ max_restarts)
 *   401           → refresh the token, resend the current chunk
 *
 * Single invocation only: the session URL stays in memory and is logged as
 * <session>; nothing is persisted, so a process restart uploads from scratch.
 * Redirects are never followed.
 */
import { specError } from './errors.js';

export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_TRANSIENT_RETRIES = 5;
const MAX_STALLS = 3;

function hdr(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    if (v) return v;
  }
  const want = name.toLowerCase();
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) if (String(k).toLowerCase() === want) return v || '';
  return '';
}

function originOf(u) { try { return new URL(u).origin; } catch { return null; } }

/** Parse a progress header "bytes=0-N" → next offset (N+1); absent → 0. */
export function nextOffsetFromProgress(value) {
  const m = /bytes=?\s*(\d+)-(\d+)/i.exec(String(value || ''));
  return m ? Number(m[2]) + 1 : 0;
}

async function drain(res) {
  try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* best effort */ }
}

/**
 * deps:
 *   fetchImpl, normalize(res) → normalized response,
 *   authorize(url, headers) → url (applies the connection auth in place),
 *   refresh() → Promise<boolean> (re-acquire the token; false if not possible),
 *   sleep(ms), audit(line)
 * init: { method, url, headers, body (JSON string) }
 * file: resolved stream file { size, readRange(start, end) }
 */
export async function runResumableUpload({ upload, init, file }, deps) {
  const { fetchImpl, normalize, authorize, refresh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), audit = () => {} } = deps;
  const sessionHeader = upload.session_url_from.slice('header:'.length);
  const chunkBytes = upload.chunk_bytes || DEFAULT_CHUNK_BYTES;
  if (upload.chunk_multiple && chunkBytes % upload.chunk_multiple !== 0) throw specError(422, 'request_spec: chunk_bytes must be a multiple of chunk_multiple');
  const incomplete = upload.incomplete_status;
  const finals = new Set(upload.final_status);
  const maxRestarts = upload.max_restarts || 0;
  const probe = upload.status_probe || 'none';
  const total = file.size;
  const initOrigin = originOf(init.url);
  let refreshes = 0;

  const send = async (url, opts) => {
    const headers = { ...opts.headers };
    const finalUrl = authorize(url, headers);
    return fetchImpl(finalUrl, { ...opts, headers, redirect: 'manual' });
  };
  const tryRefresh = async () => {
    if (refreshes >= 2) return false;
    refreshes++;
    return refresh();
  };

  const startSession = async () => {
    let res = await send(init.url, { method: init.method, headers: init.headers, body: init.body });
    if (res.status === 401 && await tryRefresh()) {
      await drain(res);
      res = await send(init.url, { method: init.method, headers: init.headers, body: init.body });
    }
    if (res.status < 200 || res.status >= 300) return { error: await normalize(res) };
    const loc = hdr(res.headers, sessionHeader);
    await drain(res);
    if (!loc) throw specError(502, `resumable upload: the init response has no ${sessionHeader} header`);
    let session;
    try { session = new URL(loc, init.url).toString(); } catch { throw specError(502, 'resumable upload: session URL is not a valid URL'); }
    if (originOf(session) !== initOrigin) {
      throw specError(502, `resumable upload: session URL origin ${originOf(session)} differs from the request origin ${initOrigin} — refused`);
    }
    audit('[conn.direct] ⇡ resumable session opened <session>');
    return { session };
  };

  let restarts = 0;
  let s = await startSession();
  if (s.error) return s.error;
  let session = s.session;
  let offset = 0;
  let transient = 0;
  let stalls = 0;

  const restart = async () => {
    if (restarts >= maxRestarts) return false;
    restarts++;
    audit(`[conn.direct] ⇡ resumable session expired; restart ${restarts}/${maxRestarts}`);
    s = await startSession();
    if (s.error) throw Object.assign(new Error('restart failed'), { response: s.error });
    session = s.session;
    offset = 0;
    return true;
  };

  const handleProgress = (res) => {
    const next = nextOffsetFromProgress(hdr(res.headers, upload.progress_header || 'Range'));
    if (next <= offset) stalls++; else stalls = 0;
    if (stalls > MAX_STALLS) throw specError(502, 'resumable upload: the server stopped accepting bytes');
    offset = next;
  };

  for (;;) {
    let res;
    const isProbe = transient > 0 && probe === 'content_range_star';
    try {
      if (isProbe) {
        res = await send(session, { method: upload.chunk_method, headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' } });
      } else if (total === 0) {
        res = await send(session, { method: upload.chunk_method, headers: { 'Content-Range': 'bytes */0', 'Content-Length': '0' } });
      } else {
        const end = Math.min(offset + chunkBytes, total) - 1;
        const body = file.readRange(offset, end);
        audit(`[conn.direct] ⇡ resumable <session> bytes ${offset}-${end}/${total}`);
        res = await send(session, {
          method: upload.chunk_method,
          headers: { 'Content-Range': `bytes ${offset}-${end}/${total}`, 'Content-Length': String(body.length) },
          body,
        });
      }
    } catch (e) {
      if (e && e.status) throw e;
      if (++transient > MAX_TRANSIENT_RETRIES) throw specError(502, `resumable upload: network error after ${MAX_TRANSIENT_RETRIES} retries`);
      await sleep(Math.min(1000 * 2 ** (transient - 1), 16000));
      continue;
    }
    const st = res.status;
    if (finals.has(st)) return normalize(res);
    if (incomplete !== undefined && st === incomplete) {
      await drain(res);
      transient = 0;
      handleProgress(res);
      continue;
    }
    if (st === 401) {
      await drain(res);
      if (await tryRefresh()) continue;
      return normalize(res);
    }
    if (st === 404 || st === 410) {
      try {
        if (await restart()) { await drain(res); transient = 0; continue; }
      } catch (e) { if (e.response) return e.response; throw e; }
      return normalize(res);
    }
    if (st >= 500) {
      if (++transient > MAX_TRANSIENT_RETRIES) return normalize(res);
      await drain(res);
      await sleep(Math.min(1000 * 2 ** (transient - 1), 16000));
      continue;
    }
    return normalize(res);
  }
}
