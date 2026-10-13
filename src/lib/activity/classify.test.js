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

// ── review R5: real executable word; consumed literal arguments ────────────
const R5_B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
const NODE_FORMS = [
  'node',
  '/usr/bin/node',
  '~/.nvm/versions/node/v20.11.0/bin/node',
  '"node"',
  "'/usr/local/bin/node'",
  'COCO_ORG_ID=o1 node',
  'exec /usr/bin/node',
  'command -p node',
  'nohup node',
  '"$NODE"',
];

test('review R5-1: every node invocation form × every send verb → reply (known) / external (unprovable)', () => {
  for (const nodeWord of NODE_FORMS) {
    for (const verb of ['comm.send', 'comm.send_card', 'comm.ask_card']) {
      const known = classifyTool('Bash', { command: `${nodeWord} /h/zylos/.claude/skills/openmax/src/cli/comm.js ${verb} '{"conversationId":"${R5_B}","title":"t"}'` });
      assert.deepEqual(known.signals.replies, [{ channel: 'openmax', conversationId: R5_B }], `${nodeWord} ${verb}`);
      assert.equal(known.signals.external, undefined, `${nodeWord} ${verb}`);
      const unknown = classifyTool('Bash', { command: `${nodeWord} src/cli/comm.js ${verb} "$(cat /tmp/p.json)"` });
      assert.equal(unknown.signals.external, true, `${nodeWord} ${verb} unprovable`);
      assert.equal(unknown.signals.replies, undefined);
    }
  }
  // Nested shells and argv arrays.
  assert.deepEqual(classifyTool('Bash', { command: `bash -lc 'node src/cli/comm.js comm.send "{\\"conversationId\\":\\"${R5_B}\\"}"'` }).signals.replies,
    [{ channel: 'openmax', conversationId: R5_B }]);
  assert.deepEqual(classifyTool('shell', { command: ['/usr/bin/node', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R5_B}","content":"a b"}`] }).signals.replies,
    [{ channel: 'openmax', conversationId: R5_B }]);
  // A runner the reader does not know, mentioning a reply verb: external.
  assert.equal(classifyTool('Bash', { command: 'xargs node src/cli/comm.js comm.send < p' }).signals.external, true);
});

test('review R5-1 (c4-send): absolute / quoted node paths are recognized too', () => {
  for (const nodeWord of NODE_FORMS.slice(0, 9)) {
    const r = classifyTool('Bash', { command: `${nodeWord} /x/c4-send.js "openmax" "${R5_B}" "hi"` });
    assert.deepEqual(r.signals.replies, [{ channel: 'openmax', endpoint: R5_B }], nodeWord);
    assert.equal(classifyTool('Bash', { command: `${nodeWord} /x/c4-send.js lark oc_1 "hi"` }).signals.external, true, nodeWord);
  }
});

test('review R5-2: an example command inside a consumed literal argument is text, not a send', () => {
  const A = CONV;
  // comm CLI JSON argument quoting a comm CLI example for A.
  const r = classifyTool('Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${R5_B}","content":"例: node src/cli/comm.js comm.send {\\"conversationId\\":\\"${A}\\"}"}'; echo trailing` });
  assert.deepEqual(r.signals.replies, [{ channel: 'openmax', conversationId: R5_B }]);
  assert.equal(r.signals.external, undefined);
  // c4-send message / heredoc body quoting sends.
  for (const cmd of [
    `node /x/c4-send.js "openmax" "${R5_B}" <<'EOF'\n示例: node /x/c4-send.js "openmax" "${A}" "hi"\nnode src/cli/comm.js comm.send '{"conversationId":"${A}"}'\nEOF`,
    `node /x/c4-send.js "openmax" "${R5_B}" "示例: node /x/c4-send.js lark oc_1 hi"`,
    `node /x/c4-send.js "openmax" "${R5_B}" "$(cat <<'EOF'\nrun: node src/cli/comm.js comm.ask_card '{"conversationId":"${A}"}'\nEOF\n)"`,
  ]) {
    const s = classifyTool('Bash', { command: cmd });
    assert.deepEqual(s.signals.replies, [{ channel: 'openmax', endpoint: R5_B }], cmd);
    assert.equal(s.signals.external, undefined, cmd);
  }
  // Real compound commands still count every send.
  for (const sep of [' && ', '; ', '\n', ' || ', ' | ']) {
    const two = classifyTool('Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${R5_B}"}'${sep}node src/cli/comm.js comm.send '{"conversationId":"${A}"}'` });
    assert.deepEqual(two.signals.replies.map((x) => x.conversationId), [R5_B, A], JSON.stringify(sep));
  }
  // A heredoc that is NOT a send's message keeps the old caution.
  assert.equal(classifyTool('Bash', { command: `cat > /tmp/x.sh <<'EOF'\nnode /x/c4-send.js lark oc_1 hi\nEOF` }).signals.external, true);
  // Command substitution executes: a send inside it is external.
  assert.equal(classifyTool('Bash', { command: `echo "$(node /x/c4-send.js openmax ${A} hi)"` }).signals.external, true);
});

