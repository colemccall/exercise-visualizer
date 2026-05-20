/**
 * map/heatmap.js
 * Leaflet multi-route heatmap layer.
 * Supports light/dark basemap switching.
 */

export const TYPE_COLORS = {
  Run:   '#FF6B6B',
  Ride:  '#4A90D9',
  Walk:  '#5CB85C',
  Hike:  '#F0AD4E',
  Swim:  '#5BC0DE',
  Other: '#aaaaaa',
};

let _routeLayerGroup = null;
let _map = null;
let _tileLayer = null;

export let _renderedPolylines  = [];
export let _renderedActivities = [];

function isDark() {
  return document.documentElement.classList.contains('dark-mode');
}

function tileUrl(_dark) {
  // Same grey basemap for both modes — dark_matter_lite is charcoal/grey, not black
  return 'https://{s}.basemaps.cartocdn.com/dark_matter_lite/{z}/{x}/{y}{r}.png';
}

const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';

export function getHeatmapInstance() { return _map; }

export function setHeatmapTheme(dark) {
  // Both modes use the same grey basemap — nothing to swap.
}

export function initHeatmap(container) {
  if (_map) { _map.remove(); _map = null; }

  _map = L.map(container, { center: [20, 0], zoom: 2, zoomControl: true, attributionControl: true });

  _tileLayer = L.tileLayer(tileUrl(isDark()), { attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19 });
  _tileLayer.addTo(_map);

  _routeLayerGroup = L.layerGroup().addTo(_map);
  return _map;
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
      const color   = TYPE_COLORS[activity.type] || TYPE_COLORS.Other;
      const latLngs = pts.filter(p => p.lat !== null && p.lng !== null).map(p => [p.lat, p.lng]);
      if (latLngs.length < 2) continue;
      const polyline = L.polyline(latLngs, { color, weight: 1.5, opacity: 0.4 });
      polyline.addTo(_routeLayerGroup);
      allLatLngs.push(...latLngs);
      _renderedPolylines.push(polyline);
      _renderedActivities.push(activity);
    }

    const done = Math.min(i + BATCH, routable.length);
    const pct  = Math.round((done / routable.length) * 100);
    overlay.textContent = `Loading routes… ${done.toLocaleString()} / ${routable.length.toLocaleString()} (${pct}%)`;

    // Fit bounds after first batch so map zooms quickly
    if (i === 0 && allLatLngs.length > 0) {
      try { map.fitBounds(L.latLngBounds(allLatLngs), { padding: [20, 20] }); } catch (e) {}
    }
  }

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
