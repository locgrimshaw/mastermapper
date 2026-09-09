// Full geometric audit of generated layouts. Usage: node audit.mjs [flats%] [seed-site]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
const FLATS = Number(process.argv[2] ?? 20);
const SITE = process.argv[3] || 'blob';       // blob | twopart
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e).slice(0, 300)));
await page.route(/https:\/\/(unpkg\.com|api\.mapbox\.com)\/.*/, route => {
  const u = route.request().url();
  const f = 'cdn/' + createHash('md5').update(u + '\n').digest('hex').slice(0, 12);
  try { route.fulfill({ status: 200, contentType: u.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(f) }); }
  catch { route.abort(); }
});
const nodeProxy = async route => {
  try {
    const r = await fetch(route.request().url(), { method: route.request().method(), headers: route.request().headers() });
    const headers = {};
    r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v; });
    route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
  } catch { route.abort(); }
};
await page.route(/https:\/\/tiles\.openfreemap\.org\/.*/, nodeProxy);
await page.route(/https:\/\/vwljbgyrsnnubrbjaxbc\.supabase\.co\/.*/, nodeProxy);
await page.route(/https:\/\/api\.open-meteo\.com\/.*/, nodeProxy);
await page.goto('http://localhost:8100/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(async ({ flats, siteKind }) => {
  const lat0 = 51.29, lng0 = 0.19;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let site;
  if (siteKind === 'twopart') {
    const P = (x, y) => [lng0 + x / kx, lat0 + y / ky];
    const west = [P(0,0), P(120,0), P(120,170), P(60.2,170), P(60.2,60), P(59.8,60), P(59.8,170), P(0,170), P(0,0)];
    const east = [P(120.5,0), P(240,0), P(240,170), P(120.5,170), P(120.5,0)];
    site = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: [[west],[east]] } };
  } else {
    const ring = [];
    for (let i = 0; i <= 48; i++) {
      const a = i / 48 * 2 * Math.PI;
      const r = 128 + 34 * Math.sin(a * 2 + 0.8) + 18 * Math.sin(a * 3 + 2.1);
      ring.push([lng0 + r * Math.cos(a) / kx, lat0 + r * Math.sin(a) / ky]);
    }
    site = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
  }
  window.__lgMod = await import('/src/layoutgen.js?v=audit' + Date.now());
  window.__lgMod.openLayoutGen({ site, siteHa: 5.1, name: "Audit", density: 35, netPct: 80,
    ppm2: 5200, assumptions: { flatMixPct: flats, salesAdjPct: 120, buildPm2House: 1900, buildPm2Flat: 2200, sitePrepPerPlot: 6, infraPerPlot: 8 },
    onAdopt: () => {} });
}, { flats: FLATS, siteKind: SITE });
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById('lg-run')?.click());
await page.waitForTimeout(15000);

