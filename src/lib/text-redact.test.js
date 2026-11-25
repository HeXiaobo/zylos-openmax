import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactText, truncateChars, redactTruncate, firstSentence, REDACT_MARGIN_CHARS,
  createLru, redactCacheStats, CACHE_MAX_ENTRIES, CACHE_MAX_UNITS,
} from './text-redact.js';

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

test('pass / pw count only as the last part of a key', () => {
  assert.equal(r('tests passed=12 PASS_RATE=0.9 compass=north bypass_proxy=1 passenger_count=3 passport_no=X12 pwm_duty=5'),
    'tests passed=12 PASS_RATE=0.9 compass=north bypass_proxy=1 passenger_count=3 passport_no=X12 pwm_duty=5');
  assert.equal(r('DB_PASS=h1 smtp.pw=h2 redis-pass: h3 pw=h4 MYSQL_PASSWORD=h5 db_passwd=h6 passphrase_file=h7'),
    'DB_PASS=[secret] smtp.pw=[secret] redis-pass: [secret] pw=[secret] MYSQL_PASSWORD=[secret] db_passwd=[secret] passphrase_file=[secret]');
});

test('harmless shapes stay: user@host:path, plain hook paths, ?code=, Authorization prose, uid:gid, date formats', () => {
  assert.equal(r('rsync -a backup@example.com:/backups/ /srv; scp me@build.example.org:out.tgz .'),
    'rsync -a backup@example.com:/backups/ /srv; scp me@build.example.org:out.tgz .');
  assert.equal(r('mail to ops@corp.example.com. Then ops@corp.example.com: done'), 'mail to [email]. Then [email]: done');
  assert.equal(r('curl https://ci.example.com/hooks/deploy-notify-v2 and /webhooks/build_status'),
    'curl https://ci.example.com/hooks/deploy-notify-v2 and /webhooks/build_status');
  assert.equal(r('https://x.test/geo?country&code=US&page=2'), 'https://x.test/geo?country&code=US&page=2');
  assert.equal(r('authorization: required for all write requests'), 'authorization: required for all write requests');
  assert.equal(r('docker run -u 1000:1000 img; date -u +%H:%M; date -u "+%F %H:%M"'),
    'docker run -u 1000:1000 img; date -u +%H:%M; date -u "+%F %H:%M"');
});

test('-u with a numeric user: only an all-digit pair (uid:gid) stays', () => {
  assert.equal(r('curl -u 1000:hunter2 https://x'), 'curl -u 1000:[secret] https://x');
  assert.equal(r('curl --user=42:s3cret-pass https://x'), 'curl --user=42:[secret] https://x');
  // Accepted gap: a numeric account with a numeric PIN reads like uid:gid.
  assert.equal(r('curl -u 12345:987654 https://x'), 'curl -u 12345:987654 https://x');
});

test('Authorization with an unknown scheme: the value goes when it looks like a credential', () => {
  assert.equal(r('Authorization: Custom hunter2pass'), 'Authorization: Custom [secret]');
  assert.equal(r('Authorization: SSWS 00abcDEF'), 'Authorization: SSWS [secret]');
  assert.equal(r('Authorization: Klaviyo-API-Key pk_abcdefghij'), 'Authorization: Klaviyo-API-Key [secret]');
});

test('more command-line credentials: registry logins, smbclient, lftp, ldap, zip, 7z, openssl, aws configure', () => {
  assert.equal(r('docker login -u me -p hunter2 reg.example.com'), 'docker login -u me -p [secret] reg.example.com');
  assert.equal(r('podman login -p=hunter2 r; nerdctl login -phunter2 r; helm registry login -p h1 r'),
    'podman login -p=[secret] r; nerdctl login -p[secret] r; helm registry login -p [secret] r');
  assert.equal(r('docker run -p 8080:80 img'), 'docker run -p 8080:80 img', 'not a login');
  assert.equal(r('echo $PW | docker login --password-stdin -u me r'), 'echo $PW | docker login --password-stdin -u me r');
  assert.equal(r("smbclient //h/s -U bob%hunter2 -c ls; smbclient //h/s -U 'DOM\\bob%two words'"),
    "smbclient //h/s -U bob%[secret] -c ls; smbclient //h/s -U 'DOM\\bob%[secret]'");
  assert.equal(r('lftp -u bob,hunter2 sftp://h -e "mirror"'), 'lftp -u bob,[secret] sftp://h -e "mirror"');
  assert.equal(r('ldapsearch -x -D cn=admin -w hunter2 -b dc=x; ldapadd -whunter2 -f a.ldif; ldapsearch -W'),
    'ldapsearch -x -D cn=admin -w [secret] -b dc=x; ldapadd -w[secret] -f a.ldif; ldapsearch -W');
  assert.equal(r('zip -P hunter2 -r a.zip x; 7z a -phunter2 a.7z x; 7za x -p a.7z'), 'zip -P [secret] -r a.zip x; 7z a -p[secret] a.7z x; 7za x -p a.7z');
  assert.equal(r('openssl enc -aes-256-cbc -k hunter2 -in x; openssl rsa -passin pass:hunter2 -passout env:PW'),
    'openssl enc -aes-256-cbc -k [secret] -in x; openssl rsa -passin pass:[secret] -passout env:PW');
  assert.equal(r('aws configure set aws_secret_access_key abc/DEF+ghi --profile p && aws configure set region us-east-1'),
    'aws configure set aws_secret_access_key [secret] --profile p && aws configure set region us-east-1');
  assert.equal(r('aws configure set --profile p aws_session_token "x y"'), 'aws configure set --profile p aws_session_token "[secret]"');
});

