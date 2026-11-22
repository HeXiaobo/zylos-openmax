/**
 * Message context (metadata.context, phase 1, OPENM-1351).
 *
 * One metadata key carries the context attached to a message:
 *
 *   metadata.context = { items: [{ type, source, audience, attrs, data? }] }
 *
 *   - type     what the item is (connectors, workflow, quote, forwarded, or
 *              another type; only those four are read here, plus phase 2's
 *              `priority`, read by system-message.js);
 *   - source   who attached it, stamped by cws-comm (not read here);
 *   - audience who it is for (`agent` | `ui` | `server`); only `agent` items
 *              are read for the Agent;
 *   - attrs    a flat map of scalar values;
 *   - data     an optional JSON object for nested or long content.
 *
 * There is no version field: unknown types and unknown fields are ignored, and
 * anything with an unexpected shape drops only that item (or that attribute or
 * data), never the message.
 *
 * The envelope does not change: each registered type is read here and handed
 * to the existing reader, context first and the old key as fallback
 * (connector-preference.js, wf-context.js, quote-excerpt.js), which renders it
 * through its existing element with its existing wording, so the same data
 * renders byte-identically whichever key carried it; the envelope is
 * unchanged. A `forwarded` item, like the old `forwarded_from` key, is not
 * rendered: a one-by-one forwarded copy reads as an ordinary message. Other
 * types (including subconversation) are ignored.
 * There is no trust logic here: cws-comm drops client-supplied platform-only
 * items (such as forwarded) and stamps `source`.
 */

// The four types read here (the phase-1 types of cws-comm !618's table): the
// encoded size `data` may have (0 = this type takes no data). Any other type
// is never read for the Agent; its data gets the 2 KiB parse limit.
export const CONTEXT_TYPES = Object.freeze({
  connectors: { dataMaxBytes: 6 * 1024 },
  workflow: { dataMaxBytes: 0 },
  quote: { dataMaxBytes: 6 * 1024 },
  forwarded: { dataMaxBytes: 0 },
});

export const MAX_CONTEXT_ITEMS = 16;
export const MAX_CONTEXT_ATTRS = 16;
export const MAX_CONTEXT_ATTR_CODE_POINTS = 200;
export const MAX_DATA_DEPTH = 5;
export const UNREGISTERED_DATA_MAX_BYTES = 2 * 1024;

/**
 * Whether `data` fits a context item's data limit: its JSON encoding is at most
 * `maxBytes` UTF-8 bytes (default: the 2 KiB cws-comm keeps for an unregistered
 * type). Not encodable → false.
 */
export function fitsContextDataLimit(data, maxBytes = UNREGISTERED_DATA_MAX_BYTES) {
  let json;
  try { json = JSON.stringify(data); } catch { return false; }
  return typeof json === 'string' && Buffer.byteLength(json, 'utf8') <= maxBytes;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const AUDIENCES = new Set(['agent', 'ui', 'server']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function depthOf(v, level = 1) {
  if (Array.isArray(v)) return v.reduce((d, x) => Math.max(d, depthOf(x, level + 1)), level);
  if (isObject(v)) return Object.values(v).reduce((d, x) => Math.max(d, depthOf(x, level + 1)), level);
  return level - 1;
}

function readData(raw, type) {
  if (!isObject(raw)) return undefined;
  const max = CONTEXT_TYPES[type]?.dataMaxBytes ?? UNREGISTERED_DATA_MAX_BYTES;
  if (max <= 0 || depthOf(raw) > MAX_DATA_DEPTH) return undefined;
  return fitsContextDataLimit(raw, max) ? raw : undefined;
}

// Scalars only, strings up to MAX_CONTEXT_ATTR_CODE_POINTS (an over-long value
// is dropped, not cut: a truncated id points at the wrong thing). Values are
// kept as sent; each reader applies the same normalization as for its old key.
function readAttrs(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_CONTEXT_ATTRS) break;
    n += 1;
    if (!NAME_RE.test(k)) continue;
    if (typeof v === 'string') {
      if ([...v].length > MAX_CONTEXT_ATTR_CODE_POINTS) continue;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
    } else if (typeof v !== 'boolean') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function metadataOf(msg) {
  if (!isObject(msg)) return undefined;
  return [msg.metadata, msg.message?.metadata].find((m) => isObject(m) && 'context' in m);
}

/**
 * Every well-formed item of `metadata.context` on a fetched message (top-level
 * `metadata`, or the nested `message.metadata` envelope — same lookup as the
 * other metadata readers), at most MAX_CONTEXT_ITEMS. Each item is
 * `{ type, audience, attrs, data? }`. A missing or malformed context gives [];
 * a malformed item, attribute or data is dropped on its own.
 */
export function contextItemsFrom(msg) {
  const ctx = metadataOf(msg)?.context;
  if (!isObject(ctx) || !Array.isArray(ctx.items)) return [];
  const out = [];
  for (const raw of ctx.items.slice(0, MAX_CONTEXT_ITEMS)) {
    if (!isObject(raw)) continue;
    if (typeof raw.type !== 'string' || !NAME_RE.test(raw.type)) continue;
    if (!AUDIENCES.has(raw.audience)) continue;
    const item = { type: raw.type, audience: raw.audience, attrs: readAttrs(raw.attrs) };
    const data = readData(raw.data, raw.type);
    if (data !== undefined) item.data = data;
    out.push(item);
  }
  return out;
}

/**
 * Outbound `metadata` carrying one item (message context, phase 2): only the
 * item, no old key. `source` is not written (cws-comm stamps it); `attrs` is
 * left out when empty.
 */
export function contextMetadata({ type, audience, attrs, data }) {
  const item = { type, audience };
  if (attrs && Object.keys(attrs).length > 0) item.attrs = attrs;
  if (data !== undefined) item.data = data;
  return { context: { items: [item] } };
}

/** The items addressed to the Agent (audience=agent); [] when there are none. */
export function agentContextItemsFrom(msg) {
  return contextItemsFrom(msg).filter((it) => it.audience === 'agent');
}

/** The agent items of `type`, in order. */
export function agentContextItems(msg, type) {
  return agentContextItemsFrom(msg).filter((it) => it.type === type);
}

/** The first agent item of `type`, or undefined. */
export function agentContextItem(msg, type) {
  return agentContextItemsFrom(msg).find((it) => it.type === type);
}
