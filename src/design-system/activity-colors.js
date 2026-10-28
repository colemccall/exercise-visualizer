/**
 * design-system/activity-colors.js
 * Single source of truth for activity-type colors across the app
 * (heatmap, route detail, all D3 charts, records list).
 *
 * Based on the Okabe-Ito palette — designed so all colors remain
 * distinguishable under protanopia, deuteranopia, and tritanopia
 * (the three most common forms of color blindness), not just to
 * "typical" color vision.
 * Reference: https://jfly.uni-koeln.de/color/
 *
 * Same hex values are used in both light and dark themes — Okabe-Ito
 * colors sit at a lightness/saturation that reads clearly against both
 * white and near-black surfaces. Only "Other" (a neutral gray, not part
 * of the 8-color Okabe-Ito set) is theme-dependent.
 */

export const TYPE_COLORS = {
  Run:   '#D55E00', // vermillion
  Ride:  '#0072B2', // blue
  Walk:  '#009E73', // bluish green
  Hike:  '#E69F00', // orange
  Swim:  '#56B4E9', // sky blue
  Other: '#8A8D99', // neutral gray (readable on both light and dark surfaces)
};

export function typeColor(type) {
  return TYPE_COLORS[type] || TYPE_COLORS.Other;
}
