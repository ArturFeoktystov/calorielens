// CalorieLens for iPhone: photo of a meal -> calories and macros -> what is left for today.
// Steps 1–2: profile, targets, home screen, water; photo/text -> Claude -> confirm -> diary; history.
// The API key lives only in this browser's storage.

import {
  ACTIVITY, GOALS, DEFAULT_PROFILE, targets, dayKey, totals, shiftDay, timeOnDay, dailyStats, summarize,
  weightTrend, daysBetween, weekStart, weeklySummary, DAY_START_HOUR,
} from "./nutrition.js?v=17";
import {
  load, save, entriesForDay, entriesBetween, getEntry, putEntry, deleteEntry, waterForDay, setWater,
  allWeights, putWeight, deleteWeight, requestPersistence,
} from "./db.js?v=17";
import { estimate, describeError, NUTRIENT_FIELDS } from "./recognize.js?v=17";
import { dailyAdvice } from "./advice.js?v=17";
const MODELS = {
  "claude-sonnet-5-5": "Sonnet 5.5 — recommended",
  "claude-haiku-4-5": "Haiku 4.5 — cheapest",
  "claude-opus-5-5": "Opus 5.5 — most careful, slower",
};
const DEFAULT_SETTINGS = { anthropicKey: "", model: "claude-sonnet-5-5" };
const RING_LENGTH = 2 * Math.PI * 52;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

const profile = () => load("profile", null);
const settings = () => ({ ...DEFAULT_SETTINGS, ...load("settings", {}) });

// --- home screen ---------------------------------------------------------------------------------
// Shows today by default; ‹ › and History open past days, which can be edited and added to.

let viewDay = null; // null = today
const shownDay = () => viewDay ?? dayKey();

const dateOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const shortDate = (day) => dateOf(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function dayTitle(day) {
  const today = dayKey();
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  if (day >= shiftDay(today, -6)) return dateOf(day).toLocaleDateString("en-US", { weekday: "long" });
  return dateOf(day).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function showDay(day) {
  viewDay = day >= dayKey() ? null : day;
  render();
  window.scrollTo({ top: 0 });
}
$("day-prev").addEventListener("click", () => showDay(shiftDay(shownDay(), -1)));
$("day-next").addEventListener("click", () => showDay(shiftDay(shownDay(), 1)));
$("day-today").addEventListener("click", () => showDay(dayKey()));

async function render() {
  const p = profile();
  if (!p) return;
  const day = shownDay();
  const goal = targets(p);
  const [entries, waterMl] = await Promise.all([entriesForDay(day), waterForDay(day)]);
  const eaten = totals(entries);

  const isToday = day === dayKey();
  $("day-title").textContent = dayTitle(day);
  $("date").textContent = shortDate(day);
  $("day-today").hidden = isToday;
  $("day-next").disabled = isToday;

  const left = goal.kcal - eaten.kcal;
  document.querySelector(".energy").classList.toggle("over", left < 0);
  $("kcal-left").textContent = fmt(Math.abs(left));
  $("kcal-left-label").textContent = left < 0 ? "kcal over" : "kcal left";
  $("kcal-eaten").textContent = `${fmt(eaten.kcal)} eaten of ${fmt(goal.kcal)}`;
  const share = Math.min(eaten.kcal / goal.kcal, 1);
  $("ring-fill").style.strokeDasharray = `${share * RING_LENGTH} ${RING_LENGTH}`;
  $("ring-fill").style.visibility = share > 0 ? "visible" : "hidden"; // a round cap draws a dot at 0

  $("macros").innerHTML = [
    ["protein", "Protein"], ["fat", "Fat"], ["carbs", "Carbs"], ["fiber", "Fiber"],
  ].map(([key, label]) => `
    <div class="macro">
      <div class="row"><span>${label}</span><span class="muted">${fmt(eaten[key])} / ${fmt(goal[key])} g</span></div>
      <div class="bar"><div class="bar-fill ${key}" style="width:${Math.min(eaten[key] / goal[key], 1) * 100}%"></div></div>
    </div>`).join("");

  const extras = [`Sugar ${fmt(eaten.sugar)} g`];
  if (eaten.alcohol > 0) extras.push(`Alcohol ${fmt(eaten.alcohol)} g`);
  $("extras").textContent = extras.join(" · ");

  // Plain water from the buttons plus drinks logged as food (tea, coffee, milk, soft drinks).
  const drinksMl = eaten.fluidMl;
  const liters = (ml) => (ml / 1000).toFixed(2);
  $("water-text").textContent = `${liters(waterMl + drinksMl)} / ${(goal.waterMl / 1000).toFixed(1)} L`;
  const waterShare = Math.min(waterMl / goal.waterMl, 1);
  $("water-fill").style.width = `${waterShare * 100}%`;
  $("drinks-fill").style.width = `${Math.min(drinksMl / goal.waterMl, 1 - waterShare) * 100}%`;
  $("water-note").textContent = drinksMl > 0 ? `incl. ${liters(drinksMl)} L from drinks` : "";
  renderWeightCard();
  renderAdvice(day, entries);

  $("feed").innerHTML = entries.map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const items = entry.items ?? [];
    const pending = entry.status === "pending";
    const names = pending
      ? (items.length ? "Ready to confirm — tap" : "Waiting — tap to recognize")
      : items.map((i) => i.name).join(", ");
    const kcal = pending ? "" : `${fmt(entryKcal(entry))} kcal`;
    const thumb = entry.thumb
      ? `<img src="${entry.thumb}" alt="">`
      : `<span class="no-thumb">${entry.source === "text" ? "✎" : "📷"}</span>`;
    return `<li data-id="${entry.id}" class="${pending ? "pending" : ""}">${thumb}
      <div class="what"><div class="names">${escapeHtml(names)}</div><div class="muted small">${time}</div></div>
      <span class="kcal">${kcal}</span></li>`;
  }).join("");
}

const entryKcal = (entry) => (entry.items ?? []).reduce((sum, i) => sum + (i.kcal ?? 0), 0);

$("feed").addEventListener("click", async (event) => {
  const li = event.target.closest("li[data-id]");
  if (!li) return;
  const entry = await getEntry(li.dataset.id);
  if (!entry) return;
  openEntry(entry);
  if (entry.status === "pending" && !entry.items?.length) recognize();
});

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

for (const button of document.querySelectorAll("[data-water]")) {
  button.addEventListener("click", async () => {
    const day = shownDay();
    const ml = Math.max((await waterForDay(day)) + Number(button.dataset.water), 0);
    await setWater(day, ml);
    render();
  });
}

