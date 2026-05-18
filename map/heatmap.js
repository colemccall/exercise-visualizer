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

// Activity type → polyline color
const TYPE_COLORS = {
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

/**
 * Initialize the Leaflet heatmap.
 * @param {HTMLElement} container  DOM element for the map
 * @returns {L.Map}
 */
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

  // OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
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
      weight: 1.5,
      opacity: 0.35,
    });

    polyline.addTo(_routeLayerGroup);
    allLatLngs.push(...latLngs);
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
