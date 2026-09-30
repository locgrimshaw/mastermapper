"""
build_road_traffic.py
---------------------
Road network by traffic volume: DfT annual average daily flow (AADF) drawn on
OS Open Roads geometry, plus the busiest junctions. Output is tippecanoe input
for road_traffic.pmtiles with three layers:

  roads      road links carrying `aadf` (all motor vehicles/day, both
             directions), `hgv` (% heavy goods), `road`, `year`, `est`
  junctions  nodes where two or more counted roads meet, `aadf` = vehicles
             passing through/day (sum of the incident links' flows / 2)
  counts     the DfT count points themselves, for the popup detail

Method
  Major roads (motorways and A roads) are counted or estimated EVERY year on
  every junction-to-junction link, one count point per link. OS Open Roads
  carries the same road numbers, so each OS link takes the flow of the nearest
  count point on the SAME road number (M25 links only ever take M25 counts).
  Nearest-point assignment splits a road halfway between count points, which
  lands near the junctions that bound the DfT links; the error is at most half
  a link, and flows change at junctions anyway. B roads use the same rule with
  a tighter reach because they are sampled rather than fully counted.
  Slip roads carry the mainline's road number but not its flow, and DfT does
  not count them, so they are left out rather than painted with the mainline's
  figure.
  Minor roads (C and unclassified) are only ever sampled at a point, so a count
  lights up just the OS link it sits on, not the whole street network.

  Each count point contributes its latest year: 2025 for nearly every major
  road link, older for minor-road samples (the `year` prop says which).

Sources (both OGL v3, no key):
  DfT road traffic AADF by count point — storage.googleapis.com/dft-statistics
  OS Open Roads (Shapefile, GB) — api.os.uk downloads
Env overrides: AADF_ZIP, OPEN_ROADS_ZIP (local files), ROAD_TILES (comma list
of OS 100 km squares, e.g. "TQ,TL" for a quick London test).

Run:  python pipeline/build_road_traffic.py
"""

import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyogrio
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
AADF_URL = ("https://storage.googleapis.com/dft-statistics/road-traffic/"
            "downloads/data-gov-uk/dft_traffic_counts_aadf.zip")
ROADS_URL = ("https://api.os.uk/downloads/v1/products/OpenRoads/downloads"
             "?area=GB&format=ESRI%C2%AE+Shapefile&redirect")
AADF_ZIP = Path(os.environ.get("AADF_ZIP") or RAW / "dft_aadf.zip")
ROADS_ZIP = Path(os.environ.get("OPEN_ROADS_ZIP") or RAW / "oproad_gb.zip")
OUT = RAW / "road_traffic.geojsonl"

MAJOR_CATS = {"TM", "PM", "TA", "PA"}      # trunk/principal motorway & A road
REACH = {"M": 4000, "A": 3000, "B": 1500}  # max link-to-count-point distance
MINOR_SNAP = 25                            # metres, minor-road point to link
KEEP_CLASSES = ("Motorway", "A Road", "B Road")

TO_WGS = Transformer.from_crs(27700, 4326, always_xy=True)


def fetch(url, dest):
    print(f"[roads] downloading {url.split('?')[0]} ...", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "MasterMapper/1.0"})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as fh:
        while True:
            b = r.read(1 << 22)
            if not b:
                break
            fh.write(b)
    print(f"[roads]   -> {dest.stat().st_size / 1e6:.0f} MB", flush=True)


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):     # 'NA' on minor-road sample points
        return 0.0


