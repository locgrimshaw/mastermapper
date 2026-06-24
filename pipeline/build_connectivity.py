"""build_connectivity.py — station service-frequency & destination metrics.

Derives, for each rail station (keyed by CRS), a small set of CONNECTIVITY
metrics from a GTFS timetable feed:

  trains_per_day        scheduled weekday departures calling at the station
  peak_trains           of those, departures in the AM peak (07:00-09:59)
  first_dep / last_dep  service span (HH:MM) on the representative weekday
  direct_destinations   distinct stations reachable WITHOUT changing (one-seat)
  key_cities            how many of a curated list of major centres are a
                        direct (one-seat) ride, plus their names

These feed a separate "Connectivity" read in the app (NOT the opportunity
score) and a transparent good/moderate/limited band for filtering.

WHY A SEPARATE SCRIPT: GTFS stop_times.txt is huge (millions of rows). We parse
it in a streaming pass and emit a tiny per-CRS CSV that build_station_usage.py
merges in by CRS — exactly like ORR usage. The heavy lifting stays here and
runs in a GitHub Action; nothing big rides into the app.

INPUTS (committed to data/raw/, or unzipped there by the Action):
  data/raw/gtfs/                a GTFS feed (stops.txt, routes.txt, trips.txt,
                                stop_times.txt, calendar.txt, calendar_dates.txt)
                                — OR a single data/raw/gtfs.zip we unzip.
  data/raw/naptan_rail.csv      NaPTAN RailReferences (or Stops) carrying both
                                the ATCO/stop code AND the CRS (TIPLOC/CRS).
                                Used to map GTFS stop_id -> CRS.

OUTPUT:
  data/raw/station_connectivity.csv   columns:
      crs, trains_per_day, peak_trains, first_dep, last_dep,
      direct_destinations, key_cities_count, key_cities

Run (locally or via Action):
  python pipeline/build_connectivity.py
"""

from __future__ import annotations

import csv
import io
import sys
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
GTFS_DIR = RAW / "gtfs"
GTFS_ZIP = RAW / "gtfs.zip"
NAPTAN_CANDIDATES = [
    RAW / "naptan_rail.csv",
    RAW / "RailReferences.csv",
    RAW / "naptan_stops.csv",
    RAW / "Stops.csv",
]
OUT = RAW / "station_connectivity.csv"

# AM peak window for the "peak_trains" count (inclusive of 07:00, up to 10:00).
PEAK_START_H = 7
PEAK_END_H = 10  # exclusive

# Curated "key destinations" — major GB centres. A direct (one-seat) service to
# any of these is a strong connectivity signal a non-expert grasps instantly.
# Keyed by CRS so the match is exact. (London is the set of its main terminals.)
KEY_CITIES = {
    # London terminals (any one-seat link to central London counts as "London")
    "EUS": "London", "KGX": "London", "STP": "London", "PAD": "London",
    "LIV": "London", "VIC": "London", "WAT": "London", "LBG": "London",
    "MYB": "London", "FST": "London", "CHX": "London", "CST": "London",
    "BFR": "London", "MOG": "London",
    # Core regional cities (principal stations)
    "BHM": "Birmingham", "BHI": "Birmingham",
    "MAN": "Manchester", "MCV": "Manchester", "MCO": "Manchester",
    "LDS": "Leeds",
    "LIV": "Liverpool",            # NB collision handled below (Liverpool St vs Lime St)
    "LIME": "Liverpool",
    "GLC": "Glasgow", "GLQ": "Glasgow",
    "EDB": "Edinburgh",
    "NCL": "Newcastle",
    "SHF": "Sheffield",
    "BRI": "Bristol", "BRI_": "Bristol",
    "NTG": "Nottingham",
    "CDF": "Cardiff",
    "RDG": "Reading",
    "YRK": "York",
    "DBY": "Derby",
    "LCN": "Lincoln",
    "PBO": "Peterborough",
    "CBG": "Cambridge",
    "OXF": "Oxford",
}
# NOTE: "LIV" is London Liverpool Street, NOT Liverpool. Liverpool Lime Street
# is "LIME". Correct the map so the city labels are right.
KEY_CITIES["LIV"] = "London"
KEY_CITIES["LIME"] = "Liverpool"


def _open_text(name: str):
    """Yield a text stream for a GTFS member, from the unzipped dir or the zip."""
    p = GTFS_DIR / name
    if p.exists():
        return p.open(encoding="utf-8-sig", newline="")
    if GTFS_ZIP.exists():
        zf = zipfile.ZipFile(GTFS_ZIP)
        # Names inside the zip may be bare or under a subfolder.
        member = next((m for m in zf.namelist() if m.endswith(name)), None)
        if member:
            return io.TextIOWrapper(zf.open(member), encoding="utf-8-sig", newline="")
    return None


