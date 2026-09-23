/**
 * map/heatmap.js
 * Leaflet multi-route heatmap layer.
 * Supports light/dark basemap switching.
 */

import { TYPE_COLORS } from '../design-system/activity-colors.js';
export { TYPE_COLORS };

let _routeLayerGroup = null;
let _userMovedMap = false;
let _map = null;
let _tileLayers = [];

export let _renderedPolylines  = [];
export let _renderedActivities = [];

function isDark() {
  return document.documentElement.classList.contains('dark-mode');
}

/* ── Basemaps ────────────────────────────────────────────────────────────────
   Two stacked layers, because no single keyless source does both jobs well:

     z0-16  Esri's World_Light_Gray_Base — the clean neutral canvas routes read
            best against. Its tiles stop at z16 ("a few city blocks"), which is
            why the map used to refuse to go closer.
     z17-20 OpenStreetMap standard tiles — native to z19, upscaled one step to
            z20, so you can zoom right down to which side of the street a route
            ran on.

   CARTO's basemaps.cartocdn.com is deliberately not used: it now stamps
   "API KEY REQUIRED" across keyless tiles.

   Dark mode inverts the tile pane in CSS (html.dark-mode .leaflet-tile-pane)
   rather than swapping providers — one basemap, consistent at every zoom, and
   it finally gives dark mode a dark map to draw routes on.                   */
const ESRI_GRAY  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const OSM_DETAIL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const BASE_OPTS = {
  maxZoom: 17,        // hands over to the detail layer
  maxNativeZoom: 16,  // Esri has nothing past 16; upscale the last half-step
  attribution: 'Tiles &copy; Esri',
};
const DETAIL_OPTS = {
  minZoom: 16.5,
  maxZoom: 20,
  maxNativeZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

export const MAX_MAP_ZOOM = 20;

/** Both basemap layers, in draw order. */
function makeTileLayers() {
  return [
    L.tileLayer(ESRI_GRAY, BASE_OPTS),
    L.tileLayer(OSM_DETAIL, DETAIL_OPTS),
  ];
}

let _heatStyle = 'type'; // 'type' | 'frequency'

export function getHeatStyle() { return _heatStyle; }

export function setHeatStyle(style) {
  _heatStyle = (style === 'frequency') ? 'frequency' : 'type';
}

/* ── Frequency colouring ─────────────────────────────────────────────────────
   "Frequency" used to mean "draw every route in one flat colour at 12-15%
   opacity and let overlaps stack up". A single pass over a road is then
   invisible, and on the light basemap the dark-mode white stroke vanished
   entirely. Instead we measure frequency directly: bin every trackpoint into a
   ~78m grid, count how many separate activities touch each cell, and score each
   route by the median cell count along it. Routes are coloured by their
   percentile rank on a sequential ramp, so the colours spread evenly no matter
   how skewed the raw counts are.

   Both ramps stay saturated at *both* ends. A pale or near-grey low end reads
   as "the map is washing my routes out" rather than "this is a road I rarely
   use" — a route you rode once should still look like a coloured route.      */

const FREQ_RAMP_LIGHT = ['#2C5FCC', '#7A3FC9', '#B92C9E', '#D92B4E', '#E8590C'];
const FREQ_RAMP_DARK  = ['#4C8DFF', '#8B5CF6', '#E040A0', '#FF7A45', '#FFD166'];

let _freqRange = { min: 1, max: 1 };

export function getFrequencyRamp(dark) { return dark ? FREQ_RAMP_DARK : FREQ_RAMP_LIGHT; }
export function getFrequencyRange()    { return { ..._freqRange }; }

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Sample a ramp at t in [0,1], interpolating between stops. */
function rampColor(t, dark) {
  const ramp    = getFrequencyRamp(dark);
  const clamped = Math.max(0, Math.min(1, t));
  const pos     = clamped * (ramp.length - 1);
  const i       = Math.min(ramp.length - 2, Math.floor(pos));
  const frac    = pos - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * frac));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

