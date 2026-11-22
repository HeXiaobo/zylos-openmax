import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalTemplate, analyzeTemplate, parseExpression, MISSING, MAX_TEMPLATE_DEPTH } from './template.js';

const ev = (t, params = {}, extra = {}) => evalTemplate(t, { params, ...extra });

test('whole-string expression keeps native types', () => {
  assert.equal(ev('{{n}}', { n: 3 }), 3);
  assert.equal(ev('{{b}}', { b: false }), false);
  assert.deepEqual(ev('{{a}}', { a: [1, 'x'] }), [1, 'x']);
  assert.deepEqual(ev('{{ o.k }}', { o: { k: { z: 1 } } }), { z: 1 });
  assert.equal(ev('{{a.1}}', { a: ['x', 'y'] }), 'y');
});

test('missing values delete the key / array element', () => {
  assert.deepEqual(ev({ a: '{{a}}', b: '{{b}}', c: 'lit' }, { a: 1 }), { a: 1, c: 'lit' });
  assert.deepEqual(ev(['{{a}}', '{{b}}', 2], { b: 'x' }), ['x', 2]);
  assert.equal(ev('{{a}}', { a: null }), MISSING);
  assert.deepEqual(ev({ x: { y: '{{nope}}' } }), { x: {} });
});

test('interpolation: missing → empty, scalars stringified, bytes rejected', () => {
  assert.equal(ev('Re: {{s}}!', { s: 'hi' }), 'Re: hi!');
  assert.equal(ev('[{{s}}]'), '[]');
  assert.equal(ev('{{a}}-{{b}}', { a: 1, b: true }), '1-true');
  assert.equal(ev('x {{o}}', { o: { a: 1 } }), 'x {"a":1}');
  assert.throws(() => ev('x {{b | utf8}}', { b: 'q' }), { status: 400 });
});

test('pipelines with transform args', () => {
  const hs = [{ name: 'Subject', value: 'Plan' }];
  assert.equal(ev("{{h | header('subject') | prefix_once('Re: ')}}", { h: hs }), 'Re: Plan');
  assert.equal(ev("{{h | header('X') | default('none')}}", { h: hs }), 'none');
  assert.equal(ev('{{a | join(", ")}}', { a: ['x', 'y'] }), 'x, y');
});

test('$if with negation, else, and key deletion when false without else', () => {
  const t = {
    location: { $if: 'index', then: { index: '{{index}}' } },
    end: { $if: '!index', then: { segmentId: '{{seg}}' } },
  };
  assert.deepEqual(ev(t, { index: 5 }), { location: { index: 5 } });
  assert.deepEqual(ev(t, {}), { end: {} });
  assert.deepEqual(ev(t, { index: 0 }), { location: { index: 0 } }, 'integer 0 is present');
  assert.equal(ev({ $if: 'x', then: 1, else: 2 }, { x: '' }), 2);
  assert.equal(ev({ $if: 'x', then: 1, else: 2 }, { x: false }), 2);
});

test('$first picks the first non-missing / non-empty value', () => {
  assert.equal(ev({ $first: ['{{a}}', '{{b}}', 'z'] }, { a: '', b: 'B' }), 'B');
  assert.equal(ev({ $first: ['{{a}}'] }), MISSING);
  assert.deepEqual(ev({ k: { $first: ['{{a}}'] } }), {});
});

test('$concat concatenates arrays (missing → [])', () => {
  assert.deepEqual(ev({ $concat: ['{{a}}', '{{b}}', '{{c}}'] }, { a: [1], c: 3 }), [1, 3]);
});

test('$pipe applies transforms to a node', () => {
  assert.equal(ev({ $pipe: ['{{s}}', 'base64url'] }, { s: 'hi' }), 'aGk');
  assert.equal(ev({ $pipe: ['{{s}}', 'base64url'] }), MISSING);
});

test('$bytes turns an expression into a file; literals are refused', () => {
  const f = ev({ $bytes: '{{raw | base64url_decode}}', mime_type: 'message/rfc822', filename: 'fwd.eml' }, { raw: 'aGk' });
  assert.equal(f.__file, true);
  assert.equal(f.bytes.toString(), 'hi');
  assert.equal(f.mime_type, 'message/rfc822');
  assert.equal(f.filename, 'fwd.eml');
  assert.equal(f.size, 2);
  assert.throws(() => ev({ $bytes: '/etc/passwd' }), { status: 422 });
  assert.throws(() => ev({ $bytes: 'x {{a}}' }, { a: 1 }), { status: 422 });
  assert.throws(() => analyzeTemplate({ $bytes: 'literal' }), { status: 422 });
  assert.equal(ev({ $bytes: '{{nope}}' }), MISSING);
});

