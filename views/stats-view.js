/**
 * views/stats-view.js
 * Stats & Charts: year summary, headline numbers, the ~30-statistic panel,
 * filters, and the D3 charts. Everything here describes the activities
 * currently in view, so the filters drive every number.
 */

import { state, scoped, filtered, emit, clearFilters } from '../core/state.js';
import { escapeHtml, debounce, parseDateInput, safeStorage, MONTH_NAMES } from '../core/util.js';
import {
  getUnits, formatters, formatDistance, formatMovingTime, formatElevation, formatPace,
} from '../core/format.js';
import { navigate } from '../core/router.js';
import { renderYearSummary } from '../components/year-summary.js';
import { renderDistanceChart } from '../charts/distance.js';
import { renderWeeklyChart } from '../charts/weekly.js';
import { renderHRZones } from '../charts/hr-zones.js';
import { renderRecords } from '../charts/records.js';
import { renderStats } from '../charts/stats.js';
import { TYPE_COLORS } from '../design-system/activity-colors.js';

let yearSel; // undefined = latest
let wired = false;

/** Max heart rate for the zone chart: the user's setting, else the highest seen. */
export function maxHr(list = scoped()) {
  const saved = parseInt(safeStorage.get('fitness-maxhr') || '', 10);
  if (saved >= 120 && saved <= 230) return saved;
  const seen = list.map(a => a.max_heart_rate).filter(Boolean).sort((a, b) => a - b);
  if (!seen.length) return 190;
  const p98 = seen[Math.min(seen.length - 1, Math.floor(seen.length * 0.98))];
  return Math.max(150, Math.min(220, Math.round(p98)));
}

function updateStatsBar(list) {
  const t = (a) => a.moving_s || a.duration_s || 0;
  const dist = list.reduce((s, a) => s + (a.distance_m || 0), 0);
  const elev = list.reduce((s, a) => s + (a.elevation_gain_m || 0), 0);
  const secs = list.reduce((s, a) => s + t(a), 0);
  const paceable = list.filter(a => ['Run', 'Ride', 'Walk', 'Hike'].includes(a.type) && a.distance_m > 100 && t(a) > 0);
  const pace = paceable.length
    ? formatPace(paceable.reduce((s, a) => s + a.distance_m, 0), paceable.reduce((s, a) => s + t(a), 0))
    : '—';
  const years = list.map(a => a.date.getFullYear());
  const range = years.length ? (Math.min(...years) === Math.max(...years) ? String(years[0]) : `${Math.min(...years)}–${Math.max(...years)}`) : '—';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-total', list.length.toLocaleString());
  set('stat-distance', formatDistance(dist));
  set('stat-time', formatMovingTime(secs));
  set('stat-elevation', formatElevation(elev));
  set('stat-pace', pace);
  set('stat-range', range);
}

function updateFiltersSummary(list) {
  const el = document.getElementById('filters-summary');
  if (!el) return;
  const f = state.filters;
  const parts = [];
  if (f.type !== 'All') parts.push(f.type);
  if (f.search) parts.push(`“${f.search}”`);
  if (f.month) { const [y, m] = f.month.split('-'); parts.push(`${MONTH_NAMES[+m]} ${y}`); }
  if (f.from) parts.push(`from ${f.from.toLocaleDateString('en-US')}`);
  if (f.to) parts.push(`to ${f.to.toLocaleDateString('en-US')}`);
  if (f.duplicatesOnly) parts.push('merged workouts only');
  const total = scoped().length;
  el.textContent = parts.length
    ? `${parts.join(' · ')} — ${list.length.toLocaleString()} of ${total.toLocaleString()} activities`
    : `Showing all ${total.toLocaleString()} activities`;
}

