/**
 * RFC 2822 / MIME message builder for request_spec `$rfc822` (plan §5.3).
 * Provider-agnostic: produces the bytes of an Internet message from flat
 * fields. RFC 5322 (headers), 2045/2046 (MIME, base64, multipart), 2047
 * (encoded-words for non-ASCII display names / subject / filename fallback),
 * 2231 (non-ASCII filename*).
 *
 *   - CRLF line endings everywhere; header lines folded at 78 columns.
 *   - text / html → one part; both → multipart/alternative (text first);
 *     attachments → outer multipart/mixed [body, attachment...].
 *   - Bodies and attachments are base64 (76 columns); a message/rfc822
 *     attachment (a forwarded original) is base64 too — nothing else.
 *   - MIME-Version and Date are generated, Message-ID is not (the provider
 *     assigns it). Callers cannot add arbitrary headers; any header input
 *     containing CR, LF or NUL is refused (400).
 */
import crypto from 'node:crypto';
import { specError } from './errors.js';
import { isFileObject } from './transforms.js';

const CRLF = '\r\n';
const MAX_LINE = 78;
// 39 bytes → 52 base64 chars → a 64-char encoded-word: keeps "Subject: " + word
// under the RFC 2047 76-column limit and every word under 75 characters.
const EW_CHUNK_BYTES = 39;

function headerSafe(v, field) {
  const s = String(v);
  if (/[\r\n\0]/.test(s)) throw specError(400, `rfc822: ${field} must not contain CR, LF or NUL`);
  return s;
}

function isAscii(s) { return /^[\x20-\x7e]*$/.test(s); }

/** RFC 2047 B encoded-words, split on UTF-8 character boundaries. */
export function encodedWords(s) {
  const words = [];
  let cur = [];
  let curLen = 0;
  for (const ch of s) {
    const b = Buffer.from(ch, 'utf8');
    if (curLen + b.length > EW_CHUNK_BYTES && cur.length) {
      words.push(Buffer.concat(cur));
      cur = []; curLen = 0;
    }
    cur.push(b); curLen += b.length;
  }
  if (cur.length) words.push(Buffer.concat(cur));
  return words.map((w) => `=?UTF-8?B?${w.toString('base64')}?=`);
}

/**
 * Fold a header made of tokens. `comma` joins tokens with "," (address lists);
 * otherwise with a space. Lines are broken before a token that would push the
 * line past 78 columns; continuation lines start with a single space.
 */