test('$rfc822 delegates to the injected builder with evaluated, present fields', () => {
  let got;
  const out = evalTemplate({ $rfc822: { to: '{{to}}', cc: '{{cc}}', subject: 'S' } }, { params: { to: 'a@b.c' }, rfc822: (f) => { got = f; return Buffer.from('M'); } });
  assert.deepEqual(got, { to: 'a@b.c', subject: 'S' });
  assert.deepEqual(out, Buffer.from('M'));
  assert.throws(() => evalTemplate({ $rfc822: { headers: 'x' } }, { params: {}, rfc822: () => Buffer.alloc(0) }), { status: 422 });
});

test('prefetch and files namespaces', () => {
  const ctx = {
    params: { x: 1 },
    prefetch: { orig: { status_code: 200, headers: {}, body: { threadId: 'T1' } } },
    files: { doc: { __file: true, filename: 'a.pdf', mime_type: 'application/pdf', size: 9, bytes: Buffer.alloc(9) } },
  };
  assert.equal(evalTemplate('{{prefetch.orig.body.threadId}}', ctx), 'T1');
  assert.equal(evalTemplate('{{prefetch.nope.body}}', ctx), MISSING);
  assert.equal(evalTemplate('{{files.doc.filename}}', ctx), 'a.pdf');
  assert.equal(evalTemplate('{{files.doc.size}}', ctx), 9);
  assert.equal(evalTemplate('{{doc}}', ctx).filename, 'a.pdf');
  assert.equal(evalTemplate('{{files.doc.bytes}}', ctx), MISSING, 'raw bytes are not addressable by path');
});

test('unknown directive / extra keys / two directives are refused', () => {
  for (const t of [{ $eval: 'x' }, { $if: 'a', then: 1, other: 2 }, { $first: ['a'], $concat: ['b'] }, { $first: [] }, { $if: 'a' }]) {
    assert.throws(() => ev(t, { a: 1 }), { status: 422 }, JSON.stringify(t));
    assert.throws(() => analyzeTemplate(t), { status: 422 }, JSON.stringify(t));
  }
});

test('unknown transform and bad expressions are refused statically and at runtime', () => {
  assert.throws(() => analyzeTemplate('{{a | exec}}'), { status: 422 });
  assert.throws(() => ev('{{a | exec}}', { a: 1 }), { status: 422 });
  assert.throws(() => parseExpression('a..b'), { status: 422 });
  assert.throws(() => parseExpression("a | header('x"), { status: 422 });
  assert.throws(() => parseExpression('1abc'), { status: 422 });
});

test('expression length and nesting depth limits', () => {
  const long = `{{${'a'.repeat(257)}}}`;
  assert.throws(() => ev(long), { status: 422 });
  assert.doesNotThrow(() => ev(`{{${'a'.repeat(256)}}}`));
  let deep = 'x';
  for (let i = 0; i <= MAX_TEMPLATE_DEPTH; i++) deep = { k: deep };
  assert.throws(() => ev(deep), { status: 422 });
  assert.throws(() => analyzeTemplate(deep), { status: 422 });
  let ok = 'x';
  for (let i = 0; i < MAX_TEMPLATE_DEPTH; i++) ok = { k: ok };
  assert.doesNotThrow(() => ev(ok));
});

test('analyzeTemplate collects root params, prefetch and file references', () => {
  const a = analyzeTemplate({
    raw: { $first: ['{{raw}}', { $pipe: [{ $rfc822: { to: '{{to}}', attachments: '{{attachments}}' } }, 'base64url'] }] },
    t: "{{prefetch.orig.body.payload.headers | header('Subject')}}",
    l: { $if: '!index', then: '{{files.attachments.0.filename}}' },
  }, { prefetchAs: new Set(['orig']), fileParams: new Set(['attachments']) });
  assert.deepEqual([...a.roots].sort(), ['attachments', 'index', 'raw', 'to']);
  assert.deepEqual([...a.prefetchRefs], ['orig']);
  assert.deepEqual([...a.fileRefs], ['attachments']);
  assert.throws(() => analyzeTemplate('{{prefetch.other.body}}', { prefetchAs: new Set(['orig']) }), { status: 422 });
  assert.throws(() => analyzeTemplate('{{files.x.size}}', { fileParams: new Set() }), { status: 422 });
  assert.throws(() => analyzeTemplate('{{prefetch.orig.secret}}', { prefetchAs: new Set(['orig']) }), { status: 422 });
});
