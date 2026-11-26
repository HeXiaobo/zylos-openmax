# KB Operations Guide

**Purpose**: Knowledge Base operations — managing KB instances themselves, the directory tree (folder / file / page nodes), the page content + revision + trash three-state model, cross-page search, and file upload/download. Chain: `kb.js → cws-core (/api/v1) → cws-kb`.

**When to load this document**:

- Lead context assembly, searching the KB for reference material (`kb.search` + `kb.page_content`)
- Distilling experience / writing decision documents / taking notes into the KB (`kb.page_create` / `kb.page_content_write`)
- Organizing the KB directory (`kb.folder_create` / `kb.node_move` / `kb.node_rename`)
- Editing page content / rolling back to an old revision (`kb.page_update` / `kb.page_restore`)
- Soft-deleting a page / permanently deleting (the `kb.page_trash` → `kb.page_delete` three-state chain)
- Registering a file attachment into the KB tree (`kb.upload` or `as.upload` without conversationId)
- Batch-downloading project deliverables via pre-signed links (`kb.file_batch_download`)

**Out of scope for this document**:

- IM message attachments (going through a conversation): `as.upload` with `conversationId` → `references/as-operations.md`
- Task / Issue / Blueprint workflow → `references/tm-operations.md`
- Proactive messaging / creating groups → `references/comm-operations.md`
- Member / project / role directory → `references/core-operations.md`

**Prerequisites**:

- For any command that takes `kbId`, first run `kb.list` to confirm the KB exists (an org has one default KB, `is_default=true`, and can have many more). **KB names are not unique**: when a human names a knowledge base, resolve it as described in "Same-named knowledge bases" below
- `kb.page_create` needs `parentId` (folder node id); get it from `kb.tree_roots` / `kb.node_children`
- `kb.page_update` / `kb.page_content_write` need `baseRevisionId`; first run `kb.page_get` to get the current `revision_id`
- For the full parameter dependency tree, see [`SKILL.md` Efficiency Shortcuts > Parameter Resolution](../SKILL.md)

---

> Layer 3 operation reference. This document stays in 1:1 correspondence with the `src/cli/kb.js` dispatch table.
> The authoritative paths follow the cws-core OpenAPI: `https://zylos01.jinglever.com/cws-core/openapi.json`

CLI location: `src/cli/kb.js`
Invocation: `node src/cli/kb.js <command> '<json>'`

Status: ✅ cws-core BFF already exposes it (all commands are reachable from the CLI).

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF base address |
| `COCO_API_PREFIX` | `/api/v1` | Path prefix |
| `COCO_AUTH_TOKEN` | (empty) | Bearer token (shared with the tm / as / comm / core CLIs) |
| `COCO_ORG_ID` | (empty) | Overrides `config.org_id` |

## Data Model

```
Org (organization, the scope unit)
  └─ KB Config (1 per org, storage_quota / search toggle, etc.)
       │
       ├─ Tree Node (directory tree node)
       │    ├─ kind="folder"  → folder, has only child nodes
       │    └─ kind="page"    → page shell, linked to one Page
       │
       └─ Page (the content body, 1:1 with a tree node)
            └─ Revision (version, auto-incrementing from 1)
```

`org_id` is the scope unit for all KB operations — taken from `config.org_id` or the `COCO_ORG_ID` env var, configured at install time.

## Command List

