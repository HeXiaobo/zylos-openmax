/**
 * Throttled warn logger for the activity reporting path.
 *
 * The reporting path is high-frequency (one poll every 750 ms, up to several
 * frames a second), so it never logs per frame or per poll. A genuinely
 * recurring problem is logged through this helper instead: at most one line
 * per reason per interval, and the next line carries how many were
 * suppressed in between. Per-frame outcomes go to counters, not here.
 */

import { THROTTLED_LOG_INTERVAL_MS } from './constants.js';

export function createThrottledLogger({ warn, intervalMs = THROTTLED_LOG_INTERVAL_MS, now = Date.now } = {}) {
  const sink = warn || ((...a) => console.warn(...a));
  /** reason → { last, suppressed } */
  const state = new Map();

  return {
    warn(reason, ...args) {
      const t = now();
      const s = state.get(reason);
      if (s && t - s.last < intervalMs) {
        s.suppressed += 1;
        return false;
      }
      const suppressed = s ? s.suppressed : 0;
      state.set(reason, { last: t, suppressed: 0 });
      sink(`[activity] ${reason}:`, ...args, ...(suppressed > 0 ? [`(${suppressed} suppressed)`] : []));
      return true;
    },
  };
}
