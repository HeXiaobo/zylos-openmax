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
    const env = { ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
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
    ...(outcome === undefined ? { outcome: { source: 'receipt', actorMemberId: 'u-req', actorKind: 'human_member', optionIndex: 0, at: new Date().toISOString() } } : outcome ? { outcome } : {}),
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
    const r2 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
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
    const r = await runConn(home, 'conn.invoke', { ...WRITE, params: { range: 'A1', values: [[999]] }, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
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
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(lastJsonLine(r.stderr).reason, 'not_answered');
    assert.equal(executes(seen).length, 0);
  });
});

test('provider failure on the first action stops the card; the second action → card_stopped', async () => {
  const W2 = { ...WRITE, params: { range: 'B1', values: [[2]] } };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE), metaFor(W2)] })] });
  await withServer(async (url, seen) => {
    const r1 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(r1.code, 0);
    assert.equal(JSON.parse(r1.stdout).status_code, 500);
    const r2 = await runConn(home, 'conn.invoke', { ...W2, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(lastJsonLine(r2.stderr).reason, 'card_stopped');
    assert.equal(executes(seen).length, 1);
  }, { executeStatus: 500 });
  assert.equal(pendingOf(home)[0].status, 'stopped');
  assert.equal(effectLog(home)[0].result, 'provider_error');
});

// External-IM confirmations: conn.confirm_prepare external:{channel, endpoint}
// creates a record; conn.invoke names it; the reply must be an inbound C4 row.
async function writeC4(home, rows) {
  const dir = path.join(home, 'zylos/comm-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'c4.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, channel TEXT, endpoint_id TEXT,
    content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  for (const r of rows) db.prepare('INSERT INTO conversations (direction, channel, endpoint_id, content) VALUES (?, ?, ?, ?)').run(r.direction || 'in', r.channel, r.endpoint, r.content);
  db.close();
}
const EXT = { channel: 'lark', endpoint: 'oc_x|type:p2p|msg:om_1' };
const larkDm = (sender, text) => `[Lark DM]\n<current-message>\n${sender} said: ${text}\n</current-message>`;
// The request message the prepare reads its requester sender from.
const REQUEST = { channel: 'lark', endpoint: EXT.endpoint, content: larkDm('林店主', '把 A1 改成 1') };

test('external IM: prepare (no card) → reply in that chat → invoke with {external, id, …} executes once; logged with evidence', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await writeC4(home, [REQUEST]);
  await withServer(async (url, seen) => {
    const prep = await runConn(home, 'conn.confirm_prepare', {
      actions: [{ ...WRITE, summary: '写入 A1' }], requesterMemberId: 'lark:ou_1', external: EXT,
    }, url);
    assert.equal(prep.code, 0, prep.stderr);
    const out = JSON.parse(prep.stdout);
    assert.equal(out.card, undefined, 'no card for an external request');
    assert.match(out.external.id, /^extc_/);
    assert.equal(out.external.endpoint, 'oc_x|type:p2p');
    assert.equal(out.external.requester_sender, '林店主');
    const conf = { external: true, id: out.external.id, by: '林店主', at: '2026-11-23T10:00:00Z', text: '确认' };
    // Before the reply arrives: refused, nothing sent.
    const early = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: conf, requesterMemberId: 'lark:ou_1' }, url);
    assert.equal(lastJsonLine(early.stderr).reason, 'external_unverified');
    // Someone else's 「确认」 in the same chat does not count.
    await writeC4(home, [{ channel: 'lark', endpoint: 'oc_x|type:p2p|msg:om_2', content: larkDm('王同事', '确认') }]);
    const other = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: conf, requesterMemberId: 'lark:ou_1' }, url);
    assert.equal(lastJsonLine(other.stderr).reason, 'external_unverified');
    await writeC4(home, [{ channel: 'lark', endpoint: 'oc_x|type:p2p|msg:om_3', content: larkDm('林店主', '确认') }]);
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: conf, requesterMemberId: 'lark:ou_1' }, url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).confirmation.mode, 'external');
    const again = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: conf, requesterMemberId: 'lark:ou_1' }, url);
    assert.equal(lastJsonLine(again.stderr).reason, 'already_used');
    assert.equal(executes(seen).length, 1);
  });
  const lines = effectLog(home);
  const ok = lines.find((l) => l.gate === 'external_confirmed');
  assert.equal(ok.external_by, '林店主');
  assert.equal(ok.external_agent_at, '2026-11-23T10:00:00Z');
  assert.ok(ok.external_evidence?.id);
  assert.equal(ok.external_evidence.sender, '林店主');
  assert.ok(!JSON.stringify(lines).includes('"确认"'), 'their words are not logged');
});

