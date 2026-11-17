/**
 * Agent readiness gate for the onboarding trigger.
 *
 * Core 1.x uses the local Dashboard readiness probe as its availability source.
 * Platform readiness and onboarding share that snapshot; onboarding alone may
 * wait for an explicitly unanswerable runtime, subject to the existing cap.
 * Core 0.x keeps the file/session checks described below unchanged.
 * The probe address follows the installed Core version (readinessProbePath):
 * `GET /api/health/ready` from Core 1.0.0-beta.12, `GET /api/health?probe=ready`
 * on an earlier 1.x.
 *
 * WHY: `online-report` is the server-side onboarding trigger (see
 * online-report.js). We fire it from WS `onOpen`, but the WebSocket coming up
 * only proves *this* process is alive — it says nothing about the runtime agent
 * behind C4. On a fresh install the comm-bridge can even be running while no
 * agent session exists at all (the `onOpen` first-connect branch already
 * documents that "prepare phase" window). Reporting then makes cws-core start
 * onboarding — welcome DM, seeded issues, an `active` onboarding session —
 * against an agent that cannot act for minutes, so the first real reply lands
 * long after the server believes onboarding began.
 *
 * LEGACY CORE READINESS: not simply `state === 'idle'`. The activity monitor
 * defines idle as `activeTools === 0 && inactiveSeconds >= 3`
 * (monitor-orchestrator.js), and when no conversation file exists yet its
 * activity source degrades to `tmux_activity` and then to `default` — so a
 * still-booting runtime with no session reads `idle` just as a finished, waiting
 * one does. Idle alone would reopen the very hole this gate closes. We therefore
 * also require proof that a session actually reached its SessionStart hooks
 * *for the current runtime launch*: `foreground-session.json.observed_at >=
 * agent-status.json.runtime_launch_at` (the hook writes that file; a stale value
 * from a previous launch is rejected by the comparison).
 *
 * LEGACY CODEX RUNTIME: zylos-core writes foreground-session.json only for a managed
 * Claude process, so on Codex the file is absent or a stale Claude record and
 * the gate would hold forever. When the active runtime is Codex and the record
 * does not belong to this launch, the newest foreground Codex thread (its
 * rollout `session_meta`, see codex-session.js) stands in for it, under the
 * same comparison against `runtime_launch_at`. Every other check — stale or
 * unhealthy status, a dead process, busy/idle — is unchanged. Any other or
 * unknown runtime keeps the original behavior exactly.
 *
 * FAIL-OPEN BY DESIGN: the gate delays the trigger, it must never cancel it.
 * A permanently busy agent, a stopped activity monitor, or an unreadable status
 * file must not strand an org un-onboarded, so `waitUntilReady` gives up after
 * `maxWaitMs` and tells the caller to report anyway. Waiting forever would just
 * trade a latency bug for a deadlock. This mirrors C4's own fail-open reading of
 * the same status file.
 *
 * Deps are injected so the gate is unit-testable without an activity monitor.
 */

import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createCodexSessionReader, readZylosRuntime } from './codex-session.js';
import { readCoreVersion as installedCoreVersion } from './core-version.js';
import { evaluateDashboardReadiness, readDashboardProbe, readinessProbePath } from './dashboard-readiness.js';
import { getDashboardPort } from './dashboard-address.js';

/**
 * Blockers on which the fail-open cap must NOT release the report.
 *
 * Fail-open exists so an agent that is *present but busy* cannot strand its org
 * un-onboarded. It must never manufacture a false "I am online" when no agent
 * session exists for this launch at all — reporting then asserts something
 * untrue, and the platform acts on it: the 2026-08-10 cws-agent-runtime
 * investigation traced the premature "有什么可以帮你" welcome DM to exactly this,
 * a transient prepare-phase comm-bridge whose online-report was taken as proof
 * the real runtime was up (it was SIGINT'd 2s later, and the real runtime had
 * not started yet).
 *
 * These two reasons both mean "no session belongs to this runtime launch", so
 * waiting longer is the only honest behavior. The caller keeps its retry path
 * (WS reconnect / periodic tick), so this defers rather than cancels.
 */
