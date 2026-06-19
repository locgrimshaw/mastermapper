"""
build_tiles.py
--------------
Converts the processed LSOA GeoJSON into a single .pmtiles vector-tile file
that the map serves from GitHub Pages. The browser then fetches only the tiles
covering the current view (via HTTP range requests) instead of the whole
national dataset at once -- this is the fix for the map being slow.

CRITICAL: we keep every domain's *_norm score, plus price + names, as
attributes INSIDE the tiles. The combined-score colouring still happens live
in the browser from those attributes, so the weighting sliders keep working.

Input:  web/data/lsoa_imd.geojson   (output of build_imd_layer.py [+ prices])
Output: web/data/lsoa.pmtiles       (single file, served by Pages)

Needs tippecanoe on PATH (the Action installs it). Run:
  python pipeline/build_tiles.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "data" / "lsoa_imd.geojson"
OUT = ROOT / "web" / "data" / "lsoa.pmtiles"
BREAKS = ROOT / "web" / "data" / "breaks.json"

DOMAINS = ["income", "employment", "education", "health",
           "crime", "housing", "environment"]
RAMP_N = 6  # number of colour classes (must match the frontend RAMP length)

# Attributes to keep in the tiles. Everything the browser needs to (a) compute
# the combined score live and (b) fill the click/inspect panel.
KEEP_ATTRS = [
    "lsoa_code", "lsoa_name", "lad_name",
    "income_norm", "employment_norm", "education_norm", "health_norm",
    "crime_norm", "housing_norm", "environment_norm",
    "price_norm", "price_median", "price_count",
]


def write_breaks():
    """Precompute quantile colour breaks across ALL features. The tiled map
    only holds visible features in memory, so it can't compute these live --
    we bake them here where the whole dataset is available, and ship a tiny
    sidecar JSON the frontend loads instantly."""
    gj = json.loads(SRC.read_text())
    feats = gj["features"]

    def quantiles(values):
        v = sorted(x for x in values if x is not None)
        if not v:
            return []
        n = len(v)
        return [round(v[int(i / RAMP_N * n)], 1) for i in range(1, RAMP_N)]

    def combined(p):
        vals = [p.get(f"{d}_norm") for d in DOMAINS]
        vals = [x for x in vals if x is not None]
        return sum(vals) / len(vals) if vals else 0

    out = {"combined_equal": quantiles(combined(f["properties"]) for f in feats)}
    for d in DOMAINS + ["price"]:
        out[d] = quantiles(f["properties"].get(f"{d}_norm") for f in feats)

    # Price band (16th-84th percentile of medians) for the legend label.
    medians = sorted(
        f["properties"]["price_median"]
        for f in feats
        if f["properties"].get("price_median") is not None
    )
    if medians:
        out["price_band"] = [
            medians[int(0.16 * (len(medians) - 1))],
            medians[int(0.84 * (len(medians) - 1))],
        ]

    # Flag whether this is synthetic sample data (codes start with "S"),
    # so the frontend can show the right data-source note without loading
    # all features.
    first_code = feats[0]["properties"].get("lsoa_code", "") if feats else ""
    out["meta"] = {"sample": first_code.startswith("S")}

    # Data bounding box, so the map can fit to it on load (the tiles don't
    # hand us an extent up front).
    xs, ys = [], []
    for f in feats:
        g = f.get("geometry")
        if not g:
            continue
        coords = g["coordinates"]
        rings = coords if g["type"] == "Polygon" else [r for poly in coords for r in poly]
        for ring in rings:
            for x, y in ring:
                xs.append(x); ys.append(y)
    if xs:
        out["bbox"] = [min(xs), min(ys), max(xs), max(ys)]

    BREAKS.write_text(json.dumps(out))
    print(f"Wrote {BREAKS} (colour breaks for {len(feats)} features)")


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found. Run build_imd_layer.py first.")
        return 1
    if not shutil.which("tippecanoe"):
        print("ERROR: tippecanoe not on PATH. (The Action installs it.)")
        return 1

    # Build the -y flags that tell tippecanoe which attributes to retain.
    keep_flags = []
    for a in KEEP_ATTRS:
        keep_flags += ["-y", a]

    cmd = [
        "tippecanoe",
        "-o", str(OUT),
        "-f",                       # overwrite if exists
        "-l", "lsoa",               # layer name the map will reference
        "-Z", "5",                  # min zoom (whole-of-England view)
        "-z", "12",                 # max zoom (street-ish; LSOAs are areas)
        # --- Border integrity (fixes the "fragmented / gappy" look) ----------
        # By default tippecanoe simplifies each polygon independently, so a
        # border shared by two LSOAs gets simplified twice and the two edges
        # drift apart, leaving hairline slivers that show the basemap through.
        # These flags keep adjacent borders stitched together:
        "--detect-shared-borders",        # simplify a shared edge identically
        "--no-simplification-of-shared-nodes",
        "--simplification", "4",          # gentler simplification overall
        "--buffer", "8",                  # wider tile buffer = fewer edge gaps
        # ---------------------------------------------------------------------
        "--coalesce-densest-as-needed",  # keep tiles small where dense (cities)
        "--extend-zooms-if-still-dropping",
        "--no-tile-size-limit",
        *keep_flags,
        str(SRC),
    ]
    print("Running tippecanoe:\n  " + " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("tippecanoe failed:")
        print(result.stderr[-2000:])
        return 1
    print(result.stderr[-800:] if result.stderr else "tippecanoe done.")

    size_mb = OUT.stat().st_size / 1e6
    print(f"Wrote {OUT}  ({size_mb:.1f} MB)")
    write_breaks()
    return 0


if __name__ == "__main__":
    sys.exit(main())