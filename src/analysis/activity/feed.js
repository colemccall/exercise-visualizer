// Activity-feed shaping: filter/sort, month grouping, weekly sidebar summary. Pure.

import { dayKey, addDays, weekStartKey, MONTH_NAMES } from '../dates.js';
import { isVisible, movingTime } from './yearly.js';

const toKey = x => (typeof x === 'string' ? x : dayKey(new Date(x)));

/**
 * Newest-first list after filtering. All filters optional:
 *   types: string[] (empty = all); source: 'strava'|'apple'|'all' (matches a.source
 *   or a.sources[]); text: case-insensitive match on name/type/sub_type;
 *   from/to: inclusive local days (Date, ms, or 'YYYY-MM-DD'); year: local year.
 */
export function feedItems(acts, { types, source, text, from, to, year } = {}) {
  const typeSet = types?.length ? new Set(types) : null;
  const q = text ? text.trim().toLowerCase() : '';
  const f = from != null ? toKey(from) : null, t = to != null ? toKey(to) : null;
  return (acts || []).filter(a => {
    if (!isVisible(a)) return false;
    if (typeSet && !typeSet.has(a.type)) return false;
    if (source && source !== 'all' && a.source !== source && !(a.sources || []).includes(source)) return false;
    if (year != null && a.date.getFullYear() !== year) return false;
    if (f || t) { const k = dayKey(a.date); if ((f && k < f) || (t && k > t)) return false; }
    if (q && !`${a.name || ''} ${a.type || ''} ${a.sub_type || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b.date - a.date || (a.id < b.id ? -1 : 1));
}

/**
 * Group (newest-first) items by local month, preserving order.
 *   -> [{key:'2025-04', label:'April 2025', items, totals:{count,distance_m,moving_s}}]
 */
export function groupByMonth(items) {
  const groups = [];
  let cur = null;
  for (const a of items || []) {
    const key = dayKey(a.date).slice(0, 7);
    if (!cur || cur.key !== key) {
      cur = { key, label: `${MONTH_NAMES[a.date.getMonth()]} ${a.date.getFullYear()}`, items: [],
        totals: { count: 0, distance_m: 0, moving_s: 0 } };
      groups.push(cur);
    }
    cur.items.push(a);
    cur.totals.count++; cur.totals.distance_m += a.distance_m || 0; cur.totals.moving_s += movingTime(a);
  }
  return groups;
}

const week = start => ({ start, count: 0, distance_m: 0, moving_s: 0, elevation_m: 0 });

/**
 * This week vs last week (Monday-start, local) for the sidebar.
 *   -> {this_week, last_week: {start, count, distance_m, moving_s, elevation_m},
 *       days: 7 x {key, dow (0 = Mon), count, distance_m, moving_s}  (this week),
 *       last_days: same for last week}
 */
export function weeklySummary(acts, now = new Date()) {
  const ws = weekStartKey(now), lws = addDays(ws, -7);
  const mkDays = start => Array.from({ length: 7 }, (_, i) =>
    ({ key: addDays(start, i), dow: i, count: 0, distance_m: 0, moving_s: 0 }));
  const out = { this_week: week(ws), last_week: week(lws), days: mkDays(ws), last_days: mkDays(lws) };
  for (const a of acts || []) {
    if (!isVisible(a) || a.date.getTime() > now.getTime() + 864e5) continue;
    const k = dayKey(a.date), wk = weekStartKey(k);
    const target = wk === ws ? [out.this_week, out.days] : wk === lws ? [out.last_week, out.last_days] : null;
    if (!target) continue;
    const [tot, days] = target;
    const day = days.find(d => d.key === k);
    for (const o of [tot, day]) { o.count++; o.distance_m += a.distance_m || 0; o.moving_s += movingTime(a); }
    tot.elevation_m += a.elevation_gain_m || 0;
  }
  return out;
}

/**
 * Activity-type mix over the trailing `days` (default 90), most-used first.
 *   -> [{type, count, distance_m, moving_s, share (of total moving time, 0-1)}]
 */
export function recentTypeMix(acts, now = new Date(), days = 90) {
  const since = now.getTime() - days * 864e5;
  const by = new Map();
  let total = 0;
  for (const a of acts || []) {
    if (!isVisible(a) || a.date.getTime() <= since || a.date.getTime() > now.getTime()) continue;
    const e = by.get(a.type) ?? { type: a.type, count: 0, distance_m: 0, moving_s: 0 };
    e.count++; e.distance_m += a.distance_m || 0; e.moving_s += movingTime(a);
    total += movingTime(a);
    by.set(a.type, e);
  }
  return [...by.values()].map(e => ({ ...e, share: total > 0 ? e.moving_s / total : 0 }))
    .sort((a, b) => b.count - a.count || b.moving_s - a.moving_s);
}
