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
    '[MENTIONS]["小B"]', // a bare name: not a UUID
    '[MENTIONS]["小 B"]', // has a space: looks like a name
    '[MENTIONS][{"type":"member","member_id":"m-1"}]', // object member_id not a UUID
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

test('[MENTIONS] member id must be a UUID: a bare name is refused as "not a member id"', () => {
  for (const line of ['[MENTIONS]["小B"]', `[MENTIONS]["${XIAO_B}","xiaob"]`, `[MENTIONS]["${XIAO_B.slice(0, -1)}"]`]) {
    assert.throws(() => parseMediaMessage(`[MEDIA:file]${PDF}\n${line}`), (e) => e instanceof MediaMessageError
      && e.code === 'MEDIA_MENTIONS_INVALID' && /is not a member id \(a UUID\)/.test(e.message), line);
  }
  // Upper-case UUIDs are member ids too.
  assert.deepEqual(parseMediaMessage(`[MEDIA:file]${PDF}\n[MENTIONS]["${XIAO_B.toUpperCase()}"]`).mentions,
    [{ type: 'member', member_id: XIAO_B.toUpperCase() }]);
});

test('[MENTIONS] id with a space or a leading @ → "looks like a name"', () => {
  for (const line of ['[MENTIONS]["小 B"]', '[MENTIONS]["@小B"]', `[MENTIONS][{"type":"member","member_id":"Xiao B"}]`]) {
    assert.throws(() => parseMediaMessage(`[MEDIA:file]${PDF}\n${line}`), (e) => e instanceof MediaMessageError
      && e.code === 'MEDIA_MENTIONS_INVALID' && /looks like a name/.test(e.message), line);
  }
});

test('line 2 that nearly is [MENTIONS] (case, full-width brackets, singular) is refused, not sent as caption', () => {
  for (const line of [
    `[mentions]["${XIAO_B}"]`,
    `[Mentions]["${XIAO_B}"]`,
    `【MENTIONS】["${XIAO_B}"]`,
    `［MENTIONS］["${XIAO_B}"]`,
    `[MENTION]["${XIAO_B}"]`,
    `  [ MENTIONS ]["${XIAO_B}"]`,
  ]) {
    assert.throws(() => parseMediaMessage(`[MEDIA:file]${PDF}\n${line}\n${CAPTION}`), (e) => e instanceof MediaMessageError
      && e.code === 'MEDIA_MENTIONS_INVALID' && /not exactly \[MENTIONS\]/.test(e.message), line);
  }
  // A caption that merely starts with a bracketed word is still a caption.
  assert.equal(parseMediaMessage(`[MEDIA:file]${PDF}\n[说明] 报价单`).caption, '[说明] 报价单');
});

