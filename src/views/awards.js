/**
 * views/awards.js
 * Badges, grouped by category. Apple mode reads these as Awards (earned badges
 * with dates); Strava mode shows them as a trophy case inside Profile.
 *
 * Rule evaluation lives in analysis/awards.js. Personal-record awards need the
 * fastest efforts across every route, which means loading trackpoints, so the
 * view first renders without them and fills them in once the routes are ready.
 */

import { state, scoped, dataAnchor } from '../core/state.js';
import { escapeHtml } from '../core/lib/util.js';
import { formatDistance, formatDate } from '../core/lib/format.js';
import { computeAwards, awardsByCategory } from '../analysis/health/awards.js';
import { bestEffortsAcross } from '../analysis/activity/efforts.js';
import { ensureRoutes } from '../core/data/routes.js';
import { badgeSvg } from '../components/badge.js';

const CATEGORY_LABEL = {
  distance: 'Distance', streak: 'Streaks', pr: 'Personal records', rings: 'Activity rings',
  challenge: 'Monthly challenge', variety: 'Variety', consistency: 'Consistency',
};

let efforts = null;
let effortsKey = '';
let loadToken = 0;

function progressText(a) {
  if (a.earned) return `Earned ${formatDate(a.earned, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (a.progress === null || a.progress === undefined) return a.target_label || '';
  const pct = Math.round(a.progress * 100);
  if (a.kind === 'distance_m') return `${formatDistance(a.value)} of ${formatDistance(a.target)} · ${pct}%`;
  if (a.kind === 'count') return `${Math.round(a.value)} of ${Math.round(a.target)} · ${pct}%`;
  return `${pct}%`;
}

export function awardsGridHtml(list, { onlyEarned = false } = {}) {
  const groups = awardsByCategory(list)
    .map(g => ({ ...g, awards: onlyEarned ? g.awards.filter(a => a.earned) : g.awards }))
    .filter(g => g.awards.length);
  if (!groups.length) return '<p class="muted-note">No awards yet — keep moving.</p>';

  return groups.map(g => `
    <section class="award-group" aria-labelledby="ag-${g.category}">
      <h2 id="ag-${g.category}" class="award-cat">${escapeHtml(CATEGORY_LABEL[g.category] || g.category)}
        <span>${g.awards.filter(a => a.earned).length} / ${g.awards.length}</span></h2>
      <ul class="award-grid">
        ${g.awards.map(a => `
          <li class="award ${a.earned ? 'earned' : 'locked'}">
            ${badgeSvg(a, { size: 84 })}
            <div class="award-text">
              <strong>${escapeHtml(a.title)}</strong>
              <span class="award-desc">${escapeHtml(a.desc)}</span>
              <span class="award-prog">${escapeHtml(progressText(a))}</span>
              ${!a.earned && a.progress > 0 ? `<span class="award-meter" aria-hidden="true"><span style="width:${Math.round(a.progress * 100)}%"></span></span>` : ''}
            </div>
          </li>`).join('')}
      </ul>
    </section>`).join('');
}

/** Compute awards for the current scope, using cached efforts if they match. */
export function currentAwards() {
  const acts = scoped();
  const key = acts.map(a => a.id).join('|');
  return computeAwards(acts, state.summaries, { now: dataAnchor(), efforts: key === effortsKey ? efforts : undefined });
}

/** Load routes for runs/rides, compute best efforts, then call back to re-render. */
export async function loadEfforts(onReady) {
  const acts = scoped();
  const key = acts.map(a => a.id).join('|');
  if (key === effortsKey && efforts) return;
  const my = ++loadToken;
  const racers = acts.filter(a => a.has_route && (a.type === 'Run' || a.type === 'Ride'));
  if (!racers.length) { effortsKey = key; efforts = []; return; }
  await ensureRoutes(racers, { concurrency: 6 });
  if (my !== loadToken) return;
  efforts = bestEffortsAcross(racers.filter(a => a.route_points && a.route_points.length));
  effortsKey = key;
  onReady?.();
}

export function renderAwards() {
  const root = document.getElementById('view-awards');
  if (!root) return;
  const list = currentAwards();
  const earned = list.filter(a => a.earned).length;
  root.innerHTML = `
  <div class="view-shell awards-shell">
    <header class="view-head">
      <h1 class="view-title">Awards</h1>
      <p class="view-sub">${earned} earned of ${list.length}</p>
    </header>
    <div id="awards-body">${awardsGridHtml(list)}</div>
  </div>`;
  loadEfforts(() => {
    if (document.getElementById('view-awards')?.classList.contains('active')) {
      const body = root.querySelector('#awards-body');
      if (body) body.innerHTML = awardsGridHtml(currentAwards());
    }
  });
}

/** Best efforts across all loaded routes, or null while they're still loading. */
export const cachedEfforts = () => efforts;
