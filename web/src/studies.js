// studies.js — the "Studies" section: long-form, data-led pages built on the
// tool's own datasets. First study: UK Stadium Analysis, read entirely from
// stadium_metrics + stadium_tiers (migrations 0089/0090), with every modelled
// assumption editable on the page and every figure recomputed live.
//
// Charts are hand-rolled SVG (no library): thin marks, one axis, hairline
// grid, a hover tooltip on every mark and a table view behind every chart.

const NATIONS = ["England", "Scotland", "Wales", "Northern Ireland"];
const SPORT_GROUPS = { Football: s => s === "Football", Rugby: s => /^Rugby/.test(s || ""),
  Cricket: s => s === "Cricket", Other: s => !/^(Football|Rugby|Cricket)/.test(s || "") };
// Three location groups (the scatter colour cap is three hues).
const GROUPS = [
  { k: "urban", label: "Urban core", types: ["City centre", "Inner-urban neighbourhood"] },
  { k: "suburban", label: "Suburban", types: ["Suburban", "Sports campus"] },
  { k: "peripheral", label: "Edge & out-of-town", types: ["Edge of town / rural", "Out-of-town / retail park"] },
];
const groupOf = t => (GROUPS.find(g => g.types.includes(t)) || GROUPS[2]).k;
const ELITE = ["Premier League", "EFL Championship", "Scottish Premiership", "Premiership Rugby",
  "United Rugby Championship", "Super League"];
const TYPOLOGIES = ["City centre", "Inner-urban neighbourhood", "Suburban", "Sports campus",
  "Out-of-town / retail park", "Edge of town / rural"];

