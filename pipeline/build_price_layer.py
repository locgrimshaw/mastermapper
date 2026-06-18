"""
build_price_layer.py
--------------------
Adds house-price context to each LSOA. Runs in the GitHub Action, after the
deprivation layer is built, and MERGES price fields into the same GeoJSON the
app already loads — so there's no extra file for the app to fetch.

Sources (both pulled automatically in the cloud — you upload nothing):
  - HM Land Registry Price Paid Data, one year (CSV, ~hundreds of MB/year)
  - ONS postcode -> LSOA best-fit lookup (from the ONS ArcGIS API)

What it computes per LSOA:
  - price_median   median sale price (whole £)
  - price_count    number of sales in the period (confidence indicator)
  - price_norm     0-100 percentile rank of median price across England

Output: rewrites web/data/lsoa_imd.geojson with the price fields added.

Run (or let the Action run it):  python pipeline/build_price_layer.py
"""

import csv
import io
import json
import sys
import urllib.request
import urllib.parse
from collections import defaultdict
from pathlib import Path
from statistics import median

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
WEBDATA = ROOT / "web" / "data" / "lsoa_imd.geojson"
CACHE = ROOT / "data" / "raw"

# One recent full year of Price Paid. Yearly files are smaller than the
# 4GB complete file and plenty for a context overlay. Adjust the year as
# newer data lands.
PPD_YEAR = 2024
PPD_URL = (
    f"http://prod1.publicdata.landregistry.gov.uk.s3-website-eu-west-1"
    f".amazonaws.com/pp-{PPD_YEAR}.csv"
)

# Price Paid CSV has no header row. These are the columns by position
# (per Land Registry's published schema). We only need price (1) and
# postcode (3).
PPD_PRICE_COL = 1
PPD_POSTCODE_COL = 3

# Postcode -> LSOA(2011) best-fit lookup via the ONS ArcGIS API.
PCD_LSOA_BASE = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "PCD_OA21_LSOA21_MSOA21_LAD_NOV24_UK_LU/FeatureServer/0/query"
)


def fetch_price_rows():
    """Yield (postcode, price) from the Land Registry yearly CSV."""
    print(f"Downloading Price Paid {PPD_YEAR} (this is the slow step)...")
    req = urllib.request.Request(PPD_URL, headers={"User-Agent": "welfare-mapper"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        text = io.TextIOWrapper(resp, encoding="utf-8", errors="replace")
        reader = csv.reader(text)
        n = 0
        for row in reader:
            if len(row) <= PPD_POSTCODE_COL:
                continue
            postcode = row[PPD_POSTCODE_COL].strip().upper().replace(" ", "")
            try:
                price = int(row[PPD_PRICE_COL])
            except (ValueError, IndexError):
                continue
            if postcode and price > 0:
                yield postcode, price
                n += 1
        print(f"  read {n} priced transactions")


def load_postcode_lsoa():
    """Return {normalised_postcode: lsoa_code}. Cached locally to avoid
    re-fetching the large lookup on every run."""
    cache_file = CACHE / "pcd_lsoa.json"
    if cache_file.exists():
        print("Using cached postcode->LSOA lookup.")
        return json.loads(cache_file.read_text())

    print("Fetching postcode->LSOA lookup from ONS (large, one-off per run)...")
    lookup = {}
    offset = 0
    PAGE = 4000
    while True:
        params = {
            "where": "1=1",
            "outFields": "pcds,lsoa11cd",
            "returnGeometry": "false",
            "f": "json",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE),
        }
        url = PCD_LSOA_BASE + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "welfare-mapper"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        feats = data.get("features", [])
        if not feats:
            break
        for ft in feats:
            a = ft.get("attributes", {})
            pcd = (a.get("pcds") or "").strip().upper().replace(" ", "")
            lsoa = a.get("lsoa11cd")
            if pcd and lsoa:
                lookup[pcd] = lsoa
        print(f"  {len(lookup)} postcodes mapped...")
        if len(feats) < PAGE:
            break
        offset += len(feats)

    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(lookup))
    return lookup


def main() -> int:
    if not WEBDATA.exists():
        print(f"ERROR: {WEBDATA} not found. Run build_imd_layer.py first.")
        return 1

    pcd_lsoa = load_postcode_lsoa()
    if len(pcd_lsoa) < 100000:
        print("  WARNING: postcode lookup looks short; results may be partial.")

    # Gather prices per LSOA.
    prices_by_lsoa = defaultdict(list)
    matched = 0
    for postcode, price in fetch_price_rows():
        lsoa = pcd_lsoa.get(postcode)
        if lsoa:
            prices_by_lsoa[lsoa].append(price)
            matched += 1
    print(f"  matched {matched} sales to LSOAs across {len(prices_by_lsoa)} areas")

    # Median + count per LSOA.
    med = {k: median(v) for k, v in prices_by_lsoa.items()}
    cnt = {k: len(v) for k, v in prices_by_lsoa.items()}

    # Percentile-rank the medians across England (0-100).
    s = pd.Series(med)
    norm = (s.rank(pct=True) * 100).round(1).to_dict()

    # Merge into the GeoJSON.
    gj = json.loads(WEBDATA.read_text())
    added = 0
    for f in gj["features"]:
        code = f["properties"].get("lsoa_code")
        if code in med:
            f["properties"]["price_median"] = int(med[code])
            f["properties"]["price_count"] = int(cnt[code])
            f["properties"]["price_norm"] = float(norm[code])
            added += 1
        else:
            f["properties"]["price_median"] = None
            f["properties"]["price_count"] = 0
            f["properties"]["price_norm"] = None
    WEBDATA.write_text(json.dumps(gj))
    print(f"Added price data to {added}/{len(gj['features'])} LSOAs")
    print(f"Wrote {WEBDATA}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
