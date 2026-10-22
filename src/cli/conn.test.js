import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildNeedsSelection, buildCandidateLabels, resolveInvokeEntry,
  planAppCreate, planAppUpdate,
  planActionDefList, planActionDefCreate, planActionDefUpdate, planActionDefDelete,
  runAppImport, resolveGuardConversationType,
  buildPageQuery, planConnActions, planAppActions, planActionsSearch, withNextCursor,
  planActionDescribe,
} from './conn.js';

// buildNeedsSelection / buildCandidateLabels / resolveInvokeEntry are pure (no
// network/config), so the three-branch resolution, the connectionId bypass, and
// label disambiguation are unit-testable here. conn.js guards main() behind an
// is-main check so importing it runs nothing. The non-active guard lives in the
// conn.invoke handler, so it is exercised via subprocess (see bottom of file).

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));

// --- buildNeedsSelection: shape + i18n contract -----------------------------

test('buildNeedsSelection 结构：candidates(connection_id/label/display_name/status) + retry_hint', () => {
  const res = buildNeedsSelection('gmail', 'gmail/messages-list', [
    { id: 'c-8f2a', displayName: '工作邮箱', status: 'active' },
    { id: 'c-1b7d', displayName: '个人邮箱', status: 'active' },
  ]);
  assert.equal(res.needs_selection, true);
  assert.equal(res.reason, 'multiple_connections');
  assert.equal(res.app, 'gmail');
  // Deterministic order: neither has createdAt, so the id tiebreak applies —
  // 'c-1b7d' < 'c-8f2a' lexicographically, so it comes first regardless of the
  // input order (see the P2 order-invariance test below).
  assert.deepEqual(res.candidates, [
    { connection_id: 'c-1b7d', label: '个人邮箱', display_name: '个人邮箱', status: 'active' },
    { connection_id: 'c-8f2a', label: '工作邮箱', display_name: '工作邮箱', status: 'active' },
  ]);
  // retry_hint carries BOTH the connectionId placeholder and the same action.
  assert.match(res.retry_hint, /connectionId/);
  assert.match(res.retry_hint, /gmail\/messages-list/);
});

test('buildNeedsSelection: display_name 为空原样透传 null，但 label 仍非空且非 connection_id', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', name: 'Gmail', status: 'active' }]);
  assert.equal(res.candidates[0].display_name, null);
  assert.ok(res.candidates[0].label && res.candidates[0].label.length > 0);
  assert.notEqual(res.candidates[0].label, 'c1'); // never the raw id
});

test('buildNeedsSelection: agent_instruction 语言中立，不写死中/英用户句', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', displayName: '工作邮箱', status: 'active' }]);
  const instr = res.agent_instruction;
  // Neutral English guidance that tells the agent to localize into the user's language.
  assert.match(instr, /USER'S language/);
  assert.match(instr, /label/);            // refers to label, not connection_id
  assert.match(instr, /never the connection_id/);
  // Must NOT embed a ready-made user-facing sentence in either language.
  //  - no CJK characters anywhere in the instruction (no hardcoded Chinese)
  assert.doesNotMatch(instr, /[一-鿿]/);
  //  - not a hardcoded English question addressed to the user
  assert.doesNotMatch(instr, /which (account|connection) would you|please choose/i);
  // The whole response object carries no hardcoded Chinese OUTSIDE the pass-through
  // user-supplied values (display_name and the label derived from it).
  const scrubbed = JSON.stringify({
    ...res,
    candidates: res.candidates.map((c) => ({ ...c, display_name: null, label: null })),
  });
  assert.doesNotMatch(scrubbed, /[一-鿿]/);
});

// --- buildCandidateLabels: non-empty + unique in the tie cases (P1-1) --------

test('buildCandidateLabels: 两个都为 null display_name（无 createdAt）→ label 非空且互异，绝不用 connection_id', () => {
  const labels = buildCandidateLabels([
    { id: 'c-8f2a4e91', name: 'Gmail', displayName: null, status: 'active' },
    { id: 'c-1b7d0c33', name: 'Gmail', displayName: '',   status: 'active' },
  ]);
  assert.equal(labels.length, 2);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));       // non-empty
  assert.notEqual(labels[0], labels[1]);                            // distinct
  assert.ok(!labels.includes('c-8f2a4e91') && !labels.includes('c-1b7d0c33')); // not the id
});

test('buildCandidateLabels: 重复 display_name（无 createdAt）→ 以序号消歧，互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: '工作邮箱', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: '工作邮箱', status: 'active' },
  ]);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));
  assert.notEqual(labels[0], labels[1]);
  labels.forEach((l) => assert.match(l, /工作邮箱/)); // built from the shared display_name
});

test('buildCandidateLabels: 重复 display_name 但 createdAt 不同 → 用创建时间消歧，互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-02-01T08:30:00Z', status: 'active' },
  ]);
  assert.notEqual(labels[0], labels[1]);
  assert.match(labels[0], /2026-01-05/);
  assert.match(labels[1], /2026-02-01/);
});

test('buildCandidateLabels: 空名 + 相同创建日 → 退化到序号，仍互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: null, createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: null, createdAt: '2026-01-05T10:00:00Z', status: 'active' }, // same second
  ]);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));
  assert.notEqual(labels[0], labels[1]);
});

test('buildNeedsSelection through-labeling: 两个 null display_name → 每个 candidate.label 非空且互异', () => {
  const res = buildNeedsSelection('gmail', 'a', [
    { id: 'c1', name: 'Gmail', displayName: null, status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: null, status: 'active' },
  ]);
  const [a, b] = res.candidates;
  assert.ok(a.label && b.label);
  assert.notEqual(a.label, b.label);
  assert.notEqual(a.label, a.connection_id);
  assert.notEqual(b.label, b.connection_id);
});

// --- P2 negative control: candidate label + position are order-invariant -----
//
// The reviewer's repro: the SAME set of same-app connections, fed in a different
// (server-incidental) order, must produce the SAME label for each connection id
// AND land each id at the SAME candidate position. Otherwise the "(1)/(2)"
// ordinal fallback and the candidates[] order tracked the input order, so the
// label the user just picked could map to a DIFFERENT account on retry.
//
// This test FAILS against the pre-fix index-based ordering (buildNeedsSelection
// used `candidates` as-is): reversing the input reverses positions and swaps the
// ordinals. It passes once candidates are sorted deterministically (created_at
// asc, id tiebreak) at the single assembly point.
test('buildNeedsSelection P2 负例：候选 label 与位置对输入顺序不变（乱序/反序结果一致）', () => {
  // Hard case: two nameless connections with MISSING createdAt (pure ordinal
  // path), two nameless with the SAME-SECOND createdAt (also ordinal path), plus
  // a named + a distinct-time one (the mix).
  const conns = [
    { id: 'c-eee', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-02-01T08:30:00Z', status: 'active' },
    { id: 'c-ccc', name: 'Gmail', displayName: null,       createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c-ddd', name: 'Gmail', displayName: '',         createdAt: '2026-01-05T10:00:00Z', status: 'active' }, // same second
    { id: 'c-aaa', name: 'Gmail', displayName: null,       status: 'active' },                                    // missing createdAt
    { id: 'c-bbb', name: 'Gmail', displayName: '',         status: 'active' },                                    // missing createdAt
  ];

  const mapsFor = (list) => {
    const res = buildNeedsSelection('gmail', 'gmail/send', list);
    const idToLabel = new Map();
    const idToPos = new Map();
    res.candidates.forEach((c, i) => {
      idToLabel.set(c.connection_id, c.label);
      idToPos.set(c.connection_id, i);
    });
    return { res, idToLabel, idToPos };
  };

  const forward = mapsFor(conns);
  const reversed = mapsFor(conns.slice().reverse());
  const shuffled = mapsFor([conns[3], conns[0], conns[4], conns[2], conns[1]]);

  // Sanity: the ordinal fallback is actually exercised (labels aren't all unique
  // display_names), and every label is non-empty and never the raw id.
  forward.res.candidates.forEach((c) => {
    assert.ok(c.label && c.label.trim().length > 0);
    assert.notEqual(c.label, c.connection_id);
  });
  assert.ok(forward.res.candidates.some((c) => /\(\d+\)$/.test(c.label))); // ordinal path hit

  for (const id of conns.map((c) => c.id)) {
    // (a) same id → same label regardless of input order
    assert.equal(reversed.idToLabel.get(id), forward.idToLabel.get(id), `label for ${id} must be order-invariant`);
    assert.equal(shuffled.idToLabel.get(id), forward.idToLabel.get(id), `label for ${id} must be order-invariant`);
    // (b) same id → same candidate position regardless of input order
    assert.equal(reversed.idToPos.get(id), forward.idToPos.get(id), `position for ${id} must be order-invariant`);
    assert.equal(shuffled.idToPos.get(id), forward.idToPos.get(id), `position for ${id} must be order-invariant`);
  }
});

// --- resolveInvokeEntry: three-branch (0 / 1 / >1) --------------------------

function deps({ index = {}, actives = () => [], any = () => null } = {}) {
  let refreshed = 0;
  return {
    refreshed: () => refreshed,
    findActives: (app) => actives(app),
    findAny: (app) => any(app),
    readEntryById: (id) => index[id] || null,
    refresh: async () => { refreshed += 1; },
  };
}

test('resolveInvokeEntry: 0 active 先刷新，仍 0 → fall back 到 any（null → 调用方 404）', async () => {
  const d = deps({ actives: () => [], any: () => null });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, null);
  assert.equal(d.refreshed(), 1); // refreshed once on empty
});

test('resolveInvokeEntry: 0 active 但有 needs_reauth → 返回该 entry（让调用方出重授权提示）', async () => {
  const reauth = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'needs_reauth' };
  const d = deps({ actives: () => [], any: () => reauth });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, reauth);
  assert.equal(out.needsSelection, undefined);
});

test('resolveInvokeEntry: 恰好 1 active（带 applicationId）→ 直接用，不刷新', async () => {
  const e = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'active' };
  const d = deps({ actives: () => [e] });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, e);
  assert.equal(out.needsSelection, undefined);
  assert.equal(d.refreshed(), 0);
});

test('resolveInvokeEntry: 1 active 但缺 applicationId → 刷新一次补全', async () => {
  const slugOnly = { id: 'c1', slug: 'gmail', applicationId: null, status: 'active' };
  const full = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'active' };
  let calls = 0;
  const d = deps({ actives: () => (calls++ === 0 ? [slugOnly] : [full]) });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry.applicationId, 'app-1');
  assert.equal(d.refreshed(), 1);
});

test('resolveInvokeEntry: >1 active → needs_selection（不静默取第一个）', async () => {
  const actives = [
    { id: 'c1', slug: 'gmail', applicationId: 'app-1', displayName: '工作邮箱', status: 'active' },
    { id: 'c2', slug: 'gmail', applicationId: 'app-1', displayName: '个人邮箱', status: 'active' },
  ];
  const d = deps({ actives: () => actives });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'gmail/send' }, d);
  assert.equal(out.entry, undefined);
  assert.equal(out.needsSelection.needs_selection, true);
  assert.equal(out.needsSelection.candidates.length, 2);
  assert.match(out.needsSelection.agent_instruction, /USER'S language/);
  // No hardcoded Chinese user-facing sentence in the instruction.
  assert.doesNotMatch(out.needsSelection.agent_instruction, /[一-鿿]/);
});

// --- resolveInvokeEntry: connectionId bypasses app-resolution ---------------

test('resolveInvokeEntry: 给 connectionId → 跳过 app 解析，直用该连接（不看 actives）', async () => {
  const chosen = { id: 'c2', slug: 'gmail', applicationId: 'app-1', displayName: '个人邮箱', status: 'active' };
  let activesCalled = 0;
  const d = deps({
    index: { c2: chosen },
    actives: () => { activesCalled++; return [{ id: 'c1' }, { id: 'c2' }]; },
  });
  const out = await resolveInvokeEntry({ connectionId: 'c2', action: 'a' }, d);
  assert.equal(out.entry, chosen);
  assert.equal(out.needsSelection, undefined);
  assert.equal(activesCalled, 0);   // resolution path never consulted
  assert.equal(d.refreshed(), 0);
});

test('resolveInvokeEntry: connectionId 本地未知 → 刷新一次后仍honored（构造最小 entry）', async () => {
  const store = {};
  let refreshedN = 0;
  const d = {
    findActives: () => { throw new Error('should not resolve by app'); },
    findAny: () => { throw new Error('should not resolve by app'); },
    readEntryById: (id) => store[id] || null,
    refresh: async () => { refreshedN += 1; },
  };
  const out = await resolveInvokeEntry({ connectionId: 'c-unknown', action: 'a' }, d);
  assert.equal(out.entry.id, 'c-unknown');
  assert.equal(out.entry.applicationId, null);
  assert.equal(refreshedN, 1);
});

// --- conn.invoke non-active guard (P1-2): rejected BEFORE credential work ----
//
// Exercised via subprocess (the guard lives in the conn.invoke handler). Each
// case must fail with the guard's actionable 409 error, NOT a
// network/credential error — proving the reject happens before credential
// resolution. COCO_AUTH_TOKEN short-circuits the JWT exchange; COCO_API_URL
// points at an unroutable port so any stray fetch would fail fast (and produce a
// DIFFERENT error the assertions would catch).

