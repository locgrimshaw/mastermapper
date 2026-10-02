// Sport & Leisure: stadium filters and list, the stadium card, and the stadium
// catchment sidebar (walk / cycle / drive / public transport) built on the
// shared deep dive. Data: map_features datasets stadium, sports_facility,
// hotel, event_venue, food_drink (pipeline/build_sport_leisure.py) and the
// stadium_catchment_summary + point_rail_access RPCs (migration 0087).

export const SPORT_COLORS = [
  ["Football", "#2f9e44"], ["Rugby union", "#1c7ed6"], ["Rugby league", "#7048e8"],
  ["Rugby", "#4263eb"], ["Cricket", "#f08c00"], ["Athletics", "#e8590c"],
  ["Greyhound racing", "#a61e4d"], ["Speedway", "#c2255c"], ["Tennis", "#99c11d"],
  ["Gaelic games", "#0b7285"], ["Multi-sport", "#495057"],
];

export function stadiumColor() {
  const e = ["match", ["coalesce", ["get", "sport1"], ""]];
  for (const [s, c] of SPORT_COLORS) e.push(s, c);
  e.push("#868e96");
  return e;
}

// Dot size grows with capacity (unknown capacity = small) and with zoom.
export function stadiumRadius() {
  const cap = ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "capacity"]], 0],
    0, 3, 5000, 4.5, 20000, 7, 50000, 10, 90000, 13];
  return ["interpolate", ["linear"], ["zoom"], 5, ["*", cap, 0.7], 10, cap, 14, ["*", cap, 1.4]];
}

const LEAGUES = [
  ["Football — England", ["Premier League", "EFL Championship", "EFL League One", "EFL League Two",
                          "National League", "National League North", "National League South",
                          "Women's Super League", "Women's Super League 2"]],
  ["Football — Scotland, Wales, NI", ["Scottish Premiership", "Scottish Championship",
                          "Scottish Professional Football League", "Cymru Premier", "NIFL Premiership"]],
  ["Rugby", ["Premiership Rugby", "United Rugby Championship", "Super League",
             "RFL Championship", "RFL League 1"]],
];
const SPORTS = ["Football", "Rugby union", "Rugby league", "Rugby", "Cricket", "Athletics",
                "Greyhound racing", "Speedway", "Tennis", "Gaelic games", "Multi-sport"];
const MODES = [
  { k: "walk",  label: "Walk",  color: "#2f9e44", costing: "pedestrian", mpm: 62,  def: 15 },
  { k: "cycle", label: "Cycle", color: "#0ca678", costing: "bicycle",    mpm: 185, def: 15 },
  { k: "drive", label: "Drive", color: "#e8590c", costing: "auto",       mpm: 450, def: 20 },
  { k: "pt",    label: "Public transport", color: "#7048e8", def: 30 },
];
const WALK_MPM = 62, INTERCHANGE = 5;

