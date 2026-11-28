/**
 * Market sync on push (`agent.config.market_sync_requested`).
 *
 * The frame only says "something changed in the market for this Agent"; the
 * market client then pulls the actual changes itself. Nothing from the frame
 * is executed or passed on: the binary path and argv are fixed.
 *
 * - Dedupe by request_id (last 256 ids, 10 minutes).
 * - Leading-edge coalescing: the first request runs at once. A request during
 *   a run queues one follow-up that starts when the run ends; a request within
 *   the cooldown after a run queues one follow-up at the end of the cooldown.
 *   At most one follow-up is queued.
 * - Exit 0 (done) and 4 (busy: the client service already has it) are success.
 * - Binary missing: the market-client install check runs at once.
 */

import os from 'os';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

export const MARKET_SYNC_EVENT = 'agent.config.market_sync_requested';
export const MARKET_SYNC_ARGS = Object.freeze(['sync', '--wait', '5']);

const KNOWN_REASONS = new Set(['hire', 'update', 'uninstall']);
const DEDUPE_MAX = 256;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 2000;
// --wait 5 plus client start-up and the poll round it waits on.
const RUN_TIMEOUT_MS = 60_000;
// request_id is a UUID; anything outside this set is rejected (it is logged).
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args, opts) => promisifiedExecFile(file, args, opts);

function defaultMarketClientBin() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
  return path.join(zylosDir, 'bin', 'market-client');
}

/**
 * Validates the frame data. Requires agent_member_id to equal self (a missing
 * one is rejected too). Extra fields are ignored; reason is only logged.
 */
export function parseMarketSyncRequest(data, selfMemberId) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'missing data' };
  if (!selfMemberId || data.agent_member_id !== selfMemberId) return { ok: false, error: 'not for this agent' };
  const requestId = data.request_id;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return { ok: false, error: 'invalid request_id' };
  }
  const reason = KNOWN_REASONS.has(data.reason) ? data.reason : 'unknown';
  return { ok: true, requestId, reason };
}

export function handleMarketSyncEvent(data, { selfMemberId, controller, slug = '?', warn = () => {} }) {
  const parsed = parseMarketSyncRequest(data, selfMemberId);
  if (!parsed.ok) {
    warn(`[${slug}] market_sync_requested ignored: ${parsed.error}`);
    return;
  }
  controller.request(parsed.requestId, { reason: parsed.reason, slug });
}

function describeExecError(err) {
  if (err?.killed || err?.signal) return `signal=${err.signal || 'SIGTERM'}`;
  if (typeof err?.code === 'number') return `exit=${err.code}`;
  return `spawn failed (${err?.code || 'error'})`;
}

export function createMarketSyncController({
  execFile = realExecFile,
  marketClientBin = defaultMarketClientBin(),
  onClientMissing = () => {},
  log = () => {},
  warn = () => {},
  now = () => Date.now(),
  cooldownMs = COOLDOWN_MS,
  runTimeoutMs = RUN_TIMEOUT_MS,
} = {}) {
  const seen = new Map(); // request id -> first seen at
  let running = false;
  let cooldownTimer = null;
  let pending = null; // label of the queued follow-up
  let ensureInFlight = false;
  let resyncCounter = 0;

  function isDuplicate(id) {
    const t = now();
    for (const [k, at] of seen) {
      if (t - at <= DEDUPE_TTL_MS) break;
      seen.delete(k);
    }
    if (seen.has(id)) return true;
    seen.set(id, t);
    while (seen.size > DEDUPE_MAX) seen.delete(seen.keys().next().value);
    return false;
  }

  function triggerEnsure() {
    if (ensureInFlight) return;
    ensureInFlight = true;
    Promise.resolve()
      .then(() => onClientMissing())
      .catch((err) => warn(`market sync: install check failed: ${err?.message || err}`))
      .finally(() => { ensureInFlight = false; });
  }

  function startCooldown() {
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (pending) {
        const label = pending;
        pending = null;
        run(label);
      }
    }, cooldownMs);
    cooldownTimer.unref?.();
  }

  async function run(label) {
    running = true;
    try {
      await execFile(marketClientBin, [...MARKET_SYNC_ARGS], { timeout: runTimeoutMs });
      log(`market sync: ${label} exit=0`);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        warn(`market sync: ${label} market client is not installed, running install check`);
        triggerEnsure();
      } else if (err?.code === 4) {
        log(`market sync: ${label} exit=4 (service busy, request handed over)`);
      } else {
        warn(`market sync: ${label} failed (${describeExecError(err)})`);
      }
    } finally {
      running = false;
    }
    if (pending) {
      const next = pending;
      pending = null;
      run(next);
    } else {
      startCooldown();
    }
  }

  function enqueue(label) {
    if (running || cooldownTimer) {
      const already = pending !== null;
      pending = label;
      return already ? 'coalesced' : 'queued';
    }
    run(label);
    return 'started';
  }

  return {
    // Returns 'started' | 'queued' | 'coalesced' | 'duplicate'. Never throws.
    request(requestId, { reason = 'unknown', slug = '?' } = {}) {
      if (isDuplicate(requestId)) return 'duplicate';
      return enqueue(`[${slug}] request=${requestId} reason=${reason}`);
    },
    // Not deduped: each call is a fresh synthetic request.
    requestResync(source = 'resync', { slug = '?' } = {}) {
      resyncCounter += 1;
      return enqueue(`[${slug}] request=${source}-${resyncCounter}`);
    },
  };
}
