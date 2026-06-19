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

# Super Generalised Clipped (200m) 2021 LSOA boundaries — small, web-friendly.
# IMD 2025 uses 2021 LSOAs (33,755 of them; ~6% changed vs 2011), so we must
# use 2021 boundaries or the codes won't join to the scores.
# This is the ONS ArcGIS Feature Server query endpoint (layer 0).
BASE = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BSC_V4/FeatureServer/0/query"
)

PAGE = 2000   # features per request (the service caps this; we page through)


def fetch_page(offset: int) -> dict:
    params = {
        "where": "1=1",
        "outFields": "LSOA21CD",     # we only need the code; scores come from IMD
        "outSR": "4326",             # WGS84 lon/lat for web maps
        "f": "geojson",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE),
        "geometryPrecision": "5",    # trim coordinate decimals -> smaller file
    }
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "welfare-mapper"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    print("Fetching LSOA boundaries from ONS (this takes a minute)...")
    features = []
    offset = 0
    while True:
        page = fetch_page(offset)
        got = page.get("features", [])
        if not got:
            break                      # no more records
        features.extend(got)
        print(f"  fetched {len(features)} features...")
        if len(got) < PAGE:
            break                      # last (partial) page reached
        offset += len(got)
        time.sleep(0.3)                # be polite to the API

    fc = {"type": "FeatureCollection", "features": features}
    RAW.mkdir(parents=True, exist_ok=True)
    out = RAW / "lsoa_boundaries.geojson"
    out.write_text(json.dumps(fc))
    size_mb = out.stat().st_size / 1e6
    print(f"Wrote {out}  ({len(features)} LSOAs, {size_mb:.1f} MB)")
    if len(features) < 30000:
        print("  WARNING: expected ~34,700 England+Wales LSOAs. Got fewer —")
        print("  the API may have changed. Check the endpoint URL.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())