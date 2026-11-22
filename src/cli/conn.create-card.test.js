import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTOR_CREATE_CARD_SCHEMA, CREATE_CARD_MAX_ACTIONS, CREATE_CARD_LIMITS,
  isSecretLikeKey, assertNoSecretKeys, parseCreateCardInput,
  buildConnectorCreateCardMessage, buildCreateCardFallbackText,
  sendConnectorCard, runCreateCard, buildConnectorAuthNoticeMessage, looksLikeToken, actionNameKey,
  createCardMetadata,
  CREATE_CARD_DATA_MAX_BYTES, CREATE_CARD_MAX_OAUTH_SCOPES,
} from './conn.js';

// conn.create_card (OPENM-836): the "create this custom connector?" card.

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));
const CONV = 'conv-abc_1';
const APP_ID = '3f401897-545e-4633-a486-5b3c464137a5';
const CARD_ID = '11111111-2222-4333-8444-555555555555';

function valid(overrides = {}) {
  return {
    conversationId: CONV,
    connector: {
      name: 'Acme CRM',
      slug: 'acme-crm',
      connector_kind: 'http',
      auth_type: 'oauth2',
      icon_url: 'https://acme.example.com/icon.png',
      description: 'Acme 的客户管理系统',
      base_url: 'https://api.acme.example.com/v1',
    },
    actions: [
      { name: 'list_contacts', effect: 'read', summary: '列出联系人' },
      { name: 'create_contact', effect: 'write', summary: '新建联系人' },
    ],
    ...overrides,
  };
}
const withConnector = (patch) => { const p = valid(); p.connector = { ...p.connector, ...patch }; return p; };
const withAction = (patch, i = 0) => { const p = valid(); p.actions[i] = { ...p.actions[i], ...patch }; return p; };
const rejects400 = (p, re) => assert.throws(() => parseCreateCardInput(p), (e) => e.status === 400 && re.test(e.message));

// --- validation ---------------------------------------------------------------

test('parseCreateCardInput: valid payload → trimmed, normalized', () => {
  const p = valid({ application_id: APP_ID });
  p.connector.name = '  Acme CRM ';
  const out = parseCreateCardInput(p);
  assert.equal(out.conversationId, CONV);
  assert.equal(out.connector.name, 'Acme CRM');
  assert.equal(out.application_id, APP_ID);
  assert.equal(out.actions.length, 2);
  // optional fields absent → omitted
  const min = parseCreateCardInput({ conversationId: CONV, connector: { name: 'X', slug: 'x', connector_kind: 'http', auth_type: 'api_key' }, actions: [{ name: 'a', effect: 'read', summary: 's' }] });
  assert.deepEqual(min.connector, { name: 'X', slug: 'x', connector_kind: 'http', auth_type: 'api_key' });
  assert.equal('application_id' in min, false);
  // applicationId alias + conversation_id alias
  const alias = parseCreateCardInput({ ...valid(), conversationId: undefined, conversation_id: CONV, applicationId: APP_ID });
  assert.equal(alias.application_id, APP_ID);
});

test('parseCreateCardInput: conversationId required and well-formed', () => {
  rejects400(valid({ conversationId: undefined }), /conversationId/);
  rejects400(valid({ conversationId: 'a/b' }), /conversationId/);
});

test('parseCreateCardInput: connector fields', () => {
  rejects400(valid({ connector: undefined }), /connector object/);
  rejects400(valid({ connector: [] }), /connector object/);
  rejects400(withConnector({ name: undefined }), /connector\.name is required/);
  rejects400(withConnector({ name: '   ' }), /connector\.name is required/);
  rejects400(withConnector({ name: 42 }), /connector\.name must be a string/);
  rejects400(withConnector({ name: 'x'.repeat(CREATE_CARD_LIMITS.name + 1) }), /too long/);
  rejects400(withConnector({ name: 'a\nb' }), /control/);
  rejects400(withConnector({ slug: undefined }), /connector\.slug is required/);
  for (const bad of ['Acme', 'acme crm', '-acme', 'acme-', 'acme/crm', 'ä', 'a'.repeat(65)]) {
    rejects400(withConnector({ slug: bad }), /connector\.slug/);
  }
  for (const ok of ['a', 'acme', 'acme-crm-k3wujp', 'tencent_ads', 'a1-b2']) {
    assert.equal(parseCreateCardInput(withConnector({ slug: ok })).connector.slug, ok);
  }
  rejects400(withConnector({ auth_type: undefined }), /auth_type must be one of api_key \| oauth2 when connector_kind is "http"/);
  rejects400(withConnector({ auth_type: 'basic' }), /auth_type must be one of api_key \| oauth2 when connector_kind is "http"/);
  rejects400(withConnector({ auth_type: 'OAUTH2' }), /auth_type must be one of/);
  rejects400(withConnector({ connector_kind: undefined }), /connector\.connector_kind is required: one of http \| mcp/);
  rejects400(withConnector({ connector_kind: 'grpc' }), /connector_kind is required: one of http \| mcp/);
  rejects400(withConnector({ connector_kind: 'HTTP' }), /connector_kind is required/);
  rejects400(withConnector({ icon_url: 'javascript:alert(1)' }), /icon_url/);
  rejects400(withConnector({ icon_url: 'not a url' }), /icon_url/);
  rejects400(withConnector({ base_url: 'ftp://acme.example.com' }), /base_url/);
  rejects400(withConnector({ base_url: 'https://u:p@acme.example.com' }), /credentials/);
  rejects400(withConnector({ base_url: `https://a.example.com/${'x'.repeat(CREATE_CARD_LIMITS.url)}` }), /too long/);
  rejects400(withConnector({ description: 'x'.repeat(CREATE_CARD_LIMITS.description + 1) }), /too long/);
  rejects400(withConnector({ category: 'crm' }), /unknown field "connector\.category"/);
});

test('parseCreateCardInput: actions', () => {
  rejects400(valid({ actions: undefined }), /actions/);
  rejects400(valid({ actions: [] }), /actions/);
  rejects400(valid({ actions: ['x'] }), /actions\[0\] must be an object/);
  rejects400(withAction({ name: undefined }), /actions\[0\]\.name is required/);
  rejects400(withAction({ name: 'acme-crm/list' }), /bare action name/);
  rejects400(withAction({ name: 'x'.repeat(CREATE_CARD_LIMITS.action_name + 1) }), /too long/);
  rejects400(withAction({ name: 'LIST_CONTACTS' }, 1), /duplicated/);
  rejects400(withAction({ effect: undefined }), /effect must be one of read \| write/);
  rejects400(withAction({ effect: 'delete' }), /effect/);
  rejects400(withAction({ summary: '' }), /summary is required/);
  rejects400(withAction({ summary: 'x'.repeat(CREATE_CARD_LIMITS.action_summary + 1) }), /too long/);
  rejects400(withAction({ method: 'GET' }), /unknown field "actions\[0\]\.method"/);
  const many = Array.from({ length: CREATE_CARD_MAX_ACTIONS }, (_, i) => ({ name: `a${i}`, effect: 'read', summary: 's' }));
  assert.equal(parseCreateCardInput(valid({ actions: many })).actions.length, 50);
  rejects400(valid({ actions: [...many, { name: 'a50', effect: 'read', summary: 's' }] }), /at most 50 actions/);
});

