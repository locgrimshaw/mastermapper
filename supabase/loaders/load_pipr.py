"""
loaders/load_pipr.py
--------------------
Loads the two ONS Price Index of Private Rents tables built by
pipeline/build_pipr.py:

  supabase/pipr_rents_import.csv   -> public.pipr_rents   (latest month levels)
  supabase/pipr_series_import.csv  -> public.pipr_series  (monthly history)

Both are full REPLACEMENTS: every existing row is deleted before the upsert,
because an area that ONS stops publishing (a local-government reorganisation
retires a district, say) must disappear rather than linger at a stale level
that still looks current. The tables are small — ~350 and ~3,100 rows — so a
clean delete-and-reload costs nothing and removes a whole class of silent
staleness.

Environment (supplied by .github/workflows/build-pipr.yml from repo Secrets):
  SUPABASE_URL          e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY  the *service_role* key (writes bypass RLS) — secret

How to run it: you don't run it locally. In GitHub, Actions tab, pick
"Build ONS private rents (PIPR)", Run workflow.
"""

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RENTS_CSV = ROOT / "supabase" / "pipr_rents_import.csv"
SERIES_CSV = ROOT / "supabase" / "pipr_series_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 400
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

INT_COLS = {"rent", "b1", "b2", "b3", "b4", "det", "semi", "terr", "flat"}
FLOAT_COLS = {"chg"}


def _headers(prefer="resolution=merge-duplicates,return=minimal"):
    return {"apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": prefer}


def _request(method, url, body=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or _headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _num(v, kind):
    v = (v or "").strip()
    if v == "":
        return None
    try:
        return int(float(v)) if kind is int else float(v)
    except ValueError:
        return None


def read_rents():
    out = []
    with RENTS_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("code") or "").strip()
            if not code:
                continue
            rec = {"code": code,
                   "name": (row.get("name") or "").strip() or code,
                   "region": (row.get("region") or "").strip() or None,
                   "asof": (row.get("asof") or "").strip()}
            for c in INT_COLS:
                rec[c] = _num(row.get(c), int)
            for c in FLOAT_COLS:
                rec[c] = _num(row.get(c), float)
            out.append(rec)
    return out


def read_series():
    """The rent/chg arrays arrive as JSON text and go up as JSON arrays;
    PostgREST maps a JSON array straight onto a Postgres array column."""
    out = []
    with SERIES_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("code") or "").strip()
            series = (row.get("series") or "").strip()
            if not code or not series:
                continue
            try:
                rents = json.loads(row.get("rents") or "[]")
                chg = json.loads(row.get("chg") or "[]")
            except json.JSONDecodeError:
                continue
            if not rents:
                continue
            out.append({"code": code, "series": series,
                        "first_period": (row.get("first_period") or "").strip(),
                        "rents": rents, "chg": chg or None})
    return out


def clear(table):
    """Delete every row. `code=neq.` matches all rows with a non-null code,
    which is every row (code is part of the primary key)."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?code=neq.__none__"
    for attempt in range(1, 5):
        try:
            _request("DELETE", url, headers=_headers("return=minimal"))
            print(f"  cleared {table}")
            return True
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            detail = (exc.read().decode("utf-8", "replace")[:300]
                      if isinstance(exc, urllib.error.HTTPError) else "")
            print(f"  delete attempt {attempt} on {table} failed: {exc}{detail}")
            time.sleep(2 ** attempt)
    return False


def upsert(table, records, on_conflict):
    url = (f"{SUPABASE_URL}/rest/v1/{table}"
           f"?on_conflict={urllib.parse.quote(on_conflict)}")
    done = 0
    for i in range(0, len(records), BATCH):
        chunk = records[i:i + BATCH]
        body = json.dumps(chunk).encode("utf-8")
        for attempt in range(1, 5):
            try:
                _request("POST", url, body)
                done += len(chunk)
                break
            except (urllib.error.HTTPError, urllib.error.URLError) as exc:
                detail = (exc.read().decode("utf-8", "replace")[:400]
                          if isinstance(exc, urllib.error.HTTPError) else "")
                print(f"  batch {i//BATCH + 1} attempt {attempt} failed: "
                      f"{exc}{detail}")
                if attempt == 4:
                    return done
                time.sleep(2 ** attempt)
    return done


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        return 1
    for p in (RENTS_CSV, SERIES_CSV):
        if not p.exists():
            print(f"ERROR: {p} not found — run pipeline/build_pipr.py first")
            return 1

    rents, series = read_rents(), read_series()
    print(f"read {len(rents)} rent rows, {len(series)} series rows")
    if not rents or not series:
        print("ERROR: refusing to clear the tables for an empty import")
        return 1

    for table, records, conflict in (("pipr_rents", rents, "code"),
                                     ("pipr_series", series, "code,series")):
        if not clear(table):
            print(f"ERROR: could not clear {table}; aborting so stale rows "
                  "are not mixed with new ones")
            return 1
        n = upsert(table, records, conflict)
        print(f"  upserted {n}/{len(records)} into {table}")
        if n != len(records):
            return 1

    asof = rents[0].get("asof")
    print(f"done — PIPR data month {asof}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
