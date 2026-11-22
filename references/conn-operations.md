# Connection Operations Reference

CLI: `node src/cli/conn.js <command> '<json>'`

## What a Connection is (read this first)

A **Connection** is a third-party app or account — mail, chat, calendar, docs, a tracker, any external SaaS/API — that an owner has **authorized directly to you** through cws-connect. It is this platform's **preferred** way to act on an external service: when a connection exists for the app, use it. You pick an action from the app's catalog and `conn.invoke` it; the token is handled for you — you never hardcode a provider URL or craft a raw HTTP request.

**One universal flow works for every app — you never pre-learn a specific provider:**

1. **`conn.list`** — which apps/accounts are authorized to you right now (each entry pairs an `application` with a `connectionId` + `status`).
2. **`conn.catalog {app}`** (or `conn.app_actions {applicationId}`) — the app's **action catalog**: every action it exposes, each carrying an `input_schema` (JSON Schema) that describes that action's parameters.
3. **`conn.invoke {app, action, params}`** — run the chosen action with `params` shaped by its `input_schema`. The credential is handled for you; `conn.invoke` auto-routes by the connection's `credential_mode` (**`direct`** = local token + your own egress, **`proxy`**/Composio = server-side execute) — see "Two execution models" above.

**Large catalogs (Composio connectors with hundreds of actions):** one discovery call returns only the first page (about 50 actions), so the action you need may simply not be in it. For such an app, **first search by keyword** with `conn.actions_search {applicationId, query}` (e.g. `"report"`, `"search"`, `"list"`, `"send"`), pick the action from the matches, then **`conn.action_describe {applicationId, action}`** for that one action to get its full `input_schema` (search/list entries are lightweight and their `input_schema` may be empty), then `conn.invoke` it with params shaped by that schema. Describe only the action you chose, not every match. When `conn.actions` / `conn.app_actions` / `conn.actions_search` return a `next_cursor`, more pages exist: pass it back unchanged as `cursor` to fetch the next page. See "Paging and search" below.

Because you read the catalog and its `input_schema` **at call time**, the same three verbs drive *any* connected app. What differs per app is only the action names and their `input_schema` — which you **discover, never hardcode** — so a newly-added provider needs zero changes here.

**When the app you need isn't in `conn.list`:** it isn't authorized to you yet. You may complete the task by any other means available to you (e.g. a CLI, extension, or credential already set up on this machine), or tell the owner they can connect/authorize the app so you can use it through a connection.

**Two execution models, one verb.** `conn.invoke` resolves the connection and routes on its `credential_mode` (recorded in the local index):

- **`direct`** — the common case: the token is cached locally, so `conn.invoke` assembles the request from the app's catalog (`url_template` + your `params`), injects the token, and calls the provider **from your own egress**. Returns `{ status_code, headers, body }`.
- **`proxy`** (e.g. a **Composio** connector, `credential_source:"composio"`) — the connection holds **no** local token, so `conn.invoke` sends the action to the platform, which resolves it, injects the credential, and calls the provider **server-side**. Returns `{ status_code, body }`. You still call the same `conn.invoke {app|connectionId, action, params}` — the routing is automatic and invisible.

Either way you never hold a URL or craft a raw request. Prefer the cache-aware verbs (`conn.invoke` / `conn.catalog`), which resolve the connection and action for you. See "Credential Handling" and "Capability Cache & Call Chain" below for the mechanics.

> The command reference below is app-agnostic: examples use placeholders like `<app>`, `<toolkit-slug>/<action-name>`, and a generic provider URL. Substitute the real values you get from `conn.list` / `conn.catalog` at runtime — never assume a particular provider.

## Commands

### conn.list
List connections available to this agent.

```bash
node src/cli/conn.js conn.list '{}'
```

Self only — cws-core derives the caller's identity from the authenticated
principal, not from any client-supplied parameter (no `agentMemberId` override
exists). Returns array of connections with status, application, owner, scopes.

### conn.check
Read-only availability check for **one** app — use it when the user names an
app, to answer in plain language before invoking.

```bash
node src/cli/conn.js conn.check '{"app":"<slug or name>"}'
```

Returns `{ app, app_name, state, connection_ids }`; `state` is `authorized` (at
least one active connection — `connection_ids` lists the active ones),
`not_authorized` (no connection for this app — send `conn.auth_notice`), or
`needs_reauth` (only expired / revoked / needs-reauth connections — ask the user
to re-authorize). No conversation id is needed: the input-box connector switch
is a preference (see SKILL.md → "Connector preference"), not a gate, so
`conn.list` / `conn.check` / `conn.invoke` work the same inside and outside an
OpenMax conversation (Lark, scheduled tasks, automations). Personal and org
connectors both work in direct messages and group chats. Never surface the
state names to the user.

### conn.auth_notice
After `conn.check` returns `not_authorized`, post the structured **"go
authorize" card** into the conversation. The chat renders it as a card whose
button deep-links to that app's own connect dialog (`/connections?connect=<slug>`).

```bash
node src/cli/conn.js conn.auth_notice '{"conversationId":"<conversation-id from <message-context>>","apps":["notion"]}'
```

