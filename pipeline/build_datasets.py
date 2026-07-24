"""
build_datasets.py
-----------------
Generic, registry-driven dataset ingestion: builds map overlay layers and
writes them to a Supabase-ready import CSV:

    supabase/datasets_import.csv

These rows populate the `public.map_features` table
(dataset, source_id, name, props jsonb, geom geometry(Geometry,4326),
PK (dataset, source_id)); the frontend fetches them by viewport bbox via the
`features_in_bbox` RPC. This mirrors pipeline/build_constraints.py: every
dataset is BEST-EFFORT (a missing/failed source is a warning + skip, never an
abort), every source is env-overridable, and the output geometry is EWKT
('SRID=4326;...') at 6 dp with light simplification for polygons.

Choose which datasets to build with --datasets (comma-separated) or the
DATASETS env var; blank = all. Env override convention: <DATASET-KEY
UPPERCASED>_SRC (e.g. ARTICLE4_SRC), accepting either a URL (downloaded to
data/raw/) or a local file path. A few datasets also honour the shorter
historical names used in their docs (GSP_SRC, TEC_SRC, WATER_SRC,
ONS_RENTS_SRC, LAD_BOUNDARIES_SRC, PTAL_SRC, OSM_POWER_GEOJSON).

REGISTRY (dataset -> default source; all downloads land in data/raw/):

  planning.data.gov.uk group (OGL v3.0, already EPSG:4326 GeoJSON, default
  URL https://files.planning.data.gov.uk/dataset/<slug>.geojson):
    lpa_boundary        local-planning-authority       polygons; props: reference
    local_plan_boundary local-plan-boundary            polygons; props: reference
    article4            article-4-direction-area       polygons; props: reference
    tpo_zone            tree-preservation-zone         polygons; props: reference
    design_code_area    design-code-area               polygons; props: reference

  Student housing:
    uni_campus   learning-provider.data.ac.uk learning-providers-plus.csv.
                 Points; name = provider name; props: ukprn, groups — plus
                 per-provider student stats (students_total / _fulltime /
                 _intl / _pg + intl_pct) joined by UKPRN from an optional
                 HESA_STUDENTS_SRC CSV (see _load_hesa_stats).
    uni_campus_site / uni_building
                 OSM amenity=university grounds + building=university
                 footprints from data/raw/osm_university.geojson (env
                 OSM_UNIVERSITY_GEOJSON), extracted by the workflow from the
                 same Geofabrik UK PBF as the power layers.
    ptal         NO default URL (London Datastore file paths are hashed) —
                 set PTAL_SRC to the TfL PTAL grid CSV (X,Y in EPSG:27700 +
                 PTAL grade / AI). Each grid point becomes a 100 m square.

  Energy:
    power_line / power_substation
                 Built together from data/raw/osm_power.geojson (env
                 OSM_POWER_GEOJSON), the intermediate the WORKFLOW extracts
                 from the Geofabrik UK OSM PBF (env OSM_PBF_SRC) with
                 osmium-tool — see .github/workflows/load-datasets.yml.
                 power=line LineStrings -> power_line (props voltage/operator/
                 cables + parsed props.kv); power=substation points/polygons ->
                 power_substation. power=minor_line is skipped.
    gsp_boundary NESO "GSP regions" zip (Feb 2026 release) — holds the same
                 regions GeoJSON in BNG and WGS84; _maybe_unzip_geo picks the
                 WGS84 member. GSP_SRC overrides for future releases.
    tec_register NO default (set TEC_SRC to a NESO TEC Register CSV export).
                 No geometry of its own: rows are geocoded by fuzzy-joining
                 the connection-site name against power_substation names built
                 in the SAME run; matches emit points at the substation
                 centroid (props: mw, status, customer, site).

  Land / values:
    lad_boundary ONS Open Geography LAD boundaries (ArcGIS FeatureServer,
                 paginated). Emitted whenever the boundaries download works.
    la_rents     ONS_RENTS_SRC (latest PIPR local-authority rents CSV — no
                 stable URL, skip w/ warning if unset) joined by LAD code onto
                 the lad_boundary polygons. props: rent_mean, rent_lq and
                 per-bedroom breakdowns as detected.
    alc          Natural England Provisional ALC (ArcGIS FeatureServer,
                 paginated). Polygons; props: alc_grade.
    water_availability
                 NO default (set WATER_AVAILABILITY_SRC / WATER_SRC to the EA
                 CAMS water resource availability GeoJSON/SHP). Polygons;
                 props: availability colour/status, detected defensively.

Run (or let the Action run it — see .github/workflows/load-datasets.yml):
    python pipeline/build_datasets.py
    python pipeline/build_datasets.py --datasets article4,uni_campus
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely import to_wkt
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

# Light polygon clean-up (metres, applied in EPSG:27700 then reprojected back).
SIMPLIFY_M = float(os.environ.get("SIMPLIFY_M", "10"))
# Coordinate precision in the output WKT (~0.1 m at 6 dp).
COORD_DP = 6
# ArcGIS FeatureServer page size (servers cap at 2000).
ARCGIS_PAGE = 2000

PLANNING_DATA_BASE = "https://files.planning.data.gov.uk/dataset/"

# dataset-key -> planning.data.gov.uk slug (uniform WGS84 GeoJSON, OGL).
PLANNING_DATASETS = {
    "lpa_boundary":        "local-planning-authority",
    "local_plan_boundary": "local-plan-boundary",
    "article4":            "article-4-direction-area",
    "tpo_zone":            "tree-preservation-zone",
    "design_code_area":    "design-code-area",
}

UNI_CAMPUS_URL = ("https://learning-provider.data.ac.uk/data/"
                  "learning-providers-plus.csv")
# NESO "GSP regions" release (Feb 2026) — a zip holding the regions GeoJSON in
# both British National Grid and WGS84; _maybe_unzip_geo picks the WGS84 one.
GSP_DEFAULT_URL = ("https://api.neso.energy/dataset/"
                   "2810092e-d4b2-472f-b955-d8bea01f9ec0/resource/"
                   "5dfab3dd-f192-40ab-b97f-b365a594293c/download/"
                   "gsp_regions_20260209.zip")
LAD_DEFAULT_URL = ("https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/"
                   "services/Local_Authority_Districts_December_2024_Boundaries"
                   "_UK_BGC/FeatureServer/0/query?where=1%3D1&outFields=*"
                   "&outSR=4326&f=geojson")
ALC_DEFAULT_URL = ("https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/"
                   "services/Provisional_Agricultural_Land_Classification_ALC_"
                   "England/FeatureServer/0/query?where=1%3D1&outFields=*"
                   "&outSR=4326&f=geojson")

ALL_DATASETS = [
    "lpa_boundary", "local_plan_boundary", "article4", "tpo_zone",
    "design_code_area",
    "uni_campus", "uni_campus_site", "uni_building", "ptal",
    "power_line", "power_substation", "gsp_boundary", "tec_register",
    "lad_boundary", "la_rents", "alc", "water_availability",
]

# dataset -> {"count": int|None, "reason": str} filled in as the run proceeds.
STATUS = {}
# (name, centroid geometry EPSG:4326) for every substation built this run —
# tec_register geocodes against this.
_SUBSTATIONS = []


def _note(dataset, reason, count=None):
    STATUS[dataset] = {"count": count, "reason": reason}


def _warn(dataset, msg):
    print(f"  [{dataset}] WARNING: {msg}")


# --- generic helpers ---------------------------------------------------------

ID_CANDIDATES = [
    "source_id", "reference", "entity", "id", "gml_id", "uid", "fid",
    "objectid", "ogc_fid", "@id",
]
NAME_CANDIDATES = ["name", "site_name", "sitename", "title", "label"]


def _find_col(df, candidates, contains=False):
    """Case-insensitive lookup of the first candidate column present. With
    contains=True, also accept a column whose name merely CONTAINS a
    candidate (defensive matching for messy CSV headers)."""
    cols = [c for c in df.columns if c != "geometry"]
    lower = {str(c).strip().lower(): c for c in cols}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    if contains:
        for cand in candidates:
            for lc, orig in lower.items():
                if cand.lower() in lc:
                    return orig
    return None


def _jsonable(v):
    """Coerce a cell value (possibly a numpy scalar) to JSON-serialisable."""
    if v is None:
        return None
    if isinstance(v, (str, bool, int, float)):
        return v
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    item = getattr(v, "item", None)
    if callable(item):
        try:
            return item()
        except Exception:
            pass
    return str(v)


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


def _num(feat, col):
    """A float value for a column, or None."""
    s = _cell(feat, col)
    if not s:
        return None
    try:
        return float(str(s).replace(",", ""))
    except ValueError:
        return None


def _stable_id(dataset, ewkt):
    """Deterministic id from dataset+geometry, for sources with no feature id
    — re-runs upsert the same rows instead of duplicating."""
    h = hashlib.md5(f"{dataset}|{ewkt}".encode("utf-8")).hexdigest()[:16]
    return f"{dataset}-{h}"


def _slug_key(s):
    """A safe snake_case props key from a messy CSV header."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(s).lower())).strip("_")


