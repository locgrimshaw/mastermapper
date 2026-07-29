"""
loaders/load_datasets.py
------------------------
Loads the generic map overlay datasets into the Supabase `public.map_features`
table (dataset, source_id, name, props jsonb, geom geometry(Geometry,4326),
PK (dataset, source_id)). The frontend reads them back via the
`features_in_bbox` RPC.

It mirrors loaders/load_constraints.py: read a prepared import file, normalise
to the table's columns, and upsert in batches via PostgREST. Geometry is sent
as SRID-tagged EWKT text ('SRID=4326;MULTIPOLYGON(...)' / 'SRID=4326;POINT(...)'),
which PostgREST parses straight into the geometry column.

One difference from the constraints loader: before upserting, existing rows
for each dataset being loaded are DELETED, so a re-run fully REPLACES that
dataset instead of accreting stale features whose source ids changed. The
DATASETS env var (comma list, blank = all) restricts both the delete and the
upsert to a subset of datasets, matching the builder's --datasets.

Input (built by pipeline/build_datasets.py, in CI or locally):
  supabase/datasets_import.csv
    columns: dataset, source_id, name, props (JSON string), geom_wkt (EWKT)

Environment (provided automatically by the GitHub Action from repo Secrets —
see .github/workflows/load-datasets.yml; you don't set these by hand):
  SUPABASE_URL          e.g. https://abcd.supabase.co
  SUPABASE_SERVICE_KEY  the *service_role* key (writes bypass RLS) — secret
  DATASETS              optional comma list restricting which datasets load

How to run it: you don't run it locally. In GitHub, go to the Actions tab,
pick "Load datasets into Supabase", and click Run workflow. (It can also be
run from a command line with the env vars set, if you ever want to.)
"""

import csv
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
IMPORT_CSV = ROOT / "supabase" / "datasets_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 500   # rows per upsert request

