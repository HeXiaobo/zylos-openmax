import crypto from 'node:crypto';
import { specError } from '../errors.js';
import { MAX_BODY_BYTES } from '../files.js';

export function checkBodySize(n, cap = MAX_BODY_BYTES) {
  if (n > cap) throw specError(413, `request body is ${n} bytes, over the ${cap}-byte limit`);
}

export function defaultBoundary() { return `omx_${crypto.randomBytes(16).toString('hex')}`; }

/** Pick a boundary that does not occur in any of the given buffers. */
export function pickBoundary(buffers, gen = defaultBoundary) {
  for (let i = 0; i < 5; i++) {
    const b = gen();
    if (/[\r\n\0"]/.test(b)) throw specError(500, 'invalid multipart boundary');
    const needle = Buffer.from(b, 'utf8');
    if (!buffers.some((x) => x.includes(needle))) return b;
  }
  throw specError(500, 'could not pick a unique multipart boundary');
}
