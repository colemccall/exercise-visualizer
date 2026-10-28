/**
 * charts/tooltip.js
 * One shared tooltip element for the D3 charts. The per-chart copies each
 * appended a new <div> to <body> on every render and never removed it, so every
 * filter change leaked one.
 */

let el = null;

export function addTooltip() {
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.id = 'chart-tooltip';
    el.setAttribute('role', 'tooltip');
    el.style.cssText = 'position:fixed;background:var(--card, var(--bg));border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text);pointer-events:none;z-index:9000;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.15);line-height:1.6;';
    document.body.appendChild(el);
  }
  return {
    /** html must already be escaped by the caller. */
    show(event, html) {
      el.innerHTML = html;
      el.style.display = 'block';
      el.style.left = (event.clientX + 12) + 'px';
      el.style.top = (event.clientY - 10) + 'px';
    },
    hide() { el.style.display = 'none'; },
  };
}
