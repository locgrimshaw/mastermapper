# Plan · PBSA (purpose-built student accommodation) site-finding sift — v2

A sift tool for student-housing locations, built to the same architecture as
the NPPF station funnel in `web/src/app.js` (`SIFT_STEPS` / `enterSiftMode` /
`computeViability` over precomputed `public.station_assessments`): precomputed
per-candidate rows loaded once from Supabase, hard gates then weighted scored
axes recomputed instantly client-side, shortlist tray / compare / CSV /
printable report reuse.

**What changed since v1.** The data this plan treated as hypothetical is now
live, and it changes the shape of the tool:

- **HESA DT051 2024/25 per-provider stats are loaded onto the `uni_campus`
  points in `public.map_features`**: `students_total`, `students_fulltime`,
  `students_intl` + `intl_pct`, and — decisively — the **term-time
  accommodation mix** from Table 57: `acc_provider_halls`,
  `acc_private_halls`, `acc_parental_home`, `acc_own_residence`,
  `acc_other_rented`, with derived `pbsa_pct` (private-halls share of FT),
  `uni_halls_pct`, `rented_pct`, `home_pct` (see
  `pipeline/build_datasets.py` and the campus popup in `web/src/app.js`).
  Unmet PBSA demand is now **measurable per university** — `students_fulltime
  × rented_pct` = students currently housed in HMOs/other rented and
  addressable by PBSA; `pbsa_pct` = existing PBSA penetration — instead of
  proxied from Census student shares. Real spread: UCL 44.6k FT, 51.9%
  international, `pbsa_pct` 7.1, `rented_pct` 40.6 (≈ 18k HMO-housed students,
  huge unmet demand); Manchester `pbsa_pct` 23.6 (already saturated). The
  Demand and Supply-balance axes are reworked around these measured
  quantities; Census TS062 keeps a role for *spatial* demand distribution only.
- Also live: **PTAL 2023** grid (`ptal`, grade + AI), **LA rents June 2026**
  (`la_rents`: `rental_price_mean` + `annual_rent_change_pct` on LAD
  polygons), **`article4`** areas, **`uni_campus_site`** (OSM campus polygons)
  + **`uni_building`** footprints, **`lad_boundary`**; **`la_property`**
  (council-owned CCOD postcode points) loading.
- **New headline feature: a rail-based sift mode** — pick a university, see
  which stations feed it by direct train, rank them. This is now **the MVP,
  built first**; the LSOA funnel of v1 becomes phase 2 (§2, mode B).

## 1. Purpose & user

Find well-connected locations where purpose-built student accommodation would
let quickly and consent plausibly — deliberately including places *outside*
the saturated core university districts (the roadmap's stated goal, especially
for London). The user is a PBSA developer/operator or investor analyst: they
want to move from "every university city" to "a dozen sites worth agent calls
and a planning pre-app", with the demand, saturation, policy and rent
assumptions visible and adjustable — because operators disagree precisely on
those assumptions (e.g. whether Article 4 areas are an opportunity or a
warning). New in v2: the primary question becomes *"for this specific
university, with this measured unmet demand, which commuter stations are the
underpriced supply frontier?"* — a question the HESA accommodation mix and the
rail timetable can now answer together.

## 2. Candidate universe — two modes

### Mode A (MVP): feeder stations, per university

One university at a time; the candidate universe is **stations with a direct
rail service into that university's gateway stations**. Rationale:

- **The insight is university-specific.** A UCL-shaped opportunity (7%
  penetration, 40% in HMOs) and a Manchester-shaped one (24% penetration) need
  opposite strategies; a single national ranking blurs exactly the measured
  distinction DT051 gives us.
- **Rail is the right frame for the out-of-core play.** The unmet-demand
  student priced out of Zone 1/2 HMOs trades rent for a direct train; "one
  seat, ≤ 45 min, turn-up-and-go frequency" is the actual product spec of
  commuter PBSA. Journey time from a real timetable beats any straight-line
  or PTAL proxy for this question.
- **It reuses the heaviest plumbing we have**: the CIF parser
  (`pipeline/build_connectivity_cif.py`), the stations layer, and
  `station_assessments` (developable land, IMD, usage) for feeder-end
  enrichment.

### Mode B (phase 2): LSOA funnel

