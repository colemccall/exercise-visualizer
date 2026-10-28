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

export const state = {
  /** All activities incl. merged-away secondaries (they carry merged_into). */
  activities: [],
  /** Apple ActivitySummary rows (rings). */
  summaries: [],
  photos: [],
  photoBuffer: 5,
  photoMatch: { matched: 0, unmatched: 0, activitiesWithPhotos: [] },
  filters: { type: 'All', from: null, to: null, search: '', duplicatesOnly: false, month: null },
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

/** Scoped activities with the type/search/date/month filters applied. */
export function filtered({ ignoreMonth = false } = {}) {
  const f = state.filters;
  const term = f.search.toLowerCase().trim();
  const toEnd = f.to ? new Date(f.to.getFullYear(), f.to.getMonth(), f.to.getDate(), 23, 59, 59, 999) : null;
  return scoped().filter(a => {
    if (f.type !== 'All' && a.type !== f.type) return false;
    if (f.from && a.date < f.from) return false;
    if (toEnd && a.date > toEnd) return false;
    if (term && !(a.name.toLowerCase().includes(term) || a.type.toLowerCase().includes(term)
      || (a.sub_type || '').toLowerCase().includes(term))) return false;
    if (f.duplicatesOnly && !(a.sources && a.sources.length > 1)) return false;
    if (!ignoreMonth && f.month) {
      const [fy, fm] = f.month.split('-');
      if (a.date.getFullYear() !== +fy || a.date.getMonth() !== +fm) return false;
    }
    return true;
  });
}

export const byId = (id) => state.activities.find(a => a.id === id) || null;

/** Number of workouts that were recorded by both sources and merged. */
export function mergedCount() {
  return state.activities.filter(a => !a.merged_into && a.sources && a.sources.length > 1).length;
}

/** Is any filter narrowing the list? (One definition; Feed, Stats and Map all read it.) */
export function isFiltered(f = state.filters) {
  return f.type !== 'All' || !!(f.from || f.to || f.search || f.duplicatesOnly || f.month);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Active filters as removable chips: [{ key, label }] (key matches a state.filters field). */
export function describeFilters(f = state.filters) {
  const out = [];
  const day = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (f.type !== 'All') out.push({ key: 'type', label: f.type });
  if (f.search) out.push({ key: 'search', label: `“${f.search}”` });
  if (f.month) { const [y, m] = f.month.split('-'); out.push({ key: 'month', label: `${MONTHS[+m]} ${y}` }); }
  if (f.from) out.push({ key: 'from', label: `from ${day(f.from)}` });
  if (f.to) out.push({ key: 'to', label: `to ${day(f.to)}` });
  if (f.duplicatesOnly) out.push({ key: 'duplicatesOnly', label: 'merged workouts only' });
  return out;
}

/** Reset one filter field to its empty value. */
export function clearFilter(key) {
  const empty = { type: 'All', search: '', month: null, from: null, to: null, duplicatesOnly: false };
  if (key in empty) state.filters[key] = empty[key];
}

export function clearFilters() {
  Object.assign(state.filters, { type: 'All', from: null, to: null, search: '', duplicatesOnly: false, month: null });
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
