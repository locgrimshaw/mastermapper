#!/usr/bin/env python3
"""Build per-station connectivity metrics from the National Rail DTD/CIF timetable.

The National Rail Open Data "timetable" feed (https://opendata.nationalrail.co.uk
/api/staticfeeds/3.0/timetable) is a zip of fixed-width ATOC CIF files, NOT GTFS.
This reader parses CIF directly:

  *.MSN  Master Station Names — gives TIPLOC -> CRS (our crosswalk, built in;
         no NaPTAN needed).
  *.MCA  The timetable schedule. Record types we use:
           BS  Basic Schedule  — train UID, date range, days-run bitmap, STP flag
           BX  Basic Schedule Extra — (skipped; operator not needed here)
           LO  Origin location     — TIPLOC + public departure time
           LI  Intermediate loc.   — TIPLOC + public arr/dep times
           LT  Terminus location   — TIPLOC + public arrival time

For each schedule that runs on a representative weekday and is valid on a chosen
sample date, we walk its call points and, per station (CRS):
  - count a "departure" wherever it has a public departure time (trains_per_day)
  - flag peak departures 07:00-09:59 (peak_trains)
  - track earliest / latest public time for service span (first_dep / last_dep)
  - collect all LATER call points as one-seat direct destinations
  - record which curated "key cities" are reachable directly

OUTPUT: data/raw/station_connectivity.csv with columns:
  crs, trains_per_day, peak_trains, first_dep, last_dep,
  direct_destinations, key_cities_count, key_cities  (key_cities pipe-joined)

Honest caveats: this is SCHEDULED service (not realised), and uses a single
representative weekday (Tuesday) as the sample day — a standard simplification.

USAGE:  python pipeline/build_connectivity_cif.py
Reads the newest *.MSN / *.MCA found under data/raw/ (extracting the timetable
zip there first if needed).
"""

from __future__ import annotations

import csv
import datetime as dt
import sys
import zipfile
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
TIMETABLE_ZIP = RAW / "rail_timetable.zip"
OUT_CSV = RAW / "station_connectivity.csv"
# Station-to-station direct links (the PBSA rail sift's input): one row per
# ordered (from, to) pair with a direct scheduled service on the sample day.
OUT_LINKS = RAW / "station_links.csv"

# Representative weekday: 0=Mon .. 6=Sun. Tuesday avoids Monday/Friday quirks.
SAMPLE_WEEKDAY = 1            # Tuesday
PEAK_START, PEAK_END = 700, 959   # inclusive HHMM window for the AM peak

# Curated "key cities" by CRS. Reaching one of these directly is the headline
# connectivity story ("direct trains to London / Birmingham / ...").
KEY_CITIES = {
    # London terminals -> all labelled "London"
    "EUS": "London", "KGX": "London", "STP": "London", "PAD": "London",
    "WAT": "London", "VIC": "London", "LST": "London", "MYB": "London",
    "CHX": "London", "LBG": "London", "BFR": "London", "MOG": "London",
    "CST": "London", "FST": "London",
    "BHM": "Birmingham", "BHI": "Birmingham", "BMO": "Birmingham",
    "MAN": "Manchester", "MCV": "Manchester", "MCO": "Manchester",
    "LDS": "Leeds",
    "LIV": "Liverpool", "LVJ": "Liverpool",
    "GLC": "Glasgow", "GLQ": "Glasgow",
    "EDB": "Edinburgh",
    "BRI": "Bristol", "BPW": "Bristol",
    "SHF": "Sheffield",
    "NCL": "Newcastle",
    "NOT": "Nottingham",
    "CDF": "Cardiff",
    "RDG": "Reading",
    "YRK": "York",
    "PBO": "Peterborough",
    "DBY": "Derby", "LEI": "Leicester", "COV": "Coventry",
    "PMS": "Portsmouth", "SOU": "Southampton", "BTN": "Brighton",
    "PLY": "Plymouth", "EXD": "Exeter", "NRW": "Norwich", "CBG": "Cambridge",
    "ABD": "Aberdeen", "INV": "Inverness", "SWA": "Swansea",
    "PRE": "Preston", "CAR": "Carlisle", "DOY": "Doncaster",
}


