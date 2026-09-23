/**
 * charts/stats.js
 * Derived statistics over a set of activities.
 *
 * computeStats() does the arithmetic and returns plain data; renderStats()
 * turns that into DOM. All formatting is delegated to the `fmt` helpers passed
 * in from app.js so units stay in one place.
 *
 * Every stat carries a `hint` — the one-line explanation shown under the
 * number. These stats are only useful if you can tell what they mean without
 * guessing.
 */

const DAY_MS = 86400000;
const EVEREST_M = 8848.86;      // sea level to summit
const EARTH_CIRCUM_M = 40075000; // equatorial

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** Local-calendar day key — never toISOString(), which shifts by UTC offset. */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayKeyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Monday-anchored week key, so "best week" means a real calendar week. */
function weekKey(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (t.getDay() + 6) % 7; // Monday = 0
  t.setDate(t.getDate() - offset);
  return dayKey(t);
}

function shortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * @param {Activity[]} activities  Already filtered — stats describe what's on screen
 * @param {object} fmt  { distance, elevation, movingTime, duration, pace, units }
 * @returns {{groups: object[], hasAny: boolean}}
 */
export function computeStats(activities, fmt) {
  const acts = activities.filter(a => a.date instanceof Date && !isNaN(a.date));
  if (acts.length === 0) return { groups: [], hasAny: false };

  const sorted   = [...acts].sort((a, b) => a.date - b.date);
  const first    = sorted[0].date;
  const last     = sorted[sorted.length - 1].date;
  const spanDays = Math.max(1, Math.round((last - first) / DAY_MS) + 1);
  const weeks    = Math.max(1, spanDays / 7);

  const totalDist = acts.reduce((s, a) => s + (a.distance_m || 0), 0);
  const totalSecs = acts.reduce((s, a) => s + (a.duration_s || 0), 0);
  const totalElev = acts.reduce((s, a) => s + (a.elevation_gain_m || 0), 0);

  // ── Per-day / per-week aggregates ──────────────────────────────────────────
  const byDay  = new Map(); // dayKey  → { count, dist }
  const byWeek = new Map(); // weekKey → { count, dist }
  const byMonth = new Map(); // 'YYYY-M' → { count, dist }
  const weekdayCounts = new Array(7).fill(0);
  const hourCounts    = new Array(24).fill(0);

  for (const a of acts) {
    const dk = dayKey(a.date);
    const day = byDay.get(dk) || { count: 0, dist: 0 };
    day.count++; day.dist += a.distance_m || 0;
    byDay.set(dk, day);

    const wk = weekKey(a.date);
    const wkEntry = byWeek.get(wk) || { count: 0, dist: 0 };
    wkEntry.count++; wkEntry.dist += a.distance_m || 0;
    byWeek.set(wk, wkEntry);

    const mk = `${a.date.getFullYear()}-${a.date.getMonth()}`;
    const mEntry = byMonth.get(mk) || { count: 0, dist: 0 };
    mEntry.count++; mEntry.dist += a.distance_m || 0;
    byMonth.set(mk, mEntry);

    weekdayCounts[a.date.getDay()]++;
    hourCounts[a.date.getHours()]++;
  }

  // ── Streaks ────────────────────────────────────────────────────────────────
  const dayKeys = [...byDay.keys()].sort();
  let longestStreak = 0, runStreak = 0, streakEnd = null, bestStreakEnd = null;
  let prev = null;
  for (const key of dayKeys) {
    const d = dayKeyToDate(key);
    if (prev && Math.round((d - prev) / DAY_MS) === 1) runStreak++;
    else runStreak = 1;
    streakEnd = d;
    if (runStreak > longestStreak) { longestStreak = runStreak; bestStreakEnd = streakEnd; }
    prev = d;
  }

  // Current streak: counted back from today, or from yesterday when today is
  // still empty — a rest day in progress shouldn't zero out a live streak.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const shiftDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
  let currentStreak = 0;
  let cursor = byDay.has(dayKey(today)) ? today : shiftDays(today, -1);
  while (byDay.has(dayKey(cursor))) {
    currentStreak++;
    cursor = shiftDays(cursor, -1);
  }
  const daysSinceLast = Math.floor((today - new Date(last.getFullYear(), last.getMonth(), last.getDate())) / DAY_MS);

  // Longest gap between consecutive active days
  let longestGap = 0, gapEnd = null;
  for (let i = 1; i < dayKeys.length; i++) {
    const gap = Math.round((dayKeyToDate(dayKeys[i]) - dayKeyToDate(dayKeys[i - 1])) / DAY_MS) - 1;
    if (gap > longestGap) { longestGap = gap; gapEnd = dayKeyToDate(dayKeys[i]); }
  }

  const busiestDay = [...byDay.entries()].sort((a, b) => b[1].count - a[1].count || b[1].dist - a[1].dist)[0];
  const bestWeek   = [...byWeek.entries()].sort((a, b) => b[1].dist - a[1].dist)[0];
  const bestMonth  = [...byMonth.entries()].sort((a, b) => b[1].dist - a[1].dist)[0];
  const favWeekday = weekdayCounts.indexOf(Math.max(...weekdayCounts));
  const favHour    = hourCounts.indexOf(Math.max(...hourCounts));

  // ── Records ────────────────────────────────────────────────────────────────
  const best = (pool, pick) => pool.reduce((b, a) => (!b || pick(a) > pick(b) ? a : b), null);
  const longestDist = best(acts.filter(a => a.distance_m > 0), a => a.distance_m);
  const longestTime = best(acts.filter(a => a.duration_s > 0), a => a.duration_s);
  const biggestClimb = best(acts.filter(a => a.elevation_gain_m > 0), a => a.elevation_gain_m);

  const paceable = acts.filter(a => a.distance_m > 1609 && a.duration_s > 60);
  const fastestRun = paceable
    .filter(a => a.type === 'Run')
    .reduce((b, a) => (!b || a.duration_s / a.distance_m < b.duration_s / b.distance_m ? a : b), null);
  const fastestRide = paceable
    .filter(a => a.type === 'Ride')
    .reduce((b, a) => (!b || a.distance_m / a.duration_s > b.distance_m / b.duration_s ? a : b), null);

  // ── Heart rate ─────────────────────────────────────────────────────────────
  const withHR = acts.filter(a => a.avg_heart_rate > 0);
  const hrWeighted = withHR.reduce((s, a) => s + a.avg_heart_rate * (a.duration_s || 0), 0);
  const hrSeconds  = withHR.reduce((s, a) => s + (a.duration_s || 0), 0);
  const avgHR = hrSeconds > 0 ? Math.round(hrWeighted / hrSeconds) : null;
  const maxHRAct = best(acts.filter(a => a.max_heart_rate > 0), a => a.max_heart_rate);
  const hardestAct = best(withHR, a => a.avg_heart_rate);

  // ── Per-type breakdown ─────────────────────────────────────────────────────
  const byType = new Map();
  for (const a of acts) {
    const t = byType.get(a.type) || { type: a.type, count: 0, dist: 0, secs: 0, elev: 0 };
    t.count++; t.dist += a.distance_m || 0; t.secs += a.duration_s || 0; t.elev += a.elevation_gain_m || 0;
    byType.set(a.type, t);
  }
  const types = [...byType.values()].sort((a, b) => b.count - a.count);

  const routed = acts.filter(a => a.has_route || a.route_points);

  const stat = (label, value, hint, extra = {}) => ({ label, value, hint, ...extra });

  const groups = [
    {
      id: 'volume',
      title: 'Volume',
      blurb: 'How much you covered across the activities currently in view.',
      stats: [
        stat('Avg per activity', fmt.distance(totalDist / acts.length),
             `Mean distance over ${acts.length.toLocaleString()} activities`),
        stat('Typical length', fmt.movingTime(Math.round(totalSecs / acts.length)),
             'Mean moving time per activity'),
        stat('Distance per week', fmt.distance(totalDist / weeks),
             `Averaged over ${Math.round(spanDays).toLocaleString()} days`),
        stat('Activities per week', (acts.length / weeks).toFixed(1),
             'Long-run average, including weeks you took off'),
        stat('Everests climbed', (totalElev / EVEREST_M).toFixed(2),
             `${fmt.elevation(totalElev)} of climbing ÷ ${fmt.elevation(EVEREST_M)}`),
        stat('Around the Earth', `${((totalDist / EARTH_CIRCUM_M) * 100).toFixed(1)}%`,
             `Of one ${fmt.distance(EARTH_CIRCUM_M)} lap of the equator`),
        stat('With GPS route', `${routed.length.toLocaleString()}`,
             `${Math.round((routed.length / acts.length) * 100)}% of activities draw on the map`),
        stat('Sources', `${new Set(acts.map(a => a.source)).size}`,
             [...new Set(acts.map(a => a.source))].join(' + ') || '—'),
      ],
    },
    {
      id: 'consistency',
      title: 'Consistency',
      blurb: 'Showing up — days, streaks, and when you tend to train.',
      stats: [
        stat('Active days', byDay.size.toLocaleString(),
             `${Math.round((byDay.size / spanDays) * 100)}% of the ${spanDays.toLocaleString()}-day span`),
        stat('Longest streak', `${longestStreak} ${longestStreak === 1 ? 'day' : 'days'}`,
             bestStreakEnd ? `Ended ${shortDate(bestStreakEnd)}` : 'Consecutive days with an activity'),
        stat('Current streak', `${currentStreak} ${currentStreak === 1 ? 'day' : 'days'}`,
             currentStreak > 0 ? 'Consecutive days up to today' : 'No activity today or yesterday'),
        stat('Days since last', daysSinceLast <= 0 ? 'Today' : `${daysSinceLast}`,
             `Last activity ${shortDate(last)}`),
        stat('Longest break', `${longestGap} ${longestGap === 1 ? 'day' : 'days'}`,
             gapEnd ? `Broken ${shortDate(gapEnd)}` : 'Largest gap between active days'),
        stat('Busiest day', busiestDay ? `${busiestDay[1].count}` : '—',
             busiestDay ? `${busiestDay[1].count} activities on ${shortDate(dayKeyToDate(busiestDay[0]))}` : ''),
        stat('Favourite day', WEEKDAYS[favWeekday],
             `${weekdayCounts[favWeekday].toLocaleString()} activities started on a ${WEEKDAYS[favWeekday]}`),
        stat('Usual start', formatHour(favHour),
             `Most activities begin in the ${favHour}:00 hour`),
      ],
    },
    {
      id: 'records',
      title: 'Records',
      blurb: 'Your bests in view. Click any card to open that activity.',
      stats: [
        longestDist && stat('Longest distance', fmt.distance(longestDist.distance_m),
          `${longestDist.name} · ${shortDate(longestDist.date)}`, { activityId: longestDist.id }),
        longestTime && stat('Longest duration', fmt.duration(longestTime.duration_s),
          `${longestTime.name} · ${shortDate(longestTime.date)}`, { activityId: longestTime.id }),
        biggestClimb && stat('Biggest climb', fmt.elevation(biggestClimb.elevation_gain_m),
          `${biggestClimb.name} · ${shortDate(biggestClimb.date)}`, { activityId: biggestClimb.id }),
        fastestRun && stat('Fastest run', fmt.pace(fastestRun.distance_m, fastestRun.duration_s),
          `${fmt.distance(fastestRun.distance_m)} · ${shortDate(fastestRun.date)}`, { activityId: fastestRun.id }),
        fastestRide && stat('Fastest ride', fmt.speed(fastestRide.distance_m, fastestRide.duration_s),
          `${fmt.distance(fastestRide.distance_m)} · ${shortDate(fastestRide.date)}`, { activityId: fastestRide.id }),
        bestWeek && stat('Best week', fmt.distance(bestWeek[1].dist),
          `Week of ${shortDate(dayKeyToDate(bestWeek[0]))} · ${bestWeek[1].count} activities`),
        bestMonth && stat('Best month', fmt.distance(bestMonth[1].dist),
          `${MONTHS[+bestMonth[0].split('-')[1]]} ${bestMonth[0].split('-')[0]} · ${bestMonth[1].count} activities`),
      ].filter(Boolean),
    },
  ];

  if (withHR.length > 0) {
    groups.push({
      id: 'heart',
      title: 'Heart',
      blurb: `Heart-rate data is present on ${withHR.length.toLocaleString()} of ${acts.length.toLocaleString()} activities.`,
      stats: [
        avgHR && stat('Average HR', `${avgHR} bpm`, 'Weighted by time, not by activity count'),
        maxHRAct && stat('Peak HR', `${maxHRAct.max_heart_rate} bpm`,
          `${maxHRAct.name} · ${shortDate(maxHRAct.date)}`, { activityId: maxHRAct.id }),
        hardestAct && stat('Hardest effort', `${hardestAct.avg_heart_rate} bpm avg`,
          `${hardestAct.name} · ${shortDate(hardestAct.date)}`, { activityId: hardestAct.id }),
        stat('HR coverage', `${Math.round((withHR.length / acts.length) * 100)}%`,
          'Share of activities that recorded heart rate'),
      ].filter(Boolean),
    });
  }

  return {
    groups,
    types,
    totals: { totalDist, totalSecs, totalElev, count: acts.length, first, last, spanDays },
    hasAny: true,
  };
}

