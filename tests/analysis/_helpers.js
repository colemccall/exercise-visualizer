// Synthetic data builders for the analysis tests (not a test file itself).

const R = 6371000;
export const DEG_PER_M = 180 / Math.PI / R;

/**
 * Straight north-bound route from legs [{dist, speed}] (meters, m/s) sampled every
 * `spacing` m. Distances come out exact (to float noise); times are exact when
 * spacing/speed is a whole number of ms.
 */
export function buildRoute(legs, { spacing = 20, start = new Date(2025, 0, 1, 8), withTime = true, ele, hr } = {}) {
  const pts = [];
  let d = 0, t = 0;
  const push = () => pts.push({
    lat: 40 + d * DEG_PER_M, lng: -105,
    ele: ele ? ele(d) : null, hr: hr ?? null, cad: null, watts: null,
    time: withTime ? new Date(start.getTime() + Math.round(t * 1000)) : null,
  });
  push();
  for (const leg of legs) {
    const n = Math.round(leg.dist / spacing);
    for (let i = 0; i < n; i++) { d += spacing; t += spacing / leg.speed; push(); }
  }
  return pts;
}

let seq = 0;
export function act(date, type = 'Run', distance_m = 5000, duration_s = 1800, extra = {}) {
  return { id: `a${++seq}`, source: 'strava', name: `${type} ${seq}`, type, date, distance_m, duration_s,
    moving_s: duration_s, elevation_gain_m: 0, avg_heart_rate: null, ...extra };
}
