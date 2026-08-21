# NPPF (August 2026) — corrections owed, and metrics worth building

Read of the published Framework (*National Planning Policy Framework:
Plan-making and national decision-making policies*, MHCLG, August 2026) against
what MasterMapper currently models. The document is a structural rewrite: 135
numbered policies (PM/DM/S/HO/GB/L/TR/…) replace the old paragraph numbering,
and several of the numbers the tool was built on have moved.

Three parts: **corrections we owe** (the tool is currently citing a
consultation draft in places, and two figures are wrong), **metrics computable
now** from open data, and **metrics needing new data**. Nothing here is built
yet — this is the plan.

---

## Part 0 — Corrections owed

### 0.1 The well-connected-station test is now top-80 TTWA, not top-60 — 86 stations affected

Annex B: a well-connected station is one *"located within a top 80 Travel to
Work Area located partially or fully within England by Gross Value Added
(GVA)"* and served, in the normal weekday timetable, by *"at least four trains
or trams per hour overall, or at least two trains or trams per hour in any one
direction"*, throughout the daytime — with a reasonable prospect of that
service counting too, where upgrades are planned or agreed with the operator.

The frequency limb is unchanged from the draft. The GVA limb moved from top 60
to **top 80**. `pipeline/build_ttwa_gva.py` still has `TOP_N = 60`.

Measured against the live data: **949 stations are well-connected today; 86
more qualify under the published definition** (all in England), a 9% increase.
Those 86 are currently one tier down, which suppresses their density floor and,
where they sit outside a settlement, denies them the Tier B Green Belt route.

The Framework also fixes the vintage: 2023 GVA data is to be used until the day
after the 2028 data is published, then held fixed in five-year blocks. That is
worth encoding as a comment against the constant so nobody "helpfully" updates
it early.

**Cost**: one constant, then `stations` reloaded and `station_assessments`
rebuilt — the rebuild we have deliberately been avoiding re-dispatching. It
should be done deliberately, not folded into another job.

### 0.2 The density minima are 35 / 45 dph, and the 45 trigger is double frequency

Policy S5(2)(c): within reasonable walking distance of a well-connected
station, *"a density of at least 35 dwellings per hectare should be achieved
within the net developable area of the site. Higher densities – of at least 45
dwellings per hectare – should be achieved where the service frequency is at
least twice that of the minimum required for a well-connected station."*
S5(3) adds that these minima *"should be exceeded where possible"*, and S5(4)
that proposals failing them *"should be refused"*.

Two things follow:

- Our 40 / 50 dph floors are **not** the NPPF minima — they are our own
  assumption sitting above them. The copy now says so. That is a defensible
  position (the Framework wants the minima exceeded), but it must not be
  presented as compliance arithmetic.
- The 45 dph tier keys on **twice the well-connected frequency** — 8 trains per
  hour overall, or 4 in one direction — not on "well-connected" itself. We
  store `meets_frequency` as a boolean and no trains-per-hour figure, so we
  cannot currently identify that tier at all. See §2.1.

### 0.3 Green Belt schemes owe the Golden Rules — BUILT

Policy GB7(1)(h) carries the station route into the Green Belt, and GB8 then
attaches the Golden Rules to *major development involving housing* on land
released from, or granted in, the Green Belt:

> affordable housing which reflects … *"a contribution which is 15 percentage
> points above the highest existing affordable housing requirement which would
> otherwise apply to the development, subject to a cap of 50%. In the absence
> of a pre-existing requirement for affordable housing, a 50% affordable
> housing contribution should apply by default."*

Plus necessary infrastructure improvements and new or improved publicly
accessible green space.

Our appraisal applies one flat affordable percentage (default 25%) everywhere.
For a Tier B station — out of settlement, Green Belt release, which is exactly
the case the tool is built to find — the policy-compliant figure is **40%**
(25 + 15), or 50% where no local requirement exists. That is a large,
systematic understatement of cost on precisely the sites we are recommending.

**BUILT.** The uplift is blended by each scheme's Green Belt share of
developable land (a site 30% in the Green Belt lands at 29.5%, not a blanket
40%), gated on major development, with the CIL exemption following the
effective affordable share. It appears as its own line in the calculation
audit and the deep-dive viability panel. Exemptions the model cannot know —
plans adopted before 12 December 2024, permissions granted before that date,
traveller sites — are named in the tooltip with an off switch. The exposure
turned out to be much wider than Tier B: 609 of 2,382 English stations have
Green Belt in their developable land, 505 are more than half Green Belt, and
26.8% of all developable hectares the tool appraises sit under the rule.

