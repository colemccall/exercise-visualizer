import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFoodCsv, exportPlanJson, importPlanJson, emptyPlan } from '../../src/core/data/plan-store.js';

test('parseFoodCsv: loose headers, several meals per day add up', () => {
  const csv = [
    'Date,Meal,Calories,Protein (g),Carbohydrates (g),Fat (g)',
    '2026-03-01,Breakfast,500,30,60,15',
    '2026-03-01,Dinner,900,50,80,35',
    '2026-03-02,Lunch,700,40,70,20',
  ].join('\n');
  const { rows, skipped } = parseFoodCsv(csv);
  assert.equal(skipped, 0);
  assert.deepEqual(rows, [
    { date: '2026-03-01', kcal: 1400, protein: 80, carbs: 140, fat: 50 },
    { date: '2026-03-02', kcal: 700, protein: 40, carbs: 70, fat: 20 },
  ]);
});

test('parseFoodCsv: quoted commas, bad rows skipped, missing columns tolerated', () => {
  const csv = 'day,"Energy (kcal)"\n"2026-03-05",1800\nnot-a-date,500\n2026-03-06,0\n';
  const { rows, skipped } = parseFoodCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kcal, 1800);
  assert.equal(skipped, 2);
  assert.deepEqual(parseFoodCsv('just,one,line').rows, []);
  assert.deepEqual(parseFoodCsv('a,b\n1,2').rows, [], 'no date/calorie columns');
});

test('plan JSON round-trips and rejects other files', () => {
  const plan = emptyPlan();
  plan.profile.sex = 'male'; plan.profile.birth_year = 1990;
  plan.scenarios = [{ id: 'a', name: 'Cut', kcal: 2000, protein_g: 160, carbs_g: 200, fat_g: 60 }, { id: 'b', name: '', kcal: 0 }];
  plan.activeScenario = 'a';
  plan.weights = [{ date: '2026-01-01', kg: 90, source: 'manual' }, { date: 'x', kg: -3 }];
  const back = importPlanJson(exportPlanJson(plan));
  assert.equal(back.profile.birth_year, 1990);
  assert.equal(back.scenarios.length, 1, 'invalid scenarios are dropped');
  assert.equal(back.weights.length, 1, 'invalid weights are dropped');
  assert.equal(back.activeScenario, 'a');
  assert.throws(() => importPlanJson('not json'), /not valid JSON/);
  assert.throws(() => importPlanJson('{"kind":"other"}'), /exported plan/);
});
