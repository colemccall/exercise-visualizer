import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from '../../src/parsers/model.js';
import { mergeDuplicates, resetMerges, visibleActivities } from '../../src/core/data/dedup.js';

const T0 = Date.UTC(2026, 3, 22, 12, 0, 0);
const min = (n) => new Date(T0 + n * 60000);

const strava = (o = {}) => createActivity({
  id: 's1', source: 'strava', name: 'Lunch Run', type: 'Run', date: min(0),
  distance_m: 8000, duration_s: 2700, moving_s: 2600, elevation_gain_m: 60,
  gear: 'Pegasus', has_route: true, gpx_file: 'activities/1.gpx', _gpxLoader: async () => ['strava-route'],
  ...o,
});
const apple = (o = {}) => createActivity({
  id: 'a1', source: 'apple', name: 'Run — 4/22/2026', type: 'Run', date: min(2),
  distance_m: 7900, duration_s: 2690, moving_s: 2690, avg_heart_rate: 150, max_heart_rate: 178,
  calories_kcal: 640, indoor: false, device: 'Watch', ...o,
});

test('merges a Strava + Apple pair: Strava wins identity, Apple wins HR/energy', () => {
  const s = strava();
  const a = apple();
  const list = [a, s];
  assert.deepEqual(mergeDuplicates(list), { merged: 1 });

  assert.equal(s.name, 'Lunch Run');
  assert.equal(s.distance_m, 8000);
  assert.equal(s.elevation_gain_m, 60);
  assert.equal(s.gear, 'Pegasus');
  assert.equal(s.moving_s, 2600);
  assert.equal(s.avg_heart_rate, 150);
  assert.equal(s.max_heart_rate, 178);
  assert.equal(s.calories_kcal, 640);
  assert.equal(s.indoor, false);
  assert.deepEqual(s.sources, ['strava', 'apple']);
  assert.deepEqual(s.merged_ids, ['a1']);
  assert.equal(s.has_duplicate, true);

  assert.equal(a.merged_into, 's1');
  assert.equal(a.duplicate_of, 's1');
  assert.deepEqual(visibleActivities(list), [s]);
});

test('Apple HR beats a Strava HR when both exist', () => {
  const s = strava({ avg_heart_rate: 120, max_heart_rate: 150 });
  mergeDuplicates([s, apple()]);
  assert.equal(s.avg_heart_rate, 150);
});

test('Strava fields the Apple side lacks are kept; Apple fills Strava nulls', () => {
  const s = strava({ elevation_gain_m: null, calories_kcal: null });
  const a = apple({ elevation_gain_m: 44 });
  mergeDuplicates([s, a]);
  assert.equal(s.elevation_gain_m, 44);
  assert.equal(s.calories_kcal, 640);
});

test('merged record stays routable when only the secondary has a route', async () => {
  const s = strava({ has_route: false, gpx_file: null, _gpxLoader: undefined });
  const loader = async () => ['apple-route'];
  const a = apple({ has_route: true, gpx_file: 'workout-routes/r.gpx', _gpxLoader: loader });
  mergeDuplicates([s, a]);
  assert.equal(s.has_route, true);
  assert.equal(s.gpx_file, 'workout-routes/r.gpx');
  assert.deepEqual(await s._gpxLoader(), ['apple-route']);
});

test('does not merge: same source, different type, >10 min apart, distance >10% off', () => {
  const cases = [
    [strava(), strava({ id: 's2', date: min(1) })],
    [strava(), apple({ type: 'Ride' })],
    [strava(), apple({ date: min(11) })],
    [strava(), apple({ distance_m: 9500 })],
  ];
  for (const [x, y] of cases) {
    assert.deepEqual(mergeDuplicates([x, y]), { merged: 0 });
    assert.equal(y.merged_into, null);
  }
});

test('boundary: exactly 10 minutes still matches', () => {
  assert.equal(mergeDuplicates([strava(), apple({ date: min(10) })]).merged, 1);
});

test('no-distance workouts match on duration within 10% (>60 s)', () => {
  const s = strava({ type: 'Other', distance_m: 0, duration_s: 3000 });
  const a = apple({ type: 'Other', distance_m: 0, duration_s: 2900 });
  assert.equal(mergeDuplicates([s, a]).merged, 1);

  const short = strava({ type: 'Other', distance_m: 0, duration_s: 50 });
  const short2 = apple({ type: 'Other', distance_m: 0, duration_s: 50 });
  assert.equal(mergeDuplicates([short, short2]).merged, 0);
});

test('one side with distance and the other without is never matched', () => {
  assert.equal(mergeDuplicates([strava(), apple({ distance_m: 0 })]).merged, 0);
});

test('a secondary merges into at most one primary — the closest in time', () => {
  const sFar = strava({ id: 's-far', date: min(-6) });
  const sNear = strava({ id: 's-near', date: min(1) });
  const a = apple({ date: min(2) });
  const list = [sFar, sNear, a];
  assert.equal(mergeDuplicates(list).merged, 1);
  assert.equal(a.merged_into, 's-near');
  assert.equal(sFar.merged_ids.length, 0);
  assert.equal(sFar.has_duplicate, false);
});

test('idempotent: re-running yields the same result and no duplicated state', () => {
  const s = strava();
  const a = apple();
  const list = [s, a];
  mergeDuplicates(list);
  const once = JSON.stringify(list, (k, v) => (typeof v === 'function' ? 'fn' : v));
  assert.deepEqual(mergeDuplicates(list), { merged: 1 });
  const twice = JSON.stringify(list, (k, v) => (typeof v === 'function' ? 'fn' : v));
  assert.equal(twice, once);
  assert.deepEqual(s.merged_ids, ['a1']);
  assert.deepEqual(s.sources, ['strava', 'apple']);
});

test('resetMerges restores the primary to its pre-merge state', () => {
  const s = strava({ avg_heart_rate: null });
  const a = apple();
  const list = [s, a];
  mergeDuplicates(list);
  assert.equal(s.avg_heart_rate, 150);
  resetMerges(list);
  assert.equal(s.avg_heart_rate, null);
  assert.deepEqual(s.sources, ['strava']);
  assert.deepEqual(s.merged_ids, []);
  assert.equal(s.has_duplicate, false);
  assert.equal(a.merged_into, null);
  assert.equal(visibleActivities(list).length, 2);
});

test('re-running after new data arrives picks up the new pair', () => {
  const s1 = strava();
  const a1 = apple();
  const list = [s1, a1];
  mergeDuplicates(list);
  list.push(strava({ id: 's2', date: min(600) }), apple({ id: 'a2', date: min(601) }));
  assert.equal(mergeDuplicates(list).merged, 2);
  assert.equal(visibleActivities(list).length, 2);
});

test('scales: 20k activities merge quickly (sorted sweep, not O(n²))', () => {
  const list = [];
  for (let i = 0; i < 10000; i++) {
    const date = new Date(T0 + i * 3600000);
    list.push(strava({ id: `s${i}`, date, has_route: false, _gpxLoader: undefined }));
    list.push(apple({ id: `a${i}`, date: new Date(+date + 60000) }));
  }
  const t = performance.now();
  assert.equal(mergeDuplicates(list).merged, 10000);
  assert.ok(performance.now() - t < 3000, `took ${performance.now() - t}ms`);
});
