/**
 * views/explore.js
 * Every activity matching the current search, as a sortable table: the "dive in" view.
 * Click a column to sort, a row to open the activity, and export what you're looking
 * at as CSV. It reads the same filters as the Feed, Map and Stats, so a search,
 * a chart drill-down or a shared link all land here consistently.
 */

import { state, filtered, scoped, emit, isFiltered } from '../core/state.js';
import { formatQuery } from '../core/lib/query.js';
import { hrefFor } from '../core/router.js';
import { escapeHtml } from '../core/lib/util.js';
import {
  formatDistance, formatDuration, formatMovingTime, formatElevation, formatEffort, formatDate, formatHR,
} from '../core/lib/format.js';
import { showToast } from '../core/lib/ui.js';

const PAGE = 50;
let page = 0;
let lastKey = '';

const hasDist = (a) => (a.distance_m || 0) > 50;
const secs = (a) => a.moving_s || a.duration_s || 0;

const COLUMNS = [
  { key: 'date', label: 'Date', sort: 'date', defaultDir: 'desc', cell: a => escapeHtml(formatDate(a.date)) },
  { key: 'name', label: 'Activity', sort: 'name', defaultDir: 'asc', cell: a => `<a href="${hrefFor('activity', a.id)}">${escapeHtml(a.name || a.sub_type || a.type)}</a>` },
  { key: 'type', label: 'Type', cell: a => escapeHtml(a.sub_type && a.sub_type !== a.type ? a.sub_type : a.type) },
  { key: 'dist', label: 'Distance', sort: 'dist', defaultDir: 'desc', num: true, cell: a => (hasDist(a) ? escapeHtml(formatDistance(a.distance_m)) : '—') },
  { key: 'dur', label: 'Time', sort: 'dur', defaultDir: 'desc', num: true, cell: a => escapeHtml(formatDuration(secs(a))) },
  { key: 'pace', label: 'Pace / speed', sort: 'pace', defaultDir: 'asc', num: true, cell: a => (hasDist(a) ? escapeHtml(formatEffort(a)) : '—') },
  { key: 'elev', label: 'Climb', sort: 'elev', defaultDir: 'desc', num: true, cell: a => (a.elevation_gain_m > 1 ? escapeHtml(formatElevation(a.elevation_gain_m)) : '—') },
  { key: 'hr', label: 'Avg HR', sort: 'hr', defaultDir: 'desc', num: true, cell: a => (a.avg_heart_rate ? escapeHtml(formatHR(a.avg_heart_rate)) : '—') },
  { key: 'kcal', label: 'Energy', num: true, cell: a => (a.calories_kcal ? `${Math.round(a.calories_kcal).toLocaleString()} kcal` : '—') },
  { key: 'src', label: 'Source', cell: a => escapeHtml((a.sources || [a.source]).map(s => (s === 'apple' ? 'Apple' : 'Strava')).join(' + ')) },
];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the activities in view: base units (metres, seconds) so it is spreadsheet-friendly. */
export function toCsv(list) {
  const head = ['date', 'name', 'type', 'sub_type', 'distance_m', 'moving_s', 'elapsed_s', 'elevation_gain_m', 'avg_hr', 'max_hr', 'calories_kcal', 'source', 'id'];
  const rows = list.map(a => [
    a.date.toISOString(), a.name, a.type, a.sub_type, Math.round(a.distance_m || 0), a.moving_s ?? '', a.duration_s ?? '',
    a.elevation_gain_m ?? '', a.avg_heart_rate ?? '', a.max_heart_rate ?? '', a.calories_kcal ?? '', (a.sources || [a.source]).join('+'), a.id,
  ]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
}

function ariaSort(col) {
  const s = state.filters.sort;
  if (!col.sort) return '';
  if (s && s.key === col.sort) return s.dir === 'asc' ? 'ascending' : 'descending';
  return !s && col.sort === 'date' ? 'descending' : 'none';
}

export function renderExplore() {
  const root = document.getElementById('view-explore');
  if (!root) return;
  const list = filtered();
  const key = `${formatQuery(state.filters)}|${state.filters.sort?.key}|${state.filters.sort?.dir}`;
  if (key !== lastKey) { page = 0; lastKey = key; }
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(page, pages - 1);
  const rows = list.slice(page * PAGE, page * PAGE + PAGE);

  const dist = list.reduce((s, a) => s + (a.distance_m || 0), 0);
  const time = list.reduce((s, a) => s + secs(a), 0);
  const climb = list.reduce((s, a) => s + (a.elevation_gain_m || 0), 0);
  const total = scoped().length;

  root.innerHTML = `
  <div class="view-shell explore-shell">
    <header class="view-head">
      <h1 class="view-title">Explore</h1>
      <p class="view-sub" aria-live="polite">${isFiltered() ? `${list.length.toLocaleString()} of ${total.toLocaleString()} activities match` : `All ${total.toLocaleString()} activities`}${formatQuery(state.filters) ? ` <code class="q">${escapeHtml(formatQuery(state.filters))}</code>` : ''}</p>
    </header>
    <div class="explore-bar">
      <button type="button" class="bs-btn bs-btn-secondary" id="explore-search">Edit search</button>
      <button type="button" class="bs-btn bs-btn-secondary" id="explore-csv" ${list.length ? '' : 'disabled'}>Export CSV (${list.length.toLocaleString()})</button>
    </div>
    ${list.length ? `
    <div class="table-scroll">
      <table class="explore-table">
        <thead><tr>${COLUMNS.map(c => `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${ariaSort(c)}">${c.sort
          ? `<button type="button" class="th-sort" data-sort="${c.sort}" data-dir="${c.defaultDir}">${escapeHtml(c.label)}<span class="sort-arrow" aria-hidden="true"></span></button>`
          : escapeHtml(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(a => `<tr>${COLUMNS.map(c => `<td class="${c.num ? 'num' : ''}" data-label="${escapeHtml(c.label)}">${c.cell(a)}</td>`).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row" colspan="3">${list.length.toLocaleString()} activities</th>
          <td class="num">${escapeHtml(formatDistance(dist))}</td><td class="num">${escapeHtml(formatMovingTime(time))}</td><td></td>
          <td class="num">${escapeHtml(formatElevation(climb))}</td><td colspan="3"></td></tr></tfoot>
      </table>
    </div>
    <nav class="pager" aria-label="Pages">
      <button type="button" class="bs-btn bs-btn-secondary" id="pg-prev" ${page === 0 ? 'disabled' : ''}>← Previous</button>
      <span>${(page * PAGE + 1).toLocaleString()}–${Math.min(list.length, page * PAGE + PAGE).toLocaleString()} of ${list.length.toLocaleString()}</span>
      <button type="button" class="bs-btn bs-btn-secondary" id="pg-next" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button>
    </nav>` : `
    <div class="empty-state"><p>Nothing matches that search.</p>
      <button type="button" class="bs-btn bs-btn-secondary" id="explore-clear">Clear the search</button></div>`}
  </div>`;

  root.onclick = (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const cur = state.filters.sort;
      const key2 = sortBtn.dataset.sort;
      const dir = cur && cur.key === key2 ? (cur.dir === 'asc' ? 'desc' : 'asc') : sortBtn.dataset.dir;
      state.filters.sort = { key: key2, dir };
      emit('filters');
    } else if (e.target.closest('#pg-prev')) { page = Math.max(0, page - 1); renderExplore(); }
    else if (e.target.closest('#pg-next')) { page += 1; renderExplore(); }
    else if (e.target.closest('#explore-clear')) { document.getElementById('search-clear')?.click(); }
    else if (e.target.closest('#explore-search')) { document.getElementById('btn-search')?.click(); }
    else if (e.target.closest('#explore-csv')) {
      const blob = new Blob([toCsv(filtered())], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'activities.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      showToast(`Exported ${list.length.toLocaleString()} activities.`);
    }
  };
}
