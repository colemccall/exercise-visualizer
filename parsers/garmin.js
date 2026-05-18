/**
 * parsers/garmin.js
 * Parse a Garmin Connect export (ZIP or JSON) into Activity[].
 *
 * Garmin export structure (varies by export type):
 *   DI_CONNECT/
 *     DI-Connect-Fitness/
 *       summarizedActivities.json     — array of activity summaries
 *     DI-Connect-Fitness-Extras/
 *       <activityId>_ACTIVITY.json    — individual activity details (optional)
 *   Activities/
 *     <activityId>.gpx                — GPX route files
 *     <activityId>.fit                — FIT files (skipped)
 *
 * We only process JSON and GPX. FIT files are skipped entirely.
 */

import { parseGPX, computeDistance, computeElevationGain } from './gpx.js';

// ── Activity type mapping from Garmin activity type strings ───────────────────
const GARMIN_TYPE_MAP = {
  'running':               'Run',
  'trail_running':         'Run',
  'treadmill_running':     'Run',
  'virtual_run':           'Run',
  'cycling':               'Ride',
  'mountain_biking':       'Ride',
  'road_biking':           'Ride',
  'gravel_cycling':        'Ride',
  'indoor_cycling':        'Ride',
  'virtual_ride':          'Ride',
  'walking':               'Walk',
  'casual_walking':        'Walk',
  'speed_walking':         'Walk',
  'hiking':                'Hike',
  'swimming':              'Swim',
  'open_water_swimming':   'Swim',
  'lap_swimming':          'Swim',
  'other':                 'Other',
  'strength_training':     'Other',
  'yoga':                  'Other',
  'cardio':                'Other',
  'elliptical':            'Other',
  'stair_stepping':        'Other',
  'floor_climbing':        'Other',
  'indoor_rowing':         'Other',
};

function mapGarminType(typeStr) {
  if (!typeStr) return 'Other';
  return GARMIN_TYPE_MAP[typeStr.toLowerCase()] || 'Other';
}

// ── Parse a single activity summary object ────────────────────────────────────
/**
 * Convert a Garmin JSON activity record to a normalized Activity.
 *
 * Garmin summarizedActivities.json fields vary, but common ones include:
 *   activityId, activityName, startTimeLocal, activityType.typeKey,
 *   distance (metres), duration (seconds), elevationGain (metres),
 *   averageHR, maxHR
 *
 * @param {Object} record
 * @returns {Activity|null}
 */
