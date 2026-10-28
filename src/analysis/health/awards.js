// Award rule engine (Apple-Awards style, original rules). Pure and deterministic.
// Every award: {id, title, desc, category, tier (1-4|null), earned (Date|null),
//   progress (0-1|null), target_label, shape, hue, kind, target, value, ...}
// `kind`/`target`/`value` expose the raw numbers (meters for 'distance_m', counts for
// 'count', days/weeks for 'days'/'weeks', seconds for 'time_s') so the UI can format
// in the user's units; title/desc/target_label are default English in miles.
// Awards that can't be evaluated with the data given are omitted; unearned but
// measurable ones carry earned:null plus progress.

import { dayKey, keyToDate, weekStartKey, addDays, daysInMonth, MONTH_NAMES,
  consecutiveRuns, streakReachedKey, longestRun } from '../dates.js';
import { isVisible } from '../activity/yearly.js';
import { indexSummaries } from './rings.js';

const MI = 1609.344;
export const CATEGORY_ORDER = ['distance', 'streak', 'consistency', 'pr', 'challenge', 'variety', 'rings'];
const SHAPE = { distance: 'circle', streak: 'hexagon', consistency: 'shield', pr: 'star',
  challenge: 'shield', variety: 'circle', rings: 'circle' };
const typeHue = t => ({ Run: 'run', Ride: 'ride', Hike: 'hike', Swim: 'swim', Walk: 'hike' }[t] ?? 'exercise');

function make(o) {
  const a = { tier: null, earned: null, progress: null, target: null, value: null, kind: null,
    shape: SHAPE[o.category], hue: 'move', ...o };
  if (a.earned) a.progress = 1;
  return a;
}

// Award with a numeric threshold: earned date (or null) + progress from value/target.
const threshold = (o, value, earned) =>
  make({ ...o, value, earned: earned ?? null, progress: Math.min(1, value / o.target) });

/**
 * Compute every evaluable award.
 * opts: {now: Date (default new Date()), efforts: bestEffortsAcross() result — enables
 *        Fastest 1 mile / 5K / 10K awards}
 * summaries: Apple ActivitySummary records ([] when none — ring awards are omitted).
 */
export function computeAwards(acts, summaries = [], opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sorted = (acts || []).filter(a => isVisible(a) && a.date.getTime() <= now.getTime())
    .sort((a, b) => a.date - b.date || (a.id < b.id ? -1 : 1));
  const out = [];

  if (sorted.length) {
    awardsDistance(sorted, out);
    awardsStreaks(sorted, out);
    awardsCounts(sorted, out);
    awardsWeeks(sorted, out);
    awardsFirstsAndPRs(sorted, out);
    awardsEfforts(opts.efforts, out);
    awardsChallenge(sorted, now, 0, out);
    awardsChallenge(sorted, now, -1, out);
  }
  if (summaries?.length) awardsRings(summaries, now, out);
  return out;
}

/** Group a computeAwards list: [{category, awards}] in a fixed category order, empties dropped. */
export function awardsByCategory(list) {
  return CATEGORY_ORDER.map(category => ({ category, awards: list.filter(a => a.category === category) }))
    .filter(g => g.awards.length);
}

function awardsDistance(sorted, out) {
  const miles = [100, 250, 500, 1000, 2500, 5000];
  const tiers = [1, 1, 2, 2, 3, 4];
  const total = sorted.reduce((s, a) => s + (a.distance_m || 0), 0);
  if (!(total > 0)) return;
  miles.forEach((mi, i) => {
    const target = mi * MI;
    let cum = 0, earned = null;
    for (const a of sorted) { cum += a.distance_m || 0; if (cum >= target) { earned = a.date; break; } }
    out.push(threshold({ id: `distance-${mi}mi`, title: `${mi} Miles`, desc: `Cover ${mi} miles in total`,
      category: 'distance', tier: tiers[i], kind: 'distance_m', target, target_label: `${mi} mi`, hue: 210 },
    total, earned));
  });
}

function awardsStreaks(sorted, out) {
  const firstOnDay = new Map();
  for (const a of sorted) { const k = dayKey(a.date); if (!firstOnDay.has(k)) firstOnDay.set(k, a.date); }
  const runs = consecutiveRuns([...firstOnDay.keys()].sort());
  const best = longestRun(runs);
  [[7, 1], [14, 2], [30, 3], [100, 4]].forEach(([n, tier]) => {
    const k = streakReachedKey(runs, n);
    out.push(threshold({ id: `streak-${n}`, title: `${n}-Day Streak`, desc: `Be active ${n} days in a row`,
      category: 'streak', tier, kind: 'days', target: n, target_label: `${n} days`, hue: 'move' },
    best, k ? firstOnDay.get(k) : null));
  });
}

