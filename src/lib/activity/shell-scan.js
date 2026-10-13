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
// Node modes that never run the script (syntax check, version / help output)
// and their negations, applied in order — the last setting of each wins
// (`--check --no-check` runs the script, `--no-check --check` does not).
const NODE_MODE_FLAGS = new Map([
  ['--check', ['check', true]], ['-c', ['check', true]], ['--no-check', ['check', false]],
  ['--version', ['version', true]], ['-v', ['version', true]], ['--no-version', ['version', false]],
  ['--help', ['help', true]], ['-h', ['help', true]], ['--no-help', ['help', false]],
]);
// Other node modes that print and exit: not modelled, never proof either way.
const NODE_OTHER_MODES = new Set(['--v8-options', '--completion-bash']);
// A variable assignment word: NAME=…, NAME+=…, NAME[i]=…, NAME[i]+=….
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
// An export / declare / readonly … argument naming a variable (with or without a value).
const NAME_ARG_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(?:\+?=|$)/;
/** Name assigned by a word (null = not an assignment). */
function assignName(w) {
  const m = ASSIGN_RE.exec(w?.value ?? w?.raw ?? '');
  return m ? m[1] : null;
}
// Environment that changes what node loads or which binary runs.
const NODE_ENV_NAMES = new Set(['NODE_OPTIONS', 'PATH']);
// Environment a new shell runs code from before its script.
const SHELL_ENV_NAMES = new Set(['BASH_ENV', 'ENV']);
// bash 5.2 `compgen -b`, and those that also exist as PATH programs.
const BASH_BUILTINS = new Set(('. : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs '
  + 'disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf '
  + 'pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias '
  + 'unset wait').split(' '));
// Operands of the coreutils wrappers, as this reader accepts them (a strict
// subset of what coreutils takes: anything else is unknown).
const INT_RE = /^[+-]?\d+$/;
const DURATION_RE = /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/;
const SIGNAL_NAMES = new Set(('HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP '
  + 'TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO POLL PWR SYS').split(' '));
const isDuration = (d) => typeof d === 'string' && DURATION_RE.test(d);
// Numbers GNU coreutils 9.4 `timeout -s N` accepts on Linux (probed 0..70):
// 0-31 and 34-64 — 32 / 33 are reserved by glibc and rejected (exit 125).
const isSignalNumber = (x) => /^\d+$/.test(x) && ((Number(x) >= 0 && Number(x) <= 31) || (Number(x) >= 34 && Number(x) <= 64));
const isSignal = (x) => typeof x === 'string' && (isSignalNumber(x) || SIGNAL_NAMES.has(x.toUpperCase().replace(/^SIG/, '')));
const literalOperand = (x) => typeof x === 'string' && x !== '' && !GLOB_RE.test(x);
const HAS_PROGRAM = new Set(['[', 'echo', 'false', 'kill', 'printf', 'pwd', 'test', 'true']);
const EXPORT_CMDS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
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
// Commands that change what (or whether) later commands run.
const SHELL_STATE_CMDS = new Set(['source', '.', 'trap', 'alias', 'hash', 'function', 'exit', 'return', 'logout']);

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

const isAssignWord = (w) => assignName(w) !== null;

/**
 * The command a word list really runs, past assignments, keywords, wrappers
 * and the shell's execution prefixes in any nesting, keeping track of where
 * the next word is looked up:
 *   shell    — functions, builtins, then PATH (the start)
 *   command  — after `command [-p] [--]`: builtins, then PATH (no functions)
 *   builtin  — after `builtin [--]`: shell builtins only (`builtin node` fails)
 *   external — after `exec …` / `nohup` / `env` / `timeout` / `nice`: a PATH
 *              program only (`exec builtin node` fails: no such program)
 * A lookup that fails, a prefix option this reader does not know, or a shape
 * it cannot follow makes the command unknown: it may not run what it names.
 *   query: `command -v / -V` — only prints what a name is, runs nothing.
 *   execAt: index of an `exec` prefix (the shell is replaced), else -1.
 *   nodeEnv / shellEnv: the command's own environment may load other code —
 *     a NODE_OPTIONS / PATH (resp. BASH_ENV / ENV) assignment prefix, or any
 *     `env` wrapper (-i / -u / -S / NAME=…: not modelled).
 */
