"""
build_osm_lowvalue.py
---------------------
Turns an OpenStreetMap extract into the "low-value / lightly developed land"
overlay datasets — the built-form lens of docs/PLAN_BROWNFIELD.md.

The point of this layer family is to find redevelopment candidates that no
brownfield register contains: the industrial shed on 2 ha, the surface car
park behind the high street, the depot, the lock-ups, the gasholder site.

WHY THESE CLASSES. NPPF (Aug 2026) Annex B defines previously developed land
as land "occupied by a permanent structure … including the curtilage", and
expressly "includes land comprising large areas of fixed surface
infrastructure such as large areas of hardstanding which have been lawfully
developed" — which is what brings surface car parks and open storage yards in
as PDL. Policy L2(1)(b) then gives "substantial weight" to proposals making
better use of "vacant and underutilised land and buildings (such as … 
redeveloping underutilised retail and business sites; and building on or above
service yards, lock-ups, car parks and other transport infrastructure which
are no longer required)". Each class below carries the policy hook it answers.

Annex B also EXCLUDES from PDL: residential gardens, parks, recreation grounds
and allotments in built-up areas; land last occupied by agricultural or
forestry buildings; and land where restoration has been secured. Those are
applied as hard filters, not scored afterwards — a coverage-driven model with
no exclusions surfaces every school field and allotment in England.

Golf courses, driving ranges and garden centres are large and low-value but
are NOT previously developed land unless they carry permanent structures, so
they get their own class flagged `pdl: false` rather than being mixed in.

INPUT   GeoJSON Text Sequence (one Feature per line) written by:
            osmium tags-filter <extract>.osm.pbf \
              w/landuse w/amenity=parking w/building w/man_made w/leisure \
              w/shop w/industrial -o filtered.osm.pbf
            osmium export filtered.osm.pbf -f geojsonseq -a id,type \
              --geometry-types=polygon -o osm_lowvalue.geojsonl
        (the workflow does this; the network policy on dev containers blocks
        Geofabrik, so extraction only runs in CI)

OUTPUT  supabase/datasets_import.csv — the format loaders/load_datasets.py
        already consumes: dataset, source_id, name, props, geom_wkt

Licence: OpenStreetMap contributors, ODbL 1.0. Attribution is required and
share-alike attaches to derived DATABASES — rendering these on a map is a
Produced Work, which is fine, but keep the class separable from the OGL
layers so it can be stripped if the licence ever becomes awkward.
"""

import csv
import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ.get("OSM_LV_SRC") or (ROOT / "data" / "raw" / "osm_lowvalue.geojsonl"))
OUT = Path(os.environ.get("OSM_LV_OUT") or (ROOT / "supabase" / "datasets_import.csv"))

# Smallest site worth showing. 1,000 m² keeps the lock-up court and the
# corner car park (both genuine infill candidates) and drops garage plots.
MIN_AREA_M2 = float(os.environ.get("OSM_LV_MIN_AREA", "1000"))

# NPPF Annex B exclusions + obvious non-candidates. Checked FIRST.
EXCLUDE_LANDUSE = {
    "allotments", "cemetery", "grave_yard", "forest", "farmland", "farmyard",
    "meadow", "orchard", "vineyard", "grass", "greenfield", "village_green",
    "recreation_ground", "residential", "religious", "military", "education",
    "flowerbed", "plant_nursery", "conservation", "salt_pond", "aquaculture",
}
EXCLUDE_LEISURE = {
    "park", "garden", "nature_reserve", "playground", "pitch", "sports_centre",
    "recreation_ground", "common", "dog_park", "fitness_station",
}

# class -> (label, previously-developed-land status, NPPF policy hook)
CLASS_META = {
    "osm_industrial": ("Industrial land & sheds", True, "L2(1)(b) underutilised business sites"),
    "osm_retail":     ("Retail sheds & parks", True, "L2(1)(b) underutilised retail sites"),
    "osm_parking":    ("Surface car parks", True, "L2(1)(b) car parks no longer required"),
    "osm_storage":    ("Yards, depots & lock-ups", True, "L2(1)(b) service yards and lock-ups"),
    "osm_brownfield": ("Brownfield, works & mineral land", True, "L2(1)(a) despoiled/derelict land"),
    "osm_leisure_lowdensity": ("Low-density leisure (not PDL)", False, "not previously developed land"),
}


