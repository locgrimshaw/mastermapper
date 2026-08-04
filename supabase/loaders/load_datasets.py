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
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
IMPORT_CSV = ROOT / "supabase" / "datasets_import.csv"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

BATCH = 500   # max rows per upsert request
# ...and a payload cap, because rows are not the same size. A dissolved
# national road corridor is hundreds of kB while a point is ~200 bytes;
# batching purely by row count produced a request large enough for
# Postgres to cancel on statement timeout (57014). 4 MB keeps the work
# per request roughly constant whatever the geometry.
MAX_BATCH_BYTES = int(os.environ.get("MAX_BATCH_BYTES") or 4_000_000)

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
    # CHUNKED, because a single DELETE over a large dataset cannot finish inside
    # the statement timeout. building_height is 1.5M rows and timed out four
    # times running on 2026-08-01; the loader then aborted with 22 other
    # datasets already cleared and none reloaded. delete_dataset_chunk
    # (migration 0041) bounds each statement so any size clears eventually.
    if _delete_in_chunks(dataset):
        print(f"  cleared existing rows for dataset '{dataset}'")
        return True

    # Fall back to the old unbounded delete if the RPC is unavailable (an older
    # database that has not had migration 0041 applied).
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


def _delete_in_chunks(dataset: str, chunk: int = 50000) -> bool:
    """Clear a dataset via the bounded-delete RPC. True once it is empty."""
    body = json.dumps({"p_dataset": dataset, "p_limit": chunk}).encode()
    removed = 0
    while True:
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/rpc/delete_dataset_chunk",
                data=body, method="POST",
                headers={**_headers(), "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as resp:
                n = int((resp.read() or b"0").decode("utf-8", "replace").strip() or 0)
        except Exception as exc:
            if removed:
                print(f"  chunked delete of '{dataset}' stopped after "
                      f"{removed:,} row(s): {exc}")
            return False
        removed += n
        if n == 0:
            return count_dataset(dataset) == 0
        if removed % 500000 < chunk:
            print(f"    cleared {removed:,} row(s) of '{dataset}' so far",
                  flush=True)


def _batches(records, max_rows, max_bytes):
    """Yield (start_index, rows, body) batches capped by BOTH row count and
    encoded payload size, because rows vary by orders of magnitude and a fixed
    row count turns into a request Postgres cancels on statement timeout.

    allow_nan=False turns any NaN that slipped past _clean_json into a loud
    local error instead of a silent 400 for the whole batch."""
    start, rows, size = 0, [], 0
    for idx, rec in enumerate(records):
        enc = json.dumps(rec, allow_nan=False)
        if rows and (len(rows) >= max_rows or size + len(enc) > max_bytes):
            yield start, rows, ("[" + ",".join(rows) + "]").encode("utf-8")
            start, rows, size = idx, [], 0
        rows.append(enc)
        size += len(enc)
    if rows:
        yield start, rows, ("[" + ",".join(rows) + "]").encode("utf-8")


def _post_with_retry(url, body, headers, attempts=5):
    """POST a batch, retrying transient failures with exponential backoff.

    Returns (True, "") or (False, reason). A momentary Cloudflare 520/521 in
    front of Supabase was enough to fail every batch of a long build inside a
    minute; 5xx and connection errors are transient by definition and deserve
    a wait. 4xx is our own bad request, so those fail immediately."""
    delay = 4
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers,
                                         method="POST")
            with urllib.request.urlopen(req, timeout=180) as resp:
                resp.read()
            return True, ""
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code < 500:
                return False, f"HTTP {exc.code} {detail}"
            why = f"HTTP {exc.code} {detail}"
        except urllib.error.URLError as exc:
            why = str(exc)
        if attempt == attempts:
            return False, f"{why} (after {attempts} attempts)"
        print(f"    transient failure ({why}); retrying in {delay}s "
              f"[{attempt}/{attempts - 1}]")
        time.sleep(delay)
        delay = min(delay * 2, 60)
    return False, "unreachable"