for (const button of document.querySelectorAll("[data-soon]")) {
  button.addEventListener("click", () => toast(`Coming in step ${button.dataset.soon} of the MVP.`));
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

// The day rolls over at 04:00 - refresh whenever the app comes back to the foreground.
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

// --- adding food: photo and text -----------------------------------------------------------------
// Every new entry is saved right away as "pending", so nothing is lost offline or on an API error.
// It becomes "confirmed" (and counts toward today) only when the user taps Save.

const PHOTO_MAX_SIDE = 1024;
const THUMB_SIDE = 160;
const MAX_PHOTOS = 4; // e.g. the dish, or the front and back of a package

// Older entries kept a single `image`; newer ones keep `images`.
const entryImages = (entry) => entry.images ?? (entry.image ? [entry.image] : []);

let addingPhoto = false; // the next photo goes into the open entry instead of a new one

$("add-photo").addEventListener("click", () => {
  addingPhoto = false;
  $("photo-input").click();
});
$("add-album").addEventListener("click", () => {
  addingPhoto = false;
  $("album-input").click();
});
// The album input lets iOS offer both the camera and the photo library.
$("entry-add-photo").addEventListener("click", () => {
  addingPhoto = true;
  $("album-input").click();
});
for (const inputId of ["photo-input", "album-input"]) {
  const input = $(inputId);
  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = ""; // allow picking the same photo again
    if (file) addPhoto(file);
  });
}

// A new photo goes into the day on screen; the Day field in the entry moves it to another day.
async function addPhoto(file) {
  try {
    const img = await loadImage(file);
    const image = toJpeg(img, PHOTO_MAX_SIDE, 0.82).split(",")[1];
    if (addingPhoto && current && entryDialog.open) {
      current.images = [...entryImages(current), image];
      delete current.image;
      await putEntry(current);
      recognize($("entry-note").value.trim());
      return;
    }
    const entry = newEntry("photo");
    entry.images = [image];
    entry.thumb = toJpeg(img, THUMB_SIDE, 0.7, true);
    await putEntry(entry);
    render();
    openEntry(entry);
    recognize();
  } catch {
    toast("Couldn't read that photo. Try again.");
  }
}

$("add-text").addEventListener("click", () => {
  $("text-form").reset();
  $("text-dialog").showModal();
});
$("text-cancel").addEventListener("click", () => $("text-dialog").close());
$("text-form").addEventListener("submit", async () => {
  const entry = newEntry("text");
  entry.text = $("text-form").elements.text.value.trim();
  await putEntry(entry);
  render();
  openEntry(entry);
  recognize();
});

// Goes into the day on screen: logging a past day afterwards puts it at today's clock time on that day.
function newEntry(source) {
  const day = shownDay();
  const time = day === dayKey() ? Date.now() : timeOnDay(day);
  return { id: crypto.randomUUID(), day, time, source, status: "pending", items: [], question: "" };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url; // Safari applies the photo's EXIF rotation when decoding an <img>
  });
}

// Scales so the longer side is at most maxSide (or crops to a square thumbnail), returns a data: URL.
function toJpeg(img, maxSide, quality, square = false) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (square) {
    const side = Math.min(w, h);
    canvas.width = canvas.height = maxSide;
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, maxSide, maxSide);
  } else {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  return canvas.toDataURL("image/jpeg", quality);
}

// --- entry dialog: recognize, review, correct, save ----------------------------------------------

const entryDialog = $("entry-dialog");
let current = null; // the entry shown in the dialog
let busy = false;

function openEntry(entry) {
  current = structuredClone(entry);
  $("entry-note").value = "";
  setEntryStatus(entry.error || "", entry.error ? "error" : "");
  renderEntry();
  if (!entryDialog.open) entryDialog.showModal();
}

function setEntryStatus(text, kind = "") {
  $("entry-status").textContent = text;
  $("entry-status").className = `status-line ${kind}`;
}

function renderEntry() {
  const items = current.items;
  const sum = Object.fromEntries(NUTRIENT_FIELDS.map((n) => [n, items.reduce((s, i) => s + (i[n] ?? 0), 0)]));
  $("entry-thumb").src = current.thumb || "";
  $("entry-thumb").classList.toggle("hidden", !current.thumb);
  $("entry-total").textContent = items.length ? `${fmt(sum.kcal)} kcal` : (current.text ? "Text entry" : "Photo");
  $("entry-macros").textContent = items.length
    ? `Protein ${fmt(sum.protein)} g · Fat ${fmt(sum.fat)} g · Carbs ${fmt(sum.carbs)} g`
    : (current.text ?? "");
  $("entry-question").textContent = current.question || "";
  // The question is answered right under it, in the correction field (or by editing grams).
  $("entry-ask").classList.toggle("has-question", Boolean(current.question));
  $("entry-note").placeholder = current.question
    ? "Your answer, e.g. “180 g”, “no oil”"
    : "Correct it: “fried in 1 tbsp oil”, “rice 200 g”…";
  $("entry-reestimate").textContent = current.question ? "Answer" : "Re-estimate";

  $("entry-items").innerHTML = items.map((item, index) => `
    <li data-index="${index}">
      <div class="item-top">
        <input class="item-name" value="${escapeHtml(item.name)}" aria-label="Food name">
        <input class="item-grams" type="number" inputmode="decimal" min="0" step="1" value="${Math.round(item.grams)}" aria-label="Grams">
        <span class="unit">g</span>
        <button type="button" class="item-remove" aria-label="Remove">✕</button>
      </div>
      <div class="item-facts">${itemFacts(item)}</div>
    </li>`).join("");

  // Full photos are dropped after saving, so photos can only be added before that.
  const images = entryImages(current);
  $("entry-photos").classList.toggle("hidden", !images.length);
  $("entry-photo-list").innerHTML = images.length > 1
    ? images.map((data) => `<img src="data:image/jpeg;base64,${data}" alt="">`).join("")
    : `<span class="muted small">Add the back of the pack for an exact label</span>`;
  $("entry-add-photo").disabled = busy || images.length >= MAX_PHOTOS;

  // Re-estimating needs the full photos or the text.
  $("entry-correct").classList.toggle("hidden", !(images.length || current.text));
  $("entry-later").classList.toggle("hidden", current.status !== "pending" || Boolean(current.unsaved));
  $("entry-day").value = current.day;
  $("entry-day").max = dayKey();
  $("entry-day-name").textContent = dayTitle(current.day);
  $("entry-again").classList.toggle("hidden", current.status !== "confirmed");
  $("entry-delete").textContent = current.unsaved ? "Cancel" : "Delete";
  $("entry-delete").classList.toggle("danger", !current.unsaved);
  $("entry-save").disabled = busy || !items.length;
  $("entry-reestimate").disabled = busy;
}

