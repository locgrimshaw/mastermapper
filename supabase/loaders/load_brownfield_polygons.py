"""
loaders/load_brownfield_polygons.py
-----------------------------------
Populates POLYGON boundaries in the `public.brownfield` table from two prepared
import CSVs, so brownfield sites render as real footprints instead of markers
(the frontend already draws them when the RPC returns area_geojson).

It mirrors loaders/load_gps.py and loaders/load_constraints.py: read a prepared
CSV, normalise to the table's columns, and talk to Supabase via PostgREST with
per-batch/per-row error handling so one hiccup never throws away the whole run.

TWO FEEDS, TWO WRITE MODES
--------------------------
PART A — supabase/brownfield_site_import.csv  (built by
         pipeline/build_brownfield_site_csv.py):
    NEW rows from planning.data.gov.uk `brownfield-site` (distinct references,
    almost all in London). UPSERTED on (organisation, reference) via a batched
    PostgREST POST with `Prefer: resolution=merge-duplicates`. geom + area are
    sent as SRID-tagged EWKT text, exactly like the point/constraint loaders —
    PostgREST parses EWKT straight into the geography columns. Because these are
    distinct references, they add to the table without clobbering the 35,892
    point-register rows.

PART B — supabase/brownfield_inspire_import.csv  (built by
         pipeline/build_brownfield_inspire.py):
    UPDATES of the `area` column only, for EXISTING brownfield-land points that
    were matched to a Land Registry INSPIRE parcel. Applied as one PostgREST
    PATCH per (organisation, reference) row (filtered update of `area`). PATCH —
    not upsert — because these rows already exist and `geom` is NOT NULL: a
    merge-duplicates upsert carrying only reference/organisation/area would try
    to INSERT a geom-less row for any non-matching key and fail the NOT NULL
    constraint. A filtered PATCH only ever touches rows that already exist.

    ⚠️  INSPIRE LICENCE CAVEAT: INSPIRE-derived boundaries contain Ordnance
    Survey data (© Crown copyright and database rights) under the Land Registry
    INSPIRE end-user licence, which restricts republication. See
    pipeline/build_brownfield_inspire.py and docs/DATASETS.md before publishing.

Environment (provided automatically by the GitHub Action from repo Secrets —
see .github/workflows/load-brownfield-polygons.yml; you don't set these by hand):
  SUPABASE_URL          e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY  the *service_role* key (writes bypass RLS) — secret

The upsert conflict target is (organisation, reference), matching the unique
index brownfield_org_ref_key in migration 0004, so re-runs update in place.

How to run it: you don't run it locally. In GitHub, go to the Actions tab, pick
"Load brownfield polygons into Supabase", and click Run workflow. (It can also
be run from a command line with the two env vars set.)
"""

import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SITE_CSV = ROOT / "supabase" / "brownfield_site_import.csv"
INSPIRE_CSV = ROOT / "supabase" / "brownfield_inspire_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 500   # rows per upsert request

