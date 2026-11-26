/**
 * Minimal cron support for the user crontab part of the task inventory
 * (task-inventory.js): parse a `crontab -l` line and compute its next runs in
 * a given IANA time zone. Pure apart from `systemTimeZone`.
 *
 * Supported: the five standard fields (minute hour day-of-month month
 * day-of-week) with `*`, numbers, `a-b` ranges, `/n` steps (`*` + step,
 * `a-b/n`, and cronie's `a/n` = `a-max/n`), comma lists, month names
 * (jan…dec) and day names (sun…sat, 7 = Sunday too), and the macros @yearly,
 * @annually, @monthly, @weekly, @daily, @midnight, @hourly and @reboot.
 * Anything else (`?`, `L`, `W`, `#`, six fields, out-of-range values) is
 * unparsable.
 *
 * Day matching follows Vixie cron: when day-of-month or day-of-week starts
 * with `*`, a day must match both; otherwise either one is enough.
 *
 * Time zones: candidates are searched in wall-clock time and converted to an
 * instant with the zone's offset (Intl). A wall time skipped by a DST change
 * runs at the same wall time after the change (shifted by the gap), and
 * duplicates are dropped, so runs are strictly increasing.
 */

import fs from 'fs';

const MINUTE_MS = 60_000;
const SEARCH_YEARS = 28; // a full leap-year/weekday cycle; no run in it (e.g. Feb 30) = none

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'dow', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

export const CRON_MACROS = Object.freeze({
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
});

function parseValue(text, field) {
  if (/^\d+$/.test(text)) return Number(text);
  if (field.names) {
    const i = field.names.indexOf(text.toLowerCase());
    if (i >= 0) return i + field.nameBase;
  }
  return null;
}

// One field → Set of allowed values, or null when invalid.
function parseField(text, field) {
  const out = new Set();
  for (const item of text.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(item);
    if (!m) return null;
    const [, range, stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!(step >= 1)) return null;
    let lo, hi;
    if (range === '*') {
      lo = field.min;
      hi = field.name === 'dow' ? 6 : field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      if (lo === null || hi === null || lo > hi) return null;
    } else {
      lo = parseValue(range, field);
      if (lo === null) return null;
      // `a/n` (cronie): from a to the end of the range.
      hi = stepText === undefined ? lo : (field.name === 'dow' ? 6 : field.max);
    }
    if (lo < field.min || hi > field.max) return null;
    for (let v = lo; v <= hi; v += step) out.add(field.name === 'dow' && v === 7 ? 0 : v);
  }
  return out.size ? out : null;
}

/**
 * Parse a cron schedule: five fields or a macro.
 * @returns {{ok: true, reboot?: true, minute?: Set, hour?: Set, dom?: Set, month?: Set,
 *   dow?: Set, domStar?: boolean, dowStar?: boolean} | {ok: false}}
 */
export function parseCron(expr) {
  const text = String(expr ?? '').trim();
  if (text.toLowerCase() === '@reboot') return { ok: true, reboot: true };
  const expanded = CRON_MACROS[text.toLowerCase()] ?? text;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return { ok: false };
  const spec = { ok: true };
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i], FIELDS[i]);
    if (!set) return { ok: false };
    spec[FIELDS[i].name] = set;
  }
  spec.domStar = parts[2].startsWith('*');
  spec.dowStar = parts[4].startsWith('*');
  return spec;
}

/**
 * Classify one `crontab -l` line.
 * @returns {{kind: 'skip'} |
 *   {kind: 'job', schedule: string, command: string, spec: object} |
 *   {kind: 'job', unparsable: true, raw: string}}
 *   `skip`: blank, comment or environment assignment (`NAME=value`).
 */
export function parseCrontabLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text.startsWith('#')) return { kind: 'skip' };
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)) return { kind: 'skip' };
  if (text.startsWith('@')) {
    const m = /^(@\S+)\s+(\S.*)$/.exec(text);
    const spec = m ? parseCron(m[1]) : { ok: false };
    if (!m || !spec.ok) return { kind: 'job', unparsable: true, raw: text };
    return { kind: 'job', schedule: m[1], command: m[2], spec };
  }
  const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(text);
  if (!m) return { kind: 'job', unparsable: true, raw: text };
  const schedule = m.slice(1, 6).join(' ');
  const spec = parseCron(schedule);
  if (!spec.ok) return { kind: 'job', unparsable: true, raw: text };
  return { kind: 'job', schedule, command: m[6], spec };
}

const dtfCache = new Map();
function formatterFor(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** UTC offset of `tz` at `instantMs`, in ms (local = instant + offset). */
export function tzOffsetMs(instantMs, tz) {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(whole))) p[type] = value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - whole;
}

// Wall-clock ms (local fields stored as UTC) → instant. Candidates come from
// the offsets around the wall time; a candidate is valid when it reads back as
// the same wall time. Ambiguous (DST fall-back): the first occurrence. Skipped
// (DST spring-forward): the later candidate, i.e. after the gap.
function wallToInstant(wallMs, tz) {
  const offsets = new Set([
    tzOffsetMs(wallMs - 86_400_000, tz),
    tzOffsetMs(wallMs, tz),
    tzOffsetMs(wallMs + 86_400_000, tz),
  ]);
  const candidates = [...offsets].map((o) => wallMs - o);
  const valid = candidates.filter((t) => t + tzOffsetMs(t, tz) === wallMs);
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}

/** Whether `tz` is a time zone Intl accepts. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next `n` runs of a parsed spec strictly after `fromMs`, in `tz`.
 * @returns {number[]} epoch ms, ascending; [] for @reboot or a rule that never matches
 */
export function nextCronRuns(spec, fromMs, tz, n = 5) {
  if (!spec?.ok || spec.reboot || n <= 0) return [];
  const runs = [];
  const wallFrom = fromMs + tzOffsetMs(fromMs, tz);
  let w = Math.floor(wallFrom / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const stop = wallFrom + SEARCH_YEARS * 366 * 86_400_000;
  while (runs.length < n && w <= stop) {
    const d = new Date(w);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
    if (!spec.month.has(mo + 1)) { w = Date.UTC(y, mo + 1, 1); continue; }
    const domOk = spec.dom.has(day), dowOk = spec.dow.has(d.getUTCDay());
    const dayOk = spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) { w = Date.UTC(y, mo, day + 1); continue; }
    if (!spec.hour.has(h)) { w = Date.UTC(y, mo, day, h + 1); continue; }
    if (!spec.minute.has(d.getUTCMinutes())) { w += MINUTE_MS; continue; }
    const at = wallToInstant(w, tz);
    if (at > fromMs && (runs.length === 0 || at > runs[runs.length - 1])) runs.push(at);
    w += MINUTE_MS;
  }
  return runs;
}

/**
 * The machine's time zone as cron sees it: /etc/localtime's zoneinfo link,
 * else /etc/timezone, else this process's zone (which honours $TZ), else UTC.
 */
export function systemTimeZone({
  readlink = fs.readlinkSync,
  readFile = fs.readFileSync,
  processZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  try {
    const m = /zoneinfo\/(.+)$/.exec(readlink('/etc/localtime'));
    if (m && isValidTimeZone(m[1])) return m[1];
  } catch { /* not a link, or absent */ }
  try {
    const z = String(readFile('/etc/timezone', 'utf8')).trim();
    if (isValidTimeZone(z)) return z;
  } catch { /* absent */ }
  try {
    const z = processZone();
    if (isValidTimeZone(z)) return z;
  } catch { /* fall through */ }
  return 'UTC';
}
