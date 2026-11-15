/**
 * Render an instant in the agent's configured timezone.
 *
 * Every timestamp this process handles arrives as UTC — the server sends
 * `settled_at` as ISO-8601 with a `Z`, and `new Date().toISOString()` produces
 * the same. Printed as-is, a receipt says `12:30` for something that happened
 * at 20:30 where the person reading it lives, and the reader either does the
 * arithmetic or, more often, misreads the answer as hours older than it is.
 *
 * 🔴 This is for DISPLAY only. The machine-readable copies stay UTC and stay
 * ISO: `<interaction-receipt settled-at="…"/>`, the `askedAt` written into
 * pending-questions.json, and anything compared against `Date.now()`. A local
 * rendering is ambiguous the moment it leaves the machine that made it (no
 * offset survives a `2026-09-24 20:30` string), so the two must not be swapped
 * for each other — which is why every call site here keeps the raw value
 * alongside rather than replacing it.
 *
 * 🔴 The zone is the AGENT's configured one, not the machine's. They happen to
 * match on this box, which is exactly why the difference has to be written down
 * rather than discovered later: a zylos agent is provisioned with a timezone
 * that lands in `~/zylos/.env` as `TZ=`, while the host it runs on is usually
 * UTC. Reading the host zone would be right here and silently wrong on the next
 * deployment — and the failure would look like nothing, just times that are
 * some hours off.
 *
 * Read `TZ=` from the agent's own `.env` first: a process managed by pm2 may
 * still inherit an older TZ after the file changes and an ordinary restart.
 * If the file provides no zone, use `TZ` in the process environment, then
 * whatever `Intl` defaults to. Deployments without a zylos `.env` keep the
 * process-environment behavior.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** The agent's zylos directory, resolved exactly as agent-readiness.js does. */
function zylosDir() {
  return process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
}

/**
 * The agent's configured zone, or '' when nothing configures one (callers then
 * let `Intl` pick, which is the host zone — the last resort, never the first).
 *
 * The `.env` read is deliberately not cached: this is called a handful of times
 * per process, and a stale zone after someone edits the file would be another
 * quiet wrongness of exactly the kind this module exists to remove.
 */
export function agentTimeZone() {
  try {
    const raw = fs.readFileSync(path.join(zylosDir(), '.env'), 'utf8');
    // Last assignment wins, matching how a shell would source the file.
    let found = '';
    for (const line of raw.split('\n')) {
      const m = /^\s*(?:export\s+)?TZ\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[1].trim().replace(/^["']|["']$/g, '').split('#')[0].trim();
      if (value) found = value;
    }
    if (found) return found;
  } catch {
    // No .env or unreadable: fall through to the process environment.
  }
  return (process.env.TZ || '').trim();
}

/**
 * `2026-09-24 20:30:12 (+08:00)`, or null when the input is not a time.
 *
 * The offset is part of the output on purpose: without it the string is a wall
 * clock with no zone, and a reader who is not on this machine cannot tell which
 * one it is. Returning null (rather than throwing or echoing the input) lets a
 * caller decide between the local form and the raw one.
 */
export function formatLocalTime(value, { timeZone = agentTimeZone() } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const at = (type) => parts.find((p) => p.type === type)?.value || '';
    const offset = at('timeZoneName').replace(/^GMT/, '') || '+00:00';
    const hour = at('hour') === '24' ? '00' : at('hour');
    return `${at('year')}-${at('month')}-${at('day')} ${hour}:${at('minute')}:${at('second')} (${offset})`;
  } catch {
    // An invalid TZ name makes Intl throw. A wrong-looking clock is worse than
    // no clock, so fall back to the caller's raw value by saying nothing.
    return null;
  }
}

// ── Wall-clock → instant (core.pause_self) ──────────────────────────────────
//
// `core.pause_self {at:"08:30"}` means "08:30 on the wall clock of a zone",
// which the platform needs as one absolute instant. Node has no Temporal yet
// and this package takes no date dependency, so the conversion is done with
// Intl alone: read the zone's offset around the wanted wall time, try each
// candidate instant, and keep the one whose wall clock reads back as wanted.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fieldFormatters = new Map();

function fieldFormatter(timeZone) {
  let fmt = fieldFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23',
    });
    fieldFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * True when `timeZone` is an IANA zone name such as `Asia/Shanghai`. Intl also
 * accepts a bare offset (`+08:00`); that is refused here because it is not a
 * zone (it has no DST rules) and the platform only takes IANA names.
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const name = timeZone.trim();
  if (!name || /^[+-]\d/.test(name)) return false;
  try {
    fieldFormatter(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA name as Intl spells it when the input differs only in case
 * (`asia/shanghai` → `Asia/Shanghai`); otherwise the input unchanged. Intl's
 * own canonical form is not used wholesale because it renames live zones
 * (`Asia/Kolkata` → `Asia/Calcutta`).
 */
export function canonicalTimeZone(timeZone) {
  const name = String(timeZone || '').trim();
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    return resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
  } catch {
    return name;
  }
}

/**
 * Wall-clock fields of an instant (epoch ms) in `timeZone`:
 * `{year, month (1-12), day, hour, minute, second, weekday (0=Sun), offsetMinutes}`.
 */
export function zonedFields(epochMs, timeZone) {
  const parts = fieldFormatter(timeZone).formatToParts(new Date(epochMs));
  const num = (type) => Number(parts.find((p) => p.type === type)?.value);
  const f = {
    year: num('year'), month: num('month'), day: num('day'),
    hour: num('hour'), minute: num('minute'), second: num('second'),
  };
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  f.offsetMinutes = Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / MINUTE_MS);
  f.weekday = new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
  return f;
}

