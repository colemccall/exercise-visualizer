/**
 * core/modes.js
 * The three experiences. A mode is a *shell* over the shared components: it
 * decides the nav, the landing view, which modules show and which activities
 * are in scope. It never touches parsing.
 *
 *   hybrid  default. Today landing (rings + trends + feed), everything on.
 *   apple   Apple Health only: Summary, Workouts, Awards, Map, Photos.
 *   strava  Strava only: Feed, Map, Profile (yearly stats + records), Photos.
 *
 * Mode and theme (light/dark) are independent: 3 x 2 designed variants.
 */

import { safeStorage } from './lib/util.js';

export const MODES = {
  hybrid: {
    id: 'hybrid',
    label: 'Hybrid',
    blurb: 'Rings, trends and the full activity feed, everything combined.',
    landing: 'today',
    nav: [
      { view: 'today',   label: 'Today' },
      { view: 'feed',    label: 'Feed' },
      { view: 'map',     label: 'Map' },
      { view: 'awards',  label: 'Awards' },
      { view: 'charts',  label: 'Stats' },
      { view: 'photos',  label: 'Photos' },
    ],
    source: null,
  },
  apple: {
    id: 'apple',
    label: 'Apple',
    blurb: 'Activity rings, trends and awards from Apple Health.',
    landing: 'today',
    nav: [
      { view: 'today',   label: 'Summary' },
      { view: 'feed',    label: 'Workouts' },
      { view: 'awards',  label: 'Awards' },
      { view: 'map',     label: 'Map' },
      { view: 'photos',  label: 'Photos' },
    ],
    source: 'apple',
  },
  strava: {
    id: 'strava',
    label: 'Strava',
    blurb: 'Your activity feed, detailed analysis and yearly stats from Strava.',
    landing: 'feed',
    nav: [
      { view: 'feed',    label: 'Feed' },
      { view: 'map',     label: 'Map' },
      { view: 'profile', label: 'Profile' },
      { view: 'photos',  label: 'Photos' },
    ],
    source: 'strava',
  },
};

export const MODE_IDS = Object.keys(MODES);

let current = 'hybrid';

export function getMode() { return MODES[current]; }

/** Which sources are present in a list of activities / summaries. */
export function detectSources(activities, summaries = []) {
  const has = { strava: false, apple: false };
  for (const a of activities) {
    for (const s of (a.sources || [a.source])) has[s] = true;
    if (has.strava && has.apple) break;
  }
  if (summaries.length) has.apple = true;
  return has;
}

/** Can this mode show anything for the loaded sources? */
export function modeAvailable(modeId, has) {
  const src = MODES[modeId].source;
  return !src || !!has[src];
}

/**
 * Restore the saved mode. The app defaults to hybrid; a saved choice only
 * counts while its source is still loaded (a stored "apple" with no Apple data
 * would be an empty app).
 */
export function restoreMode(has) {
  const saved = safeStorage.get('fitness-mode');
  current = saved && MODES[saved] && modeAvailable(saved, has) ? saved : 'hybrid';
  return getMode();
}

export function setMode(modeId, has) {
  if (!MODES[modeId] || !modeAvailable(modeId, has)) return getMode();
  current = modeId;
  safeStorage.set('fitness-mode', modeId);
  return getMode();
}

/** Activities in scope for the current mode (merged-away secondaries never are). */
export function inScope(activity, mode = getMode()) {
  if (activity.merged_into) return false;
  if (!mode.source) return true;
  return (activity.sources || [activity.source]).includes(mode.source);
}

/** Is a view part of this mode's nav (or a deep-linkable sub-view)? */
export function viewAllowed(view, mode = getMode()) {
  return view === 'activity' || mode.nav.some(n => n.view === view);
}
