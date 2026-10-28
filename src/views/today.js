/**
 * views/today.js
 * The landing view for Apple and Hybrid modes ("Summary" / "Today").
 *
 *   Rings   Move / Exercise / Stand for a day, or *cumulative* over a week, month or
 *           year (every day added up, against the sum of each day's own goal).
 *           Real values from Apple's ActivitySummary; nothing is estimated.
 *   Trends  last 90 days against the 365-day baseline
 *   Recent  the newest workouts
 *   Awards  the most recently earned badges
 *
 * Without Apple data there are no rings, so the card becomes an invitation to
 * add an Apple Health export instead of showing fake numbers.
 */

import { state, scoped, dataAnchor } from '../core/state.js';
import { getMode } from '../core/modes.js';
import { hrefFor } from '../core/router.js';
import { escapeHtml, MONTH_NAMES } from '../core/lib/util.js';
import {
  formatDistance, formatMovingTime, formatPaceSecPerM, formatCalories,
} from '../core/lib/format.js';
import { dayKey, keyToDate, addDays, parseKey } from '../analysis/dates.js';
import {
  ringsForDay, ringStreaks, monthRings, periodRingTotals, periodBounds, yearMonthTotals,
} from '../analysis/health/rings.js';
import { computeTrends } from '../analysis/activity/trends.js';
import { computeAwards } from '../analysis/health/awards.js';
import { ringsSvg, animateRings, ringsLabel } from '../components/ring.js';
import { badgeSvg } from '../components/badge.js';
import { icon } from '../components/icons.js';
import { cardHtml, hydrateThumbs } from './feed.js';

let range = 'day';   // 'day' | 'week' | 'month' | 'year'
let selected = null; // 'YYYY-MM-DD' (any day within the range)

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RANGES = ['day', 'week', 'month', 'year'];
/** Move is calories for most people, but minutes for Move-Minutes users (parser sets move_unit). */
const ringRows = () => [
  ['move', 'Move', state.summaries.some(s => s.move_unit === 'min') ? 'min' : 'kcal'],
  ['exercise', 'Exercise', 'min'], ['stand', 'Stand', 'hrs'],
];

function formatTrendValue(t, v) {
  switch (t.unit_kind) {
    case 'distance': return formatDistance(v);
    case 'duration': return formatMovingTime(v);
    case 'pace': return formatPaceSecPerM(v);
    case 'hr': return `${Math.round(v)} bpm`;
    case 'energy': return formatCalories(v);
    default: return v.toFixed(1);
  }
}

const num = (n) => Math.round(n).toLocaleString();
const shortDate = (key) => keyToDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** One day: value over that day's goal (a ring with no goal set says so instead of "/0"). */
function ringStats(day) {
  return ringRows().map(([k, name, unit]) => {
    const r = day[k];
    const goal = r.goal > 0 ? `<small>/${num(r.goal)} ${unit}</small>` : `<small> ${unit} · no goal set</small>`;
    return `
    <div class="ring-stat ${k}">
      <span class="ring-stat-name"><i aria-hidden="true"></i>${name}</span>
      <span class="ring-stat-val">${num(r.value)}${goal}</span>
    </div>`;
  }).join('');
}

/** A period: Σ progress over Σ per-day goals, plus how many days closed it. */
function totalsStats(p) {
  return ringRows().map(([k, name, unit]) => {
    const t = p[k];
    const goal = t.has_goal ? `<small>/${num(t.goal)} ${unit}</small>` : `<small> ${unit} · no goal set</small>`;
    const sub = t.has_goal
      ? `${t.closed_days} of ${t.goal_days} days closed · ${Math.round(t.pct * 100)}%`
      : 'goal not set for this period';
    return `
    <div class="ring-stat ${k}">
      <span class="ring-stat-name"><i aria-hidden="true"></i>${name}</span>
      <span class="ring-stat-val">${num(t.value)}${goal}</span>
      <span class="ring-stat-sub">${sub}</span>
    </div>`;
  }).join('');
}

