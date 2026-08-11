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

EPC floor areas (optional, transforms the £/m² heatmap from estimate to
measurement): with EPC_EMAIL + EPC_API_KEY set (free account at
https://epc.opendatacommunities.org/), the full domestic-certificates bulk
file is streamed and each sale is address-matched to its latest certificate
— normalised SAON+PAON+street against EPC ADDRESS1(+ADDRESS2), within the
postcode. Matched sales gain m2 (TOTAL_FLOOR_AREA) and ppm2r (price ÷ m2);
rebuild_price_grid() then prefers real medians over the type-mix estimate.
"""

import base64
import csv
import io
import json
import hashlib
import os
import re
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
# NOTE the path: bulk files are served under /files/ (with API Basic auth
# accepted); /api/v1/files is a JSON LISTING endpoint — requesting a filename
# under it returns an empty 200, which is how the 2026-08-11 run produced a
# 0-byte "zip" and died. Docs: guides.opendatacommunities.org article 40.
EPC_BULK_URL = os.environ.get(
    "EPC_BULK_URL",
    "https://epc.opendatacommunities.org/files/"
    "all-domestic-certificates.zip")

# 36 months is the product now: the price layers advertise "last 3 years" and
# the trend metric compares the last 12 months against the prior 24, so a
# shorter default would silently hollow out both.
MONTHS = int(os.environ.get("PPD_MONTHS", "36") or 36)


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


def _akey(*parts):
    """Normalise address fragments into one comparable token: uppercase
    alphanumerics only, so 'Flat 1, 12 High Street' == SAON 'FLAT 1' +
    PAON '12' + street 'HIGH STREET'."""
    return re.sub(r"[^A-Z0-9]", "", " ".join(p for p in parts if p).upper())


def epc_floor_areas(sales):
    """Address-match sales to EPC certificates -> {sale index: floor m²}.

    Streams the national bulk zip (several GB — kept on disk, read member by
    member, never extracted) and keeps only certificates whose normalised
    address key is one a sale actually needs, so memory stays ~the sales
    list. Latest lodgement wins per address. Returns {} when no credentials
    are configured."""
    email = os.environ.get("EPC_EMAIL", "").strip()
    key = os.environ.get("EPC_API_KEY", "").strip()
    if not email or not key:
        print("[epc] EPC_EMAIL / EPC_API_KEY not set — £/m² stays a type-mix "
              "estimate (docs/MANUAL_TASKS.md 5c)")
        return {}

    # Which (postcode, addr-key) pairs do we actually need? A flat only
    # matches its full SAON+PAON key (the bare building key would borrow a
    # neighbour's floor area); a house matches PAON+street or bare PAON.
    needed = {}                      # key -> [sale indices]
    pcs_needed = set()
    for i, s in enumerate(sales):
        pc = s["_pc"]
        pcs_needed.add(pc)
        variants = ([_akey(s["_saon"], s["_paon"], s["_street"]),
                     _akey(s["_saon"], s["_paon"])] if s["_saon"]
                    else [_akey(s["_paon"], s["_street"]), _akey(s["_paon"])])
        for v in variants:
            if v:
                needed.setdefault(pc + "|" + v, []).append(i)

    dest = RAW / "epc-all-domestic.zip"
    if not dest.exists() or dest.stat().st_size < 1e8:
        auth = base64.b64encode(f"{email}:{key}".encode()).decode()
        req = urllib.request.Request(
            EPC_BULK_URL, headers={"Authorization": f"Basic {auth}",
                                   "Accept": "application/zip"})
        print(f"[epc] downloading bulk certificates (several GB) ...")
        try:
            with urllib.request.urlopen(req, timeout=1800) as r, \
                 open(dest, "wb") as fh:
                got = 0
                while True:
                    chunk = r.read(1 << 22)
                    if not chunk:
                        break
                    fh.write(chunk)
                    got += len(chunk)
                    if got % (1 << 29) < (1 << 22):
                        print(f"[epc]   {got / 1e9:.1f} GB ...")
        except Exception as exc:
            print(f"[epc] WARNING: bulk download failed ({exc}) — check the "
                  "account/key; continuing without floor areas")
            dest.unlink(missing_ok=True)
            return {}
        print(f"[epc]   -> {dest.stat().st_size / 1e9:.2f} GB")
        # The real archive is ~5 GB. A small 200 response is an error page or
        # an empty body from a wrong endpoint — never a zip. Degrade, don't die.
        if dest.stat().st_size < 1e8:
            head = dest.read_bytes()[:200]
            print(f"[epc] WARNING: response too small to be the bulk archive "
                  f"({dest.stat().st_size} bytes; starts {head!r}) — check "
                  "EPC_BULK_URL/credentials; continuing without floor areas")
            dest.unlink(missing_ok=True)
            return {}

    best = {}                        # key -> (lodgement_date, area)
    scanned = 0
    # A corrupt or truncated archive must degrade to the type-mix estimate,
    # not take the whole PPD build (and the sales load behind it) down.
    try:
        zf_test = zipfile.ZipFile(dest)
    except zipfile.BadZipFile:
        print("[epc] WARNING: downloaded file is not a valid zip — deleting "
              "and continuing without floor areas")
        dest.unlink(missing_ok=True)
        return {}
    with zf_test as zf:
        members = [m for m in zf.namelist()
                   if m.lower().endswith("certificates.csv")]
        print(f"[epc] scanning {len(members)} authority files ...")
        for m in members:
            with zf.open(m) as fh:
                for row in csv.DictReader(
                        io.TextIOWrapper(fh, "utf-8", errors="ignore")):
                    scanned += 1
                    pc = (row.get("POSTCODE") or "").replace(" ", "").upper()
                    if pc not in pcs_needed:
                        continue
                    try:
                        area = float(row.get("TOTAL_FLOOR_AREA") or 0)
                    except ValueError:
                        continue
                    if not 15 <= area <= 600:
                        continue
                    lodged = (row.get("LODGEMENT_DATE")
                              or row.get("LODGEMENT_DATETIME") or "")[:10]
                    a1 = row.get("ADDRESS1") or ""
                    a2 = row.get("ADDRESS2") or ""
                    for k in {_akey(a1), _akey(a1, a2)}:
                        if not k:
                            continue
                        kk = pc + "|" + k
                        if kk in needed and lodged >= best.get(kk, ("",))[0]:
                            best[kk] = (lodged, area)
    print(f"[epc] {scanned:,} certificates scanned, "
          f"{len(best):,} address keys matched")

    out = {}
    for i, s in enumerate(sales):
        pc = s["_pc"]
        variants = ([_akey(s["_saon"], s["_paon"], s["_street"]),
                     _akey(s["_saon"], s["_paon"])] if s["_saon"]
                    else [_akey(s["_paon"], s["_street"]), _akey(s["_paon"])])
        for v in variants:
            hit = best.get(pc + "|" + v)
            if hit:
                out[i] = hit[1]
                break
    print(f"[epc] {len(out):,}/{len(sales):,} sales matched a floor area "
          f"({100 * len(out) / max(1, len(sales)):.0f}%)")
    return out


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
    # EVERY year from cutoff to now. This was sorted({cutoff_y, today.year}),
    # which downloads only the two endpoint files — a 36-month window fetched
    # pp-2023 and pp-2026 and silently skipped 2024 and 2025 entirely, so a
    # third of the "3-year" comparables never existed. The hole was invisible:
    # nothing failed, the layer just had less data than it claimed.
    years = list(range(cutoff_y, today.year + 1))
    print(f"[ppd] window: sales since {cutoff} (files: {years})")

    pcs = load_postcodes()
    try:
        from pyproj import Transformer
    except ImportError:
        print("ERROR: pyproj unavailable", file=sys.stderr)
        return 1
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    sales, seen, skipped_pc, skipped_cat = [], set(), 0, 0
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
                sales.append({"sid": sid, "price": int(r[1]),
                              "date": r[2][:10], "ptype": r[4], "newb": r[5],
                              "tenure": r[6], "_pc": pc, "_paon": r[7],
                              "_saon": r[8], "_street": r[9]})
    print(f"[ppd] {len(sales):,} sales kept ({skipped_pc:,} unmatched "
          f"postcodes, {skipped_cat:,} non-standard category)")
    if not sales:
        print("ERROR: no sales in window", file=sys.stderr)
        return 1

    areas = epc_floor_areas(sales)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for i, s in enumerate(sales):
            e, n = pcs[s["_pc"]]
            lon, lat = tr.transform(e, n)
            dx, dy = _jitter(s["sid"])
            addr = " ".join(x for x in (s["_paon"], s["_street"]) if x) \
                .title()[:60]
            props = {"price": s["price"], "date": s["date"],
                     "ptype": s["ptype"], "newb": s["newb"],
                     "tenure": s["tenure"]}
            if addr:
                props["addr"] = addr
            m2 = areas.get(i)
            if m2:
                ppm2 = s["price"] / m2
                if 300 <= ppm2 <= 30000:          # junk-match guard
                    props["m2"] = round(m2, 1)
                    props["ppm2r"] = round(ppm2)
            w.writerow({
                "dataset": "ppd_sales",
                "source_id": s["sid"],
                "name": None,
                "props": json.dumps(props, allow_nan=False),
                "geom_wkt": f"SRID=4326;POINT({lon + dx:.6f} {lat + dy:.6f})",
            })
    print(f"Wrote {len(sales):,} rows to {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
