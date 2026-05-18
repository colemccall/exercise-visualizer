/**
 * parsers/apple.js
 * Parse an Apple Health export (ZIP or XML) into Activity[].
 *
 * Apple Health export structure:
 *   apple_health_export/
 *     export.xml                — main XML with <Workout> elements
 *     workout-routes/           — GPX files for each workout with GPS
 *       route_YYYY-MM-DD_*.gpx
 *
 * The export.xml can be very large (100MB+), so we use a chunked string
 * scanning approach with regex to extract <Workout> elements without
 * loading the full DOM.
 *
 * HKWorkoutActivityType values are mapped to display names.
 */

import { parseGPX, computeDistance, computeElevationGain } from './gpx.js';

// ── Activity type mapping from HKWorkoutActivityType ─────────────────────────
const HK_TYPE_MAP = {
  'HKWorkoutActivityTypeRunning':          'Run',
  'HKWorkoutActivityTypeCycling':          'Ride',
  'HKWorkoutActivityTypeWalking':          'Walk',
  'HKWorkoutActivityTypeHiking':           'Hike',
  'HKWorkoutActivityTypeSwimming':         'Swim',
  'HKWorkoutActivityTypeSwimmingOpenWater':'Swim',
  'HKWorkoutActivityTypeCrossTraining':    'Other',
  'HKWorkoutActivityTypeElliptical':       'Other',
  'HKWorkoutActivityTypeStairClimbing':    'Other',
  'HKWorkoutActivityTypeYoga':             'Other',
  'HKWorkoutActivityTypeFunctionalStrengthTraining': 'Other',
  'HKWorkoutActivityTypeTraditionalStrengthTraining': 'Other',
  'HKWorkoutActivityTypeHighIntensityIntervalTraining': 'Other',
  'HKWorkoutActivityTypeMixedCardio':      'Other',
  'HKWorkoutActivityTypePilates':          'Other',
  'HKWorkoutActivityTypeBarre':            'Other',
  'HKWorkoutActivityTypeDance':            'Other',
  'HKWorkoutActivityTypeSoccer':           'Other',
  'HKWorkoutActivityTypeBasketball':       'Other',
  'HKWorkoutActivityTypeTennis':           'Other',
  'HKWorkoutActivityTypeSkatingSports':    'Other',
  'HKWorkoutActivityTypeSnowSports':       'Other',
};

function mapHKType(hkType) {
  return HK_TYPE_MAP[hkType] || 'Other';
}

// ── Unit conversions ──────────────────────────────────────────────────────────
// Apple stores distances in various units, most commonly "km" or "mi"
function toMetres(value, unit) {
  if (!unit) return value;
  const u = unit.toLowerCase();
  if (u === 'km') return value * 1000;
  if (u === 'mi' || u === 'mile') return value * 1609.344;
  if (u === 'm')  return value;
  return value; // assume metres
}

// ── Chunked XML extraction ────────────────────────────────────────────────────
/**
 * Extract all <Workout> element strings from potentially huge XML text
 * using a simple chunk-based regex scan.
 *
 * Strategy: scan the text for "<Workout " ... "</Workout>" pairs.
 * We process in 1MB chunks with overlap to avoid splitting across tags.
 *
 * @param {string} xmlText
 * @returns {string[]}  Raw XML strings for each <Workout> element
 */
function extractWorkoutStrings(xmlText) {
  const workouts = [];
  // Use a global regex that finds complete Workout blocks
  // Apple workouts don't nest, so this is safe.
  const regex = /<Workout\b[^>]*>[\s\S]*?<\/Workout>/g;
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    workouts.push(match[0]);
  }
  return workouts;
}

// ── Parse a single <Workout> XML string ──────────────────────────────────────
/**
 * Parse a raw <Workout> XML block into an Activity object.
 * Uses regex to extract attributes since we don't have the full DOM context.
 *
 * @param {string} workoutXml
 * @param {number} index  Used for ID generation
 * @returns {Activity|null}
 */
