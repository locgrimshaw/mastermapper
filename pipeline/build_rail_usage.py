"""
build_rail_usage.py
-------------------
The passenger rail network by service level: every section of track coloured
by the trains timetabled over it on a normal weekday. Output is tippecanoe
input for rail_usage.pmtiles, layer "rail_links":
    trains  passenger trains per weekday over the section, both directions
    tph     average trains/hour 07:00-19:00, both directions
    from/to the busiest station pair whose trains use the section (popup)

Why not station_links (build_connectivity_cif.py): that table is every pair a
train calls at, for journey planning. Line loading needs the consecutive
pairs, including stations a fast train passes WITHOUT stopping — otherwise a
four-track main line looks as quiet as its stopping service.

1. Timetable (National Rail DTD/CIF, data/raw/rail_timetable.zip — see
   load-rail-links.yml for the download). For a sample Tuesday:
     - passenger schedules only (train status P / 1; buses, ships and freight
       out),
     - ONE schedule per train UID by CIF precedence: a cancellation (C) beats a
       new STP schedule (N), which beats an overlay (O), which beats the
       permanent timetable (P). Counting every schedule "valid on Tuesday"
       double-counts every overlaid train.
     - every location on the schedule that is a station (TIPLOC with a CRS in
       the MSN), whether the train calls or passes.
   Each consecutive station pair on a schedule counts one train.
2. Track: OSM railway=rail (GB) — data/raw/osm_rail.geojson from the
   workflow's osmium extract, falling back to web/data/rail.geojson
   (England). Sidings and yards are dropped. The track is turned into a graph,
   plain track between junctions collapsed into single edges (station points
   kept as nodes), which is what makes routing thousands of pairs fast.
3. Each station pair is routed along the track (Dijkstra, detour-bounded) and
   its trains added to every edge on the way. Edges no passenger train uses
   are left out.

RAIL_PAIRS_CSV (env) skips step 1 with a ready-made crs_a,crs_b,trains,day
file — for testing the routing without timetable credentials.

Licences: timetable © Rail Delivery Group (open data licence); track ©
OpenStreetMap contributors (ODbL); station list ODbL (see build_rail_layer.py).

Run:  python pipeline/build_rail_usage.py
"""

import csv
import datetime as dt
import heapq
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_connectivity_cif import (ensure_extracted, load_crosswalk,  # noqa: E402
                                    parse_yymmdd, pick_sample_date,
                                    runs_on_sample_day)

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = RAW / "rail_usage.geojsonl"
OUT_PAIRS = RAW / "rail_pairs.csv"
TRACK_SRCS = [RAW / "osm_rail.geojson", ROOT / "web" / "data" / "rail.geojson"]
STATIONS_CSV = RAW / "uk_stations.csv"

PASSENGER = {"P", "1"}
STP_RANK = {"C": 3, "N": 2, "O": 1, "P": 0}
DAY_START, DAY_END = 700, 1900
SNAP_M = 400                       # station point to track
DROP_SERVICE = {"yard", "siding"}


# ---- 1. timetable -> consecutive station pairs -------------------------------

def _hhmm(s):
    s = (s or "").strip()[:4]
    return int(s) if len(s) == 4 and s.isdigit() else None