def find_file(suffix: str) -> Path | None:
    cands = sorted(RAW.glob(f"*{suffix}"))
    return cands[-1] if cands else None


def ensure_extracted() -> tuple[Path, Path] | None:
    """Return (msn_path, mca_path), extracting the zip into data/raw/ if needed."""
    msn, mca = find_file(".MSN"), find_file(".MCA")
    if msn and mca:
        return msn, mca
    if TIMETABLE_ZIP.exists():
        print(f"Extracting {TIMETABLE_ZIP.name} ...")
        with zipfile.ZipFile(TIMETABLE_ZIP) as zf:
            zf.extractall(RAW)
        msn, mca = find_file(".MSN"), find_file(".MCA")
        if msn and mca:
            return msn, mca
    return None


# ---- MSN: TIPLOC -> CRS crosswalk ------------------------------------------

def load_crosswalk(msn_path: Path) -> tuple[dict, dict, dict]:
    """Parse the Master Station Names file. 'A' records carry station name,
    TIPLOC (cols 37-43, 1-based), CRS (cols 44-46), and OS grid easting
    (cols 47-51) / northing (cols 53-57) in units of 100m. Returns
    (tiploc->crs, crs->name, tiploc->(easting,northing))."""
    tiploc_to_crs, crs_to_name, tiploc_to_xy = {}, {}, {}
    with msn_path.open(encoding="latin-1") as fh:
        for line in fh:
            if not line.startswith("A"):
                continue
            # Skip the header 'A ... FILE-SPEC=' record.
            if "FILE-SPEC" in line:
                continue
            name = line[5:30].strip()
            tiploc = line[36:43].strip()
            crs = line[43:46].strip().upper()
            if not crs or len(crs) != 3 or not tiploc:
                continue
            tiploc_to_crs[tiploc] = crs
            crs_to_name.setdefault(crs, name.title())
            # Grid refs: easting cols 53-57, northing cols 59-63 (1-based),
            # in units of 100m. (Verified against the Luton MSN record.)
            try:
                east = int(line[52:57].strip())
                north = int(line[58:63].strip())
                if east and north:
                    tiploc_to_xy[tiploc] = (east, north)
            except (ValueError, IndexError):
                pass
    return tiploc_to_crs, crs_to_name, tiploc_to_xy



# ---- MCA helpers ------------------------------------------------------------

def parse_yymmdd(s: str) -> dt.date | None:
    s = s.strip()
    if len(s) != 6 or not s.isdigit():
        return None
    yy, mm, dd = int(s[0:2]), int(s[2:4]), int(s[4:6])
    year = 2000 + yy if yy < 60 else 1900 + yy
    try:
        return dt.date(year, mm, dd)
    except ValueError:
        return None


def hhmm_to_int(s: str) -> int | None:
    """'2255' -> 2255. Trailing 'H' (half minute) and blanks handled. 0000/blank
    -> None (no public time)."""
    s = s.strip().rstrip("H")
    if not s or not s.isdigit() or len(s) < 4:
        return None
    v = int(s[:4])
    return v if v != 0 else None


