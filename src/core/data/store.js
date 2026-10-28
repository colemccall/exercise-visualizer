/**
 * core/store.js
 * IndexedDB persistence, so a reload shows your data without re-parsing a
 * 900MB export. Everything stays in this browser (same privacy story as before)
 * and "Delete my data" wipes it.
 *
 * What is stored:
 *   activities  raw normalized activities per source, *before* dedup merging
 *               (merging mutates records, so a source can be re-uploaded and the
 *               union re-merged from clean copies)
 *   summaries   Apple ActivitySummary rows (the rings)
 *   routes      trackpoints per activity id, packed into typed arrays
 *   meta        schema version + save time
 *
 * Photos are deliberately not stored: they are large local files, and the
 * browser can't re-read them without the user picking them again.
 *
 * Every function resolves quietly to an empty/false result when IndexedDB is
 * unavailable (private windows, blocked storage), so the app still works.
 */

const DB_NAME = 'fitness-visualizer';
const DB_VERSION = 1;
const SCHEMA = 2;
/** Bumped when parsers start capturing more fields; saved data from an older parser still loads but lacks them. */
export const MODEL = 3; // bump when the activity model changes shape; older data is discarded

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('activities', { keyPath: 'id' });
      db.createObjectStore('summaries', { keyPath: 'date' });
      db.createObjectStore('routes', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Promise wrapper around a request. */
const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

// ── (De)serialisation ────────────────────────────────────────────────────────

/** Strip functions/derived state and turn Dates into numbers for storage. */
export function serializeActivity(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === 'function') continue;                 // _gpxLoader
    if (k === 'route_points' || k === 'photos') continue;  // stored separately / not at all
    if (k.startsWith('_')) continue;                       // render caches (_freqScore…)
    out[k] = v;
  }
  out.date = a.date instanceof Date ? a.date.getTime() : a.date;
  return out;
}

export function reviveActivity(rec) {
  const a = { ...rec, date: new Date(rec.date), route_points: null, photos: [], _gpxLoader: null };
  // Undo any merge state; dedup runs again from clean copies on load.
  a.merged_into = null;
  a.merged_ids = [];
  a.has_duplicate = false;
  a.duplicate_of = null;
  a.sources = [a.source];
  return a;
}

/** Pack trackpoints into typed arrays (NaN marks "missing"). */
export function packRoute(points) {
  const n = points.length;
  const lat = new Float64Array(n), lng = new Float64Array(n), time = new Float64Array(n);
  const ele = new Float32Array(n), hr = new Float32Array(n), cad = new Float32Array(n), watts = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    lat[i] = p.lat ?? NaN; lng[i] = p.lng ?? NaN;
    time[i] = p.time ? +p.time : NaN;
    ele[i] = p.ele ?? NaN; hr[i] = p.hr ?? NaN; cad[i] = p.cad ?? NaN; watts[i] = p.watts ?? NaN;
  }
  return { n, lat, lng, time, ele, hr, cad, watts };
}

export function unpackRoute(rec) {
  const pts = new Array(rec.n);
  const num = (x) => (Number.isNaN(x) ? null : x);
  for (let i = 0; i < rec.n; i++) {
    pts[i] = {
      lat: num(rec.lat[i]), lng: num(rec.lng[i]),
      ele: num(rec.ele[i]), time: Number.isNaN(rec.time[i]) ? null : new Date(rec.time[i]),
      hr: num(rec.hr[i]), cad: num(rec.cad[i]), watts: num(rec.watts[i]),
    };
  }
  return pts;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Is there a usable saved dataset? */
export async function hasData() {
  const db = await openDb();
  if (!db) return false;
  try {
    const meta = await done(db.transaction('meta').objectStore('meta').get('state'));
    return !!meta && meta.schema === SCHEMA;
  } catch { return false; }
}

/** Replace everything stored for one source with a fresh parse. */
export async function saveSource(source, activities) {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(['activities', 'meta'], 'readwrite');
    const store = tx.objectStore('activities');
    const existing = await done(store.getAll());
    for (const rec of existing) if (rec.source === source) store.delete(rec.id);
    for (const a of activities) store.put(serializeActivity(a));
    tx.objectStore('meta').put({ key: 'state', schema: SCHEMA, model: MODEL, saved: Date.now() });
    await txDone(tx);
    return true;
  } catch (e) { console.warn('store.saveSource failed', e); return false; }
}

export async function saveSummaries(summaries) {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction('summaries', 'readwrite');
    const store = tx.objectStore('summaries');
    store.clear();
    for (const s of summaries) store.put(s);
    await txDone(tx);
    return true;
  } catch (e) { console.warn('store.saveSummaries failed', e); return false; }
}

/** @returns {Promise<{activities: object[], summaries: object[], model: number}>} activities are revived, loaders attached */
export async function loadAll() {
  const db = await openDb();
  if (!db) return { activities: [], summaries: [] };
  try {
    const meta = await done(db.transaction('meta').objectStore('meta').get('state'));
    if (!meta || meta.schema !== SCHEMA) return { activities: [], summaries: [] };
    const tx = db.transaction(['activities', 'summaries']);
    const [recs, summaries] = await Promise.all([
      done(tx.objectStore('activities').getAll()),
      done(tx.objectStore('summaries').getAll()),
    ]);
    const activities = recs.map(reviveActivity);
    for (const a of activities) attachRouteLoader(a);
    summaries.sort((x, y) => (x.date < y.date ? -1 : 1));
    return { activities, summaries, model: meta.model || 2 };
  } catch (e) { console.warn('store.loadAll failed', e); return { activities: [], summaries: [] }; }
}

/** Give an activity a loader that reads its trackpoints back out of IndexedDB. */
export function attachRouteLoader(a) {
  if (a.has_route) a._gpxLoader = () => loadRoute(a.id);
}

export async function saveRoutes(entries) {
  // entries: [{ id, points }]
  const db = await openDb();
  if (!db || !entries.length) return false;
  try {
    const tx = db.transaction('routes', 'readwrite');
    const store = tx.objectStore('routes');
    for (const { id, points } of entries) if (points && points.length) store.put({ id, ...packRoute(points) });
    await txDone(tx);
    return true;
  } catch (e) { console.warn('store.saveRoutes failed', e); return false; }
}

export async function loadRoute(id) {
  const db = await openDb();
  if (!db) return [];
  try {
    const rec = await done(db.transaction('routes').objectStore('routes').get(id));
    return rec ? unpackRoute(rec) : [];
  } catch { return []; }
}

/** Which route ids are already saved (so we only write new ones). */
export async function savedRouteIds() {
  const db = await openDb();
  if (!db) return new Set();
  try {
    return new Set(await done(db.transaction('routes').objectStore('routes').getAllKeys()));
  } catch { return new Set(); }
}

/** Drop saved routes whose activity no longer exists (after a re-upload). */
export async function pruneRoutes(validIds) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction('routes', 'readwrite');
    const store = tx.objectStore('routes');
    const keys = await done(store.getAllKeys());
    for (const k of keys) if (!validIds.has(k)) store.delete(k);
    await txDone(tx);
  } catch { /* best effort */ }
}

/** "Delete my data": wipe everything this app stored. */
export async function clearAll() {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(['activities', 'summaries', 'routes', 'meta'], 'readwrite');
    for (const name of ['activities', 'summaries', 'routes', 'meta']) tx.objectStore(name).clear();
    await txDone(tx);
    return true;
  } catch { return false; }
}

export async function storageEstimate() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}
