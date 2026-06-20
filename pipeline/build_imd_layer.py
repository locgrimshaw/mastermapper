"""
build_imd_layer.py
------------------
Turns raw English IMD 2025 data + LSOA 2021 boundaries into a single GeoJSON
the map can consume directly.

Inputs (you download these — see docs/DATASETS.md):
  data/raw/imd2025_scores.csv      English IoD 2025, File 7 (all ranks/scores/
                                   deciles) by LSOA — includes LSOA name AND
                                   Local Authority District name in the file.
  data/raw/lsoa_boundaries.geojson LSOA 2021 boundaries (generalised), fetched
                                   by fetch_boundaries.py.

Output:
  web/data/lsoa_imd.geojson        one feature per LSOA, with normalised
                                   0-100 metrics + raw scores + names.

Run:  python pipeline/build_imd_layer.py
"""

import sys
from pathlib import Path

import pandas as pd
import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"

# The 7 IMD domains we expose as adjustable metrics, plus overall.
# Keys are our internal names; values are the *score* column names as they
# appear in the official IoD 2025 File 7 CSV (verified against the published
# file — these are unchanged from 2019).
DOMAIN_SCORE_COLUMNS = {
    "overall":    "Index of Multiple Deprivation (IMD) Score",
    "income":     "Income Score (rate)",
    "employment": "Employment Score (rate)",
    "education":  "Education, Skills and Training Score",
    "health":     "Health Deprivation and Disability Score",
    "crime":      "Crime Score",
    "housing":    "Barriers to Housing and Services Score",
    "environment":"Living Environment Score",
}

# 2025 File 7 column names. The geography moved from 2011 to 2021 LSOAs, and the
# file now carries LSOA name AND Local Authority District name directly — so we
# no longer need the fragile ONS name-lookup web service that 2019 required.
IMD_LSOA_CODE = "LSOA code (2021)"
IMD_LSOA_NAME = "LSOA name (2021)"
IMD_LAD_NAME  = "Local Authority District name (2024)"
# The LSOA code field in the 2021 boundary file (ONS calls it LSOA21CD).
GEO_LSOA_CODE = "LSOA21CD"

# Resident population per LSOA. Source: ONS mid-year population estimates by
# 2021 LSOA (download separately — see docs/DATASETS.md). Optional: if the file
# is absent the build still runs, just without a population field (the app then
# hides population/density stats gracefully). We accept a few common column
# spellings for the code and the count so a fresh ONS download "just works".
POP_FILENAME = "lsoa_population.csv"
POP_CODE_CANDIDATES = [
    "LSOA 2021 Code", "LSOA code (2021)", "LSOA21CD", "lsoa_code", "Area code",
]
POP_COUNT_CANDIDATES = [
    # IMD 2025 File 7 carries population denominators directly — preferred, as
    # it needs no extra download. Its column is the "Total population" field.
    "Total population: mid 2022 (excluding prisoners)",
    "Total population: mid 2021 (excluding prisoners)",
    "Total population: mid 2020 (excluding prisoners)",
    "Total population",
    # Generic / standalone ONS mid-year estimate spellings.
    "Total", "All Ages", "All ages", "Population", "population",
    "Mid-2022 population", "Mid-year population", "Observation",
]


def district_from_lsoa_name(name):
    """LSOA names look like 'Camden 001A' — the district is everything before
    the trailing 'NNNX' code. A reliable fallback if the LAD lookup is empty."""
    if not isinstance(name, str):
        return None
    import re
    m = re.match(r"^(.*?)\s+\d{3}[A-Z]?$", name.strip())
    return m.group(1) if m else name


def normalise_0_100(series: pd.Series) -> pd.Series:
    """Percentile-rank to 0-100. Higher = more deprived (worse).

    We use percentile rank rather than min-max so a few extreme outliers
    don't compress everyone else into a narrow band. 100 = most deprived
    in England, 0 = least.
    """
    return (series.rank(pct=True) * 100).round(1)


