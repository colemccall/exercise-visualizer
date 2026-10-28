/**
 * app.js
 * Fitness Visualizer — entry point and orchestrator.
 *
 * This file owns only the shell: the nav, the three experience modes, the theme
 * and unit toggles, routing between views, and the upload dialog. Each view
 * lives in views/*.js and renders from the shared store in core/state.js; data
 * parsing lives in parsers/*.js and core/upload.js.
 *
 * External globals (vendored under /vendor, loaded by classic <script> tags):
 *   L (Leaflet), JSZip, d3
 */

import { state, on, emit, scoped, mergedCount } from './core/state.js';
import {
  MODES, MODE_IDS, getMode, setMode, restoreMode, modeAvailable, viewAllowed,
} from './core/modes.js';
import { startRouter, navigate, hrefFor, parseHash } from './core/router.js';
import { safeStorage } from './core/lib/util.js';
import { getUnits, setUnits } from './core/lib/format.js';
import {
  syncNavHeight, showToast, openModal, anyModalOpen,
} from './core/lib/ui.js';
import { initCollapsibles } from './core/lib/collapse.js';
import {
  setupUploadZones, parseStaged, restoreSaved, saveRoutesInBackground, deleteAllData,
  rematchPhotos, rebuildMerge,
} from './core/data/upload.js';
import { MODEL } from './core/data/store.js';
import { icon, BRAND_MARK } from './components/icons.js';
import { setHeatmapTheme } from './map/heatmap.js';
import { renderPhotosList } from './photos/list.js';
import { renderPhotosDetail } from './photos/detail.js';

import { renderToday } from './views/today.js';
import { renderFeed, resetFeedPaging } from './views/feed.js';
import { renderActivity, destroyActivity, setActivityHandlers } from './views/activity.js';
import { renderAwards } from './views/awards.js';
import { renderProfile } from './views/profile.js';
import { renderStatsView, initStatsView, redrawCharts } from './views/stats-view.js';
import {
  renderMapView, initMapView, invalidateMap, resetMapDrawing, clearRouteSelection,
  hasRouteSelection, isMapFullscreen, setMapFullscreen, toggleMapFullscreen, restyleMapForTheme, tlStop,
} from './views/map-view.js';

// ═════════════════════════════════════════════════════════════════════════════
// VIEW REGISTRY + ROUTING
// ═════════════════════════════════════════════════════════════════════════════

const VIEW_ICON = { today: 'today', feed: 'feed', map: 'map', awards: 'awards', charts: 'charts', profile: 'profile', photos: 'photos' };
const KNOWN_VIEWS = new Set(['today', 'feed', 'activity', 'map', 'awards', 'profile', 'charts', 'photos']);

const renderers = {
  today: () => renderToday({ openUpload }),
  feed: renderFeed,
  map: renderMapView,
  awards: renderAwards,
  profile: renderProfile,
  charts: renderStatsView,
  photos: renderPhotosView,
};

let currentView = null;
let currentParam = null;
const dirty = new Set(Object.keys(renderers));

/** Nav tab that should look active for a view (sub-views light up their parent). */
function navTabFor(view) {
  const nav = getMode().nav.map(n => n.view);
  if (view === 'activity') return 'feed';
  if (nav.includes(view)) return view;
  if (view === 'charts' && nav.includes('profile')) return 'profile';
  return null;
}

function resolveView(view) {
  if (!KNOWN_VIEWS.has(view)) return getMode().landing;
  // A view the current mode has no tab for is still reachable by link; only
  // views with nothing to show for this data fall back to the landing view.
  if (view === 'today' && !state.summaries.length && getMode().id === 'strava') return getMode().landing;
  return view;
}

async function onRoute({ view, param }) {
  if (!state.activities.length && !state.summaries.length) { openUpload(); return; }
  const target = resolveView(view || getMode().landing);
  if (target !== view) { navigate(target, null, { replace: true }); return; }
  await showView(target, param);
}

