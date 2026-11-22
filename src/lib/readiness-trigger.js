/**
 * Event-driven runtime-metrics trigger.
 *
 * WHY: `runtime.state` (IDLE / BUSY / OFFLINE …) is what the platform reads to
 * decide whether an Agent can be talked to, but it only travels upward on the
 * runtime-metrics tick — 60s by default, plus a 15s initial delay. A freshly
 * provisioned Agent can therefore sit "greyed out" in the UI for up to a minute
 * after it is genuinely able to work. This watcher closes that window by firing
 * one extra report the moment the gate-relevant state actually changes.
 *
 * WHAT COUNTS AS A CHANGE — deliberately NOT every state transition. The local
 * execution state flaps between busy and idle constantly while an agent works
 * (observed in the readiness logs: busy → idle_too_brief → busy within seconds).
 * Reporting on every flap would turn a 1/min PUT into a continuous stream for a
 * working agent, which is a worse problem than the latency it fixes. So the
 * fingerprint is only what the platform's chat gate can act on:
 *
 *   - `stage` — how far provisioning has provably got (see READINESS_STAGES in
 *               agent-readiness.js). `ready` and `observable` are derived from
 *               it, so comparing the stage subsumes both.
 *
 * busy↔idle does not move the stage (both are `session_ready`), so an agent
 * grinding through a long task produces no extra reports.
 *
 * The periodic tick is left exactly as it is: this only adds reports, never
 * removes them, so a missed edge still heals on the next tick.
 */

import { readinessReport, normalizeNumericOptions } from './agent-readiness.js';

export const TRIGGER_DEFAULTS = {
  pollMs: 2000,     // matches the readiness gate's own cadence
  minGapMs: 5000,   // floor between event-driven reports, so a pathological flip cannot spam
};

/**
 * Public config (`metricsReport.readinessTrigger`) is snake_case, like every
 * other operator-facing key; internals are camelCase. Without this mapping the
 * documented knobs are read, found not to match any default, and silently
 * dropped — an operator setting `poll_ms: 123` keeps getting 2000ms with
 * nothing to explain why. camelCase is accepted too, for programmatic callers.
 */
const TRIGGER_OPTION_ALIASES = {
  poll_ms: 'pollMs',
  min_gap_ms: 'minGapMs',
};

// minGapMs = 0 is a real setting ("no floor between event-driven reports"),
// unlike pollMs where 0 would turn the watcher into a busy spin.
const TRIGGER_ZERO_OK = ['minGapMs'];

/**
 * @param {object} deps
 * @param {() => {ready: boolean, reason: string}} deps.evaluate  readiness gate's one-shot check
 * @param {() => Promise<void>} deps.report                       the existing reportMetrics()
 * @param {(fn: Function, ms: number) => any} deps.setIntervalImpl
 * @param {() => number} deps.now
 * @param {() => object} [deps.options]
 */
export function createReadinessTrigger({
  evaluate, report, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  now = Date.now, options = () => ({}), log = () => {}, warn = () => {},
}) {
  let last = null;        // previous fingerprint, null until the first sample
  let lastReportAt = 0;
  let timer = null;
  let inflight = false;

  function settings() {
    return {
      ...TRIGGER_DEFAULTS,
      ...normalizeNumericOptions(options(), TRIGGER_DEFAULTS, TRIGGER_OPTION_ALIASES, { allowZero: TRIGGER_ZERO_OK }),
    };
  }

  /**
   * Reduce the gate verdict to what the platform can act on.
   *
   * Shares readinessReport() with the metrics payload on purpose: this used to
   * keep its own copy of the "observable" reason list, which is exactly the
   * kind of duplicate vocabulary that drifts once someone adds a reason in one
   * place only.
   */
  async function fingerprint() {
    return readinessReport(await evaluate());
  }

  async function fire(fp, cause) {
    lastReportAt = now();
    try {
      log(`[readiness-trigger] state changed (${cause}) — reporting runtime-metrics immediately`);
      await report();
    } catch (err) {
      // The periodic tick remains the safety net, so a failed edge report is
      // not escalated beyond a warning.
      warn(`[readiness-trigger] immediate report failed: ${err.message}`);
    }
  }

  async function tick() {
    // The same guard covers async sampling and reporting: slow probes must not
    // finish out of order and move the remembered stage backwards.
    if (inflight) return;
    inflight = true;
    try {
      await sampleAndReport();
    } finally {
      inflight = false;
    }
  }

  async function sampleAndReport() {
    const cfg = settings();
    const fp = await fingerprint();

    if (last === null) {
      // First sample establishes the baseline. Deliberately no report: the
      // reporter's own initial tick already covers process start.
      last = fp;
      return;
    }
    // Compare the STAGE, not the two bits. `ready` and `observable` are both
    // derived from it, so the stage subsumes them — and it also catches
    // runtime_down→runtime_up, which moves neither bit but IS a step the
    // platform's provisioning progress shows. Without this, that first step
    // waited for the next periodic tick (up to 60s) even though we knew
    // seconds after boot.
    //
    // Still flap-free where it matters: busy and idle_too_brief both map to
    // session_ready, so an agent grinding through work produces no reports.
    if (fp.stage === last.stage) return;

    const cause = `stage ${last.stage}→${fp.stage} (${fp.reason})`;
    last = fp;
    if (now() - lastReportAt < cfg.minGapMs) {
      // Inside the floor — the periodic tick will carry it. Log so a suppressed
      // edge is visible rather than mysteriously absent.
      log(`[readiness-trigger] state changed (${cause}) but within ${cfg.minGapMs}ms floor — deferring to the periodic tick`);
      return;
    }
    await fire(fp, cause);
  }

  return {
    /** Exposed for tests and for a one-shot check. */
    tick,
    start() {
      if (timer) return;
      const { pollMs } = settings();
      timer = setIntervalImpl(() => { tick().catch(() => {}); }, pollMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) { clearIntervalImpl(timer); timer = null; }
    },
  };
}
