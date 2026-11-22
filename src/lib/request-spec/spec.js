/**
 * request_spec structure validation (plan §4.2), run by the plugin before
 * executing an action. cws-connect validates the same rules on write; the
 * plugin re-checks at runtime because custom-connector specs are authored by
 * org users (Q8) and a stale cache could hold anything. Malformed → 422;
 * a `requires` this build does not know → 426 (assertCapabilities).
 */
import { specError } from './errors.js';
import { assertCapabilities, FEATURE_CAPABILITIES } from './capabilities.js';
import { analyzeTemplate, parseCondition } from './template.js';
import { MAX_FILE_BYTES, MAX_STREAM_FILE_BYTES, MAX_BODY_BYTES, FILE_SOURCES } from './files.js';

export const ENCODINGS = Object.freeze(['json', 'form', 'none', 'media', 'multipart_related', 'multipart_form', 'batch_mixed']);
const UPLOAD_ENCODINGS = new Set(['media', 'multipart_related', 'multipart_form']);
const TOP_KEYS = new Set(['version', 'requires', 'encoding', 'unmapped_params', 'prefetch', 'files', 'body', 'parts', 'upload', 'batch']);
const FILE_KEYS = new Set(['multiple', 'max_bytes', 'max_total_bytes', 'accept', 'sources', 'stream']);
const UPLOAD_KEYS = new Set(['init_headers', 'session_url_from', 'chunk_method', 'chunk_bytes', 'chunk_multiple', 'range_style',
  'incomplete_status', 'progress_header', 'status_probe', 'final_status', 'max_restarts']);
const BATCH_KEYS = new Set(['items_param', 'allowed_actions', 'max_items', 'path_prefix', 'part_format']);
const PREFETCH_KEYS = new Set(['as', 'action', 'params', 'when']);
const AS_RE = /^[a-z][a-z0-9_]{0,31}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
export const MAX_PREFETCH = 3;
export const MAX_SPEC_BYTES = 64 * 1024;

const bad = (msg) => specError(422, `request_spec: ${msg}`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Parse the catalog value (object or JSON text). Returns null when absent. */
export function parseRequestSpec(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let spec = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_SPEC_BYTES) throw bad(`larger than ${MAX_SPEC_BYTES} bytes`);
    try { spec = JSON.parse(raw); } catch { throw bad('is not valid JSON'); }
  }
  if (!isObj(spec)) throw bad('must be a JSON object');
  return spec;
}

function urlPlaceholderNames(actionDef) {
  const names = new Set();
  const add = (s) => { for (const m of String(s || '').matchAll(/\{([^}]+)\}/g)) names.add(m[1]); };
  add(actionDef && actionDef.url_template);
  const ht = actionDef && actionDef.headers_template;
  if (isObj(ht)) Object.values(ht).forEach(add);
  return names;
}

/**
 * Validate + analyse. Returns { spec, encoding, referenced: Set<param>, used: Set<cap> }.
 * `catalog` (array) lets prefetch / batch references be checked; optional.
 */
