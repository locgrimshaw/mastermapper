# Welfare Mapper

A socio-economic site-appraisal tool for English local authorities and public
bodies. Maps deprivation at LSOA level, lets you reweight the domains into a
custom combined score, and produces a context report for any plot you draw.

> **Status:** prototype. Core map + scoring engine + plot context report work
> today on synthetic data. Real data drops in via the pipeline (see below).
> Isochrones, amenities, housing/policy overlays, and portfolio scoring are
> scoped but not yet built — see the roadmap.

## How to run this (no terminal needed)

If you don't use a command prompt, follow **`docs/WEBSITE_ONLY_GUIDE.md`** —
a click-by-click walkthrough that does everything through the GitHub website:
upload the project, turn on Pages, and let a GitHub Action process the
government data for you in the cloud. You never touch a terminal.

The sections below describe the local/terminal workflow, kept for reference.

## Quickstart (terminal users only)

```bash
# 1. Install the pipeline dependencies (only needed to (re)build data)
pip install -r pipeline/requirements.txt

# 2. Generate synthetic sample data so the app has something to show
python pipeline/make_sample_data.py

# 3. Serve the web app (any static server works)
cd web && python -m http.server 8000
# open http://localhost:8000
```

You'll see a deprivation choropleth over a patch of London (fake data),
working weighting sliders, and a working draw-a-plot context report.

## Loading real England data

1. Download the two Tier-1 datasets in [`docs/DATASETS.md`](docs/DATASETS.md)
   and place them in `data/raw/`.
2. Run the real pipeline:

   ```bash
   python pipeline/build_imd_layer.py
   ```

3. Reload the app. The "synthetic data" warning disappears and you're looking
   at all 32,844 English LSOAs.

## Structure

```
welfare-mapper/
├── data/
│   ├── raw/          # you put downloaded gov data here (git-ignored)
│   └── processed/    # pipeline output the app consumes (git-ignored)
├── pipeline/         # Python: turns raw gov data into map-ready GeoJSON
│   ├── build_imd_layer.py
│   ├── make_sample_data.py
│   └── requirements.txt
├── web/              # the static front-end (deploy this to GitHub Pages)
│   ├── index.html
│   └── src/{app.js, styles.css}
└── docs/
    └── DATASETS.md   # the dataset shopping list
```

## How the pieces fit

- **Pipeline** (offline, occasional): heavy data prep. Run when source data
  updates (rarely). Keeps the live app fast.
- **Web** (static, free to host): the map. Loads one processed GeoJSON,
  computes the combined score and plot reports entirely in the browser.
- **Backend** (not yet): needed for isochrones, big portfolio batch jobs, and
  serving national data as vector tiles instead of GeoJSON.

## Roadmap

- [x] LSOA deprivation choropleth (1.1)
- [x] Live domain reweighting → combined score (1.2)
- [x] Quantile colour scaling + click-to-inspect single areas
- [x] Domain tooltips explaining each IMD measure
- [x] Draw a plot → area-weighted context report (1.3)
- [x] Housing context overlay — median sale price (1.5, partial)
- [ ] Isochrones + nearest amenities (1.4) — needs routing API
- [ ] Council waiting lists / rents (1.5, deeper)
- [ ] Policy/constraint overlays (1.6) — needs planning.data.gov.uk layers
- [ ] Portfolio batch scoring + need×feasibility quadrant (2.1)
- [ ] Indicative viability proxy (2.2) — later phase

## Licence / data attribution

Code: choose a licence (MIT suggested). Data: Open Government Licence v3 —
see the attribution block in `docs/DATASETS.md`.
```
