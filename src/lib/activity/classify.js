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

const OPENMAX_REPLY_RE = /c4-send\.js["']?\s+["']?openmax["']?\s/;
const C4_SEND_RE = /c4-send\.js["']?\s+["']?([A-Za-z0-9_.-]+)["']?\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;
const KB_RE = /skills\/openmax-kb\/|openmax\/src\/cli\/kb\.js/;
const SPILL_RE = /comm-bridge\/attachments\/conv-(\d+)\/message\.txt/;

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

function spillId(text) {
  const m = SPILL_RE.exec(String(text ?? ''));
  return m ? m[1] : undefined;
}

/**
 * @returns {{ category: string, tool?: string, detail?: string,
 *   signals: { spillC4Id?: string, reply?: { channel: string, endpoint?: string } } }}
 */
export function classifyTool(name, input) {
  const n = String(name ?? '');
  const signals = {};
  let category = 'tool';
  let detail;

  if (COMMAND_TOOLS.has(n)) {
    const cmd = commandText(input);
    const s = spillId(cmd);
    if (s) signals.spillC4Id = s;
    const send = C4_SEND_RE.exec(cmd);
    if (send) signals.reply = { channel: send[1], endpoint: send[2] ?? send[3] ?? send[4] };
    if (OPENMAX_REPLY_RE.test(cmd)) category = 'reply';
    else if (KB_RE.test(cmd)) category = 'kb';
    else {
      category = 'command';
      detail = programName(cmd);
    }
  } else if (READ_TOOLS.has(n)) {
    const p = String(input?.file_path ?? input?.path ?? '');
    const s = spillId(p);
    if (s) signals.spillC4Id = s;
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