/** Index of the first element >= value — used for percentile ranking. */
function lowerBound(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Score every routed activity by how well-trodden its path is.
 * Writes `_freqScore` (how many activities share this route) and `_freqT`
 * (0-1 percentile rank) onto each activity. One pass over every trackpoint:
 * ~650k points runs in well under a second.
 */
export function computeFrequency(activities) {
  const CELL = 0.0007; // ~78m of latitude
  const cellCounts = new Map();
  const perAct = [];

  for (const act of activities) {
    const pts = act.route_points;
    if (!pts || pts.length < 2) { act._freqScore = 0; act._freqT = 0; continue; }
    const cells = new Set();
    for (const p of pts) {
      if (p.lat === null || p.lng === null) continue;
      cells.add(`${Math.round(p.lat / CELL)},${Math.round(p.lng / CELL)}`);
    }
    if (cells.size === 0) { act._freqScore = 0; act._freqT = 0; continue; }
    // One increment per activity per cell — repeated laps of the same loop
    // inside one workout shouldn't inflate that cell's count.
    for (const key of cells) cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    perAct.push({ act, cells });
  }

  const scores = [];
  for (const { act, cells } of perAct) {
    const counts = [];
    for (const key of cells) counts.push(cellCounts.get(key) || 1);
    counts.sort((a, b) => a - b);
    // Median, not max: one incidental crossing of a busy trail shouldn't make a
    // one-off route read as a daily commute.
    act._freqScore = counts[Math.floor(counts.length / 2)];
    scores.push(act._freqScore);
  }

  scores.sort((a, b) => a - b);
  _freqRange = scores.length
    ? { min: scores[0], max: scores[scores.length - 1] }
    : { min: 1, max: 1 };

  // Colour position blends two readings of the same number: percentile rank
  // spreads the palette evenly across the routes you actually have, and a log
  // scale of the raw count keeps the colour tied to "how many times", so a
  // dataset where nothing repeats doesn't paint itself as if it did.
  const logMax = Math.log(Math.max(2, _freqRange.max));
  for (const { act } of perAct) {
    const percentile = scores.length > 1
      ? lowerBound(scores, act._freqScore) / (scores.length - 1)
      : 1;
    const logT = Math.log(Math.max(1, act._freqScore)) / logMax;
    act._freqT = 0.6 * percentile + 0.4 * Math.min(1, logT);
  }
}

export function routeStyle(dark, activity) {
  if (_heatStyle === 'frequency') {
    const t = activity && typeof activity._freqT === 'number' ? activity._freqT : 0.5;
    // Busy routes draw thicker and more opaque. The floor is high enough that a
    // once-ridden route is a solid line, not a ghost: opacity carries emphasis,
    // colour carries the actual reading.
    return { weight: 2.5 + 2 * t, opacity: 0.7 + 0.25 * t };
  }
  return dark
    ? { weight: 1.5, opacity: 0.55 }  // brighter on dark
    : { weight: 2,   opacity: 0.65 }; // stronger on light
}

// Resolve stroke color for the current heat style.
export function styleColor(activity, dark) {
  if (_heatStyle === 'frequency') {
    const t = activity && typeof activity._freqT === 'number' ? activity._freqT : 0.5;
    return rampColor(t, dark);
  }
  return TYPE_COLORS[activity.type] || TYPE_COLORS.Other;
}

/* ── Route interaction ───────────────────────────────────────────────────────
   Routes are the content of this page, so they behave like content: hover to
   preview, click to pin. app.js owns the card UI and decides what a click
   means; this module owns the map-side drawing.                             */

let _routeHandlers = {};
let _highlightLayer = null;

export function setRouteHandlers(handlers) {
  _routeHandlers = { ..._routeHandlers, ...handlers };
}

function attachRouteHandlers(polyline, activity) {
  polyline.on('mouseover', () => _routeHandlers.onHover?.(activity, true));
  polyline.on('mouseout',  () => _routeHandlers.onHover?.(activity, false));
  polyline.on('click', (e) => {
    L.DomEvent.stopPropagation(e);   // don't let the map's own click clear it
    _routeHandlers.onSelect?.(activity);
  });
}

function activityLatLngs(activity) {
  return (activity?.route_points || [])
    .filter(p => p.lat !== null && p.lng !== null)
    .map(p => [p.lat, p.lng]);
}

/**
 * Draw a route on top of everything else: a casing in the page background
 * colour, then the route in its own colour. Two lines rather than one thick
 * one, so the highlight reads against both a dense cluster and an empty map.
 */
export function highlightRoute(activity, { preview = false } = {}) {
  clearHighlight();
  if (!_map || !activity) return;
  const latLngs = activityLatLngs(activity);
  if (latLngs.length < 2) return;

  const dark = isDark();
  _highlightLayer = L.layerGroup([
    L.polyline(latLngs, {
      color: dark ? '#0b0c10' : '#ffffff',
      weight: preview ? 7 : 9,
      opacity: preview ? 0.75 : 0.9,
      lineJoin: 'round', lineCap: 'round', interactive: false,
    }),
    L.polyline(latLngs, {
      color: styleColor(activity, dark),
      weight: preview ? 3.5 : 4.5,
      opacity: 1,
      lineJoin: 'round', lineCap: 'round', interactive: false,
    }),
  ]).addTo(_map);
}

export function clearHighlight() {
  if (_highlightLayer && _map) _map.removeLayer(_highlightLayer);
  _highlightLayer = null;
}

/** Frame a single route. */
export function zoomToRoute(activity) {
  if (!_map) return;
  const latLngs = activityLatLngs(activity);
  if (latLngs.length < 2) return;
  _userMovedMap = true; // a deliberate framing — don't undo it on the next load
  _map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40], maxZoom: 17 });
}