function setupHome({ orgId = 'org-1', connections = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  const connDir = path.join(compDir, 'runtime/connect');
  fs.mkdirSync(connDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { [orgId]: { enabled: true, org_id: orgId, self: { member_id: 'm-self' } } },
  }));
  fs.writeFileSync(path.join(connDir, `connections-index.${orgId}.json`), JSON.stringify({ connections }));
  return home;
}

function runConn(home, command, params, apiUrl = 'http://127.0.0.1:1') {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_AUTH_TOKEN: 'test-token', // skip JWT exchange
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('conn.invoke guard: explicit connectionId → needs_reauth 连接凭证解析前被拒（重授权提示）', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'needs_reauth' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /re-authorization|重新授权/);
});

test('conn.invoke guard: explicit connectionId → expired 连接被拒（通用可操作错误）', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'expired' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /not usable \(status: expired\)/);
});

test('conn.invoke guard: explicit connectionId → revoked 连接被拒', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'revoked' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /not usable \(status: revoked\)/);
});

test('conn.invoke guard (app path): list 返回 error+needs_reauth → 刷新规范化为 needs_reauth 并在凭证前被拒', async () => {
  const home = setupHome({ connections: {} }); // empty → forces a refresh from the list
  const server = createServer((req, res) => {
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // cws-connect can express reauth-required as status:"error" + needs_reauth:true.
      res.end(JSON.stringify({
        data: [{ id: 'c1', application_id: 'app-1', application_slug: 'gmail', application_name: 'Gmail', status: 'error', needs_reauth: true }],
        request_id: 'r1',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { app: 'gmail', action: 'gmail/send' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 409);
    assert.match(err.error, /re-authorization|重新授权/); // normalized to needs_reauth, guarded
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- conn.invoke routing by credential_mode (direct vs proxy/composio) -------
//
// conn.invoke routes on the connector taxonomy in the index (credential_mode):
//   - proxy (composio) → SERVER-SIDE execute: POST /connections/<id>/actions/
//     execute, WITHOUT acquiring a credential or fetching a local catalog (the
//     inverse of the old direct-only negative assertion).
//   - direct → LOCAL EGRESS: acquire the credential + fetch the local catalog +
//     assemble the request here (regression).
//   - legacy index lacking credential_mode → refresh from conn.list, re-read,
//     then route on the refreshed mode (never uses acquire to detect composio).
// Exercised via subprocess with a local server that records every path hit.

test('conn.invoke routing: a proxy (composio) connection → SERVER-SIDE execute (POST .../actions/execute), NEVER acquire/local-catalog', async () => {
  const home = setupHome({ connections: {
    // A composio connection: credential_source composio + credential_mode proxy.
    c1: { id: 'c1', applicationId: 'app-1', slug: 'notion', name: 'Notion', status: 'active', credentialMode: 'proxy', credentialSource: 'composio' },
  } });
  const seen = [];
  let executeBody = null;
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/connections/c1/actions/execute')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try { executeBody = JSON.parse(body); } catch { executeBody = body; }
        res.writeHead(200, { 'content-type': 'application/json' });
        // op execute-connect-action → { status_code, body }.
        res.end(JSON.stringify({ data: { status_code: 200, body: { ok: true, pages: [] } }, request_id: 'r1' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(
      home, 'conn.invoke',
      { connectionId: 'c1', action: 'notion/search', params: { q: 'roadmap' } },
      `http://127.0.0.1:${port}`,
    );
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    // The server passthrough { status_code, body } is returned as the result.
    const out = JSON.parse(stdout);
    assert.equal(out.status_code, 200);
    assert.deepEqual(out.body, { ok: true, pages: [] });
    // The execute endpoint was called with { action, params }.
    assert.ok(seen.some((u) => u.includes('/connect/connections/c1/actions/execute')), `proxy path must call server execute: ${JSON.stringify(seen)}`);
    assert.deepEqual(executeBody, { action: 'notion/search', params: { q: 'roadmap' } });
    // It must NOT acquire a credential and must NOT fetch a local catalog.
    assert.ok(!seen.some((u) => u.includes('/credential')), `composio must never acquire a credential: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => /\/connect\/applications\/[^/]+\/actions/.test(u)), `composio must never fetch a local catalog: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.invoke routing: a direct connection takes the DIRECT path (local egress), NOT server execute', async () => {
  // A direct credential routes into the DIRECT branch, which fetches the local
  // catalog (GET /connect/applications/<appId>/actions) to assemble the request.
  // The catalog-endpoint hit proves the direct path was taken; the proxy branch
  // would instead POST /connections/<id>/actions/execute (never reached). We
  // serve an empty catalog so it stops at "unknown action" — a direct-path
  // outcome, distinctly NOT the server-execute path.
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'active', credentialMode: 'direct', credentialSource: 'managed' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/connections/c1/credential')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { credential_mode: 'direct', access_token: 'tok' }, request_id: 'r1' }));
      return;
    }
    if (req.url.includes('/connect/applications/app-1/actions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    // The direct path's own downstream error — NOT server execute.
    assert.match(err.error, /unknown action|not in local catalog/);
    assert.doesNotMatch(err.error, /unsupported/i);
    // Direct path proof: the local catalog was fetched, and the server execute
    // endpoint was NEVER called.
    assert.ok(seen.some((u) => u.includes('/connect/applications/app-1/actions')), `direct path must fetch the local catalog: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => u.includes('/actions/execute')), `direct path must not call server execute: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.invoke routing (legacy index): entry lacks credential_mode → refresh from conn.list, then route proxy→server execute (no acquire-based detection)', async () => {
  // A legacy index entry with NO credentialMode. conn.invoke must refresh from
  // conn.list (which now returns credential_mode/credential_source), re-read the
  // entry, and route on the refreshed mode — WITHOUT ever calling acquire to
  // detect composio. Here the refresh reveals a composio connection → server
  // execute.
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'notion', name: 'Notion', status: 'active' }, // no credentialMode
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active', credential_mode: 'proxy', credential_source: 'composio' }],
        request_id: 'r1',
      }));
      return;
    }
    if (req.url.includes('/connect/connections/c1/actions/execute')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { status_code: 201, body: { done: true } }, request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'notion/search', params: {} }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    const out = JSON.parse(stdout);
    assert.equal(out.status_code, 201);
    // The refresh happened and the server-execute path was taken; acquire never was.
    assert.ok(seen.some((u) => u.includes('/connect/agents/me/connections')), `legacy path must refresh from conn.list: ${JSON.stringify(seen)}`);
    assert.ok(seen.some((u) => u.includes('/connect/connections/c1/actions/execute')), `must route to server execute after refresh: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => u.includes('/credential')), `must never acquire to detect composio: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.invoke routing (empty mode, self-heal fails): entry lacks credential_mode AND refresh does not fill it → UNSUPPORTED (never default-direct, no acquire)', async () => {
  // A stale/orphan index entry with NO credentialMode. conn.invoke refreshes once
  // from conn.list (self-heal) but the list STILL carries no credential_mode. The
  // post-refresh fallback must NOT default to 'direct' — it must surface the
  // explicit unsupported error path (the same one used for an unexpected mode) and
  // must never acquire a credential or call server execute.
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'notion', name: 'Notion', status: 'active' }, // no credentialMode
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // conn.list STILL lacks credential_mode (truly stale/orphan backend record).
      res.end(JSON.stringify({
        data: [{ id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active' }],
        request_id: 'r1',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'notion/search', params: {} }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /unsupported/i);
    // The self-heal refresh was attempted...
    assert.ok(seen.some((u) => u.includes('/connect/agents/me/connections')), `must refresh once before giving up: ${JSON.stringify(seen)}`);
    // ...but it must NOT default to direct: never acquire, never server-execute.
    assert.ok(!seen.some((u) => u.includes('/credential')), `empty-mode must never acquire a credential: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => u.includes('/actions/execute')), `empty-mode must never call server execute: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => /\/connect\/applications\/[^/]+\/actions/.test(u)), `empty-mode must never fetch a local catalog: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- conn.catalog: never persist a full catalog for a composio app ----------
//
// P2-1 regression (zylos0t): a LEGACY index entry that has an applicationId but
// lacks the connector taxonomy (credentialMode/credentialSource) must NOT be
// treated as non-composio on face value. conn.catalog must refresh from conn.list
// (which now returns the taxonomy) before deciding, and must NEVER writeCatalog
// for what turns out to be a composio (proxy) app.

test('conn.catalog (P2-1): legacy index (applicationId, no taxonomy) + conn.list reveals composio → refreshes AND does NOT persist a catalog', async () => {
  const home = setupHome({ connections: {
    // Legacy: applicationId present, but no credentialMode/credentialSource.
    c1: { id: 'c1', applicationId: 'app-1', slug: 'notion', name: 'Notion', status: 'active' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // conn.list now returns the taxonomy → this app is composio (proxy).
      res.end(JSON.stringify({
        data: [{ id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active', credential_mode: 'proxy', credential_source: 'composio' }],
        request_id: 'r1',
      }));
      return;
    }
    if (req.url.includes('/connect/applications/app-1/actions')) {
      // Fetch-through is allowed (returns the catalog to the caller); the point is
      // it must NOT be written to disk.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ toolkit: 'notion', action: 'notion/search', method: 'POST', input_schema: '{}' }], request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const catalogFile = path.join(home, 'zylos/components/openmax/runtime/connect/action-catalog/app-1.json');
  try {
    const { code, stdout } = await runConn(home, 'conn.catalog', { app: 'notion' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    // The legacy-taxonomy safeguard forced a conn.list refresh before deciding.
    assert.ok(seen.some((u) => u.includes('/connect/agents/me/connections')), `must refresh from conn.list to learn the taxonomy: ${JSON.stringify(seen)}`);
    // The negative control: a composio app must NEVER persist a full catalog.
    assert.ok(!fs.existsSync(catalogFile), `composio catalog must not be persisted: ${catalogFile}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.catalog (positive control): a known-direct app persists its catalog without a taxonomy refresh', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-2', slug: 'gmail', name: 'Gmail', status: 'active', credentialMode: 'direct', credentialSource: 'managed' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/applications/app-2/actions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ toolkit: 'gmail', action: 'gmail/send', method: 'POST', input_schema: '{}' }], request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const catalogFile = path.join(home, 'zylos/components/openmax/runtime/connect/action-catalog/app-2.json');
  try {
    const { code, stdout } = await runConn(home, 'conn.catalog', { app: 'gmail' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    // Taxonomy is already known (direct) → no conn.list refresh needed.
    assert.ok(!seen.some((u) => u.includes('/connect/agents/me/connections')), `known-direct must not need a taxonomy refresh: ${JSON.stringify(seen)}`);
    // Confidently non-composio → the catalog IS persisted.
    assert.ok(fs.existsSync(catalogFile), `direct app catalog must be persisted: ${catalogFile}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.catalog (proxy control): a known-proxy app (credentialMode only, no credentialSource) never persists AND needs no refresh', async () => {
  // isProxyEntry keys PURELY on credentialMode==='proxy' — credentialSource is
  // gone. A known-proxy entry is confidently proxy without any refresh, so
  // conn.catalog must NOT hit conn.list and must NOT write a local catalog.
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-3', slug: 'notion', name: 'Notion', status: 'active', credentialMode: 'proxy' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/applications/app-3/actions')) {
      // Fetch-through is allowed (returned to the caller) but must not be persisted.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ toolkit: 'notion', action: 'notion/search', method: 'POST', input_schema: '{}' }], request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const catalogFile = path.join(home, 'zylos/components/openmax/runtime/connect/action-catalog/app-3.json');
  try {
    const { code, stdout } = await runConn(home, 'conn.catalog', { app: 'notion' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    // Known-proxy from credentialMode alone → no taxonomy refresh needed.
    assert.ok(!seen.some((u) => u.includes('/connect/agents/me/connections')), `known-proxy must not need a taxonomy refresh: ${JSON.stringify(seen)}`);
    // Proxy → the catalog must NEVER be persisted.
    assert.ok(!fs.existsSync(catalogFile), `proxy catalog must not be persisted: ${catalogFile}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- conn.proxy / conn.execute: removed-verb tombstones ---------------------
//
// The two legacy verbs are removed. They must throw an explicit "unsupported/
// removed" error pointing to conn.invoke (which now handles BOTH direct and
// proxy/Composio) — never make a proxy/execute network call. COCO_API_URL
// defaults to an unroutable port, so a clean message also proves no network
// happened.

for (const command of ['conn.proxy', 'conn.execute']) {
  test(`${command} tombstone: removed → 400 unsupported/removed, points to conn.invoke`, async () => {
    const home = setupHome({ connections: {
      c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'active' },
    } });
    const { code, stderr } = await runConn(home, command, { connectionId: 'c1', action: 'toolkit/act', url: 'https://example.test' });
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /unsupported|deprecated|removed/i);
    assert.match(err.error, /conn\.invoke/);
  });
}

// ============================================================================
//  Custom-connector management: pure request planners
// ============================================================================
//
// planApp* / planActionDef* are pure (no network/config — only apiPath + isUuid),
// so required-param validation, method+path building, and the security invariant
// (org_id / oauth_callback_url never placed in the body) are unit-testable here.

const APP_UUID = '11111111-1111-1111-1111-111111111111';
const ACTION_UUID = '22222222-2222-2222-2222-222222222222';

// --- planAppCreate ----------------------------------------------------------

test('planAppCreate: 缺 display_name/provider_type → 400（slug 不再必填）', () => {
  assert.throws(() => planAppCreate({ slug: 'x', provider_type: 'api_key' }), (e) => e.status === 400 && /display_name/.test(e.message));
  assert.throws(() => planAppCreate({ slug: 'x', display_name: 'X' }), (e) => e.status === 400 && /provider_type/.test(e.message));
});

// #31: slug is server-generated when omitted — the CLI no longer force-requires
// it, and MUST NOT synthesize/force-send one. An explicit slug is still honored.
test('planAppCreate: slug 省略 → 不再报错，body 里也不出现 slug（服务端生成）', () => {
  const plan = planAppCreate({ display_name: 'Acme', provider_type: 'api_key' });
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, /\/connect\/applications$/);
  assert.equal(plan.body.slug, undefined); // never force-sent
  assert.equal(plan.body.display_name, 'Acme');
});

test('planAppCreate: 显式 slug 仍原样透传', () => {
  const plan = planAppCreate({ slug: 'acme', display_name: 'Acme', provider_type: 'oauth2' });
  assert.equal(plan.body.slug, 'acme');
});

test('planAppCreate: POST /connect/applications，body 走 allowlist 且不含 org_id/oauth_callback_url/credential_source/visibility', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    api_key_location: 'header', api_key_header_name: 'X-Api-Key',
    visibility: 'org', credential_source: 'custom', category: 'crm', tags: ['a', 'b'],
    // Forbidden / server-derived — must NOT appear in the body:
    org_id: 'evil-org', oauth_callback_url: 'https://evil/cb',
    // Unknown key — allowlist drops it too:
    bogus: 'nope',
  });
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, /\/connect\/applications$/);
  assert.equal(plan.body.slug, 'acme');
  assert.equal(plan.body.display_name, 'Acme');
  assert.equal(plan.body.provider_type, 'api_key');
  assert.equal(plan.body.api_key_header_name, 'X-Api-Key');
  assert.deepEqual(plan.body.tags, ['a', 'b']);
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.oauth_callback_url, undefined);
  assert.equal(plan.body.bogus, undefined);
  // credential_source / visibility are now server-FORCED (custom/org) and rejected
  // (422) if sent — the allowlist must drop them just like org_id/oauth_callback_url.
  assert.equal(plan.body.credential_source, undefined);
  assert.equal(plan.body.visibility, undefined);
});

// credential_source / visibility / credential_mode are NOT create fields:
// cws-core forces them server-side (custom / org / direct) and now REJECTS (422)
// any of them in the request body, so the CLI must never forward them on create —
// even if the caller passes one. Applies to BOTH custom and managed callers, and
// to the import path (runAppImport builds its app body via planAppCreate).

test('planAppCreate: caller-sent credential_source/visibility/credential_mode → 全部不落 body（服务端强制 custom/org/direct）', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    credential_source: 'custom', visibility: 'org', credential_mode: 'proxy', // all dropped
  });
  assert.equal(plan.body.credential_source, undefined);
  assert.equal(plan.body.visibility, undefined);
  assert.equal(plan.body.credential_mode, undefined);
});

test('planAppCreate: 无这些字段 → 依旧不出现在 body', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
  });
  assert.equal(plan.body.credential_source, undefined);
  assert.equal(plan.body.visibility, undefined);
  assert.equal(plan.body.credential_mode, undefined);
});

test('planAppCreate: 即使 caller 传 managed 也不转发（create 路径一律不接受这三个字段）', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    credential_source: 'managed', visibility: 'public', credential_mode: 'direct',
  });
  assert.equal(plan.body.credential_source, undefined);
  assert.equal(plan.body.visibility, undefined);
  assert.equal(plan.body.credential_mode, undefined);
});

