/**
 * core/collapse.js
 * Collapsible panels. Anything carrying `data-collapse="<key>"` is a toggle; the
 * section it folds is its closest `.panel` / `.chart-card` / `#explore-panel`
 * ancestor, which gets the `collapsed` class (CSS then hides that section's
 * `.collapsible-body`). State persists per key under `fitness-collapsed:<key>`:
 * the usual reason to collapse something here is "leave the map big", and that
 * shouldn't reset on reload.
 *
 * D3 charts size to their container, which is 0px wide while hidden, so callers
 * pass `onExpand(key)` to redraw them.
 */

import { safeStorage } from './util.js';

const PREFIX = 'fitness-collapsed:';

/** Sections that start folded. The map's tools strip does, so Map is just the map. */
const COLLAPSED_BY_DEFAULT = { explore: true };

const sectionFor = (toggle) => toggle.closest('.panel, .chart-card, #explore-panel');

export function isCollapsed(key) {
  const stored = safeStorage.get(PREFIX + key);
  if (stored === null) return !!COLLAPSED_BY_DEFAULT[key];
  return stored === '1';
}

export function setCollapsed(key, collapsed, onChange) {
  const toggle = document.querySelector(`[data-collapse="${key}"]`);
  const section = toggle && sectionFor(toggle);
  if (!section) return;

  section.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  safeStorage.set(PREFIX + key, collapsed ? '1' : '0');

  const label = toggle.querySelector('.panel-toggle-label');
  if (label) label.textContent = collapsed ? 'Show tools' : 'Hide tools';
  onChange?.(key, collapsed);
}

/**
 * @param {(key: string, collapsed: boolean) => void} onChange  fired after any toggle
 */
export function initCollapsibles(onChange) {
  document.querySelectorAll('[data-collapse]').forEach(toggle => {
    const key = toggle.dataset.collapse;
    setCollapsed(key, isCollapsed(key), onChange);
    toggle.addEventListener('click', () => {
      setCollapsed(key, !sectionFor(toggle)?.classList.contains('collapsed'), onChange);
    });
  });

  // Chart cards collapse from their own title, keyed by the chart's id.
  document.querySelectorAll('.chart-card .card-toggle').forEach(btn => {
    const card = btn.closest('.chart-card');
    const key = `card-${card.querySelector('[id^="chart-"]')?.id || card.id}`;
    const apply = (collapsed) => {
      card.classList.toggle('collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
    };
    apply(isCollapsed(key));
    btn.addEventListener('click', () => {
      const next = !card.classList.contains('collapsed');
      apply(next);
      safeStorage.set(PREFIX + key, next ? '1' : '0');
      onChange?.(key, next);
    });
  });

  // "Collapse all" / "Expand all" for the Stats view
  const allBtn = document.getElementById('btn-collapse-all');
  if (allBtn) {
    const panels = ['stats', 'filters', 'activities', 'charts'];
    const label = () => {
      allBtn.textContent = panels.some(k => !isCollapsed(k)) ? 'Collapse all sections' : 'Expand all sections';
    };
    allBtn.addEventListener('click', () => {
      const anyOpen = panels.some(k => !isCollapsed(k));
      panels.forEach(k => setCollapsed(k, anyOpen, onChange));
      label();
    });
    label();
  }
}