### 0.4 Citations

The well-connected-station policy survived the consultation into the published
Framework as **S5(1)(h)** (outside settlements), **L3** (densities) and
**GB7(1)(h)** (Green Belt), with 800 m / 10 minutes defined in Annex B. The
in-copy citations have been updated; the sift's step 1 and step 2 text now
names those policies rather than "the draft NPPF".

Worth noting for its own sake: **policy S4** now says development within
settlements *"should be approved unless the benefits of doing so would be
substantially outweighed by any adverse effects"* — a stronger and simpler
presumption than the old tilted balance, and it vindicates the Tier A "default
yes" framing the tool already uses.

---

## Part 1 — Metrics computable now, from open data

### 1.1 Standard-method local housing need — BUILT

Annex D specifies the standard method completely, and every input is free:

| Step | Rule | Source |
|---|---|---|
| 1. Baseline | **0.8% of existing housing stock** for the area | MHCLG Live Table 125, dwelling stock by LAD, annual |
| 2. Affordability | No adjustment at a ratio of 5 or below. For each 1% above 5, increase the baseline by 0.95%. `Adjustment Factor = ((5yr avg ratio − 5) / 5) × 0.95 + 1` | ONS median **workplace-based** house-price-to-earnings ratio by LAD, mean of the five most recent years |

That yields a minimum annual local housing need figure for every English
authority — the single number that governs how much land an authority has to
find. Both sources are published, stable and already in the shape our
`build_datasets.py` LAD joins expect.

**BUILT** as dataset `housing_need` (layer "Housing need (standard method)").
293 authorities carry a figure. The check that it is right rather than merely
plausible: summed across England it comes to **367,693 homes a year** against
the government's published standard-method total of about 370,000.

### 1.2 Plan requirement vs standard-method need — BUILT

Annex D para 9(c): for decision-making, a **20% buffer** applies where an
authority's plan was examined against a pre-December-2024 Framework and its
*"annual average housing requirement … is 80% or less of the most up-to-date
local housing need figure"*.

**BUILT** as the second layer on the same dataset ("Plan requirement vs
need"). 172 of 293 authorities can be compared honestly, and **126 of those
sit at or below 80% of current need**.

Three classes of authority are deliberately excluded, because ranking the
first cut showed each producing a fabricated shortfall: authorities carrying
several predecessor district plans after reorganisation (North Yorkshire holds
seven; taking the latest presented one former district as the whole county, at
315 homes a year against a need of 4,173), joint plans whose requirement
covers several authorities with no published split (Norwich read 262% of its
need), and plans whose period began before the authority existed (Somerset was
showing the Sedgemoor Local Plan). Those keep their plan count and say why on
hover — an authority running on predecessor plans has no up-to-date one, which
is a signal in itself.

The flag is `below80`, not `buffer20`: Annex D 9(c)'s second limb (a
requirement adopted in the last five years, examined against a
pre-December-2024 Framework) cannot be confirmed per authority from open
data.

### 1.3 Housing Delivery Test consequences, including the unmet-need route

Annex D paras 11–13 confirm the thresholds our HDT layer already colours
(95% / 85% / 75%) but adds the consequence that matters most:

- **< 95%** — action plan required
- **< 85%** — 20% buffer on the deliverable supply, plus the action plan
- **< 75%** — *"an evidenced unmet need for housing is deemed to exist for the
  purpose of applying policy S5(1)(j)"* — the route to approval **outside
  settlements**, in addition to the action plan and buffer

The third tier is not currently surfaced as what it is: a statutory unlock for
out-of-settlement development. It should be its own flag on the station row and
in the site report, not just a colour band.

### 1.4 Site-size classification — which policies actually bite

Annex B: **major development** for housing is *"where 10 or more homes will be
provided, or the site has an area of 0.5 hectares or more"*; **medium-sized**
is a subset — *"10–49 homes (inclusive) and the site has an area of up to 2.5
hectares"*.

Every plot in the deep dive and every assembled site already has an area and a
capacity, so both classes are a one-line derivation. It matters because the
Golden Rules, affordable-housing requirements and much of the contributions
regime attach to *major* development — a 9-home scheme on 0.4 ha is a different
policy animal, and the appraisal should say so rather than applying major-
development costs to a minor scheme.

