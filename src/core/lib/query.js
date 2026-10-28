/**
 * core/lib/query.js
 * The search language. One line of text <-> the shared filter object, so a typed
 * search, a clicked chart bar and a bookmarked link are all the same thing.
 *
 *   type:run,ride        year:2025            month:2025-04        before:2025-06-01   after:2025-01-01
 *   dist:>10km           dist:5..10mi         dur:>1h30m           dur:20m..45m        elev:>500m
 *   hr:>150              source:apple         has:route            is:indoor           gear:pegasus
 *   dow:sat,sun          sort:-dist           sort:oldest          "hill repeats"      anything else = text
 *
 * Bare words (and "quoted phrases") search the name, type, sub-type, description, gear
 * and device. Units default to the user's setting (mi/ft or km/m) but may be written.
 * A recognised key with a value it can't read is reported in `errors` (and ignored);
 * an unrecognised "word:" is kept as plain text, so searching "9:30" or "re:run" works.
 *
 * Pure: no DOM. parseQuery() -> { filters, text, errors }; formatQuery() is its inverse.
 */

import { getUnits } from './format.js';

const M_PER_MI = 1609.344;
const FT = 0.3048;

/** The empty value of every filter field (also the shape of state.filters). */
export function emptyFilters() {
  return {
    type: 'All', types: [], search: '', year: null, month: null, from: null, to: null,
    source: null, hasRoute: null, indoor: null, gear: '', duplicatesOnly: false,
    dist: null, dur: null, elev: null, hr: null, dow: [], sort: null,
  };
}

const KEYS = new Set(['type', 'year', 'month', 'before', 'after', 'dist', 'dur', 'elev', 'hr', 'source', 'has', 'is', 'gear', 'dow', 'sort', 'merged']);
const TYPES = { run: 'Run', ride: 'Ride', bike: 'Ride', cycle: 'Ride', cycling: 'Ride', walk: 'Walk', hike: 'Hike', swim: 'Swim', other: 'Other' };
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_NAME = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SORTS = { date: 'date', dist: 'dist', distance: 'dist', dur: 'dur', time: 'dur', duration: 'dur', elev: 'elev', climb: 'elev', pace: 'pace', speed: 'pace', hr: 'hr', name: 'name' };
const DEFAULT_DIR = { date: 'desc', dist: 'desc', dur: 'desc', elev: 'desc', hr: 'desc', pace: 'asc', name: 'asc' };

// ── Value parsers (each returns a value, or throws a readable Error) ─────────

function parseNumber(s) {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`"${s}" is not a number`);
  return n;
}

/** "10km" / "6.2mi" / "5000m" / "10" -> metres. */
function distance(s, fallbackUnit) {
  const m = /^([\d.]+)\s*(km|mi|m)?$/i.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not a distance (try 10km or 6mi)`);
  const unit = (m[2] || fallbackUnit).toLowerCase();
  const v = parseNumber(m[1]);
  return unit === 'km' ? v * 1000 : unit === 'mi' ? v * M_PER_MI : v;
}

/** "1h30m" / "45m" / "90s" / "1:30" / "45" (minutes) -> seconds. */
function duration(s) {
  const t = s.trim().toLowerCase();
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (m) return m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 3600 + (+m[2]) * 60;
  m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return (parseFloat(m[1]) || 0) * 3600 + (parseFloat(m[2]) || 0) * 60 + (parseFloat(m[3]) || 0);
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t) * 60;
  throw new Error(`"${s}" is not a duration (try 1h30m or 45m)`);
}

/** "500m" / "1500ft" / "500" -> metres. */
function elevation(s, fallbackUnit) {
  const m = /^([\d.]+)\s*(m|ft)?$/i.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not an elevation (try 500m or 1500ft)`);
  const unit = (m[2] || fallbackUnit).toLowerCase();
  const v = parseNumber(m[1]);
  return unit === 'ft' ? v * FT : v;
}

const heartRate = (s) => parseNumber(s.trim());

/**
 * ">10km" | ">=10km" | "<5mi" | "5..10km" -> [min, max] (null = open end).
 * A trailing unit on the last number applies to both ends of "a..b".
 */
