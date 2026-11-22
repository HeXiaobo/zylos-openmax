import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRfc822, encodedWords, rfc2231Value, parseMailbox } from './rfc822.js';

const DATE = new Date(Date.UTC(2026, 9, 22, 8, 30, 0));
const opts = () => { let i = 0; return { date: DATE, boundary: () => `B${i++}` }; };
const build = (f) => buildRfc822(f, opts()).toString('utf8');
const file = (filename, mime, content) => ({ __file: true, filename, mime_type: mime, bytes: Buffer.from(content), size: Buffer.byteLength(content) });

function assertCrlfOnly(s) {
  assert.ok(!/[^\r]\n/.test(s) && !/\r[^\n]/.test(s), 'every line ends with CRLF');
}

test('golden: plain text message', () => {
  const got = build({ from: 'Me <me@example.com>', to: 'you@example.com', subject: 'Hello', text: 'Hi there' });
  assert.equal(got, [
    'MIME-Version: 1.0',
    'Date: Thu, 22 Oct 2026 08:30:00 +0000',
    'From: Me <me@example.com>',
    'To: you@example.com',
    'Subject: Hello',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Hi there').toString('base64'),
  ].join('\r\n'));
  assertCrlfOnly(got);
  assert.ok(!/Message-ID/i.test(got), 'Message-ID is left to the provider');
});

test('golden: html only', () => {
  const got = build({ to: 'a@b.co', html: '<p>x</p>' });
  assert.match(got, /\r\nContent-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA\+eDwvcD4=$/);
});

test('golden: multipart/alternative (text first)', () => {
  const got = build({ to: 'a@b.co', subject: 'S', text: 'T', html: '<b>H</b>' });
  assert.equal(got, [
    'MIME-Version: 1.0',
    'Date: Thu, 22 Oct 2026 08:30:00 +0000',
    'To: a@b.co',
    'Subject: S',
    'Content-Type: multipart/alternative;',
    ' boundary="B0"',
    '',
    '--B0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    'VA==',
    '--B0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    'PGI+SDwvYj4=',
    '--B0--',
    '',
  ].join('\r\n'));
});

test('golden: multipart/mixed with alternative body and an attachment', () => {
  const got = build({ to: 'a@b.co', text: 'T', html: 'H', attachments: [file('r.pdf', 'application/pdf', '%PDF')] });
  assert.equal(got, [
    'MIME-Version: 1.0',
    'Date: Thu, 22 Oct 2026 08:30:00 +0000',
    'To: a@b.co',
    'Content-Type: multipart/mixed;',
    ' boundary="B1"',
    '',
    '--B1',
    'Content-Type: multipart/alternative;',
    ' boundary="B0"',
    '',
    '--B0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    'VA==',
    '--B0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    'SA==',
    '--B0--',
    '',
    '--B1',
    'Content-Type: application/pdf;',
    ' name="r.pdf"',
    'Content-Disposition: attachment;',
    ' filename="r.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERg==',
    '--B1--',
    '',
  ].join('\r\n'));
  assertCrlfOnly(got);
});

