import test from 'node:test';
import assert from 'node:assert/strict';
import { ringsForDay, ringsRange, ringStreaks, monthRings, weeklyRingTotals, periodRingTotals, periodBounds, yearMonthTotals } from '../../../src/analysis/health/rings.js';
import { ringsSvg, ringsLabel } from '../../../src/components/ring.js';
import { computeAwards, awardsByCategory } from '../../../src/analysis/health/awards.js';
import { addDays } from '../../../src/analysis/dates.js';
import { act } from '../_helpers.js';

const summary = (date, closed = true, over = {}) => ({
  date, move_kcal: closed ? 600 : 200, move_goal: 500,
  exercise_min: closed ? 35 : 10, exercise_goal: 30,
  stand_hours: closed ? 12 : 4, stand_goal: 12, ...over,
});
const days = (start, n, closed = true) =>
  Array.from({ length: n }, (_, i) => summary(addDays(start, i), closed));

test('ringsForDay: values, pct, closed; null when no summary', () => {
  const s = [summary('2025-03-03', true), summary('2025-03-04', false)];
  const r = ringsForDay(s, '2025-03-03');
  assert.equal(r.move.pct, 1.2);
  assert.ok(r.move.closed && r.all_closed);
  const half = ringsForDay(s, '2025-03-04');
  assert.equal(half.exercise.pct, 10 / 30);
  assert.equal(half.all_closed, false);
  assert.equal(ringsForDay(s, '2025-03-05'), null);
  assert.equal(ringsRange(s, '2025-03-04', '2025-03-10').length, 1);
});

test('ringStreaks: boundaries, current-through-yesterday, gaps', () => {
  const s = [...days('2025-03-01', 5), summary('2025-03-06', false), ...days('2025-03-07', 3)];
  const a = ringStreaks(s, { today: '2025-03-09' });
  assert.equal(a.closeAllLongest, 5);
  assert.equal(a.closeAllCurrent, 3);
  // today (the 10th) has no summary yet: streak still counts through yesterday
  assert.equal(ringStreaks(s, { today: '2025-03-10' }).closeAllCurrent, 3);
  // a missing day breaks the streak
  assert.equal(ringStreaks(s, { today: '2025-03-12' }).closeAllCurrent, 0);
  assert.equal(a.moveLongest, 5);
});

test('monthRings and weeklyRingTotals', () => {
  const s = days('2025-03-03', 7);
  const m = monthRings(s, 2025, 3);
  assert.equal(m.length, 31);
  assert.equal(m[0].move, null);
  assert.equal(m[2].date, '2025-03-03');
  assert.ok(m[2].all_closed && m[2].move.pct === 1.2 && m[2].move.value === 600 && m[2].move.goal === 500);
  const w = weeklyRingTotals(s, '2025-03-03');
  assert.equal(w.closed.all, 7);
  assert.equal(w.move_kcal, 4200);
});

test('awards: streak boundary — 7 days earns on day 7, 6 days is progress only', () => {
  const week = n => Array.from({ length: n }, (_, i) => act(new Date(2025, 2, 1 + i, 8)));
  const now = new Date(2025, 2, 20);
  const got = computeAwards(week(7), [], { now }).find(a => a.id === 'streak-7');
  assert.equal(got.earned.getTime(), new Date(2025, 2, 7, 8).getTime());
  assert.equal(got.progress, 1);
  const miss = computeAwards(week(6), [], { now }).find(a => a.id === 'streak-7');
  assert.equal(miss.earned, null);
  assert.ok(Math.abs(miss.progress - 6 / 7) < 1e-9);
  assert.equal(computeAwards(week(7), [], { now }).find(a => a.id === 'streak-14').earned, null);
});

