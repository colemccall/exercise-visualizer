/**
 * views/activity.js
 * One activity as a page (#/activity/<id>): hero route map, headline numbers,
 * splits, best efforts and the synced elevation / pace / heart-rate / cadence /
 * power charts. Scrubbing a chart moves a marker along the route.
 *
 * Strava reads it as inline stats + splits table + best efforts; Apple reads the
 * same data as big-numeral tiles. Content is shared, the CSS differs per mode.
 */

import { state, byId, filtered, scoped } from '../core/state.js';
import { getMode } from '../core/modes.js';
import { navigate, hrefFor } from '../core/router.js';
import { escapeHtml } from '../core/lib/util.js';
import {
  getUnits, formatDistance, distanceParts, formatDuration, formatEffort, formatElevation,
  formatCalories, formatHR, formatPaceSecPerM, formatSpeedMps, formatSpeed, formatDateLong, formatTimeOfDay,
  formatDate,
} from '../core/lib/format.js';
import { ensureRoute, positioned } from '../core/data/routes.js';
import { buildSeries, hasStream } from '../analysis/activity/streams.js';
import { computeSplits } from '../analysis/activity/splits.js';
import { bestEfforts, bestEffortsAcross } from '../analysis/activity/efforts.js';
import { renderRoute } from '../map/route.js';
import { renderStreams } from '../charts/stream.js';
import { icon, typeIcon } from '../components/icons.js';
import { TYPE_COLORS } from '../design-system/activity-colors.js';

let route = null;
let streams = null;
let token = 0;
let handlers = { openPhotos: () => {} };

export function setActivityHandlers(h) { handlers = { ...handlers, ...h }; }

export function destroyActivity() {
  token++;
  route?.destroy(); route = null;
  streams?.destroy(); streams = null;
}

const SOURCE_NAME = { strava: 'Strava', apple: 'Apple Watch' };

function tilesFor(a) {
  const moving = a.moving_s || a.duration_s;
  const hasDist = (a.distance_m || 0) > 50;
  const d = distanceParts(a.distance_m);
  const tiles = [];
  if (hasDist) tiles.push({ label: 'Distance', value: d.value, unit: d.unit, key: 'distance' });
  tiles.push({ label: a.moving_s ? 'Moving time' : 'Time', value: formatDuration(moving), key: 'time' });
  if (a.moving_s && a.duration_s && a.duration_s > a.moving_s * 1.05) {
    tiles.push({ label: 'Elapsed', value: formatDuration(a.duration_s), key: 'elapsed' });
  }
  if (hasDist) {
    const e = formatEffort(a).split(' ');
    tiles.push({ label: a.type === 'Ride' ? 'Avg speed' : 'Avg pace', value: e[0], unit: e.slice(1).join(' '), key: 'pace' });
  }
  if (a.elevation_gain_m > 1) {
    const e = formatElevation(a.elevation_gain_m).split(' ');
    tiles.push({ label: 'Elevation', value: e[0], unit: e[1], key: 'elev' });
  }
  if (a.calories_kcal) tiles.push({ label: 'Energy', value: Math.round(a.calories_kcal).toLocaleString(), unit: 'kcal', key: 'kcal' });
  if (a.avg_heart_rate) tiles.push({ label: 'Avg heart rate', value: String(Math.round(a.avg_heart_rate)), unit: 'bpm', key: 'hr' });
  if (a.max_heart_rate) tiles.push({ label: 'Max heart rate', value: String(Math.round(a.max_heart_rate)), unit: 'bpm', key: 'hrmax' });
  if (a.avg_cadence) tiles.push({ label: 'Avg cadence', value: String(Math.round(a.avg_cadence)), unit: 'rpm', key: 'cad' });
  if (a.avg_watts) tiles.push({ label: 'Avg power', value: String(Math.round(a.avg_watts)), unit: 'W', key: 'watts' });
  if (a.max_speed_mps) {
    const s = formatSpeedMps(a.max_speed_mps).split(' ');
    tiles.push({ label: 'Max speed', value: s[0], unit: s[1], key: 'maxspeed' });
  }
  return tiles;
}

