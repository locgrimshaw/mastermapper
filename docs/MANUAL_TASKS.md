# Manual tasks — step-by-step guide

Every layer below is already fully wired into the app. The ONLY missing piece
for each one is a file or URL that needs a human (login walls, hashed download
links, licence acceptances). Do a task, then run the loader (last section) —
the layer lights up on the map.

**The two mechanisms** (each task says which to use):

- **Drop-in file** — upload the file straight into the repo through the GitHub
  website: open <https://github.com/locgrimshaw/mastermapper/upload/main/data/raw>,
  drag the file in, **rename it to the exact filename given** (click the
  filename box), press **Commit changes**. Works for files up to ~25 MB.
- **Repo variable** — for big files that stay hosted at their source: open
  <https://github.com/locgrimshaw/mastermapper/settings/variables/actions>,
  press **New repository variable**, enter the **Name** given and paste the
  URL as the **Value**, save.

---

## 1. HESA student numbers — ✅ DONE (2024/25 data committed)

data/raw/hesa_students.csv now carries HESA DT051 Table 1 (enrolments +
international share) merged with Table 57 (term-time accommodation mix) for
304 providers, 2024/25, CC-BY 4.0. To refresh for a future academic year:
download the two tables from <https://www.hesa.ac.uk/data-and-analysis/students>
(Table 1 and Table 57, filtered to the latest year) and hand the raw CSVs to
Claude — the merge is scripted.

## 2. NESO TEC register → the grid connection queue (MW per site)

1. Go to <https://www.neso.energy/data-portal/transmission-entry-capacity-tec-register>.
2. Find the latest **TEC Register** resource and right-click its CSV download
   button → **Copy link address**.
3. **Repo variable** `TEC_SRC` = that link. (If the link looks unstable,
   download the CSV instead → drop-in file named **`tec-register.csv`**.)

## 3. NESO Grid Supply Point boundaries — ✅ DONE, no action needed

The Feb 2026 "GSP regions" zip release is now the pipeline's built-in default
(the builder unzips it and picks the WGS84 GeoJSON automatically). Only when
NESO publishes a NEWER release: copy its zip link from
<https://www.neso.energy/data-portal> and set repo variable `GSP_SRC` to it.

## 4. TfL PTAL grid — ✅ DONE (stable ArcGIS Hub URL wired as default)

## 4b. (superseded) original PTAL steps

1. Go to <https://data.london.gov.uk/dataset/public-transport-accessibility-levels-24rz6/>
   (or search "PTAL" on data.london.gov.uk).
2. Download EITHER the **shapefile/GeoJSON** version of the PTAL grid (a zip
   is fine) OR a CSV **that includes X and Y coordinate columns** — the plain
   attribute CSV (GridID + scores only) cannot be placed on the map.
3. **Drop-in file** named **`ptal_grid.csv`** (keep that name even for a
   zip/GeoJSON — the pipeline sniffs the content), or hand the file to Claude.

## 5. ONS private rents — ✅ DONE (June 2026 data committed)

data/raw/ons-la-rents.csv carries the latest-month average rent + annual
change for 335 local authorities, extracted from the PIPR workbook. To
refresh: hand the new PIPR download to Claude (any format).

## 5b. (superseded) ONS private rents original steps