def load_population(raw_dir: Path) -> pd.DataFrame | None:
    """Load resident population by LSOA, if the file is present.

    Returns a DataFrame with columns ['lsoa_code', 'population'] or None when
    the file is absent. ONS publishes these tables with varying headers (and
    sometimes a few preamble rows), so we sniff the header row and accept any of
    the common code/count column spellings.
    """
    pop_path = raw_dir / POP_FILENAME
    if not pop_path.exists():
        print(f"  (no {POP_FILENAME} — building without population)")
        return None

    print(f"Reading population estimates ({POP_FILENAME})...")
    # ONS files sometimes carry title rows before the header. Try a direct read
    # first; if neither a code nor a count column is found, hunt for the header.
    def _pick(cols, candidates):
        lower = {c.lower().strip(): c for c in cols}
        for cand in candidates:
            if cand.lower() in lower:
                return lower[cand.lower()]
        return None

    df = pd.read_csv(pop_path, dtype=str)
    code_col = _pick(df.columns, POP_CODE_CANDIDATES)
    count_col = _pick(df.columns, POP_COUNT_CANDIDATES)
    if code_col is None or count_col is None:
        for skip in range(1, 12):
            try:
                trial = pd.read_csv(pop_path, dtype=str, skiprows=skip)
            except Exception:
                continue
            code_col = _pick(trial.columns, POP_CODE_CANDIDATES)
            count_col = _pick(trial.columns, POP_COUNT_CANDIDATES)
            if code_col and count_col:
                df = trial
                break

    if code_col is None or count_col is None:
        print("  WARNING: couldn't find LSOA-code / population columns in "
              f"{POP_FILENAME}. Columns seen:\n   " + "\n   ".join(df.columns))
        print("  Building without population.")
        return None

    out = df[[code_col, count_col]].rename(
        columns={code_col: "lsoa_code", count_col: "population"}
    )
    out["lsoa_code"] = out["lsoa_code"].str.strip()
    # Counts may carry thousands separators; coerce to a clean integer.
    out["population"] = (
        out["population"].astype(str).str.replace(",", "", regex=False)
    )
    out["population"] = pd.to_numeric(out["population"], errors="coerce")
    out = out.dropna(subset=["lsoa_code", "population"])
    out["population"] = out["population"].round().astype(int)
    print(f"  population for {len(out)} LSOAs "
          f"(total {out['population'].sum():,})")
    return out