def upsert(records: list, label: str = "") -> tuple:
    """Upsert records into Supabase via PostgREST (on_conflict dataset,source_id).

    Resilient: if a batch fails, it reports the reason and keeps going, so one
    hiccup doesn't throw away the whole run. Returns (loaded, failed) — the
    CALLER decides what a total failure means, because for a per-dataset load
    the other datasets must still get their turn."""
    url = (f"{SUPABASE_URL}/rest/v1/map_features"
           "?on_conflict=dataset,source_id")
    headers = _headers()
    total, failed = 0, 0
    for i, rows, body in _batches(records, BATCH, MAX_BATCH_BYTES):
        ok, why = _post_with_retry(url, body, headers)
        if ok:
            total += len(rows)
            print(f"  upserted {total} / {len(records)}{label}")
        else:
            failed += len(rows)
            print(f"  batch starting {i} ({len(rows)} rows, "
                  f"{len(body) / 1e6:.1f} MB) failed: {why}")
            # Keep going — a later batch may be fine, and partial load beats none.
    return total, failed


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

    append = os.environ.get("LOAD_MODE", "replace").strip().lower() == "append"
    if append:
        # Used by loads built up across runs (the per-LA INSPIRE parcel
        # ingests), where a delete would wipe earlier LAs.
        print("LOAD_MODE=append — existing rows kept; matching keys refreshed.")

    # ONE DATASET AT A TIME: clear it, then immediately load it.
    #
    # This used to clear EVERY dataset first and upsert afterwards, and refuse
    # to upsert at all if any clear had failed. On 2026-08-01 the delete of
    # building_height (1.5M rows) hit the statement timeout, and that single
    # failure aborted the run with 22 already-cleared datasets — universities,
    # substations, PTAL, TPO zones, boundaries — deleted and never reloaded.
    # The guard was meant to stop a dataset going half-stale; instead it turned
    # one dataset's timeout into total loss of twenty-two others.
    #
    # Per-dataset, a failure can only ever affect its own dataset: the clear
    # and the load are adjacent, and every other dataset still gets its turn.
    # Refusing to upsert onto rows that should have gone is still right — that
    # is what produced a 45%-wrong public_parcel once — but it is now a
    # per-dataset decision, not a kill switch for the whole run.
    total_loaded, total_failed = 0, 0
    skipped, partial = [], []
    for dataset in sorted(by_dataset):
        rows = [r for r in records if r["dataset"] == dataset]
        if not append:
            if not delete_dataset(dataset):
                # Left alone deliberately: the OLD rows are still there, so the
                # layer keeps working with stale data rather than emptying.
                print(f"::warning::Could not clear '{dataset}' — skipping its "
                      f"{len(rows):,} new row(s) rather than mixing them into "
                      "rows that should have been replaced. Its existing data "
                      "is untouched; other datasets continue.")
                skipped.append(dataset)
                continue
        print(f"  loading {dataset} ({len(rows):,} rows) ...")
        loaded, failed = upsert(rows, f"  [{dataset}]")
        total_loaded += loaded
        total_failed += failed
        if failed:
            partial.append(f"{dataset} ({failed:,} row(s) failed)")

    print(f"Done: upserted {total_loaded:,} map features"
          + (f" ({total_failed:,} failed)." if total_failed else "."))
    if partial:
        print(f"::warning::Partially loaded: {', '.join(partial)}")
    if skipped:
        print(f"::error::Could not clear, so NOT reloaded: {', '.join(skipped)}. "
              "Their previous rows are still in place. Re-run the load for just "
              "those datasets (DATASETS=...) against the import CSV artifact.")
    if total_loaded == 0:
        print("::error::Nothing loaded at all.")
        return 1

    # Stamp the freshness ledger (best-effort — a failed stamp never fails
    # the load): dataset -> loaded_at + row count in public.dataset_meta.
    # SKIPPED datasets are deliberately not stamped: this ledger is the record
    # used to work out what is stale, and marking a dataset as freshly loaded
    # when it was not is how a gap stays invisible. (dataset_meta still showing
    # census_students and student_accom as loaded on 24 July, long after they
    # were deleted, is what finally identified this bug.)
    for dataset in sorted(d for d in by_dataset if d not in skipped):
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
    # Non-zero if anything was skipped, so a partial run is never green — but
    # only AFTER everything that could load has loaded.
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main())