export const NO_FAIL_OPEN_REASONS = new Set(['no_session', 'session_predates_launch', 'session_not_running']);

/**
 * How far provisioning has provably got, as one monotonic ladder.
 *
 * WHY THIS LIVES HERE: the platform shows a staged "your agent is being set up"
 * progress UI, and it used to derive those stages itself — from `runtime.state`
 * and from a WebSocket-presence flag. Both are wrong for the same reason this
 * gate exists: `state === 'idle'` cannot tell a still-booting runtime from a
 * finished one (with no session file the activity source degrades to
 * `tmux_activity` then `default`), and a live WebSocket only proves the
 * comm-bridge process is up, not that any agent session exists behind it. This
 * module is the only place that sees every input, so it is the only place that
 * can answer honestly. The platform stores what it is told and does not
 * re-interpret it.
 *
 * For Core 1.x, Dashboard availability drives the ladder; accompanying runtime
 * health can defer onboarding without lowering a successful probe's rung.
 * The legacy Core 0.x mapping is:
 *
 *   runtime_down   agent-status.json missing/stale, or health not ok
 *                  → nothing can be believed yet
 *   runtime_up     status is fresh and healthy, but no session belongs to this
 *                  launch (or the runtime process is confirmed dead)
 *   session_ready  a session for THIS launch exists and the process is alive,
 *                  but it is busy or has not been idle long enough
 *   ready          every condition met — the agent can take work
 *
 * `runtime_dead` maps to runtime_up rather than session_ready even though
 * evaluate() only reaches it after the session checks pass: a confirmed-dead
 * process must never be credited with a working session. Erring toward the
 * lower rung only ever delays a stage, and the platform stamps each rung
 * write-once, so a rung already reached is never taken back.
 *
 * Unknown/新 reasons fall to runtime_down for the same reason — an unrecognized
 * blocker must not silently advance the ladder.
 */
export const READINESS_STAGES = Object.freeze(['runtime_down', 'runtime_up', 'session_ready', 'ready']);

const STAGE_BY_REASON = new Map([
  ['ready', 'ready'],
  ['busy', 'session_ready'],
  ['idle_too_brief', 'session_ready'],
  ['no_session', 'runtime_up'],
  ['session_predates_launch', 'runtime_up'],
  ['runtime_dead', 'runtime_up'],
  ['session_not_running', 'runtime_up'],
  ['status_missing', 'runtime_down'],
  ['status_stale', 'runtime_down'],
]);

/** Map an evaluate() reason to its ladder rung. `health_*` is dynamic, hence the prefix test. */
export function stageForReason(reason) {
  return STAGE_BY_REASON.get(reason) || 'runtime_down';
}

/**
 * The two bits plus the rung the platform acts on, derived from one verdict.
 * Exported so the metrics payload and the readiness-edge trigger cannot drift
 * apart — they previously kept separate copies of the "observable" reason list.
 */
export function readinessReport(verdict) {
  const reason = verdict?.reason ?? 'status_missing';
  const stage = verdict?.ready === true ? 'ready' : stageForReason(reason);
  return {
    ready: verdict?.ready === true,
    // "a running agent process for this launch is visible" — everything from
    // session_ready up. Kept for the platform's coarser present/absent check.
    observable: stage === 'session_ready' || stage === 'ready',
    stage,
    reason,
  };
}

export const READINESS_DEFAULTS = {
  minIdleSeconds: 5,      // sustained idle before we believe the agent is waiting
  pollMs: 2000,           // status file is rewritten every ~1s
  maxWaitMs: 10 * 60_000, // hard cap, then report anyway (see FAIL-OPEN above)
  staleStatusMs: 30_000,  // older than this ⇒ monitor not writing ⇒ unknown, not ready
  heartbeatMs: 30_000,    // while held, re-log at this cadence so a long wait is visible
};

