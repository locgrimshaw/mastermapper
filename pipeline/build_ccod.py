"""
build_ccod.py
-------------
Council-owned property from HM Land Registry's CCOD dataset ("UK companies
that own property in England and Wales"), for the map_features dataset
`la_property`.

REQUIRES the CCOD_API_KEY env var (a GitHub Actions secret): an API key from
a registered account at https://use-land-property-data.service.gov.uk/ with
the CCOD licence accepted. The raw file is licence-restricted — it is only
ever downloaded inside the workflow run, never committed.

Phase 1 (this script): download the latest CCOD full file via the service's
API, keep titles whose proprietor is a local authority (proprietorship
category "Local Authority"/"County Council", or a proprietor name that reads
as a council), geocode by POSTCODE using OS Code-Point Open (free, no key),
and aggregate to one point per (postcode, proprietor) with a title count.
Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
— loaded by supabase/loaders/load_datasets.py with DATASETS=la_property.

Phase 2 (later): join title numbers to HMLR INSPIRE index polygons for true
parcel outlines.

Licence: contains HM Land Registry data © Crown copyright and database right
2026, licensed under the CCOD licence; postcode locations via OS Code-Point
Open (OGL). Positions are postcode centroids — indicative, not boundaries.
"""

import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

API_BASE = "https://use-land-property-data.service.gov.uk/api/v1"
CODEPOINT_URL = ("https://api.os.uk/downloads/v1/products/CodePointOpen/"
                 "downloads?area=GB&format=CSV&redirect")

LA_CATEGORY = re.compile(r"local authority|county council", re.I)
LA_NAME = re.compile(
    r"\b(BOROUGH|COUNTY|CITY|DISTRICT|TOWN|PARISH)?\s*COUNCIL\b|"
    r"\bCOMMON COUNCIL\b|\bGREATER LONDON AUTHORITY\b", re.I)


def _api(path, key):
    req = urllib.request.Request(API_BASE + path,
                                 headers={"Authorization": key,
                                          "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def _walk_strings(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_strings(v)
    elif isinstance(obj, str):
        yield obj


def discover_ccod(key):
    """Find the latest CCOD full-file name, then its signed download URL.
    The API's exact response shape has drifted between versions, so walk the
    JSON for the patterns we need rather than assuming a schema."""
    meta = _api("/datasets/ccod", key)
    names = [s for s in _walk_strings(meta)
             if re.match(r"CCOD_FULL_\d{4}_\d{2}\.zip$", s.strip())]
    if not names:
        names = [s for s in _walk_strings(meta) if "CCOD_FULL" in s and s.endswith(".zip")]
    if not names:
        print("ERROR: no CCOD_FULL file name in /datasets/ccod response. Keys:",
              list(meta)[:8], file=sys.stderr)
        sys.exit(1)
    fname = sorted(set(names))[-1]
    print(f"[ccod] latest full file: {fname}")
    link_meta = _api(f"/datasets/ccod/{fname}", key)
    urls = [s for s in _walk_strings(link_meta) if s.startswith("http")]
    if not urls:
        print("ERROR: no download URL in file response. Keys:",
              list(link_meta)[:8], file=sys.stderr)
        sys.exit(1)
    return fname, urls[0]


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


def main():
    key = os.environ.get("CCOD_API_KEY", "").strip()
    if not key:
        print("::warning::CCOD_API_KEY not set — skipping the CCOD build. Add "
              "it as a repository secret (an API key from "
              "use-land-property-data.service.gov.uk).")
        return 0

    RAW.mkdir(parents=True, exist_ok=True)
    fname, url = discover_ccod(key)
    ccod_zip = RAW / "ccod_full.zip"
    print(f"[ccod] downloading {fname} (~400 MB) ...")
    urllib.request.urlretrieve(url, ccod_zip)

    pcs = load_postcodes()
    try:
        from pyproj import Transformer
    except ImportError:
        print("ERROR: pyproj unavailable", file=sys.stderr)
        return 1
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    # Stream the CCOD CSV; keep LA-owned titles; aggregate per (postcode,
    # proprietor). The header names the columns; find the ones we need.
    agg = {}
    kept = seen = 0
    with zipfile.ZipFile(ccod_zip) as zf:
        member = next(m for m in zf.namelist() if m.lower().endswith(".csv"))
        with zf.open(member) as fh:
            rd = csv.reader(io.TextIOWrapper(fh, "utf-8-sig", errors="ignore"))
            header = next(rd)
            low = [h.strip().lower() for h in header]

            def col(pattern):
                return [i for i, h in enumerate(low) if re.search(pattern, h)]

            i_addr = (col(r"property address") or [None])[0]
            i_pc = (col(r"^postcode") or col(r"postcode") or [None])[0]
            i_names = col(r"proprietor name")
            i_cats = col(r"proprietorship category")
            if i_pc is None or not i_names:
                print("ERROR: unexpected CCOD columns:", header[:12],
                      file=sys.stderr)
                return 1
            for row in rd:
                seen += 1
                if len(row) <= i_pc:
                    continue
                is_la, prop_name, prop_cat = False, None, None
                for i_n, i_c in zip(i_names, i_cats + [None] * len(i_names)):
                    nm = row[i_n].strip() if i_n < len(row) else ""
                    ct = row[i_c].strip() if i_c is not None and i_c < len(row) else ""
                    if not nm:
                        continue
                    if LA_CATEGORY.search(ct) or LA_NAME.search(nm):
                        is_la, prop_name, prop_cat = True, nm, ct
                        break
                if not is_la:
                    continue
                pc = row[i_pc].replace(" ", "").upper()
                if pc not in pcs:
                    continue
                kept += 1
                k = (pc, prop_name.upper())
                a = agg.setdefault(k, {"n": 0, "name": prop_name,
                                       "category": prop_cat, "postcode": row[i_pc],
                                       "address": None})
                a["n"] += 1
                if a["address"] is None and i_addr is not None and i_addr < len(row):
                    a["address"] = row[i_addr][:160]
    print(f"[ccod] {seen:,} titles scanned, {kept:,} LA-owned with a mappable "
          f"postcode, {len(agg):,} aggregated points")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for (pc, _), a in agg.items():
            e, n = pcs[pc]
            lon, lat = tr.transform(e, n)
            props = {k: v for k, v in (("titles", a["n"]),
                                       ("category", a["category"]),
                                       ("postcode", a["postcode"]),
                                       ("address", a["address"])) if v}
            w.writerow({
                "dataset": "la_property",
                "source_id": f"{pc}-{re.sub(r'[^A-Z0-9]+', '', a['name'].upper())[:40]}",
                "name": a["name"],
                "props": json.dumps(props, separators=(",", ":"), ensure_ascii=False),
                "geom_wkt": f"SRID=4326;POINT({lon:.6f} {lat:.6f})",
            })
    print(f"[ccod] wrote {OUT} ({OUT.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
