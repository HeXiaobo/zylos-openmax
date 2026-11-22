import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const connOps = read('../../references/conn-operations.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section: ${start}`);
  return source.slice(from, to);
}

test('conn-operations: one vocabulary — connector_kind http | mcp, auth_type api_key | oauth2 for http only', () => {
  assert.doesNotMatch(connOps, /`provider_type` = `auth_type`,/);
  assert.doesNotMatch(connOps, /`api_key` \| `oauth2` \| `mcp`/);
  assert.doesNotMatch(connOps, /"auth_type":"mcp"/);
  assert.match(connOps, /`connector_kind` and `auth_type` = the card's \(`auth_type` exists \*\*on `http` cards only\*\*\)/);
  assert.match(connOps, /An `mcp` card has no `auth_type` and is never `auth_type` \/ `provider_type` `"mcp"` \(refused\)/);
  assert.match(connOps, /"connector_kind":"http","auth_type":"oauth2"/);
});

test('conn-operations documents the two-step MCP connector path', () => {
  const mcp = section(connOps, '#### MCP connectors (`connector_kind: "mcp"`) — two steps', '### Action-def schema semantics');
  assert.match(mcp, /"connector_kind":"mcp"\}\}'/);
  assert.doesNotMatch(mcp, /"provider_type":"oauth2"/);
  assert.doesNotMatch(connOps, /Plaud and most hosted MCP/);
  assert.match(mcp, /\*\*no `auth_type`\*\* \(refused\) and \*\*omit `provider_type`\*\* \(the CLI sends `api_key`\)/);
  assert.match(mcp, /upgrades `api_key` → `oauth2`, never the reverse/);
  assert.match(mcp, /no `oauth_authorize_url` \/ `oauth_token_url` \/ `oauth_scopes_default` \(refused/);
  assert.match(mcp, /`oauth_client_id` is accepted/);
  assert.match(mcp, /「应用连接」页面/);
  assert.match(mcp, /传输类型选「远程（Streamable HTTP）」/);
  assert.match(mcp, /在「服务器 URL」里粘贴/);
  assert.doesNotMatch(mcp, /「MCP 服务器地址」/);
  assert.match(mcp, /"connector_kind":"mcp"[^']*"server_url":"https:/);
  assert.match(mcp, /Never `auth_type: "mcp"` \/ `provider_type: "mcp"`/);
  assert.match(mcp, /No `actions` \(refused\)/);
  assert.match(mcp, /\*\*\(b\) The user connects it on openmax\.com\.\*\*/);
  assert.match(mcp, /\*\*exact URL to paste\*\*/);
  assert.match(mcp, /`mcp_server\.server_url` with transport `remote_http`/);
  assert.match(mcp, /tell the user plainly what failed/);
});

test('conn.app_create docs: connector_kind is a separate axis from provider_type', () => {
  const create = section(connOps, '### conn.app_create', '### conn.app_list');
  assert.match(create, /`connector_kind` \(optional\): `http` \(default/);
  assert.match(create, /\*\*never\*\* `"mcp"`/);
  assert.match(create, /Required: `display_name`, `auth_type` \(`api_key` \| `oauth2`/);
  assert.match(create, /For `connector_kind: "mcp"` send \*\*no\*\* `auth_type` \(refused\)/);
  assert.match(create, /`provider_type` is only a \*\*placeholder\*\*/);
  assert.match(create, /`oauth_authorize_url` \/\s*`oauth_token_url` \/ `oauth_scopes_default` are refused/);
  assert.match(connOps, /exactly as written — lowercase; anything else, e\.g\. `OAuth2` \/ `basic`, is refused/);
});
