/**
 * Read-only billing queries with the Agent's own token (OPENM-1375).
 *
 *   overview — GET /billing/plan-state: balance (paid / promo / breakdown),
 *              plan, status, current period, auto-renew, next charge,
 *              outstanding points. A curated subset; payment credentials and
 *              server capability flags are never returned.
 *   spend    — GET /billing/credit-statement paged and aggregated locally:
 *              consumption points per Agent (agent_identity / agent_name) and
 *              per category, totals and the top N Agents. The server caps one
 *              window at 92 days and page_size at 200, so longer ranges are
 *              split into consecutive ≤ 92-day windows, and the total number
 *              of pages is capped. Windows are read newest → oldest (and the
 *              server pages each window newest first), so a capped result
 *              (complete:false) covers an unbroken span ending at the range
 *              end, reported as covered_from / covered_to; every aggregate
 *              (total, top_agents, by_category) then covers only that span.
 *
 * No purchase / upgrade / top-up / auto-recharge call exists here on purpose:
 * those stay on the web (creditPageUrl).
 */

import { agentTimeZone, isValidTimeZone, zonedFields, wallTimeToInstant } from './local-time.js';

export const STATEMENT_WINDOW_MAX_MS = 92 * 86400000;
export const MAX_RANGE_DAYS = 366;
export const STATEMENT_PAGE_SIZE = 200;
export const MAX_STATEMENT_PAGES = 60;
export const DEFAULT_TOP = 10;
export const CREDIT_PAGE_PATH = '/account?tab=credit';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/** Curated plan-state view: what an admin asks about, nothing payment-sensitive. */
export function summarizePlanState(ps) {
  const sub = ps?.subscription;
  const usage = ps?.usage_snapshot;
  return {
    plan: sub ? pick(sub, [
      'plan_code', 'plan_name', 'custom_plan', 'status', 'billing_interval', 'current_period_start',
      'current_period_end', 'auto_renew', 'auto_renew_off_reason', 'trial_end', 'renewal_mode',
      'managed_until', 'next_charge_amount_cents', 'currency', 'pending_plan_code', 'pending_change_at',
      'next_grant_at', 'current_cycle_grant_points', 'free_fallback_reason',
    ]) : null,
    credits: usage ? pick(usage, [
      'credit_balance', 'credit_as_of', 'paid_balance', 'promo_balance', 'credit_breakdown',
      'period_consumed_points', 'outstanding_points', 'credit_pending', 'enforcement_suspended',
    ]) : null,
    seats: usage ? pick(usage, ['agent_slots_used', 'agent_slots_total', 'members_used', 'members_total']) : null,
    is_paid_plan: ps?.is_paid_plan,
  };
}

export async function fetchOverview(get) {
  return summarizePlanState(await get('/billing/plan-state'));
}

function parseTime(v, field) {
  if (typeof v !== 'string' || !RFC3339_RE.test(v) || !Number.isFinite(Date.parse(v))) {
    throw Object.assign(new Error(`${field} must be RFC3339 (e.g. 2026-11-01T00:00:00+08:00)`), { status: 400 });
  }
  return Date.parse(v);
}

function monthStart(now, timeZone) {
  const f = zonedFields(now, timeZone);
  return wallTimeToInstant({ year: f.year, month: f.month, day: 1, hour: 0, minute: 0 }, timeZone);
}

/**
 * Resolve the spend range. Exactly one of: {rangeStart, rangeEnd?}, {last:"Nd"},
 * {period:"month"|"billing_period"}; none → current calendar month to now in
 * the Agent's time zone (fallback Asia/Shanghai). Max MAX_RANGE_DAYS.
 * `billingPeriodStart` is plan-state's current_period_start (period:"billing_period").
 */
export function resolveSpendRange(params = {}, { now = Date.now(), timeZone, billingPeriodStart } = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const forms = ['rangeStart', 'last', 'period'].filter((k) => params[k] !== undefined);
  if (forms.length > 1) throw bad('use only one of rangeStart/rangeEnd, last, period');
  if (params.rangeEnd !== undefined && params.rangeStart === undefined) throw bad('rangeEnd needs rangeStart');
  const tz = timeZone || (isValidTimeZone(agentTimeZone()) ? agentTimeZone() : 'Asia/Shanghai');
  let start;
  let end = now;
  let label;
  if (params.rangeStart !== undefined) {
    start = parseTime(params.rangeStart, 'rangeStart');
    if (params.rangeEnd !== undefined) end = parseTime(params.rangeEnd, 'rangeEnd');
    label = 'custom';
  } else if (params.last !== undefined) {
    const m = /^([1-9]\d{0,2})d$/.exec(String(params.last));
    if (!m) throw bad('last must be whole days such as 7d or 30d');
    start = now - Number(m[1]) * 86400000;
    label = `last_${m[1]}d`;
  } else {
    const period = params.period ?? 'month';
    if (period === 'month') {
      start = monthStart(now, tz);
      label = 'month_to_date';
    } else if (period === 'billing_period') {
      const t = Date.parse(billingPeriodStart);
      if (!Number.isFinite(t)) throw bad('the current billing period start is unknown; use period "month" or an explicit range');
      start = t;
      label = 'billing_period_to_date';
    } else {
      throw bad('period must be month or billing_period');
    }
  }
  if (end > now) end = now;
  if (!(end > start)) throw bad('range end must be after range start (and not in the future)');
  if (end - start > MAX_RANGE_DAYS * 86400000) throw bad(`range must be at most ${MAX_RANGE_DAYS} days`);
  return { start, end, label, timeZone: tz };
}

