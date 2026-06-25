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
  data/raw/orr_station_usage_1410.csv   PRIMARY. ORR "Estimates of station
                                   usage", Table 1410 (single year). Carries the
                                   rich fields: interchanges, ticket-type split
                                   (Full/Reduced/Season), Region, quality flags.
                                   (Generic name orr_station_usage.csv also
                                   accepted.)
  data/raw/orr_station_usage_1415.csv   OPTIONAL. Table 1415 (time series). Read
                                   ONLY for the multi-year trend sparkline,
                                   merged onto the primary by CRS/name. Without
                                   it the trend just uses whatever year columns
                                   the primary file carries (one, for 1410).
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
# Primary usage file. Prefer Table 1410 (single year, but carries the rich
# fields: interchanges, ticket split, region, quality flags). We accept the
# generic name OR an explicit 1410 name, whichever is committed.
USAGE_CSV_CANDIDATES = [
    RAW / "orr_station_usage_1410.csv",
    RAW / "orr_station_usage.csv",
    RAW / "orr_1410.csv",
]
# Optional time-series file (Table 1415) read ONLY for the multi-year trend,
# merged onto the primary by CRS/name. If absent, the trend just uses whatever
# year columns the primary file happens to contain (one, for 1410).
TREND_CSV_CANDIDATES = [
    RAW / "orr_station_usage_1415.csv",
    RAW / "orr_1415.csv",
    RAW / "orr_station_usage_timeseries.csv",
]
OUT = ROOT / "web" / "data" / "stations.geojson"

# Optional connectivity metrics (output of build_connectivity.py), merged by
# CRS. Carries trains_per_day, peak_trains, first/last departure, direct
# destinations and key-cities. Absent => stations simply carry null connectivity.
CONNECTIVITY_CSV = RAW / "station_connectivity.csv"


def _first_existing(paths):
    return next((p for p in paths if p.exists()), None)


# Resolved at runtime in load_usage()/load_trend().
USAGE_CSV = _first_existing(USAGE_CSV_CANDIDATES) or USAGE_CSV_CANDIDATES[1]

# Candidate column names in the ORR Table 1410 CSV. ORR tweaks headers between
# releases, so we sniff a set of plausible spellings rather than hard-code one.
CRS_CANDIDATES = ["TLC", "CRS", "crs", "crsCode", "Station CRS", "3-Alpha Code",
                  "Three Letter Code", "NLC code"]
NAME_CANDIDATES = ["Station Name", "Station name", "station", "stationName",
                   "Name", "Station"]
OPERATOR_CANDIDATES = ["Station Facility Owner", "Operator", "TOC",
                       "Train Operating Company", "Owning Operator",
                       "Station operator"]
# Interchanges (passengers changing trains, not entering/exiting). A high
# interchange:entry ratio marks a network node rather than a local destination.
INTERCHANGE_CANDIDATES = ["Interchanges", "Interchange", "Total Interchanges"]
# Entries+exits split by ticket type. ORR categories are Full / Reduced /
# Season (NOT journey-purpose — ORR can't classify business/leisure). The
# SEASON share is the standard commuter proxy. Latest-year columns carry the
# year; we match the type word and prefer the most recent year.
TICKET_FULL_HINT = re.compile(r"\bfull\b", re.I)
TICKET_REDUCED_HINT = re.compile(r"reduced", re.I)
TICKET_SEASON_HINT = re.compile(r"season", re.I)
ENTRIES_HINT = re.compile(r"entr", re.I)
EXITS_HINT = re.compile(r"exit", re.I)
REGION_CANDIDATES = ["Region", "Government Office Region", "ORR Region",
                     "Region (December 2024)"]
# Quality / methodology flags ORR includes per station.
QUALITY_CANDIDATES = ["Quality limitations", "Quality Limitations",
                      "Change and quality comments"]
ADJUSTMENT_CANDIDATES = ["Data source/adjustments", "Data source / adjustments",
                         "Data sources/adjustments"]
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
    """Return (latest_col, [(col, year_label), ...]) for TOTAL entries+exits.

    Strategy: find every YEAR-SPAN column (these are the per-year entries-&-exits
    columns in the time series, or the single year column in Table 1410),
    excluding any marked as interchanges OR as a ticket-type split (Full /
    Reduced / Season), which are sub-totals, not the grand total. The right-most
    year is the 'latest'. If no year-span column exists, fall back to a column
    literally named with entries/exits words.
    """
    def is_ticket_split(h):
        return bool(TICKET_FULL_HINT.search(h) or TICKET_REDUCED_HINT.search(h)
                    or TICKET_SEASON_HINT.search(h))
    cols = []
    for h in header:
        if INTERCHANGE_HINT.search(h) or is_ticket_split(h):
            continue
        yr = _year_label(h)
        if yr:
            cols.append((h, yr))
    if cols:
        cols.sort(key=lambda c: c[1])   # sort by tidy year label, ascending
        return cols[-1][0], cols
    # Fallback: a single explicitly-named entries/exits column with no year.
    for h in header:
        if (ENTRIES_EXITS_HINT.search(h) and not INTERCHANGE_HINT.search(h)
                and not is_ticket_split(h)):
            return h, [(h, None)]
    return None, []


