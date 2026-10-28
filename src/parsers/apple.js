/**
 * parsers/apple.js
 * Parse an Apple Health export (ZIP or XML) into Activity[] plus the daily
 * Activity Ring summaries.
 *
 * Apple Health export structure:
 *   apple_health_export/
 *     export.xml                — main XML with <Workout> and <ActivitySummary>
 *     workout-routes/           — GPX files for each workout with GPS
 *       route_YYYY-MM-DD_*.gpx
 *
 * The export.xml can be very large (100MB–1GB+), so we stream it and use
 * string scanning with regex to pull out <Workout> blocks and the
 * self-closing <ActivitySummary/> tags without building a DOM or ever holding
 * the whole decompressed text in one string.
 *
 * HKWorkoutActivityType values are mapped to display names; anything that
 * isn't one of the five core types becomes type 'Other' with the original
 * label preserved in `sub_type` ("Yoga", "Rowing", …).
 *
 * Note: an Apple export also contains workouts that other apps (including
 * Strava) wrote into Health. Those arrive as source 'apple' with
 * `device` = "Strava"; the cross-source dedup in core/dedup.js pairs them
 * with the real Strava CSV row.
 */

import { loadGpxEntry } from './gpx.js';
import { createActivity, humanize } from './model.js';

// ── Activity type mapping from HKWorkoutActivityType ─────────────────────────
// Only the core types are listed; every other HKWorkoutActivityType (Yoga,
// Rowing, Kickboxing, Golf, Pickleball, Climbing, Paddle sports, …) falls
// through to 'Other' and is told apart by sub_type.
const HK_TYPE_MAP = {
  'HKWorkoutActivityTypeRunning':          'Run',
  'HKWorkoutActivityTypeCycling':          'Ride',
  'HKWorkoutActivityTypeWalking':          'Walk',
  'HKWorkoutActivityTypeHiking':           'Hike',
  'HKWorkoutActivityTypeSwimming':         'Swim',
  'HKWorkoutActivityTypeSwimmingOpenWater':'Swim',
};

// Labels where "split the camel case" reads badly.
const HK_LABEL_OVERRIDES = {
  'HighIntensityIntervalTraining': 'HIIT',
  'CoreTraining': 'Core Training',
};

function mapHKType(hkType) {
  return HK_TYPE_MAP[hkType] || 'Other';
}

