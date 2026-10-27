/**
 * views/map-view.js
 * The Map view: the heatmap, route hover/select card, legends, and the folded
 * tools strip (Locations / By Month / Timelapse).
 *
 * The Map view is the map, so the routes themselves are the interface: hover
 * previews one, click pins it in a card with the numbers and a way into the full
 * detail page. Selection is a pointer at one activity, independent of filters.
 */

import { state, scoped, filtered, emit } from '../core/state.js';
import { navigate } from '../core/router.js';
import { escapeHtml, MONTH_SHORT, safeStorage } from '../core/util.js';
import {
  formatDistance, formatDuration, formatElevation, formatEffort, formatDate,
} from '../core/format.js';
import { syncNavHeight, showToast } from '../core/ui.js';
import { setCollapsed } from '../core/collapse.js';
import {
  initHeatmap, renderHeatmap, routeStyle, styleColor, setHeatStyle, getHeatStyle,
  getFrequencyRamp, getFrequencyRange, raiseHotRoutes, setRouteHandlers, highlightRoute,
  clearHighlight, zoomToRoute, _renderedPolylines, _renderedActivities, TYPE_COLORS,
} from '../map/heatmap.js';
import { saveRoutes, savedRouteIds } from '../core/store.js';

/** @type {object|null} Pinned route, if any */
let selectedRoute = null;
/** Signature of the activity set currently drawn, to know when a full redraw is due. */
let drawnKey = '';
let renderToken = 0;

const TYPE_ORDER = ['Run', 'Ride', 'Walk', 'Hike', 'Swim', 'Other'];

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════

/** Draw (or update) the map for the current scope + filters. */
export async function renderMapView() {
  const el = document.getElementById('heatmap');
  if (!el) return;

  if (!state.heatmap) {
    const center = await getInitialMapCenter();
    state.heatmap = initHeatmap(el, center ? { center, zoom: 11 } : {});
    state.heatmap.on('click', clearRouteSelection);
  }

  const visible = scoped();
  const key = visible.map(a => a.id).join('|');
  const token = ++renderToken;

  if (key !== drawnKey) {
    drawnKey = key;
    clearRouteSelection();
    await renderHeatmap(visible, state.heatmap);
    if (token !== renderToken) return;
    persistLoadedRoutes(visible);
    renderLocationsPanel();
  }

  applyHeatmapFilter(filtered());
  renderMonthsTab();
  invalidateMap();
}

export function invalidateMap() {
  setTimeout(() => { try { state.heatmap?.invalidateSize(); } catch { /* map not visible yet */ } }, 80);
}

/** Force the next render to redraw every route (mode or dataset changed). */
export function resetMapDrawing() { drawnKey = ''; }

/**
 * Save trackpoints that arrived from a fresh parse so the next visit can skip
 * re-parsing. Routes restored from IndexedDB are already there and skipped.
 */
async function persistLoadedRoutes(list) {
  try {
    const have = await savedRouteIds();
    const entries = list
      .filter(a => a.route_points && a.route_points.length && !have.has(a.id))
      .map(a => ({ id: a.id, points: a.route_points }));
    // Merged secondaries share a route with their primary; save those under their own id too.
    if (entries.length) await saveRoutes(entries);
  } catch (e) { console.warn('route persistence failed', e); }
}

async function getInitialMapCenter() {
  const routable = scoped().filter(a => a.has_route || a.route_points);
  for (const act of routable.slice(0, 25)) {
    if (!act.route_points && typeof act._gpxLoader === 'function') {
      try { act.route_points = await act._gpxLoader(); } catch { continue; }
    }
    const p = act.route_points?.find(x => x.lat !== null && x.lng !== null);
    if (p) return [p.lat, p.lng];
  }
  return null;
}

function applyHeatmapFilter(list) {
  if (!_renderedPolylines.length) { renderMapLegend(); return; }
  const ids = new Set(list.map(a => a.id));
  const f = state.filters;
  const hasFilter = f.type !== 'All' || f.month || f.search || f.duplicatesOnly || f.from || f.to;

  for (let i = 0; i < _renderedPolylines.length; i++) {
    const act = _renderedActivities[i];
    const poly = _renderedPolylines[i];
    if (!poly || !act) continue;
    const color = styleColor(act, state.dark);
    if (!hasFilter || ids.has(act.id)) poly.setStyle({ color, ...routeStyle(state.dark, act) });
    else poly.setStyle({ color, weight: 1, opacity: 0.07 });
  }
  raiseHotRoutes();
  renderMapLegend();
}

