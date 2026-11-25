import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, truncateChars, redactTruncate, firstSentence, REDACT_MARGIN_CHARS } from './text-redact.js';

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

test('Authorization with any scheme: the scheme stays, the value goes', () => {
  assert.equal(r('curl -H "Authorization: Token abcdef123456" https://x'), 'curl -H "Authorization: Token [secret]" https://x');
  assert.equal(r("-H 'Proxy-Authorization: Digest abcdefg123'"), "-H 'Proxy-Authorization: Digest [secret]'");
  assert.equal(r('X-Authorization: Basic abc'), 'X-Authorization: Basic [secret]');
  assert.equal(r('Authorization: abcdef123456'), 'Authorization: [secret]');
  assert.equal(r('"Authorization": "Token abc123"'), '"Authorization": "[secret]"');
  assert.equal(r('Authorization: Bearer $TOKEN'), 'Authorization: Bearer $TOKEN');
});

test('command-line credentials: -u user:pass, mysql -p<pw>, redis-cli -a, sshpass -p, --pass', () => {
  assert.equal(r('curl -u admin:hunter2pass https://x'), 'curl -u admin:[secret] https://x');
  assert.equal(r('curl --user=admin:hunter2pass -x p --proxy-user bob:pw1 https://x'), 'curl --user=admin:[secret] -x p --proxy-user bob:[secret] https://x');
  assert.equal(r('curl --user-agent "Mozilla/5.0 (X11)" https://x'), 'curl --user-agent "Mozilla/5.0 (X11)" https://x');
  assert.equal(r('mysqldump -uroot -pS3cretPassw0rd db > ~/d.sql'), 'mysqldump -uroot -p[secret] db > ~/d.sql');
  assert.equal(r("mysql -u root -p'S3cret' -P3306 db"), "mysql -u root -p'[secret]' -P3306 db");
  assert.equal(r('mysql -u root -p db'), 'mysql -u root -p db', '-p alone prompts');
  assert.equal(r('tar -pczf a.tgz x; mkdir -p y'), 'tar -pczf a.tgz x; mkdir -p y', 'not a mysql command');
  assert.equal(r('redis-cli -h 127.0.0.1 -a hunter2 ping'), 'redis-cli -h 127.0.0.1 -a [secret] ping');
  assert.equal(r('redis-cli -ahunter2 ping; ls -a /tmp'), 'redis-cli -a[secret] ping; ls -a /tmp');
  assert.equal(r('redis-cli --pass hunter2 --user u'), 'redis-cli --pass [secret] --user u');
  assert.equal(r('sshpass -p hunter2 ssh -p 2222 me@host uptime'), 'sshpass -p [secret] ssh -p 2222 me@host uptime');
  assert.equal(r('sshpass -phunter2 ssh h'), 'sshpass -p[secret] ssh h');
  assert.equal(r('openssl enc --passphrase s3cret'), 'openssl enc --passphrase [secret]');
});

test('pass / pw keys, with prose and flag values kept', () => {
  assert.equal(r('DB_PASS=hunter2 ./run.sh'), 'DB_PASS=[secret] ./run.sh');
  assert.equal(r('DB_PW=hunter2 MYSQL_PWD=abc SMTP_PASSPHRASE=x ./run.sh'), 'DB_PW=[secret] MYSQL_PWD=[secret] SMTP_PASSPHRASE=[secret] ./run.sh');
  assert.equal(r('pass=hunter2'), 'pass=[secret]');
  assert.equal(r('Tests pass: 12/12'), 'Tests pass: 12/12');
  assert.equal(r('bypass_cache=true no_password=false'), 'bypass_cache=true no_password=false');
});

