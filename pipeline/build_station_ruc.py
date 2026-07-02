"""
build_station_ruc.py
--------------------
Adds an ONS Rural-Urban Classification (RUC 2011) to every rail station, so the
developable-land tool can pick a sensible DEFAULT density regime (rural /
suburban / urban) for a site near that station.

Method (mirrors build_ttwa_gva.py's read/modify/write idiom on
web/data/stations.geojson, but does the spatial join with geopandas sjoin like
the boundary joins elsewhere in the pipeline):
  1. Load the RUC 2011 lookup CSV — keyed by 2011 LSOA code, carrying a RUC11
     code (e.g. 'A1') and its full ONS name (e.g. 'Urban major conurbation').
  2. Load LSOA boundaries (web/data/lsoa_imd.geojson, which carries an
     `lsoa_code` property) and point-in-polygon each station onto its LSOA.
  3. Map the station's LSOA -> RUC name/code -> one of THREE regimes.
  4. Rewrite web/data/stations.geojson, adding ruc_code / ruc_name /
     rural_urban to every feature's properties.

INPUTS (both Open Government Licence v3):
  data/raw/ruc_lsoa.csv        ONS "Rural Urban Classification (2011) of Lower
                               Layer Super Output Areas in England and Wales".
                               Env RUC_SRC overrides. A CSV keyed by LSOA11 code
                               with a RUC11 code + a RUC11 name column. Header
                               spellings vary between exports, so we match
                               leniently (see *_CANDIDATES below).
  web/data/lsoa_imd.geojson    LSOA boundaries with an `lsoa_code` property
                               (output of build_imd_layer.py). Env LSOA_SRC
                               overrides.
  web/data/stations.geojson    the stations to annotate (output of the station
                               builders).

OUTPUT (DATA CONTRACT — keep EXACT, the frontend relies on it): rewrites
  web/data/stations.geojson, adding to each feature's properties:
    rural_urban  one of 'rural' | 'suburban' | 'urban', or null if unmatched
    ruc_name     full ONS label (string; '' if unmatched)
    ruc_code     RUC11 code, e.g. 'A1' (string; '' if unmatched)

Note on geography: the RUC lookup is on 2011 LSOAs while lsoa_imd.geojson is on
2021 LSOAs. ~94% of codes are unchanged, so the join on `lsoa_code` matches the
vast majority of stations directly; the rest fall through to rural_urban=null
and are reported in the distribution summary.

Run (after the LSOA + station builders):
    python pipeline/build_station_ruc.py
"""

import json
import os
import sys
from pathlib import Path

import pandas as pd
import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
STATIONS = ROOT / "web" / "data" / "stations.geojson"

# Source resolution (env override, then first existing default).
RUC_DEFAULTS = ["ruc_lsoa.csv", "ruc_lsoa11.csv", "RUC11_LSOA.csv",
                "ruc.csv"]
LSOA_DEFAULTS = [ROOT / "web" / "data" / "lsoa_imd.geojson",
                 RAW / "lsoa_boundaries.geojson"]

# Lenient column matching in the RUC CSV. ONS/Nomis exports vary the wording.
RUC_LSOA_CODE_CANDIDATES = [
    "LSOA11CD", "LSOA11 Code", "LSOA code", "LSOA Code",
    "Lower Super Output Area 2011 Code", "lsoa_code", "geography code",
    "Geography Code", "mnemonic", "LSOA11CD ",
]
RUC_CODE_CANDIDATES = [
    "RUC11CD", "RUC11 Code", "Rural Urban Classification 2011 code",
    "Rural Urban Classification 2011 Code", "RUC code", "ruc_code",
]
RUC_NAME_CANDIDATES = [
    "RUC11", "RUC11NM", "RUC11 Name",
    "Rural Urban Classification 2011 (10 fold)",
    "Rural Urban Classification 2011 name",
    "Rural Urban Classification 2011", "RUC name", "ruc_name",
]

# ---- ONS RUC name -> our three density regimes ------------------------------
# This mapping is deliberately explicit and lives at the top because it is the
# kind of policy choice that gets tuned. Keys are the ONS base labels; the
# "... in a sparse setting" / "... sparse" variants collapse to the same regime
# (handled by _classify, which strips the sparse suffix before matching).
#   urban    -> dense conurbation cores (default HIGH density regime)
#   suburban -> smaller towns/cities (default MEDIUM density regime)
#   rural    -> towns' rural fringe, villages, hamlets (default LOW density)
REGIME_BY_RUC_NAME = {
    "Urban major conurbation":              "urban",
    "Urban minor conurbation":              "urban",
    "Urban city and town":                  "suburban",
    "Rural town and fringe":                "rural",
    "Rural village":                        "rural",
    "Rural hamlets and isolated dwellings": "rural",
    # Some exports spell the RUC differently; a couple of common aliases:
    "Urban city and town in a sparse setting": "suburban",
}

