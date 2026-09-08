/*
 * layoutgen.js — generative residential layout tool.
 *
 * Loaded on demand (dynamic import from the compile-plots modal), never on the
 * main page. Given the compiled site polygon it evolves real layouts — road
 * corridors with pavements, individual house plots with gardens, apartment
 * blocks, pocket greens — and scores each against the chosen objective:
 *   target   hit a chosen net density while keeping the mix and green space
 *   max      greatest capacity subject to the mix (±) and amenity floors
 *   profit   greatest profit on cost (excl. land), letting value density fight
 *            build + road cost — the viability assessment made spatial
 *
 * Geometry is deliberately planar: the site is projected once into local
 * metres, road corridors are exact rectangles (straight streets need no
 * geodesic buffering), and blocks come from polygon-clipping booleans
 * (turf.difference / intersect are planar under the hood, so metre coords are
 * fine). Houses are placed plot by plot along block frontages, garden depth
 * guaranteed by construction from the amenity dial. It is a capacity and
 * massing study, not an engineering drawing — visibility splays, drainage and
 * levels are the next profession's job, and the footer says so.
 *
 * Genome per candidate: street orientation, street phase offset, spine
 * position, block-corner nibble tolerance. Evolution: elitism + gaussian
 * mutation + fresh immigrants, one generation per tick while running.
 */

const ROAD_W = 5.5;          // carriageway
const PAVE_W = 2.0;          // each side
const CORRIDOR = ROAD_W + 2 * PAVE_W;
const HOUSE_DEPTH = 9.5;     // built footprint depth
const FRONT_SETBACK = 3.0;
const TYPES = {
  det:  { w: 11.0, m2: 115, label: "Detached",      color: "#e8590c", valMult: 1.05 },
  semi: { w: 6.6,  m2: 92,  label: "Semi-detached", color: "#f59f00", valMult: 1.00 },
  terr: { w: 5.2,  m2: 82,  label: "Terraced",      color: "#fab005", valMult: 0.95 },
  flat: { w: 30.0, m2: 58,  label: "Flats",         color: "#7048e8", valMult: 0.90 },
};
const FLAT_BLOCK = { w: 30, d: 16, storeys: 3, perBlock: 17 }; // ~30x16x3 / 78m² gross

const T = () => window.turf;

// ---- planar helpers --------------------------------------------------------
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++)
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(s / 2);
}
function polyArea(poly) { // geojson Polygon coords
  return poly.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(r), 0);
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = true;
  }
  return inside;
}
function inPoly(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (inRing(x, y, poly[i])) return false;
  return true;
}
function rot(p, c, s) { return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; }
function rotPoly(poly, c, s) { return poly.map(r => r.map(p => rot(p, c, s))); }

function boolOp(op, a, b) { // planar boolean, turf v6/v7 tolerant
  const t = T();
  try { const r = t[op](t.featureCollection([a, b])); if (r !== undefined) return r; } catch (_) {}
  try { return t[op](a, b); } catch (_) { return null; }
}
function flatPolys(feat) {
  if (!feat) return [];
  const g = feat.geometry || feat;
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}
const F = coords => ({ type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: coords } });
const MF = polys => ({ type: "Feature", properties: {},
  geometry: { type: "MultiPolygon", coordinates: polys } });

