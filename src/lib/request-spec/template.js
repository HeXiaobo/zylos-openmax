/**
 * request_spec template language (plan §4.3) — a deliberately small, pure
 * evaluator. A template is an ordinary JSON value:
 *
 *   "{{to}}"                      whole-string expression → native value (type kept);
 *                                 MISSING drops the containing key / array element
 *   "Re: {{subject}}"             interpolation; MISSING → ''
 *   "{{ a.b | t1 | t2('x') }}"    path + transform pipeline
 *   {"$if": "p"|"!p", "then": X, "else": Y}
 *   {"$first": [A, B, ...]}       first non-missing (non-null, non-'') value
 *   {"$concat": [A, B, ...]}      array concatenation (missing → [])
 *   {"$rfc822": {...}}            RFC 2822 builder → bytes
 *   {"$bytes": "{{expr}}", "mime_type": …, "filename": …}   expression result as a file
 *   {"$pipe": [node, "t1", "t2('x')"]}
 *
 * No loops, no code execution. Roots: a param name, `prefetch.<as>.…`
 * (status_code / headers / body) and `files.<param>.…` (filename / mime_type /
 * size). Every structural rule is checked both statically (analyzeTemplate,
 * used by the spec validator before anything runs) and at evaluation time.
 */
import { specError } from './errors.js';
import { MISSING, isMissing, isFileObject, applyTransform, checkTransformCall } from './transforms.js';

export const MAX_TEMPLATE_DEPTH = 16;
export const MAX_EXPRESSION_LENGTH = 256;

const WHOLE_RE = /^\{\{([^{}]+)\}\}$/;
const INTERP_RE = /\{\{([^{}]+)\}\}/g;
const SEG_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+)$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DIRECTIVES = {
  $if: new Set(['then', 'else']),
  $first: new Set(),
  $concat: new Set(),
  $rfc822: new Set(),
  $bytes: new Set(['mime_type', 'filename']),
  $pipe: new Set(),
};

export const RFC822_FIELDS = new Set([
  'from', 'to', 'cc', 'bcc', 'reply_to', 'subject', 'text', 'html', 'attachments', 'in_reply_to', 'references',
]);

const bad = (msg) => specError(422, `request_spec: ${msg}`);

// ---------------------------------------------------------------------------
//  Expression parsing
// ---------------------------------------------------------------------------

function parseArgs(src, where) {
  const args = [];
  let i = 0;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  skip();
  if (i >= src.length) return args;
  for (;;) {
    skip();
    const c = src[i];
    if (c === "'" || c === '"') {
      let out = '';
      i++;
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
        if (ch === c) { closed = true; i++; break; }
        out += ch; i++;
      }
      if (!closed) throw bad(`unterminated string argument in ${where}`);
      args.push(out);
    } else {
      const m = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(src.slice(i));
      if (!m) throw bad(`invalid argument in ${where}`);
      args.push(JSON.parse(m[1]));
      i += m[1].length;
    }
    skip();
    if (i >= src.length) return args;
    if (src[i] !== ',') throw bad(`expected "," between arguments in ${where}`);
    i++;
  }
}

/** Split on top-level "|" (outside quotes). */
function splitPipes(src) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      cur += ch;
      if (ch === '\\' && i + 1 < src.length) { cur += src[++i]; continue; }
      if (ch === q) q = null;
    } else if (ch === "'" || ch === '"') { q = ch; cur += ch; }
    else if (ch === '|') { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (q) throw bad('unterminated string in expression');
  parts.push(cur);
  return parts;
}

/** Parse one transform call: `name` or `name(arg, …)`. */
export function parseCall(src) {
  const s = src.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?$/s.exec(s);
  if (!m) throw bad(`invalid transform call "${s}"`);
  const args = m[2] === undefined ? [] : parseArgs(m[2], `transform ${m[1]}`);
  checkTransformCall(m[1], args.length);
  return { name: m[1], args };
}

export function parsePath(src) {
  const s = src.trim();
  if (!s) throw bad('empty path in expression');
  const segs = s.split('.');
  for (const seg of segs) {
    if (!SEG_RE.test(seg)) throw bad(`invalid path segment "${seg}" in "${s}"`);
  }
  if (/^[0-9]/.test(segs[0])) throw bad(`path must start with a name: "${s}"`);
  return segs;
}

