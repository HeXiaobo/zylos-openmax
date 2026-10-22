/**
 * Transform registry for request_spec templates (plan §4.4). Provider-agnostic
 * value conversions applied in an expression pipeline:
 *   {{ path | t1 | t2('x') }}   or   {"$pipe": [node, "t1", "t2('x')"]}
 *
 * A transform receiving MISSING returns MISSING (so a missing value keeps
 * propagating and its key gets dropped), except `default(v)` which supplies v.
 */
import { specError } from './errors.js';

/** Sentinel for "no value": dropped from objects/arrays, '' in interpolation. */
export const MISSING = Symbol('request_spec.missing');

export function isMissing(v) { return v === MISSING || v === undefined; }

/** Is this a resolved file object produced by files.js or $bytes? */
export function isFileObject(v) {
  return !!v && typeof v === 'object' && !Buffer.isBuffer(v) && v.__file === true;
}

function toBytes(v, name) {
  if (Buffer.isBuffer(v)) return v;
  if (isFileObject(v)) {
    if (!Buffer.isBuffer(v.bytes)) throw specError(400, `transform ${name}: file "${v.filename}" is streamed and cannot be used here`);
    return v.bytes;
  }
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw specError(400, `transform ${name}: expected bytes or string, got ${typeof v}`);
}

function decodeBase64Any(v, name) {
  if (typeof v !== 'string') throw specError(400, `transform ${name}: expected a string`);
  const s = v.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw specError(400, `transform ${name}: not valid base64`);
  return Buffer.from(s, 'base64');
}

function needString(v, name) {
  if (typeof v !== 'string') throw specError(400, `transform ${name}: expected a string, got ${Array.isArray(v) ? 'array' : typeof v}`);
  return v;
}

/** name -> { min, max, fn(value, args) } (min/max = accepted argument counts). */
export const TRANSFORMS = Object.freeze({
  base64url: { min: 0, max: 0, fn: (v) => toBytes(v, 'base64url').toString('base64url') },
  base64: { min: 0, max: 0, fn: (v) => toBytes(v, 'base64').toString('base64') },
  base64url_decode: { min: 0, max: 0, fn: (v) => decodeBase64Any(v, 'base64url_decode') },
  base64_decode: { min: 0, max: 0, fn: (v) => decodeBase64Any(v, 'base64_decode') },
  utf8: { min: 0, max: 0, fn: (v) => Buffer.from(needString(v, 'utf8'), 'utf8') },
  json: { min: 0, max: 0, fn: (v) => JSON.stringify(v) },
  default: { min: 1, max: 1, passMissing: true, fn: (v, [d]) => (isMissing(v) || v === null ? d : v) },
  join: {
    min: 1, max: 1,
    fn: (v, [sep]) => {
      if (!Array.isArray(v)) throw specError(400, 'transform join: expected an array');
      return v.map((x) => (x === null || x === undefined ? '' : String(x))).join(String(sep));
    },
  },
  header: {
    min: 1, max: 1,
    fn: (v, [name]) => {
      if (!Array.isArray(v)) return MISSING;
      const want = String(name).toLowerCase();
      for (const h of v) {
        if (h && typeof h === 'object' && typeof h.name === 'string' && h.name.toLowerCase() === want) {
          return h.value === undefined || h.value === null ? MISSING : h.value;
        }
      }
      return MISSING;
    },
  },
  prefix_once: {
    min: 1, max: 1,
    fn: (v, [p]) => {
      const s = needString(v, 'prefix_once');
      const prefix = String(p);
      if (s.trimStart().toLowerCase().startsWith(prefix.trim().toLowerCase())) return s;
      return prefix + s;
    },
  },
});

/** Static check used by the spec validator: known name + accepted arity. */
export function checkTransformCall(name, argc) {
  const t = TRANSFORMS[name];
  if (!t) throw specError(422, `request_spec: unknown transform "${name}"`);
  if (argc < t.min || argc > t.max) {
    throw specError(422, `request_spec: transform "${name}" takes ${t.min === t.max ? t.min : `${t.min}-${t.max}`} argument(s), got ${argc}`);
  }
}

export function applyTransform(name, value, args) {
  checkTransformCall(name, args.length);
  const t = TRANSFORMS[name];
  if (isMissing(value) && !t.passMissing) return MISSING;
  return t.fn(value, args);
}
