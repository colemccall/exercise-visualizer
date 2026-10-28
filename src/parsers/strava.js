/**
 * parsers/strava.js
 * Parse a Strava data export (ZIP file or loose files) into Activity[].
 *
 * Strava export structure:
 *   activities.csv          — main activity log
 *   activities/             — folder of GPX/FIT files referenced by CSV "Filename" column
 *
 * Supported inputs (passed as JSZip object or File array):
 *   - A .zip file → extracted with JSZip
 *   - A bare activities.csv file (no GPX route data)
 *
 * Routes: `.gpx`, `.gpx.gz`, `.fit` and `.fit.gz` entries all load (FIT via
 * parsers/fit.js); TCX is not decoded.
 *
 * Output conforms to the normalized Activity model (see parsers/model.js).
 */

import { parseGPX, computeDistance, computeElevationGain, readText, loadGpxEntry, gunzipToBytes } from './gpx.js';
import { parseFit } from './fit.js';
import { createActivity, humanize } from './model.js';

// ── Activity type mapping from Strava sport type strings ──────────────────────
// Keys are normalized (lowercase, letters/digits only) so "VirtualRide" (API
// style) and "Virtual Ride" (what activities.csv actually writes) both match.
const TYPE_MAP = {
  'run':               'Run',
  'virtualrun':        'Run',
  'trailrun':          'Run',
  'ride':              'Ride',
  'virtualride':       'Ride',
  'mountainbikeride':  'Ride',
  'emountainbikeride': 'Ride',
  'gravelride':        'Ride',
  'ebikeride':         'Ride',
  'walk':              'Walk',
  'hike':              'Hike',
  'swim':              'Swim',
  'openwaterswim':     'Swim',
};

function normalizeTypeKey(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapType(stravaType) {
  return TYPE_MAP[normalizeTypeKey(stravaType)] || 'Other';
}

// ── Duration parsing ──────────────────────────────────────────────────────────
// Strava exports duration as "H:MM:SS", "M:SS", plain seconds, or decimal seconds.
function parseDuration(str) {
  if (!str) return 0;
  str = str.trim();
  // Plain integer or decimal seconds (e.g. "3452" or "3452.0")
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str));
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// ── Date parsing ──────────────────────────────────────────────────────────────
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse Strava's "Activity Date" column.
 *
 * Strava writes this as "Apr 22, 2026, 3:14:03 AM" with **no timezone marker**,
 * and the value is UTC — verified against the Z-suffixed <time> of the first
 * trackpoint in the matching GPX, which agrees to the second. Handing that
 * string to `new Date()` makes the engine read it as *local* time, shifting
 * every activity by the viewer's UTC offset — enough to push late-evening
 * workouts onto the next day and to break cross-source dedup, which only
 * pairs activities within 10 minutes of each other.
 *
 * @param {string} raw
 * @returns {Date|null}
 */
function parseStravaDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();

  const m = str.match(
    /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP])\.?M\.?)?$/i
  );
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      let hour = parseInt(m[4], 10);
      const meridiem = m[7] ? m[7].toUpperCase() : null;
      if (meridiem === 'A' && hour === 12) hour = 0;
      else if (meridiem === 'P' && hour < 12) hour += 12;
      return new Date(Date.UTC(
        parseInt(m[3], 10), month, parseInt(m[2], 10),
        hour, parseInt(m[5], 10), parseInt(m[6], 10)
      ));
    }
  }

  // Anything else (ISO 8601, explicit "UTC" suffix, older export formats) already
  // carries its own zone information — let the engine handle it.
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ── CSV parsing (no external library) ────────────────────────────────────────
/**
 * Parse CSV text into an array of objects keyed by the header row.
 * Handles quoted fields with embedded commas and newlines.
 * @param {string} text
 * @returns {Object[]}
 */
function parseCSV(text) {
  const lines = [];
  let field = '';
  let inQuotes = false;
  let currentRow = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // Escaped double-quote inside quoted field
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(field);
        field = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(field);
        field = '';
        lines.push(currentRow);
        currentRow = [];
        i++; // skip \n
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(field);
        field = '';
        lines.push(currentRow);
        currentRow = [];
      } else {
        field += ch;
      }
    }
  }
  // Flush last row
  if (field || currentRow.length > 0) {
    currentRow.push(field);
    lines.push(currentRow);
  }

  if (lines.length < 2) return [];

  const headers = lines[0].map(h => h.trim());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 1 && row[0] === '') continue; // skip empty rows
    const obj = {};
    headers.forEach((h, idx) => {
      // First occurrence wins — Strava's extended export duplicates column names
      // (e.g. two "Distance" columns: first is km, second is metres in extended format).
      // Later copies stay reachable as "Distance#2", "Distance#3", …
      const value = row[idx] !== undefined ? row[idx].trim() : '';
      if (!(h in obj)) {
        obj[h] = value;
      } else {
        let n = 2;
        while (`${h}#${n}` in obj) n++;
        obj[`${h}#${n}`] = value;
      }
    });
    records.push(obj);
  }

  return records;
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse a Strava export into Activity[].
 * @param {File} file   A .zip, .csv, or .gpx File object
 * @param {Function} onProgress  (pct: number, label: string) => void
 * @returns {Promise<Activity[]>}
 */
