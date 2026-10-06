# CalorieLens

A calorie tracker for iPhone, built for a cut: lose fat, keep muscle. Snap a photo of your meal →
Claude recognizes the food and estimates grams, calories, protein, fat and carbs → you confirm →
the home screen shows what is left for today.

It is a web app you add to the home screen. No App Store, no server, no sign-up. This repository
contains **no API keys**: each user types their own Anthropic key in Settings, and it is stored only
in that phone's browser storage. All diary data stays on the phone.

Status: **step 1 of the MVP** — profile, daily targets, home screen, water.

## Install on iPhone

1. Open <https://arturfeoktystov.github.io/calorielens/> in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it from the home screen, fill in your profile, then tap **⚙︎** and paste your Anthropic
   key (`sk-ant-…`).

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
| Water | 35 ml/kg; tea and coffee count, soup does not |
| Sugar, alcohol | shown, no target |

A new day starts at **04:00**, so a 00:30 snack belongs to the day before.

**Weekly report** every Monday. A target change (±100–150 kcal) is proposed at most every 2 weeks,
only with at least 10 weigh-ins in the last 14 days, always with your confirmation, and never
below BMR.

## Decisions

- **Platform**: home-screen web app, iPhone only, plain HTML/JS, hosted on GitHub Pages.
- **Language and units**: English UI, metric units. Food can be described in any language; names
  are saved in English.
- **Recognition**: Claude Sonnet 5.5 by default (model selectable in Settings). Every photo goes
  through a confirmation screen where grams can be edited.
- **Food data**: ~200 common foods from USDA FoodData Central (CC0) bundled as JSON; anything else
  is the model's estimate, marked "≈". Every manual correction is saved to **My foods**.
- **Input**: photo, text (voice = the iPhone keyboard's dictation button), repeat a past meal,
  barcode (photo of the barcode → Open Food Facts; if missing, photo of the nutrition label →
  Claude reads it → saved to My foods).
- **Offline**: entries are saved as *pending* and recognized when the network is back.
- **Diary**: a time-ordered feed, no meal categories, a thumbnail for each entry; past days can be
  edited.
- **Advice**: a rule-based hint on the home screen for what is left (suggestions from your own
  history first, then the food table); **Finish day** asks Claude for a short review; weekly
  report on Mondays.
- **Reminders**: the app icon badge shows calories left (0 when over); an iOS Shortcuts automation
  sends "Check CalorieLens" at 13:00, 17:00 and 20:30. A push server with real numbers is a later
  stage.
- **Storage**: IndexedDB on the phone, persistent storage requested; JSON export/import through
  Files, with a banner when the last backup is old.

## MVP plan

1. ✅ Profile, daily targets, home screen, water.
2. Photo → recognition → confirmation → diary; text input; pending queue.
3. Repeat, My foods, USDA table, barcode and label.
4. Weight log, weekly report, target adjustment, badge.
5. Hints, Finish day, export/import, Shortcuts instructions.

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
| `app.js` | UI: home screen, profile, settings |
| `nutrition.js` | Target math and day boundaries (pure functions, tested) |
| `db.js` | IndexedDB storage |
| `manifest.webmanifest`, `icons/` | Home-screen name and icon |
