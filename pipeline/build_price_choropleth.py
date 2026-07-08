"""
build_price_choropleth.py
-------------------------
Populate the full-map HOUSE-PRICE choropleth (the app's "House prices" layer)
directly from the price fields already committed on the LSOA points layer, so the
value overlay works WITHOUT the slow Land Registry download + gated ONS postcode
lookup that build_price_layer.py depends on.

The frontend colours the LSOA polygons by `price_norm` (a 0-100 percentile) when
the "House prices" layer is selected, and build_tiles.py derives the price colour
breaks from that same field. This step joins the per-LSOA price from
web/data/lsoa_imd_points.geojson onto the polygon layer web/data/lsoa_imd.geojson
and writes:

  price_norm    0-100 national percentile of £/m² (HIGH = most expensive -> the
                dark end of the ramp, i.e. the value hot-spots). £/m² is used
                rather than median sale price so the map shows value per unit
                floor area, not just where the big houses are.
  price_ppm2    the raw £/m² (for the legend + inspect popup)
  price_median  the raw median sale price £ (kept for the popup / station cover)
  price_count   number of sales behind the median, when the source carries it

Idempotent; safe to re-run. Runs before build_tiles.py in the data build.

  env PRICE_CHOROPLETH_BASIS   "ppm2" (default) | "median" — which metric drives
                               the colour ranking.
"""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POINTS = ROOT / "web" / "data" / "lsoa_imd_points.geojson"
POLYS = ROOT / "web" / "data" / "lsoa_imd.geojson"


def _percentiles(code_to_value):
    """Map {code -> value} to {code -> 0-100 percentile rank} (ties share the
    average rank; higher value -> higher percentile)."""
    items = [(c, v) for c, v in code_to_value.items() if isinstance(v, (int, float))]
    n = len(items)
    if n == 0:
        return {}
    items.sort(key=lambda kv: kv[1])
    out = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and items[j + 1][1] == items[i][1]:
            j += 1
        # average 1-based rank of the tie block -> percentile
        avg_rank = (i + 1 + j + 1) / 2.0
        pct = round(avg_rank / n * 100, 1)
        for k in range(i, j + 1):
            out[items[k][0]] = pct
        i = j + 1
    return out


def main() -> int:
    if not POINTS.exists():
        print(f"ERROR: {POINTS.name} not found — run build_lsoa_imd_points.py "
              "(+ build_lsoa_prices.py) first.")
        return 1
    if not POLYS.exists():
        print(f"ERROR: {POLYS.name} not found — run build_imd_layer.py first.")
        return 1

    basis = os.environ.get("PRICE_CHOROPLETH_BASIS", "ppm2").strip().lower()
    basis_field = "median_price" if basis == "median" else "price_per_m2"

    pts = json.loads(POINTS.read_text())
    ppm2, median, count = {}, {}, {}
    for f in pts.get("features", []):
        p = f.get("properties") or {}
        code = p.get("lsoa_code")
        if not code:
            continue
        if isinstance(p.get("price_per_m2"), (int, float)):
            ppm2[code] = p["price_per_m2"]
        if isinstance(p.get("median_price"), (int, float)):
            median[code] = p["median_price"]
        if isinstance(p.get("price_count"), (int, float)):
            count[code] = p["price_count"]

    rank_src = ppm2 if basis_field == "price_per_m2" else median
    if not rank_src:
        print(f"No {basis_field} values on the points layer — nothing to join. "
              "(Run build_lsoa_prices.py to populate them.)")
        return 1
    norm = _percentiles(rank_src)
    print(f"Ranked {len(norm)} LSOAs by {basis_field} "
          f"({len(set(round(v) for v in rank_src.values()))} distinct values).")

    polys = json.loads(POLYS.read_text())
    added = 0
    for f in polys.get("features", []):
        p = f.setdefault("properties", {})
        code = p.get("lsoa_code")
        p["price_norm"] = norm.get(code)                    # colour driver (0-100)
        p["price_ppm2"] = ppm2.get(code)                    # £/m² for legend/popup
        p["price_median"] = median.get(code)                # £ sale price for popup
        p["price_count"] = int(count.get(code, 0) or 0)
        if p["price_norm"] is not None:
            added += 1

    POLYS.write_text(json.dumps(polys, separators=(",", ":")))
    print(f"Merged price onto {added}/{len(polys.get('features', []))} LSOA polygons "
          f"-> {POLYS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
