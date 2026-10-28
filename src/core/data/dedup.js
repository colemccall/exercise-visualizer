/**
 * core/dedup.js
 * Cross-source duplicate detection AND merge.
 *
 * The same workout is often recorded by both an Apple Watch and Strava (or
 * synced from one into the other). Two activities are the same workout when:
 *   - they come from different sources (never within one source),
 *   - they have the same normalized `type`,
 *   - their start times are within 10 minutes (clocks and sync vary), and
 *   - EITHER both have distance > 100 m and the distances agree within 10%,
 *     OR both have distance < 100 m and both last > 60 s with durations
 *     within 10% (strength, yoga …). One with distance and one without is
 *     never matched — too risky to guess.
 *
 * Unlike the old flag-only pass, a match is merged: the primary record
 * (Strava when both exist, since it carries the user's own names, gear and
 * routes) absorbs the secondary's missing fields, and the secondary is marked
 * `merged_into` the primary so views can hide it via `visibleActivities()`.
 *
 *   Strava wins : name, distance_m, elevation_gain_m, route (has_route /
 *                 gpx_file / _gpxLoader), gear, moving_s, description,
 *                 sub_type, max_speed_mps, avg_cadence, avg_watts
 *   Apple wins  : avg/max heart rate, calories_kcal, indoor, device
 *   Any field the winner lacks is filled from the other record.
 *
 * Exact match first: when Strava writes a workout into Apple Health, Apple records
 * its id as HKExternalUUID ("strava://activities/<id>"). Such a pair is merged on that id
 * alone, whatever the clock skew or distance, before the heuristics above run.
 *
 * Everything is reversible: overwritten fields are remembered in
 * `primary._premerge`, so re-running `mergeDuplicates()` after another upload
 * first undoes the previous merge and recomputes from scratch (idempotent).
 */

const MS_10_MIN = 10 * 60 * 1000;

// Fields where a given source is authoritative when both records carry a value.
const APPLE_WINS = ['avg_heart_rate', 'max_heart_rate', 'calories_kcal', 'indoor', 'device'];
const FILLABLE = [
  'name', 'distance_m', 'duration_s', 'moving_s', 'elevation_gain_m',
  'avg_heart_rate', 'max_heart_rate', 'calories_kcal', 'avg_cadence',
  'avg_watts', 'max_speed_mps', 'gear', 'indoor', 'description', 'device',
  'relative_effort', 'elevation_loss_m', 'steps', 'avg_speed_mps', 'avg_mets', 'time_zone', 'weather',
];
const ROUTE_FIELDS = ['has_route', 'gpx_file', '_gpxLoader', 'route_points'];

/** Lower rank = preferred primary. */
function rank(a) {
  if (a.source === 'strava') return 0;
  if (a.source === 'apple') return 1;
  return 2;
}

function isMissing(field, value) {
  if (value === null || value === undefined) return true;
  // 0 distance / duration means "not recorded" for these.
  if ((field === 'distance_m' || field === 'duration_s') && !(value > 0)) return true;
  return false;
}

/** Are these two activities the same workout? */
function isDuplicate(a, b) {
  if (a.source === b.source) return false;
  if (!a.date || !b.date) return false;
  if (a.type !== b.type) return false;
  if (Math.abs(a.date - b.date) > MS_10_MIN) return false;

  const distA = a.distance_m || 0;
  const distB = b.distance_m || 0;

  if (distA > 100 && distB > 100) {
    const larger = Math.max(distA, distB);
    return (larger - Math.min(distA, distB)) / larger <= 0.10;
  }
  if (distA < 100 && distB < 100) {
    if (a.duration_s > 60 && b.duration_s > 60) {
      const larger = Math.max(a.duration_s, b.duration_s);
      return (larger - Math.min(a.duration_s, b.duration_s)) / larger <= 0.10;
    }
  }
  return false;
}

