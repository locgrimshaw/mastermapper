"""
build_imd_layer.py
------------------
Turns raw English IMD 2019 data + LSOA boundaries into a single GeoJSON
the map can consume directly.

Inputs (you download these — see docs/DATASETS.md):
  data/raw/imd2019_scores.csv      English IMD 2019, scores by LSOA
  data/raw/lsoa_boundaries.geojson LSOA 2011 boundaries (generalised)

Output:
  data/processed/lsoa_imd.geojson  one feature per LSOA, with normalised
                                   0-100 metrics + raw deciles

Run:  python pipeline/build_imd_layer.py
"""

import json
import sys
import urllib.request
import urllib.parse
from pathlib import Path

import pandas as pd
import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"

# ONS lookup giving each 2011 LSOA its name and its Local Authority District
# (the "borough/district"). Field names: LSOA11CD, LSOA11NM, LAD22CD, LAD22NM.
LSOA_LAD_BASE = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "LSOA_2011_to_LSOA_2021_to_Local_Authority_District_2022_Lookup_for_England__2022"
    "/FeatureServer/0/query"
)

# The 7 IMD domains we expose as adjustable metrics, plus overall.
# Keys are our internal names; values are the *score* column names as they
# appear in the official IMD 2019 CSV (these are stable — verify on download).
DOMAIN_SCORE_COLUMNS = {
    "overall":    "Index of Multiple Deprivation (IMD) Score",
    "income":     "Income Score (rate)",
    "employment": "Employment Score (rate)",
    "education":  "Education, Skills and Training Score",
    "health":     "Health Deprivation and Disability Score",
    "crime":      "Crime Score",
    "housing":    "Barriers to Housing and Services Score",
    "environment":"Living Environment Score",
}

# The LSOA code column name in the IMD CSV.
IMD_LSOA_CODE = "LSOA code (2011)"
# The LSOA code field in the boundary file (ONS calls it LSOA11CD).
GEO_LSOA_CODE = "LSOA11CD"


