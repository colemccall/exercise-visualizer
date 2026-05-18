/**
 * app.js
 * Fitness Activity Visualizer — main application entry point.
 *
 * Responsibilities:
 *   - Upload handling (drag-and-drop + click-to-browse for 3 sources)
 *   - Orchestrate parsers (strava, apple, garmin)
 *   - Merge activity lists, run deduplication
 *   - Manage filter state (type, date range)
 *   - Unit toggle (metric / imperial), stored in localStorage
 *   - Render activity list, stats bar, charts, heatmap
 *   - Activity detail modal (lazy GPX load, route map, charts)
 *
 * External globals assumed present (CDN):
 *   L        (Leaflet)
 *   JSZip    (jszip)
 *   d3       (D3 v7, loaded as ESM re-export below)
 */

// ── D3 ESM import — makes `d3` available as a global for chart modules ────────
import * as _d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
window.d3 = _d3;

// ── Parser imports ────────────────────────────────────────────────────────────
import { parse as parseStrava }  from './parsers/strava.js';
import { parse as parseApple }   from './parsers/apple.js';

// ── Chart imports ─────────────────────────────────────────────────────────────
import { renderDistanceChart }  from './charts/distance.js';
import { renderWeeklyChart }    from './charts/weekly.js';
import { renderHRZones }        from './charts/hr-zones.js';
import { renderElevationChart, renderHRLineChart } from './charts/elevation.js';

// ── Map imports ───────────────────────────────────────────────────────────────
import { initHeatmap, renderHeatmap, _renderedPolylines, _renderedActivities, TYPE_COLORS } from './map/heatmap.js';
import { renderRoute }                from './map/route.js';

// ═════════════════════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════════════════════

/** @type {Activity[]} All loaded activities (across all sources) */
let allActivities = [];

/** @type {'metric'|'imperial'} */
let units = localStorage.getItem('fitness-units') || 'metric';

/** Current filter state */
const filters = {
  type: 'All',
  from: null,
  to: null,
  search: '',
  duplicatesOnly: false,
};

/** Leaflet heatmap instance */
let heatmapInstance = null;

/** Currently open detail activity */
let detailRouteMap = null;

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD HANDLING — stage files per source, parse all on "Go"
// ═════════════════════════════════════════════════════════════════════════════

const SOURCES = ['strava', 'apple'];
const PARSERS = { strava: parseStrava, apple: parseApple };

/** Staged (not yet parsed) files per source */
const stagedFiles = { strava: [], apple: [], garmin: [] };

function setupUploadZone(source) {
  const zone  = document.getElementById(`zone-${source}`);
  const input = document.getElementById(`file-${source}`);

  zone.addEventListener('click', (e) => {
    if (e.target.closest('details')) return;
    if (e.target.closest('label')) return;
    input.click();
  });

  input.addEventListener('change', () => {
    if (input.files.length > 0) stageFiles(source, Array.from(input.files));
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) stageFiles(source, files);
  });
}

function stageFiles(source, files) {
  stagedFiles[source] = files;
  updateZoneUI(source);
  updateGoButton();
}

function updateZoneUI(source) {
  const files = stagedFiles[source];
  const zone  = document.getElementById(`zone-${source}`);
  const sub   = document.getElementById(`sub-${source}`);
  const fileList = document.getElementById(`filelist-${source}`);

  if (files.length > 0) {
    zone.classList.add('staged');
    zone.classList.remove('loaded');
    sub.textContent = files.length === 1 ? files[0].name : `${files.length} files selected`;
    if (fileList) {
      fileList.innerHTML = files.map(f =>
        `<div class="staged-file">&#128196; ${escapeHtml(f.name)}</div>`
      ).join('');
    }
  } else {
    zone.classList.remove('staged', 'loaded');
    sub.textContent = source === 'strava' ? 'Choose ZIP file' : 'Choose file';
    if (fileList) fileList.innerHTML = '';
  }
}

