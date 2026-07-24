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

// Fill/outline colours: green for the developable land kept, muted red for the
// subtracted "blocker" constraints.
const DEVELOPABLE_COLOR = "#2f9e44";
const DEVELOPABLE_BLOCKER_COLOR = "#c0392b";

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
  // minPlotAc: drop developable plots below this many acres (0 = keep all).
  // largestOnly: keep only the single largest contiguous developable plot.
  return { radius_m: 800, inner_radius_m: 200, subtract, minPlotAc: 0, largestOnly: false };
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
    },
    layers: [{ id: "base", type: "raster", source: "carto" }],
  },
  center: [-0.11, 51.51],
  zoom: 10.5,
  // A tap on a phone rarely lands pixel-perfect; without a tolerance a tap that
  // wobbles a few px is treated as a drag and the click handler never fires.
  // 8px is comfortable for fingers without making real drags feel sticky.
  clickTolerance: 8,
});
window.map = map;   // dev: expose for console debugging

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

  const stationPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
  map.on("mouseenter", "station-dot", (e) => {
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = "pointer";
    const u = p.usage != null && p.usage !== "" ? `${fmtCount(Number(p.usage))} entries/exits` : "usage n/a";
    stationPopup.setLngLat(e.lngLat).setHTML(`<strong>${p.name || "Station"}</strong> · ${u}`).addTo(map);
  });
  map.on("mousemove", "station-dot", (e) => stationPopup.setLngLat(e.lngLat));
  map.on("mouseleave", "station-dot", () => {
    map.getCanvas().style.cursor = "";
    stationPopup.remove();
  });
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
      el.textContent += " Power network © OpenStreetMap contributors (ODbL).";
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
    { key: "market",   title: "Market & boundaries" },
  ]},
  { key: "energy", title: "Energy &amp; utilities", subs: [
    { key: "grid",        title: "Power grid" },
    { key: "sitefactors", title: "Site factors" },
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

  // ---- map_features datasets (generic ingestion framework; see ----
  // ---- pipeline/build_datasets.py + docs/DATA_LAYERS_ROADMAP.md) ----
  // Plans & policy areas (planning.data.gov.uk sweep)
  { key: "lpa_boundary",        group: "policy", label: "Planning authority boundaries", color: "#495057", dataset: "lpa_boundary",        render: "line",  minZoom: 5 },
  { key: "local_plan_boundary", group: "policy", label: "Local plan boundaries",         color: "#5f3dc4", dataset: "local_plan_boundary", render: "line",  minZoom: 6 },
  { key: "article4",            group: "policy", label: "Article 4 direction areas",     color: "#c2255c", dataset: "article4",            minZoom: 8 },
  { key: "tpo_zone",            group: "policy", label: "Tree preservation zones",       color: "#2b8a3e", dataset: "tpo_zone",            minZoom: 9 },
  { key: "design_code_area",    group: "policy", label: "Design code areas",             color: "#e8590c", dataset: "design_code_area",    minZoom: 8 },
  // Universities & students
  { key: "uni_campus", group: "students", label: "Universities & HE providers", color: "#7048e8", dataset: "uni_campus", render: "point", minZoom: 5 },
  { key: "ptal",       group: "students", label: "PTAL (London transport access)", color: "#f03e3e", dataset: "ptal", minZoom: 10 },
  // Market & boundaries
  { key: "la_rents",     group: "market", label: "Private rents (LA average)", color: "#0b7285", dataset: "la_rents",     minZoom: 5 },
  { key: "lad_boundary", group: "market", label: "Local authority boundaries", color: "#868e96", dataset: "lad_boundary", render: "line", minZoom: 5 },
  // Power grid
  // Power layers thin by VOLTAGE at wide zooms (via the RPC's numeric prop
  // filter) — a national view shows the 275/400 kV backbone, zooming in adds
  // 132 kV then everything — so the row cap almost never bites arbitrarily.
  { key: "power_line",       group: "grid", label: "Transmission & HV lines (OSM)", color: "#e8590c", dataset: "power_line",       render: "line",  minZoom: 5, lim: 8000,
    numFilter: z => z < 7 ? { key: "kv", min: 200 } : z < 9.5 ? { key: "kv", min: 90 } : null },
  { key: "power_substation", group: "grid", label: "Substations (OSM)",             color: "#d9480f", dataset: "power_substation", render: "point", minZoom: 6, lim: 8000,
    numFilter: z => z < 8 ? { key: "kv", min: 90 } : z < 10.5 ? { key: "kv", min: 20 } : null },
  { key: "gsp_boundary",     group: "grid", label: "Grid Supply Point boundaries",  color: "#845ef7", dataset: "gsp_boundary",     render: "line",  minZoom: 4 },
  { key: "tec_register",     group: "grid", label: "Connection queue (TEC register)", color: "#f59f00", dataset: "tec_register",   render: "point", minZoom: 5 },
  // Site factors
  { key: "alc",                group: "sitefactors", label: "Agricultural land grades (ALC)", color: "#94d82d", dataset: "alc",                minZoom: 7 },
  { key: "water_availability", group: "sitefactors", label: "Water resource availability",    color: "#22b8cf", dataset: "water_availability", minZoom: 6 },
];
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
  brownfield:         { about: "Previously developed sites councils have registered as suitable for redevelopment, with indicative dwelling capacity.", source: "Brownfield land registers, planning.data.gov.uk (OGL v3)" },
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
  uni_campus:          { about: "University and higher-education provider locations (one point per registered provider).", source: "UK Learning Providers / UKRLP (open data)" },
  ptal:                { about: "Public Transport Accessibility Level on a 100 m grid, graded 0–6b. Greater London only.", source: "TfL / London Datastore (OGL)" },
  la_rents:            { about: "Average monthly private rents by local authority, including per-bedroom breakdowns where published.", source: "ONS Price Index of Private Rents (OGL v3)" },
  lad_boundary:        { about: "Local authority district boundaries.", source: "ONS Open Geography Portal (OGL v3)" },
  power_line:          { about: "High-voltage lines, weight-scaled by voltage. Wide zooms show the 275/400 kV backbone; zoom in for 132 kV and below. Click a line for its details.", source: "© OpenStreetMap contributors (ODbL)" },
  power_substation:    { about: "Grid and primary substations — where new large connections plug in. Wide zooms show transmission-scale sites; zoom in for the rest. Click one for its details.", source: "© OpenStreetMap contributors (ODbL)" },
  gsp_boundary:        { about: "Grid Supply Point boundaries — where the national transmission grid hands over to regional distribution networks.", source: "NESO Data Portal (open licence)" },
  tec_register:        { about: "The transmission connection queue: projects holding capacity agreements, with MW and status. Shows where the grid is contested.", source: "NESO TEC Register (open licence)" },
  alc:                 { about: "Agricultural Land Classification grades 1–5. Grades 1–3a are 'best and most versatile' — policy steers development away.", source: "Natural England (OGL v3)" },
  water_availability:  { about: "Whether water is available for new abstraction licences, by catchment — a proxy for large-scale water supply feasibility.", source: "Environment Agency CAMS (OGL v3)" },
};

