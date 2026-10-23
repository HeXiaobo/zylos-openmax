import assert from 'node:assert/strict';
import { test } from 'node:test';

import TaskRegistry from './task-registry.js';

/** Wait for `n` turns of the microtask queue. */
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('register rejects a duplicate name', () => {
  const tasks = new TaskRegistry();
  tasks.register('a', () => {}, 1000);
  assert.throws(() => tasks.register('a', () => {}, 1000), /already registered/);
});

test('runOnStart fires once immediately, and list reports what is running', async () => {
  const tasks = new TaskRegistry();
  let calls = 0;
  tasks.register('a', () => { calls++; }, 60_000, { runOnStart: true });
  assert.deepEqual(tasks.list(), [{ name: 'a', intervalMs: 60_000, running: false, inFlight: false }]);

  tasks.start('a');
  await flush();
  assert.equal(calls, 1);
  assert.equal(tasks.list()[0].running, true);

  tasks.stop('a');
  assert.equal(tasks.list()[0].running, false);
});

// setInterval awaits nothing, so an async task slower than its own interval used
// to accumulate overlapping runs. For anything that read-modify-writes shared
// state (the connect-result queue rewrites one file) that means duplicated side
// effects and lost writes, so a tick that lands on a run still in flight has to
// be dropped rather than doubled up.
test('an async task whose run is still in flight skips the next tick', async () => {
  const tasks = new TaskRegistry();
  let starts = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  tasks.register('slow', async () => {
    starts++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await gate;
    concurrent--;
  }, 60_000, { runOnStart: true });

  tasks.start('slow');
  await flush();
  assert.equal(starts, 1);
  assert.equal(tasks.list()[0].inFlight, true, 'the run is visible as in flight');

  // Two more ticks land while the first run is stuck (as the interval would).
  tasks.tickNow('slow');
  tasks.tickNow('slow');
  await flush();
  assert.equal(starts, 1, 'overlapping ticks must not start a second run');
  assert.equal(maxConcurrent, 1);

  release();
  await flush(5);
  assert.equal(tasks.list()[0].inFlight, false, 'the slot is released when the run ends');

  // Once free, the next tick runs normally — the guard must not latch.
  tasks.tickNow('slow');
  await flush();
  assert.equal(starts, 2);
  tasks.stop('slow');
});

test('a rejecting async task is contained, not turned into an unhandled rejection', async () => {
  const tasks = new TaskRegistry();
  let calls = 0;
  tasks.register('bad', async () => { calls++; throw new Error('boom'); }, 60_000);

  await assert.doesNotReject(tasks.tickNow('bad'));
  assert.equal(calls, 1);
  // And the failure does not wedge the task: the next tick still runs.
  await tasks.tickNow('bad');
  assert.equal(calls, 2);
  assert.equal(tasks.list()[0].inFlight, false);
});

test('stopAll clears both the delay timer and the interval', () => {
  const tasks = new TaskRegistry();
  tasks.register('delayed', () => {}, 60_000, { delay: 60_000 });
  tasks.register('plain', () => {}, 60_000);
  tasks.startAll();
  assert.deepEqual(tasks.list().map((t) => t.running), [true, true]);
  tasks.stopAll();
  assert.deepEqual(tasks.list().map((t) => t.running), [false, false]);
});

test('isRunning / has report the start state; stop is idempotent', () => {
  const tasks = new TaskRegistry();
  assert.equal(tasks.has('a'), false);
  assert.equal(tasks.isRunning('a'), false);
  tasks.register('a', () => {}, 60_000, { delay: 10_000 });
  assert.equal(tasks.has('a'), true);
  assert.equal(tasks.isRunning('a'), false);
  tasks.start('a');
  assert.equal(tasks.isRunning('a'), true, 'a pending first-tick delay counts as running');
  tasks.stop('a');
  tasks.stop('a');
  assert.equal(tasks.isRunning('a'), false);
  tasks.start('a');
  tasks.start('a');
  assert.equal(tasks.isRunning('a'), true);
  tasks.stopAll();
  assert.equal(tasks.isRunning('a'), false);
});
