"""
build_lsoa_imd_points.py
------------------------
Reduce the full LSOA IMD polygon layer (web/data/lsoa_imd.geojson, ~33.7k
polygons, 42 MB) to a compact POINT layer — one representative centroid per LSOA
carrying the IMD domain scores + population:

    web/data/lsoa_imd_points.geojson   (Point features, ~5 MB)

Why points: Assessment 4 (socio-economic benefit) needs a per-station catchment
IMD. A population-weighted average over LSOA centroids within the 800 m catchment
is a transparent, cheap proxy that fits the Supabase free tier (points + numbers,
no polygon geometry stored) and computes instantly with a GiST index + ST_DWithin.
The published points layer is loaded into public.lsoa_imd via the Postgres `http`
extension (see migration 0011), exactly like the stations load.

Centroid method: a plain average of every coordinate pair in the geometry
(exterior rings + parts). LSOAs are small, compact areas (~1,500 residents), so a
vertex-mean sits comfortably inside the zone — accurate enough to assign an LSOA
to a station catchment. (The frontend deep-dive still uses exact areal weighting
over the vector tiles for single-site precision; this is the national-sift proxy.)

No geopandas/shapely dependency — pure json + arithmetic, so it runs anywhere.

Run:
    python pipeline/build_lsoa_imd_points.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "data" / "lsoa_imd.geojson"
OUT = ROOT / "web" / "data" / "lsoa_imd_points.geojson"

# IMD score fields carried onto each point (normalised 0–100 domain scores +
# population). Kept compact; the raw scores stay in the polygon layer/tiles.
NORM_FIELDS = [
    "overall_norm", "income_norm", "employment_norm", "education_norm",
    "health_norm", "crime_norm", "housing_norm", "environment_norm",
]


def _iter_coords(geom):
    """Yield every [lng, lat] pair in a GeoJSON geometry (Polygon/MultiPolygon/
    others), recursing through the nested coordinate arrays."""
    if not geom:
        return
    coords = geom.get("coordinates")
    if coords is None:
        return

    def walk(node):
        # A coordinate pair is [number, number(, ...)]; anything else is a list
        # of sub-nodes to recurse into.
        if (isinstance(node, (list, tuple)) and len(node) >= 2
                and isinstance(node[0], (int, float))
                and isinstance(node[1], (int, float))):
            yield float(node[0]), float(node[1])
        elif isinstance(node, (list, tuple)):
            for sub in node:
                yield from walk(sub)

    yield from walk(coords)


def centroid(geom):
    """Vertex-mean centroid [lng, lat], or None if the geometry has no coords."""
    sx = sy = 0.0
    n = 0
    for x, y in _iter_coords(geom):
        sx += x
        sy += y
        n += 1
    if n == 0:
        return None
    return [round(sx / n, 6), round(sy / n, 6)]


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found.")
        return 1
    print(f"Reading {SRC.relative_to(ROOT)} ...")
    with SRC.open(encoding="utf-8") as fh:
        data = json.load(fh)
    feats = data.get("features", [])
    print(f"  {len(feats)} LSOAs; reducing to centroid points ...")

    out_feats, skipped = [], 0
    for f in feats:
        p = f.get("properties", {})
        code = p.get("lsoa_code")
        c = centroid(f.get("geometry"))
        if not code or c is None:
            skipped += 1
            continue
        props = {"lsoa_code": code, "lad_name": p.get("lad_name"),
                 "population": p.get("population")}
        for k in NORM_FIELDS:
            props[k] = p.get(k)
        out_feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": c},
            "properties": props,
        })

    out = {"type": "FeatureCollection", "features": out_feats}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    size_mb = OUT.stat().st_size / 1e6
    print(f"  wrote {len(out_feats)} points -> {OUT.relative_to(ROOT)} "
          f"({size_mb:.1f} MB)" + (f", skipped {skipped}" if skipped else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