### KB Collection

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `kb.init` | Initialize the default KB for the current org (idempotent; repeated calls return the existing one) | `{}` | `POST /api/v1/kbs/init` |
| ✅ | `kb.list` | List the KB instances of the current org that you can see (active and archived, most recently changed first). Page size defaults to 20, max 100: when matching a name pass `limit: 100` and page with `offset` until a page comes back short. `statusFilter`: `active` or `archived` | `{limit?, offset?, statusFilter?}` | `GET /api/v1/kbs` |
| ✅ | `kb.create` | Create a new KB instance; `visibility` is one of `open` / `closed` / `private` (default closed); the slug is derived server-side from name. Names are not unique: run `kb.list` first, and never retry a create that timed out or failed without a clear answer (see "Same-named knowledge bases") | `{name, visibility?, description?, icon?}` | `POST /api/v1/kbs` |
| ✅ | `kb.get` | Get the details of a single KB instance | `{kbId}` | `GET /api/v1/kbs/{kb_id}` |
| ✅ | `kb.update` | Edit KB metadata; `set_description` / `set_icon` are tri-state (explicit clear vs leave untouched). Agents cannot change a private KB to an org one or anything to private (see "Same-named knowledge bases") | `{kbId, name?, description?, setDescription?, visibility?, icon?, setIcon?}` | `PATCH /api/v1/kbs/{kb_id}` |
| ✅ | `kb.delete` | Delete a KB; it cannot be restored (use with caution). Refused with 409 `KB_IN_USE_BY_PROJECTS` (`meta.project_count`) while projects, archived ones included, use it: switch those projects to another KB first | `{kbId}` | `DELETE /api/v1/kbs/{kb_id}` |
| ✅ | `kb.archive` | Archive a KB (recoverable) | `{kbId}` | `POST /api/v1/kbs/{kb_id}/archive` |
| ✅ | `kb.unarchive` | Restore an archived KB back to active | `{kbId}` | `POST /api/v1/kbs/{kb_id}/unarchive` |

### Directory Tree

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `kb.tree_roots` | List all top-level nodes under the KB root (folder / page / file) | `{kbId}` | `GET /api/v1/kbs/{kb_id}/tree/roots` |
| ✅ | `kb.folder_create` | Create a folder node (the KB's only explicit node-creation entry point) | `{kbId, parentId?, name}` | `POST /api/v1/kbs/{kb_id}/tree/folders` |
| ✅ | `kb.node_get` | Get node details (common to folder / page / file) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}` |
| ✅ | `kb.node_breadcrumb` | Get a node's ancestor path (root → ... → current) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/breadcrumb` |
| ✅ | `kb.node_children` | List the direct child nodes under a given node | `{kbId, parentId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{parent_id}/children` |
| ✅ | `kb.node_move` | Move a node to another parent (within the same KB) | `{kbId, nodeId, parentId}` | `POST /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/move` |
| ✅ | `kb.node_rename` | Change a node's display name | `{kbId, nodeId, name}` | `PATCH /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/rename` |
| ✅ | `kb.node_delete` | Delete a node (a folder must be empty first; page / file go through their respective trash → delete) | `{kbId, nodeId}` | `DELETE /api/v1/kbs/{kb_id}/tree/nodes/{node_id}` |

Node ID form: `tn-{uuid}`. A Page indirectly creates its corresponding tree node via `kb.page_create`, not through folder_create.