test('parseCreateCardInput: application_id must be a UUID; unknown top-level keys refused', () => {
  rejects400(valid({ application_id: 'acme' }), /application_id must be a UUID/);
  rejects400(valid({ extra: 1 }), /unknown field "extra"/);
});

test('parseCreateCardInput: every length cap — exactly at cap accepted, cap+1 rejected', () => {
  const L = CREATE_CARD_LIMITS;
  const urlOf = (n) => { const base = 'https://a.example.com/'; return base + 'x'.repeat(n - base.length); };
  const cases = [
    ['connector.name', (n) => withConnector({ name: 'x'.repeat(n) }), L.name, (o) => o.connector.name],
    ['connector.slug', (n) => withConnector({ slug: 'a'.repeat(n) }), L.slug, (o) => o.connector.slug],
    ['connector.description', (n) => withConnector({ description: 'x'.repeat(n) }), L.description, (o) => o.connector.description],
    ['connector.icon_url', (n) => withConnector({ icon_url: urlOf(n) }), L.url, (o) => o.connector.icon_url],
    ['connector.base_url', (n) => withConnector({ base_url: urlOf(n) }), L.url, (o) => o.connector.base_url],
    ['actions[0].name', (n) => withAction({ name: 'x'.repeat(n) }), L.action_name, (o) => o.actions[0].name],
    ['actions[0].summary', (n) => withAction({ summary: 'x'.repeat(n) }), L.action_summary, (o) => o.actions[0].summary],
  ];
  for (const [field, make, cap, get] of cases) {
    assert.equal([...get(parseCreateCardInput(make(cap)))].length, cap, `${field} at cap`);
    assert.throws(() => parseCreateCardInput(make(cap + 1)), (e) => e.status === 400 && e.message.includes(field), `${field} cap+1`);
  }
  // characters, not UTF-16 units: 100 CJK / emoji characters fit the name cap
  assert.doesNotThrow(() => parseCreateCardInput(withConnector({ name: '😀'.repeat(L.name) })));
});

test('parseCreateCardInput: slug with an uppercase letter anywhere is rejected', () => {
  for (const s of ['acmeCrm', 'acme-Crm', 'Acme', 'acmE']) rejects400(withConnector({ slug: s }), /connector\.slug/);
});

test('parseCreateCardInput: control / invisible formatting characters (Cc, Cf) rejected in every text field', () => {
  const bad = ['a\u202Eb', 'a\u202Ab', 'a\u200Eb', 'a\u200Fb', 'a\u200Bb', 'a\uFEFFb', 'a\u2060b', 'a\u2064b',
    'a\u0007b', 'a\tb', 'a\u2066b', 'a\u2069b', 'a\u2028b', 'a\u2029b', 'a\u{E0001}b'];
  const fields = [
    (v) => withConnector({ name: v }), (v) => withConnector({ description: v }), (v) => withConnector({ slug: v }),
    (v) => withAction({ name: v }), (v) => withAction({ summary: v }),
    (v) => withConnector({ base_url: `https://a.example.com/${v}` }), (v) => withConnector({ icon_url: `https://a.example.com/${v}` }),
  ];
  for (const mk of fields) {
    for (const v of bad) {
      assert.throws(() => parseCreateCardInput(mk(v)), (e) => e.status === 400 && /control, invisible formatting or line-separator|connector\.slug/.test(e.message), JSON.stringify(v));
    }
  }
  assert.throws(() => parseCreateCardInput(withConnector({ name: 'Acme\u202Emrc' })), /invisible formatting/);
});

test('parseCreateCardInput: emoji ZWJ / tag sequences allowed only where valid; ZWNJ only in description', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 👨‍👩‍👧
  const rainbow = '\u{1F3F3}️‍\u{1F308}'; // 🏳️‍🌈 (VS16 before ZWJ)
  const skin = '\u{1F469}\u{1F3FD}‍\u{1F4BB}'; // 👩🏽‍💻 (skin tone before ZWJ)
  const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'; // 🏴󠁧󠁢󠁳󠁣󠁴󠁿
  for (const v of [family, rainbow, skin, scotland]) {
    assert.equal(parseCreateCardInput(withConnector({ name: `CRM ${v}` })).connector.name, `CRM ${v}`);
    assert.equal(parseCreateCardInput(withConnector({ description: `说明 ${v}` })).connector.description, `说明 ${v}`);
    assert.equal(parseCreateCardInput(withAction({ summary: `${v} 列出` })).actions[0].summary, `${v} 列出`);
  }
  // ZWNJ between letters: description only
  const zwnj = 'می‌خواهم';
  assert.equal(parseCreateCardInput(withConnector({ description: zwnj })).connector.description, zwnj);
  rejects400(withConnector({ name: zwnj }), /invisible formatting/);
  rejects400(withAction({ summary: zwnj }), /invisible formatting/);
  rejects400(withConnector({ description: 'ab‌' }), /invisible formatting/);
  rejects400(withConnector({ description: '1‌2' }), /invisible formatting/);
  // tag characters outside a complete 🏴 … U+E007F sequence
  for (const v of ['\u{E0020}', 'list\u{E0020}', 'a\u{E0067}\u{E007F}', '\u{1F3F4}\u{E0067}\u{E0062}', '\u{1F3F4}\u{E007F}', `${scotland}\u{E0020}`]) {
    rejects400(withConnector({ name: v }), /invisible formatting/);
    rejects400(withAction({ summary: v }), /invisible formatting/);
    rejects400(withConnector({ description: v }), /invisible formatting/);
  }
  // ZWJ not between two emoji
  for (const v of ['a‍b', '\u{1F468}‍', '‍\u{1F468}', '\u{1F468}‍a', 'list‍']) {
    rejects400(withConnector({ name: v }), /invisible formatting/);
    rejects400(withConnector({ description: v }), /invisible formatting/);
  }
  rejects400(withConnector({ name: `${family}‮` }), /invisible formatting/);
  // no joiners / tags at all in action names, slug, URLs
  for (const v of [family, scotland]) rejects400(withAction({ name: `list${v}` }), /invisible formatting/);
  rejects400(withAction({ name: 'list\u{E0020}' }), /invisible formatting/);
  rejects400(withConnector({ base_url: 'https://a.example.com/x‍y' }), /invisible formatting/);
  rejects400(withConnector({ icon_url: `https://a.example.com/${scotland}` }), /invisible formatting/);
  rejects400(withConnector({ slug: 'a‍b' }), /connector\.slug/);
});