function itemFacts(item) {
  const guess = item.confidence === "low" ? ` · <span class="guess">≈ rough guess</span>` : "";
  const alcohol = item.alcohol > 0 ? ` · alcohol ${fmt(item.alcohol)} g` : "";
  const water = item.fluidMl > 0 ? ` · <span class="drink">💧 ${fmt(item.fluidMl)} ml</span>` : "";
  return `${fmt(item.kcal)} kcal · P ${fmt(item.protein)} · F ${fmt(item.fat)} · C ${fmt(item.carbs)}${alcohol}${water}${guess}`;
}

// Moves the entry to another diary day, keeping its clock time. Applied to storage on Save.
$("entry-day").addEventListener("change", () => {
  const day = $("entry-day").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > dayKey()) {
    $("entry-day").value = current.day; // empty or in the future
    return;
  }
  current.time = timeOnDay(day, new Date(current.time));
  current.day = day;
  $("entry-day-name").textContent = dayTitle(day);
});

// Editing grams scales every nutrient of that item proportionally.
$("entry-items").addEventListener("input", (event) => {
  const li = event.target.closest("li[data-index]");
  const item = current.items[li.dataset.index];
  if (event.target.classList.contains("item-name")) {
    item.name = event.target.value;
    return;
  }
  const grams = Number(event.target.value);
  if (!(grams >= 0) || !item.grams) return;
  const factor = grams / item.grams;
  for (const n of NUTRIENT_FIELDS) item[n] = (item[n] ?? 0) * factor; // older entries have no fluidMl
  item.grams = grams;
  li.querySelector(".item-facts").innerHTML = itemFacts(item);
  const items = current.items;
  $("entry-total").textContent = `${fmt(items.reduce((s, i) => s + i.kcal, 0))} kcal`;
  $("entry-macros").textContent = ["protein", "fat", "carbs"]
    .map((n) => `${n[0].toUpperCase() + n.slice(1)} ${fmt(items.reduce((s, i) => s + i[n], 0))} g`).join(" · ");
});
$("entry-items").addEventListener("click", (event) => {
  if (!event.target.classList.contains("item-remove")) return;
  current.items.splice(event.target.closest("li").dataset.index, 1);
  renderEntry();
});

async function recognize(note = "") {
  const s = settings();
  if (!s.anthropicKey) {
    setEntryStatus("Add your Anthropic key in ⚙︎ Settings, then tap this entry again.", "error");
    return;
  }
  if (!navigator.onLine) {
    setEntryStatus("You're offline. The entry is saved — tap it in Meals when you're back online.", "error");
    return;
  }
  const entry = current;
  busy = true;
  setEntryStatus(note ? "Re-estimating…" : "Recognizing…", "busy");
  renderEntry();
  try {
    const result = await estimate({
      apiKey: s.anthropicKey, model: s.model, images: entryImages(entry), text: entry.text,
      note: note ? `${entry.question ? `You asked: ${entry.question}\nAnswer: ` : ""}${note}\nPrevious estimate: ${JSON.stringify(entry.items.map(({ name, grams }) => ({ name, grams })))}` : "",
    });
    entry.items = result.items;
    entry.question = result.question;
    delete entry.error;
    await putEntry(entry);
    if (current === entry) {
      setEntryStatus(result.items.length ? "Check the grams, then tap Save." : "", "");
      $("entry-note").value = "";
    }
  } catch (error) {
    const { message } = describeError(error);
    entry.error = message;
    await putEntry(entry);
    if (current === entry) setEntryStatus(message, "error");
  } finally {
    busy = false;
    if (current === entry) renderEntry();
    render();
  }
}

function reestimate() {
  if (busy) return;
  const note = $("entry-note").value.trim();
  if (!note && current.items.length) {
    $("entry-note").focus();
    return;
  }
  $("entry-note").blur();
  recognize(note);
}
$("entry-reestimate").addEventListener("click", reestimate);
// Return in the correction field re-estimates instead of submitting (= saving) the form.
$("entry-note").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  reestimate();
});

$("entry-form").addEventListener("submit", async (event) => {
  if (busy || !current.items.length) {
    event.preventDefault();
    return;
  }
  current.status = "confirmed";
  delete current.image; // keep only the thumbnail
  delete current.images;
  delete current.error;
  delete current.unsaved;
  const { day } = current;
  await putEntry(current);
  current = null;
  if (day !== shownDay()) showDay(day);
  else render();
  toast("Saved.");
});

$("entry-later").addEventListener("click", () => entryDialog.close());
$("entry-delete").addEventListener("click", async () => {
  if (current.unsaved) { // a repeat that was never saved: nothing to delete
    entryDialog.close();
    return;
  }
  if (!confirm("Delete this entry?")) return;
  await deleteEntry(current.id);
  entryDialog.close();
  render();
});
entryDialog.addEventListener("close", () => { if (!busy) current = null; });

window.addEventListener("online", async () => {
  const waiting = (await entriesForDay(dayKey())).filter((e) => e.status === "pending" && !e.items.length);
  if (waiting.length) toast(`Back online — tap ${waiting.length === 1 ? "the waiting entry" : "the waiting entries"} in Meals.`);
});

// --- repeat: log a saved meal again, with its thumbnail and numbers, without asking Claude --------
// The copy opens in the entry dialog (grams can be changed) and is stored only when Saved.

const REPEAT_DAYS = 30;
const repeatDialog = $("repeat-dialog");
let repeatChoices = [];

function repeatOf(entry, day) {
  return {
    id: crypto.randomUUID(),
    day,
    time: day === dayKey() ? Date.now() : timeOnDay(day),
    source: entry.source,
    status: "pending",
    unsaved: true,
    thumb: entry.thumb,
    text: entry.text,
    items: structuredClone(entry.items),
    question: "",
    repeatOf: entry.id,
  };
}

function openRepeat(entry, day) {
  repeatDialog.close();
  openEntry(repeatOf(entry, day));
  const where = day === dayKey() ? "today" : dayTitle(day);
  setEntryStatus(`Logging this again for ${where}. Change the grams if needed, then Save.`);
}

$("entry-again").addEventListener("click", () => openRepeat(current, dayKey()));

