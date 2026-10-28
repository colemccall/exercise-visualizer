import test from 'node:test';
import assert from 'node:assert/strict';
import { activityMatches, sortActivities, isFiltered, describeFilters, state, clearFilters, clearFilter, setFilters } from '../../src/core/state.js';
import { parseQuery, emptyFilters } from '../../src/core/lib/query.js';

const mk = (o) => ({ id: o.id, type: 'Run', name: 'Run', sub_type: 'Run', date: new Date(2025, 3, 12, 8), distance_m: 5000, duration_s: 1800, moving_s: 1750,
  elevation_gain_m: 40, avg_heart_rate: 140, has_route: true, indoor: false, source: 'strava', sources: ['strava'], gear: null, description: null, device: null, ...o });

const acts = [
  mk({ id: 'a', name: 'Morning Run', distance_m: 5000 }),
  mk({ id: 'b', name: 'Long Run', distance_m: 21000, moving_s: 6600, duration_s: 6800, elevation_gain_m: 250, avg_heart_rate: 152, date: new Date(2025, 3, 19, 7) }),   // Sat
  mk({ id: 'c', type: 'Ride', name: 'Hill Repeats', sub_type: 'Ride', distance_m: 42000, moving_s: 5400, elevation_gain_m: 900, avg_heart_rate: 138, gear: 'Pegasus road bike', date: new Date(2024, 8, 3, 18) }),
  mk({ id: 'd', type: 'Other', name: 'Yoga', sub_type: 'Yoga', distance_m: 0, moving_s: 3600, duration_s: 3600, elevation_gain_m: null, avg_heart_rate: null, has_route: false, indoor: true, source: 'apple', sources: ['apple'], date: new Date(2025, 5, 2, 12), description: 'Evening stretch' }),
];
const ids = (text, opts = { units: 'metric' }) => acts.filter(a => activityMatches(a, parseQuery(text, opts).filters)).map(a => a.id);

test('type, year, date range, weekday', () => {
  assert.deepEqual(ids('type:run'), ['a', 'b']);
  assert.deepEqual(ids('type:run,ride'), ['a', 'b', 'c']);
  assert.deepEqual(ids('year:2024'), ['c']);
  assert.deepEqual(ids('after:2025-04-15'), ['b', 'd']);
  assert.deepEqual(ids('before:2025-04-12'), ['a', 'c'], '"before" includes the whole day');
  assert.deepEqual(ids('dow:sat'), ['a', 'b'], 'both runs were on Saturdays (12 and 19 April 2025)');
  assert.deepEqual(ids('dow:weekend'), ['a', 'b'], 'the Monday yoga is not a weekend');
});

test('numeric ranges: distance, duration, elevation, heart rate (activities missing the value never match)', () => {
  assert.deepEqual(ids('dist:>10km'), ['b', 'c']);
  assert.deepEqual(ids('dist:4..6km'), ['a']);
  assert.deepEqual(ids('dur:>1h30m'), ['b', 'c'].filter(x => x === 'b' || x === 'c'));
  assert.deepEqual(ids('elev:>200m'), ['b', 'c']);
  assert.deepEqual(ids('hr:>145'), ['b']);
  assert.deepEqual(ids('hr:<200'), ['a', 'b', 'c'], 'yoga has no heart rate so it is excluded from a heart-rate filter');
});

test('boolean fields and source', () => {
  assert.deepEqual(ids('has:route'), ['a', 'b', 'c']);
  assert.deepEqual(ids('is:indoor'), ['d']);
  assert.deepEqual(ids('is:outdoor'), ['a', 'b', 'c']);
  assert.deepEqual(ids('source:apple'), ['d']);
  assert.deepEqual(ids('is:merged'), []);
});

test('text searches name, type, sub-type, description and gear; every word must match', () => {
  assert.deepEqual(ids('hill'), ['c']);
  assert.deepEqual(ids('yoga'), ['d']);
  assert.deepEqual(ids('stretch'), ['d'], 'description');
  assert.deepEqual(ids('pegasus'), ['c'], 'gear');
  assert.deepEqual(ids('gear:pegasus'), ['c']);
  assert.deepEqual(ids('long run'), ['b']);
  assert.deepEqual(ids('long yoga'), [], 'all words must match');
  assert.deepEqual(ids('"hill repeats"'), ['c']);
});

test('combined filters narrow together', () => {
  assert.deepEqual(ids('type:run year:2025 dist:>10km'), ['b']);
});

test('sorting: distance, pace, oldest, name, and stable fallbacks', () => {
  const sorted = (key, dir) => sortActivities(acts, { key, dir }).map(a => a.id);
  assert.deepEqual(sorted('dist', 'desc'), ['c', 'b', 'a', 'd']);
  assert.deepEqual(sorted('date', 'asc'), ['c', 'a', 'b', 'd'].sort((x, y) => acts.find(a => a.id === x).date - acts.find(a => a.id === y).date));
  assert.equal(sorted('pace', 'asc')[0], 'c', 'the 42 km ride is the fastest per metre');
  assert.equal(sorted('pace', 'asc').at(-1), 'd', 'no distance sorts last');
  assert.deepEqual(sorted('name', 'asc'), ['c', 'b', 'a', 'd']);
  assert.deepEqual(sortActivities(acts, null).map(a => a.id), ['d', 'b', 'a', 'c'], 'default is newest first');
});

test('isFiltered / describeFilters / clearFilter', () => {
  clearFilters();
  assert.equal(isFiltered(), false);
  setFilters(parseQuery('type:run dist:>10km sort:-dist hill', { units: 'metric' }).filters);
  assert.equal(isFiltered(), true);
  assert.deepEqual(describeFilters().map(c => c.key), ['types', 'dist', 'search'], 'sort is not a narrowing filter');
  clearFilter('dist');
  assert.equal(state.filters.dist, null);
  clearFilter('types');
  clearFilter('search');
  assert.equal(isFiltered(), false);
  setFilters({ ...emptyFilters(), sort: { key: 'dist', dir: 'desc' } });
  assert.equal(isFiltered(), false, 'sorting alone does not count as filtering');
  clearFilters();
  assert.deepEqual(state.filters.sort, { key: 'dist', dir: 'desc' }, 'Clear keeps the chosen sort');
});
