/**
 * analysis/health/nutrition.js
 * Energy balance and goal planning. Pure: no DOM, no storage. Units are kg, cm,
 * kcal, metres and seconds throughout; the UI converts for display.
 *
 * The model, in one line:
 *     balance/day = intake - (base burn + exercise)         base burn = BMR + non-exercise activity
 *     weight change per week = balance x 7 / KCAL_PER_KG
 *
 * It answers two questions in both directions:
 *   "I eat X and want to hit goal G: how much exercise do I need?"      (planTargets)
 *   "I'll do Y exercise and want goal G: how much can I eat?"           (intakeAllowance)
 *
 * KCAL_PER_KG (7,700; 3,500 per lb) is the standard rule of thumb. It is an
 * approximation (bodies adapt), so the UI labels projections as estimates, and
 * observedExpenditure() can replace the guess with the user's own numbers once
 * they have a few weeks of food and weight data.
 *
 * Guardrails are part of the model, not decoration: no deficit plans under 18,
 * loss rates are capped at ~1% of bodyweight per week, and a scenario below a
 * minimum intake is flagged. This is planning arithmetic, not medical advice.
 */

import { addDays, daysBetween, dayKey } from '../dates.js';

export const KCAL_PER_KG = 7700;
export const KCAL_PER_LB = 3500;
export const DAYS_PER_MONTH = 30.4375;

/** Minimum daily intake we will recommend; below it a scenario is flagged. */
export const INTAKE_FLOOR = { female: 1200, male: 1500, other: 1350 };
/** Loss-rate guardrails as a fraction of bodyweight per week. */
export const RATE_AGGRESSIVE = 0.0075;
export const RATE_MAX = 0.01;

/** Non-exercise activity multipliers on BMR (exercise is added separately). */
export const BASELINE_FACTOR = { sedentary: 1.2, light: 1.3, active: 1.45 };

// ── Basics ──────────────────────────────────────────────────────────────────

export function ageFromBirthYear(birthYear, now = new Date()) {
  return birthYear ? now.getFullYear() - birthYear : null;
}

/** Mifflin-St Jeor resting energy expenditure, kcal/day. sex: 'male' | 'female' | 'other'. */
export function mifflinBmr({ sex, weight_kg, height_cm, age }) {
  if (!(weight_kg > 0) || !(height_cm > 0) || !(age > 0)) return null;
  const base = 10 * weight_kg + 6.25 * height_cm - 5 * age;
  if (sex === 'male') return base + 5;
  if (sex === 'female') return base - 161;
  return base - 78; // midpoint of the two constants for people who prefer not to say
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs, f = x => x) => xs.reduce((a, x) => a + f(x), 0);
const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

// ── Weight trend ────────────────────────────────────────────────────────────

/**
 * Smooth weigh-ins with a *time-aware* exponential moving average, so a salty dinner
 * doesn't read as a gain, but a reading after a long gap is trusted almost fully.
 * Each reading moves the trend by 1 - exp(-days since the previous reading / tau), so
 * daily weigh-ins are smoothed (tau = 7 days) while a weigh-in six weeks after the last
 * one replaces the old trend (an entry-count EMA lagged badly here: four weigh-ins
 * months apart left the "current weight" 20 lb below the latest reading).
 * weights: [{date:'YYYY-MM-DD', kg}] -> same + trend.
 */
export function ewmaTrend(weights, tauDays = 7) {
  const sorted = [...(weights || [])].filter(w => w.kg > 0).sort((x, y) => (x.date < y.date ? -1 : 1));
  let t = null, prev = null;
  return sorted.map((w) => {
    if (t === null) t = w.kg;
    else {
      const gap = Math.max(1, daysBetween(prev, w.date));
      t += (1 - Math.exp(-gap / tauDays)) * (w.kg - t);
    }
    prev = w.date;
    return { ...w, trend: t };
  });
}

/** Latest smoothed weight (falls back to the latest raw value). */
export function currentWeight(weights) {
  const tr = ewmaTrend(weights);
  return tr.length ? tr[tr.length - 1].trend : null;
}

// ── Base burn ───────────────────────────────────────────────────────────────