test('runAppImport: app body 不转发 credential_source/visibility/credential_mode（走 planAppCreate allowlist）', async () => {
  const appBodies = [];
  await runAppImport(
    {
      application: {
        slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
        credential_source: 'custom', visibility: 'org', credential_mode: 'proxy',
      },
      actions: [],
    },
    {
      createApp: async (body) => { appBodies.push(body); return { id: APP_UUID }; },
      createActionDef: async () => ({ id: 'a' }),
    },
  );
  // server forces custom/org/direct on create; none of them may be sent.
  assert.equal(appBodies[0].credential_source, undefined);
  assert.equal(appBodies[0].visibility, undefined);
  assert.equal(appBodies[0].credential_mode, undefined);
});

// --- planAppUpdate ----------------------------------------------------------

test('planAppUpdate: 缺 applicationId / 非 UUID → 400', () => {
  assert.throws(() => planAppUpdate({ display_name: 'X' }), (e) => e.status === 400 && /applicationId is required/.test(e.message));
  assert.throws(() => planAppUpdate({ applicationId: 'not-a-uuid', display_name: 'X' }), (e) => e.status === 400 && /UUID/.test(e.message));
});

test('planAppUpdate: 无可更新字段 → 400', () => {
  assert.throws(() => planAppUpdate({ applicationId: APP_UUID }), (e) => e.status === 400 && /no updatable fields/.test(e.message));
});

test('planAppUpdate: PATCH，忽略 slug/provider_type/org_id/oauth_callback_url/credential_source/visibility/credential_mode', () => {
  const plan = planAppUpdate({
    applicationId: APP_UUID, display_name: 'New', category: 'ops', is_enabled: false,
    slug: 'changed', provider_type: 'oauth2', org_id: 'evil', oauth_callback_url: 'https://evil/cb',
    // server-forced (custom/org/direct) and rejected (422) if sent — must be dropped:
    credential_source: 'custom', visibility: 'org', credential_mode: 'direct',
  });
  assert.equal(plan.method, 'PATCH');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}$`));
  assert.equal(plan.body.display_name, 'New');
  assert.equal(plan.body.category, 'ops');
  assert.equal(plan.body.is_enabled, false);
  assert.equal(plan.body.slug, undefined);
  assert.equal(plan.body.provider_type, undefined);
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.oauth_callback_url, undefined);
  assert.equal(plan.body.credential_source, undefined);
  assert.equal(plan.body.visibility, undefined);
  assert.equal(plan.body.credential_mode, undefined);
});

// --- OAuth field forwarding (create + update) -------------------------------
//
// #31: cws-core now stores the full OAuth field set end-to-end, so the CLI must
// forward oauth_client_id / oauth_client_secret / oauth_scopes_default and the
// authorize/token URLs verbatim. Two write semantics are asserted here:
//   - a BLANK oauth_client_secret is DROPPED ("keep the stored one") — a blank
//     secret can never clear a previously-set secret;
//   - a NON-empty secret is forwarded (set/rotate), and an explicit empty
//     oauth_scopes_default:[] is PRESERVED (clears the default scopes).

test('planAppCreate: OAuth 字段全部透传（client_id/secret/scopes/urls）', () => {
  const plan = planAppCreate({
    display_name: 'Acme', provider_type: 'oauth2',
    oauth_authorize_url: 'https://p.test/authorize', oauth_token_url: 'https://p.test/token',
    oauth_client_id: 'cid-123', oauth_client_secret: 's3cr3t',
    oauth_scopes_default: ['read', 'write'], oauth_pkce: true,
    oauth_token_auth_method: 'basic', oauth_token_body_format: 'form',
  });
  assert.equal(plan.body.oauth_client_id, 'cid-123');
  assert.equal(plan.body.oauth_client_secret, 's3cr3t');
  assert.deepEqual(plan.body.oauth_scopes_default, ['read', 'write']);
  assert.equal(plan.body.oauth_authorize_url, 'https://p.test/authorize');
  assert.equal(plan.body.oauth_token_url, 'https://p.test/token');
  assert.equal(plan.body.oauth_pkce, true);
  assert.equal(plan.body.oauth_token_auth_method, 'basic');
  assert.equal(plan.body.oauth_token_body_format, 'form');
});

test('planAppCreate: 空 oauth_client_secret 被丢弃（不下发空串）', () => {
  const plan = planAppCreate({
    display_name: 'Acme', provider_type: 'oauth2',
    oauth_client_id: 'cid-123', oauth_client_secret: '   ',
  });
  assert.equal(plan.body.oauth_client_id, 'cid-123');
  assert.equal('oauth_client_secret' in plan.body, false);
});

test('planAppUpdate: OAuth 字段全部透传，非空 secret 下发', () => {
  const plan = planAppUpdate({
    applicationId: APP_UUID,
    oauth_client_id: 'cid-new', oauth_client_secret: 'rotated',
    oauth_scopes_default: ['read'],
    oauth_authorize_url: 'https://p.test/a', oauth_token_url: 'https://p.test/t',
  });
  assert.equal(plan.method, 'PATCH');
  assert.equal(plan.body.oauth_client_id, 'cid-new');
  assert.equal(plan.body.oauth_client_secret, 'rotated');
  assert.deepEqual(plan.body.oauth_scopes_default, ['read']);
  assert.equal(plan.body.oauth_authorize_url, 'https://p.test/a');
  assert.equal(plan.body.oauth_token_url, 'https://p.test/t');
});

test('planAppUpdate: 空 secret 被丢弃但其它字段照常更新（blank = 保持不变，绝不清空）', () => {
  const plan = planAppUpdate({
    applicationId: APP_UUID, display_name: 'Renamed',
    oauth_client_id: 'cid-2', oauth_client_secret: '',
  });
  assert.equal(plan.body.display_name, 'Renamed');
  assert.equal(plan.body.oauth_client_id, 'cid-2');
  assert.equal('oauth_client_secret' in plan.body, false);
});

test('planAppUpdate: 仅传空 secret → 视为无可更新字段 400（不会下发空串清空）', () => {
  assert.throws(
    () => planAppUpdate({ applicationId: APP_UUID, oauth_client_secret: '   ' }),
    (e) => e.status === 400 && /no updatable fields/.test(e.message),
  );
});

test('planAppUpdate: 显式空 oauth_scopes_default:[] 透传（清空默认 scopes，与 secret 语义相反）', () => {
  const plan = planAppUpdate({ applicationId: APP_UUID, oauth_scopes_default: [] });
  assert.deepEqual(plan.body.oauth_scopes_default, []);
});

// --- planActionDefList ------------------------------------------------------

test('planActionDefList: GET .../action-defs；缺/非 UUID applicationId → 400', () => {
  assert.throws(() => planActionDefList({}), (e) => e.status === 400);
  assert.throws(() => planActionDefList({ applicationId: 'x' }), (e) => e.status === 400 && /UUID/.test(e.message));
  const plan = planActionDefList({ applicationId: APP_UUID });
  assert.equal(plan.method, 'GET');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs$`));
});

// --- planActionDefCreate ----------------------------------------------------

test('planActionDefCreate: 缺 name/method/url_template → 400', () => {
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, method: 'GET', url_template: 'u' }), (e) => e.status === 400 && /name/.test(e.message));
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', url_template: 'u' }), (e) => e.status === 400 && /method/.test(e.message));
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', method: 'GET' }), (e) => e.status === 400 && /url_template/.test(e.message));
});