test('external IM: a failed action stops the external confirmation; the next action → card_stopped, nothing more sent', async () => {
  const W2 = { ...WRITE, params: { range: 'B1', values: [[2]] } };
  const home = setupHome({ confirm: ALL_ON });
  await writeC4(home, [REQUEST]);
  await withServer(async (url, seen) => {
    const prep = await runConn(home, 'conn.confirm_prepare', {
      actions: [{ ...WRITE, summary: 'A1' }, { ...W2, summary: 'B1' }], requesterMemberId: 'u-req', external: EXT,
    }, url);
    assert.equal(prep.code, 0, prep.stderr);
    const id = JSON.parse(prep.stdout).external.id;
    await writeC4(home, [{ channel: 'lark', endpoint: 'oc_x|type:p2p|msg:om_2', content: larkDm('林店主', '确认') }]);
    const conf = { external: true, id, by: '林店主', at: 'now', text: '确认' };
    const r1 = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: conf, requesterMemberId: 'u-req' }, url);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout).status_code, 500);
    const rec = pendingOf(home).find((x) => x.id === id);
    assert.equal(rec.status, 'stopped');
    assert.equal(rec.stoppedReason, 'provider_status:500');
    const r2 = await runConn(home, 'conn.invoke', { ...W2, confirmation: conf, requesterMemberId: 'u-req' }, url);
    assert.equal(lastJsonLine(r2.stderr).reason, 'card_stopped');
    assert.equal(executes(seen).length, 1);
  }, { executeStatus: 500 });
});

test('external IM: prepare refuses a non-IM channel (whitelist) and a request message it cannot find in C4', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await writeC4(home, [REQUEST, { channel: 'web-console', endpoint: 'x|msg:1', content: '[Dashboard] a said: x' }]);
  await withServer(async (url, seen) => {
    for (const channel of ['dashboard', 'web-console', 'c4', 'webhook', 'internal', 'openmax']) {
      const p = await runConn(home, 'conn.confirm_prepare', { actions: [{ ...WRITE, summary: 's' }], requesterMemberId: 'u', external: { channel, endpoint: 'x|msg:1' } }, url);
      assert.equal(p.code, 1, channel);
      assert.equal(lastJsonLine(p.stderr).code, 'external_channel_refused', channel);
    }
    for (const endpoint of ['oc_x|type:p2p|msg:om_unknown', 'oc_y|type:p2p|msg:om_1']) {
      const p = await runConn(home, 'conn.confirm_prepare', { actions: [{ ...WRITE, summary: 's' }], requesterMemberId: 'u', external: { channel: 'lark', endpoint } }, url);
      assert.equal(p.code, 1, endpoint);
      assert.equal(lastJsonLine(p.stderr).code, 'external_request_not_found', endpoint);
    }
    assert.equal(executes(seen).length, 0);
  });
  assert.equal(fs.existsSync(path.join(home, 'zylos/components/openmax/runtime/pending-questions.json')), false, 'no record written');
});

test('external IM: the old unbound {external, by, at, text} → external_malformed; prepare refuses external with a Workspace conversationId', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: { external: true, by: '林店主', at: '2026-11-23T10:00:00Z', text: '确认' }, requesterMemberId: 'lark:ou_1' }, url);
    assert.equal(lastJsonLine(r.stderr).reason, 'external_malformed');
    const p = await runConn(home, 'conn.confirm_prepare', { actions: [{ ...WRITE, summary: 's' }], requesterMemberId: 'u', external: EXT, conversationId: 'conv-1' }, url);
    assert.equal(p.code, 1);
    assert.equal(lastJsonLine(p.stderr).code, 'external_in_workspace');
    const q = await runConn(home, 'conn.confirm_prepare', { actions: [{ ...WRITE, summary: 's' }], requesterMemberId: 'u', external: { channel: 'openmax', endpoint: 'x' } }, url);
    assert.equal(q.code, 1);
    assert.equal(executes(seen).length, 0);
  });
});

// --- review fixes: requester required, human tap, external only outside Workspace --