test('awards: distance milestones, workout counts, firsts, PRs, merged excluded', () => {
  const acts = [
    act(new Date(2025, 0, 1, 8), 'Run', 60 * 1609.344),
    act(new Date(2025, 0, 10, 8), 'Ride', 60 * 1609.344),
    act(new Date(2025, 0, 20, 8), 'Hike', 60 * 1609.344),
    act(new Date(2025, 0, 21, 8), 'Run', 999999, 100, { merged_into: 'dup' }),
  ];
  const list = computeAwards(acts, [], { now: new Date(2025, 1, 1) });
  const by = Object.fromEntries(list.map(a => [a.id, a]));
  assert.equal(by['distance-100mi'].earned.getTime(), acts[1].date.getTime());
  assert.equal(by['distance-250mi'].earned, null);
  assert.ok(Math.abs(by['distance-250mi'].progress - 180 / 250) < 1e-9);
  assert.equal(by['workouts-10'].earned, null);
  assert.equal(by['workouts-10'].progress, 0.3);
  assert.equal(by['first-ride'].earned.getTime(), acts[1].date.getTime());
  assert.equal(by['first-swim'], undefined);
  assert.equal(by['pr-longest-run'].activity_id, acts[0].id);
  assert.equal(by['rings-close-all-7'], undefined); // no summaries -> omitted
  assert.equal(computeAwards([], []).length, 0);

  const ids = list.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(awardsByCategory(list).every(g => g.awards.length > 0));
});

test('awards: efforts input unlocks fastest-time awards', () => {
  const acts = [act(new Date(2025, 0, 1, 8))];
  const efforts = [{ key: '5k', time_s: 1250, date: acts[0].date, activity_id: acts[0].id }];
  const by = Object.fromEntries(computeAwards(acts, [], { now: new Date(2025, 1, 1), efforts }).map(a => [a.id, a]));
  assert.equal(by['pr-fastest-5k'].earned.getTime(), acts[0].date.getTime());
  assert.equal(by['pr-fastest-10k'], undefined);
});

test('awards: 4 strong weeks (3+ workouts, consecutive Mon-start weeks)', () => {
  const acts = [];
  for (let w = 0; w < 4; w++) for (let k = 0; k < 3; k++) acts.push(act(new Date(2025, 2, 3 + w * 7 + k * 2, 8)));
  const a = computeAwards(acts, [], { now: new Date(2025, 4, 1) }).find(x => x.id === 'weeks-3x-4');
  assert.equal(a.earned.getTime(), new Date(2025, 2, 3 + 21 + 4, 8).getTime()); // 3rd workout of week 4
});

test('awards: monthly challenge — 110% of the prior six-month average', () => {
  const acts = [];
  for (const [y, m] of [[2024, 10], [2024, 11], [2025, 0], [2025, 1], [2025, 2], [2025, 3], [2025, 4]]) {
    for (let k = 0; k < 4; k++) acts.push(act(new Date(y, m, 5 + k, 8), 'Run', 10000));
  }
  acts.push(act(new Date(2025, 5, 3, 8), 'Run', 25000), act(new Date(2025, 5, 9, 8), 'Run', 25000));
  const now = new Date(2025, 5, 15);
  const by = Object.fromEntries(computeAwards(acts, [], { now }).filter(a => a.category === 'challenge').map(a => [a.id, a]));
  const june = by['challenge-2025-06'], may = by['challenge-2025-05'];
  assert.equal(june.target, 44000);
  assert.equal(june.earned.getTime(), new Date(2025, 5, 9, 8).getTime());
  assert.equal(may.target, 44000);
  assert.equal(may.earned, null);
  assert.ok(Math.abs(may.progress - 40000 / 44000) < 1e-9);
  assert.equal(may.complete_month, true);
});

test('awards: ring awards from summaries', () => {
  const s = days('2025-03-03', 7); // Mon-Sun, all closed
  const by = Object.fromEntries(computeAwards([], s, { now: new Date(2025, 3, 1) }).map(a => [a.id, a]));
  assert.equal(by['rings-close-all-7'].earned.getDate(), 9);
  assert.equal(by['rings-close-all-30'].earned, null);
  assert.ok(Math.abs(by['rings-close-all-30'].progress - 7 / 30) < 1e-9);
  assert.equal(by['rings-perfect-week'].earned.getDate(), 9);
  assert.equal(by['rings-move-7'].earned.getDate(), 9);
  assert.equal(by['rings-perfect-month'].earned, null);
  assert.ok(Math.abs(by['rings-perfect-month'].progress - 7 / 31) < 1e-9);
});

