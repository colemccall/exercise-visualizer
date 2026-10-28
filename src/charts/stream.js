/**
 * charts/stream.js
 * Synced small-multiple charts for one activity: elevation, pace/speed, heart
 * rate, cadence, power. All rows share an x axis (distance) and one crosshair, so
 * scrubbing any row reads every row and moves a marker on the route map.
 *
 * Input is the output of analysis/streams.js buildSeries(). Uses the global `d3`.
 *
 *   const chart = renderStreams(el, series, { rows, units, onScrub, onLeave })
 *   chart.destroy()   // disconnect observers when the view goes away
 *
 * A row is { key, label, color, format(value), invert?, area? }. `invert` flips
 * the y axis so "better" sits on top (pace: smaller = faster).
 */

import { escapeHtml } from '../core/lib/util.js';

const M_PER_MI = 1609.344;
const MARGIN = { top: 6, right: 12, bottom: 4, left: 46 };

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** y-domain for a row; pace-like rows clip outliers so one stop doesn't flatten the line. */
function domainFor(values, { invert, clip }) {
  const v = values.filter(x => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  let lo = clip ? percentile(v, 0.03) : v[0];
  let hi = clip ? percentile(v, 0.97) : v[v.length - 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return invert ? [lo - pad, hi + pad] : [lo - pad, hi + pad];
}

export function renderStreams(container, series, { rows, units = 'imperial', onScrub, onLeave } = {}) {
  const d3 = window.d3;
  const unitM = units === 'imperial' ? M_PER_MI : 1000;
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const n = series.dist.length;
  const maxDist = series.dist[n - 1] || 1;

  const wrap = document.createElement('div');
  wrap.className = 'stream-wrap';
  container.replaceChildren(wrap);

  const rowEls = rows.map((row) => {
    const el = document.createElement('div');
    el.className = 'stream-row';
    el.innerHTML = `
      <div class="stream-head">
        <span class="stream-label"><i style="background:${row.color}"></i>${escapeHtml(row.label)}</span>
        <span class="stream-read" aria-live="off"></span>
      </div>
      <svg role="img" aria-label="${escapeHtml(row.label)} over distance"></svg>`;
    wrap.appendChild(el);
    return el;
  });
  const axis = document.createElement('div');
  axis.className = 'stream-axis-note';
  axis.textContent = `Distance (${unitLabel})`;
  wrap.appendChild(axis);

  let xScale = null;
  const guides = [];

  function draw() {
    const width = Math.max(240, wrap.clientWidth || container.clientWidth || 600);
    const height = width < 520 ? 84 : 100;
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const lastExtra = 18; // room for the distance ticks under the bottom row
    xScale = d3.scaleLinear().domain([0, maxDist]).range([0, innerW]);
    guides.length = 0;

    rows.forEach((row, i) => {
      const svg = d3.select(rowEls[i].querySelector('svg')).attr('width', width).attr('height', height + (i === rows.length - 1 ? lastExtra : 0));
      svg.selectAll('*').remove();
      const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);
      const vals = series[row.key];
      const [d0, d1] = domainFor(vals, row);
      const y = d3.scaleLinear().domain(row.invert ? [d0, d1] : [d1, d0]).range([0, innerH]).clamp(true);
      // For inverted rows the *smaller* value draws on top: domain [d0,d1] -> range [0,innerH].
      // For normal rows the larger value draws on top: domain [d1,d0] -> range [0,innerH].

      // Horizontal grid + y labels (3 ticks)
      const ticks = y.ticks(3);
      g.selectAll('.grid').data(ticks).enter().append('line')
        .attr('class', 'stream-grid').attr('x1', 0).attr('x2', innerW)
        .attr('y1', t => y(t)).attr('y2', t => y(t));
      g.selectAll('.ylab').data(ticks).enter().append('text')
        .attr('class', 'stream-ylab').attr('x', -8).attr('y', t => y(t)).attr('dy', '0.32em').attr('text-anchor', 'end')
        .text(t => row.tick ? row.tick(t) : Math.round(t));

      // x ticks along the bottom row only
      if (i === rows.length - 1) {
        const xt = d3.scaleLinear().domain([0, maxDist / unitM]).ticks(width < 520 ? 4 : 7);
        g.selectAll('.xlab').data(xt).enter().append('text')
          .attr('class', 'stream-xlab').attr('x', t => xScale(t * unitM)).attr('y', innerH + 14).attr('text-anchor', 'middle')
          .text(t => t);
      }

      // Sparse streams (heart rate sampled every few seconds) read better as one
      // line through the samples than as dashes, so draw through defined points only.
      // Clipped rows (pace) drop samples outside the plotted range, so a stop at a
      // traffic light leaves a gap instead of a spike to the edge of the chart.
      const inRange = (v) => !row.clip || (v >= Math.min(d0, d1) && v <= Math.max(d0, d1));
      const idxs = d3.range(n).filter(k => vals[k] !== null && vals[k] !== undefined && inRange(vals[k]));
      const xAt = (_, k) => xScale(series.dist[k]);
      const yAt = (_, k) => y(vals[k]);
      const defined = () => true;

      if (row.area) {
        g.append('path').datum(idxs)
          .attr('class', 'stream-area').attr('fill', row.color)
          .attr('d', d3.area().defined((k) => defined(null, k)).x(k => xAt(null, k)).y0(innerH).y1(k => yAt(null, k)).curve(d3.curveMonotoneX));
      }
      g.append('path').datum(idxs)
        .attr('class', 'stream-line').attr('fill', 'none').attr('stroke', row.color)
        .attr('d', d3.line().defined(k => defined(null, k)).x(k => xAt(null, k)).y(k => yAt(null, k)).curve(d3.curveMonotoneX));

      const cross = g.append('line').attr('class', 'stream-cross').attr('y1', 0).attr('y2', innerH).style('display', 'none');
      const dot = g.append('circle').attr('class', 'stream-dot').attr('r', 4).attr('fill', row.color).style('display', 'none');
      guides.push({ cross, dot, y, innerW });
    });
  }

  function indexAtX(px) {
    const dist = xScale.invert(px);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series.dist[mid] < dist) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function showAt(i) {
    const x = xScale(series.dist[i]);
    rows.forEach((row, r) => {
      const guide = guides[r];
      guide.cross.attr('x1', x).attr('x2', x).style('display', null);
      const v = series[row.key][i];
      if (v === null || v === undefined) guide.dot.style('display', 'none');
      else guide.dot.attr('cx', x).attr('cy', guide.y(v)).style('display', null);
      const read = rowEls[r].querySelector('.stream-read');
      read.textContent = v === null || v === undefined ? '—' : row.format(v);
    });
    onScrub?.(i, series.idx[i]);
  }

  function hide() {
    guides.forEach(g => { g.cross.style('display', 'none'); g.dot.style('display', 'none'); });
    rowEls.forEach(el => { el.querySelector('.stream-read').textContent = ''; });
    onLeave?.();
  }

  let pressed = false;
  const pointerX = (e) => {
    const svg = rowEls[0].querySelector('svg').getBoundingClientRect();
    return e.clientX - svg.left - MARGIN.left;
  };
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !pressed) return;
    const px = pointerX(e);
    if (px < -MARGIN.left / 2 || px > xScale.range()[1] + MARGIN.right) { hide(); return; }
    showAt(indexAtX(Math.max(0, Math.min(xScale.range()[1], px))));
  });
  wrap.addEventListener('pointerdown', (e) => { pressed = true; if (e.pointerType === 'touch') wrap.setPointerCapture?.(e.pointerId); wrap.dispatchEvent(new PointerEvent('pointermove', e)); });
  const release = () => { pressed = false; };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
  wrap.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });

  // Keyboard: arrow keys scrub, Escape clears. The wrap is focusable for this.
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Activity charts. Use the left and right arrow keys to move along the route.');
  let kbIndex = 0;
  wrap.addEventListener('keydown', (e) => {
    const step = Math.max(1, Math.round(n / 60));
    if (e.key === 'ArrowRight') { kbIndex = Math.min(n - 1, kbIndex + step); showAt(kbIndex); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { kbIndex = Math.max(0, kbIndex - step); showAt(kbIndex); e.preventDefault(); }
    else if (e.key === 'Escape') hide();
  });

  draw();
  let timer = null;
  const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(draw, 120); });
  ro.observe(wrap);

  return { destroy() { ro.disconnect(); clearTimeout(timer); }, redraw: draw };
}