test('confirmed card without requesterMemberId → requester_missing, nothing sent, card not consumed', async () => {
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)] })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card' }, url);
    assert.equal(r.code, 1);
    assert.equal(lastJsonLine(r.stderr).reason, 'requester_missing');
    assert.equal(executes(seen).length, 0);
  });
  assert.equal(pendingOf(home)[0].consumed, undefined);
});

test('card tapped by a non-human actor → answerer_not_human, nothing sent', async () => {
  const outcome = { source: 'receipt', actorMemberId: 'u-req', actorKind: 'agent', optionIndex: 0, at: new Date().toISOString() };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)], outcome })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(lastJsonLine(r.stderr).reason, 'answerer_not_human');
    assert.equal(executes(seen).length, 0);
  });
});

test('external text confirmation with a Workspace conversationId → external_in_workspace, nothing sent', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', {
      ...WRITE, conversationId: 'conv-1', requesterMemberId: 'u-req',
      confirmation: { external: true, id: 'extc_1', by: '林店主', at: '2026-11-23T10:00:00Z', text: '确认' },
    }, url);
    assert.equal(r.code, 1);
    assert.equal(lastJsonLine(r.stderr).reason, 'external_in_workspace');
    assert.equal(executes(seen).length, 0);
  });
});

test('conn.confirm_prepare: a gated action without requesterMemberId → 400 requester_missing, no card', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.confirm_prepare', { actions: [{ connectionId: 'c-gs', action: WRITE.action, params: WRITE.params, summary: 's' }] }, url);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), '');
    const err = lastJsonLine(r.stderr);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'requester_missing');
    // Reads only: no requester needed.
    const ok = await runConn(home, 'conn.confirm_prepare', { actions: [{ connectionId: 'c-gs', action: READ.action, params: READ.params, summary: 's' }] }, url);
    assert.equal(ok.code, 0, ok.stderr);
  });
});

// --- execution window: 30 minutes from the tap, not from the send ----------------

const minAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

test('card sent 44 min ago, tapped at minute 29 (15 min ago) → still executes (window runs from the tap)', async () => {
  const outcome = { source: 'receipt', actorMemberId: 'u-req', actorKind: 'human_member', optionIndex: 0, at: minAgo(15) };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)], askedAt: minAgo(44), outcome })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).confirmation.mode, 'card');
    assert.equal(executes(seen).length, 1);
  });
});

test('invoked more than 30 min after the tap → execution_window_expired, nothing sent', async () => {
  const outcome = { source: 'receipt', actorMemberId: 'u-req', actorKind: 'human_member', optionIndex: 0, at: minAgo(31) };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)], askedAt: minAgo(40), outcome })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.reason, 'execution_window_expired');
    assert.equal(err.sent, false);
    assert.equal(executes(seen).length, 0);
  });
  assert.equal(effectLog(home)[0].gate, 'rejected:confirmation_invalid:execution_window_expired');
});

test('tapped more than 30 min after the card was sent → expired, nothing sent', async () => {
  const outcome = { source: 'receipt', actorMemberId: 'u-req', actorKind: 'human_member', optionIndex: 0, at: minAgo(5) };
  const home = setupHome({ confirm: ALL_ON, pending: [confirmCard({ actions: [metaFor(WRITE)], askedAt: minAgo(36), outcome })] });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { ...WRITE, confirmation: 'm-card', requesterMemberId: 'u-req' }, url);
    assert.equal(lastJsonLine(r.stderr).reason, 'expired');
    assert.equal(executes(seen).length, 0);
  });
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

// --- direct action missing from the catalog: no confirmation, the 404 at once -------

const SHOP_SCOPE = { enabled: true, scope: { connectors: [{ app: 'shopify-app' }] } };
const MISSING = { connectionId: 'c-sh', action: 'shopify-app-products/delete-everything', params: { product_id: '1' } };
const providerCalls = (seen) => seen.filter((s) => !s.url.includes('/connect/'));

test('conn.invoke: in-scope direct action not in the catalog → unknown-action 404 at once, no confirmation asked, nothing sent', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', MISSING, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.equal(err.status, 404);
    assert.match(err.error, /unknown action "shopify-app-products\/delete-everything" for app \(not in local catalog\)/);
    assert.notEqual(err.code, 'confirmation_required');
    assert.equal(executes(seen).length, 0);
    assert.equal(providerCalls(seen).length, 0);
  }, { routes: shopRoutes });
  const [line] = effectLog(home);
  assert.equal(line.result, 'not_sent');
  assert.ok(!String(line.gate).startsWith('rejected:'), `no gate rejection: ${line.gate}`);
});

