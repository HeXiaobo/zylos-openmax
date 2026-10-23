/**
 * Tool call / result → step `detail` candidates (plan §3.3, O3). Runs on the
 * agent host only: the raw input / output is read here and dropped; what is
 * returned is summary-level (counts, link lists, a diff preview) and is
 * redacted + capped again by detail.js normalizeDetail() before it is stored
 * or sent.
 *
 *   command      → output { exit_code?, lines }   (never the output text — D4)
 *   search_web   → links (WebSearch results: title + url)
 *   fetch_web    → links (the fetched url) | text "HTTP <code> …" on an HTTP error
 *   write / edit → diff { file, added, removed, preview } — available when the
 *                  call starts (tool_use input), corrected from the result
 *                  (Claude structuredPatch) when it ends
 *   anything     → text (first lines of the error) when the call failed
 *
 * What the logs offer per tool is listed in the Phase 0 data-source note
 * (workspace 137-phase0-datasource.md).
 */

import path from 'path';
import { DIFF_PREVIEW_LINES, DIFF_PREVIEW_BYTES } from './constants.js';
import { headLines } from './detail.js';

const RAW_PREVIEW_BYTES = DIFF_PREVIEW_BYTES * 4;     // pre-redaction slice (normalizeDetail cuts to 2 KiB)

/** Lines in a text: '' → 0; a trailing newline does not open another line. */
export function countLines(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

const base = (p) => (typeof p === 'string' && p ? path.basename(p) : undefined);
const head = (s) => headLines(s, DIFF_PREVIEW_LINES + 5, RAW_PREVIEW_BYTES).text;

// ── apply_patch (Codex) ────────────────────────────────────────────────────

/**
 * Files and line counts of an apply_patch payload
 * (`*** Begin Patch` / `*** Add|Update|Delete File: <path>` / +/- lines).
 * @returns {{ files: string[], added: number, removed: number, preview: string }}
 */
export function parsePatch(text) {
  const files = [];
  let added = 0;
  let removed = 0;
  const body = [];
  for (const ln of String(text ?? '').split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(ln);
    if (m) {
      files.push(m[1].trim());
      continue;
    }
    if (/^\*\*\* (?:Begin|End) Patch|^\*\*\* Move to:|^@@/.test(ln)) continue;
    if (ln.startsWith('+')) added += 1;
    else if (ln.startsWith('-')) removed += 1;
    else continue;
    if (body.length < DIFF_PREVIEW_LINES + 5) body.push(ln);
  }
  return { files, added, removed, preview: body.join('\n') };
}

function patchInputText(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return input.input ?? input.patch ?? '';
  return '';
}

// ── call start ─────────────────────────────────────────────────────────────

/** The file a write / edit call targets (basename), if any. */
export function editTarget(name, input) {
  if (name === 'apply_patch') return base(parsePatch(patchInputText(input)).files[0]);
  return base(input?.file_path ?? input?.notebook_path ?? input?.path);
}

/**
 * Diff known when a write / edit call starts (the complete tool_use input is
 * logged before it runs — there is no streaming of the content).
 */
export function startDetail(name, category, input) {
  if (category !== 'write' && category !== 'edit') return undefined;
  if (name === 'apply_patch') {
    const p = parsePatch(patchInputText(input));
    const file = base(p.files[0]);
    if (!file) return undefined;
    return { type: 'diff', file: p.files.length > 1 ? `${file} +${p.files.length - 1}` : file,
      added: p.added, removed: p.removed, preview: p.preview, truncated: false };
  }
  const file = editTarget(name, input);
  if (!file) return undefined;
  if (name === 'Write') {
    const content = typeof input?.content === 'string' ? input.content : '';
    return { type: 'diff', file, added: countLines(content), removed: 0, preview: head(content), truncated: false };
  }
  const edits = name === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits : [input || {}];
  let added = 0;
  let removed = 0;
  const lines = [];
  for (const e of edits) {
    const oldS = typeof e?.old_string === 'string' ? e.old_string : (typeof e?.old_source === 'string' ? e.old_source : '');
    const newS = typeof e?.new_string === 'string' ? e.new_string : (typeof e?.new_source === 'string' ? e.new_source : '');
    removed += countLines(oldS);
    added += countLines(newS);
    if (lines.length < DIFF_PREVIEW_LINES + 5) {
      for (const l of head(oldS).split('\n')) if (oldS) lines.push(`- ${l}`);
      for (const l of head(newS).split('\n')) if (newS) lines.push(`+ ${l}`);
    }
  }
  return { type: 'diff', file, added, removed, preview: lines.slice(0, DIFF_PREVIEW_LINES + 5).join('\n'), truncated: false };
}

// ── call end ───────────────────────────────────────────────────────────────

/** Lines of the hunks of a Claude Code structuredPatch. */
function structuredPatchCounts(patch) {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  const body = [];
  for (const h of patch) {
    if (!Array.isArray(h?.lines)) return null;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added += 1;
      else if (l.startsWith('-')) removed += 1;
      else continue;
      if (body.length < DIFF_PREVIEW_LINES + 5) body.push(l);
    }
  }
  return { added, removed, preview: body.join('\n') };
}

