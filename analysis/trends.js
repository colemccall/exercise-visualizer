// Apple-Fitness-style Trends: trailing 90 days vs the trailing 365-day baseline. Pure.

import { isVisible, movingTime } from './yearly.js';

const DAY = 864e5;
const FLAT = 0.03; // within 3% reads as "flat"
const MIN_HISTORY_DAYS = 120;

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

const METRICS = [
  { key: 'weekly_distance', label: 'Weekly distance', unit_kind: 'distance', good: 'up',
    value: (xs, wk) => sum(xs, a => a.distance_m || 0) / wk },
  { key: 'weekly_minutes', label: 'Weekly active time', unit_kind: 'duration', good: 'up',
    value: (xs, wk) => sum(xs, movingTime) / wk },
  { key: 'weekly_workouts', label: 'Weekly workouts', unit_kind: 'count', good: 'up',
    value: (xs, wk) => xs.length / wk },
  { key: 'avg_workout_length', label: 'Avg workout length', unit_kind: 'duration', good: null,
    value: xs => sum(xs, movingTime) / xs.length },
  { key: 'avg_pace', label: 'Avg running pace', unit_kind: 'pace', good: 'down',
    pick: a => a.type === 'Run' && (a.distance_m || 0) >= 1000 && movingTime(a) > 0, min: [2, 5],
    value: xs => sum(xs, movingTime) / sum(xs, a => a.distance_m) },
  { key: 'avg_hr', label: 'Avg heart rate', unit_kind: 'hr', good: null,
    pick: a => a.avg_heart_rate > 0, min: [2, 5],
    value: xs => sum(xs, a => a.avg_heart_rate * (movingTime(a) || 1)) / sum(xs, a => movingTime(a) || 1) },
  { key: 'weekly_calories', label: 'Weekly energy', unit_kind: 'energy', good: 'up',
    pick: a => a.calories_kcal > 0, min: [2, 5],
    value: (xs, wk) => sum(xs, a => a.calories_kcal) / wk },
];

/**
 * Recent (last 90 days) vs baseline (last 365 days, which includes the recent
 * window — same as Apple). Weekly metrics are per-week averages.
 *   -> [{key, label, unit_kind: 'distance'|'duration'|'count'|'pace'|'hr'|'energy',
 *        recent, baseline, delta, pct, direction: 'up'|'down'|'flat',
 *        good: 'up'|'down'|null, favorable: true|false|null}]
 * Units: meters, seconds, counts, s/m (pace), bpm, kcal. `favorable` is whether
 * the move went the good way (null when flat or no preferred direction).
 * Returns [] with < 120 days of history; trends lacking data are omitted.
 */
export function computeTrends(acts, now = new Date()) {
  const nowMs = now.getTime();
  const vis = (acts || []).filter(a => isVisible(a) && a.date.getTime() <= nowMs);
  if (!vis.length) return [];
  const earliest = vis.reduce((m, a) => Math.min(m, a.date.getTime()), Infinity);
  const historyDays = (nowMs - earliest) / DAY;
  if (historyDays < MIN_HISTORY_DAYS) return [];

  const baseDays = Math.min(365, historyDays);
  const base = vis.filter(a => a.date.getTime() > nowMs - 365 * DAY);
  const recent = vis.filter(a => a.date.getTime() > nowMs - 90 * DAY);
  const wkRecent = 90 / 7, wkBase = baseDays / 7;

  const out = [];
  for (const m of METRICS) {
    const r = m.pick ? recent.filter(m.pick) : recent;
    const b = m.pick ? base.filter(m.pick) : base;
    const [minR, minB] = m.min || [3, 8];
    if (r.length < minR || b.length < minB) continue;
    const rv = m.value(r, wkRecent), bv = m.value(b, wkBase);
    if (!Number.isFinite(rv) || !Number.isFinite(bv) || bv <= 0) continue;
    const delta = rv - bv, pct = delta / bv;
    const direction = Math.abs(pct) < FLAT ? 'flat' : delta > 0 ? 'up' : 'down';
    out.push({
      key: m.key, label: m.label, unit_kind: m.unit_kind,
      recent: rv, baseline: bv, delta, pct, direction, good: m.good,
      favorable: direction === 'flat' || !m.good ? null : direction === m.good,
    });
  }
  return out;
}
