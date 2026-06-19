"""
loaders/load_gps.py
-------------------
Loads English GP practices into the Supabase `amenities` table (kind='gp').

This is the FIRST per-dataset loader — the pattern every future amenity loader
(pharmacies, schools, bus stops...) will copy: fetch source -> normalise to
{name, source_id, lng, lat, props} -> upsert into `amenities`. Each dataset has
its own loader and its own refresh schedule, so refreshing GPs never touches
IMD, rail, or anything else (the "per-dataset refresh, not monolithic rebuild"
goal).

Source data:
  - NHS ODS 'epraccur' — every GP practice in England with name, status, and
    POSTCODE (but no coordinates). OGL licensed.
  - We turn postcode -> lng/lat with a postcode centroid lookup. Two options,
    auto-detected:
      (a) a committed CSV at data/raw/postcodes.csv  (columns: postcode, lat,
          long) — the reliable, offline route (same "commit a CSV" trick used
          elsewhere in this project); OR
      (b) the free postcodes.io bulk API as a fallback when no CSV is present.

Environment (set as GitHub Action secrets, or export locally):
  SUPABASE_URL              e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY      the *service_role* key (writes bypass RLS) — keep secret

Run:
  python supabase/loaders/load_gps.py
"""

import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RAW = ROOT / "data" / "raw"
POSTCODES_CSV = RAW / "postcodes.csv"

# NHS ODS epraccur — the current GP practice file (zipped CSV, no header row).
# This is the long-standing stable download path on the TRUD/ODS distribution.
EPRACCUR_URL = "https://files.digital.nhs.uk/assets/ods/current/epraccur.zip"

# epraccur is headerless; these are the columns we care about by INDEX, per the
# ODS epraccur record spec. (0) org code, (1) name, (9) postcode,
# (12) status code: 'A' active / 'C' closed / 'D' dormant / 'P' proposed.
COL_CODE = 0
COL_NAME = 1
COL_POSTCODE = 9
COL_STATUS = 12

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 500   # rows per upsert request


def norm_pc(pc: str) -> str:
    """Normalise a postcode to uppercase, single internal space."""
    pc = (pc or "").upper().strip()
    pc = " ".join(pc.split())
    if " " not in pc and len(pc) > 3:
        pc = pc[:-3] + " " + pc[-3:]   # insert the conventional space
    return pc


def load_postcode_lookup(postcodes_needed: set) -> dict:
    """Return {postcode: (lng, lat)} for the postcodes we need.

    Prefer a committed CSV (offline, fast, reproducible). Fall back to the
    postcodes.io bulk API if no CSV is present.
    """
    lookup = {}

    if POSTCODES_CSV.exists():
        print(f"Using committed postcode CSV: {POSTCODES_CSV.name}")
        with POSTCODES_CSV.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            def col(row, *names):
                for n in names:
                    if n in row and row[n] not in (None, ""):
                        return row[n]
                return None
            for row in reader:
                pc = norm_pc(col(row, "postcode", "pcds", "Postcode") or "")
                lat = col(row, "lat", "latitude")
                lng = col(row, "long", "lng", "longitude")
                if not pc or lat is None or lng is None:
                    continue
                try:
                    lookup[pc] = (float(lng), float(lat))
                except ValueError:
                    continue
        print(f"  {len(lookup)} postcodes in lookup")
        return lookup

    # Fallback: postcodes.io bulk endpoint (max 100 per request).
    print("No postcode CSV found — geocoding via postcodes.io (slower).")
    pcs = [p for p in postcodes_needed if p]
    for i in range(0, len(pcs), 100):
        chunk = pcs[i:i + 100]
        body = json.dumps({"postcodes": chunk}).encode("utf-8")
        req = urllib.request.Request(
            "https://api.postcodes.io/postcodes",
            data=body,
            headers={"Content-Type": "application/json",
                     "User-Agent": "mastermapper-loader/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            print(f"  postcodes.io chunk {i} failed: {exc}")
            continue
        for item in data.get("result", []):
            r = item.get("result")
            if not r:
                continue
            pc = norm_pc(item.get("query", ""))
            if r.get("longitude") is not None and r.get("latitude") is not None:
                lookup[pc] = (r["longitude"], r["latitude"])
        time.sleep(0.3)   # be polite to the free API
        print(f"  geocoded {len(lookup)} / {len(pcs)}...")
    return lookup


def fetch_epraccur_rows() -> list:
    """Download epraccur.zip and return its CSV rows (list of lists)."""
    print(f"Downloading {EPRACCUR_URL} ...")
    req = urllib.request.Request(EPRACCUR_URL, headers={"User-Agent": "mastermapper-loader/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        blob = resp.read()
    zf = zipfile.ZipFile(io.BytesIO(blob))
    # The archive contains a single CSV (epraccur.csv).
    csv_name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    text = zf.read(csv_name).decode("latin-1")   # ODS files are latin-1
    rows = list(csv.reader(io.StringIO(text)))
    print(f"  {len(rows)} practice records")
    return rows


def upsert(records: list):
    """Upsert records into Supabase via PostgREST (on_conflict kind,source_id)."""
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.")
        sys.exit(1)

    url = (f"{SUPABASE_URL}/rest/v1/amenities"
           "?on_conflict=kind,source_id")
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        # merge-duplicates = upsert; return minimal to keep responses small.
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    total = 0
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        body = json.dumps(batch).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp.read()
            total += len(batch)
            print(f"  upserted {total} / {len(records)}")
        except urllib.error.HTTPError as exc:
            print(f"  batch {i} failed: {exc.code} {exc.read().decode('utf-8', 'replace')[:500]}")
            sys.exit(1)
    print(f"Done: upserted {total} GP practices.")


def main() -> int:
    rows = fetch_epraccur_rows()

    # Keep ACTIVE English practices (codes beginning with a letter; status 'A').
    active = []
    for r in rows:
        if len(r) <= COL_STATUS:
            continue
        if (r[COL_STATUS] or "").strip().upper() != "A":
            continue
        active.append(r)
    print(f"  {len(active)} active practices")

    needed = {norm_pc(r[COL_POSTCODE]) for r in active}
    lookup = load_postcode_lookup(needed)

    records, missing = [], 0
    for r in active:
        pc = norm_pc(r[COL_POSTCODE])
        coord = lookup.get(pc)
        if not coord:
            missing += 1
            continue
        lng, lat = coord
        records.append({
            "kind": "gp",
            "source_id": r[COL_CODE].strip(),
            "name": (r[COL_NAME] or "").strip().title(),
            "props": {"postcode": pc},
            # PostgREST accepts GeoJSON for a geography column.
            "geom": {"type": "Point", "coordinates": [lng, lat]},
        })
    print(f"  {len(records)} geocoded, {missing} unmatched postcodes")

    if not records:
        print("Nothing to upsert (no geocoded practices). Aborting.")
        return 1
    upsert(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