def parse_pairs():
    found = ensure_extracted()
    if not found:
        print("[rail] no timetable under data/raw (rail_timetable.zip) — nothing to do")
        return None, {}
    msn, mca = found
    tip_crs, crs_name, _xy = load_crosswalk(msn)
    day = pick_sample_date(dt.date.today())
    print(f"[rail] sample day {day}", flush=True)

    best = {}            # uid -> (rank, [(crs, hhmm)])
    uid = rank = None
    keep = False
    locs = []

    def done():
        if uid is None or not keep:
            return
        prev = best.get(uid)
        if prev is None or rank > prev[0]:
            best[uid] = (rank, locs)

    n = 0
    with mca.open(encoding="latin-1") as fh:
        for line in fh:
            rt = line[:2]
            if rt == "BS":
                done()
                n += 1
                uid, stp = line[3:9], line[79:80]
                rank = STP_RANK.get(stp, 0)
                keep = runs_on_sample_day(line[21:28], parse_yymmdd(line[9:15]),
                                          parse_yymmdd(line[15:21]), day)
                # a cancellation carries no status; anything else must be passenger
                if keep and stp != "C" and line[29:30] not in PASSENGER:
                    keep = False
                locs = []
            elif not keep:
                continue
            elif rt in ("LO", "LI", "LT"):
                crs = tip_crs.get(line[2:9].strip())
                if not crs:
                    continue
                if rt == "LO":
                    t = _hhmm(line[10:14])
                elif rt == "LT":
                    t = _hhmm(line[10:14])
                else:   # pass time, else departure, else arrival
                    t = _hhmm(line[20:24]) or _hhmm(line[15:19]) or _hhmm(line[10:14])
                if locs and locs[-1][0] == crs:
                    continue
                locs.append((crs, t))
        done()

    pairs = {}
    n_trains = 0
    for rk, seq in best.values():
        if rk == STP_RANK["C"] or len(seq) < 2:
            continue
        n_trains += 1
        for (a, ta), (b, _tb) in zip(seq, seq[1:]):
            key = (a, b) if a < b else (b, a)
            p = pairs.setdefault(key, [0, 0])
            p[0] += 1
            if ta is not None and DAY_START <= ta < DAY_END:
                p[1] += 1
    print(f"[rail] {n:,} schedules, {n_trains:,} passenger trains that day, "
          f"{len(pairs):,} consecutive station pairs", flush=True)
    with OUT_PAIRS.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["crs_a", "crs_b", "trains", "day"])
        for (a, b), (t, d) in sorted(pairs.items()):
            w.writerow([a, b, t, d])
    return pairs, crs_name


def read_pairs(path):
    pairs = {}
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            a, b = r["crs_a"], r["crs_b"]
            key = (a, b) if a < b else (b, a)
            p = pairs.setdefault(key, [0, 0])
            p[0] += int(r["trains"])
            p[1] += int(r.get("day") or 0)
    return pairs


# ---- 2. track graph -----------------------------------------------------------

def load_stations():
    st = {}
    with STATIONS_CSV.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            try:
                st[r["crsCode"].strip()] = (float(r["long"]), float(r["lat"]), r["stationName"])
            except (ValueError, KeyError):
                continue
    return st


def load_track():
    src = next((p for p in TRACK_SRCS if p.exists()), None)
    if src is None:
        raise SystemExit("[rail] no track geometry (data/raw/osm_rail.geojson or web/data/rail.geojson)")
    g = json.loads(src.read_text())
    lines = []
    for f in g["features"]:
        p = f.get("properties") or {}
        if p.get("kind") == "stop" or p.get("mode") not in (None, "rail"):
            continue
        if p.get("railway") not in (None, "rail") or p.get("service") in DROP_SERVICE:
            continue
        geom = f.get("geometry") or {}
        if geom.get("type") == "LineString":
            lines.append(geom["coordinates"])
        elif geom.get("type") == "MultiLineString":
            lines.extend(geom["coordinates"])
    print(f"[rail] track: {len(lines):,} lines from {src.name}", flush=True)
    return lines