test('conn.invoke: an action that IS in the catalog (short slug form) is still gated normally', async () => {
  // The not-found shortcut only fires for actions the catalog lacks: a real
  // write in the same catalog keeps needing its confirmation.
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.invoke', { connectionId: 'c-sh', action: 'update-variant', params: { product_id: '1' } }, url);
    assert.equal(lastJsonLine(r.stderr).code, 'confirmation_required');
  }, { routes: shopRoutes });
});

test('conn.invoke: catalog lookup fails (5xx) → error, nothing sent, never executed without confirmation', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', MISSING, url);
    assert.equal(r.code, 1);
    const err = lastJsonLine(r.stderr);
    assert.notEqual(err.status, 404);
    assert.equal(executes(seen).length, 0);
    assert.equal(providerCalls(seen).length, 0);
  }, { routes: { ...shopRoutes, '/connect/applications/app-sh/actions': { code: 503 } } });
});

test('conn.invoke: catalog returned empty / in an unexpected shape → still gated (confirmation_required)', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', MISSING, url);
    assert.equal(lastJsonLine(r.stderr).code, 'confirmation_required');
    assert.equal(providerCalls(seen).length, 0);
  }, { routes: { ...shopRoutes, '/connect/applications/app-sh/actions': { data: { unexpected: true } } } });
});

test('conn.confirm_prepare: direct action not in the catalog → the same 404, no card / meta.actions', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.confirm_prepare', {
      requesterMemberId: 'u-req',
      actions: [
        { connectionId: 'c-sh', action: 'shopify-app-products/update-variant', params: { product_id: '1' }, summary: '改价' },
        { ...MISSING, summary: '删除' },
      ],
    }, url);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), '', 'no card template printed');
    const err = lastJsonLine(r.stderr);
    assert.equal(err.status, 404);
    assert.match(err.error, /unknown action "shopify-app-products\/delete-everything" for app \(not in local catalog\)/);
    assert.equal(executes(seen).length, 0);
  }, { routes: shopRoutes });
});

test('conn.confirm_prepare: an in-catalog direct write is still classified and needs confirmation', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.confirm_prepare', {
      requesterMemberId: 'u-req',
      actions: [{ connectionId: 'c-sh', action: 'shopify-app-products/update-variant', params: { product_id: '1' }, summary: '改价' }],
    }, url);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.actions[0].needs_confirmation, true);
    assert.equal(out.actions[0].basis, 'graphql:mutation');
    assert.equal(out.meta.actions.length, 1);
  }, { routes: shopRoutes });
});

test('conn.confirm_prepare: catalog lookup failure → error, no card (fail closed)', async () => {
  const home = setupHome({ confirm: SHOP_SCOPE });
  await withServer(async (url) => {
    const r = await runConn(home, 'conn.confirm_prepare', { actions: [{ ...MISSING, summary: '删除' }] }, url);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), '');
    assert.notEqual(lastJsonLine(r.stderr).status, 404);
  }, { routes: { ...shopRoutes, '/connect/applications/app-sh/actions': { code: 503 } } });
});

