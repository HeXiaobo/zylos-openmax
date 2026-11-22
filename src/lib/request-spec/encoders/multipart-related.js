/**
 * multipart/related (RFC 2387): e.g. a JSON metadata part followed by the
 * file's bytes. Each evaluated part becomes one body part with its own
 * Content-Type; CRLF everywhere; closed with --boundary--.
 * ctx.parts = [{ value, content_type? }] (already evaluated).
 */
import { pickBoundary, checkBodySize } from './util.js';
import { partBytes } from './parts.js';

export function buildMultipart(subtype, items, boundaryGen) {
  const payloads = items.map((it) => it.bytes);
  const boundary = pickBoundary(payloads, boundaryGen);
  const chunks = [];
  for (const it of items) {
    chunks.push(Buffer.from(`--${boundary}\r\n${it.headers.join('\r\n')}\r\n\r\n`, 'utf8'), it.bytes, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(chunks);
  checkBodySize(body.length);
  return { contentType: `multipart/${subtype}; boundary=${boundary}`, body };
}

export function encode({ parts, boundary }) {
  const items = [];
  for (const p of parts) {
    const pb = partBytes(p.value, p.content_type);
    if (!pb) continue;
    items.push({ headers: [`Content-Type: ${pb.contentType}`], bytes: pb.bytes });
  }
  return buildMultipart('related', items, boundary);
}
