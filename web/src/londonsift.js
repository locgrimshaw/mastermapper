// londonsift.js — the "London sites" sifter.
//
// Every candidate plot in Greater London (brownfield, underused built land,
// green space, grey belt — ~22k sites, table london_sites, migration 0083)
// arrives once with its evidence attached: PTAL, DfT connectivity, a
// door-to-Zone-1 journey time, rents, growth signals, constraints. Everything
// after that is client-side, so reordering or retuning a gate is instant.
//
// Gates are an ordered list. Each is Filter (a hard cut), Score (kept, but it
// counts toward the ranking) or Off. Order does two jobs: the funnel reads
// top to bottom ("after PTAL, 4,210 sites remain"), and the ranking weights
// gates by position — the top scoring gate counts most, the last one least.

const PTAL_LEVELS = ["0", "1a", "1b", "2", "3", "4", "5", "6a", "6b"];

// Candidate land types, grouped as the brief frames them.
const LAND_TYPES = [
  { key: "register",       cat: "brownfield", label: "Brownfield register" },
  { key: "osm_brownfield", cat: "brownfield", label: "Derelict, works & construction land" },
  { key: "osm_industrial", cat: "underused",  label: "Industrial estates & business parks" },
  { key: "osm_retail",     cat: "underused",  label: "Retail sheds & parks" },
  { key: "osm_storage",    cat: "underused",  label: "Yards, depots & lock-ups" },
  { key: "osm_parking",    cat: "underused",  label: "Surface car parks" },
  { key: "green_space",    cat: "green",      label: "Green space (OS Open Greenspace)" },
  { key: "osm_leisure",    cat: "green",      label: "Low-density leisure (golf, tracks)" },
  { key: "grey_belt",      cat: "grey_belt",  label: "Grey belt candidates" },
];
const CAT_LABEL = { brownfield: "Brownfield", underused: "Underused built land",
                    green: "Green space", grey_belt: "Grey belt" };
const CAT_COLOR = { brownfield: "#e8590c", underused: "#7048e8", green: "#2f9e44", grey_belt: "#868e96" };
// Green-space functions that are almost never a development proposition in
// London; off by default, one tick away.
const GREEN_SOFT_EXCLUDE = ["Public Park Or Garden", "Play Space", "Cemetery",
                            "Religious Grounds", "Bowling Green", "Tennis Court"];

// Land already being built (OSM landuse=construction, register "Started") is
// someone else's scheme, not an opportunity.
const isBuilding = r => (r.src === "osm_brownfield" && r.subtype === "construction")
  || (r.src === "register" && /^started$/i.test(r.permission || ""));
// Register sites with planning permission in any of the registers' spellings.
const isPermissioned = r => r.src === "register"
  && /(^|\s)(full )?perm|p[e]mrission|appeal allowed|started/i.test(r.permission || "")
  && !/not/i.test(r.permission || "");

// SINC grades as GiGL writes them: "Metropolitan importance", "Borough
// importance grade I", "Borough importance grade II", "Borough importance",
// "Local importance". The top two carry real weight under London Plan G6.
const sincMajor = g => !!g && (/^metropolitan/i.test(g) || /grade I$/i.test(g));
function constraintHit(k, r) {
  if (k === "listed") return (r.listed_n || 0) > 0;
  if (k === "sinc_major") return sincMajor(r.sinc_grade);
  if (k === "sinc_any") return !!r.sinc_grade;
  return !!r[k];
}

const fmtInt = v => Math.round(v).toLocaleString("en-GB");
const gbp = v => "£" + fmtInt(v);