`conversationId` is only the place the card is posted (missing / malformed →
`400`, nothing sent). `apps` is a list of app slugs (display names / application
ids also match, exactly and case-insensitively), resolved against the
application catalog to `{name, slug}`: an application id is read exactly
(`GET /connect/applications/{id}`); a slug or name walks the catalog search
with its cursor (`GET /connect/applications?query=…&limit=100&cursor=…`, a
stable keyset order, so connections changing mid-walk can't skip a row) until
an exact match or no `next_cursor`. An app not in the catalog is refused with
`404 unknown_connector` and nothing is posted; if the search runs past 20 pages
it stops with `502 catalog_lookup_incomplete` (nothing posted — pass the
application id instead).
Returns `{ status: "sent", conversation_id, connectors }`. The message is
`AGENT_STRUCTURED` with body schema `prototype.connector-auth-notice.v1`
(`connector_names[]` / `connector_slugs[]`, index-aligned), a metadata copy, and
a plain Chinese `fallback_text` for clients that don't render the card.

### conn.acquire
Acquire the credential for a connection. Returns `access_token`, `token_type`,
`expires_at`, `toolkits[]`. It does **not** write the local credential cache:
`conn.invoke` acquires, caches and injects the token itself, so you normally
never call this (it also puts the token into your context). To make
`conn.invoke` use a fresh credential, run `conn.clear_cache {connectionId}` and
invoke again.

```bash
node src/cli/conn.js conn.acquire '{"connectionId":"2b0e4f41-..."}'
```

The comm-bridge automatically acquires and caches credentials on `connection.authorized` events. Use this command only to inspect what the server returns.

### conn.actions
Discover the named actions available for a connection's provider. Pair with `conn.invoke` to run one by name. Scoped to the agent's authorization on the connection.

```bash
node src/cli/conn.js conn.actions '{"connectionId":"2b0e4f41-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }`. `input_schema` is a JSON Schema (draft-07 style) describing the `conn.invoke` params for that action: the request body fields plus any URL path/query placeholders it declares. Pass params declared `array` / `object` as **native** JSON values — the plugin encodes them per the action definition (e.g. JSON text in the query string); do not hand-build encoded strings. An empty string means the schema is not published / unknown (do NOT assume an empty body), while an explicit empty-object schema (`{"type":"object","properties":{},"additionalProperties":false}`) means the action takes no request body. `params[]` still lists URL path/query placeholders separately (a placeholder may or may not also appear in `input_schema`). To run an action, use `conn.invoke {app, action, params}`.

Optional paging: `{"connectionId":"...", "cursor":"<next_cursor>", "limit":50}` — see "Paging and search" below.

### conn.status
Get connection details: status, owner, application, scopes, expiry.

```bash
node src/cli/conn.js conn.status '{"connectionId":"2b0e4f41-..."}'
```

### conn.app_actions
Discover the **app-keyed action catalog** for an application — every action the app exposes (each with its `input_schema`), **without needing an existing connection**. Unlike `conn.actions` (connection-scoped and gated on the connection-agent authorization boundary), this is capability metadata readable by any org member: use it to see what an app can do before a connection exists, or to build a per-application capability cache shared across that app's connections.

```bash
node src/cli/conn.js conn.app_actions '{"applicationId":"cb4e4f15-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }` (same shape as `conn.actions`). Resolved strictly by `applicationId` — the BFF route keys on the path id and does not accept a slug override, so the requested resource identity always matches the returned catalog.

Optional paging: `{"applicationId":"...", "cursor":"<next_cursor>", "limit":50}` — see "Paging and search" below.

### conn.actions_search
Keyword-search an application's action catalog. **Use this first for a Composio connector** (or any app with many actions): a plain `conn.actions` / `conn.app_actions` / `conn.catalog` call only shows the first page, so the action you need may not be in it.

```bash
node src/cli/conn.js conn.actions_search '{"applicationId":"cb4e4f15-...","query":"report"}'
node src/cli/conn.js conn.actions_search '{"applicationId":"cb4e4f15-...","query":"report","cursor":"<next_cursor>","limit":20}'
```

| Param | Required | Meaning |
|-------|----------|---------|
| `applicationId` | yes | The app to search (from `conn.list` → `application`, or `conn.catalog`'s `applicationId`). |
| `query` | no | Keyword to match (e.g. `"report"`, `"search"`, `"list"`, `"send"`, `"issue"`). Omit to list from the start. |
| `cursor` | no | The `next_cursor` from the previous page, passed back unchanged. |
| `limit` | no | Page size, 1..100 (validated by the server). |

Returns the matching actions (same item shape as `conn.actions`), but as **lightweight** entries: `input_schema` may be empty (`""`), so a search hit does not tell you the required param names or types. Try a few short keywords if the first one finds nothing useful, pick one action, then **describe it** with `conn.action_describe` and only then run it with `conn.invoke {app|connectionId, action, params}`. Calls `GET /connect/applications/{id}/actions:search`.

### conn.action_describe
Get the **full definition of one action** — including its complete `input_schema` (required param names and types). Use it on the action you picked from `conn.actions_search` (or from a paged list whose entry has an empty `input_schema`) **before** `conn.invoke`; never guess params from the action name.

```bash
node src/cli/conn.js conn.action_describe '{"applicationId":"cb4e4f15-...","action":"NOTION_FETCH_DATA"}'
```

| Param | Required | Meaning |
|-------|----------|---------|
| `applicationId` | yes | The app the action belongs to (same id you searched). |
| `action` | yes | The `action` value exactly as returned by `conn.actions_search` / `conn.actions`. |

Returns a single action object `{ toolkit, action, method, description, params[], input_schema, ... }` (same fields as a `conn.actions` item, fully populated). Read `input_schema.required` / `properties` to build `params` for `conn.invoke`. Describe only the action you are about to call — do not describe every search result. Calls `GET /connect/applications/{id}/actions/{action}`.

**Flow for a large (Composio) catalog:** `conn.actions_search {applicationId, query}` → pick one action → `conn.action_describe {applicationId, action}` → `conn.invoke {app|connectionId, action, params}`.

### Paging and search

`conn.actions`, `conn.app_actions` and `conn.actions_search` accept optional `cursor` and `limit`. Only the params you give are sent; with neither, the request is exactly the unpaged call.

- **No more pages:** the result is the plain array of actions, as before.
- **More pages exist:** the result is `{ "actions": [...], "next_cursor": "..." }`. Pass `next_cursor` back unchanged as `cursor` (with the same other params) to get the next page. Stop when a result comes back without `next_cursor`.

Do not build, decode or edit a cursor. Prefer `conn.actions_search` with a keyword over paging through a whole Composio catalog.

### conn.callback
Return the platform's OAuth **callback URL** — the redirect URI to register in your
provider's OAuth app **before** you create a connector. Read-only, no params.

```bash
node src/cli/conn.js conn.callback '{}'
```

Returns `{ callback_url }`. The endpoint is authed (bearer) but **not** org-scoped;
the CLI still authenticates it with the org's token (harmless — the route ignores
the org scoping). It is the redirect URI to register at the OAuth provider. When
you create an OAuth connector **for a user**, the user registers it (shown on the create
card, copyable, where the web client renders it — otherwise give it from here) and then enters the Client ID **and** Client Secret
together on the connections page — you do not pass `oauth_client_id` or
`oauth_client_secret` (see "Creating a custom connector for a user", steps 4 and 6).

## Custom connector management (applications + action-defs)

The verbs above **use** connections an owner already authorized to you. The verbs
in this section **onboard and manage the connector applications themselves** — you
create a custom connector application, then define the HTTP **action definitions**
(the DB-backed action catalog) it exposes. These are org-scoped and ownership-gated
server-side: you can only update/delete an application (and its action-defs) that
belongs to your own org.

Two invariants hold for every verb here (they mirror the rest of `conn.*`):

- **You never supply `org_id`.** cws-core derives the owning org from your
  authenticated principal. (`{org}` still selects *which* enabled org's token to
  use on a multi-org agent — it is not written into any request body.)
- **You never supply `oauth_callback_url`.** cws-core injects the provider-facing
  redirect URI on create/update and returns it read-only on the item — register
  that value at your OAuth provider. (Use **`conn.callback`** to fetch it *before*
  creating the connector so you can register it in the provider's OAuth app first.)

**Creating a new connector for a user needs the owner's confirmation first:** send
`conn.create_card` and wait (see "Creating a custom connector for a user" below).

### conn.app_create
Create a custom connector application.

```bash
node src/cli/conn.js conn.app_create '{"slug":"acme","display_name":"Acme","auth_type":"api_key","api_key_location":"header","api_key_header_name":"X-Api-Key","category":"crm"}'
```

Required: `display_name`, `auth_type` (`api_key` | `oauth2`, exactly as
written — lowercase; anything else, e.g. `OAuth2` / `basic`, is refused locally
with `400`; not sent for `connector_kind: "mcp"`, see below). `auth_type` is the
same word the confirmation card uses; the CLI sends it to the platform as
`provider_type` (the platform's name for it, still accepted as an alias — if you
send both they must be equal). `slug` is
**optional** — cws-core generates one from `display_name` when omitted; pass an
explicit `slug` only when you need a specific value (it is honored as-is). Optional:
`slug`, `description`, `icon_url`, `category`,
`tags[]`, `default_ttl_seconds`, and the auth-shape fields —
API-key: `api_key_location` (`header` | `query`), `api_key_header_name`;
OAuth: `oauth_authorize_url`, `oauth_token_url`, `oauth_client_id` (**leave it
out when creating a connector for a user** — see step 4 of "Creating a custom
connector for a user"), `oauth_scopes_default[]`, `oauth_pkce` (bool),
`oauth_token_auth_method` (`basic` | `post`), `oauth_token_body_format`
(`form` | `json`). Returns the created `application` item (its `source` is a
read-only derived `"custom"`; `oauth_callback_url` is returned for you to register).

`connector_kind` (optional): `http` (default — the per-action HTTP connector) or
`mcp` (an MCP server connector). It is a **separate axis** from `auth_type`:
`auth_type` / `provider_type` is always the **auth model** (`api_key` | `oauth2`)
and is **never** `"mcp"` — the CLI refuses `auth_type: "mcp"` and
`provider_type: "mcp"` (any letter case) locally, pointing to `connector_kind`
(the platform only stores `oauth2` / `api_key` and fails with HTTP 500 on
anything else). For `connector_kind: "mcp"` send **no** `auth_type` (refused):
the platform's `provider_type` is only a **placeholder** there, because the
platform decides the auth per connection when the user connects it (OAuth
discovery upgrades `api_key` → `oauth2`, but never downgrades — so `oauth2` on a
no-auth / static-token server sticks). **Omit it** (the CLI then sends
`provider_type: "api_key"`, as the openmax.com form does).
Also for `mcp`: no OAuth endpoints or scopes — `oauth_authorize_url` /
`oauth_token_url` / `oauth_scopes_default` are refused (they are discovered at
connect time, and a preset value makes every connection fail);
`oauth_client_id` is still accepted (the fallback client for a server without
dynamic client registration); and **no MCP server config** — `server_url` /
`mcp_server` are refused on the definition, because the server URL is entered
per-connection when the user connects it (see "MCP connectors" below).

The API also accepts `oauth_client_secret`, but **you never collect or pass it**:
do not ask for it in chat, do not accept it from a message, and leave it out of
every `conn.app_create` / `conn.app_import` / `conn.app_update` call. The user
fills it in on the connections page (`/connections?edit=<application_id>`, the
「填写 Client Secret」button on the create card). See step 6 of "Creating a custom
connector for a user" below.

### conn.app_list
List the connector applications visible to your org — the public catalog **∪**
your own org's custom connectors. This is **how you enumerate `applicationId`s
without an existing connection** (contrast `conn.list`, which is
connection-scoped and only returns apps you already have a connection to).

```bash
node src/cli/conn.js conn.app_list '{}'
```

Optional `category` filters the result (e.g. `{"category":"crm"}`). The owning
org is derived **server-side** from your authenticated principal — you never pass
`org_id` (and `{org}` only selects which enabled org's token to use on a
multi-org agent). Returns an **array** of application items, each with
`applicationId` / `id`, `slug`, `display_name`, `provider_type`, `source`,
`visibility`, `credential_source`, `credential_mode`, `category`, the auth-shape
fields (`oauth_*` / `api_key_*`), `is_enabled`, `oauth_callback_url`,
`created_at`, … (same item shape `conn.app_create` / `conn.app_update` return).

### conn.app_update
Update your own custom connector application (ownership-gated).

```bash
node src/cli/conn.js conn.app_update '{"applicationId":"cb4e4f15-...","display_name":"Acme CRM","category":"sales","is_enabled":false}'
```

`applicationId` (UUID) required plus at least one updatable field. `slug` and
`provider_type` are **immutable** and not accepted; the same custom fields as
create are updatable, plus `is_enabled`. This includes the OAuth set —
`oauth_client_id`, `oauth_scopes_default[]`, `oauth_authorize_url`,
`oauth_token_url`, `oauth_pkce`, `oauth_token_auth_method`,
`oauth_token_body_format` (and, as an API capability only, `oauth_client_secret`
— which you never send: the user sets or rotates it on
`/connections?edit=<application_id>`).

Two write semantics to know:

- **`oauth_client_secret` is write-only "blank = keep".** A **blank** (empty or
  whitespace-only) secret is **dropped** — it never overwrites/clears the stored
  one, so updating other fields (always without the secret) never clears it. (An
  update whose *only* field is a blank secret is rejected as "no updatable
  fields".) The CLI still forwards a non-empty value for the UI-equivalent API
  path, but **you never send one**: a secret reaching you through chat is exposed
  — do not use it; tell the user to rotate it and enter the new one on
  `/connections?edit=<application_id>`.
- **`oauth_scopes_default` clears on explicit empty.** An explicit empty array
  (`[]`) is forwarded and **clears** the default scopes (asymmetric with the
  secret above). Omit the field to leave scopes unchanged.

### conn.actiondef_list
List an application's HTTP **action definitions** (the DB-backed action catalog you
publish for agents). Distinct from `conn.app_actions` / `conn.actions`, which return
the *resolved capability catalog* agents execute.

```bash
node src/cli/conn.js conn.actiondef_list '{"applicationId":"cb4e4f15-..."}'
```

Returns an array of `{ id, application_id, name, method, url_template, headers?,
encoding, input_schema, created_at?, updated_at? }`.

### conn.actiondef_create
Create one HTTP action definition on an application (ownership-gated).

```bash
node src/cli/conn.js conn.actiondef_create '{"applicationId":"cb4e4f15-...","name":"list_repos","description":"List the authenticated user's repositories","method":"GET","url_template":"{base_url}/user/repos","encoding":"","input_schema":"{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}"}'
```

Required: `applicationId` (UUID), `name`, `method`, `url_template`, **`description`
(non-empty)**. Optional: `headers` (map), `encoding`, `input_schema`. See
**Action-def schema semantics** below for the field rules. `description` is
rejected locally with `{status:400}` when missing or empty — before any network
call (and, in `conn.app_import`, recorded as that action's per-action failure).

### conn.actiondef_update
Partial-update one action definition (ownership-gated; parent-scoped by
`applicationId`).

```bash
node src/cli/conn.js conn.actiondef_update '{"applicationId":"cb4e4f15-...","actionId":"7d2a...","method":"POST","url_template":"{base_url}/user/repos"}'
```

`applicationId` + `actionId` (both UUID) required, plus at least one of `method`,
`url_template`, `encoding`, `input_schema`, `headers`. Note the server rule for
`headers`: a **non-empty** map replaces the stored headers; an empty map leaves
them unchanged.

### conn.actiondef_delete
Delete one action definition (ownership-gated).

```bash
node src/cli/conn.js conn.actiondef_delete '{"applicationId":"cb4e4f15-...","actionId":"7d2a..."}'
```

### conn.app_import
Bulk-onboard a custom connector from an import JSON: create the application, then
loop-create each action-def, reporting **per-action** success/failure so a partial
import is visible (mirrors the cws-fe "actions JSON import" flow).

```bash
node src/cli/conn.js conn.app_import '{"application":{"slug":"acme","display_name":"Acme","auth_type":"api_key","api_key_location":"header","api_key_header_name":"X-Api-Key"},"actions":[{"name":"list_repos","description":"List repositories","method":"GET","url_template":"{base_url}/user/repos"},{"name":"get_repo","description":"Get one repository","method":"GET","url_template":"{base_url}/repos/{id}"}]}'
```

`application` (same fields as `conn.app_create`) is validated **before** any network
call; an invalid app body fails fast without creating anything. For
`connector_kind: "mcp"` send **no** `actions` (omit or `[]`): an MCP connector's
tools come from the MCP server, so any action is refused (`400`) before anything
is created. Returns
`{ application, applicationId, actions_total, actions_created, actions_failed,
results[] }` where each `results[i]` is `{ index, name, ok, id? , error?, status? }`.
Action-def failures do **not** abort the remaining actions — the app and its
succeeding action-defs stand, and you fix/retry the failed ones with
`conn.actiondef_create`.

### Adding actions to a custom connector — two paths

When a user wants actions added to a custom connector, you (the Agent) have **two
ways** — pick by what the user wants:

**A) Import them yourself via the CLI.** If the user just wants it done, call the CLI
from your own egress:
- **New connector + its actions in one shot** — `conn.app_import` with
  `{"application":{…},"actions":[…]}` (creates the app, then loop-creates each action;
  per-action partial-failure is reported in `results[]`).
- **Add actions to an *existing* connector** — `conn.actiondef_create`, one call per
  action (`applicationId` + the action fields).

**B) Hand the user a JSON block to self-import.** If the user wants to paste it into the
UI themselves (cws-fe「添加动作」/「动作 JSON 导入」box), give them a **directly-importable**
object — a single top-level `actions` array, one entry per action. The shape must be
exactly right:
- **Do** emit `{"actions":[ {…}, {…} ]}` — an object with one `actions` array.
- **Do NOT** wrap it in `application` — the `{"application":{…},"actions":[…]}` shape is
  only for the CLI `conn.app_import` (path A), which *also creates the connector*.
- **Do NOT** emit a bare array (`[ {…} ]`) — it must be the `{"actions":[…]}` object.

```json
{"actions":[
  {"name":"list_repos","description":"List the user's repositories","method":"GET","url_template":"{base_url}/user/repos"},
  {"name":"get_repo","description":"Get one repository","method":"GET","url_template":"{base_url}/repos/{id}","input_schema":"{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}"}
]}
```

Either path uses the same per-action fields — required `name` / `method` /
`url_template` / `description`; optional `headers` / `encoding` / `input_schema` — per
**Action-def schema semantics** below (`Authorization` header forbidden; `input_schema`
is a draft-07 JSON Schema **string**). Fill `description` for every action (required,
non-empty). Each action `name` is just the action segment (e.g. `list_repos`) — the
server prepends the connector slug to form the stored `{slug}/{name}`, so submit the bare
action name, not `slug/name`.

### Starting from just an address (the user names a system, nothing else)

Often the request is only "connect `crm.acme.com`" (the connections page's
「问 Agent」 sends exactly that: the system address, maybe a purpose). Work out
the rest yourself before sending a card:

1. **Research it yourself.** Open the official site and look for its developer /
   API documentation (developer portal, "API", "Docs", an OpenAPI file, an MCP
   server page). Do not ask the user for things the docs answer.
2. **Decide the shape from the docs:**
   - `connector_kind`: `mcp` when the vendor publishes an MCP server (use its
     https server address); otherwise `http`.
   - for `http`, `auth_type`: `oauth2` when the API uses an OAuth authorization
     code flow (take the authorize URL, token URL and default scopes from the
     docs — they go on the card, see step 1 below); `api_key` when it uses a
     static key / token in a header or query.
   - `base_url` and the actions, each from a documented endpoint (method → read /
     write as below).
3. **Ask only for what you cannot determine** — one specific question (e.g. the
   tenant-specific API host, or which of two documented auth methods their
   account uses), not a questionnaire, and never for a key, token or secret.
4. **No public API found → say so plainly** ("I could not find a public API for
   X"), and ask the user for the API documentation link (or whether their
   vendor provides one). **Never invent endpoints or actions**, and never guess
   an auth type to fill the card.
5. Then follow "Creating a custom connector for a user" below (card first).

### Creating a custom connector for a user — confirmation card first (`conn.create_card`)

Before you create a **new** custom connector for a user (`conn.app_import`, or
`conn.app_create` followed by `conn.actiondef_create`), the owner confirms it on a
card. Never create first and ask afterwards.

**1. Prepare the spec.** Connector `name` (display name), an explicit `slug`, the
`connector_kind` (`http` | `mcp`) and, for `http` only, the `auth_type`
(`api_key` | `oauth2`), optional `icon_url` / `description` / `base_url`, for
`oauth2` also the OAuth details from the provider's docs so the owner sees them
on the card — `oauth_authorize_url`, `oauth_token_url` and `oauth_scopes_default`
(array of scope strings; the same values you will pass to `conn.app_import`, but
**not** `oauth_client_id`, see step 4) — and the
actions you will import (for `connector_kind: "mcp"` see "MCP connectors" below
instead — no `auth_type`, a required `server_url`, no `base_url`, no actions): for each one its bare `name` (the
action segment, e.g. `list_contacts`, no `slug/`), whether it **reads** or
**writes** (`effect`), and a one-line `summary` the user can understand. Also
draft the full action-defs (method, url_template, description, input_schema) you
will pass to `conn.app_import` — the card shows only name / effect / summary.
Choose the slug yourself and keep it: lowercase letters `a-z` and digits, with
single `-` or `_` separators allowed inside (not first or last), at most 64
characters — exactly what `conn.create_card` validates:
`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`. Prefer `-` like the server's own
generated slugs (e.g. `acme-crm`, or `acme-crm-k3wujp` to avoid a clash). The same
slug goes to `conn.app_import`, because the card finds the created app by it.

**Action rules (state them on the card truthfully):**
- **`effect` follows the HTTP method:** `GET` (and `HEAD`) = `read`; `POST`,
  `PUT`, `PATCH`, `DELETE` = `write`. Never label a write as a read to make the
  card look safer — even a `POST` that only searches is shown as `write`.
- **Every action's `url_template` stays on the card's service.** When the card has
  a `base_url`, each `url_template` starts with `{base_url}` (or an absolute URL
  on the same host as `base_url`). An action pointing at another host is not what
  the owner confirmed: put it on the card (its own `base_url` / connector) or drop
  it.
- The actions you import are exactly the actions on the card (same names, same
  read/write); anything else needs a new card.

**2. Send the card (creates nothing).**

```bash
node src/cli/conn.js conn.create_card '{"conversationId":"<conversation-id from <message-context>>","connector":{"name":"Acme CRM","slug":"acme-crm","connector_kind":"http","auth_type":"oauth2","description":"Acme 客户管理","base_url":"https://api.acme.example.com/v1","oauth_authorize_url":"https://acme.example.com/oauth/authorize","oauth_token_url":"https://acme.example.com/oauth/token","oauth_scopes_default":["contacts.read","contacts.write"]},"actions":[{"name":"list_contacts","effect":"read","summary":"列出联系人"},{"name":"create_contact","effect":"write","summary":"新建联系人"}]}'
```

Optional `application_id` (UUID) when the application already exists. Strict
validation, all before anything is sent (`400`): required `name` (≤100) / `slug`
(`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`) / `connector_kind` (`http` | `mcp`);
for `http` a required `auth_type` (`api_key` | `oauth2`); for `mcp` **no**
`auth_type`, a required `server_url` (alias `mcp_server_url`, **https** only,
same URL checks as below), no `base_url`, and no actions (omit `actions` or send
`[]`); `auth_type: "mcp"` is refused (MCP is a `connector_kind`, not an auth
type); `server_url` on an `http` card is refused; `oauth_authorize_url` /
`oauth_token_url` / `oauth_scopes_default` (all optional) only on an `http` +
`oauth2` card (on `api_key` or `mcp` → `400`), the two URLs under the same URL
checks as `base_url`, `oauth_scopes_default` an array of at most 50 non-empty
strings (each ≤200, no invisible characters; `[]` = omitted); `icon_url`,
`base_url`, `oauth_authorize_url` and `oauth_token_url` absolute http(s) URLs (≤2048) with no `user:pass@`, no `#fragment` and
no secret-named query / fragment parameter (`?api_key=…`, `?x=1;sig=…` — `;`
counts as a separator too — `?X-Amz-Signature=…`, `?id_token=…`, `#token=…` →
`400 secret_field_rejected`, naming the parameter, never its value); a path
segment (percent-decoded) or query value in a well-known token format is
refused the same way — `sk-…` / `sk_live_…` / `rk_test_…`, `ghp_…` and the other
GitHub prefixes, `github_pat_…`, `glpat-…`, `xoxb-…` (Slack), a JWT (`eyJ….…`),
an AWS key id (`AKIA…` / `ASIA…`), each only with a realistic body length, so
`?hl=sk-SK`, `/sk_SK/` or `xoxo-gossip` pass. There is deliberately no generic
"long random string" rule (it would block Google Drive / Notion ids), so this is
a best-effort check, not a guarantee. URLs are echoed in normalized form (the
parsed `href`, so the card shows the real host). No control, invisible
formatting, default-ignorable or line-separator characters (Unicode Cc / Cf such
as U+202E, U+200B, U+FEFF, tag characters; Hangul fillers U+115F / U+1160 /
U+3164 / U+FFA0; variation selectors U+FE00–FE0F, U+180B–180F, U+E0100–E01EF;
U+2028 / U+2029) in any field, with narrow exceptions for emoji and scripts in
`connector.name`, `connector.description` and `actions[].summary`: VS16 (U+FE0F)
right after an emoji (❤️, 1️⃣); a ZWJ only between two emoji (👨‍👩‍👧, 🏳️‍🌈); tag
characters only in a subdivision flag — 🏴, then 3–6 digit / lowercase-letter
tags, then U+E007F (🏴󠁧󠁢󠁳󠁣󠁴󠁿); and, in `connector.description` only, a ZWNJ after
a letter or combining mark and before a letter (Hindi, Persian, Arabic). `slug`,
`actions[].name` and URLs allow none of them. Action names are compared for
duplicates after NFKC (folds full-width and other compatibility forms:
`ＬＩＳＴ` = `list`), removal of default-ignorables, and lower-casing;
`description` ≤500; 1–50 actions, each `name` ≤100 without `/` and unique,
`effect` `read` | `write`, `summary` ≤200; unknown fields refused. **Any
secret-like key anywhere in the input** (`api_key`, `secret`, `client_secret`,
`oauth_client_secret`, `token`, `password`, `private_key`, `authorization`, …, at
any depth) is refused with `400 secret_field_rejected` and nothing is sent. The
input is checked for secret-like fields on a best-effort basis — it cannot catch
every secret, so never put credentials in any field or URL yourself.
Known limitations (accepted): secret / token detection is best-effort, and
look-alike letters from different scripts (Cyrillic `а` vs Latin `a`) are not
detected, so two action names can still look alike on the card — keep names
plain ASCII.
Returns `{ status: "sent", conversation_id, card_id, message_id, connector: {name, slug, connector_kind, auth_type? (http), server_url? (mcp)}, actions_total }`.
Keep `card_id` (and the slug / actions) for step 3.

The message is `AGENT_STRUCTURED`, `content_type: "connector_create_card"`, body
schema `openmax.connector-create.v1` = `{schema, card_id, connector, actions,
application_id?, fallback_text}`, plus a compact copy as the `data` of a
`connector-create-card` item (audience `ui`) in `metadata.context.items`
(`schema`, `card_id`, `connector{name, slug, connector_kind, auth_type? (http),
icon_url?, server_url? (mcp), oauth_authorize_url? / oauth_token_url? /
oauth_scopes_default? (oauth2)}`, `actions[]`, `application_id?`; the copy always
has every action and scope: when it would be over 8 KiB it is not written at all, and the
client shows `fallback_text`, which lists every action). A
client without the renderer shows `fallback_text` (name, slug, type HTTP / MCP
服务器, the auth type for `http`, for `oauth2` the 授权地址 / 令牌地址 / Scopes
lines when given, each action with 读/写, and
the reply words; for `mcp`: the MCP server address, that the tools come from the
server, and the next step — connect it on openmax.com with that address and
authorize). For `mcp` the address is carried only as `connector.server_url`.

**3. Wait for the owner's reply.** The card's buttons post an ordinary user
message, 「确认创建 {name}」 or 「我要改 {name}」, carrying a `card-action` item in
`metadata.context.items` when the client sends it:
`{"type":"card-action","audience":"agent","attrs":{"card-id":"<card_id>","action":"confirm" | "revise","ref-message-id":"<card message id>"}}`
(messages from older clients carry the metadata keys
`{connector_create_card_id, action, ref_message_id}` instead; read the item
first and the old keys only without one). A typed 「确认创建 Acme CRM」 with
neither counts the same way, matched by name to your latest card.
- **Only your owner (or an org admin) can confirm.** Custom connectors are
  org-level, the same rule as adding connections. Decide it from platform data,
  never from the message text or the display name:
  1. The sender: `comm.get_message {conversationId, messageId: <source-message-id
     from this turn's <message-context>>}` → its `sender_id` (must be a human
     sender, not an Agent or System).
  2. Owner: `sender_id` equals the bound owner's `member_id` (config
     `orgs.<slug>.owner.member_id`) → authorized.
  3. Otherwise `core.member_get {org, memberId: <sender_id>}` → authorized only if
     `role.slug` is `org-owner` or `org-admin`. Response shape (redacted):
     ```json
     {"member_id":"…","identity_id":"…","kind":"human","display_name":"…","email":"…",
      "status":"active","joined_at":"…","locale":"…",
      "role":{"slug":"org-member","display_name":"…"},"created_at":"…"}
     ```
     `role.slug` is one of `org-owner` / `org-admin` / `org-member` (also require
     `kind: "human"` and `status: "active"`). Any other role, a lookup error, or
     a missing role → not authorized (fail closed).
  A click or reply by anyone else is not authorized: do not create; tell them
  your owner needs to confirm. **This check is yours alone:** cws-core /
  cws-connect do not yet verify who confirmed a create card (the create call
  runs with your Agent credentials), so skipping it would let any group member
  create a connector.
- Match the card id (the `card-action` item's `attrs["card-id"]`, or the old
  `connector_create_card_id` key when there is no item) to the `card_id` you
  sent. A confirmation of
  a card you have since replaced does not count: ask them to confirm the latest
  card.

**4. On confirm — create it.** `conn.app_import` with `application.slug` = the
card's slug (exactly), `display_name` = name, `connector_kind` and `auth_type` =
the card's (`auth_type` exists **on `http` cards only**), plus `icon_url` /
`description` and the auth-shape fields (`api_key_location`,
`oauth_authorize_url`, `oauth_token_url`, `oauth_scopes_default`, … — the OAuth
values as shown on the card), and `actions` = the full
action-defs for exactly the actions on the card. Never add `oauth_client_secret`,
and for an `oauth2` connector **do not set `oauth_client_id`** either, even if you
know it: the user enters the Client ID and Client Secret together on the
connections page, and the page shows the connector as "pending configuration"
only while it has no Client ID — a Client ID without a Secret would show
「去连接」 and the authorization would then fail.
An `mcp` card has no `auth_type` and is never `auth_type` / `provider_type`
`"mcp"` (refused): create it as described in "MCP connectors" below. Report the result in plain words; if some actions failed (`actions_failed > 0`), name them and offer
to retry those with `conn.actiondef_create`. Do not send another card for a retry
of the same spec.

**5. On revise — new card.** Discuss what to change, then send a new
`conn.create_card` (new `card_id`). The old card stays in the chat; say the new
one replaces it (「以新卡为准」).

**6. OAuth Client Secret — never in chat.** For `auth_type: "oauth2"` never ask
for, accept or forward the Client Secret, and never pass `oauth_client_secret` to
`conn.app_import` / `conn.app_update`. Tell the user to click 「填写 Client
Secret」 on the card: it opens `/connections?edit=<application_id>`, where they
fill in the Client ID and Client Secret together. If the card was
sent before the application existed (no `application_id`), the page finds the
created app by slug after creation — which is why the slug on the card must equal
the created slug. Newer web clients show the callback URL to register in the provider's OAuth
app on the card (with a copy button). When the card does not show it (older web
client, or the card does not render), or the user asks, fetch it with
`conn.callback` (or read the created app's `oauth_callback_url`) and give it to
them.

**7. A secret pasted into chat anyway.** Do not use it, do not repeat it, and do not
pass it to any command. Tell the user it is now exposed in the conversation and
ask them to revoke / rotate it, then enter the new value on the connections page.

Outside an OpenMax conversation (no card renders), describe the same spec in plain
text and create only after your owner's explicit 「确认创建」.

#### MCP connectors (`connector_kind: "mcp"`) — two steps

An MCP connector is a **connector kind**, not an auth type: the platform stores
`connector_kind: "mcp"` next to a placeholder `provider_type` (the auth model). The
MCP server address is **not** part of the connector definition; it is entered
per-connection when the user connects it, where the platform checks the server
and runs its OAuth sign-in when needed. So creation has two steps:

**(a) You create the connector definition — after the owner confirms.** Send the
card with the server address and no actions:

```bash
node src/cli/conn.js conn.create_card '{"conversationId":"<conversation-id from <message-context>>","connector":{"name":"Plaud","slug":"plaud-mcp","connector_kind":"mcp","description":"Plaud 录音与转写","server_url":"https://<the MCP server address>"}}'
```

On the owner's confirmation (same check as step 3):

```bash
node src/cli/conn.js conn.app_import '{"application":{"slug":"plaud-mcp","display_name":"Plaud","description":"Plaud 录音与转写","connector_kind":"mcp"}}'
```

- `connector_kind: "mcp"`; **no `auth_type`** (refused) and **omit
  `provider_type`** (the CLI sends `api_key`). For MCP it is only a
  placeholder — the platform decides the auth when the user connects (OAuth
  discovery upgrades `api_key` → `oauth2`, never the reverse, so an `oauth2` you
  pick for a no-auth / static-token server sticks). Never `auth_type: "mcp"` /
  `provider_type: "mcp"`.
- No `actions` (refused), no `server_url` / `mcp_server` on the application
  (refused), no `oauth_authorize_url` / `oauth_token_url` / `oauth_scopes_default`
  (refused — discovered at connect time; a preset value makes every connection
  fail), no client secret. `oauth_client_id` is accepted, only for a server
  without dynamic client registration.

**(b) The user connects it on openmax.com.** Creation cannot pre-fill the
server address, so tell the user exactly what to do and give them the **exact
URL to paste** (the one on the card), e.g.: 「连接器已创建。请打开 openmax.com 的
「应用连接」页面，找到「Plaud」→ 新建连接，传输类型选「远程（Streamable HTTP）」，
在「服务器 URL」里粘贴 `https://<the MCP server address>`，然后按提示完成授权。」
That connection carries `mcp_server.server_url` with transport `remote_http`;
for an OAuth server the page then sends the user to the provider to authorize.

If the platform refuses any of this (the create call fails, or the connections
page does not offer the MCP address field for this connector), tell the user
plainly what failed and that this connector cannot be added this way yet —
never switch to another connector kind or auth type silently.

### Action-def schema semantics

One action-def row = one HTTP action published for agents to execute.

- **`name`** — the **action-only** name, e.g. `"list_repos"` (non-empty). Submit just the
  action segment — the server prepends the connector slug and stores it as
  `"{connector-slug}/{name}"`, which is what appears in the catalog and what agents pass
  to `conn.invoke`. (So don't write the slug prefix into the name yourself.)
- **`description`** — **required, non-empty** on create/import. A short
  human-readable summary of what the action does; it surfaces to agents in the
  resolved catalog (`conn.actions` / `conn.app_actions`) to help them pick the right
  action. The CLI rejects a missing/blank `description` locally (`{status:400}`)
  before any network call. (On `conn.actiondef_update` it is an *optional* editable
  field.)
- **`method`** — one of `GET` | `POST` | `PUT` | `PATCH` | `DELETE`.
- **`url_template`** — absolute, or `{base_url}`-prefixed. `{placeholder}` slots are
  filled from params (path/query); an **unfilled query placeholder is dropped**.
- **`encoding`** — `""` (empty) = JSON body · `form` = urlencoded · `none` = no body.
  Direct mode honours it too (a `form` action is sent
  `application/x-www-form-urlencoded`, nested objects as `a[b]=c`; `none` sends no
  body even for POST). A `DELETE` sends a body only when `input_schema` declares
  at least one non-placeholder property.
- **`request_spec`** — optional JSON object describing a templated body, file
  parameters, upload encodings or a batch (cws-connect `request_spec/v1`; see
  "Actions with a `request_spec`" below). Validated by cws-connect on write and by
  the plugin before execution; it may not hard-code file references. When set,
  `encoding` must be empty.
- **`input_schema`** — a JSON Schema **draft-07** string describing the action's
  params. `{"type":"object","properties":{},"additionalProperties":false}` means the
  action takes no request body. A **query** placeholder may be declared here too;
  if its value is an array/object and the provider expects JSON text in the query,
  add `"x-query-style":"json"` to that property (direct mode JSON-encodes it;
  without it the value is `String(v)`, e.g. `a,b`). The keyword is ignored for
  path/header placeholders and body fields.
- **`headers`** — static or templated headers. **The `Authorization` header is
  forbidden.** Provider auth comes from the *connection* (the credential is injected
  from the connection at call time), **not** from action headers — a stored
  `Authorization` would override the per-connection auth, so it must never be
  authored. The CLI **rejects it locally, case-insensitively** (`Authorization` /
  `authorization` / `AUTHORIZATION`): `conn.actiondef_create` / `conn.actiondef_update`
  fail with `{status:400, error:"headers.Authorization is forbidden — the connection
  credential is injected at call time"}`, and `conn.app_import` records the offending
  action as a per-action failure (that row is never created). Do not put credentials
  in `headers`.

### conn.cached
List locally cached credentials (from WS event auto-acquire).

```bash
node src/cli/conn.js conn.cached '{}'
```

Returns `{ count, credentials: [{ connection_id, provider, has_access_token }] }`.

### conn.clear_cache
Clear cached credentials. Without `connectionId`, clears all.

```bash
node src/cli/conn.js conn.clear_cache '{"connectionId":"2b0e4f41-..."}'
node src/cli/conn.js conn.clear_cache '{}'
```

## Credential Handling

`conn.invoke {app, action, params}` auto-routes by the connection's
`credential_mode` — you always call the same verb; the credential handling differs:

- **`direct`** — `conn.invoke` acquires the connection's real `access_token`, caches
  it locally (`connect/credentials/<id>.json`, `0600`), assembles the request from
  the catalog's `url_template` + params, injects the token, and calls the provider
  **from this host's egress**. The token is refreshed proactively when its
  `expires_at` is near/expired and reactively once on a provider 401; a missing
  local cache is re-acquired before the call.
- **`proxy`** (e.g. a **Composio** connector, `credential_source:"composio"`) — the
  connection holds **no** local token and its `acquire` is rejected server-side, so
  `conn.invoke` does **not** touch the credential cache or the local catalog. It
  POSTs the action to `POST /connect/connections/{id}/actions/execute`, and the
  platform resolves the action, injects the credential, and calls the provider
  **server-side**, returning `{ status_code, body }`.

Request assembly is **code-driven from the catalog** — the action name must resolve
in the local catalog and the URL can only be that action's `url_template` expanded
with schema-checked params. A free-form provider URL is never accepted from the
caller.

### Connections that require request signing

Some direct connectors (e.g. TikTok Shop) need every request signed with an app
secret that stays on the platform. You call `conn.invoke` exactly as usual; the
plugin has each request signed by the platform before sending it (one extra
round trip). Nothing changes in the params you pass. Errors to act on (in all of
them except `signed_request_redirected` nothing was sent; the CLI error carries
`code`, `status` and, where the plugin knows nothing reached the provider,
`sent: false`):

| `code` | status | What to do |
|---|---|---|
| `CONNECT_SHOP_NOT_AUTHORIZED` | 400 | The `shop_cipher` you passed is not a shop of this connection. Call the connector's `get_authorized_shops` action and pass one of its `cipher` values (a connection with several shops needs `shop_cipher` on shop actions; with one shop it is filled in for you). If the shop is missing, the user must re-authorize. |
| `CONNECT_REQUEST_NOT_IN_CATALOG` | 400 | The request did not match the action (method, host, path, query params). Refresh the catalog (`conn.catalog {refresh:true}`), check the action with `conn.action_describe`, pass only declared params (no `_query` extras). |
| `CONNECT_BODY_TOO_LARGE` | 400 | The body is over the signing limit; send less per call. |
| `CONNECT_CLIENT_UPGRADE_REQUIRED` | 426 | The plugin is too old for this connection — the plugin must be upgraded. |
| `CONNECT_SIGNING_NOT_ENABLED` | 422 | The local credential disagrees with the server: `conn.clear_cache` for that connection and retry once; report if it persists. |
| `request_signing_unsupported_path` | 422 | `_download`, `request_spec` actions and the Meta page-token exchange are not supported on these connections yet. |
| `request_signing_unsupported_auth` | 422 | The connection places its credential in the URL query, which cannot be combined with signing. Report it; do not retry. |
| `request_signing_unsupported` | 501 | The server does not support signing yet (usually the platform is not upgraded yet). Tell the user; do not retry. |
| `request_signing_expired` | 502 | The server returned an already-expired signature twice. This host's clock may be wrong; report it. |
| `request_signing_invalid_response` | 502 | The server's signing answer was malformed. Report it; do not retry in a loop. |
| `signed_request_redirected` | 502 | The request **was delivered** and the provider answered with a redirect (not followed for signed requests). Do **not** retry a write action — it may already have taken effect; check its result first. Report it. |

**Provider "token expired" inside a 2xx** (e.g. TikTok Shop `code: 105002` in
an HTTP 200 body): the plugin does not re-acquire on these. Run
`conn.clear_cache {"connectionId":"<id>"}` and retry the same `conn.invoke`
once — the invoke then fetches and caches a fresh credential. Do **not** use
`conn.acquire` for this: it does not update the cache (the retry would reuse
the old token) and it puts the token into your context. Report if it fails
again.

Signed URLs, signatures and request bodies never appear in the logs (only
method, host, path and the provider's status code).

## Capability Cache & Call Chain (runtime/connect/)

All connect-side local state lives under one subtree, split by its natural key:

```
runtime/connect/
├── connections-index.<orgId>.json   # connection → application, per org
├── action-catalog/<applicationId>.json   # application → capability
├── action-schema/<applicationId>__<action>.json   # ONE proxy action's input_schema (file params), 6h TTL; failed describe 5 min
└── credentials/<connectionId>.json  # real access_token, 0600
```

The connections index is **per-org** (`connections-index.<orgId>.json`): the
comm-bridge runs a WS per enabled org and a connection belongs to one org, so a
multi-org agent connected to the same app in two orgs must not resolve the wrong
org's connection. The `conn.*` capability verbs take an optional `{org}` (default:
the single/default enabled org) and run the lookup **and** the execute call
against that org's index, JWT, and member. The action catalog stays global
(keyed by applicationId) since an app's capabilities are the same across orgs.

- **connections-index** and **action-catalog** are the *discovery* layer. The
  index resolves an application → its `connectionId` + `status` (the agent's entry
  point is an app, not a connection); the catalog caches the per-application action
  metadata (`input_schema` etc.).
- **credentials/** caches the connection's real `access_token` (files are `0600`),
  which `conn.invoke` injects into the request at call time.

### Recommended agent flow (identify → call)

Any bot with this skill gets the flow for free by calling the cache-aware verbs —
it does not need to "know" the sequence:

1. **`conn.invoke {app, action, params}`** — resolves the connection for `app`
   from `connections-index.json` (refreshing from `conn.list` on a miss), then
   routes on its `credential_mode`:
   - **`direct`** — assemble the request from the local catalog's `url_template`
     and call the provider from this host, injecting the locally-cached token
     (refreshed on near-expiry / 401). On an action/schema-shaped error it
     invalidates the cached catalog once so the next `conn.catalog` refetches.
   - **`proxy` / composio** — POST the action to the platform's server-side
     execute endpoint (`POST /connect/connections/{id}/actions/execute`); no local
     token or catalog is touched. Returns the server passthrough `{ status_code,
     body }`. A local file path in a `file_uploadable` param is uploaded first —
     see "File parameters on proxy (Composio) actions" below. A legacy index entry with no recorded `credential_mode` triggers one
     `conn.list` refresh (which now returns it) before routing.
2. **`conn.catalog {app|applicationId}`** — returns the cached action catalog for
   discovery, filling from `conn.app_actions` on a miss / TTL-expiry (24h) /
   `{refresh:true}`. Read this to pick an `action` + build `params` from its
   `input_schema` before calling `conn.invoke`. It holds only the first page of
   a large catalog — for a Composio app whose action you cannot find there, use
   `conn.actions_search {applicationId, query}`, then `conn.action_describe
   {applicationId, action}` on the chosen action for its full `input_schema`.
3. **`conn.index {refresh?}`** — inspect the local index (observability).

Invalidation is **TTL + error-triggered** — the app-actions response carries no
version/etag today (see "cws-connect follow-up" below), so there is no
change-detected refresh yet.

> **catalog note:** the catalog carries a per-action `url_template` (and an
> optional `headers_template`, Authorization excluded). `conn.invoke` uses these
> to assemble the real request locally — the mapping comes from the catalog, never
> from a caller-supplied URL. If a cached catalog predates `url_template`,
> `conn.invoke` returns a clear error — run `conn.catalog {refresh:true}`.

### Actions with a `request_spec` (compose / upload / batch)

Some actions carry a `request_spec` in the catalog: a data description of how
the request body is built. The plugin executes it locally (direct connections
only) — you still only call `conn.invoke {app, action, params}` with flat
params from the action's `input_schema`. Typical names end in `-compose-…`
(e-mail built from flat fields), `-upload` / `-upload-resumable` (file
contents), or `-batch` (several calls in one request). The plain actions they
complement (e.g. a raw-MIME `…/messages-send`) keep working unchanged.

- **Compose** (e.g. `gmail/messages-compose-send`, `gmail/drafts-compose-create`,
  `gmail/drafts-compose-update`, `gmail/threads-compose-reply`,
  `gmail/messages-compose-forward`): pass `to` / `cc` / `bcc` (string or
  array, `"Name <a@b>"` allowed), `subject`, `text` and/or `html`, optional
  `attachments`. You never build MIME or base64 yourself. Reply takes the
  `message_id` being answered (recipient defaults to its Reply-To, else From;
  there is no reply-all — pass `cc` explicitly); forward takes `message_id` +
  `to` and attaches the original as `forwarded.eml`.
- **File parameters** (attachments, upload `file`): each value is one of
  - `{"source":"path","path":"~/zylos/components/openmax/upload/report.pdf"}` —
    local files only from the openmax component's own `media/` or `upload/`
    directory. Copy any other file into `~/zylos/components/openmax/upload/`
    first; paths elsewhere (including `~/zylos/workspace`), dot-files, keys,
    `.env*`, the component `runtime/` and `config.json` are refused.
  - `{"source":"artifact","artifact":"artifact://<id>"}` (or just the string
    `"artifact://<id>"`)
  - `{"source":"base64","data":"…","filename":"a.png"}`
  - `{"source":"text","text":"# Title\nbody","filename":"note.md","mime_type":"text/markdown"}`

  Optional `filename` / `mime_type` on any of them. URLs (`https://…`) are not
  accepted — download into the upload directory or upload as an artifact
  first. Limits: 25 MB per file and per request (resumable uploads: 1 GB per
  file); a multiple-file param takes an array.
- **Batch** (e.g. `calendar/events-batch`): `{"requests":[{"action":
  "calendar/events-insert","params":{…}}, …]}` — only the actions the spec
  allows, at most `max_items`. The result is `{status_code, body:{results:[{index,
  action, status_code, headers, body}]}}`; check each item, partial failure is
  normal. An outer 5xx is returned as-is and never retried (some items may have
  run).
- Params the action does not use are refused (400) instead of being silently
  dropped; `_query` keeps working; `_download` is refused on these actions.
- A failing read-before-write step (e.g. reply/forward reading the original)
  returns that response with `failed_step: "prefetch:<name>"`.
- **Upgrade error (426)**: `action requires plugin capabilities [x]; upgrade
  the openmax plugin` — the catalog has an action this plugin build cannot run
  (normally hidden by the server; seen only with a stale cache). Upgrade the
  plugin, or `conn.catalog {refresh:true}`.
- **Capability header**: every catalog request (`conn.catalog`, `conn.actions`,
  `conn.app_actions`, `conn.actions_search`, `conn.action_describe`, and the
  catalog warm-up after authorize) sends `X-Connect-Client-Capabilities:
  request_spec.v1, body_template, prefetch, file_source, file_upload,
  resumable_upload, batch`. The server hides actions whose `request_spec.requires`
  this list does not cover. The local catalog cache records the value; after a
  plugin upgrade the cache is refetched at once instead of waiting for the 24h TTL.
- Audit logs for these actions show only parameter names with type and size
  (`text:<string 1.2KB> attachments:<2 files 3.4MB>`), never values.

### File parameters on proxy (Composio) actions

A Composio action marks each file param with `file_uploadable: true` in its
`input_schema` (e.g. `YOUTUBE_UPLOAD_VIDEO.videoFilePath`, mail attachments,
Drive uploads). For such a param, pass one of:

| Value | What happens |
|-------|--------------|
| **A local file path** (recommended) — absolute or `~/…`, of a file in `~/zylos/components/openmax/upload/` or `~/zylos/components/openmax/media/` | `conn.invoke` uploads the file, then executes with `{"upload_id": "…"}` in its place |
| A public **direct** `https://` URL (no redirects; max 100MB) | sent as-is; the server downloads it |
| An object you already have (`{"upload_id": …}`, `{name, mimetype, content_base64}`) | sent as-is |

Which strings are local paths: one starting with `~/` always is; one starting
with `/` is, **unless** it looks like raw base64 (it starts with `/9j/` — a
JPEG's base64 — or is 64+ characters of only `A–Z a–z 0–9 + /` with optional
trailing `=`). Any other string (URL, `data:` URI, base64 text, a bare file
name) is sent unchanged.

The server itself accepts only three forms for a file param: a public
`http(s)` URL, `{"upload_id": …}`, or `{name, mimetype, content_base64}`.
Anything else — other object shapes (`{name, path}`, …) or a path the CLI did
not upload — is rejected with `unsupported file input`. So a local file must be
passed as a path the CLI uploads, i.e. one in `~/zylos/components/openmax/upload/`
or `media/`.

**The file must be in the openmax component's `upload/` (or `media/`)
directory** — the same rule as the direct-connection file sources above. Copy
any other file there first with `cp` (not a symlink or hard link):

```bash
cp ~/zylos/workspace/out/demo.mp4 ~/zylos/components/openmax/upload/demo.mp4
node src/cli/conn.js conn.invoke '{"app":"youtube","action":"YOUTUBE_UPLOAD_VIDEO","params":{"videoFilePath":"~/zylos/components/openmax/upload/demo.mp4","title":"Demo","privacyStatus":"unlisted"}}'
```

What `conn.invoke` does for a local path (proxy connections only):

1. Reads the action's `input_schema` (`conn.action_describe`'s endpoint) and
   finds every `file_uploadable` param exactly the way the server does —
   `properties`, single-schema `items`, `anyOf`/`oneOf` (first branch with a
   file value), `allOf` and `$ref` (to `$defs`/`definitions`). Any non-null
   file value except a bare `{s3key}` descriptor counts, not just local paths:
   if a URL / base64 / `upload_id` file value already settles an `anyOf`
   branch or an `allOf`, a local path the server would then skip is not
   uploaded either. A file param under
   `additionalProperties`, `prefixItems` or tuple-form `items: […]` is not
   uploaded (the server would not convert it), and a `file_uploadable` param
   takes one file, not an array of paths. The schema is cached per action
   for 6h under `runtime/connect/action-schema/`; a failed describe is
   remembered for 5 minutes. **So a proxy call whose params contain a string
   starting with `/` or `~/` costs at most one extra describe per action per
   TTL**; calls without such a string never describe. If the schema cannot be
   read (no applicationId yet, describe failed), the call runs exactly as before
   without preprocessing.
2. Checks the path with the direct-branch sandbox: real path (symlinks
   resolved) inside `upload/` or `media/`; dot-file segments, `.env*`, `*.pem`,
   `*.key`, `id_*`, the component `runtime/` and `config.json`, `~/.ssh`,
   `~/.config` refused. Then it opens the file **once** and works only on that
   descriptor: regular file, the same file that was checked (its `/proc/self/fd` path must equal the checked real path and pass the sandbox again; inode compared everywhere), not a hard link, not empty, **at most 500MB**
   (override: `OPENMAX_CONN_UPLOAD_MAX_BYTES`); md5 and the upload both read
   exactly the size seen at open (a file that grows meanwhile is cut at that
   size; one that shrinks fails with `file_changed`). Mimetype from the
   extension (`application/octet-stream` when unknown).
3. `POST /connect/connections/{id}/files/upload-slot` `{action, filename,
   mimetype, size, md5}` → `{upload_id, presigned_url, expires_at}`.
4. Streams the file to `presigned_url` with a plain `PUT` (Content-Type +
   Content-Length only; no platform credentials; skipped when the server returns
   an empty `presigned_url`). The URL is never logged or printed. Timeout: 10
   minutes, longer for big files.
5. Replaces the param with `{"upload_id": "…"}` and executes.

Errors (exit 1, JSON on stderr):

| `code` | status | Meaning / what to do |
|--------|--------|----------------------|
| `file_not_found` | 400 | No such file — check the path. |
| `file_invalid_path` | 400 | Not an absolute / `~/` path. |
| `file_outside_allowed_dirs` | 403 | Copy the file into `~/zylos/components/openmax/upload/` first, then pass that path. |
| `file_forbidden` | 403 | Protected file (keys / `.env` / dot-files / runtime / hard link) — never upload these; pick or copy another file. |
| `file_not_regular` / `file_empty` | 400 | A directory/device, or a 0-byte file — pass a real file with content. |
| `file_too_large` | 400 | Over 500MB — use a smaller file or a public https URL. |
| `file_changed` | 409 | The file was replaced or shrank while being read — stop whatever changes it, then retry. |
| `local_file_upload_unsupported` | 400 | This environment's server has no upload endpoint yet — pass a public direct https URL instead. |
| `CONNECT_CONNECTION_NOT_FOUND` (or another server code) | 404 | The upload-slot call itself was refused — handle like the same error from execute. |
| `CONNECT_FILE_UPLOAD_SLOT_UNAVAILABLE` | 503 | Upload temporarily unavailable on the server — retry later (not in a tight loop), or pass a public https URL. |
| `CONNECT_FILE_UPLOAD_RATE_LIMITED` | 429 | Too many uploads for this connection / org — back off before trying again; do not retry in parallel. |
| `upload_put_failed` / `upload_put_timeout` | 502 / 504 | Upload to storage failed — retry the call **once**; if it fails again, use an https URL. |

**This is a long-running call** (upload + the provider's own processing, e.g.
YouTube): run it without a short timeout and never retry it in parallel —
a cancelled or doubled call can publish twice. Limits of the target platform
(e.g. Gmail's 25MB attachments) still apply and come back from execute as the
provider's error.

### Multiple connections for one app (disambiguation)

An owner can authorize **more than one connection of the same app** to you (e.g.
two Gmail accounts). When you `conn.invoke {app, action, params}` and **more than
one active connection matches** that app, `conn.invoke` does **not** silently pick
one. It returns a **normal result** (stdout, exit 0 — not an error) asking you to
disambiguate:

```json
{
  "needs_selection": true,
  "reason": "multiple_connections",
  "app": "gmail",
  "agent_instruction": "Multiple connections match this app. Ask the user which one to use, phrasing your question in the USER'S language (they may write Chinese or English). Refer to each connection by its label, never the connection_id. Then retry with the chosen connectionId.",
  "candidates": [
    { "connection_id": "c-8f2a4e91", "label": "工作邮箱", "display_name": "工作邮箱", "status": "active" },
    { "connection_id": "c-1b7d0c33", "label": "个人邮箱", "display_name": "个人邮箱", "status": "active" }
  ],
  "retry_hint": "conn.invoke {\"connectionId\":\"<chosen>\",\"action\":\"<same>\",\"params\":{...}}"
}
```

**What to do when you get `needs_selection`:**

1. **Ask the user which connection to use, in the user's own language** (they may
   write Chinese or English — the `agent_instruction` is language-neutral guidance
   on purpose; localize the actual question yourself).
2. **Refer to each candidate by its `label`, never the `connection_id`.** The id
   is an internal handle the user never sees. Each candidate carries a
   guaranteed-non-empty, **unique** `label`: it is the connection's `display_name`
   when set, otherwise a human fallback built from the app name + creation time
   (e.g. `"Gmail · 2026-01-05"`) — so even legacy connections with empty or
   duplicate `display_name` stay distinguishable. Present the `label` as-is; you
   may also invite the owner to name an unnamed connection.
3. **Retry with the chosen connection's id** — pass it as `connectionId` (see
   below). One command re-invokes the same action against the picked connection.

Counts: **0** active → same as before (refresh once, then a 404 "no connection
found" if still none); **exactly 1** → used directly (unchanged); **>1** →
`needs_selection`. `conn.catalog {app}` is per-application and shared across an
app's connections, so it needs **no** disambiguation.

A connection that is **not active** (needs re-authorization, expired, revoked, or
in an error state) is **never** a silent candidate and is rejected **before** any
credential work: `conn.invoke` returns a 409 with an actionable message (for a
reauth-required connection, a "re-authorize on the connection page" hint) — for
both the app-resolved path and the explicit `connectionId` path.

### Targeting a specific connection — `connectionId`

`conn.invoke` accepts an optional **`connectionId`** (alias `connection_id`). When
present it **skips app-resolution entirely** and runs the action against that
connection directly:

```bash
node src/cli/conn.js conn.invoke '{"connectionId":"c-8f2a4e91","action":"gmail/messages-send","params":{...}}'
```

This is exactly the retry after a `needs_selection` prompt: the user picked by
`label`, you map that choice back to the candidate's `connection_id` yourself, and
re-invoke by `connectionId`. `app` is not required when `connectionId` is given.

### `conversationId` on `conn.invoke`

In an OpenMax conversation, pass `conversationId` on `conn.invoke` — copy it
from this turn's `<message-context conversation-id="..."/>`:

```bash
node src/cli/conn.js conn.invoke '{"app":"gmail","action":"gmail/messages-list","params":{},"conversationId":"<conversation-id from <message-context>>"}'
```

It does not change which connectors run: **personal and org connectors both
work in direct messages and group chats**. Outside OpenMax (Lark, scheduled
tasks, automations) there is no OpenMax conversation id — omit it.

## WS Event Flow

The comm-bridge automatically maintains the index for all modes, and (for `direct` connections only) the action-catalog cache and credentials — a `proxy`/composio connection is indexed but keeps no local catalog or credential:

| Event | Action |
|-------|--------|
| `connection.authorized` | Upsert into `connections-index.<orgId>.json` (recording the connector taxonomy `credentialMode` — the index no longer records `credentialSource`; classification keys purely on `credentialMode`), then **refresh that org's index from the authoritative agent-connections list** so `applicationId`/`slug`/`name` are correct immediately — the event payload carries only `connection_id` + `provider` (slug), so a bare upsert alone would leave `applicationId`/`name` null until the next `conn.list`. Then, **by mode**: a **`direct`** connection **warms the action-catalog cache** (`action-catalog/{applicationId}.json`, from `/connect/applications/{id}/actions`) and **acquires the credential** → cache to `runtime/connect/credentials/{id}.json`; a **`proxy`/composio** connection does **neither** (it holds no local token and executes server-side, so no credential is acquired and no full catalog is warmed). The identity refresh + catalog warm are **best-effort** (a failure never blocks the credential/index path). **Also enqueues a one-line session notice to the agent** (`🔌 [Connection authorized] …`, via the C4 control queue) so the bot learns it can act via `conn.*` right away, instead of only discovering the connection by chance on a later `conn.list`. |
| `connection.revoked` | Remove from index + delete cached credential |
| `connection.disconnected` | Remove from index + delete cached credential |
| `connection.credential_updated` | Upsert index; **only when a local credential file already exists** (i.e. a `direct` connection) re-acquire and rewrite the cached token so the local `access_token` stays current. A `proxy`/composio connection has no local file, so this is a no-op for it. |
| `connection.reauth_needed` | **Stop calling the dead connection**: delete the cached credential and keep the connection indexed but flagged `status: needs_reauth` (not removed — reauth is recoverable), so `conn.invoke` surfaces an actionable 409 "needs re-authorization" hint instead of a bare 404. Also **best-effort DM the owner** to re-authorize (`sendOwnerReauthDm`; a no-owner / send failure only warns, never blocks the event path). |

Cache location: `components/openmax/runtime/connect/`

### Agent-side effect of each event

What the agent actually does and stores locally per event. The authorization/token
boundary is enforced server-side by cws-connect; this table is only the
**agent-side** effect.

| Trigger (endpoint) → event | agent does / stores |
|---|---|
| **Authorize to agent** → `connection.authorized` | Upsert the org index (`connections-index.<orgId>.json`, incl. `credentialMode`; `credentialSource` is no longer recorded), then **refresh it from the agent-connections list** so `{applicationId, slug, name, status:active}` is correct despite the sparse event payload. Then, **for a `direct` connection only**: **warm the action-catalog cache** (`action-catalog/<applicationId>.json`) **and** `acquire` the credential and write the real `access_token` to `connect/credentials/<connectionId>.json` (file `0600`, dir `0700`). A **`proxy`/composio** connection skips both — no local credential file and no full catalog (it executes server-side). |
| **Revoke this agent** (`DELETE /connections/{id}/agents/{memberId}`) → `connection.revoked` | Remove from the org index **and** delete `connect/credentials/<connectionId>.json` (the cached token). |
| **Disconnect the connection** (`POST /connections/{id}/disconnect`) → `connection.disconnected` | Same as revoke: remove from the org index **and** delete the cached token file. |
| Token refreshed → `connection.credential_updated` | Re-`acquire` and rewrite the cached token so the local `access_token` stays current — **only when a local credential file exists** (`direct`); a `proxy`/composio connection has no local file and is skipped. |

Note: **revoke vs disconnect** differ in *meaning* — revoke removes only *this
agent's* authorization (`connection_agents` binding) while the connection lives on
for others; disconnect tears down the whole connection for everyone — but the
agent's **local cleanup is identical** (unindex + delete the cached credential).

## BFF Endpoints (via cws-core)

| Method | Path | CLI |
|--------|------|-----|
| GET | `/connect/agents/me/connections` | conn.list / conn.index --refresh |
| POST | `/connect/connections/{id}/credential` | conn.acquire (also the token refresh); sends `X-Connect-Client-Capabilities` including `request_signing.v1` |
| POST | `/connect/connections/{id}/actions/execute` | conn.invoke (proxy/composio server-side execute) |
| POST | `/connect/connections/{id}/sign` | conn.invoke (direct: sign one request of a connection whose credential carries `request_signing`) |
| POST | `/connect/connections/{id}/files/upload-slot` | conn.invoke (proxy: upload slot for a local-path file param) |
| GET | `/connect/applications/{id}/actions/{action}` | conn.invoke (proxy: the action's `input_schema` for file params, cached 6h / failure 5 min) |
| GET | `/conversations/{id}` | conn.invoke (personal-connector group guard: conversation type — guard currently off, not called) |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions` | conn.actions (optional `?cursor=&limit=`) |
| GET | `/connect/applications/{id}/actions` | conn.app_actions / conn.catalog |
| GET | `/connect/applications/{id}/actions:search` | conn.actions_search |
| GET | `/connect/applications/{id}/actions/{action}` | conn.action_describe |
| GET | `/connect/oauth-callback-url` | conn.callback |
| GET | `/connect/applications` | conn.app_list |
| POST | `/connect/applications` | conn.app_create / conn.app_import |
| PATCH | `/connect/applications/{id}` | conn.app_update |
| GET | `/connect/applications/{id}/action-defs` | conn.actiondef_list |
| POST | `/connect/applications/{id}/action-defs` | conn.actiondef_create / conn.app_import |
| PATCH | `/connect/applications/{id}/action-defs/{action_id}` | conn.actiondef_update |
| DELETE | `/connect/applications/{id}/action-defs/{action_id}` | conn.actiondef_delete |

None of the connection/action *usage* endpoints accept a client-supplied
`agent_member_id`, and none of the application/action-def *management* endpoints
accept a client-supplied `org_id` or `oauth_callback_url` — cws-core
derives the caller's identity from the authenticated principal on every one of
them (security fix, 2026-08-04). The CLI never had a way to target a
connection/action that doesn't belong to the calling agent.

## cws-connect follow-up (optional, non-blocking)

`ListApplicationActionsResponse` returns only `ActionInfo` (`toolkit, action,
method, description, params, input_schema`) — **no version/etag**. `Toolkit.version`
exists in the model but is not surfaced on this endpoint. To enable *precise*
catalog invalidation (refresh only when the catalog actually changed), add a
catalog-level version/etag (and ideally `If-None-Match → 304`). Until then the
agent-side cache relies on TTL + error-triggered refresh.
