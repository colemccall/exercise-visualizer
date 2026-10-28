/**
 * map/tiles.js
 * The one basemap definition, shared by the heatmap and the single-route map.
 *
 * Two stacked layers, because no single keyless source does both jobs well:
 *
 *   z0-16  Esri's World_Light_Gray_Base — the clean neutral canvas routes read
 *          best against. Its tiles stop at z16 ("a few city blocks"), which is
 *          why the map used to refuse to go closer.
 *   z17-20 OpenStreetMap standard tiles — native to z19, upscaled one step to
 *          z20, so you can zoom right down to which side of the street a route
 *          ran on.
 *
 * CARTO's basemaps.cartocdn.com is deliberately not used: it now stamps
 * "API KEY REQUIRED" across keyless tiles.
 *
 * Dark mode inverts the tile pane in CSS (html.dark-mode .leaflet-tile-pane)
 * rather than swapping providers — one basemap, consistent at every zoom.
 */

export const ESRI_GRAY  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const OSM_DETAIL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const MAX_MAP_ZOOM = 20;

const BASE_OPTS = {
  maxZoom: 17,        // hands over to the detail layer
  maxNativeZoom: 16,  // Esri has nothing past 16; upscale the last half-step
  attribution: 'Tiles &copy; Esri',
};
const DETAIL_OPTS = {
  minZoom: 16.5,
  maxZoom: MAX_MAP_ZOOM,
  maxNativeZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

/** Both basemap layers, in draw order. Requires the Leaflet global `L`. */
export function makeTileLayers() {
  return [
    L.tileLayer(ESRI_GRAY, BASE_OPTS),
    L.tileLayer(OSM_DETAIL, DETAIL_OPTS),
  ];
}
