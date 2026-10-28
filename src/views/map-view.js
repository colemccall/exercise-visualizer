/**
 * views/map-view.js
 * The Map view: the heatmap, route hover/select card, legends, and the folded
 * tools strip (Locations / By Month / Timelapse).
 *
 * The Map view is the map, so the routes themselves are the interface: hover
 * previews one, click pins it in a card with the numbers and a way into the full
 * detail page. Selection is a pointer at one activity, independent of filters.
 */

import { state, scoped, filtered, emit, isFiltered, clearFilters, sortActivities } from '../core/state.js';
import { navigate } from '../core/router.js';
import { escapeHtml, MONTH_SHORT, safeStorage } from '../core/lib/util.js';
import {
  formatDistance, formatDuration, formatElevation, formatEffort, formatDate,
} from '../core/lib/format.js';
import { syncNavHeight, showToast } from '../core/lib/ui.js';
import { setCollapsed, isCollapsed } from '../core/lib/collapse.js';
import {
  initHeatmap, renderHeatmap, routeStyle, styleColor, setHeatStyle, getHeatStyle,
  getFrequencyRamp, getFrequencyRange, raiseHotRoutes, setRouteHandlers, highlightRoute,
  clearHighlight, zoomToRoute, _renderedPolylines, _renderedActivities, TYPE_COLORS,
  computeFrequency, setHeatmapBasemap,
} from '../map/heatmap.js';
import { getBasemap, setBasemap } from '../map/tiles.js';
import { saveRoutes, savedRouteIds } from '../core/data/store.js';

/** @type {object|null} Pinned route, if any */
let selectedRoute = null;
/** Signature of the activity set currently drawn, to know when a full redraw is due. */
let drawnKey = '';
let renderToken = 0;
/** Activities inside the box drawn with "Select area" (null = no area). */
let areaIds = null;
let areaRect = null;
let areaMode = false;
let areaStart = null;

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
    bindAreaDrag(state.heatmap);
    const bm = document.getElementById('map-basemap');
    if (bm) bm.value = getBasemap();
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

/** Ids of the routes that pass the filters (and the drawn area, if any). */
function matchingIds(list = filtered()) {
  const ids = new Set(list.map(a => a.id));
  if (areaIds) for (const id of [...ids]) if (!areaIds.has(id)) ids.delete(id);
  return ids;
}

function applyHeatmapFilter(list) {
  if (!_renderedPolylines.length) { renderMapLegend(); renderMapFilters(); renderActivitiesList(); return; }
  const ids = matchingIds(list);
  const hasFilter = isFiltered() || !!areaIds;

  // Frequency is "how many activities share this road": measured over the activities
  // you're looking at, so filtering to 2024 shows 2024's habits, not all-time.
  if (getHeatStyle() === 'frequency') {
    computeFrequency(hasFilter ? _renderedActivities.filter(a => ids.has(a.id)) : _renderedActivities);
  }

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
  renderMapFilters();
  renderActivitiesList();
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
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  els.hint.textContent = pinned ? (touch ? 'Tap the map background to clear' : 'Esc or the map background clears this') : (touch ? 'Tap a route to pin it' : 'Click the route to pin it');
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

function selectRoute(activity, latlng) {
  selectedRoute = activity;
  highlightRoute(activity, { preview: false });
  renderRouteCard(activity, { pinned: true });
  renderRoutePick(activity, latlng);
  renderActivitiesList();
}

/** Every drawn route under a tap/click, so a busy junction doesn't hide all but the top line. */
function routesAt(latlng) {
  if (!state.heatmap || !latlng) return [];
  const pt = state.heatmap.latLngToLayerPoint(latlng);
  const ids = matchingIds();
  const out = [];
  for (let i = 0; i < _renderedPolylines.length; i++) {
    const a = _renderedActivities[i], p = _renderedPolylines[i];
    if (!a || !p || !ids.has(a.id)) continue;
    try { if (p._containsPoint && p._containsPoint(pt)) out.push(a); } catch { /* not drawn yet */ }
  }
  return out;
}

function renderRoutePick(activity, latlng) {
  const box = document.getElementById('route-card-pick');
  if (!box) return;
  const others = routesAt(latlng).filter(a => a.id !== activity.id).sort((a, b) => b.date - a.date).slice(0, 8);
  box.hidden = !others.length;
  box.innerHTML = others.length ? `<div class="route-pick-title">${others.length} other route${others.length === 1 ? '' : 's'} here</div>` +
    others.map(a => `<button type="button" data-pick="${escapeHtml(a.id)}">${escapeHtml(a.name)} · ${escapeHtml(formatDate(a.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</button>`).join('') : '';
  box.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    const a = b && _renderedActivities.find(x => x.id === b.dataset.pick);
    if (a) selectRoute(a, null);
  };
}

