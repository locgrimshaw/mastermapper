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
  det:  { w: 12.2, m2: 115, label: "Detached", color: "#e8590c", valMult: 1.06 },
  semi: { w: 6.7,  m2: 92,  label: "Semi",     color: "#f59f00", valMult: 1.00 },
  terr: { w: 5.3,  m2: 82,  label: "Terrace",  color: "#fab005", valMult: 0.94 },
  flat: { w: 26.0, m2: 58,  label: "Flats",    color: "#7048e8", valMult: 0.90 },
};
const FLAT_PLOT_D = 22, FLAT_BLD_D = 14; // blocks sized 2 or 3 storeys at placement time

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

// Building footprint for a lot — one source of truth for the renderer and
// the solar engine. Returns the closed quad plus eaves-ish height.
function bldQuad(l) {
  const { tx, ty, nx, ny } = l;
  const p0 = l.quad[0];
  const w0 = TYPES[l.type].w;
  const fd = (l.type === "flat" ? 4 : FRONT_GARDEN) + (l.jit || 0);
  const bd = l.type === "flat" ? FLAT_BLD_D : HOUSE_DEPTH;
  // detached homes read detached: a real side margin, not a party-wall gap
  const m = l.runId ? 0.05 : (l.type === "det" ? 2.3 : 0.7);
  const b0 = [p0[0] + tx * m + nx * fd, p0[1] + ty * m + ny * fd];
  const b1 = [b0[0] + tx * (w0 - 2 * m), b0[1] + ty * (w0 - 2 * m)];
  const b2 = [b1[0] + nx * bd, b1[1] + ny * bd];
  const b3 = [b0[0] + nx * bd, b0[1] + ny * bd];
  return { quad: [b0, b1, b2, b3, b0.slice()], h: l.type === "flat" ? (l.storeys === 2 ? 6.8 : 9.5) : 7.8 };
}

// ---- solar: equinox garden sun-hours ---------------------------------------
// First-order BRE-style check at the equinox (declination 0): for each rear
// garden midpoint, hourly 08:00-16:00, is the sun blocked by any nearby
// building? alt = asin(cos phi * cos H); shadow reach = h / tan(alt).
function _rayHitsQuad(px, py, dx, dy, maxT, quad) {
  for (let i = 0; i < 4; i++) {
    const ax = quad[i][0], ay = quad[i][1];
    const ex = quad[i + 1][0] - ax, ey = quad[i + 1][1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - px) * ey - (ay - py) * ex) / den;
    const u = ((ax - px) * dy - (ay - py) * dx) / den;
    if (t > 0.05 && t <= maxT && u >= 0 && u <= 1) return true;
  }
  return false;
}
function computeSun(cand, site) {
  if (cand._sun) return cand._sun;
  const phi = (site.lat0 || 52) * Math.PI / 180;
  const blds = cand.lots.map(l => {
    const b = bldQuad(l);
    return { quad: b.quad, h: b.h,
             cx: (b.quad[0][0] + b.quad[2][0]) / 2,
             cy: (b.quad[0][1] + b.quad[2][1]) / 2 };
  });
  const hoursLit = [];
  for (const l of cand.lots) {
    if (l.type === "flat") continue;
    const gd = cand.gardenDepth || 11;
    const gDist = FRONT_GARDEN + HOUSE_DEPTH + gd * 0.55;
    const gp = [l.quad[0][0] + l.tx * TYPES[l.type].w / 2 + l.nx * gDist,
                l.quad[0][1] + l.ty * TYPES[l.type].w / 2 + l.ny * gDist];
    let lit = 0;
    for (let h = 8; h <= 16; h++) {
      const H = (h - 12) * 15 * Math.PI / 180;
      const alt = Math.asin(Math.cos(phi) * Math.cos(H));
      if (alt <= 0.06) continue;
      const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi));
      const ux = -Math.sin(A), uy = -Math.cos(A);   // toward the sun
      let blocked = false;
      for (const b of blds) {
        if (Math.hypot(b.cx - gp[0], b.cy - gp[1]) > 46) continue;
        if (_rayHitsQuad(gp[0], gp[1], ux, uy, b.h / Math.tan(alt), b.quad)) {
          blocked = true; break;
        }
      }
      if (!blocked) lit++;
    }
    l._sun = lit;
    hoursLit.push(lit);
  }
  hoursLit.sort((a, b) => a - b);
  cand._sun = {
    median: hoursLit.length ? hoursLit[Math.floor(hoursLit.length / 2)] : 0,
    pct3: hoursLit.length ? hoursLit.filter(v => v >= 3).length / hoursLit.length * 100 : 0,
  };
  return cand._sun;
}

