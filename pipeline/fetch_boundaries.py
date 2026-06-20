"""
fetch_boundaries.py
-------------------
Downloads the 2021 LSOA boundaries (Super Generalised, 200m, clipped) straight
from the ONS Open Geography Portal's ArcGIS API. This runs inside the GitHub
Action, so YOU never download or upload a boundary file. 2021 geography matches
the IoD 2025 LSOA codes (the 2019 indices used 2011 LSOAs).

The API returns features in pages, so we loop until we have them all.

Output:
  data/raw/lsoa_boundaries.geojson  (then build_imd_layer.py consumes it)

Run (or let the Action run it):
  python pipeline/fetch_boundaries.py
"""

import json
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

# Candidate boundary services, tried in order. The FIRST that returns the full
# set of LSOAs is used. We lead with the 200m (BSC) service we KNOW responds, so
# the build always succeeds; the finer 20m (BGC) services are listed too in case
# the exact name is right, but a wrong BGC name simply falls through to BSC
# rather than failing the build. (ONS renames these with each version, so we
# can't hardcode one fragile string.) All expose the LSOA21CD field.
#
# NOTE: most of the close-up detail improvement comes from NOT double-simplifying
# in build_imd_layer.py and from building tiles to z14 — both already done — so
# even on the BSC boundaries the zoomed-in view is much better than before.
CANDIDATES = [
    # 20m Generalised Clipped (BGC) — finer; tried first for crisp close-ups.
    # If this exact name is stale, it simply falls through to BSC below.
    ("BGC 20m v3",
     "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
     "Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BGC_V3/FeatureServer/0/query"),
    ("BGC 20m v2",
     "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
     "Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BGC_V2/FeatureServer/0/query"),
    # 200m Super Generalised (BSC) — the known-good baseline so the build always
    # succeeds even if both BGC names are stale.
    ("BSC 200m v4 (known-good fallback)",
     "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
     "Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BSC_V4/FeatureServer/0/query"),
]

PAGE = 2000   # features per request (the service caps this; we page through)


def fetch_page(base: str, offset: int) -> dict:
    params = {
        "where": "1=1",
        "outFields": "LSOA21CD",     # we only need the code; scores come from IMD
        "outSR": "4326",             # WGS84 lon/lat for web maps
        "f": "geojson",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE),
        "geometryPrecision": "6",    # ~0.1m; keep finer detail now we want close-up
    }
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 mastermapper"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all(base: str) -> list:
    """Page through one endpoint. Returns [] if the service errors or is empty."""
    features, offset = [], 0
    while True:
        page = fetch_page(base, offset)
        # ArcGIS reports a bad service/field as an "error" object, NOT an HTTP
        # failure — so an unrecognised name silently yields zero features unless
        # we check for this explicitly.
        if isinstance(page, dict) and page.get("error"):
            print(f"    service error: {page['error'].get('message', page['error'])}")
            return []
        got = page.get("features", [])
        if not got:
            break
        features.extend(got)
        print(f"    fetched {len(features)} features...")
        if len(got) < PAGE:
            break
        offset += len(got)
        time.sleep(0.3)
    return features


def load_committed_file():
    """If you've committed a boundary file (downloaded from the ONS portal in
    your browser), use it directly — no API call, no flaky service names. We
    look for a few likely names. The file can be raw ONS GeoJSON in EITHER
    coordinate system: WGS84 lat/long (what the map needs) or British National
    Grid eastings/northings (what ONS often serves). We auto-detect by the size
    of the coordinates and reproject if needed.

    Returns a feature list in WGS84, or None if no committed file is found.
    """
    candidates = [
        RAW / "lsoa_2021_bgc.geojson",
        RAW / "lsoa_boundaries_source.geojson",
        RAW / "LSOA_2021_EW_BGC_V2.geojson",
    ]
    path = next((p for p in candidates if p.exists()), None)
    if not path:
        return None

    print(f"Using committed boundary file: {path.name}")
    try:
        import geopandas as gpd
        gdf = gpd.read_file(path)
    except Exception as e:
        print(f"  couldn't read {path.name}: {e}")
        return None

    # Find the LSOA code column under whatever name the file uses.
    code_col = None
    for c in gdf.columns:
        if c.upper() == "LSOA21CD":
            code_col = c
            break
    if code_col is None:
        # Fall back to any LSOA*CD column.
        for c in gdf.columns:
            if c.upper().startswith("LSOA") and c.upper().endswith("CD"):
                code_col = c
                break
    if code_col is None:
        print(f"  no LSOA code column found. Columns: {list(gdf.columns)}")
        return None

    # Detect coordinate system. ONS GeoJSON is often British National Grid
    # (EPSG:27700), where coordinates are large (eastings ~ 100k–700k). The map
    # needs WGS84 (EPSG:4326), where longitudes are small (~ -8 to 2). If the
    # CRS is declared we trust it; otherwise we sniff the coordinate magnitude.
    try:
        if gdf.crs is None:
            xmin, ymin, xmax, ymax = gdf.total_bounds
            if abs(xmax) > 1000 or abs(ymax) > 1000:
                print("  no CRS set; coordinates look like British National Grid"
                      " — assuming EPSG:27700.")
                gdf = gdf.set_crs(27700)
            else:
                gdf = gdf.set_crs(4326)
        if gdf.crs.to_epsg() != 4326:
            print(f"  reprojecting from EPSG:{gdf.crs.to_epsg()} to WGS84 (4326)...")
            gdf = gdf.to_crs(4326)
    except Exception as e:
        print(f"  CRS handling note: {e}; assuming already WGS84.")

    import json as _json
    out = []
    for code, geom in zip(gdf[code_col], gdf.geometry):
        if code is None or geom is None or geom.is_empty:
            continue
        out.append({
            "type": "Feature",
            "properties": {"LSOA21CD": str(code)},
            "geometry": _json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"],
        })
    print(f"  {len(out)} LSOAs read from committed file")
    return out if out else None


def main() -> int:
    # 1) Prefer a committed boundary file (most reliable — no live API).
    features = load_committed_file()

    # 2) Otherwise fall back to the ONS API candidates.
    if not features:
        print("Fetching LSOA boundaries from ONS (this takes a minute)...")
        for label, base in CANDIDATES:
            print(f"  trying {label}...")
            try:
                features = fetch_all(base)
            except Exception as e:
                print(f"    failed: {e}")
                features = []
            if len(features) >= 30000:
                print(f"  using {label}: {len(features)} LSOAs")
                break
            elif features:
                print(f"    only {len(features)} features — trying next source")

    fc = {"type": "FeatureCollection", "features": features or []}
    RAW.mkdir(parents=True, exist_ok=True)
    out = RAW / "lsoa_boundaries.geojson"
    out.write_text(json.dumps(fc))
    size_mb = out.stat().st_size / 1e6
    print(f"Wrote {out}  ({len(fc['features'])} LSOAs, {size_mb:.1f} MB)")
    if len(fc["features"]) < 30000:
        print("  ERROR: expected ~34,700 England+Wales LSOAs but got far fewer.")
        print("  Easiest fix: download the boundary file in your browser and")
        print("  commit it as data/raw/lsoa_2021_bgc.geojson — see")
        print("  docs/BOUNDARIES_DOWNLOAD.md. The build will then use it directly.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())