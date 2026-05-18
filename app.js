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
import { parse as parseGarmin }  from './parsers/garmin.js';

// ── Chart imports ─────────────────────────────────────────────────────────────
import { renderDistanceChart }  from './charts/distance.js';
import { renderWeeklyChart }    from './charts/weekly.js';
import { renderHRZones }        from './charts/hr-zones.js';
import { renderElevationChart, renderHRLineChart } from './charts/elevation.js';

// ── Map imports ───────────────────────────────────────────────────────────────
import { initHeatmap, renderHeatmap } from './map/heatmap.js';
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
};

/** Leaflet heatmap instance */
let heatmapInstance = null;

/** Currently open detail activity */
let detailRouteMap = null;

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD HANDLING
// ═════════════════════════════════════════════════════════════════════════════

const SOURCES = ['strava', 'apple', 'garmin'];
const PARSERS = { strava: parseStrava, apple: parseApple, garmin: parseGarmin };

function setupUploadZone(source) {
  const zone  = document.getElementById(`zone-${source}`);
  const input = document.getElementById(`file-${source}`);

  // Click on zone → trigger file input
  zone.addEventListener('click', (e) => {
    // Don't trigger if clicking the <details> element
    if (e.target.closest('details')) return;
    input.click();
  });

  // File input change
  input.addEventListener('change', () => {
    if (input.files.length > 0) {
      handleFiles(source, Array.from(input.files));
    }
  });

  // Drag and drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.style.borderColor = 'var(--accent)';
    zone.style.background  = 'var(--accent-light)';
  });

  zone.addEventListener('dragleave', () => {
    zone.style.borderColor = '';
    zone.style.background  = '';
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.style.borderColor = '';
    zone.style.background  = '';
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(source, files);
  });
}

async function handleFiles(source, files) {
  const zone  = document.getElementById(`zone-${source}`);
  const sub   = document.getElementById(`sub-${source}`);

  showProgress(0, `Reading ${source} files…`);

  const parser = PARSERS[source];
  let newActivities = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const pct  = Math.round((i / files.length) * 90);
      const partial = await parser(file, (p, label) => {
        showProgress(pct + Math.round(p * 0.9), label);
      });
      newActivities = newActivities.concat(partial);
    }
  } catch (err) {
    console.error(`Error parsing ${source} files:`, err);
    showToast(`Error loading ${source} data: ${err.message}`);
    hideProgress();
    return;
  }

  showProgress(95, `Merging ${newActivities.length} activities…`);

  // Add to master list (removing old activities from this source)
  allActivities = allActivities.filter(a => a.source !== source);
  allActivities = allActivities.concat(newActivities);

  // Deduplicate
  flagDuplicates(allActivities);

  showProgress(100, 'Done!');
  setTimeout(hideProgress, 600);

  // Mark zone as loaded
  zone.classList.add('loaded');
  sub.textContent = `${newActivities.length} activities loaded`;

  showToast(`Loaded ${newActivities.length} ${source} activities`);

  // Switch to dashboard
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
  const MS_5_MIN = 5 * 60 * 1000;

  // Reset all flags first
  for (const a of activities) a.has_duplicate = false;

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];

      // Only flag cross-source duplicates
      if (a.source === b.source) continue;
      if (!a.date || !b.date) continue;

      const timeDiff = Math.abs(a.date - b.date);
      if (timeDiff > MS_5_MIN) continue;

      const distA = a.distance_m;
      const distB = b.distance_m;
      if (distA === 0 && distB === 0) continue;

      const larger  = Math.max(distA, distB);
      const smaller = Math.min(distA, distB);
      const distRatio = larger > 0 ? (larger - smaller) / larger : 0;

      if (distRatio <= 0.05) {
        a.has_duplicate = true;
        b.has_duplicate = true;
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FILTERING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply current filters to allActivities.
 * @returns {Activity[]}  Filtered subset, sorted newest first
 */
function getFilteredActivities() {
  return allActivities
    .filter(a => {
      if (filters.type !== 'All' && a.type !== filters.type) return false;
      if (filters.from && a.date < filters.from) return false;
      if (filters.to) {
        const toEnd = new Date(filters.to);
        toEnd.setHours(23, 59, 59, 999);
        if (a.date > toEnd) return false;
      }
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

  const dates = activities.map(a => a.date).filter(Boolean).sort((a,b)=>a-b);
  const rangeStr = dates.length >= 2
    ? `${dates[0].getFullYear()}–${dates[dates.length-1].getFullYear()}`
    : dates.length === 1 ? String(dates[0].getFullYear()) : '—';

  document.getElementById('stat-total').textContent    = activities.length.toLocaleString();
  document.getElementById('stat-distance').textContent = formatDistance(totalDist);
  document.getElementById('stat-elevation').textContent = formatElevation(totalElev);
  document.getElementById('stat-range').textContent    = rangeStr;
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
      ${activity.has_duplicate ? '<span class="duplicate-badge">⚠ Possible duplicate</span>' : ''}
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

  // Upload zones
  SOURCES.forEach(setupUploadZone);

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
    filters.type = 'All';
    filters.from = null;
    filters.to   = null;
    document.getElementById('filter-type').value = 'All';
    document.getElementById('filter-from').value = '';
    document.getElementById('filter-to').value   = '';
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

});

// ═════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
