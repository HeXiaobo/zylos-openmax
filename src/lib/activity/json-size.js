/**
 * Encoded size of a JSON value as cws-comm measures agent_run: Go json.Encoder
 * with SetEscapeHTML(false), trailing newline included.
 *
 * Go and JSON.stringify agree on every escape except U+2028 / U+2029: Go always
 * writes them as \u2028 / \u2029 (6 bytes), JSON.stringify leaves them raw
 * (3 UTF-8 bytes). Counting the raw form let a summary full of separators pass
 * the local budget and be stripped server-side.
 */

const LINE_SEPARATORS = /[\u2028\u2029]/g;

export function goJsonBytes(value) {
  const s = JSON.stringify(value);
  if (s === undefined) return 0;
  const separators = s.match(LINE_SEPARATORS)?.length ?? 0;
  return Buffer.byteLength(s, 'utf8') + 3 * separators + 1;
}