def _find_interchange_col(header):
    """The latest-year interchange column (a column mentioning 'interchange').
    Picks the most recent year if several exist."""
    cands = [h for h in header if INTERCHANGE_HINT.search(h)]
    if not cands:
        return None
    dated = [(h, _year_label(h)) for h in cands]
    dated_only = [d for d in dated if d[1]]
    if dated_only:
        dated_only.sort(key=lambda d: d[1])
        return dated_only[-1][0]
    return cands[-1]


def _find_ticket_cols(header):
    """Return {full, reduced, season} -> latest-year column name for the
    entries+exits ticket-type split. ORR names these like 'Full Entries & Exits
    2024-25' (and similar). We require an entries/exits sense and the type word,
    excluding interchange columns, and pick the most recent year per type."""
    out = {}
    for key, hint in (("full", TICKET_FULL_HINT),
                      ("reduced", TICKET_REDUCED_HINT),
                      ("season", TICKET_SEASON_HINT)):
        cands = []
        for h in header:
            if INTERCHANGE_HINT.search(h):
                continue
            if not hint.search(h):
                continue
            # Must be an entries/exits-type column (not a count of something else)
            if not (ENTRIES_HINT.search(h) or EXITS_HINT.search(h)
                    or ENTRIES_EXITS_HINT.search(h)):
                continue
            cands.append((h, _year_label(h)))
        if not cands:
            continue
        dated = [c for c in cands if c[1]]
        if dated:
            dated.sort(key=lambda c: c[1])
            out[key] = dated[-1][0]
        else:
            out[key] = cands[-1][0]
    return out


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


def _read_orr_csv(path):
    """Read an ORR CSV robustly (encoding fallback) and locate the real header
    row. Returns (header_list, body_rows, header_idx) or (None, None, None)."""
    rows = None
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with path.open(newline="", encoding=enc) as fh:
                rows = list(csv.reader(fh))
            if enc != "utf-8-sig":
                print(f"  ({path.name} read as {enc}, not UTF-8)")
            break
        except UnicodeDecodeError:
            continue
    if rows is None:
        print(f"  WARNING: couldn't decode {path.name} in any known encoding.")
        return None, None, None
    if not rows:
        return None, None, None
    # Find the real header: >= 3 cells, a name column, an entries/exits column.
    header_idx = 0
    for i, r in enumerate(rows[:12]):
        if len(r) < 3:
            continue
        if _pick(r, NAME_CANDIDATES) and _find_entries_exits_cols(r)[0]:
            header_idx = i
            break
    return rows[header_idx], rows[header_idx + 1:], header_idx


def load_trend():
    """Read the OPTIONAL Table 1415 time-series file (if present) and return
    {crs -> [{year, value}, ...]} plus {normname -> trend}. Used to enrich the
    primary file's single-year data with a multi-year sparkline.

    Returns (by_crs, by_name) — empty dicts if no time-series file is committed.
    """
    path = _first_existing(TREND_CSV_CANDIDATES)
    if path is None:
        return {}, {}
    print(f"  reading time-series (trend) from {path.name}...")
    header, body, _ = _read_orr_csv(path)
    if header is None:
        return {}, {}
    crs_col = _pick(header, CRS_CANDIDATES)
    name_col = _pick(header, NAME_CANDIDATES)
    _, dated_cols = _find_entries_exits_cols(header)
    if name_col is None or not dated_cols:
        print(f"    (no usable year columns in {path.name}; skipping trend)")
        return {}, {}
    idx = {h: i for i, h in enumerate(header)}
    trend_cols = dated_cols[-TREND_MAX_YEARS:]
    by_crs, by_name = {}, {}
    for r in body:
        if not r or len(r) <= idx[name_col]:
            continue
        name = r[idx[name_col]].strip()
        if not name:
            continue
        trend = []
        for col, yr in trend_cols:
            v = _to_int(r[idx[col]]) if idx.get(col, 1e9) < len(r) else None
            if v is not None and yr:
                trend.append({"year": yr, "value": v})
        if len(trend) < 2:
            continue
        crs = (r[idx[crs_col]].strip().upper() if crs_col and idx[crs_col] < len(r) else "")
        if crs:
            by_crs[crs] = trend
        nn = norm_name(name)
        if nn:
            by_name[nn] = trend
    print(f"    trend series for {len(by_crs)} stations "
          f"({len(trend_cols)} years)")
    return by_crs, by_name


