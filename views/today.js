/**
 * views/today.js
 * The landing view for Apple and Hybrid modes ("Summary" / "Today").
 *
 *   Rings   Move / Exercise / Stand for a day, a week or a month (real values
 *           from Apple's ActivitySummary; nothing is estimated)
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
import { escapeHtml, MONTH_NAMES } from '../core/util.js';
import {
  formatDistance, formatMovingTime, formatPaceSecPerM, formatCalories,
} from '../core/format.js';
import { dayKey, weekStartKey, keyToDate, addDays, parseKey } from '../analysis/dates.js';
import { ringsForDay, ringStreaks, monthRings, weeklyRingTotals } from '../analysis/rings.js';
import { computeTrends } from '../analysis/trends.js';
import { computeAwards } from '../analysis/awards.js';
import { ringsSvg, animateRings, ringsLabel } from '../components/ring.js';
import { badgeSvg } from '../components/badge.js';
import { icon } from '../components/icons.js';
import { cardHtml, hydrateThumbs } from './feed.js';

let range = 'day';   // 'day' | 'week' | 'month'
let selected = null; // 'YYYY-MM-DD' (any day within the range)

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

function ringStats(day) {
  const row = (cls, name, r, unit) => `
    <div class="ring-stat ${cls}">
      <span class="ring-stat-name"><i aria-hidden="true"></i>${name}</span>
      <span class="ring-stat-val">${Math.round(r.value)}<small>/${Math.round(r.goal)} ${unit}</small></span>
    </div>`;
  return row('move', 'Move', day.move, 'kcal') + row('exercise', 'Exercise', day.exercise, 'min') + row('stand', 'Stand', day.stand, 'hrs');
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

  const lastKey = sums[sums.length - 1].date;
  if (!selected || selected > lastKey) selected = lastKey;
  const streaks = ringStreaks(sums);
  let body = '';
  let heading = '';

  if (range === 'day') {
    const d = ringsForDay(sums, selected);
    heading = keyToDate(selected).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    body = d
      ? `<div class="rings-day">
           <div class="rings-hero">${ringsSvg(d, { size: 176, label: ringsLabel(d) })}</div>
           <div class="ring-stats">${ringStats(d)}</div>
         </div>`
      : '<p class="muted-note center">No ring data for this day.</p>';
  } else if (range === 'week') {
    const start = weekStartKey(selected);
    const w = weeklyRingTotals(sums, start);
    heading = `Week of ${keyToDate(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    body = `
      <div class="rings-week">
        ${w.days.map((d, i) => `
          <button type="button" class="ring-day ${addDays(start, i) === selected ? 'sel' : ''}" data-day="${addDays(start, i)}" aria-label="${DOW[i]}: ${escapeHtml(ringsLabel(d))}">
            ${ringsSvg(d, { size: 52, stroke: 6 })}<span>${DOW[i][0]}</span>
          </button>`).join('')}
      </div>
      <dl class="week-ring-totals">
        <div><dt>Move</dt><dd>${Math.round(w.move_kcal).toLocaleString()}<small> kcal</small></dd></div>
        <div><dt>Exercise</dt><dd>${Math.round(w.exercise_min).toLocaleString()}<small> min</small></dd></div>
        <div><dt>Stand</dt><dd>${Math.round(w.stand_hours)}<small> hrs</small></dd></div>
        <div><dt>Rings closed</dt><dd>${w.closed.all}<small> / 7 days</small></dd></div>
      </dl>`;
  } else {
    const { y, m } = parseKey(selected);
    const cal = monthRings(sums, y, m);
    heading = `${MONTH_NAMES[m - 1]} ${y}`;
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday-first
    body = `
      <div class="rings-month" role="group" aria-label="${heading}">
        ${DOW.map(d => `<span class="rm-dow">${d[0]}</span>`).join('')}
        ${'<span></span>'.repeat(lead)}
        ${cal.map(c => `
          <button type="button" class="ring-day mini ${c.date === selected ? 'sel' : ''}" data-day="${c.date}" aria-label="${c.date}${c.move ? ': ' + escapeHtml(ringsLabel(c)) : ': no data'}">
            ${ringsSvg(c.move ? c : null, { size: 38, stroke: 5 })}<span>${c.day}</span>
          </button>`).join('')}
      </div>`;
  }

  return `
  <section class="today-card rings-card" aria-labelledby="rings-h">
    <div class="card-head">
      <h2 id="rings-h" class="card-title">Activity rings</h2>
      <div class="seg" role="tablist" aria-label="Range">
        ${['day', 'week', 'month'].map(r => `<button type="button" role="tab" aria-selected="${range === r}" data-range="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="rings-nav">
      <button type="button" class="icon-btn" data-step="-1" aria-label="Previous ${range}">${icon('back')}</button>
      <strong class="rings-heading" aria-live="polite">${escapeHtml(heading)}</strong>
      <button type="button" class="icon-btn" data-step="1" aria-label="Next ${range}" ${selected >= lastKey && range === 'day' ? 'disabled' : ''}>${icon('chevron')}</button>
    </div>
    ${body}
    <div class="streak-row">
      <span class="chip static">${icon('flame', { size: 16 })} ${streaks.closeAllCurrent}-day streak</span>
      <span class="chip static">Best ${streaks.closeAllLongest} days</span>
      <span class="chip static">Move streak ${streaks.moveCurrent}</span>
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
    if (day) { selected = day.dataset.day; range = range === 'month' ? 'day' : range; renderToday(handlers); return; }
    const step = e.target.closest('[data-step]');
    if (step && selected) {
      const dir = +step.dataset.step;
      if (range === 'day') selected = addDays(selected, dir);
      else if (range === 'week') selected = addDays(selected, 7 * dir);
      else { const { y, m } = parseKey(selected); selected = dayKey(new Date(y, m - 1 + dir, 1)); }
      const last = state.summaries[state.summaries.length - 1]?.date;
      if (last && selected > last) selected = last;
      renderToday(handlers);
      return;
    }
    if (e.target.closest('[data-action="upload"]')) handlers.openUpload?.();
  };
}
