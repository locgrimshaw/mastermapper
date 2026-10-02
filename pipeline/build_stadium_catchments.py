"""
build_stadium_catchments.py
---------------------------
Network catchments and populations for every stadium, for stadium_metrics
(migration 0089) and the stadium sidebar / UK Stadium Analysis study.

Per stadium:
  walk 15 min, drive 20 min  street-network isochrones (Valhalla, OSM) — read
                             from ISO_VH (a JSON cache built by the workflow's
                             Valhalla step) when present.
  public transport 30 / 45 min
                             earliest-arrival Connection Scan over the BODS
                             national timetable (bus, tram, Underground, DLR,
                             ferry excluded), leaving the ground at 17:00 on a
                             Saturday — the post-match dispersal — plus one
                             direct National Rail hop from any station reached
                             (station_links: scheduled minutes; waiting time =
                             half the average daytime headway, capped at 30 min).
                             The catchment is the union of walking discs around
                             every stop/station reached, sized by the minutes
                             left (80 m/min, 1.3 detour factor, max 1.2 km).
  population                 Meta High Resolution Population Density (2019,
                             ~30 m grid, UK-wide, CC BY 4.0) summed inside the
                             800 m / 1.5 km / 3 km rings and each catchment —
                             one consistent source for all four nations.

Inputs (env): GTFS_ZIP (BODS all-regions GTFS), POP_NPZ (lat/lon/pop npz,
built from the HDX CSV on first run), ISO_VH (Valhalla cache JSON, filled by
fetch_valhalla() unless WAIT_VH is set),
SUPABASE_URL / SUPABASE_KEY (read stadium_metrics, stations, station_links).
Output: data/raw/stadium_catchments.json — {"iso": [...], "metrics": [...]}
for the loader.

Licences: BODS OGL v3; OSM ODbL; Meta population CC BY 4.0; ORR/RDG data.
"""

import csv
import datetime as dt
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
GTFS_ZIP = Path(os.environ.get("GTFS_ZIP") or RAW / "bus-gtfs.zip")
POP_NPZ = Path(os.environ.get("POP_NPZ") or RAW / "pop_gbr.npz")
ISO_VH = Path(os.environ.get("ISO_VH") or RAW / "iso_vh.json")
OUT = RAW / "stadium_catchments.json"
SB_URL = os.environ.get("SUPABASE_URL", "https://vwljbgyrsnnubrbjaxbc.supabase.co")
SB_KEY = os.environ.get("SUPABASE_KEY", "sb_publishable_j55jzkpiaVPeAYii1RoCxA_RX1bt956")

T0 = 17 * 3600                 # leave the ground at 17:00, Saturday
BUDGETS = (30, 45)             # minutes
WALK_MPM = 80.0 / 1.3          # straight-line metres per minute of walking
MAX_WALK_M = 1200.0
ACCESS_M = 1200.0              # stadium -> first stop
TRANSFER_M = 300.0
REGION_M = 70000.0             # connections considered around each ground
MODES_OK = {"0", "1", "3"} | {str(x) for x in range(700, 800)} | {"900", "400", "401", "2", "100", "101", "102"}

to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)