1. Go to <https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/privaterentandhousepricesuk/latest>
   and open the **Price Index of Private Rents** data downloads (or the
   companion dataset
   <https://www.ons.gov.uk/peoplepopulationandcommunity/housing/datasets/privaterentalmarketsummarystatisticsinengland>).
2. Download the **local-authority level** table (average monthly rents,
   ideally with bedroom-count breakdowns). If it's XLSX, open it and save the
   LA-level sheet as CSV (delete preamble rows above the header).
3. **Drop-in file** named **`ons-la-rents.csv`**.

## 5c. EPC account → REAL £/m² in the sold-price heatmap

The £/m² heatmap currently estimates floor areas from property type. With an
EPC account it uses each home's actual certificated floor area instead:

1. Register (free) at <https://epc.opendatacommunities.org/> — after signing
   up, your **API key** is shown on your account page.
2. Add TWO repository secrets at
   <https://github.com/locgrimshaw/mastermapper/settings/secrets/actions>:
   **`EPC_EMAIL`** (the account email) and **`EPC_API_KEY`**.
3. Re-run the **"Load Price Paid sales into Supabase"** workflow with months
   = 36. It downloads the national certificate file (~5 GB, stays inside the
   runner), address-matches every sale, and the heatmap re-aggregates itself
   — hover a cell to see "measured (N EPC-matched sales)" replace the ~
   estimates.

## 6. EA water availability → data-centre water feasibility

1. Go to <https://environment.data.gov.uk/dataset/62514eb5-e9d5-4d96-8b73-a40c5b702d43>
   (Water Resource Availability and Abstraction Reliability — CAMS).
2. Download the **GeoJSON** version if offered.
3. If < 25 MB: **drop-in file** named **`water-availability.geojson`**.
   If larger: **repo variable** `WATER_SRC` = the download link.

## 7. Agricultural Land Classification (fix the failed default)

1. Go to <https://naturalengland-defra.opendata.arcgis.com/> and search
   **"Provisional Agricultural Land Classification (ALC)"**.
2. On the dataset page press **Download** → choose **GeoJSON** → when the file
   is generated, right-click the download button → **Copy link address**.
3. **Repo variable** `ALC_SRC` = that link.

## 8. HM Land Registry CCOD — monthly manual upload (Cloudflare blocks CI)

HMLR's site sits behind Cloudflare bot protection that refuses requests from
GitHub's runners (Error 1010), so the API key route can't run headlessly.
The working route — repeat monthly when HMLR refresh the file:

1. Signed in at <https://use-land-property-data.service.gov.uk/>, download the
   latest full file (e.g. `CCOD_FULL_2026_07.zip`, ~400 MB).
2. Open the Supabase dashboard → your project → **Storage** → bucket
   **`restricted`** (private — the licence-restricted file never goes in the
   public repo) → **Upload file** → pick the zip, keep its original
   `CCOD_FULL_…` name.
3. Run the **"Load CCOD council-owned property into Supabase"** workflow from
   the Actions tab (no inputs needed — it finds the newest CCOD_FULL zip in
   the bucket automatically).
4. Optionally delete the zip from the bucket afterwards to save storage.

## 8c. National land-parcel outlines (INSPIRE tiles) — ONE step left

The national tile file is **built and waiting** (4.5 GB, kept as a workflow
artifact) — only the upload is blocked by the project's storage limit:

1. In the Supabase dashboard: **Project Settings → Storage → Upload file
   size limit** → set to at least **5 GB** (default is 50 MB; the file is
   4.5 GB).
2. Run the **"Finish national parcel tiles"** workflow from the Actions tab
   with *source_run_id* = **30136665316**. It reuses that run's downloaded
   data (nothing re-fetched from HMLR), re-tiles (~1¾ h) and uploads.
3. Hard-refresh the map and turn on **Land parcels (HMLR INSPIRE)** under
   Land ownership — parcels appear from zoom 13.

(Future rebuilds: run "Build national INSPIRE parcel tiles" with max_las
blank — it now fans out across 8 parallel runners, ~3.5 h total.)

## 8b. (superseded) original HMLR steps

1. Go to <https://use-land-property-data.service.gov.uk/> → **Create account**
   (free).
2. Once signed in, request access to **"UK companies that own property in
   England and Wales" (CCOD)** — free, but you must accept its licence.
3. Don't upload anything anywhere (the file is ~400 MB and licence-restricted
   — it must NOT go in the public repo). Just tell Claude when the account is
   ready and we'll wire a private storage route.
   (The INSPIRE parcel polygons at
   <https://use-land-property-data.service.gov.uk/datasets/inspire> need no
   account — that side is already automatable.)

## 8d. Housing Delivery Test → the NPPF approval-likelihood layer

1. Search gov.uk for **"Housing Delivery Test measurement"** and download the
   latest measurement CSV/ODS (save/export as CSV if ODS).
2. **Drop-in file** named **`hdt.csv`**, then run the datasets loader with
   `hdt` — authorities colour by consequence (red = presumption in favour).

## 8e. Finer rents (optional but recommended)

The rents builder already understands bedroom-level tables. Download the
**VOA private rental market summary statistics** (LA × bedroom count,
medians/quartiles) from gov.uk and supply it as the rents CSV (drop-in
**`ons-la-rents.csv`** replacement or hand it to Claude) — the layer and
hover then carry per-bedroom figures. For London ward-level rents, grab the
GLA London Rents Map data extract and hand it over.