test('forwarded original as message/rfc822 attachment is base64 only', () => {
  const orig = 'From: x@y.z\r\nSubject: Orig\r\n\r\nbody';
  const got = build({ to: 'a@b.co', text: 'see below', attachments: file('forwarded.eml', 'message/rfc822', orig) });
  assert.match(got, /Content-Type: message\/rfc822;\r\n name="forwarded.eml"\r\nContent-Disposition: attachment;\r\n filename="forwarded.eml"\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.ok(got.includes(Buffer.from(orig).toString('base64')));
});

test('non-ASCII subject: UTF-8 B encoded-words ≤ 75 chars, split on char boundaries, folded', () => {
  const subject = '季度报告：这是一个很长的中文主题，用来测试编码词的切分与折行是否正确 ✅';
  const got = build({ to: 'a@b.co', subject, text: 'x' });
  const lines = got.split('\r\n');
  const i = lines.findIndex((l) => l.startsWith('Subject: '));
  const subj = [lines[i]];
  for (let j = i + 1; lines[j].startsWith(' '); j++) subj.push(lines[j]);
  assert.ok(subj.length > 1, 'folded over several lines');
  for (const l of subj) assert.ok(l.length <= 76, `line ≤ 76: ${l}`);
  const words = subj.map((l) => l.replace(/^Subject: /, '').trim());
  let decoded = '';
  for (const w of words) {
    assert.ok(w.length <= 75);
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
    assert.ok(m, w);
    const part = Buffer.from(m[1], 'base64');
    assert.equal(Buffer.from(part.toString('utf8'), 'utf8').length, part.length, 'each word is whole UTF-8 chars');
    decoded += part.toString('utf8');
  }
  assert.equal(decoded, subject);
});

test('RFC 2047 / RFC 2231 reference values', () => {
  assert.deepEqual(encodedWords('André'), ['=?UTF-8?B?QW5kcsOp?=']);
  // RFC 2231 §4 example value ("This is ***fun***"), with the UTF-8 charset.
  assert.equal(rfc2231Value('This is ***fun***'), "UTF-8''This%20is%20%2A%2A%2Afun%2A%2A%2A");
  assert.equal(rfc2231Value('报告.pdf'), "UTF-8''%E6%8A%A5%E5%91%8A.pdf");
});

test('non-ASCII display names are encoded, addresses untouched; specials quoted', () => {
  const got = build({ from: 'André Müller <andre@example.com>', to: ['"Doe, John" <j@x.io>', 'Plain Name <p@x.io>', 'bare@x.io'], text: '' });
  assert.match(got, /\r\nFrom: =\?UTF-8\?B\?QW5kcsOpIE3DvGxsZXI=\?= <andre@example.com>\r\n/);
  assert.match(got, /\r\nTo: "Doe, John" <j@x\.io>, Plain Name <p@x\.io>, bare@x\.io\r\n/);
});

test('address lists: comma-separated string, folding at 78 columns, bcc written', () => {
  const many = Array.from({ length: 8 }, (_, i) => `person${i}@example.com`).join(', ');
  const got = build({ to: many, bcc: 'hidden@example.com', text: 't' });
  const lines = got.split('\r\n');
  const i = lines.findIndex((l) => l.startsWith('To: '));
  assert.ok(lines[i + 1].startsWith(' '), 'folded');
  for (let j = i; j < lines.length && (j === i || lines[j].startsWith(' ')); j++) assert.ok(lines[j].length <= 78);
  assert.ok(got.includes('\r\nBcc: hidden@example.com\r\n'));
});

test('non-ASCII attachment filename: RFC 2231 filename* plus RFC 2047 fallback', () => {
  const got = build({ to: 'a@b.co', text: 't', attachments: [file('报告.pdf', 'application/pdf', 'x')] });
  assert.ok(got.includes(' name="=?UTF-8?B?5oql5ZGKLnBkZg==?="'));
  assert.ok(got.includes(' filename="=?UTF-8?B?5oql5ZGKLnBkZg==?=";\r\n filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.pdf'));
});

test('In-Reply-To / References written verbatim as <id> tokens', () => {
  const got = build({ to: 'a@b.co', in_reply_to: '<m1@x>', references: '  <m0@x>   <m1@x> ', text: 't' });
  assert.ok(got.includes('\r\nIn-Reply-To: <m1@x>\r\n'));
  assert.ok(got.includes('\r\nReferences: <m0@x> <m1@x>\r\n'));
  assert.throws(() => build({ in_reply_to: 'm1@x', text: 't' }), { status: 400 });
  assert.throws(() => build({ references: '<a> b', text: 't' }), { status: 400 });
});

test('header injection is refused (CR / LF / NUL in any header input)', () => {
  const evil = [
    { subject: 'Hi\r\nBcc: victim@x.io' },
    { subject: 'Hi\nX: y' },
    { to: 'a@b.co\r\nBcc: v@x.io' },
    { to: 'Name\0 <a@b.co>' },
    { from: 'x@y.z\n' },
    { in_reply_to: '<a@b>\r\nX: y' },
    { attachments: [file('a\r\n.txt', 'text/plain', 'x')] },
    { attachments: [file('a.txt', 'text/plain\r\nX-Evil: 1', 'x')] },
  ];
  for (const f of evil) assert.throws(() => build({ text: 't', ...f }), { status: 400 }, JSON.stringify(f));
});

test('invalid addresses and non-file attachments are refused', () => {
  assert.throws(() => build({ to: 'not an address', text: 't' }), { status: 400 });
  assert.throws(() => build({ to: 'a@b.co', text: 't', attachments: ['/etc/passwd'] }), { status: 400 });
  assert.deepEqual(parseMailbox('"Q \\"x\\"" <a@b.co>', 'to'), { name: 'Q "x"', address: 'a@b.co' });
});

test('base64 body lines are at most 76 characters', () => {
  const got = build({ to: 'a@b.co', text: 'x'.repeat(500) });
  const body = got.split('\r\n\r\n')[1].split('\r\n');
  assert.ok(body.length > 1);
  for (const l of body) assert.ok(l.length <= 76);
});

test('default boundary is random and never collides with content', () => {
  const a = buildRfc822({ to: 'a@b.co', text: 't', html: 'h' }, { date: DATE }).toString();
  const b = buildRfc822({ to: 'a@b.co', text: 't', html: 'h' }, { date: DATE }).toString();
  assert.notEqual(a, b);
  let n = 0;
  const gen = () => (n++ === 0 ? 'VA' : 'FRESH'); // 'VA' occurs in base64("T") = "VA=="
  const got = buildRfc822({ to: 'a@b.co', text: 'T', html: 'h' }, { date: DATE, boundary: gen }).toString();
  assert.ok(got.includes('boundary="FRESH"') && !got.includes('boundary="VA"'));
});

test('a Gmail-style raw payload round-trips through base64url', () => {
  const raw = buildRfc822({ to: 'me@example.com', subject: '[cws-verify] t', text: 'hello' }, opts()).toString('base64url');
  assert.ok(!raw.includes('=') && !raw.includes('+') && !raw.includes('/'));
  assert.match(Buffer.from(raw, 'base64url').toString(), /^MIME-Version: 1\.0\r\n/);
});