test('planActionDefCreate: POST .../action-defs，body allowlist（含 description/headers/encoding/input_schema）', () => {
  const plan = planActionDefCreate({
    applicationId: APP_UUID,
    name: 'repos/list', description: 'List repositories', method: 'GET', url_template: '{base_url}/repos',
    headers: { 'X-Trace': '1' }, encoding: 'form',
    input_schema: '{"type":"object","properties":{},"additionalProperties":false}',
    org_id: 'evil', bogus: 'nope',
  });
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs$`));
  assert.equal(plan.body.name, 'repos/list');
  assert.equal(plan.body.description, 'List repositories');
  assert.equal(plan.body.method, 'GET');
  assert.equal(plan.body.url_template, '{base_url}/repos');
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
  assert.equal(plan.body.encoding, 'form');
  assert.ok(plan.body.input_schema.includes('additionalProperties'));
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.bogus, undefined);
});

// #31: description is REQUIRED and non-empty on create/import. Missing, empty,
// or whitespace-only all reject locally (400) before any network call.
test('planActionDefCreate: 缺/空/空白 description → 400（非空必填）', () => {
  const baseline = { applicationId: APP_UUID, name: 't/a', method: 'GET', url_template: 'u' };
  assert.throws(() => planActionDefCreate(baseline), (e) => e.status === 400 && /description is required/.test(e.message));
  assert.throws(() => planActionDefCreate({ ...baseline, description: '' }), (e) => e.status === 400 && /description is required/.test(e.message));
  assert.throws(() => planActionDefCreate({ ...baseline, description: '   ' }), (e) => e.status === 400 && /description is required/.test(e.message));
  // A non-empty description makes it valid.
  const plan = planActionDefCreate({ ...baseline, description: 'does a thing' });
  assert.equal(plan.body.description, 'does a thing');
});

test('planActionDefCreate: headers.Authorization 禁止（大小写不敏感）→ 400', () => {
  // A valid description is supplied so the reject is isolated to the Authorization
  // header (the forbidden-header check runs after the required-field checks).
  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
    assert.throws(
      () => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', description: 'd', method: 'GET', url_template: 'u', headers: { [key]: 'Bearer x' } }),
      (e) => e.status === 400 && /headers\.Authorization is forbidden/.test(e.message),
      `expected rejection for header key ${key}`,
    );
  }
  // A benign header alongside is irrelevant — the Authorization key still trips.
  assert.throws(
    () => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', description: 'd', method: 'GET', url_template: 'u', headers: { 'X-Trace': '1', authorization: 'Bearer x' } }),
    (e) => e.status === 400 && /Authorization is forbidden/.test(e.message),
  );
  // Non-Authorization headers pass through untouched.
  const plan = planActionDefCreate({ applicationId: APP_UUID, name: 't/a', description: 'd', method: 'GET', url_template: 'u', headers: { 'X-Trace': '1' } });
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
});

// --- planActionDefUpdate ----------------------------------------------------

test('planActionDefUpdate: 缺/非 UUID actionId → 400；无字段 → 400', () => {
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, method: 'GET' }), (e) => e.status === 400 && /actionId is required/.test(e.message));
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, actionId: 'x', method: 'GET' }), (e) => e.status === 400 && /UUID/.test(e.message));
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID }), (e) => e.status === 400 && /no updatable fields/.test(e.message));
});

test('planActionDefUpdate: PATCH .../action-defs/{action_id}', () => {
  const plan = planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, method: 'POST', encoding: '' });
  assert.equal(plan.method, 'PATCH');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs/${ACTION_UUID}$`));
  assert.equal(plan.body.method, 'POST');
  assert.equal(plan.body.encoding, '');
});

test('planActionDefUpdate: headers.Authorization 禁止（大小写不敏感）→ 400', () => {
  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION']) {
    assert.throws(
      () => planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, headers: { [key]: 'Bearer x' } }),
      (e) => e.status === 400 && /headers\.Authorization is forbidden/.test(e.message),
      `expected rejection for header key ${key}`,
    );
  }
  // headers alone (non-Authorization) is a valid updatable field.
  const plan = planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, headers: { 'X-Trace': '1' } });
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
});

// --- planActionDefDelete ----------------------------------------------------

test('planActionDefDelete: DELETE .../action-defs/{action_id}；两个 id 都需 UUID', () => {
  assert.throws(() => planActionDefDelete({ applicationId: APP_UUID }), (e) => e.status === 400 && /actionId/.test(e.message));
  const plan = planActionDefDelete({ applicationId: APP_UUID, actionId: ACTION_UUID });
  assert.equal(plan.method, 'DELETE');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs/${ACTION_UUID}$`));
});

// ============================================================================
//  runAppImport: injectable bulk create (app + loop action-defs)
// ============================================================================

test('runAppImport: 缺 application 对象 → 400（无网络）', async () => {
  await assert.rejects(
    () => runAppImport({ actions: [] }, { createApp: async () => { throw new Error('should not call'); }, createActionDef: async () => {} }),
    (e) => e.status === 400 && /application object is required/.test(e.message),
  );
});

test('runAppImport: app body 无效（缺 display_name，slug 现可省）→ 400 且不发起任何创建', async () => {
  let createAppCalls = 0;
  // slug is now optional, so the invalid-app guard trips on a STILL-required
  // field (display_name) instead — validated up-front before any network call.
  await assert.rejects(
    () => runAppImport(
      { application: { provider_type: 'api_key' }, actions: [] },
      { createApp: async () => { createAppCalls += 1; return { id: APP_UUID }; }, createActionDef: async () => {} },
    ),
    (e) => e.status === 400 && /display_name/.test(e.message),
  );
  assert.equal(createAppCalls, 0);
});

test('runAppImport: 成功创建 app 再逐个创建 action-def；org_id/oauth_callback_url 不落入任何 body', async () => {
  const appBodies = [];
  const actionBodies = [];
  const out = await runAppImport(
    {
      application: {
        slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
        org_id: 'evil', oauth_callback_url: 'https://evil/cb',
      },
      actions: [
        { name: 'repos/list', description: 'List repos', method: 'GET', url_template: '{base_url}/repos', org_id: 'evil' },
        { name: 'repos/get', description: 'Get one repo', method: 'GET', url_template: '{base_url}/repos/{id}' },
      ],
    },
    {
      createApp: async (body) => { appBodies.push(body); return { id: APP_UUID, slug: body.slug }; },
      createActionDef: async (appId, body) => { actionBodies.push({ appId, body }); return { id: `${ACTION_UUID}-${actionBodies.length}` }; },
    },
  );
  assert.equal(out.applicationId, APP_UUID);
  assert.equal(out.actions_total, 2);
  assert.equal(out.actions_created, 2);
  assert.equal(out.actions_failed, 0);
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.ok === true));
  // app body scrubbed
  assert.equal(appBodies[0].org_id, undefined);
  assert.equal(appBodies[0].oauth_callback_url, undefined);
  assert.equal(appBodies[0].slug, 'acme');
  // every action-def created under the returned application id, org_id scrubbed
  assert.ok(actionBodies.every((a) => a.appId === APP_UUID));
  assert.equal(actionBodies[0].body.org_id, undefined);
  assert.equal(actionBodies[0].body.name, 'repos/list');
});

test('runAppImport: 某个 action-def 失败 → 部分成功报告（不中断其余）', async () => {
  const out = await runAppImport(
    {
      application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' },
      actions: [
        { name: 'ok/one', description: 'a', method: 'GET', url_template: '{base_url}/a' },
        { name: 'bad/two', description: 'b', method: 'GET' }, // missing url_template → local 400, never sent
        { name: 'ok/three', description: 'c', method: 'GET', url_template: '{base_url}/c' },
      ],
    },
    {
      createApp: async () => ({ id: APP_UUID }),
      createActionDef: async (_appId, body) => {
        if (body.name === 'ok/three') { const e = new Error('boom'); e.status = 500; throw e; }
        return { id: 'a-ok' };
      },
    },
  );
  assert.equal(out.actions_total, 3);
  assert.equal(out.actions_created, 1);
  assert.equal(out.actions_failed, 2);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].status, 400); // local validation failure (url_template)
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].status, 500); // server failure surfaced
});

test('runAppImport: action-def 带 Authorization 头 → 本地拒绝为该 action 的失败（不创建该行）', async () => {
  const actionBodies = [];
  const out = await runAppImport(
    {
      application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' },
      actions: [
        { name: 'ok/one', description: 'a', method: 'GET', url_template: '{base_url}/a' },
        { name: 'bad/auth', description: 'b', method: 'GET', url_template: '{base_url}/b', headers: { Authorization: 'Bearer leaked' } },
        { name: 'bad/auth-lower', description: 'c', method: 'GET', url_template: '{base_url}/c', headers: { authorization: 'Bearer leaked' } },
      ],
    },
    {
      createApp: async () => ({ id: APP_UUID }),
      createActionDef: async (_appId, body) => { actionBodies.push(body); return { id: 'a-ok' }; },
    },
  );
  assert.equal(out.actions_total, 3);
  assert.equal(out.actions_created, 1);
  assert.equal(out.actions_failed, 2);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].status, 400);
  assert.match(out.results[1].error, /Authorization is forbidden/);
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].status, 400);
  // The offending rows were never sent to createActionDef — only the clean one.
  assert.equal(actionBodies.length, 1);
  assert.equal(actionBodies[0].name, 'ok/one');
});

test('runAppImport: app 创建未返回 id → 502', async () => {
  await assert.rejects(
    () => runAppImport(
      { application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' }, actions: [] },
      { createApp: async () => ({}), createActionDef: async () => {} },
    ),
    (e) => e.status === 502,
  );
});

// ============================================================================
//  conn.app_create end-to-end (subprocess): server captures method/path/body
// ============================================================================
//
// Strongest proof that org_id / oauth_callback_url never reach the wire body:
// run the real CLI against a local server and inspect the received request.

test('conn.app_create (subprocess): POST /connect/applications；服务端收到的 body 不含 org_id/oauth_callback_url', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const seen = {};
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.includes('/connect/applications')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        try { seen.body = JSON.parse(body); } catch { seen.body = body; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: APP_UUID, slug: 'acme', source: 'custom' }, request_id: 'r1' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.app_create', {
      slug: 'acme', display_name: 'Acme', provider_type: 'api_key', category: 'crm',
      // `org` selects the operating org; `org_id`/`oauth_callback_url` are
      // forbidden body fields the allowlist must drop.
      org: 'org-1', org_id: 'evil-org', oauth_callback_url: 'https://evil/cb',
    }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'POST');
    assert.match(seen.url, /\/connect\/applications$/);
    assert.equal(seen.body.slug, 'acme');
    assert.equal(seen.body.category, 'crm');
    assert.equal(seen.body.org_id, undefined);
    assert.equal(seen.body.oauth_callback_url, undefined);
    assert.equal(seen.body.org, undefined);
    // The returned application item is echoed as the result.
    const out = JSON.parse(stdout);
    assert.equal(out.id, APP_UUID);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ============================================================================
//  conn.app_list end-to-end (subprocess): GET the org's applications
// ============================================================================
//
// conn.app_list enumerates the org's custom connector applications
// (GET /api/v1/connect/applications) WITHOUT needing an existing connection.
// It is org-scoped (org derived server-side from the principal), so the request
// must carry NO org_id — neither in the path nor the query. `category` is
// appended as ?category=<encoded> when provided and omitted otherwise. The D8
// envelope's `data` is an ARRAY of application items, unwrapped by the client.

test('conn.app_list (subprocess): GET /connect/applications，无 org_id，无 category 时无查询串，返回 data 数组', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const seen = {};
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/connect/applications')) {
      seen.method = req.method;
      seen.url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: APP_UUID, slug: 'acme', provider_type: 'api_key', source: 'custom' },
        ],
        request_id: 'r1',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // `org` only selects the operating org's token; `org_id` is a forbidden
    // param the handler must never place on the wire.
    const { code, stdout } = await runConn(home, 'conn.app_list', { org: 'org-1', org_id: 'evil-org' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'GET');
    // Path is exactly /connect/applications — no query string at all when no category.
    assert.match(seen.url, /\/api\/v1\/connect\/applications$/);
    assert.doesNotMatch(seen.url, /\?/);
    // org_id must not leak into the URL (path or query).
    assert.doesNotMatch(seen.url, /org_id/);
    assert.doesNotMatch(seen.url, /evil-org/);
    // The D8 array is unwrapped to the command result.
    const out = JSON.parse(stdout);
    assert.ok(Array.isArray(out));
    assert.equal(out[0].id, APP_UUID);
    assert.equal(out[0].slug, 'acme');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.app_list (subprocess): 传 category → 作为 ?category=<encoded> 查询串附加，仍无 org_id', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const seen = {};
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/connect/applications')) {
      seen.method = req.method;
      seen.url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // A category needing URL-encoding proves the value is encoded, not raw.
    const { code, stdout } = await runConn(home, 'conn.app_list', { org: 'org-1', category: 'crm tools' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'GET');
    assert.match(seen.url, /\/connect\/applications\?category=crm(%20|\+)tools$/);
    assert.doesNotMatch(seen.url, /org_id/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ============================================================================
//  conn.callback end-to-end (subprocess): GET the platform OAuth callback URL
// ============================================================================
//
// conn.callback hits the read-only, authed-but-NOT-org-scoped endpoint
// GET /api/v1/connect/oauth-callback-url and returns the D8-unwrapped
// { callback_url } object. Prove the exact request method+path and that the
// client unwraps the envelope down to the inner data object.

test('conn.callback (subprocess): GET /connect/oauth-callback-url，返回 unwrap 后的 { callback_url }', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const seen = {};
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/connect/oauth-callback-url')) {
      seen.method = req.method;
      seen.url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { callback_url: 'https://platform.test/oauth/callback' }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.callback', { org: 'org-1' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'GET');
    assert.match(seen.url, /\/api\/v1\/connect\/oauth-callback-url$/);
    // The D8 envelope is unwrapped by the client → the command result is the
    // inner data object.
    const out = JSON.parse(stdout);
    assert.equal(out.callback_url, 'https://platform.test/oauth/callback');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ============================================================================
//  OAuth-field forwarding + Authorization non-forwarding (subprocess, wire-level)
// ============================================================================
//
// #31 regression, proven at the wire (the strongest form — the real CLI process
// against a local server that captures the received request):
//   1. The full OAuth field set forwards correctly on conn.app_create and
//      conn.app_update.
//   2. A BLANK oauth_client_secret is never placed on the wire on update — a
//      blank secret must never overwrite/clear a stored one.
//   3. The CLI never forwards a caller-supplied action-def `Authorization`
//      header — conn.actiondef_create rejects it LOCALLY (400) and NO request
//      ever reaches cws-core (the header can't leak into a stored row).

// Small helper: a server that records the first captured {method,url,body}.
function bodyCaptureServer(match, respond) {
  const seen = {};
  const server = createServer((req, res) => {
    if (match(req)) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.authorization = req.headers.authorization;
        try { seen.body = JSON.parse(body); } catch { seen.body = body; }
        respond(res);
      });
      return;
    }
    seen.strayUrls = seen.strayUrls || [];
    seen.strayUrls.push(req.url);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  return { seen, server };
}

test('conn.app_create (subprocess): OAuth 字段整套下发到 wire body（client_id/secret/scopes/urls），org_id 不泄漏', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const { seen, server } = bodyCaptureServer(
    (req) => req.method === 'POST' && req.url.includes('/connect/applications'),
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: APP_UUID, slug: 'acme' }, request_id: 'r1' }));
    },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.app_create', {
      org: 'org-1', display_name: 'Acme', provider_type: 'oauth2',
      oauth_authorize_url: 'https://p.test/authorize', oauth_token_url: 'https://p.test/token',
      oauth_client_id: 'cid-123', oauth_client_secret: 's3cr3t',
      oauth_scopes_default: ['read', 'write'],
      org_id: 'evil-org',
    }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.body.oauth_client_id, 'cid-123');
    assert.equal(seen.body.oauth_client_secret, 's3cr3t');
    assert.deepEqual(seen.body.oauth_scopes_default, ['read', 'write']);
    assert.equal(seen.body.oauth_authorize_url, 'https://p.test/authorize');
    assert.equal(seen.body.oauth_token_url, 'https://p.test/token');
    assert.equal(seen.body.org_id, undefined);
    // slug omitted by the caller → never force-sent (server generates it).
    assert.equal(seen.body.slug, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.app_update (subprocess): OAuth 字段下发；空 secret 绝不上 wire（blank = 保持不变）', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const { seen, server } = bodyCaptureServer(
    (req) => req.method === 'PATCH' && req.url.includes(`/connect/applications/${APP_UUID}`),
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: APP_UUID }, request_id: 'r1' }));
    },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.app_update', {
      org: 'org-1', applicationId: APP_UUID,
      display_name: 'Acme CRM',
      oauth_client_id: 'cid-new', oauth_client_secret: '', // blank → dropped
      oauth_scopes_default: ['read'],
    }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'PATCH');
    assert.equal(seen.body.display_name, 'Acme CRM');
    assert.equal(seen.body.oauth_client_id, 'cid-new');
    assert.deepEqual(seen.body.oauth_scopes_default, ['read']);
    // The blank secret must NOT appear on the wire — it can never clear a stored one.
    assert.equal('oauth_client_secret' in seen.body, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.actiondef_create (subprocess): 调用方 Authorization 头本地拒绝，绝不转发到 cws-core（无任何请求上 wire）', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { id: ACTION_UUID }, request_id: 'r1' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.actiondef_create', {
      org: 'org-1', applicationId: APP_UUID,
      name: 'repos/list', description: 'List repos', method: 'GET', url_template: '{base_url}/repos',
      headers: { Authorization: 'Bearer leaked-caller-token' },
    }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /headers\.Authorization is forbidden/);
    // The critical guarantee: the caller's Authorization header never reaches
    // cws-core — the reject is local, so NO action-def request hit the server.
    assert.equal(hits.length, 0, `no request should reach cws-core, saw: ${JSON.stringify(hits)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// =============================================================================
// OPENM-915: the connector toggle is a PREFERENCE, never a gate.
// =============================================================================
//
// conn.list / conn.invoke / conn.check never require a conversation id and never
// consult a per-conversation enabled set: Lark, scheduled tasks and automations
// have no OpenMax conversation and must keep working. conn.auth_notice needs a
// conversation id only as the place to post the card.

const CONV = '019f0000-aaaa-7bbb-8ccc-0000000000c1';
const connMod = () => import('./conn.js');

const AGENT_CONNECTIONS = [
  { id: 'c-gm1', application_slug: 'gmail', application_name: 'Gmail', display_name: '工作邮箱', status: 'active', credential_mode: 'proxy' },
  { id: 'c-gm2', application_slug: 'gmail', application_name: 'Gmail', display_name: '个人邮箱', status: 'active', credential_mode: 'proxy' },
  { id: 'c-no1', application_slug: 'notion', application_name: 'Notion', status: 'error', needs_reauth: true, credential_mode: 'proxy' },
  { id: 'c-sl1', application_slug: 'slack', application_name: 'Slack', status: 'expired', credential_mode: 'proxy' },
];

async function withServer(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (handler(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r9"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function serveConnections(req, res, list = AGENT_CONNECTIONS) {
  if (req.method === 'GET' && req.url.startsWith('/api/v1/connect/agents/me/connections')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: list, request_id: 'r0' }));
    return true;
  }
  return false;
}

// --- regression: no conversation id needed ----------------------------------

test('conn.list (OPENM-915): no conversationId → full authorized list, no per-conversation lookup', async () => {
  const home = setupHome({ connections: {} });
  await withServer((req, res) => serveConnections(req, res), async (url, seen) => {
    const { code, stdout, stderr } = await runConn(home, 'conn.list', {}, url);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).map((c) => c.id), ['c-gm1', 'c-gm2', 'c-no1', 'c-sl1']);
    assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
  });
});

