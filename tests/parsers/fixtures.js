/**
 * Shared test plumbing: the two browser globals the parsers assume, plus
 * builders for small synthetic Strava / Apple / GPX fixtures. No real or
 * personal data lives in the repo — everything is generated here.
 *
 * Import this file first in every parser test.
 */
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

globalThis.JSZip = JSZip;
globalThis.DOMParser = new JSDOM('').window.DOMParser;

/** A Node Buffer with a .name, which the parsers accept in place of a File. */
export function namedBuffer(buf, name) {
  return Object.assign(Buffer.from(buf), { name });
}

/** Build a ZIP from { path: string | Buffer } and return it as a named Buffer. */
export async function makeZip(files, name = 'export.zip') {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return namedBuffer(buf, name);
}

export const gzip = (text) => gzipSync(Buffer.from(text, 'utf8'));

/** CSV text from a header array (duplicates allowed) and rows of cell arrays. */
export function csv(headers, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n';
}

/** GPX text. Each point: { lat, lon, ele, time, hr, cad, power } */
export function gpx(points) {
  const trkpts = points.map(p => {
    const ext = [];
    if (p.power !== undefined) ext.push(`<power>${p.power}</power>`);
    const tpx = [];
    if (p.hr !== undefined) tpx.push(`<gpxtpx:hr>${p.hr}</gpxtpx:hr>`);
    if (p.cad !== undefined) tpx.push(`<gpxtpx:cad>${p.cad}</gpxtpx:cad>`);
    if (tpx.length) ext.push(`<gpxtpx:TrackPointExtension>${tpx.join('')}</gpxtpx:TrackPointExtension>`);
    return `<trkpt lat="${p.lat}" lon="${p.lon}">` +
      (p.ele !== undefined ? `<ele>${p.ele}</ele>` : '') +
      (p.time ? `<time>${p.time}</time>` : '') +
      (ext.length ? `<extensions>${ext.join('')}</extensions>` : '') +
      '</trkpt>';
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><trkseg>
${trkpts}
</trkseg></trk></gpx>`;
}

/** A short, valid 3-point route. */
export const SAMPLE_GPX = gpx([
  { lat: 40.0, lon: -75.0, ele: 10, time: '2026-04-22T03:14:03Z', hr: 100, cad: 80, power: 150 },
  { lat: 40.001, lon: -75.0, ele: 12, time: '2026-04-22T03:15:03Z', hr: 110, cad: 82, power: 160 },
  { lat: 40.002, lon: -75.0, ele: 11, time: '2026-04-22T03:16:03Z', hr: 120, cad: 84, power: 170 },
]);

// Header modelled on a real Strava export: several column names appear twice
// (first copy km / short form, second copy metres / extended form).
export const STRAVA_HEADERS = [
  'Activity ID', 'Activity Date', 'Activity Name', 'Activity Type', 'Activity Description',
  'Elapsed Time', 'Distance', 'Max Heart Rate', 'Commute', 'Activity Gear', 'Filename',
  'Elapsed Time', 'Moving Time', 'Distance', 'Max Speed', 'Elevation Gain',
  'Max Heart Rate', 'Average Heart Rate', 'Average Cadence', 'Average Watts', 'Calories',
];

/** One row for STRAVA_HEADERS from a friendly object. */
export function stravaRow(o) {
  return [
    o.id ?? '', o.date, o.name ?? 'Test', o.type ?? 'Run', o.description ?? '',
    o.elapsed ?? 1800, o.km ?? 5, o.maxHr ?? '', '', o.gear ?? '', o.filename ?? '',
    o.elapsed ?? 1800, o.moving ?? '', o.meters ?? (o.km ?? 5) * 1000, o.maxSpeed ?? '', o.elev ?? '',
    o.maxHr ?? '', o.avgHr ?? '', o.cad ?? '', o.watts ?? '', o.calories ?? '',
  ];
}
