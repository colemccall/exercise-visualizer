/**
 * charts/hr-zones.js
 * D3 v7 horizontal bar chart: percentage of time spent in each HR zone.
 *
 * HR Zones are defined as percentages of max HR:
 *   Zone 1: < 50%        (rest / very light)
 *   Zone 2: 50–60%       (fat burn / easy)
 *   Zone 3: 60–70%       (aerobic / moderate)
 *   Zone 4: 70–80%       (threshold / hard)
 *   Zone 5: 80–90%       (VO2 max / very hard)
 *   Zone 6: > 90%        (anaerobic / maximum)
 *
 * Heart rate data comes from route_points (GPX HR readings) and/or
 * avg_heart_rate / max_heart_rate summary fields.
 *
 * Exports:
 *   renderHRZones(activities, container, maxHR)
 *
 * @param {Activity[]} activities
 * @param {HTMLElement} container
 * @param {number} maxHR   User-specified max heart rate (default 190)
 */

export function renderHRZones(activities, container, maxHR = 190) {
  container.innerHTML = '';

  // ── Zone definitions ──────────────────────────────────────────────────────
  const zones = [
    { name: 'Zone 1', label: 'Rest',       min: 0,   max: 0.50, color: '#93c5fd' },
    { name: 'Zone 2', label: 'Easy',       min: 0.50, max: 0.60, color: '#6ee7b7' },
    { name: 'Zone 3', label: 'Moderate',   min: 0.60, max: 0.70, color: '#fde68a' },
    { name: 'Zone 4', label: 'Hard',       min: 0.70, max: 0.80, color: '#fb923c' },
    { name: 'Zone 5', label: 'Very Hard',  min: 0.80, max: 0.90, color: '#f87171' },
    { name: 'Zone 6', label: 'Max',        min: 0.90, max: 1.00, color: '#c026d3' },
  ];

  // ── Collect all HR readings ───────────────────────────────────────────────
  const hrReadings = [];

  for (const act of activities) {
    // Prefer point-by-point HR from GPX route_points
    if (act.route_points && act.route_points.length > 0) {
      for (const pt of act.route_points) {
        if (pt.hr !== null && pt.hr > 0) {
          hrReadings.push(pt.hr);
        }
      }
    }
    // Fallback: use avg HR as a single representative reading
    else if (act.avg_heart_rate) {
      hrReadings.push(act.avg_heart_rate);
    }
  }

  if (hrReadings.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No HR data available</p>';
    return;
  }

  // ── Bin readings into zones ───────────────────────────────────────────────
  const zoneCounts = zones.map(() => 0);

  for (const hr of hrReadings) {
    const pct = hr / maxHR;
    // Find the zone this reading falls into (last zone catches >= 90%)
    let placed = false;
    for (let z = zones.length - 1; z >= 0; z--) {
      if (pct >= zones[z].min) {
        zoneCounts[z]++;
        placed = true;
        break;
      }
    }
    if (!placed) zoneCounts[0]++; // below zone 1 minimum
  }

  const total = hrReadings.length;
  const zoneData = zones.map((z, i) => ({
    ...z,
    count: zoneCounts[i],
    pct: total > 0 ? zoneCounts[i] / total : 0,
  })).filter(z => z.pct > 0);

  if (zoneData.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px 0">No HR zones to display</p>';
    return;
  }

  // ── Dimensions ────────────────────────────────────────────────────────────
  const W = container.clientWidth || 280;
  const barH = 18;
  const barGap = 6;
  const labelW = 62;
  const pctLabelW = 36;
  const margin = { top: 4, right: pctLabelW, bottom: 4, left: labelW };
  const innerW = W - margin.left - margin.right;
  const H = zoneData.length * (barH + barGap) + margin.top + margin.bottom;

  const xScale = d3.scaleLinear()
    .domain([0, 1])
    .range([0, innerW]);

  // ── SVG ───────────────────────────────────────────────────────────────────
  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const rows = g.selectAll('.zone-row')
    .data(zoneData)
    .join('g')
    .attr('class', 'zone-row')
    .attr('transform', (d, i) => `translate(0, ${i * (barH + barGap)})`);

  // Zone name label (left)
  rows.append('text')
    .attr('x', -4)
    .attr('y', barH / 2 + 1)
    .attr('text-anchor', 'end')
    .attr('dominant-baseline', 'middle')
    .attr('fill', 'var(--text-muted)')
    .style('font-size', '10px')
    .text(d => `${d.name} ${d.label}`);

  // Background track
  rows.append('rect')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', innerW)
    .attr('height', barH)
    .attr('rx', 3)
    .attr('fill', 'var(--surface-2)');

  // Filled bar
  rows.append('rect')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', d => xScale(d.pct))
    .attr('height', barH)
    .attr('rx', 3)
    .attr('fill', d => d.color);

  // Percentage label (right)
  rows.append('text')
    .attr('x', innerW + 5)
    .attr('y', barH / 2 + 1)
    .attr('dominant-baseline', 'middle')
    .attr('fill', 'var(--text-mid)')
    .style('font-size', '10px')
    .style('font-weight', '600')
    .text(d => `${Math.round(d.pct * 100)}%`);
}
