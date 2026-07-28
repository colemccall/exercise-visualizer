/**
 * photos/detail.js
 * Photos Explorer detail view — renders one workout's route with photo
 * markers plotted along it, plus a full grid of all photos below the map
 * and a Play/Prev/Next tour that flies the map between them.
 */

import { renderRoute } from '../map/route.js';
import { ensurePhotoURL } from './heic.js';
import { ensureVideoPoster } from './video.js';
import { exportTourVideo, downloadBlob } from './export.js';

let _tourTimer = null;
let _tourIdx = 0;
let _mapRef = null;
let _tourPlaying = false;
const PHOTO_HOLD_MS = 4000;
const VIDEO_MAX_MS  = 20000;

/**
 * @param {HTMLElement} container
 * @param {Activity} activity  Must have activity.photos populated
 * @param {{onBack: () => void}} opts
 */
export async function renderPhotosDetail(container, activity, opts) {
  stopTour();

  container.innerHTML = `
    <div class="photos-detail-header">
      <button class="bs-btn-ghost" id="pd-back">&larr; Back</button>
      <div class="photos-detail-title">
        <div class="photos-detail-name">${escapeHtml(activity.name || activity.type)}</div>
        <div class="photos-detail-meta">${escapeHtml(activity.type)} · ${formatDate(activity.date)} · ${activity.photos.length} photo${activity.photos.length === 1 ? '' : 's'}</div>
      </div>
      <div class="photos-detail-tour">
        <button class="tl-btn" id="pd-prev" title="Previous">&larr;</button>
        <button class="tl-btn" id="pd-play" title="Play tour">&#9654; Play</button>
        <button class="tl-btn" id="pd-next" title="Next">&rarr;</button>
        <button class="tl-btn" id="pd-share" title="Export tour as video">&#128190; Share</button>
      </div>
    </div>

    <div class="photos-detail-mapwrap">
      <div id="pd-map" class="photos-detail-map"></div>
      <div id="pd-preview" class="pd-preview" hidden aria-hidden="true">
        <div class="pd-preview-media" id="pd-preview-media"></div>
        <div class="pd-preview-caption" id="pd-preview-caption"></div>
      </div>
    </div>
    <div class="cinema-controls" role="group" aria-label="Tour controls">
      <button class="tl-btn" id="pd-cinema-prev" title="Previous">&larr;</button>
      <button class="tl-btn" id="pd-cinema-pause" title="Pause tour">&#9646;&#9646;</button>
      <button class="tl-btn" id="pd-cinema-next" title="Next">&rarr;</button>
      <button class="tl-btn" id="pd-cinema-exit" title="Exit fullscreen">&times;</button>
    </div>

    <div class="photos-detail-legend">
      <span><span class="pd-legend-dot solid"></span> EXIF GPS</span>
      <span><span class="pd-legend-dot dashed"></span> Interpolated from GPX time</span>
      <span class="pd-legend-hint">Click any photo below to fly the map there and open it.</span>
    </div>

    <div id="pd-grid" class="pd-grid"></div>

    <div id="pd-lightbox" class="pd-lightbox" hidden>
      <div class="pd-lightbox-inner">
        <div id="pd-lightbox-media" class="pd-lightbox-media"></div>
        <div id="pd-lightbox-caption" class="pd-lightbox-caption"></div>
        <button class="pd-lightbox-close" id="pd-lightbox-close">&times;</button>
      </div>
    </div>

    <div id="pd-share-modal" class="pd-share-modal" hidden>
      <div class="pd-share-inner">
        <div class="pd-share-header">
          <div class="pd-share-title">Export tour as video</div>
          <button class="pd-share-close" id="pd-share-close">&times;</button>
        </div>
        <div class="pd-share-body">
          <p class="pd-share-hint">
            Renders your photo tour to a shareable WebM file — plays inline in Twitter/X, iMessage, Discord, WhatsApp, and Slack.
          </p>
          <div class="pd-share-row">
            <label>Speed <span id="pd-share-speed-val">1.0×</span></label>
            <input type="range" id="pd-share-speed" min="0.5" max="3" step="0.1" value="1" />
          </div>
          <div class="pd-share-row">
            <label>Pause on photos <span id="pd-share-hold-val">3s</span></label>
            <input type="range" id="pd-share-hold" min="1" max="8" step="1" value="3" />
          </div>
          <div class="pd-share-row">
            <label>Extra pause after videos <span id="pd-share-tail-val">1s</span></label>
            <input type="range" id="pd-share-tail" min="0" max="3" step="1" value="1" />
          </div>
          <div class="pd-share-status" id="pd-share-status" hidden>
            <div class="pd-share-progress"><div id="pd-share-progress-fill"></div></div>
            <div id="pd-share-status-label" class="pd-share-status-label"></div>
          </div>
        </div>
        <div class="pd-share-footer">
          <button class="bs-btn bs-btn-secondary" id="pd-share-cancel">Cancel</button>
          <button class="bs-btn" id="pd-share-go">Export</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#pd-back').addEventListener('click', () => {
    stopTour(container);
    opts.onBack();
  });

  // Ensure route is loaded before rendering.
  if (!activity.route_points && typeof activity._gpxLoader === 'function') {
    try { activity.route_points = await activity._gpxLoader(); } catch {}
  }

  const mapEl = container.querySelector('#pd-map');
  const map = renderRoute(activity, mapEl);
  _mapRef = map;

  // Build the entries once — each carries its playable URL, poster URL, and
  // (later) references to the DOM elements so we can highlight them.
  const entries = [];
  for (let i = 0; i < activity.photos.length; i++) {
    const p = activity.photos[i];
    if (p.lat === null || p.lng === null) continue;
    const src = p._source || p;
    const playableURL = p.isVideo ? src.url : await ensurePhotoURL(src);
    const thumbURL    = p.isVideo ? await ensureVideoPoster(src) : playableURL;
    entries.push({ photo: p, playableURL, thumbURL, marker: null, tile: null });
  }

  // Plot map markers (small circles). Skip if map failed to render.
  if (map) {
    entries.forEach((entry, i) => {
      const { photo, thumbURL } = entry;
      const marker = L.marker([photo.lat, photo.lng], {
        icon: L.divIcon({
          className: 'photo-marker-wrap',
          html: makeMarkerHTML(thumbURL, photo.interpolated, photo.isVideo),
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        }),
      });
      marker.on('click', () => activate(container, entries, i, { openLightbox: true, fly: true }));
      marker.addTo(map);
      entry.marker = marker;
    });
  }

  // Build the photo grid — always visible, always populated.
  const grid = container.querySelector('#pd-grid');
  if (entries.length === 0) {
    grid.innerHTML = `<div class="pd-grid-empty">No photos have a resolvable location for this workout.</div>`;
  } else {
    entries.forEach((entry, i) => {
      const { photo, thumbURL } = entry;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pd-tile';
      tile.innerHTML = `
        <div class="pd-tile-thumb" style="${thumbURL ? `background-image:url('${cssEscape(thumbURL)}')` : ''}">
          ${photo.isVideo ? '<span class="pd-tile-play">&#9654;</span>' : ''}
          ${photo.interpolated ? '<span class="pd-tile-badge" title="Interpolated position">≈</span>' : ''}
          ${!thumbURL && photo.isHEIC ? '<span class="pd-tile-fallback">HEIC</span>' : ''}
        </div>
        <div class="pd-tile-caption">${escapeHtml(photo.timestamp ? formatTime(photo.timestamp) : (photo.name || ''))}</div>
      `;
      tile.addEventListener('click', () => activate(container, entries, i, { openLightbox: true, fly: true }));
      grid.appendChild(tile);
      entry.tile = tile;
    });
  }

  // Tour controls (header + floating cinema-mode set)
  container.querySelector('#pd-prev').addEventListener('click', () => stepTour(container, entries, -1));
  container.querySelector('#pd-next').addEventListener('click', () => stepTour(container, entries, +1));
  container.querySelector('#pd-play').addEventListener('click', () => toggleTour(container, entries));
  container.querySelector('#pd-cinema-prev')?.addEventListener('click', () => stepTour(container, entries, -1));
  container.querySelector('#pd-cinema-next')?.addEventListener('click', () => stepTour(container, entries, +1));
  container.querySelector('#pd-cinema-pause')?.addEventListener('click', () => toggleTour(container, entries));
  container.querySelector('#pd-cinema-exit')?.addEventListener('click', () => toggleTour(container, entries));

  // Lightbox close (stop any playing video)
  const lb = container.querySelector('#pd-lightbox');
  const media = container.querySelector('#pd-lightbox-media');
  const closeLightbox = () => { lb.hidden = true; media.innerHTML = ''; };
  container.querySelector('#pd-lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  // Share (export tour as video) modal
  wireShareModal(container, activity);
}

function wireShareModal(container, activity) {
  const modal = container.querySelector('#pd-share-modal');
  const openBtn  = container.querySelector('#pd-share');
  const closeBtn = container.querySelector('#pd-share-close');
  const cancelBtn = container.querySelector('#pd-share-cancel');
  const goBtn = container.querySelector('#pd-share-go');
  const speedIn = container.querySelector('#pd-share-speed');
  const holdIn  = container.querySelector('#pd-share-hold');
  const tailIn  = container.querySelector('#pd-share-tail');
  const speedLbl = container.querySelector('#pd-share-speed-val');
  const holdLbl  = container.querySelector('#pd-share-hold-val');
  const tailLbl  = container.querySelector('#pd-share-tail-val');
  const statusEl = container.querySelector('#pd-share-status');
  const statusLbl = container.querySelector('#pd-share-status-label');
  const progFill  = container.querySelector('#pd-share-progress-fill');

  const close = () => {
    if (goBtn.disabled) return; // don't close mid-render
    modal.hidden = true;
    statusEl.hidden = true;
    statusLbl.textContent = '';
    progFill.style.width = '0%';
  };

  openBtn.addEventListener('click', () => { modal.hidden = false; });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  speedIn.addEventListener('input', () => { speedLbl.textContent = `${(+speedIn.value).toFixed(1)}×`; });
  holdIn.addEventListener('input',  () => { holdLbl.textContent  = `${holdIn.value}s`; });
  tailIn.addEventListener('input',  () => { tailLbl.textContent  = `${tailIn.value}s`; });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    statusEl.hidden = false;
    try {
      const blob = await exportTourVideo({
        activity,
        opts: {
          speedMultiplier: +speedIn.value,
          photoHoldMs: +holdIn.value * 1000,
          videoTailMs: +tailIn.value * 1000,
          onProgress: (pct, label) => {
            progFill.style.width = `${pct}%`;
            if (label) statusLbl.textContent = `${label} ${pct}%`;
          },
        },
      });
      const dateStr = activity.date ? activity.date.toISOString().slice(0, 10) : 'tour';
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, `workout-tour-${dateStr}.${ext}`);
      statusLbl.textContent = 'Saved to Downloads';
    } catch (err) {
      console.error('[share] export failed', err);
      statusLbl.textContent = `Failed: ${err.message || err}`;
    } finally {
      goBtn.disabled = false;
      cancelBtn.disabled = false;
      closeBtn.disabled = false;
    }
  });
}

function activate(container, entries, idx, { openLightbox, fly }) {
  _tourIdx = idx;
  const { photo, playableURL, tile } = entries[idx];

  // Highlight the active tile
  entries.forEach(e => e.tile?.classList.remove('active'));
  tile?.classList.add('active');
  tile?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  if (fly && _mapRef) {
    // Zoom 13 shows the surrounding streets/terrain so you can identify
    // where the photo was taken, not just the exact GPS pin.
    try { _mapRef.flyTo([photo.lat, photo.lng], 13, { duration: 1.0 }); } catch {}
  }
  if (openLightbox) showLightbox(container, photo, playableURL);
}

function showLightbox(container, photo, url) {
  const lb    = container.querySelector('#pd-lightbox');
  const media = container.querySelector('#pd-lightbox-media');
  const cap   = container.querySelector('#pd-lightbox-caption');
  media.innerHTML = '';
  if (photo.isVideo && url) {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.className = 'pd-lightbox-video';
    media.appendChild(v);
  } else if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = photo.name || '';
    img.className = 'pd-lightbox-img';
    media.appendChild(img);
  } else {
    const p = document.createElement('div');
    p.className = 'pd-lightbox-fallback';
    p.textContent = 'HEIC decode failed — export as JPG to preview.';
    media.appendChild(p);
  }
  cap.innerHTML = `${escapeHtml(photo.name || '')}
    <span class="pd-caption-meta">${photo.timestamp ? photo.timestamp.toLocaleString() : ''}${photo.interpolated ? ' · interpolated position' : ''}</span>`;
  lb.hidden = false;
}

function makeMarkerHTML(url, interpolated, isVideo) {
  const style = interpolated ? 'photo-marker interpolated' : 'photo-marker';
  const bg = url ? `background-image:url('${cssEscape(url)}')` : 'background:#888';
  const badge = isVideo ? '<span class="photo-marker-play">&#9654;</span>' : '';
  return `<div class="${style}" style="${bg}">${badge}</div>`;
}

function stepTour(container, entries, delta) {
  if (!entries.length) return;
  const idx = (_tourIdx + delta + entries.length) % entries.length;
  activate(container, entries, idx, { openLightbox: false, fly: true });
  // If tour is playing, restart the auto-advance timer around the new item.
  if (_tourPlaying) scheduleTourAdvance(container, entries);
}

function toggleTour(container, entries) {
  const btn = container.querySelector('#pd-play');
  if (_tourPlaying) {
    stopTour(container);
    if (btn) btn.innerHTML = '&#9654; Play';
    return;
  }
  if (!entries.length) return;
  _tourPlaying = true;
  if (btn) btn.innerHTML = '&#9646;&#9646; Pause';
  enterCinema(container);
  showPreview(container, entries[_tourIdx]);
  activate(container, entries, _tourIdx, { openLightbox: false, fly: true });
  scheduleTourAdvance(container, entries);
}

function enterCinema(container) {
  container.classList.add('cinema');
  // Leaflet needs to re-measure its container after the size change.
  setTimeout(() => { try { _mapRef?.invalidateSize(); } catch {} }, 240);
}

function exitCinema(container) {
  container.classList.remove('cinema');
  setTimeout(() => { try { _mapRef?.invalidateSize(); } catch {} }, 240);
}

function scheduleTourAdvance(container, entries) {
  clearTimeout(_tourTimer);
  const entry = entries[_tourIdx];
  const isVideo = !!entry.photo.isVideo;
  const advance = () => {
    if (!_tourPlaying) return;
    const nextIdx = (_tourIdx + 1) % entries.length;
    activate(container, entries, nextIdx, { openLightbox: false, fly: true });
    showPreview(container, entries[nextIdx]);
    scheduleTourAdvance(container, entries);
  };
  if (isVideo) {
    // Wait for the video element in the preview to end (capped by VIDEO_MAX_MS).
    const videoEl = container.querySelector('#pd-preview-media video');
    if (videoEl) {
      const onEnd = () => { videoEl.removeEventListener('ended', onEnd); advance(); };
      videoEl.addEventListener('ended', onEnd);
      _tourTimer = setTimeout(() => {
        videoEl.removeEventListener('ended', onEnd);
        advance();
      }, VIDEO_MAX_MS);
    } else {
      _tourTimer = setTimeout(advance, PHOTO_HOLD_MS);
    }
  } else {
    _tourTimer = setTimeout(advance, PHOTO_HOLD_MS);
  }
}

function stopTour(container) {
  clearTimeout(_tourTimer);
  _tourTimer = null;
  _tourPlaying = false;
  if (container) {
    hidePreview(container);
    exitCinema(container);
  }
}

function showPreview(container, entry) {
  if (!container || !entry) return;
  const preview = container.querySelector('#pd-preview');
  const media   = container.querySelector('#pd-preview-media');
  const cap     = container.querySelector('#pd-preview-caption');
  if (!preview || !media) return;

  const { photo, playableURL } = entry;
  media.innerHTML = '';
  if (photo.isVideo && playableURL) {
    const v = document.createElement('video');
    v.src = playableURL;
    v.autoplay = true;
    v.controls = true;
    v.playsInline = true;
    v.muted = false;
    v.className = 'pd-preview-video';
    media.appendChild(v);
    // Try unmuted first (Play button was a user gesture so this usually
    // works). If the browser still blocks it, fall back to muted playback
    // with a one-tap unmute hint.
    v.play?.().catch(() => {
      v.muted = true;
      v.play?.().catch(() => {});
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'pd-preview-unmute';
      hint.innerHTML = '🔇 Tap to unmute';
      hint.addEventListener('click', () => {
        v.muted = false;
        v.play?.().catch(() => {});
        hint.remove();
      });
      media.appendChild(hint);
    });
  } else if (playableURL) {
    const img = document.createElement('img');
    img.src = playableURL;
    img.alt = photo.name || '';
    img.className = 'pd-preview-img';
    media.appendChild(img);
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'pd-preview-fallback';
    fallback.textContent = 'Preview unavailable';
    media.appendChild(fallback);
  }
  const time = photo.timestamp ? photo.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  cap.textContent = time
    ? `${time}${photo.interpolated ? ' · interpolated' : ''}`
    : (photo.name || '');
  preview.hidden = false;
  preview.setAttribute('aria-hidden', 'false');
}

function hidePreview(container) {
  const preview = container.querySelector('#pd-preview');
  const media   = container.querySelector('#pd-preview-media');
  if (preview) { preview.hidden = true; preview.setAttribute('aria-hidden', 'true'); }
  if (media) media.innerHTML = ''; // stops any playing video
}

function formatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function cssEscape(s) {
  return String(s).replace(/'/g, "\\'");
}