test('conn.confirm_prepare: a proxy action keeps its classification (no catalog lookup, still needs confirmation)', async () => {
  const home = setupHome({ confirm: ALL_ON });
  await withServer(async (url, seen) => {
    const r = await runConn(home, 'conn.confirm_prepare', { requesterMemberId: 'u-req', actions: [{ connectionId: 'c-gs', action: 'GOOGLESHEETS_NOT_A_REAL_ACTION', params: {}, summary: 's' }] }, url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).actions[0].needs_confirmation, true);
    assert.ok(!seen.some((s) => s.url.includes('/actions?') || /\/applications\/[^/]+\/actions$/.test(s.url)));
  });
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

const MEMBER = '019ea63a-0000-7000-8000-000000000001';

test('malformed connector_confirm ("on", true, 1, []) fails closed: get shows enabled, a write is gated, nothing sent', async () => {
  for (const shape of ['on', true, 1, []]) {
    const home = setupHome({ confirm: shape });
    const g = await runConn(home, 'conn.confirm_config', { action: 'get' });
    assert.equal(g.code, 0, g.stderr);
    const eff = JSON.parse(g.stdout).effective;
    assert.equal(eff.enabled, true, JSON.stringify(shape));
    assert.equal(eff.scope, 'all');
    assert.match(eff.warning, /not an object/);
    await withServer(async (url, seen) => {
      const r = await runConn(home, 'conn.invoke', WRITE, url);
      assert.equal(r.code, 1);
      assert.equal(lastJsonLine(r.stderr).code, 'confirmation_required', JSON.stringify(shape));
      assert.equal(executes(seen).length, 0);
    });
  }
});

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

test('conn.confirm_config set works without any caller identity; date recorded; log line written; no network', async () => {
  const home = setupHome({ confirm: { ticket: 'wsb#753' } });
  // Unroutable API URL (the default): set never makes a request.
  const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: true, scope: { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] } });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.effective.enabled, true);
  assert.equal(out.changed_by, undefined);
  const cc = configOf(home).orgs[SLUG].connector_confirm;
  assert.equal(cc.enabled, true);
  assert.deepEqual(cc.scope, { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] });
  assert.equal(cc.ticket, 'wsb#753', 'other fields kept');
  assert.equal(cc.requested_by, undefined);
  assert.equal(cc.requested_by_member_id, undefined);
  assert.ok(Date.parse(cc.date));
  const [line] = effectLog(home);
  assert.equal(line.event, 'confirm_config');
  assert.equal(line.org_id, ORG);
  assert.equal(line.initiator_member_id, null);
  assert.deepEqual(line.change, { enabled: true, scope: { connectors: [{ app: 'shopify-app', connectionId: 'c-sh' }] } });
});

test('conn.confirm_config set records who asked when given; enabling without scope stores "all"', async () => {
  const home = setupHome();
  const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: true, requesterMemberId: MEMBER, requestedBy: '林店主' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).changed_by, '林店主');
  const cc = configOf(home).orgs[SLUG].connector_confirm;
  assert.equal(cc.scope, 'all');
  assert.equal(cc.requested_by, '林店主');
  assert.equal(cc.requested_by_member_id, MEMBER);
  assert.equal(effectLog(home)[0].initiator_member_id, MEMBER);
  // A later anonymous (non-loosening) change does not leave the earlier name standing.
  await runConn(home, 'conn.confirm_config', { action: 'set', enabled: true });
  const cc2 = configOf(home).orgs[SLUG].connector_confirm;
  assert.equal(cc2.enabled, true);
  assert.equal(cc2.requested_by, undefined);
  assert.equal(effectLog(home).length, 2);
});

test('conn.confirm_config set: loosening without an initiator → denied via the CLI, nothing changed, denial logged, no network', async () => {
  const home = setupHome({ confirm: { enabled: true, scope: 'all' } });
  const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: false, requestedBy: '林店主' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'missing_initiator');
  assert.match(out.reply, /只有这个 Agent 的主人/);
  assert.equal(out.notice, undefined);
  assert.deepEqual(configOf(home).orgs[SLUG].connector_confirm, { enabled: true, scope: 'all' });
  const [line] = effectLog(home);
  assert.equal(line.decision, 'denied');
  assert.equal(line.reason, 'missing_initiator');
  assert.equal(line.loosening, true);
});

test('conn.confirm_config set: tightening via the CLI returns the notice to post', async () => {
  const home = setupHome();
  const r = await runConn(home, 'conn.confirm_config', { action: 'set', enabled: true, requestedBy: '林店主' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.allowed, true);
  assert.equal(out.notice, '连接器写操作确认开关已由 林店主 改为：开启，范围：全部连接器\nConnector write confirmation changed by 林店主 to: on, scope: all connectors');
  assert.match(out.instruction, /verbatim/);
});

test('conn.confirm_config set with malformed input → 400, nothing stored, nothing logged', async () => {
  const home = setupHome({ confirm: { enabled: false } });
  for (const p of [
    { scope: 'some' }, { scope: { connectors: [] } }, { scope: { connectors: [{ connectionId: 'c1' }] } },
    { enabled: 'yes' }, {},
  ]) {
    const r = await runConn(home, 'conn.confirm_config', { action: 'set', ...p });
    assert.equal(r.code, 1, JSON.stringify(p));
    assert.equal(lastJsonLine(r.stderr).status, 400, JSON.stringify(p));
  }
  assert.deepEqual(configOf(home).orgs[SLUG].connector_confirm, { enabled: false });
  assert.equal(effectLog(home).length, 0);
  const bad = await runConn(home, 'conn.confirm_config', { action: 'delete' });
  assert.equal(lastJsonLine(bad.stderr).status, 400);
});