/**
 * What the body burns on a day with no workout: BMR + everyday movement.
 *
 * With Apple Health data we use the user's *own* numbers over the last `weeks`:
 *   BMR   = median daily basal energy (the watch's estimate)   [or the formula, if chosen]
 *   NEAT  = median of (daily active energy - that day's logged workout kcal)
 * Without it: BMR from the formula x a baseline factor (BASELINE_FACTOR).
 *
 * @param {object} o
 * @param {{sex, birth_year, height_cm, baseline}} o.profile
 * @param {number} o.weight_kg
 * @param {{[date:string]: number}} [o.basal_by_day]    kcal per day (Apple basal)
 * @param {{[date:string]: number}} [o.active_by_day]   kcal per day (Apple Move ring)
 * @param {object[]} [o.workouts]  activities (for kcal and date)
 * @param {'watch'|'formula'} [o.bmrSource]
 * @returns {{bmr:number, neat:number, base:number, source:'watch'|'formula', bmr_formula:number|null,
 *            bmr_watch:number|null, days_used:number}|null}
 */
export function baseBurn({ profile, weight_kg, basal_by_day, active_by_day, workouts = [], now = new Date(), weeks = 8, bmrSource = 'watch' }) {
  const age = ageFromBirthYear(profile?.birth_year, now);
  const bmr_formula = mifflinBmr({ sex: profile?.sex, weight_kg, height_cm: profile?.height_cm, age });
  const from = dayKey(new Date(now.getTime() - weeks * 7 * 864e5));
  const to = dayKey(now);

  const basalDays = Object.entries(basal_by_day || {}).filter(([d, v]) => d >= from && d <= to && v > 0);
  const bmr_watch = basalDays.length >= 7 ? median(basalDays.map(([, v]) => v)) : null;
  const useWatch = bmrSource === 'watch' && bmr_watch !== null;
  const bmr = useWatch ? bmr_watch : bmr_formula;
  if (bmr === null || bmr === undefined) return null;

  // Workout kcal by day, to subtract from the day's active energy.
  const workoutKcal = {};
  for (const a of workouts) {
    if (a.merged_into || !a.date || !(a.calories_kcal > 0)) continue;
    const k = dayKey(a.date);
    workoutKcal[k] = (workoutKcal[k] || 0) + a.calories_kcal;
  }
  const neatDays = Object.entries(active_by_day || {})
    .filter(([d, v]) => d >= from && d <= to && v > 0)
    .map(([d, v]) => Math.max(0, v - (workoutKcal[d] || 0)));
  const haveNeat = neatDays.length >= 7;
  const neat = haveNeat
    ? median(neatDays)
    : bmr * ((BASELINE_FACTOR[profile?.baseline] || BASELINE_FACTOR.sedentary) - 1);

  return {
    bmr, neat, base: bmr + neat,
    source: useWatch && haveNeat ? 'watch' : 'formula',
    bmr_formula, bmr_watch, days_used: neatDays.length,
  };
}

/**
 * Back-solve true expenditure from what was actually eaten and how weight actually moved:
 *   TDEE = average intake - (change in smoothed weight x 7700 / days).
 * Needs >= 21 days of span with >= 14 logged days and >= 2 weigh-ins; otherwise null.
 * @returns {{tdee:number, avg_intake:number, days:number, logged_days:number, change_kg:number, confidence:'low'|'medium'|'high'}|null}
 */
export function observedExpenditure({ foodlog, weights, now = new Date(), windowDays = 60 }) {
  const from = dayKey(new Date(now.getTime() - windowDays * 864e5));
  const log = (foodlog || []).filter(e => e.date >= from && e.kcal > 0);
  const tr = ewmaTrend((weights || []).filter(w => w.date >= from));
  if (log.length < 14 || tr.length < 2) return null;
  const first = log.reduce((m, e) => (e.date < m ? e.date : m), log[0].date);
  const last = log.reduce((m, e) => (e.date > m ? e.date : m), log[0].date);
  const days = daysBetween(first, last) + 1;
  if (days < 21) return null;
  const inSpan = tr.filter(w => w.date >= first && w.date <= last);
  if (inSpan.length < 2) return null;
  const span = daysBetween(inSpan[0].date, inSpan[inSpan.length - 1].date);
  if (span < 14) return null;
  const change_kg = inSpan[inSpan.length - 1].trend - inSpan[0].trend;
  const avg_intake = sum(log, e => e.kcal) / log.length;
  const tdee = avg_intake - (change_kg * KCAL_PER_KG) / span;
  const coverage = log.length / days;
  return {
    tdee, avg_intake, days, logged_days: log.length, change_kg,
    confidence: days >= 42 && coverage >= 0.8 ? 'high' : days >= 28 && coverage >= 0.6 ? 'medium' : 'low',
  };
}