/** Totals in the shape ringsSvg/ringsLabel expect. */
const totalsAsRings = (p) => ({ move: p.move, exercise: p.exercise, stand: p.stand });

function coverageNote(p, bounds) {
  const parts = [`${p.days_with_data} of ${p.days_in_period} days have data`];
  if (bounds.capped) parts.push(`through ${shortDate(bounds.to)}`);
  if (p.all_closed_days) parts.push(`all three rings closed on ${p.all_closed_days}`);
  return `<p class="coverage-note">${escapeHtml(parts.join(' · '))}</p>`;
}

function periodHeading(kind, bounds) {
  if (kind === 'week') return `Week of ${shortDate(bounds.from)} – ${shortDate(bounds.full_to)}`;
  const { y, m } = parseKey(bounds.from);
  return kind === 'month' ? `${MONTH_NAMES[m - 1]} ${y}` : String(y);
}

function ringsCardHtml() {
  const sums = state.summaries;
  if (!sums.length) {
    return `
    <section class="today-card rings-card empty" aria-labelledby="rings-h">
      <h2 id="rings-h" class="card-title">Activity rings</h2>
      <div class="rings-empty">
        ${ringsSvg({ move: { pct: 0.7 }, exercise: { pct: 0.45 }, stand: { pct: 0.85 } }, { size: 120 })}
        <p>Add an Apple Health export to see your Move, Exercise and Stand rings, streaks and awards.</p>
        <button type="button" class="bs-btn bs-btn-primary" data-action="upload">${icon('upload', { size: 18 })} Add Apple Health data</button>
      </div>
    </section>`;
  }

  const firstKey = sums[0].date;
  const lastKey = sums[sums.length - 1].date;
  if (!selected || selected > lastKey) selected = lastKey;
  if (selected < firstKey) selected = firstKey;
  const streaks = ringStreaks(sums);

  let body = '';
  let heading = '';
  let atStart = false, atEnd = false;

  if (range === 'day') {
    const d = ringsForDay(sums, selected);
    heading = keyToDate(selected).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    atStart = selected <= firstKey; atEnd = selected >= lastKey;
    body = d
      ? `<div class="rings-day">
           <div class="rings-hero">${ringsSvg(d, { size: 176, label: ringsLabel(d) })}</div>
           <div class="ring-stats">${ringStats(d)}</div>
         </div>`
      : '<p class="muted-note center">No ring data for this day.</p>';
  } else {
    const bounds = periodBounds(range, selected, lastKey);
    const p = periodRingTotals(sums, bounds.from, bounds.to);
    heading = periodHeading(range, bounds);
    atStart = bounds.from <= firstKey; atEnd = bounds.to >= lastKey;
    const cumulative = p.days_with_data
      ? `<div class="rings-day">
           <div class="rings-hero">${ringsSvg(totalsAsRings(p), { size: 176, label: `Total for ${heading}: ${ringsLabel(totalsAsRings(p))}` })}</div>
           <div class="ring-stats">${totalsStats(p)}</div>
         </div>
         ${coverageNote(p, bounds)}`
      : '<p class="muted-note center">No ring data in this period.</p>';

    let detail = '';
    if (range === 'week') {
      const days = Array.from({ length: 7 }, (_, i) => addDays(bounds.from, i));
      detail = `<div class="rings-week">${days.map((key, i) => {
        const d = ringsForDay(sums, key);
        return `<button type="button" class="ring-day ${key === selected ? 'sel' : ''}" data-day="${key}" aria-label="${DOW[i]}: ${d ? escapeHtml(ringsLabel(d)) : 'no data'}">
          ${ringsSvg(d, { size: 52, stroke: 6 })}<span>${DOW[i][0]}</span></button>`;
      }).join('')}</div>`;
    } else if (range === 'month') {
      const { y, m } = parseKey(bounds.from);
      const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday-first
      detail = `
      <div class="rings-month" role="group" aria-label="${heading}">
        ${DOW.map(d => `<span class="rm-dow">${d[0]}</span>`).join('')}
        ${'<span></span>'.repeat(lead)}
        ${monthRings(sums, y, m).map(c => `
          <button type="button" class="ring-day mini ${c.date === selected ? 'sel' : ''}" data-day="${c.date}" aria-label="${c.date}: ${c.has_data ? escapeHtml(ringsLabel(c)) : 'no data'}">
            ${ringsSvg(c.has_data ? c : null, { size: 38, stroke: 5 })}<span>${c.day}</span>
          </button>`).join('')}
      </div>`;
    } else {
      const { y } = parseKey(bounds.from);
      detail = `<div class="rings-year" role="group" aria-label="Each month of ${y}">${yearMonthTotals(sums, y).map(mt => {
        const key = `${y}-${String(mt.month).padStart(2, '0')}-01`;
        const has = mt.days_with_data > 0;
        return `<button type="button" class="ring-day month" data-month="${key}" ${has ? '' : 'disabled'} aria-label="${MONTH_NAMES[mt.month - 1]}: ${has ? `${mt.all_closed_days} days with all rings closed, ${mt.days_with_data} days of data` : 'no data'}">
          ${ringsSvg(has ? totalsAsRings(mt) : null, { size: 52, stroke: 6 })}<span>${MONTH_NAMES[mt.month - 1].slice(0, 3)}</span></button>`;
      }).join('')}</div>`;
    }
    body = cumulative + detail;
  }

  return `
  <section class="today-card rings-card" aria-labelledby="rings-h">
    <div class="card-head">
      <h2 id="rings-h" class="card-title">Activity rings</h2>
      <div class="seg" role="tablist" aria-label="Range">
        ${RANGES.map(r => `<button type="button" role="tab" aria-selected="${range === r}" data-range="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="rings-nav">
      <button type="button" class="icon-btn" data-step="-1" aria-label="Previous ${range}" ${atStart ? 'disabled' : ''}>${icon('back')}</button>
      <strong class="rings-heading" aria-live="polite">${escapeHtml(heading)}</strong>
      <button type="button" class="icon-btn" data-step="1" aria-label="Next ${range}" ${atEnd ? 'disabled' : ''}>${icon('chevron')}</button>
    </div>
    ${body}
    <div class="streak-row" title="Streaks are counted back from the newest day in your data, ${shortDate(lastKey)}">
      <span class="chip static">${icon('flame', { size: 16 })} ${streaks.closeAllCurrent}-day streak</span>
      <span class="chip static">Best ${streaks.closeAllLongest} days</span>
      <span class="chip static">Move streak ${streaks.moveCurrent}</span>
      <span class="streak-asof">as of ${escapeHtml(shortDate(lastKey))}</span>
    </div>
  </section>`;
}

function trendsHtml() {
  const trends = computeTrends(scoped(), dataAnchor());
  if (!trends.length) {
    return `<section class="today-card" aria-labelledby="tr-h"><h2 id="tr-h" class="card-title">Trends</h2>
      <p class="muted-note">Trends compare your last 90 days with the past year. They appear once you have about four months of history.</p></section>`;
  }
  return `
  <section class="today-card" aria-labelledby="tr-h">
    <div class="card-head"><h2 id="tr-h" class="card-title">Trends</h2><span class="card-sub">Last 90 days vs past year</span></div>
    <ul class="trend-list">
      ${trends.map(t => {
        const dir = t.direction;
        const cls = dir === 'flat' ? 'flat' : t.favorable === true ? 'good' : t.favorable === false ? 'bad' : 'neutral';
        const word = dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'steady';
        return `<li class="trend ${cls}">
          <span class="trend-arrow">${icon(dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'flat', { size: 22 })}</span>
          <span class="trend-body">
            <span class="trend-label">${escapeHtml(t.label)}</span>
            <span class="trend-vals">${escapeHtml(formatTrendValue(t, t.recent))} <small>vs ${escapeHtml(formatTrendValue(t, t.baseline))}</small></span>
          </span>
          <span class="trend-pct" aria-label="${word}${t.pct !== null ? ' ' + Math.abs(Math.round(t.pct * 100)) + ' percent' : ''}">${t.pct === null ? '' : (t.pct > 0 ? '+' : '') + Math.round(t.pct * 100) + '%'}</span>
        </li>`;
      }).join('')}
    </ul>
  </section>`;
}

function recentHtml(modeId) {
  const recent = scoped().slice(0, 5);
  if (!recent.length) return '';
  return `
  <section class="today-card wide" aria-labelledby="rc-h">
    <div class="card-head"><h2 id="rc-h" class="card-title">${modeId === 'apple' ? 'Recent workouts' : 'Latest activity'}</h2>
      <a class="card-link" href="${hrefFor('feed')}">See all ${icon('chevron', { size: 16 })}</a></div>
    <div class="today-recent">${recent.map(a => cardHtml(a, modeId)).join('')}</div>
  </section>`;
}

function awardsPreviewHtml() {
  const earned = computeAwards(scoped(), state.summaries, { now: dataAnchor() })
    .filter(a => a.earned).sort((a, b) => b.earned - a.earned).slice(0, 4);
  if (!earned.length) return '';
  return `
  <section class="today-card" aria-labelledby="aw-h">
    <div class="card-head"><h2 id="aw-h" class="card-title">Awards</h2>
      <a class="card-link" href="${hrefFor('awards')}">See all ${icon('chevron', { size: 16 })}</a></div>
    <ul class="award-strip">
      ${earned.map(a => `<li>${badgeSvg(a, { size: 72 })}<span>${escapeHtml(a.title)}</span></li>`).join('')}
    </ul>
  </section>`;
}

export function renderToday(handlers = {}) {
  const root = document.getElementById('view-today');
  if (!root) return;
  const mode = getMode();
  const now = dataAnchor();

  root.innerHTML = `
  <div class="view-shell today-shell">
    <header class="view-head">
      <p class="view-eyebrow">${escapeHtml((Math.abs(Date.now() - now) > 864e5 * 2 ? 'Data through ' : '') + now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: Math.abs(Date.now() - now) > 864e5 * 2 ? 'numeric' : undefined }))}</p>
      <h1 class="view-title">${mode.id === 'apple' ? 'Summary' : 'Today'}</h1>
    </header>
    <div class="today-grid">
      ${ringsCardHtml()}
      ${trendsHtml()}
      ${awardsPreviewHtml()}
      ${recentHtml(mode.id)}
    </div>
  </div>`;

  animateRings(root);
  hydrateThumbs(root);

  root.onclick = (e) => {
    const r = e.target.closest('[data-range]');
    if (r) { range = r.dataset.range; renderToday(handlers); return; }
    const day = e.target.closest('[data-day]');
    if (day) { selected = day.dataset.day; range = 'day'; renderToday(handlers); return; }
    const month = e.target.closest('[data-month]');
    if (month && !month.disabled) { selected = month.dataset.month; range = 'month'; renderToday(handlers); return; }
    const step = e.target.closest('[data-step]');
    if (step && !step.disabled && selected) {
      const dir = +step.dataset.step;
      const { y, m } = parseKey(selected);
      if (range === 'day') selected = addDays(selected, dir);
      else if (range === 'week') selected = addDays(selected, 7 * dir);
      else if (range === 'month') selected = dayKey(new Date(y, m - 1 + dir, 1));
      else selected = dayKey(new Date(y + dir, 0, 1));
      renderToday(handlers);
      return;
    }
    if (e.target.closest('[data-action="upload"]')) handlers.openUpload?.();
  };
}
