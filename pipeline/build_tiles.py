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
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "data" / "lsoa_imd.geojson"
RAIL_SRC = ROOT / "web" / "data" / "rail.geojson"   # optional overlay (lines+stations)
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
    # Unique per-build stamp. The frontend appends this to the tile URL so a
    # rebuilt lsoa.pmtiles is never served from a stale browser/CDN cache (the
    # filename stays the same, so without this a cached copy can hide new data).
    out["meta"]["build_id"] = str(int(time.time()))

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

    # Tell the frontend what the rail overlay contains, per mode, so it shows
    # only the toggles that have data. Counts come straight from the sidecar
    # the rail builder already wrote.
    if RAIL_SRC.exists():
        try:
            rail = json.loads(RAIL_SRC.read_text())
            meta = rail.get("metadata", {})
            out["meta"]["rail"] = {
                "line_counts": meta.get("line_counts", {}),
                "stop_counts": meta.get("stop_counts", {}),
            }
        except (ValueError, KeyError):
            pass

    BREAKS.write_text(json.dumps(out))
    print(f"Wrote {BREAKS} (colour breaks for {len(feats)} features)")


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found. Run build_imd_layer.py first.")
        return 1
    if not shutil.which("tippecanoe"):
        print("ERROR: tippecanoe not on PATH. (The Action installs it.)")
        return 1

    # Pre-trim the LSOA layer's attributes HERE, in Python, rather than with
    # tippecanoe's -y flag. Critical: tippecanoe's -y is a GLOBAL whitelist —
    # it applies to every layer, so using it would also strip mode/name/crs
    # from the rail layers (leaving grey lines + "Unnamed/UNDEFINED" stops).
    # We write a trimmed copy of just the LSOA layer and feed that instead.
    lsoa_trimmed = ROOT / "web" / "data" / "_lsoa_trimmed.geojson"
    rail_tmp = [lsoa_trimmed]
    src_gj = json.loads(SRC.read_text())
    for f in src_gj.get("features", []):
        props = f.get("properties", {})
        f["properties"] = {k: props[k] for k in KEEP_ATTRS if k in props}
    lsoa_trimmed.write_text(json.dumps(src_gj))
    print(f"Trimmed LSOA attributes to {len(KEEP_ATTRS)} fields "
          f"(was {len(src_gj['features'][0]['properties']) if src_gj['features'] else 0} kept).")

    # Optional rail overlay. tippecanoe takes extra inputs as their OWN named
    # layers via -L. We split rail.geojson into a line layer and a stop layer;
    # the per-feature `mode` attribute (rail/subway/light_rail/tram), plus name/
    # crs/operator, are kept intact because we no longer pass a global -y.
    rail_layer_flags = []
    if RAIL_SRC.exists():
        try:
            rail = json.loads(RAIL_SRC.read_text())
            feats = rail.get("features", [])
            lines = [f for f in feats if f["properties"].get("kind") == "line"]
            stops = [f for f in feats if f["properties"].get("kind") == "stop"]
            if lines:
                p = ROOT / "web" / "data" / "_rail_line.geojson"
                p.write_text(json.dumps({"type": "FeatureCollection", "features": lines}))
                rail_tmp.append(p)
                rail_layer_flags += ["-L", f"rail_line:{p}"]
            if stops:
                p = ROOT / "web" / "data" / "_rail_stop.geojson"
                p.write_text(json.dumps({"type": "FeatureCollection", "features": stops}))
                rail_tmp.append(p)
                rail_layer_flags += ["-L", f"rail_stop:{p}"]
            print(f"Rail overlay: {len(lines)} lines, {len(stops)} stops "
                  "-> bundling into tiles.")
        except (ValueError, KeyError) as exc:
            print(f"Could not read {RAIL_SRC.name} ({exc}); building without rail.")

    cmd = [
        "tippecanoe",
        "-o", str(OUT),
        "-f",                       # overwrite if exists
        "-L", "lsoa:" + str(lsoa_trimmed),   # trimmed choropleth layer
        "-Z", "5",                  # min zoom (whole-of-England view)
        "-z", "14",                 # max zoom — deeper so close-up stays crisp
        # --- Border integrity (fixes the "fragmented / gappy" look) ----------
        # By default tippecanoe simplifies each polygon independently, so a
        # border shared by two LSOAs gets simplified twice and the two edges
        # drift apart, leaving hairline slivers that show the basemap through.
        # The fix has three parts:
        #   1. Don't simplify the deepest zoom at all, so at full zoom the
        #      polygons are exactly the source geometry (no drift => no gaps).
        #   2. Keep shared borders stitched at the zoom levels we do simplify.
        #   3. A gentle simplification factor for the zoomed-out tiles only.
        "--no-simplification-of-shared-nodes",
        "--simplification", "2",          # gentler than before (was 4)
        "--buffer", "16",                 # wider tile buffer = fewer edge gaps
        "--full-detail", "12",            # higher per-tile coordinate resolution
        # ---------------------------------------------------------------------
        "--coalesce-densest-as-needed",  # keep tiles small where dense (cities)
        "--extend-zooms-if-still-dropping",
        "--no-tile-size-limit",
        *rail_layer_flags,
    ]
    print("Running tippecanoe:\n  " + " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    # Clean up the temporary split files regardless of outcome.
    for p in rail_tmp:
        try:
            p.unlink()
        except OSError:
            pass
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