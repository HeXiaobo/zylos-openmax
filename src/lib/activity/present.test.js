import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventToStep, omittedNote, fitFrameDetail, stepCategory, isVisibleTool, thinkingBody, line, bodyText,
} from './present.js';
import { CATEGORIES, WAIT_FOR } from './constants.js';
import { REDACTED as R } from './privacy.js';
import { validateStepV3, V3 } from './testdata/validators.js';

const ok = (s) => assert.deepEqual(validateStepV3(s), [], JSON.stringify(s));

test('the step enums are the shared contract (validators.js V3)', () => {
  assert.deepEqual([...CATEGORIES].sort(), [...V3.CATEGORIES].sort());
  assert.deepEqual([...new Set(Object.values(WAIT_FOR))].sort(), [...V3.WAIT_FOR].sort());
});

test('tool step: category key + agent title + object; no fixed UI wording is sent', () => {
  const s = eventToStep({ id: 'e3', kind: 'tool', category: 'command', title: '统计缺失地区的记录', at: 1, ended_at: 5, error: false,
    detail: { type: 'output', exit_code: 0, lines: 12, truncated: false } });
  assert.deepEqual(s, { id: 'e3', kind: 'tool', category: 'command', status: 'ok', at: 1, ended_at: 5, title: '统计缺失地区的记录',
    detail: { type: 'output', exit_code: 0, lines: 12, truncated: false } });
  ok(s);
  // No title / object → none sent: the FE shows its own category label.
  assert.deepEqual(eventToStep({ id: 'e1', kind: 'tool', category: 'read', at: 1 }),
    { id: 'e1', kind: 'tool', category: 'read', status: 'running', at: 1 });
});

test('wait_for: a category key while running only; none for quick local categories', () => {
  const run = eventToStep({ id: 'e1', kind: 'tool', category: 'search_web', object: 'q', at: 1 });
  assert.equal(run.wait_for, 'search_results');
  ok(run);
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'search_web', at: 1, ended_at: 2 }).wait_for, undefined);
  for (const c of ['read', 'write', 'edit', 'search_files', 'image']) {
    assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: c, at: 1 }).wait_for, undefined, c);
  }
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'command', at: 1 }).wait_for, 'command_result');
});

test('reply sends and wait polls are never steps; unknown categories become tool', () => {
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'reply', at: 1 }), null);
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'waiting', at: 1 }), null);
  assert.equal(isVisibleTool({ kind: 'tool', category: 'reply' }), false);
  assert.equal(isVisibleTool({ kind: 'tool', category: 'command' }), true);
  assert.equal(stepCategory('mystery'), 'tool');
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'mystery', at: 1 }).category, 'tool');
});

test('thinking: commentary body redacted (tokens only), kept as-is otherwise; empty → no step', () => {
  const s = eventToStep({ id: 'e1', kind: 'commentary', text: 'Checking /home/bob/app with token=abcdef123456 now\u0007', at: 1 });
  assert.deepEqual(s, { id: 'e1', kind: 'thinking', at: 1, body: 'Checking /home/bob/app with token=[已隐藏] now' });
  ok(s);
  assert.equal(eventToStep({ id: 'e1', kind: 'commentary', text: '  \n ', at: 1 }), null);
  assert.equal(eventToStep({ id: 'e1', kind: 'commentary', text: 'sk-abcdefghijklmnopqrstuvwxyz', at: 1 }), null, 'only a placeholder left');
  assert.equal(Array.from(thinkingBody('长'.repeat(3000))).length, 2000);
});

test('notes: only merged_turn from a run (focus / truncated notices are gone); steps_omitted from compaction', () => {
  assert.deepEqual(eventToStep({ id: 'e2', kind: 'notice', code: 'merged_turn', at: 2 }), { id: 'e2', kind: 'note', at: 2, code: 'merged_turn' });
  for (const code of ['focus_acquired', 'truncated', 'other']) assert.equal(eventToStep({ id: 'e2', kind: 'notice', code, at: 2 }), null);
  const n = omittedNote([{ at: 10 }, { at: 13 }]);
  assert.deepEqual(n, { id: 'omitted', kind: 'note', at: 10, code: 'steps_omitted', count: 2 });
  ok(n);
});

