/**
 * components/badge.js
 * Award badges as inline SVG. Original artwork: four geometric shapes, a soft
 * highlight and a category glyph. Earned badges are filled with their hue;
 * unearned ones are a quiet outline with a progress readout beside them.
 */

import { iconBody } from './icons.js';
import { TYPE_COLORS } from '../design-system/activity-colors.js';

const SHAPES = {
  circle:  '<circle cx="50" cy="50" r="44"/>',
  hexagon: '<polygon points="50,5 90,27.5 90,72.5 50,95 10,72.5 10,27.5"/>',
  shield:  '<path d="M50 6 L88 20 V50 C88 74 70 88 50 95 C30 88 12 74 12 50 V20 Z"/>',
  star:    '<polygon points="50,5 61.8,34.5 93.5,37.2 69.4,57.9 76.8,88.8 50,72.3 23.2,88.8 30.6,57.9 6.5,37.2 38.2,34.5"/>',
};

const GLYPH = {
  distance: 'map', streak: 'flame', pr: 'bolt', rings: 'today',
  challenge: 'star', variety: 'mountain', consistency: 'clock',
};

const HUES = {
  run: TYPE_COLORS.Run, ride: TYPE_COLORS.Ride, hike: TYPE_COLORS.Hike, swim: TYPE_COLORS.Swim,
  move: 'var(--ring-move)', exercise: 'var(--ring-exercise)', stand: 'var(--ring-stand)',
};

// Hues too light for a white glyph (checked against 3:1) get a dark one.
const INK_DARK = new Set(['hike', 'swim']);

export const hueColor = (hue) => (typeof hue === 'number' ? `hsl(${hue} 62% 48%)` : HUES[hue] || 'var(--accent)');

/** @param {{shape:string, hue:string|number, category:string, earned:Date|null}} award */
export function badgeSvg(award, { size = 88 } = {}) {
  const earned = !!award.earned;
  const color = hueColor(award.hue);
  const shape = SHAPES[award.shape] || SHAPES.circle;
  const glyph = iconBody(GLYPH[award.category] || 'star');
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="badge-svg ${earned ? 'earned' : 'locked'} hue-${typeof award.hue === 'number' ? 'custom' : award.hue}${INK_DARK.has(award.hue) ? ' ink-dark' : ''}" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <g fill="${earned ? color : 'var(--card-2)'}" stroke="${earned ? 'rgba(0,0,0,.18)' : 'var(--border-mid)'}" stroke-width="${earned ? 1.5 : 2.5}" ${earned ? '' : 'stroke-dasharray="5 5"'}>${shape}</g>
    ${earned ? `<g fill="url(#${id})">${shape}</g>` : ''}
    <g class="glyph" transform="translate(28 28) scale(1.83)" fill="none" stroke="${earned ? '#fff' : 'var(--text-muted)'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
  </svg>`;
}
