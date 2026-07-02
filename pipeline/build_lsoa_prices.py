"""
build_lsoa_prices.py
--------------------
Merge LSOA-level price data onto the published LSOA points layer
(web/data/lsoa_imd_points.geojson) so each station can be given a real, LOCAL
Gross Development Value in the viability model — a catchment-weighted £/m² over
the LSOAs within its 800 m ring (computed in SQL by rebuild_station_prices()).

Adds two properties to each point: `price_per_m2` and `median_price`.

SOURCES (all Open Government Licence). Provide either or both; each is optional
and matched by flexible column names so the various published layouts work:

  £/m² by LSOA — HM Land Registry Price Paid × EPC floor areas.
    London Datastore "House Price per Square Metre in England and Wales" (EPO9W).
    https://data.london.gov.uk/dataset/house-price-per-square-metre-in-england-and-wales-epo9w
    env LSOA_PPM2_SRC   default data/raw/lsoa_price_per_m2.csv
    expected columns: an LSOA code (lsoa/lsoa11/lsoa21/code/…) + a £/m² value
    (price_per_m2/price_per_sqm/ppsqm/…); if the file is long-format with a
    `year` column the latest year per LSOA is used.

  median price by LSOA — ONS House Price Statistics for Small Areas (HPSSA).
    https://www.ons.gov.uk/peoplepopulationandcommunity/housing/datasets/medianhousepricesforadministrativegeographies
    env LSOA_MEDIAN_PRICE_SRC   default data/raw/lsoa_median_price.csv
    expected columns: an LSOA code + a median price value.

If only median price is available, a £/m² is derived as median_price / an assumed
average floor area (AVG_FLOOR_M2, documented) so the viability model still has a
local £/m². Where a source is missing entirely the properties are left null and
the model falls back to the regional estimate.

Run:  python pipeline/build_lsoa_prices.py
Then republish web/data/lsoa_imd_points.geojson and re-run the lsoa_imd loader +
rebuild_station_prices().
"""

import csv
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POINTS = ROOT / "web" / "data" / "lsoa_imd_points.geojson"
RAW = ROOT / "data" / "raw"

# Fallback floor area (m²) to derive £/m² from a median price when no direct £/m²
# is supplied. ~94 m² is the ONS/English Housing Survey average dwelling size.
AVG_FLOOR_M2 = 94.0

LSOA_CODE_COLS = ["lsoa_code", "lsoa11cd", "lsoa21cd", "lsoa11", "lsoa21",
                  "lsoa", "code", "area_code", "geography_code", "geography code"]
PPM2_COLS = ["price_per_m2", "price_per_sqm", "ppsqm", "price_per_square_metre",
             "pricepersqm", "median_price_per_sqm", "value"]
MEDIAN_COLS = ["median_price", "median", "median_price_paid", "price", "value"]
YEAR_COLS = ["year", "period", "date"]


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _find(headers, cands):
    hn = {_norm(h): h for h in headers}
    for c in cands:
        if _norm(c) in hn:
            return hn[_norm(c)]
    return None


def _read_csv_latest(path, value_cols):
    """Read a CSV keyed by LSOA -> numeric value. If a year/period column exists,
    keep the latest per LSOA. Returns {lsoa_code: value} or {}."""
    if not path or not path.exists():
        return {}
    out, years = {}, {}
    with path.open(newline="", encoding="utf-8-sig", errors="replace") as fh:
        reader = csv.DictReader(fh)
        headers = reader.fieldnames or []
        code_col = _find(headers, LSOA_CODE_COLS)
        val_col = _find(headers, value_cols)
        year_col = _find(headers, YEAR_COLS)
        if not code_col or not val_col:
            print(f"  [{path.name}] could not find LSOA code / value columns "
                  f"(headers: {headers[:8]}…) — skipping")
            return {}
        for row in reader:
            code = (row.get(code_col) or "").strip()
            raw = (row.get(val_col) or "").strip().replace(",", "").replace("£", "")
            if not code or not raw:
                continue
            try:
                val = float(raw)
            except ValueError:
                continue
            if val <= 0:
                continue
            yr = 0
            if year_col:
                m = re.search(r"(\d{4})", str(row.get(year_col) or ""))
                yr = int(m.group(1)) if m else 0
            if code not in out or yr >= years.get(code, -1):
                out[code] = val
                years[code] = yr
    print(f"  [{path.name}] {len(out)} LSOA values via '{code_col}' / '{val_col}'"
          + (f" (latest by '{year_col}')" if _find(headers, YEAR_COLS) else ""))
    return out


def _src(env, default):
    v = os.environ.get(env, "").strip()
    if v and Path(v).exists():
        return Path(v)
    p = RAW / default
    return p if p.exists() else None


def main() -> int:
    if not POINTS.exists():
        print(f"ERROR: {POINTS} not found — run build_lsoa_imd_points.py first.")
        return 1

    ppm2 = _read_csv_latest(_src("LSOA_PPM2_SRC", "lsoa_price_per_m2.csv"), PPM2_COLS)
    median = _read_csv_latest(_src("LSOA_MEDIAN_PRICE_SRC", "lsoa_median_price.csv"), MEDIAN_COLS)
    if not ppm2 and not median:
        print("No price source found. Provide LSOA_PPM2_SRC and/or "
              "LSOA_MEDIAN_PRICE_SRC (see the module docstring). Nothing to do.")
        return 1

    with POINTS.open(encoding="utf-8") as fh:
        data = json.load(fh)
    feats = data.get("features", [])

    n_ppm2 = n_med = n_derived = 0
    for f in feats:
        p = f.setdefault("properties", {})
        code = p.get("lsoa_code")
        mp = median.get(code)
        pm = ppm2.get(code)
        if mp is not None:
            p["median_price"] = round(mp)
            n_med += 1
        if pm is not None:
            p["price_per_m2"] = round(pm)
            n_ppm2 += 1
        elif mp is not None:
            p["price_per_m2"] = round(mp / AVG_FLOOR_M2)   # derived fallback
            n_derived += 1

    with POINTS.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print(f"Wrote {POINTS.relative_to(ROOT)}: {n_ppm2} £/m² direct, "
          f"{n_derived} £/m² derived from median, {n_med} median prices "
          f"(of {len(feats)} LSOAs).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
