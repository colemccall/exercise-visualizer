/**
 * views/profile.js
 * Strava-mode profile: year selector + totals, personal bests across every
 * route, and a trophy case of earned awards. (Hybrid and Apple show the same
 * year summary at the top of Stats.)
 */

import { scoped } from '../core/state.js';
import { escapeHtml } from '../core/util.js';
import { formatDuration, formatDate } from '../core/format.js';
import { hrefFor } from '../core/router.js';
import { renderYearSummary } from '../components/year-summary.js';
import { currentAwards, awardsGridHtml, loadEfforts, cachedEfforts } from './awards.js';

let year; // undefined = latest year

function effortsHtml() {
  const efforts = cachedEfforts();
  if (efforts === null) return '<p class="muted-note">Searching your routes for personal bests…</p>';
  if (!efforts.length) return '<p class="muted-note">Personal bests appear once you have runs or rides with GPS and timestamps.</p>';
  const runs = efforts.filter(e => e.type === 'Run'), rides = efforts.filter(e => e.type === 'Ride');
  const table = (title, list) => !list.length ? '' : `
    <table class="pb-table">
      <caption>${title}</caption>
      <thead><tr><th scope="col">Distance</th><th scope="col">Time</th><th scope="col">Date</th></tr></thead>
      <tbody>${list.map(e => `<tr><th scope="row">${escapeHtml(e.label)}</th>
        <td><a href="${hrefFor('activity', e.activity_id)}">${escapeHtml(formatDuration(e.time_s))}</a></td>
        <td>${escapeHtml(formatDate(e.date))}</td></tr>`).join('')}</tbody>
    </table>`;
  return `<div class="pb-grid">${table('Running', runs)}${table('Cycling', rides)}</div>`;
}

export function renderProfile() {
  const root = document.getElementById('view-profile');
  if (!root) return;
  root.innerHTML = `
  <div class="view-shell profile-shell">
    <header class="view-head">
      <h1 class="view-title">Profile</h1>
      <p class="view-sub">Your training, year by year</p>
    </header>
    <div id="profile-year"></div>
    <section class="act-card" aria-labelledby="pb-h">
      <h2 id="pb-h" class="act-card-title">Personal bests</h2>
      <div id="profile-pb">${effortsHtml()}</div>
    </section>
    <section class="act-card" aria-labelledby="tc-h">
      <h2 id="tc-h" class="act-card-title">Trophy case</h2>
      <div id="profile-awards">${awardsGridHtml(currentAwards(), { onlyEarned: true })}</div>
    </section>
    <p class="profile-link"><a href="${hrefFor('charts')}">Detailed statistics &amp; charts &rarr;</a></p>
  </div>`;

  const draw = () => renderYearSummary(root.querySelector('#profile-year'), scoped(), {
    year, onYear: (y) => { year = y; draw(); },
  });
  draw();

  loadEfforts(() => {
    const pb = root.querySelector('#profile-pb');
    if (pb) { pb.innerHTML = effortsHtml(); }
    const aw = root.querySelector('#profile-awards');
    if (aw) aw.innerHTML = awardsGridHtml(currentAwards(), { onlyEarned: true });
  });
  if (cachedEfforts()) root.querySelector('#profile-pb').innerHTML = effortsHtml();
}
