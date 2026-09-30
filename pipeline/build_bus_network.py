"""
build_bus_network.py
--------------------
The national bus network by service level, from the Bus Open Data Service
timetable (GTFS). Two outputs from one streaming pass:

1. data/raw/bus_network.geojsonl — tippecanoe input for bus_network.pmtiles:
     layer "bus_links"  one line per stop-to-stop link, both directions merged,
                        carrying `trips` = weekday bus journeys over the link.
                        Geometry follows the route shape (the road) where the
                        feed has one; otherwise a straight stop-to-stop line.
     layer "bus_stops"  every served stop: `trips` = weekday departures,
                        `bph` = average buses/hour 07:00-19:00, `routes`.
2. data/raw/bus_stop_freq.csv — the same per-stop figures keyed by ATCO code,
   merged into the `bus_stop` dataset by build_bus.py so the database layer,
   the connectivity scores and the popups all agree with the tiles.

"Usage" here is scheduled SERVICE, not passengers: no open dataset gives bus
boardings by stop across Great Britain. Timetabled frequency is the standard
proxy (it is what PTAL is built on) and is what a busy corridor looks like on a
map.

Sample day: the first Tuesday on or after today that falls inside the feed, so
the count is ONE real day. calendar.txt date ranges and calendar_dates.txt
exceptions are both honoured — BODS publishes overlapping timetable versions
(this term / next term) and counting every service that runs "on Tuesdays"
double-counts them. frequencies.txt trips are expanded to one journey per
headway.

Source: BODS GTFS, no key needed for the bulk download:
  BUS_GTFS_SRC (env) — defaults to the all-regions file (~1 GB). A regional
  file (…/gtfs-file/london/) works for a quicker test.
  Drop-in: data/raw/bus-gtfs.zip is used as-is if present.
  OPEN_ROADS_ZIP (env, default data/raw/oproad_gb.zip): when present, links
  with no route shape are routed along the road network (road_snap.py)
  instead of drawn straight.

Licence: Bus Open Data Service © DfT, OGL v3.

Run:  python pipeline/build_bus_network.py
"""

import csv
import datetime as dt
import io
import json
import math
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
GTFS_FILE = Path(os.environ.get("BUS_GTFS_FILE") or RAW / "bus-gtfs.zip")
DEFAULT_SRC = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/all/"
OUT_TILES = RAW / "bus_network.geojsonl"
OUT_FREQ = RAW / "bus_stop_freq.csv"
# OS Open Roads (Shapefile zip) for routing links the feed has no shape for;
# build_road_traffic.py downloads the same file.
ROADS_ZIP = Path(os.environ.get("OPEN_ROADS_ZIP") or RAW / "oproad_gb.zip")

SAMPLE_WEEKDAY = 1                   # Tuesday
DAY_START_H, DAY_END_H = 7, 19       # the buses/hour window
SNAP_M = 120                         # max stop-to-shape distance to trust a cut
MAX_ROUTES = 10

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch(url, dest):
    print(f"[bus] downloading {url.split('?')[0]} ...", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as fh:
        while True:
            chunk = r.read(1 << 22)
            if not chunk:
                break
            fh.write(chunk)
    print(f"[bus]   -> {dest.stat().st_size / 1e6:.0f} MB", flush=True)


def secs(t):
    """GTFS HH:MM:SS (hours may exceed 24) -> seconds, or None."""
    try:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except (ValueError, AttributeError):
        return None


def ymd(s):
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


class Gtfs:
    def __init__(self, path):
        self.zf = zipfile.ZipFile(path)
        self.member = {n.lower().rsplit("/", 1)[-1]: n for n in self.zf.namelist()}

    def has(self, name):
        return name in self.member

    def rows(self, name):
        """(header index, row iterator) — csv.reader, far faster than DictReader
        over a billion-byte stop_times."""
        fh = io.TextIOWrapper(self.zf.open(self.member[name]), "utf-8-sig",
                              errors="ignore", newline="")
        rd = csv.reader(fh)
        head = next(rd)
        return {k.strip(): i for i, k in enumerate(head)}, rd


def pick_date(g):
    """First Tuesday on/after today inside the feed's validity."""
    start = dt.date.today()
    end = None
    if g.has("feed_info.txt"):
        h, rd = g.rows("feed_info.txt")
        for r in rd:
            try:
                if "feed_start_date" in h and r[h["feed_start_date"]]:
                    start = max(start, ymd(r[h["feed_start_date"]]))
                if "feed_end_date" in h and r[h["feed_end_date"]]:
                    end = ymd(r[h["feed_end_date"]])
            except (ValueError, IndexError):
                pass
            break
    d = start + dt.timedelta(days=(SAMPLE_WEEKDAY - start.weekday()) % 7)
    if end and d > end:
        d -= dt.timedelta(days=7)
    return d


def active_services(g, day):
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday",
          "saturday", "sunday"][day.weekday()]
    ds = day.strftime("%Y%m%d")
    on = set()
    if g.has("calendar.txt"):
        h, rd = g.rows("calendar.txt")
        for r in rd:
            if (r[h[wd]] == "1" and r[h["start_date"]] <= ds <= r[h["end_date"]]):
                on.add(r[h["service_id"]])
    if g.has("calendar_dates.txt"):
        h, rd = g.rows("calendar_dates.txt")
        for r in rd:
            if r[h["date"]] != ds:
                continue
            if r[h["exception_type"]] == "1":
                on.add(r[h["service_id"]])
            elif r[h["exception_type"]] == "2":
                on.discard(r[h["service_id"]])
    return on


