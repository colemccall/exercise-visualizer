// Local-calendar date helpers shared by the analysis modules.
// All "days" are LOCAL calendar days keyed 'YYYY-MM-DD' — one definition, so the
// UTC-vs-local mismatch (see CLAUDE.md timezone note) can't creep back in.
// Key arithmetic goes through Date.UTC so DST never shifts a day.

const pad = n => String(n).padStart(2, '0');
const DAY_MS = 864e5;

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Local 'YYYY-MM-DD' for a Date (or anything `new Date()` accepts). */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> {y, m (1-12), d}. */
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** 'YYYY-MM-DD' -> local Date at `hour` (default noon, safe from DST edges). */
export function keyToDate(key, hour = 12) {
  const { y, m, d } = parseKey(key);
  return new Date(y, m - 1, d, hour);
}

/** Add n days (may be negative) to a day key. */
export function addDays(key, n) {
  const { y, m, d } = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from key a to key b (b - a). */
export function daysBetween(a, b) {
  const pa = parseKey(a), pb = parseKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** Monday of the week containing a day key or Date, as a day key. */
export function weekStartKey(x) {
  const key = typeof x === 'string' ? x : dayKey(x);
  const { y, m, d } = parseKey(key);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon = 0
  return addDays(key, -dow);
}

/** Days in month (m is 1-12). */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 1-based day of year for a day key. */
export function dayOfYear(key) {
  const { y, m, d } = parseKey(key);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
}

/**
 * Split sorted unique keys into runs where each key is `step` days after the
 * previous. -> [{start, end, length, keys}] in chronological order.
 */
export function consecutiveRuns(sortedKeys, step = 1) {
  const runs = [];
  let cur = null;
  for (const k of sortedKeys) {
    if (cur && addDays(cur.end, step) === k) {
      cur.end = k; cur.keys.push(k); cur.length++;
    } else {
      cur = { start: k, end: k, length: 1, keys: [k] };
      runs.push(cur);
    }
  }
  return runs;
}

/** Key at which the first run of length >= n reaches n days; null if none. */
export function streakReachedKey(runs, n) {
  for (const r of runs) if (r.length >= n) return r.keys[n - 1];
  return null;
}

export const longestRun = runs => runs.reduce((m, r) => Math.max(m, r.length), 0);