/**
 * Public config (`agent.readiness_gate` in config.json) is snake_case, like every
 * other key in this file's neighbours (`device_id`, `api_key`,
 * `heartbeat_interval`). Internals are camelCase. Normalize at the boundary
 * rather than letting the two shapes meet: merging raw config into camelCase
 * defaults silently dropped every documented timing knob, so an operator
 * lowering the 10-minute cap kept getting 10 minutes with no error to show why.
 *
 * camelCase is accepted too, for programmatic/test callers. Non-numeric or
 * non-positive values are ignored rather than propagated — a NaN reaching
 * `maxWaitMs` would disable the fail-open cap, and a NaN `pollMs` would turn the
 * wait into a busy spin.
 */
const OPTION_ALIASES = {
  min_idle_seconds: 'minIdleSeconds',
  poll_ms: 'pollMs',
  max_wait_ms: 'maxWaitMs',
  stale_status_ms: 'staleStatusMs',
  heartbeat_ms: 'heartbeatMs',
};

export function normalizeReadinessOptions(raw) {
  return normalizeNumericOptions(raw, READINESS_DEFAULTS, OPTION_ALIASES);
}

/**
 * The snake_case→camelCase normalization above, reusable by any timing-knob
 * block that follows the same convention (public config snake_case, internals
 * camelCase).
 *
 * Extracted because the readiness-edge trigger repeated the original bug
 * verbatim — it merged raw config straight into camelCase defaults, so every
 * documented knob (`poll_ms`, `min_gap_ms`) was silently ignored and the
 * defaults stayed in force with no error to show why. One shared normalizer
 * means the next block of knobs cannot make the same mistake a third time.
 *
 * Keys not present in `defaults` are dropped rather than passed through: a
 * sibling key like `enabled` is not a timing knob, and letting unknown keys
 * flow into the settings object is how a typo becomes a silent no-op.
 *
 * Zero is rejected by default because these are intervals — a 0ms poll is a
 * busy spin, not a configuration. `allowZero` names the keys where 0 is a
 * real setting rather than nonsense (a throttle floor of 0 means "no floor").
 */
export function normalizeNumericOptions(raw, defaults, aliases = {}, { allowZero = [] } = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  const zeroOk = new Set(allowZero);
  for (const [key, value] of Object.entries(raw)) {
    const name = aliases[key] || key;
    if (!(name in defaults)) continue; // unknown key (e.g. `enabled`) — not ours
    const n = Number(value);
    if (!Number.isFinite(n)) continue;  // garbage in config must not break the loop
    if (n < 0 || (n === 0 && !zeroOk.has(name))) continue;
    out[name] = n;
  }
  return out;
}

/**
 * @param {object} deps
 * @param {() => ({data: object, mtimeMs: number}|null)} deps.readStatus     agent-status.json
 * @param {() => (object|null)} deps.readForeground                          foreground-session.json
 * @param {() => (object|null)} deps.readProc                                proc-state.json
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} deps.now                                           epoch ms
 * @param {() => object} [deps.options]                                     overrides, read per call
 * @param {() => (string|null)} [deps.readRuntime]                          active zylos runtime ('claude'|'codex'|null)
 * @param {({launchAt}) => ({session_id, started_at}|null)} [deps.readCodexSession]
 *   newest foreground Codex thread; consulted only on Codex when the
 *   foreground record does not belong to this launch
 */
