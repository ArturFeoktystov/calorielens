import test from "node:test";
import assert from "node:assert/strict";
import { bmr, targets, dayKey, totals, shiftDay, timeOnDay, dailyStats, summarize, DEFAULT_PROFILE, weightTrend, daysBetween, weekStart, weeklySummary } from "./nutrition.js";

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

test("weight trend: weekly weigh-ins, rate per week, range filter", () => {
  const weights = [
    { day: "2026-09-29", kg: 85.0 },
    { day: "2026-09-08", kg: 86.6 },
    { day: "2026-09-15", kg: 86.1 },
    { day: "2026-09-22", kg: 85.4 },
  ];
  const t = weightTrend(weights);
  assert.deepEqual(t.points.map((p) => p.day), ["2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]);
  assert.equal(t.change, -1.6);
  assert.equal(t.perWeek, -0.55);
  assert.equal(weightTrend(weights, "2026-09-20").points.length, 2);
  assert.equal(daysBetween("2026-09-28", "2026-10-05"), 7);
});

test("weight trend needs two weigh-ins a week apart for a rate", () => {
  assert.equal(weightTrend([]).last, null);
  assert.equal(weightTrend([{ day: "2026-10-01", kg: 80 }]).perWeek, null);
  assert.equal(weightTrend([{ day: "2026-10-01", kg: 80 }, { day: "2026-10-04", kg: 79.5 }]).perWeek, null);
});

test("weekStart is the Monday of that week", () => {
  assert.equal(weekStart("2026-10-07"), "2026-10-05"); // Wednesday
  assert.equal(weekStart("2026-10-05"), "2026-10-05"); // Monday
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Sunday
  assert.equal(weekStart("2026-10-01"), "2026-09-28"); // across a month
});

test("weeklySummary: weekly weight, change, and the week's eating", () => {
  const weights = [
    { day: "2026-09-21", kg: 86.0 },
    { day: "2026-09-30", kg: 85.4 }, { day: "2026-10-03", kg: 85.0 }, // two weigh-ins: averaged
    { day: "2026-10-12", kg: 84.6 }, // skips a week
  ];
  const days = [
    { day: "2026-09-29", logged: true, kcal: 2000, protein: 170 },
    { day: "2026-09-30", logged: true, kcal: 2200, protein: 150 },
    { day: "2026-10-01", logged: false, kcal: 0, protein: 0 },
    { day: "2026-10-06", logged: true, kcal: 1900, protein: 180 },
  ];
  const rows = weeklySummary(weights, days);
  assert.deepEqual(rows.map((r) => r.week), ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  assert.deepEqual(rows.map((r) => r.kg), [86, 85.2, null, 84.6]);
  assert.deepEqual(rows.map((r) => r.change), [null, -0.8, null, -0.6]); // compared with the last weighed week
  assert.equal(rows[1].avgKcal, 2100);
  assert.equal(rows[1].loggedDays, 2);
  assert.equal(rows[2].avgProtein, 180);
  assert.equal(rows[0].avgKcal, null);
});
