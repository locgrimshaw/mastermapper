"""
build_constraints.py
---------------------
Builds the "erase"/overlay polygon layers for the station developable-land
analysis and writes them to a Supabase-ready import CSV:

    supabase/constraints_import.csv

These layers populate the `public.planning_constraints` table (see
supabase/migrations/0005_planning_constraints_and_developable_land.sql). The
`developable_land_near_station` RPC buffers an 800 m catchment around a station
and ERASES the selected constraint kinds from it, so we only ever need
constraint geometry that sits WITHIN ~800 m of a rail station.

CRITICAL DESIGN CONSTRAINT — clip to station catchments.
The Supabase DB is on the free tier (~500 MB), so we must NOT store national
polygon layers. This pipeline reads the station points from
web/data/stations.geojson, buffers each by 1000 m (a little beyond the 800 m
analysis radius, for safety) in EPSG:27700, unions them into ONE clip mask, and
intersects EVERY constraint layer with that mask before output. National
datasets shrink to a thin sliver around the rail network.

kinds produced: built_land, green_space, transport, flood_zone_2,
flood_zone_3, green_belt, plus the Gate-3 heritage/environmental designations
from planning.data.gov.uk (all OGL, already EPSG:4326):
  hard exclusions: sssi, sac, spa, ramsar, ancient_woodland, scheduled_monument
  soft constraints: conservation_area, aonb, park_garden, listed_building
The heritage/environmental kinds share ONE generic builder (build_planning_data)
since every planning.data.gov.uk dataset is a uniform WGS84 GeoJSON — see
PLANNING_DATA_KINDS for the kind->dataset-slug map.

DATA SOURCES (all Open Government Licence v3.0). Most OS data is EPSG:27700
British National Grid and is reprojected to EPSG:4326 here. Downloads are large;
commit them under data/raw/ (allowlisted in .gitignore) or fetch them in CI.
The file paths are configurable per source via env var; the defaults are shown.

  built_land   OS Open Built Up Areas (polygon). EPSG:27700.
               https://osdatahub.os.uk/downloads/open/BuiltUpAreas
               env BUILT_LAND_SRC   default data/raw/os_open_built_up_areas.gpkg

  green_space  OS Open Greenspace — the "Greenspace Site" POLYGON layer
               (Access Points are ignored). EPSG:27700.
               https://osdatahub.os.uk/downloads/open/OpenGreenspace
               env GREEN_SPACE_SRC  default data/raw/os_open_greenspace.gpkg

  transport    OS OpenMap Local — Road (centrelines/polygons) + Railway lines.
               Line features are buffered in EPSG:27700 by a half-width based on
               classification (motorway 15 m, A-road 9 m, B/minor 5 m,
               local/residential 4 m, rail 6 m). Road *polygons* are kept as-is.
               Road + rail merge into kind='transport'. EPSG:27700.
               https://osdatahub.os.uk/downloads/open/OpenMapLocal
               env TRANSPORT_ROAD_SRC / TRANSPORT_RAIL_SRC
               default data/raw/os_openmap_local.gpkg (both layers in one GPKG)

  flood_zone_2 EA Flood Map for Planning (Rivers and Sea) Flood Zones — polygon.
  flood_zone_3 Either two per-zone files, OR one combined file with a zone
               attribute (auto-split). EPSG:27700.
               https://environment.data.gov.uk/ (Defra Data Services Platform)
               env FLOOD_ZONE_2_SRC default data/raw/ea_flood_zone_2.gpkg
               env FLOOD_ZONE_3_SRC default data/raw/ea_flood_zone_3.gpkg
               env FLOOD_ZONES_SRC  (combined) default data/raw/ea_flood_zones.gpkg

  green_belt   planning.data.gov.uk green-belt (polygon). ALREADY EPSG:4326 —
               no reprojection of the source coordinates.
               https://www.planning.data.gov.uk/dataset/green-belt
               env GREEN_BELT_SRC   default data/raw/green-belt.geojson

Each source is OPTIONAL: if its file is not present the kind is skipped with a
warning, so partial runs work. Choose which kinds to build with --kinds
(comma-separated) or the CONSTRAINT_KINDS env var; default is all.

OUTPUT columns (supabase/constraints_import.csv):
    kind, source_id, name, props (JSON string), geom_wkt
where geom_wkt is EWKT: 'SRID=4326;MULTIPOLYGON(...)'. Only features that
intersect the station-buffer mask are written. source_id is a stable per-feature
id taken from the source where available; where the source has no per-feature id
we derive a deterministic id from a hash of kind+geometry, so re-runs upsert
idempotently on (kind, source_id) instead of duplicating.

Run (or let the Action run it — see .github/workflows/load-constraints.yml):
    python pipeline/build_constraints.py
    python pipeline/build_constraints.py --kinds built_land,transport
"""

