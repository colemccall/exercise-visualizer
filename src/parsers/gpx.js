/**
 * parsers/gpx.js
 * Shared GPX parser — parses a GPX XML string and returns an array of
 * track points: [{ lat, lng, ele, time, hr, cad, watts }, ...]
 *
 * Handles:
 *  - Standard GPX <trkpt> elements with <ele> and <time>
 *  - Garmin TrackPointExtension heart rate / cadence: <gpxtpx:hr>, <gpxtpx:cad>
 *  - Generic <extensions><hr> heart rate, <power>/<watts> power
 */

/**
 * Read a File/Blob/Buffer as UTF-8 text. Browsers give us File (has .text());
 * the Node test harness hands over a Buffer with a .name property.
 * @param {File|Blob|Uint8Array} file
 * @returns {Promise<string>}
 */
export async function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new TextDecoder('utf-8').decode(file);
}

/**
 * gunzip a byte array to UTF-8 text via the platform DecompressionStream
 * (Chrome 80+, Firefox 113+, Safari 16.4+, Node 18+).
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function gunzipToText(bytes) {
  return new TextDecoder('utf-8').decode(await gunzipToBytes(bytes));
}

/**
 * gunzip a byte array to raw bytes (FIT files are binary, not text).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function gunzipToBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress .gz files (no DecompressionStream)');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  // Not awaited: the write only settles once the readable side is consumed.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Read a ZIP entry holding a GPX track — plain `.gpx` or gzipped `.gpx.gz`
 * (sniffed by the gzip magic bytes, not just the name) — and parse it.
 * @param {object} zipEntry  JSZip file entry
 * @returns {Promise<Array>}
 */
export async function loadGpxEntry(zipEntry) {
  const bytes = await zipEntry.async('uint8array');
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped
    ? await gunzipToText(bytes)
    : new TextDecoder('utf-8').decode(bytes);
  return parseGPX(text);
}

/**
 * Parse a GPX XML string into an array of track points.
 * @param {string} gpxText  Raw GPX file content
 * @returns {{ lat: number, lng: number, ele: number|null, hr: number|null,
 *              cad: number|null, watts: number|null, time: Date|null }[]}
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

    // Heart rate / cadence / power — namespaced and non-namespaced locations
    const { hr, cad, watts } = extractSensors(trkpt);

    points.push({
      lat,
      lng,
      ele: isNaN(ele) ? null : ele,
      hr,
      cad,
      watts,
      time: time && !isNaN(time.getTime()) ? time : null,
    });
  }

  return points;
}

/**
 * Extract heart rate, cadence and power from a <trkpt>'s <extensions>.
 * Elements are matched by local name (DOMParser drops the namespace prefix),
 * anywhere under <extensions>:
 *   hr / heartrate / heart_rate   → hr      (1–299)
 *   cad / cadence                 → cad     (> 0)
 *   power / watts                 → watts   (> 0)
 *
 * @param {Element} trkpt
 * @returns {{ hr: number|null, cad: number|null, watts: number|null }}
 */
function extractSensors(trkpt) {
  const out = { hr: null, cad: null, watts: null };
  const extensions = trkpt.querySelector('extensions');
  if (!extensions) return out;

  for (const el of extensions.querySelectorAll('*')) {
    const name = el.localName.toLowerCase();
    const val = parseInt(el.textContent.trim(), 10);
    if (isNaN(val)) continue;
    if (out.hr === null && (name === 'hr' || name === 'heartrate' || name === 'heart_rate')) {
      if (val > 0 && val < 300) out.hr = val;
    } else if (out.cad === null && (name === 'cad' || name === 'cadence')) {
      if (val > 0) out.cad = val;
    } else if (out.watts === null && (name === 'power' || name === 'watts')) {
      if (val > 0) out.watts = val;
    }
  }
  return out;
}

/**
 * Compute total elevation gain from an array of GPX points.
 *
 * GPS/barometric elevation is noisy, so summing every positive step over-counts
 * badly (a flat run can "climb" hundreds of metres). Two-stage filter instead:
 * a 3-point median removes single-sample spikes, then a 2 m hysteresis band
 * counts a climb only once it has risen 2 m above the last anchor.
 *
 * @param {{ ele: number|null }[]} points
 * @returns {number} elevation gain in metres
 */
export function computeElevationGain(points) {
  const eles = points.map(p => p.ele).filter(e => e !== null && e !== undefined);
  if (eles.length < 2) return 0;

  const smooth = eles.map((e, i) => {
    if (i === 0 || i === eles.length - 1) return e;
    return [eles[i - 1], e, eles[i + 1]].sort((a, b) => a - b)[1];
  });

  const THRESHOLD_M = 2;
  let gain = 0;
  let anchor = smooth[0];
  for (let i = 1; i < smooth.length; i++) {
    const delta = smooth[i] - anchor;
    if (delta > THRESHOLD_M) { gain += delta; anchor = smooth[i]; }
    else if (delta < -THRESHOLD_M) anchor = smooth[i];
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
