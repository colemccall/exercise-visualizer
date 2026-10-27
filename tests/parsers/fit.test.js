import './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { csv, makeZip, STRAVA_HEADERS, stravaRow } from './fixtures.js';
import { parseFit, parseFitRecords, parseFitSummary } from '../../parsers/fit.js';
import { parse } from '../../parsers/strava.js';

// ── Tiny FIT encoder (test helper) ───────────────────────────────────────────
const FIT_EPOCH = Date.UTC(1989, 11, 31);
const fitTs = (iso) => Math.round((Date.parse(iso) - FIT_EPOCH) / 1000);
const semi = (deg) => Math.round(deg * 2147483648 / 180);

/** Definition message. fields: [num, size, baseType]; dev: [num, size, devIndex]. */
function def(local, global, fields, { little = true, dev = [] } = {}) {
  const b = [(local & 0x0F) | 0x40 | (dev.length ? 0x20 : 0), 0, little ? 0 : 1,
    little ? global & 255 : global >> 8, little ? global >> 8 : global & 255, fields.length];
  for (const [n, s, t] of fields) b.push(n, s, t);
  if (dev.length) { b.push(dev.length); for (const [n, s, i] of dev) b.push(n, s, i); }
  return b;
}

/** Data message: numbers are encoded to each field's size in the chosen endianness. */
function data(local, fields, values, { little = true, header, extra = [] } = {}) {
  const out = [header ?? (local & 0x0F)];
  fields.forEach(([, size], i) => {
    let n = BigInt.asUintN(size * 8, BigInt(values[i]));
    const bytes = [];
    for (let k = 0; k < size; k++) { bytes.push(Number(n & 255n)); n >>= 8n; }
    out.push(...(little ? bytes : bytes.reverse()));
  });
  return out.concat(extra);
}

/** Wrap a message body in a FIT file header (12 or 14 bytes) and a dummy CRC. */
function file(body, { headerSize = 14 } = {}) {
  const dv = new DataView(new ArrayBuffer(headerSize));
  dv.setUint8(0, headerSize);
  dv.setUint8(1, 0x10);
  dv.setUint16(2, 2000, true);
  dv.setUint32(4, body.length, true);
  new Uint8Array(dv.buffer).set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  return Uint8Array.from([...new Uint8Array(dv.buffer), ...body, 0, 0]);
}

const REC = [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [78, 4, 0x86], [3, 1, 0x02], [4, 1, 0x02], [7, 2, 0x84]];
const T0 = fitTs('2026-04-22T10:00:00Z');

test('decodes records: position, altitude, hr, cadence, power, time', () => {
  const body = [
    ...def(0, 20, REC),
    ...data(0, REC, [T0, semi(42.5), semi(-71.25), (100 + 500) * 5, 140, 80, 210]),
    ...data(0, REC, [T0 + 1, semi(42.5001), semi(-71.2501), (101 + 500) * 5, 141, 81, 215]),
  ];
  const pts = parseFit(file(body));
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0].lat - 42.5) < 1e-6);
  assert.ok(Math.abs(pts[0].lng - -71.25) < 1e-6);
  assert.equal(pts[0].ele, 100);
  assert.equal(pts[0].hr, 140);
  assert.equal(pts[0].cad, 80);
  assert.equal(pts[0].watts, 210);
  assert.equal(pts[0].time.toISOString(), '2026-04-22T10:00:00.000Z');
  assert.equal(pts[1].time.toISOString(), '2026-04-22T10:00:01.000Z');
});

test('big-endian definitions decode the same values (12-byte header)', () => {
  const body = [
    ...def(0, 20, REC, { little: false }),
    ...data(0, REC, [T0, semi(-33.9), semi(151.2), (20 + 500) * 5, 99, 70, 150], { little: false }),
  ];
  const [p] = parseFit(file(body, { headerSize: 12 }));
  assert.ok(Math.abs(p.lat - -33.9) < 1e-6);
  assert.ok(Math.abs(p.lng - 151.2) < 1e-6);
  assert.equal(p.ele, 20);
  assert.equal(p.watts, 150);
  assert.equal(p.time.toISOString(), '2026-04-22T10:00:00.000Z');
});

test('invalid sentinels become null and records without a fix are dropped', () => {
  const body = [
    ...def(0, 20, REC),
    // no position (0x7FFFFFFF), everything else valid: dropped from parseFit
    ...data(0, REC, [T0, 0x7FFFFFFF, 0x7FFFFFFF, 3000, 120, 70, 100]),
    // position ok, altitude/hr/cadence/power invalid
    ...data(0, REC, [T0 + 1, semi(10), semi(20), 0xFFFFFFFF, 0xFF, 0xFF, 0xFFFF]),
  ];
  const bytes = file(body);
  const pts = parseFit(bytes);
  assert.equal(pts.length, 1);
  assert.deepEqual([pts[0].ele, pts[0].hr, pts[0].cad, pts[0].watts], [null, null, null, null]);
  assert.equal(parseFitRecords(bytes).length, 2);
  assert.equal(parseFitRecords(bytes)[0].lat, null);
});