test('conn.list (OPENM-915): a conversationId, if passed, filters nothing', async () => {
  const home = setupHome({ connections: {} });
  await withServer((req, res) => serveConnections(req, res), async (url, seen) => {
    const { code, stdout, stderr } = await runConn(home, 'conn.list', { conversationId: CONV }, url);
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).length, 4);
    assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
  });
});

function serveExecute(req, res, bodies) {
  if (req.method === 'POST' && /\/connect\/connections\/[^/]+\/actions\/execute$/.test(req.url)) {
    let buf = '';
    req.on('data', (d) => { buf += d; });
    req.on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(buf) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { status_code: 200, body: { ok: true } }, request_id: 'r1' }));
    });
    return true;
  }
  return false;
}

test('conn.invoke (OPENM-915): app path with NO conversationId runs (Lark / automation have no OpenMax conversation)', async () => {
  const home = setupHome({ connections: {} });
  const bodies = [];
  const list = [AGENT_CONNECTIONS[0], AGENT_CONNECTIONS[2]];
  await withServer((req, res) => serveConnections(req, res, list) || serveExecute(req, res, bodies), async (url, seen) => {
    const { code, stdout, stderr } = await runConn(home, 'conn.invoke', { app: 'gmail', action: 'gmail/messages-list', params: { q: 'is:unread' } }, url);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).body, { ok: true });
    assert.deepEqual(bodies.map((b) => b.url), ['/api/v1/connect/connections/c-gm1/actions/execute']);
    assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
  });
});

test('conn.invoke (OPENM-915): a conversationId, if passed, is not a gate (no enabled-set lookup)', async () => {
  // org-scope: the only conversation-dependent check left is the personal-
  // connector group guard (OPENM-815, tests at the bottom), which org
  // connectors skip — so no conversation request of any kind is made here.
  const home = setupHome({ connections: {
    'c-gm2': { id: 'c-gm2', applicationId: 'app-g', slug: 'gmail', name: 'Gmail', displayName: '个人邮箱', status: 'active', credentialMode: 'proxy', ownerScope: 'org' },
  } });
  const bodies = [];
  await withServer((req, res) => serveExecute(req, res, bodies), async (url, seen) => {
    const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c-gm2', action: 'gmail/messages-list', params: {}, conversationId: CONV }, url);
    assert.equal(code, 0, stderr);
    assert.equal(bodies.length, 1);
    assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
  });
});

test('buildNeedsSelection retry_hint (OPENM-915): does not ask for a conversationId', () => {
  const res = buildNeedsSelection('gmail', 'gmail/messages-list', [
    { id: 'c-gm1', displayName: '工作邮箱', status: 'active' },
    { id: 'c-gm2', displayName: '个人邮箱', status: 'active' },
  ]);
  assert.doesNotMatch(res.retry_hint, /conversation/i);
});

// --- conn.check: authorized / not_authorized / needs_reauth -----------------

async function runCheck(params, list = AGENT_CONNECTIONS) {
  const home = setupHome({ connections: {} });
  return withServer((req, res) => serveConnections(req, res, list), async (url, seen) => ({
    ...(await runConn(home, 'conn.check', params, url)), seen,
  }));
}

test('conn.check: two active Gmail connections → authorized with both ids, NO conversationId needed', async () => {
  const { code, stdout, stderr, seen } = await runCheck({ app: 'gmail' });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { app: 'gmail', app_name: 'Gmail', state: 'authorized', connection_ids: ['c-gm1', 'c-gm2'] });
  assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
});

test('conn.check: matched by app name, case-insensitive; a conversationId is accepted but ignored', async () => {
  const { code, stdout, stderr, seen } = await runCheck({ app: 'GMAIL', conversationId: CONV });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).state, 'authorized');
  assert.ok(!seen.some((u) => u.includes('/conversations/')), JSON.stringify(seen));
});

test('conn.check: no connection for the app → not_authorized', async () => {
  const { code, stdout } = await runCheck({ app: 'jira' });
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout), { app: 'jira', app_name: null, state: 'not_authorized', connection_ids: [] });
});

test('conn.check: only an error+needs_reauth (or expired) connection → needs_reauth', async () => {
  for (const app of ['notion', 'Slack']) {
    const { code, stdout } = await runCheck({ app });
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).state, 'needs_reauth', app);
  }
});

test('conn.check: one active + one needs_reauth of the same app → authorized with only the active id', async () => {
  const list = [
    { id: 'c-n1', application_slug: 'notion', application_name: 'Notion', status: 'error', needs_reauth: true },
    { id: 'c-n2', application_slug: 'notion', application_name: 'Notion', status: 'active' },
  ];
  const { code, stdout } = await runCheck({ app: 'notion' }, list);
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout).connection_ids, ['c-n2']);
  assert.equal(JSON.parse(stdout).state, 'authorized');
});

test('conn.check: missing app → 400, no request', async () => {
  const { code, stderr, seen } = await runCheck({});
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).status, 400);
  assert.deepEqual(seen, []);
});

// --- conn.auth_notice: structured "go authorize" card ------------------------
//
// The card must parse with cws-fe's parseConnectorAuthNotice
// (apps/web/src/lib/connector-auth-notice.ts). This is a faithful JS port of
// that parser, so a shape drift on the agent side fails here.
function feParseConnectorAuthNotice(message) {
  if (message.type !== 'AGENT_STRUCTURED' || message.sender_type !== 'AGENT') return null;
  const asRecord = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const contentBody = asRecord(message.content?.body) || {};
  const body = contentBody.schema === 'prototype.connector-auth-notice.v1'
    ? contentBody
    : asRecord(asRecord(message.metadata)?.connector_auth_notice);
  if (!body || body.schema !== 'prototype.connector-auth-notice.v1') return null;
  if (!Array.isArray(body.connector_names)) return null;
  const connectorNames = body.connector_names.filter((n) => typeof n === 'string' && n.trim() !== '');
  if (connectorNames.length === 0) return null;
  const slugs = Array.isArray(body.connector_slugs) ? body.connector_slugs : [];
  const connectorSlugs = connectorNames.map((_, i) => (typeof slugs[i] === 'string' && slugs[i].trim() !== '' ? slugs[i] : null));
  return { connectorNames, connectorSlugs };
}

