/**
 * charts/weight-chart.js
 * Weight over time: each weigh-in as a dot, the smoothed trend as a line, and, if
 * there's a goal, the target weight plus a dashed projection at the planned rate.
 * Uses the global `d3`. Values are kg in, display units via `toDisplay`.
 *
 *   renderWeightChart(el, { points, target, projection, toDisplay, unitLabel })
 *     points      [{date:'YYYY-MM-DD', kg, trend}]
 *     target      {kg}|null
 *     projection  {from:{date,kg}, to:{date,kg}}|null
 */

import { escapeHtml } from '../core/lib/util.js';

const MARGIN = { top: 14, right: 16, bottom: 26, left: 44 };

export function renderWeightChart(container, { points, target, projection, toDisplay = (x) => x, unitLabel = 'kg' }) {
  const d3 = window.d3;
  container.replaceChildren();
  if (!points.length) {
    container.innerHTML = '<p class="muted-note center">Log a few weigh-ins to see your trend and projection here.</p>';
    return;
  }
  const width = Math.max(260, container.clientWidth || 520);
  const height = width < 480 ? 190 : 230;
  const iw = width - MARGIN.left - MARGIN.right, ih = height - MARGIN.top - MARGIN.bottom;
  const t = (s) => new Date(s + 'T12:00:00');

  const xs = points.map(p => t(p.date));
  if (projection) xs.push(t(projection.to.date));
  const ys = points.flatMap(p => [toDisplay(p.kg), toDisplay(p.trend)]);
  if (target) ys.push(toDisplay(target.kg));
  if (projection) ys.push(toDisplay(projection.to.kg));
  const [y0, y1] = d3.extent(ys);
  const pad = Math.max(1, (y1 - y0) * 0.12);
  const x = d3.scaleTime().domain(d3.extent(xs)).range([0, iw]);
  const y = d3.scaleLinear().domain([y0 - pad, y1 + pad]).range([ih, 0]).nice();

  const svg = d3.select(container).append('svg').attr('width', width).attr('height', height)
    .attr('role', 'img').attr('aria-label', `Weight in ${unitLabel} over time`);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  g.selectAll('.grid').data(y.ticks(4)).enter().append('line').attr('class', 'wc-grid')
    .attr('x1', 0).attr('x2', iw).attr('y1', d => y(d)).attr('y2', d => y(d));
  g.selectAll('.ylab').data(y.ticks(4)).enter().append('text').attr('class', 'wc-lab')
    .attr('x', -8).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(d => Math.round(d));
  g.selectAll('.xlab').data(x.ticks(width < 480 ? 3 : 5)).enter().append('text').attr('class', 'wc-lab')
    .attr('x', d => x(d)).attr('y', ih + 18).attr('text-anchor', 'middle')
    .text(d3.timeFormat(xs.length && (d3.extent(xs)[1] - d3.extent(xs)[0]) > 400 * 864e5 ? '%b %Y' : '%b %d'));

  if (target) {
    g.append('line').attr('class', 'wc-target').attr('x1', 0).attr('x2', iw).attr('y1', y(toDisplay(target.kg))).attr('y2', y(toDisplay(target.kg)));
    g.append('text').attr('class', 'wc-target-lab').attr('x', iw).attr('y', y(toDisplay(target.kg)) - 5).attr('text-anchor', 'end')
      .text(`Goal ${toDisplay(target.kg).toFixed(1)} ${unitLabel}`);
  }

  if (projection) {
    g.append('line').attr('class', 'wc-proj')
      .attr('x1', x(t(projection.from.date))).attr('y1', y(toDisplay(projection.from.kg)))
      .attr('x2', x(t(projection.to.date))).attr('y2', y(toDisplay(projection.to.kg)));
  }

  g.append('path').datum(points).attr('class', 'wc-trend').attr('fill', 'none')
    .attr('d', d3.line().x(p => x(t(p.date))).y(p => y(toDisplay(p.trend))).curve(d3.curveMonotoneX));
  g.selectAll('.dot').data(points).enter().append('circle').attr('class', 'wc-dot').attr('r', 3)
    .attr('cx', p => x(t(p.date))).attr('cy', p => y(toDisplay(p.kg)))
    .append('title').text(p => `${p.date}: ${toDisplay(p.kg).toFixed(1)} ${unitLabel}`);

  const note = document.createElement('p');
  note.className = 'wc-legend';
  note.innerHTML = `<i class="dot"></i>weigh-in <i class="line"></i>smoothed trend${projection ? ' <i class="proj"></i>projection' : ''}${target ? ' <i class="tgt"></i>' + escapeHtml('goal') : ''}`;
  container.appendChild(note);
}
