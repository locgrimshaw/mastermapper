# Datasets to download

This is your shopping list. Everything here is free public data under the
Open Government Licence (OGL) v3 — fine for commercial use with attribution.
Download each, place the file at the path shown, then run the pipeline.

England only for v1, as agreed.

---

## TIER 1 — needed for the core map (do these first)

### 1. English Indices of Deprivation 2025 — "File 7" (CSV)

- **What it is:** the 7 deprivation domains + overall IMD, scored for all
  33,755 English LSOAs (2021 geography). This is the backbone of the whole app.
- **Where:** the official release page —
  https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025
  Download **"File 7: All ranks, scores, deciles and population denominators
  for the Indices of Deprivation"** — it's already a **CSV** (no Excel-to-CSV
  step needed, unlike 2019). Direct link (stable):
  https://assets.publishing.service.gov.uk/media/691ded56d140bbbaa59a2a7d/File_7_IoD2025_All_Ranks_Scores_Deciles_Population_Denominators.csv
- **What to do:** save it as:

      data/raw/imd2025_scores.csv

  Upload via GitHub **Add file → Upload files** (a normal CSV uploads fine).
- **Licence:** OGL v3. Attribute MHCLG.
- The pipeline expects these exact column names (verified against the 2025 file):
  `LSOA code (2021)`, `LSOA name (2021)`,
  `Local Authority District name (2024)`,
  `Index of Multiple Deprivation (IMD) Score`, `Income Score (rate)`,
  `Employment Score (rate)`, `Education, Skills and Training Score`,
  `Health Deprivation and Disability Score`, `Crime Score`,
  `Barriers to Housing and Services Score`, `Living Environment Score`.

### 2. LSOA (2021) boundaries — super generalised, clipped to coastline

- **What it is:** the polygon shapes for each LSOA, so scores can be drawn
  on a map. **Must be 2021 LSOAs** to match IoD 2025 codes.
- **Where:** fetched automatically by `fetch_boundaries.py` from the ONS Open
  Geography Portal (the *Lower layer Super Output Areas (December 2021)
  Boundaries EW BSC V4*, Super Generalised 200m). You normally don't download
  this by hand — the build does it.
- **What it produces:**

      data/raw/lsoa_boundaries.geojson

- **Licence:** OGL v3. Contains OS data © Crown copyright.
- The code column is `LSOA21CD`; the pipeline auto-detects it if it differs.

> **Borough/district names** come straight from File 7 now (it includes
> `Local Authority District name (2024)`), so clicking an area shows where it
> is. The old ONS name-lookup web call has been removed — one less thing to
> break.

> ⚠ **Geography change.** IoD 2025 uses **2021** LSOAs (33,755; ~6% of
> boundaries changed vs 2011, and LADs dropped from 317 to 296). The whole
> pipeline is now on 2021 geography. The 2025 methodology also changed, so
> 2025 scores are **not directly comparable** to 2019 — treat trend
> comparisons with care.

> ⚠ **House prices are on hold for 2025.** The price layer used a
> postcode→2011-LSOA lookup; on 2021 geography that lookup must be refreshed
> before prices can be re-enabled. Leave `include_prices` off until then.

**After Tier 1:** run `python pipeline/build_imd_layer.py`, then open the web
app. You'll have a real, national, reweightable deprivation map.

---

## TIER 2 — overlays (add once the core map works)

### 3. Crime — street-level data
- **Where:** https://data.police.uk/data/ (CSV by month & force) or the API
  at https://data.police.uk/docs/. Free.
- **Use:** point layer + counts per area. Note IMD already includes a crime
  *domain*; this adds live, granular incident points on top.
- **Licence:** OGL v3.

### 4. House prices — HM Land Registry Price Paid Data
- **Now automatic.** The build Action fetches a year of Price Paid data from
  Land Registry and the postcode→LSOA lookup from ONS, aggregates sales to a
  median price per LSOA, and merges it into the map layer. You upload nothing.
- To include it: on the **Build data layer** workflow, tick
  **"Also add house prices"** before running. (It's slower — a year of sales is
  a large download — so it's off by default.)
- The map then shows a "Deprivation / House prices" toggle, and the site
  context report includes a median sale price.
- **Licence:** OGL v3. Attribution: "Contains HM Land Registry data © Crown
  copyright and database right."

### 5. Schools — Get Information About Schools (GIAS)
- **Where:** https://get-information-schools.service.gov.uk/Downloads
- **Use:** nearest-school amenity points with phase/type. CSV with eastings/
  northings (convert to lat/lon — the pipeline can do this later).
- **Licence:** OGL v3.

### 6. GPs & pharmacies — NHS ODS / NHS Digital
- **Where:** NHS Organisation Data Service "epraccur" (GP practices) and
  "edispensary"/"etrust" extracts: https://digital.nhs.uk/services/organisation-data-service/data-downloads
- **Use:** healthcare amenity points.
- **Licence:** OGL v3.

### 7. Bus stops — NaPTAN
- **Where:** https://beta-naptan.dft.gov.uk/ (national public transport access
  nodes). CSV/XML.