function range(raw, parse) {
  const s = raw.trim();
  const dots = s.indexOf('..');
  if (dots > 0) {
    const a = s.slice(0, dots), b = s.slice(dots + 2);
    if (!a || !b) throw new Error(`"${raw}" needs a number on both sides of ..`);
    const unit = /[a-z]+$/i.exec(b)?.[0];
    const lo = parse(/[a-z]+$/i.test(a) || !unit ? a : a + unit);
    const hi = parse(b);
    return lo <= hi ? [lo, hi] : [hi, lo];
  }
  const m = /^(>=|<=|>|<)\s*(.+)$/.exec(s);
  if (!m) throw new Error(`"${raw}" needs > or < or a..b (for example >10km)`);
  const v = parse(m[2]);
  return m[1][0] === '>' ? [v, null] : [null, v];
}

function localDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not a date (use YYYY-MM-DD)`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

// ── parseQuery ──────────────────────────────────────────────────────────────

/** Split on spaces, keeping "quoted phrases" and key:"quoted value" intact. */
function tokenize(text) {
  const out = [];
  const re = /(?:[A-Za-z]+:)?"[^"]*"|\S+/g;
  let m;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

/**
 * @param {string} text
 * @param {{units?: 'imperial'|'metric'}} [opts]
 * @returns {{filters: object, text: string, errors: {token: string, message: string}[]}}
 */
export function parseQuery(text, { units = getUnits() } = {}) {
  const f = emptyFilters();
  const errors = [];
  const words = [];
  const dUnit = units === 'imperial' ? 'mi' : 'km';
  const eUnit = units === 'imperial' ? 'ft' : 'm';

  for (const token of tokenize(String(text || ''))) {
    const m = /^([A-Za-z]+):(.*)$/.exec(token);
    const key = m && m[1].toLowerCase();
    if (!m || !KEYS.has(key)) { words.push(token.replace(/^"|"$/g, '')); continue; }
    const value = m[2].replace(/^"|"$/g, '');
    try {
      switch (key) {
        case 'type': {
          const list = value.split(',').map(v => TYPES[v.trim().toLowerCase()]);
          if (list.some(v => !v)) throw new Error(`type must be run, ride, walk, hike, swim or other`);
          f.types = [...new Set(list)];
          break;
        }
        case 'year': { const y = parseInt(value, 10); if (!(y >= 1990 && y <= 2100)) throw new Error('year must look like 2025'); f.year = y; break; }
        case 'month': {
          const mm = /^(\d{4})-(\d{1,2})$/.exec(value);
          if (!mm || +mm[2] < 1 || +mm[2] > 12) throw new Error('month must look like 2025-04');
          f.month = `${mm[1]}-${+mm[2] - 1}`;   // filters.month is "YYYY-<0-based month>"
          break;
        }
        case 'before': f.to = localDate(value); break;
        case 'after': f.from = localDate(value); break;
        case 'dist': f.dist = range(value, s => distance(s, dUnit)); break;
        case 'dur': f.dur = range(value, duration); break;
        case 'elev': f.elev = range(value, s => elevation(s, eUnit)); break;
        case 'hr': f.hr = range(value, heartRate); break;
        case 'source': {
          const v = value.toLowerCase();
          if (v !== 'apple' && v !== 'strava') throw new Error('source must be apple or strava');
          f.source = v; break;
        }
        case 'has': if (value.toLowerCase() !== 'route') throw new Error('has: only supports route'); f.hasRoute = true; break;
        case 'is': {
          const v = value.toLowerCase();
          if (v === 'indoor') f.indoor = true; else if (v === 'outdoor') f.indoor = false;
          else if (v === 'merged') f.duplicatesOnly = true;
          else throw new Error('is: supports indoor, outdoor or merged');
          break;
        }
        case 'merged': f.duplicatesOnly = true; break;
        case 'gear': f.gear = value.toLowerCase(); break;
        case 'dow': {
          const days = value.toLowerCase() === 'weekend' ? [0, 6] : value.toLowerCase() === 'weekday' ? [1, 2, 3, 4, 5]
            : value.split(',').map(v => DOW[v.trim().toLowerCase().slice(0, 3)]);
          if (days.some(d => d === undefined)) throw new Error('dow must be days like sat,sun (or weekend / weekday)');
          f.dow = [...new Set(days)].sort(); break;
        }
        case 'sort': {
          let v = value.toLowerCase(), dir = null;
          if (v === 'oldest') { v = 'date'; dir = 'asc'; } else if (v === 'newest') { v = 'date'; dir = 'desc'; }
          else if (v.startsWith('-')) { v = v.slice(1); dir = 'desc'; }
          else if (v.startsWith('+')) { v = v.slice(1); dir = 'asc'; }
          const k = SORTS[v];
          if (!k) throw new Error('sort must be date, dist, dur, elev, pace, hr or name');
          f.sort = { key: k, dir: dir || DEFAULT_DIR[k] };
          break;
        }
        default: break;
      }
    } catch (e) { errors.push({ token, message: e.message }); }
  }
  f.search = words.join(' ').trim();
  return { filters: f, text: f.search, errors };
}

// ── formatQuery ─────────────────────────────────────────────────────────────

const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
const trim = (n) => String(Math.round(n * 100) / 100);

function fmtRange(r, show) {
  if (!r) return '';
  const [lo, hi] = r;
  if (lo !== null && hi !== null) return `${show(lo)}..${show(hi)}`;
  return lo !== null ? `>${show(lo)}` : `<${show(hi)}`;
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m || Math.round(s)}${m ? 'm' : 's'}`;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The filter as removable pieces: [{ key, text }]. `key` is the state.filters field a
 * chip's "x" should reset; joined with spaces the texts are the query string.
 */
