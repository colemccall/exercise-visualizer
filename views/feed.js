/**
 * views/feed.js
 * The activity feed. Strava reads it as a feed of cards (title, stat trio, route
 * thumbnail, week summary alongside); Apple mode reads the same markup as the
 * Workouts list. Markup is shared, CSS and the choice of headline stats differ
 * per mode.
 *
 * Cards are plain links to #/activity/<id>, so they are keyboard- and
 * middle-click-friendly (the old activity rows were clickable <div>s).
 */

import { state, filtered, scoped, emit, dataAnchor } from '../core/state.js';
import { getMode } from '../core/modes.js';
import { hrefFor } from '../core/router.js';
import { escapeHtml, debounce } from '../core/util.js';
import {
  formatDistance, formatDuration, formatMovingTime, formatElevation, formatEffort, formatCalories,
  formatDate, formatTimeOfDay, formatHR,
} from '../core/format.js';
import { ensureRoute } from '../core/routes.js';
import { groupByMonth, weeklySummary, recentTypeMix } from '../analysis/feed.js';
import { routeThumbSvg } from '../components/thumb.js';
import { typeIcon } from '../components/icons.js';
import { TYPE_COLORS } from '../design-system/activity-colors.js';

const PAGE = 24;
let shown = PAGE;
let built = false;
let thumbObserver = null;

const SOURCE_LABEL = { strava: 'Strava', apple: 'Apple Watch' };

/** Headline stats per mode: [label, value] pairs, empty ones dropped. */
function statsFor(a, modeId) {
  const t = a.moving_s || a.duration_s;
  const hasDist = (a.distance_m || 0) > 50;
  const dist = hasDist ? ['Distance', formatDistance(a.distance_m)] : null;
  const effort = hasDist ? [a.type === 'Ride' ? 'Speed' : 'Pace', formatEffort(a)] : null;
  const time = ['Time', formatDuration(t)];
  const elev = a.elevation_gain_m > 5 ? ['Elev', formatElevation(a.elevation_gain_m)] : null;
  const kcal = a.calories_kcal ? ['Energy', formatCalories(a.calories_kcal)] : null;
  const hr = a.avg_heart_rate ? ['Avg HR', formatHR(a.avg_heart_rate)] : null;

  const pick = modeId === 'apple' ? [dist, time, kcal, hr]
    : modeId === 'strava' ? [dist, effort, time, elev]
    : [dist, effort, time, kcal || elev || hr];
  return pick.filter(Boolean);
}

function sourceBadges(a) {
  return (a.sources || [a.source]).map(s => `<span class="src-badge ${s}">${SOURCE_LABEL[s] || s}</span>`).join('');
}

export function cardHtml(a, modeId = getMode().id) {
  const color = TYPE_COLORS[a.type] || TYPE_COLORS.Other;
  const title = a.name || a.sub_type || a.type;
  const sub = a.sub_type && a.sub_type !== a.type ? a.sub_type : a.type;
  const stats = statsFor(a, modeId).map(([l, v]) => `
      <div class="fc-stat"><span class="fc-lbl">${escapeHtml(l)}</span><span class="fc-val">${escapeHtml(v)}</span></div>`).join('');
  return `
  <a class="feed-card" href="${hrefFor('activity', a.id)}" data-id="${escapeHtml(a.id)}" style="--type-color:${color}">
    <div class="fc-head">
      <span class="fc-avatar" aria-hidden="true">${typeIcon(a.type)}</span>
      <div class="fc-title">
        <h3>${escapeHtml(title)}</h3>
        <p><span class="fc-type">${escapeHtml(sub)}</span> · ${escapeHtml(formatDate(a.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))} · ${escapeHtml(formatTimeOfDay(a.date))}</p>
      </div>
      <span class="fc-badges">${sourceBadges(a)}</span>
    </div>
    <div class="fc-body ${a.has_route ? '' : 'no-thumb'}">
      <div class="fc-stats">${stats}</div>
      ${a.has_route ? '<div class="fc-thumb" aria-hidden="true"></div>' : ''}
    </div>
  </a>`;
}

/** Fill in route thumbnails as cards scroll into view. */
export function hydrateThumbs(root) {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const card = e.target;
        const a = state.activities.find(x => x.id === card.dataset.id);
        const slot = card.querySelector('.fc-thumb');
        if (!a || !slot) continue;
        ensureRoute(a).then(points => {
          const svg = a._thumb ??= routeThumbSvg(points);
          if (svg) slot.innerHTML = svg; else card.querySelector('.fc-body')?.classList.add('no-thumb');
        });
      }
    }, { rootMargin: '300px 0px' });
  }
  root.querySelectorAll('.feed-card .fc-thumb').forEach(el => thumbObserver.observe(el.closest('.feed-card')));
}