### 1.5 Small-site supply — HO6

Policy HO6(1)(a): local plans should *"allocate land to accommodate at least
10% of the housing requirement on sites no larger than one hectare, and a
further 10% on sites of between one and two and a half hectares"*.

We compute contiguous plot polygons per station catchment. Counting those in
the ≤1 ha and 1–2.5 ha bands gives a direct read on whether a station catchment
can serve an authority's small-site obligation — a genuinely differentiated
pitch, because the 10%+10% requirement is one most authorities struggle with
and small sites are exactly what a station catchment produces.

### 1.6 Grey belt — align the model to the published definition

Annex B now defines grey belt formally: *"land in the Green Belt comprising
previously developed land and/or any other land that, in either case, does not
strongly contribute to any of purposes (a), (b), or (d) in policy GB2"* — that
is, checking unrestricted sprawl, preventing towns merging, and preserving the
setting of historic towns. Purposes (c) safeguarding countryside and (e)
assisting urban regeneration are **excluded** from the test.

Our `grey_belt_candidate` model is built from built-up-area proximity and the
brownfield register. It should be restated against those three named purposes —
at minimum documenting which purpose each heuristic proxies, and dropping any
part that leans on (c) or (e).

### 1.7 Affordable-housing value assumption — calibrate against Annex B

Annex B: discounted market sales housing is *"sold at a discount of at least
20% below local market value"*, and the same 20% floor governs other low-cost
home ownership. Our `affordableValue` default is 55% of market. That is fine
for social/affordable rent, but a tenure mix containing discounted market sale
should be modelled at ~80%, not 55% — currently we understate GDV on
mixed-tenure affordable provision. Worth splitting `affordableValue` into a
rented and an intermediate/DMS rate.

---

## Part 2 — Metrics needing new data

### 2.1 Trains per hour, to unlock the 45 dph tier

The only blocker on §0.2. We already ingest the GB rail timetable
(`pipeline/build_connectivity_cif.py`) to derive `meets_frequency`; the same
pass can emit the count rather than only the boolean, giving both the ≥4/hour
test and the ≥8/hour double-frequency test from one source. Low effort, and it
removes a stated gap from the sift.

### 2.2 The DfT Connectivity Tool

Policies TR3(2) and S5(3) both name it: *"The Connectivity Tool … should be
used alongside other relevant quantitative or qualitative evidence in assessing
the connectivity of particular locations proposed for development."* When the
Framework names a tool by URL, matching it is a credibility argument in itself.

Access is free to built-environment professionals via GOV.UK One Login, with a
no-registration "Lite" version and a published methodology
(`transport-connectivity-metric`). **Unknown**: whether the underlying scores
are obtainable as bulk data or only through the interactive tool. Worth one
email to `connectivity@dft.gov.uk` before any build estimate — if the scores
are downloadable per location, this becomes a first-class layer; if not, it is
a link-out from the site report.

### 2.3 Workplace-based affordability ratio as its own layer

Our affordability layer divides sale prices by ASHE/MSOA income. The standard
method uses a specific ONS series — median **workplace-based** house-price-to-
earnings ratio by local authority. Since §1.1 needs it anyway, it should also
be published as the policy-grade affordability layer, distinct from the
neighbourhood-level one we already show: same idea, but the number that
actually drives housing need.

### 2.4 Local Nature Recovery Strategies

Policy HO4(1)(c) requires strategic-site locations to address *"strategic
environmental opportunities and safeguards, including those set out in Local
Nature Recovery Strategies"*, and the N-series leans on them throughout. LNRSs
are being published authority by authority. Coverage is partial and formats
vary — a watching brief, not a build, but it will become a standard constraint
layer.

### 2.5 Real S106 obligations — calibration, if the unit counts can be found

Separately from the NPPF: `developer-agreement-contribution` on
planning.data.gov.uk carries **39,325 contributions, £1.49bn of amounts, from
67 authorities**, with medians by purpose (education £22,050, health £46,046,
open space £14,588, affordable housing £26,150 per contribution). It is the
only real-world check on the contribution rates we researched.

The blocker is that a contribution is per agreement, not per dwelling, and the
platform's `planning-application` dataset carries no dwelling count — so a
per-unit rate cannot be derived from it alone. Unless a unit count can be
joined in from elsewhere, this cannot calibrate our per-unit assumptions, and
saying otherwise would be inventing a denominator.

