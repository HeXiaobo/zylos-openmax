#!/usr/bin/env node

/**
 * ArtifactStore — canonical interface for all file upload / download in
 * zylos-openmax. Talks to cws-core (contract-v5).
 *
 * v5 collapsed the old cws-as endpoints. The only artifact API that
 * remains is:
 *
 *   POST /api/v1/artifacts/resolve   batch-resolve artifact:// URIs
 *                                     → presigned download URLs
 *
 * Uploads moved to two new namespaces depending on use case:
 *
 *   IM media (attach to a conversation message):
 *     POST /api/v1/conversations/{cid}/uploads/prepare
 *          body {filename, content_type, size_bytes}
 *          resp {upload_token, upload_url, headers, expires_at, instant_upload}
 *     PUT  <upload_url>          (skip if instant_upload)
 *     POST /api/v1/conversations/uploads/finalize
 *          body {upload_token}
 *          resp {media_id, artifact_id}
 *
 *   KB files (attach to a KB tree as a file node):
 *     POST /api/v1/uploads/prepare
 *          body {parent_id?, filename, content_type, size_bytes}
 *          resp {upload_token, upload_url, headers, expires_at, instant_upload}
 *     PUT  <upload_url>          (skip if instant_upload)
 *     POST /api/v1/uploads/finalize
 *          body {upload_token}
 *          resp <tree_node>      (the new file node with its artifact_id)
 *
 * Two roles in one file:
 *
 *   1. Library exports (imported by scripts/send.js, src/comm-bridge.js,
 *      src/cli/kb.js):
 *        - uploadMedia(localPath, opts)        — IM if conversationId, else KB (opts.orgId scopes it)
 *        - downloadMedia(uriOrId, file?, orgId?) — fetch bytes from artifact://<id>
 *        - getMediaUrl(uriOrId, orgId?)        — resolve artifact://<id> → URL
 *        - resolveUris(uris, orgId?)           — batch /artifacts/resolve
 *
 *   2. CLI dispatcher (when invoked as
 *      `node src/cli/as.js <cmd> '<json>'`):
 *        - as.upload     {filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}
 *        - as.url        {artifactId|uri}   (short-lived URL; prefer as.download)
 *        - as.download   {artifactId|uri, filename?}
 *        - as.resolve    {uris, inline?}
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { postForOrg, apiPath, putBytes, getBytes } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';

// Org resolution for the artifact surface (mirrors conn.js PR#127). Every
// /artifacts and /uploads route is org-owned: the backend resolves the org from
// the JWT principal and 403s ("org membership required") on an identity-only
// token. A bare post() would silently fall through to resolveDefaultOrgId(),
// which returns '' when >1 org is enabled and no org is given — producing that
// opaque 403. Callers thread an explicit orgId (comm-bridge passes
// orgConfig.org_id; the CLI resolves {org}); the library funcs below carry it
// into the org-scoped postForOrg. Single-org / COCO_ORG_ID deployments resolve
// the one org exactly as before.
function resolveOrgIdFrom(params = {}) {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}
function requireOrgIdFrom(params = {}) {
  const orgId = resolveOrgIdFrom(params);
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}

const HOME = process.env.HOME || '/tmp';
const TMP_DIR = path.join(HOME, 'zylos/components/openmax/media');

const MIME_BY_KIND = {
  image:   'image/png',
  video:   'video/mp4',
  audio:   'audio/mpeg',
  voice:   'audio/ogg',
  file:    'application/octet-stream',
  sticker: 'image/webp',
};

// Real MIME inference by file extension. This is the source-of-truth fix for
// issue #7: without it, a `.png` sent as `[MEDIA:file]` (or any non-image
// `mediaType`) falls back to `application/octet-stream` and the receiving FE
// renders it as a file card instead of an inline image. Inferring from the
// extension means the content_type is correct regardless of how the upper
// layer tagged the media. It also fixes the related bug where any image kind
// was hardcoded to `image/png` (so `.jpg`/`.gif` got the wrong MIME).
const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.pdf':  'application/pdf',
};

// Map a local path / filename to its MIME via extension, or null if unknown.
function mimeFromExt(filePathOrName) {
  if (!filePathOrName) return null;
  const ext = path.extname(filePathOrName).toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

async function ensureTmpDir() {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
}

// ============================================================================
//  Library functions
// ============================================================================

/**
 * Build an `artifact://` URI from a bare id, or return as-is if already a URI.
 */
function toArtifactUri(idOrUri) {
  if (typeof idOrUri !== 'string') {
    throw new Error('artifact id or URI is required');
  }
  return idOrUri.startsWith('artifact://') ? idOrUri : `artifact://${idOrUri}`;
}

/**
 * Upload a local file via the v5 prepare/finalize flow.
 *
 * Routing:
 *   - `opts.conversationId` set      → IM upload (conversation-scoped)
 *   - `opts.kbId` set or neither     → KB upload (file node in a tree)
 *
 * Backward-compatible return shape: `{mediaId, artifactId, fileName, mimeType,
 * sizeBytes, instantUpload}` so existing callers in send.js / comm-bridge keep
 * working. KB uploads additionally include `{nodeId, treeNode}`.
 */
