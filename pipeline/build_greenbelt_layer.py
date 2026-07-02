"""
build_greenbelt_layer.py
------------------------
Turns the national green-belt dataset (planning.data.gov.uk) into a slim GeoJSON
DISPLAY layer the map can draw directly: web/data/greenbelt.geojson.

This is a *display* overlay (a coloured wash of England's green belt), NOT the
"erase" constraint layer used by the developable-land tool — that one is built,
clipped and pushed to Supabase by build_constraints.py. Here we keep the whole
national extent but strip it down to a handful of properties and simplify the
geometry lightly so it stays light enough to serve as static GeoJSON (or, if it
is still large, as vector tiles — see the tippecanoe note at the end).

INPUT (download once; the asset host isn't reachable from CI, so commit it under
data/raw/ or fetch it in CI). From the dataset page click "Download" and choose
GeoJSON (already EPSG:4326):
    https://www.planning.data.gov.uk/dataset/green-belt
Save as (env GREEN_BELT_SRC overrides; .gpkg / .json also accepted):
    data/raw/green-belt.geojson

OUTPUT (DATA CONTRACT — keep EXACT, the frontend relies on it):
    web/data/greenbelt.geojson
    a GeoJSON FeatureCollection; each feature is Polygon/MultiPolygon with
      properties.name       string (may be '')
      properties.reference  string
    (plus, when present in the source, properties.organisation for context.)

Run:
    python pipeline/build_greenbelt_layer.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data" / "greenbelt.geojson"
PMTILES = ROOT / "web" / "data" / "greenbelt.pmtiles"

# Accept any of these as the downloaded source, in priority order. The
# planning.data.gov.uk "entity" export is a GeoJSON already in EPSG:4326.
SOURCE_CANDIDATES = [
    "green-belt.geojson", "green_belt.geojson", "green-belt.json",
    "green_belt.json", "green-belt.gpkg", "green_belt.gpkg",
]

# Light simplification. tippecanoe (if we tile later) simplifies per zoom, but
# this layer is a soft area wash where crisp edges don't matter, so a gentle
# pre-simplify in metres (via British National Grid) keeps the file small with
# no visible loss. COORD_DP keeps ~1 m precision in the written lon/lat.
SIMPLIFY_M = 10
COORD_DP = 6

# Slim property set. `name` and `reference` are the contract; `organisation`
# (the local authority / organisation-entity that supplied the record) is kept
# for context when the source carries it. Lenient, case-insensitive spellings.
NAME_CANDIDATES = ["name", "Name", "NAME"]
REFERENCE_CANDIDATES = ["reference", "Reference", "REFERENCE"]
ORG_CANDIDATES = [
    "organisation-entity", "organisation", "organisation-name",
    "local-authority", "local_authority", "OrganisationURI",
]

# Rough size (MB) above which raw GeoJSON gets sluggish and vector tiles are the
# better delivery format (same threshold spirit as build_imd_layer / build_tiles).
TILE_HINT_MB = 15


def _pick(columns, candidates):
    """Case-insensitive lookup of the first candidate column present."""
    lower = {c.lower(): c for c in columns if c != "geometry"}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def _src_path():
    """Resolve the source file: env GREEN_BELT_SRC, else first existing default
    under data/raw/. Returns a Path or None."""
    cands = []
    v = os.environ.get("GREEN_BELT_SRC", "").strip()
    if v:
        cands.append(Path(v))
    cands += [RAW / n for n in SOURCE_CANDIDATES]
    for p in cands:
        if p and p.exists():
            return p
    return None


def _maybe_tile():
    """Optionally emit web/data/greenbelt.pmtiles if tippecanoe is on PATH.
    Never fails the build if tippecanoe is absent (it usually isn't locally)."""
    if not shutil.which("tippecanoe"):
        return
    cmd = [
        "tippecanoe",
        "-o", str(PMTILES),
        "-f",                       # overwrite if exists
        "-L", "greenbelt:" + str(OUT),
        "-Z", "5",                  # min zoom (whole-of-England view)
        "-z", "12",                 # max zoom (a soft area wash needs no more)
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-size-limit",
    ]
    print("tippecanoe found — also emitting vector tiles:\n  " + " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("  (tippecanoe failed; keeping the GeoJSON only)")
        print(result.stderr[-800:])
        return
    size_mb = PMTILES.stat().st_size / 1e6
    print(f"  Wrote {PMTILES}  ({size_mb:.1f} MB)")


def main() -> int:
    src = _src_path()
    if src is None:
        print("ERROR: no green-belt source file found. Download the national "
              "green-belt dataset (GeoJSON) from\n"
              "  https://www.planning.data.gov.uk/dataset/green-belt\n"
              "and save it as data/raw/green-belt.geojson "
              "(or set GREEN_BELT_SRC).")
        return 1

    print(f"Reading {src.name} ...")
    gdf = gpd.read_file(src)
    print(f"  {len(gdf)} features read")

    # Keep only polygonal features (the source is polygons, but guard against
    # stray points/lines in a mixed export).
    gdf = gdf[gdf.geometry.notna()]
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    if len(gdf) == 0:
        print("ERROR: no Polygon/MultiPolygon features in the source.")
        return 1

    # The planning.data.gov.uk export is already WGS84 lat/long, but set it
    # explicitly if the file carries no CRS, then simplify in metres.
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)
    print(f"Simplifying geometry (tolerance {SIMPLIFY_M}m, topology-preserving)...")
    gdf = gdf.to_crs(27700)
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_M, preserve_topology=True)
    gdf = gdf.to_crs(4326)
    # Drop anything that simplified away to empty.
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]

    # Resolve and build the slim property set.
    name_col = _pick(gdf.columns, NAME_CANDIDATES)
    ref_col = _pick(gdf.columns, REFERENCE_CANDIDATES)
    org_col = _pick(gdf.columns, ORG_CANDIDATES)
    print(f"  columns -> name: {name_col!r}  reference: {ref_col!r}  "
          f"organisation: {org_col!r}")

    def _str(series):
        # Coerce to a clean string; missing -> '' so the contract holds.
        return series.fillna("").astype(str).str.strip()

    out = gpd.GeoDataFrame(geometry=gdf.geometry.values, crs=4326)
    out["name"] = _str(gdf[name_col]) if name_col else ""
    out["reference"] = _str(gdf[ref_col]) if ref_col else ""
    if org_col:
        out["organisation"] = _str(gdf[org_col])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()  # GeoJSON driver appends otherwise
    out.to_file(OUT, driver="GeoJSON", COORDINATE_PRECISION=COORD_DP)

    size_mb = OUT.stat().st_size / 1e6
    print(f"Wrote {OUT}  ({len(out)} features, {size_mb:.1f} MB)")

    if size_mb > TILE_HINT_MB:
        print(f"  NOTE: {size_mb:.1f} MB is on the large side for raw GeoJSON. "
              f"Consider tiling it with tippecanoe (like build_tiles.py) and "
              f"serving web/data/greenbelt.pmtiles instead.")
    _maybe_tile()
    return 0


if __name__ == "__main__":
    sys.exit(main())