The v1 national LSOA screen survives as phase 2, with its Demand and
Supply-balance axes rebuilt on measured HESA quantities (§3B). It answers the
complementary question — "rank all neighbourhoods near any university" — and
still needs the Census TS062 ingest (not yet done) for spatial distribution.
Two candidate types never share one funnel ("one row = one candidate" holds);
they are two tools behind the shared sift picker specified in
`PLAN_SIFT_DATACENTRE.md` §6.

## 3A. Mode A criteria (feeder-station sift)

Selection: university typeahead over `uni_campus` (HESA name, UKPRN). The
chosen university's **demand card** shows the measured quantities that frame
everything downstream: FT students, `intl_pct`, the full accommodation mix,
`pbsa_pct`, and the headline `students_fulltime × rented_pct / 100` =
**addressable HMO-housed students**.

| # | Criterion | What it checks | Default (rationale) | Dataset(s) | User adjusts |
|---|-----------|----------------|---------------------|------------|--------------|
| 1 | Gateway walk | Stations within walk distance of the university HQ point or its associated OSM campus polygons (within 3 km of the point) | 1,500 m — upper bound of an acceptable daily campus walk; polygons catch multi-site campuses the point misses | `uni_campus`, `uni_campus_site`, stations | Max gateway walk 500–2,500 m |
| 2 | Journey time | Median scheduled direct journey time feeder → any gateway | ≤ 45 min — the practical edge of daily student commuting; beyond it, term-time attendance patterns break | `station_links` | 15–90 min |
| 3 | Service frequency | Weekday direct trains/day feeder → gateways | ≥ 10 — below roughly two trains/hour across the day, a missed train costs a lecture | `station_links` | 2–60 trains/day |

Direct services only at MVP: one-seat journeys are what the timetable gives us
cheaply and what students actually tolerate; interchange routing is a later
refinement, flagged honestly in the about-panel.

## 3B. Mode B funnel (phase 2, revised)

Gates 1–4 of v1 stand structurally (demand anchor ≤ 4 km / ≥ 5,000 FT;
connectivity PTAL ≥ 3 or station ≤ 1,600 m; saturation cap; market floor
`rental_price_mean` ≥ £700/month from `la_rents`), but the scored axes change
where measurement replaced proxy:

| Axis | Weight | 0–100 scoring (piecewise-linear bands) | Dataset(s) |
|------|--------|----------------------------------------|------------|
| Demand (**reworked**) | 30 | Reachable **unmet demand**: Σ over campuses ≤ 4 km of `students_fulltime × rented_pct/100`, distance-decayed (≤ 1 km × 1.0, 4 km × 0.4). ≥ 15k addressable students = 100, 5k = 60, 1k = 20. International share ≥ 40% adds +10 capped (intl students disproportionately choose PBSA) | `uni_campus` (HESA DT051) |
| Connectivity | 20 | Unchanged: London PTAL 3 = 40 … 6b = 100; elsewhere station ≤ 400 m = 100, 1.6 km = 50 | `ptal`, stations |
| Market | 20 | `rental_price_mean`: £700/m = 30, £900 = 55, £1,200 = 80, ≥ £1,500 = 100; +10 capped if `annual_rent_change_pct` ≥ 6 | `la_rents` |
| Supply balance (**reworked**) | 15 | **Measured penetration**: weighted-mean `pbsa_pct` of reachable campuses — ≤ 8% = 100, 15% = 60, ≥ 25% = 0 (Manchester-grade saturation). Blended 60/40 with the v1 LSOA student-share curve (TS062, 5–20% = 100) for *where within the catchment*. Article 4 bonus ±15 unchanged | `uni_campus`, TS062, `article4` |
| Site supply | 15 | Brownfield ≥ 2 ha = 100, 0.5 ha = 60, any = 40, none = 0 | brownfield layer |

TS062 remains the only spatial demand-distribution input — HESA numbers are
per-provider, not per-neighbourhood — so the TS062 ingest stays on the phase-2
critical path (§7).

## 4. Scoring model — ranking feeder stations (mode A)

Same shape as `computeViability`: raw columns precomputed or fetched, all
banding and weighting client-side, instant recompute, weights and breakpoints
persisted via `mmStore` (`mastermapper:sift:pbsa:config`).

```
feederScore = Σ (w_i × axis_i) / Σ w_i        over axes with non-null data
```