def load_counts():
    """Latest year per count point."""
    if not AADF_ZIP.exists():
        fetch(AADF_URL, AADF_ZIP)
    zf = zipfile.ZipFile(AADF_ZIP)
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    latest = {}
    with zf.open(name) as fh:
        for r in csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")):
            cp, y = r["count_point_id"], int(r["year"])
            if cp not in latest or y > latest[cp]["year"]:
                try:
                    amv = int(float(r["all_motor_vehicles"] or 0))
                    hgv = int(float(r["all_HGVs"] or 0))
                    e, n = float(r["easting"]), float(r["northing"])
                except ValueError:
                    continue
                latest[cp] = {
                    "id": cp, "year": y, "road": (r["road_name"] or "").strip(),
                    "cat": r["road_category"], "e": e, "n": n, "aadf": amv,
                    "hgv": round(100.0 * hgv / amv, 1) if amv else 0.0,
                    "est": "C" if r["estimation_method"] == "Counted" else "E",
                    "from": (r["start_junction_road_name"] or "").strip(),
                    "to": (r["end_junction_road_name"] or "").strip(),
                    "la": (r["local_authority_name"] or "").strip(),
                    "len": _num(r["link_length_km"]),
                }
    pts = [p for p in latest.values() if p["aadf"] > 0]
    print(f"[roads] {len(pts):,} count points "
          f"({sum(p['cat'] in MAJOR_CATS for p in pts):,} major-road links)", flush=True)
    return pts


def ensure_roads():
    if not ROADS_ZIP.exists():
        fetch(ROADS_URL, ROADS_ZIP)
    zf = zipfile.ZipFile(ROADS_ZIP)
    tiles = sorted({n.rsplit("/", 1)[-1][:2] for n in zf.namelist()
                    if n.endswith("_RoadLink.shp")})
    only = [t.strip().upper() for t in os.environ.get("ROAD_TILES", "").split(",") if t.strip()]
    if only:
        tiles = [t for t in tiles if t in only]
    return zf, tiles


def read_tile(zf, tile, where=None):
    prefix = next(n.rsplit("/", 1)[0] for n in zf.namelist()
                  if n.endswith(f"{tile}_RoadLink.shp"))
    path = f"/vsizip/{ROADS_ZIP}/{prefix}/{tile}_RoadLink.shp"
    return pyogrio.read_dataframe(
        path, columns=["class", "roadNumber", "name1", "formOfWay",
                       "startNode", "endNode"], where=where)


def coords_wgs(geom):
    xy = np.asarray(geom.coords)[:, :2]
    lon, lat = TO_WGS.transform(xy[:, 0], xy[:, 1])
    out, last = [], None
    for x, y in zip(lon, lat):
        p = (round(float(x), 5), round(float(y), 5))
        if p != last:
            out.append(p)
            last = p
    return out