test('quoted values with spaces go whole', () => {
  assert.equal(r('mysql -u root -p"two words" db'), 'mysql -u root -p"[secret]" db');
  assert.equal(r("redis-cli -a 'a b c' ping; sshpass -p \"c d\" ssh h"), "redis-cli -a '[secret]' ping; sshpass -p \"[secret]\" ssh h");
  assert.equal(r('tool --password "two words" --token \'x y\' --name "a b"'), 'tool --password "[secret]" --token \'[secret]\' --name "a b"');
  assert.equal(r('curl -u "admin:two words" https://x'), 'curl -u "admin:[secret]" https://x');
  assert.equal(r('tool --password "unclosed value\nnext line'), 'tool --password "[secret]"\nnext line', 'an unclosed quote runs to the line end');
  assert.equal(r('secret: "a b\nok'), 'secret: "[secret]"\nok');
  assert.equal(r("redis-cli -a 'a b\nok"), "redis-cli -a '[secret]'\nok");
  assert.equal(r('tool --password ""'), 'tool --password ""');
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

test('redactTruncate on a huge input redacts only the field plus a margin, never showing the cut line', () => {
  const max = 100;
  const huge = 'wm-'.repeat(400_000); // 1.2 MB, one line
  let started = process.hrtime.bigint();
  assert.equal(redactTruncate(huge, max, { home: HOME }), '…', 'one line longer than the cap: nothing safe to show');
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500);
  const lines = `${'wm-'.repeat(30)}\n`.repeat(12_000); // 1.1 MB, short lines
  started = process.hrtime.bigint();
  const out = redactTruncate(lines, max, { home: HOME });
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200);
  assert.equal(out, truncateChars(lines, max));
  // A PEM block swallows line breaks, so the margin grows until the text
  // after it is whole.
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(max + REDACT_MARGIN_CHARS - 100)}\n-----END RSA PRIVATE KEY-----`;
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def-ghi';
  assert.equal(redactTruncate(`${pem} x ${jwt} tail`, max, { home: HOME }), '[secret] x [secret] tail');
});

test('redactTruncate: text shrinking before a quoted value cut in half never leaks it (review repro)', () => {
  const ids = Array.from({ length: 80 }, (_, i) => `oc_${String(i).padStart(4, '0')}${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4'}`).join(' ');
  const secret = ' smtp_password="correct horse battery staple"';
  for (const tail of [` and then ${'more words '.repeat(400)}`, `\n${'next line\n'.repeat(400)}`, `\n${'x '.repeat(30_000)}`]) {
    const text = `${ids}${secret}${tail}`;
    const at = ids.length;
    let checked = 0;
    for (let k = -10; k < secret.length + 10; k += 1) {
      const max = at + k - REDACT_MARGIN_CHARS; // the first margin's cut falls around the value
      const out = redactTruncate(text, max, { home: HOME });
      assert.doesNotMatch(out, /correct|horse|battery|staple/, `cut at ${k}: ${out.slice(-80)}`);
      assert.equal(out, truncateChars(redactText(text, { home: HOME }), max), `cut at ${k}`);
      checked += 1;
    }
    assert.ok(checked > 40);
  }
});

test('redactTruncate at the margin cap drops the cut line', () => {
  const max = 100;
  const shrink = 'oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 '.repeat(2_000); // 72 KB → 10 KB, one line
  const text = `first line\n${shrink}pw="correct horse battery staple" ${'z '.repeat(40_000)}`;
  assert.equal(redactTruncate(text, max, { home: HOME }), 'first line\n…');
  assert.equal(redactTruncate(`${shrink}pw="correct horse battery staple" ${'z '.repeat(40_000)}`, max, { home: HOME }), '…');
});

test('redactTruncate equals truncate(redactText) on mixed multi-line input', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pool = [
    'oc_655daebb99f5c62bae0121979c8f152d', 'smtp_password="correct horse battery staple"', 'Bearer abcdef123456',
    'curl -u admin:hunter2pass', 'mysql -p"two words" db', 'token: abc123', 'ops@corp.example.com', '/home/alice/x',
    'redis-cli -a "a b"', '019f6a84-3a1e-76dd-931d-0eea1cb3112a', 'word', 'other', '中文说明', '😀', 'x', '[x]', 'sk-proj-abcdefghijklmnop1234',
  ];
  for (let i = 0; i < 120; i += 1) {
    const parts = [];
    const size = 1_500 + rand(9_000);
    let len = 0;
    while (len < size) {
      const p = pool[rand(pool.length)];
      parts.push(p, rand(6) === 0 ? '\n' : ' ');
      len += p.length + 1;
    }
    const text = parts.join('');
    const max = 10 + rand(2_000);
    assert.equal(redactTruncate(text, max, { home: HOME }), truncateChars(redactText(text, { home: HOME }), max), `case ${i}, max ${max}`);
  }
});