/** Consecutive windows of at most `max` ms covering [start, end). */
export function splitWindows(start, end, max = STATEMENT_WINDOW_MAX_MS) {
  const out = [];
  for (let s = start; s < end; s += max) out.push([s, Math.min(s + max, end)]);
  return out;
}

const entryPoints = (e) => {
  const v = Number(e?.points_total ?? e?.points ?? 0);
  return Number.isFinite(v) ? Math.abs(v) : 0;
};

/**
 * Page through credit-statement for every window and aggregate consumptions.
 * `get(path, query)` returns the unwrapped `data` object.
 */
export async function fetchSpend(get, { start, end, top = DEFAULT_TOP, maxPages = MAX_STATEMENT_PAGES, pageSize = STATEMENT_PAGE_SIZE } = {}) {
  const agents = new Map();
  const categories = new Map();
  const seenCharges = new Set();
  let total = 0;
  let outstanding = 0;
  let count = 0;
  let pages = 0;
  let complete = true;
  let balance = null;
  let balanceAsOf = null;
  let coveredFrom = end;
  const add = (e) => {
    const pts = entryPoints(e);
    total += pts;
    outstanding += Math.max(0, Number(e?.outstanding_points) || 0);
    count++;
    const key = e?.agent_identity || '';
    const a = agents.get(key) || { agent_identity: key || null, agent_name: null, points: 0, entries: 0 };
    a.points += pts;
    a.entries++;
    if (!a.agent_name && typeof e?.agent_name === 'string' && e.agent_name) a.agent_name = e.agent_name;
    agents.set(key, a);
    const cat = e?.category || 'uncategorized';
    categories.set(cat, (categories.get(cat) || 0) + pts);
  };
  const windows = splitWindows(start, end);
  // Newest window first: a page cap then drops the OLDEST data, never the latest.
  // Rows of a window are buffered and counted once the window is settled, so a
  // truncated window contributes exactly the span it can vouch for.
  outer: for (const [ws, we] of [...windows].reverse()) {
    const rows = [];
    for (let page = 1; ; page++) {
      if (pages >= maxPages) {
        complete = false;
        // Truncated window (server order: newest first by time, kind, id). Rows
        // sharing the oldest timestamp read may continue on the next page, so
        // that whole instant is dropped and coverage starts 1 ms after it.
        // Rows without a readable time cannot be placed and are dropped too.
        const timed = rows.map((e) => [e, Date.parse(e?.occurred_at)]).filter(([, t]) => Number.isFinite(t));
        if (timed.length) {
          const boundary = Math.min(...timed.map(([, t]) => t));
          const kept = timed.filter(([, t]) => t > boundary);
          if (kept.length) {
            kept.forEach(([e]) => add(e));
            coveredFrom = Math.min(we, Math.max(ws, boundary + 1));
          }
          // All rows on one instant: nothing from this window is claimed;
          // coverage stays at the end of this window (= previous window start).
        }
        break outer;
      }
      const data = await get('/billing/credit-statement', {
        range_start: new Date(ws).toISOString(), range_end: new Date(we).toISOString(),
        page, page_size: pageSize,
      });
      pages++;
      if (balance === null && data?.balance !== undefined) { balance = data.balance; balanceAsOf = data.balance_as_of ?? null; }
      for (const e of Array.isArray(data?.consumptions) ? data.consumptions : []) {
        // A row on a window boundary could be returned by both windows.
        if (e?.charge_id) {
          if (seenCharges.has(e.charge_id)) continue;
          seenCharges.add(e.charge_id);
        }
        rows.push(e);
      }
      if (!data?.has_more) break;
    }
    rows.forEach(add);
    coveredFrom = ws;
  }
  const byAgent = [...agents.values()]
    .map((a) => ({ ...a, org_level: a.agent_identity === null }))
    .sort((x, y) => y.points - x.points);
  const n = Math.max(1, Math.min(100, Number.isInteger(top) ? top : DEFAULT_TOP));
  return {
    range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    // The span all aggregates below actually cover; equals range when complete.
    covered_from: new Date(coveredFrom).toISOString(),
    covered_to: new Date(end).toISOString(),
    windows: windows.length,
    pages,
    complete,
    total_points: total,
    outstanding_points: outstanding,
    consumption_entries: count,
    by_category: Object.fromEntries([...categories.entries()].sort((x, y) => y[1] - x[1])),
    top_agents: byAgent.slice(0, n),
    agent_count: byAgent.filter((a) => !a.org_level).length,
    balance,
    balance_as_of: balanceAsOf,
  };
}