# CSV can carry very long WKT fields (polygon rings) — lift the field-size cap.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def _num(v):
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if s == "" or s.lower() in ("n/a", "na", "none", "null", "nan"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _int(v):
    f = _num(v)
    return None if f is None else int(round(f))


def _text(v):
    s = (v or "").strip()
    return s or None


def _bool(v):
    s = (v or "").strip().lower()
    if s in ("true", "t", "1", "yes", "y"):
        return True
    if s in ("false", "f", "0", "no", "n"):
        return False
    return None


def _date(v):
    s = (v or "").strip()
    # The builders already normalise dates; accept only YYYY-MM-DD, else null so
    # the date column never rejects a batch on one bad value.
    return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None


def read_site_records(path: Path) -> list:
    """Read brownfield_site_import.csv into upsert-ready dicts for the brownfield
    table. Rows without a point geometry are skipped (geom is NOT NULL)."""
    if not path.exists():
        print(f"  PART A: {path.name} not present — skipping site upsert.")
        return []

    records, skipped = [], 0
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            geom = (row.get("geom_wkt") or "").strip()
            ref = (row.get("reference") or "").strip()
            if not geom or not ref:
                skipped += 1
                continue
            area = (row.get("area_wkt") or "").strip()
            records.append({
                "reference": ref,
                "entity": _int(row.get("entity")),
                "organisation": _text(row.get("organisation")),
                "name": _text(row.get("name")),
                "site_address": _text(row.get("site_address")),
                "hectares": _num(row.get("hectares")),
                "dwellings_min": _int(row.get("dwellings_min")),
                "dwellings_max": _int(row.get("dwellings_max")),
                "ownership_status": _text(row.get("ownership_status")),
                "is_public": _bool(row.get("is_public")),
                "deliverable": _text(row.get("deliverable")),
                "permission_status": _text(row.get("permission_status")),
                "permission_date": _date(row.get("permission_date")),
                "notes": _text(row.get("notes")),
                "source_url": _text(row.get("source_url")),
                # EWKT text -> geography columns, like the point/constraint loaders.
                "geom": geom,
                "area": area or None,
            })
    if skipped:
        print(f"  PART A: skipped {skipped} row(s) with no point/reference")
    return records


def upsert_sites(records: list) -> int:
    """Batched upsert of new brownfield-site rows on (organisation, reference).
    Returns the number of rows successfully sent. Resilient per batch."""
    url = (f"{SUPABASE_URL}/rest/v1/brownfield"
           "?on_conflict=organisation,reference")
    headers = _headers()
    total, failed = 0, 0
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        body = json.dumps(batch).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                resp.read()
            total += len(batch)
            print(f"  PART A: upserted {total} / {len(records)}")
        except urllib.error.HTTPError as exc:
            failed += len(batch)
            detail = exc.read().decode("utf-8", "replace")[:500]
            print(f"  PART A: batch starting {i} failed: HTTP {exc.code} {detail}")
        except urllib.error.URLError as exc:
            failed += len(batch)
            print(f"  PART A: batch starting {i} failed: {exc}")
    print(f"  PART A: upserted {total} brownfield-site rows"
          + (f" ({failed} failed)." if failed else "."))
    return total


def read_inspire_records(path: Path) -> list:
    """Read brownfield_inspire_import.csv into {reference, organisation, area}
    dicts. Rows without an area are skipped (nothing to update)."""
    if not path.exists():
        print(f"  PART B: {path.name} not present — skipping INSPIRE updates.")
        return []

    records, skipped = [], 0
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            area = (row.get("area_wkt") or "").strip()
            ref = (row.get("reference") or "").strip()
            if not area or not ref:
                skipped += 1
                continue
            records.append({
                "reference": ref,
                "organisation": (row.get("organisation") or "").strip(),
                "area": area,
            })
    if skipped:
        print(f"  PART B: skipped {skipped} row(s) with no area/reference")
    return records


def patch_inspire(records: list) -> int:
    """Apply INSPIRE boundaries as filtered PATCHes of the `area` column on
    existing (organisation, reference) rows. One request per row; resilient.
    Returns the number of rows successfully patched."""
    headers = _headers()
    total, failed = 0, 0
    for n, rec in enumerate(records, 1):
        # Filter the exact row(s): organisation=eq.<org>&reference=eq.<ref>.
        # eq. filter values must be URL-encoded (references contain spaces etc).
        org = urllib.parse.quote(rec["organisation"], safe="")
        ref = urllib.parse.quote(rec["reference"], safe="")
        url = (f"{SUPABASE_URL}/rest/v1/brownfield"
               f"?organisation=eq.{org}&reference=eq.{ref}")
        body = json.dumps({"area": rec["area"]}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="PATCH")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp.read()
            total += 1
        except urllib.error.HTTPError as exc:
            failed += 1
            detail = exc.read().decode("utf-8", "replace")[:300]
            print(f"  PART B: PATCH {rec['organisation']}/{rec['reference']} "
                  f"failed: HTTP {exc.code} {detail}")
        except urllib.error.URLError as exc:
            failed += 1
            print(f"  PART B: PATCH {rec['organisation']}/{rec['reference']} "
                  f"failed: {exc}")
        if n % 200 == 0:
            print(f"  PART B: patched {total} / {len(records)}")
    print(f"  PART B: patched {total} INSPIRE boundaries"
          + (f" ({failed} failed)." if failed else "."))
    return total


def main() -> int:
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.")
        return 1

    site_records = read_site_records(SITE_CSV)
    inspire_records = read_inspire_records(INSPIRE_CSV)

    if not site_records and not inspire_records:
        print("Nothing to load: neither import CSV had usable rows. Run the "
              "build scripts first.")
        return 1

    loaded_a = upsert_sites(site_records) if site_records else 0
    loaded_b = patch_inspire(inspire_records) if inspire_records else 0

    if loaded_a == 0 and loaded_b == 0:
        print("Nothing loaded — every request failed. See the errors above.")
        return 1
    print(f"Done: {loaded_a} brownfield-site rows upserted, "
          f"{loaded_b} INSPIRE boundaries patched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