def classify(t):
    """OSM tags -> (dataset class, subtype) or (None, None). First match wins."""
    lu = t.get("landuse")
    bld = t.get("building")
    amen = t.get("amenity")
    mm = t.get("man_made")
    leis = t.get("leisure")
    shop = t.get("shop")
    ind = t.get("industrial")

    # --- NPPF Annex B exclusions, applied before anything is scored ---------
    if lu in EXCLUDE_LANDUSE:
        return None, None
    if leis in EXCLUDE_LEISURE:
        return None, None
    if bld in ("house", "residential", "apartments", "detached", "semidetached_house",
               "terrace", "bungalow", "farm", "barn", "greenhouse", "stable",
               "church", "school", "hospital", "cathedral", "chapel", "mosque"):
        return None, None
    if t.get("abandoned") == "yes" and lu is None and bld is None:
        return None, None

    # --- 1. declared brownfield, works, mineral & waste land ---------------
    if lu in ("brownfield", "construction"):
        return "osm_brownfield", lu
    if lu in ("quarry", "landfill"):
        return "osm_brownfield", lu
    if mm in ("works", "wastewater_plant", "water_works"):
        return "osm_brownfield", "works"

    # --- 2. yards, depots, lock-ups, gasholders ----------------------------
    if lu in ("depot", "garages", "port"):
        return "osm_storage", lu
    if ind in ("depot", "scrap_yard", "yard", "distribution", "warehouse"):
        return "osm_storage", ind
    if mm in ("gasometer", "storage_tank", "silo"):
        return "osm_storage", mm
    if amen in ("recycling", "waste_transfer_station", "waste_disposal") and lu is None:
        return "osm_storage", "waste"

    # --- 3. surface car parks (hardstanding = PDL under Annex B) -----------
    if amen == "parking":
        pk = (t.get("parking") or "surface").lower()
        if pk in ("multi-storey", "underground", "rooftop", "sheds", "carports",
                  "garage_boxes", "lane", "street_side"):
            return None, None
        return "osm_parking", ("park_and_ride" if t.get("park_ride") not in (None, "no") else pk)

    # --- 4. retail sheds & parks -------------------------------------------
    if lu == "retail":
        return "osm_retail", "retail_land"
    if bld in ("retail", "supermarket", "kiosk"):
        return "osm_retail", bld
    if shop in ("supermarket", "doityourself", "department_store", "furniture",
                "car", "trade", "wholesale", "hardware"):
        return "osm_retail", shop

    # --- 5. industrial land & sheds ----------------------------------------
    if lu == "industrial":
        return "osm_industrial", "industrial_land"
    if bld in ("industrial", "warehouse", "factory", "manufacture", "hangar"):
        return "osm_industrial", bld

    # --- 6. large low-density leisure — explicitly NOT PDL -----------------
    if leis in ("golf_course", "driving_range", "track", "water_park", "marina"):
        return "osm_leisure_lowdensity", leis
    if shop == "garden_centre":
        return "osm_leisure_lowdensity", "garden_centre"
    if amen == "fuel":
        return "osm_retail", "fuel"

    return None, None


def ring_area_m2(ring, lat0):
    """Planar shoelace in local metres — accurate enough for a size filter."""
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[i + 1][0] * kx, ring[i + 1][1] * ky
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def poly_area_m2(coords, lat0):
    """Outer ring minus holes."""
    if not coords:
        return 0.0
    a = ring_area_m2(coords[0], lat0)
    for hole in coords[1:]:
        a -= ring_area_m2(hole, lat0)
    return max(0.0, a)


def wkt_polys(polys):
    def ring(r):
        return "(" + ",".join(f"{p[0]:.6f} {p[1]:.6f}" for p in r) + ")"
    return "SRID=4326;MULTIPOLYGON(" + ",".join(
        "(" + ",".join(ring(r) for r in poly) + ")" for poly in polys) + ")"


def main():
    if not SRC.exists():
        sys.exit(f"missing input {SRC} — run the osmium export step first")
    OUT.parent.mkdir(parents=True, exist_ok=True)

    counts, kept, seen = {}, 0, set()
    with SRC.open() as fh, OUT.open("w", newline="") as out:
        w = csv.writer(out)
        w.writerow(["dataset", "source_id", "name", "props", "geom_wkt"])
        for lineno, line in enumerate(fh, 1):
            line = line.strip().lstrip("\x1e")     # GeoJSONSeq record separator
            if not line or line[0] != "{":
                continue
            try:
                f = json.loads(line)
            except Exception:
                continue
            g = f.get("geometry") or {}
            gt = g.get("type")
            if gt == "Polygon":
                polys = [g["coordinates"]]
            elif gt == "MultiPolygon":
                polys = g["coordinates"]
            else:
                continue
            t = f.get("properties") or {}
            cls, subtype = classify(t)
            if not cls:
                continue

            lat0 = polys[0][0][0][1]
            area = sum(poly_area_m2(p, lat0) for p in polys)
            if area < MIN_AREA_M2:
                continue

            oid = str(t.get("@id") or t.get("id") or t.get("osm_id") or f"L{lineno}")
            otype = str(t.get("@type") or t.get("type") or "w")[:1]
            sid = f"osm-{otype}{oid}"
            if sid in seen:
                continue
            seen.add(sid)

            label, pdl, hook = CLASS_META[cls]
            levels = t.get("building:levels")
            try:
                levels = int(float(levels)) if levels is not None else None
            except Exception:
                levels = None
            props = {
                "cls": cls, "kind": label, "subtype": subtype,
                "area_m2": int(round(area)), "ha": round(area / 1e4, 3),
                "pdl": pdl, "hook": hook,
            }
            if levels:
                props["levels"] = levels
            if t.get("operator"):
                props["operator"] = t["operator"][:120]
            name = (t.get("name") or label)[:180]

            w.writerow([cls, sid, name, json.dumps(props, separators=(",", ":")),
                        wkt_polys(polys)])
            counts[cls] = counts.get(cls, 0) + 1
            kept += 1

    print(f"wrote {kept:,} features -> {OUT}")
    for k in sorted(counts, key=lambda x: -counts[x]):
        print(f"  {k:26s} {counts[k]:>8,}")


if __name__ == "__main__":
    main()