// ---- candidate generation --------------------------------------------------
function generateCandidate(sitePolys, siteArea, params, genome) {
  const { theta, phase, spineFrac } = genome;
  const c = Math.cos(-theta), s = Math.sin(-theta);
  const ci = Math.cos(theta), si = Math.sin(theta);
  const rPolys = sitePolys.map(p => rotPoly(p, c, s));

  // Plot depth from the amenity dial: garden area ≥ gardenMin at semi width.
  const gardenDepth = Math.max(9, params.gardenMin / TYPES.semi.w);
  const plotDepth = FRONT_SETBACK + HOUSE_DEPTH + gardenDepth;
  const spacing = 2 * plotDepth + CORRIDOR;

  let minX = 1e12, maxX = -1e12, minY = 1e12, maxY = -1e12;
  for (const poly of rPolys) for (const ring of poly) for (const p of ring) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const pad = 5;
  // Horizontal streets in the rotated frame + one perpendicular spine — but a
  // small site earns fewer roads: no cross streets when they'd leave no usable
  // block, no spine on a site too narrow to flank one. A tiny paddock is one
  // block served off the boundary, which is how such sites actually build out.
  const corridors = [];
  if (maxY - minY >= spacing + plotDepth * 0.8)
    for (let y = minY + phase * spacing; y < maxY; y += spacing)
      corridors.push([[[minX - pad, y], [maxX + pad, y], [maxX + pad, y + CORRIDOR],
                       [minX - pad, y + CORRIDOR], [minX - pad, y]]]);
  if (maxX - minX >= 45) {
    const sx = minX + spineFrac * (maxX - minX);
    corridors.push([[[sx, minY - pad], [sx + CORRIDOR, minY - pad],
                     [sx + CORRIDOR, maxY + pad], [sx, maxY + pad], [sx, minY - pad]]]);
  }

  const siteFeat = rPolys.length === 1 ? F(rPolys[0]) : MF(rPolys);
  let roadsInSite = null, blocksFeat = siteFeat;
  if (corridors.length) {
    const corrFeat = MF(corridors);
    roadsInSite = boolOp("intersect", siteFeat, corrFeat);
    const diff = boolOp("difference", siteFeat, corrFeat);
    if (diff) blocksFeat = diff;
  }
  const blocks = flatPolys(blocksFeat).filter(p => polyArea(p) > 250);
  const roadArea = flatPolys(roadsInSite).reduce((a, p) => a + polyArea(p), 0);

  // Unit targets. In target mode the queue stops at the target count; in the
  // max/profit modes it is effectively unbounded and frontage is the limit.
  const targetUnits = params.objective === "target"
    ? Math.max(1, Math.round(params.density * (siteArea / 1e4) * params.netPct / 100))
    : 1e9;
  const mixShares = { flat: params.flatsPct / 100 };
  const hs = 1 - mixShares.flat;
  mixShares.det = hs * params.detPct / 100;
  mixShares.terr = hs * params.terrPct / 100;
  mixShares.semi = Math.max(0, hs - mixShares.det - mixShares.terr);

  const placed = { det: 0, semi: 0, terr: 0, flat: 0 };
  const lots = [], houses = [], flatsBlocks = [];
  let total = 0;
  // Types ordered by how far each is BEHIND its target share, so the mix stays
  // on course — but the placer tries them ALL at a position, because a wide
  // type that never fits (a 30 m flats block on a village plot) must not
  // deadlock the frontage walk.
  const typeOrder = () => Object.keys(mixShares)
    .filter(k => mixShares[k] > 0)
    .sort((a, b) =>
      (mixShares[b] - (total > 0 ? placed[b] / total : 0))
      - (mixShares[a] - (total > 0 ? placed[a] / total : 0)));

  for (const block of blocks) {
    if (total >= targetUnits) break;
    let bMinX = 1e12, bMaxX = -1e12, bMinY = 1e12, bMaxY = -1e12;
    for (const ring of block) for (const p of ring) {
      if (p[0] < bMinX) bMinX = p[0]; if (p[0] > bMaxX) bMaxX = p[0];
      if (p[1] < bMinY) bMinY = p[1]; if (p[1] > bMaxY) bMaxY = p[1];
    }
    // Two frontages: the bottom row faces the street below, the top row the
    // street above. Rows are skipped when the block is too shallow.
    const rows = [];
    if (bMaxY - bMinY >= plotDepth) rows.push({ y0: bMinY, dir: 1 });
    if (bMaxY - bMinY >= 2 * plotDepth) rows.push({ y0: bMaxY, dir: -1 });
    for (const row of rows) {
      let x = bMinX + 0.5;
      while (x < bMaxX - 3 && total < targetUnits) {
        let advanced = false;
        for (const type of typeOrder()) {
          const tw = TYPES[type].w;
          const depth = type === "flat" ? FLAT_BLOCK.d + FRONT_SETBACK + 6 : plotDepth;
          const y0 = row.y0, y1 = row.y0 + row.dir * depth;
          const corners = [[x, y0], [x + tw, y0], [x + tw, y1], [x, y1],
                           [x + tw / 2, (y0 + y1) / 2]];
          if (!corners.every(p => inPoly(p[0], p[1], block))) continue;
          const fy0 = row.y0 + row.dir * FRONT_SETBACK;
          const fy1 = fy0 + row.dir * (type === "flat" ? FLAT_BLOCK.d : HOUSE_DEPTH);
          const plotRect = [[x, y0], [x + tw, y0], [x + tw, y1], [x, y1], [x, y0]];
          const bldRect = [[x + 0.6, fy0], [x + tw - 0.6, fy0], [x + tw - 0.6, fy1],
                           [x + 0.6, fy1], [x + 0.6, fy0]];
          if (type === "flat") {
            flatsBlocks.push({ plot: plotRect, bld: bldRect });
            placed.flat += FLAT_BLOCK.perBlock;
            total += FLAT_BLOCK.perBlock;
          } else {
            lots.push({ plot: plotRect, type });
            houses.push({ bld: bldRect, type });
            placed[type] += 1;
            total += 1;
          }
          x += tw;
          advanced = true;
          break;
        }
        if (!advanced) x += 1.5;
      }
    }
  }

  const lotArea = lots.reduce((a, l) => a + ringArea(l.plot), 0)
    + flatsBlocks.reduce((a, l) => a + ringArea(l.plot), 0);
  const greenArea = Math.max(0, siteArea - roadArea - lotArea);

  // Rotate everything back to true orientation for display.
  const back = poly => rotPoly(poly, ci, si);
  return {
    genome,
    roads: flatPolys(roadsInSite).map(back),
    blocks: blocks.map(back),
    lots: lots.map(l => ({ type: l.type, plot: back([l.plot])[0] })),
    houses: houses.map(h => ({ type: h.type, bld: back([h.bld])[0] })),
    flats: flatsBlocks.map(f => ({ plot: back([f.plot])[0], bld: back([f.bld])[0] })),
    stats: statsFor({ placed, total, roadArea, greenArea, siteArea, params }),
  };
}

