# Plan · Brownfield & underused land

**Brief (2026-09-09):** better analysis and options for selecting brownfield
and other "lightly developed" sites — a *set* of layers in Data layers, with
different types / classifications / sources, so an opportunity can be
approached from several angles rather than through one national register.

Audited against the live DB and live endpoints on 2026-09-09. Every number
below was measured, not assumed.

---

## 1. What we have today, and why one layer is not enough

One overlay row — `brownfield` ("Brownfield sites", orange) — backed by
`public.brownfield` and `brownfield_in_bbox`. It is the MHCLG **Brownfield
Land Register**, and nothing else.

Measured state of that table:

| Measure | Value | Comment |
|---|---|---|
| Sites | 36,133 | 306 organisations |
| With a polygon (`area`) | 2,916 (8.1%) | the rest are **points only** |
| Public-owned flag | 4,423 | `is_public` |
| Deliverable = yes | 23,264 | LPA's own assertion |
| Median site | **0.24 ha** | p90 2.06 ha — small urban plots |
| Max dwellings (sum) | 1,324,835 | national declared capacity |
| Loaded | 2026-07-02 | registers refresh annually |
| Scotland rows | **0** | England-only dataset |

**Three defects this audit found, all fixable:**

1. **`hectares` has unit-error outliers.** 75 rows exceed 100 ha and 43 exceed
   1,000 ha (max **157,945 ha** — larger than Greater London). They inflate
   the national area from a sensible **35,443 ha** to **498,282 ha**, a 14×
   overstatement, and `brownfield_summary_in_polygon` sums the raw column, so
   any catchment containing one reports nonsense hectares.
2. **92% of sites are a dot.** A point cannot be assembled, measured, or laid
   out. The register is a *pointer to* an opportunity, not a site boundary.
3. **The register is only one lens.** It records what councils chose to
   declare. It misses: the surface car park behind the high street, the
   single-storey retail shed on 2 ha, the NHS depot, the golf course, the
   redundant petrol station — none of which any LPA is obliged to register.

Prior roadmap entries (`DATA_LAYERS_ROADMAP.md` §2, `ROADMAP_PHASE2.md`)
already flagged "better brownfield surfacing" as not started; this plan is
that work, widened from *surfacing the register* to *finding the land*.

---

## 2. The methodology: four independent lenses

The core proposal is that "brownfield" is not one dataset but **four
independent ways of noticing the same opportunity**, each with different
coverage, authority and failure modes. A site that appears in more than one
lens is a stronger lead than a site that appears in the best single lens.

```
  A · DECLARED        B · OWNED            C · BUILT FORM        D · COST
  what the state      who could sell it    what it looks like    what it takes
  has written down                         from the built form   to unlock
  ───────────────     ───────────────      ───────────────       ───────────────
  BLR register        CCOD/public parcels  parcel coverage %     historic landfill
  brownfield-site     NHS / MOD / LA       storeys / plot ratio  coal legacy
  grey-belt model     Homes England        surface parking       flood / contam.
  PDR pipeline        church / utility     low-rise sheds        heritage / TPO
```

Each lens becomes a **sub-group of layers**, and the four combine into one
**opportunity score** that is always decomposable back to its evidence.

### Lens A — Declared (authority: high, coverage: partial)
What a public body has already written down as previously developed.
* Brownfield Land Register (have: 36,133 pts) — fix hectares, expose the
  `permission_status` / `deliverable` / `dwellings` fields as filters.
* `brownfield-site` polygons (have: 2,916, mostly London) — keep separate,
  badge as "boundary published".
* Grey-belt candidate model (have: 23,399) — already a derived
  previously-developed-in-Green-Belt layer; belongs in this family.
* **Gap: Scotland and Wales have zero coverage.** Scottish Vacant & Derelict
  Land Survey and Welsh derelict-land returns are the equivalents.

### Lens B — Owned (authority: high, coverage: good, intent: unknown)
Who owns it and could therefore sell it.
* `public_parcel` (have: 145,783 INSPIRE-matched polygons with `area_m2` and
  `owner_class`), `la_property` (120,775), `he_land` (98 Homes England sites
  with `status`/`route`/`capacity`).
* This is already strong and simply needs to be *presented as brownfield
  opportunity* rather than as an ownership curiosity — filtered to
  ≥0.25 ha, non-operational uses, and cross-referenced with Lens C.

### Lens C — Built form (authority: none, coverage: total) ← the new capability
The derived lens, and the answer to "lightly developed". For any parcel:

```
  site coverage   = Σ building footprint ∩ parcel ÷ parcel area
  massing         = mean storeys of buildings on it
  intensity index = coverage × storeys      (≈ plot ratio)
```

A parcel that is 2 ha, 12% covered, single-storey, in a settlement, not
protected, is a **lightly developed site** whether or not anyone registered
it. Thresholds define the classes: *vacant* (<3%), *lightly developed*
(3–20%), *low-rise sheds* (>20% coverage but ≤1.2 plot ratio), against an
urban norm of ~2.0+.