$("add-repeat").addEventListener("click", async () => {
  const today = dayKey();
  const entries = (await entriesBetween(shiftDay(today, 1 - REPEAT_DAYS), today))
    .filter((e) => e.status === "confirmed" && e.items?.length)
    .sort((a, b) => b.time - a.time);
  // The same meal logged several times shows once: the latest copy, with how often it was eaten.
  const byMeal = new Map();
  for (const entry of entries) {
    const key = entry.items.map((i) => `${i.name.toLowerCase()}:${Math.round(i.grams)}`).sort().join("|");
    const seen = byMeal.get(key);
    if (seen) seen.count++;
    else byMeal.set(key, { entry, count: 1 });
  }
  repeatChoices = [...byMeal.values()];
  $("repeat-list").innerHTML = repeatChoices.map(({ entry, count }, index) => {
    const thumb = entry.thumb
      ? `<img src="${entry.thumb}" alt="">`
      : `<span class="no-thumb">${entry.source === "text" ? "✎" : "📷"}</span>`;
    const when = `${dayTitle(entry.day)}${count > 1 ? ` · ${count}×` : ""}`;
    return `<li data-index="${index}">${thumb}
      <div class="what"><div class="names">${escapeHtml(entry.items.map((i) => i.name).join(", "))}</div>
      <div class="muted small">${when}</div></div>
      <span class="kcal">${fmt(entryKcal(entry))} kcal</span></li>`;
  }).join("");
  $("repeat-empty").classList.toggle("hidden", repeatChoices.length > 0);
  repeatDialog.showModal();
});
$("repeat-list").addEventListener("click", (event) => {
  const li = event.target.closest("li[data-index]");
  if (li) openRepeat(repeatChoices[li.dataset.index].entry, shownDay());
});
$("repeat-close").addEventListener("click", () => repeatDialog.close());

// --- history: calories per day, averages, tap a day to open it -----------------------------------

const statsDialog = $("stats-dialog");
const CHART = { width: 340, height: 150, top: 14, bottom: 18 };
let statsDays = [];
let statsGoal = null;

$("open-stats").addEventListener("click", () => {
  renderStats();
  statsDialog.showModal();
});
$("stats-close").addEventListener("click", () => statsDialog.close());
statsDialog.addEventListener("change", renderStats);

