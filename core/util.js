/**
 * core/util.js
 * Small helpers shared by app.js, the views and the chart modules. One copy of
 * each so a fix lands everywhere (escapeHtml used to exist four times, one of
 * them without quote escaping).
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use inside innerHTML, including attribute values. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch]);
}

/** Tagged template that escapes every interpolation: html`<b>${name}</b>`. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += (v && v.__raw !== undefined ? v.__raw : escapeHtml(v)) + strings[i + 1];
  });
  return out;
}

/** Mark a string as already-safe markup for html`` (use sparingly). */
export function raw(markup) {
  return { __raw: String(markup) };
}

/** Debounce: run fn once `ms` after the last call. */
export function debounce(fn, ms = 150) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Run fn on the next animation frame, coalescing repeat calls. */
export function rafOnce(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/** localStorage that never throws (private windows, blocked storage). */
export const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/**
 * Parse a date input's "YYYY-MM-DD" as local midnight.
 * `new Date('2024-01-01')` is parsed as *UTC* midnight, so west of Greenwich
 * the filter lands a day early.
 */
export function parseDateInput(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Does the user ask the OS for less motion? */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT = MONTH_NAMES.map(m => m.slice(0, 3));
