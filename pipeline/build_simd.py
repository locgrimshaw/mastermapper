"""
build_simd.py
-------------
Build web/data/simd_points.geojson — one Point per Scottish Data Zone (2011,
6,976 zones) carrying the Scottish Index of Multiple Deprivation 2020 as
0..100 national percentiles (100 = most deprived), plus population and (optional)
prices. This is Scotland's analogue of web/data/lsoa_imd_points.geojson, and it
loads into the public.simd table the same way (http-load from the published file),
feeding rebuild_station_scotland() for catchment deprivation / population.

SOURCE (Open Government Licence): Scottish Government SIMD 2020, served as an
ArcGIS FeatureServer/MapServer layer that carries the Data Zone polygons plus the
overall + per-domain ranks. Default points at the ScotGov PeopleSociety SIMD2020
layer; override with SIMD_ARCGIS_URL. We page through it, take each zone's
representative point, and convert ranks -> percentiles.

  env SIMD_ARCGIS_URL   ArcGIS layer query base (…/MapServer/<id>), default below.
  env SIMD_POP_SRC      optional CSV of Data Zone populations (data_zone,population)
                        if the layer lacks a population field (NRS mid-year est.).

Run (CI has open internet; the agent proxy may block maps.gov.scot locally):
  python pipeline/build_simd.py
Then publish web/data/simd_points.geojson and http-load public.simd, then
  select public.rebuild_station_scotland();
"""

import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data" / "simd_points.geojson"      # Data Zone CENTROIDS (DB + catchment)
OUT_POLY = ROOT / "web" / "data" / "simd.geojson"        # Data Zone POLYGONS (map choropleth)
RAW = ROOT / "data" / "raw"

# ScotGov SIMD2020 layer (Data Zone polygons + ranks). Override via env.
DEFAULT_URL = ("https://maps.gov.scot/server/rest/services/ScotGov/"
               "PeopleSociety/MapServer/7")
N_DATAZONES = 6976   # SIMD 2020 rank denominator (1 = most deprived)
PAGE = 1000

# Flexible field matching — ArcGIS field names vary across SIMD publications.
DZ_COLS   = ["DataZone", "DZ", "data_zone", "datazone", "DZ_CODE", "dzcode"]
NAME_COLS = ["DZname", "DZName", "Name", "council", "council_name", "LAName", "la_name"]
POP_COLS  = ["Total_population", "Totpop", "population", "pop", "Population",
             "TotPop2020", "Working_age_population"]
# rank -> percentile. Provide the overall + per-domain rank field candidates.
RANK_COLS = {
    "overall":    ["Rankv2", "SIMD2020v2_Rank", "SIMD2020_Rank", "Rank", "SIMD_Rank", "OverallRank"],
    "income":     ["IncRankv2", "Income_Domain_2020_Rank", "IncRank", "Income_rank"],
    "employment": ["EmpRankv2", "Employment_Domain_2020_Rank", "EmpRank", "Employment_rank"],
    "education":  ["EduRankv2", "Education_Domain_2020_Rank", "EduRank", "Education_rank"],
    "health":     ["HlthRankv2", "Health_Domain_2020_Rank", "HlthRank", "Health_rank"],
    "crime":      ["CrimeRankv2", "Crime_Domain_2020_Rank", "CrimeRank", "Crime_rank"],
    "housing":    ["HouseRankv2", "Housing_Domain_2020_Rank", "HouseRank", "Housing_rank"],
    "access":     ["AccessRankv2", "Access_Domain_2020_Rank", "GAccRank", "Access_rank"],
}


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _find(keys, cands):
    kn = {_norm(k): k for k in keys}
    for c in cands:
        if _norm(c) in kn:
            return kn[_norm(c)]
    return None


def _rank_to_pctile(rank):
    """SIMD rank 1 (most deprived) .. N (least). Return 0..100 with 100 = most
    deprived, matching the English overall_norm convention."""
    try:
        r = float(rank)
    except (TypeError, ValueError):
        return None
    if r <= 0:
        return None
    return round((1.0 - (r - 1.0) / (N_DATAZONES - 1.0)) * 100.0, 1)


def _fetch_json(url, attempts=5):
    # The ScotGov ArcGIS host intermittently 403s a bare request and rate-limits
    # rapid paging, so send browser-like headers and retry with backoff.
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://simd.scot/",
    }
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last = exc
            # linear-ish backoff; a fixed sleep is fine in CI (no wall-clock deps).
            import time
            time.sleep(3 * (i + 1))
    raise last


def _representative_point(geom):
    """Centroid-ish point for an ArcGIS/GeoJSON polygon without a geo dependency:
    average of the exterior ring vertices of the largest ring. Good enough at
    Data Zone scale for catchment weighting."""
    try:
        import geopandas as gpd  # noqa
        from shapely.geometry import shape
        g = shape(geom)
        p = g.representative_point()
        return [round(p.x, 6), round(p.y, 6)]
    except Exception:
        # Fallback: mean of the first ring's coords.
        coords = []
        gt = geom.get("type")
        if gt == "Polygon":
            coords = geom["coordinates"][0]
        elif gt == "MultiPolygon":
            coords = geom["coordinates"][0][0]
        if not coords:
            return None
        xs = [c[0] for c in coords]; ys = [c[1] for c in coords]
        return [round(sum(xs) / len(xs), 6), round(sum(ys) / len(ys), 6)]


