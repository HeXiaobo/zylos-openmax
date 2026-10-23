/**
 * Step `detail` (agent_run schema v3, plan §3.3): normalisation and caps.
 *
 *   text      { type, text, truncated }
 *   links     { type, items: [{ title?, url, site }], total, truncated }
 *   output    { type, exit_code?, lines, truncated }       (no output text — D4)
 *   diff      { type, file, added, removed, preview?, truncated }
 *   children  { type, items: [{ title?, object?, status }], total, truncated }   (Phase 2)
 *
 * Every string goes through privacy.js (token-only redaction, D3) and is cut
 * to its cap here; `truncated` is true whenever anything was cut or dropped.
 * `detail_ref` is reserved for the on-demand detail API (plan B) and never
 * emitted. The builders that turn a tool call / result into a detail live in
 * tool-detail.js.
 */

import {
  DETAIL_TEXT_LIMIT, LINKS_MAX_ITEMS, LINK_TITLE_LIMIT, LINK_URL_LIMIT, DIFF_PREVIEW_LINES,
  DIFF_PREVIEW_BYTES, CHILDREN_MAX_ITEMS, TITLE_LIMIT, OBJECT_LIMIT,
} from './constants.js';
import { redactDisplay, redactUrl, isEmptyAfterRedaction } from './privacy.js';

/** Summary caps (plan §3.3). */
export const DETAIL_LIMITS = Object.freeze({
  text: DETAIL_TEXT_LIMIT,
  links: LINKS_MAX_ITEMS,
  linkTitle: LINK_TITLE_LIMIT,
  url: LINK_URL_LIMIT,
  previewLines: DIFF_PREVIEW_LINES,
  previewBytes: DIFF_PREVIEW_BYTES,
  children: CHILDREN_MAX_ITEMS,
});

/** Half caps (compaction level 1, oversized live-frame detail). */
export function scaledLimits(f, base = DETAIL_LIMITS) {
  const n = (v) => Math.max(1, Math.floor(v * f));
  return {
    text: n(base.text), links: n(base.links), linkTitle: base.linkTitle, url: base.url,
    previewLines: n(base.previewLines), previewBytes: n(base.previewBytes), children: n(base.children),
  };
}

// eslint-disable-next-line no-control-regex
const LINE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Cut to at most `limit` code points, ending in "…" when shortened. */
export function cut(text, limit) {
  const cps = Array.from(String(text ?? ''));
  if (cps.length <= limit) return cps.join('');
  return `${cps.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/** One-line text: controls → space, whitespace collapsed, cut to `limit`. */
export function line(text, limit = TITLE_LIMIT) {
  return cut(String(text ?? '').replace(LINE_CONTROL_RE, ' ').replace(/\s+/g, ' ').trim(), limit);
}

/** Multi-line text (\n and \t kept), cut to `limit`. */
export function bodyText(text, limit) {
  return cut(String(text ?? '').replace(BODY_CONTROL_RE, ''), limit);
}

/** Redacted one-line display string, or undefined when nothing usable is left. */
export function displayLine(text, limit = TITLE_LIMIT) {
  if (typeof text !== 'string') return undefined;
  const s = line(redactDisplay(text), limit);
  return s && !isEmptyAfterRedaction(s) ? s : undefined;
}

/** First `maxLines` lines and ≤ `maxBytes` UTF-8 bytes of `text` (whole code points). */
export function headLines(text, maxLines, maxBytes) {
  const lines = String(text ?? '').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  let cutAny = lines.length > maxLines;
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    const cps = Array.from(out);
    let bytes = 0;
    let i = 0;
    for (; i < cps.length; i++) {
      const b = Buffer.byteLength(cps[i], 'utf8');
      if (bytes + b > maxBytes) break;
      bytes += b;
    }
    out = cps.slice(0, i).join('');
    cutAny = true;
  }
  return { text: out, cut: cutAny };
}

const nonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);

function displayUrl(raw, limit) {
  const r = redactUrl(raw);
  if (!r) return undefined;
  let { url } = r;
  if (Array.from(url).length > limit) {
    // Too long: drop query and fragment first, then cut the path.
    const bare = url.replace(/[?#].*$/, '');
    url = Array.from(bare).length > limit ? cut(bare, limit) : bare;
  }
  return { url, site: r.site };
}

/**
 * Normalise a detail to the v3 shape under `limits`.
 * @returns {object|undefined} undefined for an unknown type or nothing to show
 */
export function normalizeDetail(d, limits = DETAIL_LIMITS) {
  if (!d || typeof d !== 'object') return undefined;
  let truncated = d.truncated === true;
  switch (d.type) {
    case 'text': {
      const raw = bodyText(redactDisplay(d.text), Number.MAX_SAFE_INTEGER).trim();
      if (!raw || isEmptyAfterRedaction(raw)) return undefined;
      const text = cut(raw, limits.text);
      if (text !== raw) truncated = true;
      return { type: 'text', text, truncated };
    }
    case 'links': {
      const src = Array.isArray(d.items) ? d.items : [];
      const items = [];
      for (const it of src) {
        if (items.length >= limits.links) { truncated = true; break; }
        const u = displayUrl(it?.url, limits.url);
        if (!u) continue;
        const item = {};
        const title = displayLine(it?.title, limits.linkTitle);
        if (title) item.title = title;
        item.url = u.url;
        item.site = u.site;
        items.push(item);
      }
      const total = Math.max(nonNegInt(d.total) ?? 0, items.length);
      if (total > items.length) truncated = true;
      if (total === 0) return undefined;
      const out = { type: 'links', total, truncated };
      if (items.length) out.items = items;
      return out;
    }
    case 'output': {
      const lines = nonNegInt(d.lines);
      const code = Number.isInteger(d.exit_code) ? d.exit_code : undefined;
      if (lines === undefined && code === undefined) return undefined;
      const out = { type: 'output' };
      if (code !== undefined) out.exit_code = code;
      out.lines = lines ?? 0;
      out.truncated = truncated;
      return out;
    }
    case 'diff': {
      const file = displayLine(d.file, OBJECT_LIMIT);
      if (!file) return undefined;
      const out = { type: 'diff', file, added: nonNegInt(d.added) ?? 0, removed: nonNegInt(d.removed) ?? 0 };
      if (typeof d.preview === 'string' && d.preview.length) {
        // Redact the head first (with a margin so a secret straddling the cut
        // is seen whole), then cut to the caps.
        const margin = headLines(d.preview, limits.previewLines + 5, limits.previewBytes * 2 + 1024);
        const red = bodyText(redactDisplay(margin.text), Number.MAX_SAFE_INTEGER);
        const head = headLines(red, limits.previewLines, limits.previewBytes);
        if (head.text.trim()) out.preview = head.text;
        if (head.cut || margin.cut) truncated = true;
      }
      out.truncated = truncated;
      return out;
    }
    case 'children': {
      const src = Array.isArray(d.items) ? d.items : [];
      const items = [];
      for (const it of src) {
        if (items.length >= limits.children) { truncated = true; break; }
        const status = ['running', 'ok', 'error'].includes(it?.status) ? it.status : 'ok';
        const item = {};
        const title = displayLine(it?.title, TITLE_LIMIT);
        const object = displayLine(it?.object, OBJECT_LIMIT);
        if (title) item.title = title;
        if (object) item.object = object;
        item.status = status;
        items.push(item);
      }
      const total = Math.max(nonNegInt(d.total) ?? 0, items.length);
      if (total === 0) return undefined;
      if (total > items.length) truncated = true;
      return { type: 'children', items, total, truncated };
    }
    default:
      return undefined;
  }
}
