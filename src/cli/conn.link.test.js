import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTIONS_PANELS, buildConnectionsLinkPath, runConnLink,
  buildConnectorAuthNoticeMessage, authNoticeConnectionsUrl,
} from './conn.js';

// conn.link + the shared Connections page deep-link helper (OPENM-1570). The
// URL shape mirrors cws-fe apps/web/src/components/connections/connections-url.ts
// (buildConnectionsHref / normalizeConnectionsLayer).

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));
const APP = '0190a000-0000-7000-8000-00000000000a';
const CONN = '0190b000-0000-7000-8000-0000000000c1';
const SELF = '019ffe5f-73ec-71e7-8568-728f573e5579';
const CATALOG = [
  { id: APP, slug: 'notion', display_name: 'Notion' },
  { id: '0190a000-0000-7000-8000-00000000000b', slug: 'jira', display_name: 'Jira Cloud' },
];
const OLD_STYLE = /[?&](connect|authorize|edit)=/;

function fakeCatalog(apps) {
  const calls = [];
  return {
    calls,
    getApplication: async (id) => {
      calls.push(`get ${id}`);
      const a = apps.find((x) => x.id === id);
      if (!a) throw Object.assign(new Error('application not found'), { status: 404 });
      return a;
    },
    listApplicationsPage: async (q) => {
      calls.push(`list ${q}`);
      return apps.filter((x) => [x.slug, x.display_name].some((v) => v.toLowerCase().includes(q.toLowerCase())));
    },
  };
}

// --- buildConnectionsLinkPath: every shape cws-fe understands ---------------

test('buildConnectionsLinkPath: each layer → the cws-fe query shape, in app → conn → grant → panel order', () => {
  const cases = [
    [{}, '/connections'],
    [{ app: APP }, `/connections?app=${APP}`],
    [{ app: APP, grant: SELF }, `/connections?app=${APP}&grant=${SELF}`],
    [{ app: APP, conn: CONN }, `/connections?app=${APP}&conn=${CONN}`],
    [{ app: APP, conn: CONN, grant: SELF }, `/connections?app=${APP}&conn=${CONN}&grant=${SELF}`],
    [{ app: APP, panel: 'new' }, `/connections?app=${APP}&panel=new`],
    [{ app: APP, panel: 'edit' }, `/connections?app=${APP}&panel=edit`],
    [{ app: APP, panel: 'add-action' }, `/connections?app=${APP}&panel=add-action`],
    [{ app: APP, conn: CONN, panel: 'rename' }, `/connections?app=${APP}&conn=${CONN}&panel=rename`],
    [{ panel: 'new-custom' }, '/connections?panel=new-custom'],
  ];
  for (const [layer, want] of cases) {
    const got = buildConnectionsLinkPath(layer);
    assert.equal(got, want, JSON.stringify(layer));
    assert.doesNotMatch(got, OLD_STYLE);
  }
  assert.deepEqual([...CONNECTIONS_PANELS], ['new', 'edit', 'add-action', 'rename', 'new-custom']);
});

