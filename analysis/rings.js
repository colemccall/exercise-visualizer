// Activity-ring math over Apple ActivitySummary records. Pure.
// Summary: {date:'YYYY-MM-DD', move_kcal, move_goal, exercise_min, exercise_goal,
//           stand_hours, stand_goal}. A day with no summary counts as not closed.

import { addDays, daysInMonth, consecutiveRuns, longestRun, dayKey } from './dates.js';

const ring = (value, goal) => {
  const v = Number.isFinite(value) ? value : 0;
  const g = Number.isFinite(goal) ? goal : 0;
  return { value: v, goal: g, pct: g > 0 ? v / g : 0, closed: g > 0 && v >= g };
};

/** Map of date key -> summary. */
export function indexSummaries(summaries) {
  return new Map((summaries || []).map(s => [s.date, s]));
}

function dayRings(s) {
  const move = ring(s.move_kcal, s.move_goal);
  const exercise = ring(s.exercise_min, s.exercise_goal);
  const stand = ring(s.stand_hours, s.stand_goal);
  return { date: s.date, move, exercise, stand, all_closed: move.closed && exercise.closed && stand.closed };
}

/**
 * One day's rings, or null with no summary.
 *   -> {date, move, exercise, stand: {value, goal, pct (1 = closed, may exceed), closed},
 *       all_closed}
 */
export function ringsForDay(summaries, key) {
  const s = indexSummaries(summaries).get(key);
  return s ? dayRings(s) : null;
}

/** Day objects (as ringsForDay) for every day with a summary in [fromKey, toKey], chronological. */
export function ringsRange(summaries, fromKey, toKey) {
  return (summaries || [])
    .filter(s => s.date >= fromKey && s.date <= toKey)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(dayRings);
}

/**
 * Streak lengths in consecutive days. "Current" counts through `today` if that day is
 * closed, otherwise through yesterday (Apple-style); today defaults to the latest
 * summary date.
 *   -> {closeAllCurrent, closeAllLongest, moveCurrent, moveLongest,
 *       exerciseCurrent, exerciseLongest, standCurrent, standLongest}
 */
export function ringStreaks(summaries, { today } = {}) {
  const days = [...(summaries || [])].sort((a, b) => (a.date < b.date ? -1 : 1)).map(dayRings);
  const last = days.length ? days[days.length - 1].date : null;
  const t = today ?? last;
  const out = {};
  const preds = {
    closeAll: d => d.all_closed, move: d => d.move.closed,
    exercise: d => d.exercise.closed, stand: d => d.stand.closed,
  };
  for (const [name, pred] of Object.entries(preds)) {
    const runs = consecutiveRuns(days.filter(pred).map(d => d.date));
    out[`${name}Longest`] = longestRun(runs);
    let cur = 0;
    if (t) {
      const closedToday = runs.some(r => r.end === t);
      const anchor = closedToday ? t : addDays(t, -1);
      cur = runs.find(r => r.end === anchor)?.length ?? 0;
    }
    out[`${name}Current`] = cur;
  }
  return out;
}

/**
 * Calendar data for one month (month is 1-12): one entry per day,
 *   {day, date, move, exercise, stand (pct, 1 = closed; null with no summary), all_closed}
 */
export function monthRings(summaries, year, month) {
  const idx = indexSummaries(summaries);
  const n = daysInMonth(year, month);
  const out = [];
  for (let day = 1; day <= n; day++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const s = idx.get(date);
    const r = s ? dayRings(s) : null;
    out.push({
      day, date,
      move: r ? r.move.pct : null, exercise: r ? r.exercise.pct : null,
      stand: r ? r.stand.pct : null, all_closed: r ? r.all_closed : false,
    });
  }
  return out;
}

/**
 * Totals for the 7 days from a week's start key (Mon by convention).
 *   -> {start, days: 7 x (dayRings|null), move_kcal, exercise_min, stand_hours,
 *       closed: {move, exercise, stand, all}  (counts of days)}
 */
export function weeklyRingTotals(summaries, weekStart) {
  const idx = indexSummaries(summaries);
  const out = { start: weekStart, days: [], move_kcal: 0, exercise_min: 0, stand_hours: 0,
    closed: { move: 0, exercise: 0, stand: 0, all: 0 } };
  for (let i = 0; i < 7; i++) {
    const s = idx.get(addDays(weekStart, i));
    const r = s ? dayRings(s) : null;
    out.days.push(r);
    if (!r) continue;
    out.move_kcal += r.move.value; out.exercise_min += r.exercise.value; out.stand_hours += r.stand.value;
    if (r.move.closed) out.closed.move++;
    if (r.exercise.closed) out.closed.exercise++;
    if (r.stand.closed) out.closed.stand++;
    if (r.all_closed) out.closed.all++;
  }
  return out;
}

export { dayKey };