function awardsCounts(sorted, out) {
  [[10, 1], [50, 1], [100, 2], [250, 3], [500, 4]].forEach(([n, tier]) => {
    out.push(threshold({ id: `workouts-${n}`, title: `${n} Workouts`, desc: `Log ${n} workouts`,
      category: 'consistency', tier, kind: 'count', target: n, target_label: `${n} workouts`, hue: 'stand' },
    sorted.length, sorted.length >= n ? sorted[n - 1].date : null));
  });
}

function awardsWeeks(sorted, out) {
  const weeks = new Map();
  for (const a of sorted) {
    const w = weekStartKey(a.date);
    (weeks.get(w) ?? weeks.set(w, []).get(w)).push(a.date);
  }
  const qualifying = [...weeks.keys()].filter(w => weeks.get(w).length >= 3).sort();
  const runs = consecutiveRuns(qualifying, 7);
  const best = longestRun(runs);
  [[4, 2], [12, 4]].forEach(([n, tier]) => {
    const wk = streakReachedKey(runs, n);
    out.push(threshold({ id: `weeks-3x-${n}`, title: `${n} Strong Weeks`,
      desc: `Work out 3+ times a week for ${n} weeks in a row`,
      category: 'consistency', tier, kind: 'weeks', target: n, target_label: `${n} weeks`, hue: 'stand' },
    best, wk ? weeks.get(wk)[2] : null)); // satisfied on the week's 3rd workout
  });
}

function awardsFirstsAndPRs(sorted, out) {
  for (const type of ['Run', 'Ride', 'Hike', 'Swim']) {
    const first = sorted.find(a => a.type === type);
    if (first) out.push(make({ id: `first-${type.toLowerCase()}`, title: `First ${type}`,
      desc: `Your first ${type.toLowerCase()} on record`, category: 'variety', earned: first.date,
      activity_id: first.id, hue: typeHue(type) }));
  }
  for (const type of ['Run', 'Ride', 'Hike']) {
    let best = null;
    for (const a of sorted) if (a.type === type && (a.distance_m || 0) > (best?.distance_m ?? 0)) best = a;
    if (best) out.push(make({ id: `pr-longest-${type.toLowerCase()}`, title: `Longest ${type}`,
      desc: `Your longest ${type.toLowerCase()}: ${(best.distance_m / 1000).toFixed(1)} km`,
      category: 'pr', kind: 'distance_m', value: best.distance_m, earned: best.date,
      activity_id: best.id, hue: typeHue(type) }));
  }
}

function awardsEfforts(efforts, out) {
  for (const [key, label] of [['1mi', '1 Mile'], ['5k', '5K'], ['10k', '10K']]) {
    const e = (efforts || []).find(x => x.key === key);
    if (e) out.push(make({ id: `pr-fastest-${key}`, title: `Fastest ${label}`,
      desc: `Your fastest ${label.toLowerCase()} run`, category: 'pr', kind: 'time_s', value: e.time_s,
      earned: e.date ?? null, activity_id: e.activity_id, hue: 'run' }));
  }
}

// Monthly challenge: beat 110% of your typical month of your main activity.
// offset 0 = the current month, -1 = the last complete one.
function awardsChallenge(sorted, now, offset, out) {
  const y = new Date(now.getFullYear(), now.getMonth() + offset, 1).getFullYear();
  const m = new Date(now.getFullYear(), now.getMonth() + offset, 1).getMonth();
  const start = new Date(y, m, 1), end = new Date(y, m + 1, 1);
  const histStart = new Date(y, m - 6, 1);

  const byType = {};
  for (const a of sorted) {
    if (a.type === 'Other' || !(a.distance_m > 0)) continue;
    if (a.date >= histStart && a.date < start) byType[a.type] = (byType[a.type] || 0) + a.distance_m;
  }
  const dominant = Object.keys(byType).sort((a, b) => byType[b] - byType[a] || (a < b ? -1 : 1))[0];
  if (!dominant) return;
  const target = Math.max(10000, Math.round((1.1 * byType[dominant]) / 6 / 1000) * 1000);

  let cum = 0, earned = null;
  for (const a of sorted) {
    if (a.type !== dominant || a.date < start || a.date >= end) continue;
    cum += a.distance_m || 0;
    if (earned == null && cum >= target) earned = a.date;
  }
  const name = MONTH_NAMES[m];
  out.push(threshold({ id: `challenge-${y}-${String(m + 1).padStart(2, '0')}`,
    title: `${name} Challenge`, desc: `${dominant}: ${Math.round(target / 1000)} km in ${name} ${y}`,
    category: 'challenge', tier: null, kind: 'distance_m', target, target_label: `${Math.round(target / 1000)} km`,
    hue: typeHue(dominant), activity_type: dominant, month: `${y}-${String(m + 1).padStart(2, '0')}`,
    complete_month: offset < 0 }, cum, earned));
}