// ── Your own exercise economics ─────────────────────────────────────────────

/**
 * What a unit of exercise costs *this* person, from their recent workouts.
 * Only workouts with calories contribute to kcal rates.
 *
 * @returns {{
 *   weeks:number, weekly_kcal:number, weekly_minutes:number, weekly_sessions:number,
 *   avg_session_kcal:number, avg_session_minutes:number, kcal_per_min:number|null,
 *   by_type:{[type:string]:{kcal:number, minutes:number, distance_m:number, share:number,
 *                           kcal_per_min:number|null, kcal_per_m:number|null, sessions:number}},
 *   weekly_distance_m:{[type:string]:number}
 * }}
 */
export function activityProfile(activities, { now = new Date(), days = 90 } = {}) {
  const from = now.getTime() - days * 864e5;
  const acts = (activities || []).filter(a => !a.merged_into && a.date && toMs(a.date) >= from && toMs(a.date) <= now.getTime());
  const weeks = days / 7;
  const by_type = {};
  let kcal = 0, minutes = 0;
  for (const a of acts) {
    const mins = (a.moving_s || a.duration_s || 0) / 60;
    const t = by_type[a.type] || (by_type[a.type] = { kcal: 0, minutes: 0, distance_m: 0, share: 0, kcal_per_min: null, kcal_per_m: null, sessions: 0, _kk: 0, _km: 0, _kd: 0, _dm: 0 });
    t.sessions++; t.minutes += mins; t.distance_m += a.distance_m || 0;
    if (a.calories_kcal > 0) {
      t.kcal += a.calories_kcal; t._kk += a.calories_kcal; t._km += mins;
      if (a.distance_m > 200) { t._kd += a.calories_kcal; t._dm += a.distance_m; }
    }
    if (a.calories_kcal > 0) { kcal += a.calories_kcal; minutes += mins; }
  }
  for (const t of Object.values(by_type)) {
    t.kcal_per_min = t._km > 0 ? t._kk / t._km : null;
    t.kcal_per_m = t._dm > 0 ? t._kd / t._dm : null;
    t.share = kcal > 0 ? t.kcal / kcal : 0;
    delete t._kk; delete t._km; delete t._kd; delete t._dm;
  }
  const withKcal = acts.filter(a => a.calories_kcal > 0);
  const weekly_distance_m = {};
  for (const [type, t] of Object.entries(by_type)) weekly_distance_m[type] = t.distance_m / weeks;
  return {
    weeks, weekly_kcal: kcal / weeks, weekly_minutes: minutes / weeks, weekly_sessions: acts.length / weeks,
    avg_session_kcal: withKcal.length ? kcal / withKcal.length : 0,
    avg_session_minutes: withKcal.length ? minutes / withKcal.length : 0,
    kcal_per_min: minutes > 0 ? kcal / minutes : null,
    by_type, weekly_distance_m,
  };
}

/**
 * Turn "burn E kcal a day" into things a person can do: minutes, sessions, distance,
 * using their own kcal-per-minute and kcal-per-metre by activity type and their recent mix.
 *
 * @returns {{day, week, month: {kcal:number, minutes:number|null, sessions:number|null, distance_m:number|null}}}
 */