/** "HKWorkoutActivityTypeFunctionalStrengthTraining" → "Functional Strength Training" */
function hkSubType(hkType) {
  const bare = String(hkType || '').replace(/^HKWorkoutActivityType/, '');
  if (!bare) return null;
  return HK_LABEL_OVERRIDES[bare] || humanize(bare);
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

function toSeconds(value, unit) {
  const u = (unit || 'min').toLowerCase();
  if (u === 'hr' || u === 'h') return value * 3600;
  if (u === 'sec' || u === 's') return value;
  return value * 60; // 'min' (Apple's default) and anything unrecognised
}

function toKcal(value, unit) {
  const u = (unit || 'kcal').toLowerCase();
  if (u === 'kj') return value / 4.184;
  if (u === 'j') return value / 4184;
  return value; // 'Cal' and 'kcal' are both kilocalories in HealthKit
}

// ── Health records (body, energy, nutrition) ─────────────────────────────────
// Only the record types the planner needs. ActiveEnergyBurned is deliberately absent:
// the ActivitySummary's Move value is Apple's own per-day total, whereas summing raw
// records double counts when an iPhone and a Watch both write them.
const HEALTH_RECORD_RE = /<Record type="HKQuantityTypeIdentifier(BasalEnergyBurned|BodyMass|Height|DietaryEnergyConsumed|DietaryProtein|DietaryCarbohydrates|DietaryFatTotal)"([^>]*)>/g;

const attrIn = (s, name) => {
  const i = s.indexOf(name + '="');
  if (i === -1) return null;
  const from = i + name.length + 2;
  return s.slice(from, s.indexOf('"', from));
};
const toKg = (v, u) => { const x = (u || 'kg').toLowerCase(); return x === 'lb' ? v * 0.45359237 : x === 'g' ? v / 1000 : x === 'st' ? v * 6.35029318 : v; };
const toCm = (v, u) => { const x = (u || 'cm').toLowerCase(); return x === 'ft' ? v * 30.48 : x === 'in' ? v * 2.54 : x === 'm' ? v * 100 : v; };
const toGrams = (v, u) => { const x = (u || 'g').toLowerCase(); return x === 'mg' ? v / 1000 : x === 'oz' ? v * 28.3495 : x === 'kg' ? v * 1000 : v; };

/**
 * Collects the planner's inputs while the export streams past.
 *   me          { birth_year, sex }      only the year is kept, never the full birth date
 *   basal_by_day  { 'YYYY-MM-DD': kcal } the largest source per day (no double counting, survives device changes)
 *   dietary_by_day{ date: {kcal, protein, carbs, fat} } likewise (macros from the winning source)
 *   weights     [{ date, kg, source }]   every body-mass entry
 *   height_cm   latest height
 */
function createHealthCollector() {
  const basal = {}, dietary = {}, weights = [], heights = [];
  let me = null;

  const bump = (store, src, day, field, v) => {
    const s = store[src] || (store[src] = {});
    const d = s[day] || (s[day] = { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    d[field] += v;
  };

  const onMe = (tag) => {
    const dob = attrIn(tag, 'HKCharacteristicTypeIdentifierDateOfBirth');
    const sexRaw = attrIn(tag, 'HKCharacteristicTypeIdentifierBiologicalSex') || '';
    const sex = /Female/i.test(sexRaw) ? 'female' : /Male/i.test(sexRaw) ? 'male' : null;
    const year = dob ? parseInt(dob.slice(0, 4), 10) : NaN;
    me = { birth_year: isNaN(year) ? null : year, sex };
  };

  const onRecord = (kind, attrs) => {
    const value = parseFloat(attrIn(attrs, 'value'));
    const start = attrIn(attrs, 'startDate');
    if (isNaN(value) || !start) return;
    const day = start.slice(0, 10);
    const unit = attrIn(attrs, 'unit');
    const src = attrIn(attrs, 'sourceName') || '';
    switch (kind) {
      case 'BasalEnergyBurned': bump(basal, src, day, 'kcal', toKcal(value, unit)); break;
      case 'DietaryEnergyConsumed': bump(dietary, src, day, 'kcal', toKcal(value, unit)); break;
      case 'DietaryProtein': bump(dietary, src, day, 'protein', toGrams(value, unit)); break;
      case 'DietaryCarbohydrates': bump(dietary, src, day, 'carbs', toGrams(value, unit)); break;
      case 'DietaryFatTotal': bump(dietary, src, day, 'fat', toGrams(value, unit)); break;
      case 'BodyMass': { const kg = toKg(value, unit); if (kg > 20 && kg < 400) weights.push({ date: day, kg: Math.round(kg * 100) / 100, source: src }); break; }
      case 'Height': { const cm = toCm(value, unit); if (cm > 80 && cm < 250) heights.push({ date: day, cm: Math.round(cm * 10) / 10 }); break; }
      default: break;
    }
  };

  // Per day, take the source that recorded the most. Two writers of the same data
  // (an iPhone and a Watch, or two nutrition apps) would double count if added; and
  // picking one "main" source for the whole export would drop the days after a device
  // change (a real export's basal energy switched Watch mid-2025).
  const bestPerDay = (store) => {
    const out = {};
    for (const days of Object.values(store)) {
      for (const [day, v] of Object.entries(days)) if (!out[day] || v.kcal > out[day].kcal) out[day] = v;
    }
    return out;
  };

  const finish = () => {
    const basalDays = bestPerDay(basal);
    const dietaryDays = bestPerDay(dietary);
    weights.sort((p, q) => (p.date < q.date ? -1 : 1));
    heights.sort((p, q) => (p.date < q.date ? -1 : 1));
    return {
      me,
      basal_by_day: Object.fromEntries(Object.entries(basalDays).map(([d, v]) => [d, Math.round(v.kcal)])),
      dietary_by_day: Object.fromEntries(Object.entries(dietaryDays).filter(([, v]) => v.kcal > 0)
        .map(([d, v]) => [d, { kcal: Math.round(v.kcal), protein: Math.round(v.protein), carbs: Math.round(v.carbs), fat: Math.round(v.fat) }])),
      weights,
      height_cm: heights.length ? heights[heights.length - 1].cm : null,
    };
  };
  return { onMe, onRecord, finish };
}

// ── Streaming extraction ──────────────────────────────────────────────────────
/**
 * Incremental scanner over decoded export.xml text. Feed it chunks with
 * `push()`; it calls `onWorkout(xml)` for every complete <Workout> block and
 * `onSummary(tag)` for every <ActivitySummary/> tag, keeping only a small
 * carry-over string between chunks. The overwhelming majority of the file is
 * <Record> noise that never matches and is dropped immediately.
 *
 * @param {(xml: string) => void} onWorkout
 * @param {(tag: string) => void} onSummary
 */
function createScanner(onWorkout, onSummary, { onRecord, onMe } = {}) {
  const WORKOUT_OPEN = '<Workout ';
  const WORKOUT_CLOSE = '</Workout>';
  const SUMMARY_OPEN = '<ActivitySummary ';
  // Long enough to hold the longest opening marker split across two chunks.
  const TAIL = SUMMARY_OPEN.length;
  let carry = '';
  // Health records (body weight, basal energy, …) are matched with one regex over
  // each chunk. A record can straddle two chunks, so keep a tail long enough for one
  // opening tag; matches that end inside the carried tail were already handled.
  let recCarry = '';
  let meTries = 0;

  function scanHealth(chunk) {
    if (onMe && !onMe.done && meTries++ < 30) {
      const i = chunk.indexOf('<Me ');
      if (i !== -1) {
        const end = chunk.indexOf('>', i);
        if (end !== -1) { onMe(chunk.slice(i, end + 1)); onMe.done = true; }
      }
    }
    if (!onRecord) return;
    const text = recCarry + chunk;
    HEALTH_RECORD_RE.lastIndex = 0;
    let m;
    while ((m = HEALTH_RECORD_RE.exec(text))) {
      if (m.index + m[0].length <= recCarry.length) continue; // already handled in the tail
      onRecord(m[1], m[2]);
    }
    recCarry = text.slice(-700);
  }

  return {
    push(chunk) {
      scanHealth(chunk);
      const text = carry + chunk;
      carry = '';
      let pos = 0;

      while (true) {
        const w = text.indexOf(WORKOUT_OPEN, pos);
        const s = text.indexOf(SUMMARY_OPEN, pos);
        if (w === -1 && s === -1) break;

        if (s !== -1 && (w === -1 || s < w)) {
          const end = text.indexOf('>', s);
          if (end === -1) { carry = text.slice(s); return; }
          onSummary(text.slice(s, end + 1));
          pos = end + 1;
          continue;
        }

        const tagEnd = text.indexOf('>', w);
        if (tagEnd === -1) { carry = text.slice(w); return; }
        if (text[tagEnd - 1] === '/') {
          // Self-closing <Workout …/> (no children) — the tag is the block.
          onWorkout(text.slice(w, tagEnd + 1));
          pos = tagEnd + 1;
          continue;
        }
        const end = text.indexOf(WORKOUT_CLOSE, tagEnd);
        if (end === -1) {
          // Workout block straddles a chunk boundary — carry it forward
          carry = text.slice(w);
          return;
        }
        onWorkout(text.slice(w, end + WORKOUT_CLOSE.length));
        pos = end + WORKOUT_CLOSE.length;
      }

      // Keep a short tail so a marker split across chunks is still found.
      carry = text.slice(Math.max(pos, text.length - TAIL));
    },
  };
}

/**
 * Stream a JSZip entry through the scanner without building the full string.
 * @returns {Promise<{workouts: string[], summaries: string[]}>}
 */
function streamZipEntry(zipEntry, onBytes, sinks) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8');
    const workouts = [];
    const summaries = [];
    const scanner = createScanner(w => workouts.push(w), s => summaries.push(s), sinks);
    let bytesProcessed = 0;

    zipEntry.internalStream('uint8array')
      .on('data', (chunk) => {
        bytesProcessed += chunk.length;
        onBytes(bytesProcessed, workouts.length);
        // stream:true tells TextDecoder more bytes are coming (split UTF-8 chars)
        scanner.push(decoder.decode(chunk, { stream: true }));
      })
      .on('error', reject)
      .on('end', () => resolve({ workouts, summaries }))
      .resume();
  });
}

