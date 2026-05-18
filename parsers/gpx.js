/**
 * parsers/gpx.js
 * Shared GPX parser — parses a GPX XML string and returns an array of
 * track points: [{ lat, lng, ele, hr, time }, ...]
 *
 * Handles:
 *  - Standard GPX <trkpt> elements with <ele> and <time>
 *  - Garmin TrackPointExtension heart rate: <gpxtpx:hr> or <ns3:hr>
 *  - Generic <extensions><hr> heart rate
 */

/**
 * Parse a GPX XML string into an array of track points.
 * @param {string} gpxText  Raw GPX file content
 * @returns {{ lat: number, lng: number, ele: number|null, hr: number|null, time: Date|null }[]}
 */
export function parseGPX(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'application/xml');

  // Check for XML parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('GPX parse error:', parseError.textContent);
    return [];
  }

  // Collect all <trkpt> elements across all tracks and segments
  const trackPoints = doc.querySelectorAll('trkpt');
  const points = [];

  for (const trkpt of trackPoints) {
    const lat = parseFloat(trkpt.getAttribute('lat'));
    const lng = parseFloat(trkpt.getAttribute('lon'));

    // Skip invalid coordinates
    if (isNaN(lat) || isNaN(lng)) continue;

    // Elevation
    const eleEl = trkpt.querySelector('ele');
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;

    // Timestamp
    const timeEl = trkpt.querySelector('time');
    const time = timeEl ? new Date(timeEl.textContent.trim()) : null;

    // Heart rate — try several namespaced and non-namespaced locations
    const hr = extractHR(trkpt);

    points.push({
      lat,
      lng,
      ele: isNaN(ele) ? null : ele,
      hr,
      time: time && !isNaN(time.getTime()) ? time : null,
    });
  }

  return points;
}

/**
 * Extract heart rate from a <trkpt> element.
 * Checks (in order):
 *   1. Garmin extension: <gpxtpx:hr> (namespace prefix varies)
 *   2. Any element named "hr" inside <extensions>
 *   3. <heartrate> element (some Strava exports)
 *
 * @param {Element} trkpt
 * @returns {number|null}
 */
function extractHR(trkpt) {
  const extensions = trkpt.querySelector('extensions');
  if (!extensions) return null;

  // Strategy 1: querySelector with various namespace-prefixed element names.
  // DOMParser retains the local name (after colon) so we can match by local name.
  const allExtChildren = extensions.querySelectorAll('*');
  for (const el of allExtChildren) {
    const localName = el.localName.toLowerCase();
    if (localName === 'hr' || localName === 'heartrate' || localName === 'heart_rate') {
      const val = parseInt(el.textContent.trim(), 10);
      if (!isNaN(val) && val > 0 && val < 300) return val;
    }
  }

  return null;
}

/**
 * Compute total elevation gain from an array of GPX points.
 * Only counts upward transitions > 1m (noise filter).
 * @param {{ ele: number|null }[]} points
 * @returns {number} elevation gain in metres
 */
export function computeElevationGain(points) {
  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].ele !== null && points[i - 1].ele !== null) {
      const diff = points[i].ele - points[i - 1].ele;
      if (diff > 1) gain += diff;
    }
  }
  return gain;
}

/**
 * Compute total distance in metres from an array of GPX points using
 * the Haversine formula.
 * @param {{ lat: number, lng: number }[]} points
 * @returns {number} distance in metres
 */
export function computeDistance(points) {
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return dist;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in metres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
