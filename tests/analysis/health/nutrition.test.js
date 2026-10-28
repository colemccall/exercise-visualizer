import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KCAL_PER_KG, mifflinBmr, ageFromBirthYear, ewmaTrend, currentWeight, baseBurn, observedExpenditure,
  activityProfile, exerciseTargets, losePlan, projectWeight, projectedGoalDate, macroSummary,
  performancePlan, riegel, planTargets, intakeAllowance, compareScenarios, INTAKE_FLOOR,
} from '../../../src/analysis/health/nutrition.js';
import { addDays, dayKey } from '../../../src/analysis/dates.js';

const near = (a, b, eps = 0.5) => assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`);
const NOW = new Date(2026, 0, 5, 12);                       // Mon 5 Jan 2026
const days = (n) => addDays(dayKey(NOW), n);
const male = { sex: 'male', birth_year: 1991, height_cm: 180, baseline: 'sedentary' }; // 35 in 2026

test('Mifflin-St Jeor: hand-computed values', () => {
  // 10*80 + 6.25*180 - 5*35 + 5 = 800 + 1125 - 175 + 5
  assert.equal(mifflinBmr({ sex: 'male', weight_kg: 80, height_cm: 180, age: 35 }), 1755);
  // 10*65 + 6.25*165 - 5*30 - 161
  near(mifflinBmr({ sex: 'female', weight_kg: 65, height_cm: 165, age: 30 }), 1370.25, 0.001);
  assert.equal(mifflinBmr({ sex: 'male', weight_kg: 0, height_cm: 180, age: 35 }), null);
  assert.equal(ageFromBirthYear(1991, NOW), 35);
});

test('ewmaTrend smooths a spike; currentWeight uses it', () => {
  const w = [80, 80, 80, 82, 80].map((kg, i) => ({ date: days(i), kg }));
  const t = ewmaTrend(w);
  assert.equal(t[0].trend, 80);
  assert.ok(t[3].trend < 80.5, 'a 2 kg one-day spike moves the trend only a little');
  assert.ok(currentWeight(w) > 79.9 && currentWeight(w) < 80.5);
  assert.equal(currentWeight([]), null);
});

test('ewmaTrend is time-aware: weigh-ins weeks apart are trusted, daily ones are smoothed', () => {
  // The shape of a real Apple Health history: four weigh-ins, months apart, rising
  const sparse = [
    { date: '2022-08-31', kg: 79.38 }, { date: '2026-01-10', kg: 81.65 },
    { date: '2026-01-12', kg: 83.91 }, { date: '2026-02-22', kg: 91.63 },
  ];
  const cur = currentWeight(sparse);
  assert.ok(cur > 90.5 && cur <= 91.63, `current weight ${cur} should sit next to the latest reading (91.63), not lag at ~81`);
  // the same count of daily readings still smooths a one-day spike
  const daily = [80, 80, 80, 82, 80].map((kg, i) => ({ date: days(i), kg }));
  assert.ok(ewmaTrend(daily)[3].trend < 80.5);
  // two readings on the same day do not blow up
  assert.ok(Number.isFinite(ewmaTrend([{ date: '2026-01-01', kg: 80 }, { date: '2026-01-01', kg: 81 }])[1].trend));
});

test('baseBurn: formula path = BMR x baseline factor', () => {
  const b = baseBurn({ profile: male, weight_kg: 80, now: NOW });
  assert.equal(b.bmr, 1755);
  near(b.neat, 1755 * 0.2);                                 // sedentary 1.2 -> +20%
  near(b.base, 1755 * 1.2);
  assert.equal(b.source, 'formula');
});

test('baseBurn: uses the watch\'s basal energy and subtracts workout kcal from active energy', () => {
  const basal = {}, active = {};
  for (let i = -20; i <= 0; i++) { basal[days(i)] = 1800; active[days(i)] = 500; }
  const workouts = [-3, -2, -1].map(i => ({ date: new Date(2026, 0, 5 + i, 8), calories_kcal: 200 }));
  const b = baseBurn({ profile: male, weight_kg: 80, basal_by_day: basal, active_by_day: active, workouts, now: NOW });
  assert.equal(b.source, 'watch');
  assert.equal(b.bmr, 1800);
  assert.equal(b.neat, 500);                                // median: most days have no workout; workout days drop to 300
  near(b.base, 2300);
  const formulaOnly = baseBurn({ profile: male, weight_kg: 80, basal_by_day: basal, active_by_day: active, workouts, now: NOW, bmrSource: 'formula' });
  assert.equal(formulaOnly.bmr, 1755);
});

test('losePlan: 10 kg over 20 weeks is 0.5 kg/week, a 550 kcal/day deficit', () => {
  const lp = losePlan({ goal: { type: 'lose', target_kg: 80, target_date: days(140) }, weight_kg: 90, age: 35, now: NOW });
  near(lp.rate_kg_week, 0.5, 0.001);
  near(lp.required_balance, -(0.5 * KCAL_PER_KG) / 7, 1);       // -550 (±1: a daylight-saving hour sits inside 20 weeks)
  assert.equal(lp.status, 'ok');
  assert.equal(lp.capped, false);
});

test('losePlan: guardrails cap the rate at 1% of bodyweight and report the earliest date', () => {
  // 20 kg in 4 weeks would be 5 kg/week
  const lp = losePlan({ goal: { type: 'lose', target_kg: 70, target_date: days(28) }, weight_kg: 90, age: 35, now: NOW });
  assert.equal(lp.status, 'unsafe');
  assert.equal(lp.capped, true);
  near(lp.rate_kg_week, 0.9, 0.001);                          // 1% of 90 kg
  near(lp.weeks_needed, 20 / 0.9, 0.01);
  const aggressive = losePlan({ goal: { type: 'lose', target_kg: 85, rate_kg_week: 0.8 }, weight_kg: 90, age: 35, now: NOW });
  assert.equal(aggressive.status, 'aggressive');              // 0.89% > 0.75%
});

test('losePlan: refuses under 18, and a goal already reached', () => {
  assert.equal(losePlan({ goal: { target_kg: 60, rate_kg_week: 0.5 }, weight_kg: 70, age: 17, now: NOW }).blocked, 'under_18');
  assert.equal(losePlan({ goal: { target_kg: 80, rate_kg_week: 0.5 }, weight_kg: 78, age: 35, now: NOW }).blocked, 'already_there');
  assert.equal(losePlan({ goal: { target_kg: 0 }, weight_kg: 78, age: 35, now: NOW }).blocked, 'no_weight');
});

test('projectWeight / projectedGoalDate', () => {
  near(projectWeight(90, -550, 14), 90 - (550 * 14) / KCAL_PER_KG, 1e-9);
  const d = projectedGoalDate(90, 80, -550, NOW);
  near((d - NOW) / 864e5, (10 * KCAL_PER_KG) / 550, 0.01);
  assert.equal(projectedGoalDate(90, 80, 200, NOW), null, 'a surplus never reaches a lower weight');
});

test('planTargets: eating less means less exercise is needed (and vice versa)', () => {
  const base = baseBurn({ profile: male, weight_kg: 90, now: NOW });   // 1855 BMR, base 2226
  near(base.base, 1855 * 1.2, 0.01);
  const goals = { lose: { type: 'lose', target_kg: 80, target_date: days(140) } };
  const at = (kcal) => planTargets({ profile: male, weight_kg: 90, goals, scenario: { kcal }, base, activity: null, now: NOW });

  // exercise = intake - base + 550
  near(at(2000).exercise_kcal_day, 2000 - base.base + 550, 0.5);
  near(at(2500).exercise_kcal_day, 2500 - base.base + 550, 0.5);
  assert.ok(at(2500).exercise_kcal_day > at(2000).exercise_kcal_day + 499, 'more food, more exercise needed');
  assert.ok(at(1700).exercise_kcal_day < at(2000).exercise_kcal_day);
  near(at(2000).targets.week.kcal, at(2000).exercise_kcal_day * 7, 0.01);
  near(at(2000).targets.month.kcal, at(2000).exercise_kcal_day * 30.4375, 0.5);
});

test('planTargets: when eating alone makes the deficit, no exercise is required and it says so', () => {
  const base = baseBurn({ profile: male, weight_kg: 90, now: NOW });
  const p = planTargets({ profile: male, weight_kg: 90, goals: { lose: { target_kg: 80, target_date: days(140) } }, scenario: { kcal: 1500 }, base, now: NOW });
  assert.equal(p.exercise_kcal_day, 0);
  assert.ok(p.warnings.some(w => w.code === 'diet_alone'));
});

test('planTargets: guardrail warnings', () => {
  const base = baseBurn({ profile: male, weight_kg: 90, now: NOW });
  const low = planTargets({ profile: male, weight_kg: 90, goals: {}, scenario: { kcal: 1200 }, base, now: NOW });
  assert.ok(low.warnings.some(w => w.code === 'below_floor'), 'below the 1500 kcal minimum for this profile');
  const fast = planTargets({ profile: male, weight_kg: 90, goals: { lose: { target_kg: 70, target_date: days(28) } }, scenario: { kcal: 2200, protein_g: 90 }, base, now: NOW });
  assert.ok(fast.warnings.some(w => w.code === 'rate_unsafe'));
  assert.ok(fast.warnings.some(w => w.code === 'protein_low'), '90 g / 90 kg = 1.0 g/kg is below 1.6');
  const teen = planTargets({ profile: { ...male, birth_year: 2010 }, weight_kg: 60, goals: { lose: { target_kg: 55, rate_kg_week: 0.5 } }, scenario: { kcal: 2000 }, base, now: NOW });
  assert.ok(teen.warnings.some(w => w.code === 'under_18'));
  assert.equal(teen.exercise_kcal_day, 0);
});

test('planTargets: no profile -> asks for it instead of inventing numbers', () => {
  const p = planTargets({ profile: {}, weight_kg: 0, goals: {}, scenario: { kcal: 2000 }, base: null, now: NOW });
  assert.ok(p.warnings.some(w => w.code === 'need_profile'));
  assert.equal(p.exercise_kcal_day, 0);
});

test('activityProfile and exerciseTargets use YOUR kcal/minute and kcal/metre', () => {
  const runs = Array.from({ length: 6 }, (_, i) => ({
    type: 'Run', date: new Date(2025, 11, 1 + i * 5, 8), moving_s: 1800, distance_m: 5000, calories_kcal: 300,
  }));
  const prof = activityProfile(runs, { now: NOW, days: 90 });
  assert.equal(prof.by_type.Run.sessions, 6);
  near(prof.by_type.Run.kcal_per_min, 10, 1e-9);            // 300 kcal / 30 min
  near(prof.by_type.Run.kcal_per_m, 0.06, 1e-9);            // 300 kcal / 5000 m
  near(prof.avg_session_kcal, 300, 1e-9);
  near(prof.weekly_kcal, (6 * 300) / (90 / 7), 1e-6);

  const t = exerciseTargets(70, prof);                      // 70 kcal a day
  near(t.week.kcal, 490, 1e-9);
  near(t.week.minutes, 49, 1e-6);
  near(t.week.sessions, 490 / 300, 1e-6);
  near(t.week.distance_m, 490 / 0.06, 1e-3);
  assert.equal(exerciseTargets(70, null).week.minutes, null, 'no history, no minutes guess');
});

test('merged-away duplicates and old workouts are ignored by activityProfile', () => {
  const acts = [
    { type: 'Run', date: new Date(2025, 11, 20), moving_s: 1800, distance_m: 5000, calories_kcal: 300 },
    { type: 'Run', date: new Date(2025, 11, 20), moving_s: 1800, distance_m: 5000, calories_kcal: 300, merged_into: 'x' },
    { type: 'Run', date: new Date(2024, 1, 1), moving_s: 1800, distance_m: 5000, calories_kcal: 300 },
  ];
  assert.equal(activityProfile(acts, { now: NOW, days: 90 }).by_type.Run.sessions, 1);
});

test('observedExpenditure: flat weight means expenditure equals intake', () => {
  const foodlog = Array.from({ length: 30 }, (_, i) => ({ date: days(-30 + i), kcal: 2000 }));
  const weights = [0, 7, 14, 21, 28].map(i => ({ date: days(-30 + i), kg: 80 }));
  const o = observedExpenditure({ foodlog, weights, now: NOW });
  near(o.tdee, 2000, 0.01);
  assert.equal(o.logged_days, 30);
  assert.equal(observedExpenditure({ foodlog: foodlog.slice(0, 10), weights, now: NOW }), null, 'too little data');
});

test('observedExpenditure: losing weight on 2000 kcal means you burn more than 2000', () => {
  const foodlog = Array.from({ length: 35 }, (_, i) => ({ date: days(-36 + i), kcal: 2000 }));
  const weights = Array.from({ length: 36 }, (_, i) => ({ date: days(-36 + i), kg: 85 - i * 0.07 }));
  const o = observedExpenditure({ foodlog, weights, now: NOW });
  assert.ok(o.tdee > 2300 && o.tdee < 3000, `tdee ${o.tdee}`);
  assert.ok(o.change_kg < 0);
});

test('macroSummary: protein per kg and kcal from macros', () => {
  const m = macroSummary({ kcal: 2000, protein_g: 160, carbs_g: 200, fat_g: 60 }, 80);
  assert.equal(m.protein_g_per_kg, 2);
  assert.equal(m.kcal_from_macros, 160 * 4 + 200 * 4 + 60 * 9);   // 1980
  assert.equal(m.mismatch_kcal, -20);
});

test('riegel: a 25:00 5K predicts about 52:07 for a 10K', () => {
  near(riegel(1500, 5000, 10000), 1500 * Math.pow(2, 1.06), 1e-9);
  near(riegel(1500, 5000, 10000), 3127.4, 0.5);
});

test('performancePlan: 10% growth cap, cut-back every 4th build week, taper, race last', () => {
  const goal = { type: 'performance', event: '10k', date: days(84) };       // 12 weeks
  const p = performancePlan({ goal, run: { weekly_m: 20000 }, now: NOW });
  assert.equal(p.weeks_to_event, 12);
  const build = p.weeks.filter(w => w.kind === 'build' || w.kind === 'cutback');
  assert.equal(p.weeks[p.weeks.length - 1].kind, 'race');
  assert.equal(p.weeks[p.weeks.length - 2].kind, 'taper');
  assert.ok(build[3].kind === 'cutback' && build[7].kind === 'cutback', 'weeks 4 and 8 are cut-backs');
  let prev = 20000;
  for (const w of build.filter(w => w.kind === 'build')) {
    assert.ok(w.distance_m <= prev * 1.1 + 1, `week ${w.index}: ${w.distance_m} vs ${prev}`);
    assert.ok(w.distance_m <= p.peak_target_m + 1);
    prev = w.distance_m;
  }
  const taper = p.weeks.find(w => w.kind === 'taper');
  assert.ok(taper.distance_m < p.peak_reachable_m, 'taper is lighter than the peak');
  for (const w of p.weeks.filter(w => w.kind !== 'race')) assert.ok(w.long_run_m <= 16000, 'long run capped for a 10K');
  assert.equal(p.weeks.at(-1).distance_m, 10000);
});

test('performancePlan: too little time is reported honestly, not faked', () => {
  const p = performancePlan({ goal: { event: 'marathon', date: days(56) }, run: { weekly_m: 10000 }, now: NOW });
  assert.equal(p.reachable, false);
  assert.ok(p.notes.some(n => /isn't time to reach/.test(n)));
  assert.ok(p.peak_reachable_m < p.peak_target_m);
});

test('performancePlan: predicted time and the gap to a target', () => {
  const goal = { event: '10k', date: days(70), target_time_s: 2900 };
  const p = performancePlan({ goal, run: { weekly_m: 25000, best_efforts: [{ distance_m: 5000, time_s: 1500 }] }, now: NOW });
  near(p.predicted_time_s, riegel(1500, 5000, 10000), 0.01);
  near(p.gap_s, p.predicted_time_s - 2900, 0.01);
});

test('both goals: training raises what you can eat; too much of both is flagged', () => {
  const base = baseBurn({ profile: male, weight_kg: 90, now: NOW });
  const goals = { lose: { target_kg: 80, rate_kg_week: 0.5 } };
  const without = planTargets({ profile: male, weight_kg: 90, base, now: NOW, goals, scenario: { kcal: 2000 } });
  const withPerf = planTargets({ profile: male, weight_kg: 90, base, now: NOW, scenario: { kcal: 2000 },
    goals: { ...goals, performance: { event: 'half', date: days(70) } }, run: { weekly_m: 40000, kcal_per_m: 0.075 } });
  assert.ok(withPerf.intake_allowance >= without.intake_allowance, 'more training, more room to eat');
  assert.ok(withPerf.exercise_kcal_day >= without.exercise_kcal_day);

  // a small person with a deficit AND a half-marathon build leaves almost nothing to eat
  const small = { sex: 'female', birth_year: 1981, height_cm: 155, baseline: 'sedentary' };
  const sbase = baseBurn({ profile: small, weight_kg: 50, now: NOW });
  const conflict = planTargets({ profile: small, weight_kg: 50, base: sbase, now: NOW, scenario: { kcal: 1500 },
    goals: { lose: { target_kg: 45, rate_kg_week: 0.5 }, performance: { event: 'half', date: days(70) } },
    run: { weekly_m: 30000, kcal_per_m: 0.05 } });
  assert.ok(conflict.warnings.some(w => w.code === 'peak_conflict'));
});

test('intakeAllowance: the inverse question, floored', () => {
  const base = { base: 2200 };
  near(intakeAllowance({ base, exercise_kcal_day: 400, rate_kg_week: 0.5, sex: 'male' }).intake, 2200 + 400 - 550, 0.01);
  const low = intakeAllowance({ base: { base: 1700 }, exercise_kcal_day: 0, rate_kg_week: 0.9, sex: 'female' });
  assert.equal(low.floored, true);
  assert.equal(low.intake, INTAKE_FLOOR.female);
});

test('compareScenarios returns a plan per scenario', () => {
  const base = baseBurn({ profile: male, weight_kg: 90, now: NOW });
  const rows = compareScenarios({
    scenarios: [{ name: 'Lean', kcal: 1900 }, { name: 'Normal', kcal: 2400 }],
    profile: male, weight_kg: 90, base, now: NOW, goals: { lose: { target_kg: 80, target_date: days(140) } },
  });
  assert.equal(rows.length, 2);
  assert.ok(rows[1].plan.exercise_kcal_day > rows[0].plan.exercise_kcal_day);
});
