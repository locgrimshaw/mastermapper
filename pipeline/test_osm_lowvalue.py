"""
test_osm_lowvalue.py — regression test for the low-value land classifier.

Run: python3 pipeline/test_osm_lowvalue.py

The West End block exists because the first version of this classifier
labelled Oxford Street, Mayfair, Selfridges and Fortnum & Mason as
"underutilised retail". OSM's `landuse=retail` is a DISTRICT tag and
`building=retail` is every shop in the country, so retail now has to prove
shed-ness: an out-of-town format, a retail-park name, or a large low-rise
footprint with its own surface car park beside it. Keep these cases passing.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sq(lon, lat, m):
    dlat = m / 110540.0
    dlon = m / (111320.0 * math.cos(math.radians(lat)))
    return [[[lon, lat], [lon + dlon, lat], [lon + dlon, lat + dlat],
             [lon, lat + dlat], [lon, lat]]]


CASES = []


def add(label, tags, m, lon, lat, expect):
    t = dict(tags)
    t["@id"] = str(len(CASES) + 1)
    t["@type"] = "way"
    CASES.append((label, t, m, lon, lat, expect))


# --- West End: must ALL be excluded (no surface parking anywhere near) -----
W = (-0.140, 51.512)
add("Fortnum & Mason", {"shop": "department_store", "name": "Fortnum & Mason"}, 64, W[0], W[1], None)
add("Selfridges", {"building": "retail", "shop": "department_store", "name": "Selfridges"}, 90, W[0] + 0.002, W[1], None)
add("70-88 Oxford Street", {"building": "retail", "name": "70-88 Oxford Street"}, 53, W[0] + 0.004, W[1], None)
add("Oxford St retail land", {"landuse": "retail"}, 60, W[0] + 0.006, W[1], None)
add("Mayfair retail land", {"landuse": "retail"}, 100, W[0] + 0.008, W[1], None)
add("West End Waitrose", {"shop": "supermarket", "building": "retail", "name": "Waitrose"}, 38, W[0] + 0.010, W[1], None)
add("6-storey shop building", {"building": "retail", "building:levels": "6"}, 60, W[0] + 0.012, W[1], None)

# --- genuine out-of-town sheds --------------------------------------------
O = (-1.300, 52.400)
add("Tesco Extra shed", {"building": "retail", "shop": "supermarket", "name": "Tesco Extra"}, 90, O[0], O[1], "osm_retail")
add("Tesco car park", {"amenity": "parking", "parking": "surface"}, 90, O[0] + 0.0009, O[1], "osm_parking")
add("Big retail box", {"building": "retail"}, 80, O[0] + 0.004, O[1], "osm_retail")
add("Box car park", {"amenity": "parking", "parking": "surface"}, 90, O[0] + 0.0049, O[1], "osm_parking")
add("Ravenside Retail Park", {"landuse": "retail", "name": "Ravenside Retail Park"}, 200, O[0] + 0.008, O[1], "osm_retail")
add("B&Q warehouse", {"shop": "doityourself", "name": "B&Q"}, 70, O[0] + 0.012, O[1], "osm_retail")
add("car dealership", {"shop": "car", "name": "Motor Group"}, 50, O[0] + 0.016, O[1], "osm_retail")
add("petrol station", {"amenity": "fuel", "shop": "convenience"}, 40, O[0] + 0.020, O[1], "osm_retail")
add("garden centre", {"shop": "garden_centre"}, 60, O[0] + 0.024, O[1], "osm_retail")
add("isolated box, no parking", {"building": "retail"}, 80, O[0] + 0.030, O[1], None)
# --- residual West End failures found in the LOADED data after fix v1 ------
# An unnamed landuse=retail district with a small city car park nearby must
# NOT qualify: a land-use district is not a site, whatever is parked near it.
add("unnamed retail district", {"landuse": "retail"}, 70, -0.1549, 51.5135, None)
# (these two are also below the 1,000 m2 feature floor, so they are excluded
#  as features too — they exist only in the parking index, where their size
#  is what disqualifies them from validating a shed)
add("small city car park", {"amenity": "parking", "parking": "surface"}, 25, -0.1544, 51.5135, None)
# A big-box building beside a SMALL car park must not qualify either.
add("box by tiny car park", {"building": "retail"}, 60, -0.1320, 51.5134, None)
# The biggest surface car park actually in the West End is 4,585 m2. Even
# beside one that size, a retail district must not qualify.
add("W1 district, 4.6k car park", {"landuse": "retail"}, 120, -0.1600, 51.5090, None)
add("biggest West End car park", {"amenity": "parking", "parking": "surface"}, 68, -0.1595, 51.5090, "osm_parking")
# Fosse Park style: a LARGE unnamed retail district with a LARGE car park is a
# genuine out-of-town retail park and must survive.
add("Fosse-style district", {"landuse": "retail"}, 250, -1.1955, 52.5855, "osm_retail")
add("Fosse-style car park", {"amenity": "parking", "parking": "surface"}, 140, -1.1938, 52.5855, "osm_parking")
# Some major retail parks are mapped landuse=commercial, not retail. Large +
# large car park must qualify; a city commercial block must not.
add("commercial retail park", {"landuse": "commercial"}, 250, -1.4500, 53.4000, "osm_retail")
add("its car park", {"amenity": "parking", "parking": "surface"}, 140, -1.4483, 53.4000, "osm_parking")
add("city commercial block", {"landuse": "commercial"}, 120, -0.0900, 51.5150, None)
add("city service parking", {"amenity": "parking", "parking": "surface"}, 60, -0.0895, 51.5150, "osm_parking")
add("tiny car park", {"amenity": "parking", "parking": "surface"}, 28, -0.1315, 51.5134, None)

# --- industrial: low-rise kept, multi-storey dropped ----------------------
add("warehouse 1-storey", {"building": "warehouse", "building:levels": "1"}, 90, O[0], O[1] + 0.01, "osm_industrial")
add("industrial estate", {"landuse": "industrial"}, 200, O[0] + 0.004, O[1] + 0.01, "osm_industrial")
add("5-storey factory", {"building": "factory", "building:levels": "5"}, 60, O[0] + 0.008, O[1] + 0.01, None)
add("tall shed (18 m)", {"building": "warehouse", "height": "18"}, 70, O[0] + 0.012, O[1] + 0.01, None)

# --- other classes ---------------------------------------------------------
add("multi-storey car park", {"amenity": "parking", "parking": "multi-storey"}, 70, O[0] + 0.016, O[1] + 0.01, None)
add("park and ride", {"amenity": "parking", "park_ride": "yes"}, 120, O[0] + 0.020, O[1] + 0.01, "osm_parking")
add("council depot", {"landuse": "depot"}, 60, O[0], O[1] + 0.02, "osm_storage")
add("lock-up garages", {"landuse": "garages"}, 40, O[0] + 0.004, O[1] + 0.02, "osm_storage")
add("gasholder", {"man_made": "gasometer"}, 50, O[0] + 0.008, O[1] + 0.02, "osm_storage")
add("scrap yard", {"landuse": "industrial", "industrial": "scrap_yard"}, 55, O[0] + 0.012, O[1] + 0.02, "osm_storage")
add("OSM brownfield", {"landuse": "brownfield"}, 100, O[0] + 0.016, O[1] + 0.02, "osm_brownfield")
add("quarry", {"landuse": "quarry"}, 300, O[0] + 0.022, O[1] + 0.02, "osm_brownfield")
add("golf course", {"leisure": "golf_course"}, 500, O[0] + 0.030, O[1] + 0.02, "osm_leisure_lowdensity")

# --- NPPF Annex B exclusions: none of these is previously developed land ---
X = (-2.500, 53.400)
for i, (label, tags) in enumerate([
        ("allotments", {"landuse": "allotments"}),
        ("park", {"leisure": "park"}),
        ("recreation ground", {"landuse": "recreation_ground"}),
        ("farmland", {"landuse": "farmland"}),
        ("agricultural barn", {"building": "barn"}),
        ("houses", {"building": "house"}),
        ("school land", {"landuse": "education"}),
        ("residential land", {"landuse": "residential"}),
        ("playing pitch", {"leisure": "pitch"}),
        ("cemetery", {"landuse": "cemetery"})]):
    add(label, tags, 200, X[0] + i * 0.01, X[1], None)

# --- size floor ------------------------------------------------------------
add("tiny lock-up (20 m sq)", {"landuse": "garages"}, 20, X[0], X[1] + 0.02, None)


def main():
    tmp = Path(tempfile.mkdtemp())
    src, out = tmp / "in.geojsonl", tmp / "out.csv"
    with src.open("w") as fh:
        for label, tags, m, lon, lat, _ in CASES:
            fh.write(json.dumps({"type": "Feature", "properties": tags,
                                 "geometry": {"type": "Polygon",
                                              "coordinates": sq(lon, lat, m)}}) + "\n")
    env = dict(os.environ, OSM_LV_SRC=str(src), OSM_LV_OUT=str(out))
    r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "build_osm_lowvalue.py")],
                       env=env, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        sys.exit("builder failed")

    import csv
    got = {row["source_id"]: row["dataset"] for row in csv.DictReader(out.open())}
    fails = 0
    for i, (label, tags, _m, _lon, _lat, expect) in enumerate(CASES, 1):
        g = got.get(f"osm-w{tags['@id']}")
        ok = (g == expect)
        if not ok:
            fails += 1
            print(f"FAIL  {label:28s} expected {expect or '(excluded)'}, got {g or '(excluded)'}")
    print(f"{len(CASES) - fails}/{len(CASES)} cases pass")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
