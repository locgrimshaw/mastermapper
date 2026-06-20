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
  layer: "deprivation",  // "deprivation" | "price"
  hasPrice: false,       // whether the loaded data includes price fields
  colourMode: "single",  // "single" | "spectrum"
  fillOpacity: 0.85,     // choropleth opacity (slider fades to basemap)
  theme: "light",        // "dark" | "light"
  hasRail: false,        // whether the tiles include the rail overlay
  // Per-mode visibility for rail lines and stops. Defaults on for any mode
  // present in the data (set during loadData from breaks.json counts).
  railLineModes: {},     // e.g. { rail:true, subway:true, ... }
  railStopModes: {},
};

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

// ---- Map ------------------------------------------------------------------

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
  clickTolerance: 5,
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
      if (typeof second === "function" && arguments.length > 2) {
        return orig.call(this, type, second);   // strip the options object
      }
      return orig.apply(this, arguments);
    };
  }
})(map);

const draw = new MapboxDraw({
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
});
map.addControl(draw, "top-right");
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ---- Data load ------------------------------------------------------------

const SOURCE_LAYER = "lsoa";   // must match the tippecanoe -l layer name

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
    const br = await fetch("data/breaks.json", { cache: "no-store" });
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

  // Append the per-build stamp so a rebuilt lsoa.pmtiles (same filename) is
  // fetched fresh rather than served from a stale browser/CDN cache. PMTiles
  // uses HTTP range requests; the query string makes each build a new URL.
  const buildId = state.breaksData?.meta?.build_id || "";
  const tilesPath = "data/lsoa.pmtiles" + (buildId ? `?v=${buildId}` : "");
  const tilesUrl = "pmtiles://" + new URL(tilesPath, location.href).href;

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
      "fill-opacity": state.fillOpacity,
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
    paint: {
      "line-color": LINE_COLOR(),
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.4, 14, 0.7, 17, 1.2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.5, 14, 0.8, 17, 0.9],
    },
  });

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
          "line-opacity": 0.95,
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

  updateDataSourceNote();
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
  }
}

// ---- Choropleth restyle on weight change ----------------------------------

// Apply the current fill-colour expression to BOTH the fill and its gap-
// bridging outline, so they never diverge (the outline closes hairline gaps
// only if it matches the fill exactly).
function applyFillColor() {
  const expr = fillColorExpression();
  map.setPaintProperty("lsoa-fill", "fill-color", expr);
  map.setPaintProperty("lsoa-fill", "fill-outline-color", expr);
}

function restyle() {
  applyFillColor();
  buildLegend();
  if (state.selectedCode) inspectLSOA(state.selectedCode);
}

// Switch the choropleth between deprivation and house prices.
function setLayer(mode) {
  state.layer = mode;
  if (mode === "price") setSolo(null);   // solo is a deprivation-only view
  applyFillColor();
  buildLegend();
  buildLayerToggle();
  if (state.selectedCode) inspectLSOA(state.selectedCode);
  if (lastDrawnPolygon) buildReport(lastDrawnPolygon);
}

function buildLayerToggle() {
  const el = document.getElementById("layer-toggle");
  if (!el) return;
  if (!state.hasPrice) { el.innerHTML = ""; return; }
  const opt = (mode, label) =>
    `<button class="seg ${state.layer === mode ? "on" : ""}" data-mode="${mode}">${label}</button>`;
  el.innerHTML = opt("deprivation", "Deprivation") + opt("price", "House prices");
  el.querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => setLayer(b.dataset.mode)));
}

// Rail overlay toggle. One group per mode that has data; within each, a Lines
// and/or Stops checkbox. Each row carries the mode's colour swatch so the map
// colours are self-explanatory. Only shown when the tiles carry rail data.
function buildRailToggle() {
  const block = document.getElementById("rail-block");
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
          <button class="solo" id="solo-${d.key}" type="button"
                  aria-label="Show only ${d.name} on the map" title="Show only this on the map">solo</button>
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
    });

    // Solo: show just this domain's choropleth (toggle).
    row.querySelector(`#solo-${d.key}`).addEventListener("click", () => {
      setSolo(state.solo === d.key ? null : d.key);
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
  });

  syncSliderUI();   // set the total readout on first build
}

