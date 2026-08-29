# Plan · Data-centre site sift — nationwide subtractive map

**Brief (2026-08-28):** a nationwide subtractive mapping exercise in its own
collapsible box at the BOTTOM of the left bar. Progressively subtract parts of
the map; remaining potential zones GREEN, the rest RED. Checkbox erase set
(built-up, roads, protected, flood…), a flatness threshold, distance-to-energy-
infrastructure and distance-to-settlement criteria (district-heat relevance,
with heat networks mapped), any other logical subtractive criteria, plus a
politics/planning layer: PlanIt approval/rejection statistics for data-centre
applications by local authority, council control and MP.

Supersedes the hex-candidate funnel in `PLAN_SIFT_DATACENTRE.md` (whose
substation/TEC research is folded in here). Audited against the live DB
2026-08-28.

---

## 1. Dataset audit (verified against the live DB)

Key finding first: **"planning_constraints is station-clipped" is out of
date.** `build_constraints.py` defaults to `CLIP_MODE=stations`, but the
workflow that actually loads it (`.github/workflows/load-constraints.yml`,
line 184) defaults to `CLIP_MODE: 'none'`, verified empirically: a bbox in
rural North Devon (Hartland, >25 km from any station) returns full constraint
coverage (352 water, 338 FZ2, 218 listed buildings, 78 FZ3, 11 SSSI…).
Constraints are **national**. The real coverage cut is by **country**.

### 1a. planning_constraints (17 kinds, 2.05M rows)

| kind | rows | source | coverage | fit for DC sift |
|---|---|---|---|---|
| water | 548,938 | OS OpenMap Local | GB | erase |
| flood_zone_2 | 525,720 | EA | **England only** (Wales: 1 row, Scotland: 0) | optional erase |
| listed_building | 505,902 | planning.data.gov.uk ×2 + HES | E+S | ignore for DC (points) |
| flood_zone_3 | 215,378 | EA | **England only** | erase |
| green_space | 165,831 | OS Open Greenspace | GB | erase (optional) |
| ancient_woodland | 44,942 | NE + Scot | E+S | erase |
| scheduled_monument | 20,150 | HE + HES | E+S | erase |
| transport | 10,158 | OS OpenMap Local, buffered & dissolved | GB | erase (dissolved — road classification lost) |
| conservation_area | 9,690 | planning.data.gov.uk + HES | E+S (E incomplete by LPA) | erase (optional) |
| built_land | 8,716 | OS Open Built Up Areas, dissolved | GB | erase |
| sssi | 4,354 | NE + Scot | E+S | erase |
| park_garden | 1,723 | HE | E(+S) | erase (optional) |
| sac / ramsar / spa | 320 / 168 / 146 | JNCC | E+S | erase |
| green_belt | 190 | planning.data.gov.uk | England | optional erase |
| aonb | 34 | NE | England (Scottish NSAs not loaded) | erase (optional) |
| buildings | **0 — kind defined but never loaded** | OS OpenMap Local Building | — | not needed at 1 km grain |

### 1b. map_features energy/site datasets

