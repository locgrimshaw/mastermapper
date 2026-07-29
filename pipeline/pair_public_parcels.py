"""
pair_public_parcels.py
----------------------
Pair public-authority ownership POINTS (CCOD postcode centroids, dataset
`la_property`) with land PARCEL POLYGONS (HMLR INSPIRE index polygons) to
produce dataset `public_parcel`: the actual shape of publicly-owned land.

WHY THIS IS A SPATIAL JOIN, not a key join: the only exact title->polygon
link is HM Land Registry's licensed National Polygon Service. INSPIRE
polygons carry an INSPIREID; CCOD carries title numbers; nothing public
joins them. So we place each ownership point (a postcode centroid) into the
parcel that contains it, or the nearest parcel within NEAR_M metres. Results
are INDICATIVE and labelled as such in the UI.

FLATS ARE EXCLUDED: a council owning one ex-right-to-buy flat inside a block
is not a land holding, and its postcode centroid would otherwise claim the
whole block's parcel. build_ccod.py classifies each title from its address
(see is_flat_address) and stores titles_land / titles_flat; this script only
uses points with titles_land > 0, and records both counts on the parcel.

Input:  a directory of line-delimited GeoJSON parcel files (parcels-*.jsonl),
        exactly what build-parcel-tiles.yml's shard jobs produce, plus the
        la_property points read live from Supabase (PostgREST, service key).
Output: supabase/datasets_import.csv rows for dataset `public_parcel`
        (props: owner, owner_class, titles, titles_land, titles_flat,
        postcode, address, area_m2, match = 'contains' | 'nearest').

Licence: INSPIRE index polygons © Crown copyright and database right,
reproduced with permission of HM Land Registry; CCOD likewise.
"""

import csv
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "supabase" / "datasets_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
# How far a postcode centroid may sit outside a parcel and still be matched
# to it (centroids often land on the road outside the site).
NEAR_M = float(os.environ.get("PARCEL_NEAR_M") or "30")
# Guard against a centroid on a road claiming a whole farm: parcels bigger
# than this are only accepted on a CONTAINS match, never a nearest match.
NEAR_MAX_M2 = 50_000.0


