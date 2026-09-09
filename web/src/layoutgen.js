/*
 * layoutgen.js — generative residential site layout tool (v2, organic).
 *
 * Loaded on demand (dynamic import from the compile-plots modal). Given the
 * compiled site polygon it EVOLVES layouts that read as designed rather than
 * gridded: a curved primary street from a chosen site entrance, a perimeter
 * loop on larger sites, culs-de-sac with turning heads, plots placed along
 * street frontages following the curve, terraces in runs, semis in mirrored
 * pairs, detached drifting to the edges and flats toward the entrance,
 * driveways, street trees, pocket greens and a SuDS pond.
 *
 * Standards baked in (Manual for Streets / Building for a Healthy Life /
 * Essex Design Guide tones — a capacity & massing study, not engineering):
 *   primary street 5.5 m carriageway + 2 m footways      (9.5 m corridor)
 *   secondary loop 4.8 m + 1.8 m footways                (8.4 m corridor)
 *   shared-surface lane 6.0 m, turning head for the 11.2 m refuse truck
 *   frontages: detached 10.5 m · semi 6.7 m · terrace 5.3 m
 *   garden depth from the amenity dial (Essex benchmark 100 m²)
 *   parking: 2 on-plot per house (driveway drawn), 1.25/flat in courts
 *
 * Objectives: meet target density · maximise capacity (mix + amenity
 * respected) · maximise profit on cost (mix value vs floorspace, road and
 * infrastructure cost — the viability model made spatial). Scores also weigh
 * road efficiency (m of street per dwelling), the metric land buyers feel.
 *
 * All geometry is planar in local metres; polygon booleans are turf's planar
 * clipping; ribbons (street corridors) are built directly from the polyline
 * normals so curves stay smooth.
 */

const STREETS = {
  primary:   { carriage: 5.5, corridor: 9.5 },
  secondary: { carriage: 4.8, corridor: 8.4 },
  lane:      { carriage: 4.4, corridor: 6.0 },
};
const HEAD_R = 8.6;            // turning head radius (refuse truck sweep)
const HOUSE_DEPTH = 9.2;
const FRONT_GARDEN = 5.2;      // holds a 2.6 × 5.0 driveway
const TYPES = {
  det:  { w: 10.5, m2: 115, label: "Detached", color: "#e8590c", valMult: 1.06 },
  semi: { w: 6.7,  m2: 92,  label: "Semi",     color: "#f59f00", valMult: 1.00 },
  terr: { w: 5.3,  m2: 82,  label: "Terrace",  color: "#fab005", valMult: 0.94 },
  flat: { w: 26.0, m2: 58,  label: "Flats",    color: "#7048e8", valMult: 0.90 },
};
const FLAT_PLOT_D = 22, FLAT_BLD_D = 14, FLAT_STOREYS = 3;
const FLAT_PER_BLOCK = Math.floor(26 * FLAT_BLD_D * FLAT_STOREYS / 82); // ≈13

const T = () => window.turf;

// ---- rng -------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---- planar helpers --------------------------------------------------------
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++)
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(s / 2);
}
function polyArea(poly) {
  return poly.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(r), 0);
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}
function inPoly(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (inRing(x, y, poly[i])) return false;
  return true;
}
function inAnyPoly(x, y, polys) {
  for (const p of polys) if (inPoly(x, y, p)) return true;
  return false;
}
function boolOp(op, a, b) {
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
const F = c => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: c } });
const MF = p => ({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: p } });

function catmullRom(ctrl, step) {
  // closed=false; sample ~every `step` metres
  const pts = [];
  const P = i => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(segLen / step));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      pts.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  pts.push(ctrl[ctrl.length - 1].slice());
  return pts;
}
function polylineLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
function ribbon(pts, halfW) {
  // thick polyline as polygon, averaged normals — smooth on curves
  if (pts.length < 2) return null;
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    L.push([pts[i][0] - dy * halfW, pts[i][1] + dx * halfW]);
    R.push([pts[i][0] + dy * halfW, pts[i][1] - dx * halfW]);
  }
  const ring = L.concat(R.reverse());
  ring.push(ring[0].slice());
  return [ring];
}
function circlePoly(cx, cy, r, n = 20) {
  const ring = [];
  for (let i = 0; i <= n; i++)
    ring.push([cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
  return [ring];
}
function quadOverlap(qa, qb) {
  // SAT for two convex quads (rings of 5 pts, closed)
  const axes = [];
  for (const q of [qa, qb])
    for (let i = 0; i < 4; i++) {
      const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1];
      const len = Math.hypot(dx, dy) || 1;
      axes.push([-dy / len, dx / len]);
    }
  for (const ax of axes) {
    let amin = 1e18, amax = -1e18, bmin = 1e18, bmax = -1e18;
    for (let i = 0; i < 4; i++) {
      const pa = qa[i][0] * ax[0] + qa[i][1] * ax[1];
      const pb = qb[i][0] * ax[0] + qb[i][1] * ax[1];
      if (pa < amin) amin = pa; if (pa > amax) amax = pa;
      if (pb < bmin) bmin = pb; if (pb > bmax) bmax = pb;
    }
    if (amax < bmin + 0.25 || bmax < amin + 0.25) return false;
  }
  return true;
}
function distToBoundary(x, y, rings) {
  let d = 1e18;
  for (const ring of rings)
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0], ay = ring[i][1], bx = ring[i + 1][0], by = ring[i + 1][1];
      const vx = bx - ax, vy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
      const dd = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
      if (dd < d) d = dd;
    }
  return d;
}