import argparse
import csv
import hashlib
import json
import os
import sys
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely import make_valid, to_wkt
from shapely.geometry import MultiPolygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "constraints_import.csv"
STATIONS = ROOT / "web" / "data" / "stations.geojson"

# Clip radius around each station. A little beyond the 800 m analysis radius so
# the erase never runs out of geometry at the catchment edge.
BUFFER_M = 1000
# Light geometry clean-up (metres, in EPSG:27700) to keep the CSV small. Small
# enough not to move the developable-area numbers meaningfully.
SIMPLIFY_M = 1.0
# Coordinate precision kept in the output WKT (~0.1 m at 6 dp).
COORD_DP = 6

ALL_KINDS = ["built_land", "green_space", "transport",
             "flood_zone_2", "flood_zone_3", "green_belt",
             # Gate 3 heritage/environmental designations (planning.data.gov.uk,
             # all OGL v3.0, all already EPSG:4326). Hard exclusions remove land;
             # soft constraints are retained and feed the friction score.
             # hard:
             "sssi", "sac", "spa", "ramsar", "ancient_woodland", "scheduled_monument",
             # soft:
             "conservation_area", "aonb", "park_garden", "listed_building"]

# The new Gate-3 kinds are all planning.data.gov.uk national datasets served as
# EPSG:4326 GeoJSON at https://files.planning.data.gov.uk/dataset/<slug>.geojson —
# so they build with ONE generic builder (mirrors build_green_belt): read WGS84,
# reproject to 27700 only for the station-catchment clip, emit MultiPolygons.
#   kind -> (dataset-slug, [prop columns to keep])
PLANNING_DATA_KINDS = {
    # Hard exclusions (statutory environmental designations).
    "sssi":               ("site-of-special-scientific-interest", ["reference", "entity"]),
    "sac":                ("special-area-of-conservation",        ["reference", "entity"]),
    "spa":                ("special-protection-area",             ["reference", "entity"]),
    "ramsar":             ("ramsar",                              ["reference", "entity"]),
    "ancient_woodland":   ("ancient-woodland",                    ["reference", "entity"]),
    "scheduled_monument": ("scheduled-monument",                  ["reference", "entity"]),
    # Soft constraints (heritage/landscape — retained, penalised via friction).
    "conservation_area":  ("conservation-area",                   ["reference", "entity"]),
    "aonb":               ("area-of-outstanding-natural-beauty",  ["reference", "entity"]),
    "park_garden":        ("park-and-garden",                     ["reference", "entity"]),
    # listed-building-outline is the polygon layer (the plain listed-building
    # dataset is points); use it as a soft/setting proxy where coverage exists.
    "listed_building":    ("listed-building-outline",             ["reference", "entity"]),
}

# Transport half-widths (metres) applied to LINE features before reprojecting.
# Rail is buffered wider than a single track to approximate railway CURTILAGE
# (the operational corridor: paired tracks, ballast, embankment/cutting, boundary
# fence) rather than a hairline centreline — so it reads as a real development
# barrier. ~12 m half-width ≈ a 24 m corridor.
RAIL_HALF_WIDTH = 12.0