async function renderStats() {
  const count = Number(statsDialog.querySelector("input[name=stats-range]:checked").value);
  const last = dayKey();
  statsGoal = targets(profile());
  statsDays = dailyStats(await entriesBetween(shiftDay(last, 1 - count), last), last, count);
  // Today is still going, so the averages use completed days only.
  const s = summarize(statsDays.slice(0, -1), statsGoal);

  const tile = (label, value, sub) =>
    `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n));
  $("stats-summary").innerHTML = s.loggedDays
    ? tile("Average per day", `${fmt(s.avgKcal)} kcal`, `target ${fmt(statsGoal.kcal)}`)
      + tile("Protein per day", `${fmt(s.avgProtein)} g`, `target ${fmt(statsGoal.protein)} g`)
      + tile("Within target", `${s.daysOnTarget} of ${s.loggedDays}`, "logged days")
      + tile("vs maintenance", `${signed(s.balanceKcal)} kcal`, `≈ ${Math.abs(s.fatKg) >= 1
        ? `${s.fatKg < 0 ? "−" : "+"}${Math.abs(s.fatKg).toFixed(1)} kg`
        : `${signed(s.fatKg * 1000)} g`} of fat`)
      + `<div class="note">Completed days with meals logged; today is not counted yet.</div>`
    : `<div class="note">Averages appear after the first completed day with meals logged.</div>`;

  drawChart();
  $("stats-days").innerHTML = statsDays.slice().reverse().map((d) => `
    <li data-day="${d.day}" class="${d.logged ? "" : "empty"}">
      <span class="when">${d.day === last ? "Today" : shortDate(d.day)}</span>
      <span class="p">${d.logged ? `P ${fmt(d.protein)}` : ""}</span>
      <span class="k">${d.logged ? `${fmt(d.kcal)} kcal` : "—"}</span>
      <span class="flag">${d.logged && d.kcal > statsGoal.kcal ? "▲ over" : ""}</span>
    </li>`).join("");
}

// One bar per day against the dashed target line; tapping a bar shows its numbers above the chart.
function drawChart(selected = statsDays.length - 1) {
  const { width, height, top, bottom } = CHART;
  const n = statsDays.length;
  const max = Math.max(statsGoal.kcal * 1.25, ...statsDays.map((d) => d.kcal));
  const y = (kcal) => top + (height - top - bottom) * (1 - kcal / max);
  const base = height - bottom;
  const slot = width / n;
  const barW = Math.max(slot - 2, 2); // 2px gap between bars
  const r = Math.min(4, barW / 2);
  const parts = [];

  statsDays.forEach((d, i) => {
    const x = i * slot + (slot - barW) / 2;
    const cls = `${!d.logged ? "empty" : d.kcal > statsGoal.kcal ? "over" : "under"}${i === selected ? " selected" : ""}`;
    if (d.logged && d.kcal > 0) {
      const yTop = Math.min(y(d.kcal), base - r);
      // Rounded top, square bottom on the baseline.
      parts.push(`<path class="${cls}" d="M${x},${base} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${base} Z"/>`);
    } else {
      parts.push(`<rect class="${cls}" x="${x}" y="${base - 2}" width="${barW}" height="2"/>`);
    }
    const every = n <= 7 ? 1 : 7;
    if ((n - 1 - i) % every === 0) {
      const label = n <= 7
        ? dateOf(d.day).toLocaleDateString("en-US", { weekday: "short" })
        : dateOf(d.day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      // The last 30-day label hugs the right edge instead of being cut off.
      const [lx, anchor] = n > 7 && i === n - 1 ? [x + barW, "end"] : [x + barW / 2, "middle"];
      parts.push(`<text x="${lx}" y="${height - 4}" text-anchor="${anchor}">${label}</text>`);
    }
    // A full-height hit area, wider than thin 30-day bars.
    parts.push(`<rect class="hit" data-i="${i}" x="${i * slot}" y="0" width="${slot}" height="${base}"/>`);
  });

  const ty = y(statsGoal.kcal);
  parts.push(`<line class="target" x1="0" x2="${width}" y1="${ty}" y2="${ty}"/>`);
  parts.push(`<text class="halo" x="2" y="${ty - 4}">target ${fmt(statsGoal.kcal)}</text>`);

  const chart = $("stats-chart");
  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chart.innerHTML = parts.join("");

  const d = statsDays[selected];
  $("stats-readout").textContent = d.logged
    ? `${shortDate(d.day)} · ${fmt(d.kcal)} kcal · P ${fmt(d.protein)} · F ${fmt(d.fat)} · C ${fmt(d.carbs)}`
    : `${shortDate(d.day)} · nothing logged`;
}

$("stats-chart").addEventListener("click", (event) => {
  const i = event.target.dataset?.i;
  if (i !== undefined) drawChart(Number(i));
});
$("stats-days").addEventListener("click", (event) => {
  const li = event.target.closest("li[data-day]");
  if (!li) return;
  statsDialog.close();
  showDay(li.dataset.day);
});

// --- daily advice: a plan each morning (from yesterday), a review of today on request -------------
// The morning plan is requested automatically on the first open of the day, once; the evening
// review only when the user taps it. Both are kept per day, so reopening the app costs nothing.

const ADVICE_KEEP_DAYS = 7;
let adviceBusy = false;
let adviceError = ""; // shown until the next request
let adviceFailedKind = "morning";
let adviceButtonKind = "evening";
const adviceRequested = new Set(); // one automatic try per day per launch, even if it fails

const adviceStore = () => load("advice", {});
function saveAdvice(day, kind, advice) {
  const all = adviceStore();
  all[day] = { ...all[day], [kind]: { ...advice, at: Date.now() } };
  const oldest = shiftDay(dayKey(), -ADVICE_KEEP_DAYS);
  for (const d of Object.keys(all)) if (d < oldest) delete all[d];
  save("advice", all);
}

function renderAdvice(day, entries) {
  const card = $("advice-card");
  const today = dayKey();
  if (day !== today || !settings().anthropicKey) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const stored = adviceStore()[today] ?? {};
  const shown = stored.evening ?? stored.morning;
  const hasMeals = entries.some((e) => e.status === "confirmed");

  $("advice-title").textContent = stored.evening ? "Today's review" : "Today's plan";
  $("advice-headline").textContent = shown?.headline ?? "";
  $("advice-tips").innerHTML = (shown?.tips ?? []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  // Collapsed by default: only the headline, so the card never takes over the screen.
  const open = Boolean(shown?.tips?.length) && adviceOpen(today);
  card.classList.toggle("collapsed", !open);
  $("advice-toggle").setAttribute("aria-expanded", String(open));
  $("advice-toggle").classList.toggle("no-tips", !shown?.tips?.length);

  // The button reviews today in the evening, or retries whatever just failed.
  adviceButtonKind = adviceError ? adviceFailedKind : "evening";
  $("advice-review").textContent = adviceError ? "Try again" : stored.evening ? "Update review" : "Review today";
  $("advice-review").classList.toggle("hidden", adviceBusy || !(adviceError || (hasMeals && isEvening())));

  if (adviceBusy) return;
  if (adviceError) {
    setAdviceStatus(adviceError, "error");
  } else if (!shown) {
    setAdviceStatus(hasMeals
      ? (isEvening() ? "Tap Review today for a review of your day." : `A review of today opens here at ${REVIEW_FROM_HOUR}:00.`)
      : "Your plan appears here each morning, based on the day before. Log your meals to get it.");
  } else {
    setAdviceStatus("");
  }
  // First open of the day: ask for the morning plan if yesterday has meals to learn from.
  if (!stored.morning && !adviceRequested.has(today) && navigator.onLine) {
    adviceRequested.add(today);
    entriesForDay(shiftDay(today, -1)).then((list) => {
      if (list.some((e) => e.status === "confirmed")) requestAdvice("morning");
    });
  }
}

// The review is for the end of the day: from 18:00 until the diary day ends at 04:00.
const REVIEW_FROM_HOUR = 18;
function isEvening(now = new Date()) {
  return now.getHours() >= REVIEW_FROM_HOUR || now.getHours() < DAY_START_HOUR;
}

// Expanded or collapsed, remembered for today only.
const adviceOpen = (day) => load("adviceOpen", {})[day] === true;
const setAdviceOpen = (day, open) => save("adviceOpen", { [day]: open });
function toggleAdvice() {
  if (!$("advice-tips").children.length) return;
  const open = $("advice-card").classList.contains("collapsed");
  setAdviceOpen(dayKey(), open);
  $("advice-card").classList.toggle("collapsed", !open);
  $("advice-toggle").setAttribute("aria-expanded", String(open));
}
$("advice-toggle").addEventListener("click", toggleAdvice);
$("advice-headline").addEventListener("click", toggleAdvice);

function setAdviceStatus(text, kind = "") {
  $("advice-status").textContent = text;
  $("advice-status").className = `status-line ${kind}`;
}

async function requestAdvice(kind) {
  if (adviceBusy) return;
  const today = dayKey();
  adviceBusy = true;
  adviceError = "";
  $("advice-review").classList.add("hidden");
  setAdviceStatus(kind === "morning" ? "Preparing today's plan…" : "Reviewing today…", "busy");
  try {
    const s = settings();
    const advice = await dailyAdvice({ apiKey: s.anthropicKey, model: s.model, kind, context: await adviceContext(kind) });
    saveAdvice(today, kind, advice);
    if (kind === "evening") setAdviceOpen(today, true); // asked for it, so show it in full
  } catch (error) {
    adviceError = describeError(error).message;
    adviceFailedKind = kind;
  }
  adviceBusy = false;
  render();
}
$("advice-review").addEventListener("click", () => requestAdvice(adviceButtonKind));

// What Claude sees: profile, targets, the last 7 days, the focus day's foods, weight trend and the
// foods the user eats most (so suggestions are things they actually have).
async function adviceContext(kind) {
  const p = profile();
  const goal = targets(p);
  const today = dayKey();
  const focusDay = kind === "morning" ? shiftDay(today, -1) : today;
  const monthEntries = await entriesBetween(shiftDay(today, -29), today);
  const days = dailyStats(monthEntries, focusDay, 7);
  const water = await Promise.all(days.map((d) => waterForDay(d.day)));
  const round = (n) => Math.round(n);
  const recentDays = days.map((d, i) => ({
    day: d.day,
    weekday: dateOf(d.day).toLocaleDateString("en-US", { weekday: "short" }),
    logged: d.logged,
    ...(d.logged ? {
      kcal: round(d.kcal), protein: round(d.protein), fat: round(d.fat), carbs: round(d.carbs),
      fiber: round(d.fiber), alcoholG: round(d.alcohol),
    } : {}),
    waterMl: round(water[i] + d.fluidMl),
  }));
  const focusFoods = monthEntries
    .filter((e) => e.day === focusDay && e.status === "confirmed")
    .sort((a, b) => a.time - b.time)
    .map((e) => ({
      time: new Date(e.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      items: e.items.map((i) => `${i.name} ${round(i.grams)} g (${round(i.kcal)} kcal, P ${round(i.protein)})`),
    }));
  const counts = new Map();
  for (const e of monthEntries) {
    if (e.status !== "confirmed") continue;
    for (const i of e.items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  }
  const usualFoods = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name]) => name);

  const weights = await allWeights();
  const t = weightTrend(weights);
  const recent = weightTrend(weights, shiftDay(today, -30));
  return {
    today,
    timeNow: kind === "evening" ? new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : undefined,
    profile: {
      sex: p.sex, age: new Date().getFullYear() - p.birthYear, heightCm: p.heightCm, weightKg: p.weightKg,
      bodyFatPct: p.bodyFatPct, goal: p.goal, plannedLossPctPerWeek: p.goal === "cut" ? p.pacePct : 0,
      strengthSessionsPerWeek: p.strengthPerWeek,
    },
    dailyTargets: { kcal: goal.kcal, protein: goal.protein, fat: goal.fat, carbs: goal.carbs, fiber: goal.fiber, waterMl: goal.waterMl },
    focusDay,
    focusDayFoods: focusFoods,
    recentDays,
    weight: t.last ? {
      latestKg: t.last.kg,
      daysSinceWeighIn: daysBetween(t.last.day, today),
      kgPerWeekLast30Days: recent.perWeek,
      plannedKgPerWeek: p.goal === "cut" ? -Math.round((p.pacePct / 100) * t.last.kg * 100) / 100 : 0,
    } : null,
    usualFoods,
  };
}

// --- weight: weekly weigh-ins, chart, rate per week vs the plan -----------------------------------
// The latest weigh-in is also the profile weight, so the daily targets follow it.

const WEIGH_EVERY_DAYS = 7;
const WEIGHT_CHART = { width: 340, height: 170, top: 12, bottom: 18, left: 30, right: 8 };
const weightDialog = $("weight-dialog");
const weightForm = $("weight-form");
let weightView = null; // { trend, points, startDay, endDay, byWeek } for the chart taps

const kgText = (kg) => `${kg.toFixed(1)} kg`;
const signedKg = (kg, digits = 1) => `${kg > 0 ? "+" : kg < 0 ? "−" : "±"}${Math.abs(kg).toFixed(digits)}`;

async function renderWeightCard() {
  const weights = await allWeights();
  const card = $("weight-card");
  const t = weightTrend(weights);
  if (!t.last) {
    $("weight-now").textContent = "";
    $("weight-sub").textContent = "Tap to log your weight — once a week is enough.";
    card.classList.add("due");
    return;
  }
  const since = daysBetween(t.last.day, dayKey());
  const recent = weightTrend(weights, shiftDay(dayKey(), -30));
  const parts = [];
  if (recent.perWeek !== null) parts.push(`${signedKg(recent.perWeek, 2)} kg/week`);
  parts.push(since === 0 ? "weighed today" : since === 1 ? "weighed yesterday" : `weighed ${since} days ago`);
  if (since >= WEIGH_EVERY_DAYS) parts.push("time to weigh in");
  $("weight-now").textContent = kgText(t.last.kg);
  $("weight-sub").textContent = parts.join(" · ");
  card.classList.toggle("due", since >= WEIGH_EVERY_DAYS);
}

function openWeight() {
  weightForm.reset();
  weightForm.elements.day.value = dayKey();
  weightForm.elements.day.max = dayKey();
  allWeights().then((weights) => {
    const last = weightTrend(weights).last;
    weightForm.elements.kg.value = (last?.kg ?? profile().weightKg).toFixed(1);
  });
  renderWeight();
  weightDialog.showModal();
}
$("weight-card").addEventListener("click", openWeight);
$("weight-card").addEventListener("keydown", (event) => { if (event.key === "Enter") openWeight(); });
$("weight-close").addEventListener("click", () => weightDialog.close());
for (const group of weightDialog.querySelectorAll(".weight-range, .weight-view")) {
  group.addEventListener("change", () => renderWeight());
}

weightForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const kg = Math.round(Number(weightForm.elements.kg.value) * 10) / 10;
  const day = weightForm.elements.day.value;
  if (!(kg >= 35 && kg <= 250) || !day || day > dayKey()) return;
  await putWeight(day, kg);
  await afterWeightChange();
  toast(`Saved ${kgText(kg)}.`);
});

// Keeps the profile weight equal to the latest weigh-in and redraws everything that depends on it.
async function afterWeightChange() {
  const latest = weightTrend(await allWeights()).last;
  const p = profile();
  if (latest && p && latest.kg !== p.weightKg) {
    save("profile", { ...p, weightKg: latest.kg });
    setTimeout(() => toast(`Targets updated for ${kgText(latest.kg)}.`), 1500);
  }
  render();
  renderWeight();
}

async function renderWeight() {
  const range = weightDialog.querySelector("input[name=weight-range]:checked").value;
  const today = dayKey();
  const all = await allWeights();
  const startDay = range === "all" ? (weightTrend(all).first?.day ?? today) : shiftDay(today, 1 - Number(range));
  const t = weightTrend(all, startDay);
  const p = profile();
  const goal = targets(p);

  const tile = (label, value, sub) =>
    `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  if (!t.last) {
    $("weight-summary").innerHTML = `<div class="note">No weigh-ins in this period yet.</div>`;
  } else {
    const planPerWeek = p.goal === "cut" ? -(p.pacePct / 100) * t.last.kg : 0;
    let paceTile;
    if (t.perWeek === null) {
      paceTile = tile("Per week", "—", "needs 2 weigh-ins a week apart");
    } else {
      paceTile = tile("Per week", `${signedKg(t.perWeek, 2)} kg`, p.goal === "cut" ? `plan ${signedKg(planPerWeek, 2)} kg` : "");
    }
    $("weight-summary").innerHTML =
      tile("Now", kgText(t.last.kg), shortDate(t.last.day))
      + tile("Change", `${signedKg(t.change)} kg`, `since ${shortDate(t.first.day)}`)
      + paceTile
      + tile("Verdict", ...paceVerdict(p, t, goal));
  }
  // "Weeks": one point and one row per Monday–Sunday week. The week's weight is the average of
  // however many weigh-ins it has, drawn mid-week; that week's eating is shown next to it.
  const byWeek = weightDialog.querySelector("input[name=weight-view]:checked").value === "weeks";
  let weeks = [];
  if (byWeek) {
    const count = daysBetween(startDay, today) + 1;
    const days = dailyStats(await entriesBetween(startDay, today), today, count);
    weeks = weeklySummary(t.points, days.filter((d) => d.day !== today)); // today isn't finished yet
  }
  const points = byWeek
    ? weeks.filter((w) => w.kg !== null).map((w) => ({
      day: w.mid < startDay ? startDay : w.mid > today ? today : w.mid, // keep the point inside the chart
      kg: w.kg, start: w.week, weighIns: w.weighIns,
    }))
    : t.points;
  weightView = { trend: t, points, startDay, endDay: today, byWeek };
  drawWeightChart();

  if (byWeek) {
    const thisWeek = weekStart(today);
    $("weight-list").innerHTML = weeks.slice().reverse().map((w) => {
      const eating = w.loggedDays
        ? `${fmt(w.avgKcal)} kcal · P ${fmt(w.avgProtein)} g · ${w.loggedDays} day${w.loggedDays > 1 ? "s" : ""} logged`
        : "no meals logged";
      const weighIns = w.weighIns > 1 ? ` · avg of ${w.weighIns} weigh-ins` : "";
      return `<li class="week-row${w.kg === null ? " empty" : ""}">
        <div class="when">${w.week === thisWeek ? "This week" : weekLabel(w.week)}
          <div class="muted small">${eating}${weighIns}</div></div>
        <span class="p">${w.change !== null ? signedKg(w.change) : ""}</span>
        <span class="k">${w.kg !== null ? kgText(w.kg) : "—"}</span>
      </li>`;
    }).join("") || `<li class="empty"><span class="when">Nothing in this period yet</span></li>`;
    return;
  }
  const newestFirst = weightTrend(all).points.slice().reverse();
  $("weight-list").innerHTML = newestFirst.map((w, i) => {
    const prev = newestFirst[i + 1];
    const diff = prev ? signedKg(Math.round((w.kg - prev.kg) * 10) / 10) : "";
    return `<li data-day="${w.day}">
      <span class="when">${w.day === today ? "Today" : shortDate(w.day)}</span>
      <span class="p">${diff}</span>
      <span class="k">${kgText(w.kg)}</span>
      <button type="button" class="item-remove" data-delete="${w.day}" aria-label="Delete">✕</button>
    </li>`;
  }).join("");
}

