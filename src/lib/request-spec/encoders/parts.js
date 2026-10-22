/** Shared: turn an evaluated multipart part into { headers, bytes }. */
import { isMissing, isFileObject } from '../transforms.js';
import { specError } from '../errors.js';

export function partBytes(value, contentType) {
  if (isFileObject(value)) {
    if (!Buffer.isBuffer(value.bytes)) throw specError(400, 'multipart: file is not held in memory');
    return { bytes: value.bytes, contentType: contentType || value.mime_type || 'application/octet-stream' };
  }
  if (Buffer.isBuffer(value)) return { bytes: value, contentType: contentType || 'application/octet-stream' };
  if (typeof value === 'string') return { bytes: Buffer.from(value, 'utf8'), contentType: contentType || 'text/plain; charset=UTF-8' };
  if (isMissing(value)) return null;
  return { bytes: Buffer.from(JSON.stringify(value), 'utf8'), contentType: contentType || 'application/json; charset=UTF-8' };
}
