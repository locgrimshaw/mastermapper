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

Environment (provided automatically by the GitHub Action from repo Secrets —
see docs/DEEP_DIVE_SETUP.md; you don't set these by hand):
  SUPABASE_URL              e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY      the *service_role* key (writes bypass RLS) — secret

How to run it: you don't run it locally. In GitHub, go to the Actions tab,
pick "Load amenities into Supabase", and click Run workflow. That executes this
script on GitHub's servers with your secrets. (It can also be run from a command
line with the two env vars set, if you ever want to.)
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

# NHS ODS 'epraccur' — current GP practice file.
#
# NOTE (June 2026): NHS retired the old files.digital.nhs.uk/.../epraccur.zip
# snapshot. The live replacement is the ODS Data Search & Export (DSE)
# "predefined report" endpoint below, which returns a plain CSV (not a zip).
# DSE replicates the legacy epraccur column layout. The file may or may not
# carry a header row depending on the report settings, so the parser below
# AUTO-DETECTS: it finds columns by header name when present, and otherwise
# falls back to the legacy fixed positions.
#
# If you prefer not to rely on this endpoint at all, you can instead download
# the CSV in your browser, commit it to data/raw/epraccur.csv, and the loader
# will use that local file (see fetch_epraccur_rows). That mirrors the
# "commit a CSV" approach used elsewhere in this project.
EPRACCUR_URL = "https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=epraccur"
EPRACCUR_LOCAL = RAW / "epraccur.csv"