export function exerciseTargets(exercise_kcal_day, profile) {
  const per = (days) => {
    const kcal = Math.max(0, exercise_kcal_day) * days;
    const minutes = profile?.kcal_per_min ? kcal / profile.kcal_per_min : null;
    const sessions = profile?.avg_session_kcal ? kcal / profile.avg_session_kcal : null;
    let distance_m = null;
    if (profile?.by_type) {
      let d = 0, any = false;
      for (const t of Object.values(profile.by_type)) {
        if (t.kcal_per_m && t.share > 0) { d += (kcal * t.share) / t.kcal_per_m; any = true; }
      }
      distance_m = any ? d : null;
    }
    return { kcal, minutes, sessions, distance_m };
  };
  return { day: per(1), week: per(7), month: per(DAYS_PER_MONTH) };
}

// ── Weight-loss goal ────────────────────────────────────────────────────────

/** Projected weight after `days` at a constant daily balance (kcal, negative = loss). */
export function projectWeight(weight_kg, balance_per_day, days) {
  return weight_kg + (balance_per_day * days) / KCAL_PER_KG;
}

/** Date the target is reached at a constant daily balance, or null if it never is. */
export function projectedGoalDate(weight_kg, target_kg, balance_per_day, from = new Date()) {
  const need = (target_kg - weight_kg) * KCAL_PER_KG;       // kcal still to move (negative = lose)
  if (need === 0) return from;
  if (balance_per_day === 0 || Math.sign(need) !== Math.sign(balance_per_day)) return null;
  return new Date(from.getTime() + (need / balance_per_day) * 864e5);
}

/**
 * Weight-loss maths for one goal.
 * goal: {type:'lose', target_kg, target_date?:'YYYY-MM-DD', rate_kg_week?}
 *
 * @returns {{
 *   blocked: null|'under_18'|'no_weight'|'already_there',
 *   requested_rate: number, rate_kg_week: number, pct_bw: number,
 *   status: 'ok'|'aggressive'|'unsafe', capped: boolean,
 *   required_balance: number, weeks_needed: number, achievable_date: Date|null
 * }}
 */
export function losePlan({ goal, weight_kg, age, now = new Date() }) {
  const out = { blocked: null, requested_rate: 0, rate_kg_week: 0, pct_bw: 0, status: 'ok', capped: false, required_balance: 0, weeks_needed: 0, achievable_date: null };
  if (!(weight_kg > 0) || !(goal?.target_kg > 0)) { out.blocked = 'no_weight'; return out; }
  if (age !== null && age !== undefined && age < 18) { out.blocked = 'under_18'; return out; }
  const to_lose = weight_kg - goal.target_kg;
  if (to_lose <= 0) { out.blocked = 'already_there'; return out; }

  let requested;
  if (goal.target_date) {
    const days = Math.max(1, (new Date(goal.target_date + 'T12:00:00').getTime() - now.getTime()) / 864e5);
    requested = to_lose / (days / 7);
  } else {
    requested = goal.rate_kg_week > 0 ? goal.rate_kg_week : 0.5;
  }
  const maxRate = weight_kg * RATE_MAX;
  const rate = Math.min(requested, maxRate);
  out.requested_rate = requested;
  out.rate_kg_week = rate;
  out.pct_bw = rate / weight_kg;
  out.capped = requested > maxRate + 1e-9;
  out.status = requested > maxRate + 1e-9 ? 'unsafe' : requested > weight_kg * RATE_AGGRESSIVE ? 'aggressive' : 'ok';
  out.required_balance = -(rate * KCAL_PER_KG) / 7;
  out.weeks_needed = to_lose / rate;
  out.achievable_date = new Date(now.getTime() + out.weeks_needed * 7 * 864e5);
  return out;
}

/**
 * Macro readout for a scenario: protein per kg and the calories the macros add up to.
 * scenario: {kcal, protein_g, carbs_g, fat_g}
 */
export function macroSummary(scenario, weight_kg) {
  const p = scenario?.protein_g || 0, c = scenario?.carbs_g || 0, f = scenario?.fat_g || 0;
  const kcal_from_macros = p * 4 + c * 4 + f * 9;
  return {
    protein_g_per_kg: weight_kg > 0 ? p / weight_kg : null,
    kcal_from_macros,
    mismatch_kcal: scenario?.kcal ? kcal_from_macros - scenario.kcal : 0,
    pct: kcal_from_macros > 0 ? { protein: (p * 4) / kcal_from_macros, carbs: (c * 4) / kcal_from_macros, fat: (f * 9) / kcal_from_macros } : null,
  };
}