| dataset | rows | coverage | real prop keys (sampled) | assessment |
|---|---|---|---|---|
| power_substation | 57,682 | GB (OSM/ODbL) | `operator`, `substation` (transmission 841 / distribution 3,037 / minor 22,536 / null 29,282), `voltage` (raw `"11000;400"`), `kv` | **only ~20% carry kv.** kv≥132: **1,729**; kv≥275: **492**. Voltage tier is the anchor; no MVA — DNO headroom is the capacity proxy. State the OSM-completeness caveat in the UI. |
| power_line | 16,612 | GB (OSM) | `kv` | kv≥132: 12,338 — good "near HV line" fallback |
| gsp_boundary | 362 | GB (NESO) | `queued_mw`, `queued_n` (rebuild_gsp_queue, 0035) | ready — per-cell GSP queue join is trivial |
| tec_register | 1,647 | GB (NESO) | `mw`, `mw_connected`, `status` (Scoping…Built), `plant`, `host_to`, `site`, `substation`, `customer` | carries MW and status; already feeds queued_mw |
| ukpn_sites | 1,504 | **London/SE/East** | `sitevoltage`, `siteclassification` (HOT/COLD), `maxdemandsummer/winter`, `transratingsummer/winter`, `local_authority` | headroom derivable ≈ Σ transratingwinter − maxdemandwinter |
| nged_sites | 1,180 | **Midlands/SW/S. Wales** | `demandconnectedheadroommw`, `demandcontractedheadroommw`, RAG, `gsp`, `bsp` | best-in-class: 36 sites ≥50 MW headroom |
| npg_sites | 681 | **NE/Yorkshire** | `demhr`, `genhr`, `firm_cap`, `maxdemand`, RAG, `pvoltage` | 56 sites ≥50 MW |
| spen_sites | **0** | NW Wales/Mersey + S. Scot | builder EXISTS (`DNO_SITES`, build_datasets.py:218, working URLs) | **not loaded — just needs a run** |
| enwl_sites | **0** | NW England | builder exists, default URL | not loaded |
| ssen_sites | **0** | N. Scot + central-S England | builder exists, `SSEN_SITES_SRC` env needed | **biggest DNO hole — central-south England is DC heartland** |
| water_availability | 4,435 | **England** (EA CAMS) | `status` (Green 1,402 / Yellow 943 / Red 1,874 / Grey 216), `resavail`, `camscdsq*` | ready |
| alc | 1,326 | **England** | `alc_grade`: 1 (90), 2 (177), 3 (269), 4 (249), 5 (148), Urban, Non-Ag | **no 3a/3b split** — "BMV" ≈ grades 1–2 only; say so. Repo source URL is an EXPIRED signed link (expired 2026-07-24) — refresh for rebuilds. |
| slope_grid | 285,800 | **GB, 1 km cells** | `slope` (mean, **degrees**), `max_slope` | ready — the natural cell universe for the whole sift (`sl-{easting}-{northing}`). User asked % threshold; cells store degrees (5.7° ≈ 10%) — display both. |
| planit_rates | 276 LPAs | E+W | `approved_3y`, `refused_3y`, `approval_pct`, `apps_year` | nightly sync (load-planit.yml 02:10) — the plumbing DC-specific stats extend |
| lad_boundary / lpa_boundary | 361 / 337 | UK / England | `lad_code` | join spine for choropleths |
| brownfield (table) | national | England | `hectares`, `ownership_status`, `deliverable`, `permission_status` | optional "prefer brownfield" scoring |
| ofcom_fibre | **0** | — | builder exists, no source configured | gap |
| aqma | 498 | UK | `reference` | optional erase (genset permitting) |

**DNO verdict:** loaded = UKPN + NGED + NPG. Missing = **ENWL, SPEN, SSEN** —
all three have builders; SPEN/ENWL load with zero code changes, SSEN needs a
source URL. Until then "DNO headroom" renders as "no data" (pass-through) in
those licence areas, never as red.

**Serving RPCs:** `features_in_bbox` (one numeric filter), `grid_in_bbox`
(one avg + one max key), `constraints_in_bbox`, `dataset_features_page`. None
can serve a multi-attribute national grid with arbitrary boolean filters — that
drives §3. PTAL measured the bbox RPC at **20.8 s for 52k cells at z12** — a
national grid must be PMTiles.

---

## 2. Gap list — missing inputs with sources