test('parseCreateCardInput: flag tag sequences — only 🏴 + 3–6 digit/lowercase tags + U+E007F', () => {
  const tag = (str) => [...str].map((c) => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('');
  const flag = (str, end = '\u{E007F}', base = '\u{1F3F4}') => `${base}${tag(str)}${end}`;
  for (const ok of ['gbeng', 'gbsct', 'gbwls', 'usca', 'fr75c', 'abc', 'abcdef']) {
    assert.doesNotThrow(() => parseCreateCardInput(withConnector({ name: `X ${flag(ok)}` })), ok);
  }
  const bad = [
    flag('ab'), //             too short
    flag('abcdefg'), //        too long
    flag('GBSCT'), //          uppercase tags (U+E0041–E005A)
    flag('gb-ct'), //          hyphen tag U+E002D
    flag('gb ct'), //          space tag U+E0020
    flag('gbsct', ''), //      no terminator
    flag('gbsct', '', '\u{1F3F4}') + '\u{E0020}',
    flag('gbsct', '\u{E007F}', '\u{1F600}'), // tag sequence after a non-flag emoji
    flag('gbsct', '\u{E007F}', 'a'),
    '\u{E007F}', //            lone terminator
  ];
  for (const v of bad) {
    rejects400(withConnector({ name: `X ${v}` }), /invisible formatting/);
    rejects400(withConnector({ description: v }), /invisible formatting/);
    rejects400(withAction({ summary: v }), /invisible formatting/);
  }
});

test('parseCreateCardInput: ZWJ needs an emoji on BOTH sides (letter + ZWJ + emoji is refused)', () => {
  for (const v of ['a‍\u{1F468}', '\u{1F468}‍a', '1‍\u{1F468}', '‍\u{1F468}', '\u{1F468}‍‍\u{1F469}']) {
    rejects400(withConnector({ name: v }), /invisible formatting/);
    rejects400(withConnector({ description: v }), /invisible formatting/);
    rejects400(withAction({ summary: v }), /invisible formatting/);
  }
});

test('parseCreateCardInput: non-Cf default-ignorables refused; VS16 only right after an emoji', () => {
  const ignorables = ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '᠋', '᠌', '᠍', '᠏', '͏',
    '︀', '︎', '\u{E0100}'];
  for (const c of ignorables) {
    for (const mk of [(v) => withConnector({ name: v }), (v) => withConnector({ description: v }),
      (v) => withAction({ summary: v }), (v) => withAction({ name: v })]) {
      assert.throws(() => parseCreateCardInput(mk(`a${c}b`)), (e) => e.status === 400, `U+${c.codePointAt(0).toString(16)}`);
    }
    rejects400(withConnector({ name: c }), /invisible formatting/); // a name made only of a Hangul filler
  }
  // VS16 after an emoji (❤️, 1️⃣ keycap) ok in text; elsewhere refused
  for (const ok of ['❤️', '1️⃣', '\u{1F3F3}️']) {
    assert.doesNotThrow(() => parseCreateCardInput(withConnector({ name: `X ${ok}` })), ok);
  }
  for (const v of ['a️', '️', '❤️️']) rejects400(withConnector({ name: v }), /invisible formatting/);
  rejects400(withAction({ name: 'list️' }), /invisible formatting/);
});

test('parseCreateCardInput: ZWNJ in description after a letter or mark, before a letter (Hindi, Persian, Arabic)', () => {
  const samples = [
    'क्‌ष', //            Devanagari: ka + virama (Mn) + ZWNJ + ssa
    'स्‌त्री',
    'می‌خواهم', //        Persian
    'مِ‌ن', //            Arabic letter + kasra (Mn) + ZWNJ + letter
  ];
  for (const v of samples) {
    assert.equal(parseCreateCardInput(withConnector({ description: v })).connector.description, v, v);
    rejects400(withConnector({ name: v }), /invisible formatting/);
  }
  for (const v of ['‌क', 'क‌', 'क‌1', '1‌क', '\u{1F600}‌क', 'क‌́']) {
    rejects400(withConnector({ description: v }), /invisible formatting/);
  }
});

test('parseCreateCardInput: action-name duplicates detected after NFKC + default-ignorable stripping', () => {
  const two = (n0, n1) => valid({ actions: [{ name: n0, effect: 'read', summary: 's' }, { name: n1, effect: 'write', summary: 's' }] });
  rejects400(two('list', 'list\u{E0020}'), /invisible formatting/); // the invisible variant never gets in
  rejects400(two('list', 'ＬＩＳＴ'), /duplicated/); // full-width folds under NFKC
  rejects400(two('list', 'LIST'), /duplicated/);
  assert.equal(actionNameKey('li­st'), 'list'); // soft hyphen is default-ignorable
  assert.equal(actionNameKey('ｌｉｓｔ'), 'list');
  assert.doesNotThrow(() => parseCreateCardInput(two('list', 'list_all')));
});