/** Parse an expression body (text inside {{ }}). */
export function parseExpression(src) {
  if (src.length > MAX_EXPRESSION_LENGTH) throw bad(`expression longer than ${MAX_EXPRESSION_LENGTH} characters`);
  const [head, ...calls] = splitPipes(src);
  return { path: parsePath(head), calls: calls.map(parseCall) };
}

/** Parse an $if / prefetch.when condition: "path" or "!path". */
export function parseCondition(src) {
  if (typeof src !== 'string') throw bad('condition must be a string "path" or "!path"');
  const s = src.trim();
  const neg = s.startsWith('!');
  const body = neg ? s.slice(1) : s;
  if (body.length > MAX_EXPRESSION_LENGTH) throw bad(`condition longer than ${MAX_EXPRESSION_LENGTH} characters`);
  return { neg, path: parsePath(body) };
}

// ---------------------------------------------------------------------------
//  Static analysis
// ---------------------------------------------------------------------------

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function directiveKey(obj) {
  const dk = Object.keys(obj).filter((k) => k.startsWith('$'));
  if (dk.length === 0) return null;
  if (dk.length > 1) throw bad(`more than one directive in one object (${dk.join(', ')})`);
  const k = dk[0];
  if (!DIRECTIVES[k]) throw bad(`unknown directive "${k}"`);
  for (const other of Object.keys(obj)) {
    if (other !== k && !DIRECTIVES[k].has(other)) throw bad(`directive ${k} does not accept key "${other}"`);
  }
  return k;
}

/**
 * Walk a template and collect what it references. Throws 422 on any
 * structural error. `scope` = { prefetchAs: Set (names visible here),
 * fileParams: Set }.
 * Returns { roots: Set<param name>, prefetchRefs: Set, fileRefs: Set, rfc822: bool, bytes: bool }.
 */