const OVERLAY_MIN_ZOOM = 7;           // default floor; per-layer minZoom overrides
const OVERLAY_DEFAULT_OPACITY = 0.32; // fill opacity a fresh overlay starts at
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
    map.setPaintProperty(`ov-${key}-fill`, "fill-opacity", v);
  if (map.getLayer(`ov-${key}-line`)) {
    const lineAlpha = def && def.render === "line" ? Math.min(1, v * 2.5) : Math.min(0.9, v * 2.2);
    map.setPaintProperty(`ov-${key}-line`, "line-opacity", lineAlpha);
  }
  if (map.getLayer(`ov-${key}-pt`)) {
    map.setPaintProperty(`ov-${key}-pt`, "circle-opacity", Math.min(1, v * 2.5));
    map.setPaintProperty(`ov-${key}-pt`, "circle-stroke-opacity", Math.min(1, v * 2.5));
  }
}

function refreshMapOverlays() {
  MAP_OVERLAYS.forEach(o => { if (overlayState[o.key] && overlayState[o.key].on) fetchMapOverlay(o.key); });
}

async function fetchMapOverlay(key) {
  const def = overlayDef(key);
  const stat = document.getElementById(`ov-stat-${key}`);
  if (!def || typeof map === "undefined") return;
  const st = overlayState[key] || (overlayState[key] = { opacity: OVERLAY_DEFAULT_OPACITY });
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
  const nfMin = nf ? nf.min : null;
  const c = st.fetched;
  if (c && vw >= c.w && vs >= c.s && ve <= c.e && vn <= c.n && zsnap <= c.z + 1.5
      && (c.nfMin ?? null) === nfMin) return;
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
      : def.dataset
      ? await sb.rpc("features_in_bbox", { p_dataset: def.dataset, w, s, e, n, p_zoom,
          lim: def.lim || 4000,
          p_num_key: nf ? nf.key : null, p_num_min: nfMin })
      : await sb.rpc("constraints_in_bbox", { p_kinds: def.kinds, w, s, e, n, p_zoom });
    if (error) throw error;
    const fc = data || { type: "FeatureCollection", features: [] };
    if (!Array.isArray(fc.features)) fc.features = [];
    st.fetched = { w, s, e, n, z: zsnap, nfMin };
    renderOverlay(key, def, fc);
    // A count AT the row cap almost certainly means truncation — say so.
    const cap = def.lim || (def.dataset ? 4000 : def.ownership ? 3000 : 1500);
    if (stat) stat.textContent = fc.features.length >= cap
      ? `${fc.features.length.toLocaleString()}+` : `${fc.features.length.toLocaleString()}`;
  } catch (err) {
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

function renderOverlay(key, def, fc) {
  const srcId = `ov-${key}-src`, fillId = `ov-${key}-fill`, lineId = `ov-${key}-line`,
        ptId = `ov-${key}-pt`;
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
    map.addLayer({ id: ptId, type: "circle", source: srcId,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 4.5, 14, 7],
        "circle-color": def.color,
        "circle-opacity": Math.min(1, opacity * 2.5),
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
        "circle-stroke-opacity": Math.min(1, opacity * 2.5),
      } }, before);
    wireOverlayTooltip(key, ptId);
  } else if (def.render === "line") {
    // Line dataset (power lines, boundaries): no fill. Power lines scale
    // width by voltage (props.kv) so 400 kV reads heavier than 33 kV.
    const width = def.dataset === "power_line"
      ? ["interpolate", ["linear"], ["coalesce", ["get", "kv"], 100],
         33, 0.8, 132, 1.4, 275, 2.2, 400, 3]
      : ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.4, 14, 2.2];
    map.addLayer({ id: lineId, type: "line", source: srcId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": def.color, "line-width": width,
               "line-opacity": Math.min(1, opacity * 2.5) } }, before);
    if (def.dataset === "power_line") wireOverlayTooltip(key, lineId);
  } else {
    map.addLayer({ id: fillId, type: "fill", source: srcId,
      paint: { "fill-color": def.color, "fill-opacity": opacity } }, before);
    map.addLayer({ id: lineId, type: "line", source: srcId,
      paint: { "line-color": def.color, "line-width": 1,
               "line-opacity": Math.min(0.9, opacity * 2.2) } }, before);
  }
  updateOverlayAttribution();
}