test('redactTruncate caches by input, field limit and home', () => {
  // 300 KB of short lines with a field limit near the whole text: one
  // redaction costs ~100 ms here, a cached answer only the hash.
  const text = 'token=abc123 /home/alice/x\n'.repeat(12_000);
  const max = 290_000;
  const first = redactTruncate(text, max, { home: HOME });
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) assert.equal(redactTruncate(text, max, { home: HOME }), first);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 400, `20 cached calls took ${ms} ms`);
  assert.equal(first, truncateChars(redactText(text, { home: HOME }), max));
  const short = 'token=abc123 /home/alice/x\n'.repeat(4_000);
  assert.notEqual(redactTruncate(short, 40, { home: HOME }), redactTruncate(short, 50, { home: HOME }));
  assert.equal(redactTruncate('/home/bob/x', 50, { home: '/home/bob' }), '~/x');
  assert.equal(redactTruncate('/srv/a/x', 50, { home: '/srv/a' }), '~/x');
  assert.equal(redactTruncate('/srv/a/x', 50, { home: '/srv/b' }), '/srv/a/x');
});

test('review shapes stay linear: wm-, eyJ-, cid+, cid/ and the new credential rules at 100 KB', () => {
  const shapes = ['wm-', 'eyJ-', 'cid+', 'cid/', 'wr_', 'Authorization: ', 'x-authorization: Token ', ' -u ', ' -ux:', '?key=',
    '/hook/', '/webhooks/1', 'mysql -p', '|mysql -pa', 'redis-cli -a ', 'sshpass -p ', ' --pass ', 'a@', 'a@b.', 'a.b@', 'hooks.slack.com/services/',
    'docker login -p ', 'docker ', ' login -p"', 'smbclient -U a%', ' -U a', 'lftp -u a,', 'ldapsearch -w ', 'zip -P ', '7z -p', 'openssl -k ',
    ' -passin pass:', 'aws configure set a_secret ', 'aws configure set ', ' --password "', " --token '", ' -u "a:', ' -u +%H:', 'x_pass=',
    'a.pw: ', 'pass', 'a@b.c:', 'a@b.cd.', '/hooks/a1', 'Authorization: x ', 'secret: "', '"', "'"];
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

test('createLru evicts the least recently used entry, and a hit refreshes it', () => {
  const lru = createLru({ maxEntries: 3, maxUnits: 1000 });
  lru.set('a', '1');
  lru.set('b', '2');
  lru.set('c', '3');
  assert.equal(lru.get('a'), '1'); // a is now the newest
  lru.set('d', '4'); // evicts b, the least recently used
  assert.equal(lru.size, 3);
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.get('a'), '1');
  assert.equal(lru.get('c'), '3');
  assert.equal(lru.get('d'), '4');
  lru.set('c', '33'); // overwrite keeps one entry
  assert.equal(lru.size, 3);
  assert.equal(lru.get('c'), '33');
  lru.set('n', null); // null results are cached too
  assert.equal(lru.get('n'), null);
});

test('createLru is bounded by stored units (keys + values) as well', () => {
  const lru = createLru({ maxEntries: 100, maxUnits: 20 });
  lru.set('k1', 'x'.repeat(8)); // 10 units
  lru.set('k2', 'y'.repeat(8)); // 20 units
  assert.equal(lru.units, 20);
  lru.set('k3', 'z'.repeat(3)); // 25 > 20: k1 goes
  assert.equal(lru.get('k1'), undefined);
  assert.equal(lru.units, 15);
  lru.set('big', 'w'.repeat(30)); // larger than the whole budget: not stored, nothing evicted
  assert.equal(lru.get('big'), undefined);
  assert.equal(lru.get('k2'), 'y'.repeat(8));
  assert.equal(lru.get('k3'), 'zzz');
  assert.equal(lru.units, 15);
});

test('the redactTruncate cache stays within its entry and unit limits', () => {
  for (let i = 0; i < CACHE_MAX_ENTRIES + 50; i += 1) redactTruncate(`task ${i} token=abc${i}`, 80, { home: HOME });
  assert.equal(redactCacheStats().entries, CACHE_MAX_ENTRIES);
  const long = (i) => `${i} `.padEnd(8000, 'lorem ipsum ');
  const fit = Math.floor(CACHE_MAX_UNITS / 8000);
  for (let i = 0; i < fit + 20; i += 1) redactTruncate(long(i), 8000, { home: HOME });
  const { entries, units } = redactCacheStats();
  assert.ok(units <= CACHE_MAX_UNITS, `units ${units}`);
  assert.ok(entries < fit + 20, `entries ${entries}`);
  // the newest long text is still cached; the oldest was evicted
  const started = process.hrtime.bigint();
  assert.equal(redactTruncate(long(fit + 19), 8000, { home: HOME }), long(fit + 19));
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 50);
});