/**
 * Undo every merge in `activities`, restoring primaries to their pre-merge
 * field values and clearing all merge/duplicate markers.
 * @param {object[]} activities  Modified in place
 */
export function resetMerges(activities) {
  for (const a of activities) {
    if (a._premerge) {
      for (const [field, value] of Object.entries(a._premerge)) a[field] = value;
      delete a._premerge;
    }
    a.sources = [a.source];
    a.merged_into = null;
    a.merged_ids = [];
    a.has_duplicate = false;
    a.duplicate_of = null;
  }
}

/** Activities to show in lists, totals and charts (merged-away records hidden). */
export function visibleActivities(activities) {
  return activities.filter(a => !a.merged_into);
}

/**
 * Detect and merge cross-source duplicates. Mutates `activities` in place.
 * O(n log n): sort by start time, then only compare neighbours within the
 * 10-minute window.
 *
 * @param {object[]} activities
 * @returns {{ merged: number }}  number of secondary records merged away
 */
export function mergeDuplicates(activities) {
  resetMerges(activities);

  const sorted = activities.filter(a => a.date).sort((a, b) => a.date - b.date);

  // Candidate pairs: [primary, secondary, timeDiff]
  const candidates = [];

  // Exact pass: Apple workouts that name their Strava activity. A negative time
  // difference sorts these ahead of every heuristic pair.
  const stravaById = new Map(sorted.filter(a => a.source === 'strava').map(a => [a.id, a]));
  for (const a of sorted) {
    const m = a.source === 'apple' && typeof a.external_id === 'string' ? /^strava:\/\/(?:activities\/)?(\d+)/.exec(a.external_id) : null;
    const primary = m && stravaById.get(`strava-${m[1]}`);
    if (primary) candidates.push([primary, a, -1]);
  }

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].date - sorted[i].date > MS_10_MIN) break;
      const a = sorted[i];
      const b = sorted[j];
      if (!isDuplicate(a, b)) continue;
      const [primary, secondary] = rank(a) <= rank(b) ? [a, b] : [b, a];
      candidates.push([primary, secondary, Math.abs(a.date - b.date)]);
    }
  }

  // Closest start times claim their partner first; a secondary merges once.
  candidates.sort((x, y) => x[2] - y[2]);
  const claimed = new Set();
  let merged = 0;
  for (const [primary, secondary] of candidates) {
    if (claimed.has(secondary)) continue;
    claimed.add(secondary);
    absorb(primary, secondary);
    merged++;
  }
  return { merged };
}

/** Fold `secondary` into `primary` and mark it hidden. */
function absorb(primary, secondary) {
  const before = primary._premerge || (primary._premerge = {});
  const set = (field, value) => {
    if (!(field in before)) before[field] = primary[field];
    primary[field] = value;
  };

  for (const field of FILLABLE) {
    const own = primary[field];
    const other = secondary[field];
    // A workout Strava wrote into Apple Health carries "Strava" as its device; that is
    // not the hardware that recorded it.
    if (field === 'device' && /strava/i.test(String(other || ''))) continue;
    if (secondary.source === 'apple' && APPLE_WINS.includes(field)) {
      // Apple is authoritative for these whenever it has a value.
      if (!isMissing(field, other)) set(field, other);
    } else if (isMissing(field, own) && !isMissing(field, other)) {
      set(field, other);
    }
  }

  // A merged record should stay routable if either side had a route.
  if (!primary.has_route && secondary.has_route) {
    for (const field of ROUTE_FIELDS) set(field, secondary[field]);
  }

  set('has_duplicate', true);
  set('duplicate_of', secondary.id);
  set('sources', [...new Set([...(primary.sources || [primary.source]), ...(secondary.sources || [secondary.source])])]);
  set('merged_ids', [...(primary.merged_ids || []), secondary.id]);

  secondary.merged_into = primary.id;
  secondary.has_duplicate = true;
  secondary.duplicate_of = primary.id;
}