- **Use:** public-transport amenity points; later, GTFS for transit isochrones.
- **Licence:** OGL v3.

### 8. Planning constraints — planning.data.gov.uk
- **Where:** https://www.planning.data.gov.uk/ — conservation areas, article 4
  directions, flood risk zones, green belt, listed buildings, etc. GeoJSON per
  dataset.
- **Use:** the policy/constraint overlays (1.6). Coverage is incomplete but the
  best single national source. Pull conservation areas + listed buildings first.
- **Licence:** OGL v3 (varies per dataset — check each).

---

## Station developable-land constraints (`planning_constraints` table)

These are the "erase"/overlay polygon layers for the station developable-land
analysis (`pipeline/build_constraints.py` → `supabase/constraints_import.csv` →
`supabase/loaders/load_constraints.py` → `public.planning_constraints`). The
build **clips every layer to a 1 km buffer around each rail station** (union of
`web/data/stations.geojson`), so the national downloads shrink to a thin sliver
and the Supabase free tier stays under its cap.

Each source is optional (missing ones are skipped). Commit the download under
`data/raw/` (allowlisted in `.gitignore`) or fetch it in CI — the paths are
configurable via the `*_SRC` env vars documented at the top of
`pipeline/build_constraints.py`. Most OS/EA data is **EPSG:27700** (British
National Grid) and is reprojected to 4326 by the pipeline.

| kind | dataset | download | default path | CRS |
|------|---------|----------|--------------|-----|
| `built_land` | OS Open Built Up Areas (polygon) | https://osdatahub.os.uk/downloads/open/BuiltUpAreas | `data/raw/os_open_built_up_areas.gpkg` | 27700 |
| `green_space` | OS Open Greenspace — "Greenspace Site" polygon layer (ignore Access Points) | https://osdatahub.os.uk/downloads/open/OpenGreenspace | `data/raw/os_open_greenspace.gpkg` | 27700 |
| `transport` | OS OpenMap Local — Road + Railway (lines buffered by class; road polygons kept) | https://osdatahub.os.uk/downloads/open/OpenMapLocal | `data/raw/os_openmap_local.gpkg` | 27700 |
| `flood_zone_2` | EA Flood Map for Planning (Rivers and Sea) — Flood Zone 2 | https://environment.data.gov.uk/ (Defra Data Services Platform) | `data/raw/ea_flood_zone_2.gpkg` | 27700 |
| `flood_zone_3` | EA Flood Map for Planning (Rivers and Sea) — Flood Zone 3 | https://environment.data.gov.uk/ (Defra Data Services Platform) | `data/raw/ea_flood_zone_3.gpkg` | 27700 |
| `green_belt` | planning.data.gov.uk green-belt (polygon) | https://www.planning.data.gov.uk/dataset/green-belt | `data/raw/green-belt.geojson` | **4326** (no reprojection) |

**Gate-3 heritage/environmental designations** (Assessment 3). All from
planning.data.gov.uk, all OGL v3.0, all already **EPSG:4326** GeoJSON at
`https://files.planning.data.gov.uk/dataset/<slug>.geojson`, all built by the one
generic `build_planning_data` builder (see `PLANNING_DATA_KINDS` in
`pipeline/build_constraints.py`). Fetched by the **Load constraints** workflow
only when the kind is named in its `kinds` input. Split into two buckets:

*Hard exclusions* (removed from developable land — folded into the RPC's default
`subtract` set):

| kind | dataset slug |
|------|--------------|
| `sssi` | `site-of-special-scientific-interest` |
| `sac` | `special-area-of-conservation` |
| `spa` | `special-protection-area` |
| `ramsar` | `ramsar` |
| `ancient_woodland` | `ancient-woodland` |
| `scheduled_monument` | `scheduled-monument` |

*Soft constraints* (land retained; feed the 0–1 friction score in the RPC and
`station_assessments.constraint_friction` / `soft_cover`):

