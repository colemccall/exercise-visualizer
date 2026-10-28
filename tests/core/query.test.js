import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, formatQuery, queryTokens, emptyFilters } from '../../src/core/lib/query.js';

const KM = { units: 'metric' };
const MI = { units: 'imperial' };
const p = (text, opts = KM) => parseQuery(text, opts);
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('type, year, month (0-based internally), dates, source, has, is, gear', () => {
  const { filters: f, errors } = p('type:run,ride year:2025 month:2025-04 after:2025-01-05 before:2025-06-30 source:apple has:route is:indoor gear:Pegasus');
  assert.deepEqual(errors, []);
  assert.deepEqual(f.types, ['Run', 'Ride']);
  assert.equal(f.year, 2025);
  assert.equal(f.month, '2025-3', 'April is month 3 in the internal "YYYY-<0-based>" key');
  assert.equal(f.from.getFullYear(), 2025); assert.equal(f.from.getMonth(), 0); assert.equal(f.from.getDate(), 5);
  assert.equal(f.to.getMonth(), 5); assert.equal(f.to.getDate(), 30);
  assert.equal(f.source, 'apple'); assert.equal(f.hasRoute, true); assert.equal(f.indoor, true);
  assert.equal(f.gear, 'pegasus');
});

test('type aliases', () => {
  assert.deepEqual(p('type:bike').filters.types, ['Ride']);
  assert.deepEqual(p('type:cycling,walk').filters.types, ['Ride', 'Walk']);
});

test('distance: units, defaults follow the user setting, ranges share a trailing unit', () => {
  near(p('dist:>10km').filters.dist[0], 10000);
  assert.equal(p('dist:>10km').filters.dist[1], null);
  near(p('dist:<5mi').filters.dist[1], 5 * 1609.344);
  const r = p('dist:5..10km').filters.dist;
  near(r[0], 5000); near(r[1], 10000);
  const mi = p('dist:5..10mi').filters.dist;
  near(mi[0], 5 * 1609.344); near(mi[1], 10 * 1609.344);
  near(p('dist:>10', MI).filters.dist[0], 10 * 1609.344);   // bare number = the user's unit
  near(p('dist:>10', KM).filters.dist[0], 10000);
  near(p('dist:>500m').filters.dist[0], 500);
});

test('duration: h/m/s, clock and bare minutes', () => {
  assert.deepEqual(p('dur:>1h30m').filters.dur, [5400, null]);
  assert.deepEqual(p('dur:<45m').filters.dur, [null, 2700]);
  assert.deepEqual(p('dur:20m..45m').filters.dur, [1200, 2700]);
  assert.deepEqual(p('dur:>1:30').filters.dur, [5400, null]);
  assert.deepEqual(p('dur:>90').filters.dur, [5400, null], 'a bare number is minutes');
});

test('elevation and heart rate', () => {
  near(p('elev:>500m').filters.elev[0], 500);
  near(p('elev:>1500ft').filters.elev[0], 1500 * 0.3048, 0.01);
  near(p('elev:>1000', MI).filters.elev[0], 1000 * 0.3048, 0.01);
  assert.deepEqual(p('hr:>150').filters.hr, [150, null]);
  assert.deepEqual(p('hr:120..140').filters.hr, [120, 140]);
});

test('weekday, weekend, lists and sorting', () => {
  assert.deepEqual(p('dow:sat,sun').filters.dow, [0, 6]);
  assert.deepEqual(p('dow:weekend').filters.dow, [0, 6]);
  assert.deepEqual(p('dow:weekday').filters.dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(p('sort:-dist').filters.sort, { key: 'dist', dir: 'desc' });
  assert.deepEqual(p('sort:dist').filters.sort, { key: 'dist', dir: 'desc' }, 'distance defaults to biggest first');
  assert.deepEqual(p('sort:pace').filters.sort, { key: 'pace', dir: 'asc' }, 'pace defaults to fastest first');
  assert.deepEqual(p('sort:oldest').filters.sort, { key: 'date', dir: 'asc' });
  assert.deepEqual(p('sort:+dur').filters.sort, { key: 'dur', dir: 'asc' });
});

test('free text and quoted phrases; unknown "words:" stay as text', () => {
  assert.equal(p('hill repeats').text, 'hill repeats');
  assert.equal(p('"hill repeats" type:run').text, 'hill repeats');
  assert.deepEqual(p('"hill repeats" type:run').filters.types, ['Run']);
  assert.equal(p('9:30 re:run').text, '9:30 re:run');
  assert.equal(p('gear:"road bike"').filters.gear, 'road bike');
});

test('bad values are reported, ignored, and never throw', () => {
  const r = p('type:banana dist:>fast year:20 month:2025-13 dur:soon dow:funday source:garmin has:photo sort:random');
  assert.equal(r.errors.length, 9);
  assert.ok(r.errors.every(e => e.token && e.message));
  assert.deepEqual(r.filters, emptyFilters(), 'nothing from the bad tokens is applied');
  assert.equal(p('').errors.length, 0);
  assert.equal(p(null).text, '');
  assert.match(p('dist:10km').errors[0].message, /> or < or a\.\.b/);
});

test('formatQuery is the inverse of parseQuery', () => {
  const original = 'type:run,ride year:2025 dist:5..10km dur:>45m hr:>150 has:route is:indoor dow:weekend sort:-pace gear:pegasus "hill repeats"';
  const parsed = p(original).filters;
  const text = formatQuery(parsed, KM);
  const again = p(text).filters;
  assert.deepEqual(again, parsed, `round trip changed the filters: ${text}`);
  // and for imperial users
  const imp = p('dist:>6mi elev:>1000ft', MI).filters;
  assert.deepEqual(p(formatQuery(imp, MI), MI).filters, imp);
});

test('queryTokens: one removable piece per active filter, keyed by the field to reset', () => {
  const f = { ...emptyFilters(), type: 'Run', search: 'hill', year: 2025, hasRoute: true };
  const t = queryTokens(f, KM);
  assert.deepEqual(t.map(x => x.key), ['type', 'year', 'hasRoute', 'search']);
  assert.deepEqual(t.map(x => x.text), ['type:run', 'year:2025', 'has:route', 'hill']);
  assert.deepEqual(queryTokens(emptyFilters(), KM), []);
});

test('a single chip-set type round-trips too', () => {
  const f = { ...emptyFilters(), type: 'Swim' };
  assert.equal(formatQuery(f, KM), 'type:swim');
});
