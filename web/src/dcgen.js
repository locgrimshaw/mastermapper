// MasterMapper — generative data-centre campus layout tool.
// Same evolutionary premise as the residential generator (layoutgen.js): a
// population of candidate layouts, geometry in local metres, scored against
// the chosen objective, mutated toward better campuses; the shown option is
// dressed lazily. Every dimensional constant below is drawn from 2024-26
// benchmarks gathered for this tool:
//
//  - Gross building area per MW IT: air-cooled ≈700 m² GEA/MW (QTS Cambois
//    750, Abbots Langley 875, Park Royal 536 — DCD/Baxtel 2025-26; RICS
//    2,500-4,000 W/m² white space norm), liquid-cooled AI ≈500 m² GEA/MW.
//  - Halls 2-3 storeys is the UK trend (QTS Cambois 3-storey, Park Royal 3
//    hall floors + roof plant, 2025-26); 20 m plant/generator yard along each
//    long elevation (scheme drawings, Arup CFD spacing guidance 2025).
//  - Hall-to-hall separation ~30 m (two yards + fire access); full-perimeter
//    7.3 m loop road (ADB B5 pump access within 45 m).
//  - Substation ≈1.2 ha per 100 MW grid demand plus 50% expansion reserve
//    (RSP Engineers 2025).
//  - Security: 20 m fence-to-building minimum; UK consents lean on landscape
//    buffers — 30-50% of a greenfield site as landscape/BNG (Abbots Langley
//    21 ha country park; GOV.UK NSIP BNG statement for data centres, 2025).
//  - SuDS attenuation 3-5% of site; gatehouse ~10×7 m at the single entrance
//    (Bridgend VDC CWL4, 2025); campuses run ~30-80 FTE.
//  - Design PUE 1.2-1.4 for new UK builds (Uptime 2025); capex ≈£11M/MW IT
//    conventional, £16-22M/MW AI-optimised (Turner & Townsend DCCI 2025-26).

import { prepareSite, _geom } from "./layoutgen.js";

const { mulberry32, ringArea, inRing, inAnyPoly, ribbon, circlePoly,
        polylineLen, distToBoundary, boolOp, flatPolys, MF, fetchTerrain } = _geom;

const T = () => window.turf;

const HALLS = {
  S: { w: 92,  d: 46, label: "S · 92×46 m" },
  M: { w: 130, d: 60, label: "M · 130×60 m" },
  L: { w: 200, d: 85, label: "L · 200×85 m" },
};
const YARD = 20;          // plant/generator apron along each long elevation
const ROAD_W = 7.3;       // fire/service loop carriageway
const ROAD_COR = 11.3;    // corridor incl verges
const COOLING = {
  air:    { m2PerMw: 700, label: "air-cooled",       pue: 1.30 },
  liquid: { m2PerMw: 500, label: "liquid-cooled AI", pue: 1.18 },
};

const rot = (x, y, c, s) => [x * c - y * s, x * s + y * c];

function svgEsc(s) { return String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }

// A rotated rectangle as a closed ring, from centre, half-extents and angle.
function rectRing(cx, cy, hw, hd, c, s) {
  const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    .map(([x, y]) => { const [rx, ry] = rot(x, y, c, s); return [cx + rx, cy + ry]; });
  pts.push(pts[0].slice());
  return pts;
}

function rectOK(ring, site, setback, extraRings) {
  // every edge sampled ≈6 m; setback measured to the site boundary
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / 6));
    for (let t2 = 0; t2 <= n; t2++) {
      const px = a[0] + (b[0] - a[0]) * t2 / n, py = a[1] + (b[1] - a[1]) * t2 / n;
      if (!site.inSite(px, py) || site.inExcl(px, py)) return false;
      if (setback > 0 && distToBoundary(px, py, site.allRings) < setback) return false;
    }
  }
  const cx = (ring[0][0] + ring[2][0]) / 2, cy = (ring[0][1] + ring[2][1]) / 2;
  if (!site.inSite(cx, cy) || site.inExcl(cx, cy)) return false;
  for (const r2 of extraRings || []) {
    for (let i = 0; i < 4; i++) if (inRing(ring[i][0], ring[i][1], r2)) return false;
    for (let i = 0; i < 4; i++) if (inRing(r2[i][0], r2[i][1], ring)) return false;
    if (inRing(cx, cy, r2)) return false;
  }
  return true;
}

