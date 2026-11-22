/**
 * Batch request packing / response splitting (plan §5.7). Generic HTTP batch
 * over multipart/mixed with application/http parts:
 *
 *   --<boundary>
 *   Content-Type: application/http
 *   Content-ID: <item-N>
 *
 *   METHOD /path?query HTTP/1.1
 *   Content-Type: application/json
 *
 *   {json}
 *   --<boundary>--
 *
 * The response is split by its own boundary; each part's
 * Content-ID <response-item-N> maps back to the request index.
 */
import { specError } from './errors.js';
import { pickBoundary, checkBodySize } from './encoders/util.js';

/**
 * items: [{ method, path (path+query, origin-relative), headers: {k:v}, body: string|Buffer|undefined }]
 * Returns { contentType, body: Buffer }.
 */
export function packBatch(items, { boundary } = {}) {
  const inner = items.map((it, i) => {
    if (!/^\//.test(it.path) || /[\r\n\s]/.test(it.path)) throw specError(400, `batch item ${i}: invalid request path`);
    const lines = [`${it.method} ${it.path} HTTP/1.1`];
    for (const [k, v] of Object.entries(it.headers || {})) {
      if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(String(v))) throw specError(400, `batch item ${i}: header contains CR/LF/NUL`);
      lines.push(`${k}: ${v}`);
    }
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
    const body = it.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(it.body) ? it.body : Buffer.from(String(it.body), 'utf8');
    return Buffer.concat([head, body]);
  });
  const b = pickBoundary(inner, boundary);
  const chunks = [];
  inner.forEach((req, i) => {
    chunks.push(Buffer.from(`--${b}\r\nContent-Type: application/http\r\nContent-ID: <item-${i}>\r\n\r\n`, 'utf8'), req, Buffer.from('\r\n', 'utf8'));
  });
  chunks.push(Buffer.from(`--${b}--\r\n`, 'utf8'));
  const body = Buffer.concat(chunks);
  checkBodySize(body.length);
  return { contentType: `multipart/mixed; boundary=${b}`, body };
}

export function boundaryFromContentType(ct) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(ct || ''));
  return m ? (m[1] || m[2]) : null;
}

function splitHeaderBlock(text) {
  const norm = text.replace(/\r\n/g, '\n');
  const idx = norm.indexOf('\n\n');
  const head = idx >= 0 ? norm.slice(0, idx) : norm;
  const rest = idx >= 0 ? norm.slice(idx + 2) : '';
  const headers = {};
  const lines = head.split('\n');
  return { lines, rest, headers, parse() {
    for (const l of lines) {
      const c = l.indexOf(':');
      if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
    }
    return headers;
  } };
}

/**
 * Split a batch response. `items` = [{action}] in request order.
 * Returns [{index, action, status_code, headers, body}].
 */
export function parseBatchResponse(bodyText, contentType, items) {
  const boundary = boundaryFromContentType(contentType);
  if (!boundary) throw specError(502, 'batch response has no multipart boundary');
  const delim = `--${boundary}`;
  const segments = String(bodyText).split(delim).slice(1);
  const results = [];
  let ordinal = 0;
  for (const seg of segments) {
    if (seg.startsWith('--')) break;
    const s = seg.replace(/^\r?\n/, '');
    const outer = splitHeaderBlock(s);
    const oh = outer.parse();
    const inner = splitHeaderBlock(outer.rest);
    const statusLine = inner.lines.shift() || '';
    const ih = inner.parse();
    const sm = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine.trim());
    let index = ordinal;
    const cid = /<response-item-(\d+)>/.exec(oh['content-id'] || '');
    if (cid) index = Number(cid[1]);
    ordinal++;
    let body = inner.rest.replace(/\r?\n$/, '');
    try { body = body === '' ? body : JSON.parse(body); } catch { /* keep text */ }
    results.push({
      index,
      action: items[index] ? items[index].action : undefined,
      status_code: sm ? Number(sm[1]) : null,
      headers: ih,
      body,
    });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}
