"""
build_terrain.py
----------------
OS Terrain 50 -> `slope_grid`: mean/max ground slope per 1 km cell across
Great Britain, the data-centre tool's flatness screen. Free OGL download,
no key: the OS Downloads API serves the full ASCII-grid product (~180 MB
zip of 10 km tile zips, each holding a 200x200 grid of 50 m elevations).

Per tile: numpy gradient -> slope in degrees per 50 m cell -> aggregate
20x20 blocks (1 km): mean + max, keeping blocks with >=50% valid data.
Output: supabase/datasets_import.csv rows (dataset slope_grid, 1 km square
polygons, props {slope, max_slope}) for load_datasets.py.

Licence: Contains OS data © Crown copyright and database right 2026 (OGL).
"""

import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

TERRAIN_URL = os.environ.get("TERRAIN50_SRC") or (
    "https://api.os.uk/downloads/v1/products/Terrain50/downloads"
    "?area=GB&format=ASCII+Grid+and+GML+%28Grid%29&redirect")

BLOCK = 20          # 20 x 50 m = 1 km aggregation blocks
CELL = 50.0         # source resolution, metres


def _parse_asc(fh):
    """ESRI ASCII grid -> (array with NaN nodata, xll, yll, cellsize)."""
    header = {}
    while len(header) < 5:
        parts = fh.readline().split()
        if len(parts) != 2:
            break
        header[parts[0].lower()] = float(parts[1])
    nodata = header.get("nodata_value", -9999.0)
    arr = np.loadtxt(fh, dtype=np.float32)
    arr[arr == nodata] = np.nan
    return (arr, header.get("xllcorner", 0.0), header.get("yllcorner", 0.0),
            header.get("cellsize", CELL))


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / "terrain50-gb.zip"
    if not dest.exists() or dest.stat().st_size < 1e7:
        print(f"[terrain] downloading OS Terrain 50 (~180 MB) ...")
        req = urllib.request.Request(
            TERRAIN_URL, headers={"User-Agent": "mastermapper-pipeline/1.0"})
        with urllib.request.urlopen(req, timeout=1800) as r, \
             open(dest, "wb") as fh:
            while True:
                chunk = r.read(1 << 22)
                if not chunk:
                    break
                fh.write(chunk)
        print(f"[terrain]   -> {dest.stat().st_size / 1e6:.0f} MB")

    try:
        from pyproj import Transformer
    except ImportError:
        print("ERROR: pyproj unavailable", file=sys.stderr)
        return 1
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    rows, tiles = [], 0
    with zipfile.ZipFile(dest) as outer:
        inner_names = [m for m in outer.namelist()
                       if m.lower().endswith(".zip")]
        print(f"[terrain] {len(inner_names)} tile zips")
        for m in inner_names:
            with zipfile.ZipFile(io.BytesIO(outer.read(m))) as inner:
                asc = next((a for a in inner.namelist()
                            if a.lower().endswith(".asc")), None)
                if asc is None:
                    continue
                with inner.open(asc) as fh:
                    arr, xll, yll, cs = _parse_asc(
                        io.TextIOWrapper(fh, "ascii", errors="ignore"))
            tiles += 1
            if arr.ndim != 2 or arr.shape[0] < BLOCK:
                continue
            # Slope in degrees from the elevation gradient (dz per metre).
            gy, gx = np.gradient(arr, cs)
            slope = np.degrees(np.arctan(np.hypot(gx, gy)))
            nr, nc = slope.shape
            nbr, nbc = nr // BLOCK, nc // BLOCK
            s = slope[:nbr * BLOCK, :nbc * BLOCK] \
                .reshape(nbr, BLOCK, nbc, BLOCK)
            valid = np.isfinite(s).mean(axis=(1, 3))
            with np.errstate(all="ignore"):
                mean_s = np.nanmean(s, axis=(1, 3))
                max_s = np.nanmax(s, axis=(1, 3))
            km = BLOCK * cs
            for bi in range(nbr):
                for bj in range(nbc):
                    if valid[bi, bj] < 0.5 or not np.isfinite(mean_s[bi, bj]):
                        continue
                    # Row 0 of the array is the TOP (max northing).
                    e0 = xll + bj * km
                    n0 = yll + (nbr - 1 - bi) * km
                    lon0, lat0 = tr.transform(e0, n0)
                    lon1, lat1 = tr.transform(e0 + km, n0 + km)
                    props = {"slope": round(float(mean_s[bi, bj]), 1),
                             "max_slope": round(float(max_s[bi, bj]), 1)}
                    rows.append({
                        "dataset": "slope_grid",
                        "source_id": f"sl-{int(e0)}-{int(n0)}",
                        "name": None,
                        "props": json.dumps(props, allow_nan=False),
                        "geom_wkt": ("SRID=4326;POLYGON(("
                                     f"{lon0:.5f} {lat0:.5f},{lon1:.5f} {lat0:.5f},"
                                     f"{lon1:.5f} {lat1:.5f},{lon0:.5f} {lat1:.5f},"
                                     f"{lon0:.5f} {lat0:.5f}))"),
                    })
            if tiles % 200 == 0:
                print(f"[terrain] {tiles} tiles processed, "
                      f"{len(rows):,} km cells so far")
    print(f"[terrain] {tiles} tiles -> {len(rows):,} 1 km slope cells")
    if not rows:
        print("ERROR: no slope cells produced", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows):,} rows to {OUT.name} "
          f"({OUT.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
