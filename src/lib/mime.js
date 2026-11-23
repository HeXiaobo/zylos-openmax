/**
 * Single extension → MIME table shared by every upload path: as.js
 * uploadMedia ([MEDIA:*] IM sends, KB uploads) and request-spec/files.js
 * detectMime (Composio uploads, direct-exec file params). Keeping one table
 * stops the two from drifting apart (wsb#796: office/zip/csv files sent via
 * [MEDIA:file] were uploaded as application/octet-stream).
 */
import path from 'node:path';

export const MIME_BY_EXT = Object.freeze({
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.eml': 'message/rfc822', '.ics': 'text/calendar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.rtf': 'application/rtf', '.7z': 'application/x-7z-compressed',
});

/** MIME for a filename or path by its (case-insensitive) extension, or null if unknown. */
export function mimeFromExtension(nameOrPath) {
  if (!nameOrPath || typeof nameOrPath !== 'string') return null;
  const ext = path.extname(nameOrPath).toLowerCase();
  if (!ext || !Object.hasOwn(MIME_BY_EXT, ext)) return null;
  return MIME_BY_EXT[ext];
}
