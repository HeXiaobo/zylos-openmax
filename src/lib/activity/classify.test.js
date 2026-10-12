import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTool, programName, sanitizeDescription, DESCRIPTION_REDACTED, scanCommCli } from './classify.js';
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

// Strict wrapper recognizer (R2): only literal-shape payloads are inspectable;
// everything else pauses attribution, even if it also holds a literal spill
// read or openmax reply (pause wins within one call).
const UNSUPPORTED = {
  concatenation: "const sender='/h/'+'c4-'+'send.js'; await tools.exec_command({cmd:'node '+sender+' telegram foreign'});",
  hexEscape: 'await tools.exec_command({cmd:"node /h/c4-\\x73end.js telegram foreign"});',
  template: 'const p = "/h/c4-send.js"; await tools.exec_command({cmd:`node ${p} telegram foreign`});',
  otherStatement: 'fetch("https://x"); await tools.exec_command({cmd:"git status"});',
  withSpill: 'const x = 1 + 1; await tools.exec_command({cmd:"cat /h/zylos/comm-bridge/attachments/conv-41/message.txt"});',
  withReply: 'await tools.exec_command({cmd:"node /x/c4-send.js openmax conv-a ok"}); const y = a + b;',
  oversized: `await tools.exec_command({cmd:"echo ${'a'.repeat(70 * 1024)}"});`,
};
for (const [label, src] of Object.entries(UNSUPPORTED)) {
  test(`exec wrapper not fully recognized (${label}) → pause, no regain / reply signal from it`, () => {
    const r = classifyTool('exec', src);
    assert.equal(r.signals.external, true);
    assert.equal(r.signals.uninspectable, true);
    assert.equal(r.signals.spillC4Ids, undefined);
    assert.equal(r.signals.replies, undefined);
  });
}
test('exec wrapper literal shapes stay inspectable', () => {
  assert.deepEqual(classifyTool('exec', 'const r = await tools.exec_command({ cmd: "git status" });\nconsole.log(r.output);').signals, {});
  assert.deepEqual(classifyTool('exec', 'await tools.shell({ command: ["bash", "-lc", "ls"], timeout_ms: 1000 })').signals, {});
  assert.deepEqual(classifyTool('exec', { cmd: 'git status', workdir: '/x' }).signals, {});
  assert.equal(classifyTool('exec', '').signals.external, true, 'empty payload pauses');
});

// ── step description (agent_run only) ─────────────────────────────────────

const RD = DESCRIPTION_REDACTED;
const cps = (s) => Array.from(s).length;

test('sanitizeDescription: text is taken as-is (no translation); controls become spaces, whitespace collapses', () => {
  assert.equal(sanitizeDescription('查看 git 状态'), '查看 git 状态');
  assert.equal(sanitizeDescription('Show git status'), 'Show git status');
  assert.equal(sanitizeDescription('  Run\ttests\n\nand\r\nlint\u0000now\u0085! x  '), 'Run tests and lint now ! x');
  assert.equal(sanitizeDescription('a​b﻿c'), 'abc', 'invisible characters are removed, not spaced');
});

test('sanitizeDescription: empty / whitespace / placeholder-only / non-string → undefined', () => {
  for (const v of [undefined, null, 42, {}, '', '   ', '\n\t', '/etc/passwd', '~/zylos/.env', 'sk-abcdefghijklmnop', ' — ', `${RD}`]) {
    assert.equal(sanitizeDescription(v), undefined, JSON.stringify(v));
  }
});

test('sanitizeDescription: absolute and home paths are redacted; relative paths and slashes in prose stay', () => {
  assert.equal(sanitizeDescription('Check /home/alice/zylos/.env exists'), `Check ${RD} exists`);
  assert.equal(sanitizeDescription('Read ~/zylos/memory/state.md'), `Read ${RD}`);
  assert.equal(sanitizeDescription('读取/home/张三/报价.md的内容'), `读取${RD}`);
  assert.equal(sanitizeDescription('List files in "/var/log"'), `List files in "${RD}"`);
  assert.equal(sanitizeDescription('Run ./scripts/x.sh and/or src/a.js, 1 / 2'), 'Run ./scripts/x.sh and/or src/a.js, 1 / 2');
});