# Fallback by RUC11 code letter, so a lookup still works if the CSV only carries
# codes (A/B urban, C suburban, D/E/F rural). The digit (1 vs 2) is the sparse
# flag and does not change the regime.
REGIME_BY_CODE_LETTER = {
    "A": "urban",     # Urban major conurbation
    "B": "urban",     # Urban minor conurbation
    "C": "suburban",  # Urban city and town (+ sparse)
    "D": "rural",     # Rural town and fringe (+ sparse)
    "E": "rural",     # Rural village (+ sparse)
    "F": "rural",     # Rural hamlets and isolated dwellings (+ sparse)
}


def _pick(columns, candidates):
    """Case-insensitive lookup of the first candidate column present."""
    lower = {c.lower().strip(): c for c in columns}
    for cand in candidates:
        if cand.lower().strip() in lower:
            return lower[cand.lower().strip()]
    return None


def _classify(ruc_name, ruc_code):
    """Map an ONS RUC name/code to 'rural' | 'suburban' | 'urban', or None."""
    if isinstance(ruc_name, str) and ruc_name.strip():
        base = ruc_name.strip()
        # Collapse the sparse-setting variants onto their base label.
        for suffix in (" in a sparse setting", " (sparse)", " sparse"):
            if base.lower().endswith(suffix):
                base = base[: -len(suffix)].strip()
        if base in REGIME_BY_RUC_NAME:
            return REGIME_BY_RUC_NAME[base]
        # Loose contains-match as a last resort on the name.
        low = base.lower()
        if "major conurbation" in low or "minor conurbation" in low:
            return "urban"
        if "city and town" in low:
            return "suburban"
        if "rural" in low:
            return "rural"
    if isinstance(ruc_code, str) and ruc_code.strip():
        return REGIME_BY_CODE_LETTER.get(ruc_code.strip()[0].upper())
    return None


def _resolve_ruc_src():
    v = os.environ.get("RUC_SRC", "").strip()
    if v:
        return Path(v) if Path(v).exists() else None
    for n in RUC_DEFAULTS:
        p = RAW / n
        if p.exists():
            return p
    return None


def _resolve_lsoa_src():
    v = os.environ.get("LSOA_SRC", "").strip()
    if v and Path(v).exists():
        return Path(v)
    for p in LSOA_DEFAULTS:
        if p.exists():
            return p
    return None


def load_ruc_lookup(path):
    """Return {lsoa_code: (ruc_code, ruc_name)}. Sniffs the header row for the
    LSOA code + RUC code/name columns, tolerating preamble rows and varied
    spellings (mirrors the lenient loaders in build_imd_layer.py)."""
    print(f"Reading RUC 2011 lookup ({path.name}) ...")
    df = pd.read_csv(path, dtype=str)
    code_col = _pick(df.columns, RUC_LSOA_CODE_CANDIDATES)
    ruc_code_col = _pick(df.columns, RUC_CODE_CANDIDATES)
    ruc_name_col = _pick(df.columns, RUC_NAME_CANDIDATES)
    # ONS files sometimes carry title rows before the header — hunt for it.
    if code_col is None or (ruc_code_col is None and ruc_name_col is None):
        for skip in range(1, 12):
            try:
                trial = pd.read_csv(path, dtype=str, skiprows=skip)
            except Exception:
                continue
            c = _pick(trial.columns, RUC_LSOA_CODE_CANDIDATES)
            rc = _pick(trial.columns, RUC_CODE_CANDIDATES)
            rn = _pick(trial.columns, RUC_NAME_CANDIDATES)
            if c and (rc or rn):
                df, code_col, ruc_code_col, ruc_name_col = trial, c, rc, rn
                break

    if code_col is None or (ruc_code_col is None and ruc_name_col is None):
        print("  ERROR: couldn't find LSOA-code + RUC columns in the CSV.")
        print("  Columns seen:\n   " + "\n   ".join(df.columns))
        return None

    print(f"  columns -> lsoa: {code_col!r}  ruc_code: {ruc_code_col!r}  "
          f"ruc_name: {ruc_name_col!r}")
    lookup = {}
    for _, row in df.iterrows():
        code = row.get(code_col)
        if not isinstance(code, str) or not code.strip():
            continue
        rcode = (row.get(ruc_code_col) or "").strip() if ruc_code_col else ""
        rname = (row.get(ruc_name_col) or "").strip() if ruc_name_col else ""
        lookup[code.strip()] = (rcode, rname)
    print(f"  RUC classes for {len(lookup)} LSOAs")
    return lookup


