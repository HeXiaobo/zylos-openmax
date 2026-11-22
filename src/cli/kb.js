#!/usr/bin/env node

/**
 * KnowledgeBase CLI — cws-core contract-v5 KB surface.
 *
 * v5 collapsed the KB routes from the old per-org prefix
 * (`/api/v1/orgs/{org_id}/...`) into two flat namespaces:
 *
 *   /api/v1/kbs/{kb_id}/tree/...   tree nodes, folders, files, download
 *   /api/v1/pages/...              pages, content, revisions, trash
 *   /api/v1/kbs[, /{kb_id}, ...]   KB collection + archive/unarchive
 *   /api/v1/search/pages           full-text search
 *
 * Org scoping is carried by the JWT principal (resolved server-side) and
 * does not appear in the path or as a header. X-Org-Id is no longer used.
 *
 * Most commands therefore require `kbId` instead of `orgId`.
 *
 * Usage:
 *   node src/cli/kb.js <command> '<json-params>'
 *   node src/cli/kb.js kb.search '{"query":"周会纪要","limit":10}'
 */

import { getForOrg, postForOrg, patchForOrg, putForOrg, delForOrg, apiPath } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';
import { uploadMedia } from './as.js';
import { kbErrorDetails } from '../lib/kb-errors.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Org resolution (mirrors conn.js PR#127). v5 dropped X-Org-Id ("org from JWT
// principal"), so every KB route — kbs, tree nodes, files, pages, search —
// requires an org-scoped JWT; an identity-only token 403s. A bare get()/post()
// would silently fall through to resolveDefaultOrgId(), which returns '' when
// >1 org is enabled and no org is given — producing that opaque 403. Resolve
// the operating org (explicit {org} or the single enabled org) and FAIL FAST
// with an actionable 400 otherwise. Single-org / COCO_ORG_ID unchanged.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}
function requireOrgId() {
  const orgId = resolveOrgId();
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}

// Org-scoped shadows of the bare verbs: each call carries the operating org's
// JWT. Resolved lazily per call so `help` / usage never require an org.
const get   = (path, query) => getForOrg(requireOrgId(), path, query);
const post  = (path, body)  => postForOrg(requireOrgId(), path, body);
const patch = (path, body)  => patchForOrg(requireOrgId(), path, body);
const put   = (path, body)  => putForOrg(requireOrgId(), path, body);
const del   = (path)        => delForOrg(requireOrgId(), path);

function requireKbId() {
  const id = params.kbId || params.kb_id;
  if (!id) throw new Error('kbId is required');
  return id;
}