test('sanitizeDescription: URLs keep scheme + host only', () => {
  assert.equal(sanitizeDescription('Fetch https://api.example.com/v1/users?id=7#top'), 'Fetch https://api.example.com');
  assert.equal(sanitizeDescription('Ping http://user:pw@10.0.0.5:8080/health now'), 'Ping http://10.0.0.5 now');
  assert.equal(sanitizeDescription('Clone git+ssh://git@github.com/org/repo.git'), 'Clone git+ssh://github.com');
  // Text glued to a URL path, with no boundary, is part of the URL (dropped).
  assert.equal(sanitizeDescription('打开https://x.cn/a/b然后检查'), '打开https://x.cn');
});

test('review R4-3: non-ASCII inside a URL tail is dropped; text outside the URL stays', () => {
  const cases = [
    ['Fetch https://example.com/?password=秘密', 'Fetch https://example.com'],
    ['打开 https://x.cn/文档/设计#章节 然后看', '打开 https://x.cn 然后看'],
    ['see https://a.com/😀?q=😀 ok', 'see https://a.com ok'],
    ['get https://a.com/café/naïve?x=é done', 'get https://a.com done'],
    ['查看 https://a.com 的说明', '查看 https://a.com 的说明'],
    ['访问https://a.com/路径。然后继续', '访问https://a.com。然后继续'],
    ['（见https://a.com/秘密）再说', '（见https://a.com）再说'],
    ['“https://a.com/秘密”看看', '“https://a.com”看看'],
    ['(https://a.com/x?k=密)说明', '(https://a.com)说明'],
    ['链接「https://a.com/q?a=1,秘密」', '链接「https://a.com」'],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeDescription(input), want, input);
});

test('sanitizeDescription: secrets, tokens and emails are redacted', () => {
  const cases = [
    ['Call API with cwsk_9f8e7d6c5b4a', `Call API with ${RD}`],
    ['Use sk-proj-abcdefghijklmnop key', `Use ${RD} key`],
    ['Push with ghp_abcdefghijklmnopqrstuvwxyz0123456789', `Push with ${RD}`],
    ['Auth gho_abc123def456', `Auth ${RD}`],
    ['Token github_pat_11ABCDEFG_xyz', `Token ${RD}`],
    ['Slack xoxb-123-456-abc and xoxp-1-2', `Slack ${RD} and ${RD}`],
    ['AWS AKIAIOSFODNN7EXAMPLE creds', `AWS ${RD} creds`],
    ['curl with Bearer eyJhbGciOi.abc.def header', `curl with Bearer ${RD} header`],
    ['Login with password=hunter2 now', `Login with password=${RD} now`],
    ['Commit a3f5c9d2e1b4a3f5c9d2e1b4c7 detail', `Commit ${RD} detail`],
    ['Decode dGhpcyBpcyBhIHNlY3JldCB2YWx1ZTEy', `Decode ${RD}`],
    ['Notify bob.smith+ops@corp.example.com', `Notify ${RD}`],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeDescription(input), want, input);
  // Long words without a digit are not tokens.
  assert.equal(sanitizeDescription('Check internationalization settings'), 'Check internationalization settings');
});

test('sanitizeDescription: cut to ≤ 80 code points (not UTF-16 units), "…" when cut', () => {
  const cjk = '检查'.repeat(50);
  const out = sanitizeDescription(cjk);
  assert.equal(cps(out), 80);
  assert.ok(out.endsWith('…'));
  assert.equal(out, `${'检查'.repeat(39)}检…`);
  const exact = '中'.repeat(80);
  assert.equal(sanitizeDescription(exact), exact, 'exactly 80 is not cut');
  const emoji = `Go${'🚀'.repeat(81)}`;
  const e = sanitizeDescription(emoji);
  assert.equal(cps(e), 80, 'astral characters count as one code point');
  assert.equal(e, `Go${'🚀'.repeat(77)}…`);
  const long = sanitizeDescription(`Inspect ${'/very/long/path/'.repeat(10)} then ${'x'.repeat(200)}`);
  assert.ok(cps(long) <= 80);
});

