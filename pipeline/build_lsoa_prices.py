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

LSOA_CODE_COLS = ["lsoa_code", "lsoa11cd", "lsoa21cd", "lsoa11", "lsoa21", "lsoacd",
                  "lsoa"]
LA_CODE_COLS = ["lad21cd", "lad22cd", "lad23cd", "ladcd", "lad_code", "la_code",
                "ltla_code", "utla_code", "local_authority_code"]
LA_NAME_COLS = ["lad21nm", "lad22nm", "lad23nm", "ladnm", "lad_name", "la_name",
                "local_authority", "local_authority_name", "name", "area_name",
                "geography", "geography_name"]
PPM2_COLS = ["price_per_m2", "price_per_sqm", "ppsqm", "price_per_square_metre",
             "pricepersqm", "median_price_per_sqm", "price_paid_per_sqm",
             "median_ppsqm", "ppm2", "priceper", "ppsm", "price_per_floor_area",
             "pricepersquaremetre"]
MEDIAN_COLS = ["median_price", "median", "median_price_paid", "price_paid_median",
               "medianprice", "price_paid", "pricepaid", "price"]
YEAR_COLS = ["year", "period", "deed_date", "date_of_transfer", "transfer_date", "date"]
# Aggregate only recent-enough transactions (the linked file spans 1995–2024).
MIN_YEAR = 2019


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _find(headers, cands):
    hn = {_norm(h): h for h in headers}
    for c in cands:
        if _norm(c) in hn:
            return hn[_norm(c)]
    return None


def _median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _read_price_csv(path, agg_ppm2, agg_med):
    """Accumulate one CSV's £/m² and price values into the aggregation dicts
    (keyed area -> list of values), from which the caller takes medians. Works for
    both aggregated files (one row per area) and transaction-level files (many rows
    per area — e.g. the linked PPD×EPC 'hpm' files). Returns the detected level
    ('lsoa' | 'la' | None). Transactions are filtered to recent years."""
    try:
        with path.open(newline="", encoding="utf-8-sig", errors="replace") as fh:
            reader = csv.DictReader(fh)
            headers = reader.fieldnames or []
            lsoa_col = _find(headers, LSOA_CODE_COLS)
            la_name_col = _find(headers, LA_NAME_COLS)
            la_code_col = _find(headers, LA_CODE_COLS)
            ppm2_col = _find(headers, PPM2_COLS)
            med_col = _find(headers, MEDIAN_COLS)
            year_col = _find(headers, YEAR_COLS)
            if not (ppm2_col or med_col):
                return None
            if lsoa_col:
                level, key_col = "lsoa", lsoa_col
            elif la_name_col or la_code_col:
                level, key_col = "la", (la_name_col or la_code_col)
            else:
                return None

            def num(col):
                v = (row.get(col) or "").strip().replace(",", "").replace("£", "")
                try:
                    f = float(v)
                    return f if f > 0 else None
                except ValueError:
                    return None

            n_p = n_m = 0
            for row in reader:
                raw_key = (row.get(key_col) or "").strip()
                if not raw_key:
                    continue
                key = raw_key if level == "lsoa" else _norm(raw_key)
                if year_col:
                    m = re.search(r"(\d{4})", str(row.get(year_col) or ""))
                    if m and int(m.group(1)) < MIN_YEAR:
                        continue
                pm = num(ppm2_col) if ppm2_col else None
                mp = num(med_col) if med_col else None
                if pm is not None:
                    agg_ppm2[(level, key)].append(pm); n_p += 1
                if mp is not None:
                    agg_med[(level, key)].append(mp); n_m += 1
            if n_p or n_m:
                print(f"  [{path.name}] level={level} · +{n_p} £/m² · +{n_m} price "
                      f"(key '{key_col}'"
                      + (f", ppm2 '{ppm2_col}'" if ppm2_col else "")
                      + (f", price '{med_col}'" if med_col else "") + ")")
            return level
    except Exception as exc:
        print(f"  [{path.name}] read failed: {exc}")
        return None


def _iter_sources():
    """Yield candidate CSV paths from the env vars / data/raw defaults. Each var
    may point at a CSV, or a directory (or an unzipped download folder) to scan."""
    seen = set()
    cands = []
    for env, default in (("LSOA_PPM2_SRC", "lsoa_price_per_m2.csv"),
                         ("LSOA_MEDIAN_PRICE_SRC", "lsoa_median_price.csv"),
                         ("HPM_SRC", "hpm")):
        v = os.environ.get(env, "").strip()
        cands.append(Path(v) if v else (RAW / default))
    cands.append(RAW / "hpm")            # default unzip folder
    for p in cands:
        if not p or not p.exists():
            continue
        files = sorted(p.rglob("*.csv")) if p.is_dir() else [p]
        for f in files:
            if f not in seen:
                seen.add(f)
                yield f


def main() -> int:
    if not POINTS.exists():
        print(f"ERROR: {POINTS} not found — run build_lsoa_imd_points.py first.")
        return 1

    from collections import defaultdict
    agg_ppm2, agg_med = defaultdict(list), defaultdict(list)
    n_files = 0
    for f in _iter_sources():
        if _read_price_csv(f, agg_ppm2, agg_med) is not None:
            n_files += 1
    if not (agg_ppm2 or agg_med):
        print("No usable price source found (see the module docstring). Nothing to do.")
        return 1
    # Median per area from the accumulated values.
    lsoa_ppm2 = {k[1]: _median(v) for k, v in agg_ppm2.items() if k[0] == "lsoa"}
    la_ppm2   = {k[1]: _median(v) for k, v in agg_ppm2.items() if k[0] == "la"}
    lsoa_med  = {k[1]: _median(v) for k, v in agg_med.items()  if k[0] == "lsoa"}
    la_med    = {k[1]: _median(v) for k, v in agg_med.items()  if k[0] == "la"}
    print(f"Aggregated {n_files} file(s) → LSOA: {len(lsoa_ppm2)} £/m², {len(lsoa_med)} price · "
          f"LA: {len(la_ppm2)} £/m², {len(la_med)} price")

    with POINTS.open(encoding="utf-8") as fh:
        data = json.load(fh)
    feats = data.get("features", [])

    n_ppm2 = n_med = n_derived = 0
    for f in feats:
        p = f.setdefault("properties", {})
        code = p.get("lsoa_code")
        lad = _norm(p.get("lad_name") or "")
        # Prefer the LSOA value; fall back to the containing local authority.
        pm = lsoa_ppm2.get(code)
        if pm is None:
            pm = la_ppm2.get(lad)
        mp = lsoa_med.get(code)
        if mp is None:
            mp = la_med.get(lad)
        if mp is not None:
            p["median_price"] = round(mp); n_med += 1
        if pm is not None:
            p["price_per_m2"] = round(pm); n_ppm2 += 1
        elif mp is not None:
            p["price_per_m2"] = round(mp / AVG_FLOOR_M2); n_derived += 1   # derived

    with POINTS.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print(f"Wrote {POINTS.relative_to(ROOT)}: {n_ppm2} £/m² ({n_derived} derived), "
          f"{n_med} median prices, of {len(feats)} LSOAs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
