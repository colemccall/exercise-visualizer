/**
 * scripts/check-contrast.mjs
 * WCAG AA check for the six mode × theme variants in styles/modes.css.
 *   node scripts/check-contrast.mjs
 * Exits non-zero if any pair fails, so it can run in CI.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'modes.css'), 'utf8');

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum ratio, why]
const PAIRS = [
  ['--text', '--card', 4.5, 'body text on card'],
  ['--text', '--page', 4.5, 'body text on page'],
  ['--text-mid', '--card', 4.5, 'secondary text on card'],
  ['--text-mid', '--page', 4.5, 'secondary text on page'],
  ['--text-muted', '--card', 4.5, 'muted text on card'],
  ['--text-muted', '--page', 4.5, 'muted text on page'],
  ['--text-muted', '--card-2', 4.5, 'muted text on nested surface'],
  ['--accent', '--card', 4.5, 'accent used as text/link on card'],
  ['--accent', '--page', 4.5, 'accent used as text/link on page'],
  ['--on-accent', '--accent', 4.5, 'text on accent fill'],
  ['--ring-move', '--card', 3, 'Move ring graphic on card'],
  ['--ring-exercise', '--card', 3, 'Exercise ring graphic on card'],
  ['--ring-stand', '--card', 3, 'Stand ring graphic on card'],
];

const blocks = [...css.matchAll(/^((?:html\.dark-mode )?body\.app-fitness\[data-mode="(\w+)"\])\s*\{([^}]*)\}/gm)];
let failures = 0;

for (const [, selector, mode, body] of blocks) {
  const theme = selector.startsWith('html.dark-mode') ? 'dark' : 'light';
  const vars = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
  for (const [fg, bg, min, why] of PAIRS) {
    if (!vars[fg] || !vars[bg]) { console.log(`?  ${mode}/${theme}: missing ${fg} or ${bg}`); failures++; continue; }
    const r = ratio(vars[fg], vars[bg]);
    const ok = r >= min;
    if (!ok) failures++;
    if (!ok || process.argv.includes('--verbose')) {
      console.log(`${ok ? 'ok' : 'FAIL'}  ${mode}/${theme}  ${why}: ${fg} ${vars[fg]} on ${bg} ${vars[bg]} = ${r.toFixed(2)} (need ${min})`);
    }
  }
}

console.log(`${blocks.length} variants checked, ${failures} failing pair(s)`);
process.exit(failures ? 1 : 0);