function formatHour(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Full stats panel — grouped tiles plus the per-type breakdown table.
 *
 * @param {HTMLElement} container
 * @param {Activity[]} activities
 * @param {object} opts  { fmt, onOpenActivity(id) }
 */
export function renderStats(container, activities, opts = {}) {
  const { fmt, onOpenActivity } = opts;
  const data = computeStats(activities, fmt);

  if (!data.hasAny) {
    container.innerHTML = '<div class="stats-empty">No activities match your filters — nothing to summarise.</div>';
    return;
  }

  let html = '';

  for (const group of data.groups) {
    html += `
      <div class="stat-group">
        <div class="stat-group-head">
          <span class="stat-group-title">${escapeHtml(group.title)}</span>
          <span class="stat-group-blurb">${escapeHtml(group.blurb)}</span>
        </div>
        <div class="stat-tiles">
          ${group.stats.map(s => `
            <${s.activityId ? 'button type="button"' : 'div'} class="stat-tile${s.activityId ? ' clickable' : ''}"
              ${s.activityId ? `data-activity="${escapeHtml(s.activityId)}"` : ''}>
              <div class="stat-tile-val">${escapeHtml(s.value)}</div>
              <div class="stat-tile-lbl">${escapeHtml(s.label)}</div>
              <div class="stat-tile-hint">${escapeHtml(s.hint || '')}</div>
            </${s.activityId ? 'button' : 'div'}>
          `).join('')}
        </div>
      </div>`;
  }

  // Per-type breakdown
  const maxDist = Math.max(1, ...data.types.map(t => t.dist));
  html += `
    <div class="stat-group">
      <div class="stat-group-head">
        <span class="stat-group-title">By activity type</span>
        <span class="stat-group-blurb">Bars are share of total distance.</span>
      </div>
      <table class="stat-table">
        <thead>
          <tr><th>Type</th><th>Activities</th><th>Distance</th><th>Time</th><th>Climb</th><th class="stat-table-bar-col">Share</th></tr>
        </thead>
        <tbody>
          ${data.types.map(t => `
            <tr>
              <td><span class="stat-type-dot" data-type="${escapeHtml(t.type)}"></span>${escapeHtml(t.type)}</td>
              <td>${t.count.toLocaleString()}</td>
              <td>${escapeHtml(fmt.distance(t.dist))}</td>
              <td>${escapeHtml(fmt.movingTime(t.secs))}</td>
              <td>${escapeHtml(fmt.elevation(t.elev))}</td>
              <td class="stat-table-bar-col">
                <span class="stat-bar"><span class="stat-bar-fill" data-type="${escapeHtml(t.type)}" style="width:${Math.round((t.dist / maxDist) * 100)}%"></span></span>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  container.innerHTML = html;

  // Colour the type dots/bars from the shared palette, set by the caller.
  if (opts.typeColors) {
    container.querySelectorAll('[data-type]').forEach(el => {
      const c = opts.typeColors[el.dataset.type] || opts.typeColors.Other;
      if (el.classList.contains('stat-type-dot')) el.style.background = c;
      else el.style.background = c;
    });
  }

  if (onOpenActivity) {
    container.querySelectorAll('.stat-tile.clickable').forEach(btn => {
      btn.addEventListener('click', () => onOpenActivity(btn.dataset.activity));
    });
  }
}