# --- generic column matching -------------------------------------------------
# A per-feature id, in priority order. Used for a stable source_id / upsert key.
ID_CANDIDATES = [
    "source_id", "reference", "entity", "id", "gml_id", "os_id", "osid",
    "toid", "gsscode", "gss_code", "uid", "fid", "objectid", "ogc_fid",
]
NAME_CANDIDATES = [
    "name", "distinctivename1", "distinctive_name1", "name1", "name1_text",
    "site_name", "sitename", "distinctivename2", "function", "flood_zone",
]
CLASS_CANDIDATES = [
    "classification", "class", "roadclass", "road_class", "featurecode",
    "legend", "drawlevel",
]


def _find_col(gdf, candidates):
    """Case-insensitive lookup of the first candidate column present."""
    lower = {c.lower(): c for c in gdf.columns if c != "geometry"}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def _src_path(env_var, default_names):
    """Resolve a source file: an explicit env path, else the first existing
    default under data/raw/. Returns a Path or None."""
    cands = []
    v = os.environ.get(env_var, "").strip()
    if v:
        cands.append(Path(v))
    cands += [RAW / n for n in default_names]
    for p in cands:
        if p and p.exists():
            return p
    return None


def _pick_layer(path, candidates):
    """For a multi-layer container (GeoPackage), return the layer name matching
    one of the candidates (exact, then substring). None for single-layer files
    like Shapefile/GeoJSON, or when no candidate matches."""
    if path.suffix.lower() not in (".gpkg", ".gdb"):
        return None
    layers = []
    try:
        import pyogrio
        layers = [row[0] for row in pyogrio.list_layers(path)]
    except Exception:
        try:
            import fiona
            layers = list(fiona.listlayers(str(path)))
        except Exception:
            return None
    low = {l.lower(): l for l in layers}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    for c in candidates:
        for l in layers:
            if c.lower() in l.lower():
                return l
    # Fall back to the first layer so a single-layer GPKG still reads.
    return layers[0] if layers else None


def _read_source(path, layer, mask_geom):
    """Read a vector source, spatially pre-filtered to the mask where the driver
    supports it (keeps the read tiny). Falls back to a full read on error."""
    kwargs = {}
    if layer:
        kwargs["layer"] = layer
    try:
        return gpd.read_file(path, mask=mask_geom, **kwargs)
    except Exception as exc:
        print(f"    (mask-filtered read unavailable: {exc}; reading full layer)")
        return gpd.read_file(path, **kwargs)


def _to_27700(gdf, assume_epsg=27700):
    """Ensure a GeoDataFrame is in EPSG:27700 (assume British National Grid when
    the CRS is missing, unless told otherwise)."""
    if gdf.crs is None:
        gdf = gdf.set_crs(assume_epsg)
    try:
        if gdf.crs.to_epsg() != 27700:
            gdf = gdf.to_crs(27700)
    except Exception:
        gdf = gdf.to_crs(27700)
    return gdf


def _jsonable(v):
    """Coerce a cell value (possibly a numpy scalar) to a JSON-serialisable one."""
    if v is None:
        return None
    if isinstance(v, (str, bool, int, float)):
        return v
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    # numpy integer/float expose .item(); everything else -> str.
    item = getattr(v, "item", None)
    if callable(item):
        try:
            return item()
        except Exception:
            pass
    return str(v)


def _to_multipolygon(geom):
    """Return a (non-empty) shapely MultiPolygon for any polygonal input, or
    None. GeometryCollections keep only their polygonal parts."""
    if geom is None or geom.is_empty:
        return None
    gt = geom.geom_type
    if gt == "Polygon":
        return MultiPolygon([geom])
    if gt == "MultiPolygon":
        return geom
    if gt == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        merged = unary_union(polys)
        return _to_multipolygon(merged)
    return None


def _cell(feat, col):
    """A cleaned string value for a feature column, or '' when absent/NaN."""
    if not col or col not in feat:
        return ""
    v = feat[col]
    if v is None:
        return ""
    try:
        if pd.isna(v):
            return ""
    except (TypeError, ValueError):
        pass
    return str(v).strip()