export function validateRequestSpec(rawSpec, actionDef = {}, catalog = null) {
  const spec = parseRequestSpec(rawSpec);
  if (!spec) throw bad('missing');
  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) throw bad(`unknown key "${k}"`);
  if (spec.version !== 1) throw bad('version must be 1');
  const req = spec.requires;
  if (!Array.isArray(req) || req.length === 0 || req.some((c) => typeof c !== 'string')) throw bad('requires must be a non-empty array of capability names');
  if (new Set(req).size !== req.length) throw bad('requires must not repeat a capability');
  assertCapabilities(req, FEATURE_CAPABILITIES); // 426 for anything this build does not implement
  const encoding = spec.encoding === undefined ? 'json' : spec.encoding;
  if (!ENCODINGS.includes(encoding)) throw bad(`unknown encoding "${encoding}"`);
  if (spec.unmapped_params !== undefined && !['reject', 'ignore'].includes(spec.unmapped_params)) throw bad('unmapped_params must be "reject" or "ignore"');
  const method = String(actionDef.method || 'GET').toUpperCase();
  if (method === 'GET') throw bad('GET actions cannot carry a request_spec');

  const used = new Set();
  const referenced = urlPlaceholderNames(actionDef);
  referenced.add('_query');

  // files
  const fileParams = new Set();
  if (spec.files !== undefined) {
    if (!isObj(spec.files) || Object.keys(spec.files).length === 0) throw bad('files must be a non-empty object');
    for (const [name, f] of Object.entries(spec.files)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || name === 'files' || name === 'prefetch') throw bad(`invalid file parameter name "${name}"`);
      if (!isObj(f)) throw bad(`files.${name} must be an object`);
      for (const k of Object.keys(f)) if (!FILE_KEYS.has(k)) throw bad(`files.${name}: unknown key "${k}"`);
      for (const k of ['multiple', 'stream']) if (f[k] !== undefined && typeof f[k] !== 'boolean') throw bad(`files.${name}.${k} must be a boolean`);
      const hard = f.stream ? MAX_STREAM_FILE_BYTES : MAX_FILE_BYTES;
      if (f.max_bytes !== undefined && (!isPosInt(f.max_bytes) || f.max_bytes > hard)) throw bad(`files.${name}.max_bytes must be an integer in 1..${hard}`);
      if (f.max_total_bytes !== undefined && (!isPosInt(f.max_total_bytes) || f.max_total_bytes > MAX_BODY_BYTES)) throw bad(`files.${name}.max_total_bytes must be an integer in 1..${MAX_BODY_BYTES}`);
      if (f.accept !== undefined && (!Array.isArray(f.accept) || f.accept.some((a) => typeof a !== 'string' || !/^[\w.+*-]+\/[\w.+*-]+$/.test(a)))) throw bad(`files.${name}.accept must be an array of mime patterns`);
      if (f.sources !== undefined && (!Array.isArray(f.sources) || f.sources.length === 0 || f.sources.some((s) => !FILE_SOURCES.includes(s)))) throw bad(`files.${name}.sources must be a non-empty subset of ${FILE_SOURCES.join(', ')}`);
      if (f.stream && f.multiple) throw bad(`files.${name}: a streamed file cannot be multiple`);
      if (f.stream && spec.upload === undefined) throw bad(`files.${name}: stream is only valid with an upload block`);
      fileParams.add(name);
      referenced.add(name);
    }
    used.add('file_source');
  }

  // prefetch
  const prefetchAs = new Set();
  if (spec.prefetch !== undefined) {
    if (!Array.isArray(spec.prefetch) || spec.prefetch.length === 0 || spec.prefetch.length > MAX_PREFETCH) throw bad(`prefetch must be an array of 1..${MAX_PREFETCH} steps`);
    for (const [i, p] of spec.prefetch.entries()) {
      if (!isObj(p)) throw bad(`prefetch[${i}] must be an object`);
      for (const k of Object.keys(p)) if (!PREFETCH_KEYS.has(k)) throw bad(`prefetch[${i}]: unknown key "${k}"`);
      if (typeof p.as !== 'string' || !AS_RE.test(p.as) || prefetchAs.has(p.as)) throw bad(`prefetch[${i}].as must match ${AS_RE} and be unique`);
      if (typeof p.action !== 'string' || !p.action) throw bad(`prefetch[${i}].action is required`);
      if (!isObj(p.params)) throw bad(`prefetch[${i}].params must be an object template`);
      const scope = { prefetchAs: new Set(prefetchAs), fileParams };
      const a = analyzeTemplate(p.params, scope);
      a.roots.forEach((r) => referenced.add(r));
      if (p.when !== undefined) {
        const c = parseCondition(p.when);
        if (c.path[0] === 'prefetch' && !prefetchAs.has(c.path[1])) throw bad(`prefetch[${i}].when references unknown prefetch "${c.path[1]}"`);
        if (c.path[0] !== 'prefetch' && c.path[0] !== 'files') referenced.add(c.path[0]);
      }
      if (Array.isArray(catalog)) {
        const target = catalog.find((x) => `${x.toolkit}/${x.action}` === p.action);
        if (!target) throw bad(`prefetch[${i}].action "${p.action}" is not in this catalog`);
        if (String(target.method || 'GET').toUpperCase() !== 'GET') throw bad(`prefetch[${i}].action "${p.action}" must be a GET action`);
        if (target.request_spec) throw bad(`prefetch[${i}].action "${p.action}" must not itself have a request_spec`);
      }
      prefetchAs.add(p.as);
    }
    used.add('prefetch');
  }

  const scope = { prefetchAs, fileParams };
  const noteTemplate = (node) => {
    const a = analyzeTemplate(node, scope);
    a.roots.forEach((r) => referenced.add(r));
    return a;
  };

  if (spec.body !== undefined) { noteTemplate(spec.body); used.add('body_template'); }
  if (spec.parts !== undefined) {
    if (!Array.isArray(spec.parts) || spec.parts.length === 0) throw bad('parts must be a non-empty array');
    for (const [i, part] of spec.parts.entries()) {
      if (!isObj(part)) throw bad(`parts[${i}] must be an object`);
      const keys = Object.keys(part);
      if ('file' in part) {
        if (keys.some((k) => !['file', 'name'].includes(k))) throw bad(`parts[${i}]: a file part takes only "file" and "name"`);
        if (!fileParams.has(part.file)) throw bad(`parts[${i}].file "${part.file}" is not declared in files`);
      } else {
        if (!('body' in part) || keys.some((k) => !['content_type', 'body', 'name'].includes(k))) throw bad(`parts[${i}] needs "body" (+ optional content_type, name) or "file"`);
        if (part.content_type !== undefined && (typeof part.content_type !== 'string' || /[\r\n\0]/.test(part.content_type))) throw bad(`parts[${i}].content_type must be a header-safe string`);
        noteTemplate(part.body);
      }
      if (part.name !== undefined && (typeof part.name !== 'string' || /[\r\n\0"]/.test(part.name))) throw bad(`parts[${i}].name must be a header-safe string`);
      if (encoding === 'multipart_form' && typeof part.name !== 'string') throw bad(`parts[${i}].name is required for multipart_form`);
    }
    used.add('body_template');
  }

  if (spec.upload !== undefined) {
    const u = spec.upload;
    if (!isObj(u)) throw bad('upload must be an object');
    for (const k of Object.keys(u)) if (!UPLOAD_KEYS.has(k)) throw bad(`upload: unknown key "${k}"`);
    if (typeof u.session_url_from !== 'string' || !/^header:[A-Za-z0-9-]+$/.test(u.session_url_from)) throw bad('upload.session_url_from must be "header:<Name>"');
    if (!['PUT', 'POST', 'PATCH'].includes(u.chunk_method)) throw bad('upload.chunk_method must be PUT, POST or PATCH');
    if (!Array.isArray(u.final_status) || u.final_status.length === 0 || u.final_status.some((s) => !Number.isInteger(s) || s < 200 || s > 299)) throw bad('upload.final_status must be a non-empty array of 2xx codes');
    if (u.chunk_multiple !== undefined && !isPosInt(u.chunk_multiple)) throw bad('upload.chunk_multiple must be a positive integer');
    if (u.chunk_bytes !== undefined && (!isPosInt(u.chunk_bytes) || (u.chunk_multiple && u.chunk_bytes % u.chunk_multiple !== 0))) throw bad('upload.chunk_bytes must be a positive multiple of chunk_multiple');
    if (u.range_style !== undefined && u.range_style !== 'content_range') throw bad('upload.range_style must be "content_range"');
    if (u.incomplete_status !== undefined && !(Number.isInteger(u.incomplete_status) && u.incomplete_status >= 200 && u.incomplete_status <= 399)) throw bad('upload.incomplete_status must be an HTTP status');
    if (u.progress_header !== undefined && (typeof u.progress_header !== 'string' || !HEADER_NAME_RE.test(u.progress_header))) throw bad('upload.progress_header must be a header name');
    if (u.status_probe !== undefined && !['content_range_star', 'none'].includes(u.status_probe)) throw bad('upload.status_probe must be content_range_star or none');
    if (u.max_restarts !== undefined && !(Number.isInteger(u.max_restarts) && u.max_restarts >= 0 && u.max_restarts <= 2)) throw bad('upload.max_restarts must be 0..2');
    if (u.init_headers !== undefined) {
      if (!isObj(u.init_headers)) throw bad('upload.init_headers must be an object');
      for (const [hk, hv] of Object.entries(u.init_headers)) {
        if (!HEADER_NAME_RE.test(hk) || /^(authorization|host|content-length)$/i.test(hk)) throw bad(`upload.init_headers: header "${hk}" is not allowed`);
        if (typeof hv !== 'string') throw bad(`upload.init_headers.${hk} must be a string template`);
        noteTemplate(hv);
      }
    }
    if (encoding !== 'json') throw bad('an upload block requires encoding "json" (the initial request carries JSON metadata)');
    const streamed = [...fileParams].filter((n) => spec.files[n].stream);
    if (streamed.length !== 1) throw bad('an upload block needs exactly one files entry with stream:true');
    used.add('resumable_upload');
  }

  if (spec.batch !== undefined) {
    const b = spec.batch;
    if (!isObj(b)) throw bad('batch must be an object');
    for (const k of Object.keys(b)) if (!BATCH_KEYS.has(k)) throw bad(`batch: unknown key "${k}"`);
    if (typeof b.items_param !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(b.items_param)) throw bad('batch.items_param must be a parameter name');
    if (!Array.isArray(b.allowed_actions) || b.allowed_actions.length === 0 || b.allowed_actions.some((a) => typeof a !== 'string' || !a)) throw bad('batch.allowed_actions must be a non-empty array of action names');
    if (!(Number.isInteger(b.max_items) && b.max_items >= 1 && b.max_items <= 100)) throw bad('batch.max_items must be 1..100');
    if (b.path_prefix !== undefined && (typeof b.path_prefix !== 'string' || !b.path_prefix.startsWith('/'))) throw bad('batch.path_prefix must start with "/"');
    if (b.part_format !== undefined && b.part_format !== 'application_http') throw bad('batch.part_format must be "application_http"');
    if (Array.isArray(catalog)) {
      for (const name of b.allowed_actions) {
        const t = catalog.find((x) => `${x.toolkit}/${x.action}` === name);
        if (!t) throw bad(`batch.allowed_actions "${name}" is not in this catalog`);
        if (t.request_spec) throw bad(`batch.allowed_actions "${name}" must not have a request_spec`);
      }
    }
    if (encoding !== 'batch_mixed') throw bad('a batch block requires encoding "batch_mixed"');
    if (spec.body !== undefined || spec.parts !== undefined || spec.files !== undefined || spec.prefetch !== undefined || spec.upload !== undefined) {
      throw bad('a batch spec cannot also carry body / parts / files / prefetch / upload');
    }
    referenced.add(b.items_param);
    used.add('batch');
  } else if (encoding === 'batch_mixed') {
    throw bad('encoding "batch_mixed" requires a batch block');
  }

  if (UPLOAD_ENCODINGS.has(encoding)) used.add('file_upload');
  if (encoding === 'media' && spec.body === undefined) throw bad('encoding "media" requires a body that yields bytes');
  if ((encoding === 'multipart_related' || encoding === 'multipart_form') && spec.parts === undefined) throw bad(`encoding "${encoding}" requires parts`);
  if (spec.parts !== undefined && !(encoding === 'multipart_related' || encoding === 'multipart_form')) throw bad('parts are only valid with a multipart encoding');
  if (encoding === 'none' && (spec.body !== undefined || spec.parts !== undefined)) throw bad('encoding "none" cannot carry a body');
  if (spec.parts !== undefined && spec.body !== undefined) throw bad('use either body or parts, not both');

  const declared = new Set(req);
  const missing = [...used].filter((c) => !declared.has(c));
  const extra = [...declared].filter((c) => !used.has(c));
  if (missing.length || extra.length) {
    throw bad(`requires must list exactly the capabilities the spec uses (missing: [${missing.join(', ')}], unused: [${extra.join(', ')}])`);
  }
  return { spec, encoding, referenced, used, fileParams, prefetchAs };
}