function sourceNote(a) {
  const src = a.sources || [a.source];
  if (src.length < 2) return '';
  const parts = [];
  if (src.includes('strava')) parts.push('name, distance and route from Strava');
  if (src.includes('apple') && (a.avg_heart_rate || a.calories_kcal)) parts.push('heart rate and energy from Apple Watch');
  return `<p class="source-note">${icon('flame', { size: 16 })}<span>Recorded by both devices and merged into one workout: ${escapeHtml(parts.join('; ') || 'combined from both sources')}.</span></p>`;
}

function splitsHtml(splits) {
  if (!splits.length) return '';
  const units = getUnits() === 'imperial' ? 'mi' : 'km';
  const full = splits.filter(s => !s.partial);
  const speeds = splits.map(s => 1 / s.pace_s_per_m);
  const maxSpeed = Math.max(...speeds), minSpeed = Math.min(...speeds);
  const fastest = full.length ? full.reduce((b, s) => (s.pace_s_per_m < b.pace_s_per_m ? s : b)) : null;
  const hasHr = splits.some(s => s.avg_hr), hasEle = splits.some(s => s.ele_gain_m !== null);
  const toDist = (m) => (getUnits() === 'imperial' ? m / 1609.344 : m / 1000);

  return `
  <section class="act-card" aria-labelledby="splits-h">
    <h2 id="splits-h" class="act-card-title">Splits</h2>
    <div class="table-scroll">
    <table class="splits">
      <thead><tr><th scope="col">${units}</th><th scope="col">Pace</th><th scope="col" class="bar-col"><span class="sr-only">Relative speed</span></th>${hasEle ? '<th scope="col">Elev</th>' : ''}${hasHr ? '<th scope="col">HR</th>' : ''}</tr></thead>
      <tbody>
      ${splits.map((s) => {
        const w = maxSpeed === minSpeed ? 100 : 35 + 65 * (1 / s.pace_s_per_m - minSpeed) / (maxSpeed - minSpeed);
        const elev = s.ele_gain_m === null ? '' : `${s.ele_gain_m >= s.ele_loss_m ? '+' : '−'}${formatElevation(Math.abs(s.ele_gain_m - s.ele_loss_m)).replace(' ', '')}`;
        return `<tr class="${fastest && s === fastest ? 'fastest' : ''}">
          <th scope="row">${s.partial ? toDist(s.dist_m).toFixed(2) : s.index}</th>
          <td>${escapeHtml(formatPaceSecPerM(s.pace_s_per_m, { suffix: false }))}</td>
          <td class="bar-col"><span class="split-bar"><span style="width:${w.toFixed(0)}%"></span></span></td>
          ${hasEle ? `<td>${escapeHtml(elev)}</td>` : ''}
          ${hasHr ? `<td>${s.avg_hr ? Math.round(s.avg_hr) : '—'}</td>` : ''}
        </tr>`;
      }).join('')}
      </tbody>
    </table>
    </div>
  </section>`;
}

function effortsHtml(efforts, a, best) {
  if (!efforts.length) return '';
  return `
  <section class="act-card" aria-labelledby="eff-h">
    <h2 id="eff-h" class="act-card-title">Best efforts</h2>
    <ul class="efforts">
      ${efforts.map((e) => {
        const isPr = best.get(e.key)?.activity_id === a.id;
        return `<li><span class="eff-label">${escapeHtml(e.label)}</span><span class="eff-time">${escapeHtml(formatDuration(e.time_s))}</span>${isPr ? '<span class="pr-badge" title="Your fastest across the activities loaded">PR</span>' : ''}</li>`;
      }).join('')}
    </ul>
  </section>`;
}

