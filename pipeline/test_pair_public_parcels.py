"""
test_pair_public_parcels.py
---------------------------
Offline test for the CCOD -> INSPIRE parcel matcher. No network, no Supabase:
it fabricates a handful of parcels, stubs fetch_points(), and asserts on the
CSV the script writes. Run it with `python pipeline/test_pair_public_parcels.py`.

It exists because the national run takes 78 minutes and its logs are
unreadable while it is in flight, so a mistake in the matching rules is
expensive to discover. The first national run produced 948,554 nearest-matches
against 118,719 ownership points — a median of 8 neighbouring parcels wrongly
attributed to each council — and every rule below is here to keep a regression
of that kind from reaching the map again.
"""

import csv
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CX, CY = -1.9016, 52.4776          # Birmingham-ish, so UTM/BNG maths is real
HALF = 0.00030                     # ~33 m half-width -> ~66 m square, ~4,400 m2


def sq(cx, cy, half):
    ring = [[cx - half, cy - half], [cx + half, cy - half],
            [cx + half, cy + half], [cx - half, cy + half],
            [cx - half, cy - half]]
    return {"type": "Polygon", "coordinates": [ring]}


def load_module(parcel_dir, out_csv):
    os.environ["PARCEL_DIR"] = str(parcel_dir)
    os.environ["SUPABASE_URL"] = "http://stub"
    os.environ["SUPABASE_SERVICE_KEY"] = "stub"
    spec = importlib.util.spec_from_file_location(
        "ppp", HERE / "pair_public_parcels.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ppp"] = mod
    spec.loader.exec_module(mod)
    mod.OUT = out_csv
    return mod


def run(tmp):
    step = 0.00062                 # ~42 m apart: neighbours fall inside NEAR_M
    parcels = [(f"T{k}", sq(CX + (k - 2) * step, CY, HALF)) for k in range(6)]
    parcels += [
        ("RESCUE",     sq(CX + 0.0060, CY, HALF)),
        ("RESCUE_FAR", sq(CX + 0.0060, CY + 0.00075, HALF)),
        ("FARM",       sq(CX + 0.0060, CY - 0.0040, 0.0030)),   # ~11 ha
        ("FLATBLOCK",  sq(CX - 0.0060, CY, HALF)),
    ]
    src = tmp / "parcels-test.jsonl"
    with src.open("w") as fh:
        for fid, geom in parcels:
            fh.write(json.dumps({"type": "Feature",
                                 "properties": {"INSPIREID": fid},
                                 "geometry": geom}) + "\n")

    ppp = load_module(tmp, tmp / "out.csv")

    # ~12 m west of RESCUE's edge, inside no parcel at all.
    bx = (CX + 0.0060) - HALF - (12 / 111320.0 / 0.61)
    ppp.fetch_points = lambda: [
        {"name": "Birmingham City Council",                 # sits inside T2
         "geom": {"type": "Point", "coordinates": [CX, CY]},
         "props": {"owner_class": "council", "titles": 5, "titles_land": 4,
                   "titles_flat": 1, "has_land": True, "postcode": "B1 1AA",
                   "address": "Land at Depot Road"}},
        {"name": "Homes England",                           # inside nothing
         "geom": {"type": "Point", "coordinates": [bx, CY]},
         "props": {"owner_class": "government", "titles": 2, "titles_land": 2,
                   "titles_flat": 0, "has_land": True, "postcode": "B1 2BB",
                   "address": "Site off Broad Street"}},
        {"name": "Flats Only Council",                      # inside FLATBLOCK
         "geom": {"type": "Point", "coordinates": [CX - 0.0060, CY]},
         "props": {"owner_class": "council", "titles": 3, "titles_land": 0,
                   "titles_flat": 3, "has_land": False, "postcode": "B1 3CC",
                   "address": "Flat 4, 19 Park Road"}},
    ]
    assert ppp.main() == 0, "matcher returned non-zero"

    rows = {r["source_id"]: (r["name"], json.loads(r["props"]))
            for r in csv.DictReader((tmp / "out.csv").open())}

    fails = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    check("pp-T2" in rows, "T2: a point inside a parcel must claim it")
    if "pp-T2" in rows:
        check(rows["pp-T2"][1]["match"] == "contains", "T2: should be 'contains'")
        check(rows["pp-T2"][0] == "Birmingham City Council", "T2: wrong owner")
        check(rows["pp-T2"][1].get("titles_flat") == 1,
              "T2: flat count should survive into props")
    for k in ("T0", "T1", "T3", "T4", "T5"):
        check(f"pp-{k}" not in rows,
              f"{k}: neighbour over-claimed by a point that is already inside T2")

    check("pp-RESCUE" in rows, "RESCUE: a point inside no parcel should be rescued")
    if "pp-RESCUE" in rows:
        check(rows["pp-RESCUE"][1]["match"] == "nearest", "RESCUE: should be 'nearest'")
        check(rows["pp-RESCUE"][1].get("match_dist_m") is not None,
              "RESCUE: should record how far the rescue reached")
    check("pp-RESCUE_FAR" not in rows,
          "RESCUE_FAR: only the single CLOSEST parcel may be rescued")

    check("pp-FARM" not in rows,
          "FARM: a >5 ha parcel with no contains-match must never be claimed")
    check("pp-FLATBLOCK" not in rows,
          "FLATBLOCK: a point whose titles are all flats must be skipped entirely")
    check(len(rows) == 2, f"expected exactly 2 parcels, got {len(rows)}: {sorted(rows)}")
    return fails


def main():
    with tempfile.TemporaryDirectory() as td:
        fails = run(Path(td))
    if fails:
        print("\nFAILED:")
        for f in fails:
            print("  -", f)
        return 1
    print("\nAll matcher rules hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