test('Bash with a description: sanitized description next to the program-name detail', () => {
  const c = classifyTool('Bash', { command: 'git status --short', description: '查看 git 工作区状态' });
  assert.equal(c.category, 'command');
  assert.equal(c.detail, 'git');
  assert.equal(c.description, '查看 git 工作区状态');
  const r = classifyTool('Bash', { command: 'cat /home/u/.env', description: 'Show /home/u/.env\nwith token=abc' });
  assert.equal(r.description, `Show ${RD} with token=${RD}`);
  assert.equal(r.detail, 'cat');
  // Reply / kb Bash calls carry their description too.
  const reply = classifyTool('Bash', { command: 'node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "conv" <<EOF', description: 'Reply to the user' });
  assert.equal(reply.category, 'reply');
  assert.equal(reply.description, 'Reply to the user');
});

test('Bash without a usable description and Codex exec_command fall back to the program name', () => {
  for (const input of [{ command: 'git log' }, { command: 'git log', description: '' }, { command: 'git log', description: '  \n ' },
    { command: 'git log', description: 42 }, { command: 'git log', description: '/home/u/x' }]) {
    const c = classifyTool('Bash', input);
    assert.equal(c.description, undefined, JSON.stringify(input));
    assert.equal(c.detail, 'git');
  }
  const x = classifyTool('exec_command', { cmd: 'rg foo src' });
  assert.equal(x.description, undefined);
  assert.equal(x.detail, 'rg');
  // Non-command tools never get one, even if their input has the field.
  assert.equal(classifyTool('Read', { file_path: '/a.md', description: 'read it' }).description, undefined);
  assert.equal(classifyTool('exec', { code: 'x', description: 'wrapper' }).description, undefined);
  // The command text itself is never used as the description.
  assert.equal(classifyTool('Bash', { command: 'echo hello world' }).description, undefined);
});

// ── comm CLI sends ─────────────────────────────────────────────────────────
const CONV = '019f0000-aaaa-7bbb-8ccc-00000000000a';

test('comm CLI reply verbs are replies with the parsed conversationId (quoting variants)', () => {
  for (const command of ['comm.send', 'comm.send_card', 'comm.ask_card']) {
    for (const cmd of [
      `node /h/zylos/.claude/skills/openmax/src/cli/comm.js ${command} '{"conversationId":"${CONV}","content":"hi"}'`,
      `cd ~/zylos/.claude/skills/openmax && node src/cli/comm.js ${command} "{\\"conversationId\\":\\"${CONV}\\",\\"title\\":\\"t\\"}"`,
      `node "src/cli/comm.js" "${command}" '{ "title": "t", "conversationId" : "${CONV}" }'`,
      `node src/cli/comm.js ${command} "$(cat <<'EOF'\n{\n  "conversationId": "${CONV}",\n  "content": "多行"\n}\nEOF\n)"`,
    ]) {
      const r = classifyTool('Bash', { command: cmd });
      assert.deepEqual(r.signals.replies, [{ channel: 'openmax', conversationId: CONV }], cmd);
      assert.equal(r.signals.external, undefined, cmd);
      assert.equal(r.category, 'reply', cmd);
    }
  }
});

test('comm CLI: non-reply commands are neither replies nor external', () => {
  for (const cmd of [
    `node src/cli/comm.js comm.get_messages '{"conversationId":"${CONV}"}'`,
    `node src/cli/comm.js comm.answered '{"cardMessageId":"1","actionId":"a"}'`,
    `node src/cli/comm.js comm.pending_clear '{"cardMessageId":"1"}'`,
    `node src/cli/comm.js comm.member_list '{"conversationId":"${CONV}"}'`,
    'sed -n 1,40p src/cli/comm.js',
    'cat src/cli/comm.js | grep comm.send',
  ]) {
    const r = classifyTool('Bash', { command: cmd });
    assert.equal(r.signals.replies, undefined, cmd);
    assert.equal(r.signals.external, undefined, cmd);
    assert.notEqual(r.category, 'reply', cmd);
  }
});

