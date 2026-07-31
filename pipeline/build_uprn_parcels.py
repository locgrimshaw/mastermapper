"""
build_uprn_parcels.py
---------------------
Join public-body asset registers to INSPIRE land parcels using a PRECISE
locator — a UPRN or a published coordinate — instead of a postcode centroid.

WHY THIS EXISTS. The existing public_parcel layer (pair_public_parcels.py)
places a CCOD owner by the centroid of its postcode. That is structurally
lossy, not merely imprecise: CCOD holds 187,666 public land titles but only
120,789 distinct postcode+owner points, and a point can claim at most one
parcel, so 66,877 titles cannot be represented at all. A centroid also lands on
the road often enough that a 30 m proximity rescue was needed to recover it.

An asset register gives one locator PER HOLDING, so a council with 40 titles at
one postcode gets 40 points rather than one. Confidence is recorded per row:
    match='uprn'   located via OS Open UPRN (a point on the building)
    match='coord'  located by a coordinate the register published itself
                   (usually a plot centroid — better than a UPRN for LAND)
Both sit alongside the existing 'contains' and 'nearest' so the map can show
how a parcel was attributed rather than implying they are equally certain.

Inputs:
  data/raw/council_assets.csv   from fetch_council_assets.py (harvest artifact)
  data/raw/osopenuprn.csv       OS Open UPRN, only needed for uprn-only rows
  PARCEL_DIR/parcels-*.jsonl    HMLR INSPIRE shards (build-parcel-tiles artifacts)
Output:
  supabase/datasets_import.csv  dataset public_parcel

Licence: INSPIRE index polygons © Crown copyright and database right, HM Land
Registry; OS Open UPRN © Crown copyright, OGL; asset registers © their
publishing authorities, OGL.
"""

import csv
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "supabase" / "datasets_import.csv"
ASSETS = Path(os.environ.get("COUNCIL_ASSETS")
              or (ROOT / "data" / "raw" / "council_assets.csv"))
OSUPRN = Path(os.environ.get("OS_OPEN_UPRN")
              or (ROOT / "data" / "raw" / "osopenuprn.csv"))

# A register's stated area vs the parcel it lands in. A 5 ha plot inside a
# 0.2 ha parcel means the point fell in a neighbour, not that the council owns a
# sliver — so the match is recorded but flagged rather than trusted silently.
AREA_LO = float(os.environ.get("AREA_RATIO_LO") or "0.2")
AREA_HI = float(os.environ.get("AREA_RATIO_HI") or "5.0")

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

# Publishers whose rows are not land HOLDINGS even though the dataset passed the
# harvester's title filter. The Joint Nature Conservation Committee's "Species
# point records from 1987 OPRU HRE Newtown and Bembridge" is the case in point:
# 451 rows of biological survey sightings, each with a grid reference. Joining
# those would label a parcel as OWNED BY the JNCC because somebody once recorded
# a bird standing on it.
PUBLISHER_DENY = re.compile(r"joint\s*nature\s*conservation", re.I)
# Northern Ireland: INSPIRE index polygons cover England and Wales only, so
# these can never match. Dropped up front so they do not read as a join failure.
NI_PUBLISHER = re.compile(r"opendatani|\bnorthern\s*ireland\b", re.I)


def _dedupe_key(r):
    """Identify the same holding across repeated snapshots of one register.

    The Cabinet Office estate is published as several overlapping extracts —
    79,416 + 65,630 + 52,994 + 880 + 418 rows of the same estate, 92% of the
    whole harvest. A UPRN identifies a holding directly; otherwise the published
    coordinate does, at 6dp (~0.1 m), which is far finer than any of these
    registers actually locate a plot."""
    u = (r.get("uprn") or "").strip()
    c = (r.get("council") or "").strip().lower()
    if u:
        return (c, "u", u)
    return (c, "c", round(r["_lng"], 6), round(r["_lat"], 6))


