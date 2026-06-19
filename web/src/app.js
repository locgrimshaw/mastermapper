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
  // This is the main reason zones/stops felt "untappable" on iPad/phone.
  clickTolerance: 5,
});

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
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.4, 14, 0.7],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 11, 0.5, 14, 0.8],
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
    </p>`;
  panel.classList.add("open");
  panel.querySelector(".fd-close").addEventListener("click", closeDetail);

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