def _stable_id(kind, ewkt):
    """Deterministic id from kind+geometry, for sources lacking a feature id."""
    h = hashlib.md5(ewkt.encode("utf-8")).hexdigest()[:16]
    return f"{kind}-{h}"


def build_clip_mask():
    """Union of 1000 m station buffers, as one shapely geometry in EPSG:27700."""
    if not STATIONS.exists():
        print(f"ERROR: station file not found: {STATIONS}")
        return None
    print(f"Reading stations from {STATIONS.relative_to(ROOT)} ...")
    stations = gpd.read_file(STATIONS)
    stations = stations[stations.geometry.notna() & ~stations.geometry.is_empty]
    if stations.crs is None:
        stations = stations.set_crs(4326)
    n = len(stations)
    stations = stations.to_crs(27700)
    print(f"  {n} stations; buffering by {BUFFER_M} m and unioning into a mask...")
    mask = unary_union(list(stations.buffer(BUFFER_M)))
    mask = make_valid(mask)
    return mask


def _finish(gdf, kind, mask_27700, prop_cols=None, id_col=None, name_col=None,
            dissolve=False):
    """Shared tail: clip to the mask (EPSG:27700), simplify lightly, reproject to
    4326, and emit one row per surviving feature. Returns a list of row dicts.

    dissolve=True first unions everything into merged geometry and emits its
    constituent polygons instead of one row per input feature — essential for
    dense line layers (roads/rail) where per-segment rows would explode the row
    count. Per-feature props are dropped when dissolving."""
    if gdf is None or gdf.empty:
        return []
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    if gdf.empty:
        return []

    if id_col is None:
        id_col = _find_col(gdf, ID_CANDIDATES)
    if name_col is None:
        name_col = _find_col(gdf, NAME_CANDIDATES)

    # Repair invalid geometry before the spatial ops.
    gdf = gdf.copy()
    gdf["geometry"] = gdf.geometry.make_valid()

    # Clip to the station-buffer mask — this is what keeps volume tiny.
    try:
        gdf = gpd.clip(gdf, mask_27700, keep_geom_type=False)
    except Exception as exc:
        print(f"    clip failed ({exc}); falling back to per-feature intersection")
        gdf["geometry"] = gdf.geometry.intersection(mask_27700)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    if gdf.empty:
        return []

    # Merge everything into one geometry then split back into its parts, so a
    # dense line layer becomes a handful of connected corridors rather than
    # hundreds of thousands of per-segment rows.
    if dissolve:
        merged = make_valid(unary_union(list(gdf.geometry.values)))
        parts = list(getattr(merged, "geoms", [merged]))
        gdf = gpd.GeoDataFrame({"geometry": parts}, geometry="geometry", crs=gdf.crs)
        prop_cols, id_col, name_col = None, None, None

    if SIMPLIFY_M:
        gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_M, preserve_topology=True)

    gdf = gdf.to_crs(4326)

    rows = []
    seen_ids = {}
    for _, feat in gdf.iterrows():
        mp = _to_multipolygon(feat.geometry)
        if mp is None or mp.is_empty:
            continue
        ewkt = "SRID=4326;" + to_wkt(mp, rounding_precision=COORD_DP, trim=True)

        sid = _cell(feat, id_col)
        if not sid:
            sid = _stable_id(kind, ewkt)
        # Guarantee (kind, source_id) uniqueness within this kind. Several
        # planning.data datasets reuse the same `reference`/`entity` across
        # distinct features; a duplicate (kind, source_id) in one upsert batch
        # makes Postgres reject the whole batch (21000, "ON CONFLICT DO UPDATE
        # command cannot affect row a second time"). Suffix repeats deterministically
        # (source feature order is stable, so re-runs still upsert the same rows).
        seen_ids[sid] = seen_ids.get(sid, 0) + 1
        if seen_ids[sid] > 1:
            sid = f"{sid}-{seen_ids[sid]}"

        name = _cell(feat, name_col)

        props = {}
        for c in (prop_cols or []):
            if c in feat and feat[c] not in (None, ""):
                val = _jsonable(feat[c])
                if val not in (None, ""):
                    props[c] = val

        rows.append({
            "kind": kind,
            "source_id": sid,
            "name": name,
            "props": props,
            "geom_wkt": ewkt,
        })
    return rows