function updateGoButton() {
  const total = SOURCES.reduce((n, s) => n + stagedFiles[s].length, 0);
  const btn   = document.getElementById('btn-go');
  const count = document.getElementById('go-file-count');
  if (!btn) return;

  if (total > 0) {
    btn.disabled = false;
    btn.classList.add('ready');
    const srcNames = SOURCES.filter(s => stagedFiles[s].length > 0)
      .map(s => `${stagedFiles[s].length} ${s}`).join(', ');
    if (count) count.textContent = srcNames;
  } else {
    btn.disabled = true;
    btn.classList.remove('ready');
    if (count) count.textContent = '';
  }
}

async function parseAllStaged() {
  const btn = document.getElementById('btn-go');
  if (btn) btn.disabled = true;

  const sourcesToParse = SOURCES.filter(s => stagedFiles[s].length > 0);
  if (sourcesToParse.length === 0) return;

  showProgress(0, 'Starting…');

  let totalNew = 0;
  const errors = [];

  for (let si = 0; si < sourcesToParse.length; si++) {
    const source = sourcesToParse[si];
    const files  = stagedFiles[source];
    const parser = PARSERS[source];
    const baseProgress = Math.round((si / sourcesToParse.length) * 90);
    const sliceSize    = Math.round(90 / sourcesToParse.length);

    let newActivities = [];

    try {
      for (let fi = 0; fi < files.length; fi++) {
        const partial = await parser(files[fi], (p, label) => {
          showProgress(baseProgress + Math.round((p / 100) * sliceSize), label);
        });
        newActivities = newActivities.concat(partial);
      }
    } catch (err) {
      console.error(`Error parsing ${source}:`, err);
      errors.push(`${source}: ${err.message}`);
      continue;
    }

    allActivities = allActivities.filter(a => a.source !== source);
    allActivities = allActivities.concat(newActivities);
    totalNew += newActivities.length;

    // Mark zone as loaded
    document.getElementById(`zone-${source}`)?.classList.replace('staged', 'loaded');
    document.getElementById(`sub-${source}`).textContent = `${newActivities.length} loaded`;
  }

  showProgress(95, 'Checking for duplicates…');
  flagDuplicates(allActivities);

  showProgress(100, 'Done!');
  setTimeout(hideProgress, 600);

  if (errors.length) showToast(`Errors: ${errors.join('; ')}`);
  else showToast(`Loaded ${totalNew.toLocaleString()} activities`);

  showDashboard();
}

// ═════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Flag activities where:
 *   - date within 5 minutes of another activity from a different source
 *   - distance within 5% of that other activity
 *
 * Sets has_duplicate: true on both activities. Does not delete either.
 *
 * @param {Activity[]} activities  Modified in-place
 */
function flagDuplicates(activities) {
  // Allow up to 10 minutes time difference — clocks & GPS sync vary between devices
  const MS_10_MIN = 10 * 60 * 1000;

  for (const a of activities) {
    a.has_duplicate = false;
    a.duplicate_of  = null;
  }

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];

      if (a.source === b.source) continue;
      if (!a.date || !b.date) continue;
      if (a.type !== b.type) continue; // different activity types can't be the same workout

      const timeDiff = Math.abs(a.date - b.date);
      if (timeDiff > MS_10_MIN) continue;

      // Primary: distance match within 10%
      const distA = a.distance_m;
      const distB = b.distance_m;
      let isDupe = false;

      if (distA > 100 && distB > 100) {
        // Both have meaningful distance — compare it
        const larger    = Math.max(distA, distB);
        const smaller   = Math.min(distA, distB);
        const distRatio = (larger - smaller) / larger;
        if (distRatio <= 0.10) isDupe = true;
      } else if (distA < 100 && distB < 100) {
        // Neither has distance (e.g. strength training) — match by duration within 10%
        if (a.duration_s > 60 && b.duration_s > 60) {
          const durLarger  = Math.max(a.duration_s, b.duration_s);
          const durSmaller = Math.min(a.duration_s, b.duration_s);
          if ((durLarger - durSmaller) / durLarger <= 0.10) isDupe = true;
        }
      }
      // If one has distance and the other doesn't, we can't reliably match — skip

      if (isDupe) {
        a.has_duplicate = true;
        b.has_duplicate = true;
        if (!a.duplicate_of) a.duplicate_of = b.id;
        if (!b.duplicate_of) b.duplicate_of = a.id;
      }
    }
  }
}