function chartRows(pts, a, units) {
  const rows = [];
  const isRide = a.type === 'Ride';
  if (hasStream(pts, 'ele')) {
    rows.push({ key: 'ele', label: 'Elevation', color: 'var(--text-muted)', area: true,
      format: v => formatElevation(v), tick: t => Math.round(units === 'imperial' ? t * 3.28084 : t) });
  }
  if (hasStream(pts, 'time')) {
    rows.push(isRide
      ? { key: 'speed', label: 'Speed', color: 'var(--accent)', clip: true,
          format: v => formatSpeedMps(v), tick: t => (units === 'imperial' ? (t * 2.23694) : (t * 3.6)).toFixed(0) }
      : { key: 'pace', label: 'Pace', color: 'var(--accent)', invert: true, clip: true,
          format: v => formatPaceSecPerM(v), tick: t => formatPaceSecPerM(t, { suffix: false }) });
  }
  if (hasStream(pts, 'hr')) rows.push({ key: 'hr', label: 'Heart rate', color: 'var(--ring-move)', format: v => formatHR(v), tick: t => Math.round(t) });
  if (hasStream(pts, 'cad')) rows.push({ key: 'cad', label: 'Cadence', color: 'var(--ring-stand)', format: v => `${Math.round(v)} rpm`, tick: t => Math.round(t) });
  if (hasStream(pts, 'watts')) rows.push({ key: 'watts', label: 'Power', color: 'var(--ring-exercise)', format: v => `${Math.round(v)} W`, tick: t => Math.round(t) });
  return rows;
}

function neighbours(a) {
  const list = filtered();
  const i = list.findIndex(x => x.id === a.id);
  if (i < 0) return { prev: null, next: null };
  return { prev: list[i + 1] || null, next: list[i - 1] || null }; // list is newest-first
}