// Switch the map to a single domain's choropleth, or back to combined (null).
function setSolo(key) {
  state.solo = key;
  for (const d of DOMAINS) {
    document.getElementById(`solo-${d.key}`)
      .classList.toggle("on", state.solo === d.key);
  }
  // Solo only applies to the deprivation layer; force it if on prices.
  if (key && state.layer === "price") state.layer = "deprivation";
  applyFillColor();
  buildLegend();
  buildLayerToggle();
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
    if (area > 0) overlaps.push({ props: f.properties, area });
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

  // House-price summary across the plot: weight each area's median by its
  // sale count (more sales = more reliable), so one thin LSOA with a single
  // freak sale doesn't dominate.
  let priceLine = "";
  if (state.hasPrice) {
    let wsum = 0, psum = 0, sales = 0;
    for (const o of overlaps) {
      const m = o.props.price_median, c = o.props.price_count || 0;
      if (m != null && c > 0) { psum += m * c; wsum += c; sales += c; }
    }
    priceLine = wsum > 0
      ? `<div class="price-line"><span>Median sale price</span>
           <strong>${priceFmt(psum / wsum)}</strong>
           <span class="dim">${sales} sales · 2024</span></div>`
      : `<div class="price-line dim">No 2024 sales recorded in this plot</div>`;
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
  const priceLine = p.price_median != null
    ? `<div class="price-line"><span>Median sale price</span>
         <strong>${priceFmt(p.price_median)}</strong>
         <span class="dim">${p.price_count} sales · 2024</span></div>`
    : (state.hasPrice ? `<div class="price-line dim">No 2024 sales recorded</div>` : "");

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

function wireInteractions() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "lsoa-fill", (e) => {
    const f = e.features[0];
    const p = f.properties;
    map.getCanvas().style.cursor = "pointer";
    const detail = state.layer === "price"
      ? (p.price_median != null ? priceFmt(p.price_median) + " median" : "no sales")
      : "combined " + p._combined.toFixed(0);
    popup.setLngLat(e.lngLat)
      .setHTML(`${p.lsoa_code} · ${detail} · click to inspect`)
      .addTo(map);
  });
  map.on("mouseleave", "lsoa-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });

  // Click a single area to pin its full breakdown. If the same tap also hit a
  // rail stop, the stop handler set _stopClickGuard — skip the zone panel so
  // the stop panel wins (both layers' click handlers fire for one tap).
  map.on("click", "lsoa-fill", (e) => {
    if (window._stopClickGuard) { window._stopClickGuard = false; return; }
    inspectLSOA(e.features[0].properties, e.point);
    setDrawer(false);   // on mobile, reveal the map result
  });

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

    // Click a stop -> pin its details. Set a guard so the lsoa-fill handler,
    // which also fires for this tap, doesn't immediately overwrite the stop
    // panel with the zone panel. (stopPropagation alone doesn't prevent the
    // other layer handler from running in the same MapLibre click cycle.)
    map.on("click", "rail-stop", (e) => {
      window._stopClickGuard = true;
      inspectStop(e.features[0].properties, e.point);
      setDrawer(false);
    });
  }
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

// ---- Legend ---------------------------------------------------------------

function buildLegend() {
  const el = document.getElementById("legend");
  const ramp = activeRamp();
  const swatches = ramp.map(c => `<span style="background:${c}"></span>`).join("");
  let header;
  if (state.layer === "price") {
    const band = state.breaksData?.price_band;
    const note = band
      ? `Land Registry 2024 · ${priceFmt(band[0])}–${priceFmt(band[1])} typical band`
      : `Land Registry 2024`;
    header = `
      <div class="title">Median sale price</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>lower</span><span>higher</span></div>
      <div class="legend-note">${note}</div>`;
  } else {
    const breaks = currentBreaks();
    const lo = breaks.length ? breaks[0].toFixed(0) : "0";
    const hi = breaks.length ? breaks[breaks.length - 1].toFixed(0) : "100";
    const soloName = state.solo
      ? DOMAINS.find(d => d.key === state.solo).name
      : null;
    const title = soloName ? `${soloName} only` : "Combined score";
    const note = soloName ? `Single domain · fixed classes`
                          : `Fixed classes · breaks ${lo}–${hi}`;
    header = `
      <div class="title">${title}</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>less deprived</span><span>more deprived</span></div>
      <div class="legend-note">${note}</div>`;
  }

  // Controls: colour mode, fade-to-map opacity, light/dark theme.
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
        <span class="lc-label">Map fade</span>
        <input type="range" id="opacity-slider" min="0.1" max="1" step="0.05"
               value="${state.fillOpacity}" aria-label="Choropleth opacity" />
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
  el.querySelector("#opacity-slider").addEventListener("input", (e) => {
    state.fillOpacity = parseFloat(e.target.value);
    map.setPaintProperty("lsoa-fill", "fill-opacity", state.fillOpacity);
  });
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
  if (map.getLayer("lsoa-line")) map.setPaintProperty("lsoa-line", "line-color", LINE_COLOR());
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
};

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

  runDeepDive(catchment, {
    eyebrow: "Deep dive",
    title: p.lad_name || "Selected area",
    subtitle: p.lsoa_name ? `${p.lsoa_name} · ${p.lsoa_code}` : p.lsoa_code,
    score: combinedScore(p, state.weights),
    scoreCaption: "Combined deprivation · weighted",
  });
}