function parseWorkoutXml(workoutXml, index) {
  // Extract attributes from the opening tag
  const attr = (name) => {
    const match = workoutXml.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? match[1] : null;
  };

  const hkType   = attr('workoutActivityType');
  const startStr = attr('startDate');
  const endStr   = attr('endDate');
  const duration = parseFloat(attr('duration') || '0');
  const durUnit  = attr('durationUnit') || 'min';

  // Distance is in a child WorkoutStatistics element, not a direct attribute.
  const distMatch = workoutXml.match(/WorkoutStatistics\b[^>]*type="HKQuantityTypeIdentifierDistance[^"]*"[^>]*sum="([^"]*)"[^>]*unit="([^"]*)"/);
  const distVal  = distMatch ? parseFloat(distMatch[1]) : 0;
  const distUnit = distMatch ? distMatch[2] : null;

  if (!startStr) return null;

  const date = new Date(startStr);
  if (isNaN(date.getTime())) return null;

  // Duration: Apple stores in minutes by default
  let duration_s = duration;
  if (durUnit === 'min') duration_s = duration * 60;
  else if (durUnit === 'hr') duration_s = duration * 3600;

  // Distance
  const distance_m = isNaN(distVal) ? 0 : toMetres(distVal, distUnit);

  // Heart rate — look for WorkoutStatistics with type Average/Max HR
  const avgHRMatch = workoutXml.match(/HKQuantityTypeIdentifierHeartRate"[^>]*average="([^"]*)"/);
  const maxHRMatch = workoutXml.match(/HKQuantityTypeIdentifierHeartRate"[^>]*maximum="([^"]*)"/);
  const avg_heart_rate = avgHRMatch ? Math.round(parseFloat(avgHRMatch[1])) : null;
  const max_heart_rate = maxHRMatch ? Math.round(parseFloat(maxHRMatch[1])) : null;

  // Elevation gain — stored as MetadataEntry with key "HKElevationAscended",
  // value format is "<number> <unit>" e.g. "11351 cm" or "113.51 m".
  const elevMatch = workoutXml.match(/key="HKElevationAscended"\s+value="([^"]*)"/);
  let elevation_gain_m = null;
  if (elevMatch) {
    const parts = elevMatch[1].trim().split(/\s+/);
    const elevVal = parseFloat(parts[0]);
    const elevUnit = (parts[1] || 'm').toLowerCase();
    if (!isNaN(elevVal)) {
      elevation_gain_m = elevUnit === 'cm' ? elevVal / 100 : elevVal;
    }
  }

  // Route file reference — inside <WorkoutRoute> as <FileReference path="..."/>
  const routeFileMatch = workoutXml.match(/<FileReference\b[^>]*path="([^"]*)"/);
  const gpx_file = routeFileMatch ? routeFileMatch[1] : null;

  const type = mapHKType(hkType || '');
  const name = `${type} — ${date.toLocaleDateString()}`;

  return {
    id: `apple-${date.getTime()}-${index}`,
    source: 'apple',
    name,
    type,
    date,
    distance_m,
    duration_s: Math.round(duration_s),
    elevation_gain_m: elevation_gain_m && !isNaN(elevation_gain_m) ? elevation_gain_m : null,
    avg_heart_rate: avg_heart_rate && !isNaN(avg_heart_rate) ? avg_heart_rate : null,
    max_heart_rate: max_heart_rate && !isNaN(max_heart_rate) ? max_heart_rate : null,
    has_route: !!gpx_file,
    gpx_file,
    route_points: null,
    has_duplicate: false,
    _rawGpxPath: gpx_file, // kept for zip resolution
  };
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse an Apple Health export into Activity[].
 * @param {File} file   A .zip or .xml File object
 * @param {Function} onProgress  (pct: number, label: string) => void
 * @returns {Promise<Activity[]>}
 */
export async function parse(file, onProgress = () => {}) {
  const activities = [];

  onProgress(5, 'Reading Apple Health export…');

  const lowerName = file.name.toLowerCase();

  // ── Case 1: ZIP archive ───────────────────────────────────────────────────
  if (lowerName.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);

    // Find the main export.xml — exclude the CDA variant which has no Workout elements
    const xmlEntry = Object.values(zip.files).find(f =>
      !f.dir &&
      f.name.toLowerCase().endsWith('export.xml') &&
      !f.name.toLowerCase().includes('cda')
    );

    if (!xmlEntry) {
      console.warn('Apple Health ZIP: no export.xml found');
      onProgress(100, 'No export.xml found in ZIP');
      return activities;
    }

    onProgress(15, 'Reading export.xml (may be large)…');
    const xmlText = await xmlEntry.async('string');

    onProgress(30, 'Scanning for workouts…');
    const workoutStrings = extractWorkoutStrings(xmlText);

    onProgress(40, `Found ${workoutStrings.length} workouts, parsing…`);

    for (let i = 0; i < workoutStrings.length; i++) {
      const activity = parseWorkoutXml(workoutStrings[i], i);
      if (!activity) continue;

      // Attempt to attach a GPX loader if a route file path was found
      if (activity._rawGpxPath) {
        const gpxEntry = findGpxEntry(zip, activity._rawGpxPath);
        if (gpxEntry) {
          activity.has_route = true;
          activity.gpx_file = gpxEntry.name;
          activity._gpxLoader = async () => {
            const text = await gpxEntry.async('string');
            return parseGPX(text);
          };
        }
      }

      // Also try matching by date if no explicit path found
      if (!activity.has_route) {
        const dateStr = activity.date.toISOString().slice(0, 10); // YYYY-MM-DD
        const routeEntry = Object.values(zip.files).find(f =>
          !f.dir &&
          f.name.toLowerCase().endsWith('.gpx') &&
          f.name.includes('workout-routes') &&
          f.name.includes(dateStr)
        );
        if (routeEntry) {
          activity.has_route = true;
          activity.gpx_file = routeEntry.name;
          activity._gpxLoader = async () => {
            const text = await routeEntry.async('string');
            return parseGPX(text);
          };
        }
      }

      activities.push(activity);

      if (i % 100 === 0) {
        onProgress(40 + Math.round((i / workoutStrings.length) * 55), `Parsed ${i} / ${workoutStrings.length} workouts…`);
      }
    }
  }

  // ── Case 2: Plain XML file ────────────────────────────────────────────────
  else if (lowerName.endsWith('.xml')) {
    onProgress(20, 'Reading XML…');
    const xmlText = await file.text();

    onProgress(35, 'Scanning for workouts…');
    const workoutStrings = extractWorkoutStrings(xmlText);

    for (let i = 0; i < workoutStrings.length; i++) {
      const activity = parseWorkoutXml(workoutStrings[i], i);
      if (activity) activities.push(activity);
    }
  }

  onProgress(100, `Loaded ${activities.length} Apple Health activities`);
  return activities;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function findGpxEntry(zip, rawPath) {
  // rawPath from Apple may be an absolute path like
  // "/var/mobile/.../workout-routes/route_2023-01-01_12.00.00.gpx"
  // We match on the basename.
  const basename = rawPath.split('/').pop().toLowerCase();
  return Object.values(zip.files).find(f =>
    !f.dir && f.name.toLowerCase().endsWith(basename)
  ) || null;
}
