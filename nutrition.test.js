import test from "node:test";
import assert from "node:assert/strict";
import { bmr, targets, dayKey, totals, shiftDay, timeOnDay, dailyStats, summarize, DEFAULT_PROFILE } from "./nutrition.js";

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

test("shiftDay crosses months and years", () => {
  assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2026-03-29", 1), "2026-03-30"); // DST change in Europe
});

test("timeOnDay keeps the entry inside that diary day", () => {
  assert.equal(dayKey(new Date(timeOnDay("2026-10-04", new Date(2026, 9, 6, 13, 5)))), "2026-10-04");
  assert.equal(dayKey(new Date(timeOnDay("2026-10-04", new Date(2026, 9, 7, 1, 30)))), "2026-10-04");
});

test("dailyStats fills empty days and summarize averages logged days only", () => {
  const entries = [
    { day: "2026-10-04", status: "confirmed", items: [{ kcal: 1800, protein: 150 }] },
    { day: "2026-10-06", status: "confirmed", items: [{ kcal: 2400, protein: 110 }] },
    { day: "2026-10-06", status: "pending", items: [{ kcal: 999 }] },
  ];
  const days = dailyStats(entries, "2026-10-06", 3);
  assert.deepEqual(days.map((d) => [d.day, d.logged, d.kcal]), [
    ["2026-10-04", true, 1800], ["2026-10-05", false, 0], ["2026-10-06", true, 2400],
  ]);
  const s = summarize(days, { kcal: 2100, tdee: 2700 });
  assert.equal(s.loggedDays, 2);
  assert.equal(s.avgKcal, 2100);
  assert.equal(s.avgProtein, 130);
  assert.equal(s.daysOnTarget, 1);
  assert.equal(s.balanceKcal, -1200);
  assert.equal(s.fatKg, -0.16);
});
test("drinks add to water; entries saved before fluidMl count as 0", () => {
  const entries = [
    { status: "confirmed", items: [{ kcal: 60, fluidMl: 250 }, { kcal: 140, fluidMl: 330 }] },
    { status: "confirmed", items: [{ kcal: 300 }] },
    { status: "pending", items: [{ kcal: 5, fluidMl: 500 }] },
  ];
  assert.equal(totals(entries).fluidMl, 580);
});