export function analyzeTemplate(node, scope = {}, acc = null, depth = 0) {
  const out = acc || { roots: new Set(), prefetchRefs: new Set(), fileRefs: new Set(), rfc822: false, bytes: false };
  if (depth > MAX_TEMPLATE_DEPTH) throw bad(`template nested deeper than ${MAX_TEMPLATE_DEPTH}`);
  const notePath = (segs, where) => {
    if (segs[0] === 'prefetch') {
      if (segs.length < 2) throw bad(`"prefetch" needs a name (${where})`);
      if (scope.prefetchAs && !scope.prefetchAs.has(segs[1])) throw bad(`unknown prefetch "${segs[1]}" (${where})`);
      if (segs.length >= 3 && !['status_code', 'headers', 'body'].includes(segs[2])) {
        throw bad(`prefetch.${segs[1]} exposes only status_code / headers / body (${where})`);
      }
      out.prefetchRefs.add(segs[1]);
    } else if (segs[0] === 'files') {
      if (segs.length < 2) throw bad(`"files" needs a parameter name (${where})`);
      if (scope.fileParams && !scope.fileParams.has(segs[1])) throw bad(`files.${segs[1]} is not declared in request_spec.files (${where})`);
      out.fileRefs.add(segs[1]);
      out.roots.add(segs[1]);
    } else {
      out.roots.add(segs[0]);
      if (scope.fileParams && scope.fileParams.has(segs[0])) out.fileRefs.add(segs[0]);
    }
  };
  const noteString = (s) => {
    INTERP_RE.lastIndex = 0;
    let m;
    while ((m = INTERP_RE.exec(s)) !== null) {
      const e = parseExpression(m[1]);
      notePath(e.path, `{{${m[1].trim()}}}`);
    }
  };
  if (typeof node === 'string') { noteString(node); return out; }
  if (Array.isArray(node)) {
    for (const el of node) analyzeTemplate(el, scope, out, depth + 1);
    return out;
  }
  if (!isPlainObject(node)) return out;
  const dk = directiveKey(node);
  if (!dk) {
    for (const v of Object.values(node)) analyzeTemplate(v, scope, out, depth + 1);
    return out;
  }
  const arg = node[dk];
  switch (dk) {
    case '$if': {
      const c = parseCondition(arg);
      notePath(c.path, `$if "${arg}"`);
      if (!('then' in node)) throw bad('$if requires "then"');
      analyzeTemplate(node.then, scope, out, depth + 1);
      if ('else' in node) analyzeTemplate(node.else, scope, out, depth + 1);
      break;
    }
    case '$first':
    case '$concat':
      if (!Array.isArray(arg) || arg.length === 0) throw bad(`${dk} takes a non-empty array`);
      for (const el of arg) analyzeTemplate(el, scope, out, depth + 1);
      break;
    case '$rfc822':
      if (!isPlainObject(arg)) throw bad('$rfc822 takes an object of fields');
      for (const [k, v] of Object.entries(arg)) {
        if (!RFC822_FIELDS.has(k)) throw bad(`$rfc822: unknown field "${k}"`);
        analyzeTemplate(v, scope, out, depth + 1);
      }
      out.rfc822 = true;
      break;
    case '$bytes': {
      if (typeof arg !== 'string' || !WHOLE_RE.test(arg)) {
        throw bad('$bytes must be a single "{{expression}}" — a literal file/bytes reference is not allowed');
      }
      noteString(arg);
      for (const k of ['mime_type', 'filename']) {
        if (k in node) {
          if (typeof node[k] !== 'string') throw bad(`$bytes ${k} must be a string template`);
          noteString(node[k]);
        }
      }
      out.bytes = true;
      break;
    }
    case '$pipe': {
      if (!Array.isArray(arg) || arg.length < 2) throw bad('$pipe takes [node, "transform", ...]');
      analyzeTemplate(arg[0], scope, out, depth + 1);
      for (const t of arg.slice(1)) {
        if (typeof t !== 'string') throw bad('$pipe transforms must be strings');
        parseCall(t);
      }
      break;
    }
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Evaluation
// ---------------------------------------------------------------------------

function present(v) { return !isMissing(v) && v !== null && v !== '' && v !== false; }

function navigate(base, segs) {
  let cur = base;
  for (const seg of segs) {
    if (isMissing(cur) || cur === null) return MISSING;
    if (isFileObject(cur)) {
      if (!['filename', 'mime_type', 'size'].includes(seg)) return MISSING;
      cur = cur[seg];
    } else if (Buffer.isBuffer(cur)) {
      return MISSING;
    } else if (Array.isArray(cur)) {
      if (!/^[0-9]+$/.test(seg)) return MISSING;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : MISSING;
    } else {
      return MISSING;
    }
  }
  return cur === undefined || cur === null ? MISSING : cur;
}

/** Resolve a parsed path against the evaluation context. */
export function resolvePath(segs, ctx) {
  const params = ctx.params || {};
  const files = ctx.files || {};
  if (segs[0] === 'prefetch') {
    const pf = (ctx.prefetch || {})[segs[1]];
    return pf === undefined ? MISSING : navigate(pf, segs.slice(2));
  }
  if (segs[0] === 'files') {
    if (!Object.prototype.hasOwnProperty.call(files, segs[1])) return MISSING;
    return navigate(files[segs[1]], segs.slice(2));
  }
  if (Object.prototype.hasOwnProperty.call(files, segs[0])) return navigate(files[segs[0]], segs.slice(1));
  if (!Object.prototype.hasOwnProperty.call(params, segs[0])) return MISSING;
  return navigate(params[segs[0]], segs.slice(1));
}

export function evalExpression(src, ctx) {
  const e = parseExpression(src);
  let v = resolvePath(e.path, ctx);
  for (const c of e.calls) v = applyTransform(c.name, v, c.args);
  return v;
}

export function evalCondition(src, ctx) {
  const c = parseCondition(src);
  const v = present(resolvePath(c.path, ctx));
  return c.neg ? !v : v;
}

function stringify(v, src) {
  if (isMissing(v) || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Buffer.isBuffer(v) || isFileObject(v)) throw specError(400, `request_spec: {{${src.trim()}}} yields bytes and cannot be interpolated into a string`);
  return JSON.stringify(v);
}

function evalString(s, ctx) {
  const m = WHOLE_RE.exec(s);
  if (m) return evalExpression(m[1], ctx);
  if (!s.includes('{{')) return s;
  return s.replace(INTERP_RE, (_, src) => stringify(evalExpression(src, ctx), src));
}

function makeFile(v, mime, filename) {
  let file;
  if (isFileObject(v)) file = { ...v };
  else if (Buffer.isBuffer(v)) file = { __file: true, bytes: v, size: v.length, filename: undefined, mime_type: undefined };
  else if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); file = { __file: true, bytes: b, size: b.length }; }
  else throw specError(400, '$bytes: expression must yield bytes, a string or a file');
  if (typeof mime === 'string' && mime) file.mime_type = mime;
  if (typeof filename === 'string' && filename) file.filename = filename;
  if (!file.mime_type) file.mime_type = 'application/octet-stream';
  return file;
}

