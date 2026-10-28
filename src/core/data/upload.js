/**
 * core/upload.js
 * Getting data in: staging files in the upload dialog, parsing them, merging
 * duplicates across sources, persisting to IndexedDB, and restoring on the next
 * visit. All parsing happens in this browser; nothing is sent anywhere.
 */

import { parse as parseStrava } from '../../parsers/strava.js';
import { parseAppleExport } from '../../parsers/apple.js';
import { parse as parsePhotos } from '../../parsers/photos.js';
import { matchPhotosToActivities } from '../../photos/matcher.js';
import { mergeDuplicates } from './dedup.js';
import { state, emit } from '../state.js';
import { detectSources } from '../modes.js';
import { escapeHtml } from '../lib/util.js';
import { showProgress, hideProgress, showToast, setUploadError } from '../lib/ui.js';
import { ensureRoutes } from './routes.js';
import * as store from './store.js';

/** Staged (not yet parsed) files per source */
export const staged = { strava: [], apple: [], photos: [] };

const FITNESS_SOURCES = ['strava', 'apple'];
const ALL_ZONES = ['strava', 'apple', 'photos'];
const DEFAULT_LABEL = { strava: 'Choose ZIP file', apple: 'Choose file', photos: 'Choose files' };

// ── Staging UI ───────────────────────────────────────────────────────────────

export function setupUploadZones() {
  for (const source of ALL_ZONES) {
    const zone = document.getElementById(`zone-${source}`);
    const input = document.getElementById(`file-${source}`);
    if (!zone || !input) continue;

    // Not input.click(): iOS Safari blocks programmatic clicks. The <label for>
    // in the markup opens the picker natively.
    input.addEventListener('change', () => { if (input.files.length) stageFiles(source, [...input.files]); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files];
      if (files.length) stageFiles(source, files);
    });
    updateZoneUI(source);
  }
  updateGoButton();
}

function stageFiles(source, files) {
  staged[source] = files;
  setUploadError('');
  updateZoneUI(source);
  updateGoButton();
}

function updateZoneUI(source) {
  const files = staged[source];
  const zone = document.getElementById(`zone-${source}`);
  const sub = document.getElementById(`sub-${source}`);
  const list = document.getElementById(`filelist-${source}`);
  if (!zone || !sub) return;
  if (files.length) {
    zone.classList.add('staged');
    zone.classList.remove('loaded');
    sub.textContent = files.length === 1 ? 'Change file' : `${files.length} files selected`;
    if (list) list.innerHTML = files.slice(0, 6).map(f => `<div class="staged-file">${escapeHtml(f.name)}</div>`).join('')
      + (files.length > 6 ? `<div class="staged-file">…and ${files.length - 6} more</div>` : '');
  } else {
    zone.classList.remove('staged', 'loaded');
    sub.textContent = DEFAULT_LABEL[source];
    if (list) list.innerHTML = '';
  }
}

function updateGoButton() {
  const total = ALL_ZONES.reduce((n, s) => n + staged[s].length, 0);
  const btn = document.getElementById('btn-go');
  const count = document.getElementById('go-file-count');
  if (!btn) return;
  btn.disabled = total === 0;
  btn.classList.toggle('ready', total > 0);
  if (count) count.textContent = ALL_ZONES.filter(s => staged[s].length).map(s => `${staged[s].length} ${s}`).join(', ');
}

// ── Merge / sources ──────────────────────────────────────────────────────────

/** Re-run duplicate merging over everything loaded and refresh source flags. */
export function rebuildMerge() {
  mergeDuplicates(state.activities);
  state.has = detectSources(state.activities.filter(a => !a.merged_into), state.summaries);
}

// ── Parse staged files ───────────────────────────────────────────────────────

/** Photos are identified by name + size + modified time so re-adding doesn't double them. */
const photoKey = (p) => `${p.file?.name ?? p.name}|${p.file?.size ?? ''}|${p.file?.lastModified ?? ''}`;

/**
 * Parse everything staged.
 * @returns {Promise<{loaded:number, errors:string[]}>}
 */