def load_usage():
    """Load ORR usage keyed by CRS and by normalised name.

    Returns (by_crs, by_name, meta) where each value is a dict:
        { usage, operator, trend, interchanges, season_share, region,
          quality, adjusted }
    `meta` carries the detected latest-year label for the legend/provenance.
    """
    if not USAGE_CSV.exists():
        print(f"  no usage file found (looked for "
              f"{', '.join(p.name for p in USAGE_CSV_CANDIDATES)}) — stations "
              "will have no usage figures. See docs/DATASETS.md.")
        return {}, {}, {}
    print(f"  primary usage file: {USAGE_CSV.name}")

    header, body, _ = _read_orr_csv(USAGE_CSV)
    if header is None:
        print("  WARNING: couldn't read the usage file. Building without usage.")
        return {}, {}, {}

    crs_col = _pick(header, CRS_CANDIDATES)
    name_col = _pick(header, NAME_CANDIDATES)
    op_col = _pick(header, OPERATOR_CANDIDATES)
    latest_col, dated_cols = _find_entries_exits_cols(header)
    interchange_col = _find_interchange_col(header)
    ticket_cols = _find_ticket_cols(header)
    region_col = _pick(header, REGION_CANDIDATES)
    quality_col = _pick(header, QUALITY_CANDIDATES)
    adjust_col = _pick(header, ADJUSTMENT_CANDIDATES)

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

    def cell(r, col):
        """Safe cell read by column name."""
        if not col:
            return None
        i = idx.get(col)
        if i is None or i >= len(r):
            return None
        v = r[i].strip()
        return v if v != "" else None

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

        interchanges = _to_int(cell(r, interchange_col))
        full = _to_int(cell(r, ticket_cols.get("full")))
        reduced = _to_int(cell(r, ticket_cols.get("reduced")))
        season = _to_int(cell(r, ticket_cols.get("season")))
        # Season-ticket share of all entries+exits: the commuter proxy. Only
        # meaningful when we have season and at least one other category.
        season_share = None
        parts = [v for v in (full, reduced, season) if v is not None]
        if season is not None and parts:
            denom = sum(parts)
            if denom > 0:
                season_share = round(season / denom, 3)

        rec = {
            "usage": usage,
            "operator": operator,
            "trend": trend,
            "interchanges": interchanges,
            "season_share": season_share,
            "region": cell(r, region_col),
            # Keep quality/adjustment notes short; they can be long prose.
            "quality": (cell(r, quality_col) or "")[:300] or None,
            "adjusted": bool(cell(r, adjust_col)),
        }

        crs = r[idx[crs_col]].strip().upper() if crs_col and idx[crs_col] < len(r) else ""
        if crs:
            by_crs[crs] = rec
        nn = norm_name(name)
        if nn:
            by_name[nn] = rec
        n += 1

    cols_found = []
    if interchange_col: cols_found.append("interchanges")
    if ticket_cols: cols_found.append(f"ticket-split({'/'.join(ticket_cols)})")
    if region_col: cols_found.append("region")
    if quality_col: cols_found.append("quality")
    print(f"  loaded usage for {n} stations from {USAGE_CSV.name} "
          f"(latest year: {latest_year or 'unknown'}; "
          f"{len(dated_cols)} year column(s) for trend)")
    if cols_found:
        print(f"  extra fields detected: {', '.join(cols_found)}")
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


def load_connectivity():
    """Load per-CRS connectivity metrics if build_connectivity.py has produced
    them. Returns {crs -> dict} or {} when the file is absent (optional layer).
    """
    if not CONNECTIVITY_CSV.exists():
        print("  (no station_connectivity.csv — building without connectivity)")
        return {}
    print(f"Reading connectivity ({CONNECTIVITY_CSV.name})...")
    out = {}
    with CONNECTIVITY_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            crs = (r.get("crs") or "").strip().upper()
            if not crs:
                continue

            def _int(v):
                try:
                    return int(float(v))
                except (TypeError, ValueError):
                    return None

            def _flt(v):
                try:
                    return round(float(v), 1)
                except (TypeError, ValueError):
                    return None

            cities = (r.get("key_cities") or "").strip()
            out[crs] = {
                "trains_per_day": _int(r.get("trains_per_day")),
                "peak_trains": _int(r.get("peak_trains")),
                "peak_hour_count": _int(r.get("peak_hour_count")),
                "peak_hour_start": (r.get("peak_hour_start") or "").strip() or None,
                "first_dep": (r.get("first_dep") or "").strip() or None,
                "last_dep": (r.get("last_dep") or "").strip() or None,
                "direct_destinations": _int(r.get("direct_destinations")),
                "key_cities_count": _int(r.get("key_cities_count")),
                "key_cities": cities.split("|") if cities else [],
                "sustained_tph": _flt(r.get("sustained_tph")),
                "sustained_tph_per_dir": _flt(r.get("sustained_tph_per_dir")),
                "meets_4tph": _int(r.get("meets_4tph")),
                "meets_2tph_per_dir": _int(r.get("meets_2tph_per_dir")),
                "meets_frequency": _int(r.get("meets_frequency")),
            }
    print(f"  connectivity for {len(out)} stations")
    return out