async function showView(view, param = null) {
  const leaving = currentView;
  if (leaving === 'activity' && (view !== 'activity' || param !== currentParam)) destroyActivity();
  if (leaving === 'map' && view !== 'map') { tlStop(); if (isMapFullscreen()) setMapFullscreen(false); }

  currentView = view;
  currentParam = param;

  // Active states
  const tab = navTabFor(view);
  document.querySelectorAll('#nav-tabs .nav-tab').forEach(t => {
    const on = t.dataset.view === tab;
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    t.classList.toggle('active', on);
  });

  const isPhotos = view === 'photos';
  document.getElementById('photos-screen').classList.toggle('visible', isPhotos);
  document.getElementById('dashboard-screen').classList.toggle('visible', !isPhotos);
  document.querySelectorAll('#dashboard-screen > .app-view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  document.body.classList.toggle('view-map-active', view === 'map');
  document.body.dataset.view = view;
  syncNavHeight();

  // Render (the view must be visible first: Leaflet and D3 measure their container)
  try {
    if (view === 'activity') await renderActivity(param);
    else if (renderers[view] && (dirty.has(view) || view === 'map')) { dirty.delete(view); await renderers[view](); }
  } catch (e) {
    console.error(`Rendering "${view}" failed`, e);
    showToast('Something went wrong drawing this view. Check the console for details.', { error: true });
  }

  if (view === 'map') invalidateMap();
  if (view === 'charts') redrawCharts();
  if (leaving !== view || leaving === 'activity') window.scrollTo({ top: 0, behavior: 'auto' });
}

/** Something the active view shows has changed: mark everything stale, redraw what's visible. */
function refresh() {
  Object.keys(renderers).forEach(v => dirty.add(v));
  if (!state.activities.length && !state.summaries.length) return;
  if (currentView) showView(currentView, currentParam);
}

on('data', () => { syncWelcome(); resetMapDrawing(); resetFeedPaging(); buildChrome(); updatePhotosBadge(); showMergeBanner(); refresh(); });
on('filters', refresh);
on('theme', () => { restyleMapForTheme(); if (currentView === 'activity') showView('activity', currentParam); });
on('units', refresh);
on('mode', () => { resetMapDrawing(); resetFeedPaging(); buildChrome(); updatePhotosBadge(); showMergeBanner(); refresh(); });

// ═════════════════════════════════════════════════════════════════════════════
// CHROME: nav tabs, mode switch, theme, menu
// ═════════════════════════════════════════════════════════════════════════════

function buildChrome() {
  const mode = getMode();
  document.body.dataset.mode = mode.id;
  document.getElementById('app-nav').classList.add('visible');

  // Tabs (links, so they work with middle-click and keyboard)
  document.getElementById('nav-tabs').innerHTML = mode.nav.map(n => `
    <a class="nav-tab" data-view="${n.view}" href="${hrefFor(n.view)}" ${n.view === 'photos' ? 'id="nav-tab-photos"' : ''}>
      ${icon(VIEW_ICON[n.view] || 'feed')}<span>${n.label}</span>${n.view === 'photos' ? '<span class="nav-badge" id="nav-photos-badge" hidden></span>' : ''}
    </a>`).join('');

  // Mode switch
  document.getElementById('mode-switch').innerHTML = MODE_IDS.map(id => {
    const ok = modeAvailable(id, state.has);
    const title = ok ? MODES[id].blurb : `${MODES[id].label} view needs ${MODES[id].source === 'apple' ? 'an Apple Health' : 'a Strava'} export`;
    return `<button type="button" role="radio" aria-checked="${mode.id === id}" data-mode="${id}" ${ok ? '' : 'disabled'} title="${title}">${MODES[id].label}</button>`;
  }).join('');

  updatePhotosBadge();
  syncNavHeight();
}

function wireChrome() {
  document.getElementById('brand-mark').innerHTML = BRAND_MARK;
  document.getElementById('btn-menu').innerHTML = icon('menu');
  document.getElementById('btn-open-upload').innerHTML = `${icon('upload', { size: 18 })}<span>Add or replace data</span>`;
  document.getElementById('btn-delete-data').innerHTML = `${icon('trash', { size: 18 })}<span>Delete my data</span>`;

  document.getElementById('mode-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.disabled) return;
    setMode(b.dataset.mode, state.has);
    const m = getMode();
    // If the current view doesn't exist in the new mode, land somewhere sensible.
    if (!viewAllowed(currentView, m) && currentView !== 'charts') navigate(m.landing, null, { replace: true });
    emit('mode');
  });

  // Theme: light by default; dark is a choice that sticks.
  document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);

  // Settings menu
  const menuBtn = document.getElementById('btn-menu');
  const pop = document.getElementById('menu-pop');
  const setMenu = (open) => {
    pop.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) pop.querySelector('button')?.focus();
  };
  menuBtn.addEventListener('click', () => setMenu(pop.hidden));
  document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); menuBtn.focus(); } });

  document.getElementById('btn-metric').addEventListener('click', () => pickUnits('metric'));
  document.getElementById('btn-imperial').addEventListener('click', () => pickUnits('imperial'));
  syncUnitButtons();

  document.getElementById('btn-open-upload').addEventListener('click', () => { setMenu(false); openUpload(); });

  // Two-step delete: first click arms it, second confirms.
  const del = document.getElementById('btn-delete-data');
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.querySelector('span').textContent = 'Click again to delete everything';
      armed = setTimeout(() => { armed = null; del.querySelector('span').textContent = 'Delete my data'; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null;
    del.querySelector('span').textContent = 'Delete my data';
    setMenu(false);
    await deleteAllData();
    resetMapDrawing();
    if (state.heatmap) { try { state.heatmap.remove(); } catch { /* gone */ } state.heatmap = null; }
    document.getElementById('app-nav').classList.remove('visible');
    document.querySelectorAll('#dashboard-screen > .app-view').forEach(v => v.classList.remove('active'));
    history.replaceState(null, '', location.pathname);
    showToast('All saved data deleted from this browser.');
    syncWelcome();
    openUpload();
  });
}