// Hover tooltip for dataset point/line overlays (name + the interesting props).
// Desktop-only nicety — tap-to-inspect stays with the central dispatcher.
function wireOverlayTooltip(key, layerId) {
  const tipProps = {
    uni_campus: p => [p.name, p.groups].filter(Boolean).join(" · "),
    power_substation: p => [p.name || "Substation", p.kv ? `${p.kv} kV` : (p.voltage || "")].filter(Boolean).join(" · "),
    power_line: p => ["Power line", p.kv ? `${p.kv} kV` : (p.voltage || ""), p.operator].filter(Boolean).join(" · "),
    tec_register: p => [p.name || p.site, p.mw ? `${p.mw} MW` : "", p.status].filter(Boolean).join(" · "),
  };
  const fmt = tipProps[key] || (p => p.name || key);
  const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  map.on("mouseenter", layerId, (e) => {
    map.getCanvas().style.cursor = "pointer";
    pop.setLngLat(e.lngLat).setHTML(`<strong>${fmt(e.features[0].properties)}</strong>`).addTo(map);
  });
  map.on("mousemove", layerId, (e) => pop.setLngLat(e.lngLat));
  map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; pop.remove(); });
  // Click pins a card with EVERY attribute the feature carries (voltage,
  // operator, substation class, queued MW, ...). Same pattern as brownfield.
  map.on("click", layerId, (e) => {
    const p = e.features[0].properties || {};
    const skip = new Set(["dataset"]);
    const rows = Object.entries(p)
      .filter(([k, v]) => !skip.has(k) && v != null && v !== "" && v !== "null")
      .map(([k, v]) => `<tr><td class="ovp-k">${k}</td><td class="ovp-v">${v}</td></tr>`)
      .join("");
    pop.remove();
    openClickPopup({ closeButton: true, maxWidth: "320px", offset: 10 }, e.lngLat,
      `<div class="ovp"><div class="ovp-title">${p.name || overlayDef(key)?.label || key}</div>` +
      `<table class="ovp-table">${rows}</table></div>`);
  });
}

// ODbL requires visible attribution while OSM-derived power layers are shown.
function updateOverlayAttribution() {
  const powerOn = ["power_line", "power_substation"]
    .some(k => overlayState[k] && overlayState[k].on);
  if (powerOn !== _osmPowerAttributionShown) {
    _osmPowerAttributionShown = powerOn;
    updateDataSourceNote();
  }
}
let _osmPowerAttributionShown = false;