function recordToActivity(record) {
  // Garmin can wrap in a nested "summarizedActivitiesExport" array
  // or the record is directly the activity object.
  const id = record.activityId || record.activity_id || String(Math.random());

  // Dates: try startTimeLocal (local ISO), then startTimeGMT
  const rawDate = record.startTimeLocal || record.startTimeGMT || record.start_time || '';
  const date = rawDate ? new Date(rawDate.replace(' ', 'T')) : null;
  if (!date || isNaN(date.getTime())) return null;

  const name = record.activityName || record.name || 'Garmin Activity';

  // Activity type: nested object or flat string
  const typeKey = record.activityType?.typeKey ||
                  record.activityType?.key ||
                  record.activityTypeDTO?.typeKey ||
                  record.sport ||
                  record.activityType ||
                  '';
  const type = mapGarminType(typeKey);

  // Distance in metres (Garmin usually stores in metres, but sometimes cm)
  let distance_m = parseFloat(record.distance || record.distanceInMeters || 0);
  // Sanity check: if value looks like centimetres, convert
  if (distance_m > 1000000) distance_m = distance_m / 100;

  // Duration in seconds
  const duration_s = Math.round(parseFloat(
    record.duration || record.elapsedDuration || record.movingDuration || 0
  ));

  // Elevation gain in metres
  const elevRaw = parseFloat(record.elevationGain || record.totalElevationGain || '');
  const elevation_gain_m = isNaN(elevRaw) ? null : elevRaw;

  // Heart rate
  const avgHR = parseInt(record.averageHR || record.avgHr || '', 10);
  const maxHR = parseInt(record.maxHR || record.maxHr || '', 10);

  return {
    id: `garmin-${id}`,
    source: 'garmin',
    name,
    type,
    date,
    distance_m,
    duration_s,
    elevation_gain_m,
    avg_heart_rate: isNaN(avgHR) || avgHR === 0 ? null : avgHR,
    max_heart_rate: isNaN(maxHR) || maxHR === 0 ? null : maxHR,
    has_route: false,
    gpx_file: null,
    route_points: null,
    has_duplicate: false,
    _activityId: String(id),
  };
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse a Garmin Connect export into Activity[].
 * @param {File} file   A .zip, .json, or .gpx File object
 * @param {Function} onProgress  (pct: number, label: string) => void
 * @returns {Promise<Activity[]>}
 */
export async function parse(file, onProgress = () => {}) {
  const activities = [];

  onProgress(5, 'Reading Garmin export…');

  const lowerName = file.name.toLowerCase();

  // ── Case 1: ZIP archive ───────────────────────────────────────────────────
  if (lowerName.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);

    onProgress(15, 'Scanning ZIP contents…');

    // Find summarizedActivities.json or similar
    const summaryEntry = findJsonSummary(zip);

    if (summaryEntry) {
      onProgress(20, 'Parsing activity summaries…');
      const jsonText = await summaryEntry.async('string');
      let records = [];

      try {
        const parsed = JSON.parse(jsonText);
        // Handle wrapped format: { summarizedActivitiesExport: [...] }
        if (Array.isArray(parsed)) {
          records = parsed;
        } else if (parsed.summarizedActivitiesExport) {
          records = parsed.summarizedActivitiesExport;
        } else if (parsed.activityList) {
          records = parsed.activityList;
        } else {
          // Might be a single activity
          records = [parsed];
        }
      } catch (e) {
        console.warn('Garmin: failed to parse JSON summary', e);
      }

      onProgress(30, `Found ${records.length} activities…`);

      // Build a map of activityId → GPX zip entry for fast lookup
      const gpxMap = buildGpxMap(zip);

      for (let i = 0; i < records.length; i++) {
        const activity = recordToActivity(records[i]);
        if (!activity) continue;

        // Attach GPX loader if a matching file exists
        const gpxEntry = gpxMap.get(activity._activityId);
        if (gpxEntry) {
          activity.has_route = true;
          activity.gpx_file = gpxEntry.name;
          activity._gpxLoader = async () => {
            const text = await gpxEntry.async('string');
            return parseGPX(text);
          };
        }

        activities.push(activity);

        if (i % 50 === 0) {
          onProgress(30 + Math.round((i / records.length) * 60), `Processed ${i} / ${records.length} activities…`);
        }
      }
    } else {
      // No summary JSON — try to parse individual activity JSON files
      onProgress(25, 'Looking for individual activity files…');
      const jsonEntries = Object.values(zip.files).filter(f =>
        !f.dir &&
        f.name.toLowerCase().endsWith('.json') &&
        f.name.toLowerCase().includes('activity')
      );

      const gpxMap = buildGpxMap(zip);

      for (let i = 0; i < jsonEntries.length; i++) {
        try {
          const text = await jsonEntries[i].async('string');
          const parsed = JSON.parse(text);
          // Individual files may have an "activityDTO" wrapper
          const record = parsed.activityDTO || parsed.activity || parsed;
          const activity = recordToActivity(record);
          if (!activity) continue;

          const gpxEntry = gpxMap.get(activity._activityId);
          if (gpxEntry) {
            activity.has_route = true;
            activity.gpx_file = gpxEntry.name;
            activity._gpxLoader = async () => {
              const text = await gpxEntry.async('string');
              return parseGPX(text);
            };
          }

          activities.push(activity);
        } catch (e) {
          // skip malformed files
        }

        if (i % 20 === 0) {
          onProgress(25 + Math.round((i / jsonEntries.length) * 65), `Parsed ${i} / ${jsonEntries.length} files…`);
        }
      }
    }
  }

  // ── Case 2: Plain JSON file ───────────────────────────────────────────────
  else if (lowerName.endsWith('.json')) {
    const jsonText = await file.text();
    let records = [];

    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) {
        records = parsed;
      } else if (parsed.summarizedActivitiesExport) {
        records = parsed.summarizedActivitiesExport;
      } else {
        records = [parsed];
      }
    } catch (e) {
      console.warn('Garmin: failed to parse JSON', e);
    }

    for (const record of records) {
      const activity = recordToActivity(record);
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

  onProgress(100, `Loaded ${activities.length} Garmin activities`);
  return activities;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the summarizedActivities JSON inside a Garmin ZIP.
 * Garmin stores it in several possible paths depending on export version.
 */
function findJsonSummary(zip) {
  const candidates = [
    'summarizedActivities.json',
    'DI_CONNECT/DI-Connect-Fitness/summarizedActivities.json',
    'DI_CONNECT/DI-Connect-Fitness-Extras/summarizedActivities.json',
  ];

  for (const c of candidates) {
    if (zip.files[c]) return zip.files[c];
  }

  // Fuzzy match
  return Object.values(zip.files).find(f =>
    !f.dir &&
    f.name.toLowerCase().includes('summarizedactivities') &&
    f.name.toLowerCase().endsWith('.json')
  ) || null;
}

/**
 * Build a Map from activityId string → JSZip file entry for all GPX files
 * in the ZIP. Garmin names GPX files as "<activityId>.gpx" or
 * "<activityId>_ACTIVITY.gpx".
 */
function buildGpxMap(zip) {
  const map = new Map();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const name = entry.name;
    if (!name.toLowerCase().endsWith('.gpx')) continue;

    // Extract the activity ID from the filename (leading digits)
    const basename = name.split('/').pop();
    const idMatch = basename.match(/^(\d+)/);
    if (idMatch) {
      map.set(idMatch[1], entry);
    }
  }
  return map;
}

/**
 * Convert GPX points to a minimal Activity (standalone GPX upload).
 */
function gpxToActivity(points, filename) {
  const date = points[0]?.time || new Date();
  const dist = computeDistance(points);
  const elev = computeElevationGain(points);

  const firstTime = points.find(p => p.time)?.time;
  const lastTime  = [...points].reverse().find(p => p.time)?.time;
  const duration_s = firstTime && lastTime
    ? Math.round((lastTime - firstTime) / 1000)
    : 0;

  const hrs = points.map(p => p.hr).filter(h => h !== null);
  const avg_hr = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
  const max_hr = hrs.length ? Math.max(...hrs) : null;

  return {
    id: `garmin-gpx-${date.getTime()}`,
    source: 'garmin',
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
