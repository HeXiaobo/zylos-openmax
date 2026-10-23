/**
 * runtime/runs/ — the run files shared between the comm-bridge process
 * (collector / attribution / emitter) and the stateless senders
 * (scripts/send.js, src/cli/comm.js comm.send / send_card / ask_card / ask).
 *
 *   runs/<run_id>.json       one run (atomic tmp + rename, mode 0600)
 *   runs/<run_id>.reply      reply claim (created with 'wx'; kind text / media / card)
 *   runs/<run_id>.form-card  marker: the run was answered with a card whose
 *                            metadata the server refused (422 → resent bare)
 *   runs/active.json         index of runs that are not closed, per-org summary gate,
 *                            unregistered group inputs (send.js guard)
 *   runs/send-stats.json     best-effort counters bumped by send.js
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from '../session.js';

// OPENMAX_RUNS_DIR overrides the location (tests that spawn send.js / comm.js
// must never read or claim the host's live runs).
export const DEFAULT_RUNS_DIR = process.env.OPENMAX_RUNS_DIR || path.join(RUNTIME_DIR, 'runs');
const RUN_FILE_RE = /^(r_[0-9a-f]{8})\.json$/;

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Persistable view of a run: in-memory bookkeeping lives under `_` keys. */
export function serializeRun(run) {
  const out = {};
  for (const [k, v] of Object.entries(run)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

export function createRunStore({ dir = DEFAULT_RUNS_DIR } = {}) {
  const runPath = (id) => path.join(dir, `${id}.json`);
  const claimPath = (id) => path.join(dir, `${id}.reply`);
  const formCardPath = (id) => path.join(dir, `${id}.form-card`);
  const activePath = path.join(dir, 'active.json');
  const sendStatsPath = path.join(dir, 'send-stats.json');

  return {
    dir,
    runPath,
    claimPath,

    writeRun(run) {
      atomicWrite(runPath(run.run_id), JSON.stringify(serializeRun(run)));
    },
    readRun(id) {
      return readJson(runPath(id));
    },
    listRunIds() {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      return names.map((n) => RUN_FILE_RE.exec(n)?.[1]).filter(Boolean);
    },
    removeRun(id) {
      for (const f of [runPath(id), claimPath(id), formCardPath(id)]) {
        try { fs.unlinkSync(f); } catch {}
      }
    },

    writeActive(index) {
      atomicWrite(activePath, JSON.stringify(index));
    },
    readActive() {
      return readJson(activePath);
    },
    removeActive() {
      try { fs.unlinkSync(activePath); } catch {}
    },

    claimExists(id) {
      try { fs.accessSync(claimPath(id)); return true; } catch { return false; }
    },
    readClaim(id) {
      return readJson(claimPath(id));
    },
    /** Create the claim; false when another reply already holds it. */
    createClaim(id, data) {
      fs.mkdirSync(dir, { recursive: true });
      let fd;
      try {
        fd = fs.openSync(claimPath(id), 'wx', 0o600);
      } catch (err) {
        if (err.code === 'EEXIST') return false;
        throw err;
      }
      try { fs.writeSync(fd, JSON.stringify(data)); } finally { fs.closeSync(fd); }
      return true;
    },
    updateClaim(id, data) {
      atomicWrite(claimPath(id), JSON.stringify(data));
    },
    releaseClaim(id) {
      try { fs.unlinkSync(claimPath(id)); } catch {}
    },
    writeFormCard(id) {
      try { atomicWrite(formCardPath(id), String(Date.now())); } catch {}
    },
    formCardExists(id) {
      try { fs.accessSync(formCardPath(id)); return true; } catch { return false; }
    },

    /** Best-effort counter bump from send.js (racy by design; counters only). */
    bumpSendStat(key) {
      try {
        const cur = readJson(sendStatsPath) || {};
        cur[key] = (cur[key] || 0) + 1;
        atomicWrite(sendStatsPath, JSON.stringify(cur));
      } catch {}
    },
    readSendStats() {
      return readJson(sendStatsPath) || {};
    },
  };
}