function statsFor({ placed, total, roadArea, greenArea, siteArea, params }) {
  const siteHa = siteArea / 1e4;
  const houseUnits = placed.det + placed.semi + placed.terr;
  const mix = total > 0 ? {
    flat: placed.flat / total, det: placed.det / total,
    semi: placed.semi / total, terr: placed.terr / total } : { flat: 0, det: 0, semi: 0, terr: 0 };
  const wantFlat = params.flatsPct / 100;
  const hs = 1 - wantFlat;
  const mixDev = Math.abs(mix.flat - wantFlat)
    + Math.abs(mix.det - hs * params.detPct / 100)
    + Math.abs(mix.terr - hs * params.terrPct / 100);
  const greenPct = greenArea / siteArea;

  // Layout-relative economics, excl. land: value follows the mix, cost follows
  // floorspace + the roads actually drawn. Indicative, for ranking layouts.
  let gdv = 0, build = 0;
  const psm = (params.ppm2 || 3500) * ((params.assumptions.salesAdjPct || 100) / 100);
  const costH = (params.assumptions.buildPm2House || 1800) * (params.assumptions.costIndexFactor || 1);
  const costF = (params.assumptions.buildPm2Flat || 2100) * (params.assumptions.costIndexFactor || 1);
  for (const k of ["det", "semi", "terr"]) {
    gdv += placed[k] * TYPES[k].m2 * psm * TYPES[k].valMult;
    build += placed[k] * TYPES[k].m2 * costH;
  }
  gdv += placed.flat * TYPES.flat.m2 * psm * TYPES.flat.valMult;
  build += placed.flat * TYPES.flat.m2 * costF;
  const roads = roadArea * 95;                       // £/m² road + drainage
  const perPlot = ((params.assumptions.sitePrepPerPlot || 0)
    + (params.assumptions.infraPerPlot || 0)) * 1000 * total;
  const cost = (build + roads + perPlot) * 1.14;     // fees + contingency tone
  const poc = cost > 0 ? (gdv - cost) / cost * 100 : 0;

  const density = siteHa > 0 ? total / siteHa : 0;   // GROSS density here
  return { total, placed, mix, mixDev, density, greenPct, greenArea,
           roadArea, poc, gdv, cost, houseUnits };
}

function scoreOf(st, params) {
  const greenFloor = params.greenPct / 100;
  const greenPen = Math.max(0, greenFloor - st.greenPct) * 400;
  const mixPen = st.mixDev * 120;
  if (params.objective === "target") {
    const targetGross = params.density * params.netPct / 100;
    return 1000 - Math.abs(st.density - targetGross) * 14 - mixPen - greenPen;
  }
  if (params.objective === "profit")
    return st.poc * 8 - mixPen - greenPen;
  return st.total - mixPen * 2 - greenPen * 2;       // max capacity
}

