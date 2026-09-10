"""
build_pipr.py
-------------
Turns the monthly ONS Price Index of Private Rents workbook into the three
things the app needs from it:

  supabase/pipr_rents_import.csv    latest month, £/month levels per area for
                                    all nine series — the evidence base the
                                    BTR viability mode capitalises.
  supabase/pipr_series_import.csv   the FULL monthly history, one row per
                                    (area, series) holding the rent and
                                    annual-change arrays. ~3,100 rows rather
                                    than the ~437,000 a long table would need,
                                    so one select returns a whole area's
                                    trend picture in a single round trip.
  supabase/pipr_la_props.json       per-LAD props for the la_rents map layer,
                                    consumed by build_datasets.py.

WHY THIS EXISTS. Migration 0075 claimed a `pipeline/build_pipr_rents.py` that
was never written — the table was populated by hand-pasted SQL, and it
described PIPR as refreshed "at a stable ONS URL", which is not true (see
pipr.latest_release_url). Everything is now derived from the published
workbook by this script, so a refresh is a workflow run rather than a paste.

Read pipeline/pipr.py first: it documents what PIPR measures, why Scotland and
Northern Ireland cannot be mapped from it, and the caveats that must travel
with the numbers.

Usage:
  python3 pipeline/build_pipr.py                 # download the latest release
  PIPR_SRC=/path/to/pipr.xlsx python3 pipeline/build_pipr.py

Licence: Crown copyright, Open Government Licence v3.0.
"""

import csv
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipr  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_RENTS = ROOT / "supabase" / "pipr_rents_import.csv"
OUT_SERIES = ROOT / "supabase" / "pipr_series_import.csv"
OUT_PROPS = ROOT / "supabase" / "pipr_la_props.json"

def main():
    src = os.environ.get("PIPR_SRC") or None
    path, asof_note = pipr.fetch_workbook(ROOT / "data" / "raw" / "pipr.xlsx", src)
    print(f"[pipr] source: {asof_note} ({path.stat().st_size/1e6:.1f} MB)")

    areas = pipr.read_table1(path)
    periods = pipr.periods_of(areas)
    latest = periods[-1]
    print(f"[pipr] {len(areas)} areas, {len(periods)} months "
          f"({periods[0]} -> {latest}) — {asof_note}")

    # ---- 1. latest-month levels -------------------------------------------
    OUT_RENTS.parent.mkdir(parents=True, exist_ok=True)
    n_rents = 0
    with OUT_RENTS.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["code", "name", "region", "rent", "b1", "b2", "b3", "b4",
                    "det", "semi", "terr", "flat", "chg", "asof"])
        for code, a in sorted(areas.items()):
            m = a["months"].get(latest)
            if not m:
                continue
            lv = {k: (m.get(k) or {}).get("rent") for k in pipr.SERIES_KEYS}
            if lv.get("all") is None:
                continue
            w.writerow([code, a["name"], a["region"] or "",
                        lv["all"], lv["b1"], lv["b2"], lv["b3"], lv["b4"],
                        lv["det"], lv["semi"], lv["terr"], lv["flat"],
                        _r1((m.get("all") or {}).get("chg")), latest])
            n_rents += 1
    print(f"[pipr] wrote {n_rents} level rows -> {OUT_RENTS.name}")

    # ---- 2. full monthly history ------------------------------------------
    # One row per (area, series). Arrays are dense over `periods`, with null
    # where a month is missing, so the client can index by month offset from
    # first_period without carrying a date per point.
    n_series = 0
    with OUT_SERIES.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["code", "series", "first_period", "rents", "chg"])
        for code, a in sorted(areas.items()):
            for skey in pipr.SERIES_KEYS:
                rents, chgs, any_val = [], [], False
                for p in periods:
                    d = (a["months"].get(p) or {}).get(skey) or {}
                    rents.append(d.get("rent"))
                    chgs.append(_r1(d.get("chg")))
                    if d.get("rent") is not None:
                        any_val = True
                if not any_val:
                    continue
                w.writerow([code, skey, periods[0],
                            json.dumps(rents, separators=(",", ":")),
                            json.dumps(chgs, separators=(",", ":"))])
                n_series += 1
    print(f"[pipr] wrote {n_series} series rows ({len(periods)} months each)"
          f" -> {OUT_SERIES.name}")

    # ---- 3. map-layer props ------------------------------------------------
    payload = pipr.build_la_props(areas, periods)
    OUT_PROPS.write_text(json.dumps(payload, separators=(",", ":")),
                         encoding="utf-8")
    print(f"[pipr] wrote {len(payload['areas'])} mappable LAD prop sets "
          f"-> {OUT_PROPS.name}")

    skipped = sorted({c[:3] for c in areas
                      if c[:3] not in pipr.MAPPABLE_PREFIXES})
    print(f"[pipr] not mapped (no matching boundary set): {', '.join(skipped)}")


def _r1(v):
    return None if v is None else round(float(v), 1)


if __name__ == "__main__":
    main()
