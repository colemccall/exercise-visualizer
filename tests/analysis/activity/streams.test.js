import test from 'node:test';
import assert from 'node:assert/strict';
import { haversine, cumulativeDistance, decimate, buildSeries, hasStream } from '../../../src/analysis/activity/streams.js';
import { buildRoute, DEG_PER_M } from '../_helpers.js';

test('haversine: one degree of latitude is ~111.2 km', () => {
  const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111195) < 50);
});

test('cumulativeDistance matches route length', () => {
  const pts = buildRoute([{ dist: 1000, speed: 4 }]);
  const d = cumulativeDistance(pts);
  assert.equal(d[0], 0);
  assert.ok(Math.abs(d[d.length - 1] - 1000) < 0.01);
});

test('decimate keeps endpoints, respects the cap, and keeps the corner', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ lat: 40 + i * 20 * DEG_PER_M, lng: -105 });
  const degLng = DEG_PER_M / Math.cos(40 * Math.PI / 180);
  for (let j = 1; j <= 100; j++) pts.push({ lat: pts[100].lat, lng: -105 + j * 20 * degLng });
  const out = decimate(pts, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0], pts[0]);
  assert.equal(out[3], pts[pts.length - 1]);
  assert.ok(out.includes(pts[100]), 'corner survives');
  assert.equal(decimate(pts, 5000).length, pts.length);
});

test('buildSeries: aligned arrays, pace from speed, stopped = null', () => {
  const pts = buildRoute([{ dist: 1000, speed: 4 }]);
  const s = buildSeries(pts);
  const n = s.dist.length;
  for (const k of ['ele', 'pace', 'speed', 'hr', 'cad', 'time', 'idx']) assert.equal(s[k].length, n);
  assert.ok(Math.abs(s.pace[10] - 0.25) < 1e-3);
  assert.equal(s.time[n - 1], 250);

  const stopped = buildRoute([{ dist: 400, speed: 4 }, { dist: 400, speed: 0.01 }], { spacing: 20 });
  assert.equal(buildSeries(stopped).pace.at(-1), null);
});

test('buildSeries caps samples and degrades without time', () => {
  const pts = buildRoute([{ dist: 40000, speed: 4 }], { spacing: 10, withTime: false });
  const s = buildSeries(pts, { maxSamples: 800 });
  assert.ok(s.dist.length <= 800 && s.dist.length > 700);
  assert.equal(s.idx[0], 0);
  assert.equal(s.idx.at(-1), pts.length - 1);
  assert.ok(s.time.every(v => v === null) && s.pace.every(v => v === null));
});

test('hasStream', () => {
  const pts = buildRoute([{ dist: 100, speed: 4 }], { hr: 140 });
  assert.ok(hasStream(pts, 'time') && hasStream(pts, 'hr'));
  assert.ok(!hasStream(pts, 'ele') && !hasStream(pts, 'cad'));
});