export async function parse(file, onProgress = () => {}) {
  const activities = [];

  onProgress(5, 'Reading Strava export…');

  const lowerName = file.name.toLowerCase();

  // ── Case 1: ZIP archive ───────────────────────────────────────────────────
  if (lowerName.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);

    // Find activities.csv inside the zip
    const csvEntry = Object.values(zip.files).find(f =>
      !f.dir && f.name.toLowerCase().endsWith('activities.csv')
    );

    if (!csvEntry) {
      console.warn('Strava ZIP: no activities.csv found');
      onProgress(100, 'No activities.csv found in ZIP');
      return activities;
    }

    onProgress(15, 'Parsing activities.csv…');
    const csvText = await csvEntry.async('string');
    const records = parseCSV(csvText);

    onProgress(30, `Found ${records.length} activities…`);

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const activity = rowToActivity(row);
      if (!activity) continue;

      // Check for a matching GPX file inside the zip
      if (row['Filename']) {
        const gpxPath = row['Filename'];
        // The zip may store files as "activities/xxxx.gpx" or "activities/xxxx.gpx.gz".
        // Most of a modern export is "activities/xxxx.fit.gz", decoded by parsers/fit.js.
        const gpxEntry = findZipEntry(zip, gpxPath) ||
                         findZipEntry(zip, gpxPath + '.gz');

        if (gpxEntry && /\.fit(\.gz)?$/i.test(gpxEntry.name)) {
          activity.has_route = true;
          activity.gpx_file = gpxEntry.name;
          activity._gpxLoader = () => loadFitEntry(gpxEntry);
        } else if (gpxEntry && /\.gpx(\.gz)?$/i.test(gpxEntry.name)) {
          activity.has_route = true;
          // Store the zip entry name so we can lazy-load it later
          activity.gpx_file = gpxEntry.name;
          // Attach a lazy-loader — called by the heatmap/route code.
          // loadGpxEntry gunzips .gpx.gz entries.
          activity._gpxLoader = () => loadGpxEntry(gpxEntry);
        }
      }

      activities.push(activity);

      // Report progress as we process rows
      if (i % 50 === 0) {
        onProgress(30 + Math.round((i / records.length) * 60), `Processed ${i} / ${records.length} activities…`);
      }
    }
  }

  // ── Case 2: Plain CSV file ────────────────────────────────────────────────
  else if (lowerName.endsWith('.csv')) {
    const csvText = await readText(file);
    const records = parseCSV(csvText);

    for (const row of records) {
      const activity = rowToActivity(row);
      if (activity) activities.push(activity);
    }
  }

  // ── Case 3: Standalone GPX file ───────────────────────────────────────────
  else if (lowerName.endsWith('.gpx')) {
    const gpxText = await readText(file);
    const points = parseGPX(gpxText);

    if (points.length > 0) {
      const activity = gpxToActivity(points, file.name);
      activities.push(activity);
    }
  }

  onProgress(100, `Loaded ${activities.length} Strava activities`);
  return activities;
}