| kind | dataset slug |
|------|--------------|
| `conservation_area` | `conservation-area` |
| `aonb` | `area-of-outstanding-natural-beauty` (National Landscapes) |
| `park_garden` | `park-and-garden` |
| `listed_building` | `listed-building-outline` (polygon layer; a setting proxy) |

**Green Belt is deliberately *not* a hard exclusion** — the draft NPPF permits
development around well-connected out-of-settlement (Tier B) stations in the
Green Belt, so the RPC returns `green_belt_ha` (an overlap flag) and the app
applies tier-aware handling (soft constraint for Tier A, permitted for Tier B).

Notes:
- **transport half-widths** applied to line features before reprojecting
  (metres): motorway 15, A-road 9, B/minor 5, local/residential 4, rail 6. Road
  *polygons* are kept as-is.
- **flood zones** can be supplied as two per-zone files (above) **or** as one
  combined file (`data/raw/ea_flood_zones.gpkg`, env `FLOOD_ZONES_SRC`) with a
  zone attribute — the build auto-splits it into `flood_zone_2` / `flood_zone_3`.

**Licences & required attribution (OGL v3.0):**
- OS Open Built Up Areas / Open Greenspace / OpenMap Local:
  *"Contains OS data © Crown copyright and database right 2025"*.
- EA Flood Map for Planning Flood Zones:
  *"© Environment Agency copyright and/or database right 2025"*.
- planning.data.gov.uk green-belt: OGL v3.0
  (*"Contains public sector information licensed under the Open Government
  Licence v3.0"*).

---

## Classification layers (green-belt overlay + station rural/urban)

Two national classification layers, each built by its own script and committed
back to the repo by the **Build classifications** workflow
(`.github/workflows/build-classifications.yml`).

### 11. Green belt — DISPLAY overlay
- **What it is:** England's green-belt boundaries as a light area wash drawn on
  the map. This is the *display* overlay, separate from the developable-land
  "erase" constraint (which `build_constraints.py` clips and pushes to Supabase).
- **Where:** planning.data.gov.uk green-belt (GeoJSON, already EPSG:4326) —
  https://www.planning.data.gov.uk/dataset/green-belt
  Click **Download** and choose GeoJSON.
- **Save as:** `data/raw/green-belt.geojson` (env `GREEN_BELT_SRC` overrides;
  `.gpkg` / `.json` also accepted).
- **Builder:** `python pipeline/build_greenbelt_layer.py`
- **Output (data contract):** `web/data/greenbelt.geojson` — a GeoJSON
  FeatureCollection; each feature is Polygon/MultiPolygon with
  `properties.name` (string, may be `''`) and `properties.reference` (string),
  plus `properties.organisation` when the source carries it. The geometry is
  lightly simplified (~10 m, topology-preserving) for web display. If the file
  grows past ~15 MB, tile it with tippecanoe (the builder emits
  `web/data/greenbelt.pmtiles` automatically when tippecanoe is on PATH).
- **Licence:** OGL v3.0 — *"Contains public sector information licensed under
  the Open Government Licence v3.0."*

### 12. ONS Rural-Urban Classification (2011) — for stations
- **What it is:** the ONS Rural Urban Classification 2011 at LSOA level — a
  10-fold class (RUC11 code `A1`…`F2` + full name) per 2011 LSOA. Used to give
  each rail station a default density regime (rural / suburban / urban) for the
  developable-land tool.
- **Where:** ONS "Rural Urban Classification (2011) of Lower Layer Super Output
  Areas in England and Wales" (a lookup CSV keyed by LSOA11 code). Published on
  the ONS / gov.uk statistics pages; the CSV carries an LSOA11 code column plus
  a RUC11 code and name.
- **Save as:** `data/raw/ruc_lsoa.csv` (env `RUC_SRC` overrides). Header
  spellings vary between exports; the builder matches leniently (accepts
  `LSOA11CD` / `LSOA code` / `geography code`… for the code, `RUC11CD` /
  `RUC11` / `Rural Urban Classification 2011 (10 fold)`… for the code/name).
- **Boundaries used for the join:** `web/data/lsoa_imd.geojson` (has an
  `lsoa_code` property; env `LSOA_SRC` overrides). Stations are joined to their
  LSOA by point-in-polygon, then looked up in the RUC CSV. NB: the RUC lookup is
  on 2011 LSOAs and the boundaries are 2021 LSOAs, so ~6% of codes won't match —
  those stations get `rural_urban = null`, reported in the build summary.
- **Builder:** `python pipeline/build_station_ruc.py`
- **Output (data contract):** rewrites `web/data/stations.geojson` in place,
  adding to each feature's properties `rural_urban` ∈ {`rural`,`suburban`,
  `urban`} (or `null`), `ruc_name` (string) and `ruc_code` (string, e.g. `A1`).
  RUC → regime mapping (tunable, defined at the top of the script): Urban major/
  minor conurbation → `urban`; Urban city and town (+ sparse) → `suburban`;
  Rural town and fringe / village / hamlets and isolated dwellings (+ sparse) →
  `rural`.
