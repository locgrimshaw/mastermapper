# Phase 2 roadmap — data acquisition & integration

*2026-07-24. The plan of record for turning MasterMapper from a rich map into
three decision tools, in the priority order set by the owner:*

1. **Portfolio / public-land tool** — engage portfolio landholders (Platform 4
   style): score a nationwide portfolio, surface the most viable & impactful
   sites, lean on the new NPPF to find land likely to win approval for major
   development; sift public-authority land, especially brownfield.
2. **PBSA corridor tool** — sites on university travel corridors, weighing
   planning risk, viability, market attractiveness and pipeline intelligence.
3. **Data-centre siting tool** — connectivity, planning risk, constructability
   (flood, flatness, power, water, fibre).

What we already have nationwide: IMD/SIMD + prices per LSOA; the full
planning-constraint stack (flood, green belt, environmental + heritage
designations, Article 4, TPO, design codes); LPA/LAD/local-plan boundaries;
brownfield registers; CCOD council property (103k points); INSPIRE parcel
tiles (in build); the power stack (OSM lines/substations by voltage, GSP, TEC
queue, UKPN + NGED headroom); universities with HESA demand + accommodation
mix + campuses; PTAL; LA rents; ALC; CAMS water; rail lines/stations/usage +
84.6k timetable links; the NPPF station sift; PBSA rail sift with stackable
walk/cycle/rail catchments and street isochrones; right-click spot summary;
university deep-dive drawer.

---

## Priority 1 — Portfolio & public-land tool

### The two flagship features

**F1. Portfolio upload & batch scorer** *(the engagement weapon)*
- Upload CSV (postcodes/addresses/coords), GeoJSON or zipped shapefile of a
  client's holdings; each site becomes a scored record.
- New RPC `polygon_summary(geojson)` generalising `point_summary`: constraint
  coverage %s (green belt / flood / designations), developable area after the
  erase-mask, nearest station + usage, substation headroom, IMD/price/rent
  context, parcel + ownership intersections.
- Composite scores per site: **Policy** (tilted-balance signals below),
  **Access** (station distance, service frequency, PTAL), **Market** (prices,
  rents, IMD trajectory), **Capacity** (area × developable % × density
  assumption) → ranked portfolio table + map, exportable.
- One-page **site report export** (print CSS → PDF) and portfolio CSV.

**F2. Public-land sift**
- Filterable universe of publicly owned land: owner class × brownfield ×
  constraint-lite × station proximity × LA policy posture.
- Needs the ownership expansion below + the CCOD-point → INSPIRE-parcel
  spatial join (parcel containing the point = indicative plot; flagged as
  heuristic until/unless NPS is licensed).

### Datasets to ingest

| Dataset | What it unlocks | Source / licence | Mechanism |
|---|---|---|---|
| **CCOD all public bodies** | we keep only LA/county proprietors — widen to combined authorities, parish/town councils, NHS bodies, government departments, universities as owners | existing CCOD download (have) | extend `build_ccod.py` category regexes; emit `owner_class` prop |
| **Brownfield register `ownership` field** | registers carry an ownership-status column ("owned by a public authority"…) — instant public-brownfield layer, zero new sources | planning.data.gov.uk (have the geometry) | re-parse with the extra column; badge + filter |
| **Government Property Finder / e-PIMS successor** | central-government estate as sites | Cabinet Office, OGL | CSV/API ingest → `gov_estate` dataset |
| **Homes England land hub** | public land already earmarked for disposal/housing | data.gov.uk, OGL | GeoJSON/CSV ingest |
| **MoD DIO estate** | large single-owner holdings | DIO open data, OGL | ingest |
| **NHS estate (ERIC site table)** | trust-level sites + floor areas | NHS Digital, OGL | CSV + geocode |
| **LA asset registers** | the Transparency Code registers (per-council CSVs, messy) | councils / aggregators | start with top-30 urban LAs; drop-in framework |
| **Housing Delivery Test results** | LAs under 75% → presumption in favour = the strongest approval signal | DLUHC annual CSV, OGL | LA-level layer + sift criterion + spot summary |
| **Local plan adoption dates** | plan >5y old → out-of-date policies → tilted balance | planning.data.gov.uk local-plan timetable fields | enrich existing boundaries with `adopted`, `age_years` |
| **5-year land supply positions** | second leg of the presumption | DLUHC/PINS statements (patchy) | ingest where published; HDT is the reliable proxy |
| **Planning applications (PlanIt API)** | live + historic apps for ~400 councils → *empirical* approval rates for major development per LPA | planit.org.uk (free, fair-use) | nightly sync of majors; `lpa_approval_rate` metric + apps layer |
| **PINS appeal decisions** | allowed-rate by LPA = how winnable a refusal is | PINS casework data, OGL | CSV ingest → LPA metric |
| **HMLR National Polygon Service** | EXACT title→parcel polygons (the licensed product) | £ — commercial licence | OWNER DECISION; architecture ready (parcels already tiled) |

### The computed layer that sells the tool

**Grey-belt candidate model** (new NPPF): green belt ∩ (previously developed
land ∪ brownfield register ∪ built-land mask) minus hard environmental/
heritage constraints, scored by settlement adjacency and station access.
Nobody hands this out as a dataset — computing it credibly from layers we
already hold is the differentiator for landholder conversations. Ship as a
toggleable layer + a portfolio-score input, clearly labelled as a model.

---

## Priority 2 — PBSA corridor tool