// ---- SVG rendering ---------------------------------------------------------
function svgOf(cand, sitePolys, w, h, detail) {
  let minX = 1e12, maxX = -1e12, minY = 1e12, maxY = -1e12;
  for (const poly of sitePolys) for (const ring of poly) for (const p of ring) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const pad = detail ? 14 : 4;
  const sc = Math.min((w - 2 * pad) / Math.max(1, maxX - minX),
                      (h - 2 * pad) / Math.max(1, maxY - minY));
  const X = x => pad + (x - minX) * sc;
  const Y = y => h - pad - (y - minY) * sc;
  const path = poly => poly.map(ring =>
    "M" + ring.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L") + "Z").join("");
  let out = "";
  // green ground under everything
  out += sitePolys.map(p => `<path d="${path(p)}" fill="#b2f2bb" stroke="none" fill-rule="evenodd"/>`).join("");
  // pavement halo then carriageway
  out += cand.roads.map(p => `<path d="${path(p)}" fill="#ced4da" fill-rule="evenodd"/>`).join("");
  // plots (gardens) + buildings
  for (const l of cand.lots)
    out += `<path d="${path([l.plot])}" fill="#d3f9d8" stroke="#8ce99a" stroke-width="${detail ? 0.7 : 0.3}"/>`;
  for (const f of cand.flats)
    out += `<path d="${path([f.plot])}" fill="#e5dbff" stroke="#b197fc" stroke-width="${detail ? 0.7 : 0.3}"/>`;
  for (const hset of cand.houses)
    out += `<path d="${path([hset.bld])}" fill="${TYPES[hset.type].color}"/>`;
  for (const f of cand.flats)
    out += `<path d="${path([f.bld])}" fill="${TYPES.flat.color}"/>`;
  out += sitePolys.map(p => `<path d="${path(p)}" fill="none" stroke="#212529" stroke-width="${detail ? 1.6 : 0.8}" fill-rule="evenodd"/>`).join("");
  if (detail) {
    const bar = 50 * sc;
    out += `<line x1="${pad}" y1="${h - 6}" x2="${pad + bar}" y2="${h - 6}" stroke="#212529" stroke-width="2"/>
      <text x="${pad + bar + 5}" y="${h - 3}" font-size="10" fill="#495057">50 m</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}

// ---- the tool --------------------------------------------------------------
export function openLayoutGen(ctx) {
  const t = T();
  if (!t) { alert("Geometry library not loaded yet — try again in a moment."); return; }

  // Project the site to local metres once.
  const g = ctx.site.geometry;
  const polys4326 = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let lat0 = 0, n = 0;
  for (const poly of polys4326) for (const p of poly[0]) { lat0 += p[1]; n++; }
  lat0 /= Math.max(1, n);
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let x0 = 1e12, y0 = 1e12;
  for (const poly of polys4326) for (const p of poly[0]) {
    x0 = Math.min(x0, p[0] * kx); y0 = Math.min(y0, p[1] * ky);
  }
  const sitePolys = polys4326.map(poly =>
    poly.map(ring => ring.map(p => [p[0] * kx - x0, p[1] * ky - y0])));
  const siteArea = sitePolys.reduce((a, p) => a + polyArea(p), 0);
  const siteHa = siteArea / 1e4;

  const params = {
    objective: "target",
    density: ctx.density || 35, netPct: ctx.netPct || 80,
    flatsPct: Math.round((ctx.assumptions.flatMixPct ?? 20)),
    detPct: 30, terrPct: 20,           // shares of the HOUSE portion
    gardenMin: 60, greenPct: 10,
    ppm2: ctx.ppm2, assumptions: ctx.assumptions || {},
  };

  const POP = 12;
  let pop = [], gen = 0, best = null, bestHist = [], running = false, timer = null;
  let focusIdx = null;

  const randGenome = () => ({
    theta: Math.random() * Math.PI,
    phase: Math.random(),
    spineFrac: 0.15 + Math.random() * 0.7,
  });
  const mutate = (gnm) => ({
    theta: (gnm.theta + (Math.random() - 0.5) * 0.35 + Math.PI) % Math.PI,
    phase: Math.min(0.99, Math.max(0, gnm.phase + (Math.random() - 0.5) * 0.3)),
    spineFrac: Math.min(0.85, Math.max(0.15, gnm.spineFrac + (Math.random() - 0.5) * 0.25)),
  });
  const build = gnm => {
    try { return generateCandidate(sitePolys, siteArea, params, gnm); }
    catch (e) { return null; }
  };
  const resetPop = () => {
    pop = [];
    for (let i = 0; i < POP; i++) { const cnd = build(randGenome()); if (cnd) pop.push(cnd); }
    gen = 0; best = null; bestHist = []; focusIdx = null;
    stepAndRender();
  };
  const step = () => {
    pop.sort((a, b) => scoreOf(b.stats, params) - scoreOf(a.stats, params));
    const elite = pop.slice(0, 4);
    const next = [...elite];
    while (next.length < POP) {
      const parent = elite[Math.floor(Math.random() * elite.length)];
      const gnm = Math.random() < 0.15 ? randGenome() : mutate(parent.genome);
      const cnd = build(gnm);
      if (cnd) next.push(cnd); else next.push(parent);
    }
    pop = next;
    pop.sort((a, b) => scoreOf(b.stats, params) - scoreOf(a.stats, params));
    if (!best || scoreOf(pop[0].stats, params) > scoreOf(best.stats, params)) best = pop[0];
    bestHist.push(scoreOf(best.stats, params));
    gen++;
  };

  // ---- DOM -----------------------------------------------------------------
  let m = document.getElementById("lg-modal");
  if (!m) { m = document.createElement("div"); m.id = "lg-modal"; document.body.appendChild(m); }
  const mixLbl = st => [
    st.placed.det ? `${st.placed.det} det` : null,
    st.placed.semi ? `${st.placed.semi} semi` : null,
    st.placed.terr ? `${st.placed.terr} terr` : null,
    st.placed.flat ? `${st.placed.flat} flats` : null].filter(Boolean).join(" · ");

  m.innerHTML = `
    <div class="lg-card">
      <div class="lg-head">
        <div><span class="cm-kicker">Generative layout · ${siteHa.toFixed(2)} ha</span>
          <h3>${(ctx.name || "Site layout").replace(/</g, "&lt;")}</h3></div>
        <button type="button" class="dd-close" id="lg-close" aria-label="Close">×</button>
      </div>
      <div class="lg-body">
        <div class="lg-controls">
          <label><span>Objective</span>
            <select id="lg-obj">
              <option value="target">Meet target density</option>
              <option value="max">Maximise capacity</option>
              <option value="profit">Maximise profit on cost</option>
            </select></label>
          <label><span>Target density <b id="lg-dv">${params.density}</b>/net ha</span>
            <input type="range" id="lg-density" min="15" max="120" step="1" value="${params.density}"></label>
          <label><span>Flats <b id="lg-fv">${params.flatsPct}</b>% of homes</span>
            <input type="range" id="lg-flats" min="0" max="80" step="5" value="${params.flatsPct}"></label>
          <label><span>Detached <b id="lg-dtv">${params.detPct}</b>% of houses</span>
            <input type="range" id="lg-det" min="0" max="80" step="5" value="${params.detPct}"></label>
          <label><span>Terraced <b id="lg-tv">${params.terrPct}</b>% of houses</span>
            <input type="range" id="lg-terr" min="0" max="80" step="5" value="${params.terrPct}"></label>
          <label><span>Garden min <b id="lg-gv">${params.gardenMin}</b> m²</span>
            <input type="range" id="lg-garden" min="30" max="150" step="10" value="${params.gardenMin}"></label>
          <label><span>Green space <b id="lg-grv">${params.greenPct}</b>% floor</span>
            <input type="range" id="lg-green" min="0" max="30" step="2" value="${params.greenPct}"></label>
          <button type="button" id="lg-run" class="plot-mode-btn">▶ Evolve</button>
          <div class="lg-gen">gen <b id="lg-gen">0</b></div>
          <canvas id="lg-spark" width="170" height="34"></canvas>
          <p class="lg-note">Capacity & massing study — plots, roads and greens are
            generated to best practice tones (garden depth from the amenity dial,
            5.5 m carriageway + 2 m footways). Not an engineering layout.</p>
        </div>
        <div class="lg-grid" id="lg-grid"></div>
        <div class="lg-best">
          <div id="lg-best-svg"></div>
          <div id="lg-best-stats"></div>
          <div class="lg-legend">
            <span><i style="background:${TYPES.det.color}"></i>det</span>
            <span><i style="background:${TYPES.semi.color}"></i>semi</span>
            <span><i style="background:${TYPES.terr.color}"></i>terr</span>
            <span><i style="background:${TYPES.flat.color}"></i>flats</span>
            <span><i style="background:#d3f9d8;border:1px solid #8ce99a"></i>garden</span>
            <span><i style="background:#b2f2bb"></i>green</span>
            <span><i style="background:#ced4da"></i>road</span>
          </div>
        </div>
      </div>
    </div>`;

  const render = () => {
    const grid = m.querySelector("#lg-grid");
    grid.innerHTML = pop.map((cnd, i) => `
      <div class="lg-cell${i === 0 && focusIdx == null ? " lg-top" : ""}${focusIdx === i ? " lg-top" : ""}" data-i="${i}">
        ${svgOf(cnd, sitePolys, 150, 128, false)}
        <span>${cnd.stats.total} · ${cnd.stats.density.toFixed(0)}/ha${params.objective === "profit" ? " · " + cnd.stats.poc.toFixed(0) + "%" : ""}</span>
      </div>`).join("");
    grid.querySelectorAll(".lg-cell").forEach(cell =>
      cell.addEventListener("click", () => { focusIdx = +cell.dataset.i; render(); }));
    const show = focusIdx != null ? pop[focusIdx] : (best || pop[0]);
    if (show) {
      m.querySelector("#lg-best-svg").innerHTML = svgOf(show, sitePolys, 430, 380, true);
      const st = show.stats;
      const cell = (v, l) => `<div class="cm-cell"><b>${v}</b><span>${l}</span></div>`;
      m.querySelector("#lg-best-stats").innerHTML = `<div class="cm-grid">`
        + cell(st.total.toLocaleString(), "dwellings")
        + cell(st.density.toFixed(1) + "/ha", "gross density")
        + cell((st.greenPct * 100).toFixed(0) + "%", "green space")
        + cell(st.poc.toFixed(0) + "%", "PoC (excl. land)")
        + `</div><p class="lg-mix">${mixLbl(st)}</p>`;
    }
    m.querySelector("#lg-gen").textContent = gen;
    const cv = m.querySelector("#lg-spark");
    if (cv && bestHist.length > 1) {
      const c2 = cv.getContext("2d");
      c2.clearRect(0, 0, cv.width, cv.height);
      const mn = Math.min(...bestHist), mx = Math.max(...bestHist);
      c2.strokeStyle = "#4c6ef5"; c2.lineWidth = 1.5; c2.beginPath();
      bestHist.forEach((v, i) => {
        const x = i / (bestHist.length - 1) * (cv.width - 4) + 2;
        const y = cv.height - 3 - (mx > mn ? (v - mn) / (mx - mn) : 0.5) * (cv.height - 6);
        i ? c2.lineTo(x, y) : c2.moveTo(x, y);
      });
      c2.stroke();
    }
  };
  const stepAndRender = () => { step(); render(); };

  const setRunning = on => {
    running = on;
    m.querySelector("#lg-run").textContent = on ? "❚❚ Pause" : "▶ Evolve";
    m.querySelector("#lg-run").classList.toggle("active", on);
    if (timer) { clearInterval(timer); timer = null; }
    if (on) timer = setInterval(stepAndRender, 380);
  };

  const slider = (id, key, lbl) => {
    const el = m.querySelector(id);
    el.addEventListener("input", () => {
      params[key] = Number(el.value);
      m.querySelector(lbl).textContent = el.value;
      resetPop();
    });
  };
  slider("#lg-density", "density", "#lg-dv");
  slider("#lg-flats", "flatsPct", "#lg-fv");
  slider("#lg-det", "detPct", "#lg-dtv");
  slider("#lg-terr", "terrPct", "#lg-tv");
  slider("#lg-garden", "gardenMin", "#lg-gv");
  slider("#lg-green", "greenPct", "#lg-grv");
  m.querySelector("#lg-obj").addEventListener("change", e => {
    params.objective = e.target.value; resetPop();
  });
  m.querySelector("#lg-run").addEventListener("click", () => setRunning(!running));
  m.querySelector("#lg-close").addEventListener("click", () => { setRunning(false); m.hidden = true; });
  m.addEventListener("click", e => { if (e.target === m) { setRunning(false); m.hidden = true; } });

  m.hidden = false;
  resetPop();
  setRunning(true);
}