| # | Gap | Named free source | Format | Licence | Builder |
|---|---|---|---|---|---|
| G1 | **Settlements with population** | OS Open Built Up Areas (GSS codes) + ONS Census-2021 BUA population (Nomis/geoportal); Scotland: NRS Settlements | GPKG ~100 MB + CSV | OGL | `build_settlements()` → dataset `settlement` `{name, pop}` |
| G2 | **Heat networks (existing & proposed)** | DESNZ **Heat Networks Planning Database**, quarterly CSV on data.gov.uk (dataset `065d267f-23bc-4d0e-9a56-52d388d5835c`, latest `HNPD_2026_Q2.csv`). Stages inception→operational cover both "proposed" and "existing". Geocode by postcode via ONSPD | CSV, few MB | OGL | `build_heat_networks()` → `heat_network` `{status, technology, dwellings, operator}` |
| G3 | **Missing DNO headroom** | run existing `build_dno_group()` for SPEN + ENWL; SSEN: data.ssen.co.uk network-capacity CSV → `SSEN_SITES_SRC` | CSV | DNO open-data | no new code |
| G4 | **Classified major roads** | **OS Open Roads** (`road_classification` ∈ Motorway/A Road/B Road) | GPKG ~500 MB | OGL | `build_major_roads()` → `major_road` `{cls}` |
| G5 | NESO strategic headroom | ETYS Appendix B workbooks + boundary shapefiles; Gate 2 queue data | XLSX+SHP | NESO | phase 4; `gsp_boundary.queued_mw` already tells the story |
| G6 | **Wales flood zones** | NRW Flood Map for Planning via DataMapWales WFS | GeoJSON | OGL | build_constraints.py, same kinds |
| G7 | Scotland flood | SEPA — licence NOT clean OGL | — | leave null, badge "no data" | — |
| G8 | Fibre proxy | Ofcom Connected Nations postcode CSV (gigabit %) — only free option; true backhaul is commercial | CSV ~300 MB | OGL | existing `build_ofcom_fibre()` |
| G9 | **Council political control** | **Open Council Data UK** (annual CSVs 2016–2026, public domain); cross-check HoC Library | CSV tiny | CC/PD | `build_council_control()` → `council_control` `{control, largest_party, seats_json, asof}` |
| G10 | **MP + party by constituency** | ONS Westminster Constituencies (July 2024) BUC GeoJSON (~575) + UK Parliament Members API (`IsCurrentMember=true`, no key) | GeoJSON+API | OGL/OPL | `build_constituencies()` → `constituency` `{pcon_code, mp_name, mp_party}` |
| G11 | **DC planning decisions** | **PlanIt API** `/api/applics/geojson`: `search`, `app_state`, `app_size`, `decided_start/end`, `pg_sz` 300, caps 5,000 results / 1,000 kB per request, 429s with Retry-After ≈60 s (already handled in `_planit_count`) | GeoJSON API | free, fair-use | `build_planit_dc()` + workflow (§5) |
| G12 | NSIP DC applications (opt-in since 8 Jan 2026) | PINS infrastructure register | web/CSV | OGL | phase-4 hand-curated (n tiny) |
| G13 | Scotland ALC equivalent | Hutton LCA 1:250k | SHP | check on ingest | phase 4 |
| G14 | Scottish NSAs (AONB equiv.) | NatureScot open data | GeoJSON | OGL | build_constraints.py, kind `aonb` |

No new national erase download is needed — the erase layers are already
national (§1a); the gaps are country edges.

---

## 3. Sift engine architecture

### Recommendation: precomputed national grid → one PMTiles layer → client-side filter expressions, plus one thin stats RPC.

**Cell universe: the existing 1 km OSGB grid** (same footprint as `slope_grid`,
285,800 cells). Phase 4 can rerun at 500 m (~1.05M cells); 1 km is the right
grain for a strategic screen and makes the slope join a no-op.

**Why not dynamic PostGIS erase:** the station RPC takes seconds for one 800 m
circle; the erase set nationally is ~2M polygons over 230k km². Per-viewport
boolean geometry at z6 would be minutes per pan on shared Postgres. The PTAL
numbers above kill even lighter dynamic approaches. Dynamic erase stays the
station-level drill-down.

**Why the grid wins:** it is the `slope_grid`/`price_grid`/PTAL pattern one
step further — each cell carries ~16 small quantised attributes, and every
checkbox/slider is a MapLibre paint expression: recolouring 100k on-screen
cells is one `setPaintProperty`, zero network, <16 ms. Tiles are built by the
already-generic `build_ptal_tiles.py` (`TILE_DATASET`/`TILE_PROPS`) +
`build-ptal-tiles.yml`, served from the existing `tiles/` bucket via
`ensureOverlayTiles`.

### 3.1 Table + precompute — migration `0067_dc_grid.sql`

```sql
create table public.dc_grid (
  cell_id text primary key,          -- "dc-{easting}-{northing}", 1 km OSGB
  geom geometry(Polygon,4326) not null,
  lng double precision, lat double precision,
  lad smallint,                      -- index into a lad lookup emitted at build
  -- distances in 100 m units, capped 25 km (0..250); 255 = none / no data
  d_sub132 smallint, d_sub275 smallint,   -- nearest OSM substation ≥132/≥275 kV
  d_line132 smallint,                      -- nearest OSM line ≥132 kV
  d_dno50 smallint, d_dno20 smallint,      -- nearest DNO site headroom ≥50/≥20 MW
  d_set5 smallint, d_set20 smallint, d_set100 smallint,  -- settlement ≥5k/20k/100k
  d_road smallint,                         -- motorway or A-road
  d_heat smallint,                         -- nearest heat network (any status)
  -- cell composition, integer percent 0..100 (-1 = unknown)
  built_pct smallint, prot_pct smallint,   -- prot = sssi|sac|spa|ramsar|aw|sm|lnr
  herit_pct smallint,                      -- conservation|park_garden|aonb
  fz3_pct smallint, fz2_pct smallint, gb_pct smallint, alc12_pct smallint,
  water_pct smallint, transp_pct smallint,
  slope10 smallint,                        -- mean slope, degrees ×10 (slope_grid)
  water_stat smallint,                     -- CAMS 0 green 1 yellow 2 red 3 grey, 9 n/a
  gsp_mw smallint,                         -- GSP queued_mw / 100, capped
  aqma smallint,                           -- 0/1
  updated_at timestamptz default now());
-- + rebuild_dc_grid(p_part, p_parts) batched like rebuild_lsoa_prices
-- + dc_sift_stats(p jsonb) -> {green_km2, green_cells, total_cells, top_lads[20]}
```

