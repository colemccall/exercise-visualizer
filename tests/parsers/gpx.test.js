import './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpx, SAMPLE_GPX } from './fixtures.js';
import { parseGPX, computeElevationGain, computeDistance } from '../../src/parsers/gpx.js';

test('parseGPX reads lat/lng/ele/time and HR, cadence, power extensions', () => {
  const pts = parseGPX(SAMPLE_GPX);
  assert.equal(pts.length, 3);
  assert.deepEqual(
    { lat: pts[1].lat, lng: pts[1].lng, ele: pts[1].ele, hr: pts[1].hr, cad: pts[1].cad, watts: pts[1].watts },
    { lat: 40.001, lng: -75.0, ele: 12, hr: 110, cad: 82, watts: 160 },
  );
  assert.equal(pts[0].time.toISOString(), '2026-04-22T03:14:03.000Z');
});

test('missing sensors come back as null, not undefined/NaN', () => {
  const pts = parseGPX(gpx([{ lat: 1, lon: 2, ele: 5 }]));
  assert.equal(pts[0].hr, null);
  assert.equal(pts[0].cad, null);
  assert.equal(pts[0].watts, null);
  assert.equal(pts[0].time, null);
});

test('invalid XML yields an empty route rather than throwing', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(parseGPX('<gpx><trk>'), []);
  } finally {
    console.warn = warn;
  }
});

test('elevation gain: noisy flat track counts ~nothing', () => {
  // ±1 m jitter around 100 m, 200 samples — the old per-step sum reported ~100 m.
  const pts = Array.from({ length: 200 }, (_, i) => ({ ele: 100 + (i % 2 ? 1 : -1) }));
  assert.ok(computeElevationGain(pts) < 3, `got ${computeElevationGain(pts)}`);
});

test('elevation gain: single-sample spike is ignored', () => {
  const pts = [10, 10, 10, 60, 10, 10, 10].map(ele => ({ ele }));
  assert.equal(computeElevationGain(pts), 0);
});

test('elevation gain: a real steady climb is counted', () => {
  const pts = Array.from({ length: 101 }, (_, i) => ({ ele: i })); // 0 → 100 m
  const gain = computeElevationGain(pts);
  assert.ok(gain >= 97 && gain <= 100, `got ${gain}`);
});

test('elevation gain tolerates nulls and short tracks', () => {
  assert.equal(computeElevationGain([]), 0);
  assert.equal(computeElevationGain([{ ele: null }, { ele: null }]), 0);
});

test('computeDistance sums haversine legs (~111 m per 0.001° lat)', () => {
  const d = computeDistance([{ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }]);
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});