// ── Convert a CSV row to an Activity object ───────────────────────────────────
// Parse a numeric CSV cell: blank / non-numeric → null.
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Sensor/energy columns use 0 for "not recorded" — treat that as missing.
function positive(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

// Small stable string hash, for ids when a row has no Activity ID.
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function rowToActivity(row) {
  // Strava CSV columns (may vary by export date):
  // "Activity ID", "Activity Date", "Activity Name", "Activity Type",
  // "Elapsed Time", "Moving Time", "Distance", "Calories", "Average Cadence",
  // "Average Watts", "Max Speed", "Activity Gear", "Commute", "Filename", ...
  const rawDate = row['Activity Date'] || row['date'] || '';
  const date = parseStravaDate(rawDate);

  if (!date) return null;

  const name = row['Activity Name'] || row['name'] || 'Strava Activity';
  // No Activity ID: derive one from the row itself so re-imports get the same id.
  const id = row['Activity ID'] || row['id'] || `${date.getTime()}-${hashString(name)}`;
  const rawType = row['Activity Type'] || row['type'] || '';
  const type = mapType(rawType);

  // Distance: Strava's activities.csv first "Distance" column is in km.
  // The extended export repeats it in metres (second column, more precise) —
  // use that when it agrees with the km value, else convert km → metres.
  const distKm = parseFloat(row['Distance'] || row['distance'] || '0') || 0;
  let distance_m = distKm * 1000;
  const distM = num(row['Distance#2']);
  if (distM !== null && distM > 0 && Math.abs(distM - distance_m) <= Math.max(50, distance_m * 0.05)) {
    distance_m = distM;
  }

  // Duration: "Elapsed Time" is in seconds; "Moving Time" excludes pauses.
  const duration_s = parseDuration(row['Elapsed Time'] || row['elapsed_time'] || '0');
  const moving = num(row['Moving Time'] ?? row['moving_time']);

  // Elevation: "Elevation Gain" in metres
  const elevRaw = parseFloat(row['Elevation Gain'] || row['total_elevation_gain'] || '');
  const elevation_gain_m = isNaN(elevRaw) ? null : elevRaw;

  // Heart rate (cells can be "115.0")
  const avgHR = Math.round(parseFloat(row['Average Heart Rate'] || row['average_heartrate'] || ''));
  const maxHR = Math.round(parseFloat(row['Max Heart Rate'] || row['max_heartrate'] || ''));

  // Weather (only present on some rows): temperature °C, humidity as a 0-1 fraction,
  // wind m/s. "Weather Condition" is an opaque numeric code in the export, so it is
  // deliberately not interpreted.
  const temp = num(row['Weather Temperature']);
  const weather = temp === null ? null : {
    temp_c: temp,
    feels_c: num(row['Apparent Temperature']),
    humidity_pct: num(row['Humidity']) === null ? null : Math.round(num(row['Humidity']) * 100),
    wind_mps: num(row['Wind Speed']),
  };

  return createActivity({
    id: `strava-${id}`,
    source: 'strava',
    name,
    type,
    sub_type: humanize(rawType) || type,
    date,
    distance_m,
    duration_s,
    moving_s: moving !== null && moving > 0 ? Math.round(moving) : null,
    elevation_gain_m,
    avg_heart_rate: isNaN(avgHR) ? null : avgHR,
    max_heart_rate: isNaN(maxHR) ? null : maxHR,
    calories_kcal: positive(row['Calories'] ?? row['calories']),
    avg_cadence: positive(row['Average Cadence']),
    avg_watts: positive(row['Average Watts']),
    max_speed_mps: positive(row['Max Speed']),
    gear: row['Activity Gear'] || row['Gear'] || row['Bike'] || null,
    description: row['Activity Description'] || null,
    // The export repeats some columns; the first copy is the short form, so prefer it.
    relative_effort: positive(row['Relative Effort']) ?? positive(row['Relative Effort#2']),
    elevation_loss_m: positive(row['Elevation Loss']),
    steps: positive(row['Total Steps']),
    avg_speed_mps: positive(row['Average Speed']),
    weather,
  });
}

// ── Convert GPX points to a minimal Activity (standalone GPX upload) ─────────
function gpxToActivity(points, filename) {
  const date = points[0]?.time || new Date();
  const dist = computeDistance(points);
  const elev = computeElevationGain(points);

  // Derive duration from first/last timestamp
  const firstTime = points.find(p => p.time)?.time;
  const lastTime = [...points].reverse().find(p => p.time)?.time;
  const duration_s = firstTime && lastTime
    ? Math.round((lastTime - firstTime) / 1000)
    : 0;

  const hrs = points.map(p => p.hr).filter(h => h !== null);
  const avg_hr = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
  const max_hr = hrs.length ? Math.max(...hrs) : null;

  const mean = (vals) => vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  const cads = points.map(p => p.cad).filter(c => c !== null && c !== undefined);
  const watts = points.map(p => p.watts).filter(w => w !== null && w !== undefined);

  return createActivity({
    id: `strava-gpx-${date.getTime()}`,
    source: 'strava',
    name: filename.replace(/\.gpx$/i, '').replace(/_/g, ' '),
    type: 'Other',
    sub_type: 'GPX track',
    date,
    distance_m: dist,
    duration_s,
    moving_s: duration_s || null,
    elevation_gain_m: elev,
    avg_heart_rate: avg_hr,
    max_heart_rate: max_hr,
    avg_cadence: mean(cads),
    avg_watts: mean(watts),
    has_route: true,
    gpx_file: filename,
    route_points: points,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Read a .fit or .fit.gz zip entry (sniffed by gzip magic bytes) into trackpoints. */
async function loadFitEntry(zipEntry) {
  let bytes = await zipEntry.async('uint8array');
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzipToBytes(bytes);
  return parseFit(bytes);
}

function findZipEntry(zip, path) {
  // Try exact match first, then case-insensitive
  if (zip.files[path]) return zip.files[path];
  const lower = path.toLowerCase();
  return Object.values(zip.files).find(f => f.name.toLowerCase() === lower) || null;
}