def _skip(kind, human_source, env_hint):
    print(f"  [{kind}] source not found — skipping. Provide {human_source} "
          f"({env_hint}). See the module docstring / docs/DATASETS.md.")


# --- per-kind builders -------------------------------------------------------

def build_built_land(mask_27700, mask_geom_27700):
    path = _src_path("BUILT_LAND_SRC", [
        "os_open_built_up_areas.gpkg", "os_open_built_up_areas.shp",
        "os_built_up_areas.gpkg", "built_up_areas.gpkg",
        "os_open_built_up_areas.geojson",
    ])
    if not path:
        _skip("built_land", "OS Open Built Up Areas", "BUILT_LAND_SRC")
        return None
    print(f"  [built_land] reading {path.name} ...")
    layer = _pick_layer(path, ["OS_Open_Built_Up_Areas", "os_open_built_up_areas",
                               "BuiltUpArea", "built_up_areas"])
    gdf = _to_27700(_read_source(path, layer, mask_geom_27700))
    return _finish(gdf, "built_land", mask_27700,
                   prop_cols=["areahectares", "area_hectares"])


def build_green_space(mask_27700, mask_geom_27700):
    path = _src_path("GREEN_SPACE_SRC", [
        "os_open_greenspace.gpkg", "os_open_greenspace.shp",
        "opgrsp_gb.gpkg", "greenspace.gpkg", "os_open_greenspace.geojson",
    ])
    if not path:
        _skip("green_space", "OS Open Greenspace (Greenspace Site polygons)",
              "GREEN_SPACE_SRC")
        return None
    print(f"  [green_space] reading {path.name} ...")
    # The POLYGON layer only — Access Points are a separate point layer we skip.
    layer = _pick_layer(path, ["GreenspaceSite", "Greenspace_Site",
                               "greenspace_site", "greenspacesite"])
    gdf = _to_27700(_read_source(path, layer, mask_geom_27700))
    # Belt-and-braces: drop any point/line rows (e.g. if a combined layer slips
    # through); we only keep polygonal greenspace.
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return _finish(gdf, "green_space", mask_27700,
                   prop_cols=["function", "distinctivename1"])


def _buffer_transport_layer(gdf, is_rail):
    """Buffer LINE features by their classification half-width (rail is fixed);
    keep polygon features as-is. Tags each feature with constraint_type /
    road_class / half_width_m for the props. Returns a GeoDataFrame in 27700."""
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    if gdf.empty:
        return gdf

    def road_half_width(cls):
        c = str(cls or "").lower()
        if "motorway" in c:
            return 15.0
        if "a road" in c or c.strip() == "a road":
            return 9.0
        if "b road" in c:
            return 5.0
        if "minor" in c:
            return 5.0
        if any(w in c for w in ("local", "resident", "restricted", "private",
                                "access", "street", "alley", "track")):
            return 4.0
        return 4.0  # sensible default for unclassified minor/local roads

    if is_rail:
        gdf["constraint_type"] = "rail"
        gdf["road_class"] = "Rail"
        hw = pd.Series(RAIL_HALF_WIDTH, index=gdf.index, dtype=float)
    else:
        gdf["constraint_type"] = "road"
        cls_col = _find_col(gdf, CLASS_CANDIDATES)
        if cls_col:
            gdf["road_class"] = gdf[cls_col].astype(str)
            hw = gdf[cls_col].map(road_half_width).astype(float)
        else:
            gdf["road_class"] = "Road"
            hw = pd.Series(4.0, index=gdf.index, dtype=float)
    gdf["half_width_m"] = hw

    geom_type = gdf.geometry.geom_type
    is_line = geom_type.isin(["LineString", "MultiLineString"])
    geoms = gdf.geometry.copy()
    if is_line.any():
        # Per-feature buffer distance, aligned positionally to the line subset.
        buffered = gdf.loc[is_line].geometry.buffer(
            hw[is_line].to_numpy(dtype=float), cap_style=1)
        geoms.loc[is_line] = buffered
    gdf["geometry"] = geoms
    # Keep only polygonal results (buffered lines + native road polygons).
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return gdf


