// Per-km / per-mile splits from a route's points. Pure.

import { cumulativeDistance, toMs, smoothSeries, interpolateAt,
  lastIndexAtOrBefore, firstIndexAtOrAfter } from './streams.js';

export const MILE_M = 1609.344;

/**
 * Full 1 km / 1 mile splits with boundaries interpolated between points, plus
 * a final partial split (partial:true) when > 5 m remain.
 *   -> [{index (1-based), dist_m, time_s, pace_s_per_m, ele_gain_m|null,
 *        ele_loss_m|null, avg_hr|null, partial}]
 * Returns [] when any point lacks a timestamp or the route has no distance.
 * Elevation is lightly smoothed first; gain/loss are null with no elevation data.
 */
export function computeSplits(points, units = 'mi') {
  const n = points?.length || 0;
  if (n < 2) return [];
  const t = points.map(p => toMs(p.time));
  if (!t.every(Number.isFinite)) return [];
  const d = cumulativeDistance(points);
  const total = d[n - 1];
  if (!(total > 0)) return [];
  const unit = units === 'km' ? 1000 : MILE_M;

  let e = null;
  if (points.some(p => Number.isFinite(p.ele))) {
    const raw = points.map(p => (Number.isFinite(p.ele) ? p.ele : null));
    let first = raw.find(v => v != null);
    for (let i = 0; i < n; i++) { if (raw[i] == null) raw[i] = first; else first = raw[i]; }
    e = smoothSeries(raw, 5);
  }

  const out = [];
  for (let s = 0; ; s++) {
    const startD = s * unit;
    if (startD >= total) break;
    const full = startD + unit <= total + 1e-3;
    const endD = full ? startD + unit : total;
    const len = endD - startD;
    if (!full && len < 5) break;

    const t0 = interpolateAt(d, t, startD), t1 = interpolateAt(d, t, endD);
    const iS = firstIndexAtOrAfter(d, startD), iE = lastIndexAtOrBefore(d, endD);

    let hrSum = 0, hrN = 0;
    for (let i = iS; i <= iE; i++) if (points[i].hr > 0) { hrSum += points[i].hr; hrN++; }

    let gain = null, loss = null;
    if (e) {
      gain = 0; loss = 0;
      let prev = interpolateAt(d, e, startD);
      const step = v => { const dv = v - prev; if (dv > 0) gain += dv; else loss -= dv; prev = v; };
      for (let i = iS; i <= iE; i++) if (d[i] > startD && d[i] < endD) step(e[i]);
      step(interpolateAt(d, e, endD));
    }

    const time_s = (t1 - t0) / 1000;
    out.push({
      index: s + 1,
      dist_m: len,
      time_s,
      pace_s_per_m: time_s / len,
      ele_gain_m: gain,
      ele_loss_m: loss,
      avg_hr: hrN ? hrSum / hrN : null,
      partial: !full,
    });
    if (!full) break;
  }
  return out;
}