def have_gtfs() -> bool:
    if (GTFS_DIR / "stop_times.txt").exists():
        return True
    if GTFS_ZIP.exists():
        try:
            zf = zipfile.ZipFile(GTFS_ZIP)
            return any(m.endswith("stop_times.txt") for m in zf.namelist())
        except Exception:
            return False
    return False


def load_naptan_crosswalk() -> dict:
    """Map GTFS stop identifiers -> CRS via NaPTAN.

    NaPTAN rail references carry an ATCO code and the CRS (3-alpha). GTFS feeds
    usually key stops by ATCO code (or embed CRS in stop_code). We build a dict
    from every plausible identifier we can see to CRS, so the later stop_id ->
    CRS lookup is forgiving.
    """
    path = next((p for p in NAPTAN_CANDIDATES if p.exists()), None)
    if not path:
        print("  (no NaPTAN file — cannot map GTFS stops to CRS; see DATASETS.md)")
        return {}

    print(f"Reading NaPTAN crosswalk ({path.name})...")
    xwalk = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        cols = {c.lower().strip(): c for c in (reader.fieldnames or [])}

        def pick(*cands):
            for c in cands:
                if c in cols:
                    return cols[c]
            return None

        crs_col = pick("crs", "crscode", "crs code", "tiploc", "three letter code")
        atco_col = pick("atcocode", "atco code", "stoppointref", "atco")
        tiploc_col = pick("tiploc", "tiploccode")
        for row in reader:
            crs = (row.get(crs_col) or "").strip().upper() if crs_col else ""
            if not crs or len(crs) != 3:
                continue
            for col in (atco_col, tiploc_col):
                if col:
                    key = (row.get(col) or "").strip()
                    if key:
                        xwalk[key] = crs
            # Also self-map the CRS so a CRS-keyed GTFS stop resolves directly.
            xwalk[crs] = crs
    print(f"  crosswalk entries: {len(xwalk)}")
    return xwalk


def representative_service_ids() -> set:
    """Pick GTFS service_ids active on a representative midweek day.

    Reads calendar.txt for a Wednesday within the feed's date range, then
    applies calendar_dates.txt exceptions (added/removed). Falls back to "all
    services" if calendars are missing, so the build still produces a figure.
    """
    cal = _open_text("calendar.txt")
    if not cal:
        print("  (no calendar.txt — counting all services; figures approximate)")
        return set()  # empty => caller treats as "no filter"

    # Choose a target Wednesday inside the feed's coverage.
    rows = list(csv.DictReader(cal))
    cal.close()
    if not rows:
        return set()

    def to_date(s):
        s = (s or "").strip()
        return date(int(s[0:4]), int(s[4:6]), int(s[6:8])) if len(s) == 8 else None

    starts = [to_date(r.get("start_date")) for r in rows if to_date(r.get("start_date"))]
    ends = [to_date(r.get("end_date")) for r in rows if to_date(r.get("end_date"))]
    if not starts or not ends:
        return set()
    lo, hi = min(starts), max(ends)
    # First Wednesday on/after lo (weekday() == 2), but within range.
    target = lo
    while target.weekday() != 2 and target <= hi:
        target = date.fromordinal(target.toordinal() + 1)
    if target > hi:
        target = lo
    ymd = int(target.strftime("%Y%m%d"))
    dow = ["monday", "tuesday", "wednesday", "thursday", "friday",
           "saturday", "sunday"][target.weekday()]
    print(f"  representative day: {target.isoformat()} ({dow})")

    active = set()
    for r in rows:
        s, e = to_date(r.get("start_date")), to_date(r.get("end_date"))
        if not s or not e:
            continue
        if s <= target <= e and (r.get(dow) or "0").strip() == "1":
            active.add(r.get("service_id"))

    # Apply calendar_dates.txt exceptions for the target day.
    cd = _open_text("calendar_dates.txt")
    if cd:
        for r in csv.DictReader(cd):
            if (r.get("date") or "").strip() == str(ymd):
                sid, exc = r.get("service_id"), (r.get("exception_type") or "").strip()
                if exc == "1":
                    active.add(sid)
                elif exc == "2":
                    active.discard(sid)
        cd.close()
    print(f"  active services on representative day: {len(active)}")
    return active


def load_trips(active_services: set) -> dict:
    """trip_id -> True for trips that run on the representative day.

    If active_services is empty (no usable calendar), keep ALL trips.
    """
    th = _open_text("trips.txt")
    if not th:
        print("  ERROR: trips.txt missing.")
        return {}
    keep = {}
    for r in csv.DictReader(th):
        sid = r.get("service_id")
        if not active_services or sid in active_services:
            keep[r.get("trip_id")] = True
    th.close()
    print(f"  trips on representative day: {len(keep)}")
    return keep