def _load_pop_csv():
    """Optional external Data Zone population CSV -> {data_zone: population}."""
    src = os.environ.get("SIMD_POP_SRC", "").strip()
    path = Path(src) if src else (RAW / "simd_population.csv")
    if not path.exists():
        return {}
    import csv
    out = {}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        dz = _find(reader.fieldnames or [], DZ_COLS)
        pc = _find(reader.fieldnames or [], POP_COLS + ["count", "value"])
        if not dz or not pc:
            return {}
        for row in reader:
            k = (row.get(dz) or "").strip()
            v = (row.get(pc) or "").replace(",", "").strip()
            if k and v:
                try:
                    out[k] = int(float(v))
                except ValueError:
                    pass
    return out


def _object_ids(query):
    """All OBJECTIDs for the layer. Offset paging (resultOffset) on the ScotGov
    SIMD layer silently caps at ~4,000 of 6,976 zones; harvesting by objectId
    batches instead returns every zone. Returns (ids, oid_field) or ([], None)."""
    url = query + "?" + urllib.parse.urlencode({"where": "1=1", "returnIdsOnly": "true", "f": "json"})
    try:
        data = _fetch_json(url)
    except Exception as exc:
        print(f"  SIMD id-query failed: {exc}")
        return [], None
    if isinstance(data, dict) and data.get("error"):
        print(f"  SIMD id-query error: {data['error']}")
        return [], None
    return data.get("objectIds") or [], data.get("objectIdFieldName") or "OBJECTID"


def _iter_pages(query):
    """Yield GeoJSON feature pages covering every zone. Prefers objectId batches
    (complete); falls back to offset paging if the id-query is unavailable."""
    ids, oid_field = _object_ids(query)
    if ids:
        print(f"  SIMD: {len(ids)} object ids -> harvesting in batches")
        for i in range(0, len(ids), PAGE):
            chunk = ids[i:i + PAGE]
            params = {"objectIds": ",".join(str(x) for x in chunk),
                      "outFields": "*", "returnGeometry": "true",
                      "outSR": "4326", "f": "geojson"}
            try:
                data = _fetch_json(query + "?" + urllib.parse.urlencode(params))
            except Exception as exc:
                print(f"  SIMD batch {i} failed: {exc}"); continue
            if isinstance(data, dict) and data.get("error"):
                print(f"  SIMD batch {i} error: {data['error']}"); continue
            yield data.get("features", [])
        return
    # Fallback: offset paging.
    print("  SIMD: no object ids returned — falling back to offset paging")
    offset = 0
    while True:
        params = {"where": "1=1", "outFields": "*", "returnGeometry": "true",
                  "outSR": "4326", "f": "geojson",
                  "resultOffset": offset, "resultRecordCount": PAGE}
        try:
            data = _fetch_json(query + "?" + urllib.parse.urlencode(params))
        except Exception as exc:
            print(f"  SIMD fetch failed at offset {offset}: {exc}"); break
        page = data.get("features", [])
        if not page:
            break
        yield page
        if len(page) < PAGE:
            break
        offset += PAGE


def main() -> int:
    base = (os.environ.get("SIMD_ARCGIS_URL") or DEFAULT_URL).rstrip("/")
    query = base + "/query"
    pop_csv = _load_pop_csv()

    points, polys = [], []     # centroid features (DB) + polygon features (choropleth)
    fld_map = None
    seen = set()
    for page in _iter_pages(query):
        if not page:
            continue
        if fld_map is None:
            keys = list((page[0].get("properties") or {}).keys())
            fld_map = {
                "dz": _find(keys, DZ_COLS),
                "name": _find(keys, NAME_COLS),
                "pop": _find(keys, POP_COLS),
                **{k: _find(keys, v) for k, v in RANK_COLS.items()},
            }
            print(f"  SIMD field map: {fld_map}")
            if not fld_map["dz"] or not fld_map["overall"]:
                print("  ERROR: could not find DataZone / overall-rank fields; aborting.")
                print(f"  available fields: {keys}")
                return 1
        for f in page:
            p = f.get("properties") or {}
            g = f.get("geometry")
            if not g:
                continue
            dz = (p.get(fld_map["dz"]) or "").strip()
            if not dz or dz in seen:
                continue
            pt = _representative_point(g)
            if not pt:
                continue
            seen.add(dz)
            pop = None
            if fld_map["pop"] and p.get(fld_map["pop"]) not in (None, ""):
                try:
                    pop = int(float(p[fld_map["pop"]]))
                except (TypeError, ValueError):
                    pop = None
            if pop is None:
                pop = pop_csv.get(dz)
            props = {"data_zone": dz,
                     "council_name": (p.get(fld_map["name"]) if fld_map["name"] else None),
                     "population": pop}
            for dom in RANK_COLS:
                col = fld_map.get(dom)
                props[f"{dom}_norm"] = _rank_to_pctile(p.get(col)) if col else None
            points.append({"type": "Feature",
                           "geometry": {"type": "Point", "coordinates": pt},
                           "properties": props})
            # Polygon feature for the map choropleth (only real polygon geometry).
            if g.get("type") in ("Polygon", "MultiPolygon"):
                polys.append({"type": "Feature", "geometry": g, "properties": props})
        print(f"  total zones so far: {len(points)}")

    if not points:
        print("No SIMD features built (check SIMD_ARCGIS_URL / network). Nothing written.")
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": points}, fh, separators=(",", ":"))
    n_pop = sum(1 for f in points if f["properties"]["population"] is not None)
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(points)} Data Zones ({n_pop} with population).")

    if polys:
        with OUT_POLY.open("w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": polys}, fh, separators=(",", ":"))
        print(f"Wrote {OUT_POLY.relative_to(ROOT)}: {len(polys)} Data Zone polygons (map choropleth).")
    else:
        print("  (no polygon geometry returned — simd.geojson not written; choropleth needs it)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
