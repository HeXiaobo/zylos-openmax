/**
 * Connector effect classification + the local effect log (OPENM-1239).
 *
 * Every conn.invoke is classified BEFORE the write-confirmation switch is
 * looked at, whatever the switch says, and every call appends one line to the
 * effect log. The classification decides whether a call needs the requester's
 * confirmation (connector-confirm.js); the log lets a human spot-check the
 * name-based Composio guesses later (`conn.effect_log`).
 *
 * Effects:
 *   read              — reads only (GET / GraphQL query / Composio read verb)
 *   write             — changes data at the provider
 *   outbound_message  — sends something to a third party (an invoice email, a
 *                       chat message); a write that also reaches outside
 *
 * Anything this module cannot positively identify as a read is a write: a
 * wrong "write" costs one extra click, a wrong "read" skips a confirmation.
 *
 * Pure apart from appendEffectLog / readEffectLog (file I/O, path injectable).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evalTemplate, isMissing } from './request-spec/template.js';

export const EFFECTS = Object.freeze(['read', 'write', 'outbound_message']);

/**
 * Actions that send something to a third party, matched as a suffix of the
 * action name. Shopify has two: REST `shopify-draft-orders/send-invoice` and
 * GraphQL `shopify-app-draft-orders/send-invoice` — both end with this.
 */
export const OUTBOUND_ACTIONS = Object.freeze(['draft-orders/send-invoice']);

/** Composio name words: any of these anywhere → outbound_message. */
export const COMPOSIO_OUTBOUND_WORDS = Object.freeze(['SEND', 'POST', 'REPLY', 'INVITE', 'SHARE', 'PUBLISH', 'NOTIFY']);

/** Composio name: first word one of these (and no outbound word) → read. */
export const COMPOSIO_READ_VERBS = Object.freeze([
  'GET', 'LIST', 'SEARCH', 'FIND', 'FETCH', 'RETRIEVE', 'QUERY', 'COUNT', 'DESCRIBE', 'READ', 'LOOKUP', 'CHECK',
]);

const READ_METHODS = new Set(['GET', 'HEAD']);

// ---------------------------------------------------------------------------
//  GraphQL
// ---------------------------------------------------------------------------

/**
 * GraphQL lexer (spec "Lexical Tokens", October 2021, as graphql-js 16 reads
 * it), just enough to find the top-level definitions of a document. Returns
 * the tokens, or null when the document is not lexically valid: an unclosed
 * string or block string, a bad escape (single-line strings: \" \\ \/ \b \f
 * \n \r \t \uXXXX \u{X…}; block strings: only \""" — every other backslash
 * is literal), a line terminator inside a single-line string, a lone
 * surrogate, a lone `.`, a number directly followed by a name or `.`, or any
 * character that is not a GraphQL token. The caller treats null as a write.
 *
 * Token: { t: "name" | "punct" | "value", v }.
 */
