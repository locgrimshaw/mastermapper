"""
build_brownfield_site_csv.py
----------------------------
Transforms the planning.data.gov.uk **brownfield-site** dataset into a
Supabase-ready import CSV: supabase/brownfield_site_import.csv.

WHY a second brownfield builder? The national `brownfield-land` register that
pipeline/build_brownfield_csv.py loads is POINT-ONLY — 35,892 sites, every
`area` null. planning.data.gov.uk publishes a SEPARATE dataset,
`brownfield-site`, that DOES carry polygon footprints (almost all in London /
the boroughs that submitted shapes). This builder reads those polygons and
emits brand-new brownfield-table rows (distinct `reference`s) so they upsert on
(organisation, reference) as ADDITIONS — they never clobber the point register.

INPUT (download once; the asset host isn't reachable from CI, so commit it or
place it locally). Two easy ways to get it:
  - From https://www.planning.data.gov.uk/dataset/brownfield-site click
    "Download" and choose GeoJSON; OR
  - the entity API (already EPSG:4326):
    https://www.planning.data.gov.uk/entity.geojson?dataset=brownfield-site
Save it as one of:

    data/raw/brownfield-site.geojson   (preferred)
    data/raw/brownfield-site.json
    data/raw/brownfield_site.geojson

The properties (planning.data.gov.uk "entity" model) we use — header spellings
vary a little between exports, so we match leniently, exactly like the
brownfield-land builder:
    reference, name, organisation-entity (or organisation), site-address,
    point (WKT 'POINT (lon lat)'), hectares, minimum-net-dwellings,
    maximum-net-dwellings, deliverable, ownership-status,
    planning-permission-status, planning-permission-date, notes, site-plan-url
The polygon comes from the GeoJSON feature `geometry` (Polygon/MultiPolygon).

OUTPUT: supabase/brownfield_site_import.csv with the SAME columns
build_brownfield_csv.py emits, so the loader and the `brownfield` table treat
both feeds identically:
    reference, entity, organisation, name, site_address, hectares,
    dwellings_min, dwellings_max, ownership_status, is_public, deliverable,
    permission_status, permission_date, notes, source_url,
    geom_wkt (SRID=4326;POINT(lng lat)), area_wkt (SRID=4326;MULTIPOLYGON(...))

geom_wkt is the site's explicit `point` when present, else the polygon centroid
(so every row still has the NOT-NULL point the table requires). area_wkt is the
feature polygon promoted to a MultiPolygon. Features with neither a point nor a
polygon are dropped (we can't place them).

Licence: planning.data.gov.uk brownfield-site is Open Government Licence v3.0
(per-dataset — see docs/DATASETS.md). Attribute the publishing organisation and
"Contains public sector information licensed under the Open Government Licence
v3.0".

Run (or let the Action run it — see .github/workflows/load-brownfield-polygons.yml):
    python pipeline/build_brownfield_site_csv.py
"""

import csv
import re
import sys
from pathlib import Path

import geopandas as gpd
from shapely import to_wkt
from shapely import wkt as shapely_wkt
from shapely.geometry import MultiPolygon

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "brownfield_site_import.csv"

# Accept any of these as the downloaded source, in priority order.
SOURCE_CANDIDATES = [
    RAW / "brownfield-site.geojson",
    RAW / "brownfield-site.json",
    RAW / "brownfield_site.geojson",
    RAW / "brownfield_site.json",
]

# Coordinate precision kept in the output WKT (~0.1 m at 6 dp).
COORD_DP = 6