# Legacy fixed column positions (used when the file has no header row):
# (0) org code, (1) name, (9) postcode, (12) status: 'A' active.
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
    failed_chunks = 0
    for i in range(0, len(pcs), 100):
        chunk = pcs[i:i + 100]
        body = json.dumps({"postcodes": chunk}).encode("utf-8")

        # Try each chunk a few times with a short backoff — the free API can
        # briefly rate-limit or hiccup, and we'd rather wait than lose a chunk.
        data = None
        for attempt in range(4):
            req = urllib.request.Request(
                "https://api.postcodes.io/postcodes",
                data=body,
                headers={"Content-Type": "application/json",
                         "User-Agent": "mastermapper-loader/1.0"},
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except (urllib.error.URLError, urllib.error.HTTPError) as exc:
                wait = 1.5 * (attempt + 1)
                print(f"  postcodes.io chunk {i} attempt {attempt + 1} failed "
                      f"({exc}); retrying in {wait:.0f}s")
                time.sleep(wait)
        if data is None:
            failed_chunks += 1
            print(f"  giving up on chunk {i} after retries")
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
    if failed_chunks:
        print(f"  WARNING: {failed_chunks} postcode chunk(s) failed; some "
              f"practices may be missing. Re-running the loader will retry.")
    return lookup


def _parse_epraccur_bytes(blob: bytes, looks_zip: bool) -> list:
    """Turn raw bytes (CSV or legacy zip) into normalised dict rows with keys
    code, name, postcode, status. Auto-detects a header row; otherwise uses the
    legacy fixed column positions."""
    if looks_zip:
        zf = zipfile.ZipFile(io.BytesIO(blob))
        csv_name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        text = zf.read(csv_name).decode("latin-1")
    else:
        # ODS files are latin-1; fall back to utf-8 if that struggles.
        try:
            text = blob.decode("latin-1")
        except UnicodeDecodeError:
            text = blob.decode("utf-8", "replace")

    raw = list(csv.reader(io.StringIO(text)))
    if not raw:
        return []

    # Header detection: a header row has non-numeric, label-like first cells and
    # known column names. epraccur data rows start with an org code like 'A81001'
    # (letter + digits). If the first row's first cell looks like a code, there's
    # no header and we use fixed positions.
    first = raw[0]
    header_like = any(
        h.strip().lower() in (
            "organisation code", "name", "postcode", "status code",
            "practice code", "organisationcode"
        ) for h in first
    )

    rows = []
    if header_like:
        hdr = [h.strip().lower() for h in first]

        def idx(*names, default=None):
            for n in names:
                if n in hdr:
                    return hdr.index(n)
            return default

        i_code = idx("organisation code", "organisationcode", "practice code", default=COL_CODE)
        i_name = idx("name", default=COL_NAME)
        i_pc = idx("postcode", default=COL_POSTCODE)
        i_status = idx("status code", "status", default=COL_STATUS)
        for r in raw[1:]:
            if len(r) <= max(i_code, i_name, i_pc, i_status):
                continue
            rows.append({
                "code": r[i_code], "name": r[i_name],
                "postcode": r[i_pc], "status": r[i_status],
            })
    else:
        for r in raw:
            if len(r) <= COL_STATUS:
                continue
            rows.append({
                "code": r[COL_CODE], "name": r[COL_NAME],
                "postcode": r[COL_POSTCODE], "status": r[COL_STATUS],
            })
    return rows


def fetch_epraccur_rows() -> list:
    """Return normalised GP practice rows.

    Order of preference:
      1. A committed local CSV at data/raw/epraccur.csv (download it in your
         browser once, commit it — no live dependency).
      2. The live ODS DSE endpoint (plain CSV). Sent with browser-like headers
         because the host 403s bare requests.
    """
    if EPRACCUR_LOCAL.exists():
        print(f"Using committed GP file: {EPRACCUR_LOCAL.name}")
        blob = EPRACCUR_LOCAL.read_bytes()
        rows = _parse_epraccur_bytes(blob, looks_zip=False)
        print(f"  {len(rows)} practice records")
        return rows

    print(f"Downloading {EPRACCUR_URL} ...")
    # A plain urllib User-Agent gets a 403 from this host; mimic a browser.
    req = urllib.request.Request(EPRACCUR_URL, headers={
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0 Safari/537.36"),
        "Accept": "text/csv,application/octet-stream,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            blob = resp.read()
    except urllib.error.HTTPError as exc:
        print(f"  Download failed: HTTP {exc.code}. The NHS endpoint may have "
              f"changed or be blocking automated access.")
        print(f"  WORKAROUND: open this URL in your browser, save the CSV, and "
              f"commit it as data/raw/epraccur.csv, then re-run:")
        print(f"    {EPRACCUR_URL}")
        raise

    looks_zip = blob[:2] == b"PK"   # zip magic number
    rows = _parse_epraccur_bytes(blob, looks_zip=looks_zip)
    print(f"  {len(rows)} practice records")
    return rows


def upsert(records: list):
    """Upsert records into Supabase via PostgREST (on_conflict kind,source_id).

    Resilient: if a batch fails, it reports the reason and keeps going, so one
    hiccup doesn't throw away the whole (slow) run. Exits non-zero only if
    nothing at all loaded."""
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
    total, failed = 0, 0
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
            failed += len(batch)
            detail = exc.read().decode("utf-8", "replace")[:500]
            print(f"  batch starting {i} failed: HTTP {exc.code} {detail}")
            # Keep going — a later batch may be fine, and partial load beats none.
    if total == 0:
        print("Nothing loaded — every batch failed. See the error above.")
        sys.exit(1)
    print(f"Done: upserted {total} GP practices"
          + (f" ({failed} failed)." if failed else "."))


def main() -> int:
    rows = fetch_epraccur_rows()

    # Keep ACTIVE practices. The new DSE file spells the status as the word
    # "ACTIVE"/"INACTIVE" (index 12); the legacy file used a single letter
    # 'A'/'C'/'D'/'P'. Accept either form.
    def is_active(r):
        s = (r.get("status") or "").strip().upper()
        return s == "ACTIVE" or s == "A"
    active = [r for r in rows if is_active(r)]
    print(f"  {len(active)} active practices")
    if not active:
        print("  No active practices parsed — the file format may have changed.")
        print("  Check data/raw/epraccur.csv or the DSE report columns.")
        return 1

    needed = {norm_pc(r["postcode"]) for r in active}
    lookup = load_postcode_lookup(needed)

    records, missing = [], 0
    for r in active:
        pc = norm_pc(r["postcode"])
        coord = lookup.get(pc)
        if not coord:
            missing += 1
            continue
        lng, lat = coord
        records.append({
            "kind": "gp",
            "source_id": (r["code"] or "").strip(),
            "name": (r["name"] or "").strip().title(),
            "props": {"postcode": pc},
            # Send the point as EWKT (SRID-tagged Well-Known Text). PostGIS
            # parses this directly into a geography column via PostgREST; a
            # raw GeoJSON object is NOT accepted here and triggers
            # "parse error - invalid geometry".
            "geom": f"SRID=4326;POINT({lng} {lat})",
        })
    print(f"  {len(records)} geocoded, {missing} unmatched postcodes")

    if not records:
        print("Nothing to upsert (no geocoded practices). Aborting.")
        return 1
    upsert(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())