function pickUnits(next) {
  setUnits(next, true);
  syncUnitButtons();
  emit('units');
}

function syncUnitButtons() {
  const u = getUnits();
  const m = document.getElementById('btn-metric'), i = document.getElementById('btn-imperial');
  m.classList.toggle('active', u === 'metric'); i.classList.toggle('active', u === 'imperial');
  m.setAttribute('aria-pressed', String(u === 'metric')); i.setAttribute('aria-pressed', String(u === 'imperial'));
}

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.classList.toggle('dark-mode', state.dark);
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    btn.innerHTML = icon(state.dark ? 'sun' : 'moon');
    btn.setAttribute('aria-pressed', String(state.dark));
    btn.setAttribute('aria-label', state.dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = state.dark ? 'Light mode' : 'Dark mode';
  }
  setHeatmapTheme(state.dark);
}

function toggleTheme() {
  state.dark = !state.dark;
  safeStorage.set('fitness-theme', state.dark ? 'dark' : 'light');
  applyTheme();
  emit('theme');
}

// ═════════════════════════════════════════════════════════════════════════════
// MERGE BANNER
// ═════════════════════════════════════════════════════════════════════════════

let bannerDismissedFor = -1;

function showMergeBanner() {
  const banner = document.getElementById('duplicate-banner');
  if (!banner) return;
  const n = mergedCount();
  const show = getMode().id === 'hybrid' && n > 0 && bannerDismissedFor !== n;
  banner.hidden = !show;
  document.getElementById('dup-count').textContent = n.toLocaleString();
  syncNavHeight();
}

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD DIALOG
// ═════════════════════════════════════════════════════════════════════════════

let closeUploadDialog = null;

/** First run (or after deleting data): show a way back to the upload dialog, never a blank page. */
function syncWelcome() {
  const w = document.getElementById('welcome');
  if (w) w.hidden = state.activities.length > 0 || state.summaries.length > 0;
}

function openUpload() {
  if (closeUploadDialog) return;
  const backdrop = document.getElementById('upload-modal-backdrop');
  const dialog = document.getElementById('upload-screen');
  closeUploadDialog = openModal(backdrop, dialog, () => { closeUploadDialog = null; });
}

function closeUpload() { closeUploadDialog?.(); }

async function runUpload() {
  const { loaded, errors } = await parseStaged();
  if (!state.activities.length && !state.summaries.length) return; // nothing usable; stay in the dialog with the error shown
  if (errors.length) { showToast(`Some files had problems: ${errors.join('; ')}`, { error: true }); return; }

  closeUpload();
  restoreMode(state.has);
  buildChrome();
  showToast(`Loaded ${loaded.toLocaleString()} activities${state.photos.length ? ` · ${state.photoMatch.matched} photos matched` : ''}`);
  navigate(getMode().landing, null, { replace: true });
  saveRoutesInBackground();
}