// ── Performance goal ────────────────────────────────────────────────────────

export const EVENTS = {
  '5k':       { label: '5K',            distance_m: 5000,    peak_per_m: 5,    long_cap_m: 10000, taper_weeks: 1 },
  '10k':      { label: '10K',           distance_m: 10000,   peak_per_m: 3.5,  long_cap_m: 16000, taper_weeks: 1 },
  half:       { label: 'Half marathon', distance_m: 21097.5, peak_per_m: 2.4,  long_cap_m: 24000, taper_weeks: 2 },
  marathon:   { label: 'Marathon',      distance_m: 42195,   peak_per_m: 1.55, long_cap_m: 32000, taper_weeks: 2 },
};

/** Riegel race-time prediction: T2 = T1 x (D2/D1)^1.06. */
export function riegel(time_s, from_m, to_m) {
  return time_s * Math.pow(to_m / from_m, 1.06);
}

/**
 * A week-by-week running ramp to an event.
 *  - weekly distance grows at most 10%/week from what you currently run;
 *  - every 4th build week is a cut-back (80%);
 *  - the last 1-2 weeks taper (70% / 50%);
 *  - the long run is ~33% of the week, capped for the event;
 *  - if there isn't time to reach the usual peak, the plan says so instead of faking it.
 *
 * goal: {type:'performance', event:'5k'|'10k'|'half'|'marathon'|'custom', distance_m?, date:'YYYY-MM-DD', target_time_s?}
 * run: {weekly_m: current weekly running distance, best_efforts?: [{distance_m, time_s}], kcal_per_m?: number}
 *
 * @returns {{event, distance_m, weeks_to_event, peak_target_m, peak_reachable_m, reachable:boolean,
 *            weeks:[{index, week_start, distance_m, long_run_m, sessions, kind:'build'|'cutback'|'taper'|'race'}],
 *            predicted_time_s:number|null, gap_s:number|null, notes:string[]}}
 */
export function performancePlan({ goal, run, now = new Date(), weight_kg = 70 }) {
  const ev = EVENTS[goal.event] || { label: 'Event', distance_m: goal.distance_m || 10000, peak_per_m: 3.5, long_cap_m: 16000, taper_weeks: 1 };
  const distance_m = goal.distance_m || ev.distance_m;
  const eventDate = goal.date;
  const weeks_to_event = Math.max(0, Math.floor(daysBetween(dayKey(now), eventDate) / 7));
  const notes = [];

  const start = Math.max(run?.weekly_m || 0, 0);
  const startFloor = Math.max(start, Math.min(8000, distance_m)); // a plan can't start from zero
  const peak_target_m = distance_m * ev.peak_per_m;
  const taper = Math.min(ev.taper_weeks, Math.max(0, weeks_to_event - 1));
  const buildWeeks = Math.max(0, weeks_to_event - taper);

  const weeks = [];
  let vol = startFloor, builds = 0;
  for (let i = 0; i < buildWeeks; i++) {
    builds++;
    const cutback = builds % 4 === 0;
    if (!cutback) vol = Math.min(peak_target_m, vol * 1.1);
    const d = cutback ? vol * 0.8 : vol;
    weeks.push({ index: i + 1, distance_m: d, kind: cutback ? 'cutback' : 'build' });
  }
  const peak_reachable_m = weeks.length ? Math.max(...weeks.map(w => w.distance_m)) : startFloor;
  for (let t = 0; t < taper; t++) {
    const f = taper === 2 ? (t === 0 ? 0.7 : 0.5) : 0.65;
    weeks.push({ index: weeks.length + 1, distance_m: peak_reachable_m * f, kind: 'taper' });
  }
  weeks.forEach((w, i) => {
    const sessions = w.distance_m <= 20000 ? 3 : w.distance_m <= 40000 ? 4 : 5;
    w.sessions = sessions;
    w.long_run_m = Math.min(w.distance_m * 0.33, ev.long_cap_m);
    w.week_start = addDays(dayKey(now), i * 7);
    w.kcal = run?.kcal_per_m ? w.distance_m * run.kcal_per_m : w.distance_m / 1000 * 0.95 * weight_kg;
  });
  weeks.push({ index: weeks.length + 1, kind: 'race', distance_m, long_run_m: distance_m, sessions: 1, week_start: addDays(dayKey(now), weeks.length * 7), kcal: 0 });

  const reachable = peak_reachable_m >= peak_target_m * 0.9;
  if (weeks_to_event < 4) notes.push('Less than four weeks to go: focus on staying healthy and fresh rather than building volume.');
  else if (!reachable) notes.push(`There isn't time to reach the usual ${(peak_target_m / 1000).toFixed(0)} km peak week; this plan peaks at ${(peak_reachable_m / 1000).toFixed(0)} km. A later date would let it build safely.`);
  if (start < distance_m * 0.5) notes.push(`You currently run about ${(start / 1000).toFixed(0)} km a week, so the first weeks build a base before anything else.`);

  let predicted_time_s = null, gap_s = null;
  const eff = (run?.best_efforts || []).filter(e => e.distance_m >= 1000 && e.time_s > 0);
  if (eff.length) {
    // Riegel works best from a nearby distance: pick the effort closest to the event.
    const ref = eff.reduce((b, e) => (Math.abs(Math.log(e.distance_m / distance_m)) < Math.abs(Math.log(b.distance_m / distance_m)) ? e : b));
    predicted_time_s = riegel(ref.time_s, ref.distance_m, distance_m);
    if (goal.target_time_s) gap_s = predicted_time_s - goal.target_time_s;
  }
  return { event: ev.label, distance_m, weeks_to_event, peak_target_m, peak_reachable_m, reachable, weeks, predicted_time_s, gap_s, notes };
}