/**
 * The instant (epoch ms) at which the wall clock of `timeZone` reads
 * `year-month-day hour:minute`. DST-safe:
 *   - the zone's offset a day before and a day after the wanted wall time
 *     covers both sides of any transition near it; each offset gives one
 *     candidate instant, kept only if its wall clock reads back as wanted;
 *   - a wall time that occurs twice (clocks set back) → the earlier instant;
 *   - a wall time that does not exist (clocks set forward) → the same wall
 *     time read with the offset before the change, i.e. moved forward by the
 *     length of the gap (02:30 on a spring-forward night in New York → 03:30).
 */
export function wallTimeToInstant({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = zonedFields(guess - DAY_MS, timeZone).offsetMinutes;
  const after = zonedFields(guess + DAY_MS, timeZone).offsetMinutes;
  const matches = [...new Set([before, after])]
    .map((offset) => guess - offset * MINUTE_MS)
    .filter((t) => {
      const f = zonedFields(t, timeZone);
      return f.year === year && f.month === month && f.day === day && f.hour === hour && f.minute === minute;
    });
  return matches.length ? Math.min(...matches) : guess - before * MINUTE_MS;
}

/**
 * The next instant strictly after `now` at which the wall clock of `timeZone`
 * reads `hour:minute`: today when that time is still ahead, else tomorrow.
 * With `skipWeekend`, a result on a local Saturday or Sunday moves to the
 * following Monday at the same wall time. Returns epoch ms. Any minimum
 * distance from now is the caller's rule (core.pause_self refuses < 30 min).
 */
export function nextWallClockTime({ hour, minute, timeZone, now, skipWeekend = false }) {
  const today = zonedFields(now, timeZone);
  // A calendar date is carried as UTC midnight so that adding days never
  // depends on the zone (or on DST).
  let date = Date.UTC(today.year, today.month - 1, today.day);
  const at = (d) => {
    const c = new Date(d);
    return wallTimeToInstant({ year: c.getUTCFullYear(), month: c.getUTCMonth() + 1, day: c.getUTCDate(), hour, minute }, timeZone);
  };
  let instant = at(date);
  // Normally at most one step (today → tomorrow); the bound only guards
  // against a zone whose rules would never produce the time.
  for (let i = 0; instant <= now; i++) {
    if (i >= 7) throw new Error(`no ${hour}:${minute} found in ${timeZone} within a week`);
    date += DAY_MS;
    instant = at(date);
  }
  if (skipWeekend) {
    const weekday = new Date(date).getUTCDay();
    if (weekday === 6 || weekday === 0) instant = at(date + (weekday === 6 ? 2 : 1) * DAY_MS);
  }
  return instant;
}

/**
 * `{local: "2026-11-16 08:30 (+08:00)", weekday: "Mon"}` for an instant in
 * `timeZone` — the minute-precision form an Agent quotes in a result summary
 * ("已暂停，2026-11-16 08:30 (+08:00) 恢复"). Null when the input is not a time
 * or the zone is invalid.
 */
export function describeLocalMinute(value, timeZone) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null;
  const f = zonedFields(ms, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  const off = Math.abs(f.offsetMinutes);
  const offset = `${f.offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
  return {
    local: `${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)} (${offset})`,
    weekday: WEEKDAYS[f.weekday],
  };
}
