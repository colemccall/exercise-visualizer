/**
 * map/route.js
 * Leaflet single-activity route map.
 * Colors the route by pace (if no HR) or by heart rate (if available).
 *
 * Pace coloring: red = fast, blue = slow (linear scale)
 * HR coloring:   blue = low, red = high (linear scale)
 *
 * Exports:
 *   renderRoute(activity, container)  → L.Map
 */

/**
 * Render a single activity's route on a new Leaflet map.
 * Existing map instance is destroyed and recreated each time.
 *
 * @param {Activity} activity   Must have route_points loaded
 * @param {HTMLElement} container  DOM element for the map
 * @returns {L.Map|null}
 */
export function renderRoute(activity, container) {
  // Clear previous map
  container.innerHTML = '';

  const pts = activity.route_points;
  if (!pts || pts.length < 2) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No route data</div>';
    return null;
  }

  const validPts = pts.filter(p => p.lat !== null && p.lng !== null);
  if (validPts.length < 2) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No route data</div>';
    return null;
  }

  // Create Leaflet map
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
  });

  const tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  L.tileLayer(tileUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Determine coloring mode
  const hasHR = validPts.some(p => p.hr !== null);

  if (hasHR) {
    renderByHR(validPts, map);
  } else {
    renderByPace(validPts, map);
  }

  // Fit bounds
  const bounds = L.latLngBounds(validPts.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [20, 20] });

  // Start/end markers
  addMarker(map, validPts[0], '🟢', 'Start');
  addMarker(map, validPts[validPts.length - 1], '🔴', 'Finish');

  return map;
}

// ── Color by pace ─────────────────────────────────────────────────────────────
/**
 * Segment the route and color each segment by pace.
 * Red = fastest, Blue = slowest.
 */
function renderByPace(pts, map) {
  // Compute pace (seconds per km) between consecutive points
  const segments = computePaceSegments(pts);
  if (segments.length === 0) {
    // Fallback: single color
    L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#DC2626', weight: 3, opacity: 0.8 }).addTo(map);
    return;
  }

  const paces = segments.map(s => s.pace).filter(p => p > 0 && p < 3600);
  const minPace = Math.min(...paces);
  const maxPace = Math.max(...paces);

  // d3 color scale: red (fast) → blue (slow)
  const colorScale = d3.scaleSequential()
    .domain([minPace, maxPace])
    .interpolator(d3.interpolateRdYlBu);

  for (const seg of segments) {
    if (seg.points.length < 2) continue;
    const color = (seg.pace > 0 && seg.pace < 3600)
      ? colorScale(seg.pace)
      : '#aaaaaa';

    L.polyline(seg.points.map(p => [p.lat, p.lng]), {
      color,
      weight: 3,
      opacity: 0.85,
    }).addTo(map);
  }
}

/**
 * Compute pace in sec/km for each segment.
 * We group every N points into a segment to avoid too many Leaflet layers.
 */
function computePaceSegments(pts, segmentSize = 5) {
  const segments = [];

  for (let i = 0; i < pts.length - 1; i += segmentSize) {
    const slice = pts.slice(i, Math.min(i + segmentSize + 1, pts.length));
    if (slice.length < 2) continue;

    // Distance of this segment
    let dist = 0;
    for (let j = 1; j < slice.length; j++) {
      dist += haversine(slice[j-1].lat, slice[j-1].lng, slice[j].lat, slice[j].lng);
    }

    // Time of this segment
    const t0 = slice[0].time;
    const t1 = slice[slice.length - 1].time;
    const elapsed = (t0 && t1) ? (t1 - t0) / 1000 : 0; // seconds

    const pace = dist > 0 && elapsed > 0
      ? elapsed / (dist / 1000) // sec per km
      : 0;

    segments.push({ points: slice, pace });
  }

  return segments;
}

// ── Color by HR ───────────────────────────────────────────────────────────────
function renderByHR(pts, map) {
  const hrs = pts.map(p => p.hr).filter(h => h !== null);
  if (hrs.length === 0) {
    L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#DC2626', weight: 3, opacity: 0.8 }).addTo(map);
    return;
  }

  const minHR = Math.min(...hrs);
  const maxHR = Math.max(...hrs);

  const colorScale = d3.scaleSequential()
    .domain([minHR, maxHR])
    .interpolator(d3.interpolateRdYlBu)
    .clamp(true);

  // Render segment by segment
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const hr  = p0.hr ?? p1.hr;
    const color = hr !== null ? colorScale(maxHR - hr + minHR) : '#aaa'; // invert: red=high

    L.polyline([[p0.lat, p0.lng], [p1.lat, p1.lng]], {
      color,
      weight: 3,
      opacity: 0.85,
    }).addTo(map);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function addMarker(map, pt, emoji, title) {
  const icon = L.divIcon({
    html: `<div style="font-size:16px;line-height:1;">${emoji}</div>`,
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
  L.marker([pt.lat, pt.lng], { icon, title }).addTo(map);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
