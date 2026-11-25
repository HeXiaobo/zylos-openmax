import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConnectResultQueue, CONNECT_RESULT_MAX_AGE_MS } from './connect-result-queue.js';

const DAY = CONNECT_RESULT_MAX_AGE_MS;

function tmpFile(name = 'pending-connect-results.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'connect-rq-')), name);
}

/** A queue over a real temp file, with a controllable clock and reporter. */
function makeQueue({ file = tmpFile(), failSend = false, ...over } = {}) {
  const sent = [];
  const warns = [];
  const logs = [];
  let clock = 1_700_000_000_000;
  const q = createConnectResultQueue({
    file,
    now: () => clock,
    sendResult: async (item) => {
      sent.push(item);
      if (failSend) throw new Error('503 upstream unavailable');
    },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    ...over,
  });
  return {
    ...q, file, sent, warns, logs,
    advance: (ms) => { clock += ms; },
    onDisk: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

const result = (over = {}) => ({
  slug: 'acme', orgId: 'org-1', bindingId: 'bind-1', channelType: 'whatsapp',
  requestId: 'req-1', status: 'connected', detail: '', ...over,
});

// --- persisting --------------------------------------------------------------

test('missing queue file reads as empty and does not throw', () => {
  const q = makeQueue();
  assert.deepEqual(q.read(), []);
  assert.equal(fs.existsSync(q.file), false, 'a read must not create the file');
});

test('queue: writes the result plus a queuedAt stamp, 0600, parent dir created', () => {
  const q = makeQueue({ file: path.join(tmpFile('x'), '..', 'nested', 'queue.json') });
  q.queue(result());

  const items = q.onDisk();
  assert.equal(items.length, 1);
  assert.equal(items[0].bindingId, 'bind-1');
  assert.equal(items[0].status, 'connected');
  assert.equal(items[0].queuedAt, 1_700_000_000_000);
  assert.equal(fs.statSync(q.file).mode & 0o777, 0o600, 'payload names the org/binding');
  assert.match(q.warns[0], /connect-result queued for resend binding=bind-1 status=connected/);
});

test('queue: a newer result for the same binding+request supersedes the older one', () => {
  const q = makeQueue();
  q.queue(result({ status: 'connected' }));
  q.advance(5_000);
  q.queue(result({ status: 'error', detail: 'verification failed' }));

  const items = q.onDisk();
  assert.equal(items.length, 1, 'no duplicate entry for the same command');
  assert.equal(items[0].status, 'error');
  assert.equal(items[0].detail, 'verification failed');
  assert.equal(items[0].queuedAt, 1_700_000_005_000, 'stamp refreshed');
});

test('queue: results for different commands on the same binding are both kept', () => {
  const q = makeQueue();
  q.queue(result({ requestId: 'req-connect', status: 'connected' }));
  q.queue(result({ requestId: 'req-disconnect', status: 'disconnected' }));
  assert.deepEqual(q.onDisk().map((x) => x.status), ['connected', 'disconnected']);
});

test('queue: capped at maxItems, keeping the newest', () => {
  const q = makeQueue({ maxItems: 3 });
  for (let i = 1; i <= 5; i++) q.queue(result({ bindingId: `bind-${i}`, requestId: `req-${i}` }));
  assert.deepEqual(q.onDisk().map((x) => x.bindingId), ['bind-3', 'bind-4', 'bind-5']);
});

test('queue: a corrupt file is treated as empty, and the next write repairs it', () => {
  const q = makeQueue();
  fs.writeFileSync(q.file, '{ this is not json');
  assert.deepEqual(q.read(), []);
  q.queue(result());
  assert.equal(q.onDisk().length, 1);
});

test('queue: a JSON file that is not an array is treated as empty', () => {
  const q = makeQueue();
  fs.writeFileSync(q.file, '{"bindingId":"bind-1"}');
  assert.deepEqual(q.read(), []);
});

test('queue: an unwritable path warns instead of throwing (a wedged disk must not kill the flow)', () => {
  // A regular file standing where a directory must be: mkdir/write both fail.
  const blocker = tmpFile('not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const q = makeQueue({ file: path.join(blocker, 'queue.json') });
  assert.doesNotThrow(() => q.queue(result()));
  assert.ok(q.warns.some((m) => /could not persist connect-result queue/.test(m)));
});

test('queue: a failed replacement reports failure without truncating earlier receipts', () => {
  const q = makeQueue();
  assert.equal(q.queue(result()), true);
  const previous = fs.readFileSync(q.file);
  const broken = makeQueue({
    file: q.file,
    fsDep: { ...fs, renameSync: () => { throw new Error('rename refused'); } },
  });
  assert.equal(broken.queue(result({ requestId: 'other' })), false);
  assert.deepEqual(fs.readFileSync(q.file), previous);
});

// --- resending ---------------------------------------------------------------

test('resend: empty queue is a no-op — no send, no file created', async () => {
  const q = makeQueue();
  assert.deepEqual(await q.resend(), { sent: 0, kept: 0, dropped: 0 });
  assert.equal(q.sent.length, 0);
  assert.equal(fs.existsSync(q.file), false);
});

test('resend: delivered results are sent with the full payload and cleared from disk', async () => {
  const q = makeQueue();
  q.queue(result());
  q.queue(result({ bindingId: 'bind-2', requestId: 'req-2', status: 'error', detail: 'nope' }));

  const stats = await q.resend();
  assert.deepEqual(stats, { sent: 2, kept: 0, dropped: 0 });
  assert.deepEqual(q.sent.map((x) => [x.orgId, x.bindingId, x.status, x.detail, x.requestId]), [
    ['org-1', 'bind-1', 'connected', '', 'req-1'],
    ['org-1', 'bind-2', 'error', 'nope', 'req-2'],
  ]);
  assert.deepEqual(q.onDisk(), [], 'delivered results are not re-sent next tick');
  assert.ok(q.logs.some((m) => /resend succeeded binding=bind-1/.test(m)));
});

test('resend: a still-failing result is kept with its original stamp, to be retried next tick', async () => {
  const q = makeQueue({ failSend: true });
  q.queue(result());
  const queuedAt = q.onDisk()[0].queuedAt;

  q.advance(60_000);
  const stats = await q.resend();
  assert.deepEqual(stats, { sent: 0, kept: 1, dropped: 0 });
  assert.equal(q.onDisk()[0].queuedAt, queuedAt, 'age must keep accruing, not reset each attempt');
  assert.ok(q.warns.some((m) => /resend failed binding=bind-1: 503/.test(m)));

  await q.resend();
  assert.equal(q.sent.length, 2, 'retried on the following tick');
});

test('resend: partial failure keeps only the undelivered entries', async () => {
  const q = makeQueue({
    sendResult: async (item) => { if (item.bindingId === 'bind-2') throw new Error('502'); },
  });
  q.queue(result({ bindingId: 'bind-1', requestId: 'r1' }));
  q.queue(result({ bindingId: 'bind-2', requestId: 'r2' }));
  q.queue(result({ bindingId: 'bind-3', requestId: 'r3' }));

  const stats = await q.resend();
  assert.deepEqual(stats, { sent: 2, kept: 1, dropped: 0 });
  assert.deepEqual(q.onDisk().map((x) => x.bindingId), ['bind-2']);
});

test('resend: an entry past the max age is dropped without being sent', async () => {
  const q = makeQueue();
  q.queue(result({ bindingId: 'stale', requestId: 'r-old' }));
  q.advance(DAY + 1);
  q.queue(result({ bindingId: 'fresh', requestId: 'r-new' }));

  const stats = await q.resend();
  assert.deepEqual(stats, { sent: 1, kept: 0, dropped: 1 });
  assert.deepEqual(q.sent.map((x) => x.bindingId), ['fresh'], 'day-old result never re-reported');
  assert.ok(q.warns.some((m) => /dropping connect-result older than 24h binding=stale/.test(m)));
  assert.deepEqual(q.onDisk(), []);
});

test('resend: a legacy entry with no queuedAt is dropped rather than retried forever', async () => {
  const q = makeQueue();
  fs.writeFileSync(q.file, JSON.stringify([result({ bindingId: 'legacy' })]));
  const stats = await q.resend();
  assert.deepEqual(stats, { sent: 0, kept: 0, dropped: 1 });
  assert.equal(q.sent.length, 0);
});

// The resend is driven by a bare setInterval, which awaits nothing: a run
// slower than the interval used to overlap the next tick, and since every run
// read-modify-writes one file, the two would re-send each other's entries and
// clobber each other's rewrite.
test('resend: a second call during a slow run joins it instead of starting another', async () => {
  const delivered = [];
  let inFlightSends = 0;
  let maxConcurrentSends = 0;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const q = makeQueue({
    sendResult: async (item) => {
      inFlightSends++;
      maxConcurrentSends = Math.max(maxConcurrentSends, inFlightSends);
      await sendGate;
      inFlightSends--;
      delivered.push(item.bindingId);
    },
  });
  q.queue(result());
  q.queue(result({ bindingId: 'bind-2', requestId: 'req-2' }));

  const first = q.resend();
  await Promise.resolve();
  const second = q.resend();          // the next 60s tick, while the first is stuck

  releaseSend();
  const [a, b] = await Promise.all([first, second]);
  // Both callers observe the same run's outcome, and that run happened once:
  // overlapping runs would have re-sent both entries (4 sends) and each would
  // have rewritten the file from its own stale read.
  assert.deepEqual(a, { sent: 2, kept: 0, dropped: 0 });
  assert.deepEqual(b, a, 'the overlapping tick reports the joined run, not a second one');
  assert.deepEqual(delivered, ['bind-1', 'bind-2'], 'each queued result delivered exactly once');
  assert.equal(maxConcurrentSends, 1, 'no two sends may be in flight at once');
  assert.deepEqual(q.onDisk(), []);
});

test('resend: a later call after the run finished starts a fresh run', async () => {
  const q = makeQueue();
  q.queue(result());
  await q.resend();
  q.queue(result({ bindingId: 'bind-2', requestId: 'req-2' }));
  await q.resend();
  assert.deepEqual(q.sent.map((x) => x.bindingId), ['bind-1', 'bind-2'],
    'single-flight must not latch after the first run completes');
});

test('resend: a run that throws internally still releases the single-flight slot', async () => {
  let calls = 0;
  const q = makeQueue({
    fsDep: {
      readFileSync: () => { calls++; if (calls === 1) throw Object.assign(new Error('boom'), { code: 'EIO' }); return '[]'; },
      writeFileSync: () => {},
      mkdirSync: () => {},
    },
  });
  await q.resend();                    // read throws → treated as empty
  assert.deepEqual(await q.resend(), { sent: 0, kept: 0, dropped: 0 },
    'the slot must be free again for the next tick');
});

// queue() is a synchronous read-modify-write; resend() spans awaits. Rewriting
// the file from the snapshot read at the top of the run therefore discarded any
// result queued while it was in flight — and in production those two are exactly
// concurrent: the connector's live failure path queues while the resend task
// runs. A lost result leaves its binding pending, i.e. the spinner this queue
// exists to prevent.
test('resend: a result queued during a slow run survives the final rewrite', async () => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const q = makeQueue({ sendResult: async () => { await sendGate; } });
  q.queue(result({ bindingId: 'old', requestId: 'r-old' }));

  const run = q.resend();                 // snapshot: [old]
  await Promise.resolve();
  q.queue(result({ bindingId: 'new', requestId: 'r-new' }));   // lands mid-run
  assert.deepEqual(q.onDisk().map((x) => x.bindingId), ['old', 'new']);

  releaseSend();
  const stats = await run;
  assert.deepEqual(stats, { sent: 1, kept: 0, dropped: 0 });
  assert.deepEqual(q.onDisk().map((x) => x.bindingId), ['new'],
    'the delivered entry is removed and the newly queued one is kept');
});

test('resend: a re-queue of the same command during the run is not deleted as "done"', async () => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const q = makeQueue({ sendResult: async () => { await sendGate; } });
  q.queue(result({ status: 'connected' }));

  const run = q.resend();
  await Promise.resolve();
  // Same binding+request, newer payload: queue() supersedes the entry in place,
  // so it carries a fresher queuedAt than the one being sent.
  q.advance(1_000);
  q.queue(result({ status: 'error', detail: 'later outcome' }));

  releaseSend();
  await run;
  const left = q.onDisk();
  assert.equal(left.length, 1, 'the newer entry must not be mistaken for the one just sent');
  assert.equal(left[0].status, 'error');
  assert.equal(left[0].detail, 'later outcome');
});

test('resend: an entry that failed mid-run is left with its stamp while a new one is added', async () => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const q = makeQueue({
    sendResult: async () => { await sendGate; throw new Error('503 upstream unavailable'); },
  });
  q.queue(result({ bindingId: 'stuck', requestId: 'r-stuck' }));
  const stuckAt = q.onDisk()[0].queuedAt;

  const run = q.resend();
  await Promise.resolve();
  q.queue(result({ bindingId: 'fresh', requestId: 'r-fresh' }));

  releaseSend();
  assert.deepEqual(await run, { sent: 0, kept: 1, dropped: 0 });
  const left = q.onDisk();
  assert.deepEqual(left.map((x) => x.bindingId), ['stuck', 'fresh']);
  assert.equal(left[0].queuedAt, stuckAt, 'the failed entry keeps accruing age');
});

test('resend: nothing is rewritten when every attempt fails (file left byte-identical)', async () => {
  const q = makeQueue({ failSend: true });
  q.queue(result());
  const before = fs.readFileSync(q.file, 'utf8');
  await q.resend();
  assert.equal(fs.readFileSync(q.file, 'utf8'), before);
});
