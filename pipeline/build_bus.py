"""
build_bus.py
------------
The national bus network for the connectivity tools, in two tiers:

1. `bus_stop` — every active bus stop in England/Scotland/Wales from NaPTAN
   (DfT, OGL, no key needed). If a GTFS timetable is supplied (tier 2), each
   stop also carries weekday daytime frequency (buses/hour, 07:00-19:00) and
   the route numbers serving it — the raw material for frequency-weighted
   catchments and a PTAL-style national access measure.
2. GTFS timetable (optional but the whole point): the DfT Bus Open Data
   Service publishes the complete national timetable as GTFS. BODS needs a
   free account, so the file arrives one of two ways:
     - env/repo variable BUS_GTFS_SRC = a download URL (BODS "all regions"
       GTFS link with ?api_key=... appended), or
     - drop-in file data/raw/bus-gtfs.zip.
   Without it, stops still load — with location/locality only.

Frequency model: departures on a service running on a typical Tuesday
(calendar.txt; calendar_dates.txt exceptions ignored) between 07:00 and
19:00, divided by 12 hours. Cheap, robust, and comparable across the country.

Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
— loaded by supabase/loaders/load_datasets.py with DATASETS=bus_stop.

Licences: NaPTAN and BODS timetable data are OGL v3 (© DfT / Crown).
"""

import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

NAPTAN_URL = "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv"
GTFS_FILE = RAW / "bus-gtfs.zip"

# On-street bus stops + bus-station bays. Everything else in NaPTAN (rail
# platforms, taxi ranks, airports...) is out of scope here.
BUS_STOP_TYPES = {"BCT", "BCS", "BCQ", "BST", "BCE"}

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch(url, dest):
    print(f"[bus] downloading {url.split('?')[0]} ...")
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as fh:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    print(f"[bus]   -> {dest.stat().st_size/1e6:.1f} MB")


def load_naptan():
    """ATCOCode -> (name, locality, stop_type, lon, lat) for active bus stops."""
    dest = RAW / "naptan.csv"
    if not dest.exists() or dest.stat().st_size < 1e6:
        fetch(NAPTAN_URL, dest)
    stops = {}
    with open(dest, newline="", encoding="utf-8-sig", errors="ignore") as fh:
        rd = csv.DictReader(fh)
        for row in rd:
            if (row.get("Status") or "").lower() not in ("active", ""):
                continue
            if (row.get("StopType") or "") not in BUS_STOP_TYPES:
                continue
            try:
                lon, lat = float(row["Longitude"]), float(row["Latitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (-9 < lon < 3 and 49 < lat < 61.5):
                continue
            atco = (row.get("ATCOCode") or "").strip()
            if not atco:
                continue
            stops[atco] = ((row.get("CommonName") or "").strip()[:80],
                           (row.get("LocalityName") or "").strip()[:60],
                           row.get("StopType") or "", lon, lat)
    print(f"[bus] NaPTAN: {len(stops):,} active bus stops")
    return stops


def _hhmm_ok(t):
    """True if a GTFS departure_time HH:MM:SS falls in 07:00-18:59."""
    try:
        return 7 <= int(t[:t.index(":")]) < 19
    except (ValueError, IndexError):
        return False


def load_gtfs_frequencies():
    """stop_id -> (weekday daytime departures, set of route short names).
    Returns None when no GTFS source is configured."""
    src = os.environ.get("BUS_GTFS_SRC", "").strip()
    if src and (not GTFS_FILE.exists() or GTFS_FILE.stat().st_size < 1e6):
        fetch(src, GTFS_FILE)
    if not GTFS_FILE.exists():
        print("[bus] no GTFS timetable (set BUS_GTFS_SRC or drop in "
              "data/raw/bus-gtfs.zip) — stops load without frequencies")
        return None

    zf = zipfile.ZipFile(GTFS_FILE)
    member = {n.lower().rsplit("/", 1)[-1]: n for n in zf.namelist()}

    def rows(name):
        with zf.open(member[name]) as fh:
            yield from csv.DictReader(
                io.TextIOWrapper(fh, "utf-8-sig", errors="ignore"))

    tuesday_services = set()
    for r in rows("calendar.txt"):
        if r.get("tuesday") == "1":
            tuesday_services.add(r["service_id"])
    print(f"[bus] GTFS: {len(tuesday_services):,} weekday services")

    route_name = {}
    for r in rows("routes.txt"):
        route_name[r["route_id"]] = (r.get("route_short_name")
                                     or r.get("route_long_name") or "")[:12]

    trip_ok = {}
    for r in rows("trips.txt"):
        if r["service_id"] in tuesday_services:
            trip_ok[r["trip_id"]] = r["route_id"]
    print(f"[bus] GTFS: {len(trip_ok):,} weekday trips")

    deps, routes = {}, {}
    n = 0
    for r in rows("stop_times.txt"):
        n += 1
        rid = trip_ok.get(r["trip_id"])
        if rid is None or not _hhmm_ok(r.get("departure_time") or ""):
            continue
        sid = r["stop_id"]
        deps[sid] = deps.get(sid, 0) + 1
        rs = routes.setdefault(sid, set())
        if len(rs) < 8:
            rs.add(route_name.get(rid, ""))
    print(f"[bus] GTFS: {n:,} stop_times scanned, {len(deps):,} stops with "
          f"weekday daytime departures")
    return deps, routes


def main():
    stops = load_naptan()
    freq = load_gtfs_frequencies()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for atco, (name, locality, stype, lon, lat) in stops.items():
            props = {"locality": locality or None, "stop_type": stype}
            if freq:
                deps, routes = freq
                d = deps.get(atco, 0)
                props["buses_hr"] = round(d / 12.0, 1)
                rt = sorted(x for x in routes.get(atco, ()) if x)
                if rt:
                    props["routes"] = ", ".join(rt)
            props = {k: v for k, v in props.items() if v not in (None, "")}
            w.writerow({
                "dataset": "bus_stop",
                "source_id": atco,
                "name": name or "Bus stop",
                "props": json.dumps(props, separators=(",", ":"),
                                    ensure_ascii=False),
                "geom_wkt": f"SRID=4326;POINT({lon:.6f} {lat:.6f})",
            })
            written += 1
    print(f"[bus] wrote {written:,} bus_stop rows to {OUT} "
          f"({OUT.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
