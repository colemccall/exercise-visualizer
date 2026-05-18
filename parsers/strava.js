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
 * Output conforms to the normalized Activity model:
 * {
 *   id, source, name, type, date, distance_m, duration_s,
 *   elevation_gain_m, avg_heart_rate, max_heart_rate,
 *   has_route, gpx_file, route_points
 * }
 */

import { parseGPX, computeDistance, computeElevationGain } from './gpx.js';

// ── Activity type mapping from Strava sport type strings ──────────────────────
const TYPE_MAP = {
  'Run':               'Run',
  'VirtualRun':        'Run',
  'TrailRun':          'Run',
  'Ride':              'Ride',
  'VirtualRide':       'Ride',
  'MountainBikeRide':  'Ride',
  'GravelRide':        'Ride',
  'EBikeRide':         'Ride',
  'Walk':              'Walk',
  'Hike':              'Hike',
  'Swim':              'Swim',
  'OpenWaterSwim':     'Swim',
};

function mapType(stravaType) {
  return TYPE_MAP[stravaType] || 'Other';
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
      if (!(h in obj)) {
        obj[h] = row[idx] !== undefined ? row[idx].trim() : '';
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
        // The zip may store files as "activities/xxxx.gpx" or "activities/xxxx.gpx.gz"
        const gpxEntry = findZipEntry(zip, gpxPath) ||
                         findZipEntry(zip, gpxPath + '.gz');

        if (gpxEntry && gpxPath.toLowerCase().endsWith('.gpx')) {
          activity.has_route = true;
          // Store the zip entry name so we can lazy-load it later
          activity.gpx_file = gpxEntry.name;
          // Attach a lazy-loader — called by the heatmap/route code
          activity._gpxLoader = async () => {
            const text = await gpxEntry.async('string');
            return parseGPX(text);
          };
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
    const csvText = await file.text();
    const records = parseCSV(csvText);

    for (const row of records) {
      const activity = rowToActivity(row);
      if (activity) activities.push(activity);
    }
  }

  // ── Case 3: Standalone GPX file ───────────────────────────────────────────
  else if (lowerName.endsWith('.gpx')) {
    const gpxText = await file.text();
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
function rowToActivity(row) {
  // Strava CSV columns (may vary by export date):
  // "Activity ID", "Activity Date", "Activity Name", "Activity Type",
  // "Elapsed Time", "Distance", "Commute", "Filename", ...
  const id = row['Activity ID'] || row['id'] || String(Math.random());
  const rawDate = row['Activity Date'] || row['date'] || '';
  const date = rawDate ? new Date(rawDate) : null;

  if (!date || isNaN(date.getTime())) return null;

  const name = row['Activity Name'] || row['name'] || 'Strava Activity';
  const type = mapType(row['Activity Type'] || row['type'] || '');

  // Distance: Strava's activities.csv first "Distance" column is in km.
  // Convert km → metres.
  const distKm = parseFloat(row['Distance'] || row['distance'] || '0');
  const distance_m = distKm * 1000;

  // Duration: "Elapsed Time" is in seconds
  const duration_s = parseDuration(row['Elapsed Time'] || row['elapsed_time'] || '0');

  // Elevation: "Elevation Gain" in metres
  const elevRaw = parseFloat(row['Elevation Gain'] || row['total_elevation_gain'] || '');
  const elevation_gain_m = isNaN(elevRaw) ? null : elevRaw;

  // Heart rate
  const avgHR = parseInt(row['Average Heart Rate'] || row['average_heartrate'] || '', 10);
  const maxHR = parseInt(row['Max Heart Rate'] || row['max_heartrate'] || '', 10);

  return {
    id: `strava-${id}`,
    source: 'strava',
    name,
    type,
    date,
    distance_m,
    duration_s,
    elevation_gain_m,
    avg_heart_rate: isNaN(avgHR) ? null : avgHR,
    max_heart_rate: isNaN(maxHR) ? null : maxHR,
    has_route: false,
    gpx_file: null,
    route_points: null,
    has_duplicate: false,
  };
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

  return {
    id: `strava-gpx-${date.getTime()}`,
    source: 'strava',
    name: filename.replace(/\.gpx$/i, '').replace(/_/g, ' '),
    type: 'Other',
    date,
    distance_m: dist,
    duration_s,
    elevation_gain_m: elev,
    avg_heart_rate: avg_hr,
    max_heart_rate: max_hr,
    has_route: true,
    gpx_file: filename,
    route_points: points,
    has_duplicate: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function findZipEntry(zip, path) {
  // Try exact match first, then case-insensitive
  if (zip.files[path]) return zip.files[path];
  const lower = path.toLowerCase();
  return Object.values(zip.files).find(f => f.name.toLowerCase() === lower) || null;
}
