/**
 * application/x-www-form-urlencoded encoder.
 *
 * Scalars mirror cws-connect's server-side form branch (Go url.Values.Encode):
 * keys sorted, url.QueryEscape escaping (everything except A-Z a-z 0-9 - _ . ~
 * is percent-encoded, space becomes "+"). booleans → "true"/"false";
 * null / undefined are skipped.
 *
 * Nested objects / arrays are expanded bracket-style — a[b]=c, a[0]=x — the
 * "deep object" form convention (plan F2). This deliberately goes beyond the
 * server's fmt.Sprintf("%v") (which renders a nested value as "map[…]" and is
 * effectively broken for nested params); direct mode is the only place these
 * requests are sent.
 */
import { isMissing } from '../transforms.js';
import { checkBodySize } from './util.js';
import { specError } from '../errors.js';

export function queryEscape(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

function scalar(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) throw specError(400, 'form encoding cannot carry raw bytes');
  return String(v);
}

function flatten(prefix, v, out) {
  if (v === null || v === undefined || isMissing(v)) return;
  if (Array.isArray(v)) { v.forEach((el, i) => flatten(`${prefix}[${i}]`, el, out)); return; }
  if (typeof v === 'object' && !Buffer.isBuffer(v)) {
    for (const [k, x] of Object.entries(v)) flatten(`${prefix}[${k}]`, x, out);
    return;
  }
  out.push([prefix, scalar(v)]);
}

export function formEncode(obj) {
  const pairs = [];
  for (const k of Object.keys(obj || {}).sort()) flatten(k, obj[k], pairs);
  return pairs.map(([k, v]) => `${queryEscape(k)}=${queryEscape(v)}`).join('&');
}

export function encode({ value }) {
  if (isMissing(value)) return { contentType: undefined, body: undefined };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw specError(422, 'form encoding needs an object body');
  const body = formEncode(value);
  checkBodySize(Buffer.byteLength(body, 'utf8'));
  return { contentType: 'application/x-www-form-urlencoded', body };
}