test('review R4-1: a comm CLI send whose destination comes from a variable / file / non-literal is external (pause)', () => {
  for (const cmd of [
    'node src/cli/comm.js comm.send "$(cat /tmp/payload.json)"',
    'node src/cli/comm.js comm.ask_card "$PAYLOAD"',
    'node src/cli/comm.js comm.send $PAYLOAD',
    'node src/cli/comm.js comm.send_card "{\"conversationId\":\"$CONV\",\"title\":\"t\"}"',
    'node src/cli/comm.js comm.send `cat p.json`',
    `node src/cli/comm.js comm.send '{"conversationId":"../etc","content":"x"}'`,
    `node src/cli/comm.js comm.send '{"content":"no destination"}'`,
    `node src/cli/comm.js comm.send '{"conversationId":"${CONV}"' 'extra'`,
    'node src/cli/comm.js comm.send',
    `node src/cli/comm.js "$VERB" '{"conversationId":"${CONV}"}'`,
    `node src/cli/comm.js comm.send "$(cat <<EOF\n{"conversationId":"$C"}\nEOF\n)"`,
  ]) {
    const r = classifyTool('Bash', { command: cmd });
    assert.equal(r.signals.external, true, cmd);
    assert.equal(r.signals.replies, undefined, cmd);
  }
});

test('review R4-2: only the invocation\'s own JSON argument counts, by its TOP-LEVEL conversationId', () => {
  const A = CONV;
  const B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
  // content mentions A, the destination is B.
  const r = classifyTool('Bash', { command: `node src/cli/comm.js comm.send '{"content":"re {\\"conversationId\\":\\"${A}\\"}","conversationId":"${B}"}'` });
  assert.deepEqual(r.signals.replies, [{ channel: 'openmax', conversationId: B }]);
  const nested = classifyTool('Bash', { command: `node src/cli/comm.js comm.send_card '{"title":"t","meta":{"conversationId":"${A}"},"conversationId":"${B}"}'` });
  assert.deepEqual(nested.signals.replies, [{ channel: 'openmax', conversationId: B }]);
  // An ID echoed later in the command line is not borrowed.
  const echoed = classifyTool('Bash', { command: `node src/cli/comm.js comm.send "$(cat p.json)"; echo '{"conversationId":"${A}"}'` });
  assert.equal(echoed.signals.replies, undefined);
  assert.equal(echoed.signals.external, true);
  // Nested content only, no top-level destination: external.
  const inner = classifyTool('Bash', { command: `node src/cli/comm.js comm.send '{"content":{"conversationId":"${A}"}}'` });
  assert.equal(inner.signals.external, true);
});

test('comm CLI: each send in a compound command gets its own conversationId; c4-send still parsed', () => {
  const other = '019f0000-aaaa-7bbb-8ccc-00000000000b';
  const r = classifyTool('Bash', { command: `node src/cli/comm.js comm.get_messages '{"conversationId":"${other}"}' && node src/cli/comm.js comm.send '{"conversationId":"${CONV}","content":"x"}' && node /x/c4-send.js "openmax" "${other}" "y"` });
  assert.deepEqual(r.signals.replies, [{ channel: 'openmax', endpoint: other }, { channel: 'openmax', conversationId: CONV }]);
  assert.deepEqual(scanCommCli(`node src/cli/comm.js comm.send '{"content":"x"}' ; node src/cli/comm.js comm.send_card '{"conversationId":"${other}"}'`),
    [{ command: 'comm.send', conversationId: null }, { command: 'comm.send_card', conversationId: other }]);
});

test('comm CLI inside a recognized Codex exec wrapper is a reply too', () => {
  const code = `const r = await tools.exec_command({ cmd: ${JSON.stringify(`node src/cli/comm.js comm.ask_card '{"conversationId":"${CONV}"}'`)} });\nconsole.log(r.output);`;
  const r = classifyTool('exec', code);
  assert.deepEqual(r.signals.replies, [{ channel: 'openmax', conversationId: CONV }]);
});