def build_transport(mask_27700, mask_geom_27700):
    default_openmap = [
        "os_openmap_local.gpkg", "os_open_map_local.gpkg",
        "opmplc_gb.gpkg", "openmap_local.gpkg",
    ]
    road_path = _src_path("TRANSPORT_ROAD_SRC", default_openmap)
    rail_path = _src_path("TRANSPORT_RAIL_SRC", default_openmap)
    if not road_path and not rail_path:
        _skip("transport", "OS OpenMap Local (Road + RailwayTrack)",
              "TRANSPORT_ROAD_SRC / TRANSPORT_RAIL_SRC")
        return None

    rows = []
    if road_path:
        print(f"  [transport] reading roads from {road_path.name} ...")
        rlayer = _pick_layer(road_path, ["Road", "road", "OpenMapLocal_Road",
                                         "Roads"])
        roads = _to_27700(_read_source(road_path, rlayer, mask_geom_27700))
        # A/B roads + motorways. Minor/residential/local streets are excluded —
        # they aren't meaningful barriers to development and their volume (hundreds
        # of thousands of segments near stations) makes the build intractable.
        cls_col = _find_col(roads, CLASS_CANDIDATES)
        if cls_col is not None:
            low = roads[cls_col].astype(str).str.lower()
            roads = roads[low.str.contains(
                "motorway|a road|b road|primary|trunk|secondary", na=False)]
            print(f"    kept {len(roads)} A/B/motorway-road features")
        roads = _buffer_transport_layer(roads, is_rail=False)
        # dissolve=True: merge buffered roads into corridors (few rows, not 100k+).
        rows += _finish(roads, "transport", mask_27700, dissolve=True)
    if rail_path:
        print(f"  [transport] reading railway from {rail_path.name} ...")
        elayer = _pick_layer(rail_path, ["RailwayTrack", "Railway",
                                         "railwaytrack", "OpenMapLocal_RailwayTrack",
                                         "RailwayTrackSide", "Rail"])
        print(f"    rail layer picked: {elayer!r}")
        rail = _to_27700(_read_source(rail_path, elayer, mask_geom_27700))
        # A silently-empty masked read (0 rows, no exception) leaves rail out
        # entirely — the bug that dropped railway curtilage before. Fall back to a
        # full read (then the mask clip in _finish still trims it) and report.
        if rail is None or rail.empty:
            print("    masked rail read returned 0 features — retrying full read")
            rail = _to_27700(gpd.read_file(rail_path, **({"layer": elayer} if elayer else {})))
        print(f"    read {0 if rail is None else len(rail)} rail features")
        rail = _buffer_transport_layer(rail, is_rail=True)
        print(f"    {0 if rail is None else len(rail)} rail features after buffering to curtilage")
        rows += _finish(rail, "transport", mask_27700, dissolve=True)
    return rows