function awardsRings(summaries, now, out) {
  const idx = indexSummaries(summaries);
  const keys = [...idx.keys()].sort();
  const closed = (s, ring) => {
    const [v, g] = { move: [s.move_kcal, s.move_goal], exercise: [s.exercise_min, s.exercise_goal],
      stand: [s.stand_hours, s.stand_goal] }[ring];
    return g > 0 && v >= g;
  };
  const allClosed = s => closed(s, 'move') && closed(s, 'exercise') && closed(s, 'stand');
  const dayAward = k => keyToDate(k);

  const streak = (id, title, desc, pred, hue) => {
    const runs = consecutiveRuns(keys.filter(k => pred(idx.get(k))));
    const best = longestRun(runs);
    [[7, 1], [30, 2], [100, 3]].forEach(([n, tier]) => {
      const k = streakReachedKey(runs, n);
      out.push(threshold({ id: `${id}-${n}`, title: title(n), desc: desc(n), category: 'rings', tier,
        kind: 'days', target: n, target_label: `${n} days`, hue }, best, k ? dayAward(k) : null));
    });
  };
  streak('rings-close-all', n => `${n}-Day Ring Streak`, n => `Close all three rings ${n} days in a row`, allClosed, 'move');
  streak('rings-move', n => `${n}-Day Move Streak`, n => `Hit your Move goal ${n} days in a row`, s => closed(s, 'move'), 'move');

  // perfect week: a Monday-Sunday week with all 7 days present and fully closed
  const weekDays = new Map();
  for (const k of keys) {
    const w = weekStartKey(k);
    (weekDays.get(w) ?? weekDays.set(w, []).get(w)).push(k);
  }
  let bestWeek = 0, perfectWeek = null;
  for (const w of [...weekDays.keys()].sort()) {
    const n = weekDays.get(w).filter(k => allClosed(idx.get(k))).length;
    bestWeek = Math.max(bestWeek, n);
    if (n === 7 && !perfectWeek) perfectWeek = addDays(w, 6);
  }
  out.push(threshold({ id: 'rings-perfect-week', title: 'Perfect Week', desc: 'Close all three rings every day of a week',
    category: 'rings', tier: 2, kind: 'days', target: 7, target_label: '7 of 7 days', hue: 'move' },
  bestWeek, perfectWeek ? dayAward(perfectWeek) : null));

  // perfect month: a past calendar month with every day present and fully closed
  const today = dayKey(now);
  const monthDays = new Map();
  for (const k of keys) {
    const mk = k.slice(0, 7);
    (monthDays.get(mk) ?? monthDays.set(mk, []).get(mk)).push(k);
  }
  let bestFrac = 0, perfectMonth = null;
  for (const mk of [...monthDays.keys()].sort()) {
    const [y, m] = mk.split('-').map(Number);
    const total = daysInMonth(y, m);
    const lastKey = `${mk}-${String(total).padStart(2, '0')}`;
    if (lastKey >= today) continue; // month not over yet
    const n = monthDays.get(mk).filter(k => allClosed(idx.get(k))).length;
    bestFrac = Math.max(bestFrac, n / total);
    if (n === total && !perfectMonth) perfectMonth = lastKey;
  }
  if (bestFrac > 0 || perfectMonth) {
    out.push(make({ id: 'rings-perfect-month', title: 'Perfect Month',
      desc: 'Close all three rings every day of a calendar month', category: 'rings', tier: 4,
      kind: 'days', target_label: 'every day', hue: 'move',
      earned: perfectMonth ? dayAward(perfectMonth) : null, progress: perfectMonth ? 1 : bestFrac }));
  }
}
