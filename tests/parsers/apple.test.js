import './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, namedBuffer, SAMPLE_GPX } from './fixtures.js';
import { parse, parseApple, parseAppleExport } from '../../src/parsers/apple.js';

const RUN = `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Test Watch" sourceVersion="1" creationDate="2026-04-22 08:00:00 -0400" startDate="2026-04-22 07:00:00 -0400" endDate="2026-04-22 07:30:00 -0400">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <MetadataEntry key="HKElevationAscended" value="5000 cm"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2026-04-22 07:10:00 -0400" duration="99" durationUnit="min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="x" endDate="y" sum="3.1" unit="mi"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="x" endDate="y" average="141.4" minimum="90" maximum="170.2" unit="count/min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="x" endDate="y" sum="312.6" unit="Cal"/>
  <WorkoutRoute sourceName="Test Watch" creationDate="2026-04-22 08:00:00 -0400">
   <FileReference path="/workout-routes/route_2026-04-22_8.00am.gpx"/>
  </WorkoutRoute>
 </Workout>`;

const YOGA = `<Workout workoutActivityType="HKWorkoutActivityTypeYoga" duration="1" durationUnit="hr" sourceName="Test Watch" startDate="2026-04-23 07:00:00 -0400" endDate="2026-04-23 08:00:00 -0400">
  <MetadataEntry key="HKIndoorWorkout" value="1"/>
 </Workout>`;

const ROWING = `<Workout workoutActivityType="HKWorkoutActivityTypeRowing" duration="900" durationUnit="sec" totalEnergyBurned="150" totalEnergyBurnedUnit="kcal" startDate="2026-04-24 07:00:00 -0400" endDate="2026-04-24 07:15:00 -0400"/>`;

const SUMMARIES = `
 <ActivitySummary dateComponents="2026-04-22" activeEnergyBurned="512.4" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="45" appleExerciseTimeGoal="30" appleStandHours="11" appleStandHoursGoal="12"/>
 <ActivitySummary dateComponents="2026-04-20" activeEnergyBurned="300" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="10" appleExerciseTimeGoal="30" appleStandHours="8" appleStandHoursGoal="12"/>
 <ActivitySummary dateComponents="2020-01-01" activeEnergyBurned="0" activeEnergyBurnedGoal="0" activeEnergyBurnedUnit="Cal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="0" appleExerciseTimeGoal="0" appleStandHours="0" appleStandHoursGoal="0"/>`;

const record = (i) =>
  ` <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Test" unit="count" creationDate="2026-04-22 07:00:00 -0400" startDate="2026-04-22 07:00:00 -0400" endDate="2026-04-22 07:01:00 -0400" value="${i}"/>`;

function exportXml(workouts, { noise = 20, summaries = SUMMARIES } = {}) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (Record)>\n]>\n<HealthData locale="en_US">'];
  for (const w of workouts) {
    for (let i = 0; i < noise; i++) parts.push(record(i));
    parts.push(w);
  }
  parts.push(summaries, '</HealthData>');
  return parts.join('\n');
}

const zipOf = (xml, extra = {}) =>
  makeZip({ 'apple_health_export/export.xml': xml, ...extra }, 'export.zip');

test('workout: type, duration, distance, HR, energy, elevation, indoor, device, route', async () => {
  const zip = await zipOf(exportXml([RUN]), {
    'apple_health_export/workout-routes/route_2026-04-22_8.00am.gpx': SAMPLE_GPX,
  });
  const { activities } = await parseAppleExport(zip);
  assert.equal(activities.length, 1);
  const a = activities[0];
  assert.equal(a.source, 'apple');
  assert.equal(a.type, 'Run');
  assert.equal(a.sub_type, 'Running');
  assert.equal(a.duration_s, 1800);       // own duration, not the WorkoutEvent's 99
  assert.equal(a.moving_s, 1800);
  assert.ok(Math.abs(a.distance_m - 3.1 * 1609.344) < 0.01);
  assert.equal(a.avg_heart_rate, 141);
  assert.equal(a.max_heart_rate, 170);
  assert.equal(a.calories_kcal, 313);
  assert.equal(a.elevation_gain_m, 50);
  assert.equal(a.indoor, false);
  assert.equal(a.device, 'Test Watch');
  assert.deepEqual(a.sources, ['apple']);
  assert.equal(a.has_route, true);
  const pts = await a._gpxLoader();
  assert.equal(pts.length, 3);
});

test('non-core types become Other with a humanized sub_type; units hr/sec handled', async () => {
  const zip = await zipOf(exportXml([YOGA, ROWING]));
  const { activities } = await parseAppleExport(zip);
  assert.equal(activities.length, 2);
  const [yoga, rowing] = activities;
  assert.equal(yoga.type, 'Other');
  assert.equal(yoga.sub_type, 'Yoga');
  assert.equal(yoga.duration_s, 3600);
  assert.equal(yoga.indoor, true);
  assert.equal(yoga.has_route, false);
  assert.match(yoga.name, /^Yoga — /);
  assert.equal(rowing.sub_type, 'Rowing');
  assert.equal(rowing.duration_s, 900);
  assert.equal(rowing.calories_kcal, 150);   // legacy totalEnergyBurned attribute
});

test('a route whose file is absent from the archive is not advertised', async () => {
  const zip = await zipOf(exportXml([RUN]));
  const [a] = (await parseAppleExport(zip)).activities;
  assert.equal(a.has_route, false);
  assert.equal(a.gpx_file, null);
});

