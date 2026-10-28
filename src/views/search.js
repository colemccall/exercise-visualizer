/**
 * views/search.js
 * The global search bar. Type a query ("hill type:run year:2025 dist:>10km sort:-dist")
 * and every view (Feed, Map, Stats, Explore) narrows to it. The text is the same
 * filter object chips and chart drill-downs edit (core/state.js filters), so the box
 * and the chips always agree, and the query rides along in the URL so a search can be
 * bookmarked or shared (core/router.js).
 *
 *   /            open and focus the search from anywhere
 *   Enter        show the results (jumps to the Feed unless you're on a view that filters)
 *   Esc          close
 */

import { state, scoped, filtered, emit, setFilters, isFiltered } from '../core/state.js';
import { parseQuery, formatQuery } from '../core/lib/query.js';
import { navigate, parseHash } from '../core/router.js';
import { formatDistance, formatMovingTime, formatElevation } from '../core/lib/format.js';
import { escapeHtml, debounce, safeStorage } from '../core/lib/util.js';
import { syncNavHeight, showToast } from '../core/lib/ui.js';

const SAVED_KEY = 'fitness-saved-searches';
const FILTERING_VIEWS = new Set(['feed', 'explore', 'map', 'charts']);
const EXAMPLES = ['type:run', 'year:2025', 'dist:>10km', 'dur:>1h', 'elev:>500m', 'hr:>150', 'has:route', 'dow:weekend', 'sort:-dist'];

const $ = (id) => document.getElementById(id);
let open = false;

const loadSaved = () => { try { return JSON.parse(safeStorage.get(SAVED_KEY) || '[]'); } catch { return []; } };
const storeSaved = (list) => safeStorage.set(SAVED_KEY, JSON.stringify(list.slice(0, 12)));

/** One line describing what the current search matches. */
function summaryText() {
  const list = filtered();
  const total = scoped().length;
  const dist = list.reduce((s, a) => s + (a.distance_m || 0), 0);
  const secs = list.reduce((s, a) => s + (a.moving_s || a.duration_s || 0), 0);
  const elev = list.reduce((s, a) => s + (a.elevation_gain_m || 0), 0);
  const head = isFiltered() ? `${list.length.toLocaleString()} of ${total.toLocaleString()} activities` : `${total.toLocaleString()} activities`;
  return list.length ? `${head} · ${formatDistance(dist)} · ${formatMovingTime(secs)} · ${formatElevation(elev)} climb` : `${head}: nothing matches`;
}

function renderMeta(errors = []) {
  const sum = $('search-summary');
  if (sum) sum.textContent = summaryText();
  const err = $('search-errors');
  if (err) {
    err.hidden = !errors.length;
    err.innerHTML = errors.map(e => `<span class="search-err" title="${escapeHtml(e.message)}"><b>${escapeHtml(e.token)}</b> ${escapeHtml(e.message)}</span>`).join('');
  }
  const saved = loadSaved();
  const box = $('search-saved');
  if (box) {
    box.hidden = !saved.length;
    box.innerHTML = saved.length ? `<span class="af-label">Saved:</span>` + saved.map((s, i) => `
      <span class="chip saved"><button type="button" class="saved-use" data-saved="${i}">${escapeHtml(s.name)}</button><button type="button" class="saved-x" data-saved-del="${i}" aria-label="Delete saved search ${escapeHtml(s.name)}">×</button></span>`).join('') : '';
  }
  $('btn-search')?.classList.toggle('has-filter', isFiltered());
}

/** Put the current filters into the box (unless the user is typing in it). */
export function syncSearchInput() {
  const input = $('global-search');
  if (input && document.activeElement !== input) input.value = formatQuery(state.filters);
  renderMeta();
}

function apply() {
  const input = $('global-search');
  const { filters, errors } = parseQuery(input.value);
  setFilters({ ...filters, sort: filters.sort || state.filters.sort });
  emit('filters');
  renderMeta(errors);
}

export function setSearchOpen(v) {
  open = v;
  const bar = $('search-bar'), btn = $('btn-search');
  if (!bar) return;
  bar.hidden = !v;
  btn?.setAttribute('aria-expanded', String(v));
  if (v) { syncSearchInput(); $('global-search')?.focus(); $('global-search')?.select(); }
  requestAnimationFrame(syncNavHeight);
}

export const isSearchOpen = () => open;

export function initSearch() {
  const input = $('global-search');
  if (!input) return;

  $('btn-search')?.addEventListener('click', () => setSearchOpen(!open));
  $('search-close')?.addEventListener('click', () => setSearchOpen(false));
  $('search-table')?.addEventListener('click', () => navigate('explore', null, { query: formatQuery(state.filters) }));
  $('search-clear')?.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });

  const debounced = debounce(apply, 180);
  input.addEventListener('input', debounced);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setSearchOpen(false); e.stopPropagation(); }
    else if (e.key === 'Enter') {
      debounced.cancel(); apply();
      if (!FILTERING_VIEWS.has(parseHash().view)) navigate('feed', null, { query: formatQuery(state.filters) });
    }
  });

  // Example tokens: click to add
  const help = $('search-help');
  if (help) {
    help.innerHTML = '<span class="af-label">Try:</span>' + EXAMPLES.map(t => `<button type="button" class="chip ghost" data-token="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
    help.addEventListener('click', (e) => {
      const b = e.target.closest('[data-token]');
      if (!b) return;
      input.value = `${input.value.trim()} ${b.dataset.token}`.trim();
      apply(); input.focus();
    });
  }

  // Saved searches
  $('search-save')?.addEventListener('click', () => {
    const q = formatQuery(state.filters).trim();
    if (!q) { showToast('Type a search first, then save it.', { error: true }); return; }
    const list = loadSaved().filter(s => s.q !== q);
    list.unshift({ name: q.length > 34 ? q.slice(0, 33) + '…' : q, q });
    storeSaved(list); renderMeta(); showToast('Search saved.');
  });
  $('search-saved')?.addEventListener('click', (e) => {
    const use = e.target.closest('[data-saved]');
    const del = e.target.closest('[data-saved-del]');
    const list = loadSaved();
    if (use && list[+use.dataset.saved]) { input.value = list[+use.dataset.saved].q; apply(); }
    if (del) { list.splice(+del.dataset.savedDel, 1); storeSaved(list); renderMeta(); }
  });

  renderMeta();
}
