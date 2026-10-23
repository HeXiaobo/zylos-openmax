import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTextBody, buildMediaBody } from './outbound-body.js';

test('buildTextBody: AGENT_TEXT, markdown detection, parent on the first chunk only, mentions kept', () => {
  assert.deepEqual(buildTextBody({ text: 'hi', replyTo: '9' }), {
    type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'hi' }, attachments: [] }, parent_id: '9',
  });
  assert.equal(buildTextBody({ text: '# T\n\n- a\n- b' }).content.content_type, 'markdown');
  const later = buildTextBody({ text: 'x', replyTo: '9', first: false, mentions: [{ type: 'member', member_id: 'm' }] });
  assert.equal('parent_id' in later, false);
  assert.deepEqual(later.mentions, [{ type: 'member', member_id: 'm' }]);
});

test('buildMediaBody: image / file shape, artifact id preferred over media id, caption in body', () => {
  const img = buildMediaBody({ kind: 'image', fileName: 'a.png', caption: 'cap', artifactId: 'art', mediaId: 'med', mimeType: 'image/png', sizeBytes: 5, replyTo: '3' });
  assert.deepEqual(img, {
    type: 'IMAGE',
    content: { content_type: 'image', body: { file_name: 'a.png', text: 'cap' }, attachments: [{ artifact_id: 'art', file_name: 'a.png', content_type: 'image/png', size_bytes: 5 }] },
    parent_id: '3',
  });
  const file = buildMediaBody({ kind: 'file', mediaId: 'med' });
  assert.equal(file.type, 'FILE');
  assert.equal(file.content.attachments[0].artifact_id, 'med');
  assert.deepEqual(file.content.body, { file_name: '' });
});
