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
  for (const pre of ['timeout 30 node', 'nice -n 5 node', 'command node', 'node -r dotenv/config', 'FOO=1 BAR="x y" /opt/node/bin/node']) {
    assert.deepEqual(scanShellSends(`${pre} src/cli/comm.js comm.send '{"conversationId":"${B}"}'`).commSends, [{ command: 'comm.send', conversationId: B }], pre);
  }
  assert.deepEqual(scanShellSends(`node -e "process.argv" src/cli/comm.js comm.send '{}'`).commSends, [{ command: null, conversationId: null }], 'inline code: unprovable');
  assert.equal(scanShellSends('sed -n 1,40p src/cli/comm.js').commSends.length, 0);
});

test('argvToScript: sh -c script as is; other argv shell-quoted', () => {
  assert.equal(argvToScript(['bash', '-lc', 'node x.js a']), 'node x.js a');
  assert.equal(argvToScript(['node', 'x.js', 'a b', "it's"]), `node x.js 'a b' 'it'\\''s'`);
});
