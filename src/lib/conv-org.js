/**
 * Conversation → org (and conversation type) mapping, shared by every process.
 *
 * The PM2 comm-bridge service knows which org each conversation belongs to
 * (via the per-org WS connection). Stateless CLI processes (scripts/send.js,
 * scripts/session-group.js, src/cli/comm.js) don't — they need a persistent
 * mapping to resolve the correct org-scoped JWT. This module provides that
 * shared mapping.
 *
 * File: <component>/runtime/conv-org-map.json
 * Shape: { [conversationId]: { orgId, ts, type?, parentId?, sub?, ownerKind? } }
 *   type      — the platform's conversation type as given (DM / GROUP / STRAT …)
 *   parentId  — parent_conversation_id, when the record has one
 *   sub       — true when the record has a non-empty context_owner_kind
 *               (a sub-conversation)
 *   ownerKind — context_owner_kind when it is `platform` (a platform topic) or
 *               `app` (an app sub-conversation). Entries written by 2.36.x and
 *               earlier have `sub` without it; registerConvOrg fills it in the
 *               next time the record is seen.
 * Only fields that never change for a conversation are stored (a
 * sub-conversation's parent and type are fixed at creation); names, members
 * and the like are fetched when needed.
 *
 * Retention: an entry WITH a type is kept for good (it is how a bare id and a
 * conversation whose record cannot be fetched get their type, and a type
 * never changes). An entry without one (org only) is pruned once it has not
 * been seen for MAX_AGE_MS, as before.
 *
 * Several processes write this file (the bridge, send.js, the session-group
 * query, comm.js). Every write re-reads the file and merges into it before
 * the atomic rename, so one process does not overwrite the entries another
 * one added. Entries never change, so the merge has no conflicts; in a rare
 * interleaving one write can still be lost, which costs one more API lookup.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const MAP_PATH = path.join(HOME, 'zylos/components/openmax/runtime/conv-org-map.json');

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (entries without a type)

let _cache = null;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function readMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    // Migrate v1 format (plain orgId string) to v2 (object with ts)
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        map[k] = { orgId: v, ts: Date.now() };
      } else if (v && typeof v === 'object') {
        map[k] = v;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function pruneStale(map) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const k of Object.keys(map)) {
    if (nonEmptyString(map[k].type)) continue;
    if ((map[k].ts || 0) < cutoff) delete map[k];
  }
}

function persistMap(map) {
  try {
    fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
    const tmp = `${MAP_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, MAP_PATH);
  } catch {
    // best-effort
  }
}

/** Stored owner kinds (context_owner_kind values the platform writes). */
const OWNER_KINDS = new Set(['app', 'platform']);

/** Whether an entry's type fields are complete: typed, and a sub-conversation knows its owner kind. */
function completeTypeFields(entry) {
  return !!entry && nonEmptyString(entry.type) && (entry.sub !== true || OWNER_KINDS.has(entry.ownerKind));
}

/**
 * Keep the type fields of whichever entry has them (a complete set over one
 * without the owner kind); the newer `ts` and its org.
 */
function mergeEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (b.ts || 0) >= (a.ts || 0) ? b : a;
  const typed = completeTypeFields(b) && !completeTypeFields(a) ? b
    : nonEmptyString(a.type) ? a : (nonEmptyString(b.type) ? b : null);
  const out = { ...newer };
  delete out.type; delete out.parentId; delete out.sub; delete out.ownerKind;
  if (typed) Object.assign(out, typeFields(typed));
  return out;
}

function typeFields(entry) {
  const out = { type: entry.type };
  if (nonEmptyString(entry.parentId)) out.parentId = entry.parentId;
  if (entry.sub === true) out.sub = true;
  if (entry.sub === true && OWNER_KINDS.has(entry.ownerKind)) out.ownerKind = entry.ownerKind;
  return out;
}

/**
 * The fields of a conversation record (GET /conversations/{id}) this file
 * keeps: `{type, parentId?, sub?, ownerKind?}`, or null when the record has
 * no type.
 * @param {object|null|undefined} conv
 * @returns {{type:string, parentId?:string, sub?:true, ownerKind?:'app'|'platform'}|null}
 */
export function convRecordFields(conv) {
  if (!conv || typeof conv !== 'object' || !nonEmptyString(conv.type)) return null;
  const out = { type: conv.type.trim() };
  if (nonEmptyString(conv.parent_conversation_id)) out.parentId = conv.parent_conversation_id;
  if (nonEmptyString(conv.context_owner_kind)) {
    out.sub = true;
    const kind = conv.context_owner_kind.trim();
    if (OWNER_KINDS.has(kind)) out.ownerKind = kind;
  }
  return out;
}

/**
 * Register a conversation → org mapping, and its type fields when known
 * (`fields` from convRecordFields). Called by comm-bridge on every inbound
 * message, by send.js / the session-group query after an org or type lookup,
 * and by comm.create_dm / create_group. Writes to disk when the entry is new,
 * its org changed, or its type fields appear for the first time; otherwise only
 * the in-memory timestamp moves.
 */
export function registerConvOrg(conversationId, orgId, fields) {
  if (!conversationId || !orgId) return;
  const typed = fields && nonEmptyString(fields.type) ? typeFields(fields) : null;
  const map = _cache || readMap();
  const existing = map[conversationId];
  const now = Date.now();
  // Up to date: same org, and nothing new to add (no type given, or the stored
  // type fields are already complete — an older entry may lack ownerKind).
  if (existing && existing.orgId === orgId
      && (!typed || completeTypeFields(existing) || (nonEmptyString(existing.type) && !completeTypeFields(typed)))) {
    existing.ts = now;
    _cache = map;
    return;
  }
  map[conversationId] = mergeEntry(existing, { orgId, ts: now, ...(typed || {}) });
  // Re-read and merge before the write, so entries other processes added since
  // this one last read the file are kept.
  const disk = readMap();
  for (const [k, v] of Object.entries(map)) disk[k] = mergeEntry(disk[k], v);
  disk[conversationId] = mergeEntry(disk[conversationId], map[conversationId]);
  pruneStale(disk);
  _cache = disk;
  persistMap(disk);
}

/**
 * Look up which org a conversation belongs to. Used by CLI send to resolve
 * the correct org-scoped token. Returns orgId or empty string.
 */
export function lookupConvOrg(conversationId) {
  if (!conversationId) return '';
  const map = readMap();
  const entry = map[conversationId];
  if (!entry) return '';
  return (typeof entry === 'string') ? entry : (entry.orgId || '');
}

/**
 * The stored type fields of a conversation: `{orgId, type, parentId?, sub?, ownerKind?}`,
 * or null when none are stored. Memory first (an entry with a type never
 * changes), then the file.
 * @param {string} conversationId
 */
export function lookupConvRecord(conversationId) {
  if (!conversationId) return null;
  let entry = _cache?.[conversationId];
  if (!entry || !nonEmptyString(entry.type)) {
    const fromFile = readMap()[conversationId];
    if (fromFile && nonEmptyString(fromFile.type) && _cache) _cache[conversationId] = mergeEntry(_cache[conversationId], fromFile);
    entry = fromFile;
  }
  if (!entry || !nonEmptyString(entry.type)) return null;
  return { orgId: entry.orgId || '', ...typeFields(entry) };
}

export { MAP_PATH as CONV_ORG_MAP_PATH };
