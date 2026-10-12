/**
 * Static shell reading for the reply signals (classify.js): which `c4-send.js`
 * and comm CLI (`comm.js comm.send / send_card / ask_card`) invocations a
 * command line really makes, and where each one sends.
 *
 * Nothing is executed or expanded. The text is split into simple commands
 * (`;`, `&&`, `||`, `|`, `&`, newline, parentheses), each word is read with the
 * shell's quoting rules, and heredoc bodies are cut out. A word whose value the
 * shell would compute ($VAR, $(…), `…`, ${…}) is "unknown".
 *
 * An invocation is recognized by its real executable word:
 *   [VAR=… …] [exec|command|nohup|time|env …|timeout …|nice …] <node> [opts] <script> …
 * where <node> is any word whose basename is node / nodejs (bare, absolute or
 * ~ path, quoted), or <script> run directly, or an unknown executable followed
 * by the script. `bash|sh|zsh|dash|ksh -c '<script>'` and `eval` with literal
 * words are read recursively.
 *
 * Literal arguments an invocation consumes (the c4-send channel / endpoint /
 * message and its heredoc body, the comm CLI verb and JSON argument) are never
 * scanned again: an example command quoted inside a message is text, not a
 * send. Any c4-send.js mention outside those — a form this reader does not
 * recognize, an expansion that may run it — counts as an unparsed send
 * (external: attribution pauses), as does a comm CLI reply verb mentioned
 * outside a recognized invocation.
 */

import path from 'path';
import { CONVERSATION_ID_RE } from './constants.js';

export const COMM_REPLY_COMMANDS = new Set(['comm.send', 'comm.send_card', 'comm.ask_card']);