const COMMANDS = {
  // ============================================================================
  //  KB collection
  // ============================================================================

  // POST /api/v1/kbs/init — initialize the principal org's default KB
  'kb.init': () => post(apiPath('/kbs/init')),

  // GET  /api/v1/kbs
  'kb.list': () => get(apiPath('/kbs'), {
    limit:  params.limit,
    offset: params.offset,
  }),

  // POST /api/v1/kbs   body {name, visibility, description?, icon?}
  //   visibility: "open" | "closed" | "private"  (required by cws-core)
  //   slug is NOT accepted by cws-core — server derives it from name.
  'kb.create': () => post(apiPath('/kbs'), {
    name:        params.name,
    visibility:  params.visibility || 'closed',
    description: params.description,
    icon:        params.icon,
  }),

  // GET    /api/v1/kbs/{kb_id}
  // PATCH  /api/v1/kbs/{kb_id}    body {name?, description?, set_description?,
  //                                      visibility?, icon?, set_icon?}
  // DELETE /api/v1/kbs/{kb_id}
  'kb.get':    () => get(apiPath(`/kbs/${requireKbId()}`)),
  'kb.update': () => patch(apiPath(`/kbs/${requireKbId()}`), {
    name:            params.name,
    description:     params.description,
    set_description: params.setDescription,
    visibility:      params.visibility,
    icon:            params.icon,
    set_icon:        params.setIcon,
  }),
  'kb.delete': () => del(apiPath(`/kbs/${requireKbId()}`)),

  // POST /api/v1/kbs/{kb_id}/archive | /unarchive
  'kb.archive':   () => post(apiPath(`/kbs/${requireKbId()}/archive`)),
  'kb.unarchive': () => post(apiPath(`/kbs/${requireKbId()}/unarchive`)),

  // ============================================================================
  //  Directory tree (kb-scoped)
  // ============================================================================

  // GET /api/v1/kbs/{kb_id}/tree/roots
  'kb.tree_roots': () => get(apiPath(`/kbs/${requireKbId()}/tree/roots`)),

  // POST /api/v1/kbs/{kb_id}/tree/folders   body {parent_id?, name}
  'kb.folder_create': () => post(apiPath(`/kbs/${requireKbId()}/tree/folders`), {
    parent_id: params.parentId,
    name:      params.name || params.title,
  }),

  // POST /api/v1/kbs/{kb_id}/tree/files   body {parent_id?, name, artifact_id}
  // Use after uploadMedia() returns an artifact_id to register the file in the tree.
  'kb.file_create': () => post(apiPath(`/kbs/${requireKbId()}/tree/files`), {
    parent_id:   params.parentId,
    name:        params.name,
    artifact_id: params.artifactId,
  }),

  // GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}
  'kb.node_get': () => get(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}`),
  ),

  // GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/breadcrumb
  'kb.node_breadcrumb': () => get(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}/breadcrumb`),
  ),

  // GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/children
  'kb.node_children': () => get(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.parentId || params.nodeId}/children`),
  ),

  // POST /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/move   body {parent_id?}
  // Accept `parentId` (canonical) or `newParentId` (common-mistake alias —
  // earlier specs / call-sites used it; passing only `newParentId` would
  // otherwise silently no-op since the server treats missing parent_id as
  // "keep current parent", surfaced during Smoke 5 on 2026-06-05).
  'kb.node_move': () => post(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}/move`),
    { parent_id: params.parentId ?? params.newParentId },
  ),

  // PATCH /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/rename   body {name}
  'kb.node_rename': () => patch(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}/rename`),
    { name: params.name || params.title },
  ),

  // DELETE /api/v1/kbs/{kb_id}/tree/nodes/{node_id}
  'kb.node_delete': () => del(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}`),
  ),

  // GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/preview
  'kb.file_preview': () => get(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}/preview`),
  ),

  // GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/download   ?inline=true
  'kb.file_download': () => get(
    apiPath(`/kbs/${requireKbId()}/tree/nodes/${params.nodeId}/download`),
    { inline: params.inline },
  ),

  // POST /api/v1/kbs/{kb_id}/tree/files/batch-download   body {node_ids, inline?}
  'kb.file_batch_download': () => post(
    apiPath(`/kbs/${requireKbId()}/tree/files/batch-download`),
    { node_ids: params.nodeIds, inline: params.inline },
  ),

  // ============================================================================
  //  Pages (flat — no kb_id in path; resolved by page_id)
  // ============================================================================

  // GET /api/v1/pages   ?cursor=&limit=&offset=
  'kb.pages': () => get(apiPath('/pages'), {
    cursor: params.cursor,
    limit:  params.limit,
    offset: params.offset,
  }),

  // POST /api/v1/kbs/{kb_id}/pages
  //     body {title, format, body, parent_id?, message?}
  //     format: "markdown" | "plain_text"
  // Accept `parentId` (canonical) or `parentNodeId` (common-mistake alias —
  // callers naturally reach for "node id" since the parent is a tree node;
  // passing only `parentNodeId` would otherwise silently land the page at
  // the KB root, surfaced during Smoke 5 round 1 on 2026-06-05).
  'kb.page_create': () => post(apiPath(`/kbs/${requireKbId()}/pages`), {
    title:     params.title,
    format:    params.format || 'markdown',
    body:      params.body ?? params.content?.body ?? params.content ?? '',
    parent_id: params.parentId ?? params.parentNodeId,
    message:   params.message || params.commitMessage,
  }),

  // GET /api/v1/pages/{page_id}
  'kb.page_get': () => get(apiPath(`/pages/${params.pageId}`)),

  // PATCH /api/v1/pages/{page_id}   body {title?, path?}
  'kb.page_update': () => patch(apiPath(`/pages/${params.pageId}`), {
    title: params.title,
    path:  params.path,
  }),

  // DELETE /api/v1/pages/{page_id}   — permanent delete (use kb.page_trash for soft)
  'kb.page_delete': () => del(apiPath(`/pages/${params.pageId}`)),

  // GET /api/v1/pages/{page_id}/content
  'kb.page_content': () => get(apiPath(`/pages/${params.pageId}/content`)),

  // PUT /api/v1/pages/{page_id}/content
  //     body {body, message?, base_revision_id?, auto_save?}
  'kb.page_content_write': () => put(apiPath(`/pages/${params.pageId}/content`), {
    body:             params.body ?? params.content?.body ?? params.content,
    message:          params.message || params.commitMessage,
    base_revision_id: params.baseRevisionId,
    auto_save:        params.autoSave ?? false,
  }),

  // POST /api/v1/pages/{page_id}/trash
  'kb.page_trash': () => post(apiPath(`/pages/${params.pageId}/trash`)),

  // POST /api/v1/pages/{page_id}/restore
  'kb.page_restore_trash': () => post(apiPath(`/pages/${params.pageId}/restore`)),

  // POST /api/v1/pages/{page_id}/freeze
  'kb.page_freeze': () => post(apiPath(`/pages/${params.pageId}/freeze`)),

  // GET /api/v1/pages/{page_id}/references
  'kb.page_references': () => get(apiPath(`/pages/${params.pageId}/references`)),

  // GET /api/v1/pages/trashed   — list all trashed pages
  'kb.pages_trashed': () => get(apiPath('/pages/trashed'), {
    limit:  params.limit,
    offset: params.offset,
  }),

  // GET  /api/v1/pages/{page_id}/revisions
  // GET  /api/v1/pages/{page_id}/revisions/{revision_id}
  // GET  /api/v1/pages/{page_id}/revisions/diff   ?from_revision=&to_revision=
  //   NOTE: server expects `from_revision` / `to_revision` WITHOUT the
  //   `_id` suffix (verified 2026-06-05 — earlier CLI sent
  //   `from_revision_id` / `to_revision_id` which 422'd as missing
  //   required query parameter, Smoke 6 #14 root blocker).
  // POST /api/v1/pages/{page_id}/revisions/{revision_id}/restore
  'kb.page_revisions': () => get(apiPath(`/pages/${params.pageId}/revisions`), {
    limit:  params.limit,
    offset: params.offset,
  }),
  'kb.page_revision': () => get(
    apiPath(`/pages/${params.pageId}/revisions/${params.revisionId}`),
  ),
  'kb.page_diff': () => get(apiPath(`/pages/${params.pageId}/revisions/diff`), {
    from_revision: params.fromRevisionId ?? params.fromRevision,
    to_revision:   params.toRevisionId   ?? params.toRevision,
  }),
  'kb.page_restore': () => post(
    apiPath(`/pages/${params.pageId}/revisions/${params.revisionId}/restore`),
  ),

  // ============================================================================
  //  Search (KB pages)
  // ============================================================================

  // GET /api/v1/search/pages   ?query=&kb_id=&limit=&offset=&sort=
  'kb.search': () => get(apiPath('/search/pages'), {
    query:  params.query || params.q,
    kb_id:  params.kbId,
    limit:  params.limit,
    offset: params.offset,
    sort:   params.sort,
  }),

  // ============================================================================
  //  File attachment to KB — uploadMedia(KB mode) returns the tree node
  // ============================================================================

  // Convenience: uploads a local file into a KB folder. Internally calls
  // uploadMedia() in KB mode (no conversationId) which posts to
  //   POST /api/v1/uploads/prepare  → PUT bytes  → POST /uploads/finalize
  // and returns the resulting tree node.
  'kb.upload': () => {
    if (!params.filePath) throw new Error('filePath is required');
    return uploadMedia(params.filePath, {
      parentId:    params.parentId,
      mimeType:    params.contentType,
      filename:    params.filename,
      orgId:       requireOrgId(),
    });
  },
};

function printUsage() {
  console.log(`KB CLI — cws-core KB surface (contract-v5)

