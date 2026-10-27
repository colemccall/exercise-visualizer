import './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExifOffset } from '../../parsers/photos.js';

// exifr returns EXIF wall-clock time as a Date read in the machine's zone. Build
// such a Date from components, the way exifr does, so the test is zone-independent.
const wall = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);

test('a photo with an offset lands on the right instant whatever zone this machine is in', () => {
  const d = applyExifOffset(wall(2026, 4, 10, 7, 2), '+00:00');
  assert.equal(d.toISOString(), '2026-04-10T07:02:00.000Z');
  const east = applyExifOffset(wall(2026, 4, 10, 7, 2), '+05:30');
  assert.equal(east.toISOString(), '2026-04-10T01:32:00.000Z');
  const west = applyExifOffset(wall(2026, 4, 10, 7, 2), '-04:00');
  assert.equal(west.toISOString(), '2026-04-10T11:02:00.000Z');
});

test('accepts Z and colon-less offsets', () => {
  assert.equal(applyExifOffset(wall(2026, 1, 1, 12, 0), 'Z').toISOString(), '2026-01-01T12:00:00.000Z');
  assert.equal(applyExifOffset(wall(2026, 1, 1, 12, 0), '-0500').toISOString(), '2026-01-01T17:00:00.000Z');
});

test('without a usable offset the date is returned unchanged', () => {
  const d = wall(2026, 4, 10, 7, 2);
  assert.equal(applyExifOffset(d, null), d);
  assert.equal(applyExifOffset(d, 'garbage'), d);
  assert.ok(Number.isNaN(applyExifOffset(new Date('nope'), '+00:00').getTime()));
});