const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const NODE_RE = /^node(js)?(\.exe)?$/;
const NODE_OPTS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--input-type', '--title', '-C', '--conditions']);
const NODE_INLINE_OPTS = new Set(['-e', '-p', '--eval', '--print']);
// Node modes that never run the script: syntax check, version / help output.
const NODE_NOEXEC_OPTS = new Set(['-c', '--check', '-v', '--version', '-h', '--help', '--v8-options', '--completion-bash']);
const HEREDOC_IN_DQ_RE = /^"\$\(cat\s+<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\n([\s\S]*?)\n\2\n?\)"/;
const C4_MENTION_RE = /c4-send\.js/g;
const COMM_VERB_MENTION_RE = /comm\.js["']?\s+["']?(comm\.(?:send_card|ask_card|send))(?![A-Za-z_])/g;
const MAX_DEPTH = 3;
// Invocation options of a shell (bash / sh / dash / ksh / zsh) this reader
// knows: short flags, flags taking an operand, `-o` / `+o` names, long options.
const SHELL_FLAGS = new Set('abefhkmnptuvxBCEHPTcilrsD'.split(''));
const SHELL_SET_O = new Set([
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history',
  'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify',
  'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace',
]);
const SHELL_LONG = new Set(['--login', '--norc', '--noprofile', '--noediting', '--posix', '--restricted', '--verbose', '--debugger']);
const SHELL_LONG_WITH_VALUE = new Set(['--rcfile', '--init-file']);
const GLOB_RE = /[*?[]/;
// Plain node flags known not to change what runs.
const NODE_KNOWN_FLAG_RE = /^--(?:no-[a-z][a-z-]*|experimental-[a-z][a-z-]*|trace-[a-z][a-z-]*|enable-source-maps|preserve-symlinks(?:-main)?|throw-deprecation|pending-deprecation|max-old-space-size=\d+|stack-size=\d+)$/;

const base = (v) => (typeof v === 'string' ? path.posix.basename(v) : null);

/** End of a `$(…)` starting at i ($ index); nested quotes / parens respected. */
function skipSubst(t, i) {
  let depth = 0;
  for (let j = i + 1; j < t.length; j++) {
    const c = t[j];
    if (c === '\\') { j += 1; continue; }
    if (c === "'") { const k = t.indexOf("'", j + 1); if (k < 0) return t.length; j = k; continue; }
    if (c === '"') {
      for (j += 1; j < t.length && t[j] !== '"'; j++) {
        if (t[j] === '\\') j += 1;
        else if (t[j] === '$' && t[j + 1] === '(') j = skipSubst(t, j) - 1;
      }
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return j + 1; }
  }
  return t.length;
}

/** End of a `…` starting at i. */
function skipBacktick(t, i) {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') { j += 1; continue; }
    if (t[j] === '`') return j + 1;
  }
  return t.length;
}

/**
 * Read one word starting at i (not a blank / operator).
 * @returns {{ start: number, end: number, value: string|null }} value null = unknown
 */
export function readWord(t, i) {
  const start = i;
  let out = '';
  let unknown = false;
  while (i < t.length && !WORD_END.has(t[i])) {
    const c = t[i];
    if (c === "'") {
      const j = t.indexOf("'", i + 1);
      if (j < 0) return { start, end: t.length, value: null };
      out += t.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const hd = HEREDOC_IN_DQ_RE.exec(t.slice(i));
      if (hd) {
        if (!hd[1] && /[$`]/.test(hd[3])) unknown = true;
        out += hd[3];
        i += hd[0].length;
        continue;
      }
      i += 1;
      let closed = false;
      while (i < t.length) {
        const d = t[i];
        if (d === '"') { i += 1; closed = true; break; }
        if (d === '\\' && i + 1 < t.length && '"\\$`\n'.includes(t[i + 1])) {
          if (t[i + 1] !== '\n') out += t[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' && (t[i + 1] === '(' || t[i + 1] === '{' || /[A-Za-z0-9_@*#?$!-]/.test(t[i + 1] || ''))) {
          unknown = true;
          if (t[i + 1] === '(') { i = skipSubst(t, i); continue; }
          if (t[i + 1] === '{') { const k = t.indexOf('}', i); i = k < 0 ? t.length : k + 1; continue; }
          i += 2;
          continue;
        }
        if (d === '`') { unknown = true; i = skipBacktick(t, i); continue; }
        out += d;
        i += 1;
      }
      if (!closed) return { start, end: t.length, value: null };
    } else if (c === '\\') {
      if (i + 1 < t.length && t[i + 1] !== '\n') out += t[i + 1];
      i += 2;
    } else if (c === '$' && t[i + 1] === '(') {
      unknown = true;
      i = skipSubst(t, i);
    } else if (c === '$' && t[i + 1] === "'") {
      unknown = true;
      const j = t.indexOf("'", i + 2);
      i = j < 0 ? t.length : j + 1;
    } else if (c === '$' && t[i + 1] === '{') {
      unknown = true;
      const k = t.indexOf('}', i);
      i = k < 0 ? t.length : k + 1;
    } else if (c === '$' && /[A-Za-z0-9_@*#?$!-]/.test(t[i + 1] || '')) {
      unknown = true;
      i += 1;
      while (i < t.length && /[A-Za-z0-9_]/.test(t[i])) i += 1;
      if (/[@*#?$!-]/.test(t[i] || '') && t[i - 1] === '$') i += 1;
    } else if (c === '`') {
      unknown = true;
      i = skipBacktick(t, i);
    } else {
      out += c;
      i += 1;
    }
  }
  return { start, end: i, value: unknown ? null : out };
}

/**
 * Split text into simple commands.
 * @returns {{ words: object[], heredocs: {start,end}[], herestrings: object[] }[]}
 */
export function splitCommands(t) {
  const commands = [];
  const newCmd = () => ({ words: [], heredocs: [], herestrings: [] });
  let cur = newCmd();
  let pending = [];
  const end = () => {
    if (cur.words.length || cur.heredocs.length || cur.herestrings.length || pending.some((p) => p.cmd === cur)) commands.push(cur);
    cur = newCmd();
  };
  const blanks = (i) => {
    for (;;) {
      if (t[i] === ' ' || t[i] === '\t' || t[i] === '\r') i += 1;
      else if (t[i] === '\\' && t[i + 1] === '\n') i += 2;
      else return i;
    }
  };
  let i = 0;
  while (i < t.length) {
    i = blanks(i);
    if (i >= t.length) break;
    const c = t[i];
    if (c === '\n') {
      i += 1;
      end();
      for (const h of pending) {
        const bodyStart = i;
        let bodyEnd = t.length;
        let next = t.length;
        let ls = i;
        while (ls < t.length) {
          const nl = t.indexOf('\n', ls);
          const lineEnd = nl < 0 ? t.length : nl;
          const line = t.slice(ls, lineEnd);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
            bodyEnd = ls;
            next = nl < 0 ? t.length : nl + 1;
            break;
          }
          if (nl < 0) break;
          ls = nl + 1;
        }
        h.cmd.heredocs.push({ start: bodyStart, end: bodyEnd, quoted: h.quoted });
        i = next;
      }
      pending = [];
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(t[i - 1]))) {
      const nl = t.indexOf('\n', i);
      i = nl < 0 ? t.length : nl;
      continue;
    }
    const redir = /^(\d*)(<<<|<<-|<<|>>|<>|>&|<&|>\||&>>|&>|>|<)/.exec(t.slice(i, i + 8));
    if (redir && (c === '<' || c === '>' || (c === '&' && t[i + 1] === '>') || /\d/.test(c))) {
      const op = redir[2];
      i += redir[0].length;
      i = blanks(i);
      if (i >= t.length || t[i] === '\n') continue;
      const w = readWord(t, i);
      i = Math.max(w.end, i + 1);
      if (op === '<<' || op === '<<-') {
        // A backslash-newline is a line continuation, not quoting: <<EO\⏎F is
        // the unquoted delimiter EOF. Any real quoting left (<<'EOF', <<"EOF",
        // <<\EOF, <<E"OF") makes the body literal; an unquoted one expands
        // $(…) / `…` in it.
        const rawDelim = t.slice(w.start, w.end).replace(/\\\n/g, '');
        const delim = w.value ?? rawDelim.replace(/['"\\]/g, '');
        const quoted = /['"\\]/.test(rawDelim);
        pending.push({ cmd: cur, delim, strip: op === '<<-', quoted });
      } else if (op === '<<<') {
        cur.herestrings.push(w);
      }
      continue;
    }
    if (';&|()'.includes(c)) {
      i += (t[i + 1] === c && c !== '(' && c !== ')') ? 2 : 1;
      end();
      continue;
    }
    const w = readWord(t, i);
    cur.words.push(w);
    i = Math.max(w.end, i + 1);
  }
  end();
  return commands;
}

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

/** Index of the executable word, past assignments, keywords and simple wrappers. */
function execIndex(words) {
  let k = 0;
  const lit = (w) => (w ? w.value : null);
  const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value ?? '') || (w.value === null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw || ''));
  for (;;) {
    const w = words[k];
    if (!w) return k;
    if (KEYWORDS.has(lit(w)) || isAssign(w)) { k += 1; continue; }
    const v = lit(w);
    if (v === 'exec' || v === 'command' || v === 'nohup') { k += 1; continue; }
    if (v === 'env') {
      k += 1;
      while (words[k] && ((words[k].value ?? '').startsWith('-') || isAssign(words[k]))) k += 1;
      continue;
    }
    if (v === 'timeout') {
      k += 1;
      while (words[k] && (words[k].value ?? '').startsWith('-')) k += 1;
      k += 1;                                   // the duration
      continue;
    }
    if (v === 'nice') {
      k += 1;
      if (words[k]?.value === '-n') k += 2;
      else if (/^-\d+$/.test(words[k]?.value ?? '')) k += 1;
      continue;
    }
    return k;
  }
}

/**
 * Spans of a heredoc body the shell executes: $(…) and `…` (an unquoted
 * delimiter only; \$ and \` are escapes there).
 */
function expandingSpans(t, start, end) {
  const spans = [];
  for (let i = start; i < end; i++) {
    const c = t[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '$' && t[i + 1] === '(') { const e = Math.min(skipSubst(t, i), end); spans.push([i, e]); i = e - 1; continue; }
    if (c === '`') { const e = Math.min(skipBacktick(t, i), end); spans.push([i, e]); i = e - 1; }
  }
  return spans;
}

/** Ranges of a heredoc body that are text, not commands: all of a literal body; an expanding body minus its $(…) / `…`. */
function heredocTextRanges(t, h) {
  if (h.quoted) return [[h.start, h.end]];
  const out = [];
  let pos = h.start;
  for (const [s, e] of expandingSpans(t, h.start, h.end)) {
    if (s > pos) out.push([pos, s]);
    pos = e;
  }
  if (pos < h.end) out.push([pos, h.end]);
  return out;
}

/**
 * Invocation options of a shell, read in order: short groups (-nc, -xn, +n …),
 * `-o name` / `+o name` (also grouped: -eo noexec), `-O name`, long options.
 * `-` turns an option on, `+` off; the last noexec setting wins (`-n +n`
 * runs, `+n -n` does not). noexec is tri-state: true / false / null =
 * unknown — a word that is not a plain literal (null value, glob characters),
 * an option this reader does not know, or an unknown `-o` / `+o` name makes
 * the outcome unprovable.
 * @param {(string|null)[]} values word values (null = computed by the shell)
 */
export function shellOptionState(values, from = 0) {
  let j = from;
  let noexec = false;
  let unknown = false;
  let command = false;
  const literal = (v) => typeof v === 'string' && !GLOB_RE.test(v);
  for (;;) {
    const v = values[j];
    if (v === null) { unknown = true; j += 1; continue; }     // $flags, "$(…)": anything
    if (typeof v !== 'string' || v === '-' || v === '--' || !/^[-+]/.test(v)) break;
    j += 1;
    if (!literal(v)) { unknown = true; continue; }
    if (v.startsWith('--')) {
      if (SHELL_LONG_WITH_VALUE.has(v)) { if (!literal(values[j])) unknown = true; j += 1; }
      else if (!SHELL_LONG.has(v)) unknown = true;              // incl. --version / --help: not modelled
      continue;
    }
    const on = v[0] === '-';
    for (const f of v.slice(1)) {
      if (f === 'o' || f === 'O') {
        const name = values[j];
        j += 1;
        if (!literal(name)) unknown = true;
        else if (f === 'o') {
          if (!SHELL_SET_O.has(name)) unknown = true;
          else if (name === 'noexec') noexec = on;
        }
      } else if (!SHELL_FLAGS.has(f)) {
        unknown = true;
      } else if (f === 'n') {
        noexec = on;
      } else if (f === 'c' && on) {
        command = true;
      }
    }
  }
  if (values[j] === '--') j += 1;
  return { noexec: unknown ? null : noexec, command, next: j };
}

function shellOptions(words, from) {
  return shellOptionState(words.map((w) => w.value), from);
}

function analyze(t, depth) {
  const out = { sends: [], unparsedSends: 0, commSends: [] };
  const accounted = [];
  const account = (w) => { if (w) accounted.push([w.start, w.end]); };
  const accountLiteral = (w) => { if (w && w.value !== null) account(w); };
  const accountHeredocs = (cmd) => { for (const h of cmd.heredocs) accounted.push(...heredocTextRanges(t, h)); };
  /** A command that runs nothing it names: its literal words / heredoc text are not sends. */
  const accountInert = (cmd) => { cmd.words.forEach(accountLiteral); cmd.herestrings.forEach(accountLiteral); accountHeredocs(cmd); };
  const commands = splitCommands(t);
  for (const cmd of commands) {
    const words = cmd.words;
    for (const w of words) w.raw = t.slice(w.start, w.end);
    const k = execIndex(words);
    const exe = words[k];
    if (!exe) continue;
    const exeBase = base(exe.value);

    // A `set -n` / `set -o noexec` inside a script is not an exemption: what
    // follows it is read as running (whether it takes effect depends on
    // scope, function names, interactive mode … — not provable statically).

    if (SHELLS.has(exeBase)) {
      const opts = shellOptions(words, k + 1);
      const script = words[opts.next];
      if (opts.noexec === true) {
        // -n (noexec), alone or in a group (-nc), last setting on: read, never run.
        accountInert(cmd);
        continue;
      }
      // noexec unknown: may run. Nothing is accounted, so a send it names
      // pauses attribution (never counts as a reply).
      if (opts.noexec === null) continue;
      if (opts.command && script?.value != null && depth < MAX_DEPTH) {
        const sub = analyze(script.value, depth + 1);
        out.sends.push(...sub.sends);
        out.commSends.push(...sub.commSends);
        out.unparsedSends += sub.unparsedSends;
        account(script);
      }
      continue;
    }
    if (exe.value === 'eval' && depth < MAX_DEPTH) {
      const rest = words.slice(k + 1);
      if (rest.length && rest.every((w) => w.value !== null)) {
        const sub = analyze(rest.map((w) => w.value).join(' '), depth + 1);
        out.sends.push(...sub.sends);
        out.commSends.push(...sub.commSends);
        out.unparsedSends += sub.unparsedSends;
        rest.forEach(account);
      }
      continue;
    }

    let scriptIdx = -1;
    if (NODE_RE.test(exeBase || '')) {
      let j = k + 1;
      let inline = false;
      let noexec = false;
      let unknown = false;                     // an option word this reader cannot prove
      while (words[j] && (words[j].value === null || words[j].value.startsWith('-'))) {
        const v = words[j].value;
        if (v === null || GLOB_RE.test(v)) { unknown = true; j += 1; continue; }
        const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
        if (NODE_INLINE_OPTS.has(name)) { inline = true; break; }
        if (NODE_NOEXEC_OPTS.has(v)) noexec = true;
        else if (!NODE_OPTS_WITH_VALUE.has(name) && !NODE_KNOWN_FLAG_RE.test(v)) unknown = true;
        if (NODE_OPTS_WITH_VALUE.has(v)) {
          if (words[j + 1]?.value == null) unknown = true;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (noexec && !inline) {
        // node --check / -c / --version / --help with only literal, known
        // options: the script is never run. With an option this reader
        // cannot prove it may run: nothing accounted (a send named pauses).
        if (!unknown) accountInert(cmd);
        continue;
      }
      if (unknown) continue;
      if (!inline) scriptIdx = j;
    } else if (exeBase === 'c4-send.js' || exeBase === 'comm.js') {
      scriptIdx = k;
    } else if (exe.value === null) {
      const nb = base(words[k + 1]?.value);
      if (nb === 'c4-send.js' || nb === 'comm.js') scriptIdx = k + 1;
    }
    const script = words[scriptIdx];
    const sb = base(script?.value);
    if (sb === 'c4-send.js') {
      const [channel, endpoint, message] = [words[scriptIdx + 1], words[scriptIdx + 2], words[scriptIdx + 3]];
      account(script);
      if (channel?.value != null && endpoint?.value != null) {
        out.sends.push({ channel: channel.value, endpoint: endpoint.value });
        account(channel);
        account(endpoint);
        accountLiteral(message);
        accountHeredocs(cmd);
        cmd.herestrings.forEach(accountLiteral);
      } else {
        out.unparsedSends += 1;
      }
    } else if (sb === 'comm.js') {
      account(script);
      const verb = words[scriptIdx + 1];
      if (!verb) continue;
      if (verb.value === null) {
        out.commSends.push({ command: null, conversationId: null });
        continue;
      }
      account(verb);
      const args = words.slice(scriptIdx + 2);
      args.forEach(accountLiteral);
      accountHeredocs(cmd);
      if (!COMM_REPLY_COMMANDS.has(verb.value)) continue;
      const arg = args[0];
      const id = arg && arg.value !== null && args.length === 1 ? topLevelConversationId(arg.value) : null;
      out.commSends.push({ command: verb.value, conversationId: id });
    }
  }

  const inAccounted = (p) => accounted.some(([s, e]) => p >= s && p < e);
  let m;
  C4_MENTION_RE.lastIndex = 0;
  while ((m = C4_MENTION_RE.exec(t)) !== null) if (!inAccounted(m.index)) out.unparsedSends += 1;
  COMM_VERB_MENTION_RE.lastIndex = 0;
  while ((m = COMM_VERB_MENTION_RE.exec(t)) !== null) {
    if (!inAccounted(m.index)) out.commSends.push({ command: null, conversationId: null });
  }
  return out;
}

/**
 * Every c4-send and comm CLI send in a shell command line.
 * @returns {{ sends: {channel, endpoint}[], unparsedSends: number,
 *   commSends: { command: string|null, conversationId: string|null }[] }}
 *   commSends: destination known / reply verb with an unprovable destination
 *   (conversationId null) / a send whose verb cannot be read (command null).
 */
export function scanShellSends(text) {
  return analyze(String(text ?? ''), 0);
}

/**
 * An argv array as a shell command line: `[sh|bash… , -c…, script, …]` is the
 * script itself; anything else is joined with each element quoted as needed.
 */
export function argvToScript(argv) {
  if (!Array.isArray(argv)) return '';
  const a = argv.filter((x) => typeof x === 'string');
  const ci = a.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
  const noexec = shellOptionState(a.slice(1, ci + 1)).noexec;
  // A noexec shell (-n, -nc …), or one whose noexec is unknown, keeps its
  // whole argv so the reader sees the options.
  if (a.length > 0 && SHELLS.has(base(a[0])) && ci > 0 && noexec === false && a.slice(1, ci).every((x) => x.startsWith('-')) && a[ci + 1] !== undefined) {
    return a[ci + 1];
  }
  return a.map((x) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(' ');
}