/** "Exit code N" (Claude Bash error) / "Process exited with code N" (Codex). */
function exitCodeFromText(text) {
  const m = /(?:^|\n)\s*(?:Exit code:?|Process exited with code)\s*(-?\d+)/.exec(String(text ?? ''));
  return m ? Number(m[1]) : undefined;
}

/** The command output part of a Codex exec_command result ("Output:\n…"). */
function codexOutputBody(text) {
  const s = String(text ?? '');
  const i = s.indexOf('\nOutput:\n');
  if (i !== -1) return s.slice(i + '\nOutput:\n'.length);
  if (s.startsWith('Output:\n')) return s.slice('Output:\n'.length);
  return null;
}

function commandDetail(name, result, isError) {
  if (name === 'Monitor') return undefined;                 // a watcher launch, not a command result
  const meta = result?.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && (typeof meta.stdout === 'string' || typeof meta.stderr === 'string')) {
    // Claude Code Bash. A background launch has no output of its own yet.
    if (meta.backgroundTaskId) return undefined;
    const out = [meta.stdout, meta.stderr].filter((x) => typeof x === 'string' && x.length).join('\n');
    let code;
    if (isError) code = exitCodeFromText(result?.text);
    else if (!meta.returnCodeInterpretation && !meta.interrupted) code = 0;
    return { type: 'output', ...(code !== undefined ? { exit_code: code } : {}), lines: countLines(out), truncated: false };
  }
  const text = typeof result?.text === 'string' ? result.text : '';
  const code = Number.isInteger(result?.exitCode) ? result.exitCode : exitCodeFromText(text);
  const body = codexOutputBody(text);
  let lines;
  if (body != null) lines = countLines(body);
  else if (isError) lines = countLines(text.replace(/^\s*Exit code:?\s*-?\d+\s*\n?/, ''));
  else lines = countLines(text);
  return { type: 'output', ...(code !== undefined ? { exit_code: code } : {}), lines, truncated: false };
}

function searchWebDetail(result) {
  const results = result?.meta?.results;
  if (!Array.isArray(results)) return undefined;
  const items = [];
  for (const r of results) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.content)) continue;
    for (const c of r.content) if (c && typeof c.url === 'string') items.push({ title: typeof c.title === 'string' ? c.title : undefined, url: c.url });
  }
  if (!items.length) return undefined;
  return { type: 'links', total: items.length, items, truncated: false };
}

function fetchWebDetail(input, result) {
  const meta = result?.meta;
  const code = Number(meta?.code);
  if (Number.isInteger(code) && code >= 400) {
    return { type: 'text', text: `HTTP ${code}${typeof meta.codeText === 'string' && meta.codeText ? ` ${meta.codeText}` : ''}`, truncated: false };
  }
  const url = typeof meta?.url === 'string' ? meta.url : (typeof input?.url === 'string' ? input.url : undefined);
  if (!url) return undefined;
  return { type: 'links', total: 1, items: [{ url }], truncated: false };
}

function errorText(result) {
  const t = typeof result?.text === 'string' ? result.text : '';
  const first = t.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n');
  return first ? { type: 'text', text: first, truncated: false } : undefined;
}

/**
 * The detail of a finished call.
 * @param {{ name: string, category: string, input?: any, result?: { text?: string, meta?: object, exitCode?: number },
 *           isError?: boolean, start?: object }} call  start: the detail it got when it started
 */
export function endDetail({ name, category, input, result, isError = false, start }) {
  switch (category) {
    case 'command':
      return commandDetail(name, result, isError);
    case 'search_web':
      return searchWebDetail(result) || (isError ? errorText(result) : undefined);
    case 'fetch_web':
      return isError && !result?.meta ? errorText(result) : fetchWebDetail(input, result);
    case 'write':
    case 'edit': {
      if (isError) return errorText(result) || start;
      const sp = structuredPatchCounts(result?.meta?.structuredPatch);
      if (sp && start?.type === 'diff' && (sp.added || sp.removed || name === 'Edit')) {
        // Claude Code: the applied patch is exact (a Write over an existing
        // file also reports its removed lines).
        return { ...start, added: sp.added, removed: sp.removed, preview: name === 'Write' && !sp.removed ? start.preview : sp.preview };
      }
      return start;
    }
    default:
      return isError ? errorText(result) : undefined;
  }
}