export async function renderActivity(id) {
  const root = document.getElementById('view-activity');
  if (!root) return;
  destroyActivity();
  const my = token;

  let a = byId(id);
  if (a?.merged_into) { navigate('activity', a.merged_into, { replace: true }); return; }
  if (!a) {
    root.innerHTML = `<div class="view-shell"><div class="empty-state"><p>That activity isn't in your loaded data.</p>
      <a class="bs-btn bs-btn-secondary" href="${hrefFor('feed')}">Back to the feed</a></div></div>`;
    return;
  }

  const modeId = getMode().id;
  const units = getUnits();
  const color = TYPE_COLORS[a.type] || TYPE_COLORS.Other;
  const { prev, next } = neighbours(a);
  const tiles = tilesFor(a);
  const src = (a.sources || [a.source]).map(s => `<span class="src-badge ${s}">${SOURCE_NAME[s] || s}</span>`).join('');
  const title = a.name || a.sub_type || a.type;

  root.innerHTML = `
  <div class="view-shell act-shell" data-mode="${modeId}">
    <nav class="act-nav" aria-label="Activity navigation">
      <a class="back-link" href="${hrefFor(modeId === 'strava' ? 'feed' : 'feed')}">${icon('back', { size: 18 })}<span>${modeId === 'apple' ? 'Workouts' : 'Feed'}</span></a>
      <span class="act-nav-pager">
        ${prev ? `<a class="icon-btn" href="${hrefFor('activity', prev.id)}" aria-label="Older: ${escapeHtml(prev.name)}" title="Older activity">${icon('back')}</a>` : ''}
        ${next ? `<a class="icon-btn" href="${hrefFor('activity', next.id)}" aria-label="Newer: ${escapeHtml(next.name)}" title="Newer activity">${icon('chevron')}</a>` : ''}
      </span>
    </nav>

    <header class="act-head" style="--type-color:${color}">
      <span class="fc-avatar lg" aria-hidden="true">${typeIcon(a.type)}</span>
      <div>
        <h1 class="act-title" id="act-title" tabindex="-1">${escapeHtml(title)}</h1>
        <p class="act-meta">${escapeHtml(formatDateLong(a.date))} · ${escapeHtml(formatTimeOfDay(a.date))}
          · <span>${escapeHtml(a.sub_type && a.sub_type !== a.type ? a.sub_type : a.type)}</span> ${src}</p>
      </div>
    </header>

    ${a.description ? `<p class="act-desc">${escapeHtml(a.description)}</p>` : ''}

    <div class="act-grid">
      <div class="act-main">
        <section class="act-map-card" aria-label="Route map">
          <div id="act-map" class="act-map"><div class="map-empty">${a.has_route ? 'Loading route…' : 'No GPS route for this activity'}</div></div>
          <div class="map-colorby" id="act-colorby" hidden role="group" aria-label="Colour the route by"></div>
        </section>

        <section class="act-stats" aria-label="Activity numbers">
          ${tiles.map(t => `
            <div class="act-stat" data-key="${t.key}">
              <span class="act-stat-lbl">${escapeHtml(t.label)}</span>
              <span class="act-stat-val">${escapeHtml(t.value)}${t.unit ? `<small>${escapeHtml(t.unit)}</small>` : ''}</span>
            </div>`).join('')}
        </section>
        ${sourceNote(a)}

        <section class="act-card" id="act-charts-card" aria-labelledby="charts-h" hidden>
          <h2 id="charts-h" class="act-card-title">Analysis <span class="act-hint">Hover or drag across a chart to follow it on the map</span></h2>
          <div id="act-charts"></div>
        </section>
      </div>

      <aside class="act-side" id="act-side">
        ${a.photos?.length ? `<section class="act-card"><h2 class="act-card-title">Photos</h2>
          <button type="button" class="bs-btn bs-btn-secondary" id="act-photos">${icon('photos', { size: 18 })} Open Photo Tour (${a.photos.length})</button></section>` : ''}
      </aside>
    </div>
  </div>`;

  root.querySelector('#act-title')?.focus({ preventScroll: true });
  root.querySelector('#act-photos')?.addEventListener('click', () => handlers.openPhotos(a));

  if (!a.has_route) return;
  await ensureRoute(a);
  if (my !== token) return;

  const pts = positioned(a.route_points);
  const mapEl = root.querySelector('#act-map');
  if (pts.length < 2) { mapEl.innerHTML = '<div class="map-empty">No GPS route for this activity</div>'; return; }

  // Map + colour switch
  route = renderRoute({ ...a, route_points: a.route_points }, mapEl);
  if (route) {
    const modes = route.modes;
    const options = [['pace', a.type === 'Ride' ? 'Speed' : 'Pace', modes.pace], ['hr', 'Heart rate', modes.hr], ['none', 'Plain', true]].filter(o => o[2]);
    if (options.length > 1) {
      const wrap = root.querySelector('#act-colorby');
      wrap.hidden = false;
      wrap.innerHTML = options.map(([k, label]) => `<button type="button" data-color="${k}" aria-pressed="${k === route.colorMode}">${label}</button>`).join('');
      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('[data-color]');
        if (!b) return;
        route.setColorBy(b.dataset.color);
        wrap.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      });
    }
    setTimeout(() => route?.invalidate(), 120);
  }

  // Streams
  const rows = chartRows(pts, a, units);
  const series = buildSeries(pts);
  if (rows.length && series.dist.length > 2) {
    root.querySelector('#act-charts-card').hidden = false;
    streams = renderStreams(root.querySelector('#act-charts'), series, {
      rows, units,
      onScrub: (_i, k) => route?.setMarker(pts[k]),
      onLeave: () => route?.clearMarker(),
    });
  }

  // Splits + efforts (need timestamps)
  const side = root.querySelector('#act-side');
  if (hasStream(pts, 'time') && (a.distance_m || 0) > 400) {
    const splits = computeSplits(pts, units === 'imperial' ? 'mi' : 'km');
    const efforts = bestEfforts(pts, a.type);
    const peers = scoped().filter(x => x.route_points && x.type === a.type);
    const best = new Map(bestEffortsAcross(peers).map(e => [e.key, e]));
    side.insertAdjacentHTML('afterbegin', splitsHtml(splits) + (modeId === 'apple' ? '' : effortsHtml(efforts, a, best)));
  }
}
