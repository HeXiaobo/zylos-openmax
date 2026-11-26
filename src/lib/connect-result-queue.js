/**
 * Durable queue for undelivered connect-results.
 *
 * A channel binding stays `pending` until its result is recorded, and a pending
 * binding is exactly what leaves the workspace UI spinning with no way to
 * retry. The connector already retries the POST with backoff
 * (channel-connector.js), but a result that outlives those attempts — a longer
 * outage, or a crash/restart mid-flight — must not be dropped: the channel is
 * connected and serving while the record says otherwise.
 *
 * So anything the connector could not deliver is written to disk and re-sent
 * until it lands. Deliberately a plain JSON file, not a database: the queue is
 * tiny, write amplification is irrelevant at one entry per connect command, and
 * a file survives a restart, which is the whole point.
 *
 * Pure logic + injectable I/O so the retry/resend path is unit-testable — the
 * previous version lived inline in comm-bridge.js, where it could not be tested
 * and shipped with an undefined path constant that crashed the service on boot.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { RUNTIME_DIR } from './session.js';

export const CONNECT_RESULT_QUEUE_FILE = path.join(RUNTIME_DIR, 'pending-connect-results.json');
export const CONNECT_RESULT_RESEND_INTERVAL_MS = 60 * 1000;
export const CONNECT_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // stop trying after a day
export const CONNECT_RESULT_QUEUE_MAX = 200;

/** One entry per binding+request: re-reporting the same command is pointless. */
const entryKey = (x) => `${x.bindingId}:${x.requestId || ''}`;

/**
 * Identity of one queued attempt: key plus the stamp it was queued with. A
 * re-queue of the same binding+request refreshes queuedAt, so this distinguishes
 * "the entry I just processed" from "a newer entry for the same command that
 * arrived while I was working" — the difference between removing what is done
 * and deleting a result that has not been delivered yet.
 */
const entryIdentity = (x) => `${entryKey(x)}@${x.queuedAt || 0}`;

/**
 * @param {object}   [deps]
 * @param {string}   [deps.file]        queue file path
 * @param {(item) => Promise<void>} deps.sendResult  delivers one queued result
 * @param {() => number} [deps.now]     clock (injectable for age tests)
 * @param {object}   [deps.fsDep]       fs module (injectable)
 * @param {function} [deps.log] @param {function} [deps.warn]
 * @param {number}   [deps.maxAgeMs] @param {number} [deps.maxItems]
 */
export function createConnectResultQueue({
  file = CONNECT_RESULT_QUEUE_FILE,
  sendResult,
  now = Date.now,
  fsDep = fs,
  log = () => {},
  warn = () => {},
  maxAgeMs = CONNECT_RESULT_MAX_AGE_MS,
  maxItems = CONNECT_RESULT_QUEUE_MAX,
} = {}) {
  // A corrupt or absent file must never take the service down — an empty queue
  // is the correct reading of "nothing recoverable on disk".
  const read = () => {
    try {
      const parsed = JSON.parse(fsDep.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  const write = (items) => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fsDep.mkdirSync(path.dirname(file), { recursive: true });
      // Preserve existing receipts if writing the replacement is interrupted.
      fsDep.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600, flag: 'wx' });
      fsDep.renameSync(temp, file);
      return true;
    } catch (e) {
      try { fsDep.rmSync(temp, { force: true }); } catch { /* The old queue is intact. */ }
      warn(`could not persist connect-result queue: ${e.message}`);
      return false;
    }
  };

  /** Persist a result the connector could not deliver. Never throws. */
  const queue = (r) => {
    // A newer result for the same binding+request supersedes the older one.
    const next = read().filter((x) => entryKey(x) !== entryKey(r));
    next.push({ ...r, queuedAt: now() });
    // Cap from the front: the newest results are the ones worth keeping.
    const saved = write(next.slice(-maxItems));
    if (saved) warn(`connect-result queued for resend binding=${r.bindingId} status=${r.status}`);
    return saved;
  };

  // Single-flight for resend. Every run does read-modify-write on one file, so
  // two overlapping runs would each re-send the entries the other is still
  // working through and then clobber each other's rewrite — losing results this
  // queue exists to guarantee. The timer that drives it does not await anything,
  // so a run slower than the interval is not hypothetical.
  let inFlight = null;

  /**
   * Try every queued result once; keep the ones that still fail. Never throws —
   * it runs from a timer, and a resend failure is expected, not exceptional.
   * A call made while a previous run is still going joins that run rather than
   * starting a second one.
   * @returns {Promise<{sent: number, kept: number, dropped: number}>}
   */
  const resend = async () => {
    if (inFlight) return inFlight;
    inFlight = runResend().finally(() => { inFlight = null; });
    return inFlight;
  };

  const runResend = async () => {
    const items = read();
    if (!items.length) return { sent: 0, kept: 0, dropped: 0 };
    // Entries this run finished with — delivered or aged out. Collected as
    // identities (see entryIdentity) because the rewrite below must remove
    // exactly these and nothing else.
    const processed = [];
    let sent = 0, dropped = 0, kept = 0;
    for (const item of items) {
      if (now() - (item.queuedAt || 0) > maxAgeMs) {
        // Past this age the binding has almost certainly been re-driven by the
        // user; re-reporting a day-old result would be worse than dropping it.
        warn(`dropping connect-result older than 24h binding=${item.bindingId} status=${item.status}`);
        processed.push(item);
        dropped++;
        continue;
      }
      try {
        await sendResult(item);
        log(`connect-result resend succeeded binding=${item.bindingId} status=${item.status}`);
        processed.push(item);
        sent++;
      } catch (e) {
        warn(`connect-result resend failed binding=${item.bindingId}: ${e.message}`);
        kept++;   // left on disk for the next tick, with its original stamp
      }
    }
    // Remove what this run finished with FROM THE CURRENT FILE, rather than
    // overwriting the file with the snapshot read at the top. Sending is async,
    // and queue() is a synchronous read-modify-write that can land in between:
    // rewriting from the stale snapshot silently discards any result queued
    // during the run — the connector's live failure path queues exactly while
    // the resend task is running, and losing that result leaves the binding
    // pending, i.e. the spinner this queue exists to prevent.
    //
    // Nothing is written when this run finished with nothing, so a round where
    // every send failed leaves the file (and its queuedAt stamps) untouched.
    if (processed.length) {
      const done = new Set(processed.map(entryIdentity));
      write(read().filter((x) => !done.has(entryIdentity(x))));
    }
    return { sent, kept, dropped };
  };

  return { queue, resend, read, file };
}