def fetch_lsoa_names() -> pd.DataFrame:
    """Fetch {lsoa_code, lsoa_name, lad_name} from ONS, paging through results.
    Returns an empty frame on failure so the build can continue without names.
    """
    print("Fetching LSOA & district names from ONS...")
    rows = []
    offset, PAGE = 0, 4000
    try:
        while True:
            params = {
                "where": "1=1",
                "outFields": "LSOA11CD,LSOA11NM,LAD22NM",
                "returnGeometry": "false",
                "f": "json",
                "resultOffset": str(offset),
                "resultRecordCount": str(PAGE),
            }
            url = LSOA_LAD_BASE + "?" + urllib.parse.urlencode(params)
            req = urllib.request.Request(url, headers={"User-Agent": "welfare-mapper"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            feats = data.get("features", [])
            if not feats:
                break
            for ft in feats:
                a = ft.get("attributes", {})
                code = a.get("LSOA11CD")
                if code:
                    rows.append({
                        "lsoa_code": code,
                        "lsoa_name": a.get("LSOA11NM"),
                        "lad_name": a.get("LAD22NM"),
                    })
            print(f"  {len(rows)} names fetched...")
            if len(feats) < PAGE:
                break
            offset += len(feats)
    except Exception as e:
        print(f"  WARNING: name lookup failed ({e}). Continuing without names.")
        return pd.DataFrame(columns=["lsoa_code", "lsoa_name", "lad_name"])
    return pd.DataFrame(rows).drop_duplicates("lsoa_code")


def normalise_0_100(series: pd.Series) -> pd.Series:
    """Percentile-rank to 0-100. Higher = more deprived (worse).

    We use percentile rank rather than min-max so a few extreme outliers
    don't compress everyone else into a narrow band. 100 = most deprived
    in England, 0 = least.
    """
    return (series.rank(pct=True) * 100).round(1)


def main() -> int:
    imd_path = RAW / "imd2019_scores.csv"
    geo_path = RAW / "lsoa_boundaries.geojson"

    if not imd_path.exists() or not geo_path.exists():
        print("ERROR: raw data missing. Expected:")
        print(f"  {imd_path}")
        print(f"  {geo_path}")
        print("See docs/DATASETS.md for download links.")
        return 1

    print("Reading IMD scores...")
    imd = pd.read_csv(imd_path)

    # Keep only the columns we need, renamed to our internal names.
    keep = {IMD_LSOA_CODE: "lsoa_code"}
    for name, col in DOMAIN_SCORE_COLUMNS.items():
        if col not in imd.columns:
            print(f"  WARNING: column not found in CSV: '{col}'")
            print(f"  Available columns:\n   " + "\n   ".join(imd.columns))
            return 1
        keep[col] = f"{name}_score_raw"
    imd = imd[list(keep)].rename(columns=keep)

    print("Normalising each domain to 0-100 (percentile rank)...")
    for name in DOMAIN_SCORE_COLUMNS:
        raw = imd[f"{name}_score_raw"]
        imd[f"{name}_norm"] = normalise_0_100(raw)

    print("Reading LSOA boundaries...")
    geo = gpd.read_file(geo_path)
    if GEO_LSOA_CODE not in geo.columns:
        # Boundary files vary; try to find the code column.
        candidates = [c for c in geo.columns if c.upper().startswith("LSOA") and c.upper().endswith("CD")]
        if not candidates:
            print(f"  ERROR: no LSOA code column in boundary file. Columns: {list(geo.columns)}")
            return 1
        geo = geo.rename(columns={candidates[0]: GEO_LSOA_CODE})
        print(f"  (used '{candidates[0]}' as the LSOA code column)")

    geo = geo.rename(columns={GEO_LSOA_CODE: "lsoa_code"})
    geo = geo[["lsoa_code", "geometry"]]

    print("Joining scores to geometry...")
    merged = geo.merge(imd, on="lsoa_code", how="inner")
    print(f"  {len(merged)} LSOAs matched "
          f"({len(geo)} boundaries, {len(imd)} score rows)")

    # Attach the LSOA name and Local Authority District (borough/district) name.
    names = fetch_lsoa_names()
    if not names.empty:
        merged = merged.merge(names, on="lsoa_code", how="left")
        n_named = merged["lad_name"].notna().sum()
        print(f"  attached district names to {n_named}/{len(merged)} LSOAs")
    else:
        merged["lsoa_name"] = None
        merged["lad_name"] = None

    # Simplify geometry and round coordinates to keep the file small enough to
    # serve as plain GeoJSON. Two levers, both safe at LSOA-on-a-national-map
    # scale where you never zoom in far enough to see the detail we're dropping:
    #   SIMPLIFY_M  — drop vertices closer together than this many metres
    #   COORD_DP    — decimal places kept in the output lon/lat
    # 50m tolerance + 4dp (~11m) is invisible at the zoom levels planners use
    # but typically shrinks the file several-fold versus 20m + 5dp.
    SIMPLIFY_M = 50
    COORD_DP = 4
    print(f"Simplifying geometry (tolerance {SIMPLIFY_M}m, {COORD_DP}dp)...")
    merged = merged.to_crs(27700)
    merged["geometry"] = merged["geometry"].simplify(SIMPLIFY_M, preserve_topology=True)
    merged = merged.to_crs(4326)

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "lsoa_imd.geojson"
    # Write with limited coordinate precision (GeoPandas passes COORDINATE_PRECISION
    # through to the GeoJSON driver).
    merged.to_file(out_path, driver="GeoJSON", COORDINATE_PRECISION=COORD_DP)
    size_mb = out_path.stat().st_size / 1e6
    print(f"Wrote {out_path}  ({size_mb:.1f} MB)")
    if size_mb > 25:
        print("  NOTE: still large. If the map feels slow, the next step is")
        print("  vector tiles (tippecanoe) rather than raw GeoJSON.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