test('ActivitySummary: sorted ascending, empty days dropped, fields mapped', async () => {
  const { summaries } = await parseAppleExport(await zipOf(exportXml([RUN])));
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map(s => s.date), ['2026-04-20', '2026-04-22']);
  assert.deepEqual(summaries[1], {
    date: '2026-04-22',
    move_kcal: 512.4, move_goal: 500, move_unit: 'kcal',
    exercise_min: 45, exercise_goal: 30,
    stand_hours: 11, stand_goal: 12,
  });
});

test('streaming survives chunk boundaries across a large export', async () => {
  const workouts = Array.from({ length: 60 }, (_, i) =>
    RUN.replace('2026-04-22 07:00:00', `2026-04-22 07:${String(i).padStart(2, '0')}:00`));
  // ~60 × 25 noise records → several hundred KB, many decompression chunks
  const zip = await zipOf(exportXml(workouts, { noise: 25 }));
  const { activities, summaries } = await parseAppleExport(zip);
  assert.equal(activities.length, 60);
  assert.equal(summaries.length, 2);
});

test('bare export.xml works (previously threw ReferenceError)', async () => {
  const file = namedBuffer(exportXml([RUN, YOGA]), 'export.xml');
  const { activities, summaries } = await parseAppleExport(file);
  assert.equal(activities.length, 2);
  assert.equal(summaries.length, 2);
  assert.equal(activities[0].has_route, false); // no archive → no route files
});

test('bare XML also accepts a Blob-style stream', async () => {
  const xml = exportXml([RUN]);
  const bytes = Buffer.from(xml);
  const file = {
    name: 'export.xml',
    size: bytes.length,
    stream: () => new Blob([bytes]).stream(),
  };
  const { activities } = await parseAppleExport(file);
  assert.equal(activities.length, 1);
});

test('parse / parseApple return activities only (compat wrappers)', async () => {
  const zip = await zipOf(exportXml([RUN]));
  assert.equal((await parse(zip)).length, 1);
  assert.equal((await parseApple(zip)).length, 1);
});

test('ZIP with no export.xml returns empty results', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await parseAppleExport(await makeZip({ 'x.txt': 'hi' }));
    assert.deepEqual(r, { activities: [], summaries: [] });
  } finally {
    console.warn = warn;
  }
});

const PAUSED = `<Workout workoutActivityType="HKWorkoutActivityTypeHiking" duration="46" durationUnit="min" sourceName="Test Watch" startDate="2026-04-25 10:00:00 -0400" endDate="2026-04-25 11:16:00 -0400">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <MetadataEntry key="HKWeatherTemperature" value="73 degF"/>
  <MetadataEntry key="HKWeatherHumidity" value="5500 %"/>
  <MetadataEntry key="HKAverageMETs" value="5.42 kcal/hr·kg"/>
  <MetadataEntry key="HKTimeZone" value="America/Chicago"/>
  <MetadataEntry key="HKExternalUUID" value="strava://18186496720"/>
  <MetadataEntry key="HKWeatherTemperature" value="73 degF"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierStepCount" startDate="x" endDate="y" sum="4210" unit="count"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierRunningPower" startDate="x" endDate="y" average="212.4" unit="W"/>
 </Workout>`;

test('duration is elapsed (start to end) and moving time is Apple active time', async () => {
  const { activities } = await parseAppleExport(await zipOf(exportXml([PAUSED])));
  const a = activities[0];
  assert.equal(a.duration_s, 76 * 60, 'elapsed = end - start');
  assert.equal(a.moving_s, 46 * 60, 'active time kept as moving time');
});

test('workouts with no pause keep duration == moving time', async () => {
  const { activities } = await parseAppleExport(await zipOf(exportXml([RUN])));
  assert.equal(activities[0].duration_s, 1800);
  assert.equal(activities[0].moving_s, 1800);
});

test('weather, METs, time zone, external id, steps and running power are captured', async () => {
  const { activities } = await parseAppleExport(await zipOf(exportXml([PAUSED])));
  const a = activities[0];
  assert.equal(a.weather.temp_c, 22.8);               // 73 F
  assert.equal(a.weather.humidity_pct, 55);           // stored x100 in the export
  assert.equal(a.avg_mets, 5.42);
  assert.equal(a.time_zone, 'America/Chicago');
  assert.equal(a.external_id, 'strava://18186496720');
  assert.equal(a.steps, 4210);
  assert.equal(a.avg_watts, 212);
});

test('a workout without these fields leaves them null', async () => {
  const { activities } = await parseAppleExport(await zipOf(exportXml([YOGA])));
  const a = activities[0];
  assert.equal(a.weather, null); assert.equal(a.avg_mets, null); assert.equal(a.external_id, null); assert.equal(a.steps, null);
});

test('Move-minutes users: appleMoveTime fills the Move ring and is flagged as minutes', async () => {
  const xml = exportXml([RUN], { summaries: ` <ActivitySummary dateComponents="2026-05-01" activeEnergyBurned="0" activeEnergyBurnedGoal="0" activeEnergyBurnedUnit="Cal" appleMoveTime="42" appleMoveTimeGoal="60" appleExerciseTime="30" appleExerciseTimeGoal="30" appleStandHours="9" appleStandHoursGoal="12"/>` });
  const { summaries } = await parseAppleExport(await zipOf(xml));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].move_kcal, 42);
  assert.equal(summaries[0].move_goal, 60);
  assert.equal(summaries[0].move_unit, 'min');
});
