/**
 * "media": the body is one blob of bytes sent as-is; Content-Type is the
 * file's (or $bytes') mime_type.
 */
import { isMissing, isFileObject } from '../transforms.js';
import { specError } from '../errors.js';
import { checkBodySize } from './util.js';

export function encode({ value }) {
  if (isMissing(value)) throw specError(400, 'media upload: no content to send (the file parameter is missing)');
  let bytes;
  let mime = 'application/octet-stream';
  if (isFileObject(value)) {
    if (!Buffer.isBuffer(value.bytes)) throw specError(400, 'media upload: file is not held in memory');
    bytes = value.bytes;
    if (value.mime_type) mime = value.mime_type;
  } else if (Buffer.isBuffer(value)) {
    bytes = value;
  } else {
    throw specError(422, 'media encoding needs a body that yields bytes (use $bytes or a file parameter)');
  }
  checkBodySize(bytes.length);
  return { contentType: mime, body: bytes };
}