export function createReadinessGate({
  readStatus, readForeground, readProc, sleep, now, options = () => ({}),
  readRuntime = () => null, readCodexSession = () => null,
  readCoreVersion = () => '0.0.0', readDashboardReadiness,
}) {
  function settings() {
    return { ...READINESS_DEFAULTS, ...normalizeReadinessOptions(options()) };
  }

  /**
   * One-shot check.
   * @returns {{ready: boolean, reason: string, detail: object}} `reason` names the
   *   blocker; `detail` is the observed snapshot, carried so the caller can log
   *   *why* without re-reading the files (this gate is diagnosed from logs on
   *   machines we don't have shell access to).
   */
  function evaluate() {
    const version = readCoreVersion();
    const major = typeof version === 'string' && /^(\d+)\./.exec(version);
    if (major && Number(major[1]) >= 1) return readDashboardReadiness(version);
    if (!major) return { ready: false, reason: 'core_version_unknown', detail: { core_version: 'unknown' } };
    const cfg = settings();

    const status = readStatus();
    if (!status?.data) return { ready: false, reason: 'status_missing', detail: { status_file: 'missing_or_unreadable' } };

    const s = status.data;
    const statusAgeMs = now() - status.mtimeMs;
    const fg = readForeground();
    const proc = readProc();
    const launchAt = Number(s.runtime_launch_at) || 0;
    const inLaunch = (at) => (at ? (!launchAt || at >= launchAt) : false);
    let observedAt = Number(fg?.observed_at) || 0;
    let sessionId = fg?.session_id ?? null;

    // Codex: nothing writes foreground-session.json, so take the newest
    // foreground Codex thread instead — but only when the record does not
    // already prove a session for this launch, and only on Codex.
    let codex = null;
    if (!inLaunch(observedAt) && readRuntime() === 'codex') {
      codex = { session_source: 'none' };
      const cx = readCodexSession({ launchAt });
      const startedAt = Number(cx?.started_at) || 0;
      // An in-launch thread always wins; an older one is still more telling
      // than no record at all (→ session_predates_launch rather than no_session).
      if (startedAt && (inLaunch(startedAt) || !observedAt)) {
        observedAt = startedAt;
        sessionId = cx.session_id ?? null;
        codex.session_source = 'codex_rollout';
      }
    }

    // Snapshot every input the verdict depends on, so one log line explains it.
    const detail = {
      state: s.state ?? null,
      idle_seconds: s.idle_seconds ?? null,
      health: s.health ?? null,
      status_age_ms: statusAgeMs,
      session_observed_at: observedAt || null,
      runtime_launch_at: launchAt || null,
      session_in_launch: inLaunch(observedAt),
      proc_alive: proc ? proc.alive !== false : null,
      session_id: sessionId,
    };
    // Only present when the Codex path ran, so the Claude snapshot is unchanged.
    if (codex) {
      detail.runtime = 'codex';
      detail.session_source = codex.session_source;
    }
    const verdict = (ready, reason) => ({ ready, reason, detail });

    // Order is by diagnostic value, not convenience: when several conditions
    // fail at once we must name the most fundamental one. During boot both
    // "no session yet" and "idle for <5s" are true, and reporting the latter
    // would hide the fact that there is no session at all.
    if (statusAgeMs > cfg.staleStatusMs) return verdict(false, 'status_stale');
    if (typeof s.health === 'string' && s.health !== 'ok') return verdict(false, `health_${s.health}`);

    // A session must have started, and started within THIS runtime launch.
    if (!observedAt) return verdict(false, 'no_session');
    if (!detail.session_in_launch) return verdict(false, 'session_predates_launch');

    // proc-state is advisory: absent/stale ⇒ don't block on it, but a confirmed
    // dead runtime means any idle reading is meaningless.
    if (detail.proc_alive === false) return verdict(false, 'runtime_dead');

    if (s.state !== 'idle') return verdict(false, 'busy');
    if ((s.idle_seconds ?? 0) < cfg.minIdleSeconds) return verdict(false, 'idle_too_brief');

    return verdict(true, 'ready');
  }

  /**
   * Poll until ready or until the cap elapses.
   *
   * `onWait({reason, detail, waitedMs, kind})` fires on the first block, on every
   * change of blocker, and on a slow heartbeat while still blocked. The heartbeat
   * matters: without it a long hold logs one line and then goes silent, which is
   * indistinguishable from a hung process to whoever is reading the log.
   *
   * @returns {Promise<{ready, reason, detail, waitedMs, timedOut, polls, failOpenAllowed}>}
   *   `failOpenAllowed: false` means the cap was reached on a blocker where
   *   reporting anyway would assert something untrue — see NO_FAIL_OPEN_REASONS.
   */
  async function waitUntilReady({ onWait } = {}) {
    const cfg = settings();
    const startedAt = now();
    let announcedReason = null;
    let lastHeartbeatAt = startedAt;
    let polls = 0;

    for (;;) {
      const snapshot = await evaluate();
      // Availability is reported to the platform unchanged. Onboarding alone
      // may wait for a runtime that is explicitly unable to answer messages.
      const v = snapshot.onboardingReason
        ? { ...snapshot, ready: false, reason: snapshot.onboardingReason }
        : snapshot;
      const waitedMs = now() - startedAt;
      if (v.ready) return { ...v, waitedMs, timedOut: false, polls };

      // A poll loop must not become a log firehose: emit on state change, then
      // only once per heartbeat interval.
      if (onWait) {
        const changed = v.reason !== announcedReason;
        const dueForHeartbeat = now() - lastHeartbeatAt >= cfg.heartbeatMs;
        if (changed || dueForHeartbeat) {
          announcedReason = v.reason;
          lastHeartbeatAt = now();
          onWait({ reason: v.reason, detail: v.detail, waitedMs, kind: changed ? 'blocked' : 'still_blocked' });
        }
      }

      if (waitedMs + cfg.pollMs > cfg.maxWaitMs) {
        return { ...v, waitedMs, timedOut: true, polls, failOpenAllowed: !NO_FAIL_OPEN_REASONS.has(v.reason) };
      }
      polls++;
      await sleep(cfg.pollMs);
    }
  }

  return { evaluate, waitUntilReady };
}