const report = await page.evaluate(() => {
  const cand = window.__lgShow, site = window.__lgSite, T2 = window.__lgMod._test;
  if (!cand) return { fatal: 'no candidate' };
  const { bldQuad, inPoly, inRing, ringArea, quadOverlap } = T2;
  const inAny = (x, y, polys) => { for (const p of polys) if (inPoly(x, y, p)) return true; return false; };
  const ribbons = cand.fullPolys;
  const rbox = ribbons.map(fp => {
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (const p of fp[0]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    return [x0, y0, x1, y1];
  });
  const onRoadExact = (x, y) => {
    for (let f = 0; f < ribbons.length; f++) {
      const b = rbox[f];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (inPoly(x, y, ribbons[f])) return true;
    }
    return false;
  };
  const edgeSamples = (quad, step) => {
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / step));
      for (let s = 0; s <= n; s++) pts.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
    }
    return pts;
  };
  const v = { bldOnRoad: [], plotOnRoad: [], outOfSite: [], inExclusion: [], bldOverlap: [], badQuad: [] };
  const lots = cand.lots;
  lots.forEach((l, i) => {
    const bq = bldQuad(l).quad;
    for (const p of edgeSamples(bq, 2.5))
      if (onRoadExact(p[0], p[1])) { v.bldOnRoad.push(i); break; }
    let hit = false;
    for (const p of edgeSamples(l.quad, 3))
      if (onRoadExact(p[0], p[1])) { hit = true; break; }
    if (hit) v.plotOnRoad.push(i);
    for (const p of [...edgeSamples(l.quad, 4), [(l.quad[0][0]+l.quad[2][0])/2, (l.quad[0][1]+l.quad[2][1])/2]]) {
      if (!inAny(p[0], p[1], site.polys)) { v.outOfSite.push(i); break; }
    }
    for (let k = 0; k < 4; k++)
      if (inAny(l.quad[k][0], l.quad[k][1], site.exclusionPolys)) { v.inExclusion.push(i); break; }
    if (ringArea(l.quad) < 20) v.badQuad.push(i);
  });
  for (let i = 0; i < lots.length; i++)
    for (let j = i + 1; j < lots.length; j++) {
      const a = bldQuad(lots[i]).quad, b = bldQuad(lots[j]).quad;
      const dx = a[0][0] - b[0][0], dy = a[0][1] - b[0][1];
      if (dx * dx + dy * dy > 2500) continue;
      if (lots[i].runId && lots[i].runId === lots[j].runId) continue;
      if (quadOverlap(a, b)) v.bldOverlap.push([i, j]);
    }
  // weld coverage among eligible neighbours
  let eligible = 0, welded = 0;
  const rows = new Map();
  for (const l of lots) { let a = rows.get(l.row); if (!a) rows.set(l.row, a = []); a.push(l); }
  const unweldedEx = [];
  for (const arr of rows.values()) {
    arr.sort((a, b) => a.spos - b.spos);
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i], b = arr[i + 1];
      const gap = Math.hypot(b.quad[0][0] - a.quad[1][0], b.quad[0][1] - a.quad[1][1]);
      if (gap > 6) continue;
      eligible++;
      if (Math.hypot(a.quad[2][0] - b.quad[3][0], a.quad[2][1] - b.quad[3][1]) < 0.05) welded++;
      else if (unweldedEx.length < 5) unweldedEx.push([lots.indexOf(a), lots.indexOf(b), gap.toFixed(1)]);
    }
  }
  // scrap survey: 2m raster of land in nothing
  const gcells = (cand.greens || []).flatMap(g => g.cells);
  const inGreenMask = (x, y) => gcells.some(c => Math.abs(x - c[0]) <= 3.2 && Math.abs(y - c[1]) <= 3.2);
  let scrap = 0, cells = 0;
  const scrapPts = [];
  for (let x = site.minX; x < site.maxX; x += 2.5)
    for (let y = site.minY; y < site.maxY; y += 2.5) {
      if (!inAny(x, y, site.polys)) continue;
      cells++;
      if (onRoadExact(x, y) || inAny(x, y, site.exclusionPolys) || inGreenMask(x, y)) continue;
      let inLot = false;
      for (const l of lots) {
        const dx = x - l.quad[0][0], dy = y - l.quad[0][1];
        if (dx * dx + dy * dy > 3600) continue;
        if (inRing(x, y, l.quad)) { inLot = true; break; }
      }
      if (!inLot) { scrap++; if (scrapPts.length < 4000) scrapPts.push([x, y]); }
    }
  // cluster scrap points into components (grid adjacency at 2.5 m)
  const skey = p2 => Math.round(p2[0] / 2.5) * 100000 + Math.round(p2[1] / 2.5);
  const sset = new Map(scrapPts.map(p2 => [skey(p2), p2]));
  const seen = new Set(); const comps = [];
  for (const [k, p2] of sset) {
    if (seen.has(k)) continue;
    let sz = 0; let q = [k]; seen.add(k);
    let cx2 = 0, cy2 = 0;
    while (q.length) {
      const kk = q.pop(); sz++;
      const pp = sset.get(kk); cx2 += pp[0]; cy2 += pp[1];
      for (const dk of [100000, -100000, 1, -1, 100001, -100001, 99999, -99999]) {
        const nk = kk + dk;
        if (sset.has(nk) && !seen.has(nk)) { seen.add(nk); q.push(nk); }
      }
    }
    comps.push({ m2: Math.round(sz * 6.25), at: [Math.round(cx2 / sz), Math.round(cy2 / sz)] });
  }
  comps.sort((a, b) => b.m2 - a.m2);
  return {
    lots: lots.length,
    v: Object.fromEntries(Object.entries(v).map(([k, a]) => [k, a.length])),
    examples: { bldOnRoad: v.bldOnRoad.slice(0, 6), plotOnRoad: v.plotOnRoad.slice(0, 6), unwelded: unweldedEx },
    weld: { eligible, welded, pct: eligible ? (100 * welded / eligible).toFixed(0) : '—' },
    scrapPct: (100 * scrap / cells).toFixed(1),
    scrapComps: { n: comps.length, over140: comps.filter(c => c.m2 > 140).length, top: comps.slice(0, 8) },
    greensN: (cand.greens || []).length,
    greensM2: Math.round((cand.greens || []).reduce((a, g) => a + g.cells.length * 36, 0)),
    stats: cand.stats && { total: cand.stats.total, density: cand.stats.density.toFixed(1), green: (cand.stats.greenPct * 100).toFixed(0) },
  };
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: `audit_${SITE}_${FLATS}.png` });
console.log('errors:', errs.slice(0, 5));
await browser.close();
