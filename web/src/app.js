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
  { key: "income",      name: "Income" },
  { key: "employment",  name: "Employment" },
  { key: "education",   name: "Education & skills" },
  { key: "health",      name: "Health & disability" },
  { key: "crime",       name: "Crime" },
  { key: "housing",     name: "Barriers to housing" },
  { key: "environment", name: "Living environment" },
];

// Sequential ramp, light -> dark = less -> more deprived.
const RAMP = ["#f7f6f2", "#f0d9b5", "#e6a96b", "#d97742", "#b0492a", "#7a2d1c"];

const state = {
  weights: Object.fromEntries(DOMAINS.map(d => [d.key, 1])),
  geojson: null,
  usingSampleData: true,
};

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

  recomputeScores();

  map.addSource("lsoa", { type: "geojson", data: state.geojson });

  map.addLayer({
    id: "lsoa-fill",
    type: "fill",
    source: "lsoa",
    paint: {
      "fill-color": [
        "interpolate", ["linear"], ["get", "_combined"],
        0, RAMP[0], 20, RAMP[1], 40, RAMP[2],
        60, RAMP[3], 80, RAMP[4], 100, RAMP[5],
      ],
      "fill-opacity": 0.72,
    },
  }, /* insert below draw layers if present */ undefined);

  map.addLayer({
    id: "lsoa-line",
    type: "line",
    source: "lsoa",
    paint: { "line-color": "#1a223080", "line-width": 0.4 },
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
}

// ---- Sliders UI -----------------------------------------------------------

function buildSliders() {
  const wrap = document.getElementById("sliders");
  for (const d of DOMAINS) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `
      <div class="label-line">
        <span class="name">${d.name}</span>
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
    <table class="metric-table">${rows}</table>
    <p class="hint" style="margin-top:14px">
      Higher = more deprived (national percentile). Isochrones, nearest
      amenities, housing &amp; policy overlays arrive with the backend.
    </p>`;
}

function rampColor(v) {
  const i = Math.min(RAMP.length - 1, Math.floor(v / (100 / RAMP.length)));
  return RAMP[i];
}

// ---- Hover popup ----------------------------------------------------------

function wireInteractions() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "lsoa-fill", (e) => {
    const f = e.features[0];
    map.getCanvas().style.cursor = "crosshair";
    popup.setLngLat(e.lngLat)
      .setHTML(`${f.properties.lsoa_code} · combined ${f.properties._combined.toFixed(0)}`)
      .addTo(map);
  });
  map.on("mouseleave", "lsoa-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });

  map.on("draw.create", onDrawChange);
  map.on("draw.update", onDrawChange);
  map.on("draw.delete", () => {
    lastDrawnPolygon = null;
    document.getElementById("report").innerHTML =
      `<p class="empty">No site selected yet.</p>`;
  });
}

// ---- Legend ---------------------------------------------------------------

function buildLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = `
    <div class="title">Combined score</div>
    <div class="ramp">${RAMP.map(c => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="scale"><span>0 least</span><span>100 most</span></div>`;
}

// ---- Boot -----------------------------------------------------------------

buildSliders();
buildLegend();

map.on("load", async () => {
  try {
    await loadData();
    wireInteractions();
  } catch (err) {
    document.getElementById("datasource").className = "datasource warn";
    document.getElementById("datasource").textContent =
      "Could not load data: " + err.message +
      " — run the pipeline or sample-data script first.";
    console.error(err);
  }
});
