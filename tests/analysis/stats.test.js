import test from 'node:test';
import assert from 'node:assert/strict';
import { availableYears, yearlyStats, compareYears, dayKey } from '../../analysis/yearly.js';
import { computeTrends } from '../../analysis/trends.js';
import { feedItems, groupByMonth, weeklySummary, recentTypeMix } from '../../analysis/feed.js';
import { weekStartKey, addDays } from '../../analysis/dates.js';
import { act } from './_helpers.js';

test('dayKey is the LOCAL day, and date helpers do calendar math', () => {
  assert.equal(dayKey(new Date(2025, 11, 31, 23, 30)), '2025-12-31');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(weekStartKey('2025-03-09'), '2025-03-03'); // Sunday -> Monday before
  assert.equal(weekStartKey(new Date(2025, 2, 3, 0, 5)), '2025-03-03');
});

test('yearlyStats: totals, buckets, filters, merged exclusion', () => {
  const acts = [
    act(new Date(2025, 0, 5, 8), 'Run', 5000, 1500, { elevation_gain_m: 40, calories_kcal: 300 }),
    act(new Date(2025, 0, 6, 8), 'Ride', 20000, 3600, { elevation_gain_m: 200, moving_s: 3000 }),
    act(new Date(2025, 5, 1, 8), 'Run', 10000, 3000),
    act(new Date(2024, 11, 31, 23, 50), 'Run', 8000, 2400),
    act(new Date(2025, 0, 5, 9), 'Run', 99999, 99999, { merged_into: 'x' }),
  ];
  assert.deepEqual(availableYears(acts), [2025, 2024]);
  const y = yearlyStats(acts, 2025);
  assert.equal(y.count, 3);
  assert.equal(y.distance_m, 35000);
  assert.equal(y.moving_s, 1500 + 3000 + 3000); // moving_s ?? duration_s
  assert.equal(y.elevation_m, 240);
  assert.equal(y.calories_kcal, 300);
  assert.equal(y.active_days, 3);
  assert.equal(y.by_type.Run.count, 2);
  assert.equal(y.by_month[0].count, 2);
  assert.equal(y.by_month[5].distance_m, 10000);
  assert.equal(y.by_week.length, 53);
  assert.equal(y.by_week[0].count, 2); // Jan 5-6 are day 5-6 of the year
  assert.equal(y.longest_activity.distance_m, 20000);
  assert.equal(y.biggest_climb.elevation_gain_m, 200);
  assert.equal(yearlyStats(acts, 2025, { types: ['Run'] }).count, 2);
  assert.equal(yearlyStats(acts, null).count, 4);
  assert.equal(yearlyStats(acts, 2024).calories_kcal, null);

  const cmp = compareYears(acts, 2024, 2025);
  assert.equal(cmp.delta.distance_m, 35000 - 8000);
  assert.ok(Math.abs(cmp.pct.distance_m - 27000 / 8000) < 1e-9);
  assert.equal(cmp.by_month[11].a, 8000);
});

const NOW = new Date(2025, 5, 30, 12);
const daysAgo = n => new Date(NOW.getTime() - n * 864e5);

test('trends: more recent volume and faster pace are detected with correct signs', () => {
  const acts = [];
  for (let w = 52; w >= 13; w--) acts.push(act(daysAgo(w * 7), 'Run', 5000, 1800, { avg_heart_rate: 150 }));
  for (let w = 12; w >= 1; w--) for (let k = 0; k < 3; k++) {
    acts.push(act(daysAgo(w * 7 + k), 'Run', 5000, 1500, { avg_heart_rate: 150 }));
  }
  const t = Object.fromEntries(computeTrends(acts, NOW).map(x => [x.key, x]));
  assert.equal(t.weekly_workouts.direction, 'up');
  assert.equal(t.weekly_workouts.favorable, true);
  assert.ok(t.weekly_workouts.recent > t.weekly_workouts.baseline);
  assert.equal(t.weekly_distance.direction, 'up');
  assert.equal(t.avg_pace.direction, 'down');
  assert.equal(t.avg_pace.good, 'down');
  assert.equal(t.avg_pace.favorable, true);
  assert.equal(t.avg_hr.direction, 'flat');
  assert.equal(t.avg_hr.favorable, null);
  assert.equal(t.weekly_calories, undefined); // no calorie data -> omitted
});

test('trends: omitted with too little history', () => {
  const acts = [];
  for (let w = 8; w >= 1; w--) acts.push(act(daysAgo(w * 7), 'Run'));
  assert.deepEqual(computeTrends(acts, NOW), []);
  assert.deepEqual(computeTrends([], NOW), []);
});

test('feedItems: filters and newest-first order', () => {
  const acts = [
    act(new Date(2025, 2, 1, 8), 'Run', 5000, 1500, { name: 'Morning Run', source: 'strava' }),
    act(new Date(2025, 3, 2, 8), 'Ride', 20000, 3600, { name: 'Hill Ride', source: 'apple' }),
    act(new Date(2025, 3, 20, 8), 'Run', 8000, 2400, { name: 'Park', source: 'strava', sources: ['strava', 'apple'] }),
    act(new Date(2024, 3, 20, 8), 'Run', 8000, 2400, { merged_into: 'x' }),
  ];
  const all = feedItems(acts);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(a => a.date.getMonth()), [3, 3, 2]);
  assert.equal(feedItems(acts, { types: ['Ride'] }).length, 1);
  assert.equal(feedItems(acts, { source: 'apple' }).length, 2); // a.source or a.sources
  assert.equal(feedItems(acts, { text: 'hill' }).length, 1);
  assert.equal(feedItems(acts, { from: '2025-04-01', to: new Date(2025, 3, 2, 23) }).length, 1);
  assert.equal(feedItems(acts, { year: 2024 }).length, 0);
});

test('groupByMonth and weeklySummary (Monday-start)', () => {
  const acts = [
    act(new Date(2025, 5, 30, 8), 'Run', 5000, 1500), // Mon (this week)
    act(new Date(2025, 5, 29, 8), 'Run', 6000, 1500), // Sun (last week)
    act(new Date(2025, 4, 31, 8), 'Run', 7000, 1500),
  ];
  const groups = groupByMonth(feedItems(acts));
  assert.deepEqual(groups.map(g => g.key), ['2025-06', '2025-05']);
  assert.equal(groups[0].label, 'June 2025');
  assert.equal(groups[0].totals.distance_m, 11000);

  const w = weeklySummary(acts, NOW);
  assert.equal(w.this_week.start, '2025-06-30');
  assert.equal(w.this_week.distance_m, 5000);
  assert.equal(w.last_week.distance_m, 6000);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[0].distance_m, 5000);
  assert.equal(w.last_days[6].distance_m, 6000);
});

test('recentTypeMix shares sum to 1', () => {
  const acts = [act(daysAgo(3), 'Run', 5000, 1000), act(daysAgo(4), 'Run', 5000, 1000), act(daysAgo(5), 'Ride', 20000, 2000),
    act(daysAgo(200), 'Swim', 1000, 1000)];
  const mix = recentTypeMix(acts, NOW, 90);
  assert.deepEqual(mix.map(m => m.type), ['Run', 'Ride']);
  assert.ok(Math.abs(mix.reduce((s, m) => s + m.share, 0) - 1) < 1e-9);
});