def hhmm(t: str):
    """GTFS time 'HH:MM:SS' (may exceed 24h) -> (hours, 'HH:MM'). None if bad."""
    parts = (t or "").split(":")
    if len(parts) < 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    return h, f"{h % 24:02d}:{m:02d}"


def main() -> int:
    print("Building station connectivity (GTFS frequency + destinations)...")
    if not have_gtfs():
        print("No GTFS feed found at data/raw/gtfs/ or data/raw/gtfs.zip.")
        print("See docs/DATASETS.md. Not writing connectivity (optional layer).")
        return 0

    xwalk = load_naptan_crosswalk()
    if not xwalk:
        print("Without a CRS crosswalk we can't key metrics to stations. Stop.")
        return 0

    # stop_id -> CRS, from stops.txt (stop_code often carries CRS/ATCO).
    stop_to_crs = {}
    sh = _open_text("stops.txt")
    if sh:
        for r in csv.DictReader(sh):
            sid = r.get("stop_id")
            if not sid:
                continue
            for cand in (r.get("stop_code"), r.get("stop_id"),
                         (r.get("stop_id") or "").split(":")[-1]):
                cand = (cand or "").strip()
                if cand in xwalk:
                    stop_to_crs[sid] = xwalk[cand]
                    break
        sh.close()
    print(f"  GTFS stops mapped to CRS: {len(stop_to_crs)}")

    active = representative_service_ids()
    trips = load_trips(active)

    # Streaming pass over stop_times.txt. For each trip (in file order, which
    # GTFS guarantees is by stop_sequence), record the ordered list of CRS it
    # calls at and the departure time at each. Then per station: count
    # departures, peak, span; and collect onward stops as direct destinations.
    st = _open_text("stop_times.txt")
    if not st:
        print("  ERROR: stop_times.txt missing.")
        return 0

    trains_per_day = defaultdict(int)
    peak_trains = defaultdict(int)
    first_dep = {}
    last_dep = {}
    direct_dests = defaultdict(set)
    key_hit = defaultdict(set)

    reader = csv.DictReader(st)
    cur_trip = None
    seq = []  # list of (crs, dep_h, dep_hhmm) for the current trip

    def flush(seq):
        # For each calling point, the onward stops (later in the sequence) are
        # one-seat destinations. Count a departure at each non-terminal call.
        n = len(seq)
        for i, (crs, dep_h, dep_str) in enumerate(seq):
            if crs is None:
                continue
            onward = [c for (c, _, _) in seq[i + 1:] if c and c != crs]
            if onward:  # a departure (not the terminus)
                trains_per_day[crs] += 1
                if dep_h is not None and PEAK_START_H <= (dep_h % 24) < PEAK_END_H:
                    peak_trains[crs] += 1
                if dep_str:
                    if crs not in first_dep or dep_str < first_dep[crs]:
                        first_dep[crs] = dep_str
                    if crs not in last_dep or dep_str > last_dep[crs]:
                        last_dep[crs] = dep_str
            for oc in onward:
                direct_dests[crs].add(oc)
                if oc in KEY_CITIES:
                    key_hit[crs].add(KEY_CITIES[oc])

    for r in reader:
        tid = r.get("trip_id")
        if tid not in trips:
            # Skip rows for trips not running today. But we must still detect
            # trip boundaries; since we filter, just continue.
            if tid != cur_trip:
                pass
            continue
        if tid != cur_trip:
            if seq:
                flush(seq)
            cur_trip = tid
            seq = []
        crs = stop_to_crs.get(r.get("stop_id"))
        parsed = hhmm(r.get("departure_time") or r.get("arrival_time"))
        if parsed:
            seq.append((crs, parsed[0], parsed[1]))
        else:
            seq.append((crs, None, None))
    if seq:
        flush(seq)
    st.close()

    # Emit CSV for every station we saw at least one departure for.
    crs_all = sorted(trains_per_day.keys())
    print(f"  stations with service: {len(crs_all)}")
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["crs", "trains_per_day", "peak_trains", "first_dep",
                    "last_dep", "direct_destinations", "key_cities_count",
                    "key_cities"])
        for crs in crs_all:
            cities = sorted(key_hit.get(crs, set()))
            w.writerow([
                crs,
                trains_per_day[crs],
                peak_trains.get(crs, 0),
                first_dep.get(crs, ""),
                last_dep.get(crs, ""),
                len(direct_dests.get(crs, set())),
                len(cities),
                "|".join(cities),
            ])
    print(f"Wrote {OUT}  ({len(crs_all)} stations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
