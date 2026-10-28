import './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, gzip, makeZip, namedBuffer, SAMPLE_GPX, STRAVA_HEADERS, stravaRow } from './fixtures.js';
import { parse } from '../../src/parsers/strava.js';

const parseCsv = async (rows) =>
  parse(namedBuffer(csv(STRAVA_HEADERS, rows), 'activities.csv'));

test('activity date is read as UTC, not local time', async () => {
  const [a] = await parseCsv([stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM' })]);
  assert.equal(a.date.toISOString(), '2026-04-22T03:14:03.000Z');
  const [b] = await parseCsv([stravaRow({ id: 2, date: 'Apr 21, 2026, 11:45:46 PM' })]);
  assert.equal(b.date.toISOString(), '2026-04-21T23:45:46.000Z');
});

test('type mapping accepts CamelCase and spaced names, case-insensitively', async () => {
  const labels = {
    'Run': 'Run', 'VirtualRun': 'Run', 'Trail Run': 'Run', 'trail run': 'Run',
    'Ride': 'Ride', 'Virtual Ride': 'Ride', 'VirtualRide': 'Ride',
    'Mountain Bike Ride': 'Ride', 'E-Bike Ride': 'Ride', 'Gravel Ride': 'Ride',
    'Walk': 'Walk', 'Hike': 'Hike', 'Swim': 'Swim', 'Open Water Swim': 'Swim',
    'Weight Training': 'Other', 'Yoga': 'Other', 'Alpine Ski': 'Other', 'Workout': 'Other',
  };
  const rows = Object.keys(labels).map((type, i) =>
    stravaRow({ id: i + 1, date: 'Apr 22, 2026, 3:14:03 AM', type }));
  const acts = await parseCsv(rows);
  Object.entries(labels).forEach(([label, expected], i) => {
    assert.equal(acts[i].type, expected, label);
  });
});

test('sub_type keeps the source label, humanized', async () => {
  const acts = await parseCsv([
    stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM', type: 'VirtualRide' }),
    stravaRow({ id: 2, date: 'Apr 22, 2026, 4:14:03 AM', type: 'Weight Training' }),
  ]);
  assert.equal(acts[0].sub_type, 'Virtual Ride');
  assert.equal(acts[1].sub_type, 'Weight Training');
});

test('elapsed and moving time are separate; distance prefers the metre column', async () => {
  const [a] = await parseCsv([stravaRow({
    id: 1, date: 'Apr 22, 2026, 3:14:03 AM', elapsed: 3452, moving: 3329, km: 3.81, meters: 3812.9,
  })]);
  assert.equal(a.duration_s, 3452);
  assert.equal(a.moving_s, 3329);
  assert.equal(a.distance_m, 3812.9);
});

test('distance falls back to km when the metre column disagrees', async () => {
  const [a] = await parseCsv([stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM', km: 5, meters: 99999 })]);
  assert.equal(a.distance_m, 5000);
});

test('v2 fields: calories, cadence, watts, max speed, gear, description, HR', async () => {
  const [a] = await parseCsv([stravaRow({
    id: 1, date: 'Apr 22, 2026, 3:14:03 AM', type: 'Ride', calories: 640, cad: 88, watts: 190,
    maxSpeed: 12.5, gear: 'Road bike', description: 'Sunny loop', avgHr: 141, maxHr: 172, elev: 220,
  })]);
  assert.equal(a.calories_kcal, 640);
  assert.equal(a.avg_cadence, 88);
  assert.equal(a.avg_watts, 190);
  assert.equal(a.max_speed_mps, 12.5);
  assert.equal(a.gear, 'Road bike');
  assert.equal(a.description, 'Sunny loop');
  assert.equal(a.avg_heart_rate, 141);
  assert.equal(a.max_heart_rate, 172);
  assert.equal(a.elevation_gain_m, 220);
  assert.deepEqual(a.sources, ['strava']);
  assert.deepEqual(a.merged_ids, []);
  assert.equal(a.merged_into, null);
});

test('blank/zero sensor columns become null', async () => {
  const [a] = await parseCsv([stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM', cad: 0, watts: '', calories: 0 })]);
  assert.equal(a.avg_cadence, null);
  assert.equal(a.avg_watts, null);
  assert.equal(a.calories_kcal, null);
  assert.equal(a.moving_s, null);
});

test('a row without an Activity ID gets a stable, non-random id', async () => {
  const row = () => stravaRow({ id: '', date: 'Apr 22, 2026, 3:14:03 AM', name: 'No id run' });
  const [a] = await parseCsv([row()]);
  const [b] = await parseCsv([row()]);
  assert.match(a.id, /^strava-\d+-[0-9a-z]+$/);
  assert.equal(a.id, b.id);
});

test('ZIP: .gpx and .gpx.gz routes load; an undecodable .fit.gz gets a loader returning []; missing files get none', async () => {
  const rows = [
    stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM', filename: 'activities/plain.gpx' }),
    stravaRow({ id: 2, date: 'Apr 23, 2026, 3:14:03 AM', filename: 'activities/zipped.gpx.gz' }),
    // CSV says .gpx but the archive stores it gzipped
    stravaRow({ id: 3, date: 'Apr 24, 2026, 3:14:03 AM', filename: 'activities/sneaky.gpx' }),
    stravaRow({ id: 4, date: 'Apr 25, 2026, 3:14:03 AM', filename: 'activities/watch.fit.gz' }),
    stravaRow({ id: 5, date: 'Apr 26, 2026, 3:14:03 AM', filename: 'activities/missing.gpx' }),
    stravaRow({ id: 6, date: 'Apr 27, 2026, 3:14:03 AM', filename: '' }),
  ];
  const zip = await makeZip({
    'activities.csv': csv(STRAVA_HEADERS, rows),
    'activities/plain.gpx': SAMPLE_GPX,
    'activities/zipped.gpx.gz': gzip(SAMPLE_GPX),
    'activities/sneaky.gpx.gz': gzip(SAMPLE_GPX),
    'activities/watch.fit.gz': Buffer.from([1, 2, 3]),
  }, 'export.zip');

  const acts = await parse(zip);
  assert.equal(acts.length, 6);
  assert.deepEqual(acts.map(a => a.has_route), [true, true, true, true, false, false]);

  for (const a of acts.slice(0, 3)) {
    const pts = await a._gpxLoader();
    assert.equal(pts.length, 3, a.id);
    assert.equal(pts[2].hr, 120);
    assert.equal(pts[2].cad, 84);
    assert.equal(pts[2].watts, 170);
  }
  // The .fit.gz holds junk bytes (not gzip, not FIT): the loader must not throw.
  assert.deepEqual(await acts[3]._gpxLoader(), []);
  assert.equal(acts[4]._gpxLoader, undefined);
});

test('ZIP without activities.csv returns an empty list', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const zip = await makeZip({ 'readme.txt': 'hi' });
    assert.deepEqual(await parse(zip), []);
  } finally {
    console.warn = warn;
  }
});

test('standalone .gpx upload becomes one activity with sensor averages', async () => {
  const acts = await parse(namedBuffer(SAMPLE_GPX, 'morning_run.gpx'));
  assert.equal(acts.length, 1);
  const a = acts[0];
  assert.equal(a.name, 'morning run');
  assert.equal(a.has_route, true);
  assert.equal(a.duration_s, 120);
  assert.equal(a.avg_cadence, 82);
  assert.equal(a.avg_watts, 160);
  assert.equal(a.avg_heart_rate, 110);
});
