# T1D Log

A private, on-device logbook for **insulin doses, food and Libre glucose history** (type 1 diabetes, manual injections).
It runs as a static web page you open on your iPhone and add to the Home Screen. **Your data never leaves the phone.**

> **What this is not.** It is a personal logbook and review tool, not a medical device. It never calculates or suggests
> insulin doses, gives no alarms, and does not replace your Libre app, your alarms or your care team. Glucose shown here is
> imported history only.

Version 0.2.1. This is "Phase 0a" of the plan: the logger and the Libre importer. There are **no predictions** yet.

## What works now

- Encrypted local storage (passphrase -> AES-256-GCM; key kept only in memory while unlocked), auto-lock, delete-everything.
- Dose logging (rapid / long-acting): units stepper respecting your pen increment, time chips, purpose, optional site/notes, undo.
- Meal logging: items with macros, how each was measured (weighed / label / estimated / guess), saved meal templates,
  **"carbs I used for my dose" kept separately**, automatic linking to a nearby rapid dose with the pre-bolus gap shown.
- Tags: exercise, alcohol, illness, stress, hypo treatment, sensor change, period, ketone, notes.
- **LibreView CSV import** with a report before anything is stored (date range, reading interval, gaps, duplicates, units, date
  format, daylight saving, likely sensor family). Safe to import the same or overlapping files repeatedly; each import can be undone.
  The account name inside the file is never read or kept. Ambiguous day/month dates are never guessed: you are asked.
- Day timeline chart of imported glucose with your logged events; data-quality screen.
- **Encrypted backup and restore.** Back up everything, or only "new entries since the last backup" (so backups can simply
  accumulate, with no central store). Backup files are encrypted with their own passphrase, so they are safe to keep in iCloud Drive or
  Files. Restoring (full or partial backups, in any order) only adds what is missing, never deletes, and never replaces a newer entry
  with an older one. A computer-side tool decrypts a backup for analysis (see below).
- Plain-text CSV/JSON export for your own analysis (not encrypted; handle with care).

## Not built yet

Food database search and barcode scanning, photo assist, live Libre feed, Garmin import, any prediction or analysis,
a Face ID lock (not possible in a web page), Lock Screen widget.

## Where the data lives (no central store)

GitHub hosts only the app's files. Everything you enter is stored locally in Safari's storage on your phone, encrypted, and
new entries are simply added to it (edits keep the previous version; deletes can be undone). Nothing is uploaded anywhere.
Because the phone holds the only copy, **make an encrypted backup regularly** and keep the file somewhere you control.

## Put it on GitHub Pages (about 10 minutes)

1. Create a GitHub repository (for example `t1d-log`). **Free accounts can only publish Pages from public repositories**;
   private-repository Pages needs a paid plan, and even then the published *site* is public. That is fine here because the site
   contains only the app, never data. **Never commit exports or CSVs.**
2. Upload the contents of this folder (without `node_modules`) to the repository's `main` branch. The file `.nojekyll` must be included.
3. Repository **Settings -> Pages -> Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. After a minute your app is at `https://<your-username>.github.io/<repo-name>/`.
5. Open that address in **Safari on the iPhone**, then **Share -> Add to Home Screen**, and open the app **from the Home Screen icon**.
   Safari deletes a normal website's stored data after 7 days without use; Home Screen apps are treated differently.
6. Create your passphrase. **It cannot be recovered.** Then make a backup (More -> Backup, export and delete) every so often.
   On a new phone: set up a log first, then restore from the backup file.

### Updating later

Upload the new files, and change `CACHE = "t1dlog-v3"` in `sw.js` to a new name (for example `t1dlog-v4`) so phones fetch the update.
Open the app twice to pick it up.

## First use

1. Set up, then in LibreView download your glucose data as CSV, and use More -> Import Libre data.
2. Read the report: **reading interval and sensor line tell us which Libre you have**; check the gaps and the date format.
3. Start logging doses and meals as you go.

## Privacy model

- Everything is stored in the browser's IndexedDB on your phone, encrypted. Only random ids are stored in the clear.
- The page's Content-Security-Policy allows no outside connections, and automated tests check that the code contains no network calls
  other than the service worker loading the app's own files. GitHub can see that someone downloaded the app files, but never your data.
- **Backups are encrypted; CSV/JSON analysis exports are not.** The analysis files hold your health data in plain text; store and share them carefully.
- The encryption key is derived from your passphrase with PBKDF2 (600,000 rounds). Unlocking may take a second or two on a phone.
- Forgetting the passphrase means the data is unrecoverable. A backup needs *its own* passphrase, which you must also remember.

## Honest limitations

- Tested in Node and a simulated browser (jsdom) with 72 automated tests, including a check that the JavaScript importer gives exactly the same
  results as the Python reference on 14 synthetic files and a public sample. **It has not yet been run on a real iPhone**: expect to find layout or
  Safari-specific issues, and tell me what you see.
- The LibreView CSV layout comes from a public sample and community notes. Insulin-dose rows (record type 4) and mmol/L exports were not in the
  sample, so those paths are covered by assumptions until your real export confirms them.
- Browser storage can be lost (cleared Safari data, deleting the Home Screen app, a lost phone). Backups are the safety net.

## For developers

```
npm install        # dev dependencies only (fake-indexeddb, jsdom) - the app itself has none
npm test           # 72 tests
python3 tools/make_golden.py   # regenerate fixtures + golden outputs from reference/libreview_parser.py
python3 tools/make_icons.py
ESBUILD=/path/to/esbuild python3 tools/build_preview.py preview.html   # single-file demo preview with made-up data
T1D_BACKUP_PASSPHRASE='...' node tools/decrypt-backup.mjs backup.json > plain.json   # open an encrypted backup on a computer
```
`reference/` holds the Python reference importer and its tests. Set `LIBREVIEW_SAMPLE=/path/to/file.csv` to also run the optional
public-sample checks. Never commit real exports.
