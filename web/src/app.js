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

const DOMAINS = [
  { key: "income",      name: "Income",
    about: "Proportion of people on low income — those receiving income-related benefits and tax credits. Includes both out-of-work and in-work low earners." },
  { key: "employment",  name: "Employment",
    about: "Involuntary exclusion from work among the working-age population: claimants of jobseeker's, incapacity, and carer's benefits." },
  { key: "education",   name: "Education & skills",
    about: "Lack of attainment and skills, combining children/young people's school results and the proportion of adults with low or no qualifications." },
  { key: "health",      name: "Health & disability",
    about: "Risk of premature death and impairment to quality of life through poor physical or mental health. Measures morbidity and disability, not health-care access." },
  { key: "crime",       name: "Crime",
    about: "Risk of personal and material victimisation, derived from recorded rates of violence, burglary, theft, and criminal damage." },
  { key: "housing",     name: "Barriers to housing",
    about: "Physical and financial accessibility of housing and key local services — distance to a GP, shop, school, plus overcrowding, homelessness, and affordability." },
  { key: "environment", name: "Living environment",
    about: "Quality of the local environment: housing condition (indoor) and air quality plus road-traffic accident risk (outdoor)." },
];

// Sequential ramp, light -> dark = less -> more deprived.
// Slightly wider perceptual spread than before so adjacent classes read apart.
const RAMP = ["#f3efe6", "#eccfa0", "#e0a063", "#cf6f3a", "#a84724", "#7a2d1c"];

// A separate cool ramp for the house-price overlay so it reads as a different
// dataset, not a re-colour of deprivation. Light -> dark = cheaper -> dearer.
const PRICE_RAMP = ["#e8eef2", "#b9cfdc", "#89b0c6", "#5a8fb0", "#356f97", "#1c4f72"];

const state = {
  weights: Object.fromEntries(DOMAINS.map(d => [d.key, 1])),
  geojson: null,
  usingSampleData: true,
  breaks: [],            // quantile breakpoints for the colour scale
  selectedCode: null,    // LSOA pinned by click-to-inspect
  layer: "deprivation",  // "deprivation" | "price"
  hasPrice: false,       // whether the loaded data includes price fields
};

// The field and ramp currently driving the choropleth.
function activeRamp() {
  return state.layer === "price" ? PRICE_RAMP : RAMP;
}
function activeField() {
  return state.layer === "price" ? "price_norm" : "_combined";
}

// ---- Scoring engine -------------------------------------------------------

// Combined score for one feature's properties, given current weights.
// Each domain is already normalised 0-100 (higher = more deprived).
function combinedScore(props, weights) {
  let wsum = 0, acc = 0;
  for (const d of DOMAINS) {
    const w = weights[d.key];
    const v = props[`${d.key}_norm`];
    if (v == null) continue;
    acc += w * v;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0;
}

// Write the combined score into every feature so the map can style by it.
function recomputeScores() {
  for (const f of state.geojson.features) {
    f.properties._combined = combinedScore(f.properties, state.weights);
  }
  computeBreaks();
}

// Quantile breakpoints across the CURRENT active field. Using quantiles
// (equal-count classes) rather than fixed cutoffs means the full colour ramp
// is always in play, so differences stay visible no matter how the user
// weights the domains, switches layer, or zooms.
function computeBreaks() {
  const field = activeField();
  const ramp = activeRamp();
  const vals = state.geojson.features
    .map(f => f.properties[field])
    .filter(v => v != null)
    .sort((a, b) => a - b);
  const n = vals.length;
  if (!n) { state.breaks = []; return; }
  const breaks = [];
  for (let i = 1; i < ramp.length; i++) {
    breaks.push(vals[Math.floor((i / ramp.length) * n)]);
  }
  state.breaks = breaks;
}

// MapLibre 'step' expression built from the current quantile breaks.
// Areas with no value for the active field render transparent.
function fillColorExpression() {
  const ramp = activeRamp();
  const field = activeField();
  if (!state.breaks.length) return ramp[0];
  const expr = ["step", ["coalesce", ["get", field], -1], "rgba(0,0,0,0)"];
  // First real class starts at 0; below 0 (our sentinel) stays transparent.
  expr.push(0, ramp[0]);
  state.breaks.forEach((b, i) => { expr.push(b, ramp[i + 1]); });
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
        tiles: ["https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap, © CARTO",
      },
    },
    layers: [{ id: "base", type: "raster", source: "carto" }],
  },
  center: [-0.11, 51.51],
  zoom: 10.5,
});