// ── review R6: heredoc delimiter quoting; non-executing interpreter modes ──
const R6_A = CONV;
const R6_B = '019f0000-aaaa-7bbb-8ccc-00000000000b';
const R6_TOOLS = {
  Bash: (cmd) => ({ command: cmd }),
  exec_command: (cmd) => ({ cmd }),
  shell: (cmd) => ({ command: ['bash', '-lc', cmd] }),
  local_shell: (cmd) => ({ command: ['bash', '-lc', cmd] }),
};
const r6 = (cmd) => Object.entries(R6_TOOLS).map(([name, wrap]) => [name, classifyTool(name, wrap(cmd)).signals]);
const bSend = `node src/cli/comm.js comm.send '{"conversationId":"${R6_B}"}'`;

test('review R6-1: an unquoted heredoc body runs its $(…) / `…`; a quoted one is text', () => {
  for (const [label, delimOpen, expanding] of [
    ['<<EOF', '<<EOF', true], ['<<-EOF', '<<-EOF', true],
    ["<<'EOF'", "<<'EOF'", false], ['<<"EOF"', '<<"EOF"', false], ['<<\\EOF', '<<\\EOF', false], ['<<E"OF"', '<<E"OF"', false],
  ]) {
    for (const inner of [`$(${bSend})`, `\`node /x/c4-send.js openmax ${R6_B} hi\``]) {
      // Outer non-send (comm.get_messages for A).
      for (const [tool, sig] of r6(`node src/cli/comm.js comm.get_messages '{"conversationId":"${R6_A}"}' ${delimOpen}\n${inner}\nEOF`)) {
        assert.equal(sig.external, expanding ? true : undefined, `${tool} ${label} ${inner.slice(0, 3)}`);
        assert.equal(sig.replies, undefined, `${tool} ${label}`);
      }
      // Outer c4-send message to A.
      for (const [tool, sig] of r6(`node /x/c4-send.js "openmax" "${R6_A}" ${delimOpen}\nhello ${inner}\nEOF`)) {
        assert.deepEqual(sig.replies, [{ channel: 'openmax', endpoint: R6_A }], `${tool} ${label}`);
        assert.equal(sig.external, expanding ? true : undefined, `${tool} ${label} c4`);
      }
      // Outer comm.send to A.
      for (const [tool, sig] of r6(`node src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}' ${delimOpen}\n${inner}\nEOF`)) {
        assert.deepEqual(sig.replies, [{ channel: 'openmax', conversationId: R6_A }], `${tool} ${label}`);
        assert.equal(sig.external, expanding ? true : undefined, `${tool} ${label} comm`);
      }
    }
  }
  // An expanding body with only variables / plain text naming a send: text.
  for (const [tool, sig] of r6(`node /x/c4-send.js "openmax" "${R6_A}" <<EOF\nhi $USER, example: node /x/c4-send.js lark oc_1 x\nEOF`)) {
    assert.deepEqual(sig.replies, [{ channel: 'openmax', endpoint: R6_A }], tool);
    assert.equal(sig.external, undefined, tool);
  }
});

test('review R6-2: node --check / -c / --version and bash|sh -n / -nc / -o noexec run nothing: no reply, no pause', () => {
  for (const cmd of [
    `node --check src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`,
    `node -c src/cli/comm.js comm.ask_card '{"conversationId":"${R6_A}"}'`,
    `/usr/bin/node --check /x/c4-send.js "openmax" "${R6_A}" "hi"`,
    `node -c /x/c4-send.js lark oc_1 hi`,
    'node --version src/cli/comm.js comm.send x',
    `bash -nc 'node src/cli/comm.js comm.send "{\\"conversationId\\":\\"${R6_A}\\"}"'`,
    `bash -n -c 'node /x/c4-send.js openmax ${R6_A} hi'`,
    `sh -xn -c 'node /x/c4-send.js lark oc_1 hi'`,
    `sh -o noexec -c 'node /x/c4-send.js openmax ${R6_A} hi'`,
  ]) {
    for (const [tool, sig] of r6(cmd)) {
      assert.equal(sig.replies, undefined, `${tool}: ${cmd}`);
      assert.equal(sig.external, undefined, `${tool}: ${cmd}`);
    }
  }
  // argv form of a noexec shell (shell / local_shell tools).
  for (const argv of [['bash', '-nc', `node /x/c4-send.js openmax ${R6_A} hi`], ['sh', '-n', '-c', `node /x/c4-send.js openmax ${R6_A} hi`]]) {
    for (const tool of ['shell', 'local_shell']) {
      const sig = classifyTool(tool, { command: argv }).signals;
      assert.equal(sig.replies, undefined, `${tool} ${argv.join(' ')}`);
      assert.equal(sig.external, undefined, `${tool} ${argv.join(' ')}`);
    }
  }
  // Executing modes stay as they were.
  assert.deepEqual(classifyTool('Bash', { command: `bash -c 'node /x/c4-send.js openmax ${R6_A} hi'` }).signals.replies, [{ channel: 'openmax', endpoint: R6_A }]);
  assert.deepEqual(classifyTool('Bash', { command: `node src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'` }).signals.replies, [{ channel: 'openmax', conversationId: R6_A }]);
  // Any other node option (R10): unknown → pause, never a reply.
  assert.equal(classifyTool('Bash', { command: `node --no-warnings src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'` }).signals.external, true);
  // -p / -e run inline code, not the script: unprovable → pause.
  assert.equal(classifyTool('Bash', { command: `node -p "1" src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'` }).signals.external, true);
  // A command substitution in a non-executing command's arguments still runs.
  assert.equal(classifyTool('Bash', { command: `node --check x.js "$(node /x/c4-send.js openmax ${R6_A} hi)"` }).signals.external, true);
});