test('monthRings output can actually be drawn (regression: it used to return bare numbers and every day rendered empty)', () => {
  const s = [summary('2025-03-03', true)];
  const day = monthRings(s, 2025, 3)[2];
  const svg = ringsSvg(day, { size: 40 });
  assert.equal((svg.match(/class="ring-arc/g) || []).length, 5, 'three first laps + second laps on Move (120%) and Exercise (117%)');
  assert.match(ringsLabel(day), /Move 600 of 500/);
});

test('monthRings: a day with a summary but zero progress is an open ring, not missing data', () => {
  const s = [summary('2025-03-05', false, { move_kcal: 0, exercise_min: 0, stand_hours: 0 })];
  const day = monthRings(s, 2025, 3)[4];
  assert.equal(day.has_data, true);
  assert.equal(day.move.pct, 0);
  assert.equal(day.move.goal, 500);
  assert.equal(monthRings(s, 2025, 3)[5].has_data, false);
});

test('periodRingTotals sums every day, with per-day goals', () => {
  // goals change mid-period: Move goal 400 for 3 days, then 1000 for 2 days
  const s = [
    ...days('2025-06-01', 3).map(d => ({ ...d, move_kcal: 500, move_goal: 400 })),
    ...days('2025-06-04', 2).map(d => ({ ...d, move_kcal: 800, move_goal: 1000 })),
  ];
  const p = periodRingTotals(s, '2025-06-01', '2025-06-07');
  assert.equal(p.days_in_period, 7);
  assert.equal(p.days_with_data, 5);
  assert.equal(p.move.value, 3100);                       // 3x500 + 2x800
  assert.equal(p.move.goal, 3200);                        // 3x400 + 2x1000, NOT 1000 x 5 or 400 x 5
  assert.ok(Math.abs(p.move.pct - 3100 / 3200) < 1e-9);
  assert.equal(p.move.closed_days, 3);                    // the first three beat 400; 800 < 1000
  assert.equal(p.all_closed_days, 3);
});

test('periodRingTotals: days with no goal do not inflate the percentage', () => {
  // Exercise/Stand goals were 0 until mid-2025 in the real export
  const noGoal = days('2025-05-01', 4).map(d => ({ ...d, exercise_min: 40, exercise_goal: 0, stand_hours: 10, stand_goal: 0 }));
  const withGoal = days('2025-05-05', 2).map(d => ({ ...d, exercise_min: 15, exercise_goal: 30 }));
  const p = periodRingTotals([...noGoal, ...withGoal], '2025-05-01', '2025-05-06');
  assert.equal(p.exercise.value, 4 * 40 + 2 * 15);        // all progress still totalled
  assert.equal(p.exercise.goal, 60);                      // only goal days
  assert.equal(p.exercise.goal_days, 2);
  assert.equal(p.exercise.pct, 0.5);                      // 30 / 60, not 190 / 60
  const none = periodRingTotals(noGoal, '2025-05-01', '2025-05-04');
  assert.equal(none.exercise.has_goal, false);
  assert.equal(none.exercise.pct, 0);
  assert.equal(none.exercise.closed, false);
});

test('periodRingTotals: missing days add nothing but are reported', () => {
  const s = [summary('2025-03-03'), summary('2025-03-05')];
  const p = periodRingTotals(s, '2025-03-03', '2025-03-09');
  assert.equal(p.days_in_period, 7);
  assert.equal(p.days_with_data, 2);
  assert.equal(p.move.value, 1200);
});

test('periodBounds caps a period still in progress at the last data day', () => {
  assert.deepEqual(periodBounds('week', '2026-04-21', '2026-04-21'), { from: '2026-04-20', to: '2026-04-21', full_to: '2026-04-26', capped: true });
  const m = periodBounds('month', '2026-04-21', '2026-04-21');
  assert.equal(m.from, '2026-04-01'); assert.equal(m.to, '2026-04-21'); assert.equal(m.full_to, '2026-04-30');
  const y = periodBounds('year', '2025-06-10', '2026-04-21');
  assert.equal(y.from, '2025-01-01'); assert.equal(y.to, '2025-12-31'); assert.equal(y.capped, false);
  assert.equal(periodBounds('month', '2024-02-10', '2026-04-21').full_to, '2024-02-29');   // leap year
});

test('yearMonthTotals returns 12 months', () => {
  const t = yearMonthTotals(days('2025-03-01', 31), 2025);
  assert.equal(t.length, 12);
  assert.equal(t[2].days_with_data, 31);
  assert.equal(t[0].days_with_data, 0);
});
