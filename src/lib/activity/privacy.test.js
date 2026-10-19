import assert from 'node:assert/strict';
import test from 'node:test';
import { redactDisplay, redactUrl, siteOf, isEmptyAfterRedaction, REDACTED as R, ENCODED } from './privacy.js';

// Decision D3 (#137 v4): ONLY secret-type content is filtered.

test('kept as-is: search terms, domains, titles, file / attachment names, paths, e-mails, task names, hashes', () => {
  for (const s of [
    '中国七大地理分区 划分标准',
    'www.example.gov.cn',
    '销售地区汇总.md',
    '/home/alice/客户/报价单.xlsx',
    'bob.smith+ops@corp.example.com',
    '核对三个地区的数据口径',
    'git commit 3f5c9d2e1b4a3f5c9d2e1b4c73f5c9d2e1b4a3f5',
    'max_tokens=100 token_count: 5 password_hint_shown=true',
    'auth: required, secret: true',
    'git@github.com:org/repo.git',
    'Check internationalization settings',
  ]) assert.equal(redactDisplay(s), s, s);
});

test('API keys / tokens by shape', () => {
  for (const s of [
    'sk-abcdefghijklmnop1234', 'sk-proj-abcdefghijklmnopqrst', 'sk-ant-api03-abcdefghijklmnopqrstu',
    'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0123456789abcd', 'glpat-abcdefghij0123456789',
    'xoxb-1234567890-abcdefghij', 'AKIAIOSFODNN7EXAMPLE', 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'cwsk_9f8e7d6c5b4a', 'hf_abcdefghijklmnopqrstuvwxyz', 'npm_abcdefghijklmnopqrstuvwxyz0123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z', 'f'.repeat(16) + '0123456789abcdef'.repeat(3),
  ]) assert.equal(redactDisplay(`x ${s} y`), `x ${R} y`, s);
});

test('passwords / bearer / basic / cookies / headers / CLI flags', () => {
  const cases = [
    ['Authorization: Bearer abc.def.ghi123', `Authorization: ${R}`],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz"', `curl -H "Authorization: ${R}"`],
    ['use Bearer abcdef123456 here', `use Bearer ${R} here`],
    ['Cookie: sid=abc; theme=dark', `Cookie: ${R}`],
    ['Set-Cookie: session=xyz', `Set-Cookie: ${R}`],
    ['X-Api-Key: 12345abcde', `X-Api-Key: ${R}`],
    ['mysql --password hunter2 -u root', `mysql --password ${R} -u root`],
    ['login --token=abcdef', `login --token=${R}`],
    ['{"password": "p@ss w0rd", "user": "bob"}', `{"password": "${R}", "user": "bob"}`],
    ["client_secret: 'abcdef'", `client_secret: '${R}'`],
    ['refreshToken=abcdef123', `refreshToken=${R}`],
  ];
  for (const [input, want] of cases) assert.equal(redactDisplay(input), want, input);
});

test('.env lines and connection strings', () => {
  const env = 'NODE_ENV=production\nOPENAI_API_KEY=sk-live-abcdefghijklmnop\nDB_PASSWORD=hunter22\nPORT=3000\nSTRIPE_SECRET=whsec_123abc\nSESSION_ID=abc123';
  assert.equal(redactDisplay(env), `NODE_ENV=production\nOPENAI_API_KEY=${R}\nDB_PASSWORD=${R}\nPORT=3000\nSTRIPE_SECRET=${R}\nSESSION_ID=${R}`);
  assert.equal(redactDisplay('postgres://admin:s3cret@db.local:5432/app'), `postgres://${R}@db.local:5432/app`);
  assert.equal(redactDisplay('mongodb+srv://u:p@cluster0.example.net/db'), `mongodb+srv://${R}@cluster0.example.net/db`);
  assert.equal(redactDisplay('Server=db;User Id=sa;Password=Pa55word;'), `Server=db;User Id=sa;Password=${R};`);
  assert.equal(redactDisplay('DATABASE_DSN=postgres://a:b@h/d'), `DATABASE_DSN=${R}`);
});

test('private keys (also unterminated) and encoded blobs', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactDisplay(`a\n${pem}\nb`), `a\n${R}\nb`);
  assert.equal(redactDisplay('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\nmore'), R);
  assert.equal(redactDisplay(`img data:image/png;base64,${'A'.repeat(300)}`), `img ${ENCODED}`);
});

test('URLs in text: userinfo and secret query values redacted, the rest kept', () => {
  assert.equal(redactDisplay('see https://a.com/x?token=abc&q=1'), `see https://a.com/x?token=${R}&q=1`);
  assert.equal(redactDisplay('https://s3.example.com/f?X-Amz-Signature=abc123def&X-Amz-Date=1'), `https://s3.example.com/f?X-Amz-Signature=${R}&X-Amz-Date=1`);
});

test('redactUrl: http(s) only; userinfo and credential params / fragments dropped; host as site; decoded for display', () => {
  assert.deepEqual(redactUrl('https://u:p@example.com/a?q=1&token=abc&X-Amz-Signature=zz#access_token=1'), { url: 'https://example.com/a?q=1', site: 'example.com' });
  assert.deepEqual(redactUrl('https://www.example.gov.cn/item/七大?from=x#sec'), { url: 'https://www.example.gov.cn/item/七大?from=x#sec', site: 'www.example.gov.cn' });
  assert.deepEqual(redactUrl('https://maps.example.com/api?key=AIzaXYZ&lang=zh'), { url: 'https://maps.example.com/api?lang=zh', site: 'maps.example.com' });
  assert.equal(redactUrl('ftp://x.com/a'), undefined);
  assert.equal(redactUrl('javascript:alert(1)'), undefined);
  assert.equal(redactUrl('not a url'), undefined);
  assert.equal(siteOf('https://docs.example.com:8443/p'), 'docs.example.com');
});

test('invisible / control characters are removed before matching (cannot split a token)', () => {
  assert.equal(redactDisplay('sk-abc\u200bdefghijklmnopqrst'), R);
  assert.equal(redactDisplay('a\u0000b\u2028c\td\ne'), 'abc\td\ne');
  assert.equal(isEmptyAfterRedaction(`${R} — ${R}`), true);
  assert.equal(isEmptyAfterRedaction(`${R} ok`), false);
});
