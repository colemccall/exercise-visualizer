/**
 * core/router.js
 * Tiny hash router. Routes look like `#/feed`, `#/activity/strava-123`,
 * `#/feed?q=type:run+year:2025`. The hash keeps every view linkable on GitHub Pages
 * (no server rewrites) and gives the browser's back button something to do.
 *
 * The optional `q` is the search query (core/lib/query.js): the filters behind a list
 * or map, so a search can be bookmarked or shared as a link.
 */

let handler = () => {};

/** Split "#/activity/strava-1?q=x" into { view: 'activity', param: 'strava-1', query: 'x' }. */
export function parseHash(hash = location.hash) {
  const [path, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const [view = '', ...rest] = path.split('/').filter(Boolean);
  let query = '';
  try { query = new URLSearchParams(qs).get('q') || ''; } catch { /* malformed: ignore */ }
  return { view, param: rest.length ? decodeURIComponent(rest.join('/')) : null, query };
}

export function buildHash(view, param, query) {
  const base = `#/${view}${param ? '/' + encodeURIComponent(param) : ''}`;
  return query ? `${base}?q=${encodeURIComponent(query).replace(/%20/g, '+').replace(/%3A/gi, ':').replace(/%2C/gi, ',')}` : base;
}

/** Go to a view. replace=true swaps the history entry instead of adding one. */
export function navigate(view, param = null, { replace = false, query } = {}) {
  const next = buildHash(view, param, query);
  if (location.hash === next) { handler(parseHash(next)); return; }
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  handler(parseHash(next));
}

/**
 * Update the query in the current URL without adding a history entry or re-running
 * the route handler (used while the user types or clicks filters).
 */
export function replaceQuery(query) {
  const { view, param } = parseHash();
  if (!view) return;
  const next = buildHash(view, param, query);
  if (location.hash !== next) history.replaceState(null, '', next);
}

/** Install the route handler; it also fires for back/forward and manual edits. */
export function startRouter(onRoute) {
  handler = onRoute;
  // popstate also fires for back/forward and for hand-edited hashes, so
  // listening to hashchange as well would run the handler twice.
  window.addEventListener('popstate', () => handler(parseHash()));
}

/** Link href for an in-app view. */
export const hrefFor = buildHash;