/**
 * Evaluate a template. ctx = { params, prefetch, files, rfc822(fields) → Buffer }.
 * Returns the value or MISSING.
 */
export function evalTemplate(node, ctx, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) throw bad(`template nested deeper than ${MAX_TEMPLATE_DEPTH}`);
  if (typeof node === 'string') return evalString(node, ctx);
  if (Array.isArray(node)) {
    const out = [];
    for (const el of node) {
      const v = evalTemplate(el, ctx, depth + 1);
      if (!isMissing(v)) out.push(v);
    }
    return out;
  }
  if (!isPlainObject(node)) return node;
  const dk = directiveKey(node);
  if (!dk) {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const r = evalTemplate(v, ctx, depth + 1);
      if (!isMissing(r)) out[k] = r;
    }
    return out;
  }
  const arg = node[dk];
  switch (dk) {
    case '$if': {
      if (!('then' in node)) throw bad('$if requires "then"');
      if (evalCondition(arg, ctx)) return evalTemplate(node.then, ctx, depth + 1);
      return 'else' in node ? evalTemplate(node.else, ctx, depth + 1) : MISSING;
    }
    case '$first': {
      if (!Array.isArray(arg) || arg.length === 0) throw bad('$first takes a non-empty array');
      for (const el of arg) {
        const v = evalTemplate(el, ctx, depth + 1);
        if (!isMissing(v) && v !== null && v !== '') return v;
      }
      return MISSING;
    }
    case '$concat': {
      if (!Array.isArray(arg) || arg.length === 0) throw bad('$concat takes a non-empty array');
      const out = [];
      for (const el of arg) {
        const v = evalTemplate(el, ctx, depth + 1);
        if (isMissing(v) || v === null) continue;
        if (Array.isArray(v)) out.push(...v); else out.push(v);
      }
      return out;
    }
    case '$rfc822': {
      if (!isPlainObject(arg)) throw bad('$rfc822 takes an object of fields');
      const fields = {};
      for (const [k, v] of Object.entries(arg)) {
        if (!RFC822_FIELDS.has(k)) throw bad(`$rfc822: unknown field "${k}"`);
        const r = evalTemplate(v, ctx, depth + 1);
        if (!isMissing(r) && r !== null && r !== '') fields[k] = r;
      }
      if (typeof ctx.rfc822 !== 'function') throw bad('$rfc822 is not available in this context');
      return ctx.rfc822(fields);
    }
    case '$bytes': {
      if (typeof arg !== 'string' || !WHOLE_RE.test(arg)) {
        throw bad('$bytes must be a single "{{expression}}" — a literal file/bytes reference is not allowed');
      }
      const v = evalString(arg, ctx);
      if (isMissing(v)) return MISSING;
      const mime = 'mime_type' in node ? evalTemplate(node.mime_type, ctx, depth + 1) : undefined;
      const fname = 'filename' in node ? evalTemplate(node.filename, ctx, depth + 1) : undefined;
      return makeFile(v, isMissing(mime) ? undefined : mime, isMissing(fname) ? undefined : fname);
    }
    case '$pipe': {
      if (!Array.isArray(arg) || arg.length < 2) throw bad('$pipe takes [node, "transform", ...]');
      let v = evalTemplate(arg[0], ctx, depth + 1);
      for (const t of arg.slice(1)) {
        if (typeof t !== 'string') throw bad('$pipe transforms must be strings');
        const c = parseCall(t);
        v = applyTransform(c.name, v, c.args);
      }
      return v;
    }
    default:
      throw bad(`unknown directive "${dk}"`);
  }
}

export { MISSING, isMissing, NAME_RE };
