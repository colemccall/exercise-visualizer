/**
 * views/plan.js
 * Plan: your body, your goals and what you eat -> the exercise that adds up.
 *
 * Left: inputs (profile, goals, eating scenarios, food log). Right: results that
 * recompute live as any input changes: daily / weekly / monthly targets, predicted
 * weight change, projected goal date, progress this week, a side-by-side scenario
 * comparison and the weight trend. The maths lives in analysis/health/nutrition.js;
 * this file is inputs, persistence and presentation.
 *
 * Everything is stored on this device (core/data/plan-store.js) and calculated here;
 * nothing is sent anywhere. These are planning estimates, not medical advice.
 */

import { state, dataAnchor } from '../core/state.js';
import { showToast } from '../core/lib/ui.js';
import { escapeHtml, debounce } from '../core/lib/util.js';
import { getUnits, formatDistance, formatMovingTime } from '../core/lib/format.js';
import { dayKey, weekStartKey, keyToDate } from '../analysis/dates.js';
import {
  ewmaTrend, baseBurn, activityProfile, planTargets, compareScenarios, observedExpenditure,
  macroSummary, EVENTS,
} from '../analysis/health/nutrition.js';
import {
  persistPlan, newId, exportPlanJson, importPlanJson, parseFoodCsv,
} from '../core/data/plan-store.js';
import { renderWeightChart } from '../charts/weight-chart.js';
import { loadEfforts, cachedEfforts } from './awards.js';
import { icon } from '../components/icons.js';

// ── Units ───────────────────────────────────────────────────────────────────
const imperial = () => getUnits() === 'imperial';
const LB = 2.20462262;
const toDisplayWeight = (kg) => (imperial() ? kg * LB : kg);
const fromDisplayWeight = (v) => (imperial() ? v / LB : v);
const weightUnit = () => (imperial() ? 'lb' : 'kg');
const fmtWeight = (kg) => `${toDisplayWeight(kg).toFixed(1)} ${weightUnit()}`;
const round = (n, to = 1) => Math.round(n / to) * to;
const num = (n) => Math.round(n).toLocaleString();

const todayKey = () => dayKey(new Date());

