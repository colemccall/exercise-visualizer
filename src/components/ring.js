/**
 * components/ring.js
 * Concentric activity rings (Move / Exercise / Stand) as inline SVG.
 *
 * Original drawing: three stroked circles with rounded caps. A ring past 100%
 * draws a second, darker lap on top, like closing it more than once. The fill
 * animates by transitioning stroke-dashoffset; CSS (and prefers-reduced-motion)
 * decides whether it moves.
 *
 * Colours come from --ring-move / --ring-exercise / --ring-stand, so each
 * mode/theme variant supplies its own AA-checked values.
 */

import { escapeHtml } from '../core/lib/util.js';

const RING_VARS = { move: 'var(--ring-move)', exercise: 'var(--ring-exercise)', stand: 'var(--ring-stand)' };

/**
 * @param {{move?: {pct:number}, exercise?: {pct:number}, stand?: {pct:number}}|null} rings
 * @param {{size?: number, stroke?: number, label?: string, rings?: string[]}} [opts]
 * @returns {string} svg markup
 */
export function ringsSvg(rings, { size = 160, stroke, label, keys = ['move', 'exercise', 'stand'] } = {}) {
  const sw = stroke ?? Math.max(5, Math.round(size * 0.115));
  const gap = Math.max(2, Math.round(sw * 0.22));
  const c = size / 2;
  const parts = [];

  keys.forEach((key, i) => {
    const r = c - sw / 2 - i * (sw + gap) - 1;
    if (r <= 0) return;
    const circ = 2 * Math.PI * r;
    const pct = Math.max(0, rings?.[key]?.pct ?? 0);
    const first = Math.min(pct, 1);
    const second = Math.min(Math.max(pct - 1, 0), 1);
    const color = RING_VARS[key];
    parts.push(`<circle class="ring-track" cx="${c}" cy="${c}" r="${r}" stroke="var(--ring-track)" stroke-width="${sw}"/>`);
    if (first > 0) {
      parts.push(`<circle class="ring-arc" data-offset="${(circ * (1 - first)).toFixed(2)}" cx="${c}" cy="${c}" r="${r}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`);
    }
    if (second > 0) {
      parts.push(`<circle class="ring-arc ring-arc-2" data-offset="${(circ * (1 - second)).toFixed(2)}" cx="${c}" cy="${c}" r="${r}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`);
    }
  });

  const aria = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"';
  return `<svg class="rings" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none" ${aria}>${parts.join('')}</svg>`;
}

/** Play the fill animation for every ring inside `root` (next frame, so the CSS transition runs). */
export function animateRings(root) {
  const arcs = root.querySelectorAll('.ring-arc');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arcs.forEach(el => { el.style.strokeDashoffset = el.dataset.offset; });
  }));
}

/** Plain-language description for screen readers. */
export function ringsLabel(rings) {
  if (!rings) return 'No ring data';
  const part = (name, r) => r ? `${name} ${Math.round(r.value ?? 0)} of ${Math.round(r.goal ?? 0)}` : '';
  return [part('Move', rings.move), part('Exercise', rings.exercise), part('Stand', rings.stand)].filter(Boolean).join(', ');
}
