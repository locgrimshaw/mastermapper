"""
build_brownfield_inspire.py
---------------------------
Gives POLYGON boundaries to the point-only brownfield-land sites by matching
each site POINT to the HM Land Registry INSPIRE land parcel that contains it,
and writes the result to a Supabase-ready import CSV:

    supabase/brownfield_inspire_import.csv
        columns: reference, organisation, area_wkt (EWKT MultiPolygon)

Unlike build_brownfield_site_csv.py (which adds NEW rows), this is an UPDATE:
the loader PATCHes the `area` column of EXISTING brownfield rows, keyed by
(organisation, reference). Sites whose point falls in no parcel are left as they
are — point-only markers.

⚠️  LICENCE CAVEAT — READ BEFORE PUBLISHING INSPIRE-DERIVED BOUNDARIES  ⚠️
HM Land Registry INSPIRE Index Polygons are NOT plain Open Government Licence
data. They carry re-use conditions: they contain Ordnance Survey data
(© Crown copyright and database rights) and are provided under the Land Registry
INSPIRE end-user licence, which RESTRICTS onward republication. Deriving site
boundaries from them and publishing those boundaries may NOT be freely
permitted — check the current INSPIRE licence and OS terms before making these
polygons public. The user has accepted pursuing them with that caveat in mind.
See docs/DATASETS.md for the full note.

INPUTS
------
1. Brownfield-land POINTS — the site set to enrich. Read from the same national
   download the point loader uses, in priority order:
       data/raw/brownfield-land.csv    (WKT 'point' column)
       data/raw/brownfield-land.geojson / .json   (Point geometries)
   Each site contributes (reference, organisation, point). If none of these
   files is present, this builder skips cleanly (documented input requirement).

2. INSPIRE parcels — one or more per-LPA files under:
       data/raw/inspire/*.gml       (INSPIRE GML, EPSG:27700 -> reprojected)
       data/raw/inspire/*.geojson    (or *.json, any CRS -> reprojected to 4326)
   INSPIRE is published as hundreds of per-Local-Planning-Authority GML zips
   from the Land Registry / use1.uk INSPIRE download index. The NATIONAL set is
   heavy (hundreds of files, many GB unzipped), so this builder is deliberately
   REGIONAL: it processes whatever parcel files you drop in data/raw/inspire/
   and leaves every un-covered point untouched. Add LPAs incrementally.

POINT-IN-POLYGON JOIN
---------------------
Each site point is spatially joined to its CONTAINING parcel (predicate
"within"):
  - ZERO parcels   -> the point is not in the join output; the site stays
                      point-only (no row emitted, `area` untouched).
  - ONE parcel     -> that parcel becomes the site's boundary.
  - MANY parcels   -> overlapping/nested INSPIRE parcels can both contain a
                      point; we keep the SMALLEST-AREA containing parcel (the
                      most specific plot) and drop the rest. Deterministic, and
                      avoids attaching a whole block when a single plot fits.

Run (or let the Action run it — see .github/workflows/load-brownfield-polygons.yml):
    python pipeline/build_brownfield_inspire.py
"""

import csv
import sys
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely import to_wkt
from shapely import wkt as shapely_wkt
from shapely.geometry import MultiPolygon

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
INSPIRE_DIR = RAW / "inspire"
OUT = ROOT / "supabase" / "brownfield_inspire_import.csv"

# Brownfield-land POINT source (same candidates as the point loader/builder).
POINT_CANDIDATES = [
    RAW / "brownfield-land.csv",
    RAW / "brownfield_land.csv",
    RAW / "brownfield-land.geojson",
    RAW / "brownfield-land.json",
    RAW / "brownfield_land.geojson",
]

# INSPIRE parcels are British National Grid unless the file says otherwise.
INSPIRE_ASSUMED_EPSG = 27700
COORD_DP = 6

# CSV can carry very long WKT fields (parcel rings) — lift the field-size cap.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _to_multipolygon(geom):
    """Return a non-empty shapely MultiPolygon for any polygonal input, or None."""
    if geom is None or geom.is_empty:
        return None
    gt = geom.geom_type
    if gt == "Polygon":
        return MultiPolygon([geom])
    if gt == "MultiPolygon":
        return geom
    if gt == "GeometryCollection":
        from shapely.ops import unary_union
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        return _to_multipolygon(unary_union(polys))
    return None


def _col(cols_lower, *names):
    for n in names:
        if n.lower() in cols_lower:
            return cols_lower[n.lower()]
    return None


