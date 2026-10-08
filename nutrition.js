// Daily targets and day boundaries. Pure functions only, so they can be unit-tested in Node.

export const ACTIVITY = {
  sedentary: { factor: 1.2, label: "Sedentary (desk job, few steps)" },
  light: { factor: 1.375, label: "Light (walks, 1–3 workouts/week)" },
  moderate: { factor: 1.55, label: "Moderate (3–5 workouts/week)" },
  high: { factor: 1.725, label: "High (hard training most days)" },
};

export const GOALS = {
  cut: "Cut — lose fat, keep muscle",
  maintain: "Maintain",
  gain: "Lean gain",
};

const KCAL_PER_KG_FAT = 7700;
const MAX_DEFICIT_SHARE = 0.25;
const GAIN_SURPLUS_SHARE = 0.1;
const PROTEIN_G_PER_KG = 2.2;
const PROTEIN_G_PER_KG_LEAN = 2.7;
const FAT_G_PER_KG = 0.8;
const FAT_MIN_SHARE = 0.2;
const FIBER_G_PER_1000_KCAL = 14;
const FIBER_MIN_G = 25;
const WATER_ML_PER_KG = 35;
export const DAY_START_HOUR = 4;

export const DEFAULT_PROFILE = {
  sex: "male",
  birthYear: 1990,
  heightCm: 180,
  weightKg: 85,
  bodyFatPct: null,
  activity: "moderate",
  strengthPerWeek: 3,
  goal: "cut",
  pacePct: 0.7,
};

export function age(profile, now = new Date()) {
  return now.getFullYear() - profile.birthYear;
}

export function bmr(profile, now = new Date()) {
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * age(profile, now);
  return base + (profile.sex === "female" ? -161 : 5);
}

export function tdee(profile, now = new Date()) {
  return bmr(profile, now) * ACTIVITY[profile.activity].factor;
}

// Returns rounded daily targets plus the numbers behind them, for the "how is this calculated" view.
export function targets(profile, now = new Date()) {
  const b = bmr(profile, now);
  const t = tdee(profile, now);
  const kg = profile.weightKg;

  let kcal = t;
  let deficit = 0;
  if (profile.goal === "cut") {
    deficit = Math.min((profile.pacePct / 100) * kg * KCAL_PER_KG_FAT / 7, t * MAX_DEFICIT_SHARE);
    kcal = Math.max(t - deficit, b);
    deficit = t - kcal;
  } else if (profile.goal === "gain") {
    kcal = t * (1 + GAIN_SURPLUS_SHARE);
  }

  const leanKg = profile.bodyFatPct ? kg * (1 - profile.bodyFatPct / 100) : null;
  const protein = leanKg ? leanKg * PROTEIN_G_PER_KG_LEAN : kg * PROTEIN_G_PER_KG;
  const fat = Math.max(kg * FAT_G_PER_KG, (kcal * FAT_MIN_SHARE) / 9);
  const carbs = Math.max((kcal - protein * 4 - fat * 9) / 4, 0);

  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein),
    fat: Math.round(fat),
    carbs: Math.round(carbs),
    fiber: Math.round(Math.max((kcal / 1000) * FIBER_G_PER_1000_KCAL, FIBER_MIN_G)),
    waterMl: Math.round((kg * WATER_ML_PER_KG) / 50) * 50,
    bmr: Math.round(b),
    tdee: Math.round(t),
    deficit: Math.round(deficit),
    atBmrFloor: profile.goal === "cut" && kcal === b,
    weeklyLossKg: profile.goal === "cut" ? Math.round((deficit * 7 / KCAL_PER_KG_FAT) * 100) / 100 : 0,
  };
}

