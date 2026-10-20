# AI Expense Tracker

A phone web app for logging expenses: snap a receipt, upload a photo or PDF, or say/type what you spent. Claude reads it, fills in vendor, amount, date, category and payment method, and keeps everything ready to export to QuickBooks Online, Xero, Wave or a spreadsheet. It can also sync to a Google Sheet.

- **No backend.** Plain HTML/CSS/JS served as static files. Data lives on the phone (IndexedDB).
- **Works offline.** The app opens with no signal; new entries wait in a queue and are read when the app is next open with a connection. (iPhones don't let web apps upload while closed.)
- **Costs nothing to host.** Each user enters their own Anthropic API key during setup and pays Anthropic directly (about 2–3¢ per receipt on the default model, under 0.1¢ on the cheapest).
- **Nothing is hard-coded to one person.** Businesses, categories, payment methods, export format, date format, currency and extra AI instructions are all chosen in setup and editable in Settings.

## Put it online (GitHub Pages, free)

1. On github.com, create a new repository (e.g. `ai-expense-tracker`). It can be private only on a paid plan; a public repo is fine since there are no secrets in the code.
2. Click **uploading an existing file**, then drag in **everything inside this folder** (including the hidden `.nojekyll` file; in File Explorer turn on View → Show → Hidden items). Commit.
3. Go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute the site is live at `https://<your-username>.github.io/ai-expense-tracker/`.

## Install on the iPhone

1. Open the link in **Safari** (not Chrome).
2. Tap the Share button → **Add to Home Screen** → Add.
3. Open it from the new icon and go through setup. From then on it works offline.

## Publishing an update

1. Change the files.
2. In `sw.js`, bump `VERSION` (e.g. `1.0.0` → `1.0.1`). Without this, phones keep the old cached copy. Also bump `APP_VERSION` in `js/views/settings.js` so Settings shows it.
3. If you added a new file, add it to the `ASSETS` list in `sw.js`.
4. Upload the changed files to the repo. Next time the app is opened, it shows **"A new version is ready, Update now"**.

## Testing on a computer

```
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge. Use the browser's device toolbar for a phone-sized view. The camera button opens a file picker on a computer.

## Google Sheets (optional)

Settings → Google Sheets walks the user through pasting a small Apps Script into their own Google Sheet and deploying it as a web app. The script lives in their Google account, appends/updates rows on an "Expenses" tab and saves receipt photos to a Drive folder. The script includes a random connection code so only this phone can write to it. This step is easiest on a computer; the app has a "Send to my computer" button for the instructions and script.

## Files

| Path | What it does |
|---|---|
| `index.html`, `manifest.webmanifest`, `icons/` | App shell, Home Screen name and icons |
| `sw.js` | Offline cache |
| `css/app.css` | All styling (light and dark mode) |
| `js/app.js` | Startup, routing, update prompt |
| `js/ai.js` | Claude request, prompt and output schema |
| `js/queue.js` | Offline queue: sends waiting entries to the AI, then syncs |
| `js/entries.js` | Expense records |
| `js/settings.js` | Defaults and presets (category lists, export formats) |
| `js/exporter.js` | QuickBooks / Xero / Wave / CSV files, receipt photo sharing, backup & restore |
| `js/sheets.js` | Google Sheets sync and the Apps Script template |
| `js/capture.js`, `js/image.js` | Camera, upload, voice/typed input, photo shrinking |
| `js/views/` | Screens: home, entry, export, settings, setup |
| `vendor/` | Official Anthropic TypeScript SDK 0.131.0 (browser bundle from jsDelivr), kept local so the app has no outside dependencies |