def build_graph(lines, station_pts):
    """Vertex graph -> contracted graph. Returns (nodes xy, edges, adj,
    station->node)."""
    key = lambda p: (round(p[0], 6), round(p[1], 6))
    vid, vxy = {}, []
    nbr = []
    for ln in lines:
        prev = None
        for p in ln:
            k = key(p)
            i = vid.get(k)
            if i is None:
                i = vid[k] = len(vxy)
                vxy.append(k)
                nbr.append(set())
            if prev is not None and prev != i:
                nbr[i].add(prev)
                nbr[prev].add(i)
            prev = i
    V = np.array(vxy)
    kx = 111320.0 * math.cos(math.radians(53.5))

    # snap stations to the nearest track vertex (grid lookup)
    cell = 0.01
    grid = {}
    for i, (x, y) in enumerate(vxy):
        grid.setdefault((int(x // cell), int(y // cell)), []).append(i)
    st_node = {}
    for crs, (x, y, _n) in station_pts.items():
        cx, cy = int(x // cell), int(y // cell)
        best, bd = None, SNAP_M ** 2
        for a in range(cx - 1, cx + 2):
            for b in range(cy - 1, cy + 2):
                for i in grid.get((a, b), ()):
                    d = ((V[i, 0] - x) * kx) ** 2 + ((V[i, 1] - y) * 111320.0) ** 2
                    if d < bd:
                        bd, best = d, i
        if best is not None:
            st_node[crs] = best

    # contract: keep junctions, ends and station vertices as nodes
    keepv = {i for i in range(len(vxy)) if len(nbr[i]) != 2} | set(st_node.values())
    edges = []                    # [coords list, length m]
    adj = {i: [] for i in keepv}
    seen = set()
    for s in keepv:
        for n0 in nbr[s]:
            if (s, n0) in seen:
                continue
            chain = [s, n0]
            prev, cur = s, n0
            while cur not in keepv:
                nxt = next(iter(nbr[cur] - {prev}), None)
                if nxt is None:
                    break
                prev, cur = cur, nxt
                chain.append(cur)
            if cur not in keepv:
                continue
            seen.add((s, chain[1]))
            seen.add((cur, chain[-2]))
            pts = V[chain]
            ln = float(np.sum(np.hypot(np.diff(pts[:, 0]) * kx, np.diff(pts[:, 1]) * 111320.0)))
            e = len(edges)
            edges.append((chain, ln))
            adj[s].append((cur, ln, e))
            adj[cur].append((s, ln, e))
    print(f"[rail] graph: {len(vxy):,} vertices -> {len(keepv):,} nodes, "
          f"{len(edges):,} edges; {len(st_node):,}/{len(station_pts):,} stations on track",
          flush=True)
    return V, edges, adj, st_node


def route(adj, a, b, limit):
    dist, prev = {a: 0.0}, {}
    heap = [(0.0, a)]
    while heap:
        c, n = heapq.heappop(heap)
        if n == b:
            break
        if c > dist.get(n, 1e18) or c > limit:
            continue
        for m, ln, e in adj[n]:
            nc = c + ln
            if nc < dist.get(m, 1e18) and nc <= limit:
                dist[m] = nc
                prev[m] = (n, e)
                heapq.heappush(heap, (nc, m))
    if b not in prev:
        return None
    path, n = [], b
    while n != a:
        n, e = prev[n]
        path.append(e)
    return path


# ---- 3. route pairs, write tiles input ---------------------------------------

def main():
    src = os.environ.get("RAIL_PAIRS_CSV")
    if src:
        pairs, names = read_pairs(src), {}
    else:
        pairs, names = parse_pairs()
        if pairs is None:
            return 0
    stations = load_stations()
    for crs, (_x, _y, nm) in stations.items():
        names.setdefault(crs, nm)
    V, edges, adj, st_node = build_graph(load_track(), stations)
    kx = 111320.0 * math.cos(math.radians(53.5))

    load = np.zeros(len(edges))
    day = np.zeros(len(edges))
    top = {}                       # edge -> (trains, a, b) busiest pair using it
    ok = miss = 0
    for (a, b), (t, d) in sorted(pairs.items(), key=lambda kv: -kv[1][0]):
        na, nb = st_node.get(a), st_node.get(b)
        if na is None or nb is None or na == nb:
            miss += 1
            continue
        straight = math.hypot((V[na, 0] - V[nb, 0]) * kx, (V[na, 1] - V[nb, 1]) * 111320.0)
        path = route(adj, na, nb, max(1.6 * straight, straight + 3000))
        if not path:
            miss += 1
            continue
        ok += 1
        for e in path:
            load[e] += t
            day[e] += d
            if e not in top:
                top[e] = (t, a, b)
    print(f"[rail] routed {ok:,} station pairs on track, {miss:,} not routable "
          f"(station off the track data or no path)", flush=True)

    n = 0
    with OUT.open("w", encoding="utf-8") as fh:
        for e, (chain, _ln) in enumerate(edges):
            if load[e] <= 0:
                continue
            t = int(load[e])
            coords = [[round(float(V[i, 0]), 5), round(float(V[i, 1]), 5)] for i in chain]
            _tt, a, b = top.get(e, (0, "", ""))
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "rail_links"},
                "properties": {"mz": 4 if t >= 100 else 6 if t >= 30 else 8,
                               "trains": t, "tph": round(day[e] / 12.0, 1),
                               "from": names.get(a, a), "to": names.get(b, b)},
                "geometry": {"type": "LineString", "coordinates": coords},
            }, separators=(",", ":")) + "\n")
            n += 1
    print(f"[rail] wrote {OUT.name}: {n:,} track sections "
          f"({OUT.stat().st_size / 1e6:.0f} MB)", flush=True)
    busiest = np.argsort(-load)[:5]
    for e in busiest:
        _t, a, b = top.get(int(e), (0, "", ""))
        print(f"[rail]   {int(load[e]):>5} trains/day  near {names.get(a, a)} – {names.get(b, b)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
