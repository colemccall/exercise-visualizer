/**
 * photos/detail.js
 * Photos Explorer detail view — renders one workout's route with photo
 * markers plotted along it, plus a full grid of all photos below the map
 * and a Play/Prev/Next tour that flies the map between them.
 */

import { renderRoute } from '../map/route.js';
import { ensurePhotoURL } from './heic.js';
import { ensureVideoPoster } from './video.js';

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
      </div>
    </div>

    <div class="photos-detail-mapwrap">
      <div id="pd-map" class="photos-detail-map"></div>
      <div id="pd-preview" class="pd-preview" hidden aria-hidden="true">
        <div class="pd-preview-media" id="pd-preview-media"></div>
        <div class="pd-preview-caption" id="pd-preview-caption"></div>
      </div>
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

  // Tour controls
  container.querySelector('#pd-prev').addEventListener('click', () => stepTour(container, entries, -1));
  container.querySelector('#pd-next').addEventListener('click', () => stepTour(container, entries, +1));
  container.querySelector('#pd-play').addEventListener('click', () => toggleTour(container, entries));

  // Lightbox close (stop any playing video)
  const lb = container.querySelector('#pd-lightbox');
  const media = container.querySelector('#pd-lightbox-media');
  const closeLightbox = () => { lb.hidden = true; media.innerHTML = ''; };
  container.querySelector('#pd-lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
}

function activate(container, entries, idx, { openLightbox, fly }) {
  _tourIdx = idx;
  const { photo, playableURL, tile } = entries[idx];

  // Highlight the active tile
  entries.forEach(e => e.tile?.classList.remove('active'));
  tile?.classList.add('active');
  tile?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  if (fly && _mapRef) {
    try { _mapRef.flyTo([photo.lat, photo.lng], 15, { duration: 1.0 }); } catch {}
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
  showPreview(container, entries[_tourIdx]);
  activate(container, entries, _tourIdx, { openLightbox: false, fly: true });
  scheduleTourAdvance(container, entries);
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
  if (container) hidePreview(container);
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
    v.play?.().catch(() => {}); // some browsers reject unmuted autoplay
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