def rest(path):
    req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}",
                                 headers={"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY})
    out, off = [], 0
    while True:
        r = urllib.request.Request(req.full_url, headers={**req.headers, "Range-Unit": "items",
                                                         "Range": f"{off}-{off + 999}"})
        rows = json.load(urllib.request.urlopen(r, timeout=120))
        out += rows
        if len(rows) < 1000:
            return out
        off += 1000


def secs(t):
    try:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except (ValueError, AttributeError):
        return None


class Gtfs:
    def __init__(self, path):
        self.zf = zipfile.ZipFile(path)
        self.m = {n.lower().rsplit("/", 1)[-1]: n for n in self.zf.namelist()}

    def rows(self, name):
        fh = io.TextIOWrapper(self.zf.open(self.m[name]), "utf-8-sig", errors="ignore", newline="")
        rd = csv.reader(fh)
        h = {k.strip(): i for i, k in enumerate(next(rd))}
        return h, rd


def saturday_services(g):
    d = dt.date.today()
    d += dt.timedelta(days=(5 - d.weekday()) % 7)
    ds = d.strftime("%Y%m%d")
    on = set()
    h, rd = g.rows("calendar.txt")
    for r in rd:
        if r[h["saturday"]] == "1" and r[h["start_date"]] <= ds <= r[h["end_date"]]:
            on.add(r[h["service_id"]])
    if "calendar_dates.txt" in g.m:
        h, rd = g.rows("calendar_dates.txt")
        for r in rd:
            if r[h["date"]] == ds:
                (on.add if r[h["exception_type"]] == "1" else on.discard)(r[h["service_id"]])
    return d, on


def load_connections(g):
    day, services = saturday_services(g)
    h, rd = g.rows("routes.txt")
    routes = {r[h["route_id"]] for r in rd if r[h["route_type"]] in MODES_OK}
    h, rd = g.rows("trips.txt")
    trips = {}
    for r in rd:
        if r[h["service_id"]] in services and r[h["route_id"]] in routes:
            trips[r[h["trip_id"]]] = len(trips)
    h, rd = g.rows("stops.txt")
    stop_idx, sx, sy = {}, [], []
    for r in rd:
        try:
            lon, lat = float(r[h["stop_lon"]]), float(r[h["stop_lat"]])
        except ValueError:
            continue
        stop_idx[r[h["stop_id"]]] = len(sx)
        sx.append(lon); sy.append(lat)
    x, y = to_bng.transform(np.array(sx), np.array(sy))
    lo, hi = T0 - 600, T0 + max(BUDGETS) * 60 + 600
    h, rd = g.rows("stop_times.txt")
    it, isd, isq, ia, idp = h["trip_id"], h["stop_id"], h["stop_sequence"], h["arrival_time"], h["departure_time"]
    cd, ca, td, ta, tr = [], [], [], [], []
    cur, calls = None, []

    def flush():
        calls.sort()
        for (s1, _, d1), (s2, a2, _) in zip(calls, calls[1:]):
            if d1 is None or a2 is None or a2 < d1 or d1 < lo or d1 > hi:
                continue
            cd.append(stop_idx[s1[1]]); ca.append(stop_idx[s2[1]])
            td.append(d1); ta.append(a2); tr.append(trips[cur])

    n = 0
    for r in rd:
        n += 1
        t = r[it]
        if t != cur:
            if cur is not None and cur in trips and len(calls) > 1:
                flush()
            cur, calls = t, []
        if t not in trips or r[isd] not in stop_idx:
            continue
        try:
            sq = int(r[isq])
        except ValueError:
            continue
        a, d = secs(r[ia] or r[idp]), secs(r[idp] or r[ia])
        if d is not None and (d < lo - 7200 or d > hi + 3600):
            continue
        calls.append(((sq, r[isd]), a, d))
    if cur in trips and len(calls) > 1:
        flush()
    order = np.argsort(np.array(td), kind="stable")
    conns = {k: np.array(v)[order] for k, v in (("dep", cd), ("arr", ca), ("td", td), ("ta", ta), ("trip", tr))}
    print(f"[iso] {day} Saturday: {len(trips):,} trips, {n:,} stop_times read, "
          f"{len(order):,} connections 16:50-18:05", flush=True)
    return x, y, conns


def footpaths(x, y):
    """stop -> [(stop, seconds)] within TRANSFER_M, via a 300 m grid."""
    cell = TRANSFER_M
    gx, gy = (x // cell).astype(np.int64), (y // cell).astype(np.int64)
    grid = {}
    for i, k in enumerate(zip(gx, gy)):
        grid.setdefault(k, []).append(i)
    fp = [[] for _ in range(len(x))]
    for (cx, cy), members in grid.items():
        near = [j for a in (-1, 0, 1) for b in (-1, 0, 1) for j in grid.get((cx + a, cy + b), ())]
        nj = np.array(near)
        for i in members:
            d = np.hypot(x[nj] - x[i], y[nj] - y[i])
            sel = (d <= TRANSFER_M) & (nj != i)
            fp[i] = list(zip(nj[sel].tolist(), (d[sel] / WALK_MPM * 60).astype(int).tolist()))
    return fp


def csa(sx, sy, x, y, conns, fp, budget_s):
    """Earliest arrival (seconds after T0) at every stop reachable within budget."""
    d0 = np.hypot(x - sx, y - sy)
    region = d0 <= REGION_M
    start = np.where(d0 <= ACCESS_M)[0]
    best = {int(i): int(d0[i] / WALK_MPM * 60) for i in start}
    if not best:
        return best
    sel = region[conns["dep"]] & (conns["td"] >= T0) & (conns["td"] <= T0 + budget_s)
    dep, arr, td, ta, trip = (conns[k][sel] for k in ("dep", "arr", "td", "ta", "trip"))
    on_trip = set()
    INF = 1 << 30
    for i in range(len(dep)):
        t_dep = int(td[i]) - T0
        tr = int(trip[i])
        if tr in on_trip or best.get(int(dep[i]), INF) <= t_dep:
            on_trip.add(tr)
            t_arr = int(ta[i]) - T0
            a = int(arr[i])
            if t_arr <= budget_s and t_arr < best.get(a, INF):
                best[a] = t_arr
                for j, w in fp[a]:
                    if t_arr + w < best.get(j, INF):
                        best[j] = t_arr + w
    return best


def rail_hops(sx, sy, best, x, y, stations, links, budget_s):
    """{(lng,lat): seconds} for stations reached by walk / PT, then one direct train."""
    st_xy = {c: to_bng.transform(s["lng"], s["lat"]) for c, s in stations.items()}
    reach = {}
    bi = np.array(list(best.keys()), dtype=np.int64) if best else np.array([], dtype=np.int64)
    bt = np.array([best[int(k)] for k in bi]) if len(bi) else np.array([])
    for c, (ex, ey) in st_xy.items():
        d = math.hypot(ex - sx, ey - sy)
        t = d / WALK_MPM * 60 if d <= ACCESS_M else 1 << 30
        if len(bi):
            dd = np.hypot(x[bi] - ex, y[bi] - ey)
            ok = dd <= 400
            if ok.any():
                t = min(t, float((bt[ok] + dd[ok] / WALK_MPM * 60).min()))
        if t < budget_s:
            reach[c] = t
    out = {}
    for c, t in reach.items():
        out[c] = min(out.get(c, 1 << 30), t)
        for (to, mins, n) in links.get(c, ()):
            wait = min(1800, 0.5 * 12 * 3600 / max(n * 0.6, 1))
            ta = t + wait + mins * 60
            if ta < budget_s:
                out[to] = min(out.get(to, 1 << 30), ta)
    return {st_xy[c]: t for c, t in out.items() if c in st_xy}


def discs(points, budget_s, origin):
    # the ground itself: walking alone, uncapped, so PT always contains walk
    geoms = [shapely.Point(*origin).buffer(budget_s / 60 * WALK_MPM, 24)]
    for (px, py), t in points:
        r = min(MAX_WALK_M, (budget_s - t) / 60 * WALK_MPM)
        if r > 60:
            geoms.append(shapely.Point(px, py).buffer(r, 12))
    return unary_union(geoms)


POP_CSV_URL = ("https://data.humdata.org/dataset/b9a7b4a3-75a7-4de1-b741-27d78e8d0564/resource/"
               "674a0049-1a75-4f9a-a07b-654bda75456e/download/population_gbr_2019-07-01.csv.zip")


def ensure_pop():
    """Meta's 2019 GB grid (~1.2 GB CSV, 19m cells) -> compact npz, once."""
    if POP_NPZ.exists():
        return
    zp = POP_NPZ.with_suffix(".csv.zip")
    if not zp.exists():
        print(f"[iso] downloading {POP_CSV_URL}", flush=True)
        urllib.request.urlretrieve(POP_CSV_URL, zp)
    lat, lon, pop = [], [], []
    with zipfile.ZipFile(zp) as zf:
        fh = io.TextIOWrapper(zf.open(zf.namelist()[0]), "utf-8", newline="")
        rd = csv.reader(fh)
        next(rd)
        for r in rd:
            lat.append(float(r[0])); lon.append(float(r[1])); pop.append(float(r[2]))
    np.savez(POP_NPZ, lat=np.array(lat, "float32"), lon=np.array(lon, "float32"), pop=np.array(pop, "float32"))


def fetch_valhalla(st):
    """Walk 15 / drive 20 isochrones from the public Valhalla server, cached in
    ISO_VH so a re-run only fetches new grounds. ~1 request a second."""
    out = json.loads(ISO_VH.read_text()) if ISO_VH.exists() else {}
    for i, s in enumerate(st):
        for mode, costing, mins in (("walk", "pedestrian", 15), ("drive", "auto", 20)):
            k = f"{s['source_id']}|{mode}"
            if out.get(k):
                continue
            body = {"locations": [{"lat": s["lat"], "lon": s["lng"]}], "costing": costing,
                    "contours": [{"time": mins}], "polygons": True}
            url = "https://valhalla1.openstreetmap.de/isochrone?json=" + urllib.parse.quote(json.dumps(body))
            for a in range(5):
                try:
                    req = urllib.request.Request(url, headers={"X-Client-Id": "mastermapper", "User-Agent": "MasterMapper/1.0"})
                    gj = json.load(urllib.request.urlopen(req, timeout=40))
                    out[k] = next((f["geometry"] for f in gj.get("features", [])
                                   if f["geometry"]["type"] in ("Polygon", "MultiPolygon")), None)
                    break
                except Exception:
                    time.sleep(3 + 5 * a)
            time.sleep(1.1)
        if i % 25 == 0:
            ISO_VH.write_text(json.dumps(out))
            print(f"[iso] valhalla {i}/{len(st)}", flush=True)
    ISO_VH.write_text(json.dumps(out))
    return out


class Pop:
    def __init__(self, path):
        z = np.load(path)
        x, y = to_bng.transform(z["lon"].astype("float64"), z["lat"].astype("float64"))
        self.x, self.y, self.p = x, y, z["pop"].astype("float64")
        o = np.argsort(self.x)
        self.x, self.y, self.p = self.x[o], self.y[o], self.p[o]

    def window(self, minx, miny, maxx, maxy):
        a, b = np.searchsorted(self.x, minx), np.searchsorted(self.x, maxx)
        x, y, p = self.x[a:b], self.y[a:b], self.p[a:b]
        k = (y >= miny) & (y <= maxy)
        return x[k], y[k], p[k]

    def ring(self, cx, cy, r):
        x, y, p = self.window(cx - r, cy - r, cx + r, cy + r)
        return float(p[np.hypot(x - cx, y - cy) <= r].sum())

    def poly(self, g):
        if g is None or g.is_empty:
            return None
        x, y, p = self.window(*g.bounds)
        if not len(x):
            return 0.0
        return float(p[shapely.contains_xy(g, x, y)].sum())


def main():
    st = rest("stadium_metrics?select=source_id,name,lng,lat&order=id")
    if os.environ.get("LIMIT"):
        st = st[:int(os.environ["LIMIT"])]
    stations = {s["crs"]: s for s in rest("stations?select=crs,lng,lat")}
    links = {}
    for l in rest("station_links?select=crs_from,crs_to,minutes,trains_day"):
        if l["minutes"] and l["trains_day"]:
            links.setdefault(l["crs_from"], []).append((l["crs_to"], float(l["minutes"]), int(l["trains_day"])))
    print(f"[iso] {len(st)} stadia, {len(stations)} stations, {sum(map(len, links.values())):,} rail links", flush=True)
    vh = (json.loads(ISO_VH.read_text()) if ISO_VH.exists() else {}) if os.environ.get("WAIT_VH") else fetch_valhalla(st)
    ensure_pop()
    pop = Pop(POP_NPZ)
    print(f"[iso] population grid: {len(pop.p):,} cells, {pop.p.sum() / 1e6:.1f}m people", flush=True)
    g = Gtfs(GTFS_ZIP)
    x, y, conns = load_connections(g)
    fp = footpaths(x, y)
    to_wgs_t = lambda gg: transform(lambda a, b, z=None: to_wgs.transform(a, b), gg)
    to_bng_t = lambda gg: transform(lambda a, b, z=None: to_bng.transform(a, b), gg)
    isos, metrics = [], []
    t_start = time.time()
    for k, s in enumerate(st):
        sx, sy = to_bng.transform(s["lng"], s["lat"])
        m = {"source_id": s["source_id"],
             "pop_800": round(pop.ring(sx, sy, 800)), "pop_1500": round(pop.ring(sx, sy, 1500)),
             "pop_3000": round(pop.ring(sx, sy, 3000))}
        # (local runs alongside the Valhalla fetch: wait for its cache to catch up)
        while os.environ.get("WAIT_VH") and f"{s['source_id']}|drive" not in vh:
            time.sleep(20)
            try:
                vh = json.loads(ISO_VH.read_text())
            except ValueError:      # caught mid-write
                pass
        for mode, mins in (("walk", 15), ("drive", 20)):
            gj = vh.get(f"{s['source_id']}|{mode}")
            if gj:
                gb = to_bng_t(shape(gj))
                p = pop.poly(gb)
                m[f"reach_{mode}{mins}"] = round(p) if p is not None else None
                isos.append({"stadium": s["source_id"], "mode": mode, "minutes": mins, "pop": m[f"reach_{mode}{mins}"],
                             "geom": mapping(shape(gj).simplify(0.0003))})
        metrics.append(m)
        if s["lng"] < -5.4 and 54.0 < s["lat"] < 55.4:
            continue    # Northern Ireland: BODS has no NI timetable
        budget = max(BUDGETS) * 60
        best = csa(sx, sy, x, y, conns, fp, budget)
        rail = rail_hops(sx, sy, best, x, y, stations, links, budget)
        pts = [((float(x[i]), float(y[i])), t) for i, t in best.items()] + list(rail.items())
        for b in BUDGETS:
            bs = b * 60
            gb = discs([(p, t) for p, t in pts if t < bs], bs, (sx, sy)).simplify(40)
            p = pop.poly(gb)
            m[f"reach_pt{b}"] = round(p)
            if b == 45:
                m["pt45_stops"] = sum(1 for _, t in best.items() if t < bs)
                m["pt45_stations"] = sum(1 for _, t in rail.items() if t < bs)
            isos.append({"stadium": s["source_id"], "mode": "pt", "minutes": b, "pop": round(p),
                         "geom": mapping(to_wgs_t(gb))})
        if k % 25 == 0:
            print(f"[iso] {k}/{len(st)} {s['name']}: walk15 {m.get('reach_walk15')}, drive20 "
                  f"{m.get('reach_drive20')}, pt45 {m.get('reach_pt45')} ({time.time() - t_start:.0f}s)", flush=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"iso": isos, "metrics": metrics}))
    print(f"[iso] wrote {OUT} — {len(isos)} isochrones, {len(metrics)} stadia", flush=True)
    if os.environ.get("SUPABASE_SERVICE_KEY"):
        load(isos, metrics)
    return 0