export async function uploadMedia(localPath, opts = {}) {
  if (!localPath) throw new Error('uploadMedia: localPath is required');
  const buf  = await fs.promises.readFile(localPath);
  const stat = await fs.promises.stat(localPath);

  const fileName    = opts.filename || path.basename(localPath);
  const mediaType   = opts.mediaType || 'file';
  // Priority: explicit override > inferred-from-extension > kind default >
  // octet-stream. Inferring from the extension (issue #7) keeps the
  // content_type correct even when the upper layer tagged an image as `file`.
  const contentType = opts.mimeType
    || opts.contentType
    || mimeFromExt(fileName)
    || mimeFromExt(localPath)
    || MIME_BY_KIND[mediaType]
    || 'application/octet-stream';
  const sizeBytes = stat.size;

  const isIm = !!opts.conversationId;

  const prepPath = isIm
    ? `/conversations/${opts.conversationId}/uploads/prepare`
    : '/uploads/prepare';

  const prepBody = isIm
    ? { filename: fileName, content_type: contentType, size_bytes: sizeBytes }
    : { parent_id: opts.parentId, filename: fileName, content_type: contentType, size_bytes: sizeBytes };

  const orgId = requireOrgIdFrom(opts);
  const prep = await postForOrg(orgId, apiPath(prepPath), prepBody);

  const uploadToken   = prep?.upload_token;
  const uploadUrl     = prep?.upload_url;
  const reqHeaders    = prep?.headers || {};
  const instantUpload = prep?.instant_upload === true;

  if (!uploadToken) {
    throw new Error('uploads/prepare returned no upload_token');
  }

  // Step 2: PUT bytes to the pre-signed URL (skip on instant_upload).
  if (!instantUpload) {
    if (!uploadUrl) throw new Error('uploads/prepare returned no upload_url');
    await putBytes(uploadUrl, buf, contentType, reqHeaders);
  }

  // Step 3: finalize.
  const finalizePath = isIm
    ? '/conversations/uploads/finalize'
    : '/uploads/finalize';
  const finalized = await postForOrg(orgId, apiPath(finalizePath), { upload_token: uploadToken });

  if (isIm) {
    // finalized: {media_id, artifact_id}
    return {
      mediaId:       finalized?.media_id,
      artifactId:    finalized?.artifact_id,
      fileName,
      mimeType:      contentType,
      sizeBytes,
      instantUpload,
    };
  }

  // KB upload: finalized is a tree node (id, kb_id, parent_id, name,
  // artifact_id, ...).
  return {
    mediaId:       finalized?.artifact_id,
    artifactId:    finalized?.artifact_id,
    nodeId:        finalized?.id,
    treeNode:      finalized,
    fileName:      finalized?.name || fileName,
    mimeType:      contentType,
    sizeBytes,
    instantUpload,
  };
}

/**
 * Attached to every URL this CLI hands out. Resolved download URLs are
 * short-lived and may be single-use: they are for this process to fetch right
 * away, never for a chat message, a delivery, a comment or memory.
 */
export const DOWNLOAD_URL_NOTICE =
  'Short-lived, possibly single-use download link for immediate use by this agent only. ' +
  'Do not post it in messages, deliveries, comments or memory. ' +
  'To work on the file, use as.download and read the local copy.';

/**
 * Resolve one artifact id or URI to a short-lived download URL.
 *
 *   getMediaUrl('artifact://abc-123', orgId)            → {url, expiresAt, contentType, name, sizeBytes}
 *   getMediaUrl('abc-123', orgId, { inline:1 })         → same, inline disposition
 *
 * Bug A fix (#13): the org id is now a real positional parameter routed through
 * postForOrg, not an ignored `opts` field. comm-bridge already calls
 * getMediaUrl(attId, orgConfig.org_id); previously that org_id landed in `opts`
 * and was silently dropped, so a multi-org media resolve went out identity-only
 * and 403'd. `orgId` omitted → resolveDefaultOrgId() (single-org unchanged).
 */
export async function getMediaUrl(idOrUri, orgId, opts = {}) {
  const uri = toArtifactUri(idOrUri);
  const inline = opts.inline === true || opts.mode === 'preview';
  const res = await postForOrg(orgId || resolveDefaultOrgId(), apiPath('/artifacts/resolve'), { uris: [uri], inline });
  const entry = res?.resolved?.[uri];
  if (!entry || !entry.download_url) {
    const failed = res?.failed || [];
    const reason = failed.includes(uri) ? 'artifact not resolvable' : 'no download_url in response';
    throw new Error(`getMediaUrl: ${reason} (${uri})`);
  }
  return {
    url:           entry.download_url,
    expiresAt:     entry.expires_at,
    contentType:   entry.content_type,
    contentLength: entry.content_length,
    name:          entry.name,
  };
}

/**
 * Batch-resolve `artifact://` URIs to short-lived download URLs.
 */
