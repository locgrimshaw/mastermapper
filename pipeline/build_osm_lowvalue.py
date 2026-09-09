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

RETAIL IS THE HARD ONE, and the first cut got it badly wrong. `landuse=retail`
in OSM is a DISTRICT tag: it blankets Oxford Street, Regent Street and Mayfair
as "retail land". `building=retail` covers every shop in the country, and
`shop=department_store` is Selfridges and Fortnum & Mason. A first pass that
took those at face value labelled the most valuable retail pitch in Europe as
underutilised. A retail shed is not a shop — it is a LARGE, LOW-RISE,
FREE-STANDING box with its own surface car park, so the classifier now demands
that evidence: an out-of-town format, or a big low-rise footprint with parking
beside it, or a name that says retail park. Prime high-street retail has no
adjacent surface parking and is rarely under three storeys, so it drops out.

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
import re
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

# A shed is low-rise. Anything at or above this is a building, not a shed, and
# is dropped from the shed classes outright (OSM building:levels / height).
MAX_SHED_LEVELS = 3
MAX_SHED_HEIGHT_M = 11.0
# Free-standing retail carries its own surface parking. Prime high-street
# retail does not — this is the discriminator that keeps Oxford Street out.
RETAIL_PARKING_R_M = 70.0
MIN_RETAIL_SHED_M2 = 1500.0
# The car park has to look like a shed's car park, not a city service yard.
MIN_SHED_PARKING_M2 = 1000.0

# Names that positively identify an out-of-town retail format.
RETAIL_PARK_RE = re.compile(
    r"retail park|shopping park|retail centre|retail center|trade park|"
    r"trading estate|outlet|superstore|leisure park|business park", re.I)

# Formats that are inherently out-of-town/low-rise whatever else they carry.
BIG_BOX_SHOPS = {"doityourself", "garden_centre", "trade", "wholesale",
                 "car", "caravan", "agrarian", "builders_merchant"}
# Prime assets that must never be classed as underutilised: a department store
# is a landmark, not a shed.
NEVER_RETAIL_SHOPS = {"department_store", "mall"}

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


def levels_of(t):
    """Storeys from OSM, or None. building:levels is sparse but reliable."""
    for k in ("building:levels", "levels"):
        v = t.get(k)
        if v is None:
            continue
        try:
            return int(float(str(v).split(";")[0].split(",")[0]))
        except Exception:
            pass
    h = height_of(t)
    if h is not None:
        return max(1, int(round(h / 3.2)))
    return None


def height_of(t):
    for k in ("height", "building:height"):
        v = t.get(k)
        if v is None:
            continue
        try:
            return float(str(v).replace("m", "").strip())
        except Exception:
            pass
    return None


def is_lowrise(t):
    """True unless OSM positively says this is a multi-storey building."""
    lv = levels_of(t)
    if lv is not None and lv >= MAX_SHED_LEVELS:
        return False
    h = height_of(t)
    if h is not None and h >= MAX_SHED_HEIGHT_M:
        return False
    return True


def classify(t, area=0.0, near_parking=False):
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

    # --- 3b. filling stations: small, self-contained, classic infill --------
    if amen == "fuel":
        return "osm_retail", "fuel"

    # --- 4. retail sheds & parks -------------------------------------------
    # Three gates, because OSM's retail tags describe SHOPS and DISTRICTS, not
    # redevelopment opportunities (see the note at the top of this file).
    is_retailish = (lu == "retail" or bld in ("retail", "supermarket") or shop)
    if is_retailish:
        if shop in NEVER_RETAIL_SHOPS:
            return None, None                  # department stores are landmarks
        if not is_lowrise(t):
            return None, None                  # 3+ storeys is a building, not a shed
        nm = t.get("name") or ""
        # (a) the name says out-of-town format — the only case where the
        #     landuse=retail DISTRICT tag can be trusted on its own
        if RETAIL_PARK_RE.search(nm):
            return "osm_retail", "retail_park"
        # (b) formats that are inherently big-box wherever they sit
        if shop in BIG_BOX_SHOPS:
            return "osm_retail", shop
        # (c) a large low-rise box WITH its own surface parking beside it.
        #     Prime high-street retail fails this: no adjacent surface car park.
        #     NOTE: landuse=retail is deliberately NOT eligible here. It is a
        #     land-use DISTRICT covering whole retail quarters, and letting it
        #     qualify on nearby parking put 11,054 districts — including six
        #     in the West End — into the layer. It qualifies by name only.
        if area >= MIN_RETAIL_SHED_M2 and near_parking:
            if bld in ("retail", "supermarket"):
                return "osm_retail", bld
            if shop in ("supermarket", "furniture", "hardware"):
                return "osm_retail", shop
        # anything else retail-tagged is a shop or a district, not a site
        if lu == "retail" or bld in ("retail", "supermarket") or shop:
            return None, None

    # --- 5. industrial land & sheds ----------------------------------------
    if lu == "industrial":
        return "osm_industrial", "industrial_land"
    if bld in ("industrial", "warehouse", "factory", "manufacture", "hangar"):
        return ("osm_industrial", bld) if is_lowrise(t) else (None, None)

    # --- 6. large low-density leisure — explicitly NOT PDL -----------------
    if leis in ("golf_course", "driving_range", "track", "water_park", "marina"):
        return "osm_leisure_lowdensity", leis
    if shop == "garden_centre":
        return "osm_leisure_lowdensity", "garden_centre"
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


