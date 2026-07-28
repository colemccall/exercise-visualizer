/**
 * photos/matcher.js
 * Pair photos to activities by timestamp and resolve each photo's position
 * (EXIF GPS when present; interpolated from the GPX track otherwise).
 *
 * Attaches results in-place:
 *   activity.photos = [{id, url, lat, lng, timestamp, interpolated, isHEIC, name}]
 *   photo.activity_id = string|null
 */

/**
 * @param {Photo[]} photos      Normalized photo objects (from parsers/photos.js)
 * @param {Activity[]} activities  Normalized activities (must have date, duration_s)
 * @param {{bufferMinutes?: number}} [opts]
 * @returns {Promise<{matched: number, unmatched: number, activitiesWithPhotos: Activity[]}>}
 */
export async function matchPhotosToActivities(photos, activities, opts = {}) {
  const bufferMs = (opts.bufferMinutes ?? 5) * 60 * 1000;

  // Reset any prior matches
  for (const a of activities) a.photos = [];
  for (const p of photos) p.activity_id = null;

  // Sort activities by start time for binary search.
  const acts = activities
    .filter(a => a.date instanceof Date && !isNaN(a.date.getTime()) && a.duration_s > 0)
    .slice()
    .sort((a, b) => a.date - b.date);
  const starts = acts.map(a => a.date.getTime());

  // First pass: assign photos to activities (windowed).
  const activitiesNeedingGPX = new Set();
  for (const photo of photos) {
    if (!photo.timestamp) continue;
    const t = photo.timestamp.getTime();

    // Binary search: largest starts[i] <= t + bufferMs
    let lo = 0, hi = starts.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t + bufferMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0) continue;

    // Walk back a few slots — activities can overlap; we want any window that
    // contains the photo timestamp (with buffer).
    for (let i = idx; i >= 0 && i >= idx - 6; i--) {
      const a = acts[i];
      const start = a.date.getTime();
      const end = start + (a.duration_s * 1000);
      if (t >= start - bufferMs && t <= end + bufferMs) {
        photo.activity_id = a.id;
        a.photos.push({
          id: photo.id,
          name: photo.name,
          url: photo.url,
          isHEIC: photo.isHEIC,
          isVideo: photo.isVideo,
          _source: photo, // keep ref for lazy poster/decode caching
          timestamp: photo.timestamp,
          lat: photo.lat,
          lng: photo.lng,
          interpolated: false, // resolved below
        });
        if (!photo.hasGPS) activitiesNeedingGPX.add(a);
        break;
      }
    }
  }

  // Second pass: for photos without EXIF GPS, interpolate from the GPX track.
  for (const a of activitiesNeedingGPX) {
    let points = a.route_points;
    if ((!points || points.length === 0) && typeof a._gpxLoader === 'function') {
      try { points = await a._gpxLoader(); a.route_points = points; }
      catch { points = null; }
    }
    if (!points || points.length < 2) continue;

    // Only points with timestamps are usable for interpolation.
    const timed = points.filter(p => p.time instanceof Date && !isNaN(p.time));
    if (timed.length < 2) continue;
    const times = timed.map(p => p.time.getTime());

    for (const photo of a.photos) {
      if (photo.lat !== null && photo.lng !== null) continue; // already had EXIF GPS
      const t = photo.timestamp.getTime();
      const pos = interpolatePosition(timed, times, t);
      if (pos) {
        photo.lat = pos.lat;
        photo.lng = pos.lng;
        photo.interpolated = true;
      }
    }
  }

  // Drop from activity.photos any that ended up with no coordinates.
  let matched = 0;
  const activitiesWithPhotos = [];
  for (const a of activities) {
    a.photos = (a.photos || []).filter(p => p.lat !== null && p.lng !== null);
    if (a.photos.length) {
      // Sort chronologically for the tour mode.
      a.photos.sort((x, y) => x.timestamp - y.timestamp);
      matched += a.photos.length;
      activitiesWithPhotos.push(a);
    }
  }
  const unmatched = photos.filter(p => p.timestamp).length - matched;

  return { matched, unmatched, activitiesWithPhotos };
}

function interpolatePosition(points, times, t) {
  // t before first / after last: clamp to the endpoint.
  if (t <= times[0]) return { lat: points[0].lat, lng: points[0].lng };
  if (t >= times[times.length - 1]) {
    const last = points[points.length - 1];
    return { lat: last.lat, lng: last.lng };
  }

  // Binary search for the pair straddling t.
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = times[hi] - times[lo];
  if (span <= 0) return { lat: a.lat, lng: a.lng };
  const frac = (t - times[lo]) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lng: a.lng + (b.lng - a.lng) * frac,
  };
}
