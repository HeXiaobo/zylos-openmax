# AS Operations Guide

**Purpose**: ArtifactStore operations — byte upload of files / media + download URL resolution. Covers the two upload paths, conversation attachments (IM mode) and KB file nodes (KB mode), as well as pre-signed URL resolution and local download of artifacts.

**When to load this document**:

- To send a local file as a conversation attachment (image / PDF / audio recording, etc.), use `as.upload` in IM mode (with `conversationId`)
- To archive a file into the KB tree, use `as.upload` in KB mode (without `conversationId`, optional `parentId`) or `kb.upload`
- Received a reference in the form `artifact://<id>` and need its content: download it with `as.download` and work on the local copy
- To download the bytes of a remote artifact locally for analysis (`as.download`)
- A process of your own must fetch the bytes itself right away (`as.url` for a single one / `as.resolve` for a batch) — the URL is short-lived and never goes into a message
- To troubleshoot why a file "uploaded successfully but can't be sent" or "was attached to the KB but search can't find it" (almost always the wrong choice between IM vs KB mode)

**Out of scope for this document**:

- KB page / folder / tree node operations → `references/kb-operations.md`
- Referencing attachments when sending messages → `references/comm-operations.md` (the `content` field of a `[STRUCTURED]` body)
- Task / Issue / Blueprint workflow → `references/tm-operations.md`
- **artifact CRUD** (list / get / update / delete / abort) → **retired in v5**, not exposed by the cws-core BFF; bytes are immutable, re-upload to change content

**Prerequisites**:

- IM upload requires a `conversationId` first (obtained from `comm.create_dm` / `comm.list_conversations`)
- The `parentId` (folder node id) for KB upload comes from `kb.tree_roots` / `kb.node_children`; if omitted, it attaches to the KB root
- `as.url` / `as.download` require an already-obtained `artifactId` or `artifact://` URI (usually from a previous `as.upload` response, or a reference someone else sent)
- For the full parameter dependency tree, see [`SKILL.md` Efficiency Shortcuts > Parameter Resolution](../SKILL.md)

---

> Layer 3 operations reference. This document maintains 1:1 correspondence with the `src/cli/as.js` dispatch table.
> The authoritative paths are per the cws-core OpenAPI: `https://zylos01.jinglever.com/cws-core/openapi.json`

CLI location: `src/cli/as.js`
Invocation: `node src/cli/as.js <command> '<json>'`

> `as.js` has a **dual role** within zylos-openmax:
> - As a CLI: the Agent explicitly calls `node src/cli/as.js <cmd>`
> - As a library: `scripts/send.js`, `src/comm-bridge.js`, and `src/cli/kb.js` all `import` `uploadMedia` / `getMediaUrl` / `downloadMedia` from this file — the repo's **only** entry point for upload / download implementation
>
> Everything involving binary bytes goes through here; do not write a second copy.

Status: ✅ All v5 paths go through the cws-core BFF (`/api/v1/...`), and the underlying cws-core then does connect-RPC to cws-as.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF base address |
| `COCO_API_PREFIX` | `/api/v1` | Path prefix |
| `COCO_AUTH_TOKEN` | (empty) | Bearer token (shared with the tm / kb / comm / core CLIs) |
| `COCO_ORG_ID` | (empty) | Overrides `config.org_id` |

---

## ⚠ Which upload path do you take? IM or KB?

**`as.upload` is a dual-mode entry point that decides which server-side path to take based on whether `conversationId` is present. Choosing wrong will fail.**

| Your purpose | Take IM upload or KB upload | How to call the CLI |
|---|---|---|
| **Send images / files in a chat / conversation** (user to agent / agent to user) | **IM upload** | `as.upload {filePath, conversationId, mediaType:"image"/"file"}` — **must include conversationId** |
| **Archive material to the KB** (project deliverables, research note attachments) | **KB upload** | `kb.upload {kbId, filePath, parentId?}` or `as.upload {filePath, parentId?}` — **without conversationId** |
| Agent outbound media message (`scripts/send.js [MEDIA:image]/path`) | **IM upload** (send.js selects automatically internally) | Directly `c4-send.js openmax "<conv>" "[MEDIA:image]/path"` |

