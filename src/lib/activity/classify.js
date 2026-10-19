/**
 * Tool call → display category, step title / object candidates, and the
 * focus signals the attribution needs. Runs on the agent host only: the tool
 * input (command text, paths, URLs …) is inspected here and then discarded.
 * What leaves the host is the enum category plus the display strings built
 * here (title, object), each token-redacted (privacy.js, decision D3) and cut
 * to its cap. Command text never leaves the host.
 */

import path from 'path';
import { TITLE_LIMIT, OBJECT_LIMIT } from './constants.js';
import { displayLine } from './detail.js';
import { REDACTED, siteOf } from './privacy.js';
import { editTarget } from './tool-detail.js';
import { scanShellSends, argvToScript, COMM_REPLY_COMMANDS } from './shell-scan.js';

export { COMM_REPLY_COMMANDS };
import { recoverWrapperCommands } from './wrapper-source.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const COMMAND_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'Monitor']);
const READ_TOOLS = new Set(['Read', 'read_file']);
const WRITE_TOOLS = new Set(['Write']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'tool_search_call']);
const SEARCH_WEB_TOOLS = new Set(['WebSearch', 'web_search']);
const FETCH_WEB_TOOLS = new Set(['WebFetch', 'web_fetch']);
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
// Wait / poll calls: never a step and never counted (decision 6); a Codex
// write_stdin on a running exec session is merged into that command's step.
const WAITING_TOOLS = new Set(['write_stdin', 'wait', 'TaskOutput', 'BashOutput', 'AgentOutputTool']);

// Execution wrappers whose payload is not a plain command (e.g. Codex's
// `exec` custom tool, whose input is code that calls other tools). Their input
// is never evaluated; see wrapper-source.js for the only shape accepted as
// fully inspectable.
const WRAPPER_EXEC_TOOLS = new Set(['exec']);

const KB_RE = /skills\/openmax-kb\/|openmax\/src\/cli\/kb\.js/;
const SPILL_RE = /comm-bridge\/attachments\/conv-(\d+)\/message\.txt/g;

/** Every string leaf of a tool input (strings, arrays, nested objects), depth-capped. */
export function stringLeaves(input, out = [], depth = 0) {
  if (depth > 8 || out.length > 1000) return out;
  if (typeof input === 'string') out.push(input);
  else if (Array.isArray(input)) for (const v of input) stringLeaves(v, out, depth + 1);
  else if (input && typeof input === 'object') for (const v of Object.values(input)) stringLeaves(v, out, depth + 1);
  return out;
}

/**
 * Scan one execution's text for every c4-send / comm CLI send (read as shell
 * from the RAW text, see shell-scan.js) and every spill path (spill paths are
 * matched with one level of \" / \' escaping undone, so a path quoted inside
 * code still matches). A send this reader cannot prove counts as external:
 * when in doubt, attribution pauses.
 */
