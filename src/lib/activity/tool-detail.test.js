import assert from 'node:assert/strict';
import test from 'node:test';
import { startDetail, endDetail, parsePatch, countLines, editTarget } from './tool-detail.js';
import { normalizeDetail } from './detail.js';
import { validateDetailV3 } from './testdata/validators.js';

const valid = (d) => assert.deepEqual(validateDetailV3(normalizeDetail(d)), [], JSON.stringify(d));

test('countLines', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines(undefined), 0);
});

test('Claude Bash → output { exit_code, lines } only, never the output text (D4)', () => {
  const ok = endDetail({ name: 'Bash', category: 'command', result: { text: 'secret out', meta: { stdout: 'a\nb\nc\n', stderr: '', interrupted: false } } });
  assert.deepEqual(ok, { type: 'output', exit_code: 0, lines: 3, truncated: false });
  valid(ok);
  const err = endDetail({ name: 'Bash', category: 'command', isError: true, result: { text: 'Exit code 2\nboom\nmore', meta: { stdout: '', stderr: 'boom\nmore', interrupted: false } } });
  assert.deepEqual(err, { type: 'output', exit_code: 2, lines: 2, truncated: false });
  // Non-zero but "not an error" (grep no match): the real code is unknown → left out.
  const grep = endDetail({ name: 'Bash', category: 'command', result: { text: '', meta: { stdout: '', stderr: '', returnCodeInterpretation: 'No matches found' } } });
  assert.deepEqual(grep, { type: 'output', lines: 0, truncated: false });
  const interrupted = endDetail({ name: 'Bash', category: 'command', isError: true, result: { text: 'interrupted', meta: { stdout: 'x', stderr: '', interrupted: true } } });
  assert.deepEqual(interrupted, { type: 'output', lines: 1, truncated: false });
  assert.equal(endDetail({ name: 'Bash', category: 'command', result: { meta: { stdout: '', stderr: '', backgroundTaskId: 'b1' } } }), undefined, 'a background launch has no output yet');
  assert.equal(endDetail({ name: 'Monitor', category: 'command', result: { meta: { taskId: 't' } } }), undefined);
  // No structured result: the text.
  assert.deepEqual(endDetail({ name: 'Bash', category: 'command', isError: true, result: { text: 'Exit code 1\nline' } }), { type: 'output', exit_code: 1, lines: 1, truncated: false });
});

test('Codex exec_command → exit code from the result, lines of the Output: section', () => {
  const text = 'Chunk ID: 3\nWall time: 0.2 seconds\nProcess exited with code 0\nOriginal token count: 9\nOutput:\nx\ny\n';
  assert.deepEqual(endDetail({ name: 'exec_command', category: 'command', result: { text, exitCode: 0 } }), { type: 'output', exit_code: 0, lines: 2, truncated: false });
  assert.deepEqual(endDetail({ name: 'exec_command', category: 'command', result: { text: 'plain\nout' } }), { type: 'output', lines: 2, truncated: false });
});

test('WebSearch → links from the structured results (title + url), total; the model summary strings ignored', () => {
  const meta = { query: 'q', results: [
    { tool_use_id: 's1', content: [{ title: 'A', url: 'https://a.example.com/x' }, { title: 'B', url: 'https://b.example.com/y?token=1' }] },
    'Here is a summary of the results …',
    { tool_use_id: 's2', content: [{ title: 'C', url: 'https://c.example.com' }] },
  ] };
  const d = endDetail({ name: 'WebSearch', category: 'search_web', result: { text: 'x', meta } });
  assert.equal(d.type, 'links');
  assert.equal(d.total, 3);
  const n = normalizeDetail(d);
  assert.deepEqual(n.items[1], { title: 'B', url: 'https://b.example.com/y', site: 'b.example.com' });
  valid(d);
  assert.equal(endDetail({ name: 'WebSearch', category: 'search_web', result: { meta: { results: ['only text'] } } }), undefined);
  assert.equal(endDetail({ name: 'web_search_call', category: 'search_web' }), undefined, 'Codex: no results in the rollout');
});