def build_flood(zone, mask_27700, mask_geom_27700, mask_geom_4326):
    kind = f"flood_zone_{zone}"
    per = _src_path(f"FLOOD_ZONE_{zone}_SRC", [
        f"ea_flood_zone_{zone}.gpkg", f"ea_flood_zone_{zone}.shp",
        f"ea_flood_zone_{zone}.geojson", f"flood_zone_{zone}.gpkg",
        f"flood_zone_{zone}.shp",
    ])
    combined = _src_path("FLOOD_ZONES_SRC", [
        # planning.data.gov.uk flood-risk-zone (EA Flood Map for Planning,
        # already EPSG:4326) — split by its flood-risk-level attribute below.
        "flood-risk-zone.geojson", "flood_risk_zone.geojson",
        "ea_flood_zones.gpkg",
        "flood_map_for_planning_rivers_and_sea_flood_zones.gpkg",
        "ea_flood_zones.geojson",
    ])

    if per:
        print(f"  [{kind}] reading {per.name} ...")
        layer = _pick_layer(per, [f"Flood_Zone_{zone}", f"flood_zone_{zone}",
                                  f"Flood_Map_for_Planning_Rivers_and_Sea_Flood_Zone_{zone}"])
        gdf = _to_27700(_read_source(per, layer, mask_geom_27700))
    elif combined:
        # planning.data flood-risk-zone is EPSG:4326; EA bulk files are 27700.
        # The mask used for the read filter must match the source CRS.
        is_wgs84 = (combined.suffix.lower() in (".geojson", ".json")
                    or "flood-risk-zone" in combined.name.lower())
        read_mask = mask_geom_4326 if is_wgs84 else mask_geom_27700
        print(f"  [{kind}] reading {combined.name} (splitting by zone attribute) ...")
        gdf = _to_27700(_read_source(combined, None, read_mask),
                        assume_epsg=(4326 if is_wgs84 else 27700))
        zcol = _find_col(gdf, ["flood-risk-level", "flood_risk_level",
                               "flood-risk-type", "flood_zone", "zone",
                               "flood_zone_type", "flood_source", "type", "layer"])
        if zcol:
            gdf = gdf[gdf[zcol].astype(str).str.contains(str(zone), na=False)]
        else:
            print(f"    WARNING: no zone attribute found in {combined.name}; "
                  f"cannot split — skipping {kind}.")
            return None
    else:
        _skip(kind, "EA Flood Map for Planning Flood Zones (or planning.data flood-risk-zone)",
              f"FLOOD_ZONE_{zone}_SRC or FLOOD_ZONES_SRC")
        return None

    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return _finish(gdf, kind, mask_27700,
                   prop_cols=["flood-risk-level", "flood_source", "type"])


def build_green_belt(mask_27700, mask_geom_4326):
    path = _src_path("GREEN_BELT_SRC", [
        "green-belt.geojson", "green_belt.geojson", "green-belt.json",
        "green_belt.gpkg", "green-belt.gpkg",
    ])
    if not path:
        _skip("green_belt", "planning.data.gov.uk green-belt", "GREEN_BELT_SRC")
        return None
    print(f"  [green_belt] reading {path.name} ...")
    # Source coordinates are already EPSG:4326 — the mask for the read filter is
    # supplied in 4326; we only reproject to 27700 for the clip step itself.
    gdf = _read_source(path, None, mask_geom_4326)
    gdf = _to_27700(gdf, assume_epsg=4326)
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return _finish(gdf, "green_belt", mask_27700,
                   prop_cols=["reference", "entity", "green-belt-core",
                              "organisation-entity"])


def build_planning_data(kind, mask_27700, mask_geom_4326):
    """Generic builder for a planning.data.gov.uk polygon dataset (EPSG:4326
    GeoJSON). Mirrors build_green_belt: the read-filter mask is 4326, the source
    is reprojected to 27700 only for the station-catchment clip in _finish."""
    slug, prop_cols = PLANNING_DATA_KINDS[kind]
    path = _src_path(f"{kind.upper()}_SRC", [
        f"{slug}.geojson", f"{slug}.json", f"{kind}.geojson",
        f"{slug}.gpkg", f"{kind}.gpkg",
    ])
    if not path:
        _skip(kind, f"planning.data.gov.uk {slug}", f"{kind.upper()}_SRC")
        return None
    print(f"  [{kind}] reading {path.name} ...")
    gdf = _read_source(path, None, mask_geom_4326)
    gdf = _to_27700(gdf, assume_epsg=4326)
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return _finish(gdf, kind, mask_27700, prop_cols=prop_cols)


