#!/usr/bin/env node
/**
 * Regenerate the agent_run (schema v2) golden samples:
 *
 *   node scripts/gen-agent-run-golden.mjs
 *
 * - src/lib/activity/testdata/agent_run_producer/<name>.json — one per
 *   PRODUCER_FIXTURES entry: { note, now, run, expected: buildAgentRun(run) }.
 * - src/lib/activity/testdata/agent_run_v2/ — the shared display examples for
 *   cws-fe (copy verbatim into its agent_run_golden fixtures):
 *     agent_run.json            full summary (level 0)
 *     agent_run_compacted.json  folded summary (level 5, group step)
 *     agent_run_ref.json        reference form of a later reply of the run
 *     live_frames.json          the agent_activity frames of one run, in order
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
import { PRODUCER_FIXTURES } from '../src/lib/activity/testdata/producer-fixtures.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const producerDir = path.join(root, 'src/lib/activity/testdata/agent_run_producer');
const v2Dir = path.join(root, 'src/lib/activity/testdata/agent_run_v2');

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

export function renderSample(fx) {
  const expected = buildAgentRun(fx.run, { now: fx.now });
  return json({ note: fx.note, now: fx.now, run: fx.run, expected });
}

/** Frames of one scripted run (thinking → Bash/node → commentary → done), as cws-comm receives them. */
export function liveFrames() {
  const T0 = 1760000523000;
  let t = T0;
  const frames = [];
  const stats = { events_dropped: 0, frames_sent: 0, frames_dropped: 0, unknown_frame_type: 0, server_errors: {} };
  const em = createEmitter({ now: () => t, stats, throttle: { warn() {} } });
  em.bindOrgWs('org', { trySend: (f) => { frames.push(JSON.parse(JSON.stringify(f))); return true; } });
  const run = {
    run_id: 'r_8c1f2a9d', org_id: 'org', conversation_id: '019f0000-aaaa-7bbb-8ccc-000000000001',
    source_message_id: '7383920118271', created_at: T0, seq: 0, dropped: 0,
  };
  em.track(run);
  em.emitNow(run);                                         // probe: queued, no steps
  t += 2500; em.tick();                                    // gate open
  em.setState(run, 'thinking');
  em.pushEvent(run, { id: 'e1', kind: 'commentary', text: '先跑一下报价脚本，再核对文档。', at: t });
  t += 600; em.tick();
  em.setState(run, 'tool', 'command', { tool: 'Bash', detail: 'node' });
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', description: '运行报价脚本', at: t });
  t += 600; em.tick();
  em.pushEvent(run, { id: 'e2', kind: 'tool', category: 'command', tool: 'Bash', detail: 'node', at: t - 600, ended_at: t, error: true });
  em.setState(run, 'thinking');
  em.pushEvent(run, { id: 'e3', kind: 'notice', code: 'merged_turn', at: t });
  t += 600; em.tick();
  em.pushEvent(run, { id: 'e4', kind: 'tool', category: 'reply', tool: 'Bash', detail: 'node', at: t, ended_at: t + 200, error: false });
  t += 300;
  em.finish(run, 'done');
  return frames;
}

export function v2Examples() {
  const common = PRODUCER_FIXTURES.find((f) => f.name === 'level0_common');
  const folded = PRODUCER_FIXTURES.find((f) => f.name === 'level5_folded');
  return {
    'agent_run.json': json(buildAgentRun(common.run, { now: common.now })),
    'agent_run_compacted.json': json(buildAgentRun(folded.run, { now: folded.now })),
    'agent_run_ref.json': json(agentRunRef(common.run.run_id)),
    'live_frames.json': json(liveFrames()),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.rmSync(producerDir, { recursive: true, force: true });
  fs.mkdirSync(producerDir, { recursive: true });
  for (const fx of PRODUCER_FIXTURES) fs.writeFileSync(path.join(producerDir, `${fx.name}.json`), renderSample(fx));
  fs.mkdirSync(v2Dir, { recursive: true });
  const ex = v2Examples();
  for (const [name, body] of Object.entries(ex)) fs.writeFileSync(path.join(v2Dir, name), body);
  console.log(`wrote ${PRODUCER_FIXTURES.length} producer samples and ${Object.keys(ex).length} v2 examples`);
}
