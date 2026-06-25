#!/usr/bin/env python3
"""Complete the NPPF 'well-connected station' test by adding the TTWA-GVA limb.

Draft NPPF (Dec 2025) defines a 'well-connected' station as one that BOTH:
  (a) lies in a top-60 Travel to Work Area (TTWA), ranked by total Gross Value
      Added (GVA), among TTWAs located partially or fully within England; AND
  (b) is served throughout the daytime by >=4 trains/hr overall, or >=2/hr per
      direction  (the 'meets_frequency' flag, already computed by
      build_connectivity_cif.py and merged onto stations).

This script does limb (a): rank England-touching TTWAs by total GVA, take the
top 60, map every station to its TTWA by point-in-polygon, flag
`ttwa_in_top60`, and set `well_connected = meets_frequency AND ttwa_in_top60`.

INPUTS (under data/raw/, both Open Government Licence):
  ttwa_2011.geojson  ONS TTWA (Dec 2011) boundaries, WGS84 lat/long, 228 areas,
                     properties TTWA11CD / TTWA11NM.
  ttwa_gva.xlsx      ONS 'UK GVA and productivity estimates for other
                     geographies'. Table 2 = TTWA total GVA (pounds million),
                     header row 2 (TTWA code, TTWA name, then a column per year
                     1998..2023).

OUTPUT: updates web/data/stations.geojson in place, adding per station:
  ttwa_code, ttwa_name, ttwa_gva_rank, ttwa_in_top60, well_connected
Also writes data/raw/ttwa_top60.csv — the ranked, auditable top-60 list (the
rank-60 cutoff is policy-sensitive, so it must be inspectable).

USAGE:  python pipeline/build_ttwa_gva.py   (run after build_station_usage.py)
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
TTWA_GEOJSON = RAW / "ttwa_2011.geojson"
TTWA_GVA_XLSX = RAW / "ttwa_gva.xlsx"
STATIONS = ROOT / "web" / "data" / "stations.geojson"
TOP60_CSV = RAW / "ttwa_top60.csv"

GVA_YEAR = "2023"   # latest available; configurable
TOP_N = 60          # NPPF: top 60 TTWAs by GVA


def load_gva(year: str = GVA_YEAR) -> dict:
    """Read Table 2 -> {ttwa_code: total_gva_for_year}. Header is row 2."""
    import openpyxl
    wb = openpyxl.load_workbook(TTWA_GVA_XLSX, read_only=True, data_only=True)
    ws = wb["Table 2"]
    rows = ws.iter_rows(min_row=2, values_only=True)
    header = list(next(rows))
    try:
        ycol = header.index(year)
    except ValueError:
        # header years may be ints, not strings
        ycol = header.index(int(year))
    gva = {}
    for r in rows:
        code = r[0]
        if not code or not str(code).strip():
            continue
        val = r[ycol]
        if isinstance(val, (int, float)):
            gva[str(code).strip()] = float(val)
    return gva


def england_touching(code: str) -> bool:
    """TTWAs 'partially or fully within England'. England TTWA codes start with
    'E30'. Cross-border TTWAs (England/Wales, England/Scotland) use a 'K01'
    prefix in the 2011 set and are partially in England, so include those too.
    Wales-only ('W22') and Scotland-only ('S22') are excluded."""
    c = str(code)
    return c.startswith("E30") or c.startswith("K01")


def rank_top60(gva: dict) -> tuple[list, dict]:
    """Return (ordered list of (rank, code, gva) for England-touching TTWAs,
    dict code->rank). Rank 1 = highest GVA."""
    eligible = [(code, g) for code, g in gva.items() if england_touching(code)]
    eligible.sort(key=lambda kv: kv[1], reverse=True)
    ranked = [(i + 1, code, g) for i, (code, g) in enumerate(eligible)]
    code_to_rank = {code: rank for rank, code, _g in ranked}
    return ranked, code_to_rank


# ---- point-in-polygon (ray casting) ----------------------------------------

def point_in_ring(x: float, y: float, ring: list) -> bool:
    """Standard ray-casting test: is (x,y) inside this linear ring?"""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and \
           (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def point_in_polygon(x: float, y: float, geom: dict) -> bool:
    """Handle Polygon and MultiPolygon. A point is inside if it's in an outer
    ring and not in any hole of that polygon."""
    t = geom["type"]
    polys = geom["coordinates"] if t == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if not poly:
            continue
        outer = poly[0]
        if point_in_ring(x, y, outer):
            in_hole = any(point_in_ring(x, y, poly[h]) for h in range(1, len(poly)))
            if not in_hole:
                return True
    return False


def bbox_of(geom: dict):
    """Quick bounding box for a fast pre-filter before the full PiP test."""
    t = geom["type"]
    polys = geom["coordinates"] if t == "MultiPolygon" else [geom["coordinates"]]
    xs, ys = [], []
    for poly in polys:
        for x, y in poly[0]:
            xs.append(x); ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys))


def main() -> int:
    print("Completing NPPF well-connected test (TTWA-GVA top-60 limb)...")
    for p in (TTWA_GEOJSON, TTWA_GVA_XLSX, STATIONS):
        if not p.exists():
            print(f"  missing input: {p}")
            return 1

    # 1. GVA -> ranked England-touching top 60.
    gva = load_gva()
    print(f"  GVA ({GVA_YEAR}): {len(gva)} TTWAs total")
    ranked, code_to_rank = rank_top60(gva)
    n_elig = len(ranked)
    top60_codes = {code for rank, code, _g in ranked if rank <= TOP_N}
    print(f"  England-touching TTWAs: {n_elig} · taking top {TOP_N} by GVA")

    # 2. Load TTWA polygons (+ name lookup), build bbox index.
    tt = json.load(open(TTWA_GEOJSON, encoding="utf-8"))
    polys = []
    name_by_code = {}
    for f in tt["features"]:
        code = f["properties"].get("TTWA11CD")
        name = f["properties"].get("TTWA11NM")
        name_by_code[code] = name
        polys.append((code, bbox_of(f["geometry"]), f["geometry"]))
    print(f"  loaded {len(polys)} TTWA polygons")

    # 3. Write the auditable ranked top-60 (+ a few either side of the cutoff).
    with TOP60_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["rank", "ttwa_code", "ttwa_name", f"gva_{GVA_YEAR}_pounds_m",
                    "in_top60"])
        for rank, code, g in ranked:
            w.writerow([rank, code, name_by_code.get(code, ""), round(g, 1),
                        "Y" if rank <= TOP_N else "N"])
    print(f"  wrote {TOP60_CSV.name} (full ranked England-touching list)")

    # 4. Map each station to its TTWA by point-in-polygon, set flags.
    sj = json.load(open(STATIONS, encoding="utf-8"))
    matched = in60 = wellconn = 0
    no_freq_field = 0
    for feat in sj["features"]:
        lng, lat = feat["geometry"]["coordinates"]
        props = feat["properties"]
        found_code = None
        for code, (minx, miny, maxx, maxy), geom in polys:
            if minx <= lng <= maxx and miny <= lat <= maxy:
                if point_in_polygon(lng, lat, geom):
                    found_code = code
                    break
        if found_code:
            matched += 1
            rank = code_to_rank.get(found_code)
            props["ttwa_code"] = found_code
            props["ttwa_name"] = name_by_code.get(found_code)
            props["ttwa_gva_rank"] = rank
            props["ttwa_in_top60"] = bool(found_code in top60_codes)
            if found_code in top60_codes:
                in60 += 1
        else:
            props["ttwa_code"] = None
            props["ttwa_name"] = None
            props["ttwa_gva_rank"] = None
            props["ttwa_in_top60"] = False
        # well_connected = frequency limb AND ttwa limb
        mf = props.get("meets_frequency")
        if mf is None:
            no_freq_field += 1
        props["well_connected"] = bool(mf) and bool(props["ttwa_in_top60"])
        if props["well_connected"]:
            wellconn += 1

    json.dump(sj, open(STATIONS, "w", encoding="utf-8"))
    print(f"  stations matched to a TTWA: {matched}/{len(sj['features'])}")
    print(f"  stations in a top-60 TTWA: {in60}")
    if no_freq_field:
        print(f"  WARNING: {no_freq_field} stations had no meets_frequency "
              f"field — run build_station_usage.py first.")
    print(f"  WELL-CONNECTED (freq AND top-60 TTWA): {wellconn} stations")

    # Show the cutoff neighbourhood — the politically sensitive boundary.
    print("\n  --- TTWA GVA ranking around the top-60 cutoff ---")
    for rank, code, g in ranked:
        if 56 <= rank <= 64:
            mark = "  <-- cutoff" if rank == TOP_N else ""
            print(f"    {rank:>3}. {name_by_code.get(code,''):<28} "
                  f"£{g:>10,.0f}m{mark}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