/** "25:30" or "1:45:00" -> seconds; null when not a time. */
export function parseClock(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (!parts.length || parts.some(n => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
export function formatClock(s) {
  if (s === null || s === undefined || Number.isNaN(s)) return '';
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let period = 'week';        // 'day' | 'week' | 'month' (targets tab)
let resizeObs = null;

// ── Model assembly ──────────────────────────────────────────────────────────

function allWorkouts() { return state.activities.filter(a => !a.merged_into); }

function ensureScenario() {
  const plan = state.plan;
  if (!plan.scenarios.length) {
    const kcal = 2000;
    plan.scenarios.push({ id: newId(), name: 'My plan', kcal, protein_g: 150, carbs_g: 200, fat_g: 62 });
    plan.activeScenario = plan.scenarios[0].id;
    persistPlan(plan, 'scenarios', 'activeScenario');
  }
  if (!plan.scenarios.some(s => s.id === plan.activeScenario)) plan.activeScenario = plan.scenarios[0].id;
  return plan.scenarios.find(s => s.id === plan.activeScenario);
}

/** Everything the results panel needs, from the current inputs. */
function compute() {
  const plan = state.plan;
  const anchor = dataAnchor();
  const now = new Date();
  const trend = ewmaTrend(plan.weights);
  const weight_kg = trend.length ? trend[trend.length - 1].trend : null;
  const workouts = allWorkouts();
  const activity = activityProfile(workouts, { now: anchor, days: 90 });

  const active_by_day = {};
  for (const s of state.summaries) if (s.move_unit !== 'min') active_by_day[s.date] = s.move_kcal;
  let base = weight_kg ? baseBurn({
    profile: plan.profile, weight_kg, basal_by_day: state.health?.basal_by_day, active_by_day,
    workouts, now: anchor, bmrSource: plan.profile.bmrSource,
  }) : null;

  // Food-log-derived expenditure (needs weeks of logging + weigh-ins)
  const foodlog = mergedFoodlog();
  const observed = observedExpenditure({ foodlog, weights: plan.weights, now });
  if (base && observed && plan.profile.useObserved) {
    const exerciseDaily = activity.weekly_kcal / 7;
    const nonExercise = Math.max(base.bmr, observed.tdee - exerciseDaily);
    base = { ...base, base: nonExercise, neat: nonExercise - base.bmr, source: 'observed' };
  }

  const efforts = (cachedEfforts() || []).filter(e => e.type === 'Run' && e.dist_m >= 1000 && e.time_s > 0)
    .map(e => ({ distance_m: e.dist_m, time_s: e.time_s }));
  const run = { weekly_m: activity.weekly_distance_m.Run || 0, best_efforts: efforts, kcal_per_m: activity.by_type.Run?.kcal_per_m || null };

  const goals = {};
  const g = plan.goals;
  if (g.lose && g.lose.target_kg > 0 && (g.lose.target_date || g.lose.rate_kg_week > 0)) goals.lose = { type: 'lose', ...g.lose };
  if (g.performance && g.performance.date && g.performance.date > todayKey()) goals.performance = { type: 'performance', ...g.performance };

  const lastWeighIn = trend.length ? trend[trend.length - 1].date : null;
  const staleDays = lastWeighIn ? Math.round((Date.now() - new Date(lastWeighIn + 'T12:00:00').getTime()) / 864e5) : null;

  const scenario = ensureScenario();
  const common = { profile: plan.profile, weight_kg: weight_kg || 0, goals, base, activity, run, now };
  const result = planTargets({ ...common, scenario });
  const compare = compareScenarios({ scenarios: plan.scenarios, ...common });
  return { trend, weight_kg, base, activity, observed, goals, scenario, result, compare, anchor, now, workouts, staleDays };
}

function mergedFoodlog() {
  const byDate = new Map();
  for (const [date, v] of Object.entries(state.health?.dietary_by_day || {})) byDate.set(date, { date, ...v });
  for (const e of state.plan.foodlog) byDate.set(e.date, e);          // your own entries win
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ── Left column: inputs ─────────────────────────────────────────────────────

function sel(opts, value) {
  return opts.map(([v, label]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function heightFields(cm) {
  if (!imperial()) {
    return `<label class="fld"><span>Height (cm)</span><input id="p-height-cm" type="number" min="100" max="230" step="1" inputmode="decimal" value="${cm ? Math.round(cm) : ''}"></label>`;
  }
  const totalIn = cm ? cm / 2.54 : 0;
  const ft = cm ? Math.floor(totalIn / 12) : '';
  const inch = cm ? Math.round(totalIn - Math.floor(totalIn / 12) * 12) : '';
  return `<div class="fld"><span>Height</span><div class="fld-pair">
    <input id="p-height-ft" type="number" min="3" max="7" step="1" inputmode="numeric" value="${ft}" aria-label="Feet"><em>ft</em>
    <input id="p-height-in" type="number" min="0" max="11" step="1" inputmode="numeric" value="${inch}" aria-label="Inches"><em>in</em></div></div>`;
}

function inputsHtml(c) {
  const plan = state.plan, p = plan.profile, g = plan.goals;
  const lose = g.lose || {}, perf = g.performance || {};
  const health = state.health;
  const hasBasal = !!(health?.basal_by_day && Object.keys(health.basal_by_day).length >= 7);
  const canImport = !!(health && (health.me || health.weights?.length || health.height_cm));
  const lastWeights = [...plan.weights].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
  const sc = c.scenario;
  const log = [...plan.foodlog].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 7);
  const dietaryDays = Object.keys(health?.dietary_by_day || {}).length;
  const loseMode = lose.target_date || !lose.rate_kg_week ? 'date' : 'rate';
  const defDate = (weeks) => dayKey(new Date(Date.now() + weeks * 7 * 864e5));

  return `
  <section class="act-card plan-card" aria-labelledby="pc-you">
    <h2 id="pc-you" class="act-card-title">About you</h2>
    <div class="fld-grid">
      <label class="fld"><span>Sex</span><select id="p-sex"><option value="">Choose…</option>${sel([['female', 'Female'], ['male', 'Male'], ['other', 'Prefer not to say']], p.sex)}</select></label>
      <label class="fld"><span>Birth year</span><input id="p-birth" type="number" min="1920" max="${new Date().getFullYear() - 10}" step="1" inputmode="numeric" value="${p.birth_year || ''}" placeholder="e.g. 1990"></label>
      ${heightFields(p.height_cm)}
      <label class="fld"><span>Day-to-day movement</span><select id="p-baseline">${sel([['sedentary', 'Mostly seated'], ['light', 'Some walking about'], ['active', 'On my feet most of the day']], p.baseline)}</select></label>
    </div>
    ${hasBasal ? `<label class="fld"><span>Resting energy from</span><select id="p-bmr">${sel([['watch', 'My Apple Watch (recommended)'], ['formula', 'Standard formula (Mifflin–St Jeor)']], p.bmrSource || 'watch')}</select></label>` : ''}
    <p class="fld-help">Used for resting energy (Mifflin–St Jeor). ${state.health?.basal_by_day && Object.keys(state.health.basal_by_day).length ? 'Your Apple Watch&rsquo;s own resting-energy and daily-movement data are used when available.' : ''}</p>

    <h3 class="plan-sub">Weight</h3>
    <div class="weight-now">${c.weight_kg ? `<strong>${fmtWeight(c.weight_kg)}</strong> <span>smoothed from ${plan.weights.length} weigh-in${plan.weights.length === 1 ? '' : 's'}</span>` : '<span>No weigh-ins yet. Add your current weight to calculate targets.</span>'}</div>
    ${c.staleDays !== null && c.staleDays > 14 ? `<p class="stale-note">Your last weigh-in was ${c.staleDays > 90 ? Math.round(c.staleDays / 30) + ' months' : c.staleDays + ' days'} ago. Targets assume your weight hasn&rsquo;t changed since; log today&rsquo;s weight for accurate numbers.</p>` : ''}
    <div class="fld-row">
      <label class="fld"><span>Date</span><input id="w-date" type="date" value="${todayKey()}"></label>
      <label class="fld"><span>Weight (${weightUnit()})</span><input id="w-val" type="number" min="20" max="900" step="0.1" inputmode="decimal" placeholder="${imperial() ? '185.0' : '84.0'}"></label>
      <button type="button" class="bs-btn bs-btn-secondary" id="w-add">Log</button>
    </div>
    ${lastWeights.length ? `<ul class="mini-list">${lastWeights.map(w => `<li>${escapeHtml(w.date)} · ${fmtWeight(w.kg)}${w.source === 'apple' ? ' <small>Apple Health</small>' : ''} <button type="button" class="x-btn" data-del-weight="${escapeHtml(w.date)}|${w.kg}" aria-label="Remove ${escapeHtml(w.date)} weigh-in">×</button></li>`).join('')}</ul>` : ''}
    ${canImport ? `<button type="button" class="bs-btn bs-btn-secondary" id="btn-import-apple">${icon('heart', { size: 18 })} Fill from Apple Health</button>
      <p class="fld-help">Reads your sex, birth year, height and ${health.weights?.length || 0} weigh-in${health.weights?.length === 1 ? '' : 's'} from the export you loaded. Only your birth <em>year</em> is kept.</p>` : ''}
  </section>

  <section class="act-card plan-card" aria-labelledby="pc-goals">
    <h2 id="pc-goals" class="act-card-title">Goals</h2>
    <label class="check"><input type="checkbox" id="g-lose-on" ${g.lose ? 'checked' : ''}> Lose weight</label>
    ${g.lose ? `
    <div class="goal-body">
      <label class="fld"><span>Target weight (${weightUnit()})</span><input id="g-lose-target" type="number" min="20" max="900" step="0.1" inputmode="decimal" value="${lose.target_kg ? toDisplayWeight(lose.target_kg).toFixed(1) : ''}"></label>
      <div class="seg" role="radiogroup" aria-label="How to set the pace">
        <button type="button" role="radio" aria-checked="${loseMode === 'date'}" data-lose-mode="date">By a date</button>
        <button type="button" role="radio" aria-checked="${loseMode === 'rate'}" data-lose-mode="rate">At a weekly rate</button>
      </div>
      ${loseMode === 'date'
        ? `<label class="fld"><span>Reach it by</span><input id="g-lose-date" type="date" min="${todayKey()}" value="${lose.target_date || defDate(16)}"></label>`
        : `<label class="fld"><span>Lose per week (${weightUnit()})</span><input id="g-lose-rate" type="number" min="0.1" max="5" step="0.05" inputmode="decimal" value="${toDisplayWeight(lose.rate_kg_week || 0.45).toFixed(2)}"></label>`}
    </div>` : ''}

    <label class="check"><input type="checkbox" id="g-perf-on" ${g.performance ? 'checked' : ''}> Run an event</label>
    ${g.performance ? `
    <div class="goal-body">
      <div class="fld-row">
        <label class="fld"><span>Distance</span><select id="g-perf-event">${sel(Object.entries(EVENTS).map(([k, v]) => [k, v.label]), perf.event || '10k')}</select></label>
        <label class="fld"><span>Event date</span><input id="g-perf-date" type="date" min="${todayKey()}" value="${perf.date || defDate(12)}"></label>
        <label class="fld"><span>Target time <small>(optional)</small></span><input id="g-perf-time" type="text" inputmode="numeric" placeholder="mm:ss or h:mm:ss" value="${perf.target_time_s ? formatClock(perf.target_time_s) : ''}"></label>
      </div>
    </div>` : ''}
  </section>

  <section class="act-card plan-card" aria-labelledby="pc-eat">
    <h2 id="pc-eat" class="act-card-title">What you eat</h2>
    <p class="fld-help">Make a scenario for a typical day, then compare them. Change the calories and watch the exercise targets move.</p>
    <div class="chips" role="group" aria-label="Eating scenarios">
      ${plan.scenarios.map(s => `<button type="button" class="chip" data-scn="${s.id}" aria-pressed="${s.id === sc.id}">${escapeHtml(s.name)}</button>`).join('')}
      <button type="button" class="chip ghost" id="scn-new">+ New</button>
    </div>
    <div class="scn-editor">
      <label class="fld"><span>Name</span><input id="s-name" type="text" maxlength="40" value="${escapeHtml(sc.name)}"></label>
      <div class="kcal-row">
        <label class="fld grow"><span>Calories a day</span>
          <input id="s-kcal" type="range" min="1000" max="4500" step="25" value="${Math.min(4500, Math.max(1000, sc.kcal))}" aria-label="Calories a day"></label>
        <input id="s-kcal-num" type="number" min="800" max="6000" step="25" inputmode="numeric" value="${Math.round(sc.kcal)}" aria-label="Calories, exact">
      </div>
      <div class="fld-row three">
        <label class="fld"><span>Protein (g)</span><input id="s-protein" type="number" min="0" max="500" step="1" inputmode="numeric" value="${sc.protein_g ?? ''}"></label>
        <label class="fld"><span>Carbs (g)</span><input id="s-carbs" type="number" min="0" max="800" step="1" inputmode="numeric" value="${sc.carbs_g ?? ''}"></label>
        <label class="fld"><span>Fat (g)</span><input id="s-fat" type="number" min="0" max="300" step="1" inputmode="numeric" value="${sc.fat_g ?? ''}"></label>
      </div>
      <p class="fld-help" id="s-macro-note"></p>
      <div class="btn-row">
        <button type="button" class="bs-btn bs-btn-secondary" id="scn-split">Split 30/40/30</button>
        <button type="button" class="bs-btn bs-btn-secondary" id="scn-dup">Duplicate</button>
        ${plan.scenarios.length > 1 ? '<button type="button" class="bs-btn bs-btn-ghost" id="scn-del">Delete</button>' : ''}
      </div>
    </div>

    <details class="log-details" ${plan.foodlog.length ? 'open' : ''}>
      <summary>Daily food log <small>(optional, for real intake and calibration)</small></summary>
      <div class="fld-row">
        <label class="fld"><span>Date</span><input id="fl-date" type="date" value="${todayKey()}"></label>
        <label class="fld"><span>Calories</span><input id="fl-kcal" type="number" min="0" max="10000" step="1" inputmode="numeric"></label>
        <label class="fld"><span>Protein</span><input id="fl-protein" type="number" min="0" max="600" step="1" inputmode="numeric"></label>
        <button type="button" class="bs-btn bs-btn-secondary" id="fl-add">Add</button>
      </div>
      ${log.length ? `<ul class="mini-list">${log.map(e => `<li>${escapeHtml(e.date)} · ${num(e.kcal)} kcal${e.protein ? ` · ${num(e.protein)} g protein` : ''} <button type="button" class="x-btn" data-del-food="${escapeHtml(e.date)}" aria-label="Remove ${escapeHtml(e.date)}">×</button></li>`).join('')}</ul>` : ''}
      <div class="btn-row">
        <label class="bs-btn bs-btn-secondary file-btn">Import CSV<input id="fl-csv" type="file" accept=".csv,text/csv" class="sr-only"></label>
        ${plan.foodlog.length >= 3 ? '<button type="button" class="bs-btn bs-btn-secondary" id="scn-from-log">Use my recent average</button>' : ''}
        ${dietaryDays ? `<button type="button" class="bs-btn bs-btn-secondary" id="fl-apple">Add ${dietaryDays} day${dietaryDays === 1 ? '' : 's'} from Apple Health</button>` : ''}
      </div>
      <p class="fld-help">CSV needs a date column and a calories column (protein, carbs and fat are read if present). Several meals on one day are added up.</p>
    </details>
  </section>

  <section class="act-card plan-card" aria-labelledby="pc-data">
    <h2 id="pc-data" class="act-card-title">Your plan data</h2>
    <p class="fld-help">Saved only in this browser. Export it as a file to back it up or move it to another device.</p>
    <div class="btn-row">
      <button type="button" class="bs-btn bs-btn-secondary" id="plan-export">Export plan</button>
      <label class="bs-btn bs-btn-secondary file-btn">Import plan<input id="plan-import" type="file" accept=".json,application/json" class="sr-only"></label>
    </div>
  </section>`;
}

// ── Right column: results ───────────────────────────────────────────────────

const PERIOD_LABEL = { day: 'Each day', week: 'Each week', month: 'Each month' };

function tile(label, value, sub = '') {
  return `<div class="act-stat"><span class="act-stat-lbl">${escapeHtml(label)}</span><span class="act-stat-val">${value}</span>${sub ? `<span class="tile-sub">${sub}</span>` : ''}</div>`;
}

function targetsHtml(c) {
  const r = c.result;
  if (!r.base) return `<section class="act-card"><h2 class="act-card-title">Your targets</h2><p class="muted-note">Add your sex, birth year, height and a weight to see targets.</p></section>`;
  const t = r.targets[period];
  const kcalTxt = num(t.kcal);
  const per = period === 'day' ? 'a day' : period === 'week' ? 'a week' : 'a month';
  const sessions = t.sessions === null ? '—' : period === 'day' ? (t.sessions < 0.15 ? '—' : `≈ ${t.sessions.toFixed(1)}`) : `${Math.max(t.kcal > 0 ? 1 : 0, Math.round(t.sessions))}`;
  const wkChange = r.projected ? r.projected.kg_per_week : 0;
  const changeTxt = Math.abs(wkChange) < 0.005 ? 'about level' : `${wkChange < 0 ? '−' : '+'}${Math.abs(toDisplayWeight(wkChange)).toFixed(2)} ${weightUnit()} a week`;
  const goalDate = r.projected?.goal_date;
  const goalTxt = c.goals.lose && goalDate && goalDate.getFullYear() < new Date().getFullYear() + 5
    ? goalDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (c.goals.lose ? 'not at this pace' : '');
  const basis = r.basis === 'lose' ? 'to reach your weight goal' : r.basis === 'performance' ? 'to follow your training plan' : '';

  const b = c.base;
  const baseLine = `<p class="base-line">Your body uses about <strong>${num(b.base)} kcal</strong> a day before any workout: ${num(b.bmr)} resting${b.source === 'watch' ? ' (from your Apple Watch)' : b.source === 'observed' ? ' + your logged intake' : ''} + ${num(b.neat)} everyday movement.</p>`;

  return `
  <section class="act-card plan-results-card" aria-labelledby="pt-h">
    <div class="card-head">
      <h2 id="pt-h" class="act-card-title">Your exercise targets</h2>
      <div class="seg" role="tablist" aria-label="Period">
        ${['day', 'week', 'month'].map(p => `<button type="button" role="tab" aria-selected="${period === p}" data-period="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
      </div>
    </div>
    <p class="hero-line">${t.kcal > 0
      ? `Eating <strong>${num(c.scenario.kcal)} kcal</strong> a day, you need about <strong>${kcalTxt} kcal</strong> of exercise ${per} ${basis}.`
      : `At <strong>${num(c.scenario.kcal)} kcal</strong> a day no extra exercise is needed for your goal${c.goals.lose ? '' : ''}.`}</p>
    <div class="act-stats plan-tiles">
      ${tile('Active energy', `${kcalTxt}<small>kcal</small>`)}
      ${tile('Exercise time', t.minutes === null ? '—' : formatMovingTime(t.minutes * 60), t.minutes === null ? 'needs workouts with calories' : '')}
      ${tile('Sessions', sessions, t.sessions === null ? '' : `of ~${num(c.activity.avg_session_kcal)} kcal each`)}
      ${t.distance_m !== null ? tile('Distance', formatDistance(t.distance_m), 'at your usual mix') : ''}
      ${tile('Weight change', changeTxt)}
      ${c.goals.lose ? tile('Goal reached', goalTxt) : ''}
    </div>
    ${baseLine}
    ${r.intake_allowance ? `<p class="base-line">Doing this exercise, you could eat up to <strong>${num(r.intake_allowance)} kcal</strong> a day and still stay on pace.</p>` : ''}
    ${progressHtml(c)}
  </section>`;
}

function progressHtml(c) {
  const r = c.result;
  const weeklyTarget = r.targets.week;
  if (!(weeklyTarget.kcal > 0)) return '';
  const start = weekStartKey(dayKey(c.anchor));
  const from = keyToDate(start).getTime();
  const done = c.workouts.filter(a => a.date.getTime() >= from && a.date <= c.anchor);
  const kcal = done.reduce((s, a) => s + (a.calories_kcal || 0), 0);
  const mins = done.reduce((s, a) => s + (a.moving_s || a.duration_s || 0) / 60, 0);
  const pct = Math.min(1.5, kcal / weeklyTarget.kcal);
  const stale = Math.abs(Date.now() - c.anchor) > 3 * 864e5;
  return `
  <div class="week-progress">
    <div class="wp-head"><span>${stale ? `Week of ${keyToDate(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (latest in your data)` : 'This week so far'}</span>
      <strong>${num(kcal)} of ${num(weeklyTarget.kcal)} kcal · ${formatMovingTime(mins * 60)}</strong></div>
    <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${num(weeklyTarget.kcal)}" aria-valuenow="${num(kcal)}"><span style="width:${Math.round(Math.min(1, pct) * 100)}%"></span></div>
  </div>`;
}

function warningsHtml(c) {
  const ws = c.result.warnings.filter(w => w.code !== 'perf_note');
  if (!ws.length) return '';
  return `<ul class="plan-warnings" aria-label="Notes about this plan">${ws.map(w => `<li class="${w.level}"><span aria-hidden="true">${w.level === 'error' ? '⛔' : w.level === 'warn' ? '⚠' : 'ℹ'}</span>${escapeHtml(w.text)}</li>`).join('')}</ul>`;
}

function performanceHtml(c) {
  const pp = c.result.performance;
  if (!pp) return '';
  const shown = pp.weeks.slice(0, 6).concat(pp.weeks.length > 6 ? [pp.weeks[pp.weeks.length - 2], pp.weeks[pp.weeks.length - 1]] : []);
  const seen = new Set();
  const rows = shown.filter(w => !seen.has(w.index) && seen.add(w.index));
  const label = (k) => ({ build: 'Build', cutback: 'Cut-back', taper: 'Taper', race: 'Race' }[k]);
  return `
  <section class="act-card" aria-labelledby="pp-h">
    <h2 id="pp-h" class="act-card-title">${escapeHtml(pp.event)} plan <span class="act-hint">${pp.weeks_to_event} weeks to go</span></h2>
    ${pp.predicted_time_s ? `<p class="base-line">From your best efforts, you&rsquo;re on track for about <strong>${formatClock(pp.predicted_time_s)}</strong>${pp.gap_s !== null ? (pp.gap_s > 0 ? `, ${formatClock(pp.gap_s)} slower than your target.` : `, ${formatClock(-pp.gap_s)} faster than your target.`) : '.'}</p>` : '<p class="muted-note">Add run timestamps and routes (or open Awards once) so predicted time can use your best efforts.</p>'}
    <div class="table-scroll"><table class="splits perf-table">
      <thead><tr><th scope="col">Week</th><th scope="col">Type</th><th scope="col">Distance</th><th scope="col">Long run</th><th scope="col">Runs</th></tr></thead>
      <tbody>${rows.map((w, i) => `${i > 0 && w.index - rows[i - 1].index > 1 ? '<tr class="gap"><td colspan="5">…</td></tr>' : ''}<tr class="${w.kind}"><th scope="row">${w.index}</th><td>${label(w.kind)}</td><td>${formatDistance(w.distance_m)}</td><td>${w.kind === 'race' ? '—' : formatDistance(w.long_run_m)}</td><td>${w.sessions}</td></tr>`).join('')}</tbody>
    </table></div>
    ${pp.notes.length ? `<ul class="plan-warnings">${pp.notes.map(n => `<li class="info"><span aria-hidden="true">ℹ</span>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function compareHtml(c) {
  if (c.compare.length < 2 || !c.result.base) return '';
  const rows = c.compare.map(({ scenario: s, plan }) => {
    const t = plan.targets.week;
    const wk = plan.projected ? plan.projected.kg_per_week : 0;
    return `<tr class="${s.id === c.scenario.id ? 'active' : ''}">
      <th scope="row">${escapeHtml(s.name)}</th>
      <td>${num(s.kcal)}</td>
      <td>${num(plan.exercise_kcal_day)}</td>
      <td>${t.minutes === null ? '—' : formatMovingTime(t.minutes * 60)}</td>
      <td>${Math.abs(wk) < 0.005 ? '≈ 0' : (wk < 0 ? '−' : '+') + Math.abs(toDisplayWeight(wk)).toFixed(2)} ${weightUnit()}</td>
      ${c.goals.lose ? `<td>${plan.projected?.goal_date ? plan.projected.goal_date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</td>` : ''}
    </tr>`;
  }).join('');
  return `
  <section class="act-card" aria-labelledby="cmp-h">
    <h2 id="cmp-h" class="act-card-title">Compare what you eat</h2>
    <div class="table-scroll"><table class="splits cmp-table">
      <thead><tr><th scope="col">Scenario</th><th scope="col">kcal/day</th><th scope="col">Exercise kcal/day</th><th scope="col">Exercise time/week</th><th scope="col">Weight/week</th>${c.goals.lose ? '<th scope="col">Goal</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function observedHtml(c) {
  const o = c.observed;
  if (!o) return '';
  const est = c.base ? c.base.base + c.activity.weekly_kcal / 7 : null;
  return `
  <section class="act-card" aria-labelledby="obs-h">
    <h2 id="obs-h" class="act-card-title">Calibrated from your own data</h2>
    <p class="base-line">Over ${o.days} days you logged ${o.logged_days} and your smoothed weight moved ${o.change_kg >= 0 ? '+' : '−'}${Math.abs(toDisplayWeight(o.change_kg)).toFixed(1)} ${weightUnit()}. That implies you burn about <strong>${num(o.tdee)} kcal</strong> a day in total${est ? ` (the formula estimate is ${num(est)})` : ''}. <em>${o.confidence} confidence.</em></p>
    <label class="check"><input type="checkbox" id="use-observed" ${state.plan.profile.useObserved ? 'checked' : ''}> Use this instead of the estimate</label>
  </section>`;
}

function chartCard() {
  return `<section class="act-card" aria-labelledby="wt-h"><h2 id="wt-h" class="act-card-title">Weight trend</h2><div id="weight-chart" class="weight-chart"></div></section>`;
}

function drawChart(c) {
  const el = document.getElementById('weight-chart');
  if (!el) return;
  const g = c.goals.lose;
  let projection = null;
  if (c.trend.length && c.result.projected && c.weight_kg) {
    // The projection starts *today* from the current smoothed weight (not from the last
    // weigh-in, which may be months old) and runs to the goal date, or 12 weeks.
    const slope = c.result.projected.kg_per_week;
    const gd = c.result.projected.goal_date;
    const today = new Date();
    const endDate = gd && g && gd.getTime() - today.getTime() < 3 * 365 * 864e5 ? gd : new Date(today.getTime() + 12 * 7 * 864e5);
    const weeks = Math.max(0, (endDate - today) / (7 * 864e5));
    if (Math.abs(slope) > 0.001 && weeks > 0) {
      const kg = Math.max(30, c.weight_kg + slope * weeks);
      projection = { from: { date: dayKey(today), kg: c.weight_kg }, to: { date: dayKey(endDate), kg } };
    }
  }
  renderWeightChart(el, { points: c.trend, target: g ? { kg: g.target_kg } : null, projection, toDisplay: toDisplayWeight, unitLabel: weightUnit() });
}

function resultsHtml(c) {
  return warningsHtml(c) + targetsHtml(c) + performanceHtml(c) + compareHtml(c) + observedHtml(c) + chartCard();
}

// ── Rendering + wiring ──────────────────────────────────────────────────────

function macroNote(c) {
  const el = document.getElementById('s-macro-note');
  if (!el) return;
  const m = macroSummary(c.scenario, c.weight_kg || 0);
  if (!m.kcal_from_macros) { el.textContent = 'Add grams of protein, carbs and fat to check them against your calories.'; return; }
  const pct = m.pct;
  const diff = Math.round(m.mismatch_kcal);
  el.textContent = `Macros add up to ${num(m.kcal_from_macros)} kcal (${Math.round(pct.protein * 100)}% protein · ${Math.round(pct.carbs * 100)}% carbs · ${Math.round(pct.fat * 100)}% fat)${m.protein_g_per_kg ? ` · ${m.protein_g_per_kg.toFixed(1)} g protein per kg` : ''}${Math.abs(diff) > 75 ? `, ${Math.abs(diff)} kcal ${diff > 0 ? 'over' : 'under'} your calorie target.` : '.'}`;
}

/** Recompute and redraw just the results (cheap; runs on every keystroke / slider tick). */
function updateResults() {
  const root = document.getElementById('plan-results');
  if (!root) return;
  const c = compute();
  root.innerHTML = resultsHtml(c);
  drawChart(c);
  macroNote(c);
}

const save = (...keys) => persistPlan(state.plan, ...keys);

function renderAll() {
  const root = document.getElementById('view-plan');
  if (!root) return;
  const c = compute();
  root.innerHTML = `
  <div class="view-shell plan-shell">
    <header class="view-head">
      <h1 class="view-title">Plan</h1>
      <p class="view-sub">Tell it about you, your goals and what you eat. It works out the exercise that adds up, using your own workout history.</p>
    </header>
    <p class="plan-disclaimer">${icon('lock', { size: 16 })}<span>Everything here stays on this device. These are planning estimates, not medical advice: talk to a professional before making big changes to how you eat or train.</span></p>
    <div class="plan-grid">
      <div class="plan-inputs">${inputsHtml(c)}</div>
      <div class="plan-results" id="plan-results">${resultsHtml(c)}</div>
    </div>
  </div>`;
  drawChart(c);
  macroNote(c);
  wire(root);
  loadEfforts(() => { if (document.getElementById('view-plan')?.classList.contains('active')) updateResults(); });

  if (resizeObs) resizeObs.disconnect();
  if ('ResizeObserver' in window) {
    let last = root.clientWidth;
    resizeObs = new ResizeObserver(debounce(() => { if (root.clientWidth !== last) { last = root.clientWidth; updateResults(); } }, 150));
    resizeObs.observe(root);
  }
}

export function renderPlan() { renderAll(); }

function activeScenario() { return state.plan.scenarios.find(s => s.id === state.plan.activeScenario) || ensureScenario(); }
const val = (id) => document.getElementById(id)?.value;
const numVal = (id) => { const v = parseFloat(val(id)); return Number.isFinite(v) ? v : null; };

function wire(root) {
  const plan = state.plan;
  const inputs = root.querySelector('.plan-inputs');
  const results = root.querySelector('#plan-results');

  // Results tabs + calibration toggle
  results.addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]');
    if (p) { period = p.dataset.period; updateResults(); }
  });
  results.addEventListener('change', (e) => {
    if (e.target.id === 'use-observed') { plan.profile.useObserved = e.target.checked; save('profile'); updateResults(); }
  });

  // ── Profile ──
  const profileChange = () => {
    plan.profile.sex = val('p-sex') || null;
    plan.profile.birth_year = numVal('p-birth');
    plan.profile.baseline = val('p-baseline') || 'sedentary';
    if (document.getElementById('p-bmr')) plan.profile.bmrSource = val('p-bmr') || 'watch';
    if (imperial()) {
      const ft = numVal('p-height-ft'), inch = numVal('p-height-in') || 0;
      plan.profile.height_cm = ft ? Math.round((ft * 12 + inch) * 2.54 * 10) / 10 : null;
    } else plan.profile.height_cm = numVal('p-height-cm');
    save('profile'); updateResults();
  };
  for (const id of ['p-sex', 'p-birth', 'p-baseline', 'p-bmr', 'p-height-cm', 'p-height-ft', 'p-height-in']) document.getElementById(id)?.addEventListener('input', profileChange);

  // ── Weights ──
  document.getElementById('w-add')?.addEventListener('click', () => {
    const v = numVal('w-val'), d = val('w-date');
    if (!v || v <= 0 || !d) { showToast('Enter a date and a weight.', { error: true }); return; }
    const kg = Math.round(fromDisplayWeight(v) * 100) / 100;
    plan.weights = plan.weights.filter(w => w.date !== d).concat([{ date: d, kg, source: 'manual' }]);
    save('weights'); renderAll();
  });
  inputs.addEventListener('click', (e) => {
    const dw = e.target.closest('[data-del-weight]');
    if (dw) {
      const [date, kg] = dw.dataset.delWeight.split('|');
      plan.weights = plan.weights.filter(w => !(w.date === date && String(w.kg) === kg));
      save('weights'); renderAll();
    }
    const df = e.target.closest('[data-del-food]');
    if (df) { plan.foodlog = plan.foodlog.filter(f => f.date !== df.dataset.delFood); save('foodlog'); renderAll(); }
  });

  // ── Apple import ──
  document.getElementById('btn-import-apple')?.addEventListener('click', () => {
    const h = state.health; if (!h) return;
    const found = [];
    if (h.me?.sex && !plan.profile.sex) { plan.profile.sex = h.me.sex; found.push('sex'); }
    if (h.me?.birth_year && !plan.profile.birth_year) { plan.profile.birth_year = h.me.birth_year; found.push('birth year'); }
    if (h.height_cm && !plan.profile.height_cm) { plan.profile.height_cm = h.height_cm; found.push('height'); }
    const have = new Set(plan.weights.map(w => w.date));
    const add = (h.weights || []).filter(w => !have.has(w.date)).map(w => ({ date: w.date, kg: w.kg, source: 'apple' }));
    if (add.length) { plan.weights = plan.weights.concat(add); found.push(`${add.length} weigh-in${add.length === 1 ? '' : 's'}`); }
    save('profile', 'weights');
    showToast(found.length ? `Filled in ${found.join(', ')} from Apple Health.` : 'Nothing new to import; your plan already has those details.');
    renderAll();
  });

  // ── Goals ──
  document.getElementById('g-lose-on')?.addEventListener('change', (e) => {
    plan.goals.lose = e.target.checked ? { target_kg: null, target_date: null, rate_kg_week: null } : null;
    if (plan.goals.lose) {
      const w = compute().weight_kg;
      plan.goals.lose.target_kg = w ? Math.round((w - 5) * 10) / 10 : null;
      plan.goals.lose.target_date = dayKey(new Date(Date.now() + 16 * 7 * 864e5));
    }
    save('goals'); renderAll();
  });
  const loseChange = () => {
    const l = plan.goals.lose; if (!l) return;
    const t = numVal('g-lose-target'); l.target_kg = t ? Math.round(fromDisplayWeight(t) * 100) / 100 : null;
    if (document.getElementById('g-lose-date')) { l.target_date = val('g-lose-date') || null; l.rate_kg_week = null; }
    if (document.getElementById('g-lose-rate')) { const r = numVal('g-lose-rate'); l.rate_kg_week = r ? fromDisplayWeight(r) : null; l.target_date = null; }
    save('goals'); updateResults();
  };
  for (const id of ['g-lose-target', 'g-lose-date', 'g-lose-rate']) document.getElementById(id)?.addEventListener('input', loseChange);
  inputs.addEventListener('click', (e) => {
    const m = e.target.closest('[data-lose-mode]');
    if (!m || !plan.goals.lose) return;
    const l = plan.goals.lose;
    if (m.dataset.loseMode === 'rate') { l.rate_kg_week = l.rate_kg_week || 0.45; l.target_date = null; }
    else { l.target_date = l.target_date || dayKey(new Date(Date.now() + 16 * 7 * 864e5)); l.rate_kg_week = null; }
    save('goals'); renderAll();
  });
  document.getElementById('g-perf-on')?.addEventListener('change', (e) => {
    plan.goals.performance = e.target.checked ? { event: '10k', date: dayKey(new Date(Date.now() + 12 * 7 * 864e5)), target_time_s: null } : null;
    save('goals'); renderAll();
  });
  const perfChange = () => {
    const p = plan.goals.performance; if (!p) return;
    p.event = val('g-perf-event') || '10k'; p.date = val('g-perf-date') || p.date; p.target_time_s = parseClock(val('g-perf-time'));
    save('goals'); updateResults();
  };
  for (const id of ['g-perf-event', 'g-perf-date', 'g-perf-time']) document.getElementById(id)?.addEventListener('input', perfChange);

  // ── Scenarios ──
  inputs.addEventListener('click', (e) => {
    const s = e.target.closest('[data-scn]');
    if (s) { plan.activeScenario = s.dataset.scn; save('activeScenario'); renderAll(); }
  });
  document.getElementById('scn-new')?.addEventListener('click', () => {
    const cur = activeScenario();
    const sc = { id: newId(), name: `Plan ${plan.scenarios.length + 1}`, kcal: Math.max(1200, cur.kcal - 200), protein_g: cur.protein_g, carbs_g: cur.carbs_g, fat_g: cur.fat_g };
    plan.scenarios.push(sc); plan.activeScenario = sc.id; save('scenarios', 'activeScenario'); renderAll();
  });
  document.getElementById('scn-dup')?.addEventListener('click', () => {
    const cur = activeScenario();
    const sc = { ...cur, id: newId(), name: `${cur.name} copy` };
    plan.scenarios.push(sc); plan.activeScenario = sc.id; save('scenarios', 'activeScenario'); renderAll();
  });
  document.getElementById('scn-del')?.addEventListener('click', () => {
    plan.scenarios = plan.scenarios.filter(s => s.id !== plan.activeScenario);
    plan.activeScenario = plan.scenarios[0]?.id || null; save('scenarios', 'activeScenario'); renderAll();
  });
  document.getElementById('scn-split')?.addEventListener('click', () => {
    const s = activeScenario();
    s.protein_g = Math.round((s.kcal * 0.3) / 4); s.carbs_g = Math.round((s.kcal * 0.4) / 4); s.fat_g = Math.round((s.kcal * 0.3) / 9);
    save('scenarios'); renderAll();
  });
  const setKcal = (v) => { const s = activeScenario(); s.kcal = v; save('scenarios'); };
  document.getElementById('s-kcal')?.addEventListener('input', (e) => {
    const v = +e.target.value; setKcal(v);
    const n = document.getElementById('s-kcal-num'); if (n) n.value = v;
    updateResults();
  });
  document.getElementById('s-kcal-num')?.addEventListener('input', (e) => {
    const v = +e.target.value; if (!(v >= 600)) return;
    setKcal(v);
    const r = document.getElementById('s-kcal'); if (r) r.value = Math.min(4500, Math.max(1000, v));
    updateResults();
  });
  document.getElementById('s-name')?.addEventListener('input', (e) => {
    activeScenario().name = e.target.value.slice(0, 40) || 'Plan'; save('scenarios');
    updateResults();
    const chip = inputs.querySelector(`[data-scn="${plan.activeScenario}"]`); if (chip) chip.textContent = activeScenario().name;
  });
  for (const [id, key] of [['s-protein', 'protein_g'], ['s-carbs', 'carbs_g'], ['s-fat', 'fat_g']]) {
    document.getElementById(id)?.addEventListener('input', (e) => { const v = parseFloat(e.target.value); activeScenario()[key] = Number.isFinite(v) ? v : null; save('scenarios'); updateResults(); });
  }

  // ── Food log ──
  document.getElementById('fl-add')?.addEventListener('click', () => {
    const d = val('fl-date'), k = numVal('fl-kcal');
    if (!d || !k || k <= 0) { showToast('Enter a date and calories.', { error: true }); return; }
    plan.foodlog = plan.foodlog.filter(f => f.date !== d).concat([{ date: d, kcal: Math.round(k), protein: numVal('fl-protein') || 0, carbs: 0, fat: 0 }]);
    save('foodlog'); renderAll();
  });
  document.getElementById('fl-csv')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const { rows, skipped } = parseFoodCsv(await f.text());
    if (!rows.length) { showToast('No usable rows found. The CSV needs a date column and a calories column.', { error: true }); return; }
    const byDate = new Map(plan.foodlog.map(x => [x.date, x]));
    rows.forEach(r => byDate.set(r.date, r));
    plan.foodlog = [...byDate.values()]; save('foodlog');
    showToast(`Imported ${rows.length} day${rows.length === 1 ? '' : 's'}${skipped ? ` (${skipped} rows skipped)` : ''}.`);
    renderAll();
  });
  document.getElementById('fl-apple')?.addEventListener('click', () => {
    const byDate = new Map(plan.foodlog.map(x => [x.date, x]));
    for (const [date, v] of Object.entries(state.health?.dietary_by_day || {})) if (!byDate.has(date)) byDate.set(date, { date, ...v });
    plan.foodlog = [...byDate.values()]; save('foodlog'); renderAll();
  });
  document.getElementById('scn-from-log')?.addEventListener('click', () => {
    const recent = [...plan.foodlog].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
    if (!recent.length) return;
    const s = activeScenario(), n = recent.length;
    s.kcal = round(recent.reduce((a, e) => a + e.kcal, 0) / n, 25);
    const prot = recent.filter(e => e.protein > 0);
    if (prot.length) s.protein_g = Math.round(prot.reduce((a, e) => a + e.protein, 0) / prot.length);
    save('scenarios'); showToast(`Set to your ${n}-day average: ${num(s.kcal)} kcal.`); renderAll();
  });

  // ── Export / import ──
  document.getElementById('plan-export')?.addEventListener('click', () => {
    const blob = new Blob([exportPlanJson(plan)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'fitness-plan.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  document.getElementById('plan-import')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      state.plan = importPlanJson(await f.text());
      save('profile', 'goals', 'scenarios', 'activeScenario', 'weights', 'foodlog');
      showToast('Plan imported.');
      renderAll();
    } catch (err) { showToast(err.message, { error: true }); }
  });
}