// ── review R7 / R8: invocation noexec (tri-state); heredoc delimiter continuation ──
const r7aC4 = `node /x/c4-send.js openmax ${R6_A} hi`;
const r7bC4 = 'node /x/c4-send.js lark oc_b hi';                // a send elsewhere: pauses
const R7_REPLY_B = [{ channel: 'openmax', conversationId: R6_B }]; // bSend: a reply to B
const R7_REPLY_A = [{ channel: 'openmax', endpoint: R6_A }];

// R8 / R9: a `set -n` inside a script is never an exemption (its effect
// depends on scope, function names, interactive mode …). A send after it is
// uncertain: it pauses attribution, but is never a reply. Real bash runs the
// trailing command for the first group and not for the second; both pause.
const R8_SET_N_PREFIXES = [
  '(set -n); ', 'set -n | cat; ', 'cat | set -n; ', 'false && set -n; ', 'set -n & ', 'false &&\nset -n\n',
  'if false; then set -n; fi; ', 'f() { set -n; }; ', 'case x in y) set -n;; esac; ',
  "if false; then 'fi'; set -n; fi; ", "while false; do 'done'; set -n; done; ", "if false; then { '}'; set -n; }; fi; ",
  'set() { :; }; set -n; ', 'flags=+n; set -n $flags; ', 'set -n +n; ', 'set -o noexec +o noexec; ',
  // Also where it would stop the rest: still read as running (pause / reply,
  // never an exemption).
  'set -n; ', 'set -n\n', 'echo hi; set -n; ', '{ set -n; }; ', 'set -eo noexec; ', 'set +n -n; ',
];

// The four command tools plus the Codex `exec` wrapper (fifth form).
const r9 = (cmd) => [...r6(cmd), ['exec', classifyTool('exec', WRAPPER_CODE(cmd)).signals]];
const assertPause = (sig, msg) => { assert.equal(sig.external, true, msg); assert.equal(sig.replies, undefined, msg); };

test('review R8-1 / R9-1: a send after a runtime set -n is uncertain — pause, never a reply', () => {
  for (const pre of [...R8_SET_N_PREFIXES, 'builtin set -n; ', 'command set -n; ', 'set -o noexec; ', 'set -on noexec; ', 'set "$@"; ', 'eval set -n; ']) {
    for (const send of [bSend, r7bC4, r7aC4]) {
      for (const [tool, sig] of r9(`${pre}${send}`)) assertPause(sig, `${tool}: ${JSON.stringify(pre + send)}`);
    }
  }
  // Interactive shells: a runtime set -n inside -c — the outer and inner send both pause.
  for (const [tool, sig] of r9(`bash --noprofile --norc -i -c 'set -n; ${r7aC4}'`)) assertPause(sig, tool);
  for (const [tool, sig] of r9(`bash -c 'set -n'; ${r7aC4}`)) assertPause(sig, tool);
  // A send before the set -n is a reply; one after it pauses.
  for (const [tool, sig] of r9(`${r7aC4}; set -n; ${r7bC4}`)) {
    assert.deepEqual(sig.replies, R7_REPLY_A, tool);
    assert.equal(sig.external, true, tool);
  }
  // Other `set` options are not a trigger.
  for (const [tool, sig] of r9(`set -euo pipefail; set +n; set -x; ${r7aC4}`)) {
    assert.deepEqual(sig.replies, R7_REPLY_A, tool);
    assert.equal(sig.external, undefined, tool);
  }
  // Separate exec_command calls of one wrapper: still uncertain (pause).
  const two = (a, b) => `await tools.exec_command({cmd:${JSON.stringify(a)}}); await tools.exec_command({cmd:${JSON.stringify(b)}});`;
  const sep = classifyTool('exec', two('set -n', r7bC4)).signals;
  assert.equal(sep.uninspectable, undefined);
  assert.equal(sep.external, true);
  assert.deepEqual(classifyTool('exec', two('set -n', r7aC4)).signals.replies, R7_REPLY_A, 'another invocation: not after the set -n');
});