def load_shapes(g):
    """shape_id -> [(lon, lat), ...] in sequence order."""
    if not g.has("shapes.txt"):
        return {}
    h, rd = g.rows("shapes.txt")
    iid, ila, ilo, isq = (h["shape_id"], h["shape_pt_lat"], h["shape_pt_lon"],
                          h["shape_pt_sequence"])
    tmp = {}
    for r in rd:
        try:
            tmp.setdefault(r[iid], []).append(
                (int(r[isq]), round(float(r[ilo]), 5), round(float(r[ila]), 5)))
        except ValueError:
            continue
    out = {}
    for k, pts in tmp.items():
        pts.sort()
        out[k] = [(x, y) for _, x, y in pts]
    return out


def _d2(a, b, kx):
    dx = (a[0] - b[0]) * kx
    dy = (a[1] - b[1]) * 111320.0
    return dx * dx + dy * dy


def cut_pattern(shape, stop_xy):
    """Vertex index on `shape` for each stop, walking forward so a looping route
    is cut in order. None where a stop is too far from the shape to trust."""
    n = len(shape)
    kx = 111320.0 * math.cos(math.radians(shape[0][1]))
    idx, cur = [], 0
    lim = SNAP_M * SNAP_M
    for p in stop_xy:
        best, bd = None, 1e18
        # forward window: far enough for a long rural gap, short enough that a
        # route returning past the same stop later is not picked early
        for j in range(cur, min(n, cur + 1500)):
            d = _d2(shape[j], p, kx)
            if d < bd:
                bd, best = d, j
        if best is None or bd > lim:
            idx.append(None)
            continue
        idx.append(best)
        cur = best
    return idx