/**
 * Same extraction for a bare export.xml. Uses the File's stream when there is
 * one (browsers, Node Blob) so a huge XML is never read into a single string;
 * otherwise falls back to slicing the text / bytes we were given.
 */
async function streamPlainXml(file, onBytes, sinks) {
  const workouts = [];
  const summaries = [];
  const scanner = createScanner(w => workouts.push(w), s => summaries.push(s), sinks);
  const decoder = new TextDecoder('utf-8');
  let bytesProcessed = 0;

  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesProcessed += value.length;
      onBytes(bytesProcessed, workouts.length);
      scanner.push(decoder.decode(value, { stream: true }));
    }
  } else if (typeof file.text === 'function') {
    scanner.push(await file.text());
  } else {
    // Buffer / Uint8Array
    const SLICE = 4 * 1024 * 1024;
    for (let i = 0; i < file.length; i += SLICE) {
      const part = file.subarray(i, i + SLICE);
      bytesProcessed += part.length;
      onBytes(bytesProcessed, workouts.length);
      scanner.push(decoder.decode(part, { stream: true }));
    }
  }
  return { workouts, summaries };
}

// ── Parse a single <ActivitySummary/> tag ────────────────────────────────────
/**
 * One day of Activity Rings.
 * @returns {{date:string, move_kcal:number, move_goal:number,
 *            exercise_min:number, exercise_goal:number,
 *            stand_hours:number, stand_goal:number}|null}
 */