function removeOverlayLayers(key) {
  for (const id of [`ov-${key}-fill`, `ov-${key}-line`, `ov-${key}-pt`])
    if (map.getLayer(id)) map.removeLayer(id);
  const srcId = `ov-${key}-src`;
  if (map.getSource(srcId)) map.removeSource(srcId);
  updateOverlayAttribution();
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
      // Green Belt (a national static file, not a bbox overlay) leads Planning.
      if (g.key === "planning") {
        rows += ltRowHTML({ rowId: "greenbelt-row", cbId: "greenbelt-show", hidden: true,
                            label: "Green Belt", color: GREENBELT_COLOR, statId: "greenbelt-count",
                            checked: false, opacity: state.greenbeltOpacity, opacityKey: "greenbelt",
                            info: { about: "Green Belt land, where national policy restrains most new development. Shown nationwide from a static extract.",
                                    source: "MHCLG via planning.data.gov.uk (OGL v3)" } });
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

  // 4. Developable land / blockers — large area polygons, lowest priority so
  // amenity / brownfield / crime taps win over them.
  for (const id of ["developable-blockers", "developable-fill"]) {
    const hits = q(id);
    if (hits) {
      const ll = map.unproject([point.x, point.y]);
      openClickPopup({ offset: 8 }, ll, developablePopupHTML(id));
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

    // 3. LSOA zone — unless a deep dive is open (you're working inside one).
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

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "lsoa-fill", (e) => {
    const f = e.features[0];
    const p = f.properties;
    map.getCanvas().style.cursor = "pointer";
    // Show the deprivation score, plus the price when the price layer is on
    // (both layers can be visible at once now).
    let detail = "combined " + combinedScore(p, state.weights).toFixed(0);
    if (state.priceOn) {
      detail += p.price_ppm2 != null ? ` · ${ppm2Fmt(p.price_ppm2)}`
        : (p.price_median != null ? ` · ${priceFmt(p.price_median)} median` : "");
    }
    popup.setLngLat(e.lngLat)
      .setHTML(`${p.lsoa_code} · ${detail} · click to inspect`)
      .addTo(map);
  });
  map.on("mouseleave", "lsoa-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });

  // (LSOA zone clicks are handled by the unified handleMapTap dispatcher above.)

  map.on("draw.create", onDrawChange);
  map.on("draw.update", onDrawChange);
  map.on("draw.delete", () => {
    lastDrawnPolygon = null;
    document.getElementById("report").innerHTML =
      `<p class="empty">No site selected yet.</p>`;
  });

  // Rail stops: hover shows a quick tooltip; click pins a full info panel.
  // Bound only when the rail layer exists. Stops sit above the choropleth, so
  // they take priority when the cursor is over a dot.
  if (state.hasRail) {
    const stopPopup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 10,
    });
    map.on("mouseenter", "rail-stop", (e) => {
      const p = e.features[0].properties;
      map.getCanvas().style.cursor = "pointer";
      stopPopup.setLngLat(e.lngLat)
        .setHTML(`<strong>${p.name || "Stop"}</strong> · ${railMode(p.mode)?.label || p.mode}`)
        .addTo(map);
    });
    map.on("mousemove", "rail-stop", (e) => stopPopup.setLngLat(e.lngLat));
    map.on("mouseleave", "rail-stop", () => {
      map.getCanvas().style.cursor = "";
      stopPopup.remove();
    });
    // (Rail-stop clicks are handled by the unified handleMapTap dispatcher.)
  }
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
  const need = combinedScoreFromDomains(deep.domains, state.weights);

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
  deep.ppm2 = res.ppm2;
  deep.medianPrice = res.medianPrice;
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
        || id.startsWith("brownfield-") || id.startsWith("developable-")) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  }
  for (const id of sourceIds) {
    if (id.startsWith("amenity-") || id.startsWith("access-route-")
        || id.startsWith("brownfield-") || id.startsWith("developable-")) {
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
    rural: Math.round(dev * dph.rural),
    suburban: Math.round(dev * dph.suburban),
    urban: Math.round(outer * dph.urbanOuter + inner * dph.urbanInner),
  };
}

// Render the developable overlay: muted-red blocker fill underneath, green
// developable fill + outline on top. Clicks are handled by the shared
// handleMapTap dispatcher (see tapDeepDiveLayers); here we only set the hover
// cursor and flag the footer attribution.
function renderDevelopableLayer() {
  removeDevelopableLayer();
  const r = deep.developableResult;
  if (!r) return;

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
    map.addSource("developable-src", {
      type: "geojson",
      data: { type: "Feature", geometry: r.developable_geojson, properties: {} },
    });
    map.addLayer({
      id: "developable-fill", type: "fill", source: "developable-src",
      paint: { "fill-color": DEVELOPABLE_COLOR, "fill-opacity": 0.42 },
    });
    map.addLayer({
      id: "developable-line", type: "line", source: "developable-src",
      paint: { "line-color": DEVELOPABLE_COLOR, "line-width": 1.8 },
    });
  }

  for (const id of ["developable-fill", "developable-blockers"]) {
    if (map.getLayer(id)) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }
  updateDevelopableAttribution(true);
}