function foldHeader(name, tokens, comma = false) {
  let line = `${name}: ${tokens[0]}`;
  const lines = [];
  for (let i = 1; i < tokens.length; i++) {
    if (comma) line += ',';
    const tok = tokens[i];
    if (line.length + 1 + tok.length > MAX_LINE) {
      lines.push(line);
      line = ` ${tok}`;
    } else {
      line += ` ${tok}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

const SPECIALS_RE = /[()<>[\]:;@\\,."]/;
const ADDR_RE = /^[^\s<>()[\],;:"@\\]+@[^\s<>()[\],;:"@\\]+$/;

/** Split an address-list string on top-level commas (outside quotes / <>). */
function splitAddressList(s) {
  const out = [];
  let cur = '';
  let q = false;
  let angle = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === '"') q = false;
      continue;
    }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === '<') angle++;
    if (ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && angle === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Parse one mailbox: "Name <a@b>", "<a@b>" or "a@b" → { name, address }. */
export function parseMailbox(raw, field) {
  const s = headerSafe(raw, field).trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  let name = '';
  let address = s;
  if (m) {
    name = m[1].trim();
    address = m[2].trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  if (!ADDR_RE.test(address)) throw specError(400, `rfc822: ${field}: "${s}" is not a valid email address`);
  return { name, address };
}

function formatMailbox({ name, address }) {
  if (!name) return address;
  if (!isAscii(name)) return `${encodedWords(name).join(' ')} <${address}>`;
  if (SPECIALS_RE.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${name} <${address}>`;
}

function addressList(value, field) {
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const it of items) {
    if (it === null || it === undefined || it === '') continue;
    if (typeof it !== 'string') throw specError(400, `rfc822: ${field} must be a string or an array of strings`);
    for (const part of splitAddressList(headerSafe(it, field))) out.push(formatMailbox(parseMailbox(part, field)));
  }
  return out;
}

function subjectHeader(subject) {
  const s = headerSafe(subject, 'subject');
  if (isAscii(s)) return / {2}|^ | $/.test(s) || s === '' ? `Subject: ${s}` : foldHeader('Subject', s.split(' '));
  const words = encodedWords(s);
  return `Subject: ${words.join(`${CRLF} `)}`;
}

function msgIdTokens(v, field) {
  const s = headerSafe(Array.isArray(v) ? v.join(' ') : v, field);
  const toks = s.split(/\s+/).filter(Boolean);
  for (const t of toks) {
    if (!/^<[^<>\s]+>$/.test(t)) throw specError(400, `rfc822: ${field} must be <message-id> tokens (got "${t}")`);
  }
  return toks;
}

export function rfc5322Date(d) {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

function base64Lines(buf) {
  const b64 = buf.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

function quoteParam(v) { return `"${v.replace(/(["\\])/g, '\\$1')}"`; }

/** RFC 2231 ext-value: UTF-8''<percent-encoded>. */
export function rfc2231Value(s) {
  const pct = Buffer.from(s, 'utf8').toString('binary').split('').map((c) => {
    const code = c.charCodeAt(0);
    if (/[A-Za-z0-9!#$&+.^_`|~-]/.test(c)) return c;
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `UTF-8''${pct}`;
}

function filenameParams(filename) {
  const f = headerSafe(filename, 'attachment filename');
  if (isAscii(f)) return { name: `name=${quoteParam(f)}`, disp: [`filename=${quoteParam(f)}`] };
  const ew = encodedWords(f).join(' ');
  return { name: `name="${ew}"`, disp: [`filename="${ew}"`, `filename*=${rfc2231Value(f)}`] };
}

const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function textPart(content, subtype) {
  const body = Buffer.from(String(content), 'utf8');
  return [
    `Content-Type: text/${subtype}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(body),
  ].join(CRLF);
}

function attachmentPart(file, idx) {
  if (!isFileObject(file)) throw specError(400, `rfc822: attachment ${idx} is not a file`);
  if (!Buffer.isBuffer(file.bytes)) throw specError(400, `rfc822: attachment ${idx} has no in-memory bytes`);
  const mime = headerSafe(file.mime_type || 'application/octet-stream', 'attachment mime_type');
  if (!MIME_RE.test(mime)) throw specError(400, `rfc822: attachment ${idx} has an invalid mime_type "${mime}"`);
  const fname = file.filename || `attachment-${idx + 1}${mime === 'message/rfc822' ? '.eml' : ''}`;
  const p = filenameParams(fname);
  return [
    `Content-Type: ${mime};${CRLF} ${p.name}`,
    `Content-Disposition: attachment;${CRLF} ${p.disp.join(`;${CRLF} `)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(file.bytes),
  ].join(CRLF);
}

function multipart(subtype, boundary, parts) {
  return {
    header: `Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"`,
    body: parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join('') + `--${boundary}--${CRLF}`,
  };
}

function defaultBoundary() { return `=_omx_${crypto.randomBytes(12).toString('hex')}`; }

/**
 * Build the message. `fields` are already-evaluated template values.
 * opts: { boundary: () => string (called once per multipart level), date: Date }
 * Returns a Buffer.
 */
export function buildRfc822(fields, opts = {}) {
  const f = fields || {};
  const nextBoundary = typeof opts.boundary === 'function' ? opts.boundary : defaultBoundary;
  const date = opts.date instanceof Date ? opts.date : new Date();
  const headers = ['MIME-Version: 1.0', `Date: ${rfc5322Date(date)}`];
  const addrHeader = (field, name) => {
    if (f[field] === undefined) return;
    const list = addressList(f[field], field);
    if (list.length) headers.push(foldHeader(name, list, true));
  };
  addrHeader('from', 'From');
  addrHeader('to', 'To');
  addrHeader('cc', 'Cc');
  addrHeader('bcc', 'Bcc');
  addrHeader('reply_to', 'Reply-To');
  if (f.subject !== undefined) headers.push(subjectHeader(typeof f.subject === 'string' ? f.subject : String(f.subject)));
  if (f.in_reply_to !== undefined) {
    const t = msgIdTokens(f.in_reply_to, 'in_reply_to');
    if (t.length > 1) throw specError(400, 'rfc822: in_reply_to takes one <message-id>');
    if (t.length) headers.push(`In-Reply-To: ${t[0]}`);
  }
  if (f.references !== undefined) {
    const t = msgIdTokens(f.references, 'references');
    if (t.length) headers.push(foldHeader('References', t));
  }
  for (const k of ['text', 'html']) {
    if (f[k] !== undefined && typeof f[k] !== 'string') throw specError(400, `rfc822: ${k} must be a string`);
  }

  const atts = [];
  const pushAtt = (v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach(pushAtt); return; }
    atts.push(v);
  };
  pushAtt(f.attachments);

  const used = [];
  const takeBoundary = (content) => {
    for (let i = 0; i < 5; i++) {
      const b = headerSafe(nextBoundary(), 'boundary');
      if (!content.includes(b) && !used.includes(b)) { used.push(b); return b; }
    }
    throw specError(500, 'rfc822: could not pick a unique MIME boundary');
  };

  let bodyEntity;
  const hasText = f.text !== undefined;
  const hasHtml = f.html !== undefined;
  if (hasText && hasHtml) {
    const parts = [textPart(f.text, 'plain'), textPart(f.html, 'html')];
    const mp = multipart('alternative', takeBoundary(parts.join('')), parts);
    bodyEntity = `${mp.header}${CRLF}${CRLF}${mp.body}`;
  } else if (hasHtml) {
    bodyEntity = textPart(f.html, 'html');
  } else {
    bodyEntity = textPart(hasText ? f.text : '', 'plain');
  }

  let entity = bodyEntity;
  if (atts.length) {
    const parts = [bodyEntity, ...atts.map(attachmentPart)];
    const mp = multipart('mixed', takeBoundary(parts.join('')), parts);
    entity = `${mp.header}${CRLF}${CRLF}${mp.body}`;
  }
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${entity}`, 'utf8');
}
