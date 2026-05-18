/**
 * charts/elevation.js
 * D3 v7 area chart: elevation profile for a single activity.
 * Used in the activity detail panel.
 *
 * Exports:
 *   renderElevationChart(routePoints, container, units)
 *
 * @param {{ lat, lng, ele, hr, time }[]} routePoints  GPX track points
 * @param {HTMLElement} container   DOM element to render into
 * @param {'metric'|'imperial'} units
 */

export function renderElevationChart(routePoints, container, units = 'metric') {
  container.innerHTML = '';

  const isImperial = units === 'imperial';

  // Filter points that have elevation data
  const points = routePoints.filter(p => p.ele !== null && p.lat !== null);

  if (points.length < 2) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px 0">No elevation data</p>';
    return;
  }

  // ── Build cumulative distance axis ────────────────────────────────────────
  // We compute cumulative distance along the route for the X axis.
  const data = buildElevationData(points, isImperial);

  // ── Dimensions ────────────────────────────────────────────────────────────
  const W = container.clientWidth || 540;
  const H = 120;
  const margin = { top: 8, right: 10, bottom: 24, left: 42 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const unitLabel  = isImperial ? 'mi' : 'km';
  const elevLabel  = isImperial ? 'ft' : 'm';

  // ── Scales ────────────────────────────────────────────────────────────────
  const xScale = d3.scaleLinear()
    .domain([0, data[data.length - 1].cumDist])
    .range([0, innerW]);

  const [minEle, maxEle] = d3.extent(data, d => d.ele);
  const eleRange = maxEle - minEle;
  const padding = eleRange < 20 ? 10 : eleRange * 0.1;

  const yScale = d3.scaleLinear()
    .domain([minEle - padding, maxEle + padding])
    .nice()
    .range([innerH, 0]);

  // ── SVG ───────────────────────────────────────────────────────────────────
  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Gradient fill beneath the area
  const gradId = 'elev-grad-' + Math.random().toString(36).slice(2);
  const defs = svg.append('defs');
  const grad = defs.append('linearGradient')
    .attr('id', gradId)
    .attr('x1', '0').attr('y1', '0')
    .attr('x2', '0').attr('y2', '1');
  grad.append('stop')
    .attr('offset', '0%')
    .attr('stop-color', 'var(--accent)')
    .attr('stop-opacity', 0.4);
  grad.append('stop')
    .attr('offset', '100%')
    .attr('stop-color', 'var(--accent)')
    .attr('stop-opacity', 0.05);

  // Area generator
  const area = d3.area()
    .x(d => xScale(d.cumDist))
    .y0(innerH)
    .y1(d => yScale(d.ele))
    .curve(d3.curveCatmullRom.alpha(0.5));

  // Line generator
  const line = d3.line()
    .x(d => xScale(d.cumDist))
    .y(d => yScale(d.ele))
    .curve(d3.curveCatmullRom.alpha(0.5));

  // Gridlines
  g.append('g')
    .attr('class', 'grid')
    .call(
      d3.axisLeft(yScale)
        .ticks(4)
        .tickSize(-innerW)
        .tickFormat('')
    )
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').attr('stroke', 'var(--border)').attr('stroke-dasharray', '2,3'));

  // Area fill
  g.append('path')
    .datum(data)
    .attr('fill', `url(#${gradId})`)
    .attr('d', area);

  // Elevation line
  g.append('path')
    .datum(data)
    .attr('fill', 'none')
    .attr('stroke', 'var(--accent)')
    .attr('stroke-width', 2)
    .attr('d', line);

  // X axis
  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(5).tickFormat(d => `${d.toFixed(1)}`))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').remove())
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // X axis unit label
  g.append('text')
    .attr('x', innerW)
    .attr('y', innerH + 20)
    .attr('text-anchor', 'end')
    .attr('fill', 'var(--text-muted)')
    .style('font-size', '9px')
    .text(unitLabel);

  // Y axis
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').remove())
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  // Y axis unit label
  g.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('y', -36)
    .attr('x', -innerH / 2)
    .attr('text-anchor', 'middle')
    .attr('fill', 'var(--text-muted)')
    .style('font-size', '9px')
    .text(elevLabel);
}

// ── Heart-rate line chart for detail panel ────────────────────────────────────
/**
 * Render an HR over time line chart for a single activity.
 * @param {{ lat, lng, ele, hr, time }[]} routePoints
 * @param {HTMLElement} container
 */
export function renderHRLineChart(routePoints, container) {
  container.innerHTML = '';

  const data = routePoints
    .filter(p => p.hr !== null && p.time !== null)
    .map(p => ({ time: p.time, hr: p.hr }));

  if (data.length < 2) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px 0">No HR data in route</p>';
    return;
  }

  const W = container.clientWidth || 540;
  const H = 100;
  const margin = { top: 8, right: 10, bottom: 22, left: 38 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const xScale = d3.scaleTime()
    .domain(d3.extent(data, d => d.time))
    .range([0, innerW]);

  const yScale = d3.scaleLinear()
    .domain([
      (d3.min(data, d => d.hr) || 0) - 5,
      (d3.max(data, d => d.hr) || 200) + 5,
    ])
    .nice()
    .range([innerH, 0]);

  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Gradient
  const gradId = 'hr-grad-' + Math.random().toString(36).slice(2);
  const defs = svg.append('defs');
  const grad = defs.append('linearGradient').attr('id', gradId).attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#ef4444').attr('stop-opacity', 0.35);
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#ef4444').attr('stop-opacity', 0.02);

  const area = d3.area().x(d => xScale(d.time)).y0(innerH).y1(d => yScale(d.hr)).curve(d3.curveCatmullRom.alpha(0.5));
  const line = d3.line().x(d => xScale(d.time)).y(d => yScale(d.hr)).curve(d3.curveCatmullRom.alpha(0.5));

  g.append('path').datum(data).attr('fill', `url(#${gradId})`).attr('d', area);
  g.append('path').datum(data).attr('fill', 'none').attr('stroke', '#ef4444').attr('stroke-width', 2).attr('d', line);

  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(4).tickFormat(d3.timeFormat('%H:%M')))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').remove())
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4))
    .call(ax => ax.select('.domain').remove())
    .call(ax => ax.selectAll('line').attr('stroke', 'var(--border)'))
    .call(ax => ax.selectAll('text').attr('fill', 'var(--text-muted)').style('font-size', '10px'));

  g.append('text')
    .attr('transform', 'rotate(-90)').attr('y', -32).attr('x', -innerH / 2)
    .attr('text-anchor', 'middle').attr('fill', 'var(--text-muted)').style('font-size', '9px')
    .text('bpm');
}

// ── Helper ────────────────────────────────────────────────────────────────────
function buildElevationData(points, isImperial) {
  const distDivisor = isImperial ? 1609.344 : 1000;
  const eleFactor   = isImperial ? 3.28084 : 1;

  let cumDist = 0;
  const result = [];

  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      cumDist += haversine(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
    }
    result.push({
      cumDist: cumDist / distDivisor,
      ele: points[i].ele * eleFactor,
    });
  }
  return result;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