// "Sep 28 – Oct 4"
function weekLabel(start) {
  const short = (day) => dateOf(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${short(start)} – ${short(shiftDay(start, 6))}`;
}

// For a cut: on track between the chosen pace (minus a little slack) and 1 % a week.
function paceVerdict(p, t, goal) {
  if (t.perWeek === null) return ["—", "weigh in again next week"];
  const lossPct = (-t.perWeek / t.last.kg) * 100;
  if (p.goal !== "cut") return [Math.abs(lossPct) < 0.25 ? "Stable" : t.perWeek < 0 ? "Losing" : "Gaining", `${Math.abs(lossPct).toFixed(2)} % a week`];
  if (lossPct > 1) return ["Too fast", "over 1 % a week: muscle at risk — eat a bit more"];
  if (lossPct < p.pacePct - 0.25) return ["Slower", `${lossPct.toFixed(2)} % vs ${p.pacePct} % planned · target ${fmt(goal.kcal)} kcal`];
  return ["On track", `${lossPct.toFixed(2)} % a week, plan ${p.pacePct} %`];
}

// A line through the weigh-ins over time, with the planned pace as a dashed line for a cut.
function drawWeightChart(selected) {
  const { trend: t, points: pts, startDay, endDay, byWeek } = weightView;
  const { width, height, top, bottom, left, right } = WEIGHT_CHART;
  const chart = $("weight-chart");
  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!pts.length) {
    chart.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle">Log a weigh-in to start the chart</text>`;
    $("weight-readout").textContent = "";
    return;
  }
  const p = profile();
  const span = Math.max(daysBetween(startDay, endDay), 7);
  const x = (day) => left + (width - left - right) * (daysBetween(startDay, day) / span);
  const plan = p.goal === "cut" ? (day) => t.first.kg * (1 - (p.pacePct / 100) * (daysBetween(t.first.day, day) / 7)) : null;
  const values = pts.map((w) => w.kg);
  if (plan) values.push(plan(endDay));
  let lo = Math.floor(Math.min(...values) - 0.5);
  let hi = Math.ceil(Math.max(...values) + 0.5);
  if (hi - lo < 2) { lo -= 1; hi += 1; }
  const y = (kg) => top + (height - top - bottom) * (1 - (kg - lo) / (hi - lo));
  const parts = [];

  for (const kg of [lo, (lo + hi) / 2, hi]) { // three gridlines with labels
    parts.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y(kg)}" y2="${y(kg)}"/>`);
    parts.push(`<text x="${left - 4}" y="${y(kg) + 3}" text-anchor="end">${Number.isInteger(kg) ? kg : kg.toFixed(1)}</text>`);
  }
  for (const day of [startDay, endDay]) {
    const label = dateOf(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    parts.push(`<text x="${x(day)}" y="${height - 4}" text-anchor="${day === startDay ? "start" : "end"}">${label}</text>`);
  }
  if (plan) {
    parts.push(`<line class="plan" x1="${x(t.first.day)}" y1="${y(t.first.kg)}" x2="${x(endDay)}" y2="${y(plan(endDay))}"/>`);
    parts.push(`<text class="halo" x="${x(endDay) - 2}" y="${y(plan(endDay)) - 5}" text-anchor="end">plan</text>`);
  }
  parts.push(`<path class="line" d="${pts.map((w, i) => `${i ? "L" : "M"}${x(w.day)},${y(w.kg)}`).join(" ")}"/>`);
  const sel = selected ?? pts.length - 1;
  pts.forEach((w, i) => {
    parts.push(`<circle class="dot${i === sel ? " selected" : ""}" cx="${x(w.day)}" cy="${y(w.kg)}" r="${i === sel ? 4.5 : 3.5}"/>`);
    parts.push(`<circle class="hit" data-i="${i}" cx="${x(w.day)}" cy="${y(w.kg)}" r="14"/>`);
  });
  chart.innerHTML = parts.join("");

  const w = pts[sel];
  const vsPlan = plan ? ` · plan ${plan(w.day).toFixed(1)}` : "";
  $("weight-readout").textContent = byWeek
    ? `${weekLabel(w.start)} · ${kgText(w.kg)}${w.weighIns > 1 ? ` (avg of ${w.weighIns})` : ""}${vsPlan}`
    : `${shortDate(w.day)} · ${kgText(w.kg)}${vsPlan}`;
}

