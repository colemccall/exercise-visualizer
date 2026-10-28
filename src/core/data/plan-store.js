/**
 * core/data/plan-store.js
 * The nutrition planner's data: who you are, what you're aiming at, what you eat.
 * Lives in state.plan, persisted as small documents in IndexedDB (core/data/store.js).
 * Nothing here leaves the browser, and "Delete my data" clears it.
 *
 *   profile    { sex, birth_year, height_cm, baseline, bmrSource }
 *   goals      { lose: {target_kg, target_date|rate_kg_week}|null,
 *                performance: {event, date, target_time_s}|null }
 *   scenarios  [{ id, name, kcal, protein_g, carbs_g, fat_g }]
 *   activeScenario  id of the scenario the targets are calculated for
 *   weights    [{ date, kg, source: 'manual'|'apple' }]
 *   foodlog    [{ date, kcal, protein, carbs, fat }]
 *
 * Only the birth YEAR is stored, never a full date of birth.
 */

import { saveDoc, loadDocs, deleteDoc } from './store.js';
import { debounce } from '../lib/util.js';

export const PLAN_KEYS = ['profile', 'goals', 'scenarios', 'weights', 'foodlog'];

export function emptyPlan() {
  return {
    profile: { sex: null, birth_year: null, height_cm: null, baseline: 'sedentary', bmrSource: 'watch' },
    goals: { lose: null, performance: null },
    scenarios: [],
    activeScenario: null,
    weights: [],
    foodlog: [],
  };
}

export const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Load whatever is saved; missing pieces fall back to defaults. */
export async function loadPlan() {
  const docs = await loadDocs();
  const plan = emptyPlan();
  if (docs.profile) plan.profile = { ...plan.profile, ...docs.profile };
  if (docs.goals) plan.goals = { ...plan.goals, ...docs.goals };
  if (Array.isArray(docs.scenarios)) plan.scenarios = docs.scenarios;
  if (docs.activeScenario) plan.activeScenario = docs.activeScenario;
  if (Array.isArray(docs.weights)) plan.weights = docs.weights;
  if (Array.isArray(docs.foodlog)) plan.foodlog = docs.foodlog;
  return { plan, health: docs.apple_health || null };
}

const pending = new Set();
const flush = debounce(async (plan) => {
  const keys = [...pending]; pending.clear();
  for (const key of keys) await saveDoc(key, key === 'activeScenario' ? plan.activeScenario : plan[key]);
}, 300);

/** Mark one part of the plan changed; it is written shortly after (inputs fire fast). */
export function persistPlan(plan, ...keys) {
  keys.forEach(k => pending.add(k));
  flush(plan);
}

export const saveHealth = (health) => saveDoc('apple_health', health);
export const clearHealth = () => deleteDoc('apple_health');

// ── Import / export (a plan is portable JSON) ────────────────────────────────

export function exportPlanJson(plan) {
  return JSON.stringify({ app: 'fitness-visualizer', kind: 'plan', version: 1, plan }, null, 2);
}

/** @returns {object} a plan, or throws a readable Error */
export function importPlanJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (data?.kind !== 'plan' || !data.plan) throw new Error('That does not look like an exported plan.');
  const merged = emptyPlan();
  const p = data.plan;
  if (p.profile) merged.profile = { ...merged.profile, ...p.profile };
  if (p.goals) merged.goals = { ...merged.goals, ...p.goals };
  if (Array.isArray(p.scenarios)) merged.scenarios = p.scenarios.filter(s => s && s.name && s.kcal > 0);
  merged.activeScenario = p.activeScenario || merged.scenarios[0]?.id || null;
  if (Array.isArray(p.weights)) merged.weights = p.weights.filter(w => w && w.date && w.kg > 0);
  if (Array.isArray(p.foodlog)) merged.foodlog = p.foodlog.filter(f => f && f.date && f.kcal > 0);
  return merged;
}

/**
 * "YYYY-MM-DD..." read by its parts. new Date("2026-03-01") is UTC midnight, which is the
 * previous *evening* west of Greenwich, so ISO dates must not go through Date().
 * Other formats ("3/1/2026", "Mar 1, 2026") are read as local dates.
 */
function toDayKey(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text).trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(text);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Parse a nutrition CSV export (MyFitnessPal, Cronometer, a spreadsheet). Header names are
 * matched loosely: date / day; calories / energy / kcal; protein; carbs / carbohydrate; fat.
 * @returns {{rows: object[], skipped: number}}
 */
export function parseFoodCsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { rows: [], skipped: 0 };
  const split = (line) => { const out = []; let f = '', q = false; for (const c of line) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(f); f = ''; } else f += c; } out.push(f); return out.map(x => x.trim()); };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const iDate = col('date', 'day'), iKcal = col('calorie', 'energy', 'kcal'), iP = col('protein'), iC = col('carb'), iF = col('fat');
  if (iDate < 0 || iKcal < 0) return { rows: [], skipped: lines.length - 1 };
  const rows = []; let skipped = 0;
  const byDay = new Map();
  for (const line of lines.slice(1)) {
    const c = split(line);
    const kcal = parseFloat(c[iKcal]);
    const key = toDayKey(c[iDate]);
    if (!key || !(kcal > 0)) { skipped++; continue; }
    const prev = byDay.get(key) || { date: key, kcal: 0, protein: 0, carbs: 0, fat: 0 };
    prev.kcal += kcal;
    if (iP >= 0) prev.protein += parseFloat(c[iP]) || 0;
    if (iC >= 0) prev.carbs += parseFloat(c[iC]) || 0;
    if (iF >= 0) prev.fat += parseFloat(c[iF]) || 0;
    byDay.set(key, prev);   // several rows for one day (meals) add up
  }
  for (const v of byDay.values()) rows.push({ date: v.date, kcal: Math.round(v.kcal), protein: Math.round(v.protein), carbs: Math.round(v.carbs), fat: Math.round(v.fat) });
  return { rows: rows.sort((a, b) => (a.date < b.date ? -1 : 1)), skipped };
}
