// Per-point stream helpers: distance, decimation, chart-ready series.
// Points are `{lat, lng, ele, time (Date|null), hr, cad, watts}`; distances are
// meters, times seconds. Pure — no DOM, no libraries.

const R = 6371000;
const RAD = Math.PI / 180;

/** Great-circle distance in meters between two {lat,lng} points. */
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Cumulative distance (m) at every point; result[0] === 0. */
export function cumulativeDistance(points) {
  const out = new Array(points.length);
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) acc += haversine(points[i - 1], points[i]);
    out[i] = acc;
  }
  return out;
}

/** Point time -> epoch ms; NaN when missing/invalid. */
export const toMs = t => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : NaN);

/** Centered moving average over odd window `w`, ignoring nulls (null stays null). */
export function smoothSeries(values, w = 5) {
  const half = Math.floor(w / 2);
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (values[i] == null) { out[i] = null; continue; }
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (values[j] != null) { s += values[j]; c++; }
    }
    out[i] = s / c;
  }
  return out;
}

/** Last index with dist[i] <= B (binary search on ascending `dist`); -1 if none. */
export function lastIndexAtOrBefore(dist, B) {
  let lo = 0, hi = dist.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= B) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** First index with dist[i] >= B; dist.length if none. */
export function firstIndexAtOrAfter(dist, B) {
  let lo = 0, hi = dist.length - 1, ans = dist.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] >= B) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

/** Linearly interpolate `values` (parallel to ascending `dist`) at distance B. */
export function interpolateAt(dist, values, B) {
  const n = dist.length;
  if (B <= dist[0]) return values[0];
  if (B >= dist[n - 1]) return values[n - 1];
  const k = lastIndexAtOrBefore(dist, B);
  const seg = dist[k + 1] - dist[k];
  return values[k] + (values[k + 1] - values[k]) * ((B - dist[k]) / seg);
}

/**
 * Reduce to <= maxPoints keeping shape (Douglas-Peucker importance ranking:
 * the most shape-defining points survive). First and last are always kept;
 * order is preserved; input is not mutated. Returns original point objects.
 */
export function decimate(points, maxPoints) {
  const n = points.length;
  if (!(maxPoints >= 2) || n <= maxPoints) return points.slice();
  const kx = R * RAD * Math.cos(points[0].lat * RAD);
  const ky = R * RAD;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = points[i].lng * kx; Y[i] = points[i].lat * ky; }

  const imp = new Float64Array(n);
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const dx = X[hi] - X[lo], dy = Y[hi] - Y[lo];
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = -1;
    for (let i = lo + 1; i < hi; i++) {
      let d;
      if (len2 === 0) d = Math.hypot(X[i] - X[lo], Y[i] - Y[lo]);
      else {
        const t = Math.max(0, Math.min(1, ((X[i] - X[lo]) * dx + (Y[i] - Y[lo]) * dy) / len2));
        d = Math.hypot(X[i] - (X[lo] + t * dx), Y[i] - (Y[lo] + t * dy));
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    imp[best] = bestD;
    stack.push([lo, best], [best, hi]);
  }

  const inner = [];
  for (let i = 1; i < n - 1; i++) inner.push(i);
  inner.sort((a, b) => imp[b] - imp[a] || a - b);
  const keep = [0, n - 1, ...inner.slice(0, maxPoints - 2)].sort((a, b) => a - b);
  return keep.map(i => points[i]);
}

/**
 * Chart-ready series, all arrays the same length (<= maxSamples, default 800,
 * evenly sampled from the full-resolution data after smoothing).
 *   dist  m from start          ele   m (lightly smoothed) | null
 *   speed m/s | null            pace  s/m | null (null when stopped < 0.3 m/s)
 *   hr, cad, watts  | null      time  s from start | null (when timestamps incomplete)
 *   idx   index into the original `points`
 * Speed/pace use a centered window of `smoothWindow` seconds (default 30) and
 * are clamped to <= 40 m/s so GPS spikes don't wreck the scale.
 */
export function buildSeries(points, { smoothWindow = 30, maxSamples = 800 } = {}) {
  const n = points.length;
  const out = { dist: [], ele: [], pace: [], speed: [], hr: [], cad: [], watts: [], time: [], idx: [] };
  if (n === 0) return out;

  const d = cumulativeDistance(points);
  const tms = points.map(p => toMs(p.time));
  const hasTime = n > 1 && tms.every(Number.isFinite);
  const ele = smoothSeries(points.map(p => (Number.isFinite(p.ele) ? p.ele : null)), 5);

  const speed = new Array(n).fill(null);
  if (hasTime) {
    const half = smoothWindow * 500;
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (tms[lo] < tms[i] - half) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < n && tms[hi + 1] <= tms[i] + half) hi++;
      let a = lo, b = hi;
      if (a === b) { a = Math.max(0, i - 1); b = Math.min(n - 1, i + 1); }
      const dt = (tms[b] - tms[a]) / 1000;
      speed[i] = dt > 0 ? Math.min(40, Math.max(0, (d[b] - d[a]) / dt)) : null;
    }
  }

  let idxs;
  if (n <= maxSamples) idxs = points.map((_, i) => i);
  else {
    const set = new Set();
    for (let i = 0; i < maxSamples; i++) set.add(Math.round(i * (n - 1) / (maxSamples - 1)));
    idxs = [...set];
  }
  const pos = v => (Number.isFinite(v) && v > 0 ? v : null);
  for (const i of idxs) {
    const p = points[i];
    out.idx.push(i);
    out.dist.push(d[i]);
    out.ele.push(ele[i]);
    out.speed.push(speed[i]);
    out.pace.push(speed[i] != null && speed[i] >= 0.3 ? 1 / speed[i] : null);
    out.hr.push(pos(p.hr));
    out.cad.push(pos(p.cad));
    out.watts.push(pos(p.watts));
    out.time.push(hasTime ? (tms[i] - tms[0]) / 1000 : null);
  }
  return out;
}

/** True when at least 2 points carry usable data for the stream. */
export function hasStream(points, kind) {
  const ok = {
    time: p => Number.isFinite(toMs(p.time)),
    ele: p => Number.isFinite(p.ele),
    hr: p => p.hr > 0,
    cad: p => p.cad > 0,
    watts: p => p.watts > 0,
  }[kind];
  if (!ok || !points) return false;
  let c = 0;
  for (const p of points) if (ok(p) && ++c >= 2) return true;
  return false;
}