export function scanExecutionText(text, { unescape = true } = {}) {
  const raw = String(text ?? '');
  const t = unescape ? raw.replace(/\\(["'])/g, '$1') : raw;
  const { sends, unparsedSends, commSends, uncertainSends } = scanShellSends(raw);
  const spills = [];
  SPILL_RE.lastIndex = 0;
  let m;
  while ((m = SPILL_RE.exec(t)) !== null) spills.push(m[1]);
  return { sends, unparsedSends, spills, commSends, uncertainSends };
}

/** The comm CLI sends of a command line (see scanShellSends). */
export function scanCommCli(text) {
  return scanShellSends(text).commSends;
}

/** Command text of a shell-like tool call (Claude Bash / Codex exec_command / shell). */
export function commandText(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ');
  return '';
}

/**
 * The shell script a command tool runs, for send scanning: a string command as
 * is; an argv array as its `sh -c` script or its elements shell-quoted.
 */
export function commandScript(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return argvToScript(c);
  return '';
}

// ── step title (the agent's own action description) ────────────────────────

export const DESCRIPTION_REDACTED = REDACTED;

/**
 * A model-written action description (Claude Code Bash / Monitor
 * `description`, a sub-agent task description) as a step title: controls →
 * space, whitespace collapsed, secrets redacted (privacy.js — nothing else is
 * hidden), cut to ≤ TITLE_LIMIT code points ("…" when cut). Taken as-is: no
 * translation, no rewording.
 *
 * @returns {string|undefined} undefined when nothing usable is left
 */
export function sanitizeDescription(text) {
  return displayLine(text, TITLE_LIMIT);
}

/**
 * Fold one execution's scan into the signals:
 *   signals.replies   every c4-send to "openmax" (endpoint per send), and every
 *                     comm CLI reply verb whose top-level conversationId is a
 *                     literal ({channel:'openmax', conversationId}); one whose
 *                     destination cannot be proven counts as external
 *   signals.external  any send to another channel, or an unparsable send —
 *                     takes precedence over replies, whatever the order
 *   signals.spillC4Ids  every C4 spill file the execution touches
 */
function applyScan(signals, scan) {
  for (const s of scan.sends) {
    if (s.channel === 'openmax') (signals.replies || (signals.replies = [])).push({ channel: s.channel, endpoint: s.endpoint });
    else signals.external = true;
  }
  if (scan.unparsedSends > 0) signals.external = true;
  // A send that may or may not run (after a runtime `set -n`): pause, but
  // never a reply — no run is marked replied or closed on it.
  if (scan.uncertainSends > 0) signals.external = true;
  for (const c of scan.commSends || []) {
    if (c.conversationId) (signals.replies || (signals.replies = [])).push({ channel: 'openmax', conversationId: c.conversationId });
    // A comm CLI send whose destination cannot be proven may go anywhere:
    // pause attribution (signal ③) until reliable focus evidence returns.
    else signals.external = true;
  }
  if (scan.spills.length) signals.spillC4Ids = [...new Set([...(signals.spillC4Ids || []), ...scan.spills])];
}

/**
 * @returns {{ category: string, title?: string, object?: string, live_preview?: true, waitRef?: string,
 *   signals: { spillC4Ids?: string[], replies?: ({channel, endpoint}|{channel, conversationId})[], external?: true } }}
 *   title: the agent's own action description (Bash / Monitor / sub-agent) or
 *   a generic tool's display name; object: search terms, domain, file name,
 *   pattern, skill name. Both redacted (secrets only) and capped.
 */
export function classifyTool(name, input) {
  const n = String(name ?? '');
  const signals = {};
  let category = 'tool';
  let title;
  let object;
  let livePreview = false;

  if (COMMAND_TOOLS.has(n) || WRAPPER_EXEC_TOOLS.has(n)) {
    // The whole operation is scanned — a compound command may hold several
    // sends. Plain command tools: the command field only (a Bash `description`
    // is not executed). Wrappers: only the commands the strict recognizer
    // fully recovers; a wrapper it cannot fully read pauses attribution.
    let leaves;
    if (WRAPPER_EXEC_TOOLS.has(n)) {
      const cmds = recoverWrapperCommands(input);
      leaves = cmds || [];
      if (!cmds) signals.uninspectable = true;
    } else {
      leaves = [commandScript(input)].filter(Boolean);
    }
    if (signals.uninspectable || leaves.length === 0) {
      signals.external = true;          // cannot inspect what runs: pause attribution
    } else {
      // Recovered wrapper commands are already unescaped literals. Each one is
      // a separate shell invocation, scanned on its own: shell state (e.g. a
      // `set -n`) in one never carries into the next.
      for (const leaf of leaves) applyScan(signals, scanExecutionText(leaf, { unescape: !WRAPPER_EXEC_TOOLS.has(n) }));
    }
    if (signals.replies) category = 'reply';
    else if (leaves.some((l) => KB_RE.test(l))) category = 'kb';
    else category = 'command';
    // Claude Code Bash / Monitor `description` (optional; Codex exec_command has none).
    if (COMMAND_TOOLS.has(n)) title = sanitizeDescription(input?.description);
  } else if (READ_TOOLS.has(n)) {
    const p = String(input?.file_path ?? input?.path ?? '');
    const spills = scanExecutionText(p).spills;
    applyScan(signals, { sends: [], unparsedSends: 0, spills, commSends: [] });
    category = IMAGE_EXT.has(path.extname(p).toLowerCase()) ? 'image' : 'read';
    // The C4 spill file (the message body itself) has no meaningful name.
    if (!spills.length) object = fileObject(p);
  } else if (n === 'view_image') {
    category = 'image';
    object = fileObject(input?.path);
  } else if (WRITE_TOOLS.has(n) || EDIT_TOOLS.has(n)) {
    category = WRITE_TOOLS.has(n) ? 'write' : 'edit';
    object = displayLine(editTarget(n, input), OBJECT_LIMIT);
    livePreview = true;
  } else if (SEARCH_TOOLS.has(n)) {
    category = 'search_files';
    object = displayLine(input?.pattern ?? input?.query, OBJECT_LIMIT);
  } else if (SEARCH_WEB_TOOLS.has(n)) {
    category = 'search_web';
    object = displayLine(input?.query, OBJECT_LIMIT);
  } else if (FETCH_WEB_TOOLS.has(n)) {
    category = 'fetch_web';
    object = displayLine(siteOf(input?.url), OBJECT_LIMIT);
  } else if (n === 'web_search_call') {
    // Codex: one call type for search and page open (action.type).
    const a = input?.action && typeof input.action === 'object' ? input.action : input;
    const t = a?.type;
    if (t === 'open_page' || t === 'find_in_page') {
      category = 'fetch_web';
      object = displayLine(siteOf(a?.url), OBJECT_LIMIT);
    } else {
      category = 'search_web';
      object = displayLine(a?.query ?? (Array.isArray(a?.queries) ? a.queries[0] : undefined), OBJECT_LIMIT);
    }
  } else if (DELEGATE_TOOLS.has(n)) {
    category = 'delegate';
    title = sanitizeDescription(input?.description);
  } else if (n === 'Skill') {
    category = input?.skill === 'openmax-kb' ? 'kb' : 'skill';
    if (category === 'skill') object = displayLine(input?.skill, OBJECT_LIMIT);
  } else if (WAITING_TOOLS.has(n)) {
    const out = { category: 'waiting', signals };
    // Codex write_stdin polls a running exec_command session.
    const sid = input?.session_id ?? input?.sessionId;
    if (Number.isInteger(sid) || (typeof sid === 'string' && /^\d{1,12}$/.test(sid))) out.waitRef = `session:${sid}`;
    return out;
  } else {
    // Any other tool: its display name is the title (no arguments, no result).
    title = toolDisplayName(n);
  }

  const out = { category, signals };
  if (title) out.title = title;
  if (object) out.object = object;
  if (livePreview) out.live_preview = true;
  return out;
}

/** Basename of a file path as a step object. */
function fileObject(p) {
  return typeof p === 'string' && p ? displayLine(path.basename(p), OBJECT_LIMIT) : undefined;
}

/**
 * Display name of a generic tool: an MCP tool (`mcp__<server>__<tool>`) shows
 * its tool part; any other name as-is.
 */
export function toolDisplayName(name) {
  const n = String(name ?? '');
  const m = /^mcp__.+?__(.+)$/.exec(n);
  return displayLine(m ? m[1] : n, TITLE_LIMIT);
}
