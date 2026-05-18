/**
 * charts/weekly.js
 * GitHub-style activity calendar heatmap.
 * Shows 52 weeks × 7 days, intensity = activity count per day.
 */

const TYPE_COLORS = {
  Run:   '#FF6B6B',
  Ride:  '#4A90D9',
  Walk:  '#5CB85C',
  Hike:  '#F0AD4E',
  Swim:  '#5BC0DE',
  Other: '#aaaaaa',
};

export function renderWeeklyChart(activities, container) {
  container.innerHTML = '';
  if (activities.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No data</p>';
    return;
  }

  // Build day map: dateKey → { count, types, totalDist }
  const dayMap = new Map();
  for (const a of activities) {
    if (!a.date) continue;
    const d = new Date(a.date);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!dayMap.has(key)) dayMap.set(key, { count: 0, types: [], dist: 0 });
    const e = dayMap.get(key);
    e.count++;
    e.types.push(a.type);
    e.dist += a.distance_m || 0;
  }

  // Build 52-week grid ending today
  const today = new Date(); today.setHours(0,0,0,0);
  const WEEKS = 52;
  // Start from (today - 52 weeks + 1), aligned to Sunday
  const startDay = new Date(today);
  startDay.setDate(startDay.getDate() - WEEKS * 7 + 1);
  // Align back to Sunday
  startDay.setDate(startDay.getDate() - startDay.getDay());

  const days = [];
  const cur = new Date(startDay);
  while (cur <= today) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    days.push({ date: new Date(cur), key, ...(dayMap.get(key) || { count: 0, types: [], dist: 0 }) });
    cur.setDate(cur.getDate() + 1);
  }

  const maxCount = Math.max(1, d3.max(days, d => d.count));

  const CELL  = 11;
  const GAP   = 2;
  const LABEL_H = 14;
  const LABEL_W = 24;
  const W = container.clientWidth || 300;
  const cols = Math.min(WEEKS, Math.floor((W - LABEL_W) / (CELL + GAP)));
  const H = 7 * (CELL + GAP) + LABEL_H + 4;

  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);

  // Day-of-week labels (Mon, Wed, Fri)
  const DOW_LABELS = ['S','M','T','W','T','F','S'];
  DOW_LABELS.forEach((lbl, i) => {
    if (i % 2 !== 1) return; // only M, W, F
    svg.append('text')
      .attr('x', 2).attr('y', LABEL_H + i * (CELL + GAP) + CELL * 0.8)
      .attr('fill', 'var(--text-muted)').style('font-size', '8px').text(lbl);
  });

  const g = svg.append('g').attr('transform', `translate(${LABEL_W}, ${LABEL_H})`);

  // Month labels
  let lastMonth = -1;
  days.filter((d, i) => i % 7 === 0).forEach((d, wi) => {
    if (d.date.getMonth() !== lastMonth) {
      lastMonth = d.date.getMonth();
      g.append('text')
        .attr('x', wi * (CELL + GAP))
        .attr('y', -3)
        .attr('fill', 'var(--text-muted)')
        .style('font-size', '8px')
        .text(d3.timeFormat('%b')(d.date));
    }
  });

  // Tooltip
  const tooltip = addTooltip(container);

  // Cells
  g.selectAll('rect')
    .data(days)
    .join('rect')
    .attr('x', d => {
      const weekIndex = Math.floor((d.date - startDay) / (7 * 86400000));
      return weekIndex * (CELL + GAP);
    })
    .attr('y', d => d.date.getDay() * (CELL + GAP))
    .attr('width', CELL).attr('height', CELL).attr('rx', 2)
    .attr('fill', d => {
      if (d.count === 0) return 'var(--border)';
      // Primary type for the day
      const primary = mostCommon(d.types);
      const base = TYPE_COLORS[primary] || TYPE_COLORS.Other;
      // Intensity based on count relative to max
      const intensity = 0.25 + 0.75 * (d.count / maxCount);
      return colorWithOpacity(base, intensity);
    })
    .on('mousemove', (event, d) => {
      if (d.count === 0) return;
      const dateStr = d.date.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      const types   = [...new Set(d.types)].join(', ');
      const dist    = d.dist > 0 ? `<br>${(d.dist / 1000).toFixed(1)} km` : '';
      tooltip.show(event, `<strong>${dateStr}</strong><br>${d.count} ${d.count === 1 ? 'activity' : 'activities'} · ${types}${dist}`);
    })
    .on('mouseleave', () => tooltip.hide());
}

function mostCommon(arr) {
  const freq = {};
  let max = 0, best = arr[0];
  for (const v of arr) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > max) { max = freq[v]; best = v; }
  }
  return best;
}

function colorWithOpacity(hex, opacity) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${opacity.toFixed(2)})`;
}

function addTooltip(container) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text);pointer-events:none;z-index:9000;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.15);line-height:1.6;';
  document.body.appendChild(el);
  return {
    show(event, html) {
      el.innerHTML = html;
      el.style.display = 'block';
      el.style.left = (event.clientX + 12) + 'px';
      el.style.top  = (event.clientY - 10) + 'px';
    },
    hide() { el.style.display = 'none'; },
  };
}
