import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseMediaMessage,
  findMisplacedMediaTag,
  assertNoMisplacedMediaTag,
  assertNoMentionsWithoutMedia,
  MediaMessageError,
  MEDIA_MENTIONS_PREFIX,
} from './media-message.js';

// OPENM-1039: a [MEDIA:file] / [MEDIA:image] message may carry explicit
// mentions on the line right after the path (`[MENTIONS][...]`, the
// [STRUCTURED] `mentions` shape). The caption is never read for `@name`.
// A [MEDIA:…] tag that starts a later line is refused, never posted as text.

const XIAO_B = '01a1ecbc-6239-7c14-8e0a-9976c61a153f';
const XIAO_C = '01a1ecbc-71f0-7d2a-9b3e-5c8d4a2f1e07';
const PDF = '/home/agent/work/报价单-2026Q4.pdf';
const CAPTION = '@小B请看报价单';

test('MEDIA_MENTIONS_PREFIX is [MENTIONS]', () => {
  assert.equal(MEDIA_MENTIONS_PREFIX, '[MENTIONS]');
});

// ── unchanged forms ──────────────────────────────────────────────────────────

test('not a MEDIA message → null', () => {
  assert.equal(parseMediaMessage('hello'), null);
  assert.equal(parseMediaMessage(`[STRUCTURED]{"content":"x"}`), null);
  assert.equal(parseMediaMessage(''), null);
  assert.equal(parseMediaMessage(undefined), null);
});

test('plain [MEDIA:file] with a caption: unchanged, no mentions, caption with @name is NOT parsed', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\n${CAPTION}`);
  assert.deepEqual(r, { kind: 'file', localPath: PDF, caption: CAPTION });
  assert.equal('mentions' in r, false);
});

test('path-only [MEDIA:image]: unchanged', () => {
  assert.deepEqual(parseMediaMessage('[MEDIA:image]/tmp/截图 1.png'), { kind: 'image', localPath: '/tmp/截图 1.png', caption: undefined });
});

test('leading whitespace before the tag is accepted (as [STRUCTURED] does)', () => {
  assert.deepEqual(parseMediaMessage(`\n  [MEDIA:file]${PDF}\n${CAPTION}`), { kind: 'file', localPath: PDF, caption: CAPTION });
});

// ── [MENTIONS] line ──────────────────────────────────────────────────────────

test('[MENTIONS] on line 2: member id strings → {type:"member"}, removed from the caption', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]\n${CAPTION}`);
  assert.deepEqual(r, {
    kind: 'file',
    localPath: PDF,
    caption: CAPTION,
    mentions: [{ type: 'member', member_id: XIAO_B }],
  });
});

test('[MENTIONS] objects and broadcasts are carried as given; image kind', () => {
  const r = parseMediaMessage(`[MEDIA:image]/tmp/方案A.png\n[MENTIONS] [{"type":"member","member_id":"${XIAO_C}"},{"type":"all_agents"},{"type":"all"}] \n方案 A`);
  assert.deepEqual(r.mentions, [{ type: 'member', member_id: XIAO_C }, { type: 'all_agents' }, { type: 'all' }]);
  assert.equal(r.kind, 'image');
  assert.equal(r.caption, '方案 A');
});

test('[MENTIONS] with no caption after it', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}","${XIAO_C}"]`);
  assert.equal(r.caption, undefined);
  assert.deepEqual(r.mentions.map((m) => m.member_id), [XIAO_B, XIAO_C]);
});

test('a multi-line caption after [MENTIONS] is kept whole', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]\n第一行\n\n第二行 @小C`);
  assert.equal(r.caption, '第一行\n\n第二行 @小C');
});

test('malformed [MENTIONS] → MediaMessageError (never sent as text)', () => {
  const bad = [
    `[MENTIONS]${XIAO_B}`, // not JSON
    `[MENTIONS]{"member_id":"${XIAO_B}"}`, // not an array
    '[MENTIONS][]', // empty
    '[MENTIONS]', // nothing
    '[MENTIONS][""]', // blank id
    '[MENTIONS][42]', // not a string / object
    '[MENTIONS][{"type":"member"}]', // member without member_id
    '[MENTIONS][{"member_id":"x"}]', // no type
    '[MENTIONS]["@小B"]', // a name, not an id
  ];
  for (const line of bad) {
    assert.throws(() => parseMediaMessage(`[MEDIA:file]${PDF}\n${line}\n${CAPTION}`), (e) => {
      assert.ok(e instanceof MediaMessageError, `${line}: ${e}`);
      assert.equal(e.code, 'MEDIA_MENTIONS_INVALID', line);
      assert.match(e.message, /\[MENTIONS\]/);
      return true;
    }, line);
  }
});

test('[MENTIONS] anywhere but right after the path line is refused (it would be posted as caption text)', () => {
  for (const msg of [
    `[MEDIA:file]${PDF}\n${CAPTION}\n[MENTIONS]["${XIAO_B}"]`,
    `[MEDIA:file]${PDF}\n\n[MENTIONS]["${XIAO_B}"]\n${CAPTION}`,
    `[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B}"]\n[MENTIONS]["${XIAO_C}"]`,
  ]) {
    assert.throws(() => parseMediaMessage(msg), (e) => e instanceof MediaMessageError && e.code === 'MEDIA_MENTIONS_INVALID'
      && /right after the path line/.test(e.message), msg);
  }
});

