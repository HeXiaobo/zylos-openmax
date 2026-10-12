import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './redact.js';

test('webhook creation credentials are redacted from nested RPC responses', () => {
  const response = { data: { binding: { id: 'binding' }, webhook_url: 'https://example.test/workspace/webhook/secret' } };
  assert.deepEqual(redactSecrets(response), {
    data: { binding: { id: 'binding' }, webhook_url: '[REDACTED]' },
  });
  assert.equal(response.data.webhook_url, 'https://example.test/workspace/webhook/secret');
});

test('redacts known sensitive keys at the top level', () => {
  const out = redactSecrets({ access_token: 'eyJabc', org_id: 'o1' });
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.org_id, 'o1');
});

test('redacts nested tokens but leaves *_expires_at timestamps intact (needed for debugging expiry)', () => {
  const out = redactSecrets({ data: { refresh_token: 'r1', access_token_expires_at: 123 } });
  assert.equal(out.data.refresh_token, '[REDACTED]');
  assert.equal(out.data.access_token_expires_at, 123);
});

test('redacts api_key, client_secret, password, ticket variants', () => {
  const out = redactSecrets({
    api_key: 'k1', apiKey: 'k2', client_secret: 's1',
    password: 'p1', ticket: 't1',
  });
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.client_secret, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.ticket, '[REDACTED]');
});

test('redacts generic "token" plus business-CLI-specific token/secret fields (core.invitation_accept, as.js upload_token, WAB verify_token/app_secret)', () => {
  const out = redactSecrets({
    token: 'invite-secret', upload_token: 'u1', verify_token: 'v1', app_secret: 'a1',
  });
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.upload_token, '[REDACTED]');
  assert.equal(out.verify_token, '[REDACTED]');
  assert.equal(out.app_secret, '[REDACTED]');
});

test('does not false-positive on field names that merely contain "secret" or "token" as a substring', () => {
  const out = redactSecrets({ not_a_secret: 'v1', token_type: 'Bearer', device_id: 'd1' });
  assert.equal(out.not_a_secret, 'v1');
  assert.equal(out.token_type, 'Bearer');
  assert.equal(out.device_id, 'd1');
});

test('redacts inside arrays', () => {
  const out = redactSecrets([{ access_token: 'a' }, { org_id: 'o' }]);
  assert.equal(out[0].access_token, '[REDACTED]');
  assert.equal(out[1].org_id, 'o');
});

test('passes through primitives and strings unchanged', () => {
  assert.equal(redactSecrets('hello'), 'hello');
  assert.equal(redactSecrets(42), 42);
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test('does not false-positive on ordinary field names', () => {
  const out = redactSecrets({ org_id: 'o1', member_id: 'm1', name: 'n1' });
  assert.deepEqual(out, { org_id: 'o1', member_id: 'm1', name: 'n1' });
});

// ── redactText (agent activity commentary) ─────────────────────────────────
import { redactText, redactTextDetailed } from './redact.js';

const H = '[已隐藏]';

test('redactText: each pattern, positive and negative', () => {
  const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactText(`key:\n${pk}\nok`), `key:\n${H}\nok`);
  assert.equal(redactText('sk-proj-abcdefghijklmnopqrst'), H);
  assert.equal(redactText('ghp_abcdefghijklmnopqrstuvwxyz'), H);
  assert.equal(redactText('AKIAABCDEFGHIJKLMNOP'), H);
  assert.equal(redactText('eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl'), H);
  assert.equal(redactText('Authorization: Bearer abc.def'), `Authorization: ${H}`);
  assert.equal(redactText('use Basic dXNlcjpwYXNz'), `use Basic ${H}`);
  assert.equal(redactText('https://user:pw@example.com/x'), `https://${H}@example.com/x`);
  assert.equal(redactText('{"password": "hunter2", "a": 1}'), `{"password": "${H}", "a": 1}`);
  assert.equal(redactText('API_KEY=abc123'), `API_KEY=${H}`);
  assert.equal(redactText('GET /x?token=abc&page=2'), `GET /x?token=${H}&page=2`);
  assert.equal(redactText('cli --api-key abc123 --verbose'), `cli --api-key ${H} --verbose`);
  assert.equal(redactText('Cookie: a=b; c=d'), `Cookie: ${H}`);
  assert.equal(redactText('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), '[编码内容已省略]');
  assert.equal(redactText(`blob ${'A'.repeat(300)}`), 'blob [编码内容已省略]');
  // Negatives: ordinary prose / code is untouched.
  assert.equal(redactText('the token expires soon; check access_token_expires_at'), 'the token expires soon; check access_token_expires_at');
  assert.equal(redactText('git push --force origin main'), 'git push --force origin main');
  assert.equal(redactText(`short ${'A'.repeat(100)}`), `short ${'A'.repeat(100)}`);
});

test('redactText: Chinese text is not damaged', () => {
  const s = '文档里的阶梯价和脚本输出对不上，我再看一下最新的计费配置。';
  assert.equal(redactText(s), s);
});

test('删除控制字符与不可见字符: removed first, so a split JWT / base64 is still caught', () => {
  assert.equal(redactText('eyJhbGciOi\u0007JI.eyJzdWIiOiIx.c2lnbmF0dXJl'), H);
  assert.equal(redactText('eyJhb\u200BGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl'), H);
  assert.equal(redactText(`x ${'A'.repeat(150)}\uFEFF${'A'.repeat(150)}`), 'x [编码内容已省略]');
  assert.equal(redactText('a\u2028b\u2029c\u00ADd\u0085e'), 'abcde');
});

test('删除控制字符与不可见字符: \\n and \\t are kept; multi-line private keys still match', () => {
  assert.equal(redactText('a\n\tb'), 'a\n\tb');
  assert.equal(redactText('-----BEGIN PRIVATE KEY-----\n\u0001abc\n-----END PRIVATE KEY-----'), H);
});

test('redactText: 2000 code-point cap → 1998 + …, counted after control removal', () => {
  const r = redactTextDetailed('字'.repeat(2001));
  assert.equal(r.truncated, true);
  assert.equal(Array.from(r.text).length, 1999);
  assert.ok(r.text.endsWith('…'));
  const exact = redactTextDetailed(`${'字'.repeat(1000)}${'\u0001'.repeat(50)}${'字'.repeat(1000)}`);
  assert.equal(exact.truncated, false, 'control characters do not count toward the cap');
  assert.equal(Array.from(exact.text).length, 2000);
  assert.equal(redactTextDetailed('short').truncated, false);
});
