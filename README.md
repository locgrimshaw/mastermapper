# MasterMapper

An **NPPF station site-appraisal tool** for England and Scotland. It maps
heavy-rail stations and their 800 m catchments (the draft-NPPF developable
radius), then funnels them through connectivity, eligibility, developable-land,
constraint and scoring gates to shortlist sites near stations — and profiles any
single station in depth.

> **Status:** working prototype on real government data. England is fully wired
> (stations, deprivation, prices, brownfield, green belt, heritage/environmental
> constraints, land ownership). Scotland is landing in phases — station network
> and SIMD deprivation are in; Scottish designations/constraints load via CI.

The app is a static MapLibre front-end backed by a Supabase Postgres/PostGIS
database. Heavy data prep runs offline in the `pipeline/` builders (mostly via
GitHub Actions), which write map-ready layers and load the database; the browser
does the interactive scoring and reporting.

## Two ways to use it

- **Explore** — search a station and profile its 800 m catchment: deprivation,
  prices, developable land, constraints, land ownership, and a scored deep dive.
- **Site sift** — step through the NPPF station funnel (connectivity → eligibility
  → developable land → constraints → the three scored axes). The shortlist
  updates live at every step; England and Scotland sift separately.

## How to run this (no terminal needed)

If you don't use a command prompt, follow **`docs/WEBSITE_ONLY_GUIDE.md`** —
a click-by-click walkthrough that does everything through the GitHub website:
turn on Pages and let the GitHub Actions workflows process the government data
in the cloud. You never touch a terminal.

The sections below describe the local/terminal workflow, kept for reference.

## Quickstart (terminal users only)

```bash
# 1. Install the pipeline dependencies (only needed to (re)build data)
pip install -r pipeline/requirements.txt

# 2. Serve the web app (any static server works)
cd web && python -m http.server 8000
# open http://localhost:8000
```

The app reads pre-built layers from `web/data/` and talks to Supabase (configured
in `web/config.js`) for the station assessments and the developable-land RPC.

## Loading real data

The `pipeline/` builders turn raw government data into map-ready GeoJSON/PMTiles
and load Supabase. Most run as GitHub Actions workflows (`.github/workflows/`) so
they can reach the gov servers directly and commit/load results. The dataset
shopping list and per-source CRS/attribution notes live in
[`docs/DATASETS.md`](docs/DATASETS.md).

Key builders:

| Area | Builders |
| --- | --- |
| Stations & connectivity | `build_rail_layer.py`, `build_station_usage.py`, `build_connectivity.py`, `build_connectivity_cif.py`, `build_station_ruc.py` |
| Deprivation | `build_imd_layer.py`, `build_lsoa_imd_points.py` (England IMD), `build_simd.py` (Scotland SIMD) |
| Prices & viability | `build_price_layer.py`, `build_lsoa_prices.py`, `build_ttwa_gva.py` |
| Land & constraints | `build_brownfield_*.py`, `build_greenbelt_layer.py`, `build_constraints.py`, `build_scot_designations.py`, `build_land_ownership.py` |
| Tiles / boundaries | `build_tiles.py`, `fetch_boundaries.py` |

Corresponding workflows load the outputs into Supabase (`build-data.yml`,
`build-simd.yml`, `load-constraints.yml`, `load-constraints-scotland.yml`,
`load-land-ownership.yml`, `load-brownfield-polygons.yml`, `load-amenities.yml`,
`build-brownfield.yml`, `build-classifications.yml`, `deploy-pages.yml`).

## Structure

```
mastermapper/
├── data/
│   └── raw/          # downloaded gov data (git-ignored; CI self-sources it)
├── pipeline/         # Python: turns raw gov data into map-ready layers + loads
├── web/              # the static MapLibre front-end (deploy to GitHub Pages)
│   ├── index.html
│   ├── config.js     # Supabase URL + anon key
│   ├── data/         # pre-built layers the app loads (pmtiles/geojson)
│   └── src/{app.js, styles.css}
├── supabase/         # SQL migrations + loaders (Postgres/PostGIS)
└── docs/             # DATASETS.md, setup + migration guides
```

## How the pieces fit

- **Pipeline** (offline, in CI): heavy data prep. Fetches gov data, builds
  layers, runs the SQL migrations, and loads Supabase. Keeps the live app fast.
- **Supabase** (Postgres/PostGIS): stores stations, per-station assessments,
  and `planning_constraints`; the developable-land RPC erases/penalises
  constraints inside each catchment.
- **Web** (static, free to host): the map + scoring UI. Loads the pre-built
  layers and calls Supabase for assessments and the plot report.

## Scotland rollout

Scotland reuses England's schema and canonical constraint kinds so both
countries sit in the same tables and the same developable RPC serves both:

- **Phase A** — country tagging + Scottish station network. *(in)*
- **Phase B** — SIMD deprivation points + `rebuild_station_scotland()` filling the
  shared catchment columns, so "Regeneration need" works from SIMD. *(in)*
- **Phase C** — Scottish designations/constraints. NatureScot (WFS) and Historic
  Environment Scotland (ArcGIS) are discovered and paged automatically by
  `build_scot_designations.py`; Scottish green belt and SEPA flood extents are
  fetched the same way, all mapped onto the canonical kinds. Loads via
  `load-constraints-scotland.yml`.

## Licence / data attribution

Code: choose a licence (MIT suggested). Data: Open Government Licence v3 —
see the attribution block in `docs/DATASETS.md`.