test('WebFetch → the fetched url as one link; an HTTP error as text', () => {
  const d = endDetail({ name: 'WebFetch', category: 'fetch_web', input: { url: 'https://x.example.com/p' }, result: { meta: { url: 'https://x.example.com/p', code: 200, codeText: 'OK', result: 'page summary' } } });
  assert.deepEqual(d, { type: 'links', total: 1, items: [{ url: 'https://x.example.com/p' }], truncated: false });
  valid(d);
  assert.deepEqual(endDetail({ name: 'WebFetch', category: 'fetch_web', result: { meta: { url: 'https://x', code: 404, codeText: 'Not Found' } } }),
    { type: 'text', text: 'HTTP 404 Not Found', truncated: false });
  assert.deepEqual(endDetail({ name: 'WebFetch', category: 'fetch_web', input: { url: 'https://y.example.com' }, result: {} }),
    { type: 'links', total: 1, items: [{ url: 'https://y.example.com' }], truncated: false });
});

test('Write: diff at the start (content lines + head preview); create keeps it, overwrite takes the applied patch', () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const s = startDetail('Write', 'write', { file_path: '/w/out/report.md', content });
  assert.equal(s.file, 'report.md');
  assert.equal(s.added, 50);
  assert.equal(s.removed, 0);
  const n = normalizeDetail(s);
  assert.equal(n.preview.split('\n').length, 40);
  assert.equal(n.truncated, true);
  valid(s);
  assert.equal(endDetail({ name: 'Write', category: 'write', result: { meta: { type: 'create', structuredPatch: [] } }, start: s }), s);
  const over = endDetail({ name: 'Write', category: 'write', start: s, result: { meta: { type: 'update', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] } } });
  assert.equal(over.added, 2);
  assert.equal(over.removed, 1);
  assert.equal(over.preview, '-b\n+c\n+d');
});

test('Edit / MultiEdit: removed / added from old / new strings at the start; exact counts from structuredPatch at the end', () => {
  const s = startDetail('Edit', 'edit', { file_path: '/a/config.js', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 3;' });
  assert.deepEqual(s, { type: 'diff', file: 'config.js', added: 1, removed: 2, preview: '- const a = 1;\n- const b = 2;\n+ const a = 3;', truncated: false });
  const e = endDetail({ name: 'Edit', category: 'edit', start: s, result: { meta: { structuredPatch: [{ lines: ['-const a = 1;', '-const b = 2;', '+const a = 3;', ' x'] }] } } });
  assert.deepEqual([e.added, e.removed], [1, 2]);
  const m = startDetail('MultiEdit', 'edit', { file_path: '/a/b.js', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'p', new_string: '' }] });
  assert.deepEqual([m.added, m.removed], [2, 2]);
  assert.equal(startDetail('Read', 'read', { file_path: '/x' }), undefined);
  assert.equal(startDetail('Write', 'write', {}), undefined, 'no file → no diff');
  // A failed edit: its error text.
  assert.deepEqual(endDetail({ name: 'Edit', category: 'edit', isError: true, start: s, result: { text: 'String not found in file' } }),
    { type: 'text', text: 'String not found in file', truncated: false });
});

test('apply_patch: files and +/- lines parsed; several files shown as "first +N"', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@ fn\n-old\n+new\n+more\n context\n*** Add File: docs/b.md\n+# B\n*** End Patch';
  assert.deepEqual(parsePatch(patch), { files: ['src/a.js', 'docs/b.md'], added: 3, removed: 1, preview: '-old\n+new\n+more\n+# B' });
  const d = startDetail('apply_patch', 'edit', patch);
  assert.deepEqual(d, { type: 'diff', file: 'a.js +1', added: 3, removed: 1, preview: '-old\n+new\n+more\n+# B', truncated: false });
  assert.equal(editTarget('apply_patch', { input: patch }), 'a.js');
  valid(d);
});

test('secrets in a diff preview are redacted (normalizeDetail), the file name kept', () => {
  const s = startDetail('Write', 'write', { file_path: '/w/.env', content: 'PORT=3000\nAPI_KEY=sk-abcdefghijklmnopqrst\n' });
  const n = normalizeDetail(s);
  assert.equal(n.file, '.env');
  assert.equal(n.preview, 'PORT=3000\nAPI_KEY=[已隐藏]\n');
});

test('any other failed call: the first lines of its error as text; a successful one: no detail', () => {
  assert.deepEqual(endDetail({ name: 'Read', category: 'read', isError: true, result: { text: '\nFile does not exist.\n\n' } }),
    { type: 'text', text: 'File does not exist.', truncated: false });
  assert.equal(endDetail({ name: 'Read', category: 'read', result: { text: 'file body' } }), undefined, 'Read has no expandable body');
  assert.equal(endDetail({ name: 'mcp__x__y', category: 'tool', result: { text: '{"raw":"json"}' } }), undefined, 'no raw result');
});
