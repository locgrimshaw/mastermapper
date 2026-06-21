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
    const tol = 8;
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
  if (map.getLayer("lsoa-fill"))
    map.setPaintProperty("lsoa-fill", "fill-opacity", state.fillOpacity);
  setDeepPanelOpen(false);
  const panel = document.getElementById("deepdive-panel");
  if (panel) panel.innerHTML = "";
  if (deep.prevView) {
    map.easeTo({ center: deep.prevView.center, zoom: deep.prevView.zoom, duration: 500 });
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
        || id.startsWith("brownfield-")) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  }
  for (const id of sourceIds) {
    if (id.startsWith("amenity-") || id.startsWith("access-route-")
        || id.startsWith("brownfield-")) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  // Tracked sets too (covers any non-prefixed leftovers + resets state).
  for (const a of AMENITY_KINDS) removeAmenityLayer(a.kind);
  removeCrimeLayer();
  removeAccessRoutes();
  removeBrownfieldLayer();
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

  // Tap an amenity for its name + subtype.
  map.on("click", layerId, (e) => {
    const pr = e.features[0].properties;
    openClickPopup({ offset: 8 }, e.lngLat,
      `<strong>${pr.name}</strong><br>${pr.sub || meta.label}`);
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

  // Click any brownfield feature -> detail card (tracked popup so it clears).
  const onClick = (e) => {
    const pr = e.features[0].properties;
    openClickPopup({ offset: 12, maxWidth: "300px", closeButton: true, closeOnClick: true, className: "bf-popup" }, e.lngLat, brownfieldPopupHTML(pr));
  };
  for (const id of ["brownfield-poly-fill", "brownfield-pt-dot"]) {
    if (map.getLayer(id)) {
      map.on("click", id, onClick);
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

    map.on("click", "crime-dot", (e) => {
      const pr = e.features[0].properties;
      openClickPopup({ offset: 8 }, e.lngLat,
        `<strong>${pr.count} crime${pr.count == 1 ? "" : "s"}</strong>` +
        (pr.street ? `<br>${pr.street}` : "") +
        (pr.breakdown ? `<br><span style="font-size:11px;text-transform:capitalize">${pr.breakdown}</span>` : "")
      );
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
    <div class="dd-eyebrow" style="margin-bottom:6px">Opportunity synthesis</div>
    <p class="syn-headline">${synthesisSentence(snap)}</p>
    ${triadHTML(snap)}
    ${snap.upliftPeople != null ? `
      <p class="syn-uplift">Developing the catchment's brownfield capacity could add
        ~<strong>${snap.upliftPeople.toLocaleString()}</strong> residents
        ${snap.upliftPct != null ? `(<strong>${snap.upliftPct.toFixed(0)}%</strong> on current population)` : ""}
        at ${PEOPLE_PER_HOME} people/home.</p>` : ""}
    <div class="syn-actions">
      <button class="syn-btn" id="syn-pin-btn" type="button"></button>
      <button class="syn-btn syn-btn-ghost" id="syn-compare-btn" type="button">Shortlist & compare →</button>
    </div>`;

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
      <div class="p-stat"><div class="p-stat-v">${i.area_km2 != null ? i.area_km2.toFixed(2) + " km²" : "—"}</div><div class="p-stat-l">Catchment area</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.usagePerResident != null ? i.usagePerResident.toFixed(0) : "—"}</div><div class="p-stat-l">Usage per resident</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.season_share != null ? Math.round(i.season_share * 100) + "%" : "—"}</div><div class="p-stat-l">Season-ticket share</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.interchanges != null ? fmtCount(i.interchanges) : "—"}</div><div class="p-stat-l">Interchanges</div></div>
      <div class="p-stat"><div class="p-stat-v">${i.upliftPeople != null ? "+" + fmtCount(i.upliftPeople) : "—"}</div><div class="p-stat-l">Modelled uplift${i.upliftPct != null ? " (" + i.upliftPct.toFixed(0) + "%)" : ""}</div></div>
    </div>

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
    area_km2: popRes.area_km2,
    parts,
    interchanges: props.interchanges != null && props.interchanges !== "" ? Number(props.interchanges) : null,
    season_share: props.season_share != null && props.season_share !== "" ? Number(props.season_share) : null,
    usagePerResident: (usage != null && population) ? usage / population : null,
    upliftPeople,
    upliftPct: (upliftPeople != null && population) ? (upliftPeople / population) * 100 : null,
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
function renderBatchResults(results, errors) {
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
  const scored = results.map(r => {
    const needN = r.need == null ? 0 : clamp01(r.need / 100);
    const supplyN = r.supplyHomes == null ? 0 : clamp01(r.supplyHomes / SUPPLY_REF_HOMES);
    // Usage contributes INVERSELY for the "latent opportunity" reading: an
    // under-used station scores higher (more headroom). Use percentile.
    const usageHeadroom = r.usagePctile == null ? 0.5 : clamp01(1 - r.usagePctile / 100);
    const opp = Math.round((0.45 * needN + 0.40 * supplyN + 0.15 * usageHeadroom) * 100);
    return { ...r, opp, needN, supplyN, usageHeadroom };
  }).sort((a, b) => b.opp - a.opp);

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

  // Row click → close dash, fly to station, open its full deep dive.
  el.querySelectorAll(".bl-row").forEach(row => {
    row.addEventListener("click", () => {
      const r = scored.find(x => x.key === row.dataset.key);
      if (!r) return;
      close();
      const feats = (state.stationsData && state.stationsData.features) || [];
      const hit = feats.find(f => ((f.properties.crs || "").toUpperCase() === r.key) || f.properties.name === r.name);
      if (hit) { state.selectedStation = hit.properties; profileStation(hit.properties, null); }
    });
  });
  el.querySelectorAll(".bl-row .bl-quad-dot, .batch-quad [data-key]").forEach(d => {
    d.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const k = d.getAttribute("data-key");
      const r = scored.find(x => x.key === k); if (!r) return;
      close();
      const feats = (state.stationsData && state.stationsData.features) || [];
      const hit = feats.find(f => ((f.properties.crs || "").toUpperCase() === k) || f.properties.name === r.name);
      if (hit) { state.selectedStation = hit.properties; profileStation(hit.properties, null); }
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
              <div class="dd-stat-num" id="dd-area-value">—</div>
              <div class="dd-stat-cap">Area</div>
            </div>
            <div class="dd-stat-cell">
              <div class="dd-stat-num" id="dd-density-value">—</div>
              <div class="dd-stat-cap">Density / km²</div>
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
            <input type="checkbox" class="enable" id="dd-all-amenities" checked />
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
    if (cb) cb.addEventListener("change", (e) => {
      toggleAmenityKind(a.kind, e.target.checked);
      syncAllAmenitiesCheckbox();
    });
  }
  const allCb = panel.querySelector("#dd-all-amenities");
  if (allCb) allCb.addEventListener("change", (e) => toggleAllAmenities(e.target.checked));
  const crimeBtn = panel.querySelector("#dd-crime-load");
  if (crimeBtn) crimeBtn.addEventListener("click", loadCrime);
  const crimeShow = panel.querySelector("#dd-crime-show");
  if (crimeShow) crimeShow.addEventListener("change", (e) => setCrimeVisible(e.target.checked));

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

  // Fill the deprivation headline, breakdown bars and plain-English summary.
  renderDeprivationScore();
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

  const score = combinedScoreFromDomains(domains, state.weights);
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
    if (!domains) { listEl.innerHTML = ""; return; }
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
function areaWeightedScore(catchment) {
  if (!window.turf) return { domains: null, parts: 0 };
  const feats = map.querySourceFeatures("lsoa", { sourceLayer: SOURCE_LAYER });
  if (!feats.length) return { domains: null, parts: 0 };

  const seen = new Set();
  let totalArea = 0;
  const contribs = [];   // { a, props }
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
  const out = { population: null, area_km2: null, parts: 0, partial: false };
  if (!window.turf) return out;

  let area_m2 = 0;
  try { area_m2 = turf.area(catchment); } catch (_) { area_m2 = 0; }
  out.area_km2 = area_m2 > 0 ? area_m2 / 1e6 : null;

  const feats = map.querySourceFeatures("lsoa", { sourceLayer: SOURCE_LAYER });
  if (!feats.length) return out;

  const seen = new Set();
  let pop = 0;
  let counted = 0;
  let missing = 0;
  for (const f of feats) {
    const props = f.properties || {};
    const code = props.lsoa_code;
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
  }

  out.parts = counted + missing;
  if (counted > 0) {
    out.population = Math.round(pop);
    out.partial = missing > 0;
  }
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

  const { domains, parts } = areaWeightedScore(catchment);
  runDeepDive(catchment, {
    eyebrow: "Isochrone deep dive",
    title: `${plot.minutes}-min ${modeLabel.toLowerCase()}`,
    subtitle: parts ? `Area-weighted across ${parts} LSOA${parts === 1 ? "" : "s"}` : "Catchment analysis",
    domains,                      // per-domain averages → live re-weighting + breakdown
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
    state.plotPointMode = false;
    map.getCanvas().style.cursor = "";
    plot.geometry = { type: "Point", coordinates: [e.lngLat.lng, e.lngLat.lat] };
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

buildSliders();
buildLegend();

map.on("load", async () => {
  try {
    await loadData();
    buildLegend();          // now that breaks.json is loaded
    buildLayerToggle();
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