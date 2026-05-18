/**
 * charts/distance.js
 * Monthly distance bar chart, stacked by activity type.
 * Much easier to read than a daily scatter.
 */

const ACTIVITY_COLORS = {
  Run:   '#FF6B6B',
  Ride:  '#4A90D9',
  Walk:  '#5CB85C',
  Hike:  '#F0AD4E',
  Swim:  '#5BC0DE',
  Other: '#aaaaaa',
};
const TYPES = ['Run', 'Ride', 'Walk', 'Hike', 'Swim', 'Other'];

export function renderDistanceChart(activities, container, units = 'metric') {
  container.innerHTML = '';
  const isImperial = units === 'imperial';
  const divisor    = isImperial ? 1609.344 : 1000;
  const unitLabel  = isImperial ? 'mi' : 'km';

  const acts = activities.filter(a => a.distance_m > 0 && a.date);
  if (acts.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No distance data</p>';
    return;
  }

  // Group by YYYY-MM
  const monthMap = new Map();
  for (const a of acts) {
    const key = `${a.date.getFullYear()}-${String(a.date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap.has(key)) {
      const entry = { key, date: new Date(a.date.getFullYear(), a.date.getMonth(), 1), total: 0 };
      TYPES.forEach(t => entry[t] = 0);
      monthMap.set(key, entry);
    }
    const e = monthMap.get(key);
    const t = TYPES.includes(a.type) ? a.type : 'Other';
    e[t] += a.distance_m / divisor;
    e.total += a.distance_m / divisor;
  }

  let data = Array.from(monthMap.values()).sort((a, b) => a.date - b.date);
  // Show last 18 months for readability
  if (data.length > 18) data = data.slice(-18);

  const W = container.clientWidth || 300;
  const H = 180;
  const margin = { top: 12, right: 8, bottom: 40, left: 42 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const xScale = d3.scaleBand()
    .domain(data.map(d => d.key))
    .range([0, innerW])
    .padding(0.18);

  const yMax = d3.max(data, d => d.total) || 1;
  const yScale = d3.scaleLinear().domain([0, yMax * 1.1]).nice().range([innerH, 0]);

  const stack   = d3.stack().keys(TYPES);
  const series  = stack(data);

  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);
  const g   = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid lines
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4).tickFormat(d => `${Math.round(d)}`))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('.tick line')
      .clone().attr('x2', innerW).attr('stroke', 'var(--border)').attr('stroke-dasharray', '3,3'))
    .call(ax => ax.selectAll('.tick line').remove())
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // Y label
  g.append('text')
    .attr('transform', 'rotate(-90)').attr('y', -34).attr('x', -innerH / 2)
    .attr('text-anchor', 'middle').attr('fill', 'var(--text-muted)').style('font-size', '9px')
    .text(unitLabel);

  // X axis — only label every Nth month to avoid crowding
  const tickEvery = data.length > 12 ? 3 : data.length > 6 ? 2 : 1;
  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale)
      .tickValues(data.filter((_, i) => i % tickEvery === 0).map(d => d.key))
      .tickFormat(key => {
        const [y, m] = key.split('-');
        return d3.timeFormat('%b %y')(new Date(+y, +m - 1, 1));
      }))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('.tick line').remove())
    .call(ax => ax.selectAll('text')
      .attr('fill', 'var(--text-muted)').style('font-size', '9px')
      .attr('transform', 'rotate(-35)').attr('text-anchor', 'end'));

  // Stacked bars
  const tooltip = addTooltip(container);

  g.selectAll('.layer')
    .data(series)
    .join('g')
    .attr('fill', d => ACTIVITY_COLORS[d.key] || '#aaa')
    .selectAll('rect')
    .data(d => d)
    .join('rect')
    .attr('x', d => xScale(d.data.key))
    .attr('y', d => yScale(d[1]))
    .attr('height', d => Math.max(0, yScale(d[0]) - yScale(d[1])))
    .attr('width', xScale.bandwidth())
    .attr('rx', 2)
    .on('mousemove', (event, d) => {
      const lines = TYPES.filter(t => d.data[t] > 0.01)
        .map(t => `${t}: ${d.data[t].toFixed(1)} ${unitLabel}`).join('<br>');
      const [y, m] = d.data.key.split('-');
      const label  = d3.timeFormat('%B %Y')(new Date(+y, +m - 1, 1));
      tooltip.show(event, `<strong>${label}</strong><br>${lines}<br><em>Total: ${d.data.total.toFixed(1)} ${unitLabel}</em>`);
    })
    .on('mouseleave', () => tooltip.hide());

  // Legend
  const activeLegend = TYPES.filter(t => data.some(d => d[t] > 0.01));
  const legendG = svg.append('g').attr('transform', `translate(${margin.left},${H - 10})`);
  let lx = 0;
  for (const t of activeLegend) {
    legendG.append('rect').attr('x', lx).attr('y', 0).attr('width', 8).attr('height', 8).attr('rx', 2).attr('fill', ACTIVITY_COLORS[t]);
    legendG.append('text').attr('x', lx + 10).attr('y', 7).text(t).attr('fill', 'var(--text-muted)').style('font-size', '9px');
    lx += t.length * 5.5 + 18;
  }
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