function getDuplicateCount() {
  // Count unique pairs, not individual flagged activities
  const seen = new Set();
  let pairs = 0;
  for (const a of allActivities) {
    if (a.has_duplicate && a.duplicate_of && !seen.has(a.id) && !seen.has(a.duplicate_of)) {
      seen.add(a.id);
      seen.add(a.duplicate_of);
      pairs++;
    }
  }
  return pairs;
}

// ═════════════════════════════════════════════════════════════════════════════
// FILTERING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply current filters to allActivities.
 * @returns {Activity[]}  Filtered subset, sorted newest first
 */
function getFilteredActivities() {
  const term = filters.search.toLowerCase().trim();
  return allActivities
    .filter(a => {
      if (filters.type !== 'All' && a.type !== filters.type) return false;
      if (filters.from && a.date < filters.from) return false;
      if (filters.to) {
        const toEnd = new Date(filters.to);
        toEnd.setHours(23, 59, 59, 999);
        if (a.date > toEnd) return false;
      }
      if (term && !a.name.toLowerCase().includes(term) && !a.type.toLowerCase().includes(term)) return false;
      if (filters.duplicatesOnly && !a.has_duplicate) return false;
      return true;
    })
    .sort((a, b) => b.date - a.date);
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIT CONVERSION HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function formatDistance(metres) {
  if (units === 'imperial') {
    const miles = metres / 1609.344;
    return miles >= 10 ? `${miles.toFixed(1)} mi` : `${miles.toFixed(2)} mi`;
  }
  const km = metres / 1000;
  return km >= 10 ? `${km.toFixed(1)} km` : `${km.toFixed(2)} km`;
}

function formatElevation(metres) {
  if (metres === null || metres === undefined) return '—';
  if (units === 'imperial') return `${Math.round(metres * 3.28084)} ft`;
  return `${Math.round(metres)} m`;
}

function formatMovingTime(seconds) {
  const h = Math.floor(seconds / 3600);
  if (h >= 100) return `${h.toLocaleString()}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatPace(distance_m, duration_s) {
  if (!distance_m || !duration_s) return '—';
  if (units === 'imperial') {
    const miles = distance_m / 1609.344;
    const secPerMile = duration_s / miles;
    const m = Math.floor(secPerMile / 60);
    const s = Math.floor(secPerMile % 60);
    return `${m}:${String(s).padStart(2,'0')} /mi`;
  }
  const km = distance_m / 1000;
  const secPerKm = duration_s / km;
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}:${String(s).padStart(2,'0')} /km`;
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD RENDERING
// ═════════════════════════════════════════════════════════════════════════════

const TYPE_ICONS = {
  Run:   '🏃',
  Ride:  '🚴',
  Walk:  '🚶',
  Hike:  '🥾',
  Swim:  '🏊',
  Other: '⚡',
};

function showDashboard() {
  document.getElementById('upload-screen').style.display = 'none';
  const dash = document.getElementById('dashboard-screen');
  dash.classList.add('visible');

  refreshDashboard();
  showDuplicateBanner();

  setTimeout(() => {
    if (heatmapInstance) heatmapInstance.invalidateSize();
  }, 150);
}

function showDuplicateBanner() {
  const banner = document.getElementById('duplicate-banner');
  if (!banner) return;

  const pairs = getDuplicateCount();
  if (pairs === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  document.getElementById('dup-count').textContent = pairs;
}

function dismissDuplicateBanner() {
  const banner = document.getElementById('duplicate-banner');
  if (banner) banner.style.display = 'none';
}

function refreshDashboard() {
  const filtered = getFilteredActivities();

  updateSourceBadges();
  updateStatsBar(filtered);
  renderActivityList(filtered);
  renderCharts(filtered);

  // Heatmap: only refresh on major changes (all activities, not filtered)
  refreshHeatmap();
}

function updateSourceBadges() {
  const sources = [...new Set(allActivities.map(a => a.source))];
  const container = document.getElementById('dash-source-badges');
  container.innerHTML = sources.map(s => {
    const count = allActivities.filter(a => a.source === s).length;
    return `<span class="source-badge ${s}">${s} ${count}</span>`;
  }).join('');
}

function updateStatsBar(activities) {
  const totalDist = activities.reduce((sum, a) => sum + (a.distance_m || 0), 0);
  const totalElev = activities.reduce((sum, a) => sum + (a.elevation_gain_m || 0), 0);
  const totalSecs = activities.reduce((sum, a) => sum + (a.duration_s || 0), 0);

  // Avg pace — only for run/ride/walk/hike activities with both distance and time
  const paceable = activities.filter(a =>
    ['Run','Ride','Walk','Hike'].includes(a.type) && a.distance_m > 100 && a.duration_s > 0
  );
  const avgPaceStr = paceable.length > 0
    ? formatPace(
        paceable.reduce((s,a) => s + a.distance_m, 0),
        paceable.reduce((s,a) => s + a.duration_s, 0)
      )
    : '—';

  const dates = activities.map(a => a.date).filter(Boolean).sort((a,b)=>a-b);
  const rangeStr = dates.length >= 2
    ? `${dates[0].getFullYear()}–${dates[dates.length-1].getFullYear()}`
    : dates.length === 1 ? String(dates[0].getFullYear()) : '—';

  document.getElementById('stat-total').textContent     = activities.length.toLocaleString();
  document.getElementById('stat-distance').textContent  = formatDistance(totalDist);
  document.getElementById('stat-time').textContent      = formatMovingTime(totalSecs);
  document.getElementById('stat-elevation').textContent = formatElevation(totalElev);
  document.getElementById('stat-pace').textContent      = avgPaceStr;
  document.getElementById('stat-range').textContent     = rangeStr;

  const countLbl = document.getElementById('list-count-label');
  if (countLbl) countLbl.textContent = `${activities.length.toLocaleString()} activities`;
}

function renderActivityList(activities) {
  const list = document.getElementById('activity-list');
  list.innerHTML = '';

  if (activities.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No activities match your filters.</div>';
    return;
  }

  const frag = document.createDocumentFragment();

  for (const activity of activities) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.dataset.id = activity.id;

    const icon = TYPE_ICONS[activity.type] || '⚡';
    const dateStr = activity.date
      ? activity.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const hrStr = activity.avg_heart_rate ? `❤️ ${activity.avg_heart_rate}` : '';

    row.innerHTML = `
      <div class="activity-type-icon">${icon}</div>
      <div class="activity-info">
        <div class="activity-name">${escapeHtml(activity.name)}</div>
        <div class="activity-meta">${dateStr}${hrStr ? ' · ' + hrStr : ''}</div>
      </div>
      <div class="activity-stats">
        <div class="activity-dist">${formatDistance(activity.distance_m)}</div>
        <div class="activity-dur">${formatDuration(activity.duration_s)}</div>
      </div>
      <span class="activity-source-badge ${activity.source}">${activity.source}</span>
      ${activity.has_duplicate ? dupBadge(activity) : ''}
    `;

    row.addEventListener('click', () => openDetail(activity));
    frag.appendChild(row);
  }

  list.appendChild(frag);
}

function renderCharts(activities) {
  // Distance chart
  const distContainer = document.getElementById('chart-distance');
  renderDistanceChart([...activities].sort((a,b)=>a.date-b.date), distContainer, units);

  // Weekly chart
  renderWeeklyChart(activities, document.getElementById('chart-weekly'));

  // HR zones — only show if we have HR data
  const hasHR = activities.some(a => a.avg_heart_rate || (a.route_points && a.route_points.some(p => p.hr)));
  const hrCard = document.getElementById('chart-hr-card');
  if (hasHR) {
    hrCard.style.display = 'block';
    const maxHR = parseInt(document.getElementById('input-max-hr').value, 10) || 190;
    renderHRZones(activities, document.getElementById('chart-hr-zones'), maxHR);
  } else {
    hrCard.style.display = 'none';
  }
}

async function refreshHeatmap() {
  if (!heatmapInstance) {
    const container = document.getElementById('heatmap');
    heatmapInstance = initHeatmap(container);
  }
  await renderHeatmap(allActivities, heatmapInstance);
  renderLocationsPanel();
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITY DETAIL MODAL
// ═════════════════════════════════════════════════════════════════════════════

async function openDetail(activity) {
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Header
  document.getElementById('detail-name').textContent = activity.name;
  document.getElementById('detail-meta').textContent =
    [
      activity.type,
      activity.date?.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' }),
      activity.source,
    ].filter(Boolean).join(' · ');

  // Stats
  document.getElementById('dstat-distance').textContent  = formatDistance(activity.distance_m);
  document.getElementById('dstat-duration').textContent  = formatDuration(activity.duration_s);
  document.getElementById('dstat-pace').textContent      = formatPace(activity.distance_m, activity.duration_s);
  document.getElementById('dstat-elevation').textContent = formatElevation(activity.elevation_gain_m);
  document.getElementById('dstat-avg-hr').textContent    = activity.avg_heart_rate ? `${activity.avg_heart_rate} bpm` : '—';
  document.getElementById('dstat-max-hr').textContent    = activity.max_heart_rate ? `${activity.max_heart_rate} bpm` : '—';

  // Clear previous route map
  const routeContainer = document.getElementById('detail-route-map');
  routeContainer.innerHTML = '<div class="loading-spinner">Loading route…</div>';
  if (detailRouteMap) {
    detailRouteMap.remove();
    detailRouteMap = null;
  }

  // Lazy-load GPX if needed
  if (activity.has_route && !activity.route_points && activity._gpxLoader) {
    try {
      activity.route_points = await activity._gpxLoader();
    } catch (e) {
      console.warn('Failed to load route:', e);
      activity.route_points = [];
    }
  }

  // Render route map
  detailRouteMap = renderRoute(activity, routeContainer);

  // Elevation chart
  const elevSection = document.getElementById('detail-elevation-section');
  const elevContainer = document.getElementById('detail-elevation-chart');
  if (activity.route_points && activity.route_points.some(p => p.ele !== null)) {
    elevSection.style.display = 'block';
    renderElevationChart(activity.route_points, elevContainer, units);
  } else {
    elevSection.style.display = 'none';
  }

  // HR chart
  const hrSection  = document.getElementById('detail-hr-section');
  const hrContainer = document.getElementById('detail-hr-chart');
  if (activity.route_points && activity.route_points.some(p => p.hr !== null)) {
    hrSection.style.display = 'block';
    renderHRLineChart(activity.route_points, hrContainer);
  } else {
    hrSection.style.display = 'none';
  }
}

function closeDetail() {
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('open');
  document.body.style.overflow = '';

  if (detailRouteMap) {
    detailRouteMap.remove();
    detailRouteMap = null;
  }
  document.getElementById('detail-route-map').innerHTML = '';
}

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESS BAR
// ═════════════════════════════════════════════════════════════════════════════

function showProgress(pct, label) {
  const container = document.getElementById('progress-container');
  const fill      = document.getElementById('progress-fill');
  const lbl       = document.getElementById('progress-label');

  container.classList.add('visible');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  lbl.textContent  = label || 'Processing…';
}

function hideProgress() {
  document.getElementById('progress-container').classList.remove('visible');
  document.getElementById('progress-fill').style.width = '0%';
}

// ═════════════════════════════════════════════════════════════════════════════
// TOAST
// ═════════════════════════════════════════════════════════════════════════════

let _toastTimer = null;

function showToast(message, duration = 3000) {
  const el = document.getElementById('bs-toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TOGGLE
// ═════════════════════════════════════════════════════════════════════════════

function setUnits(newUnits) {
  units = newUnits;
  localStorage.setItem('fitness-units', units);

  document.getElementById('btn-metric').classList.toggle('active', units === 'metric');
  document.getElementById('btn-imperial').classList.toggle('active', units === 'imperial');

  if (allActivities.length > 0) {
    refreshDashboard();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // Upload zones + Go button
  SOURCES.forEach(setupUploadZone);
  SOURCES.forEach(s => updateZoneUI(s));
  updateGoButton();

  document.getElementById('btn-go')?.addEventListener('click', parseAllStaged);

  // Duplicate banner
  document.getElementById('btn-dup-review')?.addEventListener('click', () => {
    filters.duplicatesOnly = true;
    document.getElementById('filter-dup-only').checked = true;
    dismissDuplicateBanner();
    refreshDashboard();
  });
  document.getElementById('btn-dup-dismiss')?.addEventListener('click', dismissDuplicateBanner);

  // Duplicates filter checkbox
  document.getElementById('filter-dup-only')?.addEventListener('change', (e) => {
    filters.duplicatesOnly = e.target.checked;
    refreshDashboard();
  });

  // Unit toggle
  document.getElementById('btn-metric').addEventListener('click',   () => setUnits('metric'));
  document.getElementById('btn-imperial').addEventListener('click', () => setUnits('imperial'));
  // Apply stored units
  setUnits(units);

  // New Upload button
  document.getElementById('btn-new-upload').addEventListener('click', () => {
    document.getElementById('upload-screen').style.display = '';
    document.getElementById('dashboard-screen').classList.remove('visible');
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Search
  document.getElementById('filter-search').addEventListener('input', (e) => {
    filters.search = e.target.value;
    refreshDashboard();
  });

  // Filters
  document.getElementById('filter-type').addEventListener('change', (e) => {
    filters.type = e.target.value;
    refreshDashboard();
  });

  document.getElementById('filter-from').addEventListener('change', (e) => {
    filters.from = e.target.value ? new Date(e.target.value) : null;
    refreshDashboard();
  });

  document.getElementById('filter-to').addEventListener('change', (e) => {
    filters.to = e.target.value ? new Date(e.target.value) : null;
    refreshDashboard();
  });

  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    filters.type           = 'All';
    filters.from           = null;
    filters.to             = null;
    filters.search         = '';
    filters.duplicatesOnly = false;
    document.getElementById('filter-type').value       = 'All';
    document.getElementById('filter-from').value       = '';
    document.getElementById('filter-to').value         = '';
    document.getElementById('filter-search').value     = '';
    const cb = document.getElementById('filter-dup-only');
    if (cb) cb.checked = false;
    refreshDashboard();
  });

  // HR max input
  document.getElementById('input-max-hr').addEventListener('change', () => {
    if (allActivities.length > 0) renderCharts(getFilteredActivities());
  });

  // Detail panel close
  document.getElementById('btn-close-detail').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detail-overlay')) closeDetail();
  });

  // Keyboard close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });

  // Dark/light mode
  applyTheme();
  document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);

  // Timelapse
  document.getElementById('tl-play-btn')?.addEventListener('click', tlToggle);
  document.getElementById('tl-reset-btn')?.addEventListener('click', tlStop);
  document.getElementById('tl-speed')?.addEventListener('input', (e) => {
    const val = document.getElementById('tl-speed-val');
    if (val) val.textContent = `${e.target.value}×`;
  });

});


// ═════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function dupBadge(activity) {
  const other = activity.duplicate_of
    ? allActivities.find(a => a.id === activity.duplicate_of)
    : null;
  const label = other ? `⚠ Also in ${other.source}` : '⚠ Duplicate';
  return `<span class="duplicate-badge" title="This activity appears in multiple sources">${label}</span>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═════════════════════════════════════════════════════════════════════════════
// TIMELAPSE
// ═════════════════════════════════════════════════════════════════════════════

let tlIdx = 0;
let tlTimer = null;
let tlRoutes = []; // sorted indices into _renderedActivities

function tlGetSortedRoutes() {
  // Get indices of rendered polylines sorted by activity date
  return _renderedActivities
    .map((a, i) => ({ i, date: a.date }))
    .filter(x => x.date)
    .sort((a, b) => a.date - b.date)
    .map(x => x.i);
}

function tlUpdateUI(step) {
  const bar   = document.getElementById('tl-progress-bar');
  const label = document.getElementById('tl-date-label');
  const count = document.getElementById('tl-count-label');
  if (!bar) return;

  const pct = tlRoutes.length > 1 ? (step / (tlRoutes.length - 1)) * 100 : 100;
  bar.style.width = `${pct}%`;

  const idx = tlRoutes[step];
  const act = _renderedActivities[idx];
  if (act && label) {
    label.textContent = act.date
      ? act.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
  }
  if (count) count.textContent = `${step + 1} / ${tlRoutes.length}`;
}

function tlStep() {
  if (tlIdx >= tlRoutes.length) {
    tlStop();
    return;
  }

  const idx  = tlRoutes[tlIdx];
  const poly = _renderedPolylines[idx];
  const act  = _renderedActivities[idx];
  if (!poly || !act) { tlIdx++; tlStep(); return; }

  const color = TYPE_COLORS[act.type] || TYPE_COLORS.Other;

  // Flash highlight
  poly.setStyle({ color: '#ffffff', weight: 4, opacity: 1 });
  setTimeout(() => {
    poly.setStyle({ color, weight: 2, opacity: 0.7 });
  }, 350);

  tlUpdateUI(tlIdx);
  tlIdx++;

  const speed = parseInt(document.getElementById('tl-speed')?.value || '3', 10);
  const delay = Math.max(40, 500 / speed);
  tlTimer = setTimeout(tlStep, delay);
}

function tlPrepare() {
  if (_renderedActivities.length === 0) {
    showToast('Load activities with routes first');
    return false;
  }

  tlRoutes = tlGetSortedRoutes();
  if (tlRoutes.length === 0) {
    showToast('No routable activities to animate');
    return false;
  }

  // Dim all polylines to start
  for (let i = 0; i < _renderedPolylines.length; i++) {
    const act = _renderedActivities[i];
    const color = TYPE_COLORS[act?.type] || TYPE_COLORS.Other;
    _renderedPolylines[i]?.setStyle({ color, weight: 2, opacity: 0.15 });
  }

  tlIdx = 0;
  tlUpdateUI(0);
  return true;
}

export function tlPlay() {
  if (tlTimer) return; // already playing

  const btn = document.getElementById('tl-play-btn');

  if (tlIdx === 0 || tlIdx >= tlRoutes.length) {
    if (!tlPrepare()) return;
  }

  if (btn) btn.innerHTML = '&#9646;&#9646; Pause';
  tlStep();
}

export function tlPause() {
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

  // Restore normal opacity
  for (let i = 0; i < _renderedPolylines.length; i++) {
    const act = _renderedActivities[i];
    const color = TYPE_COLORS[act?.type] || TYPE_COLORS.Other;
    _renderedPolylines[i]?.setStyle({ color, weight: 2, opacity: 0.6 });
  }
}

function tlToggle() {
  if (tlTimer) {
    tlPause();
  } else {
    tlPlay();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MOST VISITED LOCATIONS
// ═════════════════════════════════════════════════════════════════════════════

const _geocodeCache = new Map();

async function reverseGeocode(lat, lng) {
  const key = `${lat},${lng}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('nominatim error');
    const data = await res.json();
    const addr = data.address || {};
    const name = addr.city || addr.town || addr.village || addr.county || addr.state || addr.country || `${lat.toFixed(1)}°, ${lng.toFixed(1)}°`;
    _geocodeCache.set(key, name);
    return name;
  } catch {
    const name = `${lat.toFixed(1)}°, ${lng.toFixed(1)}°`;
    _geocodeCache.set(key, name);
    return name;
  }
}

