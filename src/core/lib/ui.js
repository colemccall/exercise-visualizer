/**
 * core/ui.js
 * Cross-cutting UI chrome: toast, progress bar, the upload modal and layout
 * measurement. Small, DOM-only, no app state.
 */

// ── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

/**
 * Brief notice. Errors stay longer and are announced assertively; a toast that
 * vanishes in 3 seconds is not an error report. (aria-live is set in the markup.)
 */
export function showToast(message, { duration = 3500, error = false } = {}) {
  const el = document.getElementById('bs-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', error);
  el.setAttribute('role', error ? 'alert' : 'status');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? Math.max(duration, 8000) : duration);
}

// ── Progress ─────────────────────────────────────────────────────────────────

export function showProgress(pct, label) {
  const container = document.getElementById('progress-container');
  const fill = document.getElementById('progress-fill');
  const lbl = document.getElementById('progress-label');
  if (!container) return;
  container.classList.add('visible');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  lbl.textContent = label || 'Processing…';
}

export function hideProgress() {
  document.getElementById('progress-container')?.classList.remove('visible');
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = '0%';
}

/** Inline, persistent error shown inside the upload dialog. */
export function setUploadError(message) {
  const el = document.getElementById('upload-error');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

// ── Modal focus handling ─────────────────────────────────────────────────────

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openModals = [];

/**
 * Open a dialog: remember the opener, move focus in, trap Tab, close on Escape.
 * @param {HTMLElement} backdrop element that gets the `visible` class
 * @param {HTMLElement} dialog   element carrying role="dialog"
 * @param {() => void} onClose   called after close
 */
export function openModal(backdrop, dialog, onClose) {
  const opener = document.activeElement;
  backdrop.classList.add('visible');
  document.body.classList.add('modal-open');
  const focusables = () => [...dialog.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  const keydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  function close() {
    backdrop.classList.remove('visible');
    backdrop.removeEventListener('keydown', keydown);
    const i = openModals.indexOf(close);
    if (i >= 0) openModals.splice(i, 1);
    if (!openModals.length) document.body.classList.remove('modal-open');
    if (opener && typeof opener.focus === 'function') opener.focus();
    onClose?.();
  }
  backdrop.addEventListener('keydown', keydown);
  openModals.push(close);
  (focusables()[0] || dialog).focus();
  return close;
}

export const anyModalOpen = () => openModals.length > 0;

// ── Layout ───────────────────────────────────────────────────────────────────

/**
 * Publish the height of everything stacked above the Map view as `--nav-h`
 * (nav + the merge banner when showing), and the mobile tab bar as `--tabbar-h`.
 * Measured, never hard-coded: the nav wraps under 700px and the banner comes
 * and goes. Call after anything that changes that chrome.
 */
export function syncNavHeight() {
  const nav = document.getElementById('app-nav');
  const banner = document.getElementById('duplicate-banner');
  const tabs = document.getElementById('nav-tabs');
  const navH = nav ? nav.offsetHeight : 56;
  const bannerH = banner && banner.offsetParent !== null ? banner.offsetHeight : 0;
  const bottomBar = tabs && getComputedStyle(tabs).position === 'fixed';
  document.body.style.setProperty('--nav-h', `${navH + bannerH}px`);
  document.body.style.setProperty('--tabbar-h', bottomBar ? `${tabs.offsetHeight}px` : '0px');
}