test('a second [MEDIA:…] line inside a MEDIA caption is refused (one file per message)', () => {
  assert.throws(
    () => parseMediaMessage(`[MEDIA:image]/tmp/a.png\n方案 A\n[MEDIA:image]/tmp/b.png`),
    (e) => e instanceof MediaMessageError && e.code === 'MEDIA_NOT_FIRST' && /one file/.test(e.message),
  );
});

// ── [MEDIA:…] not at the start ───────────────────────────────────────────────

test('findMisplacedMediaTag: a later line starting with the tag is found (with its 1-based line)', () => {
  assert.deepEqual(findMisplacedMediaTag(`@小B 报告附上\n[MEDIA:file]${PDF}`), { line: 2, kind: 'file' });
  assert.deepEqual(findMisplacedMediaTag('看图\n\n   [MEDIA:image]/tmp/a.png'), { line: 3, kind: 'image' });
});

test('findMisplacedMediaTag: mentions of the tag that are not a line start, or inside a fence, are fine', () => {
  for (const ok of [
    'plain text',
    '用 `[MEDIA:file]/abs/path` 发送文件',
    'send it as [MEDIA:file]/abs/path please',
    '示例：\n```text\n[MEDIA:file]/abs/path\n说明\n```\n完',
    '示例：\n~~~\n[MEDIA:image]/abs/a.png\n~~~',
    '示例：\n  ```\n[MEDIA:image]/abs/a.png\n  ```',
    '[MEDIA:video]/x.mp4 is not a tag we send',
    'x\n[MEDIA:video]/x.mp4',
  ]) {
    assert.equal(findMisplacedMediaTag(ok), null, ok);
  }
});

test('findMisplacedMediaTag: a tag after a closed fence is still found', () => {
  assert.deepEqual(findMisplacedMediaTag('```\ncode\n```\n[MEDIA:file]/tmp/x.pdf'), { line: 4, kind: 'file' });
});

test('assertNoMisplacedMediaTag throws MEDIA_NOT_FIRST naming the correct form', () => {
  assert.doesNotThrow(() => assertNoMisplacedMediaTag('hello'));
  assert.throws(() => assertNoMisplacedMediaTag(`${CAPTION}\n[MEDIA:file]${PDF}`), (e) => {
    assert.ok(e instanceof MediaMessageError);
    assert.equal(e.code, 'MEDIA_NOT_FIRST');
    assert.match(e.message, /line 2/);
    assert.match(e.message, /Nothing was sent/);
    assert.match(e.message, /\[MEDIA:file\]\/abs\/path\n\[MENTIONS\]/);
    return true;
  });
});

// ── [MENTIONS] without a [MEDIA:…] line ──────────────────────────────────────

test('assertNoMentionsWithoutMedia: a message whose first non-blank line starts with [MENTIONS] is refused, pointing to [STRUCTURED]', () => {
  for (const msg of [
    `[MENTIONS]["${XIAO_B}"]\n${CAPTION}`,
    `\n  [MENTIONS]["${XIAO_B}"]\n${CAPTION}`,
    '[MENTIONS]not even json',
  ]) {
    assert.throws(() => assertNoMentionsWithoutMedia(msg), (e) => {
      assert.ok(e instanceof MediaMessageError, msg);
      assert.equal(e.code, 'MENTIONS_WITHOUT_MEDIA', msg);
      assert.match(e.message, /Nothing was sent/);
      assert.match(e.message, /\[STRUCTURED\]\{"content":"[^"]*","mentions":\[/);
      return true;
    }, msg);
  }
});

test('assertNoMentionsWithoutMedia: [MENTIONS] that is not the first non-blank line, or mid-line, is plain text', () => {
  for (const ok of [
    'hello',
    `${CAPTION}\n[MENTIONS]["${XIAO_B}"]`,
    'use [MENTIONS] after the path line',
    '`[MENTIONS]` example',
  ]) {
    assert.doesNotThrow(() => assertNoMentionsWithoutMedia(ok), ok);
  }
});