// A diary day runs from 04:00 to 03:59 the next morning. Returns "YYYY-MM-DD" in local time.
export function dayKey(date = new Date()) {
  const shifted = new Date(date.getTime() - DAY_START_HOUR * 3600_000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const d = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Moves a "YYYY-MM-DD" key by whole days (noon avoids daylight-saving edge cases).
export function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// A moment inside a diary day: today's clock time on that day, so new entries sort naturally.
// Clock times before 04:00 belong to the next calendar date of that diary day.
export function timeOnDay(day, now = new Date()) {
  const [y, m, d] = day.split("-").map(Number);
  const extra = now.getHours() < DAY_START_HOUR ? 1 : 0;
  return new Date(y, m - 1, d + extra, now.getHours(), now.getMinutes(), now.getSeconds()).getTime();
}

// Per-day totals for the `count` days ending with `lastDay`, oldest first.
// Days with no confirmed entries have logged: false, so averages skip them.
export function dailyStats(entries, lastDay, count) {
  const byDay = new Map();
  for (const entry of entries) {
    if (entry.status === "pending") continue;
    byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
  }
  return Array.from({ length: count }, (_, i) => {
    const day = shiftDay(lastDay, i - count + 1);
    const list = byDay.get(day) ?? [];
    return { day, logged: list.length > 0, ...totals(list) };
  });
}

// Averages over logged days, how many stayed within the calorie target, and the energy balance
// against maintenance (negative = deficit). Fat estimate uses the same 7700 kcal/kg as the targets.
export function summarize(days, goal) {
  const logged = days.filter((d) => d.logged);
  const avg = (key) => (logged.length ? logged.reduce((s, d) => s + d[key], 0) / logged.length : 0);
  const balance = logged.reduce((s, d) => s + d.kcal - goal.tdee, 0);
  return {
    loggedDays: logged.length,
    avgKcal: Math.round(avg("kcal")),
    avgProtein: Math.round(avg("protein")),
    daysOnTarget: logged.filter((d) => d.kcal <= goal.kcal).length,
    balanceKcal: Math.round(balance),
    fatKg: Math.round((balance / KCAL_PER_KG_FAT) * 100) / 100,
  };
}

// --- weight -------------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
export const daysBetween = (fromDay, toDay) =>
  Math.round((Date.UTC(...ymd(toDay)) - Date.UTC(...ymd(fromDay))) / MS_PER_DAY);
const ymd = (day) => day.split("-").map((v, i) => (i === 1 ? v - 1 : Number(v)));

// Weigh-ins ({day, kg}) from `fromDay` on, oldest first, with the rate of change in kg per week:
// a least-squares line through them, so one unusual weigh-in doesn't swing the result.
// The rate needs at least two weigh-ins a week or more apart; otherwise it is null.
export function weightTrend(weights, fromDay = "0000-00-00") {
  const points = weights.filter((w) => w.day >= fromDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  if (!points.length) return { points, first: null, last: null, change: 0, perWeek: null };
  const first = points[0];
  const last = points.at(-1);
  let perWeek = null;
  if (points.length >= 2 && daysBetween(first.day, last.day) >= 7) {
    const xs = points.map((p) => daysBetween(first.day, p.day));
    const meanX = xs.reduce((s, x) => s + x, 0) / xs.length;
    const meanY = points.reduce((s, p) => s + p.kg, 0) / points.length;
    const sxy = points.reduce((s, p, i) => s + (xs[i] - meanX) * (p.kg - meanY), 0);
    const sxx = xs.reduce((s, x) => s + (x - meanX) ** 2, 0);
    perWeek = Math.round((sxy / sxx) * 7 * 100) / 100;
  }
  return { points, first, last, change: Math.round((last.kg - first.kg) * 10) / 10, perWeek };
}

// Monday of the week a "YYYY-MM-DD" day belongs to (weeks run Monday to Sunday).
export function weekStart(day) {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(y, m - 1, d, 12).getDay(); // 0 = Sunday
  return shiftDay(day, -((weekday + 6) % 7));
}

// One row per calendar week, oldest first: the average weigh-in of that week (if any), the change
// from the previous week that had one, and calories/protein averaged over the week's logged days.
// `days` comes from dailyStats; weeks with neither weigh-ins nor logged days are left out.
export function weeklySummary(weights, days) {
  const weeks = new Map();
  const week = (day) => {
    const start = weekStart(day);
    if (!weeks.has(start)) weeks.set(start, { week: start, kgs: [], logged: [] });
    return weeks.get(start);
  };
  for (const w of weights) week(w.day).kgs.push(w.kg);
  for (const d of days) if (d.logged) week(d.day).logged.push(d);

  let previousKg = null;
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map(({ week: start, kgs, logged }) => {
    const kg = kgs.length ? Math.round((kgs.reduce((s, k) => s + k, 0) / kgs.length) * 10) / 10 : null;
    const change = kg !== null && previousKg !== null ? Math.round((kg - previousKg) * 10) / 10 : null;
    if (kg !== null) previousKg = kg;
    const avg = (key) => (logged.length ? Math.round(logged.reduce((s, d) => s + d[key], 0) / logged.length) : null);
    return { week: start, kg, weighIns: kgs.length, change, loggedDays: logged.length, avgKcal: avg("kcal"), avgProtein: avg("protein") };
  });
}

export const NUTRIENTS =["kcal", "protein", "fat", "carbs", "fiber", "sugar", "alcohol", "fluidMl"];

// Sums confirmed entries; pending entries (not yet recognized) are not counted.
export function totals(entries) {
  const sum = Object.fromEntries(NUTRIENTS.map((n) => [n, 0]));
  for (const entry of entries) {
    if (entry.status === "pending") continue;
    for (const item of entry.items ?? []) {
      for (const n of NUTRIENTS) sum[n] += item[n] ?? 0;
    }
  }
  return sum;
}
