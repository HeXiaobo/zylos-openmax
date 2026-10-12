/**
 * Tool call → display category, public tool name, program name, and the
 * focus signals the attribution needs. Runs on the agent host only: the tool
 * input (command text, paths, URLs …) is inspected here and then discarded —
 * only the enum category and the two allowlisted names ever leave the host.
 */

import path from 'path';
import { TOOL_ALLOWLIST, DETAIL_ALLOWLIST } from './constants.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const COMMAND_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell']);
const READ_TOOLS = new Set(['Read', 'read_file']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'tool_search_call']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch', 'web_search_call']);
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
const WAITING_TOOLS = new Set(['write_stdin', 'wait', 'TaskOutput']);

// Execution wrappers whose payload is not a plain command (e.g. Codex's
// `exec` custom tool, whose input is code that calls other tools). Their input
// is never evaluated: every string inside it is scanned as text.
const WRAPPER_EXEC_TOOLS = new Set(['exec']);

const C4_SEND_MENTION_RE = /c4-send\.js/g;
const C4_SEND_RE = /c4-send\.js["']?\s+["']?([A-Za-z0-9_.-]+)["']?\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
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
 * Scan text (one level of \" / \' escaping undone, so a command quoted inside
 * wrapper code still matches) for EVERY c4-send invocation and spill path.
 * A c4-send mention whose channel cannot be parsed counts as an external send:
 * when in doubt, attribution pauses.
 */
export function scanExecutionText(text) {
  const t = String(text ?? '').replace(/\\(["'])/g, '$1');
  const sends = [];
  C4_SEND_RE.lastIndex = 0;
  let m;
  while ((m = C4_SEND_RE.exec(t)) !== null) sends.push({ channel: m[1], endpoint: m[2] ?? m[3] ?? m[4] });
  const mentions = (t.match(C4_SEND_MENTION_RE) || []).length;
  const spills = [];
  SPILL_RE.lastIndex = 0;
  while ((m = SPILL_RE.exec(t)) !== null) spills.push(m[1]);
  return { sends, unparsedSends: Math.max(0, mentions - sends.length), spills };
}

/** Command text of a shell-like tool call (Claude Bash / Codex exec_command / shell). */
export function commandText(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ');
  return '';
}

/** First word of a command, basename only, if it is an allowlisted program. */
export function programName(command) {
  const m = /^\s*(\S+)/.exec(String(command ?? ''));
  if (!m) return undefined;
  const word = path.basename(m[1].replace(/^["']|["']$/g, ''));
  return DETAIL_ALLOWLIST.has(word) ? word : undefined;
}

/**
 * Fold one execution's scan into the signals:
 *   signals.replies   every c4-send to "openmax" (endpoint per send)
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
  if (scan.spills.length) signals.spillC4Ids = [...new Set([...(signals.spillC4Ids || []), ...scan.spills])];
}

/**
 * @returns {{ category: string, tool?: string, detail?: string,
 *   signals: { spillC4Ids?: string[], replies?: {channel, endpoint}[], external?: true } }}
 */
export function classifyTool(name, input) {
  const n = String(name ?? '');
  const signals = {};
  let category = 'tool';
  let detail;

  if (COMMAND_TOOLS.has(n) || WRAPPER_EXEC_TOOLS.has(n)) {
    // The whole operation is scanned — a compound command may hold several
    // sends; a wrapper's inner commands are only reachable as text.
    // Plain command tools: the command field only (a Bash `description` is not
    // executed). Wrappers: every string in the payload.
    const leaves = WRAPPER_EXEC_TOOLS.has(n)
      ? stringLeaves(input)
      : [commandText(input)].filter(Boolean);
    if (leaves.length === 0) {
      signals.external = true;          // cannot inspect what runs: pause attribution
    } else {
      applyScan(signals, scanExecutionText(leaves.join('\n')));
    }
    if (signals.replies) category = 'reply';
    else if (leaves.some((l) => KB_RE.test(l))) category = 'kb';
    else {
      category = 'command';
      if (COMMAND_TOOLS.has(n)) detail = programName(commandText(input));
    }
  } else if (READ_TOOLS.has(n)) {
    const p = String(input?.file_path ?? input?.path ?? '');
    applyScan(signals, { sends: [], unparsedSends: 0, spills: scanExecutionText(p).spills });
    category = IMAGE_EXT.has(path.extname(p).toLowerCase()) ? 'image' : 'read';
  } else if (n === 'view_image') {
    category = 'image';
  } else if (WRITE_TOOLS.has(n)) {
    category = 'write';
  } else if (SEARCH_TOOLS.has(n)) {
    category = 'search';
  } else if (WEB_TOOLS.has(n)) {
    category = 'web';
  } else if (DELEGATE_TOOLS.has(n)) {
    category = 'delegate';
  } else if (n === 'Skill') {
    category = input?.skill === 'openmax-kb' ? 'kb' : 'tool';
  } else if (WAITING_TOOLS.has(n)) {
    return { category: 'waiting', signals };
  }

  const out = { category, signals };
  if (TOOL_ALLOWLIST.has(n)) out.tool = n;
  if (detail) out.detail = detail;
  return out;
}
