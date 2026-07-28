/**
 * photos/list.js
 * Render the Photos Explorer list — one card per workout that has
 * matched photos, sorted newest first. Includes a buffer-minutes slider that
 * re-runs matching when changed.
 */

import { ensurePhotoURL } from './heic.js';
import { ensureVideoPoster } from './video.js';

/**
 * @param {HTMLElement} container
 * @param {Activity[]} activitiesWithPhotos
 * @param {{
 *   bufferMinutes: number,
 *   totalPhotos: number,
 *   unmatched: number,
 *   onBufferChange: (n:number) => void,
 *   onOpen: (activity:Activity) => void,
 * }} opts
 */
export function renderPhotosList(container, activitiesWithPhotos, opts) {
  container.innerHTML = '';

  // Header + buffer slider + match stats
  const header = document.createElement('div');
  header.className = 'photos-header';
  header.innerHTML = `
    <div class="photos-title">Photo tour</div>
    <div class="photos-stats">
      <span><strong>${activitiesWithPhotos.length}</strong> workouts with photos</span>
      <span>·</span>
      <span><strong>${opts.totalPhotos - opts.unmatched}</strong> matched</span>
      ${opts.unmatched > 0 ? `<span>·</span><span class="photos-unmatched">${opts.unmatched} unmatched</span>` : ''}
    </div>
    <div class="photos-buffer-row">
      <label for="photos-buffer">Match window ±</label>
      <input type="range" id="photos-buffer" min="0" max="30" step="1" value="${opts.bufferMinutes}" />
      <span id="photos-buffer-val">${opts.bufferMinutes} min</span>
    </div>
  `;
  container.appendChild(header);

  const slider = header.querySelector('#photos-buffer');
  const label  = header.querySelector('#photos-buffer-val');
  let sliderDebounce;
  slider.addEventListener('input', () => {
    label.textContent = `${slider.value} min`;
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(() => opts.onBufferChange(parseInt(slider.value, 10)), 300);
  });

  if (activitiesWithPhotos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'photos-empty';
    empty.textContent = 'No photos matched to workouts. Try increasing the match window, or drop more photos.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'photos-list';
  container.appendChild(list);

  const sorted = activitiesWithPhotos.slice().sort((a, b) => b.date - a.date);
  for (const a of sorted) {
    const row = document.createElement('div');
    row.className = 'photos-row bs-card';
    row.innerHTML = `
      <div class="photos-row-info">
        <div class="photos-row-date">${formatDate(a.date)}</div>
        <div class="photos-row-name">${escapeHtml(a.name || a.type)}</div>
        <div class="photos-row-meta">${escapeHtml(a.type)} · ${a.photos.length} photo${a.photos.length === 1 ? '' : 's'}</div>
      </div>
      <div class="photos-row-thumbs"></div>
    `;
    const thumbs = row.querySelector('.photos-row-thumbs');
    for (const p of a.photos.slice(0, 4)) {
      const wrap = document.createElement('div');
      wrap.className = 'photos-thumb-wrap';
      const img = document.createElement('img');
      img.className = 'photos-thumb';
      img.alt = p.name || '';
      img.loading = 'lazy';
      wrap.appendChild(img);
      if (p.isVideo) {
        const badge = document.createElement('span');
        badge.className = 'photos-thumb-play';
        badge.textContent = '▶'; // ▶
        wrap.appendChild(badge);
        ensureVideoPoster(p._source || p).then(url => { if (url) img.src = url; });
      } else {
        ensurePhotoURL(p._source || p).then(url => { if (url) img.src = url; });
      }
      thumbs.appendChild(wrap);
    }
    row.addEventListener('click', () => opts.onOpen(a));
    list.appendChild(row);
  }
}

function formatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