Precompute per batch: grid seed from `slope_grid` geometry; distances via
indexed KNN (`order by geom <-> centroid limit 1`) against materialised subsets
(kv≥132 n=1,729; kv≥275 n=492; DNO-headroom sites; settlement pop bands;
major_road; heat_network); composition percents via
`sum(ST_Area(ST_Intersection(cell, geom_simple)))/ST_Area(cell)` per kind-group
(the heavy step — one-off then monthly); joins for lad/gsp_mw/water_stat/aqma.
**No-data baked in at build time:** Scotland `fz3_pct=-1`, non-England
`water_stat=9`, DNO-uncovered `d_dno50=255` — client treats unknown as pass +
badge (the station sift's null-degradation rule).

Then mirror to `map_features` dataset `dc_grid` → tippecanoe z4–z11 →
`tiles/dc_grid.pmtiles` (~30–60 MB). MapLibre overzooms past z11; 1 km blocks
at z13+ look chunky — acceptable, and the drill-down switches to real vectors.

### 3.2 Client-side composition

```js
function dcPassExpr(c) {
  const conds = [];
  if (c.exBuilt) conds.push(["<=", ["get","built_pct"], c.builtMax]);   // 10
  if (c.exTrans) conds.push(["<=", ["get","transp_pct"], 20]);
  if (c.exWater) conds.push(["<=", ["get","water_pct"], 20]);
  if (c.exProt)  conds.push(["<=", ["get","prot_pct"], c.protMax]);     // 5
  if (c.exHerit) conds.push(["<=", ["get","herit_pct"], c.heritMax]);
  if (c.exFz3)   conds.push(["<=", ["coalesce",["get","fz3_pct"],0], c.fz3Max]);
  if (c.exFz2)   conds.push(["<=", ["coalesce",["get","fz2_pct"],0], c.fz2Max]);
  if (c.exGB)    conds.push(["<=", ["get","gb_pct"], 25]);
  if (c.exAlc)   conds.push(["<=", ["get","alc12_pct"], 25]);
  conds.push(["<=", ["get","slope10"], Math.round(c.maxSlopeDeg*10)]);
  // power: c.powerAttr ∈ d_sub132|d_sub275|d_dno50|d_line132; slider km → ×10
  conds.push(["<=", ["get", c.powerAttr], c.powerKm*10]);
  if (c.powerAttr === "d_dno50")   // 255 here mostly means "DNO not ingested"
    conds[conds.length-1] = ["any", ["==",["get","d_dno50"],255], conds[conds.length-1]];
  if (c.avoidQueue) conds.push(["<=", ["coalesce",["get","gsp_mw"],0], c.maxQueue100]);
  conds.push(["any", ["==",["get",c.setAttr],255], ["<=",["get",c.setAttr], c.setKm*10]]);
  return ["all", ...conds];
}
```

The 255-passes-as-unknown rule applies ONLY to attributes where 255 means "not
ingested" (DNO, settlement pre-Phase-2); for OSM substations 255 genuinely
means "nothing within 25 km" and FAILS. Documented per-attribute in the
about-panel.

**Rendering:** `fill` layer, `fill-color: ["case", dcPassExpr(c), "#2f9e44",
"#c92a2a"]`, opacity slider default 0.35 (red at 0.75× so eliminated mass
doesn't drown the basemap); "green only" toggle switches to setFilter + green
fill; thin outline from z9; inserted via `overlayBeforeId()` so station dots
stay on top; hover card via `hoverContentForOverlay`.

### 3.3 Aggregate readout

`dc_sift_stats(p jsonb)` mirrors the expression server-side — one seq scan of
286k rows (~150–400 ms) → `{green_km2, green_cells, total_cells, top_lads}`.
Called debounced (~600 ms) on control release: map recolours instantly, numbers
follow a beat later (the station-sift funnel contract). **Largest contiguous
zones:** exact national connected-components under arbitrary filters is
expensive — Phase 2 ships "largest zones in view" (client union-find over
`queryRenderedFeatures`, labelled "in current view"); Phase 4 option: nightly
`ST_ClusterDBSCAN` snapshot for the default preset only.

---

## 4. UI spec — the bottom box

`web/index.html`: `<section class="side-box" id="dc-sift-box">` after
`#pbsa-box`; `wireSideBoxes()` gives collapse/persist free
(`ui.box.dc-sift-box.min`). New `wireDcSiftBox()` next to `wirePbsaBox()`.
State `DC` persisted via `mmStore` (`dcSiftConfig`), mirroring
`SIFT`/`persistSiftConfig`.

```
▾ Data-centre sift
  [ Activate ▢ ]
  1 · Remove land   (checkbox grid, each with ⓘ source tooltip)
    ☑ Built-up areas  ☑ Roads & rail  ☑ Water
    ☑ Protected nature (SSSI·SAC·SPA·Ramsar·AW·SM)
    ☐ Heritage & landscape (CA·RPG·AONB)  ☑ Flood zone 3  ☐ Flood zone 2
    ☐ Green Belt  ☐ Best farmland (ALC 1–2)  ☐ AQMA
    [advanced ▸ per-item "max % of cell" inputs]
  2 · Flatness   max mean slope [====|——] 5.0° (~9%)
  3 · Power      within [==|—] 5 km of [≥132 kV substation ▾]
                 (≥132 kV sub · ≥275 kV sub · DNO site ≥50 MW headroom · ≥132 kV line)
                 ☐ avoid contested GSPs (queue > [2,000] MW)
                 ⚠ badge when selector = DNO and viewport is a non-ingested DNO area
  4 · Settlement within [====|] 10 km of a settlement of [20k+ ▾] people
                 ☐ show heat networks (● operational ○ proposed — DESNZ HNPD)
  ── Result ──────────────────────────────
  ██ 4,120 km² potential (1.8% of GB) · 61,400 cells
  Top districts: 1 East Riding 212 km² · 2 Wiltshire 189 · 3 …  [full ranking ↗]
  [Green only ▢] [opacity ——●—] [Reset] [Export view GeoJSON]
  ── Planning & politics ─────────────────
  ☐ DC decisions (PlanIt)  ☐ Approval choropleth  ☐ Council control  ☐ MP / party
```

- **Drill-down:** click a green cell → per-cell scorecard popup: each criterion
  with value/threshold/✓✗– (– = no data + country reason), nearest substation
  name/kV/distance, GSP queue, settlement, LA + approval rate + control.
  Buttons: **"Deep dive this square"** (feeds the cell polygon into the
  existing plot flow — polygon catchments already supported) and **"Zoom"**.
- **Coexistence with the station sift:** independent — no mode switch. DC
  layers below `station-dot` via `overlayBeforeId()`; DC legend hides while
  `sift-legend` is visible.
- ~40 lines of styles.css reusing `.pbsa-crit-*` / `.sl-*` patterns.

---

## 5. Politics & planning layer

### 5.1 PlanIt DC decisions

- `GET /api/applics/geojson` (Point geometry). National sweep **by date
  window, not by authority**: `search="data centre" OR "data center" OR
  datacentre OR "server farm"`, `decided_start/end` in 6-month slices from
  2015, `pg_sz=300`, paginate under the 5,000-results/1,000 kB caps. No DC
  use-class exists (sui generis/B8-ish since Sept 2020) so keyword search is
  the only route; filter noise client-side on description regex, dedupe by
  `uid`, flag `app_size=Large`.
- Storage: dataset `dc_application` (point; `{uid, auth, description(300),
  app_state, app_size, decided_date, start_date, url}`) — low thousands,
  served by `features_in_bbox`.
- Aggregation: nightly `rebuild_dc_rates()` → dataset `planit_dc_rates` (LAD
  polygons, `{dc_apps, dc_permitted, dc_rejected, dc_pending, dc_approval_pct,
  since}`), cloning the planit_rates join.
- Refresh: extend `load-planit.yml` (02:10) — monthly full re-sweep, nightly
  decided-last-30-days delta, same progress-cache trick.

### 5.2 Choropleths

Three `MAP_OVERLAYS` entries under a new `politics` sub-group:
- `planit_dc_rates` — colour by rate ONLY when `dc_apps ≥ 5`; below that,
  hatched grey "too few decisions (n)" — enforced in the paint expression, not
  the tooltip. About-text: the map mostly measures *where DCs are proposed*,
  not systematic hostility; pair each LA's DC rate with its all-apps baseline.
- `council_control` — categorical fill by control, annual refresh (G9),
  tooltip shows seats + as-of.
- `constituency` — MP name + party (G10), boundaries from z6.

The DC box's checkboxes proxy `toggleMapOverlay(key, on)` so the layers also
live in the Data-layers panel with opacity sliders for free.

**Printed caveats:** approval% ignores withdrawn/pending; committee vs
delegated not distinguished; PlanIt is England+Wales; council control ≠
committee arithmetic; control changes each May (`asof` shown).

---

## 6. Phased roadmap

**Phase 1 — visible green/red map from existing data. SHIPPED 2026-08-28.**
Migrations 0070 (dc_grid + rebuild + serving RPCs + stats) and 0071 (council
control + dd_station_context); the bottom-left box with erase set, slope,
power tier/distance, GSP queue, green-only and opacity controls; two-tier
numbers-only serving (4 km whole-GB blocks + 1 km viewport cells) instead of
tiles. Grid precompute runs in 16 northing bands; uncomputed cells render
neutral grey. Council control shipped EARLY (from phase 3) because the deep
dive's Key Facts wanted it. Original scope note follows. No new
ingestion. 0067 migration (table + rebuild + stats + grants); workflow
`build-dc-grid.yml` (loop rebuild parts → mirror to map_features → tile via
the build-ptal-tiles chain, z4–z11); `#dc-sift-box` markup; `DC` state +
`wireDcSiftBox` + `dcPassExpr` + layers + stats + hover + scorecard v1; css.
Ships criteria 1, 2, 3 (voltage tiers, HV line, GSP queue) + readout.
Phase-1 attrs: slope10, the *_pct set, d_sub132/275, d_line132, gsp_mw,
water_stat, aqma, lad; d_dno*/d_set*/d_road/d_heat = 255 for now.

**Phase 2 — settlement, DNO, heat, roads. SHIPPED 2026-08-29 (core).**
Migration 0072: `dc_settlement` (1,669 BUAs ≥5k pop — England ONS
LSOA→BUA×IMD populations; Scotland/Wales area-estimated, `est` flag),
`dc_heat` (1,495 DESNZ HNPD schemes, OSGB→WGS84), `dc_dno` (2,521 primary
substations with demand headroom: NGED + NPG published, UKPN derived N-1
excluding HOT sites; 252 ≥50 MW); six dc_grid distance columns
d_set5/20/100, d_dno20/50, d_heat filled by `rebuild_dc_grid_dist2()`
(whole-grid KNN, minutes); dc_cells_agg/dc_sift_stats extended (DNO 255 =
no-data passes); criterion-4 UI (settlement scale + km, heat km), DNO options
in the power selector with a coverage note, HNPD overlay via
`dc_heat_points()` with status-coloured points. Deferred from phase 2:
`build_major_roads`/d_road, SPEN/ENWL/SSEN (exports permission-gated),
largest-zones-in-view, LA ranking panel, export-view GeoJSON.

**Phase 3 — politics & planning (≈3–4 days).** `build_planit_dc` +
`rebuild_dc_rates` + workflow; `build_council_control` +
`build_constituencies`; three overlays + small-n hatching + scorecard
integration.

**Phase 4 — refinements.** 500 m grid rerun; Wales flood (G6); Scotland gaps
badged (G7/G13/G14); ETYS (G5); NSIP points (G12); default-preset contiguous
zones; presets ("Edge 10 MW / Campus 40 MW / Hyperscale 100 MW+") that just
set the controls.

**Touch list:** `supabase/migrations/0067_dc_grid.sql` (new) ·
`.github/workflows/build-dc-grid.yml` (new) · `load-planit.yml` (extend) ·
`pipeline/build_datasets.py` (5 builders) · `build_ptal_tiles.py` (reused
unchanged) · `web/index.html` · `web/src/app.js` (DC state, box, expression,
overlays + politics group, LAYER_INFO) · `web/src/styles.css` · docs.

**Attribution:** Contains OS data © Crown copyright & database right 2026
(OGL) · © OpenStreetMap contributors (ODbL) · EA/NE/HE/DESNZ (OGL) · NESO Open
Data · DNO open-data portals · PlanIt (planit.org.uk) · Open Council Data UK ·
Open Parliament Licence. No commercial licences anywhere in this plan.