def read_assets():
    """Asset rows that carry a usable locator, plus the set of UPRNs to resolve."""
    if not ASSETS.exists():
        print(f"ERROR: {ASSETS} not found — run fetch_council_assets.py or "
              "download the council_assets_csv artifact.", file=sys.stderr)
        return None, None
    rows, need = [], set()
    seen = set()
    n_read = n_dup = n_denied = n_ni = 0
    with ASSETS.open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            n_read += 1
            council = r.get("council") or ""
            if PUBLISHER_DENY.search(council):
                n_denied += 1
                continue
            if NI_PUBLISHER.search(council):
                n_ni += 1
                continue
            lng, lat = r.get("lng") or "", r.get("lat") or ""
            uprn = (r.get("uprn") or "").strip()
            if lng and lat:
                try:
                    r["_lng"], r["_lat"] = float(lng), float(lat)
                except ValueError:
                    continue
            elif uprn:
                r["_lng"] = r["_lat"] = None
            else:
                continue
            # Dedupe BEFORE the UPRN lookup: otherwise five snapshots of one
            # estate inflate props.assets to "5 holdings here" for a parcel that
            # holds one, and the popup states that as fact.
            k = _dedupe_key(r)
            if k in seen:
                n_dup += 1
                continue
            seen.add(k)
            if r["_lng"] is None:
                need.add(uprn)
            rows.append(r)
    print(f"[uprn] {n_read:,} row(s) read -> {len(rows):,} distinct holding(s) "
          f"({n_dup:,} duplicate row(s) across repeated register snapshots"
          + (f", {n_denied:,} non-holding publisher" if n_denied else "")
          + (f", {n_ni:,} Northern Ireland (no INSPIRE cover)" if n_ni else "")
          + ")")
    print(f"[uprn] {len(need):,} need an OS Open UPRN lookup, "
          f"{len(rows) - len(need):,} already carry a coordinate")
    return rows, need


