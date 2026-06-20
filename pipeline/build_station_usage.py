"""
build_station_usage.py
----------------------
Builds the STATION layer used by the station-led analysis (Workstream 1):
every England heavy-rail (mainline) station as a point, carrying passenger
USAGE (annual entries + exits), a recent multi-year TREND, the operator, and
its CRS code.

This is the demand dimension on top of the station *locations* we already have
(in rail.geojson / the committed uk_stations.csv). It powers:
  - the station picker / search,
  - the station-profile deep dive (the "usage" signal of the need/supply/usage
    triad),
  - ranking and comparison of stations.

Heavy rail ONLY for now (Network Rail's estate). Metro/tram/Underground are
intentionally excluded here even though rail.geojson carries them.

Inputs (committed; see docs/DATASETS.md):
  data/raw/orr_station_usage.csv   ORR "Estimates of station usage", Table 1410
                                   (Passenger entries and exits and interchanges
                                   by station), the CSV variant. We also accept
                                   the time-series Table 1415 to derive a trend.
  web/data/rail.geojson            station LOCATIONS (output of
                                   build_rail_layer.py); we take its mode="rail"
                                   stops as the canonical England station set and
                                   their coordinates.

Why join to rail.geojson rather than use ORR's own coordinates? rail.geojson is
already England-filtered, already on the map, and already keyed by CRS — so the
station the user clicks and the usage figure line up exactly. ORR coordinates
(OS grid / lat-long) vary by release and would risk a second, slightly-offset
set of points.

Output:
  web/data/stations.geojson        one Point feature per England mainline
                                   station with usage + trend + operator + crs.

Matching: by CRS code first (exact, reliable), then by normalised name as a
fallback. Stations with a location but no usage match still emit (usage = null),
so the layer degrades gracefully — the same policy as house prices / rail.

Run (or let the Action run it):
  python pipeline/build_station_usage.py
"""

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
RAIL_GEOJSON = ROOT / "web" / "data" / "rail.geojson"
USAGE_CSV = RAW / "orr_station_usage.csv"
OUT = ROOT / "web" / "data" / "stations.geojson"

# Candidate column names in the ORR Table 1410 CSV. ORR tweaks headers between
# releases, so we sniff a set of plausible spellings rather than hard-code one.
CRS_CANDIDATES = ["TLC", "CRS", "crs", "crsCode", "Station CRS", "3-Alpha Code",
                  "Three Letter Code", "NLC code"]
NAME_CANDIDATES = ["Station Name", "Station name", "station", "stationName",
                   "Name", "Station"]
OPERATOR_CANDIDATES = ["Station Facility Owner", "Operator", "TOC",
                       "Train Operating Company", "Owning Operator",
                       "Station operator"]
# Entries+exits for the latest year. ORR labels this column with the year, e.g.
# "1415: Entries & Exits 2024-25" or "Entries and exits 2023-24". We match by
# pattern: a column mentioning entries/exits (and not "interchange").
ENTRIES_EXITS_HINT = re.compile(r"entr.*exit|entries.*exits", re.I)
INTERCHANGE_HINT = re.compile(r"interchang", re.I)
YEAR_HINT = re.compile(r"(19|20)\d{2}\s*[-/]\s*\d{2,4}")


