/**
 * core/routes.js
 * Lazy trackpoint loading with a concurrency cap. The Feed thumbnails, the
 * single-activity page, personal-record search and the heatmap all need
 * `activity.route_points`; they share this so a route is only ever loaded once.
 */

/** Load one activity's trackpoints (no-op if present or not routable). */
export async function ensureRoute(activity) {
  if (activity.route_points) return activity.route_points;
  if (!activity.has_route || typeof activity._gpxLoader !== 'function') return null;
  // Share an in-flight load between callers.
  if (!activity._routePromise) {
    activity._routePromise = activity._gpxLoader()
      .then(pts => { activity.route_points = pts || []; return activity.route_points; })
      .catch(e => { console.warn('route load failed', activity.id, e); activity.route_points = []; return []; })
      .finally(() => { activity._routePromise = null; });
  }
  return activity._routePromise;
}

/**
 * Load routes for many activities, at most `concurrency` at once.
 * @param {object[]} activities
 * @param {{concurrency?: number, onProgress?: (done:number,total:number)=>void, signal?: {cancelled:boolean}}} [opts]
 */
export async function ensureRoutes(activities, { concurrency = 6, onProgress, signal } = {}) {
  const todo = activities.filter(a => a.has_route && !a.route_points);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length && !(signal && signal.cancelled)) {
      const a = todo[next++];
      await ensureRoute(a);
      onProgress?.(++done, todo.length);
      // Yield now and then so a big batch never freezes the page.
      if (done % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
}

/** Points with a real position. */
export const positioned = (points) => (points || []).filter(p => p.lat !== null && p.lng !== null);