---

## Part 3 — Framing changes, not data

### 3.1 What the viability engine is arguing

Policy DM5(1): where proposals accord with up-to-date plan policies, *"they
should be assumed to be viable"*. DM5(3): *"Neither the price paid for land,
nor the price intended to be paid through an option agreement, should be a
justification for failing to accord with relevant policies"*.

This is the Framework endorsing exactly the residual-at-benchmark-land-value
method the engine already uses, and it sharpens what the output is *for*. The
question a viability appraisal answers under DM5 is not "what is my profit?"
but "is a policy-compliant scheme viable here at a benchmark land value?" —
because if it is, the contributions stand regardless of what the land cost. The
calculation audit should lead with that framing.

### 3.2 Contributions certainty

Policy PM12(3)(c): affordable housing requirements *"should be expressed as a
single figure rather than a range"*. Where we present a range, we are being
vaguer than the plan-making system now requires plans to be. Worth a pass over
how the appraisal presents policy costs.

---

## Part 4 — constraint and register layers the Framework relies on

A separate class of work from the metrics above: policies that turn on whether
a site sits inside a designated area. Each is a boundary set we do not hold,
and every one below is already published on planning.data.gov.uk under OGL —
they drop straight into the existing dataset framework with no new
infrastructure. Sizes are the published GeoJSON.

### 4.1 The delivery blockers — build these first

| Layer | Policy | Size | Why it matters |
|---|---|---|---|
| **Nutrient neutrality catchments** | N6 | 2.1 MB | The single biggest stalling mechanism in English housing. Inside one of these, a scheme needs mitigation before permission — schemes have sat for years. A site that is otherwise perfect and inside a catchment is a different proposition, and we currently show no difference at all. |
| **Minerals & waste safeguarding areas** | M2 | 21.4 + 19.1 MB | Safeguarded mineral resource blocks or complicates housing over it, and it is invisible on every other layer we draw. A genuine surprise-at-planning-stage constraint. |
| **Air quality management areas** | P3 | 7.4 MB | Declared AQMAs bring assessment requirements and mitigation cost, and cluster exactly where station-adjacent development is most attractive. |
| **Flood storage areas** | F2, S4 | 1.9 MB | Policy S4(2)(b) singles out land used for water storage or flood risk management: losing it is one of the named ways benefits are "substantially outweighed". Distinct from the flood zones we already draw. |

### 4.2 Heritage and nature, completing sets we have started

We draw conservation areas, listed buildings, scheduled monuments, SSSI, SAC,
SPA, Ramsar and ancient woodland. The Framework's heritage and nature policies
reach further, and the gaps are all small files:

- **Archaeological priority areas** (3.1 MB) and **heritage at risk** (11.8 MB)
  — HE-series. Heritage at risk cuts both ways: a constraint, but also an
  enabling-development argument.
- **Locally listed buildings** (0.3 MB) — policy HE7 handles non-designated
  assets on a balanced judgement, not the designated-asset test. Today they are
  invisible until someone objects.
- **Battlefields**, **certificates of immunity**, **building preservation
  notices** (~1 MB together) — rare, but a certificate of immunity is a
  positive signal worth surfacing, not just a constraint.
- **Local nature reserves** (14.9 MB) and **nature improvement areas** (2.5 MB)
  — N-series, and both feed the N2(1)(c) ecological-network test.

### 4.3 Context layers that change the reading of a site

- **Educational establishments** (31.5 MB) — school locations and capacity are
  the denominator of the education contribution the appraisal already charges
  for. Also the HO4(1)(b) "access to services" test for strategic sites.
- **Development corporation boundaries** (0.2 MB) — a different consenting
  regime and often a different affordable requirement.
- **Central activities zone** (0.1 MB) — drives London policy that overrides
  borough norms.

### 4.4 Ground conditions — policy P2, and the one gap not on the platform

P2 requires sites to be suitable "taking into account ground conditions,
including any risks arising from land instability or contamination (whether
due to natural hazards or current and former activities such as mining or fuel
storage)". Our site report flags this as desk-study work, which is honest but
unhelpful — the two big national datasets exist:

- **Coal mining development high risk areas** (Mining Remediation Authority,
  formerly the Coal Authority). Roughly a quarter of England sits over former
  coalfield, and a high risk area means a mining report and often grouting.
  **Source needs confirming** — their open data platform, licence unchecked.