export function queryTokens(f, { units = getUnits() } = {}) {
  const out = [];
  const imp = units === 'imperial';
  if (f.types?.length) out.push({ key: 'types', text: `type:${f.types.map(t => t.toLowerCase()).join(',')}` });
  else if (f.type && f.type !== 'All') out.push({ key: 'type', text: `type:${f.type.toLowerCase()}` });
  if (f.year) out.push({ key: 'year', text: `year:${f.year}` });
  if (f.month) { const [y, m] = f.month.split('-'); out.push({ key: 'month', text: `month:${y}-${String(+m + 1).padStart(2, '0')}` }); }
  if (f.from) out.push({ key: 'from', text: `after:${ymd(f.from)}` });
  if (f.to) out.push({ key: 'to', text: `before:${ymd(f.to)}` });
  if (f.dist) out.push({ key: 'dist', text: `dist:${fmtRange(f.dist, v => (imp ? `${trim(v / M_PER_MI)}mi` : `${trim(v / 1000)}km`))}` });
  if (f.dur) out.push({ key: 'dur', text: `dur:${fmtRange(f.dur, fmtDuration)}` });
  if (f.elev) out.push({ key: 'elev', text: `elev:${fmtRange(f.elev, v => (imp ? `${Math.round(v / FT)}ft` : `${Math.round(v)}m`))}` });
  if (f.hr) out.push({ key: 'hr', text: `hr:${fmtRange(f.hr, v => String(Math.round(v)))}` });
  if (f.source) out.push({ key: 'source', text: `source:${f.source}` });
  if (f.hasRoute) out.push({ key: 'hasRoute', text: 'has:route' });
  if (f.indoor !== null && f.indoor !== undefined) out.push({ key: 'indoor', text: f.indoor ? 'is:indoor' : 'is:outdoor' });
  if (f.duplicatesOnly) out.push({ key: 'duplicatesOnly', text: 'is:merged' });
  if (f.gear) out.push({ key: 'gear', text: `gear:${q(f.gear)}` });
  if (f.dow?.length) {
    const wk = f.dow.join() === '0,6' ? 'weekend' : f.dow.join() === '1,2,3,4,5' ? 'weekday' : f.dow.map(d => DOW_NAME[d]).join(',');
    out.push({ key: 'dow', text: `dow:${wk}` });
  }
  if (f.sort) {
    const d = f.sort.dir === DEFAULT_DIR[f.sort.key] ? '' : (f.sort.dir === 'asc' ? (f.sort.key === 'date' ? '' : '+') : '-');
    out.push({ key: 'sort', text: f.sort.key === 'date' && f.sort.dir === 'asc' ? 'sort:oldest' : `sort:${d}${f.sort.key}` });
  }
  if (f.search) out.push({ key: 'search', text: /\s/.test(f.search) ? `"${f.search}"` : f.search });
  return out;
}

export function formatQuery(f, opts) {
  return queryTokens(f, opts).map(t => t.text).join(' ');
}