function parseSummaryTag(tag) {
  const attr = (name) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const num = (name) => {
    const v = parseFloat(attr(name));
    return isNaN(v) ? 0 : v;
  };

  const date = attr('dateComponents');
  if (!date) return null;

  const unit = attr('activeEnergyBurnedUnit');
  let move = toKcal(num('activeEnergyBurned'), unit);
  let moveGoal = toKcal(num('activeEnergyBurnedGoal'), unit);
  // Some users (e.g. Move Minutes mode) have no calorie Move ring: Apple then fills
  // appleMoveTime instead. Keep it, and flag the unit so the UI labels it "min".
  let move_unit = 'kcal';
  if (!move && !moveGoal && (num('appleMoveTime') || num('appleMoveTimeGoal'))) {
    move = num('appleMoveTime'); moveGoal = num('appleMoveTimeGoal'); move_unit = 'min';
  }
  const summary = {
    date: date.slice(0, 10),
    move_kcal: move,
    move_goal: moveGoal,
    move_unit,
    exercise_min: num('appleExerciseTime'),
    exercise_goal: num('appleExerciseTimeGoal'),
    stand_hours: num('appleStandHours'),
    stand_goal: num('appleStandHoursGoal'),
  };

  // Apple writes a zeroed row (with no goals) for days the ring wasn't set up.
  const empty = !summary.move_kcal && !summary.move_goal && !summary.exercise_min &&
                !summary.exercise_goal && !summary.stand_hours && !summary.stand_goal;
  return empty ? null : summary;
}

// ── Parse a single <Workout> XML string ──────────────────────────────────────
/** Attributes of a <WorkoutStatistics> child whose type starts with `typePrefix`. */
function statsTag(workoutXml, typePrefix) {
  const re = /<WorkoutStatistics\b[^>]*>/g;
  let m;
  while ((m = re.exec(workoutXml))) {
    if (m[0].includes(`type="${typePrefix}`)) return m[0];
  }
  return null;
}

