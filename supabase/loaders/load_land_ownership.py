"""
loaders/load_land_ownership.py
------------------------------
Load public-body land-ownership polygons into public.land_ownership (for the
"Public land ownership" map overlay). Reads supabase/land_ownership_import.csv
(body, owner_name, geom_wkt EWKT) built by pipeline/build_land_ownership.py.

Idempotent: for each body present in the CSV it first DELETEs that body's rows,
then bulk-inserts — so re-running refreshes cleanly (the table has a serial PK,
no natural conflict key).

Env (from the workflow Secrets): SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role).
"""

import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
IMPORT_CSV = ROOT / "supabase" / "land_ownership_import.csv"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
BATCH = 200
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def read_records(path: Path):
    if not path.exists():
        print(f"ERROR: import file not found: {path}\nRun pipeline/build_land_ownership.py first.")
        return []
    recs = []
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            geom = (row.get("geom_wkt") or "").strip()
            body = (row.get("body") or "").strip()
            if not geom or not body:
                continue
            recs.append({"body": body, "owner_name": (row.get("owner_name") or "").strip() or None,
                         "geom": geom})
    return recs


def delete_body(body: str):
    url = f"{SUPABASE_URL}/rest/v1/land_ownership?body=eq.{urllib.parse.quote(body)}"
    req = urllib.request.Request(url, headers=_headers({"Prefer": "return=minimal"}), method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp.read()
        print(f"  cleared existing rows for body={body}")
    except urllib.error.HTTPError as exc:
        print(f"  delete {body} failed: HTTP {exc.code} {exc.read().decode('utf-8','replace')[:300]}")


def insert(records):
    url = f"{SUPABASE_URL}/rest/v1/land_ownership"
    headers = _headers({"Prefer": "return=minimal"})
    total, failed = 0, 0
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        req = urllib.request.Request(url, data=json.dumps(batch).encode("utf-8"),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                resp.read()
            total += len(batch)
            print(f"  inserted {total} / {len(records)}")
        except urllib.error.HTTPError as exc:
            failed += len(batch)
            print(f"  batch {i} failed: HTTP {exc.code} {exc.read().decode('utf-8','replace')[:300]}")
        except urllib.error.URLError as exc:
            failed += len(batch)
            print(f"  batch {i} failed: {exc}")
    if total == 0:
        print("Nothing loaded — every batch failed."); sys.exit(1)
    print(f"Done: inserted {total} land-ownership polygons" + (f" ({failed} failed)." if failed else "."))


def main() -> int:
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY."); return 1
    records = read_records(IMPORT_CSV)
    if not records:
        print("Nothing to load."); return 1
    bodies = sorted({r["body"] for r in records})
    print(f"Loading {len(records)} rows for bodies: {', '.join(bodies)}")
    for b in bodies:
        delete_body(b)
    insert(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