- **Licence:** OGL v3.0 — *"Contains public sector information licensed under
  the Open Government Licence v3.0."* Attribute ONS.

---

## Brownfield site POLYGON boundaries (`brownfield` table `area` column)

The national **brownfield-land** register (loaded by
`pipeline/build_brownfield_csv.py`) is **point-only** — 35,892 sites, every
`area` null. Two independent feeds add real polygon footprints; both are
wanted, and both are optional (run whichever sources you have). The frontend
already draws the polygon when the RPC returns `area_geojson`
(`renderBrownfieldLayer`), so populating `area` is all that's needed.

Pipeline:
`build_brownfield_site_csv.py` + `build_brownfield_inspire.py` →
`supabase/brownfield_site_import.csv` + `supabase/brownfield_inspire_import.csv`
→ `supabase/loaders/load_brownfield_polygons.py` → `public.brownfield`
(workflow: `.github/workflows/load-brownfield-polygons.yml`).

### A. planning.data.gov.uk `brownfield-site` (has polygons — mostly London)

- **What it is:** a SEPARATE planning.data.gov.uk dataset from brownfield-land,
  and the one that actually carries polygon geometries (almost all submitted by
  London boroughs). Loaded as **new** brownfield rows (distinct `reference`s),
  so they upsert on `(organisation, reference)` **alongside** the point register
  without clobbering it.
- **Where:** https://www.planning.data.gov.uk/dataset/brownfield-site — click
  **Download → GeoJSON**, or use the entity API (already **EPSG:4326**):
  https://www.planning.data.gov.uk/entity.geojson?dataset=brownfield-site
- **Save as:** `data/raw/brownfield-site.geojson`
- **Licence:** Open Government Licence v3.0 (per-dataset — confirm on the page).
  Attribute the publishing organisation and *"Contains public sector
  information licensed under the Open Government Licence v3.0."*
- **Fields used** (lenient matching, shared with the brownfield-land builder):
  `reference`, `name`, `organisation-entity`/`organisation`, `site-address`,
  `point` (WKT), `hectares`, `minimum-net-dwellings`, `maximum-net-dwellings`,
  `deliverable`, `ownership-status`, `planning-permission-status`,
  `planning-permission-date`, `notes`, `site-plan-url`. The polygon comes from
  the GeoJSON feature `geometry` (Polygon/MultiPolygon → MultiPolygon). `geom`
  is the site's `point`, or the polygon centroid when no point is given.

### B. HM Land Registry INSPIRE parcels (boundaries for brownfield-land points)

- **What it is:** INSPIRE Index Polygons — freehold land parcels. This feed
  spatially joins each **brownfield-land POINT** to its **containing** parcel
  and writes an `area` **update** for that existing `(organisation, reference)`
  row. Points that fall in no parcel stay point-only.
- **Where:** the Land Registry / `use1.uk` INSPIRE download index publishes
  polygons as **per-Local-Planning-Authority GML zips** (EPSG:27700). The build
  reprojects to 4326.
- **Save as:** unzip into `data/raw/inspire/` (e.g.
  `data/raw/inspire/<lpa>.gml`; `*.geojson`/`*.json` also accepted). The
  brownfield-land **point** download (`data/raw/brownfield-land.csv` or
  `.geojson`) must also be present — it's the point set being enriched.
- **Regional by design:** national INSPIRE is **hundreds of per-LPA files** and
  many GB unzipped. The builder processes **whatever parcel files are present**
  and leaves everything else point-only, so add LPAs incrementally.
- **⚠️ LICENCE — RESTRICTED RE-USE (important):** INSPIRE Index Polygons are
  **not** plain OGL data. They contain **Ordnance Survey data (© Crown copyright
  and database rights)** and are provided under the **Land Registry INSPIRE
  end-user licence**, which **restricts onward republication**. Deriving site
  boundaries from them and **publishing** those boundaries may **not** be freely
  permitted — review the current INSPIRE licence and OS terms before making
  these polygons public. Pursued here with that caveat explicitly accepted.