// ---- one candidate campus ---------------------------------------------------
function generateCampus(site, params, genome) {
  const rnd = mulberry32(genome.seed);
  const hall = HALLS[params.hallSize] || HALLS.M;
  const cool = COOLING[params.cooling] || COOLING.air;
  const mwPerHall = hall.w * hall.d * params.storeys / cool.m2PerMw;
  const targetMw = params.objective === "target" ? params.targetMw : 1e9;
  const c = Math.cos(genome.theta), s = Math.sin(genome.theta);
  const setback = params.setback;

  // hall + yard envelope per slot (yards on both long elevations)
  const envD = hall.d / 2 + YARD;
  const pitchX = hall.w + 28;                       // fire gap + column road
  const pitchY = hall.d + 2 * YARD + ROAD_COR;      // yards + shared loop lane

  // lattice centred on the site centroid, offset by the genome
  const mainC = site.parts[0].centroid;
  const ox = mainC[0] + genome.ox, oy = mainC[1] + genome.oy;
  const halls = [];
  const span = Math.ceil(site.diag / Math.min(pitchX, pitchY)) + 1;
  const slots = [];
  for (let gx = -span; gx <= span; gx++)
    for (let gy = -span; gy <= span; gy++) {
      const [lx, ly] = rot(gx * pitchX, gy * pitchY, c, s);
      slots.push({ gx, gy, x: ox + lx, y: oy + ly,
                   d2: gx * gx * pitchX * pitchX + gy * gy * pitchY * pitchY });
    }
  slots.sort((a, b) => a.d2 - b.d2);
  const placedRings = [];   // hall+yard envelopes for overlap tests
  let itMw = 0;
  for (const sl of slots) {
    if (itMw >= targetMw) break;
    const env = rectRing(sl.x, sl.y, hall.w / 2 + 4, envD + 1, c, s);
    if (!rectOK(env, site, setback, placedRings)) continue;
    halls.push({ x: sl.x, y: sl.y, gx: sl.gx, gy: sl.gy,
                 ring: rectRing(sl.x, sl.y, hall.w / 2, hall.d / 2, c, s),
                 env, mw: mwPerHall });
    placedRings.push(env);
    itMw += mwPerHall;
  }
  if (!halls.length) return null;

  // substation sized to grid demand (1.2 ha / 100 MW × 1.5 reserve)
  const gridMw = itMw * params.pue;
  const subSide = Math.sqrt(gridMw / 100 * 12000 * 1.5);
  let sub = null;
  {
    const tries = [];
    const offD = envD + subSide / 2 + ROAD_COR;
    const offW = hall.w / 2 + 6 + subSide / 2 + ROAD_COR;
    for (const h of halls)
      for (const [lx, ly] of [[0, offD], [0, -offD], [offW, 0], [-offW, 0]]) {
        const [rx, ry] = rot(lx, ly, c, s);
        tries.push([h.x + rx, h.y + ry]);
      }
    // genome nudges which candidate position wins
    for (let i = 0; i < tries.length; i++) {
      const k = (i + genome.sub) % tries.length;
      const ring = rectRing(tries[k][0], tries[k][1], subSide / 2, subSide / 2, c, s);
      if (rectOK(ring, site, Math.max(8, setback * 0.6), placedRings)) {
        sub = { x: tries[k][0], y: tries[k][1], side: subSide, ring };
        placedRings.push(ring);
        break;
      }
    }
  }

  // entrance on the boundary, gatehouse + parking just inside
  const bnd = site.parts[0].boundary;
  const E = bnd[Math.floor(genome.tE * bnd.length) % bnd.length];
  // walk inward: direction toward the nearest hall
  let near = halls[0];
  for (const h of halls) if (Math.hypot(h.x - E[0], h.y - E[1]) < Math.hypot(near.x - E[0], near.y - E[1])) near = h;
  const eL = Math.hypot(near.x - E[0], near.y - E[1]) || 1;
  const ex = (near.x - E[0]) / eL, ey = (near.y - E[1]) / eL;
  const gate = rectRing(E[0] + ex * 16, E[1] + ey * 16, 5, 3.5, ex, ey);
  let park = null;
  {
    const spaces = Math.max(40, Math.round(itMw * 0.5));
    const pw = 34, pd = Math.min(70, 12 + spaces / 4 * 2.6);
    for (const off of [26, 40, 58]) {
      const px = E[0] + ex * (off + pd / 2), py = E[1] + ey * (off + pd / 2);
      const pr = rectRing(px + ey * (pw / 2 + 8), py - ex * (pw / 2 + 8), pw / 2, pd / 2, ex, ey);
      if (rectOK(pr, site, 4, placedRings)) { park = { ring: pr, spaces }; placedRings.push(pr); break; }
    }
  }

  // roads: loop rectangle around the hall cluster + row lanes + entrance spur
  const roads = [];
  {
    // cluster bounds in lattice frame
    let x0 = 1e12, x1 = -1e12, y0 = 1e12, y1 = -1e12;
    for (const h of halls) {
      x0 = Math.min(x0, h.gx); x1 = Math.max(x1, h.gx);
      y0 = Math.min(y0, h.gy); y1 = Math.max(y1, h.gy);
    }
    const fx0 = x0 * pitchX - hall.w / 2 - 12, fx1 = x1 * pitchX + hall.w / 2 + 12;
    const fy0 = y0 * pitchY - envD - ROAD_COR / 2, fy1 = y1 * pitchY + envD + ROAD_COR / 2;
    const W = (lx, ly) => { const [rx, ry] = rot(lx, ly, c, s); return [ox + rx, oy + ry]; };
    // clip to the site, SPLITTING into runs at every gap — otherwise the
    // ribbon would bridge straight across a notch outside the boundary
    const clipRuns = pts => {
      const runs = [];
      let cur = [];
      for (const p of pts) {
        if (site.inSite(p[0], p[1])) cur.push(p);
        else if (cur.length) { runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      return runs.filter(r2 => r2.length > 3);
    };
    const seg = (a, b) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(2, Math.ceil(L / 5));
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
      return pts;
    };
    const loop = [...seg(W(fx0, fy0), W(fx1, fy0)), ...seg(W(fx1, fy0), W(fx1, fy1)),
                  ...seg(W(fx1, fy1), W(fx0, fy1)), ...seg(W(fx0, fy1), W(fx0, fy0))];
    const loopRuns = clipRuns(loop);
    for (const r2 of loopRuns) roads.push({ pts: r2, loop: true });
    // a lane between each pair of used rows
    const rows = [...new Set(halls.map(h => h.gy))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < rows.length; i++) {
      const midY = (rows[i] * pitchY + rows[i + 1] * pitchY) / 2;
      for (const r2 of clipRuns(seg(W(fx0, midY), W(fx1, midY)))) roads.push({ pts: r2 });
    }
    // entrance spur to the nearest point of any loop run
    let best = null, bd = 1e12;
    for (const r2 of loopRuns) for (const p of r2) {
      const d = Math.hypot(p[0] - E[0], p[1] - E[1]);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) for (const r2 of clipRuns(seg(E, best))) roads.push({ pts: r2 });
  }
  let roadArea = 0;
  const roadPolys = roads.map(r => { const rb = ribbon(r.pts, ROAD_COR / 2); if (rb) roadArea += ringArea(rb[0]); return rb; }).filter(Boolean);

  // ---- stats ---------------------------------------------------------------
  const footprint = halls.length * hall.w * hall.d;
  const yards = halls.length * hall.w * YARD * 2;
  const gea = footprint * params.storeys;
  const subArea = sub ? sub.side * sub.side : 0;
  const developed = footprint + yards + roadArea + subArea + (park ? ringArea(park.ring) : 0);
  const greenPct = Math.max(0, 1 - developed / site.areaM2);
  const capex = itMw * params.costPerMw;
  const value = itMw * params.valuePerMw;
  const margin = capex > 0 ? (value - capex) / capex * 100 : 0;
  const fenceLen = site.allRings.reduce((a2, r2) => a2 + polylineLen(r2), 0);
  const stats = {
    itMw, gridMw, halls: halls.length, mwPerHall, gea,
    coverage: footprint / site.areaM2 * 100,
    mwHa: itMw / (site.areaM2 / 1e4),
    greenPct: greenPct * 100, roadArea, subArea, subOk: !!sub,
    parking: park ? park.spaces : 0, fenceLen,
    capex, value, margin,
    fuelM3: Math.round(gridMw * 250 * 48 / 1000),   // 48 h @ 250 L/MW/h
  };
  return { genome, halls, hall, sub, gate, park, roads, roadPolys, stats,
           E, dir: [ex, ey], theta: genome.theta, pond: null, trees: [] };
}

function scoreOf(st, params) {
  const greenPen = Math.max(0, params.greenPct - st.greenPct) * 30;
  const subPen = st.subOk ? 0 : 400;
  if (params.objective === "target")
    return 1000 - Math.abs(st.itMw - params.targetMw) * 4 - greenPen - subPen;
  if (params.objective === "value") return st.margin * 6 + st.itMw - greenPen - subPen;
  return st.itMw * 2 - greenPen - subPen;
}

// pond + buffer trees, display-only
function decorate(cand, site) {
  if (cand._dec) return cand;
  cand._dec = true;
  const rnd = mulberry32((cand.genome.seed ^ 0x77aa11) >>> 0);
  const blocked = (x, y) => {
    for (const h of cand.halls) if (inRing(x, y, h.env)) return true;
    if (cand.sub && inRing(x, y, cand.sub.ring)) return true;
    if (cand.park && inRing(x, y, cand.park.ring)) return true;
    for (const rp of cand.roadPolys) if (inRing(x, y, rp[0])) return true;
    return false;
  };
  // SuDS attenuation in the clearest pocket (~4% of site, research: 3-5%)
  let bx = null, bd2 = -1;
  for (let gx = site.minX + 12; gx < site.maxX; gx += 16)
    for (let gy = site.minY + 12; gy < site.maxY; gy += 16) {
      if (!site.inSite(gx, gy) || site.inExcl(gx, gy) || blocked(gx, gy)) continue;
      let d = distToBoundary(gx, gy, site.allRings);
      for (const h of cand.halls) d = Math.min(d, Math.hypot(gx - h.x, gy - h.y) - hallRad(cand));
      if (cand.sub) d = Math.min(d, Math.hypot(gx - cand.sub.x, gy - cand.sub.y) - cand.sub.side * 0.71);
      if (cand.park) {
        const pc = cand.park.ring;
        d = Math.min(d, Math.hypot(gx - (pc[0][0] + pc[2][0]) / 2, gy - (pc[0][1] + pc[2][1]) / 2) - 24);
      }
      if (d > bd2) { bd2 = d; bx = [gx, gy]; }
    }
  if (bx && bd2 > 14) {
    const r = Math.min(bd2 - 4, Math.sqrt(site.areaM2 * 0.04 / Math.PI));
    const ring = [];
    for (let i = 0; i <= 24; i++) {
      const a2 = i / 24 * 2 * Math.PI;
      ring.push([bx[0] + r * (1 + 0.12 * Math.sin(a2 * 3)) * Math.cos(a2),
                 bx[1] + r * 0.7 * (1 + 0.12 * Math.sin(a2 * 3 + 1)) * Math.sin(a2)]);
    }
    cand.pond = [ring];
  }
  // landscape-buffer tree belts inside the setback
  const trees = [];
  for (const part of site.parts) {
    const bpts = part.boundary;
    for (let i = 0; i < bpts.length; i += 3) {
      const p = bpts[i];
      for (const inset of [6, 13]) {
        const px = p[0] + (part.centroid[0] - p[0]) / Math.max(1, Math.hypot(part.centroid[0] - p[0], part.centroid[1] - p[1])) * (inset + rnd() * 4);
        const py = p[1] + (part.centroid[1] - p[1]) / Math.max(1, Math.hypot(part.centroid[0] - p[0], part.centroid[1] - p[1])) * (inset + rnd() * 4);
        if (site.inSite(px, py) && !blocked(px, py) && rnd() < 0.6) trees.push([px, py]);
      }
    }
  }
  cand.trees = trees;
  return cand;
}
function hallRad(cand) { return Math.hypot(cand.hall.w, cand.hall.d) / 2 + YARD; }

// ---- rendering --------------------------------------------------------------
function svgOf(cand, site, w, h, detail) {
  const { minX, maxX, minY, maxY } = site;
  const pad = detail ? 14 : 4;
  const sc = Math.min((w - 2 * pad) / Math.max(1, maxX - minX),
                      (h - 2 * pad) / Math.max(1, maxY - minY));
  const X = x => pad + (x - minX) * sc;
  const Y = y => h - pad - (y - minY) * sc;
  const path = poly => poly.map(ring =>
    "M" + ring.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L") + "Z").join("");
  let out = "";
  out += site.polys.map(p => `<path d="${path(p)}" fill="#d5e6d0" fill-rule="evenodd"/>`).join("");
  for (const ex of site.exclusionPolys || [])
    out += `<path d="${path(ex)}" fill="rgba(224,49,49,0.16)" stroke="#e03131" stroke-width="${detail ? 1 : 0.4}" stroke-dasharray="4 3" fill-rule="evenodd"/>`;
  for (const rp of cand.roadPolys)
    out += `<path d="${path(rp)}" fill="#c4cad1"/>`;
  if (cand.pond)
    out += `<path d="${path(cand.pond)}" fill="#74c0fc" stroke="#4dabf7" stroke-width="1"/>`;
  if (cand.park) {
    out += `<path d="${path([cand.park.ring])}" fill="#cfd5da" stroke="#adb5bd" stroke-width="0.6"/>`;
  }
  if (cand.sub) {
    out += `<path d="${path([cand.sub.ring])}" fill="#f3d19c" stroke="#a87900" stroke-width="${detail ? 1 : 0.5}"/>`;
    if (detail) {
      const [sx, sy] = [cand.sub.x, cand.sub.y];
      for (let i = -1; i <= 1; i++)
        out += `<circle cx="${X(sx + i * cand.sub.side * 0.22).toFixed(1)}" cy="${Y(sy).toFixed(1)}" r="${(2.6 * sc).toFixed(1)}" fill="#a87900" opacity="0.7"/>`;
      out += `<text x="${X(sx).toFixed(1)}" y="${Y(sy - cand.sub.side / 2 - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#7a5a00">substation ${(cand.stats.subArea / 1e4).toFixed(1)} ha</text>`;
    }
  }
  const c = Math.cos(cand.theta), s = Math.sin(cand.theta);
  for (const hl of cand.halls) {
    // yard aprons then the hall with a roof-plant band
    const yardR = rectRing(hl.x, hl.y, cand.hall.w / 2, cand.hall.d / 2 + YARD, c, s);
    out += `<path d="${path([yardR])}" fill="#ccd3da"/>`;
    if (detail) {
      // generator sets along both long elevations
      for (const sgn of [-1, 1]) {
        for (let i = -2; i <= 2; i++) {
          const [gx2, gy2] = rot(i * cand.hall.w * 0.17, sgn * (cand.hall.d / 2 + YARD * 0.5), c, s);
          out += `<path d="${path([rectRing(hl.x + gx2, hl.y + gy2, 5.5, 3, c, s)])}" fill="#8b95a1"/>`;
        }
      }
    }
    if (detail) {
      const sh = 1.4;
      out += `<path d="${path([hl.ring.map(p => [p[0] + sh, p[1] - sh])])}" fill="rgba(33,37,41,0.3)"/>`;
    }
    out += `<path d="${path([hl.ring])}" fill="#274b6d"${detail ? ` stroke="#ffffff" stroke-width="0.6"` : ""}/>`;
    if (detail) {
      out += `<path d="${path([rectRing(hl.x, hl.y, cand.hall.w / 2 - 6, cand.hall.d * 0.16, c, s)])}" fill="#3e6a94"/>`;
      out += `<text x="${X(hl.x).toFixed(1)}" y="${Y(hl.y).toFixed(1)}" font-size="9" text-anchor="middle" dominant-baseline="middle" fill="#dbe7f3">${hl.mw.toFixed(0)} MW</text>`;
    }
  }
  if (cand.gate)
    out += `<path d="${path([cand.gate])}" fill="#495057"/>`;
  if (detail)
    for (const t2 of cand.trees)
      out += `<circle cx="${X(t2[0]).toFixed(1)}" cy="${Y(t2[1]).toFixed(1)}" r="${(2.1 * sc).toFixed(1)}" fill="#37b24d" opacity="0.7"/>`;
  // security fence on the boundary: solid + inner dashed line
  out += site.polys.map(p => `<path d="${path(p)}" fill="none" stroke="#212529" stroke-width="${detail ? 1.6 : 0.8}" fill-rule="evenodd"/>`).join("");
  out += site.polys.map(p => `<path d="${path(p)}" fill="none" stroke="#495057" stroke-width="${detail ? 0.7 : 0.3}" stroke-dasharray="5 3" fill-rule="evenodd" transform="translate(${(1.5 * sc).toFixed(1)},${(-1.5 * sc).toFixed(1)})"/>`).join("");
  if (detail && site.terrain) {
    for (const seg2 of site.terrain.contours) {
      const mx = (seg2[0][0] + seg2[1][0]) / 2, my = (seg2[0][1] + seg2[1][1]) / 2;
      if (!site.inSite(mx, my)) continue;
      out += `<line x1="${X(seg2[0][0]).toFixed(1)}" y1="${Y(seg2[0][1]).toFixed(1)}" x2="${X(seg2[1][0]).toFixed(1)}" y2="${Y(seg2[1][1]).toFixed(1)}" stroke="rgba(141,110,66,0.35)" stroke-width="0.8"/>`;
    }
  }
  if (detail) {
    const bar = 50 * sc;
    out += `<line x1="${pad}" y1="${h - 6}" x2="${pad + bar}" y2="${h - 6}" stroke="#212529" stroke-width="2"/>
      <text x="${pad + bar + 5}" y="${h - 3}" font-size="10" fill="#495057">50 m</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}

// ---- the tool ---------------------------------------------------------------
let _dcgSession = null;

export function openDcGen(ctx) {
  const t = T();
  if (!t) { alert("Geometry library not loaded yet — try again in a moment."); return; }
  const site = prepareSite(ctx, t);
  if (!site) { alert("Site geometry too small to lay out."); return; }
  const siteHa = site.areaM2 / 1e4;

  const sig = (() => {
    const c2 = JSON.stringify(site._g.coordinates);
    let h2 = 0;
    for (let i = 0; i < c2.length; i += 7) h2 = (h2 * 31 + c2.charCodeAt(i)) | 0;
    return "dc" + h2 + ":" + c2.length;
  })();
  const saved = _dcgSession && _dcgSession.sig === sig ? _dcgSession : null;

  const params = saved ? saved.params : {
    objective: "target",
    targetMw: Math.max(10, Math.round(siteHa * (ctx.netPct || 70) / 100 * (ctx.mwPerHa || 10))),
    cooling: "air", storeys: 2, hallSize: siteHa > 12 ? "L" : siteHa > 5 ? "M" : "S",
    setback: 20, greenPct: 35,
    pue: ctx.pue || 1.25, costPerMw: ctx.costPerMw || 11, valuePerMw: ctx.valuePerMw || 15,
  };
  if (saved) { params.pue = ctx.pue || params.pue; }

  fetchTerrain(site).then(t2 => { site.terrain = t2; render(); })
    .catch(err => console.warn("terrain unavailable", err));

  const POP = 10;
  let pop = [], gen = 0, best = null, bestHist = [], running = false, timer = null, focusIdx = null;
  let sinceUp = 0, genRate = 0;

  const randGenome = () => ({
    theta: Math.random() * Math.PI,
    ox: (Math.random() - 0.5) * site.diag * 0.25,
    oy: (Math.random() - 0.5) * site.diag * 0.25,
    tE: Math.random(), sub: (Math.random() * 12) | 0,
    seed: (Math.random() * 1e9) | 0,
  });
  const mutate = (g2, pw = 1) => ({
    theta: g2.theta + (Math.random() - 0.5) * 0.22 * pw,
    ox: g2.ox + (Math.random() - 0.5) * 24 * pw,
    oy: g2.oy + (Math.random() - 0.5) * 24 * pw,
    tE: Math.random() < 0.08 * pw ? Math.random() : (g2.tE + (Math.random() - 0.5) * 0.1 * pw + 1) % 1,
    sub: Math.random() < 0.2 * pw ? (Math.random() * 12) | 0 : g2.sub,
    seed: Math.random() < 0.3 ? (Math.random() * 1e9) | 0 : g2.seed,
  });
  const gDiff = (a, b) =>
    Math.abs(a.theta - b.theta) * 2 + Math.hypot(a.ox - b.ox, a.oy - b.oy) / 30
    + Math.min(Math.abs(a.tE - b.tE), 1 - Math.abs(a.tE - b.tE)) * 2;
  const build = g2 => { try { return generateCampus(site, params, g2); } catch (_) { return null; } };

  const resetPop = () => {
    if (m && m._fillT) { clearTimeout(m._fillT); m._fillT = null; }
    pop = [];
    for (let i = 0; i < 12 && pop.length < 4; i++) {
      const c2 = build(randGenome()); if (c2) pop.push(c2);
    }
    gen = 0; best = null; bestHist = []; focusIdx = null; sinceUp = 0;
    render();
    const fill = () => {
      m._fillT = null;
      if (running || pop.length >= POP) return;
      const c2 = build(randGenome());
      if (c2) pop.push(c2);
      render();
      if (pop.length < POP) m._fillT = setTimeout(fill, 40);
    };
    m._fillT = setTimeout(fill, 40);
  };

  const step = () => {
    if (!pop.length) return;
    for (const c2 of pop) c2._s = scoreOf(c2.stats, params);
    if (best) best._s = scoreOf(best.stats, params);
    const cands = best && !pop.includes(best) ? [best, ...pop] : pop.slice();
    cands.sort((a, b) => b._s - a._s);
    const elite = [];
    for (const c2 of cands) {
      if (elite.every(e => gDiff(e.genome, c2.genome) > 0.3)) elite.push(c2);
      if (elite.length === 3) break;
    }
    for (const c2 of cands) { if (elite.length === 3) break; if (!elite.includes(c2)) elite.push(c2); }
    const pw = Math.min(3, 1 + sinceUp / 12);
    const next = [...elite];
    let tries = 0;
    if (sinceUp > 0 && sinceUp % 30 === 0)
      while (next.length < POP && tries++ < POP * 3) {
        const c2 = build(randGenome()); if (c2) next.push(c2);
      }
    while (next.length < POP && tries++ < POP * 4) {
      const p1 = elite[(Math.random() * elite.length) | 0];
      const g2 = Math.random() < 0.15 ? randGenome() : mutate(p1.genome, pw);
      const c2 = build(g2);
      next.push(c2 || p1);
    }
    pop = next;
    for (const c2 of pop) c2._s = scoreOf(c2.stats, params);
    pop.sort((a, b) => b._s - a._s);
    if (!best || pop[0]._s > best._s) { best = pop[0]; sinceUp = 0; } else sinceUp++;
    bestHist.push(best._s);
    if (bestHist.length > 700) bestHist = bestHist.filter((_, i) => i % 2 === 0);
    gen++;
  };

  let m = document.getElementById("dcg-modal");
  if (!m) { m = document.createElement("div"); m.id = "dcg-modal"; document.body.appendChild(m); }

  m.innerHTML = `
    <div class="lg-card">
      <div class="lg-head">
        <div><span class="cm-kicker">Generative DC campus · ${siteHa.toFixed(2)} ha</span>
          <h3>${svgEsc(ctx.name || "Data-centre campus")}</h3></div>
        <button type="button" id="dcg-close" class="dd-close" aria-label="Close">×</button>
      </div>
      <div class="lg-body">
        <div class="lg-controls">
          <label><span>Objective</span>
            <select id="dcg-obj">
              <option value="target">Hit target IT load</option>
              <option value="max">Maximise IT load</option>
              <option value="value">Maximise value margin</option>
            </select></label>
          <label><span>Target IT load <b id="dcg-tv">${params.targetMw}</b> MW</span>
            <input type="range" id="dcg-target" min="10" max="${Math.max(60, Math.round(siteHa * 20))}" step="5" value="${params.targetMw}"></label>
          <label><span>Cooling / density</span>
            <select id="dcg-cool">
              <option value="air">Air-cooled · ~700 m² GEA/MW</option>
              <option value="liquid">Liquid-cooled AI · ~500 m² GEA/MW</option>
            </select></label>
          <label><span>Hall storeys <b id="dcg-sv">${params.storeys}</b></span>
            <input type="range" id="dcg-storeys" min="1" max="3" step="1" value="${params.storeys}"></label>
          <label><span>Hall size</span>
            <select id="dcg-hall">
              ${Object.entries(HALLS).map(([k, h2]) => `<option value="${k}">${h2.label}</option>`).join("")}
            </select></label>
          <label><span>Security setback <b id="dcg-bv">${params.setback}</b> m</span>
            <input type="range" id="dcg-setback" min="10" max="50" step="5" value="${params.setback}"></label>
          <label><span>Landscape floor <b id="dcg-gv">${params.greenPct}</b>%</span>
            <input type="range" id="dcg-green" min="15" max="60" step="5" value="${params.greenPct}"></label>
          <label><span>Design PUE <b id="dcg-pv">${params.pue}</b></span>
            <input type="range" id="dcg-pue" min="1.1" max="1.5" step="0.05" value="${params.pue}"></label>
          <button type="button" id="dcg-run" class="plot-mode-btn">▶ Evolve</button>
          <div class="lg-gen">gen <b id="dcg-gen">0</b></div>
          <canvas id="dcg-spark" width="190" height="34"></canvas>
          <button type="button" id="dcg-adopt" class="plot-mode-btn">Adopt into appraisal</button>
          <button type="button" id="dcg-export" class="ghost">Export GeoJSON</button>
          <details class="lg-std"><summary>Benchmarks applied ⓘ</summary>
            <ul>
              <li>Hall GEA per MW: air ≈700 m²/MW, liquid-cooled AI ≈500 m²/MW
                (QTS Cambois 750, Abbots Langley 875, Park Royal 536 — 2025-26
                consents; RICS 2.5-4 kW/m² white-space norm).</li>
              <li>20 m plant/generator aprons on both long elevations; ~30 m
                hall separation; full-perimeter 7.3 m fire loop (ADB B5).</li>
              <li>Substation 1.2 ha / 100 MW grid demand + 50% reserve (RSP
                2025); demand = IT × PUE (Uptime 2025 — design 1.2-1.4).</li>
              <li>Security setback dial (default 20 m fence-to-building);
                landscape/BNG floor default 35% of gross (UK greenfield
                consents run 30-50%; NSIP BNG statement 2025).</li>
              <li>SuDS attenuation ≈4% of site; 48 h fuel @ 250 L/MW/h;
                gatehouse at single controlled entrance; parking ~0.5
                spaces/MW (30-80 FTE campuses).</li>
              <li>Capex/value dials from the compile view (T&amp;T DCCI 2025-26:
                ~£11M/MW conventional, £16-22M/MW AI-fitted).</li>
            </ul>
          </details>
          <p class="lg-note">Capacity &amp; massing study — not an engineering
          design: EIA, noise, connection agreement and utilities follow.</p>
        </div>
        <div id="dcg-grid" class="lg-grid"></div>
        <div class="lg-best">
          <div id="dcg-best-svg"></div>
          <div id="dcg-best-stats"></div>
          <div class="lg-legend">
            <span><i style="background:#274b6d"></i>data hall</span>
            <span><i style="background:#ccd3da"></i>plant yard</span>
            <span><i style="background:#f3d19c"></i>substation</span>
            <span><i style="background:#c4cad1"></i>road</span>
            <span><i style="background:#cfd5da"></i>parking</span>
            <span><i style="background:#74c0fc"></i>SuDS</span>
            <span><i style="background:#d5e6d0"></i>landscape</span>
            <span><i style="background:rgba(224,49,49,0.25);border:1px dashed #e03131"></i>no-build</span>
          </div>
        </div>
      </div>
    </div>`;

  const render = () => {
    const grid = m.querySelector("#dcg-grid");
    grid.innerHTML = pop.map((cnd, i) => `
      <div class="lg-cell${(focusIdx === i || (i === 0 && focusIdx == null)) ? " lg-top" : ""}" data-i="${i}">
        ${cnd._thumb || (cnd._thumb = svgOf(cnd, site, 150, 128, false))}
        <span>${cnd.stats.itMw.toFixed(0)} MW · ${cnd.stats.halls}H${params.objective === "value" ? " · " + cnd.stats.margin.toFixed(0) + "%" : ""}</span>
      </div>`).join("");
    grid.querySelectorAll(".lg-cell").forEach(cell =>
      cell.addEventListener("click", () => { focusIdx = +cell.dataset.i; render(); }));
    const show = focusIdx != null ? pop[focusIdx] : (best || pop[0]);
    window.__dcgShow = show; window.__dcgSite = site;
    if (show) {
      decorate(show, site);
      m.querySelector("#dcg-best-svg").innerHTML = svgOf(show, site, 430, 360, true);
      const st = show.stats;
      const money = v => "£" + (v >= 1000 ? (v / 1000).toFixed(1) + "bn" : v.toFixed(0) + "m");
      const cell = (v, l, cls) => `<div class="cm-cell${cls ? " " + cls : ""}"><b>${v}</b><span>${l}</span></div>`;
      m.querySelector("#dcg-best-stats").innerHTML = `<div class="cm-grid">`
        + cell(st.itMw.toFixed(0) + " MW", "IT load")
        + cell(st.gridMw.toFixed(0) + " MW", `grid demand @ PUE ${params.pue}`)
        + cell(st.halls + " × " + st.mwPerHall.toFixed(0) + " MW", "data halls")
        + cell(Math.round(st.gea).toLocaleString() + " m²", "GEA")
        + cell(st.mwHa.toFixed(1) + " MW/ha", "IT density (gross)")
        + cell(st.coverage.toFixed(0) + "%", "building coverage")
        + cell(st.greenPct.toFixed(0) + "%", "landscape / open")
        + cell(st.subOk ? (st.subArea / 1e4).toFixed(1) + " ha" : "⚠ no fit", "substation", st.subOk ? "" : "cm-sr")
        + cell(st.parking, "parking spaces")
        + cell(money(st.capex), "capex")
        + cell(money(st.value), "stabilised value")
        + cell(st.margin.toFixed(0) + "%", "margin on capex",
               st.margin >= 20 ? "cm-sg" : st.margin >= 8 ? "cm-sa" : "cm-sr")
        + `</div><p class="lg-mix">${st.fuelM3.toLocaleString()} m³ 48 h fuel · fence ${Math.round(st.fenceLen)} m${show.pond ? " · SuDS pond" : ""} · ${show.trees.length} buffer trees</p>`
        + (site.terrain ? `<p class="lg-mix">⛰ slope mean ${site.terrain.meanSlope.toFixed(1)}% max ${site.terrain.maxSlope.toFixed(0)}%${site.terrain.maxSlope > 8 ? " ⚠ pad earthworks" : ""}</p>` : `<p class="lg-mix">⛰ terrain loading…</p>`);
      m._exportCand = show;
    }
    m.querySelector("#dcg-gen").textContent = gen + (running && genRate >= 1 ? ` · ${genRate.toFixed(0)}/s` : "");
    const cv = m.querySelector("#dcg-spark");
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

  const loopTick = () => {
    if (!running) return;
    const t0 = performance.now();
    let n = 0;
    do { step(); n++; } while (performance.now() - t0 < 110 && n < 60);
    genRate = n * 1000 / Math.max(1, performance.now() - t0);
    render();
    timer = setTimeout(loopTick, 30);
  };
  const setRunning = on => {
    running = on;
    const b = m.querySelector("#dcg-run");
    b.textContent = on ? "❚❚ Pause" : "▶ Evolve";
    b.classList.toggle("active", on);
    if (timer) { clearTimeout(timer); timer = null; }
    genRate = 0;
    if (on) timer = setTimeout(loopTick, 0);
  };

  const debouncedReset = () => { clearTimeout(m._deb); m._deb = setTimeout(resetPop, 300); };
  const dial = (id, key, lbl, num) => {
    const el = m.querySelector(id);
    el.addEventListener("input", () => {
      params[key] = num ? Number(el.value) : el.value;
      const lab = lbl && m.querySelector(lbl);
      if (lab) lab.textContent = el.value;
      debouncedReset();
    });
  };
  dial("#dcg-target", "targetMw", "#dcg-tv", true);
  dial("#dcg-storeys", "storeys", "#dcg-sv", true);
  dial("#dcg-setback", "setback", "#dcg-bv", true);
  dial("#dcg-green", "greenPct", "#dcg-gv", true);
  dial("#dcg-pue", "pue", "#dcg-pv", true);
  m.querySelector("#dcg-obj").value = params.objective;
  m.querySelector("#dcg-obj").addEventListener("change", e => { params.objective = e.target.value; resetPop(); });
  m.querySelector("#dcg-cool").value = params.cooling;
  m.querySelector("#dcg-cool").addEventListener("change", e => { params.cooling = e.target.value; resetPop(); });
  m.querySelector("#dcg-hall").value = params.hallSize;
  m.querySelector("#dcg-hall").addEventListener("change", e => { params.hallSize = e.target.value; resetPop(); });
  m.querySelector("#dcg-run").addEventListener("click", () => setRunning(!running));

  const stash = () => { _dcgSession = { sig, pop, best, gen, bestHist, focusIdx, params }; };
  const closeTool = () => { setRunning(false); stash(); m.hidden = true; };
  m.querySelector("#dcg-close").addEventListener("click", closeTool);
  m.addEventListener("click", e => { if (e.target === m) closeTool(); });

  m.querySelector("#dcg-adopt").addEventListener("click", () => {
    const cand = m._exportCand;
    if (!cand || !ctx.onAdopt) return;
    ctx.onAdopt({ itMw: cand.stats.itMw, gridMw: cand.stats.gridMw });
    setRunning(false); stash();
    m.hidden = true;
  });
  m.querySelector("#dcg-export").addEventListener("click", () => {
    const cand = m._exportCand;
    if (!cand) return;
    decorate(cand, site);
    const toLL = p => [(p[0] + site.ox) / site.kx, (p[1] + site.oy) / site.ky];
    const ringLL = ring => ring.map(toLL);
    const feats = [];
    for (const hl of cand.halls) {
      feats.push({ type: "Feature", properties: { kind: "data_hall", mw: +hl.mw.toFixed(1), storeys: params.storeys },
        geometry: { type: "Polygon", coordinates: [ringLL(hl.ring)] } });
      feats.push({ type: "Feature", properties: { kind: "plant_yard" },
        geometry: { type: "Polygon", coordinates: [ringLL(rectRing(hl.x, hl.y, cand.hall.w / 2, cand.hall.d / 2 + YARD, Math.cos(cand.theta), Math.sin(cand.theta)))] } });
    }
    if (cand.sub) feats.push({ type: "Feature", properties: { kind: "substation" },
      geometry: { type: "Polygon", coordinates: [ringLL(cand.sub.ring)] } });
    for (const rp of cand.roadPolys)
      feats.push({ type: "Feature", properties: { kind: "street" },
        geometry: { type: "Polygon", coordinates: rp.map(ringLL) } });
    if (cand.park) feats.push({ type: "Feature", properties: { kind: "parking" },
      geometry: { type: "Polygon", coordinates: [ringLL(cand.park.ring)] } });
    if (cand.pond) feats.push({ type: "Feature", properties: { kind: "suds_pond" },
      geometry: { type: "Polygon", coordinates: cand.pond.map(ringLL) } });
    for (const tr of cand.trees)
      feats.push({ type: "Feature", properties: { kind: "tree" },
        geometry: { type: "Point", coordinates: toLL(tr) } });
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features: feats })],
      { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (ctx.name || "dc_campus").replace(/[^\w-]+/g, "_") + "_layout.geojson";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  m.hidden = false;
  if (saved && saved.pop && saved.pop.length) {
    pop = saved.pop; best = saved.best; gen = saved.gen;
    bestHist = saved.bestHist || []; focusIdx = saved.focusIdx;
    render();
  } else {
    resetPop();
  }
}
