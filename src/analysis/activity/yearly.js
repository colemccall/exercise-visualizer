// Yearly / monthly / weekly rollups (Strava-profile style). Pure.
// Days are LOCAL calendar days (see dates.js). Time = moving_s ?? duration_s.

import { dayKey, dayOfYear } from '../dates.js';

export { dayKey };

/** Activities hidden by dedup-merge are never counted. */
export const isVisible = a => !!a && !a.merged_into && a.date instanceof Date;
/** Moving time in seconds, falling back to elapsed. */
export const movingTime = a => a.moving_s ?? a.duration_s ?? 0;

const bucket = () => ({ count: 0, distance_m: 0, moving_s: 0 });
const add = (b, a) => { b.count++; b.distance_m += a.distance_m || 0; b.moving_s += movingTime(a); };

/** Local calendar years that have activities, newest first. */
export function availableYears(acts) {
  const ys = new Set();
  for (const a of acts || []) if (isVisible(a)) ys.add(a.date.getFullYear());
  return [...ys].sort((x, y) => y - x);
}

/**
 * Rollup for one local year, or all-time when year is null.
 * opts.types: optional array of activity types to include.
 *   -> {year, count, distance_m, moving_s, elevation_m,
 *       calories_kcal (null if no activity had calories),
 *       by_type: {Run: {count,distance_m,moving_s}, ...},
 *       by_month: 12 x {count,distance_m,moving_s}   (index 0 = January),
 *       by_week:  53 x {count,distance_m,moving_s}   (index = floor((dayOfYear-1)/7)),
 *       active_days, longest_activity (Activity|null), biggest_climb (Activity|null)}
 */
export function yearlyStats(acts, year = null, opts = {}) {
  const types = opts.types?.length ? new Set(opts.types) : null;
  const out = {
    year, count: 0, distance_m: 0, moving_s: 0, elevation_m: 0, calories_kcal: null,
    by_type: {}, by_month: Array.from({ length: 12 }, bucket),
    by_week: Array.from({ length: 53 }, bucket),
    active_days: 0, longest_activity: null, biggest_climb: null,
  };
  const days = new Set();
  for (const a of acts || []) {
    if (!isVisible(a)) continue;
    if (year != null && a.date.getFullYear() !== year) continue;
    if (types && !types.has(a.type)) continue;
    const key = dayKey(a.date);
    days.add(key);
    add(out, a);
    out.elevation_m += a.elevation_gain_m || 0;
    if (Number.isFinite(a.calories_kcal)) out.calories_kcal = (out.calories_kcal ?? 0) + a.calories_kcal;
    add(out.by_type[a.type] ??= bucket(), a);
    add(out.by_month[a.date.getMonth()], a);
    add(out.by_week[Math.min(52, Math.floor((dayOfYear(key) - 1) / 7))], a);
    if ((a.distance_m || 0) > (out.longest_activity?.distance_m ?? 0)) out.longest_activity = a;
    if ((a.elevation_gain_m || 0) > (out.biggest_climb?.elevation_gain_m ?? 0)) out.biggest_climb = a;
  }
  out.active_days = days.size;
  return out;
}

/**
 * Year A vs year B (opts.types as above).
 *   -> {a, b, delta:{count,distance_m,moving_s,elevation_m} (b - a),
 *       pct:{...same keys, (b-a)/a or null when a is 0},
 *       by_month: 12 x {month, a: distance_m, b: distance_m}}
 */
export function compareYears(acts, yearA, yearB, opts = {}) {
  const a = yearlyStats(acts, yearA, opts), b = yearlyStats(acts, yearB, opts);
  const keys = ['count', 'distance_m', 'moving_s', 'elevation_m'];
  const delta = {}, pct = {};
  for (const k of keys) { delta[k] = b[k] - a[k]; pct[k] = a[k] > 0 ? delta[k] / a[k] : null; }
  return {
    a, b, delta, pct,
    by_month: a.by_month.map((m, i) => ({ month: i, a: m.distance_m, b: b.by_month[i].distance_m })),
  };
}