const draw = new MapboxDraw({
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
});
map.addControl(draw, "top-right");
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ---- Data load ------------------------------------------------------------

async function loadData() {
  // Data lives inside web/ so GitHub Pages can serve it at this relative path.
  const res = await fetch("data/lsoa_imd.geojson");
  if (!res.ok) throw new Error(`Could not load data (${res.status})`);
  state.geojson = await res.json();

  // Heuristic: synthetic codes start with "S".
  state.usingSampleData =
    state.geojson.features[0]?.properties.lsoa_code?.startsWith("S") ?? true;

  // Does this dataset include the house-price overlay?
  state.hasPrice = state.geojson.features.some(
    f => f.properties.price_norm != null
  );

  recomputeScores();

  map.addSource("lsoa", { type: "geojson", data: state.geojson });

  map.addLayer({
    id: "lsoa-fill",
    type: "fill",
    source: "lsoa",
    paint: {
      "fill-color": fillColorExpression(),
      "fill-opacity": 0.78,
    },
  });

  map.addLayer({
    id: "lsoa-line",
    type: "line",
    source: "lsoa",
    paint: { "line-color": "#1a223080", "line-width": 0.4 },
  });

  // Highlight outline for the LSOA pinned by click-to-inspect.
  map.addLayer({
    id: "lsoa-selected",
    type: "line",
    source: "lsoa",
    paint: { "line-color": "#1a2230", "line-width": 2.4 },
    filter: ["==", "lsoa_code", ""],
  });

  // Fit to the data extent.
  const b = turf.bbox(state.geojson);
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 0 });

  updateDataSourceNote();
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
  }
}

// ---- Choropleth restyle on weight change ----------------------------------

function restyle() {
  recomputeScores();
  map.getSource("lsoa").setData(state.geojson);
  map.setPaintProperty("lsoa-fill", "fill-color", fillColorExpression());
  buildLegend();
  if (state.selectedCode) inspectLSOA(state.selectedCode);
}

// Switch the choropleth between deprivation and house prices.
function setLayer(mode) {
  state.layer = mode;
  computeBreaks();
  map.setPaintProperty("lsoa-fill", "fill-color", fillColorExpression());
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

// ---- Sliders UI -----------------------------------------------------------

function buildSliders() {
  const wrap = document.getElementById("sliders");
  for (const d of DOMAINS) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `
      <div class="label-line">
        <span class="name">${d.name}<button class="info" type="button"
              aria-label="What ${d.name} covers" tabindex="0">i<span
              class="tip" role="tooltip">${d.about}</span></button></span>
        <span class="val" id="val-${d.key}">1.0×</span>
      </div>
      <input type="range" min="0" max="3" step="0.1" value="1"
             id="slider-${d.key}" aria-label="${d.name} weight" />`;
    wrap.appendChild(row);

    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      state.weights[d.key] = parseFloat(input.value);
      document.getElementById(`val-${d.key}`).textContent =
        `${parseFloat(input.value).toFixed(1)}×`;
      restyle();
      refreshReportIfActive();
    });
  }

  document.getElementById("reset-weights").addEventListener("click", () => {
    for (const d of DOMAINS) {
      state.weights[d.key] = 1;
      document.getElementById(`slider-${d.key}`).value = 1;
      document.getElementById(`val-${d.key}`).textContent = "1.0×";
    }
    restyle();
    refreshReportIfActive();
  });
}

// ---- Plot context report (spatial aggregation, client-side) ---------------

let lastDrawnPolygon = null;

function onDrawChange() {
  const data = draw.getAll();
  if (!data.features.length) { lastDrawnPolygon = null; return; }
  lastDrawnPolygon = data.features[data.features.length - 1];
  state.selectedCode = null;
  map.setFilter("lsoa-selected", ["==", "lsoa_code", ""]);
  buildReport(lastDrawnPolygon);
}

function refreshReportIfActive() {
  if (lastDrawnPolygon) buildReport(lastDrawnPolygon);
}