test('review R9-1: set -n text inside a consumed send message is not a trigger', () => {
  for (const first of [
    `node /x/c4-send.js "openmax" "${R6_A}" "tip: run set -n; or set -o noexec first"`,
    `node /x/c4-send.js "openmax" "${R6_A}" <<'EOF'\nset -n\nset -o noexec\nEOF`,
    `node src/cli/comm.js comm.send '{"conversationId":"${R6_A}","content":"set -n; set -o noexec"}'`,
  ]) {
    for (const [tool, sig] of r6(`${first}\n${r7aC4}`)) {
      assert.equal(sig.external, undefined, `${tool}: ${first}`);
      assert.equal(sig.replies.length, 2, `${tool}: ${first}`);
    }
    // Control: a genuine set -n between them makes the second send uncertain.
    for (const [tool, sig] of r6(`${first}\nset -n\n${r7aC4}`)) {
      assert.equal(sig.external, true, `${tool}: ${first}`);
      assert.equal(sig.replies.length, 1, `${tool}: ${first}`);
    }
  }
  // Single-line forms (the Codex wrapper recognizer only accepts one line).
  for (const first of [
    `node /x/c4-send.js "openmax" "${R6_A}" "tip: run set -n; or set -o noexec first"`,
    `node src/cli/comm.js comm.send '{"conversationId":"${R6_A}","content":"set -n; set -o noexec"}'`,
  ]) {
    for (const [tool, sig] of r9(`${first}; ${r7aC4}`)) {
      assert.equal(sig.external, undefined, `${tool}: ${first}`);
      assert.equal(sig.replies.length, 2, `${tool}: ${first}`);
    }
    for (const [tool, sig] of r9(`${first}; set -n; ${r7aC4}`)) {
      assert.equal(sig.external, true, `${tool}: ${first}`);
      assert.equal(sig.replies.length, 1, `${tool}: ${first}`);
    }
  }
});

test('review R8-2: invocation noexec is read in order and tri-state; unknown options are not proof', () => {
  // Enable then disable: the script runs.
  for (const cmd of [`bash -n +n -c '${r7bC4}'`, `bash -o noexec +o noexec -c '${r7bC4}'`, `sh -n +o noexec -c '${r7bC4}'`, `bash -xn +xn -c '${r7bC4}'`]) {
    for (const [tool, sig] of r6(cmd)) assert.equal(sig.external, true, `${tool}: ${cmd}`);
  }
  for (const [tool, sig] of r6(`bash -n +n -c '${r7aC4}'`)) {
    assert.deepEqual(sig.replies, R7_REPLY_A, tool);
    assert.equal(sig.external, undefined, tool);
  }
  // Unknown (non-literal arg / unknown option or -o name): may run → pause,
  // never a reply, never inert. bash runs the first four; it rejects the
  // others, but an option this reader does not know is not proof either way.
  for (const cmd of [
    `flags=+n; bash -n $flags -c '${r7aC4}'`, `opt=noexec; bash -n +o "$opt" -c '${r7aC4}'`,
    `bash -n "$(echo +n)" -c '${r7aC4}'`, `bash -n \`echo +n\` -c '${r7aC4}'`, `bash -n +[n] -c '${r7aC4}'`,
    `bash -n --frobnicate -c '${r7aC4}'`, `bash -n -o bogus -c '${r7aC4}'`, `bash -nZ -c '${r7aC4}'`,
    `node --check $X src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`,
    `node --check --frobnicate /x/c4-send.js openmax ${R6_A} hi`,
  ]) {
    for (const [tool, sig] of r6(cmd)) {
      assert.equal(sig.external, true, `${tool}: ${cmd}`);
      assert.equal(sig.replies, undefined, `${tool}: ${cmd}`);
    }
  }
  for (const [tool, sig] of r6(`flags=+n; bash -n $flags -c '${bSend}'`)) assert.equal(sig.external, true, tool);
  // Disable then enable, literal: inert.
  for (const cmd of [
    `bash +n -n -c '${r7bC4}'`, `bash +o noexec -o noexec -c '${r7bC4}'`, `bash -xo noexec -c '${r7bC4}'`,
    `bash -n -c '${bSend}'`, `bash -in -c '${r7bC4}'`, `bash --noprofile --norc -n -O extglob -c '${r7aC4}'`,
  ]) {
    for (const [tool, sig] of r6(cmd)) assert.deepEqual(sig, {}, `${tool}: ${cmd}`);
  }
  // argv forms (shell / local_shell): no expansion — every element is literal.
  for (const [argv, want] of [
    [['bash', '-n', '+n', '-c', r7bC4], 'runs'], [['bash', '-o', 'noexec', '+o', 'noexec', '-c', r7bC4], 'runs'],
    [['bash', '+n', '-n', '-c', r7bC4], 'inert'], [['bash', '+o', 'noexec', '-o', 'noexec', '-c', r7bC4], 'inert'],
    [['sh', '-nc', r7bC4], 'inert'], [['bash', '-in', '-c', r7bC4], 'inert'],
    [['bash', '-n', '--frobnicate', '-c', r7aC4], 'unknown'], [['bash', '-n', '-o', 'bogus', '-c', r7aC4], 'unknown'],
  ]) {
    for (const tool of ['shell', 'local_shell']) {
      const sig = classifyTool(tool, { command: argv }).signals;
      if (want === 'inert') assert.deepEqual(sig, {}, `${tool} ${argv.join(' ')}`);
      else assert.equal(sig.external, true, `${tool} ${argv.join(' ')}`);
      if (want === 'unknown') assert.equal(sig.replies, undefined, `${tool} ${argv.join(' ')}`);
    }
  }
  for (const tool of ['shell', 'local_shell']) {
    assert.deepEqual(classifyTool(tool, { command: ['bash', '-n', '+n', '-c', r7aC4] }).signals.replies, R7_REPLY_A, tool);
  }
  // Long options are skipped, not taken for the script.
  for (const [tool, sig] of r6(`bash --login --norc -c '${r7aC4}'`)) assert.deepEqual(sig.replies, R7_REPLY_A, tool);
});