def _read_csv(path):
    """CSV read tolerant of BOMs and legacy encodings."""
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(path, encoding=enc, low_memory=False)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, low_memory=False)


# --- source resolution (URL or local path, env-overridable) ------------------

def _download(url, dest):
    """Download url -> dest (streamed). Raises on failure; callers treat any
    exception as skip-with-warning."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "mastermapper-pipeline/1.0"})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=300) as resp, tmp.open("wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    tmp.replace(dest)
    return dest


def _resolve_source(dataset, env_vars, default_url, cache_name):
    """Resolve a dataset source into a local file path (or None + reason).

    env_vars: env var names checked in order (the generic <KEY>_SRC first).
    The value may be a URL (downloaded to data/raw/cache_name) or a local
    path. When no env var is set, an existing data/raw/cache_name is reused,
    else default_url is downloaded (best-effort). Returns (Path|None, reason).
    """
    for var in env_vars:
        v = os.environ.get(var, "").strip()
        if not v:
            continue
        if v.lower().startswith(("http://", "https://")):
            dest = RAW / cache_name
            try:
                print(f"  [{dataset}] downloading {var} -> {dest.name} ...")
                return _download(v, dest), f"downloaded from {var}"
            except Exception as exc:
                return None, f"{var} download failed: {exc}"
        p = Path(v)
        if p.exists():
            return p, f"local file via {var}"
        return None, f"{var}={v} does not exist"

    cached = RAW / cache_name
    if cached.exists() and cached.stat().st_size > 0:
        return cached, f"cached {cached.name}"

    if default_url:
        try:
            print(f"  [{dataset}] downloading default source -> {cached.name} ...")
            return _download(default_url, cached), "downloaded default"
        except urllib.error.HTTPError as exc:
            return None, f"default URL returned HTTP {exc.code}"
        except Exception as exc:
            return None, f"default download failed: {exc}"
    return None, "no source configured"


def _fetch_arcgis(url, dest, dataset):
    """Fetch every feature from an ArcGIS FeatureServer query URL (which caps
    responses at ~2000 features) by looping resultOffset, and write one merged
    GeoJSON FeatureCollection to dest. Raises on failure."""
    feats, offset = [], 0
    sep = "&" if "?" in url else "?"
    for _page in range(500):  # hard guard: 500 pages = 1M features
        page_url = (f"{url}{sep}resultOffset={offset}"
                    f"&resultRecordCount={ARCGIS_PAGE}")
        req = urllib.request.Request(
            page_url, headers={"User-Agent": "mastermapper-pipeline/1.0"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if "error" in data:
            raise RuntimeError(f"ArcGIS error: {data['error']}")
        page = data.get("features", [])
        feats.extend(page)
        print(f"  [{dataset}] ArcGIS page at offset {offset}: {len(page)} features")
        more = (data.get("exceededTransferLimit")
                or data.get("properties", {}).get("exceededTransferLimit"))
        if not page or (len(page) < ARCGIS_PAGE and not more):
            break
        offset += len(page)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)
    return dest


def _resolve_arcgis_source(dataset, env_vars, default_url, cache_name):
    """Like _resolve_source but understands paginated ArcGIS query URLs (env
    value or default). Plain URLs/paths fall through to _resolve_source."""
    for var in env_vars:
        v = os.environ.get(var, "").strip()
        if v and ("featureserver" in v.lower() or "mapserver" in v.lower()):
            dest = RAW / cache_name
            try:
                print(f"  [{dataset}] fetching paginated ArcGIS source ({var}) ...")
                return _fetch_arcgis(v, dest, dataset), f"ArcGIS via {var}"
            except Exception as exc:
                return None, f"{var} ArcGIS fetch failed: {exc}"
    env_set = any(os.environ.get(v, "").strip() for v in env_vars)
    if env_set:
        return _resolve_source(dataset, env_vars, None, cache_name)
    cached = RAW / cache_name
    if cached.exists() and cached.stat().st_size > 0:
        return cached, f"cached {cached.name}"
    if default_url:
        try:
            print(f"  [{dataset}] fetching paginated ArcGIS default ...")
            return _fetch_arcgis(default_url, cached, dataset), "ArcGIS default"
        except urllib.error.HTTPError as exc:
            return None, f"default ArcGIS URL returned HTTP {exc.code}"
        except Exception as exc:
            return None, f"default ArcGIS fetch failed: {exc}"
    return None, "no source configured"


# --- geometry + row emission -------------------------------------------------

def _to_multipolygon(geom):
    """A non-empty MultiPolygon from any polygonal input, or None."""
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
        return _to_multipolygon(unary_union(polys))
    return None


def _ensure_4326(gdf, assume_epsg=4326):
    if gdf.crs is None:
        gdf = gdf.set_crs(assume_epsg)
    try:
        if gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(4326)
    except Exception:
        gdf = gdf.to_crs(4326)
    return gdf


def _emit(gdf, dataset, name_col=None, id_col=None, props_fn=None,
          want="polygon", assume_epsg=4326, simplify=True):
    """Shared tail: normalise CRS to 4326, lightly simplify polygons (in
    EPSG:27700, SIMPLIFY_M metres), and emit one row dict per feature with
    EWKT geometry at 6 dp. want: 'polygon' (promote to MultiPolygon, drop
    non-polygonal), 'point', 'line', or 'any'."""
    if gdf is None or gdf.empty:
        return []
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    if gdf.empty:
        return []
    try:
        gdf["geometry"] = gdf.geometry.make_valid()
    except Exception:
        pass
    gdf = _ensure_4326(gdf, assume_epsg=assume_epsg)

    if want == "polygon":
        gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon",
                                               "GeometryCollection"])]
    elif want == "point":
        gdf = gdf[gdf.geometry.geom_type.isin(["Point", "MultiPoint"])]
    elif want == "line":
        gdf = gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    if gdf.empty:
        return []

    # Light simplification for polygonal (and line) geometry: round-trip
    # through British National Grid so the tolerance is in metres.
    if simplify and SIMPLIFY_M and want in ("polygon", "line", "any"):
        try:
            g27 = gdf.to_crs(27700)
            g27["geometry"] = g27.geometry.simplify(SIMPLIFY_M,
                                                    preserve_topology=True)
            gdf = g27.to_crs(4326)
            gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
        except Exception as exc:
            print(f"  [{dataset}] simplify skipped ({exc})")

    if id_col is None:
        id_col = _find_col(gdf, ID_CANDIDATES)
    if name_col is None:
        name_col = _find_col(gdf, NAME_CANDIDATES)

    rows, seen = [], {}
    for _, feat in gdf.iterrows():
        geom = feat.geometry
        if geom is None or geom.is_empty:
            continue
        if want == "polygon":
            geom = _to_multipolygon(geom)
            if geom is None or geom.is_empty:
                continue
        ewkt = "SRID=4326;" + to_wkt(geom, rounding_precision=COORD_DP, trim=True)

        sid = _cell(feat, id_col)
        if not sid:
            sid = _stable_id(dataset, ewkt)
        # (dataset, source_id) is the PK — make repeats unique deterministically
        # so one upsert batch never touches the same row twice.
        seen[sid] = seen.get(sid, 0) + 1
        if seen[sid] > 1:
            sid = f"{sid}-{seen[sid]}"

        props = {}
        if props_fn is not None:
            for k, v in (props_fn(feat) or {}).items():
                v = _jsonable(v)
                if v not in (None, ""):
                    props[k] = v

        rows.append({
            "dataset": dataset,
            "source_id": sid,
            "name": _cell(feat, name_col) or None,
            "props": props,
            "geom_wkt": ewkt,
        })
    return rows


# --- builders ----------------------------------------------------------------
# Each builder returns {dataset: rows-list} for the datasets it produced, and
# records a STATUS reason for anything it skipped.

def build_planning_dataset(key):
    slug = PLANNING_DATASETS[key]
    path, how = _resolve_source(key, [f"{key.upper()}_SRC"],
                                PLANNING_DATA_BASE + f"{slug}.geojson",
                                f"{slug}.geojson")
    if path is None:
        _warn(key, f"{how} — set {key.upper()}_SRC to a "
                   f"planning.data.gov.uk {slug} GeoJSON (URL or path)")
        _note(key, how)
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    gdf = gpd.read_file(path)
    ref_col = _find_col(gdf, ["reference"])
    rows = _emit(gdf, key, want="polygon",
                 props_fn=lambda f: {"reference": _cell(f, ref_col)})
    _note(key, how, len(rows))
    return {key: rows}


def _load_hesa_stats():
    """Optional per-provider student stats keyed by UKPRN, merged onto the
    uni_campus points for the PBSA deep-dive card. Source: HESA_STUDENTS_SRC —
    a CSV with a UKPRN column plus any of (detected case-insensitively,
    'contains' matching): total students, full-time, international/non-UK,
    postgraduate. Wide format, one row per provider; trim HESA's metadata
    preamble lines if the raw download has them. Missing source = quiet skip
    (the layer still builds, the card just has no stats)."""
    path, how = _resolve_source("uni_campus_stats", ["HESA_STUDENTS_SRC"],
                                None, "hesa_students.csv")
    if path is None:
        print("  [uni_campus] no HESA_STUDENTS_SRC — points build without "
              "student stats (set it to a per-provider CSV keyed by UKPRN)")
        return {}
    try:
        df = _read_csv(path)
    except Exception as exc:
        _warn("uni_campus", f"HESA stats CSV unreadable ({exc}) — continuing "
                            "without stats")
        return {}
    ukprn_col = _find_col(df, ["ukprn"], contains=True)
    if ukprn_col is None:
        _warn("uni_campus", "HESA stats CSV has no UKPRN column — continuing "
                            f"without stats (columns: {list(df.columns)[:10]})")
        return {}
    fields = {
        "students_total": _find_col(df, ["total_students", "total students",
                                         "students_total", "all students",
                                         "total"], contains=True),
        "students_fulltime": _find_col(df, ["full-time", "fulltime", "full time"],
                                       contains=True),
        "students_intl": _find_col(df, ["international", "non-uk", "non uk",
                                        "overseas"], contains=True),
        "students_pg": _find_col(df, ["postgraduate", "pg "], contains=True),
        # Term-time accommodation mix (HESA DT051 Table 57, full-time
        # students) — the core PBSA demand signals: private halls = existing
        # PBSA penetration, other rented = the HMO market, provider halls =
        # university-run stock.
        "acc_provider_halls": _find_col(df, ["acc_provider_halls",
                                             "provider maintained"], contains=True),
        "acc_private_halls": _find_col(df, ["acc_private_halls",
                                            "private-sector halls",
                                            "private sector halls"], contains=True),
        "acc_parental_home": _find_col(df, ["acc_parental_home", "parental"],
                                       contains=True),
        "acc_own_residence": _find_col(df, ["acc_own_residence", "own residence"],
                                       contains=True),
        "acc_other_rented": _find_col(df, ["acc_other_rented", "other rented"],
                                      contains=True),
    }
    found = {k: c for k, c in fields.items() if c is not None}
    if not found:
        _warn("uni_campus", "no recognisable student-count columns in the HESA "
                            "CSV — continuing without stats")
        return {}
    stats = {}
    for _, r in df.iterrows():
        try:
            ukprn = str(int(float(r[ukprn_col])))
        except (TypeError, ValueError):
            continue
        row = {}
        for k, col in found.items():
            v = pd.to_numeric(pd.Series([r[col]]).astype(str)
                              .str.replace(",", "", regex=False),
                              errors="coerce").iloc[0]
            if pd.notna(v):
                row[k] = int(v)
        if row:
            # Derived shares the PBSA card leads with.
            if "students_total" in row and row["students_total"] > 0 \
                    and "students_intl" in row:
                row["intl_pct"] = round(100.0 * row["students_intl"]
                                        / row["students_total"], 1)
            ft = row.get("students_fulltime")
            if ft:
                for acc, pct in (("acc_private_halls", "pbsa_pct"),
                                 ("acc_provider_halls", "uni_halls_pct"),
                                 ("acc_other_rented", "rented_pct"),
                                 ("acc_parental_home", "home_pct")):
                    if acc in row:
                        row[pct] = round(100.0 * row[acc] / ft, 1)
            stats[ukprn] = row
    print(f"  [uni_campus] HESA stats joined for {len(stats)} providers ({how})")
    return stats


def build_uni_campus():
    key = "uni_campus"
    path, how = _resolve_source(key, ["UNI_CAMPUS_SRC"], UNI_CAMPUS_URL,
                                "learning-providers-plus.csv")
    if path is None:
        _warn(key, f"{how} — set UNI_CAMPUS_SRC to the learning-providers-plus"
                   " CSV (URL or path)")
        _note(key, how)
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    df = _read_csv(path)
    lat_col = _find_col(df, ["latitude", "lat"], contains=True)
    lon_col = _find_col(df, ["longitude", "long", "lon"], contains=True)
    name_col = _find_col(df, ["provider_name", "view_name", "name"], contains=True)
    ukprn_col = _find_col(df, ["ukprn"], contains=True)
    groups_col = _find_col(df, ["groups"], contains=True)
    if lat_col is None or lon_col is None:
        _warn(key, f"no LATITUDE/LONGITUDE columns found in {path.name} "
                   f"(columns: {list(df.columns)[:12]}...)")
        _note(key, "no coordinate columns in CSV")
        return {}
    df = df.copy()
    df["_lat"] = pd.to_numeric(df[lat_col], errors="coerce")
    df["_lon"] = pd.to_numeric(df[lon_col], errors="coerce")
    before = len(df)
    df = df[df["_lat"].notna() & df["_lon"].notna()]
    if before - len(df):
        print(f"  [{key}] dropped {before - len(df)} row(s) without coordinates")
    gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["_lon"], df["_lat"]),
                           crs=4326)
    hesa = _load_hesa_stats()

    def _props(f):
        ukprn_raw = _cell(f, ukprn_col)
        p = {"ukprn": ukprn_raw, "groups": _cell(f, groups_col)}
        try:
            p.update(hesa.get(str(int(float(ukprn_raw))), {}))
        except (TypeError, ValueError):
            pass
        return p

    rows = _emit(gdf, key, name_col=name_col, id_col=ukprn_col, want="point",
                 props_fn=_props)
    _note(key, how + (" + HESA stats" if hesa else ""), len(rows))
    return {key: rows}


def build_university_group():
    """uni_campus_site (amenity=university grounds) + uni_building
    (building=university footprints) from the workflow's osmium university
    extract — the full physical footprint of each institution, complementing
    the one-dot-per-provider uni_campus layer."""
    src = os.environ.get("OSM_UNIVERSITY_GEOJSON", "").strip() \
        or str(RAW / "osm_university.geojson")
    path = Path(src)
    if not path.exists():
        for k in ("uni_campus_site", "uni_building"):
            _note(k, "osm_university.geojson missing")
        _warn("uni_campus_site/uni_building",
              f"{path} not found. The GitHub workflow extracts it from the UK"
              " OSM PBF alongside the power extract; locally, run the osmium"
              " steps from .github/workflows/load-datasets.yml or set"
              " OSM_UNIVERSITY_GEOJSON.")
        return {}
    print(f"  [university] reading {path.name} ...")
    gdf = gpd.read_file(path)
    amenity_col = _find_col(gdf, ["amenity"])
    building_col = _find_col(gdf, ["building"])
    name_col = _find_col(gdf, ["name"])
    op_col = _find_col(gdf, ["operator"])
    web_col = _find_col(gdf, ["website"])
    out = {}

    is_poly = gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])
    if amenity_col is not None:
        am = gdf[amenity_col].astype(str).str.strip().str.lower()
        sites = gdf[(am == "university") & is_poly]
        out["uni_campus_site"] = _emit(
            sites, "uni_campus_site", name_col=name_col, want="polygon",
            props_fn=lambda f: {"operator": _cell(f, op_col),
                                "website": _cell(f, web_col)})
        _note("uni_campus_site", "osmium extract", len(out["uni_campus_site"]))
    else:
        _note("uni_campus_site", "no amenity tag in extract")

    if building_col is not None:
        bl = gdf[building_col].astype(str).str.strip().str.lower()
        builds = gdf[(bl == "university") & is_poly]
        out["uni_building"] = _emit(
            builds, "uni_building", name_col=name_col, want="polygon",
            props_fn=lambda f: {"operator": _cell(f, op_col)})
        _note("uni_building", "osmium extract", len(out["uni_building"]))
    else:
        _note("uni_building", "no building tag in extract")
    return out


def build_ptal():
    key = "ptal"
    path, how = _resolve_source(key, ["PTAL_SRC"], None, "ptal_grid.csv")
    if path is None:
        _warn(key, "no PTAL source. London Datastore file paths are hashed, so"
                   " there is no reliable default URL — set PTAL_SRC to the TfL"
                   " 'PTAL grid values' CSV (X,Y in EPSG:27700 + PTAL grade),"
                   " from https://data.london.gov.uk (search: PTAL).")
        _note(key, "PTAL_SRC not set (no reliable default URL)")
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    df = _read_csv(path)
    x_col = _find_col(df, ["x", "easting", "x_coord", "x (easting)"], contains=False) \
        or _find_col(df, ["easting"], contains=True)
    y_col = _find_col(df, ["y", "northing", "y_coord", "y (northing)"], contains=False) \
        or _find_col(df, ["northing"], contains=True)
    ptal_col = _find_col(df, ["ptal"], contains=True)
    ai_col = _find_col(df, ["ai", "access index", "accessindex"], contains=False) \
        or _find_col(df, ["access index", "ai20"], contains=True)
    if x_col is None or y_col is None or ptal_col is None:
        _warn(key, f"could not detect X/Y/PTAL columns in {path.name} "
                   f"(columns: {list(df.columns)[:12]}...)")
        _note(key, "unrecognised PTAL CSV columns")
        return {}
    df = df.copy()
    df["_x"] = pd.to_numeric(df[x_col], errors="coerce")
    df["_y"] = pd.to_numeric(df[y_col], errors="coerce")
    df = df[df["_x"].notna() & df["_y"].notna()]
    gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["_x"], df["_y"]),
                           crs=27700)
    # Each grid point represents a 100 m cell: a square 50 m buffer in BNG.
    gdf["geometry"] = gdf.geometry.buffer(50, cap_style=3)
    rows = _emit(gdf, key, name_col=ptal_col, want="polygon", assume_epsg=27700,
                 simplify=False,  # they're already minimal 100 m squares
                 props_fn=lambda f: {"ptal": _cell(f, ptal_col),
                                     "ai": _num(f, ai_col)})
    _note(key, how, len(rows))
    return {key: rows}


def _parse_kv(voltage):
    """Max voltage in kilovolts from an OSM voltage tag ('400000;275000'),
    or None."""
    best = None
    for part in str(voltage or "").split(";"):
        part = part.strip().replace(",", "")
        try:
            v = float(part)
        except ValueError:
            continue
        best = v if best is None else max(best, v)
    if best is None:
        return None
    return round(best / 1000.0, 3)


def _closed_line_to_polygon(geom):
    """Substation outlines exported as closed LineStrings -> Polygon; open
    lines -> centroid point (still a usable marker)."""
    try:
        if geom.geom_type == "LineString" and geom.is_ring:
            return Polygon(geom.coords)
    except Exception:
        pass
    return geom.centroid


def build_power_group():
    """power_line + power_substation from the workflow's osmium-extracted
    GeoJSON. Also fills the substation-name cache used by tec_register."""
    src = os.environ.get("OSM_POWER_GEOJSON", "").strip() \
        or os.environ.get("POWER_LINE_SRC", "").strip() \
        or str(RAW / "osm_power.geojson")
    path = Path(src)
    if not path.exists():
        for k in ("power_line", "power_substation"):
            _note(k, "osm_power.geojson missing")
        _warn("power_line/power_substation",
              f"{path} not found. The GitHub workflow extracts it from the UK"
              " OSM PBF (env OSM_PBF_SRC) with osmium-tool; locally, run the"
              " osmium tags-filter/export steps from"
              " .github/workflows/load-datasets.yml or set OSM_POWER_GEOJSON.")
        return {}
    print(f"  [power] reading {path.name} ...")
    gdf = gpd.read_file(path)
    power_col = _find_col(gdf, ["power"])
    if power_col is None:
        _warn("power_line/power_substation", "no 'power' attribute in the "
              "extracted GeoJSON — re-run osmium export keeping the power tag")
        for k in ("power_line", "power_substation"):
            _note(k, "no power tag in extract")
        return {}
    pw = gdf[power_col].astype(str).str.strip().str.lower()
    volt_col = _find_col(gdf, ["voltage"])
    op_col = _find_col(gdf, ["operator"])
    cables_col = _find_col(gdf, ["cables"])
    sub_col = _find_col(gdf, ["substation"])
    name_col = _find_col(gdf, ["name"])
    out = {}

    # power=line only — power=minor_line is deliberately skipped.
    lines = gdf[(pw == "line")
                & gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    out["power_line"] = _emit(
        lines, "power_line", name_col=name_col, want="line",
        props_fn=lambda f: {"voltage": _cell(f, volt_col),
                            "kv": _parse_kv(_cell(f, volt_col)),
                            "operator": _cell(f, op_col),
                            "cables": _cell(f, cables_col)})
    _note("power_line", "osmium extract", len(out["power_line"]))

    subs = gdf[pw == "substation"].copy()
    if not subs.empty:
        gt = subs.geometry.geom_type
        fix = ~gt.isin(["Polygon", "MultiPolygon", "Point", "MultiPoint"])
        if fix.any():
            subs.loc[fix, "geometry"] = subs.loc[fix].geometry.apply(
                _closed_line_to_polygon)
        # The frontend renders substations as a CIRCLE layer, which draws
        # Points only — a polygon footprint would be invisible. Collapse every
        # non-point to a representative interior point.
        gt = subs.geometry.geom_type
        poly = ~gt.isin(["Point"])
        if poly.any():
            subs.loc[poly, "geometry"] = subs.loc[poly].geometry.representative_point()
    out["power_substation"] = _emit(
        subs, "power_substation", name_col=name_col, want="any",
        props_fn=lambda f: {"voltage": _cell(f, volt_col),
                            "kv": _parse_kv(_cell(f, volt_col)),
                            "operator": _cell(f, op_col),
                            "substation": _cell(f, sub_col)})
    _note("power_substation", "osmium extract", len(out["power_substation"]))

    # Cache (name, centroid) for the tec_register fuzzy join.
    if not subs.empty:
        subs4326 = _ensure_4326(subs)
        for _, f in subs4326.iterrows():
            nm = _cell(f, name_col)
            if nm and f.geometry is not None and not f.geometry.is_empty:
                _SUBSTATIONS.append((nm, f.geometry.centroid))
    print(f"  [power] cached {len(_SUBSTATIONS)} named substations for "
          "tec_register geocoding")
    return out


def _maybe_unzip_geo(path, key):
    """If `path` is actually a ZIP (checked by magic bytes, not extension —
    downloads are cached under a fixed name), extract it and return the best
    vector member: prefer a GeoJSON whose name suggests WGS84/4326 (NESO ships
    the same layer in British National Grid AND WGS84), else any member whose
    first coordinate looks like lon/lat (|x| <= 360), else the first vector
    file. Non-zip paths pass straight through."""
    import zipfile
    try:
        with open(path, "rb") as fh:
            if fh.read(4) != b"PK\x03\x04":
                return path
    except OSError:
        return path
    dest = RAW / f"{key}_unzipped"
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as zf:
        zf.extractall(dest)
    vecs = sorted([f for f in dest.rglob("*")
                   if f.suffix.lower() in (".geojson", ".json", ".gpkg", ".shp")])
    if not vecs:
        _warn(key, f"zip source {path.name} holds no vector file")
        return None
    named = [f for f in vecs if any(t in f.name.lower()
                                    for t in ("wgs84", "wgs_84", "4326"))]
    if named:
        print(f"  [{key}] zip source: using WGS84 member {named[0].name}")
        return named[0]
    for f in vecs:
        if f.suffix.lower() in (".geojson", ".json"):
            # Cheap probe: the first coordinate pair's magnitude tells BNG
            # (six-figure metres) apart from lon/lat without a full parse.
            head = f.read_text(encoding="utf-8-sig", errors="ignore")[:100000]
            m = re.search(r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", head)
            if m and abs(float(m.group(1))) <= 360 and abs(float(m.group(2))) <= 360:
                print(f"  [{key}] zip source: {f.name} looks like lon/lat")
                return f
    print(f"  [{key}] zip source: falling back to {vecs[0].name}")
    return vecs[0]


def build_gsp_boundary():
    key = "gsp_boundary"
    path, how = _resolve_source(key, ["GSP_BOUNDARY_SRC", "GSP_SRC"],
                                GSP_DEFAULT_URL, "gsp-boundaries.geojson")
    if path is not None:
        path = _maybe_unzip_geo(path, key)
    if path is None:
        _warn(key, f"{how} — the NESO resource hash changes between releases."
                   " Set GSP_SRC to the current 'GIS Boundaries for GB Grid"
                   " Supply Points' GeoJSON URL from the NESO Data Portal"
                   " (https://www.neso.energy/data-portal).")
        _note(key, how)
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    gdf = gpd.read_file(path)
    name_col = _find_col(gdf, ["gsp", "gsp_name", "gspname", "name", "gsps",
                               "sitename"], contains=True)
    id_cols = [c for c in gdf.columns
               if c != "geometry" and re.search(
                   r"(^|_)(id|code|gsp|group)($|_)", str(c).lower())]

    def props_fn(f, cols=tuple(id_cols)):
        return {_slug_key(c): _cell(f, c) for c in cols}

    rows = _emit(gdf, key, name_col=name_col, want="polygon", props_fn=props_fn)
    _note(key, how, len(rows))
    return {key: rows}


def _norm_site(s):
    """Normalise a substation/connection-site name for fuzzy matching."""
    s = str(s or "").lower()
    for w in ("grid supply point", "supply point", "substation", "switching",
              "station", "s/s", "gsp", "bsp", "grid", "no.", "number"):
        s = s.replace(w, " ")
    s = re.sub(r"\b\d+\s*k?v\b", " ", s)     # 400kV / 132 kv etc.
    return re.sub(r"[^a-z0-9]+", "", s)


def build_tec_register():
    key = "tec_register"
    path, how = _resolve_source(key, ["TEC_REGISTER_SRC", "TEC_SRC"], None,
                                "tec-register.csv")
    if path is None:
        _warn(key, "no TEC source — set TEC_SRC to a CSV export of the NESO"
                   " TEC Register (https://www.neso.energy/data-portal,"
                   " 'Transmission Entry Capacity (TEC) Register').")
        _note(key, "TEC_SRC not set (no stable default URL)")
        return {}
    if not _SUBSTATIONS:
        _warn(key, "no power_substation features were built this run, so TEC"
                   " rows cannot be geocoded — build power_substation in the"
                   " same run (it needs the osmium OSM extract).")
        _note(key, "no substations available to geocode against")
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    df = _read_csv(path)
    site_col = _find_col(df, ["connection site", "connection_site", "site name",
                              "connection point", "substation"], contains=True)
    mw_col = _find_col(df, ["mw connected", "cumulative total capacity",
                            "mw effective", "capacity (mw)", "mw increase",
                            "mw"], contains=True)
    status_col = _find_col(df, ["project status", "status", "agreement type",
                                "stage"], contains=True)
    cust_col = _find_col(df, ["customer name", "customer", "company",
                              "project name", "developer"], contains=True)
    if site_col is None:
        _warn(key, f"no connection-site column detected in {path.name} "
                   f"(columns: {list(df.columns)[:12]}...)")
        _note(key, "unrecognised TEC CSV columns")
        return {}

    # Normalised substation lookup, longest names first so the most specific
    # substation wins a contains-match.
    subs = [(_norm_site(nm), nm, pt) for nm, pt in _SUBSTATIONS]
    subs = sorted([s for s in subs if len(s[0]) >= 4],
                  key=lambda s: len(s[0]), reverse=True)

    rows, unmatched, seen = [], 0, {}
    for _, r in df.iterrows():
        site = _cell(r, site_col)
        norm = _norm_site(site)
        match = None
        if len(norm) >= 4:
            for snorm, sname, spt in subs:
                if snorm in norm or norm in snorm:
                    match = (sname, spt)
                    break
        if match is None:
            unmatched += 1
            continue
        sname, spt = match
        ewkt = "SRID=4326;" + to_wkt(spt, rounding_precision=COORD_DP, trim=True)
        sid = _stable_id(key, f"{site}|{_cell(r, cust_col)}|{ewkt}")
        seen[sid] = seen.get(sid, 0) + 1
        if seen[sid] > 1:
            sid = f"{sid}-{seen[sid]}"
        props = {k: v for k, v in {
            "mw": _num(r, mw_col),
            "status": _cell(r, status_col),
            "customer": _cell(r, cust_col),
            "site": site,
            "substation": sname,
        }.items() if v not in (None, "")}
        rows.append({"dataset": key, "source_id": sid,
                     "name": _cell(r, cust_col) or site or None,
                     "props": props, "geom_wkt": ewkt})
    total = len(rows) + unmatched
    rate = (100.0 * len(rows) / total) if total else 0.0
    print(f"  [{key}] matched {len(rows)}/{total} rows ({rate:.0f}%) to "
          "substation names")
    if unmatched:
        _warn(key, f"{unmatched} TEC row(s) had no substation name match and "
                   "were dropped")
    _note(key, f"{how}; match rate {rate:.0f}%", len(rows))
    return {key: rows}


def build_rents_group():
    """lad_boundary (always, when the boundaries fetch works) and la_rents
    (when an ONS PIPR rents CSV is supplied and joins by LAD code)."""
    out = {}
    bpath, bhow = _resolve_arcgis_source(
        "lad_boundary", ["LAD_BOUNDARY_SRC", "LAD_BOUNDARIES_SRC"],
        LAD_DEFAULT_URL, "lad-boundaries.geojson")
    if bpath is None:
        _warn("lad_boundary", f"{bhow} — set LAD_BOUNDARIES_SRC to an ONS Open"
              " Geography LAD boundaries GeoJSON/FeatureServer query URL")
        _note("lad_boundary", bhow)
        _note("la_rents", "no LAD boundaries to join rents onto")
        return out
    print(f"  [lad_boundary] reading {bpath.name} ({bhow}) ...")
    gdf = gpd.read_file(bpath)
    code_col = None
    for c in gdf.columns:
        if re.fullmatch(r"lad\d*cd", str(c).lower()):
            code_col = c
            break
    code_col = code_col or _find_col(gdf, ["lad_code", "code", "areacd",
                                           "area_code"], contains=True)
    name_col = None
    for c in gdf.columns:
        if re.fullmatch(r"lad\d*nm", str(c).lower()):
            name_col = c
            break
    name_col = name_col or _find_col(gdf, NAME_CANDIDATES)

    out["lad_boundary"] = _emit(
        gdf, "lad_boundary", name_col=name_col, id_col=code_col, want="polygon",
        props_fn=lambda f: {"lad_code": _cell(f, code_col)})
    _note("lad_boundary", bhow, len(out["lad_boundary"]))

    rpath, rhow = _resolve_source("la_rents", ["LA_RENTS_SRC", "ONS_RENTS_SRC"],
                                  None, "ons-la-rents.csv")
    if rpath is None:
        _warn("la_rents", "no rents CSV — set ONS_RENTS_SRC to the latest ONS"
              " PIPR (Price Index of Private Rents) local-authority-level CSV"
              " (no stable download URL; grab it from the ONS PIPR release"
              " page). lad_boundary was still built so the boundaries layer"
              " works alone.")
        _note("la_rents", "ONS_RENTS_SRC not set")
        return out
    print(f"  [la_rents] reading {rpath.name} ({rhow}) ...")
    df = _read_csv(rpath)
    rcode_col = _find_col(df, ["area code", "areacd", "ons code", "lad code",
                               "ladcd", "local authority code", "geography code",
                               "code"], contains=True)
    if rcode_col is None:
        _warn("la_rents", f"no LAD-code column detected in {rpath.name} "
              f"(columns: {list(df.columns)[:12]}...)")
        _note("la_rents", "unrecognised rents CSV columns")
        return out

    # Rent value columns, detected defensively. Two shapes are handled:
    #  wide  — one row per LAD, columns like 'Mean rent', 'Lower quartile',
    #          '1 bedroom', ...
    #  long  — many rows per LAD with a bedrooms/category column and a single
    #          rent/price value column.
    bed_cat_col = _find_col(df, ["bedroom category", "bedrooms", "bedroom",
                                 "property type"], contains=True)
    value_cols = [c for c in df.columns if c not in (rcode_col, bed_cat_col)
                  and re.search(r"rent|price|mean|median|quartile|bed",
                                str(c).lower())]
    props_by_code = {}
    if bed_cat_col and value_cols:
        # long format: fold each (code, bedroom-category) row into props.
        val_col = value_cols[0]
        for c in value_cols:
            if re.search(r"rent|price", str(c).lower()):
                val_col = c
                break
        for _, r in df.iterrows():
            code = _cell(r, rcode_col)
            v = _num(r, val_col)
            if not code or v is None:
                continue
            cat = _slug_key(_cell(r, bed_cat_col)) or "all"
            p = props_by_code.setdefault(code, {})
            p[f"rent_{cat}"] = v
            if "all" in cat:
                p.setdefault("rent_mean", v)
    elif value_cols:
        # wide format: one row per LAD.
        for _, r in df.iterrows():
            code = _cell(r, rcode_col)
            if not code:
                continue
            p = props_by_code.setdefault(code, {})
            for c in value_cols:
                v = _num(r, c)
                if v is None:
                    continue
                lc = str(c).lower()
                if "mean" in lc or "average" in lc:
                    p["rent_mean"] = v
                elif "lower quartile" in lc or re.search(r"\blq\b", lc):
                    p["rent_lq"] = v
                else:
                    p[_slug_key(c)] = v
    if not props_by_code:
        _warn("la_rents", "no usable rent values detected in the CSV")
        _note("la_rents", "no rent values detected")
        return out

    joined = gdf[gdf[code_col].astype(str).isin(props_by_code)] if code_col else gdf
    print(f"  [la_rents] {len(joined)}/{len(gdf)} LADs matched a rents row")

    def rent_props(f):
        p = dict(props_by_code.get(_cell(f, code_col), {}))
        p["lad_code"] = _cell(f, code_col)
        return p

    out["la_rents"] = _emit(joined, "la_rents", name_col=name_col,
                            id_col=code_col, want="polygon", props_fn=rent_props)
    _note("la_rents", f"{rhow}; joined on {rcode_col}", len(out["la_rents"]))
    return out


def build_alc():
    key = "alc"
    path, how = _resolve_arcgis_source(key, ["ALC_SRC"], ALC_DEFAULT_URL,
                                       "alc-england.geojson")
    if path is None:
        _warn(key, f"{how} — set ALC_SRC to the Natural England Provisional"
                   " ALC (England) GeoJSON or FeatureServer query URL")
        _note(key, how)
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    gdf = gpd.read_file(path)
    grade_col = _find_col(gdf, ["alc_grade", "alcgrade", "alc grade", "grade"],
                          contains=True)
    rows = _emit(gdf, key, name_col=grade_col, want="polygon",
                 props_fn=lambda f: {"alc_grade": _cell(f, grade_col)})
    _note(key, how, len(rows))
    return {key: rows}


def build_water_availability():
    key = "water_availability"
    path, how = _resolve_source(key, ["WATER_AVAILABILITY_SRC", "WATER_SRC"],
                                None, "water-availability.geojson")
    if path is not None:
        path = _maybe_unzip_geo(path, key)
    if path is None:
        _warn(key, "no source — set WATER_AVAILABILITY_SRC (or WATER_SRC) to"
                   " the EA CAMS 'water resource availability' GeoJSON/SHP"
                   " download (https://environment.data.gov.uk, search: CAMS"
                   " water resource availability).")
        _note(key, "WATER_AVAILABILITY_SRC not set (no default URL)")
        return {}
    print(f"  [{key}] reading {path.name} ({how}) ...")
    gdf = gpd.read_file(path)
    status_col = _find_col(gdf, ["colour", "color", "status", "availab",
                                 "class"], contains=True)
    rows = _emit(gdf, key, name_col=None, want="polygon",
                 assume_epsg=27700,  # EA shapefiles are BNG when CRS missing
                 props_fn=lambda f: {"status": _cell(f, status_col)})
    _note(key, how, len(rows))
    return {key: rows}


# Build groups: (produces, builder, extra dataset keys that also trigger the
# group even when none of its own outputs were requested — tec_register needs
# the substations built in the same run).
GROUPS = (
    [( [k], (lambda _k=k: build_planning_dataset(_k)), [] )
     for k in PLANNING_DATASETS]
    + [
        (["uni_campus"], build_uni_campus, []),
        (["uni_campus_site", "uni_building"], build_university_group, []),
        (["ptal"], build_ptal, []),
        (["power_line", "power_substation"], build_power_group,
         ["tec_register"]),
        (["gsp_boundary"], build_gsp_boundary, []),
        (["tec_register"], build_tec_register, []),
        (["lad_boundary", "la_rents"], build_rents_group, []),
        (["alc"], build_alc, []),
        (["water_availability"], build_water_availability, []),
    ]
)


def _resolve_datasets(cli_arg):
    raw = cli_arg or os.environ.get("DATASETS", "")
    if not raw.strip():
        return list(ALL_DATASETS)
    wanted = [d.strip() for d in raw.replace(",", " ").split() if d.strip()]
    unknown = [d for d in wanted if d not in ALL_DATASETS]
    if unknown:
        print(f"WARNING: ignoring unknown dataset(s): {', '.join(unknown)}")
    ordered = [d for d in ALL_DATASETS if d in wanted]
    return ordered or list(ALL_DATASETS)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the map_features import CSV.")
    ap.add_argument("--datasets", help="comma-separated subset of: "
                    + ",".join(ALL_DATASETS) + " (default: all). "
                    "Also settable via the DATASETS env var.")
    ap.add_argument("--out", default=str(OUT), help="output CSV path")
    args = ap.parse_args()

    selected = _resolve_datasets(args.datasets)
    out_path = Path(args.out)
    RAW.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Building datasets: {', '.join(selected)}")
    print(f"  SIMPLIFY_M={SIMPLIFY_M} (polygon simplify tolerance, metres)\n")

    fields = ["dataset", "source_id", "name", "props", "geom_wkt"]
    total = 0
    with out_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for produces, builder, also in GROUPS:
            wanted = [d for d in produces if d in selected]
            trigger = wanted or any(d in selected for d in also)
            if not trigger:
                continue
            # Best-effort per group: one failing dataset never aborts the run.
            try:
                built = builder() or {}
            except Exception as exc:
                for d in produces:
                    _warn(d, f"FAILED — skipping: {exc}")
                    _note(d, f"builder failed: {exc}")
                continue
            for d, rows in built.items():
                if d not in selected:
                    # Built only as a dependency (e.g. substations for the TEC
                    # join) — not written to the CSV.
                    print(f"  [{d}] built as a dependency only (not requested)")
                    continue
                for r in rows:
                    w.writerow({
                        "dataset": r["dataset"],
                        "source_id": r["source_id"],
                        "name": r["name"] or "",
                        "props": json.dumps(r["props"], separators=(",", ":"),
                                            ensure_ascii=False),
                        "geom_wkt": r["geom_wkt"],
                    })
                total += len(rows)
                print(f"  [{d}] {len(rows)} features written")

    size_mb = out_path.stat().st_size / 1e6
    print("\nSummary")
    print(f"  output: {out_path}  ({size_mb:.2f} MB, {total} features)")
    for d in selected:
        st = STATUS.get(d)
        if st is None:
            print(f"    {d:20s} (not built)")
        elif st["count"] is None:
            print(f"    {d:20s} skipped — {st['reason']}")
        else:
            print(f"    {d:20s} {st['count']} features ({st['reason']})")
    if total == 0:
        print("\nNo features written. Check the warnings above — most datasets"
              " download by default, but ptal/tec_register/la_rents/"
              "water_availability need operator-supplied *_SRC env vars.")
        return 1
    print("\nNext: python supabase/loaders/load_datasets.py "
          "(needs SUPABASE_URL + SUPABASE_SERVICE_KEY).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
