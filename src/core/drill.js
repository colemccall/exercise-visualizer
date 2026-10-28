/**
 * core/drill.js
 * "Show me the activities behind this number": every chart bar, table row and
 * calendar day that summarises a set of workouts can hand a query string here and
 * land on that set. The query is the same language as the search box
 * (core/lib/query.js), so a drill-down is just a search someone didn't have to type.
 */

import { state, emit, setFilters } from './state.js';
import { parseQuery } from './lib/query.js';
import { navigate } from './router.js';

/**
 * @param {string} queryText  e.g. "type:run year:2025" or "after:2025-04-12 before:2025-04-12"
 * @param {string} [view]     where to show the result: 'feed' (default), 'explore' or 'map'
 */
export function drillTo(queryText, view = 'feed') {
  const { filters } = parseQuery(queryText);
  setFilters({ ...filters, sort: filters.sort || state.filters.sort });
  emit('filters');
  navigate(view, null, { query: queryText });
}

/** One delegated handler for any element carrying data-drill="<query>" [data-view="explore"]. */
export function installDrillHandlers(root = document) {
  const go = (el) => drillTo(el.dataset.drill, el.dataset.view || 'feed');
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-drill]');
    if (el && !e.target.closest('a[href]')) go(el);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest?.('[data-drill]');
    if (el && el.tagName !== 'BUTTON' && el.tagName !== 'A') { e.preventDefault(); go(el); }
  });
}
