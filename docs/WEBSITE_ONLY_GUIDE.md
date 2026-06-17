# Doing everything through the GitHub website (no terminal)

You never need a command prompt. Every step below is clicks in your browser.
Follow them in order.

---

## Part 1 — Create the repository and upload the project

1. Go to https://github.com and sign in (make a free account if needed).
2. Top-right **+** → **New repository**.
   - Repository name: `welfare-mapper`
   - **Private** is fine for now.
   - Do **not** add a README (the project already has one).
   - Click **Create repository**.
3. On the new empty repo page, click the link **"uploading an existing file"**
   (in the "…or push an existing repository" area, there's an
   **upload an existing file** link near the top).
4. Unzip the project on your computer (right-click the .zip → Extract/Unzip).
   You'll get a `welfare-mapper` folder.
5. **Drag the *contents* of that folder** (not the folder itself — open it and
   select everything inside: `README.md`, `web`, `pipeline`, `docs`, `data`,
   `.github`, `.gitignore`) into the GitHub upload box.
   - If GitHub won't let you drag folders, drag the files and folders you can,
     then repeat the upload for any it missed. Folders usually work in Chrome.
6. At the bottom, in **Commit changes**, type "Initial prototype" and click
   **Commit changes**.

Your project is now on GitHub.

> If `.github` doesn't upload (browsers sometimes hide dot-folders): see
> "Adding the Actions by hand" at the bottom of this guide.

---

## Part 2 — Turn on GitHub Pages (one time)

1. In your repo, click **Settings** (top menu).
2. Left sidebar → **Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
   (Not "Deploy from a branch".)
4. That's it — nothing else to set here.

---

## Part 3 — First publish (with sample data, to prove it works)

1. Click the **Actions** tab (top menu).
   - If it asks you to enable workflows, click the green **enable** button.
2. You'll see two workflows: **Build data layer** and **Deploy map to Pages**.
3. Click **Build data layer** → **Run workflow** (button on the right) →
   **Run workflow** again to confirm.
   - This runs for ~1 minute. With no real data uploaded yet, it generates the
     synthetic sample so the map has something to show, and commits it.
4. That commit automatically triggers **Deploy map to Pages**. Wait for it to
   finish (green tick).
5. Go to **Settings → Pages** again — it now shows your live URL, like
   `https://yourname.github.io/welfare-mapper/`. Open it.

You should see the map with the (fake) London choropleth, working sliders, and
the draw-a-plot report. The footer warns it's synthetic data — correct.

---

## Part 4 — Load the REAL England data

You download two files in your browser (just clicking), then upload them to
GitHub and re-run the build. Full source details are in `docs/DATASETS.md`.

### 4a. Download the two files to your computer

**File 1 — Deprivation scores:**
- Go to https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019
- Download **"File 7: all ranks, deciles and scores…"** (an Excel .xlsx).
- Open it in Excel/Numbers/Google Sheets. Go to the sheet named
  **"IoD2019 Scores"**. Use **File → Save As / Download as → CSV**.
- Name the saved file exactly: `imd2019_scores.csv`

**File 2 — LSOA boundaries:**
- Go to the ONS Open Geography Portal: https://geoportal.statistics.gov.uk
- Search: **Lower layer Super Output Areas December 2011 Boundaries
  Generalised Clipped**.
- Open that dataset, find the **Download** options, choose **GeoJSON**.
- Rename the downloaded file exactly: `lsoa_boundaries.geojson`

> Use the *Generalised* (BGC/BSC) version, not full resolution — full-res is
> huge and slow in the browser.

### 4b. Upload them into the repo's data/raw folder

1. In your repo, click into the **data** folder, then the **raw** folder.
2. Click **Add file → Upload files**.
3. Drag in `imd2019_scores.csv` and `lsoa_boundaries.geojson`.
4. Commit changes.

### 4c. Re-run the build

1. **Actions** tab → **Build data layer** → **Run workflow** → confirm.
2. This time it detects the real files and processes all 32,844 English LSOAs.
   It commits the processed file, which triggers a fresh Pages deploy.
3. Refresh your live URL. The "synthetic data" warning is gone — you're now
   looking at real England deprivation data, fully reweightable.

> The real processed file is larger than the sample. If the map feels slow,
> that's the GeoJSON-vs-vector-tiles tradeoff we discussed — fine for the
> prototype, addressed properly in a later phase.

---

## Making changes later (all in the browser)

- To edit any file: click it in GitHub, click the **pencil** icon, edit,
  **Commit changes**. Pages redeploys automatically.
- To refresh data after the government publishes new figures: upload new files
  to `data/raw/` and re-run **Build data layer**.

---

## Adding the Actions by hand (only if .github didn't upload)

If the `.github` folder didn't make it during upload, create the two workflow
files directly on the website:

1. **Add file → Create new file**.
2. In the name box type: `.github/workflows/build-data.yml`
   (typing the slashes creates the folders).
3. Paste the contents of the `build-data.yml` file from the project.
4. Commit. Repeat for `.github/workflows/deploy-pages.yml`.

Both files are in the `welfare-mapper/.github/workflows/` folder of the zip —
open them in any text editor (Notepad, TextEdit) to copy the contents.