# Lenient property matching: our field -> list of source spellings. This is a
# copy of the brownfield-land builder's map (the two datasets share the BLR
# "entity" schema), so the same field-name variants are handled.
COLS = {
    "reference": ["reference", "Reference"],
    "entity": ["entity", "Entity", "entity-id"],
    "organisation": ["organisation-entity", "organisation", "OrganisationURI",
                     "organisation-name"],
    "name": ["name", "Name"],
    "site_address": ["site-address", "SiteNameAddress", "address"],
    "point": ["point", "Point", "GeoX_GeoY", "location"],
    "hectares": ["hectares", "Hectares", "site-area", "SiteareaHectares"],
    "dwellings_min": ["minimum-net-dwellings", "MinNetDwellings",
                      "NetDwellingsRangeFrom", "minimum-net-dwellings-range"],
    "dwellings_max": ["maximum-net-dwellings", "MaxNetDwellings",
                      "NetDwellingsRangeTo", "maximum-net-dwellings-range"],
    "ownership_status": ["ownership-status", "OwnershipStatus"],
    "deliverable": ["deliverable", "Deliverable"],
    "permission_status": ["planning-permission-status", "PlanningStatus",
                          "permission-status"],
    "permission_date": ["planning-permission-date", "PermissionDate",
                        "planning-permission-grant-date"],
    "notes": ["notes", "Notes"],
    "source_url": ["site-plan-url", "SiteplanURL", "documentation-url"],
}

# Ownership values that imply (some) public ownership — identical treatment to
# the brownfield-land builder so the `is_public` flag is consistent across feeds.
PUBLIC_OWNER_RE = re.compile(r"owned-by-a-public-authority|public|crown|council|mixed", re.I)
NOT_PUBLIC_RE = re.compile(r"not-owned-by-a-public-authority|private|not-public", re.I)

POINT_RE = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", re.I)


def _num(v):
    if v is None:
        return ""
    s = str(v).strip().replace(",", "")
    if s == "" or s.lower() in ("n/a", "na", "none", "null", "nan"):
        return ""
    try:
        return float(s)
    except ValueError:
        return ""


def _int(v):
    f = _num(v)
    if f == "":
        return ""
    return int(round(f))


def _is_public(ownership):
    """Map an ownership-status string to True/False/'' (unknown -> leave null).
    Mirrors build_brownfield_csv.py so both feeds flag ownership the same way."""
    if not ownership:
        return ""
    o = str(ownership)
    if NOT_PUBLIC_RE.search(o):
        if "mixed" in o.lower():
            return True
        return False
    if PUBLIC_OWNER_RE.search(o):
        return True
    return ""


def _pick(cols_lower, candidates):
    """Resolve one of our fields to the actual source column name (or None)."""
    for c in candidates:
        if c.lower() in cols_lower:
            return cols_lower[c.lower()]
    return None


def _cell(feat, col):
    """Cleaned string value for a feature property, '' when absent/NaN."""
    if not col or col not in feat:
        return ""
    v = feat[col]
    if v is None:
        return ""
    try:
        import pandas as pd
        if pd.isna(v):
            return ""
    except (TypeError, ValueError, ImportError):
        pass
    return str(v).strip()


def _to_multipolygon(geom):
    """Return a non-empty shapely MultiPolygon for any polygonal input, or None.
    GeometryCollections keep only their polygonal parts. (Same shape-promotion
    rule build_constraints.py uses for its polygon layers.)"""
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


def _point_wkt(point_val, geom):
    """Return 'SRID=4326;POINT(lng lat)' from the explicit `point` property if
    present, else from the polygon centroid. '' when neither is available."""
    # Explicit point property (WKT text) — the authoritative site location.
    if point_val:
        try:
            p = shapely_wkt.loads(str(point_val))
            if p.geom_type == "Point" and not p.is_empty:
                return f"SRID=4326;POINT({round(p.x, COORD_DP)} {round(p.y, COORD_DP)})"
        except Exception:
            m = POINT_RE.search(str(point_val))
            if m:
                return f"SRID=4326;POINT({m.group(1)} {m.group(2)})"
    # Fall back to the polygon centroid so the row still has a NOT-NULL point.
    if geom is not None and not geom.is_empty:
        c = geom.centroid
        if not c.is_empty:
            return f"SRID=4326;POINT({round(c.x, COORD_DP)} {round(c.y, COORD_DP)})"
    return ""