| Axis | Weight | 0–100 formula (defaults; band edges editable) | Source |
|------|--------|-----------------------------------------------|--------|
| Journey time | 30 | Decay on `minutes`: ≤ 15 = 100, 25 = 80, 35 = 60, 45 = 40, 60 = 15, ≥ 75 = 0 | `station_links` |
| Frequency | 15 | `trains_day`: ≥ 60 = 100, 30 = 75, 15 = 50, 10 = 40, 4 = 10, < 2 = 0 | `station_links` |
| Rent differential | 20 | `(homeRent − feederRent) / homeRent` where rents are `rental_price_mean` of the feeder's LAD vs the university's home LAD: ≥ 30% cheaper = 100, 15% = 70, parity = 40, ≥ 10% dearer = 0. Cheaper is the whole commuter-PBSA thesis | `la_rents`, `lad_boundary` point-in-polygon |
| Article 4 | 10 | No HMO Article 4 near the feeder station = 100, present = 0 — default reads absence as freedom to operate; **sign flippable** (some operators read Article 4 as demand diverted into PBSA), the same disputed-assumption slider as v1 | `article4` |
| Saturation headroom | 10 | Student share near the feeder (TS062, phase 2 until ingested): ≤ 5% = 100, 15% = 60, ≥ 35% = 0 — greenfield student markets score high because the demand is imported by rail, not local | TS062 via LSOA feature-state |
| Site supply | 15 | Reuse `station_assessments` where the feeder has a row: `developable_ha` ≥ 2 = 100, 0.5 = 60, any = 40, none/null = axis dropped | `station_assessments` |

Renormalisation over non-null axes gives graceful degradation: at first ship
only journey time + frequency may exist for some feeders and the ranking still
works; each about-panel badges what is missing. RAG chip thresholds as v1
(≥ 70 / 45–70 / < 45).

## 5. Precompute pipeline

### 5.1 Station links (build first — the MVP dependency)

`pipeline/build_connectivity_cif.py` is being extended to emit
**station-to-station direct service links** from the National Rail CIF
timetable, alongside its existing per-station output:

- **Output**: `data/raw/station_links.csv` — `crs_from, crs_to, minutes`
  (median scheduled journey time over the sample weekday's direct services),
  `trains_day` (weekday direct services).
- **Credentials**: the timetable feed needs National Rail Open Data
  credentials — a **user task** (§7). Workflow `load-rail-links.yml` runs the
  build + load with secrets `NR_EMAIL` / `NR_PASSWORD`.
- **Table**:

```sql
create table public.station_links (
  crs_from   text not null,
  crs_to     text not null,
  minutes    integer not null,      -- median scheduled direct journey time
  trains_day integer not null,      -- weekday direct services
  primary key (crs_from, crs_to)
);
-- RLS public-read + anon select grant, per the 0022_map_features.sql convention
```

### 5.2 RPC `uni_rail_access`

```sql
create function public.uni_rail_access(p_ukprn text, p_gateway_m int default 1500)
returns jsonb;
```

For one university, returns as JSON:

- **Gateways**: stations within `p_gateway_m` of the HQ point **or of any
  associated `uni_campus_site` polygon** (polygons matched by proximity —
  within 3 km of the point; name/operator matching is a phase-2 refinement),
  with walk distance each.
- **Feeders**: every station with a `station_links` row into any gateway, with
  `minutes` (min over gateways) and `trains_day` (sum over gateways), plus
  coordinates for map placement.

One RPC call per university selection; all filtering/ranking of the feeder
list is then client-side per §4.

### 5.3 `pbsa_assessments` (phase 2)

The v1 LSOA table stands as specified (schema unchanged apart from the demand
columns, which gain `addressable_students` and `campus_pbsa_pct` per §3B) and
is built by `pipeline/build_pbsa_assessments.py` +
`rebuild_pbsa_assessments(prefix)` batching, monthly cadence. Not on the MVP
path.

### 5.4 Feeder-row enrichment (the step after the visualiser)

Once the mode-A visualiser works end-to-end, enrich each feeder row —
client-side joins or a widened RPC, whichever profiles better:

- **LA rent** + growth (`la_rents` via `lad_boundary` point-in-polygon);
- **Article 4** presence near the station (`article4` intersects a 1 km buffer);
- **IMD** and **station usage** (both already in `station_assessments`);
- **developable land** near the station (ditto).

This is what activates the four lower-weighted scoring axes of §4.

## 6. UI

- **A new minimiseable side-box, "PBSA sift", directly below the "Rail &
  stations" box** (same collapse/expand pattern — see the side-box block in
  `web/src/app.js`). Not part of the sift-picker shell at MVP: mode A is a
  focused single-university tool and ships faster standalone; it folds into
  the shared picker when mode B lands.