test('compressed-timestamp records reconstruct time from the 5-bit offset', () => {
  const small = [[0, 4, 0x85], [1, 4, 0x85]];
  const base = T0 - (T0 % 32); // multiple of 32 so offsets are easy to reason about
  const body = [
    ...def(0, 20, REC),
    ...def(1, 20, small),
    ...data(0, REC, [base + 30, semi(1), semi(2), 0xFFFFFFFF, 0xFF, 0xFF, 0xFFFF]),
    // compressed header: bit7 | local(1) << 5 | offset 2  -> rolls past the 32 s boundary
    ...data(1, small, [semi(1.001), semi(2.001)], { header: 0x80 | (1 << 5) | 2 }),
  ];
  const pts = parseFit(file(body));
  assert.equal(pts.length, 2);
  assert.equal((pts[1].time - pts[0].time) / 1000, 4); // 30 -> 34
});

test('developer fields are skipped by size', () => {
  const body = [
    ...def(0, 20, REC, { dev: [[0, 3, 0], [1, 2, 0]] }),
    ...data(0, REC, [T0, semi(1), semi(2), 3000, 100, 60, 90], { extra: [9, 9, 9, 8, 8] }),
    ...data(0, REC, [T0 + 1, semi(1.1), semi(2.1), 3000, 101, 61, 91], { extra: [7, 7, 7, 6, 6] }),
  ];
  const pts = parseFit(file(body));
  assert.equal(pts.length, 2);
  assert.equal(pts[1].hr, 101);
});

test('chained FIT files are concatenated', () => {
  const one = file([...def(0, 20, REC), ...data(0, REC, [T0, semi(5), semi(6), 3000, 100, 60, 90])]);
  const two = file([...def(0, 20, REC), ...data(0, REC, [T0 + 60, semi(7), semi(8), 3000, 100, 60, 90])]);
  const pts = parseFit(Uint8Array.from([...one, ...two]));
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[1].lat - 7) < 1e-6);
});

test('truncated and garbage input never throws', () => {
  const body = [
    ...def(0, 20, REC),
    ...data(0, REC, [T0, semi(1), semi(2), 3000, 100, 60, 90]),
    ...data(0, REC, [T0 + 1, semi(1), semi(2), 3000, 100, 60, 90]),
  ];
  const full = file(body);
  for (const cut of [0, 5, 14, 20, full.length - 12, full.length - 3]) {
    assert.doesNotThrow(() => parseFit(full.slice(0, cut)), `cut ${cut}`);
  }
  assert.equal(parseFit(full.slice(0, full.length - 12)).length, 1); // second record cut off
  assert.deepEqual(parseFit(new Uint8Array(0)), []);
  assert.deepEqual(parseFit(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), []);
  const noise = new Uint8Array(500).map((_, i) => (i * 37 + 11) & 255);
  assert.doesNotThrow(() => parseFit(noise));
});

test('session summary', () => {
  const SES = [[253, 4, 0x86], [2, 4, 0x86], [5, 1, 0x00], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86],
    [11, 2, 0x84], [16, 1, 0x02], [17, 1, 0x02], [22, 2, 0x84]];
  const body = [...def(0, 18, SES), ...data(0, SES, [T0 + 2000, T0, 1, 2_000_000, 1_900_000, 500_000, 321, 150, 180, 42])];
  const s = parseFitSummary(file(body));
  assert.equal(s.sport, 'running');
  assert.equal(s.total_distance_m, 5000);
  assert.equal(s.total_elapsed_s, 2000);
  assert.equal(s.total_timer_s, 1900);
  assert.equal(s.calories, 321);
  assert.equal(s.avg_hr, 150);
  assert.equal(s.max_hr, 180);
  assert.equal(s.total_ascent_m, 42);
  assert.equal(s.start.toISOString(), '2026-04-22T10:00:00.000Z');
  assert.equal(parseFitSummary(new Uint8Array(3)), null);
});

test('Strava ZIP: .fit.gz and .fit entries load routes through the lazy loader', async () => {
  const fit = file([
    ...def(0, 20, REC),
    ...data(0, REC, [T0, semi(42), semi(-71), 3000, 120, 70, 100]),
    ...data(0, REC, [T0 + 5, semi(42.001), semi(-71.001), 3000, 125, 71, 110]),
  ]);
  const rows = [
    stravaRow({ id: 1, date: 'Apr 22, 2026, 3:14:03 AM', filename: 'activities/a.fit.gz' }),
    stravaRow({ id: 2, date: 'Apr 23, 2026, 3:14:03 AM', filename: 'activities/b.fit' }),
  ];
  const zip = await makeZip({
    'activities.csv': csv(STRAVA_HEADERS, rows),
    'activities/a.fit.gz': gzipSync(Buffer.from(fit)),
    'activities/b.fit': Buffer.from(fit),
  });
  const acts = await parse(zip);
  assert.deepEqual(acts.map(a => a.has_route), [true, true]);
  for (const a of acts) {
    const pts = await a._gpxLoader();
    assert.equal(pts.length, 2, a.id);
    assert.equal(pts[1].hr, 125);
    assert.ok(pts[1].time instanceof Date);
  }
});