export function restyleMapForTheme() {
  applyHeatmapFilter(filtered());
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE SELECTION CARD
// ═════════════════════════════════════════════════════════════════════════════

function routeCardEls() {
  return {
    card: document.getElementById('route-card'),
    type: document.getElementById('route-card-type'),
    name: document.getElementById('route-card-name'),
    date: document.getElementById('route-card-date'),
    stats: document.getElementById('route-card-stats'),
    actions: document.getElementById('route-card-actions'),
    hint: document.getElementById('route-card-hint'),
    close: document.getElementById('btn-route-clear'),
  };
}

function renderRouteCard(activity, { pinned }) {
  const els = routeCardEls();
  if (!els.card || !activity) return;

  els.card.hidden = false;
  els.card.classList.toggle('previewing', !pinned);
  els.type.textContent = activity.type;
  els.type.style.background = TYPE_COLORS[activity.type] || TYPE_COLORS.Other;
  els.name.textContent = activity.name;
  els.date.textContent = [
    formatDate(activity.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    (activity.sources || [activity.source]).join(' + '),
  ].filter(Boolean).join(' · ');

  const rows = [
    ['Distance', formatDistance(activity.distance_m)],
    ['Time', formatDuration(activity.moving_s || activity.duration_s)],
    [activity.type === 'Ride' ? 'Speed' : 'Pace', formatEffort(activity)],
    ['Climb', formatElevation(activity.elevation_gain_m)],
  ];
  if (activity.avg_heart_rate) rows.push(['Avg HR', `${activity.avg_heart_rate} bpm`]);
  if (typeof activity._freqScore === 'number' && activity._freqScore > 0) {
    rows.push(['Shared by', `${activity._freqScore} ${activity._freqScore === 1 ? 'activity' : 'activities'}`]);
  }
  els.stats.innerHTML = rows.map(([label, value]) => `
    <div>
      <span class="route-card-stat-lbl">${escapeHtml(label)}</span>
      <span class="route-card-stat-val">${escapeHtml(value)}</span>
    </div>`).join('');

  els.actions.hidden = !pinned;
  els.close.hidden = !pinned;
  els.hint.textContent = pinned ? 'Esc or the map background clears this' : 'Click the route to pin it';
}

function hideRouteCard() {
  const { card } = routeCardEls();
  if (card) card.hidden = true;
}

function previewRoute(activity, entering) {
  if (entering) {
    highlightRoute(activity, { preview: true });
    renderRouteCard(activity, { pinned: false });
  } else if (selectedRoute) {
    highlightRoute(selectedRoute, { preview: false });
    renderRouteCard(selectedRoute, { pinned: true });
  } else {
    clearHighlight();
    hideRouteCard();
  }
}

function selectRoute(activity) {
  selectedRoute = activity;
  highlightRoute(activity, { preview: false });
  renderRouteCard(activity, { pinned: true });
}

export function clearRouteSelection() {
  selectedRoute = null;
  clearHighlight();
  hideRouteCard();
}

export const hasRouteSelection = () => !!selectedRoute;

function initRouteInteraction() {
  setRouteHandlers({
    onHover: previewRoute,
    onSelect: (activity) => {
      if (selectedRoute && selectedRoute.id === activity.id) clearRouteSelection();
      else selectRoute(activity);
    },
  });
  document.getElementById('btn-route-clear')?.addEventListener('click', clearRouteSelection);
  document.getElementById('btn-route-detail')?.addEventListener('click', () => {
    if (selectedRoute) navigate('activity', selectedRoute.id);
  });
  document.getElementById('btn-route-zoom')?.addEventListener('click', () => {
    if (selectedRoute) zoomToRoute(selectedRoute);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// FULL-SCREEN MAP
// ═════════════════════════════════════════════════════════════════════════════

export function setMapFullscreen(on) {
  document.body.classList.toggle('map-fullscreen', on);
  // Measure after the class lands: full-screen drops the brand on narrow screens.
  requestAnimationFrame(syncNavHeight);

  const btn = document.getElementById('btn-map-fullscreen');
  if (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('.map-icon-label').textContent = on ? 'Exit full map' : 'Expand map';
    btn.title = on ? 'Back to the normal layout (Esc)' : 'Fill the screen with the map (F, or Esc to exit)';
  }
  if (on) window.scrollTo({ top: 0, behavior: 'auto' });
  invalidateMap();
}

export const isMapFullscreen = () => document.body.classList.contains('map-fullscreen');
export const toggleMapFullscreen = () => setMapFullscreen(!isMapFullscreen());

// ═════════════════════════════════════════════════════════════════════════════
// LEGENDS
// ═════════════════════════════════════════════════════════════════════════════

function renderMapLegend() {
  const freqMode = getHeatStyle() === 'frequency';
  const typeEl = document.getElementById('map-legend-type');
  const freqEl = document.getElementById('map-legend-freq');
  if (!typeEl || !freqEl) return;

  if (_renderedActivities.length === 0) { typeEl.hidden = true; freqEl.hidden = true; return; }
  typeEl.hidden = freqMode;
  freqEl.hidden = !freqMode;

  if (freqMode) {
    document.getElementById('map-legend-ramp').style.background =
      `linear-gradient(90deg, ${getFrequencyRamp(state.dark).join(', ')})`;
    const { min, max } = getFrequencyRange();
    document.getElementById('map-legend-min').textContent = `${min} visit${min === 1 ? '' : 's'}`;
    document.getElementById('map-legend-max').textContent = `${max} visits`;
    return;
  }

  // Only list the types actually on the map, so the legend stays honest.
  const present = new Set(_renderedActivities.map(a => a.type));
  const items = TYPE_ORDER.filter(t => present.has(t));
  document.getElementById('map-legend-type-items').innerHTML = (items.length ? items : TYPE_ORDER).map(t => `
    <span class="map-legend-item">
      <span class="map-legend-swatch" style="background:${TYPE_COLORS[t] || TYPE_COLORS.Other}"></span>${t}
    </span>`).join('');
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPLORE STRIP (Locations / By Month / Timelapse)
// ═════════════════════════════════════════════════════════════════════════════

function initExplorePanel() {
  const tabs = [...document.querySelectorAll('.etab')];
  const select = (btn) => {
    // The strip starts collapsed to leave the map alone; picking a tab is a
    // request to see it, so open it rather than switching a hidden pane.
    if (document.getElementById('explore-panel')?.classList.contains('collapsed')) {
      setCollapsed('explore', false, invalidateMap);
    }
    tabs.forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.etab-pane').forEach(p => p.classList.toggle('active', p.id === `etab-${btn.dataset.tab}`));
  };
  tabs.forEach(btn => {
    btn.addEventListener('click', () => select(btn));
    btn.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(btn);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (next) { e.preventDefault(); next.focus(); select(next); }
    });
  });
}

function renderMonthsTab() {
  const container = document.getElementById('etab-months');
  if (!container) return;

  const yearMap = new Map();
  for (const a of filtered({ ignoreMonth: true })) {
    const y = a.date.getFullYear();
    if (!yearMap.has(y)) yearMap.set(y, new Array(12).fill(0));
    yearMap.get(y)[a.date.getMonth()]++;
  }
  const years = [...yearMap.keys()].sort((a, b) => b - a);

  let out = '';
  if (state.filters.month) out += '<button class="month-clear-btn" id="btn-month-clear">&#x2715; Show all months</button>';
  for (const year of years) {
    const counts = yearMap.get(year);
    const max = Math.max(1, ...counts);
    out += `<div class="month-year-label">${year}</div><div class="month-grid">`;
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${m}`;
      const pct = Math.round((counts[m] / max) * 100);
      out += `<button class="month-cell ${state.filters.month === key ? 'active' : ''} ${counts[m] === 0 ? 'empty' : ''}"
        data-key="${key}" aria-pressed="${state.filters.month === key}" title="${MONTH_SHORT[m]} ${year}: ${counts[m]} activities">
        <span class="mc-bar" style="height:${pct}%"></span>
        <span class="mc-name">${MONTH_SHORT[m]}</span>
        <span class="mc-count">${counts[m] || ''}</span>
      </button>`;
    }
    out += '</div>';
  }
  container.innerHTML = out || '<div class="muted-note">No activities in view.</div>';

  container.querySelectorAll('.month-cell:not(.empty)').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (state.filters.month === key) {
        state.filters.month = null;
      } else {
        state.filters.month = key;
        const [y, m] = key.split('-').map(Number);
        const pts = scoped()
          .filter(a => a.date.getFullYear() === y && a.date.getMonth() === m)
          .flatMap(a => (a.route_points || []).filter((_, k) => k % 10 === 0))
          .filter(p => p.lat && p.lng)
          .map(p => [p.lat, p.lng]);
        if (pts.length > 1 && state.heatmap) {
          try { state.heatmap.fitBounds(L.latLngBounds(pts), { padding: [30, 30], animate: true }); } catch { /* ignore */ }
        }
      }
      emit('filters');
    });
  });
  container.querySelector('#btn-month-clear')?.addEventListener('click', () => {
    state.filters.month = null;
    emit('filters');
  });
}

// ── Timelapse ────────────────────────────────────────────────────────────────

let tlIdx = 0;
let tlTimer = null;
let tlRoutes = [];

const tlSortedRoutes = () => _renderedActivities
  .map((a, i) => ({ i, date: a.date }))
  .filter(x => x.date)
  .sort((a, b) => a.date - b.date)
  .map(x => x.i);

function tlUpdateUI(step) {
  const bar = document.getElementById('tl-progress-bar');
  const label = document.getElementById('tl-date-label');
  const count = document.getElementById('tl-count-label');
  if (!bar) return;
  bar.style.width = `${tlRoutes.length > 1 ? (step / (tlRoutes.length - 1)) * 100 : 100}%`;
  const act = _renderedActivities[tlRoutes[step]];
  if (act && label) label.textContent = formatDate(act.date);
  if (count) count.textContent = `${step + 1} / ${tlRoutes.length}`;
}

function tlStep() {
  if (tlIdx >= tlRoutes.length) { tlStop(); return; }
  const idx = tlRoutes[tlIdx];
  const poly = _renderedPolylines[idx];
  const act = _renderedActivities[idx];
  if (!poly || !act) { tlIdx++; tlStep(); return; }

  // Flash in bright, then settle to normal visible opacity
  poly.setStyle({ color: state.dark ? '#ffffff' : '#111111', weight: 4, opacity: 1 });
  setTimeout(() => poly.setStyle({ color: styleColor(act, state.dark), ...routeStyle(state.dark, act) }), 300);

  tlUpdateUI(tlIdx);
  tlIdx++;
  const speed = parseInt(document.getElementById('tl-speed')?.value || '3', 10);
  tlTimer = setTimeout(tlStep, Math.max(40, 500 / speed));
}

function tlPrepare() {
  if (_renderedActivities.length === 0) { showToast('Load activities with routes first'); return false; }
  clearRouteSelection();
  tlRoutes = tlSortedRoutes();
  if (!tlRoutes.length) { showToast('No routable activities to animate'); return false; }
  for (const p of _renderedPolylines) p?.setStyle({ opacity: 0, weight: 2 });
  tlIdx = 0;
  tlUpdateUI(0);
  return true;
}

function tlPlay() {
  if (tlTimer) return;
  if (tlIdx === 0 || tlIdx >= tlRoutes.length) if (!tlPrepare()) return;
  const btn = document.getElementById('tl-play-btn');
  if (btn) btn.innerHTML = '&#9646;&#9646; Pause';
  tlStep();
}

function tlPause() {
  clearTimeout(tlTimer);
  tlTimer = null;
  const btn = document.getElementById('tl-play-btn');
  if (btn) btn.innerHTML = '&#9654; Play';
}

export function tlStop() {
  clearTimeout(tlTimer);
  tlTimer = null;
  tlIdx = 0;
  tlRoutes = [];
  const btn = document.getElementById('tl-play-btn');
  if (btn) btn.innerHTML = '&#9654; Play';
  const bar = document.getElementById('tl-progress-bar');
  if (bar) bar.style.width = '0%';
  const label = document.getElementById('tl-date-label');
  if (label) label.textContent = 'Press Play to animate routes chronologically';
  const count = document.getElementById('tl-count-label');
  if (count) count.textContent = '';
  for (let i = 0; i < _renderedPolylines.length; i++) {
    const act = _renderedActivities[i];
    if (act) _renderedPolylines[i]?.setStyle({ color: styleColor(act, state.dark), ...routeStyle(state.dark, act) });
  }
}

// ── Most visited places ──────────────────────────────────────────────────────

const geocodeCache = new Map();

/**
 * Name a place via OpenStreetMap's Nominatim. This sends one coordinate per
 * region to a third party, so it only ever runs after the user opts in.
 */
async function reverseGeocode(lat, lng) {
  const key = `${lat},${lng}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  let name;
  try {
    // zoom=7 gives region/county level without pinning to a specific town
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=7`,
      { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('nominatim error');
    const addr = (await res.json()).address || {};
    const region = addr.state_district || addr.region || null;
    const st = addr.state || addr.province || null;
    const country = addr.country_code?.toUpperCase();
    if (region && st && region !== st) name = `${region}, ${st}`;
    else if (st) name = country === 'US' ? st : `${st}, ${country}`;
    else name = addr.country || coordLabel(lat, lng);
  } catch { name = coordLabel(lat, lng); }
  geocodeCache.set(key, name);
  return name;
}

const coordLabel = (lat, lng) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;

function computeLocationClusters(activities, limit = 10) {
  const counts = new Map();
  const centers = new Map();
  for (const act of activities) {
    const p = act.route_points?.find(x => x.lat !== null && x.lng !== null);
    if (!p) continue;
    // Cluster on a 2° grid (~220km) — wide enough to keep a metro region together.
    const key = `${Math.round(p.lat * 0.5) / 0.5},${Math.round(p.lng * 0.5) / 0.5}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    // Represent the cell with a real activity point, not the rounded cell corner.
    if (!centers.has(key)) centers.set(key, { lat: p.lat, lng: p.lng });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, count]) => ({ key, count, ...centers.get(key) }));
}

async function renderLocationsPanel() {
  const container = document.getElementById('locations-list');
  if (!container) return;
  const routable = _renderedActivities.filter(a => a.route_points && a.route_points.length > 0);
  if (!routable.length) { container.innerHTML = '<div class="muted-note">No GPS routes loaded yet.</div>'; return; }

  const clusters = computeLocationClusters(routable);
  const named = safeStorage.get('fitness-geocode-ok') === '1';
  const maxCount = clusters[0]?.count || 1;

  for (const c of clusters) c.name = named ? await reverseGeocode(c.lat, c.lng) : coordLabel(c.lat, c.lng);

  container.innerHTML = clusters.map((loc, i) => `
    <button type="button" class="loc-row" data-lat="${loc.lat}" data-lng="${loc.lng}" title="Zoom the map here">
      <span class="loc-rank">${i + 1}</span>
      <span class="loc-info">
        <span class="loc-name">${escapeHtml(loc.name)}</span>
        <span class="loc-bar-wrap"><span class="loc-bar" style="width:${Math.round((loc.count / maxCount) * 100)}%"></span></span>
      </span>
      <span class="loc-count">${loc.count}</span>
    </button>`).join('') + (named ? '' : `
    <div class="loc-consent">
      <p>Places are shown as coordinates so nothing leaves your device.
      <button type="button" class="bs-btn bs-btn-secondary" id="btn-name-places">Name these places</button></p>
      <p class="muted-note">Naming sends one coordinate per area to OpenStreetMap&rsquo;s Nominatim service.</p>
    </div>`);

  container.querySelectorAll('.loc-row').forEach(row => {
    row.addEventListener('click', () => {
      const lat = parseFloat(row.dataset.lat), lng = parseFloat(row.dataset.lng);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) state.heatmap?.setView([lat, lng], 11, { animate: true });
    });
  });
  container.querySelector('#btn-name-places')?.addEventListener('click', () => {
    safeStorage.set('fitness-geocode-ok', '1');
    renderLocationsPanel();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════

export function initMapView() {
  initRouteInteraction();
  initExplorePanel();

  document.getElementById('btn-map-fullscreen')?.addEventListener('click', toggleMapFullscreen);

  document.getElementById('tl-play-btn')?.addEventListener('click', () => (tlTimer ? tlPause() : tlPlay()));
  document.getElementById('tl-reset-btn')?.addEventListener('click', tlStop);
  document.getElementById('tl-speed')?.addEventListener('input', (e) => {
    const val = document.getElementById('tl-speed-val');
    if (val) val.textContent = `${e.target.value}×`;
  });

  document.querySelectorAll('.hm-style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      if (getHeatStyle() === style) return;
      setHeatStyle(style);
      document.querySelectorAll('.hm-style-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      applyHeatmapFilter(filtered()); // also refreshes the legend
    });
  });
}