# CSV can carry very long WKT fields (polygon rings) — lift the field-size cap.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _clean_json(v):
    """NaN/Infinity are valid to Python's json module but NOT valid JSON —
    pandas-built props carry them for any empty numeric cell, and PostgREST
    rejects the entire batch (PGRST102 'Empty or invalid json') over a single
    NaN token. Scrub them to null, recursively."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _clean_json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean_json(x) for x in v]
    return v


def _wanted_datasets():
    """The DATASETS env var as a set, or None for 'all'."""
    raw = os.environ.get("DATASETS", "").strip()
    if not raw:
        return None
    return {d.strip() for d in raw.replace(",", " ").split() if d.strip()}


def _headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        # merge-duplicates = upsert; return minimal to keep responses small.
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def read_records(path: Path, wanted) -> list:
    """Read datasets_import.csv into upsert-ready dicts. Rows without a
    geometry are skipped (nothing to store); rows outside the DATASETS
    filter are skipped too."""
    if not path.exists():
        print(f"ERROR: import file not found: {path}")
        print("Run pipeline/build_datasets.py first (it writes this CSV).")
        return []

    records, skipped, filtered = [], 0, 0
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            geom = (row.get("geom_wkt") or "").strip()
            dataset = (row.get("dataset") or "").strip()
            if not geom or not dataset:
                skipped += 1
                continue
            if wanted is not None and dataset not in wanted:
                filtered += 1
                continue

            # props is stored as a JSON string in the CSV; send it as an object.
            props_raw = (row.get("props") or "").strip()
            try:
                props = _clean_json(json.loads(props_raw)) if props_raw else {}
            except json.JSONDecodeError:
                props = {}

            source_id = (row.get("source_id") or "").strip()
            records.append({
                "dataset": dataset,
                # (dataset, source_id) is the primary key — the builder always
                # fills a stable id, but keep None-safety anyway.
                "source_id": source_id or None,
                "name": (row.get("name") or "").strip() or None,
                "props": props,
                # EWKT text -> geometry(Geometry,4326), exactly like the
                # constraints loader sends 'SRID=4326;MULTIPOLYGON(...)'.
                "geom": geom,
            })
    if skipped:
        print(f"  skipped {skipped} row(s) with no geometry/dataset")
    if filtered:
        print(f"  filtered out {filtered} row(s) not in DATASETS")

    # Belt-and-braces: collapse duplicate (dataset, source_id) pairs (keeping
    # the last), so a single upsert batch never asks ON CONFLICT to touch the
    # same row twice (Postgres 21000).
    deduped, by_key, dupes = [], {}, 0
    for rec in records:
        key = (rec["dataset"], rec.get("source_id"))
        if rec.get("source_id") is None:
            deduped.append(rec)          # null id can't upsert-conflict; keep all
            continue
        if key in by_key:
            deduped[by_key[key]] = rec   # replace earlier occurrence
            dupes += 1
        else:
            by_key[key] = len(deduped)
            deduped.append(rec)
    if dupes:
        print(f"  collapsed {dupes} duplicate (dataset, source_id) row(s)")
    return deduped


def count_dataset(dataset: str):
    """How many rows the table currently holds for one dataset (None if the
    count can't be read)."""
    url = (f"{SUPABASE_URL}/rest/v1/map_features"
           f"?dataset=eq.{urllib.parse.quote(dataset)}&select=dataset&limit=1")
    headers = dict(_headers())
    headers["Prefer"] = "count=exact"
    headers["Range-Unit"] = "items"
    headers["Range"] = "0-0"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp.read()
            # content-range comes back as "0-0/12345" (or "*/12345" when empty)
            cr = resp.headers.get("content-range") or ""
        total = cr.split("/")[-1]
        return int(total) if total.isdigit() else None
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
        return None


def delete_dataset(dataset: str) -> bool:
    """DELETE every existing row for one dataset, so the upsert fully replaces
    it (stale features whose source ids changed don't linger).

    This USED to be best-effort: one DELETE, and on failure a warning and
    carry on, on the theory that the upsert overwrites every current key
    anyway. That reasoning is wrong whenever a re-run produces FEWER rows than
    before — the surplus old rows keep their old keys, are never overwritten,
    and silently mix into the new data. It happened: a corrected public_parcel
    run wrote 112,650 good rows on top of 93,214 stale ones from a superseded
    run, and the dataset looked plausible while being 45% wrong.

    So now: retry, verify the dataset is actually empty afterwards, and return
    False only when it genuinely isn't — main() turns that into a hard failure
    rather than a warning nobody reads."""
    url = (f"{SUPABASE_URL}/rest/v1/map_features"
           f"?dataset=eq.{urllib.parse.quote(dataset)}")
    for attempt in range(1, 5):
        try:
            req = urllib.request.Request(url, headers=_headers(), method="DELETE")
            with urllib.request.urlopen(req, timeout=600) as resp:
                resp.read()
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            detail = ""
            if isinstance(exc, urllib.error.HTTPError):
                detail = " " + exc.read().decode("utf-8", "replace")[:300]
            print(f"  delete attempt {attempt} for '{dataset}' failed: "
                  f"{exc}{detail}")
        left = count_dataset(dataset)
        if left == 0:
            print(f"  cleared existing rows for dataset '{dataset}'")
            return True
        if left is None:
            print(f"  WARNING: could not verify '{dataset}' is empty after the "
                  "delete; assuming it is not.")
        else:
            print(f"  {left:,} row(s) still present for '{dataset}' after "
                  f"attempt {attempt}")
    return False


def upsert(records: list):
    """Upsert records into Supabase via PostgREST (on_conflict dataset,source_id).

    Resilient: if a batch fails, it reports the reason and keeps going, so one
    hiccup doesn't throw away the whole run. Exits non-zero only if nothing at
    all loaded."""
    url = (f"{SUPABASE_URL}/rest/v1/map_features"
           "?on_conflict=dataset,source_id")
    headers = _headers()
    total, failed = 0, 0
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        # allow_nan=False turns any NaN that slipped past _clean_json into a
        # loud local error instead of a silent 400 for the whole batch.
        body = json.dumps(batch, allow_nan=False).encode("utf-8")
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
    print(f"Done: upserted {total} map features"
          + (f" ({failed} failed)." if failed else "."))


def main() -> int:
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.")
        return 1

    wanted = _wanted_datasets()
    records = read_records(IMPORT_CSV, wanted)
    if not records:
        print("Nothing to upsert. Aborting.")
        return 1

    # Per-dataset tally so the log shows what went in.
    by_dataset = {}
    for r in records:
        by_dataset[r["dataset"]] = by_dataset.get(r["dataset"], 0) + 1
    print(f"Loaded {len(records)} rows from {IMPORT_CSV.name}:")
    for dataset in sorted(by_dataset):
        print(f"    {dataset:20s} {by_dataset[dataset]}")

    # Full replace by default: clear each dataset present in the CSV (and the
    # DATASETS filter) before upserting its fresh rows. LOAD_MODE=append skips
    # the delete — used for datasets built up incrementally across runs (the
    # per-LA INSPIRE parcel ingests), where a delete would wipe earlier LAs.
    if os.environ.get("LOAD_MODE", "replace").strip().lower() == "append":
        print("LOAD_MODE=append — existing rows kept; matching keys refreshed.")
    else:
        print("Clearing datasets being reloaded ...")
        undeleted = [d for d in sorted(by_dataset) if not delete_dataset(d)]
        if undeleted:
            # Loading fresh rows on top of rows that should have gone produces
            # a dataset that looks fine and is partly stale. Refuse: the CSV is
            # kept as a workflow artifact, so re-loading after clearing by hand
            # costs nothing, whereas silently-wrong ownership data is expensive.
            print(f"::error::Could not clear {', '.join(undeleted)} — refusing "
                  "to upsert on top of rows that should have been replaced. "
                  "Delete them (in batches if the table is large) and re-run "
                  "the load against the import CSV artifact.")
            return 1

    upsert(records)

    # Stamp the freshness ledger (best-effort — a failed stamp never fails
    # the load): dataset -> loaded_at + row count in public.dataset_meta.
    for dataset in sorted(by_dataset):
        try:
            import datetime as _dt
            body = json.dumps([{"dataset": dataset,
                                "n_rows": by_dataset[dataset],
                                "loaded_at": _dt.datetime.now(
                                    _dt.timezone.utc).isoformat()}]).encode()
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/dataset_meta",
                data=body, method="POST",
                headers={"apikey": SUPABASE_KEY,
                         "Authorization": f"Bearer {SUPABASE_KEY}",
                         "Content-Type": "application/json",
                         "Prefer": "resolution=merge-duplicates"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp.read()
        except Exception as exc:
            print(f"  note: freshness stamp for '{dataset}' failed ({exc})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
