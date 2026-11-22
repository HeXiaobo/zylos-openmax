import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectInboundMedia } from './inbound-media.js';

// Every inbound attachment becomes a mediaItem — none is dropped — so the
// formatter can show one that cannot be fetched instead of an empty message.

const orgConfig = { org_id: 'org-recv' };

function stub(behaviour) {
  const calls = [];
  const download = async (id, saveName, orgId) => {
    calls.push([id, saveName, orgId]);
    return behaviour(id);
  };
  return { calls, download };
}

test('🔴 an attachment without artifact_id is kept with its name and type, and not downloaded', async () => {
  const { calls, download } = stub(() => '/tmp/never');
  const items = await collectInboundMedia(orgConfig, [{ file_name: 'a.png', content_type: 'image/png' }], { shouldDownload: true, download });
  assert.deepEqual(items, [{ fileName: 'a.png', contentType: 'image/png' }]);
  assert.equal(calls.length, 0);
});

test('🔴 a failed download keeps the id and is flagged downloadFailed; the failure is warned', async () => {
  const warned = [];
  const { download } = stub(() => { throw new Error('boom'); });
  const items = await collectInboundMedia(orgConfig, [{ artifact_id: 'art-1', file_name: 'x.pdf' }], {
    shouldDownload: true, download, warn: (...a) => warned.push(a),
  });
  assert.deepEqual(items, [{ id: 'art-1', fileName: 'x.pdf', downloadFailed: true }]);
  assert.deepEqual(warned, [['media fetch failed:', 'art-1', 'boom']]);
});

test('a successful download records localPath, by id in the receiving org', async () => {
  const { calls, download } = stub((id) => `/tmp/${id}`);
  const items = await collectInboundMedia(orgConfig, [{ artifact_id: 'art-1', file_name: 'x.pdf' }], { shouldDownload: true, download });
  assert.deepEqual(items, [{ id: 'art-1', fileName: 'x.pdf', localPath: '/tmp/art-1' }]);
  assert.deepEqual(calls, [['art-1', 'art-1.pdf', 'org-recv']]);
});

test('not downloading: an id-only item, no download attempted, not flagged', async () => {
  const { calls, download } = stub(() => '/tmp/never');
  const items = await collectInboundMedia(orgConfig, [{ artifact_id: 'art-1', file_name: 'x.pdf' }], { shouldDownload: false, download });
  assert.deepEqual(items, [{ id: 'art-1', fileName: 'x.pdf' }]);
  assert.equal(calls.length, 0);
});

test('a non-object item is kept as an unfetchable entry instead of throwing', async () => {
  const { calls, download } = stub(() => '/tmp/never');
  const items = await collectInboundMedia(orgConfig, [null, 'art-x', 7], { shouldDownload: true, download });
  assert.deepEqual(items, [
    { fileName: undefined, contentType: undefined },
    { fileName: undefined, contentType: undefined },
    { fileName: undefined, contentType: undefined },
  ]);
  assert.equal(calls.length, 0);
});

test('order is preserved across mixed outcomes', async () => {
  const { download } = stub((id) => { if (id === 'bad') throw new Error('x'); return `/tmp/${id}`; });
  const items = await collectInboundMedia(orgConfig, [
    { artifact_id: 'ok', file_name: 'a.png' }, { file_name: 'gone.txt' }, { artifact_id: 'bad' },
  ], { shouldDownload: true, download });
  assert.deepEqual(items.map((i) => i.localPath ?? i.id ?? i.fileName), ['/tmp/ok', 'gone.txt', 'bad']);
  assert.equal(items[2].downloadFailed, true);
});