function resolveCommand(words) {
  let k = 0;
  let ctx = 'shell';
  let atStart = true;
  let query = false;
  let unknown = false;
  let execAt = -1;
  let nodeEnv = false;
  let shellEnv = false;
  const val = (i) => words[i]?.value;
  const opt = () => words[k] && (words[k].value === null || words[k].value.startsWith('-'));
  const noteAssign = (w) => {
    const n = assignName(w);
    if (NODE_ENV_NAMES.has(n)) nodeEnv = true;
    if (SHELL_ENV_NAMES.has(n)) shellEnv = true;
  };
  const viaBuiltin = () => { if (ctx === 'external') unknown = true; atStart = false; };
  const viaExternal = () => { if (ctx === 'builtin') unknown = true; ctx = 'external'; atStart = false; };
  while (k < words.length && !unknown) {
    const w = words[k];
    const v = w.value;
    if (atStart && v === 'time') {
      k += 1;
      while (val(k) === '-p' || val(k) === '--') k += 1;
      continue;
    }
    if (atStart && (KEYWORDS.has(v) || isAssignWord(w))) { if (isAssignWord(w)) noteAssign(w); k += 1; continue; }
    if (!atStart && (KEYWORDS.has(v) || isAssignWord(w))) { unknown = true; break; }
    if (v === 'command') {
      viaBuiltin();
      ctx = 'command';
      k += 1;
      while (opt()) {
        const o = words[k].value;
        k += 1;
        if (o === '--') break;
        if (o !== null && /^-[pvV]+$/.test(o)) { if (/[vV]/.test(o)) query = true; } else unknown = true;
      }
    } else if (v === 'builtin') {
      viaBuiltin();
      ctx = 'builtin';
      k += 1;
      if (val(k) === '--') k += 1;
      else if (opt()) unknown = true;
    } else if (v === 'exec') {
      viaBuiltin();
      if (execAt < 0) execAt = k;
      ctx = 'external';
      k += 1;
      while (opt()) {
        const o = words[k].value;
        k += 1;
        if (o === '--') break;
        if (o === '-a') { if (k >= words.length) unknown = true; k += 1; }
        else if (o === null || !/^-[cl]+$/.test(o)) unknown = true;
      }
    } else if (v === 'nohup') {
      // Only `--`; --help / --version print and exit, others fail.
      viaExternal();
      k += 1;
      if (val(k) === '--') k += 1;
      else if (opt()) unknown = true;
    } else if (v === 'env') {
      viaExternal();
      nodeEnv = true;
      shellEnv = true;
      k += 1;
      while (words[k] && (opt() || isAssignWord(words[k]))) {
        const o = words[k].value;
        k += 1;
        if (o === null) { unknown = true; break; }
        if (o === '--') break;
        if (isAssignWord(words[k - 1]) && !o.startsWith('-')) continue;
        if (o === '-i' || o === '--ignore-environment') continue;
        if (o === '-u' || o === '--unset' || o === '-C' || o === '--chdir') {
          if (!literalOperand(val(k)) || ((o === '-u' || o === '--unset') && val(k).includes('='))) unknown = true;
          k += 1;
          continue;
        }
        const mu = /^(?:--unset=|-u)(.+)$/.exec(o);
        if (mu) { if (!literalOperand(mu[1]) || mu[1].includes('=')) unknown = true; continue; }
        const mc = /^(?:--chdir=|-C)(.+)$/.exec(o);
        if (mc) { if (!literalOperand(mc[1])) unknown = true; continue; }
        unknown = true;                          // -S, -0, --help, --version, anything else
      }
    } else if (v === 'timeout') {
      // [--preserve-status] [--foreground] [-v] [-s SIG] [-k DUR] [--] DUR:
      // every option and operand a literal of a verified shape.
      viaExternal();
      k += 1;
      while (opt()) {
        const o = words[k].value;
        k += 1;
        if (o === '--') break;
        if (o === '--preserve-status' || o === '--foreground' || o === '-v' || o === '--verbose') continue;
        let operand;
        let check;
        if (o === '-s' || o === '--signal') { operand = val(k); k += 1; check = isSignal; }
        else if (o === '-k' || o === '--kill-after') { operand = val(k); k += 1; check = isDuration; }
        else if (/^(?:-s|--signal=)/.test(o)) { operand = o.replace(/^(?:-s|--signal=)/, ''); check = isSignal; }
        else if (/^(?:-k|--kill-after=)/.test(o)) { operand = o.replace(/^(?:-k|--kill-after=)/, ''); check = isDuration; }
        if (!check || !check(operand)) { unknown = true; break; }
      }
      if (!isDuration(val(k))) unknown = true;
      k += 1;                                   // the duration
    } else if (v === 'nice') {
      // -n N / -nN / --adjustment=N / --adjustment N / -N, N a literal integer.
      viaExternal();
      k += 1;
      const o = val(k);
      if (o === '-n' || o === '--adjustment') { if (!INT_RE.test(val(k + 1) ?? '')) unknown = true; k += 2; }
      else if (o?.startsWith('--adjustment=')) { if (!INT_RE.test(o.slice('--adjustment='.length))) unknown = true; k += 1; }
      else if (o && /^-n./.test(o)) { if (!INT_RE.test(o.slice(2))) unknown = true; k += 1; }
      else if (o && /^-\d+$/.test(o)) k += 1;
      else if (o === '--') k += 1;
      else if (opt()) unknown = true;               // --help / --version / unknown / computed
      if (!unknown && o !== '--' && val(k) === '--') k += 1;
    } else {
      break;
    }
  }
  const v = val(k);
  if (!unknown && k < words.length) {
    if (ctx === 'builtin' && !BASH_BUILTINS.has(v)) unknown = true;         // builtin node: not a builtin
    if (ctx === 'external' && (v === 'time' || (BASH_BUILTINS.has(v) && !HAS_PROGRAM.has(v)))) unknown = true;
    if ((ctx === 'command' || ctx === 'builtin') && v === 'time') unknown = true;
  }
  return { k, query, unknown, execAt, nodeEnv, shellEnv };
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
 * the outcome unprovable. everOn: noexec was turned on at some point.
 * @param {(string|null)[]} values word values (null = computed by the shell)
 */
export function shellOptionState(values, from = 0) {
  let j = from;
  let noexec = false;
  let everOn = false;
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
          else if (name === 'noexec') { noexec = on; everOn ||= on; }
        }
      } else if (!SHELL_FLAGS.has(f)) {
        unknown = true;
      } else if (f === 'n') {
        noexec = on;
        everOn ||= on;
      } else if (f === 'c' && on) {
        command = true;
      }
    }
  }
  if (values[j] === '--') j += 1;
  return { noexec: unknown ? null : noexec, everOn, command, next: j };
}