async function computeTopLocations(activities, limit = 10) {
  // Cluster activity start points by 0.5° grid cell (~55km)
  const counts = new Map();
  const centers = new Map();

  for (const act of activities) {
    const pts = act.route_points;
    if (!pts || pts.length === 0) continue;
    const p = pts.find(x => x.lat !== null && x.lng !== null);
    if (!p) continue;

    const cellLat = Math.round(p.lat * 2) / 2;
    const cellLng = Math.round(p.lng * 2) / 2;
    const key = `${cellLat},${cellLng}`;

    counts.set(key, (counts.get(key) || 0) + 1);
    if (!centers.has(key)) centers.set(key, { lat: cellLat, lng: cellLng });
  }

  if (counts.size === 0) return [];

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  // Reverse geocode in parallel (with a small delay between to be polite)
  const results = [];
  for (const [key, count] of sorted) {
    const { lat, lng } = centers.get(key);
    const name = await reverseGeocode(lat, lng);
    results.push({ key, name, count, lat, lng });
    await new Promise(r => setTimeout(r, 100)); // 100ms between Nominatim calls
  }

  return results;
}

async function renderLocationsPanel() {
  const container = document.getElementById('locations-list');
  if (!container) return;

  // Use heatmap-rendered activities — these are the ones with route_points loaded
  const routable = _renderedActivities.filter(a => a.route_points && a.route_points.length > 0);
  if (routable.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">No GPS routes loaded yet.</div>';
    return;
  }

  container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Computing locations…</div>';

  const locs = await computeTopLocations(routable, 10);
  if (locs.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No location data</div>';
    return;
  }

  const maxCount = locs[0].count;

  container.innerHTML = locs.map((loc, i) => `
    <div class="loc-row" data-lat="${loc.lat}" data-lng="${loc.lng}" title="Click to zoom map here">
      <div class="loc-rank">${i + 1}</div>
      <div class="loc-info">
        <div class="loc-name">${escapeHtml(loc.name)}</div>
        <div class="loc-bar-wrap">
          <div class="loc-bar" style="width:${Math.round((loc.count / maxCount) * 100)}%"></div>
        </div>
      </div>
      <div class="loc-count">${loc.count}</div>
      <div class="loc-zoom">&#8599;</div>
    </div>
  `).join('');

  // Click to zoom map to that location
  container.querySelectorAll('.loc-row').forEach(row => {
    row.addEventListener('click', () => {
      const lat = parseFloat(row.dataset.lat);
      const lng = parseFloat(row.dataset.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        if (heatmapInstance) {
          heatmapInstance.setView([lat, lng], 11, { animate: true });
        }
        // Scroll so the map is visible
        document.getElementById('heatmap-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// DARK / LIGHT MODE
// ═════════════════════════════════════════════════════════════════════════════

let _darkMode = localStorage.getItem('fitness-theme') === 'dark';

function applyTheme() {
  document.documentElement.classList.toggle('dark-mode', _darkMode);
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = _darkMode ? '☀ Light' : '🌙 Dark';
}

function toggleTheme() {
  _darkMode = !_darkMode;
  localStorage.setItem('fitness-theme', _darkMode ? 'dark' : 'light');
  applyTheme();
}