export function clearRouteSelection() {
  selectedRoute = null;
  clearHighlight();
  hideRouteCard();
  const pick = document.getElementById('route-card-pick');
  if (pick) pick.hidden = true;
  renderActivitiesList();
}

export const hasRouteSelection = () => !!selectedRoute;

function initRouteInteraction() {
  setRouteHandlers({
    onHover: previewRoute,
    onSelect: (activity, e) => {
      if (selectedRoute && selectedRoute.id === activity.id) clearRouteSelection();
      else selectRoute(activity, e?.latlng);
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

  // Only list the types actually on the map, so the legend stays honest; each is a
  // button that filters to that type (and back), with the number of routes.
  const counts = {};
  for (const a of _renderedActivities) counts[a.type] = (counts[a.type] || 0) + 1;
  const items = TYPE_ORDER.filter(t => counts[t]);
  const active = state.filters.types.length === 1 ? state.filters.types[0] : state.filters.type;
  document.getElementById('map-legend-type-items').innerHTML = (items.length ? items : TYPE_ORDER).map(t => `
    <button type="button" class="map-legend-item" data-legend-type="${t}" aria-pressed="${active === t}" title="Show only ${t} routes">
      <span class="map-legend-swatch" style="background:${TYPE_COLORS[t] || TYPE_COLORS.Other}"></span>${t}
      <span class="map-legend-count">${counts[t] || 0}</span>
    </button>`).join('');
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

let tlIdx = 0;          // how many routes are currently revealed
let tlTimer = null;
let tlRoutes = [];      // indices into _renderedActivities, oldest first (only routes passing the filters)

const tlSortedRoutes = () => {
  const ids = matchingIds();
  return _renderedActivities
    .map((a, i) => ({ i, date: a.date, id: a.id }))
    .filter(x => x.date && ids.has(x.id))
    .sort((a, b) => a.date - b.date)
    .map(x => x.i);
};

const normalStyle = (act, poly) => poly.setStyle({ color: styleColor(act, state.dark), ...routeStyle(state.dark, act) });

function tlUpdateUI(shown) {
  const bar = document.getElementById('tl-progress-bar');
  const label = document.getElementById('tl-date-label');
  const count = document.getElementById('tl-count-label');
  const scrub = document.getElementById('tl-scrub');
  if (!bar) return;
  bar.style.width = `${tlRoutes.length > 0 ? (shown / tlRoutes.length) * 100 : 0}%`;
  const act = _renderedActivities[tlRoutes[Math.max(0, shown - 1)]];
  if (label) label.textContent = act && shown > 0 ? formatDate(act.date) : 'Press Play, or drag the slider';
  if (count) count.textContent = tlRoutes.length ? `${shown} / ${tlRoutes.length}` : '';
  if (scrub) { scrub.max = String(tlRoutes.length); scrub.value = String(shown); }
}

/** Show the first `n` routes of the sequence at normal strength and hide the rest. */
function tlShowUpTo(n) {
  const inSeq = new Set(tlRoutes);
  tlRoutes.forEach((idx, k) => {
    const poly = _renderedPolylines[idx], act = _renderedActivities[idx];
    if (!poly || !act) return;
    if (k < n) normalStyle(act, poly); else poly.setStyle({ opacity: 0, weight: 2 });
  });
  // routes the filters exclude stay faint, as on the static map
  _renderedPolylines.forEach((poly, idx) => { if (!inSeq.has(idx) && poly) poly.setStyle({ weight: 1, opacity: 0.07 }); });
}

function tlStep() {
  if (tlIdx >= tlRoutes.length) { tlPause(); return; }
  const idx = tlRoutes[tlIdx];
  const poly = _renderedPolylines[idx];
  const act = _renderedActivities[idx];
  tlIdx++;
  if (poly && act) {
    // Flash in bright, then settle to normal visible opacity
    poly.setStyle({ color: state.dark ? '#ffffff' : '#111111', weight: 4, opacity: 1 });
    setTimeout(() => normalStyle(act, poly), 300);
  }
  tlUpdateUI(tlIdx);
  const speed = parseInt(document.getElementById('tl-speed')?.value || '3', 10);
  tlTimer = setTimeout(tlStep, Math.max(40, 500 / speed));
}

function tlPrepare() {
  if (_renderedActivities.length === 0) { showToast('Load activities with routes first'); return false; }
  clearRouteSelection();
  tlRoutes = tlSortedRoutes();
  if (!tlRoutes.length) { showToast('No routes match the current filters'); return false; }
  tlIdx = 0;
  tlShowUpTo(0);
  tlUpdateUI(0);
  return true;
}

function tlPlay() {
  if (tlTimer) return;
  if (!tlRoutes.length || tlIdx >= tlRoutes.length) if (!tlPrepare()) return;
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

/** Jump to "n routes revealed" (scrubber, step buttons). */
function tlSeek(n) {
  tlPause();
  if (!tlRoutes.length && !tlPrepare()) return;
  tlIdx = Math.max(0, Math.min(tlRoutes.length, n));
  tlShowUpTo(tlIdx);
  tlUpdateUI(tlIdx);
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
  if (label) label.textContent = 'Press Play, or drag the slider';
  const count = document.getElementById('tl-count-label');
  if (count) count.textContent = '';
  const scrub = document.getElementById('tl-scrub');
  if (scrub) { scrub.max = '0'; scrub.value = '0'; }
  applyHeatmapFilter(filtered());
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
// MAP FILTER BAR (same filters as the search box)
// ═════════════════════════════════════════════════════════════════════════════

function renderMapFilters() {
  const chips = document.getElementById('map-chips');
  if (!chips) return;
  const all = scoped();
  const types = ['All', ...TYPE_ORDER.filter(t => all.some(a => a.type === t))];
  const active = state.filters.types.length === 1 ? state.filters.types[0] : state.filters.types.length ? null : state.filters.type;
  chips.innerHTML = types.map(t => `<button type="button" class="chip" data-map-type="${t}" aria-pressed="${active === t}">${t}</button>`).join('');

  const yearSel = document.getElementById('map-year');
  if (yearSel) {
    const years = [...new Set(all.map(a => a.date.getFullYear()))].sort((a, b) => b - a);
    yearSel.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${y}" ${state.filters.year === y ? 'selected' : ''}>${y}</option>`).join('');
  }

  const ids = matchingIds();
  const shown = _renderedActivities.filter(a => ids.has(a.id)).length;
  const count = document.getElementById('map-count');
  if (count) count.textContent = _renderedActivities.length ? `${shown.toLocaleString()} of ${_renderedActivities.length.toLocaleString()} routes` : '';
  const clear = document.getElementById('map-clear');
  if (clear) clear.hidden = !(isFiltered() || areaIds);
}

/** Zoom to the routes currently shown (sampling points: this only needs a bounding box). */
function fitToFiltered() {
  if (!state.heatmap) return;
  const ids = matchingIds();
  const pts = [];
  for (const a of _renderedActivities) {
    if (!ids.has(a.id) || !a.route_points) continue;
    for (let k = 0; k < a.route_points.length; k += 8) {
      const p = a.route_points[k];
      if (p.lat !== null && p.lng !== null) pts.push([p.lat, p.lng]);
    }
  }
  if (pts.length < 2) { showToast('No routes match the current filters.'); return; }
  try { state.heatmap.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 }); } catch { /* degenerate bounds */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITIES LIST (side panel): the routes on the map, as a list
// ═════════════════════════════════════════════════════════════════════════════

const LIST_LIMIT = 150;

function renderActivitiesList() {
  const box = document.getElementById('map-activities');
  if (!box) return;
  const ids = matchingIds();
  const items = sortActivities(_renderedActivities.filter(a => ids.has(a.id)), state.filters.sort);

  const summary = document.getElementById('map-area-summary');
  if (summary) {
    summary.hidden = !areaIds;
    if (areaIds) {
      const dist = items.reduce((t, a) => t + (a.distance_m || 0), 0);
      const secs = items.reduce((t, a) => t + (a.moving_s || a.duration_s || 0), 0);
      summary.innerHTML = `<span><strong>${items.length.toLocaleString()}</strong> in this area · ${escapeHtml(formatDistance(dist))} · ${escapeHtml(formatDuration(secs))}</span><button type="button" class="map-mini-btn" id="area-clear-btn">Clear area</button>`;
    }
  }

  if (!_renderedActivities.length) { box.innerHTML = '<div class="muted-note">Routes appear here once they load.</div>'; return; }
  if (!items.length) { box.innerHTML = '<div class="muted-note">No routes match the current filters.</div>'; return; }
  box.innerHTML = items.slice(0, LIST_LIMIT).map(a => `
    <button type="button" class="act-row-btn ${selectedRoute && selectedRoute.id === a.id ? 'sel' : ''}" data-act="${escapeHtml(a.id)}">
      <span class="dot" style="background:${TYPE_COLORS[a.type] || TYPE_COLORS.Other}"></span>
      <span><span class="nm">${escapeHtml(a.name)}</span><span class="sub">${escapeHtml(formatDate(a.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</span></span>
      <span class="val">${escapeHtml(formatDistance(a.distance_m))}</span>
    </button>`).join('') + (items.length > LIST_LIMIT ? `<div class="map-list-more">Showing ${LIST_LIMIT} of ${items.length.toLocaleString()}. Filter to narrow it down.</div>` : '');
}

function initActivitiesList() {
  const box = document.getElementById('map-activities');
  const find = (el) => { const b = el.closest('[data-act]'); return b && _renderedActivities.find(a => a.id === b.dataset.act); };
  box?.addEventListener('mouseover', (e) => { const a = find(e.target); if (a) previewRoute(a, true); });
  box?.addEventListener('mouseout', (e) => { const a = find(e.target); if (a) previewRoute(a, false); });
  box?.addEventListener('focusin', (e) => { const a = find(e.target); if (a) previewRoute(a, true); });
  box?.addEventListener('focusout', (e) => { const a = find(e.target); if (a) previewRoute(a, false); });
  box?.addEventListener('click', (e) => {
    const a = find(e.target);
    if (a) { selectRoute(a, null); zoomToRoute(a); }
  });
  document.getElementById('map-area-summary')?.addEventListener('click', (e) => { if (e.target.closest('#area-clear-btn')) clearArea(); });
}

// ═════════════════════════════════════════════════════════════════════════════
// SELECT AREA: draw a box, see the activities that pass through it
// ═════════════════════════════════════════════════════════════════════════════

function bboxOf(a) {
  if (a._bbox) return a._bbox;
  let s2 = 90, w = 180, n = -90, e2 = -180;
  for (const p of a.route_points || []) {
    if (p.lat === null || p.lng === null) continue;
    if (p.lat < s2) s2 = p.lat; if (p.lat > n) n = p.lat;
    if (p.lng < w) w = p.lng; if (p.lng > e2) e2 = p.lng;
  }
  return (a._bbox = { s: s2, w, n, e: e2 });
}

/** Activities with a route point inside `bounds` (box test first, then every 3rd point). */
function activitiesInBounds(bounds) {
  const south = bounds.getSouth(), north = bounds.getNorth(), west = bounds.getWest(), east = bounds.getEast();
  const ids = new Set();
  for (const a of _renderedActivities) {
    if (!a.route_points?.length) continue;
    const b = bboxOf(a);
    if (b.n < south || b.s > north || b.e < west || b.w > east) continue;
    for (let k = 0; k < a.route_points.length; k += 3) {
      const p = a.route_points[k];
      if (p.lat !== null && p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east) { ids.add(a.id); break; }
    }
  }
  return ids;
}

function setAreaMode(on) {
  areaMode = on;
  const map = state.heatmap;
  document.getElementById('btn-map-area')?.setAttribute('aria-pressed', String(on));
  const lbl = document.querySelector('#btn-map-area .map-icon-label');
  if (lbl) lbl.textContent = on ? 'Drag a box…' : 'Select area';
  if (!map) return;
  map.getContainer().classList.toggle('area-select', on);
  if (on) map.dragging.disable(); else map.dragging.enable();
}

function clearArea() {
  areaIds = null;
  if (areaRect && state.heatmap) { state.heatmap.removeLayer(areaRect); areaRect = null; }
  setAreaMode(false);
  applyHeatmapFilter(filtered());
}

function initAreaSelect() {
  document.getElementById('btn-map-area')?.addEventListener('click', () => {
    if (areaIds) { clearArea(); return; }
    setAreaMode(!areaMode);
  });
}

/** Called once the Leaflet map exists: pointer events work for mouse, pen and touch. */
function bindAreaDrag(map) {
  const el = map.getContainer();
  el.addEventListener('pointerdown', (e) => {
    if (!areaMode || e.button > 0) return;
    e.preventDefault();
    areaStart = map.mouseEventToLatLng(e);
    if (areaRect) { map.removeLayer(areaRect); areaRect = null; }
    areaRect = L.rectangle([areaStart, areaStart], { className: 'area-rect', interactive: false, color: '#c2410c', weight: 2, dashArray: '6 4', fillOpacity: 0.12 }).addTo(map);
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!areaMode || !areaStart || !areaRect) return;
    areaRect.setBounds(L.latLngBounds(areaStart, map.mouseEventToLatLng(e)));
  });
  const finish = (e) => {
    if (!areaMode || !areaStart || !areaRect) return;
    const bounds = areaRect.getBounds();
    const sw = map.latLngToContainerPoint(bounds.getSouthWest()), ne = map.latLngToContainerPoint(bounds.getNorthEast());
    areaStart = null;
    el.releasePointerCapture?.(e.pointerId);
    if (Math.abs(sw.x - ne.x) < 12 || Math.abs(sw.y - ne.y) < 12) { map.removeLayer(areaRect); areaRect = null; return; }   // a click, not a box
    areaIds = activitiesInBounds(bounds);
    setAreaMode(false);
    document.querySelector('.etab[data-tab="activities"]')?.click();
    applyHeatmapFilter(filtered());
    if (!areaIds.size) showToast('No routes pass through that box.');
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════

export function initMapView() {
  initRouteInteraction();
  initExplorePanel();
  initActivitiesList();
  initAreaSelect();

  // Filters on the map
  document.getElementById('map-filters')?.addEventListener('click', (e) => {
    const t = e.target.closest('[data-map-type]');
    if (t) { state.filters.type = t.dataset.mapType; state.filters.types = []; emit('filters'); }
    if (e.target.closest('#map-fit')) fitToFiltered();
    if (e.target.closest('#map-clear')) { clearFilters(); if (areaIds) clearArea(); emit('filters'); }
  });
  document.getElementById('map-year')?.addEventListener('change', (e) => { state.filters.year = e.target.value ? +e.target.value : null; emit('filters'); });
  document.getElementById('map-legend-type-items')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-legend-type]');
    if (!b) return;
    const cur = state.filters.types.length === 1 ? state.filters.types[0] : state.filters.type;
    state.filters.type = cur === b.dataset.legendType ? 'All' : b.dataset.legendType;
    state.filters.types = [];
    emit('filters');
  });

  // Basemap + side panel
  document.getElementById('map-basemap')?.addEventListener('change', (e) => { setBasemap(e.target.value); setHeatmapBasemap(e.target.value); });
  const tools = document.getElementById('btn-map-tools');
  const syncTools = () => tools?.setAttribute('aria-pressed', String(!isCollapsed('explore')));
  syncTools();
  tools?.addEventListener('click', () => { setCollapsed('explore', !isCollapsed('explore'), invalidateMap); syncTools(); });

  // Timelapse scrubber and step
  document.getElementById('tl-scrub')?.addEventListener('input', (e) => tlSeek(+e.target.value));
  document.getElementById('tl-prev')?.addEventListener('click', () => tlSeek(tlIdx - 1));
  document.getElementById('tl-next')?.addEventListener('click', () => tlSeek(tlIdx + 1));

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