def norm_name(s: str) -> str:
    """Normalise a station name for fuzzy matching: lowercase, drop punctuation,
    collapse whitespace, and strip common suffixes that differ between sources
    (e.g. '(Rail Station)', 'Rail Station')."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"\(.*?\)", " ", s)                     # drop parentheticals
    s = re.sub(r"\b(rail|railway)?\s*station\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _pick(header, candidates):
    low = {h.lower().strip(): h for h in header}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


def _find_entries_exits_cols(header):
    """Return (latest_col, [year-labelled cols...]) for entries+exits.

    Time-series files (Table 1415) carry several year columns; the single-year
    Table 1410 carries one. We collect every entries-&-exits column (ignoring
    interchange columns) and treat the right-most year as 'latest'.
    """
    cols = []
    for h in header:
        if ENTRIES_EXITS_HINT.search(h) and not INTERCHANGE_HINT.search(h):
            ym = YEAR_HINT.search(h)
            cols.append((h, ym.group(0) if ym else None))
    if not cols:
        # Some single-year files just call it "Entries and Exits" with the year
        # only in the file name. Fall back to any non-interchange numeric-looking
        # column whose header contains 'entries' or 'exits'.
        for h in header:
            if re.search(r"entr|exit", h, re.I) and not INTERCHANGE_HINT.search(h):
                cols.append((h, None))
    if not cols:
        return None, []
    # Order by the year string where present so the last is the most recent.
    dated = [c for c in cols if c[1]]
    if dated:
        dated.sort(key=lambda c: c[1])
        latest = dated[-1][0]
        return latest, dated
    return cols[-1][0], cols


def _to_int(v):
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "n/a", "na", "..", "."):
        return None
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def load_usage():
    """Load ORR usage keyed by CRS and by normalised name.

    Returns (by_crs, by_name, meta) where each value is a dict:
        { usage, operator, trend: [{year, value}, ...] }
    `meta` carries the detected latest-year label for the legend/provenance.
    """
    if not USAGE_CSV.exists():
        print(f"  no {USAGE_CSV.name} — stations will have no usage figures "
              "(layer still builds). See docs/DATASETS.md.")
        return {}, {}, {}

    with USAGE_CSV.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        rows = list(reader)
    if not rows:
        return {}, {}, {}

    # The CSV sometimes has a title/blurb line before the header. Find the row
    # that looks like a header (contains a name-ish and a usage-ish column).
    header_idx = 0
    for i, r in enumerate(rows[:12]):
        if _pick(r, NAME_CANDIDATES) and _find_entries_exits_cols(r)[0]:
            header_idx = i
            break
    header = rows[header_idx]
    body = rows[header_idx + 1:]

    crs_col = _pick(header, CRS_CANDIDATES)
    name_col = _pick(header, NAME_CANDIDATES)
    op_col = _pick(header, OPERATOR_CANDIDATES)
    latest_col, dated_cols = _find_entries_exits_cols(header)

    if name_col is None or latest_col is None:
        print("  WARNING: couldn't find name / entries-exits columns in "
              f"{USAGE_CSV.name}. Header seen:\n   " + "\n   ".join(header))
        return {}, {}, {}

    idx = {h: i for i, h in enumerate(header)}
    latest_year = None
    ym = YEAR_HINT.search(latest_col)
    if ym:
        latest_year = ym.group(0)

    by_crs, by_name = {}, {}
    n = 0
    for r in body:
        if not r or len(r) <= idx[name_col]:
            continue
        name = r[idx[name_col]].strip()
        if not name:
            continue
        usage = _to_int(r[idx[latest_col]]) if idx[latest_col] < len(r) else None
        operator = (r[idx[op_col]].strip() if op_col and idx[op_col] < len(r)
                    else "")
        trend = []
        for col, yr in dated_cols:
            v = _to_int(r[idx[col]]) if idx.get(col, 1e9) < len(r) else None
            if v is not None and yr:
                trend.append({"year": yr, "value": v})
        rec = {"usage": usage, "operator": operator, "trend": trend}

        crs = r[idx[crs_col]].strip().upper() if crs_col and idx[crs_col] < len(r) else ""
        if crs:
            by_crs[crs] = rec
        nn = norm_name(name)
        if nn:
            by_name[nn] = rec
        n += 1

    print(f"  loaded usage for {n} stations from {USAGE_CSV.name} "
          f"(latest year: {latest_year or 'unknown'}; "
          f"{len(dated_cols)} year column(s) for trend)")
    return by_crs, by_name, {"latest_year": latest_year,
                             "year_count": len(dated_cols)}


def load_station_points():
    """England heavy-rail station points from rail.geojson (mode='rail' stops).

    Returns a list of {name, crs, lng, lat}. If rail.geojson is missing we
    can't place stations, so we return empty (the layer simply won't appear).
    """
    if not RAIL_GEOJSON.exists():
        print(f"  no {RAIL_GEOJSON.name} — run build_rail_layer.py first. "
              "No station layer will be produced.")
        return []
    gj = json.loads(RAIL_GEOJSON.read_text())
    pts = []
    for f in gj.get("features", []):
        p = f.get("properties", {})
        if p.get("kind") != "stop" or p.get("mode") != "rail":
            continue
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lng, lat = g["coordinates"][:2]
        pts.append({"name": p.get("name", ""), "crs": (p.get("crs") or "").upper(),
                    "lng": lng, "lat": lat})
    print(f"  {len(pts)} England heavy-rail station points from {RAIL_GEOJSON.name}")
    return pts


def main() -> int:
    print("Building station-usage layer (England heavy rail)...")
    points = load_station_points()
    if not points:
        print("Nothing to build (no station points). Not writing stations.geojson.")
        return 0

    by_crs, by_name, meta = load_usage()

    feats = []
    matched_crs = matched_name = unmatched = 0
    for s in points:
        rec = None
        if s["crs"] and s["crs"] in by_crs:
            rec = by_crs[s["crs"]]; matched_crs += 1
        else:
            nn = norm_name(s["name"])
            if nn and nn in by_name:
                rec = by_name[nn]; matched_name += 1
            else:
                unmatched += 1

        props = {
            "name": s["name"],
            "crs": s["crs"],
            "usage": rec["usage"] if rec else None,
            "operator": (rec["operator"] if rec else "") or "",
            # Trend kept compact: list of {year, value}. Frontend draws a
            # sparkline / computes a % change from it.
            "trend": rec["trend"] if rec else [],
        }
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(s["lng"], 5), round(s["lat"], 5)]},
            "properties": props,
        })

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "latest_year": meta.get("latest_year"),
            "count": len(feats),
            "matched_crs": matched_crs,
            "matched_name": matched_name,
            "unmatched": unmatched,
            "attribution": "Station usage: Office of Rail and Road (OGL). "
                           "Locations: OpenStreetMap / Trainline (ODbL).",
        },
        "features": feats,
    }
    OUT.write_text(json.dumps(fc))
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT}  ({size_kb:.0f} KB, {len(feats)} stations)")
    print(f"  matched by CRS: {matched_crs} · by name: {matched_name} · "
          f"no usage: {unmatched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
