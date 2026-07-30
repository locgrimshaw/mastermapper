"""
build_building_tiles.py
-----------------------
Normalise OSM building FOOTPRINTS (not centroids) into line-delimited GeoJSON
ready for tippecanoe, so the map can colour each building's outline by its
height instead of dropping a dot on it.

Why a separate path from build_datasets.build_building_height: that one makes
centroids and loads them into Postgres, which is the right shape for a
low-zoom "where are the tall buildings" layer but useless for reading an area's
built form. Footprints are ~1.5M polygons — too much to serve from the
database per viewport, and exactly what vector tiles are for. Same parsing
rules in both, so the numbers agree.

Input:  data/raw/osm_buildings.geojsonl — line-delimited GeoJSON written by
        ogr2ogr from an osmium-filtered PBF (see build-building-tiles.yml).
Output: data/raw/buildings-tiles.jsonl — one Feature per line with props
        height_m, storeys, class ('low'|'mid'|'high') and name.

Licence: OpenStreetMap contributors, ODbL.
"""

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SRC = Path(os.environ.get("BUILDING_SRC") or (RAW / "osm_buildings.geojsonl"))
OUT = Path(os.environ.get("BUILDING_OUT") or (RAW / "buildings-tiles.jsonl"))

# Metres per storey when only one of height / building:levels is tagged.
M_PER_STOREY = 3.2
# Tagging errors are common at both ends: a 0.5 m "building" and a 900 m house.
MIN_H, MAX_H = 1.5, 400.0

_TAG = {}


def tagval(other_tags, key):
    """Pull one tag out of ogr2ogr's hstore-ish other_tags string."""
    if not isinstance(other_tags, str):
        return None
    rx = _TAG.get(key)
    if rx is None:
        rx = _TAG[key] = re.compile('"' + re.escape(key) + '"=>"([^"]*)"')
    m = rx.search(other_tags)
    return m.group(1) if m else None


_H_M = re.compile(r"^([\d.]+)\s*(m|metres?|meters?)?$")
_H_FT = re.compile(r"^([\d.]+)\s*(ft|feet|')$")


def _multi(v):
    """Split an OSM multi-valued tag into its parts.

    A single way often covers buildings of differing heights, and OSM records
    that as semicolon-separated values: building:levels="4;1". Stripping the
    punctuation and reading what is left as one number turns that into FORTY
    ONE storeys — which is exactly how terraces in Chelsea and South Kensington
    came to be painted as 130 m towers. The tell was a spike in the national
    storey histogram at 31, 41 and 43 ("3;1", "4;1", "4;3") where the counts
    should be falling away."""
    return [p for p in re.split(r"\s*;\s*", str(v).strip()) if p]


def _parse_one_height(v):
    v = v.strip().lower()
    m = _H_M.match(v)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    m = _H_FT.match(v)
    if m:
        try:
            return float(m.group(1)) * 0.3048
        except ValueError:
            return None
    return None


def parse_height(v):
    """OSM `height`: usually bare metres, sometimes with units, sometimes feet,
    sometimes several values for one way. The TALLEST part is what the layer
    is about, so multi-values take their max."""
    if not v:
        return None
    vals = [h for h in (_parse_one_height(p) for p in _multi(v)) if h is not None]
    return max(vals) if vals else None


def parse_levels(v):
    if not v:
        return None
    vals = []
    for part in _multi(v):
        try:
            n = float(re.sub(r"[^\d.]", "", part) or 0)
        except ValueError:
            continue
        if n:
            vals.append(n)
    n = max(vals) if vals else 0
    return n or None


def height_and_storeys(props):
    """(height_m, storeys), or (None, None) when the height is unknown.

    Either measure stands in for the other at ~3.2 m per storey.

    Two rules that used to live here are GONE. The old ">= 2 storeys or >= 6 m"
    cut was meant to drop sheds and garages, but it also emptied the whole
    bottom of the scale: a genuine single-storey building is ~3 m, so the
    "under 5 m" band could essentially never be populated and the map showed no
    short buildings at all. And a height outside the sane range no longer drops
    the BUILDING — only the bad number — because a footprint with an absurd tag
    is still a real building and belongs on the map as 'unknown'."""
    tags = props.get("other_tags")
    h = parse_height(props.get("height")) or parse_height(tagval(tags, "height"))
    lv = parse_levels(props.get("building:levels")) \
        or parse_levels(tagval(tags, "building:levels"))
    if h is None and lv:
        h = round(lv * M_PER_STOREY, 1)
    if lv is None and h:
        lv = round(h / M_PER_STOREY)
    if h is None or not (MIN_H < h < MAX_H):
        return None, None
    return round(h, 1), (int(lv) if lv else None)


def hclass(h):
    """Coarse class kept for the hover card. None height -> 'unknown'."""
    if h is None:
        return "unknown"
    return "high" if h >= 25 else ("mid" if h >= 12 else "low")


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found — the workflow's osmium/ogr2ogr step "
              "writes it.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)

    read = kept = 0
    by_class = {"low": 0, "mid": 0, "high": 0, "unknown": 0}
    tallest = (0.0, None)
    with SRC.open(encoding="utf-8", errors="ignore") as fin, \
            OUT.open("w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip().rstrip(",")
            if not line or line[0] != "{":
                continue                      # array wrapper lines, if any
            try:
                feat = json.loads(line)
            except ValueError:
                continue
            geom = feat.get("geometry")
            if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            read += 1
            props = feat.get("properties") or {}
            h, lv = height_and_storeys(props)
            cls = hclass(h)
            by_class[cls] += 1
            kept += 1
            if h is not None and h > tallest[0]:
                tallest = (h, props.get("name"))
            # An untagged building carries NO height_m at all, rather than a
            # zero or a guess: the map paints those a neutral grey so a gap in
            # OSM's tagging reads as "not known" instead of "short".
            out = {"class": cls}
            if h is not None:
                out["height_m"] = h
            if lv:
                out["storeys"] = lv
            if props.get("name"):
                out["name"] = props["name"]
            fout.write(json.dumps(
                {"type": "Feature", "properties": out, "geometry": geom},
                separators=(",", ":"), ensure_ascii=False) + "\n")
            if read % 500_000 == 0:
                print(f"  [buildings] {read:,} read, {kept:,} kept", flush=True)

    known = kept - by_class["unknown"]
    print(f"[buildings] {read:,} footprints -> {kept:,} written "
          f"(low {by_class['low']:,} / mid {by_class['mid']:,} / "
          f"high {by_class['high']:,} / height unknown "
          f"{by_class['unknown']:,})")
    print(f"[buildings] {known:,} with a height "
          f"({100.0 * known / kept:.0f}% of footprints)" if kept else "")
    if tallest[1] or tallest[0]:
        print(f"[buildings] tallest: {tallest[0]} m ({tallest[1] or 'unnamed'})")
    if not kept:
        print("ERROR: no usable buildings", file=sys.stderr)
        return 1
    print(f"[buildings] wrote {OUT} ({OUT.stat().st_size / 1e6:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
