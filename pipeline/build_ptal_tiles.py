"""
build_ptal_tiles.py
-------------------
Export a map_features dataset to newline-delimited GeoJSON for tippecanoe.

WHY PTAL NEEDS THIS. PTAL is a 100 m grid over Greater London — 159,451 cells —
and the per-viewport bbox RPC cannot serve it at a London-wide zoom. Measured,
with the frontend's 30% fetch margin applied:

    z12   52,301 cells   14 MB   20.8 s      <- unusable
    z13   13,286 cells  3.6 MB    1.4 s

Raising the row cap does not help. The cost is not the geometry simplification
(the same query with simplification removed takes the same 20.8 s) but roughly
400 microseconds per feature spent assembling the JSON document, so it scales
with the number of cells however the query is tuned. And below z12 the cells
never reached the cap at all: the RPC drops geometry smaller than a pixel, and a
100 m cell (1.3e-6 deg^2) is under the z11 threshold (1.9e-6) — asking for
200,000 features at z11 returned two.

PMTiles removes the ceiling: the whole grid is tiled once, served as static
range requests, and costs the database nothing per view. Same route as
buildings (1.5M polygons) and parcels (26M).

PROPERTIES ARE TRIMMED to just the keys the map uses. PTAL carries a unique
float per cell ('ai', the accessibility index) which nothing renders and which
would prevent tippecanoe coalescing adjacent same-grade cells — with it gone,
neighbouring cells merge into single polygons and the low-zoom tiles get
dramatically smaller.

Environment:
  SUPABASE_URL, SUPABASE_SERVICE_KEY   required
  TILE_DATASET   dataset to export      (default 'ptal')
  TILE_PROPS     comma list to keep     (default 'ptal'; blank = keep all)
  TILE_OUT       output .jsonl          (default data/raw/<dataset>-tiles.jsonl)
  PAGE_SIZE      rows per request       (default 5000, server caps at 20000)

Licence: TfL PTAL 2023 via ArcGIS Hub, Open Government Licence.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
DATASET = os.environ.get("TILE_DATASET") or "ptal"
PAGE = int(os.environ.get("PAGE_SIZE") or 5000)
_props = os.environ.get("TILE_PROPS", "ptal")
PROPS = [p.strip() for p in _props.split(",") if p.strip()] if _props.strip() else None
OUT = Path(os.environ.get("TILE_OUT")
           or (ROOT / "data" / "raw" / f"{DATASET}-tiles.jsonl"))


def _page(after):
    body = json.dumps({"p_dataset": DATASET, "p_limit": PAGE,
                       "p_after": after, "p_props": PROPS}).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/dataset_features_page",
        data=body, method="POST",
        headers={"apikey": SUPABASE_KEY,
                 "Authorization": f"Bearer {SUPABASE_KEY}",
                 "Content-Type": "application/json"})
    # One retry: a single blip should not throw away a long export.
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
    raise last


def main() -> int:
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    total, after, pages = 0, None, 0
    empty_geom = 0
    with OUT.open("w", encoding="utf-8") as fh:
        while True:
            got = _page(after)
            feats = (got or {}).get("features") or []
            if not feats:
                break
            for f in feats:
                if not f.get("geometry"):
                    empty_geom += 1
                    continue
                # One feature per line: tippecanoe --read-parallel splits on
                # newlines, so this is what lets it use every core.
                fh.write(json.dumps(f, separators=(",", ":")) + "\n")
                total += 1
            pages += 1
            nxt = (got or {}).get("last")
            # Guard against a cursor that fails to advance: without this a
            # server-side change could spin here forever writing duplicates.
            if nxt is None or nxt == after:
                break
            after = nxt
            if pages % 5 == 0:
                print(f"  [{DATASET}] {total:,} features written "
                      f"(cursor {after})", flush=True)
            if len(feats) < PAGE:
                break
    print(f"[{DATASET}] wrote {total:,} feature(s) to {OUT} "
          f"({OUT.stat().st_size / 1e6:.1f} MB, {pages} page(s))")
    if empty_geom:
        print(f"[{DATASET}] skipped {empty_geom:,} row(s) with no geometry")
    if total == 0:
        print(f"ERROR: no features exported for '{DATASET}' — is it loaded?",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
