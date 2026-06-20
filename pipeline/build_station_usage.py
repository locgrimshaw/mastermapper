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
# Keep at most this many recent years for the trend sparkline (the time-series
# file can carry ~28). 6 gives a clear post-pandemic recovery shape.
TREND_MAX_YEARS = 6
# Entries+exits column detection. Two ORR layouts exist:
#   - Table 1410 (single year): a column literally named "Entries & Exits …".
#   - Table 1415 (time series): one column PER YEAR, named like
#     "Apr 2024 to Mar 2025" — no "entries/exits" words, because the whole table
#     IS entries-and-exits. So we detect YEAR-SPAN columns directly.
# Footnote markers like "[b]" can be appended; we strip them.
ENTRIES_EXITS_HINT = re.compile(r"entr.*exit|entries.*exits", re.I)
INTERCHANGE_HINT = re.compile(r"interchang", re.I)
# A financial-year span in either form: "2024-25" / "2024/25" or
# "Apr 2024 to Mar 2025". Capturing the END year gives a clean sort key.
YEAR_RANGE_DASH = re.compile(r"(19|20)(\d{2})\s*[-/]\s*(\d{2,4})")
YEAR_RANGE_APR = re.compile(r"apr\w*\s*((?:19|20)\d{2})\s*to\s*mar\w*\s*((?:19|20)\d{2})", re.I)


def _year_label(header_cell):
    """Return a tidy financial-year label (e.g. '2024-25') for a header cell, or
    None if it isn't a year-span column. Handles both ORR formats and strips
    footnote markers."""
    s = re.sub(r"\[[^\]]*\]", "", header_cell)  # drop "[b]" style footnotes
    m = YEAR_RANGE_APR.search(s)
    if m:
        start, end = m.group(1), m.group(2)
        return f"{start}-{end[-2:]}"
    m = YEAR_RANGE_DASH.search(s)
    if m:
        start = m.group(1) + m.group(2)
        end = m.group(3)
        return f"{start}-{end[-2:]}"
    return None


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
    """Match a header column to one of `candidates`, tolerating embedded
    newlines and repeated spaces in the header cell (ORR headers wrap, e.g.
    'Three Letter Code\\n(TLC)'). We compare on whitespace-collapsed lowercase,
    and also try a contains-match so 'Three Letter Code (TLC)' matches a
    candidate of 'TLC' or 'Three Letter Code'."""
    def squash(s):
        return re.sub(r"\s+", " ", s).strip().lower()
    norm = {squash(h): h for h in header}
    # 1) exact (whitespace-normalised) match
    for c in candidates:
        cs = squash(c)
        if cs in norm:
            return norm[cs]
    # 2) candidate appears as a token/substring within a header cell
    for c in candidates:
        cs = squash(c)
        for hk, h in norm.items():
            if cs in hk:
                return h
    return None


def _find_entries_exits_cols(header):
    """Return (latest_col, [(col, year_label), ...]) for entries+exits usage.

    Strategy: find every YEAR-SPAN column (these are the per-year entries-&-exits
    columns in the time series, or the single year column in Table 1410),
    excluding any explicitly marked as interchanges. The right-most year is the
    'latest'. If no year-span column exists, fall back to a column literally
    named with entries/exits words.
    """
    cols = []
    for h in header:
        if INTERCHANGE_HINT.search(h):
            continue
        yr = _year_label(h)
        if yr:
            cols.append((h, yr))
    if cols:
        cols.sort(key=lambda c: c[1])   # sort by tidy year label, ascending
        return cols[-1][0], cols
    # Fallback: a single explicitly-named entries/exits column with no year.
    for h in header:
        if ENTRIES_EXITS_HINT.search(h) and not INTERCHANGE_HINT.search(h):
            return h, [(h, None)]
    return None, []


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

    # ORR/government CSVs are frequently NOT UTF-8 (often Windows-1252 / Latin-1,
    # e.g. an accented station name). Try UTF-8 first, then fall back through the
    # common encodings; latin-1 maps every byte so it never raises, guaranteeing
    # we can always read the file even if a stray byte is unusual.
    rows = None
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with USAGE_CSV.open(newline="", encoding=enc) as fh:
                rows = list(csv.reader(fh))
            if enc != "utf-8-sig":
                print(f"  ({USAGE_CSV.name} read as {enc}, not UTF-8)")
            break
        except UnicodeDecodeError:
            continue
    if rows is None:
        print(f"  WARNING: couldn't decode {USAGE_CSV.name} in any known "
              "encoding. Building without usage.")
        return {}, {}, {}
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
    latest_year = _year_label(latest_col)
    # The time series can carry ~28 years; a sparkline only needs the recent
    # few to read well. Keep the most recent TREND_MAX_YEARS (dated_cols is
    # sorted ascending, so take the tail).
    trend_cols = dated_cols[-TREND_MAX_YEARS:] if dated_cols else []

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
        for col, yr in trend_cols:
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