export async function parseStaged() {
  const btn = document.getElementById('btn-go');
  if (btn) btn.disabled = true;
  setUploadError('');

  const sources = FITNESS_SOURCES.filter(s => staged[s].length);
  const photoFiles = staged.photos;
  if (!sources.length && !photoFiles.length) return { loaded: 0, errors: [] };

  showProgress(0, 'Starting…');
  let loaded = 0;
  const errors = [];

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si];
    const base = Math.round((si / sources.length) * 88);
    const slice = Math.round(88 / sources.length);
    const onProgress = (p, label) => showProgress(base + Math.round((p / 100) * slice), label);

    let fresh = [];
    let summaries = null;
    try {
      for (const file of staged[source]) {
        if (source === 'apple') {
          const out = await parseAppleExport(file, onProgress);
          fresh = fresh.concat(out.activities);
          summaries = (summaries || []).concat(out.summaries);
        } else {
          fresh = fresh.concat(await parseStrava(file, onProgress));
        }
      }
    } catch (err) {
      console.error(`Error parsing ${source}:`, err);
      errors.push(`${source}: ${err.message}`);
      continue;
    }

    if (!fresh.length && !(summaries && summaries.length)) {
      errors.push(`${source}: no activities found in ${staged[source].map(f => f.name).join(', ')}. Is this the right export?`);
      continue;
    }

    // Persist the raw activities before merging mutates them.
    await store.saveSource(source, fresh);
    state.activities = state.activities.filter(a => a.source !== source).concat(fresh);
    if (summaries) {
      const byDay = new Map(summaries.map(s => [s.date, s]));
      state.summaries = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      await store.saveSummaries(state.summaries);
    }
    loaded += fresh.length;

    document.getElementById(`zone-${source}`)?.classList.replace('staged', 'loaded');
    const sub = document.getElementById(`sub-${source}`);
    if (sub) sub.textContent = `${fresh.length.toLocaleString()} loaded`;
    staged[source] = [];
  }

  showProgress(90, 'Merging duplicates…');
  rebuildMerge();

  // ── Photos & videos (optional) ───────────────────────────────────────────
  if (photoFiles.length) {
    try {
      showProgress(92, `Reading ${photoFiles.length} files…`);
      const fresh = await parsePhotos(photoFiles, (pct, label) => showProgress(92 + Math.round(pct / 100 * 6), label));
      const have = new Set(state.photos.map(photoKey));
      const added = fresh.filter(p => !have.has(photoKey(p)));
      // The parser numbers ids per batch; renumber so a second batch can't collide.
      added.forEach((p, i) => { p.id = `photo-${state.photos.length + i}-${p.name}`; });
      state.photos = state.photos.concat(added);
      document.getElementById('zone-photos')?.classList.replace('staged', 'loaded');
      const sub = document.getElementById('sub-photos');
      if (sub) sub.textContent = `${fresh.length} loaded`;
      staged.photos = [];
    } catch (err) {
      console.error('Photo parse failed:', err);
      errors.push(`photos: ${err.message}`);
    }
  }
  await rematchPhotos();

  showProgress(100, errors.length && !loaded ? 'Nothing loaded' : 'Done!');
  setTimeout(hideProgress, 500);
  updateGoButton();
  if (errors.length) setUploadError(errors.join('\n'));
  emit('data');
  return { loaded, errors };
}

export async function rematchPhotos() {
  if (!state.photos.length) return;
  state.photoMatch = await matchPhotosToActivities(state.photos, state.activities.filter(a => !a.merged_into), {
    bufferMinutes: state.photoBuffer,
  });
}

// ── Restore + background route saving ────────────────────────────────────────

/** Load whatever a previous visit saved. @returns {Promise<boolean>} true if data was restored */
export async function restoreSaved() {
  if (!(await store.hasData())) return false;
  const { activities, summaries, model } = await store.loadAll();
  if (!activities.length && !summaries.length) return false;
  state.activities = activities;
  state.summaries = summaries;
  state.dataModel = model;
  rebuildMerge();
  return true;
}

let saving = null;

/**
 * Decode every route once and write it to IndexedDB so the next visit skips
 * parsing entirely. Runs in the background; the UI doesn't wait for it.
 */
export function saveRoutesInBackground() {
  if (saving) return saving;
  saving = (async () => {
    try {
      const have = await store.savedRouteIds();
      const todo = state.activities.filter(a => a.has_route && !have.has(a.id));
      if (todo.length) {
        await ensureRoutes(todo, { concurrency: 4 });
        for (let i = 0; i < todo.length; i += 25) {
          await store.saveRoutes(todo.slice(i, i + 25)
            .filter(a => a.route_points && a.route_points.length)
            .map(a => ({ id: a.id, points: a.route_points })));
          await new Promise(r => setTimeout(r, 0));
        }
      }
      await store.pruneRoutes(new Set(state.activities.map(a => a.id)));
      if (todo.length) showToast('Saved in this browser — your data will be here next time.');
    } catch (e) { console.warn('background save failed', e); }
    finally { saving = null; }
  })();
  return saving;
}

/** "Delete my data": wipe storage and reset everything in memory. */
export async function deleteAllData() {
  await store.clearAll();
  state.activities = []; state.summaries = []; state.photos = [];
  state.photoMatch = { matched: 0, unmatched: 0, activitiesWithPhotos: [] };
  state.has = { strava: false, apple: false };
  for (const s of ALL_ZONES) staged[s] = [];
}