export function initStudies(d) {
  const { getSupabase, onShowStadium } = d;
  const root = document.getElementById("studies");
  const S = { rows: null, tiers: null, f: { nation: "all", minCap: 1000, sport: "all" },
              a: { dph: 50, devShare: 25, spend: 45 }, sort: { k: "anchor_index", dir: -1 }, q: "" };

  // ---- formatting -----------------------------------------------------------
  const fmt = n => n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-GB");
  const compact = n => {
    if (n == null || isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "bn";
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "m";
    if (a >= 1e4) return Math.round(n / 1e3) + "k";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return Number.isInteger(n) || a >= 100 ? String(Math.round(n)) : String(+n.toFixed(1));
  };
  const pct = (n, dp = 0) => n == null || isNaN(n) ? "—" : `${(100 * n).toFixed(dp)}%`;
  const fx = n => n == null ? "—" : n.toFixed(1);
  const gbp = n => n == null ? "—" : "£" + compact(n);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const median = xs => { const v = xs.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
  // Published costs for pre-1990 grounds are the original Victorian/post-war
  // build, not today's stadium, so cost analysis uses modern builds only.
  const costOk = r => r.cost_real_gbp && r.capacity && r.opened >= 1990;
  const sum = xs => xs.reduce((a, b) => a + (Number(b) || 0), 0);
  const short = s => { const t = String(s || "").replace(/\s+(Football Club|FC)$/i, ""); return t.length > 30 ? t.slice(0, 29) + "…" : t; };

  // ---- data -------------------------------------------------------------------
  async function load() {
    if (S.rows) return;
    const sb = getSupabase();
    const [m, t] = await Promise.all([
      sb.from("stadium_metrics").select("*").limit(2000),
      sb.from("stadium_tiers").select("*"),
    ]);
    if (m.error) throw m.error;
    S.tiers = Object.fromEntries((t.data || []).map(x => [x.tier, { ...x }]));
    S.tiersDefault = JSON.parse(JSON.stringify(S.tiers));
    S.rows = (m.data || []).map(r => ({ ...r, group: groupOf(r.typology), elite: ELITE.includes(r.tier) }));
  }
  // Modelled columns recomputed from the (editable) tier assumptions.
  function derive(r) {
    const t = S.tiers[r.tier] || { matchdays: 20, fill_rate: 0.3 };
    const crowd = r.capacity ? r.capacity * t.fill_rate : null;
    const everyday = (r.pop_800 || 0) + (r.jobs_800 || 0);
    return Object.assign(r, {
      md: t.matchdays, fill: t.fill_rate, crowd,
      visits: crowd ? crowd * t.matchdays : null,
      idle: 365 - t.matchdays,
      surge: crowd && everyday ? crowd / everyday : null,
      everyday: everyday || null,
      spendYr: crowd ? crowd * t.matchdays * S.a.spend : null,
    });
  }
  function filtered() {
    const f = S.f;
    return S.rows.map(derive).filter(r => (r.capacity || 0) >= f.minCap
      && (f.nation === "all" || r.nation === f.nation)
      && (f.sport === "all" || SPORT_GROUPS[f.sport](r.sport)));
  }

  // ---- tooltip ------------------------------------------------------------------
  let tip;
  function showTip(e, lines) {
    if (!tip) { tip = document.createElement("div"); tip.className = "sy-tip"; document.body.appendChild(tip); }
    tip.replaceChildren(...lines.map(([v, l, c], i) => {
      const row = document.createElement("div");
      if (i === 0 && !l) { row.className = "sy-tip-h"; row.textContent = v; return row; }
      if (c) { const k = document.createElement("i"); k.style.background = c; row.appendChild(k); }
      const b = document.createElement("b"); b.textContent = v; row.appendChild(b);
      if (l) { const s = document.createElement("span"); s.textContent = " " + l; row.appendChild(s); }
      return row;
    }));
    tip.style.display = "block";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => { if (tip) tip.style.display = "none"; };
  function bindTips(svg, fn) {
    svg.addEventListener("pointermove", e => {
      const t = e.target.closest("[data-i]");
      if (!t) return hideTip();
      showTip(e, fn(Number(t.dataset.i), t));
    });
    svg.addEventListener("pointerleave", hideTip);
    svg.addEventListener("focusin", e => {
      const t = e.target.closest("[data-i]");
      if (!t) return;
      const r = t.getBoundingClientRect();
      showTip({ clientX: r.right, clientY: r.top }, fn(Number(t.dataset.i), t));
    });
    svg.addEventListener("focusout", hideTip);
  }

  // ---- chart primitives ----------------------------------------------------------
  let W = 640;
  const fit = el => { W = Math.max(320, Math.round(el.clientWidth || 640)); };
  const niceMax = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
  // Clean tick steps for a niceMax()ed maximum (1/2/2.5/5 × 10^k).
  const ticks = max => { const m = max / 10 ** Math.floor(Math.log10(max)), n = m === 2 ? 4 : 5; return Array.from({ length: n + 1 }, (_, i) => max * i / n); };
  const rangeTicks = (lo, hi) => { const st = niceMax((hi - lo) / 5); const t = []; for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) t.push(v); return t; };
  const logTicks = (lo, hi) => { const t = []; for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) t.push(10 ** p); return t.filter(v => v >= lo * 0.999 && v <= hi * 1.001); };
  // Horizontal bars: rows [{label, v, sub?, hi?}], one series.
  function hbars(el, rows, o = {}) {
    fit(el);
    const lw = Math.min(o.labelW || 190, Math.round(W * 0.4)), bh = 18, gap = 8, top = 22, H = top + rows.length * (bh + gap) + 6;
    const max = o.max || niceMax(Math.max(o.ref || 0, ...rows.map(r => r.v || 0)) * 1.04);
    const x = v => lw + (W - lw - 70) * Math.max(0, v) / max;
    const g = [`<svg viewBox="0 0 ${W} ${H}" class="sy-svg" role="img" aria-label="${esc(o.title || "")}">`];
    (o.tickVals || ticks(max)).forEach((t, k) => g.push(`<line class="sy-grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 4}"/>`
      + (W >= 480 || k % 2 === 0 ? `<text class="sy-ax" x="${x(t)}" y="${top - 10}" text-anchor="middle">${o.tick ? o.tick(t) : compact(t)}</text>` : "")));
    if (o.ref != null) g.push(`<line class="sy-ref" x1="${x(o.ref)}" x2="${x(o.ref)}" y1="${top - 6}" y2="${H - 4}"/><text class="sy-ax sy-ref-t" x="${x(o.ref) + 4}" y="${H - 6}">${esc(o.refLabel || "")}</text>`);
    rows.forEach((r, i) => {
      const y = top + i * (bh + gap), w = Math.max(1, x(r.v || 0) - lw);
      g.push(`<text class="sy-lbl" x="${lw - 8}" y="${y + bh / 2 + 4}" text-anchor="end">${esc(fitText(r.label, lw))}</text>`);
      g.push(`<path class="sy-bar${r.hi ? " hi" : ""}" d="M${lw},${y}h${Math.max(0, w - 4)}a4,4 0 0 1 4,4v${bh - 8}a4,4 0 0 1 -4,4h${-Math.max(0, w - 4)}z" style="fill:${r.color || "var(--sy-s1)"}"/>`);
      g.push(`<text class="sy-val" x="${lw + w + 6}" y="${y + bh / 2 + 4}">${esc(o.val ? o.val(r) : compact(r.v))}</text>`);
      g.push(`<rect class="sy-hit" data-i="${i}" tabindex="0" x="0" y="${y - gap / 2}" width="${W}" height="${bh + gap}"/>`);
    });
    el.innerHTML = g.join("") + "</svg>";
    bindTips(el.querySelector("svg"), i => o.tip ? o.tip(rows[i]) : [[rows[i].label], [o.val ? o.val(rows[i]) : fmt(rows[i].v), o.unit || ""]]);
  }
  // Columns over ordered categories; series = [{k, label, color}], rows [{label, [k]: v}].
  function columns(el, rows, series, o = {}) {
    fit(el);
    const H = o.h || 220, l = 46, b = 34, t = 14, iw = W - l - 10, ih = H - t - b;
    const max = o.max || niceMax(Math.max(...rows.flatMap(r => series.map(s => r[s.k] || 0))));
    const band = iw / rows.length, bw = Math.min(24, (band - 10) / series.length - 2);
    const y = v => t + ih - ih * v / max;
    const g = [`<svg viewBox="0 0 ${W} ${H}" class="sy-svg" role="img" aria-label="${esc(o.title || "")}">`];
    for (const tk of ticks(max)) g.push(`<line class="sy-grid" x1="${l}" x2="${W - 10}" y1="${y(tk)}" y2="${y(tk)}"/><text class="sy-ax" x="${l - 6}" y="${y(tk) + 4}" text-anchor="end">${o.tick ? o.tick(tk) : compact(tk)}</text>`);
    if (o.ref != null) g.push(`<line class="sy-ref" x1="${l}" x2="${W - 10}" y1="${y(o.ref)}" y2="${y(o.ref)}"/><text class="sy-ax sy-ref-t" x="${l + 4}" y="${y(o.ref) - 5}">${esc(o.refLabel || "")}</text>`);
    rows.forEach((r, i) => {
      const cx = l + band * i + band / 2, x0 = cx - (series.length * (bw + 2) - 2) / 2;
      series.forEach((s, j) => {
        const v = r[s.k] || 0, yy = y(v), h = t + ih - yy, x = x0 + j * (bw + 2);
        if (h > 0.5) g.push(`<path class="sy-bar" d="M${x},${t + ih}v${-Math.max(0, h - 4)}a4,4 0 0 1 4,-4h${bw - 8}a4,4 0 0 1 4,4v${Math.max(0, h - 4)}z" style="fill:${s.color}"/>`);
      });
      g.push(`<text class="sy-ax" x="${cx}" y="${H - b + 16}" text-anchor="middle">${esc(r.label)}</text>`);
      g.push(`<rect class="sy-hit" data-i="${i}" tabindex="0" x="${l + band * i}" y="${t}" width="${band}" height="${ih}"/>`);
    });
    g.push(`<line class="sy-base" x1="${l}" x2="${W - 10}" y1="${t + ih}" y2="${t + ih}"/>`);
    if (o.xLabel) g.push(`<text class="sy-ax" x="${l + iw / 2}" y="${H - 2}" text-anchor="middle">${esc(o.xLabel)}</text>`);
    el.innerHTML = g.join("") + "</svg>";
    bindTips(el.querySelector("svg"), i => [[o.tipHead ? o.tipHead(rows[i]) : rows[i].label],
      ...series.map(s => [o.val ? o.val(rows[i][s.k]) : fmt(rows[i][s.k]), s.label, s.color])]);
  }
  // Scatter: pts [{x, y, label, c (color), r?}], nearest-point hover.
  function scatter(el, pts, o = {}) {
    fit(el);
    const H = o.h || 380, l = 66, b = 40, t = 14, rgt = 16, iw = W - l - rgt, ih = H - t - b;
    const xs = pts.map(p => p.x).filter(v => v > 0 || !o.logX), ys = pts.map(p => p.y).filter(v => v > 0 || !o.logY);
    const xr = o.xr || [o.logX ? Math.min(...xs) : 0, o.logX ? Math.max(...xs) : niceMax(Math.max(...xs))];
    const yr = o.yr || [o.logY ? Math.min(...ys) : 0, o.logY ? Math.max(...ys) : niceMax(Math.max(...ys))];
    const sx = v => o.logX ? l + iw * (Math.log10(v) - Math.log10(xr[0])) / (Math.log10(xr[1]) - Math.log10(xr[0])) : l + iw * (v - xr[0]) / (xr[1] - xr[0]);
    const sy = v => o.logY ? t + ih - ih * (Math.log10(v) - Math.log10(yr[0])) / (Math.log10(yr[1]) - Math.log10(yr[0])) : t + ih - ih * (v - yr[0]) / (yr[1] - yr[0]);
    const g = [`<svg viewBox="0 0 ${W} ${H}" class="sy-svg" role="img" aria-label="${esc(o.title || "")}">`];
    const xt = o.logX ? logTicks(xr[0], xr[1]) : rangeTicks(xr[0], xr[1]), yt = o.logY ? logTicks(yr[0], yr[1]) : rangeTicks(yr[0], yr[1]);
    for (const v of xt) g.push(`<line class="sy-grid" x1="${sx(v)}" x2="${sx(v)}" y1="${t}" y2="${t + ih}"/><text class="sy-ax" x="${sx(v)}" y="${t + ih + 15}" text-anchor="middle">${o.xTick ? o.xTick(v) : compact(v)}</text>`);
    for (const v of yt) g.push(`<line class="sy-grid" x1="${l}" x2="${l + iw}" y1="${sy(v)}" y2="${sy(v)}"/><text class="sy-ax" x="${l - 6}" y="${sy(v) + 4}" text-anchor="end">${o.yTick ? o.yTick(v) : compact(v)}</text>`);
    const cid = "clip-" + ((el.closest("figure") || {}).id || Math.random().toString(36).slice(2));
    g.push(`<clipPath id="${cid}"><rect x="${l}" y="${t}" width="${iw}" height="${ih}"/></clipPath><g clip-path="url(#${cid})">${(o.under || (() => ""))(sx, sy, { l, t, iw, ih })}`);
    const order = pts.map((p, i) => i).sort((a, b) => (pts[a].hi ? 1 : 0) - (pts[b].hi ? 1 : 0));
    for (const i of order) {
      const p = pts[i];
      if ((o.logX && !(p.x > 0)) || (o.logY && !(p.y > 0))) continue;
      g.push(`<circle class="sy-dot${p.hi ? " hi" : ""}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.r || 4}" style="fill:${p.c}"/>`);
    }
    g.push("</g>");
    // Selective direct labels; a label that would collide with one already
    // placed tries below the dot, then is dropped (the tooltip still has it).
    const placed = [];
    for (const p of pts.filter(p => p.lab)) {
      const X = sx(p.x), Y = sy(p.y), right = X < l + iw * 0.72, w = p.lab.length * 6.6 + 4;
      for (const dy of [-6, 14]) {
        const bx = right ? X + 7 : X - 7 - w, by = Y + dy - 10;
        if (placed.some(q => bx < q[0] + q[2] && bx + w > q[0] && by < q[1] + 13 && by + 13 > q[1])) continue;
        placed.push([bx, by, w]);
        g.push(`<text class="sy-dlab" x="${X + (right ? 7 : -7)}" y="${Y + dy}" text-anchor="${right ? "start" : "end"}">${esc(p.lab)}</text>`);
        break;
      }
    }
    g.push(`<text class="sy-ax" x="${l + iw / 2}" y="${H - 4}" text-anchor="middle">${esc(o.xLabel || "")}</text>`);
    g.push(`<text class="sy-ax" transform="translate(12 ${t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(o.yLabel || "")}</text>`);
    g.push(`<rect class="sy-hit sy-area" x="${l}" y="${t}" width="${iw}" height="${ih}"/>`);
    el.innerHTML = g.join("") + "</svg>";
    const svg = el.querySelector("svg"), pt = svg.createSVGPoint();
    const P = pts.map(p => ((o.logX && !(p.x > 0)) || (o.logY && !(p.y > 0))) ? null : [sx(p.x), sy(p.y)]);
    svg.addEventListener("pointermove", e => {
      pt.x = e.clientX; pt.y = e.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      let bi = -1, bd = 26 * 26;
      P.forEach((c, i) => { if (!c) return; const dd = (c[0] - q.x) ** 2 + (c[1] - q.y) ** 2; if (dd < bd) { bd = dd; bi = i; } });
      svg.querySelectorAll(".sy-dot.hover").forEach(n => n.classList.remove("hover"));
      if (bi < 0) return hideTip();
      showTip(e, o.tip(pts[bi]));
    });
    svg.addEventListener("pointerleave", hideTip);
    if (o.onClick) svg.addEventListener("click", e => {
      pt.x = e.clientX; pt.y = e.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      let bi = -1, bd = 26 * 26;
      P.forEach((c, i) => { if (!c) return; const dd = (c[0] - q.x) ** 2 + (c[1] - q.y) ** 2; if (dd < bd) { bd = dd; bi = i; } });
      if (bi >= 0) o.onClick(pts[bi]);
    });
  }
  // Dumbbell: rows [{label, a, b}] on one log or linear axis; two series.
  function dumbbell(el, rows, sa, sb, o = {}) {
    fit(el);
    const lw = Math.min(170, Math.round(W * 0.36)), rh = 22, top = 24, H = top + rows.length * rh + 8;
    const vals = rows.flatMap(r => [r.a, r.b]).filter(v => v > 0);
    const lo = o.lo || 10 ** Math.floor(Math.log10(Math.min(...vals))), hi = o.hi || 10 ** Math.ceil(Math.log10(Math.max(...vals)));
    const x = v => lw + (W - lw - 20) * (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
    const g = [`<svg viewBox="0 0 ${W} ${H}" class="sy-svg" role="img" aria-label="${esc(o.title || "")}">`];
    for (const t of logTicks(lo, hi)) for (const m of [1, 2, 5]) {
      const v = t * m; if (v > hi) continue;
      g.push(`<line class="sy-grid${m === 1 ? "" : " minor"}" x1="${x(v)}" x2="${x(v)}" y1="${top - 6}" y2="${H - 4}"/>`);
      if (m !== 5) g.push(`<text class="sy-ax" x="${x(v)}" y="${top - 10}" text-anchor="middle">${compact(v)}</text>`);
    }
    rows.forEach((r, i) => {
      const y = top + i * rh + rh / 2;
      g.push(`<text class="sy-lbl" x="${lw - 8}" y="${y + 4}" text-anchor="end">${esc(fitText(r.label, lw))}</text>`);
      if (r.a > 0 && r.b > 0) g.push(`<line class="sy-dbl" x1="${x(r.a)}" x2="${x(r.b)}" y1="${y}" y2="${y}"/>`);
      if (r.b > 0) g.push(`<circle class="sy-dot" cx="${x(r.b)}" cy="${y}" r="5" style="fill:${sb.color}"/>`);
      if (r.a > 0) g.push(`<circle class="sy-dot" cx="${x(r.a)}" cy="${y}" r="5" style="fill:${sa.color}"/>`);
      g.push(`<rect class="sy-hit" data-i="${i}" tabindex="0" x="0" y="${y - rh / 2}" width="${W}" height="${rh}"/>`);
    });
    el.innerHTML = g.join("") + "</svg>";
    bindTips(el.querySelector("svg"), i => [[rows[i].label], [compact(rows[i].a), sa.label, sa.color], [compact(rows[i].b), sb.label, sb.color],
      ...(o.extra ? o.extra(rows[i]) : [])]);
  }
  const fitText = (t, px) => { const n = Math.floor((px - 10) / 6.4); t = String(t ?? ""); return t.length > n ? t.slice(0, Math.max(3, n - 1)) + "…" : t; };
  const legend = items => `<div class="sy-legend">${items.map(([l, c, kind]) => `<span><i class="${kind || ""}" style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>`;
  const C = { s1: "var(--sy-s1)", s2: "var(--sy-s2)", s3: "var(--sy-s3)", mute: "var(--sy-mute)" };
  const GCOL = { urban: C.s1, suburban: C.s3, peripheral: C.s2 };
  const groupLegend = legend(GROUPS.map(g => [g.label, GCOL[g.k]]));

  // A chart card with a table-view twin.
  function card(id, title, sub, opts = {}) {
    return `<figure class="sy-card${opts.wide ? " wide" : ""}" id="${id}">
      <figcaption><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</figcaption>
      ${opts.legend || ""}
      <div class="sy-chart"></div>
      ${opts.note ? `<p class="sy-note">${opts.note}</p>` : ""}
      <details class="sy-tv"><summary>Table view</summary><div class="sy-tv-body"></div></details>
    </figure>`;
  }
  function tableView(id, head, rows) {
    const el = root.querySelector(`#${id} .sy-tv-body`);
    if (!el) return;
    el.innerHTML = `<table class="sy-mini"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  const chartEl = id => root.querySelector(`#${id} .sy-chart`);

  // ---- page shell ---------------------------------------------------------------------
  function shell() {
    root.innerHTML = `
      <div class="sy-top">
        <div class="sy-brand">MasterMapper <span>Studies</span></div>
        <nav class="sy-tabs"><button type="button" class="active">UK Stadium Analysis</button></nav>
        <button type="button" class="sy-close" title="Back to the map">← Map</button>
      </div>
      <div class="sy-scroll"><article class="sy-page" id="sy-page"><p class="sy-loading">Loading the stadium evidence base…</p></article></div>`;
    root.querySelector(".sy-close").addEventListener("click", close);
  }

  function filtersHTML() {
    const f = S.f;
    const opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${l}</option>`;
    return `<div class="sy-filters" role="group" aria-label="Filters">
      <label>Nation <select data-f="nation">${opt("all", "UK", f.nation)}${NATIONS.map(n => opt(n, n, f.nation)).join("")}</select></label>
      <label>Sport <select data-f="sport">${opt("all", "All sports", f.sport)}${Object.keys(SPORT_GROUPS).map(n => opt(n, n, f.sport)).join("")}</select></label>
      <label>Capacity <select data-f="minCap">${[1000, 5000, 10000, 20000, 40000].map(v => opt(v, `${v.toLocaleString()}+ seats`, f.minCap)).join("")}</select></label>
      <span class="sy-count" id="sy-count"></span>
      <button type="button" class="sy-btn" id="sy-csv">Download data (CSV)</button>
    </div>`;
  }

  // ---- the study ------------------------------------------------------------------------
  function render() {
    const R = filtered();
    const page = root.querySelector("#sy-page");
    const seats = sum(R.map(r => r.capacity));
    const visits = sum(R.map(r => r.visits));
    const seatDaysUsed = sum(R.map(r => (r.capacity || 0) * r.md)) / Math.max(1, seats * 365);
    const land = sum(R.map(r => r.regen_ha)), parking = sum(R.map(r => r.parking_ha));
    const homes = land * S.a.devShare / 100 * S.a.dph;
    const walkPop = sum(R.map(r => r.reach_walk15));
    const withImd = R.filter(r => r.imd_1500 != null);
    const deprived = withImd.filter(r => r.imd_1500 >= 70).length / Math.max(1, withImd.length);
    const deprivedElite = withImd.filter(r => r.elite);
    const deprivedEliteShare = deprivedElite.filter(r => r.imd_1500 >= 70).length / Math.max(1, deprivedElite.length);
    const withPt = R.filter(r => r.pt_share != null && r.reach_drive20 > 0);
    const ptMed = median(withPt.map(r => r.pt_share));
    const ptHalf = withPt.filter(r => r.pt_share < 0.5).length / Math.max(1, withPt.length);
    const ptOver = withPt.filter(r => r.pt_share > 1).length;
    const big = R.filter(r => (r.capacity || 0) >= 15000 && r.beds_per_100 != null);
    const hotelDeserts = big.filter(r => r.beds_per_100 < 25);
    const withSurge = R.filter(r => r.surge != null);
    const surge1 = withSurge.filter(r => r.surge > 1).length / Math.max(1, withSurge.length);
    const surge5 = withSurge.filter(r => r.surge > 5).length;
    const quad = R.filter(r => r.imd_1500 >= 60 && r.regen_ha >= median(R.map(x => x.regen_ha)) && r.reach_pt45 >= median(R.map(x => x.reach_pt45)));
    const spend = sum(R.map(r => r.spendYr));
    const typ = TYPOLOGIES.map(t => ({ t, rows: R.filter(r => r.typology === t) })).filter(x => x.rows.length);
    const urbanShare = sum(R.filter(r => r.group === "urban").map(r => r.capacity)) / Math.max(1, seats);

    page.innerHTML = `
      <header class="sy-hero">
        <p class="sy-kicker">Study · Stadiums as place anchors</p>
        <h1>The UK's stadiums are open ${pct(seatDaysUsed, 1)} of the time.</h1>
        <p class="sy-lede">${fmt(R.length)} grounds and ${compact(seats)} seats host about ${compact(visits)} matchday visits a year, then stand empty on ${fmt(365 - Math.round(seatDaysUsed * 365))} days of 365.
        Within a ten-minute walk of them sit <b>${fmt(land)} hectares</b> of surface car parks, brownfield, publicly owned and low-intensity land. ${pct(deprived)} of grounds sit in the most deprived 30% of neighbourhoods. This study measures every ground on the same evidence: catchments by foot, car and the national bus, tram, Underground and rail timetable; land supply; deprivation; and the visitor economy. It asks where a stadium could anchor everyday place-making, not just ${fmt(Math.round(seatDaysUsed * 365))} afternoons a year.</p>
        ${filtersHTML()}
      </header>

      <section class="sy-tiles">
        ${tile(compact(seats), "seats", `${fmt(R.length)} grounds`)}
        ${tile(compact(visits), "matchday visits / yr", "modelled, editable below")}
        ${tile(gbp(spend), "matchday spend / yr", `at £${S.a.spend} a head outside the ground`)}
        ${tile(`${fmt(land)} ha`, "regenerable land ≤ 800 m", `${fmt(parking)} ha of it parking`)}
        ${tile(compact(homes), "homes, if built out", `${S.a.devShare}% at ${S.a.dph} dph`)}
        ${tile(compact(walkPop), "people ≤ 15 min walk", "Meta 30 m population")}
      </section>

      <section class="sy-findings">
        <h2>Ten findings</h2>
        <ol>
          <li><b>The idle asset.</b> Weighted by seats, UK grounds are in use on ${pct(seatDaysUsed, 1)} of days. That leaves ${compact(seats * 365 * (1 - seatDaysUsed))} empty seat-days a year, against ${compact(visits)} matchday visits.</li>
          <li><b>Matchday is a different town.</b> At ${pct(surge1)} of grounds the matchday crowd outnumbers everyone who lives or works within 800 m, and at ${fmt(surge5)} it is more than five times as large. For top-flight and second-tier grounds the median is ${fx(median(R.filter(r => r.elite).map(r => r.surge)))}×; for all others it is ${fx(median(R.filter(r => !r.elite).map(r => r.surge)))}×. The bigger the club, the more a matchday remakes the neighbourhood.</li>
          <li><b>Grounds sit where need is highest.</b> ${pct(deprived)} of grounds, and ${pct(deprivedEliteShare)} of top-flight ones, are in the most deprived 30% of neighbourhoods. A random spread would give 30%. The anchor and the need are in the same place.</li>
          <li><b>Land is the hidden asset.</b> The median ground has ${median(R.map(r => r.regen_ha))?.toFixed(1) ?? "—"} ha of regenerable land within 800 m. ${fmt(R.filter(r => r.regen_ha >= 20).length)} grounds have 20 ha or more, enough for a new neighbourhood.</li>
          <li><b>Car parks and public land are the first sites.</b> Surface and multi-storey parking covers ${fmt(parking)} ha within 800 m of the ${fmt(R.length)} grounds, and ${fmt(sum(R.map(r => r.public_ha)))} ha is publicly owned. ${fmt(R.filter(r => r.parking_ha >= 5).length)} grounds have 5 ha or more of parking within a ten-minute walk.</li>
          <li><b>Public transport vs the car.</b> Leaving at 17:00 on a Saturday, 45 minutes by bus, tram, Underground and rail reaches a median ${pct(ptMed)} of the people a 20-minute drive does. At ${pct(ptHalf)} of grounds it reaches less than half; at ${fmt(ptOver)} grounds, mostly in big-city cores, it reaches more than the car.</li>
          <li><b>The centre wins on reach.</b> Urban-core grounds hold ${pct(urbanShare)} of seats. Their median 45-minute public-transport reach is ${compact(median(R.filter(r => r.group === "urban").map(r => r.reach_pt45)))} people, against ${compact(median(R.filter(r => r.group === "peripheral").map(r => r.reach_pt45)))} for edge and out-of-town grounds.</li>
          <li><b>Hotel deserts.</b> ${fmt(hotelDeserts.length)} of ${fmt(big.length)} grounds with 15,000+ seats have fewer than 25 hotel bedspaces per 100 seats within 5 km. Visiting fans' overnight spend leaks to the next city.</li>
          <li><b>A shortlist writes itself.</b> ${fmt(quad.length)} grounds combine above-median land, above-median public-transport reach and a deprived neighbourhood (60th percentile or more). These are the places where a stadium-led regeneration has the land, the access and the need.</li>
          <li><b>The cost of a seat.</b> Across ${fmt(R.filter(costOk).length)} stadiums built since 1990 with a published cost, investment in today's money runs from ${gbp(Math.min(...R.filter(costOk).map(r => r.cost_real_gbp / r.capacity)))} to ${gbp(Math.max(...R.filter(costOk).map(r => r.cost_real_gbp / r.capacity)))} per seat. Over a 30-year life, that is a median ${gbp(median(R.filter(costOk).map(r => r.cost_real_gbp / r.capacity / (r.md * 30))))} of capital per seat per matchday, with the seat idle on the other ${fmt(365 - Math.round(seatDaysUsed * 365))} days.</li>
        </ol>
      </section>

      <h2 class="sy-h2">1 · The idle asset</h2>
      <div class="sy-grid2">
        ${card("c-days", "Days in use a year, by competition", "Home fixtures (league + typical cups) out of 365. Each bar is one competition tier; the grey line marks a quarter of the year.")}
        ${card("c-decade", "Seats by decade of opening", "Capacity of today's grounds by the year the current stadium opened: the Victorian grounds of the 1880s-1900s, then the rebuild that followed the 1990 Taylor Report.")}
      </div>

      <h2 class="sy-h2">2 · Matchday vs everyday</h2>
      ${card("c-surge", "How much a matchday changes a place", "Each dot is a ground: capacity × modelled fill (crowd) against residents + workers within 800 m. Diagonals mark 1×, 3×, 10× and 30× surges. Click a dot to open it on the map.", { wide: true, legend: groupLegend })}
      <div class="sy-grid2">
        ${card("c-surgetop", "Biggest matchday surges", "Crowd ÷ everyday population within 800 m.")}
        ${card("c-typo", "Where the seats are", "Seats by location typology (classified from density, jobs, land use and rail usage).")}
      </div>

      <h2 class="sy-h2">3 · Need, land &amp; the regeneration shortlist</h2>
      <div class="sy-grid2">
        ${card("c-imd", "Grounds by neighbourhood deprivation", "Share of grounds in each national deprivation decile (population-weighted within 1.5 km). If grounds were spread at random, every decile would hold 10%.", { legend: legend([["Top-flight & second tier", C.s1], ["All other grounds", C.s2]]) })}
        ${card("c-land", "Most land within a 10-minute walk", "Union of car parks, brownfield, publicly owned and low-intensity retail, industrial and storage land within 800 m (ha).")}
      </div>
      ${card("c-quad", "The regeneration quadrant", "Deprivation (x) against regenerable land within 800 m (y). Dot size is public-transport reach. Top right is the shortlist: need plus land. The ten highest regeneration-index grounds are labelled.", { wide: true, legend: groupLegend })}

      <h2 class="sy-h2">4 · Access: who can get there without a car</h2>
      ${card("c-pt", "Public transport vs car reach · the 30 largest grounds", "People within 45 min by public transport (leaving 17:00 Saturday, all buses, trams, Underground, DLR and rail) and within a 20-minute drive. Log scale; sorted by the public-transport share. Great Britain only (no Northern Ireland timetable).", { wide: true, legend: legend([["Public transport 45 min", C.s1], ["Drive 20 min", C.s2]]) })}
      <div class="sy-grid2">
        ${card("c-ptshare", "Public-transport share by location", "Median PT-45 reach as a share of drive-20 reach.")}
        ${card("c-walk", "Biggest walk-in neighbourhoods", "People within a 15-minute walk on the street network: the ground's everyday community.")}
      </div>

      <h2 class="sy-h2">5 · The visitor economy</h2>
      <div class="sy-grid2">
        ${card("c-hotel", "Hotel deserts · grounds with 15,000+ seats", "Hotel bedspaces within 5 km per 100 seats, the 15 lowest. The grey line is the median for these grounds.")}
        ${card("c-spend", "What stadiums cost · today's money per seat", "Build cost (Wikidata, with its year) uprated by RPI, divided by capacity, against year opened. Grounds opened since 1990 with a published cost; dot size is capacity.", {})}
      </div>

      <h2 class="sy-h2">6 · Typology fingerprints</h2>
      <figure class="sy-card wide" id="c-finger"><figcaption><h3>Six kinds of stadium place</h3><p>Medians by location typology. Shading runs light to dark within each column.</p></figcaption><div class="sy-finger"></div></figure>

      <h2 class="sy-h2">7 · Index league tables</h2>
      <p class="sy-p">Each index is a 0–100 percentile composite across UK grounds with 1,000+ seats. <b>Regeneration</b>: land within 800 m 40%, deprivation 25%, PT reach 20%, low local prices 15%. <b>Social value</b>: deprivation 35%, walk-in population 35%, schools 15%, sports facilities 15%. <b>Visitor</b>: beds per seat 35%, venue capacity 25%, food & drink 20%, rail usage 20%. <b>Anchor</b>: the mean of the three.</p>
      <div class="sy-boards">${["anchor_index", "regen_index", "social_index", "visitor_index"].map(k => board(k, R)).join("")}</div>

      <h2 class="sy-h2">8 · Every ground, compared</h2>
      <div class="sy-tbl-tools"><input type="search" id="sy-q" placeholder="Find a ground, club or town…" value="${esc(S.q)}" /><span class="sy-note">Click a column to sort · click a row to open it on the map</span></div>
      <div class="sy-tbl-wrap"><table class="sy-tbl" id="sy-tbl"></table></div>

      <h2 class="sy-h2">9 · Assumptions (edit them)</h2>
      <p class="sy-p">Everything modelled on this page follows from these values. Change any of them and every figure, chart and finding above recomputes.</p>
      <div class="sy-assume">
        <table class="sy-mini sy-tiers"><thead><tr><th>Tier</th><th>Grounds</th><th>Home matchdays / yr</th><th>Average fill</th><th>Basis</th></tr></thead><tbody>
          ${Object.values(S.tiers).sort((a, b) => a.rank - b.rank || a.tier.localeCompare(b.tier)).map(t => `<tr><td>${esc(t.tier)}</td><td>${fmt(R.filter(r => r.tier === t.tier).length)}</td>
            <td><input type="number" min="1" max="365" step="1" data-tier="${esc(t.tier)}" data-k="matchdays" value="${t.matchdays}"></td>
            <td><input type="number" min="0.05" max="1" step="0.05" data-tier="${esc(t.tier)}" data-k="fill_rate" value="${t.fill_rate}"></td><td class="sy-dim">${esc(t.note || "")}</td></tr>`).join("")}
        </tbody></table>
        <div class="sy-assume-side">
          <label>Spend per visitor outside the ground (£) <input type="number" data-a="spend" min="0" step="5" value="${S.a.spend}"></label>
          <label>Share of regenerable land built out (%) <input type="number" data-a="devShare" min="0" max="100" step="5" value="${S.a.devShare}"></label>
          <label>Density (homes / ha) <input type="number" data-a="dph" min="10" max="400" step="10" value="${S.a.dph}"></label>
          <button type="button" class="sy-btn ghost" id="sy-reset">Reset to defaults</button>
        </div>
      </div>

      <h2 class="sy-h2">Method &amp; sources</h2>
      <div class="sy-method">
        <p><b>Grounds.</b> Every <code>leisure=stadium</code> in OpenStreetMap, enriched from Wikidata (capacity, clubs, leagues, opening year, cost). Cups and defunct leagues are removed; "tier" is the highest competition a ground's clubs play in.</p>
        <p><b>Catchments.</b> Walk 15 min and drive 20 min are street-network isochrones (Valhalla on OSM; free-flow drive speeds). Public transport is an earliest-arrival Connection Scan over the national BODS timetable (every bus, tram, Underground, DLR and light-rail trip on the sample Saturday). The traveller leaves the ground at 17:00, walks up to 1.2 km to a first stop, and changes within 300 m. One direct National Rail hop is added from any station reached, timed by the scheduled minutes with a wait of half the daytime headway. The catchment is every stop reached, plus the walk possible in the time left. Matchday specials and crowding are not modelled.</p>
        <p><b>People.</b> Population is the Meta / CIESIN high-resolution grid (about 30 m, CC BY 4.0), so all four nations are measured on the same basis. Jobs are ONS BRES 2024 by LSOA (England). Deprivation is IMD 2025 (England) and SIMD (Scotland) as a national percentile, population-weighted within 1.5 km. Wales and NI have no deprivation data in the tool yet.</p>
        <p><b>Land.</b> The union, within 800 m, of OSM car parks, brownfield, retail, industrial, storage and low-density leisure land, the brownfield land registers and INSPIRE publicly owned parcels. These are opportunity areas, not allocations; some are operational. Rings overlap where grounds are close together, so UK totals count shared land more than once.</p>
        <p><b>Visitor economy.</b> Hotels, rooms and bedspaces are from OSM (tagged rooms, or estimated from brand, footprint × storeys, or type). Event venues and food and drink are from OSM.</p>
        <p><b>Cost.</b> Wikidata P2130 with its point-in-time, uprated by ONS RPI (CDKO). Only ${fmt(R.filter(r => r.cost_real_gbp).length)} grounds in this selection publish one.</p>
        <p class="sy-dim">Licences: OSM ODbL · Wikidata CC0 · BODS, ONS, MHCLG and ORR under the OGL v3 · Meta population CC BY 4.0.</p>
      </div>`;

    wire(R);
    drawCharts(R);
    drawTable(R);
  }
  const tile = (v, l, s) => `<div class="sy-tile"><div class="sy-tile-v">${v}</div><div class="sy-tile-l">${l}</div><div class="sy-tile-s">${s}</div></div>`;
  const IXL = { anchor_index: "Place anchor", regen_index: "Regeneration", social_index: "Social value", visitor_index: "Visitor economy" };
  function board(k, R) {
    const top = R.filter(r => r[k] != null).sort((a, b) => b[k] - a[k]).slice(0, 10);
    return `<div class="sy-board"><h4>${IXL[k]}</h4><ol>${top.map(r => `<li data-sid="${esc(r.source_id)}"><b>${Math.round(r[k])}</b><span>${esc(short(r.name))}</span><em>${esc(r.area_name || "")}</em></li>`).join("")}</ol></div>`;
  }

  function drawCharts(R) {
    // 1 · days in use by tier
    const tiers = Object.values(S.tiers).filter(t => R.some(r => r.tier === t.tier)).sort((a, b) => b.matchdays - a.matchdays);
    hbars(chartEl("c-days"), tiers.map(t => ({ label: t.tier, v: t.matchdays, n: R.filter(r => r.tier === t.tier).length })),
      { max: 365, ref: 91, tickVals: [0, 91, 183, 274, 365], refLabel: "¼ of the year", labelW: 200, val: r => `${r.v} days`, tick: v => fmt(v),
        tip: r => [[r.label], [`${r.v} days`, "in use"], [`${365 - r.v} days`, "idle"], [fmt(r.n), "grounds"]] });
    tableView("c-days", ["Tier", "Matchdays", "Idle days", "Grounds"], tiers.map(t => [t.tier, t.matchdays, 365 - t.matchdays, R.filter(r => r.tier === t.tier).length]));

    const dec = {};
    for (const r of R) if (r.opened >= 1870 && r.opened <= 2030 && r.capacity) { const k = Math.floor(r.opened / 10) * 10; (dec[k] = dec[k] || { seats: 0, n: 0 }); dec[k].seats += r.capacity; dec[k].n++; }
    const decRows = Object.keys(dec).map(Number).sort((a, b) => a - b).filter(k => k >= 1880).map(k => ({ label: k % 20 === 0 ? String(k) : "", full: `${k}s`, seats: dec[k].seats, n: dec[k].n }));
    columns(chartEl("c-decade"), decRows, [{ k: "seats", label: "seats", color: C.s1 }], { tipHead: r => `${r.full} · ${r.n} grounds`, xLabel: "Decade opened" });
    tableView("c-decade", ["Decade", "Grounds", "Seats"], decRows.map(r => [r.full, r.n, fmt(r.seats)]));

    // 2 · surge scatter
    const sp = R.filter(r => r.crowd > 0 && r.everyday > 50);
    const topSurge = [...sp].sort((a, b) => b.surge - a.surge);
    const lab = new Set([...topSurge.slice(0, 5), ...topSurge.slice(-3), ...[...sp].sort((a, b) => b.capacity - a.capacity).slice(0, 4)].map(r => r.source_id));
    scatter(chartEl("c-surge"), sp.map(r => ({ x: r.everyday, y: r.crowd, c: GCOL[r.group], r: 4, row: r, lab: lab.has(r.source_id) ? short(r.name) : null })), {
      logX: true, logY: true, xr: [100, 300000], yr: [200, 100000], h: 420,
      xLabel: "Everyday population within 800 m (residents + workers, log)", yLabel: "Matchday crowd (log)",
      under: (sx, sy) => [1, 3, 10, 30].map(k => {
        const x0 = 100, x1 = 300000, y0 = x0 * k, y1 = x1 * k;
        const a = [Math.max(x0, 200 / k), Math.max(y0, 200)], b = [Math.min(x1, 100000 / k), Math.min(y1, 100000)];
        return a[0] < b[0] ? `<line class="sy-iso" x1="${sx(a[0])}" y1="${sy(a[1])}" x2="${sx(b[0])}" y2="${sy(b[1])}"/><text class="sy-ax" x="${sx(b[0]) - 4}" y="${sy(b[1]) + 12}" text-anchor="end">${k}×</text>` : "";
      }).join(""),
      tip: p => [[p.row.name], [fmt(p.row.crowd), "matchday crowd"], [fmt(p.row.everyday), "everyday people ≤ 800 m"], [`${p.row.surge.toFixed(1)}×`, "surge"], [p.row.typology || "", ""]],
      onClick: p => show(p.row),
    });
    tableView("c-surge", ["Ground", "Crowd", "Everyday ≤800 m", "Surge"], topSurge.map(r => [r.name, fmt(r.crowd), fmt(r.everyday), r.surge.toFixed(1) + "×"]));
    hbars(chartEl("c-surgetop"), topSurge.slice(0, 12).map(r => ({ label: short(r.name), v: r.surge, row: r })),
      { val: r => `${r.v.toFixed(0)}×`, tick: v => `${v}×`, tip: r => [[r.row.name], [`${r.v.toFixed(1)}×`, "surge"], [fmt(r.row.crowd), "crowd"], [fmt(r.row.everyday), "everyday ≤ 800 m"]] });
    tableView("c-surgetop", ["Ground", "Surge"], topSurge.slice(0, 12).map(r => [r.name, r.surge.toFixed(1) + "×"]));
    const typRows = TYPOLOGIES.map(t => ({ label: t, v: sum(R.filter(r => r.typology === t).map(r => r.capacity)), n: R.filter(r => r.typology === t).length })).filter(x => x.n);
    hbars(chartEl("c-typo"), typRows, { labelW: 190, tip: r => [[r.label], [fmt(r.v), "seats"], [fmt(r.n), "grounds"]] });
    tableView("c-typo", ["Typology", "Grounds", "Seats"], typRows.map(r => [r.label, r.n, fmt(r.v)]));

    // 3 · deprivation deciles
    const decile = rows => { const c = Array(10).fill(0); rows.forEach(r => c[Math.min(9, Math.floor(r.imd_1500 / 10))]++); return c.map(v => v / Math.max(1, rows.length)); };
    const wi = R.filter(r => r.imd_1500 != null), de = decile(wi.filter(r => r.elite)), dn = decile(wi.filter(r => !r.elite));
    const imdRows = de.map((v, i) => ({ label: String(i + 1), elite: v, other: dn[i] }));
    columns(chartEl("c-imd"), imdRows, [{ k: "elite", label: "top-flight & second tier", color: C.s1 }, { k: "other", label: "all other grounds", color: C.s2 }],
      { ref: 0.1, refLabel: "random = 10%", tick: v => pct(v), val: v => pct(v, 1), xLabel: "Deprivation decile (1 = least, 10 = most deprived)", tipHead: r => `Decile ${r.label}` });
    tableView("c-imd", ["Decile", "Top-flight & second tier", "Others"], imdRows.map(r => [r.label, pct(r.elite, 1), pct(r.other, 1)]));

    const landTop = R.filter(r => r.regen_ha != null).sort((a, b) => b.regen_ha - a.regen_ha).slice(0, 14);
    hbars(chartEl("c-land"), landTop.map(r => ({ label: short(r.name), v: r.regen_ha, row: r })),
      { val: r => `${r.v.toFixed(0)} ha`, tip: r => [[r.row.name], [`${r.v.toFixed(1)} ha`, "regenerable land"], [`${(r.row.parking_ha || 0).toFixed(1)} ha`, "parking"], [`${(r.row.brownfield_ha || 0).toFixed(1)} ha`, "brownfield"], [`${(r.row.public_ha || 0).toFixed(1)} ha`, "public ownership"]] });
    tableView("c-land", ["Ground", "Regenerable", "Parking", "Brownfield", "Public"], landTop.map(r => [r.name, r.regen_ha, r.parking_ha, r.brownfield_ha, r.public_ha]));

    const qp = R.filter(r => r.imd_1500 != null && r.regen_ha != null);
    const qlab = new Set([...qp].sort((a, b) => (b.regen_index || 0) - (a.regen_index || 0)).slice(0, 10).map(r => r.source_id));
    const mLand = median(qp.map(r => r.regen_ha));
    scatter(chartEl("c-quad"), qp.map(r => ({ x: r.imd_1500, y: Math.max(0.5, r.regen_ha), c: GCOL[r.group], r: 2.5 + 6 * Math.sqrt((r.reach_pt45 || 0) / 4e6), row: r, hi: qlab.has(r.source_id), lab: qlab.has(r.source_id) ? short(r.name) : null })), {
      xr: [0, 100], logY: true, yr: [0.5, 200], h: 420, xLabel: "Deprivation within 1.5 km (national percentile, 100 = most deprived)", yLabel: "Regenerable land within 800 m (ha, log)",
      under: (sx, sy, b) => `<rect class="sy-quad" x="${sx(60)}" y="${b.t}" width="${sx(100) - sx(60)}" height="${sy(mLand) - b.t}"/><line class="sy-ref" x1="${sx(60)}" x2="${sx(60)}" y1="${b.t}" y2="${b.t + b.ih}"/><line class="sy-ref" x1="${b.l}" x2="${b.l + b.iw}" y1="${sy(mLand)}" y2="${sy(mLand)}"/><text class="sy-ax" x="${sx(99)}" y="${b.t + 12}" text-anchor="end">need + land</text>`,
      tip: p => [[p.row.name], [`${Math.round(p.row.imd_1500)}`, "deprivation percentile"], [`${p.row.regen_ha.toFixed(1)} ha`, "regenerable land"], [compact(p.row.reach_pt45), "people ≤ 45 min PT"], [`${Math.round(p.row.regen_index ?? 0)}`, "regeneration index"]],
      onClick: p => show(p.row),
    });
    tableView("c-quad", ["Ground", "Deprivation", "Land ha", "PT 45", "Regen index"], [...qp].sort((a, b) => (b.regen_index || 0) - (a.regen_index || 0)).slice(0, 40).map(r => [r.name, Math.round(r.imd_1500), r.regen_ha, fmt(r.reach_pt45), Math.round(r.regen_index ?? 0)]));

    // 4 · access
    const ptRows = R.filter(r => r.reach_pt45 > 0 && r.reach_drive20 > 0).sort((a, b) => b.capacity - a.capacity).slice(0, 30)
      .sort((a, b) => b.reach_pt45 / b.reach_drive20 - a.reach_pt45 / a.reach_drive20);
    dumbbell(chartEl("c-pt"), ptRows.map(r => ({ label: short(r.name), a: r.reach_pt45, b: r.reach_drive20, row: r })),
      { label: "PT 45 min", color: C.s1 }, { label: "Drive 20 min", color: C.s2 }, { extra: r => [[pct(r.a / r.b), "PT ÷ car"]] });
    tableView("c-pt", ["Ground", "PT 45 min", "Drive 20 min", "PT ÷ car"], ptRows.map(r => [r.name, fmt(r.reach_pt45), fmt(r.reach_drive20), pct(r.reach_pt45 / r.reach_drive20)]));
    const shareRows = TYPOLOGIES.map(t => ({ label: t, v: median(R.filter(r => r.typology === t && r.reach_drive20 > 0 && r.reach_pt45 != null).map(r => r.reach_pt45 / r.reach_drive20)) })).filter(x => x.v != null);
    hbars(chartEl("c-ptshare"), shareRows, { max: niceMax(Math.max(...shareRows.map(r => r.v))), val: r => pct(r.v), tick: v => pct(v), labelW: 190 });
    tableView("c-ptshare", ["Typology", "Median PT ÷ car"], shareRows.map(r => [r.label, pct(r.v)]));
    const walkTop = R.filter(r => r.reach_walk15 != null).sort((a, b) => b.reach_walk15 - a.reach_walk15).slice(0, 12);
    hbars(chartEl("c-walk"), walkTop.map(r => ({ label: short(r.name), v: r.reach_walk15, row: r })),
      { tip: r => [[r.row.name], [fmt(r.v), "people ≤ 15 min walk"], [fmt(r.row.capacity), "seats"]] });
    tableView("c-walk", ["Ground", "People ≤ 15 min walk"], walkTop.map(r => [r.name, fmt(r.reach_walk15)]));

    // 5 · visitor economy
    const bigs = R.filter(r => (r.capacity || 0) >= 15000 && r.beds_per_100 != null);
    const deserts = [...bigs].sort((a, b) => a.beds_per_100 - b.beds_per_100).slice(0, 15);
    hbars(chartEl("c-hotel"), deserts.map(r => ({ label: short(r.name), v: r.beds_per_100, row: r })),
      { ref: median(bigs.map(r => r.beds_per_100)), refLabel: "median", val: r => `${r.v.toFixed(0)}`,
        tip: r => [[r.row.name], [r.v.toFixed(0), "bedspaces per 100 seats"], [fmt(r.row.beds_5k), "bedspaces ≤ 5 km"], [fmt(r.row.capacity), "seats"]] });
    tableView("c-hotel", ["Ground", "Beds per 100 seats", "Beds ≤5 km", "Seats"], deserts.map(r => [r.name, r.beds_per_100, fmt(r.beds_5k), fmt(r.capacity)]));
    const cost = R.filter(costOk);
    if (cost.length) {
      scatter(chartEl("c-spend"), cost.map(r => ({ x: r.opened, y: r.cost_real_gbp / r.capacity, c: C.s1, r: 3 + 7 * Math.sqrt(r.capacity / 90000), row: r, lab: short(r.name) })), {
        xr: [Math.floor(Math.min(...cost.map(r => r.opened)) / 10) * 10 - 5, 2030], h: 340, xTick: v => String(Math.round(v)),
        yLabel: "Real cost per seat (£, RPI-uprated)", xLabel: "Year opened", yTick: v => gbp(v),
        tip: p => [[p.row.name], [gbp(p.row.cost_real_gbp), "today's money"], [gbp(p.row.cost_real_gbp / p.row.capacity), "per seat"], [fmt(p.row.capacity), "seats"], [String(p.row.opened), "opened"]],
        onClick: p => show(p.row),
      });
    } else chartEl("c-spend").innerHTML = `<p class="sy-note">No grounds with a published cost in this selection.</p>`;
    tableView("c-spend", ["Ground", "Opened", "Cost (today)", "Per seat"], cost.map(r => [r.name, r.opened, gbp(r.cost_real_gbp), gbp(r.cost_real_gbp / r.capacity)]));

    // 6 · fingerprints
    const FC = [["Grounds", rs => rs.length, fmt], ["Seats", rs => sum(rs.map(r => r.capacity)), compact],
      ["Surge ×", rs => median(rs.map(r => r.surge)), v => v == null ? "—" : v.toFixed(1)],
      ["Walk 15", rs => median(rs.map(r => r.reach_walk15)), compact], ["PT 45", rs => median(rs.map(r => r.reach_pt45)), compact],
      ["PT ÷ car", rs => median(rs.map(r => r.pt_share)), v => pct(v)], ["Land ha", rs => median(rs.map(r => r.regen_ha)), v => v == null ? "—" : v.toFixed(1)],
      ["Deprivation", rs => median(rs.map(r => r.imd_1500)), fmt], ["Beds/100", rs => median(rs.map(r => r.beds_per_100)), fmt],
      ["£/m² homes", rs => median(rs.map(r => r.ppm2_1500)), v => v == null ? "—" : "£" + fmt(v)], ["Anchor", rs => median(rs.map(r => r.anchor_index)), fmt]];
    const fv = TYPOLOGIES.map(t => ({ t, v: FC.map(([, f]) => f(R.filter(r => r.typology === t))) })).filter(x => x.v[0] > 0);
    const ranges = FC.map((_, j) => { const xs = fv.map(x => x.v[j]).filter(v => v != null); return [Math.min(...xs), Math.max(...xs)]; });
    root.querySelector("#c-finger .sy-finger").innerHTML = `<div class="sy-tbl-wrap"><table class="sy-tbl sy-fp"><thead><tr><th>Typology</th>${FC.map(([h]) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${fv.map(x => `<tr><td>${esc(x.t)}</td>${x.v.map((v, j) => {
      const [a, b] = ranges[j], s = v == null || b === a ? 0 : (v - a) / (b - a);
      return `<td style="--sh:${(0.06 + 0.5 * s).toFixed(2)}" class="sh${s > 0.6 ? " dk" : ""}">${FC[j][2](v)}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  // ---- comparison table --------------------------------------------------------------
  const COLS = [
    ["name", "Ground", r => esc(r.name), "t"], ["area_name", "Area", r => esc(r.area_name || ""), "t"], ["tier", "Tier", r => esc(r.tier || ""), "t"],
    ["typology", "Typology", r => esc(r.typology || ""), "t"], ["capacity", "Seats", r => fmt(r.capacity)],
    ["md", "Matchdays", r => fmt(r.md)], ["visits", "Visits / yr", r => compact(r.visits)], ["surge", "Surge ×", r => r.surge == null ? "—" : r.surge.toFixed(1)],
    ["reach_walk15", "Walk 15", r => compact(r.reach_walk15)], ["reach_pt45", "PT 45", r => compact(r.reach_pt45)], ["reach_drive20", "Drive 20", r => compact(r.reach_drive20)],
    ["pt_share", "PT ÷ car", r => pct(r.pt_share)], ["imd_1500", "Deprivation", r => fmt(r.imd_1500)],
    ["regen_ha", "Land ha", r => r.regen_ha == null ? "—" : r.regen_ha.toFixed(1)], ["parking_ha", "Parking ha", r => r.parking_ha == null ? "—" : r.parking_ha.toFixed(1)],
    ["public_ha", "Public ha", r => r.public_ha == null ? "—" : r.public_ha.toFixed(1)], ["beds_per_100", "Beds/100", r => fmt(r.beds_per_100)],
    ["venue_cap_3k", "Venue cap 3 km", r => compact(r.venue_cap_3k)], ["food_800", "Food & drink", r => fmt(r.food_800)],
    ["ppm2_1500", "£/m²", r => r.ppm2_1500 ? "£" + fmt(r.ppm2_1500) : "—"], ["price_premium_pct", "vs area", r => r.price_premium_pct == null ? "—" : `${r.price_premium_pct > 0 ? "+" : ""}${Math.round(r.price_premium_pct)}%`],
    ["regen_index", "Regen", r => fmt(r.regen_index)], ["social_index", "Social", r => fmt(r.social_index)], ["visitor_index", "Visitor", r => fmt(r.visitor_index)], ["anchor_index", "Anchor", r => fmt(r.anchor_index)],
  ];
  function drawTable(R) {
    const q = S.q.trim().toLowerCase();
    const rows = R.filter(r => !q || [r.name, r.clubs, r.area_name, r.league].some(s => (s || "").toLowerCase().includes(q)))
      .sort((a, b) => { const k = S.sort.k, x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.sort.dir; });
    const t = root.querySelector("#sy-tbl");
    t.innerHTML = `<thead><tr>${COLS.map(([k, l, , ty]) => `<th data-k="${k}" class="${ty === "t" ? "t" : ""}${S.sort.k === k ? " on" : ""}" aria-sort="${S.sort.k === k ? (S.sort.dir > 0 ? "ascending" : "descending") : "none"}">${l}${S.sort.k === k ? (S.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-i="${i}" tabindex="0">${COLS.map(([, , f, ty]) => `<td class="${ty === "t" ? "t" : ""}">${f(r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    t.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k;
      S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : (COLS.find(c => c[0] === k)[3] === "t" ? 1 : -1) };
      drawTable(R);
    }));
    t.querySelectorAll("tbody tr").forEach(tr => {
      const go = () => show(rows[Number(tr.dataset.i)]);
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    });
  }
  function csv(R) {
    const keys = ["name", "clubs", "league", "tier", "sport", "nation", "area_name", "typology", "lng", "lat", "capacity", "opened", "cost_real_gbp",
      "md", "fill", "visits", "surge", "pop_800", "pop_1500", "pop_3000", "jobs_800", "jobs_1500", "dens_1500", "imd_1500", "imd_income", "imd_health", "imd_employment",
      "reach_walk15", "reach_pt30", "reach_pt45", "reach_drive20", "pt_share", "pt45_stops", "pt45_stations", "parking_ha", "brownfield_ha", "public_ha", "lowvalue_ha", "regen_ha", "green_ha",
      "flood3_share", "conservation_share", "listed_800", "hotels_3k", "rooms_1k", "beds_1k", "beds_3k", "beds_5k", "beds_per_100", "venues_3k", "venue_cap_3k",
      "food_800", "pubs_800", "sport_fac_1500", "pitch_ha_1500", "schools_1500", "stations_1k", "nearest_station_m", "station_usage_1k", "buses_hr_800",
      "ppm2_1500", "ppm2_area", "price_premium_pct", "price_trend_pct", "regen_index", "social_index", "visitor_index", "anchor_index"];
    const q = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : (typeof v === "number" ? +v.toFixed(3) : v);
    const body = [keys.join(","), ...R.map(r => keys.map(k => q(r[k])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
    a.download = "uk-stadium-analysis.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function wire(R) {
    const page = root.querySelector("#sy-page");
    const cnt = page.querySelector("#sy-count");
    if (cnt) cnt.textContent = `${fmt(R.length)} grounds`;
    page.querySelectorAll(".sy-filters select").forEach(s => s.addEventListener("change", () => {
      S.f[s.dataset.f] = s.dataset.f === "minCap" ? Number(s.value) : s.value;
      rerender();
    }));
    page.querySelector("#sy-csv").addEventListener("click", () => csv(R));
    const q = page.querySelector("#sy-q");
    q.addEventListener("input", () => { S.q = q.value; drawTable(R); });
    page.querySelectorAll(".sy-tiers input").forEach(i => i.addEventListener("change", () => {
      const v = Number(i.value);
      if (!(v > 0)) return;
      S.tiers[i.dataset.tier][i.dataset.k] = i.dataset.k === "matchdays" ? Math.min(365, Math.round(v)) : Math.min(1, v);
      rerender();
    }));
    page.querySelectorAll("[data-a]").forEach(i => i.addEventListener("change", () => {
      const v = Number(i.value);
      if (v >= 0) { S.a[i.dataset.a] = v; rerender(); }
    }));
    page.querySelector("#sy-reset").addEventListener("click", () => {
      S.tiers = JSON.parse(JSON.stringify(S.tiersDefault)); S.a = { dph: 50, devShare: 25, spend: 45 }; rerender();
    });
    page.querySelectorAll(".sy-board li").forEach(li => li.addEventListener("click", () => show(S.rows.find(r => r.source_id === li.dataset.sid))));
  }
  // Re-render in place, keeping the reader's scroll position.
  function rerender() {
    const sc = root.querySelector(".sy-scroll"), top = sc.scrollTop;
    render();
    sc.scrollTop = top;
  }
  function show(r) {
    if (!r) return;
    close();
    onShowStadium(r);
  }

  // ---- open / close ------------------------------------------------------------------------
  async function open() {
    root.hidden = false;
    document.body.classList.add("studies-open");
    if (!root.querySelector(".sy-page")) shell();
    if (history.replaceState) history.replaceState(null, "", "#study=stadia");
    try {
      await load();
      if (!root.querySelector(".sy-hero")) render();
    } catch (e) {
      root.querySelector("#sy-page").innerHTML = `<p class="sy-loading">Couldn't load the stadium data (${esc(e.message || e)}).</p>`;
    }
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove("studies-open");
    hideTip();
    if (location.hash.startsWith("#study") && history.replaceState) history.replaceState(null, "", location.pathname + location.search);
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !root.hidden) close(); });
  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!root.hidden && S.rows && root.querySelector(".sy-hero")) rerender(); }, 200); });
  if (location.hash.startsWith("#study")) open();
  return { open, close };
}