// ---- candidate generation --------------------------------------------------
// Every DISJOINT part of the site gets its own mini street network — a
// scattered-parcel assembly must not leave outlying parcels unserved. The main
// entrance lives on the largest part (genome tE); each other part takes its
// access from the boundary point nearest that entrance, so the whole scheme
// reads as approached from one side.
function buildPartNetwork(part, site, params, genome, rnd, E0, roads, heads, roadSamples, plotDepth) {
  const rings = part.poly;
  const polys = [part.poly];
  const bp = part.boundary;
  const isMain = part.main;

  // entrance for this part
  let E = bp[0];
  if (isMain) E = bp[Math.floor(genome.tE * bp.length) % bp.length];
  else {
    let bd = 1e18;
    for (const p of bp) {
      const d = Math.hypot(p[0] - E0[0], p[1] - E0[1]);
      if (d < bd) { bd = d; E = p; }
    }
  }

  // tiny or thin parts: a shared-surface lane tracing just inside the
  // boundary (reads as a mews court), no spine.
  if (part.area < 1500 || part.width < 34) {
    const inset = 3.4;
    const pts = [];
    for (let i = 0; i < bp.length; i += 2) {
      const a = bp[(i - 2 + bp.length) % bp.length], b = bp[(i + 2) % bp.length];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (!inPoly(bp[i][0] + nx * 2, bp[i][1] + ny * 2, part.poly)) { nx = -nx; ny = -ny; }
      pts.push([bp[i][0] + nx * inset, bp[i][1] + ny * inset]);
    }
    if (pts.length > 5) {
      pts.push(pts[0].slice());
      roads.push({ pts, type: "lane", part });
      for (const p of pts) roadSamples.push(p);
    }
    return E;
  }

  // spine across the part
  let Fp = bp[0], fd = -1;
  for (const p of bp) {
    const d = Math.hypot(p[0] - E[0], p[1] - E[1]);
    if (d > fd) { fd = d; Fp = p; }
  }
  const C = part.centroid;
  const amp = part.diag * 0.14 * params.organic;
  const c1 = [E[0] + (C[0] - E[0]) * 0.45 + genome.b1x * amp, E[1] + (C[1] - E[1]) * 0.45 + genome.b1y * amp];
  const c2 = [C[0] + (Fp[0] - C[0]) * 0.5 + genome.b2x * amp, C[1] + (Fp[1] - C[1]) * 0.5 + genome.b2y * amp];
  const Fin = [Fp[0] + (C[0] - Fp[0]) * 0.25, Fp[1] + (C[1] - Fp[1]) * 0.25];
  let spine = catmullRom([E, c1, c2, Fin], 6);
  spine = spine.filter((p, i) => i === 0 || inPoly(p[0], p[1], part.poly) ||
                                 distToBoundary(p[0], p[1], rings) < 2);
  // Centre the street: nudge interior points a plot depth clear of the
  // boundary so BOTH frontages have room, then re-smooth. Without this the
  // curve hugs an edge and half the site's street serves nobody.
  const wantClear = Math.min(plotDepth * 0.8, part.width * 0.32);
  for (let it = 0; it < 3; it++) {
    for (let i = 2; i < spine.length - 1; i++) {
      const d = distToBoundary(spine[i][0], spine[i][1], rings);
      if (d < wantClear) {
        const vx = C[0] - spine[i][0], vy = C[1] - spine[i][1];
        const vl = Math.hypot(vx, vy) || 1;
        const push = Math.min(wantClear - d, 8);
        spine[i] = [spine[i][0] + vx / vl * push, spine[i][1] + vy / vl * push];
      }
    }
    for (let i = 2; i < spine.length - 1; i++)
      spine[i] = [(spine[i - 1][0] + spine[i][0] * 2 + spine[i + 1][0]) / 4,
                  (spine[i - 1][1] + spine[i][1] * 2 + spine[i + 1][1]) / 4];
  }
  while (spine.length > 4 &&
         distToBoundary(spine[spine.length - 1][0], spine[spine.length - 1][1], rings) < plotDepth * 0.55)
    spine.pop();
  if (spine.length > 3) {
    roads.push({ pts: spine, type: isMain ? "primary" : "secondary", part });
    if (polylineLen(spine) > 40) heads.push(spine[spine.length - 1]);
    for (const p of spine) roadSamples.push(p);
  } else return E;

  // perimeter loop for genuinely large parts
  if (genome.loop > 0.5 && part.area > 12000) {
    const inset = plotDepth + STREETS.secondary.corridor / 2 + 1.5;
    const raw = [];
    for (let i = 0; i < bp.length; i++) {
      const a = bp[(i - 2 + bp.length) % bp.length], b = bp[(i + 2) % bp.length];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (!inPoly(bp[i][0] + nx * 3, bp[i][1] + ny * 3, part.poly)) { nx = -nx; ny = -ny; }
      raw.push([bp[i][0] + nx * inset, bp[i][1] + ny * inset]);
    }
    const loopPts = [];
    for (let i = 0; i < raw.length; i++) {
      let sx = 0, sy = 0;
      for (let k = -3; k <= 3; k++) {
        const p = raw[(i + k + raw.length) % raw.length];
        sx += p[0]; sy += p[1];
      }
      const p = [sx / 7, sy / 7];
      if (!inPoly(p[0], p[1], part.poly)) { loopPts.push(null); continue; }
      let clear = true;
      for (const sp of spine)
        if (Math.hypot(p[0] - sp[0], p[1] - sp[1]) < 16) { clear = false; break; }
      loopPts.push(clear ? p : null);
    }
    let run = [];
    const flush = () => {
      if (run.length > 14 && polylineLen(run) > 60) {
        roads.push({ pts: run, type: "secondary", part });
        for (const p of run) roadSamples.push(p);
      }
      run = [];
    };
    for (const p of loopPts) { if (p) run.push(p); else flush(); }
    flush();
  }

  // branch lanes / culs-de-sac off the spine
  if (spine.length > 6 && part.area > 5000) {
    let next = Math.max(30, genome.branchGap * 0.6), side = rnd() < 0.5 ? 1 : -1, acc = 0;
    for (let i = 1; i < spine.length && roads.length < 16; i++) {
      acc += Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]);
      if (acc < next) continue;
      next = acc + genome.branchGap;
      side = -side;
      let dx = spine[i][0] - spine[i - 1][0], dy = spine[i][1] - spine[i - 1][1];
      const len = Math.hypot(dx, dy) || 1;
      let bx = -dy / len * side, by = dx / len * side;
      const pts = [spine[i].slice()];
      let px = spine[i][0], py = spine[i][1];
      for (let s = 0; s < 40; s++) {
        const ang = (rnd() - 0.5) * 0.24 * params.organic;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const nbx = bx * ca - by * sa;
        by = bx * sa + by * ca; bx = nbx;
        px += bx * 6; py += by * 6;
        if (!inPoly(px, py, part.poly)) break;
        if (distToBoundary(px, py, rings) < plotDepth * 0.7) break;
        let near = false;
        for (const rp of roadSamples)
          if (Math.hypot(px - rp[0], py - rp[1]) < 15 &&
              Math.hypot(px - spine[i][0], py - spine[i][1]) > 18) { near = true; break; }
        if (near) break;
        pts.push([px, py]);
      }
      if (polylineLen(pts) >= 22) {
        roads.push({ pts, type: "lane", part });
        for (const p of pts) roadSamples.push(p);
        heads.push(pts[pts.length - 1]);
      }
    }
  }
  return E;
}