Usage: node src/cli/kb.js <command> '<json-params>'

KB collection
  kb.init                  {}                                # POST /kbs/init
  kb.list                  {limit?, offset?}                 # GET  /kbs
  kb.create                {name, visibility?, description?, icon?}    # POST /kbs   visibility=open|closed|private (default closed)
  kb.get                   {kbId}                            # GET  /kbs/{kb_id}
  kb.update                {kbId, name?, description?, setDescription?, visibility?, icon?, setIcon?}    # PATCH /kbs/{kb_id}
  kb.delete                {kbId}                            # DELETE /kbs/{kb_id}
  kb.archive               {kbId}                            # POST /kbs/{kb_id}/archive
  kb.unarchive             {kbId}                            # POST /kbs/{kb_id}/unarchive

Directory tree (kb-scoped)
  kb.tree_roots            {kbId}
  kb.folder_create         {kbId, name, parentId?}
  kb.file_create           {kbId, name, artifactId, parentId?}
  kb.node_get              {kbId, nodeId}
  kb.node_breadcrumb       {kbId, nodeId}
  kb.node_children         {kbId, parentId|nodeId}
  kb.node_move             {kbId, nodeId, parentId?}         # POST .../move
  kb.node_rename           {kbId, nodeId, name}              # PATCH .../rename
  kb.node_delete           {kbId, nodeId}
  kb.file_preview          {kbId, nodeId}
  kb.file_download         {kbId, nodeId, inline?}
  kb.file_batch_download   {kbId, nodeIds, inline?}