/** Sync the filter inputs from state (other views change the filters too). */
function syncFilterInputs() {
  const f = state.filters;
  const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
  set('filter-search', f.search);
  set('filter-type', f.type);
  set('filter-from', f.from ? `${f.from.getFullYear()}-${String(f.from.getMonth() + 1).padStart(2, '0')}-${String(f.from.getDate()).padStart(2, '0')}` : '');
  set('filter-to', f.to ? `${f.to.getFullYear()}-${String(f.to.getMonth() + 1).padStart(2, '0')}-${String(f.to.getDate()).padStart(2, '0')}` : '');
  const cb = document.getElementById('filter-dup-only');
  if (cb) cb.checked = f.duplicatesOnly;
}

export function redrawCharts() {
  const view = document.getElementById('view-charts');
  if (!view || !view.classList.contains('active') || !scoped().length) return;
  const list = filtered();
  const units = getUnits();
  try {
    renderDistanceChart([...list].sort((a, b) => a.date - b.date), document.getElementById('chart-distance'), units);
    renderWeeklyChart(list, document.getElementById('chart-weekly'), units);
    renderRecords(list, document.getElementById('chart-records'), units, (a) => navigate('activity', a.id));
  } catch (e) { console.error('Chart error:', e); }

  const hasHr = list.some(a => a.avg_heart_rate || (a.route_points && a.route_points.some(p => p.hr)));
  const card = document.getElementById('chart-hr-card');
  if (card) {
    card.style.display = hasHr ? 'block' : 'none';
    if (hasHr) {
      const input = document.getElementById('maxhr-input');
      const value = maxHr();
      if (input && document.activeElement !== input) input.value = value;
      try { renderHRZones(list, document.getElementById('chart-hr-zones'), value); } catch (e) { console.error('HR zones error:', e); }
    }
  }
}

export function renderStatsView() {
  const list = filtered();
  syncFilterInputs();
  updateStatsBar(list);
  updateFiltersSummary(list);

  const ys = document.getElementById('stats-year');
  if (ys) renderYearSummary(ys, scoped(), { year: yearSel, onYear: (y) => { yearSel = y; renderStatsView(); } });

  const detail = document.getElementById('stats-detail');
  if (detail) {
    try {
      renderStats(detail, list, {
        fmt: formatters(),
        typeColors: TYPE_COLORS,
        onOpenActivity: (id) => navigate('activity', id),
      });
    } catch (e) { console.error('Stats error:', e); }
  }
  redrawCharts();
}

/** One-time event wiring for the filters panel and chart resizing. */
export function initStatsView() {
  if (wired) return;
  wired = true;
  const apply = () => { emit('filters'); };

  const redrawSearch = debounce(apply, 200);
  document.getElementById('filter-search')?.addEventListener('input', (e) => {
    state.filters.search = e.target.value; // immediate; only the redraw is debounced
    redrawSearch();
  });
  document.getElementById('filter-type')?.addEventListener('change', (e) => { state.filters.type = e.target.value; apply(); });
  document.getElementById('filter-from')?.addEventListener('change', (e) => { state.filters.from = parseDateInput(e.target.value); apply(); });
  document.getElementById('filter-to')?.addEventListener('change', (e) => { state.filters.to = parseDateInput(e.target.value); apply(); });
  document.getElementById('filter-dup-only')?.addEventListener('change', (e) => { state.filters.duplicatesOnly = e.target.checked; apply(); });
  document.getElementById('btn-clear-filters')?.addEventListener('click', () => { clearFilters(); apply(); });
  document.getElementById('maxhr-input')?.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 120 && v <= 230) safeStorage.set('fitness-maxhr', String(v)); else safeStorage.remove('fitness-maxhr');
    redrawCharts();
  });

  // D3 charts size to their container, so redraw when the width changes
  // (window resize, rotating a phone) — not only when a section expands.
  const view = document.getElementById('view-charts');
  if (view && 'ResizeObserver' in window) {
    let lastW = view.clientWidth;
    new ResizeObserver(debounce(() => {
      if (view.clientWidth !== lastW) { lastW = view.clientWidth; redrawCharts(); }
    }, 150)).observe(view);
  }
}