def main():
    pts = load_counts()
    by_road = {}
    for p in pts:
        if p["road"] and p["road"][0] in "MAB" and p["road"][1:2].isdigit():
            by_road.setdefault(p["road"], []).append(p)
    # DfT also numbers the short links INSIDE a junction (slip-to-roundabout,
    # 0.1-0.3 km) with the mainline's road number, at a fraction of its flow —
    # M25 J26 has three at ~6-10k beside a ~150k mainline. Left in, they would
    # capture the mainline links next to them. Stale points (a link last
    # counted years ago, since superseded) go the same way. Both stay in the
    # count-points layer; a road with nothing else keeps them.
    newest = max(p["year"] for p in pts)
    for k, v in list(by_road.items()):
        main = [p for p in v if p["cat"] not in MAJOR_CATS
                or (p["len"] >= 0.5 and p["year"] >= newest - 3)]
        by_road[k] = main or v
    arr = {k: (np.array([[q["e"], q["n"]] for q in v]), v) for k, v in by_road.items()}
    minor = [p for p in pts if p["cat"] not in MAJOR_CATS
             and not (p["road"][:1] == "B" and p["road"][1:2].isdigit())]

    zf, tiles = ensure_roads()
    print(f"[roads] {len(tiles)} OS 100 km tiles", flush=True)
    node_xy, node_links = {}, {}
    n_major = n_minor = 0
    used_minor = set()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fh:
        def emit(geom, cp, cls, extra_min=None):
            line = coords_wgs(geom)
            if len(line) < 2:
                return
            mz = extra_min if extra_min is not None else (
                5 if cls == "Motorway" else 6 if cls == "A Road" else 9)
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "roads"},
                "properties": {"mz": mz, "aadf": cp["aadf"], "hgv": cp["hgv"],
                               "road": cp["road"], "year": cp["year"],
                               "est": cp["est"], "cls": "U" if cls == "Minor" else cls[0]},
                "geometry": {"type": "LineString", "coordinates": line},
            }, separators=(",", ":")) + "\n")

        for tile in tiles:
            df = read_tile(zf, tile, where="class IN ('Motorway','A Road','B Road')")
            if len(df):
                mids = df.geometry.interpolate(0.5, normalized=True)
                mx, my = mids.x.to_numpy(), mids.y.to_numpy()
                for i, (num, cls, fow) in enumerate(zip(df["roadNumber"], df["class"],
                                                        df["formOfWay"])):
                    # slip roads carry the mainline's number but a fraction of
                    # its flow — left undrawn rather than shown as the busiest
                    if fow == "Slip Road" or not isinstance(num, str) or num not in arr:
                        continue
                    xy, plist = arr[num]
                    d2 = (xy[:, 0] - mx[i]) ** 2 + (xy[:, 1] - my[i]) ** 2
                    j = int(np.argmin(d2))
                    if d2[j] > REACH.get(num[0], 1500) ** 2:
                        continue
                    cp = plist[j]
                    g = df.geometry.iloc[i]
                    emit(g, cp, cls)
                    n_major += 1
                    if cls != "B Road":
                        c = g.coords
                        for nid, xyz in ((df["startNode"].iloc[i], c[0]),
                                         (df["endNode"].iloc[i], c[-1])):
                            node_xy[nid] = (xyz[0], xyz[1])
                            node_links.setdefault(nid, []).append((cp["aadf"], num))

            # minor-road samples: only the link each point sits on
            mp = [p for p in minor if p["id"] not in used_minor]
            if mp:
                allr = read_tile(zf, tile)
                minx, miny, maxx, maxy = allr.total_bounds
                inside = [p for p in mp if minx <= p["e"] <= maxx and miny <= p["n"] <= maxy]
                if inside:
                    gp = gpd.GeoDataFrame(
                        {"k": range(len(inside))},
                        geometry=gpd.points_from_xy([p["e"] for p in inside],
                                                    [p["n"] for p in inside]),
                        crs=27700)
                    minor_links = allr[~allr["class"].isin(KEEP_CLASSES)]
                    hit = gpd.sjoin_nearest(gp, minor_links[["geometry", "class"]],
                                            max_distance=MINOR_SNAP, how="inner")
                    hit = hit[~hit.index.duplicated()]
                    for _, row in hit.iterrows():
                        cp = inside[int(row["k"])]
                        used_minor.add(cp["id"])
                        emit(minor_links.geometry.loc[row["index_right"]], cp,
                             "Minor", extra_min=11)
                        n_minor += 1
            print(f"[roads]   {tile}: {n_major:,} major/B links, {n_minor:,} minor so far",
                  flush=True)

        # junctions: nodes joining two or more DIFFERENT counted roads
        n_j = 0
        for nid, links in node_links.items():
            roads = {r for _, r in links}
            if len(links) < 3 or len(roads) < 2:
                continue
            flow = int(sum(a for a, _ in links) / 2)
            lon, lat = TO_WGS.transform(*node_xy[nid])
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "junctions"},
                "properties": {"mz": 7 if flow >= 100000 else 9 if flow >= 40000 else 11,
                               "aadf": flow, "roads": " / ".join(sorted(roads))},
                "geometry": {"type": "Point",
                             "coordinates": [round(lon, 5), round(lat, 5)]},
            }, separators=(",", ":")) + "\n")
            n_j += 1

        # the count points (popup detail: counted vs estimated, junction names)
        lon, lat = TO_WGS.transform(np.array([p["e"] for p in pts]),
                                    np.array([p["n"] for p in pts]))
        for p, x, y in zip(pts, lon, lat):
            fh.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": "counts"},
                "properties": {"mz": 10 if p["cat"] in MAJOR_CATS else 12,
                               **{k: p[k] for k in ("id", "road", "year", "aadf", "hgv",
                                                    "est", "from", "to", "la")}},
                "geometry": {"type": "Point",
                             "coordinates": [round(float(x), 5), round(float(y), 5)]},
            }, separators=(",", ":")) + "\n")

    print(f"[roads] wrote {OUT.name}: {n_major:,} major/B links, {n_minor:,} minor links, "
          f"{n_j:,} junctions, {len(pts):,} count points "
          f"({OUT.stat().st_size / 1e6:.0f} MB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
