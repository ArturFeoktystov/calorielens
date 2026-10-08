# CalorieLens

A calorie tracker for iPhone, built for a cut: lose fat, keep muscle. Snap a photo of your meal →
Claude recognizes the food and estimates grams, calories, protein, fat and carbs → you confirm →
the home screen shows what is left for today.

It is a web app you add to the home screen. No App Store, no server, no sign-up. This repository
contains **no API keys**: each user types their own Anthropic key in Settings, and it is stored only
in that phone's browser storage. All diary data stays on the phone.

Status: **steps 1–2 of the MVP** — profile, targets, home screen, water; photo or text → Claude → confirm → diary; past days and a 7/30-day history.

## Install on iPhone

1. Open <https://arturfeoktystov.github.io/calorielens/> in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it from the home screen and fill in your profile.
4. Add your Anthropic key: on the laptop run VoiceToText's QR tool
   (`.venv\Scripts\python.exe tools\show_keys_qr.py` in the VoiceToText folder), then on the phone
   tap **⚙︎** → **Scan key from laptop** and point the camera at the QR code. The same QR works
   for both apps; CalorieLens takes only the Anthropic key. Or paste the key (`sk-ant-…`) by hand.

Data entered in Safari and in the home-screen app is stored separately — use the home-screen app.

## Daily targets

| What | Rule |
|---|---|
| BMR | Mifflin–St Jeor: `10·kg + 6.25·cm − 5·age + 5` (men) / `− 161` (women) |
| TDEE | BMR × activity: 1.2 · 1.375 · 1.55 · 1.725 |
| Cut | deficit = `pace (% body weight/week) × kg × 7700 / 7`, capped at 25 % of TDEE; default pace 0.7 % |
| Floor | calories never go below BMR |
| Protein | 2.2 g/kg, or 2.7 g/kg of lean mass when body fat % is known |
| Fat | 0.8 g/kg, at least 20 % of calories |
| Carbs | the rest |
| Fiber | 14 g per 1000 kcal, at least 25 g |
| Water | 35 ml/kg: plain water buttons + drinks logged as food (tea, coffee, milk, soft drinks, juice); not alcohol or soup |
| Sugar, alcohol | shown, no target |

A new day starts at **04:00**, so a 00:30 snack belongs to the day before.

**Weight**: weigh in once a week (same day, morning, before eating). The Weight card opens a chart
(1 month / 3 months / 6 months / all) with the planned pace as a dashed line, the change, the rate per week
(a least-squares line through the weigh-ins, so one odd reading doesn't swing it) and a verdict:
on track between the chosen pace − 0.25 % and 1 % a week, "too fast" above 1 % (muscle at risk).
The latest weigh-in is the profile weight, so the targets follow it. **Weekly average** (next to **Each weigh-in**) shows one row per
Monday–Sunday week: the average of all that week's weigh-ins (one or several, drawn mid-week), the change from the previous week, and that week's
average calories and protein (finished days only), so eating and weight sit side by side.

**Weekly report** every Monday. A target change (±100–150 kcal) is proposed at most every 2 weeks,
only with weigh-ins at least 2 weeks apart, always with your confirmation, and never below BMR.

## Decisions

- **Platform**: home-screen web app, iPhone only, plain HTML/JS, hosted on GitHub Pages.
- **Language and units**: English UI, metric units. Food can be described in any language; names
  are saved in English.
- **Recognition**: Claude Sonnet 5.5 by default (model selectable in Settings). Every photo goes
  through a confirmation screen where grams can be edited.
- **Food data**: ~200 common foods from USDA FoodData Central (CC0) bundled as JSON; anything else
  is the model's estimate, marked "≈". Every manual correction is saved to **My foods**.
- **Input**: photo (camera, or an earlier photo from the album; every entry has a Day field to put it on any day), text (voice = the iPhone keyboard's dictation button), repeat a past meal,
  barcode (photo of the barcode → Open Food Facts; if missing, photo of the nutrition label →
  Claude reads it → saved to My foods).
- **Offline**: entries are saved as *pending* and recognized when the network is back.
- **Diary**: a time-ordered feed, no meal categories, a thumbnail for each entry; past days can be
  edited.
- **Advice**: every morning, on the first open of the day, Claude writes **Today's plan** from
  yesterday's meals, the last 7 days (calories, protein, fiber, water), the weight trend and the
  foods you usually eat; it shows collapsed (headline only, tap to expand). **Review today** appears
  from 18:00 and asks for a review of the day so far. One small request
  each (effort low, ~$0.01), cached for the day. Later: a rule-based hint for what is left, weekly
  report on Mondays.
- **Reminders**: the app icon badge shows calories left (0 when over); an iOS Shortcuts automation
  sends "Check CalorieLens" at 13:00, 17:00 and 20:30. A push server with real numbers is a later
  stage.
- **Storage**: IndexedDB on the phone, persistent storage requested; JSON export/import through
  Files, with a banner when the last backup is old.

## MVP plan

1. ✅ Profile, daily targets, home screen, water.
2. ✅ Photo → recognition → confirmation → diary; text input; pending queue.
   Plus: ‹ › to open past days (view, edit, log afterwards); History with calories per day,
   averages, days within target and the balance against maintenance.
3. ✅ Repeat (log a saved meal again, no new photo). Next: My foods, USDA table, barcode and label.
4. ✅ Weight log and chart. Next: weekly report, target adjustment, badge.
5. ✅ Daily plan and review from Claude. Next: rule-based hints, export/import, Shortcuts instructions.

Later: push server with numbers, auto-save when the model is confident, Haiku quality check on
real photos, training/rest-day targets, free-form advice chat.

## Development

```
npx serve -l 5173 .        # open http://localhost:5173
node --test                # unit tests for the target math
```

| File | What it is |
|---|---|
| `index.html`, `style.css` | The screens |
| `app.js` | UI: home screen, adding food, confirmation, profile, settings |
| `recognize.js` | Claude prompt, JSON schema and API call for food recognition |
| `advice.js` | Claude prompt and API call for the daily plan and review |
| `nutrition.js` | Target math and day boundaries (pure functions, tested) |
| `db.js` | IndexedDB storage |
| `manifest.webmanifest`, `icons/` | Home-screen name and icon |
| `sw.js` | Service worker: fresh files on every launch, last copy for offline |
