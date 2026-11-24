import test from 'node:test';
import assert from 'node:assert/strict';
import { MIME_BY_EXT, mimeFromExtension } from './mime.js';

test('office, zip and csv files map to their real MIME (wsb#796)', () => {
  assert.equal(mimeFromExtension('report.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mimeFromExtension('memo.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeFromExtension('deck.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(mimeFromExtension('bundle.zip'), 'application/zip');
  assert.equal(mimeFromExtension('data.csv'), 'text/csv');
});

test('extension match is case-insensitive', () => {
  assert.equal(mimeFromExtension('REPORT.XLSX'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mimeFromExtension('Photo.JpG'), 'image/jpeg');
});

test('accepts a full path and uses only its extension', () => {
  assert.equal(mimeFromExtension('/home/u/zylos/components/openmax/upload/q3.final.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeFromExtension('/tmp/dir.pdf/notes.csv'), 'text/csv');
});

test('unknown, missing or empty extension → null', () => {
  assert.equal(mimeFromExtension('archive.unknownext'), null);
  assert.equal(mimeFromExtension('Makefile'), null);
  assert.equal(mimeFromExtension('.bashrc'), null);
  assert.equal(mimeFromExtension('trailing.'), null);
  assert.equal(mimeFromExtension('x.constructor'), null);
  assert.equal(mimeFromExtension(''), null);
  assert.equal(mimeFromExtension(undefined), null);
  assert.equal(mimeFromExtension(null), null);
});

test('keeps every mapping the old as.js table had (no image/audio/video/pdf regression)', () => {
  const legacy = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  };
  for (const [ext, mime] of Object.entries(legacy)) assert.equal(MIME_BY_EXT[ext], mime, ext);
  assert.ok(Object.isFrozen(MIME_BY_EXT));
});
