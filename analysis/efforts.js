// Best efforts: fastest contiguous stretch of a given distance within a route
// (sliding window with interpolation at the ends). Pure.

import { cumulativeDistance, toMs, interpolateAt,
  lastIndexAtOrBefore, firstIndexAtOrAfter } from './streams.js';

// [key, label, meters] — keys are unique across types so results can be merged.
export const RUN_EFFORTS = [
  ['400m', '400 m', 400], ['1k', '1 km', 1000], ['1mi', '1 mile', 1609.344],
  ['5k', '5 km', 5000], ['10k', '10 km', 10000], ['15k', '15 km', 15000],
  ['half', 'Half marathon', 21097.5], ['marathon', 'Marathon', 42195],
];
export const RIDE_EFFORTS = [
  ['ride-5k', '5 km', 5000], ['ride-10k', '10 km', 10000],
  ['ride-20k', '20 km', 20000], ['ride-40k', '40 km', 40000],
];

const defsFor = type => (type === 'Run' ? RUN_EFFORTS : type === 'Ride' ? RIDE_EFFORTS : []);
// Windows faster than this are GPS/timestamp garbage, not efforts.
const MAX_SPEED = { Run: 10, Ride: 30 };

/**
 * Fastest window per standard distance <= the route's length.
 *   -> [{key, label, dist_m, time_s, start_idx, end_idx}]
 * start_idx/end_idx are the point indices bracketing the window (start is the
 * point at/before it, end the point at/after it). Only Run and Ride have
 * defined efforts; other types, or routes without timestamps, give [].
 */
export function bestEfforts(points, type) {
  const defs = defsFor(type);
  const n = points?.length || 0;
  if (!defs.length || n < 2) return [];
  const t = points.map(p => toMs(p.time));
  if (!t.every(Number.isFinite)) return [];
  const d = cumulativeDistance(points);
  const total = d[n - 1];
  const maxSpeed = MAX_SPEED[type];

  const out = [];
  for (const [key, label, D] of defs) {
    if (D > total + 1e-6) continue;
    let best = null;
    const consider = (time_s, s, e) => {
      if (time_s > 0 && D / time_s <= maxSpeed && (!best || time_s < best.time_s)) {
        best = { key, label, dist_m: D, time_s, start_idx: Math.max(0, s), end_idx: Math.min(n - 1, e) };
      }
    };
    // windows ending on a recorded point
    for (let j = firstIndexAtOrAfter(d, D - 1e-6); j < n; j++) {
      const ts = interpolateAt(d, t, d[j] - D);
      consider((t[j] - ts) / 1000, lastIndexAtOrBefore(d, d[j] - D), j);
    }
    // windows starting on a recorded point
    for (let i = 0; i < n && d[i] + D <= total + 1e-6; i++) {
      const te = interpolateAt(d, t, d[i] + D);
      consider((te - t[i]) / 1000, i, firstIndexAtOrAfter(d, d[i] + D));
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Best per effort key across many activities.
 * items: [{id, type, date, route_points | points}]
 *   -> [{...effort, activity_id, type, date}] ordered Run distances then Ride.
 */
export function bestEffortsAcross(items) {
  const best = new Map();
  for (const it of items || []) {
    const pts = it.route_points ?? it.points;
    if (!pts) continue;
    for (const e of bestEfforts(pts, it.type)) {
      const cur = best.get(e.key);
      if (!cur || e.time_s < cur.time_s) {
        best.set(e.key, { ...e, activity_id: it.id, type: it.type, date: it.date ?? null });
      }
    }
  }
  return [...RUN_EFFORTS, ...RIDE_EFFORTS].map(([k]) => best.get(k)).filter(Boolean);
}
