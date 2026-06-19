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