function generateCandidate(site, params, genome) {
  const rnd = mulberry32(genome.seed);
  const gardenDepth = Math.max(9, params.gardenMin / TYPES.semi.w);
  const plotDepth = FRONT_GARDEN + HOUSE_DEPTH + gardenDepth;
  const { diag } = site;

  const roads = [], heads = [], roadSamples = [];
  const mainPart = site.parts.find(p => p.main);
  const E = mainPart.boundary[Math.floor(genome.tE * mainPart.boundary.length) % mainPart.boundary.length];
  for (const part of site.parts)
    buildPartNetwork(part, site, params, genome, rnd, E, roads, heads, roadSamples, plotDepth);

  // --- corridors (full ribbons + carriageways) ------------------------------
  const fullPolys = [], carrPolys = [];
  for (const r of roads) {
    const spec = STREETS[r.type];
    const fp = ribbon(r.pts, spec.corridor / 2);
    const cp = ribbon(r.pts, spec.carriage / 2);
    if (fp) fullPolys.push(fp);
    if (cp) carrPolys.push(cp);
  }
  for (const hd of heads) {
    fullPolys.push(circlePoly(hd[0], hd[1], HEAD_R));
    carrPolys.push(circlePoly(hd[0], hd[1], HEAD_R - 1.8));
  }
  // road land take: union of full ribbons ∩ site
  let roadArea = 0, roadClip = [];
  if (fullPolys.length) {
    let u = MF(fullPolys.map(p => p));
    const inter = boolOp("intersect", site.feat, u);
    roadClip = flatPolys(inter);
    roadArea = roadClip.reduce((a, p) => a + polyArea(p), 0);
  }

  // --- plots along frontages ------------------------------------------------
  const targetUnits = params.objective === "target"
    ? Math.max(1, Math.round(params.density * (site.areaM2 / 1e4) * params.netPct / 100))
    : 1e9;
  const mixShares = { flat: params.flatsPct / 100 };
  const hshare = 1 - mixShares.flat;
  mixShares.det = hshare * params.detPct / 100;
  mixShares.terr = hshare * params.terrPct / 100;
  mixShares.semi = Math.max(0, hshare - mixShares.det - mixShares.terr);

  const placed = { det: 0, semi: 0, terr: 0, flat: 0 };
  const lots = [];        // {quad, type, front:[p0,p1], runId, side}
  let total = 0, runCounter = 0;

  const deficits = () => Object.keys(mixShares)
    .filter(k => mixShares[k] > 0)
    .sort((a, b) =>
      (mixShares[b] - (total > 0 ? placed[b] / total : 0))
      - (mixShares[a] - (total > 0 ? placed[a] / total : 0)));
  const biased = (pos) => {
    // flats & terraces gravitate to the entrance, detached to the far edges
    const d = Math.hypot(pos[0] - E[0], pos[1] - E[1]) / diag;
    let order = deficits();
    if (d < 0.3) order = order.sort((a, b) =>
      (a === "flat" || a === "terr" ? -1 : 0) - (b === "flat" || b === "terr" ? -1 : 0));
    else if (d > 0.62) order = order.sort((a, b) =>
      (a === "det" ? -1 : 0) - (b === "det" ? -1 : 0));
    return order;
  };

  const tryQuad = (quad) => {
    for (let i = 0; i < 4; i++)
      if (!inAnyPoly(quad[i][0], quad[i][1], site.polys)) return false;
    const cx = (quad[0][0] + quad[2][0]) / 2, cy = (quad[0][1] + quad[2][1]) / 2;
    if (!inAnyPoly(cx, cy, site.polys)) return false;
    for (const fp of fullPolys)
      for (let i = 0; i < 4; i++)
        if (inPoly(quad[i][0], quad[i][1], fp) || inPoly(cx, cy, fp)) return false;
    for (const l of lots) {
      const lx = (l.quad[0][0] + l.quad[2][0]) / 2, ly = (l.quad[0][1] + l.quad[2][1]) / 2;
      if (Math.hypot(cx - lx, cy - ly) > 60) continue;
      if (quadOverlap(quad, l.quad)) return false;
    }
    return true;
  };

  const mkQuad = (pos, tx, ty, nx, ny, w, d0, depth) => {
    const p0 = [pos[0] + nx * d0, pos[1] + ny * d0];
    const p1 = [p0[0] + tx * w, p0[1] + ty * w];
    const p2 = [p1[0] + nx * depth, p1[1] + ny * depth];
    const p3 = [p0[0] + nx * depth, p0[1] + ny * depth];
    return [p0, p1, p2, p3, p0.slice()];
  };

  // Walk each frontage by TRUE ARCLENGTH so plots sit flush along the curve —
  // pointAt(s) interpolates position and tangent anywhere on the polyline.
  const walker = pts => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++)
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    let seg = 1;
    const pointAt = s => {
      while (seg < cum.length - 1 && cum[seg] < s) seg++;
      while (seg > 1 && cum[seg - 1] > s) seg--;
      const a = pts[seg - 1], b = pts[seg];
      const sl = cum[seg] - cum[seg - 1] || 1;
      const t2 = (s - cum[seg - 1]) / sl;
      let tx = (b[0] - a[0]) / sl, ty = (b[1] - a[1]) / sl;
      const n2 = Math.hypot(tx, ty) || 1;
      return { pos: [a[0] + (b[0] - a[0]) * t2, a[1] + (b[1] - a[1]) * t2],
               tx: tx / n2, ty: ty / n2 };
    };
    return { L, pointAt };
  };

  for (const road of roads) {
    if (total >= targetUnits) break;
    const spec = STREETS[road.type];
    const edge = spec.corridor / 2 + 0.3;
    const { L, pointAt } = walker(road.pts);
    if (L < 14) continue;
    for (const side of [1, -1]) {
      if (total >= targetUnits) break;
      let s = 2, runId = null, runType = null, runLeft = 0;
      while (s < L - 4 && total < targetUnits) {
        const { pos, tx, ty } = pointAt(s);
        const nx = -ty * side, ny = tx * side;
        let placedHere = false;
        const order = runLeft > 0 ? [runType] : biased(pos);
        for (const type of order) {
          const tw = TYPES[type].w;
          if (s + tw > L - 2) continue;
          const depth = type === "flat" ? FLAT_PLOT_D : plotDepth;
          const quad = mkQuad(pos, tx, ty, nx, ny, tw, edge, depth);
          if (!tryQuad(quad)) continue;
          let thisRun = null;
          if (type === "terr") {
            if (runLeft > 0) { thisRun = runId; runLeft--; }
            else { runId = "r" + (runCounter++); thisRun = runId; runType = "terr"; runLeft = 2 + Math.floor(rnd() * 3); }
          } else if (type === "semi") {
            if (runLeft > 0) { thisRun = runId; runLeft--; }
            else { runId = "s" + (runCounter++); thisRun = runId; runType = "semi"; runLeft = 1; }
          } else runLeft = 0;
          lots.push({ quad, type, side, runId: thisRun,
                      front: [quad[0], quad[1]], tx, ty, nx, ny,
                      jit: (rnd() - 0.5) * 1.2 * params.organic });
          if (type === "flat") { placed.flat += FLAT_PER_BLOCK; total += FLAT_PER_BLOCK; }
          else { placed[type]++; total++; }
          s += tw + (runLeft > 0 ? 0.05 : 0.5 + rnd() * 1.4 * params.organic);
          placedHere = true;
          break;
        }
        if (!placedHere) { s += 2; runLeft = 0; }
      }
    }
  }

  // --- greens, pond, trees --------------------------------------------------
  const lotArea = lots.reduce((a, l) => a + ringArea(l.quad), 0);
  const greenArea = Math.max(0, site.areaM2 - roadArea - lotArea);

  let pond = null;
  if (site.areaM2 > 12000) {
    let bx = null, bd = -1;
    for (let gx = site.minX + 10; gx < site.maxX; gx += 12)
      for (let gy = site.minY + 10; gy < site.maxY; gy += 12) {
        if (!inAnyPoly(gx, gy, site.polys)) continue;
        let d = distToBoundary(gx, gy, site.allRings);
        for (const rp of roadSamples) {
          const dd = Math.hypot(gx - rp[0], gy - rp[1]);
          if (dd < d) d = dd;
        }
        for (const l of lots) {
          const lx = (l.quad[0][0] + l.quad[2][0]) / 2, ly = (l.quad[0][1] + l.quad[2][1]) / 2;
          const dd = Math.hypot(gx - lx, gy - ly) - 12;
          if (dd < d) d = dd;
        }
        if (d > bd) { bd = d; bx = [gx, gy]; }
      }
    if (bx && bd > 13) {
      const ang = rnd() * Math.PI, rx = 12, ry = 7.5, ring = [];
      for (let i = 0; i <= 22; i++) {
        const t2 = i / 22 * 2 * Math.PI;
        const ex = rx * Math.cos(t2), ey = ry * Math.sin(t2);
        ring.push([bx[0] + ex * Math.cos(ang) - ey * Math.sin(ang),
                   bx[1] + ex * Math.sin(ang) + ey * Math.cos(ang)]);
      }
      pond = [ring];
    }
  }

  const trees = [];
  for (const road of roads) {
    if (road.type === "lane") continue;
    const off = STREETS[road.type].corridor / 2 + 1.6;
    let acc = 0, side = 1;
    for (let i = 1; i < road.pts.length; i++) {
      acc += Math.hypot(road.pts[i][0] - road.pts[i - 1][0], road.pts[i][1] - road.pts[i - 1][1]);
      if (acc < 13) continue;
      acc = 0; side = -side;
      const a = road.pts[i - 1], b = road.pts[i];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const px = b[0] - dy / len * off * side, py = b[1] + dx / len * off * side;
      if (!inAnyPoly(px, py, site.polys)) continue;
      let free = true;
      for (const l of lots)
        if (inRing(px, py, l.quad)) { free = false; break; }
      if (free) trees.push([px, py]);
    }
  }

  const roadLen = roads.reduce((a, r) => a + polylineLen(r.pts), 0);
  const stats = statsFor({ placed, total, roadArea, roadLen, greenArea, site, params,
                           gardenDepth, flatBlocks: lots.filter(l => l.type === "flat").length });
  return { genome, roads, roadClip, carrPolys, heads, lots, pond, trees, stats,
           gardenDepth };
}