- **Radon affected areas** (UKHSA/BGS). Protective measures are a build-cost
  item we do not currently model. Licensing is likely to be the obstacle.

Both are honest "needs a source check" items rather than costed builds.

### 4.5 Annex C — let the Framework write our further-work list

Annex C is a table of the information an application must supply, by policy:
planning statement, viability assessment, transport statement or assessment,
travel plan, site investigation by a competent person, flood risk assessment,
SuDS statement, coastal change vulnerability assessment, heritage impact
assessment, protected-landscape assessment, open space assessment, town centre
impact assessment.

Our site report already carries a "risks and further work" section built from
whatever fields we flagged as desk-study. Driving it from Annex C instead —
and switching each item on from the constraints we actually detected on the
site — turns a list we invented into the Framework's own, cited by policy. It
is the cheapest credibility win left in the document: no new data, one mapping
table, and it makes the report read as a planning document rather than a
data summary.

### 4.6 Watch item — Environmental Delivery Plans

Policy N6 introduces a second route where a habitats site is affected: the
impact "is being addressed through an Environmental Delivery Plan which has
been made and the developer has committed to paying the nature restoration
levy". This is the intended successor to bespoke nutrient and recreation
mitigation. No national register exists yet. When one appears it becomes a
first-class layer, because inside an EDP area a levy payment replaces an
open-ended mitigation problem — which is precisely the difference between a
site being developable and not.

---

## Roadmap

Six phases, ordered by cost and by what shares a rebuild. Phases 1-3 are all
buildable now from data in hand or free sources.

### Phase 1 — finish the corrections (small, and two share one rebuild)

| Item | Cost |
|---|---|
| §1.3 HDT unmet-need flag — surface the sub-75% S5(1)(j) unlock as a flag, not a colour band | frontend only |
| §1.6 grey belt restated against GB2 purposes (a), (b), (d) only | model + copy |
| §1.7 split affordable value into rented and intermediate (Annex B's ≥20% discount floor) | one schema entry |
| §2.1 trains per hour from the timetable pass we already run | pipeline |
| §0.1 top-80 TTWA — 86 stations sitting a tier low | one constant |

The last two both need `station_assessments` rebuilt, so they go together in
one deliberate pass rather than two.

### Phase 2 — site-level policy classification (no new data at all)

| Item | Cost |
|---|---|
| §1.4 major / medium / minor classification from area and capacity | derivation |
| §1.5 small-site supply per catchment against HO6's 10% + 10% | derivation |
| §4.5 Annex C information requirements driving the report's further-work list | mapping table |

Highest value per hour of anything left: all three are arithmetic or copy over
data already loaded, and together they move the site report from "here is what
we found" to "here is what the Framework asks of this site".

### Phase 3 — the missing constraint layers (free, OGL, existing framework)

Start with §4.1's four delivery blockers — nutrient neutrality especially,
which changes whether a site is developable at all. Then §4.2's heritage and
nature sets, then §4.3's context layers. Each is a builder function and a
registry entry; the pattern is now well worn.

### Phase 4 — ground conditions

§4.4 coal and radon. Source and licence checks first — do not scope a build
before those answers.

### Phase 5 — the open questions

- The DfT **Connectivity Tool's own scores** (§2.2). The published metric is
  now in the tool at authority, neighbourhood and Output Area level; what
  remains is whether the tool's finer internal scores are obtainable. One
  email answers it, and the same email should settle the metric's licence,
  which its own metadata still records as "TBA".
- **Local Nature Recovery Strategies** (§2.4) — publishing authority by
  authority; a watching brief.
- **S106 calibration** (§2.5) — blocked until a dwelling-count denominator
  appears; do not attempt without one.

### Phase 6 — reframing, not building

§3.1 lead the calculation audit with the DM5 question it actually answers —
"is a policy-compliant scheme viable here at a benchmark land value?" — rather
than "what is the profit?". §3.2 present contributions as single figures, as
PM12(3)(c) now requires plans to.

Worth stating once somewhere prominent: policy **PM9** requires plan-makers to
assess land for "availability, suitability and achievability (including likely
viability)". That is a description of what this tool does. The sift and the
site report together are a HELAA in miniature, and saying so in the
Framework's own words is a stronger claim than any feature list.