test('buildConnectorAuthNoticeMessage: exact FE schema + structured shape + metadata copy + Chinese fallback', async () => {
  const { CONNECTOR_AUTH_NOTICE_SCHEMA, buildConnectorAuthNoticeMessage } = await connMod();
  assert.equal(CONNECTOR_AUTH_NOTICE_SCHEMA, 'prototype.connector-auth-notice.v1');
  const m = buildConnectorAuthNoticeMessage([{ name: 'Notion', slug: 'notion' }, { name: 'Jira Cloud', slug: 'jira' }, { name: 'Google Drive', slug: 'googledrive' }]);
  assert.equal(m.type, 'AGENT_STRUCTURED');
  assert.match(m.client_msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(m.content.content_type, 'connector_auth_notice');
  assert.deepEqual(m.content.attachments, []);
  assert.deepEqual(m.content.body, {
    schema: 'prototype.connector-auth-notice.v1',
    connector_names: ['Notion', 'Jira Cloud', 'Google Drive'],
    connector_slugs: ['notion', 'jira', 'googledrive'],
  });
  assert.deepEqual(m.metadata.connector_auth_notice, m.content.body);
  assert.notEqual(m.metadata.connector_auth_notice, m.content.body, 'metadata is a copy, not the same object');
  assert.match(m.fallback_text, /Notion、Jira Cloud、Google Drive/);
  assert.match(m.fallback_text, /\/connections/);
  assert.match(m.fallback_text, /授权/);
  // Preference model: no "turn it on in the conversation" step after authorizing.
  assert.doesNotMatch(m.fallback_text, /not_authorized|403|conversation|打开|启用/);
});

test('buildConnectorAuthNoticeMessage: FE parser reads it from content AND from metadata only (list hot path)', async () => {
  const { buildConnectorAuthNoticeMessage } = await connMod();
  const m = buildConnectorAuthNoticeMessage([{ name: 'Notion', slug: 'notion' }, { name: 'Google Drive', slug: 'googledrive' }]);
  const expected = { connectorNames: ['Notion', 'Google Drive'], connectorSlugs: ['notion', 'googledrive'] };
  assert.deepEqual(feParseConnectorAuthNotice({ ...m, sender_type: 'AGENT' }), expected);
  assert.deepEqual(feParseConnectorAuthNotice({ ...m, sender_type: 'AGENT', content: { content_type: m.content.content_type } }), expected);
});

test('buildConnectorAuthNoticeMessage: rejects empty list and entries without name/slug', async () => {
  const { buildConnectorAuthNoticeMessage } = await connMod();
  assert.throws(() => buildConnectorAuthNoticeMessage([]), /at least one/);
  assert.throws(() => buildConnectorAuthNoticeMessage([{ name: 'Notion' }]), /name and slug/);
  assert.throws(() => buildConnectorAuthNoticeMessage([{ name: ' ', slug: 'notion' }]), /name and slug/);
});

test('parseAuthNoticeApps: string or list, trimmed, case-insensitive de-dup, bounded', async () => {
  const { parseAuthNoticeApps } = await connMod();
  assert.deepEqual(parseAuthNoticeApps({ apps: 'notion' }), ['notion']);
  assert.deepEqual(parseAuthNoticeApps({ apps: [' notion ', 'NOTION', 'jira'] }), ['notion', 'jira']);
  assert.throws(() => parseAuthNoticeApps({}), /apps/);
  assert.throws(() => parseAuthNoticeApps({ apps: [] }), /apps/);
  assert.throws(() => parseAuthNoticeApps({ apps: [''] }), /non-empty/);
  assert.throws(() => parseAuthNoticeApps({ apps: Array.from({ length: 11 }, (_, i) => `a${i}`) }), /at most/);
});

const CATALOG_APPS = [
  { id: '0190a000-0000-7000-8000-00000000000a', slug: 'notion', display_name: 'Notion' },
  { id: '0190a000-0000-7000-8000-00000000000b', slug: 'jira', display_name: 'Jira Cloud' },
  { id: '0190a000-0000-7000-8000-00000000000c', slug: 'googledrive', display_name: 'Google Drive' },
];

// In-process fake with the producer's search semantics (substring over
// display_name / slug only, never id) and an exact id read.
function fakeCatalog(apps, { wrap = false } = {}) {
  const calls = [];
  return {
    calls,
    getApplication: async (id) => {
      calls.push(`get ${id}`);
      const a = apps.find((x) => x.id === id);
      if (!a) throw Object.assign(new Error('application not found'), { status: 404 });
      return a;
    },
    listApplicationsPage: async (q, cursor) => {
      calls.push(`list ${q} ${cursor || '-'}`);
      const rows = apps.filter((x) => [x.slug, x.display_name].some((v) => (v || '').toLowerCase().includes(q.toLowerCase())));
      const from = cursor ? Number(cursor) : 0;
      const data = rows.slice(from, from + 100);
      const next = from + 100 < rows.length ? String(from + 100) : '';
      return wrap ? { data, next_cursor: next } : data;
    },
  };
}

test('resolveAuthNoticeConnectors: slug/name/id → index-aligned {name, slug} in request order', async () => {
  const { resolveAuthNoticeConnectors } = await connMod();
  const cat = fakeCatalog(CATALOG_APPS);
  const out = await resolveAuthNoticeConnectors(['jira', 'google drive', CATALOG_APPS[0].id], cat);
  assert.deepEqual(out, [
    { name: 'Jira Cloud', slug: 'jira' },
    { name: 'Google Drive', slug: 'googledrive' },
    { name: 'Notion', slug: 'notion' },
  ]);
  assert.deepEqual(cat.calls, ['list jira -', 'list google drive -', `get ${CATALOG_APPS[0].id}`]);
  const out2 = await resolveAuthNoticeConnectors(['notion', 'Notion'], fakeCatalog(CATALOG_APPS, { wrap: true }));
  assert.deepEqual(out2, [{ name: 'Notion', slug: 'notion' }]);
});

test('resolveAuthNoticeConnectors: unknown or only-fuzzy-matching app → 404 unknown_connector (no dead-link card)', async () => {
  const { resolveAuthNoticeConnectors } = await connMod();
  await assert.rejects(resolveAuthNoticeConnectors(['confluence'], fakeCatalog(CATALOG_APPS)),
    (e) => e.status === 404 && e.code === 'unknown_connector');
  await assert.rejects(resolveAuthNoticeConnectors(['not'], fakeCatalog(CATALOG_APPS)),
    (e) => e.code === 'unknown_connector');
  await assert.rejects(resolveAuthNoticeConnectors(['x'], fakeCatalog([{ id: 'i', display_name: 'x' }])),
    (e) => e.code === 'unknown_connector', 'a catalog hit without a slug is not linkable');
  const disabled = [{ ...CATALOG_APPS[0], is_enabled: false }];
  await assert.rejects(resolveAuthNoticeConnectors([disabled[0].id], fakeCatalog(disabled)),
    (e) => e.code === 'unknown_connector', 'a disabled app is not in the /connections catalog');
});

test('resolveAuthNoticeConnectors: a non-404 id-read error propagates (an outage is not "unknown")', async () => {
  const { resolveAuthNoticeConnectors } = await connMod();
  const cat = { ...fakeCatalog(CATALOG_APPS), getApplication: async () => { throw Object.assign(new Error('boom'), { status: 503 }); } };
  await assert.rejects(resolveAuthNoticeConnectors([CATALOG_APPS[0].id], cat), (e) => e.status === 503);
});

// Producer simulation of the catalog endpoints conn.auth_notice reads, matching
// the real contract rather than "return everything". GET
// /api/v1/connect/applications?query&… is cws-core list-connect-applications
// (connect.go), whose `query` is a case-insensitive SUBSTRING match on
// display_name / slug / category only — never id — in both modes:
//   - numbered mode (page / page_size present; page_size 1..100, else 400) →
//     cws-connect ListApplicationsOffsetPaged: ordered by the caller's
//     connection-state bucket (connected custom, connected managed, unconnected
//     custom, unconnected managed) then sort_order, display_name, id;
//     OFFSET/LIMIT, no next_cursor.
//   - cursor mode (otherwise; limit 1..100, else 400; backend default 50) →
//     ListApplicationsPaged: plain (sort_order, display_name, id) order, keyset
//     `> cursor tuple`, fetch limit+1, next_cursor = opaque base64url JSON of
//     the last row's tuple (application_repo.go encodeAppCursor), omitted on
//     the last page.
// State is read per request, so a test can mutate it between pages
// (`onList(n)` runs after the n-th list response).
// GET /api/v1/connect/applications/{id} — exact id read (GetApplication), 404
// when absent.
function catalogProducer(apps, { onList } = {}) {
  const bucket = (a) => (a.connected ? 0 : 2) + (a.credential_source === 'custom' ? 0 : 1);
  const cmpStr = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const cmpKey = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || cmpStr(a.display_name, b.display_name) || cmpStr(a.id, b.id);
  let lists = 0;
  return (req, res) => {
    if (req.method !== 'GET') return false;
    const u = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
    if (u.pathname === '/api/v1/connect/applications') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      const matching = apps
        .filter((a) => a.is_enabled !== false)
        .filter((a) => !q || [a.display_name, a.slug, a.category].some((v) => (v || '').toLowerCase().includes(q)));
      let body;
      if (u.searchParams.has('page') || u.searchParams.has('page_size')) {
        const page = Number(u.searchParams.get('page') ?? '1');
        const size = Number(u.searchParams.get('page_size') ?? '20');
        if (!(size >= 1 && size <= 100)) return send(400, { error: { detail: 'page_size must be an integer between 1 and 100' }, request_id: 'r-l' });
        const rows = matching.sort((a, b) => bucket(a) - bucket(b) || cmpKey(a, b));
        body = { data: rows.slice((page - 1) * size, page * size), total_count: rows.length, total_pages: Math.ceil(rows.length / size), request_id: 'r-l' };
      } else {
        const limit = Number(u.searchParams.get('limit') ?? '50');
        if (!(limit >= 1 && limit <= 100)) return send(400, { error: { detail: 'limit must be between 1 and 100' }, request_id: 'r-l' });
        let rows = matching.sort(cmpKey);
        const cur = u.searchParams.get('cursor');
        if (cur) {
          const k = JSON.parse(Buffer.from(cur, 'base64url').toString());
          const after = { sort_order: k.s, display_name: k.d, id: k.i };
          rows = rows.filter((a) => cmpKey(a, after) > 0);
        }
        const pageRows = rows.slice(0, limit);
        const last = pageRows[pageRows.length - 1];
        body = { data: pageRows, total_count: matching.length, request_id: 'r-l' };
        if (rows.length > limit) {
          body.next_cursor = Buffer.from(JSON.stringify({ s: last.sort_order ?? 0, d: last.display_name, i: last.id })).toString('base64url');
        }
      }
      send(200, body);
      lists += 1;
      if (onList) onList(lists);
      return true;
    }
    const m = u.pathname.match(/^\/api\/v1\/connect\/applications\/([^/]+)$/);
    if (m) {
      const a = apps.find((x) => x.id === decodeURIComponent(m[1]));
      return a ? send(200, { data: a, request_id: 'r-g' }) : send(404, { error: { detail: 'application not found' }, request_id: 'r-g' });
    }
    return false;
  };
}

async function runAuthNotice(params, catalog = CATALOG_APPS, producerOpts) {
  const home = setupHome({ connections: {} });
  const posted = [];
  const serveCatalog = catalogProducer(catalog, producerOpts);
  return withServer((req, res) => {
    if (serveCatalog(req, res)) return true;
    if (req.method === 'POST' && req.url === `/api/v1/conversations/${CONV}/messages`) {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        posted.push(JSON.parse(buf));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'msg-1' }, request_id: 'r-p' }));
      });
      return true;
    }
    return false;
  }, async (url, seen) => ({ ...(await runConn(home, 'conn.auth_notice', params, url)), seen, posted }));
}

test('conn.auth_notice: resolves from the catalog and posts the card to the given conversation', async () => {
  const { code, stdout, stderr, posted } = await runAuthNotice({ conversationId: CONV, apps: ['notion', 'Jira Cloud', 'googledrive'] });
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'sent');
  assert.equal(out.conversation_id, CONV);
  assert.deepEqual(out.connectors, [{ name: 'Notion', slug: 'notion' }, { name: 'Jira Cloud', slug: 'jira' }, { name: 'Google Drive', slug: 'googledrive' }]);
  assert.equal(posted.length, 1);
  assert.deepEqual(feParseConnectorAuthNotice({ ...posted[0], sender_type: 'AGENT' }),
    { connectorNames: ['Notion', 'Jira Cloud', 'Google Drive'], connectorSlugs: ['notion', 'jira', 'googledrive'] });
});

test('conn.auth_notice: unknown app → 404 unknown_connector and NOTHING is posted', async () => {
  const { code, stderr, posted } = await runAuthNotice({ conversationId: CONV, apps: ['notion', 'confluence'] });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'unknown_connector');
  assert.equal(posted.length, 0);
});

// Regressions for the producer/consumer mismatch: the catalog search never
// matches on id, and an exact slug can rank behind more than one page of
// substring matches (here `mail`'s higher sort_order puts it after all 150
// "Mail Merge Tool" rows in the catalog order).
const ACME_ID = '0190aaaa-bbbb-7ccc-8ddd-000000000001';
const MAIL_NOISE = Array.from({ length: 150 }, (_, i) => ({
  id: `0190bbbb-0000-7000-8000-${String(i).padStart(12, '0')}`,
  slug: `mail-merge-tool-${i}`, display_name: `Mail Merge Tool ${String(i).padStart(3, '0')}`,
  credential_source: 'custom', category: 'productivity',
}));
const BIG_CATALOG = [
  ...MAIL_NOISE,
  { id: '0190cccc-0000-7000-8000-000000000001', slug: 'mail', display_name: 'Mail', credential_source: 'managed', category: 'email', sort_order: 10 },
  { id: ACME_ID, slug: 'acme-crm', display_name: 'Acme CRM', credential_source: 'managed', category: 'crm' },
];
const appPages = (seen) => seen.filter((u) => u.startsWith('GET /api/v1/connect/applications?'));

test('conn.auth_notice: an application id resolves by exact id read (the catalog search never matches id)', async () => {
  const { code, stdout, stderr, posted, seen } = await runAuthNotice({ conversationId: CONV, apps: [ACME_ID] }, BIG_CATALOG);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).connectors, [{ name: 'Acme CRM', slug: 'acme-crm' }]);
  assert.equal(posted.length, 1);
  assert.ok(seen.includes(`GET /api/v1/connect/applications/${ACME_ID}`), JSON.stringify(seen));
});