$("weight-chart").addEventListener("click", (event) => {
  const i = event.target.dataset?.i;
  if (i !== undefined) drawWeightChart(Number(i));
});
$("weight-list").addEventListener("click", async (event) => {
  const del = event.target.dataset?.delete;
  if (del) {
    if (!confirm("Delete this weigh-in?")) return;
    await deleteWeight(del);
    await afterWeightChange();
    return;
  }
  const li = event.target.closest("li[data-day]"); // tap a row to correct it in the form above
  if (!li) return;
  const w = weightTrend(await allWeights()).points.find((p) => p.day === li.dataset.day);
  weightForm.elements.kg.value = w.kg.toFixed(1);
  weightForm.elements.day.value = w.day;
  weightForm.elements.kg.focus();
});

// --- profile -------------------------------------------------------------------------------------

const profileForm = $("profile-form");
$("activity-select").innerHTML = Object.entries(ACTIVITY)
  .map(([value, { label }]) => `<option value="${value}">${label}</option>`).join("");
$("goal-select").innerHTML = Object.entries(GOALS)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

function readProfileForm() {
  const f = new FormData(profileForm);
  const num = (name) => Number(f.get(name));
  return {
    sex: f.get("sex"),
    birthYear: num("birthYear"),
    heightCm: num("heightCm"),
    weightKg: num("weightKg"),
    bodyFatPct: f.get("bodyFatPct") ? num("bodyFatPct") : null,
    activity: f.get("activity"),
    strengthPerWeek: num("strengthPerWeek"),
    goal: f.get("goal"),
    pacePct: num("pacePct"),
  };
}

