import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, truncateChars, redactTruncate, firstSentence } from './text-redact.js';

const HOME = '/home/alice';
const r = (text) => redactText(text, { home: HOME });

test('null and undefined pass through as null; other values become strings', () => {
  assert.equal(r(null), null);
  assert.equal(r(undefined), null);
  assert.equal(r(42), '42');
  assert.equal(r(''), '');
});

test('plain readable text is unchanged', () => {
  const text = 'Every day at 10:00, summarize yesterday (v2.37.1, 2026-11-26T02:00:00Z, 300s, count 12345678). on_success ok.';
  assert.equal(r(text), text);
});

test('home paths become ~/', () => {
  assert.equal(r('run /home/alice/zylos/x.sh'), 'run ~/zylos/x.sh');
  assert.equal(r('cd /home/alice && ls'), 'cd ~ && ls');
  assert.equal(r('cat /home/bob/.env'), 'cat ~/.env');
  assert.equal(r('open /Users/carol/Documents/a.md'), 'open ~/Documents/a.md');
  assert.equal(r('read /root/.ssh/config'), 'read ~/.ssh/config');
  assert.equal(r('path="/home/alice/x"'), 'path="~/x"');
  assert.equal(redactText('ls /srv/agent/data', { home: '/srv/agent' }), 'ls ~/data');
});

test('a /home/ inside a URL path is not a home path', () => {
  assert.equal(r('see https://example.com/home/page'), 'see https://example.com/home/page');
  assert.equal(r('https://example.com/root/x'), 'https://example.com/root/x');
});

test('Lark / Feishu / WeCom / DingTalk / OpenMax ids become [id]', () => {
  assert.equal(r('chat oc_655daebb99f5c62bae0121979c8f152d'), 'chat [id]');
  assert.equal(r('user ou_7d8a6e6f0a1b2c3d4e5f60718293a4b5 / on_1a2b3c4d5e6f7a8b'), 'user [id] / [id]');
  assert.equal(r('msg om_x100b7f4553534138fff486da5e79684 thread omt_1a2b3c4d5e6f'), 'msg [id] thread [id]');
  assert.equal(r('app cli_a1b2c3d4e5f6a7b8'), 'app [id]');
  assert.equal(r('wecom group wrOgQhDgAAAbcdEfgH12345678'), 'wecom group [id]');
  assert.equal(r('dingtalk cid4WfZJXEsdkjfh2378=='), 'dingtalk [id]');
  assert.equal(r('conv 019f6a84-3a1e-76dd-931d-0eea1cb3112a'), 'conv [id]');
  assert.equal(r('019f6a84-3a1e-76dd-931d-0eea1cb3112a|type:group|msg:7300000000000000132'), '[id]|type:group|msg:[id]');
});

test('long numeric ids become [id]; short numbers and decimals stay', () => {
  assert.equal(r('telegram -1001234567890 and user 123456789'), 'telegram [id] and user [id]');
  assert.equal(r('discord 112233445566778899.'), 'discord [id].');
  assert.equal(r('limit 100000000x'), 'limit 100000000x');
  assert.equal(r('pi 3.1415926535 and 12345678'), 'pi 3.1415926535 and 12345678');
});

test('words that merely start like an id prefix stay', () => {
  assert.equal(r('on_success / on_error / cli_options / wrongfully_misinterpreted_concept'),
    'on_success / on_error / cli_options / wrongfully_misinterpreted_concept');
});

test('bearer / basic credentials, JWTs and URL passwords become [secret]', () => {
  assert.equal(r('curl -H "Authorization: Bearer abcdef123456.xyz"'), 'curl -H "Authorization: Bearer [secret]"');
  assert.equal(r('Basic dXNlcjpwYXNzd29yZA=='), 'Basic [secret]');
  assert.equal(r('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def-ghi ok'), 'jwt [secret] ok');
  assert.equal(r('git clone https://bob:hunter2@git.example.com/repo'), 'git clone https://[secret]@git.example.com/repo');
});

test('vendor token formats become [secret]', () => {
  for (const token of [
    'sk-proj-abcdefghijklmnop1234',
    'sk-ant-api03-abcdefghijklmnopqrst',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0abcdefghijklmn',
    'glpat-abcdefghijklmnop1234',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'zylos_ak_abcdefgh1234',
    'zylos_st_abcdefgh1234',
  ]) {
    assert.equal(r(`use ${token} now`), 'use [secret] now', token);
  }
  // `task-…` is not an `sk-` token.
  assert.equal(r('scheduler-task-msscj22p-e0tles'), 'scheduler-task-msscj22p-e0tles');
});

