#!/usr/bin/env node
/**
 * Regenerate the metadata.agent_run producer golden samples from
 * src/lib/activity/testdata/producer-fixtures.js:
 *
 *   node scripts/gen-agent-run-golden.mjs [outDir]
 *
 * Default outDir: src/lib/activity/testdata/agent_run_producer/. compact.test.js
 * fails when the committed samples differ from what compact.js produces now, so
 * a change to compact.js means regenerating here and contributing the samples
 * to cws-comm (internal/app/testdata/agent_run_golden/producer/).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAgentRun } from '../src/lib/activity/compact.js';
import { PRODUCER_FIXTURES } from '../src/lib/activity/testdata/producer-fixtures.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] || path.join(root, 'src/lib/activity/testdata/agent_run_producer');

export function renderSample(fx) {
  const expected = buildAgentRun(fx.run, { now: fx.now });
  return `${JSON.stringify({ note: fx.note, now: fx.now, run: fx.run, expected }, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const fx of PRODUCER_FIXTURES) {
    fs.writeFileSync(path.join(outDir, `${fx.name}.json`), renderSample(fx));
  }
  console.log(`wrote ${PRODUCER_FIXTURES.length} samples to ${outDir}`);
}