// Area-weighted aggregation: for each LSOA the plot overlaps, weight its
// metrics by the area of overlap. This gives the plot's immediate context
// rather than a single LSOA's value.
function buildReport(plot) {
  const overlaps = [];
  for (const f of state.geojson.features) {
    let inter;
    try {
      // Turf v7: intersect takes a FeatureCollection of two polygons.
      inter = turf.intersect(
        turf.featureCollection([turf.feature(plot.geometry), f])
      );
    } catch { inter = null; }
    if (!inter) continue;
    const area = turf.area(inter);
    if (area > 0) overlaps.push({ props: f.properties, area });
  }

  const report = document.getElementById("report");
  if (!overlaps.length) {
    report.innerHTML =
      `<p class="empty">Plot doesn't overlap any data areas. ` +
      `Draw within the coloured region.</p>`;
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
  // Colour a 0-100 value by the current quantile breaks (matches the map).
  if (!state.breaks.length) return RAMP[0];
  for (let i = 0; i < state.breaks.length; i++) {
    if (v < state.breaks[i]) return RAMP[i];
  }
  return RAMP[RAMP.length - 1];
}

// ---- Click to inspect a single LSOA ---------------------------------------

function inspectLSOA(code) {
  const f = state.geojson.features.find(x => x.properties.lsoa_code === code);
  if (!f) return;
  state.selectedCode = code;
  lastDrawnPolygon = null;                       // clicking supersedes a drawn plot
  map.setFilter("lsoa-selected", ["==", "lsoa_code", code]);

  const p = f.properties;
  const combined = p._combined;
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

  document.getElementById("report").innerHTML = `
    <div class="report-headline">
      <div class="big">${combined.toFixed(0)}<span style="font-size:14px">/100</span></div>
      <div class="cap">${code} · single area · weighted</div>
    </div>
    ${priceLine}
    <table class="metric-table">${rows}</table>
    <p class="hint" style="margin-top:14px">
      Each value is that domain's national percentile (100 = most deprived
      in England). Draw a plot to aggregate several areas instead.
    </p>`;
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

  // Click a single area to pin its full breakdown.
  map.on("click", "lsoa-fill", (e) => {
    inspectLSOA(e.features[0].properties.lsoa_code);
  });

  map.on("draw.create", onDrawChange);
  map.on("draw.update", onDrawChange);
  map.on("draw.delete", () => {
    lastDrawnPolygon = null;
    state.selectedCode = null;
    map.setFilter("lsoa-selected", ["==", "lsoa_code", ""]);
    document.getElementById("report").innerHTML =
      `<p class="empty">No site selected yet.</p>`;
  });
}

// ---- Legend ---------------------------------------------------------------

function buildLegend() {
  const el = document.getElementById("legend");
  const ramp = activeRamp();
  const swatches = ramp.map(c => `<span style="background:${c}"></span>`).join("");
  if (state.layer === "price") {
    const lo = priceFmt(quantilePrice(0.16));
    const hi = priceFmt(quantilePrice(0.84));
    el.innerHTML = `
      <div class="title">Median sale price</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>lower</span><span>higher</span></div>
      <div class="legend-note">Land Registry 2024 · ${lo}–${hi} typical band</div>`;
  } else {
    const lo = state.breaks.length ? state.breaks[0].toFixed(0) : "0";
    const hi = state.breaks.length ? state.breaks[state.breaks.length - 1].toFixed(0) : "100";
    el.innerHTML = `
      <div class="title">Combined score</div>
      <div class="ramp">${swatches}</div>
      <div class="scale"><span>less deprived</span><span>more deprived</span></div>
      <div class="legend-note">Equal-count classes · breaks ${lo}–${hi}</div>`;
  }
}

// A price at a given fraction through the sorted medians (for legend labels).
function quantilePrice(frac) {
  const vals = state.geojson.features
    .map(f => f.properties.price_median)
    .filter(v => v != null)
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  return vals[Math.floor(frac * (vals.length - 1))];
}

function priceFmt(v) {
  if (v == null) return "—";
  if (v >= 1e6) return "£" + (v / 1e6).toFixed(1) + "m";
  return "£" + Math.round(v / 1000) + "k";
}

// ---- Boot -----------------------------------------------------------------

buildSliders();
buildLegend();

map.on("load", async () => {
  try {
    await loadData();
    buildLayerToggle();
    wireInteractions();
  } catch (err) {
    document.getElementById("datasource").className = "datasource warn";
    document.getElementById("datasource").textContent =
      "Could not load data: " + err.message +
      " — run the pipeline or sample-data script first.";
    console.error(err);
  }
});