test('review R7-3: a backslash-newline in a heredoc delimiter is a continuation, not quoting', () => {
  // Unquoted (EO\⏎F = EOF): bash runs the $(…) — B is sent, then A.
  for (const [tool, sig] of r6(`node /x/c4-send.js "openmax" "${R6_A}" <<EO\\\nF\n$(${bSend})\nEOF`)) {
    assert.deepEqual(sig.replies, R7_REPLY_A, tool);
    assert.equal(sig.external, true, tool);
  }
  for (const [tool, sig] of r6(`node src/cli/comm.js comm.get_messages '{"conversationId":"${R6_A}"}' <<\\\nEOF\n$(${bSend})\nEOF`)) {
    assert.equal(sig.external, true, tool);
  }
  // Really quoted with a continuation too (\E… / '…'): the body is text.
  for (const open of ['<<\\EO\\\nF', '<<E\\O\\\nF', '<<"EO\\\nF"']) {
    for (const [tool, sig] of r6(`node /x/c4-send.js "openmax" "${R6_A}" ${open}\n$(${bSend})\nEOF`)) {
      assert.deepEqual(sig.replies, R7_REPLY_A, `${tool} ${JSON.stringify(open)}`);
      assert.equal(sig.external, undefined, `${tool} ${JSON.stringify(open)}`);
    }
  }
});

