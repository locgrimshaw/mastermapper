"""
pipeline/build_voa_offices.py
-----------------------------
VOA rating list (England & Wales) -> map_features dataset `voa_offices`:
one point per OFFICE hereditament with its floor area, rateable value and
derived rent in £/m²/year.

Why this is the office-rent evidence base: a rateable value is the VOA's
statutory assessment of the open-market annual rent of that specific
building at the antecedent valuation date (2026 list = 1 April 2024
rents), assessed per building by professional valuers and republished
weekly as open data under OGL. It is the only free national source of
BUILDING-LEVEL office rents — commercial platforms (CoStar, Realyse etc.)
are licensed. Caveats carried into the UI: values are AVD-dated (not
today's asking rents) and understate brand-new Grade A space, which is why
the office calculator applies an editable Grade-A adjustment on top of the
local median.

Source: VOA "summary valuations" full-list baseline (~150 MB zip, ~2M
hereditaments), star-delimited fixed records. Record type 01 carries
everything needed: UARN, address, postcode, special category (SCat),
total floor area, total value and unit of measure. SCat 203 and 723 are
both "Offices And Premises" (~430k records between them). Geocoded to
postcode centroids via OS Code-Point Open (free, no key), with the same
deterministic ±15 m jitter as ppd_sales so offices sharing a postcode fan
out instead of stacking.

The newest baseline URL is discovered from the VOA downloads page at run
time, so the scheduled workflow keeps tracking new epochs (and the 2029
list, eventually) without edits. Overrides for local runs:
  VOA_SMV_ZIP  path to an already-downloaded summary-valuations zip
  CODEPOINT_ZIP path to an already-downloaded Code-Point Open zip

Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
loaded by supabase/loaders/load_datasets.py with DATASETS=voa_offices
(.github/workflows/load-voa-offices.yml).

Data: Crown copyright VOA / OS, Open Government Licence v3.
"""

import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

VOA_PAGE = "https://voaratinglists.blob.core.windows.net/html/rlidata.htm"
CODEPOINT_URL = ("https://api.os.uk/downloads/v1/products/CodePointOpen/"
                 "downloads?area=GB&format=CSV&redirect")

# "Offices And Premises" special categories. 203 is the ordinary office
# SCat; 723 is its non-standard-valuation twin — both describe themselves
# identically in the list and together they are the VOA office sector.
OFFICE_SCATS = {"203", "723"}

# Sanity bounds on the derived £/m². Outside these the record is almost
# certainly a data artefact (a token £1 RV, an area of 0.5 m², a car park
# miscoded) and one bad comp can drag a small-sample median.
PM2_MIN, PM2_MAX = 20, 3000
AREA_MIN_M2 = 15


def smv_zip_url():
    """Find the newest full-list summary-valuations baseline on the VOA
    downloads page (highest list year wins; the page keeps 2010-2026)."""
    with urllib.request.urlopen(VOA_PAGE, timeout=120) as resp:
        html = resp.read().decode("utf-8", "replace")
    links = re.findall(
        r'href="(https://[^"]+ndr-(\d{4})-summaryvaluations-compiled-'
        r'epoch-\d+-baseline-csv\.zip)"', html)
    if not links:
        raise RuntimeError("no summary-valuations baseline link on VOA page")
    return max(links, key=lambda t: t[1])[0]


def load_postcodes():
    """postcode (no spaces, upper) -> (easting, northing) from Code-Point Open."""
    dest = Path(os.environ.get("CODEPOINT_ZIP") or (RAW / "codepoint-open.zip"))
    if not dest.exists():
        print("[codepoint] downloading OS Code-Point Open ...")
        dest.parent.mkdir(parents=True, exist_ok=True)
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


def _jitter(uarn):
    """Deterministic ±~15m offset from the UARN, so offices sharing a
    postcode fan out instead of stacking on the centroid."""
    h = hashlib.md5(uarn.encode()).digest()
    dx = (h[0] / 255 - 0.5) * 0.0004
    dy = (h[1] / 255 - 0.5) * 0.00025
    return dx, dy


def _addr(fields):
    """Short display address from the 01-record address lines (5-9) + town."""
    parts = [p.strip() for p in fields[5:10] if p.strip()]
    town = fields[11].strip()
    s = ", ".join(parts[:2] + ([town] if town else []))
    return s.title()[:70]


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)

    zpath = os.environ.get("VOA_SMV_ZIP")
    if zpath:
        zpath = Path(zpath)
    else:
        url = smv_zip_url()
        print(f"[voa] downloading {url.rsplit('/', 1)[-1]} ...")
        zpath = RAW / "voa-smv.zip"
        urllib.request.urlretrieve(url, zpath)

    pcs = load_postcodes()
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    rows, seen = [], set()
    n01 = n_office = skipped_pc = skipped_junk = 0
    with zipfile.ZipFile(zpath) as zf:
        member = max(zf.namelist(), key=lambda m: zf.getinfo(m).file_size)
        with zf.open(member) as fh:
            for line in io.TextIOWrapper(fh, "utf-8", errors="ignore"):
                if not line.startswith("01*"):
                    continue
                n01 += 1
                f = line.rstrip("\n").split("*")
                # 01 record: 1 UARN, 5-9 address, 11 town, 13 postcode,
                # 16 total area m², 18 total value, 19 adopted RV,
                # 21 billing authority, 26 SCat, 27 unit of measure.
                if len(f) < 29 or f[26] not in OFFICE_SCATS:
                    continue
                n_office += 1
                pc = f[13].replace(" ", "").upper()
                if pc not in pcs:
                    skipped_pc += 1
                    continue
                try:
                    area = float(f[16])
                    value = float(f[18])
                except ValueError:
                    skipped_junk += 1
                    continue
                if area < AREA_MIN_M2 or value <= 0:
                    skipped_junk += 1
                    continue
                pm2 = value / area
                if not (PM2_MIN <= pm2 <= PM2_MAX):
                    skipped_junk += 1
                    continue
                uarn = f[1].strip()
                if not uarn or uarn in seen:
                    continue
                seen.add(uarn)
                e, n = pcs[pc]
                lon, lat = tr.transform(e, n)
                dx, dy = _jitter(uarn)
                props = {"pc": f[13].strip(), "m2": round(area),
                         "rv": round(value), "pm2": round(pm2),
                         "unit": f[27].strip() or None,
                         "ba": f[21].strip() or None}
                rows.append({
                    "dataset": "voa_offices",
                    "source_id": uarn,
                    "name": _addr(f) or None,
                    "props": json.dumps(props, allow_nan=False),
                    "geom_wkt": f"SRID=4326;POINT({lon + dx:.6f} {lat + dy:.6f})",
                })

    print(f"[voa] {n01:,} hereditaments scanned, {n_office:,} offices, "
          f"{len(rows):,} kept ({skipped_pc:,} unmatched postcodes, "
          f"{skipped_junk:,} failed sanity checks)")
    if len(rows) < 100000:
        # A partial parse must never delete-and-replace a good dataset.
        print("ERROR: implausibly few offices — refusing to write", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows):,} rows to {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
