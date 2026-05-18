/**
 * charts/records.js
 * Personal records panel — no D3 needed.
 * Shows longest, fastest, most elevation, longest streak, etc.
 */

export function renderRecords(activities, container, units = 'metric') {
  container.innerHTML = '';
  if (activities.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No data</p>';
    return;
  }

  const isImp = units === 'imperial';
  const km = m => (m / 1000).toFixed(1);
  const mi = m => (m / 1609.344).toFixed(1);
  const dist = m => m > 0 ? (isImp ? `${mi(m)} mi` : `${km(m)} km`) : null;
  const elev = m => m != null ? (isImp ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`) : null;
  const dur  = s => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
  const pace = (dist_m, dur_s) => {
    if (!dist_m || !dur_s) return null;
    if (isImp) { const spm = dur_s / (dist_m / 1609.344); return `${Math.floor(spm/60)}:${String(Math.floor(spm%60)).padStart(2,'0')} /mi`; }
    const spk = dur_s / (dist_m / 1000);
    return `${Math.floor(spk/60)}:${String(Math.floor(spk%60)).padStart(2,'0')} /km`;
  };

  const runs  = activities.filter(a => a.type === 'Run' && a.distance_m > 100);
  const rides = activities.filter(a => a.type === 'Ride' && a.distance_m > 100);
  const all   = activities.filter(a => a.distance_m > 100);

  const records = [];

  // Longest run
  if (runs.length) {
    const best = runs.reduce((a, b) => a.distance_m > b.distance_m ? a : b);
    records.push({ label: 'Longest Run', value: dist(best.distance_m), date: best.date, type: 'Run' });
  }
  // Fastest run pace (at least 1km / 0.6mi)
  const minDist = isImp ? 965 : 1000; // ~1km or ~0.6mi
  const paceRuns = runs.filter(a => a.distance_m >= minDist && a.duration_s > 0);
  if (paceRuns.length) {
    const best = paceRuns.reduce((a, b) => {
      const pa = a.duration_s / (a.distance_m / 1000);
      const pb = b.duration_s / (b.distance_m / 1000);
      return pa < pb ? a : b;
    });
    records.push({ label: 'Fastest Run Pace', value: pace(best.distance_m, best.duration_s), date: best.date, type: 'Run' });
  }
  // Longest ride
  if (rides.length) {
    const best = rides.reduce((a, b) => a.distance_m > b.distance_m ? a : b);
    records.push({ label: 'Longest Ride', value: dist(best.distance_m), date: best.date, type: 'Ride' });
  }
  // Most elevation gain
  const withElev = activities.filter(a => a.elevation_gain_m > 10);
  if (withElev.length) {
    const best = withElev.reduce((a, b) => a.elevation_gain_m > b.elevation_gain_m ? a : b);
    records.push({ label: 'Most Elevation', value: elev(best.elevation_gain_m), date: best.date, type: best.type });
  }
  // Longest single activity by duration
  const withDur = activities.filter(a => a.duration_s > 0);
  if (withDur.length) {
    const best = withDur.reduce((a, b) => a.duration_s > b.duration_s ? a : b);
    records.push({ label: 'Longest Duration', value: dur(best.duration_s), date: best.date, type: best.type });
  }
  // Longest streak (consecutive days with activity)
  const streak = longestStreak(activities);
  if (streak.days > 1) {
    records.push({ label: 'Longest Streak', value: `${streak.days} days`, date: streak.endDate, type: null });
  }
  // Most active month
  const monthBest = busiestMonth(activities);
  if (monthBest) {
    records.push({ label: 'Most Active Month', value: `${monthBest.count} activities`, date: monthBest.date, type: null });
  }

  const TYPE_COLORS = { Run:'#FF6B6B', Ride:'#4A90D9', Walk:'#5CB85C', Hike:'#F0AD4E', Swim:'#5BC0DE', Other:'#aaaaaa' };

  container.innerHTML = records.filter(r => r.value).map(r => {
    const color = r.type ? (TYPE_COLORS[r.type] || '#aaa') : 'var(--accent)';
    const dateStr = r.date ? r.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return `
      <div class="record-row">
        <div class="record-dot" style="background:${color}"></div>
        <div class="record-info">
          <div class="record-label">${r.label}</div>
          ${dateStr ? `<div class="record-date">${dateStr}</div>` : ''}
        </div>
        <div class="record-value">${r.value}</div>
      </div>`;
  }).join('');
}

function longestStreak(activities) {
  const days = new Set(activities.filter(a => a.date).map(a => {
    const d = new Date(a.date); d.setHours(0,0,0,0); return d.getTime();
  }));
  const sorted = [...days].sort((a,b)=>a-b);
  let best = 1, cur = 1, bestEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i-1] === 86400000) { cur++; if (cur > best) { best = cur; bestEnd = sorted[i]; } }
    else cur = 1;
  }
  return { days: best, endDate: new Date(bestEnd) };
}

function busiestMonth(activities) {
  const m = new Map();
  for (const a of activities) {
    if (!a.date) continue;
    const key = `${a.date.getFullYear()}-${a.date.getMonth()}`;
    m.set(key, { count: (m.get(key)?.count || 0) + 1, date: new Date(a.date.getFullYear(), a.date.getMonth(), 1) });
  }
  if (!m.size) return null;
  return [...m.values()].reduce((best, e) => e.count > best.count ? e : best);
}
