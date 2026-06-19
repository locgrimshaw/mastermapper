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


def main() -> int:
    print("Fetching LSOA boundaries from ONS (this takes a minute)...")
    features = []
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

    fc = {"type": "FeatureCollection", "features": features}
    RAW.mkdir(parents=True, exist_ok=True)
    out = RAW / "lsoa_boundaries.geojson"
    out.write_text(json.dumps(fc))
    size_mb = out.stat().st_size / 1e6
    print(f"Wrote {out}  ({len(features)} LSOAs, {size_mb:.1f} MB)")
    if len(features) < 30000:
        print("  ERROR: expected ~34,700 England+Wales LSOAs but got far fewer.")
        print("  All candidate ONS endpoints failed. The services may have been")
        print("  renamed again — check https://geoportal.statistics.gov.uk")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())