### Server-side path comparison

| Mode | prepare endpoint | finalize endpoint | Returned fields |
|---|---|---|---|
| **IM** | `POST /api/v1/conversations/{cid}/uploads/prepare` | `POST /api/v1/conversations/uploads/finalize` | `{media_id, artifact_id, ...}` — used for the attachments of `[STRUCTURED]` / `[MEDIA:…]` sends (`send.js`) |
| **KB** | `POST /api/v1/uploads/prepare` (body includes `parent_id`) | `POST /api/v1/uploads/finalize` | `{node_id, artifact_id, tree_node, ...}` — a file node appears directly in the KB tree |

### What happens if you choose wrong

- **Want to send to a conversation but omit conversationId** → the CLI takes the KB path, the file attaches to the KB root directory, **does not appear in the chat box**, and the recipient sees nothing at all.
- **Want to archive to the KB but include conversationId** → the CLI takes the IM path, the artifact attaches to some conversation but is **not in the KB tree**, and neither KB retrieval nor `kb.search` can find it.
- **The artifact_id field is located differently in the two paths**; stuffing an IM `media_id` back into a KB operation as if it were a KB `node_id` (e.g. trying to use `kb.file_create artifactId=...`) will fail.

⚠️ This rule is strongly tied to the cws-comm / cws-kb backend architecture: on the IM path the artifact is bound to `conversation_id`, and on the KB path the artifact is bound to `org_id` + `kb_id`. Which path to take **can only be decided by the caller during the prepare stage**; switching later requires re-uploading.

---

## v5 three-step upload (every `as.upload` goes through this)

v5 splits uploads into two parallel flows by "purpose", sharing the same prepare → PUT → finalize rhythm, only with a different namespace for prepare / finalize. `as.upload` automatically selects the branch based on whether `conversationId` is present.

```
                 local file
                    │
        ┌───────────┴───────────┐
        │                       │
   has conversationId       no conversationId
        │                       │
        ▼                       ▼
   ┌──────────────┐        ┌──────────────┐
   │  IM upload   │        │  KB upload   │
   └──────────────┘        └──────────────┘
        │                       │
  1. POST /api/v1/conversations  1. POST /api/v1/uploads/prepare
     /{cid}/uploads/prepare         Body: {parent_id?, filename,
     Body: {filename,                      content_type, size_bytes}
            content_type,
            size_bytes}
        │                       │
        └───────────┬───────────┘
                    │
            common response fields:
              {upload_token, upload_url, headers,
               expires_at, instant_upload}
                    │
        ┌───────────┴───────────┐
        ├─► instant_upload=true ──► skip PUT (instant-upload hit, bytes already in S3)
        │
        │  2. PUT <upload_url>
        │     Body: raw bytes
        │     Headers: the headers from the response (Content-Type, etc.)
        │     (bytes go directly to S3 / MinIO / R2, not through cws-core / cws-as)
        │
        ▼
   ┌──────────────┐        ┌──────────────┐
   │ IM finalize  │        │ KB finalize  │
   └──────────────┘        └──────────────┘
        │                       │
  3. POST /api/v1/conversations  3. POST /api/v1/uploads/finalize
     /uploads/finalize             Body: {upload_token}
     Body: {upload_token}          Resp: <tree_node>
     Resp: {media_id,                    (KB file node, includes artifact_id)
            artifact_id}
        │                       │
        └───────────┬───────────┘
                    ▼
{mediaId, artifactId, [nodeId, treeNode (KB only),]
 fileName, mimeType, sizeBytes, instantUpload}
```

After the underlying cws-core receives the prepare / finalize, it calls cws-as via connect-RPC to complete artifact registration, SHA-256 verification, state machine advancement, etc.; the Agent side only sees these 3 steps on the cws-core BFF.