// Every numeric measure a gate can test or score on. dir 1 = higher is
// better (threshold is a minimum), -1 = lower is better (a maximum).
const METRICS = {
  area_ha:        { label: "Site size", get: r => r.area_ha, dir: 1, min: 0.05, max: 10, step: 0.05, def: 0.1,
                    fmt: v => `${v.toFixed(2)} ha` },
  ptal_ai:        { label: "PTAL", get: r => r.ptal_ai, dir: 1, ptal: true, def: "4",
                    fmt: v => v },
  conn_pt:        { label: "Public transport, all purposes", get: r => r.conn_pt, dir: 1, min: 0, max: 100, step: 1, def: 80,
                    fmt: v => `${v.toFixed(0)} / 100` },
  conn_emp:       { label: "Public transport to jobs", get: r => r.conn_emp, dir: 1, min: 0, max: 100, step: 1, def: 80,
                    fmt: v => `${v.toFixed(0)} / 100` },
  conn_all:       { label: "All modes, all purposes", get: r => r.conn_all, dir: 1, min: 0, max: 100, step: 1, def: 85,
                    fmt: v => `${v.toFixed(0)} / 100` },
  z1_min:         { label: "Door to Zone 1", get: r => r.z1_min, dir: -1, min: 5, max: 60, step: 1, def: 30,
                    fmt: v => `${v.toFixed(0)} min` },
  stn_m:          { label: "Walk to nearest station", get: r => r.stn_m, dir: -1, min: 100, max: 2000, step: 50, def: 800,
                    fmt: v => `${fmtInt(v)} m` },
  resi_rent:      { label: "Private rent, all homes (borough)", get: r => r.resi_rent, dir: 1, min: 1200, max: 5000, step: 50, def: 2000,
                    fmt: v => `${gbp(v)} pcm` },
  resi_rent_2b:   { label: "Private rent, 2-bed (borough)", get: r => r.resi_rent_2b, dir: 1, min: 1200, max: 4000, step: 50, def: 2000,
                    fmt: v => `${gbp(v)} pcm` },
  office_prime:   { label: "Prime office rent (agents, submarket)", get: r => r.office_prime, dir: 1, min: 20, max: 150, step: 2.5, def: 50,
                    fmt: v => `£${v.toFixed(2)} /ft²` },
  office_mid:     { label: "Grade A/B office rent (agents)", get: r => r.office_mid, dir: 1, min: 15, max: 120, step: 2.5, def: 40,
                    fmt: v => `£${v.toFixed(2)} /ft²` },
  office_voa_pm2: { label: "Office rateable value, ~400 m (VOA)", get: r => r.office_voa_pm2, dir: 1, min: 50, max: 1000, step: 10, def: 250,
                    fmt: v => `£${fmtInt(v)} /m²` },
  office_n:       { label: "Office cluster, ~400 m (VOA units)", get: r => r.office_n, dir: 1, min: 0, max: 500, step: 5, def: 25,
                    fmt: v => `${fmtInt(v)} units` },
  price_ppm2:     { label: "Home sale price £/m² (local)", get: r => r.price_ppm2, dir: 1, min: 3000, max: 20000, step: 250, def: 6000,
                    fmt: v => `${gbp(v)} /m²` },
  rent_g5:        { label: "Rent growth, 5 years (borough)", get: r => r.rent_g5, dir: 1, min: -10, max: 60, step: 1, def: 25,
                    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
  rent_chg:       { label: "Rent growth, last 12 months (borough)", get: r => r.rent_chg, dir: 1, min: -5, max: 15, step: 0.5, def: 3,
                    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
  price_trend:    { label: "Local price trend £/m²", get: r => r.price_trend, dir: 1, min: -20, max: 30, step: 1, def: 0,
                    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
  approval_pct:   { label: "Planning approval rate (borough, 3 yrs)", get: r => r.approval_pct, dir: 1, min: 50, max: 100, step: 1, def: 85,
                    fmt: v => `${v.toFixed(0)}%` },
  plan_vs_lhn:    { label: "Plan supply vs housing need (lower = more pressure)", get: r => r.plan_vs_lhn, dir: -1, min: 0, max: 200, step: 5, def: 80,
                    fmt: v => `${v.toFixed(0)}%` },
  headroom:       { label: "Height headroom vs neighbours", get: r => r.storeys_ctx == null ? null : r.storeys_ctx - (r.storeys_site || 0),
                    dir: 1, min: 0, max: 15, step: 0.5, def: 2, fmt: v => `${v.toFixed(1)} storeys` },
};

// The gate catalogue. `metrics` lists the measures a gate can switch between.
const GATE_DEFS = {
  land:        { title: "Candidate land", special: "land",
                 about: "Which kinds of land enter the funnel, and the smallest plot worth looking at. Registered brownfield carries council capacity figures; the OSM categories catch derelict and underused land no council has registered (NPPF para 124c/d). Green space and grey belt are harder planning cases and are flagged as not previously developed." },
  ptal:        { title: "PTAL", metrics: ["ptal_ai"],
                 about: "TfL Public Transport Accessibility Level for the 100 m cell at the site's centre: 0 (worst) to 6b (best). The London Plan steers higher densities to PTAL 4–6." },
  conn:        { title: "Connectivity (DfT)", metrics: ["conn_pt", "conn_emp", "conn_all"],
                 about: "DfT transport connectivity metric (2025, experimental), output-area level: how easily people here reach jobs, services and each other. 0–100, England-wide." },
  z1:          { title: "Travel time to Zone 1", metrics: ["z1_min"],
                 about: "Door-to-Zone-1 minutes: walk to the best of the eight nearest stops, wait, then the fastest route by Tube, DLR, Overground, Elizabeth line, tram or national rail, with interchange penalties. Built from TfL timetables and rail direct-service times; Overground and Elizabeth-line hops use average speeds. Modelled, not a journey planner." },
  walk:        { title: "Walk to station", metrics: ["stn_m"],
                 about: "Straight-line distance to the nearest rail, Tube, DLR, Overground, Elizabeth line or tram stop." },
  resi:        { title: "Residential rents", metrics: ["resi_rent", "resi_rent_2b"],
                 about: "ONS Price Index of Private Rents, borough mean £ per calendar month (official statistics in development). The build-to-rent revenue signal." },
  office:      { title: "Office rents", metrics: ["office_prime", "office_mid", "office_voa_pm2", "office_n"], keepMissingDefault: true,
                 about: "Agent-published office rents (£/ft² pa) for the nearest London submarket within 3 km — inner London only. The VOA measures cover everywhere: median office rateable value per m² and the number of office units within about 400 m (a cluster signal). Rateable value is a rental proxy, not a quoted rent." },
  price:       { title: "Sales values", metrics: ["price_ppm2"],
                 about: "Median residential sale price per m² (Land Registry × EPC floor areas) for the local grid cell, borough figure where the cell is thin." },
  growth:      { title: "Growth", metrics: ["rent_g5", "rent_chg", "price_trend", "approval_pct", "plan_vs_lhn"],
                 about: "Momentum and policy tailwind: borough rent growth (ONS), local price trend, how often the borough says yes to planning applications, and how far its adopted plan falls short of the standard-method housing need (more shortfall = more pressure to approve)." },
  headroom:    { title: "Intensification headroom", metrics: ["headroom"],
                 about: "How much taller the neighbourhood is than the site: the 75th-percentile storey count of buildings within ~300 m minus the site's own average. A low shed among mid-rise blocks scores high." },
  constraints: { title: "Constraints", special: "constraints",
                 about: "Remove sites under hard or costly designations. Strategic Industrial Locations are protected for industry and logistics (London Plan E5) and Metropolitan Open Land has Green Belt-level protection (G3); Locally Significant Industrial Sites (E6) are protected by the borough but some allow co-location with homes; Sites of Importance for Nature Conservation (G6) matter most at Metropolitan and Borough Grade I. All are tested against the whole plot, so a site clipping one is flagged. Flood zones, conservation areas and listed buildings are tested against the site; Article 4 directions in London mostly remove office-to-residential permitted development." },
  policy:      { title: "Policy areas & ownership", special: "policy",
                 about: "Keep only sites inside a London Plan Opportunity Area (the capital's planned growth locations), the Central Activities Zone, a Mayoral development corporation (LLDC, OPDC), or on public land (council and other public-body titles). Several ticks = any of them." },
  borough:     { title: "Boroughs", special: "borough",
                 about: "Limit the sift to chosen boroughs." },
};

const CONSTRAINT_OPTS = [
  { key: "in_sil", label: "Strategic Industrial Location" },
  { key: "in_mol", label: "Metropolitan Open Land" },
  { key: "in_lsis", label: "Locally Significant Industrial Site" },
  { key: "sinc_major", label: "SINC — Metropolitan or Borough I" },
  { key: "sinc_any", label: "SINC — any grade" },
  { key: "flood3", label: "Flood zone 3" },
  { key: "flood2", label: "Flood zone 2" },
  { key: "conservation", label: "Conservation area" },
  { key: "listed", label: "Listed building on site" },
  { key: "article4", label: "Article 4 direction" },
  { key: "tpo", label: "Tree preservation order" },
  { key: "aqma", label: "Air quality management area" },
];
const POLICY_OPTS = [
  { key: "in_oa", label: "Opportunity Area" },
  { key: "in_caz", label: "Central Activities Zone" },
  { key: "in_devcorp", label: "Development corporation" },
  { key: "public_land", label: "Public land" },
];

function defaultGate(key, over = {}) {
  const d = GATE_DEFS[key];
  const g = { key, mode: "off" };
  if (d.metrics) {
    g.metric = d.metrics[0];
    g.value = METRICS[g.metric].def;
    g.keepMissing = !!d.keepMissingDefault;
  }
  if (d.special === "land") {
    g.types = LAND_TYPES.filter(t => t.cat !== "green").map(t => t.key);
    g.greenExclude = GREEN_SOFT_EXCLUDE.slice();
    g.minHa = 0.1;
    g.excludeBuilding = true;     // already under construction
    g.excludePermissioned = false;
    g.mode = "filter";
  }
  if (d.special === "constraints") g.exclude = ["in_sil", "in_mol", "sinc_major", "flood3", "listed"];
  if (d.special === "policy") g.require = ["in_oa"];
  if (d.special === "borough") g.boroughs = [];
  return Object.assign(g, over);
}

const PRESETS = {
  balanced: { label: "Balanced", gates: [
    defaultGate("land"),
    defaultGate("ptal", { mode: "filter", value: "4" }),
    defaultGate("z1", { mode: "filter", value: 30 }),
    defaultGate("conn", { mode: "score" }),
    defaultGate("resi", { mode: "score" }),
    defaultGate("office", { mode: "score", metric: "office_voa_pm2", value: 250 }),
    defaultGate("growth", { mode: "score" }),
    defaultGate("headroom", { mode: "score" }),
    defaultGate("constraints", { mode: "filter" }),
    defaultGate("walk"), defaultGate("price"), defaultGate("policy"), defaultGate("borough"),
  ] },
  office: { label: "Office-led", gates: [
    defaultGate("land", { types: ["register", "osm_brownfield", "osm_industrial", "osm_retail", "osm_storage", "osm_parking"], minHa: 0.1 }),
    defaultGate("z1", { mode: "filter", value: 20 }),
    defaultGate("ptal", { mode: "filter", value: "5" }),
    defaultGate("office", { mode: "filter", metric: "office_voa_pm2", value: 300, keepMissing: false }),
    defaultGate("conn", { mode: "score", metric: "conn_emp", value: 90 }),
    defaultGate("growth", { mode: "score", metric: "approval_pct", value: 85 }),
    defaultGate("constraints", { mode: "filter", exclude: ["in_sil", "in_mol", "sinc_major", "flood3", "listed"] }),
    defaultGate("resi"), defaultGate("walk"), defaultGate("price"), defaultGate("headroom"),
    defaultGate("policy"), defaultGate("borough"),
  ] },
  btr: { label: "Build-to-rent", gates: [
    defaultGate("land", { minHa: 0.25 }),
    defaultGate("ptal", { mode: "filter", value: "4" }),
    defaultGate("z1", { mode: "filter", value: 35 }),
    defaultGate("resi", { mode: "filter", metric: "resi_rent_2b", value: 2000 }),
    defaultGate("growth", { mode: "score", metric: "rent_g5", value: 25 }),
    defaultGate("headroom", { mode: "score" }),
    defaultGate("walk", { mode: "score" }),
    defaultGate("constraints", { mode: "filter", exclude: ["in_sil", "in_mol", "sinc_major", "flood3", "listed"] }),
    defaultGate("conn"), defaultGate("office"), defaultGate("price"), defaultGate("policy"), defaultGate("borough"),
  ] },
  broad: { label: "Broad screen", gates: [
    defaultGate("land", { types: LAND_TYPES.map(t => t.key), minHa: 0.25 }),
    defaultGate("constraints", { mode: "filter", exclude: ["in_mol", "sinc_major", "flood3"] }),
    defaultGate("z1", { mode: "score" }),
    defaultGate("ptal", { mode: "score" }),
    defaultGate("conn", { mode: "score" }),
    defaultGate("resi", { mode: "score" }),
    defaultGate("growth", { mode: "score" }),
    defaultGate("office"), defaultGate("walk"), defaultGate("price"), defaultGate("headroom"),
    defaultGate("policy"), defaultGate("borough"),
  ] },
};

const clone = o => JSON.parse(JSON.stringify(o));

export function initLondonSift(deps) {
  const { map, getSupabase, mmStore, escape, overlayBeforeId } = deps;
  const root = document.getElementById("ls-root");
  if (!root) return null;

  const LS = {
    active: false,
    rows: null,           // all sites
    byId: new Map(),
    sorted: {},           // metric -> sorted non-null values (for percentiles)
    boroughs: [],
    result: null,         // { survivors: [{r, s}], funnel: [...] }
    showOut: mmStore.get("londonSift.showOut", false),
    gates: null,
    preset: mmStore.get("londonSift.preset", "balanced"),
    outlines: null,       // id -> simplified GeoJSON geometry (all sites, loaded once)
  };
  const saved = mmStore.get("londonSift.gates", null);
  LS.gates = Array.isArray(saved) && saved.length ? mergeSaved(saved) : clone(PRESETS[LS.preset]?.gates || PRESETS.balanced.gates);

  // Keep saved configs valid as the catalogue grows: drop unknown gates, add
  // new ones (Off) at the end.
  function mergeSaved(list) {
    const out = list.filter(g => GATE_DEFS[g.key]).map(g => Object.assign(defaultGate(g.key), g));
    for (const k of Object.keys(GATE_DEFS))
      if (!out.some(g => g.key === k)) out.push(defaultGate(k));
    return out;
  }
  // Per-viewer panel layout, kept apart from the gate settings so presets
  // and "Reset" never undo it: which cards are minimised, which are hidden.
  // A hidden gate is not applied at all (it would otherwise change the
  // results from somewhere the viewer can no longer see).
  const ui = Object.assign({ collapsed: {}, hidden: {} }, mmStore.get("londonSift.ui", {}));
  const saveUi = () => mmStore.set("londonSift.ui", ui);
  const isHidden = g => !!ui.hidden[g.key];
  const effMode = g => isHidden(g) ? "off" : g.mode;

  const persist = () => {
    mmStore.set("londonSift.gates", LS.gates);
    mmStore.set("londonSift.preset", LS.preset);
  };

  root.innerHTML = `
    <p class="hint">Sift every candidate plot in Greater London — brownfield, underused built land, green space and grey belt — down to the well-connected, marketable ones. Each gate can <b>filter</b> (a hard cut), <b>score</b> (counts toward the ranking) or be off. Drag gates to reorder: the funnel reads top to bottom, and higher gates weigh more in the ranking.</p>
    <label class="dd-row dd-row-all">
      <input type="checkbox" id="ls-activate" />
      <span class="dd-label"><strong>Activate the London sift</strong></span>
      <span class="dd-stat" id="ls-status"></span>
    </label>
    <div id="ls-controls" hidden>
      <div class="ls-presets" role="group" aria-label="Presets">
        ${Object.entries(PRESETS).map(([k, p]) =>
          `<button type="button" class="ls-preset" data-preset="${k}">${p.label}</button>`).join("")}
      </div>
      <div class="ls-gatebar">
        <button type="button" class="ls-link" id="ls-collapse-all">Minimise all</button>
        <button type="button" class="ls-link" id="ls-expand-all">Expand all</button>
      </div>
      <div id="ls-gates" class="ls-gates"></div>
      <div id="ls-hidden" class="ls-hidden"></div>
      <div class="dc-sec">Result</div>
      <div id="ls-summary" class="ls-summary"></div>
      <div class="ls-opts">
        <label class="dc-check-row"><input type="checkbox" id="ls-showout" /> <span>Show eliminated sites (grey)</span></label>
      </div>
      <div id="ls-list" class="ls-list"></div>
      <div class="pf-actions">
        <button type="button" id="ls-export">Export CSV</button>
        <button type="button" class="ghost" id="ls-reset">Reset to preset</button>
      </div>
      <p class="hint ls-foot">Sources: MHCLG brownfield registers, OpenStreetMap, OS Open Greenspace, TfL (PTAL, timetables), DfT connectivity metric, ONS private rents, VOA rating list, agent office reports, HM Land Registry, planning.data.gov.uk, GLA planning data map (Opportunity Areas, SIL, LSIS, MOL), GiGL (SINCs). Borough-level figures (rents, approval rate, plan supply) apply to every site in the borough.</p>
    </div>`;

  const $ = id => document.getElementById(id);
  const act = $("ls-activate");
  act.addEventListener("change", () => {
    $("ls-controls").hidden = !act.checked;
    activate(act.checked);
  });
  root.querySelectorAll(".ls-preset").forEach(b => b.addEventListener("click", () => {
    LS.preset = b.dataset.preset;
    LS.gates = clone(PRESETS[LS.preset].gates);
    persist(); renderGates(); run();
  }));
  $("ls-collapse-all").addEventListener("click", () => {
    for (const g of LS.gates) ui.collapsed[g.key] = true;
    saveUi(); renderGates();
  });
  $("ls-expand-all").addEventListener("click", () => {
    ui.collapsed = {}; saveUi(); renderGates();
  });
  $("ls-reset").addEventListener("click", () => {
    LS.gates = clone(PRESETS[LS.preset]?.gates || PRESETS.balanced.gates);
    persist(); renderGates(); run();
  });
  $("ls-showout").checked = LS.showOut;
  $("ls-showout").addEventListener("change", e => {
    LS.showOut = e.target.checked;
    mmStore.set("londonSift.showOut", LS.showOut);
    paintShapes();
    applyLayerVisibility();
  });
  $("ls-export").addEventListener("click", exportCsv);

  // ── data ─────────────────────────────────────────────────────────────
  async function load() {
    if (LS.rows) return LS.rows;
    const sb = getSupabase();
    if (!sb) throw new Error("database not configured");
    const page = 1000, rows = [];
    for (let batch = 0; ; batch += 4) {
      const reqs = [];
      for (let i = batch; i < batch + 4; i++)
        reqs.push(sb.rpc("london_sites_all").order("id", { ascending: true })
          .range(i * page, (i + 1) * page - 1));
      const res = await Promise.all(reqs);
      let done = false;
      for (const { data, error } of res) {
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < page) done = true;
      }
      $("ls-status").textContent = `loading… ${rows.length.toLocaleString()}`;
      if (done) break;
    }
    LS.rows = rows;
    for (const r of rows) LS.byId.set(r.id, r);
    for (const [k, m] of Object.entries(METRICS)) {
      LS.sorted[k] = rows.map(m.get).filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
    }
    LS.boroughs = [...new Set(rows.map(r => r.borough).filter(Boolean))].sort();
    return rows;
  }

  // Percentile of v within the whole London pool, oriented so 1 = best.
  function pct(metric, v) {
    const arr = LS.sorted[metric];
    if (v == null || !arr || !arr.length) return null;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    let lo2 = lo, hi2 = arr.length;
    while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (arr[mid] <= v) lo2 = mid + 1; else hi2 = mid; }
    const p = ((lo + lo2) / 2) / arr.length;
    return METRICS[metric].dir > 0 ? p : 1 - p;
  }

  // ── gate logic ───────────────────────────────────────────────────────
  function passes(g, r) {
    const d = GATE_DEFS[g.key];
    if (d.special === "land") {
      if (!g.types.includes(r.src)) return false;
      if ((r.area_ha || 0) < g.minHa) return false;
      if (r.src === "green_space" && g.greenExclude.includes(r.subtype)) return false;
      if (g.excludeBuilding && isBuilding(r)) return false;
      if (g.excludePermissioned && isPermissioned(r)) return false;
      return true;
    }
    if (d.special === "constraints") {
      for (const k of g.exclude) {
        if (constraintHit(k, r)) return false;
      }
      return true;
    }
    if (d.special === "policy") {
      if (!g.require.length) return true;
      return g.require.some(k => r[k]);
    }
    if (d.special === "borough") {
      return !g.boroughs.length || g.boroughs.includes(r.borough);
    }
    const m = METRICS[g.metric];
    if (m.ptal) {
      if (!r.ptal) return g.keepMissing;
      return PTAL_LEVELS.indexOf(r.ptal) >= PTAL_LEVELS.indexOf(String(g.value));
    }
    const v = m.get(r);
    if (v == null || Number.isNaN(v)) return g.keepMissing;
    return m.dir > 0 ? v >= g.value : v <= g.value;
  }

  function run() {
    if (!LS.rows) return;
    let pool = LS.rows.filter(r => r.lng != null);
    const start = pool.length;
    const funnel = [];
    // "Show" on a gate stops the map and list at that stage: later gates
    // neither filter nor score, and the sites this gate removed are kept
    // aside so the map can mark them.
    let stageI = LS.stageKey ? LS.gates.findIndex(g => g.key === LS.stageKey && !isHidden(g)) : -1;
    if (stageI < 0) LS.stageKey = null;
    let shown = null, cut = [];
    LS.gates.forEach((g, i) => {
      if (effMode(g) === "filter") {
        const before = pool.length, kept = [], dropped = [];
        for (const r of pool) (passes(g, r) ? kept : dropped).push(r);
        pool = kept;
        funnel[i] = { before, after: pool.length };
        if (i === stageI) cut = dropped;
      } else funnel[i] = null;
      if (i === stageI) shown = pool;
    });
    const finalN = pool.length;
    if (shown) pool = shown;
    // Ranking: scoring gates (filter or score, with a metric), weighted by
    // their position among themselves — first counts most. At a stage, only
    // the gates up to it count.
    const upto = stageI >= 0 ? LS.gates.slice(0, stageI + 1) : LS.gates;
    const scorers = upto.filter(g => effMode(g) !== "off" && GATE_DEFS[g.key].metrics);
    const n = scorers.length;
    const survivors = pool.map(r => {
      let num = 0, den = 0;
      scorers.forEach((g, i) => {
        const p = pct(g.metric, METRICS[g.metric].get(r));
        if (p == null) return;
        const w = n - i;
        num += w * p; den += w;
      });
      return { r, s: den ? Math.round(100 * num / den) : 0 };
    }).sort((a, b) => b.s - a.s || (b.r.area_ha || 0) - (a.r.area_ha || 0));
    LS.result = { start, survivors, funnel, scorers, finalN, stageI,
                  cut: new Set(cut.map(r => r.id)) };
    renderFunnel();
    renderSummary();
    renderList();
    renderMap();
  }

  // ── gates UI ─────────────────────────────────────────────────────────
  const gatesEl = $("ls-gates");
  let dragFrom = null;
  gatesEl.addEventListener("click", e => {
    const b = e.target.closest(".ls-show");
    if (!b) return;
    LS.stageKey = LS.stageKey === b.dataset.stage ? null : b.dataset.stage;
    run();
  });

  function renderGates() {
    root.querySelectorAll(".ls-preset").forEach(b =>
      b.classList.toggle("on", b.dataset.preset === LS.preset));
    const vis = LS.gates.map((g, i) => i).filter(i => !isHidden(LS.gates[i]));
    gatesEl.innerHTML = vis.map((i, k) => gateHTML(LS.gates[i], i, k === 0, k === vis.length - 1)).join("");
    gatesEl.querySelectorAll(".ls-gate").forEach(el => wireGate(el));
    renderHiddenTray();
    renderFunnel();
  }

  // Tray of hidden gates, each one click from coming back.
  function renderHiddenTray() {
    const el = $("ls-hidden");
    const hid = LS.gates.filter(isHidden);
    if (!hid.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<span class="hint">Hidden (not applied):</span> ` + hid.map(g =>
      `<button type="button" class="ls-chip-btn" data-show="${g.key}" title="Show this gate again">+ ${escape(GATE_DEFS[g.key].title)}</button>`).join("");
    el.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", () => {
      delete ui.hidden[b.dataset.show]; saveUi(); renderGates(); run();
    }));
  }

  // One-line reading of a gate's setting, shown in the header when minimised.
  function gateSummary(g) {
    const d = GATE_DEFS[g.key];
    if (d.special === "land") return `${g.types.length} land types · ≥ ${g.minHa.toFixed(2)} ha`;
    if (d.special === "constraints") return g.exclude.length ? `excludes ${g.exclude.length}` : "none excluded";
    if (d.special === "policy") return g.require.length ? `${g.require.length} area type${g.require.length > 1 ? "s" : ""}` : "any";
    if (d.special === "borough") return g.boroughs.length ? `${g.boroughs.length} borough${g.boroughs.length > 1 ? "s" : ""}` : "all London";
    const m = METRICS[g.metric];
    if (m.ptal) return `PTAL ${g.value}+`;
    return `${m.dir > 0 ? "≥" : "≤"} ${m.fmt(Number(g.value))}`;
  }

  function gateHTML(g, i, first, last) {
    const collapsed = !!ui.collapsed[g.key];
    const d = GATE_DEFS[g.key];
    const modeSel = `<select class="ls-mode" aria-label="Gate mode">
        <option value="filter"${g.mode === "filter" ? " selected" : ""}>Filter</option>
        ${d.metrics ? `<option value="score"${g.mode === "score" ? " selected" : ""}>Score</option>` : ""}
        <option value="off"${g.mode === "off" ? " selected" : ""}>Off</option>
      </select>`;
    return `<div class="ls-gate ls-mode-${g.mode}${collapsed ? " ls-collapsed" : ""}" draggable="true" data-i="${i}">
      <div class="ls-gate-h">
        <span class="ls-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <button type="button" class="ls-fold" aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Minimise"}">
          <span class="ls-caret" aria-hidden="true">▾</span>
          <span class="ls-gate-t">${escape(d.title)}</span>
          ${collapsed && g.mode !== "off" ? `<span class="ls-sum">${escape(gateSummary(g))}</span>` : ""}
        </button>
        ${modeSel}
        <span class="ls-move">
          <button type="button" class="ls-up" aria-label="Move up"${first ? " disabled" : ""}>↑</button>
          <button type="button" class="ls-down" aria-label="Move down"${last ? " disabled" : ""}>↓</button>
          <button type="button" class="ls-hide" aria-label="Hide this gate" title="Hide (stops applying it)">✕</button>
        </span>
      </div>
      <div class="ls-gate-b"${g.mode === "off" || collapsed ? " hidden" : ""}>${gateBodyHTML(g)}
        <details class="ls-about"><summary>About</summary><p>${escape(d.about)}</p></details>
      </div>
      <div class="ls-gate-f"></div>
    </div>`;
  }

  function gateBodyHTML(g) {
    const d = GATE_DEFS[g.key];
    if (d.special === "land") {
      const types = LAND_TYPES.map(t => `<label><input type="checkbox" data-type="${t.key}"${g.types.includes(t.key) ? " checked" : ""} />
          <i class="ls-sw" style="background:${CAT_COLOR[t.cat]}"></i>${escape(t.label)}</label>`).join("");
      const greenOn = g.types.includes("green_space");
      const greens = ["Public Park Or Garden", "Playing Field", "Other Sports Facility", "Golf Course",
                      "Allotments Or Community Growing Spaces", "Play Space", "Cemetery", "Religious Grounds",
                      "Bowling Green", "Tennis Court"]
        .map(f => `<label><input type="checkbox" data-green="${escape(f)}"${g.greenExclude.includes(f) ? "" : " checked"} />${escape(f)}</label>`).join("");
      return `<div class="dc-checks ls-types">${types}</div>
        <details class="ls-green"${greenOn ? "" : " hidden"}><summary>Green-space types included</summary><div class="dc-checks">${greens}</div></details>
        <label class="dc-check-row"><input type="checkbox" class="ls-exbuild"${g.excludeBuilding ? " checked" : ""} />
          <span>Exclude sites already under construction</span></label>
        <label class="dc-check-row"><input type="checkbox" class="ls-experm"${g.excludePermissioned ? " checked" : ""} />
          <span>Exclude register sites that already have permission</span></label>
        <label class="pbsa-crit"><span>Min site size</span>
          <input type="range" class="ls-minha" min="0.05" max="5" step="0.05" value="${g.minHa}" />
          <span class="pbsa-crit-val">${g.minHa.toFixed(2)} ha</span></label>`;
    }
    if (d.special === "constraints") {
      return `<div class="hint ls-sub">Remove sites in or on:</div><div class="dc-checks">` + CONSTRAINT_OPTS.map(o =>
        `<label><input type="checkbox" data-ex="${o.key}"${g.exclude.includes(o.key) ? " checked" : ""} />${o.label}</label>`).join("") + `</div>`;
    }
    if (d.special === "policy") {
      return `<div class="hint ls-sub">Keep sites in any of:</div><div class="dc-checks">` + POLICY_OPTS.map(o =>
        `<label><input type="checkbox" data-req="${o.key}"${g.require.includes(o.key) ? " checked" : ""} />${o.label}</label>`).join("") + `</div>`;
    }
    if (d.special === "borough") {
      const opts = (LS.boroughs.length ? LS.boroughs : g.boroughs).map(b =>
        `<option${g.boroughs.includes(b) ? " selected" : ""}>${escape(b)}</option>`).join("");
      return `<select class="ls-boroughs" multiple size="6">${opts}</select>
        <div class="hint">Ctrl/⌘-click to pick several. None selected = all London.</div>`;
    }
    const m = METRICS[g.metric];
    const metricSel = d.metrics.length > 1
      ? `<select class="ls-metric">${d.metrics.map(k => `<option value="${k}"${k === g.metric ? " selected" : ""}>${escape(METRICS[k].label)}</option>`).join("")}</select>`
      : "";
    const cmp = m.dir > 0 ? "At least" : "At most";
    const ctl = m.ptal
      ? `<select class="ls-ptal">${PTAL_LEVELS.map(l => `<option${String(g.value) === l ? " selected" : ""}>${l}</option>`).join("")}</select>
         <span class="pbsa-crit-val">PTAL ${escape(String(g.value))}+</span>`
      : `<input type="range" class="ls-val" min="${m.min}" max="${m.max}" step="${m.step}" value="${g.value}" />
         <span class="pbsa-crit-val">${escape(m.fmt(Number(g.value)))}</span>`;
    return `${metricSel}
      <label class="pbsa-crit ls-thr"><span>${cmp}</span>${ctl}</label>
      <label class="dc-check-row ls-keep"><input type="checkbox" class="ls-keepmissing"${g.keepMissing ? " checked" : ""} />
        <span>Keep sites with no data</span></label>
      <div class="hint ls-dist"></div>`;
  }

  function wireGate(el) {
    const i = Number(el.dataset.i);
    const g = LS.gates[i];
    const changed = (rerender = false) => { LS.preset = "custom"; persist(); if (rerender) renderGates(); run(); };
    el.querySelector(".ls-mode").addEventListener("change", e => { g.mode = e.target.value; changed(true); });
    const neighbour = step => {
      for (let j = i + step; j >= 0 && j < LS.gates.length; j += step)
        if (!isHidden(LS.gates[j])) return j;
      return -1;
    };
    el.querySelector(".ls-up").addEventListener("click", () => move(i, neighbour(-1)));
    el.querySelector(".ls-down").addEventListener("click", () => move(i, neighbour(1)));
    el.querySelector(".ls-fold").addEventListener("click", () => {
      if (ui.collapsed[g.key]) delete ui.collapsed[g.key]; else ui.collapsed[g.key] = true;
      saveUi(); renderGates();
    });
    el.querySelector(".ls-hide").addEventListener("click", () => {
      ui.hidden[g.key] = true; saveUi(); renderGates(); run();
    });
    // Drag and drop (desktop); the arrows cover touch.
    el.addEventListener("dragstart", e => {
      if (!e.target.classList || !e.target.classList.contains("ls-gate")) return;
      dragFrom = i; el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(i)); } catch (_) {}
    });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); dragFrom = null;
      gatesEl.querySelectorAll(".drop-over").forEach(x => x.classList.remove("drop-over")); });
    el.addEventListener("dragover", e => { if (dragFrom == null) return; e.preventDefault(); el.classList.add("drop-over"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-over"));
    el.addEventListener("drop", e => { e.preventDefault(); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); });
    // Inputs inside a draggable card must not start a drag.
    el.querySelectorAll("input, select, details, button").forEach(c => {
      c.addEventListener("mousedown", () => { el.draggable = false; });
      c.addEventListener("mouseup", () => { el.draggable = true; });
      c.addEventListener("blur", () => { el.draggable = true; });
    });

    const d = GATE_DEFS[g.key];
    if (d.special === "land") {
      el.querySelectorAll("[data-type]").forEach(cb => cb.addEventListener("change", () => {
        const k = cb.dataset.type;
        g.types = cb.checked ? [...new Set([...g.types, k])] : g.types.filter(t => t !== k);
        const gd = el.querySelector(".ls-green"); if (gd) gd.hidden = !g.types.includes("green_space");
        changed();
      }));
      el.querySelectorAll("[data-green]").forEach(cb => cb.addEventListener("change", () => {
        const f = cb.dataset.green;
        g.greenExclude = cb.checked ? g.greenExclude.filter(x => x !== f) : [...new Set([...g.greenExclude, f])];
        changed();
      }));
      el.querySelector(".ls-exbuild").addEventListener("change", e => { g.excludeBuilding = e.target.checked; changed(); });
      el.querySelector(".ls-experm").addEventListener("change", e => { g.excludePermissioned = e.target.checked; changed(); });
      const r = el.querySelector(".ls-minha");
      r.addEventListener("input", () => { g.minHa = Number(r.value); r.nextElementSibling.textContent = `${g.minHa.toFixed(2)} ha`; changedSoon(); });
      return;
    }
    if (d.special === "constraints") {
      el.querySelectorAll("[data-ex]").forEach(cb => cb.addEventListener("change", () => {
        const k = cb.dataset.ex;
        g.exclude = cb.checked ? [...new Set([...g.exclude, k])] : g.exclude.filter(x => x !== k);
        changed();
      }));
      return;
    }
    if (d.special === "policy") {
      el.querySelectorAll("[data-req]").forEach(cb => cb.addEventListener("change", () => {
        const k = cb.dataset.req;
        g.require = cb.checked ? [...new Set([...g.require, k])] : g.require.filter(x => x !== k);
        changed();
      }));
      return;
    }
    if (d.special === "borough") {
      const s = el.querySelector(".ls-boroughs");
      s.addEventListener("change", () => { g.boroughs = [...s.selectedOptions].map(o => o.value); changed(); });
      return;
    }
    const ms = el.querySelector(".ls-metric");
    if (ms) ms.addEventListener("change", () => {
      g.metric = ms.value; g.value = METRICS[g.metric].def; changed(true);
    });
    const pt = el.querySelector(".ls-ptal");
    if (pt) pt.addEventListener("change", () => {
      g.value = pt.value; pt.nextElementSibling.textContent = `PTAL ${g.value}+`; changed();
    });
    const v = el.querySelector(".ls-val");
    if (v) v.addEventListener("input", () => {
      g.value = Number(v.value);
      v.nextElementSibling.textContent = METRICS[g.metric].fmt(g.value);
      changedSoon();
    });
    el.querySelector(".ls-keepmissing").addEventListener("change", e => { g.keepMissing = e.target.checked; changed(); });
  }

  let _soon = null;
  function changedSoon() {
    LS.preset = "custom";
    root.querySelectorAll(".ls-preset").forEach(b => b.classList.remove("on"));
    clearTimeout(_soon);
    _soon = setTimeout(() => { persist(); run(); }, 120);
  }

  function move(from, to) {
    if (to < 0 || to >= LS.gates.length) return;
    const [g] = LS.gates.splice(from, 1);
    LS.gates.splice(to, 0, g);
    LS.preset = "custom";
    persist(); renderGates(); run();
  }

  // Per-gate funnel line + where the pool sits on this measure.
  function renderFunnel() {
    const res = LS.result;
    gatesEl.querySelectorAll(".ls-gate").forEach(el => {
      const i = Number(el.dataset.i);
      const g = LS.gates[i];
      const f = el.querySelector(".ls-gate-f");
      if (!res || !f) { if (f) f.innerHTML = ""; return; }
      const fr = res.funnel[i];
      const rank = res.scorers.indexOf(g);
      let html = "";
      if (fr) {
        const w = res.start ? (100 * fr.after / res.start) : 0;
        const cut = fr.before - fr.after;
        html += `<div class="ls-bar"><i style="width:${w.toFixed(1)}%"></i></div>
          <span class="ls-fn">${cut ? `−${fmtInt(cut)} · ` : ""}<b>${fmtInt(fr.after)}</b> left</span>`;
      }
      if (rank >= 0) {
        const n = res.scorers.length;
        const wPct = Math.round(100 * (n - rank) / (n * (n + 1) / 2));
        html += `<span class="ls-w" title="Share of the ranking score">weight ${wPct}%</span>`;
      }
      const on = res.stageI === i;
      html += `<button type="button" class="ls-show${on ? " on" : ""}" data-stage="${g.key}"
        title="${on ? "Back to the full sift" : "Show the map and list as they stand after this gate, ignoring the gates below it"}">${on ? "Showing ✓" : "Show"}</button>`;
      f.innerHTML = html;
      el.classList.toggle("ls-staged", on);
      el.classList.toggle("ls-after", res.stageI >= 0 && i > res.stageI);
      const dist = el.querySelector(".ls-dist");
      if (dist && g.metric && LS.sorted[g.metric]?.length) {
        const a = LS.sorted[g.metric], m = METRICS[g.metric];
        const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
        dist.textContent = m.ptal ? "" :
          `London range: ${m.fmt(q(0.1))} (10th pct) · ${m.fmt(q(0.5))} (median) · ${m.fmt(q(0.9))} (90th) · ${fmtInt(a.length)} sites with data`;
      }
    });
  }

  function renderSummary() {
    const el = $("ls-summary");
    const { survivors, start } = LS.result;
    const ha = survivors.reduce((t, x) => t + (x.r.area_ha || 0), 0);
    const byCat = {};
    for (const { r } of survivors) byCat[r.cat] = (byCat[r.cat] || 0) + 1;
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      `<span class="ls-chip"><i class="ls-sw" style="background:${CAT_COLOR[c]}"></i>${CAT_LABEL[c] || c} <b>${fmtInt(n)}</b></span>`).join("");
    const byB = {};
    for (const { r } of survivors) if (r.borough) byB[r.borough] = (byB[r.borough] || 0) + 1;
    const tops = Object.entries(byB).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([b, n]) => `${escape(b)} <b>${n}</b>`).join(" · ");
    const { stageI, finalN, cut } = LS.result;
    const banner = stageI >= 0 ? `<div class="ls-stage-banner">
        <span>Showing the sift up to <b>${escape(GATE_DEFS[LS.gates[stageI].key].title)}</b>${cut.size ? ` — its ${fmtInt(cut.size)} removed sites are the grey rings` : ""}. The full sift leaves ${fmtInt(finalN)}.</span>
        <button type="button" class="ls-link" id="ls-stage-clear">Show full sift</button></div>` : "";
    el.innerHTML = banner + `<div class="dc-headline"><b>${fmtInt(survivors.length)}</b> sites · <b>${fmtInt(ha)}</b> ha
        <span class="hint">of ${fmtInt(start)} candidates</span></div>
      <div class="ls-chips">${cats}</div>
      <div class="ls-legend" aria-label="Map colour key">
        <span>Score</span>
        <i class="ls-ramp" style="background:linear-gradient(90deg, ${RAMP_STOPS.map(([v, c]) => `${c} ${v}%`).join(", ")})"></i>
        <span>best</span>
        <span class="ls-legend-top"><i>1</i> top ${TOP_N} ranked</span>
      </div>
      ${tops ? `<div class="hint">Top boroughs: ${tops}</div>` : ""}`;
    const clr = $("ls-stage-clear");
    if (clr) clr.addEventListener("click", () => { LS.stageKey = null; run(); });
  }

  function renderList() {
    const el = $("ls-list");
    const top = LS.result.survivors.slice(0, 60);
    if (!top.length) { el.innerHTML = `<p class="hint">No sites pass every filter — relax a gate or switch one to Score.</p>`; return; }
    el.innerHTML = `<table class="sift-table ls-table"><thead><tr>
        <th>#</th><th>Site</th><th title="Ranking score, 0–100">Score</th><th>PTAL</th><th title="Door to Zone 1">Z1</th></tr></thead><tbody>
      ${top.map(({ r, s }, i) => `<tr data-id="${r.id}">
        <td>${i + 1}</td>
        <td><i class="ls-sw" style="background:${CAT_COLOR[r.cat]}"></i>${escape(siteName(r))}
          <small>${escape(r.borough || "")} · ${(r.area_ha || 0).toFixed(2)} ha · ${escape(typeLabel(r))}</small></td>
        <td><b>${s}</b></td><td>${escape(r.ptal || "–")}</td>
        <td>${r.z1_min != null ? Math.round(r.z1_min) + "′" : "–"}</td></tr>`).join("")}
      </tbody></table>
      ${LS.result.survivors.length > top.length ? `<p class="hint">Top ${top.length} of ${fmtInt(LS.result.survivors.length)} shown — export for the full list.</p>` : ""}`;
    el.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => {
      const r = LS.byId.get(Number(tr.dataset.id));
      if (!r) return;
      map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 15.5) });
      openCard(r);
    }));
  }

  function siteName(r) {
    if (r.name && r.name.trim()) return r.name.length > 60 ? r.name.slice(0, 57) + "…" : r.name;
    return `Unnamed — ${typeLabel(r).toLowerCase()}`;
  }
  function typeLabel(r) {
    const t = LAND_TYPES.find(t => t.key === r.src);
    if (r.src === "green_space" && r.subtype) return r.subtype;
    return t ? t.label : r.src;
  }

  // ── map ──────────────────────────────────────────────────────────────
  const S = ["coalesce", ["get", "s"], -1];
  // Every stop is saturated enough to read on the pale basemap — the old ramp
  // opened at a near-white peach, so most sites vanished into the map.
  // Low scores stay a clear orange; the best sites run to deep red.
  // Kept in the orange-red family: purples would read as the station dots.
  const RAMP_STOPS = [[0, "#ffa94d"], [40, "#fd7e14"], [65, "#e8590c"], [85, "#c92a2a"], [100, "#7a1212"]];
  const SCORE_RAMP = ["interpolate", ["linear"], S, ...RAMP_STOPS.flat()];
  const TOP_N = 25;          // ranked sites that get a number on the map
  // A site's dot fades out once its outline is big enough to read (roughly
  // ~3 px across): 2 ha plots at z11, 0.5 ha at z12, 0.12 ha at z13, the rest
  // by z14. Small plots keep a dot until then, so nothing disappears.
  const HA = ["coalesce", ["get", "ha"], 0];
  // (A zoom curve must be the outermost expression, so the stroke gets its own
  // copy scaled inside rather than a multiplied one.)
  const dotFade = (on) => ["interpolate", ["linear"], ["zoom"],
    10.5, on,
    11.3, ["case", [">=", HA, 2], 0, on],
    12.2, ["case", [">=", HA, 0.5], 0, on],
    13.1, ["case", [">=", HA, 0.12], 0, on],
    13.9, ["case", [">=", HA, 0.04], 0, on]];

  function pointsFc() {
    const scoreOf = new Map(LS.result.survivors.map(x => [x.r.id, x.s]));
    const rankOf = new Map(LS.result.survivors.slice(0, TOP_N).map((x, i) => [x.r.id, i + 1]));
    return { type: "FeatureCollection", features: LS.rows.filter(r => r.lng != null).map(r => ({
      type: "Feature", id: r.id,
      properties: { id: r.id, s: scoreOf.has(r.id) ? scoreOf.get(r.id) : LS.result.cut.has(r.id) ? -2 : -1,
                    ha: r.area_ha || 0,
                    rank: rankOf.get(r.id) || 0 },
      geometry: { type: "Point", coordinates: [r.lng, r.lat] } })) };
  }

  function ensureLayers() {
    const before = overlayBeforeId();
    if (!map.getSource("ls-pts")) map.addSource("ls-pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!map.getSource("ls-shp")) map.addSource("ls-shp", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Plot outlines from z11. Removed-by-this-gate plots (s = -2) are hollow.
    if (!map.getLayer("ls-shp-fill")) map.addLayer({ id: "ls-shp-fill", type: "fill", source: "ls-shp", minzoom: 11,
      paint: { "fill-color": ["case", ["<", S, 0], "#868e96", SCORE_RAMP],
               "fill-opacity": ["case", ["==", S, -2], 0.04, ["<", S, 0], 0.15, 0.65] } }, before);
    if (!map.getLayer("ls-shp-line")) map.addLayer({ id: "ls-shp-line", type: "line", source: "ls-shp", minzoom: 11,
      paint: { "line-color": ["case", ["<", S, 0], "#868e96", SCORE_RAMP],
               "line-opacity": ["case", ["==", S, -2], 0.6, 1],
               "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 13, 1.5, 17, 3] } }, before);
    // Site dots sit on top of every other layer (stations included): while the
    // sift is on, the sites are the subject.
    if (!map.getLayer("ls-pts-out")) map.addLayer({ id: "ls-pts-out", type: "circle", source: "ls-pts",
      filter: ["==", S, -1], maxzoom: 14,
      paint: { "circle-color": "#868e96", "circle-opacity": 0.35,
               "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 13, 3] } });
    // Sites removed by the gate being shown ("Show" on a gate): hollow rings,
    // so its impact reads against what survives.
    if (!map.getLayer("ls-pts-cut")) map.addLayer({ id: "ls-pts-cut", type: "circle", source: "ls-pts",
      filter: ["==", S, -2], maxzoom: 14,
      paint: { "circle-color": "rgba(0,0,0,0)",
               "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 11, 4.5, 13.9, 6],
               "circle-stroke-color": "#495057", "circle-stroke-width": 1, "circle-stroke-opacity": 0.5 } });
    if (!map.getLayer("ls-pts-in")) {
      map.addLayer({ id: "ls-pts-in", type: "circle", source: "ls-pts",
        filter: [">=", S, 0], maxzoom: 14,
        layout: { "circle-sort-key": S },   // best sites drawn last, on top
        paint: { "circle-color": SCORE_RAMP,
                 "circle-radius": ["interpolate", ["linear"], ["zoom"],
                   8, ["interpolate", ["linear"], ["coalesce", ["get", "ha"], 0], 0, 3, 5, 5, 50, 8],
                   11, ["interpolate", ["linear"], ["coalesce", ["get", "ha"], 0], 0, 4, 5, 7, 50, 11],
                   13.9, ["interpolate", ["linear"], ["coalesce", ["get", "ha"], 0], 0, 4.5, 5, 7, 50, 9]],
                 "circle-stroke-color": "#212529",
                 "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 13, 1.2],
                 "circle-stroke-opacity": dotFade(0.75),
                 "circle-opacity": dotFade(1) } });
      // Top-ranked sites: a white halo ring plus their rank number, so the
      // shortlist in the panel can be found on the map at a glance.
      map.addLayer({ id: "ls-pts-top", type: "circle", source: "ls-pts",
        filter: [">", ["coalesce", ["get", "rank"], 0], 0], maxzoom: 17,
        paint: { "circle-color": "#1f1f1f",
                 "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 8, 13, 11],
                 "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      map.addLayer({ id: "ls-pts-rank", type: "symbol", source: "ls-pts",
        filter: [">", ["coalesce", ["get", "rank"], 0], 0], maxzoom: 17,
        layout: { "text-field": ["to-string", ["get", "rank"]],
                  "text-font": ["Noto Sans Bold"], "text-size": 11,
                  "text-allow-overlap": true, "text-ignore-placement": true,
                  "symbol-sort-key": ["get", "rank"] },
        paint: { "text-color": "#fff" } });
      for (const id of ["ls-pts-in", "ls-pts-top", "ls-shp-fill"]) {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      }
    }
  }

  function applyLayerVisibility() {
    const vis = on => on ? "visible" : "none";
    if (map.getLayer("ls-pts-out")) map.setLayoutProperty("ls-pts-out", "visibility", vis(LS.active && LS.showOut));
    for (const id of ["ls-pts-in", "ls-pts-cut", "ls-pts-top", "ls-pts-rank", "ls-shp-fill", "ls-shp-line"])
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(LS.active));
    if (LS.active && map.getLayer("ls-shp-fill")) {
      const f = LS.showOut ? null : [">=", S, -2];
      map.setFilter("ls-shp-fill", f); map.setFilter("ls-shp-line", f);
    }
  }

  function renderMap() {
    if (!LS.active || !LS.result) return;
    ensureLayers();
    map.getSource("ls-pts").setData(pointsFc());
    paintShapes();
    applyLayerVisibility();
  }

  // Outlines for the sites currently in play: survivors, plus the plots the
  // shown gate removed, plus everything else when "show eliminated" is on.
  function paintShapes() {
    const src = map.getSource("ls-shp");
    if (!src || !LS.outlines || !LS.result) return;
    const feats = [];
    const push = (id, s) => {
      const g = LS.outlines.get(id);
      if (g) feats.push({ type: "Feature", id, properties: { id, s }, geometry: g });
    };
    for (const { r, s } of LS.result.survivors) push(r.id, s);
    for (const id of LS.result.cut) push(id, -2);
    if (LS.showOut) {
      const inPlay = new Set([...LS.result.survivors.map(x => x.r.id), ...LS.result.cut]);
      for (const id of LS.outlines.keys()) if (!inPlay.has(id)) push(id, -1);
    }
    src.setData({ type: "FeatureCollection", features: feats });
  }

  // Every outline, once, in the background after the sites arrive (~5 MB
  // uncompressed, paged because PostgREST caps a response at 1,000 rows).
  async function loadOutlines() {
    if (LS.outlines) return;
    const sb = getSupabase(); if (!sb) return;
    const page = 1000, out = new Map();
    for (let batch = 0; ; batch += 4) {
      const res = await Promise.all([0, 1, 2, 3].map(k =>
        sb.rpc("london_site_outlines").order("id", { ascending: true })
          .range((batch + k) * page, (batch + k + 1) * page - 1)));
      let done = false;
      for (const { data, error } of res) {
        if (error) { console.error("london_site_outlines failed", error); return; }
        for (const row of data || []) {
          try { out.set(row.id, JSON.parse(row.outline)); } catch (_) {}
        }
        if (!data || data.length < page) done = true;
      }
      if (done) break;
    }
    LS.outlines = out;
    paintShapes();
  }

  async function activate(on) {
    LS.active = on;
    const st = $("ls-status");
    if (!on) { applyLayerVisibility(); st.textContent = ""; return; }
    try {
      st.textContent = "loading…";
      await load();
      if (!LS.active) return;
      st.textContent = `${fmtInt(LS.rows.length)} sites`;
      renderGates();
      run();
      loadOutlines();
      const b = map.getBounds();
      if (b.getWest() > 0.35 || b.getEast() < -0.52 || b.getSouth() > 51.7 || b.getNorth() < 51.28)
        map.flyTo({ center: [-0.11, 51.5], zoom: 9.6 });
    } catch (err) {
      console.error("London sift load failed", err);
      st.textContent = "unavailable";
    }
  }

  // ── site card ────────────────────────────────────────────────────────
  let popup = null;
  function openCard(r, lngLat) {
    if (popup) popup.remove();
    const s = LS.result?.survivors.find(x => x.r.id === r.id);
    const stat = (v, k) => v == null || v === "" ? "" :
      `<div class="ovp-stat"><div class="ovp-sv">${v}</div><div class="ovp-sk">${escape(k)}</div></div>`;
    const f = (k, v) => v == null ? null : METRICS[k].fmt(v);
    const flags = [
      r.in_oa && `Opportunity Area${r.oa_name ? ": " + r.oa_name : ""}`,
      r.in_sil && "Strategic Industrial Location", r.in_mol && "Metropolitan Open Land",
      r.in_lsis && "Locally Significant Industrial Site",
      r.sinc_grade && `SINC · ${r.sinc_grade.replace(/ importance/i, "")}`,
      r.in_caz && "CAZ", r.in_devcorp && "Development corporation", r.public_land && "Public land",
      r.flood3 && "Flood zone 3", !r.flood3 && r.flood2 && "Flood zone 2", r.conservation && "Conservation area",
      (r.listed_n || 0) > 0 && `${r.listed_n} listed building${r.listed_n > 1 ? "s" : ""}`,
      r.article4 && "Article 4", r.tpo && "TPO", r.aqma && "AQMA",
    ].filter(Boolean);
    const html = `<div class="ovp ovp2 ls-card" style="--ov:${CAT_COLOR[r.cat]}">
      <div class="ovp-kind"><span class="ovp-dot"></span>${escape(CAT_LABEL[r.cat] || r.cat)} — ${escape(typeLabel(r))}</div>
      <div class="ovp-title">${escape(siteName(r))}</div>
      <div class="ovp-note">${escape(r.borough || "")} · ${(r.area_ha || 0).toFixed(2)} ha${r.pdl === false ? " · <b>not previously developed</b>" : ""}
        ${s ? ` · score <b>${s.s}</b> / 100`
          : LS.result?.cut.has(r.id) ? ` · <b>removed by ${escape(GATE_DEFS[LS.gates[LS.result.stageI].key].title)}</b>`
          : ` · <b>eliminated</b>`}</div>
      <div class="ls-card-sec">Access</div>
      <div class="ovp-stats">
        ${stat(r.ptal ? `PTAL ${escape(r.ptal)}` : null, "public transport access")}
        ${stat(f("z1_min", r.z1_min), `to Zone 1${r.z1_via ? " via " + r.z1_via : ""}`)}
        ${stat(r.stn_m != null ? `${fmtInt(r.stn_m)} m` : null, `to ${r.stn_name || "station"}`)}
        ${stat(f("conn_pt", r.conn_pt), "DfT connectivity, PT")}
      </div>
      <div class="ls-card-sec">Market</div>
      <div class="ovp-stats">
        ${stat(f("resi_rent_2b", r.resi_rent_2b), "2-bed rent (borough)")}
        ${stat(f("office_prime", r.office_prime), `prime office${r.office_submkt ? " · " + r.office_submkt : ""}`)}
        ${stat(f("office_voa_pm2", r.office_voa_pm2), `office RV · ${r.office_n || 0} units nearby`)}
        ${stat(f("price_ppm2", r.price_ppm2), "sales £/m²")}
      </div>
      <div class="ls-card-sec">Growth</div>
      <div class="ovp-stats">
        ${stat(f("rent_g5", r.rent_g5), "rent growth, 5 yrs")}
        ${stat(f("price_trend", r.price_trend), "price trend")}
        ${stat(f("approval_pct", r.approval_pct), "planning approvals")}
        ${stat(f("plan_vs_lhn", r.plan_vs_lhn), "plan vs housing need")}
      </div>
      ${r.storeys_ctx != null ? `<div class="ovp-note">Neighbourhood height ~${r.storeys_ctx.toFixed(0)} storeys; site ${r.storeys_site != null ? "~" + r.storeys_site.toFixed(1) : "open / unbuilt"}.</div>` : ""}
      ${r.dwellings_max ? `<div class="ovp-note">Register capacity: up to <b>${fmtInt(r.dwellings_max)}</b> homes${r.permission ? " · " + escape(r.permission) : ""}.</div>` : ""}
      ${flags.length ? `<div class="ls-flags">${flags.map(x => `<span>${escape(x)}</span>`).join("")}</div>` : ""}
    </div>`;
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: "340px" })
      .setLngLat(lngLat || [r.lng, r.lat]).setHTML(html).addTo(map);
  }

  // Called from app.js's tap dispatcher so touch works as well as click.
  function tap(point, box) {
    if (!LS.active || !LS.rows) return false;
    const layers = ["ls-pts-top", "ls-pts-in", "ls-shp-fill", "ls-pts-cut", "ls-pts-out"].filter(id =>
      map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    if (!layers.length) return false;
    let hits = [];
    try { hits = map.queryRenderedFeatures(box, { layers }); } catch (_) {}
    if (!hits.length) return false;
    const id = Number(hits[0].properties.id);
    const r = LS.byId.get(id);
    if (!r) return false;
    openCard(r, map.unproject([point.x, point.y]));
    return true;
  }

  function exportCsv() {
    if (!LS.result) return;
    const cols = ["rank", "score", "id", "name", "borough", "cat", "src", "subtype", "area_ha", "pdl", "lat", "lng",
      "ptal", "ptal_ai", "z1_min", "z1_via", "stn_name", "stn_m", "conn_pt", "conn_emp", "conn_all",
      "resi_rent", "resi_rent_2b", "office_submkt", "office_prime", "office_mid", "office_voa_pm2", "office_n",
      "price_ppm2", "price_trend", "rent_chg", "rent_g5", "approval_pct", "plan_vs_lhn", "land_value", "cil",
      "in_oa", "oa_name", "in_sil", "in_mol", "in_lsis", "sinc_grade", "in_caz", "in_devcorp", "public_land", "article4", "conservation", "listed_n", "flood3", "flood2", "tpo", "aqma",
      "storeys_site", "storeys_ctx", "dwellings_max", "permission"];
    const q = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const lines = [cols.join(",")];
    LS.result.survivors.forEach(({ r, s }, i) =>
      lines.push(cols.map(c => c === "rank" ? i + 1 : c === "score" ? s : q(r[c])).join(",")));
    const gates = LS.gates.filter(g => effMode(g) !== "off").map((g, i) =>
      `${i + 1}. ${GATE_DEFS[g.key].title} [${g.mode}]` + (g.metric ? ` ${METRICS[g.metric].label} ${METRICS[g.metric].dir > 0 ? ">=" : "<="} ${g.value}` : ""));
    const stage = LS.result.stageI >= 0 ? ` — STAGE VIEW up to ${GATE_DEFS[LS.gates[LS.result.stageI].key].title}` : "";
    lines.unshift(`# London sites sift — ${new Date().toISOString().slice(0, 10)}${stage} — ${gates.join("; ")}`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `london-sites-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  renderGates();
  return { tap, get active() { return LS.active; }, _LS: LS, run };
}
