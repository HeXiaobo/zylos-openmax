import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexSessionReader, readZylosRuntime } from './codex-session.js';

// Fixtures live in a throwaway temp dir — the real ~/.codex is never touched.
function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-test-'));
  const codexHome = path.join(root, '.codex');
  const zylosDir = path.join(root, 'zylos');
  fs.mkdirSync(zylosDir, { recursive: true });
  return { root, codexHome, zylosDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const pad = (n) => String(n).padStart(2, '0');

/** Write a rollout whose dir/name use the epoch's UTC fields (any tz is within the slack). */
function writeRollout(codexHome, { at, id, source = 'cli', cwd, partial = false, type = 'session_meta' }) {
  const d = new Date(at);
  const [y, mo, da] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())];
  const stamp = `${y}-${mo}-${da}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  const dir = path.join(codexHome, 'sessions', String(y), mo, da);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: new Date(at + 1500).toISOString(),
    type,
    payload: { id, session_id: id, timestamp: new Date(at).toISOString(), cwd, originator: 'codex-tui', source, base_instructions: { text: 'x'.repeat(70_000) } },
  };
  const line = JSON.stringify(meta);
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, partial ? line.slice(0, 100) : `${line}\n{"type":"event_msg"}\n`);
  return file;
}

const LAUNCH = Date.UTC(2026, 10, 3, 6, 22, 25);

test('readCodexSession: 取本轮 launch 后最新的前台 cli thread，忽略 subagent / exec / 其它 cwd', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH - 3600_000, id: 'old-cli', cwd: h.zylosDir });
  writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'main', cwd: h.zylosDir });
  writeRollout(h.codexHome, { at: LAUNCH + 60_000, id: 'sub', cwd: h.zylosDir, source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } } });
  writeRollout(h.codexHome, { at: LAUNCH + 70_000, id: 'exec', cwd: h.zylosDir, source: 'exec' });
  writeRollout(h.codexHome, { at: LAUNCH + 80_000, id: 'elsewhere', cwd: '/tmp/other' });

  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 100_000 });
  const s = read({ launchAt: LAUNCH });
  assert.equal(s.session_id, 'main');
  assert.equal(s.started_at, LAUNCH + 9_000);
});

test('readCodexSession: 只有早于 launch 的 thread ⇒ 返回它（由 gate 判 predates）', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH - 60_000, id: 'prev', cwd: h.zylosDir });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 10_000 });
  const s = read({ launchAt: LAUNCH });
  assert.equal(s.session_id, 'prev');
  assert.ok(s.started_at < LAUNCH);
});

test('readCodexSession: 远早于 launch 的目录/文件根本不读；没有 sessions 目录 ⇒ null', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH });
  assert.equal(read({ launchAt: LAUNCH }), null);

  writeRollout(h.codexHome, { at: LAUNCH - 5 * 24 * 3600_000, id: 'ancient', cwd: h.zylosDir });
  const read2 = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH });
  assert.equal(read2({ launchAt: LAUNCH }), null);
});

test('readCodexSession: 首行还没写完 ⇒ 这次不算、不缓存，写完后能读到', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  let clock = LAUNCH + 5_000;
  const file = writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'booting', cwd: h.zylosDir, partial: true });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => clock, minScanIntervalMs: 5000 });
  assert.equal(read({ launchAt: LAUNCH }), null);

  writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'booting', cwd: h.zylosDir });
  assert.ok(fs.existsSync(file));
  assert.equal(read({ launchAt: LAUNCH }), null, 'throttled: no rescan inside minScanIntervalMs');
  clock += 5000;
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'booting');
});

test('readCodexSession: 非 session_meta 首行 / 坏 JSON ⇒ 忽略', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH + 1_000, id: 'weird', cwd: h.zylosDir, type: 'response_item' });
  const dir = path.dirname(writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'ok', cwd: h.zylosDir }));
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-03T06-30-00-bad.jsonl'), '{not json\n');
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 600_000 });
  assert.equal(read({ launchAt: LAUNCH }).session_id, 'ok');
});

test('readCodexSession: launch 改变时立即重扫（不吃旧缓存）', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'first', cwd: h.zylosDir });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 3_600_000 });
  assert.equal(read({ launchAt: LAUNCH }).session_id, 'first');
  const relaunch = LAUNCH + 1_800_000;
  writeRollout(h.codexHome, { at: relaunch + 3_000, id: 'second', cwd: h.zylosDir });
  assert.equal(read({ launchAt: relaunch }).session_id, 'second');
});

test('readZylosRuntime: 读 .zylos/config.json 的 runtime；缺失/坏文件 ⇒ null', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  assert.equal(readZylosRuntime(h.zylosDir), null);
  fs.mkdirSync(path.join(h.zylosDir, '.zylos'));
  fs.writeFileSync(path.join(h.zylosDir, '.zylos', 'config.json'), '{"runtime":"codex"}');
  assert.equal(readZylosRuntime(h.zylosDir), 'codex');
  fs.writeFileSync(path.join(h.zylosDir, '.zylos', 'config.json'), '{oops');
  assert.equal(readZylosRuntime(h.zylosDir), null);
});

test('an explicit default runtime applies only to missing or unset configuration', () => {
  const missing = { readFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
  assert.equal(readZylosRuntime('/isolated', { fsImpl: missing, defaultRuntime: 'claude' }), 'claude');
  for (const [text, expected] of [['{}', 'claude'], ['{"runtime":"codex"}', 'codex'], ['{"runtime":null}', null], ['null', null], ['broken', null]]) {
    assert.equal(readZylosRuntime('/isolated', { fsImpl: { readFileSync: () => text }, defaultRuntime: 'claude' }), expected);
  }
});

// ---------------------------------------------------------------------------
// Day-folder / file-name pruning and realpath matching.
// ---------------------------------------------------------------------------

/**
 * Write a rollout under an explicit local-time name `YYYY-MM-DDTHH-MM-SS`, with
 * a session_meta creation time (`metaAt`) independent of the name. A "lure"
 * (old name, new metaAt) wins the newest-thread pick if it is ever opened, so
 * pruning is observable in the result, not only through the fs spy.
 */
function writeNamedRollout(codexHome, stamp, { id, metaAt, cwd, source = 'cli' }) {
  const [, y, mo, da] = /^(\d{4})-(\d{2})-(\d{2})T/.exec(stamp);
  const dir = path.join(codexHome, 'sessions', y, mo, da);
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date(metaAt).toISOString();
  const meta = { timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, originator: 'codex-tui', source } };
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
  return file;
}

/** The real fs, recording every directory listed and every file opened. */
function spyFs() {
  const listed = [];
  const opened = [];
  const fsImpl = {
    readdirSync: (dir, ...rest) => { listed.push(dir); return fs.readdirSync(dir, ...rest); },
    openSync: (file, ...rest) => { opened.push(file); return fs.openSync(file, ...rest); },
    readSync: (...args) => fs.readSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    realpathSync: (...args) => fs.realpathSync(...args),
  };
  return { fsImpl, listed, opened };
}

/** `sessions/`-relative, '/'-joined, sorted. */
const relSessions = (codexHome, paths) => paths
  .map((p) => path.relative(path.join(codexHome, 'sessions'), p).split(path.sep).join('/'))
  .sort();

test('readCodexSession 剪枝: 早于 launch − 1 天的年/月/日目录不 list，cutoff 之前的文件不 open（即使它会胜出）', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  // LAUNCH = 2026-11-03T06:22:25Z ⇒ cutoff = 2026-11-02T06:22:25Z (cutoff day 2026-11-02).
  // Every lure claims a creation time after the real thread: opening any of them changes the result.
  const lure = { cwd: h.zylosDir, metaAt: LAUNCH + 3_600_000 };
  writeNamedRollout(h.codexHome, '2025-12-31T23-59-59', { id: 'old-year', ...lure });
  writeNamedRollout(h.codexHome, '2026-10-31T23-59-59', { id: 'old-month', ...lure });
  writeNamedRollout(h.codexHome, '2026-11-01T23-59-59', { id: 'old-day', ...lure });
  writeNamedRollout(h.codexHome, '2026-11-02T06-22-24', { id: 'pre-cutoff', ...lure }); // cutoff day, 1 s too old
  const main = writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'main', cwd: h.zylosDir });

  const spy = spyFs();
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, fsImpl: spy.fsImpl, now: () => LAUNCH + 100_000 });
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'main');
  assert.deepEqual(relSessions(h.codexHome, spy.listed), ['', '2026', '2026/11', '2026/11/02', '2026/11/03'],
    'only the cutoff day and later are listed (2025, 2026/10, 2026/11/01 are pruned)');
  assert.deepEqual(spy.opened, [main], 'the pre-cutoff file in the cutoff-day folder is never opened');
});

test('readCodexSession 剪枝边界: cutoff 当天目录、名字时间 ≥ launch − 1 天的文件仍会读到（时区 slack）', (t) => {
  const cases = [
    { stamp: '2026-11-02T06-22-25', found: true, why: 'name time == launch − 1 day (the cutoff itself)' },
    { stamp: '2026-11-02T06-22-24', found: false, why: 'name time 1 s before the cutoff' },
    { stamp: '2026-11-02T18-22-26', found: true, why: 'UTC−12 host: a thread created 1 s after launch is named launch − 12 h' },
    { stamp: '2026-11-03T20-22-26', found: true, why: 'UTC+14 host: named launch + 14 h' },
  ];
  for (const c of cases) {
    const h = makeHome();
    t.after(h.cleanup);
    // metaAt after launch: the file qualifies whenever it is opened, so `null` means "skipped by name".
    const file = writeNamedRollout(h.codexHome, c.stamp, { id: 'x', cwd: h.zylosDir, metaAt: LAUNCH + 1_000 });
    const spy = spyFs();
    const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, fsImpl: spy.fsImpl, now: () => LAUNCH + 100_000 });
    assert.equal(read({ launchAt: LAUNCH })?.session_id ?? null, c.found ? 'x' : null, c.why);
    assert.deepEqual(spy.opened, c.found ? [file] : [], `${c.why}: opened`);
  }
});

test('readCodexSession 剪枝边界: 跨年 launch 仍列出上一年 12/31，之前的月/日不 list', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const launch = Date.UTC(2027, 0, 1, 3, 0, 0); // cutoff = 2026-12-31T03:00:00Z
  const lure = { cwd: h.zylosDir, metaAt: launch + 3_600_000 };
  writeNamedRollout(h.codexHome, '2026-11-30T23-59-59', { id: 'old-month', ...lure });
  writeNamedRollout(h.codexHome, '2026-12-30T23-59-59', { id: 'old-day', ...lure });
  // UTC−12 host: a thread created 1 s after launch is named 2026-12-31T15-00-01.
  writeNamedRollout(h.codexHome, '2026-12-31T15-00-01', { id: 'nye', cwd: h.zylosDir, metaAt: launch + 1_000 });

  const spy = spyFs();
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, fsImpl: spy.fsImpl, now: () => launch + 100_000 });
  assert.equal(read({ launchAt: launch })?.session_id, 'nye');
  assert.deepEqual(relSessions(h.codexHome, spy.listed), ['', '2026', '2026/12', '2026/12/31']);
});

/** zylos dir as a real directory plus a symlink to it; also an unrelated real dir. */
function linkedZylos(h) {
  const real = fs.realpathSync(h.zylosDir);
  const link = path.join(h.root, 'zylos-link');
  fs.symlinkSync(real, link, 'dir');
  const other = `${real}-other`;
  fs.mkdirSync(other);
  return { real, link, other };
}

test('readCodexSession realpath: zylos dir 经 symlink、thread cwd 记的是真实路径 ⇒ 仍匹配', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const { real, link } = linkedZylos(h);
  assert.notEqual(link, real);
  writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'via-real', cwd: real });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: link, now: () => LAUNCH + 100_000 });
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'via-real');
});

test('readCodexSession realpath: zylos dir 经 symlink、thread cwd 记的也是 symlink 路径 ⇒ 匹配', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const { link } = linkedZylos(h);
  writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'via-link', cwd: link });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: link, now: () => LAUNCH + 100_000 });
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'via-link');
});

test('readCodexSession realpath: 另一个真实目录 / 指向别处的 symlink / 父目录 ⇒ 不匹配', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const { real, link, other } = linkedZylos(h);
  const otherLink = path.join(h.root, 'other-link');
  fs.symlinkSync(other, otherLink, 'dir');
  writeRollout(h.codexHome, { at: LAUNCH + 1_000, id: 'zylos', cwd: real });
  writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'other-real', cwd: other });
  writeRollout(h.codexHome, { at: LAUNCH + 3_000, id: 'other-link', cwd: otherLink });
  writeRollout(h.codexHome, { at: LAUNCH + 4_000, id: 'parent', cwd: path.dirname(real) });
  for (const zylosDir of [link, real]) {
    const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir, now: () => LAUNCH + 100_000 });
    assert.equal(read({ launchAt: LAUNCH })?.session_id, 'zylos', `zylosDir=${zylosDir}`);
  }
});

test('readCodexSession realpath: zylos dir 尚不存在（realpath 抛错）⇒ 按字面路径匹配', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const missing = path.join(h.root, 'not-yet');
  writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'literal', cwd: missing });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: missing, now: () => LAUNCH + 100_000 });
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'literal');
});