**Feasibility, measured:** we already serve both inputs as vector tiles —
`parcels.pmtiles` (INSPIRE, z12–15) and `buildings.pmtiles` (OSM footprints,
z13–16, *all* buildings not just height-tagged ones). The intersection can
therefore run **client-side in the viewport** with no new national dataset.
A national precompute is the phase-2 option if we want ranking rather than
browsing.

⚠️ **Do not use `map_features/building_height` for this.** It is the
height-tagged OSM subset (1,500,761 points ≈ 5% of GB buildings). Probe: of
4,000 public parcels ≥0.25 ha, **84.7% contain zero** height-tagged buildings
— the sparsity would read as "vacant" and the layer would be almost entirely
false positives. Footprints, not the point layer.

⚠️ **INSPIRE licence.** `build_brownfield_inspire.py` already carries the
warning: INSPIRE Index Polygons are not plain OGL and restrict onward
republication of derived boundaries. Coverage computed *client-side and
displayed* is materially different from publishing a derived boundary set —
keep the derived score, don't republish the geometry.

### Lens D — Cost to unlock (authority: high, coverage: England-good)
The reason brownfield stalls. Absent from our data entirely today.
* **EA Historic Landfill — verified live**, open WFS,
  **19,851 sites** (`environment.data.gov.uk/spatialdata/historic-landfill/wfs`,
  layer `Historic_Landfill_Sites`). The single highest-value addition:
  landfill gas and ground risk kill more brownfield schemes than planning does.
* Coal Authority development-risk areas; EA permitted waste sites;
  existing constraints we already hold (flood, TPO, heritage, AQMA).
* Presented as a **cost/risk overlay on** the opportunity, never as a
  disqualifier — a contaminated site with high value can still work.

---

## 3. Proposed layer tree

A new top-level branch in `OVERLAY_TREE`, beside "Planning & environment":

```
Brownfield & underused land
├── Declared sites
│   ├── Brownfield register — all sites          (36,133)
│   ├── … with published boundary                 (2,916)
│   ├── … public-authority owned                  (4,423)
│   ├── … deliverable, 5+ dwellings               (filterable)
│   └── Grey-belt candidates (model)              (23,399)
├── Underused land (model)
│   ├── Vacant parcels        (<3% built)
│   ├── Lightly developed     (3–20% built)
│   ├── Low-rise sheds        (>20%, ≤1.2 plot ratio)
│   └── Surface car parks
├── Public & institutional estate
│   ├── Public parcels ≥0.25 ha        (from public_parcel)
│   ├── NHS / MOD / LA / Homes England (owner_class facets)
│   └── Homes England disposal pipeline
└── Remediation & risk
    ├── Historic landfill (EA)                    (19,851)
    ├── Coal mining legacy
    └── Permitted waste sites
```

Every row keeps the existing overlay contract (colour, `minZoom`, `about`
text with source + licence), so nothing new is needed in the layer engine.

---

## 4. Scoring — the "brownfield opportunity index"

One number per candidate site, always decomposable:

| Component | Weight | Source |
|---|---|---|
| Underuse (1 − intensity index) | 30% | Lens C |
| Size (usable area after constraints) | 20% | parcel ∩ constraints |
| Value (local £/m², existing layers) | 20% | `price_grid_*` |
| Ownership tractability | 15% | Lens B (single public owner best) |
| Policy support | 10% | register presence, grey belt, HDT, PDR route |
| Remediation risk (negative) | −15% | Lens D |

Deliberately **not** a black box: the site card shows each component with its
source, exactly as the DC panel does now. A registered site and a modelled
site are labelled differently and never silently merged.

---

## 5. Delivery phases

**Phase 1 — fix and expose what we hold** (small, high value)
* Repair `hectares` (clamp/flag the 75 outliers; correct the summary RPC).
* Split the single overlay into the "Declared sites" family with filters.
* Add EA Historic Landfill (verified reachable; one loader + one layer).
* Refresh the register (loaded 2026-07-02).

**Phase 2 — the underuse model** (the new capability)
* Client-side parcel × building coverage in the viewport, painted as the
  three underuse classes, with a site card showing coverage / storeys / area.
* Public-estate facets promoted into the branch.

**Phase 3 — national ranking + workflow join-up**
* Precompute coverage per parcel nationally (pipeline, not client) so sites
  can be *ranked* and sifted rather than only browsed.
* Feed selected sites straight into the existing assemble → compile →
  generative-layout chain, which already accepts arbitrary parcel geometry.
* Scotland/Wales declared-site equivalents.

---

## 6. Honesty rules (carried from the rest of the app)

* A modelled underused site is **a lead, not a fact** — label it as derived,
  name the inputs, and never show it in the same colour as a registered site.
* OSM building coverage is incomplete in rural areas; low coverage there may
  mean unsurveyed, not undeveloped. Cross-check against the built-land mask
  before calling a parcel vacant.
* Register `deliverable` and `dwellings` are the LPA's own assertions,
  restated as theirs, not adopted as ours.