- **Multiple / zero parcels per point:** a point inside several nested/
  overlapping parcels keeps the **smallest-area** containing parcel (the most
  specific plot); a point inside **no** parcel is skipped (row left point-only).

---

## TIER 3 — needs a backend / 3rd-party service (later phase)

### 9. Isochrones + travel times (requirement 1.4)
- Not a download — a routing service. Start with a **TravelTime** or **Mapbox
  Isochrone** API key (both have free tiers). Self-hosting OpenTripPlanner with
  national GTFS is a later optimisation, not a v1 task.

### 10. Council waiting lists / rents (requirement 1.5, deeper)
- MHCLG live tables (annual, LAD-level, patchy) and ONS Private Rental Market
  Statistics. Coarse geography — set expectations. CSV.

---

## A note on plot boundaries (requirements 1.3 & 2.1)

There is **no free, complete national land-parcel dataset**. For v1:
- **Manual draw** (already built into the prototype) — no data needed.
- **Portfolio tester** — the portfolio holder (Network Rail, MoD, etc.)
  supplies their own boundary GeoJSON/Shapefile. You don't need a national
  parcel set for this.
- Optional assist: HM Land Registry **INSPIRE** polygons (free, incomplete,
  commercial-reuse caveats) — treat as a prototype aid, not a product
  dependency.

---

## Attribution block (put this in the app footer for real data)

> Contains public sector information licensed under the Open Government
> Licence v3.0. Indices of Deprivation 2019 © MHCLG. Boundaries © ONS, contains
> OS data © Crown copyright and database right 2019. Price data © HM Land
> Registry.

---

## Transit overlay (rail / subway / light rail / tram)

The transit overlay is an **optional layer** that draws on top of the
choropleth. It never touches the deprivation scores, so it's safe to rebuild on
its own. Tick **"include_rail"** when running the *Build data layer* workflow.

It covers **four modes**, each rendered in its own colour and toggleable
independently (lines and stops separately, per mode):

| Mode        | Colour      | Lines (OSM)                                  | Stops |
|-------------|-------------|----------------------------------------------|-------|
| Heavy rail  | near-black  | `railway=rail` + `usage=main`/`branch`       | committed CSV (has CRS) |
| Subway      | blue        | `railway=subway`                             | OSM `railway=station/halt` + `station=subway` |
| Light rail  | teal        | `railway=light_rail`                         | OSM `railway=station/halt` + `station=light_rail` |
| Tram        | orange      | `railway=tram`                               | OSM `railway=tram_stop` |

**Lines — OpenStreetMap (no upload needed).** `build_rail_layer.py` queries the
Overpass API for England. For heavy rail it keeps only the passenger network
(`usage=main`/`branch`), excluding sidings/yards (`service=*`); other modes are
selected by their own `railway=*` value. Disused/abandoned/construction track
carries lifecycle-prefixed keys and is skipped automatically. If Overpass is
unavailable the step skips cleanly and the build still succeeds (same policy as
house prices).

**Stops.** `railway=rail` also covers freight and the OSM mainline-station tag
doesn't carry CRS codes, so heavy-rail stops come from a committed CSV instead
(authoritative, includes CRS). Subway/light-rail/tram stops come from OSM,
since the CSV is National-Rail only.

Download a UK stations CSV and commit it as **`data/raw/uk_stations.csv`**.
Recommended: the `davwheat/uk-railway-stations` dataset (header
`stationName,lat,long,crsCode,iataAirportCode,constituentCountry`). The parser
keeps England rows and tolerates column-name variants (`lat`/`latitude`,
`long`/`lng`/`longitude`, `stationName`/`name`, etc). Upload it like the IMD
CSV: in GitHub, **Add file → Upload files** (a normal CSV uploads fine; only
dotfiles get skipped by drag-and-drop). If the CSV is absent, heavy-rail stops
are simply omitted; the other three modes and all lines still build.

**Clicking a stop** opens an info panel with the stop name, a colour-coded mode
badge, an inline SVG glyph (no icon CDN needed), and any operator/network/CRS
detail present.

**Licensing — important.** OSM and the Trainline-derived CSV are both **ODbL**
(attribution **and** share-alike), stricter than the OGL data used elsewhere.
The footer credits OpenStreetMap contributors & Trainline (ODbL) whenever the
overlay is present.

**Frontend note.** Stop labels use the `Noto Sans Regular` font stack served by
the MapLibre demo glyph endpoint. If you switch glyph servers, update the
`text-font` value in the `rail-stop-label` layer in `app.js` to a stack that
server provides, or labels will silently not render (the dots still will).