test('indented [MENTIONS] on line 2 is read', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\n   [MENTIONS]["${XIAO_B}"]\n${CAPTION}`);
  assert.deepEqual(r.mentions, [{ type: 'member', member_id: XIAO_B }]);
  assert.equal(r.caption, CAPTION);
});

test('CRLF input: path, [MENTIONS] and caption are read as with LF', () => {
  const r = parseMediaMessage(`[MEDIA:file]${PDF}\r\n[MENTIONS]["${XIAO_B}"]\r\n${CAPTION}\r\n`);
  assert.deepEqual(r, { kind: 'file', localPath: PDF, caption: CAPTION, mentions: [{ type: 'member', member_id: XIAO_B }] });
  assert.deepEqual(findMisplacedMediaTag(`${CAPTION}\r\n[MEDIA:file]${PDF}`), { line: 2, kind: 'file' });
  assert.equal(findMisplacedMediaTag('示例：\r\n```\r\n[MEDIA:file]/abs/path\r\n```\r\n完'), null);
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

test('findMisplacedMediaTag: a 4-backtick fence holding a 3-backtick example stays open (CommonMark)', () => {
  const text = '写法：\n````markdown\n```text\n[MEDIA:file]/abs/path\n```\n[MEDIA:file]/abs/other.pdf\n````\n完';
  assert.equal(findMisplacedMediaTag(text), null);
  // …and closes at the 4-backtick line: a tag after it is found.
  assert.deepEqual(findMisplacedMediaTag(`${text}\n[MEDIA:file]/tmp/x.pdf`), { line: 9, kind: 'file' });
});

test('findMisplacedMediaTag: only a same-character, long-enough, bare fence closes a fence', () => {
  for (const ok of [
    '```\n~~~\n[MEDIA:file]/abs/path\n```', // ~~~ does not close ```
    '~~~~\n~~~\n[MEDIA:file]/abs/path\n~~~~', // shorter does not close
    '```\n```text\n[MEDIA:file]/abs/path\n```', // a fence with an info string does not close
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

test('assertNoMentionsWithoutMedia: a [MENTIONS] line anywhere in a text message is refused, with its line', () => {
  for (const [msg, line] of [
    [`${CAPTION}\n[MENTIONS]["${XIAO_B}"]`, 2],
    [`第一段\n\n第二段\n   [MENTIONS]["${XIAO_B}"]\n尾`, 4],
    [`${CAPTION}\r\n[MENTIONS]["${XIAO_B}"]\r\n尾`, 2], // CRLF
    ['```\n[MENTIONS]["x"]\n```\n[MENTIONS]["y"]', 4], // after a closed fence
    ['```x``` 是行内代码\n[MENTIONS]["y"]', 2], // inline code opens no fence
  ]) {
    assert.throws(() => assertNoMentionsWithoutMedia(msg), (e) => {
      assert.ok(e instanceof MediaMessageError, msg);
      assert.equal(e.code, 'MENTIONS_WITHOUT_MEDIA', msg);
      assert.match(e.message, new RegExp(`\\(line ${line}\\)`), msg);
      return true;
    }, msg);
  }
});

test('assertNoMentionsWithoutMedia: [MENTIONS] mid-line, in inline code, or inside a fence is plain text', () => {
  for (const ok of [
    'hello',
    'use [MENTIONS] after the path line',
    '`[MENTIONS]` example',
    'x\n`[MENTIONS]["y"]` 这样写',
    '写法：\n```text\n[MEDIA:file]/abs/path\n[MENTIONS]["<member id>"]\n```\n完',
    '写法：\r\n```text\r\n[MENTIONS]["<member id>"]\r\n```\r\n完', // CRLF fence
    '~~~\n[MENTIONS]["x"]', // unclosed fence runs to the end
    '~~~ a`b\n[MENTIONS]["x"]\n~~~', // a tilde fence's info may hold a backtick
  ]) {
    assert.doesNotThrow(() => assertNoMentionsWithoutMedia(ok), ok);
  }
});

test('a line "```x```" (backtick info string with a backtick) is inline code, not a fence opener', () => {
  // Before: "```x```" opened a fence that ran to the end and hid the tag.
  assert.deepEqual(findMisplacedMediaTag('```x```\n[MEDIA:file]/tmp/x.pdf'), { line: 2, kind: 'file' });
  assert.deepEqual(findMisplacedMediaTag('```x``` here\n\n[MEDIA:image]/tmp/a.png'), { line: 3, kind: 'image' });
  assert.deepEqual(findMisplacedMediaTag('use ```x``` here\n[MEDIA:file]/tmp/x.pdf'), { line: 2, kind: 'file' });
  assert.deepEqual(findMisplacedMediaTag('```x```\r\n[MEDIA:file]/tmp/x.pdf'), { line: 2, kind: 'file' });
  // …in a MEDIA caption too.
  assert.throws(() => parseMediaMessage('[MEDIA:file]/tmp/a.pdf\n```x```\n[MEDIA:file]/tmp/b.pdf'),
    (e) => e.code === 'MEDIA_NOT_FIRST');
  assert.throws(() => parseMediaMessage(`[MEDIA:file]/tmp/a.pdf\n\`\`\`x\`\`\`\n[MENTIONS]["${XIAO_B}"]`),
    (e) => e.code === 'MEDIA_MENTIONS_INVALID');
  // A real fence (info without backticks) still hides it; a tilde fence's info may hold backticks.
  assert.equal(findMisplacedMediaTag('```js\n[MEDIA:file]/tmp/x.pdf\n```'), null);
  assert.equal(findMisplacedMediaTag('~~~ `x`\n[MEDIA:file]/tmp/x.pdf\n~~~'), null);
  // Inside an open fence a "```x```" line is content: it neither closes nor reopens.
  assert.equal(findMisplacedMediaTag('```\n```x```\n[MEDIA:file]/tmp/x.pdf\n```'), null);
});
