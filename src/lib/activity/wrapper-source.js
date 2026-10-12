/**
 * Strict static recognizer for execution-wrapper payloads (Codex's `exec`
 * custom tool, whose input is code that calls other tools).
 *
 * The code is NEVER evaluated. It is accepted as "fully inspectable" only when
 * it has exactly this narrow shape, statement by statement (separated by `;`
 * and / or newlines):
 *
 *   [const|let|var <ident> =] [await] tools.<exec_command|shell|local_shell>({ <props> })
 *   console.log(<ident>[.<ident>…])
 *
 * where every property value is a plain literal: a string in "…" or '…' whose
 * only escapes are \" \' \\ , a number, true / false / null, or an array of such
 * strings. The command (`cmd` / `command`) must be one of those literals.
 * Anything else — concatenation (+), template literals, \x / \u / octal or any
 * other escape, identifiers as values, other calls or statements, comments,
 * unknown tools, an oversized payload — makes the payload NOT inspectable, and
 * the caller pauses attribution.
 */

import { argvToScript } from './shell-scan.js';

export const MAX_WRAPPER_SOURCE_BYTES = 64 * 1024;
const INNER_TOOLS = new Set(['exec_command', 'shell', 'local_shell']);
const COMMAND_KEYS = new Set(['cmd', 'command']);

function parser(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /[ \t\r]/.test(src[i])) i++; };
  const wsNl = () => { while (i < src.length && /[ \t\r\n]/.test(src[i])) i++; };
  const ident = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const eat = (s) => {
    if (src.startsWith(s, i)) { i += s.length; return true; }
    return false;
  };
  /** A plain string literal; null if absent or using any unsupported escape. */
  const string = () => {
    const q = src[i];
    if (q !== '"' && q !== "'") return null;
    let out = '';
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === q) { i = j + 1; return out; }
      if (c === '\n' || c === '\r') return null;
      if (c === '\\') {
        const n = src[j + 1];
        if (n === '"' || n === "'" || n === '\\') { out += n; j += 2; continue; }
        return null;            // \x \u \n \0 … — not a plain literal
      }
      out += c;
      j += 1;
    }
    return null;
  };
  /** Literal value; returns { strings: [...] } or null. */
  const value = () => {
    const s = string();
    if (s !== null) return { strings: [s] };
    if (eat('[')) {
      const strings = [];
      wsNl();
      if (eat(']')) return { strings, array: true };
      for (;;) {
        wsNl();
        const e = string();
        if (e === null) return null;
        strings.push(e);
        wsNl();
        if (eat(']')) return { strings, array: true };
        if (!eat(',')) return null;
      }
    }
    const m = /^(?:-?\d+(?:\.\d+)?|true|false|null)(?![A-Za-z0-9_$])/.exec(src.slice(i));
    if (m) { i += m[0].length; return { strings: [] }; }
    return null;
  };
  /** tools.<tool>({ … }) → command strings, or null. */
  const toolCall = () => {
    if (!eat('tools.')) return null;
    const tool = ident();
    if (!tool || !INNER_TOOLS.has(tool)) return null;
    ws();
    if (!eat('(')) return null;
    wsNl();
    if (!eat('{')) return null;
    const commands = [];
    let sawCommand = false;
    for (;;) {
      wsNl();
      if (eat('}')) break;
      let key = ident();
      if (key === null) key = string();
      if (key === null) return null;
      wsNl();
      if (!eat(':')) return null;
      wsNl();
      const v = value();
      if (!v) return null;
      if (COMMAND_KEYS.has(key)) {
        if (v.strings.length === 0) return null;
        sawCommand = true;
        commands.push(v.array ? argvToScript(v.strings) : v.strings.join(' '));
      }
      wsNl();
      if (eat('}')) break;
      if (!eat(',')) return null;
    }
    wsNl();
    if (!eat(')')) return null;
    return sawCommand ? commands : null;
  };
  const statement = () => {
    const save = i;
    if (eat('console.log(')) {
      ws();
      if (!ident()) return null;
      while (eat('.')) if (!ident()) return null;
      ws();
      return eat(')') ? [] : null;
    }
    i = save;
    const kw = /^(?:const|let|var)\s+/.exec(src.slice(i));
    if (kw) {
      i += kw[0].length;
      if (!ident()) return null;
      ws();
      if (!eat('=')) return null;
      ws();
    }
    if (/^await\s/.test(src.slice(i))) { i += 5; ws(); }
    return toolCall();
  };
  return {
    program() {
      const commands = [];
      let count = 0;
      for (;;) {
        wsNl();
        while (eat(';')) wsNl();
        if (i >= src.length) break;
        const cmds = statement();
        if (cmds === null) return null;
        commands.push(...cmds);
        count += 1;
        ws();
        if (i >= src.length) break;
        if (!eat(';') && !eat('\n')) return null;
      }
      return count > 0 ? commands : null;
    },
  };
}

/**
 * Recover the commands a wrapper payload runs.
 * @param {unknown} input  raw string, or an object carrying it
 * @returns {string[]|null}  the commands, or null when not fully inspectable
 */
export function recoverWrapperCommands(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_WRAPPER_SOURCE_BYTES || input.trim() === '') return null;
    return parser(input).program();
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  // A structured call ({ cmd | command: literal, …scalars }) is a direct command.
  const keys = Object.keys(input);
  const cmdKey = keys.find((k) => COMMAND_KEYS.has(k));
  if (cmdKey) {
    const c = input[cmdKey];
    const cmd = typeof c === 'string' ? c : (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string') ? argvToScript(c) : null);
    if (cmd === null || Buffer.byteLength(cmd, 'utf8') > MAX_WRAPPER_SOURCE_BYTES) return null;
    const others = keys.filter((k) => k !== cmdKey).map((k) => input[k]);
    if (others.some((v) => v !== null && typeof v === 'object')) return null;
    return [cmd];
  }
  // Otherwise exactly one string field holding the code.
  const strings = keys.filter((k) => typeof input[k] === 'string');
  if (strings.length !== 1 || keys.some((k) => input[k] !== null && typeof input[k] === 'object')) return null;
  return recoverWrapperCommands(input[strings[0]]);
}