def resolve_uprns(need):
    """UPRN -> (lng, lat) for just the UPRNs we need.

    OS Open UPRN is ~40M rows, so it is streamed and only the wanted keys are
    kept: holding the whole file would cost gigabytes for a few thousand hits."""
    if not need:
        return {}
    # This lookup is OPTIONAL and must degrade, never abort. The vast majority
    # of holdings carry their own coordinate (75,810 of 85,191 on the first real
    # run) and need nothing from this file. The first attempt died here with
    # PermissionError: the OS zip stores the CSV with mode 000 and unzip
    # preserves it, so the file existed, passed the .exists() check, and then
    # failed to open — taking down a run that had already spent four minutes
    # unpacking 24.4M parcels, to save 11% of the points. Any OSError is caught
    # for the same reason.
    try:
        fh = OSUPRN.open(newline="", encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        print(f"  WARNING: cannot read {OSUPRN} ({exc}) — continuing WITHOUT it. "
              f"{len(need):,} UPRN-only holding(s) will be dropped; every "
              "coordinate-bearing holding is unaffected.", file=sys.stderr)
        return {}
    found, seen = {}, 0
    with fh:
        rd = csv.DictReader(fh)
        cols = {c.lower(): c for c in (rd.fieldnames or [])}
        ucol = cols.get("uprn")
        latc = cols.get("latitude")
        lonc = cols.get("longitude")
        if not (ucol and latc and lonc):
            print(f"  WARNING: unexpected OS Open UPRN columns: {rd.fieldnames}",
                  file=sys.stderr)
            return {}
        for rec in rd:
            seen += 1
            u = (rec.get(ucol) or "").strip()
            if u in need:
                try:
                    found[u] = (float(rec[lonc]), float(rec[latc]))
                except (TypeError, ValueError):
                    pass
            if seen % 5_000_000 == 0:
                print(f"    [uprn] {seen:,} OS rows scanned, "
                      f"{len(found):,}/{len(need):,} resolved", flush=True)
    print(f"[uprn] resolved {len(found):,}/{len(need):,} UPRN(s) from "
          f"{seen:,} OS Open UPRN rows")
    return found


def main() -> int:
    try:
        from shapely.geometry import shape, Point, box
        from shapely.strtree import STRtree
        from shapely.ops import transform as shp_transform
        from pyproj import Transformer
    except ImportError as e:
        print(f"ERROR: shapely + pyproj required ({e})", file=sys.stderr)
        return 1

    rows, need = read_assets()
    if rows is None:
        return 1
    coords = resolve_uprns(need)

    pts, meta = [], []
    unresolved = 0
    for r in rows:
        if r["_lng"] is None:
            hit = coords.get((r.get("uprn") or "").strip())
            if not hit:
                unresolved += 1
                continue
            r["_lng"], r["_lat"] = hit
            r["_how"] = "uprn"
        else:
            r["_how"] = "coord"
        pts.append(Point(r["_lng"], r["_lat"]))
        meta.append(r)
    print(f"[uprn] {len(pts):,} located asset point(s) "
          f"({unresolved:,} unresolved UPRN(s) dropped)")
    if not pts:
        print("ERROR: nothing located", file=sys.stderr)
        return 1

    src_dir = Path(os.environ.get("PARCEL_DIR") or (ROOT / "data" / "raw"))
    files = sorted(src_dir.glob("parcels-*.jsonl"))
    if not files:
        print(f"ERROR: no parcels-*.jsonl in {src_dir}", file=sys.stderr)
        return 1

    tree = STRtree(pts)
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True).transform

    matched, scanned = {}, 0
    for path in files:
        with path.open(encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                scanned += 1
                if scanned % 500_000 == 0:
                    print(f"[uprn] {scanned:,} parcels scanned, "
                          f"{len(matched):,} matched", flush=True)
                try:
                    feat = json.loads(line)
                    poly = shape(feat["geometry"])
                except Exception:
                    continue
                if poly.is_empty:
                    continue
                minx, miny, maxx, maxy = poly.bounds
                idxs = tree.query(box(minx, miny, maxx, maxy))
                if len(idxs) == 0:
                    continue
                inside = [int(i) for i in idxs if poly.contains(pts[int(i)])]
                if not inside:
                    continue
                area_m2 = shp_transform(to_bng, poly).area
                fid = (feat.get("properties") or {}).get("INSPIREID") \
                    or f"{poly.centroid.x:.6f},{poly.centroid.y:.6f}"
                key = str(fid)
                # Several plots of one estate can share a parcel; keep the row
                # but record how many assets consolidated into it.
                best = meta[inside[0]]
                stated = None
                for i in inside:
                    a = meta[i].get("area_ha")
                    try:
                        stated = float(a) if a not in (None, "") else stated
                    except ValueError:
                        pass
                props = {
                    "owner": best.get("council"),
                    "owner_class": "public_asset_register",
                    "match": best["_how"],
                    "assets": len(inside),
                    "area_m2": round(area_m2),
                    "description": (best.get("description") or "")[:180] or None,
                    "address": (best.get("address") or "")[:180] or None,
                    "source_url": best.get("source_url"),
                }
                if stated:
                    props["stated_ha"] = round(stated, 3)
                    ratio = (area_m2 / 10_000.0) / stated if stated > 0 else None
                    if ratio is not None:
                        props["area_ratio"] = round(ratio, 2)
                        # Flagged, not dropped: the operator can judge it, and a
                        # silent drop would hide a systematic alignment problem.
                        props["area_mismatch"] = not (AREA_LO <= ratio <= AREA_HI)
                matched[key] = {"geom": poly, "props": props}

    n_coord = sum(1 for v in matched.values() if v["props"]["match"] == "coord")
    n_flag = sum(1 for v in matched.values() if v["props"].get("area_mismatch"))
    owners = {v["props"]["owner"] for v in matched.values()}
    print(f"[uprn] {scanned:,} parcels scanned -> {len(matched):,} matched "
          f"({n_coord:,} by coordinate, {len(matched) - n_coord:,} by UPRN) "
          f"across {len(owners)} publisher(s)")
    if n_flag:
        print(f"[uprn] {n_flag:,} match(es) flagged: the register's stated area "
              f"is outside {AREA_LO}-{AREA_HI}x the parcel it landed in")
    if not matched:
        print("ERROR: no parcels matched", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for key, v in matched.items():
            w.writerow({
                "dataset": "public_parcel",
                # Own id namespace: these must never collide with the
                # postcode-centroid rows, which keep their own keys.
                "source_id": f"ar-{key}"[:120],
                "name": v["props"]["owner"],
                "props": json.dumps({k: x for k, x in v["props"].items()
                                     if x is not None},
                                    separators=(",", ":"), ensure_ascii=False),
                "geom_wkt": "SRID=4326;" + v["geom"].wkt,
            })
    print(f"[uprn] wrote {len(matched):,} rows to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
