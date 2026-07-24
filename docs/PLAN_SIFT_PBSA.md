# Plan · PBSA (purpose-built student accommodation) site-finding sift

A sift tool for student-housing locations, built to the same architecture as
the NPPF station funnel in `web/src/app.js` (`SIFT_STEPS` / `enterSiftMode` /
`computeViability` over precomputed `public.station_assessments`): precomputed
per-candidate rows loaded once from Supabase, a sequential wizard of hard gates
then weighted scored axes recomputed instantly client-side, live shortlist
table, localStorage persistence, CSV export, shortlist tray / compare /
printable report reuse. Sits beside the station and data-centre sifts behind a
shared tool picker (see §6; the picker/refactor is specified once in
`PLAN_SIFT_DATACENTRE.md` §6 and shared).

## 1. Purpose & user

Find well-connected neighbourhoods where purpose-built student accommodation
would let quickly and consent plausibly — deliberately including places
*outside* the saturated core university districts (the roadmap's stated goal,
especially for London). The user is a PBSA developer/operator or investor
analyst screening nationally: they want to move from "every university city"
to "a dozen neighbourhoods worth agent calls and a planning pre-app", with the
demand, saturation, policy and rent assumptions all visible and adjustable —
because operators disagree precisely on those assumptions (e.g. whether
Article 4 areas are an opportunity or a warning).

## 2. Candidate universe

**Recommended: LSOAs (2021), filtered to university catchments.** One row per
LSOA whose population-weighted centroid lies within 8 km of a university
campus with ≥ 2,000 full-time students — roughly 8–15k rows in England, the
same order as the station sift's paged load.

Rationale:

- **PBSA demand is neighbourhood-scale**, and nearly every input is LSOA-native
  or trivially joined: Census student % (TS062), IMD, PTAL (area-weighted from
  the 100 m grid), Article 4 polygons, LA rents (LA→LSOA lookup). No invented
  geography, and ONS lookups give the LA/region join spine for free.
- **The app already has LSOA plumbing**: the LSOA/IMD PMTiles layer means
  survivors can be highlighted by `setFilter`/feature-state on an existing
  vector layer — the direct analogue of `highlightSiftSurvivors` on
  `station-dot` — with zero new geometry shipping.
