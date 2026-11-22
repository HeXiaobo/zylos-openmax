/**
 * JSON encoder. Byte-identical to the pre-request_spec direct path: the body is
 * `JSON.stringify(value)` (sent as a string, exactly as sendDirect did) with
 * Content-Type application/json. A MISSING / undefined value sends no body.
 */
import { isMissing } from '../transforms.js';
import { checkBodySize } from './util.js';

export function encode({ value }) {
  if (isMissing(value)) return { contentType: undefined, body: undefined };
  const body = JSON.stringify(value);
  checkBodySize(Buffer.byteLength(body, 'utf8'));
  return { contentType: 'application/json', body };
}