function shellOptions(words, from) {
  return shellOptionState(words.map((w) => w.value), from);
}

function analyze(t, depth, inherited = {}) {
  const out = { sends: [], unparsedSends: 0, commSends: [], uncertainSends: 0, runtimeNoexec: false };
  // After a runtime `set -n` / `set -o noexec` (or a `set` whose options are
  // unknown) in command position, whether a later send runs depends on scope,
  // function names, interactive mode … — not provable. Such a send is
  // "uncertain": it pauses attribution but is never a reply.
  let uncertain = false;
  let replacedBefore = false;
  // NODE_OPTIONS / PATH set earlier in this script (or in the parent shell's
  // script): every later node invocation may load other code.
  let nodeEnvTainted = inherited.nodeEnvTainted === true;
  let shellEnvTainted = inherited.shellEnvTainted === true;
  const markUncertainAfter = () => { uncertain = true; out.runtimeNoexec = true; };
  const pushSend = (s) => { if (uncertain) out.uncertainSends += 1; else out.sends.push(s); };
  const pushComm = (c) => { if (uncertain) out.uncertainSends += 1; else out.commSends.push(c); };
  const merge = (sub) => {
    if (uncertain) out.uncertainSends += sub.sends.length + sub.commSends.length;
    else { out.sends.push(...sub.sends); out.commSends.push(...sub.commSends); }
    out.unparsedSends += sub.unparsedSends;
    out.uncertainSends += sub.uncertainSends;
    if (sub.runtimeNoexec) { uncertain = true; out.runtimeNoexec = true; }
  };
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
    if (replacedBefore) markUncertainAfter();
    if (words.every(isAssignWord)) {
      if (words.some((w) => NODE_ENV_NAMES.has(assignName(w)))) nodeEnvTainted = true;
      if (words.some((w) => SHELL_ENV_NAMES.has(assignName(w)))) shellEnvTainted = true;
    }
    const rc = resolveCommand(words);
    const k = rc.k;
    const exe = words[k];
    if (exe && EXPORT_CMDS.has(exe.value)) {
      const names = words.slice(k + 1).map((w) => (w.value === null ? null : NAME_ARG_RE.exec(w.value)?.[1]));
      if (words.slice(k + 1).some((w) => w.value === null)) { nodeEnvTainted = true; shellEnvTainted = true; }
      if (names.some((n) => NODE_ENV_NAMES.has(n))) nodeEnvTainted = true;
      if (names.some((n) => SHELL_ENV_NAMES.has(n))) shellEnvTainted = true;
    }
    // Any other command naming NODE_OPTIONS / BASH_ENV (read, printf -v,
    // mapfile, declare -n …) may set it: taint (not for the send commands,
    // whose literal message may mention it — they are handled below).
    // (A nested shell / eval script is read on its own, below.)
    if (exe && !NODE_RE.test(base(exe.value) || '') && !['c4-send.js', 'comm.js', 'eval'].includes(base(exe.value)) && !SHELLS.has(base(exe.value))) {
      if (words.some((w) => /NODE_OPTIONS/.test(w.raw))) nodeEnvTainted = true;
      if (words.some((w) => /BASH_ENV/.test(w.raw))) shellEnvTainted = true;
    }
    // `exec cmd` replaces this shell: nothing after it runs here.
    if (rc.execAt >= 0 && exe) replacedBefore = true;
    if (!exe) continue;
    const exeBase = base(exe.value);

    // `command -v / -V name …` only prints what name is: runs nothing.
    if (rc.query) { accountInert(cmd); continue; }
    // A prefix this reader cannot read may run anything (incl. a `set -n`).
    if (rc.unknown) { markUncertainAfter(); continue; }

    // A `set -n` / `set -o noexec` inside a script is never an exemption:
    // every send after it is uncertain (above). Only a `set` in command
    // position counts — not text inside a send's consumed message.
    if (exe.value === 'set') {
      const st = shellOptions(words, k + 1);
      if (st.everOn || st.noexec === null) markUncertainAfter();
      continue;
    }
    // Other ways the commands after this one may not run, or may run
    // something else than they name: a computed command word ($x may be
    // `set -n`), sourcing a file, traps, function / alias definitions and
    // `hash -p` (a name such as node redefined), exit / return / logout.
    // Anything sent after them is uncertain.
    if (exe.value === null && !['c4-send.js', 'comm.js'].includes(base(words[k + 1]?.value))) { markUncertainAfter(); continue; }
    if (SHELL_STATE_CMDS.has(exe.value)) {
      const args = words.slice(k + 1);
      const risky = exe.value === 'alias' ? args.some((w) => w.value === null || w.value.includes('='))
        : exe.value === 'hash' ? args.some((w) => w.value === null || /^-[a-z]*p/.test(w.value))
          : exe.value === 'trap' ? args.some((w) => w.value === null || !/^-[lp]$/.test(w.value))
            : true;
      if (risky) markUncertainAfter();
      continue;
    }
    if (words.length === k + 1 && !KEYWORDS.has(exe.value) && /^[ \t]*\([ \t]*\)/.test(t.slice(exe.end))) { markUncertainAfter(); continue; }

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
        // This command's own NODE_OPTIONS / PATH prefix reaches the script.
        const sub = analyze(script.value, depth + 1, { nodeEnvTainted: nodeEnvTainted || rc.nodeEnv, shellEnvTainted });
        // BASH_ENV / ENV (prefix, `env`, exported earlier) or an rc file run
        // first in the new shell: may exit or `set -n` before the script.
        const startup = shellEnvTainted || rc.shellEnv
          || words.slice(k + 1, opts.next).some((w) => w.value === '--rcfile' || w.value === '--init-file');
        if (startup) {
          out.uncertainSends += sub.sends.length + sub.commSends.length + sub.uncertainSends;
          out.unparsedSends += sub.unparsedSends;
        } else {
          merge(sub);
        }
        account(script);
      }
      continue;
    }
    if (exe.value === 'eval') {
      const rest = words.slice(words[k + 1]?.value === '--' ? k + 2 : k + 1);
      if (rest.length && rest.every((w) => w.value !== null) && depth < MAX_DEPTH) {
        const sub = analyze(rest.map((w) => w.value).join(' '), depth + 1, { nodeEnvTainted: nodeEnvTainted || rc.nodeEnv, shellEnvTainted: shellEnvTainted || rc.shellEnv });
        merge(sub);
        if (sub.nodeEnvTainted || rc.nodeEnv) nodeEnvTainted = true;   // eval runs in this shell
        if (sub.shellEnvTainted) shellEnvTainted = true;
        rest.forEach(account);
      } else if (rest.length) {
        markUncertainAfter();                  // computed code: may be a `set -n`
      }
      continue;
    }

    let scriptIdx = -1;
    if (NODE_RE.test(exeBase || '')) {
      let j = k + 1;
      let inline = false;
      let unknownWord = false;                 // a word the shell computes, or a glob
      let other = false;                       // any option but the mode flags
      const mode = { check: false, version: false, help: false };
      while (words[j] && (words[j].value === null || words[j].value.startsWith('-'))) {
        const v = words[j].value;
        if (v === null || GLOB_RE.test(v)) { unknownWord = true; j += 1; continue; }
        const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
        if (NODE_INLINE_OPTS.has(name)) { inline = true; break; }
        const m = NODE_MODE_FLAGS.get(v);
        if (m) { mode[m[0]] = m[1]; j += 1; continue; }
        other = true;
        if (NODE_OTHER_MODES.has(v)) mode.other = true;
        if (NODE_OPTS_WITH_VALUE.has(v)) {
          if (words[j + 1]?.value == null) unknownWord = true;
          j += 2;
        } else {
          j += 1;
        }
      }
      // Only two shapes are provable: options that are all literal mode
      // flags (none at all included) — inert if a mode is on at the end, a
      // normal run if not. Anything else — any other option (--require /
      // --import / --loader preload code even under --check; an unknown
      // option makes node exit), inline code, a computed word, an env /
      // VAR= prefix (NODE_OPTIONS=--require …) — whatever the final mode:
      // unknown, nothing accounted, so a send it names pauses.
      const envPrefix = nodeEnvTainted || rc.nodeEnv;
      if (other || inline || unknownWord || envPrefix || mode.other) continue;
      if (mode.check || mode.version || mode.help) { accountInert(cmd); continue; }
      scriptIdx = j;
    } else if (exeBase === 'c4-send.js' || exeBase === 'comm.js') {
      // Run directly, its `#!/usr/bin/env node` sees NODE_OPTIONS / PATH too.
      if (nodeEnvTainted || rc.nodeEnv) continue;
      scriptIdx = k;
    } else if (exe.value === null) {
      // A computed interpreter ("$NODE") followed by the script. Unquoted it
      // is word-split ($NODE = "node -r hook"): may run other code first.
      const nb = base(words[k + 1]?.value);
      if ((nb === 'c4-send.js' || nb === 'comm.js') && /^"[^"]*"$/.test(exe.raw) && !nodeEnvTainted && !rc.nodeEnv) scriptIdx = k + 1;
    }
    const script = words[scriptIdx];
    const sb = base(script?.value);
    if (sb === 'c4-send.js') {
      const [channel, endpoint, message] = [words[scriptIdx + 1], words[scriptIdx + 2], words[scriptIdx + 3]];
      account(script);
      if (channel?.value != null && endpoint?.value != null) {
        pushSend({ channel: channel.value, endpoint: endpoint.value });
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
        pushComm({ command: null, conversationId: null });
        continue;
      }
      account(verb);
      const args = words.slice(scriptIdx + 2);
      args.forEach(accountLiteral);
      accountHeredocs(cmd);
      if (!COMM_REPLY_COMMANDS.has(verb.value)) continue;
      const arg = args[0];
      const id = arg && arg.value !== null && args.length === 1 ? topLevelConversationId(arg.value) : null;
      pushComm({ command: verb.value, conversationId: id });
    }
  }

  out.nodeEnvTainted = nodeEnvTainted;
  out.shellEnvTainted = shellEnvTainted;
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
 * @returns {{ sends: {channel, endpoint}[], unparsedSends: number, uncertainSends: number,
 *   commSends: { command: string|null, conversationId: string|null }[] }}
 *   commSends: destination known / reply verb with an unprovable destination
 *   (conversationId null) / a send whose verb cannot be read (command null).
 *   uncertainSends: sends after a runtime `set -n` (may or may not run).
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