**Instant upload (`instant_upload`)**: the server looks up an existing active artifact by SHA-256, and on a match returns `instant_upload=true` directly, and the client skips the PUT step. When the Agent repeatedly uploads the same file (e.g. a screenshot), only the first time actually transfers the bytes.

**Old path retired**: in the contract-v4 era there was a single-flow upload that directly created an artifact via `POST /api/v1/artifacts` + wrapped it up via `POST /api/v1/artifacts/{id}/finalize`; this is deprecated in v5, and cws-core no longer registers these two routes. If you see this style of call in old code, migrate it to one of the two namespaces above.

## Command List

| Status | Command | Description | Input params | Real endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `as.upload` | Dual-mode upload: with `conversationId` takes IM (conversation attachment), without takes KB (archive into the KB tree) | `{filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}` | Dual-mode prepare/finalize (see the flow diagram above) |
| ✅ | `as.download` | **Preferred.** Resolve a fresh link + byte GET (follows its redirect), downloads to `~/zylos/components/openmax/media/<filename>` | `{artifactId\|uri, filename?}` | `POST /api/v1/artifacts/resolve` + byte download to local |
| ✅ | `as.url` | Get a short-lived download URL for a single artifact, for immediate use by this agent's own process only (attachment by default, optional inline preview) | `{artifactId\|uri, inline?}` | `POST /api/v1/artifacts/resolve` (takes the first `download_url`) |
| ✅ | `as.resolve` | Batch-resolve an array of `artifact://<id>` URIs to short-lived download URLs (for inter-service calls) | `{uris:["artifact://<id>", ...], inline?}` | `POST /api/v1/artifacts/resolve` |

