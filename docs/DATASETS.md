# Datasets to download

This is your shopping list. Everything here is free public data under the
Open Government Licence (OGL) v3 — fine for commercial use with attribution.
Download each, place the file at the path shown, then run the pipeline.

England only for v1, as agreed.

---

## TIER 1 — needed for the core map (do these first)

### 1. English Indices of Deprivation 2019 — "File 7: all ranks, deciles and scores"

- **What it is:** the 7 deprivation domains + overall IMD, scored for all
  32,844 English LSOAs. This is the backbone of the whole app.
- **Where:** gov.uk → search "English indices of deprivation 2019".
  Download **"File 7: all ranks, deciles and scores for the indices of
  deprivation, and population denominators"** (an .xlsx).
  Page: https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019
- **What to do:** open the .xlsx, find the sheet **"IoD2019 Scores"**, and
  save it as CSV to:

      data/raw/imd2019_scores.csv

- **Licence:** OGL v3. Attribute MHCLG.
- The pipeline expects these exact column names (they are stable):
  `LSOA code (2011)`, `Index of Multiple Deprivation (IMD) Score`,
  `Income Score (rate)`, `Employment Score (rate)`,
  `Education, Skills and Training Score`,
  `Health Deprivation and Disability Score`, `Crime Score`,
  `Barriers to Housing and Services Score`, `Living Environment Score`.

### 2. LSOA (2011) boundaries — generalised, clipped to coastline

- **What it is:** the polygon shapes for each LSOA, so scores can be drawn
  on a map.
- **Where:** ONS Open Geography Portal (geoportal.statistics.gov.uk).
  Search **"Lower layer Super Output Areas (December 2011) Boundaries
  Generalised Clipped (BGC) EW"**. Download as **GeoJSON**.
  - Use the *generalised* (BGC or BSC) version, NOT the full-resolution one —
    full-res is huge and will choke the browser in the prototype.
- **What to do:** save as:

      data/raw/lsoa_boundaries.geojson

- **Licence:** OGL v3. Contains OS data © Crown copyright.
- The code column is usually `LSOA11CD`; the pipeline auto-detects it if not.

> ⚠ IMD 2019 uses **2011** LSOA boundaries. Census 2021 introduced **2021**
> LSOAs (some changed). For v1, stay on 2011 boundaries to match IMD. When you
> add Census 2021 data later, you'll need the 2011↔2021 lookup (also on the
> Open Geography Portal) to reconcile them.

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