test('webhook URL tokens and credential query parameters', () => {
  assert.equal(r('curl -X POST https://hooks.slack.com/services/T0001/B0002/XXXXyyyyZZZZ -d x'), 'curl -X POST https://hooks.slack.com/services/[secret] -d x');
  assert.equal(r('https://discord.com/api/webhooks/123456789012/abcDEF_ghi-jkl'), 'https://discord.com/api/webhooks/[secret]');
  assert.equal(r('https://open.larksuite.com/open-apis/bot/v2/hook/0a1b2c3d-1111-2222-3333-444455556666'), 'https://open.larksuite.com/open-apis/bot/v2/hook/[secret]');
  assert.equal(r('cd ~/repo/.git/hooks/pre-commit-check && ls'), 'cd ~/repo/.git/hooks/pre-commit-check && ls');
  assert.equal(r('curl "https://api.x.com/v1?key=abc123&sig=def456&page=2&signature=s1"'), 'curl "https://api.x.com/v1?key=[secret]&sig=[secret]&page=2&signature=[secret]"');
  assert.equal(r('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7a1b'), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=[secret]');
  assert.equal(r('https://s3.x/o?X-Amz-Signature=abcd&X-Amz-Credential=AK%2F1'), 'https://s3.x/o?X-Amz-Signature=[secret]&X-Amz-Credential=[secret]');
  assert.equal(r('https://x/y?key=$KEY'), 'https://x/y?key=$KEY');
});

test('email addresses become [email]; git remotes stay', () => {
  assert.equal(r('echo hi | mail -s report ops@corp.internal'), 'echo hi | mail -s report [email]');
  assert.equal(r('to: First.Last+tag@example.co.uk, 123456789@qq.com'), 'to: [email], [email]');
  assert.equal(r('git clone git@github.com:org/repo.git'), 'git clone git@github.com:org/repo.git');
  assert.equal(r('ssh deploy@10.0.0.1 uptime'), 'ssh deploy@10.0.0.1 uptime');
});

test('U+0000 is removed (Workspace refuses it)', () => {
  assert.equal(r('a\u0000b\u0000'), 'ab');
  assert.equal(truncateChars('a\u0000bc', 10), 'abc');
  assert.equal(redactTruncate('x\u0000y', 5, { home: HOME }), 'xy');
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

test('redactTruncate cuts a huge input before redacting, without leaving a partial secret', () => {
  const max = 100;
  const huge = 'wm-'.repeat(400_000); // 1.2 MB, one word
  const started = process.hrtime.bigint();
  const out = redactTruncate(huge, max, { home: HOME });
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500);
  assert.equal(Array.from(out).length, max);
  // A secret straddling the pre-cut: the partial word is dropped, so it cannot
  // move into the field once the text before it shrinks.
  // Here a PEM block (→ 8 chars) fills the margin and the pre-cut falls inside
  // a JWT, whose first segment alone would no longer look like a secret.
  const limit = max + REDACT_MARGIN_CHARS;
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(limit - 100)}\n-----END RSA PRIVATE KEY-----`;
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def-ghi';
  const text = `${pem} x ${jwt} tail`;
  assert.ok(text.indexOf(jwt) < limit && text.indexOf(jwt) + jwt.length > limit, 'the pre-cut falls inside the JWT');
  const res = redactTruncate(text, max, { home: HOME });
  assert.equal(res, '[secret] x ');
});

test('review shapes stay linear: wm-, eyJ-, cid+, cid/ and the new credential rules at 100 KB', () => {
  const shapes = ['wm-', 'eyJ-', 'cid+', 'cid/', 'wr_', 'Authorization: ', 'x-authorization: Token ', ' -u ', ' -ux:', '?key=',
    '/hook/', '/webhooks/1', 'mysql -p', '|mysql -pa', 'redis-cli -a ', 'sshpass -p ', ' --pass ', 'a@', 'a@b.', 'a.b@', 'hooks.slack.com/services/'];
  for (const shape of shapes) {
    const text = shape.repeat(Math.ceil(100_000 / shape.length));
    const started = process.hrtime.bigint();
    redactText(text, { home: HOME });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${JSON.stringify(shape)} took ${ms} ms`);
  }
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
