"""Load data/raw/station_links.csv into public.station_links (full refresh).

Direct scheduled station-to-station services parsed from the National Rail
CIF timetable by pipeline/build_connectivity_cif.py. Needs SUPABASE_URL +
SUPABASE_SERVICE_KEY env (repository secrets in CI).
"""

import csv
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "data" / "raw" / "station_links.csv"
BATCH = 2000


def req(url, key, method="POST", body=None, extra=None):
    headers = {
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }
    headers.update(extra or {})
    r = urllib.request.Request(url, method=method, headers=headers,
                               data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=180) as resp:
        return resp.status


def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY not set", file=sys.stderr)
        return 1
    if not SRC.exists():
        print(f"::warning::{SRC} not found — run build_connectivity_cif.py first")
        return 0

    rows = []
    with SRC.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            try:
                rows.append({
                    "crs_from": r["crs_from"], "crs_to": r["crs_to"],
                    "minutes": float(r["minutes"]) if r.get("minutes") else None,
                    "trains_day": int(r["trains_day"]) if r.get("trains_day") else None,
                })
            except (KeyError, ValueError):
                continue
    print(f"[links] {len(rows):,} rows parsed")

    # Full refresh: the timetable is a complete snapshot each time.
    req(f"{url}/rest/v1/station_links?crs_from=neq.__none__", key, method="DELETE")
    print("[links] cleared existing rows")
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        req(f"{url}/rest/v1/station_links", key, body=chunk,
            extra={"Prefer": "resolution=merge-duplicates,return=minimal"})
        if (i // BATCH) % 20 == 0:
            print(f"[links] {i + len(chunk):,}/{len(rows):,}")
    print("[links] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