test('buildConnectionsLinkPath: rejects combinations cws-fe would silently drop, and non-UUID ids', () => {
  const rejects = [
    [{ conn: CONN }, /app .*required/],
    [{ grant: SELF }, /app .*required/],
    [{ panel: 'edit' }, /app .*required/],
    [{ app: APP, panel: 'rename' }, /rename" requires conn/],
    [{ app: APP, conn: CONN, panel: 'edit' }, /takes no conn/],
    [{ app: APP, conn: CONN, panel: 'new' }, /takes no conn/],
    [{ app: APP, panel: 'new', grant: SELF }, /cannot be combined/],
    [{ app: APP, panel: 'new-custom' }, /new-custom" takes no/],
    [{ panel: 'new-custom', grant: SELF }, /new-custom" takes no/],
    [{ app: APP, panel: 'delete' }, /panel must be one of/],
    [{ app: APP, panel: 'disconnect' }, /panel must be one of/],
    [{ app: 'notion' }, /app must be a UUID/],
    [{ app: APP, conn: 'c-1' }, /conn must be a UUID/],
    [{ app: APP, grant: 'm-self' }, /grant must be a UUID/],
    [{ app: `${APP}&panel=edit` }, /app must be a UUID/],
  ];
  for (const [layer, re] of rejects) {
    assert.throws(() => buildConnectionsLinkPath(layer), (e) => e.status === 400 && re.test(e.message), JSON.stringify(layer));
  }
});

// --- runConnLink (in-process, injected catalog / self) ----------------------

test('runConnLink: UUID app is used as-is (no catalog read); slug / name resolves to the application_id', async () => {
  const cat = fakeCatalog(CATALOG);
  const opts = { resolveOrg: () => 'org-1', ...cat, selfMemberId: SELF };
  const r1 = await runConnLink({ app: APP, panel: 'edit' }, opts);
  assert.equal(r1.path, `/connections?app=${APP}&panel=edit`);
  assert.ok(r1.url.endsWith(`/connections?app=${APP}&panel=edit`), r1.url);
  assert.deepEqual(cat.calls, []);
  const r2 = await runConnLink({ app: 'Notion', grant: true }, opts);
  assert.equal(r2.path, `/connections?app=${APP}&grant=${SELF}`);
  const r3 = await runConnLink({ app: 'notion', conn: CONN }, opts);
  assert.equal(r3.path, `/connections?app=${APP}&conn=${CONN}`);
  const r4 = await runConnLink({ panel: 'new-custom' }, opts);
  assert.equal(r4.path, '/connections?panel=new-custom');
  for (const r of [r1, r2, r3, r4]) assert.doesNotMatch(r.url, OLD_STYLE);
});

test('runConnLink: unknown slug → 404 unknown_connector; bad shapes fail before any catalog read', async () => {
  const cat = fakeCatalog(CATALOG);
  const opts = { resolveOrg: () => 'org-1', ...cat, selfMemberId: SELF };
  await assert.rejects(runConnLink({ app: 'confluence' }, opts), (e) => e.status === 404 && e.code === 'unknown_connector');
  cat.calls.length = 0;
  for (const p of [
    { app: 'notion', panel: 'rename' },
    { app: 'notion', panel: 'new', grant: true },
    { app: 'notion', conn: 'not-a-uuid' },
    { conn: CONN },
    { app: 'notion', panel: 'delete' },
    { app: 'notion', grant: SELF }, // never an arbitrary Agent id
    { app: 'notion', grant: 'true' },
    { app: '' },
  ]) {
    await assert.rejects(runConnLink(p, opts), (e) => e.status === 400, JSON.stringify(p));
  }
  assert.deepEqual(cat.calls, [], 'validation runs before the catalog is read');
});

test('runConnLink: {} is the last-resort fallback — the Connections page, no catalog read even when the catalog is down', async () => {
  const down = {
    calls: [],
    getApplication: async () => { throw Object.assign(new Error('catalog unavailable'), { status: 502 }); },
    listApplicationsPage: async () => { throw Object.assign(new Error('catalog unavailable'), { status: 502 }); },
  };
  const opts = { resolveOrg: () => 'org-1', ...down, selfMemberId: SELF };
  // The same slug path conn.auth_notice uses fails here ...
  await assert.rejects(runConnLink({ app: 'notion', grant: true }, opts));
  // ... while the bare call still yields a link.
  const r = await runConnLink({}, opts);
  assert.equal(r.path, '/connections');
  assert.ok(r.url.endsWith('/connections'), r.url);
});

test('runConnLink: grant:true needs this Agent\'s member_id', async () => {
  await assert.rejects(runConnLink({ app: APP, grant: true }, { resolveOrg: () => 'org-1', selfMemberId: '' }),
    (e) => e.status === 400 && /member_id/.test(e.message));
});

// --- conn.auth_notice fallback text uses the new shape ----------------------

test('authNoticeConnectionsUrl: one connector → its authorize dialog for this Agent; several → the page', () => {
  const one = authNoticeConnectionsUrl([{ name: 'Notion', slug: 'notion', id: APP }], SELF);
  assert.ok(one.endsWith(`/connections?app=${APP}&grant=${SELF}`), one);
  const many = authNoticeConnectionsUrl([{ name: 'Notion', slug: 'notion', id: APP }, { name: 'Jira', slug: 'jira', id: CATALOG[1].id }], SELF);
  assert.ok(many.endsWith('/connections'), many);
  const noSelf = authNoticeConnectionsUrl([{ name: 'Notion', slug: 'notion', id: APP }], '');
  assert.ok(noSelf.endsWith('/connections'), noSelf);
  for (const u of [one, many, noSelf]) assert.doesNotMatch(u, OLD_STYLE);
});

test('buildConnectorAuthNoticeMessage: fallback_text carries the full ?app=&grant= link; card body unchanged', () => {
  const url = `https://openmax.example/workspace/connections?app=${APP}&grant=${SELF}`;
  const m = buildConnectorAuthNoticeMessage([{ name: 'Notion', slug: 'notion', id: APP }], { connectionsUrl: url });
  assert.ok(m.fallback_text.includes(url), m.fallback_text);
  assert.match(m.fallback_text, /Notion/);
  assert.match(m.fallback_text, /授权/);
  assert.doesNotMatch(m.fallback_text, /not_authorized|403|conversation|打开|启用/);
  assert.doesNotMatch(m.fallback_text, OLD_STYLE);
  assert.deepEqual(m.content.body, { schema: 'prototype.connector-auth-notice.v1', connector_names: ['Notion'], connector_slugs: ['notion'] });
});

// --- CLI subprocess ---------------------------------------------------------

function setupHome(self = SELF) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-link-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(compDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    server: { bff_url: 'https://openmax.example', frontend_base_path: '/workspace' },
    orgs: { 'org-1': { enabled: true, org_id: 'org-1', self: { member_id: self } } },
  }));
  return home;
}

