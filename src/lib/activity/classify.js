/**
 * Tool call → display category, public tool name, program name, and the
 * focus signals the attribution needs. Runs on the agent host only: the tool
 * input (command text, paths, URLs …) is inspected here and then discarded —
 * only the enum category and the two allowlisted names ever leave the host on
 * the live frame. One more value, the sanitized model-written Bash
 * `description` (never the command text), goes ONLY into the persisted
 * metadata.agent_run step description — see sanitizeDescription().
 */

import path from 'path';
import { TOOL_ALLOWLIST, DETAIL_ALLOWLIST, DESCRIPTION_LIMIT, CONVERSATION_ID_RE } from './constants.js';
import { recoverWrapperCommands } from './wrapper-source.js';

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
// is never evaluated; see wrapper-source.js for the only shape accepted as
// fully inspectable.
const WRAPPER_EXEC_TOOLS = new Set(['exec']);

const C4_SEND_MENTION_RE = /c4-send\.js/g;
const C4_SEND_RE = /c4-send\.js["']?\s+["']?([A-Za-z0-9_.-]+)["']?\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
// The openmax comm CLI (`node …/src/cli/comm.js <command> '<json>'`). Only the
// three outbound verbs are replies; every other command (get_messages,
// answered, pending_clear, member_list …) is not.
const COMM_CLI_RE = /src\/cli\/comm\.js["']?\s+["']?(comm\.[A-Za-z_]+)/g;
const COMM_CLI_MENTION_RE = /src\/cli\/comm\.js|c4-send\.js/g;
export const COMM_REPLY_COMMANDS = new Set(['comm.send', 'comm.send_card', 'comm.ask_card']);
const COMM_CONV_ID_RE = /["']?conversationId["']?\s*:\s*["']([^"'\\\s]+)["']/;
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
export function scanExecutionText(text, { unescape = true } = {}) {
  const raw = String(text ?? '');
  const t = unescape ? raw.replace(/\\(["'])/g, '$1') : raw;
  const sends = [];
  C4_SEND_RE.lastIndex = 0;
  let m;
  while ((m = C4_SEND_RE.exec(t)) !== null) sends.push({ channel: m[1], endpoint: m[2] ?? m[3] ?? m[4] });
  const mentions = (t.match(C4_SEND_MENTION_RE) || []).length;
  const spills = [];
  SPILL_RE.lastIndex = 0;
  while ((m = SPILL_RE.exec(t)) !== null) spills.push(m[1]);
  return { sends, unparsedSends: Math.max(0, mentions - sends.length), spills, commSends: scanCommCli(t) };
}

/**
 * Every comm CLI reply verb in the text, with the conversationId of its JSON
 * argument parsed best-effort: the argument is taken to run up to the next
 * comm.js / c4-send.js mention (or the end), and searched for a
 * "conversationId": "<id>" pair. null when it cannot be read (an argument
 * built from a variable or a file, for example).
 * @returns {{ command: string, conversationId: string|null }[]}
 */
export function scanCommCli(text) {
  const t = String(text ?? '');
  const hits = [];
  COMM_CLI_RE.lastIndex = 0;
  let m;
  while ((m = COMM_CLI_RE.exec(t)) !== null) hits.push({ command: m[1], start: m.index, argStart: COMM_CLI_RE.lastIndex });
  const out = [];
  for (const h of hits) {
    if (!COMM_REPLY_COMMANDS.has(h.command)) continue;
    COMM_CLI_MENTION_RE.lastIndex = h.argStart;
    const next = COMM_CLI_MENTION_RE.exec(t);
    const arg = t.slice(h.argStart, next ? next.index : t.length);
    const id = COMM_CONV_ID_RE.exec(arg)?.[1];
    out.push({ command: h.command, conversationId: id && CONVERSATION_ID_RE.test(id) ? id : null });
  }
  return out;
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

// ── step description (agent_run only) ─────────────────────────────────────

export const DESCRIPTION_REDACTED = '[已隐藏]';
const R = DESCRIPTION_REDACTED;

// Removed outright: zero-width characters, BOM, soft hyphen (they could split
// a secret past the patterns below).
const DESC_INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
// Replaced by a space: every C0 / C1 control (incl. \n \t), DEL, line /
// paragraph separators — cws-comm accepts no control character in a description.
// eslint-disable-next-line no-control-regex
const DESC_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const DESC_RULES = [
  // URL → scheme://host (userinfo, port, path, query, fragment dropped).
  [/\b([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^\s/?#@]*@)?([^\s/?#:@"'`<>]+)(?::\d+)?[^\s"'`<>\u0080-\uffff]*/g, '$1://$2'],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, R],
  // Authorization schemes.
  [/\b(Bearer|Basic)\s+\S+/gi, `$1 ${R}`],
  // Well-known secret prefixes.
  [/\b(?:cwsk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|xox[abpr]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, R],
  // key=value / key: value of a sensitive-looking key.
  [/\b(token|password|passwd|pwd|secret|api[-_]?key|access[-_]?key|private[-_]?key)(\s*[=:]\s*)\S+/gi, `$1$2${R}`],
  // Absolute and home paths (a slash not preceded by a word character, dot,
  // colon or another slash — so relative paths and the `://` of a kept URL
  // stay). Runs up to whitespace, a quote, a bracket or punctuation.
  [/(?<![A-Za-z0-9_.:/\\~-])(?:~\/|\/(?=[^\s/]))[^\s"'`<>()[\]{}|,;，。、；：！？（）【】「」]*/g, R],
  // Long hex / base64-ish tokens: ≥ 20 such characters with a letter and a digit.
  [/[A-Za-z0-9+/=_-]{20,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? R : m)],
];

/**
 * Sanitize a model-written step description (Claude Code Bash `description`)
 * for metadata.agent_run: controls → space, whitespace collapsed, paths / URL
 * paths / emails / secrets / long tokens replaced by "[已隐藏]", then cut to
 * ≤ DESCRIPTION_LIMIT (80) code points, ending in "…" when shortened. The text
 * is otherwise taken as-is (no translation, no rewording).
 *
 * @returns {string|undefined} undefined when nothing usable is left (empty,
 *   or nothing but placeholders / punctuation).
 */
export function sanitizeDescription(text) {
  if (typeof text !== 'string') return undefined;
  let s = text.replace(DESC_INVISIBLE_RE, '').replace(DESC_CONTROL_RE, ' ');
  for (const [re, rep] of DESC_RULES) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(s.split(R).join(''))) return undefined;
  const cps = Array.from(s);
  if (cps.length > DESCRIPTION_LIMIT) s = `${cps.slice(0, DESCRIPTION_LIMIT - 1).join('').trimEnd()}…`;
  return s;
}

/**
 * Fold one execution's scan into the signals:
 *   signals.replies   every c4-send to "openmax" (endpoint per send), and every
 *                     comm CLI reply verb whose conversationId could be read
 *                     ({channel:'openmax', conversationId}; one that cannot be
 *                     read is neither a reply nor external)
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
  for (const c of scan.commSends || []) {
    if (c.conversationId) (signals.replies || (signals.replies = [])).push({ channel: 'openmax', conversationId: c.conversationId });
  }
  if (scan.spills.length) signals.spillC4Ids = [...new Set([...(signals.spillC4Ids || []), ...scan.spills])];
}

/**
 * `description` (command tools only) is host-local: it may be persisted in the
 * run file and used as the agent_run step description, but it is never put on
 * a live agent_activity frame event (cws-comm drops tool events with fields
 * outside category / tool / detail / ended_at / error).
 *
 * @returns {{ category: string, tool?: string, detail?: string, description?: string,
 *   signals: { spillC4Ids?: string[], replies?: ({channel, endpoint}|{channel, conversationId})[], external?: true } }}
 */
export function classifyTool(name, input) {
  const n = String(name ?? '');
  const signals = {};
  let category = 'tool';
  let detail;
  let description;

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
      leaves = [commandText(input)].filter(Boolean);
    }
    if (signals.uninspectable || leaves.length === 0) {
      signals.external = true;          // cannot inspect what runs: pause attribution
    } else {
      // Recovered wrapper commands are already unescaped literals.
      applyScan(signals, scanExecutionText(leaves.join('\n'), { unescape: !WRAPPER_EXEC_TOOLS.has(n) }));
    }
    if (signals.replies) category = 'reply';
    else if (leaves.some((l) => KB_RE.test(l))) category = 'kb';
    else {
      category = 'command';
      if (COMMAND_TOOLS.has(n)) detail = programName(commandText(input));
    }
    // Claude Code Bash `description` (optional; Codex exec_command has none).
    if (COMMAND_TOOLS.has(n)) description = sanitizeDescription(input?.description);
  } else if (READ_TOOLS.has(n)) {
    const p = String(input?.file_path ?? input?.path ?? '');
    applyScan(signals, { sends: [], unparsedSends: 0, spills: scanExecutionText(p).spills, commSends: [] });
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
  if (description) out.description = description;
  return out;
}
