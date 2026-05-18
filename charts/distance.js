/**
 * charts/distance.js
 * D3 v7 line chart: distance per activity over time,
 * with a 30-day moving average overlay.
 *
 * Exports:
 *   renderDistanceChart(activities, container, units)
 *
 * @param {Activity[]} activities   Sorted by date ascending
 * @param {HTMLElement} container   DOM element to render into
 * @param {'metric'|'imperial'} units
 */

// D3 is loaded as a global from the ESM CDN import in app.js
// We use the `d3` global here rather than re-importing.

export function renderDistanceChart(activities, container, units = 'metric') {
  // Clear previous render
  container.innerHTML = '';

  const isImperial = units === 'imperial';
  const divisor    = isImperial ? 1609.344 : 1000;
  const unitLabel  = isImperial ? 'mi' : 'km';

  // Filter to activities with positive distance and a valid date
  const data = activities
    .filter(a => a.distance_m > 0 && a.date)
    .sort((a, b) => a.date - b.date)
    .map(a => ({
      date: a.date,
      dist: a.distance_m / divisor,
      type: a.type,
    }));

  if (data.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No distance data</p>';
    return;
  }

  // ── Dimensions ────────────────────────────────────────────────────────────
  const W = container.clientWidth || 280;
  const H = 160;
  const margin = { top: 10, right: 10, bottom: 28, left: 36 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  // ── Scales ────────────────────────────────────────────────────────────────
  const xScale = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([0, innerW]);

  const yScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.dist) * 1.1])
    .nice()
    .range([innerH, 0]);

  // ── 30-day moving average ─────────────────────────────────────────────────
  const maData = computeMovingAverage(data, 30);

  // ── SVG ───────────────────────────────────────────────────────────────────
  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // X axis
  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(
      d3.axisBottom(xScale)
        .ticks(4)
        .tickFormat(d3.timeFormat('%b %y'))
    )
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').attr('stroke', 'var(--border)'))
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // Y axis
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').attr('stroke', 'var(--border)'))
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // Y axis label
  g.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('y', -30)
    .attr('x', -innerH / 2)
    .attr('text-anchor', 'middle')
    .attr('fill', 'var(--text-muted)')
    .style('font-size', '9px')
    .text(unitLabel);

  // Scatter dots — colored by activity type
  g.selectAll('.dot')
    .data(data)
    .join('circle')
    .attr('class', 'dot')
    .attr('cx', d => xScale(d.date))
    .attr('cy', d => yScale(d.dist))
    .attr('r', 2.5)
    .attr('fill', d => ACTIVITY_COLORS[d.type] || ACTIVITY_COLORS.Other)
    .attr('opacity', 0.65);

  // 30-day MA line
  if (maData.length > 1) {
    const maLine = d3.line()
      .x(d => xScale(d.date))
      .y(d => yScale(d.ma))
      .curve(d3.curveCatmullRom.alpha(0.5));

    g.append('path')
      .datum(maData)
      .attr('fill', 'none')
      .attr('stroke', 'var(--accent)')
      .attr('stroke-width', 2)
      .attr('opacity', 0.9)
      .attr('d', maLine);
  }
}

// ── Activity type colors ──────────────────────────────────────────────────────
const ACTIVITY_COLORS = {
  Run:   '#FF6B6B',
  Ride:  '#4A90D9',
  Walk:  '#5CB85C',
  Hike:  '#F0AD4E',
  Swim:  '#5BC0DE',
  Other: '#aaaaaa',
};

// ── 30-day moving average ─────────────────────────────────────────────────────
/**
 * Compute a 30-day rolling average of distance.
 * @param {{ date: Date, dist: number }[]} data  Sorted ascending by date
 * @param {number} windowDays
 * @returns {{ date: Date, ma: number }[]}
 */
function computeMovingAverage(data, windowDays) {
  const result = [];
  const MS_PER_DAY = 86400000;

  for (let i = 0; i < data.length; i++) {
    const cutoff = data[i].date.getTime() - windowDays * MS_PER_DAY;
    const window = data.filter(d => d.date.getTime() >= cutoff && d.date <= data[i].date);
    const avg = window.reduce((sum, d) => sum + d.dist, 0) / window.length;
    result.push({ date: data[i].date, ma: avg });
  }

  return result;
}
