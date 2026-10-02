"""
hotel_rooms.py
--------------
Room counts for hotels that OpenStreetMap doesn't tag (about 92% of them),
for build_sport_leisure.py.

Every hotel is joined to the OSM building it occupies: its own outline when
the hotel is mapped as a building, otherwise the building containing the
hotel point, or the buildings a hotel site polygon covers. Where the building
is split into building:parts, every part counts. Floorspace is then
footprint × storeys. Storeys come from building:levels, else height / 3.2 m,
else the JRC GHSL average built height for the surrounding ~90 m
(GHS-BUILT-H 2018, CC BY 4.0) / 3.2, else the median tagged storeys nearby.

Rooms are then predicted by a log-linear model calibrated on every hotel
that does tag its rooms:

  log(rooms) = a + b·log(floorspace) + c·[storeys known]
             + d·log(GHSL height) + type effect + brand effect

where the brand effects (Premier Inn, Travelodge, Holiday Inn Express, ...)
are ridge-shrunk, so a brand with few examples stays close to the overall
fit. GHSL height enters twice on purpose: as storeys for the floorspace, and
as a density signal, because taller surroundings mean more rooms per m².

The model is cross-validated (5-fold) on each run and the error printed. On
the October 2026 build it was:
  old method (brand median, own-outline footprint)   median abs error 53%, 48% within ±50%, bias +20%
  this model                                          median abs error 35%, 67% within ±50%, bias 0%
Per-hotel figures are therefore indicative. Area totals (beds within 1, 3
or 5 km of a ground) are much more reliable, since the errors are unbiased
and largely cancel.

Known room counts in pipeline/data/hotel_rooms_overrides.csv (osm_id, rooms)
always win, ahead of the OSM tag.

rooms_src: override | tagged | model (building found) | brand | typical.
"""

import csv
import json
import math
import random
import statistics
from pathlib import Path

import numpy as np
from shapely.geometry import Point, shape

OVERRIDES = Path(__file__).resolve().parent / "data" / "hotel_rooms_overrides.csv"
CELL = 0.004                     # ~400 m grid for the building join / local storeys
TYPES = ["apartment", "guest_house", "hostel", "hotel", "motel"]