/**
 * Render a readiness snapshot as one compact, greppable log field set.
 * Kept next to `evaluate` so the two never drift apart.
 */
export function formatReadinessDetail(detail = {}) {
  if (detail.core_version) return `core_version=${detail.core_version}`;
  if (detail.source === 'dashboard') return `source=dashboard http=${detail.http_status} mode=${detail.session_mode} runtime=${detail.runtime} health_source=${detail.health_source} health=${detail.health}`;
  if (detail.status_file) return `status_file=${detail.status_file}`;
  const parts = [
    `state=${detail.state}`,
    `idle=${detail.idle_seconds}s`,
    `health=${detail.health}`,
    `status_age=${Math.round((detail.status_age_ms ?? 0) / 1000)}s`,
    `session=${detail.session_observed_at ? (detail.session_in_launch ? 'in-launch' : 'predates-launch') : 'none'}`,
  ];
  if (detail.proc_alive !== null && detail.proc_alive !== undefined) parts.push(`proc=${detail.proc_alive ? 'alive' : 'dead'}`);
  if (detail.session_id) parts.push(`session_id=${detail.session_id}`);
  if (detail.runtime) parts.push(`runtime=${detail.runtime}`);
  if (detail.session_source) parts.push(`session_source=${detail.session_source}`);
  return parts.join(' ');
}

/**
 * Wrap the online-reporter so the trigger waits for a ready agent.
 *
 * One waiter per org: a periodic retry tick must not stack a second poll loop
 * behind the one the WS open already started. The underlying reporter's own Set
 * makes the POST idempotent — this guards the *wait*, not the POST.
 *
 * @param {object} deps
 * @param {(orgConfig: object) => Promise<void>} deps.reportAgentOnline
 * @param {{waitUntilReady: Function}} deps.gate
 * @param {() => boolean} [deps.isDisabled]           bypass the gate entirely (config escape hatch)
 * @param {(slug: string) => boolean} [deps.isAlreadyReported]  org has nothing left to report
 */