## 8f. Bus timetable → frequency-coloured bus stops (BODS GTFS)

Bus stops (NaPTAN) load with **no action needed** — run the "Load bus network
into Supabase" workflow. To light up frequencies + route numbers per stop:

1. Register (free) at <https://data.bus-data.dft.gov.uk/> and find your API
   key under account settings.
2. On the *Download all data* → **Timetables — GTFS** page, copy the "All
   regions" download link and append `?api_key=YOURKEY`.
3. **Repo variable** `BUS_GTFS_SRC` = that link (or download the zip yourself
   → drop-in file named **`bus-gtfs.zip`** — but it's ~1 GB, so the variable
   route is better).
4. Re-run the "Load bus network into Supabase" workflow.

## 9. DNO registrations → real grid capacity/headroom (v2 layers)

1. **UKPN** — ✅ DONE: the Grid and Primary sites export is wired in as the
   `ukpn_sites` dataset (stable API URL, no registration needed for export).
2. **NGED** — ✅ DONE: the substations capacity CSV is wired in as the
   `nged_sites` dataset (stable CKAN resource URL).

## 9b. The last three DNOs → national substation headroom coverage

UKPN, NGED and **Northern Powergrid (✅ DONE — 681 substation areas load
automatically)** are wired in. The remaining three publish their headroom
data behind sign-ins or hashed links, so each needs one pasted URL:

1. Find the dataset (a free portal account may be required for the export):
   - SPEN: <https://spenergynetworks.opendatasoft.com/> — search "heat map
     primary substations" (SPD and SPM are separate datasets; you can paste
     BOTH export links joined with a `|`).
   - Electricity North West:
     <https://electricitynorthwest.opendatasoft.com/explore/dataset/distribution-tx-headroom/>
     (log in → Export → CSV link).
   - SSEN: <https://data.ssen.co.uk/> → Network Capacity collection → the
     primary/BSP headroom CSV.
2. Copy the **CSV export link** (data needs lat/long or easting/northing
   columns — the pipeline sniffs either).
3. **Repo variable** `SPEN_SITES_SRC` / `ENWL_SITES_SRC` / `SSEN_SITES_SRC`
   = that link, then run the datasets loader with
   `spen_sites,enwl_sites,ssen_sites`.

## 11. Ofcom Connected Nations → full-fibre availability layer

1. Go to <https://www.ofcom.org.uk/phones-and-broadband/coverage-and-speeds/connected-nations-and-infrastructure-reports>
   and open the latest **Connected Nations** report's data downloads.
2. Download the **fixed coverage, local authority level** CSV (it has an LA
   code column plus "Full Fibre availability" / "Gigabit availability"
   percentage columns).
3. If < 25 MB: **drop-in file** named **`ofcom-fixed-la.csv`**; otherwise
   **repo variable** `OFCOM_FIBRE_SRC` = the download link. Then run the
   datasets loader with `ofcom_fibre`.

## 10. National Rail Open Data account → the PBSA rail sift's journey data

The new "PBSA sift" box ranks feeder stations by DIRECT train time into a
university's gateway stations. That needs the National Rail timetable:
1. Register (free) at <https://opendata.nationalrail.co.uk/> and subscribe to
   the **Timetable** feed.
2. Add TWO repository secrets at
   <https://github.com/locgrimshaw/mastermapper/settings/secrets/actions>:
   **`NR_EMAIL`** (your login email) and **`NR_PASSWORD`**.
3. Run the **"Load rail station links into Supabase"** workflow from the
   Actions tab. Until then the PBSA box shows walkable gateway stations only,
   with an honest note.

---

## Finally: run the loader (after any of tasks 1–7)

1. Go to <https://github.com/locgrimshaw/mastermapper/actions/workflows/load-datasets.yml>.
2. Press **Run workflow** (grey button, right side).
3. In the *datasets* box either leave it **blank** (rebuild everything) or
   type just the ones you've supplied, e.g. `tec_register,gsp_boundary` or
   `la_rents,ptal,alc,water_availability,uni_campus`.
4. Press the green **Run workflow** button. Give it 10–40 minutes (longer if
   power/university datasets are included — those re-download OpenStreetMap).
5. When the run shows a green tick, hard-refresh the map (Ctrl/Cmd-Shift-R)
   and the layers will populate. Any dataset that still failed shows a
   ⚠ warning in the run's logs saying exactly what it needs.
