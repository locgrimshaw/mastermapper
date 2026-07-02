"""
loaders/load_constraints.py
---------------------------
Loads the station developable-land constraint polygons into the Supabase
`public.planning_constraints` table (kinds: built_land, green_space, transport,
flood_zone_2, flood_zone_3, green_belt).

It mirrors loaders/load_gps.py: read a prepared import file, normalise to the
table's columns, and upsert in batches via PostgREST. The only real difference
is the geometry — here it's a polygon layer, sent as the same SRID-tagged EWKT
text that load_gps.py uses for points ('SRID=4326;MULTIPOLYGON(...)'). PostgREST
parses EWKT straight into the geometry column.

Input (built by pipeline/build_constraints.py, in CI or locally):
  supabase/constraints_import.csv
    columns: kind, source_id, name, props (JSON string), geom_wkt (EWKT)

Environment (provided automatically by the GitHub Action from repo Secrets —
see .github/workflows/load-constraints.yml; you don't set these by hand):
  SUPABASE_URL          e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY  the *service_role* key (writes bypass RLS) — secret

The upsert conflict target is (kind, source_id), matching the partial unique
index in migration 0005, so re-runs update existing rows instead of duplicating.

How to run it: you don't run it locally. In GitHub, go to the Actions tab, pick
"Load constraints into Supabase", and click Run workflow. (It can also be run
from a command line with the two env vars set, if you ever want to.)
"""

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
IMPORT_CSV = ROOT / "supabase" / "constraints_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 500   # rows per upsert request

# CSV can carry very long WKT fields (polygon rings) — lift the field-size cap.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def read_records(path: Path) -> list:
    """Read constraints_import.csv into upsert-ready dicts. Rows without a
    geometry are skipped (nothing to store)."""
    if not path.exists():
        print(f"ERROR: import file not found: {path}")
        print("Run pipeline/build_constraints.py first (it writes this CSV).")
        return []

    records, skipped = [], 0
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            geom = (row.get("geom_wkt") or "").strip()
            kind = (row.get("kind") or "").strip()
            if not geom or not kind:
                skipped += 1
                continue

            # props is stored as a JSON string in the CSV; send it as an object.
            props_raw = (row.get("props") or "").strip()
            try:
                props = json.loads(props_raw) if props_raw else {}
            except json.JSONDecodeError:
                props = {}

            source_id = (row.get("source_id") or "").strip()
            rec = {
                "kind": kind,
                # PostgREST needs the conflict key present; null is allowed but
                # then the row can't upsert-merge, so keep whatever the builder
                # gave (it always fills a stable id).
                "source_id": source_id or None,
                "name": (row.get("name") or "").strip() or None,
                "props": props,
                # EWKT text -> geometry(MultiPolygon,4326), exactly like the
                # point loader sends 'SRID=4326;POINT(...)'.
                "geom": geom,
            }
            records.append(rec)
    if skipped:
        print(f"  skipped {skipped} row(s) with no geometry/kind")
    return records


def upsert(records: list):
    """Upsert records into Supabase via PostgREST (on_conflict kind,source_id).

    Resilient: if a batch fails, it reports the reason and keeps going, so one
    hiccup doesn't throw away the whole run. Exits non-zero only if nothing at
    all loaded."""
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.")
        sys.exit(1)

    url = (f"{SUPABASE_URL}/rest/v1/planning_constraints"
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
            with urllib.request.urlopen(req, timeout=180) as resp:
                resp.read()
            total += len(batch)
            print(f"  upserted {total} / {len(records)}")
        except urllib.error.HTTPError as exc:
            failed += len(batch)
            detail = exc.read().decode("utf-8", "replace")[:500]
            print(f"  batch starting {i} failed: HTTP {exc.code} {detail}")
            # Keep going — a later batch may be fine, and partial load beats none.
        except urllib.error.URLError as exc:
            failed += len(batch)
            print(f"  batch starting {i} failed: {exc}")
    if total == 0:
        print("Nothing loaded — every batch failed. See the error above.")
        sys.exit(1)
    print(f"Done: upserted {total} constraint polygons"
          + (f" ({failed} failed)." if failed else "."))


def main() -> int:
    records = read_records(IMPORT_CSV)
    if not records:
        print("Nothing to upsert. Aborting.")
        return 1

    # Per-kind tally so the log shows what went in.
    by_kind = {}
    for r in records:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    print(f"Loaded {len(records)} rows from {IMPORT_CSV.name}:")
    for kind in sorted(by_kind):
        print(f"    {kind:14s} {by_kind[kind]}")

    upsert(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
