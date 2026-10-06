import test from "node:test";
import assert from "node:assert/strict";
import { bmr, targets, dayKey, totals, DEFAULT_PROFILE } from "./nutrition.js";

const NOW = new Date(2026, 9, 6, 12, 0);
const man = { ...DEFAULT_PROFILE, birthYear: 1990, weightKg: 85, heightCm: 180, activity: "moderate" };

test("Mifflin-St Jeor BMR", () => {
  assert.equal(bmr(man, NOW), 1800);
  assert.equal(bmr({ ...man, sex: "female" }, NOW), 1634);
});

test("cut targets at 0.7 %/week", () => {
  const t = targets(man, NOW);
  assert.equal(t.tdee, 2790);
  assert.equal(t.kcal, 2136);
  assert.equal(t.protein, 187);
  assert.equal(t.fat, 68);
  assert.equal(t.carbs, 194);
  assert.equal(t.fiber, 30);
  assert.equal(t.waterMl, 3000);
  assert.equal(t.atBmrFloor, false);
});

test("deficit is capped at 25 % of TDEE and never below BMR", () => {
  const small = { ...man, sex: "female", birthYear: 1996, weightKg: 50, heightCm: 160, activity: "sedentary", pacePct: 1 };
  const t = targets(small, NOW);
  assert.equal(t.kcal, t.bmr);
  assert.equal(t.atBmrFloor, true);
});

test("protein from lean mass when body fat is known", () => {
  assert.equal(targets({ ...man, bodyFatPct: 20 }, NOW).protein, 184);
});

test("maintain and gain", () => {
  assert.equal(targets({ ...man, goal: "maintain" }, NOW).kcal, 2790);
  assert.equal(targets({ ...man, goal: "gain" }, NOW).kcal, 3069);
});

test("a day starts at 04:00", () => {
  assert.equal(dayKey(new Date(2026, 9, 7, 0, 30)), "2026-10-06");
  assert.equal(dayKey(new Date(2026, 9, 7, 3, 59)), "2026-10-06");
  assert.equal(dayKey(new Date(2026, 9, 7, 4, 0)), "2026-10-07");
});

test("totals skip pending entries", () => {
  const entries = [
    { status: "confirmed", items: [{ kcal: 300, protein: 30 }, { kcal: 100, fiber: 4 }] },
    { status: "pending", items: [{ kcal: 999 }] },
  ];
  const sum = totals(entries);
  assert.equal(sum.kcal, 400);
  assert.equal(sum.protein, 30);
  assert.equal(sum.fiber, 4);
});
