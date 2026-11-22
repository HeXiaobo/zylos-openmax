/**
 * Download one inbound attachment (a message's own, or one on the message it
 * quotes) for comm-bridge.
 *
 * The artifact id is passed through — not a resolved URL — so downloadMedia
 * resolves a fresh short-lived link per attempt and re-resolves once if a
 * fetch fails. The org is the receiving org's `org_id`: artifacts resolve in
 * the org the message arrived in, not the CLI's default org.
 */

import path from 'node:path';
import { downloadMedia } from '../cli/as.js';

export function attachmentSaveName(artifactId, fileName) {
  return artifactId + (fileName ? path.extname(fileName) : '');
}

export function downloadInboundAttachment(orgConfig, artifactId, fileName, { download = downloadMedia } = {}) {
  return download(artifactId, attachmentSaveName(artifactId, fileName), orgConfig.org_id);
}

/**
 * Turn a message's attachments into the formatter's mediaItems, one per
 * attachment and in order — none is dropped. An attachment with an artifact id
 * becomes `{id, fileName}`, plus `localPath` when `shouldDownload` and the
 * download succeeds, or `downloadFailed: true` when it throws. One with no
 * artifact id (or that is not an object) has nothing to fetch it by and becomes
 * `{fileName, contentType}`, so the formatter can say it is unavailable instead
 * of rendering an empty message.
 */
export async function collectInboundMedia(orgConfig, attachments, { shouldDownload, warn = () => {}, download } = {}) {
  const mediaItems = [];
  for (const att of attachments) {
    const a = (att && typeof att === 'object') ? att : {};
    const attId = a.artifact_id;
    const attFileName = a.file_name;
    if (!attId) {
      mediaItems.push({ fileName: attFileName, contentType: a.content_type });
      continue;
    }
    const item = { id: attId, fileName: attFileName };
    if (shouldDownload) {
      try {
        // By id, in this org: a fresh short-lived link per attempt.
        item.localPath = await downloadInboundAttachment(orgConfig, attId, attFileName, { download });
      } catch (e) {
        warn('media fetch failed:', attId, e.message);
        item.downloadFailed = true;
      }
    }
    mediaItems.push(item);
  }
  return mediaItems;
}
