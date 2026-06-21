"""
build_brownfield_csv.py
-----------------------
Transforms the national brownfield-land dataset (planning.data.gov.uk) into a
Supabase-ready import CSV: supabase/brownfield_import.csv.

This is the "supply" layer for Workstream 2 — every English Brownfield Land
Register Part 1 site, with its estimated dwelling capacity, area, ownership and
deliverability. It lives in Supabase (not a static file) because it's the first
of several large planning layers and we want spatial "sites in this catchment"
queries server-side (see supabase/migrations/0004_brownfield.sql).

INPUT (download once; the asset host isn't reachable from CI, so commit it or
place it locally): from https://www.planning.data.gov.uk/dataset/brownfield-land
click "Download" and choose CSV (preferred) or GeoJSON. Save as:

    data/raw/brownfield-land.csv      (or .json / .geojson)

The CSV columns (planning.data.gov.uk "entity" model) we use:
    reference, name, organisation-entity (or organisation), site-address,
    point (WKT 'POINT (lon lat)'), geometry (WKT MULTIPOLYGON/POLYGON, often ''),
    hectares, minimum-net-dwellings, maximum-net-dwellings, deliverable,
    ownership-status, planning-permission-status, planning-permission-date,
    notes, site-plan-url
Header spellings vary a little between exports, so we match leniently.

OUTPUT: supabase/brownfield_import.csv with columns ready for the staging table
in supabase/import_brownfield.sql:
    reference, organisation, name, site_address, hectares,
    dwellings_min, dwellings_max, ownership_status, is_public, deliverable,
    permission_status, permission_date, notes, source_url,
    geom_wkt (SRID=4326;POINT(lng lat)), area_wkt (SRID=4326;... or '')

Sites with no point are dropped (we can't place them). Sites with a point but
no polygon keep area_wkt empty → they render as markers, per the agreed design.

Run:
    python pipeline/build_brownfield_csv.py
"""

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "brownfield_import.csv"

# Accept any of these as the downloaded source, in priority order.
SOURCE_CANDIDATES = [
    RAW / "brownfield-land.csv",
    RAW / "brownfield_land.csv",
    RAW / "brownfield-land.json",
    RAW / "brownfield-land.geojson",
    RAW / "brownfield_land.geojson",
]

