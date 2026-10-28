import test from 'node:test';
import assert from 'node:assert/strict';
import { ringsForDay, ringsRange, ringStreaks, monthRings, weeklyRingTotals } from '../../../src/analysis/health/rings.js';
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
  assert.ok(m[2].all_closed && m[2].move === 1.2);
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