function tagAttr(tag, name) {
  if (!tag) return null;
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Parse a raw <Workout> XML block into an Activity object.
 * Uses regex to extract attributes since we don't have the full DOM context.
 *
 * @param {string} workoutXml
 * @param {number} index  Used for ID generation
 * @returns {Activity|null}
 */
function parseWorkoutXml(workoutXml, index) {
  // Attributes of the opening tag only — child elements reuse names like
  // "duration" (WorkoutEvent) that must not leak into the workout's own.
  const openTag = workoutXml.slice(0, workoutXml.indexOf('>') + 1);
  const attr = (name) => tagAttr(openTag, name);

  const hkType   = attr('workoutActivityType');
  const startStr = attr('startDate');
  if (!startStr) return null;

  const date = new Date(startStr);
  if (isNaN(date.getTime())) return null;

  // Apple's `duration` is *active* time (pauses excluded); start→end is elapsed time.
  // Strava's duration is elapsed, so use the same meaning here and keep the active
  // figure as moving time. (61 of 402 workouts in a real export differ by >2 min.)
  const active_s = toSeconds(parseFloat(attr('duration') || '0') || 0, attr('durationUnit'));
  const endDate = new Date(attr('endDate') || '');
  const spanned_s = isNaN(endDate.getTime()) ? 0 : (endDate - date) / 1000;
  const duration_s = spanned_s >= active_s && spanned_s > 0 ? spanned_s : active_s;

  // Distance is in a child WorkoutStatistics element (iOS 16+: the type is
  // DistanceWalkingRunning / DistanceCycling / DistanceSwimming…), or in the
  // older totalDistance attribute on the workout itself.
  const distTag = statsTag(workoutXml, 'HKQuantityTypeIdentifierDistance');
  let distVal = parseFloat(tagAttr(distTag, 'sum'));
  let distUnit = tagAttr(distTag, 'unit');
  if (isNaN(distVal)) {
    distVal = parseFloat(attr('totalDistance'));
    distUnit = attr('totalDistanceUnit');
  }
  const distance_m = isNaN(distVal) ? 0 : toMetres(distVal, distUnit);

  // Heart rate — WorkoutStatistics with average/maximum
  const hrTag = statsTag(workoutXml, 'HKQuantityTypeIdentifierHeartRate');
  const avgHR = Math.round(parseFloat(tagAttr(hrTag, 'average')));
  const maxHR = Math.round(parseFloat(tagAttr(hrTag, 'maximum')));

  // Energy: active kcal from statistics, else the legacy totalEnergyBurned attribute.
  const energyTag = statsTag(workoutXml, 'HKQuantityTypeIdentifierActiveEnergyBurned');
  let kcal = parseFloat(tagAttr(energyTag, 'sum'));
  let kcalUnit = tagAttr(energyTag, 'unit');
  if (isNaN(kcal)) {
    kcal = parseFloat(attr('totalEnergyBurned'));
    kcalUnit = attr('totalEnergyBurnedUnit');
  }
  const calories_kcal = isNaN(kcal) || kcal <= 0 ? null : Math.round(toKcal(kcal, kcalUnit));

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

  // Indoor flag — MetadataEntry key="HKIndoorWorkout" value="0"|"1"
  const indoorMatch = workoutXml.match(/key="HKIndoorWorkout"\s+value="([^"]*)"/);
  const indoor = indoorMatch ? indoorMatch[1] === '1' : null;

  // Other metadata worth keeping. Every MetadataEntry appears twice per workout in
  // a real export, so the first match is enough.
  const meta = (key) => {
    const mm = workoutXml.match(new RegExp(`key="${key}"\\s+value="([^"]*)"`));
    return mm ? mm[1] : null;
  };
  let weather = null;
  const tempRaw = meta('HKWeatherTemperature');            // "73 degF"
  if (tempRaw) {
    const [tv, tu = 'degF'] = tempRaw.trim().split(/\s+/);
    const t = parseFloat(tv);
    if (!isNaN(t)) {
      const hum = parseFloat((meta('HKWeatherHumidity') || '').trim());   // stored x100: "5500 %" = 55%
      weather = {
        temp_c: Math.round((/f/i.test(tu) ? (t - 32) * 5 / 9 : t) * 10) / 10,
        feels_c: null,
        humidity_pct: isNaN(hum) ? null : Math.round(hum > 100 ? hum / 100 : hum),
        wind_mps: null,
      };
    }
  }
  const metsRaw = parseFloat((meta('HKAverageMETs') || '').trim());
  const avg_mets = isNaN(metsRaw) || metsRaw <= 0 ? null : Math.round(metsRaw * 100) / 100;
  const time_zone = meta('HKTimeZone');
  const external_id = meta('HKExternalUUID');
  const stepsVal = parseFloat(tagAttr(statsTag(workoutXml, 'HKQuantityTypeIdentifierStepCount'), 'sum'));
  const powerVal = parseFloat(tagAttr(statsTag(workoutXml, 'HKQuantityTypeIdentifierRunningPower'), 'average'));

  // Route file reference — inside <WorkoutRoute> as <FileReference path="..."/>
  const routeFileMatch = workoutXml.match(/<FileReference\b[^>]*path="([^"]*)"/);
  const gpx_file = routeFileMatch ? routeFileMatch[1] : null;

  const type = mapHKType(hkType || '');
  const sub_type = hkSubType(hkType) || type;
  const name = `${type === 'Other' ? sub_type : type} — ${date.toLocaleDateString()}`;

  return createActivity({
    id: `apple-${date.getTime()}-${index}`,
    source: 'apple',
    name,
    type,
    sub_type,
    date,
    distance_m,
    duration_s: Math.round(duration_s),
    moving_s: Math.round(active_s),
    elevation_gain_m: elevation_gain_m && !isNaN(elevation_gain_m) ? elevation_gain_m : null,
    avg_heart_rate: avgHR > 0 ? avgHR : null,
    max_heart_rate: maxHR > 0 ? maxHR : null,
    calories_kcal,
    indoor,
    steps: !isNaN(stepsVal) && stepsVal > 0 ? Math.round(stepsVal) : null,
    avg_watts: !isNaN(powerVal) && powerVal > 0 ? Math.round(powerVal) : null,
    avg_mets, time_zone, external_id, weather,
    device: attr('sourceName'),
    has_route: !!gpx_file,
    gpx_file,
    _rawGpxPath: gpx_file, // kept for zip resolution
  });
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse an Apple Health export into activities + daily ring summaries.
 * @param {File} file   A .zip or .xml File object
 * @param {Function} onProgress  (pct: number, label: string) => void
 * @returns {Promise<{activities: Activity[], summaries: object[], health: object}>}
 *   summaries: [{ date:'YYYY-MM-DD', move_kcal, move_goal, exercise_min,
 *                 exercise_goal, stand_hours, stand_goal }] sorted ascending
 *   health: { me:{birth_year, sex}|null, basal_by_day, dietary_by_day, weights, height_cm }
 *           (inputs for the nutrition planner; see createHealthCollector)
 */