def _num(v):
    try:
        return float(str(v).split(";")[0].replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _levels(p):
    v = _num(p.get("building:levels"))
    if v and 0 < v < 80:
        return v
    h = _num(str(p.get("height") or "").replace("m", ""))
    if h and 2 < h < 300:
        return max(1.0, round(h / 3.2))
    return None


def join_buildings(hotels, building_lines):
    """hotels: [{id, lon, lat, geom}]; building_lines: iterable of OSM
    geojsonseq lines (buildings and building:parts). Returns (match, cell_lv):
    match[id] = [{id, m2, lv, part, ov}], cell_lv[(cx, cy)] = median storeys."""
    grid = {}
    for i, h in enumerate(hotels):
        grid.setdefault((int(h["lon"] // CELL), int(h["lat"] // CELL)), []).append(i)
    near = {(cx + a, cy + b) for cx, cy in grid for a in (-1, 0, 1) for b in (-1, 0, 1)}
    shapes = [None] * len(hotels)
    match, stats, n = {}, {}, 0
    for line in building_lines:
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        n += 1
        try:
            f = json.loads(line)
        except ValueError:
            continue
        gm = f.get("geometry") or {}
        if gm.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        ring = gm["coordinates"][0] if gm["type"] == "Polygon" else gm["coordinates"][0][0]
        xs, ys = [q[0] for q in ring], [q[1] for q in ring]
        k = (int((min(xs) + max(xs)) / 2 // CELL), int((min(ys) + max(ys)) / 2 // CELL))
        if k not in near:
            continue
        p = f.get("properties") or {}
        lv = _levels(p)
        if lv and not p.get("building:part"):
            stats.setdefault(k, []).append(lv)
        g = None
        for i in (j for a in (-1, 0, 1) for b in (-1, 0, 1) for j in grid.get((k[0] + a, k[1] + b), ())):
            h = hotels[i]
            if not (min(xs) - 3e-4 <= h["lon"] <= max(xs) + 3e-4 and min(ys) - 3e-4 <= h["lat"] <= max(ys) + 3e-4):
                continue
            if g is None:
                g = shape(gm)
                if not g.is_valid:
                    g = g.buffer(0)
            if shapes[i] is None:
                shapes[i] = shape(h["geom"]) if h.get("geom") else Point(h["lon"], h["lat"])
            hg, pt = shapes[i], Point(h["lon"], h["lat"])
            inside = g.contains(pt)
            ov = 1.0
            if hg.geom_type != "Point":
                if not g.intersects(hg):
                    continue
                try:
                    ov = g.intersection(hg).area / max(g.area, 1e-12)
                except Exception:
                    ov = 0.5
                if ov < 0.3 and not inside:
                    continue
            elif not inside:
                continue
            m2 = g.area * 111320 ** 2 * math.cos(math.radians(h["lat"]))
            bid = f"{str(p.get('@type', 'w'))[:1]}{p.get('@id')}"
            match.setdefault(h["id"], []).append({"id": bid, "m2": m2, "lv": lv,
                                                  "part": bool(p.get("building:part")), "ov": ov})
    cell_lv = {k: statistics.median(v) for k, v in stats.items() if len(v) >= 3}
    print(f"[hotels] {n:,} buildings scanned; {len(match):,} of {len(hotels):,} hotels matched to a footprint",
          flush=True)
    return match, cell_lv


def ghs_heights(hotels, tifs):
    """Max GHSL average net building height (m) in the 3×3 cells around each hotel."""
    try:
        import rasterio
    except ImportError:
        print("[hotels] rasterio not installed — no GHSL heights", flush=True)
        return {}
    srcs = [rasterio.open(t) for t in tifs if Path(t).exists()]
    out = {}
    for h in hotels:
        for r in srcs:
            b = r.bounds
            if not (b.left <= h["lon"] < b.right and b.bottom <= h["lat"] < b.top):
                continue
            row, col = r.index(h["lon"], h["lat"])
            try:
                w = r.read(1, window=((row - 1, row + 2), (col - 1, col + 2)))
            except Exception:
                break
            v = w[w > 0]
            if v.size:
                out[h["id"]] = float(v.max())
            break
    print(f"[hotels] GHSL height for {len(out):,} hotels", flush=True)
    return out


def _floorspace(h, match, cell_lv):
    m = match.get(h["id"], [])
    if not m:
        return None, False
    cx, cy = int(h["lon"] // CELL), int(h["lat"] // CELL)
    local = [cell_lv[(cx + a, cy + b)] for a in (-1, 0, 1) for b in (-1, 0, 1) if (cx + a, cy + b) in cell_lv]
    imp = statistics.median(local) if local else (2 if h["type"] == "guest_house" else 3)
    if h.get("ghs"):
        imp = max(1.0, min(30.0, h["ghs"] / 3.2))
    parts = [b for b in m if b["part"]]
    whole = [b for b in m if not b["part"]]
    if parts and any(b["lv"] for b in parts):
        return sum(b["m2"] * (b["lv"] or imp) for b in parts), True
    if h["poly"] and not h["own_bld"]:
        bs = [b for b in whole if b["ov"] >= 0.5] or whole
    else:
        own = [b for b in m if b["id"] == h["id"]]
        bs = own or sorted(whole or parts, key=lambda b: b["m2"])[:1]
    known, F = False, 0.0
    for b in bs:
        lv = b["lv"] or h.get("lvtag")
        known = known or bool(lv)
        F += b["m2"] * min(lv or imp, 40)
    return (F if F > 30 else None), known


def _x(h, brands):
    v = [1.0, math.log(h["F"]), 1.0 if h["known"] else 0.0, math.log(max(h.get("ghs") or 3.0, 3.0))]
    v += [1.0 if h["type"] == t else 0.0 for t in TYPES[1:]]
    v += [1.0 if h["brand"] == b else 0.0 for b in brands]
    return v


def _fit(train):
    tr = [h for h in train if h["rooms"] and h["F"]]
    counts = {}
    for h in tr:
        if h["brand"]:
            counts[h["brand"]] = counts.get(h["brand"], 0) + 1
    brands = sorted(b for b, c in counts.items() if c >= 4)
    X = np.array([_x(h, brands) for h in tr])
    y = np.log([h["rooms"] for h in tr])
    lam = np.full(X.shape[1], 1e-3)
    lam[4:4 + len(TYPES) - 1] = 0.5
    lam[4 + len(TYPES) - 1:] = 3.0
    beta = np.linalg.solve(X.T @ X + np.diag(lam), X.T @ y)
    bmed, tmed = {}, {}
    for h in train:
        if h["rooms"]:
            tmed.setdefault(h["type"], []).append(h["rooms"])
            if h["brand"]:
                bmed.setdefault(h["brand"], []).append(h["rooms"])
    return {"beta": beta, "brands": brands,
            "bmed": {b: statistics.median(v) for b, v in bmed.items() if len(v) >= 5},
            "tmed": {k: statistics.median(v) for k, v in tmed.items()}}


def _predict(m, h):
    if h["F"]:
        est = math.exp(float(np.array(_x(h, m["brands"])) @ m["beta"]))
        return max(1 if h["type"] == "guest_house" else 3, min(1500, round(est))), "model"
    if h["brand"] in m["bmed"]:
        return round(m["bmed"][h["brand"]]), "brand"
    return round(m["tmed"].get(h["type"], 10)), "typical"


def _report(errs):
    a = np.abs(np.exp(np.array(errs)) - 1)
    return (f"median abs error {100 * np.median(a):.0f}%, {100 * np.mean(a <= .25):.0f}% within ±25%, "
            f"{100 * np.mean(a <= .5):.0f}% within ±50%, bias {100 * (np.exp(np.median(errs)) - 1):+.0f}%")


def load_overrides():
    if not OVERRIDES.exists():
        return {}
    with OVERRIDES.open(encoding="utf-8") as fh:
        return {r["osm_id"].strip(): int(r["rooms"]) for r in csv.DictReader(fh)
                if r.get("osm_id") and (r.get("rooms") or "").strip().isdigit()}


def estimate(hotels, match, cell_lv, ghs):
    """hotels: [{id, lon, lat, geom, t}] -> {id: (rooms, rooms_src)}."""
    H = []
    for r in hotels:
        t = r["t"]
        n = _num(t.get("rooms"))
        H.append({"id": r["id"], "lon": r["lon"], "lat": r["lat"], "type": t.get("tourism"),
                  "brand": (t.get("brand") or "").strip().lower(), "rooms": n if n and 3 <= n <= 2000 else None,
                  "tag": n if n and 1 <= n <= 2000 else None,
                  "poly": bool(r.get("geom")) and r["geom"].get("type") != "Point",
                  "own_bld": bool(t.get("building") or t.get("building:part")),
                  "lvtag": _num(t.get("building:levels")), "ghs": ghs.get(r["id"])})
    for h in H:
        h["F"], h["known"] = _floorspace(h, match, cell_lv)
    tagged = [h for h in H if h["rooms"]]
    random.Random(1).shuffle(tagged)
    errs = []
    for k in range(5):
        test = tagged[k::5]
        ids = {h["id"] for h in test}
        m = _fit([h for h in H if h["id"] not in ids])
        errs += [math.log(_predict(m, h)[0] / h["rooms"]) for h in test]
    print(f"[hotels] 5-fold check on {len(tagged):,} tagged hotels: {_report(errs)}", flush=True)
    m = _fit(H)
    over = load_overrides()
    out = {}
    for h in H:
        if h["id"] in over:
            out[h["id"]] = (over[h["id"]], "override")
        elif h["tag"]:
            out[h["id"]] = (round(h["tag"]), "tagged")
        else:
            out[h["id"]] = _predict(m, h)
    c = {}
    for _, s in out.values():
        c[s] = c.get(s, 0) + 1
    print(f"[hotels] rooms by source: {c}; {len(m['brands'])} brand effects", flush=True)
    return out