// ═════════════════════════════════════════════════════════════════════════════
// PHOTOS
// ═════════════════════════════════════════════════════════════════════════════

function updatePhotosBadge() {
  const badge = document.getElementById('nav-photos-badge');
  const n = state.photoMatch?.matched || 0;
  if (badge) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
  const tab = document.getElementById('nav-tab-photos');
  if (tab) {
    tab.setAttribute('aria-disabled', String(n === 0));
    tab.title = n ? '' : 'Add photos or videos from the menu to build a Photo Tour';
  }
}

function renderPhotosView() {
  const body = document.getElementById('photos-screen-body');
  renderPhotosList(body, state.photoMatch.activitiesWithPhotos, {
    bufferMinutes: state.photoBuffer,
    totalPhotos: state.photos.length,
    unmatched: state.photoMatch.unmatched,
    onBufferChange: async (n) => {
      state.photoBuffer = n;
      await rematchPhotos();
      updatePhotosBadge();
      renderPhotosView();
    },
    onOpen: (a) => showPhotosDetail(a),
  });
}

async function showPhotosDetail(activity) {
  const body = document.getElementById('photos-screen-body');
  await renderPhotosDetail(body, activity, { onBack: () => renderPhotosView() });
}

// ═════════════════════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Theme: light unless the user chose dark.
  state.dark = safeStorage.get('fitness-theme') === 'dark';

  wireChrome();
  applyTheme();
  setupUploadZones();
  initCollapsibles((key) => {
    if (key === 'explore') invalidateMap();
    else redrawCharts();
  });
  initStatsView();
  initMapView();

  document.getElementById('btn-go').addEventListener('click', runUpload);
  document.getElementById('btn-welcome-upload').addEventListener('click', openUpload);
  document.getElementById('btn-close-upload').addEventListener('click', closeUpload);
  document.getElementById('upload-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'upload-modal-backdrop') closeUpload();
  });
  document.getElementById('btn-photos-back').addEventListener('click', () => navigate(getMode().landing));

  document.getElementById('btn-dup-review').addEventListener('click', () => {
    state.filters.duplicatesOnly = true;
    navigate('feed');
    emit('filters');
  });
  document.getElementById('btn-dup-dismiss').addEventListener('click', () => {
    bannerDismissedFor = mergedCount();
    showMergeBanner();
  });

  // Photos tab is only useful with matched photos; keep the link but explain.
  document.getElementById('nav-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('#nav-tab-photos');
    if (tab && tab.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      showToast('Add photos or videos (menu → Add or replace data) to build a Photo Tour.');
    }
  });

  setActivityHandlers({
    openPhotos: (a) => { navigate('photos'); showPhotosDetail(a); },
  });

  // Keyboard: Esc steps back one layer; F toggles the full-screen map.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
    if (e.key === 'Escape' && !anyModalOpen()) {
      if (hasRouteSelection()) clearRouteSelection();
      else if (isMapFullscreen()) setMapFullscreen(false);
    } else if ((e.key === 'f' || e.key === 'F') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && currentView === 'map') {
      e.preventDefault();
      toggleMapFullscreen();
    }
  });

  window.addEventListener('resize', () => { syncNavHeight(); });
  startRouter(onRoute);

  // Restore a previous visit, or ask for data.
  const restored = await restoreSaved();
  if (restored) {
    restoreMode(state.has);
    buildChrome();
    updatePhotosBadge();
    showMergeBanner();
    const { view } = parseHash();
    await onRoute({ view: view || getMode().landing, param: parseHash().param });
    saveRoutesInBackground();
    // Data saved by an older parser lacks weather, effort, steps and exact merging.
    if (state.dataModel !== null && state.dataModel < MODEL && !safeStorage.get(`fitness-model-hint:${MODEL}`)) {
      safeStorage.set(`fitness-model-hint:${MODEL}`, '1');
      showToast('New details (weather, effort, steps) need a fresh import: re-upload your exports once from the ⋯ menu.', { duration: 10000 });
    }
  } else {
    syncWelcome();
    openUpload();
  }
});