test('parseCreateCardInput: URLs — credentials in any form rejected; normalized href echoed', () => {
  for (const u of ['https://user:pass@a.example.com', 'https://:pass@a.example.com', 'https://user:@a.example.com', 'https://user@a.example.com']) {
    rejects400(withConnector({ base_url: u }), /must not embed credentials/);
    rejects400(withConnector({ icon_url: u }), /must not embed credentials/);
  }
  // backslash trick: displayed host must be the real host
  const o = parseCreateCardInput(withConnector({ base_url: 'https://evil.example.com\\@good.example.com', icon_url: 'HTTPS://A.Example.COM/i.png' }));
  assert.equal(o.connector.base_url, 'https://evil.example.com/@good.example.com');
  assert.equal(o.connector.icon_url, 'https://a.example.com/i.png');
  const m = buildConnectorCreateCardMessage(o, CARD_ID);
  assert.equal(m.content.body.connector.base_url, 'https://evil.example.com/@good.example.com');
  assert.match(m.fallback_text, /服务地址：https:\/\/evil\.example\.com\/@good\.example\.com/);
  assert.equal(m.metadata.context.items[0].data.connector.icon_url, 'https://a.example.com/i.png');
  // a plain fragment is refused too
  rejects400(withConnector({ icon_url: 'https://a.example.com/i.png#x' }), /#fragment/);
  rejects400(withConnector({ base_url: 'https://a.example.com/#section' }), /#fragment/);
});

test('parseCreateCardInput: secrets in URL query / fragment → secret_field_rejected naming the parameter, never the value', () => {
  const urls = [
    ['https://a.example.com/?api_key=SECRETVAL', 'query parameter "api_key"'],
    ['https://a.example.com/v1?x=1&access_token=SECRETVAL', 'query parameter "access_token"'],
    ['https://a.example.com/?client%5Fsecret=SECRETVAL', 'query parameter "client_secret"'],
    ['https://a.example.com/?Password=SECRETVAL', 'query parameter "Password"'],
    ['https://a.example.com/#token=SECRETVAL', 'fragment parameter "token"'],
    ['https://a.example.com/#state=1&id_token=SECRETVAL', 'fragment parameter "id_token"'],
    ['https://a.example.com/#a=1;apiKey=SECRETVAL', 'fragment parameter "apiKey"'],
  ];
  for (const field of ['base_url', 'icon_url']) {
    for (const [u, where] of urls) {
      assert.throws(() => parseCreateCardInput(withConnector({ [field]: u })), (e) => e.status === 400
        && e.code === 'secret_field_rejected' && e.message.includes(where) && e.message.includes(`connector.${field}`)
        && !e.message.includes('SECRETVAL'), `${field} ${u}`);
    }
  }
  // harmless query params pass through
  assert.equal(parseCreateCardInput(withConnector({ base_url: 'https://a.example.com/v1?version=2' })).connector.base_url,
    'https://a.example.com/v1?version=2');
});

test('URLs: ";" is a query separator too; signed-URL / JWT parameter names refused', () => {
  const cases = [
    ['https://a.example.com/?x=1;api_key=V', 'api_key'],
    ['https://a.example.com/?x=1;sig=V', 'sig'],
    ['https://a.example.com/?sv=2022-11-02&sig=V', 'sig'],
    ['https://a.example.com/?X-Amz-Signature=V', 'X-Amz-Signature'],
    ['https://a.example.com/?X-Amz-Credential=V', 'X-Amz-Credential'],
    ['https://a.example.com/?X-Goog-Signature=V', 'X-Goog-Signature'],
    ['https://a.example.com/?X-Goog-Credential=V', 'X-Goog-Credential'],
    ['https://a.example.com/?signature=V', 'signature'],
    ['https://a.example.com/?jwt=V', 'jwt'],
    ['https://a.example.com/?id_token=V', 'id_token'],
    ['https://a.example.com/?refresh_token=V', 'refresh_token'],
  ];
  for (const [u, name] of cases) {
    assert.throws(() => parseCreateCardInput(withConnector({ base_url: u })), (e) => e.code === 'secret_field_rejected'
      && e.message.includes(`query parameter "${name}"`), u);
  }
  // ordinary names still pass
  for (const u of ['https://a.example.com/?sv=2022-11-02', 'https://a.example.com/?page=2;size=10', 'https://a.example.com/?design=1&signed_up=0']) {
    assert.doesNotThrow(() => parseCreateCardInput(withConnector({ base_url: u })), u);
  }
});

// Real-looking tokens are assembled at runtime so no secret-shaped literal sits
// in the repository (and push protection has nothing to flag).
const R = (n, alphabet = 'aB3dE5gH7jK9mN2pQ4sT6vW8xY0') => Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');
const TOKENS = [
  ['sk', '-', 'proj-', R(40)].join(''),
  ['sk', '-', R(20)].join(''),
  ['sk', '_live_', R(24)].join(''),
  ['rk', '_test_', R(24)].join(''),
  ['gh', 'p_', R(36)].join(''),
  ['gh', 's_', R(36)].join(''),
  ['github', '_pat_', R(40)].join(''),
  ['gl', 'pat-', R(20)].join(''),
  ['xo', 'xb-', '1234567890-', R(24)].join(''),
  ['ey', 'J', R(20), '.', 'eyJ', R(20), '.', R(20)].join(''),
  ['AK', 'IA', R(16, 'ABCDEFGHIJ0123456789')].join(''),
];

test('URLs: well-known token formats refused in path segments and query values (best-effort)', () => {
  for (const t of TOKENS) {
    assert.equal(looksLikeToken(t), true, t);
    assert.throws(() => parseCreateCardInput(withConnector({ base_url: `https://a.example.com/hooks/${t}` })),
      (e) => e.code === 'secret_field_rejected' && /token-like URL path segment #2/.test(e.message) && !e.message.includes(t), t);
    assert.throws(() => parseCreateCardInput(withConnector({ icon_url: `https://a.example.com/i.png?v=${t}` })),
      (e) => e.code === 'secret_field_rejected' && /token-like value of URL query parameter "v"/.test(e.message), t);
  }
});

test('URLs: a percent-encoded token in a path segment is decoded before the check', () => {
  const t = ['sk', '_live_', R(24)].join('');
  const encoded = `%73${t.slice(1)}`; // "%73" = "s"
  assert.equal(looksLikeToken(encoded), false, 'raw form alone would slip through');
  assert.throws(() => parseCreateCardInput(withConnector({ base_url: `https://a.example.com/hooks/${encoded}` })),
    (e) => e.code === 'secret_field_rejected' && /path segment #2/.test(e.message));
  const gh = ['gh', 'p_', R(36)].join('');
  assert.throws(() => parseCreateCardInput(withConnector({ icon_url: `https://a.example.com/%67${gh.slice(1)}/i.png` })),
    (e) => e.code === 'secret_field_rejected');
});

test('URLs: no false positives on locale codes, words, short prefixes or Drive / Notion / S3-style ids', () => {
  const ok = [
    'sk-SK', 'sk_SK', 'sk-proj', 'sk_live_short', 'rk_test_x', 'xoxo-gossip', 'xoxb-short', 'ghp_short', 'github_pat_x',
    'glpat-xyz', 'eyJ', 'eyJabc.def', 'AKIA1234', 'skills', 'sketch',
    '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', // Google Sheets / Drive id
    'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv', // 32 mixed-class chars, no known prefix
    '1429989fe8ac4effbc8f57f56486db54', // Notion page id
    'My-Page-Title-1429989fe8ac4effbc8f57f56486db54',
    '3f401897-545e-4633-a486-5b3c464137a5', 'd41d8cd98f00b204e9800998ecf8427e', 'list-all-repositories-for-the-current-user',
  ];
  for (const t of ok) {
    assert.equal(looksLikeToken(t), false, t);
    assert.doesNotThrow(() => parseCreateCardInput(withConnector({ base_url: `https://a.example.com/${t}/x` })), t);
  }
  for (const u of ['https://a.example.com/docs?hl=sk-SK', 'https://a.example.com/sk_SK/docs', 'https://a.example.com/blog/xoxo-gossip',
    'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit']) {
    assert.doesNotThrow(() => parseCreateCardInput(withConnector({ base_url: u })), u);
  }
});

// The command ENTRY (COMMANDS['conn.auth_notice'] / ['conn.create_card']) runs in a
// child process with the shared transport replaced: if either entry bypassed
// sendConnectorCard, the stub would see no call and the fake server would see a POST.
function runCommandWithStubbedTransport(command, params, apiUrl, home) {
  const code = `
    process.argv = [process.execPath, '', ${JSON.stringify(command)}, ${JSON.stringify(JSON.stringify(params))}];
    const mod = await import(${JSON.stringify(new URL('./conn.js', import.meta.url).href)});
    const calls = [];
    mod.connectorCardTransport.post = async (...args) => { calls.push(args); return { id: 'msg-stub' }; };
    const out = await mod.COMMANDS[${JSON.stringify(command)}]();
    process.stdout.write(JSON.stringify({ out, calls }));
  `;
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
    execFile(process.execPath, ['--input-type=module', '-e', code], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('command entries conn.auth_notice and conn.create_card route through sendConnectorCard', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url.startsWith('/api/v1/connect/applications')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a1', slug: 'notion', display_name: 'Notion' }], request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r9"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const home = setupHome();
    for (const [command, params, contentType] of [
      ['conn.auth_notice', { conversationId: CONV, apps: ['notion'] }, 'connector_auth_notice'],
      ['conn.create_card', valid(), 'connector_create_card'],
    ]) {
      const { code, stdout, stderr } = await runCommandWithStubbedTransport(command, params, url, home);
      assert.equal(code, 0, stderr);
      const { out, calls } = JSON.parse(stdout);
      assert.equal(out.status, 'sent', command);
      assert.equal(calls.length, 1, command);
      const [orgId, p, message, opts] = calls[0];
      assert.equal(orgId, 'org-1');
      assert.equal(p, `/api/v1/conversations/${CONV}/messages`);
      assert.equal(message.content.content_type, contentType);
      assert.deepEqual(opts, { timeoutMs: 30_000, quietOnSuccess: true });
    }
    assert.equal(seen.some((s) => s.startsWith('POST')), false, 'no card POST bypassed the shared transport');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('runCreateCard: secret in a URL → nothing sent (network stub 0 calls)', async () => {
  let calls = 0;
  const deps = { resolveOrg: () => 'org-1', post: async () => { calls += 1; return { id: 'm' }; } };
  for (const u of ['https://a.example.com/?api_key=k', 'https://a.example.com/#access_token=t']) {
    await assert.rejects(runCreateCard(withConnector({ base_url: u }), deps), (e) => e.code === 'secret_field_rejected');
    await assert.rejects(runCreateCard(withConnector({ icon_url: u }), deps), (e) => e.code === 'secret_field_rejected');
  }
  assert.equal(calls, 0);
});

// --- secret refusal -------------------------------------------------------------

test('isSecretLikeKey: catches secret names in any casing/separator, leaves card fields alone', () => {
  for (const k of ['api_key', 'apiKey', 'API-KEY', 'secret', 'client_secret', 'clientSecret', 'oauth_client_secret',
    'token', 'access_token', 'refreshToken', 'password', 'passwd', 'passphrase', 'private_key', 'key',
    'authorization', 'bearer', 'credentials', 'cookie', 'aws_secret_access_key', 'webhook_secret']) {
    assert.equal(isSecretLikeKey(k), true, k);
  }
  for (const k of ['name', 'slug', 'icon_url', 'description', 'base_url', 'connector_kind', 'auth_type', 'server_url', 'effect', 'summary',
    'conversationId', 'actions', 'application_id', 'org']) {
    assert.equal(isSecretLikeKey(k), false, k);
  }
});

test('parseCreateCardInput: secret-like key at ANY depth → 400 secret_field_rejected (before other checks)', () => {
  const cases = [
    { ...valid(), api_key: 'sk-1' },
    withConnector({ oauth_client_secret: 's' }),
    withConnector({ client_secret: 's' }),
    withAction({ token: 't' }, 1),
    withConnector({ extra: { nested: [{ password: 'p' }] } }),
    { ...valid(), meta: [[{ Authorization: 'Bearer x' }]] },
    // secret refusal wins even when everything else is invalid too
    { apiKey: 'x' },
  ];
  for (const p of cases) {
    assert.throws(() => parseCreateCardInput(p), (e) => e.status === 400 && e.code === 'secret_field_rejected'
      && /secret-like field/.test(e.message) && /填写 Client Secret/.test(e.message), JSON.stringify(p));
  }
  // the error names the path, never the value
  try { parseCreateCardInput(withConnector({ extra: { nested: [{ password: 'hunter2' }] } })); } catch (e) {
    assert.match(e.message, /connector\.extra\.nested\[0\]\.password/);
    assert.doesNotMatch(e.message, /hunter2/);
  }
  assert.doesNotThrow(() => assertNoSecretKeys({ a: [{ b: 1 }], c: null }));
});

// --- connector_kind "mcp": MCP server address, no auth_type, no actions ----------

const MCP_URL = 'https://api.plaud.ai/mcp';
function validMcp(connectorPatch = {}, overrides = {}) {
  return {
    conversationId: CONV,
    connector: { name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', description: 'Plaud 录音', server_url: MCP_URL, ...connectorPatch },
    ...overrides,
  };
}

test('parseCreateCardInput mcp: server_url required (https), echoed as server_url only; no auth_type, no actions', () => {
  const out = parseCreateCardInput(validMcp());
  assert.deepEqual(out.connector, {
    name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', description: 'Plaud 录音', server_url: MCP_URL,
  });
  assert.deepEqual(out.actions, []);
  // explicit empty actions list is fine too; mcp_server_url alias accepted
  assert.deepEqual(parseCreateCardInput(validMcp({}, { actions: [] })).actions, []);
  const alias = parseCreateCardInput(validMcp({ server_url: undefined, mcp_server_url: MCP_URL }));
  assert.equal(alias.connector.server_url, MCP_URL);
  // required + https only + the usual URL hygiene
  rejects400(validMcp({ server_url: undefined }), /server_url .*required when connector_kind is "mcp"/);
  rejects400(validMcp({ server_url: '  ' }), /server_url .*required/);
  rejects400(validMcp({ server_url: 'http://api.plaud.ai/mcp' }), /must be an https URL/);
  rejects400(validMcp({ server_url: 'not a url' }), /server_url/);
  rejects400(validMcp({ server_url: 'https://u:p@api.plaud.ai/mcp' }), /credentials/);
  assert.throws(() => parseCreateCardInput(validMcp({ server_url: `${MCP_URL}?api_key=1` })), (e) => e.code === 'secret_field_rejected');
  rejects400(validMcp({ mcp_server_url: 'https://other.example.com/mcp' }), /differ/);
  rejects400(validMcp({ base_url: 'https://api.plaud.ai' }), /base_url is not used when connector_kind is "mcp"/);
});

test('parseCreateCardInput: auth_type "mcp" is gone — refused with a pointer to connector_kind; mcp cards carry no auth_type', () => {
  for (const at of ['mcp', 'MCP', ' Mcp ']) {
    for (const kind of [undefined, 'http', 'mcp']) {
      rejects400(validMcp({ auth_type: at, connector_kind: kind }),
        /connector\.auth_type "mcp" is not valid .*connector\.connector_kind:"mcp" with no auth_type/);
    }
  }
  for (const at of ['api_key', 'oauth2', null, '']) {
    rejects400(validMcp({ auth_type: at }), /auth_type is not used when connector_kind is "mcp"/);
  }
});

test('parseCreateCardInput mcp: actions refused (tools come from the MCP server)', () => {
  rejects400(validMcp({}, { actions: [{ name: 'a', effect: 'read', summary: 's' }] }), /actions are not listed when connector_kind is "mcp"/);
  rejects400(validMcp({}, { actions: 'x' }), /actions are not listed/);
});

test('parseCreateCardInput: server_url only for mcp; api_key / oauth2 unchanged (actions still required)', () => {
  rejects400(withConnector({ server_url: MCP_URL }), /server_url is only for connector_kind "mcp"/);
  rejects400(withConnector({ auth_type: 'api_key', mcp_server_url: MCP_URL }), /only for connector_kind "mcp"/);
  rejects400(valid({ actions: [] }), /actions \(non-empty list\) is required/);
  const out = parseCreateCardInput(valid());
  assert.equal(out.connector.base_url, 'https://api.acme.example.com/v1');
  assert.equal('server_url' in out.connector, false);
});

test('mcp card: body + metadata carry the server URL, zero actions; fallback text tells the next step', () => {
  const input = parseCreateCardInput(validMcp());
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  assert.deepEqual(m.content.body.connector, {
    name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', description: 'Plaud 录音', server_url: MCP_URL,
  });
  assert.deepEqual(m.content.body.actions, []);
  assert.deepEqual(m.metadata.context.items[0].data.connector, {
    name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', server_url: MCP_URL,
  });
  assert.deepEqual(m.metadata.context.items[0].data.actions, []);
  const t = m.fallback_text;
  assert.match(t, /类型：MCP 服务器/);
  assert.doesNotMatch(t, /认证方式/);
  assert.match(t, new RegExp(`MCP 服务器地址：${MCP_URL.replace(/[.]/g, '\\.')}`));
  assert.match(t, /工具由 MCP 服务器提供/);
  assert.match(t, /openmax\.com 的「应用连接」页面/);
  assert.match(t, /传输类型选「远程（Streamable HTTP）」/);
  assert.match(t, /在「服务器 URL」填入上面的 MCP 服务器地址/);
  assert.doesNotMatch(t, /「MCP 服务器地址」/);
  assert.match(t, /完成授权/);
  assert.match(t, /确认创建 Plaud/);
  assert.doesNotMatch(t, /动作（/);
  assert.doesNotMatch(t, /Client Secret/);
});

test('runCreateCard mcp: returns server_url and actions_total 0', async () => {
  const out = await runCreateCard(validMcp(), { resolveOrg: () => 'org-1', post: async () => ({ id: 'msg-1' }), cardId: CARD_ID });
  assert.deepEqual(out.connector, { name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', server_url: MCP_URL });
  assert.equal(out.actions_total, 0);
});

// --- payload shape --------------------------------------------------------------

test('buildConnectorCreateCardMessage: exact schema, AGENT_STRUCTURED body + compact metadata copy', () => {
  const input = parseCreateCardInput(valid({ application_id: APP_ID }));
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  assert.equal(CONNECTOR_CREATE_CARD_SCHEMA, 'openmax.connector-create.v1');
  assert.equal(m.type, 'AGENT_STRUCTURED');
  assert.match(m.client_msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(m.content.content_type, 'connector_create_card');
  assert.deepEqual(m.content.attachments, []);
  const body = m.content.body;
  assert.deepEqual(Object.keys(body), ['schema', 'card_id', 'connector', 'actions', 'application_id', 'fallback_text']);
  assert.equal(body.schema, 'openmax.connector-create.v1');
  assert.equal(body.card_id, CARD_ID);
  assert.deepEqual(body.connector, input.connector);
  assert.deepEqual(body.actions, input.actions);
  assert.equal(body.application_id, APP_ID);
  assert.equal(body.fallback_text, m.fallback_text);
  assert.deepEqual(Object.keys(m.metadata), ['context'], 'only the context item, no old connector_create_card key');
  assert.equal(m.metadata.context.items.length, 1);
  const [item] = m.metadata.context.items;
  assert.deepEqual(Object.keys(item), ['type', 'audience', 'data'], 'no source, no empty attrs');
  assert.equal(item.type, 'connector-create-card');
  assert.equal(item.audience, 'ui');
  const meta = item.data;
  assert.deepEqual(meta, {
    schema: 'openmax.connector-create.v1',
    card_id: CARD_ID,
    connector: { name: 'Acme CRM', slug: 'acme-crm', connector_kind: 'http', auth_type: 'oauth2', icon_url: 'https://acme.example.com/icon.png' },
    actions: input.actions,
    application_id: APP_ID,
  });
  assert.notEqual(meta.actions, body.actions, 'metadata is a copy');
  assert.equal(JSON.stringify(m).includes('secret'), false);
});

test('connector-create-card data up to 8 KiB: written in full, every action', () => {
  const size = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  assert.equal(CREATE_CARD_DATA_MAX_BYTES, 8192);
  const actions = Array.from({ length: 20 }, (_, i) => ({
    name: `action_${String(i).padStart(2, '0')}`, effect: i % 2 ? 'write' : 'read', summary: `第 ${i} 个动作：${'说明'.repeat(30)}`,
  }));
  const input = parseCreateCardInput(valid({ actions }));
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  const data = m.metadata.context.items[0].data;
  assert.ok(size(data) > 2048 && size(data) <= 8192, `data is ${size(data)} bytes`);
  assert.deepEqual(data.actions, input.actions, 'all actions, unchanged — over 2 KiB is no longer trimmed');
  assert.deepEqual(m.content.body.actions, input.actions);
});

test('connector-create-card data over 8 KiB: item omitted, never a partial action list', () => {
  const size = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const actions = Array.from({ length: CREATE_CARD_MAX_ACTIONS }, (_, i) => ({
    name: `action_${String(i).padStart(2, '0')}`, effect: i % 2 ? 'write' : 'read', summary: `第 ${i} 个动作：${'说明'.repeat(30)}`,
  }));
  const input = parseCreateCardInput(valid({ actions }));
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  assert.equal('metadata' in m, false, 'no connector-create-card item at all');
  assert.equal(m.content.body.actions.length, actions.length, 'the body keeps every action');
  for (const a of actions) assert.ok(m.fallback_text.includes(a.name), 'fallback text lists every action');
  // exact boundary on the same byte counting as fitsContextDataLimit
  const ofBytes = (n) => { const base = { card_id: CARD_ID, actions: [], pad: '' }; base.pad = 'x'.repeat(n - size(base)); return base; };
  assert.equal(size(ofBytes(8192)), 8192);
  assert.deepEqual(createCardMetadata(ofBytes(8192)).context.items[0].data, ofBytes(8192));
  assert.equal(createCardMetadata(ofBytes(8193)), undefined);
  assert.equal(JSON.stringify(m).includes('"connector-create-card"'), false);
});

test('buildConnectorCreateCardMessage: no application_id → omitted; card_id defaults to a fresh uuid', () => {
  const input = parseCreateCardInput(valid());
  const a = buildConnectorCreateCardMessage(input);
  const b = buildConnectorCreateCardMessage(input);
  assert.equal('application_id' in a.content.body, false);
  assert.equal('application_id' in a.metadata.context.items[0].data, false);
  assert.match(a.content.body.card_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.content.body.card_id, b.content.body.card_id);
  assert.equal(a.metadata.context.items[0].data.card_id, a.content.body.card_id);
});

test('fallback_text: name, slug, auth type, every action with 读/写, reply words', () => {
  const t = buildCreateCardFallbackText(parseCreateCardInput(valid()));
  assert.match(t, /「Acme CRM」（acme-crm）/);
  assert.match(t, /类型：HTTP\n认证方式：OAuth 2\.0/);
  assert.match(t, /- \[读\] list_contacts：列出联系人/);
  assert.match(t, /- \[写\] create_contact：新建联系人/);
  assert.match(t, /动作（2）/);
  assert.match(t, /确认创建 Acme CRM/);
  assert.match(t, /我要改 Acme CRM/);
  assert.match(t, /Client Secret 请在「连接」页面填写/);
  const k = buildCreateCardFallbackText(parseCreateCardInput(withConnector({ auth_type: 'api_key' })));
  assert.match(k, /认证方式：API Key/);
  assert.doesNotMatch(k, /Client Secret/);
});

// --- OAuth endpoint fields (wsb#789) ---------------------------------------------

const OAUTH = {
  oauth_authorize_url: 'https://acme.example.com/oauth/authorize',
  oauth_token_url: 'https://acme.example.com/oauth/token',
  oauth_scopes_default: ['contacts.read', 'contacts.write'],
};
const MCP_BASE = { name: 'Plaud', slug: 'plaud-mcp', connector_kind: 'mcp', server_url: 'https://mcp.plaud.example.com/mcp' };

test('oauth2 card: authorize / token URL + scopes in parse, body, compact copy and fallback text', () => {
  const input = parseCreateCardInput(withConnector({ ...OAUTH, oauth_scopes_default: [' contacts.read ', 'contacts.write'] }));
  assert.equal(input.connector.oauth_authorize_url, OAUTH.oauth_authorize_url);
  assert.equal(input.connector.oauth_token_url, OAUTH.oauth_token_url);
  assert.deepEqual(input.connector.oauth_scopes_default, ['contacts.read', 'contacts.write'], 'scopes trimmed');
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  assert.deepEqual(m.content.body.connector, input.connector);
  const data = m.metadata.context.items[0].data;
  assert.deepEqual(data.connector, {
    name: 'Acme CRM', slug: 'acme-crm', connector_kind: 'http', auth_type: 'oauth2',
    icon_url: 'https://acme.example.com/icon.png', ...OAUTH,
  });
  assert.notEqual(data.connector.oauth_scopes_default, input.connector.oauth_scopes_default, 'copy, not shared array');
  const t = m.fallback_text;
  assert.match(t, /授权地址：https:\/\/acme\.example\.com\/oauth\/authorize\n/);
  assert.match(t, /令牌地址：https:\/\/acme\.example\.com\/oauth\/token\n/);
  assert.match(t, /Scopes：contacts\.read contacts\.write\n/);
  assert.equal(t, m.content.body.fallback_text);
  // each field is optional on its own; absent / null / [] → omitted everywhere
  const one = parseCreateCardInput(withConnector({ oauth_token_url: OAUTH.oauth_token_url, oauth_scopes_default: [] }));
  assert.equal(one.connector.oauth_token_url, OAUTH.oauth_token_url);
  assert.equal('oauth_authorize_url' in one.connector, false);
  assert.equal('oauth_scopes_default' in one.connector, false);
  const none = buildConnectorCreateCardMessage(parseCreateCardInput(withConnector({ oauth_scopes_default: null })), CARD_ID);
  for (const k of Object.keys(OAUTH)) {
    assert.equal(k in none.content.body.connector, false);
    assert.equal(k in none.metadata.context.items[0].data.connector, false);
  }
  assert.doesNotMatch(none.fallback_text, /授权地址|令牌地址|Scopes/);
});

test('OAuth fields: refused (400) unless connector_kind http + auth_type oauth2', () => {
  for (const [k, v] of Object.entries(OAUTH)) {
    rejects400(withConnector({ auth_type: 'api_key', [k]: v }), new RegExp(`connector\\.${k} is only allowed when connector_kind is "http" and auth_type is "oauth2"`));
    rejects400({ conversationId: CONV, connector: { ...MCP_BASE, [k]: v } }, new RegExp(`connector\\.${k} is only allowed`));
  }
  // even an empty value is refused on a non-oauth2 card (the key itself is the mistake)
  rejects400(withConnector({ auth_type: 'api_key', oauth_scopes_default: [] }), /oauth_scopes_default is only allowed/);
  // null counts as present too: the key itself is the mistake
  rejects400(withConnector({ auth_type: 'api_key', oauth_token_url: null }), /oauth_token_url is only allowed/);
  // the mcp card itself stays valid without them
  assert.equal(parseCreateCardInput({ conversationId: CONV, connector: MCP_BASE }).connector.server_url, MCP_BASE.server_url);
});

test('OAuth URLs: same checks as base_url (scheme, credentials, secret query, token values, fragment, length)', () => {
  for (const k of ['oauth_authorize_url', 'oauth_token_url']) {
    rejects400(withConnector({ [k]: 'javascript:alert(1)' }), new RegExp(`connector\\.${k} must be an absolute http\\(s\\) URL`));
    rejects400(withConnector({ [k]: 'not a url' }), new RegExp(k));
    rejects400(withConnector({ [k]: 42 }), new RegExp(`connector\\.${k} must be a string`));
    rejects400(withConnector({ [k]: 'https://u:p@acme.example.com/oauth' }), /credentials/);
    rejects400(withConnector({ [k]: 'https://acme.example.com/oauth#x' }), /fragment/);
    rejects400(withConnector({ [k]: `https://a.example.com/${'x'.repeat(CREATE_CARD_LIMITS.url)}` }), /too long/);
    for (const url of [
      'https://acme.example.com/oauth?client_secret=abc',
      'https://acme.example.com/oauth?x=1;api_key=abc',
      'https://acme.example.com/oauth?code=ghp_abcdefghijklmnopqrstuvwxyz0123',
      'https://acme.example.com/oauth#access_token=abc',
    ]) {
      assert.throws(() => parseCreateCardInput(withConnector({ [k]: url })), (e) => e.status === 400 && e.code === 'secret_field_rejected'
        && e.message.includes(`connector.${k}`) && !e.message.includes('abcdefghijklmnop'), url);
    }
    // normalized href echoed; plain query (client_id-less, response_type) allowed
    assert.equal(parseCreateCardInput(withConnector({ [k]: 'HTTPS://Acme.Example.com/oauth?response_type=code' })).connector[k],
      'https://acme.example.com/oauth?response_type=code');
  }
});

test('OAuth scopes: array of non-empty strings, ≤ CREATE_CARD_MAX_OAUTH_SCOPES, no invisible characters', () => {
  assert.equal(CREATE_CARD_MAX_OAUTH_SCOPES, 50);
  const many = Array.from({ length: 50 }, (_, i) => `scope.${i}`);
  assert.equal(parseCreateCardInput(withConnector({ oauth_scopes_default: many })).connector.oauth_scopes_default.length, 50);
  rejects400(withConnector({ oauth_scopes_default: [...many, 'scope.50'] }), /oauth_scopes_default has too many items \(max 50\)/);
  rejects400(withConnector({ oauth_scopes_default: 'read write' }), /oauth_scopes_default must be an array of strings/);
  // one scope per item: whitespace inside would read as several scopes (RFC 6749 §3.3)
  rejects400(withConnector({ oauth_scopes_default: ['contacts read', 'write'] }), /oauth_scopes_default\[0\] must be a single scope \(no whitespace\)/);
  rejects400(withConnector({ oauth_scopes_default: ['read', 'a\tb'] }), /oauth_scopes_default\[1\]/);
  rejects400(withConnector({ oauth_scopes_default: ['read', 'write', 'read'] }), /oauth_scopes_default has duplicate items/);
  rejects400(withConnector({ oauth_scopes_default: { a: 1 } }), /must be an array of strings/);
  rejects400(withConnector({ oauth_scopes_default: ['read', 42] }), /oauth_scopes_default\[1\] must be a string/);
  rejects400(withConnector({ oauth_scopes_default: ['read', null] }), /oauth_scopes_default\[1\] must be a string/);
  rejects400(withConnector({ oauth_scopes_default: ['read', '  '] }), /oauth_scopes_default\[1\] is required/);
  rejects400(withConnector({ oauth_scopes_default: ['re‮ad'] }), /oauth_scopes_default\[0\] must not contain control/);
  rejects400(withConnector({ oauth_scopes_default: ['a\nb'] }), /control/);
  const cap = CREATE_CARD_LIMITS.oauth_scope;
  assert.equal(parseCreateCardInput(withConnector({ oauth_scopes_default: ['s'.repeat(cap)] })).connector.oauth_scopes_default[0].length, cap);
  rejects400(withConnector({ oauth_scopes_default: ['s'.repeat(cap + 1)] }), /oauth_scopes_default\[0\] is too long/);
});

test('OAuth fields count toward the 8 KiB compact copy: over the limit → item omitted, never trimmed', () => {
  const size = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const scopes = Array.from({ length: CREATE_CARD_MAX_OAUTH_SCOPES }, (_, i) => `https://www.example.com/auth/scope_${String(i).padStart(2, '0')}.${'x'.repeat(150)}`);
  // Without scopes these actions fit; with all 50 long scopes the copy goes over 8 KiB.
  const actions = Array.from({ length: 10 }, (_, i) => ({ name: `action_${i}`, effect: 'read', summary: `动作 ${i}` }));
  const small = buildConnectorCreateCardMessage(parseCreateCardInput(valid({ actions, connector: { ...valid().connector, ...OAUTH } })), CARD_ID);
  assert.ok(small.metadata, 'small oauth card has the copy');
  const bigInput = parseCreateCardInput(valid({ actions, connector: { ...valid().connector, ...OAUTH, oauth_scopes_default: scopes } }));
  const big = buildConnectorCreateCardMessage(bigInput, CARD_ID);
  assert.equal('metadata' in big, false, 'no connector-create-card item');
  assert.deepEqual(big.content.body.connector.oauth_scopes_default, scopes, 'the body keeps every scope');
  assert.ok(big.fallback_text.includes(scopes.join(' ')), 'fallback text lists every scope');
  // the would-be copy is indeed over the limit, and the item is not partially written
  const wouldBe = { schema: CONNECTOR_CREATE_CARD_SCHEMA, card_id: CARD_ID, connector: { ...bigInput.connector }, actions };
  delete wouldBe.connector.description; delete wouldBe.connector.base_url;
  assert.ok(size(wouldBe) > CREATE_CARD_DATA_MAX_BYTES, `copy is ${size(wouldBe)} bytes`);
  // boundary: the largest scope count whose copy fits is written in full
  // (every scope); one more scope and the whole item is omitted.
  const build = (k) => buildConnectorCreateCardMessage(parseCreateCardInput(valid({ actions, connector: { ...valid().connector, ...OAUTH, oauth_scopes_default: scopes.slice(0, k) } })), CARD_ID);
  let n = scopes.length;
  while (n > 0 && !build(n).metadata) n -= 1;
  assert.ok(n > 0 && n < scopes.length, `boundary at ${n} scopes`);
  const data = build(n).metadata.context.items[0].data;
  assert.deepEqual(data.connector.oauth_scopes_default, scopes.slice(0, n));
  assert.ok(size(data) <= CREATE_CARD_DATA_MAX_BYTES && size(data) > CREATE_CARD_DATA_MAX_BYTES - 250, `copy is ${size(data)} bytes`);
  assert.equal('metadata' in build(n + 1), false);
});

// --- send path ------------------------------------------------------------------

test('sendConnectorCard: auth_notice and create_card share one send path (POST conversation messages)', async () => {
  const calls = [];
  const post = async (...args) => { calls.push(args); return { id: 'msg-9' }; };
  const notice = buildConnectorAuthNoticeMessage([{ name: 'Notion', slug: 'notion' }]);
  await sendConnectorCard('org-1', CONV, notice, post);
  const out = await runCreateCard(valid(), { resolveOrg: () => 'org-1', post, cardId: CARD_ID });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c[0], 'org-1');
    assert.match(c[1], new RegExp(`/conversations/${CONV}/messages$`));
    assert.deepEqual(c[3], { timeoutMs: 30_000, quietOnSuccess: true });
  }
  assert.equal(calls[1][2].content.body.card_id, CARD_ID);
  assert.deepEqual(out, {
    status: 'sent', conversation_id: CONV, card_id: CARD_ID, message_id: 'msg-9',
    connector: { name: 'Acme CRM', slug: 'acme-crm', connector_kind: 'http', auth_type: 'oauth2' }, actions_total: 2,
  });
});

test('runCreateCard: invalid / secret input → nothing sent, org not resolved', async () => {
  let posted = 0; let resolved = 0;
  const deps = { resolveOrg: () => { resolved += 1; return 'org-1'; }, post: async () => { posted += 1; } };
  await assert.rejects(runCreateCard(withConnector({ client_secret: 'x' }), deps), (e) => e.code === 'secret_field_rejected');
  await assert.rejects(runCreateCard(withConnector({ auth_type: 'basic' }), deps), (e) => e.status === 400);
  await assert.rejects(runCreateCard(validMcp({ auth_type: 'mcp' }), deps), (e) => e.status === 400);
  assert.equal(posted, 0);
  assert.equal(resolved, 0);
});

// --- CLI end to end (subprocess + fake cws-core) -----------------------------

function setupHome(orgId = 'org-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cc-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { [orgId]: { enabled: true, org_id: orgId, self: { member_id: 'm-self' } } },
  }));
  return home;
}

function runConn(home, params, apiUrl) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
    execFile(process.execPath, [cliPath, 'conn.create_card', JSON.stringify(params)], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function runWithServer(params) {
  const posted = [];
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === `/api/v1/conversations/${CONV}/messages`) {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        posted.push(JSON.parse(buf));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'msg-1' }, request_id: 'r-p' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r9"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await runConn(setupHome(), params, `http://127.0.0.1:${server.address().port}`);
    return { ...r, posted, seen };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('conn.create_card CLI: posts the card and prints card_id + message_id', async () => {
  const { code, stdout, stderr, posted, seen } = await runWithServer(valid());
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'sent');
  assert.equal(out.message_id, 'msg-1');
  assert.equal(seen.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].content.body.schema, 'openmax.connector-create.v1');
  assert.equal(posted[0].content.body.card_id, out.card_id);
  assert.equal(posted[0].metadata.context.items[0].data.card_id, out.card_id);
});

test('conn.create_card CLI: secret in input → exit 1, 400, nothing sent', async () => {
  const p = valid();
  p.connector.oauth_client_secret = 'shh-very-secret';
  const { code, stderr, seen } = await runWithServer(p);
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'secret_field_rejected');
  assert.doesNotMatch(stderr, /shh-very-secret/);
  assert.equal(seen.length, 0);
});
