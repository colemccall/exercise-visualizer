/**
 * components/thumb.js
 * Static route thumbnail as inline SVG: the shape of the route, no map tiles
 * (so a feed of 400 cards makes zero tile requests). Points are decimated and
 * projected with a cosine-corrected equirectangular fit.
 */

import { decimate } from '../analysis/streams.js';

/**
 * @param {{lat:number,lng:number}[]} points
 * @param {{w?: number, h?: number, pad?: number, max?: number}} [opts]
 * @returns {string|null} svg markup, or null when there's no usable route
 */
export function routeThumbSvg(points, { w = 160, h = 110, pad = 10, max = 120 } = {}) {
  const pts = (points || []).filter(p => p.lat !== null && p.lng !== null);
  if (pts.length < 2) return null;
  const d = decimate(pts, max);

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of d) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
  }
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;

  const xy = p => [
    (offX + (p.lng - minLng) * kx * scale).toFixed(1),
    (offY + (maxLat - p.lat) * scale).toFixed(1),
  ];
  const path = d.map((p, i) => `${i ? 'L' : 'M'}${xy(p).join(' ')}`).join('');
  const [sx, sy] = xy(d[0]);
  const [ex, ey] = xy(d[d.length - 1]);

  return `<svg class="route-thumb" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
    <path d="${path}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${sx}" cy="${sy}" r="3.4" fill="var(--card)" stroke="currentColor" stroke-width="2"/>
    <circle cx="${ex}" cy="${ey}" r="3.4" fill="currentColor"/>
  </svg>`;
}
