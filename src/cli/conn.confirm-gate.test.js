/**
 * OPENM-1239 — conn.invoke write-confirmation gate, conn.confirm_prepare,
 * conn.effect_log and conn.confirm_config, exercised through the CLI (the
 * gate lives in the conn.invoke handler) against a local stub server.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { paramsDigest } from '../lib/conn-effect.js';

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));
const ORG = 'org-1';
const SLUG = 'lin-shop';

const GS = { id: 'c-gs', applicationId: 'app-gs', slug: 'googlesheets', name: 'Sheets', status: 'active', credentialMode: 'proxy', credentialSource: 'composio' };
const GM = { id: 'c-gm', applicationId: 'app-gm', slug: 'gmail', name: 'Gmail', status: 'active', credentialMode: 'proxy', credentialSource: 'composio' };
const SH = { id: 'c-sh', applicationId: 'app-sh', slug: 'shopify-app', name: 'Shopify', status: 'active', credentialMode: 'direct', credentialSource: 'managed' };

function setupHome({ confirm, pending, orgExtra = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-confirm-'));
  const comp = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(comp, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(comp, 'config.json'), JSON.stringify({
    orgs: { [SLUG]: { enabled: true, org_id: ORG, self: { member_id: 'm-self' }, ...(confirm !== undefined ? { connector_confirm: confirm } : {}), ...orgExtra } },
  }));
  fs.writeFileSync(path.join(comp, `runtime/connect/connections-index.${ORG}.json`), JSON.stringify({ connections: { 'c-gs': GS, 'c-gm': GM, 'c-sh': SH } }));
  if (pending) fs.writeFileSync(path.join(comp, 'runtime/pending-questions.json'), JSON.stringify(pending));
  return home;
}
const configOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'zylos/components/openmax/config.json'), 'utf8'));
const pendingOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'zylos/components/openmax/runtime/pending-questions.json'), 'utf8'));
const effectLog = (home) => {
  const f = path.join(home, 'zylos/components/openmax/logs/conn-effect.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// Stub cws-core. `executeStatus` is the provider status the proxy execute
// passes through; `routes` add JSON answers by URL prefix.
async function withServer(fn, { executeStatus = 200, routes = {} } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body });
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (/\/connect\/connections\/[^/]+\/actions\/execute/.test(req.url)) {
        return send(200, { data: { status_code: executeStatus, body: { ok: executeStatus < 400 } }, request_id: 'r' });
      }
      for (const [prefix, handler] of Object.entries(routes)) {
        if (req.url.includes(prefix)) {
          const out = typeof handler === 'function' ? handler(req) : handler;
          return send(out.code ?? 200, out.code && out.code >= 400 ? { error: { detail: 'x' }, request_id: 'r' } : { data: out.data ?? out, request_id: 'r' });
        }
      }
      // describe of one action (file-param detection) → no schema
      return send(404, { error: { detail: 'not found' }, request_id: 'r0' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function runConn(home, command, params, apiUrl = 'http://127.0.0.1:1') {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
    delete env.OPENMAX_CONN_EFFECT_LOG;
    delete env.COCO_ORG_ID;
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}
const lastJsonLine = (s) => JSON.parse(s.trim().split('\n').filter((l) => l.startsWith('{')).pop());
const executes = (seen) => seen.filter((s) => s.url.includes('/actions/execute'));

const ALL_ON = { enabled: true, scope: 'all' };
const WRITE = { connectionId: 'c-gs', action: 'GOOGLESHEETS_BATCH_UPDATE', params: { range: 'A1', values: [[1]] } };
const READ = { connectionId: 'c-gs', action: 'GOOGLESHEETS_GET_SPREADSHEET_INFO', params: { id: 's1' } };

function confirmCard({ id = 'm-card', actions, outcome, askedAt = new Date(Date.now() - 60_000).toISOString(), status } = {}) {
  return {
    kind: 'connector.write_confirm', askedOf: 'u-req', conversationId: 'conv-1', cardMessageId: id,
    actionIds: ['opt_1', 'opt_2'], askedAt, meta: { actions },
    ...(outcome === undefined ? { outcome: { source: 'receipt', actorMemberId: 'u-req', optionIndex: 0, at: new Date().toISOString() } } : outcome ? { outcome } : {}),
    ...(status ? { status } : {}),
  };
}
const metaFor = (inv, extra = {}) => ({
  app: 'googlesheets', action: inv.action, connectionId: inv.connectionId, summary: 's', effect: 'write', digest: paramsDigest(inv.params), ...extra,
});

// --- switch off / out of scope: exactly today's behavior ----------------------

test('switch off: a write executes as today, result unchanged, and an effect-log line is still written', async () => {
  const home = setupHome();
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', WRITE, url);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { status_code: 200, body: { ok: true } }, 'no effect/confirmation fields added when off');
    assert.equal(executes(seen).length, 1);
  });
  const [line] = effectLog(home);
  assert.ok(Date.parse(line.ts));
  assert.equal(line.event, 'invoke');
  assert.equal(line.org_id, ORG);
  assert.equal(line.agent_member_id, 'm-self');
  assert.equal(line.app, 'googlesheets');
  assert.equal(line.action, 'GOOGLESHEETS_BATCH_UPDATE');
  assert.equal(line.connection_id, 'c-gs');
  assert.equal(line.mode, 'proxy');
  assert.equal(line.effect, 'write');
  assert.equal(line.basis, 'composio_name:default_write');
  assert.equal(line.confirm_enabled, false);
  assert.equal(line.gate, 'off');
  assert.equal(line.result, 'ok');
  assert.ok(!JSON.stringify(line).includes('A1'), 'params are not logged');
});

test('enabled but connector not in scope: executes as today, result unchanged, gate out_of_scope', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: [{ app: 'gmail' }] } } });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', WRITE, url);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { status_code: 200, body: { ok: true } });
    assert.equal(executes(seen).length, 1);
  });
  assert.equal(effectLog(home)[0].gate, 'out_of_scope');
  assert.equal(effectLog(home)[0].in_scope, false);
});

// --- enabled + in scope ----------------------------------------------------------

test('in scope, write, no confirmation → 403 confirmation_required, NOTHING sent', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', WRITE, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'confirmation_required');
    assert.equal(err.sent, false);
    assert.match(err.hint, /conn\.confirm_prepare/);
    assert.equal(seen.length, 0, `no request at all: ${JSON.stringify(seen)}`);
  });
  const [line] = effectLog(home);
  assert.equal(line.gate, 'rejected:confirmation_required');
  assert.equal(line.result, 'not_sent');
});

test('in scope, read → executes directly; result carries effect + confirmation.mode "read"', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', READ, url);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.effect, 'read');
    assert.deepEqual(out.confirmation, { mode: 'read' });
    assert.equal(executes(seen).length, 1);
  });
  assert.equal(effectLog(home)[0].gate, 'read');
});

test('outbound (GMAIL_SEND_EMAIL) in scope is gated too', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: [{ app: 'gmail', connectionId: 'c-gm' }] } } });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { connectionId: 'c-gm', action: 'GMAIL_SEND_EMAIL', params: { to: 'x' } }, url);
    assert.equal(lastJsonLine(r.stderr).code, 'confirmation_required');
    assert.equal(executes(seen).length, 0);
  });
  assert.equal(effectLog(home)[0].effect, 'outbound_message');
});

test('malformed scope while enabled → treated as "all" (gated) with a warning, never silently passed', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: 'shopify' } } });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', WRITE, url);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /WARNING: .*malformed/);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.code, 'confirmation_required');
    assert.match(err.warning, /malformed/);
    assert.equal(executes(seen).length, 0);
  });
  assert.match(effectLog(home)[0].policy_warning, /malformed/);
});

test('confirmed card: executes once with confirmation.mode "card"; the same action again → already_used', async () => {
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)] })] });
  await withServer(async (url, seen) => {
    const r1 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(r1.code, 0, r1.stderr);
    const out = JSON.parse(r1.stdout);
    assert.equal(out.status_code, 200);
    assert.equal(out.effect, 'write');
    assert.deepEqual(out.confirmation, { mode: 'card', cardMessageId: 'm-card', actionIndex: 0, confirmer: 'u-req' });
    const r2 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card' }, url);
    assert.equal(r2.code, 1);
    assert.equal(lastJsonLine(r2.stderr).reason, 'already_used');
    assert.equal(executes(seen).length, 1, 'executed exactly once');
  });
  assert.equal(pendingOf(home)[0].status, 'used');
  const lines = effectLog(home);
  assert.equal(lines[0].gate, 'confirmed');
  assert.equal(lines[0].card_message_id, 'm-card');
  assert.equal(lines[0].confirmer, 'u-req');
  assert.equal(lines[1].gate, 'rejected:confirmation_invalid:already_used');
});

test('digest mismatch (params changed after the card) → rejected with the re-confirm text, nothing sent', async () => {
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)] })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, params: { range: 'A1', values: [[999]] }, confirmation: 'm-card' }, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.reason, 'digest_mismatch');
    assert.equal(err.user_message, '参数和你确认的不一致，需要重新确认');
    assert.match(err.hint, /参数和你确认的不一致，需要重新确认/);
    assert.equal(executes(seen).length, 0);
  });
});

test('an agent-written (non-receipt) outcome does not authorize', async () => {
  const forged = { source: 'agent', actorMemberId: 'u-req', optionIndex: 0, at: new Date().toISOString() };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)], outcome: forged })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card' }, url);
    assert.equal(lastJsonLine(r.stderr).reason, 'not_answered');
    assert.equal(executes(seen).length, 0);
  });
});

test('provider failure on the first action stops the card; the second action → card_stopped', async () => {
  const W2 = { ...WRITE, params: { range: 'B1', values: [[2]] } };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE), metaFor(W2)] })] });
  await withServer(async (url, seen) => {
    const r1 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card' }, url);
    assert.equal(r1.code, 0);
    assert.equal(JSON.parse(r1.stdout).status_code, 500);
    const r2 = await runConn(home, 'conn.invoke', { ...W2, confirmation: 'm-card' }, url);
    assert.equal(lastJsonLine(r2.stderr).reason, 'card_stopped');
    assert.equal(executes(seen).length, 1);
  }, { executeStatus: 500 });
  assert.equal(pendingOf(home)[0].status, 'stopped');
  assert.equal(effectLog(home)[0].result, 'provider_error');
});

test('external IM text confirmation with by/at/text → executes, logged external_logged (not verified)', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: { external: true, by: '林店主', at: '2026-11-23T10:00:00Z', text: '确认' } }, url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).confirmation.mode, 'external');
    assert.equal(executes(seen).length, 1);
  });
  const [line] = effectLog(home);
  assert.equal(line.gate, 'external_logged');
  assert.equal(line.external_by, '林店主');
  assert.ok(!JSON.stringify(line).includes('"确认"'), 'their words are not logged');
});

// --- direct: classified from the catalog entry before the request -----------------

const SHOP_CATALOG = [
  { toolkit: 'shopify-app-products', action: 'update-variant', method: 'POST', url_template: 'https://{shop}/admin/api/2026-10/graphql.json',
    request_spec: { version: 1, requires: ['body_template'], encoding: 'json', body: { query: 'mutation U($id: ID!) { productVariantsBulkUpdate(productId: $id, variants: []) { userErrors { field } } }', variables: { id: '{{product_id}}' } } } },
  { toolkit: 'shopify-app-products', action: 'list', method: 'POST', url_template: 'https://{shop}/admin/api/2026-10/graphql.json',
    request_spec: { version: 1, requires: ['body_template'], encoding: 'json', body: { query: 'query L { products(first: 5) { nodes { id } } }' } } },
];
const shopRoutes = {
  '/connect/connections/c-sh/credential': { credential_mode: 'direct', access_token: 'tok' },
  '/connect/applications/app-sh/actions': SHOP_CATALOG,
};

test('direct GraphQL mutation in scope → confirmation_required before any provider request', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: [{ app: 'shopify-app' }] } } });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.invoke', { connectionId: 'c-sh', action: 'shopify-app-products/update-variant', params: { product_id: '1' } }, url);
    assert.equal(lastJsonLine(r.stderr).code, 'confirmation_required');
  }, { routes: shopRoutes });
  const [line] = effectLog(home);
  assert.equal(line.mode, 'direct');
  assert.equal(line.basis, 'graphql:mutation');
  assert.equal(line.result, 'not_sent');
});

test('direct GraphQL query in scope passes the gate as a read', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: [{ app: 'app-sh' }] } } });
  await withServer(async (url) => {
    await runConn(home, 'conn.invoke', { connectionId: 'c-sh', action: 'shopify-app-products/list', params: {} }, url);
  }, { routes: shopRoutes });
  const [line] = effectLog(home);
  assert.equal(line.effect, 'read');
  assert.equal(line.basis, 'graphql:query');
  assert.equal(line.gate, 'read');
});

// --- conn.confirm_prepare / conn.effect_log ----------------------------------------

test('conn.confirm_prepare: digest/effect per action and a ready card template when gated', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.confirm_prepare', {
      requesterMemberId: 'u-req',
      actions: [
        { connectionId: 'c-gs', action: WRITE.action, params: WRITE.params, summary: '写入 A1' },
        { app: 'googlesheets', action: READ.action, params: READ.params, summary: '读表' },
      ],
    }, url);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.actions[0].digest, paramsDigest(WRITE.params));
    assert.equal(out.actions[0].effect, 'write');
    assert.equal(out.actions[0].needs_confirmation, true);
    assert.equal(out.actions[1].effect, 'read');
    assert.equal(out.actions[1].needs_confirmation, false);
    assert.deepEqual(out.meta.actions, [{ app: 'googlesheets', action: WRITE.action, connectionId: 'c-gs', summary: '写入 A1', effect: 'write', digest: paramsDigest(WRITE.params) }]);
    assert.equal(out.card.kind, 'connector.write_confirm');
    assert.equal(out.card.askedOf, 'u-req');
    assert.deepEqual(out.card.options, [{ label: '确认执行' }, { label: '取消' }]);
    assert.equal(executes(seen).length, 0, 'prepare never executes');
  });
});

test('conn.confirm_prepare: summary required; switch off → nothing needs confirmation', async () => {
  const home = setupHome();
  const bad = await runConn(home, 'conn.confirm_prepare', { actions: [{ connectionId: 'c-gs', action: 'X' }] });
  assert.equal(bad.code, 1);
  assert.match(lastJsonLine(bad.stderr).error, /summary is required/);
  const r = await runConn(home, 'conn.confirm_prepare', { actions: [{ connectionId: 'c-gs', action: WRITE.action, params: WRITE.params, summary: 's' }] });
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.meta.actions, []);
  assert.equal(out.card, undefined);
});

test('conn.effect_log summarizes the local log (filter by mode)', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url) => {
    await runConn(home, 'conn.invoke', READ, url);
    await runConn(home, 'conn.invoke', WRITE, url);
  });
  const r = await runConn(home, 'conn.effect_log', { mode: 'proxy', since: '2020-01-01' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.total, 2);
  assert.deepEqual(out.by_effect, { read: 1, write: 1 });
  assert.equal(out.by_gate.read, 1);
  assert.equal(out.by_gate['rejected:confirmation_required'], 1);
  assert.equal(JSON.parse((await runConn(home, 'conn.effect_log', { mode: 'direct' })).stdout).total, 0);
});

// --- conn.confirm_config ------------------------------------------------------------

const CONV = '019ea63a-c01b-7ca6-8463-e8d455bfd537';
const OWNER = '019ea63a-0000-7000-8000-000000000001';
const ADMIN = '019ea63a-0000-7000-8000-000000000002';
function memberRoutes(senderId) {
  return {
    [`/conversations/${CONV}/messages/123`]: { conversation_id: CONV, sender_id: senderId, sender_type: 'HUMAN', timestamp: new Date().toISOString() },
    [`/members/${OWNER}`]: { member_id: OWNER, kind: 'human', status: 'active', role: 'org-owner', display_name: '林店主' },
    [`/members/${ADMIN}`]: { member_id: ADMIN, kind: 'human', status: 'active', role: 'org-admin', display_name: '小王' },
  };
}

test('conn.confirm_config get: shows the stored block and the effective policy', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: { connectors: 'bad' } } });
  const r = await runConn(home, 'conn.confirm_config', { action: 'get' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.org, SLUG);
  assert.deepEqual(out.connector_confirm, { enabled: true, scope: { connectors: 'bad' } });
  assert.equal(out.effective.scope, 'all');
  assert.match(out.effective.warning, /malformed/);
});

test('conn.confirm_config set by the org Owner: stored with requested_by/date, audited', async () => {
  const home = setupHome({ confirm: { ticket: 'wsb#753' } });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.confirm_config', {
      action: 'set', enabled: true, scope: { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] }, conversationId: CONV, messageId: '123',
    }, url);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.effective.enabled, true);
    assert.match(out.changed_by, /林店主/);
  }, { routes: memberRoutes(OWNER) });
  const cc = configOf(home).orgs[SLUG].connector_confirm;
  assert.equal(cc.enabled, true);
  assert.deepEqual(cc.scope, { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] });
  assert.equal(cc.ticket, 'wsb#753', 'other fields kept');
  assert.equal(cc.requested_by_member_id, OWNER);
  assert.match(cc.requested_by, /林店主/);
  assert.ok(Date.parse(cc.date));
  const [audit] = effectLog(home);
  assert.equal(audit.event, 'confirm_config');
  assert.equal(audit.allowed, true);
  assert.equal(audit.initiator_member_id, OWNER);
  assert.deepEqual(audit.change, { enabled: true, scope: { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] } });
});

test('conn.confirm_config set by an admin (not Owner) → 403 not_org_owner, config unchanged, audited', async () => {
  const home = setupHome();
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: true, conversationId: CONV, messageId: '123' }, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'not_org_owner');
    assert.equal(err.reason, 'initiator_not_owner');
    assert.match(err.reply, /Owner/);
  }, { routes: memberRoutes(ADMIN) });
  assert.equal(configOf(home).orgs[SLUG].connector_confirm, undefined);
  assert.equal(effectLog(home)[0].allowed, false);
});

test('conn.confirm_config set without a Workspace source message → refused', async () => {
  const home = setupHome();
  const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: false });
  assert.equal(r.code, 1);
  assert.equal(lastJsonLine(r.stderr).code, 'not_org_owner');
  assert.equal(configOf(home).orgs[SLUG].connector_confirm, undefined);
});

test('conn.confirm_config set with malformed input → 400, nothing stored', async () => {
  const home = setupHome({ confirm: { enabled: false } });
  for (const p of [
    { scope: 'some' }, { scope: { connectors: [] } }, { scope: { connectors: [{ connectionId: 'c1' }] } },
    { enabled: 'yes' }, {},
  ]) {
    const r = await runConn(home, 'conn.confirm_config', { action: 'set', conversationId: CONV, messageId: '123', ...p });
    assert.equal(r.code, 1, JSON.stringify(p));
    assert.equal(lastJsonLine(r.stderr).status, 400, JSON.stringify(p));
  }
  assert.deepEqual(configOf(home).orgs[SLUG].connector_confirm, { enabled: false });
  assert.equal(effectLog(home).length, 0, 'rejected before the owner check');
});