def load_points():
    """Return a GeoDataFrame (EPSG:4326) of brownfield-land site points with
    columns reference, organisation, geometry — or None if no source present."""
    src = next((p for p in POINT_CANDIDATES if p.exists()), None)
    if src is None:
        print("No brownfield-land POINT source found under data/raw/ "
              "(brownfield-land.csv/.geojson) — skipping PART B.\n"
              "  This is the same national download build_brownfield_csv.py "
              "uses; commit it to enrich points with INSPIRE parcels.")
        return None

    if src.suffix.lower() in (".geojson", ".json"):
        print(f"Reading points from {src.name} (GeoJSON) ...")
        gdf = gpd.read_file(src)
        if gdf.crs is None:
            gdf = gdf.set_crs(4326)
        elif gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(4326)
        cols_lower = {c.lower(): c for c in gdf.columns if c != "geometry"}
        ref_c = _col(cols_lower, "reference", "Reference")
        org_c = _col(cols_lower, "organisation-entity", "organisation",
                     "organisation-name", "OrganisationURI")
        gdf = gdf[gdf.geometry.notna()].copy()
        gdf["geometry"] = gdf.geometry.representative_point()
        out = gpd.GeoDataFrame({
            "reference": gdf[ref_c].astype(str).str.strip() if ref_c else "",
            "organisation": gdf[org_c].astype(str).str.strip() if org_c else "",
            "geometry": gdf.geometry,
        }, crs=4326)
    else:
        print(f"Reading points from {src.name} (CSV) ...")
        df = None
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                df = pd.read_csv(src, dtype=str, encoding=enc)
                break
            except UnicodeDecodeError:
                continue
        if df is None:
            print(f"  ERROR: couldn't decode {src.name}.")
            return None
        cols_lower = {c.lower(): c for c in df.columns}
        ref_c = _col(cols_lower, "reference", "Reference")
        org_c = _col(cols_lower, "organisation-entity", "organisation",
                     "organisation-name", "OrganisationURI")
        pt_c = _col(cols_lower, "point", "Point", "location")
        if not pt_c:
            print("  ERROR: no 'point' (WKT) column in the CSV; cannot place "
                  "sites.")
            return None

        geoms, refs, orgs = [], [], []
        for _, row in df.iterrows():
            pv = row.get(pt_c)
            if not pv or str(pv).strip() == "":
                continue
            try:
                p = shapely_wkt.loads(str(pv))
            except Exception:
                continue
            if p.is_empty or p.geom_type != "Point":
                continue
            geoms.append(p)
            refs.append(str(row.get(ref_c, "") or "").strip())
            orgs.append(str(row.get(org_c, "") or "").strip())
        out = gpd.GeoDataFrame(
            {"reference": refs, "organisation": orgs, "geometry": geoms},
            crs=4326)

    out = out[out.geometry.notna() & ~out.geometry.is_empty].copy()
    print(f"  {len(out)} site points")
    return out


def load_inspire():
    """Read every parcel file under data/raw/inspire/ into one GeoDataFrame in
    EPSG:4326, or None if the directory has no usable files."""
    if not INSPIRE_DIR.exists():
        print(f"No INSPIRE directory ({INSPIRE_DIR}) — skipping PART B.\n"
              "  Drop per-LPA INSPIRE parcel files (*.gml or *.geojson) there. "
              "INSPIRE is regional and heavy; add LPAs as needed.")
        return None

    files = sorted(
        [p for p in INSPIRE_DIR.iterdir()
         if p.suffix.lower() in (".gml", ".geojson", ".json")])
    if not files:
        print(f"No *.gml / *.geojson parcel files in {INSPIRE_DIR} — skipping "
              "PART B.")
        return None

    frames = []
    for f in files:
        try:
            g = gpd.read_file(f)
        except Exception as exc:
            print(f"  WARNING: could not read {f.name} ({exc}); skipping it.")
            continue
        if g.empty:
            continue
        # INSPIRE GML is EPSG:27700; assume that when a file omits its CRS.
        if g.crs is None:
            g = g.set_crs(INSPIRE_ASSUMED_EPSG)
        if g.crs.to_epsg() != 4326:
            g = g.to_crs(4326)
        g = g[g.geometry.notna() & ~g.geometry.is_empty]
        g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
        if not g.empty:
            frames.append(g[["geometry"]].copy())
            print(f"  {f.name}: {len(g)} parcels")

    if not frames:
        print("  No usable parcels after reading INSPIRE files.")
        return None
    parcels = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=4326)
    print(f"  {len(parcels)} INSPIRE parcels total")
    return parcels


def main() -> int:
    points = load_points()
    if points is None or points.empty:
        return 0
    parcels = load_inspire()
    if parcels is None or parcels.empty:
        return 0

    # Give every parcel a stable index and an area for the "smallest wins"
    # tie-break when a point sits inside multiple (nested/overlapping) parcels.
    parcels = parcels.reset_index(drop=True)
    parcels["_parcel_id"] = parcels.index
    # Area in EPSG:27700 (square metres) is a faithful magnitude for picking the
    # most specific plot; degrees-squared would distort with latitude.
    parcels["_area_m2"] = parcels.geometry.to_crs(27700).area

    # Point-in-polygon join. A point inside N parcels yields N joined rows.
    joined = gpd.sjoin(
        points, parcels[["_parcel_id", "_area_m2", "geometry"]],
        how="inner", predicate="within")
    if joined.empty:
        print("No site points fell within any INSPIRE parcel — nothing to "
              "write. (Points left point-only, as designed.)")
        return 0

    # MANY parcels per point -> keep the smallest-area containing parcel.
    joined = joined.sort_values("_area_m2")
    joined["_site_key"] = (joined["organisation"].astype(str) + "\x1f"
                           + joined["reference"].astype(str))
    best = joined.drop_duplicates("_site_key", keep="first")

    parcel_geom = parcels.set_index("_parcel_id").geometry

    OUT.parent.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["reference", "organisation", "area_wkt"])
        w.writeheader()
        for _, r in best.iterrows():
            ref = str(r["reference"]).strip()
            org = str(r["organisation"]).strip()
            if not ref:
                skipped += 1
                continue
            mp = _to_multipolygon(parcel_geom.loc[r["_parcel_id"]])
            if mp is None:
                skipped += 1
                continue
            area_wkt = "SRID=4326;" + to_wkt(mp, rounding_precision=COORD_DP,
                                             trim=True)
            w.writerow({"reference": ref, "organisation": org,
                        "area_wkt": area_wkt})
            written += 1

    matched_pct = (written / len(points) * 100) if len(points) else 0
    print(f"Wrote {OUT}  ({written} boundaries for {len(points)} points, "
          f"{matched_pct:.1f}% matched)")
    if skipped:
        print(f"  skipped {skipped} match(es) with no reference / empty geometry")
    print("  Points with no containing parcel were left point-only.")
    print("Next: the loader PATCHes the `area` column of these existing "
          "(organisation, reference) rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