Pages (flat)
  kb.pages                 {cursor?, limit?, offset?}
  kb.page_create           {kbId, title, format?, body?, parentId?, message?}    # POST /kbs/{kb_id}/pages   format=markdown|plain_text (default markdown)
  kb.page_get              {pageId}
  kb.page_update           {pageId, title?, path?}
  kb.page_delete           {pageId}                          # permanent
  kb.page_trash            {pageId}                          # soft
  kb.page_restore_trash    {pageId}                          # un-trash
  kb.page_freeze           {pageId}
  kb.page_content          {pageId}
  kb.page_content_write    {pageId, body, message?, baseRevisionId?, autoSave?}  # PUT
  kb.page_references       {pageId}
  kb.pages_trashed         {limit?, offset?}
  kb.page_revisions        {pageId, limit?, offset?}
  kb.page_revision         {pageId, revisionId}
  kb.page_diff             {pageId, fromRevisionId|fromRevision, toRevisionId|toRevision}  # server query: from_revision / to_revision (no _id suffix)
  kb.page_restore          {pageId, revisionId}              # restore a revision

Search (Meilisearch)
  kb.search                {query, kbId?, limit?, offset?, sort?}

File attachment (uploads to KB tree)
  kb.upload                {filePath, parentId?, contentType?, filename?}
                           # POST /uploads/prepare + PUT bytes + POST /uploads/finalize
                           # → tree node containing the artifact

Environment:
  COCO_API_URL       cws-core base URL
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
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
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    // code / kbId / hint: a page write into a deleted or unknown knowledge
    // base (404 KB_NOT_FOUND, or a plain 404 from an older cws-core) is
    // reported as such, never as "gateway not connected".
    Object.assign(payload, kbErrorDetails(command, params, err));
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