/** Re-stack so the busiest routes sit above the quiet ones. */
export function raiseHotRoutes() {
  if (_heatStyle !== 'frequency') return;
  const order = _renderedActivities
    .map((a, i) => ({ i, t: a?._freqT ?? 0 }))
    .sort((a, b) => a.t - b.t);
  for (const { i, t } of order) {
    if (t > 0.6) _renderedPolylines[i]?.bringToFront();
  }
}


export function getHeatmapInstance() { return _map; }

export function setHeatmapTheme(dark) {
  if (!_map) return;
  // The basemap itself doesn't change — CSS inverts the tile pane in dark mode.
  // Only the routes need restyling.
  _renderedPolylines.forEach((poly, i) => {
    const act = _renderedActivities[i];
    if (!poly || !act) return;
    poly.setStyle({ color: styleColor(act, dark), ...routeStyle(dark, act) });
  });
  raiseHotRoutes();
}

/**
 * @param {HTMLElement} container
 * @param {{center?: [number,number], zoom?: number}} [opts]
 *   Pass a real center when you can — avoids the "world map at [20,0]" flash
 *   before routes finish loading. fitBounds() will still tighten the view once
 *   the first batch of routes is decoded.
 */
export function initHeatmap(container, opts = {}) {
  if (_map) { _map.remove(); _map = null; }

  const center = opts.center || [20, 0];
  const zoom   = opts.zoom ?? (opts.center ? 10 : 2);

  _map = L.map(container, {
    center, zoom,
    zoomControl: true,
    attributionControl: true,
    maxZoom: MAX_MAP_ZOOM,
    zoomSnap: 0.5,   // half-steps for wheel/pinch; +/- still moves a full level
  });

  _tileLayers = makeTileLayers();
  _tileLayers.forEach(layer => layer.addTo(_map));

  // Once the user pans or zooms, stop re-framing the map underneath them.
  _userMovedMap = false;
  _map.on('dragstart mousedown wheel', () => { _userMovedMap = true; });

  _routeLayerGroup = L.layerGroup().addTo(_map);
  // Handy for driving the map from Playwright (see CLAUDE.md § Testing).
  window.__heatmapMap = _map;
  return _map;
}

/**
 * Bounds around the place you actually train, not around every point.
 *
 * Fitting all points opens the map at continent or world scale — one trip
 * abroad, a race in another state, or a single GPS spike is enough — with the
 * routes you care about reduced to a speck. So: bin points onto a ~25km grid,
 * take the busiest cell, and frame everything within ~80km of it. Anything
 * further out is still drawn; you just have to zoom out to see it.
 */
