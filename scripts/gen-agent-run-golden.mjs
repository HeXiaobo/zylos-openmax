#!/usr/bin/env node
/**
 * Regenerate the agent_run (schema v3) golden samples:
 *
 *   node scripts/gen-agent-run-golden.mjs
 *
 * - src/lib/activity/testdata/agent_run_producer/<name>.json — one per
 *   PRODUCER_FIXTURES entry: { note, now, run, expected: buildAgentRun(run) },
 *   one per compaction level.
 * - src/lib/activity/testdata/agent_run_v3/ — the shared display examples for
 *   cws-fe (copy verbatim into its fixtures; validators.js has the matching
 *   contract checks):
 *     agent_run.json             full summary (level 0)
 *     agent_run_truncated.json   summary at compaction level 4 (details cut,
 *                                previews removed, links total only)
 *     agent_run_compacted.json   summary at level 6 (steps_omitted note)
 *     agent_run_ref.json         reference form of a later reply of the run
 *     steps_catalog.json         one step per category / detail type
 *     live_frames.json           agent_activity frames of one run, in order
 *     live_frames_failed.json    frames of a run that ends failed
 *
 * compact.test.js / emitter.test.js fail when the committed files differ from
 * what the code produces now: a display change means regenerating here and
 * re-copying to cws-fe.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAgentRun, agentRunRef } from '../src/lib/activity/compact.js';
import { createEmitter } from '../src/lib/activity/emitter.js';
import { eventToStep } from '../src/lib/activity/present.js';
import { PRODUCER_FIXTURES, STEP_CATALOG, T0 } from '../src/lib/activity/testdata/producer-fixtures.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const producerDir = path.join(root, 'src/lib/activity/testdata/agent_run_producer');
const v3Dir = path.join(root, 'src/lib/activity/testdata/agent_run_v3');

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

export function renderSample(fx) {
  const expected = buildAgentRun(fx.run, { now: fx.now });
  return json({ note: fx.note, now: fx.now, run: fx.run, expected });
}

function scripted(fn) {
  let t = T0;
  const frames = [];
  const stats = { events_dropped: 0, frames_sent: 0, frames_dropped: 0, unknown_frame_type: 0, server_errors: {} };
  const em = createEmitter({ now: () => t, stats, throttle: { warn() {} } });
  em.bindOrgWs('org', { trySend: (f) => { frames.push(JSON.parse(JSON.stringify(f))); return true; } });
  const run = {
    run_id: 'r_3fa9c1d2', org_id: 'org', conversation_id: 'c_7Hk2',
    source_message_id: '1849302211', created_at: T0, seq: 0, dropped: 0, step_count: 0,
  };
  em.track(run);
  em.emitNow(run);                                         // probe: queued, no steps
  t += 2500; em.tick();                                    // gate open (heartbeat-free: nothing new)
  const clock = { get t() { return t; }, advance(ms) { t += ms; } };
  fn({ em, run, clock });
  return frames;
}

/** queued → thinking → search (running → ok) → command (error) → write (live preview) → done. */
export function liveFrames() {
  return scripted(({ em, run, clock }) => {
    clock.advance(700);
    run.exec_started_at = clock.t;                         // entered a runtime turn
    em.setState(run, 'thinking');
    em.pushEvent(run, { id: 'e1', kind: 'commentary', text: '字段检查完成，接下来检索公开的地区划分标准。', at: clock.t });
    clock.advance(600); em.tick();
    const s = clock.t;
    run.step_count = 1;
    em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'search_web', object: '中国七大地理分区 划分标准', at: s });
    clock.advance(600); em.tick();
    clock.advance(9000);
    em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'search_web', object: '中国七大地理分区 划分标准', at: s, ended_at: clock.t, error: false,
      detail: { type: 'links', total: 5, truncated: false, items: [
        { title: '中国地理区划 - 百度百科', url: 'https://baike.baidu.com/item/中国地理区划' },
        { title: '七大地理分区', url: 'https://www.example.gov.cn/dqfq/index.html' }] } });
    const c = clock.t;
    run.step_count = 2;
    em.pushEvent(run, { id: 'e3', kind: 'tool', category: 'command', title: '统计缺失地区的记录', at: c });
    clock.advance(600); em.tick();
    clock.advance(1400);
    em.pushEvent(run, { id: 'e3', kind: 'tool', category: 'command', title: '统计缺失地区的记录', at: c, ended_at: clock.t, error: true,
      detail: { type: 'output', exit_code: 1, lines: 4, truncated: false } });
    const w = clock.t;
    run.step_count = 3;
    const diff = { type: 'diff', file: '销售地区汇总.md', added: 6, removed: 0, preview: '| 地区 | 销售额 |\n| --- | --- |\n| 华东 | 1,284,000 |', truncated: false };
    em.pushEvent(run, { id: 'e4', kind: 'tool', category: 'write', object: '销售地区汇总.md', live_preview: true, at: w, detail: diff });
    clock.advance(600); em.tick();
    em.pushEvent(run, { id: 'e4', kind: 'tool', category: 'write', object: '销售地区汇总.md', live_preview: true, at: w, ended_at: clock.t, error: false, detail: diff });
    em.pushEvent(run, { id: 'e5', kind: 'notice', code: 'merged_turn', at: clock.t });
    clock.advance(600); em.tick();
    clock.advance(10_000); em.tick();                      // heartbeat: no steps, same state
    clock.advance(300);
    em.finish(run, 'done');
  });
}

/** queued → thinking → a command still running → failed (runtime_restarted). */
export function liveFramesFailed() {
  return scripted(({ em, run, clock }) => {
    clock.advance(4000);
    run.exec_started_at = clock.t;
    em.setState(run, 'thinking');
    run.step_count = 1;
    em.pushEvent(run, { id: 'e1', kind: 'tool', category: 'command', title: 'Run the full test suite', at: clock.t });
    clock.advance(600); em.tick();
    clock.advance(20_000);
    em.finish(run, 'failed', 'runtime_restarted');
  });
}

export function v3Examples() {
  const by = (n) => PRODUCER_FIXTURES.find((f) => f.name === n);
  const common = by('level0_common');
  const truncated = by('level4_links_total_only');
  const folded = by('level6_omitted');
  return {
    'agent_run.json': json(buildAgentRun(common.run, { now: common.now })),
    'agent_run_truncated.json': json(buildAgentRun(truncated.run, { now: truncated.now })),
    'agent_run_compacted.json': json(buildAgentRun(folded.run, { now: folded.now })),
    'agent_run_ref.json': json(agentRunRef(common.run.run_id)),
    'steps_catalog.json': json(STEP_CATALOG.map(eventToStep).filter(Boolean)),
    'live_frames.json': json(liveFrames()),
    'live_frames_failed.json': json(liveFramesFailed()),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.rmSync(producerDir, { recursive: true, force: true });
  fs.mkdirSync(producerDir, { recursive: true });
  for (const fx of PRODUCER_FIXTURES) fs.writeFileSync(path.join(producerDir, `${fx.name}.json`), renderSample(fx));
  fs.rmSync(v3Dir, { recursive: true, force: true });
  fs.mkdirSync(v3Dir, { recursive: true });
  const ex = v3Examples();
  for (const [name, body] of Object.entries(ex)) fs.writeFileSync(path.join(v3Dir, name), body);
  console.log(`wrote ${PRODUCER_FIXTURES.length} producer samples and ${Object.keys(ex).length} v3 examples`);
}
