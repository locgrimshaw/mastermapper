"""
build_land_ownership.py
-----------------------
Build supabase/land_ownership_import.csv (body, owner_name, geom_wkt) from
public-body land-ownership polygon sources, for the "Public land ownership" map
overlay (public.land_ownership + land_ownership_in_bbox).

Genuinely-open owner-labelled polygon sources (OGL) available today:
  forestry_england  — Forestry England Ownership (Forestry Commission Open Data,
                      ArcGIS Hub item 88527fff4fcb4e08b8e90a43979ffc87)
  forestry_scotland — National Forest Estate Ownership Scotland 2019
                      (ArcGIS Hub item f5b65ef014464c16b24f4cfc9c9a5bf6)

NOTE on Network Rail / MoD / local authorities: HM Land Registry publishes owner
NAMES (CCOD, OGL) and parcel GEOMETRY (INSPIRE, OGL) separately, but the dataset
linking title->polygon (National Polygon Service) is licensed (£20k/yr). So those
bodies can be added here later by loading NPS-joined polygons under the same
schema (body + owner_name + geom); the overlay already supports them.

Each source is a downloaded GeoJSON (the workflow fetches it); point the env vars
at the files (defaults under data/raw). Missing sources are skipped.
  env LAND_FE_SRC   default data/raw/land_forestry_england.geojson
  env LAND_FLS_SRC  default data/raw/land_forestry_scotland.geojson

Run:  python pipeline/build_land_ownership.py   (then loaders/load_land_ownership.py)
"""

import csv
import os
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon
from shapely import make_valid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "supabase" / "land_ownership_import.csv"
RAW = ROOT / "data" / "raw"
SIMPLIFY_M = 10.0     # light simplify in EPSG:27700 to keep the table compact
COORD_DP = 6

# body -> (env var, default filename, human owner label). All Open Government
# Licence. Scotland's public estate is unusually open: each landowning public body
# publishes its own holdings, so we ingest them per-body under the same schema.
SOURCES = {
    "forestry_england":     ("LAND_FE_SRC",  "land_forestry_england.geojson",  "Forestry England"),
    "forestry_scotland":    ("LAND_FLS_SRC", "land_forestry_scotland.geojson",  "Forestry and Land Scotland"),
    # Scotland Tier-A public bodies (see docs/DATASETS.md). Polygons only; point
    # datasets (e.g. some HES monuments) are dropped by _to_multipolygon.
    "naturescot_scotland":  ("LAND_NS_SRC",  "land_naturescot.geojson",         "NatureScot (National Nature Reserves)"),
    "crown_estate_scotland":("LAND_CES_SRC", "land_crown_estate_scotland.geojson", "Crown Estate Scotland"),
    "hes_scotland":         ("LAND_HES_SRC", "land_hes_properties_in_care.geojson", "Historic Environment Scotland (Properties in Care)"),
}

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _src(env, default):
    v = os.environ.get(env, "").strip()
    p = Path(v) if v else (RAW / default)
    return p if p.exists() else None


def _to_multipolygon(geom):
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "Polygon":
        return MultiPolygon([geom])
    if geom.geom_type == "MultiPolygon":
        return geom
    # GeometryCollection etc. -> keep polygonal parts only
    polys = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    if not polys:
        return None
    out = []
    for g in polys:
        out.extend(g.geoms if g.geom_type == "MultiPolygon" else [g])
    return MultiPolygon(out) if out else None


def main() -> int:
    rows = []
    for body, (env, default, label) in SOURCES.items():
        path = _src(env, default)
        if not path:
            print(f"  [{body}] no source ({env} / {default}) — skipping")
            continue
        print(f"  [{body}] reading {path.name} ...")
        try:
            gdf = gpd.read_file(path)
        except Exception as exc:
            print(f"    read failed: {exc}")
            continue
        if gdf.empty:
            print("    empty — skipping")
            continue
        if gdf.crs is None:
            gdf = gdf.set_crs(4326)
        # Simplify in a metric CRS, then back to 4326 for storage.
        g27 = gdf.to_crs(27700)
        g27["geometry"] = g27.geometry.buffer(0).simplify(SIMPLIFY_M, preserve_topology=True)
        gdf = g27.to_crs(4326)
        n = 0
        for geom in gdf.geometry:
            mp = _to_multipolygon(make_valid(geom)) if geom is not None else None
            if mp is None or mp.is_empty:
                continue
            wkt = mp.wkt
            # trim coordinate precision to keep the CSV small
            rows.append({"body": body, "owner_name": label,
                         "geom_wkt": f"SRID=4326;{wkt}"})
            n += 1
        print(f"    {n} ownership polygons")

    if not rows:
        print("No land-ownership sources found. Nothing written.")
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["body", "owner_name", "geom_wkt"])
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rows)} rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
