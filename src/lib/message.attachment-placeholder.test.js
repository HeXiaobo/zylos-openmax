import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInboundForC4, UNAVAILABLE_ATTACHMENT } from './message.js';

// An inbound attachment that cannot be fetched must still show up, so an
// empty-text message carrying it is not rendered blank.

const conv = { type: 'dm', id: 'cv-1' };
const sender = { displayName: 'Alice' };

test('placeholder text is the agreed literal', () => {
  assert.equal(UNAVAILABLE_ATTACHMENT, '[附件无法获取]');
});

test('🔴 an attachment with neither localPath nor id renders a placeholder with its name and type', () => {
  const out = formatInboundForC4(conv, sender, {
    content: '', type: 'file',
    mediaItems: [{ fileName: 'a<b>.png', contentType: 'image/png' }],
  });
  assert.ok(
    out.endsWith(' ---- [附件无法获取] name="a&lt;b&gt;.png" content_type="image/png"'),
    out,
  );
});

test('a bare unfetchable attachment (no name, no type) still renders the placeholder', () => {
  const out = formatInboundForC4(conv, sender, { content: '', type: 'file', mediaItems: [{}] });
  assert.ok(out.endsWith('</current-message> ---- [附件无法获取]'), out);
});

test('🔴 a failed download keeps the artifact id and adds the placeholder', () => {
  const out = formatInboundForC4(conv, sender, {
    content: '', type: 'image',
    mediaItems: [{ id: 'art-1', fileName: 'x.png', downloadFailed: true }],
  });
  assert.ok(out.endsWith(' ---- artifact_id: art-1 name="x.png" [附件无法获取]'), out);
});

test('unchanged: downloaded and id-only (not attempted) attachments keep their format', () => {
  const out = formatInboundForC4(conv, sender, {
    content: 'hi', type: 'image',
    mediaItems: [{ id: 'art-1', fileName: 'x.png', localPath: '/tmp/x.png' }, { id: 'art-2', fileName: 'y.png' }],
  });
  assert.ok(out.endsWith(' ---- image: /tmp/x.png name="x.png" ---- artifact_id: art-2 name="y.png"'), out);
  assert.ok(!out.includes(UNAVAILABLE_ATTACHMENT));
});