def main() -> int:
    print("Building station-usage layer (England heavy rail)...")
    points = load_station_points()
    if not points:
        print("Nothing to build (no station points). Not writing stations.geojson.")
        return 0

    by_crs, by_name, meta = load_usage()
    # Optional richer trend from a Table 1415 time-series file, merged by CRS.
    trend_by_crs, trend_by_name = load_trend()
    # Optional connectivity metrics (GTFS-derived), merged by CRS.
    conn_by_crs = load_connectivity()

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

        # Prefer the multi-year time-series trend where available; otherwise
        # fall back to whatever year columns the primary file carried.
        ts_trend = None
        if s["crs"] and s["crs"] in trend_by_crs:
            ts_trend = trend_by_crs[s["crs"]]
        else:
            nn = norm_name(s["name"])
            if nn and nn in trend_by_name:
                ts_trend = trend_by_name[nn]
        trend = ts_trend if ts_trend else (rec["trend"] if rec else [])

        props = {
            "name": s["name"],
            "crs": s["crs"],
            "usage": rec["usage"] if rec else None,
            "operator": (rec["operator"] if rec else "") or "",
            # Trend kept compact: list of {year, value}. Frontend draws a
            # sparkline / computes a % change from it.
            "trend": trend,
            "interchanges": rec.get("interchanges") if rec else None,
            "season_share": rec.get("season_share") if rec else None,
            "region": rec.get("region") if rec else None,
            "quality": rec.get("quality") if rec else None,
            "adjusted": rec.get("adjusted") if rec else False,
        }
        # Connectivity (optional). Null-safe: stations without a match carry
        # nulls and the app hides the Connectivity block gracefully.
        conn = conn_by_crs.get(s["crs"]) if s["crs"] else None
        if conn:
            props["trains_per_day"] = conn["trains_per_day"]
            props["peak_trains"] = conn["peak_trains"]
            props["peak_hour_count"] = conn["peak_hour_count"]
            props["peak_hour_start"] = conn["peak_hour_start"]
            props["first_dep"] = conn["first_dep"]
            props["last_dep"] = conn["last_dep"]
            props["direct_destinations"] = conn["direct_destinations"]
            props["key_cities_count"] = conn["key_cities_count"]
            props["key_cities"] = conn["key_cities"]
            props["sustained_tph"] = conn["sustained_tph"]
            props["sustained_tph_per_dir"] = conn["sustained_tph_per_dir"]
            props["meets_4tph"] = conn["meets_4tph"]
            props["meets_2tph_per_dir"] = conn["meets_2tph_per_dir"]
            props["meets_frequency"] = conn["meets_frequency"]
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(s["lng"], 5), round(s["lat"], 5)]},
            "properties": props,
        })

    # National usage percentile rank (0-100): "busier than X% of England
    # stations". Computed across stations that HAVE a usage figure; the rest
    # get null. Done here (build time) since it needs the whole set.
    with_usage = sorted((f for f in feats if f["properties"]["usage"] is not None),
                        key=lambda f: f["properties"]["usage"])
    total = len(with_usage)
    for i, f in enumerate(with_usage):
        # Fraction of stations with usage strictly below this one.
        f["properties"]["usage_pctile"] = round(i / total * 100, 1) if total > 1 else 50.0
    for f in feats:
        f["properties"].setdefault("usage_pctile", None)

    # National connectivity percentile from trains-per-day (0-100), so the app
    # can band good/moderate/limited relative to the network rather than with
    # arbitrary absolute cutoffs. Stations without service get null.
    with_tpd = sorted((f for f in feats
                       if f["properties"].get("trains_per_day") is not None),
                      key=lambda f: f["properties"]["trains_per_day"])
    ntpd = len(with_tpd)
    for i, f in enumerate(with_tpd):
        f["properties"]["connectivity_pctile"] = round(i / ntpd * 100, 1) if ntpd > 1 else 50.0
    for f in feats:
        f["properties"].setdefault("connectivity_pctile", None)

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "latest_year": meta.get("latest_year"),
            "count": len(feats),
            "matched_crs": matched_crs,
            "matched_name": matched_name,
            "unmatched": unmatched,
            "attribution": "Station usage: Office of Rail and Road (OGL). "
                           "Locations: OpenStreetMap / Trainline (ODbL). "
                           "Connectivity: GTFS timetable (RDG/DfT, OGL); "
                           "NaPTAN (OGL).",
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
