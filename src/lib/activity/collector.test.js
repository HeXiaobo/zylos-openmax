import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollector, encodeProjectDir } from './collector.js';

function setup({ runtime = 'claude', codexQuery } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-col-'));
  const zylos = path.join(home, 'zylos');
  fs.mkdirSync(zylos, { recursive: true });
  const dir = path.join(home, '.claude/projects', encodeProjectDir(fs.realpathSync(zylos)));
  fs.mkdirSync(path.join(dir, 'sess/subagents'), { recursive: true });
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const inputs = [];
  const flags = { degraded: 0, recovered: 0, unknown: 0, restarts: 0 };
  const attribution = {
    turn: null,
    openRuns: () => [{ created_at: t - 1000 }],
    handle: (ev, { file }) => inputs.push({ ...ev, file }),
    degradeAll: () => { flags.degraded += 1; },
    recover: () => { flags.recovered += 1; },
    noteUnknownShape: () => { flags.unknown += 1; },
    noteRuntimeRestart: () => { flags.restarts += 1; },
  };
  const stats = { parse_errors: 0, parse_unknown_shape: 0 };
  const warns = [];
  const col = createCollector({ runtime, homeDir: home, zylosDir: zylos, attribution, stats, warn: (m) => warns.push(m), now: clock.now, codexQuery });
  const sid = '11111111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, '');
  const line = (rec) => `${JSON.stringify({ isSidechain: false, sessionId: sid, timestamp: new Date(t).toISOString(), ...rec })}\n`;
  return { col, clock, inputs, flags, stats, warns, dir, file, line, attribution };
}

test('encodeProjectDir mirrors Claude Code (every non-alphanumeric → -)', () => {
  assert.equal(encodeProjectDir('/home/cocoai/zylos'), '-home-cocoai-zylos');
  assert.equal(encodeProjectDir('/a/b.c_d'), '-a-b-c-d');
});

test('reads root session logs only; half lines are buffered until complete', async () => {
  const { col, inputs, file, line, dir } = setup();
  fs.writeFileSync(path.join(dir, 'sess/subagents/agent-1.jsonl'), line({ type: 'system', subtype: 'turn_duration', uuid: 'sub' }));
  await col.discover();
  assert.deepEqual([...col.files.keys()], [file]);
  const l = line({ type: 'system', subtype: 'turn_duration', uuid: 'a' });
  fs.appendFileSync(file, l.slice(0, 20));
  col.poll();
  assert.equal(inputs.length, 0);
  fs.appendFileSync(file, l.slice(20));
  col.poll();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].t, 'turn_end');
});

test('uuid dedupe; truncation re-reads from the start without replaying', async () => {
  const { col, inputs, file, line } = setup();
  await col.discover();
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'a' }) + line({ type: 'system', subtype: 'turn_duration', uuid: 'a' }));
  col.poll();
  assert.equal(inputs.length, 1);
  fs.writeFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'b' }));
  col.poll();
  assert.equal(inputs.length, 2);
});

test('records outside the open-run window are skipped; bad JSON counted; 100 in a row → status-only', async () => {
  const { col, inputs, file, line, clock, stats, flags, warns } = setup();
  await col.discover();
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'old', timestamp: new Date(clock.now() - 60_000).toISOString() }));
  col.poll();
  assert.equal(inputs.length, 0);
  fs.appendFileSync(file, '{oops\n'.repeat(100));
  col.poll();
  assert.equal(stats.parse_errors, 100);
  assert.equal(flags.degraded, 1);
  assert.equal(warns.length, 1, 'logged once on the state change, not per line');
});

test('unknown shapes: counted, the run degrades, never handed on', async () => {
  const { col, inputs, file, line, stats, flags } = setup();
  await col.discover();
  fs.appendFileSync(file, line({ type: 'assistant', uuid: 'x', message: { content: 'not-an-array' } }));
  col.poll();
  assert.equal(stats.parse_unknown_shape, 1);
  assert.equal(flags.unknown, 1);
  assert.equal(inputs.length, 0);
});

