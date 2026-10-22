/**
 * multipart/form-data (RFC 7578): each part carries
 * Content-Disposition: form-data; name="…" [; filename="…"]; a non-ASCII
 * filename is sent as filename*=UTF-8''… with an ASCII fallback.
 */
import { isFileObject } from '../transforms.js';
import { specError } from '../errors.js';
import { partBytes } from './parts.js';
import { buildMultipart } from './multipart-related.js';

function pct(s) {
  return Array.from(Buffer.from(s, 'utf8')).map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9!#$&+.^_`|~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function disposition(name, filename) {
  if (/[\r\n\0"]/.test(name)) throw specError(400, 'multipart_form: invalid part name');
  let d = `Content-Disposition: form-data; name="${name}"`;
  if (filename !== undefined) {
    if (/[\r\n\0]/.test(filename)) throw specError(400, 'multipart_form: invalid filename');
    if (/^[\x20-\x7e]*$/.test(filename)) d += `; filename="${filename.replace(/(["\\])/g, '\\$1')}"`;
    else d += `; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1')}"; filename*=UTF-8''${pct(filename)}`;
  }
  return d;
}

export function encode({ parts, boundary }) {
  const items = [];
  for (const p of parts) {
    const values = Array.isArray(p.value) && p.value.every(isFileObject) ? p.value : [p.value];
    for (const v of values) {
      const pb = partBytes(v, p.content_type);
      if (!pb) continue;
      const fname = isFileObject(v) ? (v.filename || 'file') : undefined;
      items.push({ headers: [disposition(p.name, fname), `Content-Type: ${pb.contentType}`], bytes: pb.bytes });
    }
  }
  return buildMultipart('form-data', items, boundary);
}
