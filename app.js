// CalorieLens for iPhone: photo of a meal -> calories and macros -> what is left for today.
// Steps 1–2: profile, targets, home screen, water; photo/text -> Claude -> confirm -> diary.
// The API key lives only in this browser's storage.

import { ACTIVITY, GOALS, DEFAULT_PROFILE, targets, dayKey, totals } from "./nutrition.js?v=4";
import {
  load, save, entriesForDay, getEntry, putEntry, deleteEntry, waterForDay, setWater, requestPersistence,
} from "./db.js?v=4";
import { estimate, describeError, NUTRIENT_FIELDS } from "./recognize.js?v=4";

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

async function render() {
  const p = profile();
  if (!p) return;
  const day = dayKey();
  const goal = targets(p);
  const [entries, waterMl] = await Promise.all([entriesForDay(day), waterForDay(day)]);
  const eaten = totals(entries);

  const [y, m, d] = day.split("-").map(Number);
  $("date").textContent = new Date(y, m - 1, d)
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

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

  $("water-text").textContent = `${(waterMl / 1000).toFixed(2)} / ${(goal.waterMl / 1000).toFixed(1)} L`;
  $("water-fill").style.width = `${Math.min(waterMl / goal.waterMl, 1) * 100}%`;

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
    const day = dayKey();
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
$("entry-add-photo").addEventListener("click", () => {
  addingPhoto = true;
  $("photo-input").click();
});
$("photo-input").addEventListener("change", async () => {
  const file = $("photo-input").files[0];
  $("photo-input").value = ""; // allow picking the same photo again
  if (!file) return;
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
});

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

function newEntry(source) {
  const now = new Date();
  return { id: crypto.randomUUID(), day: dayKey(now), time: now.getTime(), source, status: "pending", items: [], question: "" };
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
  const sum = Object.fromEntries(NUTRIENT_FIELDS.map((n) => [n, items.reduce((s, i) => s + i[n], 0)]));
  $("entry-thumb").src = current.thumb || "";
  $("entry-thumb").classList.toggle("hidden", !current.thumb);
  $("entry-total").textContent = items.length ? `${fmt(sum.kcal)} kcal` : (current.text ? "Text entry" : "Photo");
  $("entry-macros").textContent = items.length
    ? `Protein ${fmt(sum.protein)} g · Fat ${fmt(sum.fat)} g · Carbs ${fmt(sum.carbs)} g`
    : (current.text ?? "");
  $("entry-question").textContent = current.question || "";
  // The question is answered in the correction field (or by editing grams).
  $("entry-note").placeholder = current.question
    ? "Answer here, e.g. “half the bag”, or just edit the grams"
    : "Correct it: “fried in 1 tbsp oil”, “rice 200 g”…";

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
  $("entry-later").classList.toggle("hidden", current.status !== "pending");
  $("entry-save").disabled = busy || !items.length;
  $("entry-reestimate").disabled = busy;
}

function itemFacts(item) {
  const guess = item.confidence === "low" ? ` · <span class="guess">≈ rough guess</span>` : "";
  const alcohol = item.alcohol > 0 ? ` · alcohol ${fmt(item.alcohol)} g` : "";
  return `${fmt(item.kcal)} kcal · P ${fmt(item.protein)} · F ${fmt(item.fat)} · C ${fmt(item.carbs)}${alcohol}${guess}`;
}

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
  for (const n of NUTRIENT_FIELDS) item[n] *= factor;
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
  await putEntry(current);
  current = null;
  render();
  toast("Saved.");
});

$("entry-later").addEventListener("click", () => entryDialog.close());
$("entry-delete").addEventListener("click", async () => {
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
  const firstRun = !profile();
  save("profile", readProfileForm());
  if (firstRun) requestPersistence();
  render();
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