def post(path, rows, prefer):
    key = os.environ["SUPABASE_SERVICE_KEY"]
    for i in range(0, len(rows), 200):
        req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}", method="POST",
                                     data=json.dumps(rows[i:i + 200]).encode(),
                                     headers={"apikey": key, "Authorization": "Bearer " + key,
                                              "Content-Type": "application/json", "Prefer": prefer})
        urllib.request.urlopen(req, timeout=300).read()


def load(isos, metrics):
    """Upsert the polygons (map_features 'stadium_iso') and the metric columns;
    then run derive_stadium_metrics() / classify_stadia() in SQL."""
    post("map_features?on_conflict=dataset,source_id", [
        {"dataset": "stadium_iso", "source_id": f"{r['stadium']}|{r['mode']}{r['minutes']}",
         "name": f"{r['mode']} {r['minutes']} min",
         "props": {k: r[k] for k in ("stadium", "mode", "minutes", "pop")},
         "geom": f"SRID=4326;{shape(r['geom']).wkt}"} for r in isos],
        "resolution=merge-duplicates,return=minimal")
    for m in metrics:
        m["dens_1500"] = round(m["pop_1500"] / (math.pi * 2.25))
    keys = sorted({k for m in metrics for k in m})
    post("stadium_metrics?on_conflict=source_id", [{k: m.get(k) for k in keys} for m in metrics],
         "resolution=merge-duplicates,return=minimal")
    print("[iso] loaded; now run select derive_stadium_metrics(); select classify_stadia();", flush=True)


if __name__ == "__main__":
    sys.exit(main())
