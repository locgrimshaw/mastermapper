"""
tile_zoom_filter.py
-------------------
Prints a tippecanoe -j feature filter that shows each feature only from the
zoom in its `mz` property:  tippecanoe ... -j "$(python pipeline/tile_zoom_filter.py 4 14)"

Why not tippecanoe's own per-feature {"tippecanoe": {"minzoom": n}}: the
tippecanoe 2.49 in Ubuntu's archive keeps only ONE feature per tile per layer
when features carry it (measured: 895 central-London road links in a z12 tile
without it, 1 with it). A legacy-syntax filter on a plain property does the
same job on every version: at zoom Z a feature passes when mz <= Z.
"""
import json
import sys

lo, hi = int(sys.argv[1]), int(sys.argv[2])
flt = ["any"] + [["all", ["==", "$zoom", z], ["<=", "mz", z]] for z in range(lo, hi + 1)]
print(json.dumps({"*": flt}, separators=(",", ":")))
