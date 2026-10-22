import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSFORMS, applyTransform, MISSING, checkTransformCall } from './transforms.js';

test('base64url: bytes and strings, no padding, url alphabet', () => {
  assert.equal(applyTransform('base64url', Buffer.from([0xfb, 0xff, 0xfe]), []), '-__-');
  assert.equal(applyTransform('base64url', 'a', []), 'YQ');
  assert.ok(!applyTransform('base64url', 'ab', []).includes('='));
});

test('base64: standard alphabet with padding', () => {
  assert.equal(applyTransform('base64', 'a', []), 'YQ==');
  assert.equal(applyTransform('base64', Buffer.from([0xfb, 0xff, 0xfe]), []), '+//+');
});

test('base64url_decode / base64_decode accept both alphabets, with or without padding', () => {
  for (const name of ['base64url_decode', 'base64_decode']) {
    assert.deepEqual(applyTransform(name, '-__-', []), Buffer.from([0xfb, 0xff, 0xfe]));
    assert.deepEqual(applyTransform(name, '+//+', []), Buffer.from([0xfb, 0xff, 0xfe]));
    assert.equal(applyTransform(name, 'YQ==', []).toString(), 'a');
    assert.equal(applyTransform(name, 'YQ', []).toString(), 'a');
    assert.throws(() => applyTransform(name, 'Y', []), { status: 400 });
    assert.throws(() => applyTransform(name, 'a$b', []), { status: 400 });
  }
});

test('utf8 / json', () => {
  assert.deepEqual(applyTransform('utf8', 'é', []), Buffer.from('é', 'utf8'));
  assert.throws(() => applyTransform('utf8', 5, []), { status: 400 });
  assert.equal(applyTransform('json', { a: [1] }, []), '{"a":[1]}');
});

test('default supplies a value only when missing / null', () => {
  assert.equal(applyTransform('default', MISSING, ['x']), 'x');
  assert.equal(applyTransform('default', null, ['x']), 'x');
  assert.equal(applyTransform('default', '', ['x']), '');
  assert.equal(applyTransform('default', 'v', ['x']), 'v');
});

test('join', () => {
  assert.equal(applyTransform('join', ['a', 1, null], [',']), 'a,1,');
  assert.throws(() => applyTransform('join', 'a', [',']), { status: 400 });
});

test('header: case-insensitive lookup on [{name,value}], missing when absent', () => {
  const hs = [{ name: 'Subject', value: 'Hi' }, { name: 'Message-ID', value: '<m@x>' }];
  assert.equal(applyTransform('header', hs, ['subject']), 'Hi');
  assert.equal(applyTransform('header', hs, ['MESSAGE-ID']), '<m@x>');
  assert.equal(applyTransform('header', hs, ['References']), MISSING);
  assert.equal(applyTransform('header', 'nope', ['x']), MISSING);
});

test('prefix_once adds a prefix only once (case-insensitive)', () => {
  assert.equal(applyTransform('prefix_once', 'Hello', ['Re: ']), 'Re: Hello');
  assert.equal(applyTransform('prefix_once', 're: Hello', ['Re: ']), 're: Hello');
  assert.equal(applyTransform('prefix_once', '  RE:Hello', ['Re: ']), '  RE:Hello');
  assert.equal(applyTransform('prefix_once', '', ['Fwd: ']), 'Fwd: ');
});

test('MISSING propagates through every transform except default', () => {
  for (const name of Object.keys(TRANSFORMS)) {
    if (name === 'default') continue;
    const t = TRANSFORMS[name];
    const args = Array(t.min).fill('x');
    assert.equal(applyTransform(name, MISSING, args), MISSING, name);
  }
});

test('unknown transform / wrong arity is a 422', () => {
  assert.throws(() => checkTransformCall('eval', 0), { status: 422 });
  assert.throws(() => checkTransformCall('header', 0), { status: 422 });
  assert.throws(() => checkTransformCall('base64url', 1), { status: 422 });
});