function fillProfileForm(p) {
  for (const [name, value] of Object.entries(p)) {
    const field = profileForm.elements[name];
    if (!field) continue;
    if (field instanceof RadioNodeList) {
      for (const radio of field) radio.checked = radio.value === value;
    } else {
      field.value = value ?? "";
    }
  }
}

function updateProfilePreview() {
  const p = readProfileForm();
  $("pace-field").hidden = p.goal !== "cut";
  if (!profileForm.checkValidity()) {
    $("profile-preview").textContent = "Fill in the fields to see your targets.";
    $("strength-tip").textContent = "";
    return;
  }
  const t = targets(p);
  const why = [`BMR ${fmt(t.bmr)}`, `TDEE ${fmt(t.tdee)}`];
  if (p.goal === "cut") why.push(`deficit ${fmt(t.deficit)} → ≈${t.weeklyLossKg} kg/week`);
  $("profile-preview").innerHTML = `
    <b>${fmt(t.kcal)} kcal</b> · protein ${t.protein} g · fat ${t.fat} g · carbs ${t.carbs} g<br>
    <span class="muted small">${why.join(" · ")}</span>`;

  const tips = [];
  if (p.goal === "cut" && p.strengthPerWeek < 2) {
    tips.push("Add 2–3 strength sessions a week. In a calorie deficit, without them your body loses muscle along with fat — no diet can make up for that.");
  }
  if (t.atBmrFloor) {
    tips.push("Your target is held at your BMR, so you will lose weight slower than the chosen pace. A smaller deficit is easier to sustain anyway.");
  }
  $("strength-tip").textContent = tips.join(" ");
}

function openProfile() {
  const p = profile();
  fillProfileForm(p ?? DEFAULT_PROFILE);
  $("profile-cancel").hidden = !p; // first run: a profile is required
  updateProfilePreview();
  $("profile-dialog").showModal();
}

profileForm.addEventListener("input", updateProfilePreview);
profileForm.addEventListener("submit", () => {
  const before = profile();
  const p = readProfileForm();
  save("profile", p);
  if (!before) requestPersistence();
  // A weight typed into the profile is also today's weigh-in, so the chart has it.
  if (!before || before.weightKg !== p.weightKg) putWeight(dayKey(), p.weightKg).then(render);
  else render();
});
$("profile-cancel").addEventListener("click", () => $("profile-dialog").close());
$("profile-dialog").addEventListener("cancel", (event) => { if (!profile()) event.preventDefault(); });

// --- settings ------------------------------------------------------------------------------------

const settingsForm = $("settings-form");
$("model-select").innerHTML = Object.entries(MODELS)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

$("open-settings").addEventListener("click", () => {
  const s = settings();
  settingsForm.elements.anthropicKey.value = s.anthropicKey;
  settingsForm.elements.model.value = s.model;
  $("key-note").textContent = "Stored only on this phone. Used to recognize food photos.";
  $("settings-dialog").showModal();
});
settingsForm.addEventListener("submit", () => {
  save("settings", {
    anthropicKey: settingsForm.elements.anthropicKey.value.trim(),
    model: settingsForm.elements.model.value,
  });
});
$("settings-cancel").addEventListener("click", () => $("settings-dialog").close());

// --- scan the key from the laptop's QR code (tools/show_keys_qr.py in the VoiceToText repo) -------
// The QR holds "VTT-KEYS:" + JSON {groq, anthropic}; only the Anthropic key is used here.
// It is decoded on the phone; nothing is sent anywhere.

const QR_PREFIX = "VTT-KEYS:";
const scanner = $("scanner");
const scannerVideo = $("scanner-video");
let scanStream = null;
let scanFrame = null;

function stopScanning() {
  cancelAnimationFrame(scanFrame);
  scanFrame = null;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  if (scanner.open) scanner.close();
}

function applyScannedKey(text) {
  let keys;
  try {
    keys = JSON.parse(text.slice(QR_PREFIX.length));
  } catch {
    return false;
  }
  if (!keys.anthropic?.startsWith("sk-ant-")) return false;
  settingsForm.elements.anthropicKey.value = keys.anthropic;
  save("settings", { ...settings(), anthropicKey: keys.anthropic });
  return true;
}

$("scan-keys").addEventListener("click", async () => {
  const status = $("scanner-status");
  status.textContent = "Starting camera…";
  scanner.showModal();
  try {
    const { default: jsQR } = await import("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm");
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    scannerVideo.srcObject = scanStream;
    await scannerVideo.play();
    status.textContent = "Looking for the QR code…";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (!scanStream) return;
      if (scannerVideo.readyState >= 2) {
        canvas.width = scannerVideo.videoWidth;
        canvas.height = scannerVideo.videoHeight;
        ctx.drawImage(scannerVideo, 0, 0);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (code?.data.startsWith(QR_PREFIX)) {
          if (applyScannedKey(code.data)) {
            stopScanning();
            $("key-note").textContent = "Key added from the laptop and saved.";
            navigator.vibrate?.(30);
            return;
          }
          status.textContent = "That QR code doesn't contain an Anthropic key.";
        }
      }
      scanFrame = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    status.textContent = "Camera not available. Allow camera access for this app in iPhone Settings.";
  }
});
$("scanner-cancel").addEventListener("click", stopScanning);
scanner.addEventListener("close", stopScanning);
$("edit-profile").addEventListener("click", () => {
  $("settings-dialog").close();
  openProfile();
});

// --- start ---------------------------------------------------------------------------------------

if (profile()) render();
else openProfile();