// The shared engine: run a deep dive on ANY catchment polygon (an LSOA, or an
// isochrone, or a drawn plot's buffer). `meta` carries what the panel header
// and score block should show.
function runDeepDive(catchment, meta) {
  deep.catchment = catchment;
  deep.active = true;
  deep.prevView = { center: map.getCenter(), zoom: map.getZoom() };
  deep.enabledKinds = new Set();
  deep.cache = {};
  deep.crimeView = "points";
  deep.crimeVisible = true;
  deep.crimeData = null;

  if (map.getLayer("lsoa-fill")) map.setPaintProperty("lsoa-fill", "fill-opacity", 0.35);
  closeDetail();
  const bbox = turf.bbox(deep.catchment);
  const rightPad = window.innerWidth <= 720 ? 40 : 420;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
    { padding: { top: 60, bottom: 60, left: 60, right: rightPad }, duration: 600 });

  setCatchmentOutline(deep.catchment);
  buildDeepDivePanel(meta);
}

function exitDeepDive() {
  deep.active = false;
  for (const a of AMENITY_KINDS) removeAmenityLayer(a.kind);
  removeCrimeLayer();
  removeCatchmentOutline();
  if (map.getLayer("plot-point-dot")) map.removeLayer("plot-point-dot");
  if (map.getSource("plot-point-src")) map.removeSource("plot-point-src");
  if (map.getLayer("lsoa-fill"))
    map.setPaintProperty("lsoa-fill", "fill-opacity", state.fillOpacity);
  setDeepPanelOpen(false);
  const panel = document.getElementById("deepdive-panel");
  if (panel) panel.innerHTML = "";
  if (deep.prevView) {
    map.easeTo({ center: deep.prevView.center, zoom: deep.prevView.zoom, duration: 500 });
  }
}