export function createGatedOnlineReporter({ reportAgentOnline, gate, isDisabled = () => false, isAlreadyReported = () => false, log = () => {}, warn = () => {} }) {
  const waiting = new Set();
  const secs = (ms) => `${Math.round(ms / 1000)}s`;

  return async function reportAgentOnlineWhenReady(orgConfig) {
    const { slug } = orgConfig;

    // Nothing left to report for this org (the report succeeded, or the endpoint
    // 404'd) ⇒ never enter the gate. The reporter is a no-op from here on, and
    // waiting for readiness before a no-op would make every later reconnect
    // poll for minutes and log holds for work that no longer exists.
    if (isAlreadyReported(slug)) return;

    if (waiting.has(slug)) {
      // Not silent: otherwise a periodic tick that appears to do nothing looks
      // like a bug when read back from a log.
      log(`[readiness] [${slug}] online-report already waiting for agent readiness — skipping duplicate wait`);
      return;
    }
    waiting.add(slug);
    try {
      if (isDisabled()) {
        log(`[readiness] [${slug}] gate disabled by config — reporting online immediately`);
        await reportAgentOnline(orgConfig);
        return;
      }
      const verdict = await gate.waitUntilReady({
        onWait: ({ reason, detail, waitedMs, kind }) => {
          const prefix = kind === 'blocked'
            ? `[readiness] [${slug}] online-report HELD: ${reason}`
            : `[readiness] [${slug}] online-report still held: ${reason} (waited ${secs(waitedMs)})`;
          log(`${prefix} — ${formatReadinessDetail(detail)}`);
        },
      });
      if (verdict.timedOut && verdict.failOpenAllowed === false) {
        // No session belongs to this launch, so reporting would assert something
        // untrue and the platform would act on it (premature welcome DM +
        // onboarding seeded at a runtime that does not exist). Defer instead —
        // the WS reconnect / periodic tick retries, so this is not a cancel.
        warn(`[readiness] [${slug}] cap reached with NO agent session (${verdict.reason}) — NOT reporting online; deferring to the next retry — ${formatReadinessDetail(verdict.detail)}`);
        return;
      }
      if (verdict.timedOut) {
        // Cap reached with an agent that exists but is busy. Report anyway — a
        // delayed onboarding beats an org that never onboards.
        warn(`[readiness] [${slug}] agent STILL not ready after ${secs(verdict.waitedMs)} (${verdict.reason}) — reporting online anyway (fail-open cap reached) — ${formatReadinessDetail(verdict.detail)}`);
      } else if (verdict.waitedMs > 0) {
        log(`[readiness] [${slug}] agent READY after ${secs(verdict.waitedMs)} (${verdict.polls} polls) — reporting online — ${formatReadinessDetail(verdict.detail)}`);
      } else {
        log(`[readiness] [${slug}] agent ready on first check — reporting online without delay — ${formatReadinessDetail(verdict.detail)}`);
      }
      await reportAgentOnline(orgConfig);
    } finally {
      waiting.delete(slug);
    }
  };
}

/** Core 1.x reads Dashboard; Core 0.x retains the activity monitor file wiring. */
export function createDefaultReadinessGate({ options, env = process.env, fetch = globalThis.fetch } = {}) {
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  const monitorDir = path.join(zylosDir, 'activity-monitor');
  const statusFile = path.join(monitorDir, 'agent-status.json');
  const foregroundFile = path.join(monitorDir, 'foreground-session.json');
  const procFile = path.join(monitorDir, 'proc-state.json');
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const readCodexSession = createCodexSessionReader({ codexHome, zylosDir });

  // These files are rewritten atomically every second; a torn read is expected
  // occasionally and simply means "unknown this tick", never "not ready forever".
  const readJson = (file) => {
    try {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  return createReadinessGate({
    readCoreVersion: () => installedCoreVersion({ env }),
    readDashboardReadiness: version => evaluateDashboardReadiness({
      runtime: readZylosRuntime(zylosDir, { defaultRuntime: 'claude' }),
      readProbe: () => readDashboardProbe({ fetch, port: getDashboardPort({ zylosDir }), path: readinessProbePath(version) }),
    }),
    readStatus: () => {
      try {
        if (!existsSync(statusFile)) return null;
        const mtimeMs = statSync(statusFile).mtimeMs;
        const data = readJson(statusFile);
        return data ? { data, mtimeMs } : null;
      } catch {
        return null;
      }
    },
    readForeground: () => readJson(foregroundFile),
    readProc: () => readJson(procFile),
    readRuntime: () => readZylosRuntime(zylosDir),
    readCodexSession,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    options,
  });
}
