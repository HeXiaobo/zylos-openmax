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
// The openmax comm CLI (`node …/comm.js <command> '<json>'`). Only the three
// outbound verbs are replies; every other command (get_messages, answered,
// pending_clear, member_list …) is not. See scanCommCli().
const COMM_INVOKE_RE = /(?:^|[\s;&|(`])node\s+(?:-[^\s]+\s+)*["']?[^\s"';&|()]*comm\.js["']?(?=[ \t\n]|$)/g;
export const COMM_REPLY_COMMANDS = new Set(['comm.send', 'comm.send_card', 'comm.ask_card']);
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
  // The comm CLI is read as shell from the RAW text: its argument's own quoting
  // decides what the CLI receives.
  return { sends, unparsedSends: Math.max(0, mentions - sends.length), spills, commSends: scanCommCli(raw) };
}

const SHELL_WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', ')', '<', '>']);
const HEREDOC_IN_DQ_RE = /^"\$\(cat\s+<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\n([\s\S]*?)\n\2\n?\)"/;

/**
 * Read ONE shell word at `i` (leading blanks skipped) as its literal value.
 * Supported: single quotes, double quotes (\" \\ \$ \` escapes), backslash
 * escapes, and the literal heredoc form "$(cat <<'EOF' … EOF)". Anything the
 * shell would expand ($VAR, $(…), `…`, a file read) makes the word unknown.
 * @returns {{ none: true } | { unknown: true } | { value: string, end: number }}
 */
function readShellWord(t, i) {
  while (t[i] === ' ' || t[i] === '\t') i += 1;
  if (i >= t.length || SHELL_WORD_END.has(t[i])) return { none: true };
  let out = '';
  while (i < t.length && !SHELL_WORD_END.has(t[i])) {
    const c = t[i];
    if (c === "'") {
      const j = t.indexOf("'", i + 1);
      if (j < 0) return { unknown: true };
      out += t.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const hd = HEREDOC_IN_DQ_RE.exec(t.slice(i));
      if (hd) {
        if (!hd[1] && /[$`]/.test(hd[3])) return { unknown: true };
        out += hd[3];
        i += hd[0].length;
        continue;
      }
      i += 1;
      for (;;) {
        if (i >= t.length) return { unknown: true };
        const d = t[i];
        if (d === '"') { i += 1; break; }
        if (d === '$' || d === '`') return { unknown: true };
        if (d === '\\' && i + 1 < t.length && '"\\$`\n'.includes(t[i + 1])) {
          if (t[i + 1] !== '\n') out += t[i + 1];
          i += 2;
          continue;
        }
        out += d;
        i += 1;
      }
    } else if (c === '\\') {
      if (i + 1 < t.length && t[i + 1] !== '\n') out += t[i + 1];
      i += 2;
    } else if (c === '$' || c === '`') {
      return { unknown: true };
    } else {
      out += c;
      i += 1;
    }
  }
  return { value: out, end: i };
}

/** After the JSON argument only the end of the command may follow (comm.js joins all args). */
function commandEndsAt(t, i) {
  while (t[i] === ' ' || t[i] === '\t') i += 1;
  if (i >= t.length || '\n;&|)<>'.includes(t[i])) return true;
  return /^\d+>/.test(t.slice(i, i + 3));
}

/** Top-level conversationId of a literal JSON object argument, or null. */
function topLevelConversationId(json) {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const id = v.conversationId;
    return typeof id === 'string' && CONVERSATION_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Every comm CLI invocation (`node <path>/comm.js <verb> <arg>`) that is, or
 * may be, a reply send. Only that invocation's own argument is read: it must
 * be one literal shell word holding a JSON object, and the destination is its
 * TOP-LEVEL conversationId (an ID inside `content`, or anywhere else in the
 * command line, never counts).
 *
 *   { command: 'comm.send'|…, conversationId }  destination known
 *   { command, conversationId: null }            reply verb, destination not
 *                                                provable (variable, file,
 *                                                extra words, not JSON …)
 *   { command: null, conversationId: null }      verb itself not literal
 * Non-reply verbs are left out.
 * @returns {{ command: string|null, conversationId: string|null }[]}
 */
export function scanCommCli(text) {
  const t = String(text ?? '');
  const out = [];
  COMM_INVOKE_RE.lastIndex = 0;
  let m;
  while ((m = COMM_INVOKE_RE.exec(t)) !== null) {
    const verb = readShellWord(t, COMM_INVOKE_RE.lastIndex);
    if (verb.none) continue;
    if (verb.unknown) { out.push({ command: null, conversationId: null }); continue; }
    if (!COMM_REPLY_COMMANDS.has(verb.value)) continue;
    const arg = readShellWord(t, verb.end);
    const id = arg.value !== undefined && commandEndsAt(t, arg.end) ? topLevelConversationId(arg.value) : null;
    out.push({ command: verb.value, conversationId: id });
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

// What ends a URL in a description (a character-class body).
const URL_END = '\\s"\'`<>()\\[\\]{}，。、；：！？（）【】「」『』《》〈〉“”‘’…';

const DESC_RULES = [
  // URL → scheme://host (userinfo, port, path, query, fragment dropped). The
  // URL runs to whitespace, a quote, an ASCII bracket or a full-width CJK
  // punctuation mark — any other character, non-ASCII included (CJK, emoji,
  // accents), is part of the URL and dropped with it.
  [new RegExp(`\\b([A-Za-z][A-Za-z0-9+.-]*):\\/\\/(?:[^${URL_END}/?#@]*@)?([^${URL_END}/?#:@]+)(?::\\d+)?[^${URL_END}]*`, 'g'), '$1://$2'],
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
  for (const c of scan.commSends || []) {
    if (c.conversationId) (signals.replies || (signals.replies = [])).push({ channel: 'openmax', conversationId: c.conversationId });
    // A comm CLI send whose destination cannot be proven may go anywhere:
    // pause attribution (signal ③) until reliable focus evidence returns.
    else signals.external = true;
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