function statsFor({ placed, total, roadArea, roadLen, greenArea, site, params, gardenDepth, flatBlocks }) {
  const siteHa = site.areaM2 / 1e4;
  const houses = placed.det + placed.semi + placed.terr;
  const mix = total > 0 ? { flat: placed.flat / total, det: placed.det / total,
    semi: placed.semi / total, terr: placed.terr / total } : { flat: 0, det: 0, semi: 0, terr: 0 };
  const wantFlat = params.flatsPct / 100, hs = 1 - wantFlat;
  const mixDev = Math.abs(mix.flat - wantFlat)
    + Math.abs(mix.det - hs * params.detPct / 100)
    + Math.abs(mix.terr - hs * params.terrPct / 100);
  const greenPct = greenArea / site.areaM2;
  const parking = houses * 2 + Math.ceil(placed.flat * 1.25);
  const avgGarden = houses > 0
    ? (placed.det * TYPES.det.w + placed.semi * TYPES.semi.w + placed.terr * TYPES.terr.w)
      * gardenDepth / houses : 0;
  let gia = 0, gdv = 0, build = 0;
  const psm = (params.ppm2 || 3500) * ((params.assumptions.salesAdjPct || 100) / 100);
  const costH = (params.assumptions.buildPm2House || 1800) * (params.assumptions.costIndexFactor || 1);
  const costF = (params.assumptions.buildPm2Flat || 2100) * (params.assumptions.costIndexFactor || 1);
  for (const k of ["det", "semi", "terr"]) {
    gia += placed[k] * TYPES[k].m2;
    gdv += placed[k] * TYPES[k].m2 * psm * TYPES[k].valMult;
    build += placed[k] * TYPES[k].m2 * costH;
  }
  gia += placed.flat * TYPES.flat.m2;
  gdv += placed.flat * TYPES.flat.m2 * psm * TYPES.flat.valMult;
  build += placed.flat * TYPES.flat.m2 * costF;
  const roadsCost = roadArea * 95 + roadLen * 60;   // surface + services in trench
  const perPlot = ((params.assumptions.sitePrepPerPlot || 0)
    + (params.assumptions.infraPerPlot || 0)) * 1000 * total;
  const cost = (build + roadsCost + perPlot) * 1.14;
  const poc = cost > 0 ? (gdv - cost) / cost * 100 : 0;
  return { total, placed, mix, mixDev,
           density: siteHa > 0 ? total / siteHa : 0,
           greenPct, greenArea, roadArea, roadLen,
           roadPerUnit: total > 0 ? roadLen / total : 0,
           parking, avgGarden, gia, gdv, cost, poc, flatBlocks, houses };
}