// Pad a valid JSON record to exactly `bytes` bytes (newline excluded).
function recordOfSize(line, uuid, bytes) {
  const base = line({ type: 'system', subtype: 'turn_duration', uuid, pad: '' }).trimEnd();
  const rec = JSON.parse(base);
  rec.pad = 'x'.repeat(bytes - Buffer.byteLength(base));
  const s = JSON.stringify(rec);
  assert.equal(Buffer.byteLength(s), bytes);
  return `${s}\n`;
}

test('line cap is on the whole line: exactly 4 MiB parses, 4 MiB + 1 is dropped, later records still parse', async () => {
  const { col, inputs, file, line, stats } = setup();
  await col.discover();
  col.poll();   // leave the idle state first (idle → active skips to the last 2 MiB)
  const MiB4 = 4 * 1024 * 1024;
  fs.appendFileSync(file, recordOfSize(line, 'exact', MiB4));
  for (let i = 0; i < 6; i++) col.poll();
  assert.equal(inputs.length, 1, 'exactly 4 MiB is accepted');
  fs.appendFileSync(file, recordOfSize(line, 'over', MiB4 + 1));
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'small' }));
  for (let i = 0; i < 6; i++) col.poll();
  assert.equal(stats.lines_oversized, 1);
  assert.deepEqual(inputs.map((e) => e.t), ['turn_end', 'turn_end'], 'the over-limit line is dropped, the small one parsed');
  assert.equal(stats.parse_errors, 0);
});

test('a 4 MiB + 10 byte complete line (valid JSON) is dropped, not parsed', async () => {
  const { col, inputs, file, line, stats } = setup();
  await col.discover();
  col.poll();
  fs.appendFileSync(file, recordOfSize(line, 'big', 4 * 1024 * 1024 + 10));
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'ok' }));
  for (let i = 0; i < 8; i++) col.poll();
  assert.equal(stats.lines_oversized, 1);
  assert.equal(inputs.length, 1);
});

test('a line far over the cap (incomplete tail grows past it) is skipped as well', async () => {
  const { col, inputs, file, line, stats } = setup();
  await col.discover();
  col.poll();
  fs.appendFileSync(file, `${'x'.repeat(5 * 1024 * 1024)}\n`);
  for (let i = 0; i < 7; i++) col.poll();
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', uuid: 'ok' }));
  for (let i = 0; i < 2; i++) col.poll();
  assert.equal(stats.lines_oversized, 1);
  assert.equal(inputs.length, 1);
});

test('discovery: missing log dir → status-only with one warn; no open run → nothing read', async () => {
  const s = setup();
  fs.rmSync(path.dirname(s.file), { recursive: true });
  await s.col.discover();
  assert.equal(s.col.statusOnly, true);
  assert.equal(s.flags.degraded, 1);
  const idle = setup();
  idle.attribution.openRuns = () => [];
  fs.appendFileSync(idle.file, idle.line({ type: 'system', subtype: 'turn_duration', uuid: 'z' }));
  await idle.col.discover();
  idle.col.poll();
  assert.equal(idle.col.files.size, 0);
  assert.equal(idle.inputs.length, 0);
});

test('codex: rollout paths come from the sqlite query; sqlite failure → status-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-codex-'));
  const rollout = path.join(home, 'rollout.jsonl');
  const now = Date.now();
  fs.writeFileSync(rollout, '');
  const s = setup({ runtime: 'codex', codexQuery: async () => [rollout] });
  await s.col.discover();
  assert.deepEqual([...s.col.files.keys()], [rollout]);
  fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  s.col.poll();
  assert.equal(s.inputs[0].t, 'turn_end');
  const bad = setup({ runtime: 'codex', codexQuery: async () => { throw new Error('no sqlite3'); } });
  await bad.col.discover();
  assert.equal(bad.col.statusOnly, true);
});

test('runtime restart: the turn\'s log stops while another grows for 120 s', async () => {
  const { col, file, dir, clock, flags, attribution, line } = setup();
  await col.discover();
  attribution.turn = { file };
  const other = path.join(dir, '99999999-2222-3333-4444-555555555555.jsonl');
  fs.writeFileSync(other, '');
  clock.advance(1000);
  await col.discover();
  fs.appendFileSync(other, line({ type: 'mode', uuid: 'm' }));
  clock.advance(121_000);
  col.poll();
  assert.equal(flags.restarts, 1);
});