def _read_source():
    """Load the brownfield-site GeoJSON into a GeoDataFrame in EPSG:4326, or None
    if no source file is present (a clean skip so CI can still run PART B)."""
    src = next((p for p in SOURCE_CANDIDATES if p.exists()), None)
    if src is None:
        print("No brownfield-site source found — skipping PART A. Download the\n"
              "  planning.data.gov.uk brownfield-site GeoJSON from\n"
              "  https://www.planning.data.gov.uk/dataset/brownfield-site\n"
              "  (or https://www.planning.data.gov.uk/entity.geojson?dataset="
              "brownfield-site)\n"
              "  and save it as data/raw/brownfield-site.geojson")
        return None
    print(f"Reading {src.name} ...")
    gdf = gpd.read_file(src)
    # The dataset is already WGS84; set it if the file omitted the CRS, and
    # reproject defensively if it somehow arrived in another CRS.
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(4326)
    print(f"  {len(gdf)} features")
    return gdf


def main() -> int:
    gdf = _read_source()
    if gdf is None:
        return 0  # nothing to do; not an error (PART B may still run)
    if gdf.empty:
        print("No features in source.")
        return 0

    cols_lower = {c.lower(): c for c in gdf.columns if c != "geometry"}
    resolved = {field: _pick(cols_lower, cands) for field, cands in COLS.items()}
    if not resolved["reference"]:
        print("WARNING: no 'reference' property found; using a row index as ref.")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out_fields = ["reference", "entity", "organisation", "name", "site_address",
                  "hectares", "dwellings_min", "dwellings_max",
                  "ownership_status", "is_public", "deliverable",
                  "permission_status", "permission_date", "notes",
                  "source_url", "geom_wkt", "area_wkt"]

    written = have_polygon = public_n = dropped = 0
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=out_fields)
        w.writeheader()
        for i, (_, feat) in enumerate(gdf.iterrows()):
            def g(field):
                return _cell(feat, resolved.get(field))

            geom = feat.geometry
            point_wkt = _point_wkt(g("point"), geom)
            if not point_wkt:
                dropped += 1
                continue

            area_wkt = ""
            mp = _to_multipolygon(geom)
            if mp is not None:
                area_wkt = "SRID=4326;" + to_wkt(mp, rounding_precision=COORD_DP,
                                                 trim=True)
                have_polygon += 1

            ownership = g("ownership_status")
            pub = _is_public(ownership)
            if pub is True:
                public_n += 1

            ref = (g("reference") or f"row-{i}").strip()
            permission_date = g("permission_date")
            if permission_date and not re.match(r"\d{4}-\d{2}-\d{2}", permission_date):
                permission_date = ""

            w.writerow({
                "reference": ref,
                "entity": re.sub(r"\D", "", g("entity")),
                "organisation": g("organisation"),
                "name": (g("name") or ref).strip(),
                "site_address": g("site_address"),
                "hectares": _num(g("hectares")),
                "dwellings_min": _int(g("dwellings_min")),
                "dwellings_max": _int(g("dwellings_max")),
                "ownership_status": ownership,
                "is_public": ("" if pub == "" else ("true" if pub else "false")),
                "deliverable": g("deliverable"),
                "permission_status": g("permission_status"),
                "permission_date": permission_date,
                "notes": g("notes").replace("\n", " ")[:1000],
                "source_url": g("source_url"),
                "geom_wkt": point_wkt,
                "area_wkt": area_wkt,
            })
            written += 1

    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT}  ({size_kb:.0f} KB, {written} sites)")
    print(f"  with polygon footprint: {have_polygon} · point-only: "
          f"{written - have_polygon}")
    print(f"  flagged public-authority owned: {public_n}")
    if dropped:
        print(f"  dropped {dropped} features with no usable location")
    print("Next: the loader (supabase/loaders/load_brownfield_polygons.py) "
          "upserts these as NEW brownfield rows on (organisation, reference).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