**⚠️ page_id ≠ node_id — when assembling a KB page link, the `?node=` parameter must use node_id, not page_id.** See the dedicated [Frontend Link Assembly](#frontend-link-assembly-agent-error-prone-must-read) section below.

### Pages

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `kb.pages` | List pages (can filter by parent, paginated) | `{kbId, parentId?, cursor?, limit?, offset?}` | `GET /api/v1/pages` |
| ✅ | `kb.page_get` | Get page metadata (including the current revision_id) | `{pageId}` | `GET /api/v1/pages/{page_id}` |
| ✅ | `kb.page_create` | Create a page and return both its page metadata and `node_id` | `{kbId, title, parentId?, format?, body, message?}` | `POST /api/v1/kbs/{kb_id}/pages` |
| ✅ | `kb.page_update` | Edit any page attribute (title / parent / content are all allowed); optimistic concurrency, requires baseRevisionId | `{pageId, title?, path?, content?, baseRevisionId, commitMessage?}` | `PATCH /api/v1/pages/{page_id}` |
| ✅ | `kb.page_delete` | Permanent delete (physical delete); the page must first be in the `trashed` state, otherwise 404 | `{pageId}` | `DELETE /api/v1/pages/{page_id}` |
| ✅ | `kb.page_content` | Get the page's current body content | `{pageId}` | `GET /api/v1/pages/{page_id}/content` |
| ✅ | `kb.page_content_write` | Edit only the content body (a more specialized write entry point, suited to large edits); optimistic concurrency | `{pageId, body, message?, baseRevisionId?, autoSave?}` | `POST /api/v1/pages/{page_id}/content` |
| ✅ | `kb.page_revisions` | List all revisions of a page | `{pageId, limit?, offset?}` | `GET /api/v1/pages/{page_id}/revisions` |
| ✅ | `kb.page_revision` | Get the snapshot content of a specified revision | `{pageId, revisionId}` | `GET /api/v1/pages/{page_id}/revisions/{rev_id}` |
| ✅ | `kb.page_diff` | The diff between two revisions (unified format) | `{pageId, fromRevisionId, toRevisionId}` | `GET /api/v1/pages/{page_id}/diff` |
| ✅ | `kb.page_restore` | Roll back page content to an old revision (status unchanged, **not** trash-restore) | `{pageId, revisionId}` | `POST /api/v1/pages/{page_id}/restore-version` |
| ✅ | `kb.page_trash` | Soft delete (status → `trashed`, goes to the recycle bin) | `{pageId}` | `POST /api/v1/pages/{page_id}/trash` |
| ✅ | `kb.page_restore_trash` | Restore from the recycle bin (status → `active`, **not** a revision restore) | `{pageId}` | `POST /api/v1/pages/{page_id}/restore` |
| ✅ | `kb.pages_trashed` | List the current org's pages in the recycle bin | `{limit?, offset?}` | `GET /api/v1/pages/trashed` |
| ✅ | `kb.page_freeze` | Mark a page read-only (subsequent writes are rejected) | `{pageId}` | `POST /api/v1/pages/{page_id}/freeze` |
| ✅ | `kb.page_references` | List the locations referencing this page (other pages / context_page_ids, etc.) | `{pageId}` | `GET /api/v1/pages/{page_id}/references` |

Page ID form: `pg-{uuid}`. A Revision is a per-page auto-incrementing integer starting from 1.

**The difference between the two write entry points**:

- `kb.page_update` (`PATCH /pages/{pid}`): edits **any page attribute** (title, parent, content…); pass whichever ones you want in the body
- `kb.page_content_write` (`POST /pages/{pid}/content`): edits **only** the content body; more specialized semantics, suited to large follow-up edits by the Agent

Both support optimistic concurrency: first run `kb.page_get` to get `revision_id`, and pass it as `baseRevisionId` when writing; if the server detects a mismatch it returns 409 + the current revision_id, and the client re-reads, merges, then writes again.

**The two "restore" operations are not the same thing, and the Agent often confuses them**:

- `kb.page_restore` (`POST /pages/{pid}/restore-version`): **rolls back to an old revision**; the page's status is unchanged. Used to "undo the last N edits".
- `kb.page_restore_trash` (`POST /pages/{pid}/restore`): **restores from the recycle bin**, changing status from `trashed` back to `active`. Unrelated to revisions.
- The paths are similar but the semantics differ; **don't guess from the name** — when you encounter "restore", first figure out whether it is trash-restore or revision-restore.

**Three-state protection chain: trash → permanent_delete**:

- `kb.page_delete` is a **permanent delete** (physical delete), unrecoverable, so cws-kb requires the page to already be in the `trashed` state: you must first run `kb.page_trash` to throw the page into the recycle bin, then `kb.page_delete`.
- Calling `kb.page_delete` directly on an `active` page returns 404 from cws-kb (not the most honest semantics; this is cws-kb#193; but the semantic protection itself is retained, so don't work around it).
- Full flow: `page_create → ... → page_trash → page_delete`. If you want to undo partway through, use `page_restore_trash` to pull it back, and **when you delete again you must trash it once more first**.

**404 on a page write: the knowledge base is gone** (not a gateway problem):

- `kb.page_create` into a knowledge base that was deleted, doesn't exist or is no longer accessible to you is refused (nothing is written). cws-core answers 404 with `code: "KB_NOT_FOUND"` and `meta.kb_id`; a cws-core without that code answers a plain 404 (`code: "KB_ERROR"`). On a 404 from `kb.page_create` the CLI's error JSON carries, next to `error` / `status`: `code` (when the response had one), `kbId` and a `hint`. Example: `{"error":"This knowledge base was deleted, does not exist, or is not visible to you. …","status":404,"code":"KB_NOT_FOUND","kbId":"…","hint":"…"}`.
- With `parentId`, a plain 404 can also mean the parent folder is gone; the `hint` then says to run `kb.get {kbId}`: 404 there = the knowledge base is gone or not accessible to you, otherwise only the folder is (re-read the tree). A current cws-core already tells them apart: `KB_NOT_FOUND` is the knowledge base, `KB_ERROR` 404 with a `parentId` is the folder.
- `kb.page_restore_trash` answered 404 can mean the page is no longer in the trash, or that its knowledge base was deleted or is no longer accessible to you (a page cannot be restored into a deleted knowledge base); the `hint` says so.
- A 404 **without** a cws-core error body (no `code`) is not an answer about the knowledge base: it can come from a proxy or a wrong server URL. The `hint` then says to run `kb.get {kbId}`: a cws-core 404 there means the knowledge base is gone or not accessible to you; another failure without a cws-core error body, or a success there (the knowledge base exists), means the 404 did not come from cws-core: a connection or configuration problem, not a deleted knowledge base. For `kb.page_restore_trash` (whose output has no `kbId`) the hint points to `kb.pages_trashed` instead.
- A knowledge base that is gone or no longer accessible is never "gateway not connected" or "temporarily unsupported": do not retry the same `kbId` and do not switch to another KB on your own. Tell the owner the knowledge base was deleted, doesn't exist or is no longer accessible to you, and ask them to restore your access, pick or re-create one, or update the project's (or automation's) knowledge base (if only your access is gone, the documents are still there: restoring access is the fix). See [`SKILL.md` "Writing into a deleted knowledge base"](../SKILL.md).

### Search ⭐

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `kb.search` | Cross-page full-text search; ReBAC filtering (returns only pages where the caller has viewer+ permission) | `{query, kbId?, folderId?, authorId?, format?, pageSize?, pageToken?, sync?}` | `GET /api/v1/search/pages` |

Underlying: **Meilisearch (fuzzy + typo tolerance + Chinese word segmentation) + NATS event-driven indexing**. Return structure:

```json
{
  "results": [
    {
      "page": { "id": "pg-...", "title": "...", "path": "...", "format": "markdown" },
      "highlights": [
        { "field": "title", "snippet": "Week 21 <mark>Weekly Meeting Minutes</mark>" },
        { "field": "body",  "snippet": "..." }
      ],
      "score": 0.98
    }
  ],
  "pagination": { "next_page_token": null, "total_count": 1 }
}
```

**`sync=true` is for the Agent**: when the Agent searches right after writing a page, the async index may not be built yet. `sync=true` waits for the Meilisearch task to complete before returning (up to a 5s timeout), guaranteeing you read what was just written. Human users default to async for fast UX.

Rate limit: 1000 requests/minute/workspace.

### File Attachments (KB Upload Only)

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `kb.upload` | Upload a file and register a file node in the KB tree (syntactic sugar for KB-mode upload) | `{kbId, filePath, parentId?, contentType?, filename?}` | Delegates to `as.uploadMedia()` → the three prepare/PUT/finalize steps, see `references/as-operations.md` |
| ✅ | `kb.file_create` | Register a file node in the KB tree using an existing artifact (the last internal step of `kb.upload`) | `{kbId, name, artifactId, parentId?}` | `POST /api/v1/kbs/{kb_id}/tree/files` |
| ✅ | `kb.file_preview` | Get a file node's inline preview URL (embedded in the browser) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/preview` |
| ✅ | `kb.file_download` | Get a single file node's download URL (inline optional) | `{kbId, nodeId, inline?}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/download` |
| ✅ | `kb.file_batch_download` | Get pre-signed download URLs for multiple file nodes at once | `{kbId, nodeIds, inline?}` | `POST /api/v1/kbs/{kb_id}/tree/files/batch-download` |

`kb.upload` is syntactic sugar for `as.upload` without `conversationId` in KB mode, and **a file node will appear in the KB tree** (the response has `nodeId` + `treeNode`); afterwards you can operate on it with `kb.node_get` / `kb.file_preview` / `kb.file_download`.

**Do not use `kb.upload` to send conversation attachments**: images or files in a conversation / DM must go through **IM upload** (`as.upload` with `conversationId`; see "Which upload path to use" at the top of [as-operations.md](./as-operations.md)), otherwise the file is attached to the KB but the recipient cannot see it in their chat window.

The returned `mediaId` / `artifactId` can also be dropped into a Page body (e.g. writing `![](artifact://<id>)` in markdown), letting the page body directly reference this artifact.

## Typical Flows

### Agent writes a page of weekly meeting minutes then immediately searches to verify

```bash
# 1. Create the page
node src/cli/kb.js kb.page_create '{
  "kbId":"<kb-uuid>",
  "title":"2026-05-21 Weekly Meeting Minutes",
  "parentId":"<folder-node-id>",
  "format":"markdown",
  "body":"# 2026-05-21 Weekly Meeting Minutes\n\n## Agenda\n\n...",
  "message":"feat: Agent auto-generated weekly meeting minutes"
}'
# -> {id:"pg-...", current_revision_id:1, ...}

# 2. Immediately search to verify (sync=true waits for the index to be built)
node src/cli/kb.js kb.search '{"query":"weekly meeting minutes","sync":true,"limit":5}'
# -> {results:[{page:{id:"pg-..."}, highlights:[...], score:0.95}], ...}
```

### Lead context assembly — finding a project's design decision document

```bash
# 1. Search within a given folder
node src/cli/kb.js kb.search '{
  "query":"architecture decisions",
  "folderId":"tn-projects-growth",
  "format":"markdown",
  "limit":20
}'

# 2. After getting the page_id, read the detailed content
node src/cli/kb.js kb.page_content '{"pageId":"pg-arch-decisions-001"}'

# 3. Look at the change history (if the content seems off)
node src/cli/kb.js kb.page_revisions '{"pageId":"pg-arch-decisions-001"}'
node src/cli/kb.js kb.page_diff '{
  "pageId":"pg-arch-decisions-001",
  "fromRevisionId":3,
  "toRevisionId":5
}'
```

### Attaching an Agent's output under a KB node

```bash
# 1. Upload the output file via as.js (KB mode, without conversationId)
node src/cli/as.js as.upload '{
  "filePath":"/tmp/q2-report.pdf",
  "mediaType":"file"
}'
# -> {artifactId:"art_...", nodeId:"tn-...", treeNode:{...}, instantUpload:false}

# 2. Write a deliverables index page that references this artifact
node src/cli/kb.js kb.page_create '{
  "kbId":"<kb-uuid>",
  "parentId":"<deliverables-folder-id>",
  "title":"Q2 Deliverables Index",
  "body":"# Q2 Deliverables\n\n- [Report](artifact://art_...)"
}'
```

## Relationship to SKILL.md

This document is a Layer 3 sub-skill of [`SKILL.md`](../SKILL.md), responsible only for the KB CLI's **command mechanics**. The behavioral content below is **in SKILL.md** and is not repeated here:

| Want to see | Which SKILL.md section |
|---|---|
| The KB-write boundary between Lead vs Worker (experience distillation vs task output) | [Role Model](../SKILL.md) |
| When to pass a page to an Issue/Task via `contextPageIds` | [Efficiency Shortcuts > Context Passing](../SKILL.md) |
| The timing and location of KB experience distillation (`/projects/{slug}/decisions/`, etc.) | [Memory Triggers > Experience Distillation Judgment](../SKILL.md) |
| General error prevention (e.g. you shouldn't call the KB API directly with curl) | [Behavioral Guardrails > Common Errors](../SKILL.md) |

## Frontend Link Assembly (Agent-Error-Prone, Must Read)

A KB page has **two kinds of ID**, and mixing them up causes the link to open blank or 404:

| ID Type | Source | Use | Example |
|---|---|---|---|
| **page_id** | the `id` returned by `kb.page_create` / `kb.page_get` | Page content operations (read/write, revision, trash) | `019ed02a-62cc-...` |
| **node_id** | the `node_id` returned by `kb.page_create`, or the `id` returned by `kb.node_get` / `kb.node_children` | Directory tree operations + **frontend URL** | `019ed02a-62d5-...` |

**Core rule: the frontend URL's `node=` parameter only accepts node_id. Putting a page_id in makes the link point to the wrong location.**

### Create response contract

`kb.page_create` creates both the page and its corresponding tree node. Its response returns the page as the top-level object and includes the created tree node as `node_id`:

```json
// kb.page_create response
{"id": "019ed02a-62cc-...", "node_id": "019ed02a-62d5-...", "kb_id": "...", "title": "...", "path": "...", ...}
//  id is the page_id; node_id is the tree node used by frontend links
```

`kb.page_get` still returns page metadata only. If a page did not come from the current `kb.page_create` response, obtain its node ID from the tree.

### The correct link-generation flow

To share a link immediately after creating a page, use the returned `node_id` directly:

```bash
# 1. Create the page → get both page_id and node_id
node src/cli/kb.js kb.page_create '{
  "kbId":"<kb-uuid>",
  "title":"Design Proposal",
  "parentId":"<folder-node-id>",
  "body":"# Proposal content..."
}'
# → {"id":"pg-abc123", "node_id":"tn-xyz789", ...}

# 2. Assemble the frontend link with the returned node_id
node src/cli/core.js core.frontend_url '{"path":"/knowledge?kb=<kb-uuid>&node=tn-xyz789"}'
# → https://xxx/cws/knowledge?kb=...&node=tn-xyz789    ✅ correct
```

**Counter-example (wrong)**:
```bash
# ❌ Using the page id (`id`) instead of `node_id`
node src/cli/core.js core.frontend_url '{"path":"/knowledge?kb=<kb-uuid>&node=pg-abc123"}'
# → the link opens but shows blank or points to the wrong location
```

### You have a page_id but don't know the node_id

If you have only the page_id (e.g. obtained from `kb.search` results), use `kb.page_get` to read the `path` field to locate the directory, then use `kb.node_children` to match by `page_id` under the corresponding folder.

### URL Format Quick Reference

For the full URL template, see [`SKILL.md` Frontend Links](../SKILL.md). Quick reference:

```
{bff_url}/cws/knowledge?kb={kb_id}&node={node_id}
                                         ↑ must be the tree node_id, not the page_id
```

You can generate it in one step with the `core.frontend_url` CLI, avoiding errors from hand-assembling the domain and prefix.

## Same-named knowledge bases

Knowledge base names are not unique: two org knowledge bases, an org one and a private one, or two of one person's private ones can all have the same name, and an archived knowledge base keeps its name without blocking a new one. Every command addresses a knowledge base by `kbId`; a name only matters when a human names a knowledge base in prose and you have to map it to an ID.

- **Resolve a name by listing everything**: `kb.list {limit: 100}` and page with `offset` until a page comes back short; compare names exactly after trimming. A partial or fuzzy match is a candidate, not a match.
- **One match**: use it.
- **Several matches: ask, never pick one yourself.** List each candidate with its link (`core.frontend_url {"path":"/knowledge?kb=<id>"}`), creator (resolve `creator_id` with `core.member_get {memberId}`; fall back to the ID if that fails), private or org (`visibility`: `private` = only its owner and the owner's Agents see it, `open` / `closed` = org knowledge base), status (active / archived) and last update (`last_modified_at`, else `updated_at`), and ask the human which one they mean. Do not choose by default status, recency or your own guess, and do not repeat the question once the human has answered it.
- **Before creating**: run `kb.list` and check whether a knowledge base with that name already exists. If one does, tell the human and ask whether to use it or really create another one with the same name.
- **Never blindly retry `kb.create`**: a create that timed out or failed without a clear answer may already have created the knowledge base, and a second call now silently creates a second one with the same name (it used to fail with a name conflict). Run `kb.list` first and only create again if it is not there.
- **Private to org is a human decision**: an Agent cannot convert a knowledge base between private and org; only its owner, signed in directly in the web app, can (cws-core: an Agent without `kb.manage` gets 403 `AUTH_FORBIDDEN`; the owner's own Agents holding `kb.manage` get 400 `KB_PRIVATE_VISIBILITY_RESERVED`; other `kb.manage` holders get 404, since a private knowledge base is not theirs to see; the owner's personal access tokens and app tokens get 400 too). If a human wants a private knowledge base shared with the whole organization, tell them its owner (the person who created it) can do it in the web app if the workspace has it turned on: open the knowledge base, ⋯ menu, 「转为组织知识库」 (Convert to org knowledge base). That menu item sits behind a runtime switch that is off until each environment turns it on, so it may not be there yet: if the owner does not see it, tell them plainly that converting is not available in this workspace yet, and do not try to convert the knowledge base any other way (for example by recreating it as an org one and copying the pages over) unless they explicitly ask for that. After converting, everyone in the organization and all Agents can see and edit it, including its history, and it cannot be turned back to private; only org admins can then rename, archive or delete it. It always becomes an open (organization-wide) knowledge base: asking for `closed` is refused (412 `KB_PRIVATE_VISIBILITY_IMMUTABLE` `meta.reason: not_open`). It cannot be converted while it is the owner's personal knowledge base (「我的知识库」, 412 `KB_PRIVATE_VISIBILITY_IMMUTABLE` `meta.reason: personal`), while it is archived (`meta.reason: archived`; restore it first), while projects use it, archived projects included (409 `KB_IN_USE_BY_PROJECTS` with `meta.project_count`; switch those projects to another knowledge base first), or, once no project uses it, while automations (enabled or paused) store their outputs in it or unfinished Issues (neither accepted nor terminated) are located in it (409 `KB_IN_USE_BY_AUTOMATIONS_OR_ISSUES` with `meta.automation_count` and `meta.open_issue_count`; they would keep writing into it once the whole organization can see it, so point those automations at another knowledge base and finish or terminate those Issues first). Nothing can be changed to private (412 `KB_PRIVATE_VISIBILITY_IMMUTABLE` `meta.reason: to_private`).

## KB-Specific Caveats

- **org_id is required**: every command needs a scope. If `config.org_id` is not set, it throws.
- `kb.list`: an org can have many knowledge bases and several can share a name; never pick one by name alone (see "Same-named knowledge bases")
- Page writes are rate-limited: 60 requests/minute/user (`rate_limited` 429)
- `kb.search` results are ReBAC-filtered: only pages where the caller has `viewer+` permission are returned
- `format` values: `markdown` / `code` / `pdf` / `image` / `archive` / `other`
- Tree node ordering: nodes under the same parent are ordered by `sort_order`; when moving a node you can specify a new `sortOrder`
- Cross-org references use the `kb://pg-{uuid}` URI (a stable ID, unchanged by move / rename)
- `kb.page_delete` called directly returns 404 — you must run `kb.page_trash` first; this is cws-kb's three-state protection chain (don't work around it)
- `kb.page_create` 404 / `KB_NOT_FOUND` = the knowledge base was deleted, doesn't exist or is no longer accessible to you (see "404 on a page write" above); report it to the owner, never as "gateway not connected"
- `kb.page_restore` vs `kb.page_restore_trash` have similar names but completely different semantics; see "The two restore operations are not the same thing" above
- **The frontend URL only accepts node_id**: after `kb.page_create`, use its `node_id` field, never its page `id`. If only a page_id is available from another operation, resolve the corresponding node from the tree. See the dedicated "Frontend Link Assembly" section above