// ── Putting it together ─────────────────────────────────────────────────────

/**
 * One call for the UI: given who you are, what you eat and what you're aiming at, return
 * the exercise targets (daily / weekly / monthly), projections and every warning.
 *
 * @param {object} o
 * @param {{sex, birth_year, height_cm, baseline}} o.profile
 * @param {number} o.weight_kg           current (smoothed) weight
 * @param {{lose?: object, performance?: object}} o.goals
 * @param {{kcal:number, protein_g?:number, carbs_g?:number, fat_g?:number}} o.scenario
 * @param {object} o.base                result of baseBurn()
 * @param {object} o.activity            result of activityProfile()
 * @param {{weekly_m:number, best_efforts?:object[], kcal_per_m?:number}} [o.run]
 */
export function planTargets({ profile, weight_kg, goals = {}, scenario, base, activity, run, now = new Date() }) {
  const warnings = [];
  const age = ageFromBirthYear(profile?.birth_year, now);
  const intake = scenario?.kcal || 0;
  const out = {
    base, intake, lose: null, performance: null, exercise_kcal_day: 0,
    targets: exerciseTargets(0, activity), balance: null, projected: null, warnings,
    macros: macroSummary(scenario, weight_kg), intake_allowance: null, basis: null,
  };
  if (!base) { warnings.push({ level: 'info', code: 'need_profile', text: 'Add your height, birth year and weight to calculate targets.' }); return out; }

  // Intake guardrails
  const floor = INTAKE_FLOOR[profile?.sex] || INTAKE_FLOOR.other;
  if (intake > 0 && intake < floor) warnings.push({ level: 'error', code: 'below_floor', text: `${Math.round(intake)} kcal/day is below the ${floor} kcal minimum this planner will recommend.` });
  else if (intake > 0 && intake < base.bmr) warnings.push({ level: 'warn', code: 'below_bmr', text: 'Eating below your resting energy needs for long stretches is hard to sustain and not generally advised.' });

  // Weight-loss requirement
  let requiredEx = 0;
  if (goals.lose) {
    const lp = losePlan({ goal: goals.lose, weight_kg, age, now });
    out.lose = lp;
    if (lp.blocked === 'under_18') warnings.push({ level: 'error', code: 'under_18', text: 'This planner does not set weight-loss targets for anyone under 18.' });
    else if (!lp.blocked) {
      requiredEx = Math.max(0, intake - base.base - lp.required_balance);
      if (lp.status === 'unsafe') warnings.push({ level: 'error', code: 'rate_unsafe', text: `Reaching that goal by that date would need about ${(lp.requested_rate / weight_kg * 100).toFixed(1)}% of bodyweight a week. Targets are capped at ${(RATE_MAX * 100).toFixed(0)}%; the earliest sensible date is ${lp.achievable_date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` });
      else if (lp.status === 'aggressive') warnings.push({ level: 'warn', code: 'rate_aggressive', text: `That is a fast rate (${(lp.pct_bw * 100).toFixed(2)}% of bodyweight a week). Many people find 0.5–0.75% easier to sustain.` });
      if (intake - base.base - lp.required_balance <= 0) warnings.push({ level: 'info', code: 'diet_alone', text: 'Your eating plan alone creates this deficit; the exercise targets below are for fitness, not for the goal.' });
      const p = out.macros.protein_g_per_kg;
      if (p !== null && p < 1.6) warnings.push({ level: 'warn', code: 'protein_low', text: `Protein is ${p.toFixed(1)} g/kg; 1.6–2.2 g/kg helps keep muscle while losing weight.` });
    }
  }

  // Performance requirement
  let perfEx = 0;
  if (goals.performance) {
    const pp = performancePlan({ goal: goals.performance, run, now, weight_kg });
    out.performance = pp;
    const current = pp.weeks.find(w => w.kind !== 'race');
    perfEx = current ? current.kcal / 7 : 0;
    for (const n of pp.notes) warnings.push({ level: 'info', code: 'perf_note', text: n });
  }

  // Combine: the bigger demand sets the exercise; the other goal then reads the leftover balance.
  const exercise = Math.max(requiredEx, perfEx);
  out.exercise_kcal_day = exercise;
  out.targets = exerciseTargets(exercise, activity);
  out.balance = intake - base.base - exercise;
  out.projected = {
    balance_per_day: out.balance,
    kg_per_week: (out.balance * 7) / KCAL_PER_KG,
    goal_date: goals.lose && !out.lose?.blocked ? projectedGoalDate(weight_kg, goals.lose.target_kg, out.balance, now) : null,
  };
  out.basis = requiredEx >= perfEx ? (goals.lose && !out.lose?.blocked ? 'lose' : perfEx > 0 ? 'performance' : 'none') : 'performance';

  // How much could you eat while doing this exercise and still hit the weight goal?
  if (goals.lose && out.lose && !out.lose.blocked) {
    out.intake_allowance = Math.max(floor, base.base + exercise + out.lose.required_balance);
    // The conflict question is what you could eat while doing *only the training plan*
    // (exercise above is solved for your chosen intake, so it would always equal it).
    const trainingAllowance = base.base + perfEx + out.lose.required_balance;
    if (goals.performance && trainingAllowance < floor) {
      warnings.push({ level: 'warn', code: 'peak_conflict', text: `Your training plan plus this deficit would leave about ${Math.round(Math.max(0, trainingAllowance))} kcal a day to eat, below the ${floor} kcal minimum. Consider a slower loss rate or a later weight goal until the event is over.` });
    }
  }

  // Ambition check against what you actually do now
  if (activity?.weekly_kcal > 0 && out.targets.week.kcal > 2 * activity.weekly_kcal && out.targets.week.kcal > 1500) {
    warnings.push({ level: 'warn', code: 'ambitious', text: `That is ${(out.targets.week.kcal / activity.weekly_kcal).toFixed(1)}× your recent weekly exercise. Build up gradually.` });
  }
  return out;
}

/**
 * The inverse: how much can you eat if you do `exercise_kcal_day` and want to lose `rate_kg_week`?
 */
export function intakeAllowance({ base, exercise_kcal_day, rate_kg_week, sex }) {
  const floor = INTAKE_FLOOR[sex] || INTAKE_FLOOR.other;
  const raw = base.base + exercise_kcal_day - (rate_kg_week * KCAL_PER_KG) / 7;
  return { intake: Math.max(floor, raw), raw, floored: raw < floor };
}

/** Run planTargets once per scenario for the side-by-side table. */
export function compareScenarios({ scenarios, ...rest }) {
  return (scenarios || []).map(s => ({ scenario: s, plan: planTargets({ ...rest, scenario: s }) }));
}
