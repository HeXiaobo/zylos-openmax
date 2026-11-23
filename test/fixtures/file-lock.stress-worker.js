// Child process for src/lib/file-lock.test.js (not a test file itself; kept
// out of src/ and out of the npm package — see .npmignore): for each
// round, wait for the round's start time, then try to consume the round's
// single-use record under withPendingLock. Prints one JSON line of results.
import fs from 'node:fs';
import { withPendingLock } from '../../src/lib/pending-question.js';

const [dir, roundsArg, t0Arg, stepArg] = process.argv.slice(2);
const rounds = Number(roundsArg);
const t0 = Number(t0Arg);
const step = Number(stepArg);
const cell = new Int32Array(new SharedArrayBuffer(4));
const out = { won: [], overlap: 0, errors: [] };
for (let r = 0; r < rounds; r += 1) {
  const start = t0 + r * step;
  while (Date.now() < start) { /* barrier: spin until the round starts */ }
  const file = `${dir}/round-${r}.json`;
  try {
    withPendingLock(file, () => {
      const inside = `${file}.inside`;
      try { fs.writeFileSync(inside, String(process.pid), { flag: 'wx' }); } catch { out.overlap += 1; }
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      Atomics.wait(cell, 0, 0, 2); // widen the critical section
      if (!state.used) {
        state.used = true;
        state.by = process.pid;
        fs.writeFileSync(file, JSON.stringify(state));
        out.won.push(r);
      }
      try { fs.unlinkSync(inside); } catch {}
    });
  } catch (e) {
    out.errors.push(`${r}: ${e.message}`);
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