function runCli(home, command, params, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0', ...extraEnv };
    delete env.COCO_API_URL;
    if (extraEnv.COCO_API_URL) env.COCO_API_URL = extraEnv.COCO_API_URL;
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('CLI conn.link: full URL on the configured web origin + base path, no network for a UUID app', async () => {
  const home = setupHome();
  const { code, stdout, stderr } = await runCli(home, 'conn.link', { app: APP, grant: true }, { COCO_API_URL: 'http://127.0.0.1:1' });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    url: `http://127.0.0.1:1/workspace/connections?app=${APP}&grant=${SELF}`,
    path: `/connections?app=${APP}&grant=${SELF}`,
  });
  const r2 = await runCli(home, 'conn.link', { panel: 'new-custom' });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).url, 'https://openmax.example/workspace/connections?panel=new-custom');
});

test('CLI conn.link: bad input → exit 1 with a 400 JSON error', async () => {
  const home = setupHome();
  const { code, stderr } = await runCli(home, 'conn.link', { app: APP, panel: 'rename' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 400);
  assert.match(err.error, /rename/);
});

test('CLI conn.auth_notice: a single connector posts a fallback_text with the new deep link, never ?connect=', async () => {
  const home = setupHome();
  const CONV = '019f0000-aaaa-7bbb-8ccc-0000000000c1';
  const posted = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && u.pathname === '/api/v1/connect/applications') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      return send(200, { data: CATALOG.filter((a) => a.slug.includes(q)), request_id: 'r' });
    }
    if (req.method === 'POST' && u.pathname === `/api/v1/conversations/${CONV}/messages`) {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => { posted.push(JSON.parse(buf)); send(201, { data: { id: 'msg-1' }, request_id: 'r' }); });
      return undefined;
    }
    return send(404, { error: { detail: 'unexpected' }, request_id: 'r' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { code, stdout, stderr } = await runCli(home, 'conn.auth_notice', { conversationId: CONV, apps: ['notion'] }, { COCO_API_URL: base });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).connectors, [{ name: 'Notion', slug: 'notion', id: APP }]);
    assert.equal(posted.length, 1);
    assert.ok(posted[0].fallback_text.includes(`${base}/workspace/connections?app=${APP}&grant=${SELF}`), posted[0].fallback_text);
    assert.doesNotMatch(posted[0].fallback_text, OLD_STYLE);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
