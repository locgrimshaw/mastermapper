// app.js — Welfare Mapper prototype
// England socio-economic site appraisal tool.
//
// What this does today:
//  - loads the processed LSOA GeoJSON (real or synthetic)
//  - renders a live choropleth of the COMBINED score
//  - lets you reweight the 7 IMD domains and recomputes instantly (client-side)
//  - lets you draw a plot boundary and produces a context report by
//    aggregating the LSOAs the plot overlaps (area-weighted)
//
// What's stubbed for later (needs the backend / extra data):
//  - isochrones + nearest amenities (3rd-party routing API)
//  - housing context + policy overlays (more layers)
//  - portfolio batch scoring (server-side job)

// Official IMD weights (the methodology MHCLG uses to combine the domains into
// the overall Index of Multiple Deprivation). These are our DEFAULT slider
// values, as percentages that sum to 100. Users can reweight from here; the
// sliders rebalance so the total always stays 100%.
const DOMAINS = [
  { key: "income",      name: "Income", weight: 22.5,
    about: "Proportion of people on low income — those receiving income-related benefits and tax credits. Includes both out-of-work and in-work low earners.",
    source: "English Indices of Deprivation 2025, Income domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "employment",  name: "Employment", weight: 22.5,
    about: "Involuntary exclusion from work among the working-age population: claimants of jobseeker's, incapacity, and carer's benefits.",
    source: "English Indices of Deprivation 2025, Employment domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "education",   name: "Education & skills", weight: 13.5,
    about: "Lack of attainment and skills, combining children/young people's school results and the proportion of adults with low or no qualifications.",
    source: "English Indices of Deprivation 2025, Education domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "health",      name: "Health & disability", weight: 13.5,
    about: "Risk of premature death and impairment to quality of life through poor physical or mental health. Measures morbidity and disability, not health-care access.",
    source: "English Indices of Deprivation 2025, Health domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "crime",       name: "Crime", weight: 9.3,
    about: "Risk of personal and material victimisation, derived from recorded rates of violence, burglary, theft, and criminal damage.",
    source: "English Indices of Deprivation 2025, Crime domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "housing",     name: "Barriers to housing", weight: 9.3,
    about: "Physical and financial accessibility of housing and key local services — distance to a GP, shop, school, plus overcrowding, homelessness, and affordability.",
    source: "English Indices of Deprivation 2025, Barriers to Housing & Services (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  { key: "environment", name: "Living environment", weight: 9.3,
    about: "Quality of the local environment: housing condition (indoor) and air quality plus road-traffic accident risk (outdoor).",
    source: "English Indices of Deprivation 2025, Living Environment domain (MHCLG)",
    sourceUrl: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
];

// Default weights as a map, e.g. { income: 22.5, ... }. Used to seed state and
// to reset. They sum to 100 (allowing for the 9.3×3 rounding the official
// methodology itself uses).
const DEFAULT_WEIGHTS = Object.fromEntries(DOMAINS.map(d => [d.key, d.weight]));

// ---- Colour ramps ----
// "Single" = the original monochrome sequential ramps (light -> dark = worse).
// "Spectrum" = a diverging blue(good) -> red(bad) scale that's more striking.
// The user toggles between them from the legend.
const RAMP_SINGLE = ["#f3efe6", "#eccfa0", "#e0a063", "#cf6f3a", "#a84724", "#7a2d1c"];
const RAMP_SPECTRUM = ["#2c7bb6", "#71b2c9", "#c5e3d8", "#fdc980", "#ec6a43", "#d7191c"];
// Price keeps its own cool sequential ramp regardless of mode.
const PRICE_RAMP = ["#e8eef2", "#b9cfdc", "#89b0c6", "#5a8fb0", "#356f97", "#1c4f72"];

// RAMP is resolved dynamically from the current colour mode.
function RAMP() {
  return state.colourMode === "spectrum" ? RAMP_SPECTRUM : RAMP_SINGLE;
}

// Boundary hairline colour, theme-aware. Dark ink on light themes reads as a
// crisp border; a translucent light line on dark themes keeps areas cohesive
// rather than carving them up.
function LINE_COLOR() {
  return state.theme === "light" ? "rgba(40,52,70,0.28)" : "rgba(220,228,238,0.18)";
}
function SELECT_COLOR() {
  return state.theme === "light" ? "#1c2533" : "#ffffff";
}

// --- Tracked click popups --------------------------------------------------
// Click popups (amenity, crime) persist until dismissed, so we track them and
// can clear them all when a deep dive closes (otherwise they linger on the map).
const _clickPopups = [];
function openClickPopup(opts, lngLat, html) {
  const p = new maplibregl.Popup(opts).setLngLat(lngLat).setHTML(html).addTo(map);
  _clickPopups.push(p);
  p.on("close", () => {
    const i = _clickPopups.indexOf(p);
    if (i >= 0) _clickPopups.splice(i, 1);
  });
  return p;
}
function closeAllPopups() {
  while (_clickPopups.length) {
    const p = _clickPopups.pop();
    try { p.remove(); } catch (_) {}
  }
}

// --- Rail overlay: modes, colours, labels ----------------------------------
// Four transit modes, each its own colour so they're distinguishable on the
// map and in the toggle list. Colours are picked to read over both ends of the
// choropleth (the blue/red spectrum) without being mistaken for data values.
// Order here is the order shown in the toggle panel.
const RAIL_MODES = [
  { key: "rail",       label: "Heavy rail",  color: "#1b1b1b", glyph: "railway" },
  { key: "subway",     label: "Subway / metro", color: "#0a5cd1", glyph: "subway" },
  { key: "light_rail", label: "Light rail",  color: "#15897a", glyph: "light_rail" },
  { key: "tram",       label: "Tram",        color: "#c44d12", glyph: "tram" },
];

function railMode(key) {
  return RAIL_MODES.find(m => m.key === key);
}

// ---- Developable land + dwelling capacity (station analysis) --------------
// Density thresholds (people/km²) that auto-classify a station's catchment into
// a dwelling-density regime. Adjustable constants so the bands can be tuned.
// urban  : density  > DENSITY_BANDS.urban
// suburban: DENSITY_BANDS.suburban ≤ density ≤ DENSITY_BANDS.urban
// rural  : density  < DENSITY_BANDS.suburban
const DENSITY_BANDS = { urban: 4000, suburban: 1000 };

// Default dwellings-per-hectare (dph) per regime; surfaced as editable inputs so
// the assumptions are adjustable. Urban applies a higher inner-ring density
// (within inner_radius_m of the station) and the suburban rate beyond it.
const DPH_DEFAULTS = { rural: 40, suburban: 50, urbanOuter: 50, urbanInner: 100 };

// Constraint kinds the developable-land RPC can subtract, with UI labels. Order
// here is the display order of the checkboxes. `on` = checked by default.
const DEVELOPABLE_SUBTRACT_KINDS = [
  { key: "built_land",   label: "Built-up land",  on: true  },
  { key: "green_space",  label: "Green space",    on: true  },
  { key: "transport",    label: "Roads &amp; rail",  on: true  },
  { key: "water",        label: "Water bodies",   on: true  },
  { key: "flood_zone_3", label: "Flood zone 3",   on: true  },
  { key: "flood_zone_2", label: "Flood zone 2",   on: false },
  { key: "green_belt",   label: "Green belt",     on: false },
  // Gate-3 hard environmental exclusions (statutory designations). On by default
  // so single-station detail matches the sift's default erase set.
  { key: "sssi",               label: "SSSI",               on: true },
  { key: "sac",                label: "Special Area of Conservation", on: true },
  { key: "spa",                label: "Special Protection Area",      on: true },
  { key: "ramsar",             label: "Ramsar wetland",     on: true },
  { key: "ancient_woodland",   label: "Ancient woodland",   on: true },
  { key: "scheduled_monument", label: "Scheduled monument", on: true },
];

// Fill/outline colours: purple for the developable land kept (green kept
// getting read as green SPACE — the exact land it is not), muted red for the
// subtracted "blocker" constraints.
const DEVELOPABLE_COLOR = "#ae3ec9";
const DEVELOPABLE_BLOCKER_COLOR = "#c0392b";
// Developable land inside the inner ring carries the URBAN dwellings-per-
// hectare rate — far more homes per acre than the same land further out — so
// it gets its own deeper, hotter shade rather than reading as "more purple".
const DEVELOPABLE_INNER_COLOR = "#5f3dc4";
// Publicly-owned parcels (CCOD x INSPIRE, flats excluded): indigo, deliberately
// outside the green/red developable language.
const PUBLIC_LAND_COLOR = "#4c6ef5";

// OS / Environment Agency / OGL attribution appended to the datasource footer
// while the developable-land layers are shown.
const DEVELOPABLE_ATTRIBUTION =
  "Contains OS data © Crown copyright and database right 2026 · " +
  "© Environment Agency copyright and/or database right 2026 · " +
  "Contains public sector information licensed under the Open Government Licence v3.0";

// Whether the developable overlay is currently on the map (drives the footer
// attribution). Toggled by render/removeDevelopableLayer.
let developableAttributionShown = false;

// National Green Belt display overlay (web/data/greenbelt.geojson, built by
// pipeline/build_greenbelt_layer.py). Toggled from the "Planning overlays" block.
const GREENBELT_COLOR = "#2b8a3e";
const GREENBELT_ATTRIBUTION =
  "Green Belt © planning.data.gov.uk / MHCLG (contains OS data © Crown " +
  "copyright and database right), Open Government Licence v3.0";
let greenbeltAttributionShown = false;

// Default developable filter config (radius + which constraints to subtract).
// Fresh copy per deep dive so edits don't leak between stations.
function defaultDevelopableConfig() {
  const subtract = {};
  for (const k of DEVELOPABLE_SUBTRACT_KINDS) subtract[k.key] = k.on;
  // minPlotAc: drop developable plots below this many acres. Default 1 acre —
  // sub-acre fragments aren't schemes, and the SIFT's precomputed hectares
  // use the same floor (rebuild_station_assessments passes 1 acre + 15 m), so
  // the two surfaces describe the same land by default. Changing either
  // default means changing BOTH, or sift and dive will disagree again.
  // largestOnly: keep only the single largest contiguous developable plot.
  // minWidthM: drop anything narrower than this, wherever it occurs — an AREA
  // test can't catch a 4 m x 300 m ribbon left along a railway or a road verge,
  // which is big enough to pass but impossible to build on. 15 m is about the
  // narrowest strip that takes a single row of housing plus access.
  return { radius_m: 800, inner_radius_m: 200, subtract, minPlotAc: 1,
           largestOnly: false, minWidthM: 15 };
}

const M2_PER_ACRE = 4046.856;

// A MapLibre 'match' expression mapping the per-feature `mode` attribute to its
// colour. Used for both line-colour and stop-fill so a mode reads consistently.
function railColorExpression() {
  const expr = ["match", ["get", "mode"]];
  for (const m of RAIL_MODES) expr.push(m.key, m.color);
  expr.push("#666");   // fallback for any unexpected mode
  return expr;
}

// Stop outline + label colours stay theme-aware (contrast against basemap).
function RAIL_STOP_STROKE() {
  return state.theme === "light" ? "#ffffff" : "#11141b";
}
function RAIL_LABEL_COLOR() {
  return state.theme === "light" ? "#1c2533" : "#f4f6fb";
}
function RAIL_LABEL_HALO() {
  return state.theme === "light" ? "#ffffff" : "#11141b";
}

const state = {
  // Weights are PERCENTAGES that always sum to 100. Seeded from the official
  // IMD methodology; the sliders rebalance the others when one is moved.
  weights: { ...DEFAULT_WEIGHTS },
  enabled: Object.fromEntries(DOMAINS.map(d => [d.key, true])), // counts toward combined?
  solo: null,            // if set, map shows just this one domain
  breaksData: null,      // precomputed colour breaks loaded from breaks.json
  usingSampleData: true,
  selectedCode: null,    // LSOA pinned by click-to-inspect
  plotPointMode: false,  // true while waiting for a map click to drop a plot point
  layer: "deprivation",  // "deprivation" | "price"
  hasPrice: false,       // whether the loaded data includes price fields
  colourMode: "single",  // "single" | "spectrum"
  // The IMD/price choropleth is now context, OFF by default (the app leads with
  // the site-appraisal funnel, not deprivation colours). Toggled from the
  // "Map layers" block. lsoa-fill stays rendered at opacity 0 when off so
  // click-to-inspect and draw-a-plot (which queryRenderedFeatures on it) keep
  // working — visibility:none would break those.
  imdOn: false,
  fillOpacity: 0.85,     // deprivation choropleth opacity (per-layer slider)
  // House prices are now an INDEPENDENT layer (their own group in the Data
  // layers panel), no longer a mode that swaps out the deprivation choropleth.
  priceOn: false,
  priceOpacity: 0.85,
  // Per-layer transparency for the transit overlay, station dots and the
  // national Green Belt fill (all adjustable from the Data layers panel).
  railOpacity: 0.95,
  stationOpacity: 0.9,
  greenbeltOpacity: 0.28,
  theme: "light",        // "dark" | "light"
  hasRail: false,        // whether the tiles include the rail overlay
  // Per-mode visibility for rail lines and stops. Defaults on for any mode
  // present in the data (set during loadData from breaks.json counts).
  railLineModes: {},     // e.g. { rail:true, subway:true, ... }
  railStopModes: {},
  hasStations: false,    // whether stations.geojson loaded (heavy-rail usage layer)
  stationsVisible: true, // whether the station layer is shown
  stationsMeta: null,    // { latest_year, count, ... } from stations.geojson
  selectedStation: null, // station props pinned in the floating card
  // Catchment method for station/plot deep dives:
  //   "circle"    — instant straight-line approximation (no network). DEFAULT,
  //                 because the public Valhalla routing server is unreliable.
  //   "isochrone" — accurate street-network walk time via Valhalla (slower,
  //                 depends on the free service being up).
  catchmentMethod: "circle",
  // Top-level app mode: "explore" (free map + station deep dives) or "sift"
  // (the NPPF station funnel over the precomputed station_assessments).
  mode: "explore",
};

// Heavy-rail station layer styling. Distinct from the transit-overlay rail
// stops: these are the analysis objects (clickable, usage-bearing). We size
// them by usage so the busy hubs read at a glance.
const STATION_COLOR = "#7a3ea8";        // a deliberate, non-deprivation hue
const STATION_COLOR_DIM = "#9a6fc0";

// The ramp currently driving the choropleth.
function activeRamp() {
  return state.layer === "price" ? PRICE_RAMP : RAMP();
}

// ---- Scoring engine -------------------------------------------------------

// Combined score for ONE feature's properties (used by the click panel and
// plot report, which work on individual features). Each domain is normalised
// 0-100, higher = more deprived. Respects the enable toggles and weights.
function combinedScore(props, weights) {
  let wsum = 0, acc = 0;
  for (const d of DOMAINS) {
    if (!state.enabled[d.key]) continue;
    const w = weights[d.key];
    const v = props[`${d.key}_norm`];
    if (v == null) continue;
    acc += w * v;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0;
}

// Build a MapLibre expression that computes the combined score on the GPU
// from the tile attributes. This is what keeps reweighting fast and live with
// vector tiles: we never loop features in JS, the style engine does it per
// visible feature. Equivalent to combinedScore() but as an expression tree.
function combinedScoreExpression() {
  const terms = [];      // weighted values
  let wsum = 0;
  for (const d of DOMAINS) {
    if (!state.enabled[d.key]) continue;
    const w = state.weights[d.key];
    if (w === 0) continue;
    terms.push(["*", w, ["coalesce", ["get", `${d.key}_norm`], 0]]);
    wsum += w;
  }
  if (!terms.length || wsum === 0) return 0;
  const sum = terms.length === 1 ? terms[0] : ["+", ...terms];
  return ["/", sum, wsum];
}

// The value expression the map colours by, depending on layer/solo mode.
function activeValueExpression() {
  if (state.layer === "price") return ["coalesce", ["get", "price_norm"], -1];
  if (state.solo) return ["coalesce", ["get", `${state.solo}_norm`], -1];
  return combinedScoreExpression();
}

// Breaks now come from the precomputed sidecar (breaks.json), because a tiled
// map only holds visible features and can't see the whole distribution. We
// pick the right set for the current mode.
function currentBreaks() {
  if (!state.breaksData) return [];
  if (state.layer === "price") return state.breaksData.price || [];
  if (state.solo) return state.breaksData[state.solo] || [];
  return state.breaksData.combined_equal || [];
}

// MapLibre 'step' expression: map the active value through the breaks to the
// ramp colours. Negative sentinel (no data) renders transparent.
function fillColorExpression() {
  const ramp = activeRamp();
  const breaks = currentBreaks();
  if (!breaks.length) return ramp[0];
  const expr = ["step", activeValueExpression(), "rgba(0,0,0,0)"];
  expr.push(0, ramp[0]);
  breaks.forEach((b, i) => { expr.push(b, ramp[i + 1]); });
  return expr;
}

// House-price choropleth colour expression. Prices are their own layer now
// (price-fill), fully independent of the deprivation choropleth, so this
// never consults state.layer/solo — it always keys on price_norm with the
// price ramp and price breaks.
function priceFillColorExpression() {
  const breaks = state.breaksData?.price || [];
  if (!breaks.length) return PRICE_RAMP[0];
  const expr = ["step", ["coalesce", ["get", "price_norm"], -1], "rgba(0,0,0,0)"];
  expr.push(0, PRICE_RAMP[0]);
  breaks.forEach((b, i) => { expr.push(b, PRICE_RAMP[i + 1]); });
  return expr;
}

// ---- Map ------------------------------------------------------------------

// Debug flag (set by ?debug in the URL). When on, key interaction steps log to
// the console so touch problems are diagnosable on a phone with no computer.
const DEBUG = (typeof location !== "undefined") && location.search.indexOf("debug") !== -1;
function dbg(...args) { if (DEBUG) console.log("[mm]", ...args); }

const map = new maplibregl.Map({
  container: "map",
  // Keeps the WebGL buffer readable so the land-assembly report can snapshot
  // the map with canvas.toDataURL(). Costs a little GPU memory; the
  // alternative (capture inside a render callback) is flakier across browsers.
  preserveDrawingBuffer: true,
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      carto: {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}@2x.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap, © CARTO",
      },
      // CARTO's matching label-only tiles: minimal place names (cities,
      // towns, key roads) that ride ABOVE every data layer so you can keep
      // your bearings with any overlay on. The keeper below pins them top.
      "carto-labels": {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}@2x.png"],
        tileSize: 256,
      },
    },
    layers: [
      { id: "base", type: "raster", source: "carto" },
      { id: "base-labels", type: "raster", source: "carto-labels",
        paint: { "raster-opacity": 0.85 } },
    ],
  },
  center: [-0.11, 51.51],
  zoom: 10.5,
  // A tap on a phone rarely lands pixel-perfect; without a tolerance a tap that
  // wobbles a few px is treated as a drag and the click handler never fires.
  // 8px is comfortable for fingers without making real drags feel sticky.
  clickTolerance: 8,
});
window.map = map;   // dev: expose for console debugging

// Every addLayer lands above base-labels; re-pin the labels to the very top
// whenever the style changes (rAF-debounced; guard avoids a moveLayer ->
// styledata feedback loop by only acting when they're not already last).
let _lblRaf = 0;
map.on("styledata", () => {
  if (_lblRaf) return;
  _lblRaf = requestAnimationFrame(() => {
    _lblRaf = 0;
    try {
      const layers = map.getStyle().layers;
      if (layers && layers.length && layers[layers.length - 1].id !== "base-labels"
          && map.getLayer("base-labels"))
        map.moveLayer("base-labels");
    } catch (_) {}
  });
});

// --- Touch fix for mapbox-gl-draw on MapLibre --------------------------------
// @mapbox/mapbox-gl-draw registers some listeners with a { passive: true }
// THIRD argument: map.on("touchstart", handler, { passive: true }). MapLibre's
// Map#on signature is on(type, listener) OR on(type, layerId, listener) — it
// has no 3rd "options" form. So Draw's options object gets mistaken for the
// listener/layerId, and on the first touch MapLibre runs `layerIds.filter(...)`
// on it and throws "filter is not a function". That uncaught error kills the
// whole touch event chain, so NOTHING responds to taps on mobile (zones,
// stops, controls) — while desktop, which never fires touchstart, works fine.
//
// Fix: drop the 3rd argument whenever the 2nd argument is the listener function
// (i.e. a plain on(type, listener, opts) call). Real delegated calls pass a
// string/array layer id as the 2nd arg and are left untouched.
(function patchTouchOptionArg(m) {
  for (const method of ["on", "off", "once"]) {
    const orig = m[method];
    if (typeof orig !== "function") continue;
    m[method] = function (type, second, third) {
      const secondIsListener = typeof second === "function";
      const secondIsLayer = typeof second === "string" || Array.isArray(second);
      if (secondIsListener && arguments.length > 2) {
        return orig.call(this, type, second);   // on(type, listener, opts) -> drop opts
      }
      if (!secondIsListener && !secondIsLayer && second != null && typeof third !== "function") {
        return this;                            // on(type, optionsObject) -> no-op
      }
      return orig.apply(this, arguments);
    };
  }
})(map);

// Surface any uncaught error to the console with a clear tag. Touch problems on
// mobile are almost always one listener throwing and killing the whole gesture
// chain; if taps still fail after the patch above, this makes the real cause
// readable in remote-debugging (Safari/Chrome devtools) rather than silent.
window.addEventListener("error", (e) => {
  console.error("[uncaught]", e.message, "at", e.filename + ":" + e.lineno);
});

// Raw DOM-level probe (debug only): listens directly on the map canvas,
// bypassing MapLibre's gesture system. If these fire on a tap but the MapLibre
// "map click fired" log does NOT, the problem is inside MapLibre's gesture
// handling (the Draw touch bug). If even these don't fire, something is
// covering the canvas / swallowing the tap before it reaches the map.
if (DEBUG) {
  map.on("load", () => {
    const c = map.getCanvas();
    ["touchstart", "touchend", "click", "pointerup"].forEach(type => {
      c.addEventListener(type, () => dbg("RAW canvas", type), { passive: true });
    });
    dbg("raw canvas probes attached");
  });
}

const draw = new MapboxDraw({
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
});
map.addControl(draw, "top-right");
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ---- Data load ------------------------------------------------------------

const SOURCE_LAYER = "lsoa";   // must match the tippecanoe -l layer name

// Runtime data assets (tiles, breaks, stations, green belt) normally live
// alongside the site under data/. Setting DATA_BASE in config.js points them
// at another origin instead — e.g. a preview deployment of just the frontend
// reading the live site's data — so previews don't ship ~130 MB of data.
// Unset/empty = same-origin relative paths, exactly as before.
function dataUrl(rel) {
  const base = ((typeof window !== "undefined" && window.MASTERMAPPER_CONFIG) || {}).DATA_BASE;
  if (!base) return rel;
  return new URL(rel, base.endsWith("/") ? base : base + "/").href;
}

async function loadData() {
  // Register the PMTiles protocol so MapLibre can read our single tile file
  // via HTTP range requests (only the visible tiles are fetched).
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  // Load the precomputed colour breaks (tiny sidecar). The map can't compute
  // quantiles itself anymore since it only holds visible features. Fetch with
  // no-store so the build_id we read here is always the latest (otherwise a
  // cached breaks.json would hand us a stale build_id and defeat the buster).
  try {
    const br = await fetch(dataUrl("data/breaks.json"), { cache: "no-store" });
    if (br.ok) state.breaksData = await br.json();
  } catch { state.breaksData = null; }

  // Flags the pipeline records in breaks.json so we don't need all features.
  state.usingSampleData = state.breaksData?.meta?.sample ?? true;
  state.hasPrice = (state.breaksData?.price?.length ?? 0) > 0;
  const railMeta = state.breaksData?.meta?.rail;
  const lineCounts = railMeta?.line_counts || {};
  const stopCounts = railMeta?.stop_counts || {};
  state.hasRail = Object.keys(lineCounts).length > 0 || Object.keys(stopCounts).length > 0;
  // Default every present mode to visible.
  state.railLineModes = {};
  state.railStopModes = {};
  for (const m of RAIL_MODES) {
    if ((lineCounts[m.key] || 0) > 0) state.railLineModes[m.key] = true;
    if ((stopCounts[m.key] || 0) > 0) state.railStopModes[m.key] = true;
  }

  // Station-usage layer (heavy rail). A small standalone GeoJSON (not in the
  // tiles), loaded like crime/amenities. Optional: absent file → no station
  // mode, everything else works.
  try {
    const sr = await fetch(dataUrl("data/stations.geojson"), { cache: "no-store" });
    if (sr.ok) {
      state.stationsData = await sr.json();
      state.hasStations = (state.stationsData.features || []).length > 0;
      state.stationsMeta = state.stationsData.metadata || null;
      console.info(`[stations] loaded ${state.stationsData.features?.length ?? 0} stations`,
        state.stationsMeta || "");
    } else {
      console.warn(`[stations] data/stations.geojson HTTP ${sr.status} — station layer disabled`);
    }
  } catch (err) {
    state.stationsData = null; state.hasStations = false;
    console.warn("[stations] failed to load stations.geojson:", err.message);
  }

  // Append the per-build stamp so a rebuilt lsoa.pmtiles (same filename) is
  // fetched fresh rather than served from a stale browser/CDN cache. PMTiles
  // uses HTTP range requests; the query string makes each build a new URL.
  const buildId = state.breaksData?.meta?.build_id || "";
  const tilesPath = "data/lsoa.pmtiles" + (buildId ? `?v=${buildId}` : "");
  const tilesUrl = "pmtiles://" + new URL(dataUrl(tilesPath), location.href).href;

  map.addSource("lsoa", {
    type: "vector",
    url: tilesUrl,
    // The choropleth must never vanish when zooming in. A vector source only
    // serves tiles up to its maxzoom and then "overzooms" (reuses the deepest
    // tile, scaled) beyond that. If maxzoom is set HIGHER than the tiles
    // actually contain, MapLibre requests tiles that don't exist and the layer
    // disappears past that zoom — which is the "everything goes to basemap when
    // I zoom in" bug. Setting maxzoom to 13 (which every build of our tileset
    // contains) guarantees clean overzoom to any depth. Detail past 13 comes
    // from overzooming the high-detail z13 tile, which still looks crisp.
    maxzoom: 13,
  });

  map.addLayer({
    id: "lsoa-fill",
    type: "fill",
    source: "lsoa",
    "source-layer": SOURCE_LAYER,
    paint: {
      "fill-color": fillColorExpression(),
      // OFF by default (opacity 0) — kept rendered so queryRenderedFeatures
      // interactions still work. setImdVisible() flips this.
      "fill-opacity": state.imdOn ? state.fillOpacity : 0,
      // Paint each polygon's own outline in its own fill colour. Because
      // tippecanoe simplifies shared borders slightly differently per
      // polygon, adjacent LSOAs can leave hairline gaps that show the bright
      // basemap through (the "fragmented" look). A same-colour outline
      // closes those sub-pixel slivers without needing a tile rebuild.
      "fill-outline-color": fillColorExpression(),
    },
  });

  // Soft hairline between areas — just enough to read boundaries, not so much
  // that it fragments the surface. Sits ABOVE the fill, low opacity, and only
  // fades in as you zoom in (at the national view, borders would be noise).
  map.addLayer({
    id: "lsoa-line",
    type: "line",
    source: "lsoa",
    "source-layer": SOURCE_LAYER,
    layout: { visibility: state.imdOn ? "visible" : "none" },
    paint: {
      "line-color": LINE_COLOR(),
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.4, 14, 0.7, 17, 1.2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.5, 14, 0.8, 17, 0.9],
    },
  });

  // Scotland SIMD choropleth (Data Zone polygons in the same pmtiles, layer
  // 'simd'). Same source + same combined-score paint as England — access_norm
  // is baked in as environment_norm so no per-country colour maths is needed.
  // Renders nothing if the tiles predate SIMD (harmless).
  map.addLayer({
    id: "simd-fill",
    type: "fill",
    source: "lsoa",
    "source-layer": "simd",
    paint: {
      "fill-color": fillColorExpression(),
      "fill-opacity": state.imdOn ? state.fillOpacity : 0,
      "fill-outline-color": fillColorExpression(),
    },
  });
  map.addLayer({
    id: "simd-line",
    type: "line",
    source: "lsoa",
    "source-layer": "simd",
    layout: { visibility: state.imdOn ? "visible" : "none" },
    paint: {
      "line-color": LINE_COLOR(),
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.4, 14, 0.7, 17, 1.2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.5, 14, 0.8, 17, 0.9],
    },
  });

  // House-price choropleth — its own layer above the deprivation fills so the
  // two can be shown independently (or together, blended via their opacity
  // sliders). Kept at opacity 0 when off, like lsoa-fill, so toggling is a
  // cheap paint change rather than a layout pass.
  if (state.hasPrice) {
    map.addLayer({
      id: "price-fill",
      type: "fill",
      source: "lsoa",
      "source-layer": SOURCE_LAYER,
      paint: {
        "fill-color": priceFillColorExpression(),
        "fill-opacity": state.priceOn ? state.priceOpacity : 0,
        "fill-outline-color": priceFillColorExpression(),
      },
    });
  }

  // Highlight outline for the LSOA pinned by click-to-inspect.
  map.addLayer({
    id: "lsoa-selected",
    type: "line",
    source: "lsoa",
    "source-layer": SOURCE_LAYER,
    paint: { "line-color": SELECT_COLOR(), "line-width": 2.4 },
    filter: ["==", "lsoa_code", ""],
  });

  // --- Rail overlay (optional) ---------------------------------------------
  // Two tile layers (rail_line, rail_stop); each feature carries a `mode`
  // (rail/subway/light_rail/tram). We colour by mode with a match expression
  // and show/hide modes with a filter, so a single layer covers all modes.
  if (state.hasRail) {
    try {
      map.addLayer({
        id: "rail-line",
        type: "line",
        source: "lsoa",
        "source-layer": "rail_line",
        layout: { "line-join": "round", "line-cap": "round" },
        filter: railModeFilter("line"),
        paint: {
          "line-color": railColorExpression(),
          // Keep lines visible even at the national view (the map opens fitted
          // to the whole-England bbox, ~zoom 6, where hairlines vanish).
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.1, 10, 1.8, 14, 3],
          "line-opacity": state.railOpacity,
        },
      });

      map.addLayer({
        id: "rail-stop",
        type: "circle",
        source: "lsoa",
        "source-layer": "rail_stop",
        filter: railModeFilter("stop"),
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.2, 11, 3.6, 14, 5.2],
          "circle-color": railColorExpression(),
          "circle-stroke-color": RAIL_STOP_STROKE(),
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 11, 1.1, 14, 1.6],
        },
      });

      // Stop labels, only when zoomed in enough to be legible.
      map.addLayer({
        id: "rail-stop-label",
        type: "symbol",
        source: "lsoa",
        "source-layer": "rail_stop",
        minzoom: 11,
        filter: railModeFilter("stop"),
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": RAIL_LABEL_COLOR(),
          "text-halo-color": RAIL_LABEL_HALO(),
          "text-halo-width": 1.4,
        },
      });
      console.log("[rail] layers added:", ["rail-line", "rail-stop", "rail-stop-label"]
        .filter(id => map.getLayer(id)));
    } catch (err) {
      console.error("[rail] failed to add layers:", err);
    }

    // Probe once the source has loaded: how many rail features are actually in
    // the current view? If this logs 0 at a city zoom, the tiles lack the
    // rail_line/rail_stop source-layers (stale tiles) rather than a style bug.
    map.on("idle", function railProbe() {
      const lines = map.querySourceFeatures("lsoa", { sourceLayer: "rail_line" }).length;
      const stops = map.querySourceFeatures("lsoa", { sourceLayer: "rail_stop" }).length;
      console.log(`[rail] features in view — lines:${lines} stops:${stops} (zoom ${map.getZoom().toFixed(1)})`);
      map.off("idle", railProbe);   // log once, not every idle
    });
  }

  // --- Station-usage layer (heavy rail, the analysis objects) --------------
  if (state.hasStations) {
    addStationLayer();
  }

  // --- National Green Belt display overlay (optional static layer) ---------
  loadGreenbelt();

  // Pre-bake the point-overlay icon badges so they're registered before the
  // first overlay toggle needs them.
  ensureOverlayIcons();

  updateDataSourceNote();
}

// Add the heavy-rail station layer from the standalone GeoJSON: circles scaled
// by annual usage, with labels at closer zooms, plus hover + click. These are
// the objects the station-led workflow profiles, so they're clickable and sit
// above the transit overlay.
function addStationLayer() {
  if (map.getLayer("station-dot")) return;  // layers already present; nothing to do
  if (!map.getSource("stations")) {
    map.addSource("stations", { type: "geojson", data: state.stationsData });
  }

  // Usage drives the radius. We interpolate on a sqrt-like set of stops so a
  // 10M-entry hub doesn't dwarf a 100k station into invisibility. Stations with
  // null usage get the minimum size. Radius = (usage curve) × (zoom factor):
  // multiplying two interpolate expressions is valid in MapLibre, whereas
  // nesting one interpolate inside another's stops is not.
  const usageRadius = [
    "interpolate", ["linear"], ["coalesce", ["get", "usage"], 0],
    0, 3.4, 250000, 5, 1000000, 6.5, 5000000, 9, 20000000, 13,
  ];
  // NOTE: a ["zoom"] expression must be the TOP-LEVEL interpolate; it cannot be
  // nested inside a ["*"] multiply. So zoom is the outer interpolate and each
  // stop multiplies the usage curve (which keys on "usage", legal to nest) by a
  // constant zoom factor.
  const circleRadius = [
    "interpolate", ["linear"], ["zoom"],
    5,  ["*", usageRadius, 0.6],
    11, ["*", usageRadius, 1.0],
    14, ["*", usageRadius, 1.25],
  ];
  map.addLayer({
    id: "station-dot",
    type: "circle",
    source: "stations",
    layout: { visibility: state.stationsVisible ? "visible" : "none" },
    paint: {
      "circle-radius": circleRadius,
      "circle-color": STATION_COLOR,
      "circle-opacity": state.stationOpacity,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 11, 1.4, 14, 2],
    },
  });
  // A subtle selected-ring layer, filtered to the pinned station's CRS.
  map.addLayer({
    id: "station-selected",
    type: "circle",
    source: "stations",
    filter: ["==", "crs", "___none___"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 7, 11, 11, 14, 15],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": STATION_COLOR,
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "station-label",
    type: "symbol",
    source: "stations",
    minzoom: 10,
    layout: {
      visibility: state.stationsVisible ? "visible" : "none",
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": RAIL_LABEL_COLOR(),
      "text-halo-color": RAIL_LABEL_HALO(),
      "text-halo-width": 1.4,
    },
  });

  // (Station hover is handled by the central hover-card system.)
  // NOTE: the station CLICK is handled centrally in wireInteractions() via a
  // queryRenderedFeatures check, not a layer-specific handler here. On the live
  // site the station dots coincide with tile-based rail stops and sit among
  // several interactive layers; a central priority check is far more reliable
  // than depending on per-layer click dispatch order.
}

// Show/hide the station layer (the "Stations" toggle).
function setStationsVisible(on) {
  state.stationsVisible = on;
  const vis = on ? "visible" : "none";
  for (const id of ["station-dot", "station-label"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
  if (!on && map.getLayer("station-selected")) {
    map.setFilter("station-selected", ["==", "crs", "___none___"]);
  }
}

// Build a MapLibre filter that keeps only the rail modes currently toggled on
// for the given kind ("line" or "stop"). Uses a `match` expression returning a
// boolean — more robust across MapLibre versions than the `in` operator with a
// ["literal", array], which can silently fail to parse and drop the layer.
function railModeFilter(kind) {
  const flags = kind === "line" ? state.railLineModes : state.railStopModes;
  const on = Object.keys(flags).filter(k => flags[k]);
  if (!on.length) return false;          // show nothing
  if (on.length === RAIL_MODES.length) return true;   // show everything
  // match: if mode is one of `on`, output true, else false.
  return ["match", ["get", "mode"], on, true, false];
}

function updateDataSourceNote() {
  const el = document.getElementById("datasource");
  if (state.usingSampleData) {
    el.className = "datasource warn";
    el.textContent =
      "⚠ Showing SYNTHETIC sample data. Download IMD 2019 + LSOA boundaries " +
      "and run the pipeline to load real England data. See docs/DATASETS.md.";
  } else {
    el.className = "datasource";
    el.textContent =
      "Source: English Indices of Deprivation 2019 (MHCLG, OGL v3) · " +
      "LSOA 2011 boundaries (ONS, OGL v3). Combined score is user-weighted.";
    if (state.hasRail) {
      el.textContent +=
        " Rail overlay © OpenStreetMap contributors & Trainline (ODbL).";
    }
    if (state.hasStations) {
      el.textContent +=
        " Station usage: Office of Rail and Road (OGL v3).";
    }
    // Developable-land analysis pulls in OS / Environment Agency constraint
    // data; credit it only while those layers are on the map.
    if (developableAttributionShown) {
      el.textContent += " " + DEVELOPABLE_ATTRIBUTION;
    }
    if (greenbeltAttributionShown) {
      el.textContent += " " + GREENBELT_ATTRIBUTION;
    }
    if (_osmPowerAttributionShown) {
      el.textContent += " Power network & university footprints © OpenStreetMap contributors (ODbL).";
    }
    if (typeof parcelsState !== "undefined" && parcelsState.on) {
      el.textContent += " Parcel outlines: HM Land Registry INSPIRE index polygons © Crown copyright and database right, geometry derived from Ordnance Survey data.";
    }
    if (typeof buildingsState !== "undefined" && buildingsState.on) {
      el.textContent += " Building footprints & heights © OpenStreetMap contributors (ODbL).";
    }
  }
}

// ---- National Green Belt display overlay ----------------------------------

// Load web/data/greenbelt.geojson (built by pipeline/build_greenbelt_layer.py)
// and add a hidden fill overlay + its toggle. Entirely optional: if the file is
// absent (not built yet) the rest of the map is unaffected.
async function loadGreenbelt() {
  try {
    const r = await fetch(dataUrl("data/greenbelt.geojson"), { cache: "no-store" });
    if (!r.ok) return;
    const gj = await r.json();
    const n = (gj.features || []).length;
    if (!n) return;
    state.hasGreenbelt = true;
    if (!map.getSource("greenbelt")) {
      map.addSource("greenbelt", { type: "geojson", data: gj });
      // Insert beneath the station dots so markers stay tappable on top.
      const beforeId = map.getLayer("station-dot") ? "station-dot" : undefined;
      map.addLayer({
        id: "greenbelt-fill", type: "fill", source: "greenbelt",
        layout: { visibility: "none" },
        paint: {
          "fill-color": GREENBELT_COLOR,
          "fill-opacity": state.greenbeltOpacity,
          "fill-outline-color": GREENBELT_COLOR,
        },
      }, beforeId);
    }
    buildGreenbeltToggle(n);
  } catch (err) {
    console.warn("[greenbelt] load failed:", err.message);
  }
}

// Reveal the Green Belt row (inside the always-visible "Map layers" block) and
// wire its checkbox.
function buildGreenbeltToggle(count) {
  const row = document.getElementById("greenbelt-row");
  const cb = document.getElementById("greenbelt-show");
  if (!row || !cb) return;
  row.hidden = false;
  const cnt = document.getElementById("greenbelt-count");
  if (cnt && count) cnt.textContent = `${count.toLocaleString()} areas`;
  cb.addEventListener("change", (e) => {
    if (!map.getLayer("greenbelt-fill")) return;
    map.setLayoutProperty("greenbelt-fill", "visibility", e.target.checked ? "visible" : "none");
    greenbeltAttributionShown = e.target.checked;
    updateDataSourceNote();
  });
}

// Master toggle for the IMD/price choropleth (now a context layer, OFF by
// default). lsoa-fill stays rendered at opacity 0 when off so click-to-inspect
// and draw-a-plot (which queryRenderedFeatures on it) keep working — hence we
// flip opacity, not visibility. The boundary line and legend follow.
function setImdVisible(on) {
  state.imdOn = on;
  for (const id of ["lsoa-fill", "simd-fill"])
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", on ? state.fillOpacity : 0);
  for (const id of ["lsoa-line", "simd-line"])
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  updateLegendVisibility();
}

// Deprivation choropleth transparency (Data layers panel slider).
function setImdOpacity(v) {
  state.fillOpacity = v;
  if (!state.imdOn) return;
  for (const id of ["lsoa-fill", "simd-fill"])
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", v);
}

// House-price layer visibility + transparency — independent of deprivation.
function setPriceVisible(on) {
  state.priceOn = on;
  if (map.getLayer("price-fill"))
    map.setPaintProperty("price-fill", "fill-opacity", on ? state.priceOpacity : 0);
  buildLegend();
  updateLegendVisibility();
}

function setPriceOpacity(v) {
  state.priceOpacity = v;
  if (state.priceOn && map.getLayer("price-fill"))
    map.setPaintProperty("price-fill", "fill-opacity", v);
}

// The legend shows whenever at least one choropleth is on.
function updateLegendVisibility() {
  const legend = document.getElementById("legend");
  if (legend) legend.style.display = (state.imdOn || state.priceOn) ? "" : "none";
}

// Wire any collapsible left-panel .block (accordion header toggles .collapsed).
// The weighting block ships collapsed by default (funnel-first UI).
function wireCollapsibleBlocks() {
  document.querySelectorAll(".block.collapsible > .block-head").forEach(head => {
    head.addEventListener("click", () => {
      const block = head.closest(".block");
      const collapsed = block.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
    });
  });
}

// Wire the "Deprivation (IMD)" checkbox in the Map layers block and reflect the
// initial (off) state on the legend. Safe to call at init before the map loads
// — setImdVisible only runs on user change, by which time the layers exist.
function wireImdToggle() {
  const cb = document.getElementById("imd-show");
  if (cb) {
    cb.checked = state.imdOn;
    cb.addEventListener("change", (e) => setImdVisible(e.target.checked));
  }
  updateLegendVisibility();
}

// ---- On-demand planning / environmental map overlays ----------------------
// The constraint + brownfield polygons live in Supabase. Each Data-layers
// toggle fetches only the current viewport (a bbox RPC), refetched as you pan
// or zoom — so the same mechanism serves a nationwide database without ever
// loading the whole country. Two things keep it fast:
//   1. a zoom guard (a country-wide bbox would pull far too many polygons);
//   2. a fetch cache: each fetch is padded ~30% beyond the viewport and the
//      padded bbox is remembered, so panning within it (or zooming IN) costs
//      no new request at all.
// NOTE: the DB extract is currently clipped to ~1 km around stations (see
// pipeline/build_constraints.py). Re-run it with CLIP_MODE=none to load
// national coverage — no frontend change needed.

// Top-level overlay-driven groups of the Data layers tree, each with its
// sub-groups. Overlay rows reference a sub-group via their `group` key.
const OVERLAY_TREE = [
  { key: "planning-env", title: "Planning &amp; environment", subs: [
    { key: "planning",    title: "Planning designations" },
    { key: "policy",      title: "Plans & policy areas" },
    { key: "environment", title: "Environmental designations" },
    { key: "heritage",    title: "Heritage" },
    { key: "flood",       title: "Flood risk" },
    { key: "land",        title: "Land ownership & infrastructure" },
  ]},
  { key: "student", title: "Student housing &amp; demand", subs: [
    { key: "students", title: "Universities & students" },
  ]},
  // Market granularity: the viability evidence base. Own top-level branch —
  // it was buried under "Student housing" back when prices only served the
  // PBSA story, but these layers now feed the residual appraisal directly.
  { key: "marketgrp", title: "Market", subs: [
    { key: "market",  title: "Prices & sales" },
    { key: "market2", title: "Costs, trend & affordability" },
  ]},
  { key: "energy", title: "Energy &amp; utilities", subs: [
    { key: "grid",        title: "Power grid" },
    { key: "sitefactors", title: "Site factors" },
  ]},
  { key: "connectivity", title: "Transport &amp; connectivity", subs: [
    { key: "bus", title: "Bus network" },
  ]},
];
const OVERLAY_GROUPS = OVERLAY_TREE.flatMap(t => t.subs);

// One entry per layer — every statutory designation is its own row now (the
// old combined "Environmental" / "Heritage" / "Flood" bundles are split) so
// each can be toggled and faded independently.
const MAP_OVERLAYS = [
  // Planning designations
  { key: "green_space",       group: "planning", label: "Green space",                color: "#74b816", kinds: ["green_space"] },
  { key: "conservation_area", group: "planning", label: "Conservation areas",         color: "#9c36b5", kinds: ["conservation_area"] },
  { key: "aonb",              group: "planning", label: "AONB / National Landscapes", color: "#5c940d", kinds: ["aonb"] },
  { key: "brownfield",        group: "planning", label: "Brownfield sites",           color: "#e8590c", brownfield: true },
  // Derived MODEL layer (rebuild_grey_belt_candidates in the DB): Green Belt
  // land that is already previously-developed in character. Indigo = built-up
  // area basis, orange = registered-brownfield basis.
  { key: "grey_belt_candidate", group: "planning", label: "Grey-belt candidates (model)", color: "#5c7cfa", dataset: "grey_belt_candidate", minZoom: 7 },
  // Environmental designations
  { key: "sssi",              group: "environment", label: "SSSI",                         color: "#0c8599", kinds: ["sssi"] },
  { key: "sac",               group: "environment", label: "Special Areas of Conservation", color: "#12b886", kinds: ["sac"] },
  { key: "spa",               group: "environment", label: "Special Protection Areas",     color: "#15aabf", kinds: ["spa"] },
  { key: "ramsar",            group: "environment", label: "Ramsar wetlands",              color: "#228be6", kinds: ["ramsar"] },
  { key: "ancient_woodland",  group: "environment", label: "Ancient woodland",             color: "#2f9e44", kinds: ["ancient_woodland"] },
  // Heritage
  { key: "scheduled_monument", group: "heritage", label: "Scheduled monuments",          color: "#a5744b", kinds: ["scheduled_monument"] },
  { key: "listed_building",    group: "heritage", label: "Listed buildings",             color: "#d9480f", kinds: ["listed_building"] },
  { key: "park_garden",        group: "heritage", label: "Registered parks & gardens",   color: "#66a80f", kinds: ["park_garden"] },
  // Flood risk
  { key: "flood_zone_2", group: "flood", label: "Flood zone 2", color: "#4dabf7", kinds: ["flood_zone_2"] },
  { key: "flood_zone_3", group: "flood", label: "Flood zone 3", color: "#1864ab", kinds: ["flood_zone_3"] },
  // Land ownership & infrastructure. Scotland's public estate is unusually
  // open, so each landowning public body is its own layer. (Network Rail /
  // MoD / councils still need HM Land Registry's licensed National Polygon
  // Service to map owner->parcel.)
  // NOTE: the 'transport' constraint kind (road/rail buffer corridors) is
  // deliberately NOT a display layer — it's an internal erase mask for the
  // developable-land analysis and reads as noise on the map.
  { key: "land_forestry_england", group: "land", label: "Forestry England estate",          color: "#2b8a3e", ownership: true, bodies: ["forestry_england"] },
  { key: "land_forestry_scotland",group: "land", label: "Forestry & Land Scotland",         color: "#37b24d", ownership: true, bodies: ["forestry_scotland"] },
  { key: "land_naturescot",       group: "land", label: "NatureScot land",                  color: "#20c997", ownership: true, bodies: ["naturescot_scotland"] },
  { key: "land_crown_estate",     group: "land", label: "Crown Estate Scotland",            color: "#845ef7", ownership: true, bodies: ["crown_estate_scotland"] },
  { key: "land_hes",              group: "land", label: "Historic Environment Scotland",    color: "#f59f00", ownership: true, bodies: ["hes_scotland"] },
  // CCOD sweep now keeps EVERY public body (owner_class prop from the
  // pipeline); dots colour by class at wide zooms, the town glyph takes over
  // close in.
  // NOTE: OWNER_CLASS_LABELS / PARCEL_MATCH below are the single source of
  // truth for how a public parcel is described — they were three near-identical
  // copies that had already drifted ("Central government" vs "Central
  // government & agencies").
  // provisional: the owner's locator is precise but it landed in a title far
  // larger than the holding the register describes, so the BOUNDARY is not
  // trustworthy even though the ownership is. Drawn faded and dashed, and
  // excluded from every hectare total (see migration 0040).
  { key: "public_parcel",         group: "land", label: "Public land parcels (CCOD x INSPIRE)", color: "#4c6ef5", dataset: "public_parcel", minZoom: 11, lim: 6000,
    provisional: ["==", ["to-boolean", ["get", "area_mismatch"]], true] },
  { key: "la_property",           group: "land", label: "Public-authority property (CCOD)", color: "#c92a2a", dataset: "la_property", render: "point", minZoom: 8, lim: 8000, icon: "town",
    cap: { color: ["match", ["to-string", ["get", "owner_class"]],
           "local_authority", "#c92a2a", "parish", "#f08c00",
           "combined_authority", "#d6336c", "nhs", "#1971c2",
           "university", "#7048e8", "police_fire", "#0ca678",
           "government", "#5f3dc4", "#c92a2a"] } },

  // ---- map_features datasets (generic ingestion framework; see ----
  // ---- pipeline/build_datasets.py + docs/DATA_LAYERS_ROADMAP.md) ----
  // Plans & policy areas (planning.data.gov.uk sweep)
  { key: "lpa_boundary",        group: "policy", label: "Planning authority boundaries", color: "#495057", dataset: "lpa_boundary",        render: "line",  minZoom: 5 },
  { key: "local_plan_boundary", group: "policy", label: "Local plan boundaries",         color: "#5f3dc4", dataset: "local_plan_boundary", render: "line",  minZoom: 6 },
  { key: "article4",            group: "policy", label: "Article 4 direction areas",     color: "#c2255c", dataset: "article4",            minZoom: 8 },
  { key: "tpo_zone",            group: "policy", label: "Tree preservation zones",       color: "#2b8a3e", dataset: "tpo_zone",            minZoom: 9 },
  { key: "design_code_area",    group: "policy", label: "Design code areas",             color: "#e8590c", dataset: "design_code_area",    minZoom: 8 },
  // NPPF approval-likelihood signal: red authorities are in presumption-in-
  // favour territory — the tilted balance applies to their decisions.
  { key: "hdt",                 group: "policy", label: "Housing Delivery Test",         color: "#e03131", dataset: "hdt", minZoom: 5 },
  // Decision culture: share of applications approved over 3 years (PlanIt).
  { key: "planit_rates",        group: "policy", label: "Approval rates (PlanIt)",       color: "#0b7285", dataset: "planit_rates", minZoom: 5 },
  // Universities & students
  { key: "uni_campus", group: "students", label: "Universities & HE providers", color: "#7048e8", dataset: "uni_campus", render: "point", minZoom: 5, icon: "uni" },
  { key: "uni_campus_site", group: "students", label: "Campus grounds (OSM)",     color: "#9775fa", dataset: "uni_campus_site", minZoom: 8 },
  { key: "census_students", group: "students", label: "Student population (Census)", color: "#7048e8", dataset: "census_students", minZoom: 5 },
  { key: "student_accom",   group: "students", label: "Existing PBSA stock (OSM)",  color: "#c2255c", dataset: "student_accom", render: "point", minZoom: 8, lim: 6000,
    radius: ["interpolate", ["linear"], ["zoom"], 7, 2.5, 11, 4.5, 15, 7] },
  { key: "uni_building",    group: "students", label: "University buildings (OSM)", color: "#5f3dc4", dataset: "uni_building", minZoom: 11 },
  // PTAL: EVERY cell, every zoom, served from PMTiles rather than the bbox RPC.
  // The RPC could not do it. A single z12 view is 52,301 cells, 14 MB and
  // 20.8 s — and it is not the simplification, since removing it changes
  // nothing; roughly 400 us per feature goes on building the JSON document, so
  // no row cap or index helps. Below z12 the cells were discarded as sub-pixel
  // before the cap was even reached: asking for 200,000 features at z11
  // returned TWO. Tiles have no such ceiling and cost the database nothing.
  // `dataset` stays for the popup and colour ramp; `tiles` routes the DATA away
  // from the RPC, reusing the ov-ptal-* layer ids so taps and opacity work.
  { key: "ptal",       group: "students", label: "PTAL (London transport access)", color: "#f03e3e", dataset: "ptal", minZoom: 8,
    tiles: { file: "ptal.pmtiles", sourceLayer: "ptal", minzoom: 8, outlineFromZoom: 15 },
    cap: { color: ["match", ["to-string", ["get", "ptal"]],
           "0", "#08306b", "1a", "#2171b5", "1b", "#6baed6", "2", "#74c476",
           "3", "#fee391", "4", "#fe9929", "5", "#ec7014",
           "6a", "#cc4c02", "6b", "#8c2d04", "#f03e3e"] } },
  // Market & boundaries
  { key: "la_rents",     group: "market", label: "Private rents (LA average)", color: "#0b7285", dataset: "la_rents",     minZoom: 5 },
  // Sold-price heatmaps: one server-side grid dataset at four resolutions
  // (~35 km -> ~550 m cells); the numFilter picks the resolution for the
  // zoom, so the same toggle reads cleanly from a national view down to
  // street blocks. Borderless fills — the colour IS the story.
  // `surface`: bilinear value surface rendered to a canvas image overlay, NOT
  // a kernel-density heatmap. The grid is a uniform VALUE lattice — summed
  // kernels oscillate between cell centres at any radius, which showed up as
  // banded stripes on screen. Interpolating the values directly means colour
  // maps to price (legendable) and the surface is genuinely smooth.
  // keyFn depends on the shared flats/houses filter (marketPtype): the grid
  // carries per-type medians — med/med_h/med_f and ppm2/ppm2_h/ppm2_f — so
  // switching type is a re-rasterise of props already on the client, never a
  // refetch. A cell lacking the selected split (its per-type count missed the
  // privacy floor) goes transparent, rather than lying with the pooled number.
  { key: "price_heat", group: "market", label: "Sold prices (3-yr heatmap)", color: "#d73027", dataset: "price_grid", minZoom: 4, lim: 8000,
    datasetFn: z => z < 6.5 ? "price_grid_c" : z < 8.5 ? "price_grid_l"
                  : z < 11  ? "price_grid_m" : "price_grid_f",
    surface: {
      keyFn: pt => pt === "houses" ? "med_h" : pt === "flats" ? "med_f" : "med",
      // Median price -> ramp position (blue ~£80k ... red £1.5M+).
      stops: [[60000, 0.06], [130000, 0.2], [200000, 0.34], [300000, 0.48],
              [450000, 0.62], [700000, 0.76], [1100000, 0.88], [1800000, 1]],
    } },
  { key: "ppm2_heat", group: "market", label: "£ per m² (3-yr heatmap)", color: "#7048e8", dataset: "price_grid", minZoom: 4, lim: 8000,
    datasetFn: z => z < 6.5 ? "price_grid_c" : z < 8.5 ? "price_grid_l"
                  : z < 11  ? "price_grid_m" : "price_grid_f",
    surface: {
      keyFn: pt => pt === "houses" ? "ppm2_h" : pt === "flats" ? "ppm2_f" : "ppm2",
      // £/m² -> ramp position (blue ~£1k ... red £10k+/m²).
      stops: [[800, 0.06], [1500, 0.2], [2200, 0.34], [3000, 0.48],
              [4200, 0.62], [5800, 0.76], [8000, 0.88], [12000, 1]],
    } },
  // Individual transactions stay for comparables work — close zooms only.
  { key: "ppd_sales",    group: "market", label: "Individual sales (comparables)",  color: "#d64550", dataset: "ppd_sales", render: "point", minZoom: 14, lim: 6000,
    radius: ["interpolate", ["linear"], ["zoom"], 12, 2.5, 15, 5, 17, 7],
    cap: { color: ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "price"]], 0],
           100000, "#f7b267", 300000, "#ef8354", 500000, "#d64550",
           800000, "#a4243b", 1500000, "#6d1a36"] } },
  { key: "lad_boundary", group: "market", label: "Local authority boundaries", color: "#868e96", dataset: "lad_boundary", render: "line", minZoom: 5, nameLabel: true },
  // --- Costs, trend & affordability (group market2) ------------------------
  // Price trend as a bilinear SURFACE like the price heatmaps (raw cells read
  // as an illegible checkerboard at national zoom), but on a DIVERGING ramp —
  // falling blue through near-transparent flat to rising red — because the
  // measure has a meaningful zero that a sequential ramp would bury. Only
  // cells with enough sales in BOTH windows carry trend_pct; the rest are
  // holes the surface fades out around.
  { key: "price_trend", group: "market2", label: "Price trend (12m vs prior 24m)", color: "#2b8a3e", dataset: "price_grid", minZoom: 5, lim: 8000,
    datasetFn: z => z < 8.5 ? "price_grid_l" : z < 11 ? "price_grid_m" : "price_grid_f",
    surface: {
      keyFn: () => "trend_pct",
      // % change -> ramp position; the flat middle (±1.5%) stays pale and
      // translucent so only genuine movement draws the eye.
      stops: [[-10, 0], [-5, 0.2], [-1.5, 0.4], [0, 0.5], [1.5, 0.6], [5, 0.8], [10, 1]],
      colors: [
        [0,   [24, 100, 171, 235]],
        [0.2, [116, 192, 252, 215]],
        [0.4, [214, 226, 235, 150]],
        [0.5, [225, 223, 223, 130]],
        [0.6, [235, 216, 216, 150]],
        [0.8, [255, 135, 135, 215]],
        [1,   [201, 42, 42, 235]],
      ],
    } },
  { key: "build_cost", group: "market2", label: "Build cost index (free proxy)", color: "#e8590c", dataset: "build_cost_index", minZoom: 5 },
  // Zoom-banded: district (ASHE pay) wide out, MSOA household income close in
  // — ~7,200 neighbourhood areas, so a village is priced against ITS residents
  // rather than the nearest city's. Same datasetFn pattern as the price grids.
  { key: "affordability", group: "market2", label: "Affordability (price ÷ income)", color: "#c2255c", dataset: "lad_income", minZoom: 5,
    datasetFn: z => z < 9.5 ? "lad_income" : "msoa_income" },
  // MHCLG/VOA residential land value per hectare — the published benchmark
  // the viability engine's land line uses. England only (source coverage).
  { key: "land_value", group: "market2", label: "Land value (resi £/ha, MHCLG)", color: "#4263eb", dataset: "land_value", minZoom: 5 },
  // Bus network (NaPTAN + BODS GTFS). ~400k stops nationally: the numeric
  // prop filter thins wide zooms to frequent-service stops, so the row cap
  // bites frequency-first rather than arbitrarily. Until the GTFS timetable
  // is loaded stops carry no buses_hr, so they only appear from z14.
  // The network's shape from OSM route=bus relations; frequencies live on
  // the stops (BODS GTFS) — together they read as service, not just streets.
  { key: "bus_route", group: "bus", label: "Bus routes (OSM)", color: "#0c8599", dataset: "bus_route", render: "line", minZoom: 9, lim: 4000 },
  { key: "bus_stop", group: "bus", label: "Bus stops (frequency-coloured)", color: "#1098ad", dataset: "bus_stop", render: "point", minZoom: 10, lim: 8000,
    radius: ["interpolate", ["linear"], ["zoom"], 10, 2, 13, 3.5, 16, 6],
    numFilter: z => z < 12 ? { key: "buses_hr", min: 8 } : z < 14 ? { key: "buses_hr", min: 2 } : null,
    cap: { color: ["case", ["!", ["has", "buses_hr"]], "#868e96",
           ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "buses_hr"]], 0],
            0, "#ced4da", 1, "#96f2d7", 4, "#38d9a9", 8, "#0ca678", 16, "#087f5b"]] } },
  // Power grid
  // Power layers thin by VOLTAGE at wide zooms (via the RPC's numeric prop
  // filter) — a national view shows the 275/400 kV backbone, zooming in adds
  // 132 kV then everything — so the row cap almost never bites arbitrarily.
  // Lines and substations share one ordinal voltage ramp (amber -> deep red,
  // light = local, dark = transmission) so capacity reads as intensity across
  // both layers. Substations split into three toggleable voltage tiers; dot
  // size scales with tier and each dot wears its kV number at closer zooms.
  { key: "power_line",       group: "grid", label: "Transmission & HV lines (OSM)", color: "#e8590c", dataset: "power_line",       render: "line",  minZoom: 5, lim: 8000, voltColor: true,
    numFilter: z => z < 7 ? { key: "kv", min: 200 } : z < 9.5 ? { key: "kv", min: 90 } : null },
  { key: "power_sub_tx",    group: "grid", label: "Substations — transmission (≥200 kV)", color: "#a61e0d", dataset: "power_substation", render: "point", minZoom: 4, lim: 2000,
    kvLabel: true, labelMinZoom: 7,
    radius: ["interpolate", ["linear"], ["zoom"], 5, 5.5, 10, 8, 14, 11],
    numFilter: () => ({ key: "kv", min: 200 }) },
  { key: "power_sub_grid",  group: "grid", label: "Substations — grid (50–200 kV)",       color: "#e8590c", dataset: "power_substation", render: "point", minZoom: 6, lim: 4000,
    kvLabel: true, labelMinZoom: 8.5,
    radius: ["interpolate", ["linear"], ["zoom"], 5, 4, 10, 6, 14, 8.5],
    numFilter: () => ({ key: "kv", min: 50, max: 200 }) },
  { key: "power_sub_local", group: "grid", label: "Substations — local (<50 kV)",          color: "#f59f00", dataset: "power_substation", render: "point", minZoom: 9, lim: 8000,
    kvLabel: true, labelMinZoom: 12,
    radius: ["interpolate", ["linear"], ["zoom"], 8, 2.5, 11, 4, 14, 6],
    numFilter: () => ({ key: "kv", max: 50 }) },
  { key: "gsp_boundary",     group: "grid", label: "Grid Supply Point boundaries",  color: "#845ef7", dataset: "gsp_boundary",     render: "line",  minZoom: 4 },
  // Same polygons, painted by how much generation/demand is already queued
  // inside each supply point (rebuild_gsp_queue sums the TEC register).
  { key: "gsp_queue",        group: "grid", label: "Connection queue by GSP",       color: "#e8590c", dataset: "gsp_boundary",     minZoom: 4 },
  { key: "tec_register",     group: "grid", label: "Connection queue (TEC register)", color: "#1971c2", dataset: "tec_register",   render: "point", minZoom: 5, icon: "plug" },
  // DNO headroom sites paint by their capacity signal, not a flat layer
  // colour: UKPN classifies sites HOT (constrained) / COLD (headroom); NGED
  // publishes a green/amber/red RAG plus the headroom MW itself — which also
  // scales the dot and is written next to it at close zooms.
  { key: "ukpn_sites",       group: "grid", label: "UKPN substation headroom",        color: "#0ca678", dataset: "ukpn_sites",     render: "point", minZoom: 5,
    cap: { color: ["match", ["to-string", ["get", "siteclassification"]],
                   "COLD", "#2f9e44", "HOT", "#e03131", "#868e96"] } },
  { key: "nged_sites",       group: "grid", label: "NGED substation headroom",        color: "#5c940d", dataset: "nged_sites",     render: "point", minZoom: 5, lim: 8000,
    cap: { color: ["match", ["downcase", ["to-string", ["coalesce", ["get", "demandconnectedrag"], ""]]],
                   "green", "#2f9e44", "amber", "#f59f00", "red", "#e03131", "#868e96"],
           mwKey: "demandconnectedheadroommw" } },
  // The other four DNOs, same idea as UKPN/NGED: dots carry the operator's
  // own headroom columns straight into the click card. Flat colours until
  // each portal's vocabulary gets a proper RAG mapping.
  { key: "spen_sites", group: "grid", label: "SPEN substation headroom",       color: "#c2255c", dataset: "spen_sites", render: "point", minZoom: 5, lim: 8000 },
  { key: "npg_sites",  group: "grid", label: "Northern Powergrid headroom",    color: "#7048e8", dataset: "npg_sites",  render: "point", minZoom: 5, lim: 8000 },
  { key: "enwl_sites", group: "grid", label: "Electricity North West headroom", color: "#0b7285", dataset: "enwl_sites", render: "point", minZoom: 5, lim: 8000 },
  { key: "ssen_sites", group: "grid", label: "SSEN substation headroom",       color: "#846358", dataset: "ssen_sites", render: "point", minZoom: 5, lim: 8000 },
  // Site factors
  { key: "alc",                group: "sitefactors", label: "Agricultural land grades (ALC)", color: "#94d82d", dataset: "alc",                minZoom: 7 },
  { key: "water_availability", group: "sitefactors", label: "Water resource availability",    color: "#22b8cf", dataset: "water_availability", minZoom: 6 },
  { key: "ofcom_fibre",        group: "sitefactors", label: "Full-fibre availability (Ofcom)", color: "#1971c2", dataset: "ofcom_fibre",       minZoom: 5 },
  // gridAgg: a continuous 1 km value grid, so it is aggregated to the zoom
  // (grid_in_bbox, migration 0042) rather than row-capped. Capping cut it along
  // a latitude line, because the generic RPC orders by degree-area and a 1 km
  // cell covers more longitude the further north it is.
  { key: "slope_grid",         group: "sitefactors", label: "Ground slope (1 km cells)",       color: "#e8590c", dataset: "slope_grid",        minZoom: 8, lim: 8000, noOutline: true,
    gridAgg: { avgKey: "slope", maxKey: "max_slope" } },
  // Built form is NOT here: a dot per building said nothing about the shape of
  // a place. It is now a footprint layer shaded by height, served from PMTiles
  // (setBuildingsVisible) because 1.5M polygons can't come from a bbox RPC.
  // The building_height POINT dataset stays in map_features, currently unused.
];

// How a public body is described. One copy: this existed three times over
// (two popup builders and the deep-dive card) and had already drifted —
// "Central government" in two of them, "Central government & agencies" in the
// third — so the same parcel read differently depending on where you clicked.
const OWNER_CLASS_LABELS = {
  local_authority: "Local authority", parish: "Parish / town council",
  combined_authority: "Combined authority", nhs: "NHS",
  university: "University", police_fire: "Police / fire",
  government: "Central government & agencies",
  // Rows joined from a published asset register rather than swept from CCOD.
  public_asset_register: "Public body (asset register)",
};

// HOW a parcel was attributed to its owner, and how much that is worth.
// These are NOT equally certain and the map must not imply they are:
//   uprn/coord  the owner itself published a locator for this specific holding
//   contains    a CCOD postcode CENTROID happened to fall inside the parcel
//   nearest     the centroid missed everything and was rescued within 30 m
// A postcode centroid is one point for every title at that postcode, so it can
// stand for at most one parcel however many the body owns there; an asset
// register gives one locator per holding. Ranked so a legend can order them.
const PARCEL_MATCH = {
  coord:    { rank: 0, label: "coordinate published by the owner", tier: "high" },
  uprn:     { rank: 1, label: "UPRN from the owner's asset register", tier: "high" },
  contains: { rank: 2, label: "postcode centroid inside this parcel", tier: "medium" },
  nearest:  { rank: 3, label: "nearest parcel within 30 m of a postcode centroid", tier: "low" },
};
const PARCEL_MATCH_TIER_COLOR = { high: "#2b8a3e", medium: "#f08c00", low: "#c92a2a" };

// A PRECISE LOCATOR IS NOT THE SAME AS A CORRECT PARCEL. The register publishes
// a point; the point falls inside whichever INSPIRE title happens to contain it,
// and a title can be far larger than the holding. Measured on the real join:
// of the 16,120 rows whose register states an area, 43.6% disagree with the
// parcel by more than 5x, and one 0.027 ha holding landed inside a 4,118 ha
// parcel. The 3,164 worst rows are under 10% of the layer but 43% of its area.
// So a flagged row must never show as "high confidence" merely because the
// locator was precise — the locator was; the parcel is the doubtful part.
function parcelConfidence(pr) {
  const m = PARCEL_MATCH[(pr || {}).match];
  if (!m) return null;
  if (pr && pr.area_mismatch) {
    return { tier: "low", color: PARCEL_MATCH_TIER_COLOR.low,
             label: m.label + ", but the parcel's size disagrees with the "
                  + "register — the point may have landed in a larger title" };
  }
  return { tier: m.tier, color: PARCEL_MATCH_TIER_COLOR[m.tier], label: m.label };
}

// "how we know" line for a parcel popup. Unknown match values fall back to the
// old wording rather than rendering a raw enum at the user.
function parcelMatchHTML(pr) {
  const c = parcelConfidence(pr);
  if (!c) return `Indicative — ownership point matched to parcel.`;
  return `<span style="color:${c.color}">●</span> ${_esc(c.tier)} confidence — ${_esc(c.label)}.`;
}

// Layers persist when zooming OUT now: the bbox RPCs take a p_zoom argument
// and simplify geometry to ~1 screen pixel server-side (dropping sub-pixel
// features), so a region-wide fetch stays small. Each layer still has a floor
// via its registry minZoom (dense point-ish layers need one); the default
// floor is low enough that layers survive to a regional view.
// What each layer IS and where it comes from — rendered as a hoverable ⓘ
// tooltip on every Data layers row. Keyed by overlay key; special non-overlay
// rows (deprivation, prices, green belt, stations, transit) are passed
// explicitly in buildLayersPanel.
const LAYER_INFO = {
  green_space:        { about: "Publicly accessible green space — parks, playing fields, allotments, cemeteries.", source: "OS Open Greenspace (OGL v3)" },
  conservation_area:  { about: "Areas of special architectural or historic interest where extra planning controls apply.", source: "Historic England via planning.data.gov.uk (OGL v3)" },
  aonb:               { about: "Areas of Outstanding Natural Beauty / National Landscapes — nationally protected landscapes.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  brownfield:         { about: "Previously developed sites councils have registered as suitable for redevelopment, with indicative dwelling capacity. Sites in public ownership are flagged in the tooltip.", source: "Brownfield land registers, planning.data.gov.uk (OGL v3)" },
  price_heat:         { about: "Median sold price over the last 3 years as one continuous value surface — deep blue cheap through green and yellow to red expensive, resolving from ~35 km countrywide down to ~550 m street blocks as you zoom. Hover anywhere for the exact local median and sale count. Areas with under 3–5 sales fade out rather than guess.", source: "HM Land Registry Price Paid Data © Crown copyright (display use, with attribution)" },
  ppm2_heat:          { about: "£ per m² over the last 3 years as one continuous value surface (blue ~£1k/m² through green/yellow to red £10k+/m²). Where sales address-match an EPC certificate the local value is the median of REAL price ÷ measured floor area (hover says how many matched sales); thin-coverage areas fall back to a property-type estimate marked with ~. EPC matching needs the free account secrets — MANUAL_TASKS 5c.", source: "HM Land Registry Price Paid Data © Crown copyright; MHCLG EPC register (floor areas)" },
  spen_sites:         { about: "SP Energy Networks substations with the operator's published capacity/headroom columns — click a dot for the full record.", source: "SP Energy Networks open data portal (CC-BY/OGL-style licence)" },
  npg_sites:          { about: "Northern Powergrid substations with the operator's published capacity/headroom columns — click a dot for the full record.", source: "Northern Powergrid open data portal" },
  enwl_sites:         { about: "Electricity North West grid & primary substations with published demand headroom — click a dot for the full record.", source: "Electricity North West open data portal" },
  ssen_sites:         { about: "SSEN substations with published network capacity/headroom — click a dot for the full record.", source: "SSEN distribution open data" },
  planit_rates:       { about: "Share of planning applications APPROVED over the last 3 years per authority (approved ÷ (approved + refused); withdrawn excluded). Local decision culture in one number — pair with the Housing Delivery Test for the full NPPF picture.", source: "PlanIt (planit.org.uk) aggregation of council planning registers" },
  gsp_queue:          { about: "Total MW already queued for connection (NESO TEC register) inside each Grid Supply Point boundary — the data-centre developer's 'how contested is this supply point' number. Green = light queue, red/purple = heavily contested. Grey = no queued projects recorded.", source: "Derived: NESO TEC register × GSP boundaries" },
  ofcom_fibre:        { about: "Share of premises with full-fibre (FTTP) available per authority, with gigabit-capable share in the hover. Red = poorly served, green = gigabit-ready.", source: "Ofcom Connected Nations (fixed coverage), OGL" },
  census_students:    { about: "Full-time students (NS-SeC class L15) as a share of adults per authority — the structural PBSA demand base, independent of any one university's numbers.", source: "Census 2021 TS062 via NOMIS (OGL)" },
  student_accom:      { about: "Existing purpose-built student accommodation and dormitories mapped in OpenStreetMap — the PBSA competition map. Coverage reflects OSM mapping quality.", source: "OpenStreetMap contributors (ODbL)" },
  slope_grid:         { about: "Mean ground slope per 1 km cell from OS Terrain 50 (hover shows the steepest 50 m within the cell). Green = flat, red = steep — the data-centre construction-feasibility screen.", source: "OS Terrain 50 © Crown copyright (OGL)" },
  building_height:    { about: "Every building in OpenStreetMap, drawn as its actual footprint, on a cool-to-warm ramp: blue for single-storey through yellow and orange to dark red for towers. Streams nationwide from z13. Height itself is a SAMPLE, not a survey — excellent for landmarks and city centres, patchy across suburbia — so a building OSM has not given a height is drawn in neutral grey rather than left out or guessed at as low rise. Hover to see which.", source: "OpenStreetMap contributors (ODbL)" },
  public_parcel:      { about: "Land parcels in public ownership, from two sources of differing certainty — click a parcel to see which. BEST: a coordinate or UPRN the owner published in its own asset register, which gives one locator per holding. WEAKER: a CCOD ownership record matched to an HMLR INSPIRE parcel by postcode centroid, which can stand for only one parcel per postcode however many the body owns there, with individual flats excluded so a single ex-right-to-buy flat can't claim a whole block. FADED WITH A DASHED EDGE means the parcel's size contradicts the register — the owner's locator is precise but landed in a title far larger (or smaller) than the holding it describes, so the boundary is not trustworthy. Those are kept on the map as leads but excluded from every hectare total and capacity estimate. INDICATIVE either way — the exact title-to-polygon link is HMLR's licensed National Polygon Service.", source: "HM Land Registry CCOD + INSPIRE index polygons © Crown copyright and database right; local authority and Cabinet Office asset registers (OGL); OS Open UPRN © Crown copyright (OGL)" },
  bus_route:          { about: "Every mapped bus route (OpenStreetMap route relations) as lines, with route number and operator on hover. Coverage reflects OSM mapping — dense in urban areas, occasionally patchy on rural services.", source: "OpenStreetMap contributors (ODbL)" },
  bus_stop:           { about: "Every active bus stop (NaPTAN). Once the national timetable is loaded, colour shows weekday daytime frequency (buses/hour, 07:00–19:00) and the tooltip lists the routes serving the stop. Wide zooms show frequent-service stops first.", source: "DfT NaPTAN + Bus Open Data Service timetable (OGL v3)" },
  grey_belt_candidate: { about: "A MODEL, not a designation: Green Belt land that is already previously-developed in character — built-up areas and registered brownfield inside the Green Belt, minus hard environmental designations (SSSI/SAC/SPA/Ramsar/ancient woodland). A first screen for NPPF 'grey belt' potential; always verify against the local plan.", source: "Derived in-database from MHCLG Green Belt × OS built-up areas × brownfield registers" },
  sssi:               { about: "Sites of Special Scientific Interest — statutory wildlife and geology designation; a hard constraint on development.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  sac:                { about: "Special Areas of Conservation — habitat protection under the Habitats Regulations.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  spa:                { about: "Special Protection Areas — statutory protection for bird habitats.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  ramsar:             { about: "Wetlands of international importance under the Ramsar Convention.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  ancient_woodland:   { about: "Woodland continuously present since 1600 — effectively undevelopable.", source: "Natural England via planning.data.gov.uk (OGL v3)" },
  scheduled_monument: { about: "Nationally important archaeological sites with statutory protection.", source: "Historic England via planning.data.gov.uk (OGL v3)" },
  listed_building:    { about: "Listed building outlines (Grades I, II* and II). Dense — zoom in to see them.", source: "Historic England via planning.data.gov.uk (OGL v3)" },
  park_garden:        { about: "Registered historic parks and gardens.", source: "Historic England via planning.data.gov.uk (OGL v3)" },
  flood_zone_2:       { about: "Medium flood probability: land with between 0.1% and 1% annual river flood risk (0.5% sea).", source: "Environment Agency Flood Map for Planning (OGL v3)" },
  flood_zone_3:       { about: "High flood probability: 1%+ annual river flood risk (0.5%+ sea). NPPF steers development away.", source: "Environment Agency Flood Map for Planning (OGL v3)" },
  land_forestry_england:  { about: "Land managed by Forestry England (the public forest estate).", source: "Forestry England open data (OGL v3)" },
  land_forestry_scotland: { about: "Scotland's national forests and land, managed by Forestry & Land Scotland.", source: "Forestry & Land Scotland open data (OGL v3)" },
  land_naturescot:        { about: "Land owned or managed by NatureScot (national nature reserves etc.).", source: "NatureScot open data (OGL v3)" },
  land_crown_estate:      { about: "Crown Estate Scotland's rural, coastal and built estate.", source: "Crown Estate Scotland open data (OGL v3)" },
  land_hes:               { about: "Properties in the care of Historic Environment Scotland.", source: "Historic Environment Scotland open data (OGL v3)" },
  lpa_boundary:        { about: "Local planning authority boundaries — who decides planning applications where. Complete for England.", source: "MHCLG planning.data.gov.uk (OGL v3)" },
  local_plan_boundary: { about: "Adopted and emerging local plan areas. Coverage is still partial — only LPAs that have published to the platform.", source: "MHCLG planning.data.gov.uk (OGL v3)" },
  article4:            { about: "Article 4 directions removing permitted development rights — often HMO conversion, so a strong student-housing pressure signal.", source: "MHCLG planning.data.gov.uk (OGL v3)" },
  tpo_zone:            { about: "Tree preservation order zones.", source: "MHCLG planning.data.gov.uk (OGL v3)" },
  design_code_area:    { about: "Areas covered by an adopted design code.", source: "MHCLG planning.data.gov.uk (OGL v3)" },
  uni_campus:          { about: "One dot per registered HE provider (the HQ). Click a dot for the PBSA deep-dive card: student numbers, international share and the term-time accommodation mix (private halls vs HMO vs living at home).", source: "UKRLP locations; HESA DT051 Tables 1 & 57, 2024/25 (CC-BY 4.0)" },
  uni_campus_site:     { about: "University campus grounds — the actual site extents, so multi-campus institutions show every campus, not just the HQ dot.", source: "© OpenStreetMap contributors (ODbL)" },
  uni_building:        { about: "Individual university building footprints. Zoom in close — these are dense.", source: "© OpenStreetMap contributors (ODbL)" },
  ptal:                { about: "Public Transport Accessibility Level on a 100 m grid, coloured by grade — blues are poorly connected (0–1b), greens/yellows mid (2–3), oranges/reds excellent (4–6b). Greater London only. Every cell in view is drawn — no sampling — which is why it needs a close zoom: the full 100 m grid is 159,451 cells and a wider view cannot be served from the database fast enough.", source: "TfL PTAL 2023 via ArcGIS Hub (OGL)" },
  la_rents:            { about: "Average monthly private rents by local authority, shaded light (cheapest, ~£500) to deep teal (most expensive, £3,000+). Hover a district for its figure and annual change.", source: "ONS Price Index of Private Rents (OGL v3)" },
  price_trend:         { about: "Whether local sale prices are rising or falling: median of the last 12 months against the median of the 24 months before, per grid cell. Blue = falling, red = rising; cells without at least 5 sales in BOTH windows stay blank rather than faking a flat market.", source: "HM Land Registry Price Paid Data (OGL v3)" },
  build_cost:          { about: "Relative construction cost by local authority — a FREE PROXY assembled from ONS construction output indices and openly published regional factors, not BCIS (which is a paid RICS product). Green = cheaper than the national average, red = dearer. Every figure can be overridden per project in Viability variables; a client with BCIS access can paste their own numbers there.", source: "ONS construction output price indices + published regional factors (proxy)" },
  affordability:       { about: "Median sale price (last 12 months) divided by local income. Zoomed out: district level, against residents' median gross pay (ONS ASHE). Zoomed in (z9.5+): neighbourhood level — ~7,200 MSOAs of ~4,000 households — against HOUSEHOLD income (ONS small area income estimates), so a village is measured against its own residents rather than the nearest city's. 4× is the classic mortgageable benchmark; 12×+ severe. Areas with suppressed income data or too few sales stay grey.", source: "HM Land Registry Price Paid + ONS ASHE / ONS small area income estimates (all OGL v3)" },
  lad_boundary:        { about: "Local authority district boundaries.", source: "ONS Open Geography Portal (OGL v3)" },
  power_line:          { about: "High-voltage lines, coloured and weight-scaled by voltage — deep red is the 275/400 kV transmission backbone, orange 90–200 kV, amber below. Wide zooms show the backbone; zoom in for the rest. Click a line for its details.", source: "© OpenStreetMap contributors (ODbL)" },
  power_sub_tx:        { about: "Transmission-scale substations (≥200 kV) — where the national grid itself can be tapped. The biggest dots; each shows its kV. Click one for details.", source: "© OpenStreetMap contributors (ODbL)" },
  power_sub_grid:      { about: "Grid & primary substations (50–200 kV) — the realistic connection points for large developments. Dots show their kV as you zoom. Click one for details.", source: "© OpenStreetMap contributors (ODbL)" },
  power_sub_local:     { about: "Local distribution substations below 50 kV (and sites with no tagged voltage) — the street-level network. Dense: zoom right in.", source: "© OpenStreetMap contributors (ODbL)" },
  gsp_boundary:        { about: "Grid Supply Point boundaries — where the national transmission grid hands over to regional distribution networks.", source: "NESO Data Portal (open licence)" },
  tec_register:        { about: "The transmission connection queue: projects holding capacity agreements, with MW and status. Shows where the grid is contested.", source: "NESO TEC Register (open licence)" },
  ukpn_sites:          { about: "UK Power Networks grid & primary substations, coloured by the DNO's demand classification — green COLD sites have headroom, red HOT sites are constrained. London, the South East and East. Click a site for full details.", source: "UK Power Networks Open Data (opendatasoft)" },
  nged_sites:          { about: "National Grid Electricity Distribution primary & bulk supply substations, coloured by their demand RAG (green/amber/red) and sized by connected headroom — the MW figure appears beside each site as you zoom in. Midlands, South West and South Wales. Click a site for full details.", source: "NGED Connected Data portal" },
  alc:                 { about: "Agricultural Land Classification, coloured by grade — deep green Grade 1 (best and most versatile, policy steers development away) through amber Grade 4 and brown Grade 5; greys are urban/non-agricultural.", source: "Natural England (OGL v3)" },
  la_property:         { about: "Property titles owned by public bodies — councils, parishes, combined authorities, NHS, universities, police/fire and central government — aggregated to postcode points with a title count, coloured by owner type. Indicative locations (postcode centroids), not boundaries — parcel outlines come in a later phase.", source: "HM Land Registry CCOD © Crown copyright and database right 2026; OS Code-Point Open (OGL)" },
  water_availability:  { about: "Whether water is available for new abstraction licences, by catchment — green available, amber restricted, red not available. A proxy for large-scale water supply feasibility.", source: "Environment Agency CAMS (OGL v3)" },
  ppd_sales:           { about: "Every registered property sale in the last 12 months as a dot, colour-ramped from amber (~£100k) to deep red (£1.5m+). Street-level price truth beneath the LSOA averages. Positions are postcode-centroid based. Zoom right in — it's dense.", source: "HM Land Registry Price Paid Data © Crown copyright (PPD licence); OS Code-Point Open" },
  hdt:                 { about: "The Housing Delivery Test: each authority's housing delivery vs target. Red (<75%) triggers the NPPF presumption in favour of sustainable development — the strongest single approval signal; orange = 20% buffer; amber = action plan; green = passing.", source: "MHCLG Housing Delivery Test measurement (OGL v3)" },
  land_value:          { about: "The value per hectare of a typical residential site in each English authority, from the government's official policy-appraisal estimates — pale blue ~£0.5M/ha rural, deep violet £10M+, grape £50M+ central London. This is the published benchmark the viability engine's land line uses. Estimates for appraisal, not valuations of specific sites.", source: "MHCLG/VOA land value estimates for policy appraisal 2023 (OGL v3)" },
};

const OVERLAY_MIN_ZOOM = 7;           // default floor; per-layer minZoom overrides
const OVERLAY_DEFAULT_OPACITY = 0.32; // fill opacity a fresh overlay starts at

// Shared flats/houses filter for the market layers (price heat, £/m² heat,
// individual sales). One state, three layers: comparing "flats here vs houses
// there" with per-layer filters would be a trap. localStorage direct rather
// than mmStore, which is declared much later in the file.
let marketPtype = (() => {
  try { return localStorage.getItem("mm.marketPtype") || "all"; }
  catch (_) { return "all"; }
})();

function setMarketPtype(v) {
  marketPtype = v === "houses" || v === "flats" ? v : "all";
  try { localStorage.setItem("mm.marketPtype", marketPtype); } catch (_) {}
  // Surface layers: re-rasterise from the cached cells — the per-type
  // medians are already in the loaded features, so this never refetches.
  for (const o of MAP_OVERLAYS) {
    const st = overlayState[o.key];
    if (o.surface && st && st.on && st.surfaceFC)
      renderGridSurface(o.key, o, st.surfaceFC);
  }
  // Individual sales: a client-side layer filter. The row cap applies BEFORE
  // this filter, so a flats-only view in a dense area may undersample — the
  // layer's z14+ floor keeps that mostly theoretical, and the popup always
  // shows the true type of what is drawn.
  const salesFilter = marketPtype === "houses"
    ? ["match", ["get", "ptype"], ["D", "S", "T"], true, false]
    : marketPtype === "flats"
    ? ["==", ["get", "ptype"], "F"]
    : null;
  if (map.getLayer("ov-ppd_sales-pt"))
    map.setFilter("ov-ppd_sales-pt", salesFilter);
}
const OVERLAY_FETCH_MARGIN = 0.3;     // pad each fetch 30% beyond the viewport
const overlayState = {};              // key -> { on, opacity, fetched:{w,s,e,n,z} }

// Per-layer zoom floors (small/dense features need closer zooms; big statutory
// designations can show from the national view thanks to simplification).
const OVERLAY_MIN_ZOOMS = {
  green_space: 9, conservation_area: 8, aonb: 5, brownfield: 9,
  sssi: 5, sac: 5, spa: 5, ramsar: 5, ancient_woodland: 8,
  scheduled_monument: 9, listed_building: 11, park_garden: 8,
  flood_zone_2: 8, flood_zone_3: 8,
  land_forestry_england: 5, land_forestry_scotland: 5, land_naturescot: 5,
  land_crown_estate: 5, land_hes: 8,
};
function overlayMinZoom(key) {
  const def = overlayDef(key);
  return (def && def.minZoom) ?? OVERLAY_MIN_ZOOMS[key] ?? OVERLAY_MIN_ZOOM;
}
let _overlayMoveWired = false;
let _overlayMoveTimer = null;

function overlayDef(key) { return MAP_OVERLAYS.find(o => o.key === key); }

function anyOverlayOn() { return MAP_OVERLAYS.some(o => overlayState[o.key] && overlayState[o.key].on); }

function toggleMapOverlay(key, on) {
  const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
  st.on = on;
  if (on) {
    if (!_overlayMoveWired && typeof map !== "undefined") {
      map.on("moveend", () => {
        clearTimeout(_overlayMoveTimer);
        _overlayMoveTimer = setTimeout(refreshMapOverlays, 250);
      });
      _overlayMoveWired = true;
    }
    fetchMapOverlay(key);
  } else {
    st.fetched = null;      // a re-toggle refetches fresh
    removeOverlayLayers(key);
    const stat = document.getElementById(`ov-stat-${key}`);
    if (stat) stat.textContent = "";
  }
}

// Live transparency for one overlay (Data layers slider). The outline scales
// with the fill so a faded layer fades as a whole.
function setOverlayOpacity(key, v) {
  const st = overlayState[key] || (overlayState[key] = {});
  st.opacity = v;
  const def = overlayDef(key);
  if (map.getLayer(`ov-${key}-fill`))
    // Re-apply the provisional fade rather than a flat number: a plain `v` here
    // would overwrite the case expression and make untrusted geometry look
    // exactly as solid as verified geometry the moment the slider is touched.
    map.setPaintProperty(`ov-${key}-fill`, "fill-opacity",
      def && def.provisional ? ["case", def.provisional, v * 0.28, v] : v);
  if (map.getLayer(`ov-${key}-line-dashed`))
    map.setPaintProperty(`ov-${key}-line-dashed`, "line-opacity", Math.min(0.9, v * 2.2));
  if (map.getLayer(`ov-${key}-line`)) {
    const lineAlpha = def && def.render === "line" ? Math.min(1, v * 2.5) : Math.min(0.9, v * 2.2);
    map.setPaintProperty(`ov-${key}-line`, "line-opacity", lineAlpha);
  }
  if (map.getLayer(`ov-${key}-heat`))
    // Surface layers use the same -heat layer id but it's a raster now.
    map.setPaintProperty(`ov-${key}-heat`,
      def && def.surface ? "raster-opacity" : "heatmap-opacity", Math.min(1, v * 2.2));
  if (map.getLayer(`ov-${key}-pt`) && !(def && def.surface)) {
    map.setPaintProperty(`ov-${key}-pt`, "circle-opacity", Math.min(1, v * 2.5));
    map.setPaintProperty(`ov-${key}-pt`, "circle-stroke-opacity", Math.min(1, v * 2.5));
  }
  if (map.getLayer(`ov-${key}-icon`))
    map.setPaintProperty(`ov-${key}-icon`, "icon-opacity", Math.min(1, v * 2.5));
  if (map.getLayer(`ov-${key}-lbl`))
    map.setPaintProperty(`ov-${key}-lbl`, "text-opacity", Math.min(1, v * 2.5));
  if (map.getLayer(`ov-${key}-name`))
    map.setPaintProperty(`ov-${key}-name`, "text-opacity", Math.min(1, v * 2.6));
}

function refreshMapOverlays() {
  MAP_OVERLAYS.forEach(o => { if (overlayState[o.key] && overlayState[o.key].on) fetchMapOverlay(o.key); });
}

// Overlay fetch scheduler. With a dozen layers on, every pan used to fire a
// dozen simultaneous geometry queries — a stampede that starves the database
// connection pool and turns into a wall of 'err'. Cap what runs at once
// (queued layers follow as slots free), drop stale responses (newest request
// per layer wins), and retry a failed fetch once before showing an error.
const _ovQueue = [];
let _ovInFlight = 0;
const OV_MAX_CONCURRENT = 4;

function fetchMapOverlay(key) {
  const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
  st.reqSeq = (st.reqSeq || 0) + 1;
  if (!_ovQueue.includes(key)) _ovQueue.push(key);
  _ovPump();
}

function _ovPump() {
  while (_ovInFlight < OV_MAX_CONCURRENT && _ovQueue.length) {
    const key = _ovQueue.shift();
    _ovInFlight++;
    _fetchMapOverlayNow(key)
      .catch(() => {})
      .finally(() => { _ovInFlight--; _ovPump(); });
  }
}

async function _fetchMapOverlayNow(key, attempt = 0) {
  const def = overlayDef(key);
  const stat = document.getElementById(`ov-stat-${key}`);
  if (!def || typeof map === "undefined") return;
  const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
  const mySeq = st.reqSeq;
  if (!st.on) return;                    // toggled off while queued
  // Tile-served layers have no per-viewport fetch at all: MapLibre pulls the
  // range requests it needs straight from the PMTiles file. They deliberately
  // reuse the ov-<key>-* layer ids so the tap dispatcher, the opacity slider
  // and removeOverlayLayers keep working untouched.
  if (def.tiles) { await ensureOverlayTiles(key, def); return; }
  const zoom = map.getZoom();
  if (zoom < overlayMinZoom(key)) {
    st.fetched = null;
    removeOverlayLayers(key);
    if (stat) stat.textContent = "zoom in";
    return;
  }
  const sb = (typeof getSupabase === "function") ? getSupabase() : null;
  if (!sb) { if (stat) stat.textContent = "n/a"; return; }
  const b = map.getBounds();
  const vw = b.getWest(), vs = b.getSouth(), ve = b.getEast(), vn = b.getNorth();
  // Fetch cache: if the view is still inside the last padded fetch bbox AND we
  // haven't zoomed in far past the detail level it was fetched at, the data on
  // the map already covers it — no request. (Server-side geometry is
  // simplified to ~1px at the fetch zoom, so zooming IN more than ~1.5 levels
  // needs a refetch for crisper detail; zooming OUT grows the bbox and
  // triggers a refetch naturally.)
  const zsnap = Math.round(zoom * 2) / 2;
  const nf = def.numFilter ? def.numFilter(zoom) : null;
  const nfMin = nf ? (nf.min ?? null) : null;
  const nfMax = nf ? (nf.max ?? null) : null;
  // Zoom-banded datasets (the price heatmap's per-resolution grids): the
  // dataset itself changes with zoom, so it joins the cache key.
  const ds = def.datasetFn ? def.datasetFn(zoom) : def.dataset;
  const c = st.fetched;
  if (c && vw >= c.w && vs >= c.s && ve <= c.e && vn <= c.n && zsnap <= c.z + 1.5
      && (c.nfMin ?? null) === nfMin && (c.nfMax ?? null) === nfMax
      && (c.ds ?? null) === (ds ?? null)) return;
  const dw = (ve - vw) * OVERLAY_FETCH_MARGIN, dh = (vn - vs) * OVERLAY_FETCH_MARGIN;
  const w = vw - dw, s = vs - dh, e = ve + dw, n = vn + dh;
  if (stat) stat.textContent = "…";
  try {
    // p_zoom drives server-side per-pixel simplification. Past z13 geometry is
    // effectively full-detail anyway, so cap what we ask for.
    const p_zoom = Math.min(zsnap, 13);
    const { data, error } = def.brownfield
      ? await sb.rpc("brownfield_in_bbox", { w, s, e, n, p_zoom })
      : def.ownership
      ? await sb.rpc("land_ownership_in_bbox", { p_bodies: def.bodies || null, w, s, e, n, p_zoom })
      // Regular value grids aggregate to the zoom instead of being row-capped.
      // features_in_bbox ends with `order by size_metric desc limit`, and
      // size_metric is area in SQUARE degrees — which grows with latitude, so
      // on a uniform metric grid that ordering is "northernmost first" and the
      // cap sliced the layer along a horizontal line.
      : def.gridAgg && ds
      ? await sb.rpc("grid_in_bbox", { p_dataset: ds, w, s, e, n, p_zoom,
          lim: def.lim || 8000,
          p_avg_key: def.gridAgg.avgKey || null,
          p_max_key: def.gridAgg.maxKey || null })
      : ds
      ? await sb.rpc("features_in_bbox", { p_dataset: ds, w, s, e, n, p_zoom,
          lim: def.lim || 4000,
          p_num_key: nf ? nf.key : null, p_num_min: nfMin, p_num_max: nfMax })
      : await sb.rpc("constraints_in_bbox", { p_kinds: def.kinds, w, s, e, n, p_zoom });
    if (error) throw error;
    // A newer request for this layer started while we were in flight (fast
    // panning) — its result supersedes this one; don't paint stale data.
    if (st.reqSeq !== mySeq || !st.on) return;
    const fc = data || { type: "FeatureCollection", features: [] };
    if (!Array.isArray(fc.features)) fc.features = [];
    st.fetched = { w, s, e, n, z: zsnap, nfMin, nfMax, ds };
    renderOverlay(key, def, fc);
    // A count AT the row cap almost certainly means truncation — say so.
    const cap = def.lim || (def.dataset ? 4000 : def.ownership ? 3000 : 1500);
    if (stat) stat.textContent = fc.features.length >= cap
      ? `${fc.features.length.toLocaleString()}+` : `${fc.features.length.toLocaleString()}`;
  } catch (err) {
    if (st.reqSeq !== mySeq || !st.on) return;   // superseded — stay quiet
    if (attempt === 0) {
      // One retry after a beat: most failures here are a momentarily busy
      // database, and the map keeps whatever it already has meanwhile.
      if (stat) stat.textContent = "retrying…";
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      if (st.reqSeq === mySeq && st.on) return _fetchMapOverlayNow(key, 1);
      return;
    }
    console.error("overlay fetch failed", key, err);
    if (stat) stat.textContent = "err";
  }
}

// Keep station dots (and the developable layers) above overlays so they stay
// clickable: insert overlay fills beneath the first station/dot layer if present.
function overlayBeforeId() {
  for (const id of ["station-dot", "station-label", "developable-fill"]) {
    if (map.getLayer(id)) return id;
  }
  return undefined;
}

// ---- Overlay point icons ---------------------------------------------------
// Small colour-badged glyphs so different point layers stay tellable apart when
// several are on at once. Pure inline SVG -> data URI -> map.addImage; no
// external assets. One image per overlay key (glyph + that layer's colour).
const ICON_GLYPHS = {
  bolt: '<path d="M14.6 3.5 7.4 14.6h4.3l-1.6 8 7.5-11.7h-4.4l1.4-7.4Z" fill="#fff"/>',
  plug: '<path d="M9.3 4.5v4h2.1v-4H9.3Zm5.3 0v4h2.1v-4h-2.1ZM8 9.8v3.1a5 5 0 0 0 3.9 4.9v3.7h2.2v-3.7a5 5 0 0 0 3.9-4.9V9.8H8Z" fill="#fff"/>',
  uni:  '<path d="M13 5.4 3.4 10 13 14.6 22.6 10 13 5.4Zm-5.6 7.4v3.5c0 1.6 2.5 2.9 5.6 2.9s5.6-1.3 5.6-2.9v-3.5L13 15.9l-5.6-3.1Z" fill="#fff"/>',
  town: '<path d="M8.1 5.2h9.8v16h-3.2v-4.2h-3.4v4.2H8.1v-16Zm2.4 2.9v2.1h2v-2.1h-2Zm5 0v2.1h-2v-2.1h2Zm-5 4.2v2.1h2v-2.1h-2Zm5 0v2.1h-2v-2.1h2Z" fill="#fff"/>',
};
function ensureOverlayIcons() {
  MAP_OVERLAYS.filter(o => o.icon && ICON_GLYPHS[o.icon]).forEach(o => {
    const id = `ovicon-${o.key}`;
    if (map.hasImage && map.hasImage(id)) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26">` +
      `<circle cx="13" cy="13" r="11.6" fill="${o.color}" stroke="#ffffff" stroke-width="1.7"/>` +
      ICON_GLYPHS[o.icon] + `</svg>`;
    const img = new Image(52, 52);
    img.onload = () => { try { if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 }); } catch (_) {} };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Grid cells -> centre points, so a "heatmap" layer can draw them as big
// soft-edged circles whose overlaps blend into a flowing gradient instead of
// hard rectangles. Cells are axis-aligned rectangles, so the ring average IS
// the centre.
function _cellsToPoints(fc) {
  return { type: "FeatureCollection", features: (fc.features || []).map(f => {
    const g = f.geometry;
    const ring = g && (g.type === "Polygon" ? g.coordinates[0]
                : g.type === "MultiPolygon" ? g.coordinates[0][0] : null);
    if (!ring || !ring.length) return f;
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    return { type: "Feature", properties: f.properties,
             geometry: { type: "Point", coordinates: [sx / ring.length, sy / ring.length] } };
  }) };
}

// ---- Grid value surface (bilinear canvas raster) ---------------------------
// The price grids are uniform VALUE lattices, and a kernel-density heatmap can
// never render one smoothly: however the radius is tuned, the sum of round
// kernels oscillates between cell centres (it peaked as banded stripes on the
// Mercator-stretched vertical spacing). The right primitive is interpolation
// of the values themselves: rasterise the lattice with bilinear interpolation
// onto a canvas, hand it to MapLibre as an image source, and let the GPU
// stretch it under the map. Colour then MEANS price — same number, same
// colour, at every zoom — and the surface is smooth by construction.

// Spectral ramp for the surface, position t in 0..1 -> RGBA. Low end keeps
// some transparency so cold areas sit lightly on the basemap.
const SURFACE_COLORS = [
  [0.06, [49, 54, 149, 115]],
  [0.18, [69, 117, 180, 153]],
  [0.3,  [116, 173, 209, 173]],
  [0.42, [171, 217, 233, 184]],
  [0.52, [224, 243, 248, 191]],
  [0.6,  [255, 255, 191, 210]],
  [0.7,  [254, 224, 144, 220]],
  [0.79, [253, 174, 97, 228]],
  [0.87, [244, 109, 67, 235]],
  [0.94, [215, 48, 39, 242]],
  [1,    [165, 0, 38, 248]],
];
// LUTs are cached per colour-stop array, so each surface layer can carry its
// own ramp (spectral for prices, diverging for the trend) at zero per-pixel
// cost.
const _surfaceLUTs = new Map();
function surfaceLUT(colors) {
  const ramp = colors || SURFACE_COLORS;
  let lut = _surfaceLUTs.get(ramp);
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = ramp[0], b = ramp[ramp.length - 1];
    for (let s = 0; s < ramp.length - 1; s++) {
      if (t >= ramp[s][0] && t <= ramp[s + 1][0]) {
        a = ramp[s]; b = ramp[s + 1]; break;
      }
    }
    const f = t <= a[0] ? 0 : t >= b[0] ? 1 : (t - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 4; c++)
      lut[i * 4 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
  }
  _surfaceLUTs.set(ramp, lut);
  return lut;
}

// Value -> ramp position via the layer's piecewise-linear stops (clamped).
function surfaceT(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, t0] = stops[i], [v1, t1] = stops[i + 1];
    if (v >= v0 && v <= v1) return t0 + (t1 - t0) * ((v - v0) / (v1 - v0));
  }
  return last[1];
}

// Image sources map linearly in MERCATOR between their corner coordinates, so
// canvas rows must be sampled at equal Mercator-y steps (and converted back to
// latitude to index the degree lattice) — sampling rows linearly in latitude
// would shear the whole surface north at UK latitudes.
const _mercY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const _invMercY = y => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

// Rasterise one fetched grid FeatureCollection into the layer's image overlay.
// Missing cells (privacy floor, no sales, or the selected flats/houses split
// absent) are NaN in the lattice; bilinear samples renormalise over whichever
// of their 4 surrounding centres exist, and the summed corner weight doubles
// as an alpha fade — so the surface dissolves softly at its data edge instead
// of ending in a hard staircase.
function renderGridSurface(key, def, fc) {
  const imgSrcId = `ov-${key}-img`, rasterId = `ov-${key}-heat`;
  const valKey = def.surface.keyFn(marketPtype);
  const cells = [];
  let res = 0;
  for (const f of fc.features || []) {
    const g = f.geometry;
    const ring = g && (g.type === "Polygon" ? g.coordinates[0]
                : g.type === "MultiPolygon" ? g.coordinates[0][0] : null);
    if (!ring || !ring.length) continue;
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    // Finite is the only requirement — the trend surface is legitimately
    // negative (falling market) or zero; a v > 0 guard here would erase
    // every falling cell. Absent props still parse to NaN and stay holes.
    const v = f.properties && f.properties[valKey] != null
      ? Number(f.properties[valKey]) : NaN;
    if (!res && f.properties && Number(f.properties.res) > 0)
      res = Number(f.properties.res);
    cells.push([sx / ring.length, sy / ring.length, Number.isFinite(v) ? v : NaN]);
  }
  const usable = cells.filter(c => Number.isFinite(c[2]));
  if (!usable.length || !res) {
    if (map.getLayer(rasterId)) map.removeLayer(rasterId);
    if (map.getSource(imgSrcId)) map.removeSource(imgSrcId);
    return;
  }
  let minLonC = Infinity, maxLonC = -Infinity, minLatC = Infinity, maxLatC = -Infinity;
  for (const [lon, lat] of cells) {
    if (lon < minLonC) minLonC = lon; if (lon > maxLonC) maxLonC = lon;
    if (lat < minLatC) minLatC = lat; if (lat > maxLatC) maxLatC = lat;
  }
  const nx = Math.round((maxLonC - minLonC) / res) + 1;
  const ny = Math.round((maxLatC - minLatC) / res) + 1;
  if (nx < 1 || ny < 1 || nx > 600 || ny > 600) return;   // malformed fetch — keep last image
  const grid = new Float64Array(nx * ny).fill(NaN);
  for (const [lon, lat, v] of cells) {
    const ix = Math.round((lon - minLonC) / res), iy = Math.round((lat - minLatC) / res);
    if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) grid[iy * nx + ix] = v;
  }
  // Image extent = outer cell EDGES (centres ± half a cell).
  const lon0 = minLonC - res / 2, lon1 = maxLonC + res / 2;
  const lat0 = minLatC - res / 2, lat1 = maxLatC + res / 2;
  const px = Math.max(3, Math.min(14, Math.floor(1600 / Math.max(nx, ny))));
  const W = nx * px, H = ny * px;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const data = img.data, lut = surfaceLUT(def.surface.colors), stops = def.surface.stops;
  // Column lattice positions are linear in lon; precompute once.
  const gxs = new Float64Array(W);
  for (let i = 0; i < W; i++)
    gxs[i] = (lon0 + ((i + 0.5) / W) * (lon1 - lon0) - minLonC) / res;
  const yTop = _mercY(lat1), yBot = _mercY(lat0);
  for (let j = 0; j < H; j++) {
    const lat = _invMercY(yTop + ((j + 0.5) / H) * (yBot - yTop));
    const gy = (lat - minLatC) / res;
    const y0 = Math.floor(gy), fy = gy - y0;
    for (let i = 0; i < W; i++) {
      const gx = gxs[i];
      const x0 = Math.floor(gx), fx = gx - x0;
      let wsum = 0, vsum = 0;
      for (let dy = 0; dy <= 1; dy++) {
        const cy = y0 + dy;
        if (cy < 0 || cy >= ny) continue;
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx <= 1; dx++) {
          const cx = x0 + dx;
          if (cx < 0 || cx >= nx) continue;
          const v = grid[cy * nx + cx];
          if (Number.isNaN(v)) continue;
          const w = wy * (dx ? fx : 1 - fx);
          wsum += w; vsum += w * v;
        }
      }
      const o = (j * W + i) * 4;
      if (wsum > 1e-9) {
        const ci = Math.round(surfaceT(stops, vsum / wsum) * 255) * 4;
        data[o] = lut[ci]; data[o + 1] = lut[ci + 1]; data[o + 2] = lut[ci + 2];
        data[o + 3] = Math.round(lut[ci + 3] * Math.min(1, wsum));
      }
      // else: all four corners missing — pixel stays transparent (zero-init).
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  const coordinates = [[lon0, lat1], [lon1, lat1], [lon1, lat0], [lon0, lat0]];
  const src = map.getSource(imgSrcId);
  if (src) {
    src.updateImage({ url, coordinates });
  } else {
    map.addSource(imgSrcId, { type: "image", url, coordinates });
  }
  if (!map.getLayer(rasterId)) {
    const opacity = overlayState[key]?.opacity ?? OVERLAY_DEFAULT_OPACITY;
    map.addLayer({ id: rasterId, type: "raster", source: imgSrcId,
      paint: { "raster-opacity": Math.min(1, opacity * 2.2),
               "raster-resampling": "linear",
               "raster-fade-duration": 0 } }, overlayBeforeId());
  }
}

// Stand up (or tear down) a PMTiles-backed overlay. Used where a dataset is too
// large to serve per viewport from Postgres — PTAL is a 100 m grid of 159,451
// cells, and the bbox RPC needed 20.8 s and 14 MB for a single z12 view because
// it spends ~400 us per feature building JSON. Tiles cost the database nothing
// per view and are complete at every zoom.
//
// The layer ids are the SAME ov-<key>-fill / -line the geojson path uses, so the
// tap dispatcher, opacity slider, attribution and teardown all work unchanged.
async function ensureOverlayTiles(key, def) {
  const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
  const stat = document.getElementById(`ov-stat-${key}`);
  const srcId = `ov-${key}-src`, fillId = `ov-${key}-fill`, lineId = `ov-${key}-line`;
  const cfg = window.MASTERMAPPER_CONFIG || {};
  if (!cfg.SUPABASE_URL) { if (stat) stat.textContent = "n/a"; return; }
  const url = `${cfg.SUPABASE_URL}/storage/v1/object/public/tiles/${def.tiles.file}`;
  // Probe once. A missing tile file should say so plainly rather than leaving an
  // enabled layer that silently draws nothing.
  if (st.tilesAvailable === undefined) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      st.tilesAvailable = r.ok;
    } catch (_) { st.tilesAvailable = false; }
  }
  if (!st.tilesAvailable) {
    if (stat) stat.textContent = "tiles not built yet";
    return;
  }
  if (!map.getSource(srcId))
    map.addSource(srcId, { type: "vector", url: "pmtiles://" + url });
  const opacity = st.opacity ?? OVERLAY_DEFAULT_OPACITY;
  const before = overlayBeforeId();
  if (!map.getLayer(fillId))
    map.addLayer({ id: fillId, type: "fill", source: srcId,
      "source-layer": def.tiles.sourceLayer || key,
      paint: { "fill-color": (def.cap && def.cap.color) || def.color,
               "fill-opacity": opacity } }, before);
  // Outline only close in: on a dense grid at wide zoom, borders would read as
  // a mesh rather than a surface.
  if (!map.getLayer(lineId) && def.tiles.outlineFromZoom != null)
    map.addLayer({ id: lineId, type: "line", source: srcId,
      "source-layer": def.tiles.sourceLayer || key,
      minzoom: def.tiles.outlineFromZoom,
      paint: { "line-color": "#ffffff", "line-width": 0.3,
               "line-opacity": 0.35 * opacity } }, before);
  if (stat) stat.textContent = `streams from z${def.tiles.minzoom ?? 0}`;
  updateOverlayAttribution();
}

function renderOverlay(key, def, fc) {
  const srcId = `ov-${key}-src`, fillId = `ov-${key}-fill`, lineId = `ov-${key}-line`,
        ptId = `ov-${key}-pt`, dashId = `ov-${key}-line-dashed`;
  if (def.surface) {
    // Value-surface layers: the visible pixels come from the canvas raster
    // (renderGridSurface); the geojson source only carries invisible centre
    // circles so hover/click popups keep working. Cache the raw cells so a
    // flats/houses switch re-rasterises without a refetch.
    const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
    st.surfaceFC = fc;
    renderGridSurface(key, def, fc);
    const pts = _cellsToPoints(fc);
    if (map.getSource(srcId)) { map.getSource(srcId).setData(pts); return; }
    map.addSource(srcId, { type: "geojson", data: pts });
    map.addLayer({ id: ptId, type: "circle", source: srcId,
      paint: { "circle-radius": ["interpolate", ["exponential", 2], ["zoom"],
                 4, 3, 6.4, 15, 6.5, 4, 8.4, 15, 8.5, 4, 10.9, 21,
                 11, 6, 13, 22, 15, 60],
               "circle-color": "#000000", "circle-opacity": 0,
               "circle-stroke-width": 0 } }, overlayBeforeId());
    return;
  }
  if (map.getSource(srcId)) {
    map.getSource(srcId).setData(fc);
    return;
  }
  const opacity = overlayState[key]?.opacity ?? OVERLAY_DEFAULT_OPACITY;
  map.addSource(srcId, { type: "geojson", data: fc });
  const before = overlayBeforeId();
  if (def.render === "point") {
    // Point dataset (campuses, substations, connection queue): circles that
    // scale slightly with zoom; opacity slider drives circle+stroke alpha.
    // Substation tiers pass their own radius curve so bigger sites = bigger dots.
    const iconId = `ovicon-${key}`;
    const hasIcon = def.icon && map.hasImage && map.hasImage(iconId);
    // Capacity-scaled radius (DNO headroom sites): dot area tracks the MW of
    // headroom, multiplied by a zoom factor (the ["zoom"] interpolate must be
    // the outer expression — same pattern as the station-usage dots).
    let radius = def.radius || ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 4.5, 14, 7];
    if (def.cap && def.cap.mwKey) {
      const mwCurve = ["interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", def.cap.mwKey]], 0],
        0, 3, 5, 4.2, 20, 5.5, 60, 7, 150, 9];
      radius = ["interpolate", ["linear"], ["zoom"],
        5, ["*", mwCurve, 0.7], 10, ["*", mwCurve, 1.1], 14, ["*", mwCurve, 1.5]];
    }
    map.addLayer({ id: ptId, type: "circle", source: srcId,
      // With an icon variant the plain dot only carries the far zooms.
      ...(hasIcon ? { maxzoom: 9 } : {}),
      paint: {
        "circle-radius": radius,
        "circle-color": (def.cap && def.cap.color) || def.color,
        "circle-opacity": Math.min(1, opacity * 2.5),
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
        "circle-stroke-opacity": Math.min(1, opacity * 2.5),
      } }, before);
    // The comparables layer honours the shared flats/houses filter from the
    // moment it is created, not only after the control is next touched.
    if (key === "ppd_sales" && marketPtype !== "all") setMarketPtype(marketPtype);
    if (hasIcon) {
      map.addLayer({ id: `ov-${key}-icon`, type: "symbol", source: srcId, minzoom: 9,
        layout: {
          "icon-image": iconId, "icon-allow-overlap": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 12, 0.8, 15, 1],
        },
        paint: { "icon-opacity": Math.min(1, opacity * 2.5) } }, before);
    }
    // Headroom figure written next to the dot at close zooms.
    if (def.cap && def.cap.mwKey) {
      map.addLayer({ id: `ov-${key}-lbl`, type: "symbol", source: srcId, minzoom: 10.5,
        filter: ["has", def.cap.mwKey],
        layout: {
          "text-field": ["concat", ["to-string",
            ["/", ["round", ["*", ["to-number", ["get", def.cap.mwKey]], 10]], 10]], " MW"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-anchor": "top", "text-offset": [0, 0.9],
          "text-optional": true,
        },
        paint: { "text-color": "#1c2533", "text-halo-color": "#ffffff",
                 "text-halo-width": 1.3,
                 "text-opacity": Math.min(1, opacity * 2.5) } }, before);
    }
    // Substations wear their voltage as a tiny number on the dot once the
    // dots are big enough to carry it.
    if (def.kvLabel) {
      map.addLayer({ id: `ov-${key}-lbl`, type: "symbol", source: srcId,
        minzoom: def.labelMinZoom || 9,
        filter: ["has", "kv"],
        layout: {
          "text-field": ["to-string", ["get", "kv"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 7, 8, 11, 9.5, 14, 11],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": def.color,
          "text-halo-width": 1.1,
          "text-opacity": Math.min(1, opacity * 2.5),
        } }, before);
    }
  } else if (def.render === "line") {
    // Line dataset (power lines, boundaries): no fill. Power lines scale
    // width AND colour by voltage (props.kv): amber local -> deep red 400 kV.
    const width = def.dataset === "power_line"
      ? ["interpolate", ["linear"], ["coalesce", ["get", "kv"], 100],
         33, 0.9, 132, 1.6, 275, 2.4, 400, 3.2]
      : ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.4, 14, 2.2];
    const color = def.voltColor
      ? ["step", ["coalesce", ["get", "kv"], 0],
         "#f59f00", 50, "#e8590c", 200, "#a61e0d"]
      : def.color;
    map.addLayer({ id: lineId, type: "line", source: srcId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": color, "line-width": width,
               "line-opacity": Math.min(1, opacity * 2.5) } }, before);
    // Boundary datasets can name themselves on the map (authority names) —
    // one label per polygon, placed inside it, never colliding.
    if (def.nameLabel) {
      map.addLayer({ id: `ov-${key}-name`, type: "symbol", source: srcId,
        filter: ["has", "name"],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 8, 12, 12, 14],
          "text-max-width": 8,
          "text-padding": 6,
          "symbol-placement": "point",
        },
        paint: {
          "text-color": def.color,
          "text-halo-color": body_is_light() ? "#ffffff" : "#12181f",
          "text-halo-width": 1.6,
          "text-opacity": Math.min(1, opacity * 2.6),
        } }, before);
    }
  } else {
    // Attribute-driven fills where the data carries a classification —
    // painting these one flat colour throws the information away.
    const waterStatus = ["downcase", ["to-string", ["coalesce", ["get", "status"], ""]]];
    const fillColor = def.key === "gsp_queue"
      // Queued MW inside each Grid Supply Point: green light -> purple mobbed.
      ? ["case", ["!", ["has", "queued_mw"]], "rgba(160,170,175,0.35)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "queued_mw"]], 0],
          100, "#d3f9d8", 500, "#ffe066", 1500, "#ffa94d",
          4000, "#fa5252", 10000, "#c92a2a", 25000, "#862e9c"]]
      : def.dataset === "ofcom_fibre"
      // Full-fibre availability: red poorly-served -> green gigabit-ready.
      ? ["case", ["!", ["has", "fttp_pct"]], "rgba(160,170,175,0.35)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "fttp_pct"]], 0],
          20, "#e03131", 40, "#e8590c", 60, "#f59f00", 75, "#ffd43b",
          85, "#94d82d", 95, "#2f9e44"]]
      : def.dataset === "census_students"
      // Full-time student share of adults: pale -> deep violet.
      ? ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "students_pct"]], 0],
         2, "#f3f0ff", 5, "#d0bfff", 8, "#9775fa", 12, "#7048e8", 18, "#5f3dc4"]
      : def.dataset === "slope_grid"
      // Mean slope per km cell: green flat -> red steep (DC flatness screen).
      ? ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "slope"]], 0],
         0.5, "#2f9e44", 1.5, "#94d82d", 3, "#ffd43b", 5, "#f59f00",
         8, "#e8590c", 12, "#e03131"]
      : def.dataset === "ptal"
      ? ["match", ["to-string", ["get", "ptal"]],
         "0", "#08306b", "1a", "#2171b5", "1b", "#6baed6", "2", "#74c476",
         "3", "#fee391", "4", "#fe9929", "5", "#ec7014",
         "6a", "#cc4c02", "6b", "#8c2d04", def.color]
      : def.dataset === "alc"
      ? ["match", ["to-string", ["get", "alc_grade"]],
         "Grade 1", "#1f7a3a", "Grade 2", "#57a639", "Grade 3", "#a3c644",
         "Grade 4", "#e0b64b", "Grade 5", "#a97e56",
         "Non Agricultural", "#b8bfc6", "Urban", "#8d959e",
         "Exclusion", "#d0d4d9", def.color]
      : def.dataset === "hdt"
      // NPPF consequence bands: <75% presumption (red), <85% buffer (orange),
      // <95% action plan (amber), passing (green).
      ? ["step", ["coalesce", ["to-number", ["get", "hdt_pct"]], 0],
         "#e03131", 75, "#e8590c", 85, "#f59f00", 95, "#2f9e44"]
      : def.dataset === "la_rents"
      // Sequential rent choropleth: light teal cheap -> deep teal expensive.
      ? ["case", ["!", ["has", "rent_mean"]], "rgba(160,170,175,0.4)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "rent_mean"]], 0],
          500, "#d5eef0", 800, "#a3d8dc", 1100, "#6dbcc5", 1500, "#3c96a6",
          2000, "#20707f", 3000, "#0d4a5c"]]
      : def.dataset === "price_grid"
      // Only the trend layer renders price_grid cells as FILL (the heatmaps
      // take the surface path), so this case is the trend ramp: diverging,
      // blue falling -> grey flat -> red rising. Cells without a trustworthy
      // trend (either window under 5 sales) are fully transparent, not grey:
      // grey would read as "flat market", and absence of evidence isn't that.
      ? ["case", ["!", ["has", "trend_pct"]], "rgba(0,0,0,0)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "trend_pct"]], 0],
          -10, "#1864ab", -5, "#74c0fc", -1.5, "#d8e2e8", 1.5, "#e9d8d8",
          5, "#ff8787", 10, "#c92a2a"]]
      : def.dataset === "land_value"
      // Residential land value: log-ish sweep, pale blue (~£0.5M/ha rural)
      // deepening through violet (£10M+) to grape (central-London £50M+).
      ? ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "resi_gbp_ha"]], 0],
         500000, "#d0ebff", 1500000, "#74c0fc", 3000000, "#4dabf7",
         6000000, "#4263eb", 12000000, "#7048e8", 25000000, "#9c36b5",
         60000000, "#5f2a6e"]
      : def.dataset === "build_cost_index"
      // Relative build cost: green cheaper-than-national -> red dearer.
      ? ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "factor"]], 1],
         0.88, "#2f9e44", 0.95, "#94d82d", 1.0, "#ffd43b",
         1.08, "#f59f00", 1.18, "#e8590c", 1.3, "#c92a2a"]
      : def.dataset === "lad_income"
      // Affordability: median price over median gross annual pay. 4x is the
      // classic mortgageable benchmark; 12x+ is London-grade unaffordability.
      ? ["case", ["!", ["has", "afford_ratio"]], "rgba(160,170,175,0.4)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "afford_ratio"]], 0],
          4, "#2f9e44", 6, "#94d82d", 8, "#ffd43b", 10, "#f59f00",
          12, "#e8590c", 15, "#c92a2a"]]
      : def.dataset === "planit_rates"
      // Approval-rate choropleth: red = refusal-happy, green = permissive.
      ? ["case", ["!", ["has", "approval_pct"]], "rgba(160,170,175,0.4)",
         ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "approval_pct"]], 0],
          60, "#e03131", 75, "#f59f00", 85, "#ffd43b", 92, "#94d82d", 97, "#2f9e44"]]
      : def.dataset === "grey_belt_candidate"
      // Basis split: indigo = built-up area inside the Green Belt, orange =
      // registered brownfield inside it (the stronger signal).
      ? ["match", ["to-string", ["get", "source"]],
         "brownfield", "#e8590c", "#5c7cfa"]
      : def.dataset === "water_availability"
      // EA CAMS Q95 classification arrives as colour words (Green / Yellow /
      // Red / Grey); keep substring fallbacks for text-valued variants.
      ? ["case",
         ["in", "green", waterStatus], "#2f9e44",
         ["any", ["in", "yellow", waterStatus], ["in", "amber", waterStatus],
                 ["in", "restrict", waterStatus]], "#f59f00",
         ["any", ["in", "red", waterStatus], ["in", "not avail", waterStatus]], "#e03131",
         ["any", ["in", "grey", waterStatus], ["in", "gray", waterStatus]], "#adb5bd",
         def.color]
      : def.color;
    // def.provisional marks features whose GEOMETRY is not trusted (as opposed
    // to unknown attributes). They stay on the map but are drawn faded with a
    // dashed edge, so a doubtful boundary never reads as a settled one.
    const prov = def.provisional;
    const baseOpacity = def.noOutline ? Math.min(0.9, opacity * 1.6) : opacity;
    map.addLayer({ id: fillId, type: "fill", source: srcId,
      paint: { "fill-color": fillColor,
               "fill-opacity": prov
                 ? ["case", prov, baseOpacity * 0.28, baseOpacity]
                 : baseOpacity } }, before);
    // Heatmap-style grids stay borderless — cell outlines would shout louder
    // than the colour ramp.
    if (!def.noOutline) {
      map.addLayer({ id: lineId, type: "line", source: srcId,
        filter: prov ? ["!", prov] : ["literal", true],
        paint: { "line-color": def.color, "line-width": 1,
                 "line-opacity": Math.min(0.9, opacity * 2.2) } }, before);
      // A separate layer, because line-dasharray is not data-driven in MapLibre:
      // a "case" expression on it is ignored without error, which would leave
      // these looking exactly like the trusted ones.
      if (prov)
        map.addLayer({ id: dashId, type: "line", source: srcId,
          filter: prov,
          paint: { "line-color": def.color, "line-width": 1,
                   "line-dasharray": [2, 2],
                   "line-opacity": Math.min(0.9, opacity * 2.2) } }, before);
    }
  }
  updateOverlayAttribution();
}

// Click-to-inspect card for any data-layer overlay feature. Invoked from the
// central handleMapTap dispatcher (NOT per-layer click handlers, which would
// double-fire alongside the LSOA panel). Pins a card with EVERY attribute the
// feature carries (voltage, operator, headroom, queued MW, ...).
function openOverlayCard(key, p, lngLat) {
  hoverCardHide();
  if (key === "uni_campus") {
    _uniPanelCtx = { p, lng: lngLat.lng, lat: lngLat.lat };
    openClickPopup({ closeButton: true, maxWidth: "340px", offset: 10 }, lngLat,
      uniProviderCardHTML(p) +
      `<button type="button" class="deepdive-btn uni-dd-open">Full deep dive →</button>`);
    return;
  }
  const skip = new Set(["dataset"]);
  const rows = Object.entries(p)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== "" && v !== "null")
    .map(([k, v]) => `<tr><td class="ovp-k">${_esc(k)}</td><td class="ovp-v">${_esc(v)}</td></tr>`)
    .join("");
  openClickPopup({ closeButton: true, maxWidth: "320px", offset: 10 }, lngLat,
    `<div class="ovp"><div class="ovp-title">${_esc(p.name || overlayDef(key)?.label || key)}</div>` +
    `<table class="ovp-table">${rows}</table></div>`);
}

// The PBSA-lens card for a university provider dot: headline student numbers
// (HESA join, when loaded), international share — the demand signals a
// student-housing developer reads first — plus provider identity, with a
// pointer to the campus/building layers for the physical footprint.
function uniProviderCardHTML(p) {
  const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
  const total = num(p.students_total), intl = num(p.students_intl),
        ft = num(p.students_fulltime), pg = num(p.students_pg),
        intlPct = num(p.intl_pct);
  const statRow = (label, v, extra) => v == null ? "" :
    `<tr><td class="ovp-k">${label}</td><td class="ovp-v"><strong>${v.toLocaleString()}</strong>${extra || ""}</td></tr>`;
  let stats = "";
  stats += statRow("Students", total);
  stats += statRow("Full-time", ft, total ? ` <span class="ovp-dim">(${Math.round(100 * ft / total)}%)</span>` : "");
  stats += statRow("International", intl, intlPct != null ? ` <span class="ovp-dim">(${intlPct}%)</span>` : "");
  stats += statRow("Postgraduate", pg, total && pg != null ? ` <span class="ovp-dim">(${Math.round(100 * pg / total)}%)</span>` : "");
  const statsBlock = stats
    ? `<table class="ovp-table">${stats}</table>`
    : `<p class="ovp-note">Student stats not loaded yet — supply the HESA per-provider CSV (HESA_STUDENTS_SRC) and re-run the datasets workflow.</p>`;

  // Term-time accommodation mix (HESA Table 57, full-time students): the
  // PBSA developer's read — how much purpose-built stock already serves this
  // institution, how big the HMO ("other rented") market is, and how many
  // live at home (little accommodation demand at all).
  const accRows = [
    ["Private halls (PBSA)", num(p.acc_private_halls), num(p.pbsa_pct)],
    ["University halls", num(p.acc_provider_halls), num(p.uni_halls_pct)],
    ["Other rented (HMO etc.)", num(p.acc_other_rented), num(p.rented_pct)],
    ["Living with parents", num(p.acc_parental_home), num(p.home_pct)],
    ["Own residence", num(p.acc_own_residence), null],
  ].filter(([, v]) => v != null);
  const accBlock = accRows.length
    ? `<div class="ovp-sub">Term-time accommodation (full-time students)</div>
       <table class="ovp-table">` + accRows.map(([label, v, pct]) =>
         `<tr><td class="ovp-k">${label}</td><td class="ovp-v"><strong>${v.toLocaleString()}</strong>${pct != null ? ` <span class="ovp-dim">(${pct}%)</span>` : ""}</td></tr>`
       ).join("") + `</table>`
    : "";
  const meta = [
    p.groups ? `<tr><td class="ovp-k">type</td><td class="ovp-v">${p.groups}</td></tr>` : "",
    p.ukprn ? `<tr><td class="ovp-k">UKPRN</td><td class="ovp-v">${p.ukprn}</td></tr>` : "",
  ].join("");
  return `<div class="ovp">
    <div class="ovp-title">${p.name || "HE provider"}</div>
    ${statsBlock}
    ${accBlock}
    <table class="ovp-table">${meta}</table>
    <p class="ovp-note">Physical footprint: turn on <em>Campus grounds</em> and <em>University buildings</em> in Student housing &amp; demand.</p>
  </div>`;
}

// ODbL requires visible attribution while OSM-derived power layers are shown.
function updateOverlayAttribution() {
  const osmOn = ["power_line", "power_substation", "uni_campus_site", "uni_building"]
    .some(k => overlayState[k] && overlayState[k].on);
  if (osmOn !== _osmPowerAttributionShown) {
    _osmPowerAttributionShown = osmOn;
    updateDataSourceNote();
  }
}
let _osmPowerAttributionShown = false;

function removeOverlayLayers(key) {
  for (const id of [`ov-${key}-fill`, `ov-${key}-line`, `ov-${key}-line-dashed`,
                    `ov-${key}-pt`, `ov-${key}-icon`, `ov-${key}-lbl`,
                    `ov-${key}-heat`, `ov-${key}-name`])
    if (map.getLayer(id)) map.removeLayer(id);
  const srcId = `ov-${key}-src`;
  if (map.getSource(srcId)) map.removeSource(srcId);
  if (map.getSource(`ov-${key}-img`)) map.removeSource(`ov-${key}-img`);
  updateOverlayAttribution();
}

// ---- National land parcels (HMLR INSPIRE index polygons, PMTiles) ----------
// Nationwide parcel outlines streamed from a prebuilt tile file on Supabase
// storage (built by .github/workflows/build-parcel-tiles.yml) — ~26M parcels
// served with zero database load, visible from z13. The free INSPIRE data
// carries parcel IDs, not owners: read alongside the CCOD council dots.
const PARCEL_COLOR = "#5c7cfa";
const parcelsState = { on: false, opacity: 0.85, available: null };

function parcelTilesUrl() {
  const cfg = window.MASTERMAPPER_CONFIG || {};
  return cfg.SUPABASE_URL
    ? `${cfg.SUPABASE_URL}/storage/v1/object/public/tiles/parcels.pmtiles`
    : null;
}

async function setParcelsVisible(on) {
  parcelsState.on = on;
  const stat = document.getElementById("parcels-stat");
  const url = parcelTilesUrl();
  if (!url) { if (stat) stat.textContent = "n/a"; return; }
  if (on && parcelsState.available === null) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      parcelsState.available = r.ok;
    } catch (_) { parcelsState.available = false; }
  }
  if (on && parcelsState.available === false) {
    if (stat) stat.textContent = "tiles not built yet";
    return;
  }
  if (on && !map.getSource("parcels")) {
    map.addSource("parcels", { type: "vector", url: "pmtiles://" + url });
    const before = overlayBeforeId();
    // Near-invisible fill = the hover/click hit target; the line carries the look.
    map.addLayer({ id: "parcel-fill", type: "fill", source: "parcels",
      "source-layer": "parcels", minzoom: 13,
      paint: { "fill-color": PARCEL_COLOR, "fill-opacity": 0.04 } }, before);
    map.addLayer({ id: "parcel-line", type: "line", source: "parcels",
      "source-layer": "parcels", minzoom: 13,
      paint: { "line-color": PARCEL_COLOR,
               "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.4, 16, 1.3],
               "line-opacity": parcelsState.opacity } }, before);
  }
  for (const id of ["parcel-fill", "parcel-line"])
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (stat) stat.textContent = on ? "streams from z13" : "";
  updateDataSourceNote();
}

function setParcelOpacity(v) {
  parcelsState.opacity = v;
  if (map.getLayer("parcel-line")) map.setPaintProperty("parcel-line", "line-opacity", v);
  if (map.getLayer("parcel-fill")) map.setPaintProperty("parcel-fill", "fill-opacity", Math.min(0.15, v * 0.08));
}

// ---- Building footprints coloured by height (OSM, PMTiles) -----------------
// Every OSM building that carries a height or building:levels tag, drawn as its
// actual FOOTPRINT and shaded by height (built by
// .github/workflows/build-building-tiles.yml). A dot per building told you
// nothing about built form; a coloured footprint reads as a townscape — you can
// see the terraces, the tower, the industrial sheds, at a glance.
//
// Coverage is whatever OSM contributors have tagged: excellent in city centres
// and for landmarks, patchy across suburbia. Untagged buildings are simply
// absent, which is honest — they are not "low rise", they are unknown.
// A single cool-to-warm progression: blue for the shortest, dark red for the
// tallest, yellow and orange between. No greens or purples — a ramp that wanders
// through unrelated hues makes the reader look at the key instead of the map,
// whereas "colder = shorter, hotter = taller" needs no key at all.
//
// The bands stay tight where the buildings actually are (5/9/14/20 m) and coarse
// above, because almost every British building is between 5 and 20 m; spreading
// the range evenly over 0-100 m is what made whole cities read as one colour.
const BUILDING_HEIGHT_BANDS = [
  { max: 5,        color: "#2c7fb8", label: "under 5 m · 1 storey" },
  { max: 9,        color: "#92c5de", label: "5–9 m · 2" },
  { max: 14,       color: "#fed976", label: "9–14 m · 3–4" },
  { max: 20,       color: "#feb24c", label: "14–20 m · 5–6" },
  { max: 35,       color: "#fd8d3c", label: "20–35 m · 7–10" },
  { max: 70,       color: "#e31a1c", label: "35–70 m · 11–21" },
  { max: Infinity, color: "#800026", label: "over 70 m · 22+" },
];
// Buildings OSM has not given a height. They are drawn, in neutral grey, rather
// than left out: a missing footprint reads as empty land, which is a worse lie
// than an honest "not known". Deliberately outside the ramp so it can never be
// mistaken for a height.
const BUILDING_UNKNOWN_COLOR = "#b0b6bb";
const buildingsState = { on: false, opacity: 0.85, available: null };

function buildingTilesUrl() {
  const cfg = window.MASTERMAPPER_CONFIG || {};
  return cfg.SUPABASE_URL
    ? `${cfg.SUPABASE_URL}/storage/v1/object/public/tiles/buildings.pmtiles`
    : null;
}

// Sequential light->dark ramp on height, as a MapLibre step expression.
function buildingHeightColorExpr() {
  const step = ["step", ["to-number", ["get", "height_m"]],
                BUILDING_HEIGHT_BANDS[0].color];
  for (let i = 0; i < BUILDING_HEIGHT_BANDS.length - 1; i++)
    step.push(BUILDING_HEIGHT_BANDS[i].max, BUILDING_HEIGHT_BANDS[i + 1].color);
  // A building with no height must NOT fall through to the shortest band —
  // coalescing a missing value to 0 would paint every untagged building as
  // single-storey, which is a guess dressed up as data.
  return ["case", ["!", ["has", "height_m"]], BUILDING_UNKNOWN_COLOR, step];
}

// The swatch a given height falls in — same bands as the fill ramp, so the
// hover card's chip always matches what's under the cursor.
function buildingBandColor(h) {
  if (h == null || h === "") return BUILDING_UNKNOWN_COLOR;
  const v = Number(h);
  if (!isFinite(v)) return BUILDING_UNKNOWN_COLOR;
  for (const b of BUILDING_HEIGHT_BANDS) if (v < b.max) return b.color;
  return BUILDING_HEIGHT_BANDS[BUILDING_HEIGHT_BANDS.length - 1].color;
}

async function setBuildingsVisible(on) {
  buildingsState.on = on;
  const stat = document.getElementById("buildings-stat");
  const url = buildingTilesUrl();
  if (!url) { if (stat) stat.textContent = "n/a"; return; }
  if (on && buildingsState.available === null) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      buildingsState.available = r.ok;
    } catch (_) { buildingsState.available = false; }
  }
  if (on && buildingsState.available === false) {
    if (stat) stat.textContent = "tiles not built yet";
    return;
  }
  if (on && !map.getSource("buildings")) {
    map.addSource("buildings", { type: "vector", url: "pmtiles://" + url });
    const before = overlayBeforeId();
    map.addLayer({ id: "building-fill", type: "fill", source: "buildings",
      "source-layer": "buildings", minzoom: 13,
      paint: { "fill-color": buildingHeightColorExpr(),
               "fill-opacity": buildingsState.opacity } }, before);
    // A hairline outline at close zoom separates a terrace into houses instead
    // of one merged block of colour.
    map.addLayer({ id: "building-line", type: "line", source: "buildings",
      "source-layer": "buildings", minzoom: 15,
      paint: { "line-color": "#ffffff",
               "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.2, 18, 0.7],
               "line-opacity": 0.5 * buildingsState.opacity } }, before);
  }
  for (const id of ["building-fill", "building-line"])
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (stat) stat.textContent = on ? "streams from z13" : "";
  const legend = document.getElementById("buildings-legend");
  if (legend) legend.hidden = !on;
  updateDataSourceNote();
}

function setBuildingOpacity(v) {
  buildingsState.opacity = v;
  if (map.getLayer("building-fill")) map.setPaintProperty("building-fill", "fill-opacity", v);
  if (map.getLayer("building-line")) map.setPaintProperty("building-line", "line-opacity", 0.5 * v);
}

// The height ramp is meaningless without a key, so the row carries its own.
function buildingsLegendHTML() {
  const items = BUILDING_HEIGHT_BANDS.map(b =>
    `<span class="bh-key"><span class="bh-sw" style="background:${b.color}"></span>${b.label}</span>`).join("")
    + `<span class="bh-key"><span class="bh-sw" style="background:${BUILDING_UNKNOWN_COLOR}"></span>no height in OSM</span>`;
  return `<div id="buildings-legend" class="bh-legend" hidden>${items}</div>`;
}

// ---- Data layers panel (left box 1) ---------------------------------------
// The grouped, sub-grouped layer tree. Every layer gets a visibility toggle
// and a transparency slider; groups and sub-groups collapse. Data-gated rows
// (prices, rail, stations, green belt) render hidden and are revealed once
// their data loads, so the existing load-time wiring keeps working unchanged.

// One compact tree row: checkbox + colour swatch + label + live stat + a
// transparency slider that shows while the layer is on.
function ltRowHTML(o) {
  const swatch = o.swatch || (o.color ? `<span class="ov-swatch" style="background:${o.color}"></span>` : "");
  const info = o.info
    ? `<button class="info" type="button" aria-label="About this layer" tabindex="0">i<span class="tip" role="tooltip">${o.info.about}<span class="tip-source">Source: ${o.info.source}</span></span></button>`
    : "";
  return `
    <div class="lt-row${o.hidden ? "" : ""}" ${o.rowId ? `id="${o.rowId}"` : ""} ${o.hidden ? "hidden" : ""}>
      <label class="lt-main">
        <input type="checkbox" ${o.cbId ? `id="${o.cbId}"` : ""} ${o.dataKey ? `data-ov="${o.dataKey}"` : ""} ${o.checked ? "checked" : ""} />
        ${swatch}
        <span class="lt-label">${o.label}</span>${info}
        <span class="lt-stat" ${o.statId ? `id="${o.statId}"` : ""}></span>
      </label>
      <div class="lt-fade">
        <span class="lt-fade-label">fade</span>
        <input type="range" min="0.05" max="1" step="0.05" value="${o.opacity}"
               class="lt-opacity" data-okey="${o.opacityKey}" aria-label="${o.label} transparency" />
      </div>
    </div>`;
}

function buildLayersPanel() {
  const host = document.getElementById("layers-tree");
  if (!host) return;

  // --- Deprivation group: layer toggle + view picker + embedded weighting ---
  const imdRamp = RAMP_SINGLE.slice(1).map(c => `<i style="background:${c}"></i>`).join("");
  const viewRadios = [{ key: "", name: "Combined score (weighted)" }]
    .concat(DOMAINS.map(d => ({ key: d.key, name: d.name })))
    .map(v => `
      <label class="lt-view">
        <input type="radio" name="imd-view" value="${v.key}" ${state.solo === (v.key || null) || (!state.solo && !v.key) ? "checked" : ""} />
        <span>${v.name}</span>
      </label>`).join("");

  const deprivationGroup = `
    <div class="lt-group" data-group="deprivation">
      <button type="button" class="lt-head" aria-expanded="true">
        <span class="lt-title">Deprivation (IMD · SIMD)</span>
        <span class="box-caret" aria-hidden="true">▾</span>
      </button>
      <div class="lt-body">
        ${ltRowHTML({ cbId: "imd-show", label: "Deprivation choropleth",
                      swatch: `<span class="lt-ramp">${imdRamp}</span>`,
                      checked: state.imdOn, opacity: state.fillOpacity, opacityKey: "imd",
                      info: { about: "Combined deprivation score across seven weighted domains (income, employment, education, health, crime, housing barriers, living environment). Darker = more deprived. England LSOAs + Scotland Data Zones.",
                              source: "English Indices of Deprivation (MHCLG) & Scottish IMD (Scottish Government), OGL v3" } })}
        <div class="lt-sub">
          <button type="button" class="lt-head lt-sub-head" aria-expanded="false">
            <span class="lt-title">Layer view — combined or a single domain</span>
            <span class="box-caret" aria-hidden="true">▾</span>
          </button>
          <div class="lt-body lt-collapsed">
            <div class="lt-views">${viewRadios}</div>
          </div>
        </div>
        <div class="lt-sub">
          <button type="button" class="lt-head lt-sub-head" aria-expanded="false">
            <span class="lt-title">Score weighting</span>
            <span class="box-caret" aria-hidden="true">▾</span>
          </button>
          <div class="lt-body lt-collapsed">
            <p class="hint">Domains are weighted as in the official Index of Multiple Deprivation. Move a slider and the others rebalance so the total stays 100%. The map updates live.</p>
            <div id="sliders"></div>
            <div id="weight-total" class="weight-total">Total: 100%</div>
            <button id="reset-weights" class="ghost">Reset to official IMD weighting</button>
          </div>
        </div>
      </div>
    </div>`;

  // --- House prices: an independent group (never tied to deprivation) ------
  const priceRamp = PRICE_RAMP.slice(1).map(c => `<i style="background:${c}"></i>`).join("");
  const priceGroup = `
    <div class="lt-group" data-group="price" id="lt-group-price" hidden>
      <button type="button" class="lt-head" aria-expanded="true">
        <span class="lt-title">House prices</span>
        <span class="box-caret" aria-hidden="true">▾</span>
      </button>
      <div class="lt-body">
        ${ltRowHTML({ cbId: "price-show", label: "House price choropleth (£/m²)",
                      swatch: `<span class="lt-ramp">${priceRamp}</span>`,
                      checked: state.priceOn, opacity: state.priceOpacity, opacityKey: "price",
                      info: { about: "Typical £ per square metre from actual sale prices, per LSOA. Independent of the deprivation layer — show both and blend with the fade sliders.",
                              source: "HM Land Registry Price Paid Data (OGL v3)" } })}
        <p class="hint" style="margin:2px 0 6px">HM Land Registry price paid, per LSOA. Independent of the deprivation layer — show both together and blend with the fade sliders.</p>
      </div>
    </div>`;

  // --- Overlay-driven groups (Planning & environment · Student housing ·
  // --- Energy & utilities), each with sub-groups from OVERLAY_TREE ---------
  const overlayGroupsHTML = OVERLAY_TREE.map(top => {
    const subHTML = top.subs.map(g => {
      let rows = "";
      // National parcel outlines (PMTiles, not a bbox overlay) lead Land.
      if (g.key === "land") {
        rows += ltRowHTML({ cbId: "parcels-show", label: "Land parcels (HMLR INSPIRE)",
                            color: PARCEL_COLOR, statId: "parcels-stat",
                            checked: false, opacity: parcelsState.opacity, opacityKey: "parcels",
                            info: { about: "The outline of every registered land parcel in England & Wales, nationwide from z13. The free data carries parcel IDs, not owners — read it alongside the council-property dots. Exact title-to-parcel ownership is only sold in HMLR's licensed National Polygon Service.",
                                    source: "HM Land Registry INSPIRE index polygons © Crown copyright and database right; geometry derived from Ordnance Survey data" } });
      }
      // Green Belt (a national static file, not a bbox overlay) leads Planning.
      if (g.key === "planning") {
        rows += ltRowHTML({ rowId: "greenbelt-row", cbId: "greenbelt-show", hidden: true,
                            label: "Green Belt", color: GREENBELT_COLOR, statId: "greenbelt-count",
                            checked: false, opacity: state.greenbeltOpacity, opacityKey: "greenbelt",
                            info: { about: "Green Belt land, where national policy restrains most new development. Shown nationwide from a static extract.",
                                    source: "MHCLG via planning.data.gov.uk (OGL v3)" } });
      }
      // Building footprints (PMTiles, not a bbox overlay) lead Site factors,
      // and carry their own height key underneath the row.
      if (g.key === "sitefactors") {
        rows += ltRowHTML({ cbId: "buildings-show", label: "Building heights (footprints)",
                            color: BUILDING_HEIGHT_BANDS[4].color, statId: "buildings-stat",
                            checked: false, opacity: buildingsState.opacity, opacityKey: "buildings",
                            info: LAYER_INFO.building_height });
        rows += buildingsLegendHTML();
      }
      // Prices & sales carry ONE shared flats/houses filter above the rows —
      // per-layer filters would let the heat show flats while the comparables
      // show houses, which is exactly the confusion this exists to prevent.
      if (g.key === "market") {
        rows += `
          <div class="lt-seg" id="market-ptype" role="group" aria-label="Property type filter">
            <span class="lt-seg-label">Type</span>
            ${["all", "houses", "flats"].map(v => `
              <button type="button" class="lt-seg-btn${marketPtype === v ? " active" : ""}"
                      data-ptype="${v}">${v === "all" ? "All" : v === "houses" ? "Houses" : "Flats"}</button>`).join("")}
          </div>`;
      }
      rows += MAP_OVERLAYS.filter(o => o.group === g.key).map(o =>
        ltRowHTML({ dataKey: o.key, label: o.label, color: o.color, statId: `ov-stat-${o.key}`,
                    checked: false, opacity: OVERLAY_DEFAULT_OPACITY, opacityKey: `ov:${o.key}`,
                    info: LAYER_INFO[o.key] })).join("");
      return `
        <div class="lt-sub">
          <button type="button" class="lt-head lt-sub-head" aria-expanded="true">
            <span class="lt-title">${g.title}</span>
            <span class="box-caret" aria-hidden="true">▾</span>
          </button>
          <div class="lt-body">${rows}</div>
        </div>`;
    }).join("");
    const hint = top.key === "planning-env"
      ? `<p class="hint" style="margin:4px 0 6px">Layers load nationwide for the current view — big designations show from a regional zoom; small/dense ones appear as you zoom in.</p>`
      : "";
    return `
      <div class="lt-group" data-group="${top.key}">
        <button type="button" class="lt-head" aria-expanded="true">
          <span class="lt-title">${top.title}</span>
          <span class="box-caret" aria-hidden="true">▾</span>
        </button>
        <div class="lt-body">
          ${subHTML}
          ${hint}
        </div>
      </div>`;
  }).join("");

  // --- Transport & rail ----------------------------------------------------
  const transportGroup = `
    <div class="lt-group" data-group="transport">
      <button type="button" class="lt-head" aria-expanded="true">
        <span class="lt-title">Transport &amp; rail</span>
        <span class="box-caret" aria-hidden="true">▾</span>
      </button>
      <div class="lt-body">
        <label class="lt-main lt-master">
          <input type="checkbox" id="transport-all" checked />
          <span class="lt-label">All transport &amp; rail</span><button class="info" type="button" aria-label="About these layers" tabindex="0">i<span class="tip" role="tooltip">Rail, metro, light-rail and tram lines and stops, plus the heavy-rail station layer. This toggle flips everything in the group at once.<span class="tip-source">Source: © OpenStreetMap contributors &amp; Trainline (ODbL); ORR station usage (OGL v3)</span></span></button>
        </label>
        ${ltRowHTML({ rowId: "station-row", cbId: "station-show", hidden: true,
                      label: "Stations (heavy rail, usage-scaled)", color: STATION_COLOR,
                      statId: "station-count-stat", checked: true,
                      opacity: state.stationOpacity, opacityKey: "stations",
                      info: { about: "Every GB heavy-rail station, sized by annual entries + exits — the analysis objects the station tools profile.",
                              source: "Office of Rail and Road station usage estimates (OGL v3)" } })}
        <div id="rail-group" hidden>
          <div id="rail-toggle" class="rail-toggle"></div>
          <div class="lt-fade lt-fade-solo">
            <span class="lt-fade-label">transit overlay fade</span>
            <input type="range" min="0.05" max="1" step="0.05" value="${state.railOpacity}"
                   class="lt-opacity" data-okey="rail" aria-label="Transit overlay transparency" />
          </div>
        </div>
      </div>
    </div>`;

  host.innerHTML = deprivationGroup + priceGroup + overlayGroupsHTML + transportGroup;

  // Collapse/expand for groups and sub-groups.
  host.querySelectorAll(".lt-head").forEach(head => {
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      if (!body) return;
      const collapsed = body.classList.toggle("lt-collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
    });
  });

  // Info buttons sit inside the row <label>; without this a click on ⓘ would
  // also toggle the layer checkbox.
  host.querySelectorAll(".lt-main .info").forEach(b =>
    b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); }));

  // Overlay checkboxes (granular planning/environment/heritage/flood/land).
  host.querySelectorAll("input[data-ov]").forEach(cb =>
    cb.addEventListener("change", e => toggleMapOverlay(e.target.dataset.ov, e.target.checked)));

  // National parcel tiles (streams from storage, not a bbox overlay).
  const parcelsCb = document.getElementById("parcels-show");
  if (parcelsCb) parcelsCb.addEventListener("change", e => setParcelsVisible(e.target.checked));

  // Building-footprint tiles (also storage-served, not a bbox overlay).
  const buildingsCb = document.getElementById("buildings-show");
  if (buildingsCb) buildingsCb.addEventListener("change", e => setBuildingsVisible(e.target.checked));

  // Shared flats/houses filter for the market layers.
  const seg = document.getElementById("market-ptype");
  if (seg) seg.addEventListener("click", e => {
    const btn = e.target.closest(".lt-seg-btn");
    if (!btn) return;
    setMarketPtype(btn.dataset.ptype);
    seg.querySelectorAll(".lt-seg-btn").forEach(b =>
      b.classList.toggle("active", b === btn));
  });

  // Every transparency slider routes through one dispatcher.
  host.querySelectorAll(".lt-opacity").forEach(sl =>
    sl.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      const k = e.target.dataset.okey;
      if (k === "imd") setImdOpacity(v);
      else if (k === "price") setPriceOpacity(v);
      else if (k === "greenbelt") setGreenbeltOpacity(v);
      else if (k === "rail") setRailOverlayOpacity(v);
      else if (k === "stations") setStationOpacity(v);
      else if (k === "parcels") setParcelOpacity(v);
      else if (k === "buildings") setBuildingOpacity(v);
      else if (k && k.startsWith("ov:")) setOverlayOpacity(k.slice(3), v);
    }));

  // Deprivation view picker: combined vs a single domain ("solo"). Selecting
  // any view turns the deprivation layer on so the choice is visible.
  host.querySelectorAll('input[name="imd-view"]').forEach(r =>
    r.addEventListener("change", e => {
      setSolo(e.target.value || null);
      if (!state.imdOn) {
        const cb = document.getElementById("imd-show");
        if (cb) cb.checked = true;
        setImdVisible(true);
      }
    }));

  // House-price toggle.
  const priceCb = host.querySelector("#price-show");
  if (priceCb) priceCb.addEventListener("change", e => setPriceVisible(e.target.checked));

  // Transport & rail master toggle: flips stations + every rail mode at once,
  // and reflects the children's state (indeterminate when mixed).
  const master = host.querySelector("#transport-all");
  if (master) master.addEventListener("change", e => setAllTransport(e.target.checked));
  const tGroup = host.querySelector('[data-group="transport"]');
  if (tGroup) tGroup.addEventListener("change", (e) => {
    if (e.target && e.target.id !== "transport-all") syncTransportMaster();
  });
}

// All checkboxes the transport master governs (only those currently rendered
// and relevant — the station row and rail toggles appear once data loads).
function transportChildCheckboxes() {
  const cbs = [];
  const stationRow = document.getElementById("station-row");
  const stationCb = document.getElementById("station-show");
  if (stationCb && stationRow && !stationRow.hidden) cbs.push(stationCb);
  for (const m of RAIL_MODES) {
    for (const kind of ["line", "stop"]) {
      const cb = document.getElementById(`rail-${kind}-${m.key}`);
      if (cb) cbs.push(cb);
    }
  }
  return cbs;
}

function setAllTransport(on) {
  const stationRow = document.getElementById("station-row");
  const stationCb = document.getElementById("station-show");
  if (stationCb && stationRow && !stationRow.hidden && stationCb.checked !== on) {
    stationCb.checked = on;
    setStationsVisible(on);
  }
  for (const m of RAIL_MODES) {
    const lineCb = document.getElementById(`rail-line-${m.key}`);
    if (lineCb && lineCb.checked !== on) {
      lineCb.checked = on;
      setRailModeVisibility("line", m.key, on);
    }
    const stopCb = document.getElementById(`rail-stop-${m.key}`);
    if (stopCb && stopCb.checked !== on) {
      stopCb.checked = on;
      setRailModeVisibility("stop", m.key, on);
    }
  }
  syncTransportMaster();
}

function syncTransportMaster() {
  const master = document.getElementById("transport-all");
  if (!master) return;
  const cbs = transportChildCheckboxes();
  if (!cbs.length) { master.checked = true; master.indeterminate = false; return; }
  const on = cbs.filter(cb => cb.checked).length;
  master.checked = on === cbs.length;
  master.indeterminate = on > 0 && on < cbs.length;
}

// Reveal the House prices group once loadData knows the tiles carry prices.
function revealPriceGroup() {
  const g = document.getElementById("lt-group-price");
  if (g) g.hidden = !state.hasPrice;
}

// ---- Per-layer transparency helpers (non-overlay layers) -------------------

function setGreenbeltOpacity(v) {
  state.greenbeltOpacity = v;
  if (map.getLayer("greenbelt-fill"))
    map.setPaintProperty("greenbelt-fill", "fill-opacity", v);
}

function setRailOverlayOpacity(v) {
  state.railOpacity = v;
  if (map.getLayer("rail-line")) map.setPaintProperty("rail-line", "line-opacity", v);
  if (map.getLayer("rail-stop")) {
    map.setPaintProperty("rail-stop", "circle-opacity", v);
    map.setPaintProperty("rail-stop", "circle-stroke-opacity", v);
  }
  if (map.getLayer("rail-stop-label"))
    map.setPaintProperty("rail-stop-label", "text-opacity", Math.min(1, v * 1.1));
}

function setStationOpacity(v) {
  state.stationOpacity = v;
  if (map.getLayer("station-dot")) {
    map.setPaintProperty("station-dot", "circle-opacity", v);
    map.setPaintProperty("station-dot", "circle-stroke-opacity", v);
  }
  if (map.getLayer("station-label"))
    map.setPaintProperty("station-label", "text-opacity", Math.min(1, v * 1.1));
}

// ---- Minimiseable side boxes (Data layers · Rail & stations) ---------------
// Each .side-box header toggles its body; the state persists across reloads.
function wireSideBoxes() {
  document.querySelectorAll(".side-box").forEach(box => {
    const head = box.querySelector(".box-head");
    if (!head) return;
    const storeKey = `ui.box.${box.id}.min`;
    const saved = mmStore.get(storeKey, false);
    if (saved) {
      box.classList.add("minimised");
      head.setAttribute("aria-expanded", "false");
    }
    head.addEventListener("click", () => {
      const min = box.classList.toggle("minimised");
      head.setAttribute("aria-expanded", String(!min));
      mmStore.set(storeKey, min);
    });
  });
}

// ---- Choropleth restyle on weight change ----------------------------------

// Apply the current fill-colour expression to BOTH the fill and its gap-
// bridging outline, so they never diverge (the outline closes hairline gaps
// only if it matches the fill exactly).
function applyFillColor() {
  const expr = fillColorExpression();
  for (const id of ["lsoa-fill", "simd-fill"]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, "fill-color", expr);
    map.setPaintProperty(id, "fill-outline-color", expr);
  }
}

function restyle() {
  applyFillColor();
  buildLegend();
  if (state.selectedCode) inspectLSOA(state.selectedCode);
}

// (The old Deprivation/House-prices segmented header toggle is gone: prices
// are an independent layer in the Data layers panel — see setPriceVisible.)

// Rail overlay toggle. One group per mode that has data; within each, a Lines
// and/or Stops checkbox. Each row carries the mode's colour swatch so the map
// colours are self-explanatory. Only shown when the tiles carry rail data.
function buildRailToggle() {
  const block = document.getElementById("rail-group");
  const el = document.getElementById("rail-toggle");
  if (!block || !el) return;
  if (!state.hasRail) { block.hidden = true; return; }
  block.hidden = false;

  const railMeta = state.breaksData?.meta?.rail || {};
  const lineCounts = railMeta.line_counts || {};
  const stopCounts = railMeta.stop_counts || {};

  const checkbox = (kind, mode, count) => {
    const id = `rail-${kind}-${mode}`;
    const flags = kind === "line" ? state.railLineModes : state.railStopModes;
    return `
      <label class="rail-sub">
        <input type="checkbox" class="enable" id="${id}" ${flags[mode] ? "checked" : ""} />
        <span class="rail-sub-label">${kind === "line" ? "Lines" : "Stops"}</span>
        <span class="rail-count">${(count || 0).toLocaleString()}</span>
      </label>`;
  };

  let html = "";
  for (const m of RAIL_MODES) {
    const lc = lineCounts[m.key] || 0;
    const sc = stopCounts[m.key] || 0;
    if (!lc && !sc) continue;   // mode absent from data -> no group
    html += `
      <div class="rail-group">
        <div class="rail-group-head">
          <span class="rail-swatch" style="background:${m.color}"></span>
          <span class="rail-mode-name">${m.label}</span>
        </div>
        <div class="rail-subs">
          ${lc ? checkbox("line", m.key, lc) : ""}
          ${sc ? checkbox("stop", m.key, sc) : ""}
        </div>
      </div>`;
  }
  el.innerHTML = html;

  // Wire each checkbox to flip that mode's visibility for that kind.
  for (const m of RAIL_MODES) {
    const lineCb = el.querySelector(`#rail-line-${m.key}`);
    if (lineCb) lineCb.addEventListener("change", (e) =>
      setRailModeVisibility("line", m.key, e.target.checked));
    const stopCb = el.querySelector(`#rail-stop-${m.key}`);
    if (stopCb) stopCb.addEventListener("change", (e) =>
      setRailModeVisibility("stop", m.key, e.target.checked));
  }
  syncTransportMaster();   // rail children just appeared — reflect their state
}

function setRailModeVisibility(kind, mode, on) {
  const flags = kind === "line" ? state.railLineModes : state.railStopModes;
  flags[mode] = on;
  if (kind === "line") {
    if (map.getLayer("rail-line"))
      map.setFilter("rail-line", railModeFilter("line"));
  } else {
    for (const id of ["rail-stop", "rail-stop-label"]) {
      if (map.getLayer(id)) map.setFilter(id, railModeFilter("stop"));
    }
  }
}

// Station controls: a typeahead search over the loaded stations + a show/hide
// toggle. Selecting a result flies to the station and opens its inspect card.
// Switch the catchment method (circle vs walk-time isochrone) and reflect it in
// the segmented toggle. Circle is instant + offline; isochrone needs the free
// Valhalla routing service (currently unreliable, hence circle is the default).
function setCatchmentMethod(method, silent) {
  state.catchmentMethod = (method === "isochrone") ? "isochrone" : "circle";
  const seg = document.getElementById("catch-method-seg");
  if (seg) {
    seg.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b.dataset.method === state.catchmentMethod));
  }
  const note = document.getElementById("catch-method-note");
  if (note) {
    note.textContent = state.catchmentMethod === "circle"
      ? "Instant. Straight-line approx."
      : "Accurate street network. Needs the routing service (may be slow/unavailable).";
  }
  if (!silent) dbg("catchment method →", state.catchmentMethod);
}

function buildStationControls() {
  const block = document.getElementById("station-block");
  if (!block) return;
  const layerRow = document.getElementById("station-row");   // Data layers row
  if (!state.hasStations) { block.hidden = true; return; }
  block.hidden = false;
  if (layerRow) layerRow.hidden = false;
  syncTransportMaster();   // station row just appeared — reflect its state

  const feats = (state.stationsData && state.stationsData.features) || [];
  const countStat = document.getElementById("station-count-stat");
  if (countStat) {
    const yr = state.stationsMeta?.latest_year;
    countStat.textContent = `${feats.length.toLocaleString()}${yr ? ` · ${yr}` : ""}`;
  }

  const input = document.getElementById("station-search-input");
  const results = document.getElementById("station-search-results");
  const showCb = document.getElementById("station-show");

  if (showCb) showCb.addEventListener("change", (e) => setStationsVisible(e.target.checked));

  const batchBtn = document.getElementById("batch-open-btn");
  if (batchBtn && !batchBtn._wired) {
    batchBtn._wired = true;
    batchBtn.addEventListener("click", openBatchSetup);
  }

  const methodSeg = document.getElementById("catch-method-seg");
  if (methodSeg && !methodSeg._wired) {
    methodSeg._wired = true;
    methodSeg.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => setCatchmentMethod(btn.dataset.method));
    });
    // Reflect the default state on first build.
    setCatchmentMethod(state.catchmentMethod, true);
  }

  if (input && results) {
    // Pre-index for quick search: lowercase name + crs.
    const index = feats.map(f => ({
      name: f.properties.name || "",
      crs: (f.properties.crs || "").toUpperCase(),
      usage: f.properties.usage,
      coords: f.geometry.coordinates,
      props: f.properties,
      hay: ((f.properties.name || "") + " " + (f.properties.crs || "")).toLowerCase(),
    }));

    const render = (matches) => {
      if (!matches.length) { results.hidden = true; results.innerHTML = ""; return; }
      results.hidden = false;
      results.innerHTML = matches.map((m, i) => `
        <button type="button" class="station-result" data-i="${i}">
          <span class="sr-name">${m.name}</span>
          <span class="sr-meta">${m.crs ? m.crs + " · " : ""}${m.usage != null && m.usage !== "" ? fmtCount(Number(m.usage)) : "usage n/a"}</span>
        </button>`).join("");
      results.querySelectorAll(".station-result").forEach(btn => {
        btn.addEventListener("click", () => {
          const m = matches[parseInt(btn.dataset.i, 10)];
          selectStationFromSearch(m);
          input.value = m.name;
          results.hidden = true;
        });
      });
    };

    let lastMatches = [];
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { results.hidden = true; return; }
      // Rank: prefix matches first, then substring; cap to 8, busiest first.
      const scored = index
        .filter(s => s.hay.includes(q))
        .sort((a, b) => {
          const ap = a.hay.startsWith(q) ? 0 : 1;
          const bp = b.hay.startsWith(q) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return (Number(b.usage) || 0) - (Number(a.usage) || 0);
        })
        .slice(0, 8);
      lastMatches = scored;
      render(scored);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && lastMatches.length) {
        e.preventDefault();
        selectStationFromSearch(lastMatches[0]);
        input.value = lastMatches[0].name;
        results.hidden = true;
      } else if (e.key === "Escape") {
        results.hidden = true;
      }
    });
    // Hide results on outside click.
    document.addEventListener("click", (e) => {
      if (!block.contains(e.target)) results.hidden = true;
    });
  }
}

// Fly to a station picked from search and open its inspect card. Ensures the
// station layer is visible so the selected ring shows.
function selectStationFromSearch(m) {
  if (!state.stationsVisible) {
    const cb = document.getElementById("station-show");
    if (cb) cb.checked = true;
    setStationsVisible(true);
  }
  map.flyTo({ center: m.coords, zoom: Math.max(map.getZoom(), 12.5), duration: 700 });
  // Project to a screen point for the floating card placement once moved.
  map.once("moveend", () => {
    const pt = map.project(m.coords);
    inspectStation(m.props, pt);
  });
  setDrawer(false);
}

// ---- Sliders UI -----------------------------------------------------------

// Redistribute weights so they always sum to 100. When the user sets `changed`
// to `newVal`, the remaining ENABLED domains absorb the difference in
// proportion to their current weights (so their relative balance is kept). If
// the others are all at zero, the difference is spread equally among them.
function rebalanceWeights(changedKey, newVal) {
  const others = DOMAINS
    .map(d => d.key)
    .filter(k => k !== changedKey && state.enabled[k]);

  newVal = Math.max(0, Math.min(100, newVal));
  state.weights[changedKey] = newVal;

  const remaining = 100 - newVal;        // budget for the others
  if (!others.length) {
    // Nothing else to absorb it; this domain alone carries 100 when enabled.
    state.weights[changedKey] = state.enabled[changedKey] ? 100 : 0;
    return;
  }

  const otherSum = others.reduce((s, k) => s + state.weights[k], 0);
  if (otherSum <= 0) {
    const each = remaining / others.length;
    others.forEach(k => { state.weights[k] = each; });
  } else {
    others.forEach(k => {
      state.weights[k] = state.weights[k] / otherSum * remaining;
    });
  }
}

// When a domain is enabled/disabled, re-spread to 100 across whatever is on.
function renormaliseEnabled() {
  const on = DOMAINS.map(d => d.key).filter(k => state.enabled[k]);
  DOMAINS.forEach(d => { if (!state.enabled[d.key]) state.weights[d.key] = 0; });
  if (!on.length) return;
  const sum = on.reduce((s, k) => s + state.weights[k], 0);
  if (sum <= 0) {
    const each = 100 / on.length;
    on.forEach(k => { state.weights[k] = each; });
  } else {
    on.forEach(k => { state.weights[k] = state.weights[k] / sum * 100; });
  }
}

// Push current weights back into every slider position + % label (used after a
// rebalance, since moving one slider changes all the others).
function syncSliderUI() {
  for (const d of DOMAINS) {
    const slider = document.getElementById(`slider-${d.key}`);
    const val = document.getElementById(`val-${d.key}`);
    if (slider) slider.value = state.weights[d.key];
    if (val) val.textContent = `${state.weights[d.key].toFixed(1)}%`;
  }
  const totalEl = document.getElementById("weight-total");
  if (totalEl) {
    const total = DOMAINS.reduce((s, d) => s + state.weights[d.key], 0);
    totalEl.textContent = `Total: ${total.toFixed(0)}%`;
  }
}

function buildSliders() {
  const wrap = document.getElementById("sliders");
  for (const d of DOMAINS) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.id = `row-${d.key}`;
    row.innerHTML = `
      <div class="label-line">
        <span class="name">
          <input type="checkbox" class="enable" id="enable-${d.key}"
                 aria-label="Include ${d.name} in combined score" checked />
          ${d.name}<button class="info" type="button"
              aria-label="What ${d.name} covers" tabindex="0">i<span
              class="tip" role="tooltip">${d.about}<span class="tip-source">Source: <a href="${d.sourceUrl}" target="_blank" rel="noopener">${d.source}</a></span></span></button></span>
        <span class="row-controls">
          <span class="val" id="val-${d.key}">${d.weight.toFixed(1)}%</span>
        </span>
      </div>
      <input type="range" min="0" max="100" step="0.5" value="${d.weight}"
             id="slider-${d.key}" aria-label="${d.name} weight (percent)" />`;
    wrap.appendChild(row);

    const input = row.querySelector(`#slider-${d.key}`);
    input.addEventListener("input", () => {
      rebalanceWeights(d.key, parseFloat(input.value));
      syncSliderUI();        // reflect the knock-on changes on every slider
      restyle();
      refreshReportIfActive();
      if (deep.active) renderDeprivationScore();   // live deep-dive headline
    });

    // Checkbox: include/exclude this domain from the combined score.
    row.querySelector(`#enable-${d.key}`).addEventListener("change", (e) => {
      state.enabled[d.key] = e.target.checked;
      row.classList.toggle("disabled", !e.target.checked);
      // A disabled domain can't be soloed; drop solo if it was on this one.
      if (!e.target.checked && state.solo === d.key) setSolo(null);
      renormaliseEnabled();  // re-spread to 100 across the still-enabled domains
      syncSliderUI();
      restyle();
      refreshReportIfActive();
      if (deep.active) renderDeprivationScore();
    });

  }

  document.getElementById("reset-weights").addEventListener("click", () => {
    setSolo(null);
    for (const d of DOMAINS) {
      state.weights[d.key] = d.weight;        // back to official IMD weights
      state.enabled[d.key] = true;
      document.getElementById(`enable-${d.key}`).checked = true;
      document.getElementById(`row-${d.key}`).classList.remove("disabled");
    }
    syncSliderUI();
    restyle();
    refreshReportIfActive();
    if (deep.active) renderDeprivationScore();
  });

  syncSliderUI();   // set the total readout on first build
}

// Switch the map to a single domain's choropleth, or back to combined (null).
// Driven by the "Layer view" radios in the Data layers panel (the individual
// IMD layers), and kept in sync when called programmatically.
function setSolo(key) {
  state.solo = key;
  document.querySelectorAll('input[name="imd-view"]').forEach(r => {
    r.checked = (r.value || null) === (key || null);
  });
  applyFillColor();
  buildLegend();
}

// ---- Plot context report (spatial aggregation, client-side) ---------------

let lastDrawnPolygon = null;

function onDrawChange() {
  const data = draw.getAll();
  if (!data.features.length) { lastDrawnPolygon = null; return; }
  lastDrawnPolygon = data.features[data.features.length - 1];
  closeDetail();   // a drawn plot supersedes a single-area inspection
  buildReport(lastDrawnPolygon);
}

function refreshReportIfActive() {
  if (lastDrawnPolygon) buildReport(lastDrawnPolygon);
}

// Area-weighted aggregation over the LSOAs a drawn plot overlaps. With vector
// tiles we don't hold all features in memory, so we ask the map which rendered
// features fall under the plot's screen bounds, then intersect those. The plot
// must be on-screen (it always is, since the user just drew it).
function buildReport(plot) {
  const report = document.getElementById("report");

  // Screen bounding box of the drawn polygon, for queryRenderedFeatures.
  const bbox = turf.bbox(plot);
  const sw = map.project([bbox[0], bbox[1]]);
  const ne = map.project([bbox[2], bbox[3]]);
  const rendered = map.queryRenderedFeatures(
    [[Math.min(sw.x, ne.x), Math.min(sw.y, ne.y)],
     [Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)]],
    { layers: ["lsoa-fill"] }
  );

  // Deduplicate by LSOA code (tiles can repeat a feature across tile edges)
  // and keep those genuinely intersecting the plot.
  const seen = new Set();
  const overlaps = [];
  for (const f of rendered) {
    const code = f.properties.lsoa_code;
    if (seen.has(code)) continue;
    seen.add(code);
    let inter;
    try {
      inter = turf.intersect(turf.featureCollection([turf.feature(plot.geometry), f]));
    } catch { inter = null; }
    if (!inter) continue;
    const area = turf.area(inter);
    let fullArea = 0;
    try { fullArea = turf.area(f); } catch (_) { fullArea = 0; }
    if (area > 0) overlaps.push({ props: f.properties, area, fullArea });
  }

  if (!overlaps.length) {
    report.innerHTML =
      `<p class="empty">Plot doesn't overlap any data areas. ` +
      `Draw within the coloured region, and zoom in so the areas are loaded.</p>`;
    return;
  }

  const totalArea = overlaps.reduce((s, o) => s + o.area, 0);
  const agg = {};
  for (const d of DOMAINS) {
    let v = 0;
    for (const o of overlaps) v += (o.props[`${d.key}_norm`] || 0) * o.area;
    agg[d.key] = v / totalArea;
  }
  const combined = combinedScore(
    Object.fromEntries(DOMAINS.map(d => [`${d.key}_norm`, agg[d.key]])),
    state.weights
  );

  // Estimated population across the plot: sum each overlapping LSOA's
  // population scaled by the share of that LSOA's area inside the plot (areal
  // interpolation — same approach as the deep dive). `o.area` is the
  // intersection area; we divide by the LSOA's full area for the share.
  let popLine = "";
  {
    let popSum = 0, haveAny = false, missing = false;
    for (const o of overlaps) {
      const pop = o.props.population;
      if (pop == null || isNaN(pop)) { missing = true; continue; }
      const full = o.fullArea;
      const share = full > 0 ? Math.min(1, o.area / full) : 0;
      popSum += Number(pop) * share;
      haveAny = true;
    }
    if (haveAny) {
      const km2 = totalArea / 1e6;
      const dens = km2 > 0 ? Math.round(popSum / km2).toLocaleString() : "—";
      popLine = `<div class="price-line"><span>Est. population</span>
           <strong>${Math.round(popSum).toLocaleString()}${missing ? "+" : ""}</strong>
           <span class="dim">${dens} / km²</span></div>`;
    }
  }

  // House-price summary across the plot: weight each area's median by its
  // sale count (more sales = more reliable), so one thin LSOA with a single
  // freak sale doesn't dominate.
  let priceLine = "";
  if (state.hasPrice) {
    // Prefer £/m² (the value metric the map is coloured by), averaged across the
    // LSOAs the plot overlaps; weight by sale count when the source carries it,
    // otherwise a straight mean. Median sale price shown alongside when present.
    let ppmSum = 0, ppmW = 0, saleSum = 0, saleW = 0, sales = 0;
    for (const o of overlaps) {
      const ppm = o.props.price_ppm2, m = o.props.price_median, c = o.props.price_count || 0;
      const w = c > 0 ? c : 1;
      if (ppm != null) { ppmSum += ppm * w; ppmW += w; }
      if (m != null)   { saleSum += m * w; saleW += w; }
      sales += c;
    }
    if (ppmW > 0) {
      const salePart = saleW > 0 ? ` · ${priceFmt(saleSum / saleW)} median sale` : "";
      priceLine = `<div class="price-line"><span>House price</span>
           <strong>${ppm2Fmt(ppmSum / ppmW)}</strong>
           <span class="dim">${sales > 0 ? sales + " sales" : ""}${salePart}</span></div>`;
    } else if (saleW > 0) {
      priceLine = `<div class="price-line"><span>Median sale price</span>
           <strong>${priceFmt(saleSum / saleW)}</strong></div>`;
    } else {
      priceLine = `<div class="price-line dim">No price data in this plot</div>`;
    }
  }

  const rows = DOMAINS.map(d => {
    const v = agg[d.key];
    return `<tr>
      <td class="name">${d.name}</td>
      <td class="bar-cell"><div class="minibar">
        <span style="width:${v.toFixed(0)}%;background:${rampColor(v)}"></span>
      </div></td>
      <td class="num">${v.toFixed(0)}</td>
    </tr>`;
  }).join("");

  report.innerHTML = `
    <div class="report-headline">
      <div class="big">${combined.toFixed(0)}<span style="font-size:14px">/100</span></div>
      <div class="cap">Combined deprivation · ${overlaps.length} area(s) · weighted</div>
    </div>
    ${popLine}
    ${priceLine}
    <table class="metric-table">${rows}</table>
    <p class="hint" style="margin-top:14px">
      Higher = more deprived (national percentile). Isochrones, nearest
      amenities &amp; policy overlays arrive with the backend.
    </p>`;
}

function rampColor(v) {
  // Colour a 0-100 value by the current breaks (matches the map). Uses the
  // combined-score breaks regardless of solo, since the report bars are always
  // per-domain percentiles on the same 0-100 scale.
  const ramp = RAMP();
  const breaks = state.breaksData?.combined_equal || [];
  if (!breaks.length) return ramp[0];
  for (let i = 0; i < breaks.length; i++) {
    if (v < breaks[i]) return ramp[i];
  }
  return ramp[ramp.length - 1];
}

// ---- Click to inspect a single LSOA ---------------------------------------

function inspectLSOA(propsOrCode, point) {
  // Accept either a properties object (from a fresh click) or, on refresh,
  // the stored code -> reuse the cached properties.
  let p;
  if (typeof propsOrCode === "string") {
    p = state.selectedProps;
    if (!p || p.lsoa_code !== propsOrCode) return;
  } else {
    p = propsOrCode;
  }
  if (!p) return;
  const code = p.lsoa_code;
  state.selectedCode = code;
  state.selectedProps = p;
  if (point) state.selectedPoint = point;   // remember where it was clicked
  map.setFilter("lsoa-selected", ["==", "lsoa_code", code]);

  const combined = combinedScore(p, state.weights);
  const priceLine = p.price_ppm2 != null
    ? `<div class="price-line"><span>House price</span>
         <strong>${ppm2Fmt(p.price_ppm2)}</strong>
         <span class="dim">${p.price_median != null ? priceFmt(p.price_median) + " median sale" : ""}</span></div>`
    : (p.price_median != null
        ? `<div class="price-line"><span>Median sale price</span>
             <strong>${priceFmt(p.price_median)}</strong></div>`
        : (state.hasPrice ? `<div class="price-line dim">No price data for this LSOA</div>` : ""));

  // Population for the single LSOA (exact — straight from the zone's own
  // figure). Density is omitted here since the floating card is compact; the
  // deep dive shows area + density for catchments.
  let popLine = "";
  if (p.population != null && !isNaN(p.population)) {
    popLine = `<div class="price-line"><span>Population</span>
         <strong>${Number(p.population).toLocaleString()}</strong>
         <span class="dim">residents</span></div>`;
  }

  const rows = DOMAINS.map(d => {
    const v = p[`${d.key}_norm`] ?? 0;
    return `<tr>
      <td class="name">${d.name}</td>
      <td class="bar-cell"><div class="minibar">
        <span style="width:${v.toFixed(0)}%;background:${rampColor(v)}"></span>
      </div></td>
      <td class="num">${v.toFixed(0)}</td>
    </tr>`;
  }).join("");

  // Location header: district (borough) prominent, LSOA name + code beneath.
  const district = p.lad_name || "Unknown district";
  const sub = p.lsoa_name ? `${p.lsoa_name} · ${code}` : code;

  const panel = document.getElementById("floating-detail");
  panel.innerHTML = `
    <button class="fd-close" aria-label="Close" title="Close">×</button>
    <div class="fd-location">
      <div class="fd-district">${district}</div>
      <div class="fd-sub">${sub}</div>
    </div>
    <div class="report-headline">
      <div class="big">${combined.toFixed(0)}<span style="font-size:14px">/100</span></div>
      <div class="cap">Combined deprivation · weighted</div>
    </div>
    ${priceLine}
    ${popLine}
    <table class="metric-table">${rows}</table>
    <p class="hint" style="margin-top:12px">
      Values are national percentiles (100 = most deprived in England).
    </p>
    <button class="deepdive-btn" id="deepdive-${code}" type="button">
      Deep dive into this area →
    </button>`;
  panel.classList.add("open");
  panel.querySelector(".fd-close").addEventListener("click", closeDetail);
  const ddBtn = panel.querySelector(".deepdive-btn");
  if (ddBtn) ddBtn.addEventListener("click", () => enterDeepDive(p));

  positionFloatingPanel(panel, state.selectedPoint);
}

// Position the floating panel near a clicked map point, relative to the map
// area and clamped so it never spills off-screen. Shared by the LSOA panel and
// the rail-stop panel.
function positionFloatingPanel(panel, pt) {
  if (!pt) return;
  const mapRect = document.getElementById("map").getBoundingClientRect();
  const appRect = document.getElementById("app").getBoundingClientRect();
  // Click point is in map-canvas pixels; convert to offset within #app
  // (the panel's positioning ancestor) by adding the map's left offset.
  const mapLeftInApp = mapRect.left - appRect.left;
  let x = mapLeftInApp + pt.x + 16;        // a little right of the cursor
  let y = pt.y - 20;                        // a little above
  const pw = 290, ph = panel.offsetHeight || 360;
  const maxX = appRect.width - pw - 12;
  const maxY = appRect.height - ph - 12;
  if (x > maxX) x = mapLeftInApp + pt.x - pw - 16;  // flip to left of cursor
  x = Math.max(mapLeftInApp + 12, Math.min(x, maxX));
  y = Math.max(12, Math.min(y, maxY));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
}

function closeDetail() {
  state.selectedCode = null;
  state.selectedProps = null;
  state.selectedPoint = null;
  map.setFilter("lsoa-selected", ["==", "lsoa_code", ""]);
  const panel = document.getElementById("floating-detail");
  panel.classList.remove("open");
  panel.innerHTML = "";
}

// ---- Central hover system --------------------------------------------------
// ONE mousemove pipeline for the whole map. Priority: station dots > rail
// stops > overlay points/lines > overlay fills > green belt > LSOA. Whatever
// wins renders into a single clean hover card (value-first rows, a colour chip
// naming the layer); the hovered LSOA additionally gets its boundary drawn.

const _esc = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function _hoverEl() { return document.getElementById("hover-card"); }

function hoverCardHide() {
  const el = _hoverEl();
  if (el) el.hidden = true;
  if (map.getLayer("lsoa-hover")) map.setFilter("lsoa-hover", ["==", "lsoa_code", ""]);
  if (map.getLayer("simd-hover")) map.setFilter("simd-hover", ["==", "lsoa_code", ""]);
}

// What the card says for each kind of feature: {title, kind, chip, rows} where
// rows are [value, label] pairs (value leads, label follows).
function hoverContentForOverlay(def, p) {
  const d = def.dataset;
  const row = (v, l) => (v == null || v === "" || v === "null") ? null : [String(v), l];
  let title = p.name || def.label, kind = def.label, rows = [];
  if (d === "power_substation") {
    title = p.name || "Substation";
    rows = [row(p.kv ? `${p.kv} kV` : null, "voltage"),
            row(p.operator, "operator"),
            row(p.substation, "class")];
  } else if (d === "power_line") {
    title = "Power line";
    rows = [row(p.kv ? `${p.kv} kV` : (p.voltage || null), "voltage"), row(p.operator, "operator")];
  } else if (d === "tec_register") {
    title = p.name || p.site || "Connection project";
    rows = [row(p.mw != null ? `${Number(p.mw).toLocaleString()} MW` : null, "queued"),
            row(p.status, "status"), row(p.plant, "plant")];
  } else if (d === "ukpn_sites") {
    title = p.sitename || p.name || "UKPN site";
    const cls = (p.siteclassification || "").toUpperCase();
    rows = [row(cls === "COLD" ? "COLD — headroom available"
                : cls === "HOT" ? "HOT — constrained" : (cls || null), "demand class"),
            row(p.sitevoltage ? `${p.sitevoltage} kV` : null, "voltage"),
            row(p.towncity, "location")];
  } else if (d === "nged_sites") {
    const hr = p.demandconnectedheadroommw ?? p.demand_connected_headroom_mw;
    title = p.name || "NGED site";
    rows = [row(hr != null && hr !== "" ? `${Number(hr).toLocaleString()} MW` : null, "demand headroom"),
            row(p.demandconnectedrag, "RAG")];
  } else if (d === "uni_campus") {
    rows = [row(p.students_total ? Number(p.students_total).toLocaleString() : null, "students"),
            row(p.intl_pct != null ? `${p.intl_pct}%` : null, "international")];
  } else if (d === "uni_campus_site" || d === "uni_building") {
    title = p.name || p.operator || def.label;
  } else if (d === "la_property") {
    title = p.name || "Public-authority property";
    rows = [row(OWNER_CLASS_LABELS[p.owner_class] || p.category || null, "owner type"),
            row(p.titles ? `${p.titles} title${p.titles > 1 ? "s" : ""}` : null, "registered")];
  } else if (d === "alc") {
    title = p.alc_grade || p.name || "Agricultural land";
    kind = "Agricultural land classification";
  } else if (d === "water_availability") {
    title = p.name || "Water body / catchment";
    kind = "Water resource availability";
    const WATER_STATUS_TEXT = {
      green: "Green — water available", yellow: "Yellow — restricted",
      red: "Red — not available", grey: "Grey — not assessed",
    };
    const ws = String(p.status || "").toLowerCase();
    rows = [row(WATER_STATUS_TEXT[ws] || p.status, "Q95 availability")];
  } else if (d === "ptal") {
    title = `PTAL ${p.ptal ?? ""}`.trim();
    kind = "Public transport access";
  } else if (d === "hdt") {
    title = p.name || "Authority";
    kind = "Housing Delivery Test";
    const hp = Number(p.hdt_pct);
    const band = hp < 75 ? "presumption in favour applies" : hp < 85 ? "20% buffer" : hp < 95 ? "action plan" : "passing";
    rows = [row(p.hdt_pct != null ? `${p.hdt_pct}%` : null, "delivery vs target"),
            row(p.consequence || band, "consequence")];
  } else if (d === "price_grid") {
    title = p.med != null ? `£${Number(p.med).toLocaleString()} median` : "Price cell";
    kind = "Sold prices — last 3 years";
    const epcReal = p.epc === true || p.epc === "true";
    const psf = v => `£${Math.round(Number(v) / 10.7639).toLocaleString()}/ft²`;
    const tr = p.trend_pct != null ? Number(p.trend_pct) : null;
    rows = [row(p.ppm2 != null
                ? `${epcReal ? "" : "~"}£${Number(p.ppm2).toLocaleString()}/m² · ${psf(p.ppm2)}`
                : null,
                epcReal ? `measured (${p.m2n} EPC-matched sales)` : "est. by type mix"),
            row(p.med_h != null
                ? `£${Number(p.med_h).toLocaleString()}` +
                  (p.ppm2_h != null ? ` · £${Number(p.ppm2_h).toLocaleString()}/m²` : "")
                : null, `houses (${p.n_h ?? "?"})`),
            row(p.med_f != null
                ? `£${Number(p.med_f).toLocaleString()}` +
                  (p.ppm2_f != null ? ` · £${Number(p.ppm2_f).toLocaleString()}/m²` : "")
                : null, `flats (${p.n_f ?? "?"})`),
            row(tr != null
                ? `${tr > 0 ? "▲ +" : tr < 0 ? "▼ " : ""}${tr}%`
                : null, `12m vs prior 24m (${p.n_r12 ?? "?"}/${p.n_p24 ?? "?"} sales)`),
            row(p.n != null ? `${Number(p.n).toLocaleString()} sales` : null, "in this cell")];
  } else if (d === "ppd_sales") {
    const PTYPE = { D: "Detached", S: "Semi-detached", T: "Terraced", F: "Flat", O: "Other" };
    title = p.price != null ? `£${Number(p.price).toLocaleString()}` : "Sale";
    kind = [p.date, PTYPE[p.ptype] || p.ptype, p.newb === "Y" ? "new build" : null,
            p.tenure === "L" ? "leasehold" : "freehold"].filter(Boolean).join(" · ");
    rows = [row(p.addr, "address"),
            row(p.ppm2r != null
                ? `£${Number(p.ppm2r).toLocaleString()}/m² · ` +
                  `£${Math.round(Number(p.ppm2r) / 10.7639).toLocaleString()}/ft² ` +
                  `(${p.m2} m² EPC)`
                : null, "measured")];
  } else if (d === "build_cost_index") {
    title = p.name || "Local authority";
    kind = "Build cost index — free proxy, not BCIS";
    rows = [row(p.factor != null ? `${Number(p.factor).toFixed(2)}× national` : null,
                p.src === "default" ? "no regional factor — national assumed" : (p.region || "region factor")),
            row(p.cost_house_pm2 != null ? `£${Number(p.cost_house_pm2).toLocaleString()}/m²` : null, "houses, indicative"),
            row(p.cost_flat_pm2 != null ? `£${Number(p.cost_flat_pm2).toLocaleString()}/m²` : null, "flats, indicative"),
            row("override in Viability variables", "per-project")];
  } else if (d === "land_value") {
    title = p.resi_gbp_ha != null
      ? `£${(Number(p.resi_gbp_ha) / 1e6).toFixed(1)}M/ha` : (p.name || "Local authority");
    kind = "Residential land value — MHCLG policy appraisal estimate";
    rows = [row(p.name || null, "authority"),
            row(p.resi_gbp_ha != null ? `£${Number(p.resi_gbp_ha).toLocaleString()}/ha` : null,
                `typical residential site${p.asof ? ` (${p.asof})` : ""}`),
            row("appraisal benchmark — not a valuation of any specific site", "VOA/MHCLG caveat")];
  } else if (d === "lad_income") {
    // Serves both geographies: district (ASHE individual pay) and, close in,
    // MSOA neighbourhoods (ONS household income, hh flag) — say which.
    const hh = p.hh === true || p.hh === "true";
    title = p.afford_ratio != null ? `${Number(p.afford_ratio).toFixed(1)}× income` : (p.name || "Area");
    kind = hh ? "Affordability — price ÷ household income (neighbourhood)"
              : "Affordability — price ÷ gross pay (district)";
    rows = [row(p.med_price != null ? `£${Number(p.med_price).toLocaleString()}` : null,
                `median price (${p.n_sales_12m ?? "?"} sales, 12m)`),
            row(p.income_median != null ? `£${Number(p.income_median).toLocaleString()}` : null,
                `${hh ? "household income" : "median annual pay"}${p.asof ? ` (${p.asof})` : ""}`),
            row(p.name || null, hh ? "neighbourhood (MSOA)" : "authority")];
  } else if (d === "la_rents") {
    title = p.name || "Local authority";
    rows = [row(p.rent_mean != null ? `£${Number(p.rent_mean).toLocaleString()}/mo` : null, "avg rent"),
            row(p.annual_rent_change_pct != null ? `${p.annual_rent_change_pct > 0 ? "+" : ""}${p.annual_rent_change_pct}%` : null, "year on year")];
  } else if (d === "planit_rates") {
    title = p.name || "Authority";
    kind = "Planning approval rate — last 3 years";
    rows = [row(p.approval_pct != null ? `${p.approval_pct}%` : null, "approved"),
            row(p.approved_3y != null ? `${Number(p.approved_3y).toLocaleString()} approved · ${Number(p.refused_3y).toLocaleString()} refused` : null, "decisions"),
            row(p.apps_year != null ? `${Number(p.apps_year).toLocaleString()}/yr` : null, "decision volume")];
  } else if (def.key === "gsp_queue" || (d === "gsp_boundary" && p.queued_mw != null)) {
    title = p.name || "Grid Supply Point";
    kind = "Connection queue at this GSP";
    rows = [row(p.queued_mw != null ? `${Number(p.queued_mw).toLocaleString()} MW` : null, "queued"),
            row(p.queued_n != null ? `${Number(p.queued_n).toLocaleString()} projects` : null, "in the queue")];
  } else if (d === "ofcom_fibre") {
    title = p.name || "Authority";
    kind = "Fixed broadband coverage";
    rows = [row(p.fttp_pct != null ? `${p.fttp_pct}%` : null, "full fibre (FTTP)"),
            row(p.gigabit_pct != null ? `${p.gigabit_pct}%` : null, "gigabit-capable")];
  } else if (d === "census_students") {
    title = p.name || "Authority";
    kind = "Census 2021 full-time students";
    rows = [row(p.students != null ? Number(p.students).toLocaleString() : null, "students"),
            row(p.students_pct != null ? `${p.students_pct}%` : null, "of adults")];
  } else if (d === "student_accom") {
    title = p.name || "Student accommodation";
    kind = "Existing PBSA / dormitory (OSM)";
    rows = [row(p.operator, "operator")];
  } else if (d === "slope_grid") {
    title = p.slope != null ? `${p.slope}° mean slope` : "Slope cell";
    // Cells merge as you zoom out (grid_in_bbox), so say what this square
    // actually represents rather than always claiming a single 1 km cell.
    const nCells = Number(p.cells) || 1;
    kind = nCells > 1
      ? `Ground slope — mean of ${nCells.toLocaleString()} × 1 km cells`
      : "Ground slope — 1 km cell";
    rows = [row(p.max_slope != null ? `${p.max_slope}°` : null,
                nCells > 1 ? "steepest 50 m in group" : "steepest 50 m")];
  } else if (d === "public_parcel") {
    const m = parcelConfidence(p);
    title = p.owner || p.name || "Public land";
    kind = "Publicly owned parcel";
    rows = [row(OWNER_CLASS_LABELS[p.owner_class] || p.owner_class, "owner type"),
            row(p.area_m2 != null ? `${(Number(p.area_m2) / 10000).toFixed(2)} ha` : null, "parcel area"),
            row(p.titles_land != null ? `${p.titles_land} land title${p.titles_land == 1 ? "" : "s"}` : null, "registered"),
            row(p.assets != null && p.assets > 1 ? `${p.assets} holdings here` : null, "asset register"),
            row(p.stated_ha != null ? `${Number(p.stated_ha).toFixed(2)} ha stated` +
                (p.area_mismatch ? " ⚠ disagrees with the parcel" : "") : null, "register says"),
            row(m ? `${m.tier} — ${m.label}` : (p.match || null), "how we know")];
  } else if (d === "bus_route") {
    title = p.ref ? `Bus ${p.ref}` : (p.name || "Bus route");
    kind = p.name && p.ref ? p.name : "Bus route";
    rows = [row(p.operator, "operator")];
  } else if (d === "bus_stop") {
    title = p.name || "Bus stop";
    kind = p.locality ? `Bus stop — ${p.locality}` : "Bus stop";
    rows = [row(p.buses_hr != null ? `${p.buses_hr}/hr` : null, "weekday daytime"),
            row(p.routes, "routes")];
  } else if (d === "grey_belt_candidate") {
    title = p.name || "Grey-belt candidate";
    kind = "Grey-belt candidate — model, not a designation";
    rows = [row(p.area_ha != null ? `${Number(p.area_ha).toLocaleString()} ha` : null, "area"),
            row(p.source === "brownfield" ? "registered brownfield in Green Belt"
                : "built-up area in Green Belt", "basis")];
  } else if (def.brownfield) {
    title = p.name || "Brownfield site";
    kind = "Brownfield register site";
    const pub = p.is_public === true || p.is_public === "true";
    rows = [row(pub ? "Public authority" : (p.ownership_status || null), "ownership"),
            row(p.dwellings_max ? `up to ${Number(p.dwellings_max).toLocaleString()} homes` : null, "capacity"),
            row(p.hectares ? `${Number(p.hectares).toLocaleString()} ha` : null, "size"),
            row(p.permission_status, "permission")];
  } else if (def.kinds || def.ownership) {
    title = p.name || def.label;
  }
  return { title, kind, chip: def.color, rows: rows.filter(Boolean) };
}

function hoverCardHTML(c, hint) {
  const rows = (c.rows || []).map(([v, l]) =>
    `<span class="hc-row"><strong class="hc-v">${_esc(v)}</strong><span class="hc-k">${_esc(l)}</span></span>`).join("");
  return `<div class="hc-head"><span class="hc-chip" style="background:${c.chip}"></span>` +
         `<span class="hc-title">${_esc(c.title || "")}</span></div>` +
         (c.kind ? `<div class="hc-kind">${_esc(c.kind)}</div>` : "") +
         (rows ? `<div class="hc-rows">${rows}</div>` : "") +
         (hint ? `<div class="hc-hint">${hint}</div>` : "");
}

function initHoverSystem() {
  // Touch devices have no hover — the tap dispatcher already covers them.
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
  const container = map.getContainer();
  let card = _hoverEl();
  if (!card) {
    card = document.createElement("div");
    card.id = "hover-card";
    card.hidden = true;
    container.appendChild(card);
  }

  // Hovered-boundary outline for LSOAs / Scottish Data Zones, under the
  // station dots so markers stay on top.
  const boundaryBefore = map.getLayer("station-dot") ? "station-dot" : undefined;
  if (map.getLayer("lsoa-fill") && !map.getLayer("lsoa-hover"))
    map.addLayer({ id: "lsoa-hover", type: "line", source: "lsoa", "source-layer": SOURCE_LAYER,
      paint: { "line-color": "#339af0", "line-width": 1.8, "line-opacity": 0.95 },
      filter: ["==", "lsoa_code", ""] }, boundaryBefore);
  if (map.getLayer("simd-fill") && !map.getLayer("simd-hover"))
    map.addLayer({ id: "simd-hover", type: "line", source: "lsoa", "source-layer": "simd",
      paint: { "line-color": "#339af0", "line-width": 1.8, "line-opacity": 0.95 },
      filter: ["==", "lsoa_code", ""] }, boundaryBefore);

  const overlayLayerIds = () => {
    // Points/lines first (small targets beat big fills), then polygon fills.
    const ids = [];
    for (const o of MAP_OVERLAYS)
      for (const sfx of ["icon", "pt", "line"])
        if (map.getLayer(`ov-${o.key}-${sfx}`)) ids.push(`ov-${o.key}-${sfx}`);
    for (const o of MAP_OVERLAYS)
      if (map.getLayer(`ov-${o.key}-fill`)) ids.push(`ov-${o.key}-fill`);
    return ids;
  };
  const overlayFromLayerId = (id) => {
    const m = id.match(/^ov-(.+)-(icon|pt|line|fill|lbl)$/);
    return m ? overlayDef(m[1]) : null;
  };

  let raf = 0;
  map.on("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateHover(e); });
  });
  map.getCanvas().addEventListener("mouseleave", () => {
    map.getCanvas().style.cursor = "";
    hoverCardHide();
  });

  function updateHover(e) {
    const tol = 5;
    const box = [[e.point.x - tol, e.point.y - tol], [e.point.x + tol, e.point.y + tol]];

    // Priority candidates, in order.
    const prio = [];
    if (state.hasStations && state.stationsVisible !== false && map.getLayer("station-dot"))
      prio.push("station-dot");
    if (map.getLayer("rail-stop")) prio.push("rail-stop");
    prio.push(...overlayLayerIds());
    if (state.hasGreenbelt && map.getLayer("greenbelt-fill")
        && map.getLayoutProperty("greenbelt-fill", "visibility") === "visible")
      prio.push("greenbelt-fill");
    // Buildings sit above parcels: the smaller, more specific thing wins.
    if (buildingsState.on && map.getLayer("building-fill")) prio.push("building-fill");
    if (parcelsState.on && map.getLayer("parcel-fill")) prio.push("parcel-fill");

    let hits = [];
    if (prio.length) {
      try { hits = map.queryRenderedFeatures(box, { layers: prio }); } catch (_) { hits = []; }
    }
    let winner = null;
    for (const id of prio) {
      const f = hits.find(h => h.layer && h.layer.id === id);
      if (f) { winner = { id, f }; break; }
    }

    // The LSOA under the cursor: boundary always highlights while a
    // choropleth is on; the card falls back to its summary when nothing
    // more specific is hovered.
    let lsoa = null;
    const lsoaLayers = ["lsoa-fill", "simd-fill"].filter(id => map.getLayer(id));
    if (lsoaLayers.length && (state.imdOn || state.priceOn)) {
      try {
        const lf = map.queryRenderedFeatures(e.point, { layers: lsoaLayers });
        if (lf.length) lsoa = lf[0].properties;
      } catch (_) {}
    }
    const code = lsoa ? lsoa.lsoa_code : "";
    if (map.getLayer("lsoa-hover")) map.setFilter("lsoa-hover", ["==", "lsoa_code", code || ""]);
    if (map.getLayer("simd-hover")) map.setFilter("simd-hover", ["==", "lsoa_code", code || ""]);

    let html = null;
    if (winner) {
      const p = winner.f.properties || {};
      if (winner.id === "station-dot") {
        const rows = [];
        if (p.usage != null && p.usage !== "")
          rows.push([fmtCount(Number(p.usage)), "entries/exits"]);
        if (p.crs) rows.push([p.crs, "CRS"]);
        html = hoverCardHTML({ title: p.name || "Station", kind: "Rail station (usage-scaled)",
                               chip: STATION_COLOR, rows }, "click for the station workflow");
      } else if (winner.id === "rail-stop") {
        const m = railMode(p.mode);
        html = hoverCardHTML({ title: p.name || "Stop", kind: m ? m.label : "Transit stop",
                               chip: (m && m.color) || "#666", rows: [] }, "click for details");
      } else if (winner.id === "greenbelt-fill") {
        html = hoverCardHTML({ title: p.name || "Green Belt", kind: "Green Belt",
                               chip: GREENBELT_COLOR, rows: [] });
      } else if (winner.id === "building-fill") {
        const CLS = { high: "High rise", mid: "Mid rise", low: "Low rise",
                      unknown: "Building" };
        const known = p.height_m != null && p.height_m !== "";
        const rows = [];
        if (known) rows.push([`${p.height_m} m`, "height"]);
        if (p.storeys != null) rows.push([`${p.storeys}`, "storeys"]);
        html = hoverCardHTML({ title: p.name || CLS[p.class] || "Building",
                               kind: known
                                 ? `${CLS[p.class] || "Building"} — OSM tagged height`
                                 : "Building — no height recorded in OSM",
                               chip: buildingBandColor(known ? p.height_m : null),
                               rows });
      } else if (winner.id === "parcel-fill") {
        html = hoverCardHTML({ title: `Parcel ${p.INSPIREID ?? p.inspireid ?? ""}`.trim(),
                               kind: "HMLR INSPIRE index parcel", chip: PARCEL_COLOR, rows: [] },
                             "outline only — click for details");
      } else {
        const def = overlayFromLayerId(winner.id);
        if (def) html = hoverCardHTML(hoverContentForOverlay(def, p), "click for full details");
      }
    } else if (lsoa) {
      const rows = [[combinedScore(lsoa, state.weights).toFixed(0) + "/100", "deprivation"]];
      if (lsoa.price_ppm2 != null) rows.push([ppm2Fmt(lsoa.price_ppm2), "house price"]);
      else if (lsoa.price_median != null) rows.push([priceFmt(lsoa.price_median), "median sale"]);
      if (lsoa.population != null && !isNaN(lsoa.population))
        rows.push([Number(lsoa.population).toLocaleString(), "residents"]);
      html = hoverCardHTML({ title: lsoa.lad_name || lsoa.lsoa_name || "Neighbourhood",
                             kind: lsoa.lsoa_name ? `${lsoa.lsoa_name} · ${code}` : code,
                             chip: rampColor(combinedScore(lsoa, state.weights)), rows },
                           "click to inspect · right-click for spot summary");
    }

    map.getCanvas().style.cursor = (winner || lsoa) ? "pointer" : "";
    if (!html) { card.hidden = true; return; }
    card.innerHTML = html;
    card.hidden = false;
    // Position beside the cursor, flipping at the right/bottom edges.
    const mw = container.clientWidth, mh = container.clientHeight;
    const cw = card.offsetWidth || 220, ch = card.offsetHeight || 90;
    let x = e.point.x + 16, y = e.point.y + 14;
    if (x + cw > mw - 8) x = e.point.x - cw - 14;
    if (y + ch > mh - 8) y = e.point.y - ch - 12;
    card.style.left = `${Math.max(8, x)}px`;
    card.style.top = `${Math.max(8, y)}px`;
  }
}

// ---- Right-click "Spot summary" --------------------------------------------
// A small context menu on right-click; "Spot summary" pulls everything we know
// about that exact point into a floating card — LSOA stats client-side, plus
// the point_summary RPC answering from the full national tables (so layers
// don't need to be switched on to be reported).

function constraintChipMeta(kind) {
  const o = MAP_OVERLAYS.find(m => m.kinds && m.kinds.includes(kind));
  if (o) return { label: o.label, color: o.color };
  if (kind === "green_belt") return { label: "Green Belt", color: GREENBELT_COLOR };
  return { label: kind.replace(/_/g, " "), color: "#868e96" };
}

function _distMeters(a, b) {
  const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function _fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function nearestUsageStation(lngLat) {
  const feats = (state.stationsData && state.stationsData.features) || [];
  let best = null, bestD = Infinity;
  for (const f of feats) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c) continue;
    const d = _distMeters(lngLat, { lng: c[0], lat: c[1] });
    if (d < bestD) { bestD = d; best = f; }
  }
  return best ? { props: best.properties, dist: bestD } : null;
}

function initSpotSummary() {
  const container = map.getContainer();
  let menu = document.getElementById("ctx-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "ctx-menu";
    menu.hidden = true;
    container.appendChild(menu);
  }
  const hideMenu = () => { menu.hidden = true; };

  map.on("contextmenu", (e) => {
    if (e.originalEvent) e.originalEvent.preventDefault();
    hoverCardHide();
    const ll = e.lngLat;
    menu.innerHTML =
      `<button type="button" class="ctx-item" data-act="spot">📍 Spot summary</button>` +
      `<button type="button" class="ctx-item" data-act="coords">⧉ Copy coordinates</button>`;
    menu.hidden = false;
    const mw = container.clientWidth, mh = container.clientHeight;
    let x = e.point.x, y = e.point.y;
    if (x + 180 > mw - 6) x = mw - 186;
    if (y + 84 > mh - 6) y = mh - 90;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelector('[data-act="spot"]').addEventListener("click", () => {
      hideMenu();
      showSpotSummary(ll, e.point);
    });
    menu.querySelector('[data-act="coords"]').addEventListener("click", () => {
      hideMenu();
      try { navigator.clipboard.writeText(`${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`); } catch (_) {}
    });
  });
  document.addEventListener("click", (ev) => { if (!menu.contains(ev.target)) hideMenu(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { hideMenu(); closeSpotPanel(); }
  });
}

function closeSpotPanel() {
  const panel = document.getElementById("spot-panel");
  if (panel) { panel.classList.remove("open"); panel.innerHTML = ""; }
}

async function showSpotSummary(lngLat, point) {
  let panel = document.getElementById("spot-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "spot-panel";
    document.getElementById("app").appendChild(panel);
  }
  const coordLine = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  panel.innerHTML = `
    <button class="fd-close" aria-label="Close">×</button>
    <div class="fd-location"><div class="fd-district">Spot summary</div>
    <div class="fd-sub">${coordLine}</div></div>
    <p class="hint">Reading this spot…</p>`;
  panel.classList.add("open");
  panel.querySelector(".fd-close").addEventListener("click", closeSpotPanel);
  positionFloatingPanel(panel, point);

  // Client-side context (available instantly).
  let lsoa = null;
  try {
    const layers = ["lsoa-fill", "simd-fill"].filter(id => map.getLayer(id));
    const lf = map.queryRenderedFeatures([point.x, point.y], { layers });
    if (lf.length) lsoa = lf[0].properties;
  } catch (_) {}
  const stn = nearestUsageStation(lngLat);

  // Server-side: everything at the point from the national tables.
  let ps = null, psErr = null;
  const sb = (typeof getSupabase === "function") ? getSupabase() : null;
  if (sb) {
    try {
      const { data, error } = await sb.rpc("point_summary",
        { p_lon: lngLat.lng, p_lat: lngLat.lat });
      if (error) throw error;
      ps = data || {};
    } catch (err) {
      console.error("point_summary failed", err);
      psErr = err;
    }
  }

  const line = (label, valueHTML) => valueHTML == null || valueHTML === "" ? "" :
    `<div class="sp-row"><span class="sp-v">${valueHTML}</span><span class="sp-k">${_esc(label)}</span></div>`;
  const sec = (title, inner) => inner ? `<div class="sp-sec"><div class="sp-h">${_esc(title)}</div>${inner}</div>` : "";
  const strong = v => `<strong>${_esc(v)}</strong>`;

  // Location.
  const areas = (ps && ps.areas) || {};
  const lad = (areas.lad_boundary && areas.lad_boundary.name) || (lsoa && lsoa.lad_name) || null;
  const lpa = areas.lpa_boundary && areas.lpa_boundary.name;
  let locSec = "";
  locSec += line("district", lad ? strong(lad) : null);
  locSec += line("planning authority", lpa && lpa !== lad ? strong(lpa) : null);
  if (lsoa) locSec += line("LSOA", strong(lsoa.lsoa_name ? `${lsoa.lsoa_name} (${lsoa.lsoa_code})` : lsoa.lsoa_code));
  if (areas.uni_campus_site) locSec += line("on campus", strong(areas.uni_campus_site.name || "university campus"));

  // People & deprivation (LSOA-level, client side).
  let peopleSec = "";
  if (lsoa) {
    const comb = combinedScore(lsoa, state.weights);
    const worst = DOMAINS.map(d => ({ n: d.name, v: lsoa[`${d.key}_norm`] ?? 0 }))
      .sort((a, b) => b.v - a.v).slice(0, 2);
    peopleSec += line("deprivation", `<strong>${comb.toFixed(0)}/100</strong> <span class="sp-dim">worst: ${_esc(worst.map(w => `${w.n} ${w.v.toFixed(0)}`).join(", "))}</span>`);
    if (lsoa.population != null && !isNaN(lsoa.population))
      peopleSec += line("population", strong(Number(lsoa.population).toLocaleString()) + ` <span class="sp-dim">this LSOA</span>`);
  }

  // Housing.
  let houseSec = "";
  if (lsoa && lsoa.price_ppm2 != null) houseSec += line("house price", strong(ppm2Fmt(lsoa.price_ppm2)));
  else if (lsoa && lsoa.price_median != null) houseSec += line("median sale", strong(priceFmt(lsoa.price_median)));
  if (areas.la_rents && areas.la_rents.rent_mean != null) {
    const ch = areas.la_rents.annual_rent_change_pct;
    houseSec += line("avg private rent", strong(`£${Number(areas.la_rents.rent_mean).toLocaleString()}/mo`) +
      (ch != null ? ` <span class="sp-dim">${ch > 0 ? "+" : ""}${_esc(ch)}% y/y</span>` : ""));
  }
  if (ps && ps.brownfield_nearby > 0)
    houseSec += line("brownfield sites", strong(String(ps.brownfield_nearby)) + ` <span class="sp-dim">within 800 m</span>`);

  // Planning & environment designations AT the point, as colour chips.
  let chips = [];
  for (const c of (ps && ps.constraints) || []) {
    const m = constraintChipMeta(c.kind);
    chips.push(`<span class="chip" title="${_esc(c.name || m.label)}"><i style="background:${m.color}"></i>${_esc(m.label)}</span>`);
  }
  for (const [dkey, label, color] of [["article4", "Article 4 area", "#c2255c"],
                                      ["tpo_zone", "Tree preservation", "#2b8a3e"],
                                      ["design_code_area", "Design code", "#e8590c"]]) {
    if (areas[dkey]) chips.push(`<span class="chip" title="${_esc(areas[dkey].name || label)}"><i style="background:${color}"></i>${_esc(label)}</span>`);
  }
  let planSec = chips.length ? `<div class="sp-chips">${chips.join("")}</div>` : "";
  if (!chips.length && ps) planSec = `<div class="sp-row"><span class="sp-dim">No designations at this exact spot.</span></div>`;
  if (areas.planit_rates && areas.planit_rates.approval_pct != null)
    planSec += line("approval rate", strong(`${areas.planit_rates.approval_pct}%`) +
      ` <span class="sp-dim">3-yr · ${_esc(String(areas.planit_rates.apps_year ?? "?"))} decided/yr</span>`);
  if (areas.grey_belt_candidate)
    planSec += line("grey-belt potential", strong(areas.grey_belt_candidate.name || "candidate area") +
      ` <span class="sp-dim">model${areas.grey_belt_candidate.area_ha != null ? ` · ${_esc(String(areas.grey_belt_candidate.area_ha))} ha` : ""}</span>`);
  if (areas.alc) planSec += line("agricultural land", strong(areas.alc.alc_grade || areas.alc.name || ""));
  if (areas.water_availability && (areas.water_availability.name || Object.keys(areas.water_availability).length > 1))
    planSec += line("water availability", strong(areas.water_availability.name || "assessed catchment"));

  // Ownership.
  let ownSec = "";
  for (const o of (ps && ps.ownership) || []) {
    const body = MAP_OVERLAYS.find(m => m.bodies && m.bodies.includes(o.body));
    ownSec += line("public land", strong(body ? body.label : (o.owner || o.body)));
  }

  // Power.
  let powSec = "";
  if (ps && ps.nearest_substation) {
    const n = ps.nearest_substation;
    powSec += line("nearest substation", strong(_fmtDist(n.dist_m)) +
      ` <span class="sp-dim">${_esc([n.kv ? `${n.kv} kV` : "local", n.name || n.operator].filter(Boolean).join(" · "))}</span>`);
  }
  if (ps && ps.nearest_grid_substation) {
    const n = ps.nearest_grid_substation;
    powSec += line("nearest grid-scale", strong(_fmtDist(n.dist_m)) +
      ` <span class="sp-dim">${_esc([`${n.kv} kV`, n.name || n.operator].filter(Boolean).join(" · "))}</span>`);
  }
  if (areas.gsp_boundary) powSec += line("grid supply point", strong(areas.gsp_boundary.name || ""));
  if (ps && ps.nearest_tec && ps.nearest_tec.dist_m < 10000) {
    const t = ps.nearest_tec;
    powSec += line("connection queue", strong(`${t.mw ?? "?"} MW`) +
      ` <span class="sp-dim">${_esc([t.status, t.name, _fmtDist(t.dist_m)].filter(Boolean).join(" · "))}</span>`);
  }

  // Transport.
  let trSec = "";
  if (stn) trSec += line("nearest station", strong(stn.props.name || "Station") +
    ` <span class="sp-dim">${_fmtDist(stn.dist)}${stn.props.usage ? ` · ${fmtCount(Number(stn.props.usage))} entries/exits` : ""}</span>`);
  if (areas.ptal) trSec += line("PTAL", strong(String(areas.ptal.ptal ?? areas.ptal.name ?? "")));

  const errNote = psErr ? `<p class="hint">Some checks didn't load (database busy) — showing what's available.</p>` : "";

  panel.innerHTML = `
    <button class="fd-close" aria-label="Close">×</button>
    <div class="fd-location"><div class="fd-district">Spot summary</div>
    <div class="fd-sub">${coordLine}</div></div>
    ${sec("Location", locSec)}
    ${sec("People & deprivation", peopleSec)}
    ${sec("Housing & land", houseSec)}
    ${sec("Planning & environment", planSec)}
    ${sec("Public land ownership", ownSec)}
    ${sec("Power", powSec)}
    ${sec("Transport", trSec)}
    ${errNote}`;
  panel.querySelector(".fd-close").addEventListener("click", closeSpotPanel);
  positionFloatingPanel(panel, point);
}

// ---- Hover popup ----------------------------------------------------------

// Within an open deep dive, resolve a tap to a detail-layer feature (brownfield
// site, amenity, or crime point) and show its popup. Returns true if something
// was hit. Used by the unified tap dispatcher so these work on touch (their
// original layer-specific click handlers don't fire on touchscreens).
function tapDeepDiveLayers(point, box, nearest, coarse) {
  const q = (id) => {
    if (!map.getLayer(id)) return null;
    try { const h = map.queryRenderedFeatures(box, { layers: [id] }); return h && h.length ? h : null; }
    catch (_) { return null; }
  };

  // 1. Brownfield sites (the actionable supply) — polygon fill then point dots.
  for (const id of ["brownfield-pt-dot", "brownfield-poly-fill"]) {
    const hits = q(id);
    if (hits) {
      const f = id.endsWith("-dot") ? nearest(hits) : hits[0];
      const ll = f.geometry && f.geometry.type === "Point"
        ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
        : map.unproject([point.x, point.y]);
      openClickPopup({ offset: 12, maxWidth: "300px", closeButton: true, closeOnClick: true, className: "bf-popup" },
        ll, brownfieldPopupHTML(f.properties));
      return true;
    }
  }

  // 2. Amenities — any enabled kind's dot/symbol layer.
  for (const a of AMENITY_KINDS) {
    const hits = q(`amenity-${a.kind}-dot`);
    if (hits) {
      const f = nearest(hits);
      const pr = f.properties;
      const ll = f.geometry && f.geometry.coordinates
        ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
        : map.unproject([point.x, point.y]);
      openClickPopup({ offset: 8 }, ll, `<strong>${pr.name}</strong><br>${pr.sub || a.label}`);
      return true;
    }
  }

  // 3. Crime points.
  const crime = q("crime-dot");
  if (crime) {
    const f = nearest(crime);
    const pr = f.properties;
    const ll = f.geometry && f.geometry.coordinates
      ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
      : map.unproject([point.x, point.y]);
    openClickPopup({ offset: 8 }, ll,
      `<strong>${pr.count} crime${pr.count == 1 ? "" : "s"}</strong>` +
      (pr.street ? `<br>${pr.street}` : "") +
      (pr.breakdown ? `<br><span style="font-size:11px;text-transform:capitalize">${pr.breakdown}</span>` : ""));
    return true;
  }

  // 3b. Publicly-owned parcels — smaller than the developable blanket, so
  // they win over it.
  {
    const hits = q("publicland-fill");
    if (hits) {
      const ll = map.unproject([point.x, point.y]);
      openClickPopup({ offset: 8, maxWidth: "300px" }, ll,
        publicLandPopupHTML(hits[0].properties || {}));
      return true;
    }
  }

  // 4. Developable land / blockers — large area polygons, lowest priority so
  // amenity / brownfield / crime taps win over them.
  for (const id of ["developable-inner-fill", "developable-fill", "developable-blockers"]) {
    const hits = q(id);
    if (hits) {
      const ll = map.unproject([point.x, point.y]);
      if (id === "developable-blockers") {
        // In assemble mode a blocker click is dead space, not a popup — the
        // user is mid-selection and a modal interruption loses their flow.
        if (!deep.assembly.active)
          openClickPopup({ offset: 8 }, ll, developablePopupHTML(id));
      } else if (deep.assembly.active) {
        // Assemble mode: clicks toggle plots in and out of the assembly
        // instead of opening the single-plot analysis.
        toggleAssemblyPlot(hits[0], point);
      } else {
        // A specific green plot: highlight it and analyse just that plot.
        selectDevelopablePlot(hits[0], ll, point);
      }
      return true;
    }
  }

  return false;
}

function wireInteractions() {
  // --- Station click (highest priority) ------------------------------------
  // Handled centrally rather than as a layer-specific handler: query for a
  // station dot at the click point first, and if found, open the station card
  // and stop. This is robust to layer ordering and to the station dots
  // coinciding with tile-based rail stops on the live map. Registered FIRST so
  // it runs before the lsoa-fill / rail-stop handlers in the same click cycle.
  // --- Unified tap handling -------------------------------------------------
  // On touch devices MapLibre often does NOT synthesise a `click` from a tap
  // (it consumes the touch as a potential drag/pinch gesture), so relying on
  // map.on("click") leaves mobile completely unable to select anything — even
  // though pan/zoom work. We instead run ALL feature selection through one
  // dispatcher, driven by map.on("click") on desktop AND by our own tap
  // detector on the canvas for touch. The dispatcher resolves the priority
  // chain: station dot → rail stop → LSOA zone.
  function handleMapTap(point, lngLat) {
    dbg("handleMapTap", [Math.round(point.x), Math.round(point.y)]);
    if (state.plotPointMode) return false;       // taps are for dropping a point
    try {
      const m = draw.getMode && draw.getMode();
      if (m && m !== "simple_select" && m !== "static") return false;  // mid-draw
    } catch (_) {}

    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const tol = coarse ? 16 : 8;
    const box = [[point.x - tol, point.y - tol], [point.x + tol, point.y + tol]];
    const nearest = (hits) => {
      let best = hits[0], bestD = Infinity;
      for (const h of hits) {
        const c = h.geometry && h.geometry.coordinates;
        if (!c) continue;
        const p = map.project(c);
        const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
        if (d < bestD) { bestD = d; best = h; }
      }
      return best;
    };

    // When a deep dive is open, taps select the detail layers inside it —
    // brownfield sites, amenities, crime — and show their popups. These run via
    // the dispatcher (not layer-specific click handlers) so they work on touch.
    if (deep.active) {
      if (tapDeepDiveLayers(point, box, nearest, coarse)) return true;
    }

    // 1. Station dot (rich card) — highest priority.
    if (state.hasStations && state.stationsVisible !== false && map.getLayer("station-dot")) {
      let hits = null;
      try { hits = map.queryRenderedFeatures(box, { layers: ["station-dot"] }); } catch (_) {}
      if (hits && hits.length) {
        dbg("tap → station", hits.length);
        inspectStation(nearest(hits).properties, point);
        setDrawer(false);
        return true;
      }
    }

    // 2. Rail stop — upgrade to station card if we can match it, else stop card.
    if (state.hasRail && map.getLayer("rail-stop")) {
      let hits = null;
      try { hits = map.queryRenderedFeatures(box, { layers: ["rail-stop"] }); } catch (_) {}
      if (hits && hits.length) {
        const props = nearest(hits).properties;
        dbg("tap → rail-stop", props.name);
        if (state.hasStations) {
          const station = findStationForStop(props);
          if (station) { inspectStation(station.properties, point); setDrawer(false); return true; }
        }
        inspectStop(props, point);
        setDrawer(false);
        return true;
      }
    }

    // 3. Data-layer overlay features — points/lines first (small targets beat
    // big fills), then polygon fills. Handled here so a click opens ONE card
    // instead of an overlay popup and the LSOA panel fighting each other.
    const ovIds = [];
    for (const o of MAP_OVERLAYS)
      for (const sfx of ["icon", "pt", "line"])
        if (map.getLayer(`ov-${o.key}-${sfx}`)) ovIds.push(`ov-${o.key}-${sfx}`);
    for (const o of MAP_OVERLAYS)
      if (map.getLayer(`ov-${o.key}-fill`)) ovIds.push(`ov-${o.key}-fill`);
    if (ovIds.length) {
      let hits = null;
      try { hits = map.queryRenderedFeatures(box, { layers: ovIds }); } catch (_) {}
      if (hits && hits.length) {
        for (const id of ovIds) {
          const f = hits.find(h => h.layer && h.layer.id === id);
          if (!f) continue;
          const m = id.match(/^ov-(.+)-(icon|pt|line|fill)$/);
          const ll = f.geometry && f.geometry.type === "Point"
            ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
            : map.unproject([point.x, point.y]);
          dbg("tap → overlay", id);
          openOverlayCard(m[1], f.properties || {}, ll);
          setDrawer(false);
          return true;
        }
      }
    }

    // 3b. Land parcel (INSPIRE tiles) — below overlays, above the LSOA fallback.
    if (parcelsState.on && map.getLayer("parcel-fill")) {
      let hits = null;
      try { hits = map.queryRenderedFeatures(box, { layers: ["parcel-fill"] }); } catch (_) {}
      if (hits && hits.length) {
        const p = hits[0].properties || {};
        const pid = p.INSPIREID ?? p.inspireid ?? "?";
        hoverCardHide();
        openClickPopup({ closeButton: true, maxWidth: "300px", offset: 10 },
          map.unproject([point.x, point.y]),
          `<div class="ovp"><div class="ovp-title">Parcel ${_esc(pid)}</div>` +
          `<table class="ovp-table"><tr><td class="ovp-k">INSPIRE ID</td><td class="ovp-v">${_esc(pid)}</td></tr></table>` +
          `<p class="ovp-note">Registered parcel outline (HM Land Registry INSPIRE index). The free data doesn't name the owner — cross-reference the council-property dots; exact title-to-parcel ownership is HMLR's licensed National Polygon Service.</p></div>`);
        setDrawer(false);
        return true;
      }
    }

    // 4. LSOA zone — unless a deep dive is open (you're working inside one).
    if (!deep.active && map.getLayer("lsoa-fill")) {
      let hits = null;
      try { hits = map.queryRenderedFeatures(box, { layers: ["lsoa-fill"] }); } catch (_) {}
      if (hits && hits.length) {
        dbg("tap → lsoa zone");
        inspectLSOA(hits[0].properties, point);
        setDrawer(false);
        return true;
      }
    }
    dbg("tap → nothing hit");
    return false;
  }

  // Desktop: MapLibre's click works fine, route it through the dispatcher.
  map.on("click", (e) => {
    dbg("map click fired");
    handleMapTap(e.point, e.lngLat);
  });

  // Touch: detect a genuine tap (touchstart→touchend with little movement and
  // a single finger) directly on the canvas, since MapLibre may not emit click.
  (function wireTouchTap() {
    const canvas = map.getCanvas();
    let sx = 0, sy = 0, st = 0, moved = false, multi = false;
    canvas.addEventListener("touchstart", (ev) => {
      if (ev.touches.length > 1) { multi = true; return; }
      multi = false; moved = false;
      const t = ev.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });
    canvas.addEventListener("touchmove", (ev) => {
      if (multi) return;
      const t = ev.touches[0];
      if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) moved = true;
    }, { passive: true });
    canvas.addEventListener("touchend", (ev) => {
      if (multi || moved) return;                 // a drag/pinch, not a tap
      if (Date.now() - st > 700) return;          // a long-press, not a tap
      const rect = canvas.getBoundingClientRect();
      // Use the changedTouch position (the finger that lifted).
      const ct = ev.changedTouches && ev.changedTouches[0];
      const cx = (ct ? ct.clientX : sx) - rect.left;
      const cy = (ct ? ct.clientY : sy) - rect.top;
      const point = { x: cx, y: cy };
      let lngLat = null;
      try { lngLat = map.unproject([cx, cy]); } catch (_) {}
      dbg("touch tap detected", [Math.round(cx), Math.round(cy)]);
      // Plot-point mode: drop the point here (the click-based handler won't
      // fire on touch). Mirror the desktop behaviour.
      if (state.plotPointMode && lngLat) {
        dropPlotPoint(lngLat);
        return;
      }
      handleMapTap(point, lngLat);
    }, { passive: true });
  })();

  // (LSOA hover is handled by the central hover-card system; zone clicks by
  // the unified handleMapTap dispatcher above.)

  map.on("draw.create", onDrawChange);
  map.on("draw.update", onDrawChange);
  map.on("draw.delete", () => {
    lastDrawnPolygon = null;
    document.getElementById("report").innerHTML =
      `<p class="empty">No site selected yet.</p>`;
  });

  // (Rail-stop hover is handled by the central hover-card system; clicks by
  // the unified handleMapTap dispatcher.)

  // The context-aware hover card, LSOA boundary highlight, and the
  // right-click "Spot summary" menu.
  initHoverSystem();
  initSpotSummary();
}

// Find the station-usage feature matching a rail-stop's properties, by CRS
// first (reliable) then normalised name. Returns the GeoJSON feature or null.
function findStationForStop(stopProps) {
  const feats = (state.stationsData && state.stationsData.features) || [];
  if (!feats.length) return null;
  const crs = (stopProps.crs || stopProps.CRS || "").toUpperCase();
  if (crs) {
    const byCrs = feats.find(f => (f.properties.crs || "").toUpperCase() === crs);
    if (byCrs) return byCrs;
  }
  const norm = (s) => (s || "").toLowerCase().replace(/\(.*?\)/g, "")
    .replace(/\b(rail|railway)?\s*station\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(stopProps.name);
  if (n) {
    const byName = feats.find(f => norm(f.properties.name) === n);
    if (byName) return byName;
  }
  return null;
}

// Build a small inline SVG glyph for a transit mode. Pure SVG so it needs no
// font/icon CDN (the project can't rely on external icon fonts).
function railGlyphSVG(mode) {
  const color = railMode(mode)?.color || "#666";
  const inner = {
    rail: '<rect x="5" y="4" width="10" height="9" rx="2"/><circle cx="7.5" cy="15" r="1.5"/><circle cx="12.5" cy="15" r="1.5"/>',
    subway: '<circle cx="10" cy="10" r="7" fill="none" stroke-width="2.4"/><path d="M6 10h8" stroke-width="2.4"/>',
    light_rail: '<rect x="5" y="3" width="10" height="11" rx="3"/><path d="M6 17l2-3M14 17l-2-3" stroke-width="1.6"/>',
    tram: '<rect x="5" y="4" width="10" height="10" rx="2"/><path d="M8 2h4M7 17l1.5-3M13 17l-1.5-3" stroke-width="1.6"/>',
  }[mode] || '<circle cx="10" cy="10" r="6"/>';
  // Two render styles: filled shapes (rail/light_rail/tram) and stroked (subway)
  const strokeOnly = mode === "subway";
  return `<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true"
            fill="${strokeOnly ? "none" : color}" stroke="${color}"
            stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// Pin a rail stop's details in the floating panel (reuses #floating-detail).
function inspectStop(p, point) {
  closeDetail();   // clear any LSOA selection first
  state.selectedStop = p;
  state.selectedPoint = point;

  const mode = railMode(p.mode);
  const bits = [];
  if (p.crs) bits.push(`CRS ${p.crs}`);
  if (p.operator) bits.push(p.operator);
  else if (p.network) bits.push(p.network);

  const panel = document.getElementById("floating-detail");
  panel.innerHTML = `
    <button class="fd-close" aria-label="Close" title="Close">×</button>
    <div class="fd-stop">
      <div class="fd-stop-glyph" style="--mode-color:${mode?.color || "#666"}">
        ${railGlyphSVG(p.mode)}
      </div>
      <div class="fd-stop-text">
        <div class="fd-district">${p.name || "Unnamed stop"}</div>
        <div class="fd-stop-class">
          <span class="fd-mode-badge" style="background:${mode?.color || "#666"}">${mode?.label || p.mode}</span>
        </div>
      </div>
    </div>
    ${bits.length ? `<div class="fd-stop-meta">${bits.join(" · ")}</div>` : ""}
    <p class="hint" style="margin-top:12px">
      Transit stop from OpenStreetMap. More detail (lines served, interchange)
      can be added later.
    </p>`;
  panel.classList.add("open");
  panel.querySelector(".fd-close").addEventListener("click", closeStop);
  positionFloatingPanel(panel, point);
}

function closeStop() {
  state.selectedStop = null;
  const panel = document.getElementById("floating-detail");
  panel.classList.remove("open");
  panel.innerHTML = "";
}

// ---- Stations: inspect card + profile launch ------------------------------

// MapLibre serialises nested GeoJSON properties to JSON strings. `trend` comes
// back as a string; parse it safely to an array of {year, value}.
function parseTrend(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  return [];
}

// Percent change across the trend series (first→last), or null if <2 points.
function trendChangePct(trend) {
  if (!trend || trend.length < 2) return null;
  const first = trend[0].value, last = trend[trend.length - 1].value;
  if (!first || first <= 0) return null;
  return ((last - first) / first) * 100;
}

// A tiny inline SVG sparkline for the usage trend. Pure SVG, no library.
function sparklineSVG(trend, color) {
  if (!trend || trend.length < 2) return "";
  const vals = trend.map(t => t.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const W = 120, H = 30, pad = 2;
  const pts = trend.map((t, i) => {
    const x = pad + (i / (trend.length - 1)) * (W - 2 * pad);
    const y = H - pad - ((t.value - min) / span) * (H - 2 * pad);
    return [x, y];
  });
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" style="overflow:visible">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4" fill="${color}"/>
  </svg>`;
}

// Compact stat chips for a station: interchanges, season-ticket share (the
// commuter proxy — ORR can't classify journey purpose, so we label it as
// season share, not "commuters"), and national usage percentile. Reused by the
// floating card and the deep-dive station section.
function stationStatChips(p) {
  const chips = [];
  const intchg = (p.interchanges != null && p.interchanges !== "") ? Number(p.interchanges) : null;
  if (intchg != null) {
    chips.push(`<div class="st-chip"><div class="st-chip-num">${fmtCount(intchg)}</div><div class="st-chip-cap">Interchanges</div></div>`);
  }
  const season = (p.season_share != null && p.season_share !== "") ? Number(p.season_share) : null;
  if (season != null) {
    chips.push(`<div class="st-chip"><div class="st-chip-num">${Math.round(season * 100)}%</div><div class="st-chip-cap">Season tickets</div></div>`);
  }
  const pct = (p.usage_pctile != null && p.usage_pctile !== "") ? Number(p.usage_pctile) : null;
  if (pct != null) {
    chips.push(`<div class="st-chip"><div class="st-chip-num">${Math.round(pct)}<span class="st-chip-sup">th</span></div><div class="st-chip-cap">Usage percentile</div></div>`);
  }
  if (!chips.length) return "";
  return `<div class="st-chips">${chips.join("")}</div>`;
}

// A small caveat line when the station's latest estimate was methodology-
// adjusted or flagged for quality — keeps the figures honest for scrutiny.
function stationQualityNote(p, year) {
  if (!p.adjusted && !p.quality) return "";
  const bits = [];
  if (p.adjusted) bits.push("estimate adjusted / supplemented with local data");
  if (p.quality) bits.push(p.quality);
  return `<p class="hint st-quality" style="margin-top:6px">⚠ ${bits.join(" · ")}</p>`;
}

// Pin a station's details in the floating panel (reuses #floating-detail),
// with usage, operator and a trend sparkline, plus a button that builds the
// station's walk-time catchment and runs the deep dive on it.
function inspectStation(p, point) {
  closeDetail();
  closeStop();
  // Diagnostic: log which rich (1410) fields are present, so it's easy to
  // verify in DevTools whether the deployed stations.geojson was built from
  // Table 1410 (rich) or 1415 (trend only). If interchanges/season_share are
  // null for every station, the data needs rebuilding from the 1410 file.
  console.info("[station]", p.name, {
    usage: p.usage, interchanges: p.interchanges, season_share: p.season_share,
    usage_pctile: p.usage_pctile, region: p.region, adjusted: p.adjusted,
  });
  state.selectedStation = p;
  state.selectedPoint = point;
  if (map.getLayer("station-selected")) {
    map.setFilter("station-selected", ["==", "crs", p.crs || "___none___"]);
  }

  const usage = (p.usage != null && p.usage !== "") ? Number(p.usage) : null;
  const trend = parseTrend(p.trend);
  const changePct = trendChangePct(trend);
  const year = state.stationsMeta?.latest_year || "";

  const meta = [];
  if (p.crs) meta.push(`CRS ${p.crs}`);
  if (p.operator) meta.push(p.operator);
  if (p.region) meta.push(p.region);

  // Compact stat chips: interchanges, season-ticket share (commuter proxy),
  // and national usage percentile. Each only shows when present.
  const statsBlock = stationStatChips(p);
  const qualityNote = stationQualityNote(p, year);

  let trendBlock = "";
  if (trend.length >= 2) {
    const arrow = changePct == null ? "" : changePct > 1 ? "▲" : changePct < -1 ? "▼" : "▬";
    const cls = changePct == null ? "" : changePct > 1 ? "up" : changePct < -1 ? "down" : "flat";
    const pctTxt = changePct == null ? "" :
      `<span class="st-trend-pct ${cls}">${arrow} ${Math.abs(changePct).toFixed(0)}%</span>`;
    trendBlock = `
      <div class="st-trend">
        <div class="st-spark">${sparklineSVG(trend, STATION_COLOR)}</div>
        <div class="st-trend-meta">
          ${pctTxt}
          <span class="dim">${trend[0].year}–${trend[trend.length - 1].year}</span>
        </div>
      </div>`;
  }

  const panel = document.getElementById("floating-detail");
  panel.innerHTML = `
    <button class="fd-close" aria-label="Close" title="Close">×</button>
    <div class="fd-stop">
      <div class="fd-stop-glyph" style="--mode-color:${STATION_COLOR}">
        ${railGlyphSVG("rail")}
      </div>
      <div class="fd-stop-text">
        <div class="fd-district">${p.name || "Station"}</div>
        <div class="fd-stop-class">
          <span class="fd-mode-badge" style="background:${STATION_COLOR}">Heavy rail</span>
        </div>
      </div>
    </div>
    ${meta.length ? `<div class="fd-stop-meta">${meta.join(" · ")}</div>` : ""}
    <div class="report-headline" style="margin-top:10px">
      <div class="big">${usage == null ? "—" : fmtCount(usage)}<span style="font-size:13px"> entries/exits</span></div>
      <div class="cap">Annual passenger usage${year ? ` · ${year}` : ""}</div>
    </div>
    ${trendBlock}
    ${statsBlock}
    ${qualityNote}
    <button class="deepdive-btn" id="station-profile-btn" type="button">
      Profile this station →
    </button>
    <p class="hint" style="margin-top:8px">
      Builds a walk-time catchment around the station and analyses its
      deprivation, population and amenities.
    </p>`;
  panel.classList.add("open");
  panel.querySelector(".fd-close").addEventListener("click", closeStation);
  const btn = panel.querySelector("#station-profile-btn");
  if (btn) btn.addEventListener("click", () => profileStation(p, point));
  positionFloatingPanel(panel, point);
}

function closeStation() {
  state.selectedStation = null;
  if (map.getLayer("station-selected")) {
    map.setFilter("station-selected", ["==", "crs", "___none___"]);
  }
  const panel = document.getElementById("floating-detail");
  panel.classList.remove("open");
  panel.innerHTML = "";
}

// Build the station's walk-time catchment (isochrone) and run the shared deep
// dive on it, passing station-specific meta so the panel shows usage etc.
async function profileStation(p, point) {
  const station = state.selectedStation || p;
  if (!station) return;
  // Find the station's coordinates from the loaded GeoJSON (props from a tile
  // click don't carry geometry).
  let coords = null;
  const feats = (state.stationsData && state.stationsData.features) || [];
  const hit = feats.find(f => (f.properties.crs && f.properties.crs === station.crs) ||
    f.properties.name === station.name);
  if (hit) coords = hit.geometry.coordinates;
  if (!coords) { alert("Couldn't locate that station's coordinates."); return; }

  const minutes = STATION_WALK_MINUTES;
  setStationProfileBtn("Building catchment…", true);
  let catchment;
  try {
    catchment = await fetchIsochrone(coords[0], coords[1], "pedestrian", minutes);
  } catch (e) {
    setStationProfileBtn("Profile this station →", false);
    alert(`Couldn't build the station catchment — ${e.message}. Please try again in a few seconds.`);
    return;
  }
  if (!catchment) {
    setStationProfileBtn("Profile this station →", false);
    alert("No catchment returned for that station.");
    return;
  }
  const circle = !!(catchment.properties && (catchment.properties._circle || catchment.properties._approx));

  // Remember the origin so "nearest access" routes from the station itself.
  plot.geometry = { type: "Point", coordinates: coords };
  plot.mode = "pedestrian";
  plot.minutes = minutes;

  const usage = (station.usage != null && station.usage !== "") ? Number(station.usage) : null;
  const trend = parseTrend(station.trend);
  // NPPF "well-connected station" fields live on the full GeoJSON feature; a
  // tile/search click may not carry them, so prefer the matched feature's props.
  const sp = (hit && hit.properties) || station || {};
  const { domains, parts } = areaWeightedScore(catchment);
  closeStation();
  runDeepDive(catchment, {
    eyebrow: "Station profile",
    title: station.name || "Station",
    subtitle: `${minutes}-min ${circle ? "circular" : "walk"} catchment${parts ? ` · ${parts} LSOA${parts === 1 ? "" : "s"}` : ""}`,
    domains,
    scoreCaption: "Catchment deprivation · weighted",
    // Station centre [lng,lat] for the developable-land RPC (independent of the
    // walk-time catchment).
    stationCentre: coords,
    station: {
      // NPPF well-connected-station test (top-60 TTWA by GVA AND meets frequency).
      well_connected: sp.well_connected === true || sp.well_connected === "true",
      meets_frequency: sp.meets_frequency === true || sp.meets_frequency === "true" || Number(sp.meets_frequency) === 1,
      ttwa_name: sp.ttwa_name || null,
      ttwa_gva_rank: sp.ttwa_gva_rank != null && sp.ttwa_gva_rank !== "" ? Number(sp.ttwa_gva_rank) : null,
      // ONS Rural-Urban Classification of the station's LSOA (build_station_ruc.py).
      // Drives the DEFAULT developable density regime (rural/suburban/urban).
      rural_urban: sp.rural_urban || station.rural_urban || null,
      ruc_name: sp.ruc_name || station.ruc_name || null,
      name: station.name, crs: station.crs, operator: station.operator,
      usage, trend, year: state.stationsMeta?.latest_year || "",
      interchanges: station.interchanges != null && station.interchanges !== "" ? Number(station.interchanges) : null,
      season_share: station.season_share != null && station.season_share !== "" ? Number(station.season_share) : null,
      usage_pctile: station.usage_pctile != null && station.usage_pctile !== "" ? Number(station.usage_pctile) : null,
      region: station.region || null,
      quality: station.quality || null,
      adjusted: station.adjusted === true || station.adjusted === "true",
      // Connectivity (GTFS-derived) — carried through so buildStationSnapshot
      // can populate the Connectivity block. Coerce numeric fields from tile
      // strings; key_cities may be an array or a "|"-joined string.
      trains_per_day: station.trains_per_day != null && station.trains_per_day !== "" ? Number(station.trains_per_day) : null,
      peak_trains: station.peak_trains != null && station.peak_trains !== "" ? Number(station.peak_trains) : null,
      peak_hour_count: station.peak_hour_count != null && station.peak_hour_count !== "" ? Number(station.peak_hour_count) : null,
      peak_hour_start: station.peak_hour_start || null,
      first_dep: station.first_dep || null,
      last_dep: station.last_dep || null,
      direct_destinations: station.direct_destinations != null && station.direct_destinations !== "" ? Number(station.direct_destinations) : null,
      key_cities_count: station.key_cities_count != null && station.key_cities_count !== "" ? Number(station.key_cities_count) : null,
      key_cities: Array.isArray(station.key_cities) ? station.key_cities : (station.key_cities ? String(station.key_cities).split("|") : []),
      connectivity_pctile: station.connectivity_pctile != null && station.connectivity_pctile !== "" ? Number(station.connectivity_pctile) : null,
    },
  });
}

function setStationProfileBtn(text, disabled) {
  const btn = document.getElementById("station-profile-btn");
  if (btn) { btn.textContent = text; btn.disabled = !!disabled; }
}

// Default walk-time (minutes) for a station catchment. At ~80 m/min this makes
// the circular catchment 800 m — matching the 800 m NPPF developable-land radius
// (the red circle), so the two rings line up by default. (10-min ped-shed.)
// Exposed as a constant so it's easy to lift into a control later.
const STATION_WALK_MINUTES = 10;

// ---- Legend ---------------------------------------------------------------

function buildLegend() {
  const el = document.getElementById("legend");
  let header = "";

  // Deprivation section (combined score or a soloed single domain).
  if (state.imdOn || !state.priceOn) {
    const ramp = RAMP();
    const swatches = ramp.map(c => `<span style="background:${c}"></span>`).join("");
    const breaks = currentBreaks();
    const lo = breaks.length ? breaks[0].toFixed(0) : "0";
    const hi = breaks.length ? breaks[breaks.length - 1].toFixed(0) : "100";
    const soloName = state.solo
      ? DOMAINS.find(d => d.key === state.solo).name
      : null;
    const title = soloName ? `${soloName} only` : "Combined score";
    const note = soloName ? `Single domain · fixed classes`
                          : `Fixed classes · breaks ${lo}–${hi}`;
    header += `
      <div class="title">${title}</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>less deprived</span><span>more deprived</span></div>
      <div class="legend-note">${note}</div>`;
  }

  // House-price section — its own independent layer, so its own legend block
  // whenever it's showing (possibly alongside the deprivation one).
  if (state.priceOn) {
    const swatches = PRICE_RAMP.map(c => `<span style="background:${c}"></span>`).join("");
    const ppm2 = state.breaksData?.price_ppm2_band;
    const sale = state.breaksData?.price_band;
    const note = ppm2
      ? `HM Land Registry £/m² · typical ${ppm2Fmt(ppm2[0])}–${ppm2Fmt(ppm2[1])}`
        + (sale ? ` · sale ${priceFmt(sale[0])}–${priceFmt(sale[1])}` : "")
      : `HM Land Registry £/m²`;
    header += `
      <div class="title">House price (£/m²)</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>lower value</span><span>higher value</span></div>
      <div class="legend-note">${note}</div>`;
  }

  // Controls: colour mode + light/dark theme. (Per-layer transparency moved
  // to the Data layers panel, so the old "Map fade" slider is gone.)
  const controls = `
    <div class="legend-controls">
      <div class="lc-row">
        <span class="lc-label">Colour</span>
        <div class="seg-mini">
          <button class="${state.colourMode === "single" ? "on" : ""}" data-cmode="single">Single</button>
          <button class="${state.colourMode === "spectrum" ? "on" : ""}" data-cmode="spectrum">Spectrum</button>
        </div>
      </div>
      <div class="lc-row">
        <span class="lc-label">Theme</span>
        <div class="seg-mini">
          <button class="${state.theme === "dark" ? "on" : ""}" data-theme="dark">Dark</button>
          <button class="${state.theme === "light" ? "on" : ""}" data-theme="light">Light</button>
        </div>
      </div>
    </div>`;

  el.innerHTML = header + controls;

  el.querySelectorAll("[data-cmode]").forEach(b =>
    b.addEventListener("click", () => setColourMode(b.dataset.cmode)));
  el.querySelectorAll("[data-theme]").forEach(b =>
    b.addEventListener("click", () => setTheme(b.dataset.theme)));
}

function setColourMode(mode) {
  state.colourMode = mode;
  applyFillColor();
  buildLegend();
  if (state.selectedCode) inspectLSOA(state.selectedCode);
  if (lastDrawnPolygon) buildReport(lastDrawnPolygon);
}

function setTheme(theme) {
  state.theme = theme;
  document.body.classList.toggle("light", theme === "light");
  // Swap the basemap tiles to match the theme.
  const url = theme === "light"
    ? "https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}@2x.png"
    : "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png";
  if (map.getSource("carto")) map.getSource("carto").setTiles([url]);
  const lblUrl = theme === "light"
    ? "https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}@2x.png"
    : "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png";
  if (map.getSource("carto-labels")) map.getSource("carto-labels").setTiles([lblUrl]);
  // Boundary + selection lines are tuned per theme so areas stay cohesive.
  for (const id of ["lsoa-line", "simd-line"])
    if (map.getLayer(id)) map.setPaintProperty(id, "line-color", LINE_COLOR());
  if (map.getLayer("lsoa-selected")) map.setPaintProperty("lsoa-selected", "line-color", SELECT_COLOR());
  // Rail line/stop fill colours are per-mode (theme-independent); only the
  // stop outline and labels need to flip for contrast against the basemap.
  if (map.getLayer("rail-stop"))
    map.setPaintProperty("rail-stop", "circle-stroke-color", RAIL_STOP_STROKE());
  if (map.getLayer("rail-stop-label")) {
    map.setPaintProperty("rail-stop-label", "text-color", RAIL_LABEL_COLOR());
    map.setPaintProperty("rail-stop-label", "text-halo-color", RAIL_LABEL_HALO());
  }
  buildLegend();
}

function priceFmt(v) {
  if (v == null) return "—";
  if (v >= 1e6) return "£" + (v / 1e6).toFixed(1) + "m";
  return "£" + Math.round(v / 1000) + "k";
}

// £ per square metre, the value metric the house-price choropleth is ranked by.
function ppm2Fmt(v) {
  if (v == null) return "—";
  return "£" + Math.round(v).toLocaleString() + "/m²";
}

// ---- Deep dive ------------------------------------------------------------
// A focused look at one sub-area. Two ways to define the catchment (only the
// first is wired now; the circular/isochrone plot mode comes next):
//   1. Click a zone -> the LSOA polygon IS the catchment.
//   2. (later) draw/upload a plot -> circular buffer, then isochrone.
// Once we have a catchment polygon, the flow is identical: query each amenity
// dataset for what's inside it, draw those points, and summarise. The data
// lives in Supabase (PostGIS); the IMD choropleth stays on the tile path.

// The amenity datasets we can show in a deep dive. Start with GPs; pharmacies,
// schools, bus stops, etc. slot in here as each loader lands. `kind` matches
// the `amenities.kind` column in Supabase.
// Amenity layers shown in a deep dive. Most come from Supabase (loaded via the
// dashboard CSV import); supermarkets are fetched live from OpenStreetMap
// (source:"osm") so they need no storage, like crime. `color` sets the map dot
// and the legend swatch.
const AMENITY_KINDS = [
  { kind: "gp",          label: "GP surgeries",   color: "#2563eb", source: "supabase", icon: "gp" },
  { kind: "pharmacy",    label: "Pharmacies",     color: "#0ea5a4", source: "supabase", icon: "pharmacy" },
  { kind: "school",      label: "Schools",        color: "#7c3aed", source: "supabase", icon: "school" },
  { kind: "nursery",     label: "Nurseries",      color: "#db2777", source: "supabase", icon: "nursery" },
  { kind: "bus_stop",    label: "Bus stops",      color: "#f59e0b", source: "supabase", icon: "bus" },
  { kind: "supermarket", label: "Food stores",    color: "#16a34a", source: "osm",      icon: "food" },
];

// Lazily-created Supabase client. Null when no config is present (the map still
// works for IMD + rail; only deep-dive amenity layers are unavailable).
let supa = null;
let supaTried = false;
function getSupabase() {
  if (supaTried) return supa;
  supaTried = true;
  const cfg = window.MASTERMAPPER_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase?.createClient) {
    supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }
  return supa;
}

const deep = {
  active: false,
  catchment: null,       // GeoJSON Polygon (the area of interest)
  prevView: null,        // {center, zoom} to restore on exit
  enabledKinds: new Set(),  // which amenity layers are toggled on
  cache: {},             // kind -> array of features {lng,lat,name,props}
  crimeView: "points",   // "points" | "heat"
  crimeVisible: true,    // whether crime layers are shown
  crimeData: null,       // cached 12-month crime array
  population: null,      // estimated resident population of the catchment
  households: null,      // estimated existing households (≈ occupied dwellings)
  area_km2: null,        // catchment area in km²
  popPartial: false,    // true if some overlapping LSOAs lacked population
  counts: {},           // kind -> latest count in catchment (for density)
  station: null,        // station meta when this is a station profile
  brownfield: null,     // cached brownfield sites in catchment (array)
  brownfieldVisible: false, // layer toggle
  brownfieldFilters: { minDwellings: 0, publicOnly: false, deliverableOnly: false },
  brownfieldSummary: null,  // { n_sites, n_public, dwellings_*_total, hectares_total }
  // Developable-land + dwelling-capacity analysis (station profiles only).
  stationCentre: null,      // [lng,lat] of the profiled station (RPC centre)
  developable: null,        // adjustable criteria { radius_m, inner_radius_m, subtract:{} }
  developableResult: null,  // RPC row { developable_geojson, blockers_geojson, *_ha }
  developableVisible: false,// layer + analysis toggle
  developableRegime: "auto",// "auto" | "rural" | "suburban" | "urban" (override)
  developableDensity: null, // people/km² over the radius circle (auto-classify)
  developableDph: null,     // editable dwellings-per-hectare per regime
  publicLand: null,         // RPC row { parcels_geojson, total_ha, inner_ha, ... }
  publicLandVisible: false, // public-parcel layer toggle
  _plots: null,             // per-plot features for click-to-analyse
  _innerCircle: null,       // cached inner-ring circle (turf polygon)
  // Land assembler: multi-select of developable plots. ids are INDICES into
  // _plots (ephemeral — cleared whenever the plots are recomputed).
  assembly: { active: false, ids: new Set(), name: "" },
};

// ---- Workstream 3: shortlist, triad, synthesis, comparison, export --------
// Session-only shortlist of station profiles the user has pinned. Each entry is
// a self-contained SNAPSHOT (the numbers at pin time), so comparison/export
// don't depend on re-querying. Keyed by CRS (falls back to name).
const shortlist = {
  items: [],            // array of snapshot objects (see buildStationSnapshot)
  has(key) { return this.items.some(i => i.key === key); },
  add(snap) { if (!this.has(snap.key)) { this.items.push(snap); return true; } return false; },
  remove(key) { this.items = this.items.filter(i => i.key !== key); },
  get(key) { return this.items.find(i => i.key === key) || null; },
};

// Occupancy assumption for modelled population uplift: homes × people/home.
// 2.3 is close to the England average household size; exposed so it's tunable.
const PEOPLE_PER_HOME = 2.3;

// Self-contained print stylesheet for the export report. Deliberately a clean,
// editorial document look — serif headings, generous whitespace, one station
// per page. No external fonts so it renders identically offline / in PDF.
const REPORT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f3ef; color: #1a2230;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .report { max-width: 880px; margin: 0 auto; }
  h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; color: #14304a; }
  .cover { background: linear-gradient(160deg,#14304a,#1f4763); color: #fff; padding: 64px 56px 48px; }
  .cover-mark { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.7; }
  .cover h1 { color: #fff; font-size: 40px; margin: 14px 0 6px; line-height: 1.1; }
  .cover-sub { font-size: 16px; opacity: 0.9; margin: 0 0 4px; }
  .cover-date { font-size: 13px; opacity: 0.7; margin: 0 0 24px; }
  .cover-legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; margin-bottom: 22px; }
  .cover-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 8px; vertical-align: middle; }
  .cover-note { font-size: 12.5px; line-height: 1.55; opacity: 0.85; max-width: 640px; }
  .summary { padding: 40px 56px; }
  .summary h2 { font-size: 22px; margin: 0 0 16px; }
  .r-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .r-table th { text-align: left; border-bottom: 2px solid #14304a; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #5d6b80; }
  .r-table td { padding: 10px; border-bottom: 1px solid #e2e0d8; vertical-align: top; }
  .r-rank { font-family: Georgia, serif; font-size: 18px; color: #b5613a; width: 28px; }
  .r-name strong { display: block; }
  .r-name span { font-size: 11px; color: #5d6b80; }
  .r-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .r-num small { display: block; font-size: 10px; color: #8a93a3; }
  .r-foot { font-size: 11px; color: #8a93a3; margin-top: 12px; }
  .profile { padding: 48px 56px; border-top: 1px solid #e2e0d8; page-break-before: always; break-before: page; }
  .p-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 22px; }
  .p-rank { font-family: Georgia, serif; font-size: 30px; color: #fff; background: #b5613a; width: 48px; height: 48px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .p-head h2 { font-size: 26px; margin: 0; }
  .p-meta { font-size: 12.5px; color: #5d6b80; margin: 4px 0 0; }
  .p-triad { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; margin-bottom: 22px; }
  .p-triad-cell { background: #fff; border: 1px solid #e2e0d8; border-radius: 10px; padding: 14px 16px; }
  .p-triad-label { font-size: 10px; letter-spacing: 0.1em; color: #8a93a3; }
  .p-triad-val { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; margin: 2px 0; }
  .p-triad-sub { font-size: 11px; color: #5d6b80; margin-bottom: 8px; }
  .p-triad-bar { height: 6px; background: #eceae3; border-radius: 3px; overflow: hidden; }
  .p-triad-bar i { display: block; height: 100%; }
  .p-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-bottom: 22px; }
  .p-stat { background: #faf9f6; border: 1px solid #e9e7df; border-radius: 8px; padding: 12px; text-align: center; }
  .p-stat-v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; color: #14304a; }
  .p-stat-l { font-size: 10.5px; color: #5d6b80; margin-top: 3px; }
  .p-domains h3 { font-size: 14px; margin: 0 0 10px; }
  .p-domain { display: grid; grid-template-columns: 140px 1fr 32px; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 12px; }
  .p-domain-l { color: #3a4658; }
  .p-domain-bar { height: 7px; background: #eceae3; border-radius: 4px; overflow: hidden; }
  .p-domain-bar i { display: block; height: 100%; background: #d9772f; }
  .p-domain-v { text-align: right; font-variant-numeric: tabular-nums; color: #5d6b80; }
  .p-synth { font-size: 13px; line-height: 1.6; color: #2a3645; background: #f0ede5; border-left: 3px solid #b5613a; padding: 12px 16px; margin-top: 22px; border-radius: 0 6px 6px 0; }
  .p-conn { font-size: 12px; line-height: 1.55; color: #3a4658; margin-top: 14px; }
  .report-footer { padding: 28px 56px 56px; font-size: 10.5px; color: #8a93a3; line-height: 1.5; }
  @media print { .cover { padding-top: 48px; } .profile { padding-top: 36px; } body { background: #fff; } }
`;


// Capture everything the triad / synthesis / comparison / export need from the
// CURRENTLY-OPEN station deep dive, as a flat snapshot. Pulls from `deep`
// (live), so call it while a station profile is open.
function buildStationSnapshot() {
  const st = deep.station;
  if (!st) return null;
  const key = (st.crs && st.crs.toUpperCase()) || st.name || "station";

  // NEED: live combined deprivation score (0-100, higher = more deprived).
  // Same fallback chain as renderDeprivationScore: when the LSOA tiles for the
  // catchment aren't loaded (deep.domains null), fall back to the precomputed
  // catchment IMD percentile from station_assessments — otherwise the Official
  // supply triad showed "—" while the Need block right below showed a score.
  let need = combinedScoreFromDomains(deep.domains, state.weights);
  const dbImd = deep.assessment && deep.assessment.catchment_imd;
  if ((need == null || isNaN(need)) && dbImd != null) need = Number(dbImd);

  // SUPPLY: brownfield capacity in the catchment (max-dwellings total).
  const bf = deep.brownfieldSummary;
  const supplyHomes = bf ? (Number(bf.dwellings_max_total) || 0) : null;
  const supplySites = bf ? (Number(bf.n_sites) || 0) : null;
  const supplyPublic = bf ? (Number(bf.n_public) || 0) : null;

  // USAGE: annual entries/exits + its national percentile.
  const usage = st.usage != null ? Number(st.usage) : null;
  const usagePctile = st.usage_pctile != null ? Number(st.usage_pctile) : null;

  // Modelled population uplift from the developable supply.
  const upliftPeople = supplyHomes != null ? Math.round(supplyHomes * PEOPLE_PER_HOME) : null;

  return {
    key,
    name: st.name || "Station",
    crs: st.crs || "",
    operator: st.operator || "",
    region: st.region || "",
    year: st.year || "",
    walkMinutes: STATION_WALK_MINUTES,
    // Triad raw values
    need, usage, usagePctile,
    supplyHomes, supplySites, supplyPublic,
    // Context
    population: deep.population,
    households: deep.households,            // existing homes baseline
    area_km2: deep.area_km2,
    interchanges: st.interchanges ?? null,
    season_share: st.season_share ?? null,
    // Connectivity (GTFS-derived). Null-safe; band derived in connectivityBand().
    trainsPerDay: st.trains_per_day ?? null,
    peakTrains: st.peak_trains ?? null,
    peakHourCount: st.peak_hour_count ?? null,
    peakHourStart: st.peak_hour_start ?? null,
    firstDep: st.first_dep ?? null,
    lastDep: st.last_dep ?? null,
    directDestinations: st.direct_destinations ?? null,
    keyCitiesCount: st.key_cities_count ?? null,
    keyCities: Array.isArray(st.key_cities) ? st.key_cities : (st.key_cities ? String(st.key_cities).split("|") : []),
    connectivityPctile: st.connectivity_pctile ?? null,
    usagePerResident: (usage != null && deep.population) ? usage / deep.population : null,
    upliftPeople,
    upliftPct: (upliftPeople != null && deep.population) ? (upliftPeople / deep.population) * 100 : null,
    // Brownfield capacity as a % uplift on EXISTING homes — a stronger
    // regeneration framing than population alone.
    homesUpliftPct: (supplyHomes != null && deep.households) ? (supplyHomes / deep.households) * 100 : null,
    domains: deep.domains ? { ...deep.domains } : null,
    capturedAt: new Date().toISOString(),
  };
}

// Normalise each triad signal to 0-100 so the three bars are visually
// comparable. NEED is already 0-100. USAGE uses its national percentile.
// SUPPLY is scaled against a reference capacity (so a 0-500+ home site reads
// near the top); this is presentation-only and clearly a relative indicator.
const SUPPLY_REF_HOMES = 500;
function triadBars(snap) {
  const needPct = snap.need == null ? null : clamp01(snap.need / 100) * 100;
  const usagePct = snap.usagePctile == null
    ? (snap.usage == null ? null : null)
    : snap.usagePctile;
  const supplyPct = snap.supplyHomes == null ? null
    : clamp01(snap.supplyHomes / SUPPLY_REF_HOMES) * 100;
  return { needPct, usagePct, supplyPct };
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Connectivity band — a transparent good/moderate/limited read, used for
// FILTERING and FRAMING only (never folded into the opportunity score, since
// the response to poor connectivity is "invest in the railway", not
// "deprioritise the site"). Based on the national trains-per-day percentile,
// nudged up when there's a direct link to a major city. Returns null if we have
// no connectivity data for the station.
function connectivityBand(snap) {
  const pct = snap.connectivityPctile;
  const tpd = snap.trainsPerDay;
  if (pct == null && tpd == null) return null;
  // Primary signal: national percentile of service frequency.
  let level = "limited";
  if (pct != null) {
    if (pct >= 66) level = "good";
    else if (pct >= 33) level = "moderate";
  } else {
    // No percentile (e.g. partial data) — fall back to absolute trains/day.
    if (tpd >= 100) level = "good";
    else if (tpd >= 40) level = "moderate";
  }
  // A direct major-city link lifts a "limited" to "moderate" — a one-seat ride
  // to a city is materially better connectivity than frequency alone implies.
  if (level === "limited" && (snap.keyCitiesCount || 0) >= 1) level = "moderate";
  const label = level === "good" ? "Well connected"
    : level === "moderate" ? "Moderately connected" : "Limited connectivity";
  return { level, label };
}

// The Connectivity block for the station synthesis: a band chip + a worded
// summary + a compact stat strip. Connectivity is shown as its OWN read,
// alongside need/supply/usage — deliberately not blended into the score.
function connectivityHTML(snap) {
  const band = connectivityBand(snap);
  if (!band) return "";   // no connectivity data — hide the block entirely
  const tpd = snap.trainsPerDay;
  const dd = snap.directDestinations;
  const cities = (snap.keyCities || []).filter(Boolean);

  // Worded summary that strengthens or tempers the growth story.
  let words;
  if (band.level === "good") {
    words = `Growth here is well supported by existing service`;
  } else if (band.level === "moderate") {
    words = `Reasonable service; larger growth may need timetable investment`;
  } else {
    words = `Limited service — significant growth would likely need investment`;
  }
  const cityLine = cities.length
    ? `Direct trains to ${cities.slice(0, 4).join(", ")}${cities.length > 4 ? "…" : ""}.`
    : (dd != null ? `${dd} direct destination${dd === 1 ? "" : "s"}, no major city by one-seat ride.` : "");

  const chip = (label, value) => value == null || value === "" ? "" :
    `<div class="conn-stat"><div class="conn-stat-v">${value}</div><div class="conn-stat-l">${label}</div></div>`;
  const span = (snap.firstDep && snap.lastDep) ? `${snap.firstDep}–${snap.lastDep}` : null;

  return `
    <div class="conn-block">
      <div class="conn-head">
        <span class="conn-band conn-${band.level}">${band.label}</span>
        <span class="conn-words">${words}.</span>
      </div>
      <div class="conn-strip">
        ${chip("trains/day", tpd != null ? tpd.toLocaleString() : null)}
        ${chip("in AM peak", snap.peakTrains != null ? snap.peakTrains : null)}
        ${chip("busiest hour", snap.peakHourCount != null ? (snap.peakHourStart ? `${snap.peakHourCount} (from ${snap.peakHourStart})` : snap.peakHourCount) : null)}
        ${chip("direct dests", dd != null ? dd : null)}
        ${chip("service span", span)}
      </div>
      ${cityLine ? `<p class="conn-cities">${cityLine}</p>` : ""}
      <p class="conn-note">Scheduled weekday service (GTFS timetable). Connectivity is reported separately and does not change the opportunity score.</p>
    </div>`;
}


async function enterDeepDive(p) {
  // LSOA deep dive: the catchment IS the clicked zone's polygon.
  const code = p.lsoa_code;
  const feats = map.querySourceFeatures("lsoa", {
    sourceLayer: SOURCE_LAYER,
    filter: ["==", "lsoa_code", code],
  });
  if (!feats.length) {
    alert("Couldn't read this area's boundary — try zooming in slightly and clicking again.");
    return;
  }
  let merged = feats[0];
  try {
    if (feats.length > 1 && window.turf) {
      merged = turf.union(turf.featureCollection(feats)) || feats[0];
    }
  } catch (_) { merged = feats[0]; }
  const geom = merged.geometry || merged;
  const catchment = { type: "Feature", properties: {}, geometry: geom };

  // Per-domain normalised values for the breakdown + live re-weighting.
  const domains = {};
  for (const d of DOMAINS) domains[d.key] = p[`${d.key}_norm`];
  domains.overall = p.overall_norm;

  runDeepDive(catchment, {
    eyebrow: "Deep dive",
    title: p.lad_name || "Selected area",
    subtitle: p.lsoa_name ? `${p.lsoa_name} · ${p.lsoa_code}` : p.lsoa_code,
    domains,
    scoreCaption: "Combined deprivation · weighted",
  });
}

// The shared engine: run a deep dive on ANY catchment polygon (an LSOA, or an
// isochrone, or a drawn plot's buffer). `meta` carries what the panel header
// and score block should show.
function runDeepDive(catchment, meta) {
  // Clear anything left from a previous deep dive (amenity icons, route lines,
  // popups, mask) before starting a fresh one.
  clearDeepDiveMapArtifacts();
  deep.catchment = catchment;
  deep.domains = meta.domains || null;   // per-domain averages for live scoring
  deep.active = true;
  deep.prevView = { center: map.getCenter(), zoom: map.getZoom() };
  deep.enabledKinds = new Set();
  deep.cache = {};
  deep.crimeView = "points";
  deep.crimeVisible = true;
  deep.crimeData = null;
  deep.population = null;
  deep.households = null;
  deep.area_km2 = null;
  deep.popPartial = false;
  deep.popFromDb = false;
  deep.ppm2FromDb = false;
  deep.assessment = null;
  deep.counts = {};
  deep.station = meta.station || null;   // station meta for the station section
  deep.brownfield = null;
  deep.brownfieldSummary = null;
  deep.brownfieldVisible = false;
  deep.brownfieldFilters = { minDwellings: 0, publicOnly: false, deliverableOnly: false };
  // Developable-land analysis — reset per dive; centre carried in from station meta.
  deep.stationCentre = meta.stationCentre || null;
  // ONS RUC-derived regime for this station (preferred over density bands).
  deep.stationRuralUrban = (meta.station && meta.station.rural_urban) || null;
  deep.stationRucName = (meta.station && meta.station.ruc_name) || null;
  deep.developable = defaultDevelopableConfig();
  deep.developableResult = null;
  deep.developableVisible = false;
  deep.developableRegime = "auto";
  deep.developableDensity = null;
  deep.developableDph = { ...DPH_DEFAULTS };
  deep.publicLand = null;
  deep.publicLandVisible = false;
  deep._plots = null;
  deep._innerCircle = null;
  delete deep._marketCtx;   // per-dive: next dive fetches its own locality
  removePublicLandLayer();
  renderDeepDiveLegend();

  // The mask dims everything outside the catchment, so we keep the choropleth
  // reasonably visible (it shows through inside the catchment) rather than
  // dimming it everywhere.
  if (state.imdOn) for (const id of ["lsoa-fill", "simd-fill"])
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", 0.6);
  closeDetail();
  const bbox = turf.bbox(deep.catchment);
  const rightPad = window.innerWidth <= 720 ? 40 : 420;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
    { padding: { top: 60, bottom: 60, left: 60, right: rightPad }, duration: 600 });

  setCatchmentOutline(deep.catchment);
  buildDeepDivePanel(meta);

  // Estimate the catchment's resident population + area, then fill the stat row.
  computeCatchmentPopulation();

  // Amenities are now OFF by default in a deep dive — the user enables them
  // per-layer from the Amenities block (keeps the catchment view clean and
  // funnel-focused). We still compute the nearest-access distance stats so the
  // access panel populates without turning the dots on.
  computeNearestDistances();

  // For a STATION profile, fetch the brownfield SUPPLY summary automatically
  // (lightweight — counts only, not all sites) so the need/supply/usage triad
  // and headline synthesis can populate without the user toggling the layer.
  if (meta.station) {
    autoLoadStationSupply();
  }
}

// Fetch the brownfield summary for the current catchment (counts only) and
// render the station synthesis (headline + triad). Used for station profiles.
async function autoLoadStationSupply() {
  try {
    const sb = getSupabase();
    if (sb) {
      const f = deep.brownfieldFilters;
      const { data } = await sb.rpc("brownfield_summary_in_polygon", {
        catchment: deep.catchment.geometry,
        min_dwellings: f.minDwellings > 0 ? f.minDwellings : null,
        public_only: !!f.publicOnly,
        deliverable_only: !!f.deliverableOnly,
      });
      deep.brownfieldSummary = (data && data[0]) || deep.brownfieldSummary;
    }
  } catch (e) {
    console.warn("[synthesis] supply summary failed:", e.message);
  }
  renderStationSynthesis();
}

// Compute the catchment's area, estimated resident population and density, store
// them on `deep`, and render the catchment stat row. Also refreshes amenity
// density figures (which depend on population). Safe to call once per deep dive.
function computeCatchmentPopulation() {
  const res = areaWeightedPopulation(deep.catchment);
  deep.population = res.population;
  deep.households = res.households;
  deep.area_km2 = res.area_km2;
  deep.popPartial = res.partial;
  // The precomputed catchment £/m² from station_assessments (loaded async) is
  // authoritative — it is THE number the sift priced this station with, so the
  // dive must quote it too. The client-side area-weighted figure only fills in
  // when no assessment value exists (non-station dives, missing price data):
  // it depends on which LSOA price zones happen to be streamed into the
  // viewport, and silently null here meant the appraisal fell back to the
  // national £350/ft² while the sift used the real local value.
  if (!deep.ppm2FromDb) {
    deep.ppm2 = res.ppm2;
    deep.medianPrice = res.medianPrice;
  }
  renderCatchmentStats();
  // Any amenity counts already loaded now get a per-1,000 figure.
  refreshAmenityDensities();
  // Station "usage per resident" needs the catchment population.
  renderUsagePerResident();
}

// Compact number formatting for stat cells: 1,234 / 12.3k / 1.2M.
function fmtCount(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 10000) return (n / 1000).toFixed(0) + "k";
  return Math.round(n).toLocaleString();
}

// Area, formatted: m² under a km², else km² with sensible precision.
function fmtArea(km2) {
  if (km2 == null || isNaN(km2)) return "—";
  if (km2 < 0.1) return `${Math.round(km2 * 1e6).toLocaleString()} m²`;
  if (km2 < 10) return `${km2.toFixed(2)} km²`;
  if (km2 < 100) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

// Fill the catchment stat cells (population / area / density) from `deep`.
function renderCatchmentStats() {
  const popEl = document.getElementById("dd-pop-value");
  const areaEl = document.getElementById("dd-area-value");
  const densEl = document.getElementById("dd-density-value");
  const noteEl = document.getElementById("dd-pop-note");
  if (!popEl) return;

  popEl.textContent = deep.population == null ? "—" : fmtCount(deep.population);
  popEl.title = deep.population == null ? "" : deep.population.toLocaleString() + " residents (est.)";
  const homesEl = document.getElementById("dd-homes-value");
  if (homesEl) {
    homesEl.textContent = deep.households == null ? "—" : fmtCount(deep.households);
    homesEl.title = deep.households == null ? "" : deep.households.toLocaleString() + " existing households (est.)";
  }
  if (areaEl) areaEl.textContent = fmtArea(deep.area_km2);
  const dens = densityPerKm2(deep.population, deep.area_km2);
  if (densEl) densEl.textContent = dens == null ? "—" : fmtCount(dens);

  // Local house-price value over the catchment (£/m²), with median sale price
  // as the tooltip — the local sales value the viability appraisal uses for GDV.
  const valEl = document.getElementById("dd-value-value");
  if (valEl) {
    valEl.textContent = deep.ppm2 == null ? "—" : ppm2Fmt(deep.ppm2);
    valEl.title = deep.ppm2 == null
      ? "No local house-price data for this catchment"
      : `${ppm2Fmt(deep.ppm2)} — catchment-weighted HM Land Registry £/m²`
        + (deep.ppm2FromDb ? " (precomputed — the same figure the sift uses)" : "")
        + (deep.medianPrice != null ? ` · ${priceFmt(deep.medianPrice)} median sale price` : "")
        + ". This is the local sales value the viability appraisal uses for GDV.";
  }

  if (noteEl) {
    if (deep.popFromDb) {
      noteEl.textContent =
        "Resident population within the 800 m catchment (ONS LSOA populations, precomputed) — the same figure the sift uses.";
    } else if (deep.population == null) {
      noteEl.textContent =
        "Population estimate unavailable — load LSOA population data (see DATASETS.md) to enable this.";
    } else if (deep.popPartial) {
      noteEl.textContent =
        "Area-weighted estimate; some overlapping LSOAs lacked a population figure, so this is a lower bound.";
    } else {
      noteEl.textContent =
        "Area-weighted estimate from overlapping LSOAs, assuming people are spread evenly within each.";
    }
  }
}

// Switch on all amenity layers (ticking their boxes and loading them).
function autoEnableAmenities() {
  for (const a of AMENITY_KINDS) {
    const cb = document.getElementById(`dd-${a.kind}`);
    if (cb && !cb.checked) {
      cb.checked = true;
      toggleAmenityKind(a.kind, true);
    }
  }
  syncAllAmenitiesCheckbox();
}

// Turn every amenity layer on or off at once from the master toggle. Ticks each
// per-kind box to match and triggers its load/remove.
function toggleAllAmenities(on) {
  for (const a of AMENITY_KINDS) {
    const cb = document.getElementById(`dd-${a.kind}`);
    if (!cb) continue;
    if (cb.checked !== on) {
      cb.checked = on;
      toggleAmenityKind(a.kind, on);
    }
  }
  // The "nearest access" route lines belong to the amenities — turning all
  // amenities off should clear them too; turning all on recomputes them.
  if (!on) {
    removeAccessRoutes();
  } else {
    computeNearestDistances();
  }
}

// Keep the master "All amenities" box reflecting the per-kind state: checked if
// all on, unchecked if all off, indeterminate if mixed.
function syncAllAmenitiesCheckbox() {
  const allCb = document.getElementById("dd-all-amenities");
  if (!allCb) return;
  let on = 0, total = 0;
  for (const a of AMENITY_KINDS) {
    const cb = document.getElementById(`dd-${a.kind}`);
    if (!cb) continue;
    total++;
    if (cb.checked) on++;
  }
  allCb.checked = total > 0 && on === total;
  allCb.indeterminate = on > 0 && on < total;
}

// Origin point for "nearest" measurements: the plot point if set, else the
// catchment centroid.
function catchmentOrigin() {
  try {
    if (plot.geometry && plot.geometry.type === "Point") return plot.geometry.coordinates;
    return turf.centroid(deep.catchment).geometry.coordinates;
  } catch (_) { return null; }
}

// Distance to the nearest amenity of each "access" kind — measured by REAL road
// travel (Valhalla routing), not straight line. For each kind we take the few
// closest candidates (crow-flies), route to each, and keep the shortest by road
// (the nearest as the crow flies isn't always nearest by road). We draw that
// route coloured to match the amenity and label it with distance + time.
const NEAREST_KINDS = [
  { kind: "gp", label: "GP surgery", source: "supabase" },
  { kind: "nursery", label: "Nursery", source: "supabase" },
  { kind: "school", label: "School", source: "supabase" },
  { kind: "supermarket", label: "Food store", source: "osm" },
];
const NEAREST_CANDIDATES = 4;   // how many closest to road-test per kind

async function computeNearestDistances() {
  const origin = catchmentOrigin();
  const listEl = document.getElementById("dd-access-list");
  if (!origin || !listEl) return;
  const [lng, lat] = origin;
  const originPt = turf.point(origin);
  // Route on foot by default to match the typical "walk to amenities" framing;
  // fall back to the plot mode if the user picked cycle/drive.
  const routeMode = plot.mode || "pedestrian";

  for (const nk of NEAREST_KINDS) {
    setAccessRow(nk.kind, nk.label, "…");
    try {
      // 1) Gather candidate amenities near the origin.
      let pts = [];
      if (nk.source === "osm") {
        pts = await fetchOsmNearby(lng, lat, 2500);
      } else {
        const sb = getSupabase();
        if (!sb) { setAccessRow(nk.kind, nk.label, "—"); continue; }
        for (const radius of [1500, 4000, 10000, 30000]) {
          const { data, error } = await sb.rpc("amenities_in_radius", {
            centre_lng: lng, centre_lat: lat, radius_m: radius, kinds: [nk.kind],
          });
          if (error) { console.error("radius", nk.kind, error); break; }
          if (data && data.length) { pts = data; break; }
        }
      }
      if (!pts.length) { setAccessRow(nk.kind, nk.label, "none nearby"); continue; }

      // 2) Take the N closest by crow-flies as routing candidates.
      pts.forEach(p => {
        p._crow = (p.distance_m != null) ? p.distance_m
          : turf.distance(originPt, turf.point([p.lng, p.lat]), { units: "meters" });
      });
      pts.sort((a, b) => a._crow - b._crow);
      const candidates = pts.slice(0, NEAREST_CANDIDATES);

      // 3) Route to each candidate; keep the shortest by road distance.
      let best = null;
      for (const c of candidates) {
        const route = await fetchRoute(lng, lat, c.lng, c.lat, routeMode);
        if (route && (!best || route.distance < best.distance)) {
          best = { ...route, target: c };
        }
      }
      if (!best) {
        // Routing failed for all — fall back to crow-flies of the closest.
        setAccessRow(nk.kind, nk.label, fmtDistance(candidates[0]._crow) + " (direct)");
        continue;
      }

      // 4) Draw the route + label, and write the stat.
      const meta = AMENITY_KINDS.find(a => a.kind === nk.kind) || { color: "#888" };
      const labelTxt = `${nk.label} · ${fmtDistance(best.distance)}`;
      drawAccessRoute(nk.kind, best.geometry, meta.color, labelTxt);
      setAccessRow(nk.kind, nk.label, `${fmtDistance(best.distance)} · ${fmtMins(best.time)}`);
    } catch (e) {
      console.error("nearest", nk.kind, e);
      setAccessRow(nk.kind, nk.label, "—");
    }
  }
}

// Valhalla point-to-point route. Returns {distance(m), time(s), geometry} or
// null. Decodes Valhalla's encoded polyline (precision 6).
async function fetchRoute(lng1, lat1, lng2, lat2, mode) {
  const body = {
    locations: [{ lat: lat1, lon: lng1 }, { lat: lat2, lon: lng2 }],
    costing: mode,
    directions_options: { units: "kilometers" },
  };
  try {
    const url = "https://valhalla1.openstreetmap.de/route?json=" + encodeURIComponent(JSON.stringify(body));
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const leg = j.trip && j.trip.legs && j.trip.legs[0];
    if (!leg) return null;
    return {
      distance: (j.trip.summary.length || 0) * 1000,   // km -> m
      time: j.trip.summary.time || 0,                  // seconds
      geometry: decodePolyline6(leg.shape),
    };
  } catch (_) { return null; }
}

// Valhalla encodes route shapes as a polyline with 6 digits of precision.
function decodePolyline6(str) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return { type: "LineString", coordinates: coords };
}

// Draw one access route, coloured to match its amenity, with a midpoint label.
function drawAccessRoute(kind, geometry, color, labelTxt) {
  const lineSrc = `access-route-${kind}`;
  const lineData = { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: { label: labelTxt || "" } }] };
  if (map.getSource(lineSrc)) {
    map.getSource(lineSrc).setData(lineData);
  } else {
    map.addSource(lineSrc, { type: "geojson", data: lineData });
    // A thin dashed route: a subtle white casing for legibility over the base,
    // then the coloured dashed line on top. Kept understated so the routes
    // inform without dominating the map.
    map.addLayer({
      id: `${lineSrc}-case`, type: "line", source: lineSrc,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#fff", "line-width": 3, "line-opacity": 0.55 },
    });
    map.addLayer({
      id: `${lineSrc}-line`, type: "line", source: lineSrc,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": 1.6,
        "line-opacity": 0.9,
        "line-dasharray": [3, 2],
      },
    });
    // Subtle label following the route line, coloured to match with a white halo.
    map.addLayer({
      id: `${lineSrc}-label`, type: "symbol", source: lineSrc,
      layout: {
        "symbol-placement": "line-center",
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
        "text-letter-spacing": 0.02,
      },
      paint: {
        "text-color": color,
        "text-halo-color": "#fff",
        "text-halo-width": 2,
      },
    });
  }
  deep.accessRouteKinds = deep.accessRouteKinds || new Set();
  deep.accessRouteKinds.add(kind);
}

function removeAccessRoutes() {
  if (!deep.accessRouteKinds) return;
  for (const kind of deep.accessRouteKinds) {
    for (const suf of ["-case", "-line", "-label"]) {
      const id = `access-route-${kind}${suf}`;
      if (map.getLayer(id)) map.removeLayer(id);
    }
    const src = `access-route-${kind}`;
    if (map.getSource(src)) map.removeSource(src);
  }
  deep.accessRouteKinds = new Set();
}

function fmtMins(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const m = Math.round(seconds / 60);
  return m < 1 ? "<1 min" : `${m} min`;
}

// Overpass: nearby food stores within `radius` m of a point (for nearest calc).
async function fetchOsmNearby(lng, lat, radius) {
  const q = `[out:json][timeout:25];
    (nwr["shop"~"supermarket|convenience|greengrocer|grocery"](around:${radius},${lat},${lng}););
    out center;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
  const json = await r.json();
  return (json.elements || []).map(el => ({
    lng: el.lon ?? el.center?.lon, lat: el.lat ?? el.center?.lat,
  })).filter(p => p.lng != null && p.lat != null);
}

function fmtDistance(m) {
  if (m == null || !isFinite(m)) return "—";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function setAccessRow(kind, label, value) {
  const listEl = document.getElementById("dd-access-list");
  if (!listEl) return;
  const meta = AMENITY_KINDS.find(a => a.kind === kind) || { color: "#888" };
  let row = document.getElementById(`dd-access-${kind}`);
  if (!row) {
    row = document.createElement("div");
    row.className = "dd-access-row";
    row.id = `dd-access-${kind}`;
    row.innerHTML =
      `<span class="dd-access-swatch" style="background:${meta.color}"></span>` +
      `<span class="dd-access-label"></span><span class="dd-access-val"></span>`;
    listEl.appendChild(row);
  }
  row.querySelector(".dd-access-label").textContent = label;
  row.querySelector(".dd-access-val").textContent = value;
}

function exitDeepDive() {
  deep.active = false;
  clearDeepDiveMapArtifacts();
  for (const id of ["lsoa-fill", "simd-fill"])
    if (map.getLayer(id))
      map.setPaintProperty(id, "fill-opacity", state.imdOn ? state.fillOpacity : 0);
  setDeepPanelOpen(false);
  const panel = document.getElementById("deepdive-panel");
  if (panel) panel.innerHTML = "";
  if (deep.prevView) {
    map.easeTo({ center: deep.prevView.center, zoom: deep.prevView.zoom, duration: 500 });
  }
  // If we drilled in from a batch run, return to that dashboard instead of
  // leaving the user stranded (they'd otherwise have to re-run the whole batch).
  if (batch.returnAfterDeepDive) {
    batch.returnAfterDeepDive = false;
    reopenBatchResults();
  }
}

// Remove EVERY map artifact a deep dive can create — amenity layers/sources,
// access-route layers/sources, crime, the catchment outline/mask, the plot
// point, and any open popups. Done by ID prefix sweep (not just tracked sets)
// so nothing can be orphaned if state ever drifts (e.g. starting a new deep
// dive over an old one). Safe to call repeatedly.
function clearDeepDiveMapArtifacts() {
  const style = map.getStyle && map.getStyle();
  const layerIds = (style && style.layers ? style.layers.map(l => l.id) : []);
  const sourceIds = style && style.sources ? Object.keys(style.sources) : [];

  // Layers first (a source can't be removed while a layer uses it).
  for (const id of layerIds) {
    if (id.startsWith("amenity-") || id.startsWith("access-route-")
        || id.startsWith("brownfield-") || id.startsWith("developable-")
        || id.startsWith("publicland-")) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  }
  for (const id of sourceIds) {
    if (id.startsWith("amenity-") || id.startsWith("access-route-")
        || id.startsWith("brownfield-") || id.startsWith("developable-")
        || id.startsWith("publicland-")) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  // Tracked sets too (covers any non-prefixed leftovers + resets state).
  for (const a of AMENITY_KINDS) removeAmenityLayer(a.kind);
  removeCrimeLayer();
  removeAccessRoutes();
  removeBrownfieldLayer();
  removeDevelopableLayer();
  removeCatchmentOutline();
  if (map.getLayer("plot-point-dot")) map.removeLayer("plot-point-dot");
  if (map.getSource("plot-point-src")) map.removeSource("plot-point-src");

  // Close any popups left open by amenity/stop/station clicks.
  closeAllPopups();
  deep.accessRouteKinds = new Set();
}

function setCatchmentOutline(feature) {
  const data = { type: "FeatureCollection", features: [feature] };

  // Build a "mask": a world-covering polygon with the catchment punched out as a
  // hole, so everything OUTSIDE the catchment is dimmed and the analysis area
  // stands out. Turf's mask does exactly this (outer ring = world, inner = the
  // catchment). Fallback: skip the mask if turf.mask isn't available.
  let maskData = { type: "FeatureCollection", features: [] };
  try {
    if (window.turf && turf.mask) {
      maskData = { type: "FeatureCollection", features: [turf.mask(feature)] };
    }
  } catch (_) { /* no mask, just the outline */ }

  // Mask fill (under the outline).
  if (map.getSource("catchment-mask")) {
    map.getSource("catchment-mask").setData(maskData);
  } else {
    map.addSource("catchment-mask", { type: "geojson", data: maskData });
    // Insert below the catchment line if it exists, else on top.
    map.addLayer({
      id: "catchment-mask-fill", type: "fill", source: "catchment-mask",
      paint: {
        "fill-color": body_is_light() ? "#ffffff" : "#0a0f1a",
        "fill-opacity": 0.55,
      },
    });
  }

  // Catchment outline (on top of the mask).
  if (map.getSource("catchment")) {
    map.getSource("catchment").setData(data);
  } else {
    map.addSource("catchment", { type: "geojson", data });
    map.addLayer({
      id: "catchment-line", type: "line", source: "catchment",
      paint: { "line-color": body_is_light() ? "#111" : "#fff", "line-width": 2.5, "line-dasharray": [2, 1] },
    });
  }
}

// Small helper: is the UI in light theme right now?
function body_is_light() {
  return document.body.classList.contains("light");
}
function removeCatchmentOutline() {
  if (map.getLayer("catchment-line")) map.removeLayer("catchment-line");
  if (map.getSource("catchment")) map.removeSource("catchment");
  if (map.getLayer("catchment-mask-fill")) map.removeLayer("catchment-mask-fill");
  if (map.getSource("catchment-mask")) map.removeSource("catchment-mask");
}

// Query Supabase for amenities of one kind inside the current catchment, cache
// and render them. Returns the count, or:
//   null    = DB not configured (no Supabase client)
//   "error" = the query ran but failed (returned via deep._lastAmenityError)
async function loadAmenityKind(kind) {
  if (deep.cache[kind]) return deep.cache[kind].length;

  const meta = AMENITY_KINDS.find(a => a.kind === kind);
  if (meta && meta.source === "osm") {
    return loadOsmAmenity(kind);   // live OpenStreetMap, no DB needed
  }

  const sb = getSupabase();
  if (!sb) { deep._lastAmenityError = "not_configured"; return null; }
  const { data, error } = await sb.rpc("amenities_in_polygon", {
    catchment: deep.catchment.geometry,
    kinds: [kind],
  });
  if (error) {
    console.error("amenities_in_polygon failed for", kind, error);
    deep._lastAmenityError = error.message || "query failed";
    return null;
  }
  deep._lastAmenityError = null;
  deep.cache[kind] = data || [];
  return deep.cache[kind].length;
}

// Food stores from OpenStreetMap via the Overpass API. Like crime, this takes
// the catchment polygon and needs no storage. We ask for supermarkets,
// convenience stores, greengrocers and similar within the polygon.
async function loadOsmAmenity(kind) {
  // Build an Overpass "poly" filter from the catchment outer ring (lat lng ...).
  let ring;
  const g = deep.catchment.geometry;
  if (g.type === "Polygon") ring = g.coordinates[0];
  else if (g.type === "MultiPolygon") ring = g.coordinates[0][0];
  else return 0;
  // Overpass wants "lat lon lat lon ..." space-separated.
  let pts = ring;
  if (pts.length > 60) {
    const step = Math.ceil(pts.length / 60);
    pts = pts.filter((_, i) => i % step === 0);
  }
  const polyStr = pts.map(([lng, lat]) => `${lat.toFixed(5)} ${lng.toFixed(5)}`).join(" ");

  // Food retail tags. node+way+relation so we catch both points and buildings.
  const q = `[out:json][timeout:25];
    (
      nwr["shop"~"supermarket|convenience|greengrocer|grocery"](poly:"${polyStr}");
    );
    out center tags;`;

  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const rows = (json.elements || []).map(el => {
      const lng = el.lon ?? el.center?.lon;
      const lat = el.lat ?? el.center?.lat;
      if (lng == null || lat == null) return null;
      const t = el.tags || {};
      const kindLabel = t.shop === "supermarket" ? "Supermarket"
        : t.shop === "convenience" ? "Convenience store"
        : t.shop === "greengrocer" ? "Greengrocer" : "Food store";
      return { lng, lat, name: t.name || kindLabel, props: { type: kindLabel } };
    }).filter(Boolean);
    deep.cache[kind] = rows;
    return rows.length;
  } catch (e) {
    console.error("overpass", e);
    return null;
  }
}

async function renderAmenityLayer(kind) {
  const meta = AMENITY_KINDS.find(a => a.kind === kind);
  const rows = deep.cache[kind] || [];
  const fc = {
    type: "FeatureCollection",
    features: rows.map(r => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
      properties: {
        name: r.name || meta.label,
        kind,
        sub: (r.props && (r.props.type || r.props.phase)) || meta.label,
      },
    })),
  };
  const srcId = `amenity-${kind}`;
  const layerId = `${srcId}-dot`;

  if (map.getSource(srcId)) {
    map.getSource(srcId).setData(fc);
    return;
  }

  map.addSource(srcId, { type: "geojson", data: fc });

  if (meta.icon) {
    // Icon marker (e.g. a little bus for stops).
    const imgId = await registerIcon(meta.icon, meta.color);
    map.addLayer({
      id: layerId, type: "symbol", source: srcId,
      layout: {
        "icon-image": imgId,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.59, 16, 0.87],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  } else {
    // Plain coloured dot.
    map.addLayer({
      id: layerId, type: "circle", source: srcId,
      paint: {
        "circle-radius": 6,
        "circle-color": meta.color,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
      },
    });
  }

  // (Amenity taps are handled by the unified handleMapTap dispatcher, so they
  // work on touch as well as desktop — no layer-specific click handler here.)
}

// SVG marker images for amenity symbol layers, keyed by icon name. Each is a
// coloured rounded square (the layer's colour) with a white border and a white
// glyph, registered as a map image so symbol layers can use it. Cached so each
// builds once per map. All share a 44x44 frame; only the glyph differs.
const _frame = (color, glyph) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
    <rect x="3" y="3" width="38" height="38" rx="10" fill="${color}" stroke="#fff" stroke-width="3"/>
    <g fill="#fff">${glyph}</g>
  </svg>`;

const ICON_SVGS = {
  // Bus — body with windows and two wheels.
  bus: (c) => _frame(c, `
    <rect x="13" y="11" width="18" height="17" rx="3"/>
    <rect x="15" y="14" width="14" height="6" rx="1.5" fill="${c}"/>
    <circle cx="17" cy="29.5" r="2.6"/><circle cx="27" cy="29.5" r="2.6"/>`),
  // GP — medical cross.
  gp: (c) => _frame(c, `
    <rect x="19" y="11" width="6" height="22" rx="1.5"/>
    <rect x="11" y="19" width="22" height="6" rx="1.5"/>`),
  // Pharmacy — mortar & pestle (bowl + pestle).
  pharmacy: (c) => _frame(c, `
    <path d="M13 21 h18 a9 9 0 0 1 -18 0 z"/>
    <rect x="20.5" y="11" width="3" height="11" rx="1.5" transform="rotate(28 22 16)"/>
    <rect x="12" y="30" width="20" height="3.5" rx="1.75"/>`),
  // School — graduation cap (mortarboard).
  school: (c) => _frame(c, `
    <path d="M22 12 L34 18 L22 24 L10 18 Z"/>
    <path d="M16 21 v5 a6 3 0 0 0 12 0 v-5" fill="none" stroke="#fff" stroke-width="2.4"/>
    <rect x="32.5" y="18" width="1.8" height="8" rx="0.9"/>`),
  // Nursery — building blocks (two stacked squares with letters feel).
  nursery: (c) => _frame(c, `
    <rect x="12" y="22" width="9" height="9" rx="1.5"/>
    <rect x="23" y="22" width="9" height="9" rx="1.5"/>
    <rect x="17.5" y="12" width="9" height="9" rx="1.5"/>`),
  // Food store — shopping basket.
  food: (c) => _frame(c, `
    <path d="M13 19 h18 l-2 13 h-14 z"/>
    <path d="M17 19 l3 -7 M27 19 l-3 -7" stroke="#fff" stroke-width="2.2" fill="none"/>
    <rect x="18" y="23" width="2.4" height="6" rx="1.2" fill="${c}"/>
    <rect x="23.6" y="23" width="2.4" height="6" rx="1.2" fill="${c}"/>`),
};

const _iconsLoaded = new Set();
async function registerIcon(name, color) {
  const id = `icon-${name}`;
  if (_iconsLoaded.has(id) || map.hasImage(id)) { _iconsLoaded.add(id); return id; }
  const svg = ICON_SVGS[name](color);
  const url = "data:image/svg+xml;base64," + btoa(svg);
  await new Promise((resolve) => {
    const img = new Image(44, 44);
    img.onload = () => {
      if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
      _iconsLoaded.add(id);
      resolve();
    };
    img.onerror = () => resolve();   // fall back to a dot if the image fails
    img.src = url;
  });
  return id;
}

function removeAmenityLayer(kind) {
  const srcId = `amenity-${kind}`;
  if (map.getLayer(`${srcId}-dot`)) map.removeLayer(`${srcId}-dot`);
  if (map.getSource(srcId)) map.removeSource(srcId);
}

// ---- Brownfield land (developable supply) ---------------------------------
// Colour for brownfield markers/footprints. A green-gold, distinct from the
// deprivation ramp, amenity colours and the purple stations.
const BROWNFIELD_COLOR = "#3f9b5e";
const BROWNFIELD_COLOR_PUBLIC = "#e0a32e";   // public-owned sites stand out

// Load brownfield sites in the catchment from Supabase, applying current
// filters server-side. Caches the result on deep.brownfield and also fetches
// the summary. Returns the site count, or null on error/not-configured.
async function loadBrownfield() {
  const sb = getSupabase();
  if (!sb) { deep._lastBrownfieldError = "not_configured"; return null; }
  const f = deep.brownfieldFilters;
  const params = {
    catchment: deep.catchment.geometry,
    min_dwellings: f.minDwellings > 0 ? f.minDwellings : null,
    public_only: !!f.publicOnly,
    deliverable_only: !!f.deliverableOnly,
  };
  const [sitesRes, sumRes] = await Promise.all([
    sb.rpc("brownfield_in_polygon", params),
    sb.rpc("brownfield_summary_in_polygon", params),
  ]);
  if (sitesRes.error) {
    console.error("brownfield_in_polygon failed", sitesRes.error);
    deep._lastBrownfieldError = sitesRes.error.message || "query failed";
    return null;
  }
  deep._lastBrownfieldError = null;
  deep.brownfield = sitesRes.data || [];
  deep.brownfieldSummary = (sumRes.data && sumRes.data[0]) || null;
  return deep.brownfield.length;
}

// Render the brownfield layer: polygon footprints where we have them, and
// circle markers for point-only sites. Public-owned sites use a distinct
// colour. Click a feature for its detail card.
function renderBrownfieldLayer() {
  removeBrownfieldLayer();
  const sites = deep.brownfield || [];
  if (!sites.length) return;

  // Split into polygon features and point features.
  const polyFeatures = [];
  const pointFeatures = [];
  for (const s of sites) {
    const baseProps = {
      id: s.id, reference: s.reference, entity: s.entity, name: s.name, site_address: s.site_address,
      hectares: s.hectares, dwellings_min: s.dwellings_min, dwellings_max: s.dwellings_max,
      ownership_status: s.ownership_status, is_public: s.is_public,
      deliverable: s.deliverable, permission_status: s.permission_status,
      permission_date: s.permission_date, notes: s.notes, source_url: s.source_url,
    };
    if (s.area_geojson) {
      let geom = null;
      try { geom = JSON.parse(s.area_geojson); } catch (_) { geom = null; }
      if (geom) polyFeatures.push({ type: "Feature", geometry: geom, properties: baseProps });
    }
    if (s.lng != null && s.lat != null) {
      pointFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: baseProps,
      });
    }
  }

  const colorExpr = ["case", ["==", ["get", "is_public"], true], BROWNFIELD_COLOR_PUBLIC, BROWNFIELD_COLOR];

  if (polyFeatures.length) {
    map.addSource("brownfield-poly", { type: "geojson", data: { type: "FeatureCollection", features: polyFeatures } });
    map.addLayer({
      id: "brownfield-poly-fill", type: "fill", source: "brownfield-poly",
      paint: { "fill-color": colorExpr, "fill-opacity": 0.28 },
    });
    map.addLayer({
      id: "brownfield-poly-line", type: "line", source: "brownfield-poly",
      paint: { "line-color": colorExpr, "line-width": 1.6 },
    });
  }
  if (pointFeatures.length) {
    map.addSource("brownfield-pt", { type: "geojson", data: { type: "FeatureCollection", features: pointFeatures } });
    map.addLayer({
      id: "brownfield-pt-dot", type: "circle", source: "brownfield-pt",
      paint: {
        // Size by max dwelling capacity so bigger opportunities read larger.
        "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "dwellings_max"], 0],
          0, 4, 50, 6, 200, 9, 1000, 13],
        "circle-color": colorExpr,
        "circle-opacity": 0.85,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.2,
      },
    });
  }

  // Brownfield taps are handled by the unified handleMapTap dispatcher (works
  // on touch + desktop); here we only set the hover cursor on desktop.
  for (const id of ["brownfield-poly-fill", "brownfield-pt-dot"]) {
    if (map.getLayer(id)) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }
}

function removeBrownfieldLayer() {
  for (const id of ["brownfield-poly-fill", "brownfield-poly-line", "brownfield-pt-dot"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ["brownfield-poly", "brownfield-pt"]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

// HTML for a brownfield site popup.
function brownfieldPopupHTML(pr) {
  const pub = pr.is_public === true || pr.is_public === "true";
  const accent = pub ? "#e0a32e" : "#3f9b5e";
  const cap = brownfieldCapacityText(pr);
  const ha = (pr.hectares != null && pr.hectares !== "") ? `${Number(pr.hectares).toFixed(2)} ha` : null;
  const perm = pr.permission_status ? String(pr.permission_status).replace(/-/g, " ") : null;
  const deliverable = String(pr.deliverable || "").toLowerCase() === "yes";
  const ownTxt = pr.ownership_status
    ? String(pr.ownership_status).replace(/-/g, " ")
    : (pub ? "public-authority owned" : null);

  // Canonical link: planning.data.gov.uk entity page (the site-plan-url field
  // is frequently blank or a dead council URL, so prefer the entity link).
  let linkHref = null;
  if (pr.entity != null && pr.entity !== "") {
    linkHref = `https://www.planning.data.gov.uk/entity/${pr.entity}`;
  } else if (pr.source_url) {
    linkHref = pr.source_url;
  }

  const title = pr.name || pr.reference || "Brownfield site";

  // A compact, graphical card: coloured header strip, a capacity "hero" number,
  // a small fact grid, status chips, and the canonical link.
  const chips = [];
  if (deliverable) chips.push(`<span class="bf-chip bf-chip-good">Deliverable</span>`);
  if (perm) chips.push(`<span class="bf-chip">${perm}</span>`);
  if (pub) chips.push(`<span class="bf-chip bf-chip-public">Public-owned</span>`);

  const facts = [];
  if (ha) facts.push(`<div class="bf-fact"><div class="bf-fact-v">${ha}</div><div class="bf-fact-l">Area</div></div>`);
  if (ownTxt) facts.push(`<div class="bf-fact"><div class="bf-fact-v" style="text-transform:capitalize;font-size:11px">${ownTxt}</div><div class="bf-fact-l">Ownership</div></div>`);

  return `
    <div class="bf-card" style="--bf-accent:${accent}">
      <div class="bf-head">
        <div class="bf-title">${title}</div>
        ${pr.site_address ? `<div class="bf-addr">${pr.site_address}</div>` : ""}
      </div>
      ${cap ? `<div class="bf-hero"><span class="bf-hero-n">${cap}</span></div>` : ""}
      ${facts.length ? `<div class="bf-facts">${facts.join("")}</div>` : ""}
      ${chips.length ? `<div class="bf-chips">${chips.join("")}</div>` : ""}
      ${linkHref ? `<a class="bf-link" href="${linkHref}" target="_blank" rel="noopener">View on Planning Data ↗</a>` : ""}
    </div>`;
}

function brownfieldCapacityText(pr) {
  const lo = (pr.dwellings_min != null && pr.dwellings_min !== "") ? Number(pr.dwellings_min) : null;
  const hi = (pr.dwellings_max != null && pr.dwellings_max !== "") ? Number(pr.dwellings_max) : null;
  if (lo == null && hi == null) return "";
  if (lo != null && hi != null && lo !== hi) return `${lo}–${hi} homes`;
  return `${hi ?? lo} homes`;
}

function brownfieldOwnershipLabel(pr) {
  const pub = pr.is_public === true || pr.is_public === "true";
  if (pr.ownership_status) {
    const txt = String(pr.ownership_status).replace(/-/g, " ");
    return (pub ? "🏛 " : "") + txt.charAt(0).toUpperCase() + txt.slice(1);
  }
  return pub ? "🏛 Public-authority owned" : "";
}

// Toggle the brownfield layer on/off (loads on first enable).
async function toggleBrownfield(on) {
  deep.brownfieldVisible = on;
  if (!on) { removeBrownfieldLayer(); renderBrownfieldSummary(); return; }
  setBrownfieldStatus("loading…");
  const n = await loadBrownfield();
  if (n === null) {
    setBrownfieldStatus(deep._lastBrownfieldError === "not_configured"
      ? "DB not configured" : "query error — see console");
    deep.brownfieldVisible = false;
    const cb = document.getElementById("dd-brownfield-show");
    if (cb) cb.checked = false;
    return;
  }
  renderBrownfieldLayer();
  renderBrownfieldSummary();
}

// Re-query with current filters (called when a filter changes while on).
async function refreshBrownfield() {
  if (!deep.brownfieldVisible) { renderBrownfieldSummary(); return; }
  setBrownfieldStatus("loading…");
  const n = await loadBrownfield();
  if (n === null) { setBrownfieldStatus("query error — see console"); return; }
  renderBrownfieldLayer();
  renderBrownfieldSummary();
}

function setBrownfieldStatus(text) {
  const el = document.getElementById("dd-brownfield-status");
  if (el) el.textContent = text;
}

// Fill the supply headline: site count, total capacity, public share.
function renderBrownfieldSummary() {
  const el = document.getElementById("dd-brownfield-summary");
  if (!el) return;
  const s = deep.brownfieldSummary;
  if (!deep.brownfieldVisible || !s) {
    el.innerHTML = "";
    setBrownfieldStatus(deep.brownfieldVisible ? "" : "");
    return;
  }
  const n = Number(s.n_sites) || 0;
  if (n === 0) {
    el.innerHTML = `<p class="hint">No brownfield sites match in this catchment${brownfieldFilterSuffix()}.</p>`;
    setBrownfieldStatus("0 sites");
    return;
  }
  const lo = Number(s.dwellings_min_total) || 0;
  const hi = Number(s.dwellings_max_total) || 0;
  const capTxt = lo && hi && lo !== hi ? `${lo.toLocaleString()}–${hi.toLocaleString()}`
    : `${(hi || lo).toLocaleString()}`;
  const pubN = Number(s.n_public) || 0;
  const ha = Number(s.hectares_total) || 0;
  el.innerHTML = `
    <div class="dd-stats-grid" style="margin-top:6px">
      <div class="dd-stat-cell"><div class="dd-stat-num">${n.toLocaleString()}</div><div class="dd-stat-cap">Sites</div></div>
      <div class="dd-stat-cell"><div class="dd-stat-num">${capTxt}</div><div class="dd-stat-cap">Est. homes</div></div>
      <div class="dd-stat-cell"><div class="dd-stat-num">${pubN.toLocaleString()}</div><div class="dd-stat-cap">Public-owned</div></div>
    </div>
    <p class="hint" style="margin-top:6px">${ha.toFixed(1)} ha of brownfield land in catchment${brownfieldFilterSuffix()}. Capacity is the register's estimate; gold markers are public-authority owned.</p>`;
  setBrownfieldStatus(`${n} site${n === 1 ? "" : "s"}`);
}

function brownfieldFilterSuffix() {
  const f = deep.brownfieldFilters;
  const bits = [];
  if (f.minDwellings > 0) bits.push(`≥${f.minDwellings} homes`);
  if (f.publicOnly) bits.push("public-owned");
  if (f.deliverableOnly) bits.push("deliverable");
  return bits.length ? ` (filtered: ${bits.join(", ")})` : "";
}

// ---- Developable land near a station (+ dwelling capacity) -----------------
// For the selected station we ask Supabase for the developable land inside a
// radius (the catchment minus the chosen physical/planning constraints). The
// RPC returns geometry to display plus hectare breakdowns we turn into a
// dwelling-capacity estimate under three density regimes. All defensive: any
// failure or empty result no-ops gracefully.

// Build the text[] `subtract` array from the checked constraint kinds.
function developableSubtractArray() {
  const sub = (deep.developable && deep.developable.subtract) || {};
  return DEVELOPABLE_SUBTRACT_KINDS.filter(k => sub[k.key]).map(k => k.key);
}

// Call the developable-land RPC for the current station + filters. Stores the
// result row on deep.developableResult and recomputes catchment density for the
// auto-classification. Returns the row, or null on error / not-configured.
async function loadDevelopable() {
  const sb = getSupabase();
  if (!sb) { deep._lastDevelopableError = "not_configured"; return null; }
  const centre = deep.stationCentre;
  if (!centre) { deep._lastDevelopableError = "no_station"; return null; }
  const cfg = deep.developable || defaultDevelopableConfig();
  const params = {
    centre_lng: centre[0],
    centre_lat: centre[1],
    radius_m: cfg.radius_m,
    inner_radius_m: cfg.inner_radius_m,
    subtract: developableSubtractArray(),
    min_plot_m2: (cfg.minPlotAc > 0 ? cfg.minPlotAc * M2_PER_ACRE : 0),
    largest_only: !!cfg.largestOnly,
    min_width_m: (cfg.minWidthM > 0 ? cfg.minWidthM : 0),
  };
  const { data, error } = await sb.rpc("developable_land_near_station", params);
  if (error) {
    console.error("developable_land_near_station failed", error);
    deep._lastDevelopableError = error.message || "query failed";
    return null;
  }
  deep._lastDevelopableError = null;
  deep.developableResult = (data && data[0]) || null;
  computeDevelopableDensity();
  return deep.developableResult;
}

// People/km² over the SAME circular catchment used by the RPC (turf.circle at
// radius_m), via the shared areal-interpolation helpers. Drives the auto
// rural/suburban/urban classification. Null if turf/LSOAs unavailable.
function computeDevelopableDensity() {
  deep.developableDensity = null;
  if (!window.turf || !deep.stationCentre || !deep.developable) return;
  let circle = null;
  try {
    circle = turf.circle(deep.stationCentre, deep.developable.radius_m / 1000,
      { units: "kilometers", steps: 64 });
  } catch (_) { circle = null; }
  if (!circle) return;
  const res = areaWeightedPopulation(circle);
  deep.developableDensity = densityPerKm2(res.population, res.area_km2);
}

// Classify a density (people/km²) into a regime using the adjustable bands.
function classifyDevelopable(density) {
  if (density == null || isNaN(density)) return null;
  if (density > DENSITY_BANDS.urban) return "urban";
  if (density >= DENSITY_BANDS.suburban) return "suburban";
  return "rural";
}

// The auto (non-override) regime: ONS Rural-Urban Classification of the
// station's LSOA when available (the preferred, authoritative source), else the
// population-density bands as a fallback.
function autoDevelopableRegime() {
  if (deep.stationRuralUrban) return deep.stationRuralUrban;
  return classifyDevelopable(deep.developableDensity);
}

// Where the auto regime came from — for the UI note ("ONS RUC" vs "by density").
function autoDevelopableRegimeSource() {
  if (deep.stationRuralUrban) return "ONS RUC";
  if (deep.developableDensity != null) return "by density";
  return null;
}

// The regime currently in effect: the user's override, else the auto class,
// else a sensible suburban default.
function activeDevelopableRegime() {
  if (deep.developableRegime && deep.developableRegime !== "auto") return deep.developableRegime;
  return autoDevelopableRegime() || "suburban";
}

// THE capacity formula — one place. This arithmetic used to be copy-pasted at
// five call sites (whole-catchment, per-plot, popup, public land, legend), so
// changing a density rule meant finding all five or shipping a map that
// disagreed with itself. Urban splits inner/outer ring densities; everything
// else is flat-rate on total area. innerHa beyond areaHa is clamped, not
// trusted — clipped geometries occasionally report a sliver more inner than
// total, and negative outer hectares would silently subtract homes.
function homesFor(areaHa, innerHa, regime, dph) {
  const d = dph || deep.developableDph || DPH_DEFAULTS;
  const a = Math.max(0, Number(areaHa) || 0);
  const inner = Math.min(a, Math.max(0, Number(innerHa) || 0));
  if (regime === "urban")
    return Math.round(inner * d.urbanInner + (a - inner) * d.urbanOuter);
  return Math.round(a * (d[regime] || d.suburban));
}

// Potential dwellings under each regime from the RPC's hectare breakdown and the
// (editable) dwellings-per-hectare constants. Whole numbers. Null if no result.
function developableDwellings() {
  const r = deep.developableResult;
  if (!r) return null;
  const dph = deep.developableDph || DPH_DEFAULTS;
  const dev = Number(r.developable_ha) || 0;
  const inner = Number(r.inner_ha) || 0;
  const outer = Number(r.outer_ha) || 0;
  return {
    rural: homesFor(dev, 0, "rural", dph),
    suburban: homesFor(dev, 0, "suburban", dph),
    urban: homesFor(dev, inner, "urban", dph),
  };
}

// Render the developable overlay: muted-red blocker fill underneath, green
// developable fill + outline on top. Clicks are handled by the shared
// handleMapTap dispatcher (see tapDeepDiveLayers); here we only set the hover
// cursor and flag the footer attribution.
// turf v7 takes a FeatureCollection where v6 took two arguments — the app
// vendors v7 but stays tolerant of either.
function _turfIntersect(a, b) {
  if (!window.turf) return null;
  try {
    const r = turf.intersect(turf.featureCollection([a, b]));
    if (r) return r;
  } catch (_) {}
  try { return turf.intersect(a, b) || null; } catch (_) { return null; }
}

// Split the RPC's single developable MultiPolygon into individually
// selectable plots, each tagged with its area and the share of it that sits
// inside the inner (high-density) ring. Falls back to one whole-geometry
// feature if turf is unavailable or the geometry defeats it.
function developablePlotFeatures(geom) {
  const base = { type: "Feature", geometry: geom, properties: {} };
  if (!window.turf) return [{ ...base, properties: { plot: 0 } }];
  let parts = [];
  try {
    const flat = turf.flatten(base);
    parts = (flat.features || []).filter(f => f && f.geometry);
  } catch (_) {
    parts = [base];
  }
  const inner = deep._innerCircle;
  return parts.map((f, i) => {
    let ha = null, innerHa = 0;
    try { ha = turf.area(f) / 10000; } catch (_) {}
    if (inner) {
      const cut = _turfIntersect(f, inner);
      if (cut) { try { innerHa = turf.area(cut) / 10000; } catch (_) {} }
    }
    return { ...f, properties: { ...(f.properties || {}), plot: i,
             area_ha: ha != null ? Math.round(ha * 100) / 100 : null,
             inner_ha: Math.round(innerHa * 100) / 100 } };
  });
}

// The developable area clipped to the inner ring — painted hotter because it
// carries the urban dwellings-per-hectare rate.
function developableInnerGeometry(geom) {
  const inner = deep._innerCircle;
  if (!window.turf || !inner) return null;
  const cut = _turfIntersect(
    { type: "Feature", geometry: geom, properties: {} }, inner);
  return cut ? cut.geometry : null;
}

// Render the developable overlay: muted-red blocker fill underneath, green
// developable fill + outline on top, with the inner (high-density) portion in
// a hotter green and a highlight layer for the selected plot. Clicks are
// handled by the shared handleMapTap dispatcher (see tapDeepDiveLayers).
function renderDevelopableLayer() {
  removeDevelopableLayer();
  const r = deep.developableResult;
  if (!r) return;

  // Cache the inner-ring circle once — used for the density split and for
  // per-plot stats.
  deep._innerCircle = null;
  if (window.turf && deep.stationCentre && deep.developable) {
    try {
      deep._innerCircle = turf.circle(deep.stationCentre,
        (deep.developable.inner_radius_m || 200) / 1000,
        { units: "kilometers", steps: 64 });
    } catch (_) {}
  }

  if (r.blockers_geojson) {
    map.addSource("developable-blockers-src", {
      type: "geojson",
      data: { type: "Feature", geometry: r.blockers_geojson, properties: {} },
    });
    map.addLayer({
      id: "developable-blockers", type: "fill", source: "developable-blockers-src",
      paint: {
        "fill-color": DEVELOPABLE_BLOCKER_COLOR,
        "fill-opacity": 0.22,
        "fill-outline-color": DEVELOPABLE_BLOCKER_COLOR,
      },
    });
  }
  if (r.developable_geojson) {
    deep._plots = developablePlotFeatures(r.developable_geojson);
    map.addSource("developable-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: deep._plots },
    });
    map.addLayer({
      id: "developable-fill", type: "fill", source: "developable-src",
      paint: { "fill-color": DEVELOPABLE_COLOR, "fill-opacity": 0.42 },
    });
    // Inner ring portion: same land, urban density — hotter fill on top.
    const innerGeom = developableInnerGeometry(r.developable_geojson);
    if (innerGeom) {
      map.addSource("developable-inner-src", {
        type: "geojson",
        data: { type: "Feature", geometry: innerGeom, properties: {} },
      });
      map.addLayer({
        id: "developable-inner-fill", type: "fill", source: "developable-inner-src",
        paint: { "fill-color": DEVELOPABLE_INNER_COLOR, "fill-opacity": 0.55 },
      });
    }
    map.addLayer({
      id: "developable-line", type: "line", source: "developable-src",
      paint: { "line-color": DEVELOPABLE_COLOR, "line-width": 1.8 },
    });
    // Selected-plot highlight (filter set on click; empty until then).
    map.addLayer({
      id: "developable-selected", type: "line", source: "developable-src",
      filter: ["==", ["get", "plot"], -1],
      paint: { "line-color": "#ffffff", "line-width": 3.4, "line-opacity": 0.95 },
    });
    // Assembly highlight — its own fill+line so it never fights the
    // single-select layer. Amber: distinct from the purple fills, readable on
    // both light and dark basemaps.
    map.addLayer({
      id: "developable-assembled", type: "fill", source: "developable-src",
      filter: ["in", ["get", "plot"], ["literal", []]],
      paint: { "fill-color": "#ffd43b", "fill-opacity": 0.35 },
    });
    map.addLayer({
      id: "developable-assembled-line", type: "line", source: "developable-src",
      filter: ["in", ["get", "plot"], ["literal", []]],
      paint: { "line-color": "#f59f00", "line-width": 3, "line-opacity": 0.95 },
    });
    // Plot ids are indices into the REBUILT _plots array — any previous
    // selection now points at different geometry, so it must not survive.
    if (deep.assembly.ids.size) {
      deep.assembly.ids.clear();
      renderAssemblySummary("Selection cleared — plots were recomputed.");
    }
    syncAssemblyLayer();
  }

  for (const id of ["developable-fill", "developable-inner-fill", "developable-blockers"]) {
    if (map.getLayer(id)) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }
  updateDevelopableAttribution(true);
  renderDeepDiveLegend();
}

function removeDevelopableLayer() {
  for (const id of ["developable-fill", "developable-inner-fill", "developable-line",
                    "developable-selected", "developable-assembled",
                    "developable-assembled-line", "developable-blockers"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (deep.assembly.ids.size) {
    deep.assembly.ids.clear();
    renderAssemblySummary();
  }
  for (const id of ["developable-src", "developable-inner-src", "developable-blockers-src"]) {
    if (map.getSource(id)) map.removeSource(id);
  }
  deep._plots = null;
  updateDevelopableAttribution(false);
  renderDeepDiveLegend();
}

// ---- Per-plot analysis (click a green plot) --------------------------------
// The developable source carries one feature per contiguous plot. Clicking one
// highlights it and reports what that plot alone is worth: area, the soft
// designations covering it, the land parcels it spans, and its own dwelling
// capacity split by the inner/outer density regimes.

// Resolve a click on any developable layer to a plot id. The inner-ring fill
// is a single merged geometry with NO plot id, so the click is re-queried
// against developable-fill underneath. Shared by single-select and the
// assembler — the fallback must never be duplicated, it is too easy to forget.
function resolvePlotId(hit, point) {
  let plotId = hit && hit.properties ? hit.properties.plot : undefined;
  if (plotId == null) {
    try {
      const under = map.queryRenderedFeatures([point.x, point.y],
        { layers: ["developable-fill"] });
      if (under && under.length) plotId = under[0].properties.plot;
    } catch (_) {}
  }
  return plotId;
}

async function selectDevelopablePlot(hit, lngLat, point) {
  const plotId = resolvePlotId(hit, point);
  const plot = (deep._plots || []).find(f => f.properties.plot === plotId);
  if (!plot) { openClickPopup({ offset: 8 }, lngLat, developablePopupHTML("developable-fill")); return; }

  if (map.getLayer("developable-selected"))
    map.setFilter("developable-selected", ["==", ["get", "plot"], plotId]);

  const areaHa = plot.properties.area_ha != null ? plot.properties.area_ha
    : (window.turf ? turf.area(plot) / 10000 : 0);
  const innerHa = plot.properties.inner_ha || 0;
  const outerHa = Math.max(0, areaHa - innerHa);
  const regime = activeDevelopableRegime();
  const homes = homesFor(areaHa, innerHa, regime);

  // Land parcels the plot spans — counted from the rendered INSPIRE tiles, so
  // it needs the parcels layer on and z13+; say so rather than showing 0.
  let parcelTxt = null;
  try {
    if (map.getLayer("parcel-fill")) {
      const feats = map.queryRenderedFeatures({ layers: ["parcel-fill"] });
      let n = 0;
      for (const f of feats) {
        try {
          const c = turf.centroid(f);
          if (turf.booleanPointInPolygon(c, plot)) n++;
        } catch (_) {}
      }
      parcelTxt = `${n}${n >= 1 ? "" : ""} in view`;
    }
  } catch (_) {}

  const esc = _esc;
  const head = `<strong>Developable plot</strong><br>` +
    `<span style="font-size:11px">${areaHa.toFixed(2)} ha · ${(areaHa * 2.471).toFixed(2)} ac` +
    (innerHa > 0 ? ` · ${innerHa.toFixed(2)} ha within ${deep.developable.inner_radius_m} m` : "") +
    `</span><br><span style="font-size:11px">~<b>${homes.toLocaleString()}</b> homes at ${esc(regime)} density</span>` +
    (parcelTxt ? `<br><span style="font-size:11px">land parcels: ${esc(parcelTxt)}</span>` : "");
  const pop = openClickPopup({ offset: 8, maxWidth: "320px" }, lngLat,
    head + `<br><span style="font-size:11px;opacity:.7">checking designations…</span>`);

  // Soft constraints covering THIS plot, from the shared polygon_summary RPC.
  let softLine = "";
  try {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.rpc("polygon_summary",
        { p_geojson: JSON.stringify(plot.geometry) });
      if (!error && data && !data.error) {
        const cons = (data.constraints || []).filter(c => c.pct >= 1);
        softLine = cons.length
          ? `<br><span style="font-size:11px">designations: ` +
            cons.slice(0, 5).map(c => `${esc(c.kind.replace(/_/g, " "))} ${c.pct}%`).join(", ") +
            `</span>`
          : `<br><span style="font-size:11px">no designations cover this plot</span>`;
        if (data.grey_belt_pct)
          softLine += `<br><span style="font-size:11px">grey-belt candidate: ${data.grey_belt_pct}%</span>`;
      }
    }
  } catch (_) {}
  try { pop.setHTML(head + (softLine || "")); } catch (_) {}
}

// ---- Public land inside the catchment -------------------------------------
// Publicly-owned parcels (CCOD ownership points paired to INSPIRE parcel
// polygons — individual flats excluded upstream) clipped to the catchment
// circle. Indicative: the exact title->polygon link is HMLR's licensed
// National Polygon Service, so this is a postcode-centroid spatial join.

async function loadPublicLand() {
  deep.publicLand = null;
  const sb = getSupabase();
  const centre = deep.stationCentre;
  if (!sb || !centre) return null;
  const cfg = deep.developable || defaultDevelopableConfig();
  try {
    const { data, error } = await sb.rpc("public_land_in_catchment", {
      centre_lng: centre[0], centre_lat: centre[1],
      radius_m: cfg.radius_m, inner_radius_m: cfg.inner_radius_m,
    });
    if (error) throw error;
    deep.publicLand = (data && data[0]) || null;
  } catch (err) {
    console.error("public_land_in_catchment failed", err);
    deep._lastPublicLandError = err.message || "query failed";
    return null;
  }
  deep._lastPublicLandError = null;
  return deep.publicLand;
}

function renderPublicLandLayer() {
  removePublicLandLayer();
  const pl = deep.publicLand;
  const fc = pl && pl.parcels_geojson;
  if (!deep.publicLandVisible || !fc || !(fc.features || []).length) return;
  map.addSource("publicland-src", { type: "geojson", data: fc });
  // Disputed parcels stay on the map — they are still real leads — but must
  // never read as settled: a register point can land in a title far bigger than
  // the holding, and 43% of this layer's hectares sit on parcels whose size
  // contradicts the register. Faded fill + dashed edge says "provisional"
  // before anything is clicked, and they are excluded from every total.
  const DISPUTED = ["==", ["to-boolean", ["get", "disputed"]], true];
  map.addLayer({
    id: "publicland-fill", type: "fill", source: "publicland-src",
    paint: {
      "fill-color": PUBLIC_LAND_COLOR,
      "fill-opacity": ["case", DISPUTED, 0.14, 0.5],
    },
  });
  map.addLayer({
    id: "publicland-line", type: "line", source: "publicland-src",
    filter: ["!", DISPUTED],
    paint: { "line-color": PUBLIC_LAND_COLOR, "line-width": 1.6,
             "line-opacity": 0.95 },
  });
  // Separate layer because line-dasharray cannot be data-driven in MapLibre —
  // a "case" expression on it is silently ignored, which would have left the
  // disputed parcels looking solid.
  map.addLayer({
    id: "publicland-line-disputed", type: "line", source: "publicland-src",
    filter: DISPUTED,
    paint: { "line-color": PUBLIC_LAND_COLOR, "line-width": 1.3,
             "line-opacity": 0.85, "line-dasharray": [2, 2] },
  });
  map.on("mouseenter", "publicland-fill", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "publicland-fill", () => { map.getCanvas().style.cursor = ""; });
  renderDeepDiveLegend();
}

function removePublicLandLayer() {
  for (const id of ["publicland-fill", "publicland-line", "publicland-line-disputed"])
    if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("publicland-src")) map.removeSource("publicland-src");
}

// Popup for a tapped public parcel: who owns it, how much land, and the
// honest caveat about title counts at the postcode.
function publicLandPopupHTML(pr) {
  const ha = pr.clipped_ha != null ? Number(pr.clipped_ha) : null;
  const rows = [
    ["owner type", OWNER_CLASS_LABELS[pr.owner_class] || pr.owner_class || "Public body"],
    ["parcel area", ha != null ? `${ha.toFixed(2)} ha (${(ha * 2.471).toFixed(2)} ac)` : null],
    ["titles here", pr.titles_land != null
      ? `${pr.titles_land} land title${pr.titles_land == 1 ? "" : "s"}` +
        (pr.titles_flat ? ` · ${pr.titles_flat} flat${pr.titles_flat == 1 ? "" : "s"} excluded` : "")
      : null],
    ["asset register", pr.assets != null && pr.assets > 1
      ? `${pr.assets} holdings here` : null],
    ["register says", pr.stated_ha != null
      ? `${Number(pr.stated_ha).toFixed(2)} ha` +
        (pr.area_mismatch ? " ⚠ disagrees with the parcel" : "") : null],
    ["address", pr.address || null],
  ].filter(r => r[1]);
  return `<strong>${_esc(pr.owner || "Public land")}</strong>` +
    rows.map(([k, v]) => `<br><span style="font-size:11px">${_esc(k)}: ${_esc(String(v))}</span>`).join("") +
    `<br><span style="font-size:10px;opacity:.7">${parcelMatchHTML(pr)}</span>`;
}

// Flip the footer attribution flag and refresh the datasource note.
function updateDevelopableAttribution(on) {
  developableAttributionShown = !!on;
  if (document.getElementById("datasource")) updateDataSourceNote();
}

// Popup HTML when the user taps the developable / blocker polygon.
function developablePopupHTML(layerId) {
  if (layerId === "developable-blockers") {
    const labels = developableSubtractArray()
      .map(k => (DEVELOPABLE_SUBTRACT_KINDS.find(x => x.key === k) || {}).label || k);
    return `<strong>Constrained land</strong><br>` +
      `<span style="font-size:11px">Subtracted: ${labels.join(", ") || "none"}</span>`;
  }
  const r = deep.developableResult;
  if (!r) return `<strong>Developable land</strong>`;
  const dw = developableDwellings();
  const active = activeDevelopableRegime();
  const devHa = Number(r.developable_ha) || 0;
  const homes = dw ? dw[active] : 0;
  return `<strong>Developable land</strong><br>` +
    `${devHa.toFixed(1)} ha · ~${homes.toLocaleString()} homes (${active})`;
}

function setDevelopableStatus(text) {
  const el = document.getElementById("dd-developable-status");
  if (el) el.textContent = text;
}

function developableErrorText() {
  const e = deep._lastDevelopableError;
  if (e === "not_configured") return "DB not configured";
  if (e === "no_station") return "no station selected";
  return "query error — see console";
}

// Toggle the developable analysis on/off (loads on first enable).
async function toggleDevelopable(on) {
  deep.developableVisible = on;
  if (!on) { removeDevelopableLayer(); renderDevelopableSummary(); return; }
  setDevelopableStatus("loading…");
  const r = await loadDevelopable();
  if (r === null) {
    setDevelopableStatus(developableErrorText());
    deep.developableVisible = false;
    const cb = document.getElementById("dd-developable-show");
    if (cb) cb.checked = false;
    return;
  }
  renderDevelopableLayer();
  renderDevelopableSummary();
  setDevelopableStatus("");
}

// ---- Public land toggle, readout and the deep-dive legend ------------------

async function togglePublicLand(on) {
  deep.publicLandVisible = on;
  const stat = document.getElementById("dd-publicland-status");
  if (!on) {
    removePublicLandLayer();
    renderPublicLandSummary();
    renderDeepDiveLegend();
    if (stat) stat.textContent = "";
    return;
  }
  if (stat) stat.textContent = "loading…";
  const r = await loadPublicLand();
  if (r === null) {
    if (stat) stat.textContent = deep._lastPublicLandError ? "err" : "n/a";
    deep.publicLandVisible = false;
    const cb = document.getElementById("dd-publicland-show");
    if (cb) cb.checked = false;
    return;
  }
  if (stat) stat.textContent = "";
  renderPublicLandLayer();
  renderPublicLandSummary();
}

// Quantify the holding: hectares/acres, parcel count, how much sits in the
// high-density inner ring, and the split by owner type.
function renderPublicLandSummary() {
  const el = document.getElementById("dd-publicland-summary");
  if (!el) return;
  const pl = deep.publicLand;
  if (!deep.publicLandVisible || !pl) { el.innerHTML = ""; return; }
  // total_ha / n_parcels / by_owner are CONFIRMED-only (migration 0040);
  // disputed parcels are reported separately and never folded in.
  const ha = Number(pl.total_ha) || 0;
  const n = Number(pl.n_parcels) || 0;
  const nDisputed = Number(pl.n_disputed) || 0;
  const disputedHa = Number(pl.disputed_ha) || 0;
  if (!n) {
    // "None matched" would be a lie when the catchment holds only parcels we
    // set aside — the land is there, its boundary is what we do not trust.
    el.innerHTML = nDisputed > 0
      ? `<p class="hint" style="margin-top:6px">No parcel here has a boundary we ` +
        `trust. ${nDisputed} parcel${nDisputed === 1 ? " was" : "s were"} set aside ` +
        `(${disputedHa.toFixed(2)} ha, shown dashed): the owner's published locator ` +
        `landed in a title far larger than the holding it describes, so the area ` +
        `cannot be relied on.</p>`
      : `<p class="hint" style="margin-top:6px">No publicly-owned parcels matched inside this catchment.</p>`;
    return;
  }
  const byOwner = pl.by_owner || {};
  const rows = Object.entries(byOwner)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div class="dd-pl-row"><span>${_esc(OWNER_CLASS_LABELS[k] || k)}</span>` +
      `<span>${Number(v).toFixed(2)} ha</span></div>`).join("");
  // How the parcels were attributed, counted off the features themselves so
  // this needs no RPC change. A headline hectare figure that mixes a published
  // asset register with a postcode centroid rescued from 30 m away reads as one
  // number of equal quality, and it is not — so show the split.
  // Disputed parcels are counted for display but excluded from every total by
  // the RPC (migration 0040), so this only needs to say how many there are.
  const byMatch = {};
  for (const f of ((pl.parcels_geojson || {}).features || [])) {
    const pr = f.properties || {};
    if (pr.disputed) continue;      // shown separately, not mixed into the split
    byMatch[pr.match || "unknown"] = (byMatch[pr.match || "unknown"] || 0) + 1;
  }
  const matchRows = Object.entries(byMatch)
    .sort((a, b) => (PARCEL_MATCH[a[0]]?.rank ?? 9) - (PARCEL_MATCH[b[0]]?.rank ?? 9))
    .map(([k, v]) => {
      const m = PARCEL_MATCH[k];
      const c = m ? PARCEL_MATCH_TIER_COLOR[m.tier] : "#868e96";
      return `<div class="dd-pl-row"><span><span style="color:${c}">●</span> ` +
        `${_esc(m ? m.label : k)}</span><span>${v}</span></div>`;
    }).join("");
  const innerHa = Number(pl.inner_ha) || 0;
  // Rough capacity of the public holding at the active regime's rates.
  const dph = deep.developableDph || DPH_DEFAULTS;
  const regime = activeDevelopableRegime();
  const cap = homesFor(ha, innerHa, regime, dph);
  el.innerHTML =
    `<div class="dd-pl-hero"><strong>${ha.toFixed(2)} ha</strong> ` +
    `<span class="dd-dim">(${(ha * 2.471).toFixed(1)} ac) across ${n} parcel${n === 1 ? "" : "s"}</span></div>` +
    `<div class="dd-pl-rows">${rows}</div>` +
    (innerHa > 0 ? `<div class="dd-pl-row"><span>within ${deep.developable.inner_radius_m} m of the station</span><span>${innerHa.toFixed(2)} ha</span></div>` : "") +
    `<div class="dd-pl-row"><span>capacity at ${_esc(regime)} density</span><span>~${cap.toLocaleString()} homes</span></div>` +
    (matchRows ? `<div class="dd-pl-sub">how attributed</div>` +
                 `<div class="dd-pl-rows">${matchRows}</div>` : "") +
    // Set aside, not deleted. The disputed parcels are drawn faded and dashed
    // on the map and excluded from every figure above; saying so is the point,
    // because a total that silently shrank would be just as misleading as one
    // that was silently inflated.
    (nDisputed > 0
      ? `<div class="dd-pl-sub">set aside</div>` +
        `<div class="dd-pl-row" style="color:#c92a2a">` +
        `<span>⚠ ${nDisputed} parcel${nDisputed === 1 ? "" : "s"} whose size ` +
        `contradicts the register</span>` +
        `<span>${disputedHa.toFixed(2)} ha</span></div>` +
        `<p class="hint" style="margin-top:4px">Shown dashed and faded. Excluded ` +
        `from the totals and the capacity estimate above — the owner's locator ` +
        `is precise, but it landed in a title far larger than the holding it ` +
        `describes, so the boundary is not trustworthy.</p>`
      : "") +
    `<p class="hint" style="margin-top:6px">Indicative. Parcels marked as a published coordinate or UPRN come from the owner's own asset register; the rest are CCOD postcode centroids matched to INSPIRE parcels by location (individual flats excluded), which can stand for only one parcel per postcode. Verify title-by-title before relying on it.</p>`;
}

// Map legend for the deep dive — explains every colour currently painted.
// Rendered into #dd-legend at the base of the map; hidden when nothing that
// needs explaining is on.
function renderDeepDiveLegend() {
  let el = document.getElementById("dd-legend");
  const showDev = !!(deep.active && deep.developableVisible && deep.developableResult);
  // n_parcels counts CONFIRMED parcels only, so a catchment holding nothing but
  // set-aside parcels still draws them — the legend has to explain them.
  const showPub = !!(deep.active && deep.publicLandVisible && deep.publicLand
                     && (Number(deep.publicLand.n_parcels) > 0
                         || Number(deep.publicLand.n_disputed) > 0));
  const showDisputed = !!(deep.active && deep.publicLandVisible && deep.publicLand
                          && Number(deep.publicLand.n_disputed) > 0);
  if (!showDev && !showPub) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "dd-legend";
    (document.getElementById("app") || document.body).appendChild(el);
  }
  const dph = deep.developableDph || DPH_DEFAULTS;
  const inner = (deep.developable && deep.developable.inner_radius_m) || 200;
  const sw = (color, opacity) =>
    `<i class="ddl-sw" style="background:${color};opacity:${opacity}"></i>`;
  const items = [];
  if (showDev) {
    items.push(`<span class="ddl-item">${sw(DEVELOPABLE_INNER_COLOR, 0.85)}` +
      `Developable · inner ${inner} m <b>${dph.urbanInner} dph</b></span>`);
    items.push(`<span class="ddl-item">${sw(DEVELOPABLE_COLOR, 0.7)}` +
      `Developable · outer <b>${activeDevelopableRegime() === "urban" ? dph.urbanOuter : (dph[activeDevelopableRegime()] || dph.suburban)} dph</b></span>`);
    items.push(`<span class="ddl-item">${sw(DEVELOPABLE_BLOCKER_COLOR, 0.5)}Constrained (subtracted)</span>`);
  }
  if (showPub) {
    items.push(`<span class="ddl-item">${sw(PUBLIC_LAND_COLOR, 0.75)}Publicly owned land</span>`);
  }
  if (showDisputed) {
    items.push(`<span class="ddl-item"><i class="ddl-sw ddl-sw-dashed" ` +
      `style="border-color:${PUBLIC_LAND_COLOR}"></i>Boundary disputed — not counted</span>`);
  }
  el.innerHTML = `<div class="ddl-items">${items.join("")}</div>` +
    (showDev ? (deep.assembly.active
      ? `<div class="ddl-note ddl-assemble">■ Assemble mode — click plots to add or remove · ${deep.assembly.ids.size} selected</div>`
      : `<div class="ddl-note">Click any green plot for its own area, constraints and capacity.</div>`) : "");
  el.hidden = false;
}

// Re-run the RPC after a radius / subtract change (only while visible). Regime
// and dph changes do NOT hit this — they recompute client-side via the summary.
async function refreshDevelopable() {
  if (!deep.developableVisible) { renderDevelopableSummary(); return; }
  setDevelopableStatus("loading…");
  const r = await loadDevelopable();
  if (r === null) { setDevelopableStatus(developableErrorText()); return; }
  renderDevelopableLayer();
  renderDevelopableSummary();
  setDevelopableStatus("");
}

// Render the readout: catchment/developable hectares, % developable, the auto
// classification + density, and dwelling capacity under all three regimes with
// the active one highlighted.
function renderDevelopableSummary() {
  const el = document.getElementById("dd-developable-summary");
  const hero = document.getElementById("dd-developable-hero");
  if (!el) return;
  const r = deep.developableResult;
  if (!deep.developableVisible || !r) { el.innerHTML = ""; if (hero) hero.innerHTML = ""; return; }

  const catchHa = Number(r.catchment_ha) || 0;
  const devHa = Number(r.developable_ha) || 0;
  const innerHa = Number(r.inner_ha) || 0;
  const outerHa = Number(r.outer_ha) || 0;
  const pct = catchHa > 0 ? (devHa / catchHa) * 100 : 0;

  if (devHa <= 0) {
    if (hero) hero.innerHTML = `<div class="dd-dev-hero-num">0</div><div class="dd-dev-hero-lbl">no developable land for the current constraints</div>`;
    el.innerHTML = `<p class="hint" style="margin-top:8px">No developable land within this radius for the current constraints — try removing a constraint or widening the radius.</p>`;
    return;
  }

  const dw = developableDwellings() || { rural: 0, suburban: 0, urban: 0 };
  const active = activeDevelopableRegime();
  // Punchy hero: the headline dwelling capacity for the active regime + the two
  // supporting figures. This is the whole point of the tool, so it leads.
  if (hero) {
    const capName = active ? active.charAt(0).toUpperCase() + active.slice(1) : "—";
    hero.innerHTML =
      `<div class="dd-dev-hero-main">` +
        `<div class="dd-dev-hero-num">~${(dw[active] || 0).toLocaleString()}</div>` +
        `<div class="dd-dev-hero-lbl">potential dwellings · ${capName} density</div>` +
      `</div>` +
      `<div class="dd-dev-hero-side">` +
        `<div><b>${devHa.toFixed(1)}</b><span>ha developable</span></div>` +
        `<div><b>${pct.toFixed(0)}%</b><span>of catchment</span></div>` +
      `</div>`;
  }
  const density = deep.developableDensity;
  const autoClass = autoDevelopableRegime();
  const autoSrc = autoDevelopableRegimeSource();
  const densTxt = density == null ? "n/a" : `${Math.round(density).toLocaleString()} /km²`;
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
  const overriding = deep.developableRegime && deep.developableRegime !== "auto";
  // Prefer the ONS RUC label when we have it, else fall back to the density read.
  const classNote = autoClass
    ? `Auto-classified <strong>${cap(autoClass)}</strong>${autoSrc ? ` (${autoSrc}${deep.stationRucName ? `: ${deep.stationRucName}` : ""})` : ""} · density ${densTxt}`
    : `Density ${densTxt}`;

  const card = (key, label, val) => `
    <div class="dd-stat-cell dd-dev-cap ${key === active ? "dd-dev-cap-on" : ""}">
      <div class="dd-stat-num">${val.toLocaleString()}</div>
      <div class="dd-stat-cap">${label}${key === active ? " ✓" : ""}</div>
    </div>`;

  el.innerHTML = `
    <div class="dd-stats-grid" style="margin-top:8px">
      <div class="dd-stat-cell"><div class="dd-stat-num">${catchHa.toFixed(1)}</div><div class="dd-stat-cap">Catchment ha</div></div>
      <div class="dd-stat-cell"><div class="dd-stat-num">${devHa.toFixed(1)}</div><div class="dd-stat-cap">Developable ha</div></div>
      <div class="dd-stat-cell"><div class="dd-stat-num">${pct.toFixed(0)}%</div><div class="dd-stat-cap">of catchment</div></div>
    </div>
    <p class="hint" style="margin:8px 0 4px">
      ${classNote}${overriding ? ` · using <strong>${cap(active)}</strong> (override)` : ""}.
      Inner ${innerHa.toFixed(1)} ha / outer ${outerHa.toFixed(1)} ha.
    </p>
    <div class="dd-stats-grid dd-dev-caps">
      ${card("rural", "Rural", dw.rural)}
      ${card("suburban", "Suburban", dw.suburban)}
      ${card("urban", "Urban", dw.urban)}
    </div>
    <p class="hint" style="margin-top:6px">Potential dwellings by density regime (✓ = selected). Urban applies ${deep.developableDph.urbanInner} dph within ${deep.developable.inner_radius_m} m of the station and ${deep.developableDph.urbanOuter} dph beyond.</p>
    ${developableConstraintsHTML(r)}`;
  renderDeepDiveViability();
}

// Deep-dive residual appraisal: the developable capacity priced by the SAME
// engine the sifter uses, with the catchment's own £/m² and, once fetched, the
// locality's build-cost factor (point_summary at the station centre now
// returns the containing build_cost_index polygon — migration 0047). Owned-div
// pattern: this function is the only writer of #dd-viability-summary.
async function renderDeepDiveViability() {
  const el = document.getElementById("dd-viability-summary");
  if (!el) return;
  const r = deep.developableResult;
  if (!deep.developableVisible || !r) {
    el.innerHTML = `<p class="hint">Turn on the developable-land tool above — the appraisal prices its dwelling capacity.</p>`;
    return;
  }
  // Locality build-cost factor, income and MHCLG land value, fetched once per
  // dive and cached. NOTE the explicit client: this block previously used a
  // bare `sb` that was never in scope, the ReferenceError vanished into the
  // catch, and every dive quietly fell back to "1.00× (national)".
  if (deep._marketCtx === undefined && deep.stationCentre) {
    deep._marketCtx = null;   // in flight — a re-render must not refetch
    const sbc = (typeof getSupabase === "function") ? getSupabase() : null;
    try {
      if (!sbc) throw new Error("not configured");
      const { data } = await sbc.rpc("point_summary",
        { p_lon: deep.stationCentre[0], p_lat: deep.stationCentre[1] });
      const areas = (data && data.areas) || {};
      deep._marketCtx = {
        factor: Number(areas.build_cost_index?.factor) || null,
        factorRegion: areas.build_cost_index?.region || null,
        income: Number((areas.msoa_income || areas.lad_income || {}).income_median) || null,
        landValueHa: Number(areas.land_value?.resi_gbp_ha) || null,
      };
    } catch (_) { deep._marketCtx = null; }
    if (!document.getElementById("dd-viability-summary")) return;
  }
  const regime = activeDevelopableRegime();
  const units = homesFor(Number(r.developable_ha) || 0, Number(r.inner_ha) || 0, regime);
  const mc = deep._marketCtx || null;
  const ap = computeAppraisal({
    units, ppm2: deep.ppm2 || null, region: deep.stationRegion || null,
    areaHa: Number(r.developable_ha) || null,
    locationFactor: (mc && mc.factor) || null,
    landValueHa: (mc && mc.landValueHa) || null,
  }, SIFT.assumptions, { noSens: true });
  if (ap.profitOnCost == null) {
    el.innerHTML = `<p class="hint">No dwelling capacity to appraise yet.</p>`;
    return;
  }
  const money = v => v == null ? "—"
    : (Math.abs(v) >= 1e6 ? "£" + (v / 1e6).toFixed(1) + "M" : "£" + Math.round(v / 1000) + "k");
  const ragCls = ap.rag === "viable" ? "sg" : ap.rag === "marginal" ? "sa" : "sr";
  el.innerHTML = `
    <div class="dd-pl-hero"><strong>${ap.profitOnCost.toFixed(1)}%</strong>
      <span class="dd-dim">profit on cost · ${units.toLocaleString()} homes (${regime})</span>
      <span class="viab-rag ${ragCls}">${ap.rag}</span></div>
    <div class="dd-pl-rows">
      <div class="dd-pl-row"><span>GDV</span><span>${money(ap.gdv)}</span></div>
      <div class="dd-pl-row"><span>total cost incl. finance</span><span>${money(ap.totalCost)}</span></div>
      <div class="dd-pl-row"><span>residual land value</span><span>${money(ap.residualLandValue)}</span></div>
      <div class="dd-pl-row"><span>RLV ÷ benchmark land</span><span>${ap.rlvVsBlv == null ? "n/a" : ap.rlvVsBlv.toFixed(2) + "×"}</span></div>
      <div class="dd-pl-row"><span>land basis</span><span>${ap.landBasisUsed === "mhclg" ? "MHCLG £/ha (published)" : ap.landScale == null ? "—" : "×" + ap.landScale.toFixed(2) + " (value-linked)"}</span></div>
      <div class="dd-pl-row"><span>peak debt</span><span>${money(ap.peakDebt)}</span></div>
      <div class="dd-pl-row"><span>sales value basis</span><span>${ap.local ? `local £${Math.round((deep.ppm2 || 0)).toLocaleString()}/m²` : "regional fallback"}</span></div>
      <div class="dd-pl-row"><span>build cost index</span><span>${mc && mc.factor ? mc.factor.toFixed(2) + "× (" + (mc.factorRegion || "local") + ")" : "1.00× (national)"}</span></div>
    </div>
    <p class="hint" style="margin-top:4px">Same engine and assumptions as the station sifter — tweak them below and both update.</p>`;
}

// ---- Land assembler --------------------------------------------------------
// Multi-select developable plots into one site, appraise the whole, and export
// a structured site report. Selection ids index deep._plots and are cleared
// whenever the plots are recomputed (radius/constraint change) — a stale id
// would silently point at different geometry.

function syncAssemblyLayer() {
  const ids = [...deep.assembly.ids];
  for (const id of ["developable-assembled", "developable-assembled-line"])
    if (map.getLayer(id))
      map.setFilter(id, ["in", ["get", "plot"], ["literal", ids]]);
}

function setAssembleMode(on) {
  deep.assembly.active = !!on;
  const btn = document.getElementById("dd-assemble-toggle");
  if (btn) {
    btn.classList.toggle("active", deep.assembly.active);
    btn.textContent = deep.assembly.active
      ? "■ Assembling — click plots to add/remove" : "▶ Assemble a site";
  }
  // Leaving assemble mode keeps the selection: the user toggles off to pan
  // and inspect, then comes back. [Clear] is the explicit reset.
  renderDeepDiveLegend();
  renderAssemblySummary();
}

function toggleAssemblyPlot(hit, point) {
  const plotId = resolvePlotId(hit, point);
  if (plotId == null) return;
  if (deep.assembly.ids.has(plotId)) deep.assembly.ids.delete(plotId);
  else deep.assembly.ids.add(plotId);
  syncAssemblyLayer();
  renderAssemblySummary();
}

function assemblyPlots() {
  return [...deep.assembly.ids]
    .map(id => (deep._plots || []).find(f => f.properties.plot === id))
    .filter(Boolean);
}

// Owned-div render of the basket (#dd-assembly-summary).
function renderAssemblySummary(notice) {
  const el = document.getElementById("dd-assembly-summary");
  if (!el) return;
  const plots = assemblyPlots();
  const regime = activeDevelopableRegime();
  if (!plots.length) {
    el.innerHTML = `<p class="hint">${notice ? escapeSift(notice) + " " : ""}` +
      (deep.assembly.active
        ? "Click green plots on the map to add them to the site."
        : "Press Assemble, then click plots to group them into one site.") + `</p>`;
    return;
  }
  const totHa = plots.reduce((s, p) => s + (p.properties.area_ha || 0), 0);
  const totInner = plots.reduce((s, p) => s + (p.properties.inner_ha || 0), 0);
  const units = homesFor(totHa, totInner, regime);
  const ap = computeAppraisal({
    units, ppm2: deep.ppm2 || null, region: null, areaHa: totHa,
    locationFactor: (deep._marketCtx && deep._marketCtx.factor) || null,
    landValueHa: (deep._marketCtx && deep._marketCtx.landValueHa) || null,
  }, SIFT.assumptions, { noSens: true });
  const rows = plots.map(p => `
    <div class="dd-pl-row"><span>Plot ${p.properties.plot + 1} · ${(p.properties.area_ha || 0).toFixed(2)} ha</span>
      <span>${homesFor(p.properties.area_ha, p.properties.inner_ha, regime).toLocaleString()} homes
      <button type="button" class="asm-remove" data-plot="${p.properties.plot}" title="Remove">×</button></span></div>`).join("");
  const ragCls = ap.rag === "viable" ? "sg" : ap.rag === "marginal" ? "sa" : "sr";
  el.innerHTML = `
    ${notice ? `<p class="hint">${escapeSift(notice)}</p>` : ""}
    <div class="dd-pl-rows">${rows}</div>
    <div class="dd-pl-hero" style="margin-top:6px"><strong>${totHa.toFixed(2)} ha</strong>
      <span class="dd-dim">${plots.length} plot${plots.length === 1 ? "" : "s"} · ~${units.toLocaleString()} homes (${regime})</span>
      ${ap.profitOnCost != null ? `<span class="viab-rag ${ragCls}">${ap.profitOnCost.toFixed(0)}% PoC</span>` : ""}</div>
    <input type="text" id="dd-assembly-name" placeholder="Site name for the report…"
      value="${escapeSift(deep.assembly.name || "")}" maxlength="80" />
    <div class="asm-actions">
      <button type="button" id="dd-assembly-report" class="plot-mode-btn">Generate site report</button>
      <button type="button" class="ghost" id="dd-assembly-clear">Clear</button>
    </div>`;
  el.querySelectorAll(".asm-remove").forEach(b => b.addEventListener("click", () => {
    deep.assembly.ids.delete(+b.dataset.plot);
    syncAssemblyLayer();
    renderAssemblySummary();
  }));
  const nameInp = el.querySelector("#dd-assembly-name");
  if (nameInp) nameInp.addEventListener("input", () => { deep.assembly.name = nameInp.value; });
  el.querySelector("#dd-assembly-clear")?.addEventListener("click", () => {
    deep.assembly.ids.clear();
    syncAssemblyLayer();
    renderAssemblySummary();
  });
  el.querySelector("#dd-assembly-report")?.addEventListener("click", generateSiteReport);
}

// Gate-3 read-out for the developable summary: the hard designations are already
// erased from `devHa` above; here we report residual soft-constraint friction (a
// 0–1 weighted coverage of the developable land) and the Green Belt overlap
// (permitted for Tier-B out-of-settlement schemes, a soft constraint for Tier A).
function developableConstraintsHTML(r) {
  if (!r) return "";
  const fr = r.friction == null ? null : Number(r.friction);
  const gb = Number(r.green_belt_ha) || 0;
  const soft = r.soft_cover || {};
  const SOFT_LABELS = {
    conservation_area: "Conservation area", aonb: "AONB / National Landscape",
    park_garden: "Registered park/garden", listed_building: "Listed-building setting",
  };
  const parts = Object.keys(soft)
    .filter(k => Number(soft[k]) > 0)
    .sort((a, b) => Number(soft[b]) - Number(soft[a]))
    .map(k => `${SOFT_LABELS[k] || k} ${(Number(soft[k]) * 100).toFixed(0)}%`);
  if (fr == null && gb <= 0 && !parts.length) return "";
  const rag = fr == null ? "" : fr < 0.15 ? "dd-fric-low" : fr < 0.4 ? "dd-fric-mid" : "dd-fric-high";
  return `
    <div class="dd-fric ${rag}" style="margin-top:8px">
      <span class="dd-fric-h">NPPF soft constraints</span>
      <span class="dd-fric-val">${fr == null ? "n/a" : "friction " + fr.toFixed(2)}</span>
      ${gb > 0 ? `<span class="dd-fric-gb" title="Developable land within Green Belt">⬡ ${gb.toFixed(1)} ha Green Belt</span>` : ""}
    </div>
    ${parts.length ? `<p class="hint" style="margin-top:4px">Covering the developable land: ${parts.join(" · ")}.</p>` : `<p class="hint" style="margin-top:4px">No soft designations overlap the developable land.</p>`}`;
}

// The developable section markup, built once per station deep dive. Reads the
// (freshly reset) config for default control values.
function developableSectionHTML(station) {
  const cfg = deep.developable || defaultDevelopableConfig();
  const dph = deep.developableDph || DPH_DEFAULTS;
  const wc = station && station.well_connected;
  const badge = wc
    ? `<span class="dd-nppf dd-nppf-yes">✓ NPPF-qualifying station</span>`
    : `<span class="dd-nppf dd-nppf-no">Not NPPF-qualifying</span>`;
  const ttwaBits = [];
  if (station && station.ttwa_name) ttwaBits.push(station.ttwa_name);
  if (station && station.ttwa_gva_rank != null) ttwaBits.push(`GVA rank #${station.ttwa_gva_rank}`);
  ttwaBits.push(station && station.meets_frequency ? "meets frequency" : "below frequency");
  const nppfNote = `<p class="hint" style="margin:2px 0 8px">${badge} <span style="opacity:0.8">${ttwaBits.join(" · ")}</span></p>`;

  const subs = DEVELOPABLE_SUBTRACT_KINDS.map(k => `
    <label class="dd-bf-check"><input type="checkbox" class="dd-dev-sub" data-kind="${k.key}" ${cfg.subtract[k.key] ? "checked" : ""} /> ${k.label}</label>`).join("");

  return `
      <section class="dd-block dd-hero" data-section="developable">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">◆ Developable land &amp; capacity</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div id="dd-developable-hero" class="dd-dev-hero"></div>
          ${nppfNote}
          <label class="dd-row dd-row-all">
            <input type="checkbox" class="enable" id="dd-developable-show" />
            <span class="dd-label"><strong>Analyse developable land</strong></span>
            <span class="dd-stat" id="dd-developable-status"></span>
          </label>
          <div class="dd-bf-filters">
            <label class="dd-bf-filter">
              <span>Radius (m)</span>
              <input type="number" id="dd-developable-radius" min="100" max="5000" step="50" value="${cfg.radius_m}" />
            </label>
            <label class="dd-bf-filter">
              <span>Regime</span>
              <select id="dd-developable-regime">
                <option value="auto">Auto (by density)</option>
                <option value="rural">Rural</option>
                <option value="suburban">Suburban</option>
                <option value="urban">Urban</option>
              </select>
            </label>
          </div>
          <div class="dd-dev-subtract">
            <span class="dd-dev-sub-label">Subtract constraints</span>
            <div class="dd-dev-checks">${subs}</div>
          </div>
          <div class="dd-bf-filters">
            <label class="dd-bf-filter" title="Ignore developable plots smaller than this. Filters out the awkward little green fragments that can't realistically be developed at scale. 0 = keep every plot.">
              <span>Min plot (acres)</span>
              <input type="number" id="dd-developable-minplot" min="0" max="50" step="0.25" value="${cfg.minPlotAc}" />
            </label>
            <label class="dd-bf-filter" title="Drop land narrower than this, wherever it occurs — the thin ribbons left beside a railway or between a road and a boundary. An area filter can't catch them: a 4 m x 300 m strip is a third of an acre but you can't build on it. 0 = no width test.">
              <span>Min width (m)</span>
              <input type="number" id="dd-developable-minwidth" min="0" max="100" step="1" value="${cfg.minWidthM}" />
            </label>
            <label class="dd-bf-check" title="Keep only the single largest contiguous developable plot in the catchment (ignores the scatter of smaller parcels).">
              <input type="checkbox" id="dd-developable-largest" ${cfg.largestOnly ? "checked" : ""} /> Largest plot only
            </label>
          </div>
          <div class="dd-bf-filters dd-dev-dph">
            <label class="dd-bf-filter"><span>Rural dph</span><input type="number" id="dd-dph-rural" min="1" max="1000" value="${dph.rural}" /></label>
            <label class="dd-bf-filter"><span>Suburban dph</span><input type="number" id="dd-dph-suburban" min="1" max="1000" value="${dph.suburban}" /></label>
            <label class="dd-bf-filter"><span>Urban outer dph</span><input type="number" id="dd-dph-urban-outer" min="1" max="1000" value="${dph.urbanOuter}" /></label>
            <label class="dd-bf-filter"><span>Urban inner dph</span><input type="number" id="dd-dph-urban-inner" min="1" max="1000" value="${dph.urbanInner}" /></label>
          </div>
          <div id="dd-developable-summary"></div>
          <label class="dd-row dd-row-all">
            <input type="checkbox" class="enable" id="dd-publicland-show" />
            <span class="dd-label"><strong>Public land in catchment</strong></span>
            <span class="dd-stat" id="dd-publicland-status"></span>
          </label>
          <div id="dd-publicland-summary"></div>
          <p class="hint" style="margin-top:8px">Developable land = the radius catchment minus the selected physical/planning constraints (OS &amp; Environment Agency data). Capacity applies dwellings-per-hectare by regime; the highlighted regime is auto-selected from catchment density. Constraints re-query the database; regime &amp; dph recompute instantly.</p>
        </div>
      </section>`;
}

// Wire the developable controls after the panel HTML exists. No-ops if the
// section isn't present (non-station dives).
function wireDevelopableControls(panel) {
  if (!panel.querySelector('[data-section="developable"]')) return;

  const show = panel.querySelector("#dd-developable-show");
  if (show) show.addEventListener("change", (e) => toggleDevelopable(e.target.checked));

  const pub = panel.querySelector("#dd-publicland-show");
  if (pub) pub.addEventListener("change", (e) => togglePublicLand(e.target.checked));

  const radius = panel.querySelector("#dd-developable-radius");
  if (radius) radius.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v > 0) deep.developable.radius_m = v;
    refreshDevelopable();
  });

  panel.querySelectorAll(".dd-dev-sub").forEach(cb => {
    cb.addEventListener("change", (e) => {
      deep.developable.subtract[e.target.dataset.kind] = e.target.checked;
      refreshDevelopable();
    });
  });

  const minPlot = panel.querySelector("#dd-developable-minplot");
  if (minPlot) minPlot.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    deep.developable.minPlotAc = (isNaN(v) || v < 0) ? 0 : v;
    refreshDevelopable();
  });

  const minWidth = panel.querySelector("#dd-developable-minwidth");
  if (minWidth) minWidth.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    deep.developable.minWidthM = (isNaN(v) || v < 0) ? 0 : v;
    refreshDevelopable();
  });

  const largest = panel.querySelector("#dd-developable-largest");
  if (largest) largest.addEventListener("change", (e) => {
    deep.developable.largestOnly = e.target.checked;
    refreshDevelopable();
  });

  const regime = panel.querySelector("#dd-developable-regime");
  if (regime) regime.addEventListener("change", (e) => {
    deep.developableRegime = e.target.value;
    renderDevelopableSummary();   // client-side only, no RPC
  });

  const dphMap = {
    "dd-dph-rural": "rural", "dd-dph-suburban": "suburban",
    "dd-dph-urban-outer": "urbanOuter", "dd-dph-urban-inner": "urbanInner",
  };
  for (const [id, key] of Object.entries(dphMap)) {
    const inp = panel.querySelector("#" + id);
    if (inp) inp.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) deep.developableDph[key] = v;
      renderDevelopableSummary();   // client-side only, no RPC
    });
  }
}

async function toggleAmenityKind(kind, on) {
  if (on) {
    deep.enabledKinds.add(kind);
    updateDeepStat(kind, "loading…");
    const n = await loadAmenityKind(kind);
    if (n === null) {
      const meta = AMENITY_KINDS.find(a => a.kind === kind);
      let msg;
      if (meta && meta.source === "osm") msg = "couldn't load";
      else if (deep._lastAmenityError === "not_configured") msg = "DB not configured";
      else msg = "query error — see console";
      updateDeepStat(kind, msg);
      deep.enabledKinds.delete(kind);
      const cb = document.getElementById(`dd-${kind}`);
      if (cb) cb.checked = false;
      return;
    }
    await renderAmenityLayer(kind);
    deep.counts[kind] = n;
    updateDeepStat(kind, formatAmenityStat(kind, n));
  } else {
    deep.enabledKinds.delete(kind);
    removeAmenityLayer(kind);
    delete deep.counts[kind];
    updateDeepStat(kind, "");
  }
}

// Build the per-amenity stat string: raw count plus, when population is known,
// a density per 1,000 residents (the more comparable figure across catchments
// of different sizes). Bus stops use a coarser denominator implicitly via the
// same formula; the per-1,000 figure is still meaningful.
function formatAmenityStat(kind, n) {
  if (n == null) return "";
  const d = per1000(n, deep.population);
  if (d == null) return `${n} in catchment`;
  // Show more precision for small rates so "0.4 / 1k" doesn't round to 0.
  const dStr = d >= 10 ? d.toFixed(0) : d >= 1 ? d.toFixed(1) : d.toFixed(2);
  return `${n} · ${dStr} / 1k`;
}

// Re-render every loaded amenity's stat (used once population becomes known, so
// counts that loaded before the population estimate gain their density figure).
function refreshAmenityDensities() {
  for (const kind of Object.keys(deep.counts)) {
    updateDeepStat(kind, formatAmenityStat(kind, deep.counts[kind]));
  }
}

function updateDeepStat(kind, text) {
  const el = document.getElementById(`dd-stat-${kind}`);
  if (el) el.textContent = text;
}

// ---- Crime (data.police.uk) ----------------------------------------------
// The police API takes our catchment polygon directly and returns street-level
// crimes inside it for a given month — no API key, no storage needed. We plot
// the points and summarise counts by category in the panel.
const CRIME_COLOR = "#b5179e";

// Turn the catchment polygon into the API's "lat,lng:lat,lng:..." poly format.
// The API wants lat,lng pairs; our GeoJSON is [lng,lat]. We use the outer ring
// and, if it's very detailed, thin it (the API rejects over-long polygons).
function catchmentToPolyParam() {
  let ring;
  const g = deep.catchment.geometry;
  if (g.type === "Polygon") ring = g.coordinates[0];
  else if (g.type === "MultiPolygon") ring = g.coordinates[0][0];
  else return null;

  // The API limits URL length / vertex count; simplify to ~30 points if needed.
  let pts = ring;
  if (pts.length > 32 && window.turf) {
    try {
      const simp = turf.simplify(
        { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } },
        { tolerance: 0.0008, highQuality: false }
      );
      const sg = simp.geometry;
      pts = sg.type === "Polygon" ? sg.coordinates[0] : pts;
    } catch (_) { /* fall through with original ring */ }
  }
  // Still too many? Sample evenly.
  if (pts.length > 60) {
    const step = Math.ceil(pts.length / 60);
    pts = pts.filter((_, i) => i % step === 0);
  }
  return pts.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(":");
}

// The police API publishes data a couple of months behind; get the list of
// available months (most recent first), so we can pull the last 12.
async function crimeMonths() {
  try {
    const r = await fetch("https://data.police.uk/api/crimes-street-dates");
    if (!r.ok) return [];
    const arr = await r.json();
    return arr.map(d => d.date);   // ["2025-12","2025-11",...]
  } catch (_) { return []; }
}

async function fetchCrimesForMonth(poly, month) {
  const form = new URLSearchParams();
  form.set("poly", poly);
  form.set("date", month);
  const r = await fetch("https://data.police.uk/api/crimes-street/all-crime", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (r.status === 503) return { tooMany: true, crimes: [] };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { tooMany: false, crimes: await r.json() };
}

async function loadCrime() {
  const body = document.getElementById("dd-crime-body");
  const periodEl = document.getElementById("dd-crime-period");
  if (!body) return;

  const poly = catchmentToPolyParam();
  if (!poly) { body.innerHTML = `<p class="hint">Couldn't read the catchment shape.</p>`; return; }

  const months = (await crimeMonths()).slice(0, 12);   // last 12 available
  if (!months.length) {
    body.innerHTML = `<p class="hint">Couldn't reach the police data service.</p>
      <button class="dd-load-btn" id="dd-crime-load" type="button">Try again</button>`;
    body.querySelector("#dd-crime-load")?.addEventListener("click", loadCrime);
    return;
  }

  // Fetch each month in turn, showing progress. Sequential (not parallel) to be
  // gentle on the free API and avoid rate limits.
  const all = [];
  let tooManyHit = false;
  for (let i = 0; i < months.length; i++) {
    body.innerHTML = `<p class="hint">Loading crime data… month ${i + 1} of ${months.length}</p>`;
    try {
      const res = await fetchCrimesForMonth(poly, months[i]);
      if (res.tooMany) { tooManyHit = true; break; }
      for (const c of res.crimes) { c._month = months[i]; all.push(c); }
    } catch (e) {
      // One bad month shouldn't kill the lot; note it and continue.
      console.warn("crime month failed", months[i], e);
    }
  }

  if (tooManyHit) {
    body.innerHTML =
      `<p class="hint">This area has too many crimes for the police API to
       return (their per-request limit is 10,000). That happens in dense
       city-centre LSOAs over a 12-month span. Try a smaller area.</p>`;
    return;
  }
  if (!all.length) {
    body.innerHTML = `<p class="hint">No recorded street-level crimes here in the last ${months.length} months.</p>`;
    removeCrimeLayer();
    return;
  }

  // Period label: "Jan 2025 – Dec 2025".
  if (periodEl) {
    const fmt = (mm) => {
      const [y, m] = mm.split("-");
      return new Date(`${y}-${m}-01`).toLocaleString("en-GB", { month: "short", year: "numeric" });
    };
    const oldest = months[months.length - 1], newest = months[0];
    periodEl.textContent = `· ${fmt(oldest)} – ${fmt(newest)}`;
  }

  deep.crimeData = all;
  renderCrimeLayer(all);
  renderCrimeStats(all, body, months.length);
}

// The police anonymise locations to a master list of "snap points" — many
// crimes collapse onto the same coordinate (e.g. a street centre covering 8+
// addresses). So a dozen visible points can represent hundreds of crimes. We
// therefore AGGREGATE by location and carry a `count` (and a category
// breakdown) on each point, then size dots and weight the heatmap by it.
function crimeFeatureCollection(crimes) {
  const byLoc = new Map();
  for (const c of crimes) {
    if (!c.location || !c.location.longitude || !c.location.latitude) continue;
    const lng = parseFloat(c.location.longitude);
    const lat = parseFloat(c.location.latitude);
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    let e = byLoc.get(key);
    if (!e) {
      e = { lng, lat, count: 0, street: c.location.street ? c.location.street.name : "", cats: {} };
      byLoc.set(key, e);
    }
    e.count++;
    const cat = (c.category || "other").replace(/-/g, " ");
    e.cats[cat] = (e.cats[cat] || 0) + 1;
  }

  const features = [];
  for (const e of byLoc.values()) {
    // Top category at this location, for the popup.
    const top = Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lng, e.lat] },
      properties: {
        count: e.count,
        street: e.street,
        topCat: top ? top[0] : "",
        // Compact breakdown string for the popup (e.g. "violent crime 12, ...").
        breakdown: Object.entries(e.cats)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`).join(", "),
      },
    });
  }
  return { type: "FeatureCollection", features, _maxCount: Math.max(1, ...[...byLoc.values()].map(e => e.count)) };
}

function renderCrimeLayer(crimes) {
  const fc = crimeFeatureCollection(crimes);
  const maxCount = fc._maxCount;

  if (map.getSource("crime")) {
    map.getSource("crime").setData(fc);
  } else {
    map.addSource("crime", { type: "geojson", data: fc });

    // Heatmap weighted by each point's crime count, so stacked snap points read
    // as hot even though they're few in number.
    map.addLayer({
      id: "crime-heat", type: "heatmap", source: "crime",
      layout: { visibility: deep.crimeView === "heat" ? "visible" : "none" },
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["sqrt", ["get", "count"]],
          0, 0, Math.sqrt(maxCount), 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 3.5],
        // Wider radius so the relatively few snap points blend into a surface
        // rather than reading as separate blobs (snap-point data is sparse).
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 30, 14, 55, 16, 70],
        "heatmap-opacity": 0.8,
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(0,0,0,0)",
          0.2, "rgba(69,10,80,0.5)",
          0.4, "#7b2382",
          0.6, "#b5179e",
          0.8, "#e0479e",
          1, "#ffd0e8",
        ],
      },
    });

    // Dots sized so the CIRCLE AREA is proportional to the crime count — the
    // correct way to scale proportional symbols (a count of 40 should look ~8x
    // the area of a count of 5, i.e. ~2.8x the radius, NOT 8x). We map
    // sqrt(count) linearly to radius. Using sqrt(maxCount) as the top stop keeps
    // the spread sensible regardless of the busiest point.
    const rMax = 30, rMin = 7;
    const sqrtMax = Math.sqrt(maxCount);
    const radiusExpr = maxCount <= 1
      ? rMin
      : ["interpolate", ["linear"], ["sqrt", ["get", "count"]],
         1, rMin, sqrtMax, rMax];
    map.addLayer({
      id: "crime-dot", type: "circle", source: "crime",
      layout: { visibility: deep.crimeView === "heat" ? "none" : "visible" },
      paint: {
        "circle-radius": radiusExpr,
        "circle-color": CRIME_COLOR,
        "circle-opacity": 0.55,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
      },
    });
    // Count label on each dot. Keep text size nearly constant (readability)
    // with only a slight bump for the biggest dots.
    map.addLayer({
      id: "crime-count", type: "symbol", source: "crime",
      layout: {
        visibility: deep.crimeView === "heat" ? "none" : "visible",
        "text-field": ["to-string", ["get", "count"]],
        "text-size": maxCount <= 1
          ? 11
          : ["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 10, sqrtMax, 14],
        "text-font": ["Noto Sans Regular"],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#fff",
        "text-halo-color": CRIME_COLOR,
        "text-halo-width": 1.2,
      },
    });

    // (Crime taps handled by the unified handleMapTap dispatcher — touch + desktop.)
  }
}

// Switch between "points" and "heat" views without refetching.
function setCrimeView(view) {
  deep.crimeView = view;
  const showDots = view !== "heat";
  for (const id of ["crime-dot", "crime-count"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility",
      (showDots && deep.crimeVisible) ? "visible" : "none");
  }
  if (map.getLayer("crime-heat"))
    map.setLayoutProperty("crime-heat", "visibility",
      (view === "heat" && deep.crimeVisible) ? "visible" : "none");
  document.querySelectorAll(".dd-crime-toggle button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
}

// Show/hide all crime layers (the on/off toggle in the section header). Keeps
// the data loaded so flipping it back is instant.
function setCrimeVisible(visible) {
  deep.crimeVisible = visible;
  // Re-apply view, which respects deep.crimeVisible for each layer.
  setCrimeView(deep.crimeView);
}

function removeCrimeLayer() {
  for (const id of ["crime-dot", "crime-count", "crime-heat"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("crime")) map.removeSource("crime");
}

function renderCrimeStats(crimes, body, monthCount) {
  const total = crimes.length;
  if (!total) {
    body.innerHTML = `<p class="hint">No recorded street-level crimes in this area.</p>`;
    return;
  }
  // Count by category, sort desc.
  const counts = {};
  for (const c of crimes) {
    const cat = (c.category || "other").replace(/-/g, " ");
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];

  const rows = sorted.map(([cat, n]) => `
    <div class="dd-crime-row">
      <span class="dd-crime-cat">${cat}</span>
      <span class="dd-crime-bar"><span style="width:${(n / max * 100).toFixed(0)}%"></span></span>
      <span class="dd-crime-n">${n}</span>
    </div>`).join("");

  const perMonth = monthCount ? (total / monthCount).toFixed(0) : null;

  body.innerHTML = `
    <div class="dd-crime-toggle" role="group" aria-label="Crime map style">
      <button type="button" data-view="points" class="${deep.crimeView === "heat" ? "" : "active"}">Points</button>
      <button type="button" data-view="heat" class="${deep.crimeView === "heat" ? "active" : ""}">Heatmap</button>
    </div>
    <div class="dd-crime-total">
      <strong>${total}</strong> crimes over ${monthCount} months
      ${perMonth ? `<span class="dd-crime-avg">≈ ${perMonth}/month</span>` : ""}
    </div>
    <div class="dd-crime-list">${rows}</div>
    <p class="hint" style="margin-top:8px">Street-level crimes from data.police.uk, snapped to approximate locations. Leaving the deep dive clears these.</p>`;

  body.querySelectorAll(".dd-crime-toggle button").forEach(b =>
    b.addEventListener("click", () => setCrimeView(b.dataset.view)));

  // Reveal the show/hide toggle in the section header now data exists.
  const showWrap = document.getElementById("dd-crime-show-wrap");
  if (showWrap) showWrap.hidden = false;
  const showCb = document.getElementById("dd-crime-show");
  if (showCb) showCb.checked = deep.crimeVisible;
}

// The station section for a station profile: the "usage" signal of the
// need/supply/usage triad (need = deprivation block; supply = brownfield, added
// in Workstream 2). Deliberately kept as its own visible signal rather than
// folded into a single score.
// Render the station synthesis block: a one-line headline that ties the three
// signals together, the need/supply/usage triad, a modelled population-uplift
// line, and pin/compare controls. Called once the supply summary has loaded.
function renderStationSynthesis() {
  const el = document.getElementById("dd-synthesis");
  if (!el || !deep.station) return;
  const snap = buildStationSnapshot();
  if (!snap) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="dd-eyebrow" style="margin-bottom:6px">Official supply</div>
    <p class="syn-headline">${synthesisSentence(snap)}</p>
    ${triadHTML(snap)}
    ${snap.households != null ? `
      <p class="syn-uplift">This catchment has ~<strong>${snap.households.toLocaleString()}</strong> existing homes.
        ${snap.supplyHomes ? `Brownfield capacity (~${snap.supplyHomes.toLocaleString()} homes) would be
        ${snap.homesUpliftPct != null ? `a <strong>${snap.homesUpliftPct.toFixed(0)}%</strong> increase` : "an increase"}
        on that stock.` : ""}</p>` : ""}
    ${snap.upliftPeople != null ? `
      <p class="syn-uplift">That capacity could add
        ~<strong>${snap.upliftPeople.toLocaleString()}</strong> residents
        ${snap.upliftPct != null ? `(<strong>${snap.upliftPct.toFixed(0)}%</strong> on current population)` : ""}
        at ${PEOPLE_PER_HOME} people/home.</p>` : ""}
    ${connectivityHTML(snap)}
    <div class="syn-actions">
      <button class="syn-btn" id="syn-pin-btn" type="button"></button>
      <button class="syn-btn syn-btn-ghost" id="syn-compare-btn" type="button">Shortlist & compare →</button>
      <button class="syn-btn syn-btn-ghost" id="syn-report-btn" type="button">⤓ Station report</button>
    </div>`;

  const reportBtn = el.querySelector("#syn-report-btn");
  if (reportBtn) reportBtn.addEventListener("click", () => exportStationReport(buildStationSnapshot()));

  const pinBtn = el.querySelector("#syn-pin-btn");
  const updatePinBtn = () => {
    const pinned = shortlist.has(snap.key);
    pinBtn.textContent = pinned ? "★ Shortlisted" : "☆ Add to shortlist";
    pinBtn.classList.toggle("syn-btn-active", pinned);
  };
  updatePinBtn();
  pinBtn.addEventListener("click", () => {
    if (shortlist.has(snap.key)) shortlist.remove(snap.key);
    else {
      shortlist.add(buildStationSnapshot());   // fresh snapshot at pin time
      // Re-show the tray if it had been closed this session.
      const tray = document.getElementById("shortlist-tray");
      if (tray) tray.dataset.dismissed = "";
    }
    updatePinBtn();
    updateShortlistTray();
  });
  el.querySelector("#syn-compare-btn").addEventListener("click", openShortlistPanel);
}

// One-sentence plain-English synthesis of the three signals.
function synthesisSentence(snap) {
  const needTxt = snap.need == null ? "an area of unknown deprivation"
    : `an area that is ${depBand(snap.need).replace(/^among /, "among ")}`;
  const usageTxt = snap.usagePctile == null ? ""
    : snap.usagePctile >= 66 ? "a well-used station"
    : snap.usagePctile <= 33 ? "a relatively under-used station"
    : "a moderately-used station";
  const supplyTxt = (snap.supplySites && snap.supplySites > 0)
    ? `${snap.supplySites} brownfield site${snap.supplySites === 1 ? "" : "s"} (~${(snap.supplyHomes || 0).toLocaleString()} homes${snap.supplyPublic ? `, ${snap.supplyPublic} publicly owned` : ""})`
    : "no recorded brownfield sites";
  let s = `${snap.name} is ${usageTxt ? usageTxt + " in " : ""}${needTxt}.`;
  s += ` Its ${snap.walkMinutes}-min catchment contains ${supplyTxt}.`;
  if (snap.usagePctile != null && snap.usagePctile <= 33 && snap.need != null && snap.need >= 60 && snap.supplyHomes) {
    s += " An under-used station in a deprived area with developable land — a strong regeneration candidate.";
  }
  return s;
}

// The need / supply / usage triad — three cells, each a headline value + a
// normalised 0-100 bar so they read comparably. Kept as three SEPARATE signals
// (not blended). Reused by the panel and the comparison view.
function triadHTML(snap, compact) {
  const bars = triadBars(snap);
  const cell = (label, value, sub, pct, color) => `
    <div class="triad-cell">
      <div class="triad-label">${label}</div>
      <div class="triad-value" style="color:${color}">${value}</div>
      <div class="triad-sub">${sub || ""}</div>
      <div class="triad-bar"><span style="width:${pct == null ? 0 : pct.toFixed(0)}%;background:${color}"></span></div>
    </div>`;
  const needVal = snap.need == null ? "—" : snap.need.toFixed(0);
  const usageVal = snap.usage == null ? "—" : fmtCount(snap.usage);
  const supplyVal = snap.supplyHomes == null ? "—" : (snap.supplyHomes || 0).toLocaleString();
  return `
    <div class="triad${compact ? " triad-compact" : ""}">
      ${cell("NEED", needVal, "deprivation /100", bars.needPct, "#d9772f")}
      ${cell("SUPPLY", supplyVal, "est. homes", bars.supplyPct, "#3f9b5e")}
      ${cell("USAGE", usageVal, snap.usagePctile != null ? `${Math.round(snap.usagePctile)}ᵗʰ pctile` : "entries/exits", bars.usagePct, "#7a3ea8")}
    </div>`;
}

// ---- Shortlist tray + comparison panel ------------------------------------

// Keep the bottom-left tray in sync with the shortlist. Hidden when empty.
function updateShortlistTray() {
  const tray = document.getElementById("shortlist-tray");
  if (!tray) return;
  const n = shortlist.items.length;
  if (n === 0) { tray.hidden = true; tray.innerHTML = ""; tray.dataset.dismissed = ""; return; }
  // If the user explicitly closed the tray this session, keep it hidden until a
  // new item is added (adding clears the dismissed flag — see addToShortlist).
  if (tray.dataset.dismissed === "1") { tray.hidden = true; return; }
  tray.hidden = false;
  tray.innerHTML = `
    <div class="tray-head">
      <div class="tray-label">Shortlist <span class="tray-count">${n}</span></div>
      <button class="tray-close" id="tray-close-btn" type="button" title="Hide shortlist" aria-label="Hide shortlist">×</button>
    </div>
    <div class="tray-chips">
      ${shortlist.items.map(i => `
        <span class="tray-chip" title="${i.name}">
          ${i.crs || i.name.slice(0, 10)}
          <button class="tray-chip-x" data-key="${i.key}" title="Remove ${i.name}" aria-label="Remove ${i.name}">×</button>
        </span>`).join("")}
    </div>
    <button class="tray-open" id="tray-open-btn" type="button">Compare & export →</button>`;
  tray.querySelector("#tray-open-btn").addEventListener("click", openShortlistPanel);
  tray.querySelector("#tray-close-btn").addEventListener("click", () => {
    tray.dataset.dismissed = "1";
    tray.hidden = true;
  });
  tray.querySelectorAll(".tray-chip-x").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      shortlist.remove(btn.dataset.key);
      updateShortlistTray();
      // Keep any open synthesis pin-button state in sync.
      const pinBtn = document.getElementById("syn-pin-btn");
      if (pinBtn && deep.station) {
        const k = (deep.station.crs && deep.station.crs.toUpperCase()) || deep.station.name;
        const pinned = shortlist.has(k);
        pinBtn.textContent = pinned ? "★ Shortlisted" : "☆ Add to shortlist";
        pinBtn.classList.toggle("syn-btn-active", pinned);
      }
    });
  });
}

// Open the comparison modal showing all shortlisted stations side by side.
function openShortlistPanel() {
  const modal = document.getElementById("compare-modal");
  if (!modal) return;
  if (!shortlist.items.length) {
    modal.hidden = false;
    modal.innerHTML = `
      <div class="compare-backdrop"></div>
      <div class="compare-sheet">
        <div class="compare-head"><h2>Shortlist</h2><button class="compare-close" type="button">×</button></div>
        <div class="compare-body"><p class="hint">No stations shortlisted yet. Profile a station and use "Add to shortlist".</p></div>
      </div>`;
    wireCompareModal(modal);
    return;
  }

  const items = shortlist.items;
  // Rank helpers: highlight the leader in each signal.
  const maxNeed = Math.max(...items.map(i => i.need ?? -1));
  const maxSupply = Math.max(...items.map(i => i.supplyHomes ?? -1));
  const maxUsage = Math.max(...items.map(i => i.usage ?? -1));

  const rows = items.map(i => {
    const bars = triadBars(i);
    const lead = (v, m) => (v != null && v === m && m >= 0) ? " compare-lead" : "";
    return `
      <tr>
        <td class="cmp-name">
          <div class="cmp-name-main">${i.name}</div>
          <div class="cmp-name-sub">${i.crs || ""}${i.region ? " · " + i.region : ""}</div>
          <button class="cmp-remove" data-key="${i.key}" title="Remove">Remove</button>
        </td>
        <td class="cmp-num${lead(i.need, maxNeed)}">
          ${i.need == null ? "—" : i.need.toFixed(0)}
          <div class="cmp-bar"><span style="width:${bars.needPct || 0}%;background:#d9772f"></span></div>
        </td>
        <td class="cmp-num${lead(i.supplyHomes, maxSupply)}">
          ${i.supplyHomes == null ? "—" : i.supplyHomes.toLocaleString()}
          <div class="cmp-sub">${i.supplySites || 0} sites · ${i.supplyPublic || 0} public</div>
          <div class="cmp-bar"><span style="width:${bars.supplyPct || 0}%;background:#3f9b5e"></span></div>
        </td>
        <td class="cmp-num${lead(i.usage, maxUsage)}">
          ${i.usage == null ? "—" : fmtCount(i.usage)}
          <div class="cmp-sub">${i.usagePctile != null ? Math.round(i.usagePctile) + "th pctile" : ""}</div>
          <div class="cmp-bar"><span style="width:${bars.usagePct || 0}%;background:#7a3ea8"></span></div>
        </td>
        <td class="cmp-num">${i.population != null ? fmtCount(i.population) : "—"}</td>
        <td class="cmp-num">${i.upliftPeople != null ? "+" + fmtCount(i.upliftPeople) : "—"}</td>
      </tr>`;
  }).join("");

  modal.hidden = false;
  modal.innerHTML = `
    <div class="compare-backdrop"></div>
    <div class="compare-sheet">
      <div class="compare-head">
        <div>
          <h2>Station comparison</h2>
          <p class="compare-sub">${items.length} shortlisted · need, supply and usage kept as separate signals</p>
        </div>
        <div class="compare-head-actions">
          <button class="compare-export" id="compare-export-btn" type="button">Export report ↗</button>
          <button class="compare-close" type="button">×</button>
        </div>
      </div>
      <div class="compare-body">
        <table class="compare-table">
          <thead><tr>
            <th>Station</th><th>Need<br><span>/100</span></th>
            <th>Supply<br><span>est. homes</span></th><th>Usage<br><span>entries/exits</span></th>
            <th>Population</th><th>Modelled<br><span>uplift</span></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint" style="margin-top:10px">Bars are normalised 0-100 for visual comparison (need = score; usage = national percentile; supply scaled to ${SUPPLY_REF_HOMES} homes). Leader in each signal is highlighted. Modelled uplift = est. homes x ${PEOPLE_PER_HOME} people/home.</p>
      </div>
    </div>`;
  wireCompareModal(modal);
}

// ---- Viability variables modal --------------------------------------------
// The full assumption set, GENERATED from VIAB_SCHEMA so the modal can never
// drift from the engine: every field the engine reads gets an input, grouped,
// tooltipped, with its source note. Right-hand pane is a live preview for the
// calling context (top sift survivor, the open deep dive, or an assembled
// site) — waterfall, headline metrics, RAG sensitivity grid — recomputed on
// every keystroke. Edits write straight into SIFT.assumptions (one assumption
// set everywhere, persisted with the sift config).
let _viabCtx = null;

function viabFieldHTML(f, a) {
  const val = a[f.key] ?? f.default;
  if (f.unit === "choice") {
    return `<label class="sift-field viab-field"><span>${f.label}` +
      `<button class="info" type="button" tabindex="0">i<span class="tip" role="tooltip">${escapeSift(f.tip)}<span class="tip-source">Source: ${escapeSift(f.source)}</span></span></button></span>` +
      `<select data-viab="${f.key}">` +
      f.choices.map(c => `<option value="${c}"${val === c ? " selected" : ""}>` +
        ({ mhclg: "MHCLG £/ha (published)", perUnit: "£/unit benchmark",
           euvPlus: "EUV + premium" }[c] || c) + `</option>`).join("") +
      `</select></label>`;
  }
  return `<label class="sift-field viab-field"><span>${f.label} <em class="viab-unit">${f.unit}</em>` +
    `<button class="info" type="button" tabindex="0">i<span class="tip" role="tooltip">${escapeSift(f.tip)}<span class="tip-source">Source: ${escapeSift(f.source)}</span></span></button></span>` +
    `<input type="number" step="${f.step || 1}" value="${val}" data-viab="${f.key}" /></label>`;
}

function viabPreviewHTML(r, label) {
  if (!r || r.profitOnCost == null)
    return `<p class="hint">No appraisal context — open from the sift or a deep dive.</p>`;
  const money = v => v == null ? "—"
    : (Math.abs(v) >= 1e6 ? "£" + (v / 1e6).toFixed(2) + "M"
                          : "£" + Math.round(v / 1000) + "k");
  const pct = v => v == null ? "n/a" : v.toFixed(1) + "%";
  const ragCls = r.rag === "viable" ? "sg" : r.rag === "marginal" ? "sa" : "sr";
  const wf = (r.waterfall || []).map(([k, v]) =>
    `<div class="viab-wf-row${v >= 0 ? " pos" : ""}"><span>${k}</span><span>${money(v)}</span></div>`).join("");
  const steps = SENS_STEPS;
  const target = SIFT.assumptions.profitTargetPct || 17.5;
  // 21 columns: bare numbers (the header cell carries the % once), tiny cells,
  // horizontal scroll if a narrow window still can't fit them.
  const sens = r.sensitivity ? `<div class="viab-sens-scroll"><table class="viab-sens-table"><thead><tr><th>build \\ sales %</th>` +
    steps.map(s => `<th>${s > 0 ? "+" : ""}${s}</th>`).join("") + `</tr></thead><tbody>` +
    r.sensitivity.map((rowArr, i) => `<tr><th>${steps[i] > 0 ? "+" : ""}${steps[i]}</th>` +
      rowArr.map(v => {
        const cls = v == null ? "" : v >= target ? "vs-g" : v >= target / 2 ? "vs-a" : "vs-r";
        return `<td class="${cls}">${v == null ? "—" : v.toFixed(0)}</td>`;
      }).join("") + `</tr>`).join("") + `</tbody></table></div>` : "";
  return `<div class="viab-prev-head">${escapeSift(label || "Scheme")} <span class="viab-rag ${ragCls}">${r.rag}</span></div>` +
    `<div class="viab-kpis">` +
    `<div class="viab-kpi"><b>${pct(r.profitOnCost)}</b><span>profit on cost</span></div>` +
    `<div class="viab-kpi"><b>${pct(r.profitOnGdv)}</b><span>profit on GDV</span></div>` +
    `<div class="viab-kpi"><b>${money(r.residualLandValue)}</b><span>residual land value</span></div>` +
    `<div class="viab-kpi"><b>${r.rlvVsBlv == null ? "n/a" : r.rlvVsBlv.toFixed(2) + "×"}</b><span>RLV ÷ benchmark land</span></div>` +
    `<div class="viab-kpi"><b>${r.landBasisUsed === "mhclg" ? "MHCLG" : r.landScale == null ? "—" : "×" + r.landScale.toFixed(2)}</b><span>${r.landBasisUsed === "mhclg" ? "land basis (published £/ha)" : "land localisation"}</span></div>` +
    `<div class="viab-kpi"><b>${r.irr == null ? "n/a" : pct(r.irr)}</b><span>IRR (equity)</span></div>` +
    `<div class="viab-kpi"><b>${money(r.peakDebt)}</b><span>peak debt</span></div>` +
    `<div class="viab-kpi"><b>${money(r.gdv)}</b><span>GDV</span></div>` +
    `</div>` +
    `<div class="viab-wf">${wf}</div>` +
    `<div class="viab-sens-h">Sensitivity — profit on cost, build cost × sales value</div>` + sens +
    `<button type="button" class="ghost" id="viab-audit-btn" style="margin-top:6px">Full calculation — every step with these numbers…</button>` +
    `<p class="hint" style="margin-top:6px">Model: sin² build S-curve, even sales absorption, equity-first funding, monthly interest capitalised on drawn debt, arrangement fee on peak. Every figure above reacts to the fields on the left.</p>`;
}

function refreshViabPreview() {
  const host = document.getElementById("viab-preview");
  if (!host || !_viabCtx) return;
  const r = computeAppraisal(
    { units: _viabCtx.units, ppm2: _viabCtx.ppm2, region: _viabCtx.region,
      areaHa: _viabCtx.areaHa, locationFactor: _viabCtx.locationFactor,
      landValueHa: _viabCtx.landValueHa },
    SIFT.assumptions);
  host.innerHTML = viabPreviewHTML(r, _viabCtx.label);
}

function openViabilityModal(ctx) {
  const modal = document.getElementById("viab-modal");
  if (!modal) return;
  _viabCtx = ctx;
  const a = SIFT.assumptions;
  const groupsHTML = VIAB_GROUPS.map(([g, title]) => {
    const fields = VIAB_SCHEMA.filter(f => f.group === g);
    return `<fieldset class="viab-group"><legend>${title}` +
      `<button type="button" class="viab-reset ghost" data-group="${g}">reset</button></legend>` +
      `<div class="viab-grid">${fields.map(f => viabFieldHTML(f, a)).join("")}</div></fieldset>`;
  }).join("");
  modal.innerHTML = `
    <div class="compare-backdrop"></div>
    <div class="compare-sheet viab-sheet">
      <div class="compare-head">
        <strong>Viability variables</strong>
        <span class="hint" style="margin-left:8px">the full assumption set behind every appraisal — sift, deep dive and site reports share it</span>
        <div class="compare-head-actions">
          <button type="button" class="ghost" id="viab-reset-all">Reset all</button>
          <button type="button" class="compare-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="compare-body viab-body">
        <div class="viab-fields">${groupsHTML}</div>
        <div class="viab-preview" id="viab-preview"></div>
      </div>
    </div>`;
  modal.hidden = false;
  const close = () => { modal.hidden = true; modal.innerHTML = ""; _viabCtx = null; };
  modal.querySelector(".compare-close").addEventListener("click", close);
  modal.querySelector(".compare-backdrop").addEventListener("click", close);
  const commit = () => {
    persistSiftConfig();
    refreshViabPreview();
    if (ctx && ctx.onChange) ctx.onChange();
  };
  modal.querySelectorAll("[data-viab]").forEach(inp => {
    inp.addEventListener("input", () => {
      const key = inp.dataset.viab;
      a[key] = inp.tagName === "SELECT" ? inp.value : (parseFloat(inp.value) || 0);
      commit();
    });
  });
  modal.querySelectorAll(".viab-reset").forEach(btn =>
    btn.addEventListener("click", () => {
      for (const f of VIAB_SCHEMA.filter(f => f.group === btn.dataset.group))
        a[f.key] = f.default;
      openViabilityModal(ctx);   // re-render with defaults restored
      if (ctx && ctx.onChange) ctx.onChange();
      persistSiftConfig();
    }));
  modal.querySelector("#viab-reset-all").addEventListener("click", () => {
    for (const f of VIAB_SCHEMA) a[f.key] = f.default;
    openViabilityModal(ctx);
    if (ctx && ctx.onChange) ctx.onChange();
    persistSiftConfig();
  });
  // Delegated: the preview's innerHTML is replaced on every keystroke, but the
  // #viab-preview container survives, so one listener covers every re-render.
  modal.querySelector("#viab-preview").addEventListener("click", e => {
    if (e.target && e.target.id === "viab-audit-btn") openCalcAudit(ctx);
  });
  refreshViabPreview();
}

// ---- Full-calculation audit modal ------------------------------------------
// Every step of the residual appraisal with the actual numbers substituted,
// so anyone can verify the arithmetic line by line — GDV, build, fees, policy,
// land, finance, returns. Rendered from the engine's own `audit` trace (the
// intermediates computeAppraisal actually passed through), never re-derived
// here: the breakdown cannot drift from the calculation it explains.
function openCalcAudit(ctx) {
  const modal = document.getElementById("viab-modal");
  if (!modal || !ctx) return;
  const a = SIFT.assumptions;
  const r = computeAppraisal(
    { units: ctx.units, ppm2: ctx.ppm2, region: ctx.region, areaHa: ctx.areaHa,
      locationFactor: ctx.locationFactor, landValueHa: ctx.landValueHa },
    a, { noSens: true });
  if (!r || r.profitOnCost == null || !r.audit) {
    alert("No dwelling capacity to appraise yet — turn on the developable-land tool first.");
    return;
  }
  modal.innerHTML = `
    <div class="compare-backdrop"></div>
    <div class="compare-sheet va-sheet">
      <div class="compare-head">
        <strong>Full calculation — ${escapeSift(ctx.label || "scheme")}</strong>
        <span class="hint" style="margin-left:8px">every step, actual numbers — the exact arithmetic behind the headline figures</span>
        <div class="compare-head-actions">
          <button type="button" class="ghost" id="va-open-vars">Viability variables…</button>
          <button type="button" class="compare-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="compare-body va-body">${calcAuditHTML(ctx, a, r)}</div>
    </div>`;
  modal.hidden = false;
  const close = () => { modal.hidden = true; modal.innerHTML = ""; };
  modal.querySelector(".compare-close").addEventListener("click", close);
  modal.querySelector(".compare-backdrop").addEventListener("click", close);
  modal.querySelector("#va-open-vars").addEventListener("click", () => openViabilityModal(ctx));
}

// Shared builder for the ten audit sections (.va-* classes — styled by
// styles.css in the modal, and by SITE_REPORT_CSS in the assembler's printed
// site report, which embeds the same breakdown so the client-facing document
// carries the identical line-by-line arithmetic).
function calcAuditHTML(ctx, a, r) {
  const t = r && r.audit;
  if (!t) return "";
  const M = v => v == null ? "—"
    : (Math.abs(v) >= 1e6 ? "£" + (v / 1e6).toFixed(2) + "M"
                          : "£" + Math.round(v / 1000).toLocaleString() + "k");
  const N = (v, d) => v == null ? "—"
    : (+v).toLocaleString(undefined, { maximumFractionDigits: d ?? 2 });
  const step = (h, rows, noteTxt) => `<div class="va-step"><div class="va-h">${h}</div>` +
    rows.filter(Boolean).join("") +
    (noteTxt ? `<p class="va-note">${noteTxt}</p>` : "") + `</div>`;
  const row = (label, formula, result) =>
    `<div class="va-row"><span class="va-l">${label}</span>` +
    `<span class="va-f">${formula}</span><b class="va-r">${result}</b></div>`;
  const target = a.profitTargetPct || 17.5;

  const inputs = step("1 · Inputs", [
    row("homes", `developable land priced at the active density regime`, N(t.units, 0)),
    row("sales value basis", t.localPsf != null
      ? `catchment £${N(ctx.ppm2, 0)}/m² (Land Registry × EPC) ÷ 10.764`
      : `no local £/m² — national fallback £${N(a.salesPsf, 0)}/ft² × regional multiplier`,
      t.localPsf != null ? "£" + N(t.localPsf) + "/ft²" : "£" + N(t.price) + "/ft²"),
    row("unit size", `assumption`, N(t.unitFt2, 0) + " ft² (" + N(t.unitM2, 1) + " m²)"),
    ctx.areaHa ? row("site area", `developable hectares`, N(ctx.areaHa) + " ha") : "",
    row("build cost index", ctx.locationFactor
      ? `local factor from the build-cost layer` : `national baseline`,
      "×" + N(t.locFactor)),
    ctx.landValueHa ? row("MHCLG land value", `published £/ha for this authority`,
      M(ctx.landValueHa) + "/ha") : "",
  ]);

  const gdv = step("2 · GDV (gross development value)", [
    row("achieved £/ft²", t.localPsf != null
      ? `£${N(t.localPsf)}/ft² × ${N(a.salesAdjPct ?? 100, 0)}% sales adjustment`
      : `£${N(a.salesPsf, 0)}/ft² fallback × regional multiplier`,
      "£" + N(t.price) + "/ft²"),
    row("affordable blend", `(1 − ${N(a.affordablePct || 0, 0)}%) + ${N(a.affordablePct || 0, 0)}% × ${N(a.affordableValue || 0, 0)}% of market value`,
      "×" + N(t.blend, 3)),
    row("sales inflation", `${N(a.salesInflationPct || 0, 1)}%/yr compounded to the sales midpoint (${N(t.midSaleYears, 1)} yrs)`,
      "×" + N(t.infl, 3)),
    row("GDV", `${N(t.units, 0)} homes × ${N(t.unitFt2, 0)} ft² × £${N(t.price)}/ft² × ${N(t.blend, 3)} × ${N(t.infl, 3)}`,
      M(r.gdv)),
  ]);

  const build = step("3 · Construction", [
    row("blended build rate", `£${N(a.buildPm2House, 0)}/m² houses × ${N((1 - t.flatFrac) * 100, 0)}% + £${N(a.buildPm2Flat, 0)}/m² flats × ${N(t.flatFrac * 100, 0)}%, × ${N(t.locFactor)} location index`,
      "£" + N(t.pm2, 0) + "/m²"),
    row("base build", `${N(t.units, 0)} homes × ${N(t.unitM2, 1)} m² × £${N(t.pm2, 0)}/m²`, M(t.buildBase)),
    row("abnormals", `${N(a.abnormalsPct || 0, 1)}% of base build`, M(t.abnormals)),
    row("site prep & infrastructure", `${N(t.units, 0)} homes × (£${N(a.sitePrepPerPlot || 0, 0)}k prep + £${N(a.infraPerPlot || 0, 0)}k infra)`, M(t.prepInfra)),
    row("hard cost subtotal", `base + abnormals + prep/infra`, M(t.hardCost)),
  ]);

  const fees = step("4 · Fees & contingency", [
    row("professional fees", `${N(a.profFeesPct || 0, 1)}% of hard cost`, M(t.fees)),
    row("contingency", `${N(a.contingencyPct || 0, 1)}% of hard cost`, M(t.contingency)),
  ]);

  const policy = step("5 · Policy costs (CIL · S106 · BNG)", [
    row("local value ratio", `achieved £${N(t.price)}/ft² ÷ £${N(t.refPsf, 0)}/ft² national reference (clamped 0.25–6)`,
      "×" + N(t.valueRatio)),
    row("policy localisation", `1 + (${N(t.valueRatio)} − 1) × ${N(a.policyLocalisePct ?? 100, 0)}%`,
      "×" + N(t.policyScale)),
    row("CIL + S106 + BNG", `${N(t.units, 0)} homes × ((£${N(a.cilPerUnit || 0, 0)}k CIL + £${N(a.s106PerUnit || 0, 0)}k S106) × ${N(t.policyScale)} + £${N(a.bngPerUnit || 0, 0)}k BNG)`,
      M(t.policyCosts)),
  ], "CIL and S106 track local sales values — a flat national £/unit would understate them in high-value areas. BNG is priced nationally (habitat units trade in a national market).");

  const sales = step("6 · Sales & marketing", [
    row("sales costs", `${N(a.salesCostPct || 0, 1)}% of GDV`, M(t.salesCosts)),
  ]);

  const landRows = [];
  if (t.mhclgLand != null) {
    landRows.push(row("land", `${N(ctx.areaHa)} ha × ${M(ctx.landValueHa)}/ha — MHCLG published benchmark for this authority (no further scaling: already local)`,
      M(t.land)));
  } else if (r.landBasisUsed === "euvPlus") {
    landRows.push(row("land (EUV+)", `${N(ctx.areaHa)} ha × £${N(a.euvPerHa || 0, 0)}k/ha × (1 + ${N(a.euvPremiumPct || 0, 0)}% premium) × ${N(r.landScale)} value-link`,
      M(t.land)));
  } else {
    landRows.push(row("land (£/unit)", `${N(t.units, 0)} homes × £${N(a.blvPerUnit || 0, 0)}k/unit × ${N(r.landScale)} value-link`,
      M(t.land)));
  }
  const land = step("7 · Land", landRows,
    t.mhclgLand == null ? "Value-link = 1 + (local value ratio − 1) × land localisation %. MHCLG published £/ha is used automatically where the authority is covered." : "");

  const fin = step("8 · Finance (from the monthly cashflow)", [
    row("programme", `${N(t.preCon, 0)}m pre-construction + ${N(t.build, 0)}m build + ${N(t.sell, 0)}m sales (${N(t.overlap, 0)}m overlap)`,
      N(t.months, 0) + " months"),
    row("equity cap", `total spend × (1 − ${N(a.ltcPct ?? 85, 0)}% loan-to-cost) — equity drawn first`, M(t.equityCap)),
    row("interest", `${N(a.debtRatePct || 0, 1)}%/yr ÷ 12, capitalised monthly on the drawn debt balance`, M(t.interest)),
    row("peak debt", `highest drawn balance across the programme`, M(r.peakDebt)),
    row("arrangement fee", `${N(a.arrangementFeePct || 0, 1)}% × peak debt`, M(t.financeFee)),
  ], "Cashflow model: land at month 0, half of fees across pre-construction, CIL/S106/BNG at start on site, build spend on a sin² S-curve (slow start, peak mid-programme), sales received evenly across the sales period, receipts repay debt first.");

  const totals = step("9 · Totals & returns", [
    row("total cost", `build ${M(t.buildBase)} + abnormals ${M(t.abnormals)} + prep/infra ${M(t.prepInfra)} + fees ${M(t.fees)} + contingency ${M(t.contingency)} + policy ${M(t.policyCosts)} + sales ${M(t.salesCosts)} + land ${M(t.land)} + finance ${M(t.interest + t.financeFee)}`,
      M(r.totalCost)),
    row("profit", `GDV ${M(r.gdv)} − total cost ${M(r.totalCost)}`, M(r.profit)),
    row("profit on cost", `${M(r.profit)} ÷ ${M(r.totalCost)}`,
      r.profitOnCost.toFixed(1) + "%"),
    row("profit on GDV", `${M(r.profit)} ÷ ${M(r.gdv)}`,
      r.profitOnGdv == null ? "n/a" : r.profitOnGdv.toFixed(1) + "%"),
    row("verdict", `viable ≥ ${N(target, 1)}% on cost · marginal ≥ ${N(target / 2, 1)}% · else unviable`,
      `<span class="va-rag ${r.rag}">${r.rag}</span>`),
  ]);

  const rlv = step("10 · Residual land value & benchmark test", [
    row("residual land value", `GDV ${M(r.gdv)} − non-land costs ${M(t.nonLand)} − target profit (${N(a.profitTargetGdvPct || 15, 0)}% of GDV = ${M(r.gdv * ((a.profitTargetGdvPct || 15) / 100))})`,
      M(r.residualLandValue)),
    row("RLV ÷ benchmark land", `${M(r.residualLandValue)} ÷ ${M(t.land)}`,
      r.rlvVsBlv == null ? "n/a" : r.rlvVsBlv.toFixed(2) + "×"),
    r.irr != null ? row("IRR (equity)", `annualised return that zeroes the monthly equity cashflow (bisection)`,
      r.irr.toFixed(1) + "%") : row("IRR (equity)", `cashflow degenerate (no equity draw or no positive receipts)`, "n/a"),
  ], "≥1× means the scheme can pay the benchmark land price and still hit the target margin — the standard viability test. A negative RLV means the scheme cannot cover its own costs even with free land.");

  return inputs + gdv + build + fees + policy + sales + land + fin + totals + rlv +
    `<p class="va-note" style="margin-top:10px">Stated simplifications: sin² build S-curve; even sales absorption; equity before debt; monthly interest capitalised; arrangement fee on pre-fee peak debt (rounding-level circularity). Every assumption above is editable in Viability variables — this breakdown always reflects the current set.</p>`;
}

function wireCompareModal(modal) {
  const close = () => { modal.hidden = true; modal.innerHTML = ""; };
  modal.querySelector(".compare-close")?.addEventListener("click", close);
  modal.querySelector(".compare-backdrop")?.addEventListener("click", close);
  modal.querySelectorAll(".cmp-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      shortlist.remove(btn.dataset.key);
      updateShortlistTray();
      openShortlistPanel();   // re-render
    });
  });
  modal.querySelector("#compare-export-btn")?.addEventListener("click", exportShortlistReport);
}

// ---- Export: a polished, standalone, printable report ---------------------
// Builds a self-contained HTML document (inline CSS, no external deps) for the
// shortlisted stations and opens it in a new tab. The user prints it to PDF.
// Designed to be board-ready: cover, methodology note, comparison table, and a
// full one-page profile per station with the triad and domain breakdown.
function exportShortlistReport() {
  if (!shortlist.items.length) { alert("Shortlist is empty — nothing to export."); return; }
  const html = buildReportHTML(shortlist.items);
  const w = window.open("", "_blank");
  if (!w) { alert("Pop-up blocked — allow pop-ups to open the report."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Mode A — standalone single-station report. Reuses the shortlist report
// generator (which already handles a one-item array) so a user exploring one
// station can export a clean report without shortlisting first.
function exportStationReport(snap) {
  if (!snap) { alert("No station profiled yet."); return; }
  const html = buildReportHTML([snap]);
  const w = window.open("", "_blank");
  if (!w) { alert("Pop-up blocked — allow pop-ups to open the report."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ---- Land-assembly site report ---------------------------------------------
// The deliverable of the assembler: a print-styled standalone document for the
// merged site — map extract, twelve appraisal sections, and a per-field
// confidence flag so desktop data is never dressed up as survey findings.

// Snapshot the live map over a bbox. preserveDrawingBuffer is on (map init),
// so toDataURL works at any moment; camera is saved and restored around the
// framing. DOM overlays (legend, popups) live outside the canvas and are
// naturally excluded.
async function captureMapImage(bbox) {
  try {
    const saved = { center: map.getCenter(), zoom: map.getZoom(),
                    bearing: map.getBearing(), pitch: map.getPitch() };
    map.fitBounds(bbox, { padding: 70, animate: false, maxZoom: 16.5 });
    await new Promise(res => {
      const t = setTimeout(res, 4000);        // never hang the report on tiles
      map.once("idle", () => { clearTimeout(t); res(); });
    });
    const url = map.getCanvas().toDataURL("image/png");
    map.jumpTo(saved);
    // An all-black/blank capture is worse than none: probe a few pixels.
    return url && url.length > 20000 ? url : null;
  } catch (_) { return null; }
}

// Confidence flags: data = open data, read directly; model = modelled or
// proxy-derived; desk = requires desktop study / survey — reported as a
// heading with nothing invented underneath.
function confBadge(level) {
  const label = { data: "open data", model: "modelled", desk: "desk study" }[level] || level;
  return `<span class="r-conf rc-${level}">${label}</span>`;
}

function generateSiteReport() {
  return _generateSiteReport().catch(err => {
    console.error("site report failed", err);
    alert("Site report failed: " + (err && err.message ? err.message : err));
  });
}

async function _generateSiteReport() {
  const plots = assemblyPlots();
  if (!plots.length) return;
  const btn = document.getElementById("dd-assembly-report");
  if (btn) { btn.disabled = true; btn.textContent = "Gathering data…"; }
  try {
    // Merge. Disjoint plots union to a MultiPolygon; if turf refuses (sliver
    // edge cases), a bare MultiPolygon of the parts serves the same purpose —
    // polygon_summary accepts either.
    let unionFeat = null;
    try {
      unionFeat = plots.length === 1 ? plots[0]
        : turf.union(turf.featureCollection(plots));
    } catch (_) {}
    if (!unionFeat) {
      unionFeat = { type: "Feature", properties: {}, geometry: {
        type: "MultiPolygon",
        coordinates: plots.flatMap(p => p.geometry.type === "Polygon"
          ? [p.geometry.coordinates] : p.geometry.coordinates) } };
    }
    const bbox = turf.bbox(unionFeat);
    const regime = activeDevelopableRegime();
    const totHa = plots.reduce((s, p) => s + (p.properties.area_ha || 0), 0);
    const totInner = plots.reduce((s, p) => s + (p.properties.inner_ha || 0), 0);
    const units = homesFor(totHa, totInner, regime);

    // Parallel gather — the report never fails outright on one source; each
    // section says what it could not get. sb may be null (DB unconfigured):
    // the report still builds from what the deep dive already holds.
    const sb = (typeof getSupabase === "function") ? getSupabase() : null;
    const [summary, slope, img] = await Promise.all([
      !sb ? Promise.resolve(null)
        : sb.rpc("polygon_summary", { p_geojson: JSON.stringify(unionFeat.geometry) })
            .then(r => r.error ? null : r.data).catch(() => null),
      !sb ? Promise.resolve(null)
        : sb.rpc("grid_in_bbox", { p_dataset: "slope_grid",
              w: bbox[0], s: bbox[1], e: bbox[2], n: bbox[3],
              p_zoom: 13, lim: 2000, p_avg_key: "slope", p_max_key: "max_slope" })
            .then(r => r.error ? null : r.data).catch(() => null),
      captureMapImage(bbox),
    ]);

    const mc = deep._marketCtx || {};
    const appraisal = computeAppraisal({
      units, ppm2: deep.ppm2 || null, region: null, areaHa: totHa,
      locationFactor: mc.factor || null,
      landValueHa: mc.landValueHa || null,
    }, SIFT.assumptions);

    const site = {
      name: (deep.assembly.name || "").trim()
        || `Assembled site — ${(deep.station && deep.station.name) || "catchment"}`,
      station: deep.station || null,
      plots, unionFeat, totHa, totInner, units, regime,
      summary, slope, img, appraisal,
      publicLand: deep.publicLand || null,
      ppm2: deep.ppm2 || null,
      marketCtx: mc,
      counts: deep.counts || {},
      radius: (deep.developable && deep.developable.radius_m) || 800,
    };
    const html = buildSiteReportHTML(site);
    const w = window.open("", "_blank");
    if (!w) { alert("Pop-up blocked — allow pop-ups to open the report."); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate site report"; }
  }
}

// Extends REPORT_CSS — never forks it. Everything site-report-specific is
// namespaced sr-/rc-.
const SITE_REPORT_CSS = `
  .sr-map { width: 100%; border-radius: 8px; border: 1px solid #d8d4c8; margin: 10px 0 14px; }
  .sr-sec { page-break-inside: avoid; margin: 18px 0; }
  .sr-sec h3 { font-family: Georgia, serif; font-size: 15px; border-bottom: 1px solid #d8d4c8; padding-bottom: 4px; margin-bottom: 8px; }
  .sr-row { display: flex; justify-content: space-between; gap: 14px; padding: 2.5px 0; font-size: 12px; border-bottom: 1px dotted #e4e0d4; }
  .sr-row .k { color: #5a5648; }
  .sr-row .v { text-align: right; font-weight: 600; }
  .sr-row .src { display: block; font-weight: 400; font-size: 9.5px; color: #8a8574; }
  .r-conf { font-size: 8.5px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; text-transform: uppercase; letter-spacing: .04em; vertical-align: middle; }
  .rc-data { background: #d3f0d8; color: #205b2a; }
  .rc-model { background: #fdeec9; color: #7a5a12; }
  .rc-desk { background: #e8e4f5; color: #4a3d80; }
  .sr-desk-list { font-size: 11.5px; color: #5a5648; margin: 4px 0 0 16px; }
  .sr-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0; }
  .sr-kpi { background: #edeae0; border-radius: 6px; padding: 8px 10px; }
  .sr-kpi b { display: block; font-size: 15px; }
  .sr-kpi span { font-size: 9.5px; color: #6a6656; text-transform: uppercase; letter-spacing: .04em; }
  .sr-table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 6px 0; }
  .sr-table th, .sr-table td { border: 1px solid #d8d4c8; padding: 3px 8px; text-align: right; }
  .sr-table th:first-child, .sr-table td:first-child { text-align: left; }
  .sr-sens th, .sr-sens td { padding: 1px 2px; font-size: 7.5px; }
  .sr-sens td.g { background: #d3f0d8; } .sr-sens td.a { background: #fdeec9; } .sr-sens td.r { background: #f6d5d0; }
  .sr-note { font-size: 10px; color: #8a8574; margin-top: 4px; }
  .sr-rag { font-size: 10px; padding: 2px 10px; border-radius: 9px; color: #fff; text-transform: uppercase; }
  .sr-rag.viable { background: #2f9e44; } .sr-rag.marginal { background: #f08c00; } .sr-rag.unviable { background: #c92a2a; }
  /* Full-calculation audit (shared .va-* markup from calcAuditHTML), print
     palette. Each step keeps to one page; rows are label · formula · result. */
  .va-step { margin: 0 0 12px; page-break-inside: avoid; }
  .va-h { font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: #6a6656; font-weight: 700; margin: 0 0 3px; }
  .va-row { display: grid; grid-template-columns: 150px 1fr auto; gap: 10px; align-items: baseline; padding: 2.5px 0; border-bottom: 1px dotted #e4e0d4; font-size: 11px; }
  .va-f { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5px; color: #5a5648; word-break: break-word; }
  .va-r { text-align: right; font-weight: 600; white-space: nowrap; }
  .va-note { font-size: 10px; color: #8a8574; margin: 4px 0 0; }
  .va-rag { font-size: 9px; padding: 1px 8px; border-radius: 8px; color: #fff; text-transform: uppercase; }
  .va-rag.viable { background: #2f9e44; } .va-rag.marginal { background: #f08c00; } .va-rag.unviable { background: #c92a2a; }
`;

function buildSiteReportHTML(site) {
  const esc = s => String(s ?? "").replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = v => v == null ? "—"
    : (Math.abs(v) >= 1e6 ? "£" + (v / 1e6).toFixed(2) + "M" : "£" + Math.round(v / 1000) + "k");
  const pct = v => v == null ? "n/a" : Number(v).toFixed(1) + "%";
  const S = site.summary || {};
  const areas = S.areas || {};
  const cons = {};
  for (const c of (S.constraints || [])) cons[c.kind] = c.pct;

  // One row, one claim, one confidence flag, one source.
  const fieldRows = [];
  const row = (label, value, conf, source) => value == null ? "" :
    `<div class="sr-row"><span class="k">${esc(label)}${confBadge(conf)}` +
    (source ? `<span class="src">${esc(source)}</span>` : "") +
    `</span><span class="v">${value}</span></div>`;
  const deskItems = [];
  const deskLine = items =>
    `<ul class="sr-desk-list">${items.map(i => `<li>${esc(i)}${confBadge("desk")}</li>`).join("")}</ul>`;

  // Slope from the aggregated grid over the site bbox.
  let slopeAvg = null, slopeMax = null;
  const sf = (site.slope && site.slope.features) || [];
  if (sf.length) {
    let wsum = 0, n = 0;
    for (const f of sf) {
      const p = f.properties || {};
      const cells = Number(p.cells) || 1;
      if (p.slope != null) { wsum += Number(p.slope) * cells; n += cells; }
      if (p.max_slope != null) slopeMax = Math.max(slopeMax ?? 0, Number(p.max_slope));
    }
    if (n) slopeAvg = wsum / n;
  }

  const ap = site.appraisal || {};
  const ragBadge = ap.rag && ap.rag !== "n/a" ? `<span class="sr-rag ${ap.rag}">${ap.rag}</span>` : "";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const stationName = site.station ? (site.station.name || site.station.crs) : null;

  // Environmental / heritage constraint helpers
  const kindLabel = {
    flood_zone_2: "Flood Zone 2", flood_zone_3: "Flood Zone 3",
    sssi: "SSSI", sac: "SAC", spa: "SPA", ramsar: "Ramsar",
    ancient_woodland: "Ancient woodland", scheduled_monument: "Scheduled monument",
    conservation_area: "Conservation area", listed_building: "Listed building (curtilage)",
    park_garden: "Registered park & garden", green_space: "Public green space",
    green_belt: "Green Belt", built_land: "Built land", water: "Water",
    transport: "Transport corridor", aonb: "AONB / National Landscape",
  };
  const consRow = (kind, conf) => cons[kind] != null
    ? row(kindLabel[kind] || kind, pct(cons[kind]) + " of site", conf || "data", "planning constraint overlay")
    : "";

  const sales = (S.recent_sales || []).slice(0, 5);
  const PT = { D: "Detached", S: "Semi", T: "Terraced", F: "Flat", O: "Other" };
  const salesTable = sales.length ? `<table class="sr-table"><thead>
      <tr><th>Comparable</th><th>Date</th><th>Type</th><th>Price</th><th>Distance</th></tr></thead><tbody>` +
    sales.map((x, i) => `<tr><td>Sale ${i + 1}</td><td>${esc(x.date || "")}</td>
      <td>${esc(PT[x.ptype] || x.ptype || "")}</td><td>£${Number(x.price || 0).toLocaleString()}</td>
      <td>${x.dist_m != null ? Math.round(x.dist_m) + " m" : ""}</td></tr>`).join("") +
    `</tbody></table>` : `<p class="sr-note">No recent transactions within the sample radius.</p>`;

  const steps = SENS_STEPS;
  const target = SIFT.assumptions.profitTargetPct || 17.5;
  const sensTable = ap.sensitivity ? `<table class="sr-table sr-sens"><thead>
      <tr><th>build \\ sales %</th>${steps.map(s => `<th>${s > 0 ? "+" : ""}${s}</th>`).join("")}</tr></thead><tbody>` +
    ap.sensitivity.map((r2, i) => `<tr><th>${steps[i] > 0 ? "+" : ""}${steps[i]}</th>` +
      r2.map(v => `<td class="${v == null ? "" : v >= target ? "g" : v >= target / 2 ? "a" : "r"}">${v == null ? "—" : v.toFixed(0)}</td>`).join("") +
      `</tr>`).join("") + `</tbody></table>` : "";

  const wfTable = ap.waterfall ? `<table class="sr-table"><tbody>` +
    ap.waterfall.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${money(v)}</td></tr>`).join("") +
    `</tbody></table>` : "";

  const assumpTable = `<table class="sr-table"><thead><tr><th>Assumption</th><th>Value</th><th>Source</th></tr></thead><tbody>` +
    VIAB_SCHEMA.map(f => {
      const v = SIFT.assumptions[f.key] ?? f.default;
      return `<tr><td>${esc(f.label)}</td><td>${esc(String(v))} ${f.unit !== "choice" ? esc(f.unit) : ""}</td><td>${esc(f.source)}</td></tr>`;
    }).join("") + `</tbody></table>`;

  const incomeArea = areas.msoa_income || areas.lad_income || null;
  const bci = areas.build_cost_index || null;

  const body = `
  <div class="cover">
    <p class="cover-note">MasterMapper · land assembly appraisal</p>
    <h1>${esc(site.name)}</h1>
    <p class="cover-sub">${stationName ? esc(stationName) + " catchment · " : ""}${site.totHa.toFixed(2)} ha across ${site.plots.length} plot${site.plots.length === 1 ? "" : "s"} · generated ${dateStr}</p>
    <div class="sr-kpis">
      <div class="sr-kpi"><b>${site.totHa.toFixed(2)} ha</b><span>net developable</span></div>
      <div class="sr-kpi"><b>~${site.units.toLocaleString()}</b><span>homes (${esc(site.regime)})</span></div>
      <div class="sr-kpi"><b>${pct(ap.profitOnCost)}</b><span>profit on cost ${ragBadge}</span></div>
      <div class="sr-kpi"><b>${money(ap.residualLandValue)}</b><span>residual land value</span></div>
    </div>
    ${site.img ? `<img class="sr-map" src="${site.img}" alt="Site plan extract" />`
               : `<p class="sr-note">Map extract unavailable — capture failed in this browser.</p>`}
    <p class="sr-note">Flags: ${confBadge("data")} read from open data · ${confBadge("model")} modelled or proxy · ${confBadge("desk")} requires desktop study or survey. Every desk item is listed in section 12 — nothing is invented.</p>
  </div>

  <section class="sr-sec"><h3>1 · Site fundamentals</h3>
    ${row("Gross site area", site.totHa.toFixed(2) + " ha (" + (site.totHa * 2.471).toFixed(1) + " ac)", "data", "developable-land analysis, constraint-stripped")}
    ${row("Parcels assembled", site.plots.length + " contiguous plot(s)", "data")}
    ${row("Inner-ring share", site.totInner > 0 ? site.totInner.toFixed(2) + " ha within " + ((deep.developable && deep.developable.inner_radius_m) || 200) + " m of station" : null, "model")}
    ${row("Mean slope", slopeAvg != null ? slopeAvg.toFixed(1) + "°" : null, "model", "OS Terrain 50-derived 1 km grid")}
    ${row("Steepest 50 m", slopeMax != null ? slopeMax.toFixed(1) + "°" : null, "model")}
    ${row("Agricultural land", areas.alc ? esc(areas.alc.alc_grade || areas.alc.name || "graded") : null, "data", "Natural England provisional ALC")}
    ${row("Local authority", areas.lad_boundary ? esc(areas.lad_boundary.name) : null, "data", "ONS boundaries")}
    ${row("Planning authority", areas.lpa_boundary ? esc(areas.lpa_boundary.name) : null, "data")}
    ${deskLine(["Topographic survey", "Existing structures & demolition extent", "Site severance (rail / watercourse / easements)", "Adjoining ownership & ransom strips"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>2 · Planning status & policy</h3>
    ${row("Local plan area", areas.local_plan_boundary ? esc(areas.local_plan_boundary.name) : null, "data", "planning.data.gov.uk")}
    ${row("Article 4 direction", areas.article4 ? "Within: " + esc(areas.article4.name || "designated area") : "None mapped on site", "data")}
    ${row("Green Belt coverage", S.grey_belt_pct != null || cons.green_belt != null ? pct(cons.green_belt ?? 0) + " of site" : null, "data")}
    ${row("Grey-belt candidate", S.grey_belt_pct != null ? pct(S.grey_belt_pct) + " of site" : null, "model", "MasterMapper grey-belt model, not a designation")}
    ${row("Housing Delivery Test", areas.hdt ? esc(String(areas.hdt.hdt_pct ?? "")) + "% (" + esc(areas.hdt.consequence || "n/a") + ")" : null, "data", "MHCLG HDT measurement")}
    ${row("Approval rate (planning apps)", areas.planit_rates ? esc(String(areas.planit_rates.approval_pct ?? "")) + "% locally" : null, "model", "PlanIt applications sample")}
    ${row("NPPF station tier", site.station && site.station.tier ? esc(site.station.tier) : null, "model", "MasterMapper station assessment")}
    ${deskLine(["Allocation status & emerging plan position", "Five-year housing land supply", "Planning history on site & adjoining", "Pre-app position, committee vs delegated", "Neighbourhood Plan policies"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>3 · Environmental constraints</h3>
    ${consRow("flood_zone_2")}${consRow("flood_zone_3")}
    ${consRow("sssi")}${consRow("sac")}${consRow("spa")}${consRow("ramsar")}
    ${consRow("ancient_woodland")}${consRow("green_space")}${consRow("water")}
    ${(S.constraints || []).length === 0 ? `<p class="sr-note">No mapped environmental constraint intersects the site (≥0.5% threshold).</p>` : ""}
    ${deskLine(["Nutrient / water neutrality catchment position", "Protected species likelihood (bats, GCN, badger)", "BNG baseline habitat units & on-site %", "Noise contours & air quality", "Trees & hedgerows survey"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>4 · Heritage</h3>
    ${consRow("conservation_area")}${consRow("listed_building")}${consRow("scheduled_monument")}${consRow("park_garden")}
    ${!cons.conservation_area && !cons.listed_building && !cons.scheduled_monument && !cons.park_garden ? `<p class="sr-note">No designated heritage asset intersects the site.</p>` : ""}
    ${deskLine(["Setting of nearby designated assets", "Archaeological potential / HER search", "Non-designated & locally listed assets"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>5 · Ground conditions</h3>
    ${row("Slope profile", slopeAvg != null ? slopeAvg.toFixed(1) + "° mean · " + (slopeMax ?? 0).toFixed(1) + "° max" : null, "model")}
    ${deskLine(["Historic land use & contamination risk", "Coal Authority high-risk area / mine entries", "Radon protection level", "Ground stability & shrink-swell", "Groundwater source protection", "UXO risk", "Foundation solution & bearing capacity"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>6 · Utilities & infrastructure</h3>
    ${row("Nearest grid substation", S.nearest_grid_substation ? esc(S.nearest_grid_substation.name || "substation") + " (" + esc(String(S.nearest_grid_substation.kv || "?")) + " kV, " + Math.round(S.nearest_grid_substation.dist_m || 0) + " m)" : null, "data", "OSM power network")}
    ${row("Grid supply point", areas.gsp_boundary ? esc(areas.gsp_boundary.name) : null, "data", "NESO")}
    ${row("Water resource availability", areas.water_availability ? esc(areas.water_availability.name || "catchment") : null, "data", "EA CAMS")}
    ${deskLine(["Foul drainage capacity & connection point", "DNO connection quote & reinforcement lead time", "SuDS feasibility & infiltration", "Gas / all-electric strategy", "Buried services & wayleaves"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>7 · Access & transport</h3>
    ${row("Rail station", stationName ? esc(stationName) + " — site within the " + site.radius + " m catchment" : null, "data")}
    ${row("PTAL", areas.ptal ? esc(String(areas.ptal.ptal ?? areas.ptal.name ?? "")) : null, "data", "TfL (London only)")}
    ${row("Schools in catchment", site.counts.school != null ? String(site.counts.school) : null, "data")}
    ${row("GP surgeries in catchment", site.counts.gp != null ? String(site.counts.gp) : null, "data")}
    ${deskLine(["Adoptable access & visibility splays", "Junction capacity & modelling scope", "PRoW crossing / diversion", "Travel plan obligations"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>8 · Market & demand</h3>
    ${row("Local sales value", site.ppm2 ? "£" + Math.round(site.ppm2).toLocaleString() + "/m² · £" + Math.round(site.ppm2 / 10.7639).toLocaleString() + "/ft²" : null, "data", "Land Registry × EPC, catchment-weighted")}
    ${row("Local rents", areas.la_rents ? "£" + esc(String(areas.la_rents.rent_mean ?? "")) + "/month LA average" : null, "data", "ONS PIPR")}
    ${row("Affordability", incomeArea && incomeArea.afford_ratio != null ? esc(String(incomeArea.afford_ratio)) + "× local income" + (areas.msoa_income ? " (neighbourhood)" : " (district)") : null, "data", "Land Registry + ONS income")}
    ${row("Build cost index", bci ? esc(String(bci.factor)) + "× national (" + esc(bci.region || "region") + ")" : null, "model", "free proxy — not BCIS")}
    <p style="font-size:12px;margin:8px 0 2px"><strong>Recent transactions</strong> ${confBadge("data")}</p>
    ${salesTable}
    ${deskLine(["New-build premium evidence & absorption rate", "Competing consented supply", "RP appetite & affordable offer levels"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>9 · Ownership & deliverability</h3>
    ${row("Public-land parcels in catchment", site.publicLand && site.publicLand.n_parcels != null ? String(site.publicLand.n_parcels) + " confirmed (" + Number(site.publicLand.total_ha || 0).toFixed(1) + " ha)" : null, "model", "CCOD × INSPIRE — postcode-centroid join, verify title-by-title")}
    ${row("Council property points on site", S.council_property != null ? String(S.council_property) : null, "model")}
    ${row("Brownfield register overlap", S.brownfield_overlap != null ? String(S.brownfield_overlap) + " site(s)" : null, "data")}
    ${deskLine(["Title ownership & restrictive covenants", "Options / promotion agreements", "Tenancies (AHA/FBT)", "Rights of light / party wall"].map(x => { deskItems.push(x); return x; }))}
  </section>

  <section class="sr-sec"><h3>10 · Viability appraisal ${confBadge("model")}</h3>
    <div class="sr-kpis">
      <div class="sr-kpi"><b>${money(ap.gdv)}</b><span>GDV</span></div>
      <div class="sr-kpi"><b>${money(ap.totalCost)}</b><span>total cost incl. finance</span></div>
      <div class="sr-kpi"><b>${pct(ap.profitOnCost)}</b><span>profit on cost</span></div>
      <div class="sr-kpi"><b>${pct(ap.profitOnGdv)}</b><span>profit on GDV</span></div>
      <div class="sr-kpi"><b>${money(ap.residualLandValue)}</b><span>residual land value</span></div>
      <div class="sr-kpi"><b>${ap.irr == null ? "n/a" : pct(ap.irr)}</b><span>equity IRR</span></div>
      <div class="sr-kpi"><b>${money(ap.peakDebt)}</b><span>peak debt</span></div>
      <div class="sr-kpi"><b>${money(ap.cashflow ? ap.cashflow.interest : null)}</b><span>finance interest</span></div>
    </div>
    <p style="font-size:12px;margin:8px 0 2px"><strong>Appraisal waterfall</strong></p>
    ${wfTable}
    <p style="font-size:12px;margin:8px 0 2px"><strong>Sensitivity — profit on cost, build cost × sales value</strong></p>
    ${sensTable}
    <p class="sr-note">Model: sin² build S-curve over ${SIFT.assumptions.buildMonths} months, even absorption over ${SIFT.assumptions.salesMonths} months, equity-first funding at ${SIFT.assumptions.ltcPct}% LTC, interest capitalised monthly.</p>
  </section>

  <section class="sr-sec"><h3>10a · Full calculation — every step, actual numbers ${confBadge("model")}</h3>
    <p style="font-size:12px;margin:0 0 6px">The complete arithmetic behind the headline figures above, with this site's numbers substituted into each formula, so the appraisal can be verified line by line. Identical to the engine that produced section 10 — rendered from the calculation's own trace, not re-derived.</p>
    ${calcAuditHTML({ units: site.units, ppm2: site.ppm2, areaHa: site.totHa,
        locationFactor: (site.marketCtx && site.marketCtx.factor) || null,
        landValueHa: (site.marketCtx && site.marketCtx.landValueHa) || null },
      SIFT.assumptions, ap)}
  </section>

  <section class="sr-sec"><h3>11 · Assumptions appendix</h3>
    ${assumpTable}
    <p class="sr-note">Every figure is an opening position, edited live in the tool's Viability variables. Build costs are a free proxy (ONS indices + regional factors), not BCIS.</p>
  </section>

  <section class="sr-sec pb"><h3>12 · Risks & further work</h3>
    <p style="font-size:12px">The following were flagged ${confBadge("desk")} above — they require desktop study, survey or legal enquiry and are NOT covered by open data. This list is generated from the flags, so it is complete by construction:</p>
    ${deskLine([...new Set(deskItems)])}
    <p class="sr-note" style="margin-top:12px">Data: HM Land Registry Price Paid & CCOD & INSPIRE (© Crown copyright and database right); EPC register; planning.data.gov.uk; Environment Agency; Natural England; Historic England; ONS; NESO; TfL; OpenStreetMap contributors (ODbL). Contains OS data © Crown copyright. Generated by MasterMapper on ${dateStr}. Indicative appraisal — not a Red Book valuation.</p>
  </section>`;

  return `<!doctype html><html><head><meta charset="utf-8" />
    <title>${esc(site.name)} — site report</title>
    <style>${REPORT_CSS}${SITE_REPORT_CSS}</style></head>
    <body><div class="report">${body}</div>
    <script>setTimeout(function(){ window.print(); }, 500);<\/script>
    </body></html>`;
}

function buildReportHTML(items) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Rank by a transparent "opportunity" ordering: most deprived first among
  // those with developable supply, so the report leads with the strongest
  // social-value candidates. (Display only — the signals stay separate.)
  const ranked = [...items].sort((a, b) => {
    const sa = (a.supplyHomes || 0) > 0 ? 1 : 0, sb = (b.supplyHomes || 0) > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return (b.need || 0) - (a.need || 0);
  });

  const summaryRows = ranked.map((i, idx) => `
    <tr>
      <td class="r-rank">${idx + 1}</td>
      <td class="r-name"><strong>${esc(i.name)}</strong><span>${esc(i.crs)}${i.region ? " · " + esc(i.region) : ""}</span></td>
      <td class="r-num">${i.need == null ? "—" : i.need.toFixed(0)}</td>
      <td class="r-num">${i.supplyHomes == null ? "—" : i.supplyHomes.toLocaleString()}<small>${i.supplySites || 0} sites</small></td>
      <td class="r-num">${i.usage == null ? "—" : fmtCount(i.usage)}<small>${i.usagePctile != null ? Math.round(i.usagePctile) + "th pctile" : ""}</small></td>
      <td class="r-num">${i.population != null ? fmtCount(i.population) : "—"}</td>
      <td class="r-num">${i.upliftPeople != null ? "+" + fmtCount(i.upliftPeople) : "—"}</td>
    </tr>`).join("");

  const profiles = ranked.map((i, idx) => reportProfilePage(i, idx + 1, esc)).join("");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Station Opportunity Report — ${dateStr}</title>
<style>${REPORT_CSS}</style></head><body>
<main class="report">
  <header class="cover">
    <div class="cover-mark">MasterMapper</div>
    <h1>Station Opportunity Report</h1>
    <p class="cover-sub">Social-value-led site identification · ${ranked.length} shortlisted station${ranked.length === 1 ? "" : "s"}</p>
    <p class="cover-date">Generated ${dateStr}</p>
    <div class="cover-legend">
      <span><i style="background:#d9772f"></i> Need — catchment deprivation (national percentile)</span>
      <span><i style="background:#3f9b5e"></i> Supply — brownfield dwelling capacity</span>
      <span><i style="background:#7a3ea8"></i> Usage — annual passenger entries/exits</span>
    </div>
    <p class="cover-note">These three signals are reported <strong>separately</strong>, not blended into a single score. Each station's catchment is a ${ranked[0]?.walkMinutes || 15}-minute walk isochrone. Deprivation is area-weighted across overlapping LSOAs; brownfield capacity is the Land Register estimate; population is an area-weighted estimate. Figures are indicative and intended to support, not replace, professional appraisal.</p>
  </header>

  <section class="summary">
    <h2>Comparison summary</h2>
    <table class="r-table">
      <thead><tr><th>#</th><th>Station</th><th>Need</th><th>Supply</th><th>Usage</th><th>Population</th><th>Uplift</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <p class="r-foot">Ranked by developable supply then deprivation. "Uplift" models brownfield capacity × ${PEOPLE_PER_HOME} people/home.</p>
  </section>

  ${profiles}

  <footer class="report-footer">
    <p>MasterMapper · Generated ${dateStr} · Data: ONS / MHCLG IoD2025 (OGL), ORR station usage (OGL), MHCLG Brownfield Land Register (OGL), OpenStreetMap (ODbL). Indicative figures for planning support.</p>
  </footer>
</main>
<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print();}catch(e){}},400);});</script>
</body></html>`;
}

// One full profile "page" per station for the report.
function reportProfilePage(i, rank, esc) {
  const bars = triadBars(i);
  const domainRows = i.domains ? DOMAINS.map(d => {
    const v = i.domains[d.key];
    if (v == null) return "";
    return `<div class="p-domain"><span class="p-domain-l">${esc(DOMAIN_LABELS[d.key])}</span>
      <span class="p-domain-bar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span>
      <span class="p-domain-v">${Number(v).toFixed(0)}</span></div>`;
  }).join("") : "";

  const triadCell = (label, val, sub, pct, color) => `
    <div class="p-triad-cell">
      <div class="p-triad-label">${label}</div>
      <div class="p-triad-val" style="color:${color}">${val}</div>
      <div class="p-triad-sub">${sub}</div>
      <div class="p-triad-bar"><i style="width:${pct == null ? 0 : pct.toFixed(0)}%;background:${color}"></i></div>
    </div>`;

  return `
  <section class="profile">
    <div class="p-head">
      <div class="p-rank">${rank}</div>
      <div>
        <h2>${esc(i.name)}</h2>
        <p class="p-meta">${esc(i.crs)}${i.operator ? " · " + esc(i.operator) : ""}${i.region ? " · " + esc(i.region) : ""} · ${i.walkMinutes}-min walk catchment</p>
      </div>
    </div>

    <div class="p-triad">
      ${triadCell("NEED", i.need == null ? "—" : i.need.toFixed(0), "deprivation /100", bars.needPct, "#d9772f")}
      ${triadCell("SUPPLY", i.supplyHomes == null ? "—" : i.supplyHomes.toLocaleString(), (i.supplySites || 0) + " sites · " + (i.supplyPublic || 0) + " public", bars.supplyPct, "#3f9b5e")}
      ${triadCell("USAGE", i.usage == null ? "—" : fmtCount(i.usage), i.usagePctile != null ? Math.round(i.usagePctile) + "th national pctile" : "entries/exits", bars.usagePct, "#7a3ea8")}
    </div>

    <div class="p-grid">
      <div class="p-stat"><div class="p-stat-v">${i.population != null ? fmtCount(i.population) : "—"}</div><div class="p-stat-l">Catchment population</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.households != null ? fmtCount(i.households) : "—"}</div><div class="p-stat-l">Existing homes</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.area_km2 != null ? i.area_km2.toFixed(2) + " km²" : "—"}</div><div class="p-stat-l">Catchment area</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.usagePerResident != null ? i.usagePerResident.toFixed(0) : "—"}</div><div class="p-stat-l">Usage per resident</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.season_share != null ? Math.round(i.season_share * 100) + "%" : "—"}</div><div class="p-stat-l">Season-ticket share</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.interchanges != null ? fmtCount(i.interchanges) : "—"}</div><div class="p-stat-l">Interchanges</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.trainsPerDay != null ? fmtCount(i.trainsPerDay) : "—"}</div><div class="p-stat-l">Trains/day (scheduled)</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.directDestinations != null ? i.directDestinations : "—"}</div><div class="p-stat-l">Direct destinations</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.upliftPeople != null ? "+" + fmtCount(i.upliftPeople) : "—"}</div><div class="p-stat-l">Modelled uplift${i.upliftPct != null ? " (" + i.upliftPct.toFixed(0) + "%)" : ""}</div></div>
    </div>

    ${(() => { const b = connectivityBand(i); if (!b) return ""; const cities = (i.keyCities || []).filter(Boolean);
      return `<p class="p-conn"><strong>${b.label}.</strong> ${i.trainsPerDay != null ? fmtCount(i.trainsPerDay) + " scheduled weekday trains" : ""}${cities.length ? `, with direct services to ${esc(cities.slice(0,4).join(", "))}` : ""}. Connectivity is reported separately and does not affect the opportunity ranking.</p>`; })()}

    ${domainRows ? `<div class="p-domains"><h3>Deprivation by domain</h3>${domainRows}</div>` : ""}

    <p class="p-synth">${esc(synthesisSentence(i))}</p>
  </section>`;
}

// ===========================================================================
// BATCH / PIPELINE ANALYSIS
// Profile MANY stations at once and present a potent, animated dashboard.
// Reuses the single-station pipeline (isochrone → area-weighted deprivation &
// population → brownfield supply) headlessly, then ranks and visualises.
// ===========================================================================

const batch = {
  running: false,
  cancel: false,
  results: [],          // array of snapshot objects (same shape as shortlist)
  errors: [],           // { name, crs, reason }
  scored: null,         // last ranked results (cached so the dashboard can reopen)
  returnAfterDeepDive: false,  // true while drilled into a station FROM the batch
};

// --- Entry: open the setup sheet with three ways to choose stations ---------
function openBatchSetup() {
  const el = document.getElementById("batch-setup");
  if (!el) return;
  const feats = (state.stationsData && state.stationsData.features) || [];
  el.hidden = false;
  el.innerHTML = `
    <div class="batch-backdrop"></div>
    <div class="batch-sheet">
      <div class="batch-head">
        <div>
          <div class="batch-eyebrow">Pipeline analysis</div>
          <h2>Batch-profile stations</h2>
          <p class="batch-sub">Score a whole portfolio on need, supply and usage in one pass. Pick how to choose the stations.</p>
        </div>
        <button class="batch-close" type="button">×</button>
      </div>

      <div class="batch-methods">
        <div class="batch-method" data-method="view">
          <div class="bm-icon">🗺️</div>
          <div class="bm-title">Busiest in current map view</div>
          <div class="bm-desc">Profile the busiest stations visible on the map right now.</div>
          <div class="bm-control">
            <label>How many <select id="batch-topn">
              <option value="5">5</option><option value="10" selected>10</option>
              <option value="15">15</option><option value="20">20</option>
            </select></label>
            <button class="bm-go" data-go="view" type="button">Use map view →</button>
          </div>
        </div>

        <div class="batch-method" data-method="paste">
          <div class="bm-icon">⌨️</div>
          <div class="bm-title">Paste a station list</div>
          <div class="bm-desc">CRS codes or names, separated by commas or new lines (e.g. <code>LUT, HEN, SAC</code>).</div>
          <div class="bm-control bm-control-col">
            <textarea id="batch-paste" rows="3" placeholder="LUT, HEN, STP&#10;or one per line…"></textarea>
            <button class="bm-go" data-go="paste" type="button">Profile these →</button>
          </div>
        </div>

        <div class="batch-method" data-method="file">
          <div class="bm-icon">📄</div>
          <div class="bm-title">Upload a list (CSV / txt)</div>
          <div class="bm-desc">A file with one CRS code or station name per line, or a CSV with a <code>crs</code> / <code>name</code> column.</div>
          <div class="bm-control bm-control-col">
            <input type="file" id="batch-file" accept=".csv,.txt,.tsv" />
            <button class="bm-go" data-go="file" type="button">Profile uploaded →</button>
          </div>
        </div>
      </div>

      <p class="batch-foot">${feats.length.toLocaleString()} stations available · each profile builds a ${STATION_WALK_MINUTES}-min walk catchment. Large batches take ~1–2s per station.</p>
    </div>`;

  const close = () => { el.hidden = true; el.innerHTML = ""; };
  el.querySelector(".batch-close").addEventListener("click", close);
  el.querySelector(".batch-backdrop").addEventListener("click", close);

  el.querySelector('[data-go="view"]').addEventListener("click", () => {
    const n = parseInt(document.getElementById("batch-topn").value, 10) || 10;
    const chosen = stationsInViewByUsage(n);
    if (!chosen.length) { alert("No stations in the current map view. Zoom out or pan to some stations."); return; }
    startBatch(chosen);
  });
  el.querySelector('[data-go="paste"]').addEventListener("click", () => {
    const raw = document.getElementById("batch-paste").value || "";
    const chosen = resolveStationList(parseTokens(raw));
    handleResolved(chosen, raw);
  });
  el.querySelector('[data-go="file"]').addEventListener("click", () => {
    const f = document.getElementById("batch-file").files[0];
    if (!f) { alert("Choose a file first."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const tokens = parseFileTokens(reader.result || "");
      const chosen = resolveStationList(tokens);
      handleResolved(chosen, reader.result);
    };
    reader.readAsText(f);
  });

  function handleResolved(chosen, raw) {
    if (!chosen.matched.length) {
      alert("Couldn't match any stations from that input. Use CRS codes (e.g. LUT) or exact station names.");
      return;
    }
    if (chosen.unmatched.length) {
      const ok = confirm(`Matched ${chosen.matched.length} station(s). ${chosen.unmatched.length} not found: ${chosen.unmatched.slice(0, 8).join(", ")}${chosen.unmatched.length > 8 ? "…" : ""}.\n\nProfile the ${chosen.matched.length} matched?`);
      if (!ok) return;
    }
    startBatch(chosen.matched);
  }
}

// Tokenise a pasted blob into candidate tokens (CRS or names).
function parseTokens(raw) {
  return raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}
// Tokenise an uploaded file: if it looks like CSV with a header, pull the
// crs/name column; otherwise treat each line as a token.
function parseFileTokens(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  if (header.includes(",") && (header.includes("crs") || header.includes("name") || header.includes("tlc"))) {
    const cols = lines[0].split(",").map(c => c.trim().toLowerCase());
    let idx = cols.findIndex(c => c === "crs" || c === "tlc");
    if (idx < 0) idx = cols.findIndex(c => c.includes("crs") || c.includes("tlc"));
    if (idx < 0) idx = cols.findIndex(c => c === "name" || c.includes("name"));
    if (idx < 0) idx = 0;
    return lines.slice(1).map(l => (l.split(",")[idx] || "").trim()).filter(Boolean);
  }
  return lines;
}

// Resolve tokens (CRS or names) to station features. Returns matched features +
// unmatched tokens.
function resolveStationList(tokens) {
  const feats = (state.stationsData && state.stationsData.features) || [];
  const byCrs = new Map();
  const byName = new Map();
  const norm = (s) => (s || "").toLowerCase().replace(/\(.*?\)/g, "")
    .replace(/\b(rail|railway)?\s*station\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const f of feats) {
    if (f.properties.crs) byCrs.set(f.properties.crs.toUpperCase(), f);
    byName.set(norm(f.properties.name), f);
  }
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  for (const t of tokens) {
    const up = t.toUpperCase();
    let hit = null;
    if (up.length === 3 && byCrs.has(up)) hit = byCrs.get(up);
    else if (byCrs.has(up)) hit = byCrs.get(up);
    else if (byName.has(norm(t))) hit = byName.get(norm(t));
    if (hit) {
      const key = (hit.properties.crs || hit.properties.name).toUpperCase();
      if (!seen.has(key)) { seen.add(key); matched.push(hit); }
    } else {
      unmatched.push(t);
    }
  }
  return { matched, unmatched };
}

// The busiest N stations whose dot is within the current map bounds.
function stationsInViewByUsage(n) {
  const feats = (state.stationsData && state.stationsData.features) || [];
  const b = map.getBounds();
  const inView = feats.filter(f => {
    const c = f.geometry.coordinates;
    return c[0] >= b.getWest() && c[0] <= b.getEast() && c[1] >= b.getSouth() && c[1] <= b.getNorth();
  });
  inView.sort((a, b2) => (Number(b2.properties.usage) || 0) - (Number(a.properties.usage) || 0));
  return inView.slice(0, n);
}

// --- The runner: profile each station headlessly, with live progress --------
async function startBatch(stationFeatures) {
  const setup = document.getElementById("batch-setup");
  if (setup) { setup.hidden = true; setup.innerHTML = ""; }
  batch.running = true;
  batch.cancel = false;
  batch.results = [];
  batch.errors = [];
  // Remember where the user was so we can restore the view after the batch
  // (profiling jumps the map around to load tiles for each catchment).
  const savedView = { center: map.getCenter(), zoom: map.getZoom() };

  const total = stationFeatures.length;
  renderBatchProgress(0, total, null);

  for (let i = 0; i < stationFeatures.length; i++) {
    if (batch.cancel) break;
    const f = stationFeatures[i];
    const name = f.properties.name || f.properties.crs || "station";
    renderBatchProgress(i, total, name);
    try {
      const snap = await profileStationHeadless(f);
      if (snap) batch.results.push(snap);
      else batch.errors.push({ name, crs: f.properties.crs || "", reason: "no catchment" });
    } catch (e) {
      batch.errors.push({ name, crs: f.properties.crs || "", reason: e.message || "error" });
    }
    // Gentle throttle so we don't hammer Valhalla / Supabase.
    await sleep(220);
  }

  batch.running = false;
  // Restore the user's original view.
  try { map.jumpTo(savedView); } catch (_) {}
  renderBatchProgress(total, total, null);
  await sleep(300);
  renderBatchResults(batch.results, batch.errors);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Profile a single station WITHOUT opening the deep-dive UI. Builds the
// catchment, ensures the LSOA tiles for that area are loaded (so the
// area-weighted scoring has data), computes need/population, fetches supply,
// and returns a snapshot.
async function profileStationHeadless(feature) {
  const props = feature.properties;
  const coords = feature.geometry.coordinates;

  // 1. Catchment (isochrone).
  const catchment = await fetchIsochrone(coords[0], coords[1], "pedestrian", STATION_WALK_MINUTES);
  if (!catchment) return null;

  // 2. Make sure the LSOA vector tiles covering this catchment are loaded.
  //    querySourceFeatures only sees loaded tiles, so jump the map to the
  //    station and wait for idle before scoring. (Off-screen panel hides the
  //    movement from the user's eye; the batch overlay is on top anyway.)
  await ensureTilesAt(catchment, coords);

  // 3. Score deprivation + population from the now-loaded tiles.
  const { domains, parts } = areaWeightedScore(catchment);
  const popRes = areaWeightedPopulation(catchment);

  // 4. Supply summary from Supabase (best-effort).
  let supply = null;
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.rpc("brownfield_summary_in_polygon", {
        catchment: catchment.geometry, min_dwellings: null,
        public_only: false, deliverable_only: false,
      });
      supply = (data && data[0]) || null;
    }
  } catch (_) { supply = null; }

  // 5. Assemble a snapshot (same shape as buildStationSnapshot).
  const need = combinedScoreFromDomains(domains, state.weights);
  const usage = props.usage != null && props.usage !== "" ? Number(props.usage) : null;
  const supplyHomes = supply ? (Number(supply.dwellings_max_total) || 0) : null;
  const upliftPeople = supplyHomes != null ? Math.round(supplyHomes * PEOPLE_PER_HOME) : null;
  const population = popRes.population;
  const households = popRes.households;

  return {
    key: (props.crs && props.crs.toUpperCase()) || props.name,
    name: props.name || "Station",
    crs: props.crs || "",
    operator: props.operator || "",
    region: props.region || "",
    year: state.stationsMeta?.latest_year || "",
    walkMinutes: STATION_WALK_MINUTES,
    coords,
    need, usage,
    usagePctile: props.usage_pctile != null && props.usage_pctile !== "" ? Number(props.usage_pctile) : null,
    supplyHomes,
    supplySites: supply ? (Number(supply.n_sites) || 0) : null,
    supplyPublic: supply ? (Number(supply.n_public) || 0) : null,
    population,
    households,
    area_km2: popRes.area_km2,
    parts,
    interchanges: props.interchanges != null && props.interchanges !== "" ? Number(props.interchanges) : null,
    season_share: props.season_share != null && props.season_share !== "" ? Number(props.season_share) : null,
    trainsPerDay: props.trains_per_day != null && props.trains_per_day !== "" ? Number(props.trains_per_day) : null,
    peakTrains: props.peak_trains != null && props.peak_trains !== "" ? Number(props.peak_trains) : null,
    peakHourCount: props.peak_hour_count != null && props.peak_hour_count !== "" ? Number(props.peak_hour_count) : null,
    peakHourStart: props.peak_hour_start || null,
    firstDep: props.first_dep || null,
    lastDep: props.last_dep || null,
    directDestinations: props.direct_destinations != null && props.direct_destinations !== "" ? Number(props.direct_destinations) : null,
    keyCitiesCount: props.key_cities_count != null && props.key_cities_count !== "" ? Number(props.key_cities_count) : null,
    keyCities: Array.isArray(props.key_cities) ? props.key_cities : (props.key_cities ? String(props.key_cities).split("|") : []),
    connectivityPctile: props.connectivity_pctile != null && props.connectivity_pctile !== "" ? Number(props.connectivity_pctile) : null,
    usagePerResident: (usage != null && population) ? usage / population : null,
    upliftPeople,
    upliftPct: (upliftPeople != null && population) ? (upliftPeople / population) * 100 : null,
    homesUpliftPct: (supplyHomes != null && households) ? (supplyHomes / households) * 100 : null,
    domains: domains ? { ...domains } : null,
    capturedAt: new Date().toISOString(),
  };
}

// Jump the map to cover the catchment and resolve once the lsoa source has
// rendered tiles there, so querySourceFeatures returns the overlapping LSOAs.
function ensureTilesAt(catchment, coords) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; map.off("idle", onIdle); resolve(); };
    const onIdle = () => finish();
    try {
      let bbox = null;
      if (window.turf) { try { bbox = turf.bbox(catchment); } catch (_) {} }
      if (bbox) {
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
          { padding: 40, duration: 0, maxZoom: 13 });
      } else {
        map.jumpTo({ center: coords, zoom: 12 });
      }
    } catch (_) {
      try { map.jumpTo({ center: coords, zoom: 12 }); } catch (e) {}
    }
    map.on("idle", onIdle);
    // Safety timeout so a stuck tile fetch can't hang the whole batch.
    setTimeout(finish, 2500);
  });
}

// --- Live progress overlay --------------------------------------------------
function renderBatchProgress(done, total, currentName) {
  const el = document.getElementById("batch-results");
  if (!el) return;
  el.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (!el.querySelector(".batch-prog")) {
    el.innerHTML = `
      <div class="batch-backdrop"></div>
      <div class="batch-prog-wrap">
        <div class="batch-prog">
          <div class="bp-ring">
            <svg viewBox="0 0 120 120">
              <circle class="bp-track" cx="60" cy="60" r="52"></circle>
              <circle class="bp-fill" cx="60" cy="60" r="52"></circle>
            </svg>
            <div class="bp-pct">0%</div>
          </div>
          <div class="bp-title">Profiling stations…</div>
          <div class="bp-current"></div>
          <div class="bp-count"></div>
          <button class="bp-cancel" type="button">Cancel</button>
        </div>
      </div>`;
    el.querySelector(".bp-cancel").addEventListener("click", () => { batch.cancel = true; });
  }
  const circ = 2 * Math.PI * 52;
  const fill = el.querySelector(".bp-fill");
  if (fill) { fill.style.strokeDasharray = `${circ}`; fill.style.strokeDashoffset = `${circ * (1 - pct / 100)}`; }
  const pctEl = el.querySelector(".bp-pct"); if (pctEl) pctEl.textContent = `${pct}%`;
  const cur = el.querySelector(".bp-current"); if (cur) cur.textContent = currentName ? `Now: ${currentName}` : (done >= total ? "Finalising…" : "");
  const cnt = el.querySelector(".bp-count"); if (cnt) cnt.textContent = `${done} of ${total}`;
}

// --- The results dashboard (the showpiece) ----------------------------------
// Reopen the dashboard from the cached scored results (no recompute). Used when
// returning from a station drill-down so the batch isn't lost.
function reopenBatchResults() {
  if (batch.scored && batch.scored.length) {
    renderBatchResults(batch.results, batch.errors, batch.scored);
  }
}

function renderBatchResults(results, errors, preScored) {
  const el = document.getElementById("batch-results");
  if (!el) return;
  el.hidden = false;

  if (!results.length) {
    el.innerHTML = `
      <div class="batch-backdrop"></div>
      <div class="batch-dash">
        <div class="batch-dash-head"><h2>Batch analysis</h2><button class="batch-close" type="button">×</button></div>
        <div class="batch-dash-body"><p class="hint">No stations could be profiled${errors.length ? ` (${errors.length} failed)` : ""}. Try a different selection.</p></div>
      </div>`;
    el.querySelector(".batch-close").addEventListener("click", () => { el.hidden = true; el.innerHTML = ""; });
    return;
  }

  // Opportunity score (transparent, presentation-only composite for RANKING
  // only — the three signals stay separate in the display). Normalises each
  // signal 0-1 and weights need & supply highest (social-value lens), usage as
  // a supporting factor. Under-used + deprived + supply rises to the top.
  // Reuse the cached scoring when reopening, so order/values stay identical.
  const scored = preScored || results.map(r => {
    const needN = r.need == null ? 0 : clamp01(r.need / 100);
    const supplyN = r.supplyHomes == null ? 0 : clamp01(r.supplyHomes / SUPPLY_REF_HOMES);
    // Usage contributes INVERSELY for the "latent opportunity" reading: an
    // under-used station scores higher (more headroom). Use percentile.
    const usageHeadroom = r.usagePctile == null ? 0.5 : clamp01(1 - r.usagePctile / 100);
    const opp = Math.round((0.45 * needN + 0.40 * supplyN + 0.15 * usageHeadroom) * 100);
    return { ...r, opp, needN, supplyN, usageHeadroom };
  }).sort((a, b) => b.opp - a.opp);
  batch.scored = scored;   // cache for reopening after a drill-down

  // Aggregate headline numbers.
  const totalHomes = scored.reduce((s, r) => s + (r.supplyHomes || 0), 0);
  const totalUplift = scored.reduce((s, r) => s + (r.upliftPeople || 0), 0);
  const totalPublic = scored.reduce((s, r) => s + (r.supplyPublic || 0), 0);
  const avgNeed = Math.round(scored.reduce((s, r) => s + (r.need || 0), 0) / scored.length);
  const topPick = scored[0];

  const leagueRows = scored.map((r, i) => {
    const bars = triadBars(r);
    return `
      <button class="bl-row" data-key="${r.key}" style="--delay:${i * 45}ms">
        <span class="bl-rank">${i + 1}</span>
        <span class="bl-name">
          <span class="bl-name-main">${r.name}</span>
          <span class="bl-name-sub">${r.crs || ""}${r.region ? " · " + r.region : ""}</span>
        </span>
        <span class="bl-opp"><span class="bl-opp-n">${r.opp}</span><span class="bl-opp-l">opportunity</span></span>
        <span class="bl-sig">
          <span class="bl-sig-bar" title="Need ${r.need == null ? "n/a" : r.need.toFixed(0)}"><i style="width:0%;--w:${bars.needPct || 0}%;background:#d9772f"></i></span>
          <span class="bl-sig-bar" title="Supply ${r.supplyHomes == null ? "n/a" : r.supplyHomes}"><i style="width:0%;--w:${bars.supplyPct || 0}%;background:#3f9b5e"></i></span>
          <span class="bl-sig-bar" title="Usage pct ${r.usagePctile == null ? "n/a" : Math.round(r.usagePctile)}"><i style="width:0%;--w:${bars.usagePct || 0}%;background:#7a3ea8"></i></span>
        </span>
        <span class="bl-homes">${r.supplyHomes != null ? r.supplyHomes.toLocaleString() : "—"}<small>homes</small></span>
        ${(() => { const b = connectivityBand(r); return `<span class="bl-conn bl-conn-${b ? b.level : "none"}" title="${b ? b.label : "connectivity unknown"}${r.trainsPerDay != null ? " · " + r.trainsPerDay + " trains/day" : ""}">${b ? (b.level === "good" ? "●●●" : b.level === "moderate" ? "●●○" : "●○○") : "—"}</span>`; })()}
      </button>`;
  }).join("");

  el.innerHTML = `
    <div class="batch-backdrop"></div>
    <div class="batch-dash">
      <div class="batch-dash-head">
        <div>
          <div class="batch-eyebrow">Pipeline analysis · ${scored.length} stations</div>
          <h2>Opportunity assessment</h2>
        </div>
        <div class="batch-dash-actions">
          <button class="batch-shortlist-all" id="batch-shortlist-all" type="button">★ Shortlist all</button>
          <button class="batch-export" id="batch-export" type="button">Export report ↗</button>
          <button class="batch-close" type="button">×</button>
        </div>
      </div>

      <div class="batch-dash-body">
        <div class="batch-kpis">
          ${kpiCard("Top candidate", topPick.name, topPick.crs || topPick.region || "", "var(--accent)")}
          ${kpiCard("Total est. homes", totalHomes.toLocaleString(), `${totalPublic.toLocaleString()} on public land`, "#3f9b5e")}
          ${kpiCard("Modelled new residents", "+" + fmtCount(totalUplift), `at ${PEOPLE_PER_HOME}/home`, "#7a3ea8")}
          ${kpiCard("Avg. catchment need", avgNeed + "/100", "deprivation", "#d9772f")}
        </div>

        <div class="batch-cols">
          <div class="batch-col-main">
            <div class="batch-section-h">Opportunity league <span>need + supply + usage headroom</span></div>
            <div class="batch-league">${leagueRows}</div>
          </div>
          <div class="batch-col-side">
            <div class="batch-section-h">Need vs supply <span>bubble = usage</span></div>
            <div class="batch-quad" id="batch-quad">${batchQuadrantSVG(scored)}</div>
            <p class="batch-quad-key">Top-right = deprived <em>and</em> land-rich — the priority quadrant. Bubble size = passenger usage.</p>
          </div>
        </div>

        ${errors.length ? `<p class="batch-errs">${errors.length} station(s) couldn't be profiled: ${errors.slice(0, 6).map(e => e.name).join(", ")}${errors.length > 6 ? "…" : ""}.</p>` : ""}
      </div>
    </div>`;

  // Wire close + actions.
  const close = () => { el.hidden = true; el.innerHTML = ""; };
  el.querySelector(".batch-close").addEventListener("click", close);
  el.querySelector(".batch-backdrop").addEventListener("click", close);
  el.querySelector("#batch-export").addEventListener("click", () => {
    const html = buildReportHTML(scored);
    const w = window.open("", "_blank");
    if (!w) { alert("Pop-up blocked — allow pop-ups to open the report."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  });
  el.querySelector("#batch-shortlist-all").addEventListener("click", () => {
    let added = 0;
    for (const r of scored) { if (shortlist.add(r)) added++; }
    const tray = document.getElementById("shortlist-tray"); if (tray) tray.dataset.dismissed = "";
    updateShortlistTray();
    el.querySelector("#batch-shortlist-all").textContent = `★ Added ${added}`;
  });

  // Drilling into a station from the batch: remember we came from the batch so
  // the deep dive can offer "← Back to results" and reopen the dashboard on exit.
  const drillInto = (key, name) => {
    close();
    batch.returnAfterDeepDive = true;
    const feats = (state.stationsData && state.stationsData.features) || [];
    const hit = feats.find(f => ((f.properties.crs || "").toUpperCase() === key) || f.properties.name === name);
    if (hit) { state.selectedStation = hit.properties; profileStation(hit.properties, null); }
    else { batch.returnAfterDeepDive = false; }
  };

  // Row click → open that station's full deep dive (keeps the batch to return to).
  el.querySelectorAll(".bl-row").forEach(row => {
    row.addEventListener("click", () => {
      const r = scored.find(x => x.key === row.dataset.key);
      if (!r) return;
      drillInto(r.key, r.name);
    });
  });
  el.querySelectorAll(".bl-row .bl-quad-dot, .batch-quad [data-key]").forEach(d => {
    d.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const k = d.getAttribute("data-key");
      const r = scored.find(x => x.key === k); if (!r) return;
      drillInto(k, r.name);
    });
  });

  // Trigger the bar-grow animation on next frame.
  requestAnimationFrame(() => {
    el.querySelectorAll(".bl-sig-bar i").forEach(i => { i.style.width = i.style.getPropertyValue("--w"); });
  });
}

function kpiCard(label, big, sub, color) {
  return `<div class="batch-kpi" style="--kpi:${color}">
    <div class="batch-kpi-l">${label}</div>
    <div class="batch-kpi-v">${big}</div>
    <div class="batch-kpi-s">${sub}</div>
  </div>`;
}

// A need-vs-supply scatter ("priority quadrant"), bubbles sized by usage.
function batchQuadrantSVG(scored) {
  const W = 300, H = 300, pad = 30;
  // Scale supply to the batch's OWN max so the bubbles fill the vertical range
  // (a fixed reference would clamp land-rich batches all to the top).
  const maxHomes = Math.max(1, ...scored.map(r => r.supplyHomes || 0));
  const x = (needVal) => pad + (clamp01((needVal || 0) / 100)) * (W - 2 * pad);
  const y = (homes) => (H - pad) - clamp01((homes || 0) / maxHomes) * (H - 2 * pad);
  const maxUsage = Math.max(1, ...scored.map(r => r.usage || 0));

  // Place dots, then nudge labels vertically to reduce obvious collisions.
  const placed = scored.map((r, i) => ({
    r, i,
    cx: x(r.need),
    cy: y(r.supplyHomes),
    rad: 5 + 9 * Math.sqrt((r.usage || 0) / maxUsage),
    top: i < 3,
  }));
  const dots = placed.map(p => {
    const { r, cx, cy, rad, top, i } = p;
    // Label above by default; if another top dot is close above, drop below.
    let ly = cy - rad - 4;
    if (top) {
      const clash = placed.some(q => q !== p && q.top &&
        Math.abs(q.cx - cx) < 26 && Math.abs((q.cy - q.rad - 4) - ly) < 11);
      if (clash) ly = cy + rad + 11;
    }
    return `<g class="bq-dot" data-key="${r.key}" style="--delay:${i * 40}ms">
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}"
        fill="${top ? "rgba(224,163,46,0.88)" : "rgba(122,62,168,0.6)"}"
        stroke="#fff" stroke-width="1.2"></circle>
      ${top ? `<text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="bq-lbl">${r.crs || r.name.slice(0, 6)}</text>` : ""}
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="bq-svg">
    <defs><linearGradient id="bqg" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="rgba(255,255,255,0.02)"/>
      <stop offset="1" stop-color="rgba(224,163,46,0.12)"/>
    </linearGradient></defs>
    <rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${H - 2 * pad}" fill="url(#bqg)" stroke="var(--ink-line)"/>
    <line x1="${W / 2}" y1="${pad}" x2="${W / 2}" y2="${H - pad}" stroke="var(--ink-line)" stroke-dasharray="3 3"/>
    <line x1="${pad}" y1="${H / 2}" x2="${W - pad}" y2="${H / 2}" stroke="var(--ink-line)" stroke-dasharray="3 3"/>
    <text x="${W - pad}" y="${H - 9}" text-anchor="end" class="bq-axis">more deprived →</text>
    <text x="${pad - 8}" y="${pad - 12}" class="bq-axis">↑ more land</text>
    ${dots}
  </svg>`;
}

function stationSectionHTML(st) {
  const usage = (st.usage != null) ? Number(st.usage) : null;
  const trend = st.trend || [];
  const changePct = trendChangePct(trend);
  const arrow = changePct == null ? "" : changePct > 1 ? "▲" : changePct < -1 ? "▼" : "▬";
  const cls = changePct == null ? "" : changePct > 1 ? "up" : changePct < -1 ? "down" : "flat";
  const meta = [];
  if (st.crs) meta.push(`CRS ${st.crs}`);
  if (st.operator) meta.push(st.operator);

  const trendBlock = trend.length >= 2 ? `
    <div class="st-trend">
      <div class="st-spark">${sparklineSVG(trend, STATION_COLOR)}</div>
      <div class="st-trend-meta">
        ${changePct == null ? "" : `<span class="st-trend-pct ${cls}">${arrow} ${Math.abs(changePct).toFixed(0)}%</span>`}
        <span class="dim">${trend[0].year}–${trend[trend.length - 1].year}</span>
      </div>
    </div>` : "";

  if (st.region) meta.push(st.region);
  const chips = stationStatChips(st);
  const quality = stationQualityNote(st, st.year);

  return `
    <section class="dd-block" data-section="station">
      <button class="dd-block-head" type="button" aria-expanded="true">
        <span class="dd-h">Usage · this station</span><span class="dd-caret">▾</span>
      </button>
      <div class="dd-block-content">
        <div class="dd-score">
          <div class="dd-score-big">${usage == null ? "—" : fmtCount(usage)}<span> entries/exits</span></div>
          <div class="dd-score-cap">Annual passenger usage${st.year ? ` · ${st.year}` : ""}</div>
        </div>
        ${trendBlock}
        ${chips}
        <div class="dd-stat-cell" id="dd-usage-per-resident" style="margin-top:8px;display:none">
          <div class="dd-stat-num" id="dd-upr-value">—</div>
          <div class="dd-stat-cap">Annual usage per catchment resident</div>
        </div>
        ${quality}
        ${meta.length ? `<p class="hint" style="margin-top:8px">${meta.join(" · ")}</p>` : ""}
        <p class="hint" style="margin-top:6px">Usage is the transit-asset signal — shown alongside need (deprivation) and, soon, developable supply, kept as separate measures rather than one blended score.</p>
      </div>
    </section>`;
}

// Fill the "usage per resident" figure once the catchment population is known.
// A LOW value in a populous catchment = an under-used station relative to who
// lives nearby — a strong regeneration signal.
function renderUsagePerResident() {
  const cell = document.getElementById("dd-usage-per-resident");
  const val = document.getElementById("dd-upr-value");
  if (!cell || !val || !deep.station) return;
  const usage = deep.station.usage;
  const pop = deep.population;
  if (usage == null || pop == null || pop <= 0) { cell.style.display = "none"; return; }
  const perResident = usage / pop;
  val.textContent = perResident >= 100 ? Math.round(perResident).toLocaleString()
    : perResident.toFixed(1);
  cell.style.display = "";
}

function buildDeepDivePanel(meta) {
  const toggles = AMENITY_KINDS.map(a => `
    <label class="dd-row">
      <input type="checkbox" class="enable" id="dd-${a.kind}" />
      <span class="dd-swatch" style="background:${a.color}"></span>
      <span class="dd-label">${a.label}</span>
      <span class="dd-stat" id="dd-stat-${a.kind}"></span>
    </label>`).join("");

  const configured = !!getSupabase();
  const note = configured ? "" :
    `<p class="hint" style="margin-top:10px">Connect Supabase (see config.js) to load amenity layers.</p>`;

  const panel = document.getElementById("deepdive-panel");
  const fromBatch = batch.returnAfterDeepDive;
  panel.innerHTML = `
    ${fromBatch ? `<button class="dd-back" id="dd-back-batch" type="button">← Back to batch results</button>` : ""}
    <div class="dd-head">
      <div>
        <div class="dd-eyebrow">${meta.eyebrow || "Deep dive"}</div>
        <div class="dd-title">${meta.title || "Selected area"}</div>
        <div class="dd-subtitle">${meta.subtitle || ""}</div>
      </div>
      <button class="dd-close" aria-label="Close deep dive" title="Close">×</button>
    </div>

    <div class="dd-body">
      ${meta.station ? developableSectionHTML(meta.station) : ""}
      ${meta.station ? `
      <section class="dd-block" data-section="viability">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Viability — residual appraisal</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div id="dd-viability-summary"><p class="hint">Turn on the developable-land tool above — the appraisal prices its dwelling capacity.</p></div>
          <button type="button" class="ghost" id="dd-viab-vars">Viability variables…</button>
          <button type="button" class="ghost" id="dd-viab-calc">Full calculation…</button>
        </div>
      </section>
      <section class="dd-block" data-section="assembly">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Site assembly</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <p class="hint">Group several developable plots into one site, appraise the whole, and export a structured site report with a map extract.</p>
          <button type="button" id="dd-assemble-toggle" class="plot-mode-btn">▶ Assemble a site</button>
          <div id="dd-assembly-summary"></div>
        </div>
      </section>` : ""}
      ${meta.station ? `<section class="dd-synthesis" id="dd-synthesis"></section>` : ""}
      ${meta.station ? stationSectionHTML(meta.station) : ""}

      <section class="dd-block" data-section="score">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">${meta.station ? "Need · deprivation" : "Deprivation"}</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div class="dd-score">
            <div class="dd-score-big" id="dd-score-value">—<span>/100</span></div>
            <div class="dd-score-cap">${meta.scoreCaption || "Combined deprivation · weighted"}</div>
          </div>
          <p class="dd-score-summary" id="dd-score-summary"></p>
          <div class="dd-domain-list" id="dd-domain-list"></div>
          <p class="hint" style="margin-top:8px">Higher = more deprived (national percentile). Adjust the weighting sliders on the left to see the headline change live.</p>
        </div>
      </section>

      <section class="dd-block" data-section="catchment">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Catchment</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div class="dd-stats-grid" id="dd-catchment-stats">
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-pop-value">—</div>
              <div class="dd-stat-cap">Est. population</div>
            </div>
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-homes-value">—</div>
              <div class="dd-stat-cap">Existing homes</div>
            </div>
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-area-value">—</div>
              <div class="dd-stat-cap">Area</div>
            </div>
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-density-value">—</div>
              <div class="dd-stat-cap">Density / km²</div>
            </div>
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-value-value">—</div>
              <div class="dd-stat-cap">House price £/m²</div>
            </div>
          </div>
          <p class="hint" id="dd-pop-note" style="margin-top:8px">Population is area-weighted from the LSOAs the catchment overlaps, assuming people are spread evenly within each.</p>
        </div>
      </section>

      <section class="dd-block" data-section="brownfield">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Developable land · supply</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <label class="dd-row dd-row-all">
            <input type="checkbox" class="enable" id="dd-brownfield-show" />
            <span class="dd-label"><strong>Brownfield sites</strong></span>
            <span class="dd-stat" id="dd-brownfield-status"></span>
          </label>
          <div class="dd-bf-filters">
            <label class="dd-bf-filter">
              <span>Min. homes</span>
              <select id="dd-bf-mindwellings">
                <option value="0">Any</option>
                <option value="10">10+</option>
                <option value="25">25+</option>
                <option value="50">50+</option>
                <option value="100">100+</option>
                <option value="250">250+</option>
              </select>
            </label>
            <label class="dd-bf-check"><input type="checkbox" id="dd-bf-public" /> Public-owned only</label>
            <label class="dd-bf-check"><input type="checkbox" id="dd-bf-deliverable" /> Deliverable only</label>
          </div>
          <div id="dd-brownfield-summary"></div>
          <p class="hint" style="margin-top:8px">Brownfield Land Register sites (England, MHCLG). The "supply" signal alongside need and usage. Coverage depends on what each local authority has published, so absence of a site isn't proof there's no opportunity.</p>
        </div>
      </section>

      <section class="dd-block" data-section="amenities">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Amenities in this area</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <label class="dd-row dd-row-all">
            <input type="checkbox" class="enable" id="dd-all-amenities" />
            <span class="dd-label"><strong>All amenities</strong></span>
            <span class="dd-stat" id="dd-stat-all"></span>
          </label>
          <div class="dd-toggles">${toggles}</div>
          ${note}
          <p class="hint" style="margin-top:8px">Each shows the count in the catchment and, where population is known, the rate per 1,000 residents. Toggle a layer to map it.</p>
        </div>
      </section>

      <section class="dd-block" data-section="access">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Nearest access</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div class="dd-access-list" id="dd-access-list"></div>
          <p class="hint" style="margin-top:8px">Real travel distance &amp; time by road to the closest of each, shown as coloured routes on the map.</p>
        </div>
      </section>
    </div>`;

  setDeepPanelOpen(true);
  panel.querySelector(".dd-close").addEventListener("click", exitDeepDive);
  const backBtn = panel.querySelector("#dd-back-batch");
  if (backBtn) backBtn.addEventListener("click", exitDeepDive);
  panel.querySelectorAll(".dd-block-head").forEach(head => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".dd-show-toggle")) return;
      const block = head.closest(".dd-block");
      const open = block.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", open ? "false" : "true");
    });
  });
  for (const a of AMENITY_KINDS) {
    const cb = panel.querySelector(`#dd-${a.kind}`);
    if (cb) cb.addEventListener("change", (e) => {
      toggleAmenityKind(a.kind, e.target.checked);
      syncAllAmenitiesCheckbox();
    });
  }
  const allCb = panel.querySelector("#dd-all-amenities");
  if (allCb) allCb.addEventListener("change", (e) => toggleAllAmenities(e.target.checked));

  // Brownfield (developable supply) controls.
  const bfShow = panel.querySelector("#dd-brownfield-show");
  if (bfShow) bfShow.addEventListener("change", (e) => toggleBrownfield(e.target.checked));
  const bfMin = panel.querySelector("#dd-bf-mindwellings");
  if (bfMin) bfMin.addEventListener("change", (e) => {
    deep.brownfieldFilters.minDwellings = parseInt(e.target.value, 10) || 0;
    refreshBrownfield();
  });
  const bfPublic = panel.querySelector("#dd-bf-public");
  if (bfPublic) bfPublic.addEventListener("change", (e) => {
    deep.brownfieldFilters.publicOnly = e.target.checked;
    refreshBrownfield();
  });
  const bfDeliv = panel.querySelector("#dd-bf-deliverable");
  if (bfDeliv) bfDeliv.addEventListener("change", (e) => {
    deep.brownfieldFilters.deliverableOnly = e.target.checked;
    refreshBrownfield();
  });

  // Developable-land + dwelling-capacity controls (station profiles only).
  wireDevelopableControls(panel);
  // Viability variables from the deep dive: same modal, deep-dive context —
  // edits re-render this panel's appraisal AND re-score the sift, because
  // there is deliberately only one assumption set.
  const at = panel.querySelector("#dd-assemble-toggle");
  if (at) at.addEventListener("click", () => {
    if (!deep.developableVisible || !deep.developableResult) {
      renderAssemblySummary("Turn on the developable-land tool first — the plots are what you assemble.");
      return;
    }
    setAssembleMode(!deep.assembly.active);
  });
  // One context builder for both viability buttons — variables and the full
  // calculation audit must describe the same scheme or the audit lies.
  const ddViabCtx = () => {
    const r = deep.developableResult;
    const regime = activeDevelopableRegime();
    return {
      label: (meta.station && (meta.station.name || meta.station.crs)) || "This catchment",
      units: r ? homesFor(Number(r.developable_ha) || 0, Number(r.inner_ha) || 0, regime) : 0,
      ppm2: deep.ppm2 || null,
      region: null,
      areaHa: r ? Number(r.developable_ha) : null,
      locationFactor: (deep._marketCtx && deep._marketCtx.factor) || null,
      landValueHa: (deep._marketCtx && deep._marketCtx.landValueHa) || null,
      onChange: () => { renderDeepDiveViability(); if (SIFT.loaded) scoreSiftRows(); },
    };
  };
  const dv = panel.querySelector("#dd-viab-vars");
  if (dv) dv.addEventListener("click", () => openViabilityModal(ddViabCtx()));
  const dc = panel.querySelector("#dd-viab-calc");
  if (dc) dc.addEventListener("click", () => openCalcAudit(ddViabCtx()));

  // Fill the deprivation headline, breakdown bars and plain-English summary.
  renderDeprivationScore();
  // Fetch the precomputed catchment IMD + population and use them as the
  // authoritative Need / Catchment read-outs (consistent with the sift).
  if (meta.station && meta.station.crs) loadStationAssessment(meta.station.crs);
  // Developable land is the headline of a station profile — auto-run it so the
  // hero box populates on open (rather than waiting for a manual tick).
  if (meta.station) {
    const devCb = panel.querySelector("#dd-developable-show");
    if (devCb) { devCb.checked = true; toggleDevelopable(true); }
  }
}

// Fetch the precomputed station_assessments row for a station profile and use it
// as the AUTHORITATIVE source for the Need (regeneration) headline and catchment
// population — the same values the sift uses. The live vector-tile read-outs are
// fragile (they depend on which LSOA tiles are loaded), so this guarantees the
// deep dive always scores and stays consistent with the sift. Replaces the old
// composite "socio-economic benefit" section (removed per review — the Need block
// now IS the broken-down IMD for the zone).
async function loadStationAssessment(crs) {
  const sb = (typeof getSupabase === "function") ? getSupabase() : null;
  if (!sb || !crs) return;
  try {
    const { data, error } = await sb.from("station_assessments")
      .select("catchment_imd, catchment_pop, catchment_income, catchment_health, catchment_education, regen_score, catchment_ppm2, catchment_median_price")
      .eq("crs", crs).single();
    if (error) throw error;
    if (!data) return;
    deep.assessment = data;
    // Population fallback: if the tile-derived estimate came back empty, use the
    // precomputed catchment population.
    if (deep.population == null && data.catchment_pop != null) {
      deep.population = Number(data.catchment_pop);
      deep.popFromDb = true;
      renderCatchmentStats();
    }
    // Sales value: the sift priced this station with catchment_ppm2, so the
    // dive's appraisal MUST use the same number — the client-side estimate
    // (viewport-dependent, often simply absent) was quietly nulling out and
    // dropping every appraisal to the national £350/ft² fallback.
    if (data.catchment_ppm2 != null) {
      deep.ppm2 = Number(data.catchment_ppm2);
      if (data.catchment_median_price != null)
        deep.medianPrice = Number(data.catchment_median_price);
      deep.ppm2FromDb = true;
      renderCatchmentStats();
      renderDeepDiveViability();
    }
    // Re-render the Need headline / breakdown now the DB fallback is available,
    // and the synthesis block — its triad + sentence read the same need value
    // via buildStationSnapshot and may have rendered before this row arrived.
    renderDeprivationScore();
    if (typeof renderStationSynthesis === "function") renderStationSynthesis();
  } catch (err) {
    console.warn("station assessment load failed", err.message);
  }
}

// DOMAINS labelled for the breakdown (shorter labels than the slider names).
const DOMAIN_LABELS = {
  income: "Income", employment: "Employment", education: "Education & skills",
  health: "Health & disability", crime: "Crime",
  housing: "Barriers to housing", environment: "Living environment",
};

// Turn a 0-100 deprivation percentile into plain English. Higher = more
// deprived, so a high value means among the MOST deprived nationally.
function depBand(v) {
  if (v == null || isNaN(v)) return "no data";
  if (v >= 90) return "among the 10% most deprived nationally";
  if (v >= 75) return "among the 25% most deprived nationally";
  if (v >= 50) return "more deprived than the national average";
  if (v >= 25) return "less deprived than the national average";
  if (v >= 10) return "among the 25% least deprived nationally";
  return "among the 10% least deprived nationally";
}

// Recompute and render the deprivation headline, breakdown and summary from the
// stored per-domain averages using the CURRENT weights. Called on panel build
// and whenever the weighting changes (so the score is live).
function renderDeprivationScore() {
  const domains = deep.domains;
  const valEl = document.getElementById("dd-score-value");
  const sumEl = document.getElementById("dd-score-summary");
  const listEl = document.getElementById("dd-domain-list");
  if (!valEl) return;

  // Live, weight-driven score from the LSOA vector tiles. For a STATION profile
  // this can be null if the tiles for the catchment aren't loaded yet — fall back
  // to the precomputed catchment IMD percentile from station_assessments (the same
  // value the sift uses), so the Need headline always scores.
  let score = combinedScoreFromDomains(domains, state.weights);
  const dbImd = deep.assessment && deep.assessment.catchment_imd;
  if ((score == null || isNaN(score)) && dbImd != null) score = Number(dbImd);
  valEl.innerHTML = (score == null || isNaN(score))
    ? `—<span>/100</span>`
    : `${score.toFixed(0)}<span>/100</span>`;

  // Plain-English summary of the overall position + the standout domain.
  if (sumEl) {
    if (score == null) {
      sumEl.textContent = "";
    } else {
      // Find the domain this area scores worst on (highest deprivation).
      let worst = null;
      for (const d of DOMAINS) {
        const v = domains && domains[d.key];
        if (v == null) continue;
        if (!worst || v > worst.v) worst = { key: d.key, v };
      }
      let txt = `Overall, this area is ${depBand(score)}.`;
      if (worst && worst.v >= 50) {
        txt += ` It is ${depBand(worst.v)} for ${DOMAIN_LABELS[worst.key].toLowerCase()}.`;
      }
      sumEl.textContent = txt;
    }
  }

  // Per-domain breakdown bars.
  if (listEl) {
    if (!domains) {
      // Tiles not available — show the precomputed catchment sub-domains we hold
      // in station_assessments (income / health / education) as a fallback so the
      // zone's deprivation is still broken down.
      const a = deep.assessment;
      if (a && (a.catchment_income != null || a.catchment_health != null || a.catchment_education != null)) {
        const row = (label, v) => v == null ? "" : `
          <div class="dd-domain-row" title="${depBand(Number(v))}">
            <span class="dd-domain-label">${label}</span>
            <span class="dd-domain-bar"><span style="width:${Math.max(0, Math.min(100, Number(v))).toFixed(0)}%"></span></span>
            <span class="dd-domain-val">${Number(v).toFixed(0)}</span>
          </div>`;
        listEl.innerHTML = row("Income", a.catchment_income) + row("Health & disability", a.catchment_health) +
          row("Education & skills", a.catchment_education);
      } else {
        listEl.innerHTML = "";
      }
      return;
    }
    listEl.innerHTML = DOMAINS.map(d => {
      const v = domains[d.key];
      if (v == null || isNaN(v)) return "";
      const off = !state.enabled[d.key];
      return `
        <div class="dd-domain-row ${off ? "dd-domain-off" : ""}" title="${depBand(v)}">
          <span class="dd-domain-label">${DOMAIN_LABELS[d.key]}</span>
          <span class="dd-domain-bar"><span style="width:${Math.max(0, Math.min(100, v)).toFixed(0)}%"></span></span>
          <span class="dd-domain-val">${v.toFixed(0)}</span>
        </div>`;
    }).join("");
  }
}

function setDeepPanelOpen(open) {
  const panel = document.getElementById("deepdive-panel");
  if (!panel) return;
  panel.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
}

// ---- Plot / isochrone catchments ------------------------------------------
// Three ways to define an area of interest: a point, a drawn plot, or (later)
// an uploaded plot. From that geometry we build a catchment — by default a
// 15-minute walking isochrone (street-network travel time) via the public
// Valhalla server, with adjustable mode and time — and run the SAME deep dive
// on it. The deprivation score for such a catchment is an AREA-WEIGHTED blend
// of the LSOAs it overlaps (see areaWeightedScore).

const ISO_MODES = [
  { id: "pedestrian", label: "Walk" },
  { id: "bicycle",    label: "Cycle" },
  { id: "auto",       label: "Drive" },
];

const plot = {
  geometry: null,   // the defining point or polygon (GeoJSON geometry)
  mode: "pedestrian",
  minutes: 15,
};

// Area-weighted deprivation for an arbitrary catchment polygon. For each LSOA
// the catchment overlaps, we weight that LSOA's per-domain normalised scores by
// its share of the total overlap area. Returns per-domain averages (0-100) plus
// the count of contributing LSOAs. Storing PER-DOMAIN values (not a single
// number) is what lets the headline score and breakdown update live when the
// user changes the weighting — exactly like the main map.
// Zone polygons currently in the tiles across BOTH deprivation layers — England
// LSOAs (layer 'lsoa') and Scotland Data Zones (layer 'simd') — so catchment
// aggregations work either side of the border. SIMD's access domain is baked in
// as environment_norm, so the same per-domain code applies to both.
function catchmentZoneFeatures() {
  const out = [];
  for (const sl of [SOURCE_LAYER, "simd"]) {
    let fs = [];
    try { fs = map.querySourceFeatures("lsoa", { sourceLayer: sl }); } catch (_) {}
    for (const f of fs) out.push(f);
  }
  return out;
}
// Stable id for a zone feature: England LSOA code or Scotland Data Zone code.
function zoneId(props) { return (props && (props.lsoa_code || props.data_zone)) || null; }

// Cheap bbox-overlap gate in front of turf.intersect. intersect costs
// milliseconds per polygon, and at national zoom the loaded tiles hold tens
// of thousands of zones — running it on every one froze the UI for 30s+ on
// each deep-dive open. A single-pass bbox reject cuts the intersect set to
// the handful of zones actually near the (sub-km) catchment.
function _zoneBboxHits(catchment) {
  const cb = turf.bbox(catchment);
  return f => {
    let fb;
    try { fb = turf.bbox(f); } catch (_) { return false; }
    return fb[0] <= cb[2] && cb[0] <= fb[2] && fb[1] <= cb[3] && cb[1] <= fb[3];
  };
}

function areaWeightedScore(catchment) {
  if (!window.turf) return { domains: null, parts: 0 };
  const feats = catchmentZoneFeatures();
  if (!feats.length) return { domains: null, parts: 0 };

  const near = _zoneBboxHits(catchment);
  const seen = new Set();
  let totalArea = 0;
  const contribs = [];   // { a, props }
  for (const f of feats) {
    const code = zoneId(f.properties);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    if (!near(f)) continue;
    let inter;
    try {
      inter = turf.intersect(turf.featureCollection([catchment, f]));
    } catch (_) { inter = null; }
    if (!inter) continue;
    let a;
    try { a = turf.area(inter); } catch (_) { a = 0; }
    if (a <= 0) continue;
    contribs.push({ a, props: f.properties });
    totalArea += a;
  }
  if (!totalArea) return { domains: null, parts: 0 };

  // Area-weighted average of each domain's *_norm value, plus overall.
  const domains = {};
  const keys = DOMAINS.map(d => d.key).concat(["overall"]);
  for (const k of keys) {
    let acc = 0, wsum = 0;
    for (const c of contribs) {
      const v = c.props[`${k}_norm`];
      if (v == null || isNaN(v)) continue;
      acc += v * c.a;
      wsum += c.a;
    }
    domains[k] = wsum > 0 ? acc / wsum : null;
  }
  return { domains, parts: contribs.length };
}

// Area-weighted resident population for an arbitrary catchment polygon. Unlike
// the deprivation score (an AVERAGE of percentiles), population is a COUNT, so
// we SUM each overlapping LSOA's population scaled by the share of that LSOA's
// area falling inside the catchment. This assumes population is spread evenly
// within an LSOA — the standard areal-interpolation approximation — which is
// reasonable at LSOA scale and clearly the right call for isochrone catchments
// where we have no finer breakdown. Returns { population, area_km2, parts,
// partial } where `partial` flags that some overlapping LSOAs lacked a
// population value (so the figure is a floor, not exact).
function areaWeightedPopulation(catchment) {
  const out = { population: null, households: null, area_km2: null, parts: 0, partial: false, ppm2: null, medianPrice: null };
  if (!window.turf) return out;

  let area_m2 = 0;
  try { area_m2 = turf.area(catchment); } catch (_) { area_m2 = 0; }
  out.area_km2 = area_m2 > 0 ? area_m2 / 1e6 : null;

  const feats = catchmentZoneFeatures();
  if (!feats.length) return out;

  const seen = new Set();
  let pop = 0;
  let hh = 0;
  let counted = 0;
  let missing = 0;
  let hhCounted = 0;
  // House-price value over the catchment, area-weighted by each LSOA's overlap
  // (the polygons carry price_ppm2 / price_median from build_price_choropleth).
  let ppmSum = 0, ppmW = 0, mpSum = 0, mpW = 0;
  const near = _zoneBboxHits(catchment);
  for (const f of feats) {
    const props = f.properties || {};
    const code = zoneId(props);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    if (!near(f)) continue;

    let inter;
    try {
      inter = turf.intersect(turf.featureCollection([catchment, f]));
    } catch (_) { inter = null; }
    if (!inter) continue;

    let interArea, lsoaArea;
    try { interArea = turf.area(inter); } catch (_) { interArea = 0; }
    if (interArea <= 0) continue;
    try { lsoaArea = turf.area(f); } catch (_) { lsoaArea = 0; }
    if (lsoaArea <= 0) continue;

    const share = Math.min(1, interArea / lsoaArea);
    const lsoaPop = props.population;
    if (lsoaPop == null || isNaN(lsoaPop)) { missing++; continue; }
    pop += Number(lsoaPop) * share;
    counted++;

    // Existing households (same areal-weighting). Independent of population
    // availability — an LSOA may carry one but not the other.
    const lsoaHh = props.households;
    if (lsoaHh != null && !isNaN(lsoaHh)) { hh += Number(lsoaHh) * share; hhCounted++; }

    // Value: weight £/m² and median sale price by the overlap area.
    const ppm = props.price_ppm2, mp = props.price_median;
    if (ppm != null && !isNaN(ppm)) { ppmSum += Number(ppm) * interArea; ppmW += interArea; }
    if (mp != null && !isNaN(mp)) { mpSum += Number(mp) * interArea; mpW += interArea; }
  }

  out.parts = counted + missing;
  if (counted > 0) {
    out.population = Math.round(pop);
    out.partial = missing > 0;
  }
  if (hhCounted > 0) out.households = Math.round(hh);
  if (ppmW > 0) out.ppm2 = Math.round(ppmSum / ppmW);
  if (mpW > 0) out.medianPrice = Math.round(mpSum / mpW);
  return out;
}

// People per km² from a population + area, or null if either is missing.
function densityPerKm2(population, area_km2) {
  if (population == null || area_km2 == null || area_km2 <= 0) return null;
  return population / area_km2;
}

// Amenities per 1,000 residents, or null if population is unknown/zero.
function per1000(count, population) {
  if (population == null || population <= 0 || count == null) return null;
  return (count / population) * 1000;
}

// Combined score from stored per-domain averages, using the CURRENT weights and
// enable toggles. Mirrors combinedScore() but reads the catchment's domain
// averages instead of a single LSOA's props.
function combinedScoreFromDomains(domains, weights) {
  if (!domains) return null;
  let wsum = 0, acc = 0;
  for (const d of DOMAINS) {
    if (!state.enabled[d.key]) continue;
    const v = domains[d.key];
    if (v == null) continue;
    acc += weights[d.key] * v;
    wsum += weights[d.key];
  }
  return wsum > 0 ? acc / wsum : null;
}

// Build an isochrone polygon from a point via the public Valhalla server.
// Returns a GeoJSON Polygon Feature, or null only if even the fallback fails.
//
// The FOSSGIS demo server is free and shared, with a fair-usage rate limit, so
// transient drops show up in the browser as "Failed to fetch" (a network-level
// failure with no status). We send the X-Client-Id header they ask of apps,
// apply a timeout, and retry with backoff. If the service still can't be
// reached, we AUTOMATICALLY fall back to a straight-line circular catchment so
// the analysis always proceeds — the returned feature is tagged
// properties._approx = true so the UI can flag it as approximate.
async function fetchIsochrone(lng, lat, mode, minutes, opts = {}) {
  // Circle method selected (the default): skip the network entirely and return
  // an instant straight-line catchment. Tagged _circle so the UI can label it.
  // opts.forceNetwork bypasses that station-tool preference — used by the PBSA
  // catchment's own precise toggle, which decides independently.
  if (!opts.forceNetwork && state.catchmentMethod === "circle") {
    const circ = circularCatchment(lng, lat, minutes);
    if (circ) { circ.properties = circ.properties || {}; circ.properties._circle = true; return circ; }
    // If turf somehow isn't available, fall through to the network path.
  }

  const body = {
    locations: [{ lat, lon: lng }],
    costing: mode,
    contours: [{ time: minutes }],
    polygons: true,
  };
  const url = "https://valhalla1.openstreetmap.de/isochrone?json=" +
    encodeURIComponent(JSON.stringify(body));

  const attempts = 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
      const r = await fetch(url, {
        headers: { "X-Client-Id": "mastermapper.github" },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (r.status === 429) throw new Error("rate-limited");
      if (!r.ok) throw new Error(`Valhalla HTTP ${r.status}`);
      const gj = r.json ? await r.json() : null;
      const feats = (gj && gj.features) || [];
      const poly = feats.find(f => f.geometry &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
      if (poly) return poly;                       // success — real street-network isochrone
      throw new Error("no polygon in response");
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
      dbg("isochrone attempt", i + 1, "failed:", e.message);
      if (/HTTP 4(?!29)/.test(e.message)) break;   // don't retry a real client error
      if (i < attempts - 1) await sleep(700 * (i + 1));
    }
  }

  // Routing unavailable after retries → automatic circular fallback so the
  // analysis still runs. Tagged approximate; callers surface a quiet notice.
  dbg("isochrone falling back to circular catchment:", lastErr && lastErr.message);
  const circ = circularCatchment(lng, lat, minutes);
  if (circ) {
    circ.properties = circ.properties || {};
    circ.properties._approx = true;
    return circ;
  }
  // Only if even the fallback can't be built (turf missing) do we fail.
  const err = new Error(lastErr ? lastErr.message : "unknown error");
  throw err;
}

// Circular catchment: a straight-line approximation using an average walk speed
// (~4.8 km/h ≈ 80 m/min). Ignores the street network, so it overstates reach a
// little, but lets analysis proceed when routing is down. GeoJSON polygon or null.
function circularCatchment(lng, lat, minutes) {
  if (!window.turf) return null;
  const radiusKm = (minutes * 80) / 1000;
  try {
    return turf.circle([lng, lat], radiusKm, { units: "kilometers", steps: 48 });
  } catch (_) { return null; }
}

// Given the defining geometry (point or plot) and the iso settings, build the
// catchment and launch the deep dive on it.
async function runPlotDeepDive() {
  if (!plot.geometry) { alert("Define a point or plot first."); return; }

  // Use the geometry's centroid as the isochrone origin (works for both a point
  // and a drawn plot).
  let origin;
  try {
    origin = turf.centroid({ type: "Feature", geometry: plot.geometry }).geometry.coordinates;
  } catch (_) {
    alert("Couldn't read that geometry."); return;
  }
  const [lng, lat] = origin;

  const modeLabel = (ISO_MODES.find(m => m.id === plot.mode) || {}).label || plot.mode;
  setPlotStatus(`Building ${plot.minutes}-min ${modeLabel.toLowerCase()} isochrone…`);

  let catchment;
  try {
    catchment = await fetchIsochrone(lng, lat, plot.mode, plot.minutes);
  } catch (e) {
    setPlotStatus(`Couldn't build isochrone — ${e.message}. The free routing service may be busy; wait a few seconds and try again.`);
    return;
  }
  if (!catchment) { setPlotStatus("No catchment returned for that point."); return; }
  const circle = !!(catchment.properties && (catchment.properties._circle || catchment.properties._approx));
  const fellBack = !!(catchment.properties && catchment.properties._approx);
  setPlotStatus(fellBack ? "Routing busy — used an approximate circular catchment." : "");

  const { domains, parts } = areaWeightedScore(catchment);
  runDeepDive(catchment, {
    eyebrow: circle ? "Circular catchment" : "Isochrone deep dive",
    title: `${plot.minutes}-min ${circle ? "circular" : modeLabel.toLowerCase()}`,
    subtitle: parts ? `Area-weighted across ${parts} LSOA${parts === 1 ? "" : "s"}` : "Catchment analysis",
    domains,                      // per-domain averages → live re-weighting + breakdown
    scoreCaption: "Area-weighted deprivation · weighted",
  });
}

function setPlotStatus(msg) {
  const el = document.getElementById("plot-status");
  if (el) el.textContent = msg || "";
}

// Set the plot origin point at a lng/lat. Shared by the desktop click handler
// and the touch-tap handler (MapLibre's click doesn't fire on touch).
function dropPlotPoint(lngLat) {
  state.plotPointMode = false;
  map.getCanvas().style.cursor = "";
  plot.geometry = { type: "Point", coordinates: [lngLat.lng, lngLat.lat] };
  const data = { type: "FeatureCollection", features: [{ type: "Feature", geometry: plot.geometry, properties: {} }] };
  if (map.getSource("plot-point-src")) map.getSource("plot-point-src").setData(data);
  else {
    map.addSource("plot-point-src", { type: "geojson", data });
    map.addLayer({
      id: "plot-point-dot", type: "circle", source: "plot-point-src",
      paint: { "circle-radius": 7, "circle-color": "#111", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
  }
  setPlotStatus("Point set. Choose mode/time, then build the catchment.");
}


// ============================================================================
// PBSA sift · University rail access (box 3). Pick a university -> show its
// HESA demand profile, gateway stations (walkable to a campus) and feeder
// stations (direct train into a gateway), ranked by adjustable criteria and
// drawn on the map (colour-banded dots + arcs). Powered by the
// uni_rail_access() RPC; degrades honestly to gateways-only until the
// station_links table is loaded (needs National Rail credentials).
// ============================================================================

const pbsa = {
  unis: null,          // cached uni_campus features [{name, ukprn, props, coords}]
  selected: null,      // {name, ukprn, ...}
  data: null,          // uni_rail_access payload
  maxMin: 45,
  minTrains: 10,
  catchModes: { walk: false, cycle: false, rail: false },  // ADDITIVE toggles
  catchZones: {},      // mode -> built zone (GeoJSON feature)
  catchSeqs: {},       // mode -> build token (newer build supersedes in-flight)
  catchMins: 30,
  catchPrecise: false, // true = street-network isochrones instead of rings
};

const PBSA_BANDS = [
  { max: 20, color: "#2f9e44", label: "under 20 min" },
  { max: 40, color: "#e0a32e", label: "20–40 min" },
  { max: 60, color: "#e8590c", label: "40–60 min" },
  { max: 999, color: "#c92a2a", label: "60+ min" },
];
function pbsaBand(mins) {
  return PBSA_BANDS.find(b => (mins ?? 999) <= b.max) || PBSA_BANDS[PBSA_BANDS.length - 1];
}

async function pbsaLoadUnis() {
  if (pbsa.unis) return pbsa.unis;
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc("features_in_bbox",
    { p_dataset: "uni_campus", w: -9, s: 49, e: 2.5, n: 61.5, lim: 600 });
  if (error || !data || !Array.isArray(data.features)) return null;
  pbsa.unis = data.features
    .filter(f => f.geometry && f.geometry.type === "Point")
    .map(f => ({
      name: f.properties.name || "HE provider",
      ukprn: f.properties.ukprn,
      props: f.properties,
      coords: f.geometry.coordinates,
      hay: (f.properties.name || "").toLowerCase(),
    }))
    .sort((a, b) => (Number(b.props.students_total) || 0) - (Number(a.props.students_total) || 0));
  return pbsa.unis;
}

// Find the selected university's OTHER campuses (OSM campus polygons near the
// HQ, or name/operator-matched further out) so catchments and the deep dive
// treat a multi-site institution as multi-site — not just the HQ dot.
async function pbsaLoadCampuses(u) {
  const ukprn = String(u.ukprn || "");
  if (pbsa.campusesFor === ukprn && pbsa.campuses) return pbsa.campuses;
  const sb = getSupabase();
  if (!sb || typeof turf === "undefined") return [];
  const lng = u.coords ? u.coords[0] : u.lng, lat = u.coords ? u.coords[1] : u.lat;
  if (lng == null || lat == null) return [];
  const dd = 0.12;                                // ~13 km search box
  try {
    const { data, error } = await sb.rpc("features_in_bbox", {
      p_dataset: "uni_campus_site", w: lng - dd, s: lat - dd, e: lng + dd, n: lat + dd,
      lim: 400, p_zoom: 12 });
    if (error || !data) return [];
    const norm = s => String(s || "").toLowerCase()
      .replace(/\b(the|university|univ|of|college|london)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
    const uniTokens = norm(u.name).split(/\s+/).filter(t => t.length > 3);
    const out = [];
    for (const f of data.features || []) {
      if (!f.geometry) continue;
      let c;
      try { c = turf.centroid(f).geometry.coordinates; } catch (_) { continue; }
      const distM = _distMeters({ lng, lat }, { lng: c[0], lat: c[1] });
      if (distM < 250) continue;                  // that's the HQ site itself
      const hay = norm(`${f.properties.name || ""} ${f.properties.operator || ""}`);
      const tokenHit = uniTokens.some(t => hay.includes(t));
      // Near the HQ = almost certainly theirs; further out needs a name match.
      if (distM <= 3000 || (tokenHit && distM <= 12000))
        out.push({ name: f.properties.name || f.properties.operator || "Campus",
                   lng: c[0], lat: c[1], distM: Math.round(distM) });
    }
    out.sort((a, b) => a.distM - b.distM);
    pbsa.campuses = out.slice(0, 12);
    pbsa.campusesFor = ukprn;
    return pbsa.campuses;
  } catch (_) { return []; }
}

function wirePbsaBox() {
  const input = document.getElementById("pbsa-uni-input");
  const results = document.getElementById("pbsa-uni-results");
  if (!input || !results) return;

  const render = (matches) => {
    if (!matches.length) { results.hidden = true; results.innerHTML = ""; return; }
    results.hidden = false;
    results.innerHTML = matches.map((m, i) => `
      <button type="button" class="station-result" data-i="${i}">
        <span class="sr-name">${m.name}</span>
        <span class="sr-meta">${m.props.students_total ? Number(m.props.students_total).toLocaleString() + " students" : (m.props.groups || "")}</span>
      </button>`).join("");
    results.querySelectorAll(".station-result").forEach(btn =>
      btn.addEventListener("click", () => {
        const m = matches[parseInt(btn.dataset.i, 10)];
        input.value = m.name;
        results.hidden = true;
        pbsaSelect(m);
      }));
  };

  let lastMatches = [];
  input.addEventListener("input", async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { results.hidden = true; return; }
    const unis = await pbsaLoadUnis();
    if (!unis) { results.hidden = false; results.innerHTML = "<div class='hint' style='padding:8px'>University list unavailable (database offline?)</div>"; return; }
    lastMatches = unis.filter(u => u.hay.includes(q)).slice(0, 8);
    render(lastMatches);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && lastMatches.length) {
      e.preventDefault();
      input.value = lastMatches[0].name;
      results.hidden = true;
      pbsaSelect(lastMatches[0]);
    } else if (e.key === "Escape") results.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("pbsa-block").contains(e.target)) results.hidden = true;
  });

  const maxMin = document.getElementById("pbsa-max-min");
  const maxMinVal = document.getElementById("pbsa-max-min-val");
  if (maxMin) maxMin.addEventListener("input", () => {
    pbsa.maxMin = parseInt(maxMin.value, 10);
    if (maxMinVal) maxMinVal.textContent = `${pbsa.maxMin} min`;
    pbsaRender();
  });
  const minTrains = document.getElementById("pbsa-min-trains");
  if (minTrains) minTrains.addEventListener("change", () => {
    pbsa.minTrains = Math.max(1, parseInt(minTrains.value, 10) || 10);
    minTrains.value = pbsa.minTrains;
    pbsaRender();
  });
  const clearBtn = document.getElementById("pbsa-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    pbsa.selected = pbsa.data = null;
    input.value = "";
    document.getElementById("pbsa-summary").innerHTML = "";
    document.getElementById("pbsa-feeders").innerHTML = "";
    document.getElementById("pbsa-criteria").hidden = true;
    const catchBox = document.getElementById("pbsa-catchment");
    if (catchBox) catchBox.hidden = true;
    clearBtn.hidden = true;
    pbsaCatchClear();
    pbsaClearViz();
  });

  // --- Build catchment controls (ADDITIVE: each mode stacks its own zone) ---
  document.querySelectorAll(".catch-mode").forEach(btn =>
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const m = btn.dataset.mode;
      const on = !pbsa.catchModes[m];
      pbsa.catchModes[m] = on;
      btn.classList.toggle("on", on);
      if (on) {
        const firstZone = !Object.values(pbsa.catchZones).some(Boolean);
        pbsaBuildCatchment(m, firstZone);
      } else {
        delete pbsa.catchZones[m];
        pbsa.catchSeqs[m] = (pbsa.catchSeqs[m] || 0) + 1;   // cancel in-flight build
        pbsaCatchRedraw();
      }
    }));
  const catchMins = document.getElementById("catch-mins");
  const catchMinsVal = document.getElementById("catch-mins-val");
  let catchDebounce = null;
  if (catchMins) catchMins.addEventListener("input", () => {
    pbsa.catchMins = parseInt(catchMins.value, 10);
    if (catchMinsVal) catchMinsVal.textContent = `${pbsa.catchMins} min`;
    clearTimeout(catchDebounce);
    catchDebounce = setTimeout(pbsaRebuildCatchments, 400);
  });
  const precise = document.getElementById("catch-precise");
  if (precise) precise.addEventListener("change", () => {
    pbsa.catchPrecise = precise.checked;
    pbsaRebuildCatchments();
  });
  const catchClear = document.getElementById("catch-clear");
  if (catchClear) catchClear.addEventListener("click", pbsaCatchClear);
}

// Rebuild every active mode's zone (slider / precise-toggle changes).
function pbsaRebuildCatchments() {
  for (const m of Object.keys(pbsa.catchModes))
    if (pbsa.catchModes[m]) pbsaBuildCatchment(m, false);
}

async function pbsaSelect(u) {
  pbsa.selected = u;
  const summary = document.getElementById("pbsa-summary");
  summary.innerHTML = `<p class="hint">Loading rail access for ${u.name}…</p>`;
  const sb = getSupabase();
  if (!sb) { summary.innerHTML = `<p class="hint">Database unavailable.</p>`; return; }
  const { data, error } = await sb.rpc("uni_rail_access", { p_ukprn: String(u.ukprn) });
  if (error || !data) {
    console.error("uni_rail_access failed", error);
    summary.innerHTML = `<p class="hint">Could not load rail access (${error?.message || "no data"}).</p>`;
    return;
  }
  pbsa.data = data;
  document.getElementById("pbsa-criteria").hidden = false;
  document.getElementById("pbsa-clear").hidden = false;
  const catchBox = document.getElementById("pbsa-catchment");
  if (catchBox) catchBox.hidden = false;
  pbsaCatchClear();   // a catchment built for the previous university is stale
  pbsa.campuses = null; pbsa.campusesFor = null;
  pbsaLoadCampuses(u).then(() => { if (pbsa.selected === u) pbsaRender(); });
  pbsaRenderSummary();
  pbsaRender();
  // Frame the university with some breathing room.
  if (data.university) {
    map.flyTo({ center: [data.university.lng, data.university.lat], zoom: 9, duration: 900 });
  }
}

function pbsaRenderSummary() {
  const d = pbsa.data, u = d.university || {};
  const p = u.props || {};
  const chip = (label, v) => v == null ? "" :
    `<div class="pbsa-chip"><div class="pbsa-chip-v">${v}</div><div class="pbsa-chip-l">${label}</div></div>`;
  const total = p.students_total ? Number(p.students_total).toLocaleString() : null;
  const chips = [
    chip("students", total),
    chip("international", p.intl_pct != null ? p.intl_pct + "%" : null),
    chip("in PBSA", p.pbsa_pct != null ? p.pbsa_pct + "%" : null),
    chip("in HMO/rented", p.rented_pct != null ? p.rented_pct + "%" : null),
  ].join("");
  const demand = (p.students_fulltime && p.rented_pct != null)
    ? `<p class="hint">≈ <strong>${Math.round(p.students_fulltime * p.rented_pct / 100).toLocaleString()}</strong> full-time students privately renting — the addressable pool PBSA competes for.</p>`
    : "";
  const linksNote = d.links_loaded ? "" :
    `<p class="hint pbsa-warn">Rail journey links aren't loaded yet (needs the free National Rail Open Data credentials — docs/MANUAL_TASKS.md). Showing walkable gateway stations only.</p>`;
  _uniPanelCtx = { p: { ...p, name: u.name || p.name, ukprn: u.ukprn ?? p.ukprn },
                   lng: u.lng, lat: u.lat };
  document.getElementById("pbsa-summary").innerHTML =
    `<div class="pbsa-chips">${chips}</div>${demand}${linksNote}` +
    `<button type="button" class="deepdive-btn uni-dd-open">Full deep dive →</button>`;
}

function pbsaFilteredFeeders() {
  const d = pbsa.data;
  if (!d || !Array.isArray(d.feeders)) return [];
  return d.feeders.filter(f =>
    (f.minutes == null || f.minutes <= pbsa.maxMin) &&
    (f.trains_day == null || f.trains_day >= pbsa.minTrains))
    .slice(0, 60);
}

function pbsaRender() {
  const d = pbsa.data;
  if (!d) return;
  const host = document.getElementById("pbsa-feeders");
  const gws = d.gateways || [];
  const feeders = pbsaFilteredFeeders();
  let html = "";
  if (gws.length) {
    html += `<div class="pbsa-sec">Gateway stations (walkable)</div>` +
      gws.slice(0, 8).map(g =>
        `<button type="button" class="pbsa-row" data-lng="${g.lng}" data-lat="${g.lat}">
           <span class="pbsa-row-name">${g.name}</span>
           <span class="pbsa-row-meta">${g.walk_m} m walk</span></button>`).join("");
  } else {
    html += `<p class="hint">No stations within walking distance of the campus.</p>`;
  }
  if (d.links_loaded) {
    html += `<div class="pbsa-sec">Feeder stations (direct train in)</div>`;
    html += feeders.length ? feeders.map(f => {
      const band = pbsaBand(f.minutes);
      return `<button type="button" class="pbsa-row" data-lng="${f.lng}" data-lat="${f.lat}">
        <span class="pbsa-dot" style="background:${band.color}"></span>
        <span class="pbsa-row-name">${f.name}</span>
        <span class="pbsa-row-meta">${f.minutes != null ? Math.round(f.minutes) + " min" : "—"} · ${f.trains_day ?? "?"}/day</span>
      </button>`;
    }).join("") : `<p class="hint">No feeder stations pass the current criteria — loosen them above.</p>`;
  }
  host.innerHTML = html;
  host.querySelectorAll(".pbsa-row").forEach(btn =>
    btn.addEventListener("click", () =>
      map.flyTo({ center: [parseFloat(btn.dataset.lng), parseFloat(btn.dataset.lat)], zoom: 13, duration: 700 })));
  pbsaDrawViz(gws, feeders);
}

// --- Map visualisation: campus halo, gateway rings, feeder dots + arcs -----
function pbsaDrawViz(gws, feeders) {
  const d = pbsa.data;
  if (!d || !d.university) return;
  const uni = d.university;
  const fc = (features) => ({ type: "FeatureCollection", features });
  const pt = (lng, lat, props) => ({ type: "Feature", properties: props || {},
    geometry: { type: "Point", coordinates: [lng, lat] } });

  // The HQ dot plus every matched campus, so multi-site institutions read as
  // what they are. (The feeder->campus arc lines are gone — they streaked
  // across the whole map and added noise, not information.)
  const campus = fc([pt(uni.lng, uni.lat, { name: uni.name }),
    ...(pbsa.campuses || []).map(c => pt(c.lng, c.lat, { name: c.name }))]);
  const gwFc = fc(gws.map(g => pt(g.lng, g.lat, { name: g.name, walk_m: g.walk_m })));
  const fdFc = fc(feeders.map(f => pt(f.lng, f.lat,
    { name: f.name, minutes: f.minutes, trains: f.trains_day,
      color: pbsaBand(f.minutes).color })));

  const ensure = (id, def) => {
    if (map.getSource(id)) { map.getSource(id).setData(def.data); return; }
    map.addSource(id, { type: "geojson", data: def.data });
    def.layers.forEach(l => map.addLayer(l));
  };
  ensure("pbsa-feeder-pts", { data: fdFc, layers: [{
    id: "pbsa-feeder-dot", type: "circle", source: "pbsa-feeder-pts",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 4, 12, 7],
             "circle-color": ["get", "color"],
             "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2 } }] });
  ensure("pbsa-gateways", { data: gwFc, layers: [{
    id: "pbsa-gateway-ring", type: "circle", source: "pbsa-gateways",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 7, 12, 12],
             "circle-color": "rgba(0,0,0,0)",
             "circle-stroke-color": "#0ca678", "circle-stroke-width": 3 } }] });
  ensure("pbsa-campus", { data: campus, layers: [{
    id: "pbsa-campus-halo", type: "circle", source: "pbsa-campus",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 10, 12, 18],
             "circle-color": "rgba(112,72,232,0.25)",
             "circle-stroke-color": "#7048e8", "circle-stroke-width": 3 } }] });

  if (!map.getLayer("pbsa-feeder-tip-wired")) {
    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    map.on("mouseenter", "pbsa-feeder-dot", (e) => {
      const p = e.features[0].properties;
      map.getCanvas().style.cursor = "pointer";
      pop.setLngLat(e.lngLat)
        .setHTML(`<strong>${p.name}</strong> · ${p.minutes != null ? Math.round(p.minutes) + " min" : ""} · ${p.trains ?? "?"} trains/day`)
        .addTo(map);
    });
    map.on("mouseleave", "pbsa-feeder-dot", () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    // Sentinel so the handlers wire once (layer never actually added).
    map.addLayer({ id: "pbsa-feeder-tip-wired", type: "background",
                   layout: { visibility: "none" }, paint: {} });
  }
}

function pbsaClearViz() {
  for (const id of ["pbsa-feeder-dot", "pbsa-gateway-ring", "pbsa-campus-halo"])
    if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ["pbsa-feeder-pts", "pbsa-gateways", "pbsa-campus"])
    if (map.getSource(id)) map.removeSource(id);
}

// --- Build catchment: travel-time zone + fade-back mask ---------------------
// Everywhere someone could live and still reach the campus within the time
// budget. Rail mode is the honest one — real timetable minutes (station_links)
// for the train leg, walking legs at 4.8 km/h, a fixed 5-minute interchange —
// so each reachable station gets a ring sized by the minutes LEFT after the
// journey. Walk/cycle modes are labelled straight-line approximations
// (speed × time × a detour factor), not street routing.

const CATCH_WALK_MPM = 62;    // effective straight-line metres/min at 4.8 km/h
const CATCH_CYCLE_MPM = 185;  // effective straight-line metres/min at ~15 km/h
const CATCH_INTERCHANGE_MIN = 5;
const CATCH_COLORS = { walk: "#2f9e44", cycle: "#0ca678", rail: "#7048e8" };

async function pbsaBuildCatchment(mode, fit) {
  const d = pbsa.data;
  const note = document.getElementById("catch-note");
  if (!d || !d.university) return;
  if (typeof turf === "undefined") {
    if (note) note.textContent = "Catchment maths needs the Turf library, which didn't load — check the network and refresh.";
    return;
  }
  const seq = pbsa.catchSeqs[mode] = (pbsa.catchSeqs[mode] || 0) + 1;
  const uni = d.university;
  const T = pbsa.catchMins;
  const circle = (lng, lat, meters) =>
    turf.circle([lng, lat], Math.max(meters, 150) / 1000, { steps: 40, units: "kilometers" });

  // Every catchment is a union of travel "sites": each has coordinates, the
  // minutes of onward travel from it, and the ring radius those minutes buy.
  // The precise toggle swaps rings for real street-network isochrones.
  // Multi-campus: every matched campus is a starting point, not just the HQ.
  const campuses = await pbsaLoadCampuses(pbsa.selected ||
    { ukprn: uni.ukprn, name: uni.name, lng: uni.lng, lat: uni.lat });
  if (pbsa.catchSeqs[mode] !== seq) return;
  const origins = [{ lng: uni.lng, lat: uni.lat }, ...(campuses || [])];

  const sites = [];
  let noteText = "";
  let reached = 0;
  if (mode === "walk" || mode === "cycle") {
    const speed = mode === "walk" ? CATCH_WALK_MPM : CATCH_CYCLE_MPM;
    for (const o of origins) sites.push({ lng: o.lng, lat: o.lat, mins: T, radiusM: T * speed });
    noteText = `${T} min ${mode === "walk" ? "walking (4.8 km/h)" : "cycling (~15 km/h)"}` +
      (origins.length > 1 ? ` from all ${origins.length} campuses` : "");
  } else {
    for (const o of origins) sites.push({ lng: o.lng, lat: o.lat, mins: T, radiusM: T * CATCH_WALK_MPM });
    const gwWalkMin = {};
    for (const g of d.gateways || []) {
      const w = (g.walk_m ?? 1200) / CATCH_WALK_MPM;
      gwWalkMin[g.crs] = w;
      const r = T - w;
      if (r > 3) sites.push({ lng: g.lng, lat: g.lat, mins: r, radiusM: r * CATCH_WALK_MPM });
    }
    const feeders = (d.feeders || [])
      .filter(f => f.minutes != null && (f.trains_day ?? 0) >= pbsa.minTrains)
      .map(f => {
        const total = f.minutes + CATCH_INTERCHANGE_MIN + (gwWalkMin[f.via_crs] ?? 12);
        return { ...f, remaining: T - total };
      })
      .filter(f => f.remaining > 3)
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 200);
    for (const f of feeders) {
      sites.push({ lng: f.lng, lat: f.lat, mins: f.remaining, radiusM: f.remaining * CATCH_WALK_MPM });
      reached++;
    }
    noteText = d.links_loaded
      ? `${reached} station${reached === 1 ? "" : "s"} reachable door-to-campus in ≤ ${T} min (timetable train times + walking legs + ${CATCH_INTERCHANGE_MIN} min interchange). Respects the min trains/day criterion above.`
      : `Rail journey links aren't loaded yet, so this shows the walking zone only — run the rail-links workflow to light up the full rail catchment.`;
  }

  const discs = [];
  if (pbsa.catchPrecise) {
    // Street-network isochrones via the free OSM Valhalla service. Calls are
    // sequential and capped to be kind to it; the biggest zones (most map
    // area) get the precise treatment, the tail keeps rings; any failed call
    // quietly falls back to that site's ring.
    const MAX_ISO = 18;
    const isoMode = mode === "cycle" ? "bicycle" : "pedestrian";
    const ordered = sites.slice().sort((a, b) => b.mins - a.mins);
    const isoSites = ordered.slice(0, MAX_ISO);
    const restSites = ordered.slice(MAX_ISO);
    let isoReal = 0, isoApprox = 0;
    for (let i = 0; i < isoSites.length; i++) {
      if (pbsa.catchSeqs[mode] !== seq) return;   // superseded mid-fetch
      if (note) note.textContent = `Fetching ${mode} street isochrones… ${i + 1}/${isoSites.length}`;
      const s2 = isoSites[i];
      let poly = null;
      try {
        poly = await fetchIsochrone(s2.lng, s2.lat, isoMode,
          Math.max(2, Math.round(s2.mins)), { forceNetwork: true });
      } catch (_) {}
      if (pbsa.catchSeqs[mode] !== seq) return;
      if (poly && !(poly.properties && (poly.properties._approx || poly.properties._circle))) {
        discs.push(poly); isoReal++;
      } else {
        discs.push(poly || circle(s2.lng, s2.lat, s2.radiusM)); isoApprox++;
      }
    }
    for (const s2 of restSites) discs.push(circle(s2.lng, s2.lat, s2.radiusM));
    noteText += isoReal
      ? ` Street-network isochrones for the ${isoReal} biggest zone${isoReal === 1 ? "" : "s"}` +
        (isoApprox || restSites.length ? ` (${isoApprox + restSites.length} smaller ones stay as rings)` : "") +
        ` — routing © OpenStreetMap/Valhalla.`
      : ` The routing service wasn't reachable — showing detour-adjusted rings instead.`;
  } else {
    for (const s2 of sites) discs.push(circle(s2.lng, s2.lat, s2.radiusM));
    if (mode === "walk" || mode === "cycle")
      noteText += " — a straight-line ring adjusted for street detours; tick the precise option for true street-network isochrones.";
    else if (d.links_loaded)
      noteText += " Rings are detour-adjusted straight-line zones; tick the precise option for street-network isochrones.";
  }

  // Dissolve into one zone. Turf v7 unions a FeatureCollection; fall back to
  // the v6 pairwise signature if that's what loaded.
  let zone = discs[0];
  for (let i = 1; i < discs.length; i++) {
    let merged = null;
    try { merged = turf.union(turf.featureCollection([zone, discs[i]])); } catch (_) {}
    if (!merged) { try { merged = turf.union(zone, discs[i]); } catch (_) {} }
    if (merged) zone = merged;
  }
  if (!zone || pbsa.catchSeqs[mode] !== seq) return;

  pbsa.catchZones[mode] = zone;
  pbsaCatchRedraw();
  if (note) note.textContent = noteText;
  if (fit) {
    try {
      const bb = turf.bbox(zone);
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 48, duration: 900 });
    } catch (_) {}
  }
}

// World-with-holes polygon so everything OUTSIDE the zone gets a dim wash.
function pbsaCatchMask(zone) {
  const worldRing = [[-180, -85], [-180, 85], [180, 85], [180, -85], [-180, -85]];
  const g = zone.geometry;
  const outers = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map(c => c[0]);
  return { type: "Feature", properties: {},
           geometry: { type: "Polygon", coordinates: [worldRing, ...outers] } };
}

const CATCH_MODE_ORDER = ["walk", "cycle", "rail"];

function _pbsaCatchLayerIds() {
  const ids = ["pbsa-catch-dim"];
  for (const m of CATCH_MODE_ORDER) ids.push(`pbsa-catch-${m}-fill`, `pbsa-catch-${m}-line`);
  return ids;
}

// Redraw the whole catchment stack from pbsa.catchZones. Layer order matters:
// translucent mode fills first (so overlaps blend), then the dim mask (holes =
// union of every active zone), then each mode's boundary line on top.
function pbsaCatchRedraw() {
  for (const id of _pbsaCatchLayerIds()) if (map.getLayer(id)) map.removeLayer(id);
  const active = CATCH_MODE_ORDER.filter(m => pbsa.catchZones[m]);
  const clearBtn = document.getElementById("catch-clear");
  if (!active.length) {
    for (const m of CATCH_MODE_ORDER)
      if (map.getSource(`pbsa-catch-${m}`)) map.removeSource(`pbsa-catch-${m}`);
    if (map.getSource("pbsa-catch-mask")) map.removeSource("pbsa-catch-mask");
    if (clearBtn) clearBtn.hidden = true;
    const note = document.getElementById("catch-note");
    if (note && !Object.values(pbsa.catchModes).some(Boolean)) note.textContent = "";
    return;
  }
  const setOrAdd = (id, data) => {
    if (map.getSource(id)) map.getSource(id).setData(data);
    else map.addSource(id, { type: "geojson", data });
  };
  // Translucent fills, in a fixed order so colours blend predictably.
  for (const m of active) {
    setOrAdd(`pbsa-catch-${m}`, pbsa.catchZones[m]);
    map.addLayer({ id: `pbsa-catch-${m}-fill`, type: "fill", source: `pbsa-catch-${m}`,
      paint: { "fill-color": CATCH_COLORS[m], "fill-opacity": 0.16 } });
  }
  // Dim wash outside the UNION of every active zone.
  let union = pbsa.catchZones[active[0]];
  for (let i = 1; i < active.length; i++) {
    let merged = null;
    try { merged = turf.union(turf.featureCollection([union, pbsa.catchZones[active[i]]])); } catch (_) {}
    if (!merged) { try { merged = turf.union(union, pbsa.catchZones[active[i]]); } catch (_) {} }
    if (merged) union = merged;
  }
  setOrAdd("pbsa-catch-mask", pbsaCatchMask(union));
  map.addLayer({ id: "pbsa-catch-dim", type: "fill", source: "pbsa-catch-mask",
    paint: { "fill-color": "#0b0d10", "fill-opacity": 0.5 } });
  // Boundary lines above the mask, one colour per mode.
  for (const m of active) {
    map.addLayer({ id: `pbsa-catch-${m}-line`, type: "line", source: `pbsa-catch-${m}`,
      layout: { "line-join": "round" },
      paint: { "line-color": CATCH_COLORS[m], "line-width": 2.8, "line-opacity": 0.95 } });
  }
  if (clearBtn) clearBtn.hidden = false;
}

function pbsaCatchClear() {
  for (const m of Object.keys(pbsa.catchModes)) {
    pbsa.catchModes[m] = false;
    pbsa.catchSeqs[m] = (pbsa.catchSeqs[m] || 0) + 1;    // cancel in-flight builds
  }
  pbsa.catchZones = {};
  document.querySelectorAll(".catch-mode").forEach(b => b.classList.remove("on"));
  pbsaCatchRedraw();
  const note = document.getElementById("catch-note");
  if (note) note.textContent = "";
}

// ---- Portfolio scorer (priority-1 tool) ------------------------------------
// Upload a landholder's holdings (CSV of postcodes / lat-lng, or GeoJSON
// polygons); every site is scored server-side by polygon_summary() and ranked.
// Free-data heuristics, honestly labelled: Policy leans on constraint
// coverage + the HDT presumption signal + brownfield overlap; Access on
// station distance; the composite is a screen, not an appraisal.

const pf = { sites: [], results: [], running: false };

function wirePortfolioBox() {
  const file = document.getElementById("pf-file");
  if (!file) return;
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      await pfLoadFile(f);
    } catch (err) {
      pfStatus(`Could not read that file: ${err.message}`);
    }
  });
  const exp = document.getElementById("pf-export");
  if (exp) exp.addEventListener("click", pfExportCsv);
  const rep = document.getElementById("pf-report");
  if (rep) rep.addEventListener("click", pfPrintReport);
  const clr = document.getElementById("pf-clear");
  if (clr) clr.addEventListener("click", pfClear);
}

// Printable portfolio report: one section per site (ranked), everything the
// scorer knows, in a clean print stylesheet. Opens a new tab and invokes the
// browser's print dialog — save as PDF from there.
function pfPrintReport() {
  if (!pf.results.length) return;
  const esc = s => String(s ?? "").replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CONSTRAINT_LABELS = k => k.replace(/_/g, " ");
  const secs = pf.results.map((r, i) => {
    const s = r.summary || {};
    const areas = s.areas || {};
    const cons = (s.constraints || [])
      .map(c => `<li>${esc(CONSTRAINT_LABELS(c.kind))} — ${esc(c.pct)}% of site</li>`).join("")
      || "<li>No planning or environmental designations touch this site.</li>";
    const sales = (s.recent_sales || [])
      .map(x => `<li>£${Number(x.price).toLocaleString()} · ${esc(x.date)} · ${esc(x.ptype)} · ${Math.round(x.dist_m)} m away</li>`).join("");
    const gsub = s.nearest_grid_substation;
    const rows = [
      s.area_ha != null ? ["Site area", `${s.area_ha} ha`] : null,
      areas.lad_boundary ? ["Authority", areas.lad_boundary.name] : null,
      areas.hdt && areas.hdt.hdt_pct != null
        ? ["Housing Delivery Test", `${areas.hdt.hdt_pct}% delivery`] : null,
      areas.planit_rates && areas.planit_rates.approval_pct != null
        ? ["Approval rate (3 yr)", `${areas.planit_rates.approval_pct}%`] : null,
      s.grey_belt_pct != null ? ["Grey-belt potential (model)", `${s.grey_belt_pct}% of site`] : null,
      s.brownfield_overlap ? ["Registered brownfield on site", `${s.brownfield_overlap} site(s)`] : null,
      s.council_property ? ["Public-authority property on site", `${s.council_property} point(s)`] : null,
      r.stationM != null ? ["Nearest station", `${esc(r.stationName || "")} · ${(r.stationM / 1000).toFixed(1)} km`] : null,
      gsub ? ["Nearest grid substation", `${esc(gsub.name || "")} (${esc(gsub.kv)} kV) · ${(gsub.dist_m / 1000).toFixed(1)} km`] : null,
      areas.la_rents && areas.la_rents.rent_mean != null
        ? ["Average private rent", `£${Number(areas.la_rents.rent_mean).toLocaleString()}/mo`] : null,
    ].filter(Boolean).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("");
    return `<section${i ? ' class="pb"' : ""}>
      <h2>#${i + 1} ${esc(r.name)} <span class="score s${r.scores.total >= 70 ? "g" : r.scores.total >= 45 ? "a" : "r"}">${r.scores.total}</span></h2>
      <p class="sub">Policy ${r.scores.policy} · Access ${r.scores.access}${r.centroid ? ` · ${r.centroid[1].toFixed(5)}, ${r.centroid[0].toFixed(5)}` : ""}</p>
      <table>${rows}</table>
      <h3>Designation coverage</h3><ul>${cons}</ul>
      ${sales ? `<h3>Recent sales nearby</h3><ul>${sales}</ul>` : ""}
    </section>`;
  }).join("");
  const w = window.open("", "_blank");
  if (!w) { pfStatus("Pop-up blocked — allow pop-ups to print the report."); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Portfolio appraisal — ${pf.results.length} sites</title>
    <style>
      body{font:13px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2533;margin:2.2em;}
      h1{font-size:1.5em;margin:0 0 .2em;} .muted{color:#6c7a89;margin:0 0 1.6em;}
      h2{font-size:1.15em;margin:1.4em 0 .1em;border-bottom:1.5px solid #dee2e6;padding-bottom:.25em;}
      h3{font-size:.95em;margin:.9em 0 .25em;} .sub{color:#6c7a89;margin:.15em 0 .7em;}
      table{border-collapse:collapse;} th{text-align:left;padding:.18em 1.2em .18em 0;color:#495057;font-weight:600;white-space:nowrap;vertical-align:top;}
      td{padding:.18em 0;} ul{margin:.25em 0 .8em 1.2em;padding:0;}
      .score{float:right;font-size:1.05em;padding:.05em .5em;border-radius:5px;color:#fff;}
      .s\\.g,.sg{background:#2f9e44;} .sa{background:#f59f00;} .sr{background:#e03131;}
      .pb{page-break-before:always;}
      @media print { .noprint{display:none;} }
    </style></head><body>
    <h1>Portfolio appraisal</h1>
    <p class="muted">${pf.results.length} sites, ranked by MasterMapper composite score · generated ${new Date().toLocaleDateString("en-GB")} · heuristic screen, not advice — verify against the local plan.</p>
    ${secs}
    <script>setTimeout(function(){window.print();}, 400);<\/script>
    </body></html>`);
  w.document.close();
}

function pfStatus(msg) {
  const el = document.getElementById("pf-status");
  if (el) el.textContent = msg || "";
}

async function pfLoadFile(f) {
  pfClear();
  const text = await f.text();
  let sites = [];
  if (/\.(geojson|json)$/i.test(f.name) || text.trim().startsWith("{")) {
    const gj = JSON.parse(text);
    const feats = gj.type === "FeatureCollection" ? gj.features : [gj];
    sites = feats.filter(x => x && x.geometry).map((x, i) => ({
      name: String(x.properties?.name || x.properties?.id || `Site ${i + 1}`),
      geometry: x.geometry,
    }));
  } else {
    sites = await pfParseCsv(text);
  }
  if (!sites.length) { pfStatus("No usable sites found in that file."); return; }
  if (sites.length > 200) { pfStatus(`${sites.length} sites — scoring the first 200.`); sites = sites.slice(0, 200); }
  pf.sites = sites;
  await pfScoreAll();
}

async function pfParseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)
    .map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, -1);
  const head = split(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (names) => head.findIndex(h => names.some(n => h === n || h.includes(n)));
  const iLat = idx(["lat", "latitude", "y"]);
  const iLng = idx(["lng", "lon", "longitude", "x"]);
  const iPc = idx(["postcode", "post code", "pcode"]);
  const iName = idx(["name", "site", "title", "ref", "address"]);
  const rows = lines.slice(1).map(split);
  if (iLat >= 0 && iLng >= 0) {
    return rows.map((r, i) => {
      const lat = parseFloat(r[iLat]), lng = parseFloat(r[iLng]);
      if (isNaN(lat) || isNaN(lng)) return null;
      return { name: (iName >= 0 && r[iName]) || `Site ${i + 1}`,
               geometry: { type: "Point", coordinates: [lng, lat] } };
    }).filter(Boolean);
  }
  if (iPc < 0) throw new Error("no postcode or lat/lng columns found");
  // Geocode postcodes via postcodes.io (free, bulk 100 per request).
  pfStatus("Geocoding postcodes…");
  const pcs = rows.map(r => (r[iPc] || "").trim()).filter(Boolean);
  const coords = {};
  for (let i = 0; i < pcs.length; i += 100) {
    const chunk = pcs.slice(i, i + 100);
    const resp = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes: chunk }),
    });
    const j = await resp.json();
    for (const r of j.result || []) {
      if (r.result) coords[r.query.replace(/\s+/g, "").toUpperCase()] =
        [r.result.longitude, r.result.latitude];
    }
  }
  return rows.map((r, i) => {
    const c = coords[(r[iPc] || "").replace(/\s+/g, "").toUpperCase()];
    if (!c) return null;
    return { name: (iName >= 0 && r[iName]) || r[iPc] || `Site ${i + 1}`,
             geometry: { type: "Point", coordinates: c } };
  }).filter(Boolean);
}

// Heuristic composite. Transparent and tunable; the table shows the inputs.
function pfScore(s) {
  const pct = k => (s.summary?.constraints || []).find(c => c.kind === k)?.pct || 0;
  const env = ["sssi", "sac", "spa", "ramsar", "ancient_woodland"]
    .reduce((a, k) => a + pct(k), 0);
  const heritage = ["conservation_area", "scheduled_monument", "park_garden"]
    .reduce((a, k) => a + pct(k), 0);
  let policy = 100
    - pct("green_belt") * 0.5
    - pct("flood_zone_3") * 0.45 - pct("flood_zone_2") * 0.15
    - Math.min(60, env) - Math.min(30, heritage * 0.4)
    - pct("listed_building") * 0.3;
  const hdt = Number(s.summary?.areas?.hdt?.hdt_pct);
  if (!isNaN(hdt)) policy += hdt < 75 ? 15 : hdt < 85 ? 8 : hdt < 95 ? 4 : 0;
  if ((s.summary?.brownfield_overlap || 0) > 0) policy += 10;
  // Grey-belt model: green_belt already subtracted above, so a site whose
  // green-belt land is previously-developed claws most of that penalty back.
  const gbc = Number(s.summary?.grey_belt_pct);
  if (!isNaN(gbc) && gbc > 0) policy += Math.min(pct("green_belt") * 0.35, gbc * 0.35);
  // Decision culture: ±8 around an 80% national-typical approval rate.
  const apr = Number(s.summary?.areas?.planit_rates?.approval_pct);
  if (!isNaN(apr)) policy += Math.max(-8, Math.min(8, (apr - 80) * 0.4));
  if (s.summary?.areas?.article4) policy -= 3;
  policy = Math.max(0, Math.min(100, policy));
  let access = 50;
  if (s.stationM != null)
    access = s.stationM <= 800 ? 100 : s.stationM <= 2000 ? 75 :
             s.stationM <= 5000 ? 45 : 20;
  return { policy: Math.round(policy), access,
           total: Math.round(policy * 0.7 + access * 0.3) };
}

async function pfScoreAll() {
  const sb = getSupabase();
  if (!sb) { pfStatus("Database unavailable."); return; }
  pf.running = true;
  pf.results = [];
  const N = pf.sites.length;
  let done = 0;
  const worker = async () => {
    while (pf.sites.length && pf.running) {
      const site = pf.sites.shift();
      let summary = null;
      try {
        const { data, error } = await sb.rpc("polygon_summary",
          { p_geojson: JSON.stringify(site.geometry) });
        if (!error) summary = data;
      } catch (_) {}
      let centroid = site.geometry.type === "Point" ? site.geometry.coordinates : null;
      if (!centroid && typeof turf !== "undefined") {
        try { centroid = turf.centroid(site).geometry.coordinates; } catch (_) {}
      }
      const stn = centroid ? nearestUsageStation({ lng: centroid[0], lat: centroid[1] }) : null;
      const rec = { name: site.name, geometry: site.geometry, centroid,
                    summary, stationM: stn ? Math.round(stn.dist) : null,
                    stationName: stn ? stn.props.name : null };
      rec.scores = summary && !summary.error ? pfScore(rec) : { policy: 0, access: 0, total: 0 };
      pf.results.push(rec);
      done++;
      pfStatus(`Scoring… ${done}/${N}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  pf.running = false;
  pf.results.sort((a, b) => b.scores.total - a.scores.total);
  pfStatus(`${pf.results.length} sites scored — ranked best first. Click a row to fly to the site.`);
  pfRender();
  pfDrawSites();
}

function pfRender() {
  const host = document.getElementById("pf-results");
  if (!host) return;
  const rows = pf.results.map((r, i) => {
    const s = r.summary || {};
    const topC = (s.constraints || [])[0];
    const gb = (s.constraints || []).find(c => c.kind === "green_belt");
    const sales = s.recent_sales || [];
    const med = sales.length
      ? sales.map(x => x.price).sort((a, b) => a - b)[Math.floor(sales.length / 2)] : null;
    return `<button type="button" class="pbsa-row pf-row" data-i="${i}">
      <span class="pf-rank">${i + 1}</span>
      <span class="pbsa-row-name">${_esc(r.name)}</span>
      <span class="pf-score" style="color:${r.scores.total >= 70 ? "#2f9e44" : r.scores.total >= 45 ? "#f59f00" : "#e03131"}">${r.scores.total}</span>
      <span class="pbsa-row-meta">${[
        s.area_ha != null ? `${s.area_ha} ha` : null,
        gb ? `GB ${gb.pct}%` : null,
        s.grey_belt_pct ? `grey-belt ${s.grey_belt_pct}%` : null,
        topC && topC.kind !== "green_belt" ? `${topC.kind.replace(/_/g, " ")} ${topC.pct}%` : null,
        s.brownfield_overlap ? "brownfield" : null,
        r.stationM != null ? `stn ${_fmtDist(r.stationM)}` : null,
        med ? `sales ~£${(med / 1000).toFixed(0)}k` : null,
      ].filter(Boolean).join(" · ")}</span>
    </button>`;
  }).join("");
  host.innerHTML = rows || "";
  document.getElementById("pf-actions").hidden = !pf.results.length;
  host.querySelectorAll(".pf-row").forEach(btn =>
    btn.addEventListener("click", () => {
      const r = pf.results[parseInt(btn.dataset.i, 10)];
      if (r && r.centroid)
        map.flyTo({ center: r.centroid, zoom: 14, duration: 800 });
    }));
}

function pfDrawSites() {
  const fc = { type: "FeatureCollection", features: pf.results.map((r, i) => ({
    type: "Feature",
    properties: { rank: i + 1, name: r.name, score: r.scores.total },
    geometry: r.geometry.type === "Point"
      ? r.geometry
      : { type: "Point", coordinates: r.centroid || [0, 0] },
  })) };
  if (map.getSource("pf-sites")) map.getSource("pf-sites").setData(fc);
  else {
    map.addSource("pf-sites", { type: "geojson", data: fc });
    map.addLayer({ id: "pf-site-dot", type: "circle", source: "pf-sites",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 6, 12, 10],
               "circle-color": ["step", ["get", "score"], "#e03131", 45, "#f59f00", 70, "#2f9e44"],
               "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.6 } });
    map.addLayer({ id: "pf-site-lbl", type: "symbol", source: "pf-sites",
      layout: { "text-field": ["to-string", ["get", "rank"]],
                "text-font": ["Noto Sans Regular"], "text-size": 10,
                "text-allow-overlap": true },
      paint: { "text-color": "#ffffff" } });
  }
}

function pfExportCsv() {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["name,score,policy,access,area_ha,green_belt_pct,flood3_pct,brownfield_overlap,hdt_pct,station_m,station,rent_mean,sales_median,constraints"];
  for (const r of pf.results) {
    const s = r.summary || {};
    const pct = k => (s.constraints || []).find(c => c.kind === k)?.pct || 0;
    const sales = (s.recent_sales || []).map(x => x.price).sort((a, b) => a - b);
    lines.push([q(r.name), r.scores.total, r.scores.policy, r.scores.access,
      s.area_ha ?? "", pct("green_belt"), pct("flood_zone_3"),
      s.brownfield_overlap ?? "", s.areas?.hdt?.hdt_pct ?? "",
      r.stationM ?? "", q(r.stationName ?? ""), s.areas?.la_rents?.rent_mean ?? "",
      sales.length ? sales[Math.floor(sales.length / 2)] : "",
      q((s.constraints || []).map(c => `${c.kind}:${c.pct}%`).join(" ")),
    ].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "portfolio-scores.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function pfClear() {
  pf.sites = []; pf.results = []; pf.running = false;
  const host = document.getElementById("pf-results");
  if (host) host.innerHTML = "";
  const act = document.getElementById("pf-actions");
  if (act) act.hidden = true;
  pfStatus("");
  for (const id of ["pf-site-dot", "pf-site-lbl"])
    if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("pf-sites")) map.removeSource("pf-sites");
}

// ---- University deep-dive drawer (right side, like the station panel) ------
// A growing home for everything about one institution: demand stats, the
// accommodation mix, its campuses, rail access and the local market around
// the HQ. Opened from the provider click-card or the PBSA box.

let _uniPanelCtx = null;   // { p: provider props, lng, lat } for the delegate

function uniPanelStatChips(p) {
  const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
  const chip = (label, v) => v == null ? "" :
    `<div class="pbsa-chip"><div class="pbsa-chip-v">${_esc(v)}</div><div class="pbsa-chip-l">${_esc(label)}</div></div>`;
  const total = num(p.students_total), ft = num(p.students_fulltime),
        pg = num(p.students_pg), intlPct = num(p.intl_pct);
  return `<div class="pbsa-chips">` +
    chip("students", total != null ? total.toLocaleString() : null) +
    chip("full-time", ft != null ? ft.toLocaleString() : null) +
    chip("international", intlPct != null ? intlPct + "%" : null) +
    chip("postgraduate", total && pg != null ? Math.round(100 * pg / total) + "%" : null) +
    `</div>`;
}

function uniPanelAccBars(p) {
  const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
  const rows = [
    ["Private halls (PBSA)", num(p.pbsa_pct), "#7048e8"],
    ["University halls", num(p.uni_halls_pct), "#4dabf7"],
    ["Other rented (HMO etc.)", num(p.rented_pct), "#f59f00"],
    ["Living with parents", num(p.home_pct), "#868e96"],
  ].filter(([, v]) => v != null);
  if (!rows.length) return `<p class="hint">No accommodation data for this provider.</p>`;
  return `<table class="metric-table">` + rows.map(([label, v, col]) =>
    `<tr><td class="name">${_esc(label)}</td>
     <td class="bar-cell"><div class="minibar"><span style="width:${Math.min(100, v)}%;background:${col}"></span></div></td>
     <td class="num">${v}%</td></tr>`).join("") + `</table>`;
}

function openUniPanel(p, lng, lat) {
  const panel = document.getElementById("uni-panel");
  if (!panel || !p) return;
  _uniPanelCtx = { p, lng, lat };
  panel.innerHTML = `
    <div class="uni-head">
      <button class="fd-close uni-close" aria-label="Close">×</button>
      <div class="fd-district">${_esc(p.name || "HE provider")}</div>
      <div class="fd-sub">${_esc([p.groups, p.ukprn ? `UKPRN ${p.ukprn}` : ""].filter(Boolean).join(" · "))}</div>
    </div>
    <div class="uni-body">
      <div class="sp-sec"><div class="sp-h">Students (HESA 2024/25)</div>${uniPanelStatChips(p)}</div>
      <div class="sp-sec"><div class="sp-h">Term-time accommodation (full-time)</div>${uniPanelAccBars(p)}</div>
      <div class="sp-sec"><div class="sp-h">Campuses</div><div id="uni-pn-campuses"><p class="hint">Finding campuses…</p></div></div>
      <div class="sp-sec"><div class="sp-h">Rail access</div><div id="uni-pn-rail"><p class="hint">Loading rail access…</p></div></div>
      <div class="sp-sec"><div class="sp-h">Around the HQ</div><div id="uni-pn-local"><p class="hint">Reading the local area…</p></div></div>
      <p class="hint">This panel keeps growing — planning context, PBSA pipeline and competitor stock are on the roadmap.</p>
    </div>`;
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  panel.querySelector(".uni-close").addEventListener("click", closeUniPanel);
  uniPanelHydrate(p, lng, lat);
}

function closeUniPanel() {
  const panel = document.getElementById("uni-panel");
  if (panel) { panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); }
}

async function uniPanelHydrate(p, lng, lat) {
  const line = (label, valueHTML) => valueHTML == null || valueHTML === "" ? "" :
    `<div class="sp-row"><span class="sp-v">${valueHTML}</span><span class="sp-k">${_esc(label)}</span></div>`;
  const strong = v => `<strong>${_esc(v)}</strong>`;

  // Campuses (OSM-matched; shared with the catchment builder).
  const campEl = () => document.getElementById("uni-pn-campuses");
  pbsaLoadCampuses({ ukprn: p.ukprn, name: p.name, lng, lat }).then(campuses => {
    const el = campEl();
    if (!el) return;
    if (!campuses || !campuses.length) {
      el.innerHTML = `<p class="hint">No separate campuses matched near the HQ (OSM data).</p>`;
      return;
    }
    el.innerHTML = campuses.map(c =>
      `<button type="button" class="pbsa-row" data-lng="${c.lng}" data-lat="${c.lat}">
         <span class="pbsa-row-name">${_esc(c.name)}</span>
         <span class="pbsa-row-meta">${_fmtDist(c.distM)} from HQ</span></button>`).join("");
    el.querySelectorAll(".pbsa-row").forEach(btn =>
      btn.addEventListener("click", () =>
        map.flyTo({ center: [parseFloat(btn.dataset.lng), parseFloat(btn.dataset.lat)], zoom: 15, duration: 700 })));
  });

  // Rail access: reuse the PBSA payload when it's this university, else fetch.
  const railEl = () => document.getElementById("uni-pn-rail");
  (async () => {
    const el = railEl();
    if (!el) return;
    let d = (pbsa.data && String(pbsa.data.university?.ukprn) === String(p.ukprn)) ? pbsa.data : null;
    if (!d) {
      const sb = getSupabase();
      if (sb) {
        try {
          const { data } = await sb.rpc("uni_rail_access", { p_ukprn: String(p.ukprn) });
          d = data;
        } catch (_) {}
      }
    }
    if (!d) { el.innerHTML = `<p class="hint">Rail access unavailable.</p>`; return; }
    const gws = d.gateways || [];
    const feeders = (d.feeders || []).filter(f => f.minutes != null);
    const quick = feeders.filter(f => f.minutes <= 30).length;
    let html = "";
    html += line("walkable gateway stations", strong(String(gws.length)));
    if (d.links_loaded) {
      html += line("stations with a direct train in", strong(feeders.length.toLocaleString()));
      html += line("of those, ≤ 30 min away", strong(String(quick)));
    }
    html += gws.slice(0, 5).map(g =>
      `<div class="sp-row"><span class="sp-v">${_esc(g.name)}</span><span class="sp-k">${g.walk_m} m walk</span></div>`).join("");
    html += `<p class="hint">Full feeder ranking and the catchment builder live in the PBSA sift box.</p>`;
    el.innerHTML = html;
  })();

  // Local market & context around the HQ, from the same spot-summary RPC.
  const localEl = () => document.getElementById("uni-pn-local");
  (async () => {
    const el = localEl();
    if (!el || lng == null) return;
    const sb = getSupabase();
    let ps = null;
    if (sb) {
      try {
        const { data } = await sb.rpc("point_summary", { p_lon: lng, p_lat: lat });
        ps = data || {};
      } catch (_) {}
    }
    if (!ps) { el.innerHTML = `<p class="hint">Local context unavailable.</p>`; return; }
    const areas = ps.areas || {};
    let html = "";
    if (areas.lad_boundary) html += line("district", strong(areas.lad_boundary.name || ""));
    if (areas.la_rents && areas.la_rents.rent_mean != null) {
      const ch = areas.la_rents.annual_rent_change_pct;
      html += line("avg private rent", strong(`£${Number(areas.la_rents.rent_mean).toLocaleString()}/mo`) +
        (ch != null ? ` <span class="sp-dim">${ch > 0 ? "+" : ""}${_esc(ch)}% y/y</span>` : ""));
    }
    if (areas.ptal) html += line("PTAL at HQ", strong(String(areas.ptal.ptal ?? "")));
    if (areas.article4) html += line("Article 4", strong("yes — HMO controls likely"));
    if (ps.brownfield_nearby > 0) html += line("brownfield sites ≤ 800 m", strong(String(ps.brownfield_nearby)));
    const stn = nearestUsageStation({ lng, lat });
    if (stn) html += line("nearest station", strong(stn.props.name || "Station") +
      ` <span class="sp-dim">${_fmtDist(stn.dist)}</span>`);
    el.innerHTML = html || `<p class="hint">Nothing notable found at the HQ location.</p>`;
  })();
}

// Any "Full deep dive" button (provider click-card or PBSA box) routes here.
document.addEventListener("click", (e) => {
  const b = e.target.closest(".uni-dd-open");
  if (!b || !_uniPanelCtx) return;
  openUniPanel(_uniPanelCtx.p, _uniPanelCtx.lng, _uniPanelCtx.lat);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUniPanel(); });

// ---- Boot -----------------------------------------------------------------

// Reflect the default theme onto <body> immediately so the UI starts in the
// right palette (the CSS variables flip on body.light). The basemap source is
// already created with the matching light tiles above.
document.body.classList.toggle("light", state.theme === "light");

// Mobile controls drawer: the toggle button and scrim show only on small
// screens (CSS). Tapping the button slides the panel in/out; tapping the scrim
// (or selecting something on the map) closes it so the map is usable.
function setDrawer(open) {
  const app = document.getElementById("app");
  const btn = document.getElementById("panel-toggle");
  const scrim = document.getElementById("panel-scrim");
  app.classList.toggle("panel-open", open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (scrim) scrim.hidden = !open;
}
(function wireDrawer() {
  const btn = document.getElementById("panel-toggle");
  const scrim = document.getElementById("panel-scrim");
  if (btn) btn.addEventListener("click", () =>
    setDrawer(!document.getElementById("app").classList.contains("panel-open")));
  if (scrim) scrim.addEventListener("click", () => setDrawer(false));
})();

// Define-area controls: point / draw plot, plus isochrone settings.
(function wirePlotTools() {
  const pointBtn = document.getElementById("plot-point");
  const drawBtn = document.getElementById("plot-draw");
  const goBtn = document.getElementById("plot-go");
  const modeSel = document.getElementById("plot-mode-select");
  const minutesInp = document.getElementById("plot-minutes");
  const undoBtn = document.getElementById("plot-undo");
  const clearBtn = document.getElementById("plot-clear");
  if (!goBtn) return;

  function setActive(btn) {
    document.querySelectorAll(".plot-mode-btn").forEach(b => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
  }

  // Remove any drawn polygon, point marker, and reset state.
  function clearPlot() {
    plot.geometry = null;
    state.plotPointMode = false;
    map.getCanvas().style.cursor = "";
    try { draw.deleteAll(); draw.changeMode("simple_select"); } catch (_) {}
    if (map.getLayer("plot-point-dot")) map.removeLayer("plot-point-dot");
    if (map.getSource("plot-point-src")) map.removeSource("plot-point-src");
    setActive(null);
    setPlotStatus("Cleared. Drop a point or draw a plot to start again.");
  }

  // Drop a point: next map click sets the plot origin.
  pointBtn.addEventListener("click", () => {
    clearPlot();
    state.plotPointMode = true;
    setActive(pointBtn);
    setPlotStatus("Click the map to drop your point.");
    map.getCanvas().style.cursor = "crosshair";
  });

  map.on("click", (e) => {
    if (!state.plotPointMode) return;
    dropPlotPoint(e.lngLat);
  });

  // Draw a plot: clear any existing, then start the polygon tool.
  drawBtn.addEventListener("click", () => {
    clearPlot();
    setActive(drawBtn);
    setPlotStatus("Draw a polygon: click points, double-click to finish.");
    try { draw.changeMode("draw_polygon"); } catch (_) {}
  });

  // When a polygon is drawn, capture it as the plot geometry.
  map.on("draw.create", (e) => {
    const f = e.features && e.features[0];
    if (f && f.geometry) {
      plot.geometry = f.geometry;
      setPlotStatus("Plot drawn. Choose mode/time, then build the catchment.");
    }
  });

  // Undo: while mid-draw, remove the last placed vertex; if a polygon is
  // finished, removing it lets you redraw. Uses Draw's trash, which deletes the
  // selected/last vertex in draw mode.
  if (undoBtn) undoBtn.addEventListener("click", () => {
    try {
      const m = draw.getMode && draw.getMode();
      if (m === "draw_polygon") {
        draw.trash();   // removes the last vertex placed
        setPlotStatus("Removed last point. Keep drawing or double-click to finish.");
      } else {
        // Nothing mid-draw: treat undo as clearing the finished plot/point.
        clearPlot();
      }
    } catch (_) { clearPlot(); }
  });

  // Clear: wipe everything and start over.
  if (clearBtn) clearBtn.addEventListener("click", clearPlot);

  modeSel.addEventListener("change", () => { plot.mode = modeSel.value; });
  minutesInp.addEventListener("change", () => {
    plot.minutes = Math.max(1, Math.min(60, parseInt(minutesInp.value, 10) || 15));
    minutesInp.value = plot.minutes;
  });

  goBtn.addEventListener("click", () => {
    plot.mode = modeSel.value;
    plot.minutes = Math.max(1, Math.min(60, parseInt(minutesInp.value, 10) || 15));
    runPlotDeepDive();
  });
})();

// ============================================================================
// Mode switch (Explore vs Site sift) + the NPPF station sift (Phase 1: Gates 1-2
// over the precomputed public.station_assessments). Later phases add Gate 3
// constraints friction and Scores 4-6.
// ============================================================================
function wireModeSwitch() {
  const sw = document.getElementById("mode-switch");
  if (sw) sw.querySelectorAll(".mode-btn").forEach(b =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  applyModeVisibility();
}

function setMode(mode) {
  if (mode !== "explore" && mode !== "sift") return;
  state.mode = mode;
  const sw = document.getElementById("mode-switch");
  if (sw) sw.querySelectorAll(".mode-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode));
  applyModeVisibility();
  if (mode === "sift") enterSiftMode();
  else exitSiftMode();
}

// Explore-only left-panel blocks (hidden in sift mode). Data-gated blocks keep
// their own `hidden` attribute; we only toggle an inline display override, so
// returning to explore restores whatever their data state dictated.
const EXPLORE_BLOCKS = ["context-block", "plot-block", "station-block"];

function applyModeVisibility() {
  const sift = state.mode === "sift";
  EXPLORE_BLOCKS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = sift ? "none" : "";
  });
  const siftBlock = document.getElementById("sift-block");
  if (siftBlock) siftBlock.hidden = !sift;
}

// ---- Persistence: a tiny namespaced localStorage wrapper --------------------
// Backs the sift configuration + shortlist so they survive a page reload. All
// access is guarded (private-mode / disabled storage just no-ops).
const mmStore = {
  key: k => `mastermapper:${k}`,
  get(k, fallback) {
    try { const v = localStorage.getItem(this.key(k)); return v == null ? fallback : JSON.parse(v); }
    catch (_) { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch (_) {} },
};

// ---- Assessments 5 & 6: parameterised Viability + Deliverability ------------
// Both are transparent models computed client-side over the sift rows, so they
// recompute instantly when the user edits an assumption (no DB round-trip). The
// defaults are indicative national figures the user is expected to tune.

// Regional sales-value multipliers applied to the base £/ft² so viability varies
// spatially using the region we already hold (no price layer needed yet). Tunable
// later; grounded in broad England new-build value gradients.
const REGION_PRICE_MULT = {
  "London": 1.9, "South East": 1.4, "East of England": 1.15, "East": 1.15,
  "South West": 1.1, "West Midlands": 0.95, "East Midlands": 0.9,
  "North West": 0.9, "Yorkshire and The Humber": 0.85, "Yorkshire": 0.85,
  "North East": 0.8, "Wales": 0.85,
};
function regionPriceMult(region) {
  if (!region) return 1.0;
  if (REGION_PRICE_MULT[region] != null) return REGION_PRICE_MULT[region];
  // loose contains-match for slightly different region strings
  const k = Object.keys(REGION_PRICE_MULT).find(x => region.indexOf(x) !== -1);
  return k ? REGION_PRICE_MULT[k] : 1.0;
}

// Regional BUILD-COST factors — a client-side mirror of the committed
// pipeline/data/build_cost_index.csv (the free BCIS-like proxy behind the
// build_cost_index layer; 1.00 = national average). The deep dive reads the
// station's LAD factor live from that layer via point_summary; the sift scores
// ~2,400 stations at once with no per-station fetch, so it applies the same
// index at region grain from this table. Keep the two in step when the CSV
// is recalibrated.
const REGION_COST_FACTORS = {
  "London": 1.18, "South East": 1.08, "East of England": 1.03, "East": 1.03,
  "South West": 1.00, "West Midlands": 0.95, "East Midlands": 0.93,
  "North West": 0.93, "Yorkshire and The Humber": 0.92, "Yorkshire": 0.92,
  "North East": 0.90, "Wales": 0.92, "Scotland": 0.97,
};
function regionCostFactor(region) {
  if (!region) return 1.0;
  if (REGION_COST_FACTORS[region] != null) return REGION_COST_FACTORS[region];
  const k = Object.keys(REGION_COST_FACTORS).find(x => region.indexOf(x) !== -1);
  return k ? REGION_COST_FACTORS[k] : 1.0;
}

// ---------------------------------------------------------------------------
// Viability assumption schema — the single source of truth. Drives the
// defaults, the Viability variables modal (fields are GENERATED from this,
// grouped and tooltipped), and the report appendix. Client-facing: every
// figure here is an opening position to be overridden, and each carries its
// source note so the tool never presents an assumption as a fact.
//
// Replaces the old flat VIABILITY_DEFAULTS. Two deliberate structural changes:
// build cost is £/m² BY TYPOLOGY × a location index (fed from the
// build_cost_index layer) instead of one £/ft²; and the old softCostPct
// bundle (which mixed fees, contingency AND finance) is split into explicit
// professional fees + contingency + computed finance + sales costs, so
// nothing is double-counted and each line can be challenged on its own.
// ---------------------------------------------------------------------------
const VIAB_SCHEMA = [
  // Land
  { key: "landBasis", group: "land", label: "Land value basis", unit: "choice",
    choices: ["mhclg", "perUnit", "euvPlus"], default: "mhclg",
    tip: "MHCLG £/ha: the published 'land value estimates for policy appraisal' figure for the authority (residential £/ha × site hectares) — the best free benchmark, used wherever the data covers the site; falls back to the localised £/unit benchmark elsewhere (including the sifter, which appraises 2,400 stations without per-site lookups). £/unit and EUV+ (the PPG approach) remain as manual bases.", source: "MHCLG land value estimates (OGL) / PPG viability guidance" },
  { key: "blvPerUnit", group: "land", label: "Benchmark land value", unit: "£k/unit", step: 1, default: 20,
    tip: "Land cost per plot when basis is per-unit.", source: "assumption" },
  { key: "euvPerHa", group: "land", label: "Existing use value", unit: "£k/ha", step: 5, default: 25,
    tip: "EUV per hectare (agricultural ≈ £20–30k/ha; industrial and urban uses far higher).", source: "assumption" },
  { key: "euvPremiumPct", group: "land", label: "EUV premium", unit: "%", step: 5, default: 100,
    tip: "Uplift on EUV to incentivise release (PPG: a premium to the landowner).", source: "PPG viability guidance" },
  { key: "landLocalisePct", group: "land", label: "Localise land to values", unit: "%", step: 10, default: 100,
    tip: "The benchmark figures above are NATIONAL-average opening positions. This scales them with the scheme's sales value relative to the fallback £/ft² reference — at 100%, a £700/ft² location carries ~2× the land cost of a £350/ft² one; at 0% land is flat everywhere (which makes high-value areas look artificially viable). Land values track sales values; replace with a local land benchmark when you hold one.", source: "model (value-linked)" },
  // Build
  { key: "buildPm2House", group: "build", label: "Build cost — houses", unit: "£/m²", step: 25, default: 1650,
    tip: "New-build houses, GIA. Seeded from a free proxy (ONS construction indices + regional factors), NOT BCIS — paste your own BCIS rate here if you hold a licence.", source: "free proxy" },
  { key: "buildPm2Flat", group: "build", label: "Build cost — flats", unit: "£/m²", step: 25, default: 2100,
    tip: "New-build flats, GIA — higher than houses (cores, corridors, M&E).", source: "free proxy" },
  { key: "flatMixPct", group: "build", label: "Flat mix", unit: "%", step: 5, default: 40,
    tip: "Share of units built as flats; blends the two build rates and informs the sales blend.", source: "assumption" },
  { key: "costIndexFactor", group: "build", label: "Location cost index", unit: "×", step: 0.01, default: 1.0,
    tip: "Regional/local construction cost factor (1.00 = national average). Auto-filled from the build-cost layer for the area in view; editable.", source: "free proxy (build_cost_index layer)" },
  { key: "abnormalsPct", group: "build", label: "Abnormals allowance", unit: "% of build", step: 1, default: 5,
    tip: "Remediation, retaining structures, piling, service diversions, offsite highway works — the classic viability killers. Raise materially on brownfield or sloping sites.", source: "assumption" },
  { key: "sitePrepPerPlot", group: "build", label: "Site preparation", unit: "£k/unit", step: 1, default: 5,
    tip: "Groundworks, drainage, enabling works per plot.", source: "assumption" },
  { key: "infraPerPlot", group: "build", label: "Site infrastructure", unit: "£k/unit", step: 1, default: 8,
    tip: "Estate roads, utilities connections, POS per plot.", source: "assumption" },
  // Fees
  { key: "profFeesPct", group: "fees", label: "Professional fees", unit: "% of build", step: 0.5, default: 10,
    tip: "Architects, engineers, PM, surveys, planning.", source: "assumption" },
  { key: "contingencyPct", group: "fees", label: "Contingency", unit: "% of build", step: 0.5, default: 5,
    tip: "Construction risk allowance on top of abnormals.", source: "assumption" },
  { key: "salesCostPct", group: "fees", label: "Sales & marketing", unit: "% of GDV", step: 0.5, default: 3,
    tip: "Agents, legals, show home, incentives.", source: "assumption" },
  // Revenue
  { key: "unitSizeFt2", group: "revenue", label: "Average unit size", unit: "ft²", step: 25, default: 750,
    tip: "Average saleable area per dwelling across the mix (NDSS 2b4p ≈ 850 ft²; 1-bed flats ≈ 550).", source: "assumption" },
  { key: "salesAdjPct", group: "revenue", label: "New-build premium", unit: "% of local", step: 5, default: 100,
    tip: "Applied to the LOCAL £/ft² (Land Registry × EPC within the catchment). 100 = resale parity; new build typically 105–115.", source: "assumption" },
  { key: "salesPsf", group: "revenue", label: "Fallback sales value", unit: "£/ft²", step: 10, default: 350,
    tip: "Used (× regional multiplier) only where no local price is loaded.", source: "assumption" },
  { key: "affordablePct", group: "revenue", label: "Affordable housing", unit: "% units", step: 5, default: 25,
    tip: "Policy-compliant share — check the LPA's adopted policy; London boroughs commonly 35–50%.", source: "LPA policy" },
  { key: "affordableValue", group: "revenue", label: "Affordable value", unit: "% of market", step: 5, default: 55,
    tip: "RP offer as a share of market value, blended across tenures (social rent ~40–50%, shared ownership ~65–75%).", source: "assumption" },
  { key: "salesInflationPct", group: "revenue", label: "Sales inflation", unit: "%/yr", step: 0.5, default: 0,
    tip: "House price growth assumed across the sales period. Leave 0 for today's-prices appraisal (the defensible default).", source: "assumption" },
  // Finance
  { key: "debtRatePct", group: "finance", label: "Debt rate", unit: "%/yr", step: 0.25, default: 7.5,
    tip: "All-in cost of senior debt on the drawn balance.", source: "assumption" },
  { key: "ltcPct", group: "finance", label: "Loan to cost", unit: "%", step: 5, default: 85,
    tip: "Share of costs funded by debt; the rest is equity (equity drawn first).", source: "assumption" },
  { key: "arrangementFeePct", group: "finance", label: "Arrangement fee", unit: "% of peak debt", step: 0.25, default: 1,
    tip: "Lender entry fee, charged on peak facility.", source: "assumption" },
  { key: "preConMonths", group: "finance", label: "Pre-construction", unit: "months", step: 1, default: 6,
    tip: "Land to start on site: discharge of conditions, procurement, mobilisation.", source: "assumption" },
  { key: "buildMonths", group: "finance", label: "Build period", unit: "months", step: 1, default: 24,
    tip: "Start on site to practical completion. Scale with scheme size.", source: "assumption" },
  { key: "salesMonths", group: "finance", label: "Sales period", unit: "months", step: 1, default: 18,
    tip: "Absorption: first completion to final sale.", source: "assumption" },
  { key: "salesOverlapMonths", group: "finance", label: "Sales overlap", unit: "months", step: 1, default: 6,
    tip: "How far sales completions start before build completion (off-plan / phased handover).", source: "assumption" },
  // Policy costs
  { key: "cilPerUnit", group: "policy", label: "CIL", unit: "£k/unit", step: 1, default: 5,
    tip: "Community Infrastructure Levy — zone-specific; check the charging schedule. n/a Scotland.", source: "LPA charging schedule" },
  { key: "s106PerUnit", group: "policy", label: "S106 / S75", unit: "£k/unit", step: 1, default: 5,
    tip: "Education, healthcare, transport, open space heads of terms.", source: "LPA precedent" },
  { key: "bngPerUnit", group: "policy", label: "BNG", unit: "£k/unit", step: 0.5, default: 2,
    tip: "10% biodiversity net gain — cheap where on-site delivery works, £20k+/unit where off-site units must be bought.", source: "assumption" },
  { key: "policyLocalisePct", group: "policy", label: "Localise CIL/S106 to values", unit: "%", step: 10, default: 100,
    tip: "CIL charging schedules and S106 asks broadly track local values (London boroughs charge multiples of northern authorities; no free national rates table exists). At 100% the CIL and S106 figures scale with the scheme's sales value vs the £/ft² reference; at 0% they are flat national figures. BNG is NOT scaled — habitat cost isn't value-linked. Pin the real charging-schedule rate and set this to 0 when you know it.", source: "model (value-linked)" },
  // Targets
  { key: "profitTargetPct", group: "targets", label: "Profit target (on cost)", unit: "%", step: 0.5, default: 17.5,
    tip: "The viability threshold: schemes below half this read unviable.", source: "PPG: 15–20% of GDV typical" },
  { key: "profitTargetGdvPct", group: "targets", label: "Profit target (on GDV)", unit: "%", step: 0.5, default: 15,
    tip: "Used for the residual land value: RLV = GDV − costs − this margin.", source: "PPG: 15–20% of GDV typical" },
];

const VIAB_GROUPS = [
  ["land", "Land"], ["build", "Build costs"], ["fees", "Fees & selling"],
  ["revenue", "Revenue"], ["finance", "Finance & programme"],
  ["policy", "Policy costs"], ["targets", "Targets"],
];

const VIABILITY_DEFAULTS = Object.fromEntries(
  VIAB_SCHEMA.map(f => [f.key, f.default]));
// Saved assumptions from the OLD flat model (buildPsf/softCostPct era) are not
// meaningfully translatable — discard them once, keep everything else.
VIABILITY_DEFAULTS._v = 2;

const SIFT = {
  loaded: false,
  rows: [],
  step: 0,             // current wizard step (index into SIFT_STEPS)
  crit: { requireFrequency: true, requireWellConnected: false, exemptInSettlement: true,
          tierA: true, tierB: true, ineligible: false, minDevHa: 0, minYield: 0,
          maxProtectedPct: 100, deprivedTopPct: 100, minProfitOnCost: -30,
          excludeGreenBelt: false, largestPlotOnly: false },
  sort: "viability",   // yield | regen | viability
  country: mmStore.get("siftCountry", "england"),  // england | scotland (sifted separately)
  assumptions: Object.assign({}, VIABILITY_DEFAULTS),
  shortlist: new Set(mmStore.get("shortlist", [])),  // pinned station CRSs (persisted)
};

// Restore a previously-saved sift configuration (criteria/assumptions/weights/sort)
// over the defaults, so a reload lands you where you left off.
(function restoreSiftConfig() {
  const saved = mmStore.get("siftConfig", null);
  if (!saved) return;
  Object.assign(SIFT.crit, saved.crit || {});
  // Assumptions only survive a reload if they speak the current schema. The
  // v1 flat model (buildPsf £/ft², bundled softCostPct) cannot be translated
  // into typology £/m² + explicit fees/finance without inventing numbers, so
  // stale saves are dropped once — criteria, sort and shortlist are kept.
  if (saved.assumptions && saved.assumptions._v === VIABILITY_DEFAULTS._v)
    Object.assign(SIFT.assumptions, saved.assumptions);
  if (saved.sort) SIFT.sort = saved.sort;
})();

function persistSiftConfig() {
  mmStore.set("siftConfig", { crit: SIFT.crit, assumptions: SIFT.assumptions,
    sort: SIFT.sort });
}
function persistShortlist() { mmStore.set("shortlist", Array.from(SIFT.shortlist)); }
function toggleShortlist(crs) {
  if (SIFT.shortlist.has(crs)) SIFT.shortlist.delete(crs);
  else SIFT.shortlist.add(crs);
  persistShortlist();
}

// ---------------------------------------------------------------------------
// The residual appraisal engine. One engine for every context: sift rows,
// the deep dive, and assembled sites all call computeAppraisal with explicit
// inputs, so a station and the plots inside its catchment can never be priced
// by different arithmetic.
//
// inputs: { units, ppm2, region, areaHa?, locationFactor? }
//   units          dwellings
//   ppm2           local sales £/m² (null -> fallback £/ft² × regional mult)
//   region         for the fallback multiplier only
//   areaHa         site hectares — needed only for the EUV+ land basis
//   locationFactor build-cost index for the locality (overrides a.costIndexFactor
//                  when the caller knows better, e.g. from the build_cost layer)
//
// MODEL SIMPLIFICATIONS, stated rather than hidden (also shown in the modal):
// build spend follows a sin² S-curve; sales complete evenly across the sales
// period; equity is drawn before debt; interest accrues monthly on the drawn
// balance and capitalises; the arrangement fee is charged on peak debt
// computed before the fee (the circularity is a rounding error at 1%); IRR is
// on the equity cashflow, annualised from the monthly rate.
// ---------------------------------------------------------------------------
const FT2_PER_M2 = 10.7639;
const M2_PER_FT2 = 1 / FT2_PER_M2;

function computeAppraisal(inputs, a, opts) {
  a = a || SIFT.assumptions;
  opts = opts || {};
  const nil = { profitOnCost: null, profitOnGdv: null, rag: "n/a", score: 0,
                price: null, local: false, gdv: 0, totalCost: 0, profit: 0,
                residualLandValue: null, irr: null, peakDebt: null,
                cashflow: null, sensitivity: null, waterfall: null };
  const units = Number(inputs.units) || 0;
  if (units <= 0) return nil;

  // --- Revenue --------------------------------------------------------------
  const unitFt2 = a.unitSizeFt2 || 750;
  const unitM2 = unitFt2 * M2_PER_FT2;
  const localPsf = inputs.ppm2 ? inputs.ppm2 / FT2_PER_M2 : null;
  const price = localPsf != null
    ? localPsf * ((a.salesAdjPct || 100) / 100)
    : (a.salesPsf || 350) * regionPriceMult(inputs.region);
  const affFrac = (a.affordablePct || 0) / 100;
  const blend = (1 - affFrac) + affFrac * ((a.affordableValue || 0) / 100);
  // Sales inflation to the MIDPOINT of the sales period — even absorption
  // means half the revenue lands either side of it.
  const preCon = Math.max(0, a.preConMonths ?? 6);
  const build = Math.max(1, a.buildMonths ?? 24);
  const sell = Math.max(1, a.salesMonths ?? 18);
  const overlap = Math.min(build, Math.max(0, a.salesOverlapMonths ?? 6));
  const midSaleYears = (preCon + build - overlap + sell / 2) / 12;
  const infl = Math.pow(1 + (a.salesInflationPct || 0) / 100, midSaleYears);
  const gdv = units * unitFt2 * price * blend * infl;

  // --- Costs ----------------------------------------------------------------
  const flatFrac = Math.min(1, Math.max(0, (a.flatMixPct || 0) / 100));
  const pm2 = ((a.buildPm2House || 0) * (1 - flatFrac)
             + (a.buildPm2Flat || 0) * flatFrac)
             * (inputs.locationFactor || a.costIndexFactor || 1);
  const buildBase = units * unitM2 * pm2;
  const abnormals = buildBase * ((a.abnormalsPct || 0) / 100);
  const prepInfra = units * (((a.sitePrepPerPlot || 0) + (a.infraPerPlot || 0)) * 1000);
  const hardCost = buildBase + abnormals + prepInfra;
  const fees = hardCost * ((a.profFeesPct || 0) / 100);
  const contingency = hardCost * ((a.contingencyPct || 0) / 100);
  // Local-value ratio: this scheme's £/ft² (local Land Registry figure when
  // loaded, else the regional fallback) over the national reference. Land
  // values and policy charges both track sales values, so a flat national
  // £/unit made London land artificially cheap and its schemes artificially
  // viable. Clamped: sub-Barnsley or super-Mayfair ratios are data noise.
  const refPsf = a.salesPsf || 350;
  const valueRatio = Math.min(6, Math.max(0.25, refPsf > 0 ? price / refPsf : 1));
  const landScale = 1 + (valueRatio - 1) * ((a.landLocalisePct ?? 100) / 100);
  const policyScale = 1 + (valueRatio - 1) * ((a.policyLocalisePct ?? 100) / 100);
  const policyCosts = units * (((a.cilPerUnit || 0) + (a.s106PerUnit || 0)) * policyScale
                              + (a.bngPerUnit || 0)) * 1000;
  // Land, best evidence first: the published MHCLG per-hectare benchmark for
  // the authority when the caller holds it (deep dive / assembler / report —
  // already local, so the value-ratio scaling must NOT stack on top), else
  // EUV+ or the £/unit benchmark, both localised by the value ratio.
  const mhclgLand = a.landBasis === "mhclg" && inputs.landValueHa > 0 && inputs.areaHa > 0
    ? inputs.areaHa * inputs.landValueHa : null;
  const land = mhclgLand != null ? mhclgLand
    : (a.landBasis === "euvPlus" && inputs.areaHa > 0
      ? inputs.areaHa * (a.euvPerHa || 0) * 1000 * (1 + (a.euvPremiumPct || 0) / 100)
      : units * (a.blvPerUnit || 0) * 1000) * landScale;
  const landBasisUsed = mhclgLand != null ? "mhclg"
    : a.landBasis === "euvPlus" && inputs.areaHa > 0 ? "euvPlus" : "perUnit";
  const salesCosts = gdv * ((a.salesCostPct || 0) / 100);

  // --- Cashflow, finance, IRR ----------------------------------------------
  const months = preCon + build + Math.max(0, sell - overlap) + 1;
  const out = new Array(months).fill(0);
  const inn = new Array(months).fill(0);
  out[0] += land;
  // Fees front-load with pre-construction (design happens before spades).
  for (let m = 0; m < preCon; m++) out[m] += fees * 0.5 / Math.max(1, preCon);
  // Policy costs at commencement — CIL is due on start on site.
  out[preCon] = (out[preCon] || 0) + policyCosts;
  // Build spend (incl. abnormals/prep, remaining fees, contingency) on a sin²
  // S-curve: slow mobilisation, peak mid-programme, tail-off to completion.
  const constr = hardCost + fees * 0.5 + contingency;
  let sTot = 0;
  const sW = [];
  for (let m = 0; m < build; m++) {
    const w = Math.pow(Math.sin(Math.PI * (m + 0.5) / build), 2);
    sW.push(w); sTot += w;
  }
  for (let m = 0; m < build; m++) out[preCon + m] += constr * sW[m] / sTot;
  // Sales: even absorption; sales costs leave in proportion to revenue.
  const firstSale = preCon + build - overlap;
  for (let m = 0; m < sell; m++) {
    inn[firstSale + m] += gdv / sell;
    out[firstSale + m] += salesCosts / sell;
  }
  // Equity first, then debt; interest capitalises monthly on the drawn balance.
  const totalOut = out.reduce((s, v) => s + v, 0);
  const equityCap = totalOut * (1 - (a.ltcPct ?? 85) / 100);
  const mRate = (a.debtRatePct || 0) / 100 / 12;
  let debt = 0, equityUsed = 0, peakDebt = 0, interest = 0;
  const equityFlow = new Array(months).fill(0);
  for (let m = 0; m < months; m++) {
    const i = debt * mRate;
    interest += i;
    debt += i;
    let need = out[m];
    const eq = Math.min(need, Math.max(0, equityCap - equityUsed));
    equityUsed += eq;
    equityFlow[m] -= eq;
    debt += need - eq;
    const repay = Math.min(debt, inn[m]);
    debt -= repay;
    equityFlow[m] += inn[m] - repay;
    peakDebt = Math.max(peakDebt, debt);
  }
  // Any residual debt at the end nets off the final equity receipt.
  equityFlow[months - 1] -= debt;
  const financeFee = peakDebt * ((a.arrangementFeePct || 0) / 100);
  equityFlow[months - 1] -= financeFee;

  const totalCost = hardCost + fees + contingency + policyCosts + salesCosts
                  + land + interest + financeFee;
  const profit = gdv - totalCost;
  const poc = totalCost > 0 ? (profit / totalCost) * 100 : null;
  const pog = gdv > 0 ? (profit / gdv) * 100 : null;

  // Residual land value: what the site is WORTH at the target margin —
  // reported beside the fixed-land profit, because clients ask both questions.
  const nonLand = totalCost - land;
  const residualLandValue = gdv - nonLand - gdv * ((a.profitTargetGdvPct || 15) / 100);
  // The industry viability test in ratio form: RLV ÷ benchmark land value.
  // ≥1 means the scheme can pay the (localised) benchmark and still hit the
  // target margin; <1 means the land demands more than the scheme can bear.
  const rlvVsBlv = land > 0 ? residualLandValue / land : null;

  // IRR on the equity cashflow (monthly, bisection, annualised). Null when the
  // flows are degenerate — an "IRR" of a no-equity or loss-making stream is
  // noise, and "n/a" is the honest render.
  const irr = (() => {
    const anyNeg = equityFlow.some(v => v < -1), anyPos = equityFlow.some(v => v > 1);
    if (!anyNeg || !anyPos) return null;
    const npv = r => equityFlow.reduce((s, v, m) => s + v / Math.pow(1 + r, m), 0);
    let lo = -0.5, hi = 1.0;
    if (npv(lo) * npv(hi) > 0) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      (npv(lo) * npv(mid) <= 0) ? (hi = mid) : (lo = mid);
    }
    return (Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100;
  })();

  // Two-way sensitivity: build cost × sales value, ±10% in 1% steps (21×21).
  // Rows = build, cols = sales. Recursion is fenced off by opts.noSens — and
  // only the modal preview and site report ever request it, so the 441
  // appraisals (~tens of ms) never touch the per-station sift loop.
  let sensitivity = null;
  if (!opts.noSens) {
    const steps = SENS_STEPS;
    sensitivity = steps.map(b => steps.map(s => {
      const aa = Object.assign({}, a, {
        buildPm2House: (a.buildPm2House || 0) * (1 + b / 100),
        buildPm2Flat: (a.buildPm2Flat || 0) * (1 + b / 100),
        salesAdjPct: (a.salesAdjPct || 100) * (1 + s / 100),
        salesPsf: (a.salesPsf || 350) * (1 + s / 100),
      });
      const r = computeAppraisal(inputs, aa, { noSens: true });
      return r.profitOnCost;
    }));
  }

  const target = a.profitTargetPct || 17.5;
  const rag = poc == null ? "n/a"
    : poc >= target ? "viable" : poc >= target * 0.5 ? "marginal" : "unviable";
  const score = poc == null ? 0
    : Math.max(0, Math.min(100, 25 + (poc / (2 * target)) * 55));

  return {
    profitOnCost: poc, profitOnGdv: pog, rag, score,
    price: Math.round(price), local: localPsf != null,
    gdv, totalCost, profit, residualLandValue, rlvVsBlv, valueRatio, irr, peakDebt,
    landBasisUsed, landScale: landBasisUsed === "mhclg" ? null : landScale,
    cashflow: { out, inn, equityFlow, months, interest, financeFee },
    sensitivity,
    // Every intermediate the arithmetic passed through, for the "Full
    // calculation" audit modal — rendered from THIS trace, never re-derived,
    // so the breakdown a client checks is the arithmetic that actually ran.
    audit: {
      units, unitFt2, unitM2, localPsf, price, blend, midSaleYears, infl,
      flatFrac, pm2, locFactor: inputs.locationFactor || a.costIndexFactor || 1,
      buildBase, abnormals, prepInfra, hardCost, fees, contingency,
      refPsf, valueRatio, policyScale, policyCosts, salesCosts,
      mhclgLand, land, preCon, build, sell, overlap, months,
      equityCap, interest, financeFee, nonLand,
    },
    waterfall: [
      ["GDV", gdv], ["Build", -buildBase], ["Abnormals", -abnormals],
      ["Site prep & infra", -prepInfra], ["Fees", -fees],
      ["Contingency", -contingency], ["CIL/S106/BNG", -policyCosts],
      ["Sales costs", -salesCosts], ["Finance", -(interest + financeFee)],
      ["Land", -land], ["Profit", profit],
    ],
  };
}

// Sensitivity axis shared by the engine and every renderer of the grid: every
// whole percent from -10 to +10 on both build cost and sales value.
const SENS_STEPS = Array.from({ length: 21 }, (_, i) => i - 10);

// Legacy shape for the sift pipeline — same keys the funnel, sort and CSV
// exports already read. The sift's whole-catchment appraisal is just the
// engine with the row's yield and catchment £/m². Sensitivity is skipped for
// speed: scoring ~2,400 stations must stay instant.
function computeViability(row) {
  const r = computeAppraisal(
    { units: row.effYield ?? (row.yield || 0), ppm2: row.catchmentPpm2, region: row.region,
      // The SAME land basis as the station's own deep dive: developable
      // hectares × the authority's published MHCLG £/ha (falling back to the
      // localised £/unit benchmark where the data doesn't cover the station).
      // Without this the two surfaces contradicted each other on land cost.
      areaHa: row.effHa ?? row.developableHa ?? null,
      landValueHa: row.landValueHa ?? null,
      // Localise BUILD costs too, not just sales: the regional index from the
      // build-cost proxy, so a Yorkshire scheme isn't costed at London rates.
      locationFactor: regionCostFactor(row.region) },
    SIFT.assumptions, { noSens: true });
  return { profitOnCost: r.profitOnCost, rag: r.rag, score: r.score,
           price: r.price, local: r.local, gdv: r.gdv, profit: r.profit,
           rlvVsBlv: r.rlvVsBlv, landBasisUsed: r.landBasisUsed };
}

// Attach the computed viability appraisal to every row (called before filter/sort).
// Deliverability & a 3-axis composite were removed per review — the funnel now ends
// on viability; they will return when deliverability is rebuilt.
function scoreSiftRows() {
  // Effective developable area/yield — two optional narrowings, applied in
  // order, and every downstream number (step-2 filters, viability units,
  // table, CSV, totals) sees the result. Yield scales proportionally with
  // area since it's area × a flat density floor.
  //   1. Largest plot only (step 2): base = the single largest contiguous
  //      plot, so a catchment of scattered slivers stops out-ranking one
  //      clean site. Null (not yet rebuilt) falls back to the total.
  //   2. Green Belt exclusion (step 3): scale by the NON-Green-Belt share of
  //      the catchment's developable land. On a largest-plot base this is an
  //      approximation — the GB share of that specific plot isn't stored.
  const nogb = SIFT.crit.excludeGreenBelt;
  const lgOnly = SIFT.crit.largestPlotOnly;
  for (const r of SIFT.rows) {
    const base = lgOnly && r.largestPlotHa != null
      ? Math.min(r.largestPlotHa, r.developableHa) : r.developableHa;
    const gbScale = nogb && r.developableHa > 0
      ? Math.max(0, 1 - (r.greenBeltHa || 0) / r.developableHa) : 1;
    r.effHa = base * gbScale;
    r.effYield = r.developableHa > 0
      ? Math.round((r.yield || 0) * (r.effHa / r.developableHa)) : (r.yield || 0);
    r._viab = computeViability(r);
  }
}

async function enterSiftMode() {
  if (!SIFT.loaded) {
    const summary = document.getElementById("sift-summary");
    if (summary) summary.textContent = "Loading station assessments…";
    await loadSiftData();
  }
  SIFT.step = 0;   // start the funnel at the first gate
  renderSift();
}

function exitSiftMode() {
  if (map.getLayer("station-dot")) { try { map.setFilter("station-dot", null); } catch (_) {} }
  if (typeof removeSiftEmphasis === "function") removeSiftEmphasis();
}

async function loadSiftData() {
  const sb = (typeof getSupabase === "function") ? getSupabase() : null;
  if (!sb) { SIFT.rows = []; SIFT.loaded = false; return; }
  try {
    // PostgREST caps a response at ~1000 rows, so page through in ranges until a
    // short page — otherwise the sift silently sees only the top 1000 stations.
    // MHCLG land value per station, in parallel with the assessment pages —
    // the sift MUST price land from the same published benchmark the deep
    // dive uses, or the two read different verdicts for the same station
    // (Kensal Green: '£160M profit' in the sift, 'unviable' in its dive).
    // ONE jsonb object, not rows: PostgREST caps set-returning responses at
    // 1,000 rows and there are 2,007 stations with a value — the row version
    // silently dropped half the country back onto proxy land.
    const landValuesP = sb.rpc("station_land_values")
      .then(r => new Map(Object.entries(r.data || {}).map(([k, v]) => [k, Number(v) || null])))
      .catch(() => new Map());
    const PAGE = 1000;
    let data = [], from = 0;
    for (;;) {
      const { data: page, error } = await sb
        .from("station_assessments")
        .select("crs, country, tier, in_settlement, density_floor, developable_ha, largest_plot_ha, dwelling_yield, constraint_friction, green_belt_ha, soft_cover, benefit_score, regen_score, access_score, housing_score, catchment_imd, catchment_pop, catchment_ppm2, catchment_median_price, stations(name, region, ttwa_name, well_connected, meets_frequency, connectivity_pctile, direct_destinations)")
        .order("dwelling_yield", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      data = data.concat(page || []);
      if (!page || page.length < PAGE) break;
      from += PAGE;
    }
    const landValues = await landValuesP;
    SIFT.rows = (data || []).map(r => ({
      crs: r.crs, country: r.country || "england", tier: r.tier, inSettlement: !!r.in_settlement, densityFloor: r.density_floor,
      landValueHa: landValues.get(r.crs) ?? null,
      developableHa: Number(r.developable_ha) || 0, yield: r.dwelling_yield || 0,
      largestPlotHa: r.largest_plot_ha == null ? null : Number(r.largest_plot_ha),
      wellConnected: !!(r.stations && r.stations.well_connected),
      meetsFrequency: !!(r.stations && r.stations.meets_frequency),
      connectivityPctile: (r.stations && r.stations.connectivity_pctile != null) ? Number(r.stations.connectivity_pctile) : null,
      directDest: (r.stations && r.stations.direct_destinations != null) ? Number(r.stations.direct_destinations) : null,
      friction: r.constraint_friction == null ? null : Number(r.constraint_friction),
      greenBeltHa: Number(r.green_belt_ha) || 0,
      softCover: r.soft_cover || {},
      benefit: r.benefit_score == null ? null : Number(r.benefit_score),
      regen: r.regen_score == null ? null : Number(r.regen_score),
      access: r.access_score == null ? null : Number(r.access_score),
      housing: r.housing_score == null ? null : Number(r.housing_score),
      catchmentImd: r.catchment_imd == null ? null : Number(r.catchment_imd),
      catchmentPop: r.catchment_pop == null ? null : Number(r.catchment_pop),
      catchmentPpm2: r.catchment_ppm2 == null ? null : Number(r.catchment_ppm2),
      catchmentMedianPrice: r.catchment_median_price == null ? null : Number(r.catchment_median_price),
      name: (r.stations && r.stations.name) || r.crs,
      region: (r.stations && r.stations.region) || "",
      ttwa: (r.stations && r.stations.ttwa_name) || "",
    }));
    SIFT.loaded = true;
  } catch (e) {
    console.error("sift load failed", e);
    SIFT.rows = []; SIFT.loaded = false;
  }
}

// The sift is a sequential funnel: an ordered series of gated steps, each with a
// predicate. Survivors "up to" a step are the rows passing steps 0..step. The UI
// shows only the current step's controls; the funnel count narrows step by step.
const SIFT_STEPS = [
  // Steps 1 (connectivity) and 2 (eligibility & tier) were merged 2026-08: the
  // tier IS the connectivity story told once — Tier A/B are computed from the
  // same in-settlement / well-connected facts the old step 1 tested, so two
  // steps meant explaining the same concepts twice. The predicate is the AND
  // of both old predicates: nothing passes or fails differently.
  { key: "connectivity", title: "1 · Station gate — connectivity & tier",
    about: {
      what: "The entry gate. Every station is classed by the draft NPPF's two-tier test: Tier A — inside a settlement, where station-adjacent development is a 'default yes'; Tier B — outside a settlement but well-connected (a genuine turn-up-and-go service in an economically significant area), where the draft NPPF now permits Green Belt release; anything else is ineligible. The tier also sets the density floor used for dwelling capacity: 50 dph for well-connected stations, else 40 dph.",
      source: "Draft NPPF (2024 consultation), development around well-connected stations. Service test: at least 4 services per hour overall, or 2 per hour in each direction, through the daytime; 'well-connected' additionally requires the station's Travel-to-Work Area to be economically significant (top 60 by GVA, ONS). Density floors: 40 dph baseline, 50 dph in the most accessible locations.",
      calc: "meets_frequency = sustained trains/trams ≥ 4/hour (or ≥ 2/hour each direction), from the GB rail timetable. well_connected = meets_frequency AND top-60 TTWA. 'In settlement' is deliberately NOT a point-in-polygon test — a station often sits in the railway gap of a built-up-area polygon, which wrongly flagged dense urban stations (e.g. South Bermondsey) as out-of-settlement. Instead we measure the BUILT-UP FRACTION of the 800 m catchment (OS Open Built-Up Areas): in-settlement when ≥ 40% built-up, or ≥ 20% with built-up land within 100 m. Tier A = in-settlement; Tier B = out-of-settlement AND well-connected; else ineligible. Density floor = 50 dph if well-connected, else 40 dph." },
    // The AND of the two former predicates. In-settlement stations are exempt
    // from the service tests by default (the NPPF 'default yes'); the strict
    // toggle applies them everywhere. The tier checkboxes then pick which
    // classes go forward. Out-of-settlement stations kept via 'include
    // ineligible' still face the frequency test.
    pred: (r, c) => {
      const exempt = c.exemptInSettlement && r.inSettlement;
      if (!exempt) {
        if (c.requireFrequency && !r.meetsFrequency) return false;
        if (c.requireWellConnected && !r.wellConnected) return false;
      }
      return (r.tier === "A" && c.tierA) || (r.tier === "B" && c.tierB) ||
             (r.tier === "ineligible" && c.ineligible);
    } },
  { key: "developable", title: "2 · Developable land",
    about: {
      what: "The net land physically available for homes within an ~800 m (10-minute) walk of the station, and the dwelling capacity that implies.",
      source: "NPPF 'reasonable walking distance' of a station; the net-developable-area method (start from the catchment, erase undevelopable land) is standard practice in Housing & Economic Land Availability Assessments (HELAA).",
      calc: "800 m circular catchment MINUS (PostGIS ST_Difference) built-up land, green space, transport corridors (roads + railway curtilage), flood zone 3 and hard environmental designations. dwelling_yield = net developable hectares × the density floor from step 1. 'Largest plot only' swaps the catchment total for the single largest contiguous plot (precomputed per station), screening out fragmented catchments; yield scales pro-rata." },
    pred: (r, c) => (r.effHa ?? r.developableHa) >= c.minDevHa &&
                    (r.effYield ?? r.yield) >= c.minYield },
  { key: "protected", title: "3 · Protected land %",
    about: {
      what: "Of the land left after hard exclusions, how much sits under a SOFT heritage or landscape designation — one that doesn't stop development outright but adds planning friction, delay and cost.",
      source: "NPPF Chapter 16 (heritage — conservation areas, listed-building settings) and Chapter 15 (National Landscapes / AONB, valued landscapes), plus locally registered parks & gardens. These are 'material considerations' weighed in the planning balance, not absolute constraints — unlike SSSIs, SACs, SPAs, Ramsar, ancient woodland and scheduled monuments, which are hard exclusions already removed in step 2.",
      calc: "Protected land % = the share of the net developable polygon (from step 2) that intersects soft designations — conservation areas, AONB / National Landscapes, registered parks & gardens and listed-building setting buffers — measured by area. The slider caps how much of a site may be so designated." },
    pred: (r, c) => r.friction == null || r.friction * 100 <= c.maxProtectedPct },
  { key: "regen", title: "4 · Regeneration need",
    about: {
      what: "Focuses the shortlist on the places that would benefit most from investment — the most deprived station catchments.",
      source: "English Indices of Multiple Deprivation 2019 (MHCLG / ONS), at LSOA level. IMD combines seven domains: income, employment, health, education, crime, barriers to housing & services, and living environment.",
      calc: "Each station's catchment deprivation = the population-weighted average IMD of the LSOAs within 800 m, expressed as a NATIONAL PERCENTILE (0 = least deprived, 100 = most deprived). The filter keeps only stations whose catchment falls in the top X% most deprived — e.g. 'top 10%' keeps percentile ≥ 90." },
    pred: (r, c) => {
      const top = c.deprivedTopPct == null ? 100 : c.deprivedTopPct;
      if (top >= 100) return true;                 // filter off — keep all
      if (r.regen == null) return true;            // no score — don't drop
      return r.regen >= (100 - top);               // top X% most deprived
    } },
  { key: "viability", title: "5 · Viability",
    about: {
      what: "A residual land-appraisal test of whether a policy-compliant scheme stacks up financially. This is the final gate — the sift ends here (deliverability will return once rebuilt).",
      source: "NPPF para 58 and Planning Practice Guidance 'Viability': residual appraisal, profit on cost, and benchmark land value.",
      calc: "GDV (net homes × average unit ft² × local £/ft², blended down for the affordable share) − build cost − soft costs − land = profit; profit on cost % = profit ÷ total cost. The local £/ft² is each station's catchment-weighted HM Land Registry £/m² (Price Paid × EPC floor area) over the LSOAs within 800 m — so value reflects the actual neighbourhood, not a broad region. Every assumption is adjustable below." },
    // Filter on profit on cost %. A null appraisal (no dwelling yield) only passes
    // when the floor is effectively off (≤ -100).
    pred: (r, c) => c.minProfitOnCost == null ? true
      : (r._viab.profitOnCost == null ? c.minProfitOnCost <= -100
        : r._viab.profitOnCost >= c.minProfitOnCost) },
];

function siftSortKey() {
  return {
    yield: r => r.effYield ?? (r.yield || 0),
    regen: r => r.regen || 0,
    viability: r => r._viab.profitOnCost == null ? -1e9 : r._viab.profitOnCost,
    // Absolute £ rankings: scale × margin, so a big marginal scheme can
    // out-rank a small lucrative one — the portfolio lens.
    gdv: r => r._viab.gdv == null ? -1e12 : r._viab.gdv,
    profit: r => r._viab.profit == null ? -1e12 : r._viab.profit,
  }[SIFT.sort] || (r => r._viab.profitOnCost == null ? -1e9 : r._viab.profitOnCost);
}

// Stations of the currently-selected country (England / Scotland are sifted
// separately — different frameworks, non-comparable metrics).
function siftCountryRows() {
  return SIFT.rows.filter(r => (r.country || "england") === SIFT.country);
}

// Rows passing every step predicate up to and including stepIdx, sorted.
function siftSurvivorsUpTo(stepIdx) {
  const c = SIFT.crit;
  scoreSiftRows();
  const steps = SIFT_STEPS.slice(0, stepIdx + 1);
  const out = siftCountryRows().filter(r => steps.every(s => s.pred(r, c)));
  const key = siftSortKey();
  out.sort((a, b) => key(b) - key(a));
  return out;
}
function siftSurvivors() { return siftSurvivorsUpTo(SIFT.step); }

// Cumulative count remaining after each step — the funnel shown in the stepper.
function siftFunnelCounts() {
  const c = SIFT.crit;
  scoreSiftRows();
  let pool = siftCountryRows();
  return SIFT_STEPS.map(s => { pool = pool.filter(r => s.pred(r, c)); return pool.length; });
}

function siftNumField(id, label, val, step, tip) {
  const t = tip ? ` title="${tip.replace(/"/g, "&quot;")}"` : "";
  const help = tip ? ` <span class="sift-help" title="${tip.replace(/"/g, "&quot;")}">ⓘ</span>` : "";
  return `<label class="sift-field"${t}><span>${label}${help}</span>` +
    `<input type="number" id="${id}" step="${step}" value="${val}"></label>`;
}

// Controls HTML for one step only (keeps the panel uncluttered).
function siftStepControlsHTML(key) {
  const A = SIFT.assumptions, C = SIFT.crit;
  const chk = v => v ? " checked" : "";
  switch (key) {
    case "connectivity":
      return `<p class="hint">Every station lands in one of two NPPF tiers — or neither. <strong>Tier A · in-settlement</strong>: the catchment is already built-up, so development is a 'default yes' regardless of service level. <strong>Tier B · well-connected, out-of-settlement</strong>: a genuine turn-up-and-go service (≥4 trains/hour, or 2 each way) in a top-60 economic area — where the draft NPPF permits Green Belt release. Everything else is <strong>ineligible</strong>. The tier also sets the density floor: 50 dph well-connected, else 40 dph. Tick which classes go forward.</p>` +
        `<label class="dd-row"><input type="checkbox" id="sift-tierA"${chk(C.tierA)}> <span>Tier A · in-settlement ('default yes')</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sift-tierB"${chk(C.tierB)}> <span>Tier B · well-connected, out-of-settlement (Green Belt permitted)</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sift-inelig"${chk(C.ineligible)}> <span>Include ineligible stations (they still face the service-frequency test)</span></label>` +
        `<p class="hint" style="margin-top:8px"><strong>Stricter than the NPPF</strong> (optional):</p>` +
        `<label class="dd-row"><input type="checkbox" id="sc-strict"${chk(!C.exemptInSettlement)}> <span>Apply the service-frequency test inside settlements too</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sc-wc"${chk(C.requireWellConnected)}> <span>Require full 'well-connected' status (frequency + top-60 TTWA)</span></label>` +
        `<p class="hint" style="margin-top:4px">The NPPF treats in-settlement stations as a 'default yes' whatever their timetable — the first toggle removes that exemption. The second demands the full well-connected definition wherever the service tests apply.</p>`;
    case "developable":
      return `<p class="hint">Net developable area within 800 m after erasing built-up land, green space, transport (roads + railway curtilage), flood zone 3 and hard environmental designations.</p>` +
        siftNumField("sift-minha", "Min developable ha", C.minDevHa || 0, 1) +
        siftNumField("sift-minyield", "Min dwelling yield", C.minYield || 0, 50) +
        `<label class="dd-row"><input type="checkbox" id="sift-largest"${chk(C.largestPlotOnly)}> <span>Largest plot only</span></label>` +
        `<p class="hint" style="margin-top:4px">Sift each station on its single <strong>largest contiguous plot</strong> instead of the catchment total — screens out places whose hectares are really a scatter of small, awkward sites. While on, the filters above, the viability appraisal and all totals use the largest plot (yield scaled pro-rata).</p>`;
    case "protected":
      return `<p class="hint">Hard designations (SSSI, SAC, SPA, Ramsar, ancient woodland, scheduled monuments) are already erased in step 2. This caps how much of the remaining developable land sits under a <strong>soft</strong> designation — conservation areas, AONB / National Landscapes, registered parks &amp; gardens and listed-building settings — which don't block development but add planning friction.</p>` +
        `<label class="sift-field"><span>Max protected land <b id="sift-prot-val">${Math.round(C.maxProtectedPct)}%</b></span><input type="range" id="sift-maxprot" min="0" max="100" step="5" value="${C.maxProtectedPct}"></label>` +
        `<label class="dd-row"><input type="checkbox" id="sift-nogb"${chk(C.excludeGreenBelt)}> <span>Exclude Green Belt land</span></label>` +
        `<p class="hint" style="margin-top:4px">With this on, each station's developable area and dwelling yield are counted <strong>net of Green Belt hectares</strong> — the exclusion flows through the land filters, the viability appraisal and the totals. Off by default because the draft NPPF explicitly permits Green Belt release around well-connected stations (Tier B).</p>`;
    case "regen":
      return `<p class="hint">Target the most deprived catchments. Each station's catchment deprivation is a national percentile of the population-weighted IMD (2019) of its LSOAs — <strong>100 = most deprived</strong>. Keep only stations in the top X% most deprived.</p>` +
        `<label class="sift-field"><span>Show top <b id="sift-depriv-val">${Math.round(C.deprivedTopPct)}%</b> most deprived</span><input type="range" id="sift-depriv" min="5" max="100" step="5" value="${C.deprivedTopPct}"></label>` +
        `<p class="hint" style="margin-top:4px">100% keeps every station; 10% keeps only catchments in the most-deprived national decile.</p>`;
    case "viability":
      return `<p class="hint"><strong>Viability</strong> runs a full residual appraisal per scheme — GDV from the <strong>local sales value</strong> (catchment-weighted Land Registry £/m² × EPC floor areas within 800 m), against typology build costs on a location index, abnormals, fees, policy costs (CIL/S106/BNG), an explicit finance line from a monthly cashflow, and land priced at the <strong>published MHCLG £/ha for the station's authority</strong> (the same basis the deep dive uses; localised £/unit fallback where uncovered). Headline levers below; <strong>every</strong> assumption is tweakable in Viability variables.</p>` +
        siftNumField("v-salesadj", "New-build premium %", A.salesAdjPct, 5,
          "Applied to the local market £/ft² from Land Registry data. 100% = resale parity; new build typically 105–115.") +
        siftNumField("v-buildh", "Build £/m² (houses)", A.buildPm2House, 25,
          "Headline construction rate for houses, GIA, at the NATIONAL average — each station is then scaled by its regional build-cost index (London ×1.18 … North East ×0.90, from the free proxy behind the build-cost layer). Paste a BCIS rate if you hold a licence. Flats and the full cost stack are in Viability variables.") +
        siftNumField("v-aff", "Affordable %", A.affordablePct, 5,
          "Share of homes delivered as affordable, valued at the % of market set in Viability variables.") +
        siftNumField("v-target", "Profit target %", A.profitTargetPct, 0.5,
          "Required profit on cost. At/above = viable (green); half of it = marginal (amber); below = unviable (red).") +
        siftNumField("v-minpoc", "Min profit on cost %", C.minProfitOnCost, 1,
          "FILTER: only keep stations achieving at least this profit on cost. Set to your target to keep only viable schemes; leave low (-30) to keep all and rank.") +
        `<button type="button" id="viab-vars-btn" class="ghost" style="margin:6px 0">Viability variables — full assumption set…</button>` +
        `<label class="sift-field"><span>Rank shortlist by</span><select id="sift-sort">` +
        ["viability:Viability (profit on cost %)", "profit:Total profit (£)",
         "gdv:Total GDV (£)", "regen:Regeneration need", "yield:Dwelling yield"]
          .map(o => { const [v, t] = o.split(":"); return `<option value="${v}"${SIFT.sort === v ? " selected" : ""}>${t}</option>`; })
          .join("") + `</select></label>`;
  }
  return "";
}

// Read whatever controls are currently in the DOM (only the current step's) into
// the persistent SIFT state. Absent inputs leave their state untouched.
function readSiftControls() {
  const g = id => document.getElementById(id);
  const C = SIFT.crit, A = SIFT.assumptions;
  const numv = (id, d) => { const el = g(id); if (!el) return d; const v = parseFloat(el.value); return isNaN(v) ? d : v; };
  // Merged step 1: the strict toggle is the INVERSE of the NPPF in-settlement
  // exemption. requireFrequency stays a stored flag (default true) — no longer
  // a visible control, but saved configs that disabled it are honoured.
  if (g("sc-strict")) C.exemptInSettlement = !g("sc-strict").checked;
  if (g("sc-wc")) C.requireWellConnected = g("sc-wc").checked;
  if (g("sift-tierA")) C.tierA = g("sift-tierA").checked;
  if (g("sift-tierB")) C.tierB = g("sift-tierB").checked;
  if (g("sift-inelig")) C.ineligible = g("sift-inelig").checked;
  if (g("sift-minha")) C.minDevHa = numv("sift-minha", 0);
  if (g("sift-minyield")) C.minYield = numv("sift-minyield", 0);
  if (g("sift-largest")) C.largestPlotOnly = g("sift-largest").checked;
  if (g("sift-maxprot")) C.maxProtectedPct = numv("sift-maxprot", 100);
  if (g("sift-nogb")) C.excludeGreenBelt = g("sift-nogb").checked;
  if (g("sift-depriv")) C.deprivedTopPct = numv("sift-depriv", 100);
  if (g("v-minpoc")) C.minProfitOnCost = numv("v-minpoc", -30);
  // Headline fields only — the full assumption set lives in the Viability
  // variables modal, which writes into the same SIFT.assumptions object.
  [["v-salesadj", "salesAdjPct"], ["v-buildh", "buildPm2House"],
   ["v-aff", "affordablePct"], ["v-target", "profitTargetPct"]].forEach(([id, key]) => {
    if (g(id)) A[key] = numv(id, A[key]);
  });
  if (g("sift-sort")) SIFT.sort = g("sift-sort").value;
  // live slider labels
  const lbl = (id, v) => { const el = g(id); if (el) el.textContent = v; };
  if (g("sift-maxprot")) lbl("sift-prot-val", Math.round(C.maxProtectedPct) + "%");
  if (g("sift-depriv")) lbl("sift-depriv-val", Math.round(C.deprivedTopPct) + "%");
  persistSiftConfig();   // remember the configuration across reloads
}

// Download the current ranked survivors as a CSV (there is no server; build a
// Blob and click a temporary link). Includes tier, density, capacity + all scores.
function exportSiftCsv() {
  const rows = siftSurvivorsUpTo(SIFT.step);
  const cols = ["rank", "crs", "name", "region", "tier", "density_floor", "developable_ha",
    "largest_plot_ha", "dwelling_yield", "protected_land_pct", "green_belt_ha",
    "regeneration_need_pctile", "viability_profit_on_cost_pct",
    "total_gdv_gbp", "total_profit_gbp", "viability_rag"];
  const esc = v => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  rows.forEach((r, i) => {
    lines.push([i + 1, r.crs, r.name, r.region, r.tier, r.densityFloor ?? "",
      r.effHa ?? r.developableHa, r.largestPlotHa ?? "",
      r.effYield ?? r.yield, r.friction == null ? "" : Math.round(r.friction * 100), r.greenBeltHa,
      r.regen == null ? "" : Math.round(r.regen),
      r._viab.profitOnCost == null ? "" : r._viab.profitOnCost.toFixed(1),
      r._viab.gdv == null ? "" : Math.round(r._viab.gdv),
      r._viab.profit == null ? "" : Math.round(r._viab.profit),
      r._viab.rag].map(esc).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `mastermapper-sift-${rows.length}-stations.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Shortlist-only CSV (the pinned stations), for the saved shortlist.
function exportShortlistCsv() {
  const set = SIFT.shortlist;
  const rows = SIFT.rows.filter(r => set.has(r.crs));
  scoreSiftRows();
  const cols = ["crs", "name", "region", "tier", "density_floor", "dwelling_yield",
    "regeneration_need_pctile", "viability_profit_on_cost_pct"];
  const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")];
  rows.forEach(r => lines.push([r.crs, r.name, r.region, r.tier, r.densityFloor ?? "", r.yield,
    r.regen == null ? "" : Math.round(r.regen),
    r._viab.profitOnCost == null ? "" : r._viab.profitOnCost.toFixed(1)].map(esc).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `mastermapper-shortlist-${rows.length}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render the stepper + the current step's controls + nav. Full re-render on step
// change only; input events update counts/table via updateSiftFunnel (no control
// re-render), so number-field focus isn't lost mid-type.
function renderSiftStep() {
  const crit = document.getElementById("sift-criteria");
  if (!crit) return;
  // The funnel shrank from 6 steps to 5 (station gate merge) — clamp any
  // stale index so an in-flight session can't render past the end.
  if (SIFT.step >= SIFT_STEPS.length) SIFT.step = SIFT_STEPS.length - 1;
  const step = SIFT.step;
  const counts = siftFunnelCounts();
  const stepper = SIFT_STEPS.map((s, i) =>
    `<button type="button" class="sift-step-chip${i === step ? " active" : ""}${i < step ? " done" : ""}" data-step="${i}" title="${escapeSift(s.title)}">` +
    `<span class="ssc-n">${i + 1}</span><span class="ssc-c">${counts[i].toLocaleString()}</span></button>`).join("");
  const def = SIFT_STEPS[step];
  const last = SIFT_STEPS.length - 1;
  const csel = (v, label) => `<button type="button" class="sift-country-btn${SIFT.country === v ? " active" : ""}" data-country="${v}">${label}</button>`;
  crit.innerHTML =
    `<div class="sift-country" title="England and Scotland are sifted separately — different planning frameworks (NPPF vs NPF4) and deprivation indices (IMD vs SIMD), so their metrics are not directly comparable.">${csel("england", "🏴 England")}${csel("scotland", "🏴 Scotland")}</div>` +
    `<div class="sift-stepper">${stepper}</div>` +
    `<div class="sift-step-body"><div class="sift-stage-h">${escapeSift(def.title)}</div>` +
    siftAboutHTML(def) +
    siftStepControlsHTML(def.key) + `</div>` +
    `<div class="sift-nav">` +
    `<button type="button" class="ghost" id="sift-back"${step === 0 ? " disabled" : ""}>← Back</button>` +
    `<span class="sift-nav-count" id="sift-stepcount"></span>` +
    `<button type="button" class="plot-mode-btn sift-next" id="sift-next"${step >= last ? " disabled" : ""}>Next →</button>` +
    `</div>`;
  crit.querySelectorAll(".sift-country-btn").forEach(b =>
    b.addEventListener("click", () => {
      if (SIFT.country === b.dataset.country) return;
      SIFT.country = b.dataset.country;
      mmStore.set("siftCountry", SIFT.country);
      renderSift();
    }));
  crit.querySelectorAll(".sift-step-chip").forEach(b =>
    b.addEventListener("click", () => { SIFT.step = +b.dataset.step; renderSift(); }));
  crit.querySelector("#sift-back").addEventListener("click", () => { if (SIFT.step > 0) { SIFT.step--; renderSift(); } });
  crit.querySelector("#sift-next").addEventListener("click", () => { if (SIFT.step < last) { SIFT.step++; renderSift(); } });
  crit.querySelectorAll(".sift-step-body input, .sift-step-body select").forEach(i =>
    i.addEventListener("input", () => { readSiftControls(); updateSiftFunnel(); }));
  const vbtn = crit.querySelector("#viab-vars-btn");
  if (vbtn) vbtn.addEventListener("click", () => {
    // Preview context: the current top sift survivor, so edits show their
    // effect on a real station rather than an abstract example.
    const top = siftSurvivorsUpTo(SIFT_STEPS.length - 1)[0]
             || siftCountryRows()[0] || null;
    openViabilityModal(top ? {
      label: top.name || top.crs,
      units: top.effYield ?? (top.yield || 0), ppm2: top.catchmentPpm2, region: top.region,
      areaHa: top.effHa ?? top.developableHa ?? null,
      landValueHa: top.landValueHa ?? null,
      locationFactor: regionCostFactor(top.region),   // preview = sift arithmetic
      onChange: () => { scoreSiftRows(); updateSiftFunnel(); },
    } : null);
  });
}

// Recompute survivors up to the current step + refresh the summary, stepper
// counts and results table (no control re-render).
function updateSiftFunnel() {
  const summary = document.getElementById("sift-summary");
  const results = document.getElementById("sift-results");
  if (!summary || !results) return;
  const counts = siftFunnelCounts();
  document.querySelectorAll(".sift-step-chip .ssc-c").forEach((el, i) => {
    if (counts[i] != null) el.textContent = counts[i].toLocaleString();
  });
  const surv = siftSurvivorsUpTo(SIFT.step);
  const totalYield = surv.reduce((s, r) => s + (r.effYield ?? r.yield ?? 0), 0);
  const stepTitle = SIFT_STEPS[SIFT.step].title.replace(/^\d+ · /, "");
  const countryTotal = siftCountryRows().length;
  summary.innerHTML =
    `<strong>${surv.length.toLocaleString()}</strong> of ${countryTotal.toLocaleString()} ${SIFT.country === "scotland" ? "Scottish" : "English"} stations remain after ` +
    `<em>${escapeSift(stepTitle)}</em> · ~<strong>${totalYield.toLocaleString()}</strong> dwellings`;
  const sc = document.getElementById("sift-stepcount");
  if (sc) sc.textContent = `${surv.length.toLocaleString()} remain`;
  renderSiftTable(surv, results);
  highlightSiftSurvivors(surv);
}

function escapeSift(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Expandable (collapsed) "about this step" panel: what it is, where it's from
// (source / quote) and exactly how it's calculated here. Every sift step has one.
function siftAboutHTML(def) {
  const a = def.about;
  if (!a) return "";
  return `<details class="sift-about"><summary>ⓘ About this step — what it is, its source &amp; how it's calculated</summary>` +
    `<div class="sift-about-body">` +
    `<p><b>What it is.</b> ${escapeSift(a.what)}</p>` +
    `<p><b>Source.</b> ${escapeSift(a.source)}</p>` +
    `<p><b>How it's calculated here.</b> ${escapeSift(a.calc)}</p>` +
    `</div></details>`;
}

// Dispatcher: (re)build the current step, then compute the funnel/table.
function renderSift() {
  const summary = document.getElementById("sift-summary");
  const results = document.getElementById("sift-results");
  const crit = document.getElementById("sift-criteria");
  if (!summary || !results || !crit) return;
  if (!SIFT.loaded) {
    summary.textContent = "Station assessments unavailable (database not reachable).";
    results.innerHTML = ""; crit.innerHTML = ""; return;
  }
  renderSiftStep();
  updateSiftFunnel();
}

// The ranked survivors table (shared by every step).
function renderSiftTable(surv, results) {
  const SORT_LABELS = { yield: "dwelling yield", regen: "regeneration need",
    viability: "viability", gdv: "total GDV", profit: "total profit" };
  const sortLabel = SORT_LABELS[SIFT.sort] || "viability";
  const top = surv.slice(0, 100);
  const vmoney = x => x == null ? "—"
    : "£" + (Math.abs(x) >= 1e9 ? (x / 1e9).toFixed(1) + "bn" : (x / 1e6).toFixed(0) + "M");
  const vcell = (r) => {
    const v = r._viab;
    if (v.profitOnCost == null) return `<td>—</td>`;
    const priceNote = v.price == null ? "" :
      ` · sales £${v.price}/ft² (${v.local ? "local Land Registry £/m²" : "regional fallback"})`;
    const tip = `profit on cost ${v.profitOnCost.toFixed(1)}% · GDV ${vmoney(v.gdv)} · ` +
      `profit ${vmoney(v.profit)} · RLV÷benchmark ${v.rlvVsBlv == null ? "n/a" : v.rlvVsBlv.toFixed(2) + "×"} · ` +
      `land ${v.landBasisUsed === "mhclg" ? "MHCLG £/ha (published)" : "localised £/unit benchmark"}; ` +
      `viability score ${Math.round(v.score)}${priceNote}`;
    // The cell shows the figure the table is RANKED by; the RAG colour stays
    // margin-based either way (a huge but margin-thin scheme reads amber/red).
    const text = SIFT.sort === "gdv" ? vmoney(v.gdv)
      : SIFT.sort === "profit" ? vmoney(v.profit)
      : v.profitOnCost.toFixed(0) + "%";
    return `<td><span class="sift-rag sift-rag-${v.rag}" title="${tip}">${text}</span></td>`;
  };
  const nShort = SIFT.shortlist.size;
  const star = crs => SIFT.shortlist.has(crs) ? "★" : "☆";
  results.innerHTML =
    `<div class="sift-actions">` +
    `<span class="sift-short-count">${nShort} shortlisted</span>` +
    `<button type="button" class="ghost" id="sift-csv" title="Export the ${surv.length.toLocaleString()} ranked survivors as CSV">⤓ Ranked CSV</button>` +
    (nShort ? `<button type="button" class="ghost" id="sift-short-csv" title="Export the shortlist as CSV">⤓ Shortlist</button>` +
              `<button type="button" class="ghost" id="sift-short-clear" title="Clear the shortlist">✕ Clear</button>` : "") +
    `</div>` +
    `<table class="sift-table"><thead><tr>` +
    `<th title="Shortlist — click a row's ★ to pin it. The shortlist is saved in your browser and exportable as CSV."></th>` +
    `<th title="Rank position within the current survivors, ordered by the 'Rank by' setting on the final step.">#</th>` +
    `<th title="Station name and region. Heavy-rail stations from the National Rail dataset (2,019 stations in England).">Station</th>` +
    `<th title="NPPF tier. A = in-settlement (≥40% of the 800 m catchment is built-up, per OS Open Built-Up Areas — or ≥20% with built-up land within 100 m). B = well-connected station outside a settlement (Green Belt permitted). Sets eligibility.">Tier</th>` +
    `<th title="Dwelling yield = net developable hectares × NPPF density floor (50 dph if well-connected, else 40 dph). Developable ha = 800 m catchment minus built-up land, green space, roads + railway, flood zone 3, and hard environmental designations (PostGIS ST_Difference). Hover a cell for the ha and dph used.">Yield</th>` +
    `<th title="Regeneration need — the station's catchment deprivation as a national percentile (population-weighted IMD 2019 of LSOAs within 800 m). 100 = most deprived. ⬡ marks developable land in the Green Belt.">Need</th>` +
    `<th title="Viability — profit on cost from a residual appraisal (GDV − build − soft costs − land). GDV uses each station's local Land Registry £/m²; all assumptions are set on the Viability step. Colour = viable / marginal / unviable vs your profit target.">Via</th>` +
    `</tr></thead><tbody>` +
    top.map((r, i) =>
      `<tr data-crs="${escapeSift(r.crs)}">` +
      `<td class="sift-star${SIFT.shortlist.has(r.crs) ? " on" : ""}" data-star="${escapeSift(r.crs)}" title="Shortlist">${star(r.crs)}</td>` +
      `<td>${i + 1}</td>` +
      `<td>${escapeSift(r.name)}<small>${escapeSift(r.region || r.ttwa)}</small></td>` +
      `<td><span class="sift-tier sift-tier-${r.tier}">${r.tier === "ineligible" ? "—" : r.tier}</span></td>` +
      `<td title="${(r.effHa ?? r.developableHa).toFixed(1)} developable ha · ${r.densityFloor || "?"} dph${SIFT.crit.excludeGreenBelt && r.greenBeltHa > 0 ? ` · net of ${r.greenBeltHa.toFixed(1)} ha Green Belt` : ""}">${(r.effYield ?? r.yield ?? 0).toLocaleString()}</td>` +
      `<td>${r.regen == null ? "—" : `<span class="sift-need" title="catchment IMD percentile ${Math.round(r.regen)} (100 = most deprived)${r.friction == null ? "" : ` · ${Math.round(r.friction * 100)}% protected land`}">${Math.round(r.regen)}</span>`}${r.greenBeltHa > 0 ? ` <span class="sift-gb" title="${r.greenBeltHa.toFixed(1)} ha developable in Green Belt">⬡</span>` : ""}</td>` +
      vcell(r) +
      `</tr>`
    ).join("") +
    `</tbody></table>` +
    (surv.length > 100 ? `<p class="hint">Showing the top 100 by ${sortLabel} of ${surv.length.toLocaleString()}.</p>` : "");
  results.querySelectorAll("td.sift-star").forEach(td =>
    td.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleShortlist(td.dataset.star);
      updateSiftFunnel();   // refresh stars + shortlist count
    }));
  results.querySelectorAll("tr[data-crs]").forEach(tr =>
    tr.addEventListener("click", () => siftDrillTo(tr.dataset.crs)));
  const csv = results.querySelector("#sift-csv");
  if (csv) csv.addEventListener("click", exportSiftCsv);
  const scsv = results.querySelector("#sift-short-csv");
  if (scsv) scsv.addEventListener("click", exportShortlistCsv);
  const sclr = results.querySelector("#sift-short-clear");
  if (sclr) sclr.addEventListener("click", () => { SIFT.shortlist.clear(); persistShortlist(); updateSiftFunnel(); });
}

function siftDrillTo(crs) {
  const feat = ((state.stationsData && state.stationsData.features) || [])
    .find(f => f.properties.crs === crs);
  if (!feat) return;
  const c = feat.geometry.coordinates;
  map.flyTo({ center: [c[0], c[1]], zoom: 13 });
  if (typeof profileStation === "function") profileStation(feat.properties, null);
}

function highlightSiftSurvivors(surv) {
  if (!map.getLayer("station-dot")) return;
  try {
    map.setFilter("station-dot", ["in", ["get", "crs"], ["literal", surv.map(r => r.crs)]]);
  } catch (_) { /* filter unsupported — leave all stations shown */ }
  renderSiftEmphasis(surv);
}

// Survivors drawn STRONGLY at any zoom, so a nationwide view reads as a
// geography of opportunity rather than a scatter of faint dots: every
// survivor gets a solid orange dot sized to survive z5, and the CURRENT top
// 10 (in the active sort) wear their rank as a number on an enlarged dot,
// with the station name alongside from regional zooms. Rebuilt on every sift
// re-render, torn down on leaving sift mode.
function renderSiftEmphasis(surv) {
  const byCrs = new Map(surv.map((r, i) => [r.crs, i + 1]));
  const feats = ((state.stationsData && state.stationsData.features) || [])
    .filter(f => byCrs.has(f.properties.crs))
    .map(f => ({ type: "Feature", geometry: f.geometry,
      properties: { crs: f.properties.crs, name: f.properties.name || f.properties.crs,
                    rank: byCrs.get(f.properties.crs) } }));
  const fc = { type: "FeatureCollection", features: feats };
  const src = map.getSource("sift-emph-src");
  if (src) { src.setData(fc); return; }
  map.addSource("sift-emph-src", { type: "geojson", data: fc });
  const topTen = ["<=", ["get", "rank"], 10];
  // Zoom must be the OUTER interpolate; the rank test nests inside each stop.
  const radius = ["interpolate", ["linear"], ["zoom"],
    4,  ["case", topTen, 8, 3.4],
    8,  ["case", topTen, 10, 5],
    12, ["case", topTen, 13, 7]];
  map.addLayer({ id: "sift-emph-dot", type: "circle", source: "sift-emph-src",
    paint: { "circle-radius": radius,
             "circle-color": "#e8590c",
             "circle-stroke-color": "#ffffff",
             "circle-stroke-width": ["case", topTen, 2, 1.2] } });
  map.addLayer({ id: "sift-emph-num", type: "symbol", source: "sift-emph-src",
    filter: topTen,
    layout: { "text-field": ["to-string", ["get", "rank"]],
              "text-font": ["Noto Sans Regular"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 8, 12, 12, 14],
              "text-allow-overlap": true },
    paint: { "text-color": "#ffffff" } });
  map.addLayer({ id: "sift-emph-name", type: "symbol", source: "sift-emph-src",
    filter: topTen, minzoom: 6,
    layout: { "text-field": ["get", "name"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10.5,
              "text-anchor": "top", "text-offset": [0, 1.1],
              "text-optional": true },
    paint: { "text-color": "#7c2d05", "text-halo-color": "#ffffff",
             "text-halo-width": 1.4 } });
}

function removeSiftEmphasis() {
  for (const id of ["sift-emph-num", "sift-emph-name", "sift-emph-dot"])
    if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("sift-emph-src")) map.removeSource("sift-emph-src");
}

// ---- Info-tooltip placement -----------------------------------------------
// The .tip bubbles are position:fixed (see styles.css) so they can never be
// cropped by a scrolling box; this places one beside its .info button the
// moment it's hovered or focused, preferring above, flipping below when the
// button sits near the top of the viewport, always clamped to the screen.
function _placeTip(btn) {
  const tip = btn.querySelector(".tip");
  if (!tip) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(260, window.innerWidth - 16);
  tip.style.width = w + "px";
  tip.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)) + "px";
  // visibility:hidden still has layout, so the height is measurable pre-show.
  const h = tip.offsetHeight || 120;
  const above = r.top - 8 - h;
  tip.style.top = (above >= 6 ? above
    : Math.min(r.bottom + 8, window.innerHeight - h - 6)) + "px";
}
document.addEventListener("mouseover", e => {
  const btn = e.target && e.target.closest ? e.target.closest(".info") : null;
  if (btn) _placeTip(btn);
});
document.addEventListener("focusin", e => {
  const btn = e.target && e.target.closest ? e.target.closest(".info") : null;
  if (btn) _placeTip(btn);
});

buildLayersPanel();       // the grouped Data layers tree (box 1) — must run
                          // first: buildSliders/wireImdToggle bind to elements
                          // the tree renders (#sliders, #imd-show, …).
buildSliders();
buildLegend();
wireImdToggle();          // IMD choropleth is a context layer, OFF by default
wireSideBoxes();          // minimiseable left boxes (persisted per box)
wireCollapsibleBlocks();  // secondary blocks (define-an-area) ship collapsed
wireModeSwitch();         // Explore / Site-sift mode switch
wirePbsaBox();            // PBSA sift (university rail access, box 3)
wirePortfolioBox();       // Portfolio scorer (priority-1 tool)

map.on("load", async () => {
  try {
    await loadData();
    buildLegend();          // now that breaks.json is loaded
    revealPriceGroup();     // House prices group shows once the tiles carry prices
    buildRailToggle();
    buildStationControls();
    updateShortlistTray();
    wireInteractions();
    // Cold-load race fix: on a fresh load (empty cache) the PMTiles header +
    // first tiles can still be in flight when the layers are added, so the map
    // can render blank until something triggers a repaint (which is why a
    // manual refresh "fixed" it — the tiles were then cached). We listen for
    // the lsoa vector source becoming loaded and force a repaint so overlays
    // appear without user intervention. Guarded so it only fires once.
    let _firstPaintDone = false;
    const ensureFirstPaint = () => {
      if (_firstPaintDone) return;
      let loaded = false;
      try { loaded = map.isSourceLoaded("lsoa"); } catch (_) { loaded = false; }
      if (!loaded) return;
      _firstPaintDone = true;
      map.off("sourcedata", onSourceData);
      map.off("idle", ensureFirstPaint);
      // Nudge a full re-evaluation of layers/filters now data is present.
      try { map.triggerRepaint(); } catch (_) {}
    };
    const onSourceData = (e) => {
      if (e.sourceId === "lsoa" && e.isSourceLoaded) ensureFirstPaint();
    };
    map.on("sourcedata", onSourceData);
    map.on("idle", ensureFirstPaint);
    // In case the source was already loaded synchronously (warm cache).
    ensureFirstPaint();
    // Intentionally NOT fitting to the national bbox — the map opens on London
    // (set in the map constructor: center [-0.11, 51.51], zoom 10.5). A city
    // view reads better and only loads the tiles in view, so it starts faster
    // than rendering the whole country. Users can zoom out to see all England.
  } catch (err) {
    document.getElementById("datasource").className = "datasource warn";
    document.getElementById("datasource").textContent =
      "Could not load data: " + err.message +
      " — run the pipeline or sample-data script first.";
    console.error(err);
  }
});

// Test/debug handle: module-scoped internals reachable from the console and
// the offline smoke harness. Read-only usage only — not a public API.
window.__mm = { MAP_OVERLAYS, LAYER_INFO, renderOverlay, hoverContentForOverlay,
                setOverlayOpacity, overlayDef, pf, pfPrintReport, _cellsToPoints,
                deep, renderDevelopableLayer, renderPublicLandLayer,
                renderDeepDiveLegend, renderPublicLandSummary,
                developablePlotFeatures, publicLandPopupHTML,
                selectDevelopablePlot, DEVELOPABLE_COLOR,
                DEVELOPABLE_INNER_COLOR, PUBLIC_LAND_COLOR,
                computeAppraisal, VIAB_SCHEMA, openViabilityModal, homesFor,
                setMarketPtype, SIFT };
