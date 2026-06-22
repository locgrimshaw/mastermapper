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
  fillOpacity: 0.85,     // choropleth opacity (slider fades to basemap)
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
  // 8px is comfortable for fingers without making real drags feel sticky.
  clickTolerance: 8,
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

  // Station-usage layer (heavy rail). A small standalone GeoJSON (not in the
  // tiles), loaded like crime/amenities. Optional: absent file → no station
  // mode, everything else works.
  try {
    const sr = await fetch("data/stations.geojson", { cache: "no-store" });
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

  // --- Station-usage layer (heavy rail, the analysis objects) --------------
  if (state.hasStations) {
    addStationLayer();
  }

  updateDataSourceNote();
}

// Add the heavy-rail station layer from the standalone GeoJSON: circles scaled
// by annual usage, with labels at closer zooms, plus hover + click. These are
// the objects the station-led workflow profiles, so they're clickable and sit
// above the transit overlay.
function addStationLayer() {
  if (map.getSource("stations")) return;
  map.addSource("stations", { type: "geojson", data: state.stationsData });

  // Usage drives the radius. We interpolate on a sqrt-like set of stops so a
  // 10M-entry hub doesn't dwarf a 100k station into invisibility. Stations with
  // null usage get the minimum size. Radius = (usage curve) × (zoom factor):
  // multiplying two interpolate expressions is valid in MapLibre, whereas
  // nesting one interpolate inside another's stops is not.
  const usageRadius = [
    "interpolate", ["linear"], ["coalesce", ["get", "usage"], 0],
    0, 3.4, 250000, 5, 1000000, 6.5, 5000000, 9, 20000000, 13,
  ];
  const zoomFactor = ["interpolate", ["linear"], ["zoom"], 5, 0.6, 11, 1, 14, 1.25];
  map.addLayer({
    id: "station-dot",
    type: "circle",
    source: "stations",
    layout: { visibility: state.stationsVisible ? "visible" : "none" },
    paint: {
      "circle-radius": ["*", usageRadius, zoomFactor],
      "circle-color": STATION_COLOR,
      "circle-opacity": 0.9,
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

// Station controls: a typeahead search over the loaded stations + a show/hide
// toggle. Selecting a result flies to the station and opens its inspect card.
function buildStationControls() {
  const block = document.getElementById("station-block");
  if (!block) return;
  if (!state.hasStations) { block.hidden = true; return; }
  block.hidden = false;

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
    if (deep.active) renderDeprivationScore();
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
  const priceLine = p.price_median != null
    ? `<div class="price-line"><span>Median sale price</span>
         <strong>${priceFmt(p.price_median)}</strong>
         <span class="dim">${p.price_count} sales · 2024</span></div>`
    : (state.hasPrice ? `<div class="price-line dim">No 2024 sales recorded</div>` : "");

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

function wireInteractions() {
  // --- Station click (highest priority) ------------------------------------
  // Handled centrally rather than as a layer-specific handler: query for a
  // station dot at the click point first, and if found, open the station card
  // and stop. This is robust to layer ordering and to the station dots
  // coinciding with tile-based rail stops on the live map. Registered FIRST so
  // it runs before the lsoa-fill / rail-stop handlers in the same click cycle.
  map.on("click", (e) => {
    if (!state.hasStations || !map.getLayer("station-dot")) return;
    if (state.stationsVisible === false) return;
    if (state.plotPointMode) return;            // a click is meant to drop a point
    // Query a small box around the click (not a single pixel) so taps near a
    // station dot still register — single-pixel hit-testing misses small dots,
    // which is why clicks were falling through to the rail-stop card.
    // Bigger hit box on touch — a finger tap is far less precise than a mouse
    // click, so a small station dot is easy to miss with a tight tolerance.
    const tol = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ? 16 : 8;
    const box = [
      [e.point.x - tol, e.point.y - tol],
      [e.point.x + tol, e.point.y + tol],
    ];
    let hits;
    try {
      hits = map.queryRenderedFeatures(box, { layers: ["station-dot"] });
    } catch (_) { hits = null; }
    if (hits && hits.length) {
      // Pick the station nearest the actual click point (box may catch a few).
      let best = hits[0], bestD = Infinity;
      for (const h of hits) {
        const c = h.geometry && h.geometry.coordinates;
        if (!c) continue;
        const p = map.project(c);
        const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
        if (d < bestD) { bestD = d; best = h; }
      }
      window._stopClickGuard = true;            // suppress the lsoa-fill handler
      inspectStation(best.properties, e.point);
      setDrawer(false);
      // The lsoa-fill handler consumes the guard in the same click cycle; if no
      // LSOA is under the click (data edge), clear it next tick so it can't
      // swallow a later, legitimate click.
      setTimeout(() => { window._stopClickGuard = false; }, 0);
    }
  });

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

  // Click a single area to pin its full breakdown. Several cases must NOT open
  // the zone panel:
  //   - a deep dive is open (you're working inside a catchment, not picking a zone)
  //   - we're dropping a point or drawing a plot (clicks are for that)
  //   - the draw tool is in any non-simple mode (mid-draw)
  //   - the same tap also hit a rail stop (stop panel wins)
  map.on("click", "lsoa-fill", (e) => {
    if (window._stopClickGuard) { window._stopClickGuard = false; return; }
    if (deep.active) return;
    if (state.plotPointMode) return;
    try {
      const m = draw.getMode && draw.getMode();
      if (m && m !== "simple_select" && m !== "static") return;
    } catch (_) {}
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

    // Click a stop -> pin its details. But if the station-usage layer is on and
    // a station dot sits under the same click (heavy-rail stops coincide with
    // station dots), let the station card win — it has usage + the profile
    // button. We check by querying station-dot features at the click point.
    map.on("click", "rail-stop", (e) => {
      const props = e.features[0].properties;
      // If we have station-usage data, a click on a heavy-rail stop should show
      // the RICH station card, not the plain stop card. Try to match the stop
      // to a station by CRS (the reliable key) or by name, and upgrade.
      if (state.hasStations) {
        const station = findStationForStop(props);
        if (station) {
          window._stopClickGuard = true;
          inspectStation(station.properties, e.point);
          setDrawer(false);
          setTimeout(() => { window._stopClickGuard = false; }, 0);
          return;
        }
      }
      window._stopClickGuard = true;
      inspectStop(e.features[0].properties, e.point);
      setDrawer(false);
    });
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
    alert(`Couldn't build the station catchment (${e.message}).`);
    return;
  }
  if (!catchment) {
    setStationProfileBtn("Profile this station →", false);
    alert("No catchment returned for that station.");
    return;
  }

  // Remember the origin so "nearest access" routes from the station itself.
  plot.geometry = { type: "Point", coordinates: coords };
  plot.mode = "pedestrian";
  plot.minutes = minutes;

  const usage = (station.usage != null && station.usage !== "") ? Number(station.usage) : null;
  const trend = parseTrend(station.trend);
  const { domains, parts } = areaWeightedScore(catchment);
  closeStation();
  runDeepDive(catchment, {
    eyebrow: "Station profile",
    title: station.name || "Station",
    subtitle: `${minutes}-min walk catchment${parts ? ` · ${parts} LSOA${parts === 1 ? "" : "s"}` : ""}`,
    domains,
    scoreCaption: "Catchment deprivation · weighted",
    station: {
      name: station.name, crs: station.crs, operator: station.operator,
      usage, trend, year: state.stationsMeta?.latest_year || "",
      interchanges: station.interchanges != null && station.interchanges !== "" ? Number(station.interchanges) : null,
      season_share: station.season_share != null && station.season_share !== "" ? Number(station.season_share) : null,
      usage_pctile: station.usage_pctile != null && station.usage_pctile !== "" ? Number(station.usage_pctile) : null,
      region: station.region || null,
      quality: station.quality || null,
      adjusted: station.adjusted === true || station.adjusted === "true",
    },
  });
}

function setStationProfileBtn(text, disabled) {
  const btn = document.getElementById("station-profile-btn");
  if (btn) { btn.textContent = text; btn.disabled = !!disabled; }
}

// Default walk-time (minutes) for a station catchment. A 15-min walk is the
// conventional station "ped-shed"; exposed as a constant so it's easy to lift
// into a control later.
const STATION_WALK_MINUTES = 15;

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
  population: null,      // estimated resident population of the catchment
  area_km2: null,        // catchment area in km²
  popPartial: false,    // true if some overlapping LSOAs lacked population
  counts: {},           // kind -> latest count in catchment (for density)
  station: null,        // station meta when this is a station profile
  brownfield: null,     // cached brownfield sites in catchment (array)
  brownfieldVisible: false, // layer toggle
  brownfieldFilters: { minDwellings: 0, publicOnly: false, deliverableOnly: false },
  brownfieldSummary: null,  // { n_sites, n_public, dwellings_*_total, hectares_total }
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
    area_km2: deep.area_km2,
    interchanges: st.interchanges ?? null,
    season_share: st.season_share ?? null,
    usagePerResident: (usage != null && deep.population) ? usage / deep.population : null,
    upliftPeople,
    upliftPct: (upliftPeople != null && deep.population) ? (upliftPeople / deep.population) * 100 : null,
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
  deep.area_km2 = null;
  deep.popPartial = false;
  deep.counts = {};
  deep.station = meta.station || null;   // station meta for the station section
  deep.brownfield = null;
  deep.brownfieldSummary = null;
  deep.brownfieldVisible = false;
  deep.brownfieldFilters = { minDwellings: 0, publicOnly: false, deliverableOnly: false };

  // The mask dims everything outside the catchment, so we keep the choropleth
  // reasonably visible (it shows through inside the catchment) rather than
  // dimming it everywhere.
  if (map.getLayer("lsoa-fill")) map.setPaintProperty("lsoa-fill", "fill-opacity", 0.6);
  closeDetail();
  const bbox = turf.bbox(deep.catchment);
  const rightPad = window.innerWidth <= 720 ? 40 : 420;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
    { padding: { top: 60, bottom: 60, left: 60, right: rightPad }, duration: 600 });

  setCatchmentOutline(deep.catchment);
  buildDeepDivePanel(meta);

  // Estimate the catchment's resident population + area, then fill the stat row.
  computeCatchmentPopulation();

  // Auto-activate every amenity layer so the user immediately sees what's in the
  // catchment, and compute nearest-distance stats. Done after the panel exists.
  autoEnableAmenities();
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
  deep.area_km2 = res.area_km2;
  deep.popPartial = res.partial;
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
  if (areaEl) areaEl.textContent = fmtArea(deep.area_km2);
  const dens = densityPerKm2(deep.population, deep.area_km2);
  if (densEl) densEl.textContent = dens == null ? "—" : fmtCount(dens);

  if (noteEl) {
    if (deep.population == null) {
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
        const r