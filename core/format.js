/**
 * core/format.js
 * Unit state and every user-visible number formatter. Everything the UI shows as
 * a distance, pace, elevation or duration goes through here so the km/mi toggle
 * is honoured in one place (a hardcoded "km" once slipped into a tooltip).
 *
 * Miles are the default. `fitness-units` alone is not trusted at startup: an
 * earlier build wrote a value into it on load, so a stored preference only counts
 * when `fitness-units-explicit` is '1', which setUnits() sets on a real click.
 */

import { safeStorage } from './util.js';

const M_PER_MI = 1609.344;

let units = safeStorage.get('fitness-units-explicit') === '1'
  ? (safeStorage.get('fitness-units') || 'imperial')
  : 'imperial';

export const getUnits = () => units;

/** @param {'metric'|'imperial'} next  @param {boolean} explicit true for a real user click */
export function setUnits(next, explicit = true) {
  units = next;
  safeStorage.set('fitness-units', units);
  if (explicit) safeStorage.set('fitness-units-explicit', '1');
}

const pad2 = n => String(n).padStart(2, '0');

export function formatDistance(metres) {
  if (metres === null || metres === undefined || Number.isNaN(metres)) return '—';
  if (units === 'imperial') {
    const mi = metres / M_PER_MI;
    return mi >= 10 ? `${mi.toFixed(1)} mi` : `${mi.toFixed(2)} mi`;
  }
  const km = metres / 1000;
  return km >= 10 ? `${km.toFixed(1)} km` : `${km.toFixed(2)} km`;
}

/** Distance split into a number and a unit, for big-numeral tiles. */
export function distanceParts(metres) {
  if (metres === null || metres === undefined) return { value: '—', unit: '' };
  if (units === 'imperial') {
    const mi = metres / M_PER_MI;
    return { value: mi >= 100 ? Math.round(mi).toLocaleString() : mi.toFixed(mi >= 10 ? 1 : 2), unit: 'mi' };
  }
  const km = metres / 1000;
  return { value: km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(km >= 10 ? 1 : 2), unit: 'km' };
}

export function formatElevation(metres) {
  if (metres === null || metres === undefined) return '—';
  return units === 'imperial' ? `${Math.round(metres * 3.28084).toLocaleString()} ft` : `${Math.round(metres).toLocaleString()} m`;
}

/** Coarse "3h 20m" for totals. */
export function formatMovingTime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  if (h >= 100) return `${h.toLocaleString()}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Clock style "1:02:03" / "42:10". */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

/** Pace from seconds-per-metre, e.g. "8:42 /mi". */
export function formatPaceSecPerM(secPerM, { suffix = true } = {}) {
  if (!secPerM || !Number.isFinite(secPerM) || secPerM <= 0) return '—';
  const per = units === 'imperial' ? secPerM * M_PER_MI : secPerM * 1000;
  const total = Math.round(per);
  const text = `${Math.floor(total / 60)}:${pad2(total % 60)}`;
  return suffix ? `${text} /${units === 'imperial' ? 'mi' : 'km'}` : text;
}

export function formatPace(distance_m, duration_s) {
  if (!distance_m || !duration_s) return '—';
  return formatPaceSecPerM(duration_s / distance_m);
}

/** Speed reads better than pace for rides. */
export function formatSpeed(distance_m, duration_s) {
  if (!distance_m || !duration_s) return '—';
  return formatSpeedMps(distance_m / duration_s);
}

export function formatSpeedMps(mps) {
  if (!mps || !Number.isFinite(mps)) return '—';
  const perHour = mps * 3600;
  return units === 'imperial' ? `${(perHour / M_PER_MI).toFixed(1)} mph` : `${(perHour / 1000).toFixed(1)} km/h`;
}

/** Pace for runners and walkers, speed for everything wheeled. */
export function formatEffort(activity) {
  const t = activity.moving_s || activity.duration_s;
  return activity.type === 'Ride'
    ? formatSpeed(activity.distance_m, t)
    : formatPace(activity.distance_m, t);
}

export const paceUnitLabel = () => (units === 'imperial' ? '/mi' : '/km');
export const distanceUnitLabel = () => (units === 'imperial' ? 'mi' : 'km');
export const elevationUnitLabel = () => (units === 'imperial' ? 'ft' : 'm');

export const formatCalories = kcal => (kcal === null || kcal === undefined ? '—' : `${Math.round(kcal).toLocaleString()} kcal`);
export const formatHR = bpm => (bpm ? `${Math.round(bpm)} bpm` : '—');

export function formatDate(date, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return date ? date.toLocaleDateString('en-US', opts) : '';
}
export const formatDateLong = date => formatDate(date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
export const formatTimeOfDay = date => (date ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');

/** Formatters bundled for charts/stats.js, which has no unit state of its own. */
export function formatters() {
  return {
    units,
    distance: formatDistance,
    elevation: formatElevation,
    movingTime: formatMovingTime,
    duration: formatDuration,
    pace: formatPace,
    speed: formatSpeed,
  };
}
