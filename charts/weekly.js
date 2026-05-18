/**
 * charts/weekly.js
 * D3 v7 stacked bar chart: activities per week, stacked by activity type.
 *
 * Exports:
 *   renderWeeklyChart(activities, container)
 *
 * @param {Activity[]} activities
 * @param {HTMLElement} container   DOM element to render into
 */

export function renderWeeklyChart(activities, container) {
  container.innerHTML = '';

  if (activities.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No data</p>';
    return;
  }

  const TYPES = ['Run', 'Ride', 'Walk', 'Hike', 'Swim', 'Other'];
  const COLORS = {
    Run:   '#FF6B6B',
    Ride:  '#4A90D9',
    Walk:  '#5CB85C',
    Hike:  '#F0AD4E',
    Swim:  '#5BC0DE',
    Other: '#aaaaaa',
  };

  // ── Group activities by ISO week (Monday-based) ───────────────────────────
  const weekMap = new Map(); // weekKey → { weekStart: Date, Run:0, Ride:0, ... }

  for (const act of activities) {
    if (!act.date) continue;
    const weekStart = getWeekStart(act.date);
    const key = weekStart.toISOString().slice(0, 10);

    if (!weekMap.has(key)) {
      const entry = { weekStart, total: 0 };
      TYPES.forEach(t => (entry[t] = 0));
      weekMap.set(key, entry);
    }
    const entry = weekMap.get(key);
    const t = TYPES.includes(act.type) ? act.type : 'Other';
    entry[t]++;
    entry.total++;
  }

  // Sort weeks ascending and limit to last 52 weeks for readability
  let weekData = Array.from(weekMap.values()).sort((a, b) => a.weekStart - b.weekStart);
  if (weekData.length > 52) weekData = weekData.slice(-52);

  // ── D3 stack ──────────────────────────────────────────────────────────────
  const stack = d3.stack().keys(TYPES);
  const series = stack(weekData);

  // ── Dimensions ────────────────────────────────────────────────────────────
  const W = container.clientWidth || 280;
  const H = 160;
  const margin = { top: 10, right: 10, bottom: 28, left: 28 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const xScale = d3.scaleBand()
    .domain(weekData.map(d => d.weekStart))
    .range([0, innerW])
    .padding(0.15);

  const yMax = d3.max(weekData, d => d.total) || 1;
  const yScale = d3.scaleLinear()
    .domain([0, yMax * 1.1])
    .nice()
    .range([innerH, 0]);

  // ── SVG ───────────────────────────────────────────────────────────────────
  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // X axis — only show a few tick labels to avoid crowding
  const tickEvery = Math.ceil(weekData.length / 6);
  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(
      d3.axisBottom(xScale)
        .tickValues(weekData.filter((_, i) => i % tickEvery === 0).map(d => d.weekStart))
        .tickFormat(d3.timeFormat('%b %d'))
    )
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').remove())
    .call(ax => ax.selectAll('text')
      .attr('fill', 'var(--text-muted)')
      .style('font-size', '9px')
      .attr('transform', 'rotate(-30)')
      .attr('text-anchor', 'end')
    );

  // Y axis
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4).tickFormat(d3.format('d')))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').attr('stroke', 'var(--border)'))
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // Stacked bars
  g.selectAll('.layer')
    .data(series)
    .join('g')
    .attr('class', 'layer')
    .attr('fill', d => COLORS[d.key] || '#aaa')
    .selectAll('rect')
    .data(d => d)
    .join('rect')
    .attr('x', d => xScale(d.data.weekStart))
    .attr('y', d => yScale(d[1]))
    .attr('height', d => Math.max(0, yScale(d[0]) - yScale(d[1])))
    .attr('width', xScale.bandwidth())
    .attr('rx', 1);

  // Legend (compact, inline)
  const activeLegend = TYPES.filter(t => weekData.some(w => w[t] > 0));
  const legendG = svg.append('g')
    .attr('transform', `translate(${margin.left},${H - 4})`);

  // We'll put the legend to the right of the chart if there's room,
  // otherwise skip it (the chart is small).
  // (Skipping for now since we have very limited height)
}

// ── Helper: get Monday-based week start ───────────────────────────────────────
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day; // adjust to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