def main():
    if not GTFS_FILE.exists() or GTFS_FILE.stat().st_size < 1e6:
        fetch(os.environ.get("BUS_GTFS_SRC", "").strip() or DEFAULT_SRC, GTFS_FILE)
    g = Gtfs(GTFS_FILE)
    day = pick_date(g)
    services = active_services(g, day)
    print(f"[bus] sample day {day} · {len(services):,} active services", flush=True)

    # stops
    h, rd = g.rows("stops.txt")
    stop_xy, stop_name = {}, {}
    for r in rd:
        try:
            sid = r[h["stop_id"]]
            stop_xy[sid] = (round(float(r[h["stop_lon"]]), 5),
                            round(float(r[h["stop_lat"]]), 5))
            stop_name[sid] = r[h["stop_name"]][:80]
        except (ValueError, KeyError):
            continue

    # routes
    h, rd = g.rows("routes.txt")
    route_name = {}
    n_other = 0
    for r in rd:
        # buses only: BODS also carries trams, metro, rail replacement
        # rail, river boats (route_type 4 — they drew straight down the Thames)
        # and National Express coaches (200: intercity hops, not local service)
        rt = r[h["route_type"]] if "route_type" in h else "3"
        if not (rt == "3" or rt.startswith("7") and len(rt) == 3):
            n_other += 1
            continue
        nm = (r[h["route_short_name"]] if "route_short_name" in h else "") \
            or (r[h["route_long_name"]] if "route_long_name" in h else "")
        route_name[r[h["route_id"]]] = nm.strip()[:12]
    print(f"[bus] {len(route_name):,} bus routes ({n_other:,} coach/rail/tram/ferry "
          f"routes left out)", flush=True)

    # trips on the sample day
    h, rd = g.rows("trips.txt")
    ish = h.get("shape_id")
    trips = {}
    for r in rd:
        if r[h["service_id"]] in services and r[h["route_id"]] in route_name:
            trips[r[h["trip_id"]]] = (route_name[r[h["route_id"]]],
                                      r[ish] if ish is not None else "")
    print(f"[bus] {len(trips):,} trips run that day", flush=True)

    # frequency-based trips: one journey per headway
    dispatch = {}
    if g.has("frequencies.txt"):
        h, rd = g.rows("frequencies.txt")
        for r in rd:
            t = r[h["trip_id"]]
            if t not in trips:
                continue
            a, b, hw = secs(r[h["start_time"]]), secs(r[h["end_time"]]), \
                int(r[h["headway_secs"]] or 0)
            if a is None or b is None or hw <= 0:
                continue
            dispatch.setdefault(t, []).extend(range(a, b, hw))
    print(f"[bus] {len(dispatch):,} frequency-based trips expanded", flush=True)

    shapes = load_shapes(g)
    print(f"[bus] {len(shapes):,} route shapes", flush=True)

    stop_trips, stop_day, stop_routes = {}, {}, {}
    link_trips, link_routes, link_geom = {}, {}, {}
    seen_pattern = set()

    def flush(tid, calls):
        info = trips.get(tid)
        if info is None or len(calls) < 1:
            return
        rname, shape_id = info
        calls.sort()
        seq = [(sid, t) for _, sid, t in calls]
        t0 = next((t for _, t in seq if t is not None), None)
        starts = dispatch.get(tid)
        offsets = [0] if not starts or t0 is None else [s - t0 for s in starts]
        mult = len(offsets)
        for sid, t in seq:
            stop_trips[sid] = stop_trips.get(sid, 0) + mult
            if t is not None:
                n_day = sum(1 for o in offsets
                            if DAY_START_H <= ((t + o) // 3600) % 24 < DAY_END_H)
                if n_day:
                    stop_day[sid] = stop_day.get(sid, 0) + n_day
            if rname:
                rs = stop_routes.setdefault(sid, set())
                if len(rs) < MAX_ROUTES:
                    rs.add(rname)
        for i in range(len(seq) - 1):
            a, b = seq[i][0], seq[i + 1][0]
            if a == b:
                continue
            key = (a, b) if a < b else (b, a)
            link_trips[key] = link_trips.get(key, 0) + mult
            if rname:
                rs = link_routes.setdefault(key, set())
                if len(rs) < MAX_ROUTES:
                    rs.add(rname)
        # road-following geometry, once per (shape, stop pattern)
        shape = shapes.get(shape_id) if shape_id else None
        stops_only = tuple(s for s, _ in seq)
        if shape and len(shape) > 1:
            pk = (shape_id, stops_only)
            if pk in seen_pattern:
                return
            seen_pattern.add(pk)
            xy = [stop_xy.get(s) for s in stops_only]
            if any(p is None for p in xy):
                return
            cut = cut_pattern(shape, xy)
            for i in range(len(stops_only) - 1):
                a, b = stops_only[i], stops_only[i + 1]
                if a == b:
                    continue
                key = (a, b) if a < b else (b, a)
                if key in link_geom:
                    continue
                ia, ib = cut[i], cut[i + 1]
                if ia is None or ib is None or ib <= ia:
                    continue
                line = [xy[i]] + shape[ia + 1:ib] + [xy[i + 1]]
                if a > b:
                    line.reverse()
                link_geom[key] = line

    h, rd = g.rows("stop_times.txt")
    it, isd, isq, idp, iar = (h["trip_id"], h["stop_id"], h["stop_sequence"],
                              h["departure_time"], h["arrival_time"])
    cur, calls, n = None, [], 0
    for r in rd:
        n += 1
        if n % 20_000_000 == 0:
            print(f"[bus]   {n:,} stop_times", flush=True)
        tid = r[it]
        if tid != cur:
            if cur is not None:
                flush(cur, calls)
            cur, calls = tid, []
        if tid not in trips:
            continue
        try:
            sq = int(r[isq])
        except ValueError:
            continue
        calls.append((sq, r[isd], secs(r[idp] or r[iar])))
    if cur is not None:
        flush(cur, calls)
    print(f"[bus] {n:,} stop_times read · {len(stop_trips):,} served stops · "
          f"{len(link_trips):,} links ({len(link_geom):,} road-following)",
          flush=True)

    # --- outputs ------------------------------------------------------------
    RAW.mkdir(parents=True, exist_ok=True)
    with OUT_FREQ.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["atco", "trips_day", "buses_hr", "routes"])
        for sid, n_all in stop_trips.items():
            w.writerow([sid, n_all,
                        round(stop_day.get(sid, 0) / (DAY_END_H - DAY_START_H), 1),
                        ", ".join(sorted(stop_routes.get(sid, ())))])

    # links the feed gave no shape for: route them along OS Open Roads
    if ROADS_ZIP.exists():
        from road_snap import RoadSnapper
        todo = {}
        for key in link_trips:
            if key in link_geom:
                continue
            a, b = stop_xy.get(key[0]), stop_xy.get(key[1])
            if a is None or b is None or a == b:
                continue
            kx = 111320.0 * math.cos(math.radians(a[1]))
            if _d2(a, b, kx) <= 3000 ** 2:
                todo[key] = (a, b)
        print(f"[bus] routing {len(todo):,} unshaped links on OS Open Roads", flush=True)
        link_geom.update(RoadSnapper(ROADS_ZIP).snap(todo, log=lambda m: print(m, flush=True)))
    else:
        print(f"[bus] no {ROADS_ZIP.name} — unshaped links stay straight", flush=True)

    def link_minzoom(n):
        # busy corridors show from the regional view, the long tail close in
        return 6 if n >= 400 else 8 if n >= 150 else 9 if n >= 60 else 10 if n >= 20 else 11

    def stop_minzoom(n):
        return 9 if n >= 400 else 11 if n >= 100 else 12 if n >= 20 else 13

    n_links = n_stops = 0
    with OUT_TILES.open("w", encoding="utf-8") as fh:
        for key, n_t in link_trips.items():
            line = link_geom.get(key)
            if line is None:
                a, b = stop_xy.get(key[0]), stop_xy.get(key[1])
                if a is None or b is None or a == b:
                    continue
                # a straight link over ~3 km is a coach/express hop between
                # distant stops, not a street — drawing it would cut across
                # the map
                kx = 111320.0 * math.cos(math.radians(a[1]))
                if _d2(a, b, kx) > 3000 ** 2:
                    continue
                line = [a, b]
            rs = sorted(link_routes.get(key, ()))
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "bus_links"},
                "properties": {"mz": link_minzoom(n_t), "trips": n_t,
                               **({"routes": ", ".join(rs)} if rs else {})},
                "geometry": {"type": "LineString", "coordinates": line},
            }, separators=(",", ":")) + "\n")
            n_links += 1
        for sid, n_all in stop_trips.items():
            p = stop_xy.get(sid)
            if p is None:
                continue
            rs = sorted(stop_routes.get(sid, ()))
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "bus_stops"},
                "properties": {"mz": stop_minzoom(n_all), 
                    "name": stop_name.get(sid, ""), "atco": sid, "trips": n_all,
                    "bph": round(stop_day.get(sid, 0) / (DAY_END_H - DAY_START_H), 1),
                    **({"routes": ", ".join(rs)} if rs else {})},
                "geometry": {"type": "Point", "coordinates": list(p)},
            }, separators=(",", ":")) + "\n")
            n_stops += 1
    print(f"[bus] wrote {OUT_TILES.name}: {n_links:,} links + {n_stops:,} stops "
          f"({OUT_TILES.stat().st_size / 1e6:.0f} MB); {OUT_FREQ.name}", flush=True)

    busiest = sorted(link_trips.items(), key=lambda kv: -kv[1])[:5]
    for (a, b), n_t in busiest:
        print(f"[bus]   {n_t:>5} trips  {stop_name.get(a, a)} — {stop_name.get(b, b)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