test('PEM private keys become [secret]', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(r(`key:\n${pem}\nend`), 'key:\n[secret]\nend');
});

test('key=value, key: value and JSON pairs with a secret-ish key', () => {
  assert.equal(r('OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 GITHUB_TOKEN=abc123'), 'OPENAI_API_KEY=[secret] GITHUB_TOKEN=[secret]');
  assert.equal(r('https://x.test/cb?token=abc123&page=2'), 'https://x.test/cb?token=[secret]&page=2');
  assert.equal(r('{"password": "p@ss w0rd", "name": "ok"}'), '{"password": "[secret]", "name": "ok"}');
  assert.equal(r("client_secret: 'a b c'"), "client_secret: '[secret]'");
  assert.equal(r('db_password=hunter2; app_secret: s3cr3t, session_id=xyz'), 'db_password=[secret]; app_secret: [secret], session_id=[secret]');
  assert.equal(r('access-key：abcd'), 'access-key：[secret]');
  assert.equal(r('密码：abc123，令牌=xyz 私钥: k1'), '密码：[secret]，令牌=[secret] 私钥: [secret]');
});

test('key=value keeps counts, variable references and empty values readable', () => {
  assert.equal(r('max_tokens=4096 input_tokens: 12'), 'max_tokens=4096 input_tokens: 12');
  assert.equal(r('use $API_KEY and token=${TOKEN} or secret=$SECRET'), 'use $API_KEY and token=${TOKEN} or secret=$SECRET');
  assert.equal(r('secret='), 'secret=');
});

test('CLI flags carrying secrets', () => {
  assert.equal(r('tool --token abc123 --password=pw1 --name foo'), 'tool --token [secret] --password=[secret] --name foo');
  assert.equal(r('tool --api-key "k-1"'), 'tool --api-key "[secret]"');
});

test('long hex and long random mixed-case strings become [secret]', () => {
  assert.equal(r('sig 3f9a1c2b3f9a1c2b3f9a1c2b3f9a1c2b'), 'sig [secret]');
  assert.equal(r('key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'key [secret]');
  // Plain long words (no digits) stay.
  assert.equal(r('supercalifragilisticexpialidocious_and_more_words'), 'supercalifragilisticexpialidocious_and_more_words');
});

test('redaction is idempotent', () => {
  const text = 'Bearer abcdef123456 oc_655daebb99f5c62bae0121979c8f152d /home/alice/x token=abc';
  assert.equal(r(r(text)), r(text));
});

test('truncateChars counts code points and marks the cut', () => {
  assert.equal(truncateChars('abc', 3), 'abc');
  assert.equal(truncateChars('abcd', 3), 'ab…');
  assert.equal(truncateChars('一二三四五六', 4), '一二三…');
  assert.equal(Array.from(truncateChars('😀'.repeat(100), 60)).length, 60);
  assert.equal(truncateChars('ab [secret] cd', 9), 'ab …', 'a half placeholder is dropped');
  assert.equal(truncateChars(null, 5), null);
});

test('redactTruncate redacts before cutting', () => {
  const text = `${'x'.repeat(10)} /home/alice/${'y'.repeat(100)}`;
  const out = redactTruncate(text, 20, { home: HOME });
  assert.equal(out, `${'x'.repeat(10)} ~/${'y'.repeat(6)}…`);
  assert.equal(Array.from(out).length, 20);
});

test('firstSentence: first non-empty line, cut after the first sentence end', () => {
  assert.equal(firstSentence('## 每日日报。然后做别的\nsecond'), '每日日报。');
  assert.equal(firstSentence('Check v2.3.1 status. Then report!'), 'Check v2.3.1 status.');
  assert.equal(firstSentence('\n\n- read ~/x.md and summarize\nmore'), 'read ~/x.md and summarize');
  assert.equal(firstSentence('Is it done? yes'), 'Is it done?');
  assert.equal(firstSentence('   \n '), null);
  assert.equal(firstSentence(null), null);
});

test('adversarial input stays linear (an 8000+ char prompt never stalls the tick)', () => {
  const inputs = [
    'a.'.repeat(10000), 'token'.repeat(4000), 'token='.repeat(3000), 'a:'.repeat(10000), 'http://'.repeat(3000),
    'aB1'.repeat(7000), '1'.repeat(20000), '/home/'.repeat(4000), '"token": "'.repeat(2000), 'Bearer '.repeat(3000),
  ];
  const started = process.hrtime.bigint();
  for (const text of inputs) redactText(text, { home: HOME });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `took ${ms} ms`);
});
