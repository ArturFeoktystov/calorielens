// CalorieLens for iPhone: photo of a meal -> calories and macros -> what is left for today.
// Step 1: profile, daily targets, home screen, water. The API key lives only in this browser's storage.

import { ACTIVITY, GOALS, DEFAULT_PROFILE, targets, dayKey, totals } from "./nutrition.js";
import { load, save, entriesForDay, waterForDay, setWater, requestPersistence } from "./db.js";

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
    const names = entry.status === "pending" ? "Waiting for recognition…" : entry.items.map((i) => i.name).join(", ");
    const kcal = entry.items.reduce((sum, i) => sum + (i.kcal ?? 0), 0);
    return `<li><span class="muted">${time}</span> ${escapeHtml(names)} <span class="muted">${fmt(kcal)} kcal</span></li>`;
  }).join("");
}

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