function removeDevelopableLayer() {
  for (const id of ["developable-fill", "developable-line", "developable-blockers"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ["developable-src", "developable-blockers-src"]) {
    if (map.getSource(id)) map.removeSource(id);
  }
  updateDevelopableAttribution(false);
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
      .select("catchment_imd, catchment_pop, catchment_income, catchment_health, catchment_education, regen_score")
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
    // Re-render the Need headline / breakdown now the DB fallback is available.
    renderDeprivationScore();
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

function areaWeightedScore(catchment) {
  if (!window.turf) return { domains: null, parts: 0 };
  const feats = catchmentZoneFeatures();
  if (!feats.length) return { domains: null, parts: 0 };

  const seen = new Set();
  let totalArea = 0;
  const contribs = [];   // { a, props }
  for (const f of feats) {
    const code = zoneId(f.properties);
    if (!code || seen.has(code)) continue;
    seen.add(code);
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
  for (const f of feats) {
    const props = f.properties || {};
    const code = zoneId(props);
    if (!code || seen.has(code)) continue;
    seen.add(code);

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
async function fetchIsochrone(lng, lat, mode, minutes) {
  // Circle method selected (the default): skip the network entirely and return
  // an instant straight-line catchment. Tagged _circle so the UI can label it.
  if (state.catchmentMethod === "circle") {
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

const VIABILITY_DEFAULTS = {
  unitSizeFt2: 750,    // average saleable area per dwelling
  salesPsf: 350,       // FALLBACK base £/ft² (× regional multiplier) where no local price
  salesAdjPct: 100,    // adjustment applied to the LOCAL catchment £/ft² (new-build premium/discount)
  buildPsf: 200,       // £/ft² build cost
  softCostPct: 30,     // fees + finance + contingency, as % of build cost
  affordablePct: 25,   // % affordable homes
  affordableValue: 55, // affordable unit value as % of market
  blvPerUnit: 20,      // benchmark land value, £000s per unit
  profitTargetPct: 17.5, // target profit on cost (viability threshold)
  gbTierBBonus: 10,    // deliverability bonus for a permitted Tier-B Green Belt site
};

const SIFT = {
  loaded: false,
  rows: [],
  step: 0,             // current wizard step (index into SIFT_STEPS)
  crit: { requireFrequency: true, requireWellConnected: false, exemptInSettlement: true,
          tierA: true, tierB: true, ineligible: false, minDevHa: 0, minYield: 0,
          maxProtectedPct: 100, deprivedTopPct: 100, minProfitOnCost: -30 },
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
  Object.assign(SIFT.assumptions, saved.assumptions || {});
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

// Residual appraisal → profit on cost (%). Transparent: GDV − (build + softs +
// land); profit-on-cost is the headline viability metric.
const FT2_PER_M2 = 10.7639;
function computeViability(row) {
  const a = SIFT.assumptions;
  const units = row.yield || 0;
  if (units <= 0) return { profitOnCost: null, rag: "n/a", score: 0, price: null, local: false };
  const area = units * a.unitSizeFt2;
  // Sales value: prefer the LOCAL catchment £/ft² (from Land Registry £/m² within
  // 800 m) × an adjustment; fall back to the base £/ft² × regional multiplier where
  // no local price is loaded yet.
  const localPsf = row.catchmentPpm2 ? row.catchmentPpm2 / FT2_PER_M2 : null;
  const price = localPsf != null
    ? localPsf * ((a.salesAdjPct || 100) / 100)
    : a.salesPsf * regionPriceMult(row.region);
  const affFrac = (a.affordablePct || 0) / 100;
  const blend = (1 - affFrac) + affFrac * ((a.affordableValue || 0) / 100);
  const gdv = area * price * blend;
  const build = area * a.buildPsf;
  const softs = build * ((a.softCostPct || 0) / 100);
  const land = units * (a.blvPerUnit || 0) * 1000;
  const cost = build + softs + land;
  if (cost <= 0) return { profitOnCost: null, rag: "n/a", score: 0, price: null, local: false };
  const poc = ((gdv - cost) / cost) * 100;
  const target = a.profitTargetPct || 17.5;
  const rag = poc >= target ? "viable" : poc >= target * 0.5 ? "marginal" : "unviable";
  // 0–100 score: target maps to ~60, 2× target to 100, break-even to ~25.
  const score = Math.max(0, Math.min(100, 25 + (poc / (2 * target)) * 55));
  return { profitOnCost: poc, rag, score, price: Math.round(price), local: localPsf != null };
}

// Attach the computed viability appraisal to every row (called before filter/sort).
// Deliverability & a 3-axis composite were removed per review — the funnel now ends
// on viability; they will return when deliverability is rebuilt.
function scoreSiftRows() {
  for (const r of SIFT.rows) {
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
}

async function loadSiftData() {
  const sb = (typeof getSupabase === "function") ? getSupabase() : null;
  if (!sb) { SIFT.rows = []; SIFT.loaded = false; return; }
  try {
    // PostgREST caps a response at ~1000 rows, so page through in ranges until a
    // short page — otherwise the sift silently sees only the top 1000 stations.
    const PAGE = 1000;
    let data = [], from = 0;
    for (;;) {
      const { data: page, error } = await sb
        .from("station_assessments")
        .select("crs, country, tier, in_settlement, density_floor, developable_ha, dwelling_yield, constraint_friction, green_belt_ha, soft_cover, benefit_score, regen_score, access_score, housing_score, catchment_imd, catchment_pop, catchment_ppm2, catchment_median_price, stations(name, region, ttwa_name, well_connected, meets_frequency, connectivity_pctile, direct_destinations)")
        .order("dwelling_yield", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      data = data.concat(page || []);
      if (!page || page.length < PAGE) break;
      from += PAGE;
    }
    SIFT.rows = (data || []).map(r => ({
      crs: r.crs, country: r.country || "england", tier: r.tier, inSettlement: !!r.in_settlement, densityFloor: r.density_floor,
      developableHa: Number(r.developable_ha) || 0, yield: r.dwelling_yield || 0,
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
  { key: "connectivity", title: "1 · Connectivity gate",
    about: {
      what: "The first filter. Only stations with a genuine turn-up-and-go service pass — unless the station sits inside a settlement, which the draft NPPF treats as a 'default yes' regardless of frequency.",
      source: "Draft NPPF (2024 consultation), development around well-connected stations. The service test used is 'at least 4 services per hour overall, or 2 per hour in each direction' through the daytime; 'well-connected' additionally requires the station's Travel-to-Work Area to be economically significant.",
      calc: "meets_frequency = sustained trains/trams ≥ 4 per hour (or ≥ 2 per hour per direction), from the GB rail timetable. well_connected = meets_frequency AND the station's TTWA is in the top 60 by GVA (ONS). With the in-settlement exemption on, these tests apply only to out-of-settlement stations." },
    // NPPF gives in-settlement stations a "default yes" regardless of service
    // frequency; exemptInSettlement (default on) mirrors that, so the frequency /
    // well-connected requirements apply only to out-of-settlement stations. Turn
    // it off to apply connectivity to every station (stricter than the NPPF).
    pred: (r, c) => {
      const exempt = c.exemptInSettlement && r.inSettlement;
      if (exempt) return true;
      if (c.requireFrequency && !r.meetsFrequency) return false;
      if (c.requireWellConnected && !r.wellConnected) return false;
      return true;
    } },
  { key: "eligibility", title: "2 · Eligibility & tier",
    about: {
      what: "Assigns each station an NPPF tier and a density floor. Tier A = inside a settlement; Tier B = well-connected but outside a settlement (where the draft NPPF now permits Green Belt release); otherwise ineligible.",
      source: "Draft NPPF two-tier approach to station-adjacent development. Density floors: 40 dwellings/hectare as a baseline minimum, 50 dph in the most accessible / well-connected locations.",
      calc: "‘In settlement’ is deliberately NOT a point-in-polygon test — a station often sits in the railway gap of a built-up-area polygon, which wrongly flagged dense urban stations (e.g. South Bermondsey) as out-of-settlement. Instead we measure the BUILT-UP FRACTION of the 800 m catchment: the share of the 800 m circle covered by OS Open Built-Up Areas. A station is in-settlement when that fraction ≥ 40%, OR ≥ 20% with a built-up area within 100 m. Tier A = in-settlement; Tier B = out-of-settlement AND well-connected; else ineligible. Density floor = 50 dph if well-connected, else 40 dph." },
    pred: (r, c) => (r.tier === "A" && c.tierA) || (r.tier === "B" && c.tierB) ||
                    (r.tier === "ineligible" && c.ineligible) },
  { key: "developable", title: "3 · Developable land",
    about: {
      what: "The net land physically available for homes within an ~800 m (10-minute) walk of the station, and the dwelling capacity that implies.",
      source: "NPPF 'reasonable walking distance' of a station; the net-developable-area method (start from the catchment, erase undevelopable land) is standard practice in Housing & Economic Land Availability Assessments (HELAA).",
      calc: "800 m circular catchment MINUS (PostGIS ST_Difference) built-up land, green space, transport corridors (roads + railway curtilage), flood zone 3 and hard environmental designations. dwelling_yield = net developable hectares × the density floor from step 2." },
    pred: (r, c) => r.developableHa >= c.minDevHa && r.yield >= c.minYield },
  { key: "protected", title: "4 · Protected land %",
    about: {
      what: "Of the land left after hard exclusions, how much sits under a SOFT heritage or landscape designation — one that doesn't stop development outright but adds planning friction, delay and cost.",
      source: "NPPF Chapter 16 (heritage — conservation areas, listed-building settings) and Chapter 15 (National Landscapes / AONB, valued landscapes), plus locally registered parks & gardens. These are 'material considerations' weighed in the planning balance, not absolute constraints — unlike SSSIs, SACs, SPAs, Ramsar, ancient woodland and scheduled monuments, which are hard exclusions already removed in step 3.",
      calc: "Protected land % = the share of the net developable polygon (from step 3) that intersects soft designations — conservation areas, AONB / National Landscapes, registered parks & gardens and listed-building setting buffers — measured by area. The slider caps how much of a site may be so designated." },
    pred: (r, c) => r.friction == null || r.friction * 100 <= c.maxProtectedPct },
  { key: "regen", title: "5 · Regeneration need",
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
  { key: "viability", title: "6 · Viability",
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
    yield: r => r.yield || 0,
    regen: r => r.regen || 0,
    viability: r => r._viab.profitOnCost == null ? -1e9 : r._viab.profitOnCost,
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
      return `<p class="hint">The first gate keeps only stations meeting the NPPF service-frequency test (4 trains/trams per hour overall, or 2 per hour per direction, through the daytime). Optionally require the full 'well-connected' definition (also within a top-60 Travel-to-Work Area by GVA).</p>` +
        `<label class="dd-row"><input type="checkbox" id="sc-freq"${chk(C.requireFrequency)}> <span>Require NPPF service frequency</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sc-wc"${chk(C.requireWellConnected)}> <span>Require 'well-connected' (frequency + top-60 TTWA)</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sc-exempt"${chk(C.exemptInSettlement)}> <span>Exempt in-settlement stations (mirror NPPF 'default yes')</span></label>` +
        `<p class="hint" style="margin-top:4px">With the exemption on, the tests above apply only to out-of-settlement stations. Turn it off to gate every station on connectivity (stricter than the NPPF).</p>`;
    case "eligibility":
      return `<p class="hint">Two-tier NPPF test. 'In settlement' = the 800 m catchment is ≥40% built-up (OS Open Built-Up Areas), or ≥20% with built-up land within 100 m — a robust rule that no longer mislabels dense urban stations. Density floor by connectivity: <strong>50 dph</strong> well-connected, else <strong>40 dph</strong>.</p>` +
        `<label class="dd-row"><input type="checkbox" id="sift-tierA"${chk(C.tierA)}> <span>Tier A · in-settlement</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sift-tierB"${chk(C.tierB)}> <span>Tier B · well-connected, out-of-settlement (Green Belt permitted)</span></label>` +
        `<label class="dd-row"><input type="checkbox" id="sift-inelig"${chk(C.ineligible)}> <span>Include ineligible</span></label>`;
    case "developable":
      return `<p class="hint">Net developable area within 800 m after erasing built-up land, green space, transport (roads + railway curtilage), flood zone 3 and hard environmental designations.</p>` +
        siftNumField("sift-minha", "Min developable ha", C.minDevHa || 0, 1) +
        siftNumField("sift-minyield", "Min dwelling yield", C.minYield || 0, 50);
    case "protected":
      return `<p class="hint">Hard designations (SSSI, SAC, SPA, Ramsar, ancient woodland, scheduled monuments) are already erased in step 3. This caps how much of the remaining developable land sits under a <strong>soft</strong> designation — conservation areas, AONB / National Landscapes, registered parks &amp; gardens and listed-building settings — which don't block development but add planning friction.</p>` +
        `<label class="sift-field"><span>Max protected land <b id="sift-prot-val">${Math.round(C.maxProtectedPct)}%</b></span><input type="range" id="sift-maxprot" min="0" max="100" step="5" value="${C.maxProtectedPct}"></label>`;
    case "regen":
      return `<p class="hint">Target the most deprived catchments. Each station's catchment deprivation is a national percentile of the population-weighted IMD (2019) of its LSOAs — <strong>100 = most deprived</strong>. Keep only stations in the top X% most deprived.</p>` +
        `<label class="sift-field"><span>Show top <b id="sift-depriv-val">${Math.round(C.deprivedTopPct)}%</b> most deprived</span><input type="range" id="sift-depriv" min="5" max="100" step="5" value="${C.deprivedTopPct}"></label>` +
        `<p class="hint" style="margin-top:4px">100% keeps every station; 10% keeps only catchments in the most-deprived national decile.</p>`;
    case "viability":
      return `<p class="hint"><strong>Viability</strong> runs a residual appraisal per scheme: <em>Gross Development Value − (build + soft costs + land)</em> = <strong>profit on cost %</strong>. GDV uses each station's <strong>local sales value</strong> — the catchment-weighted £/m² from HM Land Registry (Price Paid × EPC floor area) over the LSOAs within 800 m, converted to £/ft² — so value reflects the actual neighbourhood, not a broad region. Where local price data isn't loaded yet it falls back to the base £/ft² below.</p>` +
        siftNumField("v-salesadj", "Local price adjustment %", A.salesAdjPct, 5,
          "Applied to the local market £/ft² from Land Registry data. 100% = the neighbourhood market rate; raise it for a prime new-build premium, lower it for a discount.") +
        siftNumField("v-sales", "Fallback sales £/ft²", A.salesPsf, 10,
          "Used only for stations where local Land Registry £/m² hasn't loaded. Multiplied by a regional factor (London ~1.9× … North East ~0.8×).") +
        siftNumField("v-build", "Build £/ft²", A.buildPsf, 10,
          "All-in construction cost per square foot (BCIS-style). Higher build cost lowers profit on cost.") +
        siftNumField("v-unit", "Avg unit ft²", A.unitSizeFt2, 25,
          "Average saleable floor area per dwelling. Converts the dwelling count into saleable area for GDV and into build cost.") +
        siftNumField("v-soft", "Soft costs %", A.softCostPct, 1,
          "Professional fees, finance, contingency and marketing, as a % of build cost (typically 25–35%).") +
        siftNumField("v-aff", "Affordable %", A.affordablePct, 5,
          "Share of homes delivered as affordable. Affordable units are valued at ~55% of market value, so a higher % reduces GDV.") +
        siftNumField("v-blv", "Land £000/unit", A.blvPerUnit, 5,
          "Benchmark land value / existing-use value paid to the landowner, in £000s per dwelling. A cost in the appraisal.") +
        siftNumField("v-target", "Profit target %", A.profitTargetPct, 0.5,
          "Your required profit on cost. Schemes at/above this are 'viable' (green), down to half of it 'marginal' (amber), below that 'unviable' (red) in the results table.") +
        siftNumField("v-minpoc", "Min profit on cost %", C.minProfitOnCost, 1,
          "FILTER: only keep stations whose scheme achieves at least this profit on cost. Set it to your profit target to keep only viable schemes, or leave low (e.g. -30) to keep everything and just rank by viability.") +
        `<label class="sift-field"><span>Rank shortlist by</span><select id="sift-sort">` +
        ["viability:Viability (profit on cost)", "regen:Regeneration need", "yield:Dwelling yield"]
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
  if (g("sc-freq")) C.requireFrequency = g("sc-freq").checked;
  if (g("sc-wc")) C.requireWellConnected = g("sc-wc").checked;
  if (g("sc-exempt")) C.exemptInSettlement = g("sc-exempt").checked;
  if (g("sift-tierA")) C.tierA = g("sift-tierA").checked;
  if (g("sift-tierB")) C.tierB = g("sift-tierB").checked;
  if (g("sift-inelig")) C.ineligible = g("sift-inelig").checked;
  if (g("sift-minha")) C.minDevHa = numv("sift-minha", 0);
  if (g("sift-minyield")) C.minYield = numv("sift-minyield", 0);
  if (g("sift-maxprot")) C.maxProtectedPct = numv("sift-maxprot", 100);
  if (g("sift-depriv")) C.deprivedTopPct = numv("sift-depriv", 100);
  if (g("v-minpoc")) C.minProfitOnCost = numv("v-minpoc", -30);
  [["v-sales", "salesPsf"], ["v-salesadj", "salesAdjPct"], ["v-build", "buildPsf"],
   ["v-unit", "unitSizeFt2"], ["v-soft", "softCostPct"], ["v-aff", "affordablePct"],
   ["v-blv", "blvPerUnit"], ["v-target", "profitTargetPct"]].forEach(([id, key]) => {
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
    "dwelling_yield", "protected_land_pct", "green_belt_ha", "regeneration_need_pctile",
    "viability_profit_on_cost_pct", "viability_rag"];
  const esc = v => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  rows.forEach((r, i) => {
    lines.push([i + 1, r.crs, r.name, r.region, r.tier, r.densityFloor ?? "", r.developableHa,
      r.yield, r.friction == null ? "" : Math.round(r.friction * 100), r.greenBeltHa,
      r.regen == null ? "" : Math.round(r.regen),
      r._viab.profitOnCost == null ? "" : r._viab.profitOnCost.toFixed(1),
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
  const totalYield = surv.reduce((s, r) => s + (r.yield || 0), 0);
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
  const SORT_LABELS = { yield: "dwelling yield", regen: "regeneration need", viability: "viability" };
  const sortLabel = SORT_LABELS[SIFT.sort] || "viability";
  const top = surv.slice(0, 100);
  const vcell = (r) => {
    const v = r._viab;
    if (v.profitOnCost == null) return `<td>—</td>`;
    const priceNote = v.price == null ? "" :
      ` · sales £${v.price}/ft² (${v.local ? "local Land Registry £/m²" : "regional fallback"})`;
    return `<td><span class="sift-rag sift-rag-${v.rag}" title="profit on cost; viability score ${Math.round(v.score)}${priceNote}">${v.profitOnCost.toFixed(0)}%</span></td>`;
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
      `<td title="${r.developableHa.toFixed(1)} developable ha · ${r.densityFloor || "?"} dph">${(r.yield || 0).toLocaleString()}</td>` +
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
}

buildLayersPanel();       // the grouped Data layers tree (box 1) — must run
                          // first: buildSliders/wireImdToggle bind to elements
                          // the tree renders (#sliders, #imd-show, …).
buildSliders();
buildLegend();
wireImdToggle();          // IMD choropleth is a context layer, OFF by default
wireSideBoxes();          // minimiseable left boxes (persisted per box)
wireCollapsibleBlocks();  // secondary blocks (define-an-area) ship collapsed
wireModeSwitch();         // Explore / Site-sift mode switch

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