def _centroid(polys):
    r = polys[0][0]
    n = max(1, len(r) - 1)
    return sum(p[0] for p in r[:n]) / n, sum(p[1] for p in r[:n]) / n


def build_parking_index(path):
    """Pass 1 — surface car park centroids on a ~100 m grid.

    Free-standing retail has its own parking; prime high-street retail does
    not. That single fact is what keeps Oxford Street out of the shed class,
    so the parking pass runs before anything is classified.
    """
    grid, n = {}, 0
    with path.open() as fh:
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if not line or line[0] != "{" or '"parking"' not in line:
                continue
            try:
                f = json.loads(line)
            except Exception:
                continue
            t = f.get("properties") or {}
            if t.get("amenity") != "parking":
                continue
            if (t.get("parking") or "surface") in ("multi-storey", "underground", "rooftop"):
                continue
            g = f.get("geometry") or {}
            gt = g.get("type")
            polys = [g["coordinates"]] if gt == "Polygon" else g.get("coordinates") if gt == "MultiPolygon" else None
            if not polys:
                continue
            lon, lat = _centroid(polys)
            a = sum(poly_area_m2(p, lat) for p in polys)
            grid.setdefault((int(lon * 1000), int(lat * 1000)), []).append((lon, lat, a))
            n += 1
    print(f"parking index: {n:,} surface car parks")
    return grid


def near_parking_fn(grid):
    """Is there a car park of at least `min_area` within `radius_m`?

    Size matters as much as proximity: a retail shed's car park is thousands
    of square metres, while a West End block may have a small service yard
    mapped nearby. Requiring a SUBSTANTIAL car park is what separates them.
    """
    def near(lon, lat, radius_m=RETAIL_PARKING_R_M, min_area=MIN_SHED_PARKING_M2):
        kx = 111320.0 * math.cos(math.radians(lat))
        gx, gy = int(lon * 1000), int(lat * 1000)
        for ax in (gx - 1, gx, gx + 1):
            for ay in (gy - 1, gy, gy + 1):
                for (plon, plat, pa) in grid.get((ax, ay), ()):
                    if pa < min_area:
                        continue
                    if math.hypot((plon - lon) * kx, (plat - lat) * 110540.0) <= radius_m:
                        return True
        return False
    return near


def main():
    if not SRC.exists():
        sys.exit(f"missing input {SRC} — run the osmium export step first")
    OUT.parent.mkdir(parents=True, exist_ok=True)

    near = near_parking_fn(build_parking_index(SRC))

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
            lat0 = polys[0][0][0][1]
            area = sum(poly_area_m2(p, lat0) for p in polys)
            if area < MIN_AREA_M2:
                continue
            # retail is the only class that needs the parking context, and the
            # lookup is not free — only pay for it on retail-tagged features
            ctx = False
            if (t.get("landuse") == "retail" or t.get("shop")
                    or t.get("building") in ("retail", "supermarket")):
                lon0, la0 = _centroid(polys)
                ctx = near(lon0, la0)
            cls, subtype = classify(t, area, ctx)
            if not cls:
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