export async function resolveUris(uris, orgId, opts = {}) {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error('resolveUris: uris must be a non-empty array');
  }
  return postForOrg(orgId || resolveDefaultOrgId(), apiPath('/artifacts/resolve'), {
    uris,
    inline: opts.inline === true,
  });
}

/** Resolve + fetch attempts in downloadMedia (each with a freshly resolved link). */
const DOWNLOAD_ATTEMPTS = 2;

/**
 * Download an artifact's bytes to a local file under the component's media
 * tmp dir. Returns the absolute local path.
 *
 *   await downloadMedia('https://...presigned...', 'cat.png')        → uses URL directly
 *   await downloadMedia('artifact://abc-123', 'cat.png')             → resolves first
 *   await downloadMedia('abc-123', 'cat.png')                        → resolves first
 *
 * With an id / URI, a failed fetch is retried once with a freshly resolved
 * link (never the same one). With a URL there is no retry.
 */
export async function downloadMedia(urlOrIdOrUri, filename, orgId) {
  let buf;
  let resolvedName;
  if (/^https?:\/\//i.test(urlOrIdOrUri)) {
    // A caller-supplied URL: one attempt. It may be single-use, and there is
    // nothing to re-resolve it from — pass the artifact id to get a retry.
    buf = await getBytes(urlOrIdOrUri);
  } else {
    // Each attempt resolves its own fresh link; a failed link (expired, or a
    // single-use link already consumed) is never requested again.
    for (let attempt = 1; ; attempt++) {
      const meta = await getMediaUrl(urlOrIdOrUri, orgId);
      resolvedName = meta.name;
      try {
        buf = await getBytes(meta.url);
        break;
      } catch (err) {
        if (attempt >= DOWNLOAD_ATTEMPTS) throw err;
      }
    }
  }
  await ensureTmpDir();
  const safeName = (filename || resolvedName || `media-${Date.now()}`).replace(/[/\\]/g, '_');
  const localPath = path.join(TMP_DIR, safeName);
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

// ============================================================================
//  CLI dispatcher
// ============================================================================

const COMMANDS = {
  // IM mode  : pass conversationId
  // KB mode  : pass parentId (or nothing — defaults to KB root)
  'as.upload': async (params) => {
    if (!params.filePath) throw new Error('filePath is required');
    return uploadMedia(params.filePath, {
      conversationId: params.conversationId,
      parentId:       params.parentId,
      mediaType:      params.mediaType,
      mimeType:       params.contentType,
      filename:       params.filename,
      orgId:          requireOrgIdFrom(params),
    });
  },

  // Prefer as.download: it fetches the bytes to a local file. as.url is for a
  // process that must fetch the URL itself right away; the URL is marked so it
  // is not passed on.
  'as.url': async (params) => {
    const id = params.uri || params.artifactId;
    if (!id) throw new Error('artifactId or uri is required');
    const meta = await getMediaUrl(id, requireOrgIdFrom(params), { inline: params.inline === true });
    return { ...meta, shortLived: true, notice: DOWNLOAD_URL_NOTICE };
  },

  'as.download': async (params) => {
    const id = params.uri || params.artifactId;
    if (!id) throw new Error('artifactId or uri is required');
    const localPath = await downloadMedia(id, params.filename, requireOrgIdFrom(params));
    return { localPath };
  },

  'as.resolve': async (params) => {
    if (!Array.isArray(params.uris) || params.uris.length === 0) {
      throw new Error('uris (non-empty array) is required');
    }
    const res = await resolveUris(params.uris, requireOrgIdFrom(params), { inline: params.inline === true });
    return res && typeof res === 'object' ? { ...res, shortLived: true, notice: DOWNLOAD_URL_NOTICE } : res;
  },
};

function printUsage() {
  console.log(`AS CLI — cws-core artifacts (contract-v5)

Usage: node src/cli/as.js <command> '<json-params>'

Commands
  as.upload     {filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}
                # IM mode  : pass conversationId — finalize returns {mediaId, artifactId}
                # KB mode  : omit conversationId — finalize returns {nodeId, artifactId, treeNode}
                # mediaType: image|video|audio|voice|file|sticker (default file)
                # → {mediaId, artifactId, [nodeId, treeNode,] fileName, mimeType, sizeBytes, instantUpload}

  as.download   {artifactId|uri, filename?}
                # PREFERRED way to read a file: resolves a fresh link, fetches the bytes
                # (following its redirect) to the local media dir → {localPath}

  as.url        {artifactId|uri, inline?}
                # POST /artifacts/resolve → {url, expiresAt, contentType, contentLength, name, shortLived, notice}
                # The url is short-lived and may be single-use: fetch it immediately in this
                # process, never post it in a message, delivery, comment or memory.

  as.resolve    {uris:["artifact://abc-123", ...], inline?}
                # passthrough to /artifacts/resolve → {resolved, failed, shortLived, notice} (same URL rules as as.url)

Environment:
  COCO_API_URL       cws-core base URL
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function runCli() {
  const [command, ...rest] = process.argv.slice(2);
  const params = rest.length ? JSON.parse(rest.join(' ')) : {};
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler(params);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