test('every display string is redacted and capped: title / object ≤ 60, ids ≤ 32', () => {
  const s = eventToStep({ id: 'x'.repeat(40), kind: 'tool', category: 'command', title: `deploy with Bearer abcdefghijk ${'长'.repeat(80)}`,
    object: `${'o'.repeat(100)}`, at: 1 });
  assert.equal(s.id.length, 32);
  assert.ok(s.title.startsWith('deploy with Bearer [已隐藏]'));
  assert.equal(Array.from(s.title).length, 60);
  assert.equal(Array.from(s.object).length, 60);
  ok(s);
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'tool', title: 'ghp_abcdefghijklmnopqrstuvwxyz0123', at: 1 }).title, undefined);
});

test('details: unknown type dropped; links / diff normalised and redacted', () => {
  assert.equal(eventToStep({ id: 'e1', kind: 'tool', category: 'tool', at: 1, detail: { type: 'raw_json', text: '{}' } }).detail, undefined);
  const s = eventToStep({ id: 'e1', kind: 'tool', category: 'search_web', at: 1, ended_at: 2,
    detail: { type: 'links', total: 1, items: [{ title: 'x', url: 'https://u:p@a.example.com/p?q=1&sig=zzz' }, { url: 'ftp://nope' }] } });
  assert.deepEqual(s.detail, { type: 'links', total: 1, truncated: false, items: [{ title: 'x', url: 'https://a.example.com/p?q=1', site: 'a.example.com' }] });
  ok(s);
});

test('live frame detail ≤ 4 KiB: re-cut, then dropped', () => {
  const big = { id: 'e1', kind: 'tool', category: 'edit', at: 1, detail: { type: 'diff', file: 'a.js', added: 500, removed: 0,
    preview: Array.from({ length: 40 }, (_, i) => `line ${i} ${'é'.repeat(30)}`).join('\n'), truncated: false } };
  const s = fitFrameDetail(eventToStep(big), 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(s.detail)) <= 1024);
  assert.equal(s.detail.truncated, true);
  const gone = fitFrameDetail(eventToStep(big), 50);
  assert.equal(gone.detail, undefined);
});

test('line / bodyText caps', () => {
  assert.equal(Array.from(line('长'.repeat(200))).length, 60);
  assert.equal(Array.from(bodyText('长'.repeat(3000), 2000)).length, 2000);
});

test('review P2: a short numeric credential is redacted on every step surface (title / object / thinking / detail)', () => {
  const t = eventToStep({ id: 'e1', kind: 'tool', category: 'command', at: 1, ended_at: 2, title: '用 DB_PASSWORD=4821 登录', object: 'api_key: 90210' });
  assert.equal(t.title, `用 DB_PASSWORD=${R} 登录`);
  assert.equal(t.object, `api_key: ${R}`);
  ok(t);
  assert.equal(thinkingBody('先登录 token=73 再说'), `先登录 token=${R} 再说`);
  const d = eventToStep({ id: 'e2', kind: 'tool', category: 'write', at: 1, ended_at: 2,
    detail: { type: 'diff', file: '.env', added: 2, removed: 0, preview: 'PORT=3000\nSECRET=31337\n' } });
  assert.equal(d.detail.preview, `PORT=3000\nSECRET=${R}\n`);
  const x = eventToStep({ id: 'e3', kind: 'tool', category: 'tool', at: 1, ended_at: 2, detail: { type: 'text', text: 'pwd=1234 ok' } });
  assert.equal(x.detail.text, `pwd=${R} ok`);
  const l = eventToStep({ id: 'e4', kind: 'tool', category: 'search_web', at: 1, ended_at: 2,
    detail: { type: 'links', total: 1, items: [{ title: 'reset password=5555', url: 'https://a.example.com/p?q=1&token=42' }] } });
  assert.deepEqual(l.detail.items, [{ title: `reset password=${R}`, url: 'https://a.example.com/p?q=1', site: 'a.example.com' }]);
});