// ---- terrain: elevations, contours, earthworks -----------------------------
// Elevation grid from the free open-meteo API (no key, CORS), sampled over
// the site bbox. Everything degrades gracefully to "no terrain".
async function fetchTerrain(site) {
  const step = Math.max(20, Math.min(45, site.diag / 15));
  const nx = Math.min(18, Math.max(4, Math.ceil((site.maxX - site.minX) / step) + 2));
  const ny = Math.min(18, Math.max(4, Math.ceil((site.maxY - site.minY) / step) + 2));
  const x0 = site.minX - step, y0 = site.minY - step;
  const lats = [], lngs = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      lngs.push(((x0 + i * step) + site.ox) / site.kx);
      lats.push(((y0 + j * step) + site.oy) / site.ky);
    }
  const z = new Array(nx * ny).fill(null);
  for (let off = 0; off < lats.length; off += 90) {
    const la = lats.slice(off, off + 90).map(v => v.toFixed(5)).join(",");
    const lo = lngs.slice(off, off + 90).map(v => v.toFixed(5)).join(",");
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`);
    if (!r.ok) throw new Error("elevation HTTP " + r.status);
    const j2 = await r.json();
    (j2.elevation || []).forEach((v, k) => { z[off + k] = v; });
  }
  if (z.some(v => v == null || isNaN(v))) throw new Error("elevation gaps");
  // contour segments (marching squares, 1 m interval)
  const zmin = Math.min(...z), zmax = Math.max(...z);
  const contours = [];
  for (let lev = Math.ceil(zmin); lev <= Math.floor(zmax); lev++) {
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const za = z[j * nx + i], zb = z[j * nx + i + 1],
              zc = z[(j + 1) * nx + i + 1], zd = z[(j + 1) * nx + i];
        const pts2 = [];
        const edge = (v1, v2, x1, y1, x2, y2) => {
          if ((v1 < lev) !== (v2 < lev)) {
            const t = (lev - v1) / (v2 - v1);
            pts2.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
          }
        };
        const X1 = x0 + i * step, X2 = x0 + (i + 1) * step;
        const Y1 = y0 + j * step, Y2 = y0 + (j + 1) * step;
        edge(za, zb, X1, Y1, X2, Y1);
        edge(zb, zc, X2, Y1, X2, Y2);
        edge(zc, zd, X2, Y2, X1, Y2);
        edge(zd, za, X1, Y2, X1, Y1);
        if (pts2.length === 2) contours.push(pts2);
      }
  }
  // slope stats over in-site cells
  let maxS = 0, sumS = 0, nS = 0;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const cx2 = x0 + (i + 0.5) * step, cy2 = y0 + (j + 0.5) * step;
      if (!inAnyPoly(cx2, cy2, site.polys)) continue;
      const sx2 = (z[j * nx + i + 1] - z[j * nx + i]) / step;
      const sy2 = (z[(j + 1) * nx + i] - z[j * nx + i]) / step;
      const s2 = Math.hypot(sx2, sy2) * 100;
      maxS = Math.max(maxS, s2); sumS += s2; nS++;
    }
  const zAt = (x, y) => {
    const fi = Math.max(0, Math.min(nx - 1.001, (x - x0) / step));
    const fj = Math.max(0, Math.min(ny - 1.001, (y - y0) / step));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    return z[j * nx + i] * (1 - u) * (1 - v) + z[j * nx + i + 1] * u * (1 - v)
         + z[(j + 1) * nx + i] * (1 - u) * v + z[(j + 1) * nx + i + 1] * u * v;
  };
  return { zAt, contours, meanSlope: nS ? sumS / nS : 0, maxSlope: maxS, zmin, zmax };
}

function computeEarthworks(cand, site) {
  if (cand._earth != null) return cand._earth;
  const terr = site.terrain;
  if (!terr) return null;
  let vol = 0;
  for (const road of cand.roads) {
    const spec = STREETS[road.type];
    const zs = road.pts.map(p => terr.zAt(p[0], p[1]));
    const smooth = zs.map((_, i) => {
      let s2 = 0, n2 = 0;
      for (let k = -3; k <= 3; k++)
        if (zs[i + k] != null) { s2 += zs[i + k]; n2++; }
      return s2 / n2;
    });
    for (let i = 1; i < road.pts.length; i++) {
      const seg = Math.hypot(road.pts[i][0] - road.pts[i - 1][0],
                             road.pts[i][1] - road.pts[i - 1][1]);
      vol += Math.abs(zs[i] - smooth[i]) * spec.corridor * seg;
    }
  }
  for (const l of cand.lots) {
    const zsq = l.quad.slice(0, 4).map(p => terr.zAt(p[0], p[1]));
    const range = Math.max(...zsq) - Math.min(...zsq);
    vol += ringArea(l.quad) * range / 4;
  }
  cand._earth = Math.round(vol);
  return cand._earth;
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
      pts.push(pts[0].slice());
      roads.push({ pts, type: "lane", part, openStart: false, openEnd: false });
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
  let c1 = [E[0] + (C[0] - E[0]) * 0.45 + genome.b1x * amp, E[1] + (C[1] - E[1]) * 0.45 + genome.b1y * amp];
  let c2 = [C[0] + (Fp[0] - C[0]) * 0.5 + genome.b2x * amp, C[1] + (Fp[1] - C[1]) * 0.5 + genome.b2y * amp];
  let Fin = [Fp[0] + (C[0] - Fp[0]) * 0.25, Fp[1] + (C[1] - Fp[1]) * 0.25];
  // Manual street editing: dragged handles override the derived controls.
  if (isMain && genome.ov) {
    if (genome.ov.E) E = genome.ov.E.slice();
    if (genome.ov.c1) c1 = genome.ov.c1.slice();
    if (genome.ov.c2) c2 = genome.ov.c2.slice();
    if (genome.ov.F) Fin = genome.ov.F.slice();
  }
  if (isMain && genome._ctrlOut)
    genome._ctrlOut.main = { E: E.slice(), c1: c1.slice(), c2: c2.slice(), F: Fin.slice() };
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
    // start = the site/part access (no head there); far end joins the
    // connectivity pass — it snaps to the loop when one is near.
    roads.push({ pts: spine, type: isMain ? "primary" : "secondary", part,
                 openStart: false, openEnd: true });
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
        roads.push({ pts: run, type: "secondary", part,
                     openStart: true, openEnd: true });
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
        roads.push({ pts, type: "lane", part, openStart: false, openEnd: true });
        for (const p of pts) roadSamples.push(p);
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
  const E = (genome.ov && genome.ov.E) ? genome.ov.E
    : mainPart.boundary[Math.floor(genome.tE * mainPart.boundary.length) % mainPart.boundary.length];
  genome._ctrlOut = {};
  for (const part of site.parts)
    buildPartNetwork(part, site, params, genome, rnd, E, roads, heads, roadSamples, plotDepth);
  const ctrl = genome._ctrlOut.main || null;
  delete genome._ctrlOut;

  // --- connectivity pass ----------------------------------------------------
  // Connected networks beat dead-ends (Building for a Healthy Life): every
  // open road end looks for another street of the SAME part within reach and,
  // when a straight in-site connector exists, joins it as a junction. Only
  // ends that genuinely cannot connect keep a turning head, and those are
  // counted and penalised.
  const CONNECT_R = 46;
  let deadEnds = 0, junctions = 0;
  const tryConnect = (road, endIdx) => {
    const p = road.pts[endIdx === 0 ? 0 : road.pts.length - 1];
    let best = null, bestD = CONNECT_R;
    for (const other of roads) {
      if (other === road || other.part !== road.part) continue;
      for (const q of other.pts) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d > 6 && d < bestD) { bestD = d; best = q; }
      }
    }
    if (!best) return false;
    // the connector must stay inside the part
    const steps = Math.max(2, Math.ceil(bestD / 4));
    const conn = [];
    for (let s2 = 1; s2 <= steps; s2++) {
      const q = [p[0] + (best[0] - p[0]) * s2 / steps,
                 p[1] + (best[1] - p[1]) * s2 / steps];
      if (s2 < steps && !inPoly(q[0], q[1], road.part.poly)) return false;
      conn.push(q);
    }
    if (endIdx === 0) road.pts.unshift(...conn.reverse());
    else road.pts.push(...conn);
    for (const q of conn) roadSamples.push(q);
    junctions++;
    return true;
  };
  for (const road of roads) {
    if (road.openStart && !tryConnect(road, 0)) {
      road.openStart = false;
      if (polylineLen(road.pts) > 24) { heads.push(road.pts[0]); deadEnds++; }
    }
    if (road.openEnd && !tryConnect(road, 1)) {
      road.openEnd = false;
      if (polylineLen(road.pts) > 24) { heads.push(road.pts[road.pts.length - 1]); deadEnds++; }
    }
  }

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
  // road land take, approximated analytically (ribbon areas minus junction
  // overlaps). The exact union∩site turf clip is far too slow for the
  // evolution loop, so decorate() computes it only for the layout on show.
  let roadArea = 0;
  for (const fp of fullPolys) roadArea += polyArea(fp);
  roadArea = Math.max(0, Math.min(roadArea - junctions * 42, site.areaM2 * 0.6));
  // spatial hash of road samples: "is this point on a street?" in O(1),
  // replacing point-in-ribbon scans over hundred-vertex polygons in tryQuad
  const RCELL = 9, rgrid = new Map();
  const rIdx = (x, y) => Math.floor(x / RCELL) * 100000 + Math.floor(y / RCELL);
  const rPush = (x, y, hw) => {
    const k = rIdx(x, y);
    let arr = rgrid.get(k); if (!arr) rgrid.set(k, arr = []);
    arr.push([x, y, hw * hw]);
  };
  for (const r of roads) {
    const hw = STREETS[r.type].corridor / 2 + 0.15;   // small safety margin
    const pts2 = r.pts;
    for (let i = 0; i < pts2.length; i++) {
      rPush(pts2[i][0], pts2[i][1], hw);
      if (i + 1 < pts2.length) {
        const seg = Math.hypot(pts2[i + 1][0] - pts2[i][0], pts2[i + 1][1] - pts2[i][1]);
        const nSub = Math.ceil(seg / 2.2);
        for (let s2 = 1; s2 < nSub; s2++)
          rPush(pts2[i][0] + (pts2[i + 1][0] - pts2[i][0]) * s2 / nSub,
                pts2[i][1] + (pts2[i + 1][1] - pts2[i][1]) * s2 / nSub, hw);
      }
    }
  }
  for (const hd of heads) rPush(hd[0], hd[1], HEAD_R + 0.15);
  const onRoad = (x, y) => {
    const ix = Math.floor(x / RCELL), iy = Math.floor(y / RCELL);
    for (let a = ix - 1; a <= ix + 1; a++)
      for (let b = iy - 1; b <= iy + 1; b++) {
        const arr = rgrid.get(a * 100000 + b);
        if (!arr) continue;
        for (const s of arr) {
          const dx = x - s[0], dy = y - s[1];
          if (dx * dx + dy * dy < s[2]) return true;
        }
      }
    return false;
  };

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

  // Flats arrive in whole blocks, so left unguarded they overshoot the dial
  // by a block at a time (a 20% dial was landing 26-35%). pickFlatUnits sizes
  // the next block (2 or 3 storeys) to whichever lands the mix closest to
  // target, and flatOK refuses a block that would move the share AWAY from it.
  const pickFlatUnits = () => {
    const t2 = mixShares.flat;
    const u3 = Math.floor(26 * FLAT_BLD_D * 3 / 82);
    const u2 = Math.floor(26 * FLAT_BLD_D * 2 / 82);
    const err = u => Math.abs((placed.flat + u) / Math.max(1, total + u) - t2);
    return err(u2) < err(u3) ? { units: u2, storeys: 2 } : { units: u3, storeys: 3 };
  };
  const flatOK = () => {
    if (mixShares.flat <= 0) return false;
    const t2 = mixShares.flat;
    const { units: u } = pickFlatUnits();
    const now = total > 0 ? placed.flat / total : 0;
    const after = (placed.flat + u) / Math.max(1, total + u);
    return after <= t2 + 0.02 || Math.abs(after - t2) < Math.abs(now - t2);
  };
  const typeOrder = () => Object.keys(mixShares)
    .filter(k => mixShares[k] > 0 && (k !== "flat" || flatOK()))
    .sort((a, b) =>
      (mixShares[b] - (total > 0 ? placed[b] / total : 0))
      - (mixShares[a] - (total > 0 ? placed[a] / total : 0)));
  const biased = (pos) => {
    // Flats & terraces gravitate to the entrance, detached to the far edges —
    // but a type is only PROMOTED while it is still under its target share,
    // otherwise position bias tramples the mix (the 20%-flats-came-out-35%
    // bug: every placeable entrance frontage kept taking another block).
    const d = Math.hypot(pos[0] - E[0], pos[1] - E[1]) / diag;
    const under = k => (total > 0 ? placed[k] / total : 0) < mixShares[k];
    let order = typeOrder();
    if (d < 0.3) order = order.sort((a, b) =>
      ((a === "flat" || a === "terr") && under(a) ? -1 : 0)
      - ((b === "flat" || b === "terr") && under(b) ? -1 : 0));
    else if (d > 0.62) order = order.sort((a, b) =>
      (a === "det" && under(a) ? -1 : 0) - (b === "det" && under(b) ? -1 : 0));
    return order;
  };

  // every plot edge is sampled (~3 m) so a street can never thread between
  // the corner test points of a deep plot
  const ptBad = (px, py) => !site.inSite(px, py) || onRoad(px, py)
    || site.inExcl(px, py);
  const tryQuad = (quad) => {
    const cx = (quad[0][0] + quad[2][0]) / 2, cy = (quad[0][1] + quad[2][1]) / 2;
    if (ptBad(cx, cy)) return false;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const eL = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nS = Math.max(1, Math.ceil(eL / 3));
      for (let s2 = 0; s2 <= nS; s2++)
        if (ptBad(a[0] + (b[0] - a[0]) * s2 / nS, a[1] + (b[1] - a[1]) * s2 / nS)) return false;
    }
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

  // Two passes: full-depth plots first, then a corner-fill sweep at reduced
  // depth so bends and site corners take a house with a shallower-but-wider
  // garden instead of leaving conspicuous developable-looking pockets.
  const placePass = (depthF) => {
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    if (total >= targetUnits) break;
    const spec = STREETS[road.type];
    const edge = spec.corridor / 2 + 0.55;
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
          if (depthF < 1 && type === "flat") continue;
          const tw = TYPES[type].w;
          if (s + tw > L - 2) continue;
          const depth = type === "flat" ? FLAT_PLOT_D
            : Math.max(FRONT_GARDEN + HOUSE_DEPTH + 3.5, plotDepth * depthF);
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
          const flatInfo = type === "flat" ? pickFlatUnits() : null;
          lots.push({ quad, type, side, runId: thisRun,
                      row: ri * 2 + (side > 0 ? 1 : 0), spos: s,
                      front: [quad[0], quad[1]], tx, ty, nx, ny,
                      units: flatInfo ? flatInfo.units : 1,
                      storeys: flatInfo ? flatInfo.storeys : 2,
                      jit: (rnd() - 0.5) * 1.2 * params.organic });
          if (type === "flat") { placed.flat += flatInfo.units; total += flatInfo.units; }
          else { placed[type]++; total++; }
          s += tw + (runLeft > 0 ? 0.05 : 0.5 + rnd() * 1.4 * params.organic);
          placedHere = true;
          break;
        }
        if (!placedHere) { s += 2; runLeft = 0; }
      }
    }
  }
  };
  placePass(1);
  placePass(0.55);

  // --- shared amenity green reserve -----------------------------------------
  // Before gardens fan out to swallow the leftover land, reserve deliberate
  // shared green pockets (the green-space dial is a floor): the clearest
  // interior spots, kept free of any garden growth.
  const LCELL = 16, lgrid = new Map();
  const lgKey = (x, y) => Math.floor(x / LCELL) * 100000 + Math.floor(y / LCELL);
  lots.forEach((l, idx) => {
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (let i = 0; i < 4; i++) {
      const p = l.quad[i];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    for (let a = Math.floor(x0 / LCELL); a <= Math.floor(x1 / LCELL); a++)
      for (let b = Math.floor(y0 / LCELL); b <= Math.floor(y1 / LCELL); b++) {
        const k = a * 100000 + b;
        let arr = lgrid.get(k); if (!arr) lgrid.set(k, arr = []);
        arr.push(idx);
      }
  });
  const lotHit = (x, y, self) => {
    const arr = lgrid.get(lgKey(x, y));
    if (!arr) return -1;
    for (const idx of arr)
      if (lots[idx] !== self && inRing(x, y, lots[idx].quad)) return idx;
    return -1;
  };
  // Shaped greens, not blobs: rasterise the undeveloped land onto a 6 m cell
  // grid, find the deepest interior pockets, and grow each green cell-by-cell
  // from the pocket's core until the green-space floor is met. The traced,
  // smoothed outline reads as a deliberately shaped space filling its gap.
  const greens = [];              // [{ outline: [[x,y]...], cells: [[cx,cy]...] }]
  const GCELL = 5;
  const gKey = (ix, iy) => ix * 100000 + iy;
  const greenMask = new Set();
  const inGreen = (x, y) => greenMask.has(
    gKey(Math.floor((x - site.minX) / GCELL), Math.floor((y - site.minY) / GCELL)));
  const carveGreens = (reserveTarget, maxN, minSeed, minArea, lotHitFn) => {
      const gCols = Math.ceil((site.maxX - site.minX) / GCELL) + 1;
      const gRows = Math.ceil((site.maxY - site.minY) / GCELL) + 1;
      const open = new Set();
      for (let ix = 0; ix < gCols; ix++)
        for (let iy = 0; iy < gRows; iy++) {
          const cx = site.minX + (ix + 0.5) * GCELL, cy = site.minY + (iy + 0.5) * GCELL;
          if (!site.inSite(cx, cy)) continue;
          if (onRoad(cx, cy)) continue;
          if (site.inExcl(cx, cy)) continue;
          if (greenMask.has(gKey(ix, iy))) continue;
          if (lotHitFn(cx, cy, null) >= 0) {
            // mop-up pass (minSeed 0): a cell straddling a fence still counts
            // when a quarter-point is clear — greens draw underneath plots,
            // so the sliver is claimed without visual overlap
            if (minSeed > 0) continue;
            const q = 0.28 * GCELL;
            let clear = false;
            for (const [qa, qb] of [[q, q], [-q, q], [q, -q], [-q, -q]])
              if (lotHitFn(cx + qa, cy + qb, null) < 0 && !onRoad(cx + qa, cy + qb)
                  && site.inSite(cx + qa, cy + qb)) { clear = true; break; }
            if (!clear) continue;
          }
          open.add(gKey(ix, iy));
        }
      // distance-to-developed-land transform over the open cells
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const depth = new Map();
      let frontier = [];
      for (const k of open) {
        const ix = Math.floor(k / 100000), iy = k % 100000;
        if (!DIRS.every(([a, b]) => open.has(gKey(ix + a, iy + b)))) {
          depth.set(k, 0); frontier.push(k);
        }
      }
      let dd = 0;
      while (frontier.length) {
        dd++;
        const nf = [];
        for (const k of frontier) {
          const ix = Math.floor(k / 100000), iy = k % 100000;
          for (const [a, b] of DIRS) {
            const nk = gKey(ix + a, iy + b);
            if (open.has(nk) && !depth.has(nk)) { depth.set(nk, dd); nf.push(nk); }
          }
        }
        frontier = nf;
      }
      const byDepth = [...depth.entries()].sort((a, b) => b[1] - a[1]);
      let reserved = 0;
      for (const [seed, sd] of byDepth) {
        if (reserved >= reserveTarget || greens.length >= maxN) break;
        if ((minSeed > 0 && sd < minSeed) || greenMask.has(seed)) continue;
        // BFS out from the pocket core; the interior-depth gate (reserve
        // pass) keeps the green hugging its gap instead of leaking down
        // cracks; the mop-up pass claims whole pockets
        const want = Math.min(reserveTarget - reserved,
                              Math.max(reserveTarget / 2, 500));
        const cells = new Set([seed]);
        let ring2 = [seed];
        while (cells.size * GCELL * GCELL < want && ring2.length) {
          const nf = [];
          for (const k of ring2) {
            const ix = Math.floor(k / 100000), iy = k % 100000;
            for (const [a, b] of DIRS) {
              const nk = gKey(ix + a, iy + b);
              if (open.has(nk) && !cells.has(nk) && !greenMask.has(nk)
                  && (depth.get(nk) || 0) >= (minSeed > 1 ? 1 : 0)) {
                cells.add(nk); nf.push(nk);
                if (cells.size * GCELL * GCELL >= want) break;
              }
            }
            if (cells.size * GCELL * GCELL >= want) break;
          }
          ring2 = nf;
        }
        if (cells.size * GCELL * GCELL < minArea) continue;   // too scrappy
        for (const k of cells) greenMask.add(k);
        reserved += cells.size * GCELL * GCELL;
        // trace the rectilinear boundary, then smooth it (Chaikin x2)
        const edges = new Map();
        for (const k of cells) {
          const ix = Math.floor(k / 100000), iy = k % 100000;
          const x0 = site.minX + ix * GCELL, y0 = site.minY + iy * GCELL;
          const segs = [];
          if (!cells.has(gKey(ix, iy - 1))) segs.push([[x0, y0], [x0 + GCELL, y0]]);
          if (!cells.has(gKey(ix + 1, iy))) segs.push([[x0 + GCELL, y0], [x0 + GCELL, y0 + GCELL]]);
          if (!cells.has(gKey(ix, iy + 1))) segs.push([[x0 + GCELL, y0 + GCELL], [x0, y0 + GCELL]]);
          if (!cells.has(gKey(ix - 1, iy))) segs.push([[x0, y0 + GCELL], [x0, y0]]);
          for (const sg of segs) {
            const key2 = sg[0][0].toFixed(1) + "," + sg[0][1].toFixed(1);
            let arr2 = edges.get(key2); if (!arr2) edges.set(key2, arr2 = []);
            arr2.push(sg);
          }
        }
        let outline = null;
        const startKeys = [...edges.keys()];
        for (const sk of startKeys) {
          const first = (edges.get(sk) || []).pop();
          if (!first) continue;
          const loop = [first[0]];
          let cur = first[1];
          for (let guard = 0; guard < 4000; guard++) {
            loop.push(cur);
            const ck = cur[0].toFixed(1) + "," + cur[1].toFixed(1);
            const nxt = (edges.get(ck) || []).pop();
            if (!nxt) break;
            cur = nxt[1];
            if (ck === sk) break;
          }
          if (!outline || loop.length > outline.length) outline = loop;
        }
        if (!outline || outline.length < 4) continue;
        const chaikin = pts => {
          const o2 = [];
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            o2.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            o2.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
          }
          return o2;
        };
        greens.push({
          outline: chaikin(chaikin(outline)),
          cells: [...cells].map(k => {
            const ix = Math.floor(k / 100000), iy = k % 100000;
            return [site.minX + (ix + 0.5) * GCELL, site.minY + (iy + 0.5) * GCELL];
          }),
        });
      }
  };
  const reserveWant = params.greenPct / 100 * site.areaM2;
  if (reserveWant > 60) carveGreens(reserveWant, 3, 2, 140, lotHit);

  // --- garden infill: fan rear gardens into the leftover land ---------------
  // Each rear corner marches away from the street until it meets a street,
  // the site edge, an exclusion, a reserved green, the garden-max cap, or an
  // opposing plot (where facing gardens split the gap so fences meet in the
  // middle). Plots become trapezoids that fill the block — no phantom
  // developable land left on show.
  const gardenMaxOf = l =>
    l.type === "flat" ? l.units * 22
      : Math.max(params.gardenMin + 30, params.gardenMax || 240)
        * (l.type === "det" ? 1.35 : l.type === "terr" ? 0.8 : 1);
  const exts = [];
  for (const l of lots) {
    const w0 = TYPES[l.type].w;
    const rear0 = l.type === "flat" ? Math.max(0, FLAT_PLOT_D - FLAT_BLD_D - 4) : gardenDepth;
    let capExt = Math.min(24, Math.max(0, (gardenMaxOf(l) - rear0 * w0) / w0));
    const per = [0, 0];
    if (capExt > 0.6) {
      for (let c = 0; c < 2; c++) {
        const corner = l.quad[c === 0 ? 3 : 2];   // rear-left, rear-right
        let ext = 0;
        for (let d = 1; d <= capExt; d += 1) {
          const px = corner[0] + l.nx * d, py = corner[1] + l.ny * d;
          if (!site.inSite(px, py) || onRoad(px, py)
              || site.inExcl(px, py) || inGreen(px, py)) break;
          const hit = lotHit(px, py, l);
          if (hit >= 0) {
            const o = lots[hit];
            // facing plot: meet in the middle; side neighbour: stop short
            ext = (l.nx * o.nx + l.ny * o.ny < -0.2) ? Math.max(0, (d - 0.5) / 2) : Math.max(0, d - 2);
            break;
          }
          ext = d;
        }
        per[c] = ext;
      }
      // keep the fan believable — no wildly lopsided fences
      if (per[0] - per[1] > 7) per[0] = per[1] + 7;
      if (per[1] - per[0] > 7) per[1] = per[0] + 7;
      // the rear EDGE between the grown corners must also stay clear — a
      // street can cross it even when both corner rays were clean
      const edgeOK = () => {
        const a = [l.quad[3][0] + l.nx * per[0], l.quad[3][1] + l.ny * per[0]];
        const b = [l.quad[2][0] + l.nx * per[1], l.quad[2][1] + l.ny * per[1]];
        const eL2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nS = Math.max(1, Math.ceil(eL2 / 2.5));
        for (let s2 = 0; s2 <= nS; s2++) {
          const px = a[0] + (b[0] - a[0]) * s2 / nS, py = a[1] + (b[1] - a[1]) * s2 / nS;
          if (!site.inSite(px, py) || onRoad(px, py)
              || site.inExcl(px, py) || inGreen(px, py)) return false;
        }
        return true;
      };
      for (let guard = 0; guard < 20 && (per[0] > 0 || per[1] > 0) && !edgeOK(); guard++) {
        per[0] = Math.max(0, per[0] - 1); per[1] = Math.max(0, per[1] - 1);
      }
    }
    exts.push(per);
  }
  lots.forEach((l, i) => {
    const [eL, eR] = exts[i];
    if (eL <= 0 && eR <= 0) return;
    l.quad[3] = [l.quad[3][0] + l.nx * eL, l.quad[3][1] + l.ny * eL];
    l.quad[2] = [l.quad[2][0] + l.nx * eR, l.quad[2][1] + l.ny * eR];
    l.quad[4] = l.quad[0].slice();
  });

  // --- fence welding: neighbouring gardens share a side boundary ------------
  // Adjacent plots on the same street side fan their side fences to a common
  // point, closing the wedge gaps that curvature opens between rectangles —
  // the plan reads as one continuous run of curtilage, like a drawn scheme.
  {
    const rows = new Map();
    for (const l of lots) {
      let arr = rows.get(l.row); if (!arr) rows.set(l.row, arr = []);
      arr.push(l);
    }
    const weldOK = (x, y) => site.inSite(x, y) && !onRoad(x, y)
      && !site.inExcl(x, y) && !inGreen(x, y);
    for (const arr of rows.values()) {
      arr.sort((a, b) => a.spos - b.spos);
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = arr[i], b = arr[i + 1];
        const gap = Math.hypot(b.quad[0][0] - a.quad[1][0], b.quad[0][1] - a.quad[1][1]);
        if (gap > 6) continue;
        const mx = (a.quad[2][0] + b.quad[3][0]) / 2;
        const my = (a.quad[2][1] + b.quad[3][1]) / 2;
        if (!weldOK(mx, my)) continue;
        // the two re-routed rear edges must stay clear along their length
        const segOK = (p, q) => {
          const eL2 = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const nS = Math.max(1, Math.ceil(eL2 / 2.5));
          for (let s2 = 0; s2 <= nS; s2++)
            if (!weldOK(p[0] + (q[0] - p[0]) * s2 / nS, p[1] + (q[1] - p[1]) * s2 / nS)) return false;
          return true;
        };
        if (!segOK(a.quad[3], [mx, my]) || !segOK([mx, my], b.quad[2])) continue;
        a.quad[2] = [mx, my]; b.quad[3] = [mx, my];
        a.quad[4] = a.quad[0].slice(); b.quad[4] = b.quad[0].slice();
      }
    }
  }

  // --- final invariant sweep ------------------------------------------------
  // Production guarantee: no dwelling stands in a street, off-site, or in an
  // exclusion zone. Any lot whose BUILDING still violates (should be none
  // after the dense checks above) is dropped and the unit counts repaired.
  {
    const bldOK = l => {
      const bq = bldQuad(l).quad;
      for (let i = 0; i < 4; i++) {
        const a = bq[i], b = bq[(i + 1) % 4];
        const eL2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nS = Math.max(1, Math.ceil(eL2 / 2.5));
        for (let s2 = 0; s2 <= nS; s2++) {
          const px = a[0] + (b[0] - a[0]) * s2 / nS, py = a[1] + (b[1] - a[1]) * s2 / nS;
          if (!site.inSite(px, py) || onRoad(px, py)
              || site.inExcl(px, py)) return false;
        }
      }
      return true;
    };
    for (let i = lots.length - 1; i >= 0; i--) {
      if (bldOK(lots[i])) continue;
      const l = lots[i];
      if (l.type === "flat") { placed.flat -= l.units; total -= l.units; }
      else { placed[l.type]--; total--; }
      lots.splice(i, 1);
    }
  }

  // --- mop-up greens: every sizeable leftover pocket becomes deliberate -----
  // After growth and welding, any remaining pocket is claimed as a shaped
  // shared green, so nothing on the plan reads as unclaimed land. Purely
  // presentational (scoring never reads greens), so it runs lazily via
  // decorate() on the layout actually shown.
  const mopupGreens = () => {
    const lgrid2 = new Map();
    lots.forEach((l, idx) => {
      let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
      for (let i = 0; i < 4; i++) {
        const p = l.quad[i];
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      for (let a = Math.floor(x0 / LCELL); a <= Math.floor(x1 / LCELL); a++)
        for (let b = Math.floor(y0 / LCELL); b <= Math.floor(y1 / LCELL); b++) {
          const k = a * 100000 + b;
          let arr = lgrid2.get(k); if (!arr) lgrid2.set(k, arr = []);
          arr.push(idx);
        }
    });
    const lotHit2 = (x, y, self) => {
      const arr = lgrid2.get(lgKey(x, y));
      if (!arr) return -1;
      for (const idx of arr)
        if (lots[idx] !== self && inRing(x, y, lots[idx].quad)) return idx;
      return -1;
    };
    carveGreens(site.areaM2, 96, 0, 90, lotHit2);
  };

  // --- greens, pond, trees --------------------------------------------------
  const lotArea = lots.reduce((a, l) => a + ringArea(l.quad), 0);
  const greenArea = Math.max(0, site.areaM2 - roadArea - lotArea);
  const houseGardens = lots.filter(l => l.type !== "flat")
    .map(l => Math.max(0, ringArea(l.quad) - TYPES[l.type].w * (FRONT_GARDEN + HOUSE_DEPTH)));
  const avgGardenReal = houseGardens.length
    ? houseGardens.reduce((a, v) => a + v, 0) / houseGardens.length : 0;

  const roadLen = roads.reduce((a, r) => a + polylineLen(r.pts), 0);
  // Garden aspect: the rear garden faces away from the street (+normal).
  // Local +y is north, so ny < −0.34 means the garden looks south-ish.
  const houseLots = lots.filter(l => l.type !== "flat");
  const southPct = houseLots.length
    ? houseLots.filter(l => l.ny < -0.34).length / houseLots.length * 100 : 0;
  const stats = statsFor({ placed, total, roadArea, roadLen, greenArea, lotArea,
                           site, params, gardenDepth, southPct, deadEnds, junctions,
                           avgGarden: avgGardenReal,
                           flatBlocks: lots.filter(l => l.type === "flat").length });
  // pond + street trees are display dressing, filled in lazily by decorate()
  // so the evolution loop never pays for them — see decorate() below.
  return { genome, roads, roadClip: null, fullPolys, carrPolys, heads, lots,
           greens, stats, pond: null, trees: [], gardenDepth, ctrl,
           _mopup: mopupGreens };
}

// Display-only dressing (SuDS pond siting + street trees). Deferred out of
// the evolution hot path: candidates are scored without it, and only the
// layout actually shown (or exported) pays for it, once.
function decorate(cand, site) {
  if (cand._dec) return cand;
  cand._dec = true;
  if (cand._mopup) { try { cand._mopup(); } catch (_) {} cand._mopup = null; }
  // exact street land take (union of ribbons ∩ site) for crisp display/export
  if (!cand.roadClip && cand.fullPolys.length) {
    try {
      const inter = boolOp("intersect", site.feat, MF(cand.fullPolys.map(p => p)));
      const clip = flatPolys(inter);
      if (clip.length) cand.roadClip = clip;
    } catch (_) { /* fall through to raw ribbons */ }
  }
  if (!cand.roadClip) cand.roadClip = cand.fullPolys;
  const rnd = mulberry32((cand.genome.seed ^ 0x51ab3e7) >>> 0);
  const lots = cand.lots;
  const roadSamples = [];
  for (const road of cand.roads) for (const p of road.pts) roadSamples.push(p);

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
    if (bx && bd > 13 && !inAnyPoly(bx[0], bx[1], site.exclusionPolys)) {
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
  cand.pond = pond;

  const trees = [];
  for (const road of cand.roads) {
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
  // tree clusters dress the shared greens — planted only on ground that is
  // genuinely clear of every plot (mop-up cells can straddle fence lines),
  // sparsely (≈1 per 90 m² of green, max 5 per green)
  {
    const clearOfLots = (x, y) => {
      for (const l of cand.lots) {
        const dx = x - l.quad[0][0], dy = y - l.quad[0][1];
        if (dx * dx + dy * dy > 4900) continue;
        if (inRing(x, y, l.quad)) return false;
      }
      return true;
    };
    let planted = 0;
    for (const gr of cand.greens || []) {
      if (planted > 60) break;
      let n2 = Math.min(5, Math.floor(gr.cells.length * 25 / 90 / 25) + 1);
      for (let i = 0; i < gr.cells.length && n2 > 0; i++) {
        const c2 = gr.cells[(i * 7 + 3) % gr.cells.length];
        const px = c2[0] + (rnd() - 0.5) * 2.4, py = c2[1] + (rnd() - 0.5) * 2.4;
        if (!clearOfLots(px, py)) continue;
        trees.push([px, py]); planted++; n2--;
      }
    }
  }
  cand.trees = trees;
  return cand;
}

function statsFor({ placed, total, roadArea, roadLen, greenArea, lotArea, site, params, gardenDepth, southPct, deadEnds, junctions, flatBlocks, avgGarden: avgGardenIn }) {
  const siteHa = site.areaM2 / 1e4;
  const houses = placed.det + placed.semi + placed.terr;
  // Gross-to-net honesty: what share of the gross site is actually developed
  // (plots + adopted street), TestFit-style, and the privacy distance the
  // opposing rear windows get (Essex benchmark 25 m, common minimum 21 m).
  const netDevPct = (lotArea + roadArea) / site.areaM2 * 100;
  const backToBack = 2 * gardenDepth + 0;
  const mix = total > 0 ? { flat: placed.flat / total, det: placed.det / total,
    semi: placed.semi / total, terr: placed.terr / total } : { flat: 0, det: 0, semi: 0, terr: 0 };
  const wantFlat = params.flatsPct / 100, hs = 1 - wantFlat;
  const mixDev = Math.abs(mix.flat - wantFlat)
    + Math.abs(mix.det - hs * params.detPct / 100)
    + Math.abs(mix.terr - hs * params.terrPct / 100);
  const greenPct = greenArea / site.areaM2;
  const parking = Math.round(houses * (params.parkRatio ?? 2))
    + Math.ceil(placed.flat * 1.25) + Math.ceil(total * 0.25); // + visitor 0.25/home
  const avgGarden = avgGardenIn != null ? avgGardenIn : (houses > 0
    ? (placed.det * TYPES.det.w + placed.semi * TYPES.semi.w + placed.terr * TYPES.terr.w)
      * gardenDepth / houses : 0);
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
           parking, avgGarden, gia, gdv, cost, poc, flatBlocks, houses,
           netDevPct, backToBack, southPct,
           deadEnds: deadEnds || 0, junctions: junctions || 0,
           exclHa: (site.exclusionArea || 0) / 1e4 };
}

function scoreOf(st, params) {
  const greenPen = Math.max(0, params.greenPct / 100 - st.greenPct) * 400;
  const mixPen = st.mixDev * 180;
  const roadPen = Math.max(0, st.roadPerUnit - 8) * 4 + (st.deadEnds || 0) * 7;
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
  // exclusion zones under the streets: development keeps out, the eye sees why
  for (const ex of site.exclusionPolys || [])
    out += `<path d="${path(ex)}" fill="rgba(224,49,49,0.16)" stroke="#e03131" stroke-width="${detail ? 1 : 0.4}" stroke-dasharray="4 3" fill-rule="evenodd"/>`;
  // footway ribbon then carriageway on top
  out += (cand.roadClip || cand.fullPolys).map(p => `<path d="${path(p)}" fill="#e3e7ea" fill-rule="evenodd"/>`).join("");
  for (const cp of cand.carrPolys)
    out += `<path d="${path(cp)}" fill="#c4cad1"/>`;
  // reserved shared amenity greens: shaped spaces filling their pockets
  for (const gr of cand.greens || [])
    out += `<path d="${path([gr.outline])}" fill="#9ed9a6" stroke="#69bd77" stroke-width="${detail ? 0.8 : 0.3}" stroke-dasharray="3 2"/>`;
  // gardens / plots (rear gardens with under 2h equinox sun read duller)
  for (const l of cand.lots) {
    const shaded = detail && l._sun != null && l._sun < 2 && l.type !== "flat";
    const fill = l.type === "flat" ? "#e5dbff" : (shaded ? "#cfdccf" : "#d8f5dd");
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
    const bq = bldQuad(l);
    const [b0, b1, b2, b3] = bq.quad;
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
  if (detail && site.terrain) {
    for (const seg of site.terrain.contours) {
      const mx = (seg[0][0] + seg[1][0]) / 2, my = (seg[0][1] + seg[1][1]) / 2;
      if (!inAnyPoly(mx, my, site.polys)) continue;
      out += `<line x1="${X(seg[0][0]).toFixed(1)}" y1="${Y(seg[0][1]).toFixed(1)}" x2="${X(seg[1][0]).toFixed(1)}" y2="${Y(seg[1][1]).toFixed(1)}" stroke="rgba(141,110,66,0.4)" stroke-width="0.8"/>`;
    }
  }
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

  // Assembled sites inherit hairline slivers and seams from imperfect parcel
  // geometry — neighbouring INSPIRE plots that almost, but not quite, abut.
  // Those slits read as site boundary, so streets refuse to cross them and
  // the network fragments. A small morphological closing (buffer out, then
  // back in) welds any gap narrower than ~2.5 m before the generator starts;
  // thin genuine features survive (closing fills gaps, it never erodes).
  let siteFeat = ctx.site;
  try {
    const grown = t.buffer(siteFeat, 0.00125, { units: "kilometers" });
    const closed = t.buffer(grown, -0.00125, { units: "kilometers" });
    if (closed && closed.geometry
        && (closed.geometry.type === "Polygon" || closed.geometry.type === "MultiPolygon")
        && t.area(closed) < t.area(siteFeat) * 1.05) {
      try {
        // buffering leaves dense arc vertices; a ~0.2 m simplify trims them
        const s2 = t.simplify(closed, { tolerance: 0.000002, highQuality: false, mutate: false });
        siteFeat = (s2 && s2.geometry) ? s2 : closed;
      } catch (_) { siteFeat = closed; }
    }
  } catch (_) { /* weld is best-effort; raw geometry still works */ }

  // Project to local metres once; precompute everything candidates share.
  const g = siteFeat.geometry;
  const polys4326 = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let lat0 = 0, n = 0;
  for (const poly of polys4326) for (const p of poly[0]) { lat0 += p[1]; n++; }
  lat0 /= Math.max(1, n);
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let ox = 1e12, oy = 1e12;
  for (const poly of polys4326) for (const p of poly[0]) {
    ox = Math.min(ox, p[0] * kx); oy = Math.min(oy, p[1] * ky);
  }
  const polys = polys4326
    .map(poly => poly.map(ring => ring.map(p => [p[0] * kx - ox, p[1] * ky - oy])))
    // drop micro-holes and debris fragments left over from parcel geometry
    .map(poly => poly.filter((ring, i) => i === 0 || ringArea(ring) > 30))
    .filter(poly => ringArea(poly[0]) > 80);
  if (!polys.length) { alert("Site geometry too small to lay out."); return; }
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
    kx, ky, ox, oy, lat0,
  };
  // Membership bitmap: candidate generation asks "is this point in the site /
  // an exclusion?" tens of thousands of times; answer from a 1.2 m grid and
  // fall back to the exact polygon test only in boundary cells (state 2).
  {
    const SC = 1.2;
    const bw = Math.ceil((maxX - minX) / SC) + 3, bh = Math.ceil((maxY - minY) / SC) + 3;
    const mk = polysArr => {
      const m = new Uint8Array(bw * bh);
      for (let ix = 0; ix < bw; ix++)
        for (let iy = 0; iy < bh; iy++)
          m[ix * bh + iy] = inAnyPoly(minX + (ix - 1 + 0.5) * SC, minY + (iy - 1 + 0.5) * SC, polysArr) ? 1 : 0;
      const un = [];
      for (let ix = 0; ix < bw; ix++)
        for (let iy = 0; iy < bh; iy++) {
          const v = m[ix * bh + iy];
          if (v === 2) continue;
          for (let a = Math.max(0, ix - 1); a <= Math.min(bw - 1, ix + 1); a++)
            for (let b = Math.max(0, iy - 1); b <= Math.min(bh - 1, iy + 1); b++)
              if ((m[a * bh + b] & 1) !== (v & 1)) { un.push(ix * bh + iy); a = bw; break; }
        }
      for (const i of un) m[i] = 2;
      // dilate the uncertain band one more ring for safety
      const un2 = [];
      for (const i of un) {
        const ix = Math.floor(i / bh), iy = i % bh;
        for (let a = Math.max(0, ix - 1); a <= Math.min(bw - 1, ix + 1); a++)
          for (let b = Math.max(0, iy - 1); b <= Math.min(bh - 1, iy + 1); b++)
            if (m[a * bh + b] !== 2) un2.push(a * bh + b);
      }
      for (const i of un2) m[i] = 2;
      return m;
    };
    const siteMap = mk(polys);
    const lookup = (m, polysArr) => (x, y) => {
      const ix = Math.floor((x - minX) / SC) + 1, iy = Math.floor((y - minY) / SC) + 1;
      if (ix < 0 || iy < 0 || ix >= bw || iy >= bh) return false;
      const v = m[ix * bh + iy];
      if (v !== 2) return v === 1;
      return inAnyPoly(x, y, polysArr);
    };
    site.inSite = lookup(siteMap, polys);
    site._mkExcl = () => {
      site.inExcl = site.exclusionPolys.length
        ? lookup(mk(site.exclusionPolys), site.exclusionPolys) : (() => false);
    };
  }
  // Hard-constraint exclusion zones (flood, heritage, habitat) arrive already
  // clipped to the site: no dwelling, plot or pond may land in one.
  site.exclusionPolys = [];
  site.exclusionArea = 0;
  for (const ex of ctx.exclusions || []) {
    const gg = ex.geometry || ex;
    const ps = gg.type === "Polygon" ? [gg.coordinates]
      : gg.type === "MultiPolygon" ? gg.coordinates : [];
    for (const poly of ps) {
      const lp = poly.map(ring => ring.map(p => [p[0] * kx - ox, p[1] * ky - oy]));
      site.exclusionPolys.push(lp);
      site.exclusionArea += polyArea(lp);
    }
  }
  site._mkExcl();
  const siteHa = areaM2 / 1e4;

  const params = {
    objective: "target",
    density: ctx.density || 35, netPct: ctx.netPct || 80,
    flatsPct: Math.round(ctx.assumptions.flatMixPct ?? 20),
    detPct: 30, terrPct: 20,
    gardenMin: 80, gardenMax: 240, greenPct: 10, organic: 0.7, parkRatio: 2,
    ppm2: ctx.ppm2, assumptions: ctx.assumptions || {},
  };

  const POP = 12;
  let pop = [], gen = 0, best = null, bestHist = [], running = false, timer = null, focusIdx = null;
  let editMode = false, dragKey = null;

  // Terrain loads in the background; layouts render immediately and the
  // contours/slope/earthworks appear when the elevations arrive.
  fetchTerrain(site).then(t => { site.terrain = t; render(); })
    .catch(err => console.warn("terrain unavailable", err));

  const randGenome = () => ({
    tE: Math.random(), b1x: Math.random() * 2 - 1, b1y: Math.random() * 2 - 1,
    b2x: Math.random() * 2 - 1, b2y: Math.random() * 2 - 1,
    branchGap: 45 + Math.random() * 60, loop: Math.random(),
    seed: (Math.random() * 1e9) | 0,
  });
  // pw (mutation power) rises when the search stagnates, so a stuck run
  // starts testing genuinely different configurations — new entrance points,
  // flipped loops — instead of only nudging the incumbent.
  const mutate = (gnm, pw = 1) => ({
    tE: Math.random() < 0.05 * pw ? Math.random()
      : (gnm.tE + (Math.random() - 0.5) * 0.12 * pw + 1) % 1,
    b1x: gnm.b1x + (Math.random() - 0.5) * 0.5 * pw, b1y: gnm.b1y + (Math.random() - 0.5) * 0.5 * pw,
    b2x: gnm.b2x + (Math.random() - 0.5) * 0.5 * pw, b2y: gnm.b2y + (Math.random() - 0.5) * 0.5 * pw,
    branchGap: Math.min(110, Math.max(40, gnm.branchGap + (Math.random() - 0.5) * 18 * pw)),
    loop: Math.random() < 0.12 * pw ? Math.random() : gnm.loop,
    seed: Math.random() < 0.4 ? (Math.random() * 1e9) | 0 : gnm.seed,
  });
  const cross = (a, b) => ({
    tE: Math.random() < 0.5 ? a.tE : b.tE,
    b1x: Math.random() < 0.5 ? a.b1x : b.b1x, b1y: Math.random() < 0.5 ? a.b1y : b.b1y,
    b2x: Math.random() < 0.5 ? a.b2x : b.b2x, b2y: Math.random() < 0.5 ? a.b2y : b.b2y,
    branchGap: Math.random() < 0.5 ? a.branchGap : b.branchGap,
    loop: Math.random() < 0.5 ? a.loop : b.loop,
    seed: (Math.random() * 1e9) | 0,
  });
  // How different two street genomes are — used to keep the elite spread
  // across distinct topologies instead of four clones of the leader.
  const gDiff = (a, b) => {
    const dt = Math.min(Math.abs(a.tE - b.tE), 1 - Math.abs(a.tE - b.tE));
    return dt * 2
      + Math.hypot(a.b1x - b.b1x, a.b1y - b.b1y) * 0.4
      + Math.hypot(a.b2x - b.b2x, a.b2y - b.b2y) * 0.4
      + Math.abs(a.branchGap - b.branchGap) / 70
      + ((a.loop > 0.55) === (b.loop > 0.55) ? 0 : 0.8);
  };
  const build = gnm => { try { return generateCandidate(site, params, gnm); } catch (_) { return null; } };
  // Population rebuilds are chunked: a few candidates immediately so the view
  // responds, the rest on idle ticks — the UI never freezes for a full build.
  const resetPop = () => {
    if (m && m._fillT) { clearTimeout(m._fillT); m._fillT = null; }
    pop = [];
    for (let i = 0; i < 10 && pop.length < 4; i++) {
      const c = build(randGenome()); if (c) pop.push(c);
    }
    gen = 0; best = null; bestHist = []; focusIdx = null; sinceUp = 0;
    render();
    const fill = () => {
      m._fillT = null;
      if (running || pop.length >= POP) return;
      const c = build(randGenome());
      if (c) pop.push(c);
      render();
      if (pop.length < POP) m._fillT = setTimeout(fill, 40);
    };
    m._fillT = setTimeout(fill, 40);
  };
  let sinceUp = 0;   // generations since the best score last improved
  const step = () => {
    if (!pop.length) return;
    for (const c of pop) c._s = scoreOf(c.stats, params);
    if (best) best._s = scoreOf(best.stats, params);
    // best-ever always competes for elite, so its genes never leave the pool
    const cands = best && !pop.includes(best) ? [best, ...pop] : pop.slice();
    cands.sort((a, b) => b._s - a._s);
    const elite = [];
    for (const c of cands) {
      if (elite.every(e => gDiff(e.genome, c.genome) > 0.15)) elite.push(c);
      if (elite.length === 4) break;
    }
    for (const c of cands) {
      if (elite.length === 4) break;
      if (!elite.includes(c)) elite.push(c);
    }
    const pw = Math.min(3, 1 + sinceUp / 15);
    const next = [...elite];
    let tries = 0;
    if (sinceUp > 0 && sinceUp % 40 === 0) {
      // restart wave: the elite survives, everything else refills fresh
      while (next.length < POP && tries++ < POP * 3) {
        const c = build(randGenome()); if (c) next.push(c);
      }
    }
    while (next.length < POP && tries++ < POP * 4) {
      const p1 = elite[(Math.random() * elite.length) | 0];
      const r = Math.random();
      let g;
      if (r < 0.12) g = randGenome();
      else if (r < 0.40 && elite.length > 1) {
        let p2 = p1;
        while (p2 === p1) p2 = elite[(Math.random() * elite.length) | 0];
        g = mutate(cross(p1.genome, p2.genome), 1);
      } else g = mutate(p1.genome, pw);
      const c = build(g);
      next.push(c || p1);
    }
    while (next.length < POP) next.push(elite[next.length % elite.length]);
    pop = next;
    for (const c of pop) c._s = scoreOf(c.stats, params);
    pop.sort((a, b) => b._s - a._s);
    if (!best || pop[0]._s > best._s) { best = pop[0]; sinceUp = 0; }
    else sinceUp++;
    bestHist.push(best._s);
    if (bestHist.length > 700) bestHist = bestHist.filter((_, i) => i % 2 === 0);
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
          <label><span>Garden max <b id="lg-gmv">${params.gardenMax}</b> m²</span>
            <input type="range" id="lg-gmax" min="120" max="420" step="20" value="${params.gardenMax}"></label>
          <label><span>Green space <b id="lg-grv">${params.greenPct}</b>% floor</span>
            <input type="range" id="lg-green" min="0" max="30" step="2" value="${params.greenPct}"></label>
          <label><span>Street character <b id="lg-ov">organic</b></span>
            <input type="range" id="lg-organic" min="0" max="100" step="10" value="${Math.round(params.organic * 100)}"></label>
          <label><span>Parking <b id="lg-pv">${params.parkRatio}</b>/house + visitor</span>
            <input type="range" id="lg-park" min="1" max="3" step="0.5" value="${params.parkRatio}"></label>
          <button type="button" id="lg-run" class="plot-mode-btn">▶ Evolve</button>
          <div class="lg-gen">gen <b id="lg-gen">0</b></div>
          <canvas id="lg-spark" width="170" height="34"></canvas>
          <button type="button" id="lg-edit" class="ghost">✋ Edit streets</button>
          <button type="button" id="lg-adopt" class="plot-mode-btn">Adopt into appraisal</button>
          <button type="button" id="lg-export" class="ghost">Export GeoJSON</button>
          <details class="lg-std"><summary>Standards applied ⓘ</summary>
            <ul>
              <li>Streets: 5.5 m carriageway + 2 m footways (primary), 4.8 m
                secondary, shared-surface lanes — Manual for Streets tones.</li>
              <li>Turning heads sized for an 11.2 m refuse vehicle.</li>
              <li>Frontages: det 12.2 m (house set in ≥2.3 m each side — truly
                detached) · semi 6.7 m · terrace 5.3 m; back-to-back privacy
                reported vs 21 m minimum.</li>
              <li>Rear gardens fan out to fill the block between the min and
                max dials (Essex Design Guide benchmark 100 m²; detached
                +35%, terraces −20%), meeting opposing fences midway — no
                phantom developable land left on the plan.</li>
              <li>Flats get communal amenity gardens at ~22 m²/unit behind
                the parking court.</li>
              <li>Parking: dial per house on-plot + 0.25 visitor/home
                (typical SPD rates); flats 1.25/unit in courts.</li>
              <li>Exclusion zones: flood zones 2/3, ancient woodland, SSSI/SAC/
                SPA/Ramsar, scheduled monuments — no homes placed within.</li>
              <li>Green space floor reserved as deliberate shared greens
                (dashed pockets, tree-planted) before gardens grow, plus a
                SuDS pond on larger sites (Schedule 3 expectation).</li>
            </ul>
          </details>
          <p class="lg-note">Capacity & massing study — not an engineering
            layout: visibility splays, levels and drainage design follow.</p>
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
            <span><i style="background:#9ed9a6;border:1px dashed #69bd77"></i>shared green</span>
            <span><i style="background:#c4cad1"></i>street</span>
            <span><i style="background:#74c0fc"></i>SuDS pond</span>
            <span><i style="background:#37b24d;border-radius:50%"></i>tree</span>
            <span><i style="background:rgba(224,49,49,0.25);border:1px dashed #e03131"></i>no-build</span>
          </div>
        </div>
      </div>
    </div>`;

  const render = () => {
    const grid = m.querySelector("#lg-grid");
    grid.innerHTML = pop.map((cnd, i) => `
      <div class="lg-cell${(focusIdx === i || (i === 0 && focusIdx == null)) ? " lg-top" : ""}" data-i="${i}">
        ${cnd._thumb || (cnd._thumb = svgOf(cnd, site, 150, 128, false))}
        <span>${cnd.stats.total} · ${cnd.stats.density.toFixed(0)}/ha${params.objective === "profit" ? " · " + cnd.stats.poc.toFixed(0) + "%" : ""}</span>
      </div>`).join("");
    grid.querySelectorAll(".lg-cell").forEach(cell =>
      cell.addEventListener("click", () => { focusIdx = +cell.dataset.i; render(); }));
    const show = focusIdx != null ? pop[focusIdx] : (best || pop[0]);
    window.__lgShow = show; window.__lgSite = site;   // harness/debug hooks
    if (show) {
      decorate(show, site);
      computeSun(show, site);
      let bigSvg = svgOf(show, site, 430, 360, true);
      if (editMode && show.ctrl) {
        const pad = 14, w2 = 430, h2 = 360;
        const sc2 = Math.min((w2 - 2 * pad) / Math.max(1, site.maxX - site.minX),
                             (h2 - 2 * pad) / Math.max(1, site.maxY - site.minY));
        const hX = x => pad + (x - site.minX) * sc2;
        const hY = y => h2 - pad - (y - site.minY) * sc2;
        let hs = "";
        for (const k of ["E", "c1", "c2", "F"]) {
          const p = show.ctrl[k];
          hs += `<circle class="lg-handle" data-k="${k}" cx="${hX(p[0]).toFixed(1)}" cy="${hY(p[1]).toFixed(1)}" r="7" fill="rgba(76,110,245,0.85)" stroke="#fff" stroke-width="2" style="cursor:grab"/>`;
        }
        bigSvg = bigSvg.replace("</svg>", hs + "</svg>");
      }
      m.querySelector("#lg-best-svg").innerHTML = bigSvg;
      const st = show.stats;
      const cell = (v, l) => `<div class="cm-cell"><b>${v}</b><span>${l}</span></div>`;
      m.querySelector("#lg-best-stats").innerHTML = `<div class="cm-grid">`
        + cell(st.total.toLocaleString(), "dwellings")
        + cell(st.density.toFixed(1) + "/ha", "gross density")
        + cell(st.netDevPct.toFixed(0) + "%", "gross → net developed")
        + cell(st.poc.toFixed(0) + "%", "PoC (excl. land)")
        + cell(Math.round(st.roadLen) + " m", "street length")
        + cell(st.roadPerUnit.toFixed(1) + " m", "street / home")
        + cell(st.parking.toLocaleString(), "parking spaces")
        + cell(Math.round(st.avgGarden) + " m²", "avg rear garden")
        + cell((st.greenPct * 100).toFixed(0) + "%", "green space")
        + cell(Math.round(st.backToBack) + " m" + (st.backToBack >= 21 ? " ✓" : " ✗"), "back-to-back")
        + cell(st.southPct.toFixed(0) + "%", "S-facing gardens")
        + (st.exclHa > 0.005 ? cell(st.exclHa.toFixed(2) + " ha", "excluded (no-build)")
                             : cell(st.total > 0 ? Math.round(st.gia).toLocaleString() + " m²" : "—", "total GIA"))
        + `</div><p class="lg-mix">${mixLbl(st)}${show.pond ? " · SuDS pond" : ""} · ${show.trees.length} street trees · ${st.junctions} junction${st.junctions === 1 ? "" : "s"} · ${st.deadEnds} cul${st.deadEnds === 1 ? "" : "s"}-de-sac</p>`
        + `<p class="lg-mix">☀ median garden sun ${show._sun.median} h (${show._sun.pct3.toFixed(0)}% ≥ 3 h, equinox)`
        + (site.terrain ? ` · ⛰ slope mean ${site.terrain.meanSlope.toFixed(1)}% max ${site.terrain.maxSlope.toFixed(0)}%${site.terrain.maxSlope > 12 ? " ⚠" : ""} · earthworks ~${(computeEarthworks(show, site) || 0).toLocaleString()} m³` : " · ⛰ terrain loading…") + `</p>`;
      m._exportCand = show;
    }
    m.querySelector("#lg-gen").textContent = gen
      + (running && genRate >= 1 ? ` · ${genRate.toFixed(0)}/s` : "");
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

  // Evolution runs as fast as the machine allows: each tick spends up to
  // ~110 ms stepping generations back-to-back, then renders once. Display
  // work (thumbnails, sun, pond/trees) is cached or deferred to the shown
  // layout only, so nearly the whole budget goes on testing new layouts.
  let genRate = 0;
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
    const b = m.querySelector("#lg-run");
    b.textContent = on ? "❚❚ Pause" : "▶ Evolve";
    b.classList.toggle("active", on);
    if (timer) { clearTimeout(timer); timer = null; }
    genRate = 0;
    if (on) timer = setTimeout(loopTick, 0);
  };

  // Sliders update their label instantly; the (costly) population rebuild is
  // debounced so dragging stays fluid.
  const debouncedReset = () => { clearTimeout(m._deb); m._deb = setTimeout(resetPop, 300); };
  const slider = (id, key, lbl, map) => {
    const el = m.querySelector(id);
    el.addEventListener("input", () => {
      params[key] = map ? map(Number(el.value)) : Number(el.value);
      const lab = m.querySelector(lbl);
      if (lab) lab.textContent = map ? el.value : el.value;
      debouncedReset();
    });
  };
  slider("#lg-density", "density", "#lg-dv");
  slider("#lg-flats", "flatsPct", "#lg-fv");
  slider("#lg-det", "detPct", "#lg-dtv");
  slider("#lg-terr", "terrPct", "#lg-tv");
  slider("#lg-garden", "gardenMin", "#lg-gv");
  slider("#lg-gmax", "gardenMax", "#lg-gmv");
  slider("#lg-green", "greenPct", "#lg-grv");
  slider("#lg-park", "parkRatio", "#lg-pv");
  {
    const el = m.querySelector("#lg-organic");
    el.addEventListener("input", () => {
      params.organic = Number(el.value) / 100;
      m.querySelector("#lg-ov").textContent =
        params.organic < 0.25 ? "formal" : params.organic < 0.65 ? "relaxed" : "organic";
      debouncedReset();
    });
  }
  m.querySelector("#lg-obj").addEventListener("change", e => { params.objective = e.target.value; resetPop(); });
  m.querySelector("#lg-run").addEventListener("click", () => setRunning(!running));
  m.querySelector("#lg-close").addEventListener("click", () => { setRunning(false); m.hidden = true; });
  m.addEventListener("click", e => { if (e.target === m) { setRunning(false); m.hidden = true; } });
  // Manual street shaping: pause evolution, drag the blue handles (entrance,
  // two bends, far end) — the layout regenerates live around your street.
  const bigBox = m.querySelector("#lg-best-svg");
  const clientToLocal = (ev) => {
    const svg = bigBox.querySelector("svg");
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const pad = 14, w2 = 430, h2 = 360;
    const sc2 = Math.min((w2 - 2 * pad) / Math.max(1, site.maxX - site.minX),
                         (h2 - 2 * pad) / Math.max(1, site.maxY - site.minY));
    const vx = (ev.clientX - r.left) / r.width * w2;
    const vy = (ev.clientY - r.top) / r.height * h2;
    return [site.minX + (vx - pad) / sc2, site.minY + (h2 - pad - vy) / sc2];
  };
  m.querySelector("#lg-edit").addEventListener("click", () => {
    editMode = !editMode;
    m.querySelector("#lg-edit").classList.toggle("active", editMode);
    m.querySelector("#lg-edit").textContent = editMode ? "✔ Done editing" : "✋ Edit streets";
    if (editMode) {
      setRunning(false);
      if (focusIdx == null) focusIdx = 0;
    }
    render();
  });
  bigBox.addEventListener("pointerdown", (ev) => {
    if (!editMode) return;
    const t2 = ev.target.closest && ev.target.closest(".lg-handle");
    if (!t2) return;
    dragKey = t2.dataset.k;
    ev.preventDefault();
    bigBox.setPointerCapture && bigBox.setPointerCapture(ev.pointerId);
  });
  bigBox.addEventListener("pointermove", (ev) => {
    if (!editMode || !dragKey) return;
    const p = clientToLocal(ev);
    if (!p) return;
    const cand = pop[focusIdx != null ? focusIdx : 0];
    if (!cand || !cand.ctrl) return;
    const ov = { E: cand.ctrl.E, c1: cand.ctrl.c1, c2: cand.ctrl.c2, F: cand.ctrl.F };
    ov[dragKey] = p;
    const g2 = { ...cand.genome, ov };
    const next = build(g2);
    if (next) {
      pop[focusIdx != null ? focusIdx : 0] = next;
      render();
    }
  });
  const endDrag = () => { dragKey = null; };
  bigBox.addEventListener("pointerup", endDrag);
  bigBox.addEventListener("pointercancel", endDrag);

  m.querySelector("#lg-adopt").addEventListener("click", () => {
    const cand = m._exportCand;
    if (!cand || !ctx.onAdopt) return;
    ctx.onAdopt({ units: cand.stats.total,
                  flatsPct: Math.round(cand.stats.mix.flat * 100) });
    setRunning(false);
    m.hidden = true;
  });
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
}

// test/harness access to internal geometry helpers (no runtime cost)
export const _test = { bldQuad, inPoly, inRing, ringArea, quadOverlap };