function scoreOf(st, params) {
  const greenPen = Math.max(0, params.greenPct / 100 - st.greenPct) * 400;
  const mixPen = st.mixDev * 180;
  const roadPen = Math.max(0, st.roadPerUnit - 8) * 4;
  if (params.objective === "target") {
    const targetGross = params.density * params.netPct / 100;
    return 1000 - Math.abs(st.density - targetGross) * 14 - mixPen - greenPen - roadPen;
  }
  if (params.objective === "profit") return st.poc * 8 - mixPen - greenPen - roadPen * 2;
  return st.total - mixPen * 2 - greenPen * 2 - roadPen;
}

// ---- rendering -------------------------------------------------------------
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
  out += site.polys.map(p => `<path d="${path(p)}" fill="#b7e4c1" fill-rule="evenodd"/>`).join("");
  // footway ribbon then carriageway on top
  out += cand.roadClip.map(p => `<path d="${path(p)}" fill="#e3e7ea" fill-rule="evenodd"/>`).join("");
  for (const cp of cand.carrPolys)
    out += `<path d="${path(cp)}" fill="#c4cad1"/>`;
  // gardens / plots
  for (const l of cand.lots) {
    const fill = l.type === "flat" ? "#e5dbff" : "#d8f5dd";
    const stroke = l.type === "flat" ? "#b197fc" : "#96d9a5";
    out += `<path d="${path([l.quad])}" fill="${fill}" stroke="${stroke}" stroke-width="${detail ? 0.7 : 0.25}"/>`;
  }
  // driveways, parking courts, then houses (shadow + body + ridge)
  for (const l of cand.lots) {
    const { tx, ty, nx, ny } = l;
    const p0 = l.quad[0];
    if (detail && (l.type === "det" || l.type === "semi")) {
      const dq = [[p0[0] + tx * 0.6, p0[1] + ty * 0.6]];
      dq.push([dq[0][0] + tx * 2.6, dq[0][1] + ty * 2.6]);
      dq.push([dq[1][0] + nx * 5, dq[1][1] + ny * 5]);
      dq.push([dq[0][0] + nx * 5, dq[0][1] + ny * 5]);
      dq.push(dq[0].slice());
      out += `<path d="${path([dq])}" fill="#cfd5da"/>`;
    }
    if (detail && l.type === "flat") {
      // rear parking court with marked bays
      const c0 = [p0[0] + tx * 1.5 + nx * (FLAT_BLD_D + 5.5), p0[1] + ty * 1.5 + ny * (FLAT_BLD_D + 5.5)];
      const cw = TYPES.flat.w - 3, cd = 5.5;
      const c1 = [c0[0] + tx * cw, c0[1] + ty * cw];
      const c2 = [c1[0] + nx * cd, c1[1] + ny * cd];
      const c3 = [c0[0] + nx * cd, c0[1] + ny * cd];
      out += `<path d="${path([[c0, c1, c2, c3, c0]])}" fill="#cfd5da"/>`;
      for (let b = 2.6; b < cw; b += 2.6) {
        const q0 = [c0[0] + tx * b, c0[1] + ty * b];
        const q1 = [q0[0] + nx * cd, q0[1] + ny * cd];
        out += `<line x1="${X(q0[0]).toFixed(1)}" y1="${Y(q0[1]).toFixed(1)}" x2="${X(q1[0]).toFixed(1)}" y2="${Y(q1[1]).toFixed(1)}" stroke="#ffffff" stroke-width="0.6"/>`;
      }
    }
    const w0 = TYPES[l.type].w;
    const fd = (l.type === "flat" ? 4 : FRONT_GARDEN) + (l.jit || 0);
    const bd = l.type === "flat" ? FLAT_BLD_D : HOUSE_DEPTH;
    const m = l.runId ? 0.05 : 0.7;   // runs read as one continuous block
    const b0 = [p0[0] + tx * m + nx * fd, p0[1] + ty * m + ny * fd];
    const b1 = [b0[0] + tx * (w0 - 2 * m), b0[1] + ty * (w0 - 2 * m)];
    const b2 = [b1[0] + nx * bd, b1[1] + ny * bd];
    const b3 = [b0[0] + nx * bd, b0[1] + ny * bd];
    if (detail) {
      const sh = 0.9;   // soft SE shadow gives the plan depth
      const s0 = [b0[0] + sh, b0[1] - sh], s1 = [b1[0] + sh, b1[1] - sh],
            s2 = [b2[0] + sh, b2[1] - sh], s3 = [b3[0] + sh, b3[1] - sh];
      out += `<path d="${path([[s0, s1, s2, s3, s0]])}" fill="rgba(33,37,41,0.28)"/>`;
    }
    out += `<path d="${path([[b0, b1, b2, b3, b0]])}" fill="${TYPES[l.type].color}"${detail ? ` stroke="#ffffff" stroke-width="0.45"` : ""}/>`;
    if (detail && l.type !== "flat") {
      // roof ridge along the frontage axis
      const r0 = [(b0[0] + b3[0]) / 2 + tx * 0.6, (b0[1] + b3[1]) / 2 + ty * 0.6];
      const r1 = [(b1[0] + b2[0]) / 2 - tx * 0.6, (b1[1] + b2[1]) / 2 - ty * 0.6];
      out += `<line x1="${X(r0[0]).toFixed(1)}" y1="${Y(r0[1]).toFixed(1)}" x2="${X(r1[0]).toFixed(1)}" y2="${Y(r1[1]).toFixed(1)}" stroke="rgba(255,255,255,0.55)" stroke-width="0.8"/>`;
    }
  }
  if (cand.pond)
    out += `<path d="${path([cand.pond[0] ? cand.pond[0] : cand.pond])}" fill="#74c0fc" stroke="#4dabf7" stroke-width="1"/>`;
  if (detail)
    for (const t of cand.trees)
      out += `<circle cx="${X(t[0]).toFixed(1)}" cy="${Y(t[1]).toFixed(1)}" r="${(1.9 * sc).toFixed(1)}" fill="#37b24d" opacity="0.75"/>`;
  out += site.polys.map(p => `<path d="${path(p)}" fill="none" stroke="#212529" stroke-width="${detail ? 1.6 : 0.8}" fill-rule="evenodd"/>`).join("");
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

  // Project to local metres once; precompute everything candidates share.
  const g = ctx.site.geometry;
  const polys4326 = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let lat0 = 0, n = 0;
  for (const poly of polys4326) for (const p of poly[0]) { lat0 += p[1]; n++; }
  lat0 /= Math.max(1, n);
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let ox = 1e12, oy = 1e12;
  for (const poly of polys4326) for (const p of poly[0]) {
    ox = Math.min(ox, p[0] * kx); oy = Math.min(oy, p[1] * ky);
  }
  const polys = polys4326.map(poly =>
    poly.map(ring => ring.map(p => [p[0] * kx - ox, p[1] * ky - oy])));
  const areaM2 = polys.reduce((a, p) => a + polyArea(p), 0);
  let minX = 1e12, maxX = -1e12, minY = 1e12, maxY = -1e12;
  for (const poly of polys) for (const ring of poly) for (const p of ring) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  // Each disjoint part gets its own resampled boundary, centroid and size, so
  // the generator can serve every parcel of a scattered assembly.
  const resample = ring => {
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.round(segLen / 5));
      for (let s2 = 0; s2 < steps; s2++)
        out.push([a[0] + (b[0] - a[0]) * s2 / steps, a[1] + (b[1] - a[1]) * s2 / steps]);
    }
    return out;
  };
  const parts = polys.map(p => {
    let pMinX = 1e12, pMaxX = -1e12, pMinY = 1e12, pMaxY = -1e12, cx2 = 0, cy2 = 0;
    for (const pt of p[0]) {
      if (pt[0] < pMinX) pMinX = pt[0]; if (pt[0] > pMaxX) pMaxX = pt[0];
      if (pt[1] < pMinY) pMinY = pt[1]; if (pt[1] > pMaxY) pMaxY = pt[1];
      cx2 += pt[0]; cy2 += pt[1];
    }
    return { poly: p, area: polyArea(p), boundary: resample(p[0]),
             centroid: [cx2 / p[0].length, cy2 / p[0].length],
             width: Math.min(pMaxX - pMinX, pMaxY - pMinY),
             diag: Math.hypot(pMaxX - pMinX, pMaxY - pMinY), main: false };
  });
  parts.sort((a, b) => b.area - a.area);
  parts[0].main = true;
  const site = {
    polys, allRings: polys.flatMap(p => p), parts, areaM2,
    minX, maxX, minY, maxY, diag: Math.hypot(maxX - minX, maxY - minY),
    feat: polys.length === 1 ? F(polys[0]) : MF(polys),
    kx, ky, ox, oy,
  };
  const siteHa = areaM2 / 1e4;

  const params = {
    objective: "target",
    density: ctx.density || 35, netPct: ctx.netPct || 80,
    flatsPct: Math.round(ctx.assumptions.flatMixPct ?? 20),
    detPct: 30, terrPct: 20,
    gardenMin: 80, greenPct: 10, organic: 0.7,
    ppm2: ctx.ppm2, assumptions: ctx.assumptions || {},
  };

  const POP = 12;
  let pop = [], gen = 0, best = null, bestHist = [], running = false, timer = null, focusIdx = null;

  const randGenome = () => ({
    tE: Math.random(), b1x: Math.random() * 2 - 1, b1y: Math.random() * 2 - 1,
    b2x: Math.random() * 2 - 1, b2y: Math.random() * 2 - 1,
    branchGap: 45 + Math.random() * 60, loop: Math.random(),
    seed: (Math.random() * 1e9) | 0,
  });
  const mutate = gnm => ({
    tE: (gnm.tE + (Math.random() - 0.5) * 0.12 + 1) % 1,
    b1x: gnm.b1x + (Math.random() - 0.5) * 0.5, b1y: gnm.b1y + (Math.random() - 0.5) * 0.5,
    b2x: gnm.b2x + (Math.random() - 0.5) * 0.5, b2y: gnm.b2y + (Math.random() - 0.5) * 0.5,
    branchGap: Math.min(110, Math.max(40, gnm.branchGap + (Math.random() - 0.5) * 18)),
    loop: Math.random() < 0.12 ? Math.random() : gnm.loop,
    seed: Math.random() < 0.4 ? (Math.random() * 1e9) | 0 : gnm.seed,
  });
  const build = gnm => { try { return generateCandidate(site, params, gnm); } catch (_) { return null; } };
  const resetPop = () => {
    pop = [];
    for (let i = 0; i < POP * 2 && pop.length < POP; i++) {
      const c = build(randGenome()); if (c) pop.push(c);
    }
    gen = 0; best = null; bestHist = []; focusIdx = null;
    stepAndRender();
  };
  const step = () => {
    if (!pop.length) return;
    pop.sort((a, b) => scoreOf(b.stats, params) - scoreOf(a.stats, params));
    const elite = pop.slice(0, 4);
    const next = [...elite];
    while (next.length < POP) {
      const parent = elite[Math.floor(Math.random() * elite.length)];
      const c = build(Math.random() < 0.15 ? randGenome() : mutate(parent.genome));
      next.push(c || parent);
    }
    pop = next;
    pop.sort((a, b) => scoreOf(b.stats, params) - scoreOf(a.stats, params));
    if (!best || scoreOf(pop[0].stats, params) > scoreOf(best.stats, params)) best = pop[0];
    bestHist.push(scoreOf(best.stats, params));
    gen++;
  };

  let m = document.getElementById("lg-modal");
  if (!m) { m = document.createElement("div"); m.id = "lg-modal"; document.body.appendChild(m); }
  const mixLbl = st => [
    st.placed.det ? `${st.placed.det} det` : null,
    st.placed.semi ? `${st.placed.semi} semi` : null,
    st.placed.terr ? `${st.placed.terr} terr` : null,
    st.placed.flat ? `${st.placed.flat} flats (${st.flatBlocks} block${st.flatBlocks === 1 ? "" : "s"})` : null,
  ].filter(Boolean).join(" · ");

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
          <label><span>Street character <b id="lg-ov">organic</b></span>
            <input type="range" id="lg-organic" min="0" max="100" step="10" value="${Math.round(params.organic * 100)}"></label>
          <button type="button" id="lg-run" class="plot-mode-btn">▶ Evolve</button>
          <div class="lg-gen">gen <b id="lg-gen">0</b></div>
          <canvas id="lg-spark" width="170" height="34"></canvas>
          <button type="button" id="lg-export" class="ghost">Export GeoJSON</button>
          <p class="lg-note">Capacity & massing study to Manual-for-Streets tones:
            5.5 m + footways primary, shared-surface lanes, turning heads for an
            11.2 m refuse truck, gardens from the amenity dial, 2 spaces/house.
            Not an engineering layout.</p>
        </div>
        <div class="lg-grid" id="lg-grid"></div>
        <div class="lg-best">
          <div id="lg-best-svg"></div>
          <div id="lg-best-stats"></div>
          <div class="lg-legend">
            <span><i style="background:${TYPES.det.color}"></i>det</span>
            <span><i style="background:${TYPES.semi.color}"></i>semi</span>
            <span><i style="background:${TYPES.terr.color}"></i>terrace</span>
            <span><i style="background:${TYPES.flat.color}"></i>flats</span>
            <span><i style="background:#d8f5dd;border:1px solid #96d9a5"></i>garden</span>
            <span><i style="background:#b7e4c1"></i>green</span>
            <span><i style="background:#c4cad1"></i>street</span>
            <span><i style="background:#74c0fc"></i>SuDS pond</span>
            <span><i style="background:#37b24d;border-radius:50%"></i>tree</span>
          </div>
        </div>
      </div>
    </div>`;

  const render = () => {
    const grid = m.querySelector("#lg-grid");
    grid.innerHTML = pop.map((cnd, i) => `
      <div class="lg-cell${(focusIdx === i || (i === 0 && focusIdx == null)) ? " lg-top" : ""}" data-i="${i}">
        ${svgOf(cnd, site, 150, 128, false)}
        <span>${cnd.stats.total} · ${cnd.stats.density.toFixed(0)}/ha${params.objective === "profit" ? " · " + cnd.stats.poc.toFixed(0) + "%" : ""}</span>
      </div>`).join("");
    grid.querySelectorAll(".lg-cell").forEach(cell =>
      cell.addEventListener("click", () => { focusIdx = +cell.dataset.i; render(); }));
    const show = focusIdx != null ? pop[focusIdx] : (best || pop[0]);
    if (show) {
      m.querySelector("#lg-best-svg").innerHTML = svgOf(show, site, 430, 360, true);
      const st = show.stats;
      const cell = (v, l) => `<div class="cm-cell"><b>${v}</b><span>${l}</span></div>`;
      m.querySelector("#lg-best-stats").innerHTML = `<div class="cm-grid">`
        + cell(st.total.toLocaleString(), "dwellings")
        + cell(st.density.toFixed(1) + "/ha", "gross density")
        + cell((st.greenPct * 100).toFixed(0) + "%", "green space")
        + cell(st.poc.toFixed(0) + "%", "PoC (excl. land)")
        + cell(Math.round(st.roadLen) + " m", "street length")
        + cell(st.roadPerUnit.toFixed(1) + " m", "street / home")
        + cell(st.parking.toLocaleString(), "parking spaces")
        + cell(Math.round(st.avgGarden) + " m²", "avg rear garden")
        + `</div><p class="lg-mix">${mixLbl(st)}${show.pond ? " · SuDS pond" : ""} · ${show.trees.length} street trees</p>`;
      m._exportCand = show;
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
    const b = m.querySelector("#lg-run");
    b.textContent = on ? "❚❚ Pause" : "▶ Evolve";
    b.classList.toggle("active", on);
    if (timer) { clearInterval(timer); timer = null; }
    if (on) timer = setInterval(stepAndRender, 450);
  };

  const slider = (id, key, lbl, map) => {
    const el = m.querySelector(id);
    el.addEventListener("input", () => {
      params[key] = map ? map(Number(el.value)) : Number(el.value);
      const lab = m.querySelector(lbl);
      if (lab) lab.textContent = map ? el.value : el.value;
      resetPop();
    });
  };
  slider("#lg-density", "density", "#lg-dv");
  slider("#lg-flats", "flatsPct", "#lg-fv");
  slider("#lg-det", "detPct", "#lg-dtv");
  slider("#lg-terr", "terrPct", "#lg-tv");
  slider("#lg-garden", "gardenMin", "#lg-gv");
  slider("#lg-green", "greenPct", "#lg-grv");
  {
    const el = m.querySelector("#lg-organic");
    el.addEventListener("input", () => {
      params.organic = Number(el.value) / 100;
      m.querySelector("#lg-ov").textContent =
        params.organic < 0.25 ? "formal" : params.organic < 0.65 ? "relaxed" : "organic";
      resetPop();
    });
  }
  m.querySelector("#lg-obj").addEventListener("change", e => { params.objective = e.target.value; resetPop(); });
  m.querySelector("#lg-run").addEventListener("click", () => setRunning(!running));
  m.querySelector("#lg-close").addEventListener("click", () => { setRunning(false); m.hidden = true; });
  m.addEventListener("click", e => { if (e.target === m) { setRunning(false); m.hidden = true; } });
  m.querySelector("#lg-export").addEventListener("click", () => {
    const cand = m._exportCand;
    if (!cand) return;
    const toLL = p => [(p[0] + site.ox) / site.kx, (p[1] + site.oy) / site.ky];
    const ringLL = ring => ring.map(toLL);
    const feats = [];
    for (const p of cand.roadClip)
      feats.push({ type: "Feature", properties: { kind: "street" },
        geometry: { type: "Polygon", coordinates: p.map(ringLL) } });
    for (const l of cand.lots)
      feats.push({ type: "Feature", properties: { kind: "plot", house: TYPES[l.type].label },
        geometry: { type: "Polygon", coordinates: [ringLL(l.quad)] } });
    if (cand.pond)
      feats.push({ type: "Feature", properties: { kind: "suds_pond" },
        geometry: { type: "Polygon", coordinates: cand.pond.map(ringLL) } });
    for (const tr of cand.trees)
      feats.push({ type: "Feature", properties: { kind: "tree" },
        geometry: { type: "Point", coordinates: toLL(tr) } });
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features: feats })],
      { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (ctx.name || "layout").replace(/[^\w-]+/g, "_") + "_layout.geojson";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  m.hidden = false;
  resetPop();
  setRunning(true);
}