> ⚠️ **Download URLs are short-lived and may be single-use. Never put one in a chat message, a delivery, a comment, a KB page or memory.** To work on a file, `as.download` it and read the local copy. To point a person at a file, attach it to a message (`artifactId`) or use a durable link (see [Durable artifact links](automation-delivery.md#durable-artifact-links)).

> **v5 BFF deliberately narrows the surface**: the old cws-as direct-connect artifact CRUD (`as.list / as.get / as.update / as.delete / as.abort`, corresponding to `GET\|PATCH\|DELETE /artifacts/{id}` + `POST /artifacts/{id}/abort`) is **no longer exposed through the cws-core BFF in v5** — these endpoints all return 404. If some capability needs to be restored later, you must first add the route in the cws-core BFF and then supplement the CLI. Artifact bytes are immutable; the normal workflow is for `as.upload` to create a new one, leaving the old one as history.

### `as.upload` details

| Parameter | Type | Description |
| --- | --- | --- |
| `filePath` | string | **Required**, local absolute path |
| `conversationId` | uuid | **Set this → IM upload** (conversation attachment). The return contains `mediaId` and `artifactId`; message attachments must reference **`artifactId`** |
| `parentId` | uuid | Only used for KB upload; the id of some folder node in the KB tree; if omitted, attaches to the KB root |
| `mediaType` | `image\|video\|audio\|voice\|file\|sticker` | Defaults to `file`; affects automatic MIME inference |
| `contentType` | string | Explicit MIME (overrides mediaType inference) |
| `filename` | string | Overrides the default filename (defaults to the filePath basename) |

**`conversationId` and `parentId` are mutually exclusive**: the IM path does not accept parent_id, and the KB path does not accept conversation_id. If both are passed, only `conversationId` takes effect (takes IM).

Return (IM mode):

```json
{
  "mediaId":       "01a12147-a2d9-7f0d-bd37-c315232404bb",
  "artifactId":    "01a12147-a3f1-7c22-9e10-5b6d0c7e1f42",
  "fileName":      "Q2-product-plan.pdf",
  "mimeType":      "application/pdf",
  "sizeBytes":     5242880,
  "instantUpload": false
}
```

KB mode additionally carries the `nodeId` + `treeNode` fields.

⚠️ **IM mode: `mediaId` and `artifactId` are different ids** (`media_id` / `artifact_id` from finalize). A chat message's `attachments[].artifact_id` must be the **`artifactId`**; using `mediaId` yields an image/file that never loads. Only in **KB mode** is `mediaId` an alias of `artifactId` (backward compatibility).

### `as.url` details

| Parameter | Type | Description |
| --- | --- | --- |
| `artifactId` / `uri` | string | Required (accepts both the `artifact://<id>` form or a bare id) |
| `inline` | bool | true → uses inline disposition (in-browser embedded preview), false → attachment (force download) |

Returns `{url, expiresAt, contentType, contentLength, name, shortLived: true, notice}`.

The URL is **short-lived and may be single-use**: it can be a platform download
link that expires within about a minute, works once, and redirects to the
storage object, or a pre-signed storage URL with its own short expiry. Read the
actual `expiresAt`; never assume a default TTL. Fetch it immediately in your own
process, once; if that fetch fails, call `as.url` again for a new link rather
than retrying the same one. **Do not post it in a message, delivery, comment, KB
page or memory** — `notice` in the output repeats this. Usually you want
`as.download` instead. For retained automation outputs use the verified
authenticated artifact route or an existing KB link, following
[Durable artifact links](automation-delivery.md#durable-artifact-links).

### `as.download` details

| Parameter | Type | Description |
| --- | --- | --- |
| `artifactId` / `uri` | string | Required |
| `filename` | string | Landing filename, defaults to being taken from the artifact metadata |

Returns `{localPath}`, landing at `~/zylos/components/openmax/media/<filename>`. Internally = resolve a fresh link + byte GET, following the link's redirect to the storage object. If the fetch fails, it resolves a **new** link once and tries again (a used or expired link is never requested twice). Once the Agent gets `localPath`, it can be used as vision / file-read input — this is the way to work on a file someone sent.

### `as.resolve` details

Batch-resolves URIs in the `artifact://<id>` form into short-lived download URLs. Artifacts without permission do not 403 but return partial results (listed in the `failed` field).
These URLs are short-lived and may be single-use, like `as.url`'s (the output carries the same `shortLived: true` and `notice`); never post or persist them.

```bash
node src/cli/as.js as.resolve '{"uris":["artifact://art_y","artifact://art_z"]}'
# -> {resolved:{...}, failed:[...], shortLived:true, notice:"..."}
```

## Typical Flows

### Agent sends an image to the user (`scripts/send.js` takes this automatically)

```bash
# Outbound via C4:
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js \
  openmax '<conv-uuid>' '[MEDIA:image]/tmp/chart.png'
```

Inside `scripts/send.js`:

1. Parses `[MEDIA:image]/tmp/chart.png`
2. `as.uploadMedia('/tmp/chart.png', {mediaType:'image'})` → `{artifactId, mediaId, ...}`
3. `POST /api/v1/conversations/{id}/messages` body `{type:"IMAGE", content:{content_type:"image", body:{file_name}, attachments:[{artifact_id:<artifactId>, file_name, content_type, size_bytes}]}}`

### Agent views an image the user sent (`comm-bridge.js` takes this automatically)

WS pushes over a frame `{content:{media_id:"art_xyz"}, ...}`, inside comm-bridge:

1. `as.downloadMedia("art_xyz", filename, orgId)` → resolves a fresh short-lived link, follows its redirect, saves to `/home/cocoai/zylos/components/openmax/media/<file>` (re-resolves once if the fetch fails)
2. Stuffs the local path into the C4 outbound text as `---- image: <localPath>` — the Agent sees the tag and automatically invokes vision
3. An attachment that cannot be fetched is still shown, never dropped: a failed download appears as `---- artifact_id: <id> name="…" [附件无法获取]` (retry with `as.download` by that id), and an attachment with no artifact id as `---- [附件无法获取] name="…" content_type="…"` (only the fields that are present)

### Agent proactively calls the CLI

Usually **there is no need to call the as.js CLI directly**, because send.js and comm-bridge use it automatically. For manual management:

```bash
# Upload a PDF (KB mode: without conversationId)
node src/cli/as.js as.upload '{
  "filePath":"/tmp/report.pdf",
  "mediaType":"file"
}'
# -> {artifactId:"art_...", nodeId:"...", treeNode:{...}, instantUpload:false}

# Download locally for analysis (the normal way to read a file)
node src/cli/as.js as.download '{"artifactId":"art_..."}'
# -> {localPath:"/home/cocoai/zylos/components/openmax/media/<filename>"}

# A short-lived URL for your own process to fetch right away (never for a message)
node src/cli/as.js as.url '{"artifactId":"art_..."}'
# -> {url:"https://...", expiresAt:"...", contentType:"...", name:"...", shortLived:true, notice:"..."}

# Batch-resolve multiple URIs (for inter-service calls)
node src/cli/as.js as.resolve '{"uris":["artifact://art_a","artifact://art_b"]}'
# -> {resolved:{...}, failed:[...], shortLived:true, notice:"..."}
```

## Selection Comparison

| Signal | Where to go |
| --- | --- |
| Content can be expressed in Markdown | KB Page (`kb.page_create`) |
| Binary (image / PDF / dataset) | `as.upload` + reference `media_id` in a message / KB |
| Large volume (MB / GB scale) | `as.upload` — uses pre-signed PUT to transfer directly to S3, bytes do not pass through the server |
| Temporary sharing into a conversation | `as.upload` (IM mode) + `[STRUCTURED]` reference (or `[MEDIA:…]`) |
| Long-term referenced project deliverable | `as.upload` (KB mode) + register the `artifact://` URI on a KB page |
| Uploading the same file multiple times | The server automatically instant-uploads by SHA-256 (`instant_upload=true`) |

## Relationship with SKILL.md

This document is a Layer 3 sub-skill of [`SKILL.md`](../SKILL.md), responsible only for the **command mechanics** of the AS CLI (plus the unique "which path to choose" question of IM vs KB dual-mode). The following behavioral-surface content is **in SKILL.md** and is not repeated in this document:

| Want to see | Which section of SKILL.md to go to |
|---|---|
| Where to attach Lead experience distillation vs Worker task output | [Role Model](../SKILL.md) (the KB writing line) |
| How the output of `as.upload` is passed to a Task via `contextPageIds` | [Efficiency Shortcuts > Context Passing](../SKILL.md) |
| General error protection (do not curl direct-upload / do not bypass the CLI) | [Behavior Guardrails > Common Mistakes](../SKILL.md) |

## AS-specific Notes

- Artifacts are immutable; "modifying" = creating anew, leaving the old one as history
- `artifact_id` / `media_id` are server-generated UUIDs (e.g. `01a12147-a2d9-7f0d-...`)
- Single-file size limit is 5 GB (exceeding returns `payload_too_large` 413)
- `mime_type` blacklist: executable files (`.exe` / `.sh`, etc.) return `unsupported_media_type` 415
- Pre-signed PUT URL TTL is 1 hour; on timeout you need to re-call the corresponding prepare endpoint (IM: `POST /api/v1/conversations/{cid}/uploads/prepare`; KB: `POST /api/v1/uploads/prepare`) to get a new `upload_token` + `upload_url`
- For large files (>100MB), cws-as automatically selects Multipart mode (`upload_mode:"multipart"`); the current `uploadMedia()` is still a single PUT, and the large-file scenario needs to be extended (marked TODO)
- `as.resolve` is for inter-service calls: artifacts without permission are skipped rather than 403, to avoid one failure dragging down the whole batch
- Resolved download URLs are short-lived and may be single-use: fetch once, right away; on failure resolve again; never post or store them
- Both `mediaId` and `artifactId` are returned. In **IM mode they differ** and message attachments must use `artifactId`; only in KB mode are they synonyms
- Choosing wrong between IM mode vs KB mode is the most common pitfall — different return fields + different downstream operation visibility, see "⚠ Which upload path do you take" above
