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
  assert.equal(classifyTool('Read', { file_path: '/h/zylos/comm-bridge/attachments/conv-123/message.txt' }).signals.spillC4Id, '123');
  assert.equal(classifyTool('Bash', { command: 'cat /h/zylos/comm-bridge/attachments/conv-9/message.txt' }).signals.spillC4Id, '9');
  assert.equal(classifyTool('Read', { file_path: '/h/zylos/notes.txt' }).signals.spillC4Id, undefined);
});

test('focus signals ② / ③: c4-send channel and endpoint', () => {
  const r = classifyTool('Bash', { command: 'node /x/c4-send.js "openmax" "019f|reply:1" <<\'EOF\'\nhi\nEOF' });
  assert.deepEqual(r.signals.reply, { channel: 'openmax', endpoint: '019f|reply:1' });
  assert.equal(r.category, 'reply');
  const lark = classifyTool('Bash', { command: 'node /x/c4-send.js lark oc_1 "hi"' });
  assert.deepEqual(lark.signals.reply, { channel: 'lark', endpoint: 'oc_1' });
  assert.equal(lark.category, 'command');
  assert.equal(classifyTool('Bash', { command: 'echo hi' }).signals.reply, undefined);
});
