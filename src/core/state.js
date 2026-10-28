/**
 * core/state.js
 * The one shared store: loaded data, filters, theme, and a tiny pub/sub so
 * views re-render only when what they show has changed (it used to be one
 * refreshDashboard() that redrew every chart on every keystroke).
 *
 * Events: 'data' (activities/summaries/photos changed), 'filters', 'units',
 * 'theme', 'mode'.
 */

import { inScope, getMode } from './modes.js';
import { emptyPlan } from './data/plan-store.js';
import { emptyFilters, queryTokens } from './lib/query.js';

export const state = {
  /** All activities incl. merged-away secondaries (they carry merged_into). */
  activities: [],
  /** Apple ActivitySummary rows (rings). */
  summaries: [],
  photos: [],
  photoBuffer: 5,
  photoMatch: { matched: 0, unmatched: 0, activitiesWithPhotos: [] },
  /** The one filter object every view reads (shape: core/lib/query.js emptyFilters). */
  filters: emptyFilters(),
  dark: false,
  /** Which sources are loaded: { strava, apple }. */
  has: { strava: false, apple: false },
  /** Leaflet map on the Map view. */
  heatmap: null,
  /** Parser version that produced the saved data (see core/data/store.js MODEL). */
  dataModel: null,
  /** Nutrition planner: profile, goals, scenarios, weights, food log (core/data/plan-store.js). */
  plan: emptyPlan(),
  /** Body and energy data read from an Apple Health export (birth year + sex, weights, height, basal energy, dietary). */
  health: null,
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) {
    try { fn(detail); } catch (e) { console.error(`listener for "${event}" failed`, e); }
  }
}

/** Activities in scope for the current mode, newest first. */
export function scoped() {
  const mode = getMode();
  return state.activities.filter(a => inScope(a, mode)).sort((a, b) => b.date - a.date);
}

const inRange = (v, r) => v !== null && v !== undefined && (r[0] === null || v >= r[0]) && (r[1] === null || v <= r[1]);

/** Everything searchable about an activity, lower-cased once. */
function haystack(a) {
  return a._hay || (a._hay = [a.name, a.type, a.sub_type, a.description, a.gear, a.device].filter(Boolean).join(' \n ').toLowerCase());
}

/**
 * Does one activity pass these filters? (The single definition of "matches"; the Feed,
 * Stats, Map and Explore views all go through it.) `ignoreMonth` lets the month grid
 * count activities across months.
 */
export function activityMatches(a, f = state.filters, { ignoreMonth = false } = {}) {
  if (f.types?.length) { if (!f.types.includes(a.type)) return false; }
  else if (f.type !== 'All' && a.type !== f.type) return false;
  if (f.year && a.date.getFullYear() !== f.year) return false;
  if (f.from && a.date < f.from) return false;
  if (f.to && a.date > new Date(f.to.getFullYear(), f.to.getMonth(), f.to.getDate(), 23, 59, 59, 999)) return false;
  if (!ignoreMonth && f.month) {
    const [fy, fm] = f.month.split('-');
    if (a.date.getFullYear() !== +fy || a.date.getMonth() !== +fm) return false;
  }
  if (f.dow?.length && !f.dow.includes(a.date.getDay())) return false;
  if (f.source && !(a.sources || [a.source]).includes(f.source)) return false;
  if (f.hasRoute && !a.has_route) return false;
  if (f.indoor !== null && f.indoor !== undefined && a.indoor !== f.indoor) return false;
  if (f.duplicatesOnly && !(a.sources && a.sources.length > 1)) return false;
  if (f.gear && !(a.gear || '').toLowerCase().includes(f.gear)) return false;
  if (f.dist && !inRange(a.distance_m || 0, f.dist)) return false;
  if (f.dur && !inRange(a.moving_s || a.duration_s || 0, f.dur)) return false;
  if (f.elev && !inRange(a.elevation_gain_m, f.elev)) return false;
  if (f.hr && !inRange(a.avg_heart_rate, f.hr)) return false;
  if (f.search) {
    const hay = haystack(a);
    for (const word of f.search.toLowerCase().split(/\s+/)) if (word && !hay.includes(word)) return false;
  }
  return true;
}

const SORT_VALUE = {
  date: a => a.date.getTime(),
  dist: a => a.distance_m || 0,
  dur: a => a.moving_s || a.duration_s || 0,
  elev: a => a.elevation_gain_m ?? -1,
  hr: a => a.avg_heart_rate ?? -1,
  name: a => (a.name || '').toLowerCase(),
  // seconds per metre; activities with no distance sort last
  pace: a => ((a.distance_m || 0) > 100 ? (a.moving_s || a.duration_s || 0) / a.distance_m : Infinity),
};

/** Apply a { key, dir } sort (null keeps newest-first). Does not mutate. */
export function sortActivities(list, sort) {
  if (!sort || !SORT_VALUE[sort.key]) return [...list].sort((a, b) => b.date - a.date);
  const get = SORT_VALUE[sort.key], dir = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((x, y) => {
    const p = get(x), q = get(y);
    return (p < q ? -1 : p > q ? 1 : 0) * dir || (y.date - x.date);
  });
}

/** Scoped activities with every filter applied, sorted by the filter's sort (default newest first). */
export function filtered({ ignoreMonth = false } = {}) {
  const f = state.filters;
  return sortActivities(scoped().filter(a => activityMatches(a, f, { ignoreMonth })), f.sort);
}

export const byId = (id) => state.activities.find(a => a.id === id) || null;

/** Number of workouts that were recorded by both sources and merged. */
export function mergedCount() {
  return state.activities.filter(a => !a.merged_into && a.sources && a.sources.length > 1).length;
}

/** Is any filter narrowing the list? (Sort alone does not narrow.) */
export function isFiltered(f = state.filters) {
  return queryTokens(f).some(t => t.key !== 'sort');
}

/** Active filters as removable chips: [{ key, label }]; key is the state.filters field to reset. */
export function describeFilters(f = state.filters) {
  return queryTokens(f).filter(t => t.key !== 'sort').map(t => ({ key: t.key, label: t.text }));
}

/** Reset one filter field to its empty value. */
export function clearFilter(key) {
  const empty = emptyFilters();
  if (key === 'types') state.filters.types = [];
  else if (key in empty) state.filters[key] = empty[key];
}

export function clearFilters() {
  const keepSort = state.filters.sort;
  Object.assign(state.filters, emptyFilters(), { sort: keepSort });
}

/** Replace every filter with a parsed query (core/lib/query.js parseQuery().filters). */
export function setFilters(next) {
  Object.assign(state.filters, emptyFilters(), next);
}

/**
 * "Now" for time-relative views (trends, this week, monthly challenge). An export
 * is a snapshot, so when its newest activity is more than a few weeks old,
 * anchoring to today would show an empty last 90 days. Use the newest activity
 * (or ring day) instead.
 */
export function dataAnchor() {
  const now = new Date();
  const newest = scoped()[0]?.date;
  const ring = state.summaries.length ? new Date(state.summaries[state.summaries.length - 1].date + 'T12:00:00') : null;
  const latest = [newest, ring].filter(Boolean).sort((a, b) => b - a)[0];
  if (!latest) return now;
  return now - latest > 21 * 864e5 ? new Date(latest.getTime() + 864e5) : now;
}