test('conn.auth_notice: an exact slug ranked behind a full page of substring matches is still found (pages until exhausted)', async () => {
  const { code, stdout, stderr, posted, seen } = await runAuthNotice({ conversationId: CONV, apps: ['mail'] }, BIG_CATALOG);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).connectors, [{ name: 'Mail', slug: 'mail' }]);
  assert.equal(posted.length, 1);
  assert.ok(appPages(seen).length >= 2, JSON.stringify(seen));
});

test('conn.auth_notice: genuinely absent app (after paging every substring match, or an unknown id) → 404 unknown_connector, nothing posted', async () => {
  for (const app of ['Mail Merge Tool', '0190dddd-0000-7000-8000-00000000dead']) {
    const { code, stderr, posted, seen } = await runAuthNotice({ conversationId: CONV, apps: [app] }, BIG_CATALOG);
    assert.equal(code, 1, app);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 404, app);
    assert.equal(err.code, 'unknown_connector', app);
    assert.equal(posted.length, 0, app);
    if (app === 'Mail Merge Tool') assert.equal(appPages(seen).length, 2, 'both pages of the 150 substring matches were read');
  }
});

// The catalog ordering changes mid-walk. Numbered mode orders by the caller's
// connection-state bucket before OFFSET, so a row that moves back across the
// page boundary between two requests makes OFFSET skip the next row: a false
// 404 although `mail` stayed enabled and visible throughout. The keyset cursor
// walk is immune — its order has no connection-state bucket, and it resumes
// after the last row's (sort_order, display_name, id) tuple, not a row count.
//   - connection revoked: 99 unconnected custom "mail…" apps, the managed
//     target `mail`, and a CONNECTED managed "Mail Archive". Numbered: Mail
//     Archive ranks first, `mail` is row 101 (page 2, OFFSET 100); revoking
//     Mail Archive after page 1 moves `mail` to row 100 → skipped.
//   - page-1 app disabled: 100 custom apps ranked before `mail` in BOTH orders
//     (so the cursor walk also needs page 2); disabling one already returned on
//     page 1 moves `mail` from row 101 to row 100 → skipped by OFFSET.
test('conn.auth_notice: catalog ordering changing between pages (connection revoked / page-1 app disabled) does not skip the exact match', async () => {
  const mail = { id: '0190cccc-0000-7000-8000-000000000001', slug: 'mail', display_name: 'Mail', credential_source: 'managed', category: 'email' };
  const cases = [
    {
      label: 'connection revoked',
      catalog: [
        ...MAIL_NOISE.slice(0, 99).map((a) => ({ ...a })),
        { ...mail },
        { id: '0190cccc-0000-7000-8000-000000000002', slug: 'mail-archive', display_name: 'Mail Archive', credential_source: 'managed', category: 'email', connected: true },
      ],
      mutate: (cat) => { cat.find((a) => a.slug === 'mail-archive').connected = false; },
      pages: 1,
    },
    {
      label: 'page-1 app disabled',
      catalog: [
        ...Array.from({ length: 100 }, (_, i) => ({
          id: `0190dddd-0000-7000-8000-${String(i).padStart(12, '0')}`,
          slug: `ai-mail-${i}`, display_name: `Ai Mail ${String(i).padStart(3, '0')}`, credential_source: 'custom', category: 'email',
        })),
        { ...mail },
      ],
      mutate: (cat) => { cat.find((a) => a.slug === 'ai-mail-0').is_enabled = false; },
      pages: 2,
    },
  ];
  for (const { label, catalog, mutate, pages } of cases) {
    const { code, stdout, stderr, posted, seen } = await runAuthNotice({ conversationId: CONV, apps: ['mail'] }, catalog, {
      onList: (n) => { if (n === 1) mutate(catalog); },
    });
    assert.equal(code, 0, `${label}: ${stderr}`);
    assert.deepEqual(JSON.parse(stdout).connectors, [{ name: 'Mail', slug: 'mail' }], label);
    assert.equal(posted.length, 1, label);
    assert.equal(appPages(seen).length, pages, `${label}: ${JSON.stringify(seen)}`);
    assert.ok(appPages(seen).every((u) => !/[?&]page(_size)?=/.test(u)), `${label}: never numbered mode`);
  }
});

test('conn.auth_notice: page bound hit without a match → catalog_lookup_incomplete (not unknown_connector), nothing posted', async () => {
  const huge = Array.from({ length: 2100 }, (_, i) => ({
    id: `0190eeee-0000-7000-8000-${String(i).padStart(12, '0')}`, slug: `zz-${i}`, display_name: `ZZ ${String(i).padStart(4, '0')}`, credential_source: 'managed',
  }));
  const { code, stderr, posted, seen } = await runAuthNotice({ conversationId: CONV, apps: ['zz'] }, huge);
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.code, 'catalog_lookup_incomplete');
  assert.equal(posted.length, 0);
  assert.equal(appPages(seen).length, 20);
});

test('conn.auth_notice: missing / malformed target conversationId → 400 before any request', async () => {
  for (const params of [{ apps: ['notion'] }, { conversationId: '../x', apps: ['notion'] }]) {
    const { code, stderr, seen } = await runAuthNotice(params);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /conversationId/);
    assert.deepEqual(seen, []);
  }
});

// =============================================================================
// Personal connector must not execute in a group conversation (OPENM-815).
//
// A personal-scope connector is the owner's own credential. When conn.invoke is
// given a conversationId, it reads that conversation's TYPE from the server
// (GET /conversations/{id} — never an agent-supplied "is group" flag) and
// refuses a non-org connector anywhere that is not a confirmed DM. cws-core
// returns the type as an upper-case enum (DM / GROUP / STRAT / BROADCAST /
// BRIDGE). A reply inside a DM is a message in that DM (same conversation id,
// message parent_id), so it reads as DM. A STRAT conversation (the renamed
// THREAD type) is resolved to its parent conversation's type through parent_id
// (cws-comm Conversation.parent_id); without a parent it stays blocked.
// =============================================================================

function convFetcher(convs, calls = []) {
  return async (id) => {
    calls.push(id);
    if (!(id in convs)) throw Object.assign(new Error('not found'), { status: 404 });
    return convs[id];
  };
}

test('resolveGuardConversationType：DM / GROUP 直接取 type（小写化）', async () => {
  const fetch = convFetcher({ d1: { id: 'd1', type: 'DM' }, g1: { id: 'g1', type: 'GROUP' } });
  assert.equal(await resolveGuardConversationType('d1', fetch), 'dm');
  assert.equal(await resolveGuardConversationType('g1', fetch), 'group');
});

test('resolveGuardConversationType：DM 里的话题（STRAT + parent_id 指向 DM）→ 按父会话 dm', async () => {
  const calls = [];
  const fetch = convFetcher({
    d1: { id: 'd1', type: 'DM' },
    t1: { id: 't1', type: 'STRAT', parent_id: 'd1' },
  }, calls);
  assert.equal(await resolveGuardConversationType('t1', fetch), 'dm');
  assert.deepEqual(calls, ['t1', 'd1']);
});

test('resolveGuardConversationType：群里的话题（STRAT + parent_id 指向 GROUP）→ group', async () => {
  const fetch = convFetcher({
    g1: { id: 'g1', type: 'GROUP' },
    t1: { id: 't1', type: 'STRAT', parent_id: 'g1' },
  });
  assert.equal(await resolveGuardConversationType('t1', fetch), 'group');
});

test('resolveGuardConversationType：reply-via 端点串只取首段会话 id（DM 里的话题回复）', async () => {
  const calls = [];
  const fetch = convFetcher({ d1: { id: 'd1', type: 'DM' } }, calls);
  assert.equal(await resolveGuardConversationType('d1|thread:t9|parent:m7', fetch), 'dm');
  assert.equal(await resolveGuardConversationType('[OPENMAX THREAD]/d1|thread:t9', fetch), 'dm');
  assert.deepEqual(calls, ['d1', 'd1']);
});

test('resolveGuardConversationType：无法确认 → null（fail-closed）', async () => {
  const fetch = convFetcher({
    t1: { id: 't1', type: 'STRAT' },                          // 话题无 parent_id
    t2: { id: 't2', type: 'STRAT', parent_id: 't2' },         // 自环
    t3: { id: 't3', type: 'STRAT', parent_id: 't4' },         // 父会话还是话题 → 只跟一跳
    t4: { id: 't4', type: 'STRAT', parent_id: 'd1' },
    t5: { id: 't5', type: 'STRAT', parent_id: 'gone' },       // 父会话查不到
    d1: { id: 'd1', type: 'DM' },
    x1: { id: 'x1' },                                         // 无 type
  });
  for (const id of ['t1', 't2', 't3', 't5', 'x1', 'missing', '', '../etc', 'a/b']) {
    assert.equal(await resolveGuardConversationType(id, fetch), null, `id=${id}`);
  }
  assert.equal(await resolveGuardConversationType(undefined, fetch), null);
});

// Subprocess harness: a local server answering GET /conversations/<id> from
// `convs` and the proxy execute route; records every URL it sees.
async function withGuardServer(convs, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const m = /\/conversations\/([^/?]+)$/.exec(req.url.split('?')[0]);
    if (m && convs[decodeURIComponent(m[1])]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: convs[decodeURIComponent(m[1])], request_id: 'r1' }));
      return;
    }
    if (/\/connect\/connections\/[^/]+\/actions\/execute/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { status_code: 200, body: { ok: true } }, request_id: 'r2' }));
      return;
    }
    res.writeHead(m ? 500 : 404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// proxy entries so the allowed path is a single server-side execute (no local
// catalog / credential needed).
function guardHome(ownerScope) {
  return setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'notion', name: 'Notion', status: 'active', credentialMode: 'proxy', credentialSource: 'composio', ownerScope },
  } });
}

const GUARD_CONVS = {
  'conv-dm': { id: 'conv-dm', type: 'DM' },
  'conv-group': { id: 'conv-group', type: 'GROUP' },
  'thread-in-dm': { id: 'thread-in-dm', type: 'STRAT', parent_id: 'conv-dm' },
  'thread-in-group': { id: 'thread-in-group', type: 'STRAT', parent_id: 'conv-group' },
};

async function invokeIn(home, conversationId) {
  return withGuardServer(GUARD_CONVS, async (url, seen) => {
    const r = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'notion/search', params: {}, conversationId }, url);
    return { ...r, seen };
  });
}

function assertBlocked({ code, stderr, seen }, convId) {
  assert.equal(code, 1, `expected blocked, stderr=${stderr}`);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'personal_connector_in_group');
  assert.match(err.error, /personal connector and cannot be used in a group conversation/);
  assert.doesNotMatch(err.error, /[\u4e00-\u9fff]/, 'no hard-coded user-facing language: the Agent words it in the user\'s language');
  assert.ok(seen.some((u) => u.includes(`/conversations/${convId}`)), 'conversation type was read from the server');
  assert.ok(!seen.some((u) => u.includes('/actions/execute')), 'no execute request may be made when blocked');
}

function assertProceeded({ code, stdout, stderr, seen }) {
  assert.equal(code, 0, `expected success, stdout=${stdout} stderr=${stderr}`);
  assert.ok(seen.some((u) => u.includes('/actions/execute')), 'proceeded to execute');
}

test('conn.invoke 群聊闸：personal + GROUP → 403，execute 之前拦下', async () => {
  assertBlocked(await invokeIn(guardHome('personal'), 'conv-group'), 'conv-group');
});

test('conn.invoke 群聊闸：personal + DM → 放行到 execute', async () => {
  assertProceeded(await invokeIn(guardHome('personal'), 'conv-dm'));
});

test('conn.invoke 群聊闸：personal + DM 里的话题（STRAT→父 DM）→ 放行', async () => {
  assertProceeded(await invokeIn(guardHome('personal'), 'thread-in-dm'));
});

test('conn.invoke 群聊闸：personal + DM 里的话题回复（reply-via 端点串）→ 放行', async () => {
  assertProceeded(await invokeIn(guardHome('personal'), 'conv-dm|thread:t9|parent:m7'));
});

test('conn.invoke 群聊闸：personal + 群里的话题（STRAT→父 GROUP）→ 403', async () => {
  assertBlocked(await invokeIn(guardHome('personal'), 'thread-in-group'), 'thread-in-group');
});

test('conn.invoke 群聊闸：org 连接器在群聊 → 放行（不查会话）', async () => {
  const r = await invokeIn(guardHome('org'), 'conv-group');
  assertProceeded(r);
  assert.ok(!r.seen.some((u) => u.includes('/conversations/')), 'org connectors never look up the conversation');
});

test('conn.invoke 群聊闸：会话查询失败 → 403（fail-closed）', async () => {
  assertBlocked(await invokeIn(guardHome('personal'), 'conv-unknown'), 'conv-unknown');
});

