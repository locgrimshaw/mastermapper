"""
test_pipr.py — regression test for the ONS PIPR reader.

Run: python3 pipeline/test_pipr.py

Everything here exists because getting it wrong would be SILENT. Table 1 is 40
unlabelled-by-position columns of four-column series blocks: read the block
offsets wrong and every flat in the country gets the terraced rent, with no
error and entirely plausible numbers. ONS also write '[x]' and '[z]' where a
figure is missing, which coerce to nothing useful if treated as numbers, and
Northern Ireland's rows carry '[z]' where the area code should be.

The workbook is 18 MB, so these cases run against a synthetic one built here.
"""
import datetime as dt
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipr  # noqa: E402

FAILS = []


def check(label, got, want):
    if got != want:
        FAILS.append(f"{label}: expected {want!r}, got {got!r}")


def build_workbook(path):
    """A miniature Table 1 with the real column layout and the real quirks."""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Table 1"
    ws.append(["Price Index of Private Rents, UK: monthly price statistics"])
    ws.append(["This worksheet contains one table."])
    hdr = ["Time period", "Area code", "Area name", "Region or country name"]
    for _key, _col, label in pipr.SERIES:
        hdr += [f"Index {label}", f"Monthly change {label}",
                f"Annual change {label}", f"Rental price {label}"]
    ws.append(hdr)

    def row(period, code, name, region, base, annual):
        """One row where each series' rent is base + a fixed per-series offset,
        so a mis-mapped column shows up as the wrong offset."""
        r = [period, code, name, region]
        for i, (_k, _c, _l) in enumerate(pipr.SERIES):
            rent = base + i * 10
            r += [100.0 + i, 0.1, annual if annual is not None else "[x]", rent]
        return r

    months = [dt.datetime(2015, 1, 1), dt.datetime(2015, 2, 1),
              dt.datetime(2025, 7, 1), dt.datetime(2026, 7, 1)]
    # An English district: rents rise 1000 -> 1100 -> 1200 -> 1320.
    for m, base, ann in zip(months, [1000, 1100, 1200, 1320],
                            [None, None, 5.5, 10.0]):
        ws.append(row(m, "E07000105", "Ashford", "South East", base, ann))
    # A Welsh unitary (mappable), a Scottish ONS grouping and an English
    # region (both fallback-only), and a Northern Ireland BRMA with no code.
    for m, base in zip(months, [700, 710, 720, 730]):
        ws.append(row(m, "W06000015", "Cardiff", "Wales", base, 3.0))
        ws.append(row(m, "S33000009", "Greater Glasgow", "Scotland", base, 3.0))
        ws.append(row(m, "E12000008", "South East", "[z]", base, 3.0))
        ws.append(row(m, "[z]", "South West Northern Ireland BRMA",
                      "Northern Ireland", base, 3.0))
    # A row whose rents are entirely suppressed must not invent zeros.
    supp = [dt.datetime(2026, 7, 1), "E06000053", "Isles of Scilly",
            "South West"]
    for _ in pipr.SERIES:
        supp += ["[z]", "[z]", "[z]", "[z]"]
    ws.append(supp)
    wb.save(path)


def main():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "mini.xlsx"
        build_workbook(path)
        areas = pipr.read_table1(path)
        periods = pipr.periods_of(areas)

    # --- geography ---------------------------------------------------------
    check("periods", periods, ["2015-01", "2015-02", "2025-07", "2026-07"])
    check("NI dropped (no area code)",
          any(not c[0].isalpha() or len(c) != 9 for c in areas), False)
    check("area count", sorted(areas),
          ["E06000053", "E07000105", "E12000008", "S33000009", "W06000015"])

    # --- column mapping: the failure that would be invisible ---------------
    m = areas["E07000105"]["months"]["2026-07"]
    for i, (key, _col, _label) in enumerate(pipr.SERIES):
        check(f"2026-07 rent {key}", m[key]["rent"], 1320 + i * 10)
    check("flat is the LAST series, not terraced", m["flat"]["rent"],
          m["terr"]["rent"] + 10)

    # --- '[x]' and '[z]' are absence, never zero ---------------------------
    check("annual change absent in 2015-01",
          areas["E07000105"]["months"]["2015-01"]["all"]["chg"], None)
    check("annual change present in 2026-07", m["all"]["chg"], 10.0)
    check("fully suppressed row keeps no rents",
          areas["E06000053"]["months"].get("2026-07"), None)

    # --- growth ------------------------------------------------------------
    # 1000 -> 1320 across the four sampled months is +32%.
    check("growth over the full window",
          pipr.growth_pct(areas["E07000105"]["months"], periods, "all", 3), 32.0)
    check("growth window longer than the history",
          pipr.growth_pct(areas["E07000105"]["months"], periods, "all", 99), None)

    # --- what reaches the map ---------------------------------------------
    payload = pipr.build_la_props(areas, periods)
    check("only E&W districts are mapped", sorted(payload["areas"]),
          ["E07000105", "W06000015"])
    p = payload["areas"]["E07000105"]
    check("map props carry every series",
          all(f"rent_{k}" in p for k in pipr.SERIES_KEYS), True)
    check("legacy rent_mean preserved", p["rent_mean"], p["rent_all"])
    check("legacy annual change preserved",
          p["annual_rent_change_pct"], p["chg_all"])
    check("asof is the latest month", payload["asof"], "2026-07")

    # --- release discovery: newest by DATE, not by filename ----------------
    html = '''
      <a href="/file?uri=/x/9september2026/priceindexofprivaterents2.xlsx">a</a>
      <a href="/file?uri=/x/22july2026/priceindexofprivaterents14.xlsx">b</a>
      <a href="/file?uri=/x/17june2026/priceindexofprivaterents13.xlsx">c</a>
    '''
    url, d = pipr.latest_release_url(html)
    check("newest release picked by date", str(d), "2026-09-09")
    check("suffix 14 does not beat September", "2.xlsx" in url, True)
    check("relative href absolutised", url.startswith("https://www.ons.gov.uk"), True)
    try:
        pipr.latest_release_url("<a href='/nothing.html'>x</a>")
        FAILS.append("a page with no dated workbook link should raise")
    except RuntimeError:
        pass

    total = len(FAILS)
    for f in FAILS:
        print("FAIL ", f)
    print(f"{'FAILED' if total else 'OK'} — {total} failure(s)")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
