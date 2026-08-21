"""Populate stations.sustained_tph / sustained_tph_per_dir from stations.geojson.

WHY THIS EXISTS SEPARATELY. Migration 0063 adds the two columns; the values
live in web/data/stations.geojson, which the timetable pipeline
(build_connectivity_cif.py -> build_station_usage.py) has always written but
which the stations table never carried. There is no stations loader workflow —
the table is loaded by hand — so this script is the reproducible way to fill
them, rather than a one-off statement pasted into a console and lost.

The frontend does NOT depend on this: it reads the same geojson directly, so
the NPPF double-frequency tier works whether or not the columns are populated.
This is for anything server-side that wants the figures — a future station
assessment, an RPC, a report generated outside the browser.

Usage:
    DATABASE_URL=postgres://...  python pipeline/load_station_tph.py
    python pipeline/load_station_tph.py --print   # emit SQL, apply it yourself

Policy S5(2)(c): 35 dwellings per hectare minimum near a well-connected
station, 45 "where the service frequency is at least twice that of the minimum
required" — 8 trains an hour overall, or 4 in one direction.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIONS = ROOT / "web" / "data" / "stations.geojson"


def rows():
    data = json.loads(STATIONS.read_text(encoding="utf-8"))
    out = []
    for f in data.get("features", []):
        p = f.get("properties") or {}
        crs = (p.get("crs") or "").strip()
        tph = p.get("sustained_tph")
        if not crs or tph is None:
            continue
        per_dir = p.get("sustained_tph_per_dir") or 0
        out.append((crs, float(tph), float(per_dir)))
    return out


def statement(rs):
    # A single packed string unnested server-side: 2,369 three-column VALUES
    # tuples is 19 KB of SQL, this is 12 KB and one round trip.
    blob = ",".join(f"{c}:{a:g}:{b:g}" for c, a, b in rs)
    if "'" in blob:                      # CRS codes are A-Z only; belt and braces
        raise SystemExit("unexpected quote in station data")
    return (
        "update public.stations s "
        "set sustained_tph = split_part(v.t, ':', 2)::numeric, "
        "    sustained_tph_per_dir = split_part(v.t, ':', 3)::numeric "
        f"from unnest(string_to_array('{blob}', ',')) as v(t) "
        "where s.crs = split_part(v.t, ':', 1);"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true",
                    help="write the SQL to stdout instead of executing it")
    args = ap.parse_args()
    if not STATIONS.exists():
        raise SystemExit(f"missing {STATIONS}")
    rs = rows()
    if not rs:
        raise SystemExit("no stations carry sustained_tph — run the timetable "
                         "pipeline first (build_connectivity_cif.py)")
    dbl = sum(1 for _, a, b in rs if a >= 8 or b >= 4)
    print(f"{len(rs):,} stations with a sustained frequency; {dbl:,} at or "
          f"above double the well-connected minimum (S5(2)(c) 45 dph tier)",
          file=sys.stderr)
    sql = statement(rs)
    if args.print:
        print(sql)
        return 0
    dsn = os.environ.get("DATABASE_URL", "").strip()
    if not dsn:
        raise SystemExit("set DATABASE_URL, or use --print and apply the SQL "
                         "yourself")
    import psycopg2                                     # noqa: PLC0415
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql)
        print(f"updated {cur.rowcount:,} rows", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
