/**
 * map/heatmap.js
 * Leaflet multi-route heatmap layer.
 *
 * Draws all loaded activity routes as semi-transparent polylines, colored
 * by activity type. On first load, up to 50 of the most recent activities
 * with GPX files have their route_points lazy-loaded.
 *
 * Exports:
 *   initHeatmap(container)  → Leaflet map instance
 *   renderHeatmap(activities, map)  → Promise<void>
 */

export const TYPE_COLORS = {
  Run:   '#FF6B6B',
  Ride:  '#4A90D9',
  Walk:  '#5CB85C',
  Hike:  '#F0AD4E',
  Swim:  '#5BC0DE',
  Other: '#aaaaaa',
};

// Leaflet layers stored so we can clear on re-render
let _routeLayerGroup = null;
let _map = null;

// Polyline registry for timelapse (parallel to rendered activities)
export let _renderedPolylines = []; // { activity, polyline }
export let _renderedActivities = [];

/**
 * Initialize the Leaflet heatmap.
 * @param {HTMLElement} container  DOM element for the map
 * @returns {L.Map}
 */
export function getHeatmapInstance() { return _map; }

export function initHeatmap(container) {
  if (_map) {
    _map.remove();
    _map = null;
  }

  _map = L.map(container, {
    center: [20, 0],
    zoom: 2,
    zoomControl: true,
    attributionControl: true,
  });

  // CartoDB dark tiles (same as Workout Maps app)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(_map);

  _routeLayerGroup = L.layerGroup().addTo(_map);

  return _map;
}

/**
 * Render all routable activities as polylines on the heatmap.
 * Will lazy-load route_points for activities that have a _gpxLoader
 * but no route_points yet. Loads the top 50 most recent with GPX.
 *
 * @param {Activity[]} activities
 * @param {L.Map} map
 * @returns {Promise<void>}
 */
export async function renderHeatmap(activities, map) {
  if (!map || !_routeLayerGroup) return;

  // Clear existing routes
  _routeLayerGroup.clearLayers();

  // Get activities that potentially have routes
  const routable = activities
    .filter(a => a.has_route || a.route_points)
    .sort((a, b) => b.date - a.date); // most recent first

  // Limit to 50 for performance
  const toRender = routable.slice(0, 50);

  // Lazy-load any that need it
  await Promise.all(
    toRender.map(async (activity) => {
      if (!activity.route_points && activity._gpxLoader) {
        try {
          activity.route_points = await activity._gpxLoader();
        } catch (e) {
          console.warn(`Failed to load GPX for ${activity.name}:`, e);
          activity.route_points = [];
        }
      }
    })
  );

  // Draw polylines
  const allLatLngs = [];
  _renderedPolylines = [];
  _renderedActivities = [];

  for (const activity of toRender) {
    const pts = activity.route_points;
    if (!pts || pts.length < 2) continue;

    const color = TYPE_COLORS[activity.type] || TYPE_COLORS.Other;
    const latLngs = pts
      .filter(p => p.lat !== null && p.lng !== null)
      .map(p => [p.lat, p.lng]);

    if (latLngs.length < 2) continue;

    const polyline = L.polyline(latLngs, {
      color,
      weight: 2,
      opacity: 0.6,
    });

    polyline.addTo(_routeLayerGroup);
    allLatLngs.push(...latLngs);
    _renderedPolylines.push(polyline);
    _renderedActivities.push(activity);
  }

  // Fit map to all rendered routes
  if (allLatLngs.length > 0) {
    try {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [20, 20] });
    } catch (e) {
      // ignore bounds errors
    }
  }
}
