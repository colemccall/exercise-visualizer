import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSplits } from '../../../src/analysis/activity/splits.js';
import { bestEfforts, bestEffortsAcross } from '../../../src/analysis/activity/efforts.js';
import { buildRoute } from '../_helpers.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('km splits on a constant-pace line are exact', () => {
  const pts = buildRoute([{ dist: 6000, speed: 4 }], { hr: 150, ele: d => d / 20 });
  const s = computeSplits(pts, 'km');
  assert.equal(s.length, 6);
  s.forEach((sp, i) => {
    assert.equal(sp.index, i + 1);
    assert.equal(sp.partial, false);
    near(sp.time_s, 250, 0.01);
    near(sp.pace_s_per_m, 0.25, 1e-5);
    assert.equal(sp.avg_hr, 150);
    near(sp.ele_gain_m, 50, 3, 'gain');
    assert.equal(sp.ele_loss_m, 0);
  });
});

test('mile splits: partial tail, sums to total within 1%', () => {
  const pts = buildRoute([{ dist: 6000, speed: 4 }]);
  const s = computeSplits(pts, 'mi');
  assert.equal(s.length, 4);
  assert.deepEqual(s.map(x => x.partial), [false, false, false, true]);
  near(s[0].time_s, 1609.344 / 4, 0.01);
  const sum = s.reduce((t, x) => t + x.dist_m, 0);
  assert.ok(Math.abs(sum - 6000) / 6000 < 0.01);
  assert.equal(s[0].avg_hr, null);
  assert.equal(s[0].ele_gain_m, null);
});

test('splits survive duplicate GPS points and refuse missing time', () => {
  const pts = buildRoute([{ dist: 3000, speed: 4 }]);
  pts.splice(60, 0, { ...pts[60] }, { ...pts[60] });
  const s = computeSplits(pts, 'km');
  assert.equal(s.length, 3);
  near(s.reduce((t, x) => t + x.dist_m, 0), 3000, 0.01);
  assert.deepEqual(computeSplits(buildRoute([{ dist: 3000, speed: 4 }], { withTime: false }), 'km'), []);
  assert.deepEqual(computeSplits([], 'km'), []);
});

test('bestEfforts: constant pace gives distance / speed; longer distances are skipped', () => {
  const e = bestEfforts(buildRoute([{ dist: 6000, speed: 4 }]), 'Run');
  assert.deepEqual(e.map(x => x.key), ['400m', '1k', '1mi', '5k']);
  const by = Object.fromEntries(e.map(x => [x.key, x]));
  near(by['400m'].time_s, 100, 0.01);
  near(by['1k'].time_s, 250, 0.01);
  near(by['1mi'].time_s, 1609.344 / 4, 0.01);
  near(by['5k'].time_s, 1250, 0.01);
  assert.ok(by['5k'].start_idx < by['5k'].end_idx);
});

test('bestEfforts finds the fast stretch in a variable-pace run', () => {
  const pts = buildRoute([{ dist: 2000, speed: 4 }, { dist: 2000, speed: 5 }, { dist: 2000, speed: 4 }]);
  const by = Object.fromEntries(bestEfforts(pts, 'Run').map(x => [x.key, x]));
  near(by['1k'].time_s, 200, 0.01);
  near(by['5k'].time_s, 2000 / 5 + 3000 / 4, 0.01);
});

test('bestEfforts: rides, unsupported types, and untimed routes', () => {
  const ride = bestEfforts(buildRoute([{ dist: 25000, speed: 8 }], { spacing: 50 }), 'Ride');
  assert.deepEqual(ride.map(x => x.key), ['ride-5k', 'ride-10k', 'ride-20k']);
  near(ride[0].time_s, 625, 0.01);
  assert.deepEqual(bestEfforts(buildRoute([{ dist: 6000, speed: 4 }]), 'Hike'), []);
  assert.deepEqual(bestEfforts(buildRoute([{ dist: 6000, speed: 4 }], { withTime: false }), 'Run'), []);
});

test('bestEffortsAcross keeps the fastest per key with its activity', () => {
  const slow = { id: 'slow', type: 'Run', date: new Date(2025, 1, 1), route_points: buildRoute([{ dist: 5000, speed: 3 }]) };
  const fast = { id: 'fast', type: 'Run', date: new Date(2025, 2, 1), route_points: buildRoute([{ dist: 5000, speed: 4 }]) };
  const res = bestEffortsAcross([slow, fast, { id: 'x', type: 'Run' }]);
  const five = res.find(r => r.key === '5k');
  assert.equal(five.activity_id, 'fast');
  near(five.time_s, 1250, 0.01);
  assert.equal(five.date.getTime(), fast.date.getTime());
});