def main() -> int:
    print("Adding ONS Rural-Urban Classification to stations...")
    ruc_src = _resolve_ruc_src()
    lsoa_src = _resolve_lsoa_src()
    if ruc_src is None:
        print("ERROR: no RUC lookup found. Download the ONS 'Rural Urban "
              "Classification (2011) of LSOAs in England and Wales' CSV and "
              "save it as data/raw/ruc_lsoa.csv (or set RUC_SRC). "
              "See docs/DATASETS.md.")
        return 1
    if lsoa_src is None:
        print(f"ERROR: no LSOA boundary source found (looked for "
              f"{[str(p) for p in LSOA_DEFAULTS]}). Run build_imd_layer.py "
              f"first, or set LSOA_SRC.")
        return 1
    if not STATIONS.exists():
        print(f"ERROR: {STATIONS} not found. Run the station builders first.")
        return 1

    ruc = load_ruc_lookup(ruc_src)
    if ruc is None:
        return 1

    # 1. LSOA boundaries -> GeoDataFrame with an `lsoa_code` column.
    print(f"Reading LSOA boundaries ({lsoa_src.name}) ...")
    lsoa = gpd.read_file(lsoa_src)
    if "lsoa_code" not in lsoa.columns:
        cands = [c for c in lsoa.columns
                 if c.upper().startswith("LSOA") and c.upper().endswith("CD")]
        if not cands:
            print(f"  ERROR: no lsoa_code column in {lsoa_src.name}. "
                  f"Columns: {list(lsoa.columns)}")
            return 1
        lsoa = lsoa.rename(columns={cands[0]: "lsoa_code"})
        print(f"  (used '{cands[0]}' as the LSOA code column)")
    lsoa = lsoa[["lsoa_code", "geometry"]]
    if lsoa.crs is None:
        lsoa = lsoa.set_crs(4326)
    else:
        lsoa = lsoa.to_crs(4326)
    print(f"  {len(lsoa)} LSOA polygons")

    # 2. Station points -> GeoDataFrame, positionally aligned to the features so
    #    we can write results straight back onto the original JSON (preserving
    #    every existing property + the metadata block, like build_ttwa_gva.py).
    sj = json.load(open(STATIONS, encoding="utf-8"))
    feats = sj["features"]
    pts, idx = [], []
    for i, feat in enumerate(feats):
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates")
        if geom.get("type") == "Point" and coords and len(coords) >= 2:
            pts.append((i, float(coords[0]), float(coords[1])))
    if not pts:
        print("ERROR: no point geometries in stations.geojson.")
        return 1
    idx = [p[0] for p in pts]
    stations_gdf = gpd.GeoDataFrame(
        {"feat_idx": idx},
        geometry=gpd.points_from_xy([p[1] for p in pts], [p[2] for p in pts]),
        crs=4326,
    )

    # 3. Point-in-polygon join (station -> LSOA).
    print("Joining stations to LSOAs (point-in-polygon)...")
    joined = gpd.sjoin(stations_gdf, lsoa, how="left", predicate="within")
    # A point on a shared border can match >1 polygon; keep the first per station.
    joined = joined.drop_duplicates(subset="feat_idx", keep="first")
    lsoa_by_feat = dict(zip(joined["feat_idx"], joined["lsoa_code"]))

    # 4. Look up each station's LSOA RUC, map to a regime, write onto the feature.
    counts = {"urban": 0, "suburban": 0, "rural": 0}
    no_lsoa = 0
    no_ruc = 0
    unmatched = 0
    for i, feat in enumerate(feats):
        props = feat["properties"]
        lsoa_code = lsoa_by_feat.get(i)
        rcode, rname, regime = "", "", None
        if not lsoa_code:
            no_lsoa += 1
        else:
            entry = ruc.get(str(lsoa_code))
            if entry is None:
                no_ruc += 1
            else:
                rcode, rname = entry
                regime = _classify(rname, rcode)
        props["ruc_code"] = rcode
        props["ruc_name"] = rname
        props["rural_urban"] = regime
        if regime is None:
            unmatched += 1
        else:
            counts[regime] += 1

    json.dump(sj, open(STATIONS, "w", encoding="utf-8"))

    # 5. Distribution summary.
    total = len(feats)
    print(f"\nRewrote {STATIONS.name} — {total} stations classified:")
    print(f"  urban    : {counts['urban']}")
    print(f"  suburban : {counts['suburban']}")
    print(f"  rural    : {counts['rural']}")
    print(f"  unmatched: {unmatched}  "
          f"(no LSOA hit: {no_lsoa}, LSOA with no RUC row: {no_ruc})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
