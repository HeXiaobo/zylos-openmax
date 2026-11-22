import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { downloadInboundAttachment, attachmentSaveName } from './inbound-media.js';

const orgConfig = { org_id: 'org-recv', slug: 'recv-slug', org_name: 'Receiving Org' };

test('downloads by artifact id in the receiving org, saved as <id><ext>', async () => {
  const calls = [];
  const download = async (...args) => { calls.push(args); return '/tmp/x'; };
  assert.equal(await downloadInboundAttachment(orgConfig, 'art-1', 'Report.Final.pdf', { download }), '/tmp/x');
  assert.equal(await downloadInboundAttachment(orgConfig, 'art-2', undefined, { download }), '/tmp/x');
  assert.deepEqual(calls, [
    ['art-1', 'art-1.pdf', 'org-recv'],
    ['art-2', 'art-2', 'org-recv'],
  ]);
});

test('attachmentSaveName keeps only the extension of the original name', () => {
  assert.equal(attachmentSaveName('a', 'x/y.png'), 'a.png');
  assert.equal(attachmentSaveName('a', 'noext'), 'a');
  assert.equal(attachmentSaveName('a', ''), 'a');
});

// comm-bridge.js connects on import, so its two download sites (the message's
// own attachments and the quoted message's) are pinned at the source level:
// own attachments go through collectInboundMedia and the quoted one through
// downloadInboundAttachment, both with the handler's own orgConfig, by artifact
// id, and nothing there resolves a URL or calls downloadMedia.
test('comm-bridge downloads both own and quoted attachments by id in the receiving org', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');
  const own = [...src.matchAll(/collectInboundMedia\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(own, ['orgConfig, allAttachments, { shouldDownload, warn }']);
  const sites = [...src.matchAll(/downloadInboundAttachment\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(sites, ['orgConfig, qMediaId, qOrigName']);
  assert.doesNotMatch(src, /\bdownloadMedia\(|\bgetMediaUrl\(/);
  // Both sites sit inside the per-org handler, where orgConfig is that org.
  const handlerStart = src.indexOf('function makeOrgMessageHandler(orgConfig');
  assert.ok(handlerStart > 0);
  assert.ok(src.indexOf('collectInboundMedia(orgConfig') > handlerStart);
  assert.ok(src.indexOf('downloadInboundAttachment(orgConfig') > handlerStart);
});