export async function parseAppleExport(file, onProgress = () => {}) {
  const activities = [];
  let summaries = [];
  const collector = createHealthCollector();
  const sinks = { onRecord: collector.onRecord, onMe: Object.assign(collector.onMe, { done: false }) };
  const emptyHealth = () => ({ me: null, basal_by_day: {}, dietary_by_day: {}, weights: [], height_cm: null });

  onProgress(5, 'Reading Apple Health export…');

  const lowerName = file.name.toLowerCase();
  let zip = null;
  let extracted = null;

  // ── Case 1: ZIP archive ───────────────────────────────────────────────────
  if (lowerName.endsWith('.zip')) {
    zip = await JSZip.loadAsync(file);

    // Find the main export.xml — exclude the CDA variant which has no Workout elements
    const xmlEntry = Object.values(zip.files).find(f =>
      !f.dir &&
      f.name.toLowerCase().endsWith('export.xml') &&
      !f.name.toLowerCase().includes('cda')
    );

    if (!xmlEntry) {
      console.warn('Apple Health ZIP: no export.xml found');
      onProgress(100, 'No export.xml found in ZIP');
      return { activities, summaries, health: emptyHealth() };
    }

    onProgress(15, 'Streaming export.xml…');
    const totalSize = xmlEntry._data?.uncompressedSize || 0;
    extracted = await streamZipEntry(xmlEntry, (bytes, found) => {
      const pct = totalSize ? Math.min(55, Math.round((bytes / totalSize) * 55)) : 0;
      onProgress(15 + pct, `Scanning XML… ${found} workouts found`);
    }, sinks);
  }

  // ── Case 2: Plain XML file ────────────────────────────────────────────────
  else if (lowerName.endsWith('.xml')) {
    onProgress(15, 'Streaming XML…');
    const totalSize = file.size || file.length || 0;
    extracted = await streamPlainXml(file, (bytes, found) => {
      const pct = totalSize ? Math.min(55, Math.round((bytes / totalSize) * 55)) : 0;
      onProgress(15 + pct, `Scanning XML… ${found} workouts found`);
    }, sinks);
  }

  if (!extracted) {
    onProgress(100, 'Unsupported Apple Health file');
    return { activities, summaries, health: emptyHealth() };
  }

  const { workouts: workoutStrings, summaries: summaryTags } = extracted;
  onProgress(72, `Found ${workoutStrings.length} workouts, parsing…`);

  // Route lookup: one pass over the ZIP, then O(1) per workout. Apple's
  // FileReference path is absolute-ish ("/workout-routes/route_….gpx"), so we
  // match on the basename.
  let routesByBase = null;
  if (zip) {
    routesByBase = new Map();
    for (const f of Object.values(zip.files)) {
      if (!f.dir) routesByBase.set(f.name.split('/').pop().toLowerCase(), f);
    }
  }

  for (let i = 0; i < workoutStrings.length; i++) {
    const activity = parseWorkoutXml(workoutStrings[i], i);
    if (!activity) continue;

    if (routesByBase && activity._rawGpxPath) {
      const gpxEntry = routesByBase.get(activity._rawGpxPath.split('/').pop().toLowerCase());
      if (gpxEntry) {
        activity.has_route = true;
        activity.gpx_file = gpxEntry.name;
        activity._gpxLoader = () => loadGpxEntry(gpxEntry);
      } else {
        // Referenced route isn't in the archive — don't advertise one.
        activity.has_route = false;
        activity.gpx_file = null;
      }
    }
    // Bare export.xml: no GPX files alongside it, so routes can't resolve.
    else if (!zip) {
      activity.has_route = false;
      activity.gpx_file = null;
    }

    // NOTE: there is deliberately no "match a route by date" fallback here.
    // Route filenames are stamped with the workout's *creation* date in local
    // time, so matching them against a workout's UTC calendar day picks the
    // wrong file — and it only ever fires for workouts that genuinely have no
    // route (yoga, strength training, indoor cardio), handing them some other
    // workout's GPS trace. Across all three real exports every route in the
    // ZIP was already resolved by FileReference above (330/330, 332/332,
    // 435/435), so the fallback contributed nothing but false positives.

    activities.push(activity);

    if (i % 100 === 0) {
      onProgress(72 + Math.round((i / workoutStrings.length) * 25), `Parsed ${i} / ${workoutStrings.length} workouts…`);
    }
  }

  summaries = summaryTags.map(parseSummaryTag).filter(Boolean);
  summaries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  onProgress(100, `Loaded ${activities.length} Apple Health activities`);
  return { activities, summaries, health: collector.finish() };
}

/**
 * Activities only — the original entry point, kept for existing callers.
 * @param {File} file
 * @param {Function} onProgress
 * @returns {Promise<Activity[]>}
 */
export async function parseApple(file, onProgress = () => {}) {
  return (await parseAppleExport(file, onProgress)).activities;
}

export { parseApple as parse };