def hhmm_to_minutes(v: int) -> int:
    """2347 -> 1427 (minutes since midnight)."""
    return (v // 100) * 60 + (v % 100)


# --- NPPF frequency test helpers --------------------------------------------
# Draft NPPF "well-connected": served throughout the daytime by >=4 trains/hr
# overall, OR >=2 trains/hr in any one direction. We test sustained frequency
# across a core daytime window, not just the peak.
DAYTIME_START_H, DAYTIME_END_H = 7, 18   # 07:00..18:59 inclusive (12 clock hours)


def sustained_tph(dep_hhmm: list[int]) -> tuple[float, int]:
    """Given departure times (HHMM ints), return (sustained_tph, busiest_clock_hr).
    sustained_tph = the MINIMUM departures-per-clock-hour across the daytime
    window — i.e. the level maintained 'throughout the daytime'. A station that
    does 8/hr at peak but 1/hr midday has sustained_tph = 1."""
    if not dep_hhmm:
        return 0.0, 0
    buckets = {h: 0 for h in range(DAYTIME_START_H, DAYTIME_END_H + 1)}
    for v in dep_hhmm:
        h = v // 100
        if DAYTIME_START_H <= h <= DAYTIME_END_H:
            buckets[h] += 1
    counts = list(buckets.values())
    if not counts:
        return 0.0, 0
    sustained = min(counts)
    busiest = max(buckets, key=buckets.get)
    return float(sustained), busiest


def bearing_group(station_xy, term_xy) -> str | None:
    """Classify a departure's direction as one of two opposing groups by the
    bearing from the station to the train's terminus. Returns 'A' or 'B' (the
    two dominant directions along the line's axis), or None if unknown.
    We split the compass into two halves; the axis is chosen per-station later,
    so here we just return the raw bearing in degrees as a float."""
    if not station_xy or not term_xy:
        return None
    dx = term_xy[0] - station_xy[0]
    dy = term_xy[1] - station_xy[1]
    if dx == 0 and dy == 0:
        return None
    import math
    # bearing 0=N, 90=E, 180=S, 270=W
    ang = (math.degrees(math.atan2(dx, dy))) % 360
    return ang  # caller bins into two opposing groups


def directional_sustained(dep_with_bearing: list[tuple[int, float]]) -> tuple[float, float]:
    """Given [(dep_hhmm, bearing_deg), ...], split into two opposing directional
    groups along the line's dominant axis and return (best, worst) direction's
    sustained tph.

    WHICH ONE THE NPPF ASKS FOR. Annex B: served "by at least four trains or
    trams per hour overall, OR at least two trains or trams per hour in ANY ONE
    direction". Any one direction is the BEST direction, not the worst.

    This function used to return only the worst, which made the second limb
    mathematically redundant: two per hour in BOTH directions is four per hour
    overall, so anything passing the worst-direction test had already passed
    the four-per-hour test. Measured against the live data that is exactly what
    happened — 1,035 stations qualified either way, the second limb doing no
    work at all. A drafter does not write a redundant limb, which is the
    strongest evidence that the worst-direction reading is the wrong one.

    Read as the best direction, the limb does real work: it admits a station
    with a decent service one way and little the other, which is precisely the
    branch-line case the wording seems meant to catch.

    Both figures are returned and stored. The best drives the policy test; the
    worst still describes service QUALITY (a station with 6/hr one way and
    nothing back is not the same proposition as 3/hr each way), so it stays.

    Method: find the dominant axis by the circular mean of bearings, split
    departures into the two half-planes around the perpendicular, then take
    each group's sustained_tph."""
    pts = [(t, b) for (t, b) in dep_with_bearing if b is not None]
    if len(pts) < 2:
        return 0.0, 0.0
    import math
    # Dominant axis via doubled-angle mean (axis, not direction).
    sx = sum(math.cos(math.radians(2 * b)) for _, b in pts)
    sy = sum(math.sin(math.radians(2 * b)) for _, b in pts)
    axis = (math.degrees(math.atan2(sy, sx)) / 2) % 180  # 0..180 axis
    # Split: a departure is group A if its bearing is within 90deg of `axis`,
    # else group B (the opposite half).
    def side(b):
        d = (b - axis) % 360
        return "A" if d < 90 or d >= 270 else "B"
    grp = {"A": [], "B": []}
    for t, b in pts:
        grp[side(b)].append(t)
    a, _ = sustained_tph(grp["A"])
    b_, _ = sustained_tph(grp["B"])
    # A one-directional service is still a service in "any one direction" — a
    # terminus running 3/hr the only way the track goes meets the limb as
    # written. It previously scored zero, which read the policy as requiring a
    # two-way service the words do not ask for.
    if not grp["A"] or not grp["B"]:
        return max(a, b_), 0.0
    return max(a, b_), min(a, b_)


def busiest_hour(dep_times: list[int]) -> tuple[int, int]:
    """Given departure times as HHMM ints, return (max_count_in_any_60min_window,
    window_start_HHMM). Uses a sliding window: for each departure, count how many
    departures fall in [t, t+59min]. The window starting at the departure that
    yields the most is the busiest hour."""
    if not dep_times:
        return 0, 0
    mins = sorted(hhmm_to_minutes(v) for v in dep_times)
    best_count, best_start = 0, mins[0]
    j = 0
    for i in range(len(mins)):
        # advance j to the last index within 60 minutes of mins[i]
        while j < len(mins) and mins[j] <= mins[i] + 59:
            j += 1
        count = j - i
        if count > best_count:
            best_count, best_start = count, mins[i]
    start_hhmm = (best_start // 60) * 100 + (best_start % 60)
    return best_count, start_hhmm


def runs_on_sample_day(days_bitmap: str, runs_from: dt.date | None,
                       runs_to: dt.date | None, sample: dt.date) -> bool:
    """days_bitmap is 7 chars Mon..Sun. Keep if it runs on SAMPLE_WEEKDAY and
    the sample date falls inside [runs_from, runs_to]."""
    if len(days_bitmap) < 7 or days_bitmap[SAMPLE_WEEKDAY] != "1":
        return False
    if runs_from and sample < runs_from:
        return False
    if runs_to and sample > runs_to:
        return False
    return True


def pick_sample_date(today: dt.date) -> dt.date:
    """Next SAMPLE_WEEKDAY on/after today — a date the current timetable covers."""
    delta = (SAMPLE_WEEKDAY - today.weekday()) % 7
    return today + dt.timedelta(days=delta)


# ---- Main parse -------------------------------------------------------------

def build(msn_path: Path, mca_path: Path) -> dict:
    tiploc_to_crs, _crs_to_name, tiploc_to_xy = load_crosswalk(msn_path)
    print(f"  crosswalk: {len(tiploc_to_crs)} TIPLOCs -> CRS "
          f"({len(tiploc_to_xy)} with coords)")

    sample_date = pick_sample_date(dt.date.today())
    print(f"  sample weekday date: {sample_date} (weekday {SAMPLE_WEEKDAY})")

    # Per-CRS accumulators.
    stats = {}  # crs -> dict(dep_count, peak, first, last, dests:set, cities:set)
    # (crs_from, crs_to) -> {"n": direct trains, "mins": sample journey times}.
    pairs = {}

    def acc(crs):
        return stats.setdefault(crs, {
            "dep": 0, "peak": 0, "first": None, "last": None,
            "dests": set(), "cities": set(), "dep_times": [],
            # (dep_hhmm, bearing_to_terminus) for the per-direction test:
            "dep_dir": [],
        })

    # Current schedule being read.
    keep = False
    calls = []   # list of (crs, tiploc, public_time_int, is_departure)

    def flush_schedule():
        """Apply the finished schedule's call points to the per-CRS stats."""
        if not keep or len(calls) < 2:
            return
        crs_seq = [c for (c, _tip, _t, _d) in calls]
        # The train's terminus TIPLOC = the last call point (for direction).
        term_tip = calls[-1][1]
        term_xy = tiploc_to_xy.get(term_tip)
        for idx, (crs, tip, t, is_dep) in enumerate(calls):
            s = acc(crs)
            # Service span: any public time at the station counts.
            if t is not None:
                if s["first"] is None or t < s["first"]:
                    s["first"] = t
                if s["last"] is None or t > s["last"]:
                    s["last"] = t
            # A "departure" = a call with a public departure time (origin or
            # intermediate). Terminus (arrival only) is not a departure.
            if is_dep and t is not None:
                s["dep"] += 1
                s["dep_times"].append(t)
                if PEAK_START <= t <= PEAK_END:
                    s["peak"] += 1
                # Directional capture: bearing from this station to the terminus.
                st_xy = tiploc_to_xy.get(tip)
                brg = bearing_group(st_xy, term_xy)
                s["dep_dir"].append((t, brg))
            # Onward one-seat destinations: every later call point. Also
            # record the (from, to) pair with the scheduled journey minutes so
            # station_links.csv can carry real times + frequencies.
            for j in range(idx + 1, len(calls)):
                onward, _tip2, t2, _d2 = calls[j]
                if onward == crs:
                    continue
                s["dests"].add(onward)
                if onward in KEY_CITIES:
                    s["cities"].add(KEY_CITIES[onward])
                if is_dep and t is not None and t2 is not None:
                    m1 = (t // 100) * 60 + (t % 100)
                    m2 = (t2 // 100) * 60 + (t2 % 100)
                    mins = m2 - m1
                    if mins < 0:
                        mins += 1440          # over-midnight leg
                    if 0 < mins <= 600:       # sanity: drop >10 h artefacts
                        pr = pairs.setdefault((crs, onward), {"n": 0, "mins": []})
                        pr["n"] += 1
                        if len(pr["mins"]) < 40:
                            pr["mins"].append(mins)

    n_lines = n_sched = n_kept = 0
    with mca_path.open(encoding="latin-1") as fh:
        for line in fh:
            n_lines += 1
            rt = line[0:2]
            if rt == "BS":
                # Finish the previous schedule before starting a new one.
                flush_schedule()
                calls = []
                n_sched += 1
                stp = line[79:80]            # P=perm, O/N=overlay, C=cancel
                if stp == "C":
                    keep = False
                    continue
                runs_from = parse_yymmdd(line[9:15])
                runs_to = parse_yymmdd(line[15:21])
                days = line[21:28]
                keep = runs_on_sample_day(days, runs_from, runs_to, sample_date)
                if keep:
                    n_kept += 1
            elif not keep:
                continue
            elif rt == "LO":
                tip = line[2:9].strip()
                crs = tiploc_to_crs.get(tip)
                dep = hhmm_to_int(line[15:19])      # public departure
                if crs:
                    calls.append((crs, tip, dep, True))
            elif rt == "LI":
                tip = line[2:9].strip()
                crs = tiploc_to_crs.get(tip)
                if not crs:
                    continue
                parr = hhmm_to_int(line[25:29])     # public arrival (cols 26-29)
                pdep = hhmm_to_int(line[29:33])     # public departure (cols 30-33)
                # Only a public passenger stop counts (has a public arr or dep).
                if parr is None and pdep is None:
                    continue
                t = pdep if pdep is not None else parr
                calls.append((crs, tip, t, pdep is not None))
            elif rt == "LT":
                tip = line[2:9].strip()
                crs = tiploc_to_crs.get(tip)
                parr = hhmm_to_int(line[15:19])     # public arrival
                if crs:
                    calls.append((crs, tip, parr, False))
        flush_schedule()  # last schedule in file

    print(f"  read {n_lines:,} MCA lines · {n_sched:,} schedules · "
          f"{n_kept:,} run on sample weekday")

    # Build output rows.
    def fmt_hhmm(v):
        if v is None:
            return ""
        return f"{v // 100:02d}:{v % 100:02d}"

    out = {}
    for crs, s in stats.items():
        if s["dep"] == 0:
            continue
        cities = sorted(s["cities"])
        peak_hr_count, peak_hr_start = busiest_hour(s["dep_times"])
        # NPPF "well-connected" frequency test (the rail-service limb).
        sustained_overall, _busiest_h = sustained_tph(s["dep_times"])
        # best = the busiest single direction (what Annex B's "any one
        # direction" asks for); worst = the quieter one, kept because it
        # describes service quality even though the policy does not test it.
        sustained_best_dir, sustained_worst_dir = directional_sustained(s["dep_dir"])
        meets_4tph = sustained_overall >= 4
        meets_2tph_dir = sustained_best_dir >= 2
        meets_frequency = meets_4tph or meets_2tph_dir
        out[crs] = {
            "crs": crs,
            "trains_per_day": s["dep"],
            "peak_trains": s["peak"],
            "peak_hour_count": peak_hr_count,
            "peak_hour_start": fmt_hhmm(peak_hr_start) if peak_hr_count else "",
            "first_dep": fmt_hhmm(s["first"]),
            "last_dep": fmt_hhmm(s["last"]),
            "direct_destinations": len(s["dests"]),
            "key_cities_count": len(cities),
            "key_cities": "|".join(cities),
            # NPPF frequency limb (the TTWA-GVA limb is added by a later step):
            "sustained_tph": round(sustained_overall, 1),
            # The policy figure. Renaming would break every downstream reader,
            # so the established key now carries the BEST direction (the test
            # as written) and the quieter direction gets its own column.
            "sustained_tph_per_dir": round(sustained_best_dir, 1),
            "sustained_tph_worst_dir": round(sustained_worst_dir, 1),
            "meets_4tph": int(meets_4tph),
            "meets_2tph_per_dir": int(meets_2tph_dir),
            "meets_frequency": int(meets_frequency),
        }
    return out, pairs


def main() -> int:
    print("Building station connectivity from National Rail DTD/CIF timetable...")
    found = ensure_extracted()
    if not found:
        print(f"  No timetable found. Expected {TIMETABLE_ZIP.name} (or extracted "
              f"*.MSN/*.MCA) under data/raw/. See docs/DATASETS.md.")
        print("  Not writing connectivity (optional layer).")
        return 0
    msn_path, mca_path = found
    print(f"  MSN: {msn_path.name} · MCA: {mca_path.name}")

    out, pairs = build(msn_path, mca_path)
    if not out:
        print("  No connectivity rows produced — check the parse. Not writing.")
        return 1

    fields = ["crs", "trains_per_day", "peak_trains", "peak_hour_count",
              "peak_hour_start", "first_dep", "last_dep",
              "direct_destinations", "key_cities_count", "key_cities",
              "sustained_tph", "sustained_tph_per_dir", "sustained_tph_worst_dir",
              "meets_4tph", "meets_2tph_per_dir", "meets_frequency"]
    with OUT_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for crs in sorted(out):
            w.writerow(out[crs])

    write_links(pairs)

    # Quick sanity summary.
    busiest = sorted(out.values(), key=lambda r: r["trains_per_day"], reverse=True)[:5]
    n_freq = sum(1 for r in out.values() if r["meets_frequency"])
    n_4tph = sum(1 for r in out.values() if r["meets_4tph"])
    n_2dir = sum(1 for r in out.values() if r["meets_2tph_per_dir"])
    print(f"  wrote {OUT_CSV.name}: {len(out)} stations")
    print(f"  NPPF frequency limb: {n_freq} stations meet it "
          f"({n_4tph} via 4/hr overall, {n_2dir} via 2/hr per direction)")
    print("  busiest by trains/day:")
    for r in busiest:
        print(f"    {r['crs']}: {r['trains_per_day']} trains, "
              f"sustained {r['sustained_tph']}/hr overall, "
              f"{r['sustained_tph_per_dir']}/hr per dir, "
              f"freq-pass={'Y' if r['meets_frequency'] else 'N'}")
    return 0


def write_links(pairs):
    import statistics
    with OUT_LINKS.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["crs_from", "crs_to", "minutes", "trains_day"])
        for (a, b), pr in sorted(pairs.items()):
            med = round(statistics.median(pr["mins"]), 1) if pr["mins"] else ""
            w.writerow([a, b, med, pr["n"]])
    print(f"  wrote {OUT_LINKS.name}: {len(pairs):,} direct station pairs")


if __name__ == "__main__":
    sys.exit(main())