// Activity-ring math over Apple ActivitySummary records. Pure.
// Summary: {date:'YYYY-MM-DD', move_kcal, move_goal, exercise_min, exercise_goal,
//           stand_hours, stand_goal}. A day with no summary counts as not closed.

import { addDays, daysBetween, daysInMonth, consecutiveRuns, longestRun, dayKey, parseKey, weekStartKey } from '../dates.js';

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
 *   {day, date, has_data, move, exercise, stand, all_closed}
 * where move/exercise/stand are full ring objects {value, goal, pct, closed} (as
 * ringsForDay) or null when that day has no summary. A day that has a summary but
 * zero progress is an *open ring*, not missing data.
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
      day, date, has_data: !!r,
      move: r ? r.move : null, exercise: r ? r.exercise : null, stand: r ? r.stand : null,
      all_closed: r ? r.all_closed : false,
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

const RING_KEYS = ['move', 'exercise', 'stand'];
const FIELD = { move: 'move_kcal', exercise: 'exercise_min', stand: 'stand_hours' };

/**
 * Cumulative rings: add up every day in [fromKey, toKey] instead of looking at one day.
 *
 *   -> { from, to, days_in_period, days_with_data, all_closed_days,
 *        move|exercise|stand: { value,       Σ progress over every day with data
 *                               goal,        Σ of the *per-day* goals (goals change over time)
 *                               pct,         Σ progress ÷ Σ goal, on days that had a goal
 *                               closed,      pct >= 1
 *                               closed_days, days this ring closed
 *                               goal_days,   days that had a goal set
 *                               has_goal } }
 *
 * Rules (verified against a real export whose goals changed four times, and whose
 * Exercise/Stand goals were 0 until mid-2025):
 *  - goals are summed per day, never "today's goal x number of days";
 *  - days with no goal for a ring are left out of that ring's goal *and* of the
 *    progress used for pct (otherwise a no-goal stretch would read as >100%), but
 *    still count toward `value`;
 *  - a day with a summary and zero progress counts (an open ring); a day with no
 *    summary adds nothing and shows up in days_with_data / days_in_period;
 *  - callers cap `toKey` at the last data day for a period still in progress.
 */
export function periodRingTotals(summaries, fromKey, toKey) {
  const out = {
    from: fromKey, to: toKey,
    days_in_period: toKey < fromKey ? 0 : daysBetween(fromKey, toKey) + 1,
    days_with_data: 0, all_closed_days: 0,
  };
  for (const k of RING_KEYS) out[k] = { value: 0, goal: 0, pct: 0, closed: false, closed_days: 0, goal_days: 0, has_goal: false, _goalValue: 0 };

  for (const s of summaries || []) {
    if (s.date < fromKey || s.date > toKey) continue;
    out.days_with_data++;
    const d = dayRings(s);
    for (const k of RING_KEYS) {
      const t = out[k], r = d[k];
      t.value += r.value;
      if (r.goal > 0) { t.goal += r.goal; t._goalValue += r.value; t.goal_days++; }
      if (r.closed) t.closed_days++;
    }
    if (d.all_closed) out.all_closed_days++;
  }
  for (const k of RING_KEYS) {
    const t = out[k];
    t.has_goal = t.goal > 0;
    t.pct = t.goal > 0 ? t._goalValue / t.goal : 0;
    t.closed = t.goal > 0 && t.pct >= 1;
    delete t._goalValue;
  }
  return out;
}

/**
 * Bounds of the week / month / year containing `key`, with the end capped at `lastKey`
 * (the newest day we have data for) so a period still in progress is measured only
 * over days that have happened.
 *   -> {from, to, full_to, label_kind, capped}
 */
export function periodBounds(kind, key, lastKey) {
  const { y, m } = parseKey(key);
  let from, fullTo;
  if (kind === 'week') { from = weekStartKey(key); fullTo = addDays(from, 6); }
  else if (kind === 'month') { from = `${y}-${String(m).padStart(2, '0')}-01`; fullTo = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth(y, m)).padStart(2, '0')}`; }
  else { from = `${y}-01-01`; fullTo = `${y}-12-31`; }
  const to = lastKey && lastKey < fullTo ? lastKey : fullTo;
  return { from, to, full_to: fullTo, capped: to < fullTo };
}

/** Per-month cumulative totals for a year: 12 entries (month 1-12). */
export function yearMonthTotals(summaries, year) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const from = `${year}-${String(m).padStart(2, '0')}-01`;
    const to = `${year}-${String(m).padStart(2, '0')}-${String(daysInMonth(year, m)).padStart(2, '0')}`;
    return { month: m, ...periodRingTotals(summaries, from, to) };
  });
}

export { dayKey };
