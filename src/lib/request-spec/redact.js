/**
 * Audit summaries for request_spec actions (plan §8): only "key:<type size>"
 * per parameter — never values, file contents, base64, prefetch results or
 * session URLs. Local paths are reduced to their file name.
 */
import path from 'node:path';
import { isFileObject } from './transforms.js';

export function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function describe(v) {
  if (v === null || v === undefined) return '<null>';
  if (Array.isArray(v)) return `<array ${v.length}>`;
  if (typeof v === 'string') return `<string ${humanBytes(Buffer.byteLength(v, 'utf8'))}>`;
  if (typeof v === 'number' || typeof v === 'boolean') return `<${typeof v}>`;
  return `<object ${Object.keys(v).length} keys>`;
}

/** Summarize caller params; `files` = resolved file params (name → file|file[]). */
export function summarizeParams(params, files = {}) {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    const f = files[k];
    if (f !== undefined) {
      const list = Array.isArray(f) ? f : [f];
      const total = list.reduce((a, x) => a + (x.size || 0), 0);
      out.push(`${k}:<${list.length} file${list.length === 1 ? '' : 's'} ${humanBytes(total)}>`);
    } else {
      out.push(`${k}:${describe(v)}`);
    }
  }
  return out.join(' ');
}

/** File names + sizes uploaded (names only, never directories). */
export function summarizeFiles(files = {}) {
  const out = [];
  for (const f of Object.values(files)) {
    for (const x of Array.isArray(f) ? f : [f]) {
      if (isFileObject(x)) out.push(`${path.basename(String(x.filename || 'file'))}(${humanBytes(x.size || 0)})`);
    }
  }
  return out.join(', ');
}