BUILDERS = {
    "built_land": lambda m27, g27, g43: build_built_land(m27, g27),
    "green_space": lambda m27, g27, g43: build_green_space(m27, g27),
    "transport": lambda m27, g27, g43: build_transport(m27, g27),
    "flood_zone_2": lambda m27, g27, g43: build_flood(2, m27, g27, g43),
    "flood_zone_3": lambda m27, g27, g43: build_flood(3, m27, g27, g43),
    "green_belt": lambda m27, g27, g43: build_green_belt(m27, g43),
}
# Register every planning.data.gov.uk heritage/environmental kind on the same
# generic builder (bind `kind` per-lambda so the closure captures its own value).
for _pd_kind in PLANNING_DATA_KINDS:
    BUILDERS[_pd_kind] = (
        lambda m27, g27, g43, _k=_pd_kind: build_planning_data(_k, m27, g43)
    )


def _resolve_kinds(cli_kinds):
    raw = cli_kinds or os.environ.get("CONSTRAINT_KINDS", "")
    if not raw:
        return list(ALL_KINDS)
    wanted = [k.strip() for k in raw.replace(",", " ").split() if k.strip()]
    unknown = [k for k in wanted if k not in ALL_KINDS]
    if unknown:
        print(f"WARNING: ignoring unknown kind(s): {', '.join(unknown)}")
    ordered = [k for k in ALL_KINDS if k in wanted]
    return ordered or list(ALL_KINDS)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build planning_constraints import CSV.")
    ap.add_argument("--kinds", help="comma-separated subset of: "
                    + ",".join(ALL_KINDS) + " (default: all). "
                    "Also settable via CONSTRAINT_KINDS.")
    ap.add_argument("--out", default=str(OUT), help="output CSV path")
    args = ap.parse_args()

    kinds = _resolve_kinds(args.kinds)
    out_path = Path(args.out)

    mask = build_clip_mask()
    if mask is None or mask.is_empty:
        print("ERROR: could not build a station clip mask; aborting.")
        return 1

    # Masks in each source CRS: the 27700 mask for OS/EA layers and the clip, and
    # a 4326 mask for the already-WGS84 green-belt read filter.
    mask_gs_27700 = gpd.GeoSeries([mask], crs=27700)
    mask_geom_27700 = mask
    mask_geom_4326 = mask_gs_27700.to_crs(4326).iloc[0]

    print(f"Building kinds: {', '.join(kinds)}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["kind", "source_id", "name", "props", "geom_wkt"]
    per_kind = {}
    total = 0
    with out_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for kind in kinds:
            # Best-effort per kind: a failure on one layer (huge national file,
            # OOM, malformed geometry) must not lose the kinds that did build.
            try:
                rows = BUILDERS[kind](mask_geom_27700, mask_geom_27700, mask_geom_4326)
            except Exception as exc:
                print(f"  [{kind}] FAILED — skipping this kind: {exc}")
                per_kind[kind] = None
                continue
            if rows is None:
                per_kind[kind] = None
                continue
            for r in rows:
                w.writerow({
                    "kind": r["kind"],
                    "source_id": r["source_id"],
                    "name": r["name"],
                    "props": json.dumps(r["props"], separators=(",", ":"),
                                        ensure_ascii=False),
                    "geom_wkt": r["geom_wkt"],
                })
            per_kind[kind] = len(rows)
            total += len(rows)
            print(f"  [{kind}] {len(rows)} features written")

    size_mb = out_path.stat().st_size / 1e6
    print("\nSummary")
    print(f"  output: {out_path}  ({size_mb:.2f} MB, {total} features)")
    for kind in kinds:
        n = per_kind.get(kind)
        print(f"    {kind:14s} {'(skipped — no source)' if n is None else f'{n} features'}")
    if total == 0:
        print("\nNo features written. Place at least one source under data/raw/ "
              "(see the module docstring) and re-run.")
        return 1
    if size_mb > 100:
        print("\n  NOTE: output is large for the Supabase free tier. Check the "
              "clip mask and simplify tolerance, or build fewer kinds at once.")
    print("\nNext: python supabase/loaders/load_constraints.py "
          "(needs SUPABASE_URL + SUPABASE_SERVICE_KEY).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