test('review R9-2/3: node is inert only with literal mode flags (last setting wins), nothing else', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`;
  // Inert (real node v22: no script, no preload).
  for (const opts of ['--check', '-c', '--no-check --check', '--no-help --help', '--no-version --version', '-v', '-h', '--check --no-help']) {
    for (const [tool, sig] of r9(`node ${opts} ${comm}`)) assert.deepEqual(sig, {}, `${tool}: ${opts}`);
  }
  // A plain VAR= prefix (not NODE_OPTIONS / PATH) changes nothing.
  for (const [tool, sig] of r9(`X=1 node --check ${comm}`)) assert.deepEqual(sig, {}, tool);
  // A mode turned off again: the script runs → a reply.
  for (const opts of ['--check --no-check', '-c --no-check', '--help --no-help', '--version --no-version']) {
    for (const [tool, sig] of r9(`node ${opts} ${comm}`)) {
      assert.deepEqual(sig.replies, [{ channel: 'openmax', conversationId: R6_A }], `${tool}: ${opts}`);
      assert.equal(sig.external, undefined, `${tool}: ${opts}`);
    }
  }
  // A mode with anything else (preloads run under --check / --help; other
  // options, env prefixes, non-literal words): unknown → pause, never a reply.
  for (const pre of [
    'node --check --require ./p.cjs', 'node --check --require=./p.cjs', 'node --check -r ./p.cjs',
    'node --check --import ./p.mjs', 'node --check --import=./p.mjs', 'node --check --experimental-loader=./p.mjs',
    'node --check --loader ./p.mjs', 'node --help --require ./p.cjs', 'node --version --require ./p.cjs',
    'node --check --no-warnings', 'node --check --env-file .env', 'node --check --frobnicate', 'node --check $X',
    'node --v8-options', 'NODE_OPTIONS="--require ./p.cjs" node --check', 'env NODE_OPTIONS=--require=./p.cjs node --check',
    'env node --check', 'PATH=/x node --check',
  ]) {
    for (const [tool, sig] of r9(`${pre} ${comm}`)) assertPause(sig, `${tool}: ${pre}`);
  }
  // argv form of node itself (shell / local_shell, no sh -c).
  for (const tool of ['shell', 'local_shell']) {
    assert.deepEqual(classifyTool(tool, { command: ['node', '--no-check', '--check', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals, {}, tool);
    assertPause(classifyTool(tool, { command: ['node', '--check', '-r', './p.cjs', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals, tool);
    assert.deepEqual(classifyTool(tool, { command: ['node', '--check', '--no-check', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals.replies,
      [{ channel: 'openmax', conversationId: R6_A }], tool);
  }
});

// ── review R10: node option gate independent of the mode; execution prefixes ──
test('review R10-1: any non-mode node option or env prefix is unknown, whatever the final mode', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`;
  // Real node v22: --frobnicate exits 9 (no send); preloads / NODE_OPTIONS run hook code, then the script.
  for (const pre of [
    'node --frobnicate', 'node --require ./h.cjs', 'node --require=./h.cjs', 'node -r ./h.cjs', 'node --import ./h.mjs',
    'node --import=./h.mjs', 'node --loader ./h.mjs', 'node --experimental-loader=./h.mjs', 'node --no-warnings',
    'node --check --no-check --require ./h.cjs', 'node -c --no-check -r ./h.cjs', 'node --env-file .env',
    'NODE_OPTIONS="--require ./h.cjs" node', 'NODE_OPTIONS=--require=./h.cjs node --check --no-check', 'PATH=/x node',
    'env node', 'env -S "node --require ./h.cjs"', 'env FOO=1 node', 'exec node --require ./h.cjs', 'nohup node -r ./h.cjs',
    'export NODE_OPTIONS="--require ./h.cjs"; node', 'NODE_OPTIONS=x; export NODE_OPTIONS; node',
    `eval 'export NODE_OPTIONS=x'; node`, 'export $(cat .env); node', 'declare -x NODE_OPTIONS=x; node',
  ]) {
    for (const [tool, sig] of r9(`${pre} ${comm}`)) assertPause(sig, `${tool}: ${pre}`);
  }
  // NODE_OPTIONS exported before a nested shell is inherited there.
  for (const [tool, sig] of r9(`export NODE_OPTIONS=x; bash -c 'node ${comm.replace(/'/g, '')}'`)) assertPause(sig, tool);
  // Controls: a direct invocation, pure mode flags ending off, safe prefixes → a reply.
  for (const pre of ['node', 'node --check --no-check', 'node -c --no-check', 'exec node', 'command -p node', 'X=1 node', 'nohup node', 'timeout 5 node', 'builtin exec node']) {
    for (const [tool, sig] of r9(`${pre} ${comm}`)) {
      assert.deepEqual(sig.replies, [{ channel: 'openmax', conversationId: R6_A }], `${tool}: ${pre}`);
      assert.equal(sig.external, undefined, `${tool}: ${pre}`);
    }
  }
  // argv form of node itself.
  for (const tool of ['shell', 'local_shell']) {
    assertPause(classifyTool(tool, { command: ['node', '--frobnicate', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals, tool);
    assertPause(classifyTool(tool, { command: ['env', 'NODE_OPTIONS=-r./h.cjs', 'node', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals, tool);
    assert.deepEqual(classifyTool(tool, { command: ['node', 'src/cli/comm.js', 'comm.send', `{"conversationId":"${R6_A}"}`] }).signals.replies,
      [{ channel: 'openmax', conversationId: R6_A }], tool);
  }
});

test('review R10-2: execution prefixes and other ways a later send may not run make it uncertain', () => {
  // Real bash 5.2: each stops (or may stop / replace) what follows.
  for (const pre of [
    'command -p set -n; ', 'command -- set -n; ', 'command -p -- set -n; ', 'builtin -- set -n; ', "eval -- 'set -n'; ",
    "builtin eval 'set -n'; ", 'command builtin set -n; ', "command -p eval 'set -n'; ", 'command -x set -n; ',
    '\\set -n; ', "'set' -n; ", '"set" -o noexec; ', 'time set -n; ', 'time -p set -n; ',
    'x="set -n"; $x; ', 'X="set -n"; eval "$X"; ', '. ./sn.sh; ', 'source ./sn.sh; ', "trap 'set -n' DEBUG; ",
    'exec true; ', 'exit 0; ', 'node() { :; }; ', 'function node { :; }; ', 'alias node=true; ', 'hash -p /bin/true node; ',
  ]) {
    for (const send of [r7aC4, bSend, `node src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`]) {
      for (const [tool, sig] of r9(`${pre}${send}`)) assertPause(sig, `${tool}: ${pre}${send}`);
    }
  }
  // Controls: queries and harmless forms leave a following A send a reply.
  for (const pre of ['command -v set -n; ', 'command -V set; ', 'command -pv set; ', 'command -v node; ', 'hash -r; ', 'trap -p; ', 'alias; ', 'set -e; ', 'echo "set -n"; ']) {
    for (const [tool, sig] of r9(`${pre}${r7aC4}`)) {
      assert.deepEqual(sig.replies, R7_REPLY_A, `${tool}: ${pre}`);
      assert.equal(sig.external, undefined, `${tool}: ${pre}`);
    }
  }
  // A send before the stopping command is still a reply.
  for (const [tool, sig] of r9(`${r7aC4}; exit 0; ${r7bC4}`)) {
    assert.deepEqual(sig.replies, R7_REPLY_A, tool);
    assert.equal(sig.external, true, tool);
  }
  // `command -v` itself names but never runs a send.
  for (const [tool, sig] of r9(`command -v node /x/c4-send.js openmax ${R6_A} hi`)) assert.deepEqual(sig, {}, tool);
});

test('review R10 sweep: wrappers, computed interpreters and shell startup files', () => {
  const comm = `src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`;
  for (const cmd of [
    `sudo node -r ./h.cjs ${comm}`, `xargs node ${comm}`, `$NODE ${comm}`, `NODE="node -r ./h.cjs"; $NODE ${comm}`,
    `export NODE_OPTIONS=x; "$NODE" ${comm}`,
    `BASH_ENV=./rc.sh bash -c '${r7aC4}'`, `env BASH_ENV=./rc.sh bash -c '${r7aC4}'`, `export BASH_ENV=./rc.sh; bash -c '${r7aC4}'`,
    `ENV=./rc.sh sh -c '${r7aC4}'` /* dash ignores ENV here; kept conservative */, `bash --rcfile ./rc.sh -i -c '${r7aC4}'`,
  ]) {
    for (const [tool, sig] of r9(cmd)) assertPause(sig, `${tool}: ${cmd}`);
  }
  // Controls.
  for (const [tool, sig] of r9(`"$NODE" ${comm}`)) assert.deepEqual(sig.replies, [{ channel: 'openmax', conversationId: R6_A }], tool);
  for (const [tool, sig] of r9(`FOO=1 bash -c '${r7aC4}'`)) assert.deepEqual(sig.replies, R7_REPLY_A, tool);
});

// ── review R11: prefix execution context; env taint into nested scripts ──
const R11_COMM = `src/cli/comm.js comm.send '{"conversationId":"${R6_A}"}'`;
const R11_REPLY = [{ channel: 'openmax', conversationId: R6_A }];
// Real bash 5.2: each fails before node runs ("not a shell builtin" / "exec: X: not found").
const R11_FAILING_PREFIXES = [
  'builtin node', 'command builtin node', 'exec builtin node', 'exec command node', 'builtin -- node',
  'builtin command builtin node', 'exec -a altered builtin node', 'exec command -p node', 'builtin builtin node',
  'nohup builtin node', 'builtin time node', 'builtin nohup node', 'exec exec node', 'nohup command node',
];
// Real bash 5.2: node runs.
const R11_RUNNING_PREFIXES = [
  'builtin command node', 'builtin exec node', 'command -p node', 'command -- node', 'time -p node', 'command exec node',
  'command command node', 'builtin command -p -- node', 'timeout -s KILL 5 node', 'nice -n 5 node', 'nohup -- node',
];

test('review R11-1: a prefix whose target lookup fails runs nothing — never a reply', () => {
  for (const pre of R11_FAILING_PREFIXES) {
    for (const [tool, sig] of r9(`${pre} ${R11_COMM}`)) assertPause(sig, `${tool}: ${pre}`);
    // …and anything after it is not proven either.
    for (const [tool, sig] of r9(`${pre} x; ${r7aC4}`)) assertPause(sig, `${tool}: ${pre} x; A`);
  }
  for (const pre of R11_RUNNING_PREFIXES) {
    for (const [tool, sig] of r9(`${pre} ${R11_COMM}`)) {
      assert.deepEqual(sig.replies, R11_REPLY, `${tool}: ${pre}`);
      assert.equal(sig.external, undefined, `${tool}: ${pre}`);
    }
  }
  // Prefixes of a runtime set: `builtin set -n` stops the rest; `exec set` exits the shell;
  // `nohup set` fails and the send runs — but a failed lookup is not proof either way: pause.
  for (const pre of ['builtin set -n; ', 'command builtin set -n; ', 'exec set -n; ', 'nohup set -n; ']) {
    for (const [tool, sig] of r9(`${pre}${r7aC4}`)) assertPause(sig, `${tool}: ${pre}`);
  }
});

test('review R11-2: NODE_OPTIONS / PATH reach nested scripts, eval and += assignments', () => {
  const inner = `node src/cli/comm.js comm.send "{\\"conversationId\\":\\"${R6_A}\\"}"`;
  for (const cmd of [
    `NODE_OPTIONS='--import=x --require=hookB' bash -c '${inner}'`,
    `NODE_OPTIONS=--require=hookB bash -c 'node --check src/cli/comm.js comm.send x'`,
    `NODE_OPTIONS=--require=hookB sh -c '${inner}'`,
    `env NODE_OPTIONS=--require=hookB bash -c '${inner}'`,
    `PATH=/evil:$PATH bash -c '${inner}'`,
    `NODE_OPTIONS=--require=hookB eval '${inner}'`,
    `NODE_OPTIONS=--require=hookB eval true; ${inner}`,
    `NODE_OPTIONS+=' --require=hookB'; ${inner}`,
    `NODE_OPTIONS[0]=--require=hookB; export NODE_OPTIONS; ${inner}`,
    `set -a; NODE_OPTIONS=--require=hookB; ${inner}`,
    `declare -x NODE_OPTIONS=--require=hookB; ${inner}`, `typeset -x NODE_OPTIONS=x; ${inner}`,
    `readonly NODE_OPTIONS=x; ${inner}`, `local NODE_OPTIONS=x; ${inner}`, `export NODE_OPTIONS+=x; ${inner}`,
    `read -r NODE_OPTIONS < f; ${inner}`, `printf -v NODE_OPTIONS %s x; ${inner}`, `declare -n r=NODE_OPTIONS; r=x; ${inner}`,
    `bash -c 'export NODE_OPTIONS=x; ${inner}'`, `eval 'export NODE_OPTIONS=x'; ${inner}`,
    `env -u NODE_OPTIONS ${inner}`, `env -i ${inner}`,
  ]) {
    for (const [tool, sig] of r9(cmd)) assertPause(sig, `${tool}: ${cmd}`);
  }
  // Controls: an unrelated prefix / variable, and a child shell's export does not leak to its parent.
  for (const cmd of [`FOO=1 bash -c '${inner}'`, `FOO+=1; ${inner}`, `bash -c 'export NODE_OPTIONS=x'; ${inner}`, `echo hi; ${inner}`]) {
    for (const [tool, sig] of r9(cmd)) {
      assert.deepEqual(sig.replies, R11_REPLY, `${tool}: ${cmd}`);
      assert.equal(sig.external, undefined, `${tool}: ${cmd}`);
    }
  }
});

// ── review R12: wrapper option shapes and operands ──
// Real coreutils 9.4 / bash 5.2: each exits (help / version / usage error) before running node.
const R12_FAILING = [
  'timeout --help 5 node', 'timeout --version 5 node', 'timeout --bogus 5 node', 'timeout nope node', 'timeout 5x node',
  'timeout -1 node', 'timeout -s INVALID 5 node', 'timeout -s "" 5 node', 'timeout -k nope 5 node', 'timeout -k "" 5 node',
  'timeout --signal= 5 node', 'timeout -s $SIG 5 node', 'timeout $D node', 'timeout node',
  'nice -n nope node', 'nice -n "" node', 'nice -n 5.5 node', 'nice --adjustment= node', 'nice --help node', 'nice --version node', 'nice -n $N node',
  'nohup --help node', 'nohup --version node', 'nohup -x node',
  'env --help node', 'env --version node', 'env -u "" node', 'env -u A=B node', 'env -0 node',
  'exec -x node', 'command -x node', 'builtin -x node',
];
// Real: node runs (a reply when nothing else is unprovable).
const R12_RUNNING = [
  'timeout -s KILL 5 node', 'timeout -k 1 5 node', 'timeout --signal=KILL 5 node', 'timeout --kill-after=1 5 node',
  'timeout --signal KILL 5 node', 'timeout -s kill 5 node', 'timeout -s SIGTERM 5 node', 'timeout -s 9 5 node', 'timeout -sKILL -k1 1.5s node',
  'timeout --preserve-status --foreground -v 0 node', 'timeout -- 5m node',
  'nice -n 5 node', 'nice --adjustment=5 node', 'nice --adjustment 5 node', 'nice -n5 node', 'nice -n -5 node', 'nice -5 node', 'nice -n +5 node',
  'nohup -- node',
];

test('review R12: wrapper options and operands are verified; anything else runs nothing provable', () => {
  for (const pre of R12_FAILING) {
    for (const [tool, sig] of r9(`${pre} ${R11_COMM}`)) assertPause(sig, `${tool}: ${pre}`);
    for (const [tool, sig] of r9(`${pre.replace(/ node$/, '')} /x/c4-send.js openmax ${R6_A} hi`)) assertPause(sig, `${tool}: ${pre} (c4-send.js run directly)`);
    for (const [tool, sig] of r9(`${pre} x; ${r7aC4}`)) assertPause(sig, `${tool}: ${pre} x; A`);
  }
  for (const pre of R12_RUNNING) {
    for (const [tool, sig] of r9(`${pre} ${R11_COMM}`)) {
      assert.deepEqual(sig.replies, R11_REPLY, `${tool}: ${pre}`);
      assert.equal(sig.external, undefined, `${tool}: ${pre}`);
    }
  }
  // A script run directly (#!/usr/bin/env node) sees NODE_OPTIONS too.
  for (const [tool, sig] of r9(`NODE_OPTIONS=--require=hookB /x/c4-send.js openmax ${R6_A} hi`)) assertPause(sig, tool);
});