export function initStadia(d) {
  const { map, getSupabase, runDeepDive, fetchIsochrone, areaWeightedScore,
          openClickPopup, esc, setOverlay } = d;
  const F = { sport: "all", league: "all", minCap: 0 };
  const S = { st: null, zones: {}, notes: {}, seq: {}, analyse: "walk", showAll: false,
              mins: Object.fromEntries(MODES.map(m => [m.k, m.def])), all: null, cardP: null };
  const fmt = n => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString();
  const km = m => m == null ? "" : (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

  // ---- filters + list (Sport & Leisure → Stadia) ---------------------------
  function filterExpr() {
    const c = ["all"];
    if (F.sport !== "all") c.push(["in", F.sport, ["coalesce", ["get", "sport"], ""]]);
    // Whole league names only ("Premier League" must not match "Women's
    // Premier League"): the prop is a ", "-joined list, so pad both sides.
    if (F.league !== "all") c.push(["in", `, ${F.league},`,
      ["concat", ", ", ["coalesce", ["get", "league"], ""], ","]]);
    if (F.minCap > 0) c.push([">=", ["coalesce", ["to-number", ["get", "capacity"]], 0], F.minCap]);
    return c.length > 1 ? c : null;
  }
  function applyFilter() {
    const f = filterExpr();
    for (const id of ["ov-stadium-pt", "ov-stadium-name"])
      if (map.getLayer(id)) map.setFilter(id, f);
    renderList();
  }
  function matches(p) {
    if (F.sport !== "all" && !String(p.sport || "").includes(F.sport)) return false;
    if (F.league !== "all" && !`, ${p.league || ""},`.includes(`, ${F.league},`)) return false;
    if (F.minCap > 0 && !(Number(p.capacity) >= F.minCap)) return false;
    return true;
  }
  function filterHTML() {
    const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${l}</option>`;
    return `
      <div class="st-filters" id="st-filters">
        <label>Sport <select class="st-f" data-f="sport">${opt("all", "All", F.sport)}${SPORTS.map(s => opt(s, s, F.sport)).join("")}</select></label>
        <label>League <select class="st-f" data-f="league">${opt("all", "All", F.league)}${LEAGUES.map(([g, ls]) =>
          `<optgroup label="${g}">${ls.map(l => opt(l, l, F.league)).join("")}</optgroup>`).join("")}</select></label>
        <label>Capacity <select class="st-f" data-f="minCap">${[[0, "Any"], [5000, "5,000+"], [10000, "10,000+"],
          [20000, "20,000+"], [40000, "40,000+"]].map(([v, l]) => opt(v, l, F.minCap)).join("")}</select></label>
        <details class="st-list-wrap"><summary id="st-list-sum">Matching stadia</summary><div id="st-list"></div></details>
        <p class="hint">Capacity is known for about half the grounds, clubs and league for about 40% (Wikidata) — a capacity or league filter hides the rest.</p>
      </div>`;
  }
  async function loadAll() {
    if (S.all) return S.all;
    const sb = getSupabase();
    if (!sb) return [];
    const { data } = await sb.rpc("features_in_bbox",
      { p_dataset: "stadium", w: -9, s: 49, e: 2.5, n: 61.5, lim: 2000 });
    S.all = ((data && data.features) || []).filter(f => f.geometry && f.geometry.type === "Point");
    return S.all;
  }
  async function renderList() {
    const el = document.getElementById("st-list"), sum = document.getElementById("st-list-sum");
    if (!el) return;
    const all = await loadAll();
    const hits = all.filter(f => matches(f.properties || {}))
      .sort((a, b) => (Number(b.properties.capacity) || 0) - (Number(a.properties.capacity) || 0));
    if (sum) sum.textContent = `Matching stadia (${hits.length.toLocaleString()})`;
    el.innerHTML = hits.slice(0, 60).map((f, i) => {
      const p = f.properties;
      return `<button type="button" class="st-li" data-i="${i}">
        <span class="st-dot" style="background:${(SPORT_COLORS.find(x => x[0] === p.sport1) || [0, "#868e96"])[1]}"></span>
        <span class="st-li-n">${esc(p.name || "Stadium")}</span>
        <span class="st-li-m">${p.capacity ? fmt(p.capacity) : "—"}</span></button>`;
    }).join("") + (hits.length > 60 ? `<p class="hint">Top 60 by capacity shown.</p>` : "");
    el.querySelectorAll(".st-li").forEach(b => b.addEventListener("click", () => {
      const f = hits[Number(b.dataset.i)];
      const [lng, lat] = f.geometry.coordinates;
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13), duration: 900 });
      openCard(f.properties, { lng, lat });
    }));
  }
  document.addEventListener("change", e => {
    const t = e.target;
    if (!t.classList || !t.classList.contains("st-f")) return;
    const k = t.dataset.f;
    F[k] = k === "minCap" ? Number(t.value) : t.value;
    applyFilter();
  });
  document.addEventListener("toggle", e => {
    if (e.target && e.target.classList && e.target.classList.contains("st-list-wrap") && e.target.open) renderList();
  }, true);

  // Overlay hook: name labels + the active filter whenever the layer is (re)built.
  function onLayers(key, srcId, before) {
    if (!map.getLayer("ov-stadium-name"))
      map.addLayer({ id: "ov-stadium-name", type: "symbol", source: srcId, minzoom: 10,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
                  "text-size": 11, "text-anchor": "top", "text-offset": [0, 1.1],
                  "text-optional": true },
        paint: { "text-color": "#1c2533", "text-halo-color": "#ffffff", "text-halo-width": 1.3 } }, before);
    applyFilter();
  }

  // ---- card -----------------------------------------------------------------
  function factRows(p) {
    return [
      ["Capacity", p.capacity ? fmt(p.capacity) : "not recorded"],
      ["Sport", p.sport], ["Clubs", p.clubs], ["League", p.league],
      ["Opened", p.opened], ["Owner", p.owner], ["Operator", p.operator],
      ["Site", p.site_ha ? `${p.site_ha} ha` : null],
    ].filter(([, v]) => v != null && v !== "");
  }
  function openCard(p, lngLat) {
    S.cardP = { p, lngLat };
    const rows = factRows(p).map(([k, v]) =>
      `<div class="ovp-stat${String(v).length > 24 ? " ovp-stat-wide" : ""}"><div class="ovp-sv">${esc(v)}</div><div class="ovp-sk">${k}</div></div>`).join("");
    openClickPopup({ closeButton: true, maxWidth: "340px", offset: 10 }, lngLat,
      `<div class="ovp ovp2" style="--ov:${(SPORT_COLORS.find(x => x[0] === p.sport1) || [0, "#1c7ed6"])[1]}">
        <div class="ovp-kind"><span class="ovp-dot"></span>Stadium</div>
        <div class="ovp-title">${esc(p.name || "Stadium")}</div>
        <div class="ovp-stats">${rows}</div>
        <button type="button" class="deepdive-btn st-analyse">Analyse catchment →</button>
      </div>`);
  }
  document.addEventListener("click", e => {
    if (e.target && e.target.closest && e.target.closest(".st-analyse") && S.cardP)
      profile(S.cardP.p, S.cardP.lngLat);
  });

  // ---- catchment zones ------------------------------------------------------
  const ring = (lng, lat, m) => turf.circle([lng, lat], Math.max(m, 150) / 1000, { steps: 48, units: "kilometers" });
  function unionAll(fs) {
    let z = fs[0];
    for (let i = 1; i < fs.length; i++) {
      let u = null;
      try { u = turf.union(turf.featureCollection([z, fs[i]])); } catch (_) {}
      if (!u) { try { u = turf.union(z, fs[i]); } catch (_) {} }
      if (u) z = u;
    }
    return z;
  }
  async function buildZone(mode) {
    const { lng, lat } = S.st, T = S.mins[mode], m = MODES.find(x => x.k === mode);
    if (mode !== "pt") {
      let poly = null;
      try { poly = await fetchIsochrone(lng, lat, m.costing, T, { forceNetwork: true }); } catch (_) {}
      if (poly && !(poly.properties && (poly.properties._approx || poly.properties._circle))) {
        S.notes[mode] = `${T}-min ${m.label.toLowerCase()} on the street network (OSM / Valhalla).`;
        return poly;
      }
      S.notes[mode] = `Routing service unavailable — ${T}-min ${m.label.toLowerCase()} shown as a detour-adjusted ring.`;
      return ring(lng, lat, T * m.mpm);
    }
    // Public transport at 30 / 45 min: the precomputed timetable isochrone
    // (bus, tram, Underground and rail, leaving 17:00 Saturday) when there is one.
    if (T === 30 || T === 45) {
      const row = await metricsFor(S.st);
      if (row) {
        try {
          const { data } = await getSupabase().from("map_features").select("geom,props")
            .eq("dataset", "stadium_iso").eq("source_id", `${row.source_id}|pt${T}`).maybeSingle();
          if (data && data.geom) {
            S.notes.pt = `${T} min by public transport leaving the ground at 17:00 on a Saturday — every bus, tram, Underground and rail service in the national timetable (BODS + National Rail), walking on from each stop with the time left. Reaches ${fmt(data.props?.pop)} people.`;
            S.ptReached = row.pt45_stations;
            return { type: "Feature", properties: {}, geometry: data.geom };
          }
        } catch (_) {}
      }
    }
    // Otherwise: walk from the stadium, plus every station within reach
    // by direct train (timetable minutes + walk + interchange), each with the
    // walking time it has left as a ring.
    const sites = [ring(lng, lat, T * WALK_MPM)];
    let reached = 0, gws = 0;
    try {
      const { data } = await getSupabase().rpc("point_rail_access", { p_lng: lng, p_lat: lat, p_gateway_m: 1500 });
      const gwWalk = {};
      for (const g of (data && data.gateways) || []) {
        const w = g.walk_m / WALK_MPM;
        gwWalk[g.crs] = w;
        gws++;
        if (T - w > 3) sites.push(ring(g.lng, g.lat, (T - w) * WALK_MPM));
      }
      for (const f of (data && data.feeders) || []) {
        if (f.minutes == null || (f.trains_day ?? 0) < 8) continue;
        const left = T - (f.minutes + INTERCHANGE + (gwWalk[f.via_crs] ?? 12));
        if (left > 3) { sites.push(ring(f.lng, f.lat, left * WALK_MPM)); reached++; }
      }
      S.notes.pt = gws
        ? `${T} min by rail + walking: ${gws} station${gws === 1 ? "" : "s"} within 1.5 km of the stadium, ${reached} more reachable by direct train (8+ trains/day) with time to walk on. Bus, tram and Underground are not routed.`
        : `No rail station within 1.5 km — the public transport zone is the walk zone only. Bus, tram and Underground are not routed.`;
    } catch (_) {
      S.notes.pt = "Rail links unavailable — showing the walk zone only.";
    }
    S.ptReached = reached;
    return unionAll(sites.slice(0, 260));
  }
  async function ensureZone(mode) {
    const seq = S.seq[mode] = (S.seq[mode] || 0) + 1;
    const z = await buildZone(mode);
    if (S.seq[mode] !== seq) return null;
    S.zones[mode] = z;
    return z;
  }
  function drawZones() {
    for (const m of MODES) for (const sfx of ["fill", "line"])
      if (map.getLayer(`stc-${m.k}-${sfx}`)) map.removeLayer(`stc-${m.k}-${sfx}`);
    for (const m of MODES) {
      const z = S.zones[m.k];
      const on = z && (S.showAll || m.k === S.analyse);
      if (!on) { if (map.getSource(`stc-${m.k}`)) map.removeSource(`stc-${m.k}`); continue; }
      if (map.getSource(`stc-${m.k}`)) map.getSource(`stc-${m.k}`).setData(z);
      else map.addSource(`stc-${m.k}`, { type: "geojson", data: z });
      map.addLayer({ id: `stc-${m.k}-fill`, type: "fill", source: `stc-${m.k}`,
        paint: { "fill-color": m.color, "fill-opacity": m.k === S.analyse ? 0.1 : 0.06 } });
      map.addLayer({ id: `stc-${m.k}-line`, type: "line", source: `stc-${m.k}`,
        layout: { "line-join": "round" },
        paint: { "line-color": m.color, "line-width": m.k === S.analyse ? 3 : 1.8,
                 "line-dasharray": m.k === S.analyse ? [1, 0] : [3, 2] } });
    }
  }
  function clear() {
    for (const m of MODES) {
      for (const sfx of ["fill", "line"]) if (map.getLayer(`stc-${m.k}-${sfx}`)) map.removeLayer(`stc-${m.k}-${sfx}`);
      if (map.getSource(`stc-${m.k}`)) map.removeSource(`stc-${m.k}`);
    }
    S.st = null; S.zones = {};
  }

  // ---- sidebar ----------------------------------------------------------------
  async function profile(p, lngLat, keepZones) {
    if (typeof turf === "undefined") { alert("Catchment maths needs the Turf library — refresh and try again."); return; }
    if (!keepZones) { clear(); }
    S.st = { p, lng: lngLat.lng, lat: lngLat.lat, name: p.name || "Stadium" };
    const btn = document.querySelector(".st-analyse");
    if (btn) { btn.disabled = true; btn.textContent = "Building catchment…"; }
    const zone = S.zones[S.analyse] || await ensureZone(S.analyse);
    if (!zone) return;
    const { domains, parts } = areaWeightedScore(zone);
    const m = MODES.find(x => x.k === S.analyse);
    runDeepDive(zone, {
      eyebrow: "Stadium catchment",
      title: S.st.name,
      subtitle: `${S.mins[S.analyse]}-min ${m.label.toLowerCase()} catchment${parts ? ` · ${parts} LSOA${parts === 1 ? "" : "s"}` : ""}`,
      domains, scoreCaption: "Catchment deprivation · weighted",
      stadium: S.st,
    });
    drawZones();
    if (S.showAll) buildOthers();
    loadSummary(zone);
    loadAnchor(S.st);
  }
  async function buildOthers() {
    for (const m of MODES) {
      if (S.zones[m.k] || !S.st) continue;
      setNote(`Building the ${m.label.toLowerCase()} zone…`);
      await ensureZone(m.k);
      drawZones();
    }
    setNote(MODES.map(m => S.notes[m.k] ? `<b style="color:${m.color}">${m.label}:</b> ${S.notes[m.k]}` : "").filter(Boolean).join("<br>"));
  }
  function setNote(html) { const el = document.getElementById("st-catch-note"); if (el) el.innerHTML = html; }

  function sectionHTML(st) {
    const p = st.p;
    const facts = factRows(p).map(([k, v]) =>
      `<div class="dd-kv-row"><span>${k}</span><b>${esc(v)}</b></div>`).join("");
    const block = (sec, title, body, open = true) => `
      <section class="dd-block${open ? "" : " collapsed"}" data-section="${sec}">
        <button class="dd-block-head" type="button" aria-expanded="${open}">
          <span class="dd-h">${title}</span><span class="dd-caret">▾</span>
        </button>
        <div class="dd-block-content">${body}</div>
      </section>`;
    const seg = MODES.map(m => `<button type="button" class="lt-seg-btn st-mode${m.k === S.analyse ? " active" : ""}" data-m="${m.k}" style="--mc:${m.color}">${m.label}</button>`).join("");
    const mins = [10, 15, 20, 30, 45, 60].map(v => `<option value="${v}"${v === S.mins[S.analyse] ? " selected" : ""}>${v} min</option>`).join("");
    return block("st-facts", "Stadium", `<div class="dd-kv">${facts}</div>`)
      + block("st-anchor", "Place-anchor profile", `<div id="st-anchor"><p class="hint">Loading…</p></div>`)
      + block("st-catch", "Catchment · travel modes", `
        <div class="lt-seg st-modes" role="group" aria-label="Catchment mode">${seg}</div>
        <div class="st-catch-row">
          <label>Time <select id="st-mins">${mins}</select></label>
          <label class="dd-bf-check"><input type="checkbox" id="st-showall"${S.showAll ? " checked" : ""} /> Show all four modes</label>
        </div>
        <div class="st-legend">${MODES.map(m => `<span><i style="background:${m.color}"></i>${m.label}</span>`).join("")}</div>
        <p class="hint" id="st-catch-note">${S.notes[S.analyse] || ""}</p>
        <p class="hint">Every figure below — and deprivation, population and land further down — is for the <b>selected</b> mode's zone (solid outline). Hotels and venues are also shown by distance from the ground.</p>`)
      + block("st-visitor", "Visitor economy · hotels &amp; venues", `<div id="st-visitor"><p class="hint">Loading…</p></div>`)
      + block("st-sport", "Sport &amp; activity", `<div id="st-sport"><p class="hint">Loading…</p></div>`)
      + block("st-food", "Food, drink &amp; matchday economy", `<div id="st-food"><p class="hint">Loading…</p></div>`)
      + block("st-transport", "Transport nodes", `<div id="st-transport"><p class="hint">Loading…</p></div>`)
      + block("st-land", "Land &amp; regeneration", `<div id="st-land"><p class="hint">Loading…</p></div>`);
  }
  // Wire the sidebar controls once the panel is in the DOM.
  function wirePanel(panel) {
    panel.querySelectorAll(".st-mode").forEach(b => b.addEventListener("click", () => {
      if (!S.st || b.dataset.m === S.analyse) return;
      S.analyse = b.dataset.m;
      profile(S.st.p, { lng: S.st.lng, lat: S.st.lat }, true);
    }));
    const mins = panel.querySelector("#st-mins");
    if (mins) mins.addEventListener("change", () => {
      S.mins[S.analyse] = Number(mins.value);
      delete S.zones[S.analyse];
      profile(S.st.p, { lng: S.st.lng, lat: S.st.lat }, true);
    });
    const all = panel.querySelector("#st-showall");
    if (all) all.addEventListener("change", () => {
      S.showAll = all.checked;
      drawZones();
      if (S.showAll) buildOthers();
    });
    panel.querySelectorAll(".st-map").forEach(b => b.addEventListener("click", () => setOverlay(b.dataset.k, true)));
  }

  async function loadSummary(zone) {
    const sb = getSupabase();
    if (!sb || !S.st) return;
    const st = S.st;
    let data = null;
    try {
      const r = await sb.rpc("stadium_catchment_summary",
        { p_geom: zone.geometry, p_lng: st.lng, p_lat: st.lat });
      data = r.data;
      if (r.error) throw r.error;
    } catch (e) {
      for (const id of ["st-visitor", "st-sport", "st-food", "st-transport", "st-land"]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<p class="hint">Couldn't load (${esc(e.message || "error")}) — a very large drive-time zone can time out; try a shorter time.</p>`;
      }
      return;
    }
    if (S.st !== st || !data) return;
    render(data);
  }

  const kv = rows => `<div class="dd-kv">${rows.filter(Boolean).map(([k, v]) =>
    `<div class="dd-kv-row"><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
  const grid = cells => `<div class="dd-stats-grid">${cells.map(([v, l]) =>
    `<div class="dd-stat-cell"><div class="dd-stat-num">${v}</div><div class="dd-stat-cap">${l}</div></div>`).join("")}</div>`;
  const mapBtn = (k, l) => `<button type="button" class="ghost st-map" data-k="${k}">${l}</button>`;
  const KIND = { conference_centre: "Conference centre", events_venue: "Events venue",
    exhibition_centre: "Exhibition centre", theatre: "Theatre", concert_hall: "Concert hall",
    music_venue: "Music venue", arts_centre: "Arts centre", pitch: "Pitches", track: "Tracks",
    sports_centre: "Sports centres", sports_hall: "Sports halls", golf_course: "Golf courses",
    ice_rink: "Ice rinks", pub: "Pubs", bar: "Bars", restaurant: "Restaurants", cafe: "Cafés",
    fast_food: "Fast food", hotel: "Hotels", guest_house: "Guest houses", hostel: "Hostels",
    motel: "Motels", apartment: "Serviced apartments" };

  function render(d) {
    const h = d.hotels || {}, v = d.venues || {}, sp = d.sport || {}, t = d.transport || {}, l = d.land || {};
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const est = s => s && s !== "tagged" ? `<span class="dd-hl-dim" title="estimated from ${s}">*</span>` : "";

    set("st-visitor",
      `<div class="st-sub">Hotels</div>`
      + grid([[fmt(h.n), "hotels in catchment"], [fmt(h.rooms), "rooms"], [fmt(h.beds), "bedspaces"]])
      + kv([["Within 1 km", `${fmt(h.bands?.["1000"]?.n)} · ${fmt(h.bands?.["1000"]?.beds)} beds`],
            ["Within 3 km", `${fmt(h.bands?.["3000"]?.n)} · ${fmt(h.bands?.["3000"]?.beds)} beds`],
            ["Within 5 km", `${fmt(h.bands?.["5000"]?.n)} · ${fmt(h.bands?.["5000"]?.beds)} beds`],
            Object.keys(h.by_type || {}).length ? ["Type", Object.entries(h.by_type).map(([k, n]) => `${KIND[k] || k} ${n}`).join(" · ")] : null,
            Object.keys(h.by_stars || {}).length ? ["Star rating", Object.entries(h.by_stars).sort().map(([k, n]) => `${k === "unrated" ? "unrated" : k + "★"} ${n}`).join(" · ")] : null])
      + ((h.top || []).length ? `<div class="st-list-tbl">${h.top.slice(0, 8).map(x =>
          `<div><span>${esc(x.name || x.brand || "Hotel")}</span><b>${fmt(x.rooms)}${est(x.src)} rooms</b><i>${km(x.dist_m)}</i></div>`).join("")}</div>` : "")
      + `<p class="hint">Rooms are tagged in OpenStreetMap for ${fmt(h.tagged)} of ${fmt(h.n)} catchment hotels; the rest (*) are estimated from the brand, the building footprint × storeys, or the typical size for the type. Bedspaces = rooms × 2.</p>`
      + `<div class="st-sub">Event, conference &amp; performance venues</div>`
      + grid([[fmt(v.n), "venues in catchment"], [v.cap_n ? fmt(v.capacity) : "—", `capacity (${fmt(v.cap_n)} known)`],
              [`${fmt(v.bands?.["1000"])} / ${fmt(v.bands?.["3000"])} / ${fmt(v.bands?.["5000"])}`, "within 1 / 3 / 5 km"]])
      + ((v.top || []).length ? `<div class="st-list-tbl">${v.top.slice(0, 8).map(x =>
          `<div><span>${esc(x.name || "Venue")} <em>${KIND[x.kind] || x.kind}</em></span><b>${x.capacity ? fmt(x.capacity) : "—"}</b><i>${km(x.dist_m)}</i></div>`).join("")}</div>` : "")
      + `<p class="hint">Capacity is recorded for few venues (OSM / Wikidata), so totals understate the offer.</p>`
      + `<div class="st-maps">${mapBtn("hotel", "Map hotels")}${mapBtn("event_venue", "Map venues")}</div>`);

    const kinds = Object.entries(sp.by_kind || {}).sort((a, b) => b[1].n - a[1].n);
    set("st-sport",
      grid([[fmt(sp.n), "sports facilities"], [`${fmt(sp.area_ha)} ha`, "mapped sports land"],
            [fmt((sp.by_kind?.pitch || {}).n), "pitches"]])
      + kv(kinds.map(([k, x]) => [KIND[k] || k, `${fmt(x.n)} · ${x.ha} ha`]))
      + ((sp.by_sport || []).length ? `<p class="hint" style="margin-top:6px"><b>By sport:</b> ${sp.by_sport.map(x => `${esc(x.sport)} ${x.n}`).join(" · ")}</p>` : "")
      + ((d.stadia || []).length ? `<div class="st-sub">Other stadia in the catchment</div><div class="st-list-tbl">${d.stadia.map(x =>
          `<div><span>${esc(x.name || "Stadium")} <em>${esc(x.sport || "")}</em></span><b>${x.capacity ? fmt(x.capacity) : "—"}</b><i>${km(x.dist_m)}</i></div>`).join("")}</div>` : "")
      + `<p class="hint">Pitches, tracks, sports centres, halls, golf and ice rinks mapped in OpenStreetMap; area is the mapped outline (point-only features count but add no area).</p>`
      + `<div class="st-maps">${mapBtn("sports_facility", "Map sports facilities")}</div>`);

    const food = d.food || {}, ft = Object.values(food).reduce((a, b) => a + b, 0);
    set("st-food",
      grid([[fmt(ft), "food & drink outlets"], [fmt((food.pub || 0) + (food.bar || 0)), "pubs & bars"],
            [fmt((food.restaurant || 0) + (food.cafe || 0)), "restaurants & cafés"]])
      + kv(Object.entries(food).sort((a, b) => b[1] - a[1]).map(([k, n]) => [KIND[k] || k, fmt(n)]))
      + `<p class="hint">GPs, schools, pharmacies, nurseries and food stores are in <b>Amenities in this area</b> below.</p>`
      + `<div class="st-maps">${mapBtn("food_drink", "Map food & drink")}</div>`);

    set("st-transport",
      ((t.stations || []).length ? `<div class="st-sub">Rail stations within 2 km</div><div class="st-list-tbl">${t.stations.map(x =>
          `<div><span>${esc(x.name)} <em>${x.crs}</em></span><b>${x.usage ? fmt(x.usage) + "/yr" : "—"}</b><i>${km(x.dist_m)}</i></div>`).join("")}</div>`
        : `<p class="hint">No National Rail station within 2 km.</p>`)
      + kv([["Bus stops in catchment", `${fmt(t.bus?.stops)} (${fmt(t.bus?.served)} served)`],
            ["Buses per hour (07:00–19:00, all stops)", fmt(t.bus?.buses_hr)],
            ["Bus departures per weekday", fmt(t.bus?.trips_day)],
            ["Car parks (mapped)", `${fmt(t.parking?.n)} · ${fmt(t.parking?.ha)} ha`],
            S.analyse === "pt" && S.ptReached != null ? ["Stations reachable by direct train", fmt(S.ptReached)] : null])
      + `<p class="hint">Station usage is ORR annual entries &amp; exits. Bus figures are scheduled service from the BODS timetable. Matchday specials are not in the timetables.</p>`);

    const pc = l.public_parcels || {};
    set("st-land",
      grid([[fmt(pc.n), "publicly owned parcels"], [`${fmt(pc.ha)} ha`, "public land"],
            [l.resi_land_gbp_ha ? `£${(l.resi_land_gbp_ha / 1e6).toFixed(1)}m` : "—", "resi land value / ha"]])
      + kv([Object.keys(pc.by_class || {}).length ? ["Owners", Object.entries(pc.by_class).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(" · ")] : null,
            ["Council property records", fmt(l.la_property)],
            ["Surface & multi-storey parking", `${fmt(t.parking?.ha)} ha — often the first regeneration land around a ground`]])
      + `<p class="hint">Land value is the MHCLG/VOA residential benchmark for the authority (an appraisal benchmark, not a site valuation). Brownfield sites, deprivation, population and house prices follow below.</p>`);
  }

  // ---- place-anchor profile (stadium_metrics, migrations 0089/0090) ----------
  let METRICS = null;
  async function allMetrics() {
    if (METRICS) return METRICS;
    const sb = getSupabase();
    if (!sb) return [];
    const { data } = await sb.from("stadium_metrics").select("*").limit(2000);
    METRICS = data || [];
    return METRICS;
  }
  async function metricsFor(st) {
    if (!st) return null;
    const all = await allMetrics();
    let best = null, bd = 1e9;
    for (const r of all) {
      const dd = Math.hypot(r.lng - st.lng, (r.lat - st.lat) * 1.6);
      if (dd < bd) { bd = dd; best = r; }
    }
    return bd < 0.003 ? best : null;
  }
  const pctOf = (all, k, v) => {
    const xs = all.map(r => r[k]).filter(x => x != null);
    return xs.length && v != null ? Math.round(100 * xs.filter(x => x <= v).length / xs.length) : null;
  };
  const bar = (label, v, color, note = "") => `
    <div class="st-ix"><span>${label}</span>
      <div class="st-ix-bar"><i style="width:${v == null ? 0 : v}%;background:${color}"></i></div>
      <b>${v == null ? "—" : Math.round(v)}</b>${note ? `<em>${note}</em>` : ""}</div>`;
  const ha = v => v == null ? "—" : `${Number(v).toFixed(1)} ha`;

  async function loadAnchor(st) {
    const el = () => document.getElementById("st-anchor");
    const row = await metricsFor(st);
    if (S.st !== st || !el()) return;
    if (!row) { el().innerHTML = `<p class="hint">No benchmark row for this ground yet.</p>`; return; }
    const all = (await allMetrics()).filter(r => (r.capacity || 0) >= 1000);
    const everyday = (row.pop_800 || 0) + (row.jobs_800 || 0);
    const crowd = row.capacity && row.fill_rate ? Math.round(row.capacity * row.fill_rate) : null;
    const peers = all.filter(r => r.source_id !== row.source_id && (row.tier === r.tier
        || (row.capacity && r.capacity && Math.abs(Math.log(r.capacity / row.capacity)) < 0.25)))
      .sort((a, b) => Math.abs(Math.log((a.capacity || 1) / (row.capacity || 1))) - Math.abs(Math.log((b.capacity || 1) / (row.capacity || 1))))
      .slice(0, 6);
    const cols = [["capacity", "Seats", fmt], ["reach_pt45", "PT 45 min", v => v == null ? "—" : `${(v / 1e3).toFixed(0)}k`],
      ["regen_ha", "Land 800 m", v => v == null ? "—" : Math.round(v)], ["imd_1500", "Depriv.", v => v == null ? "—" : Math.round(v)],
      ["beds_per_100", "Beds/100", v => v == null ? "—" : Math.round(v)], ["anchor_index", "Anchor", v => v == null ? "—" : Math.round(v)]];
    const prow = (r, me) => `<tr${me ? ' class="me"' : ""}><td>${esc(r.name || "")}</td>${cols.map(([k, , f]) => `<td>${f(r[k])}</td>`).join("")}</tr>`;
    const reachMax = Math.max(row.reach_drive20 || 0, row.reach_pt45 || 0, 1);
    const rbar = (l, v, c) => `<div class="st-reach"><span>${l}</span><div><i style="width:${Math.max(1, 100 * (v || 0) / reachMax)}%;background:${c}"></i></div><b>${fmt(v)}</b></div>`;
    el().innerHTML = `
      <div class="st-typo"><span class="st-chip">${esc(row.typology || "—")}</span><span class="st-chip ghost">${esc(row.tier || "")}</span>${row.nation ? `<span class="st-chip ghost">${esc(row.nation)}</span>` : ""}</div>
      <div class="st-sub">Indices · percentile among ${all.length} UK grounds with 1,000+ seats</div>
      ${bar("Regeneration", row.regen_index, "#e8590c")}
      ${bar("Social value", row.social_index, "#2f9e44")}
      ${bar("Visitor economy", row.visitor_index, "#7048e8")}
      ${bar("Place anchor", row.anchor_index, "#1c2533")}
      <div class="st-sub">Matchday vs everyday</div>
      ${grid([[fmt(row.matchdays), "matchdays / yr (est.)"], [fmt(row.idle_days), "days with no fixture"],
              [row.annual_visits ? (row.annual_visits >= 1e6 ? `${(row.annual_visits / 1e6).toFixed(1)}m` : `${Math.round(row.annual_visits / 1e3)}k`) : "—", "matchday visits / yr"]])}
      ${crowd && everyday ? `<div class="st-surge"><div><i style="width:${Math.min(100, 100 * everyday / Math.max(everyday, crowd))}%"></i><span>Everyday: ${fmt(everyday)} residents + workers within 800 m</span></div>
        <div><i class="c" style="width:${Math.min(100, 100 * crowd / Math.max(everyday, crowd))}%"></i><span>Matchday crowd: ${fmt(crowd)}</span></div></div>
        <p class="hint">On a matchday the area within 10 minutes' walk holds <b>${row.surge_ratio}×</b> its everyday population; on the other ${row.idle_days} days the ground is a ${row.capacity ? `${fmt(row.capacity)}-seat` : ""} structure with nothing on. Matchdays and fill rate are modelled for the ${esc(row.tier)} tier.</p>` : ""}
      <div class="st-sub">Network reach · people</div>
      ${rbar("Walk 15 min", row.reach_walk15, "#2f9e44")}
      ${rbar("PT 30 min", row.reach_pt30, "#9775fa")}
      ${rbar("PT 45 min", row.reach_pt45, "#7048e8")}
      ${rbar("Drive 20 min", row.reach_drive20, "#e8590c")}
      <p class="hint">Public transport leaves the ground at 17:00 on a Saturday. It reaches <b>${row.pt_share != null ? Math.round(row.pt_share * 100) + "%" : "—"}</b> as many people as a 20-minute drive (UK median ${Math.round(100 * median(all.map(r => r.pt_share)))}%).</p>
      <div class="st-sub">Land supply within 800 m</div>
      ${grid([[ha(row.regen_ha), "regenerable land (union)"], [ha(row.parking_ha), "parking"], [ha(row.public_ha), "public ownership"]])}
      ${kv([["Brownfield", ha(row.brownfield_ha)], ["Retail, industrial & storage", ha(row.lowvalue_ha)],
            ["Green space", ha(row.green_ha)],
            ["Constraints", `flood zone 3 ${Math.round(100 * (row.flood3_share || 0))}% · conservation ${Math.round(100 * (row.conservation_share || 0))}% · ${fmt(row.listed_800)} listed buildings`],
            ["UK percentile (land)", `${pctOf(all, "regen_ha", row.regen_ha) ?? "—"}th`]])}
      <div class="st-sub">Hotel fit</div>
      ${grid([[row.beds_per_100 != null ? fmt(Math.round(row.beds_per_100)) : "—", "bedspaces per 100 seats (5 km)"],
              [fmt(row.beds_1k), "bedspaces within 1 km"], [fmt(row.beds_5k), "within 5 km"]])}
      <p class="hint">${row.beds_per_100 != null && row.beds_per_100 < 25 ? "Thin hotel supply for the crowd — visiting fans and event-day stays leak to other places." : "Hotel supply could absorb a share of visiting demand."} UK median ${Math.round(median(all.map(r => r.beds_per_100)))} per 100 seats.</p>
      <div class="st-sub">Social value &amp; community reach</div>
      ${kv([["Deprivation within 1.5 km", row.imd_1500 != null ? `${Math.round(row.imd_1500)}th percentile (100 = most deprived)` : "—"],
            ["Income · health · employment", [row.imd_income, row.imd_health, row.imd_employment].map(v => v == null ? "—" : Math.round(v)).join(" · ")],
            ["People within 15 min walk", fmt(row.reach_walk15)],
            ["Schools within 1.5 km", fmt(row.schools_1500)],
            ["Sports facilities · pitches (1.5 km)", `${fmt(row.sport_fac_1500)} · ${ha(row.pitch_ha_1500)}`]])}
      ${peers.length ? `<div class="st-sub">Peers · ${row.tier ? esc(row.tier) + " or similar size" : "similar size"}</div>
        <div class="st-peer-wrap"><table class="st-peer"><thead><tr><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>
        <tbody>${prow(row, true)}${peers.map(r => prow(r, false)).join("")}</tbody></table></div>` : ""}
      <p class="hint">Full UK comparison in <a href="#" class="st-open-study">Studies → UK Stadium Analysis</a>.</p>`;
    const a = el().querySelector(".st-open-study");
    if (a) a.addEventListener("click", e => { e.preventDefault(); if (d.openStudy) d.openStudy("stadia", row.source_id); });
  }
  function median(xs) {
    const v = xs.filter(x => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }

  return { filterHTML, onLayers, openCard, profile, sectionHTML, wirePanel, clear, applyFilter, allMetrics };
}