function setCatchmentOutline(feature) {
  const data = { type: "FeatureCollection", features: [feature] };
  if (map.getSource("catchment")) {
    map.getSource("catchment").setData(data);
  } else {
    map.addSource("catchment", { type: "geojson", data });
    map.addLayer({
      id: "catchment-line", type: "line", source: "catchment",
      paint: { "line-color": "#111", "line-width": 2, "line-dasharray": [2, 1] },
    });
  }
}
function removeCatchmentOutline() {
  if (map.getLayer("catchment-line")) map.removeLayer("catchment-line");
  if (map.getSource("catchment")) map.removeSource("catchment");
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

  // Tap an amenity for its name + subtype.
  map.on("click", layerId, (e) => {
    const pr = e.features[0].properties;
    new maplibregl.Popup({ offset: 8 })
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${pr.name}</strong><br>${pr.sub || meta.label}`)
      .addTo(map);
  });
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
    updateDeepStat(kind, `${n} in catchment`);
  } else {
    deep.enabledKinds.delete(kind);
    removeAmenityLayer(kind);
    updateDeepStat(kind, "");
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

    map.on("click", "crime-dot", (e) => {
      const pr = e.features[0].properties;
      new maplibregl.Popup({ offset: 8 })
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${pr.count} crime${pr.count == 1 ? "" : "s"}</strong>` +
          (pr.street ? `<br>${pr.street}` : "") +
          (pr.breakdown ? `<br><span style="font-size:11px;text-transform:capitalize">${pr.breakdown}</span>` : "")
        )
        .addTo(map);
    });
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

  const scoreStr = (meta.score == null || isNaN(meta.score)) ? "—" : meta.score.toFixed(0);

  const panel = document.getElementById("deepdive-panel");
  panel.innerHTML = `
    <div class="dd-head">
      <div>
        <div class="dd-eyebrow">${meta.eyebrow || "Deep dive"}</div>
        <div class="dd-title">${meta.title || "Selected area"}</div>
        <div class="dd-subtitle">${meta.subtitle || ""}</div>
      </div>
      <button class="dd-close" aria-label="Close deep dive" title="Close">×</button>
    </div>

    <div class="dd-body">
      <section class="dd-block" data-section="score">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Deprivation</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div class="dd-score">
            <div class="dd-score-big">${scoreStr}<span>/100</span></div>
            <div class="dd-score-cap">${meta.scoreCaption || "Combined deprivation · weighted"}</div>
          </div>
        </div>
      </section>

      <section class="dd-block" data-section="amenities">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Amenities in this area</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">
          <div class="dd-toggles">${toggles}</div>
          ${note}
          <p class="hint" style="margin-top:8px">Toggle a layer to map it within the catchment.</p>
        </div>
      </section>

      <section class="dd-block" data-section="crime" id="dd-crime-block">
        <button class="dd-block-head" type="button" aria-expanded="true">
          <span class="dd-h">Crime <span class="dd-h-note" id="dd-crime-period"></span></span>
          <span class="dd-head-right">
            <label class="dd-show-toggle" id="dd-crime-show-wrap" hidden>
              <input type="checkbox" id="dd-crime-show" checked />
              <span>Show</span>
            </label>
            <span class="dd-caret">▾</span>
          </span>
        </button>
        <div class="dd-block-content">
          <div id="dd-crime-body">
            <button class="dd-load-btn" id="dd-crime-load" type="button">Load 12 months of crime</button>
          </div>
        </div>
      </section>
    </div>`;

  setDeepPanelOpen(true);
  panel.querySelector(".dd-close").addEventListener("click", exitDeepDive);
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
    if (cb) cb.addEventListener("change", (e) => toggleAmenityKind(a.kind, e.target.checked));
  }
  const crimeBtn = panel.querySelector("#dd-crime-load");
  if (crimeBtn) crimeBtn.addEventListener("click", loadCrime);
  const crimeShow = panel.querySelector("#dd-crime-show");
  if (crimeShow) crimeShow.addEventListener("change", (e) => setCrimeVisible(e.target.checked));
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

