/**
 * components/icons.js
 * Original line icons (24px grid, 1.8 stroke), drawn for this app — no icon font,
 * no third-party artwork. icon('map') returns an <svg> string that inherits
 * currentColor, so it themes with the surrounding text.
 */

const PATHS = {
  today:   '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  feed:    '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  map:     '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  awards:  '<circle cx="12" cy="9" r="5.5"/><path d="M8.6 13.4 7 21l5-2.8 5 2.8-1.6-7.6"/>',
  charts:  '<path d="M5 20v-9M12 20V4M19 20v-6"/>',
  stats:   '<path d="M5 20v-9M12 20V4M19 20v-6"/>',
  photos:  '<rect x="3.5" y="5.5" width="17" height="13" rx="3"/><circle cx="9" cy="11" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4.5 3.5"/>',
  profile: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-4 3.6-6 7-6s6.2 2 7 6"/>',
  sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon:    '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  menu:    '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  upload:  '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  trash:   '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 13h8.4L17 7M10.5 11v6M13.5 11v6"/>',
  back:    '<path d="M15 5l-7 7 7 7"/>',
  close:   '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  up:      '<path d="M12 19V6M6 11l6-6 6 6"/>',
  down:    '<path d="M12 5v13M6 13l6 6 6-6"/>',
  flat:    '<path d="M5 12h14"/>',
  lock:    '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  heart:   '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/>',
  flame:   '<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3 2.2-4.6 3.2-7 1 1 1.6 2 1.8 3.2 1.4-1.6 2.2-3.8 2-6.6 3.4 2 5 5.6 5 9.4 0 3.9-2.4 6.6-6 6.6z"/>',
  bolt:    '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/>',
  mountain:'<path d="m3 19 6-10 3.5 5.5L15 11l6 8z"/>',
  clock:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  star:    '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
};

/** @param {keyof typeof PATHS} name */
export function icon(name, { size, label } = {}) {
  const body = PATHS[name] || '';
  const dims = size ? ` width="${size}" height="${size}"` : '';
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"';
  return `<svg viewBox="0 0 24 24"${dims} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

/** The brand mark: two nested rings and a route stroke. */
export const BRAND_MARK = `<svg class="nav-brand-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="12.5" opacity=".35"/><path d="M16 3.5a12.5 12.5 0 0 1 11.2 7"/><path d="M8 22c3-1 4.5-5 8-5s4.2 3.3 8 2.5"/></svg>`;

/** Activity type glyphs for list rows (original, simple). */
const TYPE_PATHS = {
  Run:   '<circle cx="14.5" cy="5" r="2"/><path d="m9 21 3-6-3-3 2-5 4 2 3 3M10 8 7 11"/>',
  Ride:  '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16 10 8h5l3 8M10 8H8M13 12H8.5"/>',
  Walk:  '<circle cx="13" cy="5" r="2"/><path d="m9 21 2.5-6-2.5-3 1-5 3.5 1.5 2.5 3M10.5 9 8 12M13 14l2 7"/>',
  Hike:  '<circle cx="13" cy="5" r="2"/><path d="m9 21 2.5-6-2.5-3 1-5 3.5 1.5 2.5 3M17 9v12"/>',
  Swim:  '<circle cx="16" cy="6" r="2"/><path d="m4 12 5-3 5 3M3 17c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1"/>',
  Other: '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/>',
};

export function typeIcon(type) {
  const body = TYPE_PATHS[type] || TYPE_PATHS.Other;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Raw inner markup of an icon, for embedding in another SVG (e.g. award badges). */
export const iconBody = (name) => PATHS[name] || '';
