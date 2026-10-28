/**
 * parsers/model.js
 * One factory for the normalized Activity model, so every parser emits the
 * same shape and new fields get a default in exactly one place.
 *
 * v2 adds (all additive, all nullable unless noted):
 *   moving_s, calories_kcal, avg_cadence, avg_watts, max_speed_mps, gear,
 *   sub_type (always set), indoor, description, device,
 *   sources, merged_into, merged_ids   (maintained by core/dedup.js)
 *
 * v2.1 adds (additive, nullable): relative_effort (Strava), elevation_loss_m, steps,
 *   avg_speed_mps, avg_mets (Apple), time_zone (IANA name), external_id (Apple's link
 *   to the Strava activity it wrote, "strava://<id>"), and
 *   weather: {temp_c, feels_c, humidity_pct, wind_mps} | null.
 */

/**
 * @param {object} fields  Whatever the parser knows; everything else defaults.
 * @returns {object} Activity
 */
export function createActivity(fields) {
  const a = {
    id: null,
    source: null,
    name: '',
    type: 'Other',
    sub_type: null,
    date: null,
    distance_m: 0,
    duration_s: 0,            // elapsed
    moving_s: null,
    elevation_gain_m: null,
    avg_heart_rate: null,
    max_heart_rate: null,
    calories_kcal: null,
    avg_cadence: null,
    avg_watts: null,
    max_speed_mps: null,
    gear: null,
    indoor: null,
    description: null,
    device: null,
    relative_effort: null,
    elevation_loss_m: null,
    steps: null,
    avg_speed_mps: null,
    avg_mets: null,
    time_zone: null,
    external_id: null,
    weather: null,
    has_route: false,
    gpx_file: null,
    route_points: null,
    has_duplicate: false,
    duplicate_of: null,
    sources: null,
    merged_into: null,
    merged_ids: [],
    ...fields,
  };
  if (!a.sub_type) a.sub_type = a.type;
  if (!a.sources) a.sources = [a.source];
  return a;
}

/** "FunctionalStrengthTraining" / "Virtual Ride" / "e_bike" → "Functional Strength Training" */
export function humanize(label) {
  return String(label || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}