- **Flow**: university typeahead → demand summary card (HESA numbers incl.
  the full accommodation mix, `pbsa_pct`, addressable-students headline) →
  ranked feeder list, filtered live by the §3A criteria sliders (max rail
  minutes 45, min trains/day 10, max gateway walk 1,500 m).
- **Map visualisation** while a university is selected: campus polygons
  highlighted (`uni_campus_site`), gateway stations ringed, feeder stations
  colour-banded by journey time (e.g. ≤ 20 / ≤ 35 / ≤ 45 / > 45 min), and
  arcs feeder → campus for the visible list. Clicking a feeder flies to it and
  opens its enrichment card (§5.4) with the existing plot-report deep-dive
  offered around the station.
- **Table columns**: station, minutes, trains/day, LA rent (Δ vs home LA),
  Article 4 flag, feeder score RAG — hover titles with full precision, CSV
  export via the existing exporters, shortlist star-pins keyed on CRS.
- **Graceful degradation**: until `station_links` is populated (NR credentials
  pending) the box still works — gateways plus nearby stations ranked by
  straight-line distance, with an honest inline note ("journey times appear
  once the National Rail timetable is loaded"). No fake minutes.
- Mode B UI: as v1 §6 (LSOA feature-state highlight, tool picker), phase 2.

## 7. Data gaps & phasing

**MVP (mode A)** — build order:

1. `station_links.csv` emitter in `build_connectivity_cif.py` + table + load
   workflow. **The one blocking user task: National Rail Open Data
   credentials** (`NR_EMAIL`/`NR_PASSWORD` secrets for `load-rail-links.yml`).
   Everything else on the MVP path is already ingested.
2. `uni_rail_access` RPC.
3. "PBSA sift" box: typeahead, demand card, feeder list + map visualiser
   (degraded distance-only mode ships even before step 1 completes).
4. Feeder enrichment (§5.4) → activates the full §4 scoring.

**Phase 2 (mode B)**: Census TS062 ingest (route via LSOA feature-state, as
the IMD layer), `pbsa_assessments` pipeline, sift-picker integration, campus
name/operator matching for `uni_campus_site` association, interchange-aware
journey times.

**Further data worth adding for PBSA** (in rough value order):

- **HESA Table 57 time series** — accommodation mix by year; the 2024/25
  download route already exists, so trend (`pbsa_pct` rising/falling per
  provider) is a repeat-run away. Turns saturation from a snapshot into a
  direction.
- **Census TS062 student share** — still to ingest; the spatial
  demand-distribution spine for mode B and the mode-A saturation axis.
- **ONS/VOA room-level rents** — summary stats for shared-house rents,
  replacing the LA mean with the rent PBSA actually competes against.
- **PBSA planning applications** (London Datahub) — pipeline beds at the
  feeder end; national coverage is commercial-only, flag as gap.
- **University expansion plans** (qualitative) — enrolment-growth intent per
  provider; annotation, not a scored axis.
- **NR timetable-derived journey times into major employment centres** — the
  same `station_links` data cut towards CBDs, for the young-professional /
  co-living overlap at feeder stations (de-risks single-market exposure).

**Degradation rule** (as v1): null criterion column → row passes; null axis →
axis dropped from the weighted sum and badged. Missing `station_links` → the
distance-only mode with the honest note; missing `article4` → "no signal",
never a penalty; missing `station_assessments` row → site-supply axis dropped.

## 8. Open questions for the product owner

1. Article 4 default sign at the feeder end: absence = freedom to operate
   (proposed default) or presence = diverted demand? One slider, but the
   default frames the tool.
2. Gateway association: is proximity-only campus-polygon matching (within
   3 km) acceptable for MVP, or do multi-city providers (e.g. UAL) need the
   name/operator matching pulled forward?
3. Direct services only: acceptable MVP simplification, or is one-change
   routing (e.g. via a London terminal) needed before the tool is credible
   for London universities?
4. Should the demand card lead on `rented_pct × FT` (addressable HMO
   students, proposed) or on `pbsa_pct` (penetration)? Same data, different
   sales pitch.
5. Rent differential vs the *home LA*: right comparator, or should it be the
   cheapest LAD already hosting the university's students?
6. Does mode B still justify its pipeline once mode A ships, or should
   phase 2 instead deepen mode A (interchanges, employment-centre overlap)?