### Features
- **Corridor scoring v2** (per PLAN_SIFT_PBSA v2): feeder-station ranking
  enriched with rent differential vs the university's LA, Article 4 presence,
  student saturation, pipeline competition; weights user-tunable.
- **PBSA funnel**: within a built catchment, LSOA-level filter → score →
  shortlist → parcel/ownership drill-down (reuses the portfolio scorer).
- **Deep-dive drawer growth**: pipeline table, competitor stock, multi-year
  demand trend, nomination-agreement notes.

### Datasets

| Dataset | What it unlocks | Source | Mechanism |
|---|---|---|---|
| **Census 2021 student population (LSOA)** | where students actually live now → saturation metric + "student neighbourhood" layer | ONS/Nomis bulk, OGL | LSOA join into the existing tiles pipeline |
| **PBSA pipeline from PlanIt** | "what else is coming" — applications matching student-accommodation classes/keywords, staged proposed/approved/built | PlanIt (as P1) | keyword+class filter of the same sync; pipeline layer + drawer table |
| **Existing PBSA stock (OSM)** | competitor mapping v1 | OSM `building=dormitory`, `residential=university` | add to the osmium extraction |
| **HESA multi-year DT051** | growth trajectory per provider, not a snapshot | HESA CC-BY | ingest 3–5 back-years; sparkline in drawer |
| **UCAS acceptances by provider** | forward demand signal | UCAS open stats | annual CSV |
| **MHCLG residential land value estimates** | viability: land cost per LA | MHCLG, OGL | LA metric in scorer + drawer |
| **HMO licensing registers** | rented-sector pressure where published | per-council | opportunistic drop-ins, top student cities first |

---

## Priority 3 — Data-centre siting tool

### Features
- **DC sift** (docs/PLAN_SIFT_DATACENTRE.md — awaiting owner sign-off):
  input MW need + acreage → candidate areas = headroom-substation buffers ∩
  flat ∩ flood-free ∩ low-grade ALC ∩ outside GB/designations ∩ fibre-near ∩
  water-plausible → scored site cards.
- **Slope & elevation in the spot summary + portfolio scorer** (serves P1 too).
- **Contested-grid heatmap**: TEC queue MW aggregated per GSP/substation.

### Datasets

| Dataset | What it unlocks | Source | Mechanism |
|---|---|---|---|
| **OS Terrain 50 → slope tiles** | the "flatness" requirement, nationwide | OS OpenData, OGL | workflow: DTM → slope raster → contour/class polygons → PMTiles (same pattern as parcels) |
| **Remaining DNO headroom: SSEN, SPEN, NPG, ENWL** | complete national distribution-capacity coverage (have UKPN + NGED) | each DNO's open-data portal (Ofgem-mandated) | one builder per portal, same `cap` rendering |
| **NESO network development (Beyond 2030 / HND)** | planned reinforcement = future headroom | NESO data portal | reinforcement-site layer |
| **Ofcom Connected Nations** | fibre availability density | Ofcom, OGL | postcode→grid layer + metric |
| **Internet exchanges + existing DCs** | latency/cluster proxy | LINX et al. + OSM `telecom=data_centre` | small curated + OSM layer |
| **EA abstraction licences** | who already takes water where | EA, OGL | points layer beside CAMS |
| **Gas transmission/distribution networks** | backup-generation feasibility | National Gas + GDN portals | line layer |
| **Aerodrome/MOD safeguarding zones** | consultation-trigger risk | NATS/MoD published maps | polygon layer |

---

## Cross-cutting platform work

- **`polygon_summary` + batch engine** — the single most reused build; every
  tool's scorer sits on it.
- **Accounts & workspaces** (Supabase auth + RLS) — portfolios and shortlists
  are client-confidential; needed the day a real landholder uploads anything.
- **Report/export layer** — per-site PDF one-pager, portfolio CSV/XLSX.
- **Refresh automation** — monthly scheduled workflows (CCOD, TEC, rents,
  HDT, PlanIt sync) with a data-freshness panel in the UI.
- **Census 2021 pack** — population, age, tenure, car ownership at LSOA:
  cheap to add to the existing tile build, feeds all three tools.

## Suggested build order

| Phase | Contents | Serves |
|---|---|---|
| **A** | polygon_summary + portfolio upload/scorer; CCOD all-public-bodies + owner_class; brownfield ownership field; CCOD→parcel join; HDT + plan-age | P1 MVP — demo-able to a landholder |
| **B** | Grey-belt model; PlanIt sync + approval rates; appeals; report export; auth/workspaces | P1 complete |
| **C** | Census students; PBSA pipeline + OSM stock; corridor scoring v2; PBSA funnel; land values; drawer growth | P2 |
| **D** | Terrain-50 slope tiles; four remaining DNOs; Ofcom fibre; queue-by-GSP; DC sift build | P3 |
| **∞** | Refresh automation + freshness panel (start in A, grow) | all |

## Decisions / spends for the owner

1. **HMLR National Polygon Service licence** — the only route to *exact*
   title→parcel ownership polygons. Everything works without it (INSPIRE
   heuristic, clearly labelled); it upgrades P1 from indicative to exact.
2. **PlanIt** — free with fair-use limits; heavy usage may warrant contact.
3. **Commercial PBSA market data** (StuRents/CoStar-class) — optional upgrade
   over the OSM+planning-pipeline approximation.
4. **BCIS build-cost data** (£) — optional viability refinement; MHCLG land
   values are the free baseline.
5. **DC sift plan sign-off** — docs/PLAN_SIFT_DATACENTRE.md before Phase D.