- **Why not stations**, despite the existing station-centric plumbing: student
  travel to campus is dominated by walking, cycling and buses, not heavy rail;
  a station-centred universe would silently exclude most real PBSA locations
  (and most of London's, where the tube/bus network is what PTAL measures).
  Stations re-enter as a *connectivity input* (distance to nearest station),
  not the ranked unit.
- **Why not a hybrid** (stations + LSOAs): two candidate types in one funnel
  breaks the "one row = one candidate" model the whole sift UI assumes.

The campus-catchment filter is a fixed precompute screen (not a user gate) to
cap payload; the *adjustable* travel gate in §3 operates within it.

## 3. Funnel design

### Gates (eliminate)

| # | Stage | What it checks | Default threshold (rationale) | Dataset(s) | User adjusts |
|---|-------|----------------|-------------------------------|------------|--------------|
| 1 | Demand anchor | Distance from LSOA centroid to nearest campus above a size floor; total FT students reachable | ≤ 4 km to a campus with ≥ 5,000 FT students. 4 km ≈ a 20-min cycle / short bus hop, the practical edge of the student letting market; 5,000 students ≈ the floor for institutional PBSA demand in one settlement | `uni_campus` (HESA headcount in props) | Max distance (1–8 km; v2 minutes when isochrones land); min campus FT students (1,000–20,000); alt. criterion "≥ N students within reach" (default 10,000 within 4 km) |
| 2 | Connectivity | London: PTAL band of the LSOA. Elsewhere: distance to nearest rail/tram station OR within 2 km of campus (walkable trumps transit) | London: PTAL ≥ 3 (boroughs expect 4+ for car-free high-density; 3 keeps the outer-London opportunity belt in play for scoring). Elsewhere: station ≤ 1,600 m (the app's standard 800 m–1.6 km walk band) or campus ≤ 2 km | `ptal`; existing stations GeoJSON | Min PTAL band (0–6b); non-London max station distance; "walkable-to-campus exemption" toggle (default on — mirrors the NPPF in-settlement exemption pattern) |
| 3 | Saturation cap | Existing full-time-student share of the LSOA's population (Census 2021 TS062) | Exclude > 50% student share. Above ~50% an area is a saturated core: peak competition from HMOs and existing PBSA, and 'studentification' planning resistance. Kept high so the *score* (not the gate) does the steering | census student % (LSOA PMTiles join / `map_features`) | Max student % (10–100, 100 = gate off) |
| 4 | Market floor | LA-level average private rent (ONS PIPR) | ≥ £700/month LA average. Below that, PBSA rents (~£160+/wk ensuite outside London) cannot compete with cheap HMO stock, whatever the demand | `la_rents` | Min LA rent £/month; optional min year-on-year rent growth % (default off) |

### Scored axes (final step "5 · Score & rank" — 0–100 each, weighted, adjustable)

| Axis | Weight | 0–100 scoring (piecewise-linear bands) | Dataset(s) |
|------|--------|----------------------------------------|------------|
| Demand | 30 | Campus proximity: ≤ 1 km = 100, 2 km = 85, 4 km = 60, 6 km = 35, ≥ 8 km = 0; blended 60/40 with reachable-students volume: ≥ 30k FT students within 4 km = 100, 10k = 60, 2k = 20. v2: international-student share and enrolment-growth uplifts | `uni_campus` |
| Connectivity | 20 | London: PTAL 3 = 40, 4 = 65, 5 = 80, 6a = 90, 6b = 100. Elsewhere: station ≤ 400 m = 100, 800 m = 80, 1.6 km = 50, > 3 km = 10; v2 replaced by bus-frequency/JTS travel-time bands | `ptal`, stations; v2 BODS/JTS |
| Market | 20 | LA rent: £700/m = 30, £900 = 55, £1,200 = 80, ≥ £1,500 = 100 (proxy for achievable PBSA rents; band edges editable as assumptions). v2: +10 capped growth bonus (≥ 6% y/y) | `la_rents` |
| Supply balance | 15 | Peaks at *proven but unsaturated*: student share 5–20% = 100, fading to 40 at 0% (no proven demand) and to 0 at 50% (saturated). +15 capped bonus if a C3→C4 Article 4 direction covers the LSOA — HMO restriction diverts demand into PBSA and signals existing pressure. v2: minus pipeline-beds penalty | census student %, `article4`; v2 PBSA pipeline (London Datahub) |
| Site supply | 15 | Brownfield-register land intersecting the LSOA: ≥ 2 ha = 100, 0.5 ha = 60, any site = 40, none = 0 — a proxy for "is there actually a plot". Softened by IMD living-environment context (v2) | existing brownfield layer |

Article 4 direction-of-travel is deliberately a *bonus with an adjustable sign*
(+15 default, settable to −15 for operators who read it as planning hostility)
— the classic disputed assumption belongs in the controls, not the pipeline.

## 4. Scoring model

Identical shape to the DC sift and the app's weighted-domain plot report,
extending the `computeViability` pattern (transparent client-side recompute,
no DB round-trip):

```
composite = Σ (w_i × axisScore_i) / Σ w_i    over axes with non-null data
```

- Default weights 30/20/20/15/15, slider-adjustable and persisted via
  `mmStore` (`mastermapper:sift:pbsa:config`); band breakpoints exposed as
  editable assumptions (advanced disclosure), like `VIABILITY_DEFAULTS`.
- Renormalisation over non-null axes = graceful degradation (missing PTAL
  outside London simply isn't an axis there — the non-London connectivity
  variant fills in; a null column drops the axis).
- Final-step filter `minComposite` (default 0, rank-only) plus rank-by:
  composite | demand | market. RAG chip: ≥ 70 strong / 45–70 possible / < 45
  weak.
- England-only at launch (Census TS062, PTAL, PIPR are England datasets); the
  country toggle is hidden for this tool. A Scotland pass needs SIMD/Scottish
  Census equivalents — out of scope here.
- Raw columns, never scores, are precomputed — all banding/weighting stays
  client-side so every control recomputes instantly.

## 5. Precompute pipeline

**Table** (no geometry — LSOA polygons already ship in the PMTiles layer;
centroids stored for flyTo):

```sql
create table public.pbsa_assessments (
  lsoa             text primary key,      -- LSOA21CD
  lsoa_name        text,
  la_code          text,
  la_name          text,
  region           text,
  in_london        boolean not null default false,
  lng              double precision,      -- population-weighted centroid
  lat              double precision,
  -- demand
  campus_id        text,                  -- map_features(uni_campus).source_id, nearest qualifying
  campus_name      text,
  campus_dist_m    integer,
  campus_students  integer,               -- FT headcount of that campus
  students_4km     integer,               -- Σ FT students of campuses ≤ 4 km
  students_8km     integer,
  -- people & policy
  ft_student_pct   numeric,               -- Census 2021 TS062
  imd_decile       integer,
  article4_hmo     boolean,               -- any C3→C4 direction intersects
  article4_pct     numeric,               -- area share covered
  -- connectivity
  ptal_band        text,                  -- London only (area-weighted mode of 100 m grid), else null
  station_dist_m   integer,
  -- market & supply
  la_rent_month    numeric,               -- ONS PIPR average, joined by la_code
  la_rent_yoy_pct  numeric,
  brownfield_ha    numeric,               -- register sites intersecting the LSOA
  pipeline_beds    integer,               -- v2: consented/pending PBSA beds (London Datahub)
  updated_at       timestamptz not null default now()
);
```

RLS public-read + `anon` select grant, per the `0022_map_features.sql`
convention.

**Script** `pipeline/build_pbsa_assessments.py` + a migration adding
`rebuild_pbsa_assessments(prefix text)` (batch by LSOA-code prefix, like
`rebuild_station_assessments`):

1. Universe: LSOA population-weighted centroids (ONS Open Geography CSV,
   loaded once) within 8 km of any `uni_campus` with `props->>'ft_students'
   ≥ 2000` — a KNN `<->` join with geography distance.
2. Demand: nearest qualifying campus + `students_4km`/`students_8km` as sums
   over a `ST_DWithin` join.
3. `ft_student_pct`: Census TS062 CSV joined by LSOA code (pure attribute
   join, done in Python like `build_lsoa_imd_points.py`).
4. `ptal_band`: area-weighted modal band of `ptal` grid cells intersecting the
   LSOA polygon (LSOA polygons loaded to a working table or read from the
   boundary source used by `build_tiles.py`); null outside the PTAL extent.
5. `article4_hmo`/`article4_pct`: `ST_Intersects` / area share against
   `article4`, filtered to HMO-type directions where the props allow (badge
   coverage-incomplete regardless).
6. `station_dist_m`: KNN against the stations table. `brownfield_ha`:
   intersection area with the existing brownfield layer. `la_rent_*`: attribute
   join from `la_rents` by `la_code`.

**Cadence:** monthly pipeline run — rents monthly (ONS PIPR), Article 4 and
brownfield on the quarterly planning.data.gov.uk sweep, Census/PTAL static.
`updated_at` shown in the tool footer. Client load pages 1,000 rows at a time
ordered by `students_4km desc`, exactly like `loadSiftData()`.

## 6. UI

- **Tool picker & refactor**: as specified in `PLAN_SIFT_DATACENTRE.md` §6 —
  Explore | Site sift mode switch, then a three-chip tool selector
  (`Stations (NPPF)` · `Data centres` · `Student housing`), with the sift shell
  (stepper, funnel counts, about-panels, table, tray, compare, CSV/report
  export) parameterised by a `SIFT_TOOLS` definition and per-tool namespaced
  persistence. This doc only specifies the PBSA tool definition.
- **Steps**: the four gates + score step of §3, each with the standard
  what/source/calc about-panel (sources: HESA, Census 2021 TS062, TfL PTAL,
  ONS PIPR, planning.data.gov.uk Article 4 — with the coverage-incomplete
  caveat surfaced in the Article 4 about-panel).
- **Map**: survivors highlighted on the **existing LSOA PMTiles layer** via
  filter/feature-state on LSOA code — the LSOA analogue of
  `highlightSiftSurvivors`. Practical cap: apply the highlight to the top ~2k
  survivors by composite (a huge `in`-list filter is slow); below the cap it is
  exact. Optional choropleth-by-composite once feature-state is wired. Campus
  points from `features_in_bbox('uni_campus', …)` drawn while the tool is
  active, so the demand anchors are visible context.
- **Table columns**: LSOA name + LA, nearest campus (name, km), student %,
  PTAL/station, LA rent, composite RAG — hover titles carrying the
  full-precision values, mirroring the station table.
- **Click-to-profile**: fly to the LSOA, show a profile card (campus list with
  headcounts, student %, rents, Article 4 status, brownfield sites listed), and
  offer the existing **plot report** run over the LSOA polygon (fetched from
  the boundary source) for the full context deep-dive.
- **Shortlist / compare / export**: star-pin keyed on LSOA code, per-tool
  shortlist store, existing CSV exporters + printable report with PBSA
  `exportCols`.

## 7. Data gaps & phasing

**MVP** (buildable with first-wave ingestion — `uni_campus`, `ptal`,
`la_rents`, `article4`, `lpa_boundary` — plus in-app layers: LSOA/IMD PMTiles,
stations, brownfield; plus two attribute CSV joins added by this pipeline:
Census TS062 and HESA headcounts, both single-file open downloads):

- All four gates live (gate 2 uses the PTAL/station dual rule; PTAL missing
  outside London is by-design, not degradation).
- All five axes live in first-order form (straight-line distances, LA-level
  rents, brownfield presence). Composite fully functional.

**v2**: campus isochrones (OpenTripPlanner/r5 over BODS GTFS) replacing
straight-line bands in gate 1 and the demand axis; bus-frequency / DfT JTS
connectivity outside London; HESA enrolment growth + international share;
PBSA pipeline beds (London Datahub; national is commercial-only — flag);
HMO licence density (per-council registers, target cities only); LSOA-level
rent modelling (VOA room-level stats) replacing the LA average.

**Degradation rule** (same as the DC sift): null gate column → row passes,
null axis column → axis dropped from the weighted sum and the about-panel
badges the gap. Specifically: missing `article4` rows mean "no bonus", never
"penalty"; missing `ptal_band` outside its extent switches to the non-London
rule; missing `la_rent_month` passes gate 4 and drops the Market axis.

## 8. Open questions for the product owner

1. Article 4 default sign: is HMO restriction a +15 opportunity (proposed
   default) or a planning-hostility penalty? Both are one slider, but the
   default frames the tool.
2. Should the demand gate count *all* campuses or exclude small specialist
   providers (conservatoires etc.) below the size floor even as bonus demand?
3. London vs regions: one national ranking (proposed, with PTAL/non-PTAL
   variants) or a London/rest-of-England split like England/Scotland in the
   station sift?
4. Is LA-level rent acceptable for MVP ranking, or is the VOA room-rent join
   a launch requirement?
5. Saturation default: is the 50% cap too permissive — should the gate default
   to 35%?
6. Do we need a beds-capacity estimate per LSOA (brownfield ha × plot ratio)
   in the table, mirroring dwelling yield, or is that false precision at MVP?
