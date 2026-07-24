"""
build_ppd.py
------------
HM Land Registry Price Paid Data -> map_features dataset `ppd_sales`:
individual property transactions as points (postcode-centroid located, tiny
deterministic jitter so same-postcode sales don't stack), giving street-level
price granularity beneath the LSOA aggregates. Free, OGL-adjacent PPD licence
(address data must not be sub-licensed as a lookup product — we display
transactions, which is the intended use, with attribution).

Coverage: the last PPD_MONTHS months (default 12; ~800k sales/yr national).
Sources are HMLR's stable S3 site: pp-<year>.csv per calendar year.

Props per sale: price, date, ptype (D/S/T/F/O), newb (Y/N), tenure (F/L),
addr (PAON + street, trimmed). Geocoded via OS Code-Point Open (no key).
"""

import csv
import io
import json
import hashlib
import os
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

PPD_BASE = ("http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1"
            ".amazonaws.com/pp-{year}.csv")
CODEPOINT_URL = ("https://api.os.uk/downloads/v1/products/CodePointOpen/"
                 "downloads?area=GB&format=CSV&redirect")

MONTHS = int(os.environ.get("PPD_MONTHS", "12") or 12)


def load_postcodes():
    """postcode (no spaces, upper) -> (easting, northing) from Code-Point Open."""
    dest = RAW / "codepoint-open.zip"
    if not dest.exists():
        print("[codepoint] downloading OS Code-Point Open ...")
        urllib.request.urlretrieve(CODEPOINT_URL, dest)
    pcs = {}
    with zipfile.ZipFile(dest) as zf:
        members = [m for m in zf.namelist()
                   if m.lower().endswith(".csv") and "/csv/" in m.lower()]
        for m in members:
            with zf.open(m) as fh:
                for row in csv.reader(io.TextIOWrapper(fh, "utf-8", errors="ignore")):
                    if len(row) >= 4:
                        pc = row[0].replace(" ", "").upper()
                        try:
                            pcs[pc] = (float(row[2]), float(row[3]))
                        except ValueError:
                            continue
    print(f"[codepoint] {len(pcs):,} postcodes indexed")
    return pcs


def _jitter(sale_id):
    """Deterministic ±~15m offset from the sale id, so multiple sales at one
    postcode fan out instead of stacking on the centroid."""
    h = hashlib.md5(sale_id.encode()).digest()
    dx = (h[0] / 255 - 0.5) * 0.0004
    dy = (h[1] / 255 - 0.5) * 0.00025
    return dx, dy


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    today = date.today()
    cutoff_y, cutoff_m = today.year, today.month - MONTHS
    while cutoff_m <= 0:
        cutoff_m += 12
        cutoff_y -= 1
    cutoff = f"{cutoff_y:04d}-{cutoff_m:02d}"
    years = sorted({cutoff_y, today.year})
    print(f"[ppd] window: sales since {cutoff} (files: {years})")

    pcs = load_postcodes()
    try:
        from pyproj import Transformer
    except ImportError:
        print("ERROR: pyproj unavailable", file=sys.stderr)
        return 1
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    rows, seen, skipped_pc, skipped_cat = [], set(), 0, 0
    for year in years:
        url = PPD_BASE.format(year=year)
        dest = RAW / f"pp-{year}.csv"
        if not dest.exists():
            print(f"[ppd] downloading {url} ...")
            urllib.request.urlretrieve(url, dest)
        with dest.open(newline="", encoding="utf-8", errors="ignore") as fh:
            for r in csv.reader(fh):
                # id, price, date, postcode, type, new, duration, PAON, SAON,
                # street, locality, town, district, county, category, status
                if len(r) < 16:
                    continue
                d = r[2][:7]                      # YYYY-MM
                if d < cutoff:
                    continue
                if r[14] != "A":                  # standard price paid only
                    skipped_cat += 1
                    continue
                pc = r[3].replace(" ", "").upper()
                if pc not in pcs:
                    skipped_pc += 1
                    continue
                sid = r[0].strip("{}")
                if sid in seen:
                    continue
                seen.add(sid)
                e, n = pcs[pc]
                lon, lat = tr.transform(e, n)
                dx, dy = _jitter(sid)
                addr = " ".join(x for x in (r[7], r[9]) if x).title()[:60]
                props = {"price": int(r[1]), "date": r[2][:10], "ptype": r[4],
                         "newb": r[5], "tenure": r[6]}
                if addr:
                    props["addr"] = addr
                rows.append({
                    "dataset": "ppd_sales",
                    "source_id": sid,
                    "name": None,
                    "props": json.dumps(props, allow_nan=False),
                    "geom_wkt": f"SRID=4326;POINT({lon + dx:.6f} {lat + dy:.6f})",
                })
    print(f"[ppd] {len(rows):,} sales kept ({skipped_pc:,} unmatched postcodes, "
          f"{skipped_cat:,} non-standard category)")
    if not rows:
        print("ERROR: no sales in window", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name", "props", "geom_wkt"])
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows):,} rows to {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
