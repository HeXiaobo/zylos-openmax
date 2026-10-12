import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTool, programName } from './classify.js';
import { CATEGORIES } from './constants.js';

test('maps tools onto all 11 categories', () => {
  const cases = [
    ['Bash', { command: 'git status' }, 'command'],
    ['Read', { file_path: '/a/b.md' }, 'read'],
    ['Write', { file_path: '/a' }, 'write'],
    ['Grep', { pattern: 'x' }, 'search'],
    ['WebFetch', { url: 'https://x' }, 'web'],
    ['Read', { file_path: '/a/b.PNG' }, 'image'],
    ['Agent', { prompt: 'p' }, 'delegate'],
    ['TaskOutput', {}, 'waiting'],
    ['TodoWrite', {}, 'tool'],
    ['Bash', { command: 'node ~/zylos/.claude/skills/openmax-kb/scripts/q.js x' }, 'kb'],
    ['Bash', { command: 'node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "conv" <<EOF' }, 'reply'],
  ];
  const seen = new Set();
  for (const [name, input, want] of cases) {
    const c = classifyTool(name, input);
    assert.equal(c.category, want, `${name} ${JSON.stringify(input)}`);
    seen.add(c.category);
  }
  assert.deepEqual([...seen].sort(), [...CATEGORIES].sort());
});

test('Codex tool names', () => {
  assert.equal(classifyTool('exec_command', { cmd: 'rg foo' }).category, 'command');
  assert.equal(classifyTool('exec_command', { cmd: 'rg foo' }).detail, 'rg');
  assert.equal(classifyTool('shell', { command: ['bash', '-lc', 'ls'] }).detail, 'bash');
  assert.equal(classifyTool('apply_patch', 'patch').category, 'write');
  assert.equal(classifyTool('view_image', { path: '/x' }).category, 'image');
  assert.equal(classifyTool('web_search_call', {}).category, 'web');
  assert.equal(classifyTool('write_stdin', {}).category, 'waiting');
  assert.equal(classifyTool('write_stdin', {}).tool, undefined);
});

test('Skill openmax-kb is kb; other skills are tool with the public name', () => {
  assert.deepEqual(classifyTool('Skill', { skill: 'openmax-kb' }), { category: 'kb', tool: 'Skill', signals: {} });
  assert.deepEqual(classifyTool('Skill', { skill: 'other' }), { category: 'tool', tool: 'Skill', signals: {} });
});

test('detail only for allowlisted first words; mcp tools carry no tool name', () => {
  assert.equal(programName('/usr/bin/python3 x.py'), 'python3');
  assert.equal(programName('"node" a.js'), 'node');
  assert.equal(programName('cd /x && node a.js'), undefined);
  assert.equal(programName('FOO=1 node a.js'), undefined);
  assert.equal(programName('rm -rf /'), undefined);
  const c = classifyTool('Bash', { command: 'docker ps' });
  assert.equal(c.detail, undefined);
  assert.equal(c.tool, 'Bash');
  const m = classifyTool('mcp__secret__tool', { q: 'x' });
  assert.deepEqual(m, { category: 'tool', signals: {} });
});

test('focus signal ①: reading a C4 spill file (Read path or Bash command)', () => {
  assert.deepEqual(classifyTool('Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-123/message.txt' }).signals.spillC4Ids, ['123']);
  assert.deepEqual(classifyTool('Bash', { command: 'cat /h/zylos/comm-bridge/attachments/conv-9/message.txt' }).signals.spillC4Ids, ['9']);
  assert.equal(classifyTool('Read', { file_path: '/h/zylos/notes.txt' }).signals.spillC4Ids, undefined);
});

test('focus signals ② / ③: c4-send channel and endpoint', () => {
  const r = classifyTool('Bash', { command: 'node /x/c4-send.js "openmax" "019f|reply:1" <<\'EOF\'\nhi\nEOF' });
  assert.deepEqual(r.signals.replies, [{ channel: 'openmax', endpoint: '019f|reply:1' }]);
  assert.equal(r.signals.external, undefined);
  assert.equal(r.category, 'reply');
  const lark = classifyTool('Bash', { command: 'node /x/c4-send.js lark oc_1 "hi"' });
  assert.equal(lark.signals.external, true);
  assert.equal(lark.signals.replies, undefined);
  assert.equal(lark.category, 'command');
  assert.deepEqual(classifyTool('Bash', { command: 'echo hi' }).signals, {});
  // A Bash description is not executed and is not scanned.
  assert.deepEqual(classifyTool('Bash', { command: 'ls', description: 'later run c4-send.js lark' }).signals, {});
});

// Compound commands: every send counts; an external one wins in either order,
// for all four shell-like tool names.
for (const name of ['Bash', 'exec_command', 'shell', 'local_shell']) {
  const wrap = (cmd) => (name === 'Bash' ? { command: cmd } : name === 'exec_command' ? { cmd } : { command: ['bash', '-lc', cmd] });
  test(`${name}: openmax + telegram sends in one command, both orders → replies + external`, () => {
    const om = 'node /x/c4-send.js "openmax" "conv-a" "done"';
    const tg = 'node /x/c4-send.js "telegram" "123" "done"';
    for (const cmd of [`${om} && ${tg}`, `${tg}; ${om}`]) {
      const r = classifyTool(name, wrap(cmd));
      assert.deepEqual(r.signals.replies, [{ channel: 'openmax', endpoint: 'conv-a' }], cmd);
      assert.equal(r.signals.external, true, cmd);
    }
    const two = classifyTool(name, wrap(`${om} && node /x/c4-send.js openmax conv-b "x"`));
    assert.equal(two.signals.replies.length, 2);
    assert.equal(two.signals.external, undefined);
  });
}

test('an unparsable c4-send counts as external (pause when in doubt)', () => {
  assert.equal(classifyTool('Bash', { command: 'node /x/c4-send.js $CH "$EP"' }).signals.external, true);
  assert.equal(classifyTool('Bash', { command: 'node /x/c4-send.js' }).signals.external, true);
});

// Codex `exec` wrapper: its input is code that calls other tools. It is never
// evaluated; every string in it is scanned as text (escaped quotes undone).
// No local Codex rollout exists on this host (~/.codex has no sessions), so
// these payloads model the wrapper format: a raw code string, and the same in
// a JSON argument object.
const WRAPPER_CODE = (cmd) => `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\nconsole.log(r.output);`;
test('exec wrapper: inner sends and spill reads are found in raw code or JSON payloads', () => {
  const ext = classifyTool('exec', WRAPPER_CODE('node /x/c4-send.js "lark" "oc_1" "hi"'));
  assert.equal(ext.signals.external, true);
  assert.equal(ext.category, 'command');
  assert.equal(ext.tool, undefined, 'exec is not a public tool name');
  const json = classifyTool('exec', { code: WRAPPER_CODE('node /x/c4-send.js "openmax" "conv-a" ok') });
  assert.deepEqual(json.signals.replies, [{ channel: 'openmax', endpoint: 'conv-a' }]);
  assert.equal(json.category, 'reply');
  const spill = classifyTool('exec', WRAPPER_CODE('cat /h/zylos/comm-bridge/attachments/conv-41/message.txt'));
  assert.deepEqual(spill.signals.spillC4Ids, ['41']);
  assert.equal(spill.signals.external, undefined);
  assert.equal(classifyTool('exec', undefined).signals.external, true, 'nothing inspectable → pause');
  assert.deepEqual(classifyTool('exec', WRAPPER_CODE('git status')).signals, {});
});
