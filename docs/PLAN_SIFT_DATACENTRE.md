# Plan · Data-centre site-finding sift

A third sift tool alongside the NPPF station funnel: a sequential, adjustable
funnel over **precomputed per-candidate assessment rows**, exactly mirroring the
existing pattern in `web/src/app.js` (`SIFT_STEPS` / `enterSiftMode` /
`computeViability` over `public.station_assessments`): load all rows once from
Supabase, apply hard gates then scored axes client-side, live shortlist table,
localStorage persistence, CSV export, shortlist tray / compare / report reuse.

## 1. Purpose & user

Find grid-feasible, physically buildable, policy-tolerable locations for a
data-centre campus in Great Britain. The user is a developer / investor analyst
doing **strategic screening**, not detailed due diligence: they want to go from
"the whole country" to "40 candidate areas worth a site visit and a DNO/NESO
pre-application enquiry" in one session, with every elimination step visible,
justified and tunable — because a DC brief varies enormously (a 10 MW edge
facility and a 150 MW hyperscale campus have different power, land and water
needs, so every threshold must be a control, not a constant).

## 2. Candidate universe

**Recommended: a supply-anchored hexagonal grid.** Generate hex cells (PostGIS
`ST_HexagonGrid`, edge ≈ 1,400 m in EPSG:27700 → ~5.1 km² per cell, apothem
~1.2 km) covering the union of **5 km buffers around every substation ≥ 132 kV**
in the `power_substation` dataset. Each hex is one candidate row. Expected
volume: roughly 10–20k cells GB-wide after a precompute-time floor of ≥ 5 ha
land that is not built-up/water (a non-adjustable physical-impossibility screen
to keep the client payload in the same order as the station sift's paged load).

Why hexes over the alternatives:

- **Brownfield register sites** — real, nameable sites, but the register is
  residentially biased, patchy by LPA and misses the greenfield/agricultural
  edge-of-substation land where most large DC campuses actually land. Kept as a
  *scoring input* (brownfield share of a hex) and a v2 overlay, not the universe.
- **INSPIRE land parcels** — the ideal end state (an actionable freehold with
  an owner via CCOD), but 29 M polygons, no ingestion yet, and parcel-level
  assessment explodes the precompute. Deferred to v2 as a *drill-down within a
  surviving hex*, not the ranked unit.
- **Substations themselves** (station-sift style points) — reuses the plumbing
  best, but a substation is a supply point, not a site: land quality varies
  hugely around it and one substation can serve several distinct opportunities.
  The hex grid keeps the "point-like row + catchment stats" shape while ranking
  *land*, which is what the user buys.

Hexes are exhaustive within the supply zone, uniform (comparable scores), cheap
to precompute, and degrade gracefully as datasets arrive — a missing layer just
nulls one column for every cell.

## 3. Funnel design

Sequential wizard steps in the `SIFT_STEPS` shape (each step = predicate +
controls + about-panel with what/source/calc). Gates first, then one scored
step carrying the weighted axes.

### Gates (eliminate)

| # | Stage | What it checks | Default threshold (rationale) | Dataset(s) | User adjusts |
|---|-------|----------------|-------------------------------|------------|--------------|
| 1 | Grid proximity | Distance from hex centroid to nearest substation at/above a voltage tier; distance to nearest ≥ 132 kV line as fallback | ≤ 5,000 m to a ≥ 132 kV substation. A dedicated 132 kV connection runs ~£1–2 m/km, so beyond ~5 km connection cost dominates; 132 kV supports ~30–90 MW, 275/400 kV needed for 100 MW+ | `power_substation`, `power_line` | Max distance (1–10 km slider); min voltage tier (132 / 275 / 400 kV); "require second substation within 10 km" toggle (diverse-feed resilience, default off) |
| 2 | Buildable land | Contiguous-ish developable area in the cell after erasing built-up land, water, transport corridors and hard environmental designations (same erase set as station sift step 3) | ≥ 10 ha developable. ~2–3 ha per 10 MW of IT load incl. plant/substation/landscaping, so 10 ha ≈ a 40 MW campus; hyperscale briefs raise this to 25–30 ha | existing constraints/developable plumbing (reuse `developable_land` erase set), `brownfield` | Min developable ha (0–50); "brownfield presence required" toggle (default off) |
| 3 | Flood | Share of the cell in Flood Zone 3 | ≤ 10% FZ3. DCs carry critical loads; the NPPF sequential test steers them out of FZ3 and insurers/hyperscalers screen it out anyway. 10% (not 0) tolerates rivers clipping a corner of a 5 km² cell | existing flood layer (constraints) | Max FZ3 % (0–100 slider); FZ2 informational only |
| 4 | Slope *(v2 — passes all when null)* | Mean slope of the developable land | ≤ 5% mean slope. DC pads want < 2–3°; cut/fill cost climbs steeply past ~5–6% | `slope` (OS Terrain 50 derivative, roadmap item 5) | Max mean slope % (2–15) |
| 5 | Policy exclusions | Green Belt share; Best & Most Versatile agricultural land (ALC 1–3a) share; soft-designation (AONB/National Landscape, conservation area) share | Green Belt: include but flag (default), optional exclude > 75% cover. ALC BMV ≤ 50% (NPPF footnote steers development away from grades 1–3a but doesn't prohibit). Soft designations ≤ 50% | existing green belt layer, `alc`, existing soft designations | Green Belt include/flag/exclude tri-state; max BMV %; max soft-designation % |
| 6 | Grid capacity *(degrades to pass-through when null)* | GSP-level connection contestation (queued TEC MW at the cell's Grid Supply Point) and, in v2, DNO demand headroom | Queued MW at GSP ≤ 2,000 MW default (heavily contested GSPs mean 2030s connection dates); v2: DNO headroom ≥ 50 MW | `gsp_boundary`, `tec_register`; v2 DNO registers | Max queued MW at GSP; min headroom MW (v2); "skip this gate" toggle |

### Scored axes (final step — 0–100 each, weighted, adjustable)

Composite step titled "7 · Score & rank", mirroring the station sift's
viability step: axis assumptions + weights + min-composite filter + rank-by.

| Axis | Weight | 0–100 scoring (piecewise-linear bands) | Dataset(s) |
|------|--------|----------------------------------------|------------|
| Power | 35 | Distance to qualifying substation: ≤ 1 km = 100, 2 km = 80, 5 km = 40, > 8 km = 0. +10 capped bonus for 275/400 kV, +5 for a second substation ≤ 10 km. v2: blend in headroom MW bands (≥ 100 MW = 100, 50 = 70, 20 = 40, < 10 = 10) and queue penalty | `power_substation`, `power_line`; v2 `tec_register`, DNO |
| Land | 25 | Developable ha: 10 = 40, 30 = 80, ≥ 50 = 100. +10 capped bonus scaled by brownfield share; slope penalty when present (mean ≤ 2% = no penalty, 5% = −20, 8% = −40) | developable erase set, `brownfield`, `slope` |
| Water | 15 | EA CAMS resource status of the cell's water body: water available = 100, restricted = 60, over-licensed = 30, over-abstracted = 10, null = axis dropped. Assumption toggle "air-cooled design" halves this axis's weight | `water_availability` |
| Planning risk | 15 | 100 minus penalties: Green Belt share × 40, BMV share × 25, soft-designation share × 25, floor 0. v2: +10 bonus if an NSIP DC precedent within 25 km | green belt, `alc`, soft designations; v2 NSIP register |
| Market & fibre | 10 | Distance to nearest major metro/IX node (London, Slough, Manchester, Cardiff, Edinburgh — static list): ≤ 25 km = 100, 50 km = 70, 100 km = 40, > 200 km = 10. v2: gigabit-capable share of postcodes in cell replaces the distance proxy | static metro list in pipeline; v2 Ofcom Connected Nations |

## 4. Scoring model

Same shape as the app's weighted-domain pattern (plot report domains) and
`computeViability`'s transparent client-side recompute:

```
axisScore_i ∈ [0,100]   (piecewise-linear band functions over precomputed columns)
composite   = Σ (w_i × axisScore_i) / Σ w_i      over axes with non-null data
```

- **Renormalisation over non-null axes** is the graceful-degradation mechanism:
  a missing dataset (slope, water, TEC) drops its axis rather than zeroing it.
- Weights default to 35/25/15/15/10, editable via sliders on the final step
  (persisted like `SIFT.assumptions` via `mmStore`); band breakpoints are the
  "assumptions" analogue and also editable (advanced disclosure).
- Filter on the final step: `minComposite` (default 0 — rank-only, like
  `minProfitOnCost` defaulting low). Rank-by: composite | power | land.
- RAG chip: composite ≥ 70 strong / 45–70 possible / < 45 weak, mirroring the
  viable/marginal/unviable chips.
- All banding happens client-side over raw precomputed columns — never
  precompute the scores themselves, or the controls stop working.

## 5. Precompute pipeline

**Table** (tiny, no geometry — same convention as `station_assessments`;
candidate geometry lives in `map_features` as dataset `dc_candidate`,
`source_id` = `hex_id`, served by `features_in_bbox` for map rendering):

```sql
create table public.dc_site_assessments (
  hex_id          text primary key,       -- ST_HexagonGrid "i_j" id @27700
  lng             double precision,       -- centroid (flyTo / client rendering)
  lat             double precision,
  region          text,
  lpa             text,                   -- from lpa_boundary
  -- power
  sub_id          text,                   -- map_features(power_substation).source_id
  sub_name        text,
  sub_voltage_kv  integer,
  sub_dist_m      integer,
  sub2_dist_m     integer,                -- 2nd-nearest ≥132 kV substation
  line_dist_m     integer,                -- nearest ≥132 kV line
  gsp_id          text,
  gsp_queued_mw   numeric,                -- Σ TEC register at GSP (null until ingested)
  headroom_mw     numeric,                -- DNO registers (v2)
  -- land & constraints (area shares of the cell)
  land_ha         numeric,                -- cell minus built-up/water
  developable_ha  numeric,                -- after hard-exclusion erase
  brownfield_ha   numeric,
  slope_mean_pct  numeric,                -- v2
  flood3_pct      numeric,
  green_belt_pct  numeric,
  alc_bmv_pct     numeric,                -- ALC grades 1–3a share
  soft_desig_pct  numeric,
  water_status    text,                   -- CAMS: available|restricted|over_licensed|over_abstracted
  fibre_ok        boolean,                -- v2 Ofcom
  metro_km        numeric,
  updated_at      timestamptz not null default now()
);
```

RLS public-read + `anon` select grant, as per `0022_map_features.sql`.

**Script** `pipeline/build_dc_assessments.py` (station-assessment style: a
migration adds a `rebuild_dc_site_assessments(batch text)` plpgsql RPC; the
Python script drives it in batches to stay under statement timeouts):

1. Qualifying substations: `map_features` where `dataset='power_substation'`
   and `(props->>'voltage')::int >= 132000` (OSM tagging is volts; also accept
   `substation=transmission` where voltage is untagged, flagged in props).
2. Hex generation: `ST_HexagonGrid(1400, ST_Transform(ST_Union(ST_Buffer(geom::geography, 5000)::geometry), 27700))`,
   keep hexes intersecting the buffer union; write hex polygons (back in 4326)
   to `map_features` as `dc_candidate`.
3. Per hex: nearest substation/line via KNN `order by geom <-> hex limit 1`
   (geography distance for metres); GSP by `ST_Contains` point-in-polygon on
   `gsp_boundary`; LPA likewise on `lpa_boundary`.
4. Area shares: `ST_Area(ST_Intersection(hex, layer))/ST_Area(hex)` against
   flood/green belt/`alc`/soft designations (union per layer first);
   developable_ha via the existing erase machinery reused with the hex as the
   catchment polygon instead of an 800 m circle.
5. `water_status`: point-in-polygon on `water_availability`; `metro_km` from a
   hard-coded metro list; `slope_mean_pct` left null until the slope dataset
   ships (then: zonal mean over slope polygons or raster, whichever route
   roadmap item 5 lands on).
6. TEC refresh: a separate cheap step joins `tec_register` rows (substation
   name → GSP) and updates only `gsp_queued_mw`.

**Cadence:** full rebuild monthly (OSM power, planning layers move slowly) and
whenever a feeding dataset is re-ingested; TEC queue column refresh
twice-weekly to match the NESO publication rhythm. `updated_at` surfaces
staleness in the UI footer.

**Client load:** page through `dc_site_assessments` in 1,000-row ranges exactly
as `loadSiftData()` does, ordered by `developable_ha desc`.

## 6. UI

- **Tool picker.** The `mode-switch` in the "Rail & stations" box (rename box
  to "Site sift & stations") keeps two modes: *Explore* | *Site sift*. Entering
  sift now shows a **tool selector row** above the stepper — three chips styled
  like the existing England/Scotland country toggle: `Stations (NPPF)` ·
  `Data centres` · `Student housing`. Selection persisted as
  `mmStore("siftTool")`.
- **Refactor.** Extract the current sift into a tool definition object —
  `{ id, label, loadRows, steps (SIFT_STEPS-shape), sortKeys, tableColumns,
  highlight(surv), drillTo(id), exportCols }` — registered in a `SIFT_TOOLS`
  map; `SIFT` state, criteria and shortlist become per-tool, with namespaced
  localStorage keys (`mastermapper:sift:dc:config`, `…:shortlist`). Stepper,
  funnel counts, about-panels, results table, CSV export, shortlist tray,
  comparison modal and printable report are shared shells parameterised by the
  tool definition.
- **Steps** = the six gates + score step from §3, each with the standard
  what/source/calc about-panel. The country toggle is hidden for this tool
  (GB-wide; power data is not England-split).
- **Map.** Survivors rendered from a client-side GeoJSON source built from the
  loaded rows (hex outline reconstructed from centroid + fixed edge length, or
  centroid dots at low zoom) — the DC analogue of `highlightSiftSurvivors`'s
  `setFilter`; colour by composite band. At high zoom, fetch true hex polygons
  for the viewport via `features_in_bbox('dc_candidate', …)`.
- **Click-to-profile.** Row click / hex click flies to the cell and runs the
  existing **plot report** (`buildReport`) over the hex polygon — the deep-dive
  comes free — plus a DC panel: nearest substation (name, kV, distance), GSP
  queue, water status, share breakdown.
- **Shortlist / compare / export.** Star-pinning keyed on `hex_id`; snapshot
  fields swapped for the DC columns; ranked CSV + shortlist CSV + printable
  report reuse the existing exporters with the tool's `exportCols`.

## 7. Data gaps & phasing

**MVP** (buildable once the parallel ingestion lands its first wave —
`power_substation`, `power_line`, `gsp_boundary`, `lpa_boundary`, `alc`,
`water_availability` — plus layers already in the app: flood, green belt, soft
designations, brownfield, built-up land):

- Gates 1, 2, 3, 5 fully live; gate 4 (slope) and gate 6 (capacity) render but
  pass everything, badged "data pending" in their about-panels.
- Axes: Power (distance/voltage part), Land (minus slope penalty), Water,
  Planning risk, Market (metro-distance proxy) — composite renormalises.

**v2** (needs new ingestion/registration): `tec_register` name→GSP join
(fiddly matching; late-MVP if easy), DNO headroom registers (free registration,
six portals — start UKPN), slope dataset (OS Terrain 50 job), Ofcom fibre,
NSIP precedent points, INSPIRE + CCOD parcel/ownership drill-down inside a
shortlisted hex.

**Degradation rule** (uniform): a gate whose feeding column is null for a row
passes that row (mirrors the `r.regen == null → true` pattern); an axis whose
column is null is dropped from the weighted sum. Every step's about-panel
states its data status so eliminations are never silently wrong.

## 8. Open questions for the product owner

1. Target scheme size: is the default brief ~40 MW / 10 ha, or should defaults
   assume hyperscale (100 MW+, 25 ha, 400 kV) with a preset switcher
   ("Edge / Campus / Hyperscale" presets over the same controls)?
2. Green Belt appetite: include-and-flag (proposed) or hard-exclude by default?
3. Scotland: OSM power and CAMS-equivalent coverage differ — ship GB-wide with
   England-only columns nulled, or England-first like the station sift split?
4. Is a 5.1 km² hex the right grain, or is a finer second-tier grid (subdivide
   surviving hexes) wanted before the parcel drill-down exists?
5. TEC queue as gate default-on or default-off once ingested? (Contested GSPs
   are also where the demand signal is strongest.)
6. Any commercial datasets in play (e.g. connection-offer intel) that should
   shape the schema now even if ingested later?
