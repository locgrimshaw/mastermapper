# Data layers roadmap

Candidate layers to add to the **Data layers** panel, researched July 2026 and
organised around the three scenarios we want the map to serve. The panel is
registry-driven (see `MAP_OVERLAYS` / `buildLayersPanel()` in `web/src/app.js`),
so each new polygon/point overlay is one registry entry plus a pipeline loader —
the grouping, toggles, counts and transparency sliders come for free.

**How layers get in** (pick the lightest that fits the data):

| Route | When | Examples already using it |
|---|---|---|
| Supabase table + bbox RPC | Big national polygon sets, fetched per viewport | constraints, brownfield, land ownership |
| Static GeoJSON in `web/data/` | Small national layers (< ~10 MB) | green belt, stations |
| PMTiles vector layer | Very large national polygon sets, per-area statistics | LSOA/IMD, house prices |
| Raster tiles | Continuous surfaces (slope, hillshade) | (none yet) |

*Verification note: URLs below were confirmed via live search results in July
2026; a handful (flagged) could not be fetched directly and should be
re-checked when the loader is written.*

---

## 1. Student housing (PBSA) site finding

Goal: well-connected locations *outside* the saturated core university areas
(especially London) where purpose-built student housing could work.

| Layer | Source & URL | Licence / format | Render as |
|---|---|---|---|
| **University campuses** | HESA campus locations (per-campus postcode + lat/long, via Provider Tools: <https://www.hesa.ac.uk/collection/provider-tools/>); fallback UK Learning Providers <https://learning-provider.data.ac.uk/> (HQ point only) | HESA open data (CC-BY — check per file) / CSV | Points sized by student headcount (join HESA numbers by UKPRN). **The key demand anchor — do first.** |
| **Student population** | Census 2021 TS062 NS-SeC L15 (full-time students) at LSOA, via Nomis <https://www.nomisweb.co.uk/datasets/c2021ts062>; or TS068 term-time population | OGL / CSV | Choropleth (% FT students) — reuses the existing LSOA PMTiles plumbing directly |
| **Article 4 / HMO restriction areas** | planning.data.gov.uk `article-4-direction-area` <https://www.planning.data.gov.uk/dataset/article-4-direction-area> | OGL / GeoJSON bulk + API | Polygons. C3→C4 Article 4s signal existing HMO pressure = PBSA demand; coverage incomplete (only publishing LPAs) — badge it |
| **HMO licence density** | Per-council registers (~300 councils, e.g. via data.gov.uk); needs geocoding via OS Open UPRN | OGL / CSV, fragmented | LSOA-aggregated density. High effort — target cities only, phase 2 |
| **PTAL (London)** | TfL Public Transport Accessibility Levels <https://data.london.gov.uk/dataset/public-transport-accessibility-levels-24rz6/> | OGL-style TfL terms / CSV grid + GIS | Fine 100 m-grid choropleth (0–6b). Flagship layer for the London scenario |
| **Connectivity outside London** | DfT Journey Time Statistics (LSOA), or computed isochrones from BODS GTFS <https://data.bus-data.dft.gov.uk/downloads/> via OpenTripPlanner/r5 | OGL / CSV, GTFS | LSOA choropleth or per-campus travel-time isochrone polygons |
| **Private rents** | ONS Price Index of Private Rents (monthly, LA-level, by bedroom count); VOA-sourced private rental summary stats (LA quartiles incl. room/shared) <https://www.ons.gov.uk/peoplepopulationandcommunity/housing/datasets/privaterentalmarketsummarystatisticsinengland> | OGL / CSV | LA choropleth (rent level + growth) |
| **PBSA pipeline (London)** | Planning London Datahub <https://data.london.gov.uk/dataset/planning-london-datahub> filtered to student-accommodation use | GLA open terms / GIS + bulk | Points of consented/pending PBSA schemes. National equivalent is commercial-only (Glenigan etc.) — flag |
| **Nightlife / amenity density** | FSA Food Hygiene Ratings API <https://api.ratings.food.gov.uk/help> (no key needed), filter pubs/bars/restaurants; or OSM POIs | OGL / JSON API | Heatmap or hex-bin density |

**Composite idea:** a "PBSA suitability" scored view — rail catchment × travel
time to campus × rent level × Article-4 presence — built the same way as the
existing sift funnel, but for LSOAs rather than stations.

---

## 2. Data centre site finding

Goal: map the UK power grid and connection capacity, then find flat,
policy-favourable sites near capacity.

### Power grid (the priority)

| Layer | Source & URL | Licence / format | Render as |
|---|---|---|---|
| **Transmission & distribution network (lines + substations)** | OpenStreetMap power infrastructure via Geofabrik energy extract <https://www.geofabrik.de/data/energy-networks.html> or Overpass | **ODbL — the licence-clean base**; NGET's own route shapefiles are restricted (planning/emergency use only, no commercial) | Lines styled by voltage (400/275/132 kV), substation polygons/points. Same ODbL pipeline as our existing OSM rail layer |
| **Grid Supply Point boundaries** | NESO Data Portal "GIS Boundaries for GB Grid Supply Points" <https://www.neso.energy/data-portal/gis-boundaries-gb-grid-supply-points> | NESO open licence / SHP + GeoJSON | GSP polygons — the natural join geography for capacity stats |
| **Connection queue / capacity** | NESO TEC Register <https://www.neso.energy/data-portal/transmission-entry-capacity-tec-register> (CSV API, updated ~twice weekly: every project with transmission entry capacity, MW, status, Gate 1/2) | NESO open licence / CSV | Points at named substations (needs substation-name→coordinate join via OSM). Colour by queued MW = "how contested is this node" |
| **Boundary headroom (strategic)** | NESO ETYS boundaries + Appendix B capability workbooks <https://www.neso.energy/publications/electricity-ten-year-statement-etys/etys-documents-and-appendices> | NESO open licence / SHP + XLSX | Boundary lines coloured by headroom — coarse but tells the strategic story |
| **DNO capacity heatmaps + embedded capacity registers** | All six DNO open-data portals (Opendatasoft): UKPN <https://ukpowernetworks.opendatasoft.com/>, NGED <https://connecteddata.nationalgrid.co.uk/>, SSEN <https://data.ssen.co.uk/>, SPEN <https://spenergynetworks.opendatasoft.com/>, Northern Powergrid, ENWL; ENA aggregator <https://www.energynetworks.org/industry/connecting-to-the-networks/connections-data> | Open (some need free registration) / GeoJSON + CSV APIs | Primary-substation points coloured by demand headroom (MW). **UKPN is the one that matters for London.** Start with 1–2 DNOs, standardise, then add the rest |

### Site viability

| Layer | Source & URL | Licence / format | Render as |
|---|---|---|---|
| **Terrain slope / flatness** | OS Terrain 50 (GB-wide 50 m DTM) <https://osdatahub.os.uk/downloads/open/Terrain50>; EA LIDAR 1 m DTM for England detail | OGL / GeoTIFF, ASCII grid | Precomputed slope raster tiles, or "slope < 2°" polygons as a bbox overlay |
| **Water availability** | EA Water Resource Availability (CAMS Cycle 3) <https://environment.data.gov.uk/dataset/62514eb5-e9d5-4d96-8b73-a40c5b702d43> | OGL / SHP, WFS | Green/yellow/red water-body polygons — cooling/abstraction feasibility |
| **Fibre / gigabit availability** | Ofcom Connected Nations postcode data <https://www.ofcom.org.uk/phones-and-broadband/coverage-and-speeds/> (note: full-fibre no longer separately reported — use "gigabit-capable") | OGL / CSV per postcode | Postcode-unit choropleth. Actual backhaul routes are commercial — flag |
| **Agricultural land quality** | Natural England Provisional ALC <https://naturalengland-defra.opendata.arcgis.com/datasets/Defra::provisional-agricultural-land-classification-alc-england/about> (+ newer Predictive ALC) | OGL / SHP, GeoJSON | Polygons — avoid Best & Most Versatile (grades 1–3a) |
| **DC planning pipeline** | PINS NSIP register (data centres are opt-in NSIPs since **8 Jan 2026**; CNI since Sept 2024) <https://infrastructure.planninginspectorate.gov.uk/> | OGL / web + docs | Points of DCO applications — both competition signal and policy precedent |
| Flood, green belt, environmental designations | **already in the app** | — | Reuse the existing granular layers in any DC composite score |

**Composite idea:** distance-to-substation-with-headroom × slope × flood ×
designations = a "DC site screen", again mirroring the sift-funnel pattern.

---

## 3. Local authority land & policy

| Layer | Source & URL | Licence / format | Render as |
|---|---|---|---|
| **Freehold parcel boundaries** | HMLR INSPIRE Index Polygons <https://use-land-property-data.service.gov.uk/datasets/inspire> (free, no registration, monthly, ~29 M polygons E&W) | Open w/ attribution / GML per LA | High-zoom parcel outlines — needs a PMTiles conversion job (multi-GB). Indicative extents, not legal boundaries |
| **Who owns it (corporate/public)** | HMLR CCOD (UK companies) + OCOD (overseas) <https://use-land-property-data.service.gov.uk/> — free but account + licence required; join to INSPIRE by title number | HMLR licence / CSV + API | Parcel fill by proprietor category — **"Local Authority" category filtered + INSPIRE join is the best national route to council-owned land polygons** |
| **Council asset registers** | Per-council "land and building assets" transparency CSVs on data.gov.uk (mandated, but patchy across ~300 councils) | OGL / CSV with grid refs | Points; use as a cross-check on the CCOD route rather than the primary source |
| **Central government estate** | e-PIMS transparency extract <https://www.data.gov.uk/dataset/17209eb1-98de-4b5c-ae49-258da9faeb0e/epims> — **superseded by GPA InSite; check staleness before building** | OGL / CSV | Points |
| **Local plans & policy areas** | planning.data.gov.uk: `local-planning-authority` (complete), `local-plan` + `local-plan-boundary` (partial), `article-4-direction-area`, `tree-preservation-zone`, `design-code-area`, `infrastructure-funding-statement` (CIL/S106, no geometry) — <https://www.planning.data.gov.uk/> | OGL / GeoJSON bulk + entity API | Mixed polygons. **One ingest pipeline covers the whole platform — highest-leverage single source in this roadmap** (we already use it for green belt + constraints) |
| **Admin boundaries** | ONS Open Geography Portal <https://geoportal.statistics.gov.uk/> (LAD/ward/LSOA + lookups) | OGL / GeoJSON, GPKG | Reference boundary lines; join spine for every LA-level choropleth |

---

## Cross-cutting notes

- **Scotland gap:** planning.data.gov.uk, INSPIRE, CCOD/OCOD, ALC and EA layers
  are England (& Wales) only. Scottish equivalents (Improvement Service Spatial
  Hub, Registers of Scotland) are partly closed/paid — needs its own pass if
  Scotland parity matters.
- **Licence watch-list:** OSM layers are ODbL (share-alike, fine as we already
  ship OSM rail); NGET route shapefiles are *not* open for commercial use (use
  OSM power instead); CCOD/OCOD require an HMLR account and licence acceptance;
  some DNO portals need free registration.
- **Storage:** national polygon loads need `CLIP_MODE=none` on
  `pipeline/build_constraints.py`-style loaders plus a paid Supabase tier, or a
  PMTiles static build for the biggest sets (INSPIRE parcels, slope).

## Suggested build order

1. **planning.data.gov.uk platform sweep** (LA boundaries, local plans, Article 4,
   TPO zones) — one pipeline, many layers, all OGL, slots straight into the
   existing "Planning & environment" group.
2. **University campuses + Census student % + PTAL** — three easy wins that make
   the student-housing scenario demo-able.
3. **OSM power network + NESO GSP boundaries + TEC register** — the data-centre
   grid backbone (new "Energy & utilities" group).
4. **UKPN + NGED capacity heatmaps** — connection headroom where it matters most.
5. **OS Terrain 50 slope tiles** — flatness for DC siting (raster route).
6. **CCOD "Local Authority" + INSPIRE join** — council-owned land polygons.
7. Rents, FHRS amenity density, water availability, NSIP pipeline, HMO registers.

---

## Local plan housing allocations — what is and is not available (Aug 2026)

Asked whether LPA-designated housing sites can be mapped nationally. Probed
`files.planning.data.gov.uk` directly rather than trusting the dataset index:

| Slug | Result |
|---|---|
| `site-allocation`, `housing-allocation`, `local-plan-site`, `site-allocations` | **403** — object does not exist (S3 returns 403, not 404, for a missing key) |
| `local-plan-boundary`, `brownfield-land`, `brownfield-site` | 206 — exists |
| `local-plan`, `local-plan-housing`, `local-plan-timetable` | 206 — exists (CSV) |

**There is no national dataset of allocated housing site polygons.** The
platform models allocations as a per-council publication, and only a minority
of LPAs have published anything conforming. That is a hard constraint, not an
ingestion problem to engineer around.

Three tiers were scoped:

1. **Plan-level arithmetic (BUILT — dataset `local_plan_housing`).** The three
   plan CSVs joined onto `local-plan-boundary` polygons: requirement,
   allocated, committed, windfall, broad locations → the **gap** each plan
   still has to close, plus adoption date, plan age against the 5-year review,
   stage and latest milestone. National, OGL, one pipeline pass. Coverage: 364
   boundaries, 338 with a plan record, **143** with numbers good enough to
   compute a gap and 134 publishing only part of their supply (shown, but with
   no gap — a blank cell is "not published", not zero, and treating it as zero
   put the wrong authorities at the top of the ranking). No site geometry —
   the polygon is the plan area.
2. **Better brownfield surfacing (not started).** Every LPA must publish a
   brownfield land register; `brownfield-land` (points, national) and
   `brownfield-site` (polygons, mostly London) are already loaded but are not
   presented as *deliverable capacity*. The registers carry
   `minimum-net-dwellings` / `maximum-net-dwellings` and a planning-status
   field that we currently drop.
3. **Harvesting allocation polygons council-by-council (not started).** Many
   LPAs publish policies-map allocations on their own ArcGIS/GeoServer
   endpoints. Real coverage, real geometry, but no common schema — a
   per-authority harvester with a hand-maintained endpoint registry, and it
   goes stale as plans are replaced. London first (the London Datastore and
   the boroughs' Local Plan policies maps are the most consistently published).

Deliberately **not** wired into the station sift: a plan-level shortfall is an
authority-wide policy signal, not a site attribute, and averaging it into a
per-station score would launder a coarse number into a precise-looking one.
