/**
 * core/router.js
 * Tiny hash router. Routes look like `#/feed`, `#/activity/strava-123`,
 * `#/awards`. The hash keeps every view linkable on GitHub Pages (no server
 * rewrites) and gives the browser's back button something to do.
 */

let handler = () => {};

/** Split "#/activity/strava-1" into { view: 'activity', param: 'strava-1' }. */
export function parseHash(hash = location.hash) {
  const path = hash.replace(/^#\/?/, '');
  const [view = '', ...rest] = path.split('/').filter(Boolean);
  return { view, param: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

export function buildHash(view, param) {
  return `#/${view}${param ? '/' + encodeURIComponent(param) : ''}`;
}

/** Go to a view. replace=true swaps the history entry instead of adding one. */
export function navigate(view, param = null, { replace = false } = {}) {
  const next = buildHash(view, param);
  if (location.hash === next) { handler(parseHash(next)); return; }
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  handler(parseHash(next));
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
