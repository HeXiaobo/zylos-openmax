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
 * The operation types defined at the top level of a GraphQL document, in
 * order: "query" | "mutation" | "subscription" | "fragment" | "shorthand"
 * (an anonymous `{ … }` query) | "other". Comments and string literals are
 * skipped, so a `mutation` inside a string or a comment is not a mutation.
 * Template placeholders (`{{x}}`) only nest braces and are harmless.
 */
export function graphqlTopLevelOperations(doc) {
  const ops = [];
  if (typeof doc !== 'string') return ops;
  let depth = 0;      // { } nesting
  let parens = 0;     // ( ) nesting (variable definitions, arguments)
  let atStart = true; // next top-level token starts a definition
  let i = 0;
  const n = doc.length;
  while (i < n) {
    const ch = doc[i];
    if (ch === '#') { while (i < n && doc[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      if (doc.startsWith('"""', i)) {
        const end = doc.indexOf('"""', i + 3);
        i = end < 0 ? n : end + 3;
        continue;
      }
      i += 1;
      while (i < n && doc[i] !== '"' && doc[i] !== '\n') { if (doc[i] === '\\') i += 1; i += 1; }
      i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (ch === '{') {
      if (depth === 0 && parens === 0 && atStart) { ops.push('shorthand'); }
      depth += 1; atStart = false; i += 1; continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && parens === 0) atStart = true;
      i += 1; continue;
    }
    if (ch === '(') { parens += 1; i += 1; continue; }
    if (ch === ')') { parens = Math.max(0, parens - 1); i += 1; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(doc[j])) j += 1;
      const word = doc.slice(i, j);
      if (depth === 0 && parens === 0 && atStart) {
        ops.push(['query', 'mutation', 'subscription', 'fragment'].includes(word) ? word : 'other');
        atStart = false;
      }
      i = j;
      continue;
    }
    // Any other punctuation (: ! $ @ = [ ] …) at the definition start is not
    // a known definition.
    if (depth === 0 && parens === 0 && atStart) { ops.push('other'); atStart = false; }
    i += 1;
  }
  return ops;
}

/**
 * read when every operation in the document is a query (named or shorthand;
 * fragments are neutral) and there is at least one; write otherwise
 * (mutation, subscription, unknown, empty).
 */
export function classifyGraphqlDocument(doc) {
  const ops = graphqlTopLevelOperations(doc);
  const operations = ops.filter((o) => o !== 'fragment');
  if (operations.length === 0) return { effect: 'write', kind: 'unknown' };
  if (operations.includes('mutation')) return { effect: 'write', kind: 'mutation' };
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
 * @param {object} call
 * @param {string} [call.mode]       credential mode: "direct" | "proxy" | other/unknown
 * @param {string} [call.slug]       connection app slug (Composio prefix stripping)
 * @param {string} call.action       the action name passed to conn.invoke
 * @param {object|null} [call.actionDef]  the direct catalog entry (method, url_template, request_spec)
 * @param {object} [call.params]     the call's params (only `query` is read, for GraphQL param documents)
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
    const g = classifyGraphqlDocument(specQuery);
    return { effect: g.effect, basis: `graphql:${g.kind}` };
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
  'confirmer', 'requester_member_id', 'external_by', 'external_at', 'policy_warning', 'result', 'status_code',
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