function coreBounds(latLngs) {
  if (latLngs.length < 20) return L.latLngBounds(latLngs);

  // Sampling keeps this cheap on the ~650k points a big export produces.
  const step   = Math.max(1, Math.floor(latLngs.length / 50000));
  const sample = step === 1 ? latLngs : latLngs.filter((_, i) => i % step === 0);

  const CELL = 0.25; // ~25km of latitude
  const counts = new Map();
  for (const [lat, lng] of sample) {
    const key = `${Math.round(lat / CELL)},${Math.round(lng / CELL)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, n] of counts) if (n > bestCount) { bestCount = n; bestKey = key; }
  if (!bestKey) return L.latLngBounds(sample);

  const [cLat, cLng] = bestKey.split(',').map(v => +v * CELL);
  const RADIUS_DEG = 0.75; // ~80km
  const lngRadius  = RADIUS_DEG / Math.max(0.2, Math.cos(cLat * Math.PI / 180));
  const near = sample.filter(([lat, lng]) =>
    Math.abs(lat - cLat) <= RADIUS_DEG && Math.abs(lng - cLng) <= lngRadius);

  return L.latLngBounds(near.length > 1 ? near : sample);
}

export async function renderHeatmap(activities, map) {
  if (!map || !_routeLayerGroup) return;

  _routeLayerGroup.clearLayers();
  _renderedPolylines  = [];
  _renderedActivities = [];

  const routable = activities
    .filter(a => a.has_route || a.route_points)
    .sort((a, b) => b.date - a.date)
    .slice(0, 10000);

  if (routable.length === 0) return;

  const overlay = getRouteOverlay(map);
  overlay.style.display = 'block';

  const allLatLngs = [];
  const BATCH = 50;

  for (let i = 0; i < routable.length; i += BATCH) {
    const batch = routable.slice(i, i + BATCH);

    // Load GPX for this batch
    await Promise.all(batch.map(async (activity) => {
      if (!activity.route_points && activity._gpxLoader) {
        try { activity.route_points = await activity._gpxLoader(); }
        catch (e) { activity.route_points = []; }
      }
    }));

    // Render batch immediately so routes appear as they load
    for (const activity of batch) {
      const pts = activity.route_points;
      if (!pts || pts.length < 2) continue;
      const dark    = isDark();
      const color   = styleColor(activity, dark);
      const latLngs = pts.filter(p => p.lat !== null && p.lng !== null).map(p => [p.lat, p.lng]);
      if (latLngs.length < 2) continue;
      const { weight, opacity } = routeStyle(dark, activity);
      const polyline = L.polyline(latLngs, {
        color, weight, opacity, lineJoin: 'round', lineCap: 'round',
      });
      attachRouteHandlers(polyline, activity);
      polyline.addTo(_routeLayerGroup);
      allLatLngs.push(...latLngs);
      _renderedPolylines.push(polyline);
      _renderedActivities.push(activity);
    }

    const done = Math.min(i + BATCH, routable.length);
    const pct  = Math.round((done / routable.length) * 100);
    overlay.textContent = `Loading routes… ${done.toLocaleString()} / ${routable.length.toLocaleString()} (${pct}%)`;

    // Fit after the first batch so the map lands somewhere real quickly.
    if (i === 0 && allLatLngs.length > 0 && !_userMovedMap) {
      try { map.fitBounds(coreBounds(allLatLngs), { padding: [20, 20], maxZoom: 15 }); } catch (e) {}
    }
  }

  // Re-fit once everything is in — unless the user has taken the wheel.
  if (allLatLngs.length > 0 && !_userMovedMap) {
    try { map.fitBounds(coreBounds(allLatLngs), { padding: [20, 20], maxZoom: 15 }); } catch (e) {}
  }

  // Frequency ranking needs every route loaded before it can rank them.
  computeFrequency(_renderedActivities);

  overlay.textContent = `${_renderedPolylines.length.toLocaleString()} routes loaded`;
  setTimeout(() => { overlay.style.display = 'none'; }, 2000);
}

function getRouteOverlay(map) {
  const container = map.getContainer();
  let el = container.querySelector('.route-load-overlay');
  if (!el) {
    el = document.createElement('div');
    el.className = 'route-load-overlay';
    el.style.cssText = [
      'position:absolute', 'bottom:28px', 'left:50%', 'transform:translateX(-50%)',
      'background:rgba(0,0,0,0.65)', 'color:#fff', 'font-size:12px', 'font-family:Inter,sans-serif',
      'padding:5px 14px', 'border-radius:20px', 'z-index:800', 'pointer-events:none',
      'white-space:nowrap', 'display:none',
    ].join(';');
    container.style.position = 'relative';
    container.appendChild(el);
  }
  return el;
}
