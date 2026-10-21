# AI Expense Tracker

A phone web app for logging expenses: snap a receipt, upload a photo or PDF, or say/type what you spent. Claude reads it and fills in vendor, amount, date, category and payment method. From there expenses go wherever the user keeps their books: an Excel workbook, a Google Sheet, QuickBooks Online, Xero, Wave, or a spreadsheet file for their accountant.

- **No backend.** Plain HTML/CSS/JS served as static files. Data lives on the phone (IndexedDB).
- **Works offline.** The app opens with no signal; new entries wait in a queue and are read when the app is next open with a connection. (iPhones don't let web apps upload while closed.)
- **Costs nothing to host.** Each user enters their own Anthropic API key during setup and pays Anthropic directly (about 2–3¢ per receipt on the default model, under 0.1¢ on the cheapest).
- **Nothing is hard-coded to one person.** Categories, payment methods, books (separate businesses or personal), destination, export layout, date format, currency and extra AI instructions are chosen in setup and editable in Settings.

## How entries are read

- **Receipts (photo or PDF):** the image itself goes to Claude, which reads it the way a person would (no separate text-recognition step). It handles crumpled or faded receipts and handwritten tips, cleans up vendor names, picks a category from the user's list, and flags anything it's unsure of for review.
- **Voice:** chosen in setup and Settings → AI, with an estimated cost per entry shown for each option (it adjusts to the chosen Claude model):
  - **Keyboard mic:** type or use the iPhone keyboard's dictation; Claude interprets the text, rambling and self-corrections included. No extra account.
  - **Voice with spoken replies** (OpenAI key): listens hands-free and stops when the user pauses. Speech is transcribed with OpenAI `gpt-transcribe` (Claude doesn't take audio), Claude logs it or asks a short follow-up, and questions are spoken in OpenAI's AI voice (`gpt-4o-mini-tts`, "marin"). That TTS model retires 2027-01-06, so move it to its successor before then. Offline, recordings are saved and processed later.
  - **Live conversation** (OpenAI key): ChatGPT-style realtime voice (`gpt-realtime-2.1-mini` over WebRTC, semantic turn detection, interruptible). The phone mints a short-lived session key with the user's own OpenAI key, so no server is needed. When it has the details, the voice model calls `log_expense`, and Claude turns that into the record using the user's categories and rules.
  - If the microphone fails, the app retries quietly once, then explains the problem and offers Try again / Use the keyboard instead. It never switches modes on its own.

## Where expenses can go

| Destination | How it works |
|---|---|
| **Google Sheets** | Live and automatic. **Connect with Google** (needs the one-time registration in [GOOGLE-SETUP.md](GOOGLE-SETUP.md)): set up on the phone with a sign-in code and a normal Google permission screen. It uses only Google's non-sensitive `drive.file` permission, so there's no "unverified app" warning and no Google review, and the device-code sign-in gives a lasting connection. It can create a new sheet or use an existing one, chosen on Google's own page ("OnePick"; the embedded Google Picker can't work in iPhone Home Screen apps because Safari blocks its cookies). Picking grants the project access to that one file, and the app then finds it through Drive. **Script method** (backup, works with sheets shared with you): paste a small Apps Script on a computer. Either way, the app reads the header row, matches columns (rules + AI), keeps existing rows and formatting, and adds a hidden "AI Expense Tracker ID" column automatically so edits and deletes update the right row. Receipt photos go to a Drive folder. |
| **Excel** | The user picks their workbook from the Files app (OneDrive, iCloud Drive, or on the phone) and a tab. The app matches columns, adds new expenses below the existing rows (copying the formatting, filling formulas like running totals down, extending Excel Tables), updates expenses edited in the app, and hands the file back to save over the original. Same hidden ID column. A brand-new workbook can be started too. No Microsoft login: live Excel sync isn't practical for a backend-free app (Microsoft's workbook API doesn't support personal OneDrive, and browser sign-ins expire every 24 hours). |
| **QuickBooks Online / Xero / Wave** | Export a CSV in each one's bank-import format (spending as negative amounts). |
| **Spreadsheet / accountant** | Export a standard spreadsheet as Excel (.xlsx) or CSV. |
| **Custom layout** | Settings → Export formats: upload a CSV/Excel file or paste column names, match columns once, and exports come out in exactly that layout. |

Wherever the user's existing data has categories or payment methods (in a mapped column), the app offers to reuse those names.

## Put it online (GitHub Pages, free)

This repo is already set up: pushing to `main` deploys to GitHub Pages.

To set up a copy from scratch:
1. Create a public GitHub repository and push (or upload) **everything in this folder**, including the hidden `.nojekyll` file.
2. **Settings → Pages**: Deploy from a branch, `main`, `/ (root)`.
3. The site is live at `https://<username>.github.io/<repo>/` a minute later.

## Install on the iPhone

1. Open the link in **Safari**.
2. Share → **Add to Home Screen** → Add.
3. Open it from the icon and go through setup. From then on it works offline.

## Publishing an update

1. Change the files.
2. In `sw.js`, bump `VERSION`. Without this, phones keep the old cached copy. Also bump `APP_VERSION` in `js/views/settings.js`.
3. If you added a file, add it to the `ASSETS` list in `sw.js`.
4. Commit and push. Next time the app is opened it shows **"A new version is ready, Update now"**.

## Testing on a computer

```
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge with the device toolbar for a phone-sized view.

## Files

| Path | What it does |
|---|---|
| `index.html`, `manifest.webmanifest`, `icons/` | App shell, Home Screen name and icons |
| `sw.js` | Offline cache |
| `css/app.css` | All styling (light and dark mode) |
| `js/app.js` | Startup, routing, update prompt |
| `js/ai.js` | Claude requests: reading expenses, suggesting column matches |
| `js/queue.js` | Offline queue: sends waiting entries to the AI, then syncs |
| `js/entries.js` | Expense records |
| `js/settings.js` | Defaults and presets (category lists, export formats) |
| `js/fields.js` | The expense details a spreadsheet column can hold, plus rule-based column matching |
| `js/mapper.js` | Column-matching screen and "reuse your categories" prompt |
| `js/exporter.js` | Export files, Excel workbook updates, receipt sharing, backup & restore |
| `js/xlsx.js`, `js/zip.js` | Reading, creating and editing Excel files (no library) |
| `js/tabular.js` | Reading a layout from CSV, Excel or pasted text |
| `js/sheets.js` | Google Sheets sync (both methods) and the Apps Script |
| `js/google.js`, `js/google-config.js` | "Connect with Google": device-code sign-in, Sheets/Drive API calls, file picker; registration values |
| `js/capture.js`, `js/image.js` | Camera, upload, voice/typed input, photo shrinking |
| `js/speech.js`, `js/talk.js` | Voice with spoken replies: recording with pause detection, transcription, AI voice, cost estimates, the conversation screen |
| `js/live.js` | Live conversation over OpenAI's realtime voice (WebRTC) |
| `js/views/voice-setup.js` | The voice-option chooser used in setup and Settings |
| `js/views/` | Screens: home, entry, export, settings, setup, Google Sheets, Excel, export formats |
| `vendor/` | Official Anthropic TypeScript SDK 0.131.0 (browser bundle from jsDelivr), kept local so the app has no outside dependencies |