// Area-weighted deprivation score for an arbitrary catchment polygon. We take
// every LSOA currently in the vector tiles that intersects the catchment,
// compute the area of overlap, and weight each LSOA's combined score by its
// share of the total overlapping area. This represents the deprivation of the
// area someone can actually reach, blending part-covered zones proportionally.
function areaWeightedScore(catchment) {
  if (!window.turf) return { score: null, parts: 0 };
  // All LSOA polygons currently rendered (covers the visible area; the user is
  // zoomed to the catchment so these are the relevant ones).
  const feats = map.querySourceFeatures("lsoa", { sourceLayer: SOURCE_LAYER });
  if (!feats.length) return { score: null, parts: 0 };

  // De-dupe by code (tiles can repeat a feature across tile edges).
  const seen = new Set();
  let totalArea = 0;
  const contribs = [];
  for (const f of feats) {
    const code = f.properties && f.properties.lsoa_code;
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
    const s = combinedScore(f.properties, state.weights);
    if (s == null || isNaN(s)) continue;
    contribs.push({ a, s });
    totalArea += a;
  }
  if (!totalArea) return { score: null, parts: 0 };
  const score = contribs.reduce((sum, c) => sum + c.s * (c.a / totalArea), 0);
  return { score, parts: contribs.length };
}

// Build an isochrone polygon from a point via the public Valhalla server.
// Returns a GeoJSON Feature (Polygon) or null. No API key needed.
async function fetchIsochrone(lng, lat, mode, minutes) {
  const body = {
    locations: [{ lat, lon: lng }],
    costing: mode,
    contours: [{ time: minutes }],
    polygons: true,
  };
  const url = "https://valhalla1.openstreetmap.de/isochrone?json=" +
    encodeURIComponent(JSON.stringify(body));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Valhalla HTTP ${r.status}`);
  const gj = r.json ? await r.json() : null;
  // Valhalla returns a FeatureCollection of contour polygons/linestrings.
  const feats = (gj && gj.features) || [];
  const poly = feats.find(f => f.geometry &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
  return poly || null;
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
    setPlotStatus(`Couldn't build isochrone (${e.message}). Try again or a different point.`);
    return;
  }
  if (!catchment) { setPlotStatus("No isochrone returned for that point."); return; }
  setPlotStatus("");

  const { score, parts } = areaWeightedScore(catchment);
  runDeepDive(catchment, {
    eyebrow: "Isochrone deep dive",
    title: `${plot.minutes}-min ${modeLabel.toLowerCase()}`,
    subtitle: parts ? `Area-weighted across ${parts} LSOA${parts === 1 ? "" : "s"}` : "Catchment analysis",
    score,
    scoreCaption: "Area-weighted deprivation · weighted",
  });
}

function setPlotStatus(msg) {
  const el = document.getElementById("plot-status");
  if (el) el.textContent = msg || "";
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
  if (!goBtn) return;

  let pointMode = false;

  function setActive(btn) {
    document.querySelectorAll(".plot-mode-btn").forEach(b => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
  }

  // Drop a point: next map click sets the plot origin.
  pointBtn.addEventListener("click", () => {
    pointMode = true;
    setActive(pointBtn);
    setPlotStatus("Click the map to drop your point.");
    map.getCanvas().style.cursor = "crosshair";
  });

  map.on("click", (e) => {
    if (!pointMode) return;
    pointMode = false;
    map.getCanvas().style.cursor = "";
    plot.geometry = { type: "Point", coordinates: [e.lngLat.lng, e.lngLat.lat] };
    // Show a marker for the chosen point.
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
  });

  // Draw a plot: use the existing MapboxDraw polygon tool.
  drawBtn.addEventListener("click", () => {
    setActive(drawBtn);
    setPlotStatus("Draw a polygon on the map (click points, double-click to finish).");
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

buildSliders();
buildLegend();

map.on("load", async () => {
  try {
    await loadData();
    buildLegend();          // now that breaks.json is loaded
    buildLayerToggle();
    buildRailToggle();
    wireInteractions();
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