function sidebarHtml() {
  const acts = scoped();
  const w = weeklySummary(acts, dataAnchor());
  const max = Math.max(1, ...w.days.map(d => d.moving_s));
  const dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const mix = recentTypeMix(acts, dataAnchor(), 90);

  const delta = (cur, prev) => (prev > 0 ? `${cur >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}% vs last week` : '');
  return `
  <section class="side-card" aria-labelledby="week-h">
    <h2 id="week-h" class="side-title">This week</h2>
    <div class="week-bars" role="img" aria-label="Time per day this week">
      ${w.days.map((d, i) => `
        <div class="week-day" title="${escapeHtml(formatMovingTime(d.moving_s))}">
          <span class="week-bar"><span style="height:${Math.round((d.moving_s / max) * 100)}%"></span></span>
          <span class="week-dow">${dow[i]}</span>
        </div>`).join('')}
    </div>
    <dl class="week-totals">
      <div><dt>Distance</dt><dd>${escapeHtml(formatDistance(w.this_week.distance_m))}</dd><small>${escapeHtml(delta(w.this_week.distance_m, w.last_week.distance_m))}</small></div>
      <div><dt>Time</dt><dd>${escapeHtml(formatMovingTime(w.this_week.moving_s))}</dd></div>
      <div><dt>Workouts</dt><dd>${w.this_week.count}</dd></div>
    </dl>
  </section>
  ${mix.length ? `
  <section class="side-card" aria-labelledby="mix-h">
    <h2 id="mix-h" class="side-title">Last 90 days</h2>
    <div class="mix-bar" role="img" aria-label="Share of time by activity type">
      ${mix.map(m => `<span style="flex:${m.share};background:${TYPE_COLORS[m.type] || TYPE_COLORS.Other}" title="${escapeHtml(m.type)}"></span>`).join('')}
    </div>
    <ul class="mix-legend">
      ${mix.map(m => `<li><span class="swatch" style="background:${TYPE_COLORS[m.type] || TYPE_COLORS.Other}"></span>${escapeHtml(m.type)}<b>${m.count}</b></li>`).join('')}
    </ul>
  </section>` : ''}`;
}

function build(root) {
  const mode = getMode();
  root.innerHTML = `
  <div class="view-shell feed-shell">
    <header class="view-head">
      <h1 class="view-title" id="feed-title">${mode.id === 'apple' ? 'Workouts' : 'Activity feed'}</h1>
      <p class="view-sub" id="feed-count" aria-live="polite"></p>
    </header>
    <div class="feed-tools">
      <label class="sr-only" for="feed-search">Search activities</label>
      <input type="search" id="feed-search" placeholder="Search activities…" autocomplete="off" />
      <div class="chips" id="feed-chips" role="group" aria-label="Filter by type"></div>
    </div>
    <div class="feed-layout">
      <div class="feed-main" id="feed-list"></div>
      <aside class="feed-side" id="feed-side" aria-label="Summary"></aside>
    </div>
  </div>`;

  // State updates immediately (so a re-render can't revert the input); only the redraw is debounced.
  const redraw = debounce(() => { shown = PAGE; emit('filters'); }, 180);
  root.querySelector('#feed-search').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    redraw();
  });
  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) { state.filters.type = chip.dataset.chip; shown = PAGE; emit('filters'); }
    if (e.target.closest('#feed-more')) { shown += PAGE; renderFeed(); }
    if (e.target.closest('#feed-clear')) { Object.assign(state.filters, { type: 'All', search: '', month: null }); emit('filters'); }
  });
  built = true;
}

export function resetFeedPaging() { shown = PAGE; }

export function renderFeed() {
  const root = document.getElementById('view-feed');
  if (!root) return;
  if (!built || root.dataset.mode !== getMode().id) { build(root); root.dataset.mode = getMode().id; }

  const modeId = getMode().id;
  const all = scoped();
  const list = filtered();

  root.querySelector('#feed-title').textContent = modeId === 'apple' ? 'Workouts' : 'Activity feed';
  root.querySelector('#feed-count').textContent = list.length === all.length
    ? `${all.length.toLocaleString()} activities`
    : `${list.length.toLocaleString()} of ${all.length.toLocaleString()} activities`;

  const search = root.querySelector('#feed-search');
  if (document.activeElement !== search) search.value = state.filters.search;

  // Type chips: only the types you actually have.
  const types = ['All', ...['Run', 'Ride', 'Walk', 'Hike', 'Swim', 'Other'].filter(t => all.some(a => a.type === t))];
  root.querySelector('#feed-chips').innerHTML = types.map(t => `
    <button type="button" class="chip" data-chip="${t}" aria-pressed="${state.filters.type === t}">${t}</button>`).join('');

  const listEl = root.querySelector('#feed-list');
  if (!list.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>No activities match your filters.</p>
        <button type="button" class="bs-btn bs-btn-secondary" id="feed-clear">Clear filters</button>
      </div>`;
  } else {
    const visible = list.slice(0, shown);
    const groups = groupByMonth(visible);
    listEl.innerHTML = groups.map(g => `
      <section class="feed-group" aria-label="${escapeHtml(g.label)}">
        <h2 class="feed-month">${escapeHtml(g.label)}
          <span>${g.items.length} · ${escapeHtml(formatDistance(g.totals.distance_m))} · ${escapeHtml(formatMovingTime(g.totals.moving_s))}</span>
        </h2>
        ${g.items.map(a => cardHtml(a, modeId)).join('')}
      </section>`).join('') + (list.length > shown
        ? `<div class="feed-more"><button type="button" class="bs-btn bs-btn-secondary" id="feed-more">Show more (${(list.length - shown).toLocaleString()} left)</button></div>`
        : '');
    hydrateThumbs(listEl);
  }

  root.querySelector('#feed-side').innerHTML = sidebarHtml();
}