test('conn.invoke 群聊闸：不带 conversationId → 不查会话，照常执行（Lark / 定时任务 / 自动化）', async () => {
  const r = await withGuardServer(GUARD_CONVS, async (url, seen) => ({
    ...(await runConn(guardHome('personal'), 'conn.invoke', { connectionId: 'c1', action: 'notion/search', params: {} }, url)), seen,
  }));
  assertProceeded(r);
  assert.ok(!r.seen.some((u) => u.includes('/conversations/')));
});

test('conn.invoke 群聊闸：ownerScope 未知 → 先刷新一次索引，刷到 personal 后在群聊被拒', async () => {
  const home = guardHome(null);
  const convs = { ...GUARD_CONVS };
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'c1', application_id: 'app-1', application_slug: 'notion', status: 'active', credential_mode: 'proxy', owner_scope: 'personal' }], request_id: 'r3' }));
      return;
    }
    const m = /\/conversations\/([^/?]+)$/.exec(req.url.split('?')[0]);
    if (m && convs[m[1]]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: convs[m[1]], request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'notion/search', params: {}, conversationId: 'conv-group' }, `http://127.0.0.1:${port}`);
    assertBlocked({ ...r, seen }, 'conv-group');
    assert.ok(seen.some((u) => u.includes('/connect/agents/me/connections')), 'unknown scope triggered one index refresh');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('docs pin (OPENM-815): SKILL.md + conn-operations.md tell the Agent to pass conversationId and keep personal connectors out of groups', () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const skill = read('../../SKILL.md');
  assert.match(skill, /In an OpenMax conversation, also pass `conversationId`/);
  assert.match(skill, /\*\*Personal connectors are for direct messages only\.\*\*/);
  const ops = read('../../references/conn-operations.md');
  assert.match(ops, /### Personal connectors — direct messages only/);
  assert.match(ops, /always pass `conversationId` on `conn\.invoke`/);
  assert.match(ops, /personal_connector_in_group/);
});

// --- Action discovery paging + conn.actions_search --------------------------

test('buildPageQuery: 无 cursor/limit → 空 query（向后兼容，不带 query string）', () => {
  assert.deepEqual(buildPageQuery({}), {});
  assert.deepEqual(buildPageQuery({ cursor: '', limit: '' }), {});
  assert.deepEqual(buildPageQuery({ cursor: null, limit: null }), {});
});

test('buildPageQuery: 只带给出的参数；limit 转整数；cursor 原样', () => {
  assert.deepEqual(buildPageQuery({ cursor: 'opaque==' }), { cursor: 'opaque==' });
  assert.deepEqual(buildPageQuery({ limit: 20 }), { limit: 20 });
  assert.deepEqual(buildPageQuery({ limit: '5', cursor: 'c' }), { cursor: 'c', limit: 5 });
});

test('buildPageQuery: 非法 limit / cursor → 400', () => {
  for (const limit of [0, -1, 1.5, 'abc']) {
    assert.throws(() => buildPageQuery({ limit }), (e) => e.status === 400 && /limit/.test(e.message));
  }
  assert.throws(() => buildPageQuery({ cursor: 42 }), (e) => e.status === 400 && /cursor/.test(e.message));
});

test('planConnActions / planAppActions: 路径不变，缺 id → 400', () => {
  const a = planConnActions({ connectionId: 'c1' });
  assert.match(a.path, /\/connect\/connections\/c1\/actions$/);
  assert.deepEqual(a.query, {});
  assert.deepEqual(planConnActions({ connection_id: 'c1', cursor: 'x', limit: 10 }).query, { cursor: 'x', limit: 10 });
  assert.throws(() => planConnActions({}), (e) => e.status === 400 && /connectionId is required/.test(e.message));

  const b = planAppActions({ applicationId: 'app-1' });
  assert.match(b.path, /\/connect\/applications\/app-1\/actions$/);
  assert.deepEqual(b.query, {});
  assert.throws(() => planAppActions({}), (e) => e.status === 400 && /applicationId is required/.test(e.message));
});

test('planActionsSearch: applicationId 必填；query/cursor/limit 仅在给出时带上', () => {
  assert.throws(() => planActionsSearch({ query: 'report' }), (e) => e.status === 400 && /applicationId is required/.test(e.message));
  assert.throws(() => planActionsSearch({ applicationId: 'app-1', query: 7 }), (e) => e.status === 400 && /query/.test(e.message));
  assert.throws(() => planActionsSearch({ applicationId: 'app-1', limit: 0 }), (e) => e.status === 400);
  const bare = planActionsSearch({ application_id: 'app-1' });
  assert.match(bare.path, /\/connect\/applications\/app-1\/actions:search$/);
  assert.deepEqual(bare.query, {});
  assert.deepEqual(
    planActionsSearch({ applicationId: 'app-1', query: 'report', cursor: 'n1', limit: 20 }).query,
    { query: 'report', cursor: 'n1', limit: 20 },
  );
});

test('withNextCursor: 无 next_cursor → 原样数组；有 → {actions, next_cursor} 原样透传', () => {
  const arr = [{ action: 'a/b' }];
  assert.equal(withNextCursor(arr, undefined), arr);
  assert.equal(withNextCursor(arr, ''), arr);
  assert.equal(withNextCursor(arr, null), arr);
  assert.deepEqual(withNextCursor(arr, 'opaque/+=='), { actions: arr, next_cursor: 'opaque/+==' });
});

// Subprocess: verify the exact wire URL and the agent-facing output shape.
async function withActionsServer(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const body = handler(req);
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body || { error: { detail: 'unexpected' }, request_id: 'r0' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const PAGE = [{ toolkit: 't', action: 't/list', method: 'GET', description: 'd', params: [], input_schema: '' }];

for (const c of [
  { command: 'conn.actions', params: { connectionId: 'c1' }, path: '/connect/connections/c1/actions' },
  { command: 'conn.app_actions', params: { applicationId: 'app-1' }, path: '/connect/applications/app-1/actions' },
]) {
  test(`${c.command} (subprocess): 无参 → 请求与旧版完全一致（无 query string），旧后端无 next_cursor → 原样数组`, async () => {
    const home = setupHome();
    await withActionsServer(() => ({ data: PAGE, request_id: 'r1', server_time: 't' }), async (url, seen) => {
      const { code, stdout, stderr } = await runConn(home, c.command, c.params, url);
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), PAGE);
      assert.equal(seen.length, 1);
      assert.ok(seen[0].endsWith(c.path), seen[0]);
      assert.ok(!seen[0].includes('?'), `no query string expected: ${seen[0]}`);
    });
  });

  test(`${c.command} (subprocess): cursor/limit 透传为 query；next_cursor 原样返回`, async () => {
    const home = setupHome();
    await withActionsServer(() => ({ data: PAGE, next_cursor: 'nxt/+==', request_id: 'r1', server_time: 't' }), async (url, seen) => {
      const { code, stdout, stderr } = await runConn(home, c.command, { ...c.params, cursor: 'cur/+==', limit: 25 }, url);
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), { actions: PAGE, next_cursor: 'nxt/+==' });
      const u = new URL(seen[0], 'http://x');
      assert.ok(u.pathname.endsWith(c.path), u.pathname);
      assert.equal(u.searchParams.get('cursor'), 'cur/+==');
      assert.equal(u.searchParams.get('limit'), '25');
    });
  });
}

test('conn.actions_search (subprocess): GET .../actions:search?query=&limit=，最后一页无 next_cursor → 数组', async () => {
  const home = setupHome();
  await withActionsServer((req) => (req.url.includes('/actions:search') ? { data: PAGE, request_id: 'r1', server_time: 't' } : null), async (url, seen) => {
    const { code, stdout, stderr } = await runConn(home, 'conn.actions_search', { applicationId: 'app-1', query: 'report', limit: 10 }, url);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), PAGE);
    const u = new URL(seen[0], 'http://x');
    assert.ok(u.pathname.endsWith('/connect/applications/app-1/actions:search'), u.pathname);
    assert.equal(u.searchParams.get('query'), 'report');
    assert.equal(u.searchParams.get('limit'), '10');
    assert.equal(u.searchParams.has('cursor'), false);
  });
});

test('conn.actions_search (subprocess): next_cursor 原样返回；只给 applicationId → 无 query string', async () => {
  const home = setupHome();
  await withActionsServer(() => ({ data: PAGE, next_cursor: 'p2', request_id: 'r1', server_time: 't' }), async (url, seen) => {
    const { code, stdout, stderr } = await runConn(home, 'conn.actions_search', { applicationId: 'app-1' }, url);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { actions: PAGE, next_cursor: 'p2' });
    assert.ok(!seen[0].includes('?'), seen[0]);
  });
});

test('conn.actions_search (subprocess): 缺 applicationId → 400，无网络请求', async () => {
  const home = setupHome();
  await withActionsServer(() => ({ data: [], request_id: 'r1' }), async (url, seen) => {
    const { code, stderr } = await runConn(home, 'conn.actions_search', { query: 'report' }, url);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /applicationId is required/);
    assert.equal(seen.length, 0);
  });
});

// --- conn.action_describe (stage 2: full schema of ONE chosen action) --------

test('planActionDescribe: GET .../applications/{id}/actions/{action}；缺参 → 400；action 路径编码', () => {
  const d = planActionDescribe({ applicationId: 'app-1', action: 'NOTION_FETCH_DATA' });
  assert.equal(d.method, 'GET');
  assert.match(d.path, /\/connect\/applications\/app-1\/actions\/NOTION_FETCH_DATA$/);
  assert.equal(d.query, undefined);
  assert.match(planActionDescribe({ application_id: 'app-1', action: 'notion.fetch' }).path, /\/actions\/notion\.fetch$/);
  assert.match(planActionDescribe({ applicationId: 'app-1', action: 't/list x' }).path, /\/actions\/t%2Flist%20x$/);
  assert.throws(() => planActionDescribe({ action: 'X' }), (e) => e.status === 400 && /applicationId is required/.test(e.message));
  assert.throws(() => planActionDescribe({ applicationId: 'app-1' }), (e) => e.status === 400 && /action is required/.test(e.message));
  assert.throws(() => planActionDescribe({ applicationId: 'app-1', action: '' }), (e) => e.status === 400 && /action is required/.test(e.message));
  assert.throws(() => planActionDescribe({ applicationId: 'app-1', action: 7 }), (e) => e.status === 400 && /action must be a string/.test(e.message));
});

test('search → describe (subprocess): 搜索条目 input_schema 为空，describe 选中的 action 返回 required 参数', async () => {
  const home = setupHome();
  const lightweight = [
    { toolkit: 'notion', action: 'NOTION_FETCH_DATA', method: 'POST', description: 'Fetch data', params: [], input_schema: '' },
    { toolkit: 'notion', action: 'NOTION_FETCH_ROW', method: 'POST', description: 'Fetch row', params: [], input_schema: '' },
  ];
  const fullSchema = JSON.stringify({
    type: 'object',
    properties: { fetch_type: { type: 'string', enum: ['pages', 'databases'] }, query: { type: 'string' } },
    required: ['fetch_type'],
  });
  const full = { ...lightweight[0], params: ['fetch_type', 'query'], input_schema: fullSchema };
  await withActionsServer((req) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/connect/applications/app-1/actions:search')) return { data: lightweight, request_id: 'r1', server_time: 't' };
    if (u.pathname.endsWith('/connect/applications/app-1/actions/NOTION_FETCH_DATA')) return { data: full, request_id: 'r2', server_time: 't' };
    return null;
  }, async (url, seen) => {
    const s = await runConn(home, 'conn.actions_search', { applicationId: 'app-1', query: 'fetch' }, url);
    assert.equal(s.code, 0, s.stderr);
    const hits = JSON.parse(s.stdout);
    assert.equal(hits[0].input_schema, '', 'search entries are lightweight');

    const d = await runConn(home, 'conn.action_describe', { applicationId: 'app-1', action: hits[0].action }, url);
    assert.equal(d.code, 0, d.stderr);
    const described = JSON.parse(d.stdout);
    assert.equal(described.action, 'NOTION_FETCH_DATA');
    const schema = JSON.parse(described.input_schema);
    assert.deepEqual(schema.required, ['fetch_type']);
    assert.equal(schema.properties.fetch_type.type, 'string');

    // Exactly one search + one describe (only the chosen action is described).
    assert.equal(seen.length, 2);
    const du = new URL(seen[1], 'http://x');
    assert.equal(du.search, '', 'describe sends no query string');
    assert.ok(du.pathname.endsWith('/connect/applications/app-1/actions/NOTION_FETCH_DATA'), du.pathname);
  });
});

test('conn.action_describe (subprocess): 缺 action / applicationId → 400，无网络请求', async () => {
  const home = setupHome();
  await withActionsServer(() => ({ data: {}, request_id: 'r1' }), async (url, seen) => {
    for (const p of [{ applicationId: 'app-1' }, { action: 'NOTION_FETCH_DATA' }]) {
      const { code, stderr } = await runConn(home, 'conn.action_describe', p, url);
      assert.equal(code, 1);
      const err = JSON.parse(stderr);
      assert.equal(err.status, 400);
      assert.match(err.error, /is required/);
    }
    assert.equal(seen.length, 0);
  });
});
