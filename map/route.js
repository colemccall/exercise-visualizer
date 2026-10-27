/**
 * map/route.js
 * Single-activity route map.
 *
 * The route is drawn on one canvas, coloured by pace (or speed for rides) when
 * the trackpoints carry timestamps, otherwise by heart rate, otherwise a plain
 * accent line. Pace colouring: fast = warm, slow = cool, clipped to the 5th-95th
 * percentile so one GPS hiccup doesn't wash out the rest.
 *
 *   const route = renderRoute(activity, container, { colorBy: 'pace' })
 *   route.setMarker(point)   // scrub marker ({lat,lng}), driven by the stream charts
 *   route.clearMarker()
 *   route.destroy()
 */

import { makeTileLayers, MAX_MAP_ZOOM } from './tiles.js';
import { haversine } from '../analysis/streams.js';

const SEGMENT_TARGET = 700; // colour segments per route: smooth enough, cheap on canvas

function percentile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Which colouring is available for these points? */
export function colorModes(points) {
  const withTime = points.filter(p => p.time).length > points.length * 0.9;
  const hasHr = points.filter(p => p.hr !== null).length > points.length * 0.5;
  return { pace: withTime, hr: hasHr };
}

/**
 * @param {object} activity  must have route_points loaded
 * @param {HTMLElement} container
 * @param {{colorBy?: 'pace'|'hr'|'none'|'auto', canvas?: boolean}} [opts]  canvas:false draws SVG (CSS-styleable layers)
 * @returns {{map: L.Map, setMarker: Function, clearMarker: Function, setColorBy: Function, modes: object, destroy: Function}|null}
 */
export function renderRoute(activity, container, { colorBy = 'auto', canvas = true } = {}) {
  container.replaceChildren();
  const pts = (activity.route_points || []).filter(p => p.lat !== null && p.lng !== null);
  if (pts.length < 2) {
    container.innerHTML = '<div class="map-empty">No GPS route for this activity</div>';
    return null;
  }

  const map = L.map(container, {
    zoomControl: true, attributionControl: true, maxZoom: MAX_MAP_ZOOM, zoomSnap: 0.5,
    preferCanvas: canvas,
  });
  makeTileLayers().forEach(l => l.addTo(map));

  const modes = colorModes(pts);
  const layer = L.layerGroup().addTo(map);
  const casing = getComputedStyle(document.body).getPropertyValue('--card').trim() || '#fff';

  function draw(mode) {
    layer.clearLayers();
    const latLngs = pts.map(p => [p.lat, p.lng]);
    // A casing under the line keeps it legible over any basemap.
    L.polyline(latLngs, { color: casing, weight: 7, opacity: 0.85, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(layer);

    if (mode === 'none' || (mode === 'pace' && !modes.pace) || (mode === 'hr' && !modes.hr)) {
      const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#c2410c';
      L.polyline(latLngs, { color: accent, weight: 4, opacity: 1, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(layer);
      return;
    }

    // Cut segments by distance (>= total/SEGMENT_TARGET, at least 25 m) so GPS jitter
    // over a few metres doesn't produce wild per-segment paces.
    let total = 0;
    for (let k = 1; k < pts.length; k++) total += haversine(pts[k - 1], pts[k]);
    const minSeg = Math.max(25, total / SEGMENT_TARGET);
    const cuts = [0];
    let acc = 0;
    for (let k = 1; k < pts.length; k++) {
      acc += haversine(pts[k - 1], pts[k]);
      if (acc >= minSeg) { cuts.push(k); acc = 0; }
    }
    if (cuts[cuts.length - 1] !== pts.length - 1) cuts.push(pts.length - 1);
    const segs = [];
    for (let c = 0; c < cuts.length - 1; c++) {
      const i = cuts[c], j = cuts[c + 1];
      let value;
      if (mode === 'pace') {
        let dist = 0;
        for (let k = i + 1; k <= j; k++) dist += haversine(pts[k - 1], pts[k]);
        const secs = (pts[j].time - pts[i].time) / 1000;
        value = dist > 1 && secs > 0 ? secs / dist : null; // seconds per metre
      } else {
        const hrs = [];
        for (let k = i; k <= j; k++) if (pts[k].hr !== null) hrs.push(pts[k].hr);
        value = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
      }
      segs.push({ i, j, value });
    }

    // Light smoothing across neighbouring segments so colour reads as a trend, not noise.
    const raw = segs.map(s => s.value);
    segs.forEach((s, i) => {
      const w = [raw[i - 1], raw[i], raw[i + 1]].filter(v => v !== null && v !== undefined);
      s.value = raw[i] === null ? null : w.reduce((a, b) => a + b, 0) / w.length;
    });
    const vals = segs.map(s => s.value).filter(v => v !== null).sort((a, b) => a - b);
    if (vals.length < 2) { draw('none'); return; }
    const lo = percentile(vals, 0.05), hi = percentile(vals, 0.95);
    // Pace: small (fast) -> warm. HR: large (hard) -> warm.
    const scale = window.d3.scaleSequential(window.d3.interpolateTurbo)
      .domain(mode === 'pace' ? [hi, lo] : [lo, hi]).clamp(true);
    for (const s of segs) {
      const color = s.value === null ? '#9a9aa5' : scale(s.value);
      L.polyline(latLngs.slice(s.i, s.j + 1), { color, weight: 4.5, opacity: 1, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(layer);
    }
  }

  const initial = colorBy === 'auto' ? (modes.pace ? 'pace' : modes.hr ? 'hr' : 'none') : colorBy;
  draw(initial);

  const dot = (cls, p) => L.marker([p.lat, p.lng], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: '', html: `<span class="route-pin ${cls}"></span>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
  }).addTo(map);
  dot('start', pts[0]);
  dot('finish', pts[pts.length - 1]);

  map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [24, 24], maxZoom: 17 });

  // Scrub marker, driven by the stream charts (they hand over the point itself).
  let marker = null;

  return {
    map,
    modes,
    colorMode: initial,
    setColorBy(mode) { draw(mode); },
    setMarker(p) {
      if (!p || p.lat === null || p.lng === null) return;
      if (!marker) {
        marker = L.marker([p.lat, p.lng], {
          interactive: false, keyboard: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: '', html: '<span class="route-pin scrub"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
        }).addTo(map);
      } else marker.setLatLng([p.lat, p.lng]);
    },
    clearMarker() { if (marker) { map.removeLayer(marker); marker = null; } },
    invalidate() { try { map.invalidateSize(); } catch { /* hidden */ } },
    destroy() { try { map.remove(); } catch { /* already gone */ } },
  };
}
