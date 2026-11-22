import assert from 'node:assert/strict';
import test from 'node:test';
import { readWord, splitCommands, scanShellSends, argvToScript } from './shell-scan.js';

test('readWord: quoting, escapes, and expansions are unknown', () => {
  assert.equal(readWord(`'a b'c`, 0).value, 'a bc');
  assert.equal(readWord(`"x \\"y\\" \\$z"`, 0).value, 'x "y" $z');
  assert.equal(readWord('"$HOME/x"', 0).value, null);
  assert.equal(readWord('$(cat f)', 0).value, null);
  assert.equal(readWord('$(cat f) next', 0).end, 8);
  assert.equal(readWord('`x`', 0).value, null);
  assert.equal(readWord(`"$(cat <<'EOF'\n{"a":1}\nEOF\n)"`, 0).value, '{"a":1}');
});

test('splitCommands: operators, newlines, heredoc bodies cut out, comments skipped', () => {
  const cmds = splitCommands(`a 1 && b 2 | c; d <<'EOF'\nnot a command\nEOF\n# e f\ng`);
  assert.deepEqual(cmds.map((c) => c.words.map((w) => w.value).join(' ')), ['a 1', 'b 2', 'c', 'd', 'g']);
  assert.equal(cmds[3].heredocs.length, 1);
});

test('scanShellSends: env / exec / timeout prefixes; node options; unknown runner', () => {
  const B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
  for (const pre of ['timeout 30 node', 'nice -n 5 node', 'command node', 'FOO=1 BAR="x y" /opt/node/bin/node']) {
    assert.deepEqual(scanShellSends(`${pre} src/cli/comm.js comm.send '{"conversationId":"${B}"}'`).commSends, [{ command: 'comm.send', conversationId: B }], pre);
  }
  // A preload / env wrapper may run other code first: unprovable.
  for (const pre of ['node -r dotenv/config', 'env FOO=1 node', 'NODE_OPTIONS=-r node']) {
    assert.deepEqual(scanShellSends(`${pre} src/cli/comm.js comm.send '{"conversationId":"${B}"}'`).commSends, [{ command: null, conversationId: null }], pre);
  }
  assert.deepEqual(scanShellSends(`node -e "process.argv" src/cli/comm.js comm.send '{}'`).commSends, [{ command: null, conversationId: null }], 'inline code: unprovable');
  assert.equal(scanShellSends('sed -n 1,40p src/cli/comm.js').commSends.length, 0);
});

test('scanShellSends: a literal noRun send is not a reply send', () => {
  const B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
  for (const verb of ['comm.send', 'comm.send_card', 'comm.ask_card', 'comm.ask']) {
    assert.deepEqual(scanShellSends(`node src/cli/comm.js ${verb} '{"conversationId":"${B}","noRun":true}'`).commSends, [], verb);
  }
  assert.deepEqual(scanShellSends(`node src/cli/comm.js comm.send '{"conversationId":"${B}","noRun":false}'`).commSends, [{ command: 'comm.send', conversationId: B }]);
  assert.deepEqual(scanShellSends(`node src/cli/comm.js comm.send '{"conversationId":"${B}","noRun":"true"}'`).commSends, [{ command: 'comm.send', conversationId: B }]);
  // Only the top level counts: a noRun inside the content is text.
  assert.deepEqual(scanShellSends(`node src/cli/comm.js comm.send '{"conversationId":"${B}","content":{"noRun":true}}'`).commSends, [{ command: 'comm.send', conversationId: B }]);
  // Not provable from a computed argument: unchanged.
  assert.deepEqual(scanShellSends('node src/cli/comm.js comm.send "$(cat /tmp/p.json)"').commSends, [{ command: 'comm.send', conversationId: null }]);
});

test('1337: scanShellSends carries a literal top-level sourceMessageId (digits) of a comm CLI reply', () => {
  const B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
  const S = '7300000000000000132';
  for (const verb of ['comm.send', 'comm.send_card', 'comm.ask_card', 'comm.ask']) {
    assert.deepEqual(scanShellSends(`node src/cli/comm.js ${verb} '{"conversationId":"${B}","sourceMessageId":"${S}"}'`).commSends,
      [{ command: verb, conversationId: B, sourceMessageId: S }], verb);
  }
  // Not the CLI's accepted form, nested, or with no provable destination: no source.
  for (const arg of [`"sourceMessageId":7300000000000000132`, `"sourceMessageId":"abc"`, `"content":{"sourceMessageId":"${S}"}`]) {
    assert.deepEqual(scanShellSends(`node src/cli/comm.js comm.send '{"conversationId":"${B}",${arg}}'`).commSends,
      [{ command: 'comm.send', conversationId: B }], arg);
  }
  assert.deepEqual(scanShellSends(`node src/cli/comm.js comm.send '{"sourceMessageId":"${S}"}'`).commSends,
    [{ command: 'comm.send', conversationId: null }]);
});

test('argvToScript: sh -c script as is; other argv shell-quoted', () => {
  assert.equal(argvToScript(['bash', '-lc', 'node x.js a']), 'node x.js a');
  assert.equal(argvToScript(['node', 'x.js', 'a b', "it's"]), `node x.js 'a b' 'it'\\''s'`);
});
