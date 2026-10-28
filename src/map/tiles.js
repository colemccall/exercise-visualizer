/**
 * map/tiles.js
 * Basemaps shared by the heatmap and the single-route map, and the user's choice.
 *
 *   light      Esri World_Light_Gray_Base to z16, then OpenStreetMap to z20. The neutral
 *              canvas routes read best against. (The default.)
 *   dark       the same tiles, inverted in CSS (.bm-dark): one provider, every zoom.
 *   terrain    OpenTopoMap (contours and hillshading). Native to z17.
 *   satellite  Esri World_Imagery. Native to z19.
 *
 * CARTO's basemaps.cartocdn.com is deliberately not used: it now stamps
 * "API KEY REQUIRED" across keyless tiles.
 *
 * PROVIDER TERMS: all of these are keyless public tile endpoints, which is fine for a
 * personal tool but not a licence for heavy or commercial traffic. Check the current
 * terms before relying on them at scale:
 *   - Esri's basemap services increasingly expect an ArcGIS Location Platform API key;
 *     keep the attribution below and consider a key if this site gets real traffic.
 *   - OpenStreetMap's tile usage policy (operations.osmfoundation.org/policies/tiles)
 *     forbids heavy use and bulk fetching and requires visible attribution; it offers
 *     no SLA.
 *   - OpenTopoMap is volunteer-run (CC-BY-SA data, attribution required) and asks for
 *     light use.
 * Dark mode inverts the light tiles in CSS rather than swapping providers.
 */

import { safeStorage } from '../core/lib/util.js';

export const ESRI_GRAY  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const OSM_DETAIL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OPEN_TOPO  = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';

export const MAX_MAP_ZOOM = 20;

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const BASEMAPS = {
  light:     { label: 'Light' },
  dark:      { label: 'Dark' },
  terrain:   { label: 'Terrain' },
  satellite: { label: 'Satellite' },
};

export function getBasemap() {
  const v = safeStorage.get('fitness-basemap');
  return BASEMAPS[v] ? v : 'light';
}
export function setBasemap(kind) {
  if (BASEMAPS[kind]) safeStorage.set('fitness-basemap', kind);
}

/** Tile layers for a basemap kind, in draw order. Requires the Leaflet global `L`. */
export function makeTileLayers(kind = getBasemap()) {
  if (kind === 'terrain') {
    return [L.tileLayer(OPEN_TOPO, {
      subdomains: 'abc', maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 17,
      attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    })];
  }
  if (kind === 'satellite') {
    return [L.tileLayer(ESRI_IMAGERY, {
      maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    })];
  }
  // light and dark share tiles; .bm-dark inverts them in CSS
  return [
    L.tileLayer(ESRI_GRAY, {
      maxZoom: 17,            // hands over to the detail layer
      maxNativeZoom: 16,      // Esri has nothing past 16; upscale the last half-step
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community',
    }),
    L.tileLayer(OSM_DETAIL, { minZoom: 16.5, maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 19, attribution: OSM_ATTR }),
  ];
}

/** Put a basemap on a map: swaps the tile layers and tags the container for CSS. */
export function applyBasemap(map, kind = getBasemap(), previous = []) {
  previous.forEach(l => { try { map.removeLayer(l); } catch { /* already gone */ } });
  const layers = makeTileLayers(kind);
  layers.forEach(l => { l.addTo(map); l.bringToBack(); });
  const el = map.getContainer();
  Object.keys(BASEMAPS).forEach(k => el.classList.toggle(`bm-${k}`, k === kind));
  return layers;
}