function lexGraphql(doc) {
  const tokens = [];
  const n = doc.length;
  const isNameStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isDigit = (c) => c >= '0' && c <= '9';
  const isHex = (c) => /^[0-9A-Fa-f]$/.test(c);
  // A SourceCharacter (any Unicode scalar value) inside a string or comment:
  // a lone surrogate is invalid. Line terminators are handled by the caller.
  // Returns the index after the character, or -1 when it is invalid.
  const sourceChar = (i) => {
    const code = doc.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = doc.charCodeAt(i + 1);
      return next >= 0xdc00 && next <= 0xdfff ? i + 2 : -1;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return -1;
    return i + 1;
  };
  let i = 0;
  while (i < n) {
    const ch = doc[i];
    // Ignored tokens: BOM, whitespace, line terminators, commas, comments.
    if (ch === '﻿' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      i += 1;
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') {
        const next = sourceChar(i);
        if (next < 0) return null;
        i = next;
      }
      continue;
    }
    if (ch === '"') {
      if (doc.startsWith('"""', i)) {
        // Block string: only \""" is an escape; every other backslash is
        // literal. It ends at the first """ not preceded by that escape.
        i += 3;
        let closed = false;
        while (i < n) {
          if (doc.startsWith('\\"""', i)) { i += 4; continue; }
          if (doc.startsWith('"""', i)) { i += 3; closed = true; break; }
          const next = sourceChar(i);
          if (next < 0) return null;
          i = next;
        }
        if (!closed) return null;
        tokens.push({ t: 'value', v: 'block_string' });
        continue;
      }
      // Single-line string: ends at an unescaped "; a line terminator (or
      // the end of the document) before that makes it malformed.
      i += 1;
      let closed = false;
      while (i < n) {
        const c = doc[i];
        if (c === '"') { i += 1; closed = true; break; }
        if (c === '\n' || c === '\r') return null;
        if (c === '\\') {
          const e = doc[i + 1];
          if (e === '"' || e === '\\' || e === '/' || e === 'b' || e === 'f' || e === 'n' || e === 'r' || e === 't') { i += 2; continue; }
          if (e === 'u') {
            if (doc[i + 2] === '{') {
              let j = i + 3;
              while (j < n && isHex(doc[j])) j += 1;
              if (j === i + 3 || doc[j] !== '}') return null;
              const cp = Number.parseInt(doc.slice(i + 3, j), 16);
              if (!(cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
              i = j + 1;
              continue;
            }
            const hex = doc.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
            const cu = Number.parseInt(hex, 16);
            if (cu >= 0xdc00 && cu <= 0xdfff) return null; // lone trailing surrogate
            if (cu >= 0xd800 && cu <= 0xdbff) {
              // A leading surrogate is valid only as the first half of a pair.
              const low = /^\\u([0-9A-Fa-f]{4})/.exec(doc.slice(i + 6, i + 12));
              const lo = low ? Number.parseInt(low[1], 16) : -1;
              if (!(lo >= 0xdc00 && lo <= 0xdfff)) return null;
              i += 12;
              continue;
            }
            i += 6;
            continue;
          }
          return null;
        }
        const next = sourceChar(i);
        if (next < 0) return null;
        i = next;
      }
      if (!closed) return null;
      tokens.push({ t: 'value', v: 'string' });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < n && (isNameStart(doc[j]) || isDigit(doc[j]))) j += 1;
      tokens.push({ t: 'name', v: doc.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      // IntValue / FloatValue: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?, not
      // directly followed by a name start, a digit or a dot.
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(doc.slice(i, i + 4096));
      if (!m) return null;
      const j = i + m[0].length;
      if (j < n && (isNameStart(doc[j]) || isDigit(doc[j]) || doc[j] === '.')) return null;
      tokens.push({ t: 'value', v: 'number' });
      i = j;
      continue;
    }
    if (ch === '.') {
      if (!doc.startsWith('...', i)) return null;
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{|}'.includes(ch)) {
      tokens.push({ t: 'punct', v: ch });
      i += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class GraphqlSyntaxError extends Error {}

/**
 * Recursive-descent check of the executable-definition grammar (spec
 * "Document", "Operations", "Selection Sets", "Fragments", "Input Values",
 * "Variables", "Directives") over the lexer's tokens. Records the type of
 * each top-level definition in `ops`; throws GraphqlSyntaxError on anything
 * that is not valid. A type-system definition (`type`, `schema`, `extend`,
 * …) is recorded as "other" and parsing stops there: it is a write anyway.
 */
function parseExecutable(tokens, ops) {
  let p = 0;
  const peek = () => tokens[p];
  const fail = () => { throw new GraphqlSyntaxError('malformed'); };
  const isPunct = (v) => peek()?.t === 'punct' && peek().v === v;
  const isName = (v) => peek()?.t === 'name' && (v === undefined || peek().v === v);
  const expectPunct = (v) => { if (!isPunct(v)) fail(); p += 1; };
  const expectName = () => { if (!isName()) fail(); p += 1; };
  const many = (open, close, item) => {
    expectPunct(open);
    do item(); while (!isPunct(close));
    p += 1;
  };
  const value = (isConst) => {
    const tok = peek();
    if (!tok) fail();
    if (tok.t === 'value' || tok.t === 'name') { p += 1; return; }
    if (tok.v === '$') { if (isConst) fail(); p += 1; expectName(); return; }
    if (tok.v === '[') { p += 1; while (!isPunct(']')) value(isConst); p += 1; return; }
    if (tok.v === '{') {
      p += 1;
      while (!isPunct('}')) { expectName(); expectPunct(':'); value(isConst); }
      p += 1;
      return;
    }
    fail();
  };
  const args = (isConst) => {
    if (!isPunct('(')) return;
    many('(', ')', () => { expectName(); expectPunct(':'); value(isConst); });
  };
  const directives = (isConst) => {
    while (isPunct('@')) { p += 1; expectName(); args(isConst); }
  };
  const type = () => {
    if (isPunct('[')) { p += 1; type(); expectPunct(']'); } else expectName();
    if (isPunct('!')) p += 1;
  };
  const typeCondition = () => { if (!isName('on')) fail(); p += 1; expectName(); };
  const selectionSet = () => {
    many('{', '}', () => {
      if (isPunct('...')) {
        p += 1;
        if (isName() && !isName('on')) { p += 1; directives(false); return; } // fragment spread
        if (isName('on')) typeCondition();
        directives(false);
        selectionSet();
        return;
      }
      expectName();
      if (isPunct(':')) { p += 1; expectName(); } // alias
      args(false);
      directives(false);
      if (isPunct('{')) selectionSet();
    });
  };
  while (p < tokens.length) {
    if (isPunct('{')) { ops.push('shorthand'); selectionSet(); continue; }
    if (isName('query') || isName('mutation') || isName('subscription')) {
      ops.push(peek().v);
      p += 1;
      if (isName()) p += 1;
      if (isPunct('(')) {
        many('(', ')', () => {
          expectPunct('$'); expectName(); expectPunct(':'); type();
          if (isPunct('=')) { p += 1; value(true); }
          directives(true);
        });
      }
      directives(false);
      selectionSet();
      continue;
    }
    if (isName('fragment')) {
      ops.push('fragment');
      p += 1;
      if (isName('on')) fail();
      expectName();
      typeCondition();
      directives(false);
      selectionSet();
      continue;
    }
    ops.push('other');
    return;
  }
}

/**
 * The top-level definitions of a GraphQL document, in order, and whether the
 * document is malformed: { ops, malformed }. ops entries: "query" |
 * "mutation" | "subscription" | "fragment" | "shorthand" (an anonymous
 * `{ … }` query) | "other". Strings, block strings and comments are lexed as
 * the spec defines them, so a `mutation` inside one is not a mutation.
 *
 * Malformed — anything the lexer rejects (an unclosed string or block
 * string, a bad escape, an unexpected character) or the executable grammar
 * does not accept (unbalanced or mismatched brackets, a missing selection
 * set, a stray token) — is reported so the caller fails closed (write).
 */
export function graphqlDocumentShape(doc) {
  if (typeof doc !== 'string') return { ops: [], malformed: true };
  const tokens = lexGraphql(doc);
  if (tokens === null) return { ops: [], malformed: true };
  const ops = [];
  try {
    parseExecutable(tokens, ops);
  } catch (err) {
    // GraphqlSyntaxError, or a RangeError from absurd nesting: both malformed.
    return { ops, malformed: true };
  }
  return { ops, malformed: false };
}

/**
 * The operation types defined at the top level of a GraphQL document, in
 * order (see graphqlDocumentShape). A malformed document yields its
 * definitions so far plus "malformed".
 */
export function graphqlTopLevelOperations(doc) {
  const { ops, malformed } = graphqlDocumentShape(doc);
  return malformed ? [...ops, 'malformed'] : ops;
}

/**
 * read when the document is well formed and every operation in it is a query
 * (named or shorthand; fragments are neutral) and there is at least one;
 * write otherwise (mutation, subscription, unknown, empty, malformed).
 */
export function classifyGraphqlDocument(doc) {
  const { ops, malformed } = graphqlDocumentShape(doc);
  if (ops.includes('mutation')) return { effect: 'write', kind: 'mutation' };
  if (malformed) return { effect: 'write', kind: 'malformed' };
  const operations = ops.filter((o) => o !== 'fragment');
  if (operations.length === 0) return { effect: 'write', kind: 'unknown' };
  if (operations.every((o) => o === 'query' || o === 'shorthand')) return { effect: 'read', kind: 'query' };
  return { effect: 'write', kind: operations.find((o) => o !== 'query' && o !== 'shorthand') };
}

function parseSpec(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
  }
  return null;
}

function urlPath(template) {
  const s = String(template || '');
  return s.split('?')[0].split('#')[0].replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
//  Composio names
// ---------------------------------------------------------------------------

/**
 * The words of a Composio action name with the toolkit removed:
 * `googlesheets/GOOGLESHEETS_GET_SPREADSHEET_INFO` (slug googlesheets) →
 * ["GET","SPREADSHEET","INFO"]. Without a matching slug prefix the first
 * `_` segment is dropped (it is the toolkit by Composio convention); a
 * one-word name is kept whole.
 */
export function composioWords(action, slug) {
  let name = String(action || '');
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.toUpperCase();
  const prefix = slug ? `${String(slug).toUpperCase().replace(/-/g, '_')}_` : '';
  if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);
  else if (name.includes('_')) name = name.slice(name.indexOf('_') + 1);
  return name.split(/[_\s-]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
//  classifyEffect
// ---------------------------------------------------------------------------

/**
 * Render a request_spec `body.query` template from the call's params only,
 * the same evaluator direct execution uses. null when that would not match
 * what is sent: the spec has prefetch steps or file params (their values only
 * exist at send time), the template fails, or it yields no string.
 */
function renderSpecQuery(template, spec, params) {
  if (spec.prefetch || spec.files) return null;
  try {
    const v = evalTemplate(template, { params: params && typeof params === 'object' ? params : {}, prefetch: {}, files: {} });
    return !isMissing(v) && typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} call
 * @param {string} [call.mode]       credential mode: "direct" | "proxy" | other/unknown
 * @param {string} [call.slug]       connection app slug (Composio prefix stripping)
 * @param {string} call.action       the action name passed to conn.invoke
 * @param {object|null} [call.actionDef]  the direct catalog entry (method, url_template, request_spec)
 * @param {object} [call.params]     the call's params (GraphQL documents: params.query, or a templated request_spec body.query rendered from them)
 * @returns {{effect: string, basis: string, verb?: string}}
 */
export function classifyEffect({ mode, slug, action, actionDef = null, params = {} } = {}) {
  const name = String(action || '');
  if (OUTBOUND_ACTIONS.some((suffix) => name === suffix || name.endsWith(`-${suffix}`) || name.endsWith(`/${suffix}`))) {
    return { effect: 'outbound_message', basis: 'outbound_const' };
  }

  if (mode === 'proxy') {
    const words = composioWords(name, slug);
    const verb = words[0] || '';
    if (words.some((w) => COMPOSIO_OUTBOUND_WORDS.includes(w))) {
      return { effect: 'outbound_message', basis: 'composio_name:outbound_word', verb };
    }
    if (COMPOSIO_READ_VERBS.includes(verb)) return { effect: 'read', basis: 'composio_name:read_verb', verb };
    return { effect: 'write', basis: 'composio_name:default_write', verb };
  }

  if (mode !== 'direct' || !actionDef || typeof actionDef !== 'object') {
    return { effect: 'write', basis: 'fallback_write' };
  }

  const method = String(actionDef.method || 'GET').toUpperCase();
  const spec = parseSpec(actionDef.request_spec);
  const specQuery = spec && spec.body && typeof spec.body === 'object' ? spec.body.query : undefined;
  if (typeof specQuery === 'string') {
    if (!specQuery.includes('{{')) {
      const g = classifyGraphqlDocument(specQuery);
      return { effect: g.effect, basis: `graphql:${g.kind}` };
    }
    // A templated document ("{{query}}", "query Q {{body}}"): classify the
    // document as it will be sent, rendered from the call's params. Anything
    // that cannot be rendered here exactly as at send time is a write.
    const rendered = renderSpecQuery(specQuery, spec, params);
    if (rendered === null) return { effect: 'write', basis: 'graphql:templated_unresolved' };
    const g = classifyGraphqlDocument(rendered);
    return { effect: g.effect, basis: `graphql:rendered:${g.kind}` };
  }
  // A GraphQL endpoint whose document comes from the caller (linear-graphql/
  // query): POST, no request_spec, URL ending in /graphql, params.query a string.
  if (!spec && method === 'POST' && /\/graphql$/i.test(urlPath(actionDef.url_template))
      && params && typeof params.query === 'string') {
    const g = classifyGraphqlDocument(params.query);
    return { effect: g.effect, basis: `graphql:param_doc:${g.kind}` };
  }
  return { effect: READ_METHODS.has(method) ? 'read' : 'write', basis: `rest:${method}` };
}

// ---------------------------------------------------------------------------
//  Parameter digest
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** "sha256:<hex>" of the canonical JSON of the params (absent params = {}). */
export function paramsDigest(params) {
  const p = params === undefined || params === null ? {} : params;
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(p)).digest('hex')}`;
}

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
//  Effect log
// ---------------------------------------------------------------------------

/** Rotate at this size to `<file>.1` (one rolled copy kept). */
export const EFFECT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function effectLogPath(env = process.env) {
  if (env.OPENMAX_CONN_EFFECT_LOG) return env.OPENMAX_CONN_EFFECT_LOG;
  return path.join(env.HOME || os.homedir(), 'zylos', 'components', 'openmax', 'logs', 'conn-effect.jsonl');
}

/** Fields written to the log. Params and their values are never logged. */
export const EFFECT_LOG_FIELDS = Object.freeze([
  'event', 'org_id', 'org', 'agent_member_id', 'connection_id', 'app', 'application_id', 'mode', 'action',
  'effect', 'basis', 'verb', 'confirm_enabled', 'in_scope', 'gate', 'card_message_id', 'action_index',
  'confirmer', 'requester_member_id', 'external_by', 'external_at', 'external_agent_at', 'external_evidence', 'policy_warning', 'result', 'status_code',
  'error_status', 'error_code',
  // conn.confirm_config audit lines (allowed and denied attempts)
  'change', 'decision', 'reason', 'loosening', 'initiator_member_id', 'initiator',
]);

function cleanValue(v) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.length > 512 ? `${v.slice(0, 512)}…` : v;
  if (typeof v === 'object') {
    try { const s = JSON.stringify(v); return s.length > 2048 ? `${s.slice(0, 2048)}…` : JSON.parse(s); } catch { return undefined; }
  }
  return undefined;
}

export function buildEffectLogRecord(fields, now = new Date()) {
  const rec = { ts: now.toISOString() };
  for (const k of EFFECT_LOG_FIELDS) {
    if (fields?.[k] === undefined) continue;
    const v = cleanValue(fields[k]);
    if (v !== undefined) rec[k] = v;
  }
  return rec;
}

/** Append one line. Best-effort: a write failure never changes the call's outcome. */
export function appendEffectLog(fields, { file = effectLogPath(), now = new Date(), maxBytes = EFFECT_LOG_MAX_BYTES } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    fs.appendFileSync(file, `${JSON.stringify(buildEffectLogRecord(fields, now))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

/** Every parseable record, oldest first (the rolled `.1` copy, then the live file). */
export function readEffectLog({ file = effectLogPath() } = {}) {
  const out = [];
  for (const line of [...readLines(`${file}.1`), ...readLines(file)]) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); } catch { /* skip */ }
  }
  return out;
}

function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  const t = Date.parse(String(since));
  if (Number.isNaN(t)) throw Object.assign(new Error(`since must be an ISO date or date-time, got ${JSON.stringify(since)}`), { status: 400 });
  return t;
}

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

/**
 * Summary for `conn.effect_log`: invoke lines filtered by `since` and `mode`,
 * counted by effect / basis / gate and by action, plus the most recent
 * samples. Config-change audit lines are listed separately.
 */
export function summarizeEffectLog(records, { since, mode, limit = 20 } = {}) {
  const from = parseSince(since);
  const keep = records.filter((r) => {
    if (from !== null && !(Date.parse(r.ts) >= from)) return false;
    return true;
  });
  const invokes = keep.filter((r) => (r.event || 'invoke') === 'invoke' && (!mode || r.mode === mode));
  const configChanges = keep.filter((r) => r.event === 'confirm_config');
  const byEffect = {};
  const byBasis = {};
  const byGate = {};
  const byAction = {};
  for (const r of invokes) {
    bump(byEffect, r.effect || 'unknown');
    bump(byBasis, r.basis || 'unknown');
    bump(byGate, String(r.gate || 'unknown').split(':').slice(0, 2).join(':'));
    const key = `${r.app || '?'} ${r.action || '?'}`;
    if (!byAction[key]) byAction[key] = { app: r.app || null, action: r.action || null, mode: r.mode || null, count: 0, effects: {}, bases: {} };
    byAction[key].count += 1;
    bump(byAction[key].effects, r.effect || 'unknown');
    bump(byAction[key].bases, r.basis || 'unknown');
  }
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  return {
    total: invokes.length,
    filters: { since: since ?? null, mode: mode ?? null },
    by_effect: byEffect,
    by_basis: byBasis,
    by_gate: byGate,
    by_action: Object.values(byAction).sort((a, b) => b.count - a.count),
    recent: invokes.slice(-n),
    config_changes: configChanges.slice(-n),
  };
}