def fetch_points():
    """la_property points with at least one non-flat title -> list of dicts."""
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY required",
              file=sys.stderr)
        sys.exit(1)
    pts, offset, page = [], 0, 1000
    while True:
        q = urllib.parse.urlencode({
            "dataset": "eq.la_property",
            "select": "source_id,name,props,geom",
            "limit": page, "offset": offset})
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/map_features?{q}",
            headers={"apikey": SUPABASE_KEY,
                     "Authorization": f"Bearer {SUPABASE_KEY}",
                     "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            batch = json.loads(r.read().decode())
        if not batch:
            break
        pts.extend(batch)
        offset += page
        if len(batch) < page:
            break
    print(f"[pair] {len(pts):,} la_property points fetched")
    return pts


def main() -> int:
    try:
        from shapely.geometry import shape, box
        from shapely.strtree import STRtree
        from shapely.ops import transform as shp_transform
        from pyproj import Transformer
    except ImportError as e:
        print(f"ERROR: shapely + pyproj required ({e})", file=sys.stderr)
        return 1

    src_dir = Path(os.environ.get("PARCEL_DIR") or (ROOT / "data" / "raw"))
    files = sorted(src_dir.glob("parcels-*.jsonl"))
    if not files:
        print(f"ERROR: no parcels-*.jsonl in {src_dir}", file=sys.stderr)
        return 1
    print(f"[pair] {len(files)} parcel file(s): {[f.name for f in files]}")

    # --- ownership points, flats excluded -----------------------------------
    raw = fetch_points()
    pts, meta = [], []
    skipped_flat = 0
    for row in raw:
        props = row.get("props") or {}
        if not props.get("has_land", True):
            skipped_flat += 1
            continue
        g = row.get("geom")
        # PostgREST returns geometry as GeoJSON when the column is geometry
        # typed via PostGIS' automatic cast; fall back to WKB-hex parsing.
        try:
            geom = shape(g) if isinstance(g, dict) else None
            if geom is None:
                from shapely import wkb
                geom = wkb.loads(bytes.fromhex(g))
        except Exception:
            continue
        pts.append(geom)
        meta.append({"owner": row.get("name"), **props})
    print(f"[pair] {len(pts):,} points usable "
          f"({skipped_flat:,} flat-only points skipped)")
    if not pts:
        print("ERROR: no usable ownership points", file=sys.stderr)
        return 1

    tree = STRtree(pts)
    # Metres-accurate work happens in British National Grid. Every point is
    # projected ONCE here: a point sits in the query envelope of many parcels,
    # so transforming it inside the match loop re-does the same work over and
    # over (~40 us a call, millions of calls).
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True).transform
    pts_bng = [shp_transform(to_bng, p) for p in pts]
    deg_near = NEAR_M / 111_320.0     # rough degrees for the query envelope

    matched = {}          # parcel key -> row dict (best match wins)
    scanned = 0
    for path in files:
        with path.open(encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                scanned += 1
                if scanned % 500_000 == 0:
                    print(f"[pair] {scanned:,} parcels scanned, "
                          f"{len(matched):,} matched")
                try:
                    feat = json.loads(line)
                    poly = shape(feat["geometry"])
                except Exception:
                    continue
                if poly.is_empty:
                    continue
                # Candidate points near this parcel. Query with an expanded
                # BOUNDS BOX, never poly.buffer() — buffering 26M polygons
                # costs hours, and the tree only uses the envelope anyway.
                minx, miny, maxx, maxy = poly.bounds
                idxs = tree.query(box(minx - deg_near, miny - deg_near,
                                      maxx + deg_near, maxy + deg_near))
                if len(idxs) == 0:
                    continue
                poly_bng = shp_transform(to_bng, poly)
                area_m2 = poly_bng.area
                for i in idxs:
                    i = int(i)
                    p = pts[i]
                    if poly.contains(p):
                        kind = "contains"
                    else:
                        if area_m2 > NEAR_MAX_M2:
                            continue
                        d = poly_bng.distance(pts_bng[i])
                        if d > NEAR_M:
                            continue
                        kind = "nearest"
                    m = meta[i]
                    fid = (feat.get("properties") or {}).get("INSPIREID") \
                        or f"{poly.centroid.x:.6f},{poly.centroid.y:.6f}"
                    key = str(fid)
                    prev = matched.get(key)
                    # A contains-match always beats a nearest-match; between
                    # equals, the owner with more land titles wins.
                    if prev and (prev["_kind"] == "contains" and kind != "contains"):
                        continue
                    if prev and prev["_kind"] == kind and \
                            prev["_land"] >= (m.get("titles_land") or 0):
                        continue
                    matched[key] = {
                        "_kind": kind,
                        "_land": m.get("titles_land") or 0,
                        "geom": poly,
                        "props": {
                            "owner": m.get("owner"),
                            "owner_class": m.get("owner_class"),
                            "titles": m.get("titles"),
                            "titles_land": m.get("titles_land"),
                            "titles_flat": m.get("titles_flat"),
                            "postcode": m.get("postcode"),
                            "address": m.get("address"),
                            "area_m2": round(area_m2),
                            "match": kind,
                        },
                    }
    print(f"[pair] {scanned:,} parcels scanned -> {len(matched):,} publicly "
          "owned parcels identified")
    if not matched:
        print("ERROR: no parcels matched any ownership point", file=sys.stderr)
        return 1

    n_contains = sum(1 for v in matched.values() if v["_kind"] == "contains")
    tot_ha = sum(v["props"]["area_m2"] for v in matched.values()) / 10_000
    print(f"[pair] {n_contains:,} contains-matches, "
          f"{len(matched) - n_contains:,} nearest-matches; "
          f"{tot_ha:,.0f} ha total")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for key, v in matched.items():
            w.writerow({
                "dataset": "public_parcel",
                "source_id": f"pp-{key}"[:120],
                "name": v["props"]["owner"],
                "props": json.dumps({k: x for k, x in v["props"].items()
                                     if x not in (None, "")},
                                    separators=(",", ":"), ensure_ascii=False),
                "geom_wkt": "SRID=4326;" + v["geom"].wkt,
            })
    print(f"[pair] wrote {len(matched):,} rows to {OUT} "
          f"({OUT.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