def main() -> int:
    imd_path = RAW / "imd2025_scores.csv"
    geo_path = RAW / "lsoa_boundaries.geojson"

    if not imd_path.exists() or not geo_path.exists():
        print("ERROR: raw data missing. Expected:")
        print(f"  {imd_path}")
        print(f"  {geo_path}")
        print("See docs/DATASETS.md for download links.")
        return 1

    print("Reading IoD 2025 scores (File 7)...")
    imd = pd.read_csv(imd_path)

    # File 7 carries a "Total population" denominator column. Capture it up front
    # (before we trim to the score columns) so we don't need a separate download.
    pop_from_imd = None
    _imd_lower = {c.lower().strip(): c for c in imd.columns}
    _imd_code = _imd_lower.get(IMD_LSOA_CODE.lower())
    for cand in POP_COUNT_CANDIDATES:
        col = _imd_lower.get(cand.lower())
        if col and _imd_code:
            pop_from_imd = imd[[_imd_code, col]].rename(
                columns={_imd_code: "lsoa_code", col: "population"}
            )
            pop_from_imd["lsoa_code"] = pop_from_imd["lsoa_code"].astype(str).str.strip()
            pop_from_imd["population"] = pd.to_numeric(
                pop_from_imd["population"].astype(str).str.replace(",", "", regex=False),
                errors="coerce",
            )
            pop_from_imd = pop_from_imd.dropna(subset=["population"])
            pop_from_imd["population"] = pop_from_imd["population"].round().astype(int)
            print(f"  population taken from File 7 column '{col}' "
                  f"({len(pop_from_imd)} LSOAs)")
            break

    # Keep only the columns we need, renamed to our internal names. The 2025
    # File 7 carries LSOA name AND Local Authority District name in the file, so
    # we take both straight from the CSV (no network lookup needed any more).
    keep = {IMD_LSOA_CODE: "lsoa_code"}
    if IMD_LSOA_NAME in imd.columns:
        keep[IMD_LSOA_NAME] = "lsoa_name"
    if IMD_LAD_NAME in imd.columns:
        keep[IMD_LAD_NAME] = "lad_name"
    for name, col in DOMAIN_SCORE_COLUMNS.items():
        if col not in imd.columns:
            print(f"  WARNING: column not found in CSV: '{col}'")
            print(f"  Available columns:\n   " + "\n   ".join(imd.columns))
            return 1
        keep[col] = f"{name}_score_raw"
    imd = imd[list(keep)].rename(columns=keep)

    print("Normalising each domain to 0-100 (percentile rank)...")
    for name in DOMAIN_SCORE_COLUMNS:
        raw = imd[f"{name}_score_raw"]
        imd[f"{name}_norm"] = normalise_0_100(raw)

    print("Reading LSOA boundaries...")
    geo = gpd.read_file(geo_path)
    if GEO_LSOA_CODE not in geo.columns:
        # Boundary files vary; try to find the code column.
        candidates = [c for c in geo.columns if c.upper().startswith("LSOA") and c.upper().endswith("CD")]
        if not candidates:
            print(f"  ERROR: no LSOA code column in boundary file. Columns: {list(geo.columns)}")
            return 1
        geo = geo.rename(columns={candidates[0]: GEO_LSOA_CODE})
        print(f"  (used '{candidates[0]}' as the LSOA code column)")

    geo = geo.rename(columns={GEO_LSOA_CODE: "lsoa_code"})
    geo = geo[["lsoa_code", "geometry"]]

    print("Joining scores to geometry...")
    merged = geo.merge(imd, on="lsoa_code", how="inner")
    print(f"  {len(merged)} LSOAs matched "
          f"({len(geo)} boundaries, {len(imd)} score rows)")
    if len(merged) == 0:
        print("  ERROR: no LSOAs matched. This usually means a geography "
              "mismatch — check the boundaries are 2021 LSOAs (LSOA21CD) to "
              "match the IoD 2025 codes.")
        return 1

    # Ensure the name columns exist even if the CSV layout surprised us.
    if "lsoa_name" not in merged.columns:
        merged["lsoa_name"] = None
    if "lad_name" not in merged.columns:
        merged["lad_name"] = None

    # Fallback: derive the district from the LSOA name ("Camden 001A" -> "Camden")
    # wherever the CSV didn't supply a LAD name. Belt-and-braces; the 2025 file
    # should populate lad_name for every row.
    missing = merged["lad_name"].isna()
    if missing.any():
        merged.loc[missing, "lad_name"] = merged.loc[missing, "lsoa_name"].apply(
            district_from_lsoa_name
        )
    n_named = merged["lad_name"].notna().sum()
    print(f"  district names present on {n_named}/{len(merged)} LSOAs")

    # Resident population (optional layer). Prefer File 7's own denominator
    # column; otherwise fall back to a separately-downloaded lsoa_population.csv.
    # Left-join either way so LSOAs without a match carry a null population,
    # which the frontend handles gracefully.
    pop = pop_from_imd if pop_from_imd is not None else load_population(RAW)
    if pop is not None:
        merged = merged.merge(pop, on="lsoa_code", how="left")
        n_pop = merged["population"].notna().sum()
        print(f"  population present on {n_pop}/{len(merged)} LSOAs")
        # GeoJSON/JS prefer a real number or null over NaN.
        merged["population"] = merged["population"].astype("Int64")

    # Keep close-up detail. Tiles (tippecanoe) already simplify per zoom level —
    # they keep full detail at the deepest zoom and simplify only the zoomed-out
    # tiles — so we must NOT heavily pre-simplify here or that detail is gone
    # before tiling. We apply only a tiny 8m clean-up (removes near-duplicate
    # vertices that bloat the file without visible benefit) and keep 5 decimal
    # places (~1m) so streets-level zoom stays crisp.
    #   SIMPLIFY_M  — drop vertices closer together than this many metres
    #   COORD_DP    — decimal places kept in the output lon/lat
    SIMPLIFY_M = 8
    COORD_DP = 5
    print(f"Light geometry clean-up (tolerance {SIMPLIFY_M}m, {COORD_DP}dp)...")
    merged = merged.to_crs(27700)
    merged["geometry"] = merged["geometry"].simplify(SIMPLIFY_M, preserve_topology=True)
    merged = merged.to_crs(4326)

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "lsoa_imd.geojson"
    # Write with limited coordinate precision (GeoPandas passes COORDINATE_PRECISION
    # through to the GeoJSON driver).
    merged.to_file(out_path, driver="GeoJSON", COORDINATE_PRECISION=COORD_DP)
    size_mb = out_path.stat().st_size / 1e6
    print(f"Wrote {out_path}  ({size_mb:.1f} MB)")
    if size_mb > 25:
        print("  NOTE: still large. If the map feels slow, the next step is")
        print("  vector tiles (tippecanoe) rather than raw GeoJSON.")
    return 0


if __name__ == "__main__":
    sys.exit(main())