# Lenient header matching: map our field -> list of source spellings.
COLS = {
    "reference": ["reference", "Reference"],
    "organisation": ["organisation-entity", "organisation", "OrganisationURI",
                     "organisation-name"],
    "name": ["name", "Name"],
    "site_address": ["site-address", "SiteNameAddress", "address"],
    "point": ["point", "Point", "GeoX_GeoY", "location"],
    "geometry": ["geometry", "Geometry", "wkt"],
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

# Ownership values that imply (some) public ownership. The source's main
# negative value is 'not-owned-by-a-public-authority'; everything else that
# mentions a public authority (incl. 'mixed-ownership') counts as public-ish.
PUBLIC_OWNER_RE = re.compile(r"owned-by-a-public-authority|public|crown|council|mixed", re.I)
NOT_PUBLIC_RE = re.compile(r"not-owned-by-a-public-authority|private|not-public", re.I)

POINT_RE = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", re.I)


def _read_source():
    """Return (rows, kind) where kind is 'csv' or 'geojson'. rows is a list of
    dicts keyed by source column / GeoJSON property."""
    src = next((p for p in SOURCE_CANDIDATES if p.exists()), None)
    if src is None:
        print("ERROR: no brownfield source file found. Download the national "
              "brownfield-land dataset (CSV or GeoJSON) from\n"
              "  https://www.planning.data.gov.uk/dataset/brownfield-land\n"
              "and save it as data/raw/brownfield-land.csv")
        return None, None

    if src.suffix.lower() in (".json", ".geojson"):
        print(f"Reading {src.name} (GeoJSON)...")
        gj = json.loads(src.read_text(encoding="utf-8"))
        rows = []
        for f in gj.get("features", []):
            props = dict(f.get("properties") or {})
            # Carry the geometry through so we can derive point + polygon WKT.
            props["__geometry__"] = f.get("geometry")
            rows.append(props)
        return rows, "geojson"

    # CSV (try utf-8 then cp1252, like the ORR builder).
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with src.open(newline="", encoding=enc) as fh:
                rows = list(csv.DictReader(fh))
            print(f"Reading {src.name} (CSV, {enc}) — {len(rows)} rows")
            return rows, "csv"
        except UnicodeDecodeError:
            continue
    print(f"ERROR: couldn't decode {src.name} in any known encoding.")
    return None, None


def _pick(row_keys_lower, candidates):
    for c in candidates:
        if c.lower() in row_keys_lower:
            return row_keys_lower[c.lower()]
    return None


def _num(v):
    if v is None:
        return ""
    s = str(v).strip().replace(",", "")
    if s == "" or s.lower() in ("n/a", "na", "none", "null"):
        return ""
    try:
        f = float(s)
        return f
    except ValueError:
        return ""


def _int(v):
    f = _num(v)
    if f == "":
        return ""
    return int(round(f))


def _point_wkt_from(point_val, geometry_val, geojson_geom):
    """Derive an 'SRID=4326;POINT(lng lat)' string and an optional polygon WKT.

    Priority for the point: explicit `point` field, else centroid of polygon
    (not computed here — we only take an explicit point), else from GeoJSON
    geometry if it's a Point. Returns (point_wkt, area_wkt). area_wkt is '' when
    there's no polygon."""
    point_wkt = ""
    area_wkt = ""

    # Point from explicit WKT field.
    if point_val:
        m = POINT_RE.search(str(point_val))
        if m:
            point_wkt = f"SRID=4326;POINT({m.group(1)} {m.group(2)})"

    # Polygon from explicit WKT geometry field.
    if geometry_val and str(geometry_val).strip():
        gv = str(geometry_val).strip()
        if gv.upper().startswith(("POLYGON", "MULTIPOLYGON")):
            area_wkt = f"SRID=4326;{gv}"

    # GeoJSON geometry path.
    if geojson_geom:
        gtype = geojson_geom.get("type")
        if gtype == "Point" and not point_wkt:
            c = geojson_geom.get("coordinates") or []
            if len(c) >= 2:
                point_wkt = f"SRID=4326;POINT({c[0]} {c[1]})"
        elif gtype in ("Polygon", "MultiPolygon") and not area_wkt:
            # Convert GeoJSON polygon to WKT, and if no point, use a rough
            # centroid (first ring's average) so the site is still placeable.
            try:
                area_wkt = "SRID=4326;" + _geojson_to_wkt(geojson_geom)
            except Exception:
                area_wkt = ""
            if not point_wkt:
                pt = _rough_centroid(geojson_geom)
                if pt:
                    point_wkt = f"SRID=4326;POINT({pt[0]} {pt[1]})"

    return point_wkt, area_wkt


def _geojson_to_wkt(geom):
    """Minimal GeoJSON Polygon/MultiPolygon -> WKT (no shapely dependency)."""
    def ring(r):
        return "(" + ", ".join(f"{x} {y}" for x, y, *_ in r) + ")"
    t = geom["type"]
    coords = geom["coordinates"]
    if t == "Polygon":
        return "POLYGON(" + ", ".join(ring(r) for r in coords) + ")"
    if t == "MultiPolygon":
        return "MULTIPOLYGON(" + ", ".join(
            "(" + ", ".join(ring(r) for r in poly) + ")" for poly in coords
        ) + ")"
    raise ValueError("unsupported geometry")


def _rough_centroid(geom):
    """A cheap centroid: average of the outer-ring vertices. Good enough to drop
    a marker; not used when an explicit point exists."""
    try:
        if geom["type"] == "Polygon":
            ring = geom["coordinates"][0]
        else:  # MultiPolygon
            ring = geom["coordinates"][0][0]
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        return (round(sum(xs) / len(xs), 6), round(sum(ys) / len(ys), 6))
    except Exception:
        return None


def _is_public(ownership):
    if not ownership:
        return ""    # unknown -> leave null, don't guess
    o = str(ownership)
    if NOT_PUBLIC_RE.search(o):
        # 'mixed-ownership' contains neither 'not-...' nor a clean private flag
        # in practice, but guard: if it also matches public (mixed), treat as
        # public. Pure 'not-owned-by-a-public-authority' -> false.
        if "mixed" in o.lower():
            return True
        return False
    if PUBLIC_OWNER_RE.search(o):
        return True
    return ""    # unknown wording -> null


def main() -> int:
    rows, kind = _read_source()
    if rows is None:
        return 1
    if not rows:
        print("No rows in source.")
        return 1

    # Resolve column names once from the first row's keys.
    sample_keys = {k.lower(): k for k in rows[0].keys()}
    resolved = {field: _pick(sample_keys, cands) for field, cands in COLS.items()}
    missing_core = [f for f in ("reference", "point") if not resolved[f]]
    # `point` may be absent in some GeoJSON exports (geometry carries it) — only
    # warn, don't fail, since the geometry path can still place sites.
    if not resolved["reference"]:
        print("WARNING: no 'reference' column found; using row index as ref.")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out_fields = ["reference", "organisation", "name", "site_address",
                  "hectares", "dwellings_min", "dwellings_max",
                  "ownership_status", "is_public", "deliverable",
                  "permission_status", "permission_date", "notes",
                  "source_url", "geom_wkt", "area_wkt"]

    written = 0
    no_point = 0
    have_polygon = 0
    public_n = 0
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=out_fields)
        w.writeheader()
        for i, row in enumerate(rows):
            def g(field):
                col = resolved.get(field)
                return row.get(col) if col else None

            point_wkt, area_wkt = _point_wkt_from(
                g("point"), g("geometry"), row.get("__geometry__"))
            if not point_wkt:
                no_point += 1
                continue
            if area_wkt:
                have_polygon += 1

            ownership = g("ownership_status") or ""
            pub = _is_public(ownership)
            if pub is True:
                public_n += 1

            ref = (g("reference") or f"row-{i}").strip()
            permission_date = (g("permission_date") or "").strip()
            # Normalise obvious non-dates to empty so the date column imports.
            if permission_date and not re.match(r"\d{4}-\d{2}-\d{2}", permission_date):
                permission_date = ""

            w.writerow({
                "reference": ref,
                "organisation": (g("organisation") or "").strip(),
                "name": (g("name") or ref).strip(),
                "site_address": (g("site_address") or "").strip(),
                "hectares": _num(g("hectares")),
                "dwellings_min": _int(g("dwellings_min")),
                "dwellings_max": _int(g("dwellings_max")),
                "ownership_status": ownership.strip(),
                "is_public": ("" if pub == "" else ("true" if pub else "false")),
                "deliverable": (g("deliverable") or "").strip(),
                "permission_status": (g("permission_status") or "").strip(),
                "permission_date": permission_date,
                "notes": (g("notes") or "").strip().replace("\n", " ")[:1000],
                "source_url": (g("source_url") or "").strip(),
                "geom_wkt": point_wkt,
                "area_wkt": area_wkt,
            })
            written += 1

    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT}  ({size_kb:.0f} KB, {written} sites)")
    print(f"  with polygon footprint: {have_polygon} · point-only (markers): "
          f"{written - have_polygon}")
    print(f"  flagged public-authority owned: {public_n}")
    if no_point:
        print(f"  dropped {no_point} sites with no usable location")
    print("Next: upload supabase/brownfield_import.csv via the Supabase Table "
          "Editor and run supabase/import_brownfield.sql (see that file).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
