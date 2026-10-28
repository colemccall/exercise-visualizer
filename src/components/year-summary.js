/**
 * components/year-summary.js
 * Yearly totals in the Strava profile style: a year selector (plus all-time),
 * headline numbers, month-by-month distance against the previous year, a
 * weekly-consistency strip and a per-type breakdown.
 *
 * Used by the Profile view (Strava mode) and at the top of Stats (Hybrid/Apple).
 */

import { escapeHtml, MONTH_SHORT } from '../core/lib/util.js';
import { formatDistance, formatMovingTime, formatElevation, formatDate, distanceParts } from '../core/lib/format.js';
import { availableYears, yearlyStats, compareYears } from '../analysis/activity/yearly.js';
import { hrefFor } from '../core/router.js';
import { TYPE_COLORS } from '../design-system/activity-colors.js';

/**
 * @param {HTMLElement} container
 * @param {object[]} acts      activities in scope (already merged-away filtered)
 * @param {{year?: number|null, onYear?: (y:number|null)=>void}} [opts]
 */
export function renderYearSummary(container, acts, { year, onYear } = {}) {
  const years = availableYears(acts);
  if (!years.length) { container.innerHTML = '<p class="muted-note">No activities yet.</p>'; return; }
  const sel = year === undefined || (year !== null && !years.includes(year)) ? years[0] : year;
  const s = yearlyStats(acts, sel);
  const cmp = sel ? compareYears(acts, sel - 1, sel) : null;

  const tile = (label, value, unit = '') => `
    <div class="ys-tile"><span class="ys-lbl">${escapeHtml(label)}</span>
      <span class="ys-val">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</span></div>`;
  const d = distanceParts(s.distance_m);
  const el = formatElevation(s.elevation_m).split(' ');

  const monthMax = Math.max(1, ...(cmp ? cmp.by_month.map(m => Math.max(m.a, m.b)) : s.by_month.map(m => m.distance_m)));
  const bars = (cmp ? cmp.by_month : s.by_month.map((m, i) => ({ month: i, a: 0, b: m.distance_m }))).map((m, i) => `
    <div class="mb" title="${MONTH_SHORT[i]}: ${escapeHtml(formatDistance(m.b))}${cmp ? ` (prev year ${escapeHtml(formatDistance(m.a))})` : ''}">
      <span class="mb-bars">
        ${cmp ? `<span class="mb-bar prev" style="height:${Math.round((m.a / monthMax) * 100)}%"></span>` : ''}
        <span class="mb-bar cur" style="height:${Math.round((m.b / monthMax) * 100)}%"></span>
      </span>
      <span class="mb-lbl">${MONTH_SHORT[i][0]}</span>
    </div>`).join('');

  const types = Object.entries(s.by_type).sort((a, b) => b[1].moving_s - a[1].moving_s);
  const typeMax = Math.max(1, ...types.map(([, v]) => v.moving_s));
  const weekMax = Math.max(1, ...s.by_week.map(w => w.count));

  container.innerHTML = `
  <div class="ys">
    <div class="ys-years" role="tablist" aria-label="Year">
      ${years.map(y => `<button type="button" role="tab" aria-selected="${sel === y}" data-year="${y}">${y}</button>`).join('')}
      <button type="button" role="tab" aria-selected="${sel === null}" data-year="all">All time</button>
    </div>

    <div class="ys-tiles">
      ${tile('Activities', s.count.toLocaleString())}
      ${tile('Distance', d.value, d.unit)}
      ${tile('Time', formatMovingTime(s.moving_s))}
      ${tile('Elevation', el[0], el[1])}
      ${tile('Active days', s.active_days.toLocaleString())}
      ${s.calories_kcal ? tile('Energy', Math.round(s.calories_kcal).toLocaleString(), 'kcal') : ''}
    </div>

    <div class="ys-grid">
      <section class="ys-card" aria-labelledby="ys-m">
        <h3 id="ys-m" class="ys-title">Distance by month ${cmp ? `<span class="legend"><i class="cur"></i>${sel} <i class="prev"></i>${sel - 1}</span>` : ''}</h3>
        <div class="month-bars" role="img" aria-label="Distance per month">${bars}</div>
      </section>
      <section class="ys-card" aria-labelledby="ys-t">
        <h3 id="ys-t" class="ys-title">By activity type</h3>
        <ul class="type-bars">
          ${types.map(([t, v]) => `
            <li><span class="tb-name"><i style="background:${TYPE_COLORS[t] || TYPE_COLORS.Other}"></i>${escapeHtml(t)}</span>
              <span class="tb-bar"><span style="width:${Math.max(3, Math.round((v.moving_s / typeMax) * 100))}%;background:${TYPE_COLORS[t] || TYPE_COLORS.Other}"></span></span>
              <span class="tb-val">${v.count} · ${escapeHtml(formatMovingTime(v.moving_s))}</span></li>`).join('')}
        </ul>
      </section>
      <section class="ys-card wide" aria-labelledby="ys-w">
        <h3 id="ys-w" class="ys-title">Weekly consistency</h3>
        <div class="week-strip" role="img" aria-label="Activities per week across the year">
          ${s.by_week.map((w, i) => `<span class="ws" style="--lvl:${(w.count / weekMax).toFixed(2)}" title="Week ${i + 1}: ${w.count} activities"></span>`).join('')}
        </div>
      </section>
      ${s.longest_activity || s.biggest_climb ? `
      <section class="ys-card wide" aria-labelledby="ys-r">
        <h3 id="ys-r" class="ys-title">Highlights</h3>
        <ul class="highlights">
          ${s.longest_activity ? `<li><span>Longest</span><a href="${hrefFor('activity', s.longest_activity.id)}">${escapeHtml(s.longest_activity.name)}</a><b>${escapeHtml(formatDistance(s.longest_activity.distance_m))} · ${escapeHtml(formatDate(s.longest_activity.date))}</b></li>` : ''}
          ${s.biggest_climb ? `<li><span>Biggest climb</span><a href="${hrefFor('activity', s.biggest_climb.id)}">${escapeHtml(s.biggest_climb.name)}</a><b>${escapeHtml(formatElevation(s.biggest_climb.elevation_gain_m))} · ${escapeHtml(formatDate(s.biggest_climb.date))}</b></li>` : ''}
        </ul>
      </section>` : ''}
    </div>
  </div>`;

  container.querySelector('.ys-years').addEventListener('click', (e) => {
    const b = e.target.closest('[data-year]');
    if (!b) return;
    onYear?.(b.dataset.year === 'all' ? null : +b.dataset.year);
  });
}
